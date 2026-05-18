/**
 * Client-side UUID v4 generation.
 *
 * Used by Step2Persons to assign person_id at creation time, so the wizard
 * doesn't depend on a backend roundtrip to learn the real id. Eliminates
 * the optimistic-UI race that could leave Step3 relations pointing at
 * temporary _uid placeholders that get replaced asynchronously by the
 * backend's personIdMap stamping (see WizardPage.handleNext + commit
 * 3c91d7a notes on the race-condition).
 *
 * Uses crypto.randomUUID() — supported in all modern browsers
 * (Chrome 92+, Safari 15.4+, Firefox 95+). Falls back to a Math.random
 * version for environments where crypto is unavailable (extremely rare;
 * defensive).
 *
 * @returns {string} UUID v4 string, e.g. "9f8a3b2c-4d5e-4f6a-b7c8-d9e0a1b2c3d4"
 */
export function generateUuid() {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
    return crypto.randomUUID();
  }
  // Fallback: RFC 4122 v4 via Math.random (low entropy, do not use for security).
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
    const r = (Math.random() * 16) | 0;
    const v = c === 'x' ? r : (r & 0x3) | 0x8;
    return v.toString(16);
  });
}
