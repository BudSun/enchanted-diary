// =====================================================================
// ratelimit.js
// In-memory IP rate limiter. Production deployments should swap this for
// Supabase / KV / Redis to share state across function invocations.
// =====================================================================

const WINDOW_MS = 60 * 60 * 1000;   // 1 hour
const MAX_REQ = 10;                 // 10 calls per IP per hour

// { ip -> { count, windowStart } }
const buckets = new Map();

// Prune stale entries every 10 min so the map doesn't grow forever
setInterval(() => {
  const now = Date.now();
  for (const [ip, b] of buckets) {
    if (now - b.windowStart > WINDOW_MS) buckets.delete(ip);
  }
}, 10 * 60 * 1000).unref?.();

export function check(ip) {
  const now = Date.now();
  let b = buckets.get(ip);
  if (!b || now - b.windowStart > WINDOW_MS) {
    b = { count: 0, windowStart: now };
    buckets.set(ip, b);
  }
  if (b.count >= MAX_REQ) {
    const retryMs = WINDOW_MS - (now - b.windowStart);
    return { ok: false, retryMs, count: b.count };
  }
  b.count += 1;
  return { ok: true, remaining: MAX_REQ - b.count };
}