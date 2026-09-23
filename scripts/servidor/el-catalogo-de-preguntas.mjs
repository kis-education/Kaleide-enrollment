#!/usr/bin/env node
/**
 * EL CATÁLOGO DE PREGUNTAS — control que EJECUTA el servidor, no que lee sus líneas.
 * ══════════════════════════════════════════════════════════════════════════════════════
 *
 * `node scripts/servidor/el-catalogo-de-preguntas.mjs`
 * Sin red, sin navegador, sin `npm ci`. Última línea: `VEREDICTO: VERDE` / `ROJO — <motivo>`.
 *
 * QUÉ PROTEGE, en una frase: **que un catálogo de preguntas guardado en la copia del
 * asistente no se pueda quedar clavado PARA SIEMPRE** — y que el ahorro de viajes que lo
 * mantiene caliente se conserve.
 *
 * POR QUÉ EXISTE. El 2026-09-22 (`@297`) el repaso del espejo aprendió a refrescar el plazo
 * del catálogo **sin volver a preguntar al KMS**. Cada 30 minutos y sin tope ⇒ lo que se
 * guardó una vez se quedaba renovado indefinidamente, y la única cura automática que había
 * —que caducara solo— desapareció. Al día siguiente Diego vio el paso 5 mal y escribió: *«Esto
 * es un bucle sin fin, se arregla una cosa y se estropea otra.»* El techo
 * (`CATALOGO_PREGUNTAS_TECHO_S_`) lo acota; este control es lo que impide que se vuelva a ir.
 *
 * ⚠️ **Y DICE LO QUE NO ES**: el techo es un PARCHE. La causa de fondo es que **nadie avisa al
 * asistente cuando el colegio toca una pregunta** — el catálogo es configuración del centro y
 * no tiene el aviso que las SOLICITUDES sí tienen. Ese arreglo es otra ficha.
 *
 * CÓMO MIDE. Extrae del FUENTE REAL (`backend/Code.js`) las funciones que deciden, y las
 * ejecuta con dobles en memoria (caché con reloj simulado, salto al KMS contado). No copia ni
 * una línea de lógica: si la función cambia, este control mide la nueva.
 *
 * ⛔ **Y SE HA VISTO FALLAR**: al final se rompe el fuente a propósito (tres roturas) y se
 * exige que el control lo NOMBRE. Un control que nunca se ha visto rojo no es una red.
 */

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
// El fuente por defecto es el del producto. Se admite otro por argumento SOLO para poder
// romperlo a propósito y ver este control en ROJO (un control que nunca se ha visto fallar no
// es una red) — en CI se ejecuta sin argumentos.
const FUENTE = process.argv[2]
  ? path.resolve(process.argv[2])
  : path.resolve(AQUI, '..', '..', 'backend', 'Code.js');

// Las que deciden el camino del catálogo. Si falta una, no se mide nada: MEDICIÓN CIEGA.
const NECESARIAS = [
  '_claveCatalogoPreguntas_', '_catalogoDePreguntasImposible_',
  '_catalogoDePreguntasDeLaCopia_', '_guardarCatalogoDePreguntas_',
  '_espejoCalentarElCuestionario_', 'fetchQuestions_',
  // 2026-09-23 — el escritor del catálogo apunta ahora su combinación en un índice, y la
  // puerta pública devuelve el catálogo con su versión puesta. No son de lo que este control
  // mide (el TECHO), pero SÍ son funciones que las de arriba llaman: sin ellas el montaje
  // reventaría con un `ReferenceError` y este arnés saldría mudo en vez de rojo.
  '_versionDelCatalogo_', '_conVersionDelCatalogo_',
  '_claveIndiceDelCatalogo_', '_combinacionesDelCatalogo_', '_apuntarCombinacionDelCatalogo_',
];
// Las del TECHO. Que estén o no se decide por el SITIO DONDE SE USA, nunca por la definición.
const DEL_TECHO = ['_claveViajeDelCatalogo_', '_marcarViajeDelCatalogo_', '_quedaTechoDelCatalogo_'];

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
  const m = new RegExp('\\nvar ' + nombre + '\\s*=\\s*(\\d+)\\s*;').exec(src);
  return m ? Number(m[1]) : null;
}

class Ciega extends Error {}

/** Monta el módulo del catálogo con dobles. Devuelve sus funciones y el mando del reloj. */
function montar(src) {
  const faltan = NECESARIAS.filter(n => !extraer(src, n));
  if (faltan.length) throw new Ciega('no están en el fuente: ' + faltan.join(', '));

  const cuerpoEspejo = extraer(src, '_espejoCalentarElCuestionario_');
  const conTecho = cuerpoEspejo.includes('_quedaTechoDelCatalogo_');
  let constantes = 'var CATALOGO_PREGUNTAS_TTL_S_ = ' + (constante(src, 'CATALOGO_PREGUNTAS_TTL_S_') || 0) + ';\n';
  if (!constante(src, 'CATALOGO_PREGUNTAS_TTL_S_')) throw new Ciega('falta CATALOGO_PREGUNTAS_TTL_S_');
  // Las del ÍNDICE de combinaciones (2026-09-23): el escritor del catálogo las usa.
  for (const n of ['CATALOGO_INDICE_TTL_S_', 'CATALOGO_COMBINACIONES_TOPE_']) {
    if (!constante(src, n)) throw new Ciega('falta ' + n);
    constantes += 'var ' + n + ' = ' + constante(src, n) + ';\n';
  }
  let techoS = null;
  if (conTecho) {
    const sinDefinir = DEL_TECHO.filter(n => !extraer(src, n));
    if (sinDefinir.length) {
      throw new Ciega('el refresco LLAMA al techo pero no están: ' + sinDefinir.join(', '));
    }
    techoS = constante(src, 'CATALOGO_PREGUNTAS_TECHO_S_');
    if (!techoS) throw new Ciega('el techo existe pero CATALOGO_PREGUNTAS_TECHO_S_ no');
    constantes += 'var CATALOGO_PREGUNTAS_TECHO_S_ = ' + techoS + ';\n';
  }

  const estado = { reloj: 0, viajes: 0 };
  const almacen = new Map();
  const cache = {
    get: k => { const e = almacen.get(k); if (!e) return null; if (e.expira <= estado.reloj) { almacen.delete(k); return null; } return e.v; },
    put: (k, v, ttl) => { almacen.set(k, { v, expira: estado.reloj + ttl * 1000 }); },
    putAll: (o, ttl) => { for (const k of Object.keys(o)) almacen.set(k, { v: o[k], expira: estado.reloj + ttl * 1000 }); },
    remove: k => { almacen.delete(k); },
    getAll: ks => { const o = {}; for (const k of ks) { const v = cache.get(k); if (v != null) o[k] = v; } return o; },
  };

  const preludio = `
var SCHOOL_ID = 'KIS';
var ESPEJO_CUESTIONARIOS_POR_VUELTA_ = 8;
var CacheService = { getScriptCache: function () { return __cache; } };
var Logger = { log: function () {} };
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
`;
  const cuerpo = constantes + preludio +
    [...NECESARIAS, ...(conTecho ? DEL_TECHO : [])].map(n => extraer(src, n)).join('\n\n') +
    '\nreturn { _espejoCalentarElCuestionario_: _espejoCalentarElCuestionario_,' +
    ' fetchQuestions_: fetchQuestions_,' +
    ' _catalogoDePreguntasDeLaCopia_: _catalogoDePreguntasDeLaCopia_,' +
    ' _guardarCatalogoDePreguntas_: _guardarCatalogoDePreguntas_ };';

  let cuposGastados = 0;
  let catalogoDelKms = { sets: [{ set_id: 's1', designation: 'Uno', items: [{ question: { question_id: 'q1' } }] }] };
  const api = new Function('__cache', '__viaje', '__cupo', '__catalogoDelKms', cuerpo)(
    cache,
    () => { estado.viajes++; },
    () => { cuposGastados++; },
    () => catalogoDelKms,
  );
  return {
    api, conTecho, techoS, estado,
    avanzar: ms => { estado.reloj += ms; },
    cupo: () => cuposGastados,
    ponerCatalogoDelKms: c => { catalogoDelKms = c; },
  };
}

// ── Las afirmaciones ────────────────────────────────────────────────────────────────────
const fallos = [];
const notas  = [];
function afirmar(nombre, condicion, porque) {
  if (condicion) { notas.push('  ✓ ' + nombre); return true; }
  fallos.push(nombre + ' — ' + porque);
  notas.push('  ✗ ' + nombre + '\n      ' + porque);
  return false;
}

const src = fs.readFileSync(FUENTE, 'utf8');
let m;
try {
  m = montar(src);
} catch (e) {
  console.log('MEDICIÓN CIEGA — ' + e.message);
  console.log('VEREDICTO: ROJO — MEDICIÓN CIEGA: ' + e.message);
  process.exit(1);
}

notas.push('fuente: backend/Code.js · techo construido: ' + (m.conTecho ? m.techoS + ' s' : 'NO'));

// (0) El techo tiene que ESTAR. Sin él, lo que se guarda una vez se queda para siempre.
afirmar('(0) el refresco sin viaje tiene TECHO',
  m.conTecho,
  'el repaso del espejo no consulta `_quedaTechoDelCatalogo_`: sin techo, un catálogo guardado ' +
  'una vez se renueva cada 30 min indefinidamente y deja de curarse solo — la regresión de `@297`');

// La medida: el repaso del espejo, vuelta cada 25 min (llega SIEMPRE con la copia viva, que es
// el caso que el refresco sin viaje vino a cubrir; con 30 min exactos caducan a la vez).
const PASO_MS = 25 * 60 * 1000;
const VUELTAS = 24;                    // 10 horas simuladas
const pendientes = { 'p1|es-ES': { program_id: 'p1', lang: 'es-ES' } };
let refrescos = 0, forzados = 0;
const vueltasConViaje = [];
let viajesAntes = 0;
for (let v = 0; v < VUELTAS; v++) {
  const r = m.api._espejoCalentarElCuestionario_(pendientes, () => false);
  refrescos += r.refrescados;
  forzados  += (r.por_techo || 0);
  if (m.estado.viajes > viajesAntes) { vueltasConViaje.push(v); viajesAntes = m.estado.viajes; }
  if (!m.api._catalogoDePreguntasDeLaCopia_('ENROLLMENT', 'es-ES', 'p1')) {
    fallos.push('la copia murió en la vuelta ' + v);
  }
  m.avanzar(PASO_MS);
}
notas.push('  · ' + VUELTAS + ' vueltas de 25 min: refrescos sin viaje=' + refrescos +
           ' · viajes de verdad=' + m.estado.viajes + ' · forzados por techo=' + forzados);

// (1) El ahorro se conserva: la mayoría de las vueltas NO viajan.
afirmar('(1) el refresco sin viaje SIGUE ahorrando',
  refrescos > m.estado.viajes,
  'en ' + VUELTAS + ' vueltas hubo ' + refrescos + ' refrescos sin viaje y ' + m.estado.viajes +
  ' viajes: si el techo obliga a viajar casi siempre, el ahorro que `@297` vino a dar se pierde ' +
  'y el cupo público ②54 —COMPARTIDO por todo el colegio— lo paga el repaso de fondo');

// (2) El techo MUERDE: se vuelve a preguntar de verdad más de una vez.
afirmar('(2) el techo obliga a volver a PREGUNTAR de verdad',
  m.estado.viajes > 1 && forzados >= 1,
  'hubo ' + m.estado.viajes + ' viaje(s) y ' + forzados + ' forzado(s) por techo en 10 horas: ' +
  'con uno solo, el catálogo que se leyó al principio se queda para siempre');

// (3) Y muerde DENTRO del plazo declarado: entre dos lecturas de verdad no puede pasar más
//     que el techo (más la vuelta en la que se detecta).
const huecoMax = vueltasConViaje.length > 1
  ? Math.max(...vueltasConViaje.slice(1).map((v, i) => v - vueltasConViaje[i])) * PASO_MS
  : Infinity;
afirmar('(3) entre dos lecturas de verdad no pasa más que el TECHO',
  m.conTecho && huecoMax <= (m.techoS * 1000 + PASO_MS),
  'el hueco mayor entre dos viajes fue ' + (huecoMax / 60000) + ' min y el techo declarado es ' +
  (m.techoS / 60) + ' min: un catálogo malo duraría más de lo que el techo promete');

// (4) LA COPIA NO SE BORRA PARA PEDIR. Si el viaje falla, lo guardado sigue en pie y la
//     familia no se queda sin cuestionario.
{
  // ⚠️ SE MODELA COMO OCURRE DE VERDAD: el repaso pasa cada 25 min y va manteniendo viva la
  // copia (que dura 30 min por su plazo) hasta que **se acaba el techo**. Saltar el reloj de
  // golpe hasta el techo mata la copia por su propio plazo y mediría otra cosa — ese fue el
  // primer ROJO de este control, y era del control.
  const m2 = montar(src);
  const vueltasHastaElTecho = m2.conTecho ? Math.ceil((m2.techoS * 1000) / PASO_MS) : 1;
  for (let v = 0; v < vueltasHastaElTecho; v++) {
    m2.api._espejoCalentarElCuestionario_(pendientes, () => false);
    m2.avanzar(PASO_MS);
  }
  const vivaAntes = !!m2.api._catalogoDePreguntasDeLaCopia_('ENROLLMENT', 'es-ES', 'p1');
  const viajesAntesDeCaer = m2.estado.viajes;
  // Ahora el KMS se cae, justo en la vuelta en la que el techo obliga a volver a preguntar.
  m2.ponerCatalogoDelKms(() => { throw new Error('KMS caído'); });
  const r2 = m2.api._espejoCalentarElCuestionario_(pendientes, () => false);
  afirmar('(4.0) ancla — la copia llegó VIVA a la vuelta en la que se acaba el techo',
    vivaAntes && (r2.por_techo || 0) >= 1 && m2.estado.viajes > viajesAntesDeCaer,
    'no se llegó a la situación que hay que medir (copia viva=' + vivaAntes + ', forzados=' +
    (r2.por_techo || 0) + '): sin ella lo de abajo pasaría EN VACÍO');
  afirmar('(4) si el viaje FALLA, la copia guardada sigue en pie',
    !!m2.api._catalogoDePreguntasDeLaCopia_('ENROLLMENT', 'es-ES', 'p1'),
    'tras un viaje fallido no queda copia: borrar antes de pedir deja a la familia sin ' +
    'cuestionario cuando el KMS no contesta');
}

// (5) EL CAMINO PÚBLICO NO CAMBIA: `fetchQuestions_(payload)` con UN solo argumento sigue
//     sirviéndose de la copia. Si alguna vez se saltara la copia, cada familia pagaría el
//     viaje y el cupo público ②54 se gastaría en minutos.
{
  const m3 = montar(src);
  m3.api.fetchQuestions_({ context_code: 'ENROLLMENT', language: 'es-ES', program_id: 'p1' });
  const viajesTrasElPrimero = m3.estado.viajes;
  for (let i = 0; i < 5; i++) {
    m3.api.fetchQuestions_({ context_code: 'ENROLLMENT', language: 'es-ES', program_id: 'p1' });
  }
  afirmar('(5) el camino público sigue sirviéndose de la copia (cero viajes de más)',
    m3.estado.viajes === viajesTrasElPrimero,
    'cinco llamadas del camino público costaron ' + (m3.estado.viajes - viajesTrasElPrimero) +
    ' viaje(s) de más: la copia dejó de servir al clic de la familia');
}

// (6) EL CRITERIO DE «CATÁLOGO IMPOSIBLE» NO SE ENSANCHA. Está copiado VERBATIM del KMS
//     (`qb_core_catalogoImposible_`) y dos criterios sobre lo mismo divergen: secciones con
//     CERO preguntas sumando todas NO se guarda; CERO secciones SÍ (colegio sin cuestionario).
{
  const m4 = montar(src);
  const conSeccionesVacias = { sets: [{ set_id: 'a', items: [] }, { set_id: 'b', items: [] }] };
  const sinSecciones       = { sets: [] };
  const unaVaciaYOtraNo    = { sets: [{ set_id: 'a', items: [] },
                                      { set_id: 'b', items: [{ question: { question_id: 'q' } }] }] };
  afirmar('(6.1) secciones con CERO preguntas: NO se guarda',
    m4.api._guardarCatalogoDePreguntas_('ENROLLMENT', 'es', 'p', conSeccionesVacias) === false,
    'se guardó un catálogo con secciones y cero preguntas: es la forma exacta de una lectura ' +
    'a medias y quedaría clavado');
  afirmar('(6.2) CERO secciones: SÍ se guarda',
    m4.api._guardarCatalogoDePreguntas_('ENROLLMENT', 'es', 'p', sinSecciones) !== false,
    'un colegio que aún no ha declarado cuestionario es una respuesta legítima y tiene que ' +
    'poder guardarse');
  afirmar('(6.3) una sección vacía junto a otra con preguntas: SÍ se guarda',
    m4.api._guardarCatalogoDePreguntas_('ENROLLMENT', 'es', 'p2', unaVaciaYOtraNo) !== false,
    'el criterio se ha ensanchado por su cuenta: está copiado VERBATIM del KMS y dos criterios ' +
    'sobre lo mismo divergen. Que una sección salga vacía es configuración del centro, y se ' +
    'arregla en su pantalla — no tirando el catálogo entero');
}

// ── ⛔ Y AHORA SE ROMPE A PROPÓSITO ─────────────────────────────────────────────────────
// Un control que no se ha visto fallar no es una red. Estas tres roturas tienen que salir
// NOMBRADAS; si alguna pasa, es este fichero el que está roto, no el producto.
const roturas = [
  ['renombrar la función del techo',
   s => s.replace('function _quedaTechoDelCatalogo_(', 'function _quedaTechoDelCatalogoXX_('),
   /MEDICIÓN CIEGA|no están/],
  ['renombrar el refresco del espejo',
   s => s.replace('function _espejoCalentarElCuestionario_(', 'function _espejoCalentarElCuestZZ_('),
   /MEDICIÓN CIEGA|no están/],
  ['borrar la constante del techo',
   s => s.replace(/\nvar CATALOGO_PREGUNTAS_TECHO_S_ = \d+;/, '\nvar CATALOGO_PREGUNTAS_OTRO_ = 0;'),
   /MEDICIÓN CIEGA|CATALOGO_PREGUNTAS_TECHO_S_/],
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

// ── Veredicto ───────────────────────────────────────────────────────────────────────────
console.log('EL CATÁLOGO DE PREGUNTAS — el techo del refresco sin viaje');
notas.forEach(n => console.log(n));
if (fallos.length) {
  console.log('VEREDICTO: ROJO — ' + fallos[0] + (fallos.length > 1 ? ' (y ' + (fallos.length - 1) + ' más)' : ''));
  process.exit(1);
}
console.log('VEREDICTO: VERDE — el catálogo guardado no se puede quedar clavado: el refresco sin ' +
  'viaje ahorra, el techo obliga a releer, un viaje fallido no se lleva la copia y el camino ' +
  'público sigue sirviéndose de ella.');
