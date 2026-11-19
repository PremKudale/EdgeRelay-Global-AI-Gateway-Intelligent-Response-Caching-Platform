/**
 * A short-lived distributed lock. It prevents a burst of identical cache misses
 * from fanning out to the model provider. The actual response lives in KV.
 */
export class CacheCoordinator implements DurableObject {
  private lockedUntil = 0;
  private lease?: string;

  constructor(private readonly state: DurableObjectState) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const now = Date.now();
    if (url.pathname === "/lock" && request.method === "POST") {
      if (this.lockedUntil > now) return Response.json({ owner: false, retryAfterMs: this.lockedUntil - now });
      this.lockedUntil = now + 25_000;
      this.lease = crypto.randomUUID();
      return Response.json({ owner: true, lease: this.lease });
    }
    if (url.pathname === "/release" && request.method === "POST") {
      const { lease } = await request.json<{ lease?: string }>();
      const released = lease === this.lease;
      if (released) {
        this.lockedUntil = 0;
        this.lease = undefined;
      }
      return Response.json({ released });
    }
    return new Response("Not found", { status: 404 });
  }
}
