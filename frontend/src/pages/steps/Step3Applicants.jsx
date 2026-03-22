import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useWizard } from '../../context/WizardContext';
import AddressForm, { emptyAddress } from '../../components/AddressForm';

const CURRENT_YEAR = new Date().getFullYear();
const SCHOOL_YEARS = Array.from({ length: 5 }, (_, i) => {
  const y = CURRENT_YEAR + i;
  return { value: String(y), label: `${y}/${String(y + 1).slice(-2)}` };
});

const emptyApplicant = () => ({
  _uid:                      Date.now() + Math.random(),
  first_name:                '',
  middle_name:               '',
  last_name:                 '',
  date_of_birth:             '',
  place_of_birth:            '',
  nationality_id:            '',
  id_type_id:                '',
  id_number:                 '',
  gender:                    '',
  mother_tongue_language:    '',
  other_languages:           [],
  desired_education_level_id:'',
  desired_start_date:        '',
  _school_year:              String(CURRENT_YEAR),
  _start_type:               'september',
  address:                   emptyAddress(),
  has_adaptation_needs:      false,
  adaptation_notes:          '',
  is_sibling:                false,
  is_alumni_family:          false,
  is_transfer:               false,
  previous_schools:          [],
  _sameAddress:              false,
});

const emptySchool = () => ({
  _uid:                        Date.now() + Math.random(),
  school_name:                 '',
  city:                        '',
  country_id:                  '',
  from_year:                   '',
  to_year:                     '',
  education_level_description: '',
  language_of_instruction:     '',
});

function PreviousSchoolRow({ school, onChange, onRemove }) {
  const { t } = useTranslation();
  const u = (f, v) => onChange({ ...school, [f]: v });
  return (
    <div className="border rounded p-2 mb-2" style={{ background: 'var(--bg)' }}>
      <div className="row g-2">
        <div className="col-md-5">
          <input className="form-control form-control-sm" placeholder={t('field.school_name')} value={school.school_name} onChange={e => u('school_name', e.target.value)} />
        </div>
        <div className="col-md-3">
          <input className="form-control form-control-sm" placeholder={t('field.city')} value={school.city} onChange={e => u('city', e.target.value)} />
        </div>
        <div className="col-md-2">
          <input className="form-control form-control-sm" placeholder={t('field.country')} value={school.country_id} onChange={e => u('country_id', e.target.value)} />
        </div>
        <div className="col-md-1">
          <input className="form-control form-control-sm" placeholder={t('field.from_year')} type="number" value={school.from_year} onChange={e => u('from_year', e.target.value)} />
        </div>
        <div className="col-md-1">
          <input className="form-control form-control-sm" placeholder={t('field.to_year')} type="number" value={school.to_year} onChange={e => u('to_year', e.target.value)} />
        </div>
        <div className="col-md-5">
          <input className="form-control form-control-sm" placeholder={t('field.edu_level_desc')} value={school.education_level_description} onChange={e => u('education_level_description', e.target.value)} />
        </div>
        <div className="col-md-5">
          <input className="form-control form-control-sm" placeholder={t('field.lang_instruction')} value={school.language_of_instruction} onChange={e => u('language_of_instruction', e.target.value)} />
        </div>
        <div className="col-md-2 d-flex align-items-center">
          <button className="remove-btn w-100" onClick={onRemove}>{t('action.remove')}</button>
        </div>
      </div>
    </div>
  );
}

function ApplicantSection({ applicant, idx, isFirst, onChange, onRemove, guardian1 }) {
  const { t } = useTranslation();
  const u = (f, v) => onChange({ ...applicant, [f]: v });

  const handleSameAddress = (checked) => {
    if (checked && guardian1?.guardian_id) {
      onChange({
        ...applicant,
        _sameAddress:                true,
        copy_address_from_guardian_id: guardian1.guardian_id,
      });
    } else {
      onChange({
        ...applicant,
        _sameAddress:                false,
        copy_address_from_guardian_id: null,
      });
    }
  };

  const handleStartType = (type) => {
    const year = applicant._school_year || String(CURRENT_YEAR);
    const startDate = type === 'september' ? `${year}-09-01` : '';
    onChange({ ...applicant, _start_type: type, desired_start_date: startDate });
  };

  const handleSchoolYear = (year) => {
    if (applicant._start_type === 'september') {
      onChange({ ...applicant, _school_year: year, desired_start_date: `${year}-09-01` });
    } else {
      onChange({ ...applicant, _school_year: year });
    }
  };

  const updateSchool = (i, val) => {
    const ps = [...(applicant.previous_schools || [])];
    ps[i] = val;
    u('previous_schools', ps);
  };
  const removeSchool = (i) => {
    const ps = [...(applicant.previous_schools || [])];
    ps.splice(i, 1);
    u('previous_schools', ps);
  };

  const canCopyAddress = !!(guardian1?.guardian_id);

  return (
    <div className="dynamic-section">
      <div className="dynamic-section-header">
        <span className="dynamic-section-title">
          {t('applicant.title', { n: idx + 1 })}
          {applicant.first_name ? ` — ${applicant.first_name} ${applicant.last_name}` : ''}
        </span>
        {!isFirst && <button className="remove-btn" onClick={onRemove}>{t('action.remove')}</button>}
      </div>

      <div className="row g-3">
        <div className="col-md-4">
          <label className="form-label">{t('field.first_name')} *</label>
          <input className="form-control" value={applicant.first_name} onChange={e => u('first_name', e.target.value)} />
        </div>
        <div className="col-md-4">
          <label className="form-label">{t('field.middle_name')}</label>
          <input className="form-control" value={applicant.middle_name} onChange={e => u('middle_name', e.target.value)} />
        </div>
        <div className="col-md-4">
          <label className="form-label">{t('field.last_name')} *</label>
          <input className="form-control" value={applicant.last_name} onChange={e => u('last_name', e.target.value)} />
        </div>
        <div className="col-md-3">
          <label className="form-label">{t('field.date_of_birth')} *</label>
          <input type="date" className="form-control" value={applicant.date_of_birth} onChange={e => u('date_of_birth', e.target.value)} />
        </div>
        <div className="col-md-3">
          <label className="form-label">{t('field.gender')}</label>
          <select className="form-select" value={applicant.gender} onChange={e => u('gender', e.target.value)}>
            <option value="">{t('placeholder.select')}</option>
            <option value="M">{t('gender.m')}</option>
            <option value="F">{t('gender.f')}</option>
            <option value="X">{t('gender.x')}</option>
          </select>
        </div>
        <div className="col-md-3">
          <label className="form-label">{t('field.nationality')}</label>
          <input className="form-control" value={applicant.nationality_id} onChange={e => u('nationality_id', e.target.value)} placeholder={t('placeholder.country_code')} />
        </div>
        <div className="col-md-3">
          <label className="form-label">{t('field.place_of_birth')}</label>
          <input className="form-control" value={applicant.place_of_birth} onChange={e => u('place_of_birth', e.target.value)} />
        </div>
        <div className="col-md-4">
          <label className="form-label">{t('field.id_type')}</label>
          <select className="form-select" value={applicant.id_type_id} onChange={e => u('id_type_id', e.target.value)}>
            <option value="">{t('placeholder.select')}</option>
            <option value="passport">{t('id.passport')}</option>
            <option value="dni">{t('id.dni')}</option>
            <option value="nie">{t('id.nie')}</option>
            <option value="other">{t('id.other')}</option>
          </select>
        </div>
        <div className="col-md-4">
          <label className="form-label">{t('field.id_number')}</label>
          <input className="form-control" value={applicant.id_number} onChange={e => u('id_number', e.target.value)} />
        </div>
        <div className="col-md-4">
          <label className="form-label">{t('field.mother_tongue')}</label>
          <input className="form-control" value={applicant.mother_tongue_language} onChange={e => u('mother_tongue_language', e.target.value)} />
        </div>
      </div>

      {/* Enrolment */}
      <div className="mt-3 p-3 rounded" style={{ background: 'var(--teal-lt)' }}>
        <h6 style={{ color: 'var(--teal-dk)', marginBottom: 12 }}>{t('applicant.enrolment')}</h6>
        <div className="row g-3">
          <div className="col-md-4">
            <label className="form-label">{t('field.school_year')}</label>
            <select className="form-select" value={applicant._school_year} onChange={e => handleSchoolYear(e.target.value)}>
              {SCHOOL_YEARS.map(y => <option key={y.value} value={y.value}>{y.label}</option>)}
            </select>
          </div>
          <div className="col-md-8">
            <label className="form-label">{t('field.start_type')}</label>
            <div className="d-flex gap-3">
              <div className="form-check">
                <input type="radio" className="form-check-input" name={`startType_${idx}`} id={`sep_${idx}`}
                  checked={applicant._start_type === 'september'}
                  onChange={() => handleStartType('september')} />
                <label className="form-check-label" htmlFor={`sep_${idx}`}>{t('start.september')}</label>
              </div>
              <div className="form-check">
                <input type="radio" className="form-check-input" name={`startType_${idx}`} id={`midterm_${idx}`}
                  checked={applicant._start_type === 'midterm'}
                  onChange={() => handleStartType('midterm')} />
                <label className="form-check-label" htmlFor={`midterm_${idx}`}>{t('start.midterm')}</label>
              </div>
            </div>
          </div>
          {applicant._start_type === 'midterm' && (
            <div className="col-md-4">
              <label className="form-label">{t('field.start_date')}</label>
              <input type="date" className="form-control"
                value={applicant.desired_start_date}
                onChange={e => u('desired_start_date', e.target.value)} />
              <div className="disclaimer-box mt-2">
                {t('start.disclaimer_en')}
                <hr style={{ margin: '6px 0' }} />
                {t('start.disclaimer_es')}
              </div>
            </div>
          )}
        </div>
      </div>

      {/* Flags */}
      <div className="mt-3 d-flex flex-wrap gap-3">
        {[
          ['has_adaptation_needs', 'applicant.has_adaptation'],
          ['is_sibling',           'applicant.is_sibling'],
          ['is_alumni_family',     'applicant.is_alumni'],
          ['is_transfer',          'applicant.is_transfer'],
        ].map(([field, labelKey]) => (
          <div className="form-check" key={field}>
            <input type="checkbox" className="form-check-input" id={`${field}_${idx}`}
              checked={!!applicant[field]} onChange={e => u(field, e.target.checked)} />
            <label className="form-check-label" htmlFor={`${field}_${idx}`}>{t(labelKey)}</label>
          </div>
        ))}
      </div>
      {applicant.has_adaptation_needs && (
        <div className="mt-2">
          <label className="form-label">{t('field.adaptation_notes')}</label>
          <textarea className="form-control" rows={2} value={applicant.adaptation_notes}
            onChange={e => u('adaptation_notes', e.target.value)} />
        </div>
      )}

      {/* Address */}
      <div className="mt-3">
        <div className="d-flex align-items-center gap-3 mb-2">
          <h6 className="mb-0" style={{ color: 'var(--muted)' }}>{t('field.address')}</h6>
          <div className="form-check mb-0">
            <input
              type="checkbox" className="form-check-input"
              id={`appSameAddr_${idx}`}
              checked={applicant._sameAddress || false}
              disabled={!canCopyAddress}
              onChange={e => handleSameAddress(e.target.checked)}
            />
            <label className="form-check-label small" htmlFor={`appSameAddr_${idx}`}>
              {t('guardian.same_as_1')}
            </label>
          </div>
        </div>
        {!applicant._sameAddress && (
          <AddressForm
            address={applicant.address || emptyAddress()}
            onChange={addr => u('address', addr)}
          />
        )}
      </div>

      {/* Previous schools */}
      <div className="mt-3">
        <h6 style={{ color: 'var(--muted)' }}>{t('applicant.prev_schools')}</h6>
        {(applicant.previous_schools || []).map((s, i) => (
          <PreviousSchoolRow key={s._uid || i} school={s}
            onChange={val => updateSchool(i, val)}
            onRemove={() => removeSchool(i)} />
        ))}
        <button className="add-btn" onClick={() => u('previous_schools', [...(applicant.previous_schools || []), emptySchool()])}>
          <i className="bi bi-plus" /> {t('applicant.add_school')}
        </button>
      </div>
    </div>
  );
}

export default function Step3Applicants({ onNext, onBack }) {
  const { t } = useTranslation();
  const { stepData, updateStep } = useWizard();
  const [applicants, setApplicants] = useState(
    stepData.applicants?.length ? stepData.applicants : [emptyApplicant()]
  );
  const [err, setErr] = useState('');
  const guardian1 = stepData.guardians?.[0] || null;

  const updateApplicant = (i, val) => {
    const next = [...applicants];
    next[i] = val;
    setApplicants(next);
  };

  const handleNext = () => {
    if (!applicants[0]?.first_name || !applicants[0]?.last_name) {
      setErr(t('error.applicant_required'));
      return;
    }
    setErr('');
    updateStep('applicants', applicants);
    onNext('applicants', applicants);
  };

  return (
    <>
      <div className="mb-2">
        <h2 style={{ color: 'var(--teal-dk)', fontWeight: 800 }}>{t('step.applicants')}</h2>
        <p style={{ color: 'var(--muted)' }}>{t('step3.subtitle')}</p>
      </div>

      {applicants.map((a, i) => (
        <ApplicantSection
          key={a._uid || i}
          applicant={a}
          idx={i}
          isFirst={i === 0}
          onChange={val => updateApplicant(i, val)}
          onRemove={() => {
            const next = [...applicants];
            next.splice(i, 1);
            setApplicants(next);
          }}
          guardian1={guardian1}
        />
      ))}

      <button className="add-btn" onClick={() => setApplicants([...applicants, emptyApplicant()])}>
        <i className="bi bi-plus-lg" /> {t('applicant.add')}
      </button>

      {err && <div className="field-error mt-2">{err}</div>}

      <div className="d-flex justify-content-between mt-4">
        <button className="btn-secondary-kis" onClick={onBack}>
          <i className="bi bi-arrow-left me-1" /> {t('nav.back')}
        </button>
        <button className="btn-primary-kis" onClick={handleNext}>
          {t('nav.continue')} <i className="bi bi-arrow-right ms-1" />
        </button>
      </div>
    </>
  );
}
