import { parsePhoneNumberFromString } from 'libphonenumber-js';

/**
 * CLI PHONE-E164 — valida + normaliza un teléfono a E.164 en el PUNTO DE ENTRADA
 * (Step 2 del wizard). Fuente de verdad del formato telefónico aguas arriba; el
 * normalizador del KMS (`_signing_normalizePhoneE164_` / `MISSING_VALID_PHONE`)
 * queda como red de seguridad en el momento de firmar.
 *
 * @param {string} rawInput      lo que teclea el usuario (nacional o internacional con +)
 * @param {string} countryISO    ISO 3166-1 alpha-2 del país de la dirección (defaultCountry)
 * @returns {{ valid: boolean, e164: (string|null), empty?: boolean, needCountry?: boolean }}
 *   - empty:true       → input vacío (no es error por sí mismo; el caller decide si es obligatorio)
 *   - needCountry:true → sin país y sin prefijo internacional → no se puede inferir
 *   - valid+e164       → e164 = `+<dialcode><national>` cuando isValid()
 */
export function validatePhone(rawInput, countryISO) {
  const raw = (rawInput || '').trim();
  if (!raw) return { valid: false, e164: null, empty: true };

  const isIntl = raw.startsWith('+');
  // Sin país y sin prefijo internacional → no hay forma de inferir el país.
  if (!isIntl && !countryISO) return { valid: false, e164: null, needCountry: true };

  try {
    // Si viene con '+', se respeta el prefijo (no se antepone país). Si viene en
    // formato nacional, countryISO actúa como defaultCountry.
    const pn = parsePhoneNumberFromString(raw, isIntl ? undefined : countryISO);
    if (pn && pn.isValid()) return { valid: true, e164: pn.number };
    return { valid: false, e164: null };
  } catch {
    return { valid: false, e164: null };
  }
}
