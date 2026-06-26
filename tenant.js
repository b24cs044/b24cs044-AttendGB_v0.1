// ============================================================
//  BioAttend  –  tenant.js  (Student PWA edition)
//  Handles: Tenant resolution, JSONP/iframe API transport,
//           Auth token management, Session expiry
// ============================================================
'use strict';

// ── Config ───────────────────────────────────────────────────
const DEFAULT_TENANT_API  = 'https://script.google.com/macros/s/AKfycbyfgsjU607novJJlhwZfMdlSreCGP7OLaaj6ztikWQb4VawkisqPGLwdqDkDuqYfjQlZw/exec';
const NERVE_URL           = 'https://script.google.com/macros/s/AKfycbx4Ef8qNz71xgGYE7jGxV3C7yO29q97zLnGPPKLlCp_0A-HdyIHltxat9hYzzWs37u5hw/exec';
const TENANT_CACHE_TTL_MS = 24 * 60 * 60 * 1000;
const API_TIMEOUT_MS      = 12000;   // reduced from 20s — better mobile UX
const API_SLOW_WARN_MS    = 5000;    // show "still connecting…" warning

// ── Known tenants ─────────────────────────────────────────────
const EXPECTED_TENANTS = {
  '1': {
    name: 'SIT',
    apiUrl: 'https://script.google.com/macros/s/AKfycbyfgsjU607novJJlhwZfMdlSreCGP7OLaaj6ztikWQb4VawkisqPGLwdqDkDuqYfjQlZw/exec'
  },
  '2': {
    name: 'SSIT',
    apiUrl: 'https://script.google.com/macros/s/AKfycbzQ1Abzar9Ydny0mZyw4JMMOrxs868Flpdb7vHdHhltbYHdRIVQYl-aTsUQ6uP0zei_/exec'
  }
};

const FALLBACK_GUIDS = new Set(['1', '2']);

const FALLBACK_TENANTS = {
  '1': {
    success: true, guid: '1', orgType: 'college',
    institution: {
      name: 'SIT', city: 'Tumakuru',
      logoUrl: 'https://web.sit.ac.in/wp-content/uploads/2025/03/SIT-Logo-1.png',
      website: 'https://web.sit.ac.in/',
      address: 'Siddaganga Institute of Technology'
    },
    application: { id: 101, name: 'Attendance Monitoring', description: 'Biometric attendance for students' },
    apiUrl: 'https://script.google.com/macros/s/AKfycbyfgsjU607novJJlhwZfMdlSreCGP7OLaaj6ztikWQb4VawkisqPGLwdqDkDuqYfjQlZw/exec'
  },
  '2': {
    success: true, guid: '2', orgType: 'college',
    institution: {
      name: 'SSIT', city: 'Tumakuru',
      logoUrl: 'https://ssit.edu.in/img/ssit-logo.png',
      website: 'https://ssit.edu.in/',
      address: 'Sri Siddhartha Institute of Technology'
    },
    application: { id: 102, name: 'Attendance Monitoring', description: 'Biometric attendance for students' },
    apiUrl: 'https://script.google.com/macros/s/AKfycbzQ1Abzar9Ydny0mZyw4JMMOrxs868Flpdb7vHdHhltbYHdRIVQYl-aTsUQ6uP0zei_/exec'
  }
};

// ── Mutable state ────────────────────────────────────────────
let TENANT_API  = DEFAULT_TENANT_API;
let tenantState = {
  guid: '', orgType: '',
  institution: {}, application: {},
  roles: [], departments: [], attendanceLocations: []
};

// ── URL helpers ──────────────────────────────────────────────
function readGuidFromUrl() {
  try {
    return String(new URLSearchParams(window.location.search).get('q') || '').trim();
  } catch (_) { return ''; }
}

function resolveTenantApiUrl() {
  const g = String(tenantState.guid || readGuidFromUrl() || '').trim();
  if (g && EXPECTED_TENANTS[g]?.apiUrl) return EXPECTED_TENANTS[g].apiUrl;
  return TENANT_API || DEFAULT_TENANT_API;
}

function getTenantApiCandidates(extra) {
  const seen = new Set();
  const out  = [];
  [extra, resolveTenantApiUrl(), TENANT_API, DEFAULT_TENANT_API,
    EXPECTED_TENANTS[String(tenantState.guid || readGuidFromUrl() || '').trim()]?.apiUrl
  ].forEach(url => {
    const u = String(url || '').trim();
    if (u && !seen.has(u)) { seen.add(u); out.push(u); }
  });
  return out;
}

// ── JSONP transport ──────────────────────────────────────────
function jsonpRequest(url, timeout = API_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const cb = '__ba_cb_' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    const script = document.createElement('script');
    let timer = null;
    let slowTimer = null;
    let done = false;

    const cleanup = (keepCb) => {
      if (timer)    clearTimeout(timer);
      if (slowTimer) clearTimeout(slowTimer);
      if (script.parentNode) script.parentNode.removeChild(script);
      if (!keepCb) try { delete window[cb]; } catch (_) { window[cb] = undefined; }
    };

    window[cb] = data => { if (!done) { done = true; cleanup(); resolve(data); } };

    script.async = true;
    script.onerror = () => { if (!done) { done = true; cleanup(true); reject(new Error('Network error')); } };

    const sep = url.includes('?') ? '&' : '?';
    script.src = `${url}${sep}callback=${encodeURIComponent(cb)}`;
    document.head.appendChild(script);

    slowTimer = setTimeout(() => {
      updateNetworkHint('Slow network — still trying…');
    }, API_SLOW_WARN_MS);

    timer = setTimeout(() => {
      if (!done) { done = true; cleanup(true); reject(new Error('Request timed out after ' + (timeout/1000) + 's')); }
    }, timeout);
  });
}

// ── iframe fallback transport ────────────────────────────────
function iframeRequest(url, timeout = API_TIMEOUT_MS) {
  return new Promise((resolve, reject) => {
    const cb = '__ba_if_' + Math.random().toString(36).slice(2);
    const frame = document.createElement('iframe');
    frame.style.cssText = 'position:absolute;width:1px;height:1px;opacity:0;pointer-events:none;border:0;';
    let timer = null;
    let done  = false;

    const cleanup = () => {
      clearTimeout(timer);
      window.removeEventListener('message', onMsg);
      try { if (frame.parentNode) frame.parentNode.removeChild(frame); } catch (_) {}
    };

    const onMsg = ev => {
      const d = ev?.data;
      if (!d || d.__ba_iframe_cb !== cb) return;
      if (!done) { done = true; cleanup(); resolve(d.__ba_iframe_data); }
    };

    window.addEventListener('message', onMsg);
    const sep = url.includes('?') ? '&' : '?';
    frame.src = `${url}${sep}transport=iframe&callback=${encodeURIComponent(cb)}`;
    frame.onerror = () => { if (!done) { done = true; cleanup(); reject(new Error('iframe load error')); } };
    document.body.appendChild(frame);

    timer = setTimeout(() => {
      if (!done) { done = true; cleanup(); reject(new Error('iframe request timed out')); }
    }, timeout);
  });
}

// ── Request queue (max 2 concurrent) ─────────────────────────
let _inflightCount = 0;
const _requestQueue = [];
const MAX_INFLIGHT  = 2;

function processQueue() {
  if (_inflightCount >= MAX_INFLIGHT || !_requestQueue.length) return;
  const { resolve, reject, fn } = _requestQueue.shift();
  _inflightCount++;
  fn().then(resolve).catch(reject).finally(() => {
    _inflightCount--;
    processQueue();
  });
}

function queuedRequest(fn) {
  return new Promise((resolve, reject) => {
    _requestQueue.push({ resolve, reject, fn });
    processQueue();
  });
}

// ── Multi-url fallback ────────────────────────────────────────
async function jsonpRequestWithFallback(urls) {
  let lastErr = null;
  for (const url of urls) {
    try { return await jsonpRequest(url); } catch (err) { lastErr = err; }
    try { return await iframeRequest(url); } catch (err) { lastErr = err; }
  }
  throw lastErr || new Error('All API endpoints failed');
}

// ── Network status hint ───────────────────────────────────────
let _slowHintTimer = null;
function updateNetworkHint(msg) {
  // Surfaced via toast if available
  try {
    const t = document.getElementById('toast');
    if (t && msg) {
      t.textContent = msg;
      t.className = 'toast show warn';
      clearTimeout(t._t);
      t._t = setTimeout(() => { t.className = 'toast'; }, 3000);
    }
  } catch (_) {}
}

// ═══════════════════════════════════════════════════════════════
//  MAIN API FUNCTION
// ═══════════════════════════════════════════════════════════════
async function api(payload) {
  const apiUrl = resolveTenantApiUrl();
  if (!apiUrl) throw new Error('API not initialised — missing tenant URL');

  // Auto-refresh token before expiry
  if (isAuthExpired()) {
    const r = await refreshAccessToken().catch(() => null);
    if (!r) { handleExpiredAuth(); throw new Error('Session expired'); }
  } else if (authExpirySoon()) {
    refreshAccessToken().catch(() => {});
  }

  const req = { ...(payload || {}) };
  if (!req.guid && tenantState.guid) req.guid = tenantState.guid;
  const tok = getAuthToken();
  if (tok && !req.authToken) req.authToken = tok;

  const query = '?data=' + encodeURIComponent(JSON.stringify(req));
  const urls  = getTenantApiCandidates(apiUrl).map(u => u + query);

  let response = await queuedRequest(() => jsonpRequestWithFallback(urls));

  // Handle token expiry on response
  if (response?.success === false) {
    const msg  = String(response.message || '').toLowerCase();
    const code = String(response.code    || '').toUpperCase();
    if (code === 'TOKEN_EXPIRED' || msg.includes('session expired')) {
      const r = await refreshAccessToken().catch(() => null);
      if (r) {
        req.authToken = getAuthToken();
        const retryUrls = getTenantApiCandidates(apiUrl).map(u => u + '?data=' + encodeURIComponent(JSON.stringify(req)));
        response = await queuedRequest(() => jsonpRequestWithFallback(retryUrls));
      } else {
        handleExpiredAuth();
      }
    } else if (msg.includes('unauthorized') || msg.includes('authentication required')) {
      handleExpiredAuth();
    }
  }
  return response;
}

// ═══════════════════════════════════════════════════════════════
//  AUTH TOKEN HELPERS
// ═══════════════════════════════════════════════════════════════
function getAuthToken() {
  if (window.__ba_auth_token) return window.__ba_auth_token;
  try { return localStorage.getItem('ba_auth_token') || ''; } catch (_) { return ''; }
}

function getRefreshToken() {
  if (window.__ba_refresh_token) return window.__ba_refresh_token;
  try { return localStorage.getItem('ba_refresh_token') || ''; } catch (_) { return ''; }
}

function getAuthExpiresAt() {
  try { return localStorage.getItem('ba_auth_expires_at') || ''; } catch (_) { return ''; }
}

function isAuthExpired() {
  const e = getAuthExpiresAt();
  if (!e) return false;
  const ms = Date.parse(e);
  return !isNaN(ms) && Date.now() >= ms;
}

function authExpirySoon() {
  const e = getAuthExpiresAt();
  if (!e) return false;
  const ms = Date.parse(e);
  return !isNaN(ms) && (ms - Date.now()) < 90_000;
}

function persistSession(data) {
  if (!data?.authToken) return;
  try {
    window.__ba_auth_token    = data.authToken;
    window.__ba_refresh_token = data.refreshToken || '';
    localStorage.setItem('ba_auth_token',      data.authToken);
    if (data.refreshToken)   localStorage.setItem('ba_refresh_token',     data.refreshToken);
    if (data.authExpiresAt)  localStorage.setItem('ba_auth_expires_at',   data.authExpiresAt);
    if (data.refreshExpiresAt) localStorage.setItem('ba_refresh_expires_at', data.refreshExpiresAt);
    if (data.userId)         localStorage.setItem('ba_auth_user_id',      String(data.userId));
    if (data.guid)           localStorage.setItem('ba_auth_guid',         String(data.guid));
    scheduleAuthExpiry();
  } catch (_) {}
}

function clearSession() {
  try {
    window.__ba_auth_token    = '';
    window.__ba_refresh_token = '';
    ['ba_auth_token','ba_refresh_token','ba_auth_expires_at','ba_refresh_expires_at',
     'ba_auth_user_id','ba_auth_role','ba_auth_guid','ba_auth_device_id'].forEach(k => {
      try { localStorage.removeItem(k); } catch (_) {}
    });
    if (window.__ba_auth_expiry_timer) {
      clearTimeout(window.__ba_auth_expiry_timer);
      window.__ba_auth_expiry_timer = null;
    }
  } catch (_) {}
}

// Keep legacy names for compat with any existing calls
const persistTeacherSession = persistSession;
const clearTeacherSession   = clearSession;

function scheduleAuthExpiry() {
  if (window.__ba_auth_expiry_timer) {
    clearTimeout(window.__ba_auth_expiry_timer);
    window.__ba_auth_expiry_timer = null;
  }
  const e = getAuthExpiresAt();
  if (!e) return;
  const ms = Date.parse(e);
  if (isNaN(ms)) return;
  const delay = ms - Date.now();
  if (delay <= 0) { handleExpiredAuth(); return; }
  window.__ba_auth_expiry_timer = setTimeout(handleExpiredAuth, delay);
}

function handleExpiredAuth() {
  clearSession();
  // Delegate to app layer if available
  try { if (typeof handleLogout === 'function') handleLogout(); } catch (_) {}
}

async function refreshAccessToken() {
  const rt = getRefreshToken();
  if (!rt) return null;
  const query = '?data=' + encodeURIComponent(JSON.stringify({ action: 'refreshToken', refreshToken: rt, guid: tenantState.guid }));
  const res = await jsonpRequestWithFallback(getTenantApiCandidates().map(u => u + query));
  if (res?.success && res.authToken) { persistSession(res); return res; }
  return null;
}

// ═══════════════════════════════════════════════════════════════
//  TENANT BOOT
// ═══════════════════════════════════════════════════════════════
function tenantCacheKey(guid) { return `tenant_${guid}`; }

function readCachedTenant(guid) {
  try {
    const raw = localStorage.getItem(tenantCacheKey(guid));
    if (!raw) return null;
    const c = JSON.parse(raw);
    if (String(c?.guid) !== String(guid)) return null;
    if (Date.now() > (c?.expiresAt || 0)) { localStorage.removeItem(tenantCacheKey(guid)); return null; }
    return c.data || null;
  } catch (_) { return null; }
}

function cacheTenantProfile(guid, data) {
  try {
    localStorage.setItem(tenantCacheKey(guid), JSON.stringify({
      guid, expiresAt: Date.now() + TENANT_CACHE_TTL_MS, data
    }));
  } catch (_) {}
}

function getFallbackTenantProfile(guid) {
  const g = String(guid || '').trim();
  return FALLBACK_GUIDS.has(g) ? (FALLBACK_TENANTS[g] || null) : null;
}

async function fetchTenantProfile(guid) {
  if (!guid) return null;
  if (NERVE_URL && !NERVE_URL.includes('/dev')) {
    try {
      const sep = NERVE_URL.includes('?') ? '&' : '?';
      const payload = await jsonpRequest(`${NERVE_URL}${sep}getApplicationFromGuid=${encodeURIComponent(guid)}`);
      if (payload?.success && payload?.apiUrl) return payload;
    } catch (e) {
      console.warn('[tenant] Nerve lookup failed, using fallback', e.message);
    }
  }
  return getFallbackTenantProfile(guid);
}

function applyTenantBranding(profile) {
  const inst = profile?.institution || {};
  const app  = profile?.application || {};
  tenantState.guid        = String(profile?.guid || tenantState.guid || readGuidFromUrl());
  tenantState.orgType     = String(profile?.orgType || inst?.orgType || '').toLowerCase();
  tenantState.institution = inst;
  tenantState.application = app;

  const resolvedApi = profile?.apiUrl
    || EXPECTED_TENANTS[String(tenantState.guid || '').trim()]?.apiUrl
    || DEFAULT_TENANT_API;
  TENANT_API = resolvedApi;
  window.TENANT_API = resolvedApi;
  window.TENANT     = profile || null;

  // Update UI
  const orgName  = inst.name || 'BioAttend';
  const subtitle = app.description || 'Biometric Attendance System';
  document.title = `${orgName} · BioAttend`;

  // Brand org line in top bar
  const orgEl = document.getElementById('brand-org');
  if (orgEl) orgEl.textContent = inst.city ? `${orgName} · ${inst.city}` : orgName;

  // Auth hero title
  const authTitle = document.getElementById('auth-title');
  if (authTitle) authTitle.textContent = orgName;

  const authSub = document.getElementById('auth-subtitle');
  if (authSub) authSub.textContent = subtitle;

  // Try loading institution logo in the logo-mark
  if (inst.logoUrl) {
    const img = new Image();
    img.onload = () => {
      const mark = document.querySelector('.logo-mark');
      if (mark) {
        mark.innerHTML = `<img src="${inst.logoUrl}" alt="${orgName}"
          style="width:100%;height:100%;object-fit:cover;border-radius:inherit;"
          referrerpolicy="no-referrer"/>`;
      }
    };
    img.onerror = () => {}; // keep SVG fallback
    img.referrerPolicy = 'no-referrer';
    img.src = inst.logoUrl;
  }
}

async function bootTenant() {
  const guid = readGuidFromUrl();
  tenantState.guid = guid;

  try {
    if (!guid) throw new Error('No tenant GUID in URL (?q=...)');

    // Try cache first (instant load)
    const cached = readCachedTenant(guid);
    if (cached) {
      applyTenantBranding({ ...cached, guid });
      return;
    }

    // Fetch from Nerve / fallback
    const profile = await fetchTenantProfile(guid);
    if (!profile) throw new Error('Tenant not found for GUID: ' + guid);

    applyTenantBranding({ ...profile, guid });
    cacheTenantProfile(guid, { ...profile, guid });

  } catch (e) {
    console.warn('[tenant] boot error:', e.message);
    const fallback = getFallbackTenantProfile(guid);
    if (fallback) {
      applyTenantBranding({ ...fallback, guid });
    } else {
      // Show inline error without blocking — app still functional
      const orgEl = document.getElementById('brand-org');
      if (orgEl) orgEl.textContent = 'Unknown Organization';
    }
  }
}

// ── loadRegisterLookups shim ──────────────────────────────────
// Called by bootTenant in old code — harmless no-op here since
// app-student.js calls loadLookups() on its own at the right time.
async function loadRegisterLookups() {
  // no-op in student PWA — handled by loadLookups() in app-student.js
}
