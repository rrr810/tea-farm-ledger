self.addEventListener("install", (e)=> self.skipWaiting());
self.addEventListener("activate", (e)=> e.waitUntil(clients.claim()));
self.addEventListener("fetch", (e)=>{
  if (e.request.url.includes("/api/")) return;
  e.respondWith(caches.open("tea-v1").then(c=> c.match(e.request).then(r=> r || fetch(e.request).then(res=>{ c.put(e.request, res.clone()); return res; }))).catch(()=> fetch(e.request)));
});
