/**
 * GAS API client.
 * Every call includes _hp (honeypot — empty, untouched by real users).
 */

const GAS_ENDPOINT = import.meta.env.VITE_GAS_ENDPOINT;

/**
 * Calls the GAS backend with the given action and payload.
 * @param {string} action
 * @param {Object} payload
 * @returns {Promise<Object>} Parsed response (ok: true guaranteed, or throws)
 */
export async function gasCall(action, payload = {}) {
  if (!GAS_ENDPOINT) throw new Error('VITE_GAS_ENDPOINT is not configured.');

  const body = JSON.stringify({ action, _hp: '', ...payload });

  const res = await fetch(GAS_ENDPOINT, {
    method:  'POST',
    headers: { 'Content-Type': 'text/plain' }, // avoid CORS preflight on GAS
    body,
  });

  if (!res.ok) throw new Error('Network error: ' + res.status);

  const data = await res.json();
  if (!data.ok) throw new Error(data.error || 'Unknown server error');

  return data;
}
