#!/usr/bin/env node
/**
 * run-wizard.mjs — la RED del wizard. Batería de COMPORTAMIENTO en navegador
 * (Playwright headless) que recorre los CAMINOS REALES DE UNA FAMILIA y afirma lo
 * observable, no la sintaxis.
 *
 * ── Por qué existe ───────────────────────────────────────────────────────────
 * El 2026-07-27 un cambio de seguridad (WIZ-ENUM: ack constante en `sendMagicLink_`)
 * estuvo a punto de romper el ALTA DE SOLICITUDES NUEVAS: la portada decidía
 * "recuperar vs crear" leyendo justo la señal de existencia que el cambio eliminaba.
 * Lo cazó un agente razonando, NO una comprobación — porque este repo no tenía
 * ninguna. Regla acordada con Diego (CLAUDE.md §"No se toca lo que funciona sin una
 * forma de comprobar que sigue funcionando"): ninguno de los dos repos está en
 * producción, ambos van a estarlo, y el cuidado es el mismo en los dos.
 *
 * ── Qué afirma, por camino ───────────────────────────────────────────────────
 *   1. alta-nueva        — portada: consentimiento + email nuevo → pantalla genérica
 *                          de "enlace enviado" y UNA sola llamada `sendMagicLink`.
 *   2. ack-indistinguible— email conocido vs desconocido: MISMA pantalla y MISMA
 *                          secuencia de llamadas. Y con el error legacy del servidor
 *                          ("Enrollment group not found") el cliente NO ramifica
 *                          (cero `initEnrollmentSession`) — el guardarraíl exacto
 *                          del casi-incidente.
 *   3. recuperar-aterrizar— magic-link `/resume/<token>?n=<email_id>` → hidrata y
 *                          aterriza EN EL PASO DONDE ESTABA (no en el 1), con el
 *                          token borrado de la barra de direcciones (KAL-7).
 *   4. guardar-paso      — editar un paso y continuar: el avance es INMEDIATO
 *                          (≤ presupuesto, medido EN LA PÁGINA), el `saveStep` sale
 *                          con el valor nuevo, y al volver atrás el valor PERSISTE.
 *   5. subir-documento   — adjuntar un archivo → `uploadDocument` con bytes reales
 *                          y confirmación visible de subida.
 *   6. tramo-firma       — expediente ADMITIDO con firma abierta → aterriza en el
 *                          primer paso de firma y lo PINTA (no se firma de verdad).
 * Cross-cutting en todos: cero errores de consola / excepciones, y ningún camino
 * puede quedarse en la pantalla de error del ErrorBoundary.
 *
 * ── Lecciones heredadas de la batería del KMS (que le costaron caras) ────────
 *   · SE CRONOMETRA LA APP, NO AL ROBOT. El presupuesto de feedback se mide DENTRO
 *     de la página (t0 = el `click` entrando en el documento en fase de captura;
 *     t1 = el primer frame en que la condición observable se cumple), no desde Node
 *     — las comprobaciones de accionabilidad de Playwright gastaban la mitad del
 *     margen y producían rojos falsos con la app intacta.
 *   · NINGÚN VERDE SILENCIOSO. La ÚLTIMA línea de stdout es SIEMPRE
 *     `VEREDICTO: VERDE|ROJO`, pase lo que pase (error fatal, excepción no
 *     capturada, promesa no gestionada). Nunca se deduce del código de salida: una
 *     tubería `| tail` devuelve el código del ÚLTIMO comando y así se coló un
 *     «error fatal» con exit 0.
 *   · UNA AFIRMACIÓN QUE NO SE EJECUTÓ NO ES VERDE. Sale como NO CUBIERTA con su
 *     motivo y exige entrada en `NO_CUBIERTAS_PERMITIDAS`; sin ella, ROJO. Y al
 *     revés: una entrada de esa lista cuyo eje SÍ se cubrió también es ROJO (la
 *     lista no puede envejecer en silencio).
 *   · MÍNIMO DE EVIDENCIA. Un recorrido que lee cero llamadas o pinta cero
 *     elementos es FALLO, no éxito: no comprobó nada.
 *   · RECONCILIACIÓN. Caminos ejecutados === caminos declarados, o ROJO.
 *
 * ── Seguridad de los datos ───────────────────────────────────────────────────
 * NO se manda ni un email y NO se toca ningún dato real: el bundle se compila con
 * `VITE_GAS_ENDPOINT=/__gas` y todo el tráfico muere en el servidor local de
 * `mock-backend.mjs`, con datos sintéticos en el dominio reservado `.invalid`.
 * Todo lo externo (CDN, fuentes, reCAPTCHA, logo) se ABORTA en el navegador.
 *
 * Uso:
 *   npm run e2e:wizard                        # build + batería completa
 *   E2E_SKIP_BUILD=1 npm run e2e:wizard       # reusa el bundle existente
 *   E2E_FILTER=alta npm run e2e:wizard        # subconjunto por nombre de camino
 *   E2E_HEADFUL=1 …                           # con navegador visible (depuración)
 *   E2E_LATENCY=800  E2E_FEEDBACK_MS=200      # latencia simulada / presupuesto
 */
import { createServer } from 'node:http'
import { readFileSync, existsSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { join, dirname, extname } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createDispatcher, buildHydrate, FIXTURE } from './mock-backend.mjs'

const HERE     = dirname(fileURLToPath(import.meta.url))
const FRONTEND = join(HERE, '..')
const DIST_DIR = process.env.E2E_DIST || 'dist-e2e'
const DIST     = join(FRONTEND, DIST_DIR)

const LATENCY        = Number(process.env.E2E_LATENCY || 800)
const FEEDBACK_BUDGET_MS = Number(process.env.E2E_FEEDBACK_MS || 200)
const FILTER     = process.env.E2E_FILTER || ''
const SKIP_BUILD = process.env.E2E_SKIP_BUILD === '1'
const HEADFUL    = process.env.E2E_HEADFUL === '1'
const VIEWPORT   = { width: 1280, height: 900 }

// ── Cobertura declarada: qué afirmación NO se ejecuta y POR QUÉ ───────────────
// Regla: una afirmación no ejecutada exige entrada aquí con motivo ESCRITO, o el
// veredicto es ROJO. Y una entrada cuya afirmación SÍ se ejecutó también es ROJO.
// Formato: { '<camino>': { '<afirmación>': 'motivo' } }
// NO se admite como motivo «los datos simulados están vacíos»: eso se ARREGLA.
const NO_CUBIERTAS_PERMITIDAS = {
  'tramo-firma': {
    // El acto de firmar es irreversible y depende del motor de firma del KMS
    // (sysSigningSessionSigners). La batería llega al tramo y afirma que PINTA;
    // firmar de verdad exigiría un backend de firma simulado que hoy no aporta
    // señal sobre el wizard (el acto vive server-side).
    'firma-consumada': 'no se firma de verdad: el acto es irreversible y su lógica vive en el motor del KMS, no en el wizard',
  },
}

// ── VEREDICTO — la ÚLTIMA línea de stdout, pase lo que pase ───────────────────
let VERDICT_PRINTED = false
function printVerdict(ok, reason) {
  VERDICT_PRINTED = true
  console.log(ok ? '\nVEREDICTO: VERDE — batería del wizard completa sin fallos.' : `\nVEREDICTO: ROJO — ${reason}`)
}
process.on('exit', (code) => {
  if (!VERDICT_PRINTED) console.log(`\nVEREDICTO: ROJO — la batería terminó SIN veredicto (código ${code}): recorrido abortado.`)
})
process.on('uncaughtException', (e) => {
  console.error('[e2e] excepción no capturada:', e)
  printVerdict(false, `excepción no capturada: ${String(e && e.message || e).slice(0, 200)}`)
  process.exit(1)
})
process.on('unhandledRejection', (e) => {
  console.error('[e2e] promesa no gestionada:', e)
  printVerdict(false, `promesa no gestionada: ${String(e && e.message || e).slice(0, 200)}`)
  process.exit(1)
})

// INVARIANTE anti-coladero: el presupuesto de feedback DEBE ser estrictamente menor
// que la latencia simulada. Solo así un avance observado dentro del presupuesto NO
// puede venir de la respuesta del servidor (que tarda ≥ latencia): tiene que venir
// del avance OPTIMISTA del wizard. Sin ese margen, un guardado BLOQUEANTE con
// servidor rápido se colaría como «avance inmediato».
if (!(FEEDBACK_BUDGET_MS < LATENCY)) {
  printVerdict(false, `configuración inválida (E2E_FEEDBACK_MS=${FEEDBACK_BUDGET_MS} ≥ E2E_LATENCY=${LATENCY})`)
  process.exit(1)
}

// ── 1 · Build ────────────────────────────────────────────────────────────────
function buildBundle() {
  console.log(`[e2e] compilando el bundle del wizard en ${DIST_DIR} (endpoint simulado /__gas)…`)
  execFileSync('npx', ['vite', 'build', '--outDir', DIST_DIR, '--emptyOutDir'], {
    cwd: FRONTEND,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: {
      ...process.env,
      VITE_GAS_ENDPOINT: '/__gas',
      // Sin clave de reCAPTCHA: la portada no carga el script externo y manda
      // recaptcha_token=null, exactamente como hace en un entorno sin clave.
      VITE_RECAPTCHA_SITE_KEY: '',
    },
  })
}

// ── 2 · Servidor: estáticos del bundle + backend simulado en /__gas ──────────
const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.svg': 'image/svg+xml',
  '.png': 'image/png', '.ico': 'image/x-icon', '.woff2': 'font/woff2',
}

// Registro de llamadas del recorrido en curso.
let calls = []
let unmockedActions = new Set()
const record = (c) => { calls.push({ ...c, at: Date.now() }) }
record.unmocked = (a) => { unmockedActions.add(String(a)) }

// Escenario MUTABLE que los caminos reconfiguran antes de navegar.
const scenario = { stage: 'hasta_preguntas', magicLinkMode: 'constant', saveStepFails: false }
const dispatch = createDispatcher(scenario, record)

function startServer() {
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url.startsWith('/__gas')) {
      let body = ''
      req.on('data', (d) => { body += d })
      req.on('end', () => {
        let payload = {}
        try { payload = JSON.parse(body || '{}') } catch { /* payload vacío */ }
        const out = dispatch(payload)
        // Latencia simulada: sin ella no se puede distinguir un avance optimista
        // de uno que espera al servidor.
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(out))
        }, LATENCY)
      })
      return
    }
    // Estáticos: SPA con HashRouter → todo lo no-fichero cae en index.html.
    let path = decodeURIComponent((req.url || '/').split('?')[0])
    let file = join(DIST, path)
    if (!existsSync(file) || !extname(file)) file = join(DIST, 'index.html')
    try {
      const buf = readFileSync(file)
      res.writeHead(200, { 'Content-Type': MIME[extname(file)] || 'application/octet-stream' })
      res.end(buf)
    } catch {
      res.writeHead(404); res.end('not found')
    }
  })
  return new Promise((resolve) => server.listen(0, '127.0.0.1', () => resolve(server)))
}

// ── 3 · Playwright ───────────────────────────────────────────────────────────
async function loadPlaywright() {
  try { return await import('playwright') } catch { /* sigue */ }
  const candidates = [
    '/opt/node22/lib/node_modules/playwright/index.mjs',
    '/usr/lib/node_modules/playwright/index.mjs',
  ]
  for (const c of candidates) if (existsSync(c)) return await import(pathToFileURL(c).href)
  throw new Error('playwright no resoluble (ni local ni global).')
}

// Ruido benigno DOCUMENTADO: recursos externos que el sandbox aborta a propósito
// (CDN de iconos, fuentes de Google, logo de GitHub, reCAPTCHA). Nada más.
const CONSOLA_PERMITIDA = [
  /Failed to load resource/i,
  /net::ERR_FAILED/i,
  /ERR_BLOCKED_BY_CLIENT/i,
  /ERR_CONNECTION_REFUSED/i,
]

// ── 4 · Sondas observables (sin `eval`: la CSP del wizard prohíbe unsafe-eval) ─

/** Índice del paso ACTIVO del stepper, o -1. Verdad observable del "dónde estoy". */
const sondaPasoActivo = () => {
  const pasos = [...document.querySelectorAll('.wizard-step')]
  return pasos.findIndex(p => p.classList.contains('active'))
}

/** Radiografía de la pantalla: qué hay pintado y en qué estado. */
const sondaPantalla = () => {
  const txt = (document.body.textContent || '').replace(/\s+/g, ' ').trim()
  // FIRMA de la pantalla para comparar dos escenarios. Se enmascara el email
  // porque la pantalla ECHOA el que el usuario acaba de teclear — eso no es una
  // señal de existencia (el usuario ya lo conocía), y sin enmascarar dos emails de
  // distinta longitud harían fallar la comparación por una diferencia legítima.
  const firma = txt.replace(/[^\s@]+@[^\s@]+\.[^\s@]+/g, '<EMAIL>')
  return {
    pasos:        document.querySelectorAll('.wizard-step').length,
    pasoActivo:   [...document.querySelectorAll('.wizard-step')].findIndex(p => p.classList.contains('active')),
    hash:         window.location.hash,
    // ErrorBoundary de App.jsx: pinta literalmente "Something went wrong."
    errorFatal:   /Something went wrong\./.test(txt),
    tarjetas:     document.querySelectorAll('.kis-card').length,
    campos:       document.querySelectorAll('input, select, textarea').length,
    largoTexto:   txt.length,
    firma,
    // PRESENCIA, no visibilidad: el sandbox bloquea la fuente de iconos, así que el
    // <i> existe con tamaño cero. Lo que importa es que la pantalla se pintó.
    sobreEnviado: !!document.querySelector('.bi-envelope-check'),
    subidaOk:     document.querySelectorAll('.upload-status.success').length,
  }
}

/**
 * Mide, EN LA PÁGINA, los ms entre el click y el primer frame en que se cumple la
 * condición observable. Nunca cronometra al robot: t0 lo pone un listener de
 * captura instalado ANTES del click. Devuelve ms, o -1 si no se cumplió.
 *
 * Condiciones soportadas (sin eval, por la CSP): { tipo:'pasoActivo', valor:N }.
 */
async function medirEnPagina(page, cond, hacerClick) {
  await page.evaluate((c) => {
    const w = window
    w.__e2eFb = { clickAt: null, at: null }
    const cumple = () => {
      if (c.tipo === 'pasoActivo') {
        const pasos = [...document.querySelectorAll('.wizard-step')]
        return pasos.findIndex(p => p.classList.contains('active')) === c.valor
      }
      return false
    }
    document.addEventListener('click', () => {
      if (w.__e2eFb.clickAt == null) w.__e2eFb.clickAt = performance.now()
    }, { capture: true, once: true })
    const tick = () => {
      if (w.__e2eFb.at != null) return
      if (w.__e2eFb.clickAt != null && cumple()) { w.__e2eFb.at = performance.now(); return }
      requestAnimationFrame(tick)
    }
    requestAnimationFrame(tick)
    // Red de seguridad si rAF se congela.
    const iv = setInterval(() => {
      if (w.__e2eFb.at != null) return clearInterval(iv)
      if (w.__e2eFb.clickAt != null && cumple()) { w.__e2eFb.at = performance.now(); clearInterval(iv) }
    }, 10)
  }, cond)

  await hacerClick()

  try {
    const handle = await page.waitForFunction(() => {
      const s = window.__e2eFb
      return (s && s.at != null && s.clickAt != null) ? { ms: s.at - s.clickAt } : false
    }, { timeout: LATENCY + 5000 })
    const { ms } = await handle.jsonValue()
    return Math.round(ms)
  } catch { return -1 }
}

/** Espera a que el wizard pinte su stepper (fin de la hidratación). */
async function esperarWizard(page, timeout = LATENCY * 3 + 15000) {
  await page.waitForFunction(() => {
    const pasos = document.querySelectorAll('.wizard-step')
    return pasos.length > 0 && [...pasos].some(p => p.classList.contains('active'))
  }, { timeout })
}

/** Llamadas registradas de una acción concreta en el recorrido en curso. */
const llamadas = (accion) => calls.filter(c => c.action === accion)

// ── 5 · Contexto de un camino ────────────────────────────────────────────────
class Camino {
  constructor(nombre) {
    this.nombre = nombre
    this.fallos = []
    this.noCubiertas = []
    this.notas = []
    this.erroresEsperados = []
    this.evidencia = { llamadas: 0, elementos: 0 }
  }
  /**
   * Declara un error de consola que ESTE camino provoca a propósito (p.ej. el
   * escenario hostil en que el servidor devuelve un fallo). No es una lista de
   * perdón: si el error declarado NO llega a ocurrir, el camino cae — así la
   * declaración no puede envejecer en silencio cuando el motivo desaparezca.
   */
  esperarErrorConsola(re, motivo) { this.erroresEsperados.push({ re, motivo, visto: false }) }
  /** Afirmación dura: si no se cumple, el camino cae. */
  afirmar(etiqueta, condicion, detalle) {
    if (condicion) { this.notas.push(`✓ ${etiqueta}`); return true }
    this.fallos.push(`${etiqueta} — ${detalle}`)
    return false
  }
  /** Afirmación que NO se pudo ejecutar: nunca cuenta como verde. */
  noCubierta(etiqueta, motivo) { this.noCubiertas.push({ etiqueta, motivo }) }
}

// ── 6 · Los caminos ──────────────────────────────────────────────────────────

/**
 * Rellena la portada (consentimiento + email) y envía. Devuelve la radiografía de
 * la pantalla resultante para poder COMPARARLA entre escenarios.
 */
let _cargaPortada = 0
async function rellenarPortada(page, base, email) {
  // Sufijo único ANTES del hash: dos `goto` al mismo `#/` serían navegación del
  // MISMO documento (el navegador no recarga) y la portada seguiría en la pantalla
  // de "enviado" del intento anterior. El parámetro va fuera del hash, así que
  // `useSearchParams` (HashRouter) ni lo ve — no altera el comportamiento.
  const url = `${base}/?e2e=${++_cargaPortada}#/`
  await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 30000 })
  await page.waitForSelector('#consent_gdpr', { timeout: 15000 })
  await page.check('#consent_gdpr')
  await page.fill('input[type="email"]', email)
  await page.click('button[type="submit"], form button.btn-primary-kis')
  // La pantalla genérica es OPTIMISTA (se pinta antes de que el servidor conteste).
  // Se espera por PRESENCIA en el DOM, no por visibilidad: el sandbox bloquea la
  // fuente de iconos y el <i> queda con tamaño cero (invisible para Playwright)
  // aunque la pantalla esté perfectamente pintada.
  await page.waitForFunction(() => !!document.querySelector('.bi-envelope-check'), { timeout: 10000 })
  // Deja respirar a las llamadas de FONDO antes de irse de la página. El envío es
  // fire-and-forget y encadena `sendMagicLink` → `warmBundle`: si la batería navega
  // a mitad de vuelo, el navegador aborta el fetch y la app registra un error de red
  // que NO es suyo, sino del robot. Se espera la cadena entera (2 saltos) + margen.
  await page.waitForTimeout(LATENCY * 2 + 900)
  return page.evaluate(sondaPantalla)
}

async function caminoAltaNueva(page, base) {
  const c = new Camino('alta-nueva')
  scenario.magicLinkMode = 'constant'

  const pantalla = await rellenarPortada(page, base, FIXTURE.emailUnknown)

  c.evidencia.elementos = pantalla.tarjetas + (pantalla.sobreEnviado ? 1 : 0)
  c.afirmar('la portada confirma el envío del enlace', pantalla.sobreEnviado,
    'no apareció la confirmación genérica de "te hemos enviado un enlace"')
  c.afirmar('sin pantalla de error', !pantalla.errorFatal, 'el ErrorBoundary pintó "Something went wrong."')

  const envios = llamadas('sendMagicLink')
  c.afirmar('sale UNA sola petición de enlace', envios.length === 1,
    `se registraron ${envios.length} llamadas a sendMagicLink (se espera exactamente 1)`)
  if (envios.length) {
    c.afirmar('la petición lleva el email tecleado',
      envios[0].payload && envios[0].payload.primary_email === FIXTURE.emailUnknown,
      `primary_email recibido: ${envios[0].payload && envios[0].payload.primary_email}`)
  } else {
    c.noCubierta('email-en-la-peticion', 'no hubo ninguna petición que inspeccionar')
  }
  // El casi-incidente: el cliente NO puede decidir recuperar-vs-crear.
  c.afirmar('el cliente NO crea la sesión por su cuenta', llamadas('initEnrollmentSession').length === 0,
    `el cliente llamó a initEnrollmentSession ${llamadas('initEnrollmentSession').length} vez/veces: volvió a ramificar en el cliente`)
  return c
}

async function caminoAckIndistinguible(page, base) {
  const c = new Camino('ack-indistinguible')

  // (a) Email CONOCIDO vs DESCONOCIDO — el servidor responde igual (ack constante).
  scenario.magicLinkMode = 'constant'
  calls = []
  const pantallaConocido = await rellenarPortada(page, base, FIXTURE.emailKnown)
  const accionesConocido = calls.map(x => x.action).join(',')

  calls = []
  const pantallaDesconocido = await rellenarPortada(page, base, FIXTURE.emailUnknown)
  const accionesDesconocido = calls.map(x => x.action).join(',')

  c.evidencia.elementos = pantallaConocido.tarjetas + pantallaDesconocido.tarjetas
  c.afirmar('la pantalla es la misma para email conocido y desconocido',
    pantallaConocido.sobreEnviado && pantallaDesconocido.sobreEnviado
      && pantallaConocido.firma === pantallaDesconocido.firma,
    `la pantalla difiere (email enmascarado):\n        conocido=[${pantallaConocido.firma.slice(0, 220)}]\n        desconocido=[${pantallaDesconocido.firma.slice(0, 220)}]`)
  c.afirmar('la secuencia de llamadas es la misma en ambos casos',
    accionesConocido === accionesDesconocido,
    `conocido=[${accionesConocido}] desconocido=[${accionesDesconocido}]`)

  // (b) Hostil: el servidor vuelve al comportamiento PRE-WIZ-ENUM y delata. El
  //     cliente NO puede aprovecharlo para ramificar ni cambiar lo que enseña.
  //     Que la app REGISTRE ese fallo del servidor es correcto (lo traga para el
  //     usuario y lo deja en el log, redactado): se declara como esperado, y si
  //     dejara de ocurrir el camino caería.
  c.esperarErrorConsola(/sendMagicLink: server returned ok=false/,
    'escenario hostil deliberado: el servidor simulado delata que el email no existe; la app debe tragarse el fallo de cara al usuario pero SÍ registrarlo')
  scenario.magicLinkMode = 'legacy_error'
  calls = []
  const pantallaLegacy = await rellenarPortada(page, base, FIXTURE.emailUnknown)
  const accionesLegacy = calls.map(x => x.action)

  c.afirmar('con un servidor que delata, la pantalla NO cambia',
    pantallaLegacy.sobreEnviado && pantallaLegacy.firma === pantallaDesconocido.firma,
    `la pantalla cambió al delatar el servidor (email enmascarado):\n        normal=[${pantallaDesconocido.firma.slice(0, 220)}]\n        delator=[${pantallaLegacy.firma.slice(0, 220)}]`)
  c.afirmar('con un servidor que delata, el cliente NO crea la sesión por su cuenta',
    !accionesLegacy.includes('initEnrollmentSession'),
    `el cliente reaccionó al error creando sesión: [${accionesLegacy.join(',')}]`)
  c.afirmar('sin pantalla de error pese al fallo del servidor', !pantallaLegacy.errorFatal,
    'el ErrorBoundary pintó "Something went wrong." al fallar la petición de fondo')

  scenario.magicLinkMode = 'constant'
  return c
}

async function caminoRecuperarAterrizar(page, base) {
  const c = new Camino('recuperar-aterrizar')
  scenario.stage = 'hasta_preguntas'   // completos 0..4 ⇒ aterriza en Documentos (5)

  await page.goto(`${base}/#/resume/${FIXTURE.resumeToken}?n=${FIXTURE.emailId}`,
    { waitUntil: 'domcontentloaded', timeout: 30000 })
  await esperarWizard(page)
  const pantalla = await page.evaluate(sondaPantalla)

  c.evidencia.elementos = pantalla.pasos + pantalla.campos

  c.afirmar('el wizard pinta sus 11 pasos', pantalla.pasos === 11,
    `se pintaron ${pantalla.pasos} pasos en el stepper`)
  c.afirmar('sin pantalla de error', !pantalla.errorFatal, 'el ErrorBoundary pintó "Something went wrong."')
  c.afirmar('aterriza en el paso donde estaba la familia (Documentos, 6.º)',
    pantalla.pasoActivo === 5,
    `aterrizó en el paso índice ${pantalla.pasoActivo} (se esperaba 5); un aterrizaje en 0 significa que la recuperación no arrastró el progreso`)
  // KAL-7: el token es un secreto de 7 días; no puede quedarse en la barra.
  c.afirmar('el token desaparece de la barra de direcciones (KAL-7)',
    pantalla.hash === '#/apply',
    `el hash quedó en "${pantalla.hash}"`)

  const hidrataciones = llamadas('hydrateSession')
  if (!hidrataciones.length) {
    c.fallos.push('la recuperación no llegó a pedir la sesión — hydrateSession nunca se llamó')
  } else {
    const p = hidrataciones[0].payload || {}
    c.afirmar('la recuperación viaja con el token del enlace', p.resume_token === FIXTURE.resumeToken,
      `resume_token recibido: ${String(p.resume_token).slice(0, 8)}…`)
    c.afirmar('la recuperación viaja con la identidad del enlace (n = email_id)',
      p.n === FIXTURE.emailId, `n recibido: ${p.n}`)
  }
  return c
}

async function caminoGuardarPaso(page, base) {
  const c = new Camino('guardar-paso')
  scenario.stage = 'sin_fecha'   // sin fecha ⇒ aterriza en el paso 1 (índice 0)

  await page.goto(`${base}/#/resume/${FIXTURE.resumeToken}?n=${FIXTURE.emailId}`,
    { waitUntil: 'domcontentloaded', timeout: 30000 })
  await esperarWizard(page)

  let pantalla = await page.evaluate(sondaPantalla)
  c.evidencia.elementos = pantalla.pasos + pantalla.campos
  if (!c.afirmar('aterriza en el primer paso incompleto', pantalla.pasoActivo === 0,
    `aterrizó en el índice ${pantalla.pasoActivo}, no en 0`)) return c
  c.afirmar('sin pantalla de error', !pantalla.errorFatal, 'el ErrorBoundary pintó "Something went wrong."')

  // Editar: pasar a "fecha concreta" y escribir una fecha que la batería controla.
  const FECHA = '2027-01-11'
  await page.waitForSelector('#mid', { timeout: 10000 })
  await page.check('#mid')
  await page.waitForSelector('input[type="date"]', { timeout: 10000 })
  await page.fill('input[type="date"]', FECHA)

  // Continuar: el avance debe ser INMEDIATO (optimista), no esperar al servidor.
  const antes = calls.length
  const ms = await medirEnPagina(page, { tipo: 'pasoActivo', valor: 1 },
    () => page.click('.btn-primary-kis'))

  if (ms < 0) {
    c.fallos.push('al continuar, el wizard nunca avanzó al paso 2')
    return c
  }
  c.afirmar(`el avance es inmediato (${ms} ms ≤ ${FEEDBACK_BUDGET_MS} ms)`,
    ms <= FEEDBACK_BUDGET_MS,
    `tardó ${ms} ms con una latencia simulada de ${LATENCY} ms: el avance está esperando al servidor en vez de ser optimista`)

  // El guardado sale con el valor nuevo (aunque el usuario ya haya avanzado).
  await page.waitForTimeout(LATENCY + 800)
  const guardados = llamadas('saveStep')
  c.evidencia.llamadas = calls.length - antes
  if (!guardados.length) {
    c.fallos.push('el paso editado NUNCA se guardó — ningún saveStep salió tras continuar')
  } else {
    const g = guardados[guardados.length - 1].payload || {}
    c.afirmar('el guardado lleva el paso correcto', g.step === 'application',
      `step recibido: ${g.step}`)
    c.afirmar('el guardado lleva la fecha que se acaba de escribir',
      !!(g.payload && g.payload.desired_start_date === FECHA),
      `desired_start_date recibido: ${g.payload && g.payload.desired_start_date} (se escribió ${FECHA})`)
    c.afirmar('el guardado va autenticado con el token de la sesión (KAL-4)',
      g.resume_token === FIXTURE.resumeToken, 'el saveStep salió sin el resume_token de la sesión')
  }

  // Persistencia visible: volver atrás y comprobar que el valor sigue.
  const atras = await page.$('.btn-secondary-kis')
  if (!atras) {
    c.noCubierta('persistencia-al-volver', 'el paso 2 no ofrece botón "Atrás"')
  } else {
    await atras.click()
    await page.waitForFunction(() => {
      const pasos = [...document.querySelectorAll('.wizard-step')]
      return pasos.findIndex(p => p.classList.contains('active')) === 0
    }, { timeout: 10000 })
    // Al volver, el paso queda protegido (banner + "Editar"): el valor debe seguir
    // visible aunque el campo esté bloqueado.
    const valor = await page.evaluate(() => {
      const i = document.querySelector('input[type="date"]')
      return i ? i.value : null
    })
    c.afirmar('al volver atrás, la fecha guardada sigue ahí', valor === FECHA,
      `el campo de fecha muestra "${valor}" (se escribió ${FECHA})`)
  }
  return c
}

async function caminoSubirDocumento(page, base) {
  const c = new Camino('subir-documento')
  scenario.stage = 'hasta_preguntas'   // aterriza directamente en Documentos (5)

  await page.goto(`${base}/#/resume/${FIXTURE.resumeToken}?n=${FIXTURE.emailId}`,
    { waitUntil: 'domcontentloaded', timeout: 30000 })
  await esperarWizard(page)

  let pantalla = await page.evaluate(sondaPantalla)
  if (!c.afirmar('aterriza en el paso de Documentos', pantalla.pasoActivo === 5,
    `aterrizó en el índice ${pantalla.pasoActivo}, no en 5`)) return c

  const añadir = await page.$('.add-btn')
  if (!añadir) {
    c.fallos.push('el paso de Documentos no ofrece el botón de añadir archivo (.add-btn)')
    return c
  }
  await añadir.click()
  await page.waitForSelector('.doc-attachment', { timeout: 10000 })
  await page.fill('.doc-attachment input[type="text"]', 'Documento sintético E2E')

  // Archivo sintético en memoria (no se lee nada del disco del usuario).
  await page.setInputFiles('.doc-attachment input[type="file"]', {
    name: 'prueba-e2e.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n% documento sintetico de la bateria E2E\n'),
  })

  let subidaOk = false
  try {
    await page.waitForSelector('.upload-status.success', { timeout: LATENCY + 12000 })
    subidaOk = true
  } catch { /* se reporta abajo */ }

  const subidas = llamadas('uploadDocument')
  c.evidencia.llamadas = subidas.length
  c.evidencia.elementos = await page.evaluate(() => document.querySelectorAll('.doc-attachment').length)

  c.afirmar('la subida llega al servidor', subidas.length >= 1,
    'no salió ninguna llamada uploadDocument al seleccionar el archivo')
  if (subidas.length) {
    const p = subidas[0].payload || {}
    c.afirmar('la subida lleva los bytes del archivo', !!(p.base64 && p.base64.length > 10),
      `base64 recibido de ${p.base64 ? p.base64.length : 0} caracteres`)
    c.afirmar('la subida lleva el nombre del archivo', p.filename === 'prueba-e2e.pdf',
      `filename recibido: ${p.filename}`)
    c.afirmar('la subida va autenticada con el token de la sesión (KAL-4)',
      p.resume_token === FIXTURE.resumeToken, 'el uploadDocument salió sin el resume_token de la sesión')
  } else {
    c.noCubierta('contenido-de-la-subida', 'no hubo ninguna subida que inspeccionar')
  }
  c.afirmar('la pantalla confirma la subida', subidaOk,
    'nunca apareció la confirmación visible de archivo subido (.upload-status.success)')
  return c
}

async function caminoTramoFirma(page, base) {
  const c = new Camino('tramo-firma')
  scenario.stage = 'firma'   // ADMITIDA + firma abierta ⇒ primer paso de firma (7)

  await page.goto(`${base}/#/resume/${FIXTURE.resumeToken}?n=${FIXTURE.emailId}`,
    { waitUntil: 'domcontentloaded', timeout: 30000 })
  await esperarWizard(page)
  await page.waitForTimeout(LATENCY + 800)   // el paso de firma lee su presupuesto

  const pantalla = await page.evaluate(sondaPantalla)
  c.evidencia.elementos = pantalla.pasos + pantalla.campos + pantalla.tarjetas

  c.afirmar('sin pantalla de error', !pantalla.errorFatal, 'el ErrorBoundary pintó "Something went wrong."')
  c.afirmar('un expediente admitido aterriza en el tramo de firma (paso 8.º)',
    pantalla.pasoActivo === 7,
    `aterrizó en el índice ${pantalla.pasoActivo} (se esperaba 7): con la firma abierta la familia se quedaría atascada en Revisión`)
  c.afirmar('el paso de firma pinta contenido de verdad',
    pantalla.tarjetas >= 1 && pantalla.largoTexto > 200,
    `tarjetas=${pantalla.tarjetas} largo del texto=${pantalla.largoTexto}: el paso quedó en blanco`)

  // Declarado y justificado en NO_CUBIERTAS_PERMITIDAS.
  c.noCubierta('firma-consumada',
    'no se firma de verdad: el acto es irreversible y su lógica vive en el motor del KMS, no en el wizard')
  return c
}

const CAMINOS = [
  { nombre: 'alta-nueva',          fn: caminoAltaNueva,          minLlamadas: 1, minElementos: 1 },
  { nombre: 'ack-indistinguible',  fn: caminoAckIndistinguible,  minLlamadas: 1, minElementos: 2 },
  { nombre: 'recuperar-aterrizar', fn: caminoRecuperarAterrizar, minLlamadas: 1, minElementos: 11 },
  { nombre: 'guardar-paso',        fn: caminoGuardarPaso,        minLlamadas: 1, minElementos: 11 },
  { nombre: 'subir-documento',     fn: caminoSubirDocumento,     minLlamadas: 1, minElementos: 1 },
  { nombre: 'tramo-firma',         fn: caminoTramoFirma,         minLlamadas: 1, minElementos: 11 },
]

// ── 7 · Runner ───────────────────────────────────────────────────────────────
async function main() {
  if (!SKIP_BUILD || !existsSync(join(DIST, 'index.html'))) buildBundle()

  const { chromium } = await loadPlaywright()
  const server = await startServer()
  const base = `http://127.0.0.1:${server.address().port}`
  console.log(`[e2e] wizard servido en ${base} (backend simulado en /__gas, latencia ${LATENCY} ms)\n`)

  let browser
  try {
    browser = await chromium.launch({ headless: !HEADFUL })
  } catch (e) {
    const guesses = ['/opt/pw-browsers/chromium-1194/chrome-linux/chrome', '/opt/pw-browsers/chromium/chrome-linux/chrome']
    const exe = guesses.find(g => existsSync(g))
    if (!exe) throw e
    browser = await chromium.launch({ headless: !HEADFUL, executablePath: exe })
  }

  const seleccionados = CAMINOS.filter(c => !FILTER || c.nombre.includes(FILTER))
  const resultados = []

  for (const def of seleccionados) {
    const context = await browser.newContext({ viewport: VIEWPORT, locale: 'es-ES' })
    // Sandbox sin egreso: se aborta TODO lo externo (CDN, fuentes, logo, reCAPTCHA).
    await context.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, r => r.abort())
    const page = await context.newPage()

    const erroresConsola = []
    page.on('console', (msg) => {
      if (msg.type() !== 'error') return
      const t = msg.text()
      if (CONSOLA_PERMITIDA.some(re => re.test(t))) return
      erroresConsola.push(t.slice(0, 300))
    })
    page.on('pageerror', (err) => erroresConsola.push(`excepción: ${String(err && err.message || err).slice(0, 300)}`))

    calls = []
    unmockedActions = new Set()
    let c
    try {
      c = await def.fn(page, base)
    } catch (e) {
      c = new Camino(def.nombre)
      c.fallos.push(`el recorrido se rompió: ${String(e && e.message || e).slice(0, 240)}`)
    }

    // Evidencia mínima: un recorrido que no leyó nada no comprobó nada.
    const totalLlamadas = calls.length
    if (totalLlamadas < def.minLlamadas) {
      c.fallos.push(`evidencia insuficiente: ${totalLlamadas} llamadas al backend (mínimo ${def.minLlamadas}) — el recorrido no llegó a ejercitar la app`)
    }
    if ((c.evidencia.elementos || 0) < def.minElementos) {
      c.fallos.push(`evidencia insuficiente: ${c.evidencia.elementos || 0} elementos pintados (mínimo ${def.minElementos}) — se afirmó sobre una pantalla vacía`)
    }
    // Errores de consola: se descuentan los DECLARADOS por el camino (escenarios
    // hostiles a propósito) y se exige que hayan ocurrido de verdad.
    const inesperados = erroresConsola.filter((t) => {
      const esperado = c.erroresEsperados.find(e => e.re.test(t))
      if (esperado) { esperado.visto = true; return false }
      return true
    })
    if (inesperados.length) {
      c.fallos.push(`${inesperados.length} error(es) en consola: ${inesperados.slice(0, 3).join(' | ')}`)
    }
    for (const e of c.erroresEsperados) {
      if (!e.visto) {
        c.fallos.push(`se declaró esperar el error de consola /${e.re.source}/ (${e.motivo}) y NUNCA ocurrió — la declaración está obsoleta`)
      }
    }
    if (unmockedActions.size) {
      c.notas.push(`⚠ acciones no simuladas (deriva de contrato): ${[...unmockedActions].join(', ')}`)
    }

    c.llamadasTotales = totalLlamadas
    resultados.push(c)

    const flag = c.fallos.length ? '✗' : '✓'
    console.log(`  ${flag} ${c.nombre}  (${totalLlamadas} llamadas, ${c.evidencia.elementos || 0} elementos)`)
    for (const n of c.notas)  console.log(`      ${n}`)
    for (const f of c.fallos) console.log(`      ✗ ${f}`)
    for (const nc of c.noCubiertas) console.log(`      · NO CUBIERTA «${nc.etiqueta}»: ${nc.motivo}`)

    await context.close()
  }

  await browser.close()
  server.close()

  // ── Resumen ────────────────────────────────────────────────────────────────
  const conFallo = resultados.filter(r => r.fallos.length)
  console.log(`\n  caminos ejecutados:  ${resultados.length} de ${seleccionados.length}`)
  console.log(`  caminos en verde:    ${resultados.length - conFallo.length}`)
  console.log(`  caminos en rojo:     ${conFallo.length}`)

  // Cobertura: lo no ejecutado exige motivo declarado; la lista no puede envejecer.
  const problemasCobertura = []
  for (const r of resultados) {
    const permitidas = NO_CUBIERTAS_PERMITIDAS[r.nombre] || {}
    for (const nc of r.noCubiertas) {
      if (!permitidas[nc.etiqueta]) {
        problemasCobertura.push(`${r.nombre} · «${nc.etiqueta}» quedó SIN cubrir (${nc.motivo}) y no está declarada en NO_CUBIERTAS_PERMITIDAS`)
      }
    }
    for (const etiqueta of Object.keys(permitidas)) {
      const declaradaYCubierta = !r.noCubiertas.some(nc => nc.etiqueta === etiqueta)
      if (declaradaYCubierta) {
        problemasCobertura.push(`${r.nombre} · «${etiqueta}» está declarada como no cubierta pero HOY sí se cubre — retira la entrada de NO_CUBIERTAS_PERMITIDAS`)
      }
    }
  }
  if (problemasCobertura.length) {
    console.log('\n  problemas de cobertura:')
    for (const p of problemasCobertura) console.log(`    ✗ ${p}`)
  }

  // Reconciliación: un recorrido a medias no es verde.
  if (resultados.length !== seleccionados.length) {
    printVerdict(false, `recorrido incompleto: ${resultados.length} de ${seleccionados.length} caminos`)
    process.exit(1)
  }
  if (conFallo.length) {
    printVerdict(false, `${conFallo.length} camino(s) en rojo: ${conFallo.map(r => r.nombre).join(', ')}`)
    process.exit(1)
  }
  if (problemasCobertura.length) {
    printVerdict(false, `cobertura no declarada en ${problemasCobertura.length} caso(s)`)
    process.exit(1)
  }
  if (!FILTER && seleccionados.length !== CAMINOS.length) {
    printVerdict(false, 'no se recorrieron todos los caminos declarados')
    process.exit(1)
  }
  if (FILTER) {
    printVerdict(false, `ejecución PARCIAL (filtro "${FILTER}"): no vale como muro de deploy`)
    process.exit(1)
  }
  printVerdict(true)
  process.exit(0)
}

main()
