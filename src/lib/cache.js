const store = new Map();

export function memo(key, ttlMs, fn) {
  const t = Date.now();
  const hit = store.get(key);
  if (hit && hit.exp > t) return hit.promise;
  if (store.size > 500) for (const [k, v] of store) if (v.exp <= t) store.delete(k);
  const promise = Promise.resolve().then(fn);
  store.set(key, { exp: t + ttlMs, promise });
  promise.catch(() => store.delete(key));
  return promise;
}
