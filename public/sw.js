// Service worker: sólo recibe los avisos (push) y abre la partida al tocarlos.

self.addEventListener('install', () => self.skipWaiting());
self.addEventListener('activate', (e) => e.waitUntil(self.clients.claim()));

self.addEventListener('push', (e) => {
  let data = {};
  try { data = e.data ? e.data.json() : {}; } catch { /* aviso sin datos */ }
  const tag = data.tag || 'batalla-naval';
  e.waitUntil(self.registration.showNotification(data.title || 'Batalla Naval', {
    body: data.body || '',
    tag,
    renotify: !data.silent,
    silent: !!data.silent,
    icon: 'icon-192.png',
    badge: 'badge-96.png',
    data: { url: data.url || './' },
  }));
});

self.addEventListener('notificationclick', (e) => {
  e.notification.close();
  const url = new URL(e.notification.data?.url || './', self.registration.scope).href;
  e.waitUntil((async () => {
    const windows = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const w of windows) {
      if ('focus' in w) {
        await w.focus();
        w.postMessage({ type: 'open', url });
        return;
      }
    }
    await self.clients.openWindow(url);
  })());
});
