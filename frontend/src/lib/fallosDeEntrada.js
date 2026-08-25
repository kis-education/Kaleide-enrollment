/**
 * `0º.tricies.vicies.semel` (2026-08-25) — UN SOLO SITIO decide de qué CLASE es el fallo al
 * volver a la solicitud por el enlace, porque de esa clase depende **qué salida se le
 * ofrece a la familia**, y ofrecerle la equivocada le empeora la situación.
 *
 * ── El defecto que cierra ────────────────────────────────────────────────────────────────
 * `ResumePage` tenía UN SOLO `catch` para la hidratación: **cualquier** fallo —el enlace
 * muerto de verdad, un corte de red, el tiempo agotado, un «Load failed» del navegador—
 * acababa en la portada diciendo *«El enlace puede haber caducado — introduce tu correo
 * para recibir uno nuevo»*. Y esa frase no es solo falsa cuando el enlace está vivo: la
 * SALIDA que ofrece **rota el token bueno** que la familia tiene en la mano y la manda a
 * esperar otro correo (2 minutos, medido) para chocar con lo mismo.
 *
 * ── Las TRES clases, y por qué son tres ──────────────────────────────────────────────────
 *   · `ENLACE_NO_VALE`     — el servidor DIJO que ese enlace no sirve (no lo reconoce, la
 *                            sesión se abandonó, o caducó de verdad a los 7 días), o el
 *                            token ni siquiera tiene forma válida. Aquí SÍ hay que pedir
 *                            uno nuevo: es la única salida que existe.
 *   · `NO_SE_PUDO_CARGAR`  — no hubo respuesta: red, tiempo agotado, el servidor no
 *                            contesta, el KMS no se pudo consultar. **El enlace no tiene
 *                            nada de malo** ⇒ se REINTENTA con el MISMO enlace y NO se
 *                            ofrece pedir otro.
 *   · `ERROR_NOMBRADO`     — el servidor contestó un error que YA viene nombrado (lo que
 *                            sea). Se dice ése, y se deja reintentar.
 *
 * ⛔ NO se adivina por el TEXTO del mensaje. Se mira el código de máquina que el servidor
 * pone en `error.code` y que `gasCall` conserva en `err.code`. Un mensaje se traduce, se
 * sanea y se reescribe; un código no.
 *
 * ⚠️ LÍMITE HONESTO, y hay que saberlo antes de tocar esto: los tres rechazos de «el enlace
 * no vale» **no tenían código hasta hoy** — `doPost` los devolvía como HTTP 500 con el
 * motivo en una cadena, y `gasCall` corta en `if (!res.ok)` antes de leer el cuerpo, así que
 * al navegador le llegaban como `Network error: 500`, indistinguibles de un corte de red.
 * Por eso el servidor se publica ANTES que este frontal: al revés, durante la ventana entre
 * las dos publicaciones una familia con el enlace caducado de verdad se quedaría
 * reintentando sin que nadie le ofrezca pedir otro.
 */

/**
 * Códigos con los que el SERVIDOR dice «este enlace no sirve». Los tres primeros los acuña
 * `_errorDeEnlace_` (`backend/Code.js`, un solo sitio); `BAD_REQUEST` es el token que ni
 * siquiera tiene forma de UUID (`assertValidUuid_`), que es el mismo caso desde el punto de
 * vista de la familia: ese enlace no la va a llevar a su solicitud.
 */
const ENLACE_MUERTO = new Set([
  'ENLACE_NO_VALIDO',
  'ENLACE_ABANDONADO',
  'ENLACE_CADUCADO',
  'BAD_REQUEST',
]);

/**
 * Códigos que significan «no se pudo preguntar», no «no vales». `SIN_RESPUESTA` lo acuña
 * `gasCall` cuando corta por el tope; `KMS_UNREACHABLE` lo acuña la puerta del asistente
 * cuando el KMS no contesta —y está escrito así a propósito: *«decirle a una familia
 * legítima que su enlace no vale porque el KMS está caído es peor que el fallo»*.
 */
const NO_SE_PUDO_PREGUNTAR = new Set([
  'SIN_RESPUESTA',
  'KMS_UNREACHABLE',
]);

/**
 * @param {Error & {code?: string}} err
 * @returns {'ENLACE_NO_VALE'|'NO_SE_PUDO_CARGAR'|'ERROR_NOMBRADO'}
 */
export function clasificarFalloDeEntrada(err) {
  const codigo = (err && err.code) ? String(err.code) : '';
  if (ENLACE_MUERTO.has(codigo)) return 'ENLACE_NO_VALE';
  if (NO_SE_PUDO_PREGUNTAR.has(codigo)) return 'NO_SE_PUDO_CARGAR';
  // SIN CÓDIGO ⇒ no hubo respuesta que leer: el `fetch` murió («Load failed»), el cuerpo no
  // era JSON, o el servidor contestó un HTTP que `gasCall` ni parsea. Es la clase que MÁS
  // pesa en el registro real de Diego, y la que este arreglo viene a separar de la primera.
  if (!codigo) return 'NO_SE_PUDO_CARGAR';
  return 'ERROR_NOMBRADO';
}

/**
 * ¿Se reintenta sola esta clase de fallo? Solo la de transporte: repetir una hidratación que
 * el servidor ya RECHAZÓ por su nombre no la va a aceptar la segunda vez, y repetir la de un
 * enlace muerto es peor todavía (le esconde la única salida que tiene).
 *
 * Reintentar es SEGURO y además suele ser RÁPIDO: la hidratación es una lectura, y el
 * intento que murió en el transporte dejó al servidor con su respuesta ya cocinada en caché
 * (`wz_hyd_`), así que el segundo intento no vuelve a pagar el camino entero.
 */
export function seReintentaSolo(clase) {
  return clase === 'NO_SE_PUDO_CARGAR';
}
