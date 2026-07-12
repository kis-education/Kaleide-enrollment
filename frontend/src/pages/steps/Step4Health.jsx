import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useWizard } from '../../context/WizardContext';
import { fetchLookups, saveNeae } from '../../api';
import LockedBanner from '../../components/LockedBanner';
import StepNav from '../../components/StepNav';
import * as log from '../../logger';

// ── NEAE enums (fixed catalogues; design kis-app neae-module-2026-07-12.md) ──
// El staging siempre escribe provenance=FAMILY_DECLARED server-side. Q4
// (willing_to_share_reports) retirada por decisión de Diego 2026-07-12.
const NEAE_CATEGORIES = ['ASD', 'GIFTED', 'ADHD', 'SLD', 'DEVELOPMENTAL_DELAY', 'SENSORY', 'MOTOR', 'LANGUAGE', 'OTHER'];
const NEAE_DIAGNOSIS  = ['NONE', 'SUSPECTED', 'IN_EVALUATION', 'DIAGNOSED'];
const NEAE_SUPPORTS   = ['PT', 'AL', 'LOGOPEDIA', 'OT', 'PSYCHOPEDAGOGICAL', 'TALENT', 'EXTERNAL_PSYCH', 'OTHER'];
const NEAE_SCOPES     = ['PRIOR_SCHOOL', 'EXTERNAL_CURRENT'];

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

function ApplicantHealthSection({ applicant, health, onChange, allergiesOpts, dietaryOpts, medicalOpts, children }) {
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
      {children}
    </div>
  );
}

// NEAE sub-section (Necesidades Específicas de Apoyo Educativo, RGPD Art. 9).
// Dos ejes: CONDICIÓN (category_code + diagnosis_status + observations) y
// APOYOS (support_type + provider_scope + observations). Todo opcional; tono
// sensible. Reutiliza TagSelect/estilos de badge de la sección de salud.
function ApplicantNeaeSection({ neae, onChange }) {
  const { t } = useTranslation();

  const conditions = neae.conditions || [];
  const supports   = neae.supports   || [];

  const catOptions = NEAE_CATEGORIES
    .filter(code => !conditions.find(c => c.category_code === code))
    .map(code => ({ id: code, label: t('neae.cat.' + code) }));

  const [supType,  setSupType]  = useState('');
  const [supScope, setSupScope] = useState('PRIOR_SCHOOL');

  const setConditions = (next) => onChange({ ...neae, conditions: next });
  const setSupports   = (next) => onChange({ ...neae, supports: next });

  const addCondition = (code) =>
    setConditions([...conditions, { category_code: code, diagnosis_status: '', observations: '' }]);
  const removeCondition = (i) => setConditions(conditions.filter((_, j) => j !== i));
  const updateCondition = (i, field, val) => {
    const next = [...conditions];
    next[i] = { ...next[i], [field]: val };
    setConditions(next);
  };

  const addSupport = () => {
    if (!supType) return;
    setSupports([...supports, { support_type: supType, provider_scope: supScope, is_current: supScope === 'EXTERNAL_CURRENT', observations: '' }]);
    setSupType('');
    setSupScope('PRIOR_SCHOOL');
  };
  const removeSupport = (i) => setSupports(supports.filter((_, j) => j !== i));
  const updateSupport = (i, field, val) => {
    const next = [...supports];
    next[i] = { ...next[i], [field]: val };
    setSupports(next);
  };

  return (
    <div className="mt-4 pt-3" style={{ borderTop: '1px dashed var(--border, #dee2e6)' }}>
      <div className="dynamic-section-title mb-1">{t('neae.section_title')}</div>
      <p className="mb-3" style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>{t('neae.intro')}</p>

      {/* Q3 — condición(es) (multi) */}
      <div className="mb-3">
        <label className="form-label fw-semibold">{t('neae.conditions_label')}</label>
        <TagSelect
          options={catOptions}
          selected={conditions.map(c => ({ id: c.category_code, label: t('neae.cat.' + c.category_code) }))}
          onChange={sel => {
            // TagSelect passes the full selected array; only additions are new codes.
            const nextCodes = sel.map(s => s.id);
            const added = nextCodes.filter(code => !conditions.find(c => c.category_code === code));
            if (added.length) added.forEach(addCondition);
          }}
          placeholder={t('neae.search_conditions')}
        />
        {conditions.length > 0 && (
          <div className="mt-2 d-flex flex-column gap-2">
            {conditions.map((c, i) => (
              <div key={c.category_code || i} className="p-2 rounded" style={{ background: 'var(--teal-lt)' }}>
                <div className="d-flex align-items-center justify-content-between gap-2 mb-2">
                  <span className="fw-semibold" style={{ color: 'var(--teal-dk)' }}>{t('neae.cat.' + c.category_code)}</span>
                  <button onClick={() => removeCondition(i)}
                    style={{ background: 'none', border: 'none', color: 'var(--teal-dk)', cursor: 'pointer', padding: 0, fontSize: '1rem', lineHeight: 1 }}>
                    &times;
                  </button>
                </div>
                <div className="row g-2">
                  <div className="col-12 col-md-5">
                    <label className="form-label form-label-sm mb-1" style={{ fontSize: '0.8rem' }}>{t('neae.diagnosis_label')}</label>
                    <select className="form-select form-select-sm"
                      value={c.diagnosis_status || ''}
                      onChange={e => updateCondition(i, 'diagnosis_status', e.target.value)}>
                      <option value="">{t('neae.diagnosis_placeholder')}</option>
                      {NEAE_DIAGNOSIS.map(s => <option key={s} value={s}>{t('neae.diag.' + s)}</option>)}
                    </select>
                  </div>
                  <div className="col-12 col-md-7">
                    <label className="form-label form-label-sm mb-1" style={{ fontSize: '0.8rem' }}>{t('health.observations')}</label>
                    <input className="form-control form-control-sm"
                      placeholder={t('neae.condition_obs_placeholder')}
                      value={c.observations || ''}
                      onChange={e => updateCondition(i, 'observations', e.target.value)} />
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>

      {/* Q1 + Q5 — apoyos (centro anterior / externo actual) */}
      <div className="mb-2">
        <label className="form-label fw-semibold">{t('neae.supports_label')}</label>
        <div className="row g-2 align-items-end mb-2">
          <div className="col-12 col-md-5">
            <select className="form-select form-select-sm" value={supType} onChange={e => setSupType(e.target.value)}>
              <option value="">{t('neae.support_type_placeholder')}</option>
              {NEAE_SUPPORTS.map(s => <option key={s} value={s}>{t('neae.sup.' + s)}</option>)}
            </select>
          </div>
          <div className="col-8 col-md-5">
            <select className="form-select form-select-sm" value={supScope} onChange={e => setSupScope(e.target.value)}>
              {NEAE_SCOPES.map(s => <option key={s} value={s}>{t('neae.scope.' + s)}</option>)}
            </select>
          </div>
          <div className="col-4 col-md-2">
            <button type="button" className="btn btn-sm btn-outline-secondary w-100" onClick={addSupport} disabled={!supType}>
              <i className="bi bi-plus-lg" />
            </button>
          </div>
        </div>
        {supports.length > 0 && (
          <div className="d-flex flex-column gap-2">
            {supports.map((s, i) => (
              <div key={i} className="d-flex align-items-center gap-2 flex-wrap">
                <span className="badge d-flex align-items-center gap-1 flex-shrink-0"
                  style={{ background: 'var(--teal-lt)', color: 'var(--teal-dk)', padding: '5px 10px', borderRadius: 20 }}>
                  {t('neae.sup.' + s.support_type)} · {t('neae.scope.' + (s.provider_scope || 'PRIOR_SCHOOL'))}
                  <button onClick={() => removeSupport(i)}
                    style={{ background: 'none', border: 'none', color: 'var(--teal-dk)', cursor: 'pointer', padding: 0, fontSize: '0.8rem', lineHeight: 1 }}>
                    &times;
                  </button>
                </span>
                <input className="form-control form-control-sm" style={{ minWidth: 160, flex: 1 }}
                  placeholder={t('health.observations')}
                  value={s.observations || ''}
                  onChange={e => updateSupport(i, 'observations', e.target.value)} />
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

export default function Step4Health({ onNext, onBack, locked, onUnlock, savePending }) {
  const { t, i18n } = useTranslation();
  const {
    stepData, updateStep,
    touchActivity, resumeToken,
  } = useWizard();
  const applicants = (stepData.persons || []).filter(p => p.person_type_id === 'applicant');

  // DL-E39 ENMIENDA (gate de entrada): la salud Art.9 RGPD está protegida por el
  // GATE DE ENTRADA del wizard (StepUpGate), no por ocultación per-campo. Una vez
  // dentro, se muestra con normalidad. `touchActivity` resetea el contador de
  // inactividad para no re-pedir el OTP mientras la familia interactúa.

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

  // NEAE state — parallel to healthData, one entry per applicant.
  const emptyNeae = (pid) => ({ person_id: pid, conditions: [], supports: [] });
  const [neaeData, setNeaeData] = useState(() =>
    applicants.map(a => {
      const pid = a.person_id || a._uid;
      const existing = (stepData.neae || []).find(n => n.person_id === pid);
      return existing ? { person_id: pid, conditions: existing.conditions || [], supports: existing.supports || [] } : emptyNeae(pid);
    })
  );
  // Baseline snapshot of the last persisted NEAE — used to skip redundant saves.
  const neaeBaselineRef = useRef(JSON.stringify(stepData.neae || []));

  // Re-sync NEAE if stepData.neae arrives after mount (server rehydration).
  useEffect(() => {
    if (!stepData.neae?.length) return;
    neaeBaselineRef.current = JSON.stringify(stepData.neae);
    setNeaeData(
      (stepData.persons || [])
        .filter(p => p.person_type_id === 'applicant')
        .map(a => {
          const pid = a.person_id || a._uid;
          const existing = stepData.neae.find(n => n.person_id === pid);
          return existing ? { person_id: pid, conditions: existing.conditions || [], supports: existing.supports || [] } : emptyNeae(pid);
        })
    );
  }, [stepData.neae]); // eslint-disable-line

  const updateNeae = (i, val) => {
    const next = [...neaeData];
    next[i] = val;
    setNeaeData(next);
  };

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

  // Persist NEAE staging in the background (action 'saveNeae'), only when it
  // actually changed vs the last persisted snapshot — avoids append-only churn
  // on clean re-visits. Fire-and-forget: never blocks navigation; degrades
  // gracefully (backend tolerates absent staging tables, P72). NEAE is captured
  // in the same screen as health, whose saveStep already enforced the step-up
  // gate — so no second OTP prompt here.
  const persistNeae = () => {
    updateStep('neae', neaeData);
    const snapshot = JSON.stringify(neaeData);
    if (!resumeToken || snapshot === neaeBaselineRef.current) return;
    neaeBaselineRef.current = snapshot;
    const sourceLocale = (i18n.language || '').slice(0, 2) || undefined;
    const payload = neaeData.map(n => ({
      person_id:     n.person_id,
      conditions:    n.conditions || [],
      supports:      n.supports   || [],
      source_locale: sourceLocale,
    }));
    saveNeae(resumeToken, payload)
      .then(() => log.success('Step4: saveNeae OK (background)'))
      .catch(err => log.warn('Step4: saveNeae failed (background)', { message: err?.message }));
  };

  const handleBack = () => {
    updateStep('health', healthData);
    persistNeae();
    onBack();
  };

  const handleNext = () => {
    log.info('Step4: onNext health', healthData);
    updateStep('health', healthData);
    persistNeae();
    onNext('health', healthData);
  };

  return (
    <>
      <div className="mb-2">
        <h2 style={{ color: 'var(--teal-dk)', fontWeight: 800 }}>{t('step.health')}</h2>
        <p style={{ color: 'var(--muted)' }}>{t('step4.subtitle')}</p>
      </div>

      <StepNav position="top" onBack={handleBack} onNext={handleNext} savePending={savePending} />

      {locked && <LockedBanner onUnlock={onUnlock} highlight={highlightEdit} />}

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
          >
            <ApplicantNeaeSection
              neae={neaeData[i] || { conditions: [], supports: [] }}
              onChange={val => updateNeae(i, val)}
            />
          </ApplicantHealthSection>
        ))}

        {applicants.length === 0 && (
          <div className="text-center py-4" style={{ color: 'var(--muted)' }}>
            {t('step4.no_applicants')}
          </div>
        )}
      </fieldset>
      </div>

      <div className="d-flex justify-content-between mt-4">
        <button className="btn-secondary-kis" onClick={handleBack}>
          <i className="bi bi-arrow-left me-1" /> {t('nav.back')}
        </button>
        {/* WPERF-1 (criterios 1+2): no se bloquea ni muestra "Guardando…" por save en vuelo. */}
        <button className="btn-primary-kis" onClick={handleNext}>
          {t('nav.continue')} <i className="bi bi-arrow-right ms-1" />
        </button>
      </div>
    </>
  );
}
