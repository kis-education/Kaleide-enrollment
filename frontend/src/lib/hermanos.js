// `0º.tricies.novemtricies` §UX (2026-09-06) — LECTOR ÚNICO de "de qué hijo habla cada
// línea de `admissionState.por_alumno`", con el nombre ya resuelto.
//
// Antes vivía SOLO dentro del `useMemo` de `WizardPage.jsx` (el banner de "solicitud
// enviada"). Se extrae aquí porque el banner de la firma (`SigningChildrenBanner`)
// necesita EXACTAMENTE lo mismo — de quién es cada línea y cómo se llama — y dos
// lectores del mismo dato divergen (CLAUDE.md §"Regla — refactors preservan el código
// probado"). Función PURA: no toca red, no decide nada de seguridad — solo casa el
// identificador que manda el servidor con las personas que el navegador ya tiene.
//
// ⛔ NO decide de quién es nada: si no hay nombre resuelto, la etiqueta genérica
// (`submitted.por_hijo.sin_nombre`) — nunca un identificador en crudo delante de la
// familia.
//
// ⚠️ MEDIDO al construir el banner de la firma (2026-09-06): `stepData.persons` tiene
// DOS FORMAS distintas según si la familia ya visitó el paso 2 en ESTA sesión.
//   - `hydrateFromResume` (WizardContext.jsx) siembra `stepData.persons` como el ARRAY
//     PLANO que devuelve el servidor (`preparePersonsForUI(persons)`), con
//     `person_type_id: 'applicant'|'guardian'` en cada fila.
//   - `Step2Persons.jsx`, al MONTARSE, lo transforma a `{applicants:[...],
//     guardians:[...]}` y lo vuelve a guardar con `updateStep('persons', ...)`.
// Una familia que entra directamente en la firma (el caso normal: llega admitida y
// nunca visita el paso 2 en esa sesión) se queda con la forma ARRAY. Leer
// `stepData.persons.applicants` sobre un array da `undefined` — la SigningChildrenBanner
// lo mostró como "Alumno 1"/"Alumno 2" en vez del nombre real (rojo demostrado,
// `tramo-firma`, 2026-09-06). `personasAplicantes_` entiende las DOS formas.
function personasAplicantes_(stepDataPersons) {
  if (Array.isArray(stepDataPersons)) {
    return stepDataPersons.filter(p => p && p.person_type_id === 'applicant');
  }
  if (stepDataPersons && Array.isArray(stepDataPersons.applicants)) {
    return stepDataPersons.applicants;
  }
  return [];
}

/**
 * ★ drenaje `:08` v1019 (`2026-11-15-el-segundo-hermano-no-puede-firmar`) — ¿este hijo tiene algo
 * que firmar? Manda `firma_abierta`, que el KMS calcula con el MISMO criterio con el que monta los
 * sobres de firma (la situación lleva la etiqueta declarada `SIGNING_OPEN`, Catálogos → Estados;
 * `enr_expedientesConLaFirmaAbierta_`). Así la pantalla no puede ofrecer firmar a un hijo para el que
 * no hay sobre, ni esconder a uno que lo tiene porque el colegio llame de otra forma a «admitido».
 *
 * ⛔ SOLO un booleano cuenta. Sin él (un servidor que aún no lo manda, o etiquetas ilegibles) se
 * degrada al literal de antes, `state_code === 'AD'`, byte a byte — es el respaldo DECLARADO, y se
 * retira cuando las dos mitades estén publicadas.
 *
 * @param {Object} a una línea de `admissionState.por_alumno`
 * @returns {boolean}
 */
export function admitidoParaFirmar(a) {
  if (!a) return false;
  if (typeof a.firma_abierta === 'boolean') return a.firma_abierta;
  return a.state_code === 'AD';
}

/**
 * @param {Array|undefined} porAlumno       `admissionState.por_alumno` — [{enrollment_id,
 *   applicant_person_id, state_code, state_label}, ...]
 * @param {Array|Object|undefined} stepDataPersons  `stepData.persons` TAL CUAL vive en el
 *   contexto — array plano (recién hidratado) u objeto `{applicants,guardians}` (tras
 *   visitar el paso 2). Ver `personasAplicantes_` arriba.
 * @param {Function} t  i18n translate (para el respaldo "Alumno N")
 * @returns {Array<{enrollment_id, applicant_person_id, nombre, situacion, admitido}>}
 */
export function hermanosConSituacion(porAlumno, stepDataPersons, t) {
  const filas = Array.isArray(porAlumno) ? porAlumno : [];
  const personas = personasAplicantes_(stepDataPersons);
  return filas.map((a, i) => {
    const p = personas.find(x => x && (x.person_id === a.applicant_person_id));
    const nombre = [p?.first_name, p?.last_name].filter(Boolean).join(' ').trim();
    return {
      enrollment_id: a.enrollment_id || null,
      applicant_person_id: a.applicant_person_id || null,
      nombre: nombre || t('submitted.por_hijo.sin_nombre', { n: i + 1 }),
      situacion: a.state_label || a.state_code || '',
      // ¿Este hijo tiene algo que firmar? Lo decide `admitidoParaFirmar` (abajo): la etiqueta
      // declarada `SIGNING_OPEN` que responde el KMS, y solo sin ella el literal de antes.
      admitido: admitidoParaFirmar(a),
      // ★ CLI 403: el estado de las pantallas 8/9/10 por hijo (del tutor que opera), si el
      // servidor lo mandó. El selector del tramo 8-11 lo lee por `lib/pantallaDeFirma.js`.
      pasos: a.pasos || null,
    };
  });
}
