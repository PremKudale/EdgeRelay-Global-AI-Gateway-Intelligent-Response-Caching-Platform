export interface Env {
  ARCHIVE: R2Bucket;
  ANALYTICS_QUEUE: Queue<AnalyticsEvent>;
  CACHE: KVNamespace;
  CACHE_COORDINATOR: DurableObjectNamespace;
  DB: D1Database;
  CACHE_TTL_SECONDS?: string;
  EDGE_CACHE_API_KEY?: string;
  OPENAI_API_KEY: string;
  STALE_TTL_SECONDS?: string;
  UPSTREAM_BASE_URL?: string;
}

export type Outcome = "hit" | "miss" | "stale" | "bypass" | "error";

export interface AnalyticsEvent {
  id: string;
  cacheKey: string;
  createdAt: string;
  estimatedCostSavedUsd: number;
  latencyMs: number;
  model?: string;
  outcome: Outcome;
  region?: string;
  requestTokens?: number;
  responseTokens?: number;
  responseBytes?: number;
  upstreamLatencyMs?: number;
}

export interface CachedResponse {
  body: string;
  cachedAt: string;
  expiresAt: string;
  headers: Record<string, string>;
  model?: string;
  status: number;
  staleAt: string;
  usage?: { prompt_tokens?: number; completion_tokens?: number; total_tokens?: number };
}

export interface EdgeCacheMeta {
  cache: Outcome;
  cacheKey: string;
  ageMs?: number;
  latencyMs: number;
  upstreamLatencyMs?: number;
}
