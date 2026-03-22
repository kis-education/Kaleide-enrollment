import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useWizard } from '../../context/WizardContext';
import { gasCall } from '../../api';
import { CONSENT_TEXTS } from '../../consentTexts';

const RECAPTCHA_SITE_KEY = import.meta.env.VITE_RECAPTCHA_SITE_KEY;

function ReviewRow({ label, value }) {
  if (!value && value !== false) return null;
  return (
    <div className="review-row">
      <span className="review-label">{label}</span>
      <span className="review-value">{String(value)}</span>
    </div>
  );
}

function ReviewSection({ title, children }) {
  return (
    <div className="review-section">
      <h4>{title}</h4>
      {children}
    </div>
  );
}

function loadRecaptcha(siteKey) {
  return new Promise(resolve => {
    if (window.grecaptcha) { resolve(window.grecaptcha); return; }
    const s = document.createElement('script');
    s.src = `https://www.google.com/recaptcha/api.js?render=${siteKey}`;
    s.onload = () => window.grecaptcha.ready(() => resolve(window.grecaptcha));
    document.head.appendChild(s);
  });
}

export default function Step7Review({ onBack }) {
  const { t, i18n }  = useTranslation();
  const navigate     = useNavigate();
  const lang         = i18n.language?.startsWith('en') ? 'en' : 'es';
  const { applicationId, stepData } = useWizard();

  const { email, guardians, applicants, health, documents } = stepData;

  const [esig,         setEsig]         = useState('');
  const [consentGdpr,  setConsentGdpr]  = useState(false);
  const [consentLegal, setConsentLegal] = useState(false);
  const [submitting,   setSubmitting]   = useState(false);
  const [err,          setErr]          = useState('');

  const handleSubmit = async () => {
    if (!esig.trim()) { setErr(t('error.esig_required')); return; }
    if (!consentGdpr)  { setErr(t('error.consent_required')); return; }
    if (!consentLegal) { setErr(t('error.consent_required')); return; }

    setErr('');
    setSubmitting(true);

    try {
      // reCAPTCHA v3
      if (RECAPTCHA_SITE_KEY) {
        const rc = await loadRecaptcha(RECAPTCHA_SITE_KEY);
        const token = await rc.execute(RECAPTCHA_SITE_KEY, { action: 'submit' });
        const rcResult = await gasCall('verifyRecaptcha', { token });
        if (!rcResult.pass) {
          setErr(t('error.recaptcha_failed'));
          setSubmitting(false);
          return;
        }
      }

      await gasCall('submitApplication', {
        application_id: applicationId,
        esignature:     esig,
        language:       lang,
        consents: [
          { type: 'gdpr',  accepted: consentGdpr,  consent_text_shown: CONSENT_TEXTS.gdpr[lang]  },
          { type: 'legal', accepted: consentLegal, consent_text_shown: CONSENT_TEXTS.legal[lang] },
        ],
      });

      navigate('/confirmation');
    } catch (e) {
      setErr(e.message);
      setSubmitting(false);
    }
  };

  return (
    <>
      <div className="mb-2">
        <h2 style={{ color: 'var(--teal-dk)', fontWeight: 800 }}>{t('step.review')}</h2>
        <p style={{ color: 'var(--muted)' }}>{t('step7.subtitle')}</p>
      </div>

      <div className="kis-card">
        {/* Email */}
        <ReviewSection title={t('review.email')}>
          <ReviewRow label={t('field.primary_email')} value={email?.primary_email} />
          <ReviewRow label={t('review.verified')} value={email?.verified ? t('yes') : t('no')} />
        </ReviewSection>

        {/* Guardians */}
        {(guardians || []).map((g, i) => (
          <ReviewSection key={i} title={`${t('guardian.title', { n: i + 1 })} — ${g.first_name || ''} ${g.last_name || ''}`}>
            <ReviewRow label={t('field.date_of_birth')} value={g.date_of_birth} />
            <ReviewRow label={t('field.nationality')} value={g.nationality_id} />
            <ReviewRow label={t('field.id_number')} value={g.id_number} />
            <ReviewRow label={t('field.profession')} value={g.profession} />
            <ReviewRow label={t('field.address_line_1')} value={g.address_line_1} />
            <ReviewRow label={t('field.city')} value={g.city} />
            <ReviewRow label={t('field.country')} value={g.country_id} />
            {(g.contacts || []).map((c, ci) => (
              <ReviewRow key={ci} label={t(`contact.${c.contact_type}`)} value={c.value + (c.is_whatsapp ? ' (WhatsApp)' : '') + (c.is_telegram ? ' (Telegram)' : '')} />
            ))}
          </ReviewSection>
        ))}

        {/* Applicants */}
        {(applicants || []).map((a, i) => (
          <ReviewSection key={i} title={`${t('applicant.title', { n: i + 1 })} — ${a.first_name || ''} ${a.last_name || ''}`}>
            <ReviewRow label={t('field.date_of_birth')} value={a.date_of_birth} />
            <ReviewRow label={t('field.gender')} value={a.gender} />
            <ReviewRow label={t('field.nationality')} value={a.nationality_id} />
            <ReviewRow label={t('field.start_date')} value={a.desired_start_date} />
            {(a.previous_schools || []).map((s, si) => (
              <ReviewRow key={si} label={`${t('applicant.prev_school')} ${si + 1}`} value={`${s.school_name || ''} (${s.from_year || ''}–${s.to_year || ''})`} />
            ))}
          </ReviewSection>
        ))}

        {/* Documents */}
        {(documents || []).length > 0 && (
          <ReviewSection title={t('step.documents')}>
            {documents.map((d, i) => (
              <ReviewRow key={i} label={t(`doc.${d.document_type}`) || d.document_type} value={t('doc.uploaded')} />
            ))}
          </ReviewSection>
        )}
      </div>

      {/* Legal / GDPR */}
      <div className="kis-card mt-3">
        <h3 style={{ color: 'var(--teal-dk)', marginTop: 0, fontSize: '1rem' }}>{t('step7.legal_title')}</h3>

        <div className="consent-block">
          <p className="consent-text">
            <strong>EN:</strong> {CONSENT_TEXTS.gdpr.en}
          </p>
          <p className="consent-text">
            <strong>ES:</strong> {CONSENT_TEXTS.gdpr.es}
          </p>
          <div className="form-check">
            <input type="checkbox" className="form-check-input" id="consent_gdpr"
              checked={consentGdpr} onChange={e => setConsentGdpr(e.target.checked)} />
            <label className="form-check-label fw-semibold" htmlFor="consent_gdpr">
              {t('consent.gdpr_accept')}
            </label>
          </div>
        </div>

        <div className="consent-block">
          <p className="consent-text">
            <strong>EN:</strong> {CONSENT_TEXTS.legal.en}
          </p>
          <p className="consent-text">
            <strong>ES:</strong> {CONSENT_TEXTS.legal.es}
          </p>
          <div className="form-check">
            <input type="checkbox" className="form-check-input" id="consent_legal"
              checked={consentLegal} onChange={e => setConsentLegal(e.target.checked)} />
            <label className="form-check-label fw-semibold" htmlFor="consent_legal">
              {t('consent.legal_accept')}
            </label>
          </div>
        </div>

        {/* E-signature */}
        <div className="mt-4">
          <label className="form-label fw-semibold">{t('step7.esig_label')}</label>
          <p style={{ fontSize: '0.85rem', color: 'var(--muted)', marginBottom: 8 }}>
            {t('step7.esig_instructions')}
          </p>
          <input
            type="text"
            className="esig-field"
            value={esig}
            onChange={e => setEsig(e.target.value)}
            placeholder={t('step7.esig_placeholder')}
          />
        </div>
      </div>

      {err && <div className="field-error mt-3 p-3 rounded" style={{ background: '#ffeaea' }}>{err}</div>}

      <div className="d-flex justify-content-between mt-4">
        <button className="btn-secondary-kis" onClick={onBack} disabled={submitting}>
          <i className="bi bi-arrow-left me-1" /> {t('nav.back')}
        </button>
        <button className="btn-primary-kis" onClick={handleSubmit} disabled={submitting}>
          {submitting
            ? <><span className="spinner-border spinner-border-sm me-2" />{t('step7.submitting')}</>
            : <><i className="bi bi-send me-1" />{t('step7.submit')}</>
          }
        </button>
      </div>

      <p style={{ textAlign: 'center', fontSize: '0.75rem', color: 'var(--muted)', marginTop: 12 }}>
        {t('step7.recaptcha_notice')}
      </p>
    </>
  );
}
