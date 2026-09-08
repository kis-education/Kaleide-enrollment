/**
 * Curated ISO 639-1 language list — hoy es SOLO el DICCIONARIO DE RESPALDO para
 * etiquetar un idioma que la familia ya declaró y que no está en el catálogo del
 * servidor (dato heredado, u otro código escrito por otro camino). value = language
 * code (`enrPersonLanguages.language_id`); label = display name.
 *
 * ── `①83` fila IDIOMAS (2026-09-08) — YA NO ES LA FUENTE DE LAS OPCIONES ─────────
 * Hasta hoy, `Step2Persons.jsx` pintaba SUS casillas directamente desde `LANGUAGES`
 * — la lista escrita a mano de aquí abajo — que es justo lo que Diego pidió que
 * dejara de pasar («no quiero ver ni un solo dato hardcodeado»). El KMS **ya sirve**
 * el catálogo (`languages`, `enr_wizardFetchLookups` ← `enr_idiomasDelCatalogo_`,
 * `kis-app kms-server/enr/wizard-gateway.gs`, reusando `sys_idiomasIndice_()`) con
 * el MISMO molde que sexo/alergias/tipos de vínculo — y hoy ese catálogo coincide
 * 1:1 con esta lista (medido el 2026-09-06, 49/49 códigos), así que el paso al
 * catálogo del servidor NO deja sin ver ningún idioma ya declarado.
 *
 * `Step2Persons.jsx` pinta ahora las opciones desde `catalogoDeIdiomas` (el lookup
 * del servidor, sin escala este fichero). Lo que SIGUE viviendo aquí es
 * `languageLabel()`, usado por `idiomasFueraDelCatalogo` para no dejar sin etiqueta
 * a un idioma ya guardado que hoy no esté en la lista que sirve el servidor.
 *
 * ⚠️ LÍMITE HONESTO, medido y sin tocar: la ficha del personal sigue enseñando este
 * valor **EN CRUDO** (`kis-app frontend/src/worlds/services/admissions/
 * ApplicationDetailPage.jsx:168` → `l.language_id`), porque `enrPersonLanguages` no
 * trae columna de designación como sí trae la nacionalidad. Resolver eso es del
 * lado del KMS y NO se toca aquí.
 */
export const LANGUAGES = [
  { value: 'ar', label: 'Arabic' },
  { value: 'eu', label: 'Basque' },
  { value: 'bn', label: 'Bengali' },
  { value: 'bg', label: 'Bulgarian' },
  { value: 'ca', label: 'Catalan' },
  { value: 'zh', label: 'Chinese' },
  { value: 'hr', label: 'Croatian' },
  { value: 'cs', label: 'Czech' },
  { value: 'da', label: 'Danish' },
  { value: 'nl', label: 'Dutch' },
  { value: 'en', label: 'English' },
  { value: 'et', label: 'Estonian' },
  { value: 'fi', label: 'Finnish' },
  { value: 'fr', label: 'French' },
  { value: 'gl', label: 'Galician' },
  { value: 'de', label: 'German' },
  { value: 'el', label: 'Greek' },
  { value: 'he', label: 'Hebrew' },
  { value: 'hi', label: 'Hindi' },
  { value: 'hu', label: 'Hungarian' },
  { value: 'is', label: 'Icelandic' },
  { value: 'id', label: 'Indonesian' },
  { value: 'ga', label: 'Irish' },
  { value: 'it', label: 'Italian' },
  { value: 'ja', label: 'Japanese' },
  { value: 'ko', label: 'Korean' },
  { value: 'lv', label: 'Latvian' },
  { value: 'lt', label: 'Lithuanian' },
  { value: 'ms', label: 'Malay' },
  { value: 'no', label: 'Norwegian' },
  { value: 'fa', label: 'Persian' },
  { value: 'pl', label: 'Polish' },
  { value: 'pt', label: 'Portuguese' },
  { value: 'pa', label: 'Punjabi' },
  { value: 'ro', label: 'Romanian' },
  { value: 'ru', label: 'Russian' },
  { value: 'sr', label: 'Serbian' },
  { value: 'sk', label: 'Slovak' },
  { value: 'sl', label: 'Slovenian' },
  { value: 'es', label: 'Spanish' },
  { value: 'sw', label: 'Swahili' },
  { value: 'sv', label: 'Swedish' },
  { value: 'tl', label: 'Tagalog' },
  { value: 'th', label: 'Thai' },
  { value: 'tr', label: 'Turkish' },
  { value: 'uk', label: 'Ukrainian' },
  { value: 'ur', label: 'Urdu' },
  { value: 'vi', label: 'Vietnamese' },
  { value: 'cy', label: 'Welsh' },
];

/**
 * Etiqueta legible de un código, para pintar un idioma YA DECLARADO que no esté en
 * la lista curada (un dato heredado, o un código que otro camino escribió). Degrada
 * al PROPIO código: nunca se esconde un idioma que la familia ya declaró solo
 * porque este catálogo no lo conozca.
 *
 * @param {string} code
 * @returns {string}
 */
export function languageLabel(code) {
  const c = String(code || '').trim();
  if (!c) return '';
  const hit = LANGUAGES.find(l => l.value === c);
  return hit ? hit.label : c;
}
