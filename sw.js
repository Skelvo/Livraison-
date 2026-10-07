// Service worker :
// - affiche les alertes départ envoyées par la fonction Supabase departs-push, même app fermée
// - garde une copie des pages pour que l'app s'ouvre sans réseau
//   (réseau d'abord pour toujours avoir la dernière version, copie si hors ligne)
const CACHE = 'departs-v1';
const SHELL = ['./', 'index.html', 'departs.html', 'data.js', 'live.js', 'manifest.webmanifest', 'icon-192.png', 'icon-180.png'];

self.addEventListener('install', function(e){
  e.waitUntil(caches.open(CACHE).then(function(c){ return c.addAll(SHELL); }).catch(function(){}));
  self.skipWaiting();
});
self.addEventListener('activate', function(e){
  e.waitUntil(caches.keys().then(function(keys){
    return Promise.all(keys.filter(function(k){ return k !== CACHE; }).map(function(k){ return caches.delete(k); }));
  }).then(function(){ return self.clients.claim(); }));
});

self.addEventListener('fetch', function(e){
  const req = e.request;
  const url = new URL(req.url);
  // Seulement les fichiers de l'app (pas Supabase, déjà gardé en mémoire par l'app)
  if(req.method !== 'GET' || url.origin !== self.location.origin) return;
  e.respondWith(fetch(req).then(function(res){
    if(res.ok){ const copy = res.clone(); caches.open(CACHE).then(function(c){ c.put(req, copy); }); }
    return res;
  }).catch(function(){
    return caches.match(req, {ignoreSearch: true}).then(function(hit){
      return hit || (req.mode === 'navigate' ? caches.match('index.html') : undefined);
    });
  }));
});

self.addEventListener('push', function(e){
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch(err) { data = { body: e.data && e.data.text() }; }
  e.waitUntil(self.registration.showNotification(data.title || 'Départ imminent', {
    body: data.body || '',
    tag: data.tag,
    renotify: true,
    icon: 'icon-192.png',
    badge: 'icon-192.png',
  }));
});

self.addEventListener('notificationclick', function(e){
  e.notification.close();
  const url = self.registration.scope;
  e.waitUntil(self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function(list){
    for (const c of list) { if (c.url.indexOf(url) === 0 && 'focus' in c) return c.focus(); }
    return self.clients.openWindow(url);
  }));
});
