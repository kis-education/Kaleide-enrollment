/**
 * enumLabels — traducción de los VALORES de enum servidos crudos por el backend.
 *
 * Los catálogos del wizard (relationTypes) llegan desde el KMS con su `label` =
 * `relation_type_designation` en inglés Title-Case ("Parent", "Legal-guardian",
 * "Grandparent", …) más algunas filas legacy KIS ("Tutor", "Mother", "Father",
 * "Relative", …). El KMS NO traduce — sirve el designation crudo. Sin esta capa,
 * la familia hispanohablante ve "Parent" / "Legal-guardian" en el desplegable y
 * en el resumen. Aquí mapeamos el designation a una clave i18n del wizard; si no
 * hay traducción para un designation desconocido, se cae al label crudo (degrada
 * defensivo — nunca rompe ni oculta el valor).
 *
 * NO cambia el VALOR de enum (el id/code que viaja al backend) — solo su etiqueta
 * visible. La clave de normalización es el designation en minúsculas con guiones y
 * espacios → underscore, p.ej. "Legal-guardian" → "legal_guardian".
 */

/** Normaliza un designation de backend a la sub-clave i18n. */
function normalizeKey(label) {
  return String(label || '')
    .trim()
    .toLowerCase()
    .replace(/[\s-]+/g, '_');
}

/**
 * Traduce el label de un tipo de relación servido por el backend.
 * @param {string} label - designation crudo (p.ej. "Parent", "Legal-guardian", "Tutor")
 * @param {Function} t - función i18n de react-i18next
 * @returns {string} etiqueta traducida, o el label crudo si no hay clave
 */
export function translateRelationLabel(label, t) {
  if (!label) return '';
  const key = `relType.${normalizeKey(label)}`;
  const out = t(key);
  // i18next devuelve la propia clave cuando no existe traducción → fallback al crudo.
  return out === key ? label : out;
}

/**
 * Traduce el valor de género almacenado ("Male"/"Female"/"Non-binary"/
 * "Prefer-not-to-say") a su etiqueta i18n. Fallback al valor crudo si no casa.
 * @param {string} value
 * @param {Function} t
 * @returns {string}
 */
export function translateGender(value, t) {
  if (!value) return '';
  const map = {
    male:               'gender.m',
    female:             'gender.f',
    'non_binary':       'gender.nonbinary',
    nonbinary:          'gender.nonbinary',
    'prefer_not_to_say':'gender.prefer_not_to_say',
  };
  const norm = normalizeKey(value);
  const key  = map[norm];
  if (!key) return value;
  const out = t(key);
  return out === key ? value : out;
}

/**
 * Traduce el código de tipo de documento de identidad ("passport"/"dni"/"nie"/
 * "other") a su etiqueta i18n (`id.*`). Fallback al valor crudo si no casa.
 * @param {string} value
 * @param {Function} t
 * @returns {string}
 */
export function translateIdType(value, t) {
  if (!value) return '';
  const key = `id.${normalizeKey(value)}`;
  const out = t(key);
  return out === key ? value : out;
}
