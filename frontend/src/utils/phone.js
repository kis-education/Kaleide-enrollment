import { parsePhoneNumberFromString } from 'libphonenumber-js';
import { COUNTRY_DIAL_CODES } from '../constants/countries';

/**
 * CLI PHONE-E164 / PHONE-VAL — valida + normaliza un teléfono a E.164 en el PUNTO
 * DE ENTRADA (Step 2 del wizard). Fuente de verdad del formato telefónico aguas
 * arriba; el normalizador del KMS (`_signing_normalizePhoneE164_` /
 * `MISSING_VALID_PHONE`) queda como red de seguridad en el momento de firmar.
 *
 * PHONE-VAL (DL-E40, set cerrado): además de exigir un E.164 válido, el prefijo
 * internacional del número debe pertenecer al SET CERRADO de prefijos del catálogo
 * de países (`COUNTRY_DIAL_CODES`). Así un número técnicamente válido pero de un
 * país que el colegio no maneja (p.ej. +672 Norfolk Island) se rechaza en la
 * entrada en vez de colarse al core. DEGRADA DEFENSIVO: si el set está vacío (la
 * columna AppSheet del código telefónico aún no alimenta el catálogo), el filtro
 * NO se aplica y se cae al validador E.164 puro — nunca rechaza por falta del dato.
 *
 * @param {string} rawInput      lo que teclea el usuario (nacional o internacional con +)
 * @param {string} countryISO    ISO 3166-1 alpha-2 del país de la dirección (defaultCountry)
 * @param {Set<string>} [dialCodes] set cerrado de prefijos aceptados (inyectable; por
 *                                   defecto el del catálogo). Vacío ⇒ filtro desactivado.
 * @returns {{ valid: boolean, e164: (string|null), empty?: boolean, needCountry?: boolean, notInSet?: boolean }}
 *   - empty:true       → input vacío (no es error por sí mismo; el caller decide si es obligatorio)
 *   - needCountry:true → sin país y sin prefijo internacional → no se puede inferir
 *   - notInSet:true    → E.164 válido pero su prefijo no está en el set cerrado
 *   - valid+e164       → e164 = `+<dialcode><national>` cuando isValid() y prefijo en el set
 */
export function validatePhone(rawInput, countryISO, dialCodes = COUNTRY_DIAL_CODES) {
  const raw = (rawInput || '').trim();
  if (!raw) return { valid: false, e164: null, empty: true };

  const isIntl = raw.startsWith('+');
  // Sin país y sin prefijo internacional → no hay forma de inferir el país.
  if (!isIntl && !countryISO) return { valid: false, e164: null, needCountry: true };

  try {
    // Si viene con '+', se respeta el prefijo (no se antepone país). Si viene en
    // formato nacional, countryISO actúa como defaultCountry.
    const pn = parsePhoneNumberFromString(raw, isIntl ? undefined : countryISO);
    if (!pn || !pn.isValid()) return { valid: false, e164: null };

    // Set cerrado (DL-E40). Degradación defensiva: solo se filtra por prefijo
    // cuando hay catálogo de prefijos; con el set vacío el filtro no aplica.
    if (dialCodes && dialCodes.size > 0 && !dialCodes.has(pn.countryCallingCode)) {
      return { valid: false, e164: null, notInSet: true };
    }
    return { valid: true, e164: pn.number };
  } catch {
    return { valid: false, e164: null };
  }
}
