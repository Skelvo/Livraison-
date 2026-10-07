// Service worker : affiche les alertes départ envoyées par la fonction Supabase departs-push,
// même quand l'app est fermée.
self.addEventListener('install', function(){ self.skipWaiting(); });
self.addEventListener('activate', function(e){ e.waitUntil(self.clients.claim()); });

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
