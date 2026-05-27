import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useWizard } from '../../context/WizardContext';
import { fetchLookups } from '../../api';
import * as log from '../../logger';

export default function Step1Email({ onNext, savePending }) {
  const { t }    = useTranslation();
  const { stepData, updateStep } = useWizard();

  const data  = stepData.email;
  const email = data.primary_email || '';

  const [programs,          setPrograms]          = useState(null); // null = loading
  const [selectedProgramId, setSelectedProgramId] = useState(data.program_id || '');
  const [startType,         setStartType]         = useState(() => {
    const d = data.desired_start_date || '';
    return d && d.slice(5, 10) !== '09-01' ? 'midterm' : 'september';
  });
  const [desiredStartDate, setDesiredStartDate] = useState(data.desired_start_date || '');

  useEffect(() => {
    fetchLookups()
      .then(lookups => {
        const progs = lookups.programs || [];
        setPrograms(progs);
        // Auto-select when only one programme is available
        if (!selectedProgramId && progs.length === 1) {
          setSelectedProgramId(progs[0].program_id);
          if (!desiredStartDate && progs[0].period_starts_on) {
            setDesiredStartDate(progs[0].period_starts_on);
          }
        }
      })
      .catch(() => setPrograms([]));
  }, []); // eslint-disable-line

  const handleProgramChange = (programId) => {
    setSelectedProgramId(programId);
    const prog = (programs || []).find(p => p.program_id === programId);
    if (prog?.period_starts_on && startType === 'september') {
      setDesiredStartDate(prog.period_starts_on);
    }
  };

  const handleStartType = (type) => {
    setStartType(type);
    if (type === 'september') {
      const prog = (programs || []).find(p => p.program_id === selectedProgramId);
      setDesiredStartDate(prog?.period_starts_on || '');
    } else {
      setDesiredStartDate('');
    }
  };

  const handleContinue = () => {
    // In september mode the date picker is hidden; use program's period_starts_on as fallback.
    const prog = (programs || []).find(p => p.program_id === selectedProgramId);
    const effectiveDate = desiredStartDate || (startType === 'september' ? (prog?.period_starts_on || '') : '');
    const emailData = { primary_email: email, verified: true, desired_start_date: effectiveDate, program_id: selectedProgramId };
    log.info('Step1: onNext application', { emailData, effectiveDate, selectedProgramId });
    updateStep('email', emailData);
    onNext('application', { desired_start_date: effectiveDate, program_id: selectedProgramId });
  };

  // September mode: date is implicit (not shown) — only program selection needed.
  // Midterm mode: user must enter a specific date.
  const canContinue = selectedProgramId && (startType === 'september' ? true : !!desiredStartDate);

  return (
    <div className="kis-card">
      <h2>{t('step.email')}</h2>

      {email && (
        <div className="alert alert-success d-flex align-items-center gap-2 mb-4">
          <i className="bi bi-check-circle-fill" />
          {t('step1.verified', { email })}
        </div>
      )}

      <div className="p-3 rounded" style={{ background: 'var(--teal-lt)' }}>
        <h6 style={{ color: 'var(--teal-dk)', marginBottom: 12 }}>{t('step1.start_date_title')}</h6>
        <div className="row g-3">
          <div className="col-md-4">
            <label className="form-label">{t('field.program')}</label>
            {programs === null ? (
              <div className="d-flex align-items-center gap-2" style={{ height: 38 }}>
                <div className="spinner-border spinner-border-sm" role="status" style={{ color: 'var(--teal)' }} />
              </div>
            ) : programs.length === 0 ? (
              <p className="text-muted small mb-0">{t('step1.no_programs')}</p>
            ) : (
              <select
                className="form-select"
                value={selectedProgramId}
                onChange={e => handleProgramChange(e.target.value)}
              >
                {programs.length > 1 && <option value="">{t('step1.select_program')}</option>}
                {programs.map(p => (
                  <option key={p.program_id} value={p.program_id}>{p.designation}</option>
                ))}
              </select>
            )}
          </div>
          <div className="col-md-8">
            <label className="form-label">{t('field.start_type')}</label>
            <div className="d-flex gap-3">
              <div className="form-check">
                <input type="radio" className="form-check-input" name="startType" id="sep"
                  checked={startType === 'september'} onChange={() => handleStartType('september')} />
                <label className="form-check-label" htmlFor="sep">{t('start.september')}</label>
              </div>
              <div className="form-check">
                <input type="radio" className="form-check-input" name="startType" id="mid"
                  checked={startType === 'midterm'} onChange={() => handleStartType('midterm')} />
                <label className="form-check-label" htmlFor="mid">{t('start.midterm')}</label>
              </div>
            </div>
          </div>
          {startType === 'midterm' && (
            <div className="col-md-5">
              <label className="form-label">{t('field.start_date')}</label>
              <input type="date" className="form-control"
                value={desiredStartDate}
                onChange={e => setDesiredStartDate(e.target.value)} />
              <div className="disclaimer-box mt-2">
                {t('start.disclaimer_en')}
                <hr style={{ margin: '6px 0' }} />
                {t('start.disclaimer_es')}
              </div>
            </div>
          )}
        </div>
      </div>

      <div className="d-flex justify-content-end mt-3">
        <button
          className="btn-primary-kis"
          onClick={handleContinue}
          disabled={!canContinue || savePending}
        >
          {savePending
            ? <><span className="spinner-border spinner-border-sm me-1" style={{ width: '0.9em', height: '0.9em', borderWidth: '0.12em' }} />{t('wizard.saving_in_background')}</>
            : <>{t('nav.continue')} <i className="bi bi-arrow-right ms-1" /></>
          }
        </button>
      </div>
    </div>
  );
}
