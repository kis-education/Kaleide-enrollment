/**
 * `2026-09-23-un-solo-cartel-para-cuatro-causas` — UN SOLO SITIO traduce el CÓDIGO con el
 * que el servidor rechazó un enlace al TEXTO que lee el tutor en la portada.
 *
 * ── El defecto que cierra ────────────────────────────────────────────────────────────────
 * El servidor distingue TRES causas y produce TRES mensajes (`_errorDeEnlace_`,
 * `backend/Code.js`, un solo sitio); la portada enseñaba **uno solo para todas**:
 * *«No hemos podido cargar tu solicitud. El enlace puede haber caducado — introduce tu
 * correo…»*. Ese texto nombra la causa que aritméticamente casi nunca es —los enlaces duran
 * SIETE días— y ofrece la salida que **rota el enlace bueno**: pedir otro. A un tutor cuyo
 * enlace murió porque ya se emitió uno más nuevo se le estaba mandando a repetir justo lo
 * que lo mató, en vez de decirle que buscara el último correo.
 *
 * ── Lo que este fichero NO hace ──────────────────────────────────────────────────────────
 * ⛔ **No clasifica.** De qué CLASE es un fallo de entrada lo decide `fallosDeEntrada.js`,
 * que es el juez ÚNICO y no se toca. Aquí solo se elige el TEXTO dentro de la clase
 * «el enlace no vale», que es la única que llega a la portada.
 * ⛔ **No se pinta lo que venga en la dirección.** Es una LISTA BLANCA: lo que no esté en el
 * mapa cae al texto de HOY, byte a byte. Un código desconocido —o ninguno— tiene que seguir
 * enseñando exactamente lo que se enseñaba antes de este cambio.
 *
 * ⛔ **Y no se declara una causa que el servidor no emite.** `BAD_REQUEST` está en el
 * conjunto `ENLACE_MUERTO` de `fallosDeEntrada.js`, pero **este camino nunca lo emite**: un
 * token con forma mala hace saltar `assertValidUuid_`, que lanza SIN código, así que cae en
 * «no se pudo cargar» y ni siquiera llega a la portada. Por eso no tiene texto.
 *
 * ⇒ **Dar de alta una causa nueva es UNA línea de este mapa** más su par de textos. Nada de
 * un `if` por causa repartido por la pantalla.
 */

/** El texto de SIEMPRE: el respaldo de la lista blanca. */
export const CARTEL_DEL_ENLACE_POR_DEFECTO = 'landing.resume_error';

/**
 * código de máquina del servidor → clave del texto visible.
 *
 * ⚠️ Las claves son PLANAS con guion bajo a propósito. i18next corre con el separador `.`
 * activo (`src/i18n.js` no lo desactiva), así que `landing.resume_error.algo` se leería como
 * `algo` ANIDADO dentro de `landing.resume_error` — que ya es una cadena — y rompería el
 * texto que existe hoy.
 */
const TEXTO_POR_CODIGO = Object.freeze({
  // se emitió un enlace más nuevo (emitir uno ROTA el anterior), o la ficha está borrada
  ENLACE_NO_VALIDO:  'landing.resume_error_no_valido',
  // esa solicitud se cerró desde el asistente
  ENLACE_ABANDONADO: 'landing.resume_error_abandonado',
  // los 7 días de verdad
  ENLACE_CADUCADO:   'landing.resume_error_caducado',
});

/**
 * @param {string|null|undefined} codigo el `err.code` que acuñó el servidor, tal cual
 * @returns {string} la clave de i18n del texto que hay que enseñar
 */
export function claveDelCartelDelEnlace(codigo) {
  const c = codigo ? String(codigo) : '';
  return Object.prototype.hasOwnProperty.call(TEXTO_POR_CODIGO, c)
    ? TEXTO_POR_CODIGO[c]
    : CARTEL_DEL_ENLACE_POR_DEFECTO;
}
