#!/usr/bin/env node
/**
 * EL PASO 11 ENSEÑA LA FIRMA DEL HIJO ELEGIDO — control que EJECUTA el criterio, no lee sus líneas.
 * ══════════════════════════════════════════════════════════════════════════════════════════════
 *
 * `node scripts/servidor/el-paso-11-ensena-la-firma-del-hijo-elegido.mjs [fuente.js]`
 * Sin red, sin navegador, sin `npm ci`. Última línea: `VEREDICTO: VERDE — N afirmaciones` / `ROJO — <motivo>`.
 *
 * QUÉ PROTEGE, en una frase: **que con dos hermanos admitidos el paso 11 (la firma) enseñe el
 * estado de la sesión del hijo ELEGIDO en el selector, y no el del primero** — ni sembrado desde
 * la memoria del contexto ni leído sin selección.
 *
 * POR QUÉ EXISTE (`2026-11-15-el-segundo-hermano-no-puede-firmar`, drenaje `:08` v1017). El paso
 * 11 guarda lo último que leyó (`signingSession`, del CONTEXTO, que sobrevive al remontaje) y una
 * sesión de firma es de UN hijo ⇒ al elegir al segundo hermano se sembraba con el estado del
 * primero —«firma completada» si ése ya había firmado— y la lectura iba SIN selección, así que el
 * servidor contestaba con la sesión primaria. Mismo molde que `CLI 468` cerró en el paso 10.
 *
 * CÓMO MIDE. Importa el módulo REAL `frontend/src/lib/sesionDeFirma.js` (o el que se le pase por
 * argumento) y ejecuta `sesionDelHijo` / `fundirSesionDeFirma`. Que el paso 11 y el contexto los
 * PIDAN se lee por líneas (dicho: lector de líneas).
 *
 * ⛔ **Y SE HA VISTO FALLAR**: al final se rompe el fuente a propósito y se exige que el control
 * lo NOMBRE; un renombrado sale «MEDICIÓN CIEGA», jamás verde.
 */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const REAL = path.resolve(AQUI, '..', '..', 'frontend', 'src', 'lib', 'sesionDeFirma.js');
const FUENTE = process.argv[2] ? path.resolve(process.argv[2]) : REAL;
const CONTEXTO = path.resolve(AQUI, '..', '..', 'frontend', 'src', 'context', 'WizardContext.jsx');
const PASO11 = path.resolve(AQUI, '..', '..', 'frontend', 'src', 'pages', 'steps', 'Step11Sign.jsx');

let total = 0;
const fallos = [];
function afirmar(nombre, condicion, porque) {
  total++;
  if (!condicion) fallos.push(`${nombre}${porque ? ' — ' + porque : ''}`);
}

const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';

async function medir(fuente) {
  const mod = await import(pathToFileURL(fuente).href + '?t=' + Date.now() + Math.random());
  const { sesionDelHijo, fundirSesionDeFirma } = mod;
  if (typeof sesionDelHijo !== 'function' || typeof fundirSesionDeFirma !== 'function') {
    throw new Error('MEDICIÓN CIEGA: el módulo no exporta sesionDelHijo / fundirSesionDeFirma');
  }
  const firmadaA = { state: 'COMPLETED', signerUrls: ['x'] };
  const draft = { state: 'DRAFT', signerUrls: [] };

  // sesionDelHijo
  afirmar('sin selección a los dos lados ⇒ siembra (byte a byte lo de hoy)', sesionDelHijo(draft, null, null) === draft);
  afirmar('el memo es del hijo en pantalla ⇒ siembra', sesionDelHijo(firmadaA, A, A) === firmadaA);
  afirmar('el memo es del OTRO hermano ⇒ NO siembra (el defecto)', sesionDelHijo(firmadaA, A, B) === null);
  afirmar('memo sin dueño y hay hijo elegido ⇒ NO siembra', sesionDelHijo(firmadaA, null, B) === null);
  afirmar('sin memo ⇒ null', sesionDelHijo(null, A, A) === null);

  // fundirSesionDeFirma
  const vacio = { sesion: null, de: null };
  let r = fundirSesionDeFirma(vacio, draft, A);
  afirmar('la primera lectura se guarda con su dueño', r.sesion === draft && r.de === A);
  r = fundirSesionDeFirma({ sesion: firmadaA, de: A }, draft, B);
  afirmar('otro hijo NO hereda el estado iniciado del anterior', r.sesion === draft && r.de === B && r.sesion.state === 'DRAFT');
  r = fundirSesionDeFirma({ sesion: firmadaA, de: A }, draft, A);
  afirmar('mismo hijo: la monotonía sigue (iniciada no vuelve a DRAFT)', r.de === A && r.sesion.state === 'COMPLETED');
  r = fundirSesionDeFirma({ sesion: firmadaA, de: null }, draft, null);
  afirmar('sin selección: la monotonía de siempre', r.de === null && r.sesion.state === 'COMPLETED');
  r = fundirSesionDeFirma({ sesion: firmadaA, de: A }, null, B);
  afirmar('una lectura vacía no pisa el memo', r.sesion === firmadaA && r.de === A);
  r = fundirSesionDeFirma(undefined, draft, undefined);
  afirmar('sin memo previo ni dueño no revienta', r.sesion === draft && r.de === null);
}

async function enRojo(nombre, mutar) {
  const src = fs.readFileSync(REAL, 'utf8');
  const roto = mutar(src);
  if (roto === src) { fallos.push(`MEDICIÓN CIEGA: la rotura «${nombre}» no cambió el fuente (¿se renombró algo?)`); return; }
  const tmp = path.join(os.tmpdir(), `sesion-de-firma-rota-${process.pid}-${Math.random().toString(36).slice(2)}.mjs`);
  fs.writeFileSync(tmp, roto);
  const antes = fallos.length, antesTotal = total;
  try { await medir(tmp); } catch (e) { fallos.push(`(rotura «${nombre}») ${e.message}`); }
  finally { fs.unlinkSync(tmp); }
  const cazada = fallos.length > antes;
  fallos.length = antes;
  total = antesTotal + 1;
  if (!cazada) fallos.push(`la rotura «${nombre}» NO puso el control en rojo`);
}

let veredicto;
try {
  await medir(FUENTE);

  // Los dos consumidores lo PIDEN (lector de líneas) y no vuelven a decidir a mano.
  const ctx = fs.readFileSync(CONTEXTO, 'utf8');
  afirmar('WizardContext pide fundirSesionDeFirma a lib/sesionDeFirma.js',
    /import\s*\{\s*fundirSesionDeFirma\s*\}\s*from\s*'\.\.\/lib\/sesionDeFirma'/.test(ctx)
      && /fundirSesionDeFirma\(prev,\s*next,\s*enrollmentId\)/.test(ctx),
    'el memo del paso 11 ya no se funde por el criterio único');
  afirmar('WizardContext expone de qué hijo es el memo', /signingSession,\s*signingSessionDe,\s*setSigningSession/.test(ctx));
  const p11 = fs.readFileSync(PASO11, 'utf8');
  afirmar('el paso 11 se siembra solo con el memo de SU hijo',
    /const signingSession = sesionDelHijo\(memoDeFirma,\s*signingSessionDe,\s*selectedEnrollmentId\)/.test(p11));
  afirmar('el paso 11 lee CON el hijo elegido',
    /initiateSigningRead\(\{\s*resumeToken,\s*signingToken,\s*selectedEnrollmentId\s*\}\)/.test(p11));
  afirmar('el paso 11 guarda la lectura con su dueño',
    /setSigningSession\(res,\s*selectedEnrollmentId \|\| null\)/.test(p11));

  if (!process.argv[2]) {
    await enRojo('el memo se siembra para cualquier hijo (el defecto)', s => s.replace("return (memoDe || null) === (hijo || null) ? memo : null;", "return memo;"));
    await enRojo('otro hijo hereda el estado iniciado', s => s.replace("if ((p.de || null) !== de) return { sesion: next, de }; // otro hijo: nada que heredar", ""));
    await enRojo('se pierde la monotonía dentro de un hijo', s => s.replace("return { sesion: { ...next, state: p.sesion.state }, de };", "return { sesion: next, de };"));
  }
} catch (e) {
  fallos.push('el control no pudo medir: ' + e.message);
} finally {
  veredicto = fallos.length
    ? `VEREDICTO: ROJO — ${fallos.join(' | ')}`
    : `VEREDICTO: VERDE — ${total} afirmaciones: el paso 11 enseña y lee la firma del hijo elegido, sin heredar la del otro hermano y sin perder la monotonía de la sesión`;
  console.log(veredicto);
  process.exitCode = fallos.length ? 1 : 0;
}
