/**
 * DEV LOGGER — lightweight pub/sub log store.
 * Import log functions anywhere in the app.
 * Mirrors to browser console AND the floating DevLogger panel.
 */

const MAX_ENTRIES = 500;
const listeners   = new Set();
export const entries = [];

function push(level, message, data) {
  const entry = {
    id:  Date.now() + Math.random(),
    ts:  new Date().toISOString().slice(11, 23), // HH:MM:SS.mmm
    level,
    message,
    data: data !== undefined
      ? (() => { try { return JSON.stringify(data, null, 2); } catch { return String(data); } })()
      : undefined,
  };
  entries.push(entry);
  if (entries.length > MAX_ENTRIES) entries.shift();
  listeners.forEach(fn => fn([...entries]));
  // Mirror to browser console
  const con = level === 'error' ? console.error
    : level === 'warn'  ? console.warn
    : level === 'debug' ? console.debug
    : console.log;
  con(`[ENR ${level.toUpperCase()}] ${message}`, data !== undefined ? data : '');
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
