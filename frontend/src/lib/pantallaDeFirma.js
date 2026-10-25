// ★ CLI 403 — LECTOR ÚNICO del estado de las pantallas de firma (8/9/10) POR HIJO.
//
// El tramo final del asistente avanza POR PANTALLA, no por hijo: dentro de la pantalla 8 el
// tutor atiende a TODOS los hijos admitidos, y no se pasa a la 9 hasta que la 8 está resuelta
// para todos (Diego, 2026-10-25: «no permita pasar a siguientes pasos hasta que no se resuelvan
// todos los hijos de cada pantalla»). Este fichero es el ÚNICO sitio que decide, por hijo y por
// pantalla, si está RESUELTO — lo piden el selector (`SigningChildrenSelector`), el candado del
// avance (`WizardPage.advanceSigningStep`) y el aterrizaje (`WizardContext`). Dos lectores del
// mismo criterio divergen.
//
// El estado por hijo sale de `admissionState.por_alumno[i].pasos`, que el servidor computa con
// un solo criterio y hace viajar por las CINCO proyecciones (CLI 403, backend):
//   { billing_confirmed, gdpr_completed, review_completed, signed, nada_que_hacer? }
//
// ⛔ EL CANDADO JAMÁS PUEDE QUEDAR IMPOSIBLE DE SATISFACER (encargo): un hijo sin datos por hijo
// (`pasos` ausente — tutor sin resolver, KMS viejo) o con `nada_que_hacer` cuenta como RESUELTO,
// nunca como pendiente. Así, sin datos por hijo el avance degrada al comportamiento de siempre
// (sin candado) en vez de atrapar a la familia.

// Las TRES pantallas con candado, en orden, con su sub-paso (billing 0 · gdpr 1 · review 2) y la
// bandera de `pasos` que las resuelve. La 11 (firma) NO lleva candado hacia adelante: es la última
// y su acto está apagado (informativa), así que no aparece aquí.
export const PANTALLAS_DE_FIRMA = [
  { sub: 0, id: 's_billing', flag: 'billing_confirmed' },
  { sub: 1, id: 's_gdpr',    flag: 'gdpr_completed' },
  { sub: 2, id: 's_review',  flag: 'review_completed' },
];

export const FLAG_DE_PANTALLA = PANTALLAS_DE_FIRMA.reduce((m, p) => { m[p.id] = p.flag; return m; }, {});

/**
 * ¿Está RESUELTA la pantalla `screenId` para este hijo? `resueltosLocales` lleva lo que el tutor
 * ACABA de completar en ESTA sesión (el servidor aún no lo refleja: su hito se escribe en diferido).
 * @param {{enrollment_id, pasos?}} hijo
 * @param {string} screenId  's_billing' | 's_gdpr' | 's_review' | 's_sign'
 * @param {Object<string,Object<string,boolean>>=} resueltosLocales  { screenId: { enrollment_id: true } }
 * @returns {boolean}
 */
export function hijoResueltoEnPantalla(hijo, screenId, resueltosLocales) {
  const enr = hijo && hijo.enrollment_id;
  if (resueltosLocales && enr && resueltosLocales[screenId] && resueltosLocales[screenId][enr]) return true;
  const p = hijo && hijo.pasos;
  if (!p) return true;                        // sin datos por hijo ⇒ no atasca (degrada al modo viejo)
  if (p.nada_que_hacer === true) return true; // la pantalla no tiene nada accionable para este hijo
  const flag = FLAG_DE_PANTALLA[screenId];
  if (!flag) return true;                     // pantalla sin candado hacia adelante (s_sign)
  return p[flag] === true;
}

/** ¿Hay estado por hijo del servidor (algún hijo admitido con `pasos`)? Si no, el selector/candado
 *  degradan al comportamiento de siempre (un solo contexto, sin fila de hijos). */
export function hayEstadoPorHijo(hijos) {
  return (hijos || []).some((h) => h && h.admitido && h.pasos);
}

/** Los hijos admitidos que FALTAN por resolver en esta pantalla (los que el candado espera). */
export function hijosPendientesEnPantalla(hijos, screenId, resueltosLocales) {
  return (hijos || []).filter((h) => h && h.admitido && !hijoResueltoEnPantalla(h, screenId, resueltosLocales));
}

/** ¿Todos los hijos admitidos resueltos en esta pantalla? (el candado del avance). */
export function todosResueltosEnPantalla(hijos, screenId, resueltosLocales) {
  return hijosPendientesEnPantalla(hijos, screenId, resueltosLocales).length === 0;
}

/** El primer hijo admitido pendiente en esta pantalla, o null (a quién saltar / a quién nombrar). */
export function primerPendienteEnPantalla(hijos, screenId, resueltosLocales) {
  return hijosPendientesEnPantalla(hijos, screenId, resueltosLocales)[0] || null;
}

/**
 * El sub-paso (0 billing · 1 gdpr · 2 review · 3 sign) por el que debería ENTRAR el tramo: el
 * primero cuya pantalla tiene ALGÚN hijo admitido pendiente; si no queda ninguno, el 3 (firma).
 * Devuelve `null` cuando no hay estado por hijo (el aterrizaje conserva su lógica de siempre).
 */
export function primerSubpasoPendiente(hijos, resueltosLocales) {
  if (!hayEstadoPorHijo(hijos)) return null;
  for (const pant of PANTALLAS_DE_FIRMA) {
    if (hijosPendientesEnPantalla(hijos, pant.id, resueltosLocales).length) return pant.sub;
  }
  return 3; // todas las pantallas resueltas para todos ⇒ firma
}
