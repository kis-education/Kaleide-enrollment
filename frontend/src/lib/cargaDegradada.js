/**
 * QUÉ NO CARGÓ — un solo sitio que lee `degraded_sections` de la hidratación.
 * ═══════════════════════════════════════════════════════════════════════════
 *
 * `2026-09-16-la-salud-no-se-recupera`. El KMS apunta en `degraded_sections` DOS clases de
 * nombre (`enr_wizardAnotarCaidas_`, `kis-app kms-server/enr/wizard-datalayer.gs`):
 *   · `person_subreads`          — la sección entera (lanzó, o alguna tabla de su lote cayó);
 *   · `person_subreads:<tabla>`  — esa tabla concreta se cayó con `softFail`.
 *
 * Hasta hoy el asistente solo miraba el nombre grueso, así que el aviso del paso de Salud salía
 * aunque lo caído fuera la nacionalidad. Aquí se lee el nombre FINO.
 *
 * ⛔ **Falla hacia AVISAR**: sin nombres finos (servidor viejo, o la sección LANZÓ entera y se
 * sirvió el fallback) se avisa como siempre — avisar de más cuesta un cartel, avisar de menos
 * cuesta que un «Continuar» pise lo declarado. Y una tabla fina que NO está en la lista de
 * salud NO apaga el aviso si además cayó una que sí lo está.
 */

const SECCION = 'person_subreads';

/** Las tablas del lote que alimentan el paso de Salud (alergias, dieta, condiciones y NEAE). */
export const TABLAS_DE_SALUD = [
  'enrPersonMedicalConditions',
  'enrPersonFoodAllergies',
  'enrPersonDietaryRequirements',
  'enrPersonNeae',
  'enrPersonNeaeSupport',
];

/** Las tablas finas caídas de una sección, sin el prefijo. */
export function tablasCaidas(degradedSections, seccion = SECCION) {
  if (!Array.isArray(degradedSections)) return [];
  const prefijo = seccion + ':';
  return degradedSections
    .filter(n => typeof n === 'string' && n.startsWith(prefijo))
    .map(n => n.slice(prefijo.length));
}

/** `true` si la carga de la SALUD pudo quedar a medias (ver «Falla hacia AVISAR»). */
export function saludNoCargo(degradedSections) {
  if (!Array.isArray(degradedSections) || !degradedSections.includes(SECCION)) return false;
  const finas = tablasCaidas(degradedSections);
  if (!finas.length) return true;
  return finas.some(t => TABLAS_DE_SALUD.includes(t));
}
