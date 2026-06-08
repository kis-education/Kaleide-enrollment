/**
 * GAS API client.
 * Every call includes _hp (honeypot — empty, untouched by real users).
 */

// ─── Lookups cache ────────────────────────────────────────────────────────────
// fetchLookups result is static for the lifetime of the page — cache it.
// prefetchLookups() kicks off the request early; fetchLookups() returns the
// cached promise (or value) so steps get the result immediately if it's ready.
let _lookupsCache  = null;
let _lookupsFlight = null;

export function prefetchLookups() {
  if (_lookupsCache || _lookupsFlight) return;
  _lookupsFlight = gasCall('fetchLookups', {})
    .then(data  => { _lookupsCache = data; _lookupsFlight = null; return data; })
    .catch(_err => { _lookupsFlight = null; });
}

export function fetchLookups() {
  if (_lookupsCache)  return Promise.resolve(_lookupsCache);
  if (_lookupsFlight) return _lookupsFlight;
  _lookupsFlight = gasCall('fetchLookups', {})
    .then(data  => { _lookupsCache = data; _lookupsFlight = null; return data; })
    .catch(err  => { _lookupsFlight = null; throw err; });
  return _lookupsFlight;
}

// ─── Signing-session READ single-flight (data-layer pieza 5: corta la tormenta) ──
// `initiateSigningSession` con create_only:true es una LECTURA del estado de la
// sesión de firma (miembros, sub-pasos completados). SignReview (mount) + SignSign
// (mount) + re-mounts concurrentes la disparaban por separado → tormenta de llamadas
// concurrentes que AppSheet throttlea a 30-60s. Single-flight por signing_token:
// mientras hay una lectura EN VUELO para ese token, los demás llamantes comparten la
// MISMA promesa. Al settle se limpia → la siguiente lectura (tras un cambio de estado)
// va fresca (sin cache stale).
//   IMPORTANTE: SOLO de-duplica la LECTURA create_only:true. El DISPATCH real del
//   envelope (initiateSigningSession SIN create_only, en SignSign por acción explícita
//   del usuario) NUNCA pasa por aquí — el STOP-GAP de SignSign se preserva intacto.
const _signingReadFlight = {};   // { [token]: promise }
export function initiateSigningRead(signingToken) {
  if (!signingToken) return Promise.reject(new Error('initiateSigningRead: signing_token required'));
  if (_signingReadFlight[signingToken]) return _signingReadFlight[signingToken];
  const flight = gasCall('initiateSigningSession', { signing_token: signingToken, create_only: true })
    .finally(() => { delete _signingReadFlight[signingToken]; });
  _signingReadFlight[signingToken] = flight;
  return flight;
}

// ─── Documents (paquete de firma) eager cache (WPERF-1 criterio "eager docs") ───
// `getDocument` (proxy de bytes) es la llamada MÁS lenta del paquete contractual
// (~40s medidos). Espejo de prefetchLookups/prefetchQuestions: cuando un firmante
// entra (expediente AD + firma lista), calentamos la LISTA de docs (initiateSigningRead
// → members) y, best-effort, los BYTES de cada doc, para que al llegar a S-REVIEW las
// previews pinten sin esperar. Se cachea la PROMESA de bytes ({base64,mimeType,filename})
// por file_id; el caller (fetchDocumentObjectUrl) construye/revoca el object URL como
// siempre — sin fugas. Errores (típicamente STEPUP_REQUIRED si el step-up no está fresco
// todavía al montar) → la entrada se purga → cache-miss silencioso, idéntico al actual.
const _docBytesCache = {};   // { [file_id]: Promise<{base64,mimeType,filename}> }

export function getDocumentBytes({ file_id, resume_token, signing_token }) {
  if (!file_id) return Promise.reject(new Error('getDocumentBytes: file_id required'));
  if (_docBytesCache[file_id]) return _docBytesCache[file_id];
  const flight = gasCall('getDocument', { file_id, resume_token, signing_token })
    .catch(err => { delete _docBytesCache[file_id]; throw err; });   // NO cachear fallos
  _docBytesCache[file_id] = flight;
  return flight;
}

export function prefetchDocuments(signingToken) {
  if (!signingToken) return;
  initiateSigningRead(signingToken)
    .then(res => {
      const members = Array.isArray(res && res.members) ? res.members : [];
      members.forEach(m => {
        if (!m.file_id || _docBytesCache[m.file_id]) return;
        getDocumentBytes({ file_id: m.file_id, signing_token: signingToken }).catch(() => {});
      });
    })
    .catch(() => {});
}

// ─── Questions cache ──────────────────────────────────────────────────────────
// The question DEFINITION catalog (fetchQuestions → { sets: [...] }) is static for
// the lifetime of the page, mirror of the lookups cache — but KEYED BY LANGUAGE
// because questions are localized (fetchQuestions receives language: i18n.language).
// This caches ONLY the catalog of questions, NOT the user's RESPONSES (those live
// in WizardContext / stepData.questions and are unaffected). context_code is fixed
// to 'ENROLLMENT' exactly as the call-sites used inline.
// WIZARD-UX (Diego 2026-06-07): Step5 + Step7 used to fetch this independently on
// every mount → re-fetched on every back/forward. Now they share the cache.
const _questionsCache  = {};   // { [lang]: data }  (module memory — dies on reload)
const _questionsFlight = {};   // { [lang]: promise }

// WIZARD-PERF-CACHE-SKELETON (Diego 2026-06-07): capa stale-while-revalidate en
// sessionStorage para que el paso de Preguntas PINTE de inmediato tras un reload
// (la cache de módulo se pierde al recargar). El catálogo de preguntas es
// CONTENIDO PÚBLICO del tenant (NO PII de la familia) → se guarda en claro en
// sessionStorage (decisión documentada: cifrar sería seguridad de teatro porque la
// clave viviría en el bundle; las RESPUESTAS de la familia NUNCA se cachean aquí).
// Frescura atada al ciclo step-up: TTL = STEPUP_WINDOW_MS (10 min, espejado local
// para evitar import circular con WizardContext) + purga explícita en clearSession
// (WizardContext llama purgeQuestionsCache()). Defensivo: parseo/quota fallan →
// cache-miss silencioso, comportamiento idéntico al actual.
const QCACHE_PREFIX = 'kis_wizard_qcache_v2_'; // v2: invalida la caché vieja con códigos (pre QB-TRANS designation fix)
const QCACHE_TTL_MS = 10 * 60 * 1000; // espejo de STEPUP_WINDOW_MS (WizardContext)

/**
 * Lectura SÍNCRONA del catálogo cacheado en sessionStorage (paint instantáneo).
 * NO calienta la cache de módulo a propósito: así fetchQuestions revalida por red
 * tras un reload (SWR). Devuelve null si ausente/expirado/corrupto.
 * @param {string} lang
 * @returns {Object|null}
 */
export function readQuestionsCacheSync(lang) {
  const key = lang || 'es';
  if (_questionsCache[key]) return _questionsCache[key];
  try {
    const raw = sessionStorage.getItem(QCACHE_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.data || !parsed.expiresAt || Date.now() > parsed.expiresAt) {
      sessionStorage.removeItem(QCACHE_PREFIX + key);
      return null;
    }
    return parsed.data;
  } catch { return null; }
}

function _persistQuestions(key, data) {
  _questionsCache[key] = data;
  try {
    sessionStorage.setItem(QCACHE_PREFIX + key, JSON.stringify({ data, expiresAt: Date.now() + QCACHE_TTL_MS }));
  } catch { /* quota/serialization → cache de módulo basta */ }
}

/** Purga toda la cache de preguntas (módulo + sessionStorage). Llamado por clearSession. */
export function purgeQuestionsCache() {
  for (const k in _questionsCache) delete _questionsCache[k];
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k && k.indexOf(QCACHE_PREFIX) === 0) sessionStorage.removeItem(k);
    }
  } catch { /* ignore */ }
}

function _doFetchQuestions(lang) {
  return gasCall('fetchQuestions', { context_code: 'ENROLLMENT', language: lang });
}

export function prefetchQuestions(lang) {
  const key = lang || 'es';
  if (_questionsCache[key] || _questionsFlight[key]) return;
  _questionsFlight[key] = _doFetchQuestions(key)
    .then(data  => { _persistQuestions(key, data); delete _questionsFlight[key]; return data; })
    .catch(_err => { delete _questionsFlight[key]; });
}

export function fetchQuestions(lang) {
  const key = lang || 'es';
  if (_questionsCache[key])  return Promise.resolve(_questionsCache[key]);
  if (_questionsFlight[key]) return _questionsFlight[key];
  _questionsFlight[key] = _doFetchQuestions(key)
    .then(data  => { _persistQuestions(key, data); delete _questionsFlight[key]; return data; })
    .catch(err  => { delete _questionsFlight[key]; throw err; });
  return _questionsFlight[key];
}

import * as log from './logger';

const GAS_ENDPOINT = import.meta.env.VITE_GAS_ENDPOINT;

/**
 * Calls the GAS backend with the given action and payload.
 * @param {string} action
 * @param {Object} payload
 * @returns {Promise<Object>} Parsed response (ok: true guaranteed, or throws)
 */
export async function gasCall(action, payload = {}) {
  if (!GAS_ENDPOINT) {
    log.error('gasCall: VITE_GAS_ENDPOINT is not configured');
    throw new Error('VITE_GAS_ENDPOINT is not configured.');
  }

  // Sanitise payload for logging (omit base64 blobs)
  const logPayload = { ...payload };
  if (logPayload.base64) logPayload.base64 = `[base64 ~${Math.round((payload.base64?.length || 0) * 0.75 / 1024)}KB]`;

  log.info(`→ GAS ${action}`, logPayload);
  log.debug(`→ GAS ${action} (raw payload keys)`, { keys: Object.keys(payload), enrollment_group_id: payload.enrollment_group_id || payload.application_id || null });

  const body = JSON.stringify({ action, _hp: '', ...payload });
  const t0   = performance.now();

  let res;
  try {
    res = await fetch(GAS_ENDPOINT, {
      method:  'POST',
      headers: { 'Content-Type': 'text/plain' }, // avoid CORS preflight on GAS
      body,
    });
  } catch (fetchErr) {
    log.error(`gasCall ${action}: network/fetch error`, { message: fetchErr.message });
    throw fetchErr;
  }

  const elapsed = Math.round(performance.now() - t0);
  log.info(`← HTTP ${res.status} (${elapsed}ms) for ${action}`);

  if (!res.ok) {
    log.error(`gasCall ${action}: HTTP ${res.status}`, { status: res.status, statusText: res.statusText });
    throw new Error('Network error: ' + res.status);
  }

  let data;
  try {
    data = await res.json();
  } catch (jsonErr) {
    log.error(`gasCall ${action}: failed to parse JSON response`, { message: jsonErr.message });
    throw new Error('Invalid JSON response from server');
  }

  if (!data.ok) {
    log.error(`gasCall ${action}: server returned ok=false`, { error: data.error, full: data });
    // data.error may be a string (err.message) or a structured object {code, message}
    // (NOT_EDITABLE, KMS_NOT_CONFIGURED, FORBIDDEN, …). Normalize so Error.message is
    // human-readable instead of "[object Object]" (M1 readiness-2026-06-03).
    const msg = (data.error && typeof data.error === 'object')
      ? (data.error.message || data.error.code)
      : data.error;
    const err = new Error(msg || 'Unknown server error');
    // Preserve the structured error code (STEPUP_REQUIRED, NOT_EDITABLE,
    // TOO_MANY_ATTEMPTS, RATE_LIMITED, …) on the Error so callers can branch on
    // err.code without string-matching the human-readable message. The message
    // already collapses code→message for display; this keeps the machine code too.
    if (data.error && typeof data.error === 'object' && data.error.code) {
      err.code = data.error.code;
    }
    throw err;
  }

  log.success(`✓ ${action} OK`, data);
  log.debug(`← GAS ${action} (full response)`, data);
  return data;
}
