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
 * `0º.tricies.duodecies` · DL-E51 — LA ETIQUETA DE UN VALOR DE SEXO, EN UN SOLO SITIO.
 *
 * **La regla, una sola y para los dos consumidores**: la clave de traducción es la que
 * DECLARA el catálogo (`label_key`); si esa clave no tiene texto, se pinta la
 * `designation` del catálogo; y si tampoco hay catálogo delante, el código en crudo.
 *
 * Aquí había un mapa de códigos escrito a mano (`male`→`gender.m`, …) — un TERCER sitio
 * donde vivía la lista de valores, que podía divergir del catálogo igual que divergía el
 * desplegable. Ya no: quien tiene el catálogo (el paso 2) lo pasa; quien no lo tiene (el
 * resumen del paso 7, que solo conoce el valor guardado) DERIVA la clave del propio
 * código, porque el catálogo declara `label_key = 'gender.' + gender_code`.
 *
 * ⚠️ LÍMITE HONESTO: si un centro declarase un valor cuyo `label_key` NO siguiera esa
 * forma, el resumen del paso 7 pintaría el código en crudo — nunca una etiqueta
 * equivocada. El desplegable del paso 2 sí lo enseñaría bien, porque ahí sí llega el
 * catálogo.
 *
 * @param {string} value        el código guardado (`enrPersons.gender`)
 * @param {Function} t          función i18n de react-i18next
 * @param {{label_key?:string, designation?:string}} [declarado]  la fila del catálogo, si se tiene
 * @returns {string}
 */
export function translateGender(value, t, declarado) {
  if (!value) return '';
  const key = (declarado && declarado.label_key) || `gender.${value}`;
  const out = t(key);
  if (out !== key) return out;
  return (declarado && declarado.designation) || value;
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
