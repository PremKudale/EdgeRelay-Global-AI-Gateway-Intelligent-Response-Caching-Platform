CREATE TABLE IF NOT EXISTS request_events (
  id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  cache_key TEXT NOT NULL,
  model TEXT,
  outcome TEXT NOT NULL CHECK (outcome IN ('hit', 'miss', 'stale', 'bypass', 'error')),
  latency_ms INTEGER NOT NULL,
  upstream_latency_ms INTEGER,
  estimated_cost_saved_usd REAL NOT NULL DEFAULT 0,
  request_tokens INTEGER,
  response_tokens INTEGER,
  region TEXT
);

CREATE INDEX IF NOT EXISTS idx_request_events_created_at ON request_events(created_at);
CREATE INDEX IF NOT EXISTS idx_request_events_outcome ON request_events(outcome);

CREATE TABLE IF NOT EXISTS cache_entries (
  cache_key TEXT PRIMARY KEY,
  model TEXT,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL,
  hits INTEGER NOT NULL DEFAULT 0,
  response_bytes INTEGER NOT NULL
);
