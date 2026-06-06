import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { gasCall } from '../api';
import { useWizard } from '../context/WizardContext';
import LangToggle from '../components/LangToggle';
import HoneypotField from '../components/HoneypotField';
import LegalFooter from '../components/LegalFooter';
import PrivacyPolicyModal from '../components/PrivacyPolicyModal';
import { useSearchParams } from 'react-router-dom';
import { CONSENT_TEXTS } from '../consentTexts';

const LOGO = 'https://raw.githubusercontent.com/kaleideschool/public/main/favicon.png';
const RECAPTCHA_SITE_KEY = import.meta.env.VITE_RECAPTCHA_SITE_KEY;

export default function LandingPage() {
  const { t } = useTranslation();
  const [searchParams] = useSearchParams();
  const { setEnrollmentGroupId, setResumeToken, updateStep, setRecognition, setRecoveredEmail } = useWizard();

  useEffect(() => {
    if (!RECAPTCHA_SITE_KEY || document.querySelector('#recaptcha-script')) return;
    const s = document.createElement('script');
    s.id = 'recaptcha-script';
    s.src = `https://www.google.com/recaptcha/api.js?render=${RECAPTCHA_SITE_KEY}`;
    document.head.appendChild(s);
  }, []);

  const resumeError = searchParams.get('resume_error') === '1';

  const [email,       setEmail]       = useState(searchParams.get('email') || '');
  const [emailErr,    setEmailErr]    = useState('');
  const [consent,     setConsent]     = useState(false);
  const [submitting,  setSubmitting]  = useState(false);
  const [err,         setErr]         = useState('');
  const [sent,           setSent]           = useState(false);
  const [resumed,        setResumed]        = useState(false);
  const [alreadySubmitted, setAlreadySubmitted] = useState(false);
  const [showPrivacy, setShowPrivacy] = useState(false);

  const validateEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

  const handleSubmit = async (e) => {
    e.preventDefault();
    if (!validateEmail(email)) { setEmailErr(t('error.invalid_email')); return; }
    if (!consent) { setErr(t('error.consent_required')); return; }

    setEmailErr('');
    setErr('');
    setSubmitting(true);

    // DL-E38 a1: remember the email the family typed as the per-guardian
    // discriminator. Persisted in sessionStorage so the magic-link resume
    // (ResumePage) can re-send it → backend re-resolves the guardian server-side.
    setRecoveredEmail(email);

    try {
      let recaptcha_token = null;
      if (RECAPTCHA_SITE_KEY && window.grecaptcha) {
        await new Promise(resolve => window.grecaptcha.ready(resolve));
        recaptcha_token = await window.grecaptcha.execute(RECAPTCHA_SITE_KEY, { action: 'init_application' });
      }

      const data = await gasCall('initEnrollmentSession', {
        primary_email:      email,
        preferred_language: navigator.language?.startsWith('en') ? 'en' : 'es',
        recaptcha_token,
      });
      if (data.already_submitted) {
        setAlreadySubmitted(true);
        setSent(true);
        return;
      }
      setEnrollmentGroupId(data.enrollment_group_id || data.application_id);
      setResumeToken(data.resumed ? null : (data.resume_token || null));
      setRecognition(data.recognition);
      updateStep('email', { primary_email: email, verified: false });
      setResumed(!!data.resumed);
      setSent(true);
    } catch (e) {
      setErr(e.message);
      setSubmitting(false);
    }
  };

  const header = (
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
  );

  if (sent) {
    if (alreadySubmitted) {
      return (
        <div className="wizard-layout">
          {header}
          <div className="landing-hero">
            <img src={LOGO} alt="KIS" className="landing-logo" />
            <div style={{
              maxWidth: 580, margin: '0 auto', padding: '32px 28px',
              background: '#e8f5e9', border: '2px solid #43a047',
              borderRadius: 12, textAlign: 'center',
            }}>
              <div style={{
                width: 72, height: 72, background: '#c8e6c9', borderRadius: '50%',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                margin: '0 auto 20px',
              }}>
                <i className="bi bi-check-circle-fill" style={{ fontSize: '2.2rem', color: '#2e7d32' }} />
              </div>
              <h1 style={{ fontSize: '1.4rem', fontWeight: 700, color: '#1b5e20', marginBottom: 16 }}>
                {t('consent.already_submitted_title')}
              </h1>
              <p style={{ color: '#2e4a2f', lineHeight: 1.5, marginBottom: 12, fontSize: '1rem' }}>
                {t('consent.already_submitted_subtitle_sent', { email })}
              </p>
              <p style={{ color: '#2e4a2f', lineHeight: 1.5, fontSize: '0.92rem', marginBottom: 0 }}>
                {t('consent.already_submitted_note')}
              </p>
            </div>
          </div>
        </div>
      );
    }
    if (resumed) {
      return (
        <div className="wizard-layout">
          {header}
          <div className="landing-hero">
            <img src={LOGO} alt="KIS" className="landing-logo" />
            <div style={{
              maxWidth: 580, margin: '0 auto', padding: '32px 28px',
              background: '#fff8e1', border: '2px solid #f0a500',
              borderRadius: 12, textAlign: 'center',
            }}>
              <div style={{
                width: 72, height: 72, background: '#ffe082', borderRadius: '50%',
                display: 'flex', alignItems: 'center', justifyContent: 'center',
                margin: '0 auto 20px',
              }}>
                <i className="bi bi-info-circle-fill" style={{ fontSize: '2.2rem', color: '#b45309' }} />
              </div>
              <h1 style={{ fontSize: '1.4rem', fontWeight: 700, color: '#92400e', marginBottom: 16 }}>
                {t('consent.resumed_title')}
              </h1>
              <p style={{ color: '#5c4400', lineHeight: 1.5, marginBottom: 12, fontSize: '1rem' }}>
                {t('consent.resumed_subtitle', { email })}
              </p>
              <p style={{ color: '#5c4400', lineHeight: 1.5, fontSize: '0.92rem', marginBottom: 0 }}>
                {t('consent.resumed_note')}
              </p>
            </div>
          </div>
        </div>
      );
    }
    return (
      <div className="wizard-layout">
        {header}
        <div className="landing-hero">
          <img src={LOGO} alt="KIS" className="landing-logo" />
          <h1 className="landing-title">{t('consent.sent_title')}</h1>
          <p className="landing-subtitle">{t('consent.sent_subtitle', { email })}</p>
          <div className="kis-card" style={{ maxWidth: 480, margin: '0 auto', textAlign: 'center' }}>
            <i className="bi bi-envelope-check" style={{ fontSize: '2.5rem', color: 'var(--teal-dk)' }} />
            <p className="mt-3" style={{ color: 'var(--muted)' }}>{t('consent.sent_note')}</p>
          </div>
        </div>
      </div>
    );
  }

  return (
    <div className="wizard-layout">
      {header}

      {resumeError && (
        <div style={{ background: '#fff3ec', borderBottom: '2px solid #f37021', padding: '14px 24px', display: 'flex', alignItems: 'center', gap: 10, color: '#18222e' }}>
          <i className="bi bi-exclamation-triangle-fill" style={{ color: '#f37021', fontSize: '1.1em' }} />
          <span>{t('landing.resume_error')}</span>
        </div>
      )}

      <div className="landing-hero">
        <img src={LOGO} alt="KIS" className="landing-logo" />
        <h1 className="landing-title">{t('landing.title')}</h1>
        <p className="landing-subtitle">{t('landing.subtitle')}</p>

        <div className="kis-card" style={{ maxWidth: 560, margin: '0 auto', textAlign: 'left' }}>
          <form onSubmit={handleSubmit} noValidate>
            <HoneypotField />

            {/* GDPR consent block */}
            <div className="consent-block mb-4">
              <p className="consent-text"><strong>EN:</strong> {CONSENT_TEXTS.gdpr.en}</p>
              <p className="consent-text"><strong>ES:</strong> {CONSENT_TEXTS.gdpr.es}</p>
              <p className="consent-text" style={{ fontSize: '0.82rem' }}>
                <a href="https://kaleide.org/es/legal-es/" target="_blank" rel="noopener noreferrer">{t('legal.notice_link')}</a>
                {' · '}
                <button onClick={() => setShowPrivacy(true)} style={{
                  background: 'none', border: 'none', padding: 0,
                  color: 'var(--teal-dk)', cursor: 'pointer', fontSize: 'inherit',
                  textDecoration: 'underline',
                }}>{t('legal.privacy_link')}</button>
              </p>
              <div className="form-check mt-3">
                <input
                  type="checkbox"
                  className="form-check-input"
                  id="consent_gdpr"
                  checked={consent}
                  onChange={e => { setConsent(e.target.checked); setErr(''); }}
                />
                <label className="form-check-label fw-semibold" htmlFor="consent_gdpr">
                  {t('consent.gdpr_accept')}
                </label>
              </div>
            </div>

            {/* Email */}
            <div className="mb-3">
              <label className="form-label fw-semibold">{t('field.primary_email')}</label>
              <input
                type="email"
                className={`form-control ${emailErr ? 'is-invalid' : ''}`}
                value={email}
                onChange={e => { setEmail(e.target.value); setEmailErr(''); }}
                placeholder="your@email.com"
                required
              />
              {emailErr && <div className="field-error">{emailErr}</div>}
            </div>

            {err && <div className="field-error mb-3">{err}</div>}

            <button type="submit" className="btn-primary-kis w-100" disabled={submitting}>
              {submitting
                ? <><span className="spinner-border spinner-border-sm me-2" />{t('landing.starting')}</>
                : <>{t('landing.access_btn')} <i className="bi bi-arrow-right ms-1" /></>
              }
            </button>
          </form>
        </div>
      </div>
      <LegalFooter />
      <PrivacyPolicyModal show={showPrivacy} onClose={() => setShowPrivacy(false)} />
    </div>
  );
}
