#!/usr/bin/env node
/**
 * DL-E41 ★ ACOTACIÓN 2026-08-02 — las banderas de PANTALLA las decide ESTE cliente.
 *
 * Diego lo cerró así: *«el KMS no tiene por qué saber nada de la estructura o del
 * funcionamiento del Wizard… los estados de pantalla del wizard los gestiona el wizard»*.
 * `editable`, `signing_available` y `signing_ready` no son hechos del expediente: son
 * decisiones de presentación («¿puedo editar?», «¿enseño el puente a la firma?»).
 *
 * Hasta el 2026-08-03 se calculaban en DOS sitios —aquí y en el KMS— y **ya divergían**:
 * para un expediente admitido cuyo contexto de firma no resuelve, el KMS decía
 * `signing_available: true` (por estar en 'AD') y este cliente decía `false` (por no haber
 * contexto). Ese campo abre el avance 7→8.
 *
 * Este control afirma dos cosas y NO más:
 *   1. existe UN solo derivador (`derivarPantallaAdmision_`) y todos los cálculos pasan por él;
 *   2. no se COPIAN esas banderas de la respuesta del KMS (`admSrc.*` / `data.admission.*`).
 *
 * LÍMITE: es un detector por líneas. No demuestra que la derivación sea correcta — eso lo
 * demuestra la batería recorriendo el tramo de firma.
 *
 * Veredicto: ÚLTIMA línea, SIEMPRE, incluso ante error fatal.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..')
const BANDERAS = ['editable', 'signing_available', 'signing_ready']

export function comprobarPantalla(fuente) {
  const fallos = []
  const lineas = fuente.split('\n')
  const limpio = lineas.map((l) => (/^\s*(\/\/|\*|\/\*)/.test(l) ? '' : l))

  const nDeriv = (limpio.join('\n').match(/function derivarPantallaAdmision_/g) || []).length
  if (nDeriv !== 1) fallos.push(`se esperaba UN derivador \`derivarPantallaAdmision_\`, hay ${nDeriv}`)

  // El cuerpo del PROPIO derivador declara las tres banderas: es donde tienen que estar.
  const ini = limpio.findIndex((l) => /function derivarPantallaAdmision_/.test(l))
  const fin = ini >= 0 ? limpio.findIndex((l, k) => k > ini && /^\}/.test(l)) : -1

  limpio.forEach((l, i) => {
    if (ini >= 0 && i >= ini && i <= fin) return
    for (const b of BANDERAS) {
      // copiar la bandera desde la respuesta del KMS
      if (new RegExp(`(admSrc|data\\.admission|adm)\\s*\\.\\s*${b}\\b`).test(l)) {
        fallos.push(`${i + 1}: copia \`${b}\` de la respuesta del KMS — esa bandera la decide este cliente`)
      }
      // recalcularla a mano fuera del derivador
      if (new RegExp(`\\b${b}\\s*[:=]`).test(l) && /NOT_INITIATED|EDITABLE_STATE|!!\s*out\.signing_context/.test(l)
          && !/derivarPantallaAdmision_/.test(l)) {
        fallos.push(`${i + 1}: recalcula \`${b}\` fuera del derivador único`)
      }
    }
  })
  return fallos
}

let motivo = null
try {
  const fallos = comprobarPantalla(readFileSync(join(RAIZ, 'backend/Code.js'), 'utf8'))
  fallos.forEach((f) => console.log('  ✗ ' + f))
  if (fallos.length) motivo = `${fallos.length} infracción(es): ${fallos.join(' · ')}`
  else console.log('  ✓ las tres banderas de pantalla salen de un derivador único y no se copian del KMS')
} catch (e) {
  motivo = 'error fatal — ' + (e && e.message)
} finally {
  console.log(motivo ? `VEREDICTO: ROJO — ${motivo}` : 'VEREDICTO: VERDE')
  process.exitCode = motivo ? 1 : 0
}
