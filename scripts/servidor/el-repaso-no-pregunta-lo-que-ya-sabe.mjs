#!/usr/bin/env node
/**
 * EL REPASO NO PREGUNTA LO QUE YA SABE — control que EJECUTA el servidor.
 * ══════════════════════════════════════════════════════════════════════════════════════
 *
 * `node scripts/servidor/el-repaso-no-pregunta-lo-que-ya-sabe.mjs`
 * Sin red, sin navegador, sin `npm ci`. Última línea: `VEREDICTO: VERDE` / `ROJO — <motivo>`.
 *
 * QUÉ PROTEGE, en una frase: **que el repaso de fondo re-caliente la puerta y la identidad con
 * lo que YA tiene guardado —sin viajar al KMS— y que ahorrar ese viaje no afloje ni un plazo de
 * seguridad.**
 *
 * POR QUÉ EXISTE. Lo que el viaje al KMS trae es la HIDRATACIÓN, que dura **6 h**
 * (`ESPEJO_HYD_TTL_S_`). Lo que de verdad caduca cada **30 min** es la PUERTA
 * (`COPIA_PUERTA_TTL_S_`), la IDENTIDAD (`IDENTIDAD_MEMO_TTL_S_`) y el CUESTIONARIO
 * (`CATALOGO_PREGUNTAS_TTL_S_`) — **y las tres se construyen enteras con `payload.group`, que
 * ya está guardado**. El repaso late cada 15 min bajo la cuenta del DESARROLLADOR
 * (`executeAs: USER_DEPLOYING`) y el salto asistente→KMS tiene suelo medido de 9,3-13,2 s ⇒ 96
 * veces al día se traía de fuera algo que ya tenía. Hoy solo PREGUNTA una de cada cuatro vueltas
 * (`ESPEJO_PREGUNTA_CADA_VUELTAS_`), y las otras tres se resuelven en memoria.
 *
 * ⛔⛔ **LA BARANDILLA QUE MANDA SOBRE EL AHORRO, y es la afirmación (2): SE EXIGE QUE LA
 * VERSIÓN DE LA COPIA CASE.** Cuando el colegio toca algo, su aviso bumpa la versión de clase y
 * esa copia **deja de re-calentarse sola**: espera al viaje. Sin esa comprobación, un enlace que
 * el colegio mató seguiría abriendo, y el plazo de revocación de 30 min que Diego llamó
 * razonable (2026-08-26) dejaría de ser 30 min.
 *
 * ⛔ **Y DEGRADA SOLO, afirmación (4):** sin índice, con el índice ilegible o con páginas sin
 * ver, la vuelta VIAJA y hace exactamente lo de hoy.
 *
 * CÓMO MIDE. Carga `backend/Code.js` REAL entero en un `vm` con dobles en memoria y ejecuta
 * `espejoRefrescarCopias` de verdad, contando las llamadas que salen por `kmsProxy_`. No copia
 * ni una línea de lógica: si la función cambia, este control mide la nueva. Los datos son
 * sintéticos y los correos van en el dominio reservado `.invalid` (RFC 2606).
 *
 * ⚠️ **LO QUE NO AFIRMA, dicho sin adornar:**
 *   · **No habla con el KMS**, así que no dice nada sobre lo que devuelve
 *     `enr.copiasDeLasSolicitudesVivas` de verdad, ni sobre cuánto tarda un viaje, ni sobre la
 *     cuota de Apps Script.
 *   · **No afirma que el DISPARADOR esté instalado** ni cada cuánto late de verdad: eso se ve
 *     en la pantalla de disparadores del proyecto, no aquí.
 *   · **No dice nada de lo que pinta el navegador**: eso es la batería (`npm run e2e:wizard`).
 *   · **No mide el tiempo que se ahorra**: cuenta VIAJES, que es la unidad que importa.
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
// ⛔ FIJO a propósito: la afirmación (1.d) compara la ficha que deja el camino del viaje con la
// que deja el camino de la memoria. Con `new Date()` la diferencia sería el RELOJ y no el
// producto — un arnés que mide su suerte, no lo que protege.
const CREADA   = '2026-09-30T08:00:00.000Z'

/** Una copia caliente sintética de UN tutor de UN expediente. */
function copia (gid, token, n, correo, extra) {
  const group = {
    enrollment_group_id: gid, resume_token: token, primary_email: correo,
    requester_person_id: 'p-' + n, submitted_at: null, abandoned_at: null,
    created_at: CREADA, program_id: 'prog-1',
    preferred_language: 'es',
  }
  Object.keys(extra || {}).forEach((k) => { group[k] = extra[k] })
  return {
    group,
    persons: [{ person_id: 'p-' + n, person_type_id: 'guardian',
                emails: [{ email_id: n, value: correo }] }],
    relations: [], documents: [], responses: [], enrollments: [],
    lookups: {}, billing_splits: { payers: [], per_participant: [] },
    live_version: 1,
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
      computeDigest: (a, s) => Array.from(Buffer.from(String(s))),
      DigestAlgorithm: { SHA_256: 1 }, Charset: { UTF_8: 1 },
      sleep () {}, formatDate: () => '2026-01-01',
      newBlob: (s) => ({ getBytes: () => Array.from(Buffer.from(String(s))) }),
    },
    Session: { getActiveUser: () => ({ getEmail: () => '' }), getScriptTimeZone: () => 'UTC' },
  }
  vm.createContext(ctx)
  vm.runInContext(fuente, ctx, { filename: 'backend/Code.js' })

  // EL CONTADOR DE VIAJES — lo único que sustituye al KMS, y devuelve SU verdad.
  // Por defecto, una página con las DOS parejas del expediente A y la del B.
  let queDevuelveElKms = (accion) => {
    if (accion !== 'enr.copiasDeLasSolicitudesVivas') return {}
    return {
      grupos_totales: 2, siguiente_desde: null,
      copias: [
        { enrollment_group_id: GID_A, n: N1, payload: copia(GID_A, TOKEN_A, N1, C1) },
        { enrollment_group_id: GID_A, n: N2, payload: copia(GID_A, TOKEN_A, N2, C2) },
        { enrollment_group_id: GID_B, n: N2, payload: copia(GID_B, TOKEN_B, N2, C2) },
      ],
    }
  }
  const cs = () => ctx.CacheService.getScriptCache()
  ctx.kmsProxy_ = (accion, cuerpo) => { viajes.push(accion); return queDevuelveElKms(accion, cuerpo) }

  return {
    ctx, cache, viajes,
    ponerKms: (f) => { queDevuelveElKms = f },
    /** Archiva una copia por el escritor ÚNICO — el mismo camino que la deja el viaje. */
    sembrar: (gid, token, n, correo, extra) =>
      ctx._espejoGuardarCopia_(cs(), gid, n, copia(gid, token, n, correo, extra)),
    /** Deja el CATÁLOGO caliente y con techo: el estado de régimen, donde no se viaja por él. */
    sembrarCatalogo: () => {
      ctx._guardarCatalogoDePreguntas_('ENROLLMENT', 'es', 'prog-1',
        { sets: [{ items: [{ question_id: 'q1' }] }] })
      ctx._marcarViajeDelCatalogo_('ENROLLMENT', 'es', 'prog-1')
    },
    /** Pone el contador de vueltas sin preguntar. */
    contador: (v) => { cs().put(ctx.ESPEJO_VUELTAS_KEY_, String(v)) },
    leerContador: () => Number(cs().get(ctx.ESPEJO_VUELTAS_KEY_)),
    cursor: () => String(cs().get(ctx.ESPEJO_CURSOR_KEY_) || ''),
    /** La copia de la PUERTA tal cual quedó guardada (o `null`). */
    puerta: (token) => {
      const crudo = cs().get(ctx._claveCopiaPuerta_(token))
      if (!crudo) return null
      try { return JSON.parse(crudo) } catch (_) { return null }
    },
    /** La memoria de la IDENTIDAD DECLARADA tal cual quedó guardada (o `null`). */
    identidad: (gid, token, n) =>
      cs().get(ctx._claveIdLinkMemo_('idlinkd_', token, n, '', gid)),
  }
}

// Lo que este arnés CONDUCE. Si falta uno, no se mide nada: MEDICIÓN CIEGA.
const NOMBRES_QUE_CONDUCE = [
  'espejoRefrescarCopias', '_espejoRecalentarDesdeLaMemoria_',
  '_espejoCuestionariosDeLaMemoria_', '_claveIndiceDeSolicitudes_',
  '_solicitudesDeLasCopias_', '_apuntarSolicitudDeCopia_',
  '_espejoGuardarCopia_', '_espejoCalentarLaPuerta_', '_parejasDeLasCopias_',
  '_claveCopiaPuerta_', '_claveIdLinkMemo_', '_versionDeClase_', '_wzCacheKey_', '_wzN_',
  '_rechazosDelEnlace_', '_guardarCatalogoDePreguntas_', '_marcarViajeDelCatalogo_',
]
const CONSTANTES_QUE_CONDUCE = ['ESPEJO_PREGUNTA_CADA_VUELTAS_', 'ESPEJO_VUELTAS_KEY_',
                                'ESPEJO_SOLICITUDES_TOPE_', 'ESPEJO_CURSOR_KEY_']

function afirmaciones (fuente) {
  const fallos = []
  let total = 0

  // 0 — MEDICIÓN CIEGA.
  let m0
  try { m0 = cargar(fuente) } catch (e) { return { ciego: true, fallos: ['MEDICIÓN CIEGA — el fuente no carga: ' + e.message] } }
  const ausentes = NOMBRES_QUE_CONDUCE.filter((n) => typeof m0.ctx[n] !== 'function')
    .concat(CONSTANTES_QUE_CONDUCE.filter((n) => m0.ctx[n] === undefined))
  if (ausentes.length) return { ciego: true, fallos: ['MEDICIÓN CIEGA — no existen: ' + ausentes.join(', ')] }

  // ── (1) UNA VUELTA CON ÍNDICE Y CONTADOR SIN VENCER: CERO VIAJES, PUERTA E IDENTIDAD ──
  //     Y SE COMPARA BYTE A BYTE CONTRA LO QUE DEJA EL CAMINO DEL VIAJE.
  //
  //     La de referencia: una vuelta que VIAJA (no hay índice todavía) deja la puerta y la
  //     identidad escritas. La medida: con el índice ya puesto y sin tocar la red.
  const ref = cargar(fuente)
  ref.sembrarCatalogo()
  ref.ponerKms((accion) => {
    if (accion !== 'enr.copiasDeLasSolicitudesVivas') return {}
    return { grupos_totales: 1, siguiente_desde: null,
             copias: [{ enrollment_group_id: GID_A, n: N1, payload: copia(GID_A, TOKEN_A, N1, C1) }] }
  })
  const outRef = ref.ctx.espejoRefrescarCopias()
  total++
  if (!outRef || outRef.viajo !== true || outRef.puertas !== 1) {
    fallos.push('(1.a) la vuelta de REFERENCIA (sin índice) no viajó o no dejó la puerta puesta (' +
      JSON.stringify(outRef) + '): sin esa referencia no hay con qué comparar — MEDICIÓN CIEGA de hecho')
  }
  const puertaRef = ref.puerta(TOKEN_A)
  const identRef = ref.identidad(GID_A, TOKEN_A, N1)

  const m = cargar(fuente)
  m.sembrarCatalogo()
  m.sembrar(GID_A, TOKEN_A, N1, C1)
  m.sembrar(GID_A, TOKEN_A, N2, C2)
  // El escritor único acaba de apuntar la solicitud en el índice global; el contador va a 0.
  m.contador(0)
  // Se BORRA la puerta y la identidad que el sembrado pudiera haber dejado: lo que se mide es
  // lo que escribe LA VUELTA, no lo que había antes.
  m.cache.delete(m.ctx._claveCopiaPuerta_(TOKEN_A))
  m.cache.delete(m.ctx._claveIdLinkMemo_('idlinkd_', TOKEN_A, N1, '', GID_A))
  m.cache.delete(m.ctx._claveIdLinkMemo_('idlinkd_', TOKEN_A, N2, '', GID_A))
  m.viajes.length = 0
  const out1 = m.ctx.espejoRefrescarCopias()

  total++
  if (m.viajes.length !== 0) {
    fallos.push('(1.b) la vuelta que NO debía preguntar hizo ' + m.viajes.length + ' llamada(s) al KMS (' +
      JSON.stringify(m.viajes) + '): el viaje es el 85 % de la vuelta y corre contra la cuota del DESARROLLADOR')
  }
  total++
  if (!out1 || out1.viajo !== false || out1.recalentadas_sin_viaje !== 2 || out1.indice_solicitudes !== 1) {
    fallos.push('(1.c) la vuelta sin viaje no re-calentó las DOS parejas del índice (' +
      JSON.stringify(out1) + '): para eso existe el índice global')
  }
  const puerta1 = m.puerta(TOKEN_A)
  total++
  if (!puerta1 || JSON.stringify(puerta1.fila) !== JSON.stringify(puertaRef && puertaRef.fila) ||
      puerta1.gid !== (puertaRef && puertaRef.gid)) {
    fallos.push('(1.d) la puerta que deja la vuelta SIN viaje no es la MISMA que deja el camino del ' +
      'viaje: una forma distinta la lee mal `_cabeceraDeLaCopia_` y una clave distinta no la lee nadie')
  }
  total++
  if (m.identidad(GID_A, TOKEN_A, N1) !== identRef || !identRef) {
    fallos.push('(1.e) la identidad DECLARADA no quedó escrita igual que por el camino del viaje ' +
      '(' + String(m.identidad(GID_A, TOKEN_A, N1) === identRef) + '): la clave la calcula `_claveIdLinkMemo_`, el mismo que la lee')
  }
  total++
  if (m.cache.has(m.ctx._claveIdLinkMemo_('idlinkr_', TOKEN_A, N1, '', GID_A))) {
    fallos.push('(1.f) se sembró la identidad de RESPALDO (`idlinkr_`, ②24.bis): atribuirle por ' +
      'adelantado a alguien lo que quizá no hizo es justo lo que esa sección separó')
  }
  total++
  if (!puerta1 || !puerta1.exp || puerta1.exp - Date.now() > (m.ctx.COPIA_PUERTA_TTL_S_ * 1000) + 5000) {
    fallos.push('(1.g) el `exp` de la puerta re-calentada pasa de `COPIA_PUERTA_TTL_S_`: eso ALARGA ' +
      'el plazo de revocación, y ningún plazo de seguridad se toca')
  }

  // ── (2) ⛔⛔ UNA COPIA CON LA VERSIÓN VIEJA NO SE RE-CALIENTA ─────────────────────────
  //     Es lo que conserva el plazo de revocación de 30 min: cuando el colegio toca algo, su
  //     aviso bumpa la versión y esa copia espera al viaje en vez de abrir sola.
  const m2 = cargar(fuente)
  m2.sembrarCatalogo()
  m2.sembrar(GID_A, TOKEN_A, N1, C1)
  m2.contador(0)
  m2.cache.delete(m2.ctx._claveCopiaPuerta_(TOKEN_A))
  m2.ctx._bumpLiveStateVersion_(GID_A)       // el bump REAL que hace el aviso del colegio
  m2.viajes.length = 0
  const out2 = m2.ctx.espejoRefrescarCopias()
  total++
  if (m2.puerta(TOKEN_A) !== null) {
    fallos.push('(2.a) se re-calentó la puerta de una copia tildada VIEJA: un enlace que el colegio ' +
      'mató seguiría abriendo, y el plazo de revocación de 30 min dejaría de ser 30 min')
  }
  total++
  if (!out2 || out2.recalentadas_sin_viaje !== 0 || !out2.recalentar || out2.recalentar.viejas !== 1) {
    fallos.push('(2.b) la vuelta no contó la copia vieja como vieja (' + JSON.stringify(out2) + '): ' +
      'si no se cuenta, nadie puede ver que esa barandilla está actuando')
  }

  // ── (3) UNA FICHA QUE EL JUEZ RECHAZA NO DEJA NADA ESCRITO ───────────────────────────
  for (const caso of [
    { nombre: 'abandonada', extra: { abandoned_at: '2026-01-01T00:00:00.000Z' } },
    { nombre: 'caducada a los 7 días', extra: { created_at: '2020-01-01T00:00:00.000Z' } },
  ]) {
    const m3 = cargar(fuente)
    m3.sembrarCatalogo()
    m3.sembrar(GID_A, TOKEN_A, N1, C1, caso.extra)
    m3.contador(0)
    m3.cache.delete(m3.ctx._claveCopiaPuerta_(TOKEN_A))
    m3.cache.delete(m3.ctx._claveIdLinkMemo_('idlinkd_', TOKEN_A, N1, '', GID_A))
    m3.viajes.length = 0
    const out3 = m3.ctx.espejoRefrescarCopias()
    total++
    if (m3.puerta(TOKEN_A) !== null || m3.identidad(GID_A, TOKEN_A, N1) ||
        (out3 && out3.recalentadas_sin_viaje !== 0)) {
      fallos.push('(3.' + caso.nombre + ') se archivó la puerta de un expediente que el juez ÚNICO ' +
        'rechaza: `_rechazosDelEnlace_` tiene que aplicarse igual sin viaje que con viaje — una copia ' +
        'CONSERVA un «sí», jamás lo CREA')
    }
  }

  // ── (4) ⛔ SIN ÍNDICE, CON ÍNDICE ILEGIBLE O CON EL CONTADOR VENCIDO, SE VIAJA ────────
  const casos4 = [
    { nombre: 'sin índice', preparar: (x) => { x.cache.delete(x.ctx._claveIndiceDeSolicitudes_()) } },
    { nombre: 'índice ilegible', preparar: (x) => { x.cache.set(x.ctx._claveIndiceDeSolicitudes_(), '{no es json') } },
    { nombre: 'contador vencido', preparar: (x) => { x.contador(x.ctx.ESPEJO_PREGUNTA_CADA_VUELTAS_ - 1) } },
    { nombre: 'páginas sin ver', preparar: (x) => { x.cache.set(x.ctx.ESPEJO_CURSOR_KEY_, '25') } },
  ]
  for (const caso of casos4) {
    const m4 = cargar(fuente)
    m4.sembrarCatalogo()
    m4.sembrar(GID_A, TOKEN_A, N1, C1)
    m4.contador(0)
    caso.preparar(m4)
    m4.viajes.length = 0
    const out4 = m4.ctx.espejoRefrescarCopias()
    total++
    if (!out4 || out4.viajo !== true ||
        m4.viajes.filter((a) => a === 'enr.copiasDeLasSolicitudesVivas').length === 0) {
      fallos.push('(4.' + caso.nombre + ') la vuelta NO viajó (' + JSON.stringify(out4) + ', viajes=' +
        JSON.stringify(m4.viajes) + '): sin índice utilizable el comportamiento tiene que ser byte a ' +
        'byte el de hoy, y una página sin ver no se puede quedar colgando')
    }
    total++
    if (!out4 || out4.archivadas === 0) {
      fallos.push('(4.' + caso.nombre + ') la vuelta que viaja dejó de archivar las copias que trae: ' +
        'el bucle del viaje no se toca')
    }
  }

  // ── (4.bis) EL CONTADOR SUBE CUANDO NO SE PREGUNTA Y SE PONE A CERO CUANDO SÍ ────────
  const m4b = cargar(fuente)
  m4b.sembrarCatalogo()
  m4b.sembrar(GID_A, TOKEN_A, N1, C1)
  m4b.contador(0)
  m4b.ctx.espejoRefrescarCopias()
  total++
  if (m4b.leerContador() !== 1) {
    fallos.push('(4.bis.a) el contador no subió tras una vuelta sin viaje (' + m4b.leerContador() +
      '): sin contador no se le preguntaría al colegio NUNCA, y una solicitud nueva no se descubriría')
  }
  m4b.contador(m4b.ctx.ESPEJO_PREGUNTA_CADA_VUELTAS_ - 1)
  m4b.ctx.espejoRefrescarCopias()
  total++
  if (m4b.leerContador() !== 0) {
    fallos.push('(4.bis.b) el contador no se puso a cero en la vuelta que viajó (' + m4b.leerContador() +
      '): se preguntaría en todas las vueltas siguientes')
  }

  // ── (5) EL ÍNDICE GLOBAL NO ADMITE NADA QUE NO SEA UN IDENTIFICADOR ──────────────────
  const m5 = cargar(fuente)
  total++
  if (m5.ctx._apuntarSolicitudDeCopia_(C1) !== false ||
      m5.ctx._apuntarSolicitudDeCopia_('e:AAAABBBBCCCCDDDD') !== false ||
      m5.ctx._apuntarSolicitudDeCopia_('-') !== false ||
      m5.ctx._solicitudesDeLasCopias_().length !== 0) {
    fallos.push('(5.a) el índice global admitió algo que NO es un identificador (' +
      JSON.stringify(m5.ctx._solicitudesDeLasCopias_()) + '): ni un correo ni su resumen entran ahí')
  }
  total++
  m5.sembrar(GID_B, TOKEN_B, N2, C2)
  m5.sembrar(GID_A, TOKEN_A, N1, C1)
  const idx5 = m5.ctx._solicitudesDeLasCopias_()
  if (idx5.length !== 2 || idx5[0] !== GID_A) {
    fallos.push('(5.b) el índice global no apuntó las dos solicitudes MÁS RECIENTE PRIMERO (' +
      JSON.stringify(idx5) + '): el presupuesto está acotado, así que el orden decide a quién se ' +
      'atiende antes')
  }
  total++
  if (m5.ctx._solicitudesDeLasCopias_().join('|').indexOf('@') !== -1) {
    fallos.push('(5.c) hay un correo dentro del índice global (KAL-11)')
  }

  // ── (6) UN FALLO EN UNA PAREJA NO TUMBA LA VUELTA NI MUEVE EL CURSOR ─────────────────
  const m6 = cargar(fuente)
  m6.sembrarCatalogo()
  m6.sembrar(GID_A, TOKEN_A, N2, C2)
  m6.sembrar(GID_A, TOKEN_A, N1, C1)   // ⛔ la ROTA va PRIMERA (el índice es más reciente
  m6.contador(0)                       //    primero), o su fallo no podría alcanzar a la buena
  // La copia del tutor 1 se deja ILEGIBLE: su trozo 0 pasa a no ser JSON.
  m6.cache.set(m6.ctx._wzCacheKey_('hyd', GID_A + '_' + N1) + '_0', '{no es json')
  m6.cache.delete(m6.ctx._claveCopiaPuerta_(TOKEN_A))
  const cursorAntes = m6.cursor()
  m6.viajes.length = 0
  let out6 = null
  try { out6 = m6.ctx.espejoRefrescarCopias() } catch (e) { out6 = null }
  total++
  if (!out6 || out6.viajo !== false) {
    fallos.push('(6.a) una pareja ilegible tumbó la vuelta (' + JSON.stringify(out6) + '): esto es ' +
      'best-effort de punta a punta y corre bajo un disparador que nadie mira')
  }
  total++
  if (!out6 || out6.recalentadas_sin_viaje !== 1) {
    fallos.push('(6.b) la pareja ilegible se llevó por delante a la BUENA (' + JSON.stringify(out6) +
      '): un fallo salta a la siguiente, no cancela el resto')
  }
  total++
  if (m6.cursor() !== cursorAntes && !(cursorAntes === '' && m6.cursor() === '0')) {
    fallos.push('(6.c) la vuelta sin viaje movió el cursor del paginado (' + cursorAntes + ' → ' +
      m6.cursor() + '): el cursor es de las páginas del KMS, y aquí no se ha pedido ninguna')
  }

  return { ciego: false, fallos, total }
}

// ── Las ROTURAS DEMOSTRADAS: cada una tiene que poner ROJA su afirmación ────────────────
const ROTURAS = [
  { nombre: 'el escritor único deja de APUNTAR la solicitud en el índice global',
    romper: (f) => f.replace(
      '    if (guardada) { _apuntarParejaDeCopia_(groupId, key); _apuntarSolicitudDeCopia_(groupId); }',
      '    if (guardada) { _apuntarParejaDeCopia_(groupId, key); }') },
  { nombre: 'la vuelta viaja SIEMPRE, como antes (el índice no sirve de nada)',
    romper: (f) => f.replace(
      `  out.viajo = (vueltasSinPreguntar >= (ESPEJO_PREGUNTA_CADA_VUELTAS_ - 1)) ||
              indice.length === 0 || desde > 0;`,
      '  out.viajo = true;') },
  { nombre: 'la vuelta NUNCA viaja (una solicitud nueva no se descubriría jamás)',
    romper: (f) => f.replace(
      `  out.viajo = (vueltasSinPreguntar >= (ESPEJO_PREGUNTA_CADA_VUELTAS_ - 1)) ||
              indice.length === 0 || desde > 0;`,
      '  out.viajo = false;') },
  { nombre: '⛔⛔ se re-calienta sin exigir que la VERSIÓN de la copia case',
    romper: (f) => f.replace(
      '          if (!env || env.v !== vigente) { out.viejas++; continue; }',
      '          if (!env) { out.viejas++; continue; }') },
  { nombre: 'el juez único de los tres rechazos deja de aplicarse al re-calentar',
    romper: (f) => f.replace(
      "    var rechazo = _rechazosDelEnlace_(fila);\n    if (rechazo) { res.motivo = 'RECHAZADO:' + (rechazo.code || '?'); return res; }",
      '    var rechazo = null;') },
  { nombre: 'el índice global apunta sin comprobar que es un identificador',
    romper: (f) => f.replace(
      "    try { assertValidUuid_(gid, 'enrollment_group_id'); } catch (eG) { return false; }",
      '') },
  { nombre: 'el contador de vueltas deja de escribirse',
    romper: (f) => f.replace(
      `    cache.put(ESPEJO_VUELTAS_KEY_, String(out.viajo ? 0 : (vueltasSinPreguntar + 1)),
      ESPEJO_GUARDA_S_);`, '') },
  { nombre: 'un fallo de una pareja cancela el resto de la vuelta (se quitan las DOS salidas ' +
            'que la aíslan: el `continue` de la copia ilegible y el `catch` por pareja)',
    romper: (f) => f.replace(
      `          try { env = JSON.parse(crudo); } catch (eP) {
            out.motivos.COPIA_ILEGIBLE = (out.motivos.COPIA_ILEGIBLE || 0) + 1; continue;
          }`,
      '          env = JSON.parse(crudo);').replace(
      '        } catch (ePar) { out.motivos.ERROR = (out.motivos.ERROR || 0) + 1; }',
      '        } catch (ePar) { throw ePar; }') },
  { nombre: 'la vuelta sin viaje escribe el cursor del paginado',
    romper: (f) => f.replace(
      '  out.siguiente_desde = desde || null;',
      '  out.siguiente_desde = desde || null;\n  desde = 25;') },
]

// Y los RENOMBRADOS: tienen que salir «MEDICIÓN CIEGA», jamás verde.
const RENOMBRADOS = ['_espejoRecalentarDesdeLaMemoria_', '_solicitudesDeLasCopias_',
                     '_apuntarSolicitudDeCopia_', '_claveIndiceDeSolicitudes_',
                     '_espejoCuestionariosDeLaMemoria_', '_espejoCalentarLaPuerta_']

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
      console.log('  ✓ una vuelta con índice y contador sin vencer hace CERO llamadas al KMS')
      console.log('  ✓ y deja la puerta y la identidad con la MISMA clave y la MISMA forma que el camino del viaje')
      console.log('  ✓ ⛔⛔ una copia con la versión VIEJA no se re-calienta (es el plazo de revocación de 30 min)')
      console.log('  ✓ una ficha que el juez único RECHAZA no deja nada escrito (abandonada · caducada)')
      console.log('  ✓ ⛔ sin índice, con índice ilegible, con el contador vencido o con páginas sin ver, SE VIAJA')
      console.log('  ✓ el índice global solo admite identificadores: ni un correo ni su resumen (KAL-11)')
      console.log('  ✓ un fallo de una pareja no tumba la vuelta ni mueve el cursor del paginado')
      console.log('  ✓ ejecutado sobre `backend/Code.js` REAL, en un vm con dobles: sin red, sin navegador, sin datos reales')
    }
  }
} catch (e) {
  motivo = 'error fatal — ' + (e && e.message)
} finally {
  const total = base && !base.ciego ? base.total : 0
  console.log(motivo
    ? `VEREDICTO: ROJO — ${motivo}`
    : `VEREDICTO: VERDE — ${total} afirmaciones: el repaso re-calienta la puerta y la identidad con lo que ya tiene, sin viajar, y ahorrar ese viaje no afloja ni un plazo de seguridad.`)
  process.exitCode = motivo ? 1 : 0
}
