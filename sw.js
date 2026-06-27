// ============================================================
//  BioAttend Service Worker  v2
//  Handles: App Shell caching, Offline attendance queuing,
//           Background Sync, Push notifications
// ============================================================

const CACHE_VERSION = 'v3';
const SHELL_CACHE   = 'bioattend-shell-' + CACHE_VERSION;
const DATA_CACHE    = 'bioattend-data-' + CACHE_VERSION;
const SYNC_TAG      = 'attendance-sync';

// Shell assets — cache on install
// NOTE: this list must stay in sync with the actual files shipped
// alongside this service worker (index.html is the login/home screen).
const SHELL_ASSETS = [
  '/',
  '/index.html',
  '/styles.css',
  '/tenant.js',
  '/app-student.js',
  '/manifest.json',
  '/icons/icon-72.png',
  '/icons/icon-96.png',
  '/icons/icon-128.png',
  '/icons/icon-192.png',
  '/icons/icon-512.png',
  '/icons/icon-512-maskable.png',
  '/offline.html'
];

// ── Install ──────────────────────────────────────────────────
self.addEventListener('install', e => {
  e.waitUntil(
    caches.open(SHELL_CACHE)
      .then(cache => cache.addAll(SHELL_ASSETS))
      .then(() => self.skipWaiting())
      .catch(err => console.warn('[SW] Shell cache failed (non-fatal):', err))
  );
});

// ── Activate — clean old caches ──────────────────────────────
self.addEventListener('activate', e => {
  e.waitUntil(
    caches.keys().then(keys => Promise.all(
      keys
        .filter(k => k.startsWith('bioattend-') && k !== SHELL_CACHE && k !== DATA_CACHE)
        .map(k => caches.delete(k))
    )).then(() => self.clients.claim())
  );
});

// ── Fetch strategy ───────────────────────────────────────────
self.addEventListener('fetch', e => {
  const url = new URL(e.request.url);

  // GAS API calls — network-first, offline-aware
  if (url.hostname.includes('script.google.com')) {
    e.respondWith(
      fetch(e.request.clone(), { signal: AbortSignal.timeout ? AbortSignal.timeout(12000) : undefined })
        .catch(() => new Response(
          JSON.stringify({ success: false, offline: true, message: 'You are offline. Attendance will be queued.' }),
          { headers: { 'Content-Type': 'application/json' } }
        ))
    );
    return;
  }

  // Nominatim (reverse geocoding) — network only, fail silently
  if (url.hostname.includes('nominatim.openstreetmap.org')) {
    e.respondWith(
      fetch(e.request.clone()).catch(() =>
        new Response(JSON.stringify({}), { headers: { 'Content-Type': 'application/json' } })
      )
    );
    return;
  }

  // Google Fonts — cache-first
  if (url.hostname.includes('fonts.googleapis.com') || url.hostname.includes('fonts.gstatic.com')) {
    e.respondWith(
      caches.match(e.request).then(cached => cached || fetch(e.request.clone())
        .then(res => {
          const clone = res.clone();
          caches.open(DATA_CACHE).then(c => c.put(e.request, clone));
          return res;
        }).catch(() => new Response('', { status: 503 }))
      )
    );
    return;
  }

  // App shell — cache-first, fallback to offline page
  e.respondWith(
    caches.match(e.request).then(cached => {
      if (cached) return cached;
      return fetch(e.request.clone())
        .then(res => {
          if (res.ok) {
            const clone = res.clone();
            caches.open(SHELL_CACHE).then(c => c.put(e.request, clone));
          }
          return res;
        })
        .catch(() => {
          if (e.request.destination === 'document') {
            return caches.match('/offline.html') ||
              new Response('<h2>You are offline</h2><p>Open when connected to use BioAttend.</p>',
                { headers: { 'Content-Type': 'text/html' } });
          }
          return new Response('', { status: 503 });
        });
    })
  );
});

// ── Background Sync — flush queued attendance ────────────────
self.addEventListener('sync', e => {
  if (e.tag === SYNC_TAG) {
    e.waitUntil(flushAttendanceQueue());
  }
});

async function flushAttendanceQueue() {
  let db;
  try {
    db = await openDB();
    const tx = db.transaction('queue', 'readonly');
    const store = tx.objectStore('queue');
    const items = await getAllItems(store);
    if (!items.length) return;

    for (const item of items) {
      try {
        const response = await fetch(item.apiUrl, {
          method: 'GET',
          // GAS uses JSONP; we signal it was queued offline so the app can display a toast
        });
        if (response.ok) {
          const delTx = db.transaction('queue', 'readwrite');
          delTx.objectStore('queue').delete(item.id);
        }
      } catch (err) {
        // Still offline — leave in queue
        console.warn('[SW] Sync flush: still offline for item', item.id);
      }
    }

    // Notify all open clients about the sync
    const clients = await self.clients.matchAll({ type: 'window' });
    clients.forEach(client => client.postMessage({ type: 'SYNC_COMPLETE', count: items.length }));
  } catch (err) {
    console.warn('[SW] flushAttendanceQueue error:', err);
  }
}

// ── Push Notifications ────────────────────────────────────────
self.addEventListener('push', e => {
  let data = { title: 'BioAttend', body: 'You have a new notification.' };
  try { if (e.data) data = { ...data, ...e.data.json() }; } catch (_) {}
  e.waitUntil(
    self.registration.showNotification(data.title, {
      body: data.body,
      icon: '/icons/icon-192.png',
      badge: '/icons/icon-96.png',
      tag: data.tag || 'bioattend',
      data: data.url ? { url: data.url } : {},
      vibrate: [200, 100, 200],
      actions: data.actions || []
    })
  );
});

self.addEventListener('notificationclick', e => {
  e.notification.close();
  const url = e.notification.data?.url || '/';
  e.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true }).then(clients => {
      const existing = clients.find(c => c.url === url && 'focus' in c);
      if (existing) return existing.focus();
      return self.clients.openWindow(url);
    })
  );
});

// ── Periodic Sync — check for active sessions ────────────────
self.addEventListener('periodicsync', e => {
  if (e.tag === 'session-check') {
    e.waitUntil(checkForActiveSessions());
  }
});

async function checkForActiveSessions() {
  // Lightweight background check — clients handle the actual poll
  const clients = await self.clients.matchAll({ type: 'window' });
  clients.forEach(c => c.postMessage({ type: 'BG_SESSION_CHECK' }));
}

// ── Message handler (from main thread) ───────────────────────
self.addEventListener('message', e => {
  if (e.data?.type === 'SKIP_WAITING') self.skipWaiting();
  if (e.data?.type === 'QUEUE_ATTENDANCE') {
    e.waitUntil(queueAttendance(e.data.payload, e.data.id));
  }
  if (e.data?.type === 'DEQUEUE_ATTENDANCE') {
    e.waitUntil(dequeueAttendance(e.data.id));
  }
});

async function queueAttendance(payload, id) {
  try {
    const db = await openDB();
    const tx = db.transaction('queue', 'readwrite');
    tx.objectStore('queue').put({ id: id || Date.now(), payload, queuedAt: Date.now() });
  } catch (err) {
    console.warn('[SW] queueAttendance failed:', err);
  }
}

async function dequeueAttendance(id) {
  try {
    const db = await openDB();
    const tx = db.transaction('queue', 'readwrite');
    tx.objectStore('queue').delete(id);
  } catch (err) {
    console.warn('[SW] dequeueAttendance failed:', err);
  }
}

// ── Minimal IndexedDB helpers ─────────────────────────────────
function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open('bioattend-offline', 1);
    req.onupgradeneeded = ev => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains('queue')) {
        db.createObjectStore('queue', { keyPath: 'id' });
      }
    };
    req.onsuccess = ev => resolve(ev.target.result);
    req.onerror = ev => reject(ev.target.error);
  });
}

function getAllItems(store) {
  return new Promise((resolve, reject) => {
    const req = store.getAll();
    req.onsuccess = () => resolve(req.result || []);
    req.onerror = () => reject(req.error);
  });
}
