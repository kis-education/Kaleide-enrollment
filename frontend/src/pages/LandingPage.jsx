import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { gasCall } from '../api';
import * as log from '../logger';
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
  const [showPrivacy, setShowPrivacy] = useState(false);

  const validateEmail = v => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v);

  // WIZARD-UX (Diego 2026-06-13) — ENVÍO OPTIMISTA + MENSAJE GENÉRICO (privacidad /
  // anti-enumeración, alineado con KAL-10 silent-ack). Antes la landing ramificaba el
  // UI en 3 pantallas distintas (already_submitted / resumed / sent) según existiera o
  // no una solicitud previa para el email → un atacante que conociera un email podía
  // inferir, por el mensaje que recibía, si esa familia está matriculando. Ahora:
  //   1. Validamos en local (formato de email + consentimiento) — única condición que
  //      bloquea el avance, no revela nada del servidor.
  //   2. Pintamos INMEDIATAMENTE la pantalla genérica "te hemos enviado un enlace" (UN
  //      solo mensaje, idéntico para TODOS los casos: nueva, en curso, ya enviada, o
  //      email inexistente).
  //   3. Disparamos la petición real (sendMagicLink → init nuevo si "not found") en
  //      SEGUNDO PLANO (fire-and-forget) — su resultado NUNCA se refleja en el UI, así
  //      que ni el mensaje ni el timing distinguen "existe" de "no existe".
  // El warm best-effort + el seed de estado del wizard se conservan dentro del kick de
  // fondo. KAL-7: el resume_token nuevo nunca llega al cliente aquí — viaja por email.
  const sendAccessLink = async () => {
    // DL-E38 a1: remember the email the family typed as the per-guardian
    // discriminator. Persisted in sessionStorage so the magic-link resume
    // (ResumePage) can re-send it → backend re-resolves the guardian server-side.
    setRecoveredEmail(email);

    try {
      // (1) RECUPERAR primero: el servidor resuelve el email contra `primary_email` Y
      //     contra los emails de guardian del grupo (sendMagicLink_ →
      //     findOpenGroupsByGuardianEmail_). El link va al inbox del tutor que lo pidió.
      let recovered = false;
      try {
        const sentRes = await gasCall('sendMagicLink', { primary_email: email });
        recovered = true;
        // SPEC-WIZ-WARMUP-V2 — kick fire-and-forget del precalentado del bundle de
        // entrada (el resume_token nuevo solo viaja por email). Best-effort.
        if (sentRes && sentRes.warm_ticket) gasCall('warmBundle', { ticket: sentRes.warm_ticket }).catch(() => {});
      } catch (recErr) {
        // Solo "Enrollment group not found" (email no asociado) cae a iniciar nuevo.
        // Cualquier otro error (rate-limit, validación, red) se traga SILENCIOSAMENTE:
        // el usuario ya vio el mensaje genérico (anti-enum) → no exponemos el fallo.
        if (!/not found/i.test((recErr && recErr.message) || '')) {
          log.warn('LandingPage: sendMagicLink failed (silenciado, anti-enum)', { message: recErr && recErr.message });
          return;
        }
      }

      if (recovered) return; // link enviado; el estado lo gobierna el destino del link.

      // ── Sin grupo asociado → iniciar una solicitud nueva ──────────────────
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
      // SPEC-WIZ-WARMUP-V2: los paths del init también envían magic link → mismo kick.
      if (data.warm_ticket) gasCall('warmBundle', { ticket: data.warm_ticket }).catch(() => {});
      // already_submitted: el backend ya mandó el link de "ver mi solicitud"; nada que
      // pintar (el mensaje genérico ya está). Para los demás casos, sembramos el estado
      // del wizard en memoria por si la familia abre el link en esta misma pestaña.
      if (data.already_submitted) return;
      setEnrollmentGroupId(data.enrollment_group_id || data.application_id);
      setResumeToken(data.resumed ? null : (data.resume_token || null));
      setRecognition(data.recognition);
      updateStep('email', { primary_email: email, verified: false });
    } catch (e) {
      // Cualquier fallo del kick de fondo se traga: el usuario ya vio el mensaje
      // genérico. Loguear (redactado) para diagnóstico, NUNCA mostrar al usuario.
      log.warn('LandingPage: kick de envío falló (silenciado, anti-enum)', { message: e && e.message });
    }
  };

  const handleSubmit = (e) => {
    e.preventDefault();
    if (!validateEmail(email)) { setEmailErr(t('error.invalid_email')); return; }
    if (!consent) { setErr(t('error.consent_required')); return; }

    setEmailErr('');
    setErr('');
    setSubmitting(true);
    // OPTIMISTA: pinta la pantalla genérica YA. El envío real corre en background.
    setSent(true);
    sendAccessLink();
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
    // WIZARD-UX (Diego 2026-06-13): UN SOLO mensaje genérico para CUALQUIER supuesto
    // (nueva, en curso, ya enviada, o email inexistente) — anti-enumeración (KAL-10).
    // El UI NO valida ni revela frente al usuario si existe o no una solicitud previa:
    // "si alguien conoce mi email y entra ahí, podría saber si estoy matriculando".
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
