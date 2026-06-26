# BioAttend Student PWA — Deployment Guide

## What's in this folder

```
/
├── index.html          ← Full student PWA shell + all UI
├── app-student.js      ← All student logic (auth, GPS, biometric, offline, ring)
├── tenant.js           ← GAS API transport, tenant resolution, token management
├── styles.css          ← Supplementary styles (print, accessibility, animations)
├── sw.js               ← Service Worker (caching, offline queue, push, background sync)
├── manifest.json       ← PWA manifest (install prompt, home screen)
├── offline.html        ← Shown when app is not cached and user is offline
├── icons/
│   ├── icon-72.png
│   ├── icon-96.png
│   ├── icon-128.png
│   ├── icon-192.png
│   ├── icon-512.png
│   └── icon-512-maskable.png
├── _headers            ← Cloudflare Pages HTTP headers (security, caching)
└── _redirects          ← Cloudflare Pages routing (SPA fallback)
```

---

## Prerequisites

- A Cloudflare account with Pages enabled
- Your Google Apps Script backend already deployed as a web app
- Your tenant GUID(s) known (e.g. `1` for SIT, `2` for SSIT)

---

## Step 1 — Update tenant.js with your real GUIDs

Open `tenant.js` and edit `EXPECTED_TENANTS` and `FALLBACK_TENANTS` with your institution's real details:

```js
const EXPECTED_TENANTS = {
  '1': {
    name: 'YOUR_COLLEGE_SHORT_NAME',
    apiUrl: 'https://script.google.com/macros/s/YOUR_GAS_DEPLOYMENT_ID/exec'
  }
};
```

Also set `NERVE_URL` to your Nerve registry URL, or leave it as-is if you're using the existing Nerve deployment.

---

## Step 2 — Replace icons with your institution's branding

Replace the generated placeholder icons in `/icons/` with your actual logo:

- Minimum required: `icon-192.png` and `icon-512.png`
- The maskable icon (`icon-512-maskable.png`) should have your logo centred in the middle 60% of the canvas with solid background padding around it
- Tool: [maskable.app](https://maskable.app) — free, browser-based

Update `manifest.json` if you change filenames.

---

## Step 3 — Deploy to Cloudflare Pages

### Option A: Direct upload (fastest)

1. Go to [dash.cloudflare.com](https://dash.cloudflare.com) → Pages
2. Click **Create a project** → **Upload assets**
3. Give the project a name (e.g. `bioattend-student`)
4. Drag and drop this entire folder
5. Click **Deploy site**

### Option B: Git-connected (recommended for ongoing updates)

1. Push this folder to a GitHub/GitLab repository
2. Cloudflare Pages → **Create a project** → **Connect to Git**
3. Select your repo and branch
4. Build settings: leave blank (no build step needed — pure static files)
5. Click **Save and Deploy**

---

## Step 4 — Set your custom domain (optional)

In Cloudflare Pages → your project → **Custom domains** → add your domain.

Cloudflare will automatically provision SSL. No configuration needed.

---

## Step 5 — Share tenant URLs with students

Students access the app at:

```
https://your-domain.pages.dev/?q=1     ← SIT
https://your-domain.pages.dev/?q=2     ← SSIT
```

The `?q=` parameter selects the tenant (institution). The app caches tenant config for 24h, so subsequent loads are instant even offline.

---

## Step 6 — HTTPS requirement for Biometric + GPS

Both WebAuthn (biometric) and Geolocation require **HTTPS**. Cloudflare Pages serves all sites over HTTPS by default. If you're testing locally:

```bash
# Use a self-signed cert with local-ssl-proxy or similar
npx serve . --ssl-cert cert.pem --ssl-key key.pem
```

Or use [ngrok](https://ngrok.com) to tunnel localhost to HTTPS.

---

## Step 7 — Push notifications (optional, advanced)

Push notifications require a server-side push relay. The SW is ready to receive them. To enable:

1. Generate VAPID keys: `npx web-push generate-vapid-keys`
2. Set up a lightweight push relay (Cloudflare Worker or small Node server)
3. Add your VAPID public key to the SW subscription call
4. Backend sends push events when: sessions open, requests approved, etc.

This is optional — the app works fully without push (it polls for active sessions every 90 seconds while open).

---

## Student URL format

```
https://yourdomain.com/?q=GUID
```

QR code generators (qr-code-generator.com, etc.) can wrap this URL for quick student onboarding.

---

## Updating the app

If you push changes to any file:

1. Re-upload to Cloudflare Pages or push to Git
2. Increment `CACHE_VERSION` in `sw.js` (e.g. `v2` → `v3`) to force all clients to update their cache
3. On next visit, clients will get the new SW, which activates after all tabs close

```js
// sw.js — line 7
const CACHE_VERSION = 'v3';  // ← bump this on each deploy
```

---

## Troubleshooting

| Issue | Fix |
|---|---|
| Biometric not working | Must be on HTTPS; check browser supports WebAuthn |
| GPS not working | User must allow location; test on a real device (not desktop emulator) |
| App not installable | Check manifest.json has correct icons and `display: standalone` |
| JSONP requests failing | Check GAS deployment is set to "Execute as: Me", "Access: Anyone" |
| Offline not working | SW must be registered; check Chrome DevTools → Application → Service Workers |
| Wrong tenant loaded | Check `?q=` param in URL; clear localStorage if stale cache is suspected |
