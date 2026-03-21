import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useWizard } from '../../context/WizardContext';

const emptyGuardian = () => ({
  _uid:                 Date.now() + Math.random(),
  first_name:           '',
  middle_name:          '',
  last_name:            '',
  date_of_birth:        '',
  place_of_birth:       '',
  nationality_id:       '',
  id_type_id:           '',
  id_number:            '',
  profession:           '',
  employer:             '',
  address_line_1:       '',
  address_line_2:       '',
  city:                 '',
  province:             '',
  country_id:           '',
  zip:                  '',
  is_primary_contact:   false,
  is_emergency_contact: false,
  contacts:             [],
  _sameAddress:         false,
});

const emptyContact = () => ({
  _uid:         Date.now() + Math.random(),
  contact_type: 'phone',
  value:        '',
  is_default:   false,
  is_emergency: false,
  is_whatsapp:  false,
  is_telegram:  false,
});

function ContactRow({ contact, onChange, onRemove, idx }) {
  const { t } = useTranslation();
  return (
    <div className="border rounded p-2 mb-2" style={{ background: 'var(--bg)' }}>
      <div className="row g-2 align-items-center">
        <div className="col-auto">
          <select
            className="form-select form-select-sm"
            value={contact.contact_type}
            onChange={e => onChange({ ...contact, contact_type: e.target.value })}
          >
            <option value="phone">{t('contact.phone')}</option>
            <option value="email">{t('contact.email')}</option>
          </select>
        </div>
        <div className="col">
          <input
            type={contact.contact_type === 'email' ? 'email' : 'tel'}
            className="form-control form-control-sm"
            value={contact.value}
            onChange={e => onChange({ ...contact, value: e.target.value })}
            placeholder={contact.contact_type === 'email' ? 'email@example.com' : '+34 600 000 000'}
          />
        </div>
        {contact.contact_type === 'phone' && (
          <>
            <div className="col-auto">
              <div className="form-check form-check-inline mb-0">
                <input
                  type="checkbox" className="form-check-input"
                  id={`wa_${idx}`}
                  checked={contact.is_whatsapp}
                  onChange={e => onChange({ ...contact, is_whatsapp: e.target.checked })}
                />
                <label className="form-check-label small" htmlFor={`wa_${idx}`}>WhatsApp</label>
              </div>
              <div className="form-check form-check-inline mb-0">
                <input
                  type="checkbox" className="form-check-input"
                  id={`tg_${idx}`}
                  checked={contact.is_telegram}
                  onChange={e => onChange({ ...contact, is_telegram: e.target.checked })}
                />
                <label className="form-check-label small" htmlFor={`tg_${idx}`}>Telegram</label>
              </div>
            </div>
          </>
        )}
        <div className="col-auto">
          <button className="remove-btn" onClick={onRemove}>&times;</button>
        </div>
      </div>
    </div>
  );
}

function GuardianSection({ guardian, idx, isFirst, onChange, onRemove, guardian1 }) {
  const { t } = useTranslation();

  const update = (field, val) => onChange({ ...guardian, [field]: val });

  const handleSameAddress = (checked) => {
    if (checked && guardian1) {
      onChange({
        ...guardian,
        _sameAddress:   true,
        address_line_1: guardian1.address_line_1,
        address_line_2: guardian1.address_line_2,
        city:           guardian1.city,
        province:       guardian1.province,
        country_id:     guardian1.country_id,
        zip:            guardian1.zip,
      });
    } else {
      onChange({ ...guardian, _sameAddress: false });
    }
  };

  const updateContact = (i, val) => {
    const contacts = [...(guardian.contacts || [])];
    contacts[i] = val;
    update('contacts', contacts);
  };
  const removeContact = (i) => {
    const contacts = [...(guardian.contacts || [])];
    contacts.splice(i, 1);
    update('contacts', contacts);
  };
  const addContact = () => update('contacts', [...(guardian.contacts || []), emptyContact()]);

  return (
    <div className="dynamic-section">
      <div className="dynamic-section-header">
        <span className="dynamic-section-title">
          {t('guardian.title', { n: idx + 1 })}
          {guardian.first_name ? ` — ${guardian.first_name} ${guardian.last_name}` : ''}
        </span>
        {!isFirst && <button className="remove-btn" onClick={onRemove}>{t('action.remove')}</button>}
      </div>

      <div className="row g-3">
        <div className="col-md-4">
          <label className="form-label">{t('field.first_name')} *</label>
          <input className="form-control" value={guardian.first_name} onChange={e => update('first_name', e.target.value)} />
        </div>
        <div className="col-md-4">
          <label className="form-label">{t('field.middle_name')}</label>
          <input className="form-control" value={guardian.middle_name} onChange={e => update('middle_name', e.target.value)} />
        </div>
        <div className="col-md-4">
          <label className="form-label">{t('field.last_name')} *</label>
          <input className="form-control" value={guardian.last_name} onChange={e => update('last_name', e.target.value)} />
        </div>
        <div className="col-md-4">
          <label className="form-label">{t('field.date_of_birth')}</label>
          <input type="date" className="form-control" value={guardian.date_of_birth} onChange={e => update('date_of_birth', e.target.value)} />
        </div>
        <div className="col-md-4">
          <label className="form-label">{t('field.place_of_birth')}</label>
          <input className="form-control" value={guardian.place_of_birth} onChange={e => update('place_of_birth', e.target.value)} />
        </div>
        <div className="col-md-4">
          <label className="form-label">{t('field.nationality')}</label>
          <input className="form-control" value={guardian.nationality_id} onChange={e => update('nationality_id', e.target.value)} placeholder={t('placeholder.country_code')} />
        </div>
        <div className="col-md-4">
          <label className="form-label">{t('field.id_type')}</label>
          <select className="form-select" value={guardian.id_type_id} onChange={e => update('id_type_id', e.target.value)}>
            <option value="">{t('placeholder.select')}</option>
            <option value="passport">{t('id.passport')}</option>
            <option value="dni">{t('id.dni')}</option>
            <option value="nie">{t('id.nie')}</option>
            <option value="other">{t('id.other')}</option>
          </select>
        </div>
        <div className="col-md-4">
          <label className="form-label">{t('field.id_number')}</label>
          <input className="form-control" value={guardian.id_number} onChange={e => update('id_number', e.target.value)} />
        </div>
        <div className="col-md-4">
          <label className="form-label">{t('field.profession')}</label>
          <input className="form-control" value={guardian.profession} onChange={e => update('profession', e.target.value)} />
        </div>
        <div className="col-md-6">
          <label className="form-label">{t('field.employer')}</label>
          <input className="form-control" value={guardian.employer} onChange={e => update('employer', e.target.value)} />
        </div>
      </div>

      {/* Address */}
      <div className="mt-3">
        <div className="d-flex align-items-center gap-3 mb-2">
          <h6 className="mb-0" style={{ color: 'var(--muted)' }}>{t('guardian.address')}</h6>
          {!isFirst && (
            <div className="form-check mb-0">
              <input
                type="checkbox" className="form-check-input"
                id={`sameAddr_${idx}`}
                checked={guardian._sameAddress || false}
                onChange={e => handleSameAddress(e.target.checked)}
              />
              <label className="form-check-label small" htmlFor={`sameAddr_${idx}`}>
                {t('guardian.same_as_1')}
              </label>
            </div>
          )}
        </div>
        <div className="row g-3">
          <div className="col-12">
            <label className="form-label">{t('field.address_line_1')}</label>
            <input className="form-control" value={guardian.address_line_1} disabled={guardian._sameAddress} onChange={e => update('address_line_1', e.target.value)} />
          </div>
          <div className="col-12">
            <label className="form-label">{t('field.address_line_2')}</label>
            <input className="form-control" value={guardian.address_line_2} disabled={guardian._sameAddress} onChange={e => update('address_line_2', e.target.value)} />
          </div>
          <div className="col-md-4">
            <label className="form-label">{t('field.city')}</label>
            <input className="form-control" value={guardian.city} disabled={guardian._sameAddress} onChange={e => update('city', e.target.value)} />
          </div>
          <div className="col-md-3">
            <label className="form-label">{t('field.province')}</label>
            <input className="form-control" value={guardian.province} disabled={guardian._sameAddress} onChange={e => update('province', e.target.value)} />
          </div>
          <div className="col-md-3">
            <label className="form-label">{t('field.country')}</label>
            <input className="form-control" value={guardian.country_id} disabled={guardian._sameAddress} onChange={e => update('country_id', e.target.value)} placeholder={t('placeholder.country_code')} />
          </div>
          <div className="col-md-2">
            <label className="form-label">{t('field.zip')}</label>
            <input className="form-control" value={guardian.zip} disabled={guardian._sameAddress} onChange={e => update('zip', e.target.value)} />
          </div>
        </div>
      </div>

      {/* Roles */}
      <div className="mt-3 d-flex gap-4">
        <div className="form-check">
          <input type="checkbox" className="form-check-input" id={`primary_${idx}`}
            checked={guardian.is_primary_contact} onChange={e => update('is_primary_contact', e.target.checked)} />
          <label className="form-check-label" htmlFor={`primary_${idx}`}>{t('guardian.is_primary')}</label>
        </div>
        <div className="form-check">
          <input type="checkbox" className="form-check-input" id={`emergency_${idx}`}
            checked={guardian.is_emergency_contact} onChange={e => update('is_emergency_contact', e.target.checked)} />
          <label className="form-check-label" htmlFor={`emergency_${idx}`}>{t('guardian.is_emergency')}</label>
        </div>
      </div>

      {/* Contacts */}
      <div className="mt-3">
        <h6 style={{ color: 'var(--muted)' }}>{t('guardian.contacts')}</h6>
        {(guardian.contacts || []).map((c, i) => (
          <ContactRow
            key={c._uid || i}
            contact={c}
            idx={`${idx}_${i}`}
            onChange={val => updateContact(i, val)}
            onRemove={() => removeContact(i)}
          />
        ))}
        <button className="add-btn" onClick={addContact}>
          <i className="bi bi-plus" /> {t('guardian.add_contact')}
        </button>
      </div>
    </div>
  );
}

export default function Step2Guardians({ onNext, onBack }) {
  const { t } = useTranslation();
  const { stepData, updateStep } = useWizard();
  const [guardians, setGuardians] = useState(
    stepData.guardians?.length ? stepData.guardians : [emptyGuardian()]
  );

  const [err, setErr] = useState('');

  const updateGuardian = (i, val) => {
    const next = [...guardians];
    next[i] = val;
    setGuardians(next);
  };
  const addGuardian = () => setGuardians([...guardians, emptyGuardian()]);
  const removeGuardian = (i) => {
    const next = [...guardians];
    next.splice(i, 1);
    setGuardians(next);
  };

  const handleNext = () => {
    if (!guardians[0]?.first_name || !guardians[0]?.last_name) {
      setErr(t('error.guardian_required'));
      return;
    }
    setErr('');
    updateStep('guardians', guardians);
    onNext('guardians', guardians);
  };

  return (
    <>
      <div className="mb-2">
        <h2 style={{ color: 'var(--teal-dk)', fontWeight: 800 }}>{t('step.guardians')}</h2>
        <p style={{ color: 'var(--muted)' }}>{t('step2.subtitle')}</p>
      </div>

      {guardians.map((g, i) => (
        <GuardianSection
          key={g._uid || i}
          guardian={g}
          idx={i}
          isFirst={i === 0}
          onChange={val => updateGuardian(i, val)}
          onRemove={() => removeGuardian(i)}
          guardian1={guardians[0]}
        />
      ))}

      <button className="add-btn" onClick={addGuardian}>
        <i className="bi bi-plus-lg" /> {t('guardian.add')}
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
