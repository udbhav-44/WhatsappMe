'use strict';

// Fixed-window in-memory rate limiter. Pure core (`hit`) + an Express middleware
// factory. Keyed by client IP. Note: state is in-memory, so it resets on
// restart — it raises the bar against bursts/brute-force but is not a durable
// lockout. Paired with the per-user login lockout in auth.js.

function hit(store, key, max, windowMs, now) {
  let rec = store[key];
  if (!rec || now >= rec.resetAt) {
    rec = { count: 0, resetAt: now + windowMs };
    store[key] = rec;
  }
  rec.count += 1;
  return { allowed: rec.count <= max, retryAfter: Math.max(0, rec.resetAt - now) };
}

// keyFn(req) -> string picks the bucket. Defaults to client IP. For login we
// key by IP+userId so an attacker hammering one account (or a shared upstream
// IP behind the tunnel) can't exhaust the budget and lock out everyone else.
function rateLimit(max, windowMs, keyFn) {
  const store = {};
  const getKey = keyFn || ((req) => req.ip || 'unknown');
  return function (req, res, next) {
    const now = Date.now();
    // Opportunistic cleanup so the map can't grow unbounded.
    if (Object.keys(store).length > 5000) {
      for (const k of Object.keys(store)) if (now >= store[k].resetAt) delete store[k];
    }
    const key = getKey(req);
    const { allowed, retryAfter } = hit(store, key, max, windowMs, now);
    if (!allowed) {
      res.set('Retry-After', String(Math.ceil(retryAfter / 1000)));
      return res.status(429).json({ error: 'Too many attempts. Please wait and try again.' });
    }
    next();
  };
}

module.exports = { hit, rateLimit };
