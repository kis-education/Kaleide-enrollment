import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useWizard } from '../../context/WizardContext';
import AddressForm, { emptyAddress } from '../../components/AddressForm';
import { COUNTRIES } from '../../constants/countries';
import LockedBanner from '../../components/LockedBanner';

const EMAIL_TYPES = ['personal', 'work', 'emergency'];
const PHONE_TYPES = ['mobile', 'home', 'work'];

const emptyPerson = (type) => ({
  _uid:                        Date.now() + Math.random(),
  person_type_id:              type,
  first_name:                  '',
  middle_name:                 '',
  last_name:                   '',
  date_of_birth:               '',
  place_of_birth:              '',
  gender:                      '',
  nationality:                 '',
  id_type_id:                  '',
  id_number:                   '',
  emails:                      [],
  phones:                      [],
  previous_schools:            [],
  address:                     emptyAddress(),
  _sameAddress:                false,
  copy_address_from_person_id: null,
});

const emptyEmail = () => ({
  _uid: Date.now() + Math.random(),
  email_address: '',
  email_type_id: '',
  is_default: false,
  is_emergency: false,
});

const emptyPhone = () => ({
  _uid: Date.now() + Math.random(),
  phone_number: '',
  phone_type_id: '',
  is_default: false,
  is_emergency: false,
  is_whatsapp: false,
  is_telegram: false,
});

const emptySchool = () => ({
  _uid: Date.now() + Math.random(),
  school_name: '',
  city: '',
  country_id: '',
  from_year: '',
  to_year: '',
  education_level_description: '',
  language_of_instruction: '',
});

function PhoneRow({ phone, idx, onChange, onRemove }) {
  const { t } = useTranslation();
  const update = (fields) => onChange({ ...phone, ...fields });
  return (
    <div className="border rounded p-2 mb-2" style={{ background: 'var(--bg)' }}>
      <div className="row g-2 align-items-center mb-2">
        <div className="col-auto" style={{ minWidth: 120 }}>
          <select className="form-select form-select-sm" value={phone.phone_type_id || ''}
            onChange={e => update({ phone_type_id: e.target.value })}>
            <option value="">{t('placeholder.select')}</option>
            {PHONE_TYPES.map(pt => <option key={pt} value={pt}>{t(`phone_type.${pt}`)}</option>)}
          </select>
        </div>
        <div className="col">
          <input type="tel" className="form-control form-control-sm"
            placeholder="+34 600 000 000"
            value={phone.phone_number}
            onChange={e => update({ phone_number: e.target.value })} />
        </div>
        <div className="col-auto">
          <button className="remove-btn" onClick={onRemove}>&times;</button>
        </div>
      </div>
      <div className="d-flex gap-3 flex-wrap">
        <div className="form-check mb-0">
          <input type="checkbox" className="form-check-input" id={`def_ph_${idx}`}
            checked={phone.is_default}
            onChange={e => update({ is_default: e.target.checked, is_emergency: e.target.checked ? false : phone.is_emergency })} />
          <label className="form-check-label small" htmlFor={`def_ph_${idx}`}>{t('contact.is_default')}</label>
        </div>
        <div className="form-check mb-0">
          <input type="checkbox" className="form-check-input" id={`emerg_ph_${idx}`}
            checked={phone.is_emergency}
            onChange={e => update({ is_emergency: e.target.checked, is_default: e.target.checked ? false : phone.is_default })} />
          <label className="form-check-label small" htmlFor={`emerg_ph_${idx}`}>{t('contact.is_emergency')}</label>
        </div>
        <div className="form-check mb-0">
          <input type="checkbox" className="form-check-input" id={`wa_${idx}`}
            checked={phone.is_whatsapp} onChange={e => update({ is_whatsapp: e.target.checked })} />
          <label className="form-check-label small" htmlFor={`wa_${idx}`}>WhatsApp</label>
        </div>
        <div className="form-check mb-0">
          <input type="checkbox" className="form-check-input" id={`tg_${idx}`}
            checked={phone.is_telegram} onChange={e => update({ is_telegram: e.target.checked })} />
          <label className="form-check-label small" htmlFor={`tg_${idx}`}>Telegram</label>
        </div>
      </div>
    </div>
  );
}

function PreviousSchoolRow({ school, onChange, onRemove, birthYear }) {
  const { t } = useTranslation();
  const u = (f, v) => onChange({ ...school, [f]: v });
  const currentYear = new Date().getFullYear();
  const minYear     = birthYear || currentYear - 30;
  const fromYear    = parseInt(school.from_year) || null;
  const minToYear   = fromYear ? Math.max(minYear, fromYear) : minYear;

  const yearRange = (min, max) =>
    Array.from({ length: max - min + 1 }, (_, i) => max - i);

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
        <div className="col-md-4">
          <select className="form-select form-select-sm" value={school.country_id}
            onChange={e => u('country_id', e.target.value)}>
            <option value="">{t('field.country')}</option>
            {COUNTRIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
        </div>
        <div className="col-md-2">
          <select className="form-select form-select-sm" value={school.from_year || ''}
            onChange={e => {
              const val = e.target.value;
              const updates = { from_year: val };
              if (school.to_year && parseInt(school.to_year) < parseInt(val)) updates.to_year = val;
              onChange({ ...school, ...updates });
            }}>
            <option value="">{t('field.from_year')}</option>
            {yearRange(minYear, currentYear).map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <div className="col-md-2">
          <select className="form-select form-select-sm" value={school.to_year || ''}
            onChange={e => u('to_year', e.target.value)}>
            <option value="">{t('field.to_year')}</option>
            {yearRange(minToYear, currentYear).map(y => <option key={y} value={y}>{y}</option>)}
          </select>
        </div>
        <div className="col-md-4">
          <input className="form-control form-control-sm" placeholder={t('field.edu_level_desc')}
            value={school.education_level_description}
            onChange={e => u('education_level_description', e.target.value)} />
        </div>
        <div className="col-md-2">
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

function PersonSection({ person, idx, isFirst, onChange, onRemove, firstPersonId, primaryEmail }) {
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

  // Single-default enforcement for emails
  const updateEmail = (i, updated) => {
    const next = (person.emails || []).map((e, j) =>
      j === i ? updated : (updated.is_default ? { ...e, is_default: false } : e)
    );
    u('emails', next);
  };
  const removeEmail = (i) => {
    const next = [...(person.emails || [])];
    next.splice(i, 1);
    u('emails', next);
  };

  // Single-default enforcement for phones
  const updatePhone = (i, updated) => {
    const next = (person.phones || []).map((p, j) =>
      j === i ? updated : (updated.is_default ? { ...p, is_default: false } : p)
    );
    u('phones', next);
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

  const canCopyAddress = (isApplicant || !isFirst) && !!firstPersonId;
  const typeLabel = isGuardian
    ? t('guardian.title', { n: idx + 1 })
    : t('applicant.title', { n: idx + 1 });

  const canUseAppEmail = isGuardian && isFirst && !!primaryEmail && (person.emails || []).length === 0;

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
          {isApplicant && person.date_of_birth && (() => {
            const ms = Date.now() - new Date(person.date_of_birth);
            const yrs = Math.floor(ms / (365.25 * 24 * 3600 * 1000));
            const mos = Math.floor((ms % (365.25 * 24 * 3600 * 1000)) / (30.44 * 24 * 3600 * 1000));
            return <div className="form-text">{yrs}y {mos}m</div>;
          })()}
        </div>
        <div className="col-md-3">
          <label className="form-label">{t('field.gender')}</label>
          <select className="form-select" value={person.gender} onChange={e => u('gender', e.target.value)}>
            <option value="">{t('placeholder.select')}</option>
            <option value="Male">{t('gender.m')}</option>
            <option value="Female">{t('gender.f')}</option>
            <option value="Non-binary">{t('gender.nonbinary')}</option>
            <option value="Prefer-not-to-say">{t('gender.prefer_not_to_say')}</option>
          </select>
        </div>
        <div className="col-md-3">
          <label className="form-label">{t('field.nationality')}</label>
          <select className="form-select" value={person.nationality} onChange={e => u('nationality', e.target.value)}>
            <option value="">{t('placeholder.select')}</option>
            {COUNTRIES.map(c => <option key={c.value} value={c.value}>{c.label}</option>)}
          </select>
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

      {/* Emails */}
      <div className="mt-3">
        <h6 style={{ color: 'var(--muted)' }}>{t('contact.email')}</h6>
        <p className="form-text mb-2" style={{ fontSize: '0.8rem' }}>{t('contact.emergency_note')}</p>
        {canUseAppEmail && (
          <button className="add-btn mb-2" onClick={() => u('emails', [{
            ...emptyEmail(), email_address: primaryEmail, email_type_id: 'personal', is_default: true,
          }])}>
            <i className="bi bi-envelope-fill me-1" /> {t('guardian.use_app_email')}
          </button>
        )}
        {(person.emails || []).map((em, i) => (
          <div key={em._uid || i} className="border rounded p-2 mb-2" style={{ background: 'var(--bg)' }}>
            <div className="row g-2 align-items-center">
              <div className="col-auto" style={{ minWidth: 140 }}>
                <select className="form-select form-select-sm" value={em.email_type_id || ''}
                  onChange={e => updateEmail(i, { ...em, email_type_id: e.target.value })}>
                  <option value="">{t('placeholder.select')}</option>
                  {EMAIL_TYPES.map(et => <option key={et} value={et}>{t(`email_type.${et}`)}</option>)}
                </select>
              </div>
              <div className="col">
                <input type="email" className="form-control form-control-sm"
                  placeholder="email@example.com"
                  value={em.email_address}
                  onChange={e => updateEmail(i, { ...em, email_address: e.target.value })} />
              </div>
              <div className="col-auto">
                <div className="form-check form-check-inline mb-0">
                  <input type="checkbox" className="form-check-input" id={`def_em_${idx}_${i}`}
                    checked={em.is_default}
                    onChange={e => updateEmail(i, { ...em, is_default: e.target.checked })} />
                  <label className="form-check-label small" htmlFor={`def_em_${idx}_${i}`}>{t('contact.is_default')}</label>
                </div>
              </div>
              <div className="col-auto">
                <button className="remove-btn" onClick={() => removeEmail(i)}>&times;</button>
              </div>
            </div>
          </div>
        ))}
        <button className="add-btn" onClick={() => u('emails', [...(person.emails || []), emptyEmail()])}>
          <i className="bi bi-plus" /> {t('contact.add_email')}
        </button>
      </div>

      {/* Phones */}
      <div className="mt-3">
        <h6 style={{ color: 'var(--muted)' }}>{t('contact.phone')}</h6>
        <p className="form-text mb-2" style={{ fontSize: '0.8rem' }}>{t('contact.emergency_note')}</p>
        {(person.phones || []).map((ph, i) => (
          <PhoneRow
            key={ph._uid || i}
            phone={ph}
            idx={`${idx}_${i}`}
            onChange={val => updatePhone(i, val)}
            onRemove={() => {
              const next = [...person.phones];
              next.splice(i, 1);
              u('phones', next);
            }}
          />
        ))}
        <button className="add-btn" onClick={() => u('phones', [...(person.phones || []), emptyPhone()])}>
          <i className="bi bi-plus" /> {t('contact.add_phone')}
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
          {(() => {
            const birthYear = person.date_of_birth
              ? new Date(person.date_of_birth).getFullYear() : null;
            const dobMissing = !birthYear;
            return (
              <>
                {(person.previous_schools || []).map((s, i) => (
                  <PreviousSchoolRow key={s._uid || i} school={s}
                    birthYear={birthYear}
                    onChange={val => updateSchool(i, val)}
                    onRemove={() => removeSchool(i)} />
                ))}
                <button className="add-btn"
                  disabled={dobMissing}
                  title={dobMissing ? t('applicant.dob_required_for_school') : undefined}
                  onClick={() => u('previous_schools', [...(person.previous_schools || []), emptySchool()])}>
                  <i className="bi bi-plus" /> {t('applicant.add_school')}
                </button>
                {dobMissing && (
                  <p className="small mt-1" style={{ color: 'var(--muted)' }}>
                    {t('applicant.dob_required_for_school')}
                  </p>
                )}
              </>
            );
          })()}
        </div>
      )}
    </div>
  );
}

/**
 * Converts a stored/resumed person (arrays) back to the flat UI fields that
 * PersonSection uses (nationality, id_type_id, id_number).
 */
function preparePersonForUI(person) {
  const out = { ...person };
  // nationality: prefer existing flat field; fall back to first nationality in array
  if (!out.nationality) {
    const primary = (out.nationalities || [])[0];
    out.nationality = primary ? (primary.nationality_id || primary.country_id || '') : '';
  }
  // id_type_id / id_number: prefer existing flat fields; fall back to first id in array
  // _id_record_id carries the existing DB record_id so transformPersonForSave can skip re-creation
  if (!out.id_type_id) {
    const firstId = (out.ids || [])[0];
    out.id_type_id    = firstId ? firstId.id_type_id : '';
    out.id_number     = firstId ? firstId.id_number  : '';
    out._id_record_id = firstId ? firstId.record_id  : null;
  }
  // _nat_record_id carries the existing DB record_id for the nationality
  if (!out.nationality) {
    const primary = (out.nationalities || [])[0];
    out.nationality    = primary ? (primary.nationality_id || primary.country_id || '') : '';
    out._nat_record_id = primary ? primary.record_id : null;
  } else {
    // flat nationality already set (e.g. first render from stepData) — still try to pick up record_id
    if (!out._nat_record_id) {
      const primary = (out.nationalities || [])[0];
      out._nat_record_id = primary ? primary.record_id : null;
    }
  }
  // Remap server field names to UI field names for phones and emails
  if (Array.isArray(out.phones)) {
    out.phones = out.phones.map(ph => ({
      ...ph,
      phone_number:  ph.phone_number  || ph.value            || '',
      phone_type_id: ph.phone_type_id || ph.phone_nr_type_id || '',
    }));
  }
  if (Array.isArray(out.emails)) {
    out.emails = out.emails.map(e => ({
      ...e,
      email_address: e.email_address || e.value || '',
    }));
  }
  return out;
}

/**
 * Transforms a person's flat UI fields into the arrays savePersons_ expects.
 * NOTE: _uid is intentionally preserved — Step3Relations depends on it to
 * build unique guardian_person_id keys before the backend assigns person_id.
 */
function transformPersonForSave(person) {
  const out = { ...person };

  out.nationalities = person.nationality
    ? [{ ...(person._nat_record_id ? { record_id: person._nat_record_id } : {}), nationality_id: person.nationality }]
    : [];
  delete out.nationality;
  delete out._nat_record_id;

  out.ids = (person.id_type_id && person.id_number)
    ? [{ ...(person._id_record_id ? { record_id: person._id_record_id } : {}), id_type_id: person.id_type_id, id_number: person.id_number }]
    : [];
  delete out.id_type_id;
  delete out.id_number;
  delete out._id_record_id;

  delete out._sameAddress;

  return out;
}

export default function Step2Persons({ onNext, onBack, locked, onUnlock }) {
  const { t } = useTranslation();
  const { stepData, updateStep } = useWizard();
  const primaryEmail = stepData.email?.primary_email || '';

  const [persons, setPersons] = useState(() => {
    if (stepData.persons?.length) return stepData.persons.map(preparePersonForUI);
    return [emptyPerson('guardian'), emptyPerson('applicant')];
  });
  const [err, setErr] = useState('');

  const guardians  = persons.filter(p => p.person_type_id === 'guardian');
  const applicants = persons.filter(p => p.person_type_id === 'applicant');
  const firstPerson = persons[0] || null;
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

  const handleBack = () => {
    updateStep('persons', persons.map(transformPersonForSave));
    onBack();
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

      {locked && <LockedBanner onUnlock={onUnlock} />}

      <fieldset disabled={locked} style={{ border: 'none', padding: 0, margin: 0 }}>
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
              primaryEmail={primaryEmail}
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
              primaryEmail={primaryEmail}
            />
          );
        })}
        <button className="add-btn" onClick={() => addPerson('applicant')}>
          <i className="bi bi-plus-lg" /> {t('person.add_applicant')}
        </button>

        {err && <div className="field-error mt-2">{err}</div>}
      </fieldset>

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
