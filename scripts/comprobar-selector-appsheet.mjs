#!/usr/bin/env node
/**
 * comprobar-selector-appsheet.mjs — ejecuta la comprobación del traductor de filtros
 * sobre `backend/Code.js` y emite un veredicto legible en UNA línea.
 *
 * Se lee SIEMPRE de la ÚLTIMA línea (`VEREDICTO: VERDE` / `VEREDICTO: ROJO — <motivo>`),
 * nunca del código de salida: cuando la salida pasa por una tubería (`| tail`, `| tee`),
 * el código que se ve es el del ÚLTIMO comando. El veredicto se imprime PASE LO QUE PASE,
 * también ante excepción no capturada o promesa no gestionada.
 *
 * Uso:  node scripts/comprobar-selector-appsheet.mjs
 * Sin dependencias: solo `node:fs`. No necesita `npm ci`, ni red, ni navegador (~1 s).
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { comprobarTraductor } from './selector-appsheet.mjs'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..')
const OBJETIVO = join(RAIZ, 'backend', 'Code.js')

let veredictoImpreso = false
function veredicto(verde, motivo) {
  if (veredictoImpreso) return
  veredictoImpreso = true
  console.log(verde
    ? `VEREDICTO: VERDE — ${motivo}`
    : `VEREDICTO: ROJO — ${motivo}`)
  process.exitCode = verde ? 0 : 1
}

process.on('uncaughtException', (e) => { veredicto(false, `excepción no capturada: ${e && e.message}`); process.exit(1) })
process.on('unhandledRejection', (e) => { veredicto(false, `promesa no gestionada: ${e && e.message}`); process.exit(1) })
process.on('exit', () => { if (!veredictoImpreso) console.log('VEREDICTO: ROJO — la comprobación terminó sin emitir veredicto') })

if (!existsSync(OBJETIVO)) {
  veredicto(false, `no existe ${OBJETIVO}: no hay nada que comprobar (y una comprobación en vacío NO es verde)`)
  process.exit(1)
}

const { fallos, revisados, motivoFatal } = comprobarTraductor(readFileSync(OBJETIVO, 'utf8'))

if (motivoFatal) {
  veredicto(false, motivoFatal)
  process.exit(1)
}

if (fallos.length) {
  console.log(`Traducción de filtros a AppSheet — ${fallos.length} de ${revisados} caso(s) MAL:\n`)
  for (const { caso, obtenido } of fallos) {
    console.log(`  ✗ ${caso.nombre}`)
    console.log(`      entra:    ${caso.entrada}`)
    console.log(`      esperado: ${caso.esperado}`)
    console.log(`      sale:     ${obtenido}`)
    console.log(`      daño:     ${caso.dano}\n`)
  }
  veredicto(false, `${fallos.length} de ${revisados} traducciones de filtro NO son las que AppSheet entiende ` +
    '(AND/OR son FUNCIONES; en forma infija AppSheet devuelve la tabla entera, en silencio)')
} else {
  veredicto(true, `las ${revisados} traducciones de filtro emiten AND()/OR() como funciones, ` +
    'respetan paréntesis y comillas, y no dejan ningún && o || sin traducir')
}
