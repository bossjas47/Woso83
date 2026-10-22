// Service worker: shows Web Push messages sent by the Worker ({ title, body, url, tag }) and opens the page on tap.
self.addEventListener('push', (e) => {
  let m = {};
  try { m = e.data ? e.data.json() : {}; } catch (_) { m = { body: e.data?.text() }; }
  e.waitUntil(self.registration.showNotification(m.title || 'Nugget Hub', { body: m.body || '', icon: '/assets/logo-icon-96.png', badge: '/assets/logo-icon-96.png', tag: m.tag, renotify: !!m.tag, data: { url: m.url || '/' } }));
});
self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || '/', self.location.origin).href;
  e.waitUntil(clients.matchAll({ type: 'window', includeUncontrolled: true }).then((ws) => {
    const w = ws.find(x => x.url.startsWith(url)); return w ? w.focus() : clients.openWindow(url);
  }));
});
