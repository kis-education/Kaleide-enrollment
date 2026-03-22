import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useWizard } from '../../context/WizardContext';
import AddressForm, { emptyAddress } from '../../components/AddressForm';

const emptyPerson = (type) => ({
  _uid:                        Date.now() + Math.random(),
  person_type_id:              type,
  first_name:                  '',
  middle_name:                 '',
  last_name:                   '',
  date_of_birth:               '',
  place_of_birth:              '',
  gender:                      '',
  nationality:                 '',     // UI-only flat field → transformed on save
  id_type_id:                  '',     // UI-only flat field → transformed on save
  id_number:                   '',     // UI-only flat field → transformed on save
  // Guardian-specific
  is_primary_contact:          false,
  is_emergency_contact:        false,
  emails:                      [],
  phones:                      [],
  // Applicant-specific
  desired_education_level_id:  '',
  is_sibling:                  false,
  is_alumni_family:            false,
  is_transfer:                 false,
  previous_schools:            [],
  // Address
  address:                     emptyAddress(),
  _sameAddress:                false,
  copy_address_from_person_id: null,
});

const emptyEmail = () => ({ _uid: Date.now() + Math.random(), email_address: '', is_default: false, is_emergency: false });
const emptyPhone = () => ({ _uid: Date.now() + Math.random(), phone_number: '', is_default: false, is_emergency: false, is_whatsapp: false, is_telegram: false });
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

function PhoneRow({ phone, onChange, onRemove, idx }) {
  const { t } = useTranslation();
  const u = (f, v) => onChange({ ...phone, [f]: v });
  return (
    <div className="border rounded p-2 mb-2" style={{ background: 'var(--bg)' }}>
      <div className="row g-2 align-items-center">
        <div className="col">
          <input type="tel" className="form-control form-control-sm"
            placeholder="+34 600 000 000"
            value={phone.phone_number}
            onChange={e => u('phone_number', e.target.value)} />
        </div>
        <div className="col-auto">
          <div className="form-check form-check-inline mb-0">
            <input type="checkbox" className="form-check-input" id={`def_ph_${idx}`}
              checked={phone.is_default} onChange={e => u('is_default', e.target.checked)} />
            <label className="form-check-label small" htmlFor={`def_ph_${idx}`}>{t('contact.is_default')}</label>
          </div>
          <div className="form-check form-check-inline mb-0">
            <input type="checkbox" className="form-check-input" id={`emg_ph_${idx}`}
              checked={phone.is_emergency} onChange={e => u('is_emergency', e.target.checked)} />
            <label className="form-check-label small" htmlFor={`emg_ph_${idx}`}>{t('contact.is_emergency')}</label>
          </div>
          <div className="form-check form-check-inline mb-0">
            <input type="checkbox" className="form-check-input" id={`wa_${idx}`}
              checked={phone.is_whatsapp} onChange={e => u('is_whatsapp', e.target.checked)} />
            <label className="form-check-label small" htmlFor={`wa_${idx}`}>WhatsApp</label>
          </div>
          <div className="form-check form-check-inline mb-0">
            <input type="checkbox" className="form-check-input" id={`tg_${idx}`}
              checked={phone.is_telegram} onChange={e => u('is_telegram', e.target.checked)} />
            <label className="form-check-label small" htmlFor={`tg_${idx}`}>Telegram</label>
          </div>
        </div>
        <div className="col-auto">
          <button className="remove-btn" onClick={onRemove}>&times;</button>
        </div>
      </div>
    </div>
  );
}

function PreviousSchoolRow({ school, onChange, onRemove }) {
  const { t } = useTranslation();
  const u = (f, v) => onChange({ ...school, [f]: v });
  return (
    <div className="border rounded p-2 mb-2" style={{ background: 'var(--bg)' }}>
      <div className="row g-2">
        <div className="col-md-5">
          <input className="form-control form-control-sm" placeholder={t('field.school_name')}
            value={school.school_name} onChange={e => u('school_name', e.target.value)} />
        </div>
        <div className="col-md-3">
          <input className="form-control form-control-sm" placeholder={t('field.city')}
            value={school.city} onChange={e => u('city', e.target.value)} />
        </div>
        <div className="col-md-2">
          <input className="form-control form-control-sm" placeholder={t('field.country')}
            value={school.country_id} onChange={e => u('country_id', e.target.value)} />
        </div>
        <div className="col-md-1">
          <input className="form-control form-control-sm" type="number" placeholder={t('field.from_year')}
            value={school.from_year} onChange={e => u('from_year', e.target.value)} />
        </div>
        <div className="col-md-1">
          <input className="form-control form-control-sm" type="number" placeholder={t('field.to_year')}
            value={school.to_year} onChange={e => u('to_year', e.target.value)} />
        </div>
        <div className="col-md-5">
          <input className="form-control form-control-sm" placeholder={t('field.edu_level_desc')}
            value={school.education_level_description}
            onChange={e => u('education_level_description', e.target.value)} />
        </div>
        <div className="col-md-5">
          <input className="form-control form-control-sm" placeholder={t('field.lang_instruction')}
            value={school.language_of_instruction}
            onChange={e => u('language_of_instruction', e.target.value)} />
        </div>
        <div className="col-md-2 d-flex align-items-center">
          <button className="remove-btn w-100" onClick={onRemove}>{t('action.remove')}</button>
        </div>
      </div>
    </div>
  );
}

function PersonSection({ person, idx, isFirst, onChange, onRemove, firstPersonId }) {
  const { t } = useTranslation();
  const u = (f, v) => onChange({ ...person, [f]: v });
  const isGuardian  = person.person_type_id === 'guardian';
  const isApplicant = person.person_type_id === 'applicant';

  const handleSameAddress = (checked) => {
    if (checked && firstPersonId) {
      onChange({ ...person, _sameAddress: true, copy_address_from_person_id: firstPersonId });
    } else {
      onChange({ ...person, _sameAddress: false, copy_address_from_person_id: null });
    }
  };

  const updateSchool = (i, val) => {
    const ps = [...(person.previous_schools || [])];
    ps[i] = val;
    u('previous_schools', ps);
  };
  const removeSchool = (i) => {
    const ps = [...(person.previous_schools || [])];
    ps.splice(i, 1);
    u('previous_schools', ps);
  };

  const canCopyAddress = !isFirst && !!firstPersonId;
  const typeLabel = isGuardian
    ? t('guardian.title', { n: idx + 1 })
    : t('applicant.title', { n: idx + 1 });

  return (
    <div className="dynamic-section">
      <div className="dynamic-section-header">
        <span className="dynamic-section-title">
          {typeLabel}
          {person.first_name ? ` — ${person.first_name} ${person.last_name}` : ''}
        </span>
        {!isFirst && <button className="remove-btn" onClick={onRemove}>{t('action.remove')}</button>}
      </div>

      {/* Core fields */}
      <div className="row g-3">
        <div className="col-md-4">
          <label className="form-label">{t('field.first_name')} *</label>
          <input className="form-control" value={person.first_name} onChange={e => u('first_name', e.target.value)} />
        </div>
        <div className="col-md-4">
          <label className="form-label">{t('field.middle_name')}</label>
          <input className="form-control" value={person.middle_name} onChange={e => u('middle_name', e.target.value)} />
        </div>
        <div className="col-md-4">
          <label className="form-label">{t('field.last_name')} *</label>
          <input className="form-control" value={person.last_name} onChange={e => u('last_name', e.target.value)} />
        </div>
        <div className="col-md-3">
          <label className="form-label">{t('field.date_of_birth')}{isApplicant && ' *'}</label>
          <input type="date" className="form-control" value={person.date_of_birth} onChange={e => u('date_of_birth', e.target.value)} />
        </div>
        <div className="col-md-3">
          <label className="form-label">{t('field.gender')}</label>
          <select className="form-select" value={person.gender} onChange={e => u('gender', e.target.value)}>
            <option value="">{t('placeholder.select')}</option>
            <option value="M">{t('gender.m')}</option>
            <option value="F">{t('gender.f')}</option>
            <option value="X">{t('gender.x')}</option>
          </select>
        </div>
        <div className="col-md-3">
          <label className="form-label">{t('field.nationality')}</label>
          <input className="form-control" value={person.nationality} onChange={e => u('nationality', e.target.value)} placeholder={t('placeholder.country_code')} />
        </div>
        <div className="col-md-3">
          <label className="form-label">{t('field.place_of_birth')}</label>
          <input className="form-control" value={person.place_of_birth} onChange={e => u('place_of_birth', e.target.value)} />
        </div>
        <div className="col-md-4">
          <label className="form-label">{t('field.id_type')}</label>
          <select className="form-select" value={person.id_type_id} onChange={e => u('id_type_id', e.target.value)}>
            <option value="">{t('placeholder.select')}</option>
            <option value="passport">{t('id.passport')}</option>
            <option value="dni">{t('id.dni')}</option>
            <option value="nie">{t('id.nie')}</option>
            <option value="other">{t('id.other')}</option>
          </select>
        </div>
        <div className="col-md-4">
          <label className="form-label">{t('field.id_number')}</label>
          <input className="form-control" value={person.id_number} onChange={e => u('id_number', e.target.value)} />
        </div>
      </div>

      {/* Guardian-specific fields */}
      {isGuardian && (
        <div className="row g-3 mt-1">
          <div className="col-12 d-flex gap-4">
            <div className="form-check">
              <input type="checkbox" className="form-check-input" id={`primary_${idx}`}
                checked={person.is_primary_contact} onChange={e => u('is_primary_contact', e.target.checked)} />
              <label className="form-check-label" htmlFor={`primary_${idx}`}>{t('guardian.is_primary')}</label>
            </div>
            <div className="form-check">
              <input type="checkbox" className="form-check-input" id={`emergency_${idx}`}
                checked={person.is_emergency_contact} onChange={e => u('is_emergency_contact', e.target.checked)} />
              <label className="form-check-label" htmlFor={`emergency_${idx}`}>{t('guardian.is_emergency')}</label>
            </div>
          </div>
        </div>
      )}

      {/* Applicant flags */}
      {isApplicant && (
        <div className="mt-3 d-flex flex-wrap gap-3">
          {[
            ['is_sibling',       'applicant.is_sibling'],
            ['is_alumni_family', 'applicant.is_alumni'],
            ['is_transfer',      'applicant.is_transfer'],
          ].map(([field, labelKey]) => (
            <div className="form-check" key={field}>
              <input type="checkbox" className="form-check-input" id={`${field}_${idx}`}
                checked={!!person[field]} onChange={e => u(field, e.target.checked)} />
              <label className="form-check-label" htmlFor={`${field}_${idx}`}>{t(labelKey)}</label>
            </div>
          ))}
        </div>
      )}

      {/* Emails */}
      <div className="mt-3">
        <h6 style={{ color: 'var(--muted)' }}>{t('contact.email')}</h6>
        {(person.emails || []).map((em, i) => (
          <div key={em._uid || i} className="border rounded p-2 mb-2" style={{ background: 'var(--bg)' }}>
            <div className="row g-2 align-items-center">
              <div className="col">
                <input type="email" className="form-control form-control-sm"
                  placeholder="email@example.com"
                  value={em.email_address}
                  onChange={e => {
                    const next = [...person.emails];
                    next[i] = { ...em, email_address: e.target.value };
                    u('emails', next);
                  }} />
              </div>
              <div className="col-auto">
                <div className="form-check form-check-inline mb-0">
                  <input type="checkbox" className="form-check-input" id={`def_em_${idx}_${i}`}
                    checked={em.is_default}
                    onChange={e => {
                      const next = [...person.emails];
                      next[i] = { ...em, is_default: e.target.checked };
                      u('emails', next);
                    }} />
                  <label className="form-check-label small" htmlFor={`def_em_${idx}_${i}`}>{t('contact.is_default')}</label>
                </div>
                <div className="form-check form-check-inline mb-0">
                  <input type="checkbox" className="form-check-input" id={`emg_em_${idx}_${i}`}
                    checked={em.is_emergency}
                    onChange={e => {
                      const next = [...person.emails];
                      next[i] = { ...em, is_emergency: e.target.checked };
                      u('emails', next);
                    }} />
                  <label className="form-check-label small" htmlFor={`emg_em_${idx}_${i}`}>{t('contact.is_emergency')}</label>
                </div>
              </div>
              <div className="col-auto">
                <button className="remove-btn" onClick={() => {
                  const next = [...person.emails];
                  next.splice(i, 1);
                  u('emails', next);
                }}>&times;</button>
              </div>
            </div>
          </div>
        ))}
        <button className="add-btn" onClick={() => u('emails', [...(person.emails || []), emptyEmail()])}>
          <i className="bi bi-plus" /> {t('guardian.add_contact')}
        </button>
      </div>

      {/* Phones */}
      <div className="mt-3">
        <h6 style={{ color: 'var(--muted)' }}>{t('contact.phone')}</h6>
        {(person.phones || []).map((ph, i) => (
          <PhoneRow
            key={ph._uid || i}
            phone={ph}
            idx={`${idx}_${i}`}
            onChange={val => {
              const next = [...person.phones];
              next[i] = val;
              u('phones', next);
            }}
            onRemove={() => {
              const next = [...person.phones];
              next.splice(i, 1);
              u('phones', next);
            }}
          />
        ))}
        <button className="add-btn" onClick={() => u('phones', [...(person.phones || []), emptyPhone()])}>
          <i className="bi bi-plus" /> {t('guardian.add_contact')}
        </button>
      </div>

      {/* Address */}
      <div className="mt-3">
        <div className="d-flex align-items-center gap-3 mb-2">
          <h6 className="mb-0" style={{ color: 'var(--muted)' }}>{t('field.address')}</h6>
          {canCopyAddress && (
            <div className="form-check mb-0">
              <input type="checkbox" className="form-check-input"
                id={`sameAddr_${idx}`}
                checked={person._sameAddress || false}
                onChange={e => handleSameAddress(e.target.checked)} />
              <label className="form-check-label small" htmlFor={`sameAddr_${idx}`}>
                {t('person.same_address_as_first')}
              </label>
            </div>
          )}
        </div>
        {!person._sameAddress && (
          <AddressForm
            address={person.address || emptyAddress()}
            onChange={addr => u('address', addr)}
          />
        )}
      </div>

      {/* Previous schools (applicants only) */}
      {isApplicant && (
        <div className="mt-3">
          <h6 style={{ color: 'var(--muted)' }}>{t('applicant.prev_schools')}</h6>
          {(person.previous_schools || []).map((s, i) => (
            <PreviousSchoolRow key={s._uid || i} school={s}
              onChange={val => updateSchool(i, val)}
              onRemove={() => removeSchool(i)} />
          ))}
          <button className="add-btn" onClick={() => u('previous_schools', [...(person.previous_schools || []), emptySchool()])}>
            <i className="bi bi-plus" /> {t('applicant.add_school')}
          </button>
        </div>
      )}
    </div>
  );
}

/**
 * Transforms a person's flat UI fields into the arrays savePersons_ expects.
 * The person_id is preserved if already set (resume/edit).
 */
function transformPersonForSave(person) {
  const out = { ...person };

  // Nationalities
  out.nationalities = person.nationality
    ? [{ country_id: person.nationality, is_primary: true }]
    : [];
  delete out.nationality;

  // IDs
  out.ids = (person.id_type_id && person.id_number)
    ? [{ id_type_id: person.id_type_id, id_number: person.id_number }]
    : [];
  delete out.id_type_id;
  delete out.id_number;

  // Clean UI-only fields
  delete out._uid;
  delete out._sameAddress;

  return out;
}

export default function Step2Persons({ onNext, onBack }) {
  const { t } = useTranslation();
  const { stepData, updateStep } = useWizard();

  const [persons, setPersons] = useState(() => {
    if (stepData.persons?.length) return stepData.persons;
    return [emptyPerson('guardian'), emptyPerson('applicant')];
  });
  const [err, setErr] = useState('');

  const guardians  = persons.filter(p => p.person_type_id === 'guardian');
  const applicants = persons.filter(p => p.person_type_id === 'applicant');
  const firstPerson = persons[0] || null;
  // ID to copy address from: the first guardian's person_id or _uid
  const firstPersonId = firstPerson ? (firstPerson.person_id || firstPerson._uid) : null;

  const updatePerson = (i, val) => {
    const next = [...persons];
    next[i] = val;
    setPersons(next);
  };

  const addPerson = (type) => setPersons([...persons, emptyPerson(type)]);

  const removePerson = (i) => {
    const next = [...persons];
    next.splice(i, 1);
    setPersons(next);
  };

  const handleNext = () => {
    if (!guardians[0]?.first_name || !guardians[0]?.last_name) {
      setErr(t('error.guardian_required'));
      return;
    }
    if (!applicants[0]?.first_name || !applicants[0]?.last_name) {
      setErr(t('error.applicant_required'));
      return;
    }
    setErr('');
    const transformed = persons.map(transformPersonForSave);
    updateStep('persons', transformed);
    onNext('persons', transformed);
  };

  return (
    <>
      <div className="mb-2">
        <h2 style={{ color: 'var(--teal-dk)', fontWeight: 800 }}>{t('step.persons')}</h2>
        <p style={{ color: 'var(--muted)' }}>{t('step2.subtitle')}</p>
      </div>

      {/* Guardians */}
      <h5 style={{ color: 'var(--teal-dk)', marginTop: 16, marginBottom: 8 }}>
        {t('person.guardians_section')}
      </h5>
      {persons.map((p, i) => {
        if (p.person_type_id !== 'guardian') return null;
        const guardianIdx = guardians.indexOf(p);
        return (
          <PersonSection
            key={p.person_id || p._uid || i}
            person={p}
            idx={guardianIdx}
            isFirst={guardianIdx === 0}
            onChange={val => updatePerson(i, val)}
            onRemove={() => removePerson(i)}
            firstPersonId={firstPersonId}
          />
        );
      })}
      <button className="add-btn" onClick={() => addPerson('guardian')}>
        <i className="bi bi-plus-lg" /> {t('person.add_guardian')}
      </button>

      {/* Applicants */}
      <h5 style={{ color: 'var(--teal-dk)', marginTop: 28, marginBottom: 8 }}>
        {t('person.applicants_section')}
      </h5>
      {persons.map((p, i) => {
        if (p.person_type_id !== 'applicant') return null;
        const applicantIdx = applicants.indexOf(p);
        return (
          <PersonSection
            key={p.person_id || p._uid || i}
            person={p}
            idx={applicantIdx}
            isFirst={applicantIdx === 0}
            onChange={val => updatePerson(i, val)}
            onRemove={() => removePerson(i)}
            firstPersonId={firstPersonId}
          />
        );
      })}
      <button className="add-btn" onClick={() => addPerson('applicant')}>
        <i className="bi bi-plus-lg" /> {t('person.add_applicant')}
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
