#!/usr/bin/env node
/**
 * EL LANZADOR DE LOS ARNESES DEL SERVIDOR — noveno control de CI.
 * ══════════════════════════════════════════════════════════════════════════════════════
 *
 * `node scripts/comprobar-el-servidor.mjs`
 * Sin red, sin navegador, sin `npm ci`. Última línea: `VEREDICTO: VERDE` / `ROJO — <motivo>`.
 *
 * QUÉ HACE, en una frase: **descubre TODOS los arneses de `scripts/servidor/`, los ejecuta y
 * junta sus veredictos en uno solo**, para que los que se escriban a partir de ahora se corran
 * solos en cada empujón a `main` en vez de depender de que alguien se acuerde.
 *
 * POR QUÉ EXISTE (Diego, 2026-09-23, *«si arregla las cosas, adelante»*). El servidor del
 * asistente tiene **208 funciones** y solo **3** las ejecutaba algún control; los ocho controles
 * anteriores LEEN LÍNEAS y la batería corre contra un backend SIMULADO. Cada arreglo del
 * servidor se comprobaba **una vez**, con un arnés que se tiraba — «arnés efímero» sale **54
 * veces** en el histórico de `CLAUDE.md` —, así que el cambio siguiente lo rompía sin que nadie
 * se enterara hasta que Diego lo veía en pantalla. Esto no abre una clase de calidad nueva:
 * **deja de destruir la que ya se escribe.**
 *
 * ⛔ **EL MOLDE DE UN ARNÉS NO SE DECLARA AQUÍ**: vive donde lo va a leer quien escriba el
 * siguiente, `scripts/servidor/LEEME.md`. Aquí solo está lo que el lanzador EXIGE al ejecutarlo.
 *
 * LO QUE EXIGE A CADA ARNÉS — y por qué cada exigencia:
 *
 *   1. Que su **ÚLTIMA línea con texto** sea `VEREDICTO: VERDE` o `VEREDICTO: ROJO — <motivo>`.
 *      Un arnés que revienta deja un rastro de pila como última línea: eso NO es un veredicto y
 *      sale ROJO. Leer el veredicto de otro sitio (un `grep`, el código de salida a secas) es
 *      exactamente cómo se cuela un rojo por verde en este repositorio.
 *   2. Que su código de salida **no contradiga** su propia línea. Un arnés que dice VERDE y sale
 *      con código distinto de 0 está roto: se dice, no se elige la mitad que conviene.
 *   3. Que **termine**. Un arnés colgado dejaría el trabajo de CI girando; hay tope y se NOMBRA.
 *   4. **`2026-09-23-un-arnes-que-no-afirma-nada-pasa`** — que un VERDE **declare cuántas
 *      afirmaciones corrió** (`VERDE — N afirmaciones`) y que N sea **al menos 1**. Sin esto, un
 *      arnés que se quedó sin afirmaciones —una excepción tapada, un renombrado que un `catch`
 *      se tragó, un refactor que vació el cuerpo— seguía diciendo VERDE: exactamente el verde
 *      falso que el resto de este lanzador existe para impedir, una capa más arriba.
 *
 * ⛔ **SI NO ENCUENTRA NINGUNO, SALE ROJO.** Un control que no mide nada no puede decir VERDE:
 * ése es justo el verde falso que esto viene a impedir.
 *
 * ⛔ **EL VEREDICTO SE IMPRIME SIEMPRE** — también ante un error fatal del propio lanzador. Sin
 * eso, un fallo suyo saldría con código 0 y CI lo daría por bueno (la trampa que este repositorio
 * ya documenta con `verja-publica.mjs`).
 *   ⚠️ **Dicho sin adornar: hoy quien lo garantiza es el `finally`**, porque el cuerpo es
 *   SÍNCRONO y siempre llega a él — eso es lo que está demostrado. Los dos oyentes de excepción
 *   no capturada y promesa no gestionada son un cinturón **para el día que alguien meta un
 *   `await` aquí**; hoy no pueden llegar antes que el `finally`, así que **no se ha visto
 *   dispararse a ninguno de los dos** y no se cuentan como red. Si ese día llega, se demuestran.
 *
 * ⛔ **Y SE COMPRUEBA A SÍ MISMO ANTES DE JUZGAR A NADIE** (§ «autocomprobación», abajo): si su
 * lectura del veredicto se afloja —una expresión más laxa, un `includes` en vez del principio de
 * línea—, **todos los rojos se volverían verdes en silencio**. La autocomprobación ejecuta un
 * arnés sintético VERDE y otro ROJO y exige que los distinga. Si no los distingue, ROJO.
 *
 * ⚠️ **LO QUE NO AFIRMA:** no ejecuta el servidor — eso lo hacen los arneses. Aquí solo se
 * afirma que se lanzaron todos los que hay y que sus veredictos se leyeron sin aflojar nada.
 *
 * El segundo argumento (la carpeta) existe SOLO para poder verlo en ROJO: con una carpeta vacía,
 * con un arnés que falla, o con una carpeta que no existe. En CI se ejecuta sin argumentos.
 */

import { readdirSync } from 'node:fs'
import { spawnSync } from 'node:child_process'
import path, { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const AQUI = dirname(fileURLToPath(import.meta.url))
const CARPETA = process.argv[2] ? path.resolve(process.argv[2]) : join(AQUI, 'servidor')

/** Tope por arnés. Los de hoy tardan ~1 s; esto solo existe para que un colgado se VEA. */
const TOPE_MS = 180000

// ── El veredicto se imprime SIEMPRE, pase lo que pase ───────────────────────────────────
let yaDicho = false
function decir(motivo) {
  if (yaDicho) return
  yaDicho = true
  console.log(motivo ? 'VEREDICTO: ROJO — ' + motivo : 'VEREDICTO: VERDE')
  process.exitCode = motivo ? 1 : 0
}
process.on('uncaughtException', (e) => {
  decir('excepción no capturada del propio lanzador — ' + (e && e.message))
  process.exit(1)
})
process.on('unhandledRejection', (e) => {
  decir('promesa no gestionada del propio lanzador — ' + (e && e.message ? e.message : String(e)))
  process.exit(1)
})

// ── Ejecutar y JUZGAR ───────────────────────────────────────────────────────────────────

/** La última línea CON TEXTO de lo que escribió. Vacío si no escribió nada. */
function ultimaLineaConTexto(salida) {
  const lineas = String(salida == null ? '' : salida).split('\n').filter((l) => l.trim() !== '')
  return lineas.length ? lineas[lineas.length - 1].trim() : ''
}

/**
 * El juicio, en UNA función pura — para poder comprobarlo sin lanzar nada.
 * Devuelve `null` si está VERDE, o el motivo del ROJO.
 */
// `2026-09-23-un-arnes-que-no-afirma-nada-pasa` — un VERDE tiene que DECLARAR cuántas
// afirmaciones corrió, y ese número tiene que ser ≥ 1. Sin esto, un arnés que se quedó sin
// afirmaciones —una excepción tapada, un renombrado que un `catch` se tragó, un refactor que
// vació el cuerpo— sigue diciendo VERDE, y es exactamente el verde falso que el resto de este
// lanzador existe para impedir, una capa más abajo. Forma exigida: `VERDE — <N> afirmaciones`
// (con lo que quiera venir detrás, dos puntos y una frase incluidos).
const CUENTA_DE_AFIRMACIONES_RE = /^VERDE\s*—\s*(\d+)\s+afirmaci/i

function juzgar({ arranco, colgado, codigo, ultima }) {
  if (!arranco) return 'no se pudo ejecutar'
  if (colgado) return 'no terminó en ' + Math.round(TOPE_MS / 1000) + ' s y se cortó'
  if (!ultima) return 'no escribió ni una línea: no hay veredicto que leer'
  if (!ultima.startsWith('VEREDICTO: ')) {
    return 'su última línea no es un veredicto (' + JSON.stringify(ultima.slice(0, 160)) + ')'
  }
  const cuerpo = ultima.slice('VEREDICTO: '.length)
  if (cuerpo.startsWith('ROJO')) return cuerpo.replace(/^ROJO\s*—?\s*/, '') || 'ROJO sin motivo'
  if (!cuerpo.startsWith('VERDE')) {
    return 'veredicto que no se entiende (' + JSON.stringify(ultima.slice(0, 160)) + ')'
  }
  if (codigo !== 0) return 'dice VERDE y termina con código ' + codigo + ': se contradice a sí mismo'
  const cuenta = CUENTA_DE_AFIRMACIONES_RE.exec(cuerpo)
  if (!cuenta) {
    return 'dice VERDE sin declarar cuántas afirmaciones corrió (falta «— N afirmaciones» en su ' +
      'propio veredicto): un arnés que no dice cuánto midió no puede decir verde'
  }
  if (Number(cuenta[1]) < 1) {
    return 'dice VERDE con CERO afirmaciones: un arnés que mide nada no puede decir verde'
  }
  return null
}

/** Lanza `node <args>` y devuelve lo que hace falta para juzgarlo. */
function lanzar(args) {
  const r = spawnSync(process.execPath, args, {
    encoding: 'utf8', timeout: TOPE_MS, maxBuffer: 32 * 1024 * 1024,
  })
  const salida = (r.stdout || '') + (r.stderr && !r.stdout ? r.stderr : '')
  return {
    arranco: !r.error || r.error.code === 'ETIMEDOUT',
    colgado: r.signal === 'SIGTERM' || (r.error && r.error.code === 'ETIMEDOUT'),
    codigo: typeof r.status === 'number' ? r.status : -1,
    ultima: ultimaLineaConTexto(salida),
    salida: r.stdout || '',
    error: r.stderr || '',
  }
}

// ── El trabajo ──────────────────────────────────────────────────────────────────────────
try {
  console.log('LOS ARNESES DEL SERVIDOR — ' + CARPETA)

  // ⛔ AUTOCOMPROBACIÓN. Si el lanzador no sabe ver un ROJO, todo lo demás sobra: cantaría
  // VERDE sobre un servidor roto. Dos arneses sintéticos, uno de cada color, ejecutados de
  // verdad (spawn + captura + juicio), más los casos que no se pueden fabricar con un proceso.
  const sintetico = (cuerpo) => ['-e', cuerpo]
  const cegueras = []
  const verdeReal = juzgar(lanzar(sintetico(
    "console.log('ruido');console.log('VEREDICTO: VERDE — 3 afirmaciones')")))
  if (verdeReal !== null) cegueras.push('no reconoce un VERDE de verdad (' + verdeReal + ')')
  const rojoReal = juzgar(lanzar(sintetico(
    "console.log('VEREDICTO: ROJO — motivo sintético');process.exit(1)")))
  if (rojoReal === null) cegueras.push('deja pasar por VERDE un arnés que dice ROJO')
  const revientaReal = juzgar(lanzar(sintetico("throw new Error('sintético')")))
  if (revientaReal === null) cegueras.push('deja pasar por VERDE un arnés que revienta sin veredicto')
  const mudoReal = juzgar(lanzar(sintetico('process.exit(0)')))
  if (mudoReal === null) cegueras.push('deja pasar por VERDE un arnés que no escribe nada')
  const mentiroso = juzgar({ arranco: true, colgado: false, codigo: 1, ultima: 'VEREDICTO: VERDE — 3 afirmaciones' })
  if (mentiroso === null) cegueras.push('deja pasar un VERDE que se contradice con su código de salida')
  const colgadoCaso = juzgar({ arranco: true, colgado: true, codigo: -1, ultima: 'VEREDICTO: VERDE — 3 afirmaciones' })
  if (colgadoCaso === null) cegueras.push('deja pasar por VERDE un arnés que hubo que cortar')
  // `2026-09-23-un-arnes-que-no-afirma-nada-pasa` — el mismo fallo que este lanzador existe
  // para impedir, una capa más arriba: un VERDE que no dice cuánto midió, o que dice CERO.
  const verdeSinContar = juzgar(lanzar(sintetico("console.log('VEREDICTO: VERDE')")))
  if (verdeSinContar === null) cegueras.push('deja pasar por VERDE un arnés que no declara cuántas afirmaciones corrió')
  const verdeConCero = juzgar(lanzar(sintetico("console.log('VEREDICTO: VERDE — 0 afirmaciones')")))
  if (verdeConCero === null) cegueras.push('deja pasar por VERDE un arnés que declara CERO afirmaciones')
  if (cegueras.length) {
    decir('el lanzador no sabe ver un rojo: ' + cegueras.join(' · '))
  } else {
    console.log('  ✓ autocomprobación: distingue VERDE, ROJO, reventado, mudo, mentiroso, colgado, ' +
      'VERDE sin contar y VERDE con CERO afirmaciones')

    // Los arneses de verdad.
    let ficheros
    try {
      ficheros = readdirSync(CARPETA)
        .filter((f) => f.endsWith('.mjs'))
        .sort()
    } catch (e) {
      throw new Error('no se pudo leer la carpeta de arneses (' + (e && e.code) + ')')
    }

    if (!ficheros.length) {
      // ⛔ Un control que no mide nada NO puede decir VERDE.
      decir('no hay ni un arnés en ' + CARPETA + ': un control que no mide nada no puede decir VERDE')
    } else {
      const rotos = []
      for (const f of ficheros) {
        const res = lanzar([join(CARPETA, f)])
        const motivo = juzgar(res)
        if (motivo === null) {
          console.log('  ✓ ' + f + ' — ' + res.ultima.slice(0, 150))
        } else {
          console.log('  ✗ ' + f + ' — ' + motivo)
          if (res.salida) res.salida.split('\n').forEach((l) => l.trim() && console.log('      | ' + l))
          if (res.error) res.error.split('\n').forEach((l) => l.trim() && console.log('      ! ' + l))
          rotos.push(f + ': ' + motivo)
        }
      }
      if (rotos.length) {
        decir(rotos.length + ' de ' + ficheros.length + ' arneses en ROJO — ' + rotos.join(' · '))
      } else {
        console.log('  ✓ los ' + ficheros.length + ' arneses de `scripts/servidor/` en VERDE')
        decir(null)
      }
    }
  }
} catch (e) {
  decir('error fatal del propio lanzador — ' + (e && e.message ? e.message : String(e)))
} finally {
  // Si algo se saltó las dos ramas de arriba, aquí no se sale en silencio.
  decir('el lanzador terminó sin dar veredicto')
}
