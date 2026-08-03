#!/usr/bin/env node
/**
 * comprobar-escrituras-directas.mjs — ejecuta el detector sobre `backend/Code.js` y
 * emite un veredicto legible en UNA línea.
 *
 * Se lee SIEMPRE de la ÚLTIMA línea (`VEREDICTO: VERDE` / `VEREDICTO: ROJO — <motivo>`),
 * nunca del código de salida: cuando la salida pasa por una tubería (`| tail`, `| tee`),
 * el código que se ve es el del ÚLTIMO comando, y así se coló ya un «error fatal» con
 * salida 0 en el repositorio hermano. El veredicto se imprime PASE LO QUE PASE —
 * también ante excepción no capturada o promesa no gestionada.
 *
 * El código de salida se conserva igualmente (0 verde / 1 rojo) porque es lo que hace
 * fallar el trabajo de integración continua.
 *
 * Uso:  node scripts/comprobar-escrituras-directas.mjs
 * Sin dependencias: solo `node:fs`. No necesita `npm ci`, ni red, ni navegador.
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { detectarEscriturasDirectas } from './escrituras-directas.mjs'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..')
const OBJETIVO = join(RAIZ, 'backend', 'Code.js')

let veredictoImpreso = false
function veredicto(verde, motivo) {
  if (veredictoImpreso) return
  veredictoImpreso = true
  console.log(verde ? 'VEREDICTO: VERDE — ninguna escritura directa a AppSheet en el backend anónimo'
                    : `VEREDICTO: ROJO — ${motivo}`)
}
// Red de seguridad: si el proceso muere por cualquier vía, la última línea sigue siendo un
// veredicto — y ROJO, porque «no llegué a comprobarlo» nunca es verde.
process.on('uncaughtException', (e) => { veredicto(false, `error fatal: ${e && e.message}`); process.exit(1) })
process.on('unhandledRejection', (e) => { veredicto(false, `promesa no gestionada: ${e && e.message}`); process.exit(1) })
process.on('exit', () => veredicto(false, 'el comprobador terminó sin emitir veredicto'))

// Cordura: sin el fichero que vigila, esto NO es «sin infracciones», es «no comprobado».
if (!existsSync(OBJETIVO)) {
  console.error(`No encuentro ${OBJETIVO}. ¿Se está ejecutando sobre la rama equivocada o sobre un árbol incompleto?`)
  veredicto(false, 'no se encontró backend/Code.js: no se ha comprobado nada')
  process.exit(1)
}

const hallazgos = detectarEscriturasDirectas(readFileSync(OBJETIVO, 'utf8'))

if (hallazgos.length) {
  for (const h of hallazgos) {
    console.error(`  ✗ ${h.texto}  [dentro de ${h.funcion}]`)
    console.error(`     ${h.motivo}`)
  }
  veredicto(false, `${hallazgos.length} escritura(s) directa(s) a AppSheet desde el backend anónimo: ` +
                   hallazgos.map((h) => h.texto).slice(0, 6).join(', ') + (hallazgos.length > 6 ? ', …' : ''))
  process.exit(1)
}

veredicto(true)
process.exit(0)
