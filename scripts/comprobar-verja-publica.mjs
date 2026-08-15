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
  }
} catch (e) {
  motivo = 'error fatal — ' + (e && e.message)
} finally {
  console.log(motivo ? `VEREDICTO: ROJO — ${motivo}` : 'VEREDICTO: VERDE')
  process.exitCode = motivo ? 1 : 0
}
