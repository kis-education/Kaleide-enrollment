#!/usr/bin/env node
/**
 * ⛔ **CLI 467 (Diego, 2026-11-15: «esto hay que resolverlo»)** — con dos hermanos admitidos, el
 * segundo se quedaba sin poder firmar.
 *
 * QUÉ PROTEGE, en una frase: que **la copia rápida del pulso (`wz_admv2_…`) no sea CIEGA al hijo
 * elegido**, porque esa entrada guarda `signing_context`, que es de UN hijo — y servírsela a otro
 * hermano le enseña al tutor los permisos de uno y los registra a nombre del otro.
 *
 * Las afirmaciones, todas sobre `backend/Code.js` REAL:
 *   (A) `_hijoElegidoDelPayload_` — criterio ÚNICO de la selección: válida pasa, ausente es `null`,
 *       y una FORMA MALA (KAL-5 capa 1) se trata como AUSENTE, nunca como error.
 *   (B) `_sufijoCopiaDelPulso_` — SIN selección la clave es **byte a byte** la de hoy
 *       (`id + '_' + _wzN_(n, correo)`), que es lo que mantiene vivo el calentamiento del enlace;
 *       CON selección, dos hijos distintos NO comparten clave; una forma mala NO entra en la clave;
 *       y el buzón sigue dentro (②24, frontera de privacidad entre tutores).
 *   (C) `getAdmissionState_` de punta a punta, con una caché de verdad en memoria: un acierto de
 *       copia NUNCA devuelve el `signing_context` de otro hijo — el tutor que elige al segundo
 *       hermano recibe el `signing_token` del SEGUNDO, y el que no elige nada sigue recibiendo el
 *       del primero desde la copia (la entrada rápida que ya funcionaba no se pierde).
 *   (D) `_conElHijoElegido_` — el cuerpo que viaja al KMS en los actos 8/9/10 usa ESA MISMA
 *       validación: lo que la clave considera «sin selección», el KMS tampoco lo recibe.
 *
 * ⛔ **NO ES UN DETECTOR POR LÍNEAS: EJECUTA EL CÓDIGO REAL** en un `vm` con dobles en memoria (ni
 * red, ni navegador, ni `npm ci`, ni un dato real; dominio reservado `.invalid`, RFC 2606).
 * ⛔ **Y SE ROMPE A PROPÓSITO.** Cada afirmación se re-corre sobre una copia MUTILADA del fuente y
 * tiene que salir ROJA; un renombrado tiene que salir «MEDICIÓN CIEGA».
 *
 * ⚠️ **LO QUE NO AFIRMA:** la otra mitad del arreglo es de PANTALLA — que la marca de «he leído la
 * carta y el contrato» sea de UN hijo (`WizardContext`/`WizardPage`/`Step10Review`) y que el paso 9
 * tenga un solo criterio de «qué hijo» (`Step9Gdpr`) — y eso lo mide el muro del navegador
 * (`npm run e2e:wizard`, recorrido `los-dos-hermanos-firman`). Tampoco habla con el KMS ni con
 * Apps Script: no dice nada sobre si el KMS acepta la escritura.
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
const H1    = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';   // el PRIMER hermano
const H2    = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';   // el SEGUNDO, el que no podía firmar
const SES1  = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const SES2  = 'dddddddd-dddd-4ddd-8ddd-dddddddddddd';
const AL1   = 'eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee';
const AL2   = 'ffffffff-ffff-4fff-8fff-ffffffffffff';
const CORREO = 'tutor1@ejemplo.invalid';               // RFC 2606: dominio reservado

class Ciega extends Error {}
const fallos = []; let total = 0; let verdes = 0; let callado = false;
const afirmar = (ok, t) => {
  total++;
  if (!callado) console.log(`  ${ok ? '✓' : '✗'} ${t}`);
  if (ok) verdes++; else fallos.push(t);
};

/** Una ScriptCache DE VERDAD, en memoria: sin ella un «acierto» no se puede observar. */
function cacheEnMemoria() {
  const m = new Map();
  return {
    get: (k) => (m.has(k) ? m.get(k) : null),
    put: (k, v) => { m.set(k, String(v)); },
    putAll: (o) => { Object.keys(o || {}).forEach((k) => m.set(k, String(o[k]))); },
    getAll: (ks) => { const o = {}; (ks || []).forEach((k) => { if (m.has(k)) o[k] = m.get(k); }); return o; },
    remove: (k) => { m.delete(k); },
    _claves: () => [...m.keys()],
  };
}

function cargar(retoques) {
  let fuente = readFileSync(join(RAIZ, 'backend/Code.js'), 'utf8');
  (retoques || []).forEach(([de, a]) => {
    const n = fuente.split(de).length - 1;
    if (n === 0) throw new Ciega(`la rotura no encuentra su texto: ${de.slice(0, 70)}`);
    if (n > 1)  throw new Ciega(`ANCLA AMBIGUA (${n}×): ${de.slice(0, 70)}`);
    fuente = fuente.replace(de, a);
  });
  const cache = cacheEnMemoria();
  const cuerposAlKms = [];
  const ctx = {
    console: { log() {}, error() {} }, Logger: { log() {} },
    JSON, Object, Array, String, Number, Date, Math, RegExp, Error, isNaN, parseInt, Boolean,
    CacheService: { getScriptCache: () => cache },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty() {} }) },
    UrlFetchApp: { fetch() { throw new Error('el arnés no sale a la red'); }, fetchAll() { throw new Error('el arnés no sale a la red'); } },
    ScriptApp: { getOAuthToken: () => 'x', getService: () => ({ getUrl: () => 'https://x/exec' }), getProjectTriggers: () => [] },
    Utilities: { getUuid: () => '44444444-4444-4444-8444-444444444444', sleep() {}, formatDate: () => '2026-01-01',
      newBlob: (s) => ({ getBytes: () => Array.from(Buffer.from(String(s))) }),
      computeDigest: (_a, s) => Array.from(Buffer.from(String(s).padEnd(32, '.')).subarray(0, 32)),
      base64EncodeWebSafe: (b) => Buffer.from(b).toString('base64').replace(/\+/g, '-').replace(/\//g, '_'),
      DigestAlgorithm: { SHA_256: 1 }, Charset: { UTF_8: 1 } },
    Session: { getActiveUser: () => ({ getEmail: () => '' }), getScriptTimeZone: () => 'UTC' },
  };
  vm.createContext(ctx);
  vm.runInContext(fuente, ctx, { filename: 'backend/Code.js' });

  // El KMS doblado. DOS hijos admitidos, DOS sesiones de firma vivas, un solo tutor.
  ctx.kmsProxy_ = (accion, cuerpo) => {
    cuerposAlKms.push({ accion, cuerpo });
    if (accion === 'enr.expedienteDelToken') {
      return { expediente: {
        enrollment_group_id: GID, resume_token: TOK, primary_email: CORREO,
        created_at: new Date().toISOString(), submitted_at: new Date().toISOString(),
        abandoned_at: null, school_id: 'KIS',
      }, identidad: { ok: true, correo: CORREO, tutor: GUARD, email_id: 'n-1' } };
    }
    if (accion === 'enr.estadoDeLaAdmision') {
      return {
        expedientes: [
          { enrollment_id: H1, applicant_person_id: AL1, current_state_id: 'AD', enrollment_group_id: GID },
          { enrollment_id: H2, applicant_person_id: AL2, current_state_id: 'AD', enrollment_group_id: GID },
        ],
        personas: [{ person_id: GUARD, person_type_id: 'guardian' },
                   { person_id: AL1, person_type_id: 'applicant' },
                   { person_id: AL2, person_type_id: 'applicant' }],
        situaciones: [{ status_code: 'AD', designation: 'Admitida', state_id: 'AD' }],
        guardados_sin_aterrizar: [], guardados_no_consultables: false,
      };
    }
    if (accion === 'enr.datosDeFirma') {
      return {
        sessions: [{ session_id: SES1, entity_id: H1, deleted_at: null, current_state_code: 'DRAFT' },
                   { session_id: SES2, entity_id: H2, deleted_at: null, current_state_code: 'DRAFT' }],
        signers_by_session: {
          [SES1]: [{ signer_id: 'sg-1', session_id: SES1, signer_person_id: GUARD, signing_token: 'tok-h1', deleted_at: null }],
          [SES2]: [{ signer_id: 'sg-2', session_id: SES2, signer_person_id: GUARD, signing_token: 'tok-h2', deleted_at: null }],
        },
        pasos_por_expediente: (cuerpo && cuerpo.guardian_person_id) ? {
          [H1]: { billing_confirmed: true, gdpr_completed: true, review_completed: true, signed: false },
          [H2]: { billing_confirmed: false, gdpr_completed: false, review_completed: false, signed: false },
        } : {},
        admision_resuelta: true,
      };
    }
    if (accion === 'enr.tutorQueRecupera') return { ok: true, correo: CORREO, tutor: GUARD, email_id: 'n-1' };
    return {};
  };
  return { ctx, cache, cuerposAlKms };
}

/** El payload del pulso tal y como lo manda `WizardPage` al elegir un hijo. */
const pulso = (sel) => {
  const p = { resume_token: TOK, n: 'n-1', pv: 'pagina-viva-1' };
  if (sel !== undefined && sel !== null) p.selected_enrollment_id = sel;
  return p;
};

function correr(retoques) {
  const { ctx, cache } = cargar(retoques);

  // ── (A) LA SELECCIÓN, VALIDADA EN UN SOLO SITIO ──────────────────────────────────────
  {
    afirmar(ctx._hijoElegidoDelPayload_(pulso(H2)) === H2,
      '(A) una selección con forma válida se devuelve tal cual');
    afirmar(ctx._hijoElegidoDelPayload_(pulso()) === null,
      '(A) sin selección, `null`');
    // KAL-5 capa 1: lo que viene de fuera NO toca una clave sin validarse. Y una forma mala
    // se trata como AUSENTE — nunca como un error que le cierre el paso a la familia.
    let lanzo = false;
    let malo = null;
    try { malo = ctx._hijoElegidoDelPayload_(pulso('no-soy-un-uuid" || "1"="1')); } catch (e) { lanzo = true; }
    afirmar(!lanzo && malo === null,
      '(A) KAL-5: una selección con FORMA MALA se trata como ausente (y no lanza)');
  }

  // ── (B) LA CLAVE DE LA COPIA ─────────────────────────────────────────────────────────
  {
    const hoy = GID + '_' + ctx._wzN_('n-1', CORREO);
    afirmar(ctx._sufijoCopiaDelPulso_(GID, pulso()) === hoy,
      '(B) SIN selección, el sufijo de la clave es BYTE A BYTE el de hoy (el calentamiento sigue sirviendo)');
    const k1 = ctx._sufijoCopiaDelPulso_(GID, pulso(H1));
    const k2 = ctx._sufijoCopiaDelPulso_(GID, pulso(H2));
    afirmar(k1 !== k2,
      '(B) CON selección, dos hijos distintos NO comparten entrada');
    afirmar(k1 !== hoy && k2 !== hoy,
      '(B) y ninguno de los dos pisa la entrada SIN selección (la del calentamiento)');
    afirmar(ctx._sufijoCopiaDelPulso_(GID, pulso('no-soy-un-uuid')) === hoy,
      '(B) una selección con forma mala NO entra en la clave: se comporta como ausente');
    // ②24 — el buzón sigue dentro: es una frontera de PRIVACIDAD entre tutores.
    const otroTutor = { resume_token: TOK, n: 'n-2', selected_enrollment_id: H2 };
    afirmar(ctx._sufijoCopiaDelPulso_(GID, otroTutor) !== k2,
      '(B) ②24: el buzón sigue dentro de la clave — dos tutores del mismo hijo NO comparten entrada');
  }

  // ── (C) DE PUNTA A PUNTA: un acierto NUNCA devuelve el contexto de otro hijo ──────────
  {
    // 1.ª pasada SIN selección: el camino vivo escribe su copia (la del PRIMER hijo).
    const sinSel1 = ctx.getAdmissionState_(pulso());
    afirmar(sinSel1 && sinSel1.signing_context && sinSel1.signing_context.entity_id === H1,
      '(C) sin selección, el contexto es el del PRIMER hijo (comportamiento de siempre)');
    const clavesTrasPrimera = cache._claves().filter((k) => k.indexOf('wz_admv2_') === 0);
    afirmar(clavesTrasPrimera.length >= 1,
      '(C) ANCLA · la primera pasada dejó su copia escrita (si no, lo que sigue mediría el aire)');

    // 2.ª pasada: el tutor ELIGE al segundo hermano. La copia de arriba NO puede servirle.
    const conH2 = ctx.getAdmissionState_(pulso(H2));
    afirmar(conH2 && conH2.signing_context
      && conH2.signing_context.entity_id === H2 && conH2.signing_context.session_id === SES2,
      '(C) al elegir al SEGUNDO hermano, se le da SU contexto — nunca el del primero desde la copia');
    // ⚠️ POR QUÉ NO SE AFIRMA AQUÍ EL `signing_token`, y es producto, no arnés: sin step-up fresco
    // el pulso lo REDACTA a propósito (SEC WIZ-SIGNTOKEN) — por los dos caminos, vivo y copia. Lo
    // que identifica al hijo en esta respuesta es la SESIÓN (`entity_id`/`session_id`); que el token
    // sea el de esa sesión lo afirma `el-tramo-final-resuelve-todos-los-hijos.mjs` (C), sobre el
    // resolvedor. Se afirma, eso sí, que la redacción sigue puesta: aflojarla serviría un secreto
    // de portador antes de que el tutor acredite su buzón.
    afirmar(conH2 && conH2.signing_context && conH2.signing_context.signing_token === null,
      '(C) SEC WIZ-SIGNTOKEN: sin step-up fresco, el signing_token sigue redactado');

    // 3.ª pasada: repetir con el mismo hijo acierta en SU copia, y sigue siendo la suya.
    const conH2Otra = ctx.getAdmissionState_(pulso(H2));
    afirmar(conH2Otra && conH2Otra.signing_context && conH2Otra.signing_context.entity_id === H2,
      '(C) y repetir con el mismo hijo sigue devolviendo el suyo (la copia por hijo es consistente)');

    // 4.ª pasada: sin selección se sigue acertando en la copia de siempre — no se pierde la
    // entrada rápida que ya funcionaba.
    const sinSel2 = ctx.getAdmissionState_(pulso());
    afirmar(sinSel2 && sinSel2.signing_context && sinSel2.signing_context.entity_id === H1,
      '(C) sin selección se sigue sirviendo la copia de siempre (la entrada rápida no se pierde)');

    const claves = cache._claves().filter((k) => k.indexOf('wz_admv2_') === 0 && k.indexOf('_meta') < 0);
    afirmar(claves.length >= 2,
      `(C) hay una entrada POR HIJO, no una compartida (claves de copia: ${claves.length})`);
  }

  // ── (D) EL CUERPO QUE VIAJA AL KMS USA LA MISMA VALIDACIÓN ───────────────────────────
  {
    const conSel = ctx._conElHijoElegido_({ resume_token: TOK }, pulso(H2));
    afirmar(conSel.selected_enrollment_id === H2,
      '(D) con selección válida, el acto 8/9/10 la manda al KMS');
    const malo = ctx._conElHijoElegido_({ resume_token: TOK }, pulso('no-soy-un-uuid'));
    afirmar(!('selected_enrollment_id' in malo),
      '(D) con forma mala NO se manda: el mismo criterio que la clave (nunca dos validaciones)');
    const porToken = ctx._conElHijoElegido_({ signing_token: 'tok-h2' }, pulso(H2));
    afirmar(!('selected_enrollment_id' in porToken),
      '(D) por la vía del signing_token no se manda: la sesión ya es la del token');
  }
}

function main() {
  let ok = 0, ciegas = 0;
  try {
    try { correr([]); } catch (e) {
      if (e instanceof Ciega) { console.log(`MEDICIÓN CIEGA · ${e.message}`); console.log('VEREDICTO: ROJO — MEDICIÓN CIEGA'); process.exitCode = 1; return; }
      console.log(`VEREDICTO: ROJO — el control reventó: ${e.stack}`); process.exitCode = 1; return;
    }

    const roturas = [
      // (B)+(C) la clave vuelve a ser CIEGA al hijo elegido ⇒ el segundo hermano recibe el contexto del primero
      ['la clave olvida el hijo elegido', [[
        "  return sel ? (base + '_s:' + sel) : base;",
        '  return base;']], ['(B)', '(C)']],
      // (A)+(B)+(D) la validación se afloja ⇒ algo de fuera entra crudo en la clave (KAL-5)
      ['la selección entra sin validar', [[
        "  try { assertValidUuid_(sel, 'selected_enrollment_id'); } catch (e) { return null; }\n  return sel;",
        '  return sel;']], ['(A)', '(B)', '(D)']],
      // (B) el buzón sale de la clave ⇒ ②24 roto: dos tutores compartirían copia
      ['el buzón sale de la clave', [[
        "  var base = id + '_' + _wzN_(p && p.n, p && p.recovered_email);",
        "  var base = id + '_';"]], ['(B)']],
      // (C) la ESCRITURA usa otra clave que la LECTURA ⇒ nunca se acierta, o se acierta mal
      ['la escritura usa la clave vieja', [[
        "      _wzCacheKey_('adm', _sufijoCopiaDelPulso_(id, p)),   // ★ CLI 467: la MISMA clave que la lectura",
        "      _wzCacheKey_('adm', id + '_' + _wzN_(p && p.n, p && p.recovered_email)),"]], ['(C)']],
      // (C) el camino vivo deja de pasarle el hijo elegido al resolvedor ⇒ siempre la sesión primaria
      ['el camino vivo ignora el hijo elegido', [[
        '  const selEnr = _hijoElegidoDelPayload_(p);',
        '  const selEnr = null;']], ['(C)']],
    ];
    console.log('\n  ── roturas demostradas ──');
    for (const [n, retoques, esps] of roturas) {
      const antes = fallos.length, v = verdes, tt = total;
      callado = true;
      let detectada = false, ciega = null;
      try { correr(retoques); } catch (e) { if (e instanceof Ciega) ciega = `rotura «${n}»: ${e.message}`; else detectada = true; }
      callado = false;
      const rojos = fallos.slice(antes);
      detectada = detectada || esps.some((esp) => rojos.some((t) => t.includes(esp)));
      fallos.length = antes; verdes = v; total = tt;
      if (ciega) { fallos.push(ciega); detectada = false; }
      console.log(`  ${detectada ? '✓' : '✗'} ROTURA ${n}`);
      if (detectada) ok++; else if (!ciega) fallos.push(`rotura no detectada: ${n}`);
    }

    // ⛔ MEDICIÓN CIEGA: si lo que medimos cambia de nombre, ROJO — nunca verde.
    for (const [n, de, a] of [
      ['el sufijo de la clave', 'function _sufijoCopiaDelPulso_(', 'function _otroSufijo_('],
      ['la selección validada', 'function _hijoElegidoDelPayload_(', 'function _otraSeleccion_('],
      ['el pulso', 'function getAdmissionState_(', 'function otroPulso_('],
    ]) {
      const tt = total, v = verdes, antes = fallos.length;
      callado = true;
      let ciego = false;
      try { correr([[de, a]]); } catch (e) { ciego = e instanceof Ciega || /is not a function/.test(e.message); }
      callado = false;
      fallos.length = antes; verdes = v; total = tt;
      console.log(`  ${ciego ? '✓' : '✗'} ROTURA renombrar ${n} → ${ciego ? 'MEDICIÓN CIEGA' : 'NO se detectó'}`);
      if (ciego) ciegas++; else fallos.push(`renombrar ${n} no da MEDICIÓN CIEGA`);
    }
  } finally {
    if (fallos.length) {
      fallos.forEach((x) => console.log(`  ✗ ${x}`));
      console.log(`VEREDICTO: ROJO — ${fallos.length} fallo(s)`);
      process.exitCode = 1;
    } else {
      console.log(`VEREDICTO: VERDE — ${total} afirmaciones, ${ok} roturas demostradas y ${ciegas} guardas de MEDICIÓN CIEGA`);
    }
  }
}
main();
