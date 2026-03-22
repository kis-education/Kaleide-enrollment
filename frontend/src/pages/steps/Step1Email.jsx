import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { gasCall } from '../../api';
import { useWizard } from '../../context/WizardContext';

const CURRENT_YEAR = new Date().getFullYear();
const SCHOOL_YEARS = Array.from({ length: 5 }, (_, i) => {
  const y = CURRENT_YEAR + i;
  return { value: String(y), label: `${y}/${String(y + 1).slice(-2)}` };
});

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

  // Desired start date — initialise from resumed application state
  const initialDate = data.desired_start_date || '';
  const initialYear = initialDate ? initialDate.slice(0, 4) : String(CURRENT_YEAR);
  const initialIsSeptember = !initialDate || initialDate.slice(5, 10) === '09-01';
  const [schoolYear,        setSchoolYear]        = useState(initialIsSeptember ? initialYear : initialYear);
  const [startType,         setStartType]         = useState(initialIsSeptember ? 'september' : 'midterm');
  const [desiredStartDate,  setDesiredStartDate]  = useState(
    initialIsSeptember ? `${initialYear}-09-01` : (initialDate || `${initialYear}-09-01`)
  );

  const validateEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

  const handleSchoolYear = (year) => {
    setSchoolYear(year);
    if (startType === 'september') {
      setDesiredStartDate(`${year}-09-01`);
    }
  };

  const handleStartType = (type) => {
    setStartType(type);
    if (type === 'september') {
      setDesiredStartDate(`${schoolYear}-09-01`);
    } else {
      setDesiredStartDate('');
    }
  };

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
      updateStep('email', { primary_email: email, verified: true, desired_start_date: desiredStartDate });
    } catch (e) { setErr(e.message); }
    finally { setLoading(false); }
  };

  const handleContinue = () => {
    updateStep('email', { primary_email: email, verified: true, desired_start_date: desiredStartDate });
    onNext('application', { desired_start_date: desiredStartDate });
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

      {/* Desired start date — shown after email is verified */}
      {verified && (
        <div className="mt-4 p-3 rounded" style={{ background: 'var(--teal-lt)' }}>
          <h6 style={{ color: 'var(--teal-dk)', marginBottom: 12 }}>{t('step1.start_date_title')}</h6>
          <div className="row g-3">
            <div className="col-md-4">
              <label className="form-label">{t('field.school_year')}</label>
              <select className="form-select" value={schoolYear} onChange={e => handleSchoolYear(e.target.value)}>
                {SCHOOL_YEARS.map(y => <option key={y.value} value={y.value}>{y.label}</option>)}
              </select>
            </div>
            <div className="col-md-8">
              <label className="form-label">{t('field.start_type')}</label>
              <div className="d-flex gap-3">
                <div className="form-check">
                  <input type="radio" className="form-check-input" name="startType" id="sep"
                    checked={startType === 'september'} onChange={() => handleStartType('september')} />
                  <label className="form-check-label" htmlFor="sep">{t('start.september')}</label>
                </div>
                <div className="form-check">
                  <input type="radio" className="form-check-input" name="startType" id="mid"
                    checked={startType === 'midterm'} onChange={() => handleStartType('midterm')} />
                  <label className="form-check-label" htmlFor="mid">{t('start.midterm')}</label>
                </div>
              </div>
            </div>
            {startType === 'midterm' && (
              <div className="col-md-5">
                <label className="form-label">{t('field.start_date')}</label>
                <input type="date" className="form-control"
                  value={desiredStartDate}
                  onChange={e => setDesiredStartDate(e.target.value)} />
                <div className="disclaimer-box mt-2">
                  {t('start.disclaimer_en')}
                  <hr style={{ margin: '6px 0' }} />
                  {t('start.disclaimer_es')}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      <div className="d-flex justify-content-end mt-3">
        <button
          className="btn-primary-kis"
          onClick={handleContinue}
          disabled={!verified || (startType === 'midterm' && !desiredStartDate)}
        >
          {t('nav.continue')} <i className="bi bi-arrow-right ms-1" />
        </button>
      </div>
    </div>
  );
}
