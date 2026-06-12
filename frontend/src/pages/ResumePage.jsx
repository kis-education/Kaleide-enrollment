import { useEffect, useState } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { gasCall } from '../api';
import { useWizard } from '../context/WizardContext';
import * as log from '../logger';

/**
 * /resume/:token — magic-link landing.
 *
 * KAL-7 (security audit 2026-05-29): the resume_token used to remain visible
 * in the URL bar (browser history, screen shares, screenshots, Referer
 * header), which is a leak of a long-lived bearer secret. We now:
 *   1. Read the token from useParams() once.
 *   2. Strip it from the URL immediately via window.history.replaceState
 *      (path becomes `/#/apply` — no token).
 *   3. Pass the token to the resumeSession call from the closure (the
 *      WizardContext.hydrateFromResume stores it in sessionStorage for
 *      subsequent API calls).
 * Combined with the <meta name="referrer" content="no-referrer"> in
 * frontend/index.html (also KAL-7), this closes both the visual leak and
 * the Referer leak.
 *
 * KAL-11: previously logged the full resume_token via log.info — now logs
 * only the first 8 chars + '...' so the token is not reconstructable from
 * the dev console log stream.
 */
// E (carga por etapas): el hydrate tarda ~30s; en vez de un texto único, el mensaje
// rota por estas etapas (i18n) para dar sensación de avance. Topado al último índice
// (no da la vuelta). El intervalo se limpia en cleanup y al resolver/rechazar la promesa.
const RESUME_STAGE_KEYS = ['resume.stage.verifying', 'resume.stage.recovering', 'resume.stage.almost'];

export default function ResumePage() {
  const { token } = useParams();
  const [searchParams] = useSearchParams();
  const navigate  = useNavigate();
  const { t, i18n } = useTranslation();
  const { hydrateFromResume, recoveredEmail, setRecoveryNonce } = useWizard();
  const [stage, setStage] = useState(0);

  // IDENTITY-FROM-LINK (2026-06-11): `?n=<email_id>` del magic link lleva la IDENTIDAD del
  // guardian (email_id, opaco, sin PII). Se captura aquí (en el hash, antes del scrub KAL-7
  // que reemplaza el hash por #/apply y lo elimina de la barra) y se PERSISTE en
  // sessionStorage (setRecoveryNonce) para sobrevivir a F5/incógnito y alimentar la
  // identidad en hydrate + actos de firma. El backend lo valida contra el grupo del
  // resume_token (KAL-4/5). NO es un bearer (no autoriza por sí solo). KAL-7: no se loguea
  // entero. La gracia OTP-skip YA NO viaja en `n` (se ancla al resume_token server-side).
  const linkN = searchParams.get('n') || null;

  useEffect(() => {
    if (!token) {
      log.warn('ResumePage: no token in URL, redirecting to /');
      navigate('/');
      return;
    }

    // KAL-7: scrub the token from the URL bar / history BEFORE any await.
    // HashRouter means the path lives in location.hash. Replace the hash with
    // '#/apply' so the address bar drops the resume token. The token is held
    // in the closure for the gasCall below and persisted in sessionStorage
    // by hydrateFromResume for follow-up API calls.
    try {
      const cleanUrl = window.location.pathname + window.location.search + '#/apply';
      window.history.replaceState(null, '', cleanUrl);
    } catch (e) {
      // replaceState can throw in very old browsers / sandboxed iframes — non-fatal.
      log.warn('ResumePage: history.replaceState failed (non-fatal)', { message: e.message });
    }

    // E: rota el mensaje de carga cada 7s, topado al último índice (no da la vuelta).
    const stageTimer = setInterval(() => {
      setStage(s => Math.min(s + 1, RESUME_STAGE_KEYS.length - 1));
    }, 7000);

    // IDENTITY-FROM-LINK: persiste el `n` (email_id) en sessionStorage → la identidad del
    // enlace sobrevive a F5/incógnito y se reenvía en getAdmissionState + actos de firma.
    if (linkN) setRecoveryNonce(linkN);

    const tokenPreview = String(token).slice(0, 8) + '...';
    log.info('ResumePage: calling hydrateSession', { resume_token_preview: tokenPreview });
    // DL-B §1 — hidratación CONSOLIDADA (hydrateSession): UNA llamada trae datos 11
    // pasos + lookups + qbResponses + admission + signing_context + billing_splits +
    // live_version. IDENTITY-FROM-LINK: `n` (email_id del enlace) resuelve la identidad
    // del guardian server-side (KAL-4); la gracia OTP-skip se ancla al resume_token. El
    // recovered_email persistido queda como compat secundario.
    gasCall('hydrateSession', { resume_token: token, recovered_email: recoveredEmail || undefined, n: linkN || undefined, language: i18n.language })
      .then(data => {
        // Post-DL-E15 shape uses `group`; legacy responses still use `application`.
        const grp = data.group || data.application;
        log.success('ResumePage: resumeSession succeeded', {
          enrollment_group_id: grp?.enrollment_group_id || grp?.application_id,
          submitted_at:        grp?.submitted_at,
        });
        hydrateFromResume(data);
        // SPEC-WIZ-WARMUP-V2.1 (2026-06-12): kick fire-and-forget del precalentado
        // TAMBIEN al entrar — cubre las entradas sin kick de envio (email de la
        // Carta, link antiguo, click mas rapido que el minuto muerto): mientras la
        // familia recorre los pasos, el backend cocina docs/members/hydrate para
        // el paso 10. Gate KAL-4 + rate-limit (120s/grupo) server-side; best-effort.
        // Retraso de 4s: con todo ya caliente el kick es casi no-op server-side, pero
        // su respuesta ocupaba una conexión del navegador compitiendo con las cargas
        // inmediatas del usuario (log Diego 18:07: getDocument server 1,2s pero 13,7s
        // percibidos por contención del transporte). Primero el usuario, luego el warm.
        setTimeout(() => { gasCall('warmBundle', { resume_token: token, n: linkN || undefined }).catch(() => {}); }, 4000);
        log.info('ResumePage: hydration complete, navigating to /apply');
        clearInterval(stageTimer);
        navigate('/apply', { replace: true });
      })
      .catch(err => {
        log.error('ResumePage: resumeSession failed', { message: err.message });
        clearInterval(stageTimer);
        navigate('/?resume_error=1', { replace: true });
      });

    return () => clearInterval(stageTimer);
  }, [token]); // eslint-disable-line

  return (
    <div style={{ textAlign: 'center', paddingTop: 80 }}>
      <div className="spinner" />
      <p style={{ color: 'var(--muted)' }} aria-live="polite">{t(RESUME_STAGE_KEYS[stage])}</p>
    </div>
  );
}
