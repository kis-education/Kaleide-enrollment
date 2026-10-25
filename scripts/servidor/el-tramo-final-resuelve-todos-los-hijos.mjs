#!/usr/bin/env node
/**
 * ⛔ **CLI 403 (Diego, 2026-10-25): «Sería la A, pero es necesario que no permita pasar a siguientes
 * pasos hasta que no se resuelvan todos los hijos de cada pantalla.»**
 *
 * QUÉ PROTEGE, en una frase: que el estado 8/9/10 POR HIJO llegue al selector del tramo 8-11 y que la
 * pantalla se alimente del hijo ELEGIDO (no del primer `.find()`) — la mitad de BACKEND de la opción A.
 *
 * Las afirmaciones, todas sobre `backend/Code.js` REAL:
 *   (A) `_pasosEnPorAlumno_` adjunta los `pasos` por hijo por `enrollment_id`, y con el mapa VACÍO
 *       deja `por_alumno` BYTE-IDÉNTICO (ni añade la clave) — degrada al modo viejo sin candado.
 *   (B) `_elegirSesionDeFirma_` elige la sesión del hijo SELECCIONADO; sin selección, la primera no
 *       terminal; con una selección que no casa (KAL-4), degrada a la primera — nunca atasca.
 *   (C) `resolveGuardianSigningContext_` con `selectedEnrollmentId` devuelve el `signing_token` del
 *       hijo elegido, no el del primero.
 *   (D) `_datosDeFirmaDelExpediente_(token, guardian)` manda `guardian_person_id` al KMS y devuelve el
 *       `pasosPorExpediente` que el KMS contesta; sin tutor, no lo manda y el mapa va vacío.
 *
 * ⛔ **NO ES UN DETECTOR POR LÍNEAS: EJECUTA EL CÓDIGO REAL** en un `vm` con dobles en memoria (ni
 * red, ni navegador, ni `npm ci`, ni un dato real; dominio reservado `.invalid`, RFC 2606).
 * ⛔ **Y SE ROMPE A PROPÓSITO.** Cada afirmación se re-corre sobre una copia MUTILADA del fuente y
 * tiene que salir ROJA; un renombrado tiene que salir «MEDICIÓN CIEGA».
 *
 * ⚠️ **LO QUE NO AFIRMA:** la otra mitad (la del KMS, `enr_pasosDeFirmaPorExpediente_` y el hydrate)
 * vive en `kis-app` y tiene su propio arnés (`kis-app scripts/servidor/`); lo que PINTA el navegador
 * (el selector, el candado del avance) lo mide el muro del asistente (`npm run e2e:wizard`); no habla
 * con el KMS ni con Apps Script.
 *
 * Veredicto: ÚLTIMA línea, SIEMPRE impresa, incluso ante error fatal.
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import vm from 'node:vm';

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..');

const GID   = '11111111-1111-4111-8111-111111111111';
const TOK   = '22222222-2222-4222-8222-222222222222';
const GUARD = '33333333-3333-4333-8333-333333333333';
const H1    = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const H2    = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const SES1  = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';  // session_id ⇒ UUID (lo exige assertValidUuid_)
const SES2  = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';

class Ciega extends Error {}
const fallos = []; let verdes = 0; let callado = false;
const afirmar = (ok, t) => { if (!callado) console.log(`  ${ok ? '✓' : '✗'} ${t}`); if (ok) verdes++; else fallos.push(t); };

function cargar(retoques) {
  let fuente = readFileSync(join(RAIZ, 'backend/Code.js'), 'utf8');
  (retoques || []).forEach(([de, a]) => {
    const n = fuente.split(de).length - 1;
    if (n === 0) throw new Ciega(`la rotura no encuentra su texto: ${de.slice(0, 60)}`);
    if (n > 1)  throw new Ciega(`ANCLA AMBIGUA (${n}×): ${de.slice(0, 60)}`);
    fuente = fuente.replace(de, a);
  });
  const cuerposAlKms = [];
  const ctx = {
    console: { log() {}, error() {} }, Logger: { log() {} },
    JSON, Object, Array, String, Number, Date, Math, RegExp, Error, isNaN, parseInt,
    CacheService: { getScriptCache: () => ({ get: () => null, put() {}, putAll() {}, getAll: () => ({}), remove() {} }) },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
    UrlFetchApp: { fetch() { throw new Error('el arnés no sale a la red'); }, fetchAll() { throw new Error('el arnés no sale a la red'); } },
    ScriptApp: { getOAuthToken: () => 'x', getService: () => ({ getUrl: () => 'https://x/exec' }), getProjectTriggers: () => [] },
    Utilities: { getUuid: () => '44444444-4444-4444-8444-444444444444', sleep() {}, formatDate: () => '2026-01-01',
      newBlob: (s) => ({ getBytes: () => Array.from(Buffer.from(String(s))) }),
      computeDigest: (_a, s) => Array.from(Buffer.from(String(s).padEnd(32, '.')).subarray(0, 32)),
      DigestAlgorithm: { SHA_256: 1 }, Charset: { UTF_8: 1 } },
    Session: { getActiveUser: () => ({ getEmail: () => '' }), getScriptTimeZone: () => 'UTC' },
  };
  vm.createContext(ctx);
  vm.runInContext(fuente, ctx, { filename: 'backend/Code.js' });
  // El KMS doblado: apunta lo que se le manda y contesta las filas de firma + los pasos por hijo.
  ctx.kmsProxy_ = (accion, cuerpo) => {
    cuerposAlKms.push({ accion, cuerpo });
    if (accion === 'enr.datosDeFirma') {
      // El KMS real solo calcula los pasos por hijo cuando se le dice de QUÉ tutor (guardian_person_id).
      const pasos = (cuerpo && cuerpo.guardian_person_id) ? {
        [H1]: { billing_confirmed: true, gdpr_completed: true, review_completed: true, signed: true, nada_que_hacer: true },
        [H2]: { billing_confirmed: false, gdpr_completed: false, review_completed: false, signed: false },
      } : {};
      return {
        sessions: [{ session_id: SES1, entity_id: H1, deleted_at: null },
                   { session_id: SES2, entity_id: H2, deleted_at: null }],
        signers_by_session: {
          [SES1]: [{ signer_person_id: GUARD, signing_token: 'tok-h1', deleted_at: null }],
          [SES2]: [{ signer_person_id: GUARD, signing_token: 'tok-h2', deleted_at: null }],
        },
        pasos_por_expediente: pasos,
        admision_resuelta: true,
      };
    }
    return {};
  };
  return { ctx, cuerposAlKms };
}

const sesiones = () => [
  { session_id: SES1, entity_id: H1, deleted_at: null, current_state_code: 'DRAFT' },
  { session_id: SES2, entity_id: H2, deleted_at: null, current_state_code: 'DRAFT' },
];
const signers = () => ({
  [SES1]: [{ signer_id: 'sg-1', session_id: SES1, signer_person_id: GUARD, signing_token: 'tok-h1', deleted_at: null }],
  [SES2]: [{ signer_id: 'sg-2', session_id: SES2, signer_person_id: GUARD, signing_token: 'tok-h2', deleted_at: null }],
});

function correr(retoques) {
  const { ctx, cuerposAlKms } = cargar(retoques);

  // (A) `_pasosEnPorAlumno_`
  {
    const base = [{ enrollment_id: H1, state_code: 'AD' }, { enrollment_id: H2, state_code: 'AD' }];
    const mapa = { [H1]: { billing_confirmed: true }, [H2]: { billing_confirmed: false } };
    const conPasos = ctx._pasosEnPorAlumno_(base, mapa);
    afirmar(conPasos[0].pasos && conPasos[0].pasos.billing_confirmed === true
      && conPasos[1].pasos && conPasos[1].pasos.billing_confirmed === false,
      '(A) `_pasosEnPorAlumno_` adjunta los pasos por hijo, casados por enrollment_id');
    const vacio = ctx._pasosEnPorAlumno_(base, {});
    afirmar(JSON.stringify(vacio) === JSON.stringify(base) && !('pasos' in vacio[0]),
      '(A) con el mapa VACÍO, por_alumno queda BYTE-IDÉNTICO (ni añade la clave `pasos`)');
  }

  // (B) `_elegirSesionDeFirma_`
  {
    const elegido = ctx._elegirSesionDeFirma_(sesiones(), H2);
    afirmar(elegido && elegido.session_id === SES2, '(B) con selección, elige la sesión de ESE hijo');
    const primero = ctx._elegirSesionDeFirma_(sesiones(), null);
    afirmar(primero && primero.session_id === SES1, '(B) sin selección, la primera no terminal');
    const degrada = ctx._elegirSesionDeFirma_(sesiones(), '99999999-9999-4999-8999-999999999999');
    afirmar(degrada && degrada.session_id === SES1, '(B) KAL-4: una selección que no casa degrada a la primera (nunca atasca)');
    const conTerminal = ctx._elegirSesionDeFirma_(
      [{ session_id: SES1, entity_id: H1, deleted_at: null, current_state_code: 'COMPLETED' },
       { session_id: SES2, entity_id: H2, deleted_at: null, current_state_code: 'DRAFT' }], null);
    afirmar(conTerminal && conTerminal.session_id === SES2, '(B) una sesión terminal se salta');
  }

  // (C) `resolveGuardianSigningContext_` con el hijo seleccionado
  {
    const ctxH2 = ctx.resolveGuardianSigningContext_(GID, GUARD, sesiones(), signers(), H2);
    afirmar(ctxH2 && ctxH2.signing_token === 'tok-h2' && ctxH2.entity_id === H2,
      '(C) con el hijo elegido, el contexto lleva SU signing_token (no el del primero)');
    const ctxH1 = ctx.resolveGuardianSigningContext_(GID, GUARD, sesiones(), signers(), null);
    afirmar(ctxH1 && ctxH1.signing_token === 'tok-h1',
      '(C) sin selección, el contexto es el del primer hijo (comportamiento de siempre)');
  }

  // (D) `_datosDeFirmaDelExpediente_` manda el tutor y devuelve los pasos
  {
    cuerposAlKms.length = 0;
    const r = ctx._datosDeFirmaDelExpediente_(TOK, GUARD);
    const cuerpo = cuerposAlKms.find((x) => x.accion === 'enr.datosDeFirma');
    afirmar(cuerpo && cuerpo.cuerpo && cuerpo.cuerpo.guardian_person_id === GUARD,
      '(D) con tutor, se manda `guardian_person_id` al KMS');
    afirmar(r && r.pasosPorExpediente && r.pasosPorExpediente[H2]
      && r.pasosPorExpediente[H2].billing_confirmed === false,
      '(D) devuelve el `pasosPorExpediente` que contesta el KMS, keyed por hijo');
    // sin tutor: no se manda el discriminador, el mapa va vacío (clave ausente)
    cuerposAlKms.length = 0;
    const sinTutor = ctx._datosDeFirmaDelExpediente_('55555555-5555-4555-8555-555555555555', null);
    const cuerpo2 = cuerposAlKms.find((x) => x.accion === 'enr.datosDeFirma');
    afirmar(cuerpo2 && cuerpo2.cuerpo && !('guardian_person_id' in cuerpo2.cuerpo)
      && JSON.stringify(sinTutor.pasosPorExpediente) === '{}',
      '(D) sin tutor, NO se manda el discriminador y el mapa de pasos va VACÍO');
  }
}

function main() {
  try { correr([]); } catch (e) {
    if (e instanceof Ciega) { console.log(`MEDICIÓN CIEGA · ${e.message}`); console.log('VEREDICTO: ROJO — MEDICIÓN CIEGA'); process.exit(1); }
    console.log(`VEREDICTO: ROJO — el control reventó: ${e.stack}`); process.exit(1);
  }
  const roturas = [
    // (A) adjunta pasos SIEMPRE (también con el mapa vacío) ⇒ por_alumno deja de ser byte-idéntico
    ['adjunta pasos aunque no haya', [[
      'var pasos = mapa[String((a && a.enrollment_id) || \'\')] || null;\n    return pasos ? Object.assign({}, a, { pasos: pasos }) : a;',
      'return Object.assign({}, a, { pasos: mapa[String((a && a.enrollment_id) || \'\')] || {} });']], '(A)'],
    // (B) ignora la selección (siempre la primera) ⇒ no elige el hijo pedido
    ['ignora la selección', [[
      'if (sel) {\n    var elegida = sessions.find(function(s) { return viva(s) && String(s.entity_id || \'\') === sel; });\n    if (elegida) return elegida;\n  }',
      '']], '(B)'],
    // (D) no manda el tutor al KMS ⇒ el KMS no sabría de quién son los pasos
    ['no manda el tutor', [[
      'if (gid) cuerpo.guardian_person_id = gid;   // ★ CLI 403: de QUÉ tutor son los pasos por hijo',
      '']], '(D)'],
  ];
  let ok = 0;
  console.log('\n  ── roturas demostradas ──');
  for (const [n, retoques, esp] of roturas) {
    const antes = fallos.length, v = verdes;
    callado = true;
    let detectada = false, ciega = null;
    try { correr(retoques); } catch (e) { if (e instanceof Ciega) ciega = `rotura «${n}»: ${e.message}`; else detectada = true; }
    callado = false;
    detectada = detectada || fallos.slice(antes).some((t) => t.includes(esp));
    fallos.length = antes; verdes = v;
    if (ciega) { fallos.push(ciega); detectada = false; }
    console.log(`  ${detectada ? '✓' : '✗'} ROTURA ${n}`);
    if (detectada) ok++; else if (!ciega) fallos.push(`rotura no detectada: ${n}`);
  }
  // ⛔ MEDICIÓN CIEGA: si lo que medimos cambia de nombre, ROJO — nunca verde.
  let ciegas = 0;
  for (const [n, de, a] of [
    ['la pieza de pasos', 'function _pasosEnPorAlumno_(', 'function _otraPieza_('],
    ['la elección de sesión', 'function _elegirSesionDeFirma_(', 'function _otraEleccion_('],
  ]) {
    let ciego = false;
    try { correr([[de, a]]); } catch (e) { ciego = e instanceof Ciega || /is not a function/.test(e.message); }
    console.log(`  ${ciego ? '✓' : '✗'} ROTURA renombrar ${n} → ${ciego ? 'MEDICIÓN CIEGA' : 'NO se detectó'}`);
    if (ciego) ciegas++; else fallos.push(`renombrar ${n} no da MEDICIÓN CIEGA`);
  }
  if (fallos.length) { fallos.forEach((x) => console.log(`  ✗ ${x}`)); console.log(`VEREDICTO: ROJO — ${fallos.length} fallo(s)`); process.exit(1); }
  console.log(`VEREDICTO: VERDE — ${verdes} afirmaciones, ${ok} roturas demostradas y ${ciegas} guardas de MEDICIÓN CIEGA`);
}
main();
