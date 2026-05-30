/**
 * DEV LOGGER — lightweight pub/sub log store.
 * Import log functions anywhere in the app.
 * Mirrors to browser console AND the floating DevLogger panel.
 *
 * KAL-11 (security audit 2026-05-29): PII redaction.
 * Logs are visible to anyone with the dev tools open and persist in the
 * DevLogger panel (visible during screen shares). Emails / UUIDs / resume
 * tokens MUST be redacted before being pushed to the store.
 *
 * Mirrors the backend `redact_` helper in backend/Code.js. Keep regexes in
 * sync — they target the same shapes (RFC-light email, canonical UUIDv4).
 */

// KAL-11: was 500 — reduced to 50. The wizard generates ~5-10 log entries per
// step transition; 50 covers the user's recent activity without keeping a
// long-lived backlog that could accumulate PII if redaction misses anything.
const MAX_ENTRIES = 50;
const listeners   = new Set();
export const entries = [];

// KAL-11: regexes match the backend's redact_ helper (Code.js).
const EMAIL_RE = /[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g;
const UUID_RE  = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi;

/**
 * Redacts emails and UUIDs from a string. Idempotent.
 * @param {*} s
 * @returns {string}
 */
function redact(s) {
  if (s === null || s === undefined) return s;
  return String(s).replace(EMAIL_RE, '[EMAIL]').replace(UUID_RE, '[UUID]');
}

/**
 * Walks a value (string/array/object) and returns a redacted clone.
 * Keys that look like tokens (`token`, `resume_token`, `*_token`) get
 * collapsed to a `<first8>...` preview to avoid leaking bearer secrets.
 */
function redactDeep(value) {
  if (value === null || value === undefined) return value;
  if (typeof value === 'string') return redact(value);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map(redactDeep);
  if (typeof value === 'object') {
    const out = {};
    for (const k of Object.keys(value)) {
      const v = value[k];
      // Token-shaped keys → preview only.
      if (/token$/i.test(k) && typeof v === 'string' && v.length > 8) {
        out[k] = v.slice(0, 8) + '...';
      } else {
        out[k] = redactDeep(v);
      }
    }
    return out;
  }
  return value;
}

function push(level, message, data) {
  // KAL-11: redact PII from both the message string and the data payload.
  const safeMessage = redact(message);
  const safeData    = data !== undefined ? redactDeep(data) : undefined;
  const entry = {
    id:  Date.now() + Math.random(),
    ts:  new Date().toISOString().slice(11, 23), // HH:MM:SS.mmm
    level,
    message: safeMessage,
    data: safeData !== undefined
      ? (() => { try { return JSON.stringify(safeData, null, 2); } catch { return String(safeData); } })()
      : undefined,
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();
  listeners.forEach(fn => fn([...entries]));
  // Mirror to browser console — also redacted so screen-shared devtools are safe.
  const con = level === 'error' ? console.error
    : level === 'warn'  ? console.warn
    : level === 'debug' ? console.debug
    : console.log;
  con(`[ENR ${level.toUpperCase()}] ${safeMessage}`, safeData !== undefined ? safeData : '');
}

export const debug   = (msg, data) => push('debug',   msg, data);
export const info    = (msg, data) => push('info',    msg, data);
export const success = (msg, data) => push('success', msg, data);
export const warn    = (msg, data) => push('warn',    msg, data);
export const error   = (msg, data) => push('error',   msg, data);

export function subscribe(fn) {
  listeners.add(fn);
  return () => listeners.delete(fn);
}

export function clear() {
  entries.length = 0;
  listeners.forEach(fn => fn([]));
}
