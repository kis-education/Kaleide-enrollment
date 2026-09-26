#!/usr/bin/env node
/**
 * REGLA 3 (Diego, 2026-09-23) — «Si alguien desde el UI del wizard modifica algo de esa
 * solicitud **se actualiza en el backend del wizard** y, cuando sea necesario, se le manda
 * al KMS.»
 *
 * QUÉ PROTEGE ESTE ARNÉS, en una frase: que una escritura del asistente deje su copia
 * caliente **al día** —rehecha CON LO QUE EL KMS DICE— y que **jamás** se archive como buena
 * una copia con un dato que el KMS todavía no ha confirmado.
 *
 * ⛔ **NO ES UN DETECTOR POR LÍNEAS: EJECUTA EL CÓDIGO REAL.** Carga `backend/Code.js` entero
 * en un `vm` con dobles en memoria (ni red, ni navegador, ni `npm ci`, ni un solo dato real:
 * todo sintético en el dominio reservado `.invalid`, RFC 2606) y llama a las funciones de
 * verdad — `_wzCopiaAlDia_` y `hydrateSession_`, la que escribe la copia y la que la lee.
 *
 * ⛔ **Y SE ROMPE A PROPÓSITO.** Cada afirmación se vuelve a correr sobre una copia
 * MUTILADA del fuente, y si la mutilación NO la pone roja, el arnés canta: una comprobación
 * que nunca se ha visto fallar no es una red. Se incluye la rotura que protege la barandilla
 * que manda (servir un dato que el KMS no ha confirmado) y la del **renombrado**, que tiene
 * que salir «MEDICIÓN CIEGA» en vez de verde.
 *
 * ⚠️ **LO QUE NO AFIRMA:** no habla con el KMS ni con Apps Script, así que no dice nada sobre
 * si el KMS acepta la escritura ni sobre cuánto tarda un viaje de verdad. Afirma lo que
 * DECIDE este backend.
 *
 * Veredicto: ÚLTIMA línea, SIEMPRE impresa, incluso ante error fatal. Se lee de ahí, NUNCA
 * del código de salida (una tubería devuelve el del último comando).
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// ── Datos SINTÉTICOS. Ni un dato real, y el dominio es el reservado (RFC 2606). ──────────
const GID    = '11111111-1111-4111-8111-111111111111'
const TOKEN  = '22222222-2222-4222-8222-222222222222'
const N      = '33333333-3333-4333-8333-333333333333'
const CORREO = 'tutor@example.invalid'

/** Lo que el KMS contesta a `enr.hydrateApplication`. Es la VERDAD: lo que el colegio tiene. */
const COPIA_DEL_KMS = () => ({
  group: { enrollment_group_id: GID, resume_token: TOKEN, primary_email: CORREO },
  persons: [{ person_id: 'p-viva', person_type_id: 'guardian' }],
  relations: [], documents: [], responses: [], enrollments: [],
  lookups: {}, billing_splits: { payers: [], per_participant: [] }, live_version: 1,
})

/** Lo que el TUTOR acaba de mandar, con una fila que el KMS DESCARTA (y no vuelve nunca). */
const LO_QUE_MANDO_EL_TUTOR = { person_id: 'p-que-el-kms-descarta', person_type_id: 'applicant' }

// ── El banco de pruebas: carga el fuente REAL en un vm con dobles ───────────────────────
function cargar (fuente) {
  const cache = new Map()
  const viajes = []            // cada llamada al KMS, con su acción
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
      getUuid: () => '44444444-4444-4444-8444-444444444444',
      base64EncodeWebSafe: (s) => Buffer.from(String(s)).toString('base64url'),
      computeDigest: (s) => Array.from(Buffer.from(String(s))),
      DigestAlgorithm: { SHA_256: 1 }, Charset: { UTF_8: 1 },
      sleep () {}, formatDate: () => '2026-01-01',
    },
    Session: { getActiveUser: () => ({ getEmail: () => '' }), getScriptTimeZone: () => 'UTC' },
  }
  vm.createContext(ctx)
  vm.runInContext(fuente, ctx, { filename: 'backend/Code.js' })

  // Dobles de las PUERTAS (no de lo que se mide): el gate, la identidad y la frescura.
  ctx.requireResumeToken_     = () => GID
  ctx.requireResumeTokenMemo_ = () => GID
  ctx._consumeMagicLinkNonce_ = () => false
  ctx._identidadDelEnlace_    = () => CORREO
  ctx._huellaDePagina_        = () => 'pv-sintetica'
  ctx._leerMarcaStepUp_       = () => ({ fresh: true, restante_s: 600, cierre: 'INACTIVIDAD' })
  ctx._markStepUpFresh_       = () => {}
  ctx._expedienteDelToken_    = () => ({ ok: true, fila: { enrollment_group_id: GID, resume_token: TOKEN, primary_email: CORREO } })
  ctx.effectiveRecoveredEmail_ = () => CORREO
  ctx.wizardResolverPreguntasDeHidratacion_ = () => {}
  ctx._redactSigningTokenIfNotFresh_ = (x) => x
  // EL CONTADOR DE VIAJES — es lo único que sustituye al KMS, y devuelve SU verdad.
  ctx.kmsProxy_ = (accion) => { viajes.push(accion); return COPIA_DEL_KMS() }

  return { ctx, cache, viajes }
}

// ── Afirmaciones ────────────────────────────────────────────────────────────────────────
const NOMBRES_QUE_CONDUCE = ['_wzCopiaAlDia_', '_wzCacheInvalidate_', '_espejoGuardarCopia_',
  '_wzCacheKey_', '_wzN_', '_versionDeClase_', 'hydrateSession_', '_bumpLiveStateVersion_']

function afirmaciones (fuente) {
  const fallos = []
  // `2026-09-23-un-arnes-que-no-afirma-nada-pasa` — cuántas afirmaciones REALES corrió
  // esta pasada, contadas EN EJECUCIÓN (no en el fuente).
  let total = 0
  const { ctx, cache, viajes } = cargar(fuente)

  // 0 — MEDICIÓN CIEGA: lo que este arnés conduce tiene que EXISTIR con ese nombre.
  const ausentes = NOMBRES_QUE_CONDUCE.filter((n) => typeof ctx[n] !== 'function')
  if (ausentes.length) return { ciego: true, fallos: ['MEDICIÓN CIEGA — no existen: ' + ausentes.join(', ')] }

  const p = { resume_token: TOKEN, n: N, language: 'es' }
  const clave = ctx._wzCacheKey_('hyd', GID + '_' + ctx._wzN_(N, null))

  // 1 — CON EL KMS CONFIRMANDO, LA COPIA SE REHACE.
  ctx._wzCacheInvalidate_(TOKEN)                 // el bump que hace el manejador al empezar
  const r1 = ctx._wzCopiaAlDia_(p, { ok: true }) // ...y el archivado del final
  total++
  if (!r1 || r1.rehecha !== true) fallos.push('con el KMS confirmando, la copia NO se rehizo (' + (r1 && r1.motivo) + ')')
  total++
  if (!cache.has(clave + '_meta')) fallos.push('la copia no quedó bajo la clave que lee el camino vivo')

  // 2 — Y EL CAMINO VIVO LA LEE: la hidratación de después NO viaja al KMS.
  viajes.length = 0
  const hid = ctx.hydrateSession_({ resume_token: TOKEN, n: N, language: 'es' })
  const viajesTrasRehacer = viajes.filter((a) => a === 'enr.hydrateApplication').length
  total++
  if (viajesTrasRehacer !== 0) fallos.push('tras rehacer, la hidratación siguió viajando al KMS (' + viajesTrasRehacer + ')')
  total++
  if (!hid || !hid.group || hid.group.enrollment_group_id !== GID) fallos.push('la hidratación servida desde la copia no trae el expediente')

  // 3 — ⛔ LA BARANDILLA: SI EL KMS ENCOLA, NO SE REHACE NADA.
  const b = cargar(fuente)
  const clave3 = b.ctx._wzCacheKey_('hyd', GID + '_' + b.ctx._wzN_(N, null))
  b.ctx._wzCacheInvalidate_(TOKEN)
  const r3 = b.ctx._wzCopiaAlDia_(p, { ok: true, queued: true })
  total++
  if (!r3 || r3.rehecha !== false || r3.motivo !== 'ENCOLADA') {
    fallos.push('con la escritura ENCOLADA se rehízo la copia: se serviría la foto de ANTES sellada como nueva')
  }
  total++
  if (b.cache.has(clave3 + '_meta')) fallos.push('con la escritura ENCOLADA quedó una copia archivada')
  total++
  if (b.viajes.length !== 0) fallos.push('con la escritura ENCOLADA se gastó un viaje al KMS')

  // 4 — LA COPIA SALE DEL KMS, NO DE LO QUE EL TUTOR MANDÓ. El dato que el KMS DESCARTA no
  //     puede aparecer en la copia archivada (los descartes del KMS son DEFINITIVOS).
  const c = cargar(fuente)
  const clave4 = c.ctx._wzCacheKey_('hyd', GID + '_' + c.ctx._wzN_(N, null))
  c.ctx._wzCacheInvalidate_(TOKEN)
  c.ctx._wzCopiaAlDia_({ resume_token: TOKEN, n: N, language: 'es',
                         persons: [LO_QUE_MANDO_EL_TUTOR] }, { ok: true })
  const guardado = leerTroceado(c.cache, clave4)
  total++
  if (guardado && JSON.stringify(guardado).indexOf('p-que-el-kms-descarta') !== -1) {
    fallos.push('la copia archivada lleva un dato que el KMS NO confirmó — se serviría como bueno algo descartado')
  }
  total++
  if (!guardado || !guardado.data || !Array.isArray(guardado.data.persons)
      || guardado.data.persons.length !== 1 || guardado.data.persons[0].person_id !== 'p-viva') {
    fallos.push('la copia archivada no es, tal cual, la que devolvió el KMS')
  }

  // 5 — UNA ESCRITURA POR MEDIO CANCELA EL ARCHIVO (si no, se sellaría como nueva una copia
  //     anterior a ese otro cambio).
  const d = cargar(fuente)
  const clave5 = d.ctx._wzCacheKey_('hyd', GID + '_' + d.ctx._wzN_(N, null))
  d.ctx._wzCacheInvalidate_(TOKEN)
  d.ctx.kmsProxy_ = () => { d.ctx._bumpLiveStateVersion_(GID, ['hyd']); return COPIA_DEL_KMS() }
  const r5 = d.ctx._wzCopiaAlDia_(p, { ok: true })
  total++
  if (!r5 || r5.rehecha !== false || r5.motivo !== 'OTRA_ESCRITURA_POR_MEDIO') {
    fallos.push('con otra escritura por medio se archivó igual (motivo=' + (r5 && r5.motivo) + ')')
  }
  total++
  if (d.cache.has(clave5 + '_meta')) fallos.push('con otra escritura por medio quedó una copia archivada')

  // 6 — LOS VIAJES DEL RECORRIDO, con y sin la pieza. Sin rehacer, la hidratación de después
  //     del guardado cuesta UN viaje; con la pieza, CERO. (El total del sistema no cambia: lo
  //     que cambia es quién espera.)
  const e = cargar(fuente)
  e.ctx._wzCacheInvalidate_(TOKEN)                 // escribe y NO rehace (lo de hoy)
  e.viajes.length = 0
  e.ctx.hydrateSession_({ resume_token: TOKEN, n: N, language: 'es' })
  const viajesSinLaPieza = e.viajes.filter((a) => a === 'enr.hydrateApplication').length
  total++
  if (viajesSinLaPieza !== 1) {
    fallos.push('la medición de referencia no cuadra: sin rehacer, la hidratación debería costar 1 viaje y costó ' + viajesSinLaPieza)
  }

  return { ciego: false, fallos, total, viajes: { sin: viajesSinLaPieza, con: viajesTrasRehacer } }
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

// ── Las ROTURAS DEMOSTRADAS: cada una tiene que poner ROJA su afirmación ─────────────────
const ROTURAS = [
  { nombre: 'se quita la guarda de «el KMS encoló» (la barandilla)',
    romper: (f) => f.replace("    if (respuestaDelKms.queued === true) return fuera('ENCOLADA');", '') },
  { nombre: 'se archiva bajo una clave que el camino vivo no lee',
    romper: (f) => f.replace(
      "    var clave = _wzCacheKey_('hyd', gid + '_' + _wzN_(p && p.n, p && p.recovered_email));",
      "    var clave = _wzCacheKey_('hyd', gid + '_otra_');") },
  { nombre: 'la copia se compone con lo que mandó el tutor en vez de con lo que dice el KMS',
    romper: (f) => f.replace(
      "    if (!data || typeof data !== 'object') return fuera('SIN_COPIA');",
      "    if (!data || typeof data !== 'object') return fuera('SIN_COPIA');\n" +
      "    if (p && p.persons) data.persons = (data.persons || []).concat(p.persons);") },
  { nombre: 'no se mira si otra escritura se coló por medio',
    romper: (f) => f.replace(
      "    if (_versionDeClase_(gid, 'hyd') !== vAntes) return fuera('OTRA_ESCRITURA_POR_MEDIO');", '') },
]

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
    // Las roturas: si una NO pone roja su afirmación, el arnés no es una red.
    const ciegas = []
    for (const r of ROTURAS) {
      const roto = r.romper(fuente)
      if (roto === fuente) { ciegas.push(r.nombre + ' (la mutilación no cambió el fuente — MEDICIÓN CIEGA)'); continue }
      let res
      try { res = afirmaciones(roto) } catch (e) { res = { ciego: false, fallos: ['excepción: ' + e.message] } }
      if (!res.fallos.length) ciegas.push(r.nombre + ' (rompiéndolo, el arnés SIGUE VERDE)')
      else console.log('  ✓ rotura demostrada — ' + r.nombre)
    }
    // Y el RENOMBRADO tiene que salir «MEDICIÓN CIEGA», no verde.
    const renombrado = fuente.split('_wzCopiaAlDia_').join('_wzCopiaAlDiaRenombrada_')
    const resRen = afirmaciones(renombrado)
    if (!resRen.ciego) ciegas.push('el renombrado de `_wzCopiaAlDia_` NO sale «MEDICIÓN CIEGA»')
    else console.log('  ✓ rotura demostrada — el renombrado sale MEDICIÓN CIEGA, no verde')

    if (ciegas.length) motivo = 'el arnés no es una red: ' + ciegas.join(' · ')
    else {
      console.log('  ✓ con el KMS CONFIRMANDO, la escritura deja la copia rehecha bajo la clave que lee la hidratación')
      console.log('  ✓ y la hidratación de después la sirve sin viajar al KMS (' + base.viajes.sin + ' viaje → ' + base.viajes.con + ')')
      console.log('  ✓ ⛔ con la escritura ENCOLADA no se rehace nada, no se archiva nada y no se gasta ni un viaje')
      console.log('  ✓ ⛔ la copia archivada es la que dice el KMS: un dato que el KMS descartó NO aparece en ella')
      console.log('  ✓ otra escritura por medio cancela el archivado en vez de sellar lo viejo como nuevo')
      console.log('  ✓ ejecutado sobre `backend/Code.js` REAL, en un vm con dobles: sin red, sin navegador, sin datos reales')
    }
  }
} catch (e) {
  motivo = 'error fatal — ' + (e && e.message)
} finally {
  const total = base && !base.ciego ? base.total : 0
  console.log(motivo ? `VEREDICTO: ROJO — ${motivo}` : `VEREDICTO: VERDE — ${total} afirmaciones`)
  process.exitCode = motivo ? 1 : 0
}
