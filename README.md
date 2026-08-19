# AttendX - Student/Faculty App

AttendX is the check-in app students and faculty use every day. Instead of a paper register or a roll call, you open the app, tap Mark Attendance, and it confirms three things at once where possible: where you are (GPS), that it's really you (a live face photo checked on-device), and optionally that you're near a classroom Bluetooth device.

This app is the companion to the Teacher/Admin app - institutions, classes, subjects, and notices are all set up there. This app is only used to check in and view your own attendance.

## What it does

- Check in with GPS, a live face match, and optional Bluetooth proximity pairing
- Set up Fingerprint (WebAuthn) or Face Login for faster sign-in and anti-proxy protection, with a 30-day cooldown between re-setups and a 90-day expiry
- Check out separately, so total time present is tracked, not just a single tap
- View attendance history with check-in/check-out pairing and CSV export
- Submit a Work Location Request (WLR) if you genuinely can't be physically present - this goes to your admin for approval, it doesn't mark you present automatically
- Read notices posted by your institution
- Get push notifications, for example when a live attendance window opens
- Keep working offline - a check-in made with no signal is queued and sent automatically once you're back online

## Stack

Plain HTML5 and hand-written CSS using design-token custom properties, no framework. JavaScript is vanilla ES6 with modules written as IIFEs, no bundler or TypeScript. Local persistence is IndexedDB with a structured, versioned schema; localStorage is only used for small flags. Offline support relies on a service worker with background sync and periodic background sync. Push notifications go through the Web Push API. Face recognition uses face-api.js 0.22.2 (TensorFlow.js underneath) with a tiny face detector, 68-point landmarks, and a recognition net. Location uses the Geolocation API plus OpenStreetMap Nominatim for reverse geocoding. Bluetooth proximity goes through the Web Bluetooth API and is feature-detected, so it degrades gracefully where unsupported. Auth adds WebAuthn alongside on-device Face Login. The backend is the same Google Apps Script web app and Google Sheet used by the Teacher/Admin app. It's built to deploy on Cloudflare Pages or any static host.

## Project layout

```
index.html    markup, CSS, and three inline scripts: service worker registration, GAS config, and the app itself
sw.js         service worker: caching, background sync, push, notification click routing
manifest.json PWA install metadata, shortcuts, and install screenshots
```

Modules include `DB`, `GAS`, `CryptoUtil`, `FaceCam`, `FaceAuth`, `Auth`, `Register`, `GPS`, `BT`, `Notices`, `App`, `History`, `UI`, `Toast`, and `Validate`.

## On privacy

Face matching happens on-device - your live photo is compared locally against your enrolled face signature rather than sent off for someone to look at. The photo taken at check-in and the numeric face signature (not the raw image) are stored with your attendance record and synced to your institution's backend, along with your GPS coordinates, place name, and accuracy for that entry. Camera and location permissions are required; attendance can't be marked without them.

## Setting it up

1. Host `index.html`, `manifest.json`, `sw.js`, and `icons/` (including the screenshot referenced in the manifest) at the domain root - the service worker registers with scope `/`, so sub-path hosting will break both the manifest scope and offline caching.
2. Serve everything over HTTPS - required for service worker registration, WebAuthn, geolocation, camera access, and Web Bluetooth, all of which this app depends on.
3. Set `window.ATTEND_X_CONFIG.gasUrl` in the second inline script of `index.html` to your deployed Google Apps Script web app URL. Leave it blank to run in local/offline-only demo mode.
4. Deploy the same Apps Script backend and Google Sheet used by the Teacher/Admin app, since both apps share subjects, notices, and attendance records.
5. Bump `CACHE_VERSION` in `sw.js` on every release that changes a cached asset.
6. If you want push notifications working, provision VAPID keys and implement the PushManager subscription flow - the push-handling code in `sw.js` assumes this is already in place, but it isn't wired up out of the box.

## Things worth knowing before you rely on this in production

- The face-match threshold is a tunable trade-off between false rejects and false accepts. Validate it against your institution's typical lighting and camera conditions before treating it as your sole anti-proxy control, and make sure the backend actually re-runs its own comparison rather than trusting the client's verdict.
- GPS coordinates can be spoofed through dev tools, rooted/jailbroken devices, or location-mocking apps. Geofencing raises the bar but isn't a hard guarantee of physical presence.
- Reverse geocoding depends on the free, rate-limited Nominatim API - high volume may need a paid provider or more caching than the current setup.
- There's no conflict resolution if the same record somehow syncs twice - duplicate handling depends entirely on the backend's own idempotency logic.
- The service worker keeps its own hand-maintained copy of the IndexedDB schema, separate from the main page's copy, so the two can drift out of sync if one is updated without the other.
- The Apps Script URL is embedded directly in client-side source, so anyone reading the page can see and call it.
- Bluetooth pairing is optional and some browsers, notably iOS Safari, don't support Web Bluetooth at all - you can still check in with GPS and face verification either way.