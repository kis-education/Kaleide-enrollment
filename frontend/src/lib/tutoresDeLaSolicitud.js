/**
 * CUÁNTOS TUTORES TIENE LA SOLICITUD — un solo sitio, porque `persons.length` MIENTE.
 * ═════════════════════════════════════════════════════════════════════════════════════
 *
 * DL-E49 §2: la hidratación recorta `persons` a **«yo + los menores»** — del OTRO tutor no
 * baja nada—. Así que `persons.filter(es tutor).length` vale **1** tanto si de verdad hay un
 * solo tutor como si hay dos y el servidor escondió al otro. **Preguntarle a esa cuenta
 * «¿hay más de un tutor?» devuelve NO siempre**, y lo que cuelgue de esa respuesta es código
 * muerto que no falla, no avisa y no se ve.
 *
 * ⛔ **Y no es hipotético: pasó.** La mitad de pantalla de `DL-E70` (el reparto de pagos que ya
 * eligió un tutor no lo reescribe el otro sin querer) nació preguntando `guardians.length > 1`
 * ⇒ el aviso no se pintaba nunca y desbloquear no preguntaba nunca. Lo cazó el recorrido
 * `reparto-se-desbloquea-adrede` de la batería. El mismo aviso estaba escrito en un comentario
 * de `Step2Persons.jsx` desde DL-E49 §3, en otro fichero, donde no lo leyó quien vino después
 * — por eso el criterio vive AQUÍ y no en un comentario.
 *
 * **La señal correcta la manda el servidor**: `guardians_total_count`, contado ANTES del
 * recorte (`enr_wizardHydrateCompute_`, `kis-app kms-server/enr/wizard-datalayer.gs`) y sin
 * ninguna identidad dentro — es un número.
 *
 * ⛔ **Y el respaldo NO es un adorno**: en un alta nueva, todavía sin hidratar, el número no ha
 * llegado y la cuenta LOCAL sí es fiable (no hay nada que recortar aún). Sin él, un alta nueva
 * con dos tutores recién teclados se leería como monoparental.
 */

/**
 * @param {Object}  stepData            el estado hidratado del asistente.
 * @param {Array}   personasVisibles    las personas que la pantalla tiene en la mano.
 * @returns {number} cuántos tutores tiene la solicitud DE VERDAD.
 */
export function cuantosTutores(stepData, personasVisibles) {
  const delServidor = stepData && stepData.guardians_total_count;
  if (delServidor != null) return Number(delServidor) || 0;
  return ((personasVisibles || []).filter(p => p && p.person_type_id === 'guardian')).length;
}

/** `true` solo si la solicitud tiene MÁS DE UN tutor. */
export function hayMasDeUnTutor(stepData, personasVisibles) {
  return cuantosTutores(stepData, personasVisibles) > 1;
}
