import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useWizard } from '../../context/WizardContext';
import { gasCall } from '../../api';
import * as log from '../../logger';

function buildInitialRelations(persons, existingRelations) {
  const guardians  = persons.filter(p => p.person_type_id === 'guardian');
  const applicants = persons.filter(p => p.person_type_id === 'applicant');

  return guardians.flatMap(g => {
    const gId = g.person_id || g._uid;
    return applicants.map(a => {
      const aId = a.person_id || a._uid;
      const existing = (existingRelations || []).find(
        r => r.guardian_person_id === gId && r.applicant_person_id === aId
      );
      return existing || {
        _uid:                  `${gId}__${aId}`,
        guardian_person_id:    gId,
        applicant_person_id:   aId,
        relation_type_id:      '',
        is_custodial:          false,
        is_pick_up_authorized: false,
      };
    });
  });
}

export default function Step3Relations({ onNext, onBack }) {
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
    gasCall('fetchLookups', {})
      .then(data => {
        log.info('Step3: fetchLookups relationTypes', { count: data.relationTypes?.length, data: JSON.stringify(data.relationTypes) });
        if (data.relationTypes?.length) setRelationTypes(data.relationTypes);
      })
      .catch(err => log.error('Step3: fetchLookups failed', { message: err.message }));
  }, []);

  const updateRelation = (idx, updates) => {
    setRelations(prev => prev.map((r, i) => i === idx ? { ...r, ...updates } : r));
  };

  const handleBack = () => {
    updateStep('relations', relations);
    onBack();
  };

  const handleNext = () => {
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

  return (
    <>
      <div className="mb-2">
        <h2 style={{ color: 'var(--teal-dk)', fontWeight: 800 }}>{t('step.relations')}</h2>
        <p style={{ color: 'var(--muted)' }}>{t('step3.subtitle')}</p>
      </div>

      {relations.map((rel, relIdx) => {
        const g = persons.find(p => (p.person_id || p._uid) === rel.guardian_person_id);
        const a = persons.find(p => (p.person_id || p._uid) === rel.applicant_person_id);
        if (!g || !a) return null;

        const gName = [g.first_name, g.last_name].filter(Boolean).join(' ')
          || t('guardian.title', { n: relIdx + 1 });
        const aName = [a.first_name, a.last_name].filter(Boolean).join(' ')
          || t('applicant.title', { n: relIdx + 1 });

        return (
          <div key={rel._uid || relIdx} className="kis-card mb-3">
            <div className="d-flex align-items-center gap-2 flex-wrap">
              <strong style={{ color: 'var(--teal-dk)' }}>{gName}</strong>
              <span style={{ color: 'var(--muted)' }}>{t('relation.is_of')}</span>
              <select
                className="form-select form-select-sm"
                style={{ width: 'auto', minWidth: 170 }}
                value={rel.relation_type_id}
                onChange={e => updateRelation(relIdx, { relation_type_id: e.target.value })}
              >
                <option value="">{t('relation.none')}</option>
                {relationTypes.filter(rt => rt.id).map(rt => (
                  <option key={rt.id} value={rt.id}>
                    {rt.label || rt.id}
                  </option>
                ))}
              </select>
              <span style={{ color: 'var(--muted)' }}>{t('relation.of')}</span>
              <strong style={{ color: 'var(--teal-dk)' }}>{aName}</strong>
            </div>

            <div className="d-flex gap-4 mt-3">
              <div className="form-check mb-0">
                <input type="checkbox" className="form-check-input"
                  id={`custodial_${relIdx}`}
                  checked={rel.is_custodial}
                  onChange={e => updateRelation(relIdx, { is_custodial: e.target.checked })} />
                <label className="form-check-label small" htmlFor={`custodial_${relIdx}`}>
                  {t('relation.is_custodial')}
                </label>
              </div>
              <div className="form-check mb-0">
                <input type="checkbox" className="form-check-input"
                  id={`pickup_${relIdx}`}
                  checked={rel.is_pick_up_authorized}
                  onChange={e => updateRelation(relIdx, { is_pick_up_authorized: e.target.checked })} />
                <label className="form-check-label small" htmlFor={`pickup_${relIdx}`}>
                  {t('relation.is_pickup')}
                </label>
              </div>
            </div>
          </div>
        );
      })}

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
