import { CacheCoordinator } from "./coordinator";
import { dashboardHtml } from "./dashboard";
import type { AnalyticsEvent, CachedResponse, EdgeCacheMeta, Env, Outcome } from "./types";
import { cachedResponse, json, numberFromEnv, requestId, sha256, stableStringify } from "./utils";

export { CacheCoordinator };

const DAY_MS = 86_400_000;
const CACHE_VERSION = "v1";

export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const url = new URL(request.url);
    if (request.method === "OPTIONS") return new Response(null, { headers: corsHeaders() });
    if (url.pathname === "/") return new Response(dashboardHtml, { headers: { "content-type": "text/html; charset=utf-8" } });
    if (url.pathname === "/health") return withCors(json({ ok: true, service: "edgecache" }));

    if (!authorized(request, env)) return withCors(json({ error: "Unauthorized" }, 401, { "www-authenticate": "Bearer" }));
    const window = analyticsWindow(url.searchParams.get("window"));
    if (url.pathname === "/api/stats" && request.method === "GET") return withCors(await stats(env, window));
    if (url.pathname === "/api/recent" && request.method === "GET") return withCors(await recentEvents(env, window));
    if (request.method !== "POST" || !["/summarize", "/v1/chat/completions"].includes(url.pathname)) {
      return withCors(json({ error: "Not found", hint: "POST /summarize or /v1/chat/completions" }, 404));
    }

    let incoming: Record<string, unknown>;
    try {
      incoming = await request.json<Record<string, unknown>>();
    } catch {
      return withCors(json({ error: "Body must be valid JSON" }, 400));
    }
    const chatRequest = url.pathname === "/summarize" ? summaryToChat(incoming) : incoming;
    if (!chatRequest) return withCors(json({ error: "For /summarize, provide a non-empty text field." }, 400));
    if (chatRequest.stream === true) return withCors(json({ error: "Streaming is not cacheable. Set stream: false." }, 400));

    const model = typeof chatRequest.model === "string" ? chatRequest.model : "gpt-4o-mini";
    const cacheKey = `${CACHE_VERSION}:${await sha256(stableStringify({ path: url.pathname, body: chatRequest }))}`;
    const noStore = request.headers.get("cache-control")?.includes("no-store") || incoming.cache === false;
    const startedAt = Date.now();

    if (!noStore) {
      const found = await readCached(env, cacheKey);
      if (found && Date.parse(found.expiresAt) > Date.now()) {
        const response = responseFor(url.pathname, found, meta("hit", cacheKey, startedAt, found));
        ctx.waitUntil(record(env, eventFor("hit", cacheKey, model, startedAt, found)));
        return withCors(response);
      }
      if (found && Date.parse(found.staleAt) > Date.now()) {
        ctx.waitUntil(revalidate(env, cacheKey, chatRequest, model, ctx));
        ctx.waitUntil(record(env, eventFor("stale", cacheKey, model, startedAt, found)));
        return withCors(responseFor(url.pathname, found, meta("stale", cacheKey, startedAt, found)));
      }
    }

    const lock = env.CACHE_COORDINATOR.get(env.CACHE_COORDINATOR.idFromName(cacheKey));
    const lockState = await lock.fetch("https://coordinator/lock", { method: "POST" }).then((r) => r.json<{ owner: boolean; lease?: string }>());
    if (!lockState.owner && !noStore) {
      const coalesced = await waitForCache(env, cacheKey);
      if (coalesced) {
        ctx.waitUntil(record(env, eventFor("hit", cacheKey, model, startedAt, coalesced)));
        return withCors(responseFor(url.pathname, coalesced, meta("hit", cacheKey, startedAt, coalesced)));
      }
    }

    try {
      const result = await callProvider(env, chatRequest);
      const elapsed = Date.now() - startedAt;
      const entry = makeEntry(result, env, model);
      if (!noStore) {
        await env.CACHE.put(cacheKey, JSON.stringify(entry), { expirationTtl: numberFromEnv(env.STALE_TTL_SECONDS, 86_400) });
        ctx.waitUntil(archive(env, cacheKey, entry));
        ctx.waitUntil(trackCacheEntry(env, cacheKey, entry));
      }
      ctx.waitUntil(record(env, eventFor(noStore ? "bypass" : "miss", cacheKey, model, startedAt, entry, elapsed)));
      return withCors(responseFor(url.pathname, entry, { cache: noStore ? "bypass" : "miss", cacheKey, latencyMs: elapsed, upstreamLatencyMs: elapsed }));
    } catch (error) {
      const message = error instanceof Error ? error.message : "Provider request failed";
      ctx.waitUntil(record(env, { ...eventFor("error", cacheKey, model, startedAt), latencyMs: Date.now() - startedAt }));
      return withCors(json({ error: "Upstream provider failed", detail: message }, 502));
    } finally {
      if (lockState.owner && lockState.lease) ctx.waitUntil(lock.fetch("https://coordinator/release", { method: "POST", body: JSON.stringify({ lease: lockState.lease }) }));
    }
  },

  async queue(batch: MessageBatch<AnalyticsEvent>, env: Env): Promise<void> {
    const statements = batch.messages.flatMap(({ body }) => {
      const insert = env.DB.prepare(`INSERT INTO request_events
      (id, created_at, cache_key, model, outcome, latency_ms, upstream_latency_ms, estimated_cost_saved_usd, request_tokens, response_tokens, response_bytes, region)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .bind(body.id, body.createdAt, body.cacheKey, body.model ?? null, body.outcome, body.latencyMs, body.upstreamLatencyMs ?? null, body.estimatedCostSavedUsd, body.requestTokens ?? null, body.responseTokens ?? null, body.responseBytes ?? null, body.region ?? null);
      const increment = (body.outcome === "hit" || body.outcome === "stale")
        ? [env.DB.prepare("UPDATE cache_entries SET hits = hits + 1 WHERE cache_key = ?").bind(body.cacheKey)]
        : [];
      return [insert, ...increment];
    });
    if (statements.length) await env.DB.batch(statements);
    batch.ackAll();
  },
} satisfies ExportedHandler<Env, AnalyticsEvent>;

function authorized(request: Request, env: Env): boolean {
  if (!env.EDGE_CACHE_API_KEY) return true;
  const supplied = request.headers.get("x-api-key") ?? request.headers.get("authorization")?.replace(/^Bearer\s+/i, "");
  return supplied === env.EDGE_CACHE_API_KEY;
}

function summaryToChat(body: Record<string, unknown>): Record<string, unknown> | null {
  if (typeof body.text !== "string" || !body.text.trim()) return null;
  return {
    model: typeof body.model === "string" ? body.model : "gpt-4o-mini",
    temperature: typeof body.temperature === "number" ? body.temperature : 0.2,
    max_tokens: typeof body.max_tokens === "number" ? body.max_tokens : 500,
    messages: [
      { role: "system", content: typeof body.system === "string" ? body.system : "Summarize the supplied text faithfully and concisely." },
      { role: "user", content: body.text },
    ],
  };
}

async function callProvider(env: Env, body: Record<string, unknown>): Promise<{ status: number; body: string; headers: Record<string, string>; usage?: CachedResponse["usage"] }> {
  if (!env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is not configured");
  const base = (env.UPSTREAM_BASE_URL ?? "https://api.openai.com/v1").replace(/\/$/, "");
  const upstream = await fetch(`${base}/chat/completions`, {
    method: "POST",
    headers: { authorization: `Bearer ${env.OPENAI_API_KEY}`, "content-type": "application/json" },
    body: JSON.stringify(body),
  });
  const responseText = await upstream.text();
  if (!upstream.ok) throw new Error(`Provider returned ${upstream.status}: ${responseText.slice(0, 300)}`);
  let parsed: { usage?: CachedResponse["usage"] } = {};
  try { parsed = JSON.parse(responseText) as { usage?: CachedResponse["usage"] }; } catch { /* preserve non-JSON upstream result */ }
  return { status: upstream.status, body: responseText, headers: {}, usage: parsed.usage };
}

function makeEntry(result: Awaited<ReturnType<typeof callProvider>>, env: Env, model: string): CachedResponse {
  const now = Date.now();
  const ttl = numberFromEnv(env.CACHE_TTL_SECONDS, 3_600);
  const stale = Math.max(ttl, numberFromEnv(env.STALE_TTL_SECONDS, 86_400));
  return { ...result, model, cachedAt: new Date(now).toISOString(), expiresAt: new Date(now + ttl * 1000).toISOString(), staleAt: new Date(now + stale * 1000).toISOString() };
}

async function readCached(env: Env, cacheKey: string): Promise<CachedResponse | null> {
  return env.CACHE.get<CachedResponse>(cacheKey, "json");
}

async function waitForCache(env: Env, key: string): Promise<CachedResponse | null> {
  for (let i = 0; i < 24; i++) {
    await new Promise((resolve) => setTimeout(resolve, 250));
    const entry = await readCached(env, key);
    if (entry) return entry;
  }
  return null;
}

async function revalidate(env: Env, key: string, body: Record<string, unknown>, model: string, _ctx: ExecutionContext): Promise<void> {
  const lock = env.CACHE_COORDINATOR.get(env.CACHE_COORDINATOR.idFromName(key));
  const state = await lock.fetch("https://coordinator/lock", { method: "POST" }).then((r) => r.json<{ owner: boolean; lease?: string }>());
  if (!state.owner) return;
  try {
    const result = await callProvider(env, body);
    const entry = makeEntry(result, env, model);
    await env.CACHE.put(key, JSON.stringify(entry), { expirationTtl: numberFromEnv(env.STALE_TTL_SECONDS, 86_400) });
    await archive(env, key, entry);
    await trackCacheEntry(env, key, entry);
  } finally {
    if (state.lease) await lock.fetch("https://coordinator/release", { method: "POST", body: JSON.stringify({ lease: state.lease }) });
  }
}

function meta(cache: Outcome, cacheKey: string, startedAt: number, entry?: CachedResponse): EdgeCacheMeta {
  return { cache, cacheKey, latencyMs: Date.now() - startedAt, ageMs: entry ? Date.now() - Date.parse(entry.cachedAt) : undefined };
}

function responseFor(path: string, entry: CachedResponse, details: EdgeCacheMeta): Response {
  if (path === "/summarize") {
    try {
      const completion = JSON.parse(entry.body) as { choices?: Array<{ message?: { content?: string } }> };
      return json({ summary: completion.choices?.[0]?.message?.content ?? "", model: entry.model, usage: entry.usage, edgecache: details }, entry.status);
    } catch { return json({ summary: entry.body, model: entry.model, edgecache: details }, entry.status); }
  }
  return cachedResponse(entry, details);
}

function eventFor(outcome: Outcome, cacheKey: string, model: string, startedAt: number, entry?: CachedResponse, upstreamLatencyMs?: number): AnalyticsEvent {
  const hit = outcome === "hit" || outcome === "stale";
  // Deliberately conservative placeholder: update with your provider's model pricing.
  const saved = hit ? ((entry?.usage?.total_tokens ?? 0) / 1_000_000) * 0.6 : 0;
  return { id: requestId(), cacheKey, createdAt: new Date().toISOString(), estimatedCostSavedUsd: saved, latencyMs: Date.now() - startedAt, model, outcome, upstreamLatencyMs: hit ? undefined : upstreamLatencyMs, requestTokens: entry?.usage?.prompt_tokens, responseTokens: entry?.usage?.completion_tokens, responseBytes: entry ? new TextEncoder().encode(entry.body).byteLength : undefined };
}

async function record(env: Env, event: AnalyticsEvent): Promise<void> {
  await env.ANALYTICS_QUEUE.send(event);
}

async function archive(env: Env, cacheKey: string, entry: CachedResponse): Promise<void> {
  await env.ARCHIVE.put(`responses/${new Date().toISOString().slice(0, 10)}/${cacheKey}/${entry.cachedAt}.json`, JSON.stringify(entry), { httpMetadata: { contentType: "application/json" } });
}

async function trackCacheEntry(env: Env, cacheKey: string, entry: CachedResponse): Promise<void> {
  await env.DB.prepare(`INSERT INTO cache_entries (cache_key, model, created_at, expires_at, response_bytes)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(cache_key) DO UPDATE SET model = excluded.model, created_at = excluded.created_at,
      expires_at = excluded.expires_at, response_bytes = excluded.response_bytes`)
    .bind(cacheKey, entry.model ?? null, entry.cachedAt, entry.expiresAt, new TextEncoder().encode(entry.body).byteLength).run();
}

type AnalyticsWindow = { label: "1h" | "24h" | "7d"; milliseconds: number; groupBy: string; points: number; step: number };
function analyticsWindow(value: string | null): AnalyticsWindow {
  if (value === "1h") return { label: "1h", milliseconds: 3_600_000, groupBy: "%Y-%m-%dT%H:%M", points: 12, step: 300_000 };
  if (value === "7d") return { label: "7d", milliseconds: 7 * DAY_MS, groupBy: "%Y-%m-%d", points: 7, step: DAY_MS };
  return { label: "24h", milliseconds: DAY_MS, groupBy: "%Y-%m-%dT%H", points: 24, step: 3_600_000 };
}

async function stats(env: Env, window: AnalyticsWindow): Promise<Response> {
  const since = new Date(Date.now() - window.milliseconds).toISOString();
  const result = await env.DB.prepare(`SELECT
      COUNT(*) AS requests,
      SUM(CASE WHEN outcome = 'hit' THEN 1 ELSE 0 END) AS hits,
      SUM(CASE WHEN outcome = 'miss' THEN 1 ELSE 0 END) AS misses,
      SUM(CASE WHEN outcome = 'stale' THEN 1 ELSE 0 END) AS stale,
      AVG(latency_ms) AS averageLatencyMs,
      SUM(estimated_cost_saved_usd) AS costSavedUsd
    FROM request_events WHERE created_at >= ?`).bind(since).first<Record<string, number | null>>();
  const latencies = await env.DB.prepare("SELECT latency_ms FROM request_events WHERE created_at >= ? ORDER BY latency_ms").bind(since).all<{ latency_ms: number }>();
  const values = latencies.results.map((row) => row.latency_ms);
  const requests = result?.requests ?? 0;
  const hits = result?.hits ?? 0;
  const grouped = await env.DB.prepare(`SELECT strftime('${window.groupBy}', created_at) AS bucket, COUNT(*) AS requests
    FROM request_events WHERE created_at >= ? GROUP BY bucket ORDER BY bucket`).bind(since).all<{ bucket: string; requests: number }>();
  const byBucket = new Map(grouped.results.map((item) => [item.bucket, item.requests]));
  const now = Date.now();
  const series = Array.from({ length: window.points }, (_, index) => {
    const timestamp = now - ((window.points - 1 - index) * window.step);
    const date = new Date(timestamp);
    const bucket = window.label === "7d" ? date.toISOString().slice(0, 10) : window.label === "24h" ? date.toISOString().slice(0, 13) : date.toISOString().slice(0, 16);
    return { label: bucket, requests: byBucket.get(bucket) ?? 0 };
  });
  return json({ window: window.label, metrics: { requests, hits, misses: result?.misses ?? 0, stale: result?.stale ?? 0, hitRatio: requests ? hits / requests : 0, averageLatencyMs: Math.round(result?.averageLatencyMs ?? 0), p50LatencyMs: values.length ? values[Math.floor(values.length * 0.5)] : 0, costSavedUsd: result?.costSavedUsd ?? 0 }, series });
}

async function recentEvents(env: Env, window: AnalyticsWindow): Promise<Response> {
  const since = new Date(Date.now() - window.milliseconds).toISOString();
  const events = await env.DB.prepare(`SELECT created_at AS createdAt, model, outcome, latency_ms AS latencyMs
    FROM request_events WHERE created_at >= ? ORDER BY created_at DESC LIMIT 8`).bind(since).all<{ createdAt: string; model: string | null; outcome: Outcome; latencyMs: number }>();
  return json({ events: events.results });
}

function corsHeaders(): HeadersInit { return { "access-control-allow-origin": "*", "access-control-allow-headers": "authorization, content-type, x-api-key, cache-control", "access-control-allow-methods": "GET, POST, OPTIONS" }; }
function withCors(response: Response): Response { const headers = new Headers(response.headers); for (const [key, value] of Object.entries(corsHeaders())) headers.set(key, value); return new Response(response.body, { status: response.status, headers }); }
