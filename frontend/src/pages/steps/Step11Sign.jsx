import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { gasCall, initiateSigningRead } from '../../api';
import { useWizard } from '../../context/WizardContext';
import StepUpReverify from '../../components/StepUpReverify';
import { signingIdentity_, isStepUpRequiredError, fetchClientIp } from './signingCommon';
import * as log from '../../logger';

/**
 * Step 11 — S-SIGN (firma electrónica Click & Sign + polling).
 *
 * REBUILD-8-11 (Diego 2026-06-11): paso TERMINAL del wizard, reconstruido como
 * ciudadano de pages/steps. La lógica de DISPATCH del envelope Click & Sign está
 * PORTADA VERBATIM del SignSign probado (antiguo pages/signing/* (monolito del antiguo host /sign),
 * eliminado en este cambio) — incluido el STOP-GAP anti-re-dispatch, el gate
 * incondicional de step-up (DL-E39), la IP forense best-effort y el ÚNICO
 * `awaitPendingSave()` legítimo del wizard (drenar la cola ANTES del acto legal,
 * que depende del milestone de revisión confirmada server-side).
 *
 * Su "avance" es el ACTO terminal de firma (frontera Click & Sign), no un
 * "Continuar" de paso — por eso conserva la back-nav propia (catálogo
 * savePolicy:'none' / lockPolicy:'never').
 */
export default function Step11Sign({ onBack, signingToken, resumeToken, signerCtx: signerCtxProp, onDone }) {
  const { t } = useTranslation();
  const { isStepUpFresh, markStepUpFresh, awaitPendingSave, recoveredEmail, recoveryNonce } = useWizard();
  const signerCtx = signerCtxProp || {};
  const finish = onDone || (() => { /* terminal — permanece en la pantalla de éxito */ });
  // Back-only nav (top + bottom). The Sign step's "advance" is the signing act
  // itself (launched from the per-signer buttons / polled to completion), so the
  // nav only carries "Atrás" → Review. Hidden once the session is COMPLETED (the
  // terminal success screen has its own Finish button). Mirrors StepNav spacing.
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
  const [session, setSession] = useState(null); // { signerUrls, state }
  const [err, setErr] = useState('');
  // STOP-GAP VERBATIM (fix real = P-SIGN-ENGINE, KMS): el bug user-blocking + legal es
  // que RE-ENTRAR a Step 11 re-despachaba el envelope de Click&Sign (email legalmente
  // vinculante) en CADA mount, porque el backend no avanza fiable la sesión a
  // INITIATED y el check de idempotencia sigue viendo DRAFT. Mientras eso se
  // arregla server-side, el FRONTEND nunca dispara un re-dispatch al re-entrar:
  //   - On mount: lectura READ-ONLY del estado (create_only:true → NO despacha,
  //     NO exige step-up). Detecta si la sesión ya está iniciada.
  //   - Si ya iniciada → render de los enlaces / "firma en curso" + polling
  //     read-only (create_only), SIN despachar nunca.
  //   - El despacho REAL (non-create_only, que dispara el envelope) ocurre SOLO
  //     en acción EXPLÍCITA del usuario (botón "Enviar a firma") y SOLO desde
  //     estado no-iniciado (DRAFT). Tras dispararlo una vez → render "ya iniciada".
  // El gate de step-up + auth por token se mantienen intactos.

  // `initiated`: la sesión ya tiene el envelope despachado (no hace falta — ni se
  // debe — re-disparar). Sembrada desde signerCtx (ya firmado) y refinada por la
  // lectura read-only de mount. Una vez true, NO se vuelve a poner false.
  const [initiated, setInitiated] = useState(!!(signerCtx?.steps && signerCtx.steps.signed));
  // DL-E39: gate INCONDICIONAL de firma — SIEMPRE exigimos step-up fresco antes
  // de DESPACHAR el acto de firma, independiente de la inactividad. Solo aplica al
  // dispatch real (botón explícito), nunca a la lectura read-only del estado.
  const [needStepUp, setNeedStepUp] = useState(!isStepUpFresh());
  const pollRef = useRef(null);
  const ipRef = useRef(undefined); // cache de la IP forense (best-effort)

  // ¿El `state` devuelto por el backend indica que la sesión YA fue iniciada
  // (envelope despachado)? Todo lo que no sea DRAFT/null/NOT_INITIATED cuenta como
  // iniciada — INITIATED, IN_PROGRESS, COMPLETED, etc.
  const isInitiatedState = (state) => {
    if (!state) return false;
    const s = String(state).toUpperCase();
    return s !== 'DRAFT' && s !== 'NOT_INITIATED';
  };

  // Lectura READ-ONLY del estado de la sesión: create_only:true crea/garantiza la
  // sesión DRAFT + tokens y devuelve members/state/signerUrls SIN despachar el
  // envelope y SIN exigir step-up. Usado en mount y en el polling — NUNCA re-despacha.
  const readState = async (initial) => {
    try {
      // Data-layer pieza 5: lectura de estado vía single-flight (de-dupe la tormenta
      // de create_only concurrentes). NUNCA despacha el envelope (STOP-GAP intacto).
      // IDENTITY-COMPLETION (#30): identidad de SESIÓN (resume_token preferente).
      const res = await initiateSigningRead({ resumeToken, signingToken });
      log.info('[DBG sign] readState', { initial, state: res && res.state, n_urls: ((res && res.signerUrls) || []).length });
      setSession(res);
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

  // DESPACHO REAL del envelope — SOLO desde acción explícita del usuario y SOLO
  // cuando la sesión NO está iniciada. Es el acto legal: exige step-up fresco
  // (gate incondicional DL-E39) + await del save de REVIEW (confirmReview) en
  // vuelo, ya que el acto depende del milestone de revisión confirmada server-side.
  const dispatchSigning = async () => {
    setErr('');
    log.warn('[DBG sign] dispatchSigning — DESPACHO DEL ENVELOPE (acto de firma)');
    // ÚNICO await legítimo del wizard: drenar la cola (billing/gdpr/review en vuelo)
    // ANTES de despachar el acto legal.
    try {
      await awaitPendingSave();
    } catch (e) {
      log.warn('Step11Sign: previous review save failed', { message: e.message });
      setErr(e?.message || t('signing.generic_error'));
      return;
    }
    // IP forense best-effort: evidencia, nunca gate. KAL-7: nunca va en la URL.
    if (ipRef.current === undefined) {
      ipRef.current = await fetchClientIp();
    }
    try {
      // IDENTITY-COMPLETION (#29): el acto legal reenvía la identidad de SESIÓN
      // (resume_token preferente; el firmante lo resuelve el backend server-side vía
      // requireSignerContext_ + binding token→tutor). El signing_token queda como
      // compat. La mecánica Click & Sign (envelope, single-use/TTL/binding del ACTO,
      // P222) es server-side e intacta — solo cambia DE DÓNDE sale la identidad.
      const res = await gasCall('initiateSigningSession', {
        ...signingIdentity_({ resumeToken, signingToken, n: recoveryNonce, recoveredEmail }),
        client_ip:     ipRef.current || undefined,
      });
      setSession(res);
      setInitiated(true); // tras despachar una vez → no volver a despachar nunca
      if (!(res && res.state === 'COMPLETED')) startPolling();
    } catch (e) {
      // Gate incondicional reforzado por el backend: re-pedimos step-up.
      if (isStepUpRequiredError(e)) {
        log.warn('Step11Sign: initiateSigningSession requires step-up');
        setNeedStepUp(true);
        return;
      }
      setErr(e.message || t('signing.generic_error'));
    }
  };

  // Click del botón "Enviar a firma": si no hay step-up fresco, lo pedimos primero;
  // tras verificar, despachamos. Si ya está fresco, despachamos directamente.
  const onSendClick = () => {
    if (needStepUp) return; // el render muestra StepUpReverify; onVerified → dispatchSigning
    dispatchSigning();
  };

  useEffect(() => {
    // STOP-GAP: en mount SOLO leemos el estado (read-only, no despacha). El
    // despacho real lo dispara el usuario explícitamente. Esto garantiza que
    // re-montar / re-entrar a Step 11 NUNCA re-despacha el envelope.
    readState(true).then((res) => {
      // Si la sesión ya estaba iniciada, arrancamos el polling para reflejar el
      // progreso de firma — sin despachar.
      const urls = (res && res.signerUrls) || [];
      if (isInitiatedState(res && res.state) || urls.length > 0 || (signerCtx?.steps && signerCtx.steps.signed)) {
        startPolling();
      }
    });
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [signingToken, resumeToken]); // eslint-disable-line

  // Gate incondicional de step-up: SOLO se muestra cuando el usuario va a DESPACHAR
  // desde estado no-iniciado (no para la lectura read-only). Si la sesión ya está
  // iniciada, no exigimos step-up para ver los enlaces.
  if (needStepUp && !initiated) {
    return (
      <div className="kis-card">
        {backNav('top')}
        <h2 style={{ color: 'var(--teal-dk)', fontWeight: 800, fontSize: '1.2rem' }}>{t('signing.signing.title')}</h2>
        <p style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>{t('stepup.sign_gate_body')}</p>
        <StepUpReverify
          /* IDENTITY-COMPLETION (#29): identidad de SESIÓN (resume_token preferente). */
          tokenPayload={signingIdentity_({ resumeToken, signingToken, n: recoveryNonce, recoveredEmail })}
          prompt={t('stepup.sign_prompt')}
          onVerified={() => { markStepUpFresh(); setNeedStepUp(false); dispatchSigning(); }}
        />
        {backNav('bottom')}
      </div>
    );
  }

  if (err) {
    return (
      <div className="kis-card">
        {backNav('top')}
        <h2 style={{ color: 'var(--teal-dk)', fontWeight: 800, fontSize: '1.2rem' }}>{t('signing.signing.title')}</h2>
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

  const signerUrls = (session && session.signerUrls) || [];

  // STOP-GAP render: si la sesión NO está iniciada (DRAFT), NO despachamos en
  // background — mostramos intro + botón explícito "Enviar a firma". El usuario
  // dispara el envelope una sola vez, conscientemente. Re-entrar aquí con la
  // sesión ya iniciada cae en la rama `initiated` (enlaces + polling), nunca
  // re-despacha.
  if (!initiated) {
    return (
      <div className="kis-card">
        {backNav('top')}
        <h2 style={{ color: 'var(--teal-dk)', fontWeight: 800, fontSize: '1.2rem' }}>{t('signing.signing.title')}</h2>
        <p style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>{t('signing.signing.intro')}</p>
        {session === null && (
          <div style={{ textAlign: 'center', padding: 24, color: 'var(--muted)' }}>
            <span className="spinner-border spinner-border-sm me-2" />{t('signing.saving')}
          </div>
        )}
        <div className="d-flex justify-content-center mt-3">
          <button className="btn-primary-kis" disabled={session === null} onClick={onSendClick}>
            {t('signing.signing.start')}
          </button>
        </div>
        {backNav('bottom')}
      </div>
    );
  }

  return (
    <div className="kis-card">
      {backNav('top')}
      <h2 style={{ color: 'var(--teal-dk)', fontWeight: 800, fontSize: '1.2rem' }}>{t('signing.signing.title')}</h2>
      <p style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>{t('signing.signing.in_progress')}</p>

      {signerUrls.length > 0 ? (
        signerUrls.map((s, i) => {
          const url  = s.signing_url || s.url || s.signingUrl;
          const name = s.name || s.signer_name || t('signing.signing.sign_as_generic');
          return (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid var(--bg)' }}>
              <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>{name}</span>
              <button className="btn-primary-kis btn-sm" disabled={!url}
                onClick={() => url && window.open(url, '_blank', 'noopener')}>
                {t('signing.signing.sign_as', { name })}
              </button>
            </div>
          );
        })
      ) : (
        <p style={{ color: 'var(--muted)', fontSize: '0.88rem', textAlign: 'center', padding: 16 }}>
          {t('signing.signing.waiting')}
        </p>
      )}

      <p style={{ textAlign: 'center', fontSize: '0.78rem', color: 'var(--muted)', marginTop: 16 }}>
        <span className="spinner-border spinner-border-sm me-2" style={{ width: 12, height: 12 }} />
        {t('signing.signing.polling')}
      </p>
      {backNav('bottom')}
    </div>
  );
}
