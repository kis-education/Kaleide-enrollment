#!/usr/bin/env node
/**
 * comprobar-codigos-de-consentimiento.mjs — ejecuta la comprobación de los códigos de
 * consentimiento sobre `backend/Code.js` y emite un veredicto legible en UNA línea.
 *
 * Se lee SIEMPRE de la ÚLTIMA línea (`VEREDICTO: VERDE` / `VEREDICTO: ROJO — <motivo>`),
 * nunca del código de salida: cuando la salida pasa por una tubería (`| tail`, `| tee`),
 * el código que se ve es el del ÚLTIMO comando. El veredicto se imprime PASE LO QUE PASE,
 * también ante excepción no capturada o promesa no gestionada.
 *
 * Uso:  node scripts/comprobar-codigos-de-consentimiento.mjs
 * Sin dependencias: solo `node:fs`. No necesita `npm ci`, ni red, ni navegador (~1 s).
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { comprobarCodigos } from './codigos-de-consentimiento.mjs'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..')
const OBJETIVO = join(RAIZ, 'backend', 'Code.js')

let veredictoImpreso = false
function veredicto(verde, motivo) {
  if (veredictoImpreso) return
  veredictoImpreso = true
  console.log(verde ? `VEREDICTO: VERDE — ${motivo}` : `VEREDICTO: ROJO — ${motivo}`)
  process.exitCode = verde ? 0 : 1
}

process.on('uncaughtException', (e) => { veredicto(false, `excepción no capturada: ${e && e.message}`); process.exit(1) })
process.on('unhandledRejection', (e) => { veredicto(false, `promesa no gestionada: ${e && e.message}`); process.exit(1) })
process.on('exit', () => { if (!veredictoImpreso) console.log('VEREDICTO: ROJO — la comprobación terminó sin emitir veredicto') })

if (!existsSync(OBJETIVO)) {
  veredicto(false, `no existe ${OBJETIVO}: no hay nada que comprobar (y una comprobación en vacío NO es verde)`)
  process.exit(1)
}

const { fallos, revisados, motivoFatal } = comprobarCodigos(readFileSync(OBJETIVO, 'utf8'))

if (motivoFatal) {
  veredicto(false, motivoFatal)
  process.exit(1)
}

if (fallos.length) {
  console.log(`Códigos de consentimiento — ${fallos.length} de ${revisados} comprobación(es) MAL:\n`)
  for (const { caso, dano } of fallos) {
    console.log(`  ✗ ${caso}`)
    console.log(`      daño: ${dano}\n`)
  }
  veredicto(false, `${fallos.length} de ${revisados} comprobaciones fallan: el wizard puede escribir ` +
    'en el libro de consentimientos un código que no está en el catálogo')
} else {
  veredicto(true, `las ${revisados} comprobaciones pasan: todo código emitido está en el catálogo, ` +
    'un tipo desconocido lanza en vez de inventarse un código, y los tipos reales de las pantallas se resuelven')
}
