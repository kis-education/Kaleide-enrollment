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
 *   3. recuperar-aterrizar— la familia PIDE su enlace en la portada y lo SIGUE:
 *                          pedirlo emite un token nuevo, `/resume/<token>?n=<email_id>`
 *                          hidrata y aterriza EN EL PASO DONDE ESTABA (no en el 1),
 *                          con el token borrado de la barra (KAL-7). Los demás caminos
 *                          de navegador entran siguiendo ese mismo enlace VIGENTE
 *                          (ver `entrarPorElEnlace`).
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
 * ── Dos backends, UNA sola costura ───────────────────────────────────────────
 * El navegador SIEMPRE habla con el servidor local de esta batería (el bundle se
 * compila con `VITE_GAS_ENDPOINT=/__gas`; la URL de Google NO entra en el bundle).
 * Lo único que cambia es a dónde va ese servidor cuando le llega la llamada:
 *   · `E2E_BACKEND=mock` (por defecto) → `dispatch()` de `mock-backend.mjs`.
 *   · `E2E_BACKEND=real`               → REENVÍA el payload tal cual al `/exec` del
 *     wizard de verdad (que a su vez llama al KMS de verdad) y devuelve su JSON.
 * El reenvío hace el DOBLE SALTO que exige una web app de GAS: POST sin seguir
 * redirecciones → se captura la cabecera `Location:` → GET a ese URL, que es donde
 * está el JSON (`CLAUDE.md` §"Smoke test technique — dos pasos"; `curl -L` NO vale
 * porque convierte el POST en GET).
 *
 * ── Seguridad de los datos ───────────────────────────────────────────────────
 * En modo `mock`: NO se manda ni un email y NO se toca ningún dato real — todo el
 * tráfico muere en el servidor local, con datos sintéticos en el dominio reservado
 * `.invalid`. Todo lo externo (CDN, fuentes, reCAPTCHA, logo) se ABORTA en el navegador.
 *
 * En modo `real`: se escribe en el sistema de verdad y SALEN CORREOS REALES. Por eso
 * las identidades son desechables y reconocibles: los correos van SIEMPRE al buzón de
 * pruebas que entra por `E2E_MAIL_BASE`, usando SUB-DIRECCIÓN de Gmail para que cada
 * tutor sea distinto ante el sistema (`buzon+robot-t1@…`, `+robot-t2@…`; la
 * recuperación es per-guardian, dos tutores con el mismo correo no ejercitan el
 * camino real), y los apellidos llevan el marcador `ROBOT-<sello>` para poder
 * localizar y borrar después la familia de prueba. Sin `E2E_GAS_URL` o sin
 * `E2E_MAIL_BASE` el modo real NO arranca: ROJO inmediato, jamás un valor por defecto.
 *
 * ⚠️ Google tiene CUOTA DIARIA de envío. Un camino que muere por cuota NO es un
 * defecto del camino de inscripción: la batería lo detecta y lo reporta como CUOTA.
 *
 * Uso:
 *   npm run e2e:wizard                        # build + batería completa (simulado)
 *   npm run robot:inscripcion                 # la misma batería contra el sistema REAL
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
import { sonda, aplicarSonda, porQueNoHaySondas, KMS_REPO } from './sondas-kms.mjs'

const HERE     = dirname(fileURLToPath(import.meta.url))
const FRONTEND = join(HERE, '..')
const DIST_DIR = process.env.E2E_DIST || 'dist-e2e'
const DIST     = join(FRONTEND, DIST_DIR)

// ── Modo de backend: simulado (por defecto) o el sistema REAL ────────────────
const BACKEND   = String(process.env.E2E_BACKEND || 'mock').toLowerCase()
const REAL      = BACKEND === 'real'
const GAS_URL   = process.env.E2E_GAS_URL || ''
const MAIL_BASE = process.env.E2E_MAIL_BASE || ''

// En modo simulado la latencia se INYECTA (es la que hace demostrable el avance
// optimista). En modo real NO se inyecta nada: el backend de verdad ya tarda. Ahí
// el valor solo sirve de latencia ESPERADA para dimensionar esperas y timeouts, y
// lo que hace demostrable el avance optimista es la latencia REAL medida.
const LATENCY        = Number(process.env.E2E_LATENCY || (REAL ? 4000 : 800))
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

// Añadidos SOLO en modo real: escenarios que el backend simulado puede fabricar y
// el sistema de verdad no. No son un perdón general — cada uno con su motivo, y la
// comprobación de "declarada pero HOY sí se cubre" sigue viva en ambos modos.
const NO_CUBIERTAS_SOLO_REAL = {
  'ack-indistinguible': {
    'servidor-que-delata': 'el escenario hostil (servidor que devuelve el error legacy "Enrollment group not found") no se puede FORZAR sobre el backend de verdad sin desplegarle un cambio; en modo simulado sí se cubre',
  },
  'alta-nueva': {
    // Medido, no supuesto — ver el bloque de `recuperarElEnlace`. La verja reCAPTCHA de
    // `initEnrollmentSession_` es fail-closed y este arnés no tiene clave, así que el alta
    // por la portada no puede completarse aquí. En producción sí. Lo que NO se hace es
    // aflojar la verja para que la prueba pase.
    'alta-desde-la-portada': 'la verja reCAPTCHA de initEnrollmentSession_ es FAIL-CLOSED y el arnés compila el bundle sin clave de reCAPTCHA (VITE_RECAPTCHA_SITE_KEY vacía): el token va nulo y no se crea nada. Es carencia del ARNÉS, no del wizard. El expediente se da de alta por la pasarela para que los diez pasos siguientes sean medibles.',
    'paso 1 · correo y sesión·correos.registrados_y_del_robot': 'la fila de enrEmails la escribe el paso de PERSONAS, que en el momento del paso 1 todavía no ha corrido. No es una carencia del paso 1: la afirmación se ejecuta en su sitio, en el paso 2.',
  },
  'expediente-completo': {
    // Todas MEDIDAS en la corrida del 2026-08-03 contra el sistema real. Ninguna es un
    // perdón: cada una nombra una configuración de tenant que falta o un paso que el
    // recorrido todavía no produce, y la comprobación de "declarada pero HOY sí se cubre"
    // las retira solas en cuanto dejen de ser ciertas.
    'paso 5 · preguntas·preguntas.respuestas_persistidas': 'el tenant no tiene cuestionario configurado para este programa: no hay sesión de respuestas que leer. Configuración de tenant, no defecto del wizard.',
    'paso 6 · documentos·documentos.contenido': 'ningún tipo de recTypes_T del ámbito enr_admission_school está marcado provided_by_code=INTERESTED_PARTY, así que el servidor no resuelve qué tipo aporta la familia y la subida no llega a intentarse. Es un clic de configuración de tenant; el producto ya lo dice con un mensaje accionable.',
    'paso 8 · facturación·facturacion.borrador_de_suscripcion': 'no hay borrador de suscripción: lo crea el motor financiero al admitir, y el expediente todavía no llega a AD (ver la transición). Se enciende sola en cuanto llegue.',
    'paso 8 · facturación·facturacion.pagador_registrado': 'no hay parte facturadora ligada al grupo: el paso 8 aún no se ha recorrido de verdad (depende de la admisión).',
    'paso 9 · consentimientos·consentimientos.por_tutor': 'el paso 9 aún no se recorre: depende de que el expediente esté admitido y el tramo de firma abierto.',
    'paso 10 · revisión·revision.confirmacion_de_lectura': 'el paso 10 aún no se recorre: depende de la admisión.',
    'paso 11 · firma·firma.preparacion': 'la sesión de firma la abre la admisión; sin expediente en AD no hay preparación que afirmar.',
    'paso 3 · vínculos·vinculos.tipo_resuelve_en_catalogo': 'el catálogo de tipos de vínculo no se pudo leer con los nombres de tabla probados (sysRelationTypes / personRelationTypes). El vínculo CONCRETO y su custodia sí se afirman; lo que queda sin comprobar es que el identificador de tipo resuelva a una fila viva.',
  },
  'subir-documento': {
    // Medido, no supuesto: contra el sistema real la familia arranca en el paso 1 (no hay
    // "escenario" que colocarla en Documentos), y el robot todavía no conduce en navegador
    // los pasos 2-5 que hay que rellenar para llegar. La subida SÍ queda cubierta —por la
    // pasarela, y verificada leyendo `recFiles` en la sonda del paso 6—, pero eso es otra
    // cosa que teclear en la pantalla, y no se venden como lo mismo.
    'subida-desde-la-pantalla': 'contra el sistema real el expediente recién creado aterriza en el paso 1, y el robot aún no conduce en navegador los pasos 2-5 necesarios para llegar a Documentos. La ESCRITURA del documento sí se cubre (por la pasarela) y la sonda del paso 6 la verifica en recFiles; lo que falta es teclearlo en la pantalla. Lo cierra el encargo 03.',
    'contenido-de-la-subida': 'no hubo subida DESDE LA PANTALLA que inspeccionar (ver arriba); el contenido de la fila lo afirma la sonda del paso 6 leyendo la base',
  },
}
if (REAL) {
  for (const [camino, entradas] of Object.entries(NO_CUBIERTAS_SOLO_REAL)) {
    NO_CUBIERTAS_PERMITIDAS[camino] = { ...(NO_CUBIERTAS_PERMITIDAS[camino] || {}), ...entradas }
  }
}

// ── VEREDICTO — la ÚLTIMA línea de stdout, pase lo que pase ───────────────────
let VERDICT_PRINTED = false
function printVerdict(ok, reason) {
  VERDICT_PRINTED = true
  const donde = (String(process.env.E2E_BACKEND || 'mock').toLowerCase() === 'real')
    ? 'contra el sistema REAL' : 'contra el backend simulado'
  console.log(ok ? `\nVEREDICTO: VERDE — batería del wizard completa sin fallos ${donde}.` : `\nVEREDICTO: ROJO — ${reason}`)
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

// ── Modo real: sin destino y sin buzón NO se arranca. Jamás un valor por defecto ─
// Un default aquí sería la peor clase de error posible: escribir en un sistema que
// no es el que se creía, o mandar correos a una dirección que no es la de pruebas.
if (BACKEND !== 'mock' && BACKEND !== 'real') {
  printVerdict(false, `E2E_BACKEND="${BACKEND}" no es un modo válido (mock|real)`)
  process.exit(1)
}
if (REAL && !/^https:\/\/script\.google\.com\/macros\/s\/[^/]+\/exec$/.test(GAS_URL)) {
  printVerdict(false, GAS_URL
    ? `E2E_GAS_URL no parece el /exec de una web app de GAS: "${GAS_URL}"`
    : 'modo real sin E2E_GAS_URL: no hay a dónde reenviar y NO se inventa un destino por defecto')
  process.exit(1)
}
if (REAL && !/^[^\s@+]+@[^\s@]+\.[^\s@]+$/.test(MAIL_BASE)) {
  printVerdict(false, MAIL_BASE
    ? `E2E_MAIL_BASE no es una dirección base válida (sin sub-dirección "+"): "${MAIL_BASE}"`
    : 'modo real sin E2E_MAIL_BASE: saldrían correos REALES y NO se inventa un buzón por defecto')
  process.exit(1)
}

// ── Identidades del recorrido ────────────────────────────────────────────────
// En simulado, las del fixture (dominio `.invalid`, nunca enruta). En real, unas
// DESECHABLES y RECONOCIBLES: sub-dirección de Gmail por identidad (cada tutor es
// distinto ante el sistema, que resuelve la recuperación per-guardian) y marcador
// `ROBOT-<sello>` en el apellido para poder localizar y borrar la familia después.
const SELLO = new Date().toISOString().replace(/[-:T.]/g, '').slice(0, 14)   // AAAAMMDDhhmmss
const MARCA = `ROBOT-${SELLO}`
const buzon = (etiqueta) => {
  const [local, dominio] = MAIL_BASE.split('@')
  return `${local}+${etiqueta}@${dominio}`
}
const DATOS = REAL
  ? {
      // El PRIMER camino (`alta-nueva`) da de alta este correo, así que a partir de ahí
      // es genuinamente CONOCIDO por el sistema — que es lo que hace válida la comparación
      // anti-enumeración del camino siguiente. Antes el alta usaba el correo desconocido y
      // los dos lados de esa comparación eran desconocidos: se comparaban dos nadas.
      //
      // ⚠️ ÚNICO POR CORRIDA, y no es cosmética: el cupo de magic-link es de **5 por correo
      // y hora** (`Code.js:1741`) y por encima el servidor descarta la petición EN SILENCIO
      // (ack constante, WIZ-ENUM). Una corrida gasta 3; **dos corridas seguidas con el
      // correo fijo se comían el cupo** y la petición de enlace de la segunda no rotaba ni
      // enviaba nada — justo cuando la condición de parada exige DOS corridas consecutivas.
      // Con sello por corrida el contador arranca limpio y el correo sigue siendo conocido
      // (lo da de alta `alta-nueva`) y localizable por el reset (marcador `+robot-`).
      emailKnown:   buzon(`robot-t1-${SELLO}`),
      // Único por corrida ⇒ genuinamente desconocido para el sistema.
      emailUnknown: buzon(`robot-u${SELLO}`),
      apellido:     MARCA,
      // ⚠️ VALORES DE ARRANQUE, NO los definitivos. En cuanto `alta-nueva` da de alta el
      // expediente, la sonda `manual_robotEnlaceDeRecuperacion` devuelve el `resume_token` y
      // el `email_id` REALES (lo mismo que llevaría el enlace del correo) y SE SOBREESCRIBEN
      // aquí. Hasta entonces son valores con forma válida que el sistema debe rechazar —
      // y los rechazaba: ése era el `Unauthorized: resume_token not recognized` con el que
      // el encargo ROBOT-1 dejó cuatro caminos en rojo.
      resumeToken:  FIXTURE.resumeToken,
      emailId:      FIXTURE.emailId,
    }
  : {
      emailKnown:   FIXTURE.emailKnown,
      emailUnknown: FIXTURE.emailUnknown,
      apellido:     'PruebaE2E',
      resumeToken:  FIXTURE.resumeToken,
      emailId:      FIXTURE.emailId,
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

// ── LA COSTURA: reenvío al backend REAL, con el doble salto de GAS ────────────
// Una web app de GAS contesta en DOS pasos: el POST devuelve 302 con `Location:`
// y el JSON está en ese segundo URL. `curl -L` (y `redirect:'follow'`) NO valen:
// convierten el POST en GET y el echo devuelve una página de error de Drive.
// Verificado a mano con curl contra el /exec real antes de escribir esto.
const CUOTA_RE = /Service invoked too many times|Limit Exceeded|too many times for one day|quota/i
let cuotaVista = null            // mensaje literal de Google, si la cuota se agotó
let cuotaDelCamino = null        // ídem, acotado al recorrido en curso
let idaYVueltaMin = Infinity     // latencia REAL mínima observada (ms)

async function reenviarAlBackendReal(payload) {
  const t0 = Date.now()
  try {
    const salto1 = await fetch(GAS_URL, {
      method: 'POST',
      redirect: 'manual',                       // el 302 se maneja a mano: ver arriba
      headers: { 'Content-Type': 'text/plain' },  // lo que manda el propio wizard
      body: JSON.stringify(payload),
    })
    const destino = salto1.headers.get('location')
    let texto
    if (destino) {
      texto = await (await fetch(destino)).text()
    } else {
      // Sin redirección (algunos errores de Google contestan directos): se lee tal cual.
      texto = await salto1.text()
    }
    idaYVueltaMin = Math.min(idaYVueltaMin, Date.now() - t0)
    if (CUOTA_RE.test(texto)) {
      cuotaVista = cuotaDelCamino = texto.replace(/\s+/g, ' ').trim().slice(0, 240)
      return { ok: false, error: { code: 'E2E_CUOTA', message: cuotaVista } }
    }
    try { return JSON.parse(texto) } catch {
      // Google devolvió HTML (sesión, error de despliegue, página de consentimiento):
      // se propaga el principio del cuerpo LITERAL, sin interpretarlo.
      return { ok: false, error: { code: 'E2E_NO_JSON', message: texto.replace(/\s+/g, ' ').trim().slice(0, 240) } }
    }
  } catch (e) {
    return { ok: false, error: { code: 'E2E_RED', message: String((e && e.message) || e).slice(0, 240) } }
  }
}

function startServer() {
  const server = createServer((req, res) => {
    if (req.method === 'POST' && req.url.startsWith('/__gas')) {
      let body = ''
      req.on('data', (d) => { body += d })
      req.on('end', async () => {
        let payload = {}
        try { payload = JSON.parse(body || '{}') } catch { /* payload vacío */ }
        const responder = (out) => {
          res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' })
          res.end(JSON.stringify(out))
        }
        if (REAL) {
          record({ action: payload && payload.action, payload })
          return responder(await reenviarAlBackendReal(payload))
        }
        const out = dispatch(payload)
        // Latencia simulada: sin ella no se puede distinguir un avance optimista
        // de uno que espera al servidor. En real no se inyecta: ya tarda de verdad.
        setTimeout(() => responder(out), LATENCY)
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

// `esperarWizard` se RETIRÓ: esperaba SOLO al stepper, así que un enlace rechazado se
// manifestaba como tiempo de espera agotado en vez de decir que el token no valía. La espera
// vive ahora dentro de `entrarPorElEnlace`, que distingue los dos finales observables.

/** Llamadas registradas de una acción concreta en el recorrido en curso. */
const llamadas = (accion) => calls.filter(c => c.action === accion)

/**
 * Peticiones a /__gas todavía EN VUELO en la página (contador que alimenta el
 * runner con los eventos de red de Playwright).
 *
 * Por qué existe: los envíos de la portada son fire-and-forget y ENCADENAN
 * (`sendMagicLink` → `warmBundle`). Si la batería se va de la página a mitad de
 * vuelo, el navegador aborta el fetch y la app registra un error de red que NO es
 * suyo, sino del robot. Contra el backend simulado bastaba un temporizador fijo
 * (la latencia la ponemos nosotros); contra el sistema REAL el tiempo lo decide
 * Google —enviar el correo pasa por el KMS— y cualquier número fijo es una
 * apuesta. Se espera al SILENCIO de red, no al reloj.
 */
const enVuelo = { n: 0 }
async function esperarSilencioDeRed(msMax = 120000, msQuieto = 2500) {
  const t0 = Date.now()
  let desde = null
  for (;;) {
    if (enVuelo.n > 0) desde = null
    else if (desde == null) desde = Date.now()
    else if (Date.now() - desde >= msQuieto) return true
    if (Date.now() - t0 > msMax) return false      // se reporta como lo que sea que falle después
    await new Promise(r => setTimeout(r, 150))
  }
}

// ── 4.bis · El expediente vivo de esta corrida ───────────────────────────────
//
// Lo rellena `alta-nueva` en cuanto el sistema da de alta la familia, leyendo del ORIGEN
// lo mismo que el correo del enlace mágico llevaría (`resume_token` + `?n=`). El robot no
// puede abrir el buzón de Gmail; abrir el buzón tampoco es parte del producto.
const EXPEDIENTE = { gid: null, listo: false }

/**
 * Pide al KMS el enlace de recuperación de la familia del robot y lo instala en `DATOS`.
 * A partir de ese momento los caminos que necesitan sesión entran con el token REAL.
 */
function recuperarElEnlace(c, email) {
  let r = sonda('manual_robotEnlaceDeRecuperacion', [email])
  if (!r.ok) {
    c.fallos.push(`no se pudo obtener el enlace de recuperación del expediente: ${r.error}`)
    return false
  }
  let s = r.resultado || {}

  // ── MEDIDO el 2026-08-03: la portada NO crea el expediente en este arnés ────────────
  // La pantalla dijo «te hemos enviado un enlace» y la base no tenía nada. No es que el
  // wizard esté roto: con un correo sin grupo, `sendMagicLink_` delega en
  // `initEnrollmentSession_`, cuya verja reCAPTCHA es FAIL-CLOSED, y el robot compila el
  // bundle SIN clave de reCAPTCHA (`VITE_RECAPTCHA_SITE_KEY: ''`) ⇒ manda token nulo ⇒ la
  // verja lo para y se traga el fallo para no delatar el camino (WIZ-ENUM). En producción
  // la clave existe; aquí no.
  //
  // Se declara la carencia con su motivo —NO se finge verde, ni se tiñe de rojo el
  // producto por una limitación del arnés— y se da de alta el expediente por la pasarela
  // para que los diez pasos siguientes sean medibles. Lo que NO se hace: tocar la verja ni
  // pedir la llave que se la salta.
  if (!s.ok) {
    c.noCubierta('alta-desde-la-portada',
      'la portada no llegó a crear el expediente: la verja reCAPTCHA de initEnrollmentSession_ ' +
      'es FAIL-CLOSED y este arnés compila el bundle sin clave de reCAPTCHA, así que manda token ' +
      'nulo. Es una carencia del ARNÉS, no del wizard (en producción la clave existe). El ack ' +
      'constante de la portada no lo delata — por eso hace falta mirar la base. ' +
      `Motivo del sistema: ${s.error || 'sin motivo'}`)
    const alta = sonda('manual_robotCrearExpediente', [email])
    if (!alta.ok || !(alta.resultado || {}).ok) {
      c.fallos.push(`tampoco se pudo dar de alta el expediente por la pasarela: ${alta.error || (alta.resultado || {}).error}`)
      return false
    }
    c.notas.push('    · expediente dado de alta por la PASARELA (la portada no pudo: ver la no-cobertura de arriba)')
    r = sonda('manual_robotEnlaceDeRecuperacion', [email])
    s = (r.resultado || {})
    if (!r.ok || !s.ok) {
      c.fallos.push(`el expediente se creó pero no se pudo localizar después: ${r.error || s.error}`)
      return false
    }
  }
  EXPEDIENTE.gid = s.enrollment_group_id
  EXPEDIENTE.listo = true
  DATOS.resumeToken = s.resume_token
  if (s.email_id) DATOS.emailId = s.email_id
  c.notas.push(`✓ expediente dado de alta y localizado (${String(s.enrollment_group_id).slice(0, 8)}…, ${r.ms} ms)`)
  if (!s.email_id) {
    // No es una carencia: la fila de `enrEmails` de la que sale el `?n=` la escribe el paso
    // de PERSONAS, que todavía no ha corrido. Se anota, y el enlace se vuelve a pedir
    // después de ese paso (`refrescarElEnlace`) para que la recuperación sea per-guardian.
    c.notas.push('    · aún sin ?n= (la fila de enrEmails la escribe el paso de personas); se re-pedirá luego')
  }
  return true
}

/** Vuelve a pedir el enlace: tras el paso de personas ya existe el `?n=` per-guardian. */
function refrescarElEnlace(c, email) {
  const r = sonda('manual_robotEnlaceDeRecuperacion', [email])
  const s = (r.resultado || {})
  if (!r.ok || !s.ok) return false
  if (s.resume_token) DATOS.resumeToken = s.resume_token
  if (s.email_id) {
    DATOS.emailId = s.email_id
    c.notas.push('    · enlace refrescado: ya viaja con identidad per-guardian (?n=)')
    return true
  }
  c.noCubierta('identidad-per-guardian-en-el-enlace',
    'ni siquiera tras el paso de personas hay fila en enrEmails para el correo del tutor que ' +
    'recupera: el enlace viajaría sin ?n= y la recuperación sería de GRUPO, no per-guardian. ' +
    `Motivo del sistema: ${s.email_id_ausente_motivo || '(no informado)'}`)
  return false
}

/**
 * ENTRADA — el robot entra como entra una familia: siguiendo el enlace VIGENTE.
 *
 * ── El defecto que cierra, MEDIDO el 2026-08-03 contra el sistema real ──────────────
 * El robot leía el enlace UNA vez (en `alta-nueva`) y lo reusaba en los cuatro caminos de
 * navegador siguientes. Pero **pedir el enlace ROTA el `resume_token`**: `sendMagicLink_`
 * (`origin/main:backend/Code.js:2605-2625`) llama a `enr.wizardTouchSession` por cada grupo
 * NO enviado y el KMS minta y persiste un token nuevo. Como el camino inmediatamente
 * siguiente (`ack-indistinguible`) pide el enlace del correo CONOCIDO, el token que el robot
 * llevaba encima quedaba muerto y los cuatro caminos morían con
 * `Unauthorized: resume_token not recognized` (`Code.js:483`).
 *
 * Medido, no razonado — dos lecturas de `enrEnrollmentGroups` con UNA petición de enlace en
 * medio, mismo grupo `1d9c4668-…`:
 *     tras el alta              resume_token = 7cacaa26-29e0-450f-8338-16acdc5068bf
 *     tras UN sendMagicLink     resume_token = 14e3ead7-0f3d-46d7-9243-69326cc7e764
 *
 * ── Qué hace ───────────────────────────────────────────────────────────────────────
 *   `pidiendolo:true`  — el acto COMPLETO de la familia: teclea su correo en la portada
 *                        (⇒ `sendMagicLink` de verdad, que rota el token y manda el correo)
 *                        y SIGUE el enlace recién emitido.
 *   `pidiendolo:false` — SIGUE el enlace vigente, sin volver a pedirlo.
 *
 * ── Por qué NO se pide en los cuatro caminos (limitación medida, no pereza) ─────────
 * El cupo de magic-link es de **5 por correo y hora** (`Code.js:1741`, `RATE_LIMITED`), y por
 * encima el servidor **se traga la petición en silencio** — ack constante, sin rotar y sin
 * mandar nada (WIZ-ENUM). Pedirlo en cada camino haría que a partir del sexto el acto que se
 * dice medir dejara de ocurrir **sin que se note**: el robot seguiría entrando (el token vivo
 * sigue sirviendo) sobre una petición que el servidor descartó. Ese verde sería peor que un
 * rojo. Se pide UNA vez, en el camino que se llama justamente `recuperar-aterrizar`, y allí
 * se AFIRMA que el enlace recién pedido es el que abre la sesión — si la rotación no ocurre
 * (por cupo o por lo que sea), ese camino cae y lo dice.
 *
 * El robot no abre Gmail: lee del ORIGEN lo mismo que el correo lleva
 * (`manual_robotEnlaceDeRecuperacion`, con su guardarraíl de marcador `+robot-`). Abrir el
 * buzón no es parte del producto; llevar encima un token caducado sí era un defecto del robot.
 */
async function entrarPorElEnlace(c, page, base, { pidiendolo = false } = {}) {
  if (REAL) {
    if (pidiendolo) await rellenarPortada(page, base, DATOS.emailKnown)
    const anterior = DATOS.resumeToken
    const r = sonda('manual_robotEnlaceDeRecuperacion', [DATOS.emailKnown])
    const s = r.resultado || {}
    if (!r.ok || !s.ok) {
      c.fallos.push(`no se pudo leer el enlace vigente del expediente: ${r.error || s.error}`)
      return false
    }
    DATOS.resumeToken = s.resume_token
    if (s.email_id) DATOS.emailId = s.email_id
    if (pidiendolo) {
      c.afirmar('pedir el enlace emite un token nuevo (la rotación de sendMagicLink_)',
        !!DATOS.resumeToken && DATOS.resumeToken !== anterior,
        `el resume_token NO cambió al pedir el enlace (${String(anterior).slice(0, 8)}… → ${String(DATOS.resumeToken).slice(0, 8)}…): o la rotación no ocurrió, o la petición se suprimió por cupo (5/hora) y el acto que este camino mide no llegó a pasar`)
    }
  }

  await page.goto(`${base}/#/resume/${DATOS.resumeToken}?n=${DATOS.emailId}`,
    { waitUntil: 'domcontentloaded', timeout: REAL ? 90000 : 30000 })

  // El aterrizaje tiene DOS finales observables, y se esperan LOS DOS: el stepper (sesión
  // abierta) o el rebote a `#/?resume_error=1` (`ResumePage.jsx`, rama `.catch`). Antes se
  // esperaba solo al stepper, así que un enlace RECHAZADO se manifestaba como un tiempo de
  // espera agotado — el síntoma más caro de diagnosticar y el que menos dice.
  // El tiempo de espera es GENEROSO a propósito y se MIDE: el hidratado real de un
  // expediente tarda 12-22 s (medido el 2026-08-04 con tres llamadas seguidas al `/exec`:
  // 22.069 / 13.161 / 12.040 ms), pero se ha visto un caso ajeno de 94 s sin explicar. Lo
  // que NO se hace es subir el número a ciegas: se imprime SIEMPRE lo que tardó, de modo que
  // un aterrizaje lento deje número en el registro en vez de un tiempo agotado mudo.
  const tEntrada = Date.now()
  const desenlace = await page.waitForFunction(() => {
    if (/resume_error=1/.test(window.location.hash + window.location.search)) return 'rechazado'
    const pasos = document.querySelectorAll('.wizard-step')
    return (pasos.length && [...pasos].some(p => p.classList.contains('active'))) ? 'abierto' : false
  }, { timeout: REAL ? 180000 : LATENCY * 3 + 15000 })
    .then(h => h.jsonValue())
    .catch(() => 'sin-desenlace')
  const msEntrada = Date.now() - tEntrada

  if (desenlace !== 'abierto') {
    c.fallos.push(desenlace === 'rechazado'
      ? `el enlace NO abre la sesión: el wizard rebotó a la portada con resume_error=1 — el sistema no reconoce el token ${String(DATOS.resumeToken).slice(0, 8)}… del enlace (${msEntrada} ms)`
      : `el enlace no llegó a abrir la sesión ni a rebotar: el wizard no pintó el stepper en ${msEntrada} ms (token ${String(DATOS.resumeToken).slice(0, 8)}…)`)
    return false
  }
  c.notas.push(`✓ el enlace abre la sesión (aterrizaje en ${msEntrada} ms)`)
  return true
}

/** Ejecuta la sonda de lectura de vuelta de un paso y vuelca su veredicto en el camino. */
function leerDeVuelta(c, fn, etiqueta, conducidoPor = 'navegador') {
  if (!REAL) return true                       // en simulado no hay base que leer
  if (!EXPEDIENTE.listo) {
    c.fallos.push(`${etiqueta} — no hay expediente que consultar: el alta no llegó a ocurrir, así que la lectura de vuelta no se pudo hacer`)
    return false
  }
  return aplicarSonda(c, etiqueta, sonda(fn, [EXPEDIENTE.gid]), conducidoPor)
}

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
  // Deja respirar a las llamadas de FONDO antes de irse de la página (ver
  // `esperarSilencioDeRed`). Con backend simulado la latencia la ponemos nosotros y
  // basta el reloj; contra el sistema real el tiempo lo decide Google, así que se
  // espera al silencio de red.
  if (REAL) await esperarSilencioDeRed()
  else await page.waitForTimeout(LATENCY * 2 + 900)
  return page.evaluate(sondaPantalla)
}

async function caminoAltaNueva(page, base) {
  const c = new Camino('alta-nueva')
  scenario.magicLinkMode = 'constant'

  // En real se da de alta el correo CONOCIDO: así el camino siguiente compara un email que
  // el sistema conoce de verdad contra uno que no, y el expediente que las once sondas van
  // a seguir es éste. En simulado se mantiene el desconocido (el fixture no tiene estado).
  const correoDelAlta = REAL ? DATOS.emailKnown : DATOS.emailUnknown
  const pantalla = await rellenarPortada(page, base, correoDelAlta)

  c.evidencia.elementos = pantalla.tarjetas + (pantalla.sobreEnviado ? 1 : 0)
  c.afirmar('la portada confirma el envío del enlace', pantalla.sobreEnviado,
    'no apareció la confirmación genérica de "te hemos enviado un enlace"')
  c.afirmar('sin pantalla de error', !pantalla.errorFatal, 'el ErrorBoundary pintó "Something went wrong."')

  const envios = llamadas('sendMagicLink')
  c.afirmar('sale UNA sola petición de enlace', envios.length === 1,
    `se registraron ${envios.length} llamadas a sendMagicLink (se espera exactamente 1)`)
  if (envios.length) {
    c.afirmar('la petición lleva el email tecleado',
      envios[0].payload && envios[0].payload.primary_email === correoDelAlta,
      `primary_email recibido: ${envios[0].payload && envios[0].payload.primary_email}`)
  } else {
    c.noCubierta('email-en-la-peticion', 'no hubo ninguna petición que inspeccionar')
  }
  // El casi-incidente: el cliente NO puede decidir recuperar-vs-crear.
  c.afirmar('el cliente NO crea la sesión por su cuenta', llamadas('initEnrollmentSession').length === 0,
    `el cliente llamó a initEnrollmentSession ${llamadas('initEnrollmentSession').length} vez/veces: volvió a ramificar en el cliente`)

  // ── LECTURA DE VUELTA (paso 1). Que la pantalla diga "te hemos enviado un enlace" no
  //    prueba que exista expediente: el ack es CONSTANTE a propósito (WIZ-ENUM), así que
  //    dice lo mismo haya pasado lo que haya pasado. Esto mira la base de datos.
  if (REAL) {
    if (recuperarElEnlace(c, correoDelAlta)) {
      leerDeVuelta(c, 'manual_robotSonda01Correo', 'paso 1 · correo y sesión')
    }
  }
  return c
}

async function caminoAckIndistinguible(page, base) {
  const c = new Camino('ack-indistinguible')

  // (a) Email CONOCIDO vs DESCONOCIDO — el servidor responde igual (ack constante).
  scenario.magicLinkMode = 'constant'
  calls = []
  const pantallaConocido = await rellenarPortada(page, base, DATOS.emailKnown)
  const accionesConocido = calls.map(x => x.action).join(',')

  calls = []
  const pantallaDesconocido = await rellenarPortada(page, base, DATOS.emailUnknown)
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
  //     Contra el sistema REAL este escenario no se puede fabricar (el servidor es
  //     el de verdad): se declara NO CUBIERTA con su motivo, nunca se finge verde.
  if (REAL) {
    c.noCubierta('servidor-que-delata',
      'el escenario hostil (servidor que devuelve el error legacy "Enrollment group not found") no se puede FORZAR sobre el backend de verdad sin desplegarle un cambio; en modo simulado sí se cubre')
    return c
  }
  c.esperarErrorConsola(/sendMagicLink: server returned ok=false/,
    'escenario hostil deliberado: el servidor simulado delata que el email no existe; la app debe tragarse el fallo de cara al usuario pero SÍ registrarlo')
  scenario.magicLinkMode = 'legacy_error'
  calls = []
  const pantallaLegacy = await rellenarPortada(page, base, DATOS.emailUnknown)
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

  // Éste es EL camino de la entrada, así que aquí se hace el acto entero: pedir el enlace
  // por la portada y seguir el que el sistema acaba de emitir.
  if (!await entrarPorElEnlace(c, page, base, { pidiendolo: true })) return c
  const pantalla = await page.evaluate(sondaPantalla)

  c.evidencia.elementos = pantalla.pasos + pantalla.campos

  c.afirmar('el wizard pinta sus 11 pasos', pantalla.pasos === 11,
    `se pintaron ${pantalla.pasos} pasos en el stepper`)
  c.afirmar('sin pantalla de error', !pantalla.errorFatal, 'el ErrorBoundary pintó "Something went wrong."')
  // El paso donde "estaba la familia" NO es el mismo en los dos modos, y fingir que sí lo
  // es sería el error de siempre: en simulado el escenario coloca el expediente con los
  // pasos 1-5 completos (⇒ Documentos, índice 5).
  //
  // ── Contra el sistema REAL el expediente recién dado de alta aterriza en el índice 1,
  //    no en el 0, y eso es CORRECTO. MEDIDO el 2026-08-04, no supuesto: un expediente
  //    creado por la pasarela y sin tocar ya trae `desired_start_date` puesta —
  //      hydrateSession → group.desired_start_date = "2026-04-08"  (la fecha de creación)
  //    — aunque el KMS la inserta explícitamente a NULL (`enr/wizard-gateway.gs:778`): quien
  //    la rellena es el **Initial Value de la columna en AppSheet**. El wizard marca el paso
  //    0 completo cuando hay fecha (`WizardContext.jsx`, `hasStartDate` → `completed.add(0)`),
  //    así que el primer paso incompleto ES el 1. La expectativa anterior (0) venía de
  //    suponer que "no tiene nada relleno"; la tabla dice otra cosa y gana la tabla.
  //    ⚠️ Que AppSheet pre-rellene esa fecha es un HALLAZGO del producto (la familia se
  //    encuentra el paso 1 dado por hecho, con la fecha de hoy). Anotado en
  //    `kis-app/docs/kms/pendiente-tras-verde.md`; no se arregla aquí.
  const pasoEsperado = REAL ? 1 : 5
  c.afirmar(`aterriza en el paso que le corresponde al expediente (índice ${pasoEsperado})`,
    pantalla.pasoActivo === pasoEsperado,
    `aterrizó en el paso índice ${pantalla.pasoActivo} (se esperaba ${pasoEsperado})`)
  // KAL-7: el token es un secreto de 7 días; no puede quedarse en la barra.
  c.afirmar('el token desaparece de la barra de direcciones (KAL-7)',
    pantalla.hash === '#/apply',
    `el hash quedó en "${pantalla.hash}"`)

  const hidrataciones = llamadas('hydrateSession')
  if (!hidrataciones.length) {
    c.fallos.push('la recuperación no llegó a pedir la sesión — hydrateSession nunca se llamó')
  } else {
    const p = hidrataciones[0].payload || {}
    c.afirmar('la recuperación viaja con el token del enlace', p.resume_token === DATOS.resumeToken,
      `resume_token recibido: ${String(p.resume_token).slice(0, 8)}…`)
    c.afirmar('la recuperación viaja con la identidad del enlace (n = email_id)',
      p.n === DATOS.emailId, `n recibido: ${p.n}`)
  }
  return c
}

async function caminoGuardarPaso(page, base) {
  const c = new Camino('guardar-paso')
  scenario.stage = 'sin_fecha'   // sin fecha ⇒ aterriza en el paso 1 (índice 0)

  if (!await entrarPorElEnlace(c, page, base)) return c

  let pantalla = await page.evaluate(sondaPantalla)
  c.evidencia.elementos = pantalla.pasos + pantalla.campos
  // Contra el sistema real el primer paso incompleto es el 1, porque AppSheet pre-rellena
  // `desired_start_date` al crear el expediente (medido — ver el comentario largo en
  // `caminoRecuperarAterrizar`). En simulado el escenario `sin_fecha` lo deja en el 0.
  const aterrizajeEsperado = REAL ? 1 : 0
  if (!c.afirmar(`aterriza en el primer paso incompleto (índice ${aterrizajeEsperado})`,
    pantalla.pasoActivo === aterrizajeEsperado,
    `aterrizó en el índice ${pantalla.pasoActivo}, no en ${aterrizajeEsperado}`)) return c
  c.afirmar('sin pantalla de error', !pantalla.errorFatal, 'el ErrorBoundary pintó "Something went wrong."')

  // Para editar la FECHA hay que estar en el paso de la fecha. Si la familia aterrizó más
  // adelante (el caso real: el paso 0 ya cuenta como completo), vuelve atrás como volvería
  // ella — con el botón «Atrás». Es un acto de la familia, no un atajo del robot: retomar y
  // corregir un paso ya dado es exactamente lo que este camino dice medir.
  // OJO con los selectores: «Atrás» (StepNav) y «Editar» (LockedBanner) comparten la MISMA
  // clase `btn-secondary-kis` (`components/LockedBanner.jsx:16`). Lo que los distingue es el
  // icono: el de editar lleva `i.bi-pencil`. Coger «el primer .btn-secondary-kis» pulsaría el
  // que estuviera antes en el DOM —y el banner va arriba—, así que se nombran por separado.
  const ATRAS  = 'button.btn-secondary-kis:not(:has(i.bi-pencil))'
  const EDITAR = 'button.btn-secondary-kis:has(i.bi-pencil)'

  if (pantalla.pasoActivo > 0) {
    const volver = await page.$(ATRAS)
    if (!volver) {
      c.fallos.push(`aterrizó en el índice ${pantalla.pasoActivo} y el paso no ofrece botón «Atrás»: no hay forma de volver al paso de la fecha`)
      return c
    }
    await volver.click()
    try {
      await page.waitForFunction(() => {
        const pasos = [...document.querySelectorAll('.wizard-step')]
        return pasos.findIndex(p => p.classList.contains('active')) === 0
      }, { timeout: 15000 })
    } catch {
      c.fallos.push('al pulsar «Atrás» el wizard no volvió al paso de la fecha (índice 0)')
      return c
    }
    // Un paso ya completado se recupera BLOQUEADO tras su banner: para tocarlo hay que pulsar
    // «Editar». Es el gesto de la familia que vuelve a cambiar la fecha, no un atajo.
    const editar = await page.$(EDITAR)
    if (editar) {
      await editar.click()
      c.notas.push('✓ el paso ya completado se recupera bloqueado y se desbloquea con «Editar»')
    }
    // Si el campo sigue sin poder tocarse, el camino cae AQUÍ y lo dice, en vez de fallar
    // más abajo con un «no se pudo escribir la fecha» que no nombra la causa.
    const editable = await page.$eval('input[type="date"], #mid', el => !el.disabled).catch(() => false)
    if (!c.afirmar('tras «Editar», el paso de la fecha vuelve a ser editable', editable,
      'el campo sigue deshabilitado: la familia no podría corregir su fecha al volver')) return c
  }

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
  // Anti-coladero: el avance solo demuestra ser OPTIMISTA si el servidor tarda más
  // que el presupuesto. En simulado lo garantiza el invariante de arriba; contra el
  // sistema real hay que MEDIRLO — si el backend contestara dentro del presupuesto,
  // la afirmación se ejecutaría en vacío y eso NO es verde.
  if (REAL && !(idaYVueltaMin > FEEDBACK_BUDGET_MS)) {
    c.noCubierta('avance-optimista',
      `el backend real contestó en ${idaYVueltaMin} ms, dentro del presupuesto de ${FEEDBACK_BUDGET_MS} ms: un avance "inmediato" podría venir del servidor y la medida no demuestra nada`)
  } else {
    c.afirmar(`el avance es inmediato (${ms} ms ≤ ${FEEDBACK_BUDGET_MS} ms)`,
      ms <= FEEDBACK_BUDGET_MS,
      `tardó ${ms} ms con una latencia ${REAL ? `REAL mínima de ${idaYVueltaMin}` : `simulada de ${LATENCY}`} ms: el avance está esperando al servidor en vez de ser optimista`)
  }

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
      g.resume_token === DATOS.resumeToken, 'el saveStep salió sin el resume_token de la sesión')
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

  if (!await entrarPorElEnlace(c, page, base)) return c

  let pantalla = await page.evaluate(sondaPantalla)

  // Contra el sistema REAL el expediente recién dado de alta aterriza en el paso 1, y el
  // robot todavía no conduce en navegador los pasos 2-5 que hay que rellenar para llegar a
  // Documentos. En vez de fingir un verde (o de teñir de rojo el producto por una carencia
  // del robot), se declara lo que hay: esta parte NO está cubierta desde la pantalla, y su
  // motivo viaja hasta el veredicto. La escritura del documento sí queda cubierta por la
  // pasarela y la sonda del paso 6 la verifica leyendo `recFiles`.
  if (REAL && pantalla.pasoActivo !== 5) {
    c.evidencia.elementos = pantalla.pasos + pantalla.campos
    c.afirmar('sin pantalla de error', !pantalla.errorFatal, 'el ErrorBoundary pintó "Something went wrong."')
    c.noCubierta('subida-desde-la-pantalla',
      `el expediente aterriza en el índice ${pantalla.pasoActivo} y el robot aún no conduce en navegador los pasos 2-5 necesarios para llegar a Documentos (índice 5). Lo cierra el encargo 03.`)
    c.noCubierta('contenido-de-la-subida',
      'no hubo subida DESDE LA PANTALLA que inspeccionar; el contenido de la fila lo afirma la sonda del paso 6')
    return c
  }
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
      p.resume_token === DATOS.resumeToken, 'el uploadDocument salió sin el resume_token de la sesión')
  } else {
    c.noCubierta('contenido-de-la-subida', 'no hubo ninguna subida que inspeccionar')
  }
  c.afirmar('la pantalla confirma la subida', subidaOk,
    'nunca apareció la confirmación visible de archivo subido (.upload-status.success)')
  return c
}

/**
 * EXPEDIENTE COMPLETO — el camino que hace ALCANZABLES los pasos 8-11 (solo modo real).
 *
 * ── Qué hace, en orden ───────────────────────────────────────────────────────────────
 *   1. Rellena por la PASARELA los pasos 2-6 (personas, vínculos, salud, documento).
 *   2. DRENA la cola hasta que no queda trabajo del expediente — las escrituras del wizard
 *      son asíncronas, y medir antes de que terminen es medir a medio escribir.
 *   3. Lee de vuelta los pasos 2 a 6 con sus sondas.
 *   4. ENVÍA (paso 7) y lo lee de vuelta.
 *   5. Lleva el expediente a `AD` con el MOTOR REAL de transiciones — que es lo que
 *      DESTAPA los pasos 8-11. Sin esto, cinco pasos no se medirían nunca.
 *   6. Lee de vuelta los pasos 8 a 11.
 *
 * ── Lo que este camino NO afirma, y hay que tener presente ──────────────────────────
 * Los pasos 2-7 los conduce la PASARELA, no el navegador: prueba que el KMS acepta el
 * payload real y deja el efecto escrito, **no** que el wizard mande ese payload. Cada
 * resultado va etiquetado con quién lo condujo, y el encargo 03 convierte `pasarela` en
 * `navegador` paso a paso. Etiquetarlo es la diferencia entre una medida y una coartada.
 */
async function caminoExpedienteCompleto() {
  const c = new Camino('expediente-completo')
  if (!EXPEDIENTE.listo) {
    c.fallos.push('no hay expediente: el alta no llegó a ocurrir, así que no hay nada que completar ni a dónde llegar')
    return c
  }
  // Este camino no toca el navegador: su evidencia son las llamadas al KMS y las filas
  // que deja escritas. Se declara aquí para que el mínimo de evidencia no lo tumbe por
  // "pantalla vacía" — no hay pantalla, y decirlo es más honesto que inflar el número.
  c.evidencia.elementos = 11
  c.evidencia.llamadas = 1

  const paso = (fn, etiqueta, params = [EXPEDIENTE.gid]) => {
    const r = sonda(fn, params)
    if (!r.ok) { c.fallos.push(`${etiqueta}: ${r.error}`); return null }
    const s = r.resultado || {}
    if (s.veredicto === 'ROJO') {
      for (const f of (s.fallos || ['sin detalle'])) c.fallos.push(`${etiqueta} — ${f}`)
    } else {
      c.notas.push(`✓ ${etiqueta} (${r.ms} ms)`)
    }
    const d = s.datos || {}
    const resumen = Object.keys(d).slice(0, 25).map(k => `${k}=${d[k]}`).join('  ')
    if (resumen) c.notas.push(`    · ${resumen}`)
    return s
  }

  // 1 · Rellenar 2-6 por la pasarela.
  paso('manual_robotCompletarHastaEnvio', 'rellenar pasos 2-6 (pasarela)')

  // 2 · Drenar hasta que no quede trabajo. El driver insiste; el KMS solo hace turnos
  //     cortos. Ése es el reparto que evita el corte de seis minutos de Apps Script.
  let pendientes = -1
  for (let intento = 1; intento <= 4; intento++) {
    const r = sonda('manual_robotDrenar', [EXPEDIENTE.gid, 120])
    if (!r.ok) { c.fallos.push(`drenar la cola (intento ${intento}): ${r.error}`); break }
    const s = r.resultado || {}
    pendientes = Number(s.pendientes_n != null ? s.pendientes_n : (s.datos && s.datos.pendientes_n))
    c.notas.push(`    · drenaje ${intento}: ${(s.datos && s.datos.estados) || '(sin trabajos)'} → pendientes=${pendientes}`)
    if (pendientes === 0) break
  }
  if (pendientes > 0) {
    c.fallos.push(`la cola no terminó: quedan ${pendientes} trabajo(s) del expediente sin completar tras 4 turnos de drenaje — todo lo que se mida a continuación estaría a medio escribir`)
  }

  // 3 · Leer de vuelta los pasos 2-6. Antes se re-pide el enlace: con las personas ya
  //     escritas existe la fila de `enrEmails` de la que sale el `?n=`, y a partir de aquí
  //     la recuperación es per-guardian (que es como funciona de verdad).
  refrescarElEnlace(c, DATOS.emailKnown)
  leerDeVuelta(c, 'manual_robotSonda02Personas', 'paso 2 · personas', 'pasarela')
  leerDeVuelta(c, 'manual_robotSonda03Vinculos', 'paso 3 · vínculos', 'pasarela')
  leerDeVuelta(c, 'manual_robotSonda04Salud', 'paso 4 · salud', 'pasarela')
  leerDeVuelta(c, 'manual_robotSonda05Preguntas', 'paso 5 · preguntas', 'pasarela')
  leerDeVuelta(c, 'manual_robotSonda06Documentos', 'paso 6 · documentos', 'pasarela')

  // 4 · Enviar y leerlo de vuelta.
  paso('manual_robotEnviar', 'enviar la solicitud (paso 7, pasarela)')
  leerDeVuelta(c, 'manual_robotSonda07Envio', 'paso 7 · envío', 'pasarela')

  // 5 · A `AD` con el motor real: lo que destapa los pasos 8-11.
  paso('manual_robotLlevarAEstado', 'admitir el expediente (motor de estados)', [EXPEDIENTE.gid, 'AD'])

  // 6 · Leer de vuelta los pasos 8-11.
  leerDeVuelta(c, 'manual_robotSonda08Facturacion', 'paso 8 · facturación', 'pasarela')
  leerDeVuelta(c, 'manual_robotSonda09Consentimientos', 'paso 9 · consentimientos', 'pasarela')
  leerDeVuelta(c, 'manual_robotSonda10Revision', 'paso 10 · revisión', 'pasarela')
  leerDeVuelta(c, 'manual_robotSonda11Firma', 'paso 11 · firma', 'pasarela')
  return c
}

async function caminoTramoFirma(page, base) {
  const c = new Camino('tramo-firma')
  scenario.stage = 'firma'   // ADMITIDA + firma abierta ⇒ primer paso de firma (7)

  if (!await entrarPorElEnlace(c, page, base)) return c
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
  // Solo en real: rellena 2-7, admite el expediente y lee de vuelta los once pasos. Va
  // ANTES del tramo de firma porque es lo que lo destapa (sin `AD` no hay firma que pintar).
  ...(REAL ? [{ nombre: 'expediente-completo', fn: caminoExpedienteCompleto, minLlamadas: 0, minElementos: 11 }] : []),
  { nombre: 'tramo-firma',         fn: caminoTramoFirma,         minLlamadas: 1, minElementos: 11 },
]

// ── 7 · Runner ───────────────────────────────────────────────────────────────
async function main() {
  if (!SKIP_BUILD || !existsSync(join(DIST, 'index.html'))) buildBundle()

  const { chromium } = await loadPlaywright()
  const server = await startServer()
  const base = `http://127.0.0.1:${server.address().port}`
  if (REAL) {
    console.log(`[robot] wizard servido en ${base} — /__gas REENVÍA al sistema REAL`)
    console.log(`[robot] destino:  ${GAS_URL}`)
    console.log(`[robot] correos:  ${DATOS.emailKnown} · ${DATOS.emailUnknown}  (buzón de pruebas, sub-dirección por identidad)`)
    console.log(`[robot] marcador: ${MARCA}   ⚠️ SE ESCRIBE EN EL SISTEMA DE VERDAD Y SALEN CORREOS REALES`)

    // ── Sin sondas NO se arranca. Un robot que no puede mirar la base de datos afirmaría
    //    solo sobre la pantalla, y ése es exactamente el agujero que este encargo cierra:
    //    un paso que pinta bien y no guarda nada saldría VERDE. Perder la lectura de vuelta
    //    no es "no aplica", es quedarse ciego — y se para antes de empezar.
    const sinSondas = porQueNoHaySondas()
    if (sinSondas) {
      server.close()
      printVerdict(false, `sin lectura de vuelta: ${sinSondas}`)
      process.exit(1)
    }
    console.log(`[robot] sondas:   ${KMS_REPO}/scripts/gas-run-via-api.mjs`)

    // ── RESET: el bucle tiene que ser repetible. Sin borrar la familia sintética de la
    //    corrida anterior, la segunda corrida mide datos de la primera y cualquier
    //    afirmación de conteo se vuelve mentira acumulativa.
    const rst = sonda('manual_resetFamiliaRobot')
    if (!rst.ok) {
      server.close()
      printVerdict(false, `no se pudo dejar el sistema a cero antes de empezar: ${rst.error}`)
      process.exit(1)
    }
    const r0 = rst.resultado || {}
    if (r0.veredicto !== 'VERDE') {
      server.close()
      printVerdict(false, `el reset previo no dejó el sistema a cero: ${(r0.fallos || []).join(' | ')}`)
      process.exit(1)
    }
    console.log(`[robot] reset:    sistema a cero (grupos borrados: ${(r0.datos && r0.datos.grupos_borrados) || 0})\n`)
  } else {
    console.log(`[e2e] wizard servido en ${base} (backend simulado en /__gas, latencia ${LATENCY} ms)\n`)
  }

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

    // Contador de peticiones al backend en vuelo (ver `esperarSilencioDeRed`).
    const esNuestra = (r) => r.url().includes('/__gas')
    page.on('request',        (r) => { if (esNuestra(r)) enVuelo.n++ })
    page.on('requestfinished',(r) => { if (esNuestra(r)) enVuelo.n-- })
    page.on('requestfailed',  (r) => { if (esNuestra(r)) enVuelo.n-- })
    enVuelo.n = 0

    calls = []
    unmockedActions = new Set()
    cuotaDelCamino = null
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
    // CUOTA: si Google cortó por límite de envío, el recorrido NO probó nada — pero
    // eso NO es un defecto del camino de inscripción. Se marca aparte para no
    // atribuir al producto un rojo que es de la cuota. Sigue sin ser verde.
    c.cuota = cuotaDelCamino
    resultados.push(c)

    const flag = c.cuota ? '⚠' : (c.fallos.length ? '✗' : '✓')
    console.log(`  ${flag} ${c.nombre}  (${totalLlamadas} llamadas, ${c.evidencia.elementos || 0} elementos)`)
    if (c.cuota) console.log(`      ⚠ CUOTA de Google (NO es defecto del camino): ${c.cuota}`)
    for (const n of c.notas)  console.log(`      ${n}`)
    for (const f of c.fallos) console.log(`      ✗ ${f}`)
    for (const nc of c.noCubiertas) console.log(`      · NO CUBIERTA «${nc.etiqueta}»: ${nc.motivo}`)

    await context.close()
  }

  await browser.close()
  server.close()

  // ── Resumen ────────────────────────────────────────────────────────────────
  const conCuota = resultados.filter(r => r.cuota)
  const conFallo = resultados.filter(r => r.fallos.length && !r.cuota)
  console.log(`\n  caminos ejecutados:  ${resultados.length} de ${seleccionados.length}`)
  console.log(`  caminos en verde:    ${resultados.filter(r => !r.fallos.length && !r.cuota).length}`)
  console.log(`  caminos en rojo:     ${conFallo.length}`)
  if (conCuota.length) console.log(`  caminos por CUOTA:   ${conCuota.length}  (no son defecto del camino de inscripción)`)
  if (REAL) console.log(`  latencia real mín.:  ${idaYVueltaMin === Infinity ? 'n/d' : idaYVueltaMin + ' ms'}`)

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
  // CUOTA antes que nada: en cuanto Google corta por límite de envío, todo lo que
  // venga después es ruido. No es verde (no se probó), pero tampoco es un rojo del
  // camino de inscripción — y atribuirlo mal cuesta un ciclo entero de diagnóstico.
  if (conCuota.length) {
    printVerdict(false, `CUOTA de Google agotada en ${conCuota.length} camino(s) (${conCuota.map(r => r.nombre).join(', ')}) — NO es un defecto del camino de inscripción; reintentar cuando el cupo se reponga. Mensaje literal: ${conCuota[0].cuota}`)
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
