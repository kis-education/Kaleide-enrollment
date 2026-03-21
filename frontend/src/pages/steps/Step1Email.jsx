import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { gasCall } from '../../api';
import { useWizard } from '../../context/WizardContext';

export default function Step1Email({ onNext }) {
  const { t }    = useTranslation();
  const { applicationId, stepData, updateStep } = useWizard();

  const data    = stepData.email;
  const [email, setEmail]     = useState(data.primary_email || '');
  const [verified, setVerified] = useState(data.verified || false);
  const [code, setCode]       = useState('');
  const [codeSent, setCodeSent] = useState(false);
  const [loading, setLoading] = useState(false);
  const [err, setErr]         = useState('');

  const validateEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

  const handleSendCode = async () => {
    if (!validateEmail(email)) { setErr(t('error.invalid_email')); return; }
    setErr('');
    setLoading(true);
    try {
      await gasCall('sendVerificationCode', { application_id: applicationId, primary_email: email });
      setCodeSent(true);
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  };

  const handleVerify = async () => {
    if (code.length !== 6) { setErr(t('error.invalid_code')); return; }
    setErr('');
    setLoading(true);
    try {
      await gasCall('verifyEmail', { application_id: applicationId, code });
      setVerified(true);
      updateStep('email', { primary_email: email, verified: true });
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  };

  return (
    <div className="kis-card">
      <h2>{t('step.email')}</h2>
      <p className="section-subtitle">{t('step1.subtitle')}</p>

      {verified ? (
        <div className="alert alert-success d-flex align-items-center gap-2">
          <i className="bi bi-check-circle-fill" />
          {t('step1.verified', { email })}
        </div>
      ) : (
        <>
          <div className="mb-3">
            <label className="form-label fw-semibold">{t('field.primary_email')}</label>
            <div className="input-group">
              <input
                type="email"
                className={`form-control ${err && !codeSent ? 'is-invalid' : ''}`}
                value={email}
                onChange={e => { setEmail(e.target.value); setErr(''); setCodeSent(false); }}
                disabled={codeSent}
                placeholder="your@email.com"
              />
              {!codeSent && (
                <button
                  className="btn btn-outline-secondary"
                  onClick={handleSendCode}
                  disabled={loading}
                >
                  {loading ? <span className="spinner-border spinner-border-sm" /> : t('step1.send_code')}
                </button>
              )}
            </div>
          </div>

          {codeSent && (
            <div className="mb-3">
              <label className="form-label fw-semibold">{t('step1.enter_code')}</label>
              <div className="d-flex align-items-center gap-3 flex-wrap">
                <input
                  type="text"
                  inputMode="numeric"
                  maxLength={6}
                  className="code-input"
                  value={code}
                  onChange={e => { setCode(e.target.value.replace(/\D/g, '')); setErr(''); }}
                />
                <button className="btn-primary-kis" onClick={handleVerify} disabled={loading}>
                  {loading ? <span className="spinner-border spinner-border-sm" /> : t('step1.verify')}
                </button>
              </div>
              <p style={{ fontSize: '0.82rem', color: 'var(--muted)', marginTop: 8 }}>
                {t('step1.resend_prompt')}{' '}
                <button
                  onClick={() => { setCodeSent(false); setCode(''); }}
                  style={{ background: 'none', border: 'none', color: 'var(--teal-dk)', cursor: 'pointer', fontWeight: 600 }}
                >
                  {t('step1.resend_link')}
                </button>
              </p>
            </div>
          )}

          {err && <div className="field-error mb-2">{err}</div>}
        </>
      )}

      <div className="d-flex justify-content-end mt-3">
        <button
          className="btn-primary-kis"
          onClick={() => onNext('email', { primary_email: email, verified: true })}
          disabled={!verified}
        >
          {t('nav.continue')} <i className="bi bi-arrow-right ms-1" />
        </button>
      </div>
    </div>
  );
}
