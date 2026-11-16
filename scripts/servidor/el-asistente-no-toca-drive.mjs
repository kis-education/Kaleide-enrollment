#!/usr/bin/env node
/**
 * EL ASISTENTE NO TOCA DRIVE — control que EJECUTA el servidor.
 * ══════════════════════════════════════════════════════════════════════════════════════
 *
 * `node scripts/servidor/el-asistente-no-toca-drive.mjs`
 * Sin red, sin navegador, sin `npm ci`. Última línea: `VEREDICTO: VERDE` / `ROJO — <motivo>`.
 *
 * QUÉ PROTEGE, en una frase: **que ni un camino vivo de este proceso escriba ni lea Drive, y
 * que su manifiesto se quede SIN ningún permiso de Drive — ni `drive`, ni `drive.file`.**
 *
 * POR QUÉ EXISTE (`CLI 470`, 2026-11-16). El manifiesto declaraba
 * `https://www.googleapis.com/auth/drive` COMPLETO, que es RESTRINGIDO. Diego, 2026-08-11:
 * *«Los únicos scopes que podemos autorizar son sensibles, no restringidos.»* Y su coste no es
 * teórico: un restringido obliga a verificar la aplicación ante Google y a pasar una **auditoría
 * de seguridad ANUAL**, por cada colegio nuevo ⇒ el alta del segundo colegio, que debe ser un
 * botón, se convierte en semanas y un trámite que no depende de nosotros
 * (`kis-app CLAUDE.md` §"RESTRICCIÓN DE DISEÑO — solo scopes SENSIBLES").
 *
 * ⛔ **Y ESTRECHARLO A `drive.file` NO SERVÍA, medido**: la carpeta de destino la DICE el KMS y
 * pertenece al árbol de SU archivo ⇒ el asistente no la creó y con `drive.file` no podría ni
 * abrirla; habría roto TODA subida. La salida no era un permiso más pequeño: era no tener
 * ninguno. Hoy los BYTES viajan al KMS y el fichero lo crea la cuenta licenciada del COLEGIO
 * (DL-R06/DL-S110, por el escritor que ya existía: `rec_uploadWizardDocument_`).
 *
 * CÓMO MIDE — y ésta es la parte que importa: **instala un `DriveApp` que MUERDE.** Cualquier
 * propiedad que se le pida lanza, así que si `uploadDocument_` o `getDocument_` volvieran a
 * tocarlo, este control lo vería al EJECUTARLOS, no leyendo sus líneas. El resto de la cadena
 * (la puerta, el código de un solo uso, el salto al KMS, la caché) va con dobles en memoria.
 *
 * ⚠️ **LO QUE NO AFIRMA:**
 *   · **no habla con el KMS**, así que no dice nada sobre si el KMS acepta la escritura ni sobre
 *     si la cuenta licenciada del centro está autorizada. Eso vive en `kis-app`:
 *     `scripts/servidor/el-escaneo-de-una-familia-es-del-colegio.mjs`.
 *   · **no dice que el Head no lleve `_manual.gs`**: afirma que está DECLARADO en
 *     `backend/.claspignore`, y `clasp push` no borra del Head lo que ya está arriba — eso se
 *     comprueba LEYENDO el Head, a mano, en el paso (3) del ciclo de tres órdenes.
 *   · **no mide el navegador**: eso es `npm run e2e:wizard`.
 *   · **no afirma que un fichero subido ANTES de `CLI 470` se pueda leer**: lo creó otra cuenta
 *     y si la licenciada no lo alcanza, el camino dice `DOC_UNAVAILABLE` — que es honesto y
 *     nombrable, y es la afirmación (12), no un «se lee igual».
 *
 * ⛔ **Y SE HA VISTO FALLAR**: al final se rompe el fuente (y el manifiesto) a propósito y se
 * exige que el control lo NOMBRE, con MEDICIÓN CIEGA ante un renombrado.
 */

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const AQUI = path.dirname(fileURLToPath(import.meta.url));
const RAIZ = path.resolve(AQUI, '..', '..');
// El fuente y el manifiesto por defecto son los del producto. Se admiten otros por argumento
// SOLO para poder romperlos a propósito y ver este control en ROJO — en CI va sin argumentos.
const FUENTE     = process.argv[2] ? path.resolve(process.argv[2]) : path.join(RAIZ, 'backend', 'Code.js');
const MANIFIESTO = process.argv[3] ? path.resolve(process.argv[3]) : path.join(RAIZ, 'backend', 'appsscript.json');
const CLASPIGNORE = path.join(RAIZ, 'backend', '.claspignore');

// Las que deciden este camino. Si falta una, no se mide nada: MEDICIÓN CIEGA.
const NECESARIAS = [
  'sha256Hex_', '_tipoDeDocumentoElegido_', '_veredictoDeLaSubida_',
  '_ficheroDelExpediente_', 'uploadDocument_', 'getDocument_',
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

/** El fuente sin comentarios — para que una MENCIÓN a `DriveApp` en una explicación no cuente. */
function sinComentarios(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, ' ')
    .split('\n').map(l => l.replace(/(^|[^:\\])\/\/.*$/, '$1')).join('\n');
}

const BYTES_PDF = Buffer.concat([Buffer.from('%PDF-1.4\n'), Buffer.from('ZZ_ARNES_CLI470_sintetico\n')]);
const B64_PDF   = BYTES_PDF.toString('base64');

/**
 * Monta los manejadores REALES con dobles. `DriveApp` MUERDE: cualquier acceso lanza y queda
 * apuntado, que es la forma de ver con EJECUCIÓN lo que un `grep` solo vería en líneas.
 */
function montar(src) {
  const faltan = NECESARIAS.filter(n => !extraer(src, n));
  if (faltan.length) throw new Ciega('no están en el fuente: ' + faltan.join(', '));

  const estado = {
    driveTocado: [],          // qué propiedad de DriveApp se pidió (debe quedar VACÍO)
    llamadasKms: [],          // { accion, payload }
    cacheEscrita: [],
  };

  // ⛔ El doble de `DriveApp`: un Proxy que lanza ante CUALQUIER propiedad. No basta con dejar
  // la variable sin definir (un `ReferenceError` también se nota, pero no diría QUÉ se pidió).
  const DriveApp = new Proxy({}, {
    get(_t, prop) {
      estado.driveTocado.push(String(prop));
      throw new Error('ARNES: se tocó DriveApp.' + String(prop));
    },
  });

  let respuestaDelKms = {};
  let respuestaDeFirma = { base64: 'ZmlybWE=', mime_type: 'application/pdf', filename: 'carta.pdf' };
  let tokenDeFirma = null;          // null ⇒ no hay paquete de firma resoluble
  let elKmsLanza = null;

  const almacen = new Map();
  const cache = {
    get: k => (almacen.has(k) ? almacen.get(k) : null),
    put: (k, v) => { almacen.set(k, v); },
    putAll: (o) => { for (const k of Object.keys(o)) almacen.set(k, o[k]); },
    getAll: ks => { const o = {}; for (const k of ks) if (almacen.has(k)) o[k] = almacen.get(k); return o; },
    remove: k => { almacen.delete(k); },
  };

  const preludio = `
var SCHOOL_ID = 'KIS';
var DriveApp = __DriveApp;
var _SUBIDA_MEMO_ = {};
var Logger = { log: function () {} };
var CacheService = { getScriptCache: function () { return __cache; } };
var Utilities = {
  base64Decode: function (s) { return __decode(s); },
  base64Encode: function (b) { return __encode(b); },
  newBlob: function () { throw new Error('ARNES: newBlob no debería hacer falta ya'); },
  computeDigest: function (_alg, b) { return __digest(b); },
  DigestAlgorithm: { SHA_256: 'SHA_256' },
};
function redact_(s) { return String(s); }
function generateUuid_() { return '11111111-2222-3333-4444-555555555555'; }
function assertValidUuid_(v, campo) {
  if (!/^[0-9a-fA-F-]{36}$/.test(String(v || ''))) { var e = new Error('uuid ' + campo); e.code = 'BAD_REQUEST'; throw e; }
}
function assertValidFileIdForRead_(v, campo) {
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(String(v || ''))) { var e = new Error('file_id ' + campo); e.code = 'BAD_REQUEST'; throw e; }
}
function requireResumeToken_(p) { __puerta(p); return __GRUPO; }
function requireResumeTokenMemo_(p) { __puerta(p); return __GRUPO; }
function requireSigningToken_() { throw new Error('ARNES: este control no entra por signing_token'); }
function assertGroupEditable_() {}
function assertStepUpFresh_() {}
function _identidadDelEnlace_() { return 'tutor@example.invalid'; }
function _huellaDePagina_() { return 'pv-1'; }
function _discriminadorDeMarca_() { return ''; }
function _wzCacheInvalidate_() {}
function _wzCacheKey_(kind, suffix) { return 'wz_' + kind + '_' + suffix; }
function _wzCachePutChunked_(c, key, serialized) { __cacheEscrita(key, serialized); return true; }
function _wzCacheGetChunked_() { return null; }
function _memoSubidaClave_(t, s) { return String(t) + '|' + JSON.stringify(s || {}); }
function _duenosDelDocumento_() { return []; }
function _hijoElegidoDelPayload_() { return null; }
function effectiveRecoveredEmail_() { return 'tutor@example.invalid'; }
function resolveGuardianForRecovery_() { return 'persona-1'; }
function _claveMemoTokenDeFirma_() { return 'memo-firma'; }
function _datosDeFirmaDelExpediente_() { return __tokenDeFirma() ? { sessions: [], signersBySession: {} } : null; }
function resolveGuardianSigningContext_() { return { signing_token: __tokenDeFirma() }; }
function kmsProxy_(accion, payload) { return __kms(accion, payload); }
`;

  const cuerpo = preludio +
    NECESARIAS.map(n => extraer(src, n)).join('\n\n') +
    '\nreturn {' + NECESARIAS.map(n => n + ': ' + n).join(', ') + '};';

  const GRUPO = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee';
  const api = new Function(
    '__DriveApp', '__cache', '__decode', '__encode', '__digest', '__puerta', '__GRUPO',
    '__kms', '__cacheEscrita', '__tokenDeFirma', cuerpo,
  )(
    DriveApp, cache,
    s => Array.from(Buffer.from(String(s), 'base64')),
    b => Buffer.from(b).toString('base64'),
    b => Array.from(crypto.createHash('sha256')
      .update(typeof b === 'string' ? Buffer.from(b) : Buffer.from(b)).digest()),
    () => {},
    GRUPO,
    (accion, payload) => {
      estado.llamadasKms.push({ accion: accion, payload: payload });
      if (elKmsLanza) { const e = new Error('KMS caído'); e.code = elKmsLanza; throw e; }
      if (accion === 'enr.serveSigningDocument') return respuestaDeFirma;
      if (accion === 'enr.ficheroDelExpediente') return respuestaDelKms;
      return respuestaDelKms;
    },
    (key, serialized) => { estado.cacheEscrita.push({ key: key, serialized: serialized }); },
    () => tokenDeFirma,
  );

  return {
    api, estado, GRUPO, B64_PDF,
    ponRespuestaDelKms: r => { respuestaDelKms = r; },
    ponTokenDeFirma:    t => { tokenDeFirma = t; },
    ponRespuestaDeFirma: r => { respuestaDeFirma = r; },
    kmsLanza: c => { elKmsLanza = c; },
    limpiar: () => { estado.driveTocado.length = 0; estado.llamadasKms.length = 0; estado.cacheEscrita.length = 0; },
  };
}

/** El payload de una subida de la familia, con bytes de PDF de verdad (número mágico incluido). */
function subidaDeEjemplo() {
  return {
    resume_token: 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee',
    upload_idempotency_token: '99999999-8888-7777-6666-555555555555',
    base64: B64_PDF,
    mimeType: 'application/pdf',
    filename: 'informe.pdf',
    description: 'informe del médico',
  };
}

/** Los permisos de Drive que el manifiesto NO puede declarar — ninguno, ni el estrecho. */
function permisosDeDriveEn(textoManifiesto) {
  let m;
  try { m = JSON.parse(textoManifiesto); } catch (e) { throw new Ciega('el manifiesto no se puede leer como JSON'); }
  if (!Array.isArray(m.oauthScopes)) throw new Ciega('el manifiesto no declara `oauthScopes`');
  return m.oauthScopes.filter(s => /\/auth\/drive(\.|$)/.test(String(s)));
}

// ── Las afirmaciones ────────────────────────────────────────────────────────────────────
const fallos = [];
const notas  = [];
let total = 0;
function afirmar(nombre, condicion, porque) {
  total++;
  if (condicion) { notas.push('  ✓ ' + nombre); return true; }
  fallos.push(nombre + ' — ' + porque);
  notas.push('  ✗ ' + nombre + '\n      ' + porque);
  return false;
}

let salida = 0;
try {
  const src = fs.readFileSync(FUENTE, 'utf8');
  const textoManifiesto = fs.readFileSync(MANIFIESTO, 'utf8');

  let m;
  try {
    m = montar(src);
  } catch (e) {
    if (e instanceof Ciega) throw new Error('MEDICIÓN CIEGA — ' + e.message);
    throw e;
  }

  // ── (0) EL CANARIO: que el doble de DriveApp se vería si alguien lo tocara ─────────────
  // Sin esto, todas las afirmaciones de «no tocó Drive» podrían estar pasando EN VACÍO
  // (un doble mal instalado, un `Proxy` que no muerde) y el control saldría verde sin medir.
  {
    let mordio = false;
    try {
      // Mismo doble, ejercitado a mano: pedirle una propiedad tiene que LANZAR y QUEDAR APUNTADO.
      const antes = m.estado.driveTocado.length;
      try { new Function('D', 'return D.getFolderById;')(
        new Proxy({}, { get(_t, p) { m.estado.driveTocado.push(String(p)); throw new Error('canario'); } }));
      } catch (_e) { /* esperado */ }
      mordio = m.estado.driveTocado.length === antes + 1;
    } catch (_e) { mordio = false; }
    if (!afirmar('(0) el detector de `DriveApp` MUERDE (canario)', mordio,
      'un acceso a DriveApp no quedó apuntado ⇒ todas las afirmaciones de «no tocó Drive» ' +
      'estarían pasando en vacío')) {
      throw new Error('MEDICIÓN CIEGA — el detector de DriveApp no funciona');
    }
    m.limpiar();
  }

  // ── (1) SUBIR: ni un acceso a Drive, y los BYTES viajan al KMS ────────────────────────
  m.ponRespuestaDelKms({ ok: true, file_persisted: true, scope_persisted: null,
                         personas_pedidas: 0, personas_persisted: null, bytes_recibidos: true,
                         file_id: '11111111-2222-3333-4444-555555555555' });
  let subida = null, errSubida = null;
  try { subida = m.api.uploadDocument_(subidaDeEjemplo()); } catch (e) { errSubida = e; }

  afirmar('(1) subir un documento NO toca Drive (ejecutado)',
    !errSubida && m.estado.driveTocado.length === 0,
    errSubida ? ('`uploadDocument_` lanzó: ' + errSubida.message)
              : ('tocó DriveApp.' + m.estado.driveTocado.join(', DriveApp.')));

  const envio = m.estado.llamadasKms.find(c => c.accion === 'enr.persistUploadedDocument');
  afirmar('(2) los BYTES viajan al KMS en el MISMO viaje que la ficha',
    !!envio && envio.payload && envio.payload.base64 === B64_PDF && !!envio.payload.rec_file,
    'el envío a `enr.persistUploadedDocument` no lleva `base64` junto a `rec_file`: sin eso el ' +
    'documento de la familia se queda SIN CONTENIDO, porque este proceso ya no puede guardarlo');

  afirmar('(3) ya no se pregunta por la carpeta: sería un viaje para tirar la respuesta',
    !m.estado.llamadasKms.some(c => c.accion === 'enr.carpetaDelArchivo'),
    'sigue llamando a `enr.carpetaDelArchivo`, que es un salto al KMS (~15 s en el camino de una ' +
    'familia) para obtener un destino que este proceso no puede usar');

  afirmar('(4) la ficha NO declara dónde aterriza el byte',
    !!envio && envio.payload.rec_file &&
      !('drive_file_id' in envio.payload.rec_file) && !('drive_folder_id' in envio.payload.rec_file),
    'la metadata sigue mandando `drive_file_id`/`drive_folder_id`: el destino lo decide el KMS, y ' +
    'obedecer uno que venga de una entrada pública sería dejar elegir dónde acaba el papel');

  afirmar('(5) el expediente sigue saliendo del enlace (KAL-4) y el envío devuelve lo escrito',
    !!subida && subida.file_id === '11111111-2222-3333-4444-555555555555' &&
      subida.document_id === subida.file_id &&
      !!envio && envio.payload.resume_token === m.GRUPO,
    'el identificador devuelto no es el que el KMS dice haber escrito, o el enlace no viaja: la ' +
    'rama idempotente del escritor devuelve la ficha que YA existía y la fila del paso 6 tiene ' +
    'que apuntar a ÉSA');

  // ── (6) SIN BYTE NO SE CONFIRMA: el peor desenlace se NOMBRA ──────────────────────────
  for (const [caso, resp] of [
    ['el KMS dice que no pudo guardar el byte', { ok: true, file_persisted: true, bytes_recibidos: false }],
    ['un KMS que todavía no conoce el campo',   { ok: true, file_persisted: true }],
  ]) {
    m.limpiar();
    m.ponRespuestaDelKms(resp);
    let err = null, ok = null;
    try { ok = m.api.uploadDocument_(subidaDeEjemplo()); } catch (e) { err = e; }
    afirmar('(6) ' + caso + ' ⇒ se NOMBRA, no se confirma',
      !ok && !!err && err.code === 'DOCUMENTO_SIN_CONTENIDO',
      'el manejador contestó ' + JSON.stringify(ok || (err && err.code)) + ': confirmarle a una ' +
      'familia un documento sin contenido es el éxito falso que este cambio no puede introducir');
  }

  // ── (7) LEER: ni un acceso a Drive, y los bytes vienen del KMS ────────────────────────
  m.limpiar();
  const SHA = crypto.createHash('sha256').update(BYTES_PDF).digest('hex');
  m.ponRespuestaDelKms({ ok: true, fichero: {
    file_id: 'ffffffff-0000-1111-2222-333333333333',
    drive_file_id: 'drive-xyz',
    file_name: 'informe.pdf',
    mime_type: 'application/pdf',
    base64: B64_PDF, sha256: SHA, size_bytes: BYTES_PDF.length,
  } });
  let leido = null, errLeido = null;
  try {
    leido = m.api.getDocument_({ resume_token: m.GRUPO, file_id: 'ffffffff-0000-1111-2222-333333333333' });
  } catch (e) { errLeido = e; }

  afirmar('(7) servir un documento NO toca Drive (ejecutado)',
    !errLeido && m.estado.driveTocado.length === 0,
    errLeido ? ('`getDocument_` lanzó: ' + errLeido.message)
             : ('tocó DriveApp.' + m.estado.driveTocado.join(', DriveApp.')));

  const lectura = m.estado.llamadasKms.find(c => c.accion === 'enr.ficheroDelExpediente');
  afirmar('(8) los bytes se PIDEN al KMS (`con_bytes`), sin un viaje más',
    !!lectura && lectura.payload.con_bytes === true &&
      m.estado.llamadasKms.filter(c => c.accion === 'enr.ficheroDelExpediente').length === 1,
    'no se piden los bytes con la ficha, o se piden en un segundo viaje: este proceso ya no puede ' +
    'leer Drive, así que sin `con_bytes` el visor del paso 6 se queda sin documento');

  afirmar('(9) lo que se sirve es byte a byte lo que mandó el KMS, con la forma de siempre',
    !!leido && leido.base64 === B64_PDF && leido.sha256 === SHA &&
      leido.size_bytes === BYTES_PDF.length &&
      leido.mimeType === 'application/pdf' && leido.mime_type === 'application/pdf' &&
      leido.filename === 'informe.pdf',
    'la respuesta cambió de forma o de contenido: los seis campos del contrato DOC-BYTES ' +
    '(`filename`/`mimeType`/`mime_type`/`base64`/`sha256`/`size_bytes`) los lee el navegador');

  afirmar('(10) el nombre que sale NO es un identificador de máquina',
    !!leido && !/^[0-9a-f]{8}-[0-9a-f]{4}/i.test(String(leido.filename || '')) &&
      !String(leido.filename || '').includes('__'),
    'el nombre servido lleva el identificador de la ficha por delante (DL-R01): eso es lo que la ' +
    'familia lee, y un UUID a la vista es el defecto que `principios.md` base 1 prohíbe');

  afirmar('(11) la copia caliente se escribe con el grupo DENTRO (post-puerta)',
    m.estado.cacheEscrita.length === 1 &&
      JSON.parse(m.estado.cacheEscrita[0].serialized).g === m.GRUPO,
    'no se guardó la copia del documento, o se guardó sin el grupo de origen: sin el grupo, una ' +
    'entrada de otra familia sería un ACIERTO de caché en vez de un fallo');

  // ── (12) LOS BYTES QUE NO LLEGAN: la cadena de respaldo de siempre, sin disfraces ─────
  // ⛔ CADA CASO EN SU PROPIO MONTAJE, y no es ceremonia: `getDocument_` MEMOIZA el
  // `signing_token` que resuelve (`_claveMemoTokenDeFirma_`, 300 s), así que compartir la caché
  // entre los dos casos le servía al segundo el token del primero — y el control salía ROJO
  // acusando al producto de algo que había hecho el propio arnés. *(Pasó al escribirlo.)*
  for (const [caso, token, esperado] of [
    ['con paquete de firma resoluble', 'tok-firma', 'FIRMA'],
    ['sin ningún token de firma',       null,        'DOC_UNAVAILABLE'],
  ]) {
    const m = montar(src);
    m.ponTokenDeFirma(token);
    m.ponRespuestaDelKms({ ok: true, fichero: {
      file_id: 'ffffffff-0000-1111-2222-333333333333',
      drive_file_id: 'drive-xyz', file_name: 'informe.pdf', mime_type: 'application/pdf',
      bytes_error: 'LICENSED_ACCOUNT_NOT_AUTHORIZED',
    } });
    let r = null, e2 = null;
    try {
      r = m.api.getDocument_({ resume_token: m.GRUPO, file_id: 'ffffffff-0000-1111-2222-333333333333' });
    } catch (e) { e2 = e; }
    const bien = esperado === 'FIRMA'
      ? (!!r && r.base64 === 'ZmlybWE=' && m.estado.driveTocado.length === 0)
      : (!r && !!e2 && e2.code === 'DOC_UNAVAILABLE' && m.estado.driveTocado.length === 0);
    afirmar('(12) el KMS no pudo traer los bytes, ' + caso + ' ⇒ la cadena de siempre',
      bien,
      'el desenlace fue ' + JSON.stringify(r ? 'bytes' : (e2 && e2.code)) + ' y se esperaba ' +
      esperado + ': un fallo de lectura no puede disfrazarse de «no es tuyo» (`UNAUTHORIZED`) ' +
      'ni de documento vacío, y nunca puede volver a caer en Drive');
  }

  // ── (13) EL MANIFIESTO: ni un permiso de Drive, tampoco el estrecho ───────────────────
  {
    let deDrive = null, ciego = null;
    try { deDrive = permisosDeDriveEn(textoManifiesto); }
    catch (e) { ciego = e instanceof Ciega ? e.message : String(e.message); }
    if (ciego) throw new Error('MEDICIÓN CIEGA — ' + ciego);
    afirmar('(13) el manifiesto no declara NINGÚN permiso de Drive',
      deDrive.length === 0,
      'sigue declarando ' + JSON.stringify(deDrive) + '. `drive` es RESTRINGIDO (auditoría ANUAL ' +
      'por colegio nuevo) y `drive.file` no sirve aquí, medido: la carpeta de destino la crea el ' +
      'KMS, así que este proceso no la alcanzaría');
  }

  // ── (14) NI UNA LLAMADA A DriveApp EN EL FUENTE QUE VIAJA ─────────────────────────────
  // Afirmación por LÍNEAS, y se dice: las (1)/(7) ejecutan DOS manejadores, y ésta cubre los
  // demás caminos del fichero —un disparador, el repaso de fondo— que este control no ejecuta.
  {
    const limpia = sinComentarios(src);
    const usos = (limpia.match(/\bDriveApp\s*\./g) || []).length;
    afirmar('(14) `Code.js` no lleva ni una llamada a `DriveApp` (fuera de comentarios)',
      usos === 0,
      'quedan ' + usos + ' usos de `DriveApp`: lo que viaja al proyecto obliga al permiso, y las ' +
      'sondas de diagnóstico viven en `_manual.gs`, que no viaja');
  }

  // ── (15) Y LA SONDA SIGUE DECLARADA FUERA DEL PROYECTO ────────────────────────────────
  {
    let ignorado = '';
    try { ignorado = fs.readFileSync(CLASPIGNORE, 'utf8'); }
    catch (_e) { throw new Error('MEDICIÓN CIEGA — no se pudo leer `backend/.claspignore`'); }
    afirmar('(15) `_manual.gs` sigue DECLARADO fuera del proyecto',
      /^_manual\.gs\s*$/m.test(ignorado),
      'la sonda del umbral de bytes usa `DriveApp` y vive ahí: si `_manual.gs` vuelve a viajar, ' +
      'el proyecto vuelve a necesitar el permiso de Drive **sin que nada falle**');
  }

  // ── ROTURAS DEMOSTRADAS ───────────────────────────────────────────────────────────────
  // (a) de MONTAJE: un renombrado tiene que salir MEDICIÓN CIEGA, nunca verde.
  const roturasDeMontaje = [
    ['renombrar `uploadDocument_`',
      s => s.replace('\nfunction uploadDocument_(', '\nfunction uploadDocumentoQQ_('),
      /MEDICIÓN CIEGA|no están/],
    ['renombrar `getDocument_`',
      s => s.replace('\nfunction getDocument_(', '\nfunction getDocumentoQQ_('),
      /MEDICIÓN CIEGA|no están/],
    ['renombrar `_veredictoDeLaSubida_`',
      s => s.replace('\nfunction _veredictoDeLaSubida_(', '\nfunction _veredictoQQ_('),
      /MEDICIÓN CIEGA|no están/],
  ];
  roturasDeMontaje.forEach(([nombre, romper, esperado]) => {
    const roto = romper(src);
    if (roto === src) {
      afirmar('(R) la rotura «' + nombre + '» se aplica de verdad', false,
        'el texto que esta rotura buscaba ya no está en el fuente: pasaría EN VACÍO');
      return;
    }
    let salto = null;
    try { montar(roto); } catch (e) { salto = e instanceof Ciega ? ('MEDICIÓN CIEGA — ' + e.message) : String(e.message); }
    afirmar('(R) rota a propósito «' + nombre + '» ⇒ el control lo NOMBRA',
      !!salto && esperado.test(salto),
      'al romper eso el control dijo ' + JSON.stringify(salto) + ' y tenía que nombrarlo: una ' +
      'comprobación que no se ha visto fallar no protege nada');
  });

  // (b) VIVAS: tienen que poner ROJA su afirmación, no cegar el arnés.
  const roturasVivas = [
    ['que subir vuelva a crear el fichero con `DriveApp`',
      s => s.replace('  const fileId        = generateUuid_();\n  const now           = new Date().toISOString();',
                     '  const folderQQ = DriveApp.getFolderById("x");\n  const fileId        = generateUuid_();\n  const now           = new Date().toISOString();'),
      mm => {
        mm.ponRespuestaDelKms({ ok: true, file_persisted: true, bytes_recibidos: true });
        try { mm.api.uploadDocument_(subidaDeEjemplo()); } catch (_e) { /* se espera que lance */ }
        return mm.estado.driveTocado.length > 0;
      }],
    ['que subir deje de mandar los BYTES',
      s => s.replace('    base64:              base64,\n', ''),
      mm => {
        mm.ponRespuestaDelKms({ ok: true, file_persisted: true, bytes_recibidos: true });
        try { mm.api.uploadDocument_(subidaDeEjemplo()); } catch (_e) {}
        const e = mm.estado.llamadasKms.find(c => c.accion === 'enr.persistUploadedDocument');
        return !e || !e.payload.base64;
      }],
    ['que el veredicto deje de mirar si hubo byte',
      s => s.replace('  if (r.bytes_recibidos !== true) {', '  if (false) {'),
      mm => {
        mm.ponRespuestaDelKms({ ok: true, file_persisted: true, bytes_recibidos: false });
        let confirmo = false;
        try { confirmo = !!mm.api.uploadDocument_(subidaDeEjemplo()); } catch (_e) {}
        return confirmo;   // confirmó una subida SIN contenido ⇒ la afirmación (6) caería
      }],
    ['que leer deje de pedir los bytes (`con_bytes`)',
      s => s.replace('_ficheroDelExpediente_(p && p.resume_token, fileId, true)',
                     '_ficheroDelExpediente_(p && p.resume_token, fileId)'),
      mm => {
        mm.ponRespuestaDelKms({ ok: true, fichero: { file_id: 'f', drive_file_id: 'd',
          file_name: 'x.pdf', mime_type: 'application/pdf', base64: B64_PDF } });
        try { mm.api.getDocument_({ resume_token: mm.GRUPO, file_id: 'ffffffff-0000-1111-2222-333333333333' }); } catch (_e) {}
        const l = mm.estado.llamadasKms.find(c => c.accion === 'enr.ficheroDelExpediente');
        return !l || l.payload.con_bytes !== true;
      }],
    ['que leer vuelva a caer en `DriveApp` cuando el KMS no trae bytes',
      s => s.replace('  // Los bytes NO llegaron (el KMS no los pudo traer:',
                     '  if (!row.base64) { DriveApp.getFileById(row.drive_file_id); }\n  // Los bytes NO llegaron (el KMS no los pudo traer:'),
      mm => {
        mm.ponRespuestaDelKms({ ok: true, fichero: { file_id: 'f', drive_file_id: 'd',
          file_name: 'x.pdf', mime_type: 'application/pdf', bytes_error: 'X' } });
        try { mm.api.getDocument_({ resume_token: mm.GRUPO, file_id: 'ffffffff-0000-1111-2222-333333333333' }); } catch (_e) {}
        return mm.estado.driveTocado.length > 0;
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

  // (c) EL MANIFIESTO roto a propósito — las DOS formas, porque `drive.file` también es un no.
  [['drive', 'https://www.googleapis.com/auth/drive'],
   ['drive.file', 'https://www.googleapis.com/auth/drive.file']].forEach(([nombre, scope]) => {
    const roto = textoManifiesto.replace(
      '"https://www.googleapis.com/auth/script.scriptapp"',
      '"' + scope + '",\n    "https://www.googleapis.com/auth/script.scriptapp"');
    if (roto === textoManifiesto) {
      afirmar('(R) la rotura del manifiesto «' + nombre + '» se aplica de verdad', false,
        'el manifiesto ya no tiene el permiso sobre el que se apoyaba esta rotura: pasaría EN VACÍO');
      return;
    }
    let deDrive = [];
    try { deDrive = permisosDeDriveEn(roto); } catch (_e) { deDrive = ['(ilegible)']; }
    afirmar('(R) manifiesto con «' + nombre + '» ⇒ el control lo NOMBRA',
      deDrive.length > 0,
      'con ese permiso declarado el control no lo vio: `drive` es restringido y `drive.file` no ' +
      'alcanza la carpeta del archivo del KMS — los dos tienen que salir rojos');
  });

  // ── Veredicto ─────────────────────────────────────────────────────────────────────────
  console.log('EL ASISTENTE NO TOCA DRIVE');
  notas.forEach(n => console.log(n));
  if (fallos.length) {
    console.log('VEREDICTO: ROJO — ' + fallos[0] + (fallos.length > 1 ? ' (y ' + (fallos.length - 1) + ' más)' : ''));
    salida = 1;
  } else {
    console.log('VEREDICTO: VERDE — ' + total + ' afirmaciones: subir y servir un documento se ' +
      'ejecutan con un `DriveApp` que muerde y no lo tocan, los bytes viajan al KMS en el mismo ' +
      'viaje que la ficha, una subida sin contenido se NOMBRA en vez de confirmarse, y el ' +
      'manifiesto no declara ningún permiso de Drive.');
  }
} catch (eFatal) {
  console.log('VEREDICTO: ROJO — el propio arnés reventó: ' + ((eFatal && eFatal.message) || eFatal));
  salida = 1;
} finally {
  process.exit(salida);
}
