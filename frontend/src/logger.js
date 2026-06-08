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
 *
 * KAL-NEW-11 (security audit 2026-05-30): the shape-based regexes above only
 * catch emails/UUIDs/token-keys. The wizard pushes whole step-data objects
 * (persons, health) whose values are minors' names, dates of birth, allergies
 * and medical conditions — Art. 9 GDPR special-category data with no universal
 * regex shape. These are redacted by KEY NAME via PII_KEY_PATTERNS below.
 * TODO Stage 2: add per-key parity to the backend `redact_` helper.
 */

// KAL-11: was 500 — reduced to 50. The wizard generates ~5-10 log entries per
// step transition; 50 covers the user's recent activity without keeping a
// long-lived backlog that could accumulate PII if redaction misses anything.
// ⚠️ DBG-SESSION (2026-06-08): subido temporalmente a 600 para una pasada E2E
// completa (11 pasos × instrumentación pesada [DBG …]). REVERTIR a 50 al cerrar
// la depuración (los logs [DBG] usan solo prefijos de 8 chars / counts, sin PII).
const MAX_ENTRIES = 600;
const listeners   = new Set();
export const entries = [];

// DBG-SESSION helper: prefijo corto y estable de un id (UUID/clave). 8 chars NO
// casan con UUID_RE (8-4-4-4-12) → sobreviven al redactor y siguen siendo
// comparables para diagnosticar el matching de claves `${qid}__${respondent}`.
// NO es un secreto ni PII (ids internos truncados). Quitar con el resto de [DBG].
export const sid = (x) => (x === null || x === undefined ? String(x) : String(x).slice(0, 8));

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

// KAL-NEW-11: keys whose VALUE is PII (names, DOB, medical, address…) — not
// detectable by a shape regex. Matched against object keys in redactDeep and
// collapsed to a constant '[PII]' marker (NOT a preview — "Mar..." still
// identifies a minor). Keep in sync with the backend redact_ when it gains
// per-key support (TODO Stage 2).
const PII_KEY_PATTERNS = [
  /^first_name$/i,
  /^last_name$/i,
  /^full_name$/i,
  /^name$/i,          // generic
  /^dob$/i,
  /^birth_date$/i,
  /^date_of_birth$/i,
  /^nationality(?:_.*)?$/i,
  /^passport(?:_.*)?$/i,
  /^national_id(?:_.*)?$/i,
  /^id_number$/i,
  /^address(?:_.*)?$/i,
  /^street$/i,
  /^postal_code$/i,
  /^city$/i,
  /^phone(?:_.*)?$/i,
  /^medical/i,        // medical_condition, medical_notes, medical_cert, …
  /^allerg/i,         // allergies, allergy_*
  /^dietary/i,        // dietary_requirements, dietary_*
  /^health(?:_.*)?$/i,
  /^condition(?:_.*)?$/i,
  /^school_history(?:_.*)?$/i,
];

function isPiiKey(k) {
  return PII_KEY_PATTERNS.some(re => re.test(k));
}

/**
 * Walks a value (string/array/object) and returns a redacted clone.
 * - Keys matching PII_KEY_PATTERNS (names, DOB, medical, address…) →
 *   collapsed to the constant '[PII]' marker (KAL-NEW-11). null/undefined
 *   values are preserved as-is (no '[PII]' for absent data).
 * - Keys that look like tokens (`token`, `resume_token`, `*_token`) →
 *   collapsed to a `<first8>...` preview to avoid leaking bearer secrets.
 * - Everything else → recursed + string values shape-redacted (email/UUID).
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
      // KAL-NEW-11: PII keys → constant marker (no preview). Preserve null/undefined.
      if (isPiiKey(k)) {
        out[k] = (v === null || v === undefined) ? v : '[PII]';
      }
      // KAL-11: token-shaped keys → preview only.
      else if (/token$/i.test(k) && typeof v === 'string' && v.length > 8) {
        out[k] = v.slice(0, 8) + '...';
      } else {
        out[k] = redactDeep(v);
      }
    }
    return out;
  }
  return value;
}

// KAL-NEW-11: internal export for verification (see docs/prompts test cases).
// Underscore prefix marks it as not part of the public logging API.
export const _redactDeepForTest = redactDeep;

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
