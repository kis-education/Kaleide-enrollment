#!/usr/bin/env node
/**
 * ②2 + ②12 + ②26 — las CINCO puertas del asistente alcanzables desde internet: cuatro
 * pasan por UNA sola verja que falla cerrado, y la quinta exige el token de recuperación.
 *
 * ②27 — y, ya detrás del token, los manejadores de mutación exigen TODOS el código de un
 * solo uso: destruir el expediente y enviarlo no pueden pedir menos que corregirlo.
 *
 * El detalle de qué afirma, qué defecto vigila y qué NO afirma vive en
 * `scripts/verja-publica.mjs` (una sola implementación, dos invocadores: éste y la
 * integración continua). Se ejecuta donde vive el código que vigila.
 *
 * Veredicto: ÚLTIMA línea, SIEMPRE impresa, incluso ante error fatal. El veredicto se lee
 * de ahí, NUNCA del código de salida (una tubería devuelve el del último comando).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { comprobarVerjaPublica } from './verja-publica.mjs'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..')

let motivo = null
try {
  const fuente = readFileSync(join(RAIZ, 'backend/Code.js'), 'utf8')
  const fallos = comprobarVerjaPublica(fuente)
  fallos.forEach((f) => console.log('  ✗ ' + f))
  if (fallos.length) motivo = `${fallos.length} infracción(es): ${fallos.join(' · ')}`
  else {
    console.log('  ✓ la verja existe UNA vez y falla cerrado en sus 5 formas (ejecutada, 6 casos)')
    console.log('  ✓ crear solicitud · reconocer familia · recuperar enlace · código de un solo uso: las cuatro pasan por ella')
    console.log('  ✓ en recuperar enlace la verja va ANTES del trabajo caro y su rechazo devuelve el ack constante')
    console.log('  ✓ en el código de un solo uso la verja está en la rama de ALTA, antes del cupo, y NO en la de step-up')
    console.log('  ✓ «Guardar y seguir luego» exige el token de recuperación antes del cupo, y el expediente NO sale del cuerpo de la petición')
    console.log('  ✓ los 11 manejadores de mutación exigen el código de un solo uso, tras derivar el expediente del token y antes del trabajo caro (②27)')
    console.log('  ✓ subir y ver un documento ya no leen `enrEnrollments`/`recFiles` de AppSheet: las tres guardas las sirve el KMS (②17)')
    console.log('  ✓ la cabecera del expediente no se lee de AppSheet y la sirve UN SOLO lector contra el KMS (②17)')
    console.log('  ✓ la entrada de una solicitud nueva no lee `enrEnrollmentGroups`/`enrPersons` de AppSheet, y sigue decidiendo la sesión única (②17)')
    console.log('  ✓ la recuperación del enlace no lee `enrEnrollmentGroups`/`enrEmails`/`enrPersons` de AppSheet, la sirve UN SOLO lector contra el KMS, y sigue devolviendo el acuse constante (②17)')
    console.log('  ✓ la identidad de quien recupera no lee AppSheet: los tres eslabones pasan por el lector ÚNICO del KMS, y ni el resolvedor gemelo ni `findEmailIdForGuardian_` han vuelto (②17 · P245)')
    console.log('  ✓ quién puede contestar no se resuelve bajando las fichas: el conjunto lo sirve el KMS con el recorrido del ESCRITOR, y el token, el código de un solo uso y el rechazo siguen en pie (②17)')
    console.log('  ✓ las etiquetas de los documentos las compone el KMS: el envío ya no lee `recFiles`/`recScopes` ni manda `rec_scopes`, y el ámbito retirado no ha vuelto (②17)')
    console.log('  ✓ la puerta y sus tres hermanas no leen `enrEnrollmentGroups`: la cabecera la sirve el lector ÚNICO en modo tolerante, `assertGroupEditable_` reusa la fila ya validada, y el gate conserva forma, TTL y cross-group guard (②17)')
    console.log('  ✓ el pulso de la admisión no lee `enrEnrollments`/`enrPersons`/`sysStates_T`: lo sirve el lector ÚNICO contra el KMS, sin el literal del dominio (DL-E48), y siguen en pie el token, la frescura y la elección por `display_order` (②17)')
    console.log('  ✓ el racimo de firma no lee `sysSigningSessionSigners`/`sysSigningSessions`/`sysMilestones`/`sysMilestoneTypes`: lo sirve el lector ÚNICO contra el KMS, `signing_url` sigue recortado (CLI 81 / S5), un KMS caído no se disfraza de token inválido, y los dos ayudantes de hitos no han vuelto (②17)')
  }
} catch (e) {
  motivo = 'error fatal — ' + (e && e.message)
} finally {
  console.log(motivo ? `VEREDICTO: ROJO — ${motivo}` : 'VEREDICTO: VERDE')
  process.exitCode = motivo ? 1 : 0
}
