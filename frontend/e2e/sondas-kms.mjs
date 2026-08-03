/**
 * sondas-kms.mjs — el puente que le da OJOS al robot dentro de la base de datos.
 *
 * ── El problema que resuelve ─────────────────────────────────────────────────────────
 * Hasta hoy el robot afirmaba sobre la PANTALLA. Un paso que pinta perfecto y no guarda
 * nada salía VERDE: la pantalla no sabe si la fila llegó. Este módulo llama, después de
 * cada paso, a una SONDA DE LECTURA del KMS que mira la base de datos de verdad y devuelve
 * conteos y contenido redactado.
 *
 * ── Por qué el driver es Node y no Apps Script ──────────────────────────────────────
 * Apps Script corta cualquier función a ~6 minutos. La red anterior metía TODO el recorrido
 * en una sola ejecución de GAS, llegó a 392.865 ms contra un tope de 360.000 y dejó de
 * devolver veredicto. Aquí el reparto es el correcto: **Node conduce** (no tiene límite) y
 * **el KMS solo expone sondas cortas** que devuelven en segundos.
 *
 * ── Cómo llega la llamada al KMS ────────────────────────────────────────────────────
 * Reutilizando `scripts/gas-run-via-api.mjs` del repositorio del KMS, que ya resuelve el
 * túnel del proxy de salida con `curl` (el `fetch` de Node corta en ejecuciones largas).
 * No se reimplementa: una segunda implementación del mismo transporte diverge, y un
 * transporte divergido miente.
 *
 * ── Si el puente no está, el robot NO se pone verde ─────────────────────────────────
 * Sin el repositorio del KMS al lado, o sin credenciales de Apps Script, las sondas no se
 * pueden ejecutar. Eso NO es "no aplica": es **cobertura perdida**, y se reporta como tal.
 * Un robot que se declarara verde porque no pudo mirar sería peor que no tener sondas.
 */
import { execFileSync } from 'node:child_process'
import { existsSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'

const AQUI = dirname(fileURLToPath(import.meta.url))

/**
 * Localiza el repositorio del KMS. Se admite `E2E_KMS_REPO`; si no, se busca como hermano
 * del checkout del wizard, que es la disposición real de las máquinas donde esto corre.
 * No hay "destino por defecto" inventado: si no se encuentra, se dice y se acabó.
 */
function localizarKms() {
  const candidatos = [
    process.env.E2E_KMS_REPO,
    join(AQUI, '..', '..', '..', 'kis-app'),
    '/home/user/kis-app',
  ].filter(Boolean)
  for (const c of candidatos) {
    if (existsSync(join(c, 'scripts', 'gas-run-via-api.mjs'))) return c
  }
  return null
}

export const KMS_REPO = localizarKms()

/** Motivo por el que las sondas no están disponibles, o `null` si lo están. */
export function porQueNoHaySondas() {
  if (!KMS_REPO) {
    return 'no se encuentra el repositorio del KMS (ni E2E_KMS_REPO, ni un hermano `kis-app` ' +
      'con scripts/gas-run-via-api.mjs): sin él no se puede leer la base de datos de vuelta'
  }
  return null
}

/**
 * Invoca una función `manual_*` del KMS y devuelve su resultado ya parseado.
 *
 * @param {string} fn — nombre de la función.
 * @param {Array}  [params] — parámetros posicionales.
 * @param {number} [timeoutMs]
 * @returns {{ok:boolean, resultado?:any, error?:string, ms:number}}
 */
export function sonda(fn, params = [], timeoutMs = 420000) {
  const t0 = Date.now()
  const motivo = porQueNoHaySondas()
  if (motivo) return { ok: false, error: motivo, ms: 0 }
  try {
    const salida = execFileSync(
      'node',
      [join(KMS_REPO, 'scripts', 'gas-run-via-api.mjs'), fn, JSON.stringify(params)],
      {
        cwd: KMS_REPO,
        encoding: 'utf8',
        timeout: timeoutMs,
        maxBuffer: 32 * 1024 * 1024,
        env: { ...process.env, NODE_USE_ENV_PROXY: '1' },
        stdio: ['ignore', 'pipe', 'pipe'],
      },
    )
    // El script imprime su traza por stdout y termina con `__RESULT__:<json>`.
    const linea = String(salida).split('\n').find(l => l.startsWith('__RESULT__:'))
    if (!linea) {
      return { ok: false, ms: Date.now() - t0, error: `la sonda ${fn} no devolvió resultado. Salida: ${String(salida).replace(/\s+/g, ' ').trim().slice(0, 300)}` }
    }
    const crudo = linea.slice('__RESULT__:'.length)
    let resultado
    try { resultado = JSON.parse(crudo) } catch { resultado = crudo }
    return { ok: true, resultado, ms: Date.now() - t0 }
  } catch (e) {
    // stderr del proceso hijo lleva el motivo real (función inexistente, token caducado…).
    const detalle = [e && e.stderr, e && e.stdout, e && e.message]
      .filter(Boolean).map(String).join(' | ').replace(/\s+/g, ' ').trim()
    return { ok: false, ms: Date.now() - t0, error: `la sonda ${fn} no se pudo ejecutar: ${detalle.slice(0, 400)}` }
  }
}

/**
 * Aplica el resultado de una sonda a un camino de la batería.
 *
 * Las tres salidas posibles, y ninguna se confunde con otra:
 *   · la sonda no se pudo ejecutar        → FALLO (cobertura perdida, no "no aplica")
 *   · la sonda dice ROJO                  → FALLO con el mensaje literal de la sonda
 *   · la sonda declara afirmaciones sin cubrir → NO CUBIERTA con su motivo (nunca verde)
 *
 * @param {object} camino — instancia de `Camino` de run-wizard.mjs
 * @param {string} etiqueta
 * @param {{ok:boolean, resultado?:any, error?:string}} r
 * @param {string} conducidoPor — 'navegador' | 'pasarela'; se imprime junto al resultado.
 */
export function aplicarSonda(camino, etiqueta, r, conducidoPor = 'navegador') {
  if (!r.ok) {
    camino.fallos.push(`${etiqueta} — la lectura de vuelta NO se pudo hacer: ${r.error}`)
    return false
  }
  const s = r.resultado || {}
  const cabecera = `${etiqueta} [conducido por: ${conducidoPor}]`
  if (s.veredicto === 'VERDE') {
    camino.notas.push(`✓ ${cabecera} — la base de datos confirma el paso (${r.ms} ms)`)
  } else {
    for (const f of (s.fallos || [`veredicto ${s.veredicto} sin detalle`])) {
      camino.fallos.push(`${cabecera} — ${f}`)
    }
  }
  for (const nc of (s.no_cubiertas || [])) {
    camino.noCubierta(`${etiqueta}·${nc.afirmacion}`, nc.motivo)
  }
  // Los datos medidos se imprimen: un rojo sin cifras obliga a repetir la corrida para
  // diagnosticar, y repetir es justo lo que la casa prohíbe.
  const datos = s.datos || {}
  const resumen = Object.keys(datos).slice(0, 40).map(k => `${k}=${datos[k]}`).join('  ')
  if (resumen) camino.notas.push(`    · ${resumen}`)
  return s.veredicto === 'VERDE'
}
