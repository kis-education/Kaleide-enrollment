import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useWizard } from '../../context/WizardContext';

const CURRENT_YEAR = new Date().getFullYear();
const SCHOOL_YEARS = Array.from({ length: 5 }, (_, i) => {
  const y = CURRENT_YEAR + i;
  return { value: String(y), label: `${y}/${String(y + 1).slice(-2)}` };
});

export default function Step1Email({ onNext }) {
  const { t }    = useTranslation();
  const { stepData, updateStep } = useWizard();

  const data = stepData.email;
  const email = data.primary_email || '';

  const initialDate = data.desired_start_date || '';
  const initialYear = initialDate ? initialDate.slice(0, 4) : String(CURRENT_YEAR);
  const initialIsSeptember = !initialDate || initialDate.slice(5, 10) === '09-01';

  const [schoolYear,       setSchoolYear]       = useState(initialYear);
  const [startType,        setStartType]        = useState(initialIsSeptember ? 'september' : 'midterm');
  const [desiredStartDate, setDesiredStartDate] = useState(
    initialIsSeptember ? `${initialYear}-09-01` : (initialDate || `${initialYear}-09-01`)
  );

  const handleSchoolYear = (year) => {
    setSchoolYear(year);
    if (startType === 'september') setDesiredStartDate(`${year}-09-01`);
  };

  const handleStartType = (type) => {
    setStartType(type);
    if (type === 'september') setDesiredStartDate(`${schoolYear}-09-01`);
    else setDesiredStartDate('');
  };

  const handleContinue = () => {
    updateStep('email', { primary_email: email, verified: true, desired_start_date: desiredStartDate });
    onNext('application', { desired_start_date: desiredStartDate });
  };

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
            <label className="form-label">{t('field.school_year')}</label>
            <select className="form-select" value={schoolYear} onChange={e => handleSchoolYear(e.target.value)}>
              {SCHOOL_YEARS.map(y => <option key={y.value} value={y.value}>{y.label}</option>)}
            </select>
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
          disabled={startType === 'midterm' && !desiredStartDate}
        >
          {t('nav.continue')} <i className="bi bi-arrow-right ms-1" />
        </button>
      </div>
    </div>
  );
}
