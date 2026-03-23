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
    throw new Error(data.error || 'Unknown server error');
  }

  log.success(`✓ ${action} OK`, data);
  return data;
}
