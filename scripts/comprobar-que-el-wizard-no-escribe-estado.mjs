#!/usr/bin/env node
/**
 * #wizard-no-escribe-estado (D33 / DL-S115) — comprueba que el wizard NO escribe el estado
 * de admisión ni dispara por su cuenta el correo de «solicitud recibida» en el camino del
 * envío. El modelo canónico: el envío COMPLETA la marca `APPLICATION_FORM_COMPLETED` y una
 * regla del tenant DISPARA la transición IN→RQ por el motor del KMS, que deja el rastro en
 * `sysStateTransitionLog`. El wizard reporta un HECHO; no decide ni escribe el estado.
 *
 * Este control vive AQUÍ y no en el KMS por la misma razón que
 * `comprobar-escrituras-directas.mjs` y `comprobar-receptor-firmado.mjs`: un control que
 * necesita el repositorio hermano se declara INERTE en la integración continua del otro lado
 * y no comprueba nada. El control se ejecuta donde vive el código que vigila. El gate del KMS
 * `#wizard-no-escribe-estado` importa esta misma función cuando tiene el hermano delante —
 * una sola implementación, dos invocadores.
 *
 * ⚠️ Mira LLAMADAS, no el nombre a secas: `WIZARD_FAMILY_CONFIRMATION` /
 * `WIZARD_INTERNAL_NOTIFICATION` aparecen hoy en COMENTARIOS que explican por qué NO se
 * mandan; un gate que casara el literal saldría rojo contra su propia documentación (fue
 * justo un comentario así el que hizo creer a tres agentes que el wizard mandaba ese correo).
 * Por eso se despojan primero las líneas de comentario.
 *
 * LÍMITE DECLARADO: es un detector por líneas, no un analizador sintáctico. Afirma la
 * AUSENCIA de los patrones de escritura de estado y de las llamadas de correo prohibidas en
 * el camino del envío; no demuestra el comportamiento en ejecución — eso lo recorre Diego a
 * mano (la red que escribía sobre expedientes se retiró el 2026-08-08).
 *
 * Veredicto: ÚLTIMA línea, SIEMPRE impresa, incluso ante error fatal.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..')

/** Despoja las líneas que son SOLO comentario (`//` o ` *`), para no casar nombres citados. */
function sinComentarios(fuente) {
  return fuente
    .split('\n')
    .map((l) => l.replace(/^\s*\/\/.*$/, '').replace(/^\s*\*.*$/, ''))
    .join('\n')
}

export function comprobarWizardNoEscribeEstado(fuente) {
  const fallos = []
  const src = sinComentarios(fuente)

  // 0 — el detector no está ciego: el camino del envío tiene que existir.
  const envio = /function submitEnrollmentSession_\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/.exec(src)
  if (!envio) {
    fallos.push('no se encontró `submitEnrollmentSession_` — el detector está ciego, verde aquí NO equivale a comprobado')
    return fallos
  }
  const cuerpo = envio[1]

  // 1 — el wizard NO fabrica una fila de transición de estado en el envío.
  if (/stateTransitionRows/.test(cuerpo)) fallos.push('`stateTransitionRows` reaparece en el envío — el wizard vuelve a fabricar la transición')
  if (/\bto_state_id\b/.test(cuerpo)) fallos.push('`to_state_id` reaparece en el envío — el wizard vuelve a escribir un estado de destino')
  if (/\bmode_actually_used\b/.test(cuerpo)) fallos.push('`mode_actually_used` reaparece en el envío — rastro de una transición fabricada por el wizard')
  if (/\brq_state_id\b/.test(cuerpo)) fallos.push('`rq_state_id` reaparece en el envío — el wizard vuelve a resolver el estado de destino')

  // 2 — el envío NO manda `state_transitions` al KMS (el motor deja ese rastro solo).
  if (/state_transitions\s*:/.test(cuerpo)) fallos.push('el envío vuelve a mandar `state_transitions` a wizardPersistSubmitSideEffects')

  // 3 — el wizard NO dispara por su cuenta el correo del envío. LLAMADAS, no nombres sueltos.
  const correo = /sendViaKmsNotify_\(\s*'(WIZARD_FAMILY_CONFIRMATION|WIZARD_INTERNAL_NOTIFICATION)'/g
  let m
  while ((m = correo.exec(cuerpo)) !== null) {
    fallos.push(`reaparece una LLAMADA \`sendViaKmsNotify_('${m[1]}'…)\` en el envío — ese correo lo manda la regla del tenant desde la entrada en RQ, no el wizard`)
  }

  return fallos
}

// Ejecutable directo: lee backend/Code.js y emite el veredicto.
if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  let motivo = null
  try {
    const fuente = readFileSync(join(RAIZ, 'backend/Code.js'), 'utf8')
    const fallos = comprobarWizardNoEscribeEstado(fuente)
    fallos.forEach((f) => console.log('  ✗ ' + f))
    if (fallos.length) motivo = `${fallos.length} infracción(es): ${fallos.join(' · ')}`
    else console.log('  ✓ el envío completa la marca y deja el estado al motor: sin escritura de estado ni correo propio')
  } catch (e) {
    motivo = 'error fatal — ' + (e && e.message)
  } finally {
    console.log(motivo ? `VEREDICTO: ROJO — ${motivo}` : 'VEREDICTO: VERDE')
    process.exitCode = motivo ? 1 : 0
  }
}
