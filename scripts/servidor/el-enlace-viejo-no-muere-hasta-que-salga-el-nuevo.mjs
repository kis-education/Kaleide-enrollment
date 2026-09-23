#!/usr/bin/env node
/**
 * ⛔ `2026-09-23-el-enlace-se-sustituye-antes-de-mandarlo`
 *
 * QUÉ PROTEGE ESTE ARNÉS, en una frase: que **una familia nunca se quede sin enlace válido
 * por un correo que no salió** — si el envío no se acepta, la solicitud queda EXACTAMENTE
 * como estaba, con el enlace que la familia ya tenía, funcionando.
 *
 * Las TRES afirmaciones, sobre las DOS ramas de `sendMagicLink_`:
 *   1. envío que SALE  ⇒ el enlace queda ROTADO y NO se repone nada;
 *   2. envío que FALLA ⇒ el enlace queda COMO ESTABA (se pide `enr.reponerEnlaceAnterior`
 *      con el token viejo) y la familia sigue entrando con el suyo;
 *   3. la rama PÚBLICA devuelve **lo mismo en los dos casos** —mismos campos, mismo `sent`
 *      y `warm_ticket` presente con la misma forma—: el ack constante de WIZ-ENUM no puede
 *      depender de si el correo salió. ⚠️ El VALOR del ticket es de un solo uso y cambia en
 *      cualquier par de llamadas, así que se compara tapado; exigirlo igual mediría el
 *      reloj, no el producto.
 * Y una cuarta que es la del correo de N enlaces: si ese correo no se acepta se reponen
 * LOS N — uno solo repuesto dejaría a la misma familia dentro de una solicitud y fuera de
 * otra.
 *
 * ⛔ **NO ES UN DETECTOR POR LÍNEAS: EJECUTA EL CÓDIGO REAL.** Carga `backend/Code.js`
 * entero en un `vm` con dobles en memoria (ni red, ni navegador, ni `npm ci`, ni un solo
 * dato real: todo sintético en el dominio reservado `.invalid`, RFC 2606) y llama a
 * `sendMagicLink_` de verdad, con el KMS sustituido por un contador de llamadas.
 *
 * ⛔ **Y SE ROMPE A PROPÓSITO.** Cada afirmación se vuelve a correr sobre una copia
 * MUTILADA del fuente y tiene que salir ROJA; el RENOMBRADO tiene que salir «MEDICIÓN
 * CIEGA», nunca verde.
 *
 * ⚠️ **LO QUE NO AFIRMA, y hay que decirlo para que nadie lo dé por cubierto:**
 *   · **no habla con el KMS ni con Apps Script**, así que no dice nada sobre si el KMS acepta
 *     la reposición — afirma lo que DECIDE este backend;
 *   · **NO cubre el TERCER sitio**, que vive en el otro repositorio: el botón «invitar a una
 *     familia» (`kis-app kms-server/enr/invite.gs`, `enr_emitirEnlace_`) y el escritor
 *     `enr_reponerTokenDelGrupo_` (`enr/wizard-gateway.gs`). Ese lado **hoy no tiene control
 *     permanente**: se comprobó con un instrumento efímero el 2026-09-23 y el control fijo
 *     tendría que vivir en `kis-app`, que es otra decisión;
 *   · **no mide tiempos** (D50).
 *
 * Veredicto: ÚLTIMA línea, SIEMPRE impresa, incluso ante error fatal.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// ── Datos SINTÉTICOS. Ni un dato real, y el dominio es el reservado (RFC 2606). ──────────
const GID_A     = '11111111-1111-4111-8111-111111111111'
const GID_B     = '55555555-5555-4555-8555-555555555555'
const VIEJO_A   = '22222222-2222-4222-8222-222222222222'
const VIEJO_B   = '66666666-6666-4666-8666-666666666666'
const NUEVO_A   = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'
const NUEVO_B   = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'
const CORREO    = 'tutor@example.invalid'

const FILA = (gid, token) => ({
  enrollment_group_id: gid, resume_token: token, primary_email: CORREO,
  submitted_at: null, abandoned_at: null, created_at: '2026-09-01T00:00:00.000Z',
  preferred_language: 'es',
})

/** El banco de pruebas: carga el fuente REAL en un `vm` con dobles. */
function cargar (fuente, opciones) {
  const o = opciones || {}
  const cache = new Map()
  const kms = []          // cada llamada al KMS, con su acción y su cuerpo
  const correos = []      // cada correo que el asistente pide mandar
  const ctx = {
    console: { log () {}, error () {} },
    Logger: { log () {} },
    CacheService: {
      getScriptCache: () => ({
        get: (k) => (cache.has(k) ? cache.get(k) : null),
        put: (k, v) => { cache.set(k, String(v)) },
        putAll: (obj) => { Object.keys(obj).forEach((k) => cache.set(k, String(obj[k]))) },
        getAll: (ks) => { const r = {}; ks.forEach((k) => { if (cache.has(k)) r[k] = cache.get(k) }); return r },
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
      base64DecodeWebSafe: (s) => Array.from(Buffer.from(String(s), 'base64url')),
      computeDigest: (s) => Array.from(Buffer.from(String(s))),
      computeHmacSha256Signature: (s) => Array.from(Buffer.from(String(s))),
      DigestAlgorithm: { SHA_256: 1 }, Charset: { UTF_8: 1 },
      sleep () {}, formatDate: () => '2026-01-01', newBlob: (s) => ({ getBytes: () => Array.from(Buffer.from(String(s))) }),
    },
    Session: { getActiveUser: () => ({ getEmail: () => '' }), getScriptTimeZone: () => 'UTC' },
  }
  vm.createContext(ctx)
  vm.runInContext(fuente, ctx, { filename: 'backend/Code.js' })

  // ── Dobles de las PUERTAS (no de lo que se mide) ───────────────────────────────────────
  ctx._verjaPublicaVeredicto_   = () => ({ ok: true })
  ctx._checkMagicLinkRateLimit_ = () => {}
  ctx._checkMagicLinkRateLimitIp_ = () => {}
  ctx.requireResumeToken_       = () => GID_A
  ctx._expedienteDelToken_      = (t) => ({ ok: true, fila: FILA(GID_A, t) })
  ctx._tutorQueRecupera_        = () => ({ tutor: true, email_id: null })
  ctx._recuperacionDeLaCache_   = () => null
  ctx._guardarRecuperacionEnCache_ = () => {}
  ctx._recuperacionDelCorreo_   = () => ({
    porCorreoPrincipal: (o.grupos || [FILA(GID_A, VIEJO_A)]).slice(),
    porTutor: [], identificadorDeCorreo: {},
  })
  ctx._mintMagicLinkNonce_      = () => {}
  // Forma UUID a propósito: en producción el ticket REAL y el SEÑUELO salen los dos de
  // `generateUuid_()`, así que un doble con otra forma mediría lo que él inventa.
  ctx._mintWarmTicket_          = () => '77777777-7777-4777-8777-777777777777'
  ctx._dejarElClicSinLlamadas_  = () => {}
  ctx._kmsRenderGdprBlock_      = () => ''
  ctx._kmsRenderResumeLinksBlock_ = () => ''
  ctx.initEnrollmentSession_    = () => ({ warm_ticket: 'ticket-sintetico' })

  // EL KMS — lo único que se sustituye del otro lado. Devuelve SU verdad y se apunta todo.
  const nuevoPorViejo = { [VIEJO_A]: NUEVO_A, [VIEJO_B]: NUEVO_B }
  ctx.kmsProxy_ = (accion, cuerpo) => {
    kms.push({ accion, cuerpo })
    if (accion === 'enr.renewApplicationSession') {
      const nt = nuevoPorViejo[cuerpo.resume_token]
      return nt ? { resume_token: nt, renewed: true } : { resume_token: cuerpo.resume_token, renewed: false }
    }
    if (accion === 'enr.reponerEnlaceAnterior') return { repuesto: true }
    return {}
  }
  // EL ENVÍO — sale o no sale, y falla como falla de verdad (`_kmsPideQueEnvie_`).
  ctx.sendViaKmsNotify_ = (plantilla, destino) => {
    correos.push({ plantilla, destino })
    if (o.elCorreoNoSale) {
      const e = new Error('El KMS no aceptó el envío de ' + plantilla)
      e.code = 'EMAIL_SEND_FAILED'
      throw e
    }
    return { sent: true }
  }

  return { ctx, kms, correos }
}

const reposiciones = (kms) => kms.filter((v) => v.accion === 'enr.reponerEnlaceAnterior')

const NOMBRES_QUE_CONDUCE = ['sendMagicLink_', '_conLosEnlacesRotados_', '_reponerElEnlace_',
  '_magicLinkConstantAck_', '_olvidarCabeceraMemo_', '_moverLaCopiaDeLaPuerta_']

function afirmaciones (fuente) {
  const fallos = []

  // 0 — MEDICIÓN CIEGA: lo que este arnés conduce tiene que EXISTIR con ese nombre.
  const sonda = cargar(fuente, {})
  const ausentes = NOMBRES_QUE_CONDUCE.filter((n) => typeof sonda.ctx[n] !== 'function')
  if (ausentes.length) return { ciego: true, fallos: ['MEDICIÓN CIEGA — no existen: ' + ausentes.join(', ')] }

  // ── RAMA PÚBLICA (teclear el correo en la portada) ─────────────────────────────────────
  // 1 — EL CORREO SALE ⇒ el enlace queda ROTADO y NO se repone nada.
  const a = cargar(fuente, {})
  const ackSale = a.ctx.sendMagicLink_({ primary_email: CORREO, recaptcha_token: 'x' })
  if (a.correos.length !== 1) fallos.push('pública, correo que SALE: se pidió ' + a.correos.length + ' correo(s) en vez de 1')
  if (reposiciones(a.kms).length !== 0) {
    fallos.push('pública, correo que SALE: se repuso el enlace igualmente — la rotación buena se estaría deshaciendo')
  }

  // 2 — ⛔ EL CORREO NO SALE ⇒ EL ENLACE QUEDA COMO ESTABA.
  const b = cargar(fuente, { elCorreoNoSale: true })
  const ackNoSale = b.ctx.sendMagicLink_({ primary_email: CORREO, recaptcha_token: 'x' })
  const rep = reposiciones(b.kms)
  if (rep.length !== 1) {
    fallos.push('pública, correo que NO SALE: se pidieron ' + rep.length + ' reposiciones en vez de 1 '
      + '⇒ la familia se queda sin enlace ninguno')
  } else {
    if (rep[0].cuerpo.token_anterior !== VIEJO_A) {
      fallos.push('pública: se repuso «' + rep[0].cuerpo.token_anterior + '» y no el enlace que la familia tenía')
    }
    if (rep[0].cuerpo.resume_token !== NUEVO_A) {
      fallos.push('pública: la reposición no se pide sobre el token RECIÉN ROTADO (KAL-4: el expediente sale del token)')
    }
  }

  // 3 — ⛔ LA RAMA PÚBLICA DEVUELVE LO MISMO EN LOS DOS CASOS (WIZ-ENUM).
  //
  // ⚠️ «Byte a byte» se mide con el TICKET TAPADO, y no es una rebaja: el `warm_ticket` es
  // un identificador de un solo uso, así que **dos llamadas cualesquiera** traen valores
  // distintos — exigir el mismo valor mediría el reloj, no el producto. Lo que NO puede
  // cambiar es la FORMA: los mismos campos, el mismo `sent`, y el ticket PRESENTE en los
  // dos casos (su ausencia sería el oráculo que `_magicLinkConstantAck_` cierra; por eso el
  // camino sin nada que calentar mintea un SEÑUELO, y los dos salen de `generateUuid_()`).
  const FORMA_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
  const tapado = (r) => JSON.stringify(r && Object.keys(r).sort().reduce((o, k) => {
    o[k] = (k === 'warm_ticket') ? '<ticket>' : r[k]; return o
  }, {}))
  if (tapado(ackSale) !== tapado(ackNoSale)) {
    fallos.push('pública: la respuesta CAMBIA según si el correo salió (' + tapado(ackSale)
      + ' vs ' + tapado(ackNoSale) + ') — eso reabre el oráculo de enumeración')
  }
  if (!FORMA_UUID.test(String(ackSale && ackSale.warm_ticket))
      || !FORMA_UUID.test(String(ackNoSale && ackNoSale.warm_ticket))) {
    fallos.push('pública: el `warm_ticket` no tiene la misma forma en los dos casos — '
      + 'su ausencia o su forma delatarían si ese correo tiene solicitud')
  }

  // 4 — EL CORREO DE N ENLACES: si no se acepta, se reponen LOS N.
  const c = cargar(fuente, {
    elCorreoNoSale: true,
    grupos: [FILA(GID_A, VIEJO_A), FILA(GID_B, VIEJO_B)],
  })
  c.ctx.sendMagicLink_({ primary_email: CORREO, recaptcha_token: 'x' })
  const repN = reposiciones(c.kms)
  if (repN.length !== 2) {
    fallos.push('pública con DOS expedientes y un solo correo que no sale: se repusieron ' + repN.length
      + ' de 2 — la familia quedaría dentro de una solicitud y fuera de otra')
  }

  // ── RAMA «GUARDAR Y SEGUIR LUEGO» (dentro de la sesión, con el enlace en la mano) ──────
  // 5 — EL CORREO SALE ⇒ rotado, sin reponer, y el error NO se inventa.
  const d = cargar(fuente, {})
  const r5 = d.ctx.sendMagicLink_({ resume_token: VIEJO_A })
  if (!r5 || r5.sent !== true) fallos.push('interna, correo que SALE: no contestó `sent:true`')
  if (reposiciones(d.kms).length !== 0) fallos.push('interna, correo que SALE: se repuso el enlace igualmente')

  // 6 — ⛔ EL CORREO NO SALE ⇒ se repone Y el error SE PROPAGA (esta rama sí los propaga).
  const e = cargar(fuente, { elCorreoNoSale: true })
  let lanzo = null
  try { e.ctx.sendMagicLink_({ resume_token: VIEJO_A }) } catch (err) { lanzo = err }
  const repI = reposiciones(e.kms)
  if (repI.length !== 1) {
    fallos.push('interna, correo que NO SALE: se pidieron ' + repI.length + ' reposiciones en vez de 1')
  } else if (repI[0].cuerpo.token_anterior !== VIEJO_A) {
    fallos.push('interna: se repuso «' + repI[0].cuerpo.token_anterior + '» y no el enlace que la familia tenía')
  }
  if (!lanzo || lanzo.code !== 'EMAIL_SEND_FAILED') {
    fallos.push('interna: el fallo del envío dejó de propagarse (' + (lanzo && lanzo.code) + ') — '
      + 'quien pulsó «guardar y seguir luego» creería que su correo salió')
  }

  // 7 — LA REPOSICIÓN ES BEST-EFFORT: si el KMS tampoco puede, NO se tapa el error del envío.
  const f = cargar(fuente, { elCorreoNoSale: true })
  const kmsOriginal = f.ctx.kmsProxy_
  f.ctx.kmsProxy_ = (accion, cuerpo) => {
    if (accion === 'enr.reponerEnlaceAnterior') { kmsOriginal(accion, cuerpo); throw new Error('el KMS no contesta') }
    return kmsOriginal(accion, cuerpo)
  }
  let lanzo7 = null
  try { f.ctx.sendMagicLink_({ resume_token: VIEJO_A }) } catch (err) { lanzo7 = err }
  if (!lanzo7 || lanzo7.code !== 'EMAIL_SEND_FAILED') {
    fallos.push('con la reposición también caída, el error que se ve ya no es el del envío ('
      + (lanzo7 && lanzo7.message) + ') — se estaría tapando la causa')
  }

  return { ciego: false, fallos }
}

// ── Las ROTURAS DEMOSTRADAS: cada una tiene que poner ROJA su afirmación ─────────────────
const ROTURAS = [
  { nombre: 'se vuelve al orden viejo: rotar, mandar, y si no sale no reponer nada',
    romper: (f) => f.replace(
      '    (rotaciones || []).forEach(function (r) { _reponerElEnlace_(r); });\n', '') },
  { nombre: 'la rama pública deja de apuntar lo que rotó (no habría qué reponer)',
    romper: (f) => f.replace(
      "            rotaciones.push({ token_viejo: g.resume_token, token_nuevo: touch.resume_token,\n"
      + "                              grupo_id: g.enrollment_group_id });\n", '') },
  { nombre: 'la rama interna deja de apuntar lo que rotó',
    romper: (f) => f.replace(
      "      if (rotado) rotaciones.push({ token_viejo: p.resume_token, token_nuevo: tokenToSend, grupo_id: groupId });\n", '') },
  { nombre: 'se repone con el token NUEVO en vez de con el que la familia tenía',
    romper: (f) => f.replace(
      '      token_anterior: r.token_viejo,', '      token_anterior: r.token_nuevo,') },
  { nombre: 'la reposición deja de ser best-effort y tapa el error del envío',
    romper: (f) => f.replace(
      '  } catch (e) {\n    repuesto = false;\n  }',
      '  } catch (e) {\n    throw e;\n  }') },
]

let motivo = null
try {
  const fuente = readFileSync(join(RAIZ, 'backend/Code.js'), 'utf8')
  const base = afirmaciones(fuente)

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
    // Y el RENOMBRADO tiene que salir «MEDICIÓN CIEGA», no verde.
    const renombrado = fuente.split('_conLosEnlacesRotados_').join('_conLosEnlacesRotadosRenombrado_')
    const resRen = afirmaciones(renombrado)
    if (!resRen.ciego) ciegas.push('el renombrado de `_conLosEnlacesRotados_` NO sale «MEDICIÓN CIEGA»')
    else console.log('  ✓ rotura demostrada — el renombrado sale MEDICIÓN CIEGA, no verde')

    if (ciegas.length) motivo = 'el arnés no es una red: ' + ciegas.join(' · ')
    else {
      console.log('  ✓ el correo SALE ⇒ el enlace queda rotado y no se repone nada (las dos ramas)')
      console.log('  ✓ ⛔ el correo NO SALE ⇒ se repone EL QUE LA FAMILIA TENÍA, sobre el token recién rotado (KAL-4)')
      console.log('  ✓ ⛔ la rama pública devuelve lo MISMO en los dos casos: mismos campos, mismo `sent` y ticket presente con la misma forma (WIZ-ENUM)')
      console.log('  ✓ con DOS expedientes en un solo correo que no sale, se reponen LOS DOS')
      console.log('  ✓ la rama «guardar y seguir luego» sigue propagando el fallo del envío, ya sin dejar a nadie fuera')
      console.log('  ✓ con la reposición TAMBIÉN caída, el error que se ve sigue siendo el del envío')
      console.log('  ✓ ejecutado sobre `backend/Code.js` REAL, en un vm con dobles: sin red, sin navegador, sin datos reales')
    }
  }
} catch (e) {
  motivo = 'error fatal — ' + (e && e.message)
} finally {
  console.log(motivo ? `VEREDICTO: ROJO — ${motivo}` : 'VEREDICTO: VERDE')
  process.exitCode = motivo ? 1 : 0
}
