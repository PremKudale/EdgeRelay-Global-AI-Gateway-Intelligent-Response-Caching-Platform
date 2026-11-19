import type { CachedResponse } from "./types";

export function stableStringify(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
    .join(",")}}`;
}

export async function sha256(input: string): Promise<string> {
  const bytes = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(digest)].map((byte) => byte.toString(16).padStart(2, "0")).join("");
}

export function numberFromEnv(value: string | undefined, fallback: number): number {
  const number = Number(value);
  return Number.isFinite(number) && number >= 0 ? number : fallback;
}

export function json(data: unknown, status = 200, headers: HeadersInit = {}): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", ...headers },
  });
}

export function cachedResponse(entry: CachedResponse, meta: object): Response {
  let payload: unknown;
  try {
    payload = JSON.parse(entry.body);
  } catch {
    payload = entry.body;
  }
  if (payload && typeof payload === "object" && !Array.isArray(payload)) {
    payload = { ...payload as Record<string, unknown>, edgecache: meta };
  }
  return json(payload, entry.status, entry.headers);
}

export function requestId(): string {
  return crypto.randomUUID();
}
