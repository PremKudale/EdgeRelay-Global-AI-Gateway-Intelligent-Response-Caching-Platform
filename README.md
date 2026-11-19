# EdgeCache ⚡

> An AI-aware, globally distributed API cache built entirely on Cloudflare.

EdgeCache sits in front of an OpenAI-compatible provider and makes repeat AI requests fast, inexpensive, and observable. A familiar API lets developers adopt it without rewriting their LLM integration, while the edge absorbs duplicate prompts before they reach a model.

## The idea

```text
Client ──▶ Worker ──▶ KV cache ── hit ──▶ instant response
                  │
                  └── miss ──▶ Durable Object ──▶ AI Gateway / OpenAI
                                             │
                           ┌─────────────────┼────────────────┐
                           ▼                 ▼                ▼
                         KV cache        R2 archive     Queue ──▶ D1 ──▶ Console
```

| Without EdgeCache | With EdgeCache |
| --- | --- |
| Every repeat prompt reaches the model | Repeats return from Cloudflare KV |
| Concurrent misses can stampede upstream | Durable Object coalesces identical misses |
| Metrics live across several systems | One D1-backed operational console |
| Prompt data can leak through telemetry | Analytics stores only hashed keys and metadata |

## Features

- **OpenAI-compatible** `POST /v1/chat/completions` endpoint.
- **Simple summary API** at `POST /summarize` with `{ "text": "…" }`.
- **Deterministic SHA-256 cache keys** from a stable request serialization; no raw prompts in KV keys or analytics.
- **Fresh and stale cache windows**, with background revalidation during the stale window.
- **Single-flight miss protection** using a Durable Object lease.
- **R2 archive** of cacheable provider responses.
- **Queue-backed, D1-powered analytics** so reporting stays off the user request path.
- **Interactive product console** at `/`: protected connection, 1h/24h/7d metrics, activity feed, usage chart, and live cache playground.
- **Cloudflare AI Gateway ready**: set an OpenAI-compatible upstream URL.

## Quick start

### 1. Install

```bash
npm install
```

### 2. Create Cloudflare resources

```bash
npx wrangler kv namespace create CACHE
npx wrangler d1 create edgecache
npx wrangler r2 bucket create edgecache-archive
npx wrangler queues create edgecache-analytics
```

Put the returned KV namespace ID and D1 database ID in `wrangler.jsonc`, then apply the schema:

```bash
npx wrangler d1 execute edgecache --remote --file=migrations/0001_init.sql
npx wrangler d1 execute edgecache --remote --file=migrations/0002_cache_metadata.sql
```

### 3. Set secrets

For development, copy `.dev.vars.example` to `.dev.vars` and add your key. Never commit it.

```ini
OPENAI_API_KEY="sk-..."
EDGE_CACHE_API_KEY="choose-a-long-random-key"
```

For production:

```bash
npx wrangler secret put OPENAI_API_KEY
npx wrangler secret put EDGE_CACHE_API_KEY
```

### 4. Run or deploy

```bash
npm run dev
# visit http://localhost:8787

npm run deploy
```

## API guide

### Summarize text

```bash
curl -X POST http://localhost:8787/summarize \
  -H 'content-type: application/json' \
  -H 'x-api-key: local-development-key' \
  -d '{
    "text": "Cloudflare Workers run JavaScript close to users around the world.",
    "model": "gpt-4o-mini"
  }'
```

Example:

```json
{
  "summary": "Cloudflare Workers execute code close to users globally.",
  "model": "gpt-4o-mini",
  "edgecache": {
    "cache": "hit",
    "cacheKey": "v1:…",
    "ageMs": 4821,
    "latencyMs": 3
  }
}
```

Submit an identical request twice: the first request is normally `miss`, the second `hit`.

### OpenAI-compatible chat completions

```bash
curl -X POST http://localhost:8787/v1/chat/completions \
  -H 'content-type: application/json' \
  -H 'authorization: Bearer local-development-key' \
  -d '{
    "model": "gpt-4o-mini",
    "messages": [{"role":"user","content":"Explain edge caching in one sentence."}]
  }'
```

The normal provider response is preserved and gains an `edgecache` metadata object.

### Bypass the cache

Use `Cache-Control: no-store` on either endpoint, or `"cache": false` on `/summarize`. Streaming is deliberately rejected because a complete body is required for reliable caching; run streaming traffic through a dedicated pass-through route.

## Console and metrics

The interactive console is served from `/`. If `EDGE_CACHE_API_KEY` is enabled, paste it into the console’s connection field; it remains in browser local storage and is only sent to the same Worker origin.

| Endpoint | Description |
| --- | --- |
| `GET /health` | Liveness probe |
| `GET /api/stats?window=1h|24h|7d` | Metrics plus graph-ready time series |
| `GET /api/recent?window=1h|24h|7d` | Latest eight metadata-only events |

## Configuration

| Variable | Default | Purpose |
| --- | --- | --- |
| `OPENAI_API_KEY` | required | Provider credential |
| `EDGE_CACHE_API_KEY` | unset | Optional client/dashboard protection |
| `UPSTREAM_BASE_URL` | `https://api.openai.com/v1` | OpenAI-compatible target; use a Cloudflare AI Gateway URL here |
| `CACHE_TTL_SECONDS` | `3600` | Fresh cache lifetime |
| `STALE_TTL_SECONDS` | `86400` | Maximum stale lifetime |

## Production checklist

- Update the cache-key scope if output varies by tenant, entitlement, or locale.
- Replace the example savings formula in `eventFor` with current per-model pricing before using it for financial reporting.
- R2 holds model outputs: configure an R2 lifecycle policy, retention controls, or remove `archive()` for sensitive workloads.
- Do not deploy with the placeholder D1 ID in `wrangler.jsonc`.
- Give `EDGE_CACHE_API_KEY` a high-entropy value in production.

## Validate the project

```bash
npm run typecheck
npm run deploy -- --dry-run
```

## Project layout

```text
src/index.ts          API, cache path, Queue/D1 integration, analytics endpoints
src/coordinator.ts    Durable Object request-coalescing lease
src/dashboard.ts      Interactive self-contained console
src/types.ts          Worker bindings and internal types
migrations/           D1 schema migrations
wrangler.jsonc        Cloudflare bindings and deployment configuration
```
