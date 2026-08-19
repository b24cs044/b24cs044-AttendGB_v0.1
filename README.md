# AttendX - Teacher/Admin App

AttendX is a classroom attendance app built as an installable PWA. Teachers use it to mark attendance for their classes and check records. Admins additionally set up institutions, branches, classes, and shared reference data.

The app is local-first - data is written to the browser's localStorage first, so it's usable offline, and syncs to a Google Apps Script backend when a connection is available.

This is the companion app to the Student/Faculty check-in app, which shares the same backend and Google Sheet but is a separate codebase.

## What it does

- Mark attendance per class/section
- Manage the student roster, including CSV import
- View attendance records, per-student percentages, and subject-wise reports
- Send parent alerts over SMS, email, or Telegram for students who are at risk or recently absent
- Post and read institution-wide notices
- Manage institutions, branches, classes, and master data (admin only)
- Back up and restore data manually as a JSON file
- Sign in with WebAuthn or a PIN as a faster alternative to typing a password
- Keep working with no connection, syncing changes once back online

## Stack

Plain HTML5 and hand-written CSS, no framework. The application logic is vanilla ES6 JavaScript with no bundler and no TypeScript. Data is kept in localStorage under an `ax2_` namespace rather than IndexedDB. Offline support comes from a service worker using the Cache API plus a web app manifest. Optional second-factor auth uses WebAuthn with a local PIN-hash fallback. The backend is a Google Apps Script web app (`doGet`/`doPost`) reading and writing a Google Sheet.

## Project layout

```
index.html          entire app: markup, CSS, and inline JS
manifest.json        PWA install metadata
service-worker.js    offline caching logic
icons/                app icons referenced by manifest.json
```

There's no build step - everything ships in one HTML file. Internally it's organized into module objects like `DB`, `State`, `API`, `Auth`, `App`, `Students`, `Records`, `Analytics`, and `Notices`.

## Roles

| Capability | Admin | Teacher |
|---|---|---|
| Mark attendance, view records/analytics, send alerts | yes | yes |
| Add, edit, delete students | yes | yes |
| Delete attendance records | yes | no |
| Access Manage (institutions/branches/classes/master data) | yes | no |
| Post, edit, delete notices | yes | read-only |

## Free plan limits

One active institution, one active branch, and up to three classes per active institution/branch pair. These are structural caps only - there's no limit on how many students or records can be stored.

## Setting it up

1. Host `index.html`, `manifest.json`, `service-worker.js`, and `icons/` at the domain root. The service worker registers with scope `/`, so hosting from a sub-path will break it.
2. Serve everything over HTTPS - required for service worker registration and WebAuthn.
3. Deploy the companion Google Apps Script project as a web app (execute as Me, access Anyone), then set the `GAS_URL` constant near the top of the inline script in `index.html` to match its deployment URL.
4. Add the icons referenced in `manifest.json` (`icons/icon-192x192.png`, `icons/icon-512x512.png`, `icons/maskable-icon.png`) plus a favicon.
5. Bump `CACHE_NAME` in `service-worker.js` on every release that changes a cached asset, otherwise returning users can get stuck on a stale cache.

## Things worth knowing before you rely on this in production

- Passwords are stored in plain text in localStorage. That's fine for a single trusted device, but not something to expose to the open internet without adding server-side auth with hashed credentials.
- Role checks are enforced in the UI only - the Apps Script backend, as called by this client, doesn't appear to do its own authorization checks. Harden that layer if sensitive data is involved.
- The Apps Script URL is embedded directly in the client-side source, so anyone reading the page can call it directly.
- There's no conflict resolution between local and cloud writes - last write wins, with no merge or version tracking.
- localStorage has a practical size limit, usually 5-10MB per origin. A very large, long-running dataset could eventually hit that ceiling with no warning beyond a silent failure.
- The CSV importers split rows on a naive comma, so any field with an embedded comma will misalign columns.
- There's a "Bluetooth Attendance" entry point in the markup that's currently commented out and not active - it's a planned feature, not a bug.