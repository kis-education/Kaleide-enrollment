/**
 * UN SOLO SITIO decide si un rechazo del servidor se vuelve a intentar (cola 18.bis.85).
 *
 * ── El defecto que esto quita ────────────────────────────────────────────────────────
 * La cola de guardado del asistente reintenta sola: cuando el servidor acepta CUALQUIER
 * escritura, el canal está demostrablemente vivo, así que se vuelve a mandar el guardado
 * que había fallado (`alConfirmarEscritura` en `WizardContext`). Eso es correcto para un
 * fallo de red — y es un viaje condenado a fallar cuando el servidor rechazó por un motivo
 * que no cambia: `PARTE_YA_ENVIADA` (②24.sexies) lo va a rechazar exactamente igual, y la
 * familia se lleva el susto DOS veces, porque el aviso reaparece como episodio nuevo.
 *
 * Ese conocimiento vivía SOLO dentro de `SaveIndicator` (para esconder «Reintentar»), así
 * que el contexto no podía consultarlo sin copiarlo. Dos listas del mismo criterio
 * divergen; una sola, no. Vive aquí, y la consumen los dos:
 *   · `WizardContext` → si el rechazo es definitivo, NO se recuerda para reintentarlo;
 *   · `SaveIndicator` → lo explica en llano y NO ofrece «Reintentar».
 *
 * ── Cómo se amplía mañana (es la herramienta, no un parche) ──────────────────────────
 * Un código nuevo se declara AQUÍ, en una línea, con su texto. No hay que tocar ni el
 * contexto ni el aviso: los dos ya preguntan.
 *
 * ── Falla hacia el lado seguro ───────────────────────────────────────────────────────
 * Solo NO se reintenta lo que está declarado. Un código DESCONOCIDO —o ninguno, que es lo
 * que trae un fallo de red— se sigue reintentando exactamente como hasta hoy. Al revés
 * (no reintentar por defecto) convertiría un corte de red pasajero en trabajo perdido.
 *
 * ── Lo que esta lista NO es ──────────────────────────────────────────────────────────
 * `SubmitErrorBanner` tiene su propio mapa de textos y NO se funde con éste a propósito:
 * responde a otra pregunta. Allí los códigos (`INVALID_PHONE`, `STEPUP_REQUIRED`) SÍ se
 * pueden reintentar con provecho —la familia corrige el teléfono o vuelve a verificarse y
 * entonces el envío entra—, por eso aquel aviso conserva su botón. Aquí solo entra lo que
 * el servidor va a rechazar igual hiciera lo que hiciera la familia. Si algún día un
 * rechazo definitivo necesita además su propio texto en el envío, esta tabla crece un
 * campo — nunca nace una segunda lista.
 */

/**
 * Rechazos que el servidor repetiría idénticos: código → clave del texto que se le enseña
 * a la familia en el carril de guardado.
 */
export const RECHAZOS_DEFINITIVOS = {
  // El tutor ya envió SU parte: el KMS descarta sus respuestas del cuestionario
  // (DL-E49 §6) y reintentar las descartaría otra vez. Antes esto no se veía en ninguna
  // parte: el asistente decía haber guardado N respuestas que nadie guardó (②24.sexies).
  PARTE_YA_ENVIADA: 'wizard.save_error.parte_ya_enviada',
};

/**
 * Clave del texto con el que se explica un rechazo definitivo, o `undefined` si ese código
 * no lo es (y entonces se usa el aviso genérico de siempre, byte-idéntico).
 * @param {string} [codigo] código de error devuelto por el servidor
 * @returns {string|undefined}
 */
export function claveDelRechazoDefinitivo(codigo) {
  if (!codigo || typeof codigo !== 'string') return undefined;
  // `hasOwnProperty` y no `RECHAZOS_DEFINITIVOS[codigo]` a secas: un código que viniera
  // llamándose `toString` o `constructor` heredaría un valor del prototipo y se colaría
  // como si estuviera declarado.
  return Object.prototype.hasOwnProperty.call(RECHAZOS_DEFINITIVOS, codigo)
    ? RECHAZOS_DEFINITIVOS[codigo]
    : undefined;
}

/**
 * ¿Merece la pena volver a mandar un guardado que falló con este código?
 * Todo lo que no esté declarado como rechazo definitivo, SÍ (fallo de red incluido).
 * @param {string} [codigo] código de error devuelto por el servidor
 * @returns {boolean}
 */
export function seReintentaTrasFallo(codigo) {
  return !claveDelRechazoDefinitivo(codigo);
}
