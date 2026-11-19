#!/usr/bin/env node
/**
 * UN SOLO FORMATEADOR DE FECHA Y DE IMPORTE EN EL ASISTENTE — control que EJECUTA las piezas.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `node scripts/servidor/un-solo-formateador-de-fecha-y-de-importe.mjs [dinero.js]`
 * Sin red, sin navegador, sin `npm ci`. Última línea: `VEREDICTO: VERDE — N afirmaciones` / `ROJO — <motivo>`.
 *
 * QUÉ PROTEGE, en una frase: **que lo que lee el tutor —una fecha o un importe— lo escriba UNA
 * pieza del asistente, y no una copia por pantalla** (drenaje `:08` v1177, ficha
 * `2026-10-11-el-formato-del-centro-no-llega-al-servidor`, la mitad del asistente).
 *
 * POR QUÉ EXISTE. (1) El paso 1 llevaba su propio formateador de fechas (`humanDate`,
 * `toLocaleDateString`) que escribía la fecha EN NÚMEROS con el orden del idioma ⇒ en inglés el
 * aviso «la fecha tiene que estar entre 9/1/2026 y 6/30/2027», que se lee como 9 de enero. El
 * ÚNICO formateador declarado es `utils/fechas.js` (`fechaLegible`) y ya lo pedía el paso 7.
 * (2) Los pasos 7 y 8 llevaban CADA UNO su copia de `money()`, byte a byte iguales: hoy la pieza
 * es `utils/dinero.js` (`importeLegible`) y las dos pantallas la PIDEN.
 *
 * CÓMO MIDE. Importa los módulos REALES y los ejecuta; el importe se compara contra el ORO —el
 * cuerpo de las dos copias retiradas, escrito aquí VERBATIM— en una rejilla de importes y
 * monedas: «sin cambiar un byte» se mide, no se promete. Lo que dicen las pantallas se lee por
 * LÍNEAS (que piden la pieza y no vuelve una copia).
 *
 * ⛔ **Y SE HA VISTO FALLAR**: al final se rompe `dinero.js` a propósito (tres roturas) y se exige
 * que el control las NOMBRE; un renombrado sale «MEDICIÓN CIEGA», jamás verde.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const SRC = path.resolve(AQUI, '..', '..', 'frontend', 'src');
const REAL = path.join(SRC, 'utils', 'dinero.js');
const FECHAS = path.join(SRC, 'utils', 'fechas.js');
const FUENTE = process.argv[2] ? path.resolve(process.argv[2]) : REAL;

let total = 0;
const fallos = [];
function afirmar(nombre, condicion, porque) {
  total++;
  if (!condicion) fallos.push(`${nombre}${porque ? ' — ' + porque : ''}`);
}

// EL ORO: el cuerpo de `money` tal como vivía en Step7Review.jsx y Step8Billing.jsx (las dos iguales).
const oro = (cents, currency) => {
  const n = Number(cents || 0) / 100;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'EUR' }).format(n);
  } catch (e) { return n.toFixed(2) + ' ' + (currency || 'EUR'); }
};

async function medirImporte(fuente) {
  const mod = await import(pathToFileURL(fuente).href + '?t=' + Date.now() + Math.random());
  const { importeLegible } = mod;
  if (typeof importeLegible !== 'function') throw new Error('MEDICIÓN CIEGA: el módulo no exporta importeLegible');
  const importes = [0, 1, 99, 100, 12345, 123456789, -5000, '250000', null, undefined, ''];
  const monedas = ['EUR', 'GBP', 'USD', undefined, null, '', 'XXXX'];
  let distintas = 0, primera = '';
  for (const c of importes) for (const m of monedas) {
    const a = importeLegible(c, m), b = oro(c, m);
    if (a !== b) { distintas++; if (!primera) primera = `${String(c)}/${String(m)}: «${a}» ≠ «${b}»`; }
  }
  afirmar(`importeLegible ≡ las dos copias retiradas en ${importes.length * monedas.length} casos`, distintas === 0,
    `${distintas} distintas, p. ej. ${primera}`);
  afirmar('una moneda inválida no revienta (cae al número con su código)', importeLegible(150, 'XXXX') === oro(150, 'XXXX'));
}

let veredicto;
try {
  await medirImporte(FUENTE);

  // La fecha: la pieza ÚNICA escribe el mes con PALABRAS, sin el orden numérico del idioma.
  const { fechaLegible } = await import(pathToFileURL(FECHAS).href);
  afirmar('fechas.js exporta fechaLegible', typeof fechaLegible === 'function', 'MEDICIÓN CIEGA');
  const en = fechaLegible('2026-09-01', 'en'), es = fechaLegible('2026-09-01', 'es');
  afirmar('en inglés el 1 de septiembre no sale «9/1/2026»', /September/.test(en) && !/\d+\/\d+\/\d+/.test(en), `salió «${en}»`);
  afirmar('en español sale «1 de septiembre de 2026»', /septiembre/.test(es) && /\b1\b/.test(es), `salió «${es}»`);
  afirmar('una fecha que no se entiende se enseña tal cual', fechaLegible('no-es-fecha', 'es') === 'no-es-fecha');

  // Las pantallas PIDEN las piezas (lector de líneas).
  const leer = (f) => fs.readFileSync(path.join(SRC, 'pages', 'steps', f), 'utf8');
  const s1 = leer('Step1Email.jsx'), s7 = leer('Step7Review.jsx'), s8 = leer('Step8Billing.jsx');
  afirmar('el paso 1 pide fechaLegible', /import \{ fechaLegible \} from '\.\.\/\.\.\/utils\/fechas'/.test(s1) && /fechaLegible\(iso, lang\)/.test(s1));
  afirmar('el paso 1 no vuelve a formatear la fecha a mano', !/toLocaleDateString|Intl\.DateTimeFormat/.test(s1));
  for (const [nombre, s] of [['paso 7', s7], ['paso 8', s8]]) {
    afirmar(`el ${nombre} pide importeLegible`, /import \{ importeLegible \} from '\.\.\/\.\.\/utils\/dinero'/.test(s) && /const money = importeLegible;/.test(s));
    afirmar(`el ${nombre} no vuelve a formatear un importe a mano`, !/Intl\.NumberFormat|toFixed\(/.test(s));
  }

  if (!process.argv[2]) {
    const src = fs.readFileSync(REAL, 'utf8');
    async function enRojo(nombre, mutar) {
      const roto = mutar(src);
      if (roto === src) { fallos.push(`MEDICIÓN CIEGA: la rotura «${nombre}» no cambió el fuente (¿se renombró algo?)`); return; }
      const tmp = path.join(os.tmpdir(), `dinero-roto-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`);
      fs.writeFileSync(tmp, roto);
      const antes = fallos.length, antesTotal = total;
      try { await medirImporte(tmp); } catch (e) { fallos.push(`(rotura «${nombre}») ${e.message}`); }
      finally { fs.unlinkSync(tmp); }
      const cazada = fallos.length > antes;
      fallos.length = antes;
      total = antesTotal + 1;
      if (!cazada) fallos.push(`la rotura «${nombre}» NO puso el control en rojo`);
    }
    await enRojo('el respaldo de moneda cambia', s => s.replace("currency: currency || 'EUR' }", "currency: currency || 'USD' }"));
    await enRojo('se deja de dividir entre 100', s => s.replace('Number(cents || 0) / 100', 'Number(cents || 0)'));
    await enRojo('se renombra la pieza', s => s.replace('export function importeLegible', 'export function importe'));
  }
} catch (e) {
  fallos.push('el control no pudo medir: ' + e.message);
} finally {
  veredicto = fallos.length
    ? `VEREDICTO: ROJO — ${fallos.join(' | ')}`
    : `VEREDICTO: VERDE — ${total} afirmaciones: una sola pieza escribe la fecha (fechaLegible) y otra el importe (importeLegible) de lo que lee el tutor, y el importe no cambia un byte`;
  console.log(veredicto);
  process.exitCode = fallos.length ? 1 : 0;
}
