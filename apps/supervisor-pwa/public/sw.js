// Keep the app usable offline without trapping a supervisor on an old daily sheet.
// Navigation is always checked against the network first; Vite assets are hashed
// and can safely use a cache-first fallback.
const CACHE_NAME = "tea-shell-v2";
const CACHE_PREFIX = "tea-";

function cacheResponse(request, response) {
  if (!response || !response.ok) return Promise.resolve(response);
  // A full Cache Storage must not turn a successful fresh page into an error.
  return caches.open(CACHE_NAME)
    .then((cache) => cache.put(request, response.clone()))
    .catch(() => undefined)
    .then(() => response);
}

function networkFirst(request) {
  return fetch(request)
    .then((response) => cacheResponse(request, response))
    .catch(() => caches.match(request).then((cached) => cached || Response.error()));
}

function cacheFirst(request) {
  return caches.open(CACHE_NAME).then((cache) => cache.match(request).then((cached) => {
    if (cached) return cached;
    return fetch(request).then((response) => cacheResponse(request, response));
  }));
}

self.addEventListener("install", (event) => {
  event.waitUntil(self.skipWaiting());
});

self.addEventListener("activate", (event) => {
  event.waitUntil(
    caches.keys()
      .then((keys) => Promise.all(keys
        .filter((key) => key.startsWith(CACHE_PREFIX) && key !== CACHE_NAME)
        .map((key) => caches.delete(key))))
      .then(() => self.clients.claim()),
  );
});

self.addEventListener("fetch", (event) => {
  const { request } = event;
  const url = new URL(request.url);

  // API requests and non-GET/cross-origin requests must retain normal browser
  // behaviour; only the PWA shell is cached here.
  if (
    request.method !== "GET" ||
    url.origin !== self.location.origin ||
    url.pathname.startsWith("/api/")
  ) return;

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request));
    return;
  }

  event.respondWith(cacheFirst(request));
});
