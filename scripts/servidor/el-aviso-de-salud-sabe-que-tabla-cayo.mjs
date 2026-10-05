#!/usr/bin/env node
/**
 * EL AVISO DE SALUD SABE QUÉ TABLA CAYÓ — control que EJECUTA el criterio, no lee sus líneas.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `node scripts/servidor/el-aviso-de-salud-sabe-que-tabla-cayo.mjs [fuente.js]`
 * Sin red, sin navegador, sin `npm ci`. Última línea: `VEREDICTO: VERDE — N afirmaciones` / `ROJO — <motivo>`.
 *
 * QUÉ PROTEGE, en una frase: **que el paso de Salud solo avise de «no se pudo cargar» cuando
 * lo que cayó es de SALUD o de apoyo educativo (o cuando el lote entero no se leyó)** — y que
 * ante la duda siga avisando.
 *
 * POR QUÉ EXISTE (`2026-09-16-la-salud-no-se-recupera`). El KMS apunta en `degraded_sections`
 * el nombre grueso `person_subreads` Y, desde el 2026-09-27, `person_subreads:<tabla>` por cada
 * tabla caída. El asistente solo miraba el grueso ⇒ si se caía la nacionalidad, el paso de Salud
 * avisaba de lo que sí había cargado, y bloqueaba el guardado de categorías vacías sin motivo.
 *
 * CÓMO MIDE. Importa el módulo REAL `frontend/src/lib/cargaDegradada.js` (o el que se le pase
 * por argumento, que es como se ve este control en ROJO) y llama a `laSaludNoCargo` de verdad.
 *
 * ⛔ **Y SE HA VISTO FALLAR**: al final se rompe el fuente a propósito (tres roturas) y se exige
 * que el control las NOMBRE; un renombrado sale «MEDICIÓN CIEGA», jamás verde.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const REAL = path.resolve(AQUI, '..', '..', 'frontend', 'src', 'lib', 'cargaDegradada.js');
const FUENTE = process.argv[2] ? path.resolve(process.argv[2]) : REAL;
const CONTEXTO = path.resolve(AQUI, '..', '..', 'frontend', 'src', 'context', 'WizardContext.jsx');

let total = 0;
const fallos = [];
function afirmar(nombre, condicion, porque) {
  total++;
  if (!condicion) fallos.push(`${nombre}${porque ? ' — ' + porque : ''}`);
}

async function medir(fuente) {
  const mod = await import(pathToFileURL(fuente).href + '?t=' + Date.now() + Math.random());
  const { laSaludNoCargo, tablasQueNoCargaron } = mod;
  if (typeof laSaludNoCargo !== 'function' || typeof tablasQueNoCargaron !== 'function') {
    throw new Error('MEDICIÓN CIEGA: el módulo no exporta laSaludNoCargo / tablasQueNoCargaron');
  }
  const S = 'person_subreads';
  afirmar('nada degradó ⇒ no avisa', laSaludNoCargo([]) === false);
  afirmar('el campo falta ⇒ no avisa (y no revienta)', laSaludNoCargo(undefined) === false && laSaludNoCargo(null) === false);
  afirmar('otra sección degradada ⇒ no avisa de salud', laSaludNoCargo(['sessions']) === false);
  afirmar('solo el nombre grueso (el lote entero no se leyó) ⇒ avisa', laSaludNoCargo([S]) === true);
  afirmar('cayó una tabla de SALUD ⇒ avisa', laSaludNoCargo([S, S + ':enrPersonFoodAllergies']) === true);
  afirmar('cayó el APOYO educativo ⇒ avisa', laSaludNoCargo([S, S + ':enrPersonNeaeSupport']) === true);
  afirmar('cayó SOLO la nacionalidad ⇒ NO avisa de salud', laSaludNoCargo([S, S + ':enrPersonNationalities']) === false);
  afirmar('cayeron SOLO tablas que no son de salud ⇒ NO avisa',
    laSaludNoCargo([S, S + ':enrPersonIDs', S + ':enrPersonAddresses', S + ':enrPreviousSchools']) === false);
  afirmar('cayó una que no es de salud Y una de salud ⇒ avisa',
    laSaludNoCargo([S, S + ':enrPersonLanguages', S + ':enrPersonMedicalConditions']) === true);
  afirmar('un nombre fino que no reconoce ⇒ avisa (falla hacia avisar)', laSaludNoCargo([S, S + ':tablaNueva']) === true);
  afirmar('el nombre fino sin el grueso no basta (el KMS siempre apunta los dos)', laSaludNoCargo([S + ':enrPersonFoodAllergies']) === false);
  afirmar('los nombres finos se leen sin el prefijo',
    JSON.stringify(tablasQueNoCargaron([S, S + ':enrPersonIDs', 'sessions'])) === '["enrPersonIDs"]');
  afirmar('un valor que no es texto no revienta', laSaludNoCargo([S, 5, null]) === true);
}

async function enRojo(nombre, mutar) {
  // Rompe el fuente a propósito y exige que ALGUNA afirmación lo note.
  const src = fs.readFileSync(REAL, 'utf8');
  const roto = mutar(src);
  if (roto === src) { fallos.push(`MEDICIÓN CIEGA: la rotura «${nombre}» no cambió el fuente (¿se renombró algo?)`); return; }
  const tmp = path.join(os.tmpdir(), `carga-degradada-rota-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(tmp, roto);
  const antes = fallos.length, antesTotal = total;
  try { await medir(tmp); } catch (e) { fallos.push(`(rotura «${nombre}») ${e.message}`); }
  finally { fs.unlinkSync(tmp); }
  const cazada = fallos.length > antes;
  fallos.length = antes;               // las afirmaciones de la rotura NO cuentan como fallos reales
  total = antesTotal + 1;              // pero la comprobación de que se vio rojo SÍ es una afirmación
  if (!cazada) fallos.push(`la rotura «${nombre}» NO puso el control en rojo`);
}

let veredicto;
try {
  await medir(FUENTE);

  // El único consumidor lo usa (un criterio, un sitio) y no ha vuelto a comparar a mano.
  const ctx = fs.readFileSync(CONTEXTO, 'utf8');
  afirmar('WizardContext pide el criterio a lib/cargaDegradada.js',
    /import\s*\{\s*laSaludNoCargo\s*\}\s*from\s*'\.\.\/lib\/cargaDegradada'/.test(ctx) && /healthLoadFailed:\s*laSaludNoCargo\(data\.degraded_sections\)/.test(ctx),
    'healthLoadFailed ya no sale de laSaludNoCargo (MEDICIÓN: lector de líneas)');
  afirmar('WizardContext no vuelve a comparar contra el nombre grueso a mano',
    !/degraded_sections\.includes\('person_subreads'\)/.test(ctx));

  if (!process.argv[2]) {
    await enRojo('el nombre grueso solo ya no avisa', s => s.replace("if (!finas.length) return true;", "if (!finas.length) return false;"));
    await enRojo('cualquier tabla caída avisa de salud (el defecto de antes)', s => s.replace("return finas.some(t => !TABLAS_QUE_NO_SON_DE_SALUD.includes(t));", "return true;"));
    await enRojo('lo que no reconoce deja de avisar', s => s.replace("return finas.some(t => !TABLAS_QUE_NO_SON_DE_SALUD.includes(t));", "return finas.some(t => TABLAS_DE_SALUD_Y_NEAE.includes(t));"));
  }
} catch (e) {
  fallos.push('el control no pudo medir: ' + e.message);
} finally {
  veredicto = fallos.length
    ? `VEREDICTO: ROJO — ${fallos.join(' | ')}`
    : `VEREDICTO: VERDE — ${total} afirmaciones: el aviso de salud salta con salud/NEAE caída o el lote entero, y no con nacionalidad, documentos, idiomas, direcciones ni colegios previos`;
  console.log(veredicto);
  process.exitCode = fallos.length ? 1 : 0;
}
