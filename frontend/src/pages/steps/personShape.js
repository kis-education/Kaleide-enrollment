// ─────────────────────────────────────────────────────────────────────────────
// personShape.js — forma CANÓNICA de una persona en el wizard (módulo PURO,
// sin imports de contexto/componentes → importable desde WizardContext sin ciclos).
//
// Fix Diego 2026-06-12 ("si no hay cambios, no es necesario guardar nada"): el
// dirty-check compara JSON exacto contra el baseline sembrado en la hidratación.
// El Step 2 ENRIQUECE cada persona al montar (nationality/id aplanados,
// _nat_record_id/_id_record_id, alias email_address/phone_number, booleanos
// normalizados) → si el baseline se siembra con la forma CRUDA del hydrate, el
// paso sale "dirty" para siempre y cada navegación dispara un saveStep espurio
// (27s de cola + nube "Guardando" sin haber tocado nada). La regla: TODO el que
// siembre o transforme personas usa ESTA función — una sola forma, cero deriva.
// (Movidas VERBATIM desde Step2Persons.jsx — regla código-de-oro.)
// ─────────────────────────────────────────────────────────────────────────────

export function parseBool(val) {
  if (typeof val === 'boolean') return val;
  // P89 — handle both AppSheet formats: "TRUE"/"FALSE" and "Y"/"N"
  if (typeof val === 'string') { const l = val.toLowerCase(); return l === 'true' || l === 'y' || val === '1'; }
  return Boolean(val);
}

export function preparePersonForUI(person) {
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
