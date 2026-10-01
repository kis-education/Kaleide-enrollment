#!/usr/bin/env node
/**
 * EL ASISTENTE REHACE LA COPIA DE UNA SOLICITUD — control que EJECUTA el servidor.
 * ══════════════════════════════════════════════════════════════════════════════════════
 *
 * `node scripts/servidor/el-asistente-rehace-la-copia-de-una-solicitud.mjs`
 * Sin red, sin navegador, sin `npm ci`. Última línea: `VEREDICTO: VERDE` / `ROJO — <motivo>`.
 *
 * QUÉ PROTEGE, en una frase: **que un aviso del KMS que llega PELADO —sin la copia dentro—
 * deje igualmente la copia caliente al día, y que hacerlo no pueda dejar a NINGÚN tutor sin
 * la suya.**
 *
 * POR QUÉ EXISTE. Hoy, cuando el colegio toca una solicitud, el KMS tiene que CALCULAR la
 * copia entera y mandarla dentro del aviso (`copias`). Eso va a dejar de poder hacerse, y
 * entonces el aviso llegará pelado: hasta ahora eso significaba «solo bump» y el tutor pagaba
 * el viaje entero al entrar. Desde hoy el asistente mira SU índice de parejas calientes
 * (`_parejasDeLasCopias_`, que escribe el escritor ÚNICO `_espejoGuardarCopia_`) y se pide las
 * que le constan por el camino que ya usa el camino vivo (`enr.hydrateApplication`).
 *
 * ⛔⛔ **LA BARANDILLA QUE MANDA SOBRE TODO LO DEMÁS, y son las afirmaciones (5) y (6):
 * NADIE SE QUEDA SIN SU COPIA.** Se pide la nueva y **solo si llega** sustituye a la vieja.
 * Una copia vieja es peor que una nueva solo en velocidad; NINGUNA copia es peor siempre.
 *
 * ⛔ **Y ES ADITIVO**: con `copias` en el aviso el comportamiento tiene que ser el de hoy,
 * byte a byte — afirmación (4).
 *
 * CÓMO MIDE. Carga `backend/Code.js` REAL entero en un `vm` con dobles en memoria y llama a
 * las funciones de verdad —`notifyLiveStateChange_`, `_espejoGuardarCopia_`,
 * `_laSolicitudCambioEnElColegio_`, `hydrateSession_`—. No copia ni una línea de lógica: si
 * la función cambia, este control mide la nueva. Los datos son sintéticos y los correos van
 * en el dominio reservado `.invalid` (RFC 2606).
 *
 * ⚠️ **LO QUE NO AFIRMA, dicho sin adornar:**
 *   · **No habla con el KMS**, así que no dice nada sobre si el KMS manda el aviso pelado
 *     (eso es la SEGUNDA MITAD, y vive en `kis-app kms-server/`), ni sobre lo que devuelve
 *     `enr.hydrateApplication` de verdad, ni sobre cuánto tarda un viaje.
 *   · **Dobla `verifySignedKmsNotice_`**: la firma, la ventana y la no-repetición del canal
 *     son de `comprobar-receptor-firmado`, no de aquí.
 *   · **No dice nada de lo que pinta el navegador**: eso es la batería (`npm run e2e:wizard`).
 *
 * ⛔ **Y SE HA VISTO FALLAR**: al final se rompe el fuente a propósito y se exige que el
 * control lo NOMBRE, con la guarda de MEDICIÓN CIEGA para los renombrados.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// ── Datos SINTÉTICOS. Ni un dato real; dominio reservado (RFC 2606). ────────────────────
const GID_A   = '11111111-1111-4111-8111-111111111111'
const GID_B   = '99999999-9999-4999-8999-999999999999'
const TOKEN_A = '22222222-2222-4222-8222-222222222222'
const TOKEN_B = '88888888-8888-4888-8888-888888888888'
const N1      = '33333333-3333-4333-8333-333333333333'   // el `email_id` del tutor 1
const N2      = '44444444-4444-4444-8444-444444444444'   // el `email_id` del tutor 2
const C1      = 'tutor1@example.invalid'
const C2      = 'tutor2@example.invalid'

/** Una copia caliente sintética de UN tutor de UN expediente. `marca` dice de qué pasada es. */
function copia (gid, token, n, correo, marca) {
  return {
    group: {
      enrollment_group_id: gid, resume_token: token, primary_email: correo,
      requester_person_id: 'p-' + n, submitted_at: null, abandoned_at: null,
      created_at: new Date().toISOString(), program_id: 'prog-1',
    },
    persons: [{ person_id: 'p-' + n, person_type_id: 'guardian',
                emails: [{ email_id: n, value: correo }] }],
    relations: [], documents: [], responses: [], enrollments: [],
    lookups: {}, billing_splits: { payers: [], per_participant: [] },
    live_version: 1, marca: marca,
  }
}

// ── El banco de pruebas: el fuente REAL en un vm con dobles ─────────────────────────────
function cargar (fuente) {
  const cache = new Map()
  const viajes = []
  const ctx = {
    console: { log () {}, error () {} },
    Logger: { log () {} },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (cache.has(k) ? cache.get(k) : null),
        put: (k, v) => { cache.set(k, String(v)) },
        putAll: (o) => { Object.keys(o).forEach((k) => cache.set(k, String(o[k]))) },
        getAll: (ks) => { const o = {}; ks.forEach((k) => { if (cache.has(k)) o[k] = cache.get(k) }); return o },
        remove: (k) => { cache.delete(k) },
      }),
    },
    PropertiesService: { getScriptProperties: () => ({ getProperty: () => null, setProperty () {} }) },
    // ⛔ Sin red: si algo intenta salir, revienta y se ve.
    UrlFetchApp: { fetch () { throw new Error('el arnés no sale a la red') },
                   fetchAll () { throw new Error('el arnés no sale a la red') } },
    ScriptApp: { getOAuthToken: () => 'x', getService: () => ({ getUrl: () => 'https://x/exec' }),
                 getProjectTriggers: () => [] },
    Utilities: {
      getUuid: () => '55555555-5555-4555-8555-555555555555',
      base64EncodeWebSafe: (s) => Buffer.from(String(s)).toString('base64url'),
      computeDigest: (s) => Array.from(Buffer.from(String(s))),
      DigestAlgorithm: { SHA_256: 1 }, Charset: { UTF_8: 1 },
      sleep () {}, formatDate: () => '2026-01-01',
      newBlob: (s) => ({ getBytes: () => Array.from(Buffer.from(String(s))) }),
    },
    Session: { getActiveUser: () => ({ getEmail: () => '' }), getScriptTimeZone: () => 'UTC' },
  }
  vm.createContext(ctx)
  vm.runInContext(fuente, ctx, { filename: 'backend/Code.js' })

  // ── Dobles de las PUERTAS (no de lo que se mide) ──────────────────────────────────────
  // ⚠️ La firma del canal NO es cosa de este arnés (`comprobar-receptor-firmado`). Aquí se
  // dobla para poder EJECUTAR el receptor; lo que se mide es lo que el receptor DECIDE.
  let evento = null
  ctx.verifySignedKmsNotice_ = () => (evento ? { ok: true, event: evento } : { ok: false })
  ctx.requireResumeToken_     = () => GID_A
  ctx.requireResumeTokenMemo_ = () => GID_A
  ctx._identidadDelEnlace_    = () => C1
  ctx.effectiveRecoveredEmail_ = () => C1
  ctx.wizardResolverPreguntasDeHidratacion_ = () => {}
  ctx._redactSigningTokenIfNotFresh_ = (x) => x
  ctx._expedienteDelToken_ = () => ({ ok: true, fila: { enrollment_group_id: GID_A, resume_token: TOKEN_A, primary_email: C1 } })

  // EL CONTADOR DE VIAJES — lo único que sustituye al KMS, y devuelve SU verdad.
  let queDevuelveElKms = (accion, cuerpo) => {
    const t = String((cuerpo && cuerpo.resume_token) || '')
    if (t === TOKEN_B) return copia(GID_B, TOKEN_B, N2, C2, 'NUEVA')
    const n = String((cuerpo && cuerpo.recovered_email) || '') === C2 ? N2 : N1
    return copia(GID_A, TOKEN_A, n, n === N2 ? C2 : C1, 'NUEVA')
  }
  ctx.kmsProxy_ = (accion, cuerpo) => { viajes.push(accion); return queDevuelveElKms(accion, cuerpo) }

  return {
    ctx, cache, viajes,
    avisar: (ev) => { evento = ev; return ctx.notifyLiveStateChange_({}) },
    ponerKms: (f) => { queDevuelveElKms = f },
    sembrar: (gid, token, n, correo) => {
      const c = copia(gid, token, n, correo, 'VIEJA')
      return ctx._espejoGuardarCopia_(ctx.CacheService.getScriptCache(), gid, n, c)
    },
    leer: (gid, n) => leerTroceado(cache, ctx._wzCacheKey_('hyd', gid + '_' + ctx._wzN_(n, null))),
  }
}

/** Reensambla el sobre troceado, igual que `_wzCacheGetChunked_`. */
function leerTroceado (cache, clave) {
  const meta = cache.get(clave + '_meta')
  if (!meta) return null
  let s = ''
  for (let i = 0; i < Number(meta); i++) {
    const t = cache.get(clave + '_' + i)
    if (t == null) return null
    s += t
  }
  try { return JSON.parse(s) } catch (_) { return null }
}

// Lo que este arnés CONDUCE. Si falta uno, no se mide nada: MEDICIÓN CIEGA.
const NOMBRES_QUE_CONDUCE = [
  'notifyLiveStateChange_', '_espejoGuardarCopia_', '_espejoArchivarCopiasDelKms_',
  '_claveIndiceDeCopias_', '_parejasDeLasCopias_', '_apuntarParejaDeCopia_',
  '_rehacerLaCopiaDeUnTutor_', '_laSolicitudCambioEnElColegio_', '_tutorDeLaCopia_',
  '_wzCacheKey_', '_wzN_', '_versionDeClase_', 'hydrateSession_', '_rechazosDelEnlace_',
]

function afirmaciones (fuente) {
  const fallos = []
  let total = 0
  const m = cargar(fuente)

  // 0 — MEDICIÓN CIEGA.
  const ausentes = NOMBRES_QUE_CONDUCE.filter((n) => typeof m.ctx[n] !== 'function')
  if (ausentes.length) return { ciego: true, fallos: ['MEDICIÓN CIEGA — no existen: ' + ausentes.join(', ')] }

  // ── (1) EL ESCRITOR ÚNICO APUNTA LA PAREJA, y va MÁS RECIENTE PRIMERO ────────────────
  m.sembrar(GID_A, TOKEN_A, N1, C1)
  m.sembrar(GID_A, TOKEN_A, N2, C2)
  const idx = m.ctx._parejasDeLasCopias_(GID_A)
  total++
  if (idx.length !== 2 || idx.indexOf(N1) === -1 || idx.indexOf(N2) === -1) {
    fallos.push('(1.a) el escritor único no apuntó las DOS parejas (índice=' + JSON.stringify(idx) + '): ' +
      'sin índice, `CacheService` no sabe listar claves y el aviso pelado no tiene a qué aplicarse')
  }
  total++
  if (idx[0] !== N2) {
    fallos.push('(1.b) el índice no va MÁS RECIENTE PRIMERO: el presupuesto está acotado, así que el ' +
      'orden decide QUÉ copia se corrige antes — y va primero la que de verdad se está sirviendo')
  }
  // (1.c) ⛔ CERO DATOS PERSONALES: una copia cuyo discriminador NO es un `email_id` (la forma
  //       `e:<resumen del correo>` de `_wzN_`, o `-`) NO se apunta — el correo no entra ni resumido.
  const mPii = cargar(fuente)
  const claveConCorreo = mPii.ctx._wzCacheKey_('hyd', GID_A + '_' + mPii.ctx._wzN_(null, C1))
  mPii.ctx._espejoGuardarCopia_(mPii.ctx.CacheService.getScriptCache(), GID_A, null,
    copia(GID_A, TOKEN_A, N1, C1, 'VIEJA'), { claveYa: claveConCorreo })
  mPii.ctx._espejoGuardarCopia_(mPii.ctx.CacheService.getScriptCache(), GID_A, null,
    copia(GID_A, TOKEN_A, N1, C1, 'VIEJA'), { claveYa: mPii.ctx._wzCacheKey_('hyd', GID_A + '_-') })
  const idxPii = mPii.ctx._parejasDeLasCopias_(GID_A)
  total++
  if (idxPii.length !== 0) {
    fallos.push('(1.c) el índice apuntó algo que NO es un `email_id` (' + JSON.stringify(idxPii) + '): ' +
      'la forma `e:<resumen del correo>` es el correo RESUMIDO, y en el índice el correo no entra ni resumido')
  }

  // ── (2) UN AVISO PELADO REHACE LAS PAREJAS DE ESE EXPEDIENTE... ──────────────────────
  const m2 = cargar(fuente)
  m2.sembrar(GID_A, TOKEN_A, N1, C1)
  m2.sembrar(GID_A, TOKEN_A, N2, C2)
  m2.sembrar(GID_B, TOKEN_B, N2, C2)
  m2.viajes.length = 0
  const r2 = m2.avisar({ enrollment_group_id: GID_A, reason: 'ENR_PERSON_UPDATED' })
  total++
  if (!r2 || r2.ok !== true || r2.rehechas !== 2) {
    fallos.push('(2.a) el aviso PELADO no rehizo las dos copias de ese expediente (' +
      JSON.stringify(r2) + '): el tutor seguiría pagando el viaje entero al entrar')
  }
  total++
  if ((m2.leer(GID_A, N1) || {}).data?.marca !== 'NUEVA' ||
      (m2.leer(GID_A, N2) || {}).data?.marca !== 'NUEVA') {
    fallos.push('(2.b) tras el aviso pelado la copia archivada sigue siendo la VIEJA: ' +
      '«invalidar NO es actualizar», y aquí ni siquiera se actualizó')
  }
  // ── ...Y NINGUNA MÁS. La copia de OTRA familia no se toca. ───────────────────────────
  total++
  if ((m2.leer(GID_B, N2) || {}).data?.marca !== 'VIEJA') {
    fallos.push('(2.c) el aviso de un expediente tocó la copia de OTRO: el índice va por expediente ' +
      'justo para que eso no se pueda')
  }
  total++
  if (m2.viajes.filter((a) => a === 'enr.hydrateApplication').length !== 2) {
    fallos.push('(2.d) el aviso pelado gastó ' + m2.viajes.length + ' viajes al KMS en vez de 2 ' +
      '(uno por pareja de ESE expediente)')
  }

  // ── (3) LA CLAVE ES BYTE A BYTE LA QUE LEE EL CAMINO VIVO ────────────────────────────
  //     Se demuestra por el EFECTO: la hidratación de después no viaja al KMS.
  m2.viajes.length = 0
  const hid = m2.ctx.hydrateSession_({ resume_token: TOKEN_A, n: N1, language: 'es' })
  total++
  if (m2.viajes.filter((a) => a === 'enr.hydrateApplication').length !== 0) {
    fallos.push('(3.a) tras rehacer, la hidratación del camino vivo volvió a viajar al KMS: ' +
      'la copia quedó bajo una clave que NADIE lee')
  }
  total++
  if (!hid || !hid.group || hid.group.enrollment_group_id !== GID_A) {
    fallos.push('(3.b) la hidratación servida desde la copia rehecha no trae el expediente')
  }

  // ── (4) ⛔ CON `copias` EN EL AVISO, BYTE A BYTE COMO HOY ────────────────────────────
  const m4 = cargar(fuente)
  m4.sembrar(GID_A, TOKEN_A, N1, C1)
  m4.viajes.length = 0
  const r4 = m4.avisar({ enrollment_group_id: GID_A, reason: 'ENR_PERSON_UPDATED',
    copias: [{ enrollment_group_id: GID_A, n: N1, payload: copia(GID_A, TOKEN_A, N1, C1, 'DEL_AVISO') }] })
  total++
  if (m4.viajes.length !== 0) {
    fallos.push('(4.a) con `copias` en el aviso se viajó igual al KMS (' + m4.viajes.length + '): ' +
      'esto es ADITIVO — mientras el KMS mande el contenido, no se rehace nada')
  }
  total++
  if (!r4 || r4.copias !== 1 || 'rehechas' in r4 || 'parejas' in r4 || 'omitidas' in r4) {
    fallos.push('(4.b) con `copias` la respuesta del receptor dejó de ser la de hoy (' +
      JSON.stringify(r4) + '): el KMS lee esta respuesta')
  }
  total++
  if ((m4.leer(GID_A, N1) || {}).data?.marca !== 'DEL_AVISO') {
    fallos.push('(4.c) con `copias` no se archivó lo que traía el aviso')
  }

  // ── (5) ⛔⛔ EL KMS NO CONTESTA ⇒ NO SE BORRA NI UNA COPIA ───────────────────────────
  const m5 = cargar(fuente)
  m5.sembrar(GID_A, TOKEN_A, N1, C1)
  m5.ponerKms(() => { throw new Error('KMS caído') })
  const r5 = m5.avisar({ enrollment_group_id: GID_A, reason: 'ENR_PERSON_UPDATED' })
  total++
  if ((m5.leer(GID_A, N1) || {}).data?.marca !== 'VIEJA') {
    fallos.push('(5.a) con el KMS caído la copia vieja DESAPARECIÓ: el tutor entra y paga el viaje ' +
      'entero. Ninguna copia es peor que una vieja — es la barandilla que manda sobre la velocidad')
  }
  total++
  if (!r5 || r5.ok !== true || r5.rehechas !== 0) {
    fallos.push('(5.b) con el KMS caído el aviso no se comportó como el solo-bump de hoy (' +
      JSON.stringify(r5) + '): el POST del KMS se llevaría un error por algo que es best-effort')
  }

  // ── (6) ⛔ UN ÍNDICE ILEGIBLE DEJA EL COMPORTAMIENTO DE HOY, NO ROMPE NADA ───────────
  const m6 = cargar(fuente)
  m6.sembrar(GID_A, TOKEN_A, N1, C1)
  m6.ctx.CacheService.getScriptCache().put(m6.ctx._claveIndiceDeCopias_(GID_A), '{no es json')
  m6.viajes.length = 0
  let r6 = null
  try { r6 = m6.avisar({ enrollment_group_id: GID_A, reason: 'ENR_PERSON_UPDATED' }) } catch (e) { r6 = null }
  total++
  if (!r6 || r6.ok !== true || r6.bumped !== true || r6.parejas !== 0) {
    fallos.push('(6.a) con el índice ilegible el aviso dejó de comportarse como hoy (' +
      JSON.stringify(r6) + '): un índice que se cae no puede romper nada')
  }
  total++
  if ((m6.leer(GID_A, N1) || {}).data?.marca !== 'VIEJA') {
    fallos.push('(6.b) con el índice ilegible se perdió la copia vieja')
  }

  // ── (7) ⛔ LA COPIA QUE VUELVE TIENE QUE SER DE ESE TUTOR ────────────────────────────
  //     La hidratación se recorta al tutor que mira (DL-E49 §2): archivar bajo la clave de un
  //     tutor una copia recortada para OTRO es servirle a un tutor los datos del otro.
  const m7 = cargar(fuente)
  m7.sembrar(GID_A, TOKEN_A, N1, C1)
  m7.ponerKms(() => copia(GID_A, TOKEN_A, N2, C2, 'DEL_OTRO_TUTOR'))   // el KMS recorta para el OTRO
  const r7 = m7.avisar({ enrollment_group_id: GID_A, reason: 'ENR_PERSON_UPDATED' })
  total++
  if ((m7.leer(GID_A, N1) || {}).data?.marca !== 'VIEJA' || (r7 && r7.rehechas !== 0)) {
    fallos.push('(7) se archivó bajo la clave de un tutor una copia recortada para OTRO: eso es ' +
      'enseñarle a un tutor los datos del otro, lo único que esta pieza podría romper de verdad')
  }

  // ── (8) EL PRESUPUESTO: lo que no cabe se queda SOLO INVALIDADO, nunca borrado ───────
  const m8 = cargar(fuente)
  m8.sembrar(GID_A, TOKEN_A, N1, C1)
  m8.sembrar(GID_A, TOKEN_A, N2, C2)
  m8.ctx.COPIAS_AVISO_PRESUPUESTO_MS_ = -1     // ya agotado en la primera vuelta
  m8.viajes.length = 0
  const r8 = m8.avisar({ enrollment_group_id: GID_A, reason: 'ENR_PERSON_UPDATED' })
  total++
  if (!r8 || r8.omitidas !== 2 || r8.rehechas !== 0 || m8.viajes.length !== 0) {
    fallos.push('(8.a) con el presupuesto agotado el aviso siguió trabajando (' + JSON.stringify(r8) +
      ', viajes=' + m8.viajes.length + '): esto corre dentro del POST del KMS y no puede durar lo que quiera')
  }
  total++
  if ((m8.leer(GID_A, N1) || {}).data?.marca !== 'VIEJA' ||
      (m8.leer(GID_A, N2) || {}).data?.marca !== 'VIEJA') {
    fallos.push('(8.b) con el presupuesto agotado desapareció una copia: lo que no cabe se queda ' +
      'SOLO INVALIDADO, que es el comportamiento de hoy — nunca sin copia')
  }

  // ── (9) UN ENLACE QUE LA PUERTA RECHAZARÍA NO SE USA PARA PEDIR NADA ────────────────
  const m9 = cargar(fuente)
  {
    const abandonada = copia(GID_A, TOKEN_A, N1, C1, 'VIEJA')
    abandonada.group.abandoned_at = '2026-01-01T00:00:00.000Z'
    m9.ctx._espejoGuardarCopia_(m9.ctx.CacheService.getScriptCache(), GID_A, N1, abandonada)
  }
  m9.viajes.length = 0
  const r9 = m9.avisar({ enrollment_group_id: GID_A, reason: 'ENR_PERSON_UPDATED' })
  total++
  if (m9.viajes.length !== 0 || (r9 && r9.rehechas !== 0)) {
    fallos.push('(9) se pidió la copia de un expediente ABANDONADO: el juez único de los tres ' +
      'rechazos (`_rechazosDelEnlace_`) dejó de aplicarse antes de gastar el viaje')
  }

  return { ciego: false, fallos, total }
}

// ── Las ROTURAS DEMOSTRADAS: cada una tiene que poner ROJA su afirmación ────────────────
const ROTURAS = [
  // ⚠️ El ancla cambió el 2026-10-01: el escritor único apunta AHORA dos índices en la misma
  // línea (la pareja y la solicitud). Se retira SOLO la pareja, que es lo que este arnés mide.
  { nombre: 'el escritor único deja de APUNTAR la pareja',
    romper: (f) => f.replace(
      '    if (guardada) { _apuntarParejaDeCopia_(groupId, key); _apuntarSolicitudDeCopia_(groupId); }',
      '    if (guardada) { _apuntarSolicitudDeCopia_(groupId); }') },
  { nombre: 'el receptor deja de rehacer cuando el aviso viene PELADO',
    romper: (f) => f.replace(
      '  const reh = traeCopias ? null : _laSolicitudCambioEnElColegio_(groupId, v.event.reason);',
      '  const reh = null;') },
  { nombre: 'el receptor rehace TAMBIÉN cuando el aviso trae `copias` (deja de ser aditivo)',
    romper: (f) => f.replace(
      '  const reh = traeCopias ? null : _laSolicitudCambioEnElColegio_(groupId, v.event.reason);',
      '  const reh = _laSolicitudCambioEnElColegio_(groupId, v.event.reason);') },
  { nombre: 'se BORRA la copia vieja antes de pedir la nueva',
    romper: (f) => f.replace(
      "    var vAntes = _versionDeClase_(groupId, 'hyd');\n    var pedidaEn = new Date().toISOString();",
      "    cache.remove(clave + '_meta');\n" +
      "    var vAntes = _versionDeClase_(groupId, 'hyd');\n    var pedidaEn = new Date().toISOString();") },
  { nombre: 'se quita la guarda de «la copia que vuelve es de ESTE tutor»',
    romper: (f) => f.replace(
      "      return 'TUTOR_NO_CASA';", "      /* guarda retirada */;") },
  { nombre: 'el índice apunta el discriminador sin comprobar que es un `email_id`',
    romper: (f) => f.replace(
      "    try { assertValidUuid_(n, 'n'); } catch (eN) { return false; }   // `e:…` y `-` NO se apuntan",
      '') },
  { nombre: 'el aviso ignora su presupuesto',
    romper: (f) => f.replace(
      '      if (Date.now() - t0 > COPIAS_AVISO_PRESUPUESTO_MS_) { out.omitidas = parejas.length - i; break; }',
      '') },
  { nombre: 'el juez único de los tres rechazos deja de aplicarse antes del viaje',
    romper: (f) => f.replace(
      "    if (_rechazosDelEnlace_(ficha)) return 'ENLACE_RECHAZADO';", '') },
]

// Y los RENOMBRADOS: tienen que salir «MEDICIÓN CIEGA», jamás verde.
const RENOMBRADOS = ['_laSolicitudCambioEnElColegio_', '_parejasDeLasCopias_',
                     '_apuntarParejaDeCopia_', '_rehacerLaCopiaDeUnTutor_', '_tutorDeLaCopia_']

let motivo = null
let base = null
try {
  const fuente = readFileSync(join(RAIZ, 'backend/Code.js'), 'utf8')
  base = afirmaciones(fuente)

  if (base.ciego) {
    motivo = base.fallos.join(' · ')
  } else if (base.fallos.length) {
    base.fallos.forEach((f) => console.log('  ✗ ' + f))
    motivo = `${base.fallos.length} afirmación(es) rota(s): ${base.fallos.join(' · ')}`
  } else {
    const ciegas = []
    for (const r of ROTURAS) {
      const roto = r.romper(fuente)
      if (roto === fuente) { ciegas.push(r.nombre + ' (la mutilación no cambió el fuente — MEDICIÓN CIEGA)'); continue }
      let res
      try { res = afirmaciones(roto) } catch (e) { res = { ciego: false, fallos: ['excepción: ' + e.message] } }
      if (!res.fallos.length) ciegas.push(r.nombre + ' (rompiéndolo, el arnés SIGUE VERDE)')
      else console.log('  ✓ rotura demostrada — ' + r.nombre)
    }
    for (const n of RENOMBRADOS) {
      const renombrado = fuente.split(n).join(n.replace(/_$/, 'Renombrada_'))
      let res
      try { res = afirmaciones(renombrado) } catch (e) { res = { ciego: false, fallos: ['excepción: ' + e.message] } }
      if (!res.ciego) ciegas.push('el renombrado de `' + n + '` NO sale «MEDICIÓN CIEGA»')
      else console.log('  ✓ rotura demostrada — renombrar `' + n + '` sale MEDICIÓN CIEGA, no verde')
    }

    if (ciegas.length) motivo = 'el arnés no es una red: ' + ciegas.join(' · ')
    else {
      console.log('  ✓ el escritor ÚNICO apunta la pareja, más reciente primero, y SOLO el `email_id` opaco')
      console.log('  ✓ un aviso PELADO rehace las copias de ESE expediente — y ninguna de otro')
      console.log('  ✓ la copia queda bajo la clave que lee el camino vivo (la hidratación de después no viaja)')
      console.log('  ✓ ⛔ con `copias` en el aviso, byte a byte como hoy: ni un viaje, ni un campo nuevo')
      console.log('  ✓ ⛔⛔ con el KMS caído, con el índice ilegible o con el presupuesto agotado, NO se borra ni una copia')
      console.log('  ✓ ⛔ una copia recortada para OTRO tutor no se archiva bajo la clave de éste')
      console.log('  ✓ ejecutado sobre `backend/Code.js` REAL, en un vm con dobles: sin red, sin navegador, sin datos reales')
    }
  }
} catch (e) {
  motivo = 'error fatal — ' + (e && e.message)
} finally {
  const total = base && !base.ciego ? base.total : 0
  console.log(motivo
    ? `VEREDICTO: ROJO — ${motivo}`
    : `VEREDICTO: VERDE — ${total} afirmaciones: un aviso pelado del KMS deja la copia caliente al día, y ningún fallo del camino puede dejar a un tutor sin la suya.`)
  process.exitCode = motivo ? 1 : 0
}
