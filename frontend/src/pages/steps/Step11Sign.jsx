import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { gasCall, initiateSigningRead } from '../../api';
import { useWizard } from '../../context/WizardContext';
import { signingIdentity_, fetchClientIp } from './signingCommon';
import { stepLabelKey } from './catalog'; // #11: el nombre del paso sale del catálogo
import * as log from '../../logger';

/**
 * Step 11 — S-SIGN (estado de la firma electrónica Click & Sign + polling).
 *
 * AUTO-DISPATCH (decisión Diego 2026-06-12, literal): "Una vez que el usuario ha
 * aceptado la lectura de los documentos en el paso 10 y le da a avanzar, se debería
 * automáticamente proceder al envío de la firma a Click and Sign (de momento
 * inhabilitada). Sí debe estar el paso 11 informando al usuario de que se le ha
 * enviado el documento para su firma digital y que mire el email, pero no debería
 * ser el usuario el que tenga que pulsar 'firmar'."
 *
 * El DESPACHO del envelope ya NO es una acción de usuario: lo invoca la regla
 * declarativa server-side kis-rule-0018 (KMS, anclada a la completación del
 * milestone REVIEW_CONFIRMED del Step 10). Este paso es INFORMATIVO:
 *   - Sesión ya iniciada (INITIATED/IN_PROGRESS/...) → "te hemos enviado los
 *     documentos para tu firma digital — revisa tu correo".
 *   - Confirmación registrada pero envío aún no efectuado (DRAFT — caso capado
 *     por el kill-switch CLICKSIGN_DISPATCH_ENABLED, o en cola) → "tu confirmación
 *     está registrada; te llegará un email para firmar en breve".
 *   - COMPLETED → pantalla de éxito terminal.
 * El polling read-only (create_only, NUNCA despacha) refresca el estado para que
 * la transición DRAFT→INITIATED se refleje sola. CERO acciones de usuario que
 * despachen (el botón "Enviar a firma" + su gate de step-up fueron eliminados).
 */
// ¿El `state` devuelto por el backend indica que la sesión YA fue iniciada (envelope
// despachado)? Todo lo que no sea DRAFT/null/NOT_INITIATED cuenta como iniciada —
// INITIATED, IN_PROGRESS, COMPLETED, etc. Módulo-scope: pura, usable en el seed de useState.
function isInitiatedState(state) {
  if (!state) return false;
  const s = String(state).toUpperCase();
  return s !== 'DRAFT' && s !== 'NOT_INITIATED';
}

export default function Step11Sign({ onBack, signingToken, resumeToken, signerCtx: signerCtxProp, onDone }) {
  const { t } = useTranslation();
  // WIZARD-UX TASK-1 (Diego 2026-06-13): el memo EN MEMORIA del estado de la sesión de
  // firma (signingSession) hace IDEMPOTENTE la re-entrada al Step 11. Al volver atrás y
  // re-avanzar, sembramos el estado desde memoria al instante (sin spinner "Guardando…",
  // que parecía "reenviando documentos") y solo refrescamos en background. El despacho
  // del envelope es y sigue siendo SERVER-SIDE (kis-rule-0018) — aquí nunca se envía nada.
  const { recoveredEmail, recoveryNonce, signingSession, setSigningSession } = useWizard();
  const signerCtx = signerCtxProp || {};
  const finish = onDone || (() => { /* terminal — permanece en la pantalla de éxito */ });
  // Back-only nav (top + bottom). El "avance" de este paso es el acto de firma
  // que ocurre FUERA (email Click & Sign); la nav solo lleva "Atrás" → Review.
  const backNav = (position) => {
    if (!onBack) return null;
    return (
      <div className={position === 'top' ? 'd-flex justify-content-between mb-3' : 'd-flex justify-content-between mt-3'}>
        <button className="btn-secondary-kis" onClick={onBack}>
          <i className="bi bi-arrow-left me-1" />{t('nav.back')}
        </button>
        <span />
      </div>
    );
  };
  // WIZARD-UX TASK-1: siembra desde el memo del contexto → re-entrada pinta el ESTADO
  // al instante (sin re-leer). null solo en la PRIMERA entrada de la sesión de navegación.
  const [session, setSession] = useState(signingSession || null); // { signerUrls, state }
  const [err, setErr] = useState('');
  // `initiated`: la sesión ya tiene el envelope despachado (server-side). Sembrada
  // desde signerCtx (ya firmado) o desde el memo del contexto, y refinada por la lectura
  // read-only. Una vez true, NO se vuelve a poner false.
  const [initiated, setInitiated] = useState(
    !!(signerCtx?.steps && signerCtx.steps.signed)
    || isInitiatedState(signingSession && signingSession.state)
    || ((signingSession && signingSession.signerUrls) || []).length > 0
  );
  const pollRef = useRef(null);
  const ipRef = useRef(undefined); // cache de la IP forense (best-effort) — solo para el dispatch preservado

  // Lectura READ-ONLY del estado de la sesión: create_only:true crea/garantiza la
  // sesión DRAFT + tokens y devuelve members/state SIN despachar el envelope.
  // Usado en mount y en el polling — NUNCA despacha (el despacho es server-side,
  // regla kis-rule-0018).
  const readState = async (initial) => {
    try {
      // Data-layer pieza 5: lectura de estado vía single-flight (de-dupe la tormenta
      // de create_only concurrentes). IDENTITY-COMPLETION (#30): identidad de SESIÓN.
      const res = await initiateSigningRead({ resumeToken, signingToken });
      log.info('[DBG sign] readState', { initial, state: res && res.state, n_urls: ((res && res.signerUrls) || []).length });
      setSession(res);
      // WIZARD-UX TASK-1: persiste el estado en el memo del contexto (monótono: no
      // des-despacha) → la próxima re-entrada al Step 11 pinta al instante sin re-leer.
      setSigningSession(res);
      const urls = (res && res.signerUrls) || [];
      if (isInitiatedState(res && res.state) || urls.length > 0) setInitiated(true);
      if (res && res.state === 'COMPLETED' && pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return res;
    } catch (e) {
      if (initial) setErr(e.message || t('signing.generic_error'));
      return undefined;
    }
  };

  const startPolling = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => readState(false), 5000);
  };

  // DISPATCH PRESERVADO, NO CABLEADO (AUTO-DISPATCH 2026-06-12): el envío real del
  // envelope lo invoca la regla declarativa kis-rule-0018 server-side al completarse
  // REVIEW_CONFIRMED (Step 10). Se conserva el código portado del acto por si Diego
  // decide reintroducir un disparo manual — NINGÚN elemento de UI lo invoca.
  // (El awaitPendingSave del acto ya no aplica: el server despacha tras el milestone.)
  // eslint-disable-next-line no-unused-vars
  const dispatchSigning = async () => {
    setErr('');
    log.warn('[DBG sign] dispatchSigning — DESPACHO DEL ENVELOPE (no cableado a UI; server-side kis-rule-0018)');
    // IP forense best-effort: evidencia, nunca gate. KAL-7: nunca va en la URL.
    if (ipRef.current === undefined) {
      ipRef.current = await fetchClientIp();
    }
    try {
      // IDENTITY-COMPLETION (#29): identidad de SESIÓN (resume_token preferente).
      const res = await gasCall('initiateSigningSession', {
        ...signingIdentity_({ resumeToken, signingToken, n: recoveryNonce, recoveredEmail }),
        client_ip:     ipRef.current || undefined,
      });
      setSession(res);
      setInitiated(true);
      if (!(res && res.state === 'COMPLETED')) startPolling();
    } catch (e) {
      setErr(e.message || t('signing.generic_error'));
    }
  };

  useEffect(() => {
    // WIZARD-UX TASK-1: si ya teníamos el estado en el memo del contexto (re-entrada al
    // Step 11 tras navegar atrás), NO mostramos error de carga inicial — el refresco es
    // de FONDO (initial=false). Solo la PRIMERA entrada de la sesión (sin memo) muestra
    // el spinner de carga. En ambos casos refrescamos el estado read-only y, si no está
    // COMPLETED, arrancamos el polling para reflejar la transición DRAFT→INITIATED que
    // dispara la regla server-side (kis-rule-0018). NUNCA despacha nada desde aquí.
    const hadSeed = !!signingSession;
    if (signingSession && signingSession.state === 'COMPLETED') {
      // Ya completada en memoria → no re-leer ni pollear.
      return undefined;
    }
    readState(!hadSeed).then((res) => {
      const finalState = (res && res.state) || (signingSession && signingSession.state);
      if (finalState !== 'COMPLETED') startPolling();
    });
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [signingToken, resumeToken]); // eslint-disable-line

  if (err) {
    return (
      <div className="kis-card">
        {backNav('top')}
        <h2 style={{ color: 'var(--teal-dk)', fontWeight: 800, fontSize: '1.2rem' }}>{t(stepLabelKey('s_sign'))}</h2>
        <div className="field-error mt-2 p-2 rounded" style={{ background: '#ffeaea' }}>{err}</div>
        {backNav('bottom')}
      </div>
    );
  }

  const state = session && session.state;
  const completed = state === 'COMPLETED' || (signerCtx.steps && signerCtx.steps.signed);

  if (completed) {
    return (
      <div className="kis-card" style={{ textAlign: 'center', padding: '32px 20px' }}>
        <i className="bi bi-check-circle-fill" style={{ fontSize: '2.8rem', color: '#2e7d32' }} />
        <h3 style={{ color: '#1b5e20', marginTop: 16 }}>{t('signing.signing.completed_title')}</h3>
        <p style={{ color: '#2e4a2f', maxWidth: 440, margin: '8px auto 16px' }}>{t('signing.signing.completed_body')}</p>
        <button className="btn-primary-kis" onClick={finish}>{t('signing.signing.finish')}</button>
      </div>
    );
  }

  // Cargando el primer estado. WIZARD-UX TASK-1: copy NEUTRO de "consultando estado",
  // NUNCA "Guardando…/Enviando…" (que sugería un reenvío a firma). Solo se ve en la
  // PRIMERA entrada de la sesión (sin memo); las re-entradas saltan este bloque.
  if (session === null) {
    return (
      <div className="kis-card">
        {backNav('top')}
        <h2 style={{ color: 'var(--teal-dk)', fontWeight: 800, fontSize: '1.2rem' }}>{t(stepLabelKey('s_sign'))}</h2>
        <div style={{ textAlign: 'center', padding: 24, color: 'var(--muted)' }}>
          <span className="spinner-border spinner-border-sm me-2" />{t('signing.signing.checking_status')}
        </div>
        {backNav('bottom')}
      </div>
    );
  }

  // Informativo según datos reales (sin acción de usuario que despache):
  //  - initiated → el envelope salió: "revisa tu correo (email del guardian)".
  //  - no initiated (DRAFT — capado/en cola) → "confirmación registrada; te llegará
  //    un email en breve" (VERDAD bajo el kill-switch).
  const sentBody = recoveredEmail
    ? t('signing.signing.auto_sent_named', { email: recoveredEmail })
    : t('signing.signing.auto_sent');

  return (
    <div className="kis-card">
      {backNav('top')}
      <h2 style={{ color: 'var(--teal-dk)', fontWeight: 800, fontSize: '1.2rem' }}>{t(stepLabelKey('s_sign'))}</h2>

      <div style={{ textAlign: 'center', padding: '20px 8px' }}>
        <i className={initiated ? 'bi bi-envelope-check' : 'bi bi-envelope-arrow-up'}
           style={{ fontSize: '2.4rem', color: 'var(--teal-dk)' }} />
        <p style={{ color: 'var(--text, #2a2a2a)', maxWidth: 480, margin: '14px auto 4px', fontWeight: 600 }}>
          {initiated ? sentBody : t('signing.signing.auto_queued')}
        </p>
      </div>

      <p style={{ textAlign: 'center', fontSize: '0.78rem', color: 'var(--muted)', marginTop: 12 }}>
        <span className="spinner-border spinner-border-sm me-2" style={{ width: 12, height: 12 }} />
        {t('signing.signing.polling')}
      </p>
      {backNav('bottom')}
    </div>
  );
}
