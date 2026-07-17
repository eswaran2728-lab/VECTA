// AVSEC OPS service worker — app-shell caching so officers can reopen the app
// (and reach their queued/offline reports) without a network connection.
// Actual report submissions are queued in IndexedDB by the app (see src/lib/offline)
// and flushed once connectivity returns; this worker only handles asset/page caching.

const CACHE_NAME = "avsec-ops-shell-v1";
const OFFLINE_URL = "/home";

self.addEventListener("install", (event) => {
  self.skipWaiting();
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(["/manifest.json", "/icons/icon.svg"])),
  );
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches
      .keys()
      .then((keys) => Promise.all(keys.filter((k) => k !== CACHE_NAME).map((k) => caches.delete(k))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  if (request.method !== "GET") return;

  const url = new URL(request.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.startsWith("/api/") || url.pathname.startsWith("/auth/")) return;

  event.respondWith(
    fetch(request)
      .then((response) => {
        if (response.ok) {
          const clone = response.clone();
          caches.open(CACHE_NAME).then((cache) => cache.put(request, clone));
        }
        return response;
      })
      .catch(async () => {
        const cached = await caches.match(request);
        if (cached) return cached;
        if (request.mode === "navigate") {
          const shell = await caches.match(OFFLINE_URL);
          if (shell) return shell;
        }
        return Response.error();
      }),
  );
});
