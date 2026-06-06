import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { gasCall } from '../api';
import * as log from '../logger';

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
 *   1. Al montar, envía un código fresco (sendVerificationCode, {stepup:true}).
 *      El backend deriva email+group del bearer token SERVER-SIDE (KAL-4) — NUNCA
 *      mandamos el email del payload. El destinatario es el buzón del expediente.
 *   2. Input de 6 dígitos + "Verificar" (verifyEmail, {stepup:true}). En éxito
 *      invoca onVerified() → el padre marca step-up fresco (10 min) y renderiza
 *      el wizard.
 *
 * KAL-7 / KAL-11: nunca metemos el código/token en la URL ni logueamos el código
 * completo.
 *
 * @param {Object}   props
 * @param {Function} props.onVerified   Callback tras verificación OK.
 * @param {Object}   props.tokenPayload Bearer token a reenviar ({ resume_token }).
 *                   El backend deriva email+group del token; NUNCA mandamos email.
 */
export default function StepUpGate({ onVerified, tokenPayload = {} }) {
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

  // Auto-envío al montar el gate (el código llega al buzón sin que la familia
  // pulse nada). Si falla, dejamos el botón "reenviar" para reintentar.
  useEffect(() => {
    if (autoSentRef.current) return;
    autoSentRef.current = true;
    sendCode();
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
        <img src={LOGO} alt="KIS" style={{ height: 48, marginBottom: 14 }} />

        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <i className="bi bi-shield-lock-fill" style={{ color: 'var(--teal-dk)', fontSize: '1.3rem' }} />
          <strong style={{ color: 'var(--teal-dk)', fontSize: '1.1rem' }}>
            {t('stepup.gate_title')}
          </strong>
        </div>
        <p style={{ color: 'var(--muted)', fontSize: '0.9rem', marginBottom: 18 }}>
          {t('stepup.gate_subtitle')}
        </p>

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
              : t('stepup.resend')}
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
