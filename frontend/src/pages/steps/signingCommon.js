// ─────────────────────────────────────────────────────────────────────────────
// REBUILD-8-11 (Diego 2026-06-11) — helpers COMUNES de los pasos de firma 8-11.
//
// Código-de-oro portado VERBATIM de pages/signing/* (monolito del antiguo host /sign) (eliminado en
// este mismo cambio — los pasos 8-11 son ahora ciudadanos idénticos a los 1-7 en
// pages/steps/Step8Billing..Step11Sign). Aquí viven SOLO los contratos probados
// de identidad/step-up/IP forense — cero UI.
// ─────────────────────────────────────────────────────────────────────────────

import * as log from '../../logger';

/**
 * DL-E39 — IP forense client-side (best-effort) antes del ACTO de firma.
 * La IP es EVIDENCIA, nunca un gate: si el eco IP externo falla, continuamos sin
 * ella. NO se mete nada en la URL (KAL-7). Se pasa como client_ip en el payload
 * de initiateSigningSession.
 */
export async function fetchClientIp() {
  try {
    const res = await fetch('https://api.ipify.org?format=json');
    if (!res.ok) return null;
    const data = await res.json();
    return data && data.ip ? data.ip : null;
  } catch (e) {
    // Best-effort: la IP es evidencia, no gate. Continuamos sin ella.
    log.warn('Step11Sign: fetchClientIp failed (best-effort, continuando sin IP)', { message: e.message });
    return null;
  }
}

export const isStepUpRequiredError = (e) =>
  e?.code === 'STEPUP_REQUIRED' || /STEPUP_REQUIRED/.test(e?.message || '');

/**
 * IDENTITY-FROM-LINK (Diego 2026-06-11) — identidad canónica del ACTO de firma. El backend
 * (requireSignerContext_) acepta DOS formas y prefiere (a): { resume_token } → grupo
 * (KAL-4) + guardian resuelto SERVER-SIDE del PROPIO ENLACE: `n` (email_id del enlace) →
 * email → guardian, validado contra el grupo del token. El { signing_token } es back-compat.
 *
 * Construimos el sub-objeto de identidad a fusionar en el payload de cada acto:
 *   - resume_token de SESIÓN (sobrevive a F5/incógnito; el firmante lo resuelve el servidor).
 *   - `n` (email_id del enlace) cuando lo tenemos → es la VÍA CANÓNICA de identidad: la
 *     identidad viaja en el enlace, no en el cliente (Diego: "resolver la identidad sabiendo
 *     el email con el que se solicita el link"). El backend lo valida contra BD (KAL-4/5).
 *   - recovered_email como COMPAT secundario (sessionStorage), si está.
 *   - si no hay resume_token, caemos al signing_token legacy.
 * NUNCA mandamos un guardian/grupo del cliente — el backend deriva la identidad del token+n.
 */
export function signingIdentity_({ resumeToken, signingToken, n, recoveredEmail }) {
  if (resumeToken) {
    const out = { resume_token: resumeToken };
    if (n) out.n = n;                                  // identidad del enlace (email_id)
    if (recoveredEmail) out.recovered_email = recoveredEmail; // compat secundario
    return out;
  }
  if (signingToken) return { signing_token: signingToken };
  return {};
}

export function lang_(i18n) { return i18n.language && i18n.language.indexOf('en') === 0 ? 'en' : 'es'; }
