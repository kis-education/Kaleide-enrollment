#!/usr/bin/env node
/**
 * comprobar-personas-quitadas.mjs — el asistente no puede volver a contar a quien la
 * familia ya quitó de su solicitud. Emite un veredicto legible en UNA línea.
 *
 * Se lee SIEMPRE de la ÚLTIMA línea (`VEREDICTO: VERDE` / `VEREDICTO: ROJO — <motivo>`),
 * nunca del código de salida: cuando la salida pasa por una tubería (`| tail`, `| tee`),
 * el código que se ve es el del ÚLTIMO comando. El veredicto se imprime PASE LO QUE PASE,
 * también ante excepción no capturada o promesa no gestionada.
 *
 * Uso:  node scripts/comprobar-personas-quitadas.mjs
 * Sin dependencias: solo `node:fs`. No necesita `npm ci`, ni red, ni navegador (~1 s).
 */
import { readFileSync, existsSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import { comprobarPersonasQuitadas } from './personas-quitadas.mjs'

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

const { casosMal, casosRevisados, lecturasCrudas, lecturasRevisadas, motivoFatal } =
  comprobarPersonasQuitadas(readFileSync(OBJETIVO, 'utf8'))

if (motivoFatal) { veredicto(false, motivoFatal); process.exit(1) }

if (lecturasRevisadas === 0) {
  veredicto(false, 'no se encontró NI UNA lectura de personas/teléfonos/correos en backend/Code.js — ' +
    'la comprobación no está mirando lo que dice mirar, y en vacío NO es verde')
  process.exit(1)
}

if (casosMal.length) {
  console.log(`Quién sigue en la solicitud — ${casosMal.length} de ${casosRevisados} caso(s) MAL:\n`)
  for (const { caso, obtenido } of casosMal) {
    console.log(`  ✗ ${caso.nombre}`)
    console.log(`      esperado: ${caso.viva}`)
    console.log(`      sale:     ${obtenido}`)
    console.log(`      daño:     ${caso.dano}\n`)
  }
}

if (lecturasCrudas.length) {
  console.log(`Lecturas que se SALTAN el único sitio que decide — ${lecturasCrudas.length} de ${lecturasRevisadas}:\n`)
  for (const l of lecturasCrudas) {
    console.log(`  ✗ Code.js:${l.linea}  (${l.forma}, T.${l.tabla}, dentro de ${l.fn})`)
    console.log(`      ${l.texto}`)
  }
  console.log('\n  Envuélvelas en `wizardSoloVivas_(…)`. Si esa lectura DEBE ver también a las')
  console.log('  personas quitadas (un diagnóstico que las cuenta), declara su función en')
  console.log('  EXENTAS de scripts/personas-quitadas.mjs CON EL MOTIVO escrito.\n')
}

if (casosMal.length || lecturasCrudas.length) {
  veredicto(false,
    `${casosMal.length} caso(s) del criterio y ${lecturasCrudas.length} lectura(s) sin colar — ` +
    'el asistente vuelve a contar a gente que la familia quitó, y la puerta del envío le pedirá el teléfono')
} else {
  veredicto(true,
    `los ${casosRevisados} casos del criterio salen bien y las ${lecturasRevisadas} lecturas de ` +
    'personas/teléfonos/correos/vínculos pasan por el único sitio que decide quién sigue en la solicitud')
}
