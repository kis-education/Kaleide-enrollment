import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useWizard } from '../../context/WizardContext';
import { fetchLookups } from '../../api';
import LockedBanner from '../../components/LockedBanner';
import * as log from '../../logger';

function buildInitialRelations(persons, existingRelations) {
  const guardians  = persons.filter(p => p.person_type_id === 'guardian');
  const applicants = persons.filter(p => p.person_type_id === 'applicant');
  const existing   = existingRelations || [];

  // Guardian → Applicant relations
  const ga = guardians.flatMap(g => {
    const gId = g.person_id || g._uid;
    return applicants.map(a => {
      const aId = a.person_id || a._uid;
      const found = existing.find(
        r => (r.guardian_person_id === gId || r.person_id_a === gId) &&
             (r.applicant_person_id === aId || r.person_id_b === aId)
      );
      return found
        ? { ...found, _kind: 'ga' }
        : { _uid: `${gId}__${aId}`, _kind: 'ga', guardian_person_id: gId, applicant_person_id: aId, relation_type_id: '', is_custodial: false, is_pick_up_authorized: false };
    });
  });

  // Applicant → Applicant relations (unique pairs)
  const aa = [];
  for (let i = 0; i < applicants.length; i++) {
    for (let j = i + 1; j < applicants.length; j++) {
      const idA = applicants[i].person_id || applicants[i]._uid;
      const idB = applicants[j].person_id || applicants[j]._uid;
      const found = existing.find(
        r => (r.person_id_a === idA && r.person_id_b === idB) ||
             (r.person_id_a === idB && r.person_id_b === idA)
      );
      aa.push(found
        ? { ...found, _kind: 'aa' }
        : { _uid: `${idA}__${idB}`, _kind: 'aa', person_id_a: idA, person_id_b: idB, relation_type_id: '' }
      );
    }
  }

  return [...ga, ...aa];
}

export default function Step3Relations({ onNext, onBack, locked, onUnlock }) {
  const { t } = useTranslation();
  const { stepData, updateStep } = useWizard();

  const persons    = stepData.persons || [];
  const guardians  = persons.filter(p => p.person_type_id === 'guardian');
  const applicants = persons.filter(p => p.person_type_id === 'applicant');

  const [relations,     setRelations]     = useState(() =>
    buildInitialRelations(persons, stepData.relations)
  );
  const [relationTypes, setRelationTypes] = useState([]);

  useEffect(() => {
    fetchLookups()
      .then(data => {
        log.info('Step3: fetchLookups relationTypes', { count: data.relationTypes?.length, data: JSON.stringify(data.relationTypes) });
        if (data.relationTypes?.length) setRelationTypes(data.relationTypes);
      })
      .catch(err => log.error('Step3: fetchLookups failed', { message: err.message }));
  }, []);

  const updateRelation = (idx, updates) => {
    setRelations(prev => prev.map((r, i) => {
      if (i !== idx) return r;
      const merged = { ...r, ...updates };
      if (updates.is_custodial === true)          merged.is_pick_up_authorized = true;
      if (updates.is_pick_up_authorized === false) merged.is_custodial = false;
      return merged;
    }));
  };

  const handleBack = () => {
    updateStep('relations', relations);
    onBack();
  };

  // Every applicant must have at least one guardian relation with custodial or pick-up
  const uncoveredApplicants = applicants.filter(a => {
    const aId = a.person_id || a._uid;
    return !relations.some(r =>
      r._kind === 'ga' &&
      (r.applicant_person_id === aId || r.person_id_b === aId) &&
      (r.is_custodial || r.is_pick_up_authorized)
    );
  });
  const validationOk = uncoveredApplicants.length === 0;

  const handleNext = () => {
    if (relations.length > 0 && !validationOk) return;
    updateStep('relations', relations);
    onNext('relations', relations);
  };

  if (!guardians.length || !applicants.length) {
    return (
      <>
        <div className="mb-2">
          <h2 style={{ color: 'var(--teal-dk)', fontWeight: 800 }}>{t('step.relations')}</h2>
        </div>
        <div className="kis-card">
          <p style={{ color: 'var(--muted)' }}>{t('step4.no_applicants')}</p>
        </div>
        <div className="d-flex justify-content-between mt-4">
          <button className="btn-secondary-kis" onClick={handleBack}>
            <i className="bi bi-arrow-left me-1" /> {t('nav.back')}
          </button>
          <button className="btn-primary-kis" onClick={handleNext}>
            {t('nav.continue')} <i className="bi bi-arrow-right ms-1" />
          </button>
        </div>
      </>
    );
  }

  const gaRelations = relations.filter(r => r._kind === 'ga');
  const aaRelations = relations.filter(r => r._kind === 'aa');

  return (
    <>
      <div className="mb-2">
        <h2 style={{ color: 'var(--teal-dk)', fontWeight: 800 }}>{t('step.relations')}</h2>
        <p style={{ color: 'var(--muted)' }}>{t('step3.subtitle')}</p>
      </div>

      {locked && <LockedBanner onUnlock={onUnlock} />}

      {!locked && uncoveredApplicants.length > 0 && (
        <div className="field-error mb-3">
          <i className="bi bi-exclamation-triangle-fill me-2" />
          {uncoveredApplicants.map(a => [a.first_name, a.last_name].filter(Boolean).join(' ') || t('applicant.unnamed')).join(', ')}
          {': '}{t('error.custodial_required')}
        </div>
      )}

      <fieldset disabled={locked} style={{ border: 'none', padding: 0, margin: 0 }}>

        {/* Guardian → Applicant */}
        {gaRelations.map((rel, relIdx) => {
          const idx = relations.indexOf(rel);
          const g = persons.find(p => (p.person_id || p._uid) === (rel.guardian_person_id || rel.person_id_a));
          const a = persons.find(p => (p.person_id || p._uid) === (rel.applicant_person_id || rel.person_id_b));
          if (!g || !a) return null;
          const gName = [g.first_name, g.last_name].filter(Boolean).join(' ') || t('guardian.title', { n: relIdx + 1 });
          const aName = [a.first_name, a.last_name].filter(Boolean).join(' ') || t('applicant.title', { n: relIdx + 1 });
          return (
            <div key={rel._uid || relIdx} className="kis-card mb-3">
              <div className="d-flex align-items-center gap-2 flex-wrap">
                <strong style={{ color: 'var(--teal-dk)' }}>{gName}</strong>
                <span style={{ color: 'var(--muted)' }}>{t('relation.is_of')}</span>
                <select
                  className="form-select form-select-sm"
                  style={{ width: 'auto', minWidth: 170 }}
                  value={rel.relation_type_id}
                  onChange={e => updateRelation(idx, { relation_type_id: e.target.value })}
                >
                  <option value="">{t('relation.none')}</option>
                  {relationTypes.filter(rt => rt.id).map(rt => (
                    <option key={rt.id} value={rt.id}>{rt.label || rt.id}</option>
                  ))}
                </select>
                <span style={{ color: 'var(--muted)' }}>{t('relation.of')}</span>
                <strong style={{ color: 'var(--teal-dk)' }}>{aName}</strong>
              </div>
              <div className="d-flex gap-4 mt-3">
                <div className="form-check mb-0">
                  <input type="checkbox" className="form-check-input"
                    id={`custodial_${idx}`}
                    checked={rel.is_custodial}
                    onChange={e => updateRelation(idx, { is_custodial: e.target.checked })} />
                  <label className="form-check-label small" htmlFor={`custodial_${idx}`}>
                    {t('relation.is_custodial')}
                  </label>
                </div>
                <div className="form-check mb-0">
                  <input type="checkbox" className="form-check-input"
                    id={`pickup_${idx}`}
                    checked={rel.is_pick_up_authorized}
                    onChange={e => updateRelation(idx, { is_pick_up_authorized: e.target.checked })} />
                  <label className="form-check-label small" htmlFor={`pickup_${idx}`}>
                    {t('relation.is_pickup')}
                  </label>
                </div>
              </div>
            </div>
          );
        })}

        {/* Applicant → Applicant */}
        {aaRelations.length > 0 && (
          <>
            <h6 className="mt-2 mb-2" style={{ color: 'var(--muted)' }}>{t('relation.between_applicants')}</h6>
            {aaRelations.map((rel, relIdx) => {
              const idx = relations.indexOf(rel);
              const pA = persons.find(p => (p.person_id || p._uid) === rel.person_id_a);
              const pB = persons.find(p => (p.person_id || p._uid) === rel.person_id_b);
              if (!pA || !pB) return null;
              const nameA = [pA.first_name, pA.last_name].filter(Boolean).join(' ') || t('applicant.unnamed');
              const nameB = [pB.first_name, pB.last_name].filter(Boolean).join(' ') || t('applicant.unnamed');
              return (
                <div key={rel._uid || relIdx} className="kis-card mb-3">
                  <div className="d-flex align-items-center gap-2 flex-wrap">
                    <strong style={{ color: 'var(--teal-dk)' }}>{nameA}</strong>
                    <span style={{ color: 'var(--muted)' }}>{t('relation.is_of')}</span>
                    <select
                      className="form-select form-select-sm"
                      style={{ width: 'auto', minWidth: 170 }}
                      value={rel.relation_type_id}
                      onChange={e => updateRelation(idx, { relation_type_id: e.target.value })}
                    >
                      <option value="">{t('relation.none')}</option>
                      {relationTypes.filter(rt => rt.id).map(rt => (
                        <option key={rt.id} value={rt.id}>{rt.label || rt.id}</option>
                      ))}
                    </select>
                    <span style={{ color: 'var(--muted)' }}>{t('relation.of')}</span>
                    <strong style={{ color: 'var(--teal-dk)' }}>{nameB}</strong>
                  </div>
                </div>
              );
            })}
          </>
        )}

      </fieldset>

      <div className="d-flex justify-content-between mt-4">
        <button className="btn-secondary-kis" onClick={handleBack}>
          <i className="bi bi-arrow-left me-1" /> {t('nav.back')}
        </button>
        <button
          className="btn-primary-kis"
          onClick={handleNext}
          disabled={!locked && relations.length > 0 && !validationOk}
        >
          {t('nav.continue')} <i className="bi bi-arrow-right ms-1" />
        </button>
      </div>
    </>
  );
}
