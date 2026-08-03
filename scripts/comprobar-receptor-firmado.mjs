#!/usr/bin/env node
/**
 * DL-S106 — comprueba que el receptor del aviso del KMS VERIFICA ANTES DE MIRAR.
 *
 * `notifyLiveStateChange_` es alcanzable desde internet SIN autenticación: está en el
 * `switch(action)` del `doPost` `ANYONE_ANONYMOUS`. Hasta el 2026-08-03 se «autenticaba»
 * comparando un secreto compartido que venía DENTRO DEL PROPIO CUERPO — o sea, quien viera
 * un mensaje podía repetirlo para siempre y fabricar mensajes nuevos.
 *
 * Este control vive AQUÍ y no en el KMS por la misma razón que
 * `comprobar-escrituras-directas.mjs`: un control que necesita el repositorio hermano se
 * declara INERTE en la integración continua del otro lado y no comprueba nada. El control se
 * ejecuta donde vive el código que vigila.
 *
 * LÍMITE DECLARADO: es un detector por líneas, no un analizador sintáctico. Afirma el ORDEN
 * de las comprobaciones y la ausencia del patrón viejo; no demuestra que el HMAC sea correcto
 * — eso lo demuestra `manual_testSignedWebhookReceiver` ejecutándose en GAS.
 *
 * Veredicto: ÚLTIMA línea, SIEMPRE impresa, incluso ante error fatal.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..')

export function comprobarReceptor(fuente) {
  const fallos = []
  const sinComentarios = fuente
    .split('\n')
    .map((l) => l.replace(/^\s*\/\/.*$/, '').replace(/^\s*\*.*$/, ''))
    .join('\n')

  // 1 — el verificador existe, y es UNO SOLO.
  const nVerif = (sinComentarios.match(/function verifySignedKmsNotice_/g) || []).length
  if (nVerif !== 1) fallos.push(`se esperaba UN verificador \`verifySignedKmsNotice_\`, hay ${nVerif}`)

  // 2 — el receptor lo INVOCA, y lo hace ANTES de leer el contenido.
  const cuerpo = /function notifyLiveStateChange_\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/.exec(sinComentarios)
  if (!cuerpo) {
    fallos.push('no se encontró `notifyLiveStateChange_` — el detector está ciego, verde aquí NO equivale a verificado')
  } else {
    const c = cuerpo[1]
    const iVerif = c.indexOf('verifySignedKmsNotice_')
    const iLee = c.indexOf('enrollment_group_id')
    if (iVerif < 0) fallos.push('`notifyLiveStateChange_` no invoca al verificador')
    else if (iLee >= 0 && iLee < iVerif) fallos.push('el receptor LEE el contenido antes de verificar la firma')
    // 3 — el patrón viejo no vuelve: comparar un secreto que viene en el cuerpo.
    if (/notify_secret/.test(c)) fallos.push('vuelve `notify_secret` — el secreto no puede viajar en el cuerpo')
  }

  // 4 — las tres comprobaciones, en orden, dentro del verificador.
  const vb = /function verifySignedKmsNotice_\s*\([^)]*\)\s*\{([\s\S]*?)\n\}/.exec(sinComentarios)
  if (vb) {
    const v = vb[1]
    const iFirma = v.indexOf('computeHmacSha256Signature')
    const iVentana = v.search(/KMS_NOTICE_WINDOW_MS_/)
    const iNonce = v.search(/cache\.get\(/)
    if (iFirma < 0) fallos.push('el verificador no recomputa el HMAC')
    if (iVentana < 0) fallos.push('el verificador no comprueba la ventana temporal')
    if (iNonce < 0) fallos.push('el verificador no comprueba la no-repetición')
    if (iFirma >= 0 && iVentana >= 0 && iFirma > iVentana) fallos.push('la ventana se comprueba antes que la firma')
    if (iVentana >= 0 && iNonce >= 0 && iVentana > iNonce) fallos.push('la no-repetición se comprueba antes que la ventana')
  } else if (nVerif === 1) {
    fallos.push('no se pudo leer el cuerpo del verificador')
  }
  return fallos
}

let motivo = null
try {
  const fuente = readFileSync(join(RAIZ, 'backend/Code.js'), 'utf8')
  const fallos = comprobarReceptor(fuente)
  fallos.forEach((f) => console.log('  ✗ ' + f))
  if (fallos.length) motivo = `${fallos.length} infracción(es): ${fallos.join(' · ')}`
  else console.log('  ✓ el receptor verifica firma → ventana → no-repetición ANTES de leer el contenido')
} catch (e) {
  motivo = 'error fatal — ' + (e && e.message)
} finally {
  console.log(motivo ? `VEREDICTO: ROJO — ${motivo}` : 'VEREDICTO: VERDE')
  process.exitCode = motivo ? 1 : 0
}
