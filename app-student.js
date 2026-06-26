// ============================================================
//  BioAttend  –  Student PWA  app-student.js  v3
//  Covers: Auth, Biometric, GPS, Dashboard, Offline Queue,
//          Attendance Ring, History, Work Location Request,
//          Dark/Light toggle, PWA Install prompt
// ============================================================

'use strict';

// ── State ─────────────────────────────────────────────────────
let currentUser   = null;   // { userId, name, email, roleKey, roleId, dept, class, section }
let todayRecord   = null;   // today's attendance record
let allHistory    = [];     // full attendance array
let offlineQueue  = [];     // queued attendance items
let currentScreen = 'auth';
let sessionPollTimer = null;
let deferredInstall  = null;

const THEME_KEY   = 'ba_theme';
const SESSION_KEY = 'ba_session';
const QUEUE_DB    = 'bioattend-offline';

// ═══════════════════════════════════════════════════════════════
//  1. THEME  (dark / light)
// ═══════════════════════════════════════════════════════════════
function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const prefer = window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
  applyTheme(saved || prefer);
}

function applyTheme(t) {
  document.documentElement.setAttribute('data-theme', t);
  localStorage.setItem(THEME_KEY, t);
  const meta = document.getElementById('meta-theme-color');
  if (meta) meta.content = t === 'dark' ? '#020917' : '#f0f4ff';
}

function toggleTheme() {
  const current = document.documentElement.getAttribute('data-theme') || 'dark';
  applyTheme(current === 'dark' ? 'light' : 'dark');
}

// ═══════════════════════════════════════════════════════════════
//  2. DEVICE ID  (stable UUID, not canvas)
// ═══════════════════════════════════════════════════════════════
async function getDeviceId() {
  try {
    let did = localStorage.getItem('ba_did');
    if (did) return did;
    did = crypto.randomUUID ? crypto.randomUUID()
        : Array.from(crypto.getRandomValues(new Uint8Array(16)))
            .map(b => b.toString(16).padStart(2, '0')).join('');
    localStorage.setItem('ba_did', did);
    return did;
  } catch {
    return 'device-' + Date.now();
  }
}

// ═══════════════════════════════════════════════════════════════
//  3. GPS
// ═══════════════════════════════════════════════════════════════
function showGPS(state, text) {
  const bar = document.getElementById('gps-bar');
  const txt = document.getElementById('gps-bar-text');
  if (!bar) return;
  bar.className = 'gps-bar show ' + state;
  if (txt) txt.textContent = text;
}

function hideGPS() {
  const bar = document.getElementById('gps-bar');
  if (bar) bar.className = 'gps-bar';
}

function getLocation(timeoutMs = 12000) {
  return new Promise(resolve => {
    if (!navigator.geolocation) {
      return resolve({ lat: null, lng: null, accuracy: null, denied: false, address: '' });
    }
    let best = null;
    let wid  = null;
    let done = false;

    const finish = result => {
      if (done) return;
      done = true;
      if (wid !== null) try { navigator.geolocation.clearWatch(wid); } catch (_) {}
      resolve(result || { lat: null, lng: null, accuracy: null, denied: false, address: '' });
    };

    wid = navigator.geolocation.watchPosition(
      pos => {
        const r = {
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
          accuracy: pos.coords.accuracy,
          denied: false,
          address: ''
        };
        if (!best || r.accuracy < best.accuracy) best = r;
        if (r.accuracy <= 50) finish(best);
      },
      err => {
        if (err.code === 1) finish({ lat: null, lng: null, accuracy: null, denied: true, address: '' });
        else finish(best || { lat: null, lng: null, accuracy: null, denied: false, address: '' });
      },
      { enableHighAccuracy: true, timeout: timeoutMs, maximumAge: 0 }
    );

    setTimeout(() => finish(best), timeoutMs);
  });
}

async function getLocationWithAddress() {
  const loc = await getLocation();
  if (!loc.lat) return loc;
  try {
    const resp = await fetch(
      `https://nominatim.openstreetmap.org/reverse?lat=${loc.lat}&lon=${loc.lng}&format=json`,
      { headers: { 'Accept-Language': 'en' } }
    );
    const data = await resp.json();
    loc.address = data.display_name
      ? data.display_name.split(',').slice(0, 3).join(', ').trim()
      : '';
  } catch (_) { loc.address = ''; }
  return loc;
}

// ═══════════════════════════════════════════════════════════════
//  4. WEBAUTHN helpers
// ═══════════════════════════════════════════════════════════════
function buf2b64url(buffer) {
  const bytes = buffer instanceof Uint8Array ? buffer : new Uint8Array(buffer || []);
  return btoa(String.fromCharCode(...bytes))
    .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64url2buf(value) {
  const raw = String(value || '').trim().replace(/-/g, '+').replace(/_/g, '/');
  const padded = raw + '='.repeat((4 - (raw.length % 4 || 4)) % 4);
  try { return Uint8Array.from(atob(padded), c => c.charCodeAt(0)); }
  catch (_) { return new Uint8Array(); }
}

async function registerBiometric(bindId) {
  if (!window.PublicKeyCredential || !navigator.credentials?.create) {
    throw Object.assign(new Error('WebAuthn not supported'), { name: 'NotSupportedError' });
  }
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const cred = await navigator.credentials.create({
    publicKey: {
      challenge,
      rp: { name: 'BioAttend', id: window.location.hostname },
      user: {
        id: new TextEncoder().encode(String(bindId)),
        name: String(bindId),
        displayName: 'BioAttend Student'
      },
      pubKeyCredParams: [
        { type: 'public-key', alg: -7   },   // ES256
        { type: 'public-key', alg: -257 }    // RS256
      ],
      authenticatorSelection: {
        authenticatorAttachment: 'platform',
        userVerification: 'required',
        requireResidentKey: false
      },
      timeout: 60000,
      attestation: 'none'
    }
  });
  if (!cred?.rawId) throw new Error('No credential returned from device');
  return buf2b64url(cred.rawId);
}

async function assertBiometric(credentialId) {
  if (!window.PublicKeyCredential || !navigator.credentials?.get) {
    throw Object.assign(new Error('WebAuthn not supported'), { name: 'NotSupportedError' });
  }
  const challenge = crypto.getRandomValues(new Uint8Array(32));
  const cred = await navigator.credentials.get({
    publicKey: {
      challenge,
      allowCredentials: credentialId ? [{
        type: 'public-key',
        id: b64url2buf(credentialId),
        transports: ['internal', 'hybrid']
      }] : [],
      userVerification: 'required',
      timeout: 60000
    }
  });
  if (!cred?.rawId) throw new Error('Biometric assertion failed');
  return buf2b64url(cred.rawId);
}

// ═══════════════════════════════════════════════════════════════
//  5. OFFLINE QUEUE  (IndexedDB)
// ═══════════════════════════════════════════════════════════════
function openQueueDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(QUEUE_DB, 1);
    req.onupgradeneeded = ev => {
      const db = ev.target.result;
      if (!db.objectStoreNames.contains('queue')) {
        db.createObjectStore('queue', { keyPath: 'id' });
      }
    };
    req.onsuccess = ev => resolve(ev.target.result);
    req.onerror   = ev => reject(ev.target.error);
  });
}

async function enqueueAttendance(payload) {
  const item = { id: Date.now(), payload, queuedAt: new Date().toISOString() };
  try {
    const db = await openQueueDB();
    const tx = db.transaction('queue', 'readwrite');
    tx.objectStore('queue').put(item);
    offlineQueue.push(item);
    updateQueueBanner();
    // Tell SW to register for background sync
    if (navigator.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'QUEUE_ATTENDANCE', payload, id: item.id });
    }
    // Register sync
    if ('serviceWorker' in navigator && 'sync' in ServiceWorkerRegistration.prototype) {
      navigator.serviceWorker.ready.then(r => r.sync.register('attendance-sync').catch(() => {}));
    }
  } catch (err) {
    console.warn('[Queue] enqueue error:', err);
    offlineQueue.push(item);
    updateQueueBanner();
  }
  return item;
}

async function loadOfflineQueue() {
  try {
    const db = await openQueueDB();
    const tx = db.transaction('queue', 'readonly');
    offlineQueue = await new Promise((res, rej) => {
      const r = tx.objectStore('queue').getAll();
      r.onsuccess = () => res(r.result || []);
      r.onerror   = () => rej(r.error);
    });
    updateQueueBanner();
  } catch (_) {}
}

async function dequeueItem(id) {
  try {
    const db = await openQueueDB();
    const tx = db.transaction('queue', 'readwrite');
    tx.objectStore('queue').delete(id);
    offlineQueue = offlineQueue.filter(i => i.id !== id);
    updateQueueBanner();
    if (navigator.serviceWorker?.controller) {
      navigator.serviceWorker.controller.postMessage({ type: 'DEQUEUE_ATTENDANCE', id });
    }
  } catch (_) {}
}

function updateQueueBanner() {
  const banner = document.getElementById('queue-banner');
  const text   = document.getElementById('queue-text');
  if (!banner) return;
  if (offlineQueue.length > 0) {
    banner.classList.add('show');
    if (text) text.textContent = offlineQueue.length === 1
      ? '1 attendance queued offline — tap to sync'
      : `${offlineQueue.length} attendance records queued — tap to sync`;
  } else {
    banner.classList.remove('show');
  }
}

async function manualSync() {
  if (!navigator.onLine) { toast('Still offline — will sync when connected', 'warn'); return; }
  if (!offlineQueue.length) { toast('Nothing to sync', 'success'); return; }
  toast('Syncing…', '');
  let synced = 0;
  for (const item of [...offlineQueue]) {
    try {
      const res = await api(item.payload);
      if (res.success) {
        await dequeueItem(item.id);
        synced++;
      }
    } catch (_) {}
  }
  if (synced > 0) {
    toast(`✓ Synced ${synced} record${synced > 1 ? 's' : ''}`, 'success');
    refreshDashboard();
  } else {
    toast('Sync failed — check connection', 'error');
  }
}

// ═══════════════════════════════════════════════════════════════
//  6. UI UTILITIES
// ═══════════════════════════════════════════════════════════════
function toast(msg, type = '') {
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = msg;
  el.className = 'toast show ' + type;
  clearTimeout(el._t);
  el._t = setTimeout(() => { el.className = 'toast'; }, 3500);
}

function togglePw(id) {
  const el = document.getElementById(id);
  if (!el) return;
  el.type = el.type === 'password' ? 'text' : 'password';
}

function setBtn(id, loading, label) {
  const el = document.getElementById(id);
  if (!el) return;
  if (loading) {
    el._orig = el.innerHTML;
    el.innerHTML = '<span class="spin"></span> ' + (label || 'Please wait…');
    el.disabled = true;
  } else {
    el.innerHTML = el._orig || el.innerHTML;
    el.disabled = false;
  }
}

function setErr(id, msg) {
  const el = document.getElementById(id);
  if (el) el.textContent = msg || '';
}

function clearField(id) { setErr(id, ''); }

function setInputErr(inputId, errId, msg) {
  const inp = document.getElementById(inputId);
  const err = document.getElementById(errId);
  if (inp) inp.classList.toggle('err', !!msg);
  if (err) err.textContent = msg || '';
}

function greetingWord() {
  const h = new Date().getHours();
  if (h < 12) return 'morning';
  if (h < 17) return 'afternoon';
  return 'evening';
}

function fmtDate(d) {
  return new Date(d).toLocaleDateString('en-IN', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}

function fmtTime(s) {
  try {
    return new Date(s).toLocaleTimeString('en-IN', { hour: '2-digit', minute: '2-digit', hour12: true });
  } catch { return String(s || '—'); }
}

// Password strength
function checkPwStrength(val) {
  const bars  = [document.getElementById('pw-b1'), document.getElementById('pw-b2'),
                 document.getElementById('pw-b3'), document.getElementById('pw-b4')];
  const label = document.getElementById('pw-label');
  let score = 0;
  if (val.length >= 8) score++;
  if (/[A-Z]/.test(val)) score++;
  if (/[0-9]/.test(val)) score++;
  if (/[^A-Za-z0-9]/.test(val)) score++;
  const colors = { 0: '', 1: 'weak', 2: 'fair', 3: 'strong', 4: 'strong' };
  const labels = { 0: '', 1: 'Weak', 2: 'Fair', 3: 'Strong', 4: 'Very strong' };
  bars.forEach((b, i) => { if (b) b.className = 'pw-bar ' + (i < score ? colors[score] : ''); });
  if (label) label.textContent = labels[score] || '';
}

// ═══════════════════════════════════════════════════════════════
//  7. SCREEN NAVIGATION
// ═══════════════════════════════════════════════════════════════
function switchScreen(name) {
  ['auth', 'home', 'history', 'profile'].forEach(s => {
    const el = document.getElementById('screen-' + s);
    if (el) el.classList.toggle('active', s === name);
  });

  ['home', 'history', 'profile'].forEach(s => {
    const btn = document.getElementById('nav-' + s);
    if (btn) btn.classList.toggle('active', s === name);
  });

  currentScreen = name;
  const nav = document.getElementById('bottom-nav');
  if (nav) nav.classList.toggle('show', name !== 'auth');

  const logoutBtn = document.getElementById('btn-logout');
  if (logoutBtn) logoutBtn.classList.toggle('hidden', name === 'auth');

  if (name === 'home') refreshDashboard();
  if (name === 'history') loadFullHistory();
  if (name === 'profile') renderProfileScreen();
}

function switchAuth(tab) {
  ['login', 'register'].forEach(t => {
    document.getElementById('atab-' + t)?.classList.toggle('active', t === tab);
    document.getElementById('apane-' + t)?.classList.toggle('active', t === tab);
  });
  if (tab === 'register') {
    resetRegisterFlow();
    loadLookups();
  }
}

// ═══════════════════════════════════════════════════════════════
//  8. AUTH — LOGIN
// ═══════════════════════════════════════════════════════════════
function validateLoginFields() {
  let ok = true;
  const email = document.getElementById('li-email')?.value.trim();
  const pass  = document.getElementById('li-password')?.value;

  if (!email) { setInputErr('li-email', 'li-email-err', 'Email is required'); ok = false; }
  else if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) { setInputErr('li-email', 'li-email-err', 'Enter a valid email address'); ok = false; }
  else setInputErr('li-email', 'li-email-err', '');

  if (!pass) { setInputErr('li-password', 'li-pass-err', 'Password is required'); ok = false; }
  else if (pass.length < 6) { setInputErr('li-password', 'li-pass-err', 'Password is too short'); ok = false; }
  else setInputErr('li-password', 'li-pass-err', '');

  return ok;
}

async function handleLogin() {
  if (!validateLoginFields()) return;
  const email = document.getElementById('li-email').value.trim();
  const pass  = document.getElementById('li-password').value;

  setBtn('btn-login', true, 'Signing in…');
  try {
    const deviceId = await getDeviceId();
    const res = await api({ action: 'signIn', email, password: pass, deviceId, guid: tenantState?.guid });

    if (!res.success) {
      toast(res.message || 'Invalid credentials', 'error');
      setInputErr('li-password', 'li-pass-err', 'Incorrect email or password');
      return;
    }

    await onLoginSuccess(res);
  } catch (e) {
    toast('Sign in failed: ' + e.message, 'error');
  } finally {
    setBtn('btn-login', false);
  }
}

async function handleBiometricLogin() {
  const email = document.getElementById('li-email')?.value.trim();
  if (!email) {
    setInputErr('li-email', 'li-email-err', 'Enter your email first');
    return;
  }
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    setInputErr('li-email', 'li-email-err', 'Enter a valid email');
    return;
  }
  setInputErr('li-email', 'li-email-err', '');

  setBtn('btn-bio-login', true, 'Verifying biometric…');
  try {
    // Look up user first to get credentialId
    const info = await api({ action: 'getUserByEmail', email });
    if (!info.success || !info.userId) {
      toast(info.message || 'No account found for this email', 'error');
      return;
    }

    // Assert biometric
    const credId = info.biometricCode || info.biometric_code || '';
    await assertBiometric(credId);

    // Sign in with biometric flag
    const deviceId = await getDeviceId();
    const res = await api({ action: 'signIn', email, biometric: true, deviceId, guid: tenantState?.guid });
    if (!res.success) { toast(res.message || 'Biometric sign-in failed', 'error'); return; }

    await onLoginSuccess(res);
  } catch (e) {
    if (e.name === 'NotAllowedError') toast('Biometric cancelled', 'warn');
    else if (e.name === 'InvalidStateError') toast('No biometric registered — use password', 'error');
    else if (e.name === 'NotSupportedError') toast('Biometric not available on this device', 'error');
    else toast('Biometric error: ' + e.message, 'error');
  } finally {
    setBtn('btn-bio-login', false);
  }
}

async function onLoginSuccess(user) {
  currentUser = {
    userId:    user.userId || user.user_id,
    name:      user.name  || user.full_name,
    email:     user.email,
    roleKey:   normalizeRole(user.roleKey || user.roleId || user.role_id || ''),
    roleId:    user.roleId || user.role_id,
    dept:      user.department  || user.departmentId,
    classId:   user.classId     || user.class_id,
    sectionId: user.sectionId   || user.section_id
  };

  // Persist session
  try { localStorage.setItem(SESSION_KEY, JSON.stringify(currentUser)); } catch (_) {}

  toast('✓ Welcome back, ' + (currentUser.name?.split(' ')[0] || 'Student'), 'success');
  setupDashboardHeader();
  await loadOfflineQueue();
  switchScreen('home');
  refreshDashboard();
  startSessionPoll();
}

function normalizeRole(val) {
  const r = String(val || '').toLowerCase().trim();
  if (r.includes('student')) return 'student';
  if (r.includes('teacher') || r.includes('faculty')) return 'teacher';
  if (r.includes('admin')) return 'admin';
  if (r.includes('employee')) return 'employee';
  return r;
}

function setupDashboardHeader() {
  const gt = document.getElementById('greeting-time');
  const dn = document.getElementById('dash-name');
  const dd = document.getElementById('dash-date');
  if (gt) gt.textContent = greetingWord();
  if (dn) dn.textContent = (currentUser?.name?.split(' ')[0]) || 'Student';
  if (dd) dd.textContent = fmtDate(new Date());
}

function handleLogout() {
  currentUser = null;
  todayRecord = null;
  allHistory  = [];
  stopSessionPoll();
  try { localStorage.removeItem(SESSION_KEY); } catch (_) {}
  switchScreen('auth');
  switchAuth('login');
  document.getElementById('li-email').value    = '';
  document.getElementById('li-password').value = '';
}

// ═══════════════════════════════════════════════════════════════
//  9. REGISTER
// ═══════════════════════════════════════════════════════════════
let regStep = 1;

function resetRegisterFlow() {
  regStep = 1;
  setRegStep(1);
  ['r-name','r-email','r-mobile','r-dob','r-emp-id'].forEach(id => {
    const el = document.getElementById(id); if (el) el.value = '';
  });
  ['r-name-err','r-email-err','r-mobile-err','r-dob-err','r-empid-err',
   'r-role-err','r-dept-err','r-class-err','r-section-err',
   'r-pass-err','r-cpass-err'].forEach(id => setErr(id, ''));
  const bioHint = document.getElementById('bio-hint');
  if (bioHint) bioHint.textContent = 'When you tap Create Account, we\'ll ask for your fingerprint or Face ID to secure your account.';
  const chip = document.getElementById('bio-status-chip');
  if (chip) chip.textContent = 'Biometric ready to set up';
}

function setRegStep(n) {
  for (let i = 1; i <= 3; i++) {
    document.getElementById('rstep-' + i)?.classList.toggle('active', i === n);
    const dot = document.getElementById('sdot-' + i);
    if (dot) {
      dot.classList.toggle('active', i === n);
      dot.classList.toggle('done', i < n);
    }
  }
  for (let i = 1; i <= 2; i++) {
    const line = document.getElementById('sline-' + i);
    if (line) line.classList.toggle('done', i < n);
  }
}

function validateRegStep1() {
  let ok = true;
  const name  = document.getElementById('r-name')?.value.trim();
  const email = document.getElementById('r-email')?.value.trim();
  const mob   = document.getElementById('r-mobile')?.value.trim();
  const dob   = document.getElementById('r-dob')?.value;
  const empId = document.getElementById('r-emp-id')?.value.trim();

  if (!name || !/^[A-Za-z][A-Za-z .'-]{1,79}$/.test(name)) {
    setErr('r-name-err', 'Enter your full name (letters only)'); ok = false;
  } else { setErr('r-name-err', ''); }

  if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    setErr('r-email-err', 'Enter a valid email address'); ok = false;
  } else { setErr('r-email-err', ''); }

  if (!mob || !/^[0-9+\-\s]{7,20}$/.test(mob)) {
    setErr('r-mobile-err', 'Enter a valid mobile number'); ok = false;
  } else { setErr('r-mobile-err', ''); }

  if (!dob) {
    setErr('r-dob-err', 'Date of birth is required'); ok = false;
  } else {
    const d = new Date(dob + 'T00:00:00');
    const today = new Date(); today.setHours(0,0,0,0);
    const minD  = new Date(); minD.setFullYear(minD.getFullYear() - 100);
    if (d >= today || d < minD) { setErr('r-dob-err', 'Enter a valid date of birth'); ok = false; }
    else setErr('r-dob-err', '');
  }

  if (!empId || !/^[A-Za-z0-9]{3,30}$/.test(empId)) {
    setErr('r-empid-err', 'Enter a valid student / employee ID'); ok = false;
  } else { setErr('r-empid-err', ''); }

  return ok;
}

function validateRegStep2() {
  let ok = true;
  const role    = document.getElementById('r-role')?.value;
  const dept    = document.getElementById('r-dept')?.value;
  const roleKey = getRoleKey();

  if (!role) { setErr('r-role-err', 'Select a role'); ok = false; } else setErr('r-role-err', '');

  if (!dept) { setErr('r-dept-err', 'Select your department'); ok = false; } else setErr('r-dept-err', '');

  if (roleKey === 'student') {
    const cls = document.getElementById('r-class')?.value;
    const sec = document.getElementById('r-section')?.value;
    if (!cls) { setErr('r-class-err', 'Select year / class'); ok = false; } else setErr('r-class-err', '');
    if (!sec) { setErr('r-section-err', 'Select section'); ok = false; } else setErr('r-section-err', '');
  }

  if (roleKey === 'teacher' || roleKey === 'employee') {
    const des = document.getElementById('r-designation')?.value.trim();
    if (!des) { setErr('r-designation-err', 'Designation is required'); ok = false; } else setErr('r-designation-err', '');
  }

  return ok;
}

function validateRegStep3() {
  let ok = true;
  const pass  = document.getElementById('r-password')?.value || '';
  const cpass = document.getElementById('r-confirm-pass')?.value || '';

  if (!pass) { setErr('r-pass-err', 'Password is required'); ok = false; }
  else if (pass.length < 8) { setErr('r-pass-err', 'At least 8 characters'); ok = false; }
  else if (!/[A-Za-z]/.test(pass) || !/[0-9]/.test(pass)) {
    setErr('r-pass-err', 'Include at least one letter and one number'); ok = false;
  } else { setErr('r-pass-err', ''); }

  if (!cpass) { setErr('r-cpass-err', 'Confirm your password'); ok = false; }
  else if (pass !== cpass) { setErr('r-cpass-err', 'Passwords do not match'); ok = false; }
  else { setErr('r-cpass-err', ''); }

  return ok;
}

function getRoleKey() {
  const sel = document.getElementById('r-role');
  if (!sel || sel.selectedIndex < 0) return '';
  const opt = sel.options[sel.selectedIndex];
  return normalizeRole(opt?.dataset?.roleKey || opt?.textContent || opt?.value || '');
}

function onRoleChange() {
  const rk = getRoleKey();
  const desigField = document.getElementById('field-r-designation');
  const classField = document.getElementById('field-r-class');
  const secField   = document.getElementById('field-r-section');
  const showStudent = rk === 'student';
  const showStaff   = rk === 'teacher' || rk === 'employee';
  if (classField) classField.classList.toggle('hidden', !showStudent);
  if (secField)   secField.classList.toggle('hidden', !showStudent);
  if (desigField) desigField.classList.toggle('hidden', !showStaff);
}

function regNext(from) {
  const validators = { 1: validateRegStep1, 2: validateRegStep2 };
  if (validators[from] && !validators[from]()) return;
  regStep = from + 1;
  setRegStep(regStep);
}

function regBack(from) {
  regStep = from - 1;
  setRegStep(regStep);
}

async function handleRegister() {
  if (!validateRegStep3()) return;

  const name    = document.getElementById('r-name').value.trim();
  const email   = document.getElementById('r-email').value.trim();
  const pass    = document.getElementById('r-password').value;
  const dob     = document.getElementById('r-dob').value;
  const mobile  = document.getElementById('r-mobile').value.trim();
  const empId   = document.getElementById('r-emp-id').value.trim();
  const role    = document.getElementById('r-role').value;
  const dept    = document.getElementById('r-dept').value;
  const cls     = document.getElementById('r-class')?.value || '';
  const section = document.getElementById('r-section')?.value || '';
  const desig   = document.getElementById('r-designation')?.value.trim() || '';
  const inst    = document.getElementById('r-institute')?.value || (tenantState?.institution?.name) || '';

  const bioHint = document.getElementById('bio-hint');
  const chip    = document.getElementById('bio-status-chip');

  setBtn('btn-register', true, 'Setting up biometric…');
  if (bioHint) bioHint.textContent = '🔐 Scan fingerprint or use Face ID when prompted…';

  try {
    // 1. Register biometric (triggers OS prompt)
    const credId = await registerBiometric(empId || email);
    if (chip) chip.textContent = '✓ Biometric registered';
    if (bioHint) bioHint.textContent = '📡 Creating your account…';

    // 2. Get device ID
    const deviceId = await getDeviceId();

    // 3. Create account
    const res = await api({
      action:       'register',
      name,  email,
      password:     pass,
      dob,   mobile,
      departmentId: dept,
      subcategoryId: section,
      classId:      cls,
      sectionId:    section,
      roleId:       role,
      instituteId:  inst,
      orgType:      tenantState?.orgType || 'college',
      studentEmployeeId: empId,
      designation:  desig,
      biometricCode: credId,
      deviceId,
      guid:         tenantState?.guid
    });

    if (res.success) {
      if (bioHint) bioHint.textContent = '✓ Account created!';
      toast('✓ Account created! Sign in to continue.', 'success');
      setTimeout(() => {
        switchAuth('login');
        const el = document.getElementById('li-email');
        if (el) el.value = email;
      }, 2000);
    } else {
      if (bioHint) bioHint.textContent = 'Registration failed — check details and try again';
      toast(res.message || 'Registration failed', 'error');
    }
  } catch (e) {
    if (bioHint) bioHint.textContent = 'When you tap Create Account, we\'ll ask for your fingerprint or Face ID.';
    if (e.name === 'NotAllowedError') toast('Biometric cancelled — tap button and try again', 'warn');
    else if (e.name === 'NotSupportedError') toast('Biometric not supported — try a different browser', 'error');
    else if (e.name === 'InvalidStateError') toast('Biometric already registered for this ID', 'error');
    else if (e.name === 'SecurityError') toast('Must be on HTTPS for biometric', 'error');
    else toast('Error: ' + e.message, 'error');
  } finally {
    setBtn('btn-register', false);
  }
}

async function loadLookups() {
  try {
    const [roleRes, deptRes, classRes, secRes] = await Promise.all([
      api({ action: 'getRoles' }),
      api({ action: 'getDepartments' }),
      api({ action: 'getClasses' }),
      api({ action: 'getSections' })
    ]);

    // Roles
    const roles = (roleRes?.data || []).filter(r => r?.role_id);
    const roleEl = document.getElementById('r-role');
    if (roleEl) {
      roleEl.innerHTML = '<option value="">Select role…</option>' +
        roles.map(r => {
          const rk = normalizeRole(r.name || r.role_id || '');
          return `<option value="${r.role_id}" data-role-key="${rk}">${roleName(r.name || rk)}</option>`;
        }).join('');
    }

    // Departments
    const depts = (deptRes?.data || []).filter(d => d?.department_id);
    const deptEl = document.getElementById('r-dept');
    if (deptEl) {
      deptEl.innerHTML = '<option value="">Select department…</option>' +
        depts.map(d => `<option value="${d.department_id}">${d.name}</option>`).join('');
    }

    // Classes
    const classes = (classRes?.data || []).filter(c => c?.class_id);
    const classEl = document.getElementById('r-class');
    if (classEl) {
      classEl.innerHTML = '<option value="">Select year…</option>' +
        classes.map(c => `<option value="${c.class_id}">${c.name}</option>`).join('');
    }

    // Sections
    const sections = (secRes?.data || []).filter(s => s?.section_id);
    const secEl = document.getElementById('r-section');
    if (secEl) {
      secEl.innerHTML = '<option value="">Select section…</option>' +
        sections.map(s => `<option value="${s.section_id}">${s.name}</option>`).join('');
    }

    // Institute name from tenant
    const instEl = document.getElementById('r-institute');
    if (instEl) {
      instEl.value = tenantState?.institution?.name || '';
    }

    onRoleChange();
  } catch (e) {
    console.warn('[lookups] failed:', e);
    // Fallback role options
    const roleEl = document.getElementById('r-role');
    if (roleEl) {
      roleEl.innerHTML = `
        <option value="">Select role…</option>
        <option value="3" data-role-key="student">Student</option>
        <option value="2" data-role-key="teacher">Teacher / Faculty</option>
        <option value="1" data-role-key="admin">Admin</option>
        <option value="4" data-role-key="employee">Employee</option>`;
    }
  }
}

function roleName(raw) {
  const r = normalizeRole(raw);
  if (r === 'student') return 'Student';
  if (r === 'teacher') return 'Teacher / Faculty';
  if (r === 'admin')   return 'Admin';
  if (r === 'employee') return 'Employee';
  return raw || '';
}

// ═══════════════════════════════════════════════════════════════
//  10. ATTENDANCE
// ═══════════════════════════════════════════════════════════════
let attendanceState = 'none'; // 'none' | 'in' | 'done'

async function handleMainAction() {
  if (!currentUser) { toast('Sign in first', 'error'); return; }
  if (attendanceState === 'done') { toast('Attendance already complete for today', 'success'); return; }
  if (attendanceState === 'in')   { return handleCheckout(); }
  return handleCheckin();
}

async function handleCheckin() {
  setBtn('btn-main-action', true, 'Getting location…');
  showGPS('getting', 'Getting your precise location…');

  try {
    const loc = await getLocationWithAddress();

    if (loc.denied) {
      hideGPS();
      showGPS('fail', 'Location access blocked — allow in browser settings');
      toast('Location permission denied', 'error');
      setBtn('btn-main-action', false);
      return;
    }

    if (loc.lat) {
      showGPS('ok', loc.address || `${loc.lat.toFixed(5)}, ${loc.lng.toFixed(5)} ±${Math.round(loc.accuracy || 0)}m`);
    } else {
      showGPS('fail', 'Location unavailable — attendance blocked');
      toast('GPS not available — move outdoors and retry', 'error');
      setBtn('btn-main-action', false);
      return;
    }

    setBtn('btn-main-action', true, 'Marking attendance…');
    const deviceId = await getDeviceId();
    const payload  = {
      action:      'markEntry',
      userId:      currentUser.userId,
      loginMethod: 'biometric',
      latitude:    loc.lat,
      longitude:   loc.lng,
      address:     loc.address,
      deviceId,
      guid:        tenantState?.guid
    };

    // Offline check
    if (!navigator.onLine) {
      const item = await enqueueAttendance(payload);
      toast('Offline — attendance queued for sync', 'warn');
      renderOfflineCheckin(loc);
      setBtn('btn-main-action', false);
      return;
    }

    const res = await api(payload);

    if (res.success) {
      toast('✓ ' + (res.message || 'Attendance marked'), 'success');
      todayRecord = res;
      attendanceState = 'in';
      updateTodayCard(res, loc);
    } else if (res.code === 'TOO_FAR') {
      showGPS('fail', `${res.distance}m from campus — must be within ${res.allowed}m`);
      toast(`Too far from campus (${res.distance}m)`, 'error');
    } else if (res.code === 'ALREADY_MARKED') {
      toast('Already marked for today', 'warn');
      attendanceState = 'in';
      updateTodayCard(res, loc);
    } else {
      toast(res.message || 'Could not mark attendance', 'error');
    }
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  } finally {
    setBtn('btn-main-action', false);
  }
}

async function handleCheckout() {
  if (!currentUser) return;
  setBtn('btn-checkout', true, 'Getting exit location…');
  showGPS('getting', 'Getting exit location…');

  try {
    const loc = await getLocationWithAddress();
    if (loc.lat) showGPS('ok', 'Exit: ' + (loc.address || `${loc.lat}, ${loc.lng}`));
    else showGPS('fail', 'Exit GPS unavailable');

    const res = await api({
      action:    'markExit',
      userId:    currentUser.userId,
      latitude:  loc.lat,
      longitude: loc.lng,
      address:   loc.address,
      guid:      tenantState?.guid
    });

    if (res.success) {
      toast('✓ Check-out recorded', 'success');
      attendanceState = 'done';
      updateTodayCard({ ...todayRecord, exitTime: res.exitTime, duration: res.duration }, loc);
      document.getElementById('btn-checkout')?.classList.add('hidden');
      const actionBtn = document.getElementById('btn-main-action');
      if (actionBtn) {
        actionBtn.disabled = true;
        actionBtn.innerHTML = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M20 6L9 17l-5-5"/></svg> Attendance Complete';
      }
    } else {
      toast(res.message || 'Check-out failed', 'error');
    }
  } catch (e) {
    toast('Check-out error: ' + e.message, 'error');
  } finally {
    setBtn('btn-checkout', false);
  }
}

function renderOfflineCheckin(loc) {
  const card = document.getElementById('today-status-card');
  if (card) card.className = 'status-card state-offline';
  const badge = document.getElementById('today-badge');
  if (badge) { badge.className = 'status-badge queued'; badge.textContent = 'Queued offline'; }
  const checkin = document.getElementById('today-checkin');
  if (checkin) { checkin.className = 'time-block-value'; checkin.textContent = fmtTime(new Date()); }
  const locEl = document.getElementById('today-location');
  const locTxt = document.getElementById('today-location-text');
  if (locEl) locEl.style.display = 'flex';
  if (locTxt) locTxt.textContent = loc.address || `${loc.lat?.toFixed(5)}, ${loc.lng?.toFixed(5)}`;
  attendanceState = 'in';
  updateMainActionBtn();
}

function updateTodayCard(data, loc) {
  const card  = document.getElementById('today-status-card');
  const badge = document.getElementById('today-badge');
  const ci    = document.getElementById('today-checkin');
  const co    = document.getElementById('today-checkout');
  const locEl = document.getElementById('today-location');
  const locTxt = document.getElementById('today-location-text');
  const distEl = document.getElementById('today-distance');

  if (!card) return;

  const isDone = attendanceState === 'done' || (data.entryTime && data.exitTime);
  card.className = 'status-card ' + (isDone ? 'state-done' : 'state-in');

  if (badge) {
    badge.className = 'status-badge ' + (isDone ? 'done' : 'in');
    badge.textContent = isDone ? 'Complete' : 'Checked In';
  }

  if (ci) {
    ci.className = 'time-block-value';
    ci.textContent = data.entryTime ? fmtTime(data.entryTime) : fmtTime(new Date());
  }

  if (co) {
    if (data.exitTime) {
      co.className = 'time-block-value';
      co.textContent = fmtTime(data.exitTime);
    } else {
      co.className = 'time-block-value empty';
      co.textContent = '--:--';
    }
  }

  if (locEl) locEl.style.display = 'flex';
  if (locTxt) locTxt.textContent = data.address || loc?.address || '';

  if (distEl && data.distanceFromCentre != null) {
    distEl.innerHTML = `<div class="distance-chip">
      <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><circle cx="12" cy="12" r="3"/><path d="M12 2v3M12 19v3M2 12h3M19 12h3"/></svg>
      ${Math.round(data.distanceFromCentre)}m from centre
    </div>`;
  }

  updateMainActionBtn();
}

function updateMainActionBtn() {
  const btn   = document.getElementById('btn-main-action');
  const coBtn = document.getElementById('btn-checkout');
  const icon  = document.getElementById('action-icon');
  const label = document.getElementById('action-label');

  if (!btn) return;

  if (attendanceState === 'done') {
    btn.disabled = true;
    if (icon)  icon.innerHTML = '<path d="M20 6L9 17l-5-5"/>';
    if (label) label.textContent = 'Attendance Complete';
    if (coBtn) coBtn.classList.add('hidden');
  } else if (attendanceState === 'in') {
    btn.disabled = false;
    if (icon)  icon.innerHTML = '<path d="M20 6L9 17l-5-5"/>';
    if (label) label.textContent = 'Re-check Location';
    if (coBtn) coBtn.classList.remove('hidden');
  } else {
    btn.disabled = false;
    if (icon)  icon.innerHTML = '<path d="M15 3h4a2 2 0 012 2v14a2 2 0 01-2 2h-4M10 17l5-5-5-5M15 12H3"/>';
    if (label) label.textContent = 'Mark Attendance';
    if (coBtn) coBtn.classList.add('hidden');
  }
}

// Session attendance
async function handleSessionAttendance() {
  // Just trigger check-in flow
  await handleCheckin();
}

// ═══════════════════════════════════════════════════════════════
//  11. DASHBOARD — refresh
// ═══════════════════════════════════════════════════════════════
async function refreshDashboard() {
  if (!currentUser) return;
  setupDashboardHeader();
  try {
    const res = await api({ action: 'getMyAttendance', userId: currentUser.userId, limit: 60 });
    if (res.records) {
      allHistory = res.records;
      renderRing(res.records);
      renderStats(res.records);
      renderRecentHistory(res.records.slice(0, 7));
      detectTodayStatus(res.records);
    }
  } catch (e) {
    console.warn('[dashboard] refresh error:', e);
  }
}

function detectTodayStatus(records) {
  const todayStr = new Date().toISOString().slice(0, 10);
  const todayRec = records.find(r => (r.date || r.attendance_date || '').slice(0, 10) === todayStr);
  if (!todayRec) {
    attendanceState = 'none';
    updateMainActionBtn();
    return;
  }
  todayRecord = todayRec;
  if (todayRec.exitTime || todayRec.exit_time) {
    attendanceState = 'done';
  } else {
    attendanceState = 'in';
  }
  updateTodayCard({
    entryTime:        todayRec.entryTime || todayRec.entry_time,
    exitTime:         todayRec.exitTime  || todayRec.exit_time,
    address:          todayRec.address,
    distanceFromCentre: todayRec.distanceFromCentre || todayRec.distance_from_centre
  }, null);
}

function renderStats(records) {
  const present = records.filter(r => r.entryTime || r.entry_time).length;
  const total   = records.length;
  const absent  = Math.max(0, total - present);

  const sp = document.getElementById('stat-present');
  const sa = document.getElementById('stat-absent');
  const st = document.getElementById('stat-total');
  if (sp) sp.textContent = present;
  if (sa) sa.textContent = absent;
  if (st) st.textContent = total;
}

function renderRing(records) {
  const present = records.filter(r => r.entryTime || r.entry_time).length;
  const total   = records.length || 1;
  const pct     = Math.round((present / total) * 100);

  const fill  = document.getElementById('ring-fill');
  const pctEl = document.getElementById('ring-pct');
  const sub   = document.getElementById('ring-sub');

  const circumference = 2 * Math.PI * 30; // r=30
  const offset = circumference - (pct / 100) * circumference;

  if (fill)  { fill.style.strokeDashoffset = offset; }
  if (pctEl) pctEl.textContent = pct + '%';
  if (sub)   sub.textContent = `${present} present out of ${total} days`;
}

function renderRecentHistory(records) {
  const el = document.getElementById('history-list');
  if (!el) return;
  if (!records.length) {
    el.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📋</div>Mark your first attendance to see history here</div>';
    return;
  }
  el.innerHTML = records.map(r => historyItemHTML(r)).join('');
}

function historyItemHTML(r) {
  const date = r.date || r.attendance_date || '';
  const entry = r.entryTime || r.entry_time;
  const exit  = r.exitTime  || r.exit_time;
  const method = r.loginMethod || r.login_method || '';
  const isQueued = r.queued;

  let status = 'absent';
  let statusLabel = 'Absent';
  if (isQueued) { status = 'queued'; statusLabel = 'Queued'; }
  else if (entry && exit) { status = 'present'; statusLabel = 'Present'; }
  else if (entry)         { status = 'partial'; statusLabel = 'Checked In'; }

  const detail = entry
    ? `In: ${fmtTime(entry)}${exit ? '  Out: ' + fmtTime(exit) : ''}${method ? '  ·  ' + method : ''}`
    : 'No entry recorded';

  return `<div class="hist-item">
    <div class="hist-dot ${status}"></div>
    <div class="hist-info">
      <div class="hist-date">${date ? fmtDate(date) : '—'}</div>
      <div class="hist-detail">${detail}</div>
    </div>
    <div class="hist-badge ${status}">${statusLabel}</div>
  </div>`;
}

let historyFullLoaded = false;

async function loadFullHistory() {
  const el = document.getElementById('full-history-list');
  if (!el) return;
  if (!currentUser) return;

  el.innerHTML = '<div class="empty-state"><div class="empty-state-icon">⏳</div>Loading…</div>';

  try {
    const res = await api({ action: 'getMyAttendance', userId: currentUser.userId });
    if (!res.records?.length) {
      el.innerHTML = '<div class="empty-state"><div class="empty-state-icon">📋</div>No attendance records yet</div>';
      return;
    }
    allHistory = res.records;
    renderFullHistory(allHistory);
    renderHistSummary(allHistory);
    historyFullLoaded = true;
  } catch (e) {
    el.innerHTML = '<div class="empty-state"><div class="empty-state-icon">⚠️</div>Could not load history</div>';
  }
}

function loadMoreHistory() {
  switchScreen('history');
}

function renderFullHistory(records) {
  const el = document.getElementById('full-history-list');
  if (!el) return;
  el.innerHTML = records.map(r => historyItemHTML(r)).join('');
}

function renderHistSummary(records) {
  const el = document.getElementById('hist-summary');
  if (!el) return;
  const present = records.filter(r => r.entryTime || r.entry_time).length;
  const total   = records.length;
  const pct     = total ? Math.round((present / total) * 100) : 0;
  el.style.display = 'block';
  el.innerHTML = `
    <div style="display:flex;gap:16px;align-items:center;">
      <div style="font-size:32px;font-weight:800;color:var(--text);letter-spacing:-1px">${pct}%</div>
      <div>
        <div style="font-size:13px;font-weight:700;color:var(--text)">Overall Attendance</div>
        <div style="font-size:11px;color:var(--muted);margin-top:3px">${present} present · ${total - present} absent · ${total} total</div>
      </div>
    </div>`;
}

function filterHistory(query) {
  if (!allHistory.length) return;
  const filtered = query
    ? allHistory.filter(r => (r.date || r.attendance_date || '').includes(query))
    : allHistory;
  renderFullHistory(filtered);
}

function exportCSV() {
  if (!allHistory.length) { toast('No data to export', 'warn'); return; }
  const rows = [
    ['Date', 'Check In', 'Check Out', 'Duration', 'Method', 'Address', 'Distance(m)', 'Status'],
    ...allHistory.map(r => {
      const entry  = r.entryTime || r.entry_time || '';
      const exit   = r.exitTime  || r.exit_time  || '';
      const status = entry && exit ? 'Present' : entry ? 'Partial' : 'Absent';
      return [
        r.date || r.attendance_date || '',
        entry, exit,
        r.duration || '',
        r.loginMethod || r.login_method || '',
        r.address || '',
        r.distanceFromCentre || r.distance_from_centre || '',
        status
      ];
    })
  ];
  const csv = rows.map(r => r.map(x => `"${String(x).replace(/"/g, '""')}"`).join(',')).join('\n');
  const a   = document.createElement('a');
  a.href    = URL.createObjectURL(new Blob([csv], { type: 'text/csv' }));
  a.download = 'attendance-' + new Date().toISOString().slice(0, 10) + '.csv';
  a.click();
}

// ═══════════════════════════════════════════════════════════════
//  12. PROFILE SCREEN
// ═══════════════════════════════════════════════════════════════
function renderProfileScreen() {
  if (!currentUser) return;
  const av   = document.getElementById('profile-avatar');
  const name = document.getElementById('profile-name');
  const email = document.getElementById('profile-email');
  const roleChip = document.getElementById('profile-role-chip');
  const details  = document.getElementById('profile-details');

  if (av)       av.textContent  = (currentUser.name || 'S')[0].toUpperCase();
  if (name)     name.textContent = currentUser.name || 'Student';
  if (email)    email.textContent = currentUser.email || '';
  if (roleChip) roleChip.textContent = roleName(currentUser.roleKey || 'student');

  if (details) {
    const rows = [
      ['User ID', currentUser.userId],
      ['Department', currentUser.dept],
      ['Class', currentUser.classId],
      ['Section', currentUser.sectionId]
    ].filter(([, v]) => v);

    details.innerHTML = rows.map(([k, v]) =>
      `<div style="display:flex;align-items:center;justify-content:space-between;padding:6px 0;border-bottom:1px solid var(--border);">
        <span style="font-size:12px;color:var(--muted);font-weight:500">${k}</span>
        <span style="font-size:13px;color:var(--text);font-weight:600">${v}</span>
      </div>`
    ).join('');
  }
}

async function reRegisterBiometric() {
  if (!currentUser) return;
  try {
    const credId = await registerBiometric(currentUser.userId);
    const res = await api({
      action: 'saveBiometric',
      userId: currentUser.userId,
      biometricCode: credId,
      guid: tenantState?.guid
    });
    toast(res.success ? '✓ Biometric updated' : (res.message || 'Failed'), res.success ? 'success' : 'error');
  } catch (e) {
    if (e.name === 'NotAllowedError') toast('Biometric cancelled', 'warn');
    else toast('Error: ' + e.message, 'error');
  }
}

// ═══════════════════════════════════════════════════════════════
//  13. WORK LOCATION REQUEST
// ═══════════════════════════════════════════════════════════════
function showWLR() {
  const overlay = document.getElementById('wlr-overlay');
  if (!overlay) return;
  overlay.style.display = 'flex';
  const dateEl = document.getElementById('wlr-date');
  if (dateEl) dateEl.value = new Date().toISOString().slice(0, 10);
}

function closeWLR(e) {
  if (e && e.target !== e.currentTarget) return;
  const overlay = document.getElementById('wlr-overlay');
  if (overlay) overlay.style.display = 'none';
}

async function submitWLR() {
  if (!currentUser) return;
  const date   = document.getElementById('wlr-date')?.value;
  const name   = document.getElementById('wlr-name')?.value.trim();
  const reason = document.getElementById('wlr-reason')?.value.trim();
  if (!date || !name || !reason) { toast('Fill all fields', 'error'); return; }

  setBtn('btn-wlr-submit', true, 'Submitting…');
  try {
    const loc = await getLocation(8000);
    const res = await api({
      action:        'createWorkLocationRequest',
      userId:        currentUser.userId,
      requestDate:   date,
      locationName:  name,
      reason,
      latitude:      loc.lat || 0,
      longitude:     loc.lng || 0,
      allowedDistance: 500,
      guid:          tenantState?.guid
    });
    if (res.success) {
      toast('✓ Request submitted — awaiting admin approval', 'success');
      closeWLR();
    } else {
      toast(res.message || 'Submission failed', 'error');
    }
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  } finally {
    setBtn('btn-wlr-submit', false);
  }
}

// ═══════════════════════════════════════════════════════════════
//  14. ACTIVE SESSION POLLING
// ═══════════════════════════════════════════════════════════════
function startSessionPoll() {
  stopSessionPoll();
  pollActiveSession();
  sessionPollTimer = setInterval(pollActiveSession, 90000); // every 90s
}

function stopSessionPoll() {
  if (sessionPollTimer) { clearInterval(sessionPollTimer); sessionPollTimer = null; }
}

async function pollActiveSession() {
  if (!currentUser || !navigator.onLine) return;
  try {
    const res = await api({ action: 'getActiveSession', guid: tenantState?.guid });
    const banner = document.getElementById('session-banner');
    const title  = document.getElementById('session-banner-title');
    const sub    = document.getElementById('session-banner-sub');
    if (!banner) return;
    if (res.active && res.session) {
      banner.classList.add('show');
      if (title) title.textContent = 'Live session: ' + (res.session.subject || 'Class');
      if (sub)   sub.textContent   = `Open now · closes in ${res.session.window_minutes || '?'}min`;
    } else {
      banner.classList.remove('show');
    }
  } catch (_) {}
}

// ═══════════════════════════════════════════════════════════════
//  15. PWA INSTALL PROMPT
// ═══════════════════════════════════════════════════════════════
window.addEventListener('beforeinstallprompt', e => {
  e.preventDefault();
  deferredInstall = e;
  // Show prompt after 10s on auth screen
  setTimeout(() => {
    if (currentScreen === 'auth' || currentScreen === 'home') showInstallPrompt();
  }, 10000);
});

function showInstallPrompt() {
  const el = document.getElementById('install-prompt');
  if (el) el.classList.add('show');
}

function hideInstallPrompt() {
  const el = document.getElementById('install-prompt');
  if (el) el.classList.remove('show');
}

document.getElementById('btn-install')?.addEventListener('click', async () => {
  hideInstallPrompt();
  if (!deferredInstall) return;
  deferredInstall.prompt();
  await deferredInstall.userChoice;
  deferredInstall = null;
});

document.getElementById('btn-install-dismiss')?.addEventListener('click', () => {
  hideInstallPrompt();
});

window.addEventListener('appinstalled', () => {
  deferredInstall = null;
  hideInstallPrompt();
  toast('✓ BioAttend installed on home screen', 'success');
});

// ═══════════════════════════════════════════════════════════════
//  16. ONLINE / OFFLINE
// ═══════════════════════════════════════════════════════════════
function updateOnlineStatus() {
  const bar = document.getElementById('offline-bar');
  if (bar) bar.classList.toggle('show', !navigator.onLine);
  if (navigator.onLine && offlineQueue.length > 0) {
    setTimeout(manualSync, 2000);
  }
}

window.addEventListener('online',  updateOnlineStatus);
window.addEventListener('offline', updateOnlineStatus);

// ═══════════════════════════════════════════════════════════════
//  17. SESSION RESTORE
// ═══════════════════════════════════════════════════════════════
async function restoreSession() {
  try {
    const saved = localStorage.getItem(SESSION_KEY);
    if (!saved) return false;
    const user = JSON.parse(saved);
    if (!user?.userId) return false;
    currentUser = user;
    setupDashboardHeader();
    await loadOfflineQueue();
    switchScreen('home');
    refreshDashboard();
    startSessionPoll();
    return true;
  } catch (_) {
    return false;
  }
}

// ═══════════════════════════════════════════════════════════════
//  18. BOOT
// ═══════════════════════════════════════════════════════════════
(async () => {
  initTheme();
  updateOnlineStatus();

  // Boot tenant (from tenant.js)
  if (typeof bootTenant === 'function') {
    try {
      await bootTenant();
      // Apply brand
      const orgEl = document.getElementById('brand-org');
      if (orgEl && tenantState?.institution?.name) orgEl.textContent = tenantState.institution.name;
      if (orgEl && !tenantState?.institution?.name) orgEl.textContent = '';
      const authTitle = document.getElementById('auth-title');
      if (authTitle && tenantState?.institution?.name) authTitle.textContent = tenantState.institution.name;
    } catch (_) {}
  }

  // Try restore session
  const restored = await restoreSession();
  if (!restored) {
    switchScreen('auth');
    switchAuth('login');
  }

  // Set DOB max
  const dobEl = document.getElementById('r-dob');
  if (dobEl) dobEl.max = new Date().toISOString().slice(0, 10);
})();
