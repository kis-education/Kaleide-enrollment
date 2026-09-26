#!/usr/bin/env node
/**
 * EL CATÁLOGO SE ENTERA CUANDO EL COLEGIO LO CAMBIA — control que EJECUTA el servidor.
 * ══════════════════════════════════════════════════════════════════════════════════════
 *
 * `node scripts/servidor/el-catalogo-se-entera-cuando-el-colegio-lo-cambia.mjs`
 * Sin red, sin navegador, sin `npm ci`. Última línea: `VEREDICTO: VERDE` / `ROJO — <motivo>`.
 *
 * QUÉ PROTEGE, en una frase: **que una pregunta editada en el KMS llegue al asistente, y que
 * un fallo de ese aviso NUNCA deje a un tutor sin cuestionario.**
 *
 * POR QUÉ EXISTE. Medido el 2026-09-23: el mismo cuestionario vivía en TRES copias (el KMS, el
 * servidor del asistente y el navegador del tutor) con tres caducidades distintas y **a ninguna
 * le avisaba nadie**. Es la regla 2 de Diego —*«Si alguien en el KMS modifica algún dato… se le
 * manda al backend del wizard»*— sin aplicar a la CONFIGURACIÓN del colegio. Desde hoy el KMS
 * avisa y `notifyLiveStateChange_` rehace el catálogo; esto es lo que impide que se vuelva a ir.
 *
 * ⛔ **LA BARANDILLA QUE MANDA SOBRE LA VELOCIDAD, y es la afirmación (3):** si el viaje del
 * rehacer falla, **la copia vieja sigue en pie**. Un catálogo viejo es peor que uno nuevo; una
 * pantalla en blanco es peor que los dos.
 *
 * CÓMO MIDE. Extrae del FUENTE REAL (`backend/Code.js`) las funciones que deciden y las ejecuta
 * con dobles en memoria (caché con reloj simulado, salto al KMS contado). No copia ni una línea
 * de lógica: si la función cambia, este control mide la nueva.
 *
 * ⚠️ **LO QUE NO AFIRMA**: no habla con el KMS, así que **no dice nada sobre si el KMS manda el
 * aviso de verdad** (eso vive en `kis-app kms-server/`: `QB_RUTAS_QUE_TOCAN_EL_CATALOGO_` +
 * `enr_avisarCambioDeCatalogoDePreguntas_`), ni sobre la firma del canal (eso es
 * `comprobar-receptor-firmado`), ni sobre lo que pinta el navegador (eso es la batería).
 *
 * ⛔ **Y SE HA VISTO FALLAR**: al final se rompe el fuente a propósito y se exige que el control
 * lo NOMBRE. Un control que nunca se ha visto rojo no es una red.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
// El fuente por defecto es el del producto. Se admite otro por argumento SOLO para poder
// romperlo a propósito y ver este control en ROJO — en CI se ejecuta sin argumentos.
const FUENTE = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(AQUI, '..', '..', 'backend', 'Code.js');

// Las que deciden este camino. Si falta una, no se mide nada: MEDICIÓN CIEGA.
const NECESARIAS = [
  '_claveCatalogoPreguntas_', '_catalogoDePreguntasImposible_',
  '_catalogoDePreguntasDeLaCopia_', '_guardarCatalogoDePreguntas_',
  '_claveViajeDelCatalogo_', '_marcarViajeDelCatalogo_', '_quedaTechoDelCatalogo_',
  '_espejoCalentarElCuestionario_', 'fetchQuestions_',
  // Las de este cambio: la versión, el índice y el rehacer.
  '_versionDelCatalogo_', '_conVersionDelCatalogo_', '_versionGuardadaDelCatalogo_',
  '_claveIndiceDelCatalogo_', '_combinacionesDelCatalogo_', '_apuntarCombinacionDelCatalogo_',
  '_catalogoCambioEnElColegio_', '_versionDelCatalogoParaElPulso_', 'getLiveStateVersion_',
];

class Ciega extends Error {}

// ── Extracción del fuente ───────────────────────────────────────────────────────────────
function extraer(src, nombre) {
  const i = src.indexOf('\nfunction ' + nombre + '(');
  if (i < 0) return null;
  let d = 0, k = src.indexOf('{', i);
  for (; k < src.length; k++) {
    if (src[k] === '{') d++;
    else if (src[k] === '}') { d--; if (d === 0) break; }
  }
  return src.slice(i + 1, k + 1);
}
function constante(src, nombre) {
  const m = new RegExp('\\nvar ' + nombre + '\\s*=\\s*([0-9*\\s]+);').exec(src);
  if (!m) return null;
  const v = Function('return (' + m[1] + ');')();
  return Number.isFinite(v) ? v : null;
}

/** Monta el módulo del catálogo con dobles. Devuelve sus funciones y el mando del reloj. */
function montar(src) {
  const faltan = NECESARIAS.filter(n => !extraer(src, n));
  if (faltan.length) throw new Ciega('no están en el fuente: ' + faltan.join(', '));

  // El receptor tiene que ATENDER el alcance CATALOGO, y eso se lee del receptor REAL: si
  // alguien quita esa rama, el aviso del KMS deja de rehacer nada y nadie se entera.
  const receptor = extraer(src, 'notifyLiveStateChange_');
  if (!receptor) throw new Ciega('no está `notifyLiveStateChange_`');
  const atiendeElCatalogo = /alcance\s*===\s*'CATALOGO'/.test(receptor) &&
                            receptor.includes('_catalogoCambioEnElColegio_');

  // El `forzar` tiene que EXISTIR en el rehacedor, o el aviso refrescaría el plazo de lo
  // viejo en vez de volver a preguntar — que es exactamente lo contrario de lo que hace falta.
  const rehacedor = extraer(src, '_espejoCalentarElCuestionario_');
  const sabeForzar = /opciones\s*&&\s*opciones\.forzar/.test(rehacedor);

  for (const n of ['CATALOGO_PREGUNTAS_TTL_S_', 'CATALOGO_PREGUNTAS_TECHO_S_',
                   'CATALOGO_INDICE_TTL_S_', 'CATALOGO_COMBINACIONES_TOPE_',
                   'CATALOGO_AVISO_PRESUPUESTO_MS_']) {
    if (constante(src, n) === null) throw new Ciega('falta la constante ' + n);
  }
  const constantes =
    'var CATALOGO_PREGUNTAS_TTL_S_ = ' + constante(src, 'CATALOGO_PREGUNTAS_TTL_S_') + ';\n' +
    'var CATALOGO_PREGUNTAS_TECHO_S_ = ' + constante(src, 'CATALOGO_PREGUNTAS_TECHO_S_') + ';\n' +
    'var CATALOGO_INDICE_TTL_S_ = ' + constante(src, 'CATALOGO_INDICE_TTL_S_') + ';\n' +
    'var CATALOGO_COMBINACIONES_TOPE_ = ' + constante(src, 'CATALOGO_COMBINACIONES_TOPE_') + ';\n' +
    'var CATALOGO_AVISO_PRESUPUESTO_MS_ = ' + constante(src, 'CATALOGO_AVISO_PRESUPUESTO_MS_') + ';\n';

  const estado = { reloj: 0, viajes: 0 };
  const almacen = new Map();
  const cache = {
    get: k => { const e = almacen.get(k); if (!e) return null; if (e.expira <= estado.reloj) { almacen.delete(k); return null; } return e.v; },
    put: (k, v, ttl) => { almacen.set(k, { v, expira: estado.reloj + ttl * 1000 }); },
    remove: k => { almacen.delete(k); },
    putAll: (o, ttl) => { for (const k of Object.keys(o)) almacen.set(k, { v: o[k], expira: estado.reloj + ttl * 1000 }); },
    getAll: ks => { const o = {}; for (const k of ks) { const v = cache.get(k); if (v != null) o[k] = v; } return o; },
  };

  const preludio = `
var SCHOOL_ID = 'KIS';
var ESPEJO_CUESTIONARIOS_POR_VUELTA_ = 8;
var CacheService = { getScriptCache: function () { return __cache; } };
var Logger = { log: function () {} };
function redact_(s) { return String(s); }
function assertValidUuid_(v) { if (!/^[0-9a-f-]{8,}$/i.test(String(v || ''))) throw new Error('uuid'); }
function _getLiveStateVersion_() { return 7; }
function _wzCachePutChunked_(cache, key, serialized, ttl) {
  var obj = {}; obj[key + '_meta'] = '1'; obj[key + '_0'] = serialized;
  cache.putAll(obj, ttl || 1800); return true;
}
function _wzCacheGetChunked_(cache, key) {
  if (!cache.get(key + '_meta')) return null; return cache.get(key + '_0');
}
function _checkPublicCatalogRateLimit_() { __cupo(); }
function kmsProxy_() { __viaje(); return {}; }
function fetchQuestions_adaptKmsResponse_() { return __catalogoDelKms(); }
function Date_now() { return Date.now(); }
`;
  // El reloj de `Date.now()` lo gobierna el arnés: los presupuestos del producto se miden con
  // él, y sin control del reloj «se acabó el tiempo» no se puede provocar.
  const cuerpo = constantes + preludio +
    NECESARIAS.map(n => extraer(src, n)).join('\n\n') +
    '\nreturn { _espejoCalentarElCuestionario_: _espejoCalentarElCuestionario_,' +
    ' fetchQuestions_: fetchQuestions_,' +
    ' _catalogoDePreguntasDeLaCopia_: _catalogoDePreguntasDeLaCopia_,' +
    ' _guardarCatalogoDePreguntas_: _guardarCatalogoDePreguntas_,' +
    ' _combinacionesDelCatalogo_: _combinacionesDelCatalogo_,' +
    ' _catalogoCambioEnElColegio_: _catalogoCambioEnElColegio_,' +
    ' _versionDelCatalogo_: _versionDelCatalogo_,' +
    ' _conVersionDelCatalogo_: _conVersionDelCatalogo_,' +
    ' _versionGuardadaDelCatalogo_: _versionGuardadaDelCatalogo_,' +
    ' _quedaTechoDelCatalogo_: _quedaTechoDelCatalogo_,' +
    ' getLiveStateVersion_: getLiveStateVersion_ };';

  let cuposGastados = 0;
  let catalogoDelKms = { sets: [{ set_id: 's1', items: [{ question: { question_id: 'q1' } }] }] };
  let elViajeFalla = false;
  const api = new Function('__cache', '__viaje', '__cupo', '__catalogoDelKms', cuerpo)(
    cache,
    () => { estado.viajes++; if (elViajeFalla) throw new Error('KMS caído'); },
    () => { cuposGastados++; },
    () => catalogoDelKms,
  );
  return {
    api, estado, atiendeElCatalogo, sabeForzar,
    presupuestoMs: constante(src, 'CATALOGO_AVISO_PRESUPUESTO_MS_'),
    avanzar: ms => { estado.reloj += ms; },
    cupo: () => cuposGastados,
    ponerCatalogoDelKms: c => { catalogoDelKms = c; },
    romperElViaje: v => { elViajeFalla = v; },
  };
}

// ── Las afirmaciones ────────────────────────────────────────────────────────────────────
const fallos = [];
const notas  = [];
// `2026-09-23-un-arnes-que-no-afirma-nada-pasa` — cuántas afirmaciones REALES corrió esta
// pasada, contadas EN EJECUCIÓN: un `total` que se quedara a cero por una excepción tapada
// o un renombrado tiene que poder DECIRLO en el propio veredicto.
let total = 0;
function afirmar(nombre, condicion, porque) {
  total++;
  if (condicion) { notas.push('  ✓ ' + nombre); return true; }
  fallos.push(nombre + ' — ' + porque);
  notas.push('  ✗ ' + nombre + '\n      ' + porque);
  return false;
}

// ⛔ El veredicto se imprime SIEMPRE, también ante un error fatal del propio arnés.
let salida = 0;
try {
  const src = fs.readFileSync(FUENTE, 'utf8');
  let m;
  try {
    m = montar(src);
  } catch (e) {
    console.log('MEDICIÓN CIEGA — ' + e.message);
    console.log('VEREDICTO: ROJO — MEDICIÓN CIEGA: ' + e.message);
    process.exit(1);
  }

  notas.push('fuente: backend/Code.js · presupuesto del aviso: ' + m.presupuestoMs + ' ms');

  // (0) EL RECEPTOR ATIENDE EL AVISO DEL CATÁLOGO. Sin esto, el KMS avisa al vacío.
  afirmar('(0) el receptor firmado atiende el alcance CATALOGO',
    m.atiendeElCatalogo,
    '`notifyLiveStateChange_` ya no mira `alcance === \'CATALOGO\'` ni llama a ' +
    '`_catalogoCambioEnElColegio_`: el KMS seguiría mandando el aviso y aquí no lo cogería ' +
    'nadie — el catálogo volvería a vivir solo de su temporizador');

  // (0.bis) EL REHACEDOR SABE FORZAR. Sin `forzar`, el aviso refresca el PLAZO de lo viejo.
  afirmar('(0.bis) el rehacedor sabe FORZAR el viaje',
    m.sabeForzar,
    '`_espejoCalentarElCuestionario_` ya no admite `{forzar:true}`: tras el aviso del colegio ' +
    'se limitaría a renovarle el plazo al catálogo VIEJO, que es lo contrario de lo que hace falta');

  // (1) UNA PREGUNTA EDITADA LLEGA. Es la afirmación principal.
  {
    const m1 = montar(src);
    m1.api.fetchQuestions_({ context_code: 'ENROLLMENT', language: 'es', program_id: 'p1' });
    const antes = m1.api._catalogoDePreguntasDeLaCopia_('ENROLLMENT', 'es', 'p1');
    const vAntes = m1.api._versionDelCatalogo_(antes);
    // El colegio edita una pregunta: el KMS servirá otra cosa a partir de ahora.
    m1.ponerCatalogoDelKms({ sets: [{ set_id: 's1', items: [
      { question: { question_id: 'q1' } }, { question: { question_id: 'q2_NUEVA' } }] }] });
    // ⚠️ Sin el aviso, la copia NO cambia: es justo el defecto que esto cierra.
    const sinAviso = m1.api._versionDelCatalogo_(
      m1.api._catalogoDePreguntasDeLaCopia_('ENROLLMENT', 'es', 'p1'));
    afirmar('(1.a) sin el aviso, la copia se queda con la pregunta VIEJA',
      sinAviso === vAntes,
      'la copia cambió sin que nadie avisara: este arnés no está midiendo lo que cree');
    // Y con el aviso:
    const r = m1.api._catalogoCambioEnElColegio_('PREGUNTA');
    const despues = m1.api._catalogoDePreguntasDeLaCopia_('ENROLLMENT', 'es', 'p1');
    const vDespues = m1.api._versionDelCatalogo_(despues);
    notas.push('  · aviso: combinaciones=' + r.combinaciones + ' rehechas=' + r.rehechas +
               ' destechadas=' + r.destechadas + ' · versión ' + vAntes + ' → ' + vDespues);
    afirmar('(1.b) el aviso del colegio REHACE la copia (la pregunta editada llega)',
      vDespues !== vAntes && (despues.sets[0].items || []).length === 2,
      'tras el aviso la copia del asistente seguía siendo la vieja (versión ' + vAntes + ' → ' +
      vDespues + '): «invalidar NO es actualizar», y aquí ni siquiera se actualizó');
    afirmar('(1.c) el aviso sabía QUÉ combinación rehacer',
      r.combinaciones >= 1 && r.rehechas >= 1,
      'el índice de combinaciones no tenía nada: el aviso llega y no encuentra a qué copia ' +
      'aplicarlo ⇒ el catálogo vuelve a depender solo de su plazo');
  }

  // (2) EL ÍNDICE LO ESCRIBE EL ESCRITOR ÚNICO, va MÁS RECIENTE PRIMERO y está ACOTADO.
  {
    const m2 = montar(src);
    for (const [l, p] of [['es', 'p1'], ['en', 'p1'], ['es', '']]) {
      m2.api.fetchQuestions_({ context_code: 'ENROLLMENT', language: l, program_id: p || undefined });
    }
    const idx = m2.api._combinacionesDelCatalogo_();
    afirmar('(2.a) el índice recoge las TRES combinaciones servidas',
      idx.length === 3,
      'el índice tiene ' + idx.length + ' de 3: el escritor único del catálogo dejó de apuntarlas ' +
      'y el aviso rehará de menos');
    afirmar('(2.b) va MÁS RECIENTE PRIMERO',
      idx[0] && idx[0].l === 'es' && idx[0].p === '',
      'la más reciente no está la primera: el aviso tiene presupuesto acotado, así que el orden ' +
      'decide QUÉ se corrige antes — y lo que se está sirviendo va primero');
    afirmar('(2.c) la clave «sin programa» está en el índice',
      idx.some(x => x.p === ''),
      'la combinación «sin programa» (la solicitud que todavía no ha elegido) no se apunta: es ' +
      'justo una de las que el KMS NO puede derivar de `enrPrograms`, y por eso tiene que salir de aquí');
  }

  // (3) ⛔⛔ LA BARANDILLA: SI EL VIAJE FALLA, NADIE SE QUEDA SIN CUESTIONARIO.
  {
    const m3 = montar(src);
    m3.api.fetchQuestions_({ context_code: 'ENROLLMENT', language: 'es', program_id: 'p1' });
    const antes = m3.api._catalogoDePreguntasDeLaCopia_('ENROLLMENT', 'es', 'p1');
    m3.romperElViaje(true);
    const r = m3.api._catalogoCambioEnElColegio_('PREGUNTA');
    const despues = m3.api._catalogoDePreguntasDeLaCopia_('ENROLLMENT', 'es', 'p1');
    afirmar('(3.a) con el rehacer ROTO, la copia vieja SIGUE EN PIE',
      !!despues && JSON.stringify(despues.sets) === JSON.stringify(antes.sets),
      'el aviso se llevó por delante la copia cuando el viaje falló: el tutor se queda con el ' +
      'paso 5 EN BLANCO. Una pantalla en blanco es peor que un catálogo viejo — es la barandilla ' +
      'que manda sobre la velocidad');
    afirmar('(3.b) y el aviso no propaga el fallo',
      r && typeof r.combinaciones === 'number',
      'el aviso lanzó hacia arriba: el POST del KMS se llevaría un error y el trabajo de la cola ' +
      'quedaría marcado como fallido por algo que es best-effort');
    // Y la puerta pública sigue sirviendo el catálogo viejo, que es lo que ve la familia.
    m3.romperElViaje(false);
    const servido = m3.api.fetchQuestions_({ context_code: 'ENROLLMENT', language: 'es', program_id: 'p1' });
    afirmar('(3.c) y la puerta pública sigue devolviendo un catálogo con preguntas',
      !!(servido && servido.sets && servido.sets.length),
      'tras un aviso con el viaje roto, `fetchQuestions_` devolvió un catálogo vacío: eso es la ' +
      'pantalla en blanco delante de la familia');
  }

  // (4) LA VERSIÓN. Es lo que hace que la copia de 30 DÍAS del navegador deje de poder mentir.
  {
    const m4 = montar(src);
    const a = { sets: [{ set_id: 's', items: [{ question: { question_id: 'q1' } }] }] };
    const b = { sets: [{ set_id: 's', items: [{ question: { question_id: 'q2' } }] }] };
    afirmar('(4.a) dos catálogos distintos dan versiones distintas',
      m4.api._versionDelCatalogo_(a) !== m4.api._versionDelCatalogo_(b),
      'la versión no distingue dos catálogos distintos: el navegador nunca se enteraría de un cambio');
    afirmar('(4.b) el mismo catálogo da SIEMPRE la misma versión',
      m4.api._versionDelCatalogo_(a) === m4.api._versionDelCatalogo_(JSON.parse(JSON.stringify(a))),
      'la versión no es estable: el navegador revalidaría en cada latido y pagaría el catálogo entero');
    // La versión NO puede depender del campo que el propio servidor le añade, o el navegador
    // —que la deriva sin ese campo— compararía dos números que nunca coinciden.
    const conVersion = m4.api._conVersionDelCatalogo_(JSON.parse(JSON.stringify(a)));
    afirmar('(4.c) poner la versión dentro NO cambia la versión',
      conVersion.catalog_version === m4.api._versionDelCatalogo_(a),
      'añadir `catalog_version` al catálogo cambia su propia versión: el número del servidor y el ' +
      'que deriva el navegador dejarían de coincidir nunca y revalidaría en bucle');
    // Y la llamada barata del pulso la lleva.
    m4.api.fetchQuestions_({ context_code: 'ENROLLMENT', language: 'es', program_id: 'p1' });
    const rv = m4.api.getLiveStateVersion_({ enrollment_group_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
                                             cat_lang: 'es', cat_prog: 'p1' });
    afirmar('(4.d) la llamada BARATA del pulso lleva la versión del catálogo',
      !!(rv && rv.catalogo_v),
      '`getLiveStateVersion` no devuelve `catalogo_v`: es la ÚNICA etapa del pulso que late cada ' +
      '30 s pase lo que pase — el detalle solo se pide cuando cambia la SOLICITUD, y un cambio de ' +
      'catálogo no la mueve. Sin esto el navegador no se entera nunca');
    const sinCombinacion = m4.api.getLiveStateVersion_({ enrollment_group_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee' });
    afirmar('(4.e) sin combinación declarada la respuesta dice «no consta», no un número',
      sinCombinacion.catalogo_v === null,
      'se devolvió una versión para una combinación que el llamante no declaró: el navegador la ' +
      'compararía con la suya y concluiría un cambio que no hubo');
    // Y no cuesta un viaje al KMS.
    const viajesAntes = m4.estado.viajes;
    m4.api.getLiveStateVersion_({ enrollment_group_id: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
                                  cat_lang: 'es', cat_prog: 'p1' });
    afirmar('(4.f) y la versión NO cuesta un viaje al KMS',
      m4.estado.viajes === viajesAntes,
      'calcular la versión salió al KMS: esto late cada 30 s por cada tutor con el asistente ' +
      'abierto — un viaje aquí es un viaje cada 30 s por familia');
  }

  // (5) EL AVISO NO GASTA EL CUPO PÚBLICO DE LA FAMILIA POR LA VÍA RARA, y respeta su presupuesto.
  {
    const m5 = montar(src);
    for (const [l, p] of [['es', 'p1'], ['en', 'p1'], ['es', 'p2'], ['en', 'p2'], ['es', ''], ['en', '']]) {
      m5.api.fetchQuestions_({ context_code: 'ENROLLMENT', language: l, program_id: p || undefined });
    }
    const viajesAntes = m5.estado.viajes;
    const r = m5.api._catalogoCambioEnElColegio_('PREGUNTA');
    afirmar('(5.a) el aviso rehace TODAS las combinaciones que hay (hoy seis)',
      r.combinaciones === 6 && (m5.estado.viajes - viajesAntes) === 6,
      'el aviso vio ' + r.combinaciones + ' combinaciones y viajó ' + (m5.estado.viajes - viajesAntes) +
      ' veces: se midieron SEIS contra el despliegue vivo (2 programas × 2 idiomas + la clave «sin ' +
      'programa»), y la que no se rehaga se queda vieja');
    afirmar('(5.b) lo que no cabe en el presupuesto se DESTECHA, no se borra',
      r.destechadas === 0,
      'con presupuesto de sobra no debería destecharse nada: ' + r.destechadas + ' destechadas');
  }

  // (5.bis) CON EL PRESUPUESTO AGOTADO: se destecha lo que no cupo y NO se borra ninguna copia.
  {
    const m6 = montar(src);
    for (const [l, p] of [['es', 'p1'], ['en', 'p1'], ['es', '']]) {
      m6.api.fetchQuestions_({ context_code: 'ENROLLMENT', language: l, program_id: p || undefined });
    }
    // El reloj del producto es `Date.now()`, así que se le agota el presupuesto empujándolo.
    const reloj = Date.now;
    let t = reloj();
    Date.now = () => { t += m6.presupuestoMs + 1; return t; };   // cada consulta ya se pasó
    let r6;
    try { r6 = m6.api._catalogoCambioEnElColegio_('PREGUNTA'); } finally { Date.now = reloj; }
    afirmar('(5.bis.a) con el presupuesto agotado se DESTECHA lo que quedó fuera',
      r6.destechadas >= 1,
      'no se destechó nada: lo que el aviso no alcanzó a rehacer se quedaría con su techo intacto ' +
      'y el repaso de fondo tampoco lo volvería a preguntar — quedaría viejo hasta 2 h más');
    afirmar('(5.bis.b) y NINGUNA copia se quedó sin catálogo',
      ['p1', 'p1', ''].every((p, i) =>
        !!m6.api._catalogoDePreguntasDeLaCopia_('ENROLLMENT', ['es', 'en', 'es'][i], p)),
      'una copia desapareció al agotarse el presupuesto: ningún tutor puede quedarse sin ' +
      'cuestionario porque al aviso se le acabara el tiempo');
  }

  // ── ⛔ Y AHORA SE ROMPE A PROPÓSITO ───────────────────────────────────────────────────
  // Un control que no se ha visto fallar no es una red. Estas roturas tienen que salir
  // NOMBRADAS; si alguna pasa, es este fichero el que está roto, no el producto.
  const roturas = [
    ['renombrar el rehacedor del aviso',
     s => s.replace('function _catalogoCambioEnElColegio_(', 'function _catalogoCambioEnElColegioXX_('),
     /MEDICIÓN CIEGA|no están/],
    ['renombrar el índice de combinaciones',
     s => s.replace('function _combinacionesDelCatalogo_(', 'function _combinacionesDelCatalogoZZ_('),
     /MEDICIÓN CIEGA|no están/],
    ['renombrar la versión del catálogo',
     s => s.replace('function _versionDelCatalogo_(', 'function _versionDelCatalogoQQ_('),
     /MEDICIÓN CIEGA|no están/],
    ['borrar la constante del presupuesto del aviso',
     s => s.replace(/\nvar CATALOGO_AVISO_PRESUPUESTO_MS_ = [^;]+;/, '\nvar CATALOGO_AVISO_OTRO_ = 0;'),
     /MEDICIÓN CIEGA|CATALOGO_AVISO_PRESUPUESTO_MS_/],
  ];
  roturas.forEach(([nombre, romper, esperado]) => {
    const roto = romper(src);
    if (roto === src) {
      afirmar('(R) la rotura «' + nombre + '» se aplica de verdad', false,
        'el texto que esta rotura buscaba ya no está en el fuente: la comprobación pasaría EN VACÍO');
      return;
    }
    let salto = null;
    try { montar(roto); } catch (e) { salto = e instanceof Ciega ? ('MEDICIÓN CIEGA — ' + e.message) : String(e.message); }
    afirmar('(R) rota a propósito «' + nombre + '» ⇒ el control lo NOMBRA',
      !!salto && esperado.test(salto),
      'al romper eso el control dijo ' + JSON.stringify(salto) + ' y se esperaba que lo nombrara: ' +
      'una comprobación que no se ha visto fallar no protege nada');
  });

  // Y las roturas que NO son de montaje: tienen que poner ROJA su afirmación, no cegar el arnés.
  const roturasVivas = [
    ['que el receptor deje de atender el alcance CATALOGO',
     s => s.replace("v.event.alcance === 'CATALOGO'", "v.event.alcance === 'NUNCA_JAMAS'"),
     m => !m.atiendeElCatalogo],
    ['que el rehacedor deje de saber FORZAR',
     s => s.replace('var forzar = !!(opciones && opciones.forzar);', 'var forzar = false;'),
     m => !m.sabeForzar],
    ['que el aviso BORRE la copia antes de pedir',
     s => s.replace('    if (!c || c.c !== \'ENROLLMENT\') continue;   // hoy solo hay este contexto',
                    '    if (!c || c.c !== \'ENROLLMENT\') continue;\n      CacheService.getScriptCache().remove(_claveCatalogoPreguntas_(c.c, c.l, c.p) + \'_meta\');'),
     m => {
       m.api.fetchQuestions_({ context_code: 'ENROLLMENT', language: 'es', program_id: 'p1' });
       m.romperElViaje(true);
       m.api._catalogoCambioEnElColegio_('PREGUNTA');
       return !m.api._catalogoDePreguntasDeLaCopia_('ENROLLMENT', 'es', 'p1');   // se quedó SIN catálogo
     }],
  ];
  roturasVivas.forEach(([nombre, romper, seNota]) => {
    const roto = romper(src);
    if (roto === src) {
      afirmar('(R) la rotura «' + nombre + '» se aplica de verdad', false,
        'el texto que esta rotura buscaba ya no está en el fuente: pasaría EN VACÍO');
      return;
    }
    let notado = false;
    try { notado = seNota(montar(roto)); } catch (e) { notado = true; }
    afirmar('(R) rota a propósito «' + nombre + '» ⇒ el control lo nota',
      notado,
      'al romper eso el control siguió VERDE: esa afirmación no está midiendo nada');
  });

  // ── Veredicto ─────────────────────────────────────────────────────────────────────────
  console.log('EL CATÁLOGO SE ENTERA CUANDO EL COLEGIO LO CAMBIA');
  notas.forEach(n => console.log(n));
  if (fallos.length) {
    console.log('VEREDICTO: ROJO — ' + fallos[0] + (fallos.length > 1 ? ' (y ' + (fallos.length - 1) + ' más)' : ''));
    salida = 1;
  } else {
    console.log('VEREDICTO: VERDE — ' + total + ' afirmaciones: una pregunta editada en el KMS ' +
      'llega a la copia del asistente, la versión viaja en el latido barato para que el navegador ' +
      'se entere sin pedir el catálogo, y si el aviso falla nadie se queda sin cuestionario.');
  }
} catch (eFatal) {
  console.log('VEREDICTO: ROJO — el propio arnés reventó: ' + ((eFatal && eFatal.message) || eFatal));
  salida = 1;
} finally {
  process.exit(salida);
}
