import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { gasCall } from '../api';
import * as log from '../logger';

/**
 * StepUpReverify — DL-E39 (PII-primero) re-verificación step-up.
 *
 * La PII sensible de menores (salud Art.9 RGPD, DNI, DOB, dirección) se muestra
 * enmascarada por defecto y se revela en claro SOLO tras un step-up: un código
 * fresco enviado al buzón del grupo. Este componente NO re-teclea el email —
 * el backend deriva email+group del bearer token server-side (KAL-4). Solo
 * pedimos el código de 6 dígitos.
 *
 * Contrato backend (Fase A):
 *   - gasCall('sendVerificationCode', { stepup:true, ...tokenPayload })
 *       → reenvía código fresco al buzón del grupo.
 *   - gasCall('verifyEmail', { code, stepup:true, ...tokenPayload })
 *       → valida; si OK marca "step-up fresco" 10 min server-side.
 *     Errores: TOO_MANY_ATTEMPTS, RATE_LIMITED.
 *
 * Al verificar OK invoca onVerified() — el padre marca step-up fresco
 * (markStepUpFresh) y reintenta la acción gateada.
 *
 * KAL-7 / KAL-11: nunca metemos el código/token en la URL ni logueamos el
 * código completo (el logger ya redacta; aquí no logueamos el code).
 *
 * @param {Object}   props
 * @param {Function} props.onVerified  Callback tras verificación OK.
 * @param {Object}   [props.tokenPayload]  Bearer token a reenviar al backend
 *                   ({ resume_token } en /apply, { signing_token } en /sign).
 *                   El backend deriva email+group del token; NUNCA mandamos email.
 * @param {string}   [props.prompt]    Texto de cabecera opcional (motivo del gate).
 * @param {boolean}  [props.compact]   Estilo inline reducido (revelar en línea).
 */
export default function StepUpReverify({ onVerified, tokenPayload = {}, prompt, compact = false }) {
  const { t } = useTranslation();
  const [sending,   setSending]   = useState(false);
  const [verifying, setVerifying] = useState(false);
  const [codeSent,  setCodeSent]  = useState(false);
  const [code,      setCode]      = useState('');
  const [err,       setErr]       = useState('');
  const [info,      setInfo]      = useState('');

  // Mapea códigos de error del backend a mensajes i18n claros.
  const errorMessage = (e) => {
    const codeOrMsg = e?.code || e?.message || '';
    if (codeOrMsg === 'TOO_MANY_ATTEMPTS' || /TOO_MANY_ATTEMPTS/.test(codeOrMsg)) {
      return t('stepup.err_too_many_attempts');
    }
    if (codeOrMsg === 'RATE_LIMITED' || /RATE_LIMITED/.test(codeOrMsg)) {
      return t('stepup.err_rate_limited');
    }
    return e?.message || t('stepup.err_generic');
  };

  const sendCode = async () => {
    setErr(''); setInfo(''); setSending(true);
    try {
      // NO mandamos email — el backend lo deriva del token (server-side).
      await gasCall('sendVerificationCode', { stepup: true, ...tokenPayload });
      setCodeSent(true);
      setInfo(t('stepup.code_sent'));
      log.info('step-up: código fresco solicitado');
    } catch (e) {
      log.error('StepUpReverify: sendVerificationCode failed', { message: e.message });
      setErr(errorMessage(e));
    } finally {
      setSending(false);
    }
  };

  const verify = async () => {
    const clean = (code || '').trim();
    if (!/^\d{6}$/.test(clean)) { setErr(t('stepup.err_code_format')); return; }
    setErr(''); setInfo(''); setVerifying(true);
    try {
      // KAL-11: el logger redacta, pero por seguridad NO logueamos el código.
      await gasCall('verifyEmail', { code: clean, stepup: true, ...tokenPayload });
      log.success('step-up: verificación OK');
      setCode('');
      onVerified();
    } catch (e) {
      log.error('StepUpReverify: verifyEmail failed', { message: e.message });
      setErr(errorMessage(e));
      setVerifying(false);
    }
  };

  return (
    <div
      className="kis-card"
      style={{
        background: 'var(--teal-lt, #eef7f7)',
        border: '1px solid var(--teal, #2a9d9d)',
        borderRadius: 10,
        padding: compact ? '12px 14px' : '16px 18px',
        marginTop: compact ? 8 : 12,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 6 }}>
        <i className="bi bi-shield-lock-fill" style={{ color: 'var(--teal-dk)' }} />
        <strong style={{ color: 'var(--teal-dk)', fontSize: compact ? '0.9rem' : '1rem' }}>
          {prompt || t('stepup.title')}
        </strong>
      </div>
      <p style={{ color: 'var(--muted)', fontSize: '0.85rem', marginBottom: 10 }}>
        {t('stepup.subtitle')}
      </p>

      {!codeSent ? (
        <button className="btn-primary-kis" onClick={sendCode} disabled={sending}>
          {sending
            ? <><span className="spinner-border spinner-border-sm me-2" />{t('stepup.sending')}</>
            : <><i className="bi bi-envelope-fill me-1" />{t('stepup.send_code')}</>}
        </button>
      ) : (
        <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            className="form-control"
            style={{ maxWidth: 140, letterSpacing: '0.3em', textAlign: 'center', fontWeight: 700 }}
            placeholder="••••••"
            value={code}
            onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            onKeyDown={e => { if (e.key === 'Enter') verify(); }}
          />
          <button className="btn-primary-kis" onClick={verify} disabled={verifying}>
            {verifying
              ? <><span className="spinner-border spinner-border-sm me-2" />{t('stepup.verifying')}</>
              : t('stepup.verify')}
          </button>
          <button
            type="button"
            className="btn btn-link btn-sm p-0"
            style={{ fontSize: '0.82rem' }}
            onClick={sendCode}
            disabled={sending}
          >
            {t('stepup.resend')}
          </button>
        </div>
      )}

      {info && (
        <div className="mt-2" style={{ color: 'var(--teal-dk)', fontSize: '0.83rem' }}>
          <i className="bi bi-check-circle me-1" />{info}
        </div>
      )}
      {err && (
        <div className="field-error mt-2 p-2 rounded" style={{ background: '#ffeaea', fontSize: '0.85rem' }}>
          {err}
        </div>
      )}
    </div>
  );
}
