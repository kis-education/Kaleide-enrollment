import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useWizard } from '../../context/WizardContext';
import { gasCall } from '../../api';
import { CONSENT_TEXTS } from '../../consentTexts';
import * as log from '../../logger';

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
  const { enrollmentGroupId, stepData, awaitPendingSave, hasPendingSave, isSubmitted } = useWizard();

  const { email, persons, documents, relations, health, questions } = stepData;
  const guardians  = (persons || []).filter(p => p.person_type_id === 'guardian');
  const applicants = (persons || []).filter(p => p.person_type_id === 'applicant');

  const [questionSets, setQuestionSets] = useState([]);
  useEffect(() => {
    gasCall('fetchQuestions', { context_designation: 'Enrollment', language: lang })
      .then(data => setQuestionSets(data.sets || []))
      .catch(() => {});
  }, []); // eslint-disable-line
  const allQuestions = questionSets.flatMap(s => s.questions || []);

  const gaRelations = (relations || []).filter(r =>
    r._kind === 'ga' || (r.guardian_person_id && r.applicant_person_id)
  );

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
    log.info('Step7: handleSubmit — submitting enrollment', { enrollmentGroupId, hasPendingSave, esig: esig.trim() ? '[signed]' : '[empty]' });

    try {
      // Drain any background save still in flight from Step 6 (or earlier).
      // The optimistic-UI pattern (handleNext) doesn't await saves before
      // advancing — submit IS the natural sync point where we MUST have
      // all data persisted before sending the final action.
      if (hasPendingSave) {
        try { await awaitPendingSave(); }
        catch (_) { /* errors already toasted; submit proceeds with whatever was last saved */ }
      }

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

      // Backend post-DL-E15: action `submitEnrollmentSession`, payload uses
      // `enrollment_group_id`; legacy `application_id` is accepted as alias
      // during the transitional period.
      await gasCall('submitEnrollmentSession', {
        enrollment_group_id: enrollmentGroupId,
        application_id:      enrollmentGroupId, // legacy alias
        desired_start_date:  email?.desired_start_date || null,
        program_id:          email?.program_id         || null,
        esignature:          esig,
        language:            lang,
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
        {guardians.map((g, i) => (
          <ReviewSection key={i} title={`${t('guardian.title', { n: i + 1 })} — ${g.first_name || ''} ${g.last_name || ''}`}>
            <ReviewRow label={t('field.date_of_birth')} value={g.date_of_birth} />
            <ReviewRow label={t('field.middle_name')} value={g.middle_name} />
            <ReviewRow label={t('field.place_of_birth')} value={g.place_of_birth} />
            <ReviewRow label={t('field.nationality')} value={g.nationalities?.[0]?.country_id} />
            <ReviewRow label={t('field.id_number')} value={g.ids?.[0] ? `${g.ids[0].id_type_id}: ${g.ids[0].id_number}` : null} />
            <ReviewRow label={t('field.address_line_1')} value={g.address?.address_line_1} />
            <ReviewRow label={t('field.address_line_2')} value={g.address?.address_line_2} />
            <ReviewRow label={t('field.city')} value={g.address?.city} />
            <ReviewRow label={t('field.province')} value={g.address?.province} />
            <ReviewRow label={t('field.zip')} value={g.address?.zip} />
            <ReviewRow label={t('field.country')} value={g.address?.country_id} />
            {(g.emails || []).map((e, ei) => (
              <ReviewRow key={ei} label={t('contact.email')} value={e.email_address || e.value} />
            ))}
            {(g.phones || []).map((ph, pi) => {
              const num = ph.phone_number || ph.value || '';
              return (
                <ReviewRow key={pi} label={t('contact.phone')} value={num + (ph.is_whatsapp ? ' (WhatsApp)' : '') + (ph.is_telegram ? ' (Telegram)' : '')} />
              );
            })}
          </ReviewSection>
        ))}

        {/* Applicants */}
        {applicants.map((a, i) => (
          <ReviewSection key={i} title={`${t('applicant.title', { n: i + 1 })} — ${a.first_name || ''} ${a.last_name || ''}`}>
            <ReviewRow label={t('field.middle_name')} value={a.middle_name} />
            <ReviewRow label={t('field.date_of_birth')} value={a.date_of_birth} />
            <ReviewRow label={t('field.place_of_birth')} value={a.place_of_birth} />
            <ReviewRow label={t('field.gender')} value={a.gender} />
            <ReviewRow label={t('field.nationality')} value={a.nationalities?.[0]?.country_id} />
            <ReviewRow label={t('field.mother_tongue')} value={a.mother_tongue} />
            <ReviewRow label={t('field.start_date')} value={email?.desired_start_date} />
            {(a.previous_schools || []).map((s, si) => (
              <ReviewRow key={si} label={`${t('applicant.prev_school')} ${si + 1}`} value={`${s.school_name || ''} (${s.from_year || ''}–${s.to_year || ''})`} />
            ))}
          </ReviewSection>
        ))}

        {/* Relations */}
        {gaRelations.length > 0 && (
          <ReviewSection title={t('step.relations')}>
            {gaRelations.map((r, i) => {
              const gId = r.guardian_person_id || r.person_id_a;
              const aId = r.applicant_person_id || r.person_id_b;
              const g = (persons || []).find(p => (p.person_id || p._uid) === gId);
              const a = (persons || []).find(p => (p.person_id || p._uid) === aId);
              if (!g || !a) return null;
              const gName = [g.first_name, g.last_name].filter(Boolean).join(' ');
              const aName = [a.first_name, a.last_name].filter(Boolean).join(' ');
              const relTypeKey = `relation.${r.relation_type_id}`;
              const relLabel = r.relation_type_id
                ? (i18n.exists(relTypeKey) ? t(relTypeKey) : r.relation_type_id)
                : '—';
              const flags = [
                r.is_custodial         && t('relation.is_custodial'),
                r.is_pick_up_authorized && t('relation.is_pickup'),
              ].filter(Boolean).join(' · ');
              return (
                <ReviewRow key={i}
                  label={`${gName} → ${aName}`}
                  value={relLabel + (flags ? ` (${flags})` : '')} />
              );
            })}
          </ReviewSection>
        )}

        {/* Health */}
        {(health || []).some(h => h.allergies?.length || h.dietary?.length || h.medical?.length) && (
          <ReviewSection title={t('step.health')}>
            {(health || []).map((h, hi) => {
              const applicant = (persons || []).find(p => (p.person_id || p._uid) === h.person_id);
              const name = applicant
                ? [applicant.first_name, applicant.last_name].filter(Boolean).join(' ')
                : null;
              const hasAny = h.allergies?.length || h.dietary?.length || h.medical?.length;
              if (!hasAny) return null;
              return (
                <div key={hi}>
                  {name && (
                    <p className="fw-semibold mb-1" style={{ fontSize: '0.9rem', color: 'var(--teal-dk)', marginTop: hi > 0 ? 8 : 0 }}>
                      {name}
                    </p>
                  )}
                  {(h.allergies || []).map((a, ai) => (
                    <ReviewRow key={`a${ai}`} label={t('health.allergies')}
                      value={a.label + (a.observations ? ` — ${a.observations}` : '')} />
                  ))}
                  {(h.dietary || []).map((d, di) => (
                    <ReviewRow key={`d${di}`} label={t('health.dietary')}
                      value={d.label + (d.observations ? ` — ${d.observations}` : '')} />
                  ))}
                  {(h.medical || []).map((m, mi) => (
                    <ReviewRow key={`m${mi}`} label={t('health.medical')}
                      value={m.label + (m.observations ? ` — ${m.observations}` : '')} />
                  ))}
                </div>
              );
            })}
          </ReviewSection>
        )}

        {/* Questions */}
        {allQuestions.length > 0 && Object.keys(questions || {}).length > 0 && (
          <ReviewSection title={t('step.questions')}>
            {Object.entries(questions || {}).map(([key, val], i) => {
              if (val === '' || val === null || val === undefined) return null;
              const [qid] = key.split('__');
              const q = allQuestions.find(qq => qq.question_id === qid);
              if (!q) return null;
              const displayVal = Array.isArray(val) ? val.join(', ') : String(val);
              return <ReviewRow key={i} label={q.question_text || qid} value={displayVal} />;
            })}
          </ReviewSection>
        )}

        {/* Documents */}
        {(documents || []).length > 0 && (
          <ReviewSection title={t('step.documents')}>
            {documents.map((d, i) => {
              const docKey = `doc.${d.document_type}`;
              return (
                <ReviewRow key={i} label={i18n.exists(docKey) ? t(docKey) : d.document_type} value={t('doc.uploaded')} />
              );
            })}
          </ReviewSection>
        )}
      </div>

      {isSubmitted ? (
        /* Read-only mode: application already submitted */
        <>
          <div className="kis-card mt-3" style={{ textAlign: 'center', padding: '32px 20px' }}>
            <i className="bi bi-check-circle-fill" style={{ fontSize: '2.8rem', color: '#2e7d32' }} />
            <h3 style={{ color: '#1b5e20', marginTop: 16, marginBottom: 8 }}>
              {t('step7.submitted_title')}
            </h3>
            <p style={{ color: '#2e4a2f', marginBottom: 0, maxWidth: 440, margin: '0 auto' }}>
              {t('step7.submitted_note')}
            </p>
          </div>
          <div className="d-flex mt-4">
            <button className="btn-secondary-kis" onClick={onBack}>
              <i className="bi bi-arrow-left me-1" /> {t('nav.back')}
            </button>
          </div>
        </>
      ) : (
        /* Active mode: consent form + submit */
        <>
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
      )}
    </>
  );
}
