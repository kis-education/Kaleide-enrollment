#!/usr/bin/env node
/**
 * ⛔ **D213 (Diego, 2026-09-23): «Lo que sí importa es que los padres no se cancelen unos a
 * otros al pedir enlaces.»**
 *
 * QUÉ PROTEGE ESTE ARNÉS, en una frase: que **lo que hace un tutor no eche al otro** — ni su
 * enlace, ni su ventana de diez minutos.
 *
 * Las CINCO afirmaciones, todas sobre `backend/Code.js` REAL:
 *   1. el tutor B teclea SU código ⇒ **la ventana de A sigue abierta** (hasta hoy la marca
 *      vivía en UNA sola ranura por expediente y la de B pisaba la de A);
 *   2. la marca de B **no le sirve a A**: el atado al buzón de ②24 no se afloja;
 *   3. **un enlace SIN `?n=` sigue entrando** — los hay en circulación: su marca cae en la
 *      ranura de siempre y se comporta como ayer, byte a byte;
 *   4. «sigo aquí» **extiende la ventana DE QUIEN PULSA** y no la del otro;
 *   5. cuando el asistente le pide al KMS que renueve o que reponga un enlace, **le dice de
 *      QUÉ TUTOR es** (el `?n=` viaja en el cuerpo): sin eso el KMS no puede guardar el
 *      enlace en la ranura de su dueño y volvería a haber uno solo para los dos.
 *
 * ⛔ **NO ES UN DETECTOR POR LÍNEAS: EJECUTA EL CÓDIGO REAL.** Carga `backend/Code.js` entero
 * en un `vm` con dobles en memoria (ni red, ni navegador, ni `npm ci`, ni un solo dato real:
 * todo sintético y en el dominio reservado `.invalid`, RFC 2606).
 *
 * ⛔ **Y SE ROMPE A PROPÓSITO.** Cada afirmación se vuelve a correr sobre una copia MUTILADA
 * del fuente y tiene que salir ROJA; el RENOMBRADO tiene que salir «MEDICIÓN CIEGA».
 *
 * ⚠️ **LO QUE NO AFIRMA, dicho para que nadie lo dé por cubierto:**
 *   · **la otra mitad vive en el KMS** (`kis-app kms-server/enr/enlace-por-tutor.gs` y
 *     `enr_resolveWizardSession_`): que el enlace de cada tutor se guarde en SU ranura y que
 *     el del otro siga abriendo lo decide aquél, y **ese lado no tiene control permanente**
 *     — la carpeta de arneses es de este repositorio;
 *   · **no habla con el KMS ni con Apps Script**: afirma lo que DECIDE este backend;
 *   · **no mide tiempos** (D50).
 *
 * Veredicto: ÚLTIMA línea, SIEMPRE impresa, incluso ante error fatal.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'
import vm from 'node:vm'

const RAIZ = join(dirname(fileURLToPath(import.meta.url)), '..', '..')

// ── Datos SINTÉTICOS. Ni un dato real; dominio reservado (RFC 2606). ─────────────────────
const GID      = '11111111-1111-4111-8111-111111111111'
const TOK_A    = '22222222-2222-4222-8222-222222222222'
const TOK_B    = '33333333-3333-4333-8333-333333333333'
const N_A      = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'   // el `?n=` del enlace de A
const N_B      = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'   // el `?n=` del enlace de B
const PAGINA_A = 'a1a1a1a1a1a1'
const PAGINA_B = 'b2b2b2b2b2b2'
const MAIL_A   = 'tutora@example.invalid'
const MAIL_B   = 'tutorb@example.invalid'

/** El banco de pruebas: carga el fuente REAL en un `vm` con dobles en memoria. */
function cargar (fuente) {
  const cache = new Map()
  const kms = []
  // Lo que el asistente manda DE VERDAD al KMS: el doble del transporte lo apunta y corta.
  const cuerposAlKms = []
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
    PropertiesService: { getScriptProperties: () => ({
      getProperty: (k) => (k === 'KMS_DEPLOYMENT_URL' ? 'https://x/exec' : (k === 'QB_SERVICE_TOKEN' ? 'st' : null)),
      setProperty () {},
    }) },
    // ⛔ Sin red: se apunta el cuerpo que iba a salir y se corta ahí mismo.
    UrlFetchApp: {
      fetch (_url, o) {
        try { cuerposAlKms.push(JSON.parse(o.payload).payload) } catch (e) { cuerposAlKms.push(null) }
        throw new Error('el arnés no sale a la red')
      },
      fetchAll () { throw new Error('el arnés no sale a la red') },
    },
    ScriptApp: { getOAuthToken: () => 'x', getService: () => ({ getUrl: () => 'https://x/exec' }),
                 getProjectTriggers: () => [] },
    Utilities: {
      getUuid: () => '44444444-4444-4444-8444-444444444444',
      base64EncodeWebSafe: (s) => Buffer.from(String(s)).toString('base64url'),
      base64DecodeWebSafe: (s) => Array.from(Buffer.from(String(s), 'base64url')),
      // La huella del buzón sale de aquí: se devuelve algo que DEPENDE del correo, o los
      // dos tutores tendrían la misma huella y la afirmación 2 pasaría en vacío.
      computeDigest: (_alg, s) => Array.from(Buffer.from(String(s).padEnd(32, '.')).subarray(0, 32)),
      computeHmacSha256Signature: (s) => Array.from(Buffer.from(String(s))),
      DigestAlgorithm: { SHA_256: 1 }, Charset: { UTF_8: 1 },
      sleep () {}, formatDate: () => '2026-01-01',
      newBlob: (s) => ({ getBytes: () => Array.from(Buffer.from(String(s))) }),
    },
    Session: { getActiveUser: () => ({ getEmail: () => '' }), getScriptTimeZone: () => 'UTC' },
  }
  vm.createContext(ctx)
  vm.runInContext(fuente, ctx, { filename: 'backend/Code.js' })

  // ── Dobles de las PUERTAS (no de lo que se mide) ───────────────────────────────────────
  ctx.requireResumeToken_ = () => GID
  // De quién es el enlace: lo dice el `?n=` del cuerpo, como en producción.
  ctx._identidadDelEnlace_ = (p) => (p && p.n === N_B ? MAIL_B : (p && p.n === N_A ? MAIL_A : MAIL_A))
  ctx._expedienteDelToken_ = (t) => ({ ok: true, fila: {
    enrollment_group_id: GID, resume_token: t, primary_email: MAIL_A,
    submitted_at: null, abandoned_at: null, created_at: '2026-09-20T00:00:00.000Z',
    preferred_language: 'es',
  } })
  ctx._tutorQueRecupera_ = (_t, o) => ({ tutor: true, email_id: (o && o.correo === MAIL_B) ? N_B : N_A })
  ctx._recuperacionDeLaCache_ = () => null
  ctx._guardarRecuperacionEnCache_ = () => {}
  ctx._mintMagicLinkNonce_ = () => {}
  ctx._verjaPublicaVeredicto_ = () => ({ ok: true })
  ctx._checkMagicLinkRateLimit_ = () => {}
  ctx._checkMagicLinkRateLimitIp_ = () => {}
  ctx._mintWarmTicket_ = () => '77777777-7777-4777-8777-777777777777'
  ctx._moverLaCopiaDeLaPuerta_ = () => false
  ctx._olvidarCabeceraMemo_ = () => {}
  ctx._kmsRenderResumeLinksBlock_ = () => ''
  ctx.initEnrollmentSession_ = () => ({ warm_ticket: 'x' })
  // La recuperación por correo: UN expediente, y el `?n=` de ESTE buzón en él (el de B).
  ctx._recuperacionDelCorreo_ = () => ({
    porCorreoPrincipal: [{ enrollment_group_id: GID, resume_token: TOK_A, primary_email: MAIL_B,
      submitted_at: null, abandoned_at: null, created_at: '2026-09-20T00:00:00.000Z',
      preferred_language: 'es' }],
    porTutor: [],
    identificadorDeCorreo: { [GID]: N_B },
  })
  ctx._dejarElClicSinLlamadas_ = () => {}
  ctx._kmsRenderGdprBlock_ = () => ''
  ctx.sendViaKmsNotify_ = () => ({ sent: true })

  // EL KMS — se apunta TODO lo que se le manda. ⛔ El proxy REAL se conserva aparte: la
  // afirmación 5 mide el CUERPO que compone él, no el del doble.
  const kmsProxyReal = ctx.kmsProxy_
  ctx.kmsProxy_ = (accion, cuerpo) => {
    kms.push({ accion, cuerpo })
    if (accion === 'enr.renewApplicationSession') return { resume_token: TOK_B, renewed: true }
    return {}
  }
  return { ctx, kms, cache, cuerposAlKms, kmsProxyReal }
}

const NOMBRES_QUE_CONDUCE = ['_markStepUpFresh_', '_isStepUpFresh_', '_leerMarcaStepUp_',
  '_extenderVentanaStepUp_', '_discriminadorDeMarca_', '_claveMarcaStepUp_',
  'refrescarVentanaDeInactividad_', 'sendMagicLink_']

/** La clave que ESTE arnés espera; se escribe aquí a propósito, para que un cambio de la
 *  clave real salga como diferencia y no se tape solo. */
const _claveEsperada = (gid, disc) => 'stepup_ok_' + gid + (disc ? '|' + disc : '')

function afirmaciones (fuente) {
  const fallos = []
  // `2026-09-23-un-arnes-que-no-afirma-nada-pasa` — cuántas afirmaciones REALES corrió
  // esta pasada, contadas EN EJECUCIÓN (no en el fuente): un `total` que se quedara a
  // cero por una excepción tapada o un renombrado tiene que poder DECIRLO.
  let total = 0

  // 0 — MEDICIÓN CIEGA: lo que este arnés conduce tiene que EXISTIR con ese nombre.
  const sonda = cargar(fuente)
  const ausentes = NOMBRES_QUE_CONDUCE.filter((n) => typeof sonda.ctx[n] !== 'function')
  if (ausentes.length) return { ciego: true, fallos: ['MEDICIÓN CIEGA — no existen: ' + ausentes.join(', ')] }

  // 1 — ⛔ EL TUTOR B TECLEA SU CÓDIGO Y LA VENTANA DE A SIGUE ABIERTA.
  {
    const s = cargar(fuente)
    s.ctx._markStepUpFresh_(GID, 'OTP', MAIL_A, PAGINA_A, N_A)
    s.ctx._markStepUpFresh_(GID, 'OTP', MAIL_B, PAGINA_B, N_B)
    total++
    if (!s.ctx._isStepUpFresh_(GID, MAIL_A, PAGINA_A, N_A)) {
      fallos.push('el tutor B acreditó su buzón y a A LO ECHARON de su propia solicitud '
        + '(la marca sigue siendo una sola por expediente) — es justo lo que D213 cierra')
    }
    total++
    if (!s.ctx._isStepUpFresh_(GID, MAIL_B, PAGINA_B, N_B)) {
      fallos.push('el tutor B acreditó su buzón y su propia ventana no quedó abierta')
    }
  }

  // 2 — La marca de B NO le sirve a A: el atado al buzón (②24) no se afloja.
  {
    const s = cargar(fuente)
    s.ctx._markStepUpFresh_(GID, 'OTP', MAIL_B, PAGINA_B, N_B)
    total++
    if (s.ctx._isStepUpFresh_(GID, MAIL_A, PAGINA_A, N_A)) {
      fallos.push('A pasa la puerta con la ventana que se ganó B — el atado al buzón de ②24 se ha aflojado')
    }
  }

  // 3 — ⛔ UN ENLACE SIN `?n=` SIGUE ENTRANDO, con la ranura de siempre.
  {
    const s = cargar(fuente)
    s.ctx._markStepUpFresh_(GID, 'OTP', MAIL_A, PAGINA_A, '')
    total++
    if (!s.ctx._isStepUpFresh_(GID, MAIL_A, PAGINA_A, '')) {
      fallos.push('un enlace SIN `?n=` ya no puede acreditar su buzón — y los hay en circulación')
    }
    // Y quien acredita CON `n` y luego guarda sin él tampoco se queda fuera.
    const t = cargar(fuente)
    t.ctx._markStepUpFresh_(GID, 'OTP', MAIL_A, PAGINA_A, N_A)
    total++
    if (!t.ctx._isStepUpFresh_(GID, MAIL_A, PAGINA_A, '')) {
      fallos.push('quien acreditó su buzón con `?n=` se queda fuera en cuanto una llamada no lo manda')
    }
  }

  // 4 — «SIGO AQUÍ» EXTIENDE LA VENTANA DE QUIEN PULSA, NO LA DEL OTRO.
  {
    const s = cargar(fuente)
    s.ctx._markStepUpFresh_(GID, 'OTP', MAIL_A, PAGINA_A, N_A)
    s.ctx._markStepUpFresh_(GID, 'OTP', MAIL_B, PAGINA_B, N_B)
    const r = s.ctx.refrescarVentanaDeInactividad_({ resume_token: TOK_A, n: N_A, pv: PAGINA_A })
    total++
    if (!r || r.step_up_fresh !== true || !(r.step_up_restante_s > 0)) {
      fallos.push('«sigo aquí» dejó de extender la ventana del tutor que pulsa (' + JSON.stringify(r) + ')')
    }
    total++
    if (!s.ctx._isStepUpFresh_(GID, MAIL_B, PAGINA_B, N_B)) {
      fallos.push('«sigo aquí» de A se llevó por delante la ventana de B')
    }
    // ⛔ Y SE EXTIENDE LA RANURA QUE SE LEYÓ, no otra: una ranura nueva significa que la
    // ventana de A se quedó sin estirar y que la escritura fue a parar a donde no la lee nadie.
    const esperadas = [_claveEsperada(GID, N_A), _claveEsperada(GID, N_B), _claveEsperada(GID, '')]
    const sobrantes = [...s.cache.keys()].filter((k) => k.indexOf('stepup_ok_') === 0 && esperadas.indexOf(k) === -1)
    total++
    if (sobrantes.length) {
      fallos.push('«sigo aquí» escribió en una ranura que nadie lee (' + sobrantes.join(', ')
        + ') ⇒ la ventana del tutor que pulsa no se está estirando')
    }
  }

  // 5 — ⛔ AL KMS SE LE DICE DE QUÉ TUTOR ES EL ENLACE QUE SE RENUEVA.
  {
    const s = cargar(fuente)
    s.ctx._N_DE_LA_PETICION_ = N_B
    // Se llama al `kmsProxy_` REAL: lo que se mide es el CUERPO que compone, no la respuesta.
    try { s.kmsProxyReal('enr.renewApplicationSession', { resume_token: TOK_A }) } catch (e) { /* cortado */ }
    const c1 = s.cuerposAlKms[0]
    total++
    if (!c1) {
      fallos.push('MEDICIÓN CIEGA — no se llegó a ver el cuerpo que `kmsProxy_` manda al KMS')
    } else if (c1.n !== N_B) {
      fallos.push('el asistente le pide al KMS que renueve el enlace SIN decirle de qué tutor es ('
        + JSON.stringify(c1.n) + ') ⇒ el KMS no puede guardarlo en la ranura de su dueño '
        + 'y los dos tutores vuelven a compartir uno solo')
    }
    // Y lo que el llamante declara MANDA: nunca se pisa.
    const t = cargar(fuente)
    t.ctx._N_DE_LA_PETICION_ = N_B
    try { t.kmsProxyReal('enr.reponerEnlaceAnterior', { resume_token: TOK_B, n: N_A }) } catch (e) { /* cortado */ }
    total++
    if (t.cuerposAlKms[0] && t.cuerposAlKms[0].n !== N_A) {
      fallos.push('el `?n=` que el llamante declara se está pisando con el de la petición')
    }
    // Y sin enlace en el cuerpo no se añade nada (no habría con qué casarlo).
    const u = cargar(fuente)
    u.ctx._N_DE_LA_PETICION_ = N_B
    try { u.kmsProxyReal('enr.recuperacionDelCorreo', { correo: MAIL_A }) } catch (e) { /* cortado */ }
    total++
    if (u.cuerposAlKms[0] && u.cuerposAlKms[0].n) {
      fallos.push('se está mandando el `?n=` en cuerpos que no llevan enlace')
    }
  }

  // 6 — ⛔ LOS DOS CAMINOS QUE EMITEN LE DICEN AL KMS DE QUÉ TUTOR ES EL ENLACE.
  //     El de la PORTADA es el principal, y es justo el que no lleva `?n=` en su petición:
  //     si no se lo dijera, el KMS solo tocaría la casilla de la ficha y **la recuperación
  //     desde la portada seguiría cancelando el enlace del otro tutor**.
  {
    const s = cargar(fuente)
    s.ctx.sendMagicLink_({ primary_email: MAIL_B, recaptcha_token: 'x' })
    const renov = s.kms.filter((v) => v.accion === 'enr.renewApplicationSession')
    total++
    if (renov.length !== 1) {
      fallos.push('portada: se pidieron ' + renov.length + ' renovaciones en vez de 1')
    } else if (renov[0].cuerpo.n !== N_B) {
      fallos.push('⛔ la recuperación DESDE LA PORTADA renueva el enlace sin decir de qué tutor es ('
        + JSON.stringify(renov[0].cuerpo.n) + ') ⇒ el otro tutor se sigue quedando fuera')
    }
    // Y si el correo NO sale, la reposición también dice de quién es.
    const t = cargar(fuente)
    t.ctx.sendViaKmsNotify_ = () => { const e = new Error('no salió'); e.code = 'EMAIL_SEND_FAILED'; throw e }
    t.ctx.sendMagicLink_({ primary_email: MAIL_B, recaptcha_token: 'x' })
    const rep = t.kms.filter((v) => v.accion === 'enr.reponerEnlaceAnterior')
    total++
    if (rep.length !== 1) {
      fallos.push('portada, correo que no sale: se pidieron ' + rep.length + ' reposiciones en vez de 1')
    } else if (rep[0].cuerpo.n !== N_B) {
      fallos.push('la reposición no dice de qué tutor es el enlace que repone ⇒ la ranura de ese '
        + 'tutor se queda con el enlace que NADIE recibió')
    }
  }

  return { ciego: false, fallos, total }
}

// ── Las ROTURAS DEMOSTRADAS: cada una tiene que poner ROJA su afirmación ─────────────────
const ROTURAS = [
  { nombre: 'la marca vuelve a ser UNA por expediente (se ignora el tutor en la clave)',
    romper: (f) => f.replace(
      "  return 'stepup_ok_' + enrollmentGroupId + (disc ? '|' + disc : '');",
      "  return 'stepup_ok_' + enrollmentGroupId;") },
  { nombre: 'el `?n=` deja de valer como discriminador (siempre vacío)',
    romper: (f) => f.replace(
      "  var n = (p && p.n) ? String(p.n).trim().toLowerCase() : '';",
      "  var n = '';") },
  { nombre: 'la marca deja de escribirse también en la ranura de siempre (rompe los enlaces sin `?n=`)',
    romper: (f) => f.replace(
      "  if (disc) cacheMarca.put(_claveMarcaStepUp_(enrollmentGroupId, ''), valor, ttl);",
      "  /* retirada a propósito */") },
  { nombre: '«sigo aquí» extiende una ranura distinta de la que leyó',
    romper: (f) => f.replace(
      "  cache.put(\n    donde.clave,",
      "  cache.put(\n    _claveMarcaStepUp_(enrollmentGroupId, 'otra'),") },
  { nombre: 'la portada renueva sin decir de qué tutor es el enlace',
    romper: (f) => f.replace(
      "            resume_token: g.resume_token, n: nPorExpediente[g.enrollment_group_id] || undefined,",
      "            resume_token: g.resume_token,") },
  { nombre: 'la reposición deja de decir de qué tutor es',
    romper: (f) => f.replace("      n:              r.n || undefined,", "") },
  { nombre: 'el `?n=` deja de viajar al KMS',
    romper: (f) => f.replace(
      "  if (cuerpo.resume_token && !cuerpo.n && _N_DE_LA_PETICION_) cuerpo.n = _N_DE_LA_PETICION_;",
      "  /* retirado a propósito */") },
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
    const ciegas = []
    for (const r of ROTURAS) {
      const roto = r.romper(fuente)
      if (roto === fuente) { ciegas.push(r.nombre + ' (la mutilación no cambió el fuente — MEDICIÓN CIEGA)'); continue }
      let res
      try { res = afirmaciones(roto) } catch (e) { res = { ciego: false, fallos: ['excepción: ' + e.message] } }
      if (!res.fallos.length && !res.ciego) ciegas.push(r.nombre + ' (rompiéndolo, el arnés SIGUE VERDE)')
      else console.log('  ✓ rotura demostrada — ' + r.nombre)
    }
    const renombrado = fuente.split('_claveMarcaStepUp_').join('_claveMarcaStepUpRenombrada_')
    const resRen = afirmaciones(renombrado)
    if (!resRen.ciego) ciegas.push('el renombrado de `_claveMarcaStepUp_` NO sale «MEDICIÓN CIEGA»')
    else console.log('  ✓ rotura demostrada — el renombrado sale MEDICIÓN CIEGA, no verde')

    if (ciegas.length) motivo = 'el arnés no es una red: ' + ciegas.join(' · ')
    else {
      console.log('  ✓ ⛔ el tutor B acredita su buzón y la ventana de A SIGUE ABIERTA')
      console.log('  ✓ la ventana de B no le sirve a A: el atado al buzón de ②24 sigue entero')
      console.log('  ✓ ⛔ un enlace SIN `?n=` sigue entrando, y quien acredita con él tampoco se queda fuera')
      console.log('  ✓ «sigo aquí» extiende la ventana DE QUIEN PULSA y no toca la del otro')
      console.log('  ✓ ⛔ al KMS se le dice de QUÉ TUTOR es el enlace que renueva, y no se pisa lo que el llamante declara')
      console.log('  ✓ ⛔ la recuperación DESDE LA PORTADA —el camino principal— dice de qué tutor es, al renovar y al reponer')
      console.log('  ✓ ejecutado sobre `backend/Code.js` REAL, en un vm con dobles: sin red, sin navegador, sin datos reales')
    }
  }
} catch (e) {
  motivo = 'error fatal — ' + (e && e.message)
} finally {
  // `2026-09-23-un-arnes-que-no-afirma-nada-pasa` — el lanzador rechaza un VERDE sin
  // esto, o con CERO: un arnés que mide nada no puede decir verde.
  const total = base && !base.ciego ? base.total : 0
  console.log(motivo ? ('VEREDICTO: ROJO — ' + motivo) : ('VEREDICTO: VERDE — ' + total + ' afirmaciones'))
  process.exitCode = motivo ? 1 : 0
}
