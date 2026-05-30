import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useWizard } from '../../context/WizardContext';
import { gasCall, fetchLookups } from '../../api';
import { CONSENT_TEXTS } from '../../consentTexts';
import * as log from '../../logger';

const RECAPTCHA_SITE_KEY = import.meta.env.VITE_RECAPTCHA_SITE_KEY;

// AppSheet returns booleans as "TRUE"/"FALSE" strings — normalise before rendering.
function parseBool(val) {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string')  return val.toLowerCase() === 'true' || val === '1';
  return Boolean(val);
}

// ─── Presentational components ────────────────────────────────────────────────

function SectionCard({ title, icon, children }) {
  return (
    <div className="kis-card mb-3" style={{ padding: '16px 20px' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        marginBottom: 14, paddingBottom: 10,
        borderBottom: '1px solid var(--border)',
      }}>
        {icon && <i className={`bi ${icon}`} style={{ color: 'var(--teal)', fontSize: '1rem' }} />}
        <span style={{ fontWeight: 700, fontSize: '0.92rem', color: 'var(--teal-dk)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          {title}
        </span>
      </div>
      {children}
    </div>
  );
}

function DataRow({ label, value }) {
  if (value === null || value === undefined || value === '' || value === false) return null;
  return (
    <div style={{ display: 'flex', gap: 12, padding: '5px 0', fontSize: '0.88rem', borderBottom: '1px solid var(--bg)' }}>
      <span style={{ color: 'var(--muted)', minWidth: 170, flexShrink: 0 }}>{label}</span>
      <span style={{ color: 'var(--text)', fontWeight: 500 }}>{String(value)}</span>
    </div>
  );
}

function Chip({ children, color }) {
  const bg   = color === 'orange' ? 'var(--orange-lt)' : color === 'red' ? '#fde8e8' : 'var(--teal-lt)';
  const text = color === 'orange' ? 'var(--orange)'   : color === 'red' ? '#c0392b'  : 'var(--teal-dk)';
  return (
    <span style={{
      display: 'inline-block', background: bg, color: text,
      borderRadius: 20, padding: '2px 10px', fontSize: '0.75rem',
      fontWeight: 600, marginRight: 4, marginBottom: 2, lineHeight: 1.6,
    }}>
      {children}
    </span>
  );
}

// ─── reCAPTCHA ────────────────────────────────────────────────────────────────

function loadRecaptcha(siteKey) {
  return new Promise(resolve => {
    if (window.grecaptcha) { resolve(window.grecaptcha); return; }
    const s = document.createElement('script');
    s.src = `https://www.google.com/recaptcha/api.js?render=${siteKey}`;
    s.onload = () => window.grecaptcha.ready(() => resolve(window.grecaptcha));
    document.head.appendChild(s);
  });
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function Step7Review({ onBack }) {
  const { t, i18n }  = useTranslation();
  const navigate     = useNavigate();
  const lang         = i18n.language?.startsWith('en') ? 'en' : 'es';
  const { enrollmentGroupId, resumeToken, stepData, awaitPendingSave, hasPendingSave, isSubmitted } = useWizard();

  const { email, persons, documents, relations, health, questions } = stepData;
  const guardians  = (persons || []).filter(p => p.person_type_id === 'guardian');
  const applicants = (persons || []).filter(p => p.person_type_id === 'applicant');

  // GA relations: have guardian_person_id + applicant_person_id (live or resumed)
  const gaRelations = (relations || []).filter(r =>
    r._kind === 'ga' || (r.guardian_person_id && r.applicant_person_id)
  );

  // Lookup tables — needed to resolve IDs to labels
  const [lookups, setLookups] = useState({
    relationTypes: [], allergies: [], dietary: [], medical: [],
  });
  // Question sets — to resolve qid → question text
  const [questionSets, setQuestionSets] = useState([]);

  useEffect(() => {
    fetchLookups()
      .then(data => setLookups({
        relationTypes: data.relationTypes || [],
        allergies:     data.allergies     || [],
        dietary:       data.dietary       || [],
        medical:       data.medical       || [],
      }))
      .catch(() => {});
    gasCall('fetchQuestions', { context_code: 'ENROLLMENT', language: lang })
      .then(data => setQuestionSets(data.sets || []))
      .catch(() => {});
  }, []); // eslint-disable-line

  const allQuestions = questionSets.flatMap(s => s.questions || []);

  // Resolve a lookup ID to its human-readable label
  const resolveLabel = (list, id) => {
    const found = list.find(x => x.id === id);
    return found ? (found.label || found.id) : (id || '');
  };

  // ─── Submit logic ──────────────────────────────────────────────────────────

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
      if (hasPendingSave) {
        try { await awaitPendingSave(); }
        catch (_) { /* errors already toasted */ }
      }

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

      await gasCall('submitEnrollmentSession', {
        resume_token:        resumeToken, // KAL-4: required for IDOR defense
        enrollment_group_id: enrollmentGroupId,
        application_id:      enrollmentGroupId,
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

  // ─── Render helpers ────────────────────────────────────────────────────────

  function renderGuardian(g, idx) {
    return (
      <SectionCard
        key={g.person_id || g._uid || idx}
        title={`${t('guardian.title', { n: idx + 1 })} — ${[g.first_name, g.last_name].filter(Boolean).join(' ')}`}
        icon="bi-person-fill"
      >
        <DataRow label={t('field.first_name')}    value={g.first_name} />
        <DataRow label={t('field.middle_name')}   value={g.middle_name} />
        <DataRow label={t('field.last_name')}     value={g.last_name} />
        <DataRow label={t('field.date_of_birth')} value={g.date_of_birth} />
        <DataRow label={t('field.place_of_birth')}value={g.place_of_birth} />
        <DataRow label={t('field.nationality')}   value={g.nationalities?.[0]?.country_id} />
        {g.ids?.[0] && (
          <DataRow label={t('field.id_number')} value={`${g.ids[0].id_type_id}: ${g.ids[0].id_number}`} />
        )}
        <DataRow label={t('field.address_line_1')} value={g.address?.address_line_1} />
        <DataRow label={t('field.address_line_2')} value={g.address?.address_line_2} />
        <DataRow label={t('field.city')}           value={g.address?.city} />
        <DataRow label={t('field.province')}       value={g.address?.province} />
        <DataRow label={t('field.zip')}            value={g.address?.zip} />
        <DataRow label={t('field.country')}        value={g.address?.country_id} />

        {(g.emails || []).map((e, ei) => {
          const addr = e.email_address || e.value || '';
          if (!addr) return null;
          const typeKey = `email_type.${e.email_type_id || e.type}`;
          const typeLabel = e.email_type_id && i18n.exists(typeKey) ? t(typeKey) : e.email_type_id || '';
          return (
            <div key={ei} style={{ display: 'flex', gap: 12, padding: '5px 0', fontSize: '0.88rem', borderBottom: '1px solid var(--bg)', alignItems: 'center' }}>
              <span style={{ color: 'var(--muted)', minWidth: 170, flexShrink: 0 }}>{t('contact.email')}</span>
              <span style={{ color: 'var(--text)', fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                {addr}
                {typeLabel              && <Chip>{typeLabel}</Chip>}
                {parseBool(e.is_default)   && <Chip>{t('contact.is_default')}</Chip>}
                {parseBool(e.is_emergency) && <Chip color="orange">{t('contact.is_emergency')}</Chip>}
              </span>
            </div>
          );
        })}

        {(g.phones || []).map((ph, pi) => {
          const num = ph.phone_number || ph.value || '';
          if (!num) return null;
          const typeKey = `phone_type.${ph.phone_type_id || ph.phone_nr_type_id}`;
          const typeLabel = (ph.phone_type_id || ph.phone_nr_type_id) && i18n.exists(typeKey) ? t(typeKey) : (ph.phone_type_id || ph.phone_nr_type_id || '');
          return (
            <div key={pi} style={{ display: 'flex', gap: 12, padding: '5px 0', fontSize: '0.88rem', borderBottom: '1px solid var(--bg)', alignItems: 'center' }}>
              <span style={{ color: 'var(--muted)', minWidth: 170, flexShrink: 0 }}>{t('contact.phone')}</span>
              <span style={{ color: 'var(--text)', fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                {num}
                {typeLabel                  && <Chip>{typeLabel}</Chip>}
                {parseBool(ph.is_whatsapp)   && <Chip>WhatsApp</Chip>}
                {parseBool(ph.is_telegram)   && <Chip>Telegram</Chip>}
                {parseBool(ph.is_default)    && <Chip>{t('contact.is_default')}</Chip>}
                {parseBool(ph.is_emergency)  && <Chip color="orange">{t('contact.is_emergency')}</Chip>}
              </span>
            </div>
          );
        })}
      </SectionCard>
    );
  }

  function renderApplicant(a, idx) {
    return (
      <SectionCard
        key={a.person_id || a._uid || idx}
        title={`${t('applicant.title', { n: idx + 1 })} — ${[a.first_name, a.last_name].filter(Boolean).join(' ')}`}
        icon="bi-person-hearts"
      >
        <DataRow label={t('field.first_name')}    value={a.first_name} />
        <DataRow label={t('field.middle_name')}   value={a.middle_name} />
        <DataRow label={t('field.last_name')}     value={a.last_name} />
        <DataRow label={t('field.date_of_birth')} value={a.date_of_birth} />
        <DataRow label={t('field.place_of_birth')}value={a.place_of_birth} />
        <DataRow label={t('field.gender')}        value={a.gender} />
        <DataRow label={t('field.nationality')}   value={a.nationalities?.[0]?.country_id} />
        <DataRow label={t('field.mother_tongue')} value={a.mother_tongue} />
        <DataRow label={t('field.start_date')}    value={email?.desired_start_date} />
        {(a.previous_schools || []).map((s, si) => (
          <div key={si} style={{ padding: '8px 0 4px', borderBottom: '1px solid var(--bg)' }}>
            <div style={{ display: 'flex', gap: 12, fontSize: '0.88rem' }}>
              <span style={{ color: 'var(--muted)', minWidth: 170, flexShrink: 0 }}>{t('applicant.prev_school')} {si + 1}</span>
              <span style={{ color: 'var(--text)', fontWeight: 500 }}>{s.school_name || '—'}</span>
            </div>
            {(s.from_year || s.to_year) && (
              <div style={{ display: 'flex', gap: 12, fontSize: '0.84rem', marginTop: 2 }}>
                <span style={{ minWidth: 170, flexShrink: 0 }} />
                <span style={{ color: 'var(--muted)' }}>
                  {s.from_year && `${t('field.from_year')}: ${s.from_year}`}
                  {s.from_year && s.to_year && ' · '}
                  {s.to_year && `${t('field.to_year')}: ${s.to_year}`}
                  {s.city && ` · ${s.city}`}
                  {s.country_id && ` (${s.country_id})`}
                </span>
              </div>
            )}
            {(s.education_level_description || s.language_of_instruction) && (
              <div style={{ display: 'flex', gap: 12, fontSize: '0.84rem', marginTop: 2 }}>
                <span style={{ minWidth: 170, flexShrink: 0 }} />
                <span style={{ color: 'var(--muted)' }}>
                  {s.education_level_description && `${t('field.edu_level_desc')}: ${s.education_level_description}`}
                  {s.education_level_description && s.language_of_instruction && ' · '}
                  {s.language_of_instruction && `${t('field.lang_instruction')}: ${s.language_of_instruction}`}
                </span>
              </div>
            )}
          </div>
        ))}
      </SectionCard>
    );
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <div className="mb-3">
        <h2 style={{ color: 'var(--teal-dk)', fontWeight: 800 }}>{t('step.review')}</h2>
        <p style={{ color: 'var(--muted)' }}>{t('step7.subtitle')}</p>
      </div>

      {/* ── Email / Start Date ── */}
      <SectionCard title={t('review.email')} icon="bi-envelope-fill">
        <DataRow label={t('field.primary_email')} value={email?.primary_email} />
        <DataRow label={t('review.verified')} value={email?.verified ? t('yes') : t('no')} />
        <DataRow label={t('field.start_date')} value={email?.desired_start_date} />
      </SectionCard>

      {/* ── Guardians ── */}
      {guardians.map((g, i) => renderGuardian(g, i))}

      {/* ── Applicants ── */}
      {applicants.map((a, i) => renderApplicant(a, i))}

      {/* ── Relations ── */}
      {gaRelations.length > 0 && (
        <SectionCard title={t('step.relations')} icon="bi-diagram-3-fill">
          {gaRelations.map((r, i) => {
            const gId = r.guardian_person_id || r.person_id_a;
            const aId = r.applicant_person_id || r.person_id_b;
            const g = (persons || []).find(p => (p.person_id || p._uid) === gId);
            const a = (persons || []).find(p => (p.person_id || p._uid) === aId);
            if (!g || !a) return null;
            const gName = [g.first_name, g.last_name].filter(Boolean).join(' ');
            const aName = [a.first_name, a.last_name].filter(Boolean).join(' ');
            const relLabel = r.relation_type_id
              ? resolveLabel(lookups.relationTypes, r.relation_type_id)
              : '—';
            return (
              <div key={i} style={{ display: 'flex', gap: 12, padding: '7px 0', fontSize: '0.88rem', borderBottom: '1px solid var(--bg)', alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ color: 'var(--text)', fontWeight: 600, minWidth: 0 }}>
                  {gName}
                  <span style={{ color: 'var(--muted)', fontWeight: 400 }}> → </span>
                  {aName}
                </span>
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {relLabel                            && <Chip>{relLabel}</Chip>}
                  {parseBool(r.is_custodial)          && <Chip>{t('relation.is_custodial')}</Chip>}
                  {parseBool(r.is_pick_up_authorized) && <Chip>{t('relation.is_pickup')}</Chip>}
                </span>
              </div>
            );
          })}
        </SectionCard>
      )}

      {/* ── Health ── */}
      {(health || []).some(h => h.allergies?.length || h.dietary?.length || h.medical?.length) && (
        <SectionCard title={t('step.health')} icon="bi-heart-pulse-fill">
          {(health || []).map((h, hi) => {
            const applicant = (persons || []).find(p => (p.person_id || p._uid) === h.person_id);
            const name = applicant
              ? [applicant.first_name, applicant.last_name].filter(Boolean).join(' ')
              : null;
            const hasAny = h.allergies?.length || h.dietary?.length || h.medical?.length;
            if (!hasAny) return null;
            return (
              <div key={hi} style={{ marginBottom: hi < (health || []).length - 1 ? 14 : 0 }}>
                {name && applicants.length > 1 && (
                  <p style={{ fontWeight: 700, fontSize: '0.85rem', color: 'var(--teal-dk)', marginBottom: 6, marginTop: hi > 0 ? 4 : 0 }}>
                    {name}
                  </p>
                )}
                {(h.allergies || []).length > 0 && (
                  <div style={{ display: 'flex', gap: 8, padding: '5px 0', fontSize: '0.88rem', borderBottom: '1px solid var(--bg)', alignItems: 'flex-start' }}>
                    <span style={{ color: 'var(--muted)', minWidth: 170, flexShrink: 0 }}>{t('health.allergies')}</span>
                    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {h.allergies.map((a, ai) => {
                        const label = a.label || resolveLabel(lookups.allergies, a.food_allergy_id);
                        return (
                          <Chip key={ai} color="red">
                            {label}{a.observations ? ` — ${a.observations}` : ''}
                          </Chip>
                        );
                      })}
                    </span>
                  </div>
                )}
                {(h.dietary || []).length > 0 && (
                  <div style={{ display: 'flex', gap: 8, padding: '5px 0', fontSize: '0.88rem', borderBottom: '1px solid var(--bg)', alignItems: 'flex-start' }}>
                    <span style={{ color: 'var(--muted)', minWidth: 170, flexShrink: 0 }}>{t('health.dietary')}</span>
                    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {h.dietary.map((d, di) => {
                        const label = d.label || resolveLabel(lookups.dietary, d.diet_id);
                        return (
                          <Chip key={di} color="orange">
                            {label}{d.observations ? ` — ${d.observations}` : ''}
                          </Chip>
                        );
                      })}
                    </span>
                  </div>
                )}
                {(h.medical || []).length > 0 && (
                  <div style={{ display: 'flex', gap: 8, padding: '5px 0', fontSize: '0.88rem', borderBottom: '1px solid var(--bg)', alignItems: 'flex-start' }}>
                    <span style={{ color: 'var(--muted)', minWidth: 170, flexShrink: 0 }}>{t('health.medical')}</span>
                    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {h.medical.map((m, mi) => {
                        const label = m.label || resolveLabel(lookups.medical, m.medical_condition_id);
                        return (
                          <Chip key={mi}>
                            {label}{m.observations ? ` — ${m.observations}` : ''}
                          </Chip>
                        );
                      })}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </SectionCard>
      )}

      {/* ── Questions ──
          DL-Q05 Q05-S3 decision: NOT migrated to <QbSetRenderer readOnly />.
          The review pane renders a flat list of "label + value" rows inside a
          single SectionCard, skipping empty responses. The shared renderer
          fans out per audience + person and emits one .kis-card per set,
          which clashes with the review layout. Keeping the dedicated DataRow
          path here is shorter than rebuilding that summary on top of the
          renderer's per-input markup. */}
      {allQuestions.length > 0 && Object.keys(questions || {}).length > 0 && (
        <SectionCard title={t('step.questions')} icon="bi-chat-square-text-fill">
          {Object.entries(questions || {}).map(([key, val], i) => {
            if (val === '' || val === null || val === undefined || val === false) return null;
            const [qid] = key.split('__');
            const q = allQuestions.find(qq => qq.question_id === qid);
            if (!q) return null;
            const displayVal = Array.isArray(val) ? val.join(', ') : String(val);
            return <DataRow key={i} label={q.question_text || qid} value={displayVal} />;
          })}
        </SectionCard>
      )}

      {/* ── Documents ── */}
      {(documents || []).length > 0 && (
        <SectionCard title={t('step.documents')} icon="bi-folder-fill">
          {documents.map((d, i) => {
            const docKey = `doc.${d.document_type}`;
            const label = i18n.exists(docKey) ? t(docKey) : d.document_type;
            return (
              <div key={i} style={{ display: 'flex', gap: 12, padding: '5px 0', fontSize: '0.88rem', borderBottom: '1px solid var(--bg)', alignItems: 'center' }}>
                <span style={{ color: 'var(--muted)', minWidth: 170, flexShrink: 0 }}>{label}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <i className="bi bi-check-circle-fill" style={{ color: '#2e7d32', fontSize: '0.9rem' }} />
                  <span style={{ color: 'var(--text)', fontWeight: 500 }}>{t('doc.uploaded')}</span>
                  {d.drive_url && (
                    <a href={d.drive_url} target="_blank" rel="noreferrer"
                      style={{ fontSize: '0.8rem', color: 'var(--teal-dk)' }}>
                      <i className="bi bi-box-arrow-up-right ms-1" />
                    </a>
                  )}
                </span>
              </div>
            );
          })}
        </SectionCard>
      )}

      {isSubmitted ? (
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
          <div className="kis-card mt-3" style={{ textAlign: 'left' }}>
            <h3 style={{ color: 'var(--teal-dk)', marginTop: 0, fontSize: '1rem' }}>
              {t('confirmation.next_steps_title')}
            </h3>
            <ul style={{ color: 'var(--text)', lineHeight: 1.8, paddingLeft: 20, marginBottom: 0 }}>
              <li>{t('confirmation.next_1')}</li>
              <li>{t('confirmation.next_2')}</li>
              <li>{t('confirmation.next_3')}</li>
            </ul>
          </div>
          <div className="d-flex mt-4">
            <button className="btn-secondary-kis" onClick={onBack}>
              <i className="bi bi-arrow-left me-1" /> {t('nav.back')}
            </button>
          </div>
        </>
      ) : (
        <>
          <div className="kis-card mt-3">
            <h3 style={{ color: 'var(--teal-dk)', marginTop: 0, fontSize: '1rem' }}>{t('step7.legal_title')}</h3>

            <div className="consent-block">
              <p className="consent-text"><strong>EN:</strong> {CONSENT_TEXTS.gdpr.en}</p>
              <p className="consent-text"><strong>ES:</strong> {CONSENT_TEXTS.gdpr.es}</p>
              <div className="form-check">
                <input type="checkbox" className="form-check-input" id="consent_gdpr"
                  checked={consentGdpr} onChange={e => setConsentGdpr(e.target.checked)} />
                <label className="form-check-label fw-semibold" htmlFor="consent_gdpr">
                  {t('consent.gdpr_accept')}
                </label>
              </div>
            </div>

            <div className="consent-block">
              <p className="consent-text"><strong>EN:</strong> {CONSENT_TEXTS.legal.en}</p>
              <p className="consent-text"><strong>ES:</strong> {CONSENT_TEXTS.legal.es}</p>
              <div className="form-check">
                <input type="checkbox" className="form-check-input" id="consent_legal"
                  checked={consentLegal} onChange={e => setConsentLegal(e.target.checked)} />
                <label className="form-check-label fw-semibold" htmlFor="consent_legal">
                  {t('consent.legal_accept')}
                </label>
              </div>
            </div>

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
