import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useWizard } from '../../context/WizardContext';
import { fetchLookups } from '../../api';
import LockedBanner from '../../components/LockedBanner';
import StepUpReverify from '../../components/StepUpReverify';
import * as log from '../../logger';

function TagSelect({ options, selected, onChange, placeholder }) {
  const [input,   setInput]   = useState('');
  const [focused, setFocused] = useState(false);
  const available    = options.filter(o => !selected.find(s => s.id === o.id));
  const filtered     = available.filter(o => o.label.toLowerCase().includes(input.toLowerCase()));
  const showDropdown = focused && filtered.length > 0;
  return (
    <div>
      <div className="input-group input-group-sm">
        <input
          className="form-control"
          value={input}
          onChange={e => setInput(e.target.value)}
          onFocus={() => setFocused(true)}
          onBlur={() => setFocused(false)}
          placeholder={placeholder}
        />
      </div>
      {showDropdown && (
        <div className="border rounded mt-1" style={{ maxHeight: 180, overflowY: 'auto' }}>
          {filtered.map(o => (
            <div key={o.id} className="px-3 py-1" style={{ cursor: 'pointer' }}
              onMouseDown={e => { e.preventDefault(); onChange([...selected, o]); setInput(''); }}>
              {o.label}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function SelectedItemRows({ items, onRemove, onObservationChange, observationsPlaceholder }) {
  if (!items.length) return null;
  return (
    <div className="mt-2 d-flex flex-column gap-2">
      {items.map((item, i) => (
        <div key={item.id || i} className="d-flex align-items-center gap-2">
          <span className="badge d-flex align-items-center gap-1 flex-shrink-0"
            style={{ background: 'var(--teal-lt)', color: 'var(--teal-dk)', padding: '5px 10px', borderRadius: 20 }}>
            {item.label}
            <button onClick={() => onRemove(i)}
              style={{ background: 'none', border: 'none', color: 'var(--teal-dk)', cursor: 'pointer', padding: 0, fontSize: '0.8rem', lineHeight: 1 }}>
              &times;
            </button>
          </span>
          <input className="form-control form-control-sm" placeholder={observationsPlaceholder}
            value={item.observations || ''}
            onChange={e => onObservationChange(i, e.target.value)} />
        </div>
      ))}
    </div>
  );
}

function ApplicantHealthSection({ applicant, health, onChange, allergiesOpts, dietaryOpts, medicalOpts }) {
  const { t } = useTranslation();
  const name = [applicant.first_name, applicant.last_name].filter(Boolean).join(' ') || t('applicant.unnamed');

  const update = (field, val) => onChange({ ...health, [field]: val });

  const allergiesSelected = (health.allergies || []).map(a => { const opt = allergiesOpts.find(o => o.id === (a.food_allergy_id || a._uid)); return { id: a.food_allergy_id || a._uid, label: a.label || opt?.label || a.food_allergy_id, observations: a.observations || '' }; });
  const dietarySelected   = (health.dietary   || []).map(d => { const opt = dietaryOpts.find(o => o.id === (d.diet_id || d._uid));                return { id: d.diet_id || d._uid,                   label: d.label || opt?.label || d.diet_id,           observations: d.observations || '' }; });
  const medicalSelected   = (health.medical   || []).map(m => { const opt = medicalOpts.find(o => o.id === (m.medical_condition_id || m._uid));    return { id: m.medical_condition_id || m._uid,         label: m.label || opt?.label || m.medical_condition_id, observations: m.observations || '' }; });

  return (
    <div className="dynamic-section">
      <div className="dynamic-section-title mb-3">{name}</div>

      <div className="mb-3">
        <label className="form-label fw-semibold">{t('health.allergies')}</label>
        <TagSelect
          options={allergiesOpts}
          selected={allergiesSelected}
          onChange={sel => update('allergies', sel.map(s => ({ food_allergy_id: s.id, label: s.label, observations: (health.allergies || []).find(x => x.food_allergy_id === s.id)?.observations || '' })))}
          placeholder={t('health.search_allergies')}
        />
        <SelectedItemRows
          items={allergiesSelected}
          observationsPlaceholder={t('health.observations')}
          onRemove={i => update('allergies', (health.allergies || []).filter((_, j) => j !== i))}
          onObservationChange={(i, val) => {
            const next = [...(health.allergies || [])];
            next[i] = { ...next[i], observations: val };
            update('allergies', next);
          }}
        />
      </div>

      <div className="mb-3">
        <label className="form-label fw-semibold">{t('health.dietary')}</label>
        <TagSelect
          options={dietaryOpts}
          selected={dietarySelected}
          onChange={sel => update('dietary', sel.map(s => ({ diet_id: s.id, label: s.label, observations: (health.dietary || []).find(x => x.diet_id === s.id)?.observations || '' })))}
          placeholder={t('health.search_dietary')}
        />
        <SelectedItemRows
          items={dietarySelected}
          observationsPlaceholder={t('health.observations')}
          onRemove={i => update('dietary', (health.dietary || []).filter((_, j) => j !== i))}
          onObservationChange={(i, val) => {
            const next = [...(health.dietary || [])];
            next[i] = { ...next[i], observations: val };
            update('dietary', next);
          }}
        />
      </div>

      <div className="mb-3">
        <label className="form-label fw-semibold">{t('health.medical')}</label>
        <TagSelect
          options={medicalOpts}
          selected={medicalSelected}
          onChange={sel => update('medical', sel.map(s => ({ medical_condition_id: s.id, label: s.label, observations: (health.medical || []).find(x => x.medical_condition_id === s.id)?.observations || '' })))}
          placeholder={t('health.search_medical')}
        />
        <SelectedItemRows
          items={medicalSelected}
          observationsPlaceholder={t('health.observations')}
          onRemove={i => update('medical', (health.medical || []).filter((_, j) => j !== i))}
          onObservationChange={(i, val) => {
            const next = [...(health.medical || [])];
            next[i] = { ...next[i], observations: val };
            update('medical', next);
          }}
        />
      </div>
    </div>
  );
}

export default function Step4Health({ onNext, onBack, locked, onUnlock, savePending }) {
  const { t } = useTranslation();
  const {
    stepData, updateStep, resumeToken,
    isStepUpFresh, markStepUpFresh, touchActivity,
  } = useWizard();
  const applicants = (stepData.persons || []).filter(p => p.person_type_id === 'applicant');

  // DL-E39 PII-primero: los datos de salud son Art.9 RGPD (la exposición más
  // sensible). OCULTOS por completo salvo step-up fresco — no enmascarado
  // parcial, ocultación total tras un cartel "verifica para ver".
  const healthRevealed = isStepUpFresh();
  const [revealRequested, setRevealRequested] = useState(false);

  const [highlightEdit, setHighlightEdit] = useState(false);
  const [healthData, setHealthData] = useState(() =>
    applicants.map(a => {
      const existing = (stepData.health || []).find(h => h.person_id === (a.person_id || a._uid));
      return existing || { person_id: a.person_id || a._uid, allergies: [], dietary: [], medical: [] };
    })
  );

  // Re-sync if stepData.health arrives after mount (e.g. after rehydration from server)
  useEffect(() => {
    if (!stepData.health?.length) return;
    setHealthData(
      (stepData.persons || [])
        .filter(p => p.person_type_id === 'applicant')
        .map(a => {
          const existing = stepData.health.find(h => h.person_id === (a.person_id || a._uid));
          return existing || { person_id: a.person_id || a._uid, allergies: [], dietary: [], medical: [] };
        })
    );
  }, [stepData.health]); // eslint-disable-line

  const [allergiesOpts, setAllergiesOpts] = useState([]);
  const [dietaryOpts,   setDietaryOpts]   = useState([]);
  const [medicalOpts,   setMedicalOpts]   = useState([]);

  useEffect(() => {
    fetchLookups()
      .then(data => {
        setAllergiesOpts(data.allergies || []);
        setDietaryOpts(data.dietary   || []);
        setMedicalOpts(data.medical   || []);
      })
      .catch(() => {});
  }, []);

  const updateHealth = (i, val) => {
    const next = [...healthData];
    next[i] = val;
    setHealthData(next);
  };

  const handleBack = () => {
    updateStep('health', healthData);
    onBack();
  };

  const handleNext = () => {
    log.info('Step4: onNext health', healthData);
    updateStep('health', healthData);
    onNext('health', healthData);
  };

  return (
    <>
      <div className="mb-2">
        <h2 style={{ color: 'var(--teal-dk)', fontWeight: 800 }}>{t('step.health')}</h2>
        <p style={{ color: 'var(--muted)' }}>{t('step4.subtitle')}</p>
      </div>

      {locked && <LockedBanner onUnlock={onUnlock} highlight={highlightEdit} />}

      {/* DL-E39 PII-primero: salud Art.9 oculta hasta step-up fresco. */}
      {!healthRevealed ? (
        <div className="kis-card" style={{ background: 'var(--bg)' }}>
          <div className="d-flex align-items-start gap-2">
            <i className="bi bi-heart-pulse" style={{ fontSize: '1.4rem', color: 'var(--teal-dk)' }} />
            <div className="flex-grow-1">
              <strong style={{ fontSize: '0.95rem' }}>{t('stepup.health_masked_title')}</strong>
              <p className="mb-2" style={{ fontSize: '0.86rem', color: 'var(--muted)' }}>{t('stepup.health_masked_body')}</p>
              {!revealRequested ? (
                <button type="button" className="btn btn-outline-primary btn-sm"
                  onClick={() => setRevealRequested(true)}>
                  <i className="bi bi-eye me-1" />{t('stepup.reveal')}
                </button>
              ) : (
                <StepUpReverify
                  tokenPayload={{ resume_token: resumeToken }}
                  onVerified={() => { markStepUpFresh(); setRevealRequested(false); }}
                  prompt={t('stepup.health_reveal_prompt')}
                />
              )}
            </div>
          </div>
        </div>
      ) : (
      <div onClick={locked ? () => { setHighlightEdit(true); setTimeout(() => setHighlightEdit(false), 600); } : touchActivity}>
      <fieldset disabled={locked} style={{ border: 'none', padding: 0, margin: 0, pointerEvents: locked ? 'none' : undefined }}>
        {applicants.map((a, i) => (
          <ApplicantHealthSection
            key={a.person_id || a._uid || i}
            applicant={a}
            health={healthData[i] || { allergies: [], dietary: [], medical: [] }}
            onChange={val => updateHealth(i, val)}
            allergiesOpts={allergiesOpts}
            dietaryOpts={dietaryOpts}
            medicalOpts={medicalOpts}
          />
        ))}

        {applicants.length === 0 && (
          <div className="text-center py-4" style={{ color: 'var(--muted)' }}>
            {t('step4.no_applicants')}
          </div>
        )}
      </fieldset>
      </div>
      )}

      <div className="d-flex justify-content-between mt-4">
        <button className="btn-secondary-kis" onClick={handleBack}>
          <i className="bi bi-arrow-left me-1" /> {t('nav.back')}
        </button>
        <button className="btn-primary-kis" onClick={handleNext} disabled={savePending}>
          {savePending
            ? <><span className="spinner-border spinner-border-sm me-1" style={{ width: '0.9em', height: '0.9em', borderWidth: '0.12em' }} />{t('wizard.saving_in_background')}</>
            : <>{t('nav.continue')} <i className="bi bi-arrow-right ms-1" /></>
          }
        </button>
      </div>
    </>
  );
}
