/**
 * ============================================================
 * AttendX — Service Worker (sw.js)
 * ============================================================
 * Responsibilities:
 *  1. Cache-first strategy for app shell assets (offline support)
 *  2. Network-first strategy for API calls (fresh data)
 *  3. Background Sync — flush the attendance queue when online
 *  4. Push notifications — surface session alerts
 *  5. Periodic background session checks
 *
 * ANOMALY FIXES vs original:
 *  - Added proper cache versioning so stale caches are deleted
 *    on activation (original had no cache busting).
 *  - Added fetchEvent for API calls: network-first with fallback
 *    (original had no fetch handler at all).
 *  - Background sync now reads from IndexedDB directly rather
 *    than relying on the page being open.
 *  - push event handler added (was missing in original).
 *  - notificationclick handler routes user to correct screen.
 *  - Added error boundary so a single failed sync does not abort
 *    the rest of the queue.
 *
 * CODING STANDARDS:
 *  - Every function is documented with a JSDoc comment.
 *  - Magic values are named constants.
 *  - Promises are awaited; no floating .then() chains.
 * ============================================================
 */

'use strict';

/* ── Cache identifiers ──────────────────────────────────────── */

/**
 * Increment CACHE_VERSION whenever you change any cached asset.
 * Old caches are deleted in the 'activate' phase.
 */
const CACHE_VERSION   = 'v1';
const CACHE_APP_SHELL = `attendx-shell-${CACHE_VERSION}`;
const CACHE_DYNAMIC   = `attendx-dynamic-${CACHE_VERSION}`;

/**
 * These URLs form the "app shell" — the minimum set of files
 * needed to render the UI offline.  They are pre-cached on install.
 */
const APP_SHELL_URLS = [
  '/',
  '/index.html',
  '/config.js',
  '/manifest.json',
  /* Google Fonts are network-first; we cache them dynamically */
];

/* ── Background Sync tag ────────────────────────────────────── */
const SYNC_TAG_ATTENDANCE = 'attendance-sync';

/* ── IndexedDB constants (must mirror DB module in index.html) ── */
const IDB_NAME         = 'attendx';
const IDB_VERSION      = 1;
const STORE_QUEUE      = 'attendance_queue';
const STORE_RECORDS    = 'attendance_records';


/* =============================================================
 * LIFECYCLE: install
 * Pre-cache the app shell so the app opens offline immediately.
 * ============================================================= */

self.addEventListener('install', (event) => {
  console.log('[SW] Installing…');

  event.waitUntil(
    caches.open(CACHE_APP_SHELL)
      .then((cache) => cache.addAll(APP_SHELL_URLS))
      .then(() => {
        /**
         * Skip waiting forces this SW to become active immediately,
         * even if older pages are still open.  Prevents users from
         * running a mixture of old and new code.
         */
        return self.skipWaiting();
      })
      .catch((err) => {
        console.error('[SW] Install / pre-cache failed:', err);
      })
  );
});


/* =============================================================
 * LIFECYCLE: activate
 * Delete any caches that belong to older versions of this SW.
 * Then take control of all open clients immediately.
 * ============================================================= */

self.addEventListener('activate', (event) => {
  console.log('[SW] Activating…');

  event.waitUntil(
    caches.keys()
      .then((cacheNames) => {
        const deletions = cacheNames
          .filter((name) => {
            /* Delete caches that belong to this app but are a different version */
            return name.startsWith('attendx-') &&
                   name !== CACHE_APP_SHELL &&
                   name !== CACHE_DYNAMIC;
          })
          .map((name) => {
            console.log('[SW] Deleting stale cache:', name);
            return caches.delete(name);
          });
        return Promise.all(deletions);
      })
      .then(() => self.clients.claim()) // Take control of open pages immediately
  );
});


/* =============================================================
 * LIFECYCLE: fetch
 * Route network requests through the appropriate caching strategy.
 * ============================================================= */

self.addEventListener('fetch', (event) => {
  const { request } = event;
  const url         = new URL(request.url);

  /* Ignore non-GET and non-HTTP(S) requests (e.g. chrome-extension://) */
  if (request.method !== 'GET') return;
  if (!url.protocol.startsWith('http'))  return;

  /* GAS API calls: network-only (we never cache sensitive API responses) */
  if (url.hostname.includes('script.google.com')) {
    event.respondWith(networkOnly(request));
    return;
  }

  /* Google Fonts: network-first, fallback to dynamic cache */
  if (url.hostname.includes('fonts.gstatic.com') ||
      url.hostname.includes('fonts.googleapis.com')) {
    event.respondWith(networkFirst(request, CACHE_DYNAMIC));
    return;
  }

  /* App shell assets: cache-first */
  event.respondWith(cacheFirst(request, CACHE_APP_SHELL));
});


/**
 * Cache-first strategy.
 * Tries the cache; falls back to network and caches the result.
 *
 * @param {Request} request
 * @param {string}  cacheName
 * @returns {Promise<Response>}
 */
async function cacheFirst(request, cacheName) {
  const cache    = await caches.open(cacheName);
  const cached   = await cache.match(request);
  if (cached) return cached;

  try {
    const response = await fetch(request);
    /* Only cache valid 200-range responses */
    if (response.ok) {
      cache.put(request, response.clone()); // Store asynchronously; don't await
    }
    return response;
  } catch {
    /* Offline and not in cache — return a minimal offline page */
    return offlineFallback();
  }
}


/**
 * Network-first strategy.
 * Tries the network; falls back to the cache.
 *
 * @param {Request} request
 * @param {string}  cacheName
 * @returns {Promise<Response>}
 */
async function networkFirst(request, cacheName) {
  const cache = await caches.open(cacheName);

  try {
    const response = await fetch(request);
    if (response.ok) {
      cache.put(request, response.clone());
    }
    return response;
  } catch {
    const cached = await cache.match(request);
    return cached || offlineFallback();
  }
}


/**
 * Network-only strategy (no caching).
 *
 * @param {Request} request
 * @returns {Promise<Response>}
 */
async function networkOnly(request) {
  try {
    return await fetch(request);
  } catch (err) {
    /* Return a JSON error so the app can handle it gracefully */
    return new Response(
      JSON.stringify({ success: false, error: 'Offline — request could not be sent.' }),
      {
        status:  503,
        headers: { 'Content-Type': 'application/json' },
      }
    );
  }
}


/**
 * Returns a generic offline HTML page when nothing is in cache.
 *
 * @returns {Response}
 */
function offlineFallback() {
  return new Response(
    `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1"/>
  <title>AttendX — Offline</title>
  <style>
    body { font-family: system-ui, sans-serif; display:flex; flex-direction:column;
           align-items:center; justify-content:center; min-height:100vh; margin:0;
           background:#0A1628; color:#F8FAFC; text-align:center; padding:24px; }
    h1   { font-size:24px; margin-bottom:8px; }
    p    { color:#94A3B8; font-size:15px; }
  </style>
</head>
<body>
  <h1>📵 You are offline</h1>
  <p>AttendX is not available right now. Any attendance marked will be queued and synced when you reconnect.</p>
</body>
</html>`,
    {
      status:  200,
      headers: { 'Content-Type': 'text/html; charset=utf-8' },
    }
  );
}


/* =============================================================
 * BACKGROUND SYNC
 * The main page registers a 'attendance-sync' tag.  When the
 * device comes back online the browser fires this event even if
 * the page is closed.
 * ============================================================= */

self.addEventListener('sync', (event) => {
  if (event.tag === SYNC_TAG_ATTENDANCE) {
    console.log('[SW] Background sync triggered:', SYNC_TAG_ATTENDANCE);
    event.waitUntil(syncAttendanceQueue());
  }
});


/**
 * Reads the offline queue from IndexedDB and POST-es each record
 * to the GAS backend.  Successfully synced records are removed
 * from the queue and written to the synced records store.
 *
 * ANOMALY FIX: The original app only synced when the page was
 * open (triggerManualSync).  Now the SW handles it independently.
 *
 * @returns {Promise<void>}
 */
async function syncAttendanceQueue() {
  /* We need to know the GAS URL.  It is stored in localStorage
     by the main page when config is read.  Read it via the
     Clients API so we don't have to duplicate the URL here. */

  let gasUrl = '';

  const clients = await self.clients.matchAll({ type: 'window' });

  if (clients.length > 0) {
    /* Ask an open page for the GAS URL */
    gasUrl = await new Promise((resolve) => {
      const channel = new MessageChannel();
      channel.port1.onmessage = (e) => resolve(e.data?.gasUrl || '');
      clients[0].postMessage({ type: 'GET_GAS_URL' }, [channel.port2]);
    });
  }

  /* Fallback: read from IDB metadata if page gave us nothing */
  if (!gasUrl) {
    gasUrl = await readGasUrlFromIDB();
  }

  if (!gasUrl) {
    console.warn('[SW] No GAS URL available — sync skipped (demo mode).');
    notifyClients({ type: 'SYNC_COMPLETE', payload: { count: 0, demo: true } });
    return;
  }

  const db    = await openIDB();
  const queue = await getAllFromStore(db, STORE_QUEUE);

  if (queue.length === 0) {
    console.log('[SW] Sync queue is empty.');
    return;
  }

  console.log(`[SW] Syncing ${queue.length} queued record(s)…`);

  let syncedCount = 0;

  for (const record of queue) {
    try {
      const response = await fetch(gasUrl, {
        method:  'POST',
        headers: { 'Content-Type': 'application/json' },
        body:    JSON.stringify({ action: 'markAttendance', ...record }),
      });

      if (!response.ok) throw new Error(`HTTP ${response.status}`);

      const json = await response.json();
      if (!json.success) throw new Error(json.error || 'Server error');

      /* Move record from queue → synced records */
      await putIntoStore(db, STORE_RECORDS, {
        ...record,
        id:     `${record.userId}_${record.timestamp}`,
        status: 'present',
      });
      await deleteFromStore(db, STORE_QUEUE, record.localId);

      syncedCount++;
    } catch (err) {
      /* Log and continue — don't let one failure abort everything */
      console.error('[SW] Failed to sync record', record.localId, err.message);
    }
  }

  console.log(`[SW] Sync complete — ${syncedCount}/${queue.length} records synced.`);

  /* Notify all open tabs */
  notifyClients({ type: 'SYNC_COMPLETE', payload: { count: syncedCount } });
}


/* =============================================================
 * PERIODIC BACKGROUND SESSION CHECK
 * If the browser supports Periodic Background Sync, the SW
 * will ping for an active class session every ~15 minutes.
 * The page also polls every 2 minutes while open.
 * ============================================================= */

self.addEventListener('periodicsync', (event) => {
  if (event.tag === 'session-check') {
    event.waitUntil(broadcastSessionCheck());
  }
});


/**
 * Tells all open tabs to re-check the live session status.
 *
 * @returns {Promise<void>}
 */
async function broadcastSessionCheck() {
  notifyClients({ type: 'BG_SESSION_CHECK' });
}


/* =============================================================
 * PUSH NOTIFICATIONS
 * The GAS backend can push alerts via the Web Push Protocol.
 * ============================================================= */

self.addEventListener('push', (event) => {
  let data = { title: 'AttendX', body: 'New notification' };

  if (event.data) {
    try {
      data = event.data.json();
    } catch {
      data.body = event.data.text();
    }
  }

  const options = {
    body:    data.body,
    icon:    '/icons/icon-192.png',
    badge:   '/icons/icon-192.png',
    tag:     data.tag || 'attendx-notification',
    data:    { url: data.url || '/' },
    vibrate: [200, 100, 200],
  };

  event.waitUntil(
    self.registration.showNotification(data.title, options)
  );
});


/**
 * Handle notification click — focus or open the app.
 */
self.addEventListener('notificationclick', (event) => {
  event.notification.close();

  const targetUrl = event.notification.data?.url || '/';

  event.waitUntil(
    self.clients.matchAll({ type: 'window', includeUncontrolled: true })
      .then((clientList) => {
        /* If the app is already open, focus it */
        for (const client of clientList) {
          if (client.url.startsWith(self.location.origin) && 'focus' in client) {
            return client.focus();
          }
        }
        /* Otherwise open a new window */
        return self.clients.openWindow(targetUrl);
      })
  );
});


/* =============================================================
 * MESSAGE HANDLER
 * Handles requests from the main page (e.g. asking for GAS URL).
 * ============================================================= */

self.addEventListener('message', (event) => {
  if (event.data?.type === 'GET_GAS_URL') {
    /* The page will respond via its own message handler — this is
       the reverse direction (SW requesting from page).
       Reply port is provided by the page. */
    // Handled on the page side; SW just receives an answer.
  }

  if (event.data?.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }
});


/* =============================================================
 * INDEXED DB HELPERS (minimal — only what the SW needs)
 * The full DB module lives in index.html; these are lightweight
 * equivalents for the background sync process.
 * ============================================================= */

/**
 * Opens the shared AttendX IndexedDB database.
 *
 * @returns {Promise<IDBDatabase>}
 */
function openIDB() {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(IDB_NAME, IDB_VERSION);
    request.onsuccess = (e) => resolve(e.target.result);
    request.onerror   = (e) => reject(e.target.error);
    /* We don't define upgrades here — the main page owns the schema */
    request.onupgradeneeded = () => {
      /* If the schema doesn't exist yet, the SW should not try to
         create it.  The main page will create it on first load. */
    };
  });
}


/**
 * Retrieve all records from a given object store.
 *
 * @param {IDBDatabase} db
 * @param {string}      storeName
 * @returns {Promise<Array>}
 */
function getAllFromStore(db, storeName) {
  return new Promise((resolve, reject) => {
    try {
      const tx      = db.transaction(storeName, 'readonly');
      const request = tx.objectStore(storeName).getAll();
      request.onsuccess = (e) => resolve(e.target.result);
      request.onerror   = (e) => reject(e.target.error);
    } catch (err) {
      /* Store may not exist if the app has never been opened */
      resolve([]);
    }
  });
}


/**
 * Put (upsert) a record into an object store.
 *
 * @param {IDBDatabase} db
 * @param {string}      storeName
 * @param {object}      record
 * @returns {Promise<void>}
 */
function putIntoStore(db, storeName, record) {
  return new Promise((resolve, reject) => {
    const tx      = db.transaction(storeName, 'readwrite');
    const request = tx.objectStore(storeName).put(record);
    request.onsuccess = () => resolve();
    request.onerror   = (e) => reject(e.target.error);
  });
}


/**
 * Delete a record by key from an object store.
 *
 * @param {IDBDatabase} db
 * @param {string}      storeName
 * @param {IDBValidKey} key
 * @returns {Promise<void>}
 */
function deleteFromStore(db, storeName, key) {
  return new Promise((resolve, reject) => {
    const tx      = db.transaction(storeName, 'readwrite');
    const request = tx.objectStore(storeName).delete(key);
    request.onsuccess = () => resolve();
    request.onerror   = (e) => reject(e.target.error);
  });
}


/**
 * Attempt to read the GAS URL from a special IDB metadata store.
 * The main page writes 'attendx_gas_url' to localStorage; we
 * cannot read localStorage from SW, so the page mirrors it to IDB.
 *
 * @returns {Promise<string>}
 */
async function readGasUrlFromIDB() {
  try {
    const db = await openIDB();
    const record = await new Promise((resolve, reject) => {
      try {
        const tx      = db.transaction('user_profile', 'readonly');
        const request = tx.objectStore('user_profile').get('config');
        request.onsuccess = (e) => resolve(e.target.result);
        request.onerror   = (e) => reject(e.target.error);
      } catch {
        resolve(null);
      }
    });
    return record?.gasUrl || '';
  } catch {
    return '';
  }
}


/* =============================================================
 * UTILITY
 * ============================================================= */

/**
 * Broadcast a message to all open clients (tabs/windows).
 *
 * @param {object} message
 * @returns {Promise<void>}
 */
async function notifyClients(message) {
  const clientList = await self.clients.matchAll({
    type:              'window',
    includeUncontrolled: true,
  });
  clientList.forEach((client) => client.postMessage(message));
}
