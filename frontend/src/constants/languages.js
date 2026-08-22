/**
 * Curated ISO 639-1 language list for use in selects.
 * value = language code stored in DB (`enrPersonLanguages.language_id`);
 * label = display name. Sorted alphabetically by label.
 *
 * ── Por qué vive aquí y no en un catálogo de AppSheet (①45, 2026-08-22) ──────────
 * Medido contra `origin/master` antes de escribir esta lista: el lookup que el
 * asistente YA pide (`enr_wizardFetchLookups`, `kms-server/enr/wizard-gateway.gs`)
 * devuelve `allergies`/`dietary`/`medical`/`relationTypes`/`programs`/
 * `recTypesInterestedParty` — y NINGÚN catálogo de idiomas. El nombre `'languages'`
 * aparece UNA vez en todo el KMS (`_manual.gs`, dentro de la lista de tablas de un
 * banco de pruebas de latencia) y **no tiene ni un lector vivo**. Por tanto hoy no
 * hay catálogo que leer, y la falta de una tabla NO congela el desarrollo
 * (`kis-app/CLAUDE.md` §"Regla — la falta de columna/tabla AppSheet NO congela el
 * desarrollo"): se construye igual, con la lista aquí.
 *
 * Mismo molde que `countries.js`, y por el mismo motivo: `language_id` es TEXTO
 * LIBRE en Stage-1, así que un código ISO 639-1 encaja hoy sin tocar AppSheet, y el
 * selector de nacionalidad —que está en la MISMA fila del formulario— ya enseña sus
 * etiquetas en inglés. Dos catálogos vecinos con dos idiomas de etiqueta distintos
 * se leen como un error, no como una mejora.
 *
 * ⚠️ LÍMITE HONESTO, medido: la ficha del personal enseña este valor **EN CRUDO**
 * (`kis-app frontend/src/worlds/services/admissions/ApplicationDetailPage.jsx:168`
 * → `l.language_id`), porque `enrPersonLanguages` no trae una columna de
 * designación como sí trae la nacionalidad (`nationality_designation`). O sea: hoy
 * Diego lee `es`, no `Spanish`. Resolver eso es del lado del KMS y NO se toca aquí.
 *
 * Cuando Stage-2 sirva un catálogo de idiomas por tenant, ESTA lista es lo que se
 * sustituye — igual que se hará con `countries.js`.
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
