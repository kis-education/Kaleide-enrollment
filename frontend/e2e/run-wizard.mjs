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
import { createDispatcher, buildHydrate, FIXTURE, RESPUESTA_GUARDADA, DOCUMENTOS_GUARDADOS, DOCUMENTOS_SIN_DESCRIPCION } from './mock-backend.mjs'
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
  'fecha-a-mitad-de-curso': {
    'limite-ilegible': 'el escenario hostil (el servidor devuelve los límites del programa en el formato crudo de AppSheet) no se puede FORZAR sobre el backend de verdad sin desplegarle un cambio; en modo simulado sí se cubre',
  },
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
    // LA ÚNICA no-cobertura DELIBERADA de todo el recorrido, y la única que no se retira
    // nunca: el acto de firmar sale a un tercero y es irreversible. El interruptor
    // `CLICK_AND_SIGN_SUSPENDED_` está PROHIBIDO tocar. Se declara aquí porque la sonda del
    // paso 11 solo llega a emitirla cuando la preparación SÍ ocurre — antes se cortaba antes.
    'paso 11 · firma·firma.acto_consumado_click_and_sign': 'no se llama al proveedor Click & Sign: el interruptor CLICK_AND_SIGN_SUSPENDED_ está prohibido tocar y el acto es irreversible y sale a un tercero. Se cubre TODO lo anterior —sesión, firmantes, tokens y paquete— y se corta exactamente en el salto al proveedor.',
    'paso 3 · vínculos·vinculos.tipo_resuelve_en_catalogo': 'el catálogo de tipos de vínculo no se pudo leer con los nombres de tabla probados (sysRelationTypes / personRelationTypes). El vínculo CONCRETO y su custodia sí se afirman; lo que queda sin comprobar es que el identificador de tipo resuelva a una fila viva.',
    // ── La ÚNICA no-cobertura de conducción legítima (encargo 08) ────────────────────
    // Lo que el navegador podría conducir del paso 11 es el ACTO de firmar, y ése está
    // PROHIBIDO: sale a Click & Sign, es irreversible, y el interruptor
    // CLICK_AND_SIGN_SUSPENDED_ no se toca. Todo lo anterior —sesión, firmantes, tokens y
    // paquete— lo prepara el motor del KMS al admitir y se lee de vuelta.
    'paso 11 · firma·conducido-por-navegador': 'el paso 11 se recorre hasta el BORDE del acto y ahí se corta a propósito: firmar sale a un tercero (Click & Sign) y es irreversible. Lo que el navegador sí conduce son los pasos 8, 9 y 10 que llevan hasta él; la preparación de la firma la produce el motor del KMS al admitir y se lee de vuelta en la base.',
  },
  'documentos-vuelven': {
    'documentos-tras-el-codigo': 'la secuencia exige teclear el código de un solo uso que el servidor manda al buzón de la familia, y el arnés no lee buzones; en modo simulado sí se cubre',
    'descripciones-vuelven': 'misma razón: sin pasar la verja no hay segunda hidratación que inspeccionar',
    'archivos-reconocibles': 'misma razón: no se llega a la pantalla de Documentos con archivos ya subidos',
    'anadir-no-borra-lo-que-habia': 'misma razón: no se llega a la pantalla de Documentos con archivos ya subidos',
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
// Registros `[DBG …]` que emite el PRODUCTO por consola. NO son errores: se guardan
// aparte para que una afirmación pueda CITARLOS al fallar. Antes se tiraban a la basura
// (el capturador solo miraba `type()==='error'`), y por eso un rojo del paso 5 no podía
// decir si lo tecleado llegaba al estado o si lo que fallaba era el envío: había que
// volver a correr a ciegas 35 min. Se vacía por recorrido, como `calls`.
let registrosDbg = []
const record = (c) => { calls.push({ ...c, at: Date.now() }) }
record.unmocked = (a) => { unmockedActions.add(String(a)) }

// Escenario MUTABLE que los caminos reconfiguran antes de navegar.
// `formatoFechasPrograma`: 'iso' (lo que manda el servidor de verdad) | 'appsheet' (el
// formato crudo 'MM/DD/YYYY' de la API — escenario hostil de ①31).
// `piiGated`/`otpSuperado`/`documentos`: la verja de datos personales (DL-E39) y los
// archivos ya subidos — los usa `documentos-vuelven` y los deja como estaban al salir.
const scenario = { stage: 'hasta_preguntas', magicLinkMode: 'constant', saveStepFails: false, preguntasMode: 'ok', correccionMode: 'ok', respuestasMode: 'ok', partes: 'unica', formatoFechasPrograma: 'iso', piiGated: false, otpSuperado: false, documentos: null }
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

// ── TRANSPORTE ROTO ≠ el sistema dijo que no ─────────────────────────────────
// El doble salto de GAS falla a veces en el SEGUNDO tramo: el `/exec` ejecuta la
// acción y devuelve su 302, pero el `echo` contesta la página de Drive «Sorry,
// unable to open the file at this time» en vez del JSON. Reproducido a mano con
// curl el 2026-08-04: 1 de cada 3 lecturas del mismo `Location:`.
//
// Antes eso se convertía en un `{ok:false}` que se le entregaba a la aplicación
// como si fuese la RESPUESTA DEL SERVIDOR. La aplicación entonces se comportaba
// distinto (no encadenaba `warmBundle`, pintaba otra cosa) y el robot le echaba
// la culpa al producto: `la secuencia de llamadas es la misma en ambos casos` salió
// ROJA porque el arnés no pudo LEER una respuesta, no porque el wizard ramificara.
// Un rojo así es peor que no tener robot: acusa al inocente.
//
// Ahora se marca aparte, igual que la CUOTA: sigue sin ser verde (no se probó
// nada), pero NO se atribuye al camino de inscripción.
const TRANSPORTE_ROTO_RE = /unable to open the file|Page Not Found|Moved Temporarily|<!DOCTYPE html|<HTML>/i
let transporteDelCamino = null   // {accion, codigo, mensaje} del recorrido en curso

// ── Reintento de la LECTURA, que sirve TAMBIÉN para las escrituras ────────────
//
// ⚠️ CORRECCIÓN DE UNA MEDICIÓN ANTERIOR (2026-08-04). Aquí ponía que el `echo` es de
// un solo uso y que releer el mismo `Location:` «NO recupera nada», así que el único
// reintento posible era repetir el POST — y por eso quedaba vedado a las escrituras.
// Esa medición existió, pero medía otra cosa: releía un `Location:` **ya consumido por
// una lectura CON ÉXITO**. Claro que la segunda vez daba «Moved Temporarily»: el vale
// ya se había gastado. **Lo que nunca se midió es el caso que importa** — releer un
// `Location:` cuya PRIMERA lectura FALLÓ.
//
// Medido el 2026-08-04 contra el `/exec` real, 42 peticiones con una acción inexistente
// (no escribe nada, mismo doble salto), en dos tandas de 12 y 30:
//     primera lectura OK = 41   ·   FALLÓ = 1  («unable to open the file»)
//     de la que falló: RECUPERA releyendo el MISMO Location = 1  (a la 1.ª relectura)
// O sea: un fallo del `echo` **no consume el vale**. La respuesta sigue ahí y se puede
// volver a pedir. La muestra es corta —un solo fallo— y por eso lo que se afirma es
// exactamente eso y nada más: que releer tras un fallo RECUPERÓ, y que releer NO
// re-ejecuta nada. Si un día no recuperase, el camino sigue cayendo en TRANSPORTE, que
// es donde debe caer.
//
// Consecuencia, que es la que arregla el rojo: **el reintento va en la LECTURA, no en
// el POST.** La acción se ejecutó UNA sola vez —el POST no se repite—, así que releer
// es seguro para `sendMagicLink` igual que para `hydrateSession`: no manda otro correo,
// no rota otro token, no gasta otro punto del cupo, y no rompe la afirmación «sale UNA
// sola petición de enlace». Por eso ya no hace falta lista blanca alguna para recuperar
// el caso normal.
//
// La lista blanca SOBREVIVE para el caso distinto y peor: cuando ni releyendo se
// obtiene respuesta (o el POST mismo falla). Ahí sí hay que repetir la llamada entera, y
// eso sigue vedado a todo lo que escriba.
const ACCIONES_REPETIBLES = new Set([
  'hydrateSession',   // lectura: arma el estado de la sesión, no escribe
  'warmBundle',       // precalentado best-effort, idempotente por diseño
])

// ── Acciones cuyo EFECTO se comprueba en la BASE, no en el acuse ──────────────
//
// MEDIDO: el segundo tramo del doble salto de GAS se pierde con `sendMagicLink` una y otra
// vez (corridas de las 10:41, 11:20 y 13:02 — tres de tres). Hasta ahora eso tumbaba el
// camino ENTERO como TRANSPORTE, y con él la única medida que este encargo produce.
//
// Pero perder el ACUSE de `sendMagicLink` no es lo mismo que no saber qué pasó: Google
// emite el 302 **después** de ejecutar el `doPost`, y el arnés comprueba el efecto REAL
// leyendo la base — `manual_robotEnlaceDeRecuperacion` dice si el `resume_token` rotó, que
// es exactamente lo que ese acuse iba a contar. Y el acuse, por diseño (WIZ-ENUM), es
// CONSTANTE: no lleva información. O sea: se pierde el recibo, no el dato.
//
// Regla de la casa aplicada al pie de la letra: **¿qué hay en la base? una consulta a la
// tabla, NADA MÁS.** Así que para estas acciones el fallo del segundo tramo se REGISTRA y
// se imprime (degradación conocida), pero NO tumba el camino — y la afirmación que de
// verdad importa, la rotación, sigue siendo dura: si el acto no ocurrió, esa afirmación
// cae y el camino se pone rojo por su cuenta.
//
// Lo que NO se hace, y no se hará: fabricar una respuesta. El cliente recibe el error tal
// cual, y su reacción sigue siendo observable.
//
// ── Y NO se arregla cambiando de cliente HTTP. MEDIDO el 2026-08-04 ──────────────────
// Se sospechaba del `fetch` de Node (undici) a través del proxy de salida, porque el
// `CLAUDE.md` del KMS documenta que `curl` túnela donde undici falla. Se midió: cuatro
// saltos dobles contra el `/exec` real con `fetchLookups` (lectura pública, sin
// escrituras ni correos), alternando lector —
//     node 43.1 s → JSON bueno      ·  curl 48.2 s → JSON bueno
//     node 34.5 s → HTML de Google  ·  curl 37.6 s → HTML de Google
// Los DOS lectores fallan igual y en la misma tanda ⇒ **el fallo está en el lado de
// Google, no en el cliente**. Muestra corta (4) y se dice como tal: no se afirma una tasa,
// se afirma que cambiar de cliente NO es el remedio. Nótese de paso la latencia real:
// 34-48 s por llamada, que es lo que hace que una corrida dure lo que dura.
const EFECTO_VERIFICADO_EN_LA_BASE = new Set([
  'sendMagicLink',    // la rotación del resume_token se comprueba leyendo enrEnrollmentGroups
  // Los pasos que el navegador conduce tienen CADA UNO su sonda de lectura de vuelta
  // (`manual_robotSonda02..07`): si el efecto no está escrito, esa sonda lo dice y el camino
  // cae por ahí. Perder el acuse de la escritura no añade información — y sí tumbaba el
  // recorrido entero por un fallo que ya sabemos que es del lado de Google.
  'saveStep',         // personas / vínculos / salud / fecha → sondas 2, 3, 4 y 1
  'saveResponses',    // cuestionario → sonda 5
  'uploadDocument',   // documentos → sonda 6
  'saveNeae',         // NEAE, best-effort por diseño; no hay afirmación que dependa del acuse
  'warmBundle',       // precalentado best-effort: por definición no afirma nada
  // ── El que ha matado d4, d5, d6 y d8, y NO es del arnés ──────────────────────────
  // MEDIDO: `getLiveStateVersion` lo llama la APLICACIÓN, no el robot — `WizardPage.jsx:170`,
  // dentro de un `setInterval(tick, 30 * 1000)` que corre mientras hay sesión abierta y la
  // pestaña visible. El arnés no añade ni una llamada suya (en `mock-backend.mjs` solo está
  // el simulacro). O sea: NO se puede quitar sin dejar de recorrer lo que recorre la familia.
  //
  // Entonces, ¿por qué mata él y no otros? Porque es EL MÁS FRECUENTE: un pulso cada 30 s
  // durante todo el rato que la página está abierta. Con un transporte que falla del orden
  // de la mitad de las veces, el que más tira es el que más cae. No es que esté roto: es
  // que tiene más papeletas.
  //
  // Y perder su respuesta NO cuesta cobertura: es un contador de detección de cambio. Si se
  // pierde un pulso, el siguiente (30 s después) lo recoge; y nada de lo que el robot
  // AFIRMA depende de él — el estado del expediente se lee de la base con las sondas, no de
  // este contador. Lo mismo vale para el detalle que dispara (`getAdmissionState`).
  'getLiveStateVersion',
  'getAdmissionState',
])
// Acciones de ESTE recorrido cuyo acuse se perdió por transporte (para no contar como
// fallo del producto el error de consola que el propio arnés provoca).
let degradacionesDelCamino = new Set()
const REINTENTOS = 2
const RELECTURAS = 4          // relecturas del MISMO Location tras un fallo del echo
// 8 s, y creciendo con cada intento (8/16/24). MEDIDO: el eco falla con HTTP 404 cuando
// el POST tarda (91,5 s frente a 32,5 s del sano), asi que reintentar a 1,2 s era
// reintentar dentro del mismo parpadeo y declarar roto lo que solo estaba tardando.
const RELECTURA_ESPERA_MS = 8000

/**
 * ¿Es este cuerpo la COMPROBACIÓN DE SALUD del wizard en vez de la respuesta a la petición?
 *
 * MEDIDO el 2026-08-04, y con esto se acaba una incógnita que llevaba tres corridas: las
 * respuestas «con `ok` falso y SIN error de ninguna forma» (`hydrateSession`,
 * `fetchQuestions`, `warmBundle`, `warmSession`) traían de claves **`status,ts`** — que es
 * exactamente, y solo, lo que devuelve el `doGet` del wizard
 * (`origin/main:backend/Code.js:1583-1585`, `{status:'ok', ts:<iso>}`).
 *
 * O sea: el segundo tramo del doble salto de Apps Script degradó a un **GET normal de la
 * aplicación web**, que ejecuta el `doGet`, en vez de reproducir el resultado del POST. Es
 * la misma familia que el «`echo` de un solo uso» ya anotado — **transporte**, no producto.
 *
 * Por qué importa arreglarlo aquí: ese cuerpo ES JSON válido, así que el arnés lo daba por
 * respuesta buena y se lo entregaba a la aplicación. El cliente leía `ok` como falso y
 * pintaba *«Unknown server error»*, o rebotaba a la portada con un enlace bueno. **Un rojo
 * inventado por el instrumento**, acusando al producto de algo que no hizo.
 *
 * El reconocimiento es ESTRECHO a propósito: exactamente dos claves, `status` y `ts`, y sin
 * `ok`. Toda respuesta de verdad del wizard trae `ok`, así que esto no puede tragarse una.
 */
function esComprobacionDeSalud(texto) {
  let o
  try { o = JSON.parse(texto) } catch { return false }
  if (!o || typeof o !== 'object' || Array.isArray(o)) return false
  const claves = Object.keys(o)
  return claves.length === 2 && claves.includes('status') && claves.includes('ts')
}

async function unSaltoDoble(payload) {
  const salto1 = await fetch(GAS_URL, {
    method: 'POST',
    redirect: 'manual',                       // el 302 se maneja a mano: ver arriba
    headers: { 'Content-Type': 'text/plain' },  // lo que manda el propio wizard
    body: JSON.stringify(payload),
  })
  const destino = salto1.headers.get('location')
  // Sin redirección (algunos errores de Google contestan directos): se lee tal cual.
  if (!destino) return salto1.text()
  // La respuesta se pide hasta `RELECTURAS` veces AL MISMO `Location:` — sin repetir el
  // POST, así que la acción no se vuelve a ejecutar (ver el bloque de arriba). Se para en
  // cuanto el cuerpo es JSON, que es la única señal de haber leído de verdad.
  let ultimo = ''
  for (let lectura = 1; lectura <= RELECTURAS; lectura++) {
    // ── El segundo tramo se lee SIN seguir redirecciones a ciegas ────────────────────
    // MEDIDO el 2026-08-04: cuando falla, lo que llega es una PÁGINA DE PRODUCTO de Google
    // («Web word processing…»), igual con `node` que con `curl`. Siguiendo la redirección en
    // silencio, esa página es todo lo que se ve y el diagnóstico se queda en «HTML de
    // Google». Leyendo el salto A MANO se puede DECIR a dónde manda y con qué código, que es
    // la diferencia entre un fallo diagnosticable y uno que obliga a repetir la corrida.
    const r2 = await fetch(destino, { redirect: 'manual' })
    // ── Qué contesta el eco cuando falla, MEDIDO el 2026-08-04 con UNA sola llamada ────
    // No es una redirección: es **HTTP 404** con la página de producto de Google. Y no es
    // aleatorio — correlaciona con un POST largo:
    //     salto1 302 → salto2 HTTP 200, 32.459 ms  (sano)
    //     salto1 302 → salto2 HTTP 404, 91.557 ms  (roto)
    // O sea: cuando el `doPost` del wizard tarda, el vale del eco todavía no tiene la
    // respuesta guardada cuando se va a recoger. Por eso ahora (a) se DICE el código —
    // «HTTP 404» es diagnosticable, «HTML de Google» no lo era— y (b) la relectura espera
    // en la escala del problema, no en la de antes: con 1,2 s se reintentaba tres veces
    // dentro del mismo parpadeo y se declaraba roto lo que solo estaba tardando.
    if (r2.status !== 200) {
      const donde = r2.headers.get('location')
      ultimo = `[E2E_SALTO2_HTTP_${r2.status}] el eco contestó ${r2.status}` +
        (donde ? ` y manda a ${String(donde).slice(0, 80)}` : ' (sin cabecera Location)') +
        ' en vez de devolver el resultado del POST'
      if (lectura < RELECTURAS) { await new Promise(r => setTimeout(r, RELECTURA_ESPERA_MS * lectura)); continue }
      return ultimo
    }
    ultimo = await r2.text()
    // La comprobación de salud es JSON válido pero NO es la respuesta: se relee como si no
    // se hubiera podido leer nada, que es lo que de verdad ha pasado.
    if (!esComprobacionDeSalud(ultimo)) {
      try { JSON.parse(ultimo); return ultimo } catch { /* sigue */ }
    }
    if (CUOTA_RE.test(ultimo)) return ultimo          // la cuota no se releé: es respuesta
    if (lectura < RELECTURAS) await new Promise(r => setTimeout(r, RELECTURA_ESPERA_MS))
  }
  return ultimo
}

async function reenviarAlBackendReal(payload, accion) {
  const t0 = Date.now()
  const transporte = (codigo, mensaje) => {
    const nombre = String(accion || '(sin acción)')
    if (EFECTO_VERIFICADO_EN_LA_BASE.has(nombre)) {
      // Degradación conocida: se pierde el acuse, no el dato (ver el bloque de arriba). Se
      // registra e imprime, pero el camino sigue y su afirmación dura decide.
      degradacionesDelCamino.add(nombre)
      console.log(`  … ${new Date().toISOString().slice(11, 19)}  acuse de «${nombre}» perdido por transporte; el efecto se comprueba en la base`)
    } else {
      transporteDelCamino = transporteDelCamino ||
        { accion: nombre, codigo, mensaje: String(mensaje).slice(0, 200) }
    }
    return { ok: false, error: { code: codigo, message: String(mensaje).slice(0, 240) } }
  }
  const repetible = ACCIONES_REPETIBLES.has(String(accion || ''))
  try {
    let texto = ''
    let ultimoFallo = ''
    for (let intento = 0; intento <= (repetible ? REINTENTOS : 0); intento++) {
      texto = await unSaltoDoble(payload)
      if (CUOTA_RE.test(texto)) break                       // la cuota no se reintenta
      if (!esComprobacionDeSalud(texto)) {
        try { JSON.parse(texto); break } catch { /* sigue */ }
      }
      ultimoFallo = texto.replace(/\s+/g, ' ').trim()
      if (!repetible) break
      if (intento < REINTENTOS) await new Promise(r => setTimeout(r, 1500))
    }
    idaYVueltaMin = Math.min(idaYVueltaMin, Date.now() - t0)
    if (CUOTA_RE.test(texto)) {
      cuotaVista = cuotaDelCamino = texto.replace(/\s+/g, ' ').trim().slice(0, 240)
      return { ok: false, error: { code: 'E2E_CUOTA', message: cuotaVista } }
    }
    if (esComprobacionDeSalud(texto)) {
      // El transporte contestó con la COMPROBACIÓN DE SALUD del wizard (`doGet`) en vez de
      // con el resultado del POST. NO es una respuesta del servidor a esta petición: no se
      // le entrega a la aplicación como si lo fuera (eso pintaba «Unknown server error» y
      // echaba a la familia con un enlace bueno). Va al cubo de TRANSPORTE, que es lo que es.
      return transporte('E2E_TRANSPORTE',
        `el segundo tramo del salto devolvió la comprobación de salud del wizard (doGet: ${texto.replace(/\s+/g, ' ').trim().slice(0, 120)}) en vez del resultado del POST`)
    }
    try { return JSON.parse(texto) } catch {
      // El arnés NO PUDO LEER la respuesta (ni tras los reintentos, si los hubo). No se
      // sabe qué hizo el servidor, así que no se afirma nada sobre él: transporte roto
      // con el cuerpo LITERAL, y aparte del veredicto del producto.
      const cuerpo = ultimoFallo || texto.replace(/\s+/g, ' ').trim()
      return transporte(TRANSPORTE_ROTO_RE.test(cuerpo) ? 'E2E_TRANSPORTE' : 'E2E_NO_JSON', cuerpo)
    }
  } catch (e) {
    return transporte('E2E_RED', String((e && e.message) || e))
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
          const accion = payload && payload.action
          const out = await reenviarAlBackendReal(payload, accion)
          // Se registra TAMBIÉN lo que contestó el servidor. Antes solo se guardaba la
          // pregunta, y un rojo obligaba a repetir la corrida entera para saber la
          // respuesta — que es justo lo que la casa prohíbe.
          // El MOTIVO va con el código: el wizard devuelve `error` como CADENA cuando el
          // fallo no lleva código (`doPost`, rama sin `err.code`), y guardando solo el
          // código esos rojos salían como «(sin código de error)» — sin una palabra de
          // por qué. Medido el 2026-08-04: costó una corrida entera no saberlo. El texto
          // ya viene saneado del servidor (`sanitizeErrorForClient_`: emails y UUID
          // redactados, 200 caracteres), y aquí se recorta otra vez.
          const errObj = out && out.error
          // ── LA LÍNEA LITERAL DE LO QUE SALE DEL NAVEGADOR (2026-08-04) ──────────────────
          // Autorizado tras la corrida de las 19:05, donde la pregunta «¿salió el saveStep
          // con step:'relations'?» NO se pudo contestar con la salida: el arnés registraba la
          // llamada pero no la imprimía nunca. Hubo que sustituirla por la lectura de vuelta
          // —que es más fuerte cuando el dato LLEGA a la base—, pero **no sirve de nada
          // cuando el fallo está aguas arriba**: si la escritura no sale del navegador, o sale
          // y muere en el transporte, la base está vacía por dos motivos distintos y la
          // lectura de vuelta no los distingue.
          // Se imprime el NOMBRE del paso y si el servidor lo acusó — NUNCA el contenido del
          // paso, que es PII de la familia (KAL-11). `step` es un identificador cerrado
          // ('persons', 'relations', 'health'…), no un dato personal.
          if (REAL && accion === 'saveStep') {
            const paso = (payload && payload.step) || '(sin step)'
            const ack = (out && out.ok) ? 'ok' :
              `NO (${(errObj && errObj.code) || (typeof errObj === 'string' ? 'error' : 'sin código')})`
            traza(`→ saveStep step='${paso}' — acuse del servidor: ${ack}`)
          }
          record({ action: accion, payload, respuesta: {
            ok:     !!(out && out.ok),
            codigo: (errObj && errObj.code) || null,
            motivo: (typeof errObj === 'string' ? errObj : (errObj && errObj.message) || '').slice(0, 200) || null,
            // Y si NO hay error de ninguna forma, las CLAVES de lo que llegó. Medido el
            // 2026-08-04: `hydrateSession`, `fetchQuestions`, `warmBundle` y `warmSession`
            // volvieron con `ok` falso y **sin error, sin código y sin mensaje** — o sea que
            // ni el código ni el motivo dicen nada, y la corrida no deja con qué diagnosticar.
            // Las claves distinguen las dos formas posibles (una respuesta de trabajo que trae
            // su propio `ok`, o un objeto vacío) sin sacar ni un valor: solo nombres.
            claves: (!errObj && out && typeof out === 'object') ? Object.keys(out).slice(0, 12).join(',') : null,
            // La VERJA de re-verificación, tal como la reporta el servidor. Es un booleano,
            // no lleva ni un dato de la familia, y sin él la pérdida de cobertura de los
            // pasos de PII era invisible: el robot conducía tres pasos cuyas escrituras el
            // servidor iba a rechazar, y solo se notaba como «error de consola».
            stepUpFresh: (out && typeof out === 'object' && 'step_up_fresh' in out)
              ? !!out.step_up_fresh : null,
          } })
          return responder(out)
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
// ── Inventario de lo que el arnés le quita al navegador ──────────────────────
// Origen → nº de peticiones abortadas. Se imprime al final de la corrida: un sandbox que
// recorta sin decir qué recorta es una fuente de rojos falsos difíciles de diagnosticar.
const abortadas = new Map()

const CONSOLA_PERMITIDA = [
  /Failed to load resource/i,
  /net::ERR_FAILED/i,
  /ERR_BLOCKED_BY_CLIENT/i,
  /ERR_CONNECTION_REFUSED/i,
]

// ⚠️ `page.waitForFunction(fn, ARG, OPCIONES)` — el segundo parámetro posicional es el
// ARGUMENTO de la función, NO las opciones. Escribir `waitForFunction(fn, { timeout: X })`
// NO da error: pasa `{timeout:X}` como argumento a la página y aplica el tiempo de espera
// POR DEFECTO de Playwright, 30 s. Aquí lo hacían LOS CINCO call-sites, y se pagó caro:
// `recuperar-aterrizar` y `tramo-firma` cayeron con «no pintó el stepper en 30006 ms» /
// «30005 ms» —el 30 exacto delata el defecto— mientras el fichero decía esperar 180 s.
// Cuando falla una espera, mirar PRIMERO si el número es sospechosamente 30.000.
// Siempre: `waitForFunction(fn, null, { timeout })`.

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
    }, null, { timeout: LATENCY + 5000 })
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
  // ── El identificador ENTERO y la hora, en la salida ─────────────────────────────
  // El reset de la corrida siguiente BORRA este expediente. Si un rojo hay que cruzarlo
  // después con la base, el registro es la única copia que queda — y con el id recortado a
  // ocho caracteres no se puede consultar nada. Hoy se perdieron dos expedientes de un rojo
  // de vínculos por exactamente esto: evidencia destruida por higiene.
  console.log(`  … ${new Date().toISOString().slice(11, 19)}  EXPEDIENTE DE ESTA CORRIDA: ${s.enrollment_group_id}  (${DATOS.emailKnown})`)
  c.notas.push(`✓ expediente dado de alta y localizado (${s.enrollment_group_id}, ${r.ms} ms)`)
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
async function entrarPorElEnlace(c, page, base, { pidiendolo = false, nOverride = null } = {}) {
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

  // DL-E49 §2 (mock-only): `nOverride` deja entrar con el `n` de OTRO tutor sin cambiar
  // el resume_token del grupo — el mismo enlace de grupo, distinto email_id, que es
  // exactamente cómo el servidor real distingue quién pregunta (IDENTITY-FROM-LINK).
  const nEfectivo = nOverride || DATOS.emailId
  await page.goto(`${base}/#/resume/${DATOS.resumeToken}?n=${nEfectivo}`,
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
  }, null, { timeout: REAL ? 180000 : LATENCY * 3 + 15000 })
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

/**
 * ¿Quedó abierta la VERJA de re-verificación (DL-E39) al entrar?
 *
 * ── Por qué existe, MEDIDO el 2026-08-04 ────────────────────────────────────────────
 * El robot condujo por navegador personas, vínculos y salud; el wizard le dejó avanzar los
 * tres pasos; y el servidor rechazó los TRES `saveStep` con `STEPUP_REQUIRED`. La cobertura
 * se perdía EN SILENCIO: los pasos «se recorrían» y no escribían nada.
 *
 * `STEPUP_REQUIRED` **no es un defecto del wizard**: es su verja haciendo su trabajo. Los
 * pasos que tocan PII (personas / vínculos / salud) exigen una ventana de step-up fresca, y
 * la única que el robot tiene es la GRACIA del magic-link — de UN SOLO USO y 10 minutos
 * DUROS, sin deslizar. Cuando esa ventana no está abierta, conducir esos pasos es teatro.
 *
 * Así que se COMPRUEBA antes, leyendo lo que el propio servidor dice (`step_up_fresh` de la
 * hidratación). Ni se debilita la verja, ni se abre un atajo que un tercero pudiera usar:
 * solo se mira el semáforo antes de cruzar.
 *
 * @returns {boolean|null} true/false según el servidor; null si no lo dijo.
 */
function verjaAbierta() {
  const hidrataciones = calls.filter(c => c.action === 'hydrateSession' || c.action === 'resumeSession')
  for (let i = hidrataciones.length - 1; i >= 0; i--) {
    const v = hidrataciones[i].respuesta && hidrataciones[i].respuesta.stepUpFresh
    if (v === true || v === false) return v
  }
  return null
}

/**
 * Drena la cola de trabajos del expediente hasta que no quede ninguno.
 *
 * El reparto es el de siempre: **el driver insiste** (Node, sin límite) y **el KMS hace
 * turnos cortos** (Apps Script corta a los seis minutos). Se llama DOS veces en el
 * recorrido —tras rellenar los pasos 2-6 y **tras admitir**— porque las dos cosas encolan
 * trabajo. Ver el bloque 5.bis de `caminoExpedienteCompleto` para lo segundo, que es lo
 * que tenía el paso 11 en rojo.
 *
 * @param {Camino} c
 * @param {string} etiqueta — de qué drenaje se trata, para que la salida lo diga.
 * @param {number} [turnos=4]
 */
function drenar(c, etiqueta, turnos = 20) {
  traza(`drenando la cola ${etiqueta}`)
  let pendientes = -1
  let fallidos = 0
  let esperando = 0
  let motivos = ''
  for (let intento = 1; intento <= turnos; intento++) {
    // ── POR QUÉ 40 s y no 120 (MEDIDO el 2026-08-04) ────────────────────────────────
    // El turno de 120 s se pasó del transporte: `curl: (28) Operation timed out after
    // 360.000 ms`. El presupuesto solo se mira ENTRE trabajos, así que el tiempo real de
    // una llamada es «presupuesto + lo que dure el trabajo que lo rebase», y los trabajos
    // que genera la admisión (generar un PDF, tocar Drive) duran minutos. Con 40 s el
    // margen hasta los 360 s del corte de Apps Script da para un trabajo largo entero.
    // Turnos altos porque los lotes son pequeños: admitir dejó 16 trabajos en cola.
    const r = sonda('manual_robotDrenar', [EXPEDIENTE.gid, 40])
    if (!r.ok) { c.fallos.push(`drenar la cola ${etiqueta} (intento ${intento}): ${r.error}`); return }
    const s = r.resultado || {}
    pendientes = Number(s.pendientes_n != null ? s.pendientes_n : (s.datos && s.datos.pendientes_n))
    fallidos = Number(s.fallidos_n != null ? s.fallidos_n : (s.datos && s.datos.fallidos_n)) || 0
    esperando = Number(s.esperando_n != null ? s.esperando_n : (s.datos && s.datos.esperando_reintento_n)) || 0
    motivos = s.fallidos_motivos || (s.datos && s.datos.motivos) || ''
    c.notas.push(`    · drenaje ${etiqueta} ${intento}: ${(s.datos && s.datos.estados) || '(sin trabajos)'} → pendientes=${pendientes} esperando=${esperando} fallidos=${fallidos}`)
    // ── PENDIENTE ≠ FALLIDO (2026-08-04, MEDIDO) ────────────────────────────────────
    // Un trabajo en `Failed` es TERMINAL: agotó sus intentos y no va a correr por muchos
    // turnos más que se le den. Antes contaba como pendiente, así que con los dos
    // `RULE_ACTION:Failed` del permiso de Drive este bucle gastaba SIEMPRE sus 20 turnos
    // —una pasada llegó a durar ~230 s— y empujaba a las sondas contra el corte de seis
    // minutos de Apps Script. Ahora se para cuando no queda nada por CORRER, y lo que
    // murió se dice UNA vez, con su motivo, en vez de esperarlo en vano.
    if (pendientes === 0) {
      if (fallidos > 0) {
        c.fallos.push(`la cola terminó ${etiqueta} con ${fallidos} trabajo(s) MUERTOS (agotaron sus intentos): ${String(motivos).slice(0, 400)} — su efecto no ocurrió, así que lo que dependa de él estará sin escribir`)
      }
      if (esperando > 0) {
        // Un trabajo que ya falló y espera su reintento (respaldo de 2, 4, 8, 16, 32 min)
        // NO va a correr dentro de esta ventana: esperarlo son veinte turnos tirados.
        c.fallos.push(`la cola quedó ${etiqueta} con ${esperando} trabajo(s) esperando su reintento tras fallar: ${String(motivos).slice(0, 400)} — no corren dentro de esta corrida, así que su efecto no está escrito`)
      }
      return
    }
  }
  c.fallos.push(`la cola no terminó ${etiqueta}: quedan ${pendientes} trabajo(s) del expediente por correr tras ${turnos} turnos de drenaje — todo lo que se mida a continuación estaría a medio escribir`)
}

// Quién condujo cada paso y con qué resultado. Se imprime al final: la tabla de los once
// pasos es LA respuesta a la pregunta que el encargo 08 hace, y tenerla que reconstruir a
// mano desde el registro es justo lo que invita a contarla mal.
const CONDUCTORES = new Map()

/**
 * Ejecuta un LOTE de sondas en UNA sola llamada y vuelca cada veredicto por separado.
 *
 * Mismo contrato que `leerDeVuelta` para cada pieza —etiqueta, quién condujo, no-cubiertas,
 * tabla de los once— pero un solo salto doble contra Apps Script en vez de cinco. La razón
 * está medida: el segundo tramo del salto devuelve HTTP 404 cuando el POST tarda, y eso no
 * se arregla desde aquí; lo que sí está en nuestra mano es TIRAR MENOS VECES.
 *
 * Si el lote entero no se puede leer, caen las cinco piezas nombradas — no se silencia
 * ninguna: perder la lectura de vuelta es cobertura perdida, no «no aplica».
 */
function leerLoteDeVuelta(c, fn, conducidoPor = 'navegador') {
  if (!REAL) return true
  if (!EXPEDIENTE.listo) {
    c.fallos.push('lote de lecturas de vuelta — no hay expediente que consultar: el alta no llegó a ocurrir')
    return false
  }
  const r = sonda(fn, [EXPEDIENTE.gid])
  const piezas = (r.ok && r.resultado && Array.isArray(r.resultado.lote)) ? r.resultado.lote : null
  if (!piezas || !piezas.length) {
    const motivo = r.ok ? 'el lote no devolvió ninguna pieza' : r.error
    for (const etq of ['paso 1 · correo y sesión', 'paso 2 · personas', 'paso 3 · vínculos',
      'paso 4 · salud', 'paso 5 · preguntas']) {
      c.fallos.push(`${etq} — la lectura de vuelta NO se pudo hacer (lote): ${motivo}`)
      CONDUCTORES.set(etq, { quien: conducidoPor, estado: 'lectura perdida' })
    }
    return false
  }
  let todasVerdes = true
  for (const p of piezas) {
    const ok = aplicarSonda(c, p.etiqueta, { ok: true, resultado: p.sonda, ms: r.ms }, conducidoPor)
    CONDUCTORES.set(p.etiqueta, {
      quien: conducidoPor,
      estado: conducidoPor !== 'navegador' ? 'NO CUBIERTO' : (ok ? 'verde' : 'rojo'),
    })
    if (!ok) todasVerdes = false
  }
  c.notas.push(`    · lote de ${piezas.length} lecturas en UNA tirada (${r.ms} ms) — antes eran ${piezas.length} saltos dobles`)
  return todasVerdes
}

/** Ejecuta la sonda de lectura de vuelta de un paso y vuelca su veredicto en el camino. */
function leerDeVuelta(c, fn, etiqueta, conducidoPor = 'navegador') {
  if (!REAL) return true                       // en simulado no hay base que leer
  if (!EXPEDIENTE.listo) {
    c.fallos.push(`${etiqueta} — no hay expediente que consultar: el alta no llegó a ocurrir, así que la lectura de vuelta no se pudo hacer`)
    CONDUCTORES.set(etiqueta, { quien: conducidoPor, estado: 'sin expediente' })
    return false
  }
  const verde = aplicarSonda(c, etiqueta, sonda(fn, [EXPEDIENTE.gid]), conducidoPor)
  CONDUCTORES.set(etiqueta, {
    quien: conducidoPor,
    estado: conducidoPor !== 'navegador' ? 'NO CUBIERTO' : (verde ? 'verde' : 'rojo'),
  })
  return verde
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
  await page.waitForFunction(() => !!document.querySelector('.bi-envelope-check'), null, { timeout: 10000 })
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

/**
 * Deja a la familia PLANTADA en el paso de la fecha (índice 0), editable.
 *
 * Para tocar la FECHA hay que estar en su paso. Si la familia aterrizó más adelante (el
 * caso real: el paso 0 ya cuenta como completo porque AppSheet pre-rellena la fecha al
 * crear el expediente), vuelve atrás como volvería ella — con «Atrás» — y desbloquea el
 * paso con «Editar». Son actos de la familia, no atajos del robot.
 *
 * OJO con los selectores: «Atrás» (StepNav) y «Editar» (LockedBanner) comparten la MISMA
 * clase `btn-secondary-kis` (`components/LockedBanner.jsx:16`). Lo que los distingue es el
 * icono: el de editar lleva `i.bi-pencil`. Coger «el primer .btn-secondary-kis» pulsaría el
 * que estuviera antes en el DOM —y el banner va arriba—, así que se nombran por separado.
 *
 * Vive aquí, en UN solo sitio, porque lo usan DOS caminos (`guardar-paso` y
 * `fecha-a-mitad-de-curso`) y dos copias de la misma maniobra divergen.
 *
 * @returns {Promise<boolean>} false si no se pudo llegar (el camino ya lleva el fallo escrito).
 */
async function volverAlPasoDeLaFecha(c, page, pasoActivo) {
  if (pasoActivo <= 0) return true

  const ATRAS  = 'button.btn-secondary-kis:not(:has(i.bi-pencil))'
  const EDITAR = 'button.btn-secondary-kis:has(i.bi-pencil)'

  const volver = await page.$(ATRAS)
  if (!volver) {
    c.fallos.push(`aterrizó en el índice ${pasoActivo} y el paso no ofrece botón «Atrás»: no hay forma de volver al paso de la fecha`)
    return false
  }
  await volver.click()
  try {
    await page.waitForFunction(() => {
      const pasos = [...document.querySelectorAll('.wizard-step')]
      return pasos.findIndex(p => p.classList.contains('active')) === 0
    }, null, { timeout: 15000 })
  } catch {
    c.fallos.push('al pulsar «Atrás» el wizard no volvió al paso de la fecha (índice 0)')
    return false
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
  return c.afirmar('tras «Editar», el paso de la fecha vuelve a ser editable', editable,
    'el campo sigue deshabilitado: la familia no podría corregir su fecha al volver')
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

  if (!await volverAlPasoDeLaFecha(c, page, pantalla.pasoActivo)) return c

  // Editar: pasar a "fecha concreta" y escribir una fecha que la batería controla.
  const FECHA = '2027-01-11'
  await page.waitForSelector('#mid', { timeout: 10000 })
  await page.check('#mid')
  await page.waitForSelector('input[type="date"]', { timeout: 10000 })
  await page.fill('input[type="date"]', FECHA)

  // ── La fecha se comprueba DONDE SE TECLEA, contra el curso que DECLARA el programa ──
  // El campo no tenía límite ninguno: admitía 1990 o 2050, y el paso decidía además el modo
  // de incorporación con el 1 de septiembre escrito a mano. Ahora los dos salen de lo que
  // declara el programa (`period_starts_on` / `period_ends_on`). Se afirma lo OBSERVABLE:
  // el campo lleva los límites declarados, y una fecha fuera de ellos no deja continuar y
  // DICE por qué (falla cerrado y nombrando, nunca en silencio).
  // NO se declara «no cubierta» si el programa no acota: eso NO es una carencia del arnés,
  // es una configuración que deja el campo abierto a 1990 — y entonces la afirmación CAE,
  // nombrándolo, que es justo lo que hay que ver.
  const limites = await page.$eval('input[type="date"]',
    el => ({ min: el.getAttribute('min') || '', max: el.getAttribute('max') || '' }))
  const hayMin = /^\d{4}-\d{2}-\d{2}$/.test(limites.min)
  if (c.afirmar('el campo de fecha lleva la fecha de inicio que declara el programa', hayMin,
    `min="${limites.min}" max="${limites.max}": el campo no acota nada, así que admitiría 1990 o 2050`)) {
    // El día ANTERIOR al inicio declarado — se calcula del propio límite, no se inventa.
    const fuera = new Date(new Date(limites.min + 'T00:00:00Z').getTime() - 86400000)
      .toISOString().slice(0, 10)
    await page.fill('input[type="date"]', fuera)
    let bloqueado = false
    try {
      await page.waitForFunction(() => {
        const b = document.querySelector('.btn-primary-kis')
        return !!(b && b.disabled)
      }, null, { timeout: 5000 })
      bloqueado = true
    } catch { /* sigue activo → el afirmar de abajo lo dice */ }
    const queja = await page.$eval('.invalid-feedback', el => (el.textContent || '').trim()).catch(() => '')
    c.afirmar(`una fecha fuera del curso declarado (${fuera}) no deja continuar`, bloqueado,
      '«Continuar» seguía activo: la familia podría mandar una fecha fuera del curso del programa')
    c.afirmar('y la pantalla dice por qué no deja continuar', !!queja,
      'no se pintó ningún mensaje junto al campo: el bloqueo sería mudo')
    await page.fill('input[type="date"]', FECHA)   // se devuelve la fecha válida
    await page.waitForFunction(() => {
      const b = document.querySelector('.btn-primary-kis')
      return !!(b && !b.disabled)
    }, null, { timeout: 5000 })
  }

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

  // El guardado sale con el valor nuevo (aunque el usuario ya haya avanzado). Se ESPERA a
  // que salga, no se duerme un rato fijo: contra el sistema real el guardado es
  // fire-and-forget y el momento en que sale lo decide la aplicación, no nuestro reloj.
  // Con `waitForTimeout(LATENCY + 800)` la misma corrida daba 4 llamadas una vez y 1 la
  // siguiente — un rojo intermitente que acusaba al wizard de no guardar cuando lo único
  // que pasaba es que el robot dejaba de mirar demasiado pronto.
  const esperaGuardado = REAL ? 60000 : LATENCY + 800
  const t0Guardado = Date.now()
  while (!llamadas('saveStep').length && Date.now() - t0Guardado < esperaGuardado) {
    await page.waitForTimeout(250)
  }
  if (REAL) await esperarSilencioDeRed(30000)
  const guardados = llamadas('saveStep')
  c.evidencia.llamadas = calls.length - antes
  if (!guardados.length) {
    c.fallos.push(`el paso editado NUNCA se guardó — ningún saveStep salió en ${Date.now() - t0Guardado} ms tras continuar`)
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
    }, null, { timeout: 10000 })
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

/**
 * ①31 — LA FAMILIA QUE PIDE INCORPORACIÓN A MITAD DE CURSO PUEDE CONTINUAR.
 *
 * El defecto que este camino vigila (reportado por Diego con la pantalla delante, 2026-08-09):
 * el paso 1, en modo «a mitad de curso», rechazaba **TODA** fecha —incluidas las que caen
 * dentro del curso declarado— y dejaba «Continuar» bloqueado. Los límites del programa
 * llegaban en el formato americano de AppSheet ('MM/DD/YYYY') y se comparaban COMO TEXTO
 * contra el 'YYYY-MM-DD' del selector de fecha: `'2026-09-30' > '08/31/2027'` es cierto
 * porque '2' > '0'. Ninguna familia de mitad de curso podía pasar del primer paso.
 *
 * Dos partes, y la segunda es la que de verdad muerde:
 *   (a) con los límites bien (ISO, como los manda hoy el servidor), una fecha DENTRO del
 *       curso deja continuar — y una fuera sigue sin dejar, que es lo que ①21 vino a poner.
 *   (b) con los límites ILEGIBLES (el formato crudo de AppSheet, el escenario hostil), la
 *       familia **sigue pudiendo continuar**: la regla dura del paso es que un límite que no
 *       se sabe leer NO se exige. Aquí es donde salta el rojo si alguien devuelve `onlyDate`
 *       a cortar diez caracteres, o lo "endurece" para bloquear ante lo desconocido.
 */
async function caminoFechaAMitadDeCurso(page, base) {
  const c = new Camino('fecha-a-mitad-de-curso')
  scenario.stage = 'sin_fecha'          // sin fecha ⇒ aterriza en el paso de la fecha
  scenario.formatoFechasPrograma = 'iso'

  if (!await entrarPorElEnlace(c, page, base)) return c

  const pantalla = await page.evaluate(sondaPantalla)
  c.evidencia.elementos = pantalla.pasos + pantalla.campos
  c.afirmar('sin pantalla de error', !pantalla.errorFatal, 'el ErrorBoundary pintó "Something went wrong."')
  if (!await volverAlPasoDeLaFecha(c, page, pantalla.pasoActivo)) return c

  // ── (a) Límites legibles: dentro del curso deja continuar, fuera no ──────────────
  await page.waitForSelector('#mid', { timeout: 10000 })
  await page.check('#mid')
  await page.waitForSelector('input[type="date"]', { timeout: 10000 })

  const limites = await page.$eval('input[type="date"]',
    el => ({ min: el.getAttribute('min') || '', max: el.getAttribute('max') || '' }))
  // El propio `min`/`max` en ISO es la señal de que la causa raíz está curada: el navegador
  // IGNORA un límite que no sea ISO, así que antes del arreglo eran letra muerta.
  const limitesIso = /^\d{4}-\d{2}-\d{2}$/.test(limites.min) && /^\d{4}-\d{2}-\d{2}$/.test(limites.max)
  if (!c.afirmar('el selector lleva los límites del curso en la forma que el navegador entiende (ISO)',
    limitesIso,
    `min="${limites.min}" max="${limites.max}": el navegador ignora un límite que no es ISO, así que no acota nada`)) return c

  // Una fecha DENTRO del curso, calculada del propio límite — no inventada. Un mes después
  // del inicio declarado es justo el caso de Diego: «30/09» con el curso empezando el 1/9.
  const dentro = new Date(new Date(limites.min + 'T00:00:00Z').getTime() + 29 * 86400000)
    .toISOString().slice(0, 10)
  await page.fill('input[type="date"]', dentro)
  let dejaSeguir = false
  try {
    await page.waitForFunction(() => {
      const b = document.querySelector('.btn-primary-kis')
      return !!(b && !b.disabled)
    }, null, { timeout: 5000 })
    dejaSeguir = true
  } catch { /* el afirmar de abajo lo nombra */ }
  const queja = await page.$eval('.invalid-feedback', el => (el.textContent || '').trim()).catch(() => '')
  c.afirmar(`una fecha DENTRO del curso declarado (${dentro}) deja continuar`, dejaSeguir,
    `«Continuar» quedó bloqueado con una fecha que SÍ está dentro de ${limites.min}…${limites.max}` +
    (queja ? ` — la pantalla decía: "${queja}"` : '') +
    ' · ESTE ES ①31: la familia de mitad de curso no puede pasar del paso 1')

  // Y el aviso, cuando toca, enseña las fechas COMO LAS LEE UNA PERSONA. `humanDate` solo
  // sabe formatear si el dato le llega en ISO: si sale '09/01/2026' con cero delante, el
  // límite llegó en crudo y la causa raíz está tapada, no curada.
  const fuera = new Date(new Date(limites.max + 'T00:00:00Z').getTime() + 86400000)
    .toISOString().slice(0, 10)
  await page.fill('input[type="date"]', fuera)
  let bloqueado = false
  try {
    await page.waitForFunction(() => {
      const b = document.querySelector('.btn-primary-kis')
      return !!(b && b.disabled)
    }, null, { timeout: 5000 })
    bloqueado = true
  } catch { /* el afirmar de abajo lo nombra */ }
  const aviso = await page.$eval('.invalid-feedback', el => (el.textContent || '').trim()).catch(() => '')
  c.afirmar(`una fecha fuera del curso (${fuera}) sigue sin dejar continuar`, bloqueado,
    '«Continuar» seguía activo: se habrían quitado los límites en vez de arreglarlos')
  c.afirmar('el aviso enseña las fechas como las lee una persona, no en crudo',
    !!aviso && !/\d{2}\/\d{2}\/\d{4}/.test(aviso),
    `el aviso dice "${aviso}": o está vacío, o enseña el formato crudo de AppSheet (mes/día/año)`)

  // ── (b) y (c): los DOS escenarios hostiles, que miden cosas DISTINTAS ─────────────
  // Contra el sistema real no se pueden fabricar (el servidor es el de verdad y ya manda
  // ISO): se declaran NO CUBIERTAS con su motivo, nunca se finge verde.
  if (REAL) {
    c.noCubierta('limite-ilegible',
      'los escenarios hostiles (el servidor devuelve los límites del programa en el formato crudo de AppSheet, o directamente ilegibles) no se pueden FORZAR sobre el backend de verdad sin desplegarle un cambio; en modo simulado sí se cubren')
    return c
  }

  // (b) Límites en el FORMATO CRUDO DE AppSheet — el dato exacto que tumbaba a la familia
  //     antes del arreglo. Hoy el paso SÍ sabe leerlo, así que lo correcto es que los
  //     aplique bien (y por tanto deje pasar una fecha que está dentro).
  scenario.formatoFechasPrograma = 'appsheet'
  // ⚠️ HAY QUE FORZAR UNA CARGA DE DOCUMENTO NUEVA, y esto se descubrió midiendo.
  // `entrarPorElEnlace` navega a `#/resume/…`; venimos de `#/apply` (el token se retira de
  // la barra, KAL-7) ⇒ para el navegador es SOLO un cambio de `#` en el MISMO documento: no
  // recarga nada. Y el frontal cachea los catálogos en memoria del módulo
  // (`frontend/src/api.js`, `_lookupsCache`, sembrada desde la hidratación), así que la
  // pantalla seguía usando los límites ISO de la primera vuelta y las dos afirmaciones de
  // abajo pasaban EN VACÍO — verdes sin haber visto jamás un límite ilegible.
  await page.goto('about:blank', { waitUntil: 'domcontentloaded' })
  if (!await entrarPorElEnlace(c, page, base)) return c
  const pantalla2 = await page.evaluate(sondaPantalla)
  if (!await volverAlPasoDeLaFecha(c, page, pantalla2.pasoActivo)) return c
  await page.waitForSelector('#mid', { timeout: 10000 })
  await page.check('#mid')
  await page.waitForSelector('input[type="date"]', { timeout: 10000 })
  await page.fill('input[type="date"]', dentro)

  let dejaSeguirHostil = false
  try {
    await page.waitForFunction(() => {
      const b = document.querySelector('.btn-primary-kis')
      return !!(b && !b.disabled)
    }, null, { timeout: 5000 })
    dejaSeguirHostil = true
  } catch { /* el afirmar de abajo lo nombra */ }
  const quejaHostil = await page.$eval('.invalid-feedback', el => (el.textContent || '').trim()).catch(() => '')
  c.afirmar('con los límites en el formato crudo de AppSheet, la familia sigue pudiendo continuar',
    dejaSeguirHostil,
    'una fecha que SÍ está dentro del curso dejó a la familia sin poder avanzar' +
    (quejaHostil ? ` — la pantalla decía: "${quejaHostil}"` : '') +
    ' · ESTE ES ①31 tal y como Diego lo vio')

  const limitesHostiles = await page.$eval('input[type="date"]',
    el => ({ min: el.getAttribute('min') || '', max: el.getAttribute('max') || '' }))
  c.notas.push(`· con límites en crudo el selector queda min="${limitesHostiles.min}" max="${limitesHostiles.max}"`)
  c.afirmar('y el selector NO acaba con un límite que el navegador no entiende',
    !/\//.test(limitesHostiles.min + limitesHostiles.max),
    `min="${limitesHostiles.min}" max="${limitesHostiles.max}": son límites en crudo, letra muerta para el navegador`)

  // (c) Límites REALMENTE ILEGIBLES — la REGLA DURA. Un valor que ningún lector puede
  //     interpretar NO puede convertirse en una familia encerrada: ese lado del rango
  //     simplemente no se exige, igual que cuando el programa no lo declara.
  scenario.formatoFechasPrograma = 'ilegible'
  await page.goto('about:blank', { waitUntil: 'domcontentloaded' })   // ver el aviso de arriba
  if (!await entrarPorElEnlace(c, page, base)) return c
  const pantalla3 = await page.evaluate(sondaPantalla)
  if (!await volverAlPasoDeLaFecha(c, page, pantalla3.pasoActivo)) return c
  await page.waitForSelector('#mid', { timeout: 10000 })
  await page.check('#mid')
  await page.waitForSelector('input[type="date"]', { timeout: 10000 })
  await page.fill('input[type="date"]', dentro)

  let dejaSeguirIlegible = false
  try {
    await page.waitForFunction(() => {
      const b = document.querySelector('.btn-primary-kis')
      return !!(b && !b.disabled)
    }, null, { timeout: 5000 })
    dejaSeguirIlegible = true
  } catch { /* el afirmar de abajo lo nombra */ }
  const quejaIlegible = await page.$eval('.invalid-feedback', el => (el.textContent || '').trim()).catch(() => '')
  const limitesIlegibles = await page.$eval('input[type="date"]',
    el => ({ min: el.getAttribute('min') || '', max: el.getAttribute('max') || '' }))
  c.notas.push(`· con límites ilegibles el selector queda min="${limitesIlegibles.min}" max="${limitesIlegibles.max}" (vacíos = no se exige ese lado)`)
  c.afirmar('con un límite que NADIE sabe leer, la familia NO se queda encerrada',
    dejaSeguirIlegible,
    'un límite ilegible dejó a la familia sin poder avanzar' +
    (quejaIlegible ? ` — la pantalla decía: "${quejaIlegible}"` : '') +
    ' · ante la duda se DEJA PASAR: jamás se convierte un dato que no se entiende en una familia encerrada')
  c.afirmar('y tampoco se le cuelga al selector el valor ilegible',
    !limitesIlegibles.min && !limitesIlegibles.max,
    `min="${limitesIlegibles.min}" max="${limitesIlegibles.max}": se colgó un límite que el navegador no puede honrar`)

  scenario.formatoFechasPrograma = 'iso'
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

// ── 6.bis · CONDUCIR POR NAVEGADOR ───────────────────────────────────────────
//
// Todo lo de aquí abajo pulsa lo que pulsaría una familia. No hay ni un atajo por la
// pasarela: si un paso no se puede completar desde la pantalla, el camino CAE y dice en
// qué paso y con qué mensaje del propio wizard — que es exactamente el hallazgo que se
// busca (encargo 08: «si el wizard te obliga a hacer algo raro para avanzar, eso es un
// hallazgo, no un obstáculo del arnés»).

const BTN_SIGUIENTE = 'button.btn-primary-kis:not([disabled])'
const BTN_EDITAR    = 'button.btn-secondary-kis:has(i.bi-pencil)'

/** Índice del paso activo del stepper (-1 si no hay stepper). */
const dondeEstoy = (page) => page.evaluate(sondaPasoActivo)

/**
 * Traza EN VIVO del recorrido por navegador.
 *
 * El runner solo imprime cuando el camino TERMINA, y este camino dura veinte minutos:
 * durante todo ese rato la salida está muda y no hay forma de saber si avanza o si se
 * quedó colgado en un paso. Una traza con hora al empezar cada paso convierte una espera
 * ciega en un registro que se puede leer mientras corre.
 */
const traza = (txt) => console.log(`  … ${new Date().toISOString().slice(11, 19)}  ${txt}`)

// ── PALANCA CERRADA POR MEDICIÓN: la pestaña en segundo plano NO se puede ─────────────
//
// La idea era buena y el número la justificaba: el wizard consulta un contador de cambio
// cada 30 s mientras la pestaña está VISIBLE (`WizardPage.jsx:170` + `setInterval(tick,
// 30 * 1000)`), así que un drenaje de cuatro minutos son OCHO pulsos que no cubren nada y
// que, con un transporte que falla del orden de la mitad de las veces, son riesgo puro.
// El propio wizard YA trae la regla que lo evitaría — `document.visibilityState ===
// 'hidden'` → salta el tick — y nadie la había ejercitado nunca.
//
// Se intentó de la única forma honesta (abrir otra pestaña de verdad y traerla al frente,
// que es lo que hace una persona) y SE MIDIÓ antes de darlo por bueno:
//     antes              : visible
//     con otra al frente : visible   ← no cambia
//     al volver          : visible
// En Chromium headless `bringToFront()` NO pone la primera pestaña en oculto. O sea: desde
// el navegador no hay forma honesta de recorrer ese camino, y la alternativa —falsear
// `visibilityState` desde dentro de la página— sería mentirle al producto para que se
// comporte distinto, que es justo lo que no se hace aquí.
//
// Queda cerrado con su medición, no con una excusa. Si algún día la batería corre con
// navegador visible, o Playwright expone la visibilidad, se reabre — y entonces se mide
// otra vez antes de creerlo.

/** Lo que el propio wizard dice cuando no deja avanzar (aviso sticky o inline). */
const quejaDelWizard = (page) => page.evaluate(() => {
  const n = document.querySelector('[role="alert"], .field-error')
  return n ? (n.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 220) : ''
})

/**
 * Un paso ya guardado se recupera PROTEGIDO tras su banner. Para tocarlo hay que pulsar
 * «Editar», igual que la familia. Devuelve true si hizo falta desbloquear.
 */
async function desbloquear(page) {
  const b = await page.$(BTN_EDITAR)
  if (!b) return false
  await b.click()
  await page.waitForTimeout(150)
  return true
}

/**
 * Pulsa «Continuar» y espera a que el stepper marque `destino`. Si no avanza, el fallo
 * NOMBRA el paso donde se quedó y la queja literal del wizard: un «no avanzó» mudo
 * obliga a repetir la corrida para diagnosticar, y repetir es lo que la casa prohíbe.
 */
async function continuar(c, page, destino, etiqueta, msMax = 45000) {
  // Un paso que todavía está cargando su contenido (el cuestionario, el paquete
  // contractual) deshabilita su «Continuar». Se ESPERA a que sea pulsable en vez de
  // declarar que «no hay botón»: ese diagnóstico acusaría al wizard de algo que solo
  // era prisa del robot.
  try {
    await page.waitForFunction(() => [...document.querySelectorAll('button.btn-primary-kis')].some(b => !b.disabled),
      null, { timeout: msMax })
  } catch {
    const queja = await quejaDelWizard(page)
    c.fallos.push(`${etiqueta} — la pantalla nunca ofreció un botón «Continuar» pulsable en ${msMax} ms${queja ? `; dice: «${queja}»` : ''}`)
    return false
  }
  const botones = await page.$$(BTN_SIGUIENTE)
  await botones[0].click()
  try {
    await page.waitForFunction((d) => {
      const p = [...document.querySelectorAll('.wizard-step')]
      return p.findIndex(x => x.classList.contains('active')) === d
    }, destino, { timeout: msMax })
    c.notas.push(`✓ ${etiqueta} [conducido por: navegador]`)
    return true
  } catch {
    const donde = await dondeEstoy(page)
    const queja = await quejaDelWizard(page)
    c.fallos.push(`${etiqueta} — al pulsar «Continuar» el wizard NO avanzó al paso ${destino + 1} ` +
      `(se quedó en el ${donde + 1})${queja ? `; el propio wizard dice: «${queja}»` : '; y sin decir por qué'}`)
    return false
  }
}

/** Pulsa un `.add-btn` por su texto visible. */
async function pulsarAñadir(page, texto) {
  const b = await page.$(`button.add-btn:has-text(${JSON.stringify(texto)})`)
  if (!b) return false
  await b.click()
  await page.waitForTimeout(150)
  return true
}

/**
 * PASO 2 · Personas — dos tutores y dos hijos, tecleados en la pantalla.
 *
 * La forma (2+2, apellido con el marcador de la corrida) NO es capricho: es la que las
 * sondas 2 y 3 afirman. Antes la producía la pasarela; ahora la produce el teclado.
 */
async function conducirPersonas(c, page) {
  traza('paso 2 · personas — tecleando dos tutores y dos alumnos')
  await desbloquear(page)
  // Por defecto el paso trae 1 tutor + 1 alumno. La familia del robot tiene 2 y 2.
  if (!await pulsarAñadir(page, 'Añadir otro tutor')) {
    c.fallos.push('paso 2 · personas — la pantalla no ofrece «Añadir otro tutor»'); return false
  }
  if (!await pulsarAñadir(page, 'Añadir otro alumno')) {
    c.fallos.push('paso 2 · personas — la pantalla no ofrece «Añadir otro alumno»'); return false
  }
  const secciones = await page.$$('.dynamic-section')
  if (secciones.length !== 4) {
    c.fallos.push(`paso 2 · personas — se esperaban 4 fichas de persona (2 tutores + 2 alumnos) y hay ${secciones.length}`)
    return false
  }
  const gente = [
    { nombre: 'Tutor1', tutor: true,  correo: DATOS.emailKnown,   nac: '1985-03-04' },
    { nombre: 'Tutor2', tutor: true,  correo: DATOS.emailKnown.replace('+robot-t1', '+robot-t2'), nac: '1986-07-19' },
    { nombre: 'Hijo1',  tutor: false, correo: null,               nac: '2017-05-12' },
    { nombre: 'Hijo2',  tutor: false, correo: null,               nac: '2019-09-30' },
  ]
  for (let i = 0; i < 4; i++) {
    const sec = secciones[i]
    const p = gente[i]
    // Los campos del núcleo son los `form-control` SIN el sufijo `-sm` (los `-sm` son de
    // correos, teléfonos y colegios previos). Orden de la fila: nombre, 2.º nombre,
    // apellidos, [fecha], lugar de nacimiento, [tipo doc], nº de documento.
    const nucleo = await sec.$$('input.form-control:not(.form-control-sm):not([type="date"])')
    if (nucleo.length < 3) {
      c.fallos.push(`paso 2 · personas — la ficha ${i + 1} no pinta los campos de nombre (${nucleo.length} campos de texto)`)
      return false
    }
    await nucleo[0].fill(p.nombre)
    await nucleo[2].fill(DATOS.apellido)                 // marcador ROBOT-<sello>
    const fecha = await sec.$('input[type="date"]')
    if (fecha) await fecha.fill(p.nac)
    // Teléfono: obligatorio para CADA tutor (el firmante lo necesita). Se teclea como lo
    // teclea una familia — país en el desplegable y número nacional en el campo.
    if (p.tutor) {
      const antes = (await sec.$$('input[type="tel"]')).length
      const añadir = await sec.$('button.add-btn:has-text("Añadir teléfono")')
      if (!añadir) { c.fallos.push(`paso 2 · personas — la ficha ${i + 1} no ofrece «Añadir teléfono»`); return false }
      await añadir.click()
      await page.waitForTimeout(150)
      const tels = await sec.$$('input[type="tel"]')
      if (tels.length <= antes) { c.fallos.push(`paso 2 · personas — «Añadir teléfono» no añadió ninguna fila en la ficha ${i + 1}`); return false }
      const fila = tels[tels.length - 1]
      const selects = await sec.$$('select.form-select-sm')
      // El desplegable de país de la fila de teléfono es el que lleva la opción 'ES'.
      for (const s of selects) {
        const tieneES = await s.$('option[value="ES"]')
        if (tieneES) { await s.selectOption('ES'); break }
      }
      await fila.fill(`61234${String(1000 + i).slice(-4)}`)
      await fila.evaluate(el => el.blur())
      // Correo propio de cada tutor: es su credencial de identidad per-guardian, y el
      // wizard exige que no se repita entre tutores.
      if (i > 0) {
        const añadirCorreo = await sec.$('button.add-btn:has-text("Añadir correo")')
        if (añadirCorreo) {
          await añadirCorreo.click()
          await page.waitForTimeout(150)
          const correos = await sec.$$('input[type="email"]')
          if (correos.length) await correos[correos.length - 1].fill(p.correo)
        }
      }
    }
  }
  return continuar(c, page, 2, 'paso 2 · personas')
}

/**
 * PASO 3 · Vínculos — la fila que estaba EN DISPUTA desde que se midieron 509 vínculos
 * vivos. Aquí se declara desde la pantalla: tipo de vínculo en los cuatro pares
 * tutor→hijo, y custodia SOLO para el tutor 1 (que es lo que la sonda 3 afirma).
 */
async function conducirVinculos(c, page) {
  traza('paso 3 · vínculos — declarando los cuatro pares tutor→alumno')
  await desbloquear(page)
  // El paso carga su catálogo de tipos al entrar: se espera a que el desplegable tenga
  // algo que elegir en vez de dormir un rato fijo.
  try {
    await page.waitForFunction(() => {
      const s = document.querySelector('select.form-select-sm')
      return !!s && s.options.length > 1
    }, null, { timeout: 60000 })
  } catch {
    c.fallos.push('paso 3 · vínculos — el desplegable de tipo de vínculo nunca se pobló: el catálogo del tenant no llegó a la pantalla')
    return false
  }
  // Solo las tarjetas tutor→alumno: son las ÚNICAS que llevan las casillas de custodia y
  // recogida. Las de hermano↔hermano se dejan como se las encuentra la familia que no
  // sabe qué poner — si el wizard las persiste igual, eso lo dirá la sonda, no el robot.
  const tarjetas = await page.$$('.kis-card:has(input[id^="custodial_"])')
  if (!tarjetas.length) { c.fallos.push('paso 3 · vínculos — la pantalla no pinta ninguna tarjeta de vínculo tutor→alumno'); return false }
  let pares = 0
  for (const t of tarjetas) {
    const sel = await t.$('select.form-select-sm')
    if (!sel) continue
    const opciones = await sel.$$eval('option', os => os.map(o => o.value).filter(Boolean))
    if (!opciones.length) continue
    await sel.selectOption(opciones[0])
    // Custodia: los dos primeros pares son del tutor 1 (el orden de pintado es
    // tutores × alumnos). Marcarla arrastra "autorizado a recoger" (regla del wizard).
    // El tutor 2 NO declara custodia —así la sonda 3 puede afirmar el ATRIBUTO del
    // vínculo y no solo su existencia—, pero sí recogida, porque cada alumno tiene que
    // quedar cubierto por alguien o el paso no deja avanzar.
    const cust = await t.$('input.form-check-input[id^="custodial_"]')
    const pick = await t.$('input.form-check-input[id^="pickup_"]')
    if (pares < 2) { if (cust) await cust.check() }
    else if (pick) { await pick.check() }
    pares++
  }
  if (pares < 4) {
    c.fallos.push(`paso 3 · vínculos — la pantalla solo ofrece ${pares} pares tutor→alumno (se esperaban 4: dos tutores × dos alumnos)`)
    return false
  }
  return continuar(c, page, 3, 'paso 3 · vínculos')
}

/**
 * PASO 4 · Salud — una alergia, una dieta y una condición médica para el primer alumno,
 * elegidas del catálogo del tenant como las elige la familia: escribiendo y pulsando la
 * sugerencia. Si el catálogo está vacío, se dice; no se inventa un id.
 */
async function conducirSalud(c, page) {
  traza('paso 4 · salud — eligiendo alergia, dieta y condición médica')
  await desbloquear(page)
  const grupos = await page.$$('.input-group input.form-control')
  if (grupos.length < 3) {
    c.noCubierta('paso 4 · salud·eleccion-desde-la-pantalla',
      `la pantalla de salud solo ofrece ${grupos.length} buscadores (se esperaban al menos 3: alergias, dieta y condiciones médicas)`)
    return continuar(c, page, 4, 'paso 4 · salud')
  }
  let elegidos = 0
  for (let i = 0; i < 3; i++) {
    await grupos[i].click()
    await grupos[i].fill('a')
    let opcion = null
    try {
      opcion = await page.waitForSelector('.border.rounded.mt-1 > div', { timeout: 4000 })
    } catch { /* catálogo sin coincidencias: se cuenta abajo */ }
    if (!opcion) { await grupos[i].fill(''); continue }
    await opcion.click()
    elegidos++
    await page.waitForTimeout(120)
  }
  if (elegidos < 3) {
    c.noCubierta('paso 4 · salud·eleccion-desde-la-pantalla',
      `solo se pudieron elegir ${elegidos} de 3 elementos de salud desde la pantalla: el catálogo del tenant no ofrece sugerencias para los tres buscadores`)
  }

  // ── ¿QUEDÓ REGISTRADA LA ELECCIÓN? El paso se afirma a sí mismo ────────────────────
  //
  // MEDIDO el 2026-08-04 (corrida d6): la sonda dijo `salud.alergias.vigentes_esperadas =
  // 0 (se esperaba 1)` en las tres tablas, y NO se podía atribuir — ¿no guarda el
  // producto, o no registra la elección el robot? Elegir culpable sin poder separarlos
  // habría sido inventar. Esta comprobación los separa EN LA PANTALLA, antes de mirar la
  // base: si la elección no deja rastro visible aquí, el defecto es del CONDUCTOR y lo
  // dice; si lo deja y la base sale vacía, el defecto es del PRODUCTO y la sonda lo dirá.
  const marcados = await page.$$eval('.badge',
    ns => ns.map(n => (n.textContent || '').replace(/\s+/g, ' ').trim()).filter(Boolean))
  c.notas.push(`    · elecciones de salud visibles en la pantalla: ${marcados.length}${marcados.length ? ` (${marcados.slice(0, 4).join(' · ')})` : ''}`)
  if (elegidos > 0 && !c.afirmar('paso 4 · salud — la elección queda registrada en la pantalla',
    marcados.length >= elegidos,
    `se eligieron ${elegidos} elementos del buscador y la pantalla muestra ${marcados.length} marcados: el robot pulsa la sugerencia pero NO deja la elección puesta, así que lo que se mida después en la base no dice nada del producto`)) return false

  return continuar(c, page, 4, 'paso 4 · salud')
}

/** PASO 5 · Cuestionario — se responde lo que el tenant tenga configurado. */
async function conducirPreguntas(c, page) {
  traza('paso 5 · preguntas — respondiendo el cuestionario del tenant')
  await desbloquear(page)
  // El paso carga sus conjuntos de preguntas al entrar y mientras tanto deshabilita el
  // avance. Se espera a que termine de cargar antes de contar qué hay que responder.
  // 240 s y no 90: la latencia REAL medida del sistema es de 34-48 s por llamada (ver el
  // bloque de EFECTO_VERIFICADO_EN_LA_BASE), y el cuestionario encadena varias. Con 90 s el
  // arnés declaraba «nunca terminó de cargar» a los 90 s exactos — un rojo del reloj, no del
  // producto. El número se sube CON la medida delante, no a ciegas: si un día vuelve a
  // agotarse, lo que hay que mirar es cuántas llamadas encadena el paso, no subirlo otra vez.
  try {
    await page.waitForFunction(() => [...document.querySelectorAll('button.btn-primary-kis')].some(b => !b.disabled),
      null, { timeout: 240000 })
  } catch {
    c.fallos.push('paso 5 · preguntas — el cuestionario no terminó de cargar en 240 s: el botón de avanzar siguió deshabilitado')
    return false
  }
  const campos = await page.$$('input[type="radio"], input[type="checkbox"], textarea, select.form-select, input[type="text"], input[type="number"], input[type="date"]')
  c.notas.push(`    · el cuestionario del tenant pinta ${campos.length} control(es) de respuesta`)
  if (!campos.length) {
    c.noCubierta('paso 5 · preguntas·respuesta-desde-la-pantalla',
      'el tenant no tiene ninguna pregunta configurada para este programa: no hay nada que responder en la pantalla. Es configuración de tenant, no defecto del wizard.')
    return continuar(c, page, 5, 'paso 5 · preguntas')
  }

  // ── RESPONDER DE VERDAD, y no solo pasar por el paso ────────────────────────────────
  // MEDIDO en d6: la pantalla pintó **47 controles** y `saveResponses` NO se llamó ni una
  // vez. No era avería del servidor (`fetchQuestions` vino sano) ni transporte: es que el
  // conductor solo marcaba radios y rellenaba áreas de texto, y con eso `responses` se
  // quedaba vacío — y `Step5Questions.handleNext` solo manda filas por las preguntas
  // RESPONDIDAS, así que no llamaba a nadie. Cero sesiones era el comportamiento CORRECTO
  // del producto ante un formulario en blanco. El defecto era del robot.
  let respondidos = 0
  for (const r of await page.$$('input[type="radio"]')) { try { await r.check(); respondidos++ } catch { /* agrupados */ } }
  for (const ch of await page.$$('input[type="checkbox"]')) { try { await ch.check(); respondidos++ } catch { /* bloqueado */ } }
  for (const t of await page.$$('textarea')) { try { await t.fill('Respuesta del robot de inscripción.'); respondidos++ } catch { /* bloqueado */ } }
  for (const s of await page.$$('select.form-select')) {
    try {
      const ops = await s.$$eval('option', os => os.map(o => o.value).filter(Boolean))
      if (ops.length) { await s.selectOption(ops[0]); respondidos++ }
    } catch { /* bloqueado */ }
  }
  for (const i of await page.$$('input[type="text"], input[type="number"]')) {
    try { await i.fill('Robot'); respondidos++ } catch { /* bloqueado */ }
  }
  c.notas.push(`    · controles respondidos desde la pantalla: ${respondidos} de ${campos.length}`)
  if (!c.afirmar('paso 5 · preguntas — el robot responde de verdad antes de continuar',
    respondidos > 0,
    `la pantalla pinta ${campos.length} controles y el robot no consiguió responder ninguno: continuar así mandaría un formulario en blanco, y entonces CERO respuestas guardadas sería lo correcto — no diría nada del producto`)) return false

  const antes = llamadas('saveResponses').length
  if (!await continuar(c, page, 5, 'paso 5 · preguntas')) return false
  // El guardado del cuestionario vuela en segundo plano: se ESPERA a que salga.
  const t0 = Date.now()
  while (llamadas('saveResponses').length === antes && Date.now() - t0 < 60000) await page.waitForTimeout(300)
  // El propio producto registra `[DBG Step5] catalog {n_sets, n_responses, …}` cada vez
  // que cambian sus respuestas. Se CITA el último para que el rojo decida SOLO cuál de
  // las dos ramas es, sin volver a correr: `n_responses = 0` tras responder ⇒ lo tecleado
  // NO llega al estado del componente; `n_responses > 0` sin llamada ⇒ falla el ENVÍO.
  const ultimoDbg = [...registrosDbg].reverse().find(r => r.includes('[DBG Step5] catalog'))
    || '(el producto no emitió ningún «[DBG Step5] catalog»: no se puede separar estado de envío — mirar que el registro siga vivo en Step5Questions.jsx)'
  return c.afirmar('paso 5 · preguntas — las respuestas salen desde la pantalla',
    llamadas('saveResponses').length > antes,
    `se respondieron ${respondidos} controles y NINGÚN saveResponses salió en ${Date.now() - t0} ms: o el paso no reconoce lo tecleado como respuesta, o no lo envía.\n        Último registro del producto → ${ultimoDbg}`)
}

/** PASO 6 · Documentos — adjuntar un archivo de verdad y esperar su confirmación. */
async function conducirDocumentos(c, page) {
  traza('paso 6 · documentos — adjuntando un archivo')
  await desbloquear(page)
  const añadir = await page.$('button.add-btn')
  if (!añadir) { c.fallos.push('paso 6 · documentos — la pantalla no ofrece el botón de añadir archivo'); return false }
  await añadir.click()
  await page.waitForSelector('.doc-attachment', { timeout: 15000 })
  await page.fill('.doc-attachment input[type="text"]', `Documento del robot ${MARCA}`)
  await page.setInputFiles('.doc-attachment input[type="file"]', {
    name: `${MARCA}-doc.pdf`,
    mimeType: 'application/pdf',
    buffer: Buffer.from(`%PDF-1.4\n% documento sintetico del robot ${MARCA}\n`),
  })
  let subido = false
  try { await page.waitForSelector('.upload-status.success', { timeout: 120000 }); subido = true } catch { /* abajo */ }
  const subidas = llamadas('uploadDocument')
  c.afirmar('paso 6 · documentos — la subida sale desde la pantalla con los bytes del archivo',
    subidas.length >= 1 && !!(subidas[0].payload && subidas[0].payload.base64 && subidas[0].payload.base64.length > 10),
    `llamadas uploadDocument=${subidas.length}` +
      (subidas.length ? `, base64 de ${((subidas[0].payload || {}).base64 || '').length} caracteres` : ''))
  if (!c.afirmar('paso 6 · documentos — la pantalla confirma la subida', subido,
    'nunca apareció la confirmación visible de archivo subido (.upload-status.success)' +
      (await quejaDelWizard(page) ? `; el wizard dice: «${await quejaDelWizard(page)}»` : ''))) return false
  return continuar(c, page, 6, 'paso 6 · documentos')
}

/**
 * PASO 7 · Revisión y ENVÍO — el acto que transiciona el expediente a RQ y dispara los
 * correos. Se firma con el nombre, se marcan los dos consentimientos y se envía.
 */
async function conducirEnvio(c, page) {
  traza('paso 7 · revisión y envío')
  const esig = await page.$('.esig-field')
  if (!esig) { c.fallos.push('paso 7 · envío — la pantalla de revisión no ofrece el campo de firma manuscrita'); return false }
  await esig.fill(`Tutor1 ${DATOS.apellido}`)
  for (const id of ['#consent_gdpr', '#consent_legal']) {
    const ch = await page.$(id)
    if (!ch) { c.fallos.push(`paso 7 · envío — falta el consentimiento ${id} en la pantalla de revisión`); return false }
    await ch.check()
  }
  const botones = await page.$$(BTN_SIGUIENTE)
  if (!botones.length) { c.fallos.push('paso 7 · envío — no hay botón de enviar pulsable'); return false }
  await botones[botones.length - 1].click()
  try {
    await page.waitForFunction(() => /#\/confirmation/.test(window.location.hash), null, { timeout: 60000 })
  } catch {
    const queja = await quejaDelWizard(page)
    c.fallos.push(`paso 7 · envío — tras pulsar «Enviar solicitud» el wizard no llegó a la confirmación${queja ? `; dice: «${queja}»` : ''}`)
    return false
  }
  // El envío vuela en segundo plano (UX-3): se espera a que salga de verdad.
  const t0 = Date.now()
  while (!llamadas('submitEnrollmentSession').length && Date.now() - t0 < 90000) await page.waitForTimeout(300)
  if (REAL) await esperarSilencioDeRed(60000)
  if (!c.afirmar('paso 7 · envío — el envío sale desde la pantalla',
    llamadas('submitEnrollmentSession').length >= 1,
    `ningún submitEnrollmentSession salió en ${Date.now() - t0} ms tras pulsar enviar`)) return false
  c.notas.push('✓ paso 7 · envío [conducido por: navegador]')
  return true
}

/** PASO 8 · Facturación — reparto entre pagadores y modalidad, desde la pantalla. */
async function conducirFacturacion(c, page) {
  traza('paso 8 · facturación')
  await desbloquear(page)
  const antes = llamadas('saveBillingInfo').length
  const botones = await page.$$(BTN_SIGUIENTE)
  if (!botones.length) {
    const queja = await quejaDelWizard(page)
    c.fallos.push(`paso 8 · facturación — el paso no ofrece botón para continuar${queja ? `; dice: «${queja}»` : ''}`)
    return false
  }
  await botones[0].click()
  try {
    await page.waitForFunction(() => {
      const p = [...document.querySelectorAll('.wizard-step')]
      return p.findIndex(x => x.classList.contains('active')) === 8
    }, null, { timeout: 60000 })
  } catch {
    const queja = await quejaDelWizard(page)
    c.fallos.push(`paso 8 · facturación — no avanzó al paso 9 (se quedó en el ${(await dondeEstoy(page)) + 1})${queja ? `; dice: «${queja}»` : ''}`)
    return false
  }
  const t0 = Date.now()
  while (llamadas('saveBillingInfo').length === antes && Date.now() - t0 < 60000) await page.waitForTimeout(300)
  c.afirmar('paso 8 · facturación — el reparto de pago sale desde la pantalla',
    llamadas('saveBillingInfo').length > antes,
    `ningún saveBillingInfo salió en ${Date.now() - t0} ms tras continuar`)
  c.notas.push('✓ paso 8 · facturación [conducido por: navegador]')
  return true
}

/** PASO 9 · Consentimientos — los 7 del RGPD, marcados uno a uno por el tutor. */
async function conducirConsentimientos(c, page) {
  traza('paso 9 · consentimientos')
  await desbloquear(page)
  try { await page.waitForSelector('input[type="checkbox"][id^="consent_"]', { timeout: 60000 }) }
  catch {
    c.fallos.push('paso 9 · consentimientos — la pantalla nunca pintó ni un consentimiento que marcar')
    return false
  }
  const generales = await page.$$('input[type="checkbox"][id^="consent_"]')
  const imagen    = await page.$$('input[type="checkbox"][id^="img_"]')
  for (const ch of [...generales, ...imagen]) { try { await ch.check() } catch { /* bloqueado */ } }
  c.notas.push(`    · consentimientos marcados: ${generales.length} generales + ${imagen.length} de derechos de imagen`)
  const antes = llamadas('submitGdprConsents').length
  if (!await continuar(c, page, 9, 'paso 9 · consentimientos')) return false
  const t0 = Date.now()
  while (llamadas('submitGdprConsents').length === antes && Date.now() - t0 < 60000) await page.waitForTimeout(300)
  return c.afirmar('paso 9 · consentimientos — el acto sale desde la pantalla',
    llamadas('submitGdprConsents').length > antes,
    `ningún submitGdprConsents salió en ${Date.now() - t0} ms tras confirmar`)
}

/**
 * PASO 10 · Revisión de la documentación contractual. CAMINO DE DINERO: se recorre y se
 * confirma la lectura, que es el acto de la familia; no se toca ni un importe.
 */
async function conducirRevisionContractual(c, page) {
  traza('paso 10 · revisión contractual')
  await desbloquear(page)
  // El paso precarga el paquete contractual al entrar; se espera a que ofrezca algo que
  // aceptar en vez de dormir un rato fijo.
  try {
    await page.waitForFunction(() => {
      const bs = [...document.querySelectorAll('button.btn-primary-kis')]
      return bs.some(b => !b.disabled)
    }, null, { timeout: 120000 })
  } catch {
    const queja = await quejaDelWizard(page)
    c.fallos.push(`paso 10 · revisión — el paquete contractual nunca llegó a la pantalla: no hay nada que revisar${queja ? `; dice: «${queja}»` : ''}`)
    return false
  }
  // «Aceptar y siguiente» documento a documento hasta que el paso se dé por leído.
  for (let i = 0; i < 12; i++) {
    const b = await page.$(BTN_SIGUIENTE)
    if (!b) break
    await b.click()
    await page.waitForTimeout(800)
    if ((await dondeEstoy(page)) === 10) break
  }
  if ((await dondeEstoy(page)) !== 10) {
    const queja = await quejaDelWizard(page)
    c.fallos.push(`paso 10 · revisión — la confirmación de lectura no llevó al paso de firma (se quedó en el ${(await dondeEstoy(page)) + 1})${queja ? `; dice: «${queja}»` : ''}`)
    return false
  }
  c.afirmar('paso 10 · revisión — la confirmación de lectura sale desde la pantalla',
    llamadas('confirmReview').length >= 1,
    `ningún confirmReview salió tras recorrer la documentación`)
  c.notas.push('✓ paso 10 · revisión [conducido por: navegador]')
  return true
}

/**
 * EXPEDIENTE COMPLETO — los once pasos, PULSANDO BOTONES (solo modo real).
 *
 * ── Qué cambió el 2026-08-04 (encargo 08) ───────────────────────────────────────────
 * Hasta hoy este camino conducía DIEZ de los once pasos llamando al KMS por la pasarela.
 * Con ese reparto, un verde significaba «el KMS acepta los once mensajes», NO «una
 * familia puede completar la inscripción usando el wizard» — que es lo que la condición
 * de parada dice. Ahora los pasos 2→10 los conduce el NAVEGADOR: se teclea en los
 * campos, se marcan las casillas y se pulsa «Continuar», como lo haría la familia.
 *
 * ── Qué hace, en orden ───────────────────────────────────────────────────────────────
 *   1. Entra PIDIENDO el enlace (rota el token y abre la ventana de step-up de 10 min).
 *   2. Conduce por navegador personas, vínculos, salud, cuestionario y documentos.
 *   3. Envía desde la pantalla de revisión (paso 7) y DRENA la cola — las escrituras del
 *      wizard son asíncronas, y medir antes de que terminen es medir a medio escribir.
 *   4. Lee de vuelta los pasos 1-7 con sus sondas.
 *   5. Lleva el expediente a `AD` con el MOTOR REAL de transiciones. Esto NO es uno de
 *      los once pasos: es un acto del PERSONAL en el KMS, no de la familia en el wizard.
 *      Es lo que DESTAPA los pasos 8-11; sin ello no se medirían nunca.
 *   6. Vuelve a entrar por el enlace y conduce por navegador facturación, consentimientos
 *      y revisión contractual. Lee de vuelta los pasos 8-11.
 *
 * ── La etiqueta es VINCULANTE ────────────────────────────────────────────────────────
 * Cada lectura de vuelta va etiquetada con QUIÉN condujo el paso. Un paso conducido por
 * `pasarela` YA NO cuenta para el verde de los once: `aplicarSonda` lo convierte en NO
 * CUBIERTO con su motivo. La pasarela solo sobrevive donde el navegador no puede llegar,
 * y ahí se declara en vez de disimularse.
 */
async function caminoExpedienteCompleto(page, base) {
  const c = new Camino('expediente-completo')
  // Autosuficiente: si el camino del alta no dejó expediente (o se filtró la corrida),
  // este camino lo da de alta él mismo en vez de morir con «no hay expediente».
  if (!EXPEDIENTE.listo && !recuperarElEnlace(c, DATOS.emailKnown)) return c

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

  // ── 1 · ENTRAR PIDIENDO EL ENLACE ──────────────────────────────────────────────────
  // No es cosmética: pedirlo abre la ventana DURA de step-up (10 min) que los pasos 2-6
  // necesitan para poder guardar PII. Sin ella, `saveStep` de personas/vínculos/salud
  // responde STEPUP_REQUIRED y el recorrido no puede ni empezar.
  traza('pidiendo el enlace y entrando por él (abre la ventana de step-up)')
  if (!await entrarPorElEnlace(c, page, base, { pidiendolo: true })) return c
  const pantalla0 = await page.evaluate(sondaPantalla)
  c.evidencia.elementos = pantalla0.pasos + pantalla0.campos
  c.afirmar('el wizard pinta sus 11 pasos', pantalla0.pasos === 11,
    `se pintaron ${pantalla0.pasos} pasos en el stepper`)
  c.afirmar('sin pantalla de error', !pantalla0.errorFatal, 'el ErrorBoundary pintó "Something went wrong."')

  // El expediente recién creado aterriza en el paso 2 (índice 1): AppSheet pre-rellena
  // `desired_start_date`, así que el paso 1 cuenta como completo (medido — ver el
  // comentario largo de `caminoRecuperarAterrizar`). Si aterrizara antes, se avanza
  // pulsando, que es lo que haría la familia.
  let donde = await dondeEstoy(page)
  while (donde < 1) {
    if (!await continuar(c, page, donde + 1, `paso ${donde + 1} · avanzar hasta personas`)) return c
    donde = await dondeEstoy(page)
  }
  if (donde !== 1) {
    c.fallos.push(`el expediente aterrizó en el paso ${donde + 1} y no en el 2 (personas): el recorrido por navegador empieza ahí`)
    return c
  }

  // ── 2 · LOS PASOS 2-6, PULSANDO BOTONES ────────────────────────────────────────────
  // ── LA VERJA, ANTES DE CRUZARLA ────────────────────────────────────────────────────
  // Los pasos 2, 3 y 4 tocan PII y el servidor exige una ventana de step-up fresca. Si no
  // está abierta, conducirlos es teatro: el wizard deja avanzar y el servidor rechaza cada
  // guardado (MEDIDO el 2026-08-04). Se mira el semáforo, y si está en rojo se dice y no se
  // finge haber recorrido nada.
  const verja = verjaAbierta()
  c.notas.push(`    · verja de re-verificación al entrar: ${verja === null ? 'el servidor no lo dijo' : (verja ? 'ABIERTA' : 'CERRADA')}`)
  if (verja === false) {
    c.noCubierta('pasos-de-PII-desde-la-pantalla',
      'la hidratación llegó con step_up_fresh=false: el servidor va a rechazar con STEPUP_REQUIRED ' +
      'cada guardado de personas, vínculos y salud. NO es un defecto del wizard —es su verja DL-E39 ' +
      'funcionando—, sino de la ENTRADA del robot: la única ventana que tiene es la gracia del ' +
      'magic-link, de un solo uso y 10 min duros. Conducir esos tres pasos sin ella sería teatro, ' +
      'así que no se conducen y la cobertura se declara perdida en vez de perderse en silencio.')
    leerDeVuelta(c, 'manual_robotSonda02Personas', 'paso 2 · personas', 'navegador (verja cerrada)')
    leerDeVuelta(c, 'manual_robotSonda03Vinculos', 'paso 3 · vínculos', 'navegador (verja cerrada)')
    leerDeVuelta(c, 'manual_robotSonda04Salud', 'paso 4 · salud', 'navegador (verja cerrada)')
    return c
  }

  // Un paso que cae CORTA el recorrido: seguir pulsando sobre una pantalla que no avanzó
  // solo produce fallos derivados que tapan el primero, que es el único que dice algo.
  if (!await conducirPersonas(c, page))    return c
  if (!await conducirVinculos(c, page))    return c
  if (!await conducirSalud(c, page))       return c
  if (!await conducirPreguntas(c, page))   return c

  // ── 3 · LEER DE VUELTA 1-5 **ANTES** DE SEGUIR ──────────────────────────────────────
  //
  // Por qué aquí y no al final del recorrido, MEDIDO el 2026-08-04 (corrida d5): el paso 6
  // cayó con `INVALID_REC_TYPE` y el camino se cortó ANTES de leer nada. Resultado: cinco
  // pasos conducidos con la verja abierta —incluido el 3, el de los 509 vínculos que llevan
  // el día entero en disputa— y CERO medidas. La lectura estaba detrás del paso más frágil.
  //
  // Ahora lo ya conducido se mide en cuanto está escrito. Cuesta un drenaje más (turnos de
  // cola, no llamadas al wizard) y a cambio ningún fallo posterior puede volver a llevarse
  // por delante una medida que YA se había ganado. Se re-pide antes el enlace: con las
  // personas ya escritas existe la fila de `enrEmails` de la que sale el `?n=`, y a partir
  // de ahí la recuperación es per-guardian, que es como funciona de verdad.
  drenar(c, 'tras conducir 2-5 por navegador')
  refrescarElEnlace(c, DATOS.emailKnown)
  // Las cinco en UNA sola tirada: cada sonda era un salto doble entero, y el segundo tramo
  // falla con HTTP 404 cuando el POST tarda (del lado de Google, ya medido). Once tiradas
  // eran once oportunidades de morir por algo ajeno al camino de inscripción.
  leerLoteDeVuelta(c, 'manual_robotSondasDelUnoAlCinco', 'navegador')

  // ── 4 · Documentos y envío, y su lectura de vuelta ──────────────────────────────────
  if (!await conducirDocumentos(c, page))  return c
  if (!await conducirEnvio(c, page))       return c
  drenar(c, 'tras documentos y envío')
  leerDeVuelta(c, 'manual_robotSonda06Documentos', 'paso 6 · documentos', 'navegador')
  leerDeVuelta(c, 'manual_robotSonda07Envio', 'paso 7 · envío', 'navegador')

  // ── 5 · ADMITIR. Esto NO es uno de los once pasos: es un acto del PERSONAL en el KMS,
  //       no de la familia en el wizard. Es lo que DESTAPA los pasos 8-11.
  traza('admitiendo el expediente (acto del personal en el KMS, no de la familia)')
  paso('manual_robotLlevarAEstado', 'admitir el expediente (acto del personal, motor de estados)', [EXPEDIENTE.gid, 'AD'])

  // 5.bis · DRENAR OTRA VEZ, y no es cautela: es lo que hacía imposible el paso 11.
  //
  // MEDIDO el 2026-08-04. El expediente estaba en `AD` —los dos, comprobado con
  // `manual_robotLlevarAEstado` sobre el grupo de la corrida anterior: `ya-en-AD | ya-en-AD`—
  // y aun así `firma.sesiones_n = 0`. La causa NO era que no llegara a admitirse (eso se
  // dio por hecho sin mirar): es que **admitir no abre la sesión de firma de forma
  // síncrona**. Desde PERF-RSAD (2026-07-30, Diego), la transición **ENCOLA** la evaluación
  // de las reglas del tenant en vez de correrla en línea —
  // `kis-app/kms-server/sys/transition-engine.gs:307`, `sys_enqueueJob_(…,
  // 'EVALUATE_TRANSITION_RULES', …)` — y de esa evaluación sale la acción `INITIATE_SIGNING`
  // que crea la sesión (`sys/scheduled-rules.gs:4097`, vía `enr_initiateSigningSession`).
  // Sin un turno de cola DESPUÉS de admitir, ese trabajo no lo corre nadie: el robot leía
  // los pasos 8-11 sobre un expediente admitido cuyos efectos aún no habían ocurrido, y le
  // echaba la culpa al producto. Lo mismo explicaba el borrador de suscripción ausente
  // del paso 8.
  drenar(c, 'tras admitir')

  // ── 6 · LOS PASOS 8-10, PULSANDO BOTONES ───────────────────────────────────────────
  // Se vuelve a entrar por el enlace: la ventana de step-up de la primera entrada ya
  // caducó (10 min duros) y los tres actos de firma la exigen. Es además lo que hace la
  // familia de verdad — recibe el aviso de admisión y vuelve por su enlace.
  traza('volviendo a entrar por el enlace, ya con el expediente admitido')
  if (!await entrarPorElEnlace(c, page, base, { pidiendolo: true })) return c
  let trasAdmitir = await dondeEstoy(page)
  c.notas.push(`    · tras la admisión, el enlace aterriza en el paso ${trasAdmitir + 1}`)
  // Si aterriza en Revisión (paso 7) con el avance ya desbloqueado, la familia lo PULSA.
  // El wizard desbloquea ese botón solo cuando el estado lo gobierna (AD + firma lista),
  // así que pulsarlo no fuerza nada: es el gesto que el propio producto ofrece.
  if (trasAdmitir === 6) {
    const avanzar = await page.$(BTN_SIGUIENTE)
    if (avanzar) {
      traza('el paso 7 ofrece el avance a la firma: pulsándolo')
      await avanzar.click()
      await page.waitForTimeout(2500)
      trasAdmitir = await dondeEstoy(page)
      c.notas.push(`    · tras pulsar el avance del paso 7, el wizard está en el paso ${trasAdmitir + 1}`)
    }
  }
  if (!c.afirmar('un expediente admitido aterriza en el tramo de firma (paso 8.º)',
    trasAdmitir === 7,
    `aterrizó en el paso ${trasAdmitir + 1} y no en el 8: la familia NO puede llegar a facturación. ` +
    `El wizard solo desbloquea el avance cuando la firma está lista para ese tutor (estado AD + ` +
    `signing_ready), así que mira PRIMERO si hay sesión de firma — si el paso 11 dice ` +
    `firma.sesiones_n=0, la causa está AGUAS ARRIBA y ya está medida y encolada: la generación de ` +
    `documentos no cabe en el permiso drive.file (docs/kms/pendiente-diego.md §2). NO es un ` +
    `defecto de este recorrido ni algo que re-diagnosticar.`)) {
    leerDeVuelta(c, 'manual_robotSonda08Facturacion', 'paso 8 · facturación', 'navegador (no alcanzado)')
    leerDeVuelta(c, 'manual_robotSonda09Consentimientos', 'paso 9 · consentimientos', 'navegador (no alcanzado)')
    leerDeVuelta(c, 'manual_robotSonda10Revision', 'paso 10 · revisión', 'navegador (no alcanzado)')
    leerDeVuelta(c, 'manual_robotSonda11Firma', 'paso 11 · firma', 'navegador (no alcanzado)')
    return c
  }

  const ok8  = await conducirFacturacion(c, page)
  const ok9  = ok8 && await conducirConsentimientos(c, page)
  const ok10 = ok9 && await conducirRevisionContractual(c, page)
  if (REAL) await esperarSilencioDeRed(60000)
  drenar(c, 'tras los actos de firma')

  // ── 7 · Leer de vuelta 8-11 ────────────────────────────────────────────────────────
  leerDeVuelta(c, 'manual_robotSonda08Facturacion', 'paso 8 · facturación', ok8 ? 'navegador' : 'navegador (caído)')
  leerDeVuelta(c, 'manual_robotSonda09Consentimientos', 'paso 9 · consentimientos', ok9 ? 'navegador' : 'navegador (no alcanzado)')
  leerDeVuelta(c, 'manual_robotSonda10Revision', 'paso 10 · revisión', ok10 ? 'navegador' : 'navegador (no alcanzado)')
  // El paso 11 lo PREPARA el motor del KMS al admitir (sesión, firmantes, tokens,
  // paquete). Lo que el navegador podría conducir es el ACTO de firmar, y ése está
  // PROHIBIDO: sale a Click & Sign y es irreversible. Se lee de vuelta la preparación.
  leerDeVuelta(c, 'manual_robotSonda11Firma', 'paso 11 · firma', 'navegador (hasta el borde del acto)')
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

/**
 * SALUD DESDE LA PANTALLA — elegir alergia, dieta y condición médica y comprobar que la
 * elección QUEDA PUESTA. Separa dos culpables que hasta hoy se confundían: «el producto no
 * guarda» y «el robot no registra la elección».
 */
async function caminoSaludDesdeLaPantalla(page, base) {
  const c = new Camino('salud-desde-la-pantalla')
  scenario.stage = 'hasta_preguntas'
  if (!await entrarPorElEnlace(c, page, base)) return c
  // Retroceder hasta Salud (índice 3) como lo haría la familia: con el botón «Atrás».
  for (let i = 0; i < 6 && (await dondeEstoy(page)) > 3; i++) {
    const atras = await page.$('button.btn-secondary-kis:not(:has(i.bi-pencil))')
    if (!atras) break
    await atras.click()
    await page.waitForTimeout(250)
  }
  const donde = await dondeEstoy(page)
  const pantalla = await page.evaluate(sondaPantalla)
  c.evidencia.elementos = pantalla.pasos + pantalla.campos
  if (!c.afirmar('se llega al paso de Salud pulsando «Atrás»', donde === 3,
    `se quedó en el índice ${donde}`)) return c
  await desbloquear(page)
  await conducirSalud(c, page)
  return c
}

/**
 * EL CUESTIONARIO NO SE APAGA EN SILENCIO — defecto 3 de la definición de hecho.
 *
 * Lo que rompía a la familia: el servidor convertía CUALQUIER fallo del catálogo en
 * `{sets:[]}`; el cliente lo sembraba como catálogo bueno y lo servía de su caché 30 min
 * sin volver a salir a red; la pantalla decía «No se encontraron preguntas» —una cosa
 * FALSA— y «Continuar» guardaba un cuestionario vacío. Ni recargar lo arreglaba.
 *
 * Este camino recorre las tres afirmaciones, en la pantalla:
 *   (a) con el servidor sano, el paso 5 PINTA preguntas de verdad;
 *   (b) con el catálogo caído, la familia ve un fallo NOMBRADO (no «no hay preguntas»)
 *       y NO puede avanzar (avanzar guardaría en blanco);
 *   (c) el fallo NO SE PEGA: en cuanto el servidor vuelve, «Volver a intentarlo» pinta
 *       las preguntas — sin esperar la ventana de revalidación de 30 minutos.
 */
async function caminoCuestionarioNoSeApaga(page, base) {
  const c = new Camino('cuestionario-no-se-apaga')
  scenario.stage = 'hasta_preguntas'
  scenario.preguntasMode = 'ok'
  // El fallo del catálogo se PROVOCA aquí: que quede registrado en consola es lo correcto
  // (antes se tragaba en silencio). Se declara para que no cuente como ruido, y la batería
  // exige que haya ocurrido de verdad — si no ocurre, este camino no midió nada.
  c.esperarErrorConsola(/gasCall fetchQuestions: server returned ok=false/,
    'el catálogo se tumba a propósito para comprobar que la familia se entera')

  if (!await entrarPorElEnlace(c, page, base)) return c
  if (!await irAPreguntas(c, page)) return c

  await page.waitForTimeout(LATENCY + 600)
  let vista = await page.evaluate(sondaPreguntas)
  c.evidencia.elementos = vista.campos + vista.tarjetas
  c.afirmar('(a) con el servidor sano el cuestionario PINTA preguntas',
    vista.preguntas >= 1,
    `el paso 5 pintó ${vista.preguntas} preguntas: con catálogo servido, cero preguntas es el apagón`)

  // ── Servidor caído + sesión nueva: es como llega una familia cuyo servidor falla.
  scenario.preguntasMode = 'caido'
  // Sesión LIMPIA de verdad: borrar los almacenes NO basta —la caché de MÓDULO de
  // `api.js` vive en el contexto de JavaScript de la página y sobrevive a un cambio de
  // hash—. `about:blank` tira ese contexto, que es lo que hace una familia que abre el
  // enlace en un navegador nuevo mientras el servidor está caído.
  await page.evaluate(() => { try { sessionStorage.clear(); localStorage.clear() } catch {} })
  await page.goto('about:blank')
  if (!await entrarPorElEnlace(c, page, base)) return c
  if (!await irAPreguntas(c, page)) return c
  await page.waitForTimeout(LATENCY + 900)

  vista = await page.evaluate(sondaPreguntas)
  c.afirmar('(b.1) un catálogo caído se NOMBRA como fallo, no como «no hay preguntas»',
    vista.avisoCaido && !vista.diceNoHayPreguntas,
    `aviso de fallo=${vista.avisoCaido} · dice «no hay preguntas»=${vista.diceNoHayPreguntas}: ` +
    'la familia se creería que este colegio no pregunta nada')
  c.afirmar('(b.2) con el catálogo caído NO se puede avanzar',
    vista.continuarDeshabilitado,
    'el botón «Continuar» estaba pulsable: avanzar guardaría el cuestionario en blanco')

  // ── (c) el fallo NO se queda pegado: vuelve el servidor y se reintenta.
  scenario.preguntasMode = 'ok'
  const reintentar = await page.$('[data-e2e="catalogo-reintentar"]')
  if (!c.afirmar('(c.1) la pantalla ofrece reintentar', !!reintentar,
    'sin botón de reintento la familia solo puede recargar — y con la caché envenenada eso no servía de nada')) return c
  await reintentar.click()
  await page.waitForTimeout(LATENCY + 900)
  vista = await page.evaluate(sondaPreguntas)
  c.afirmar('(c.2) el fallo NO se pega: al volver el servidor, el cuestionario aparece',
    vista.preguntas >= 1 && !vista.avisoCaido,
    `tras reintentar: preguntas=${vista.preguntas} aviso=${vista.avisoCaido}. ` +
    'Éste es el corazón del defecto: un vacío cacheado apagaba el paso durante 30 minutos')
  return c
}

/** Sonda del paso 5. Distingue las tres pantallas posibles: preguntas / vacío / fallo. */
const sondaPreguntas = () => {
  const txt = (document.body.textContent || '').replace(/\s+/g, ' ')
  const continuar = [...document.querySelectorAll('button.btn-primary-kis')]
    .filter(b => !b.hasAttribute('data-e2e'))
  return {
    preguntas:  document.querySelectorAll('.qb-question, [data-qb-question]').length ||
                document.querySelectorAll('.form-label').length,
    campos:     document.querySelectorAll('input, select, textarea').length,
    tarjetas:   document.querySelectorAll('.kis-card').length,
    avisoCaido: !!document.querySelector('[data-e2e="catalogo-caido"]'),
    diceNoHayPreguntas: /No se encontraron preguntas|No questions found/.test(txt),
    continuarDeshabilitado: continuar.length > 0 && continuar.every(b => b.disabled),
  }
}

/** Lleva la pantalla al paso 5 (Preguntas, índice 4) desde donde esté, con «Atrás». */
async function irAPreguntas(c, page) {
  for (let i = 0; i < 8 && (await dondeEstoy(page)) > 4; i++) {
    const atras = await page.$('button.btn-secondary-kis:not(:has(i.bi-pencil))')
    if (!atras) break
    await atras.click()
    await page.waitForTimeout(250)
  }
  const donde = await dondeEstoy(page)
  if (!c.afirmar('se llega al paso de Preguntas', donde === 4,
    `se quedó en el índice ${donde}`)) return false
  await desbloquear(page)
  return true
}

/**
 * PEDIR CORREGIR — una familia que YA envió se da cuenta de un error y lo pide desde
 * la pantalla (cola 18.quater, decisión de Diego 2026-08-07).
 *
 * Lo que afirma, y son DOS cosas, no una:
 *   · que el botón EXISTE en la pantalla de «solicitud enviada» y que al enviarlo la
 *     familia ve que su petición quedó cursada;
 *   · y —lo que de verdad importa— que cuando el KMS contesta que NO quedó cursada
 *     (p.ej. el colegio aún no lo tiene declarado) la pantalla lo dice, en vez de
 *     enseñar el mismo «hecho» de siempre.
 *
 * El segundo es el que protege a la familia: un «hecho» falso la deja esperando una
 * respuesta que nadie va a mandar, y nadie se entera nunca. Por eso los dos casos se
 * recorren de verdad, no solo el bueno.
 */
async function caminoPedirCorreccion(page, base) {
  const c = new Camino('pedir-correccion')
  scenario.stage = 'enviada'
  scenario.correccionMode = 'ok'

  if (!await entrarPorElEnlace(c, page, base)) return c
  await page.waitForTimeout(LATENCY + 400)

  const pantalla = await page.evaluate(sondaPantalla)
  c.evidencia.elementos = pantalla.pasos + pantalla.campos + pantalla.tarjetas
  c.afirmar('sin pantalla de error', !pantalla.errorFatal, 'el ErrorBoundary pintó "Something went wrong."')
  c.afirmar('una solicitud ya enviada aterriza en Revisión (paso 7.º)',
    pantalla.pasoActivo === 6,
    `aterrizó en el índice ${pantalla.pasoActivo} (se esperaba 6)`)

  // ── (a) el camino bueno: pedirlo y ver que quedó cursado ────────────────────
  const abrir = await page.$('[data-testid="correction-open"]')
  if (!c.afirmar('la pantalla de «solicitud enviada» ofrece corregir',
        !!abrir, 'no hay ningún sitio donde pedirlo: la familia sigue teniendo que escribir a admisiones')) {
    return c
  }
  await abrir.click()
  await page.waitForTimeout(150)
  const nota = await page.$('[data-testid="correction-note"]')
  if (nota) await nota.type('nos equivocamos en la fecha de nacimiento')
  const enviar = await page.$('[data-testid="correction-send"]')
  if (!c.afirmar('el formulario de corrección tiene botón de enviar', !!enviar, 'no se pintó')) return c
  await enviar.click()
  await page.waitForTimeout(LATENCY + 600)
  c.evidencia.llamadas++
  c.afirmar('cursada la petición, la familia ve que llegó',
    !!(await page.$('[data-testid="correction-result-ok"]')),
    'no se pintó la confirmación: la familia no sabe si su petición salió')

  // ── (b) el caso que protege: el KMS dice que NO quedó cursada ───────────────
  scenario.correccionMode = 'no_declarada'
  if (!await entrarPorElEnlace(c, page, base)) return c
  await page.waitForTimeout(LATENCY + 400)
  const abrir2 = await page.$('[data-testid="correction-open"]')
  if (!c.afirmar('se puede volver a pedir tras recargar', !!abrir2, 'el botón desapareció')) return c
  await abrir2.click()
  await page.waitForTimeout(150)
  const enviar2 = await page.$('[data-testid="correction-send"]')
  if (!c.afirmar('el botón de enviar sigue ahí en el segundo caso', !!enviar2, 'no se pintó')) return c
  await enviar2.click()
  await page.waitForTimeout(LATENCY + 600)
  c.evidencia.llamadas++
  const fallo = await page.$('[data-testid="correction-result-failed"]')
  const falsoOk = await page.$('[data-testid="correction-result-ok"]')
  c.afirmar('si NO quedó cursada, se le dice a la familia (y NO se le dice que sí)',
    !!fallo && !falsoOk,
    falsoOk
      ? 'la pantalla dijo «recibida» con una petición que el KMS NO cursó — la familia se queda esperando para siempre'
      : 'no se pintó ningún aviso: el botón no hizo nada visible')
  return c
}

/**
 * QUITAR ALGO DE LA SOLICITUD — cola 18.bis.8.
 *
 * Lo que rompía a la familia: los botones de quitar solo borraban DE LA PANTALLA. Al
 * guardar se mandaba la lista superviviente y el servidor guardaba lo que llegaba, sin
 * tocar lo que dejaba de venir ⇒ **quitar no se guardaba nunca**, y al volver a entrar
 * seguía todo ahí. Diego lo intentó dos veces y las dos siguió midiendo 22 personas.
 *
 * Este camino recorre las afirmaciones, EN LA PANTALLA:
 *   (0) la pregunta previa la pinta **el asistente**, no el navegador (18.bis.16), y si la
 *       familia **CANCELA no pasa nada** — ni en la pantalla ni hacia el servidor. Esta es
 *       la que vigila el riesgo caro de aquel cambio: `window.confirm` detenía la
 *       ejecución y un cuadro de React no, así que una conversión descuidada quitaría a la
 *       persona **sin preguntar**;
 *   (a) quitar a una persona **sale hacia el servidor** (no se queda en el navegador) y
 *       la persona deja de verse;
 *   (b) si el servidor dice que **NO se puede** (el último tutor, el solicitante), la
 *       persona **VUELVE A VERSE** y se le dice por qué — jamás se finge que se quitó;
 *   (c) con la solicitud **ya enviada**, tampoco se finge: vuelve y se le explica que
 *       puede pedir la corrección.
 *
 * (b) y (c) son el fondo del asunto: una pantalla que trata un «no» como un «sí» deja a
 * la familia creyendo que quitó a alguien que sigue en su expediente.
 */
async function caminoQuitarDeLaSolicitud(page, base) {
  const c = new Camino('quitar-de-la-solicitud')
  scenario.stage = 'hasta_preguntas'
  scenario.quitarMode = 'ok'

  // ── La pregunta es DE LA APLICACIÓN, no del navegador (cola 18.bis.16) ──────────
  // Hasta el 2026-08-09 la confirmación era un `window.confirm` y este camino la
  // aceptaba con `page.on('dialog', …)`. Ahora la pregunta la pinta el asistente, así
  // que el manejador de diálogos pasa a ser un VIGÍA: si vuelve a aparecer un aviso del
  // navegador, se cuenta y se falla nombrándolo (y se descarta, que es lo que hace el
  // navegador solo cuando nadie contesta — con lo que el resto del camino también cae).
  let nativos = 0
  const vigilarNativo = async (dlg) => { nativos++; try { await dlg.dismiss() } catch { /* ya cerrado */ } }
  page.on('dialog', vigilarNativo)

  /** Contesta a la pregunta del asistente. `true` = confirmar, `false` = cancelar. */
  const responderEnPantalla = async (confirmar) => {
    const cuadro = await page.waitForSelector('[data-testid="confirm-dialog"]', { timeout: 4000 }).catch(() => null)
    if (!cuadro) return false
    const boton = await page.$(`[data-testid="confirm-dialog-${confirmar ? 'accept' : 'cancel'}"]`)
    if (!boton) return false
    await boton.click()
    await page.waitForTimeout(120)
    return true
  }

  // Se cuentan las llamadas que salen DE VERDAD: es la afirmación central (a).
  let llamadasQuitar = 0
  let ultimoCuerpo = null
  const espiar = (req) => {
    if (!/\/__gas/.test(req.url())) return
    let body = null
    try { body = JSON.parse(req.postData() || '{}') } catch { return }
    if (body && body.action === 'retirarDelExpediente') { llamadasQuitar++; ultimoCuerpo = body }
  }
  page.on('request', espiar)

  const limpiar = () => { page.off('dialog', vigilarNativo); page.off('request', espiar) }

  try {
    if (!await entrarPorElEnlace(c, page, base)) return c
    // Retroceder hasta Personas (índice 1) como lo haría la familia.
    for (let i = 0; i < 8 && (await dondeEstoy(page)) > 1; i++) {
      const atras = await page.$('button.btn-secondary-kis:not(:has(i.bi-pencil))')
      if (!atras) break
      await atras.click()
      await page.waitForTimeout(250)
    }
    if (!c.afirmar('se llega al paso de Personas', (await dondeEstoy(page)) === 1,
      `se quedó en el índice ${await dondeEstoy(page)}`)) return c
    await desbloquear(page)
    await page.waitForTimeout(200)

    const contarPersonas = () => page.$$eval('.dynamic-section-header',
      (h) => h.filter(x => /Tutor|Guardian|Alumno|Student/i.test(x.textContent || '')).length)

    const antes = await contarPersonas()
    const pantalla = await page.evaluate(sondaPantalla)
    c.evidencia.elementos = pantalla.pasos + pantalla.campos
    // DL-E49 §2 — «hay más de una persona» dejó de ser el requisito real: el servidor
    // ya no enseña al segundo tutor (por diseño), así que desde AQUÍ solo hay UN
    // tutor visible + los menores. Lo que este camino necesita es UN botón de quitar,
    // y los tres sub-casos (a/b/c) se ejercitan sobre EL MISMO, en el orden que no
    // lo consume hasta el final: primero los dos que lo devuelven (no_se_puede,
    // enviada), y solo al final el que de verdad lo quita (ok).
    if (!c.afirmar('hay alguien con quien probar', antes >= 1,
      `no se pintó ninguna persona: sin al menos una, quitar no se puede ni empezar a medir`)) return c
    const botonesIniciales = await page.$$('.dynamic-section-header button.remove-btn')
    if (!c.afirmar('la persona que la familia añadió tiene botón de quitar', botonesIniciales.length >= 1,
      'no hay ningún botón de quitar: la familia no puede deshacer lo que metió por error')) return c
    const objetivo = botonesIniciales.length - 1  // el último — el que la familia añadió

    // ── (0) la pregunta es DEL ASISTENTE, y CANCELAR no quita nada (18.bis.16) ─
    // El riesgo caro de haber cambiado el aviso del navegador por uno de la aplicación:
    // `window.confirm` DETENÍA la ejecución y devolvía sí/no en la misma línea; un cuadro
    // de React no. Una conversión descuidada dispararía el quitar ANTES de la respuesta.
    // Esto lo mide donde se ve: se pulsa quitar, se CANCELA, y no puede haber pasado nada
    // — ni en la pantalla ni hacia el servidor.
    await (await page.$$('.dynamic-section-header button.remove-btn'))[objetivo].click()
    const salioElCuadro = await responderEnPantalla(false)
    c.afirmar('la pregunta la pinta el asistente, no el navegador',
      salioElCuadro && nativos === 0,
      nativos > 0
        ? 'saltó un aviso del NAVEGADOR («admissions.kaleide.org dice»): la familia ve un cuadro del sistema en mitad de su solicitud'
        : 'no apareció el cuadro de confirmación del asistente al pulsar quitar')
    await page.waitForTimeout(LATENCY + 400)
    // Las dos son PUERTA: si la acción se disparó sin respuesta, los sub-casos de abajo
    // operan sobre una lista ya mutilada y el camino se rompería con un ruido cualquiera
    // («undefined.click») en vez de decir lo que pasó. Se para aquí y se nombra.
    if (!c.afirmar('si la familia CANCELA, la persona sigue ahí',
      (await contarPersonas()) === antes,
      `quedaron ${await contarPersonas()} de ${antes}: se quitó a alguien que la familia NO confirmó quitar — la acción se disparó ANTES de la respuesta`)) return c
    if (!c.afirmar('y CANCELAR no manda nada al servidor',
      llamadasQuitar === 0,
      `salieron ${llamadasQuitar} peticiones de retirada tras CANCELAR: la acción se disparó antes de la respuesta`)) return c

    // ── (b) el servidor dice que NO se puede ⇒ VUELVE, y se dice por qué ──────
    scenario.quitarMode = 'no_se_puede'
    await (await page.$$('.dynamic-section-header button.remove-btn'))[objetivo].click()
    if (!c.afirmar('el cuadro vuelve a salir para el segundo intento', await responderEnPantalla(true),
      'no se pudo confirmar: el cuadro del asistente no apareció')) return c
    await page.waitForTimeout(LATENCY + 900)
    const trasRechazo = await contarPersonas()
    const texto = (await page.evaluate(() => (document.body.textContent || '').replace(/\s+/g, ' '))).toLowerCase()
    c.afirmar('si el servidor dice que NO se puede, la persona VUELVE A VERSE',
      trasRechazo === antes,
      `quedaron ${trasRechazo} de ${antes}: la pantalla dio por quitada a una persona que sigue en el expediente`)
    c.afirmar('y se le dice por qué', texto.includes('al menos un tutor'),
      'no se pintó el motivo: la familia ve reaparecer a alguien sin saber qué pasó')

    // ── (c) ya enviada ⇒ tampoco se finge ─────────────────────────────────────
    scenario.quitarMode = 'enviada'
    const botones3 = await page.$$('.dynamic-section-header button.remove-btn')
    if (!c.afirmar('sigue habiendo botón de quitar tras el rechazo', botones3.length >= 1,
      '(c) no se pudo ejercitar: no quedó ningún botón de quitar')) return c
    await botones3[objetivo].click()
    if (!c.afirmar('el cuadro sale también con la solicitud enviada', await responderEnPantalla(true),
      'no se pudo confirmar: el cuadro del asistente no apareció')) return c
    await page.waitForTimeout(LATENCY + 900)
    const texto3 = (await page.evaluate(() => (document.body.textContent || '').replace(/\s+/g, ' '))).toLowerCase()
    c.afirmar('con la solicitud ya enviada, la persona sigue ahí',
      (await contarPersonas()) === antes,
      'se quitó de la pantalla algo que el servidor NO quitó')
    c.afirmar('y se le dice que puede pedir que se la devuelvan para corregirla',
      texto3.includes('corregir'),
      'no se pintó ninguna salida: la familia se queda sin saber qué hacer')

    // ── (a) se quita DE VERDAD, y SALE hacia el servidor ──────────────────────
    scenario.quitarMode = 'ok'
    const botones4 = await page.$$('.dynamic-section-header button.remove-btn')
    if (!c.afirmar('sigue habiendo botón de quitar tras el «ya enviada»', botones4.length >= 1,
      '(a) no se pudo ejercitar: no quedó ningún botón de quitar')) return c
    await botones4[objetivo].click()
    if (!c.afirmar('el cuadro sale en el intento que sí quita', await responderEnPantalla(true),
      'no se pudo confirmar: el cuadro del asistente no apareció')) return c
    await page.waitForTimeout(LATENCY + 600)
    c.evidencia.llamadas += llamadasQuitar

    c.afirmar('quitar a una persona SALE hacia el servidor', llamadasQuitar >= 1,
      'el botón no mandó nada: el borrado se queda en el navegador y al volver a entrar la persona sigue ahí (el defecto de 18.bis.8)')
    const lote = ultimoCuerpo && Array.isArray(ultimoCuerpo.retirar) ? ultimoCuerpo.retirar : []
    c.afirmar('lo que se quita viaja IDENTIFICADO, no «lo que no mando bórralo»',
      lote.length === 1 && lote[0].clase === 'PERSONA' && !!lote[0].id,
      `lo enviado fue ${JSON.stringify(lote).slice(0, 120)} — un borrado por omisión vaciaría la solicitud entera con un envío a medias`)
    c.afirmar('la persona deja de verse', (await contarPersonas()) === antes - 1,
      `siguen pintándose ${await contarPersonas()} de ${antes}`)
    return c
  } finally {
    limpiar()
    scenario.quitarMode = 'ok'
  }
}


/**
 * LAS RESPUESTAS VUELVEN — cola 18.bis.25, reportado por Diego el 2026-08-09: recupera su
 * solicitud y el cuestionario aparece EN BLANCO, aunque lo había contestado.
 *
 * Lo que se midió antes de escribir esto (contra los datos reales, no razonado): las
 * respuestas SÍ están guardadas (31 vivas en su expediente) y el KMS SÍ las sirve — su
 * hidratación devuelve las 31, con la forma que la pantalla espera y casando con personas
 * que esa misma respuesta trae. O sea que se pierden DENTRO del asistente, entre la
 * respuesta del servidor y lo que se pinta. Este camino es el que lo ve.
 *
 * Afirma UNA cosa, la que le importa a la familia: **lo que dejé escrito sigue ahí cuando
 * vuelvo**. Y lo comprueba donde se ve, en el valor del campo — no en el payload, que ya
 * sabemos que llega bien.
 *
 * ⚠️ La batería NO podía ver esto hasta hoy: el simulacro devolvía una respuesta a una
 * pregunta INEXISTENTE (`q1`) y atribuida a un tutor, cuando las preguntas del catálogo del
 * robot son generales y la pantalla las busca por el expediente. Servía para dar el paso por
 * visitado y jamás llegaba a pintarse. Arreglado en `mock-backend.mjs` en este mismo cambio.
 */
async function caminoRespuestasVuelven(page, base) {
  const c = new Camino('respuestas-vuelven')
  scenario.stage = 'hasta_preguntas'

  // Los DOS sujetos con los que una respuesta general puede volver del servidor. El
  // segundo NO es hipotético: es la forma exacta con la que Diego vio su cuestionario en
  // blanco el 2026-08-09, y el dato viejo sigue en la base de datos aunque el escritor ya
  // esté arreglado. La familia tiene que ver lo que escribió en los dos casos.
  const SUJETOS = [
    ['ok',               'contra el expediente'],
    ['contra_un_tutor',  'contra un tutor (la forma del defecto del 2026-08-09)'],
  ]

  try {
    for (const [modo, comoSeLlama] of SUJETOS) {
      scenario.respuestasMode = modo

      if (!await entrarPorElEnlace(c, page, base)) return c
      await page.waitForTimeout(LATENCY + 400)

      const pantalla = await page.evaluate(sondaPantalla)
      c.evidencia.elementos = Math.max(c.evidencia.elementos || 0, pantalla.pasos + pantalla.campos)
      c.afirmar(`sin pantalla de error — respuesta ${comoSeLlama}`, !pantalla.errorFatal,
        'el ErrorBoundary pintó "Something went wrong."')

      if (!await irAPreguntas(c, page)) return c
      await page.waitForTimeout(400)

      // Lo que la familia ve: el texto que escribió, dentro de un campo del cuestionario.
      const visto = await page.evaluate((esperado) => {
        const campos = [...document.querySelectorAll('input, textarea')]
        return {
          n_campos: campos.length,
          valores_no_vacios: campos.filter(e => String(e.value || '').trim()).length,
          lo_encuentra: campos.some(e => String(e.value || '').trim() === esperado),
        }
      }, RESPUESTA_GUARDADA)

      c.evidencia.elementos += visto.n_campos
      console.log(`      respuestas ${comoSeLlama}: ${visto.n_campos} campos, ${visto.valores_no_vacios} con valor`)

      c.afirmar(`el cuestionario pinta sus campos — respuesta ${comoSeLlama}`, visto.n_campos > 0,
        'el paso de Preguntas no pintó ni un campo: sin campos no hay nada que recuperar')
      c.afirmar(`lo que la familia escribió sigue ahí al volver a entrar — respuesta ${comoSeLlama}`, visto.lo_encuentra,
        `ninguno de los ${visto.n_campos} campos trae «${RESPUESTA_GUARDADA}» ` +
        `(${visto.valores_no_vacios} traen algún valor) — la respuesta llegó del servidor y se perdió en la pantalla`)
    }
  } finally {
    scenario.respuestasMode = 'ok'
  }
  return c
}

/**
 * LO QUE LA FAMILIA SUBIÓ SIGUE AHÍ CUANDO VUELVE A ENTRAR (síntoma de Diego, 2026-08-09:
 * «figuran tres archivos supuestamente subidos por la familia en el paso 6, documentos,
 * pero que no aparecen listados en el paso 6»).
 *
 * ── Por qué la secuencia es ÉSTA y no «entrar y mirar» ───────────────────────────────
 * El dato NO se pierde por el camino: el servidor lo manda. Lo que fallaba es CUÁNDO
 * llega. La pantalla de Documentos siembra su lista UNA sola vez, al montarse; y una
 * familia cuyo enlace ya no tiene gracia recibe la PRIMERA hidratación SIN nada suyo
 * (`pii_gated:true`, la verja de datos personales de DL-E39) y sus archivos solo llegan
 * en la SEGUNDA, tras teclear el código de un solo uso. Todo lo que estuviera montado
 * antes de ese segundo paquete se quedó con la foto vacía — para siempre.
 *
 * Por eso el recorrido reproduce las DOS hidrataciones, en su orden real:
 *   1. entra por el enlace → el servidor contesta con la verja puesta y CERO documentos;
 *   2. teclea el código → la segunda hidratación trae los TRES archivos;
 *   3. va a Documentos y **tienen que estar los tres, con su descripción**.
 *
 * Y afirma una cuarta cosa que es la que hace segura la corrección: **añadir un archivo
 * nuevo no borra los que ya estaban**. Re-sembrar una lista pisando lo que el usuario
 * tiene a medias sería peor que el fallo que se arregla.
 */
async function caminoDocumentosVuelven(page, base) {
  const c = new Camino('documentos-vuelven')
  scenario.stage = 'hasta_preguntas'

  if (REAL) {
    // La verja no se puede FORZAR contra el sistema de verdad (dependeria de dejar
    // caducar la gracia del enlace) y, sobre todo, el codigo de un solo uso llega a un
    // buzon que este arnes no lee. No se afloja la verja para que la prueba pase.
    c.noCubierta('documentos-tras-el-codigo',
      'la secuencia exige teclear el codigo de un solo uso que el servidor manda al buzon de la familia, y el arnes no lee buzones; en modo simulado si se cubre')
    c.noCubierta('descripciones-vuelven',
      'misma razon: sin pasar la verja no hay segunda hidratacion que inspeccionar')
    c.noCubierta('archivos-reconocibles',
      'misma razon: no se llega a la pantalla de Documentos con archivos ya subidos')
    c.noCubierta('anadir-no-borra-lo-que-habia',
      'misma razon: no se llega a la pantalla de Documentos con archivos ya subidos')
    return c
  }

  try {
    // ══ PASE 1 · con la VERJA de datos personales por medio ═══════════════════
    // Los archivos llegan en la SEGUNDA hidratacion, tras el codigo. Es la secuencia
    // de una familia cuyo enlace ya no tiene gracia.
    scenario.documentos = DOCUMENTOS_GUARDADOS
    scenario.piiGated = true
    scenario.otpSuperado = false

    await page.goto(`${base}/#/resume/${DATOS.resumeToken}?n=${DATOS.emailId}`,
      { waitUntil: 'domcontentloaded', timeout: 30000 })
    const hayVerja = await page.waitForSelector('input[autocomplete="one-time-code"]', { timeout: LATENCY * 3 + 15000 })
      .then(() => true).catch(() => false)
    if (!c.afirmar('con la verja puesta, el asistente pide el codigo antes de ensenar nada', hayVerja,
      'nunca aparecio la casilla del codigo de un solo uso: la secuencia que este recorrido mide no llego a darse')) return c

    const hidratacionesAntes = llamadas('hydrateSession').length

    // La casilla nace DESHABILITADA hasta que hay un codigo enviado. El asistente solo
    // lo manda solo la PRIMERA vez que se recupera la solicitud; despues espera a que la
    // familia lo pida (boton «Enviar codigo»). Se pulsa si hace falta -- que es lo que
    // hace una familia -- en vez de dar por hecho que la casilla esta lista.
    const casillaLista = async () => page.evaluate(() => {
      const i = document.querySelector('input[autocomplete="one-time-code"]')
      return !!(i && !i.disabled)
    })
    const esperarCasilla = (ms) => page.waitForFunction(() => {
      const i = document.querySelector('input[autocomplete="one-time-code"]')
      return !!(i && !i.disabled)
    }, null, { timeout: ms }).then(() => true).catch(() => false)
    // Primero se ESPERA al envío automático (el asistente lo dispara solo la primera vez
    // que se recupera la solicitud). Solo si no llega se pulsa «Enviar código» a mano —
    // pulsarlo mientras el automático está en vuelo no hace nada (el botón está inhabilitado)
    // y dejaba el recorrido en rojo por prisa del arnés, no por un defecto del asistente.
    if (!await casillaLista() && !await esperarCasilla(LATENCY * 4 + 8000)) {
      const pedir = await page.$('button.btn-link.btn-sm:not([disabled])')
      if (pedir) await pedir.click()
      await esperarCasilla(LATENCY * 3 + 10000)
    }
    if (!c.afirmar('la familia puede teclear el codigo que le mandaron', await casillaLista(),
      'la casilla del codigo sigue deshabilitada tras pedirlo: no se puede pasar la verja')) return c

    await page.fill('input[autocomplete="one-time-code"]', '123456')
    await page.click('button.btn-primary-kis:not([disabled])')
    const abierto = await page.waitForFunction(() => {
      const pasos = document.querySelectorAll('.wizard-step')
      return !!(pasos.length && [...pasos].some(p => p.classList.contains('active')))
    }, null, { timeout: LATENCY * 4 + 20000 }).then(() => true).catch(() => false)
    if (!c.afirmar('tras el codigo, el asistente abre la solicitud', abierto,
      'el asistente no llego a pintar los pasos despues de verificar el codigo')) return c
    await page.waitForTimeout(LATENCY + 600)

    c.afirmar('el codigo provoca una segunda hidratacion (la que trae los archivos)',
      llamadas('hydrateSession').length > hidratacionesAntes,
      'no salio ninguna hidratacion nueva tras el codigo: los archivos nunca llegaron a la pantalla')

    if (!await irADocumentos(c, page, 'con la verja por medio')) return c
    await page.waitForTimeout(400)
    const conVerja = await radiografiaDocumentos(page)
    console.log(`      con la verja por medio: ${JSON.stringify(conVerja)}`)
    c.evidencia.elementos = conVerja.n_paneles
    c.evidencia.llamadas  = llamadas('hydrateSession').length

    c.afirmar('los archivos que la familia ya subio salen listados al volver a entrar',
      conVerja.n_paneles >= DOCUMENTOS_GUARDADOS.length,
      `el paso de Documentos pinto ${conVerja.n_paneles} de los ${DOCUMENTOS_GUARDADOS.length} archivos que el servidor mando en la segunda hidratacion`)

    const esperadas = DOCUMENTOS_GUARDADOS.map(d => d.description)
    c.afirmar('cada archivo conserva la descripcion que escribio la familia',
      esperadas.every(d => conVerja.descripciones.includes(d)),
      `faltan descripciones: se esperaban ${JSON.stringify(esperadas)} y en pantalla hay ${JSON.stringify(conVerja.descripciones)} -- el servidor no manda la descripcion en la hidratacion, asi que lo que la familia escribio vuelve en blanco`)

    // Anadir uno nuevo NO borra los que habia.
    const anadir = await page.$('.add-btn')
    if (!anadir) { c.fallos.push('el paso de Documentos no ofrece el boton de anadir archivo (.add-btn)'); return c }
    await anadir.click()
    await page.waitForTimeout(300)
    const trasAnadir = await page.evaluate(() => document.querySelectorAll('.doc-attachment').length)
    c.afirmar('anadir un archivo nuevo no borra los que ya estaban',
      trasAnadir === conVerja.n_paneles + 1,
      `antes habia ${conVerja.n_paneles} paneles y tras pulsar «Anadir archivo» hay ${trasAnadir} (se esperaban ${conVerja.n_paneles + 1})`)

    // ══ PASE 2 · ARCHIVOS SIN DESCRIPCION ════════════════════════════════════
    // La descripcion es OPCIONAL: un expediente normal tiene archivos sin ella. Si la
    // pantalla solo sabe ensenar la descripcion, esos archivos salen como cajas vacias:
    // ESTAN, pero la familia no reconoce ninguno -- y eso, para quien mira, es lo mismo
    // que si no estuvieran. Aqui se entra por el camino ordinario (con la gracia del
    // enlace, sin verja), porque lo que se mide es OTRA cosa.
    scenario.documentos = DOCUMENTOS_SIN_DESCRIPCION
    scenario.piiGated = false
    scenario.otpSuperado = false

    if (!await entrarPorElEnlace(c, page, base)) return c
    await page.waitForTimeout(LATENCY + 400)
    if (!await irADocumentos(c, page, 'sin descripcion')) return c
    await page.waitForTimeout(400)
    const sinDesc = await radiografiaDocumentos(page)
    console.log(`      sin descripcion: ${JSON.stringify(sinDesc)}`)
    c.evidencia.elementos = Math.max(c.evidencia.elementos, sinDesc.n_paneles)

    c.afirmar('los archivos sin descripcion tambien salen listados',
      sinDesc.n_paneles >= DOCUMENTOS_SIN_DESCRIPCION.length,
      `el paso de Documentos pinto ${sinDesc.n_paneles} de los ${DOCUMENTOS_SIN_DESCRIPCION.length} archivos`)

    const nombres = DOCUMENTOS_SIN_DESCRIPCION.map(d => d.file_name)
    c.afirmar('la familia puede RECONOCER cada archivo que subio',
      nombres.every(n => sinDesc.texto.includes(n)),
      `ninguno de los ${sinDesc.n_paneles} paneles dice de que archivo se trata: se buscaban ${JSON.stringify(nombres)} y el paso solo muestra «${sinDesc.texto.replace(/\s+/g, ' ').trim().slice(0, 160)}». Sin descripcion escrita, el panel no ensena NADA que identifique el fichero: la familia ve cajas vacias y no puede saber que subio`)
  } finally {
    scenario.piiGated = false
    scenario.otpSuperado = false
    scenario.documentos = null
  }
  return c
}

/** Lo que se VE en el paso de Documentos: cuantos paneles, sus descripciones y su texto. */
async function radiografiaDocumentos(page) {
  return page.evaluate(() => {
    const paneles = [...document.querySelectorAll('.doc-attachment')]
    return {
      n_paneles: paneles.length,
      descripciones: paneles.map(p => {
        const i = p.querySelector('input[type="text"]')
        return String((i && i.value) || '').trim()
      }).filter(Boolean),
      n_confirmados: document.querySelectorAll('.doc-attachment .upload-status.success').length,
      texto: paneles.map(p => p.innerText || '').join(' | '),
    }
  })
}

/** Retrocede hasta el paso de Documentos (índice 5) y lo desbloquea para poder tocarlo. */
async function irADocumentos(c, page, etiqueta) {
  for (let i = 0; i < 8 && (await dondeEstoy(page)) > 5; i++) {
    const atras = await page.$('button.btn-secondary-kis:not(:has(i.bi-pencil))')
    if (!atras) break
    await atras.click()
    await page.waitForTimeout(250)
  }
  const donde = await dondeEstoy(page)
  if (!c.afirmar(`se llega al paso de Documentos${etiqueta ? ' — ' + etiqueta : ''}`, donde === 5,
    `se quedó en el índice ${donde}`)) return false
  await desbloquear(page)
  return true
}

/**
 * DL-E49 §1 · EL SEGUNDO TUTOR ENVÍA Y LA SOLICITUD PASA A REVISIÓN.
 *
 * El defecto que este camino vigila NO es hipotético: hasta hoy, en cuanto UN tutor
 * enviaba, el asistente se cerraba para TODOS y el equipo de admisiones recibía como
 * completa una solicitud a la que le faltaban las respuestas del otro tutor.
 *
 * Lo que afirma, en el orden en que lo vive la familia:
 *   1. la madre envía su parte → la pantalla de confirmación le ACUSA RECIBO diciéndole
 *      que falta la parte del otro tutor, POR SU NOMBRE (§5). Sin ese acuse envía, no
 *      pasa nada visible, y no entiende por qué;
 *   2. el padre entra después y envía la suya → ya NO se le dice que falte nadie, porque
 *      la solicitud ya está completa y pasa a revisión.
 *
 * `scenario.partes` es lo único simulado: 'falta_el_otro' hace que el PRIMER envío vuelva
 * parcial y el SEGUNDO completo, que es exactamente la secuencia del contrato real.
 */
async function caminoSegundoTutorEnvia(page, base) {
  const c = new Camino('segundo-tutor-envia')
  scenario.stage = 'lista_para_enviar'   // aterriza en Revisión, con el botón de enviar
  scenario.partes = 'falta_el_otro'

  try {
    // ── 1 · La madre envía su parte ──────────────────────────────────────────
    if (!await entrarPorElEnlace(c, page, base)) return c
    await page.waitForTimeout(LATENCY + 600)
    const donde1 = await dondeEstoy(page)
    if (!c.afirmar('un expediente listo aterriza en Revisión', donde1 === 6,
      `aterrizó en el índice ${donde1} (se esperaba 6): sin llegar a Revisión no hay envío que probar`)) return c
    await desbloquear(page)
    if (!await conducirEnvio(c, page)) return c

    const envio1 = llamadas('submitEnrollmentSession').slice(-1)[0]
    c.afirmar('el envío dice QUIÉN lo manda (el `n` del enlace viaja)',
      !!(envio1 && envio1.payload && envio1.payload.n),
      'el envío salió sin el `n` del enlace: el servidor no puede saber qué tutor envió, ' +
      'y sin eso la parte no se registra a nombre de nadie')

    // El acuse se pinta cuando vuelve `estadoDeLasPartes` (la confirmación lo pregunta).
    const t0 = Date.now()
    while (!llamadas('estadoDeLasPartes').length && Date.now() - t0 < 20000) await page.waitForTimeout(200)
    await page.waitForTimeout(LATENCY + 500)

    const acuse = await page.evaluate(() => {
      const txt = document.body.innerText || ''
      return { texto_len: txt.length, nombra_al_que_falta: /RobotDosE2E/.test(txt) }
    })
    c.evidencia.elementos = Math.max(c.evidencia.elementos || 0, 2)
    c.afirmar('acuse al que envía primero — se le dice que falta el otro tutor, por su nombre',
      acuse.nombra_al_que_falta,
      'la pantalla de confirmación no nombra al tutor que falta: la familia envía, no pasa ' +
      'nada visible, y no entiende por qué la solicitud no avanza')

    // ── 2 · El padre entra después y envía la suya ───────────────────────────
    if (!await entrarPorElEnlace(c, page, base)) return c
    await page.waitForTimeout(LATENCY + 600)
    const donde2 = await dondeEstoy(page)
    if (!c.afirmar('el segundo tutor también aterriza en Revisión', donde2 === 6,
      `aterrizó en el índice ${donde2} (se esperaba 6): el que aún no ha enviado tiene que ` +
      'poder llegar a enviar su parte, no encontrarse la solicitud cerrada')) return c
    await desbloquear(page)
    if (!await conducirEnvio(c, page)) return c
    await page.waitForTimeout(LATENCY + 1200)

    const cerrado = await page.evaluate(() => !/RobotDosE2E/.test(document.body.innerText || ''))
    c.evidencia.elementos += 1
    c.afirmar('con las dos partes enviadas ya no se dice que falte nadie',
      cerrado,
      'tras enviar el segundo tutor la confirmación sigue diciendo que falta alguien: la ' +
      'solicitud nunca pasaría a revisión')
  } finally {
    scenario.partes = 'unica'
  }
  return c
}

/**
 * DL-E49 §2 — CADA TUTOR VE LO SUYO Y LO DE LOS MENORES, NUNCA LO DEL OTRO TUTOR.
 *
 * El caso que lo justifica (Diego): una madre que se ha ido de casa y cuyo domicilio o
 * teléfono no puede acabar en un formulario que abre su expareja. La pantalla de
 * Revisión (Paso 7, `stage: 'lista_para_enviar'`) es donde el hallazgo de mayor
 * severidad vivía: pintaba nombre, DNI, dirección, email y teléfono de LOS DOS tutores,
 * sin importar cuál de los dos abrió el enlace.
 *
 * El recorte real vive en el SERVIDOR (`enr_wizardPersonasVisiblesParaTutor_`,
 * kis-app/kms-server/enr/wizard-datalayer.gs + su espejo `buildResumeSessionData_` del
 * wizard) — este camino no puede ejercitar ESE código (la batería corre contra un mock),
 * pero SÍ puede ejercitar el contrato: si el `hydrateSession` que recibe la pantalla ya
 * viene recortado (como lo estaría en producción), ¿la pantalla respeta ese recorte o
 * asume por su cuenta que hay dos tutores y rompe/inventa datos? El mock
 * (`recortarPorTutorE2E_`) aplica el MISMO criterio que el servidor real, así que un
 * cambio futuro que vuelva a mandar el grupo entero sin filtrar (regresión del lado
 * servidor) NO lo cazaría este camino — pero uno que asuma en el cliente "siempre hay 2
 * tarjetas de tutor" sí, y es justo la clase de regresión que dejaría el recorte del
 * servidor sin efecto.
 */
/**
 * DL-E49 §3 — LAS DECLARACIONES DE LA FAMILIA DE UN SOLO TUTOR LLEGAN AL LIBRO, CON SU TEXTO.
 *
 * Qué mide, y por qué importa: una familia monoparental declara dos cosas distintas —que es el
 * único tutor y que ostenta la patria potestad— y esas declaraciones existen para PROTEGER
 * LEGALMENTE A LA ESCUELA. Lo que las hace valer no es una casilla marcada: es que conste el
 * TEXTO EXACTO que la familia leyó al aceptarlas. Antes de este cambio la marca se escribía en
 * cuatro columnas que NO LEÍA NADIE (medido: cero lectores en los dos repositorios) y que puede
 * que ni existan ⇒ la declaración no quedaba registrada en ninguna parte.
 *
 * Este camino entra como familia de UN tutor, marca las dos casillas, envía, y comprueba en el
 * envío REAL que las dos declaraciones viajan con el texto que se pintó en pantalla.
 */
async function caminoDeclaracionesTutorUnico(page, base) {
  const c = new Camino('declaraciones-tutor-unico')
  // Expediente COMPLETO a propósito: así el recorrido de vuelta a Personas y de ida a
  // Revisión no se queda atrapado rellenando pasos intermedios, y lo que se mide es lo que
  // este camino existe para medir — que las declaraciones llegan al envío.
  scenario.stage = 'lista_para_enviar'
  scenario.tutorUnico = true

  let envio = null
  const espiar = (req) => {
    if (!/\/__gas/.test(req.url())) return
    let body = null
    try { body = JSON.parse(req.postData() || '{}') } catch { return }
    if (body && body.action === 'submitEnrollmentSession') envio = body
  }
  page.on('request', espiar)
  const limpiar = () => { page.off('request', espiar); scenario.tutorUnico = false }

  try {
    if (!await entrarPorElEnlace(c, page, base)) return c
    // Retroceder hasta Personas (índice 1), como haría la familia. Copiado de
    // `caminoQuitarDeLaSolicitud` — mismo recorrido, mismo botón.
    for (let i = 0; i < 8 && (await dondeEstoy(page)) > 1; i++) {
      const atras = await page.$('button.btn-secondary-kis:not(:has(i.bi-pencil))')
      if (!atras) break
      await atras.click()
      await page.waitForTimeout(250)
    }
    if (!c.afirmar('se llega al paso de Personas', (await dondeEstoy(page)) === 1,
      `se quedó en el índice ${await dondeEstoy(page)}`)) return c
    await desbloquear(page)
    await page.waitForTimeout(250)

    // Las dos casillas SOLO se pintan con un tutor. Si no están, o el recorte de personas
    // dejó más de un tutor o la pantalla dejó de pedir las declaraciones: las dos cosas son
    // el fallo que este camino busca, y por eso se afirma antes de tocar nada.
    const casillas = await page.$$('.alert-warning input[type=checkbox]')
    c.evidencia.elementos = Math.max(c.evidencia.elementos || 0, casillas.length)
    if (!c.afirmar('la familia de un solo tutor ve las DOS declaraciones (tutor único + patria potestad)',
      casillas.length === 2,
      `se pintaron ${casillas.length} casillas de declaración (se esperaban 2): sin ellas la familia envía sin declarar nada y la escuela se queda sin el registro que DL-E49 §3 exige`)) return c

    // El TEXTO que se pinta es el que tiene que acabar en el libro: se lee de la pantalla,
    // no se reconstruye aquí — si se reconstruyera, el camino aprobaría un texto que la
    // familia nunca vio, que es justo lo que invalida un registro legal.
    const textos = await page.$$eval('.alert-warning label span', (ss) => ss.map(s => (s.textContent || '').trim()))
    await casillas[0].click()
    await casillas[1].click()
    await page.waitForTimeout(150)

    // Avanzar hasta Revisión y enviar.
    for (let i = 0; i < 8 && (await dondeEstoy(page)) < 6; i++) {
      if (!await continuar(c, page, (await dondeEstoy(page)) + 1, 'avanzar hacia Revisión')) break
    }
    if (!c.afirmar('se llega a Revisión', (await dondeEstoy(page)) === 6,
      `se quedó en el índice ${await dondeEstoy(page)}`)) return c
    await desbloquear(page)
    await page.waitForTimeout(200)

    const marcarYEnviar = await page.evaluate(() => {
      document.querySelectorAll('input[type=checkbox]').forEach(ch => { if (!ch.checked) ch.click() })
      const firma = document.querySelector('input[type=text]')
      if (firma) {
        const setter = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
        setter.call(firma, 'RobotUnoE2E PruebaE2E')
        firma.dispatchEvent(new Event('input', { bubbles: true }))
      }
      const btn = [...document.querySelectorAll('button')].find(b => /enviar|submit/i.test(b.textContent || ''))
      if (btn && !btn.disabled) { btn.click(); return true }
      return false
    })
    if (!c.afirmar('el botón de enviar está disponible y se pulsa', marcarYEnviar,
      'no se encontró un botón de enviar habilitado en Revisión')) return c
    await page.waitForTimeout(LATENCY + 1200)

    if (!c.afirmar('el envío sale de verdad', !!envio,
      'no se registró ninguna llamada a submitEnrollmentSession')) return c

    const decl = (envio.consents || []).filter(x => x && /sole_guardian_attestation|parental_authority/.test(x.type || ''))
    c.evidencia.llamadas = Math.max(c.evidencia.llamadas || 0, 1)
    c.afirmar('las DOS declaraciones viajan en el envío, hacia el libro de consentimientos',
      decl.length === 2,
      `el envío llevó ${decl.length} declaración(es) de las 2 esperadas: lo que no viaja aquí no se registra en ninguna parte — vuelve a ser la casilla suelta que nadie lee`)
    c.afirmar('cada declaración lleva el TEXTO EXACTO que se mostró en pantalla',
      decl.length === 2 && decl.every(d => d.consent_text_shown && textos.includes(d.consent_text_shown)),
      `los textos enviados fueron ${JSON.stringify(decl.map(d => d.consent_text_shown))} y en pantalla se leyeron ${JSON.stringify(textos)}: un registro legal sin el texto que la familia leyó no prueba qué aceptó`)
    c.afirmar('las dos declaraciones van como ACEPTADAS',
      decl.length === 2 && decl.every(d => d.accepted === true),
      `se enviaron con accepted=${JSON.stringify(decl.map(d => d.accepted))}`)

    return c
  } finally {
    limpiar()
  }
}

async function caminoSegundoTutorNoVeAlPrimero(page, base) {
  const c = new Camino('segundo-tutor-no-ve-al-primero')
  scenario.stage = 'lista_para_enviar'   // aterriza en Revisión: ahí vivía la fuga mayor

  const leerNombres = () => page.evaluate(() => {
    const txt = document.body.innerText || ''
    return {
      len: txt.length,
      veUno: /RobotUnoE2E/.test(txt),
      veDos: /RobotDosE2E/.test(txt),
      // El icono `bi-person-fill` es EXCLUSIVO de la tarjeta de tutor en Step7Review
      // (el aplicante usa `bi-person-hearts`) — cuenta cuántas tarjetas de TUTOR se pintaron.
      tarjetasTutor: document.querySelectorAll('.kis-card i.bi-person-fill').length,
    }
  })

  // ── 1 · Entra el primer tutor (el enlace de siempre) ─────────────────────────
  if (!await entrarPorElEnlace(c, page, base)) return c
  await page.waitForTimeout(LATENCY + 700)
  const donde1 = await dondeEstoy(page)
  if (!c.afirmar('el primer tutor aterriza en Revisión', donde1 === 6,
    `aterrizó en el índice ${donde1} (se esperaba 6): sin llegar a Revisión no hay nada que comprobar`)) return c
  await desbloquear(page)

  const vista1 = await leerNombres()
  c.evidencia.elementos = Math.max(c.evidencia.elementos || 0, vista1.tarjetasTutor)
  c.afirmar('el primer tutor ve SU PROPIO nombre',
    vista1.veUno,
    'la pantalla de Revisión no muestra el nombre del tutor que la está mirando — algo más grave que la fuga que este camino busca')
  c.afirmar('el primer tutor NO ve el nombre del OTRO tutor',
    !vista1.veDos,
    'la pantalla de Revisión sigue mostrando el nombre del segundo tutor a quien no lo es — la fuga que DL-E49 §2 vino a cerrar sigue abierta')

  // ── 2 · Entra el segundo tutor, mismo grupo, SU PROPIO email_id ──────────────
  if (!await entrarPorElEnlace(c, page, base, { nOverride: FIXTURE.emailId2 })) return c
  await page.waitForTimeout(LATENCY + 700)
  const donde2 = await dondeEstoy(page)
  if (!c.afirmar('el segundo tutor también aterriza en Revisión', donde2 === 6,
    `aterrizó en el índice ${donde2} (se esperaba 6)`)) return c
  await desbloquear(page)

  const vista2 = await leerNombres()
  c.evidencia.elementos += vista2.tarjetasTutor
  c.afirmar('el segundo tutor ve SU PROPIO nombre',
    vista2.veDos,
    'la pantalla de Revisión no muestra el nombre del segundo tutor cuando es él quien mira')
  c.afirmar('el segundo tutor NO ve el nombre del PRIMER tutor',
    !vista2.veUno,
    'la pantalla de Revisión muestra el nombre del primer tutor al segundo — el caso concreto de Diego: el domicilio de una madre acabaría en la pantalla que abre su expareja')
  c.afirmar('cada tutor ve EXACTAMENTE una tarjeta de tutor, nunca dos',
    vista1.tarjetasTutor === 1 && vista2.tarjetasTutor === 1,
    `tarjetas vistas por el primero=${vista1.tarjetasTutor}, por el segundo=${vista2.tarjetasTutor} (se esperaba 1 y 1): si alguno ve dos, el recorte del servidor no llegó a esta pantalla`)

  return c
}

/**
 * CAMINO · «el teléfono que se ve es el que se guarda» (cola 18.bis.21).
 *
 * EL DEFECTO, medido el 2026-08-09: el número que la familia teclea vive en el estado del
 * control (país del desplegable + número nacional del input) y solo llegaba a guardarse al
 * SALIR del campo Y si la validación decía «válido». La puerta del paso 2 juzgaba lo
 * PERSISTIDO — vacío justo en el caso que falla. Consecuencias:
 *   · ALUMNO: el teléfono desaparecía SIN UNA PALABRA (la regla de «≥1 válido» solo mira a
 *     los tutores, y el bucle `if (raw && !valid)` no entraba porque `raw` era '').
 *   · TUTOR: se le decía «falta un teléfono» con el número escrito y visible en pantalla, y
 *     sin decir de cuál de los dos tutores hablaba.
 *
 * Este camino mide las TRES cosas desde la pantalla: que no se pasa de largo, que el aviso
 * nombra a la persona y el motivo REAL, y que al corregirlo el número SALE hacia el
 * servidor. No mide el envío: eso lo cubre `caminoDeclaracionesTutorUnico`.
 */
async function caminoTelefonoQueSeVeSeGuarda(page, base) {
  const c = new Camino('telefono-que-se-ve-se-guarda')
  scenario.stage = 'hasta_preguntas'

  // Se espía el guardado del paso: es donde se demuestra que lo escrito llegó a viajar.
  let ultimoPersons = null
  const espiar = (req) => {
    if (!/\/__gas/.test(req.url())) return
    let body = null
    try { body = JSON.parse(req.postData() || '{}') } catch { return }
    if (body && body.action === 'saveStep' && body.step === 'persons') ultimoPersons = body
  }
  page.on('request', espiar)
  const limpiar = () => page.off('request', espiar)

  // ── Utillaje de pantalla: se opera sobre la ÚLTIMA sección (un alumno) y sobre la
  //    PRIMERA (el tutor que está mirando). Ambas por posición en el DOM, sin inventar
  //    selectores nuevos: `.dynamic-section` es lo que pinta `PersonSection`.
  const seccion = async (cual) => {
    const ss = await page.$$('.dynamic-section')
    if (!ss.length) return null
    return cual === 'ultima' ? ss[ss.length - 1] : ss[0]
  }
  const añadirTelefonoEn = async (cual) => {
    const s = await seccion(cual)
    if (!s) return false
    const botones = await s.$$('button.add-btn')
    for (const b of botones) {
      const txt = (await b.evaluate(n => n.textContent || '')).trim()
      if (/tel[eé]fono|phone/i.test(txt)) { await b.click(); await page.waitForTimeout(150); return true }
    }
    return false
  }
  const escribirTelefonoEn = async (cual, valor) => {
    const s = await seccion(cual)
    if (!s) return false
    const input = await s.$('input[type=tel]')
    if (!input) return false
    await input.fill(valor)            // teclea de verdad: dispara el onChange de React
    await page.keyboard.press('Tab')   // y sale del campo, como haría la familia
    await page.waitForTimeout(200)
    return true
  }
  /** Pulsa Continuar y devuelve {avanzo, queja} SIN hacer fallar el camino. */
  const intentarContinuar = async (desde) => {
    const botones = await page.$$(BTN_SIGUIENTE)
    if (!botones.length) return { avanzo: false, queja: '(no había botón Continuar)' }
    await botones[0].click()
    await page.waitForTimeout(600)
    const donde = await dondeEstoy(page)
    return { avanzo: donde !== desde, donde, queja: await quejaDelWizard(page) }
  }

  try {
    if (!await entrarPorElEnlace(c, page, base)) return c
    // Retroceder hasta Personas (índice 1), como la familia. Copiado de
    // `caminoQuitarDeLaSolicitud` — mismo recorrido, mismo botón.
    for (let i = 0; i < 8 && (await dondeEstoy(page)) > 1; i++) {
      const atras = await page.$('button.btn-secondary-kis:not(:has(i.bi-pencil))')
      if (!atras) break
      await atras.click()
      await page.waitForTimeout(250)
    }
    if (!c.afirmar('se llega al paso de Personas', (await dondeEstoy(page)) === 1,
      `se quedó en el índice ${await dondeEstoy(page)}`)) return c
    await desbloquear(page)
    await page.waitForTimeout(200)

    const pantalla = await page.evaluate(sondaPantalla)
    c.evidencia.elementos = pantalla.pasos + pantalla.campos

    // ── (a) EL ALUMNO — un número escrito que no se puede guardar NO pasa de largo ──
    if (!c.afirmar('el alumno ofrece añadir un teléfono', await añadirTelefonoEn('ultima'),
      'no se encontró el botón de añadir teléfono en la última persona: sin él no se puede medir nada')) return c
    if (!c.afirmar('se puede teclear el teléfono del alumno', await escribirTelefonoEn('ultima', '123'),
      'no apareció el campo de teléfono tras añadirlo')) return c

    const tras1 = await intentarContinuar(1)
    c.afirmar('un teléfono escrito que NO se puede guardar frena el paso también en un ALUMNO',
      !tras1.avanzo,
      `el asistente avanzó al índice ${tras1.donde} con un número escrito en pantalla que no se guarda: la familia lo ve al teclearlo y ya no está cuando vuelve — el dato se pierde en silencio`)
    c.afirmar('y el aviso dice DE QUIÉN habla',
      /alumno|solicitante|applicant|student/i.test(tras1.queja || ''),
      `el aviso fue «${tras1.queja}»: sin nombrar a la persona, una familia con dos hijos no sabe cuál revisar`)
    c.afirmar('y dice que el problema es el número ESCRITO, no que falte',
      /no es v[aá]lido|isn't valid|falta elegir el pa[ií]s|country is missing/i.test(tras1.queja || ''),
      `el aviso fue «${tras1.queja}»: decir «falta un teléfono» con el número delante es lo que dejaba a la familia sin saber qué corregir`)

    // ── (b) CORREGIDO — se avanza Y el número VIAJA hacia el servidor ───────────────
    if (!c.afirmar('se puede corregir el teléfono del alumno', await escribirTelefonoEn('ultima', '600123456'),
      'no se pudo reescribir el campo de teléfono')) return c
    const tras2 = await intentarContinuar(1)
    if (!c.afirmar('con el teléfono corregido el paso avanza', tras2.avanzo,
      `siguió sin avanzar; el asistente dice: «${tras2.queja}»`)) return c
    await page.waitForTimeout(LATENCY + 900)

    if (!c.afirmar('el paso se guarda', !!ultimoPersons,
      'no salió ningún saveStep de personas tras avanzar')) return c
    c.evidencia.llamadas += 1
    const personasEnviadas = Array.isArray(ultimoPersons.payload) ? ultimoPersons.payload : []
    const telefonos = personasEnviadas.flatMap(p => (p.phones || []).map(ph => String(ph.value || ph.phone_number || '')))
    c.afirmar('el número escrito en pantalla es el que VIAJA hacia el servidor',
      telefonos.some(v => v.replace(/\D/g, '').endsWith('600123456')),
      `los teléfonos enviados fueron ${JSON.stringify(telefonos)}: lo que se ve y lo que se guarda siguen siendo cosas distintas`)
    c.afirmar('y viaja NORMALIZADO, con su prefijo internacional (DL-E40)',
      telefonos.some(v => /^\+\d{7,15}$/.test(v) && v.replace(/\D/g, '').endsWith('600123456')),
      `los teléfonos enviados fueron ${JSON.stringify(telefonos)}: sin el prefijo el KMS lo rechaza más tarde`)
    c.afirmar('lo que es SOLO de pantalla no se manda al servidor',
      personasEnviadas.every(p => (p.phones || []).every(ph => ph._escrito === undefined && ph._pais === undefined)),
      'los campos de borrador de la pantalla (_escrito/_pais) llegaron al servidor: son estado de la interfaz, no datos de la familia')

    // ── (c) EL TUTOR — el aviso deja de decir «falta» y nombra al tutor ─────────────
    for (let i = 0; i < 8 && (await dondeEstoy(page)) > 1; i++) {
      const atras = await page.$('button.btn-secondary-kis:not(:has(i.bi-pencil))')
      if (!atras) break
      await atras.click()
      await page.waitForTimeout(250)
    }
    if (!c.afirmar('se vuelve al paso de Personas', (await dondeEstoy(page)) === 1,
      `se quedó en el índice ${await dondeEstoy(page)}`)) return c
    await desbloquear(page)
    await page.waitForTimeout(200)
    if (!c.afirmar('se puede reescribir el teléfono del tutor', await escribirTelefonoEn('primera', '123'),
      'la primera persona no tiene campo de teléfono')) return c

    const tras3 = await intentarContinuar(1)
    c.afirmar('un teléfono de tutor escrito y no guardable frena el paso', !tras3.avanzo,
      `avanzó al índice ${tras3.donde} con el teléfono del tutor sin guardar`)
    c.afirmar('el aviso del tutor dice DE QUÉ TUTOR habla',
      /tutor\s*\d|guardian\s*\d/i.test(tras3.queja || ''),
      `el aviso fue «${tras3.queja}»: con dos tutores, no decir cuál obliga a revisarlos todos`)
    c.afirmar('y no le dice «falta un teléfono» teniéndolo escrito delante',
      /no es v[aá]lido|isn't valid|falta elegir el pa[ií]s|country is missing/i.test(tras3.queja || ''),
      `el aviso fue «${tras3.queja}»: el número está escrito y visible — decir que falta es exactamente lo que desconcertaba a la familia`)

    // ── (d) CORREGIR un teléfono QUE YA ESTABA GUARDADO también llega al servidor ───
    // Caso distinto del (b): el del tutor VIENE del servidor, así que su fila ya trae el
    // número viejo. El transformador se quedaba con ese viejo («solo si no hay valor»),
    // de modo que corregir un teléfono existente no salía NUNCA — la pantalla enseñaba el
    // nuevo y el expediente guardaba el de antes.
    ultimoPersons = null
    if (!c.afirmar('se puede corregir el teléfono del tutor', await escribirTelefonoEn('primera', '600999888'),
      'no se pudo reescribir el campo de teléfono del tutor')) return c
    const tras4 = await intentarContinuar(1)
    if (!c.afirmar('con el teléfono del tutor corregido el paso avanza', tras4.avanzo,
      `siguió sin avanzar; el asistente dice: «${tras4.queja}»`)) return c
    await page.waitForTimeout(LATENCY + 900)
    if (!c.afirmar('el paso se vuelve a guardar', !!ultimoPersons,
      'no salió ningún saveStep de personas tras corregir el teléfono del tutor: lo que se iba a mandar era IDÉNTICO a lo ya guardado, o sea que la corrección no llegó siquiera a formar parte del envío')) return c
    c.evidencia.llamadas += 1
    const tras4Personas = Array.isArray(ultimoPersons.payload) ? ultimoPersons.payload : []
    const tras4Telefonos = tras4Personas.flatMap(p => (p.phones || []).map(ph => String(ph.value || ph.phone_number || '')))
    c.afirmar('corregir un teléfono YA GUARDADO llega al servidor (no se queda el viejo)',
      tras4Telefonos.some(v => v.replace(/\D/g, '').endsWith('600999888')),
      `los teléfonos enviados fueron ${JSON.stringify(tras4Telefonos)}: se mandó el número ANTERIOR — la familia corrige su teléfono, ve el nuevo en pantalla, y el colegio sigue llamando al viejo`)

    return c
  } finally {
    limpiar()
  }
}

const CAMINOS = [
  { nombre: 'alta-nueva',          fn: caminoAltaNueva,          minLlamadas: 1, minElementos: 1 },
  { nombre: 'ack-indistinguible',  fn: caminoAckIndistinguible,  minLlamadas: 1, minElementos: 2 },
  { nombre: 'recuperar-aterrizar', fn: caminoRecuperarAterrizar, minLlamadas: 1, minElementos: 11 },
  { nombre: 'guardar-paso',        fn: caminoGuardarPaso,        minLlamadas: 1, minElementos: 11 },
  // ①31 — la familia que se incorpora a mitad de curso no puede quedarse encerrada en el paso 1.
  { nombre: 'fecha-a-mitad-de-curso', fn: caminoFechaAMitadDeCurso, minLlamadas: 1, minElementos: 11 },
  { nombre: 'subir-documento',     fn: caminoSubirDocumento,     minLlamadas: 1, minElementos: 1 },
  // Solo en real: rellena 2-7, admite el expediente y lee de vuelta los once pasos. Va
  // ANTES del tramo de firma porque es lo que lo destapa (sin `AD` no hay firma que pintar).
  ...(REAL ? [{ nombre: 'expediente-completo', fn: caminoExpedienteCompleto, minLlamadas: 8, minElementos: 11 }] : []),
  { nombre: 'tramo-firma',         fn: caminoTramoFirma,         minLlamadas: 1, minElementos: 11 },
  // Ejercita el paso 4 DESDE LA PANTALLA también en simulado. Nació para contestar, sin
  // gastar una corrida de 35 min, si el `0 de 1` de la salud contra el sistema real era
  // del producto o del conductor. Se queda: era cobertura que faltaba.
  { nombre: 'salud-desde-la-pantalla', fn: caminoSaludDesdeLaPantalla, minLlamadas: 1, minElementos: 11 },
  // Defecto 3 de la definición de hecho: el cuestionario se apagaba entero, en silencio
  // y durante media hora, por un fallo pasajero del servidor. Ver el camino.
  { nombre: 'cuestionario-no-se-apaga', fn: caminoCuestionarioNoSeApaga, minLlamadas: 1, minElementos: 2 },
  // Cola 18.quater — la familia pide corregir su solicitud ya enviada.
  { nombre: 'pedir-correccion',    fn: caminoPedirCorreccion,    minLlamadas: 2, minElementos: 11 },
  { nombre: 'quitar-de-la-solicitud', fn: caminoQuitarDeLaSolicitud, minLlamadas: 1, minElementos: 11 },
  // Cola 18.bis.25 — lo que la familia escribió sigue ahí cuando vuelve.
  { nombre: 'respuestas-vuelven', fn: caminoRespuestasVuelven, minLlamadas: 1, minElementos: 11 },
  // Lo que la familia SUBIÓ sigue ahí cuando vuelve (síntoma de Diego, 2026-08-09).
  // Contra el sistema real el recorrido se declara NO CUBIERTO y sale sin tocar la
  // pantalla (el código de un solo uso llega a un buzón que el arnés no lee), así que
  // ahí no se le puede exigir evidencia pintada: se exigiría por algo que se declaró
  // que no se hace, y el veredicto acusaría al producto de una carencia del arnés.
  { nombre: 'documentos-vuelven', fn: caminoDocumentosVuelven,
    minLlamadas: REAL ? 0 : 1, minElementos: REAL ? 0 : 3 },
  // DL-E49 §1 — el envío es POR TUTOR: quien termina envía su parte, y la solicitud solo
  // pasa a revisión cuando han enviado todos.
  { nombre: 'segundo-tutor-envia', fn: caminoSegundoTutorEnvia, minLlamadas: 2, minElementos: 2 },
  // DL-E49 §2 — cada tutor ve LO SUYO y lo de los menores, nunca lo del otro tutor.
  { nombre: 'segundo-tutor-no-ve-al-primero', fn: caminoSegundoTutorNoVeAlPrimero, minLlamadas: 2, minElementos: 2 },
  // DL-E49 §3 — las declaraciones de la familia de un solo tutor llegan al libro con su texto.
  { nombre: 'declaraciones-tutor-unico', fn: caminoDeclaracionesTutorUnico, minLlamadas: 1, minElementos: 2 },
  // Cola 18.bis.21 — lo que se ve en pantalla y lo que se guarda dejan de diferir.
  { nombre: 'telefono-que-se-ve-se-guarda', fn: caminoTelefonoQueSeVeSeGuarda, minLlamadas: 1, minElementos: 11 },
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
    // ── El reset se REPITE una vez si quedó algo, y no es cautela ────────────────────
    // MEDIDO el 2026-08-04 (corrida de las 13:18): el reset barrió y AUN ASÍ quedó 1 grupo,
    // porque otra sesión creó su expediente de prueba —con el mismo marcador `+robot-`—
    // MIENTRAS el reset corría. El barrido tarda minutos: es una ventana de carrera real,
    // no una rareza. Repetirlo una vez la cierra sin aflojar el invariante: se sigue
    // EXIGIENDO cero al final, solo se da una segunda pasada antes de rendirse.
    let rst = sonda('manual_resetFamiliaRobot')
    let r0 = rst.ok ? (rst.resultado || {}) : {}
    if (rst.ok && r0.veredicto !== 'VERDE') {
      console.log(`[robot] reset:    quedaba algo (${(r0.fallos || []).join(' | ')}) — segunda pasada`)
      rst = sonda('manual_resetFamiliaRobot')
      r0 = rst.ok ? (rst.resultado || {}) : {}
    }
    if (!rst.ok) {
      server.close()
      printVerdict(false, `no se pudo dejar el sistema a cero antes de empezar: ${rst.error}`)
      process.exit(1)
    }
    if (r0.veredicto !== 'VERDE') {
      server.close()
      printVerdict(false, `el reset previo no dejó el sistema a cero ni en la segunda pasada: ${(r0.fallos || []).join(' | ')} — si otra sesión está creando expedientes del robot a la vez, hay que esperarla: dos corridas sobre el mismo tenant se comen los turnos de cola la una a la otra`)
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
    // ── Sandbox sin egreso, PERO con inventario ─────────────────────────────────────
    // Se aborta TODO lo externo, igual que antes. Lo que cambia (encargo 08) es que ya
    // no se aborta A CIEGAS: cada URL abortada queda registrada por ORIGEN y el runner
    // la imprime al final, de modo que se pueda AFIRMAR —y no suponer— qué se le está
    // quitando a la página.
    //
    // MEDIDO el 2026-08-04, y por eso NO se levanta ninguna excepción: lo único que se
    // aborta es de TERCEROS y ninguna de esas peticiones la necesita la aplicación para
    // funcionar (fuente e iconos de CDN, favicon, reCAPTCHA, eco de IP best-effort del
    // acto de firma). Todo lo que la aplicación SÍ necesita va a `/__gas` en 127.0.0.1
    // y NUNCA entró en esta regla — o sea, el obstáculo que este encargo venía a quitar
    // no estaba aquí. Estaba en el DESMONTAJE (una petición de fondo en vuelo al cerrar
    // el camino), y se cerró esperando silencio de red antes de juzgar.
    //
    // ⚠️ Se PROBÓ sustituir la hoja de iconos por una local (para que los `<i>` tuvieran
    // caja y Playwright no los viese invisibles) y se REVIRTIÓ tras medirlo: esa hoja va
    // pineada con `integrity` en el HTML, así que el navegador BLOQUEA cualquier
    // sustituto —«Failed to find a valid digest in the integrity attribute»— y encima
    // añade un error de consola que el arnés cuenta como fallo. El remedio era peor.
    await context.route(/^https?:\/\/(?!127\.0\.0\.1|localhost)/, (r) => {
      try { const o = new URL(r.request().url()).origin; abortadas.set(o, (abortadas.get(o) || 0) + 1) } catch { /* URL rara */ }
      return r.abort()
    })
    const page = await context.newPage()

    const erroresConsola = []
    page.on('console', (msg) => {
      const t = msg.text()
      // Los `[DBG …]` del producto se CAPTURAN (no se cuentan como fallo) y luego se
      // sigue con la red de errores INTACTA: si alguno llegara como `error`, cuenta
      // igual. El logger emite `console.log('[ENR INFO] …', {objeto})` y `text()` rinde
      // ese objeto como «JSHandle@object», así que el 2.º argumento se resuelve aparte.
      if (t.includes('[DBG')) {
        const args = msg.args()
        void (async () => {
          let datos = ''
          try { if (args[1]) datos = JSON.stringify(await args[1].jsonValue()) } catch { /* la página ya no está */ }
          registrosDbg.push(`${t.replace(' JSHandle@object', '')} ${datos}`.slice(0, 900))
        })()
      }
      if (msg.type() !== 'error') return
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
    registrosDbg = []
    cuotaDelCamino = null
    transporteDelCamino = null
    degradacionesDelCamino = new Set()
    let c
    try {
      c = await def.fn(page, base)
    } catch (e) {
      c = new Camino(def.nombre)
      c.fallos.push(`el recorrido se rompió: ${String(e && e.message || e).slice(0, 240)}`)
    }

    // ── ANTES DE JUZGAR, DEJAR QUE EL FONDO TERMINE (2026-08-04, MEDIDO) ─────────────
    // `warmBundle` es precalentado best-effort que el cliente dispara en SEGUNDO PLANO. Si
    // el camino acaba con esa petición en vuelo, se aborta y el cliente escribe
    // `network/fetch error {message: Failed to fetch}` — que este bloque contaba como
    // fallo del producto. Medido en las corridas de las 10:03 y 10:24: tumbó
    // `recuperar-aterrizar` y `guardar-paso`, y en `ack-indistinguible` hizo que la
    // secuencia de llamadas difiriera (`conocido=[sendMagicLink]` ·
    // `desconocido=[sendMagicLink,warmBundle]`) — o sea, el arnés acusando al producto de
    // ruido que causaba él mismo al desmontar.
    // Esperar silencio de red antes de juzgar NO tapa nada: si la llamada de fondo falla de
    // verdad, su error llega igual; lo que desaparece es el aborto por desmontaje.
    if (REAL) await esperarSilencioDeRed(30000)

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
      // El error que el PROPIO ARNÉS provoca al perder el acuse de una acción cuyo efecto
      // se comprueba en la base: no es del producto. Se descuenta SOLO para la acción cuyo
      // acuse se perdió DE VERDAD en este recorrido — no hay lista blanca general.
      for (const a of degradacionesDelCamino) {
        if (t.includes(`gasCall ${a}:`)) return false
      }
      return true
    })
    if (degradacionesDelCamino.size) {
      c.notas.push(`    · acuse perdido por transporte (efecto comprobado en la base): ${[...degradacionesDelCamino].join(', ')}`)
    }

    // ── El servidor RECHAZA una escritura de la familia: eso se NOMBRA ────────────────
    // MEDIDO en la corrida de las 13:21: el navegador rellenó personas, vínculos y salud, el
    // wizard le dejó avanzar los tres pasos, y el servidor contestó `STEPUP_REQUIRED` a los
    // TRES `saveStep`. Sin esto, eso solo asomaba como «error de consola» — la forma más
    // fácil de leerlo por encima.
    //
    // ⚠️ CUIDADO CON A QUIÉN SE ACUSA. `STEPUP_REQUIRED` NO es un defecto del wizard: es su
    // verja de re-verificación (DL-E39) funcionando. La misma corrida lo demuestra — acto
    // seguido el cliente pidió un código (`sendVerificationCode`, `StepUpGate`), que es
    // exactamente lo que el producto debe hacer. Lo que falla es el ARNÉS: entra con la
    // gracia del magic-link, que es de UN SOLO USO y dura 10 min duros, y para cuando
    // conduce los pasos de PII esa ventana ya no está. El robot todavía no sabe pasar la
    // verja; mientras no sepa, esto es cobertura perdida y así se dice.
    // Solo en modo real: en simulado hay un escenario HOSTIL deliberado que devuelve error
    // a propósito, y contarlo aquí sería inventar un rojo.
    if (REAL) {
      const rechazos = calls.filter(x => x.respuesta && !x.respuesta.ok &&
        x.respuesta.codigo && !String(x.respuesta.codigo).startsWith('E2E_'))
      const porCodigo = {}
      for (const r of rechazos) (porCodigo[r.respuesta.codigo] = porCodigo[r.respuesta.codigo] || []).push(r.action)
      for (const [cod, acciones] of Object.entries(porCodigo)) {
        const detalle = `${acciones.length} llamada(s) —${[...new Set(acciones)].join(', ')}`
        if (cod === 'STEPUP_REQUIRED') {
          c.noCubierta('paso-conducido-tras-la-verja-de-re-verificacion',
            `el servidor exigió re-verificación (STEPUP_REQUIRED) en ${detalle}. NO es un defecto del wizard —` +
            ` es su verja DL-E39 haciendo su trabajo—, sino una carencia del ROBOT: entra con la gracia del` +
            ` magic-link (un solo uso, 10 min duros) y para cuando conduce los pasos de PII esa ventana ya no` +
            ` está. Lo que esos pasos escribieron NO se puede dar por bueno.`)
        } else {
          c.fallos.push(`el servidor RECHAZÓ ${detalle} con [${cod}]: la pantalla dejó avanzar igual, así que la familia creería que quedó guardado`)
        }
      }
    }
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
    // TRANSPORTE: el arnés no pudo LEER una respuesta. No se sabe qué hizo el servidor,
    // así que nada de lo que este recorrido observó después es atribuible al producto.
    c.transporte = transporteDelCamino
    resultados.push(c)

    const flag = (c.cuota || c.transporte) ? '⚠' : (c.fallos.length ? '✗' : '✓')
    console.log(`  ${flag} ${c.nombre}  (${totalLlamadas} llamadas, ${c.evidencia.elementos || 0} elementos)`)
    if (c.cuota) console.log(`      ⚠ CUOTA de Google (NO es defecto del camino): ${c.cuota}`)
    if (c.transporte) console.log(`      ⚠ TRANSPORTE del arnés roto (NO es defecto del camino): la respuesta de «${c.transporte.accion}» no se pudo leer [${c.transporte.codigo}] — ${c.transporte.mensaje}`)
    for (const n of c.notas)  console.log(`      ${n}`)
    // Toda respuesta que NO vino en verde se imprime, aunque el camino haya salido bien:
    // es la evidencia que convierte un rojo en diagnosticable sin repetir la corrida.
    const negativas = calls.filter(x => x.respuesta && !x.respuesta.ok)
    for (const x of negativas) {
      console.log(`      ↩ el servidor contestó ok=false a «${x.action}»${x.respuesta.codigo ? ` [${x.respuesta.codigo}]` : ' (sin código de error)'}${x.respuesta.motivo ? ` — ${x.respuesta.motivo}` : ''}${x.respuesta.claves ? ` — sin error de ninguna forma; claves de la respuesta: ${x.respuesta.claves}` : ''}`)
    }
    for (const f of c.fallos) console.log(`      ✗ ${f}`)
    for (const nc of c.noCubiertas) console.log(`      · NO CUBIERTA «${nc.etiqueta}»: ${nc.motivo}`)

    await context.close()
  }

  await browser.close()
  server.close()

  // ── Resumen ────────────────────────────────────────────────────────────────
  const conCuota      = resultados.filter(r => r.cuota)
  const conTransporte = resultados.filter(r => r.transporte && !r.cuota)
  const conFallo      = resultados.filter(r => r.fallos.length && !r.cuota && !r.transporte)
  console.log(`\n  caminos ejecutados:  ${resultados.length} de ${seleccionados.length}`)
  console.log(`  caminos en verde:    ${resultados.filter(r => !r.fallos.length && !r.cuota).length}`)
  console.log(`  caminos en rojo:     ${conFallo.length}`)
  if (conCuota.length) console.log(`  caminos por CUOTA:   ${conCuota.length}  (no son defecto del camino de inscripción)`)
  if (conTransporte.length) console.log(`  caminos por TRANSPORTE: ${conTransporte.length}  (el arnés no pudo leer la respuesta; no son defecto del camino)`)
  if (REAL) console.log(`  latencia real mín.:  ${idaYVueltaMin === Infinity ? 'n/d' : idaYVueltaMin + ' ms'}`)
  // Inventario del sandbox: qué se le quitó al navegador y qué se le fabricó.
  const inv = [...abortadas.entries()].sort((a, b) => b[1] - a[1]).map(([o, n]) => `${o}×${n}`)
  console.log(`  red externa:         ${inv.length ? inv.join('  ') : 'ninguna petición externa'}`)
  console.log('                       (todo lo de arriba es de TERCEROS; las llamadas de la aplicación van a /__gas en 127.0.0.1 y nunca se abortan)')
  if (CONDUCTORES.size) {
    console.log('\n  LOS ONCE PASOS — quién los condujo:')
    for (const [etiqueta, v] of CONDUCTORES) {
      const marca = v.estado === 'verde' ? '✓' : v.estado === 'rojo' ? '✗' : '·'
      console.log(`    ${marca} ${etiqueta.padEnd(30)} ${String(v.quien).padEnd(34)} ${v.estado}`)
    }
  }

  // Cobertura: lo no ejecutado exige motivo declarado; la lista no puede envejecer.
  const problemasCobertura = []
  for (const r of resultados) {
    const permitidas = NO_CUBIERTAS_PERMITIDAS[r.nombre] || {}
    for (const nc of r.noCubiertas) {
      if (!permitidas[nc.etiqueta]) {
        problemasCobertura.push(`${r.nombre} · «${nc.etiqueta}» quedó SIN cubrir (${nc.motivo}) y no está declarada en NO_CUBIERTAS_PERMITIDAS`)
      }
    }
    // «Declarada pero HOY sí se cubre» SOLO puede afirmarse de un camino que LLEGÓ AL
    // FINAL. Un camino que aborta a mitad (entrada fallida, transporte roto) nunca ejecuta
    // sus `noCubierta`, así que la ausencia no significa «ya se cubre»: significa que no
    // se llegó a mirar. MEDIDO: con la entrada rota, `tramo-firma` hacía que el robot
    // pidiera retirar «firma-consumada» — que es la no-cobertura MÁS legítima que tiene
    // (no se firma de verdad). Seguir ese consejo habría borrado una declaración honesta
    // y dejado el acto irreversible sin declarar. Un consejo derivado de un recorrido a
    // medias es peor que ningún consejo.
    const llegoAlFinal = !r.fallos.length && !r.cuota && !r.transporte
    if (llegoAlFinal) {
      for (const etiqueta of Object.keys(permitidas)) {
        const declaradaYCubierta = !r.noCubiertas.some(nc => nc.etiqueta === etiqueta)
        if (declaradaYCubierta) {
          problemasCobertura.push(`${r.nombre} · «${etiqueta}» está declarada como no cubierta pero HOY sí se cubre — retira la entrada de NO_CUBIERTAS_PERMITIDAS`)
        }
      }
    } else if (Object.keys(permitidas).length) {
      console.log(`      (cobertura de «${r.nombre}» no evaluada: el camino no llegó al final, así que «no la declaró» no prueba que se cubra)`)
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
  // TRANSPORTE antes que el rojo de producto, por el mismo motivo que la CUOTA: si el
  // arnés no pudo leer la respuesta, lo que el recorrido «observó» después no acusa a nadie.
  if (conTransporte.length) {
    const t = conTransporte[0].transporte
    printVerdict(false, `TRANSPORTE del arnés roto en ${conTransporte.length} camino(s) (${conTransporte.map(r => r.nombre).join(', ')}) — el doble salto de GAS no devolvió JSON al leer la respuesta de «${t.accion}» [${t.codigo}], así que NO se sabe qué hizo el servidor y NO es un defecto del camino de inscripción. Mensaje literal: ${t.mensaje}`)
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
