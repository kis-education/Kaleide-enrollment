/**
 * QUÉ NO CARGÓ — un solo sitio, porque `degraded_sections` trae DOS clases de nombre.
 * ═══════════════════════════════════════════════════════════════════════════════════
 *
 * `2026-09-16-la-salud-no-se-recupera`. El KMS (`enr_wizardHydrateCompute_`,
 * `kis-app kms-server/enr/wizard-datalayer.gs`) apunta en `degraded_sections`:
 *
 *   · `person_subreads`          — la sección LANZÓ (el lote entero no se leyó) **o** alguna de
 *                                  sus tablas se cayó con `softFail`;
 *   · `person_subreads:<tabla>`  — esa tabla concreta se cayó (`enr_wizardAnotarCaidas_`).
 *
 * Desde que el nombre fino existe, el nombre grueso por sí solo ya NO dice «salud»: si se cae
 * `enrPersonNationalities` también sale `person_subreads`, y el paso de Salud avisaba de que no
 * había cargado lo que sí cargó.
 *
 * **La regla, y es la misma que hace el KMS:** si vienen nombres finos, MANDAN ellos; si solo
 * viene el grueso, el lote entero no se leyó y TODO lo que cuelga de él falta.
 *
 * ⛔ **Falla hacia AVISAR**: un nombre fino que no reconocemos NO apaga el aviso de salud solo
 * porque no sea de salud — solo lo apagan las tablas que SABEMOS que son de otra cosa. Avisar de
 * más cuesta un cartel; avisar de menos cuesta que un «Continuar» pise lo declarado.
 */

const SECCION_DE_LA_SALUD = 'person_subreads';

/** Las tablas del lote que NO son de salud ni de NEAE — las únicas que pueden dejar el aviso apagado. */
const TABLAS_QUE_NO_SON_DE_SALUD = [
  'enrPersonNationalities',
  'enrPersonIDs',
  'enrPersonLanguages',
  'enrPersonAddresses',
  'enrPreviousSchools',
];

/** Las tablas fina que SI son de salud o de apoyo educativo (NEAE), solo para documentar. */
export const TABLAS_DE_SALUD_Y_NEAE = [
  'enrPersonMedicalConditions',
  'enrPersonFoodAllergies',
  'enrPersonDietaryRequirements',
  'enrPersonNeae',
  'enrPersonNeaeSupport',
];

/**
 * @param {*} degradadas `data.degraded_sections` tal como llega (puede faltar).
 * @returns {string[]} las TABLAS concretas que el KMS dice que no cargaron (sin el prefijo de sección).
 */
export function tablasQueNoCargaron(degradadas) {
  if (!Array.isArray(degradadas)) return [];
  const prefijo = SECCION_DE_LA_SALUD + ':';
  return degradadas
    .filter(n => typeof n === 'string' && n.indexOf(prefijo) === 0)
    .map(n => n.slice(prefijo.length));
}

/**
 * ¿Falta lo de SALUD o NEAE por un fallo de carga? (no confundir con «no hay nada declarado»)
 *
 * @param {*} degradadas `data.degraded_sections`.
 * @returns {boolean}
 */
export function laSaludNoCargo(degradadas) {
  if (!Array.isArray(degradadas) || !degradadas.includes(SECCION_DE_LA_SALUD)) return false;
  const finas = tablasQueNoCargaron(degradadas);
  // Solo el nombre grueso: el lote ENTERO no se leyó ⇒ salud y NEAE faltan.
  if (!finas.length) return true;
  // Hay nombres finos: avisa salvo que TODAS sean de una tabla que sabemos que no es de salud.
  return finas.some(t => !TABLAS_QUE_NO_SON_DE_SALUD.includes(t));
}
