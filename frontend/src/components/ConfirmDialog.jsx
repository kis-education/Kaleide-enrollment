/**
 * LA PREGUNTA DE CONFIRMACIÓN DEL ASISTENTE — una sola, y del colegio, no del navegador.
 *
 * ── Qué arregla ─────────────────────────────────────────────────────────────────────────
 * Los dos sitios donde el asistente pregunta antes de destruir algo (quitar a una persona
 * de la solicitud, empezar de cero) usaban `window.confirm`: un cuadro del sistema
 * operativo, encabezado «admissions.kaleide.org dice», con la tipografía y los botones del
 * navegador. Lo ve una familia en el momento más delicado del formulario y parece un aviso
 * del navegador, no del colegio.
 *
 * ── La trampa de esta conversión, y cómo se evita ───────────────────────────────────────
 * `window.confirm` **detiene** la ejecución y devuelve `true`/`false` en la misma línea; un
 * cuadro de React **no**. Los dos sitios estaban escritos como `if (!confirm(...)) return;`.
 * Convertirlos mal haría que quitar a una persona ocurriese **sin preguntar**.
 * Por eso esta pieza NO expone un componente que el que llama tenga que orquestar: expone
 * `pedirConfirmacion(...)`, que devuelve una **promesa** que no se resuelve hasta que la
 * familia contesta. El que llama sigue escribiendo una sola línea —
 * `if (!await pedirConfirmacion(...)) return;` — y la acción es literalmente inalcanzable
 * antes de la respuesta.
 *
 * ── Por qué una sola, compartida ────────────────────────────────────────────────────────
 * Dos cuadros parecidos divergen en cuanto alguien toca uno: uno acaba sin `Esc`, otro con
 * el botón de confirmar bajo el pulgar. Uno solo, no.
 *
 * ── Las reglas de este cuadro ───────────────────────────────────────────────────────────
 *  1. **Nada se hace sin respuesta.** Sin anfitrión montado, `pedirConfirmacion` responde
 *     que NO (ante la duda, no se destruye) y lo deja escrito en el registro.
 *  2. **Se sale con `Esc`**, y con `Esc` se cancela — nunca se confirma.
 *  3. **El foco entra en el cuadro y no se escapa por detrás** mientras está abierto, y
 *     vuelve a donde estaba al cerrarse.
 *  4. **El botón de confirmar NO es el que queda bajo el pulgar.** En móvil el de abajo —
 *     el que cae bajo el dedo — es *Cancelar*; y el foco inicial también es *Cancelar*,
 *     así que pulsar Intro sin leer no destruye nada.
 */

import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import * as log from '../logger';

// El anfitrión montado publica aquí su forma de pintar; la promesa en curso, su respuesta.
let mostrar = null;    // (pregunta|null) => void
let responder = null;  // (boolean) => void

/**
 * Pregunta a la familia y NO devuelve nada hasta que conteste.
 *
 * @param {Object|string} opciones  el texto, o `{ mensaje, titulo, textoConfirmar, textoCancelar }`
 * @returns {Promise<boolean>} `true` solo si la familia lo confirmó explícitamente.
 */
export function pedirConfirmacion(opciones) {
  const o = (typeof opciones === 'string') ? { mensaje: opciones } : (opciones || {});

  if (!mostrar) {
    // Sin cuadro no se puede preguntar; y sin preguntar no se destruye nada.
    log.error('[confirmar] no hay cuadro de confirmación montado — no se hace nada');
    return Promise.resolve(false);
  }
  if (responder) {
    // Ya hay una pregunta abierta: la segunda no se apila (se contesta que no y basta).
    log.warn('[confirmar] ya había una pregunta abierta; la nueva se descarta');
    return Promise.resolve(false);
  }

  return new Promise((resolve) => {
    responder = (respuesta) => {
      responder = null;
      if (mostrar) mostrar(null);
      resolve(respuesta === true);
    };
    mostrar(o);
  });
}

/**
 * El anfitrión. Se monta UNA vez, arriba del todo (`App.jsx`), y pinta la pregunta en
 * curso — ninguna pantalla necesita montar el suyo.
 */
export default function ConfirmDialog() {
  const { t } = useTranslation();
  const [pregunta, setPregunta] = useState(null);
  const cajaRef = useRef(null);
  const cancelarRef = useRef(null);
  const focoPrevioRef = useRef(null);

  // Registro del anfitrión. Al desmontar, cualquier pregunta viva se contesta que NO:
  // quien esperaba no se queda colgado, y la respuesta segura es no destruir.
  useEffect(() => {
    mostrar = setPregunta;
    return () => {
      mostrar = null;
      if (responder) responder(false);
      setPregunta(null);
    };
  }, []);

  const contestar = useCallback((respuesta) => {
    if (responder) responder(respuesta);
    else setPregunta(null);
  }, []);

  // Foco dentro, y de vuelta al salir. El foco inicial es CANCELAR (regla 4).
  useEffect(() => {
    if (!pregunta) return undefined;
    focoPrevioRef.current = document.activeElement;
    const desbloquear = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const id = setTimeout(() => { if (cancelarRef.current) cancelarRef.current.focus(); }, 0);
    return () => {
      clearTimeout(id);
      document.body.style.overflow = desbloquear;
      const previo = focoPrevioRef.current;
      if (previo && typeof previo.focus === 'function') { try { previo.focus(); } catch { /* se fue de la pantalla */ } }
    };
  }, [pregunta]);

  if (!pregunta) return null;

  const titulo         = pregunta.titulo         || t('confirmar.titulo');
  const textoConfirmar = pregunta.textoConfirmar || t('confirmar.aceptar');
  const textoCancelar  = pregunta.textoCancelar  || t('common.cancel');

  // El foco no se escapa por detrás: Tab da la vuelta dentro del cuadro. Esc cancela.
  const alTeclear = (e) => {
    if (e.key === 'Escape') { e.preventDefault(); contestar(false); return; }
    if (e.key !== 'Tab') return;
    const focosables = cajaRef.current ? Array.from(cajaRef.current.querySelectorAll('button')) : [];
    if (focosables.length === 0) return;
    const primero = focosables[0];
    const ultimo  = focosables[focosables.length - 1];
    if (e.shiftKey && document.activeElement === primero) { e.preventDefault(); ultimo.focus(); }
    else if (!e.shiftKey && document.activeElement === ultimo) { e.preventDefault(); primero.focus(); }
  };

  return (
    <div
      className="kis-confirm-backdrop"
      data-testid="confirm-dialog"
      onMouseDown={(e) => { if (e.target === e.currentTarget) contestar(false); }}
      onKeyDown={alTeclear}
    >
      <div
        className="kis-confirm-box"
        ref={cajaRef}
        role="dialog"
        aria-modal="true"
        aria-labelledby="kis-confirm-title"
        aria-describedby="kis-confirm-text"
      >
        <h2 className="kis-confirm-title" id="kis-confirm-title">{titulo}</h2>
        <p className="kis-confirm-text" id="kis-confirm-text">{pregunta.mensaje}</p>
        {/* Orden en el documento: confirmar primero, cancelar después. En pantalla ancha
            se invierte (confirmar a la derecha, como se espera); en móvil se apila y el
            de abajo —bajo el pulgar— es CANCELAR. Regla 4. */}
        <div className="kis-confirm-actions">
          <button
            type="button"
            className="kis-confirm-danger"
            data-testid="confirm-dialog-accept"
            onClick={() => contestar(true)}
          >
            {textoConfirmar}
          </button>
          <button
            type="button"
            className="btn-secondary-kis"
            data-testid="confirm-dialog-cancel"
            ref={cancelarRef}
            onClick={() => contestar(false)}
          >
            {textoCancelar}
          </button>
        </div>
      </div>
    </div>
  );
}
