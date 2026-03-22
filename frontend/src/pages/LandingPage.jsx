import { useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { gasCall } from '../api';
import LangToggle from '../components/LangToggle';
import { Toast, useToast } from '../components/Toast';
import HoneypotField from '../components/HoneypotField';

const LOGO = 'https://raw.githubusercontent.com/kaleideschool/public/main/favicon.png';

export default function LandingPage() {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const [searchParams] = useSearchParams();
  const resumeError = searchParams.get('resume_error') === '1';

  const [resumeEmail, setResumeEmail]     = useState('');
  const [resumeErr, setResumeErr]         = useState('');
  const [resumeSending, setResumeSending] = useState(false);

  const { message: toastMsg, showToast } = useToast();

  const validateEmail = (v) => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

  const handleResume = async (e) => {
    e.preventDefault();
    if (!validateEmail(resumeEmail)) {
      setResumeErr(t('error.invalid_email'));
      return;
    }
    setResumeErr('');
    setResumeSending(true);
    try {
      await gasCall('sendMagicLink', { primary_email: resumeEmail });
      showToast(t('landing.magic_link_sent'));
      setResumeEmail('');
    } catch (err) {
      setResumeErr(err.message);
    } finally {
      setResumeSending(false);
    }
  };

  return (
    <div className="wizard-layout">
      {/* Header */}
      <header className="kis-header">
        <div className="brand">
          <img src={LOGO} alt="KIS" />
          <div>
            <div className="brand-name">Kaleide International School</div>
            <div className="brand-sub">{t('landing.header_sub')}</div>
          </div>
        </div>
        <LangToggle />
      </header>

      {resumeError && (
        <div style={{ background: '#fff3ec', borderBottom: '2px solid #f37021', padding: '14px 24px', display: 'flex', alignItems: 'center', gap: 10, color: '#18222e' }}>
          <i className="bi bi-exclamation-triangle-fill" style={{ color: '#f37021', fontSize: '1.1em' }} />
          <span>{t('landing.resume_error')}</span>
        </div>
      )}

      {/* Hero */}
      <div className="landing-hero">
        <img src={LOGO} alt="KIS" className="landing-logo" />
        <h1 className="landing-title">{t('landing.title')}</h1>
        <p className="landing-subtitle">{t('landing.subtitle')}</p>

        {/* Start application */}
        <div className="kis-card" style={{ maxWidth: 460, margin: '0 auto 28px' }}>
          <h2 style={{ marginBottom: 4 }}>{t('landing.start_title')}</h2>
          <p className="section-subtitle">{t('landing.start_subtitle')}</p>
          <button className="btn-primary-kis w-100" onClick={() => navigate('/consent')}>
            {t('landing.start_btn')} <i className="bi bi-arrow-right ms-1" />
          </button>
        </div>

        {/* Resume application */}
        <div className="kis-card" style={{ maxWidth: 460, margin: '0 auto' }}>
          <h2 style={{ marginBottom: 4 }}>{t('landing.resume_title')}</h2>
          <p className="section-subtitle">{t('landing.resume_subtitle')}</p>
          <form onSubmit={handleResume} noValidate>
            <HoneypotField />
            <div className="mb-3">
              <label className="form-label fw-semibold">{t('field.primary_email')}</label>
              <input
                type="email"
                className={`form-control ${resumeErr ? 'is-invalid' : ''}`}
                value={resumeEmail}
                onChange={e => { setResumeEmail(e.target.value); setResumeErr(''); }}
                placeholder="your@email.com"
              />
              {resumeErr && <div className="field-error">{resumeErr}</div>}
            </div>
            <button type="submit" className="btn-secondary-kis w-100" disabled={resumeSending}>
              {resumeSending
                ? <span className="spinner-border spinner-border-sm" />
                : t('landing.resume_btn')
              }
            </button>
          </form>
        </div>
      </div>

      <Toast message={toastMsg} />
    </div>
  );
}
