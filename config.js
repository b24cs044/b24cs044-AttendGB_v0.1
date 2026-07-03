/**
 * ============================================================
 * AttendX — Runtime Configuration
 * ============================================================
 * This file is loaded BEFORE the main app JavaScript.
 * It sets window.ATTEND_GB_CONFIG so that the app modules
 * can read configuration without hard-coding values.
 *
 * HOW TO DEPLOY:
 *   1. Replace GAS_URL with your deployed Google Apps Script URL.
 *      Format: https://script.google.com/macros/s/YOUR_ID/exec
 *   2. Adjust geofence, face-queue, and anomaly thresholds as needed.
 *   3. On Cloudflare Pages, you can use a build-time replacement or
 *      keep this file and update it before each deployment.
 * ============================================================
 */

window.ATTEND_X_CONFIG = {

  /* ── Backend ─────────────────────────────────────────────── */

  /**
   * URL of your deployed Google Apps Script web-app.
   * Leave as empty string during local development; the app will
   * enter "offline demo mode" automatically.
   */
  gasUrl: '',

  /* ── Application metadata ────────────────────────────────── */

  appVersion:  '1.0.0',
  appName:     'AttendX',

  /* ── Geofence / GPS ──────────────────────────────────────── */

  /**
   * Default class/institution location used when no server-side
   * class mapping is available. Replace with your institution's
   * actual coordinates.
   *
   * radiusMeters: how close the user must be to mark attendance.
   * accuracyThreshold: GPS fixes with accuracy WORSE than this value
   *   (in metres) are flagged as anomalous — a reading of ±500 m
   *   almost certainly means the device is using Wi-Fi/cell towers
   *   instead of real GPS and should not be trusted.
   */
  defaultClassLocation: {
    lat:          25.5788,
    lng:          91.8933,
    radiusMeters: 150,
    name:         'Main Academic Block',
  },

  /** Reject GPS fixes whose accuracy is worse than this (metres). */
  gpsAccuracyThreshold: 80,

  /* ── Face-capture queue limits ───────────────────────────── */

  /**
   * Rolling queue constraints for locally stored face images.
   * Oldest images are deleted first when either limit is exceeded.
   *
   * maxFaceCaptures: total number of images to keep.
   * maxFaceQueueMB:  total storage budget in megabytes.
   */
  maxFaceCaptures: 600,   // ~20 captures/day x 30 days
  maxFaceQueueMB:  20,    // 20 MB hard limit

  /* ── Anomaly detection thresholds ───────────────────────── */

  /**
   * Minimum seconds that must elapse between two consecutive
   * attendance marks. Guards against double-tap / rapid re-submission.
   */
  minSecondsBetweenMarks: 30,

  /**
   * If GPS accuracy is worse than gpsAccuracyThreshold,
   * how many consecutive bad readings before anomaly is flagged?
   */
  badGpsReadingsBeforeFlag: 3,

  /**
   * Maximum distance (metres) a user is allowed to travel between
   * two attendance events. Exceeding this suggests location spoofing.
   */
  maxTeleportDistanceMeters: 5000,

  /* ── Session polling ─────────────────────────────────────── */

  /**
   * How often (ms) the app polls the server for a live class session.
   * 120000 = 2 minutes.
   */
  sessionPollIntervalMs: 120000,

  /* ── Offline sync ────────────────────────────────────────── */

  /**
   * Background sync tag registered with the Service Worker.
   * Must match the tag used in sw.js.
   */
  bgSyncTag: 'attendx-sync',
};
