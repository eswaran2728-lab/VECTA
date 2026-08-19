// VECTA (aa-ops) service worker: app-shell caching + offline fallback for
// both the ICMS and AVSEC sub-apps. Merged from icms's static-asset
// cache-first strategy and avsec's api/auth bypass — actual offline
// submissions (checkpoints, reports) are queued in IndexedDB by the app
// itself (lib/icms/offline-queue.ts, lib/avsec/offline/db.ts) and replayed
// on reconnect; this worker only handles asset/page caching.
const CACHE = "aa-ops-shell-v1";
const SHELL = ["/manifest.json", "/icms/offline", "/icons/vecta-icon-192.png"];

self.addEventListener("install", (event) => {
  event.waitUntil(
    caches.open(CACHE).then((cache) => cache.addAll(SHELL)).then(() => self.skipWaiting())
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
      .then(() => self.clients.claim())
  );
});

self.addEventListener("fetch", (event) => {
  const req = event.request;
  if (req.method !== "GET") return;

  const url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/icms/api/") || url.pathname.startsWith("/avsec/auth/")) return;

  // Static build assets / icons: cache-first (immutable hashes).
  if (url.pathname.startsWith("/_next/static/") || url.pathname.startsWith("/icons/")) {
    event.respondWith(
      caches.open(CACHE).then(async (cache) => {
        const hit = await cache.match(req);
        if (hit) return hit;
        const res = await fetch(req);
        if (res.ok) cache.put(req, res.clone());
        return res;
      })
    );
    return;
  }

  // Page navigations: network-first, cached copy as fallback, then the
  // app-relevant offline page (ICMS under /icms, AVSEC falls back to /avsec/home).
  if (req.mode === "navigate") {
    event.respondWith(
      fetch(req)
        .then((res) => {
          const clone = res.clone();
          caches.open(CACHE).then((cache) => cache.put(req, clone));
          return res;
        })
        .catch(async () => {
          const cached = await caches.match(req);
          if (cached) return cached;
          const fallback = url.pathname.startsWith("/avsec") ? "/avsec/home" : "/icms/offline";
          return caches.match(fallback);
        })
    );
  }
});
