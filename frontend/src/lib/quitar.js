/**
 * QUITAR de la solicitud — la pieza compartida, en un solo sitio.
 *
 * ── Qué arregla ─────────────────────────────────────────────────────────────────────────
 * Los botones de quitar del asistente (un tutor, un alumno, un correo, un teléfono, un
 * documento) hasta hoy solo borraban DE LA PANTALLA: al guardar se mandaba la lista
 * superviviente y el servidor guardaba lo que llegaba, sin tocar lo que dejaba de venir.
 * Resultado: quitar no se guardaba nunca, y al volver a entrar seguía todo ahí.
 *
 * ── Por qué en un solo fichero ──────────────────────────────────────────────────────────
 * Porque hay cinco botones de quitar en tres pantallas distintas. Cinco copias de «pide
 * confirmación, avisa al servidor, deshaz si dice que no» divergen en cuanto alguien toca
 * una: una acaba sin confirmación, otra sin deshacer. Una sola, no.
 *
 * ── Las tres reglas de esta pieza ───────────────────────────────────────────────────────
 *  1. **Se pregunta antes.** Para la familia esto es irreversible: lo que quita no lo puede
 *     recuperar ella.
 *  2. **Se quita de la pantalla al instante** y se avisa al servidor por detrás — la familia
 *     no espera. Pero si el servidor dice que NO se pudo, **se vuelve a poner** y se le
 *     explica por qué. Nunca se deja creer que se quitó algo que sigue ahí.
 *  3. **Lo que nunca llegó a guardarse no se manda.** Una persona que la familia añadió y
 *     quitó sin haber guardado no existe en el servidor: mandarla sería ruido.
 */

import { retirarDelExpediente } from '../api';
import { pedirConfirmacion } from '../components/ConfirmDialog';
import i18n from '../i18n';
import * as log from '../logger';

/**
 * ¿Merece la pena avisar al servidor de que esto se quita?
 *
 * Solo si el elemento tiene un identificador con forma de los que emite el sistema. Los que
 * la pantalla se inventa para poder pintar una lista (`_uid`, `row-3`) no son eso.
 *
 * @param {string} id
 * @returns {boolean}
 */
export function seGuardoAlgunaVez(id) {
  return typeof id === 'string' &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id.trim());
}

/**
 * Avisa al servidor de que la familia quita UNA cosa, y traduce su respuesta a algo que la
 * pantalla pueda usar sin volver a interpretar nada.
 *
 * NUNCA lanza: un fallo de red no puede tumbar la pantalla de una familia a mitad de su
 * solicitud. Devuelve `{ quitado:false, motivo }` y quien llama decide qué enseñar.
 *
 * @param {string} resumeToken
 * @param {'PERSONA'|'CORREO'|'TELEFONO'|'VINCULO'|'DOCUMENTO'} clase
 * @param {string} id
 * @returns {Promise<{quitado: boolean, motivo: string}>}
 */
export async function quitarEnElServidor(resumeToken, clase, id) {
  if (!resumeToken) {
    // Sin sesión no hay nada que quitar en el servidor (la familia todavía no ha guardado).
    return { quitado: true, motivo: '' };
  }
  try {
    const r = await retirarDelExpediente(resumeToken, [{ clase, id }]);

    // La solicitud ya está enviada: el servidor no quita nada y explica qué puede hacer.
    if (r && r.bloqueado) return { quitado: false, motivo: r.mensaje || '' };

    const v = r && Array.isArray(r.resultados) ? r.resultados[0] : null;
    if (!v) return { quitado: false, motivo: '' };

    // `YA_ESTABA` es un sí: lo que la familia quería quitar no está. No es un error.
    if (v.estado === 'QUITADO' || v.estado === 'YA_ESTABA') return { quitado: true, motivo: '' };

    log.warn('[quitar] el servidor no lo quitó', { clase, estado: v.estado });
    return { quitado: false, motivo: v.motivo || '' };
  } catch (e) {
    log.warn('[quitar] no se pudo avisar al servidor', { clase, error: String(e && e.message || e) });
    return { quitado: false, motivo: '' };
  }
}

/**
 * El gesto completo, tal y como lo vive la familia: preguntar → quitarlo de la pantalla →
 * avisar por detrás → deshacer y explicar si no se pudo.
 *
 * @param {Object}   o
 * @param {string}   o.resumeToken
 * @param {string}   o.clase          PERSONA | CORREO | TELEFONO | VINCULO | DOCUMENTO
 * @param {string}   o.id             el identificador del elemento (puede ser uno de pantalla)
 * @param {string}   o.pregunta       lo que se le pregunta antes de quitar
 * @param {string}   o.motivoPorDefecto  qué decirle si el servidor no explica por qué
 * @param {Function} o.quitarDeLaPantalla   () => void
 * @param {Function} o.volverAPonerlo       () => void   (solo se usa si el servidor dice que no)
 * @param {Function} o.avisar               (mensaje) => void
 */
export async function confirmarYQuitar(o) {
  const {
    resumeToken, clase, id, pregunta, motivoPorDefecto,
    quitarDeLaPantalla, volverAPonerlo, avisar,
  } = o;

  // La pregunta es la del asistente, no la del navegador. `pedirConfirmacion` devuelve una
  // promesa que NO se resuelve hasta que la familia contesta ⇒ nada de lo de abajo puede
  // ocurrir antes de la respuesta (con el `window.confirm` de antes lo garantizaba el
  // navegador; ahora lo garantiza este `await`, y quitarlo rompe el camino de la batería).
  if (pregunta) {
    const confirmado = await pedirConfirmacion({
      mensaje:        pregunta,
      textoConfirmar: i18n.t('quitar.confirmar_boton'),
    });
    if (!confirmado) return;
  }

  quitarDeLaPantalla();                     // la familia no espera al servidor

  if (!seGuardoAlgunaVez(id)) return;       // nunca se guardó ⇒ no hay nada que avisar

  const r = await quitarEnElServidor(resumeToken, clase, id);
  if (r.quitado) return;

  if (volverAPonerlo) volverAPonerlo();     // NO se finge: si sigue ahí, se vuelve a ver
  if (avisar) avisar(r.motivo || motivoPorDefecto || '');
}
