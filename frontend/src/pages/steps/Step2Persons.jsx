import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useWizard } from '../../context/WizardContext';
import * as log from '../../logger';
import AddressForm, { emptyAddress } from '../../components/AddressForm';
import { COUNTRIES } from '../../constants/countries';
import LockedBanner from '../../components/LockedBanner';
import StepNav from '../../components/StepNav';
import { generateUuid } from '../../utils/uuid';
import { validatePhone } from '../../utils/phone';

const EMAIL_TYPES = ['personal', 'work', 'emergency'];
const PHONE_TYPES = ['mobile', 'home', 'work'];

// CLI 8 (DL-E39 ENMIENDA 3): versión del texto de atestación de tutor único. Se
// registra junto al acto (attestant + timestamp) para trazabilidad legal; bumpea si
// cambia el texto de la atestación.
const SOLE_GUARDIAN_ATTESTATION_VERSION = 'v1';

// Email efectivo de un tutor (normalizado lowercase/trim): el default, o el primero.
function guardianEmail_(p) {
  const list = p && Array.isArray(p.emails) ? p.emails : [];
  const def = list.find(e => e && (e.is_default === true || e.is_default === 'true'));
  const chosen = def || list[0] || null;
  const raw = chosen ? (chosen.email_address || chosen.value || '') : '';
  return String(raw).trim().toLowerCase();
}

// person_id generated client-side at creation. Backend savePersons_ accepts
// the provided id (`person.person_id || generateUuid_()`), so the round-trip
// returns the same id — no stamping needed. Step3Relations can reference
// these persons by person_id from the moment they exist, eliminating the
// optimistic-UI race where the temp _uid would otherwise be used downstream.
// _uid is preserved for backwards-compat (React keys in legacy components
// and the personIdMap fallback in WizardPage handle the very edge case of
// a resumed session that pre-dates this change).
const emptyPerson = (type) => ({
  _uid:                        Date.now() + Math.random(),
  person_id:                   generateUuid(),
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

// D (selector de país): detecta el país de un número legacy SIN '+' por su prefijo de
// marcación. Elige el `dial` MÁS LARGO que prefije el número (varios países comparten
// dial, p.ej. '1' US/CA → gana el match de prefijo más largo; con empate, el primero de
// COUNTRIES). REUTILIZA COUNTRIES (no se crea otra lista). Devuelve ISO alpha-2 o ''.
function detectCountryByDial(rawInput) {
  const digits = (rawInput || '').replace(/\D/g, '');
  if (!digits) return '';
  let best = '', bestLen = 0;
  for (const c of COUNTRIES) {
    if (c.dial && digits.startsWith(c.dial) && c.dial.length > bestLen) {
      best = c.value; bestLen = c.dial.length;
    }
  }
  return best;
}

// D: construye el mejor input para `validatePhone` usando el país del selector, SIN tocar
// phone.js (la normalización/validación E.164 + set cerrado DL-E40 quedan intactas — solo
// CONSTRUIMOS mejor el input). Fallback ordenado: (1) si el usuario escribe con '+' →
// internacional explícito; (2) si hay país elegido → nacional con ese país; (3) caso legacy
// 11-díg internacional sin '+' (p.ej. 34609211201 con país ES) → si el número empieza por el
// dial del país y el nacional falla, reintenta como +<numerocompleto>; (4) sin país → cae al
// country de la dirección (comportamiento previo). El valor persistido sigue siendo res.e164.
function resolvePhoneValidation(rawInput, phoneCountry, countryISO) {
  const raw = (rawInput || '').trim();
  if (!raw) return validatePhone(raw, phoneCountry || countryISO || '');
  if (raw.startsWith('+')) return validatePhone(raw, '');           // internacional explícito
  if (phoneCountry) {
    const res = validatePhone(raw, phoneCountry);                   // nacional con el país elegido
    if (res.valid) return res;
    const dial = COUNTRIES.find(c => c.value === phoneCountry)?.dial;
    const digits = raw.replace(/\D/g, '');
    if (dial && digits.startsWith(dial)) {                          // legacy internacional sin '+'
      const intl = validatePhone('+' + digits, '');
      if (intl.valid) return intl;
    }
    return res;                                                     // ya pasamos country → no needCountry muerto
  }
  return validatePhone(raw, countryISO || '');                      // sin país elegido: country de la dirección
}

function PhoneRow({ phone, idx, countryISO, onChange, onRemove }) {
  const { t } = useTranslation();
  const [touched, setTouched] = useState(false);
  // IMPL-G: separar el DIAL (desplegable de país) del NÚMERO NACIONAL (input). El valor
  // PERSISTIDO sigue siendo E.164 completo en `phone.phone_number` (contrato intacto); el
  // dial vive SOLO en el desplegable y el input muestra SOLO el número nacional, sin '+'.
  // Derivación de montaje: a partir del E.164 persistido (o legacy sin '+') se reparte en
  // { país del desplegable, número nacional del input } detectando el dial MÁS LARGO que
  // prefija (reutiliza detectCountryByDial/COUNTRIES — no se inventa lista).
  const deriveFromPersisted = () => {
    const digits = (phone.phone_number || '').replace(/\D/g, '');
    if (digits) {
      const detected = detectCountryByDial(digits);   // legacy '+34…' o '34…' → país por dial
      if (detected) {
        const dial = COUNTRIES.find(c => c.value === detected)?.dial || '';
        return { country: detected, national: digits.slice(dial.length) };
      }
      // Sin dial detectable: el desplegable cae al país de la dirección; el input muestra
      // los dígitos tal cual (NUNCA con '+').
      return { country: countryISO || '', national: digits };
    }
    return { country: countryISO || '', national: '' };
  };
  const initial = deriveFromPersisted();
  const [phoneCountry, setPhoneCountry] = useState(initial.country);
  const [nationalNumber, setNationalNumber] = useState(initial.national);
  const update = (fields) => onChange({ ...phone, ...fields });

  // IMPL-G: construye el candidato internacional combinando (dial del desplegable) +
  // (número nacional del input) → +<dial><national>; sin dial cae al país de la dirección.
  // La normalización/validación E.164 + set cerrado DL-E40 las sigue haciendo validatePhone
  // (vía resolvePhoneValidation) — phone.js NO se toca. El input NUNCA contiene el dial.
  const selDial = COUNTRIES.find(c => c.value === phoneCountry)?.dial || '';
  const national = nationalNumber.trim();
  const candidate = national
    ? (selDial ? '+' + selDial + national.replace(/\D/g, '') : national)
    : '';
  const res = resolvePhoneValidation(candidate, phoneCountry, countryISO);
  const showError = touched && national && !res.valid;
  const errKey = res.needCountry  ? 'step2.phone.country_needed'
               : res.notInSet     ? 'step2.phone.unsupported_country'
               :                     'step2.phone.invalid';

  const handleBlur = () => {
    setTouched(true);
    // Input vacío → persistir vacío; NUNCA re-inyectar el dial.
    if (!national) {
      if (phone.phone_number) update({ phone_number: '' });
      return;
    }
    // Al salir del campo, si es válido persistimos el valor NORMALIZADO a E.164.
    if (res.valid && res.e164 && res.e164 !== phone.phone_number) {
      update({ phone_number: res.e164 });
    }
  };

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
        {/* D: selector de país/prefijo en la misma fila — da el camino para corregir un
            número legacy in-place. Poblado de COUNTRIES (no otra lista). */}
        <div className="col-auto" style={{ minWidth: 150 }}>
          <select className="form-select form-select-sm" value={phoneCountry}
            aria-label={t('field.phone_country')}
            onChange={e => setPhoneCountry(e.target.value)}>
            <option value="">{t('field.phone_country')}</option>
            {COUNTRIES.map(c => <option key={c.value} value={c.value}>{c.label} (+{c.dial})</option>)}
          </select>
        </div>
        <div className="col">
          <input type="tel"
            className={'form-control form-control-sm' + (showError ? ' is-invalid' : '')}
            aria-invalid={showError ? 'true' : undefined}
            placeholder="600 000 000"
            value={nationalNumber}
            onChange={e => setNationalNumber(e.target.value)}
            onBlur={handleBlur} />
          {showError && <div className="field-error" style={{ fontSize: '0.78rem' }}>{t(errKey)}</div>}
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

function PersonSection({ person, idx, isFirst, onChange, onRemove, firstPersonId, primaryEmail, invalidFields = {}, onFieldEdit }) {
  const { t } = useTranslation();
  // UX-2: resaltado por-campo. `inv(field)` consulta si está marcado inválido; editar un
  // campo lo limpia (vía onFieldEdit, subido al estado del padre).
  const _pk = person.person_id || person._uid;
  const inv = (f) => !!invalidFields[`${_pk}:${f}`];
  const u = (f, v) => { if (onFieldEdit) onFieldEdit(`${_pk}:${f}`); onChange({ ...person, [f]: v }); };
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
          <input className={'form-control' + (inv('first_name') ? ' is-invalid' : '')} aria-invalid={inv('first_name') ? 'true' : undefined}
            value={person.first_name} onChange={e => u('first_name', e.target.value)} />
        </div>
        <div className="col-md-4">
          <label className="form-label">{t('field.middle_name')}</label>
          <input className="form-control" value={person.middle_name} onChange={e => u('middle_name', e.target.value)} />
        </div>
        <div className="col-md-4">
          <label className="form-label">{t('field.last_name')} *</label>
          <input className={'form-control' + (inv('last_name') ? ' is-invalid' : '')} aria-invalid={inv('last_name') ? 'true' : undefined}
            value={person.last_name} onChange={e => u('last_name', e.target.value)} />
        </div>
        <div className="col-md-3">
          <label className="form-label">{t('field.date_of_birth')}{isApplicant && ' *'}</label>
          {/* DL-E39 ENMIENDA (gate de entrada): DOB visible — PII protegida por el gate de entrada. */}
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
          {/* DL-E39 ENMIENDA (gate de entrada): nº de identidad visible — PII protegida por el gate de entrada. */}
          <input className="form-control" value={person.id_number} onChange={e => u('id_number', e.target.value)} />
        </div>
      </div>

      {/* Emails */}
      <div className="mt-3">
        <h6 style={{ color: 'var(--muted)' }}>{t('contact.email')}</h6>
        <p className="form-text mb-2" style={{ fontSize: '0.8rem' }}>{t('contact.emergency_note')}</p>
        {/* CLI 8 (DL-E42): el email de cada tutor es su credencial de identidad
            per-guardian (recuperación + firma + decisiones legales a su nombre) →
            por eso los emails de distintos tutores deben ser distintos. */}
        {isGuardian && (
          <div className="alert alert-light border d-flex align-items-start gap-2 mb-2 py-2 px-2"
               style={{ fontSize: '0.8rem', borderLeft: '3px solid var(--teal)' }}>
            <i className="bi bi-shield-lock" style={{ color: 'var(--teal)' }} />
            <span>{t('step2.identity_note')}</span>
          </div>
        )}
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
            countryISO={person.address?.country_id || ''}
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
          /* DL-E39 ENMIENDA (gate de entrada): dirección visible — PII protegida por el gate de entrada. */
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
// AppSheet returns booleans as strings "TRUE" / "FALSE". Normalise to real
// JS booleans so checkbox `checked` and conditional renders work correctly.
function parseBool(val) {
  if (typeof val === 'boolean') return val;
  // P89 — handle both AppSheet formats: "TRUE"/"FALSE" and "Y"/"N"
  if (typeof val === 'string') { const l = val.toLowerCase(); return l === 'true' || l === 'y' || val === '1'; }
  return Boolean(val);
}

// ─── #6: re-derivación del checkbox "Mismo domicilio que Tutor 1" ─────────────
// `_sameAddress` es estado UI-only (transformPersonForSave lo borra), así que al
// re-sembrar el paso (rehidratación tras resume, o volver al Step 2 en sesión) se
// perdía y aparecían los campos de domicilio duplicados aunque el domicilio fuera
// el mismo. Estos helpers re-derivan el estado del checkbox en la siembra:
//  (a) por igualdad de domicilio campo a campo (normalizando trim/case) con la
//      primera persona, o
//  (b) por la marca in-session `copy_address_from_person_id` (presente en stepData
//      cuando el usuario marcó el checkbox en esta sesión; el server no la devuelve).
// Campos canónicos del domicilio = los de AddressForm/emptyAddress (enrAddresses).
const ADDRESS_FIELDS = ['address_line_1', 'address_line_2', 'city', 'province', 'country_id', 'zip'];
const normalizedAddress_ = (a) =>
  ADDRESS_FIELDS.map(f => String((a && a[f]) || '').trim().toLowerCase()).join('|');
const addressIsEmpty_ = (a) =>
  ADDRESS_FIELDS.every(f => !String((a && a[f]) || '').trim());

function deriveSameAddressFlags(list) {
  if (!Array.isArray(list) || !list.length) return list;
  const first = list[0];
  const firstKey   = first ? (first.person_id || first._uid || null) : null;
  const firstNorm  = normalizedAddress_(first && first.address);
  const firstEmpty = addressIsEmpty_(first && first.address);
  return list.map((p, i) => {
    if (i === 0 || !p || p._sameAddress) return p;
    const byCopyRef  = !!p.copy_address_from_person_id && p.copy_address_from_person_id === firstKey;
    const byEquality = !firstEmpty && normalizedAddress_(p.address) === firstNorm;
    if (!byCopyRef && !byEquality) return p;
    log.debug('Step2: re-derived _sameAddress on seed', { idx: i, byCopyRef, byEquality });
    return { ...p, _sameAddress: true };
  });
}

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
  // Remap server field names to UI field names for phones and emails.
  // Also normalise boolean fields: AppSheet stores them as "TRUE"/"FALSE" strings.
  if (Array.isArray(out.phones)) {
    out.phones = out.phones.map(ph => ({
      ...ph,
      phone_number:  ph.phone_number  || ph.value            || '',
      phone_type_id: ph.phone_type_id || ph.phone_nr_type_id || '',
      is_default:    parseBool(ph.is_default),
      is_emergency:  parseBool(ph.is_emergency),
      is_whatsapp:   parseBool(ph.is_whatsapp),
      is_telegram:   parseBool(ph.is_telegram),
    }));
  }
  if (Array.isArray(out.emails)) {
    out.emails = out.emails.map(e => ({
      ...e,
      email_address: e.email_address || e.value || '',
      is_default:    parseBool(e.is_default),
      is_emergency:  parseBool(e.is_emergency),
    }));
  }
  return out;
}

/**
 * Transforms a person's flat UI fields into the arrays savePersons_ expects.
 * NOTE: _uid is intentionally preserved — Step3Relations depends on it to
 * build unique guardian_person_id keys before the backend assigns person_id.
 */
function transformPersonForSave(person, idx, arr) {
  const out = { ...person };

  // #6: con "Mismo domicilio que Tutor 1" marcado, materializa la COPIA de los
  // campos de domicilio de la primera persona en el save. Sin esto el backend
  // (enr_persistPersons_ ignora copy_address_from_person_id y solo escribe
  // p.address con datos) no persistía NINGÚN domicilio para esa persona y el
  // round-trip de rehidratación no podía re-derivar el checkbox (#6). Se copian
  // SOLO los 6 campos canónicos (nunca address_id/record propios, que se
  // preservan para el upsert). Si los valores ya son iguales, el objeto no
  // cambia → el dirty-check no se ensucia.
  if (out._sameAddress && Array.isArray(arr) && idx > 0 && arr[0] && !addressIsEmpty_(arr[0].address)) {
    const src = arr[0].address || {};
    const copied = {};
    // Copia VERBATIM (sin coerciones) — si los valores ya eran iguales, el objeto
    // resultante es idéntico al baseline y el dirty-check no dispara saves extra.
    ADDRESS_FIELDS.forEach(f => { copied[f] = (src[f] !== undefined ? src[f] : ''); });
    out.address = { ...(out.address || {}), ...copied };
  }

  // Spread existing array entry as base to preserve server fields (e.g. person_id)
  // so the dirty check stays stable on resume.
  const existingNat = (person.nationalities || [])[0] || {};
  out.nationalities = person.nationality
    ? [{ ...existingNat, ...(person._nat_record_id ? { record_id: person._nat_record_id } : {}), nationality_id: person.nationality }]
    : [];
  delete out.nationality;
  delete out._nat_record_id;

  const existingId = (person.ids || [])[0] || {};
  out.ids = (person.id_type_id && person.id_number)
    ? [{ ...existingId, ...(person._id_record_id ? { record_id: person._id_record_id } : {}), id_type_id: person.id_type_id, id_number: person.id_number }]
    : [];
  delete out.id_type_id;
  delete out.id_number;
  delete out._id_record_id;

  delete out._sameAddress;

  // Normalize phones to server-canonical shape: remove UI-added alias fields
  // (phone_number, phone_type_id) that preparePersonForUI adds on top of the
  // server fields (value, phone_nr_type_id). Without this, the dirty check
  // always returns true for resumed sessions because the baseline has the
  // raw server shape while the transformed data has both old and new field names.
  if (Array.isArray(out.phones)) {
    out.phones = out.phones.map(ph => {
      // eslint-disable-next-line no-unused-vars
      const { phone_number, phone_type_id, _uid, ...rest } = ph;
      // Preserve phone_number / phone_type_id as canonical fields when no
      // server-side alias exists (new phones added in the UI never have
      // phone_nr_type_id / value set, only phone_number / phone_type_id).
      if (!rest.value && phone_number)          rest.value            = phone_number;
      if (!rest.phone_nr_type_id && phone_type_id) rest.phone_nr_type_id = phone_type_id;
      return rest;
    });
  }

  // Same normalization for emails: remove UI-added email_address alias and _uid.
  if (Array.isArray(out.emails)) {
    out.emails = out.emails.map(e => {
      // eslint-disable-next-line no-unused-vars
      const { email_address, _uid, ...rest } = e;
      if (!rest.value && email_address) rest.value = email_address;
      return rest;
    });
  }

  return out;
}

export default function Step2Persons({ onNext, onBack, locked, onUnlock, savePending }) {
  const { t } = useTranslation();
  const {
    stepData, updateStep, recognition,
    touchActivity, setValidationError,
  } = useWizard();
  const primaryEmail = stepData.email?.primary_email || '';

  // DL-E39 ENMIENDA (gate de entrada): el enmascarado per-campo (DOB/DNI/dirección)
  // se ELIMINA. Toda la PII está protegida por el GATE DE ENTRADA del wizard
  // (StepUpGate en WizardPage). Una vez dentro, los datos se muestran con
  // normalidad. `touchActivity` resetea el contador de inactividad.

  const [persons, setPersons] = useState(() => {
    if (stepData.persons?.length) {
      // #6: tras preparar la shape UI, re-deriva el checkbox "Mismo domicilio que
      // Tutor 1" comparando domicilios (trim/case) — se perdía en cada re-siembra.
      const ui = deriveSameAddressFlags(stepData.persons.map(preparePersonForUI));
      log.debug('Step2: init persons from stepData (preparePersonForUI applied)', ui);
      return ui;
    }
    log.debug('Step2: init persons with empty defaults');
    return [emptyPerson('guardian'), emptyPerson('applicant')];
  });
  const [err, setErr] = useState('');
  // UX-1: eleva el aviso de validación a la zona sticky superior (WizardPage lo pinta en
  // lugar del banner local al pie). Se limpia al corregir (err→'') y al desmontar.
  useEffect(() => { setValidationError(err); }, [err, setValidationError]);
  useEffect(() => () => setValidationError(''), [setValidationError]);
  // UX-2: campos concretos marcados inválidos (is-invalid + aria-invalid). Clave =
  // `${person_id||_uid}:${field}` (o 'attestation'). Se limpia al corregir el campo y al
  // re-validar OK (handleNext resetea). Aditivo — NO cambia qué se considera válido.
  const [invalidFields, setInvalidFields] = useState({});
  const markInvalid = (keys) => setInvalidFields(Object.fromEntries(keys.map(k => [k, true])));
  const clearInvalidField = (k) => setInvalidFields(prev => (prev[k] ? (() => { const n = { ...prev }; delete n[k]; return n; })() : prev));
  const pkey = (p) => p.person_id || p._uid;
  const [highlightEdit, setHighlightEdit] = useState(false);
  // CLI 8: atestación de tutor único (familia monoparental / único tutor legal).
  // Persistido en el save vía sole_guardian_attestation; se rehidrata si ya constaba.
  const [soleGuardianAttested, setSoleGuardianAttested] = useState(
    !!stepData.sole_guardian_attestation?.attested
  );
  // D-E18: dismissed flag survives only within this render of Step2; if the user
  // declines the banner, hide it for the rest of the session.
  const [recognitionDismissed, setRecognitionDismissed] = useState(false);

  // True when a guardian already carries a personal_id (set by accepting the
  // recognition banner, or hydrated from a resumed session). Used to hide the
  // banner once the user has accepted the match.
  const recognitionAccepted = persons.some(p =>
    p.person_type_id === 'guardian' && p.personal_id
  );

  const acceptRecognition = (recPerson) => {
    // Pre-fill the first guardian slot with the recognised person and stamp
    // personal_id so savePersons_ writes the FK reverse to enrPersons.
    setPersons(prev => {
      const next = [...prev];
      const i = next.findIndex(p => p.person_type_id === 'guardian');
      if (i === -1) return next;
      next[i] = {
        ...next[i],
        first_name:  recPerson.first_name || next[i].first_name || '',
        last_name:   recPerson.last_name  || next[i].last_name  || '',
        personal_id: recPerson.personal_id,
      };
      return next;
    });
  };

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
    // DL-C-B (a): en modo locked/read-only (editable:false — revisando dato histórico)
    // NO re-validamos los pasos 1-7. El fieldset está disabled (sin ediciones), así que
    // el avance es un pass-through: dato legacy que no cumple E.164/gates nuevos NO debe
    // bloquear la navegación. WizardPage.handleNext no guardará (no dirty). Preserva las
    // validaciones íntegras en modo edición (locked=false).
    if (locked) { setErr(''); onNext('persons', persons); return; }
    setInvalidFields({});  // UX-2: reset del resaltado antes de re-validar
    if (!guardians.length) {
      setErr(t('error.guardian_required'));
      return;
    }
    if (!applicants.length) {
      setErr(t('error.applicant_required'));
      return;
    }
    // Every person must have first_name + last_name
    for (const p of persons) {
      if (!p.first_name?.trim() || !p.last_name?.trim()) {
        const sameType = persons.filter(x => x.person_type_id === p.person_type_id);
        const idx = sameType.indexOf(p) + 1;
        const label = p.person_type_id === 'applicant'
          ? t('applicant.title', { n: idx })
          : t('guardian.title', { n: idx });
        // UX-2: marca el/los campo(s) de nombre vacío(s) de ESA persona.
        const bad = [];
        if (!p.first_name?.trim()) bad.push(`${pkey(p)}:first_name`);
        if (!p.last_name?.trim())  bad.push(`${pkey(p)}:last_name`);
        markInvalid(bad);
        setErr(t('error.person_name_required', { name: label }));
        return;
      }
    }
    // CLI PHONE-E164: gate de teléfono. (a) cualquier teléfono NO vacío debe ser
    // E.164 válido; (b) cada guardian (firmante — Click&Sign lo exige) necesita ≥1
    // teléfono válido. Applicants: teléfono opcional, pero si está, válido.
    for (const p of persons) {
      const countryISO = p.address?.country_id || '';
      const phones = p.phones || [];
      for (const ph of phones) {
        const raw = (ph.phone_number || ph.value || '').trim();
        if (raw && !validatePhone(raw, countryISO).valid) {
          markInvalid([`${pkey(p)}:phone`]);  // UX-2 (el PhoneRow ya resalta inline; refuerza)
          setErr(t('step2.phone.invalid'));
          return;
        }
      }
      if (p.person_type_id === 'guardian') {
        const hasValid = phones.some(ph =>
          validatePhone((ph.phone_number || ph.value || '').trim(), countryISO).valid);
        if (!hasValid) {
          markInvalid([`${pkey(p)}:phone`]);  // UX-2
          setErr(t('step2.phone.guardian_required'));
          return;
        }
      }
    }
    // CLI 8 (DL-E42): email único por tutor. El email de cada tutor es su credencial
    // de identidad per-guardian → dos tutores del grupo NO pueden compartirlo. Gate de
    // avance (defensa backend en assertUniqueGuardianEmails_). El primer tutor recibe
    // el email de sesión (primaryEmail) inyectado abajo; lo consideramos aquí también.
    {
      const seen = {};
      for (let gi = 0; gi < guardians.length; gi++) {
        const g = guardians[gi];
        let email = guardianEmail_(g);
        if (!email && gi === 0 && primaryEmail) email = String(primaryEmail).trim().toLowerCase();
        if (!email) continue;
        if (seen[email] !== undefined) {
          markInvalid([`${pkey(g)}:email`]);  // UX-2: marca el email duplicado
          setErr(t('error.duplicate_guardian_email'));
          return;
        }
        seen[email] = gi;
      }
    }
    // CLI 8 (DL-E39 ENMIENDA 3 punto 4): atestación de tutor único. Si solo se declara
    // 1 tutor, exige confirmar la atestación (familia monoparental / único tutor legal)
    // antes de avanzar.
    if (guardians.length === 1 && !soleGuardianAttested) {
      markInvalid(['attestation']);  // UX-2: resalta la atestación
      setErr(t('error.sole_guardian_attestation_required'));
      return;
    }
    setErr('');
    setInvalidFields({});  // UX-2: validación OK → limpia el resaltado
    // Inject primary email BEFORE transformPersonForSave so the injected entry
    // goes through the same normalization as existing emails. Doing it after
    // would leave { email_address } on the injected entry while the rest have
    // { value }, making the dirty-check always return true.
    let firstGuardianDone = false;
    const withPrimaryEmail = persons.map(p => {
      if (p.person_type_id === 'guardian' && primaryEmail && !firstGuardianDone) {
        firstGuardianDone = true;
        const alreadyHas = (p.emails || []).some(
          e => (e.email_address || e.value || '') === primaryEmail
        );
        if (!alreadyHas) {
          return {
            ...p,
            emails: [{ email_address: primaryEmail, is_default: true }, ...(p.emails || [])],
          };
        }
      }
      return p;
    });
    // CLI PHONE-E164: normaliza los teléfonos válidos a E.164 antes de persistir
    // (cubre el caso de pulsar Continuar sin haber hecho blur en algún campo).
    const withE164 = withPrimaryEmail.map(p => ({
      ...p,
      phones: (p.phones || []).map(ph => {
        const raw = (ph.phone_number || '').trim();
        if (!raw) return ph;
        const r = validatePhone(raw, p.address?.country_id || '');
        return r.valid && r.e164 ? { ...ph, phone_number: r.e164 } : ph;
      }),
    }));
    const transformed = withE164.map(transformPersonForSave);
    log.info('Step2: onNext persons (transformed)', transformed);
    updateStep('persons', transformed);
    // CLI 8: si hay exactamente 1 tutor y se atestó, adjunta el acto declarativo al
    // save (sole_guardian_attestation). attestant = email del tutor único (su credencial
    // de identidad) o el email de sesión. El backend lo persiste best-effort (group-scoped).
    let extra = null;
    if (guardians.length === 1 && soleGuardianAttested) {
      const attestant = guardianEmail_(guardians[0]) || String(primaryEmail || '').trim().toLowerCase() || null;
      extra = {
        sole_guardian_attestation: {
          attested:            true,
          attestant_guardian:  attestant,
          attested_at:         new Date().toISOString(),
          attestation_version: SOLE_GUARDIAN_ATTESTATION_VERSION,
        },
      };
    }
    onNext('persons', transformed, extra);
  };

  return (
    <>
      <div className="mb-2">
        <h2 style={{ color: 'var(--teal-dk)', fontWeight: 800 }}>{t('step.persons')}</h2>
        <p style={{ color: 'var(--muted)' }}>{t('step2.subtitle')}</p>
      </div>

      <StepNav position="top" onBack={handleBack} onNext={handleNext} savePending={savePending} />

      {locked && <LockedBanner onUnlock={onUnlock} highlight={highlightEdit} />}

      {/* D-E18: legacy family recognised by email — offer to pre-fill */}
      {recognition?.matched && !recognitionAccepted && !recognitionDismissed && (
        <div className="alert alert-info d-flex align-items-start gap-3 mb-3" style={{ borderLeft: '4px solid var(--teal)' }}>
          <i className="bi bi-people-fill" style={{ fontSize: '1.4rem', color: 'var(--teal)' }} />
          <div className="flex-grow-1">
            <strong>{t('step2.recognized_title', 'Reconocimos tu familia')}</strong>
            <p className="mb-2" style={{ fontSize: '0.92rem' }}>
              {t('step2.recognized_body', 'Tenemos a las siguientes personas registradas con tu email. Si alguna es el progenitor que inicia esta solicitud, pulsa para pre-rellenar:')}
            </p>
            <div className="d-flex gap-2 flex-wrap">
              {recognition.persons.map(rp => (
                <button
                  key={rp.personal_id}
                  type="button"
                  className="btn btn-outline-primary btn-sm"
                  onClick={() => acceptRecognition(rp)}
                >
                  {[rp.first_name, rp.last_name].filter(Boolean).join(' ') || rp.personal_id}
                </button>
              ))}
              <button
                type="button"
                className="btn btn-link btn-sm text-muted"
                onClick={() => setRecognitionDismissed(true)}
              >
                {t('step2.recognized_dismiss', 'Ninguno · seguir como familia nueva')}
              </button>
            </div>
          </div>
        </div>
      )}

      <div
        onClick={locked
          ? () => { setHighlightEdit(true); setTimeout(() => setHighlightEdit(false), 600); }
          : touchActivity}
      >
      <fieldset disabled={locked} style={{ border: 'none', padding: 0, margin: 0, pointerEvents: locked ? 'none' : undefined }}>
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
              invalidFields={invalidFields}
              onFieldEdit={clearInvalidField}
            />
          );
        })}
        <button className="add-btn" onClick={() => addPerson('guardian')}>
          <i className="bi bi-plus-lg" /> {t('person.add_guardian')}
        </button>

        {/* CLI 8 (DL-E39 ENMIENDA 3 punto 4): atestación de tutor único. Aparece solo
            cuando se declara exactamente 1 tutor; sin marcarla no se avanza. El acto
            (attestant + timestamp + versión) se registra en el save. */}
        {guardians.length === 1 && (
          <div className="alert alert-warning mt-2 mb-1 py-2 px-3" style={{ fontSize: '0.86rem', borderLeft: '4px solid var(--amber, #f0a500)' }}>
            <label className="d-flex align-items-start gap-2 mb-0" style={{ cursor: 'pointer' }}>
              <input
                type="checkbox"
                className={'form-check-input mt-1' + (invalidFields['attestation'] ? ' is-invalid' : '')}
                aria-invalid={invalidFields['attestation'] ? 'true' : undefined}
                checked={soleGuardianAttested}
                onChange={e => { setSoleGuardianAttested(e.target.checked); clearInvalidField('attestation'); }}
              />
              <span>{t('step2.sole_guardian.attestation_label')}</span>
            </label>
          </div>
        )}

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
              invalidFields={invalidFields}
              onFieldEdit={clearInvalidField}
            />
          );
        })}
        <button className="add-btn" onClick={() => addPerson('applicant')}>
          <i className="bi bi-plus-lg" /> {t('person.add_applicant')}
        </button>

        {/* UX-1: el aviso de validación se muestra ahora en la zona sticky superior
            (WizardPage lo pinta desde validationError); ya no al pie del paso. */}
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
