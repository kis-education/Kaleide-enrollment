import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { gasCall } from '../api';
import * as log from '../logger';
import LangToggle from './LangToggle';

const LOGO = 'https://raw.githubusercontent.com/kaleideschool/public/main/favicon.png';

/**
 * StepUpGate — DL-E39 ENMIENDA (gate de ENTRADA, Diego 2026-06-06).
 *
 * Modelo DEFINITIVO (supersede el step-up per-campo): para ACCEDER al wizard de
 * una solicitud RECUPERADA por magic-link hacen falta DOS cosas: el magic link
 * (resume_token, ya consumido al llegar aquí) Y un OTP corto (código de 6 díg.
 * enviado al buzón del expediente). Hasta superar el gate NO se muestra NINGÚN
 * paso ni dato. Tras introducir el OTP correcto → entra al wizard completo, con
 * los datos visibles con normalidad (sin enmascarado per-campo).
 *
 * Esta pantalla:
 *   1. Al montar, envía un código fresco SOLO si shouldAutoSend=true (la PRIMERA
 *      recuperación de la sesión, req. b). En reload/re-expiración (shouldAutoSend
 *      =false) NO auto-envía — muestra el botón "enviar código" para que el usuario
 *      lo pida (req. c, Diego 2026-06-07). El backend deriva email+group del bearer
 *      token SERVER-SIDE (KAL-4) — NUNCA mandamos el email del payload.
 *   2. Input de 6 dígitos + "Verificar" (verifyEmail, {stepup:true}). En éxito
 *      invoca onVerified() → el padre marca step-up fresco (10 min) y renderiza
 *      el wizard.
 *
 * KAL-7 / KAL-11: nunca metemos el código/token en la URL ni logueamos el código
 * completo.
 *
 * @param {Object}   props
 * @param {Function} props.onVerified     Callback tras verificación OK.
 * @param {Object}   props.tokenPayload   Bearer token a reenviar ({ resume_token }).
 *                   El backend deriva email+group del token; NUNCA mandamos email.
 * @param {boolean}  props.shouldAutoSend Auto-enviar el código al montar (true solo
 *                   la 1ª recuperación). Default true (retrocompat).
 * @param {Function} [props.onAutoSent]   Callback tras el auto-envío (el padre marca
 *                   la sesión como "ya auto-enviada" para no repetir en reloads).
 */
export default function StepUpGate({ onVerified, tokenPayload = {}, shouldAutoSend = true, onAutoSent }) {
  const { t } = useTranslation();
  const [sending,   setSending]   = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [codeSent,  setCodeSent]  = useState(false);
  const [code,      setCode]      = useState('');
  const [err,       setErr]       = useState('');
  const [info,      setInfo]      = useState('');
  // Evita doble envío en el StrictMode double-mount de dev y en re-renders.
  const autoSentRef = useRef(false);

  const errorMessage = (e) => {
    const codeOrMsg = e?.code || e?.message || '';
    if (/TOO_MANY_ATTEMPTS/.test(codeOrMsg)) return t('stepup.err_too_many_attempts');
    if (/RATE_LIMITED/.test(codeOrMsg))      return t('stepup.err_rate_limited');
    return e?.message || t('stepup.err_generic');
  };

  const sendCode = async () => {
    // Limpiamos el input al pedir un código nuevo — el código anterior ya no es
    // válido, así que no dejamos el valor erróneo en pantalla (Diego 2026-06-07).
    setCode('');
    setErr(''); setInfo(''); setSending(true);
    try {
      // NO mandamos email — el backend lo deriva del token (server-side, KAL-4).
      await gasCall('sendVerificationCode', { stepup: true, ...tokenPayload });
      setCodeSent(true);
      setInfo(t('stepup.code_sent'));
      log.info('StepUpGate: código de entrada solicitado');
    } catch (e) {
      log.error('StepUpGate: sendVerificationCode failed', { message: e.message });
      setErr(errorMessage(e));
    } finally {
      setSending(false);
    }
  };

  // Auto-envío al montar SOLO la primera recuperación (shouldAutoSend). En reload de
  // una sesión recuperada o re-expiración de frescura (shouldAutoSend=false) NO se
  // auto-envía: el gate aparece con el botón "enviar código" para que el usuario lo
  // pida (req. c). autoSentRef cubre el StrictMode double-mount.
  useEffect(() => {
    if (autoSentRef.current) return;
    autoSentRef.current = true;
    if (shouldAutoSend) {
      sendCode();
      if (onAutoSent) onAutoSent();
    }
    // OTP-WARM pieza A (decisión Diego 2026-06-11: "por qué no está el wizard
    // precargando datos… sólo se pone a hidratar cuando introduzco el otp"): mientras
    // el usuario teclea el código, el servidor cocina el snapshot del hydrate y lo
    // deja en la cache warm (warmSession devuelve SOLO {ok,warmed} — cero PII pre-OTP;
    // gate KAL-4 por resume_token + rate-limit server-side 120s/grupo). Fire-and-forget:
    // su fallo no afecta al flujo (el hydrate post-OTP seguiría el camino frío normal).
    gasCall('warmSession', { ...tokenPayload })
      .then(r => log.info('StepUpGate: warmSession', { warmed: !!(r && r.warmed), reason: (r && r.reason) || null }))
      .catch(e => log.warn('StepUpGate: warmSession failed (best-effort)', { message: e.message }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const verify = async () => {
    const clean = (code || '').trim();
    if (!/^\d{6}$/.test(clean)) { setErr(t('stepup.err_code_format')); return; }
    setErr(''); setInfo(''); setVerifying(true);
    try {
      await gasCall('verifyEmail', { code: clean, stepup: true, ...tokenPayload });
      log.success('StepUpGate: verificación de entrada OK');
      setCode('');
      onVerified();
    } catch (e) {
      log.error('StepUpGate: verifyEmail failed', { message: e.message });
      setErr(errorMessage(e));
      setVerifying(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 16, background: 'var(--bg, #f8f9fa)',
    }}>
      <div className="kis-card" style={{
        maxWidth: 440, width: '100%', padding: '28px 26px', textAlign: 'center',
      }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
          <LangToggle />
        </div>
        <img src={LOGO} alt="KIS" style={{ height: 48, marginBottom: 14 }} />

        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <i className="bi bi-shield-lock-fill" style={{ color: 'var(--teal-dk)', fontSize: '1.3rem' }} />
          <strong style={{ color: 'var(--teal-dk)', fontSize: '1.1rem' }}>
            {t('stepup.gate_title')}
          </strong>
        </div>
        <p style={{ color: 'var(--muted)', fontSize: '0.9rem', marginBottom: 10 }}>
          {t(codeSent ? 'stepup.gate_subtitle' : 'stepup.gate_subtitle_unsent')}
        </p>
        <p style={{ color: 'var(--muted)', fontSize: '0.8rem', marginBottom: 18 }}>
          <i className="bi bi-clock me-1" />{t('stepup.gate_duration_note')}
        </p>

        {/* OTP-TRIGGER: cuando NO se auto-envió (reload / re-expiración), invita a
            pedir el código manualmente. Se oculta en cuanto se envía uno. */}
        {!codeSent && !sending && (
          <p style={{ color: 'var(--teal-dk)', fontSize: '0.85rem', marginBottom: 16 }}>
            <i className="bi bi-envelope me-1" />{t('stepup.press_to_send')}
          </p>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center' }}>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            className="form-control"
            style={{ maxWidth: 180, letterSpacing: '0.35em', textAlign: 'center', fontWeight: 700, fontSize: '1.15rem' }}
            placeholder="••••••"
            value={code}
            disabled={!codeSent || verifying}
            onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            onKeyDown={e => { if (e.key === 'Enter') verify(); }}
          />
          <button
            className="btn-primary-kis"
            style={{ minWidth: 180 }}
            onClick={verify}
            disabled={verifying || !codeSent || code.length !== 6}
          >
            {verifying
              ? <><span className="spinner-border spinner-border-sm me-2" />{t('stepup.verifying')}</>
              : <><i className="bi bi-box-arrow-in-right me-1" />{t('stepup.gate_enter')}</>}
          </button>
          <button
            type="button"
            className="btn btn-link btn-sm p-0"
            style={{ fontSize: '0.85rem' }}
            onClick={sendCode}
            disabled={sending}
          >
            {sending
              ? <><span className="spinner-border spinner-border-sm me-1" />{t('stepup.sending')}</>
              : (codeSent ? t('stepup.resend') : t('stepup.send'))}
          </button>
        </div>

        {info && (
          <div className="mt-3" style={{ color: 'var(--teal-dk)', fontSize: '0.84rem' }}>
            <i className="bi bi-check-circle me-1" />{info}
          </div>
        )}
        {err && (
          <div className="field-error mt-3 p-2 rounded" style={{ background: '#ffeaea', fontSize: '0.85rem' }}>
            {err}
          </div>
        )}
      </div>
    </div>
  );
}
