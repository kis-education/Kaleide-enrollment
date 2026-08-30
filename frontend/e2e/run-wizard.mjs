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
  'los-dos-pagadores': {
    // MEDIDO el 2026-08-27: con la excepción de D121 la pantalla enseña SIEMPRE a los dos
    // tutores, así que la rama de «un solo pagador» de SplitEditor —la que antes clavaba un
    // «100 %» que podía no ser el guardado— NO se alcanza por este camino. La barandilla SÍ
    // está construida (se pinta `suyo`%, el valor real) y su rojo se demostró aparte,
    // devolviendo el literal: «se leyó "100%…" con el 60 % guardado: la pantalla está
    // mintiendo». Se declara aquí para que la lista no envejezca en silencio.
    'cien-por-cien-mentiroso': 'con la excepción de D121 hay SIEMPRE dos pagadores en pantalla, así que la rama de «un solo pagador» no es alcanzable por este camino; su arreglo se acredita con la rotura demostrada, no aquí',
  },
}

// Añadidos SOLO en modo real: escenarios que el backend simulado puede fabricar y
// el sistema de verdad no. No son un perdón general — cada uno con su motivo, y la
// comprobación de "declarada pero HOY sí se cubre" sigue viva en ambos modos.
const NO_CUBIERTAS_SOLO_REAL = {
  'simulador-paso7': {
    'simulador-en-pie': 'guardar la forma de pago elegida exige el código de un solo uso, que el servidor manda al buzón de la familia y este arnés no lee buzones; en modo simulado sí se cubre',
    'simulador-caido': 'el escenario hostil (el simulador no responde) no se puede FORZAR sobre el backend de verdad sin desplegarle un cambio; en modo simulado sí se cubre',
  },
  'simulador-no-recalcula-al-navegar': {
    'no-recalcula-al-navegar': 'exige un expediente con plantillas de tarifa declaradas y contar las llamadas del navegador; contra el sistema real el arnés no puede sembrarlo',
  },
  'cuotas-no-llegan-no-se-miente': {
    'cuotas-cortadas': 'el escenario hostil (la simulación se corta sin dejar respuesta) no se puede FORZAR sobre el backend de verdad sin desplegarle un cambio; en modo simulado sí se cubre',
  },
  'simulador-paso7-varios-planes': {
    'varios-planes': 'exige declarar en el catálogo real dos plantillas de suscripción aplicables a la vez al mismo solicitante; en modo simulado sí se cubre',
  },
  'simulador-tras-enviar': {
    'simulador-tras-enviar': 'exige un expediente YA ENVIADO con plantillas de tarifa declaradas; el arnés no puede sembrarlo contra el sistema de verdad. En modo simulado sí se cubre',
  },
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
  // Cola 18.bis.84 — el trabajo APUNTADO. Hace falta que el trabajador de la cola del KMS
  // falle o descarte contenido a propósito, y eso no se puede pedir desde fuera sin dejar
  // datos a medias en un expediente real; en modo simulado sí se cubre.
  'guardado-apuntado-se-vigila': {
    'guardado-apuntado': 'exige que el trabajo encolado del KMS falle o descarte contenido a propósito; el arnés no puede provocarlo sobre el sistema real sin ensuciar el expediente',
  },
  // Cola 18.bis — el aviso rojo de guardado. Los dos caminos necesitan un guardado que
  // FALLE a voluntad, y eso solo lo puede fabricar el backend simulado
  // (`scenario.saveStepFails`). Contra el sistema real no hay forma honesta de tumbar un
  // guardado sin desplegarle un cambio al servidor de verdad; en modo simulado sí se cubre.
  'aviso-guardado-se-apaga': {
    'aviso-de-guardado': 'el fallo del guardado se pide con `scenario.saveStepFails`, una palanca del backend simulado; contra el sistema real no hay forma honesta de hacer fallar un guardado a voluntad',
  },
  'aviso-guardado-se-cierra': {
    'cierre-del-aviso': 'el fallo del guardado se pide con `scenario.saveStepFails`, una palanca del backend simulado; contra el sistema real no hay forma honesta de hacer fallar un guardado a voluntad',
  },
  // ②24.sexies — el servidor descarta el cuestionario del tutor que ya envió su parte.
  // El precalentado sin ruido — ver el camino: contra el sistema real pedir el enlace dos
  // veces manda dos correos y rota el token de los caminos que vienen detrás.
  'precalentado-sin-ruido': {
    'precalentado-sin-ruido': 'pedir el enlace dos veces contra el sistema real manda DOS correos y ROTA el resume_token, dejando sin token a los caminos que vienen detrás; en modo simulado sí se cubre',
  },
  'precalentado-fallo-se-registra': {
    'fallo-del-precalentado': 'el fallo del precalentado se pide con `scenario.warmFalla`, una palanca del backend simulado; contra el sistema real no hay forma honesta de tumbarlo a voluntad',
  },
  'respuestas-rechazadas-se-dicen': {
    'respuestas-rechazadas': 'exige un expediente real con un tutor que YA envió su parte y otro que sigue rellenando; el arnés no puede montar ese estado sin dejar datos a medias. En modo simulado sí se cubre, con la palanca `scenario.trabajoResultado = "invalidado"`.',
  },
  'ventana-por-inactividad': {
    'la-actividad-reinicia-el-contador': 'contra el sistema real la ventana son 10 minutos de RELOJ: comprobarla exigiría tener el robot 20 minutos tocando la pantalla, y el código llega a un buzón que este arnés no lee. En modo simulado sí se cubre, comprimiendo la ventana con `scenario.ventanaMs` (el cliente decide sobre el tiempo restante que le manda el servidor, así que la secuencia observada es la misma).',
    'sin-actividad-avisa-y-bloquea':     'misma razón',
    'con-actividad-no-hay-aviso':        'misma razón',
    'la-recarga-vuelve-a-pedir-codigo':  'misma razón: hace falta pasar la verja del código antes de poder recargar con la ventana viva',
    'el-pulso-no-alarga-nada':           'exige leer el tiempo restante dos veces seguidas de la MISMA marca; contra el real habría que esperar minutos entre lecturas y el resultado dependería del reloj de Google',
    'caducada-no-se-resucita':           'exige dejar caducar una ventana a propósito; contra el real son 10 minutos de espera por afirmación',
    'otra-huella-no-vale':               'exige fabricar peticiones con la huella de otra página y el buzón de otro tutor: contra el sistema real eso es exactamente lo que no se hace',
    'el-techo-avisa-por-seguridad':      'contra el sistema real el techo son DOS HORAS de reloj desde que se teclea el código: comprobarlo exigiría tener el robot dos horas tocando la pantalla. En modo simulado sí se cubre, comprimiendo el techo con `scenario.techoMs`.',
  },
  'codigo-sin-congelar': {
    'aviso-antes-que-la-respuesta': 'exige forzar la verja del código (dejar caducar la gracia del enlace) y cronometrar un viaje cuyo tiempo decide Google; en modo simulado sí se cubre, con `scenario.codigoDemoraMs`',
    'casilla-lista-sin-esperar':    'misma razón',
    'se-entra-sin-esperar':         'misma razón: además el código llega a un buzón que este arnés no lee',
    'el-fallo-sustituye-al-aviso':  'exige que el servidor RECHACE la petición del código; no se provoca contra datos reales. En modo simulado sí se cubre, con `scenario.codigoFalla`.',
    'reenviar-limitado-por-reloj':  'misma razón que las tres primeras',
  },
  'un-viaje-al-abrir': {
    'un-viaje-al-abrir': 'exige forzar la verja de datos personales (dejar caducar la gracia del enlace) para que el asistente se encuentre la respuesta CERRADA, que es la que producía el tropel; contra el sistema real eso pide un buzón que este arnés no lee. En modo simulado sí se cubre, con `scenario.piiGated`.',
  },
  'codigo-al-entrar-por-enlace': {
    'un-solo-codigo-al-entrar':        'exige forzar la verja del código (dejar caducar la gracia del enlace) y contar los envíos a un buzón que este arnés no lee; en modo simulado sí se cubre, con `scenario.piiGated`',
    'la-pantalla-dice-que-ya-se-envio': 'misma razón',
    'el-fallo-del-autoenvio-llega':    'exige que el servidor RECHACE la petición del código; no se provoca contra datos reales. En modo simulado sí se cubre, con `scenario.codigoFalla`.',
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
// `warmFalla`: el precalentado falla DE VERDAD (no "no había nada que calentar") — la
// otra mitad de `precalentado-sin-ruido`: un fallo real sigue registrándose.
// `codigoDemoraMs`/`codigoFalla`: la petición del código de un solo uso, LENTA y/o
// RECHAZADA — las dos palancas de `codigo-sin-congelar`. La demora la aplica el servidor
// de esta batería (abajo, en `startServer`), porque lo que se mide es CUÁNDO, no QUÉ.
const scenario = { stage: 'hasta_preguntas', magicLinkMode: 'constant', saveStepFails: false, preguntasMode: 'ok', correccionMode: 'ok', respuestasMode: 'ok', respuestasRechazadas: false, trabajoResultado: null, partes: 'unica', formatoFechasPrograma: 'iso', piiGated: false, otpSuperado: false, documentos: null, subidaNoRegistrada: false, warmFalla: false, simulacionFalla: false, codigoDemoraMs: 0, codigoFalla: null, ventanaViva: false, ventanaMs: 0, subidaDemoraMs: 0, variosProgramas: false, subidaPideCodigoUnaVez: false, vinculoHermanosInvertido: false, dosSolicitantes: false, unSoloAlumno: false, hidratacionCorta: 0, hidratacionRechazada: null, simulacionCorta: 0, saveStepDemoraMs: 0 }
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
        // ★ `0º.tricies.vicies.semel` — FALLO DE TRANSPORTE de verdad, no un `ok:false`.
        // El defecto que se mide es justamente el que NO deja respuesta que leer: el
        // `Load failed` del registro real de Diego (41,6 s) mientras el servidor sigue
        // trabajando. Un `{ok:false}` NO lo reproduce — llega con cuerpo y con código, y
        // el cliente lo clasificaría por otra rama. Así que se MATA el socket: el `fetch`
        // del navegador rechaza sin código, que es exactamente lo que pasó.
        // Es un CONTADOR: falla los N primeros intentos y deja pasar el siguiente, para
        // poder afirmar que el reintento entra con el MISMO enlace.
        if (scenario.hidratacionCorta > 0 && payload && payload.action === 'hydrateSession') {
          scenario.hidratacionCorta -= 1
          // Se REGISTRA aunque muera: sin esto los intentos cortados son invisibles y no se
          // podría afirmar que el reintento ocurrió — que es la mitad del arreglo.
          record({ action: payload.action, payload, cortada: true })
          try { req.socket.destroy() } catch { /* ya cerrado */ }
          return
        }
        // ⛔ `0º.tricies.vicies.sexies` — LO MISMO PARA LA SIMULACIÓN DE CUOTAS, y por el
        // mismo motivo. En el registro real de Diego (2026-08-26) `simularCuotas` salió y
        // el navegador la CORTÓ a los 240.000 ms sin respuesta: no es que no hubiera
        // cuotas, es que no llegaron. `scenario.simulacionFalla` NO reproduce eso — ésa
        // responde `simulable:false`, que es el servidor CONTESTANDO que este plan no
        // admite cuotas, y es un caso legítimo distinto. También es un CONTADOR, para
        // poder afirmar que el reintento entra.
        if (scenario.simulacionCorta > 0 && payload && payload.action === 'simularCuotas') {
          scenario.simulacionCorta -= 1
          record({ action: payload.action, payload, cortada: true })
          try { req.socket.destroy() } catch { /* ya cerrado */ }
          return
        }
        const out = dispatch(payload)
        // Latencia simulada: sin ella no se puede distinguir un avance optimista
        // de uno que espera al servidor. En real no se inyecta: ya tarda de verdad.
        //
        // ── UNA acción puede pedir MÁS demora que las demás ────────────────────────
        // `sendVerificationCode` tarda EN LA VIDA REAL mucho más que el resto (medido el
        // 2026-08-19 en el registro de Diego: 77 s de reloj), y ésa es justamente la
        // condición en la que se ve si la pantalla espera al servidor o no. Con la
        // latencia uniforme el margen era de 800 ms — demasiado estrecho para distinguir
        // «apareció antes de la respuesta» de «apareció justo después».
        // 0º.quindecies (segunda pieza) — `uploadDocument` puede pedir SU PROPIA demora
        // extra, igual que `sendVerificationCode`: es la única forma de dejar una subida
        // deliberadamente en vuelo el tiempo suficiente para forzar un latido a mitad y
        // comprobar que el pulso se aparta (ver `caminoSubirDocumento`).
        const extra = (payload && payload.action === 'sendVerificationCode')
          ? Number(scenario.codigoDemoraMs || 0)
          : (payload && payload.action === 'uploadDocument')
          ? Number(scenario.subidaDemoraMs || 0)
          // `0º.tricies.quintricies` — `saveStep` puede pedir SU PROPIA demora: es la única
          // forma de dejar una escritura EN VUELO el tiempo suficiente para comprobar que el
          // guardado disparado al ocultarse la pantalla ENTRA POR LA COLA y no la adelanta.
          // Sin eso, la comprobación del orden pasaría en vacío.
          : (payload && payload.action === 'saveStep')
          ? Number(scenario.saveStepDemoraMs || 0) : 0
        setTimeout(() => responder(out), LATENCY + extra)
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

/**
 * El PRECALENTADO no pinta un error cuando no había nada que calentar (2026-08-15).
 *
 * Tras pedir el enlace, la portada dispara el precalentado del bundle de entrada con un
 * ticket opaco que el servidor consume al PRIMER uso (single-use, 300 s). Que un segundo
 * intento —una recarga, una petición repetida, el ticket ya caducado— no encuentre nada
 * es lo NORMAL. El servidor lo contestaba con `{ok:false}` y el cliente lo trataba como
 * error del servidor: un ERROR ROJO en la consola de la familia («Unknown server error»,
 * porque tampoco había mensaje) para algo que fue bien. Quien lo mire concluye que el
 * asistente está roto cuando no lo está.
 *
 * Se afirma lo observable: pedir el enlace dos veces NO deja ni un error en la consola
 * (la red de errores del arnés lo exige: cualquier error no declarado tumba el camino) y
 * la pantalla sigue siendo la genérica. Y la otra mitad: cuando el precalentado falla DE
 * VERDAD, el fallo se sigue registrando — si dejara de hacerlo, el camino cae.
 *
 * ⚠️ LÍMITE, dicho: esto corre contra el backend SIMULADO, cuya rama de ticket está
 * copiada del contrato de `warmBundle_`; el `backend/Code.js` real NO se ejecuta aquí.
 * Lo que esta batería puede afirmar es que, con esa respuesta, la familia no ve ruido.
 *
 * ⚠️ Y VAN EN DOS CAMINOS SEPARADOS A PROPÓSITO — medido el 2026-08-15, no razonado. La
 * otra mitad («un fallo de verdad SÍ se registra») declara esperar el error de consola
 * `gasCall warmBundle: server returned ok=false`, y esa declaración vale para TODO el
 * camino, no para el tramo donde se escribe: metidas en el mismo camino, la declaración
 * de la segunda mitad SE TRAGA el error de la primera. Se comprobó rompiendo el simulado
 * a propósito (ticket gastado → `{ok:false}`, el contrato viejo): con las dos mitades
 * juntas el camino salió **VERDE** — o sea, la red no medía nada. Separadas, sale ROJO.
 */
async function caminoPrecalentadoSinRuido(page, base) {
  const c = new Camino('precalentado-sin-ruido')
  scenario.magicLinkMode = 'constant'

  // Contra el sistema REAL no se hace: pedir el enlace dos veces manda DOS correos de
  // verdad y ROTA el resume_token, dejando sin token a los caminos siguientes.
  if (REAL) {
    c.noCubierta('precalentado-sin-ruido',
      'pedir el enlace dos veces contra el sistema real manda DOS correos y ROTA el resume_token, dejando sin token a los caminos que vienen detrás; en modo simulado sí se cubre')
    return c
  }

  // DOS peticiones de enlace: el ticket del segundo precalentado ya está gastado.
  calls = []
  await rellenarPortada(page, base, DATOS.emailKnown)
  const pantalla = await rellenarPortada(page, base, DATOS.emailKnown)
  const precalentados = llamadas('warmBundle')

  c.evidencia.elementos = pantalla.tarjetas + (pantalla.sobreEnviado ? 1 : 0)
  c.afirmar('la portada dispara el precalentado las dos veces', precalentados.length >= 2,
    `se registraron ${precalentados.length} llamadas a warmBundle (se esperan 2)`)
  c.afirmar('la pantalla sigue siendo la genérica de "enlace enviado"', pantalla.sobreEnviado,
    'no apareció la confirmación genérica')
  c.afirmar('sin pantalla de error', !pantalla.errorFatal, 'el ErrorBoundary pintó "Something went wrong."')
  // La afirmación que de verdad muerde —CERO errores de consola— la exige el propio arnés:
  // cualquier error no declarado tumba el camino, y aquí NO se declara ninguno.
  return c
}

/**
 * La otra mitad: cuando el precalentado falla DE VERDAD, el fallo SIGUE registrándose.
 * «No había nada que calentar» se calla; «falló» no. Si el cliente dejara de registrarlo,
 * este camino cae solo (el arnés exige que el error declarado ocurra de verdad).
 */
async function caminoPrecalentadoFalloSeRegistra(page, base) {
  const c = new Camino('precalentado-fallo-se-registra')
  scenario.magicLinkMode = 'constant'

  if (REAL) {
    c.noCubierta('fallo-del-precalentado',
      'el fallo del precalentado se pide con `scenario.warmFalla`, una palanca del backend simulado; contra el sistema real no hay forma honesta de tumbarlo a voluntad')
    return c
  }

  c.esperarErrorConsola(/gasCall warmBundle: server returned ok=false/,
    'escenario deliberado: el precalentado falla de verdad; la app se lo traga de cara al usuario pero DEBE dejarlo registrado')
  calls = []
  scenario.warmFalla = true
  const pantalla = await rellenarPortada(page, base, DATOS.emailKnown)
  scenario.warmFalla = false

  c.evidencia.elementos = pantalla.tarjetas + (pantalla.sobreEnviado ? 1 : 0)
  c.afirmar('un fallo real del precalentado no rompe la pantalla', pantalla.sobreEnviado && !pantalla.errorFatal,
    'la pantalla cambió o el ErrorBoundary saltó cuando el precalentado falló')
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

/**
 * programa-se-recupera — EL PROGRAMA ELEGIDO SE VE AL VOLVER, Y DEJA AVANZAR
 * (`0º.tricies.bis`, Diego 2026-08-22: *«siempre que vuelvo al paso 1 sale "Selecciona un
 * programa…". De hecho, ahora he vuelto y no me deja avanzar al paso 2»*).
 *
 * ── El defecto que cierra, MEDIDO contra el sistema real ─────────────────────────────
 * El programa **SÍ se guarda** y **SÍ viaja**: la hidratación devuelve la fila entera del
 * expediente, con `program_id` y `desired_start_date` rellenos (comprobado con
 * `manual_diagCursoDelPaso7`/`manual_diagQueLlegaAlPaso1` sobre un expediente real). Lo que
 * fallaba es que **esta pantalla no lo leía**: tomaba `stepData.email.program_id`, y el
 * hidratador pone el programa en `stepData.application` —lo dice con todas las letras—, así
 * que ese campo era SIEMPRE `undefined`. Con UN solo programa no se notaba porque el
 * catálogo lo auto-elegía; con varios, el desplegable salía vacío, `canContinue` quedaba en
 * `false` y **la familia no podía pasar al paso 2**.
 *
 * ⛔ Por eso este camino sirve DOS programas (`scenario.variosProgramas`): con uno solo, la
 * afirmación pasaría en vacío gracias al auto-elegido, que es exactamente lo que escondió
 * el defecto durante semanas.
 */
async function caminoProgramaSeRecupera(page, base) {
  const c = new Camino('programa-se-recupera')
  scenario.stage = 'sin_fecha'        // sin fecha ⇒ aterriza en el paso 1
  scenario.variosProgramas = true

  try {
    if (!await entrarPorElEnlace(c, page, base)) return c
    await page.waitForTimeout(LATENCY + 600)

    const opciones = await page.$$eval('select option', os => os.map(o => o.value).filter(Boolean))
    c.evidencia.elementos = Math.max(c.evidencia.elementos || 0, opciones.length)
    if (!c.afirmar('el desplegable ofrece MÁS DE UN programa (si no, el auto-elegido lo tapa)',
      opciones.length >= 2,
      `el desplegable trajo ${opciones.length} opción(es): con una sola, «el programa se recupera» pasaría en vacío`)) return c

    const elegido = await page.$eval('select', el => el.value).catch(() => null)
    c.afirmar('el programa que la familia eligió SE VE marcado al volver',
      !!elegido && elegido !== '',
      `el desplegable quedó en ${JSON.stringify(elegido)}: la familia ve «Selecciona un programa…» y su elección se perdió de vista`)

    // El síntoma que Diego reportó: no es cosmético, es que NO SE PUEDE AVANZAR.
    //
    // ⛔ Se miran TODOS los botones de continuar, no el primero que casa: el paso pinta DOS
    // (el de la barra de arriba y el del final), los dos gateados por lo mismo, y quedarse
    // con uno dejaba pasar la rotura — medido: con el desplegable vacío esta afirmación
    // salía VERDE mirando solo el primero.
    const botones = await page.$$eval('button', bs => bs
      .filter(x => /continuar|continue/i.test(x.textContent || ''))
      .map(x => ({ txt: (x.textContent || '').trim().slice(0, 24), disabled: x.disabled })))
    if (!c.afirmar('el paso 1 pinta algún botón de continuar (si no, no hay nada que afirmar)',
      botones.length > 0, 'no se encontró ningún botón de continuar en el paso 1')) return c
    c.afirmar('con el programa recuperado, el paso 1 DEJA avanzar al paso 2',
      botones.every(b => b.disabled === false),
      `los botones de continuar quedaron ${JSON.stringify(botones)}: deshabilitado es justo lo que tenía parada a la familia`)
    return c
  } finally {
    scenario.variosProgramas = false
  }
}

/**
 * 2026-08-26 — «NO HAY PROGRAMAS» NO ES LO QUE SE DICE CUANDO NO SE PUDIERON CARGAR.
 *
 * Diego abrió su solicitud con DOS programas declarados y los dos con el plazo ABIERTO
 * (medido ese día con `manual_diagPlazoDeInscripcion`: «VERDE — 2 de 2») y el paso 1 le
 * dijo *«No hay programas de admisión disponibles en este momento»*, con el botón de
 * continuar gris. Su reacción, literal: *«lo que es rotundamente falso»*.
 *
 * ⛔ ANCLA por delante: si el paso 1 no llega a pintar su etiqueta de programa, este
 * recorrido no está midiendo nada y sale ROJO en vez de pasar en vacío.
 */
async function caminoProgramasNoSeInventan(page, base) {
  const c = new Camino('programas-no-se-inventan')
  scenario.stage = 'sin_fecha'          // sin fecha ⇒ aterriza en el paso 1
  scenario.catalogosMode = 'caido'      // ⇐ los DOS sitios que sirven catálogos
  // El escenario tira el catálogo A PROPÓSITO, así que la aplicación registra su fallo: eso
  // es lo correcto (§KAL-11), no un defecto. Lo que se mide es lo que la familia LEE.
  c.esperarErrorConsola(/gasCall fetchLookups: server returned ok=false/,
    'el catálogo está caído a propósito en este recorrido')

  try {
    if (!await entrarPorElEnlace(c, page, base)) return c
    await page.waitForTimeout(LATENCY + 900)

    const textoPaso = await page.evaluate(() => document.body.innerText)
    if (!c.afirmar('el paso 1 llegó a pintarse (si no, no hay nada que medir)',
      /Programa de admisi|Admission programme/i.test(textoPaso),
      'el paso 1 no pintó su etiqueta de programa')) return c

    c.evidencia.elementos = Math.max(c.evidencia.elementos || 0, 1)

    // (1) LA MENTIRA. Es la afirmación que importa.
    c.afirmar('con los catálogos caídos NO se afirma que el colegio no tenga programas',
      !/No hay programas de admisi|No admission programmes are available/i.test(textoPaso),
      'la pantalla dijo «no hay programas de admisión» con los catálogos CAÍDOS: eso es una '
      + 'afirmación falsa sobre la configuración del colegio, y deja a la familia sin nada que hacer')

    // (2) Y se dice lo que de verdad pasa.
    c.afirmar('se dice que no se pudieron cargar',
      /no hemos podido cargar los programas|could not load the admission programmes/i.test(textoPaso),
      `el texto leído fue ${JSON.stringify(textoPaso.slice(0, 200))}: sin decirlo, la familia no sabe si esperar, reintentar o irse`)

    // (3) Y hay por dónde salir.
    const hayReintento = await page.$$eval('button', bs => bs
      .some(x => /volver a intentarlo|try again/i.test(x.textContent || '')))
    if (!c.afirmar('se ofrece volver a intentarlo', hayReintento,
      'no se pintó ningún botón de reintentar: la familia se queda encallada sin salida')) return c

    // FASE B — con los catálogos ya sanos, el reintento TRAE los programas de verdad.
    scenario.catalogosMode = null
    await page.$$eval('button', bs => {
      const b = bs.find(x => /volver a intentarlo|try again/i.test(x.textContent || ''))
      if (b) b.click()
    })
    await page.waitForTimeout(LATENCY + 900)

    const opciones = await page.$$eval('select option', os => os.map(o => o.value).filter(Boolean))
    c.evidencia.elementos = Math.max(c.evidencia.elementos || 0, opciones.length)
    c.afirmar('al reintentar, el desplegable trae los programas',
      opciones.length >= 1,
      `tras reintentar el desplegable trajo ${opciones.length} opción(es): el reintento no sirve de nada`)

    const textoB = await page.evaluate(() => document.body.innerText)
    c.afirmar('y el aviso de «no se pudieron cargar» desaparece',
      !/no hemos podido cargar los programas|could not load the admission programmes/i.test(textoB),
      'el aviso de fallo sigue en pantalla con los programas ya cargados')
    return c
  } finally {
    scenario.catalogosMode = null
  }
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

  // ── 18.bis.35 · QUÉ ES EL DOCUMENTO (DL-R16) ─────────────────────────────────────────
  // La casilla de texto de arriba DESCRIBE, y describir no CLASIFICA: no le asigna al papel
  // ni su nivel de confidencialidad ni sus etiquetas, que es lo único que decide quién puede
  // verlo. Eso lo hace el TIPO. Se afirman tres cosas por separado, porque fallan por motivos
  // distintos: que se pregunte, que las opciones salgan del CATÁLOGO que manda el servidor (no
  // de una lista escrita en la pantalla), y que la respuesta VIAJE con la subida.
  const opcionesDeTipo = await page.$$eval('.doc-attachment .doc-type option',
    os => os.map(o => ({ valor: o.value, texto: (o.textContent || '').trim() })))
  c.afirmar('el paso 6 pregunta qué tipo de documento es', opcionesDeTipo.length > 0,
    'la pantalla no ofrece el desplegable «qué tipo de documento es» (.doc-type)')
  c.afirmar('las opciones de tipo son las que manda el catálogo del centro',
    opcionesDeTipo.some(o => o.valor === 'APPLICATION_DOCUMENTATION') &&
    opcionesDeTipo.some(o => o.valor === 'MEDICAL_RECORD'),
    `las opciones ofrecidas fueron: ${opcionesDeTipo.map(o => o.valor).join(' · ') || '(ninguna)'} — se sirvieron APPLICATION_DOCUMENTATION y MEDICAL_RECORD`)
  c.afirmar('no viene ningún tipo preseleccionado',
    await page.$eval('.doc-attachment .doc-type', s => s.value === '').catch(() => false),
    'el desplegable de tipo arrancó con una opción ya elegida: elegir por la familia es inventar la respuesta')
  const TIPO_ELEGIDO = 'MEDICAL_RECORD'
  if (opcionesDeTipo.some(o => o.valor === TIPO_ELEGIDO)) {
    await page.selectOption('.doc-attachment .doc-type', TIPO_ELEGIDO)
  }

  // ── DL-R17 · DE QUIÉN ES EL DOCUMENTO ────────────────────────────────────────────────
  // Con el archivo por fecha, esta respuesta es el ÚNICO sitio donde consta a quién pertenece
  // el papel: si la pantalla deja de preguntarlo, o lo pregunta y no lo manda, el fichero
  // existe y no significa nada. Se afirman las TRES cosas por separado, porque fallan por
  // motivos distintos: que se pregunte, que las opciones salgan de las personas que la familia
  // YA declaró (no de una lista escrita a mano), y que la respuesta VIAJE con la subida.
  const opcionesDeDueño = await page.$$eval('.doc-attachment .doc-owner option',
    os => os.map(o => ({ valor: o.value, texto: (o.textContent || '').trim() })))
  c.afirmar('el paso 6 pregunta de quién es el documento', opcionesDeDueño.length > 0,
    'la pantalla no ofrece el desplegable «de quién es» (.doc-owner)')
  c.afirmar('no viene ninguna respuesta preseleccionada',
    await page.$eval('.doc-attachment .doc-owner', s => s.value === '').catch(() => false),
    'el desplegable «de quién es» arrancó con una opción ya elegida: elegir por la familia es inventar la respuesta')
  c.afirmar('«de la solicitud» es una opción EXPLÍCITA, no la ausencia de respuesta',
    opcionesDeDueño.some(o => o.valor === 'SOLICITUD'),
    `las opciones ofrecidas fueron: ${opcionesDeDueño.map(o => o.valor).join(' · ') || '(ninguna)'}`)
  // Las personas se ofrecen por su identificador real, no por su nombre ni por su posición.
  const personasOfrecidas = opcionesDeDueño.filter(o => o.valor && o.valor !== 'SOLICITUD')
  c.afirmar('ofrece a las personas que la familia ya declaró', personasOfrecidas.length >= 1,
    'el desplegable no ofreció ninguna persona de la solicitud: sin ellas solo se puede decir «de la solicitud»')
  if (personasOfrecidas.length) {
    await page.selectOption('.doc-attachment .doc-owner', personasOfrecidas[0].valor)
  }

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
    // DL-R17 — y lleva DE QUIÉN es. Que la pantalla lo pregunte no sirve de nada si la
    // respuesta se queda en el navegador: lo que hace que el documento signifique algo es la
    // fila que el KMS escribe con esto.
    c.afirmar('la subida dice de quién es el documento',
      Array.isArray(p.person_ids) && p.person_ids.length === 1 &&
      p.person_ids[0] === (personasOfrecidas[0] || {}).valor,
      `person_ids recibido: ${JSON.stringify(p.person_ids)} (se eligió ${(personasOfrecidas[0] || {}).valor})`)
    // 18.bis.35 — y lleva QUÉ ES. Preguntarlo en pantalla no sirve de nada si la respuesta se
    // queda en el navegador: es este campo el que hace que el KMS le ponga al papel su nivel de
    // confidencialidad y sus etiquetas. Y con dos o más tipos en el catálogo, sin él el
    // servidor RECHAZA la subida entera (`REC_TYPE_REQUIRED`).
    c.afirmar('la subida dice QUÉ tipo de documento es',
      p.rec_type_code === TIPO_ELEGIDO,
      `rec_type_code recibido: ${JSON.stringify(p.rec_type_code)} (se eligió ${TIPO_ELEGIDO})`)
  } else {
    c.noCubierta('contenido-de-la-subida', 'no hubo ninguna subida que inspeccionar')
  }
  c.afirmar('la pantalla confirma la subida', subidaOk,
    'nunca apareció la confirmación visible de archivo subido (.upload-status.success)')

  // ── 18.bis.95 · SI LA FICHA DEL DOCUMENTO NO QUEDÓ ESCRITA, LA PANTALLA NO CONFIRMA ──
  // El endpoint del KMS es SÍNCRONO y dice si escribió (`file_persisted`); el asistente
  // tiraba esa respuesta y confirmaba igual ⇒ un documento que está en Drive pero no existe
  // para nadie, dado por bueno en pantalla. Contra el sistema REAL esto exige provocar un
  // rechazo de escritura en el KMS, que no se hace sobre datos de verdad: se declara.
  if (REAL) {
    c.noCubierta('subida-no-registrada',
      'exige que el KMS rechace la escritura de la ficha del documento; no se provoca contra datos reales. En modo simulado sí se cubre, con la palanca `scenario.subidaNoRegistrada`.')
    return c
  }
  // El rechazo se PROVOCA a propósito: que quede registrado en consola es lo correcto.
  c.esperarErrorConsola(/gasCall uploadDocument: server returned ok=false/,
    'el servidor rechaza la ficha del documento a propósito para comprobar que la familia se entera')
  c.esperarErrorConsola(/Step6: uploadDocument failed/,
    'la pantalla registra el rechazo provocado antes de explicárselo a la familia')
  scenario.subidaNoRegistrada = true
  try {
    const antes = llamadas('uploadDocument').length
    // Se sube inline (no con `subirUnDocumento`, que EXIGE ver la confirmación y aquí lo
    // correcto es justo que NO aparezca).
    const otroAñadir = await page.$('.add-btn')
    if (!otroAñadir) { c.fallos.push('el paso de Documentos dejó de ofrecer el botón de añadir archivo'); return c }
    await otroAñadir.click()
    await page.waitForTimeout(300)
    const cajas = await page.$$('.doc-attachment input[type="text"]')
    if (cajas.length) await cajas[cajas.length - 1].fill('Documento sintético E2E (18.bis.95)')
    // 18.bis.35 — se contesta también QUÉ es, porque lo que aquí se quiere provocar es que el
    // KMS rechace la ESCRITURA de la ficha; sin tipo, la subida ni saldría de la pantalla y se
    // estaría midiendo otra cosa.
    const tiposDeLaRechazada = await page.$$('.doc-attachment .doc-type')
    if (tiposDeLaRechazada.length) {
      const opts = await tiposDeLaRechazada[tiposDeLaRechazada.length - 1]
        .$$eval('option', os => os.map(o => o.value).filter(Boolean))
      if (opts.length) await tiposDeLaRechazada[tiposDeLaRechazada.length - 1].selectOption(opts[0])
    }
    const ficheros = await page.$$('.doc-attachment input[type="file"]')
    if (!ficheros.length) { c.fallos.push('la fila de documento no ofrece campo de archivo'); return c }
    await ficheros[ficheros.length - 1].setInputFiles({
      name: 'prueba-e2e.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4\n% documento sintetico de la bateria E2E\n'),
    })
    await page.waitForTimeout(LATENCY + 2500)
    c.afirmar('(1) el rechazo de la ficha llega al servidor y vuelve',
      llamadas('uploadDocument').length > antes,
      'no salió una segunda subida que el servidor pudiera rechazar')

    const filas = await page.evaluate(() => Array.from(document.querySelectorAll('.doc-attachment')).map(f => ({
      exito: !!f.querySelector('.upload-status.success'),
      error: (f.querySelector('.upload-status.error')?.textContent || '').replace(/\s+/g, ' ').trim(),
    })))
    const rechazada = filas.find(f => f.error)
    c.afirmar('(2) la pantalla NO da por subido lo que no quedó registrado',
      !!rechazada && !rechazada.exito,
      `la fila de la subida rechazada quedó ${rechazada ? 'marcada como subida' : 'sin ningún aviso'}: la familia creería que su documento está en la solicitud, y no lo está (18.bis.95)`)
    c.afirmar('(3) el aviso dice QUÉ pasó y qué hacer, en el idioma de la familia',
      !!rechazada && /no ha quedado registrado|was not recorded/i.test(rechazada.error) &&
                     /vuelve a subirlo|upload it again/i.test(rechazada.error),
      `el aviso dice «${rechazada ? rechazada.error : '(ninguno)'}»: sin decir que no quedó registrado ni qué hacer, la familia no sabe que tiene que volver a subirlo`)
  } finally {
    scenario.subidaNoRegistrada = false
  }

  // ── 0º.quindecies (segunda pieza, 2026-08-21) · EL PULSO SE APARTA MIENTRAS SUBE UN
  // DOCUMENTO ──────────────────────────────────────────────────────────────────────
  // Medido en el registro real de Diego del 2026-08-20: mientras un documento de 90 KB
  // tardaba 96 s en subir, el latido de la pantalla (`WizardPage.jsx`, cada 30 s) disparó
  // igual `getAdmissionState` y pagó su propia pregunta a la puerta del expediente EN
  // PARALELO con la que ya estaba pagando la subida — el pulso solo miraba la cola de
  // guardado de PASOS (`hasPendingSave`), que una subida de documento nunca toca (es un
  // canal aparte, directo por `gasCall`). Se demuestra forzando el latido —el mismo evento
  // `focus` que dispara la aplicación real, `latirLaVentana`— A MITAD de una subida
  // deliberadamente lenta (`scenario.subidaDemoraMs`), y comprobando que
  // `getLiveStateVersion` —la PRIMERA llamada que el pulso hace, antes de preguntar nada
  // más— NO sale mientras la subida sigue en vuelo, y SÍ sale en cuanto termina.
  scenario.subidaDemoraMs = 3000
  try {
    const otroAñadirLento = await page.$('.add-btn')
    if (!otroAñadirLento) { c.fallos.push('el paso de Documentos dejó de ofrecer el botón de añadir archivo'); return c }
    await otroAñadirLento.click()
    await page.waitForTimeout(300)
    const cajasLentas = await page.$$('.doc-attachment input[type="text"]')
    if (cajasLentas.length) await cajasLentas[cajasLentas.length - 1].fill('Documento lento E2E (0º.quindecies)')
    const tiposLentos = await page.$$('.doc-attachment .doc-type')
    if (tiposLentos.length) {
      const opts = await tiposLentos[tiposLentos.length - 1]
        .$$eval('option', os => os.map(o => o.value).filter(Boolean))
      if (opts.length) await tiposLentos[tiposLentos.length - 1].selectOption(opts[0])
    }
    const ficherosLentos = await page.$$('.doc-attachment input[type="file"]')
    if (!ficherosLentos.length) { c.fallos.push('la fila de documento no ofrece campo de archivo'); return c }
    await ficherosLentos[ficherosLentos.length - 1].setInputFiles({
      name: 'prueba-lenta-e2e.pdf',
      mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4\n% documento lento sintetico E2E\n'),
    })
    await page.waitForTimeout(600) // deja que la subida SALGA y quede registrada, sin dar tiempo a que vuelva
    const subidasEnVueloAntes = llamadas('uploadDocument').length
    c.afirmar('la subida lenta llega a salir antes de forzar el latido',
      subidasEnVueloAntes > subidas.length,
      'no se registró la subida deliberadamente lenta: la carrera no se puede montar')
    const marcaDeLlamadas = calls.length
    await latirLaVentana(page)
    await page.waitForTimeout(400)
    const versionesDurantelaSubida = llamadas('getLiveStateVersion').filter(l => calls.indexOf(l) >= marcaDeLlamadas)
    c.afirmar('el pulso NO pregunta nada mientras un documento sigue subiéndose',
      versionesDurantelaSubida.length === 0,
      `el latido forzado a mitad de la subida SÍ disparó getLiveStateVersion (${versionesDurantelaSubida.length} vez/veces): el pulso y la subida vuelven a colisionar`)
    // La subida termina (LATENCY + subidaDemoraMs) y el pulso vuelve a funcionar con normalidad.
    await page.waitForTimeout(LATENCY + scenario.subidaDemoraMs + 1500)
    const marcaTrasLaSubida = calls.length
    await latirLaVentana(page)
    await page.waitForTimeout(400)
    const versionesTrasLaSubida = llamadas('getLiveStateVersion').filter(l => calls.indexOf(l) >= marcaTrasLaSubida)
    c.afirmar('el pulso vuelve a preguntar en cuanto la subida termina (no se queda apartado para siempre)',
      versionesTrasLaSubida.length > 0,
      'tras terminar la subida, un latido forzado siguió sin disparar getLiveStateVersion: el apartado no se libera')
  } finally {
    scenario.subidaDemoraMs = 0
  }

  // ── `0º.tricies.quinquies` (Diego, 2026-08-22) · EL DOCUMENTO QUE SE SUBE MIENTRAS LA
  // FAMILIA AVANZA ────────────────────────────────────────────────────────────────────
  // Cita literal: *«Elijo un documento… Se queda subiendo. Si en ese momento avanzo al paso 7
  // y vuelvo al 6, el documento ha desaparecido. No sé si se sigue subiendo o se ha cancelado
  // la subida.»* Se sigue subiendo —nada la aborta— pero su rastro moría con el panel, y como
  // el navegador tampoco mandaba la marca de «este envío ya lo hice», volver a subirlo
  // DUPLICABA. Aquí se miden las tres cosas.
  //
  // (a) LA MARCA VIAJA — sin ella el mecanismo anti-duplicado de los dos servidores está muerto.
  const conMarca = llamadas('uploadDocument').filter(l => l.payload && l.payload.upload_idempotency_token)
  c.afirmar('la subida manda su marca de idempotencia, con forma de UUID',
    conMarca.length > 0 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
      .test(conMarca[conMarca.length - 1].payload.upload_idempotency_token),
    `de ${llamadas('uploadDocument').length} subida(s), ${conMarca.length} llevaron marca; la última fue ` +
    `${JSON.stringify(conMarca.length ? conMarca[conMarca.length - 1].payload.upload_idempotency_token : null)}: ` +
    'sin marca válida el servidor acuña una nueva cada vez y el mismo archivo se guarda dos veces')

  // (b) EL REINTENTO DEL MISMO ARCHIVO MANDA LA MISMA MARCA — es lo que hace que el segundo
  // envío devuelva el fichero que ya estaba en vez de crear otro. El reintento que cuenta es
  // el REAL: el servidor pide el código de un solo uso, la familia lo teclea y el asistente
  // repite la subida por `setStepUpRetry`, con el MISMO archivo ya elegido.
  //
  // ⛔ Volver a ELEGIR el archivo NO es un reintento y acuña marca nueva a propósito: ahí el
  // navegador no puede saber que son los mismos bytes, y reutilizar la marca haría que el
  // servidor devolviera el fichero anterior creyendo la familia que subió el nuevo.
  const MISMO_ARCHIVO = {
    name: 'reintento-e2e.pdf', mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n% mismo archivo, dos intentos\n'),
  }
  scenario.subidaPideCodigoUnaVez = true
  try {
    const anadirR = await page.$('.add-btn')
    if (!anadirR) { c.fallos.push('el paso de Documentos dejó de ofrecer el botón de añadir archivo'); return c }
    await anadirR.click()
    await page.waitForTimeout(300)
    const tiposR = await page.$$('.doc-attachment .doc-type')
    if (tiposR.length) {
      const opts = await tiposR[tiposR.length - 1].$$eval('option', os => os.map(o => o.value).filter(Boolean))
      if (opts.length) await tiposR[tiposR.length - 1].selectOption(opts[0])
    }
    const ficherosR = await page.$$('.doc-attachment input[type="file"]')
    await ficherosR[ficherosR.length - 1].setInputFiles(MISMO_ARCHIVO)
    await page.waitForTimeout(LATENCY + 900)
    // El asistente pide el código; al verificarlo repite la subida YA ELEGIDA
    // (`setStepUpRetry`), que es el reintento que tiene que reenviar la misma marca.
    const pedirlo = await page.$('input[autocomplete="one-time-code"]')
    if (!pedirlo) {
      // Todavía en «te lo mando»: se pulsa para que aparezca la casilla.
      const enviar = await page.$$('button.btn-primary-kis')
      for (const b of enviar) {
        const txt = await b.evaluate(n => (n.textContent || '').trim())
        if (/código|code/i.test(txt)) { await b.click(); break }
      }
      await page.waitForTimeout(LATENCY + 600)
    }
    const casilla = await page.$('input[autocomplete="one-time-code"]')
    if (casilla) {
      await casilla.fill('123456')
      const botones = await page.$$('button.btn-primary-kis')
      for (const b of botones) {
        const txt = await b.evaluate(n => (n.textContent || '').trim())
        if (/verificar|verify/i.test(txt)) { await b.click(); break }
      }
      await page.waitForTimeout(LATENCY + 1500)
    }
  } finally {
    scenario.subidaPideCodigoUnaVez = false
  }
  const delMismoArchivo = llamadas('uploadDocument')
    .filter(l => l.payload && l.payload.filename === MISMO_ARCHIVO.name)
    .map(l => l.payload.upload_idempotency_token)
  if (!c.afirmar('el reintento del mismo archivo llega a producirse (si no, no hay nada que comparar)',
    delMismoArchivo.length >= 2,
    `solo se registró ${delMismoArchivo.length} intento(s) de ${MISMO_ARCHIVO.name}: el reintento tras el código no llegó a dispararse`)) return c
  c.afirmar('el reintento del MISMO archivo manda la MISMA marca (no lo duplica)',
    !!delMismoArchivo[0] && delMismoArchivo.every(m => m === delMismoArchivo[0]),
    `las marcas de los ${delMismoArchivo.length} intento(s) del mismo archivo fueron ${JSON.stringify(delMismoArchivo)}: ` +
    'con marcas distintas el servidor guarda el archivo otra vez, que es el PDF repetido que Diego ya había visto')

  // (c) LA FILA EN VUELO SOBREVIVE A SALIR DEL PASO. Se lanza una subida deliberadamente
  // lenta, se avanza al paso 7 y se vuelve al 6: la fila tiene que SEGUIR AHÍ, y acabar en
  // «subido» cuando la subida termine.
  scenario.subidaDemoraMs = 4000
  try {
    const añadirV = await page.$('.add-btn')
    if (!añadirV) { c.fallos.push('el paso de Documentos dejó de ofrecer el botón de añadir archivo'); return c }
    await añadirV.click()
    await page.waitForTimeout(300)
    const tiposV = await page.$$('.doc-attachment .doc-type')
    if (tiposV.length) {
      const opts = await tiposV[tiposV.length - 1].$$eval('option', os => os.map(o => o.value).filter(Boolean))
      if (opts.length) await tiposV[tiposV.length - 1].selectOption(opts[0])
    }
    const ficherosV = await page.$$('.doc-attachment input[type="file"]')
    await ficherosV[ficherosV.length - 1].setInputFiles({
      name: 'en-vuelo-e2e.pdf', mimeType: 'application/pdf',
      buffer: Buffer.from('%PDF-1.4\n% subida en vuelo\n'),
    })
    await page.waitForTimeout(700)   // que SALGA, sin darle tiempo a volver

    // La familia avanza al paso 7 con la subida en vuelo — a propósito, y NUNCA se le impide.
    if (!await continuar(c, page, 6, 'al paso 7 con una subida en vuelo')) return c
    await page.waitForTimeout(400)
    if (!await irADocumentos(c, page, 'de vuelta con la subida en vuelo')) return c
    await page.waitForTimeout(300)

    // ⛔ NO se cuentan filas: al volver, las filas vacías o fallidas de antes desaparecen
    // legítimamente (se siembran de lo guardado), así que un recuento mezcla dos cosas. Lo
    // que se mide es lo único que dice si la subida sobrevivió: que haya una fila EN VUELO.
    // ⛔ Se cuentan las filas POR ESTADO, no el texto de la página entera: en este punto ya
    // hay otras filas que dicen «Subido» de subidas anteriores, así que buscar esa palabra en
    // el `body` pasaba EN VACÍO — medido: con el aterrizaje roto a propósito, la afirmación
    // seguía saliendo verde.
    const porEstado = () => page.$$eval('.doc-attachment', ns => ({
      enVuelo: ns.filter(n => /Subiendo|Uploading/i.test(n.textContent || '')).length,
      subidos: ns.filter(n => /Subido|Uploaded/i.test(n.textContent || '')).length,
    }))
    const alVolver = await porEstado()
    if (!c.afirmar('el documento que se estaba subiendo SIGUE en la pantalla al volver al paso 6',
      alVolver.enVuelo >= 1,
      `al volver al paso 6 hay ${alVolver.enVuelo} fila(s) en «subiendo…»: la fila en vuelo desapareció, que es justo lo que Diego reportó`)) return c

    // Y termina: la subida acaba y ESA fila pasa a «subido» sola — una menos en vuelo, una
    // más subida. Es lo único que acredita que el final de la subida llegó a la pantalla
    // aunque el panel que la lanzó ya no exista.
    await page.waitForTimeout(LATENCY + scenario.subidaDemoraMs + 3000)
    const alTerminar = await porEstado()
    c.afirmar('la subida que quedó en vuelo termina y ESA fila se ve como SUBIDA',
      alTerminar.enVuelo === alVolver.enVuelo - 1 && alTerminar.subidos === alVolver.subidos + 1,
      `al volver: ${JSON.stringify(alVolver)} · al terminar: ${JSON.stringify(alTerminar)}. ` +
      'Se esperaba una fila menos en vuelo y una más subida: la fila se quedó en «subiendo…» porque el final de la subida no llegó a la pantalla')
  } finally {
    scenario.subidaDemoraMs = 0
  }

  c.evidencia.llamadas = llamadas('uploadDocument').length
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
  if (!c.afirmar('paso 5 · preguntas — las respuestas salen desde la pantalla',
    llamadas('saveResponses').length > antes,
    `se respondieron ${respondidos} controles y NINGÚN saveResponses salió en ${Date.now() - t0} ms: o el paso no reconoce lo tecleado como respuesta, o no lo envía.\n        Último registro del producto → ${ultimoDbg}`)) return false

  // ── 0º.tricies.decies · LA CLAVE DE LA RESPUESTA NO CAMBIÓ AL AGRUPAR ────────────────
  // `Step5Questions.handleNext` parte la clave (`question_id__sujeto`) para componer el
  // `respondent_id` de cada fila: si al agrupar por sujeto se hubiera tocado esa clave, la
  // respuesta de un alumno se guardaría contra otro sujeto —o contra el expediente— y la
  // familia perdería lo que escribió. Se comprueba donde se ve: en lo que SALE.
  const nuevas = llamadas('saveResponses').slice(antes)
  const sujetos = new Set()
  nuevas.forEach(l => ((l.payload && l.payload.responses) || [])
    .forEach(r => r && r.respondent_id && sujetos.add(r.respondent_id)))
  return c.afirmar('paso 5 · preguntas — la respuesta de cada alumno viaja con SU identificador',
    sujetos.has(FIXTURE.applicantId) && sujetos.has(FIXTURE.applicant2Id),
    `los sujetos que viajaron fueron ${JSON.stringify([...sujetos])}: se esperaban los dos ` +
    `alumnos (${FIXTURE.applicantId}, ${FIXTURE.applicant2Id}). Si falta alguno, la clave ` +
    `«question_id__sujeto» dejó de componerse por persona y las respuestas se atribuyen mal`)
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
  // `0º.vicies.semel` (2026-08-21) — la firma tecleada se retiró: nadie la leía y bloqueaba
  // el envío sin motivo. Se afirma que el campo YA NO existe (no que se rellena) y que se
  // puede enviar sin teclear ningún nombre — solo con los dos consentimientos.
  if (!c.afirmar('paso 7 · envío — se puede enviar sin teclear ninguna firma manuscrita',
    !(await page.$('.esig-field')),
    'la pantalla de revisión sigue ofreciendo el campo de firma manuscrita (.esig-field)')) return false
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
 * ①27 pieza 9 · DL-R19 — LA IMAGEN SE COMPRIME EN EL NAVEGADOR, Y LO INMUTABLE NO.
 *
 * Dos afirmaciones que fallan por motivos DISTINTOS, y por eso van separadas:
 *   · una foto de un tipo corriente viaja con MENOS bytes de los que la familia eligió;
 *   · la misma foto, declarada de un tipo INMUTABLE, viaja BYTE A BYTE como estaba.
 *
 * ⛔ **LA FOTO SE FABRICA EN EL NAVEGADOR, no con un `Buffer` de Node, y no es capricho**:
 * comprimir exige que el navegador sepa DESCODIFICAR la imagen. Unos bytes inventados no
 * son un JPEG legible ⇒ `comprimirImagen` devolvería el original por «no-se-pudo-descodificar»
 * y la afirmación pasaría **en vacío**, que es peor que no tenerla. Se dibuja un patrón suave
 * y grande, se codifica a JPEG de alta calidad, y ESO es lo que se le da al selector.
 *
 * ⚠️ **Lo que este camino NO cubre**: que el KMS guarde los bytes comprimidos. La batería
 * corre contra un backend simulado que **nunca ejecuta `backend/Code.js`** ni el KMS — aquí
 * se afirma lo que MANDA el navegador, que es donde vive la decisión de DL-R19.
 */
async function caminoImagenSeComprime(page, base) {
  const c = new Camino('imagen-se-comprime-al-subir')
  scenario.stage = 'hasta_preguntas'   // aterriza directamente en Documentos (5)

  if (!await entrarPorElEnlace(c, page, base)) return c

  const pantalla = await page.evaluate(sondaPantalla)
  if (REAL && pantalla.pasoActivo !== 5) {
    c.evidencia.elementos = pantalla.pasos + pantalla.campos
    c.noCubierta('compresion-desde-la-pantalla',
      `el expediente aterriza en el índice ${pantalla.pasoActivo} y el robot aún no conduce los pasos 2-5 para llegar a Documentos`)
    return c
  }
  if (!c.afirmar('aterriza en el paso de Documentos', pantalla.pasoActivo === 5,
    `aterrizó en el índice ${pantalla.pasoActivo}, no en 5`)) return c

  // ⛔ EL JPEG SE DIBUJA EN EL NAVEGADOR, pero se ENTREGA con `setInputFiles` — que es la vía
  // que este robot ya usa y la que sabe alcanzar un selector de archivo OCULTO (el del paso 6
  // lo está: `style={{display:'none'}}`). Fijar `input.files` a mano desde la página NO vale:
  // se probó y el `querySelectorAll` no alcanzaba ese campo, y el rojo que salía era del robot,
  // no del producto.
  let fotoBytes = null, fotoBuffer = null
  const dibujarFoto = async () => {
    if (fotoBuffer) return
    const b64 = await page.evaluate(async () => {
      const lienzo = document.createElement('canvas')
      lienzo.width = 3000; lienzo.height = 2100
      const ctx = lienzo.getContext('2d')
      const img = ctx.createImageData(lienzo.width, lienzo.height)
      for (let y = 0; y < lienzo.height; y++) {
        for (let x = 0; x < lienzo.width; x++) {
          const p = (y * lienzo.width + x) * 4
          // Patrón suave (se codifica bien) + un grano fino que impide que el JPEG lo reduzca
          // a nada: sin grano el original ya sería diminuto, no habría nada que ahorrar, y la
          // comparación de abajo pasaría EN VACÍO.
          img.data[p]     = 128 + 100 * Math.sin(x / 40) + ((x * y) % 17)
          img.data[p + 1] = 128 + 100 * Math.sin(y / 55) + ((x + y) % 23)
          img.data[p + 2] = 128 + 100 * Math.sin((x + y) / 70) + ((x * 3 + y) % 13)
          img.data[p + 3] = 255
        }
      }
      ctx.putImageData(img, 0, 0)
      const blob = await new Promise(r => lienzo.toBlob(r, 'image/jpeg', 0.85))
      return await new Promise(r => {
        const fr = new FileReader()
        fr.onload = () => r(String(fr.result).split(',')[1])
        fr.readAsDataURL(blob)
      })
    })
    fotoBuffer = Buffer.from(b64, 'base64')
    fotoBytes  = fotoBuffer.length
  }
  // ⛔ SIEMPRE EL ÚLTIMO campo de archivo, nunca el del panel N. Un panel con la subida ya
  // terminada SUSTITUYE su zona de soltar por el aviso de éxito ⇒ su campo desaparece del
  // documento, y contar por panel deja de casar. Medido: por eso el primer intento salió rojo
  // con «no hay campo de archivo en el panel 1» — un rojo del ROBOT, no del producto.
  const elegirFoto = async () => {
    await dibujarFoto()
    const entradas = await page.$$('.doc-attachment input[type="file"]')
    if (!entradas.length) throw new Error('no quedó ningún campo de archivo donde elegir la foto')
    await entradas[entradas.length - 1].setInputFiles({
      name: 'foto-familia-e2e.jpg', mimeType: 'image/jpeg', buffer: fotoBuffer,
    })
    return fotoBytes
  }

  const bytesDeLaSubida = (llamada) => {
    const b64 = (llamada && llamada.payload && llamada.payload.base64) || ''
    return Math.floor(b64.length * 3 / 4)   // base64 → bytes, con el margen del relleno
  }

  const abrirPanel = async (indice) => {
    const añadir = await page.$('.add-btn')
    if (!añadir) return false
    await añadir.click()
    await page.waitForFunction(
      n => document.querySelectorAll('.doc-attachment').length >= n, indice + 1, { timeout: 10000 })
    // ⛔ Y SE ESPERA A QUE LA LISTA SE ASIENTE. Tras una subida con éxito la pantalla vuelve a
    // sembrar sus filas con lo que trae el expediente, así que los paneles siguen apareciendo
    // un rato. Actuar en mitad de ese repintado deja el gesto sobre un nodo que React ya ha
    // sustituido: el desplegable «cambia» y nadie recibe el cambio. Medido — era esto.
    let previo = -1
    for (let i = 0; i < 12; i++) {
      const ahora = await page.evaluate(() => document.querySelectorAll('.doc-attachment').length)
      if (ahora === previo) break
      previo = ahora
      await page.waitForTimeout(400)
    }
    return true
  }

  // Elige el tipo y COMPRUEBA QUE PRENDIÓ tras un repintado. La comprobación no es de adorno:
  // el desplegable está gobernado por el estado de la pantalla, así que si React no recibió el
  // gesto, el valor vuelve solo al de partida en cuanto algo repinta — y el rojo saldría más
  // adelante, como «no salió la subida», mandando a buscar el defecto donde no está.
  const elegirTipo = async (valor) => {
    for (let intento = 0; intento < 5; intento++) {
      await page.locator('.doc-attachment .doc-type').last().selectOption(valor)
      await page.waitForTimeout(500)
      const ok = await page.evaluate(v => {
        const ss = document.querySelectorAll('.doc-attachment .doc-type')
        return !!ss.length && ss[ss.length - 1].value === v
      }, valor)
      if (ok) return true
    }
    return false
  }

  // ── ANCLA: sin los tres tipos en el desplegable, todo lo de abajo mediría el aire ──────
  if (!await abrirPanel(0)) { c.fallos.push('el paso de Documentos no ofrece el botón de añadir archivo'); return c }
  const opciones = await page.$$eval('.doc-attachment .doc-type option', os => os.map(o => o.value).filter(Boolean))
  c.evidencia.elementos = opciones.length
  if (!c.afirmar('el catálogo ofrece un tipo corriente Y uno inmutable',
    opciones.includes('APPLICATION_DOCUMENTATION') && opciones.includes('CUSTODY_ORDER'),
    `las opciones fueron: ${opciones.join(' · ') || '(ninguna)'} — sin las dos, las afirmaciones de abajo pasarían en vacío`)) return c

  // ── (1) TIPO CORRIENTE (`is_immutable:false`) ⇒ viaja comprimida ───────────────────────
  if (!c.afirmar('el tipo corriente queda elegido en el primer panel',
    await elegirTipo('APPLICATION_DOCUMENTATION'),
    'la eleccion del tipo no prendio: la pantalla no dispara la subida sin respuesta (18.bis.35)')) return c
  const bytesOriginal = await elegirFoto()
  try { await page.waitForSelector('.doc-attachment .upload-status.success', { timeout: LATENCY + 20000 }) }
  catch { /* se reporta abajo por la ausencia de llamada */ }

  const subidas1 = llamadas('uploadDocument')
  c.evidencia.llamadas = subidas1.length
  if (!c.afirmar('la foto llega al servidor', subidas1.length >= 1,
    'no salió ninguna llamada uploadDocument al elegir la foto')) return c

  const bytesEnviados = bytesDeLaSubida(subidas1[subidas1.length - 1])
  c.afirmar('la foto viaja COMPRIMIDA cuando el tipo no es inmutable',
    bytesEnviados > 0 && bytesEnviados < bytesOriginal * 0.8,
    `se eligió una foto de ${bytesOriginal} bytes y viajaron ${bytesEnviados}: sin compresión, la familia paga el camino más lento del asistente con el archivo entero`)
  c.afirmar('el nombre y el tipo del archivo NO cambian al comprimir',
    (subidas1[subidas1.length - 1].payload || {}).filename === 'foto-familia-e2e.jpg' &&
    (subidas1[subidas1.length - 1].payload || {}).mimeType === 'image/jpeg',
    `llegaron filename=${(subidas1[subidas1.length - 1].payload || {}).filename} y mimeType=${(subidas1[subidas1.length - 1].payload || {}).mimeType}: la extensión dejaría de decir la verdad`)

  // ── (2) TIPO INMUTABLE ⇒ byte a byte como estaba (DL-R19) ─────────────────────────────
  if (!await abrirPanel(1)) { c.fallos.push('no se pudo abrir un segundo panel de archivo'); return c }
  // ⛔ Se elige con un LOCALIZADOR que se vuelve a resolver, no con un puntero capturado antes:
  // añadir el panel repinta la lista y un puntero de hace un instante puede quedar apuntando a un
  // nodo que ya no está en la pantalla — la elección «funciona» sin que nadie la reciba.
  if (!c.afirmar('el tipo INMUTABLE queda elegido en el segundo panel',
    await elegirTipo('CUSTODY_ORDER'),
    `los desplegables de tipo valen ${JSON.stringify(await page.$$eval('.doc-attachment .doc-type', ss => ss.map(s => s.value)))}: sin la eleccion, la pantalla no dispara la subida y el rojo de abajo seria del robot`)) return c
  const antesDeSoltar = await page.evaluate(() => ({
    paneles: document.querySelectorAll('.doc-attachment').length,
    tipos: [...document.querySelectorAll('.doc-attachment .doc-type')].map(s => s.value),
    campos: document.querySelectorAll('.doc-attachment input[type="file"]').length,
  }))
  const bytesOriginal2 = await elegirFoto()
  // ⛔ SE ESPERA A LA LLAMADA, no al aviso de éxito, y con presupuesto largo: el archivo de un
  // tipo INMUTABLE viaja ENTERO a propósito (es lo que se está comprobando), así que tarda
  // bastante más que el comprimido de arriba. Medido: con el presupuesto corto el robot leía
  // «solo salió 1 subida» cuando el panel decía «Subiendo…» — un rojo del ROBOT, no del producto.
  for (let i = 0; i < 120 && llamadas('uploadDocument').length < 2; i++) await page.waitForTimeout(500)

  const subidas2 = llamadas('uploadDocument')
  c.evidencia.llamadas = subidas2.length
  const dicePanel = await page.evaluate(() => {
    const ps = [...document.querySelectorAll('.doc-attachment')]
    return ps.map((p, i) => `#${i}[${(p.innerText || '').replace(/\s+/g, ' ').trim().slice(-170)}]`).join(' || ')
  })
  if (!c.afirmar('la segunda foto llega al servidor', subidas2.length >= 2,
    `salieron ${subidas2.length} llamada(s) uploadDocument; se esperaban 2 — antes de soltar la foto: ${JSON.stringify(antesDeSoltar)} — el panel dice: «${dicePanel}»`)) return c

  const bytesInmutable = bytesDeLaSubida(subidas2[subidas2.length - 1])
  c.afirmar('un tipo INMUTABLE se sube tal cual, sin recomprimir',
    Math.abs(bytesInmutable - bytesOriginal2) <= 3,
    `se eligió una foto de ${bytesOriginal2} bytes y viajaron ${bytesInmutable}: un documento con valor probatorio recomprimido deja de ser el que se firmó (DL-R19)`)

  return c
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
 * ⭐ EL PASO 8 AL DÍA (2026-08-27) — el paso 8 se quedó DOS pasadas por detrás del 7 siendo
 * la MISMA pantalla de dinero, y NADIE se enteró porque **no tenía ni una afirmación**: el
 * doble devolvía `subscriptions: []`. Este camino lo cubre.
 *
 * ⛔ ANCLA por delante: sin comprobar que el paso 8 llegó a pintar su presupuesto, las demás
 * afirmaciones pasarían sobre una pantalla que no se montó.
 */
async function caminoPaso8AlDia(page, base) {
  const c = new Camino('paso8-al-dia')
  scenario.stage = 'firma'
  if (!await entrarPorElEnlace(c, page, base)) return c
  await page.waitForTimeout(LATENCY + 900)

  const pantalla = await page.evaluate(sondaPantalla)
  c.evidencia.elementos = pantalla.pasos + pantalla.campos + pantalla.tarjetas

  // (0) ANCLA — el presupuesto llegó a pintarse.
  const desglose = await page.$('[data-testid="paso8-desglose"]')
  if (!c.afirmar('ANCLA · el paso 8 pinta su presupuesto', !!desglose,
    'no se pintó [data-testid="paso8-desglose"]: lo que sigue mediría el aire')) return c

  // (1) UN DESPLEGABLE, NO TARJETAS — es lo que Diego mandó quitar en el paso 7.
  const selector = await page.$('[data-testid="paso8-modalidad-selector"]')
  const etiquetas = await page.$$eval('[data-testid="paso8-modalidad"]',
    ns => ns.map(n => n.tagName))
  c.afirmar('la forma de pago se elige con un DESPLEGABLE, no con tarjetas',
    !!selector && etiquetas.every(x => x === 'OPTION'),
    `selector encontrado: ${!!selector}; las opciones eran ${JSON.stringify(etiquetas)}: si son BUTTON, han vuelto las tarjetas`)

  // (2) LAS CINCO COLUMNAS — concepto · fecha · bruto · descuento · a pagar.
  const cols = await page.$$eval('[data-testid="paso8-desglose"] thead th', ns => ns.length)
  const desc = await page.$$('[data-testid="paso8-desglose-descuento"]')
  const neto = await page.$$('[data-testid="paso8-desglose-neto"]')
  c.afirmar('el calendario enseña el descuento y lo que se paga por cada vencimiento',
    cols === 5 && desc.length > 0 && neto.length > 0,
    `columnas=${cols} celdas de descuento=${desc.length} celdas de neto=${neto.length}: con tres columnas el descuento pasa desapercibido, que es lo que Diego dijo del paso 7`)

  // (3) EL SUBTOTAL — el escalón entre las filas y el total.
  const sub = await page.$('[data-testid="paso8-subtotal-plan"]')
  const subNeto = await page.$eval('[data-testid="paso8-subtotal-neto"]', n => n.textContent.trim())
    .catch(() => null)
  c.afirmar('el plan lleva su SUBTOTAL, con lo que de verdad se paga',
    !!sub && !!subNeto && /\d/.test(subNeto),
    `subtotal presente=${!!sub} neto leído=${JSON.stringify(subNeto)}`)

  // (4) EL REPARTO, EN EUROS — no solo «60 % / 40 %».
  const importes = await page.$$eval('[data-testid="reparto-importe"]',
    ns => ns.map(n => n.textContent.trim()))
  // ⚠️ Este comentario decía «UNA sola fila… el paso 8 solo puede enseñar UNA», y quedó
  // CADUCADO el 2026-08-27 con la excepción de D121: del otro tutor viajan ya su nombre y su
  // identificador, así que el reparto pinta a los DOS y el deslizador existe. Lo que se
  // afirma aquí no cambia: que cada pagador ve su importe, y que es una CIFRA.
  c.afirmar('el tutor ve CUÁNTO le toca pagar, no solo su porcentaje',
    importes.length >= 1 && importes.every(x => /\d/.test(x)),
    `importes leídos: ${JSON.stringify(importes)}: con solo el porcentaje, la familia no sabe cuánto es`)

  // (5) Y ESE EURO LO MANDA EL SERVIDOR — no se recalcula al mover el reparto.
  //     Al cambiar el porcentaje, el importe guardado deja de corresponder ⇒ se dice, no se
  //     inventa. Es la barandilla de DL-080-A puesta donde se ve.
  const slider = await page.$('input[type="range"]')
  if (slider) {
    await slider.evaluate(n => {
      const set = Object.getOwnPropertyDescriptor(window.HTMLInputElement.prototype, 'value').set
      set.call(n, '30'); n.dispatchEvent(new Event('input', { bubbles: true }))
    })
    await page.waitForTimeout(250)
    const tras = await page.$$eval('[data-testid="reparto-importe"]',
      ns => ns.map(n => n.textContent.trim()))
    c.afirmar('al mover el reparto NO se inventa un importe nuevo en la pantalla',
      tras.some(x => !/\d/.test(x)),
      `tras mover el deslizador los importes eran ${JSON.stringify(tras)}: si siguen siendo cifras, o se están recalculando en el navegador (DL-080-A) o se está enseñando el número viejo al lado del porcentaje nuevo`)
  } else {
    // Con la excepción de D121 el reparto pinta a los DOS tutores ⇒ el deslizador EXISTE.
    // Que no esté ya no es un eje fuera de alcance: es un defecto, y se dice como tal.
    c.afirmar('al mover el reparto NO se inventa un importe nuevo en la pantalla', false,
      'no se pintó el deslizador del reparto: con la excepción de D121 la pantalla enseña a los dos pagadores, así que su ausencia significa que el otro tutor ha dejado de llegar')
  }
  return c
}

/**
 * ⭐ EL PASO 8 AL DÍA — LO QUE DIEGO VIO DE VERDAD (medido el 2026-08-27): el presupuesto
 * devolvía CERO suscripciones porque ningún expediente estaba admitido, y la pantalla NO
 * DECÍA NADA. Lo leyó como «no me deja elegir la forma de pago».
 */
async function caminoPaso8SinNadaQueElegir(page, base) {
  const c = new Camino('paso8-sin-nada-que-elegir')
  scenario.stage = 'firma'
  scenario.sinSuscripcion = 'sin-admitir'
  try {
    if (!await entrarPorElEnlace(c, page, base)) return c
    await page.waitForTimeout(LATENCY + 900)
    const pantalla = await page.evaluate(sondaPantalla)
    c.evidencia.elementos = pantalla.pasos + pantalla.campos + pantalla.tarjetas

    // ANCLA — se llegó al paso 8 (si no, no se está midiendo esta pantalla).
    if (!c.afirmar('ANCLA · se aterriza en el paso 8', pantalla.pasoActivo === 7,
      `aterrizó en el índice ${pantalla.pasoActivo}`)) return c

    const aviso = await page.$eval('[data-testid="paso8-sin-nada-que-elegir"]', n => n.textContent.trim())
      .catch(() => null)
    c.afirmar('sin nada que elegir, la pantalla lo DICE',
      !!aviso && aviso.length > 20,
      `el aviso leído fue ${JSON.stringify(aviso)}: en silencio, la familia lee «no me deja elegir la forma de pago» — que es exactamente lo que pasó`)
    c.afirmar('y no ofrece un desplegable vacío',
      !(await page.$('[data-testid="paso8-modalidad-selector"]')),
      'se pintó el desplegable de elegir sin ninguna forma de pago que ofrecer')
  } finally {
    scenario.sinSuscripcion = null
  }
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

  // ⭐ 0º.vicies.septies (2026-08-22) — EL APOYO EDUCATIVO SE RECUPERA.
  // Es dato de SALUD de un menor. Hasta hoy el KMS no lo mandaba NUNCA en la hidratación
  // (medido: cero apariciones de `neae` en `enr/wizard-datalayer.gs`), así que la pantalla
  // salía vacía por mucho que su re-sembrado —que SÍ existe— funcionara. Se entra de nuevo
  // con el servidor mandándolo y se comprueba en la pantalla.
  scenario.neaeDelServidor = true
  try {
    if (await entrarPorElEnlace(c, page, base)) {
      for (let i = 0; i < 6 && (await dondeEstoy(page)) > 3; i++) {
        const atras = await page.$('button.btn-secondary-kis:not(:has(i.bi-pencil))')
        if (!atras) break
        await atras.click()
        await page.waitForTimeout(250)
      }
      await desbloquear(page)
      await page.waitForTimeout(LATENCY + 600)
      const condiciones = await page.$$('[data-testid="paso4-neae-condicion"]')
      const apoyos      = await page.$$('[data-testid="paso4-neae-apoyo"]')
      // ⚠️ LO QUE ESTA AFIRMACIÓN PRUEBA, DICHO CON PRECISIÓN: que el apoyo educativo VIAJA
      // en la hidratación y la pantalla lo pinta — que es EXACTAMENTE el defecto medido (el
      // KMS no lo mandaba nunca). **NO prueba el re-sembrado tardío**: se comprobó rompiendo
      // el `useEffect` a propósito y esta afirmación siguió VERDE, porque al volver a entrar
      // la pantalla se monta con la hidratación ya servida y el inicializador del estado la
      // recoge sin necesidad del efecto. Se dice aquí para que nadie la cuente como lo que
      // no es.
      c.afirmar('el apoyo educativo que manda el servidor SE VE en la pantalla de salud',
        condiciones.length > 0 && apoyos.length > 0,
        `se pintaron ${condiciones.length} condición(es) y ${apoyos.length} apoyo(s): con cero, la familia ve su bloque VACÍO y al guardar puede dar de baja lo que hay`)

      // ⭐ 0º.vicies.nonies (decisión de Diego, opción (b), 2026-08-22) — EL VACIADO SE
      // DECLARA, Y ES POR PERSONA. El KMS no añade: SUSTITUYE, así que una ficha vacía retira
      // lo que hubiera. Se vacía el bloque de UN SOLO hijo y se mira lo que SALE hacia el
      // servidor: el suyo tiene que ir declarado y el del hermano NO.
      //
      // ⚠️ Esta batería NO ejecuta el KMS ni `backend/Code.js` ⇒ aquí se mide lo que manda el
      // NAVEGADOR. La mitad del servidor (que sin declaración NO se da de baja nada) se midió
      // aparte, ejecutando `enr_persistNeae_`/`enr_neaeSePuedeVaciar_` reales con dobles.
      const cuerposDeSalud = []
      const espiarSalud = (req) => {
        if (!/\/__gas/.test(req.url())) return
        let body = null
        try { body = JSON.parse(req.postData() || '{}') } catch { return }
        if (body && body.action === 'saveNeae') cuerposDeSalud.push(body)
      }
      page.on('request', espiarSalud)
      try {
        const fichas = await page.$$eval('[data-testid="paso4-neae-ficha"]',
          els => els.map(e => e.getAttribute('data-person-id')))
        if (!c.afirmar('la pantalla enseña el apoyo educativo de MÁS DE UN hijo (si no, «por persona» no se comprueba)',
          fichas.length >= 2 && fichas[0] && fichas[1] && fichas[0] !== fichas[1],
          `las fichas de apoyo educativo en pantalla fueron ${JSON.stringify(fichas)}`)) return c

        // Se vacía SOLO el bloque del PRIMER hijo, de una en una: cada aspa re-dibuja el
        // bloque, así que recorrer una lista tomada de golpe deja la mitad sin pulsar.
        let quitados = 0
        for (let k = 0; k < 40; k++) {
          const hecho = await page.evaluate(() => {
            const ficha = document.querySelector('[data-testid="paso4-neae-ficha"]')
            if (!ficha) return false
            const caja = ficha.querySelector(
              '[data-testid="paso4-neae-condicion"], [data-testid="paso4-neae-apoyo"]')
            if (!caja) return false
            const x = caja.querySelector('button')
            if (!x) return false
            x.click()
            return true
          })
          if (!hecho) break
          quitados++
          await page.waitForTimeout(120)
        }
        await page.waitForTimeout(300)
        const quedanEnElPrimero = await page.$$eval('[data-testid="paso4-neae-ficha"]',
          els => els[0] ? els[0].querySelectorAll(
            '[data-testid="paso4-neae-condicion"], [data-testid="paso4-neae-apoyo"]').length : -1)
        c.afirmar('la familia puede QUITAR su apoyo educativo y se queda quitado en la pantalla',
          quitados > 0 && quedanEnElPrimero === 0,
          `se pulsaron ${quitados} aspa(s) y quedan ${quedanEnElPrimero} en el bloque del primer hijo: si no se puede vaciar a propósito, esta protección habría roto el caso legítimo`)

        cuerposDeSalud.length = 0
        if (await continuar(c, page, 4, 'salud tras vaciar el bloque de un hijo')) {
          await page.waitForTimeout(LATENCY + 700)
        }
        const enviadas = cuerposDeSalud.flatMap(b => (b.neae || []))
        c.evidencia.llamadas = Math.max(c.evidencia.llamadas || 0, cuerposDeSalud.length)
        const vaciada = enviadas.find(n => n.person_id === fichas[0])
        const intacta = enviadas.find(n => n.person_id === fichas[1])
        const resumen = JSON.stringify(enviadas.map(n => ({
          p: String(n.person_id || '').slice(0, 8), v: n.vaciado_declarado,
          cond: (n.conditions || []).length, sup: (n.supports || []).length })))

        // (a) VACIAR A PROPÓSITO SIGUE FUNCIONANDO: es lo único que el servidor acepta como
        // orden de retirar, así que sin la declaración la familia vería volver lo que quitó.
        c.afirmar('vaciar A PROPÓSITO viaja DECLARADO (es lo único que el servidor acepta)',
          !!vaciada && vaciada.vaciado_declarado === true &&
          (vaciada.conditions || []).length === 0 && (vaciada.supports || []).length === 0,
          `lo enviado fue ${resumen}: sin la declaración el servidor CONSERVA, y la familia que quitó su condición a propósito la vería volver`)

        // (b) EL HERMANO QUE NADIE TOCÓ NO VIENE DECLARADO. Si la marca fuera por defecto, la
        // protección no existiría: un «Continuar» distraído volvería a poder retirar la
        // logopedia de un menor.
        if (!c.afirmar('el hijo cuyo bloque NADIE tocó también viaja (para poder comprobarlo)',
          !!intacta, `lo enviado fue ${resumen}: sin su ficha, esta comprobación pasaría en vacío`)) return c
        c.afirmar('el hijo cuyo bloque NADIE tocó NO viene declarado como vaciado',
          intacta.vaciado_declarado !== true,
          `lo enviado fue ${resumen}: con la marca puesta por defecto, un «Continuar» distraído volvería a poder retirar la logopedia de un menor`)
      } finally {
        page.off('request', espiarSalud)
      }
    }
  } finally {
    scenario.neaeDelServidor = false
  }
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

  // ── ③51 (2026-08-16) · EL CONTROL SALE DE LO DECLARADO, NO DEL CÓDIGO DEL TIPO ───────
  // El simulado sirve DOS preguntas del MISMO tipo (`TEXT`): una DECLARA `ui_widget:'input'`
  // y la otra NO declara nada. Si la pantalla siguiera eligiendo por el código del tipo, las
  // dos saldrían iguales —dos áreas de texto— y esto sale ROJO. Con la declaración honrada
  // sale una caja de una línea Y un área de texto, y esa mezcla acredita a la vez las dos
  // mitades: que lo declarado manda, y que la CAÍDA sigue viva (sin ella, un control que la
  // pantalla no sepa pintar dejaría a la familia sin poder contestar).
  const controles = await page.evaluate(() => ({
    unaLinea: document.querySelectorAll('input[type="text"]').length,
    areas:    document.querySelectorAll('textarea').length,
  }))
  c.afirmar('(a.bis) el control lo elige lo DECLARADO, no el código del tipo',
    controles.unaLinea >= 1 && controles.areas >= 1,
    `dos preguntas del MISMO tipo, una con control declarado ('input') y otra sin declarar: ` +
    `se esperaba al menos una caja de una línea Y un área de texto, y salieron ` +
    `cajas=${controles.unaLinea} áreas=${controles.areas}. Todo áreas ⇒ la pantalla sigue ` +
    `eligiendo por el código del tipo y ③51 no tiene efecto; todo cajas ⇒ se perdió la caída.`)

  // ── 0º.tricies.decies (2026-08-22) · LAS PREGUNTAS SE AGRUPAN POR SUJETO ─────────────
  // Diego: «tampoco salen agrupadas… lo lógico es que dentro de cada pill haya un área de
  // agrupación por sujeto». El simulado sirve DOS preguntas de alumno y el expediente tiene
  // DOS alumnos, así que la secuencia observable distingue las dos formas:
  //   intercalado (lo de antes) → Jara·P1 · Pepito·P1 · Jara·P2 · Pepito·P2  (4 encabezados)
  //   agrupado    (lo de ahora) → Jara·[P1,P2] · Pepito·[P1,P2]              (2 encabezados)
  // Se mide sobre el TEXTO en orden de documento, no sobre un atributo: así la afirmación
  // habla del comportamiento y no de cómo esté marcado el HTML por dentro.
  // ⛔ POR TARJETA, no por página (`0º.tricies.vicies.septies`, 2026-08-26). El catálogo del
  // robot sirve ahora DOS conjuntos —y cada conjunto es una tarjeta—, así que un mismo hijo
  // aparece legítimamente una vez en cada uno. Medir sobre la página entera diría que su
  // nombre «se repite» cuando lo que pasa es que hay dos conjuntos: la afirmación de
  // agrupación habla de lo que ocurre DENTRO de un conjunto, y así se mide.
  const tarjetas = await page.evaluate(() => {
    const out = [];
    document.querySelectorAll('.kis-card').forEach(card => {
      const fichas = [];
      // `0º.tricies.sexdecies`: con VARIOS sujetos el encabezado es la PASTILLA; con uno
      // solo sigue siendo la línea gris de siempre. Se aceptan las dos formas, porque lo
      // que esta sonda mide es el ORDEN de lo que se lee, no cómo esté marcado el HTML.
      card.querySelectorAll(
        '[data-testid="sujeto-separador"], p, label.form-label'
      ).forEach(el => {
        if (el.getAttribute('data-testid') === 'sujeto-separador') {
          fichas.push({ t: 'sujeto', v: (el.textContent || '').trim() });
          return;
        }
        if (el.tagName === 'P') {
          if (el.querySelector('i.bi-person, i.bi-person-fill')) {
            fichas.push({ t: 'sujeto', v: (el.textContent || '').trim() });
          }
          return;
        }
        fichas.push({ t: 'pregunta', v: (el.textContent || '').trim() });
      });
      if (fichas.length) out.push(fichas);
    });
    return out;
  })
  const orden = tarjetas[0] || []
  const nombres = orden.filter(f => f.t === 'sujeto').map(f => f.v)
  // ANCLA: sin encabezados de sujeto las tres afirmaciones de abajo pasarían EN VACÍO —
  // que es exactamente lo que pasaba antes de este cambio, cuando el catálogo del robot
  // era general entero y la pantalla no pintaba ni un nombre.
  if (c.afirmar('(d.0) ancla — el paso 5 pinta preguntas CON SUJETO',
    nombres.length >= 2,
    `se leyeron ${nombres.length} encabezado(s) de sujeto: sin ellos, agrupar no se puede medir`)) {

    const nombresPorTarjeta = tarjetas.map(f => f.filter(x => x.t === 'sujeto').map(x => x.v))
    c.afirmar('(d.1) el nombre de cada alumno se pinta UNA sola vez DENTRO de su conjunto',
      nombresPorTarjeta.every(ns => new Set(ns).size === ns.length),
      `los encabezados por conjunto fueron ${JSON.stringify(nombresPorTarjeta)}: un nombre ` +
      `repetido DENTRO de un conjunto significa que las preguntas siguen intercaladas y la ` +
      `familia salta de un hijo a otro`)

    // Cada sujeto arrastra TODAS sus preguntas: se cuentan las que van entre su encabezado
    // y el siguiente. Intercalado da 1 por encabezado; agrupado da las 2 del catálogo.
    const porSujeto = []
    orden.forEach(f => {
      if (f.t === 'sujeto') porSujeto.push({ nombre: f.v, preguntas: [] })
      else if (porSujeto.length) porSujeto[porSujeto.length - 1].preguntas.push(f.v)
    })
    // CUATRO por alumno desde `0º.tricies.vicies.decies`: las dos de texto de siempre más las
    // dos de redondeles que se dieron de alta para poder ver el defecto de los grupos.
    // Intercalado daría 1 por encabezado; agrupado, las 4 del conjunto.
    c.afirmar('(d.2) las preguntas de un mismo alumno salen SEGUIDAS, bajo su nombre',
      porSujeto.length > 0 && porSujeto.every(s => s.preguntas.length === 4),
      `bajo cada nombre se leyeron ${JSON.stringify(porSujeto.map(s => s.preguntas.length))} ` +
      `pregunta(s) (se esperaban 4 por alumno): ${JSON.stringify(porSujeto)}`)

    // ── 0º.tricies.sexdecies (2026-08-22) · SE VE DÓNDE ACABA UN HERMANO Y EMPIEZA EL
    // OTRO. Diego: «es difícil visualmente separar un hermano del otro. La letra es muy
    // pequeña, no hay un elemento (un pill) que claramente separe visualmente lo que
    // corresponde a cada hermano». Agrupar (d.*) ya estaba; lo que faltaba era VERLO.
    // Se mide lo que el navegador PINTA de verdad (estilo calculado), no la clase CSS:
    // una clase que no exista en `theme.css` el navegador la ignora EN SILENCIO.
    const separadores = await page.evaluate(() => {
      const out = [];
      document.querySelectorAll('[data-qb-sujeto]').forEach(bloque => {
        const cab = bloque.querySelector('[data-testid="sujeto-separador"]');
        const eb = getComputedStyle(bloque);
        const ec = cab ? getComputedStyle(cab) : null;
        out.push({
          nombre:   cab ? (cab.textContent || '').trim() : null,
          bordeIzq: parseFloat(eb.borderLeftWidth) || 0,
          fondo:    ec ? ec.backgroundColor : null,
          tamano:   ec ? parseFloat(ec.fontSize) : 0,
          peso:     ec ? Number(ec.fontWeight) || 0 : 0,
        });
      });
      return out;
    })
    const transparente = (c) => !c || c === 'transparent' || /rgba\(0, 0, 0, 0\)/.test(c)

    c.afirmar('(e.1) el nombre de cada alumno se pinta como una PASTILLA, no como un texto suelto',
      separadores.length >= 2 &&
      separadores.every(s => s.nombre && !transparente(s.fondo) && s.tamano >= 15 && s.peso >= 700),
      `los separadores leídos fueron ${JSON.stringify(separadores)}: se esperaba, en cada alumno, ` +
      `un elemento con nombre, fondo propio, letra de al menos 15px y peso 700. Sin eso vuelve ` +
      `el texto gris de 0.8rem que Diego no podía distinguir a media pantalla`)

    c.afirmar('(e.2) lo que corresponde a cada alumno queda ENCERRADO en su propia área',
      separadores.length >= 2 && separadores.every(s => s.bordeIzq >= 2),
      `los bordes de agrupación leídos fueron ${JSON.stringify(separadores.map(s => s.bordeIzq))}: ` +
      `sin un elemento que delimite el bloque, las preguntas de los dos hermanos siguen ` +
      `corriendo seguidas y solo las separa una línea de texto`)

    // ── `0º.tricies.vicies.septies` (2026-08-26) · LA MISMA PANTALLA, UN SOLO ASPECTO ───
    // Diego, con captura: «Jara se ve en pequeñito, pero en los paneles anteriores habíamos
    // puesto un pill más resaltado». El conjunto `set-e2e-2` («7 años o más») deja fuera al
    // hermano pequeño POR SUS CONDICIONES ⇒ solo le entra UN alumno. Cuando «¿hay más de un
    // sujeto?» se calculaba DENTRO de cada conjunto, ese caía a la línea gris mientras el de
    // al lado sacaba pastilla. Se comprueba EN EL BLOQUE de ese conjunto, no en el montón:
    // así el rojo nombra el caso en vez de decir «alguno de los tres no tiene pastilla».
    const soloUno = await page.evaluate(() => {
      const cards = [...document.querySelectorAll('.kis-card')];
      // La tarjeta con UN solo bloque de sujeto habiendo dos hermanos en la solicitud: ésa
      // es la del conjunto que por edad deja a uno fuera.
      const card = cards.filter(x => x.querySelectorAll('[data-qb-sujeto]').length === 1).pop();
      if (!card) return null;
      const bloque = card.querySelector('[data-qb-sujeto]');
      const cab = bloque.querySelector('[data-testid="sujeto-separador"]');
      const eb = getComputedStyle(bloque);
      const ec = cab ? getComputedStyle(cab) : null;
      return {
        conjunto: (card.querySelector('h3') || {}).textContent || '',
        nombre:   cab ? (cab.textContent || '').trim() : null,
        bordeIzq: parseFloat(eb.borderLeftWidth) || 0,
        fondo:    ec ? ec.backgroundColor : null,
        tamano:   ec ? parseFloat(ec.fontSize) : 0,
        peso:     ec ? Number(ec.fontWeight) || 0 : 0,
      };
    })
    if (c.afirmar('(e.2.bis.0) ancla — hay un conjunto al que por sus condiciones solo le entra UN hermano',
      !!soloUno,
      'no se encontró ningún conjunto con un solo bloque de sujeto: sin él, la afirmación de abajo pasaría EN VACÍO')) {
      c.afirmar('(e.2.bis) un conjunto con UN SOLO hermano lleva la MISMA pastilla que los demás',
        !!soloUno.nombre && !transparente(soloUno.fondo) && soloUno.tamano >= 15 &&
        soloUno.peso >= 700 && soloUno.bordeIzq >= 2,
        `el conjunto ${JSON.stringify(soloUno.conjunto)} pintó ${JSON.stringify(soloUno)}: ` +
        `si la cuenta se hace DENTRO del conjunto, éste cae a la línea gris mientras el de al ` +
        `lado saca pastilla — y la familia ve la misma pantalla con dos aspectos`)
    }

    // ── ⛔⛔ `0º.tricies.vicies.decies` (2026-08-26) · LOS REDONDELES NO SE PISAN ─────────
    // Diego: «si selecciono una respuesta de la primera pregunta, cuando selecciono una
    // respuesta de la segunda, se desactiva lo seleccionado en la primera».
    //
    // El nombre del grupo de redondeles agrupa EN TODO EL DOCUMENTO. Con el nombre puesto
    // solo por pregunta, las dos copias de la MISMA pregunta —una por hijo, desde que se
    // agrupa por sujeto— son UN SOLO grupo para el navegador: marcar la de un hijo desmarca
    // la del otro. Y no se recupera solo: el redondel está gobernado por React, que no ve
    // el cambio y no lo repone.
    //
    // ⚠️ Se mide EL COMPORTAMIENTO (marcar y volver a leer), no el atributo `name`: lo que
    // rompe a la familia es perder lo que contestó, no cómo se llame el grupo por dentro.
    const leerRedondeles = () => page.evaluate(() => {
      const out = [];
      document.querySelectorAll('[data-qb-sujeto]').forEach(bloque => {
        const grupos = new Map();
        bloque.querySelectorAll('input[type=radio]').forEach(r => {
          if (!grupos.has(r.name)) grupos.set(r.name, []);
          grupos.get(r.name).push(r.checked);
        });
        if (!grupos.size) return;
        out.push({
          sujeto: bloque.getAttribute('data-qb-sujeto'),
          grupos: [...grupos.entries()].map(([name, opts]) => ({
            name, marcada: opts.findIndex(Boolean),
          })),
        });
      });
      return out;
    })
    const marcar = (b, g, o) => page.evaluate(({ b, g, o }) => {
      const bloques = [...document.querySelectorAll('[data-qb-sujeto]')]
        .filter(x => x.querySelector('input[type=radio]'));
      const bl = bloques[b];
      if (!bl) return false;
      const grupos = new Map();
      bl.querySelectorAll('input[type=radio]').forEach(r => {
        if (!grupos.has(r.name)) grupos.set(r.name, []);
        grupos.get(r.name).push(r);
      });
      const arr = [...grupos.values()][g];
      if (!arr || !arr[o]) return false;
      arr[o].click();
      return true;
    }, { b, g, o })

    const antesDeMarcar = await leerRedondeles()
    if (c.afirmar('(f.0) ancla — los DOS hermanos tienen preguntas de redondeles',
      antesDeMarcar.length >= 2 && antesDeMarcar.every(x => x.grupos.length >= 2),
      `los bloques con redondeles fueron ${JSON.stringify(antesDeMarcar)}: hacen falta DOS ` +
      `alumnos con DOS preguntas de redondeles cada uno, o las afirmaciones de abajo pasan en vacío`)) {

      // (f.1) DENTRO del mismo hijo: contestar la segunda no puede desmarcar la primera.
      await marcar(0, 0, 0)
      await page.waitForTimeout(150)
      await marcar(0, 1, 1)
      await page.waitForTimeout(250)
      let ahora = await leerRedondeles()
      c.afirmar('(f.1) contestar la SEGUNDA pregunta no desmarca la PRIMERA del mismo alumno',
        ahora[0] && ahora[0].grupos[0].marcada === 0 && ahora[0].grupos[1].marcada === 1,
        `tras marcar las dos, el primer alumno quedó ${JSON.stringify(ahora[0])}: ` +
        `«marcada:-1» es una respuesta que la familia dio y la pantalla le borró`)

      // (f.2) Y ENTRE HERMANOS: es la copia de la MISMA pregunta, el caso que rompe.
      await marcar(1, 0, 2)
      await page.waitForTimeout(250)
      ahora = await leerRedondeles()
      const nombresDeGrupo = ahora.map(x => x.grupos.map(g => g.name))
      c.afirmar('(f.2) contestar por un hermano NO desmarca lo que se contestó por el otro',
        ahora[0] && ahora[1] &&
        ahora[0].grupos[0].marcada === 0 && ahora[0].grupos[1].marcada === 1 &&
        ahora[1].grupos[0].marcada === 2,
        `tras contestar por el segundo hermano quedó ${JSON.stringify(ahora)} ` +
        `(nombres de grupo: ${JSON.stringify(nombresDeGrupo)}): si el nombre del grupo no ` +
        `lleva a la persona, las dos copias de la misma pregunta son UN SOLO grupo para el ` +
        `navegador y contestar por un hijo borra lo del otro`)
    }

    // ── (d.3) LA CLAVE DE LA RESPUESTA NO CAMBIÓ AL AGRUPAR ──────────────────────────
    // `Step5Questions.handleNext` PARTE la clave (`question_id__sujeto`) para componer el
    // `respondent_id` de cada fila. Si al agrupar por sujeto se hubiera tocado esa clave,
    // la respuesta de un alumno se guardaría contra otro sujeto —o contra el expediente—
    // y la familia perdería lo que escribió. Se comprueba donde se ve: en lo que SALE.
    const antesDeGuardar = llamadas('saveResponses').length
    for (const t of await page.$$('[data-qb-sujeto] textarea')) {
      try { await t.fill('Respuesta del robot para este alumno.') } catch { /* bloqueado */ }
    }
    await page.click(BTN_SIGUIENTE)
    const t0Resp = Date.now()
    while (llamadas('saveResponses').length === antesDeGuardar && Date.now() - t0Resp < 15000) {
      await page.waitForTimeout(200)
    }
    const sujetosQueViajaron = new Set()
    llamadas('saveResponses').slice(antesDeGuardar).forEach(l =>
      ((l.payload && l.payload.responses) || []).forEach(
        r => r && r.respondent_id && sujetosQueViajaron.add(r.respondent_id)))
    c.afirmar('(d.3) la respuesta de cada alumno viaja con SU identificador',
      sujetosQueViajaron.has(FIXTURE.applicantId) && sujetosQueViajaron.has(FIXTURE.applicant2Id),
      `los sujetos que viajaron fueron ${JSON.stringify([...sujetosQueViajaron])}: se esperaban ` +
      `los DOS alumnos. Si falta alguno, la clave «question_id__sujeto» dejó de componerse ` +
      `por persona y las respuestas se atribuyen a quien no es`)
    // ⛔ Y SE ESPERA A QUE NO QUEDE NADA EN VUELO ANTES DE SEGUIR. La fase (b) tira el
    // contexto de la página con `about:blank`, y un `fetch` a medias lo ABORTA: la
    // aplicación registra un «network/fetch error» que NO es suyo sino del robot, y este
    // recorrido tiene declarado un único error de consola esperado (el del catálogo
    // caído), así que ese ruido lo tumbaba entero. MEDIDO: sin esta línea el camino salió
    // ROJO con «network/fetch error» en saveResponses Y en saveStep, con las cuatro
    // afirmaciones de arriba en VERDE. Es el mismo motivo por el que existen `drenar` y
    // `esperarSilencioDeRed` en este fichero.
    await esperarSilencioDeRed(15000, 800)
  }

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

  // ── (e.3) CON UN SOLO ALUMNO EL SEPARADOR NO ESTORBA (0º.tricies.sexdecies) ─────────
  // Sin nada que separar, una pastilla grande es ruido: la pantalla vuelve a la línea de
  // siempre. Se mide con una familia de UN solo hijo — con la de dos, esta comprobación
  // pasaría en vacío, que es peor que no tenerla.
  scenario.unSoloAlumno = true
  try {
    // ⛔ SE ESPERA A QUE NO QUEDE NADA EN VUELO ANTES DE TIRAR LA PÁGINA. `about:blank`
    // ABORTA cualquier `fetch` a medias y la aplicación registra un «network/fetch error»
    // que NO es suyo sino del robot; este recorrido declara UN solo error de consola
    // esperado (el del catálogo caído), así que ese ruido lo tumbaba ENTERO — y de forma
    // INTERMITENTE, que es peor. Medido el 2026-08-22: el rojo era «gasCall warmBundle:
    // network/fetch error». Mismo motivo que el drenado de (d.3).
    await esperarSilencioDeRed(15000, 800)
    await page.evaluate(() => { try { sessionStorage.clear(); localStorage.clear() } catch {} })
    await page.goto('about:blank')
    if (!await entrarPorElEnlace(c, page, base)) return c
    if (!await irAPreguntas(c, page)) return c
    await page.waitForTimeout(LATENCY + 900)
    const solo = await page.evaluate(() => ({
      bloques:      document.querySelectorAll('[data-qb-sujeto]').length,
      pastillas:    document.querySelectorAll('[data-testid="sujeto-separador"]').length,
      lineaDeSiempre: !!document.querySelector('.kis-card p i.bi-person, .kis-card p i.bi-person-fill'),
    }))
    // `0º.tricies.vicies.septies`: con DOS conjuntos en el catálogo, un solo alumno pinta un
    // bloque POR CONJUNTO (los dos suyos). Lo que se afirma abajo sigue siendo lo mismo: con
    // UN SOLO hijo en toda la solicitud no hay nada que separar, así que NINGÚN bloque —de
    // ningún conjunto— lleva pastilla.
    if (c.afirmar('(e.3.0) ancla — con un solo alumno el paso 5 sigue pintando su bloque de sujeto',
      solo.bloques >= 1,
      `se pintaron ${solo.bloques} bloque(s) de sujeto con un solo alumno: sin ninguno, lo de abajo pasaría en vacío`)) {
      c.afirmar('(e.3) con UN SOLO alumno no se pinta la pastilla: se conserva la línea de siempre',
        solo.pastillas === 0 && solo.lineaDeSiempre,
        `pastillas=${solo.pastillas} · línea de siempre=${solo.lineaDeSiempre}: con un solo hijo no hay ` +
        `nada que separar, así que el separador con peso sobra — y el nombre no puede desaparecer`)
    }
    // Y también al SALIR: el recorrido siguiente navega, y una petición de éste a medias
    // se abortaría y contaría como error de consola de un camino que ya terminó.
    await esperarSilencioDeRed(15000, 800)
  } finally {
    scenario.unSoloAlumno = false
  }
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
 * AVISAR AL OTRO TUTOR — DL-E49 §4/§9, pedido por Diego el 2026-08-16.
 *
 * El defecto que cierra, MEDIDO antes de construir: la familia YA podía declarar al segundo
 * tutor con su correo, y ese tutor YA podía entrar pidiendo su enlace en la portada — pero
 * **nadie se lo decía**. Ningún camino del asistente le mandaba nada, ni al declararlo, ni
 * al guardar, ni al enviar. ⇒ si la madre no le avisaba por su cuenta, la solicitud se
 * quedaba esperando su parte indefinidamente (DL-E49 §1, que sí está construido y muerde).
 *
 * Afirma TRES cosas, y en la pantalla:
 *   (a) el botón está **junto al tutor que la familia acaba de añadir**, y NO junto a la
 *       ficha del que está rellenando — avisarse a uno mismo no es nada;
 *   (b) al pulsarlo **sale la petición** con la ficha de ESE tutor y con el enlace de la
 *       familia (el servidor deriva de ahí el expediente y resuelve su correo; por aquí no
 *       viaja ninguna dirección);
 *   (c) si el servidor **no pudo mandarlo, NO se dice «enviado»** — y ése es el fondo del
 *       asunto: una pantalla que finge deja a la familia esperando a un tutor al que nunca
 *       le llegó nada.
 */
async function caminoAvisarAlOtroTutor(page, base) {
  const c = new Camino('avisar-al-otro-tutor')
  scenario.stage = 'hasta_preguntas'
  scenario.avisarMode = 'ok'

  let llamadas = 0
  let ultimoCuerpo = null
  const espiar = (req) => {
    if (!/\/__gas/.test(req.url())) return
    let body = null
    try { body = JSON.parse(req.postData() || '{}') } catch { return }
    if (body && body.action === 'avisarATutor') { llamadas++; ultimoCuerpo = body }
  }
  page.on('request', espiar)
  const limpiar = () => page.off('request', espiar)

  /** Los botones de avisar que hay ahora mismo en la pantalla. */
  const botonesAvisar = () => page.$$('button.add-btn:has(i.bi-send)')

  try {
    if (!await entrarPorElEnlace(c, page, base)) return c
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

    // ── (a) el botón sale con el SEGUNDO tutor, no con el que rellena ────────────────
    // DL-E49 §2: el servidor solo enseña al tutor que mira, así que de entrada hay uno y
    // NO puede haber botón. Aparece cuando la familia añade al otro — que es justo el
    // momento en el que Diego lo pidió («cuando María mete a Juan…»).
    const antesDeAnadir = (await botonesAvisar()).length
    if (!c.afirmar('sin un segundo tutor no se ofrece avisar a nadie', antesDeAnadir === 0,
      `había ${antesDeAnadir} botón(es) de avisar con un solo tutor en pantalla: se estaría ofreciendo avisarse a uno mismo`)) return c

    const anadirTutor = await page.$('button.add-btn:has-text("tutor"), button.add-btn:has-text("guardian")')
    if (!c.afirmar('se puede añadir un segundo tutor', !!anadirTutor,
      'no se encontró el botón de añadir tutor: sin él no hay a quién avisar')) return c
    await anadirTutor.click()
    await page.waitForTimeout(300)

    // Su correo, tal y como lo hace la familia: la ficha nace SIN ninguno, así que primero
    // se pulsa «añadir correo» y luego se escribe. Sin correo la pantalla explica que falta
    // —en vez de ofrecer un botón que solo puede fallar—, y eso también es lo correcto.
    // ⚠️ Las fichas de ALUMNO también son `.dynamic-section` y van DESPUÉS, así que «la
    // última» es la de un menor, no la del tutor. Se acota por el rótulo — si no, las tres
    // afirmaciones siguientes medirían la ficha equivocada y pasarían en vacío.
    const todas = await page.$$('.dynamic-section')
    const seccionesTutor = []
    for (const s of todas) {
      const rotulo = await s.$eval('.dynamic-section-title', el => el.textContent || '').catch(() => '')
      if (/Tutor|Guardian/i.test(rotulo)) seccionesTutor.push(s)
    }
    if (!c.afirmar('se distingue la ficha del tutor añadido', seccionesTutor.length >= 2,
      `se encontraron ${seccionesTutor.length} fichas de tutor: el segundo no llegó a pintarse`)) return c
    const suSeccion = seccionesTutor[seccionesTutor.length - 1]
    const sinCorreoTodavia = await suSeccion.$$('button.add-btn:has(i.bi-send)')
    c.afirmar('sin correo NO se ofrece avisar', sinCorreoTodavia.length === 0,
      'se ofrecía avisar a un tutor sin correo declarado: el aviso no podría salir a ninguna parte')

    const anadirCorreo = await suSeccion.$('button.add-btn:has(i.bi-plus)')
    if (!c.afirmar('se le puede añadir un correo', !!anadirCorreo,
      'no se encontró el botón de añadir correo en la ficha del tutor añadido')) return c
    await anadirCorreo.click()
    await page.waitForTimeout(250)
    const suCorreo = await suSeccion.$('input[type="email"]')
    if (!c.afirmar('hay dónde escribir su correo', !!suCorreo,
      'no apareció el campo de correo tras pulsar añadir')) return c
    await suCorreo.fill('juan.tutor2@ejemplo.invalid')
    await page.waitForTimeout(200)

    const botones = await botonesAvisar()
    if (!c.afirmar('el tutor recién añadido tiene botón de avisar', botones.length === 1,
      `se pintaron ${botones.length} botones de avisar: se espera exactamente uno, el del tutor añadido`)) return c

    // ── (b) al pulsar, SALE la petición con la ficha de ese tutor ────────────────────
    await botones[0].click()
    await page.waitForTimeout(900)
    if (!c.afirmar('pulsar avisa al servidor', llamadas >= 1,
      'no salió ninguna petición `avisarATutor`: el botón no haría absolutamente nada')) return c
    c.afirmar('la petición dice A QUIÉN se avisa y de qué solicitud',
      !!(ultimoCuerpo && ultimoCuerpo.person_id && ultimoCuerpo.resume_token),
      `person_id recibido: ${ultimoCuerpo && ultimoCuerpo.person_id} · resume_token: ${!!(ultimoCuerpo && ultimoCuerpo.resume_token)}`)
    // Y NO viaja el correo: el servidor lo resuelve de lo que la familia ya declaró, así
    // que por esta puerta no se puede mandar el enlace a una dirección arbitraria.
    c.afirmar('la petición NO lleva una dirección de correo',
      !!(ultimoCuerpo && !ultimoCuerpo.email && !ultimoCuerpo.destino),
      'la petición llevaba un correo: por ahí se podría mandar el enlace a quien fuera')

    const textoOk = await page.evaluate(() => document.body.innerText || '')
    c.afirmar('se ve que el aviso salió, y a quién',
      /Aviso enviado|Notification sent/i.test(textoOk),
      'la pantalla no confirma el envío: la familia no sabe si su tutor recibió el enlace')

    // ── (c) si NO se pudo mandar, NO se dice «enviado» ───────────────────────────────
    scenario.avisarMode = 'no_se_pudo'
    const botones2 = await botonesAvisar()
    if (botones2.length) {
      await botones2[0].click()
      await page.waitForTimeout(900)
      const texto2 = await page.evaluate(() => document.body.innerText || '')
      c.afirmar('un envío fallido NO se pinta como enviado',
        /No se ha podido enviar|could not be sent/i.test(texto2),
        'la pantalla no dice que falló: la familia se queda esperando a un tutor al que no le llegó nada')
    }
    return c
  } catch (e) {
    c.afirmar('el camino termina sin reventar', false, String((e && e.message) || e))
    return c
  } finally {
    scenario.avisarMode = 'ok'
    limpiar()
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
 * DL-E49 §8 · EDITAR DESPUÉS DE ENVIAR INVALIDA ESE ENVÍO, Y LA FAMILIA SE ENTERA.
 *
 * ── Qué cubría antes, y por qué ya no puede ────────────────────────────────────────
 * Este camino comprobaba el RECHAZO: el KMS descartaba el cuestionario del tutor que ya
 * había enviado su parte (DL-E49 §6) y el asistente tenía que decirlo. **Diego cambió el
 * criterio el 2026-08-24**: ese tutor **SÍ** puede seguir editando; lo que ocurre es que
 * **su envío queda invalidado** hasta que vuelva a enviar. El rechazo se retiró de los dos
 * lados, así que seguir comprobándolo sería medir un código que ya no puede llegar.
 *
 * ── Qué comprueba ahora ────────────────────────────────────────────────────────────
 * Lo mismo que importaba entonces —que la familia SE ENTERE de lo que le pasa a su
 * guardado— pero del comportamiento nuevo:
 *   (1) el guardado del tutor que ya envió **ENTRA**: no hay ningún aviso de error;
 *   (2) cuando el trabajo cuenta que invalidó su envío, la pantalla **se lo dice**;
 *   (3) el aviso dice QUÉ tiene que hacer (volver a enviar), no solo que algo pasó;
 *   (4) **no bloquea nada**: no hay estado de error ni botón de reintentar, porque no hay
 *       nada que reintentar — lo que tiene que hacer es enviar otra vez;
 *   (5) el aviso **no cuesta una petición aparte**: sale del canal que ya preguntaba cómo
 *       acabaron los guardados. Una consulta propia se aborta al cambiar de pantalla y deja
 *       en la consola de la familia un `network/fetch error` que no es suyo (`0º.septies`) —
 *       y eso lo cazó esta misma batería cuando se intentó de la otra forma.
 */
async function caminoRespuestasRechazadasSeDicen(page, base) {
  const c = new Camino('respuestas-rechazadas-se-dicen')
  scenario.stage = 'hasta_preguntas'

  try {
    if (!await entrarPorElEnlace(c, page, base)) return c
    const pantalla = await page.evaluate(sondaPantalla)
    c.evidencia.elementos = pantalla.pasos + pantalla.campos
    c.evidencia.llamadas = calls.length
    if (REAL) {
      // Contra el sistema de verdad haría falta un expediente con DOS tutores en el que uno
      // ya hubiera enviado su parte, y dejarlo así. No se afloja nada para que pase: se
      // declara descubierto y se dice por qué.
      c.noCubierta('respuestas-rechazadas',
        'exige un expediente real con un tutor que YA envió su parte y otro que sigue rellenando; el arnés no puede montar ese estado sin dejar datos a medias')
      return c
    }
    if (!await irAPreguntas(c, page)) return c
    await page.waitForTimeout(LATENCY + 500)

    // La familia contesta algo y pulsa Continuar, que es cuando se guarda el cuestionario.
    const campo = await page.$('input[type="text"], input:not([type]), textarea')
    if (campo) { await campo.click({ clickCount: 3 }); await campo.type('Respuesta del segundo tutor E2E') }

    // El trabajo entra Y invalida el envío previo de este tutor (DL-E49 §8). NO es un fallo.
    scenario.trabajoResultado = 'invalidado'
    await page.click(BTN_SIGUIENTE)
    await page.waitForTimeout(LATENCY + 3000)

    // El aviso llega por el canal que pregunta cómo acabaron los trabajos apuntados, y ese canal
    // va con el LATIDO de 30 s. Se fuerza el latido con el MISMO evento que lo dispara en la
    // aplicación real, en vez de tener el robot medio minuto esperando (patrón ya usado en
    // `ventana-por-inactividad`). Dos veces: la primera puede pillar el trabajo aún «pendiente».
    await latirLaVentana(page)
    await page.waitForTimeout(LATENCY + 1500)
    await latirLaVentana(page)

    const hayError = await page.$('[data-testid="save-indicator-error"]')
    c.afirmar('(1) el guardado del tutor que YA envió ENTRA — no se le rechaza',
      !hayError,
      'salió el aviso de error: el tutor que ya envió vuelve a estar bloqueado, que es justo la regla que Diego derogó el 2026-08-24')

    let salio = false
    try {
      await page.waitForSelector('[data-testid="save-indicator-reenviar"]', { timeout: LATENCY + 8000 })
      salio = true
    } catch { /* lo dice el afirmar */ }
    if (!c.afirmar('(2) la pantalla DICE que su envío quedó invalidado', salio,
      'la pantalla se quedó muda: la familia creería que su parte sigue enviada cuando ya no lo está, y la escuela nunca recibiría la versión corregida')) return c

    const texto = await page.$eval('[data-testid="save-indicator-reenviar"]',
      el => (el.textContent || '').replace(/\s+/g, ' ').trim())
    c.afirmar('(3) el aviso dice QUÉ tiene que hacer: volver a enviarla',
      /vuelve a enviar|send it again/i.test(texto),
      `el aviso dice «${texto}»: sin decirle que tiene que volver a enviar, la familia no sabe qué hacer`)

    const hayReintentar = await page.$('[data-testid="save-error-retry"]')
    c.afirmar('(4) NO se ofrece «Reintentar»: no hay nada que reintentar', !hayReintentar,
      'se ofrece reintentar un guardado que entró bien: lo que hay que hacer es volver a ENVIAR, no volver a guardar')

    // (5) El aviso NO puede costar una petición aparte. `estadoDeLasPartes` es la consulta
    // que la primera versión de este arreglo hacía desde el contexto, y que esta misma
    // batería cazó dejando `network/fetch error` en la consola al abortarse al navegar.
    const consultasAparte = llamadas('estadoDeLasPartes').length
    c.afirmar('(5) el aviso sale del canal que YA existía, sin una petición nueva',
      consultasAparte === 0,
      `el asistente hizo ${consultasAparte} consulta(s) a estadoDeLasPartes desde el recorrido de edición: se aborta al cambiar de pantalla y deja ruido en la consola de la familia (0º.septies)`)

    c.evidencia.llamadas = calls.length
    return c
  } finally {
    scenario.respuestasRechazadas = false
    scenario.trabajoResultado = 'hecho'
  }
}

/**
 * «APUNTADO» NO ES «GUARDADO»: EL ASISTENTE VUELVE A PREGUNTAR (cola 18.bis.84).
 *
 * ── El defecto ──────────────────────────────────────────────────────────────────────
 * El KMS no escribe los pasos del asistente en el acto: los APUNTA y los hace después.
 * Que la llamada volviera bien solo acredita que el servidor la aceptó — y la familia leía
 * «Todos los cambios guardados». Si el trabajo acababa fallando, o descartaba a propósito
 * lo que había escrito (el KMS no deja que un tutor toque la ficha de otro, DL-E49 §2, ni
 * guarda las respuestas de quien ya envió su parte, §6), **nadie se enteraba nunca**.
 *
 * ── Por qué se provoca el latido en vez de esperarlo ────────────────────────────────
 * La pregunta viaja en el latido que YA existe (30 s + al recuperar el foco de la
 * ventana, `WizardPage.jsx`). Aquí se dispara el evento `focus` — que es exactamente lo
 * que hace una familia que vuelve a su pestaña — en vez de dejar la batería parada medio
 * minuto por recorrido. Se recorre el mecanismo REAL, no un atajo.
 *
 * ── Las dos mitades, y las dos hacen falta ──────────────────────────────────────────
 *   (A) un guardado que acaba BIEN no deja ni ruido: preguntar y callar es lo correcto,
 *       y un aviso aquí sería asustar a la familia por nada.
 *   (B) un guardado DESCARTADO se dice, con su motivo, y SIN ofrecer «Reintentar» —
 *       reintentar lo descartaría igual, que es el callejón sin salida de 18.bis.85.
 */
async function caminoGuardadoApuntadoSeVigila(page, base) {
  const c = new Camino('guardado-apuntado-se-vigila')
  scenario.stage = 'hasta_preguntas'

  try {
    if (!await entrarPorElEnlace(c, page, base)) return c
    const pantalla = await page.evaluate(sondaPantalla)
    c.evidencia.elementos = pantalla.pasos + pantalla.campos
    c.evidencia.llamadas = calls.length
    if (REAL) {
      // Contra el sistema de verdad haría falta que el trabajador de la cola del KMS
      // fallara o descartara a propósito, y eso no se puede pedir desde fuera sin dejar
      // datos a medias. No se afloja nada para que pase: se declara descubierto.
      c.noCubierta('guardado-apuntado',
        'exige que el trabajo encolado del KMS falle o descarte contenido a propósito; el arnés no puede provocarlo sin ensuciar el expediente real')
      return c
    }

    // ── (A) UN GUARDADO QUE ACABA BIEN NO DEJA NI RUIDO ───────────────────────────────
    scenario.trabajoResultado = 'hecho'
    if (!await irAPreguntas(c, page)) return c
    await page.waitForTimeout(LATENCY + 500)
    const campoA = await page.$('input[type="text"], input:not([type]), textarea')
    if (campoA) { await campoA.click({ clickCount: 3 }); await campoA.type('Respuesta E2E (trabajo que entra)') }
    const antesDeGuardarA = llamadas('saveResponses').length
    await page.click(BTN_SIGUIENTE)
    await page.waitForTimeout(LATENCY + 2500)
    if (!c.afirmar('(0) el guardado sale hacia el servidor',
      llamadas('saveResponses').length > antesDeGuardarA,
      'no salió ningún guardado: sin él no hay trabajo apuntado y este camino no mediría nada')) return c

    const preguntasAntes = llamadas('estadoDelGuardado').length
    await latirLaVentana(page)
    await page.waitForTimeout(LATENCY + 1500)
    if (!c.afirmar('(1) el asistente VUELVE A PREGUNTAR cómo acabó el guardado apuntado',
      llamadas('estadoDelGuardado').length > preguntasAntes,
      'no preguntó ni una vez: el servidor solo dijo «apuntado», así que sin preguntar el asistente no puede saber —ni decir— si aquello llegó a guardarse')) return c

    const trasA = await page.evaluate(sondaCarrilDeGuardado)
    c.afirmar('(2) un guardado que acaba BIEN no deja ni un aviso',
      !trasA.rojo,
      `apareció el aviso «${trasA.texto}» para un guardado que el servidor dice que entró entero: asustar a la familia por nada es tan malo como callarse`)

    // ── (B) UN GUARDADO DESCARTADO SE DICE, Y NO SE OFRECE REINTENTARLO ───────────────
    scenario.trabajoResultado = 'descartado'
    if (!await irAPreguntas(c, page)) return c
    await page.waitForTimeout(LATENCY + 500)
    const campoB = await page.$('input[type="text"], input:not([type]), textarea')
    if (campoB) { await campoB.click({ clickCount: 3 }); await campoB.type('Respuesta E2E (trabajo descartado)') }
    await page.click(BTN_SIGUIENTE)
    await page.waitForTimeout(LATENCY + 2500)
    await latirLaVentana(page)

    let salio = false
    try {
      await page.waitForSelector('[data-testid="save-indicator-error"]', { timeout: LATENCY + 8000 })
      salio = true
    } catch { /* lo dice el afirmar */ }
    if (!c.afirmar('(3) el trabajo descarta lo que la familia escribió y la pantalla lo DICE', salio,
      'la pantalla siguió muda (o diciendo «Todos los cambios guardados»): el servidor aceptó el encargo y luego lo tiró, y la familia se iría creyendo que quedó guardado — que es el defecto 18.bis.84 entero')) return c

    const trasB = await page.evaluate(sondaCarrilDeGuardado)
    // 2026-08-24 (DL-E49 §8) — el descarte de prueba era «tu parte ya está enviada», y ese
    // rechazo se DEROGÓ (el tutor que ya envió sigue editando; su envío se invalida). El fixture
    // pasó al descarte que SÍ sigue vivo —la ficha de otro tutor—, así que lo que se afirma es lo
    // mismo (que el aviso diga QUÉ no entró y POR QUÉ) con el texto que ahora puede llegar.
    c.afirmar('(4) el aviso dice que NO se guardaron y por qué',
      /no se ha guardado|not been saved|NOT saved/i.test(trasB.texto) &&
      /otro tutor|another guardian|only be (modified|changed)/i.test(trasB.texto),
      `el aviso dice «${trasB.texto}»: sin el motivo, la familia no sabe que reintentar no sirve ni a quién preguntar`)
    c.afirmar('(5) NO se ofrece «Reintentar», que aquí no puede funcionar',
      !trasB.reintentar,
      'el aviso ofrece reintentar un guardado que el servidor va a descartar exactamente igual: un callejón sin salida')
    c.afirmar('(6) la pantalla NO dice «Todos los cambios guardados»',
      !trasB.guardado,
      'la pantalla se quedó diciendo que todo está guardado con lo de la familia tirado a la basura: la mentira que esto viene a quitar')

    c.evidencia.llamadas = calls.length
    return c
  } finally {
    scenario.trabajoResultado = null
  }
}

/**
 * 0º.tricies.octies (B) — UN GUARDADO QUE MURIÓ EN LA COLA DEJA DE SER MUDO.
 *
 * El defecto medido el 2026-08-22: Diego dio de alta un segundo alumno, la pantalla dijo
 * «Esta sección está guardada y bloqueada», avanzó — y al recargar el alumno no estaba. Los
 * guardados del asistente NO escriben: apuntan el trabajo y contestan que sí, así que cuando
 * el trabajo muere minutos después el rechazo llega cuando la respuesta ya se dio y no hay a
 * quién decírselo ahí. El pulso, que ya va y viene, es quien puede traerlo.
 *
 * Las tres afirmaciones son las tres mitades del asunto: que SE VEA, que NOMBRE el paso (un
 * aviso que no dice cuál manda a la familia a revisar seis pantallas), y que se APAGUE SOLO
 * cuando el paso vuelve a guardarse bien — sin eso el aviso sería permanente y la familia
 * aprendería a ignorarlo. La cuarta es la degradación honesta: «no se pudo mirar» NO es
 * «todo está guardado», que es exactamente la confusión que este trabajo viene a cerrar.
 */
async function caminoGuardadoMuertoSeDice(page, base) {
  const c = new Camino('guardado-muerto-se-dice')
  scenario.stage = 'hasta_preguntas'
  try {
    if (!await entrarPorElEnlace(c, page, base)) return c
    const pantalla = await page.evaluate(sondaPantalla)
    c.evidencia.elementos = pantalla.pasos + pantalla.campos
    c.evidencia.llamadas = calls.length
    if (REAL) {
      c.noCubierta('guardado-muerto',
        'exige que un trabajo de la cola del KMS muera de verdad; provocarlo contra el sistema real dejaría el expediente a medias')
      return c
    }

    const sonda = () => {
      const el = document.querySelector('[data-testid="aviso-guardado-no-llego"]')
      return { visible: !!el, texto: el ? el.innerText : '' }
    }

    // ── (0) sin fallos, ni un aviso ────────────────────────────────────────────────
    await latirLaVentana(page)
    await page.waitForTimeout(LATENCY + 1200)
    if (!c.afirmar('(0) sin guardados muertos NO se asusta a nadie',
      !(await page.evaluate(sonda)).visible,
      'salió el aviso con todos los guardados aterrizados: asustar por nada es tan malo como callarse')) return c

    // ── (1) y (2) un guardado muerto SE VE y NOMBRA el paso ────────────────────────
    // El KMS bumpa la versión del grupo al morir un guardado (`sys_jobQueue_markFailed_`);
    // sin ese bump el pulso NO pide el detalle y la familia no se entera. Se simula igual.
    scenario.guardadosSinAterrizar = ['PERSONAS']
    scenario.liveVersion = 2
    await latirLaVentana(page)
    let visto = false
    try {
      await page.waitForSelector('[data-testid="aviso-guardado-no-llego"]', { timeout: LATENCY + 8000 })
      visto = true
    } catch { /* lo dice el afirmar */ }
    if (!c.afirmar('(1) un guardado que murió en la cola SE VE', visto,
      'la pantalla siguió muda: la familia se va creyendo que lo que tecleó quedó guardado, que es el defecto entero')) return c

    const conAviso = await page.evaluate(sonda)
    c.afirmar('(2) el aviso NOMBRA el paso que no se guardó',
      /personas|people/i.test(conAviso.texto),
      `el aviso dice «${conAviso.texto}»: sin nombrar el paso, la familia tiene que revisar seis pantallas para encontrar qué falta`)

    // ── (3) «no se pudo mirar» NO apaga el aviso ───────────────────────────────────
    scenario.guardadosSinAterrizar = []
    scenario.guardadosNoConsultables = true
    scenario.liveVersion = 3
    await latirLaVentana(page)
    await page.waitForTimeout(LATENCY + 1500)
    c.afirmar('(3) un «no se pudo mirar» NO se convierte en «todo está guardado»',
      (await page.evaluate(sonda)).visible,
      'el aviso se apagó porque la consulta falló: volver a afirmar que todo está guardado sin saberlo es EL defecto que esto cierra, ahora por otra puerta')

    // ── (4) y se apaga solo cuando el paso vuelve a guardarse bien ─────────────────
    scenario.guardadosNoConsultables = false
    scenario.liveVersion = 4
    await latirLaVentana(page)
    await page.waitForTimeout(LATENCY + 1500)
    c.afirmar('(4) el aviso se apaga SOLO cuando el paso vuelve a guardarse bien',
      !(await page.evaluate(sonda)).visible,
      'el aviso siguió encendido con el guardado ya aterrizado: un aviso que no se apaga nunca se aprende a ignorar')

    c.evidencia.llamadas = calls.length
    return c
  } finally {
    scenario.guardadosSinAterrizar = null
    scenario.guardadosNoConsultables = false
    scenario.liveVersion = 1
  }
}

/**
 * Provoca el latido que YA existe (`WizardPage.jsx`: `setInterval` de 30 s + `onFocus`)
 * sin quedarse medio minuto parado por recorrido. `focus` es el mismo evento que dispara
 * una familia al volver a su pestaña — se recorre el mecanismo real, no un atajo.
 */
/**
 * DL-E63 · `0º.tricies.tervicies` — **lo que cambia el colegio se le DICE a la familia.**
 *
 * Diego (2026-08-24): *«siempre que se haga un cambio desde el KMS vinculado a una solicitud,
 * ese cambio se visualice en el wizard»*. Hasta hoy el latido era **mudo por diseño** y solo
 * refrescaba el bloque de admisión (su propio comentario lo decía: *«SOLO slice admisión/firma
 * — nunca datos/nav»*), así que un cambio del colegio no llegaba nunca a la pantalla.
 *
 * ⚠️ **Este recorrido mide el lado del CLIENTE.** Que la edición del operador suba la versión
 * es del KMS y **ninguna batería lo ejecuta** — se midió aparte.
 */
const NOMBRE_SOLICITANTE_E2E = 'RobotHijoE2E'
async function caminoLoQueCambiaElColegioSeDice(page, base) {
  const c = new Camino('cambio-del-colegio-se-dice')
  scenario.stage = 'hasta_preguntas'
  scenario.liveVersion = 1
  try {
    if (!await entrarPorElEnlace(c, page, base)) return c
    const pantalla = await page.evaluate(sondaPantalla)
    c.evidencia.elementos = pantalla.pasos + pantalla.campos
    c.evidencia.llamadas = calls.length
    if (REAL) {
      c.noCubierta('cambio-del-colegio',
        'exige que alguien del colegio edite la solicitud desde el KMS; hacerlo contra el sistema real tocaría datos de una familia')
      return c
    }
    // Se retrocede hasta Personas — el paso donde SE VE un dato que el colegio puede corregir.
    // Mismo utillaje que `caminoIdiomasHablados`, sin inventar navegación.
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

    // ⚠️ El control del nombre NO tiene `name` ni `id` (`Step2Persons.jsx:557` es un
    // `input.form-control` pelado), así que se localiza **por su valor**: el del solicitante
    // del molde antes, y el que escribe el colegio después. Buscarlo por un atributo que no
    // existe fue el primer intento y devolvía `null` — el ancla lo cazó.
    const hayInputConValor = (v) => page.evaluate((valor) => {
      const i = [...document.querySelectorAll('input.form-control')].find(x => x.value === valor)
      return i ? { visible: true, disabled: i.disabled, readOnly: i.readOnly } : { visible: false }
    }, v)
    const avisoColegio = () => page.evaluate(() => {
      const el = document.querySelector('[data-testid="save-indicator-aviso-colegio"]')
      return { visible: !!el, texto: el ? el.innerText : '' }
    })

    // ── ANCLA: el paso 2 pinta el nombre del alumno; sin esto, lo demás mediría el aire ──
    const antes = await hayInputConValor(NOMBRE_SOLICITANTE_E2E)
    if (!c.afirmar('(0) ANCLA — el paso pinta el nombre del alumno',
      antes.visible,
      `no se encontró ningún campo con el valor "${NOMBRE_SOLICITANTE_E2E}": sin un dato en pantalla, «se refresca» no se puede comprobar`)) return c

    // ── (1) sin que suba la versión, NO se refresca ni se avisa ─────────────────────
    scenario.datoCambiadoPorElColegio = 'ZZ_E2E_CAMBIADO'
    await latirLaVentana(page)
    await page.waitForTimeout(LATENCY + 1200)
    c.afirmar('(1) sin subir la versión NO se toca nada',
      (await hayInputConValor(NOMBRE_SOLICITANTE_E2E)).visible && !(await avisoColegio()).visible,
      'la pantalla se refrescó sin que la versión subiera: la hidratación es la lectura MÁS CARA ' +
      'del asistente y no puede correr en cada latido')

    // ── (2) y (3) sube la versión ⇒ el dato se refresca Y se le DICE ────────────────
    scenario.liveVersion = 2
    await latirLaVentana(page)
    let visto = false
    try {
      await page.waitForSelector('[data-testid="save-indicator-aviso-colegio"]', { timeout: LATENCY + 9000 })
      visto = true
    } catch { /* lo dice el afirmar */ }
    c.afirmar('(2) el cambio del colegio SE LE DICE a la familia', visto,
      'la pantalla siguió muda: el dato cambia debajo de la familia sin que nadie se lo diga, ' +
      'que es exactamente lo que DL-E63 vino a cerrar')

    const ahora = await hayInputConValor('ZZ_E2E_CAMBIADO')
    c.afirmar('(3) y el dato cambiado SE VE',
      ahora.visible,
      'la pantalla sigue enseñando el nombre viejo aunque el colegio lo cambió a "ZZ_E2E_CAMBIADO": ' +
      'avisar de un cambio que no se enseña deja a la familia buscándolo')

    // ── (4) el aviso NO bloquea: se sigue rellenando ────────────────────────────────
    c.afirmar('(4) el aviso NO bloquea nada',
      ahora.visible && !ahora.disabled && !ahora.readOnly,
      'el campo quedó bloqueado: DL-E63 dice expresamente que no hay candado ni reserva')

    // ⚠️ **LA GUARDA DEL FOCO NO TIENE COBERTURA AQUÍ, y se dice en vez de fingirla.**
    // El refresco se aplaza si hay un control de edición enfocado (`WizardPage.jsx`, la rama
    // `if (tecleando)`), y **este recorrido no puede afirmarlo**: se intentó de las dos formas
    // y las dos midieron el aire. (1) Con `.focus()` desde el DOM, en headless la página no
    // está enfocada y `document.activeElement` se queda en `BODY` — la afirmación pasaba
    // aunque la guarda no existiera. (2) Con la API de Playwright, el `click` **agota los 30 s**:
    // tras el refresco de mitad de sesión el paso queda cubierto y sus campos no son
    // interactuables. Lo segundo es además un hallazgo del producto y queda anotado.
    // ⇒ la guarda se acredita **leyendo el código**, no con esta batería.

    // ── (5) sin datos de nadie en el aviso ──────────────────────────────────────────
    c.afirmar('(5) el aviso NO enseña datos de nadie',
      !/ZZ_E2E_CAMBIADO/.test((await avisoColegio()).texto),
      `el aviso dice «${(await avisoColegio()).texto}»: tiene que decir QUE hubo un cambio, no cuál`)

    c.evidencia.llamadas = calls.length
    return c
  } finally {
    scenario.datoCambiadoPorElColegio = null
    scenario.liveVersion = 1
  }
}

const latirLaVentana = (page) => page.evaluate(() => window.dispatchEvent(new Event('focus')))

/** Radiografía del carril global de guardado (el aviso que gobierna `SaveIndicator`). */
const sondaCarrilDeGuardado = () => ({
  rojo:       !!document.querySelector('[data-testid="save-indicator-error"]'),
  guardado:   !!document.querySelector('[data-testid="save-indicator-idle"]'),
  reintentar: !!document.querySelector('[data-testid="save-error-retry"]'),
  texto:      (document.querySelector('[data-testid="save-indicator-error"]')?.textContent || '').replace(/\s+/g, ' ').trim(),
})

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

/**
 * ⭐ LOS DOS PAGADORES (D121, 2026-08-27) — EL CASO REAL: el tutor A guarda 60/40 y entra B.
 *
 * Hasta hoy, a B se le montaba UNA sola fila con el 60 % suyo, el editor le pintaba «100 %» a
 * pelo y la puerta —que exige que la suma sea 100— le dejaba ATASCADO sin decir por qué, en
 * una pantalla que se firma.
 *
 * ⛔ La afirmación (4) es la que PROTEGE EL ALCANCE de D121 y no es opcional: del otro tutor
 * viajan su nombre y su identificador, y NADA MÁS.
 */
/**
 * ⭐ HERMANOS CON ADMISIONES DESIGUALES — el defecto que Diego probó.
 *
 * Una solicitud lleva varios hijos y el colegio resuelve cada expediente por separado. Hasta el
 * 2026-08-27 la puerta 7→8 miraba `state_code`, que es el Estado del hijo **MENOS avanzado**
 * (`enrStates.sort(display_order)[0]`), así que con Jara `AD` (orden 6) y Pepito `WL` (orden 4) el
 * resumen salía `WL` y **la familia NO podía firmar la matrícula de Jara** — mientras que si a
 * Pepito lo RECHAZABAN (`TD`, orden 10) el resumen salía `AD` y sí podía. **Rechazar a un hermano
 * desbloqueaba la firma y ponerlo en lista de espera la bloqueaba**, y eso no lo decidió nadie.
 *
 * Hoy la puerta la abre un HITO que la configuración completa cuando ningún hermano queda a medias.
 * Este recorrido mide las dos mitades: que con el hito SE AVANZA aunque el resumen sea `WL`, y que
 * SIN el hito NO se avanza aunque haya un hijo admitido con su firma preparada.
 */
async function caminoHermanosDesiguales(page, base) {
  const c = new Camino('hermanos-desiguales')
  scenario.stage = 'firma'
  scenario.hermanosDesiguales = true
  try {
    // ── FASE A · con el hito puesto: se avanza aunque el resumen diga «lista de espera» ──
    if (!await entrarPorElEnlace(c, page, base)) return c
    await page.waitForTimeout(LATENCY + 900)
    const pantalla = await page.evaluate(sondaPantalla)
    c.evidencia.elementos = pantalla.pasos + pantalla.campos + pantalla.tarjetas

    // (0) ANCLA — el paso 7 se pintó. Sin esto, lo de abajo mediría el aire.
    const hayCartel = await page.$('[data-testid="paso7-hermanos"], .wizard-step')
    if (!c.afirmar('ANCLA · el paso 7 llegó a pintarse', pantalla.pasoActivo >= 6 && !!hayCartel,
      `pasoActivo=${pantalla.pasoActivo} cartel=${!!hayCartel}: lo que sigue no mediría nada`)) return c

    // (1) EL DEFECTO: Jara AD + Pepito WL ⇒ SE PUEDE avanzar al paso 8.
    // ⛔ EL SELECTOR ES EL DEL BOTÓN DE AVANZAR, no `BTN_SIGUIENTE` (cualquier `btn-primary-kis`):
    // el paso 7 con la solicitud enviada pinta OTROS botones primarios, así que el genérico
    // encontraba uno SIEMPRE y esta afirmación pasaba en vacío. Se descubrió exigiéndole el rojo:
    // con la puerta devuelta a `_gateState === 'AD'` seguía saliendo VERDE.
    // ⛔⛔ LO QUE SE MIDE ES EL PASO EN EL QUE ATERRIZA, no que haya un botón. Dos intentos
    // anteriores midieron el aire y los destapó exigirles el rojo: `BTN_SIGUIENTE` casaba
    // cualquier botón primario de la pantalla, y `nav-siguiente` existe TAMBIÉN en los pasos de
    // firma — a los que el asistente aterriza SOLO si la puerta está abierta. El paso activo es
    // la señal que no se puede fingir: con la puerta cerrada la familia se queda en el 7.
    const avanzar = pantalla.pasoActivo >= 7
    c.afirmar('(1) con un hermano admitido y otro en lista de espera, SE ENTRA a la firma',
      avanzar,
      `el asistente se quedó en el paso ${pantalla.pasoActivo + 1}: la puerta sigue mirando el `
      + 'Estado del hijo MENOS avanzado, así que un hermano en lista de espera bloquea la '
      + 'matrícula del que SÍ está admitido')

    // (3) La lista nombra a los dos, con su situación.
    const filas = await page.$$eval('[data-testid="paso7-hermano"]',
      ns => ns.map(n => (n.innerText || '').replace(/\s+/g, ' ').trim()))
    c.afirmar('(3) la pantalla dice de qué hijo habla cada situación',
      filas.length === 2
      && filas.some(x => /RobotHijoE2E|RobotHijoUno/i.test(x) || /Admitida/.test(x))
      && filas.some(x => /lista de espera/i.test(x)),
      `las líneas leídas fueron ${JSON.stringify(filas)}: con dos hijos en situaciones distintas, `
      + 'el rótulo grande dice una sola y la familia no sabe de quién')
    c.afirmar('(3.bis) y ninguna línea enseña un identificador en crudo',
      !filas.some(x => /[0-9a-f]{8}-[0-9a-f]{4}/i.test(x)),
      `las líneas leídas fueron ${JSON.stringify(filas)}`)

    // ── FASE B · SIN el hito: no se avanza, aunque haya un admitido y su firma lista ──
    await esperarSilencioDeRed(15000, 1200)
    scenario.sinHitoAdmision = true
    if (!await entrarPorElEnlace(c, page, base)) return c
    await page.waitForTimeout(LATENCY + 900)
    const sinHito = await page.evaluate(sondaPantalla)
    c.afirmar('(2) SIN el hito «admisión resuelta» NO se entra a la firma, aunque un hijo esté admitido',
      sinHito.pasoActivo < 7,
      `se entró al paso ${sinHito.pasoActivo + 1} con el hito sin completar: un hito que no consta `
      + 'NO es un hito cumplido, y así se firma una matrícula con hermanos todavía sin resolver')

    // ── FASE C · UN SOLO hijo admitido: como siempre, y SIN lista ──
    await esperarSilencioDeRed(15000, 1200)
    scenario.sinHitoAdmision = false
    scenario.hermanosDesiguales = false
    if (!await entrarPorElEnlace(c, page, base)) return c
    await page.waitForTimeout(LATENCY + 900)
    const uno = await page.evaluate(sondaPantalla)
    const listaUno = await page.$('[data-testid="paso7-hermanos"]')
    c.afirmar('(4) con UN solo hijo admitido se entra a la firma igual que siempre', uno.pasoActivo >= 7,
      `con un solo hijo admitido el asistente se quedó en el paso ${uno.pasoActivo + 1}: este cambio `
      + 'no puede tocar a esa familia')
    c.afirmar('(4.bis) y con un solo hijo la lista NO se pinta', !listaUno,
      'se pintó la lista de hermanos con un solo hijo: no hay nada que comparar y es ruido')
  } finally {
    scenario.hermanosDesiguales = false
    scenario.sinHitoAdmision = false
  }
  return c
}

async function caminoLosDosPagadores(page, base) {
  const c = new Camino('los-dos-pagadores')
  scenario.stage = 'firma'
  scenario.repartoGuardado60_40 = true
  try {
    // Entra el SEGUNDO tutor, con su propia identidad.
    if (!await entrarPorElEnlace(c, page, base, { nOverride: FIXTURE.emailId2 })) return c
    await page.waitForTimeout(LATENCY + 900)
    const pantalla = await page.evaluate(sondaPantalla)
    c.evidencia.elementos = pantalla.pasos + pantalla.campos + pantalla.tarjetas

    // (0) ANCLA — se está en el paso 8 y su reparto se pintó.
    const hayReparto = await page.$('input[type="range"], [data-testid="reparto-porcentaje"]')
    if (!c.afirmar('ANCLA · el paso 8 pinta el reparto', pantalla.pasoActivo === 7 && !!hayReparto,
      `pasoActivo=${pantalla.pasoActivo} reparto=${!!hayReparto}: lo que sigue mediría el aire`)) return c

    // (1) SE VEN LOS DOS, con nombre.
    const texto = await page.evaluate(() => document.body.innerText)
    const veAlPrimero = texto.includes('RobotUnoE2E')
    const veASiMismo  = texto.includes('RobotDosE2E')
    c.afirmar('el segundo tutor VE a los dos, con su nombre',
      veAlPrimero && veASiMismo,
      `ve al primero=${veAlPrimero} se ve a sí mismo=${veASiMismo}: sin el otro no hay a quién repartirle`)

    // (2) Y PUEDE AVANZAR — el atasco se acabó.
    const deslizador = await page.$('input[type="range"]')
    c.afirmar('con dos pagadores se ofrece el deslizador del reparto', !!deslizador,
      'no se pintó el deslizador: con un solo pagador no se puede repartir nada')
    const avanzar = await page.$(BTN_SIGUIENTE)   // el selector canónico de este arnés
    c.afirmar('el segundo tutor NO se queda atascado', !!avanzar,
      'no hay ningún botón de avance disponible: la familia se queda sin salida')

    // (2.bis) ⛔ Y VE EL REPARTO QUE ACORDÓ A, no un 100/0 inventado. Es DINERO y se FIRMA:
    // si la pantalla sembrara los valores por defecto, B firmaría algo distinto de lo pactado.
    await page.waitForTimeout(LATENCY + 700)   // la revalidación silenciosa del reparto guardado
    const pcts = await page.evaluate(() => {
      const t = document.body.innerText
      return (t.match(/\d+\s*%/g) || []).map(x => x.replace(/\s/g, ''))
    })
    c.afirmar('el segundo tutor ve el reparto QUE ACORDÓ EL PRIMERO (60/40), no un 100/0',
      pcts.includes('60%') && pcts.includes('40%'),
      `los porcentajes en pantalla eran ${JSON.stringify(pcts)}: con 60/40 guardado, sembrar 100/0 le haría firmar algo distinto de lo pactado`)

    // (3) EL «100 %» YA NO MIENTE — si hubiera una sola fila, enseñaría su valor real.
    const solo = await page.$eval('[data-testid="reparto-porcentaje"]', n => n.textContent.trim()).catch(() => null)
    if (solo !== null) {
      c.afirmar('con un solo pagador se enseña su valor REAL, no un 100 % inventado',
        !/^100\s*%/.test(solo),
        `se leyó ${JSON.stringify(solo)} con el 60 % guardado: la pantalla está mintiendo`)
    } else {
      c.noCubierta('cien-por-cien-mentiroso',
        'con la excepción de D121 hay DOS pagadores, así que la rama de «un solo pagador» no se alcanza por este camino; su arreglo se comprueba con la rotura declarada en el reporte')
    }

    // (4) ⛔ EL TOPE DE D121 — del otro tutor, NADA MÁS que nombre e identificador.
    const fuga = await page.evaluate(() => {
      const t = document.body.innerText
      const sospechosos = ['@', '+34', 'X1234567', '1980-', 'Calle ']
      return sospechosos.filter(x => t.includes(x))
    })
    c.afirmar('del otro tutor NO viaja ni un dato de más',
      !fuga.includes('X1234567') && !fuga.includes('Calle '),
      `en la pantalla aparecen rastros de datos que D121 NO permite: ${JSON.stringify(fuga)} — del otro tutor solo pueden viajar su nombre y su identificador`)
  } finally {
    scenario.repartoGuardado60_40 = false
  }
  return c
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

/**
 * CAMINO · «los idiomas que habla cada persona» (①45).
 *
 * Diego, 2026-08-16: «El wizard debería recoger el idioma o idiomas hablados por la
 * familia como dato opcional.» Hasta este cambio el paso 2 no lo preguntaba en ninguna
 * parte: `languages`/`language_id` tenían CERO apariciones en todo `frontend/src`,
 * mientras el KMS ya escribía (`enr_persistPersons_`) y ya devolvía (`enr_wizardHydrate`)
 * ese dato — la fontanería entera construida y sin nadie que la usara.
 *
 * Las CUATRO cosas que mide, y ninguna sobra:
 *   (1) se pueden declarar VARIOS idiomas para una persona;
 *   (2) viajan en el guardado con la forma EXACTA que el escritor del KMS lee
 *       (`p.languages[].language_id`) — mandar otra cosa se descarta en silencio;
 *   (3) lo ya declarado vuelve marcado Y NO se puede desmarcar (los satélites del KMS
 *       son append-only y `enrPersonLanguages` no es una clase que se pueda quitar:
 *       dejar desmarcar sería quitarlo de la pantalla y que volviera al recargar);
 *   (4) es OPCIONAL DE VERDAD: la persona que no marca ninguno no impide avanzar.
 *
 * ⚠️ Lo que NO cubre: la batería corre contra un backend SIMULADO que nunca ejecuta
 * `backend/Code.js` ni llama al KMS. Que la fila se escriba de verdad en
 * `enrPersonLanguages` no lo acredita esto — se acredita leyendo el escritor real.
 */
async function caminoIdiomasHablados(page, base) {
  const c = new Camino('idiomas-hablados')
  scenario.stage = 'hasta_preguntas'

  let ultimoPersons = null
  const espiar = (req) => {
    if (!/\/__gas/.test(req.url())) return
    let body = null
    try { body = JSON.parse(req.postData() || '{}') } catch { return }
    if (body && body.action === 'saveStep' && body.step === 'persons') ultimoPersons = body
  }
  page.on('request', espiar)
  const limpiar = () => page.off('request', espiar)

  // Casilla de un idioma DENTRO de una ficha concreta. Se localiza por posición en el DOM
  // (`.dynamic-section` es lo que pinta `PersonSection`) + el `data-testid` del idioma —
  // el mismo utillaje que `caminoTelefonoQueSeVeSeGuarda`, sin inventar selectores.
  const casilla = async (cual, code) => {
    const ss = await page.$$('.dynamic-section')
    if (!ss.length) return null
    const s = cual === 'ultima' ? ss[ss.length - 1] : ss[0]
    return await s.$(`[data-testid="idioma-${code}"]`)
  }
  const estado = async (cual, code) => {
    const el = await casilla(cual, code)
    if (!el) return null
    return await el.evaluate(n => ({ marcado: n.checked, bloqueado: n.disabled }))
  }

  try {
    if (!await entrarPorElEnlace(c, page, base)) return c
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

    // ── ANCLA: si el paso no ofrece el control, las afirmaciones de abajo medirían el
    //    vacío. Se comprueba primero y se para, nombrándolo.
    if (!c.afirmar('el paso 2 pregunta qué idiomas habla cada persona',
      !!(await casilla('primera', 'en')),
      'no se pintó ninguna casilla de idioma en la primera ficha: el paso no recoge el dato')) return c

    // ── (3) LO YA DECLARADO — el tutor viene del servidor con `es` declarado ────────
    const yaEs = await estado('primera', 'es')
    c.afirmar('un idioma YA declarado vuelve marcado', !!(yaEs && yaEs.marcado),
      `la casilla de «es» del tutor volvió ${JSON.stringify(yaEs)}: lo que la familia ya declaró no se le muestra`)
    c.afirmar('y NO se puede desmarcar (los satélites del KMS son append-only)',
      !!(yaEs && yaEs.bloqueado),
      `la casilla de «es» del tutor volvió ${JSON.stringify(yaEs)}: si se deja desmarcar, la familia lo quita de la pantalla y le vuelve al recargar — el defecto exacto que lib/quitar.js existe para cerrar`)

    // ── (1) VARIOS IDIOMAS en la persona que no tiene ninguno (el último alumno) ────
    for (const code of ['en', 'fr']) {
      const el = await casilla('ultima', code)
      if (!c.afirmar(`el alumno ofrece declarar «${code}»`, !!el,
        `no se encontró la casilla del idioma ${code} en la última ficha`)) return c
      await el.click()
      await page.waitForTimeout(120)
    }
    const trasMarcar = await Promise.all(['en', 'fr'].map(x => estado('ultima', x)))
    c.afirmar('se pueden declarar VARIOS idiomas para la misma persona',
      trasMarcar.every(e => e && e.marcado),
      `las casillas quedaron ${JSON.stringify(trasMarcar)}: el control no admite más de uno`)

    // ── (2) VIAJAN en el guardado, con la forma que el KMS lee ─────────────────────
    ultimoPersons = null
    const botones = await page.$$(BTN_SIGUIENTE)
    if (!c.afirmar('el paso deja continuar tras declarar idiomas', botones.length > 0,
      'no había botón «Continuar» activo: declarar un idioma opcional dejó el paso bloqueado')) return c
    await botones[0].click()
    await page.waitForTimeout(LATENCY + 900)

    if (!c.afirmar('el paso se guarda', !!ultimoPersons,
      'no salió ningún saveStep de personas tras declarar los idiomas')) return c
    c.evidencia.llamadas += 1
    const enviadas = Array.isArray(ultimoPersons.payload) ? ultimoPersons.payload : []
    const delAlumno = enviadas.filter(p => p.person_type_id === 'applicant')
    const codigos = delAlumno.flatMap(p => (p.languages || []).map(l => l && l.language_id))
    c.afirmar('los idiomas declarados VIAJAN hacia el servidor',
      ['en', 'fr'].every(x => codigos.includes(x)),
      `los idiomas enviados para los alumnos fueron ${JSON.stringify(codigos)}: lo que la familia marcó no llega al expediente`)
    c.afirmar('y viajan con la forma que el escritor del KMS lee (`language_id`)',
      delAlumno.every(p => (p.languages || []).every(l => l && typeof l.language_id === 'string' && l.language_id)),
      `el alumno mandó ${JSON.stringify(delAlumno.map(p => p.languages))}: sin `
        + '`language_id` el KMS lo descarta en silencio (`if (!l || !l.language_id) return;`)')

    // ── (4) OPCIONAL DE VERDAD — la otra persona no declaró ninguno y se avanzó igual
    const sinNinguno = enviadas.filter(p => !(p.languages || []).length)
    c.afirmar('quien no declara ningún idioma no impide avanzar',
      sinNinguno.length > 0 && (await dondeEstoy(page)) > 1,
      `personas sin idioma en el envío: ${sinNinguno.length}; el asistente se quedó en el índice ${await dondeEstoy(page)}`)

    // ── LA VUELTA — al volver al paso, lo declarado sigue marcado ──────────────────
    const atras = await page.$('button.btn-secondary-kis:not(:has(i.bi-pencil))')
    if (!atras) {
      c.noCubierta('idiomas-al-volver', 'el paso siguiente no ofrece botón «Atrás»')
    } else {
      await atras.click()
      await page.waitForTimeout(400)
      await desbloquear(page)
      await page.waitForTimeout(200)
      const alVolver = await Promise.all(['en', 'fr'].map(x => estado('ultima', x)))
      c.afirmar('al volver al paso, los idiomas declarados siguen marcados',
        alVolver.every(e => e && e.marcado),
        `las casillas volvieron ${JSON.stringify(alVolver)}: lo que la familia declaró se perdió al navegar`)
    }

    return c
  } finally {
    limpiar()
  }
}

/**
 * CAMINO · «las opciones de sexo salen del catálogo» (`0º.tricies.duodecies` · DL-E51).
 *
 * El catálogo Capa 2 del producto (`person-gender-values`) promete en su propio comentario
 * que un valor nuevo *«se añade AHÍ (una línea) y aparece solo en la pantalla»*. Para el
 * asistente eso era FALSO: los cuatro `<option>` estaban escritos a mano en
 * `Step2Persons.jsx`, así que la pantalla y el catálogo podían decir cosas distintas — que
 * es exactamente lo que perdió el paso de personas de una familia real (`0º.tricies.octies`).
 *
 * Las CUATRO cosas que mide, y ninguna sobra:
 *   (1) el desplegable pinta EXACTAMENTE lo que sirve el catálogo del servidor — ni una
 *       opción de más ni de menos (el doble sirve una lista DISTINTA de la escrita a mano
 *       a propósito: sin eso la comprobación pasaría en vacío);
 *   (2) un valor que la lista escrita a mano SÍ trae y el catálogo NO (`Male`) no aparece —
 *       si apareciera, la pantalla estaría pintando su respaldo;
 *   (3) la etiqueta sigue la regla única: con traducción se pinta la traducción; sin ella,
 *       la `designation` del catálogo (nunca el código en crudo);
 *   (4) lo que la familia elige VIAJA en el guardado, en `gender`.
 *
 * ★ FASE B (2026-08-22) — retirado el RESPALDO escrito a mano, el caso «no llegó el
 * catálogo» tiene que DECIRSE: con `scenario.catalogoSexoVacio` el doble sirve la lista
 * vacía (como un KMS que aún no la sirve, o una lectura caída) y se afirma que
 *   (5) NO se pinta ni una opción — si apareciera alguna, habría vuelto una lista local; y
 *   (6) la pantalla AVISA al lado del campo. El campo es OPCIONAL, así que sin aviso la
 *       familia avanza y el dato se pierde para siempre sin que nadie diga nada.
 *
 * ⚠️ Lo que NO cubre: la batería corre contra un backend SIMULADO que nunca ejecuta
 * `backend/Code.js` ni llama al KMS. Que `enr_wizardFetchLookups` sirva de verdad el
 * catálogo no lo acredita esto — se acredita leyendo el manejador real.
 */
async function caminoSexoDesdeElCatalogo(page, base) {
  const c = new Camino('sexo-desde-el-catalogo')
  scenario.stage = 'hasta_preguntas'

  let ultimoPersons = null
  const espiar = (req) => {
    if (!/\/__gas/.test(req.url())) return
    let body = null
    try { body = JSON.parse(req.postData() || '{}') } catch { return }
    if (body && body.action === 'saveStep' && body.step === 'persons') ultimoPersons = body
  }
  page.on('request', espiar)
  const limpiar = () => page.off('request', espiar)

  // El desplegable de la PRIMERA ficha. Se localiza por su `data-testid`, igual que las
  // casillas de idioma del camino de arriba — sin inventar selectores.
  const selector = async () => {
    const ss = await page.$$('.dynamic-section')
    if (!ss.length) return null
    return await ss[0].$('select[data-testid^="sexo-"]')
  }

  try {
    if (!await entrarPorElEnlace(c, page, base)) return c
    for (let i = 0; i < 8 && (await dondeEstoy(page)) > 1; i++) {
      const atras = await page.$('button.btn-secondary-kis:not(:has(i.bi-pencil))')
      if (!atras) break
      await atras.click()
      await page.waitForTimeout(250)
    }
    if (!c.afirmar('se llega al paso de Personas', (await dondeEstoy(page)) === 1,
      `se quedó en el índice ${await dondeEstoy(page)}`)) return c
    await desbloquear(page)
    await page.waitForTimeout(400)

    const pantalla = await page.evaluate(sondaPantalla)
    c.evidencia.elementos = pantalla.pasos + pantalla.campos

    // ── ANCLA: sin desplegable, todo lo de abajo mediría el vacío.
    const sel = await selector()
    if (!c.afirmar('el paso 2 ofrece el desplegable del sexo', !!sel,
      'no se pintó ningún select[data-testid^="sexo-"] en la primera ficha')) return c

    const opciones = await sel.$$eval('option', els =>
      els.map(o => ({ value: o.value, texto: (o.textContent || '').trim() })))
    const conValor = opciones.filter(o => o.value)

    // ── (1) + (2) LO QUE SE PINTA ES LO QUE SIRVE EL CATÁLOGO ──────────────────────
    const esperados = ['Female', 'Non-binary', 'ZZ-E2E']   // los que sirve el doble
    c.afirmar('las opciones son EXACTAMENTE las del catálogo que manda el servidor',
      conValor.length === esperados.length && esperados.every(x => conValor.some(o => o.value === x)),
      `se pintaron ${JSON.stringify(conValor.map(o => o.value))}, se esperaba ${JSON.stringify(esperados)}`)
    c.afirmar('un valor que el catálogo NO declara no aparece (no se pinta la lista escrita a mano)',
      !conValor.some(o => o.value === 'Male'),
      'apareció «Male», que el catálogo del servidor no sirve: la pantalla está pintando su respaldo, no el catálogo')

    // ── (3) LA ETIQUETA: traducción si la hay, `designation` si no ─────────────────
    const female = conValor.find(o => o.value === 'Female')
    c.afirmar('un valor CON traducción se pinta traducido',
      !!female && female.texto === 'Femenino',
      `la opción de «Female» se leyó «${female && female.texto}» (se esperaba «Femenino»)`)
    const zz = conValor.find(o => o.value === 'ZZ-E2E')
    c.afirmar('un valor SIN traducción cae a la designación del catálogo, nunca al código crudo',
      !!zz && zz.texto === 'Valor E2E',
      `la opción de «ZZ-E2E» se leyó «${zz && zz.texto}» (se esperaba «Valor E2E», la designación del catálogo)`)

    // ── (4) LO ELEGIDO VIAJA ──────────────────────────────────────────────────────
    // Se comprueba ANTES de intentar elegirlo: `selectOption` sobre una opción que no
    // existe LANZA, y un recorrido que revienta pierde las afirmaciones ya hechas y
    // reporta un tiempo de espera agotado en vez de nombrar el caso. Medido rompiéndolo.
    if (!c.afirmar('el valor del catálogo se puede elegir de verdad',
      conValor.some(o => o.value === 'ZZ-E2E'),
      `«ZZ-E2E» no está entre las opciones pintadas (${JSON.stringify(conValor.map(o => o.value))}): la pantalla no ofrece lo que el catálogo declara`)) return c
    await sel.selectOption('ZZ-E2E')
    await page.waitForTimeout(150)
    ultimoPersons = null
    const botones = await page.$$(BTN_SIGUIENTE)
    if (!c.afirmar('el paso deja continuar tras elegir el sexo', botones.length > 0,
      'no había botón «Continuar» activo tras elegir una opción del catálogo')) return c
    await botones[0].click()
    await page.waitForTimeout(LATENCY + 900)

    if (!c.afirmar('el paso se guarda', !!ultimoPersons,
      'no salió ningún saveStep de personas tras elegir el sexo')) return c
    c.evidencia.llamadas += 1
    const enviadas = Array.isArray(ultimoPersons.payload) ? ultimoPersons.payload : []
    const generos = enviadas.map(p => p && p.gender)
    c.afirmar('el valor elegido VIAJA hacia el servidor, con el código del catálogo',
      generos.includes('ZZ-E2E'),
      `los sexos enviados fueron ${JSON.stringify(generos)}: lo que la familia eligió no llega al expediente`)

    // ── FASE B · SIN CATÁLOGO, LA PANTALLA LO DICE (2026-08-22) ────────────────────
    // Retirado el respaldo escrito a mano, el caso «no llegó el catálogo» NO puede quedarse
    // mudo: el campo es OPCIONAL, así que un desplegable vacío dejaría avanzar y el dato se
    // perdería sin un solo aviso. Se entra de nuevo con el catálogo vacío a propósito.
    await esperarSilencioDeRed(20000, 400)   // el precalentado en vuelo, no el producto
    scenario.catalogoSexoVacio = true
    // ⛔ SESIÓN LIMPIA DE VERDAD, y no es ceremonia: la caché de MÓDULO de `api.js`
    // (`_lookupsCache`) vive en el contexto de JavaScript de la página y SOBREVIVE a un
    // cambio de hash, así que sin tirar el contexto la FASE B mediría el catálogo de la
    // FASE A y pasaría en vacío. Medido: salía ROJA diciendo «ha vuelto una lista escrita
    // a mano» cuando lo que volvía era la caché del propio robot.
    await page.evaluate(() => { try { sessionStorage.clear(); localStorage.clear() } catch {} })
    await page.goto('about:blank')
    if (!await entrarPorElEnlace(c, page, base)) return c
    for (let i = 0; i < 8 && (await dondeEstoy(page)) > 1; i++) {
      const atras = await page.$('button.btn-secondary-kis:not(:has(i.bi-pencil))')
      if (!atras) break
      await atras.click()
      await page.waitForTimeout(250)
    }
    if (!c.afirmar('(B) se vuelve al paso de Personas con el catálogo vacío',
      (await dondeEstoy(page)) === 1,
      `se quedó en el índice ${await dondeEstoy(page)}`)) return c
    await desbloquear(page)
    await page.waitForTimeout(500)

    // ── ANCLA: sin desplegable, las dos afirmaciones de abajo medirían el vacío.
    const sel2 = await selector()
    if (!c.afirmar('(B) el paso 2 sigue ofreciendo el campo del sexo', !!sel2,
      'no se pintó ningún select[data-testid^="sexo-"]: sin el campo, lo de abajo no mide nada')) return c

    const opciones2 = await sel2.$$eval('option', els =>
      els.map(o => ({ value: o.value, texto: (o.textContent || '').trim() })))
    const conValor2 = opciones2.filter(o => o.value)
    c.afirmar('(B) sin catálogo NO se pinta ninguna opción escrita a mano',
      conValor2.length === 0,
      `se pintaron ${JSON.stringify(conValor2.map(o => o.value))} sin catálogo del servidor: ha vuelto una lista escrita a mano en el asistente`)

    const aviso = await page.$('[data-testid^="sexo-no-disponible-"]')
    const textoAviso = aviso ? ((await aviso.textContent()) || '').trim() : null
    c.afirmar('(B) la pantalla AVISA de que las opciones no se pudieron cargar',
      !!textoAviso && textoAviso.length > 10,
      `el aviso leído fue ${JSON.stringify(textoAviso)}: con un desplegable vacío y sin aviso, la familia avanza y el dato se pierde sin que nadie diga nada`)

    return c
  } finally {
    scenario.catalogoSexoVacio = false
    limpiar()
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// COLA 18.bis — EL AVISO DE «NO SE PUDO GUARDAR» DEJA DE MENTIR.
//
// Diego, 2026-08-09, con la pantalla delante: «Si el wizard falla el guardado, aparece
// una barra en el menú de color rojo, que invita a volver a guardar, pero es persistente.
// Si al final guarda por otro lado (como me ha pasado) la barra se queda.»
//
// La causa MEDIDA contra `origin/main`: el aviso solo se apagaba desde el final feliz de
// la cola de guardado (`WizardContext.enqueueSave`), y hay caminos que persisten de
// verdad SIN pasar por ella — subir un documento, guardar las NEAE, quitar a alguien del
// expediente. El dato quedaba a salvo y el cartel seguía diciendo lo contrario.
//
// Los dos caminos de abajo son mock-only a propósito: el fallo del guardado se PIDE con
// `scenario.saveStepFails`, que es una palanca del backend simulado. Contra el sistema
// real no hay forma honesta de hacer fallar un guardado a voluntad, así que allí se
// declara NO CUBIERTO con su motivo en vez de fingir un verde.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Sube UN archivo más en el paso de Documentos y espera su confirmación visible.
 *
 * Es lo que deja el paso SUCIO de verdad: el paso solo cuenta las filas que YA tienen
 * archivo subido (`Step6Documents.uploadedDocs`), así que una fila con solo descripción
 * no ensucia nada y el «Continuar» no llegaría a guardar. Además, la subida es una de
 * las tres escrituras que persisten SIN pasar por la cola de guardado —justo la que este
 * camino necesita para comprobar el «guarda por otro lado» de Diego.
 */
async function subirUnDocumento(c, page, descripcion) {
  const yaSubidos = await page.$$eval('.upload-status.success', els => els.length).catch(() => 0)
  const añadir = await page.$('.add-btn')
  if (!añadir) {
    c.fallos.push('el paso de Documentos no ofrece el botón de añadir archivo (.add-btn)')
    return false
  }
  await añadir.click()
  await page.waitForSelector('.doc-attachment', { timeout: 10000 })
  const cajas = await page.$$('.doc-attachment input[type="text"]')
  if (cajas.length) await cajas[cajas.length - 1].fill(descripcion)
  // 18.bis.35 — Y SE CONTESTA QUÉ ES, como lo haría una familia. Cuando el catálogo del
  // centro ofrece dos o más tipos, la respuesta es OBLIGATORIA (el KMS rechaza la subida que
  // no la lleva), así que un ayudante que no la conteste deja de subir nada — y este ayudante
  // es la ESCRITURA QUE SÍ ENTRA de otros tres caminos, que se quedarían sin medir. Con 0 ó 1
  // tipo no hay desplegable que contestar y esto no hace nada, igual que la pantalla.
  const tipos = await page.$$('.doc-attachment .doc-type')
  if (tipos.length) {
    const opciones = await tipos[tipos.length - 1].$$eval('option', os => os.map(o => o.value).filter(Boolean))
    if (opciones.length) await tipos[tipos.length - 1].selectOption(opciones[0])
  }
  const ficheros = await page.$$('.doc-attachment input[type="file"]')
  if (!ficheros.length) {
    c.fallos.push('la fila de documento no ofrece campo de archivo')
    return false
  }
  await ficheros[ficheros.length - 1].setInputFiles({
    name: 'prueba-e2e.pdf',
    mimeType: 'application/pdf',
    buffer: Buffer.from('%PDF-1.4\n% documento sintetico de la bateria E2E\n'),
  })
  try {
    await page.waitForFunction((n) => document.querySelectorAll('.upload-status.success').length > n,
      yaSubidos, { timeout: LATENCY + 12000 })
    return true
  } catch {
    c.fallos.push('el archivo nunca llegó a subirse: sin una escritura que SÍ entre, este camino no mide nada')
    return false
  }
}

/** ¿Se está viendo el aviso rojo de guardado? */
const hayAvisoRojo = (page) => page.$eval('[data-testid="save-indicator-error"]', () => true).catch(() => false)

/**
 * (a) UN GUARDADO POSTERIOR QUE SÍ ENTRA APAGA EL AVISO — venga por donde venga.
 *
 * Recorrido: el guardado del paso de Documentos falla ⇒ sale el aviso rojo. Acto seguido
 * la familia SUBE un archivo, que persiste por un camino que NO pasa por la cola
 * (`pages/steps/Step6Documents.jsx:66`). Ese es exactamente el «guarda por otro lado» de
 * Diego: cuando el servidor acepta esa escritura, el aviso tiene que apagarse SOLO.
 *
 * Roto a propósito (2026-08-09): quitando la suscripción de `WizardContext` a
 * `alConfirmarEscritura`, este camino sale ROJO nombrándolo — el aviso se queda encendido
 * con el dato ya guardado.
 */
async function caminoAvisoGuardadoSeApaga(page, base) {
  const c = new Camino('aviso-guardado-se-apaga')
  scenario.stage = 'hasta_preguntas'   // aterriza directamente en Documentos (5)
  scenario.saveStepFails = true

  try {
    if (!await entrarPorElEnlace(c, page, base)) return c
    const pantalla = await page.evaluate(sondaPantalla)
    c.evidencia.elementos = pantalla.pasos + pantalla.campos
    c.evidencia.llamadas = calls.length
    if (REAL) {
      c.noCubierta('aviso-de-guardado',
        'el fallo del guardado se pide con `scenario.saveStepFails`, una palanca del backend simulado; contra el sistema real no hay forma honesta de hacer fallar un guardado a voluntad')
      return c
    }
    // Se declara AQUÍ y no antes: en modo real el camino sale por la puerta de arriba y
    // el error nunca ocurriría, con lo que la declaración caería por obsoleta.
    c.esperarErrorConsola(/gasCall saveStep: server returned ok=false/,
      'el guardado del paso se tumba a propósito para hacer aparecer el aviso rojo')
    if (!c.afirmar('aterriza en el paso de Documentos', pantalla.pasoActivo === 5,
      `aterrizó en el índice ${pantalla.pasoActivo}, no en 5`)) return c

    // ── (1) el guardado falla ⇒ sale el aviso rojo ────────────────────────────────
    if (!await subirUnDocumento(c, page, 'Documento sintético E2E')) return c
    await page.click(BTN_SIGUIENTE)
    let salio = false
    try {
      await page.waitForSelector('[data-testid="save-indicator-error"]', { timeout: LATENCY + 8000 })
      salio = true
    } catch { /* lo dice el afirmar */ }
    if (!c.afirmar('(1) cuando el guardado falla, la pantalla lo dice', salio,
      'no apareció ningún aviso de guardado fallido: la familia creería que quedó guardado')) return c

    // El texto tiene que decir QUÉ pasó, no «Error» a secas.
    const texto = await page.$eval('[data-testid="save-indicator-error"]',
      el => (el.textContent || '').replace(/\s+/g, ' ').trim())
    c.afirmar('(2) el aviso dice qué no se pudo guardar y que lo escrito sigue ahí',
      /no se ha podido guardar/i.test(texto) && /sigue aquí/i.test(texto),
      `el aviso dice «${texto}»: no nombra lo que falló ni qué pasa con lo que la familia escribió`)

    // ── (2) un guardado que SÍ entra, por un camino que no es la cola, lo apaga ────
    scenario.saveStepFails = false
    const atras = await page.$('button.btn-secondary-kis:not(:has(i.bi-pencil))')
    if (!c.afirmar('se puede volver a Documentos', !!atras,
      'el paso siguiente no ofrece «Atrás»: no hay forma de volver a subir el archivo')) return c
    await atras.click()
    await page.waitForFunction(() => {
      const p = [...document.querySelectorAll('.wizard-step')]
      return p.findIndex(x => x.classList.contains('active')) === 5
    }, null, { timeout: 15000 }).catch(() => {})
    await desbloquear(page)

    c.afirmar('el aviso sigue encendido mientras nada se ha guardado', await hayAvisoRojo(page),
      'el aviso se apagó sin que ningún guardado hubiese entrado: eso es esconder el problema, no resolverlo')

    // (3) la familia sube OTRO archivo: eso persiste de verdad y NO pasa por la cola.
    if (!await subirUnDocumento(c, page, 'Segundo documento E2E')) return c
    c.notas.push('✓ (3) la segunda subida entra por un camino que NO pasa por la cola de guardado')

    let apagado = false
    try {
      await page.waitForFunction(() => !document.querySelector('[data-testid="save-indicator-error"]'),
        null, { timeout: LATENCY + 10000 })
      apagado = true
    } catch { /* lo dice el afirmar */ }
    c.afirmar('(4) con el dato ya guardado, el aviso se apaga SOLO',
      apagado,
      'el aviso rojo seguía encendido después de que el servidor aceptara una escritura: es el defecto que Diego describió — «si al final guarda por otro lado, la barra se queda»')

    // Y no se apaga mintiendo: el guardado que había fallado se REINTENTA de verdad.
    c.afirmar('(5) el guardado que falló se vuelve a intentar (no se descarta en silencio)',
      llamadas('saveStep').length >= 2,
      `salieron ${llamadas('saveStep').length} guardado(s) de paso: el que falló se dio por perdido en vez de reintentarse`)
    c.evidencia.llamadas = calls.length
    return c
  } finally {
    scenario.saveStepFails = false
  }
}

/**
 * (b) LA X CIERRA EL CARTEL, NO EL PROBLEMA.
 *
 * La familia oculta el aviso a mano. Tiene que desaparecer — y NO puede aparecer en su
 * lugar el «Todos los cambios guardados», porque seguiría habiendo algo sin guardar. Y si
 * vuelve a fallar un guardado, el aviso REAPARECE: cerrar cierra ESE episodio, no los
 * futuros.
 *
 * Roto a propósito (2026-08-09): (i) quitando el botón de cerrar → rojo en (1);
 * (ii) haciendo que la X ponga el estado en 'idle' → rojo en (3), porque la pantalla pasa
 * a decir «Todos los cambios guardados» con el dato aún sin guardar.
 */
async function caminoAvisoGuardadoSeCierra(page, base) {
  const c = new Camino('aviso-guardado-se-cierra')
  scenario.stage = 'hasta_preguntas'
  scenario.saveStepFails = true

  try {
    if (!await entrarPorElEnlace(c, page, base)) return c
    const pantalla = await page.evaluate(sondaPantalla)
    c.evidencia.elementos = pantalla.pasos + pantalla.campos
    c.evidencia.llamadas = calls.length
    if (REAL) {
      c.noCubierta('cierre-del-aviso',
        'el fallo del guardado se pide con `scenario.saveStepFails`, una palanca del backend simulado; contra el sistema real no hay forma honesta de hacer fallar un guardado a voluntad')
      return c
    }
    // Se declara AQUÍ y no antes: en modo real el camino sale por la puerta de arriba y
    // el error nunca ocurriría, con lo que la declaración caería por obsoleta.
    c.esperarErrorConsola(/gasCall saveStep: server returned ok=false/,
      'el guardado del paso se tumba a propósito para hacer aparecer el aviso rojo')
    if (!c.afirmar('aterriza en el paso de Documentos', pantalla.pasoActivo === 5,
      `aterrizó en el índice ${pantalla.pasoActivo}, no en 5`)) return c

    if (!await subirUnDocumento(c, page, 'Documento sintético E2E')) return c
    await page.click(BTN_SIGUIENTE)
    try {
      await page.waitForSelector('[data-testid="save-indicator-error"]', { timeout: LATENCY + 8000 })
    } catch {
      c.fallos.push('no apareció el aviso de guardado fallido: sin él no hay nada que cerrar')
      return c
    }

    // (1) la X existe y se puede nombrar (lector de pantalla incluido).
    const cerrar = await page.$('[data-testid="save-error-dismiss"]')
    if (!c.afirmar('(1) el aviso ofrece una X para cerrarlo', !!cerrar,
      'no hay ningún botón de cerrar: el aviso es persistente, que es justo lo que Diego pidió arreglar')) return c
    const etiqueta = await cerrar.getAttribute('aria-label')
    c.afirmar('(2) la X se puede nombrar (tiene etiqueta accesible)', !!(etiqueta && etiqueta.trim()),
      'el botón de cerrar no tiene aria-label: para quien navega con lector de pantalla es un botón sin nombre')

    await cerrar.click()
    await page.waitForTimeout(200)
    c.afirmar('(3) al cerrar, el aviso desaparece', !(await hayAvisoRojo(page)),
      'el aviso seguía en pantalla tras pulsar la X')

    // La comprobación que impide el arreglo tramposo: cerrar NO puede dejar la pantalla
    // diciendo que está todo guardado, porque NO lo está.
    const dice = await page.$eval('[data-testid="save-indicator-idle"]', () => true).catch(() => false)
    c.afirmar('(4) cerrar NO hace que la pantalla diga que está todo guardado', !dice,
      'tras cerrar el aviso la pantalla anuncia «Todos los cambios guardados» con el dato aún sin guardar: la X estaría escondiendo el problema, no el cartel')

    // (5) sigue habiendo algo sin guardar ⇒ un fallo NUEVO vuelve a avisar.
    const atras = await page.$('button.btn-secondary-kis:not(:has(i.bi-pencil))')
    if (!c.afirmar('se puede volver a Documentos', !!atras,
      'el paso siguiente no ofrece «Atrás»')) return c
    await atras.click()
    await page.waitForFunction(() => {
      const p = [...document.querySelectorAll('.wizard-step')]
      return p.findIndex(x => x.classList.contains('active')) === 5
    }, null, { timeout: 15000 }).catch(() => {})
    await desbloquear(page)
    // Otro archivo ⇒ el paso vuelve a estar sucio ⇒ «Continuar» vuelve a guardar, y el
    // servidor sigue tumbando el guardado: es un fallo NUEVO, no el mismo de antes.
    if (!await subirUnDocumento(c, page, 'Segundo documento E2E')) return c
    await page.click(BTN_SIGUIENTE)
    let volvio = false
    try {
      await page.waitForSelector('[data-testid="save-indicator-error"]', { timeout: LATENCY + 8000 })
      volvio = true
    } catch { /* lo dice el afirmar */ }
    c.afirmar('(5) si vuelve a fallar un guardado, el aviso REAPARECE',
      volvio,
      'el aviso no volvió: haberlo cerrado una vez lo apagó para siempre, y el día que el fallo sea de verdad la familia no se entera')
    c.evidencia.llamadas = calls.length
    return c
  } finally {
    scenario.saveStepFails = false
  }
}

/**
 * PASO 7 · EL SIMULADOR DE CUOTAS — y, sobre todo, que NO GATEA EL ENVÍO (Diego 2026-08-19).
 *
 * Dos mitades, y la SEGUNDA es la que importa:
 *   (A) con el simulador en pie: la familia ve las formas de pago con sus importes, elige
 *       una, y esa elección viaja al servidor identificada.
 *   (B) CON EL SIMULADOR CAÍDO: la pantalla lo dice sin drama y **la familia sigue pudiendo
 *       enviar su solicitud**. Si esto se rompe, un fallo del simulador deja a una familia
 *       sin poder matricular — que es el daño que este camino existe para impedir.
 *
 * ⚠️ Y las opciones se comprueban contra lo que MANDA EL SERVIDOR (dos formas de pago en el
 * doble), no contra una lista escrita aquí: con una sola opción la comprobación de que la
 * familia PUEDE elegir pasaría en vacío.
 */
async function caminoSimuladorPaso7(page, base) {
  const c = new Camino('simulador-paso7')
  scenario.stage = 'lista_para_enviar'
  scenario.simulacionFalla = false

  if (REAL) {
    // La mitad (B) —el simulador CAÍDO— no se puede FORZAR sobre el sistema de verdad sin
    // desplegarle un cambio, y guardar la elección exige el código de un solo uso, que
    // llega a un buzón que este arnés no lee. No se afloja ninguna de las dos cosas para
    // que la prueba pase; en modo simulado sí se cubren.
    c.noCubierta('simulador-en-pie',
      'el desglose y la marca de la tarjeta se comprueban contra el backend simulado; contra el real haría falta un expediente con plantillas declaradas, que el arnés no puede sembrar')
    c.noCubierta('simulador-caido',
      'el escenario hostil (el simulador no responde) no se puede FORZAR sobre el backend de verdad sin desplegarle un cambio; en modo simulado sí se cubre')
    return c
  }

  let llamadasAlServidor = []
  let envio = null
  const espiar = (req) => {
    if (!/\/__gas/.test(req.url())) return
    let body = null
    try { body = JSON.parse(req.postData() || '{}') } catch { return }
    // ⭐ 0º.vicies.sexies — antes se espiaba `guardarModalidadPreferida`. Ese manejador se
    // RETIRÓ ENTERO: marcar una forma de pago ya no viaja a ningún sitio. Ahora se cuenta
    // CUALQUIER llamada al servidor mientras se marca, que es lo que hay que afirmar.
    llamadasAlServidor.push(body && body.action)
    if (body && body.action === 'submitEnrollmentSession') envio = body
  }
  page.on('request', espiar)
  const limpiar = () => { page.off('request', espiar); scenario.simulacionFalla = false }

  const irARevision = async (etiqueta) => {
    if (!await entrarPorElEnlace(c, page, base)) return false
    for (let i = 0; i < 8 && (await dondeEstoy(page)) < 6; i++) {
      if (!await continuar(c, page, (await dondeEstoy(page)) + 1, etiqueta)) break
    }
    return c.afirmar(`se llega a Revisión (${etiqueta})`, (await dondeEstoy(page)) === 6,
      `se quedó en el índice ${await dondeEstoy(page)}`)
  }

  try {
    // ── (A) El simulador en pie ────────────────────────────────────────────────
    if (!await irARevision('con simulador')) return c
    await desbloquear(page)
    await page.waitForTimeout(LATENCY + 600)

    const bloque = await page.$('[data-testid="paso7-simulador"]')
    if (!c.afirmar('el paso 7 enseña la simulación de cuotas', !!bloque,
      'no se pintó el recuadro del simulador en Revisión')) return c

    // El aviso de que esto NO compromete tiene que estar SIEMPRE: es lo que separa una
    // simulación de una elección en firme, y la familia lo tiene que leer antes de elegir.
    const aviso = await page.$eval('[data-testid="paso7-simulador-aviso"]',
      el => (el.textContent || '').trim()).catch(() => '')
    c.afirmar('la pantalla dice que la simulación es orientativa y no compromete',
      /orientativ|no compromete|indicative|commits you to nothing/i.test(aviso),
      `el aviso leído fue ${JSON.stringify(aviso)}: sin él, la familia puede creer que ya ha elegido cómo paga`)

    const opciones = await page.$$eval('[data-testid="paso7-modalidad"]', bs => bs.map(b => ({
      id: b.getAttribute('data-modality-id'),
      txt: (b.textContent || '').trim(),
    })))
    c.evidencia.elementos = Math.max(c.evidencia.elementos || 0, opciones.length)
    if (!c.afirmar('se ofrecen al menos DOS formas de pago (hay algo que elegir)',
      opciones.length >= 2,
      `se pintaron ${opciones.length} opción(es): con una sola, «permitir elegir la modalidad» no se está comprobando`)) return c

    c.afirmar('cada forma de pago enseña su importe',
      opciones.every(o => /\d/.test(o.txt) && /€|EUR/.test(o.txt)),
      `los textos de las opciones fueron ${JSON.stringify(opciones.map(o => o.txt))}: sin importe, esto no es un simulador de tarifas`)

    // `0º.quaterdecies` (2026-08-21) — con UN solo plan aplicable la pantalla tiene que
    // quedar BYTE-IDÉNTICA a como estaba antes de que un solicitante pudiera tener varios
    // planes a la vez: sin envoltorio de plan, sin nombre de plan, sin total sumado — esos
    // tres solo aparecen cuando hay MÁS de un plan (ver `caminoSimuladorPaso7VariosPlanes`).
    const marcasDeVariosPlanes = await page.$$(
      '[data-testid="paso7-plan"], [data-testid="paso7-solicitante"], [data-testid="paso7-total-solicitante"]')
    c.afirmar('con un solo plan, la pantalla NO pinta el envoltorio de "varios planes"',
      marcasDeVariosPlanes.length === 0,
      `se encontraron ${marcasDeVariosPlanes.length} marca(s) de varios planes con un único plan aplicable: la pantalla dejó de ser byte-idéntica a la de antes`)

    // ⭐ 0º.vicies.sexies pieza 3 — EL DESGLOSE: cada vencimiento con SU CONCEPTO y una
    // fecha que se pueda leer. Diego lo pidió con esas palabras y lo que salía era
    // `2026-09-01` en crudo y sin decir de qué era cada pago.
    const filas = await page.$$eval('[data-testid="paso7-desglose-fila"]', trs => trs.map(tr => ({
      concepto: (tr.querySelector('[data-testid="paso7-desglose-concepto"]') || {}).textContent || '',
      fecha:    (tr.querySelector('[data-testid="paso7-desglose-fecha"]')    || {}).textContent || '',
    })))
    c.afirmar('el desglose enseña una fila por vencimiento', filas.length > 0,
      'no se pintó ni una fila de desglose: la familia sigue sin ver de qué es cada pago')
    c.afirmar('cada vencimiento dice DE QUÉ es (su concepto)',
      filas.length > 0 && filas.every(f => f.concepto.trim() && f.concepto.trim() !== '—'),
      `los conceptos leídos fueron ${JSON.stringify(filas.map(f => f.concepto.trim()))}: sin concepto, el desglose no desglosa nada`)
    c.afirmar('la fecha se lee, no sale en crudo',
      filas.length > 0 && filas.every(f => !/^\s*\d{4}-\d{2}-\d{2}\s*$/.test(f.fecha)),
      `las fechas leídas fueron ${JSON.stringify(filas.map(f => f.fecha.trim()))}: en crudo (2026-09-01) es justo lo que Diego devolvió`)

    // ⭐ 0º.vicies.sexies pieza 1 — MARCAR NO VIAJA. La presentación de pagos es
    // informativa (decisión de Diego): la marca vive solo en el navegador, así que pulsar
    // una tarjeta no puede producir NI UNA llamada al servidor.
    // ⭐ 0º.tricies (Diego, TERCERA pasada) — SELECTOR, NO TARJETAS, y el calendario
    // ENTERO debajo. Cita literal: *«no quiero tarjetas, quiero un botón o desplegable que
    // elija entre modalidades y las muestre con todos los conceptos (matrícula, fecha
    // etc.)»*. Las dos pasadas anteriores se dieron por buenas sin que la pantalla lo
    // hiciera, así que aquí se comprueba lo que SE VE, no lo que llega.
    const haySelector = await page.$('[data-testid="paso7-modalidad-selector"]')
    if (!c.afirmar('la forma de pago se elige con un SELECTOR, no con tarjetas', !!haySelector,
      'no se encontró [data-testid="paso7-modalidad-selector"]: siguen siendo tarjetas, que es lo que Diego devolvió dos veces')) return c

    // (a) EL CALENDARIO COMPLETO: con una forma de pago de varios vencimientos se tienen
    // que ver TODAS las filas, cada una con su concepto y su fecha legible — no un resumen.
    const idsDeModalidad = opciones.map(o => o.id).filter(Boolean)
    const filasDe = () => page.$$eval('[data-testid="paso7-desglose-fila"]', trs => trs.map(tr => ({
      concepto: ((tr.querySelector('[data-testid="paso7-desglose-concepto"]') || {}).textContent || '').trim(),
      fecha:    ((tr.querySelector('[data-testid="paso7-desglose-fecha"]')    || {}).textContent || '').trim(),
    })))
    const filasAntes = await filasDe()

    llamadasAlServidor = []
    await page.selectOption('[data-testid="paso7-modalidad-selector"]', idsDeModalidad[1])
    await page.waitForTimeout(LATENCY + 600)
    const filasDespues = await filasDe()
    c.evidencia.elementos = Math.max(c.evidencia.elementos || 0, filasDespues.length)

    c.afirmar('el calendario enseña TODOS los vencimientos, no solo el primero',
      filasDespues.length > 1,
      `tras elegir la otra forma de pago se pintaron ${filasDespues.length} fila(s): «Primer pago» a secas es justo lo que Diego devolvió`)
    c.afirmar('cada vencimiento del calendario dice su concepto y su fecha legible',
      filasDespues.length > 1 &&
      filasDespues.every(f => f.concepto && f.concepto !== '—') &&
      filasDespues.every(f => f.fecha && !/^\d{4}-\d{2}-\d{2}$/.test(f.fecha)),
      `las filas leídas fueron ${JSON.stringify(filasDespues)}: sin concepto o con la fecha en crudo, el calendario no sirve`)

    // (b) REPINTA AL INSTANTE Y SIN SERVIDOR: todas las formas de pago vienen ya en la
    // respuesta, así que elegir no puede costar ni una llamada.
    c.evidencia.llamadas = Math.max(c.evidencia.llamadas || 0, 1)
    c.afirmar('cambiar de forma de pago REPINTA el calendario',
      JSON.stringify(filasDespues) !== JSON.stringify(filasAntes),
      `el calendario quedó igual (${filasAntes.length} → ${filasDespues.length} filas): la pantalla no obedece al selector`)
    c.afirmar('cambiar de forma de pago NO llama al servidor',
      llamadasAlServidor.length === 0,
      `se llamó a ${JSON.stringify(llamadasAlServidor)}: elegir es comparar, no dejar constancia`)
    const marcada = await page.$eval('[data-testid="paso7-modalidad-selector"]',
      el => el.value).catch(() => null)
    c.afirmar('la forma de pago elegida queda marcada al instante', marcada === idsDeModalidad[1],
      `el selector quedó en ${JSON.stringify(marcada)} y se eligió ${JSON.stringify(idsDeModalidad[1])}: la familia elige y no ve que haya pasado nada`)

    // ⭐ `0º.tricies.sexdecies` (2026-08-22) — con UN SOLO solicitante tampoco se pinta el
    // separador por alumno: no hay nada que separar y el plan ya se nombra a sí mismo.
    const separadorConUno = await page.$$('[data-testid="sujeto-separador"]')
    c.afirmar('con un solo solicitante NO se pinta el separador por alumno',
      separadorConUno.length === 0,
      `se pintaron ${separadorConUno.length} separador(es) de alumno con un único solicitante: sobra ruido en pantalla`)

    // ── (C) DOS HERMANOS: SE VE DÓNDE ACABA UNO Y EMPIEZA EL OTRO (0º.tricies.sexdecies)
    // Diego: «es difícil visualmente separar un hermano del otro. La letra es muy pequeña,
    // no hay un elemento (un pill) que claramente separe visualmente lo que corresponde a
    // cada hermano» — y lo dijo de las DOS pantallas, el cuestionario y las cuotas. El
    // simulado sirve un presupuesto por CADA hermano solo con esta palanca; con la familia
    // de siempre (un solo solicitante con planes) esto pasaría EN VACÍO.
    scenario.dosSolicitantes = true
    try {
      if (!await irARevision('con dos hermanos')) return c
      await desbloquear(page)
      await page.waitForTimeout(LATENCY + 700)
      const hermanos = await page.evaluate(() => {
        const out = []
        document.querySelectorAll('[data-testid="sujeto-separador"]').forEach(cab => {
          const bloque = cab.parentElement
          const ec = getComputedStyle(cab)
          const eb = bloque ? getComputedStyle(bloque) : null
          out.push({
            nombre:   (cab.textContent || '').trim(),
            fondo:    ec.backgroundColor,
            tamano:   parseFloat(ec.fontSize) || 0,
            peso:     Number(ec.fontWeight) || 0,
            bordeIzq: eb ? (parseFloat(eb.borderLeftWidth) || 0) : 0,
          })
        })
        return out
      })
      const transp = (v) => !v || v === 'transparent' || /rgba\(0, 0, 0, 0\)/.test(v)
      if (c.afirmar('(C.0) ancla — con dos hermanos la pantalla pinta un separador por cada uno',
        hermanos.length === 2,
        `se pintaron ${hermanos.length} separador(es) de alumno con DOS presupuestos: sin ellos, lo de abajo pasaría en vacío`)) {
        c.afirmar('(C.1) el nombre de cada hermano se pinta como una PASTILLA legible',
          hermanos.every(h => h.nombre && !transp(h.fondo) && h.tamano >= 15 && h.peso >= 700),
          `los separadores leídos fueron ${JSON.stringify(hermanos)}: se esperaba nombre, fondo propio, ` +
          `letra de al menos 15px y peso 700 — el mismo tratamiento que en el cuestionario`)
        c.afirmar('(C.2) las cuotas de cada hermano quedan ENCERRADAS en su propia área',
          hermanos.every(h => h.bordeIzq >= 2),
          `los bordes de agrupación fueron ${JSON.stringify(hermanos.map(h => h.bordeIzq))}: sin un ` +
          `elemento que delimite el bloque, los dos presupuestos corren seguidos`)
        c.afirmar('(C.3) cada hermano se anuncia con SU nombre, no con un identificador',
          new Set(hermanos.map(h => h.nombre)).size === 2 &&
          hermanos.every(h => !/^[0-9a-f-]{8,}$/i.test(h.nombre)),
          `los nombres leídos fueron ${JSON.stringify(hermanos.map(h => h.nombre))}`)
      }
    } finally {
      scenario.dosSolicitantes = false
    }

    // ── (B) EL SIMULADOR CAÍDO — la familia sigue pudiendo enviar ──────────────
    scenario.simulacionFalla = true
    envio = null
    if (!await irARevision('con simulador caído')) return c
    await desbloquear(page)
    await page.waitForTimeout(LATENCY + 600)

    const sinOpciones = await page.$$('[data-testid="paso7-modalidad"]')
    c.afirmar('con el simulador caído no se pinta ninguna forma de pago (ni números falsos)',
      sinOpciones.length === 0,
      `se pintaron ${sinOpciones.length} opción(es) pese a que el servidor no contestó`)
    const vacio = await page.$('[data-testid="paso7-simulador-vacio"]')
    c.afirmar('con el simulador caído la pantalla lo dice, sin romper el paso', !!vacio,
      'no se encontró el mensaje de «todavía no podemos mostrarte una simulación»')

    const enviado = await page.evaluate(() => {
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
    c.afirmar('con el simulador caído el botón de enviar sigue disponible y se pulsa', enviado,
      'no se encontró un botón de enviar habilitado: un simulador caído estaría impidiendo matricular')
    await page.waitForTimeout(LATENCY + 1200)
    c.afirmar('con el simulador caído la solicitud SE ENVÍA IGUAL', !!envio,
      'no se registró ninguna llamada a submitEnrollmentSession: el envío quedó gateado por el simulador, que es justo lo que no puede pasar')

    return c
  } finally {
    limpiar()
  }
}

/**
 * simulador-no-recalcula-al-navegar — LA MEDICIÓN de `0º.tricies.quindecies`
 * (Diego, 2026-08-22: *«Las cuotas se siguen recalculando aunque no cambie absolutamente
 * nada. Si navego hacia atrás desde el paso 7, vuelven a calcularse innecesariamente»*).
 *
 * Cuenta las llamadas a `simularCuotas` que salen del navegador al recorrer 7 → 6 → 7 SIN
 * TOCAR NADA. Cada recálculo del lado del servidor son ~89 s de espera para la familia, así
 * que una llamada de más no es cosmética.
 *
 * ⚠️ Esto mide LO QUE PIDE EL NAVEGADOR, no lo que el servidor recalcula: la batería corre
 * contra un backend simulado que NUNCA ejecuta `backend/Code.js`. La caché de dos niveles
 * (`simularCuotas_`) se mide aparte.
 */
async function caminoSimuladorNoRecalculaAlNavegar(page, base) {
  const c = new Camino('simulador-no-recalcula-al-navegar')
  scenario.stage = 'lista_para_enviar'
  scenario.simulacionFalla = false

  if (REAL) {
    c.noCubierta('no-recalcula-al-navegar',
      'exige un expediente con plantillas de tarifa declaradas y contar las llamadas del navegador; contra el sistema real el arnés no puede sembrarlo')
    return c
  }

  let simulaciones = 0
  const acciones = []
  const espiar = (req) => {
    if (!/\/__gas/.test(req.url())) return
    let body = null
    try { body = JSON.parse(req.postData() || '{}') } catch { return }
    if (body && body.action === 'simularCuotas') simulaciones++
    acciones.push(body && body.action === 'saveStep' ? ('saveStep:' + body.step) : (body && body.action))
  }
  page.on('request', espiar)

  try {
    if (!await entrarPorElEnlace(c, page, base)) return c
    for (let i = 0; i < 8 && (await dondeEstoy(page)) < 6; i++) {
      if (!await continuar(c, page, (await dondeEstoy(page)) + 1, 'hacia Revisión')) break
    }
    if (!c.afirmar('se llega a Revisión', (await dondeEstoy(page)) === 6,
      `se quedó en el índice ${await dondeEstoy(page)}`)) return c
    await desbloquear(page)
    await page.waitForTimeout(LATENCY + 800)

    const bloque = await page.$('[data-testid="paso7-simulador"]')
    if (!c.afirmar('el paso 7 enseña la simulación (ancla)', !!bloque,
      'no se pintó el simulador: sin él esta medición pasaría en vacío')) return c
    c.evidencia.elementos = Math.max(c.evidencia.elementos || 0, 2)

    const trasLaPrimera = simulaciones
    c.afirmar('llegar al paso 7 pide la simulación UNA sola vez', trasLaPrimera === 1,
      `se pidieron ${trasLaPrimera} simulaciones al montar el paso 7`)

    // ── Volver atrás y regresar, SIN TOCAR NADA ──────────────────────────────────────
    const atras = await page.$('button.btn-secondary-kis:not(:has(i.bi-pencil))')
    if (!atras) { c.noCubierta('volver-y-regresar', 'el paso 7 no ofrece botón «Atrás»'); return c }
    await atras.click()
    await page.waitForTimeout(400)
    c.afirmar('«Atrás» lleva al paso 6', (await dondeEstoy(page)) === 5,
      `tras pulsar «Atrás» el stepper marca el índice ${await dondeEstoy(page)}`)

    if (!await continuar(c, page, 6, 'de vuelta a Revisión')) return c
    await page.waitForTimeout(LATENCY + 800)

    const trasElRegreso = simulaciones
    c.notas.push(`MEDIDO — simularCuotas: ${trasLaPrimera} al llegar · ${trasElRegreso} tras 7→6→7`)
    c.notas.push(`MEDIDO — acciones del navegador en todo el recorrido: ${JSON.stringify(acciones)}`)
    c.afirmar('volver atrás y regresar NO vuelve a pedir la simulación',
      trasElRegreso === trasLaPrimera,
      `se pidió ${trasElRegreso - trasLaPrimera} vez/veces más al regresar al paso 7 (total ${trasElRegreso}): ` +
      `cada una son ~89 s de espera para la familia, y no había cambiado nada`)

    // ── Y LA CAUSA DE FONDO: pasar por el paso 6 sin tocarlo NO puede guardar nada ──────
    // Un `saveStep` de documentos que la familia no pidió es peor que un viaje de más: el
    // servidor bumpa la versión del grupo y TIRA la caché de la simulación (además de las
    // de hidratación, admisión y miembros), así que el paso 7 vuelve a pagar. Y pasa por el
    // código de un solo uso, así que puede saltarle `STEPUP_REQUIRED` por un guardado que
    // nunca pidió.
    const guardadosDeDocumentos = acciones.filter(a => a === 'saveStep:documents')
    c.afirmar('pasar por el paso 6 SIN TOCAR NADA no encola ningún guardado',
      guardadosDeDocumentos.length === 0,
      `se encolaron ${guardadosDeDocumentos.length} guardado(s) de documentos sin que la familia tocara el paso: ` +
      `eso tira la caché de la simulación y le vuelve a cobrar el cálculo`)
    return c
  } finally {
    page.off('request', espiar)
  }
}

/**
 * ⛔ cuotas-no-llegan-no-se-miente — `0º.tricies.vicies.sexies` (Diego, 2026-08-26).
 *
 * Diego: *«Ahora no carga ninguna cuota en el wizard en el paso 7»*, con el recuadro
 * diciendo *«Todavía no podemos mostrarte una simulación de las cuotas. El colegio te
 * informará de los importes cuando estudie tu solicitud.»* — y en su propio registro
 * `simularCuotas` había salido y el navegador la había CORTADO a los 240.000 ms sin
 * respuesta. **No es que no haya cuotas: es que no llegaron**, y la pantalla hablaba del
 * colegio.
 *
 * El molde es el del paso 1 (`programas-no-se-inventan`): TRES situaciones, no dos —
 * calculando · el servidor contestó (y puede no haber cuotas, que es legítimo) · no se
 * pudo calcular, que se DICE y se puede reintentar.
 *
 * ⛔ EL FALLO SE PROVOCA MATANDO EL SOCKET, no con un `{ok:false}` ni con
 * `scenario.simulacionFalla`: lo que hay que reproducir es el fallo que NO DEJA RESPUESTA
 * QUE LEER. `simulacionFalla` responde `simulable:false`, que es el servidor CONTESTANDO
 * que ese plan no admite cuotas — el caso legítimo del que hay que distinguirse, y que
 * sigue midiéndose en `simulador-paso7`.
 *
 * ⚠️ Esto NO hace que las cuotas lleguen: mientras `simularCuotas` tarde más de cuatro
 * minutos, la familia seguirá sin verlas. Eso lo cierra `0º.tricies.vicies.quinquies`.
 * Aquí solo se deja de mentir.
 */
async function caminoCuotasNoLleganNoSeMiente(page, base) {
  const c = new Camino('cuotas-no-llegan-no-se-miente')
  scenario.stage = 'lista_para_enviar'
  scenario.simulacionFalla = false

  if (REAL) {
    c.noCubierta('cuotas-cortadas',
      'el escenario hostil (la simulación se corta sin dejar respuesta) no se puede FORZAR sobre el backend de verdad sin desplegarle un cambio; en modo simulado sí se cubre')
    return c
  }

  let pedidas = 0
  const espiar = (req) => {
    if (!/\/__gas/.test(req.url())) return
    let body = null
    try { body = JSON.parse(req.postData() || '{}') } catch { return }
    if (body && body.action === 'simularCuotas') pedidas++
  }
  page.on('request', espiar)

  // El corte deja un «network/fetch error» en la consola de la aplicación. Es CORRECTO que
  // quede registrado —el defecto era justamente tragárselo—, así que se declara para que
  // no cuente como ruido, y la batería exige que ocurra de verdad.
  c.esperarErrorConsola(/gasCall simularCuotas: network\/fetch error/,
    'la simulación se corta a propósito para comprobar que la familia se entera')

  // ⚠️ SE MATAN TODOS LOS INTENTOS, no solo el primero — y es lo MEDIDO, no una
  // precaución: al destruir el socket, **Chromium reintenta la petición por debajo**
  // (mismo hallazgo que `0º.tricies.vicies.semel`). Con el contador a 1, ese reintento
  // invisible traía las cuotas y la pantalla nunca llegaba a fallar: el camino salía en
  // verde sin haber medido nada. Se abre a 0 más abajo, para el reintento de VERDAD.
  scenario.simulacionCorta = 99

  try {
    if (!await entrarPorElEnlace(c, page, base)) return c
    for (let i = 0; i < 8 && (await dondeEstoy(page)) < 6; i++) {
      if (!await continuar(c, page, (await dondeEstoy(page)) + 1, 'hacia Revisión')) break
    }
    if (!c.afirmar('se llega a Revisión', (await dondeEstoy(page)) === 6,
      `se quedó en el índice ${await dondeEstoy(page)}`)) return c
    await desbloquear(page)
    await page.waitForTimeout(LATENCY + 1500)

    const leer = () => page.evaluate(() => {
      const el = document.querySelector('[data-testid="paso7-simulador"]')
      return {
        recuadro:  !!el,
        texto:     el ? (el.textContent || '').replace(/\s+/g, ' ').trim() : '',
        vacio:     !!document.querySelector('[data-testid="paso7-simulador-vacio"]'),
        fallo:     !!document.querySelector('[data-testid="paso7-simulador-fallo"]'),
        reintento: !!document.querySelector('[data-testid="paso7-simulador-reintentar"]'),
        opciones:  document.querySelectorAll('[data-testid="paso7-modalidad"]').length,
      }
    })

    const roto = await leer()
    c.evidencia.elementos = Math.max(c.evidencia.elementos || 0, roto.recuadro ? 2 : 0)
    c.evidencia.llamadas = Math.max(c.evidencia.llamadas || 0, pedidas)
    // ANCLA: sin el recuadro del simulador, todo lo de abajo pasaría EN VACÍO.
    if (!c.afirmar('(0) ancla — el paso 7 pinta su recuadro de cuotas',
      roto.recuadro, 'no se pintó [data-testid="paso7-simulador"]: sin él no hay nada que medir')) return c

    c.afirmar('(1) una simulación que NO LLEGA no se cuenta como «el colegio ya te dirá»',
      !roto.vacio && !/te informará|will tell you/i.test(roto.texto),
      `el recuadro decía ${JSON.stringify(roto.texto.slice(0, 200))}: un fallo de transporte ` +
      `está saliendo por la MISMA puerta que «este plan no admite cuotas», y la pantalla habla ` +
      `del colegio cuando lo que pasa es que no le llegó la respuesta`)

    c.afirmar('(2) la pantalla DICE que no se pudo calcular',
      roto.fallo,
      `no se pintó [data-testid="paso7-simulador-fallo"]; el recuadro decía ` +
      `${JSON.stringify(roto.texto.slice(0, 200))}`)

    c.afirmar('(3) y ofrece volver a intentarlo',
      roto.reintento,
      'no se pintó el botón de reintento: sin él la familia solo puede recargar el asistente entero')

    c.afirmar('(4) con la simulación caída NO se pinta ninguna forma de pago (ni números falsos)',
      roto.opciones === 0,
      `se pintaron ${roto.opciones} opción(es) pese a que el servidor no contestó`)

    // ── Y NO SE QUEDA PEGADO: el reintento sale a la red y trae las cuotas ─────────────
    if (roto.reintento) {
      const antes = pedidas
      scenario.simulacionCorta = 0    // el servidor vuelve
      await page.click('[data-testid="paso7-simulador-reintentar"]')
      await page.waitForTimeout(LATENCY + 1500)
      const sano = await leer()
      c.afirmar('(5) «Volver a intentarlo» vuelve a PREGUNTAR de verdad',
        pedidas > antes,
        `se pidieron ${pedidas - antes} simulaciones al reintentar: si el fallo se hubiera ` +
        `guardado en la memoria de la sesión, el botón no serviría de nada`)
      c.afirmar('(6) al volver el servidor, las cuotas aparecen y el aviso de fallo se va',
        sano.opciones >= 1 && !sano.fallo,
        `tras reintentar: opciones=${sano.opciones} aviso de fallo=${sano.fallo}. ` +
        `Un fallo memorizado apagaría el simulador el resto de la sesión`)
    }
    return c
  } finally {
    page.off('request', espiar)
    scenario.simulacionCorta = 0
  }
}

/**
 * simulador-paso7-varios-planes — UN NIÑO PUEDE TENER VARIOS PLANES A LA VEZ
 * (`0º.quaterdecies`, 2026-08-21).
 *
 * ── El defecto que cierra ────────────────────────────────────────────────────────────
 * Antes, cuando a un solicitante le tocaban VARIAS plantillas de suscripción aplicables a
 * la vez (cuota escolar + comedor + permanencia — la configuración que Diego está montando
 * AHORA, con los tres aplicando a todos los niños), la simulación del paso 7 se rendía con
 * `VARIAS_PLANTILLAS` y la familia dejaba de ver sus cuotas justo en la pantalla donde
 * revisa antes de enviar. Ahora se ensayan TODAS las plantillas que le tocan y se ven
 * todas, cada una con su nombre y su forma de pago, más el total sumado del solicitante.
 *
 * ── Lo que este camino NO repite ─────────────────────────────────────────────────────
 * El caso de UN solo plan (el de siempre) lo sigue midiendo `caminoSimuladorPaso7`, que
 * gana la afirmación de que con un solo plan la pantalla queda byte-idéntica a como
 * estaba — sin envoltorio de plan, sin total sumado. Aquí solo se mide el caso de VARIOS.
 */
async function caminoSimuladorPaso7VariosPlanes(page, base) {
  const c = new Camino('simulador-paso7-varios-planes')
  scenario.stage = 'lista_para_enviar'
  scenario.dosPlanes = true

  if (REAL) {
    c.noCubierta('varios-planes',
      'exige declarar en el catálogo real dos plantillas de suscripción aplicables a la vez al mismo solicitante; en modo simulado sí se cubre')
    return c
  }

  try {
    if (!await entrarPorElEnlace(c, page, base)) return c
    for (let i = 0; i < 8 && (await dondeEstoy(page)) < 6; i++) {
      if (!await continuar(c, page, (await dondeEstoy(page)) + 1, 'con dos planes')) break
    }
    if (!c.afirmar('se llega a Revisión con los planes aplicables', (await dondeEstoy(page)) === 6,
      `se quedó en el índice ${await dondeEstoy(page)}`)) return c
    await desbloquear(page)
    await page.waitForTimeout(LATENCY + 600)

    const planes = await page.$$('[data-testid="paso7-plan"]')
    c.evidencia.elementos = Math.max(c.evidencia.elementos || 0, planes.length)
    if (!c.afirmar('se ven los TRES planes del solicitante, no uno', planes.length === 3,
      `se pintaron ${planes.length} bloque(s) de plan: con tres plantillas aplicables tienen que verse las tres`)) return c

    const nombres = await page.$$eval('[data-testid="paso7-plan-nombre"]',
      els => els.map(e => (e.textContent || '').trim()))
    c.afirmar('cada plan enseña su NOMBRE (la plantilla), no un identificador',
      nombres.includes('Cuota escolar') && nombres.includes('Comedor') && nombres.includes('Permanencia'),
      `los nombres leídos fueron ${JSON.stringify(nombres)}`)

    const opciones = await page.$$('[data-testid="paso7-modalidad"]')
    c.evidencia.llamadas = Math.max(c.evidencia.llamadas || 0, 1)
    c.afirmar('cada plan sigue ofreciendo su propia forma de pago para elegir',
      opciones.length === 3,
      `se pintaron ${opciones.length} opción(es) de forma de pago: se esperaba una por plan`)

    // ⭐ 0º.tricies (c) — UN PLAN SIN SELECTOR TAMBIÉN ENSEÑA SU CALENDARIO. Diego lo pidió
    // con esas palabras: comedor y ampliación de horario no ofrecen alternativa de pago,
    // pero la familia tiene que ver igualmente TODOS sus vencimientos con concepto y fecha.
    const sinSelector = await page.$$('[data-testid="paso7-modalidad-selector"]')
    c.afirmar('un plan con una sola forma de pago NO pinta desplegable (no hay nada que elegir)',
      sinSelector.length === 0,
      `se pintaron ${sinSelector.length} desplegable(s) con una sola forma de pago por plan: un desplegable de una opción no es una elección`)

    const desgloseDelComedor = await page.$$eval('[data-testid="paso7-plan"]', bloques => {
      const b = bloques.find(x => /Comedor/.test(x.textContent || ''))
      if (!b) return null
      return Array.from(b.querySelectorAll('[data-testid="paso7-desglose-fila"]')).map(tr => ({
        concepto: ((tr.querySelector('[data-testid="paso7-desglose-concepto"]') || {}).textContent || '').trim(),
        fecha:    ((tr.querySelector('[data-testid="paso7-desglose-fecha"]')    || {}).textContent || '').trim(),
      }))
    })
    c.afirmar('el plan SIN selector enseña igualmente su calendario completo',
      !!desgloseDelComedor && desgloseDelComedor.length > 1 &&
      desgloseDelComedor.every(f => f.concepto && f.concepto !== '—') &&
      desgloseDelComedor.every(f => f.fecha && !/^\d{4}-\d{2}-\d{2}$/.test(f.fecha)),
      `el desglose del comedor fue ${JSON.stringify(desgloseDelComedor)}: sin selector Diego sigue queriendo ver todos los vencimientos`)

    // ⭐ `0º.tricies` (segunda vuelta) — Y EL PLAN QUE NO ADMITE NINGUNA FORMA DE PAGO.
    // NO es el mismo caso que el comedor de arriba, que tiene UNA: aquí el KMS devuelve la
    // modalidad con `designation`/`modality_code` a **null** (`candidates = [null]`), y esa
    // forma es la que hacía que la línea empezara por un « · » suelto. Sin este caso en el
    // doble, la comprobación de arriba pasa en vacío sobre un plan que SÍ tiene nombre.
    const permanencia = await page.$$eval('[data-testid="paso7-plan"]', bloques => {
      const b = bloques.find(x => /Permanencia/.test(x.textContent || ''))
      if (!b) return null
      const linea = b.querySelector('[data-testid="paso7-modalidad"]')
      return {
        linea: ((linea || {}).textContent || '').trim(),
        filas: Array.from(b.querySelectorAll('[data-testid="paso7-desglose-fila"]')).map(tr => ({
          concepto: ((tr.querySelector('[data-testid="paso7-desglose-concepto"]') || {}).textContent || '').trim(),
          fecha:    ((tr.querySelector('[data-testid="paso7-desglose-fecha"]')    || {}).textContent || '').trim(),
        })),
      }
    })
    if (!c.afirmar('el plan que no admite NINGUNA forma de pago se pinta', !!permanencia,
      'no se encontró el bloque del plan «Permanencia»')) return c
    c.afirmar('una forma de pago SIN NOMBRE se anuncia con su importe, sin un separador suelto delante',
      !!permanencia.linea && !/^\s*[·—-]/.test(permanencia.linea),
      `la línea leída fue ${JSON.stringify(permanencia.linea)}: vacía la familia no ve qué paga, y empezando por « · » lee un renglón roto`)
    c.afirmar('el plan sin ninguna forma de pago enseña igualmente su calendario completo',
      permanencia.filas.length === 2 &&
      permanencia.filas.every(f => f.concepto && f.concepto !== '—') &&
      permanencia.filas.every(f => f.fecha && !/^\d{4}-\d{2}-\d{2}$/.test(f.fecha)),
      `el desglose de permanencia fue ${JSON.stringify(permanencia.filas)} (se esperaban 2 filas con concepto y fecha legible)`)

    // 3.000,00 € (cuota) + 0,00 € (comedor: descuento del 100 %, `0º.tricies.ter`) +
    // 500,00 € (permanencia) = 3.500,00 €. El total es de NETOS, así que un plan
    // íntegramente descontado suma cero — que es exactamente el caso real del comedor.
    const totalTxt = await page.$eval('[data-testid="paso7-total-solicitante"]',
      el => (el.textContent || '').trim()).catch(() => '')
    c.afirmar('el total del solicitante es la SUMA de sus planes',
      /3[.,]?500[.,]00/.test(totalTxt),
      `el total leído fue ${JSON.stringify(totalTxt)}: se esperaba la suma de los tres planes en NETO (3.500,00 €)`)

    // ⭐ `0º.tricies.ter` (Diego, 2026-08-22: *«el comedor y la permanencia sí aplican el
    // descuento, pero pasa muy desapercibido… faltan totales, subtotales»*) — LAS TRES
    // AFIRMACIONES DEL ESCALÓN QUE FALTABA. El plan del comedor es el caso real: nueve
    // filas con importe y un total de 0,00 €, sin nada en medio que lo explicara.
    const comedorCifras = await page.$$eval('[data-testid="paso7-plan"]', bloques => {
      const b = bloques.find(x => /Comedor/.test(x.textContent || ''))
      if (!b) return null
      const fila = b.querySelector('[data-testid="paso7-desglose-fila"]')
      const sub  = b.querySelector('[data-testid="paso7-subtotal-plan"]')
      const txt  = (el, sel) => {
        const n = el && el.querySelector(sel)
        return n ? (n.textContent || '').trim() : null
      }
      return {
        fila_descuento:  txt(fila, '[data-testid="paso7-desglose-descuento"]'),
        fila_neto:       txt(fila, '[data-testid="paso7-desglose-neto"]'),
        sub_bruto:       txt(sub,  '[data-testid="paso7-subtotal-bruto"]'),
        sub_descuento:   txt(sub,  '[data-testid="paso7-subtotal-descuento"]'),
        sub_neto:        txt(sub,  '[data-testid="paso7-subtotal-neto"]'),
      }
    })
    if (!c.afirmar('el plan con descuento se encuentra en la pantalla', !!comedorCifras,
      'no se localizó el bloque del comedor: sin él, las tres afirmaciones siguientes pasarían en vacío')) return c

    // (a) una fila con descuento ENSEÑA SU IMPORTE de descuento — no solo el nombre.
    c.afirmar('cada vencimiento con descuento enseña SU IMPORTE de descuento',
      !!comedorCifras.fila_descuento && /\d/.test(comedorCifras.fila_descuento) &&
      comedorCifras.fila_descuento !== '—',
      `la columna de descuento de la primera fila leyó ${JSON.stringify(comedorCifras.fila_descuento)}: sin cifra, el descuento sigue pasando desapercibido`)

    // (b) el SUBTOTAL del plan enseña bruto, descuento y neto — el escalón intermedio.
    c.afirmar('el subtotal del plan enseña bruto, descuento y neto',
      [comedorCifras.sub_bruto, comedorCifras.sub_descuento, comedorCifras.sub_neto]
        .every(v => !!v && /\d/.test(v)),
      `el subtotal leyó ${JSON.stringify({ bruto: comedorCifras.sub_bruto, desc: comedorCifras.sub_descuento, neto: comedorCifras.sub_neto })}: sin las tres cifras no hay nada entre las filas y el total`)

    // (c) LAS CIFRAS VIENEN DEL SERVIDOR, no de una cuenta del navegador: se comprueba que
    // lo pintado es EXACTAMENTE lo que mandó el simulado, sin recalcular nada.
    c.afirmar('las cifras del subtotal son las que mandó el servidor, sin recalcular',
      /1[.,]?200[.,]00/.test(comedorCifras.sub_bruto || '') &&
      /1[.,]?200[.,]00/.test(comedorCifras.sub_descuento || '') &&
      /0[.,]00/.test(comedorCifras.sub_neto || ''),
      `el subtotal leyó ${JSON.stringify({ bruto: comedorCifras.sub_bruto, desc: comedorCifras.sub_descuento, neto: comedorCifras.sub_neto })}: el servidor mandó 1.200,00 € / 1.200,00 € / 0,00 €`)

    return c
  } finally {
    scenario.dosPlanes = false
  }
}

/**
 * simulador-tras-enviar — LA FAMILIA QUE YA ENVIÓ TAMBIÉN PUEDE CONSULTAR SUS CUOTAS (`③70`).
 *
 * ── El defecto que cierra ────────────────────────────────────────────────────────────
 * Diego, 2026-08-21: *«si una familia entra en el wizard se va a quedar en el paso 7, con
 * todos los pasos previos bloqueados, y con el aviso de que la solicitud está enviada. A lo
 * mejor lo que sí puede hacer en esta pantalla es consultar la simulación, ver los distintos
 * planes o modalidades»*. Hasta hoy el recuadro de cuotas se pintaba SOLO en la rama
 * «todavía no enviada», así que quien volvía a entrar no veía ni una cifra.
 *
 * ── Qué afirma, y por qué en ESTE orden ──────────────────────────────────────────────
 *   (a) que la pantalla es de verdad la de «solicitud enviada» — sin este ancla, las tres
 *       siguientes podrían pasar sobre la pantalla de antes de enviar y no medirían nada;
 *   (b) que el recuadro se pinta y enseña LAS CIFRAS (calendario con concepto y fecha);
 *   (c) que se ven TODAS las formas de pago, para poder compararlas;
 *   (d) que NO hay control de elegir y que mirar la simulación no manda NI UNA escritura.
 *
 * ⚠️ La batería corre contra un backend SIMULADO: `backend/Code.js` no se ejecuta aquí, así
 * que esto afirma lo que pinta el navegador, no lo que permite el servidor. Que
 * `simularCuotas_` siga sin exigir `assertGroupEditable_` se midió leyendo el código real.
 */
async function caminoSimuladorTrasEnviar(page, base) {
  const c = new Camino('simulador-tras-enviar')
  scenario.stage = 'enviada'
  scenario.simulacionFalla = false

  if (REAL) {
    c.noCubierta('simulador-tras-enviar',
      'exige un expediente ya enviado CON plantillas de tarifa declaradas; el arnés no puede sembrarlo contra el sistema de verdad')
    return c
  }

  const llamadas = []
  const espiar = (req) => {
    if (!/\/__gas/.test(req.url())) return
    let body = null
    try { body = JSON.parse(req.postData() || '{}') } catch { return }
    llamadas.push(body && body.action)
  }
  page.on('request', espiar)

  try {
    if (!await entrarPorElEnlace(c, page, base)) return c
    await page.waitForTimeout(LATENCY + 800)

    // (a) el ancla: esto TIENE que ser la pantalla de «solicitud enviada».
    const pantalla = await page.evaluate(sondaPantalla)
    c.evidencia.elementos = pantalla.pasos + pantalla.campos + pantalla.tarjetas
    c.afirmar('sin pantalla de error', !pantalla.errorFatal,
      'el ErrorBoundary pintó "Something went wrong."')
    if (!c.afirmar('una solicitud ya enviada aterriza en Revisión (paso 7.º)',
      pantalla.pasoActivo === 6,
      `aterrizó en el índice ${pantalla.pasoActivo} (se esperaba 6)`)) return c
    const avisoEnviada = await page.$('[data-testid="correction-open"]')
    if (!c.afirmar('la pantalla es la de «solicitud enviada» (ofrece pedir corrección)',
      !!avisoEnviada,
      'no se encontró el botón de corregir: esta pantalla no es la de enviada, y las afirmaciones siguientes no medirían nada')) return c

    // (b) el recuadro se pinta, y con cifras.
    const bloque = await page.$('[data-testid="paso7-simulador"]')
    if (!c.afirmar('la familia que ya envió VE la simulación de cuotas', !!bloque,
      'no se pintó [data-testid="paso7-simulador"] con la solicitud enviada: la familia se queda sin ninguna cifra')) return c

    const filas = await page.$$eval('[data-testid="paso7-desglose-fila"]', trs => trs.map(tr => ({
      concepto: ((tr.querySelector('[data-testid="paso7-desglose-concepto"]') || {}).textContent || '').trim(),
      fecha:    ((tr.querySelector('[data-testid="paso7-desglose-fecha"]')    || {}).textContent || '').trim(),
    })))
    c.evidencia.elementos = Math.max(c.evidencia.elementos || 0, filas.length)
    c.afirmar('enseña el calendario completo, con concepto y fecha legible',
      filas.length > 0 &&
      filas.every(f => f.concepto && f.concepto !== '—') &&
      filas.every(f => f.fecha && !/^\d{4}-\d{2}-\d{2}$/.test(f.fecha)),
      `las filas leídas fueron ${JSON.stringify(filas)}: sin ellas la consulta no sirve de nada`)

    // (c) se ven TODAS las formas de pago (el doble sirve dos a propósito).
    const opciones = await page.$$eval('[data-testid="paso7-modalidad"]', els => els.map(
      e => (e.textContent || '').trim()))
    c.afirmar('se ven las DOS formas de pago, para poder compararlas',
      opciones.length >= 2,
      `se pintaron ${opciones.length} opción(es): con una sola, «ver los distintos planes o modalidades» no se está comprobando`)
    c.afirmar('cada forma de pago enseña su importe',
      opciones.length >= 2 && opciones.every(txt => /\d/.test(txt) && /€|EUR/.test(txt)),
      `los textos leídos fueron ${JSON.stringify(opciones)}: sin importe esto no es una consulta de tarifas`)

    // (d) NO se puede elegir, y consultar no escribe nada.
    const selector = await page.$('[data-testid="paso7-modalidad-selector"]')
    c.afirmar('con la solicitud enviada NO se ofrece elegir la forma de pago',
      !selector,
      'se pintó el desplegable de elegir: la elección en firme es la del paso 8, y aquí prometería algo que esta pantalla no puede dar')

    const escrituras = llamadas.filter(a => /^(saveStep|saveResponses|uploadDocument|submitEnrollmentSession|guardarModalidadPreferida|applyPaymentModality|saveBillingInfo|saveNeae|retirarDelExpediente)$/.test(a || ''))
    c.evidencia.llamadas = Math.max(c.evidencia.llamadas || 0, 1)
    c.afirmar('consultar la simulación no manda NI UNA escritura',
      escrituras.length === 0,
      `salieron escrituras: ${JSON.stringify(escrituras)} (todas las llamadas: ${JSON.stringify(llamadas)})`)

    return c
  } finally {
    page.off('request', espiar)
  }
}

/**
 * codigo-sin-congelar — PEDIR EL CÓDIGO DE UN SOLO USO NO CONGELA LA PANTALLA.
 *
 * ── El defecto que cierra, MEDIDO (registro real de Diego, 2026-08-19) ───────────────
 * `sendVerificationCode` tardó **77 s** de reloj (73 s de servidor: dos viajes al KMS para
 * resolver de quién es el buzón + uno para APUNTAR el envío — que ni siquiera manda el
 * correo: lo manda después un repaso que tarda otros ~56 s de media). Durante esos 77 s la
 * pantalla ataba `codeSent` a la RESPUESTA ⇒ casilla del código deshabilitada, «Acceder»
 * deshabilitado y «reenviar» también. La familia miraba una tarjeta congelada, y el código
 * podía llegarle al buzón ANTES de que la pantalla la dejase teclearlo.
 *
 * ── Cómo se mide, y por qué así ─────────────────────────────────────────────────────
 * El invariante NO es «aparece rápido»: es «lo que se ve NO puede venir de la respuesta».
 * Así que se cronometra contra el propio viaje — se apunta CUÁNDO sale y CUÁNDO vuelve cada
 * petición (eventos de red de Playwright, no el reloj del robot) y se comprueba que el aviso
 * ya estaba en pantalla ANTES de que volviera. Para que la distinción sea holgada y no una
 * carrera de milisegundos, este camino pide al servidor de la batería que ESE viaje tarde
 * mucho más que los demás (`scenario.codigoDemoraMs`) — que es justo lo que pasa de verdad.
 *
 * ── Se conduce el BOTÓN, no el envío automático ──────────────────────────────────────
 * Al entrar por el enlace, el gate se monta, auto-envía el código… y **se vuelve a montar**
 * (`WizardPage` pone `rehydrating` a true al re-hidratar ⇒ `mustPassEntryGate` cae y el gate
 * desaparece un instante). Este camino mide el gesto que la familia hace CON EL BOTÓN, así
 * que entra dos veces y parte de una verja que no auto-envía (ver `abrirLaVerja`).
 *   · El defecto que ese remontaje causaba —la segunda instancia olvidaba el envío y ofrecía
 *     «Pulsa para recibir tu código» con un código ya en vuelo— se CERRÓ el 2026-08-22
 *     (`0º.tricies.nonies`), y quien lo vigila es el camino `codigo-al-entrar-por-enlace`.
 *     Aquí ya no se anota como pendiente.
 *
 * ⚠️ Esto cubre LA PANTALLA. El `backend/Code.js` no se ejecuta en esta batería (el backend
 * es simulado): lo que el servidor del asistente hace con la petición no está aquí.
 */
async function caminoCodigoSinCongelar(page, base) {
  const c = new Camino('codigo-sin-congelar')
  scenario.stage = 'hasta_preguntas'

  if (REAL) {
    // Contra el sistema de verdad la verja solo se abre dejando caducar la gracia del
    // enlace, y el código llega a un buzón que este arnés no lee. No se afloja la verja
    // para que la prueba pase.
    c.noCubierta('aviso-antes-que-la-respuesta', 'ver NO_CUBIERTAS_SOLO_REAL')
    c.noCubierta('casilla-lista-sin-esperar',    'ver NO_CUBIERTAS_SOLO_REAL')
    c.noCubierta('se-entra-sin-esperar',         'ver NO_CUBIERTAS_SOLO_REAL')
    c.noCubierta('el-fallo-sustituye-al-aviso',  'ver NO_CUBIERTAS_SOLO_REAL')
    c.noCubierta('reenviar-limitado-por-reloj',  'ver NO_CUBIERTAS_SOLO_REAL')
    return c
  }

  // Cuándo SALE y cuándo VUELVE cada petición. Listas, no un solo valor: por el remontaje
  // de arriba hay un envío automático en vuelo antes de que la familia toque nada, y
  // quedarse con «la primera» mediría la petición equivocada.
  const salidas = {}
  const vueltas = {}
  const accionDe = (req) => {
    try { return JSON.parse(req.postData() || '{}').action || '' } catch { return '' }
  }
  const anota = (bolsa) => (req) => {
    if (!/\/__gas/.test(req.url())) return
    const a = accionDe(req)
    if (!a) return
    ;(bolsa[a] = bolsa[a] || []).push(Date.now())
  }
  const alPedir = anota(salidas)
  const alVolver = anota(vueltas)
  page.on('request', alPedir)
  page.on('requestfinished', alVolver)
  const cuantas = (bolsa, a) => (bolsa[a] || []).length
  const ultima  = (bolsa, a) => { const l = bolsa[a] || []; return l.length ? l[l.length - 1] : null }

  const limpiar = () => {
    page.off('request', alPedir)
    page.off('requestfinished', alVolver)
    scenario.piiGated = false
    scenario.otpSuperado = false
    scenario.codigoDemoraMs = 0
    scenario.codigoFalla = null
  }

  /** Lo que la familia VE en la verja y lo que puede hacer, en un solo tiro. */
  const verja = () => page.evaluate(() => {
    const casilla  = document.querySelector('input[autocomplete="one-time-code"]')
    const acceder  = [...document.querySelectorAll('button.btn-primary-kis')][0] || null
    const reenviar = document.querySelector('[data-testid="stepup-reenviar"]')
    const aviso    = document.querySelector('[data-testid="stepup-enviado"]')
    const error    = document.querySelector('[data-testid="stepup-error"]')
    return {
      hayVerja:          !!casilla,
      casillaLista:      !!(casilla && !casilla.disabled),
      accederBloqueado:  !!(acceder && acceder.disabled),
      aviso:             aviso ? (aviso.innerText || '').trim() : null,
      error:             error ? (error.innerText || '').trim() : null,
      reenviarBloqueado: !!(reenviar && reenviar.disabled),
      reenviarTexto:     reenviar ? (reenviar.textContent || '').trim() : null,
    }
  })

  /**
   * Espera a que NO quede ninguna petición del código en vuelo.
   *
   * Hace falta en los DOS extremos de cada pase: irse de la página con un `fetch` a medias
   * lo ABORTA y la app registra un «network/fetch error» que NO es suyo, sino del robot
   * (mismo motivo que `esperarSilencioDeRed`); y empezar a medir con una petición vieja
   * volando mediría la petición equivocada.
   */
  const drenar = async () => {
    const t0 = Date.now()
    const techo = LATENCY + Number(scenario.codigoDemoraMs || 0) + 12000
    while (cuantas(vueltas, 'sendVerificationCode') < cuantas(salidas, 'sendVerificationCode')
           && Date.now() - t0 < techo) {
      await page.waitForTimeout(120)
    }
    await page.waitForTimeout(300)
  }

  /**
   * Igual, pero espera a que NO quede NINGUNA petición en vuelo, de cualquier acción.
   *
   * Hace falta entre las DOS entradas de `abrirLaVerja`: el precalentado (`warmSession`) sale
   * al montar la verja y el segundo `goto` lo ABORTA, lo que la aplicación registra como
   * «network/fetch error» — un error que NO es suyo sino del robot, y que el arnés cuenta como
   * fallo del camino. Medido el 2026-08-22: exactamente dos, uno por entrada.
   */
  const drenarTodo = async () => {
    const total = (bolsa) => Object.values(bolsa).reduce((n, l) => n + l.length, 0)
    const t0 = Date.now()
    const techo = LATENCY + Number(scenario.codigoDemoraMs || 0) + 12000
    while (total(vueltas) < total(salidas) && Date.now() - t0 < techo) await page.waitForTimeout(120)
    await page.waitForTimeout(300)
  }

  /**
   * Abre la verja de cero y deja la pantalla QUIETA: espera a que el envío automático haya ido
   * y vuelto, para que lo que se mida después sea la petición del BOTÓN y no la suya.
   *
   * ⚠️ Desde `0º.tricies.nonies` el auto-envío de la PRIMERA entrada deja su espera corta
   * corriendo (antes se perdía en el remontaje y el botón quedaba libre por accidente — ése era
   * el defecto). Este recorrido mide el GESTO de la familia, así que entra una SEGUNDA vez: la
   * sesión ya no auto-envía (`otpAutoSentForRecovery` persiste) y la verja parte de cero, con
   * su botón disponible. Quien mide el auto-envío es `codigo-al-entrar-por-enlace`.
   */
  const abrirLaVerja = async (etiqueta) => {
    await drenar()
    const ir = async (sufijo) => {
      await page.goto(`${base}/?verja=${etiqueta}${sufijo}#/resume/${DATOS.resumeToken}?n=${DATOS.emailId}`,
        { waitUntil: 'domcontentloaded', timeout: 30000 })
      return await page.waitForSelector('input[autocomplete="one-time-code"]', { timeout: LATENCY * 3 + 15000 })
        .then(() => true).catch(() => false)
    }
    if (!await ir('')) return false
    await drenarTodo()
    if (!await ir('bis')) return false
    await drenarTodo()
    return true
  }

  /** Pulsa «Enviar código» / «Reenviar código» y devuelve false si estaba bloqueado. */
  const pedirElCodigo = () => page.evaluate(() => {
    const b = document.querySelector('[data-testid="stepup-reenviar"]')
    if (!b || b.disabled) return false
    b.click(); return true
  })

  try {
    scenario.piiGated = true
    scenario.otpSuperado = false
    // El viaje del código tarda MUCHO más que la latencia normal — como en la vida real.
    scenario.codigoDemoraMs = 4000

    // ══ PASE 1 · el aviso, la casilla y la espera del reenvío ═════════════════════
    if (!c.afirmar('con la verja puesta, el asistente pide el código antes de enseñar nada',
      await abrirLaVerja('p1'),
      'nunca apareció la casilla del código: la secuencia que este recorrido mide no llegó a darse')) return c

    const salidasAntes = cuantas(salidas, 'sendVerificationCode')
    const vueltasAntes = cuantas(vueltas, 'sendVerificationCode')
    if (!c.afirmar('la familia puede pedir su código', await pedirElCodigo(),
      'el botón de pedir el código estaba bloqueado nada más abrir la verja')) return c

    // El aviso tiene que estar ANTES de que vuelva esa petición. Se le da un techo corto
    // (2,5 s) frente a los 4,8 s que tarda el servidor: si no cabe ahí, es que espera.
    let foto = null
    let respuestaYaVuelta = null
    try {
      await page.waitForFunction(
        () => !!document.querySelector('[data-testid="stepup-enviado"]'),
        null, { timeout: 2500 })
      foto = await verja()
      respuestaYaVuelta = cuantas(vueltas, 'sendVerificationCode') > vueltasAntes
    } catch {
      // Un rojo se DIAGNOSTICA: se imprime lo que de verdad hay en la verja.
      const f = await verja()
      c.fallos.push('el aviso de «te hemos enviado un código» no apareció en 2,5 s, con una respuesta del servidor que tarda ' +
        `${LATENCY + scenario.codigoDemoraMs} ms: la pantalla está esperando al servidor para decir lo que ya sabe. ` +
        `Estado de la verja: ${JSON.stringify(f)}`)
      return c
    }
    c.evidencia.elementos = 1
    c.evidencia.llamadas  = cuantas(salidas, 'sendVerificationCode')

    c.afirmar('el aviso de «enviado» aparece ANTES de que el servidor conteste',
      !respuestaYaVuelta,
      'cuando el aviso apareció, la respuesta de sendVerificationCode YA había vuelto: el aviso viene del viaje, no del gesto')

    c.afirmar('la casilla del código está lista en ese mismo momento',
      foto.casillaLista,
      'se le decía a la familia que el código estaba enviado y la casilla seguía deshabilitada: la pantalla se queda congelada esperando al servidor')

    c.afirmar('el aviso dice qué hacer si el código no llega',
      /2-3|2 ?a ?3/.test(foto.aviso || ''),
      `el aviso dice «${foto.aviso}» y no da un plazo concreto: «espera unos minutos» no le sirve a quien no sabe si pedir otro`)

    // ── «reenviar» limitado por RELOJ, no por el viaje ─────────────────────────────
    // Ya con la petición contestada (ningún viaje en vuelo), si el botón sigue bloqueado
    // solo puede ser por la espera corta y deliberada.
    const t0 = Date.now()
    while (cuantas(vueltas, 'sendVerificationCode') <= vueltasAntes
           && Date.now() - t0 < LATENCY + scenario.codigoDemoraMs + 8000) {
      await page.waitForTimeout(120)
    }
    if (cuantas(vueltas, 'sendVerificationCode') <= vueltasAntes) {
      c.fallos.push('la respuesta de sendVerificationCode nunca volvió: no se puede distinguir «bloqueado por el viaje» de «bloqueado por el reloj»')
      return c
    }
    await page.waitForTimeout(500)
    const trasVolver = await verja()
    c.afirmar('«reenviar» sigue limitado por su espera corta cuando ya NO hay viaje en vuelo',
      trasVolver.reenviarBloqueado && /\d/.test(trasVolver.reenviarTexto || ''),
      trasVolver.reenviarBloqueado
        ? `el botón está bloqueado pero no dice cuánto falta («${trasVolver.reenviarTexto}»): la familia no puede saber si está roto o esperando`
        : `el botón quedó libre («${trasVolver.reenviarTexto}») en cuanto contestó el servidor: la limitación seguía siendo el viaje, no una espera deliberada`)
    c.afirmar('el envío de la petición no dejó nada bloqueado ni borró lo tecleado',
      trasVolver.casillaLista, 'la casilla se deshabilitó al volver la respuesta')

    // ══ PASE 2 · se puede TECLEAR y ENTRAR sin esperar a esa respuesta ════════════
    scenario.otpSuperado = false
    if (!c.afirmar('la verja vuelve a abrirse para el segundo pase', await abrirLaVerja('p2'),
      'la casilla del código no volvió a aparecer')) return c
    const vueltasP2 = cuantas(vueltas, 'sendVerificationCode')
    if (!c.afirmar('la familia vuelve a poder pedir su código', await pedirElCodigo(),
      'el botón de pedir el código estaba bloqueado al abrir la verja de nuevo')) return c
    await page.waitForFunction(
      () => !!document.querySelector('[data-testid="stepup-enviado"]'), null, { timeout: 2500 }).catch(() => {})

    await page.fill('input[autocomplete="one-time-code"]', '123456')
    const pulsado = await page.evaluate(() => {
      const b = [...document.querySelectorAll('button.btn-primary-kis')].find(x => !x.disabled)
      if (!b) return false
      b.click(); return true
    })
    if (!c.afirmar('«Acceder» se puede pulsar sin esperar a la respuesta del código', pulsado,
      'el botón de acceder seguía deshabilitado: la familia no puede entrar aunque tenga el código delante')) return c

    // La prueba dura: la verificación SALIÓ antes de que volviera la petición del código.
    const t1 = Date.now()
    while (!ultima(salidas, 'verifyEmail') && Date.now() - t1 < 4000) await page.waitForTimeout(80)
    const salidaVerify = ultima(salidas, 'verifyEmail')
    const vueltaCodigo = cuantas(vueltas, 'sendVerificationCode') > vueltasP2
      ? ultima(vueltas, 'sendVerificationCode') : null
    c.afirmar('la verificación sale ANTES de que vuelva la petición del código',
      !!salidaVerify && (vueltaCodigo == null || salidaVerify < vueltaCodigo),
      salidaVerify == null
        ? 'nunca salió la llamada verifyEmail: pulsar «Acceder» no hizo nada'
        : 'la verificación no salió hasta que el servidor contestó a la petición del código: entrar sigue encadenado al viaje')

    c.afirmar('tras el código, el asistente abre la solicitud',
      await page.waitForFunction(() => {
        const pasos = document.querySelectorAll('.wizard-step')
        return !!(pasos.length && [...pasos].some(p => p.classList.contains('active')))
      }, null, { timeout: LATENCY * 4 + 20000 }).then(() => true).catch(() => false),
      'el asistente no llegó a pintar los pasos después de verificar el código')

    // ══ PASE 3 · un «enviado» que era MENTIRA se corrige en pantalla ══════════════
    // El rechazo se PROVOCA a propósito: que quede registrado en consola es lo correcto.
    c.esperarErrorConsola(/gasCall sendVerificationCode: server returned ok=false/,
      'el servidor rechaza la petición del código a propósito, para comprobar que la familia se entera')
    c.esperarErrorConsola(/StepUpGate: sendVerificationCode failed/,
      'la pantalla registra el rechazo provocado antes de explicárselo a la familia')
    scenario.otpSuperado = false
    scenario.codigoFalla = 'RATE_LIMITED'
    scenario.codigoDemoraMs = 1500
    if (!c.afirmar('la verja vuelve a abrirse para el tercer pase', await abrirLaVerja('p3'),
      'la casilla del código no volvió a aparecer')) return c
    const vueltasP3 = cuantas(vueltas, 'sendVerificationCode')
    if (!c.afirmar('la familia pide su código con el servidor a punto de rechazar', await pedirElCodigo(),
      'el botón de pedir el código estaba bloqueado')) return c

    let optimista = null
    try {
      await page.waitForFunction(
        () => !!document.querySelector('[data-testid="stepup-enviado"]'), null, { timeout: 1200 })
      optimista = cuantas(vueltas, 'sendVerificationCode') <= vueltasP3
    } catch { optimista = null }
    if (!c.afirmar('también con el servidor a punto de rechazar, el aviso sale primero',
      optimista === true,
      optimista === null
        ? 'no se llegó a ver el aviso optimista, así que no se puede comprobar que se corrige'
        : 'el aviso apareció cuando el servidor ya había contestado: no era optimista')) return c

    // Se teclea un código ANTES de que llegue el rechazo: la corrección no puede quitárselo.
    await page.fill('input[autocomplete="one-time-code"]', '123456')

    const corregido = await page.waitForFunction(
      () => !!document.querySelector('[data-testid="stepup-error"]'),
      null, { timeout: LATENCY + scenario.codigoDemoraMs + 8000 }).then(() => true).catch(() => false)
    await page.waitForTimeout(300)
    const tras = await verja()
    const tecleado = await page.$eval('input[autocomplete="one-time-code"]', el => el.value).catch(() => '')
    c.afirmar('cuando la petición acaba mal, el aviso se SUSTITUYE por el error real',
      corregido && !!tras.error && tras.aviso == null,
      corregido
        ? `el error salió pero el «te lo hemos enviado» sigue en pantalla («${tras.aviso}»): la familia lee dos cosas que se contradicen`
        : 'la pantalla se quedó diciendo «te hemos enviado un código» después de que el servidor rechazara la petición: el fallo se tragó')
    c.afirmar('el error que se muestra es el REAL del servidor, no uno genérico',
      /demasiados c[oó]digos|requested too many/i.test(tras.error || ''),
      `el aviso de error dice «${tras.error}» y no el de cupo agotado (RATE_LIMITED) que devolvió el servidor`)
    c.afirmar('un fallo al pedir el código NO cierra el camino de entrar',
      tras.casillaLista && !tras.accederBloqueado && tecleado === '123456',
      `tras el rechazo la casilla está ${tras.casillaLista ? 'lista' : 'DESHABILITADA'}, «Acceder» está ${tras.accederBloqueado ? 'BLOQUEADO' : 'disponible'} y lo tecleado es «${tecleado}»: una familia con un código válido de un envío anterior se queda fuera por un fallo que no le afecta`)

    // Ni un fetch a medias al salir: el camino siguiente no puede heredar un error de red
    // que provocó el robot al irse de la página.
    await drenar()
    return c
  } finally {
    limpiar()
  }
}

/**
 * codigo-al-entrar-por-enlace — ENTRAR POR EL ENLACE MANDA UN SOLO CÓDIGO, Y LA PANTALLA LO DICE.
 *
 * ── El defecto que cierra (Diego, 2026-08-22) ────────────────────────────────────────
 * *«Cuando se carga el wizard desde un enlace, automáticamente envía un OTP y eso da error,
 * porque la pantalla de carga permite enviar otro. No tiene sentido.»*
 *
 * ── La causa, MEDIDA — y NO era ninguno de los dos candidatos de la ficha ────────────
 * La verja se **REMONTA**: `WizardPage` la pinta, ésta auto-envía el código, y acto seguido su
 * efecto de rehidratación (`needsHydration`, cierto porque la hidratación con el candado puesto
 * vuelve sin `email.verified`) pone `rehydrating=true` ⇒ el padre devuelve el loader neutro y la
 * verja DESAPARECE. Al volver (15-40 s), la SEGUNDA instancia nacía con su estado local a cero:
 * «pulsa para recibir tu código», casilla DESHABILITADA y botón «Enviar» LIBRE — con el primer
 * código ya volando. La familia no tenía más remedio que pulsar para poder teclear, y ese
 * segundo envío PISA al primero en la caché del servidor (`cache.put(codeKey, code, 600)`,
 * `backend/Code.js`) ⇒ el código que ya le había llegado deja de valer.
 *   · NO era «el auto-envío falla» (candidato 1): el envío sale bien.
 *   · NO era «`autoSentRef` se reinicia y auto-envía otra vez» (candidato 2): `shouldAutoSend`
 *     ya es falso en la segunda instancia, porque `otpAutoSentForRecovery` persiste. Lo que se
 *     perdía no era el freno del envío, era la MEMORIA de que ya se había enviado.
 *
 * ── Qué se afirma aquí ───────────────────────────────────────────────────────────────
 * (1) entrar por el enlace gasta UN solo código · (2) la pantalla DICE que ya se envió ·
 * (3) la casilla está lista para teclearlo · (4) «reenviar» está en su espera corta, así que no
 * se invita a quemar otro · (5) y con eso se entra. Y la otra mitad: (6) si ese auto-envío FALLA,
 * el error llega a la familia aunque lo provoque una instancia ya desmontada, y (7) no la deja
 * sin salida.
 *
 * ⚠️ Esto cubre LA PANTALLA. `backend/Code.js` no se ejecuta en esta batería (backend simulado).
 */
async function caminoCodigoAlEntrarPorEnlace(page, base) {
  const c = new Camino('codigo-al-entrar-por-enlace')
  scenario.stage = 'hasta_preguntas'

  if (REAL) {
    // Contra el sistema de verdad la verja solo se abre dejando caducar la gracia del enlace, y
    // el código llega a un buzón que este arnés no lee. No se afloja la verja para que pase.
    c.noCubierta('un-solo-codigo-al-entrar', 'ver NO_CUBIERTAS_SOLO_REAL')
    c.noCubierta('la-pantalla-dice-que-ya-se-envio', 'ver NO_CUBIERTAS_SOLO_REAL')
    c.noCubierta('el-fallo-del-autoenvio-llega', 'ver NO_CUBIERTAS_SOLO_REAL')
    return c
  }

  const peticiones = []
  const enVuelo = { n: 0 }
  const alPedir = (req) => {
    if (!/\/__gas/.test(req.url())) return
    enVuelo.n++
    try { const a = JSON.parse(req.postData() || '{}').action; if (a) peticiones.push(a) } catch { /* cuerpo raro */ }
  }
  const alVolver = (req) => { if (/\/__gas/.test(req.url())) enVuelo.n-- }
  page.on('request', alPedir)
  page.on('requestfinished', alVolver)
  page.on('requestfailed', alVolver)
  const cuantas = (a) => peticiones.filter(x => x === a).length

  /**
   * Espera a que no quede NADA en vuelo antes de navegar. Irse de la página con un `fetch` a
   * medias lo ABORTA y la aplicación registra un «network/fetch error» que NO es suyo sino del
   * robot — y el arnés lo cuenta como fallo del camino (mismo motivo que `esperarSilencioDeRed`).
   */
  const drenar = async () => {
    const t0 = Date.now()
    const techo = LATENCY + Number(scenario.codigoDemoraMs || 0) + 16000
    // No basta «cero en vuelo AHORA»: `ResumePage` dispara el precalentado (`warmBundle`) con
    // un `setTimeout` de 4 s tras hidratar. Se exige un tramo de QUIETUD que lo cubra.
    let desde = null
    for (;;) {
      if (enVuelo.n > 0) desde = null
      else if (desde == null) desde = Date.now()
      else if (Date.now() - desde >= 4600) break
      if (Date.now() - t0 > techo) break
      await page.waitForTimeout(120)
    }
    await page.waitForTimeout(300)
  }

  const limpiar = () => {
    page.off('request', alPedir)
    page.off('requestfinished', alVolver)
    page.off('requestfailed', alVolver)
    scenario.piiGated = false
    scenario.otpSuperado = false
    scenario.codigoFalla = null
    scenario.codigoDemoraMs = 0
  }

  /** Lo que la familia VE en la verja y lo que puede hacer, en un solo tiro. */
  const verja = () => page.evaluate(() => {
    const casilla  = document.querySelector('input[autocomplete="one-time-code"]')
    const reenviar = document.querySelector('[data-testid="stepup-reenviar"]')
    const aviso    = document.querySelector('[data-testid="stepup-enviado"]')
    const error    = document.querySelector('[data-testid="stepup-error"]')
    return {
      hayVerja:          !!casilla,
      casillaLista:      !!(casilla && !casilla.disabled),
      aviso:             aviso ? (aviso.innerText || '').trim() : null,
      error:             error ? (error.innerText || '').trim() : null,
      reenviarBloqueado: !!(reenviar && reenviar.disabled),
      reenviarTexto:     reenviar ? (reenviar.textContent || '').trim() : null,
    }
  })

  /**
   * Entra por el enlace y espera a que la pantalla se ASIENTE: la verja aparece, DESAPARECE
   * mientras rehidrata y vuelve. Mirar antes de eso mediría la instancia que va a morir, que es
   * justo el error de método que este recorrido existe para no cometer.
   */
  const entrarYAsentar = async (etiqueta) => {
    await drenar()
    await page.goto(`${base}/?codigo=${etiqueta}#/resume/${DATOS.resumeToken}?n=${DATOS.emailId}`,
      { waitUntil: 'domcontentloaded', timeout: 30000 })
    const hay = await page.waitForSelector('input[autocomplete="one-time-code"]', { timeout: LATENCY * 3 + 15000 })
      .then(() => true).catch(() => false)
    if (!hay) return false
    // La rehidratación tapa la verja con el loader neutro y la vuelve a pintar. Se espera a que
    // el asistente deje de pedir cosas y la pantalla quede quieta.
    await page.waitForTimeout(LATENCY * 2 + 2500)
    return await page.$('input[autocomplete="one-time-code"]') !== null
  }

  try {
    scenario.piiGated = true
    scenario.otpSuperado = false
    // El viaje del código tarda MUCHO más que la latencia normal — como en la vida real. Así el
    // remontaje ocurre con la petición todavía en vuelo, que es el caso que rompía.
    scenario.codigoDemoraMs = 3000

    // ══ FASE A · entrar por el enlace: UN código, y la pantalla lo dice ═══════════════
    if (!c.afirmar('con la verja puesta, el asistente pide el código antes de enseñar nada',
      await entrarYAsentar('a'),
      'nunca apareció la casilla del código: la secuencia que este recorrido mide no llegó a darse')) return c

    const foto = await verja()
    c.evidencia.elementos = 1
    c.evidencia.llamadas  = peticiones.length

    c.afirmar('(1) entrar por el enlace gasta UN SOLO código',
      cuantas('sendVerificationCode') === 1,
      `salieron ${cuantas('sendVerificationCode')} peticiones de código al entrar: la verja se remonta y la segunda instancia olvida que el primero ya iba de camino, así que la familia gasta otro de su cupo y el que le llegó al buzón deja de valer`)

    c.afirmar('(2) la pantalla DICE que el código ya se envió',
      !!foto.aviso,
      `tras asentarse, la verja no muestra el aviso de «te hemos enviado un código» (aviso: ${JSON.stringify(foto.aviso)}): con un código ya en vuelo, invita a pedir otro`)

    c.afirmar('(3) la casilla está lista para teclear el código que va a llegar',
      foto.casillaLista,
      'la casilla del código está DESHABILITADA con un código ya enviado: la familia se ve obligada a pulsar «Enviar» solo para poder escribir, y ese segundo envío invalida el primero')

    c.afirmar('(4) «reenviar» está en su espera corta, no ofreciendo otro código de inmediato',
      foto.reenviarBloqueado && /\d/.test(foto.reenviarTexto || ''),
      foto.reenviarBloqueado
        ? `el botón está bloqueado pero no dice cuánto falta («${foto.reenviarTexto}»)`
        : `el botón quedó libre («${foto.reenviarTexto}») justo después del auto-envío: se está invitando a la familia a quemar un segundo código`)

    // ⚠️ NO se teclea a ciegas: con la casilla deshabilitada `page.fill` LANZA, y el runner
    // descarta el camino entero sustituyéndolo por «el recorrido se rompió» — perdiendo las
    // cuatro afirmaciones de arriba, que son las que nombran el defecto. Se comprueba antes.
    const tecleado = foto.casillaLista
      ? await page.fill('input[autocomplete="one-time-code"]', '123456').then(() => true).catch(() => false)
      : false
    if (tecleado) {
      await page.evaluate(() => {
        const b = [...document.querySelectorAll('button.btn-primary-kis')].find(x => !x.disabled)
        if (b) b.click()
      })
    }
    c.afirmar('(5) con ese código se entra en la solicitud',
      tecleado && await page.waitForFunction(() => !!document.querySelector('.wizard-step'),
        null, { timeout: LATENCY * 4 + 20000 }).then(() => true).catch(() => false),
      tecleado
        ? 'el asistente no llegó a pintar los pasos tras teclear el código del auto-envío'
        : 'no se pudo ni teclear el código: la casilla sigue deshabilitada tras el auto-envío, así que la familia está obligada a pedir otro')

    // ══ FASE B · si ese auto-envío FALLA, la familia se entera ════════════════════════
    // El rechazo se PROVOCA a propósito: que quede registrado en consola es lo correcto.
    c.esperarErrorConsola(/gasCall sendVerificationCode: server returned ok=false/,
      'el servidor rechaza el auto-envío a propósito, para comprobar que la familia se entera')
    c.esperarErrorConsola(/StepUpGate: sendVerificationCode failed/,
      'la pantalla registra el rechazo provocado antes de explicárselo a la familia')

    // Sesión NUEVA: sin esto `otpAutoSentForRecovery` (sessionStorage) impide el auto-envío y
    // esta fase mediría el botón, no el auto-envío — que es lo que se quiere medir.
    await page.evaluate(() => { try { sessionStorage.clear() } catch { /* sandbox */ } })
    scenario.otpSuperado = false
    scenario.codigoFalla = 'RATE_LIMITED'
    const antes = cuantas('sendVerificationCode')
    if (!c.afirmar('la verja vuelve a abrirse con el servidor a punto de rechazar',
      await entrarYAsentar('b'), 'la casilla del código no volvió a aparecer')) return c

    const trasFallo = await verja()
    c.afirmar('(6) el fallo del auto-envío LLEGA a la familia, aunque lo provoque una pantalla que ya no existe',
      !!trasFallo.error && /demasiados c[oó]digos|requested too many/i.test(trasFallo.error),
      `la verja muestra error=${JSON.stringify(trasFallo.error)}: el rechazo lo dispara la instancia que se desmonta al rehidratar, así que si no sale del componente la familia se queda esperando un código que nunca salió`)

    c.afirmar('(6.bis) y NO se le sigue diciendo que se lo hemos enviado',
      trasFallo.aviso == null,
      `sigue en pantalla «${trasFallo.aviso}» junto al error: la familia lee dos cosas que se contradicen`)

    // Ni un fetch a medias al salir: el camino siguiente no puede heredar un error de red que
    // provocó el robot al irse de la página.
    await drenar()

    c.afirmar('(7) un auto-envío fallido NO cierra el camino de entrar',
      trasFallo.casillaLista && !trasFallo.reenviarBloqueado && cuantas('sendVerificationCode') === antes + 1,
      `casilla ${trasFallo.casillaLista ? 'lista' : 'DESHABILITADA'}, «reenviar» ${trasFallo.reenviarBloqueado ? 'BLOQUEADO' : 'libre'}, peticiones ${cuantas('sendVerificationCode') - antes} (se esperaba 1): tras un fallo la familia tiene que poder pedir otro sin esperar`)

    return c
  } finally {
    limpiar()
  }
}

/**
 * ventana-por-inactividad — el contador de los 10 minutos se reinicia con la actividad
 * REAL de la familia, el aviso sale dos minutos antes, y una RECARGA vuelve a pedir código.
 *
 * Decisión de Diego (2026-08-20): *«Es muy incómodo para las familias tener que estar
 * pidiendo el código cada 10 minutos. Hay que evitar que se pueda entrar con recarga (esto
 * debe bloquear, sí), pero no impedir que el usuario pueda seguir. Cada acción del usuario
 * debe reiniciar el contador de 10 minutos. No me parece mal un aviso dos minutos antes
 * […] pero solo si no ha estado haciendo clic»*.
 *
 * ⏱ EL RELOJ SE COMPRIME, EL MECANISMO NO. `scenario.ventanaMs` hace que el servidor
 * simulado conceda ventanas de segundos en vez de 10 minutos. Es legítimo porque el
 * cliente NO echa su propia cuenta: pinta y decide sobre el `step_up_restante_s` que le
 * manda el servidor (ése es justo el arreglo de este cambio). La secuencia que se observa
 * —se avisa, se reinicia con la actividad, se bloquea sin ella— es la misma que a los 10
 * minutos; lo único distinto es cuánto hay que esperar para verla.
 *
 * ⚠️ LO QUE ESTE RECORRIDO NO CUBRE, Y HAY QUE DECIRLO: `backend/Code.js` NO se ejecuta
 * aquí (el backend es simulado). Las afirmaciones (5), (6) y (7) miden el CONTRATO del
 * servidor contra el modelo del simulado, que es copia declarada del real. Quien toque
 * `_leerMarcaStepUp_` / `_extenderVentanaStepUp_` en el backend, que lo mida allí.
 */
async function caminoVentanaPorInactividad(page, base) {
  const c = new Camino('ventana-por-inactividad')
  scenario.stage = 'hasta_preguntas'

  if (REAL) {
    // Contra el sistema de verdad la ventana son 10 minutos de reloj y el código llega a
    // un buzón que este arnés no lee. No se afloja nada para que la prueba pase.
    c.noCubierta('la-actividad-reinicia-el-contador', 'ver NO_CUBIERTAS_SOLO_REAL')
    c.noCubierta('sin-actividad-avisa-y-bloquea',     'ver NO_CUBIERTAS_SOLO_REAL')
    c.noCubierta('con-actividad-no-hay-aviso',        'ver NO_CUBIERTAS_SOLO_REAL')
    c.noCubierta('la-recarga-vuelve-a-pedir-codigo',  'ver NO_CUBIERTAS_SOLO_REAL')
    c.noCubierta('el-pulso-no-alarga-nada',           'ver NO_CUBIERTAS_SOLO_REAL')
    c.noCubierta('caducada-no-se-resucita',           'ver NO_CUBIERTAS_SOLO_REAL')
    c.noCubierta('otra-huella-no-vale',               'ver NO_CUBIERTAS_SOLO_REAL')
    c.noCubierta('el-techo-avisa-por-seguridad',      'ver NO_CUBIERTAS_SOLO_REAL')
    return c
  }

  // La huella de página viva que el navegador acuña: se lee de una petición real, porque
  // es memoria privada del módulo y no hay otra forma honesta de conocerla.
  let huellaVista = null
  let refrescos = 0
  const alPedir = (req) => {
    if (!/\/__gas/.test(req.url())) return
    try {
      const b = JSON.parse(req.postData() || '{}')
      if (b.pv) huellaVista = b.pv
      if (b.action === 'refrescarVentana') refrescos++
    } catch { /* cuerpo raro */ }
  }
  page.on('request', alPedir)

  const limpiar = () => {
    page.off('request', alPedir)
    scenario.piiGated = false
    scenario.otpSuperado = false
    scenario.ventanaViva = false
    scenario.ventanaMs = 0
    scenario.techoMs = 0
  }

  /** ¿Está el asistente abierto (pasos pintados) o cerrado tras la verja del código? */
  const pantalla = () => page.evaluate(() => ({
    hayVerja: !!document.querySelector('input[autocomplete="one-time-code"]'),
    hayPasos: !!document.querySelector('.wizard-step'),
    hayAviso: !!document.querySelector('[data-testid="aviso-ventana"]'),
    textoAviso: (document.querySelector('[data-testid="aviso-ventana"]')?.innerText || '').trim(),
    pasos: document.querySelectorAll('.wizard-step').length,
    campos: document.querySelectorAll('input, select, textarea').length,
  }))

  /**
   * Irse de la página con un `fetch` a medias lo ABORTA, y la aplicación registra un
   * «network/fetch error» que NO es suyo sino del robot (mismo motivo que
   * `esperarSilencioDeRed`). Este recorrido navega SIETE veces, así que se espera a que
   * no quede nada en vuelo antes de cada salto.
   *
   * ⚠️ No basta con «cero en vuelo AHORA»: `ResumePage` dispara el precalentado
   * (`warmBundle`) con un `setTimeout` de 4 s DESPUÉS de hidratar, así que puede no haber
   * salido todavía cuando se mira. Por eso se exige un tramo de QUIETUD que lo cubra —
   * medido el 2026-08-22: al dejar `0º.tricies.nonies` la casilla lista al primer intento,
   * el recorrido se aceleró, alcanzó el siguiente salto antes de esos 4 s y apareció un
   * «network/fetch error» de `warmBundle` que NO es del producto.
   */
  // La quietud larga solo hace falta ANTES DE NAVEGAR (`drenar(techo, QUIETUD_MS)`); dentro
  // del recorrido no se abandona la página, así que ahí sigue bastando «nada en vuelo».
  const QUIETUD_MS = 4600
  /**
   * ⚠️ SALIDA POR TECHO — medido el 2026-08-27, y es LA CAUSA del rojo intermitente de este
   * recorrido cuyo mensaje llevaba sin capturarse desde el 2026-08-22 (`0º.tricies.sexdecies`
   * lo dejó anotado como «no se llegó a capturar»). El mensaje es
   * `[ENR ERROR] gasCall warmSession: network/fetch error`: bajo carga, el bucle de quietud
   * no junta sus 4,6 s dentro del techo, sale igualmente Y EL LLAMANTE NAVEGA — abortando el
   * precalentado que seguía en vuelo. Por eso el techo ya no devuelve a secas: antes exige al
   * menos «cero en vuelo», con su propio tope corto. Si ni eso se logra, se devuelve igual
   * (colgar el recorrido sería peor que un rojo), pero ese caso ya no es el habitual.
   */
  const cederElTecho = async () => {
    const t1 = Date.now()
    while (enVuelo.n > 0 && Date.now() - t1 < 10000) await page.waitForTimeout(120)
    await page.waitForTimeout(200)
  }
  const drenar = async (techo = 20000, quietud = 300) => {
    const t0 = Date.now()
    for (;;) {
      let desde = null
      for (;;) {
        if (enVuelo.n > 0) desde = null
        else if (desde == null) desde = Date.now()
        else if (Date.now() - desde >= quietud) break
        if (Date.now() - t0 > techo) return await cederElTecho()
        await page.waitForTimeout(120)
      }
      // Margen final Y RECONFIRMACIÓN: con la ventana comprimida (`scenario.ventanaMs`) el
      // asistente puede bloquearse EN MITAD de esta espera, montar la verja y disparar su
      // precalentado justo después de la última mirada. Sin volver a comprobar, el `goto`
      // siguiente lo abortaría — medido el 2026-08-22 con una sonda: se perdía en el pase «c».
      await page.waitForTimeout(300)
      if (enVuelo.n === 0) return
      if (Date.now() - t0 > techo) return await cederElTecho()
    }
  }

  /** Entra: abre la verja, pide el código, lo teclea y espera a que se pinte el asistente. */
  const entrarConElCodigo = async (etiqueta) => {
    await drenar(16000, QUIETUD_MS)
    await page.goto(`${base}/?ventana=${etiqueta}#/resume/${DATOS.resumeToken}?n=${DATOS.emailId}`,
      { waitUntil: 'domcontentloaded', timeout: 30000 })
    const hayVerja = await page.waitForSelector('input[autocomplete="one-time-code"]', { timeout: LATENCY * 3 + 15000 })
      .then(() => true).catch(() => false)
    if (!hayVerja) return false
    // La verja se REMONTA en la entrada (la rehidratación la tapa un instante). Si se teclea
    // antes de que se asiente, se teclea en la instancia que va a desaparecer. Se deja
    // reposar y, si la casilla sigue bloqueada, se pide el código y se reintenta.
    // ⚠️ Desde `0º.tricies.nonies` el auto-envío YA NO se pierde en ese remontaje: la primera
    // entrada deja la casilla lista y el bucle sale al primer intento. El bucle se conserva
    // para las entradas SIGUIENTES de este recorrido, donde la sesión ya no auto-envía
    // (`otpAutoSentForRecovery`) y hay que pulsar el botón como haría la familia.
    await drenar()
    for (let intento = 0; intento < 4; intento++) {
      const lista = await page.$eval('input[autocomplete="one-time-code"]', el => !el.disabled).catch(() => false)
      if (lista) break
      await page.evaluate(() => { const b = document.querySelector('[data-testid="stepup-reenviar"]'); if (b && !b.disabled) b.click() })
      await page.waitForTimeout(900)
      await drenar()
    }
    const casillaLista = await page.$eval('input[autocomplete="one-time-code"]', el => !el.disabled).catch(() => false)
    if (!casillaLista) return false
    await page.fill('input[autocomplete="one-time-code"]', '123456')
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button.btn-primary-kis')].find(x => !x.disabled)
      if (b) b.click()
    })
    const abierto = await page.waitForFunction(
      () => !!document.querySelector('.wizard-step'), null, { timeout: LATENCY * 4 + 20000 })
      .then(() => true).catch(() => false)
    if (abierto) {
      const f = await pantalla()
      c.evidencia.elementos = Math.max(c.evidencia.elementos || 0, f.pasos + f.campos)
    }
    return abierto
  }

  /** Un gesto REAL de persona: el mismo evento que escucha la aplicación. */
  const gesto = () => page.evaluate(() => {
    document.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }))
  })

  /** Llamada al servidor simulado desde fuera del navegador — para el contrato puro. */
  const alServidor = async (action, extra) => {
    const r = await fetch(`${base}/__gas`, {
      method: 'POST', headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ action, _hp: '', resume_token: DATOS.resumeToken,
                             n: DATOS.emailId, pv: huellaVista, ...extra }),
    })
    return await r.json()
  }

  try {
    scenario.piiGated = true
    scenario.ventanaViva = true

    // ══ FASE A · una RECARGA vuelve a pedir el código aunque la marca siga viva ════════
    // Va la PRIMERA a propósito: si la huella de página sobreviviese a la recarga (el fallo
    // que este atado cierra), TODAS las fases siguientes cambiarían de comportamiento y el
    // rojo saldría en el sitio equivocado. Medido rompiéndolo: puesta al final, el fallo se
    // manifestaba como «el asistente no se pintó en el tercer pase», que no nombra el caso.
    scenario.ventanaMs = 600000     // ventana LARGA: si entrase, sería por la marca viva
    if (!c.afirmar('la familia entra con una ventana larga por delante', await entrarConElCodigo('a'),
      'el asistente no se pintó en el primer pase')) return c
    const huellaAntes = huellaVista
    await drenar(16000, QUIETUD_MS)   // recargar también ABORTA lo que esté en vuelo
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 30000 })
    // Mientras el asistente re-hidrata pinta su armazón VACÍO a propósito (el loader de
    // WIZARD-GATE-ORDER), así que mirar en ese instante mediría la pantalla equivocada: se
    // espera a que la hidratación conteste y la pantalla se asiente.
    const pidioCodigo = await page.waitForSelector('input[autocomplete="one-time-code"]',
      { timeout: LATENCY * 4 + 20000 }).then(() => true).catch(() => false)
    await drenar()
    const foto = await pantalla()
    c.afirmar('(4) una recarga vuelve a pedir el código aunque la ventana siga viva',
      pidioCodigo && foto.hayVerja,
      'tras recargar, el asistente NO pidió el código: la huella de página viva no está cerrando la recarga, ' +
      `y con la ventana viva (10 min) se entraría con un F5 (pasos pintados: ${foto.pasos})`)
    c.afirmar('(4.bis) y es porque la página acuñó una huella NUEVA (no sobrevive a la recarga)',
      !!huellaAntes && !!huellaVista && huellaVista !== huellaAntes,
      `la huella de página viva es la misma antes y después de recargar (${String(huellaVista).slice(0, 8)}…): está sobreviviendo a la recarga, así que se estará guardando donde no debe`)

    // ══ FASE B · con actividad continua se sobrepasa la ventana ENTERA sin bloquearse ═══
    scenario.ventanaMs = 6000        // 6 s hacen de los 10 min

    if (!c.afirmar('la familia entra tecleando su código', await entrarConElCodigo('b'),
      'el asistente no llegó a pintarse tras teclear el código: la secuencia que este recorrido mide no llegó a darse')) return c

    const refrescosAntes = refrescos
    const arranque = Date.now()
    // Tres ventanas enteras de reloj (18 s) tocando la pantalla cada segundo y medio.
    while (Date.now() - arranque < 18000) {
      await gesto()
      await page.waitForTimeout(1500)
    }
    const trasActividad = await pantalla()
    c.afirmar('(1) con actividad continua, pasadas TRES ventanas enteras, NO se bloquea',
      trasActividad.hayPasos && !trasActividad.hayVerja,
      trasActividad.hayVerja
        ? 'el asistente volvió a pedir el código estando la familia tocando la pantalla todo el rato: el contador NO se reinicia con la actividad'
        : 'el asistente dejó de pintar los pasos')
    c.afirmar('(1.bis) y ese «sigo aquí» viaja al servidor, no se resuelve en el navegador',
      refrescos - refrescosAntes >= 3,
      `solo salieron ${refrescos - refrescosAntes} peticiones de refresco en 18 s: si la ventana se estirase sola en el cliente, el servidor seguiría rechazando el siguiente guardado`)

    // ══ FASE C · el aviso sale dos minutos antes, y la actividad lo quita ══════════════
    // Ventana de 125 s: al entrar quedan 125 (por encima del umbral de aviso, 120), así que
    // el aviso NO puede estar; a los pocos segundos de quietud se cruza el umbral y sale.
    scenario.ventanaMs = 125000
    if (!c.afirmar('la familia vuelve a entrar para el segundo pase', await entrarConElCodigo('c'),
      'el asistente no se pintó en el segundo pase')) return c

    const reciénEntrado = await pantalla()
    c.afirmar('(3) recién entrado, con la ventana entera por delante, NO hay aviso',
      !reciénEntrado.hayAviso,
      `el aviso de «¿sigues ahí?» está en pantalla con 125 s de ventana por delante: «${reciénEntrado.textoAviso}»`)

    const salioElAviso = await page.waitForFunction(
      () => !!document.querySelector('[data-testid="aviso-ventana"]'), null, { timeout: 20000 })
      .then(() => true).catch(() => false)
    const conAviso = await pantalla()
    c.afirmar('(2.a) sin tocar nada, el aviso sale ANTES de bloquear y dice cuánto queda',
      salioElAviso && /\d:\d\d/.test(conAviso.textoAviso),
      salioElAviso
        ? `el aviso salió pero no dice el tiempo que queda: «${conAviso.textoAviso}»`
        : 'nunca salió el aviso de «¿sigues ahí?»: la familia pasaría de trabajar a estar bloqueada sin previo aviso')
    c.afirmar('(2.a.bis) y sale con el asistente todavía abierto, no después de bloquear',
      conAviso.hayPasos && !conAviso.hayVerja,
      'cuando salió el aviso el asistente ya estaba bloqueado: avisar después no es avisar')

    // Pulsar «sigo aquí» devuelve la ventana entera ⇒ el aviso se retira.
    await page.evaluate(() => {
      const b = document.querySelector('[data-testid="aviso-ventana-sigo"]')
      if (b) b.click()
    })
    const seFue = await page.waitForFunction(
      () => !document.querySelector('[data-testid="aviso-ventana"]'), null, { timeout: 15000 })
      .then(() => true).catch(() => false)
    c.afirmar('(3.bis) al decir «sigo aquí» el contador se reinicia y el aviso desaparece',
      seFue, 'el aviso siguió en pantalla tras pulsar «sigo aquí»: el contador no se reinició')

    // ══ FASE D · sin actividad, se bloquea ════════════════════════════════════════════
    scenario.ventanaMs = 5000
    if (!c.afirmar('la familia vuelve a entrar para el tercer pase', await entrarConElCodigo('d'),
      'el asistente no se pintó en el tercer pase')) return c
    const seBloqueo = await page.waitForFunction(
      () => !!document.querySelector('input[autocomplete="one-time-code"]'), null, { timeout: 25000 })
      .then(() => true).catch(() => false)
    c.afirmar('(2.b) sin actividad, al agotarse la ventana el asistente vuelve a pedir el código',
      seBloqueo,
      'pasada la ventana entera SIN tocar nada, el asistente seguía abierto: la puerta no se cierra sola')

    // ══ FASE E · el CONTRATO del servidor, sin navegador de por medio ═════════════════
    // Se vuelve a entrar para tener una marca viva y una huella conocida.
    scenario.ventanaMs = 8000
    if (!c.afirmar('la familia entra por última vez, para medir el contrato del servidor',
      await entrarConElCodigo('e'), 'el asistente no se pintó en el quinto pase')) return c

    const uno = await alServidor('getAdmissionState')
    await page.waitForTimeout(2000)
    const dos = await alServidor('getAdmissionState')
    c.afirmar('(5) el pulso NO alarga nada: solo REPORTA lo que queda, y sigue bajando',
      Number(dos.step_up_restante_s) > 0 && Number(dos.step_up_restante_s) < Number(uno.step_up_restante_s),
      `dos pulsos separados 2 s reportaron ${uno.step_up_restante_s} s y ${dos.step_up_restante_s} s: si el segundo no es MENOR, el pulso está estirando la ventana solo (eso es SEC-STEPUP #55)`)

    const refresco = await alServidor('refrescarVentana')
    c.afirmar('(5.bis) y quien SÍ la alarga es el «sigo aquí», que la devuelve entera',
      refresco.ok === true && Number(refresco.step_up_restante_s) > Number(dos.step_up_restante_s),
      `el refresco devolvió ${JSON.stringify(refresco).slice(0, 120)}`)

    const otraHuella = await alServidor('refrescarVentana', { pv: 'ffffffff0000ffffffff0000ffffffff' })
    c.afirmar('(7.a) la huella de OTRA página no sirve para alargar la ventana',
      otraHuella.ok === false && /STEPUP_REQUIRED/.test(JSON.stringify(otraHuella)),
      `con una huella de página distinta el servidor contestó ${JSON.stringify(otraHuella).slice(0, 140)}: una recarga podría estirarse a sí misma`)

    const otroBuzon = await alServidor('refrescarVentana', { n: 'email-de-otro-tutor' })
    c.afirmar('(7.b) la marca de un tutor tampoco la alarga OTRO buzón',
      otroBuzon.ok === false && /STEPUP_REQUIRED/.test(JSON.stringify(otroBuzon)),
      `con otro buzón el servidor contestó ${JSON.stringify(otroBuzon).slice(0, 140)}: se estaría transfiriendo la marca de ②24`)

    // Dejar caducar del todo y pedir refresco: NO se resucita.
    await page.waitForTimeout(9000)
    const yaCaducada = await alServidor('refrescarVentana')
    c.afirmar('(6) sobre una ventana YA caducada el refresco NO crea nada: pide código',
      yaCaducada.ok === false && /STEPUP_REQUIRED/.test(JSON.stringify(yaCaducada)),
      `con la ventana caducada el servidor contestó ${JSON.stringify(yaCaducada).slice(0, 140)}: la actividad estaría resucitando una sesión que ya había expirado`)

    // ══ FASE F · EL TECHO: el aviso dice que se cierra POR SEGURIDAD, y NO ofrece quedarse ══
    // Diego, 2026-08-20: *«es importante avisar que se va a cerrar por seguridad»*. La
    // diferencia con el aviso de inactividad no es de redacción: es que el botón «sigo aquí»
    // NO PUEDE funcionar contra el techo (el refresco devuelve 0), así que ofrecerlo sería
    // prometerle a la familia que se queda y echarla dos minutos después.
    scenario.ventanaMs = 20000   // ventana larga…
    scenario.techoMs   = 6000    // …y techo CORTO: el que manda es el techo
    if (!c.afirmar('la familia entra una vez más, ya con el techo cerca',
      await entrarConElCodigo('f'), 'el asistente no se pintó en el sexto pase')) return c

    const conTecho = await alServidor('getAdmissionState')
    c.afirmar('(8) el servidor DICE cuál de los dos límites va a cerrar, resuelto',
      conTecho.step_up_cierre === 'TECHO' && Number(conTecho.step_up_restante_s) <= 6,
      `el pulso contestó cierre=${conTecho.step_up_cierre} restante=${conTecho.step_up_restante_s} s: con la ventana en 20 s y el techo en 6 s, el que manda es el techo y hay que decirlo`)

    const avisoTecho = await page.waitForFunction(
      () => {
        const el = document.querySelector('[data-testid="aviso-ventana"]')
        return el ? { cierre: el.getAttribute('data-cierre'),
                      texto: el.innerText.trim(),
                      haySigo: !!el.querySelector('[data-testid="aviso-ventana-sigo"]') } : null
      }, null, { timeout: 20000 }).then(h => h.jsonValue()).catch(() => null)

    c.afirmar('(9) el aviso del techo se pinta, y se identifica como tal',
      !!avisoTecho && avisoTecho.cierre === 'TECHO',
      `el aviso que salió fue ${JSON.stringify(avisoTecho)}: con el techo cerca no puede salir el de inactividad`)
    // ⚠️ Comprobar solo «¿dice seguridad?» NO distingue: el aviso de INACTIVIDAD también lo
    // dice. Lo que separa a los dos es que el del techo NO pregunta «¿sigues ahí?» —no hay
    // nada que contestar— y sí promete que lo escrito no se pierde. Se exige eso.
    c.afirmar('(10) dice que se cierra POR SEGURIDAD, sin preguntar «¿sigues ahí?» a quien no puede quedarse',
      !!avisoTecho && /seguridad/i.test(avisoTecho.texto) && /c[oó]digo/i.test(avisoTecho.texto)
        && !/sigues ah[ií]|still there/i.test(avisoTecho.texto),
      `el texto era ${JSON.stringify(avisoTecho && avisoTecho.texto)}: si nombra «¿sigues ahí?» es el aviso de inactividad, que ofrece quedarse — contra el techo eso es mentira`)
    c.afirmar('(11) y NO ofrece «sigo aquí», porque contra el techo ese botón no puede funcionar',
      !!avisoTecho && avisoTecho.haySigo === false,
      'el aviso del techo traía el botón de quedarse: es una promesa que el servidor va a rechazar')

    // ══ FASE G · 0º.tricies.quater — el botón ACUSA RECIBO, y si deja de servir el
    // asistente SE BLOQUEA ═══════════════════════════════════════════════════════════
    // Diego, 2026-08-22: *«Si le doy al botón de "sigo aquí" no hace nada. El contador
    // sigue marcha atrás, no desaparece el mensaje... al llegar a cero se ha cerrado el
    // mensaje pero no se ha bloqueado el wizard.»* Medido: el clic SÍ viaja y SÍ extiende,
    // pero según el techo se acerca lo hace por un margen que a simple vista es
    // imperceptible — y hasta que esa respuesta no vuelve, el botón se sigue ofreciendo
    // como si fuera a servir de algo. A diferencia de la FASE F (que entra YA con el
    // techo alcanzado), aquí NACE en INACTIVIDAD y el techo se alcanza a base de clics,
    // que es la secuencia real que describió Diego.
    const leerAvisoG = () => page.evaluate(() => {
      const el = document.querySelector('[data-testid="aviso-ventana"]')
      if (!el) return null
      const boton = el.querySelector('[data-testid="aviso-ventana-sigo"]')
      return { cierre: el.getAttribute('data-cierre'), disabled: boton ? boton.disabled : null }
    })

    scenario.ventanaMs = 8000    // ventana corta…
    scenario.techoMs   = 13000   // …y techo un poco más lejos: NACE en INACTIVIDAD
    if (!c.afirmar('la familia entra por séptima vez, con el techo cerca pero SIN alcanzar',
      await entrarConElCodigo('g'), 'el asistente no se pintó en el séptimo pase')) return c

    const nacioAviso = await page.waitForFunction(
      () => !!document.querySelector('[data-testid="aviso-ventana"]'), null, { timeout: 15000 })
      .then(() => true).catch(() => false)
    const alNacer = nacioAviso ? await leerAvisoG() : null
    c.afirmar('(12) nace en modo INACTIVIDAD — el techo todavía no obliga',
      !!alNacer && alNacer.cierre === 'INACTIVIDAD',
      `el aviso nació como ${JSON.stringify(alNacer)}: si ya nace en TECHO esta fase no prueba la secuencia gradual que describió Diego`)

    // Un clic, y el botón tiene que acusar recibo AL INSTANTE — antes incluso de que
    // vuelva la respuesta del servidor: se deshabilita mientras está en vuelo.
    await page.evaluate(() => {
      const b = document.querySelector('[data-testid="aviso-ventana-sigo"]')
      if (b) b.click()
    })
    const seDeshabilito = await page.waitForFunction(
      () => {
        const b = document.querySelector('[data-testid="aviso-ventana-sigo"]')
        return !!(b && b.disabled)
      }, null, { timeout: 3000 }).then(() => true).catch(() => false)
    c.afirmar('(13) al pulsar «sigo aquí» el botón se deshabilita EN EL ACTO: el clic se acusa, no se queda mudo',
      seDeshabilito,
      'el botón nunca se marcó "en vuelo" tras el clic: no hay forma de saber, mirando la pantalla, si el clic surtió algún efecto')

    // Clics repetidos, como los de Diego, hasta que el techo gane: o el aviso pasa a modo
    // TECHO (deja de ofrecer el botón) o el asistente termina bloqueado — nunca "sigue
    // igual, para siempre", que es exactamente lo que él describió.
    let cambioG = null
    const arranqueG = Date.now()
    while (Date.now() - arranqueG < 20000 && !cambioG) {
      await page.evaluate(() => {
        const b = document.querySelector('[data-testid="aviso-ventana-sigo"]')
        if (b && !b.disabled) b.click()
      })
      await page.waitForTimeout(900)
      if (await page.$('input[autocomplete="one-time-code"]')) { cambioG = 'BLOQUEADO'; break }
      const est = await leerAvisoG()
      if (est && est.cierre === 'TECHO') { cambioG = 'TECHO'; break }
    }
    c.afirmar('(14) tras clics sucesivos el techo SE NOTA: pasa a modo TECHO o el asistente se bloquea — nunca sigue exactamente igual',
      cambioG === 'TECHO' || cambioG === 'BLOQUEADO',
      `tras 20 s de clics sucesivos no cambió nada observable (cambio=${cambioG}): es exactamente "el botón no hace nada" que reportó Diego`)

    // Y si terminó en modo TECHO (sin llegar aún a bloquear), agotar el resto SIN tocar
    // nada más tiene que bloquear el asistente igualmente — la mitad (B) del defecto.
    if (cambioG === 'TECHO') {
      const seBloqueoTrasTecho = await page.waitForFunction(
        () => !!document.querySelector('input[autocomplete="one-time-code"]'), null, { timeout: 15000 })
        .then(() => true).catch(() => false)
      c.afirmar('(15) y, agotado el techo sin más clics, el asistente SÍ se bloquea',
        seBloqueoTrasTecho,
        'llegó a modo TECHO y el contador a cero, pero el asistente se quedó abierto: la pantalla prometía un bloqueo que no ejecutaba')
    }

    // El camino termina con el asistente BLOQUEADO, o sea con la verja recién montada y su
    // precalentado (`warmSession`) en vuelo. Cerrar el contexto ahí lo ABORTA y la aplicación
    // registra un «network/fetch error» que NO es suyo sino del robot. Se espera al silencio.
    await drenar(16000, QUIETUD_MS)
    return c
  } finally {
    limpiar()
  }
}

/**
 * `0º.tricies.vicies.quater` — ABRIR EL ASISTENTE CUESTA UN VIAJE, NO OCHO.
 *
 * ── Lo que pasó de verdad (Diego, 2026-08-26) ─────────────────────────────────────────
 * *«Es imposible presentar estos tiempos de carga a un cliente de mi escuela sin recibir
 * numerosas quejas. Esto es inviable.»* Abandonó sin que la pantalla terminara de cargar.
 * Medido en su registro: el tiempo **no se va en trabajar, se va en VIAJAR** — la puerta del
 * expediente hace **4,8 s** de trabajo dentro del KMS y tarda **66 s** en volver; las listas,
 * **15 s / 73 s**; el pulso, **0,8 s / 45 s**. Y abrir el asistente disparaba **OCHO**
 * llamadas casi simultáneas, que se encolan unas detrás de otras.
 *
 * ── Qué mide este camino, y por qué SE PUEDE medir aquí ───────────────────────────────
 * Mide **el número de viajes**, que es una decisión del NAVEGADOR: quién dispara qué, y
 * cuándo. Eso es exactamente lo que la batería sí puede afirmar. Lo que NO mide —y se dice—
 * son los SEGUNDOS: el servidor simulado responde en milisegundos y nunca ejecuta
 * `backend/Code.js` ni el KMS.
 *
 * ⛔ **Va con la VERJA PUESTA (`piiGated`), y no es un detalle**: con la gracia del enlace
 * viva el servidor devuelve la solicitud entera —catálogos incluidos— y el asistente no
 * necesita pedir nada más, así que el tropel **no se produce** y este camino pasaría EN
 * VACÍO. El caso de Diego es el otro: enlace sin gracia ⇒ primera respuesta cerrada
 * (`pii_gated:true`, `lookups:{}`, `questions:null`) y **de ahí salían los siete viajes de
 * más**.
 *
 * ⚠️ Y el simulado NO reproducía esa respuesta cerrada: servía los catálogos igualmente. Era
 * una divergencia SUYA respecto del contrato real (`backend/Code.js`, rama `if (!stepUpFresh)`
 * de `hydrateSession_`), y era la razón por la que la batería no podía ver el defecto.
 * Corregida en el mismo cambio.
 */
async function caminoUnViajeAlAbrir(page, base) {
  const c = new Camino('un-viaje-al-abrir')
  scenario.stage = 'hasta_preguntas'

  if (REAL) {
    // Contra el sistema de verdad la verja solo se abre dejando caducar la gracia del enlace,
    // y forzar esa caducidad exige un buzón que este arnés no lee. No se afloja para que pase.
    c.noCubierta('un-viaje-al-abrir', 'ver NO_CUBIERTAS_SOLO_REAL')
    return c
  }

  // El contador va sobre las peticiones REALES del navegador, no sobre lo que el arnés
  // apunta: lo que se afirma es cuántas veces se sale a la red, y eso solo lo sabe la red.
  const peticiones = []
  const enVuelo = { n: 0 }
  // Se apunta CUÁNDO sale cada una y CUÁNDO vuelve la hidratación: eso es lo que permite
  // afirmar que la llamada que PINTA no compite con nadie, que es la propiedad de fondo
  // (el tropel no dolía por ser ocho, dolía porque las ocho se encolaban a la vez).
  const salidas = []
  let hidratacionVuelveEn = null
  const t0Camino = Date.now()
  const alPedir = (req) => {
    if (!/\/__gas/.test(req.url())) return
    enVuelo.n++
    try {
      const a = JSON.parse(req.postData() || '{}').action
      if (a) { peticiones.push(a); salidas.push({ a, t: Date.now() - t0Camino }) }
    } catch { /* cuerpo raro */ }
  }
  const alVolver = (req) => {
    if (!/\/__gas/.test(req.url())) return
    enVuelo.n--
    try {
      const a = JSON.parse(req.postData() || '{}').action
      if (a === 'hydrateSession' && hidratacionVuelveEn === null) hidratacionVuelveEn = Date.now() - t0Camino
    } catch { /* cuerpo raro */ }
  }
  page.on('request', alPedir)
  page.on('requestfinished', alVolver)
  page.on('requestfailed', alVolver)
  const limpiar = () => {
    page.off('request', alPedir)
    page.off('requestfinished', alVolver)
    page.off('requestfailed', alVolver)
  }

  /** Espera a que no quede NADA en vuelo: irse con un `fetch` a medias lo aborta y la
   *  aplicación registra un «network/fetch error» que es del ROBOT, no suyo. */
  const drenar = async (techo = 16000, quietud = 400) => {
    const t0 = Date.now()
    let ultimo = Date.now()
    let visto = peticiones.length
    while (Date.now() - t0 < techo) {
      if (peticiones.length !== visto) { visto = peticiones.length; ultimo = Date.now() }
      if (enVuelo.n === 0 && Date.now() - ultimo > quietud) return
      await page.waitForTimeout(120)
    }
  }

  try {
    scenario.piiGated = true
    scenario.otpSuperado = false

    await page.goto(`${base}/#/resume/${DATOS.resumeToken}?n=${DATOS.emailId}`,
      { waitUntil: 'domcontentloaded', timeout: 30000 })

    // El desenlace observable con la verja puesta es la CASILLA DEL CÓDIGO. Se espera a ella
    // —no a un reloj— para que el recuento se tome sobre la pantalla que la familia ve.
    const pidioCodigo = await page.waitForSelector('input[autocomplete="one-time-code"]',
      { timeout: LATENCY * 4 + 20000 }).then(() => true).catch(() => false)

    // ⛔ ANCLA. Sin ella, «se hicieron pocos viajes» saldría VERDE sobre una pantalla que no
    // llegó a montarse — que es la forma más cara de verde falso.
    if (!c.afirmar('(0) con la verja puesta, el asistente pide el código',
      pidioCodigo,
      'nunca apareció la casilla del código: la secuencia que este recorrido mide no llegó a darse')) return c

    // El precalentado de la entrada sale RETRASADO a propósito (4 s), así que un recuento
    // tomado antes se dejaría fuera justo una de las llamadas que hay que contar. Se espera a
    // que la red calle de verdad, con quietud larga.
    await page.waitForTimeout(5200)
    await drenar(16000, 1200)

    c.evidencia.elementos = Math.max(1, peticiones.length)

    const cuantas = (a) => peticiones.filter(x => x === a).length
    const total = peticiones.length

    // ── (1) EL RECUENTO. Es la afirmación de la ficha, dicha en su propio término. ────────
    // El listón son CUATRO, y las cuatro tienen su motivo escrito — ninguna es un viaje de
    // datos duplicado:
    //   1. `hydrateSession`      — LA ÚNICA QUE PINTA: trae la cabecera del expediente.
    //   2. `sendVerificationCode`— el código que la familia necesita para entrar.
    //   3. `warmSession`         — cocina la solicitud mientras ella teclea (fuego y olvido).
    //   4. `warmBundle`          — a los 4 s, y lo único que hace de verdad en este camino es
    //                              arrancar el precalentado de la simulación del paso 7: su
    //                              otra mitad choca con el freno de `warmSession_` (120 s por
    //                              token Y por expediente) y vuelve `RATE_LIMITED`.
    //
    // ⚠️ NO SE BAJA A TRES fundiendo 3 y 4, y el motivo está MEDIDO: cada una es la única
    // que calienta en SU camino — `warmSession` en la RECARGA (donde `ResumePage` no llega a
    // montarse) y `warmBundle` en la ENTRADA POR EL ENLACE (donde además arranca la fase de
    // la simulación). Fundirlas es tocar `backend/Code.js` y arriesga DUPLICAR el arranque
    // de esa fase en el camino del ticket, que ya la mintea por su cuenta. Queda dicho, no
    // hecho.
    //
    // El techo es lo que impide que el tropel vuelva sin que nadie se entere.
    c.afirmar('(1) abrir el asistente cuesta CUATRO viajes como mucho, no ocho',
      total <= 4,
      `salieron ${total} peticiones al abrir: [${peticiones.join(', ')}] — el tropel de la entrada ha vuelto`)

    // ── (1.bis) Y LA PROPIEDAD DE FONDO: la que PINTA no compite con nadie. ───────────────
    // El tropel no dolía por ser ocho, dolía porque las ocho salían casi a la vez y se
    // encolaban: con ~60 s de viaje cada una (medido en el registro real de Diego), la
    // hidratación acababa esperando detrás de precalentados y catálogos. Aquí se afirma lo
    // único que de verdad le importa a la familia: **mientras la solicitud viene de camino,
    // no sale ninguna otra petición**. Las tres restantes arrancan DESPUÉS, cuando la
    // pantalla ya está.
    const antesDeVolverLaHidratacion = hidratacionVuelveEn === null
      ? salidas.filter(x => x.a !== 'hydrateSession')
      : salidas.filter(x => x.a !== 'hydrateSession' && x.t < hidratacionVuelveEn)
    c.afirmar('(1.bis) la llamada que PINTA no compite con ninguna otra',
      antesDeVolverLaHidratacion.length === 0,
      `mientras la solicitud venía de camino salieron ${antesDeVolverLaHidratacion.length} petición(es) más: ` +
      `[${antesDeVolverLaHidratacion.map(x => `${x.a}@${x.t}ms`).join(', ')}] — se encolan por delante de la pantalla`)

    // ── (2) LA HIDRATACIÓN, UNA VEZ. La segunda era un viaje entero regalado: con la verja
    //       puesta devuelve EL MISMO esqueleto vacío que el cliente ya tiene. ──────────────
    c.afirmar('(2) la solicitud se pide UNA sola vez, no dos',
      cuantas('hydrateSession') === 1,
      `hydrateSession salió ${cuantas('hydrateSession')} veces: la rehidratación de WizardPage vuelve a pagar el viaje para recibir el MISMO esqueleto cerrado`)

    // ── (3) LOS CATÁLOGOS. Detrás de la verja la familia no ve ni vínculos ni preguntas:
    //       pedirlos ahí es pagar dos viajes por lo que no se puede enseñar. ───────────────
    c.afirmar('(3) los catálogos NO se piden mientras la verja está cerrada',
      cuantas('fetchLookups') === 0 && cuantas('fetchQuestions') === 0,
      `fetchLookups salió ${cuantas('fetchLookups')} vez/veces y fetchQuestions ${cuantas('fetchQuestions')}: se están pagando los catálogos de unos pasos que la familia todavía no puede ver`)

    // ── (4) EL PULSO. No tiene nada que vigilar mientras no haya pantalla que refrescar. ──
    c.afirmar('(4) el pulso no late mientras la verja está cerrada',
      cuantas('getLiveStateVersion') === 0 && cuantas('getAdmissionState') === 0,
      `el pulso salió ${cuantas('getLiveStateVersion') + cuantas('getAdmissionState')} vez/veces con la verja cerrada`)

    // ── (5) LO QUE NO SE TOCA: el código SIGUE saliendo solo. Quitar viajes no puede
    //       convertirse en dejar a la familia esperando a pulsar un botón. ────────────────
    c.afirmar('(5) y el código de un solo uso SIGUE saliendo solo al abrir',
      cuantas('sendVerificationCode') === 1,
      `sendVerificationCode salió ${cuantas('sendVerificationCode')} vez/veces: si no sale sola, la familia se queda esperando un código que nadie ha pedido`)

    c.notas.push(`✓ viajes al abrir con la verja puesta: ${total} — `
      + `[${salidas.map(x => `${x.a}@${x.t}ms`).join(', ')}]`
      + ` · la solicitud volvió a los ${hidratacionVuelveEn}ms`)

    // ── (6) Y TRAS TECLEAR EL CÓDIGO, LA SOLICITUD LLEGA ENTERA. Es la otra mitad: quitar
    //       viajes de la entrada no puede dejar a la familia sin sus catálogos después. ───
    const antesDelCodigo = peticiones.length
    scenario.otpSuperado = true
    // Mismos gestos que `entrarConElCodigo` del recorrido de la ventana — no se inventa
    // navegación nueva: se teclea el código y se pulsa el botón primario de la verja.
    await page.fill('input[autocomplete="one-time-code"]', '123456')
    await page.evaluate(() => {
      const b = [...document.querySelectorAll('button.btn-primary-kis')].find(x => !x.disabled)
      if (b) b.click()
    })
    const abierto = await page.waitForFunction(
      () => !!document.querySelector('.wizard-step'), null, { timeout: LATENCY * 4 + 20000 })
      .then(() => true).catch(() => false)
    await drenar()

    c.afirmar('(6) con el código tecleado, el asistente SÍ abre la solicitud',
      abierto,
      `tras teclear el código el asistente no pintó los pasos (peticiones desde entonces: [${peticiones.slice(antesDelCodigo).join(', ')}])`)

    const trasCodigo = peticiones.slice(antesDelCodigo)
    const pasos = await page.evaluate(() => document.querySelectorAll('.wizard-step').length)
    c.evidencia.elementos = Math.max(c.evidencia.elementos, pasos)
    c.afirmar('(7) y los catálogos llegan CON esa hidratación, sin pedirlos aparte',
      trasCodigo.filter(x => x === 'fetchLookups').length === 0 &&
      trasCodigo.filter(x => x === 'fetchQuestions').length === 0,
      `tras abrir la verja se pidieron los catálogos aparte: [${trasCodigo.join(', ')}] — la hidratación ya los trae, así que eso son dos viajes de más`)

    await drenar(16000, 1200)
    return c
  } finally {
    scenario.piiGated = false
    scenario.otpSuperado = false
    limpiar()
  }
}

/**
 * `0º.tricies.octies` (D) — EL AVISO ROJO DEL PASO 3 MANDA A MIRAR DONDE ES.
 *
 * Lo que pasó de verdad (Diego, 2026-08-22): con los DOS tutores ya puestos y el par de
 * hermanos sin tipo, la pantalla decía «Selecciona el tipo de relación para todos los
 * TUTORES» y no dejaba avanzar. Se quedó atascado mirando los tutores, que estaban bien.
 * La condición miraba TODOS los vínculos y el mensaje solo nombraba uno de los dos casos.
 *
 * Se mide donde la familia lo ve: se rellenan todos los vínculos tutor→hijo y se deja el
 * de hermano↔hermano vacío. A partir de ahí, el aviso NO puede hablar de tutores.
 */
async function caminoAvisoDeVinculoSeñalaDondeEs(page, base) {
  const c = new Camino('aviso-de-vinculo-señala-donde-es')
  scenario.stage = 'hasta_preguntas'

  if (!await entrarPorElEnlace(c, page, base)) return c

  // Retroceder hasta Vínculos (índice 2), como la familia. Mismo botón y mismo bucle que
  // `caminoQuitarDeLaSolicitud` — no se inventa navegación nueva.
  for (let i = 0; i < 8 && (await dondeEstoy(page)) > 2; i++) {
    const atras = await page.$('button.btn-secondary-kis:not(:has(i.bi-pencil))')
    if (!atras) break
    await atras.click()
    await page.waitForTimeout(250)
  }
  if (!c.afirmar('se llega al paso de Vínculos', (await dondeEstoy(page)) === 2,
    `se quedó en el índice ${await dondeEstoy(page)}`)) return c
  await desbloquear(page)
  await page.waitForTimeout(250)

  const pantalla = await page.evaluate(sondaPantalla)
  c.evidencia.elementos = pantalla.pasos + pantalla.campos

  // Los desplegables salen en orden: primero los tutor→hijo, y los de hermano↔hermano
  // DESPUÉS (así los pinta `Step3Relations`, en dos bloques). El último es el del par.
  const selects = await page.$$('.kis-card select.form-select-sm')
  if (!c.afirmar('el paso pinta el par de hermanos y los vínculos de los tutores', selects.length >= 2,
    `se pintaron ${selects.length} desplegable(s): con dos alumnos tiene que haber al menos ` +
    'uno de tutor→hijo y el del par de hermanos, o este caso no se está midiendo')) return c

  /** Elige la PRIMERA opción real (la vacía es la de «sin tipo»). */
  const elegirTipoEn = async (sel) => {
    const valores = await sel.$$eval('option', (os) => os.map(o => o.value).filter(Boolean))
    if (!valores.length) return false
    await sel.selectOption(valores[0])
    await page.waitForTimeout(120)
    return true
  }

  // Todos los tutor→hijo rellenos; el par de hermanos (el último) se deja VACÍO a propósito.
  for (let i = 0; i < selects.length - 1; i++) {
    if (!c.afirmar(`el vínculo tutor→hijo ${i + 1} admite tipo`, await elegirTipoEn(selects[i]),
      'el desplegable no ofrecía ni una opción del catálogo')) return c
  }
  const avisos = async () => (await page.$$eval('.field-error', (ns) => ns.map(n => n.textContent || '')))
    .join(' · ')

  const conSoloElParVacio = await avisos()
  // (1) LA AFIRMACIÓN CENTRAL: con los tutores rellenos, el aviso NO puede hablar de tutores.
  c.afirmar('con los tutores ya puestos, el aviso no manda a mirar a los tutores',
    !/tutores|guardians/i.test(conSoloElParVacio),
    `el aviso leído fue "${conSoloElParVacio}": manda a mirar donde ya está resuelto`)
  // (2) y SÍ nombra el caso real, el de entre alumnos.
  c.afirmar('el aviso nombra el vínculo entre los alumnos',
    /alumnos|students/i.test(conSoloElParVacio),
    `el aviso leído fue "${conSoloElParVacio}": no dice cuál es el vínculo que falta`)

  // (3) y al rellenar el par, el aviso desaparece — la familia puede seguir.
  await elegirTipoEn(selects[selects.length - 1])
  const trasRellenarElPar = await avisos()
  c.afirmar('al declarar el vínculo entre los alumnos el aviso desaparece',
    !/relaci[oó]n|relationship/i.test(trasRellenarElPar),
    `el aviso seguía en pantalla: "${trasRellenarElPar}"`)

  return c
}

/**
 * Lleva al paso de Vínculos (índice 2) desde donde sea que haya aterrizado, y lo
 * desbloquea. Mismo bucle y mismo botón que `caminoAvisoDeVinculoSeñalaDondeEs` — no se
 * inventa navegación nueva.
 */
async function irAVinculos(c, page) {
  for (let i = 0; i < 8 && (await dondeEstoy(page)) > 2; i++) {
    const atras = await page.$('button.btn-secondary-kis:not(:has(i.bi-pencil))')
    if (!atras) break
    await atras.click()
    await page.waitForTimeout(250)
  }
  if (!c.afirmar('se llega al paso de Vínculos', (await dondeEstoy(page)) === 2,
    `se quedó en el índice ${await dondeEstoy(page)}`)) return false
  await desbloquear(page)
  await page.waitForTimeout(250)
  return true
}

/**
 * `0º.septvicies` — UNA DECLARACIÓN, UNA FILA (DL-S45, Diego 2026-08-21).
 *
 * Hasta el 2026-08-22 el paso 3 empujaba, por cada par de hermanos NUEVO, **la fila
 * invertida además de la suya** — el modelo de grafo bidireccional que Diego derogó. El KMS
 * ya se había convertido (`enr_upsertRelation_` escribe UNA fila, con identidad
 * `(grupo, a, b)`), así que la invertida caía en otra clave y nacía como fila NUEVA: cada
 * vínculo entre hermanos declarado desde esta pantalla nacía DUPLICADO.
 *
 * Se mide lo observable, y en este orden a propósito:
 *   FASE A — el LECTOR: un vínculo guardado en el sentido CONTRARIO (una sola fila, como lo
 *     escribe el KMS) se ve igual en la tarjeta del par. Es la mitad que sostenía el empujón
 *     («so both children can query their siblings») y la que, si falla, hace DESAPARECER de
 *     la pantalla un vínculo que la familia ya declaró. Va primero porque es la de más daño.
 *   FASE B — el ESCRITOR: declarar el par manda UNA sola fila al servidor, no dos.
 */
async function caminoVinculoHermanosUnaSolaFila(page, base) {
  const c = new Camino('vinculo-hermanos-una-sola-fila')
  const esAlumno = (id) => id === FIXTURE.applicantId || id === FIXTURE.applicant2Id

  try {
    // ── FASE A · el vínculo guardado AL REVÉS se sigue viendo ───────────────────────
    scenario.stage = 'hasta_preguntas'
    scenario.vinculoHermanosInvertido = true

    if (!await entrarPorElEnlace(c, page, base)) return c
    const pantalla = await page.evaluate(sondaPantalla)
    c.evidencia.elementos = pantalla.pasos + pantalla.campos
    if (!await irAVinculos(c, page)) return c

    // ANCLA: sin el par de hermanos en pantalla, todo lo de abajo pasaría en vacío.
    const selectsA = await page.$$('.kis-card select.form-select-sm')
    if (!c.afirmar('(1) el paso pinta el par de hermanos y los vínculos de los tutores',
      selectsA.length >= 2,
      `se pintaron ${selectsA.length} desplegable(s): con dos alumnos tiene que haber al menos ` +
      'uno de tutor→hijo y el del par de hermanos, o este caso no se está midiendo')) return c

    // UNA sola tarjeta por pareja de hermanos: si el lector no plegara los dos sentidos,
    // o si el asistente volviera a mandar la invertida, aquí saldrían DOS.
    const tarjetasDeHermanos = await page.$$eval('.kis-card', (cards) =>
      cards.filter(el => {
        const t = (el.textContent || '')
        return /RobotHijoE2E/.test(t) && /RobotHijoDosE2E/.test(t)
      }).length)
    c.afirmar('(2) el par de hermanos se pinta en UNA sola tarjeta',
      tarjetasDeHermanos === 1,
      `se pintaron ${tarjetasDeHermanos} tarjeta(s) para la misma pareja de hermanos: ` +
      'la pantalla estaría enseñando el mismo vínculo dos veces')

    // LA AFIRMACIÓN CENTRAL DE LA FASE: el tipo declarado se ve, aunque la fila esté
    // guardada como (hijo2 → hijo1) y la tarjeta se pinte como (hijo1 … hijo2).
    const valorDelPar = await selectsA[selectsA.length - 1].inputValue()
    c.afirmar('(3) el vínculo entre hermanos guardado en el sentido CONTRARIO se ve igual',
      valorDelPar === 'rt_child',
      `el desplegable del par de hermanos vale "${valorDelPar}" (se esperaba "rt_child"): ` +
      'el lector solo casa un extremo, así que con UNA sola fila el vínculo que la familia ' +
      'ya declaró desaparece de la pantalla del otro hermano')

    // ── FASE B · declarar el par manda UNA sola fila ────────────────────────────────
    scenario.vinculoHermanosInvertido = false
    if (!await entrarPorElEnlace(c, page, base)) return c
    if (!await irAVinculos(c, page)) return c

    const selectsB = await page.$$('.kis-card select.form-select-sm')
    if (!c.afirmar('(4) el paso vuelve a ofrecer el par de hermanos sin tipo',
      selectsB.length >= 2 && !(await selectsB[selectsB.length - 1].inputValue()),
      `se pintaron ${selectsB.length} desplegable(s) y el último vale ` +
      `"${selectsB.length ? await selectsB[selectsB.length - 1].inputValue() : ''}": ` +
      'sin un par VACÍO que declarar, la fase no mide el alta de un vínculo nuevo')) return c

    // Se declaran TODOS los tipos y se marca la custodia de cada alumno: sin eso el paso
    // no deja continuar (`validationOk`) y no habría guardado que inspeccionar.
    for (const sel of selectsB) {
      const valores = await sel.$$eval('option', (os) => os.map(o => o.value).filter(Boolean))
      if (valores.length) { await sel.selectOption(valores[0]); await page.waitForTimeout(120) }
    }
    const casillas = await page.$$('input.form-check-input[id^="custodial_"]')
    for (const ch of casillas) { if (!(await ch.isChecked())) await ch.check() }
    await page.waitForTimeout(200)

    const antes = calls.length
    if (!await continuar(c, page, 3, 'paso 3 → 4 tras declarar los vínculos')) return c

    const t0 = Date.now()
    const guardadosDeVinculos = () => llamadas('saveStep')
      .filter(g => (g.payload || {}).step === 'relations')
    while (!guardadosDeVinculos().length && Date.now() - t0 < LATENCY + 3000) {
      await page.waitForTimeout(200)
    }
    c.evidencia.llamadas = calls.length - antes
    const guardados = guardadosDeVinculos()
    if (!c.afirmar('(5) los vínculos declarados se guardan', guardados.length > 0,
      `ningún saveStep con step="relations" salió en ${Date.now() - t0} ms tras continuar`)) return c

    const filas = (guardados[guardados.length - 1].payload || {}).payload || []
    const entreHermanos = filas.filter(r =>
      esAlumno(r.person_id_a || r.from_person_id) && esAlumno(r.person_id_b || r.to_person_id))
    c.afirmar('(6) declarar el vínculo entre hermanos manda UNA sola fila al servidor',
      entreHermanos.length === 1,
      `se mandaron ${entreHermanos.length} fila(s) para la MISMA pareja de hermanos ` +
      `(${JSON.stringify(entreHermanos.map(r => [r.person_id_a, r.person_id_b]))}): el asistente ` +
      'está volviendo a escribir la inversa que DL-S45 derogó, y el KMS la guarda como fila NUEVA')
    c.afirmar('(7) y ninguna de las filas mandadas repite una pareja ya mandada',
      new Set(filas.map(r => [r.person_id_a || r.from_person_id, r.person_id_b || r.to_person_id]
        .sort().join('|'))).size === filas.length,
      `se mandaron ${filas.length} fila(s) para ` +
      `${new Set(filas.map(r => [r.person_id_a, r.person_id_b].sort().join('|'))).size} pareja(s) distintas`)

    return c
  } finally {
    scenario.vinculoHermanosInvertido = false
  }
}

/**
 * `0º.duodetricies` — EDITAR UN VÍNCULO YA GUARDADO LLEGA AL SERVIDOR CON SUS DOS EXTREMOS.
 *
 * El ÚNICO escritor descarta EN SILENCIO todo vínculo que no traiga `person_id_a` y
 * `person_id_b` (`enr_persistRelations_`, `kis-app kms-server/enr/wizard-gateway.gs`), y la
 * hidratación del KMS **no manda esos dos nombres**: proyecta `guardian_person_id` /
 * `applicant_person_id` encima de `from_person_id` / `to_person_id`. Resultado medido el
 * 2026-08-22: la familia corregía «madre» por «tutora legal» o marcaba la custodia de un
 * vínculo YA GUARDADO, la pantalla no protestaba, y **el cambio no se escribía nunca**.
 *
 * ⚠️ Esto NO es lo mismo que D97 (el `pair_id` obligatorio), que RECHAZA la escritura entera
 * y SÍ se ve en pantalla. Éste falla hacia el SILENCIO, que es peor: no hay aviso que mirar.
 *
 * Se mide lo observable desde el navegador: qué filas salen en el `saveStep` del paso 3
 * después de tocar un vínculo que vino de la hidratación. Lo que el KMS haga con ellas la
 * batería no lo ve —corre contra el backend simulado—, y por eso la afirmación se queda
 * exactamente en el contrato del escritor: los dos identificadores, y en su orden.
 */
async function caminoEditarVinculoGuardado(page, base) {
  const c = new Camino('editar-vinculo-guardado')

  try {
  // Etapa con vínculos YA guardados en el expediente. Se usa la familia de UN SOLO tutor a
  // propósito: es el único molde del simulado cuya hidratación trae los vínculos de TODOS
  // los hijos, con su tipo y su custodia ya puestos. Con dos tutores, el recorte de
  // DL-E49 §2 esconde el vínculo del otro y el segundo hijo se queda sin custodia ⇒ el paso
  // no deja continuar y el camino moriría ANTES de la afirmación, sin medir nada.
  scenario.stage = 'hasta_preguntas'
  scenario.tutorUnico = true

  if (!await entrarPorElEnlace(c, page, base)) return c
  const pantalla = await page.evaluate(sondaPantalla)
  c.evidencia.elementos = pantalla.pasos + pantalla.campos
  if (!await irAVinculos(c, page)) return c

  // ANCLA: sin un vínculo YA guardado y con su tipo puesto, todo lo de abajo mediría el
  // alta de uno nuevo — que es justo el caso que SÍ funcionaba.
  const selects = await page.$$('.kis-card select.form-select-sm')
  const tipoPrevio = selects.length ? await selects[0].inputValue() : ''
  if (!c.afirmar('(1) el paso trae un vínculo YA guardado, con su tipo declarado',
    selects.length >= 1 && !!tipoPrevio,
    `se pintaron ${selects.length} desplegable(s) y el primero vale "${tipoPrevio}": ` +
    'sin un vínculo que venga de la hidratación, este caso no se está midiendo')) return c

  // Se cambia el tipo a OTRO distinto del que vino guardado: es la edición que hoy se pierde.
  const opciones = await selects[0].$$eval('option', (os) => os.map(o => o.value).filter(Boolean))
  const tipoNuevo = opciones.find(v => v !== tipoPrevio)
  if (!c.afirmar('(2) el catálogo ofrece otro tipo al que cambiar',
    !!tipoNuevo,
    `las opciones eran ${JSON.stringify(opciones)} y el valor guardado "${tipoPrevio}": ` +
    'con una sola opción no hay edición que medir')) return c
  await selects[0].selectOption(tipoNuevo)
  await page.waitForTimeout(200)

  const antes = calls.length
  if (!await continuar(c, page, 3, 'paso 3 → 4 tras cambiar el tipo de un vínculo guardado')) return c

  const t0 = Date.now()
  const guardadosDeVinculos = () => llamadas('saveStep')
    .filter(g => (g.payload || {}).step === 'relations')
  while (!guardadosDeVinculos().length && Date.now() - t0 < LATENCY + 3000) {
    await page.waitForTimeout(200)
  }
  c.evidencia.llamadas = calls.length - antes
  const guardados = guardadosDeVinculos()
  if (!c.afirmar('(3) tocar un vínculo guardado dispara su guardado', guardados.length > 0,
    `ningún saveStep con step="relations" salió en ${Date.now() - t0} ms tras continuar: ` +
    'la edición no llega ni a salir del navegador')) return c

  const filas = (guardados[guardados.length - 1].payload || {}).payload || []
  const editada = filas.find(r => (r.relation_type_id || '') === tipoNuevo)

  // LA AFIRMACIÓN CENTRAL: sin los dos extremos, el escritor la tira sin decir nada.
  c.afirmar('(4) la fila editada viaja con `person_id_a` y `person_id_b`',
    !!(editada && editada.person_id_a && editada.person_id_b),
    `la fila del vínculo editado salió como ${JSON.stringify(editada || null)}: ` +
    'sin los DOS identificadores, `enr_persistRelations_` la descarta EN SILENCIO y la ' +
    'corrección de la familia no se guarda nunca')

  // El ORDEN es parte del dato: el escritor identifica la fila por la terna
  // `(expediente, a, b)`, así que invertirla no actualiza — crea una fila NUEVA.
  c.afirmar('(5) y los extremos conservan el orden con el que están guardados',
    !!(editada && (!editada.from_person_id || editada.person_id_a === editada.from_person_id) &&
                  (!editada.to_person_id   || editada.person_id_b === editada.to_person_id)),
    `la fila salió con a=${editada && editada.person_id_a} / b=${editada && editada.person_id_b} ` +
    `sobre from=${editada && editada.from_person_id} / to=${editada && editada.to_person_id}: ` +
    'invertir los extremos hace que el KMS cree una fila NUEVA en vez de actualizar la suya')

  // Y el cambio que la familia hizo es el que sale, no el que había.
  c.afirmar('(6) el tipo que sale es el que la familia acaba de elegir',
    !!(editada && editada.relation_type_id === tipoNuevo),
    `se esperaba relation_type_id="${tipoNuevo}" y las filas mandadas fueron ` +
    JSON.stringify(filas.map(r => r.relation_type_id)))

  return c
  } finally {
    scenario.tutorUnico = false
  }
}


/**
 * `0º.tricies.vicies.semel` — «EL ENLACE PUEDE HABER CADUCADO» CUANDO NO HA CADUCADO.
 *
 * ── El defecto, MEDIDO el 2026-08-25 sobre el registro real de Diego ────────────────────
 * Pidió su enlace, tardó DOS MINUTOS en llegarle, lo abrió, y el asistente le dijo *«No
 * hemos podido cargar tu solicitud. El enlace puede haber caducado — introduce tu correo a
 * continuación para recibir uno nuevo.»* El enlace se acababa de emitir y duran SIETE DÍAS.
 * `ResumePage` tenía UN SOLO `catch`: cualquier fallo —red, tiempo agotado, «Load failed»—
 * acababa en `/?resume_error=1`, que pinta ese cartel. Y el daño no es el texto: es la
 * SALIDA que ofrece, porque pedir otro enlace ROTA el que la familia tiene en la mano.
 *
 * ── Por qué se mata el SOCKET y no se devuelve un `{ok:false}` ─────────────────────────
 * Porque el fallo que hay que reproducir es el que NO DEJA RESPUESTA QUE LEER. Un
 * `{ok:false}` llega con cuerpo y con código y el cliente lo clasificaría por otra rama; lo
 * que Diego vio fue el `fetch` muriendo sin nada («network/fetch error: Load failed»). El
 * contador `scenario.hidratacionCorta` mata los N primeros intentos y deja pasar el
 * siguiente — así se puede afirmar TAMBIÉN que el reintento entra con el MISMO enlace.
 *
 * ── Las tres clases, una fase cada una ─────────────────────────────────────────────────
 *  A) no se pudo cargar   → se queda en la página, NO dice «caducado», NO ofrece pedir otro
 *                           enlace, y reintenta sola antes de rendirse.
 *  B) el mismo enlace     → el botón «Volver a intentarlo» entra, con el MISMO resume_token.
 *  C) el enlace no vale   → el servidor lo dice con su código ⇒ AHÍ SÍ va a la portada con
 *                           su cartel y su casilla, que es la única salida que existe.
 *  D) error nombrado      → se dice ÉSE, y se deja reintentar.
 *
 * ⚠️ LO QUE ESTA BATERÍA NO CUBRE: corre contra un backend SIMULADO que **nunca ejecuta
 * `backend/Code.js`**. Que los tres rechazos del servidor lleven ya su código de máquina
 * (`_errorDeEnlace_`) se acredita LEYENDO ese código, no aquí.
 */
async function caminoEnlaceNoHaCaducado(page, base) {
  const c = new Camino('enlace-no-ha-caducado')
  scenario.stage = 'hasta_preguntas'

  if (REAL) {
    c.noCubierta('el-enlace-no-ha-caducado',
      'el fallo de transporte se provoca matando el socket del servidor simulado; contra el sistema real no hay forma honesta de tumbar la hidratación a voluntad sin romperle la corrida a los caminos que vienen detrás')
    return c
  }

  // Los tres son deliberados: la hidratación muere sin respuesta (A/B) y el servidor
  // rechaza el enlace por su nombre (C/D). Si alguno NO llega a ocurrir, el camino cae.
  c.esperarErrorConsola(/gasCall hydrateSession: network\/fetch error/,
    'escenario deliberado: la hidratación muere en el transporte, como el «Load failed» del registro real')
  c.esperarErrorConsola(/ResumePage: hydrateSession failed/,
    'la página registra el fallo con su clase — sin eso no habría con qué diagnosticar')
  c.esperarErrorConsola(/gasCall hydrateSession: server returned ok=false/,
    'escenario deliberado: el servidor rechaza el enlace por su nombre (fases C y D)')

  try {
    // ── A · TRANSPORTE: la hidratación muere sin respuesta, como el «Load failed» real ───
    calls = []
    // ⚠️ NO es «tres intentos»: es EL TRANSPORTE CAÍDO. Medido el 2026-08-25 — al matar el
    // socket, **Chromium reintenta la petición por debajo** (4 peticiones al servidor para 2
    // intentos de la página), así que un contador por PETICIÓN no dice cuántos intentos hizo
    // la aplicación. Quien acredita el reintento es lo que la familia VE: el aviso «seguimos
    // cargando…», que solo se pinta cuando `reintentoAuto > 0`.
    scenario.hidratacionCorta = 99
    await page.goto(`${base}/#/resume/${DATOS.resumeToken}?n=${DATOS.emailId}`,
      { waitUntil: 'domcontentloaded', timeout: 30000 })

    // (5) primero se comprueba que NO se rinde a la primera: la pantalla lo DICE.
    const dijoQueSigue = await page.waitForFunction(
      () => /[Ss]eguimos cargando|[Ss]till loading/.test(document.body.textContent || ''),
      null, { timeout: LATENCY * 4 + 20000 },
    ).then(() => true).catch(() => false)

    const llegoElFallo = await page.waitForFunction(
      () => !!document.querySelector('[data-testid="resume-fallo"]'),
      null, { timeout: LATENCY * 6 + 30000 },
    ).then(() => true).catch(() => false)

    const pantallaA = await page.evaluate(() => ({
      hash:   window.location.hash,
      texto:  (document.body.textContent || '').replace(/\s+/g, ' ').trim(),
      fallo:  !!document.querySelector('[data-testid="resume-fallo"]'),
      boton:  !!document.querySelector('[data-testid="resume-reintentar"]'),
      // La casilla del correo de la PORTADA: si aparece, es que se fue a pedir otro enlace.
      correo: !!document.querySelector('input[type="email"]'),
    }))
    c.evidencia.elementos = (pantallaA.fallo ? 1 : 0) + (pantallaA.boton ? 1 : 0)

    if (!llegoElFallo) {
      const seFueALaPortada = /resume_error=1/.test(pantallaA.hash)
      c.fallos.push(`(1) un fallo de TRANSPORTE no puede acabar en «el enlace puede haber caducado» — ${seFueALaPortada ? 'la página SE FUE A LA PORTADA a decir que el enlace puede haber caducado y a pedir otro, con el enlace bueno todavía vivo (es el defecto entero: ha vuelto el `catch` único)' : 'no se pintó la pantalla de fallo'}; el hash quedó en "${pantallaA.hash}", los intentos registrados fueron ${JSON.stringify(calls.map(l => l.action + (l.cortada ? '(cortada)' : '')))} y la pantalla decía: ${pantallaA.texto.slice(0, 160)}`)
      return c
    }

    c.afirmar('(1) el fallo de transporte NO manda a la portada a pedir otro enlace',
      !/resume_error=1/.test(pantallaA.hash),
      `el hash quedó en "${pantallaA.hash}": se rotaría el token bueno que la familia tiene en la mano`)
    c.afirmar('(2) la pantalla NO dice que el enlace pueda haber caducado',
      !/caducad/i.test(pantallaA.texto),
      `la pantalla decía: ${pantallaA.texto.slice(0, 200)}`)
    c.afirmar('(3) NO se le ofrece pedir un enlace nuevo',
      !pantallaA.correo,
      'apareció la casilla del correo: pedir otro enlace ROTA el que la familia tiene')
    c.afirmar('(4) se le ofrece reintentar con el MISMO enlace',
      pantallaA.boton, 'no se pintó el botón «Volver a intentarlo»')

    const intentosA = llamadas('hydrateSession')
    c.afirmar('(5) la carga no se rinde a la primera: reintenta sola y lo DICE en pantalla',
      dijoQueSigue,
      'la pantalla nunca dijo «seguimos cargando»: o no reintentó, o reintentó en silencio')
    c.afirmar('(5.bis) y el reintento llega de verdad al servidor',
      intentosA.length >= 2,
      `se registraron ${intentosA.length} peticiones de hydrateSession (se esperaban al menos 2)`)

    // ── B · EL MISMO ENLACE: el botón entra, sin pedir nada nuevo ────────────────────────
    calls = []
    scenario.hidratacionCorta = 0
    await page.click('[data-testid="resume-reintentar"]')
    const entro = await page.waitForFunction(() => {
      const pasos = document.querySelectorAll('.wizard-step')
      return !!(pasos.length && [...pasos].some(p => p.classList.contains('active')))
    }, null, { timeout: LATENCY * 4 + 30000 }).then(() => true).catch(() => false)

    const reintentos = llamadas('hydrateSession')
    c.afirmar('(6) el reintento ENTRA en la solicitud', entro,
      'tras pulsar «Volver a intentarlo» el wizard no llegó a pintar el stepper')
    c.afirmar('(7) el reintento va con el MISMO enlace — no se pide uno nuevo',
      reintentos.length > 0 && reintentos.every(l => (l.payload || {}).resume_token === DATOS.resumeToken),
      `los tokens reintentados fueron ${JSON.stringify(reintentos.map(l => String((l.payload || {}).resume_token).slice(0, 8)))} y el del enlace es ${String(DATOS.resumeToken).slice(0, 8)}…`)
    c.afirmar('(8) reintentar NO pide un enlace nuevo por la puerta de atrás',
      llamadas('sendMagicLink').length === 0,
      `se registraron ${llamadas('sendMagicLink').length} llamadas a sendMagicLink: eso ROTA el token bueno`)

    // ── C · EL ENLACE NO VALE DE VERDAD: ahí SÍ se le manda a pedir otro ────────────────
    calls = []
    scenario.hidratacionRechazada = 'ENLACE_CADUCADO'
    await page.goto(`${base}/#/resume/${DATOS.resumeToken}?n=${DATOS.emailId}`,
      { waitUntil: 'domcontentloaded', timeout: 30000 })
    const rebote = await page.waitForFunction(
      () => /resume_error=1/.test(window.location.hash + window.location.search),
      null, { timeout: LATENCY * 4 + 20000 },
    ).then(() => true).catch(() => false)
    const textoC = await page.evaluate(() => (document.body.textContent || '').replace(/\s+/g, ' ').trim())
    c.afirmar('(9) un enlace que el servidor RECHAZA por su nombre sí lleva a pedir otro',
      rebote, 'el wizard no rebotó a la portada: la familia se queda sin la única salida que tiene')
    c.afirmar('(10) y allí se le dice que puede haber caducado, que es la verdad de ese caso',
      /caducad/i.test(textoC),
      `la portada decía: ${textoC.slice(0, 200)}`)
    c.afirmar('(11) el rechazo nombrado NO se reintenta a ciegas',
      llamadas('hydrateSession').length === 1,
      `se registraron ${llamadas('hydrateSession').length} intentos: repetir una hidratación que el servidor ya rechazó por su nombre no la va a aceptar la segunda vez`)

    // ── D · ERROR NOMBRADO: se dice ÉSE, y se deja reintentar ───────────────────────────
    calls = []
    scenario.hidratacionRechazada = 'KMS_NOT_CONFIGURED'
    await page.goto(`${base}/#/resume/${DATOS.resumeToken}?n=${DATOS.emailId}`,
      { waitUntil: 'domcontentloaded', timeout: 30000 })
    const hayMotivo = await page.waitForFunction(
      () => !!document.querySelector('[data-testid="resume-fallo-motivo"]'),
      null, { timeout: LATENCY * 4 + 20000 },
    ).then(() => true).catch(() => false)
    const pantallaD = await page.evaluate(() => ({
      hash:  window.location.hash,
      texto: (document.body.textContent || '').replace(/\s+/g, ' ').trim(),
      boton: !!document.querySelector('[data-testid="resume-reintentar"]'),
    }))
    c.afirmar('(12) un error NOMBRADO por el servidor se dice, no se disfraza de «caducado»',
      hayMotivo && !/caducad/i.test(pantallaD.texto),
      `motivo pintado: ${hayMotivo} · la pantalla decía: ${pantallaD.texto.slice(0, 200)}`)
    c.afirmar('(13) y también deja reintentar con el mismo enlace', pantallaD.boton,
      'no se pintó el botón «Volver a intentarlo»')
    return c
  } finally {
    scenario.hidratacionCorta = 0
    scenario.hidratacionRechazada = null
  }
}


/**
 * `0º.tricies.quintricies` — LO TECLEADO Y SIN GUARDAR NO PUEDE MORIR CON LA PÁGINA.
 *
 * ⛔ EL DEFECTO, MEDIDO contra `origin/main` el 2026-08-29: el asistente **solo encola un
 * guardado al pulsar Continuar** (`WizardPage.handleNext` → `enqueueSave`). No hay guardado
 * por campo ni por tiempo, y **nada** dispara al ocultarse la pantalla (0 apariciones de
 * `visibilitychange`/`pagehide` que hagan salir un guardado). ⇒ todo lo tecleado en un paso
 * vive SOLO en la memoria del navegador hasta que el tutor avanza, y **iOS descarta la
 * página** cuando se va a otra app: al volver se recarga desde cero y lo tecleado se perdió,
 * sin un solo aviso.
 *
 * ⛔ LA SALIDA NO ES GUARDAR EN EL NAVEGADOR, ES ENVIAR (KAL-7): los datos pendientes SON
 * datos personales de la familia, así que persistirlos en `sessionStorage` es exactamente lo
 * que esa decisión cierra. Se MANDAN antes de que la página muera; nada nuevo se queda aquí.
 *
 * La (4) es la mitad que se olvida: un guardado disparado a oscuras puede ser RECHAZADO y no
 * hay nadie mirando. Un rechazo que se pierde es PEOR que el dato perdido, porque el tutor
 * cree que guardó.
 */
async function caminoLoTecleadoNoMuere(page, base) {
  const c = new Camino('lo-tecleado-no-muere-con-la-pagina')
  scenario.stage = 'hasta_preguntas'   // aterriza en Documentos (5) y se retrocede a Personas (1)

  // Espía de guardados de paso: cuántos salen, de qué paso, y qué llevan dentro.
  const saves = []
  const espiar = (req) => {
    if (!/\/__gas/.test(req.url())) return
    let body = null
    try { body = JSON.parse(req.postData() || '{}') } catch { return }
    if (body && body.action === 'saveStep') saves.push({ ...body, _t: Date.now() })
  }
  page.on('request', espiar)
  const limpiar = () => page.off('request', espiar)

  // Ocultar/mostrar la pantalla como lo hace iOS al irse a otra app. `visibilityState` es de
  // solo lectura, así que se sustituye su lector y se emite el evento — que es exactamente
  // lo que el navegador hace.
  const ocultar = async () => {
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
      Object.defineProperty(document, 'hidden',          { configurable: true, get: () => true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await page.waitForTimeout(700)
  }
  const volver = async () => {
    await page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
      Object.defineProperty(document, 'hidden',          { configurable: true, get: () => false })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await page.waitForTimeout(700)
  }

  try {
    // ── ⛔ ¿ESTOY MIDIENDO LO QUE DIGO MEDIR? ─────────────────────────────────────
    // Este recorrido afirma sobre un mecanismo con nombre. Si alguien lo renombra o lo
    // retira, las afirmaciones de abajo caerían diciendo «no salió ningún guardado» —
    // cierto, pero sin nombrar que el recorrido ya no sabe qué está mirando. Se comprueba
    // contra el FUENTE, y si no está, sale CIEGO en vez de rojo-a-secas o de verde.
    const FUENTES = [
      ['frontend/src/context/WizardContext.jsx', /registrarBorradorDelPaso/],
      ['frontend/src/context/WizardContext.jsx', /leerBorradorDelPaso/],
      ['frontend/src/pages/WizardPage.jsx',      /addEventListener\('visibilitychange'/],
      ['frontend/src/pages/WizardPage.jsx',      /encolarGuardadoDelPaso/],
      ['frontend/src/pages/steps/Step2Persons.jsx', /registrarBorradorDelPaso/],
    ]
    const ausentes = []
    for (const [rel, re] of FUENTES) {
      let txt = ''
      try { txt = readFileSync(new URL('../../' + rel, import.meta.url), 'utf8') } catch { txt = '' }
      if (!re.test(txt)) ausentes.push(`${rel} :: ${re.source}`)
    }
    if (!c.afirmar('MEDICIÓN CIEGA · el mecanismo que este recorrido mide EXISTE con su nombre',
      ausentes.length === 0,
      `no se encontró en el fuente: ${ausentes.join(' · ')} — el recorrido NO puede medir lo que ` +
      `dice medir, así que NO puede salir verde`)) return c

    if (!await entrarPorElEnlace(c, page, base)) return c

    // Retroceder hasta Personas (índice 1), como lo haría la familia.
    for (let i = 0; i < 8 && (await dondeEstoy(page)) > 1; i++) {
      const atras = await page.$('button.btn-secondary-kis:not(:has(i.bi-pencil))')
      if (!atras) break
      await atras.click()
      await page.waitForTimeout(250)
    }
    if (!c.afirmar('ANCLA · se llega al paso de Personas', (await dondeEstoy(page)) === 1,
      `se quedó en el índice ${await dondeEstoy(page)}`)) return c
    await desbloquear(page)
    await page.waitForTimeout(250)

    // ── ANCLA: hay un campo donde teclear. Sin esto las demás medirían el aire.
    // ⚠️ Los campos del paso NO llevan `type="text"` explícito (`<input className="form-control">`),
    // y `input[type="text"]` NO casa un input sin ese atributo — medido: devolvía 0 y el ancla
    // caía sin que faltara nada en la pantalla.
    const SEL_CAMPO = 'input.form-control:not([type])'
    const campos = await page.$$(SEL_CAMPO)
    if (!c.afirmar('ANCLA · el paso admite escritura', campos.length > 0,
      'no se encontró ni un campo de texto en el paso de Personas')) return c

    // ── (1) Se teclea SIN pulsar Continuar y se oculta la pantalla ⇒ SALE el guardado ──
    const TECLEADO = 'ZZTecleadoSinGuardar'
    saves.length = 0
    await campos[0].click({ clickCount: 3 })
    await campos[0].type(TECLEADO, { delay: 15 })
    await page.waitForTimeout(1200)   // ventana: nadie guarda mientras se teclea

    const mientrasTeclea = saves.length
    c.afirmar('mientras se teclea NO sale ningún guardado (la ventana que se quiere cerrar)',
      mientrasTeclea === 0,
      `salieron ${mientrasTeclea} guardado(s) mientras se tecleaba`)

    await ocultar()
    const traasOcultar = saves.length
    if (!c.afirmar('(1) al ocultarse la pantalla SALE el guardado de lo tecleado',
      traasOcultar > mientrasTeclea,
      `no salió ningún guardado al ocultar la pantalla (${traasOcultar} en total): lo tecleado ` +
      `vive solo en la memoria del navegador, y si iOS descarta la página se pierde sin aviso`)) return c

    const llevaLoTecleado = saves.some(s =>
      JSON.stringify(s.payload || {}).includes(TECLEADO))
    c.afirmar('(1.bis) el guardado lleva LO TECLEADO, no una foto vieja', llevaLoTecleado,
      `ninguno de los ${saves.length} guardado(s) contenía «${TECLEADO}»`)

    // ── (2) Volver a visible NO repite el mismo guardado ──
    const antesDeVolver = saves.length
    await volver()
    await ocultar()   // ocultar OTRA vez sin tocar nada: el paso ya está limpio
    await volver()
    c.afirmar('(2) volver y re-ocultar NO repite el guardado',
      saves.length === antesDeVolver,
      `salieron ${saves.length - antesDeVolver} guardado(s) de más al ir y volver: ` +
      `ocultar y volver varias veces se convierte en una tormenta de guardados`)

    // ── (3) Ocultar con el paso LIMPIO no manda nada ──
    const antesLimpio = saves.length
    await ocultar()
    await volver()
    c.afirmar('(3) con el paso limpio, ocultar no manda NADA',
      saves.length === antesLimpio,
      `salieron ${saves.length - antesLimpio} guardado(s) con el paso ya limpio`)

    // ── (4) Un guardado disparado a oscuras que el servidor RECHAZA se VE al volver ──
    scenario.saveStepFails = true
    c.esperarErrorConsola(/saveStep|guardar|E2E_FORCED/i,
      'el escenario hostil hace que el servidor rechace el guardado disparado a oscuras')
    const campos2 = await page.$$(SEL_CAMPO)
    await campos2[0].click({ clickCount: 3 })
    await campos2[0].type('ZZSegundoIntento', { delay: 15 })
    await page.waitForTimeout(400)
    await ocultar()
    await page.waitForTimeout(1500)
    await volver()
    await page.waitForTimeout(1200)

    const avisoVisible = await page.evaluate(() => {
      const t = (document.body.innerText || '')
      return /no se pudo guardar|error al guardar|couldn.t save|save failed|reintentar|retry/i.test(t)
    })
    c.afirmar('(4) el RECHAZO del guardado disparado a oscuras se VE al volver', avisoVisible,
      'al volver a la pantalla no hay ni un aviso del guardado rechazado: el tutor cree que guardó')
    scenario.saveStepFails = false

    // ── (5) El disparo ENTRA POR LA COLA: no adelanta a un guardado ya en vuelo ──
    // El orden es FIFO A PROPÓSITO (personas→vínculos: el vínculo necesita el identificador
    // que estampa el de personas). Se deja una escritura deliberadamente lenta en vuelo, se
    // teclea otra cosa y se oculta: el segundo guardado tiene que llegar DESPUÉS del primero.
    // ⚠️ El freno tiene que ser MUCHO mayor que las esperas de este propio recorrido: con
    // 2,5 s el hueco medido era de 2174 ms **con la cola saltada**, o sea que lo producían
    // mis `waitForTimeout`, no la cola — y la rotura (c) salía VERDE. Con 6 s: en cola ~6,8 s,
    // saltándola ~1,5 s. Y las esperas de esta fase van al mínimo, sin los ayudantes de 700 ms.
    scenario.saveStepDemoraMs = 6000
    saves.length = 0
    const campos3 = await page.$$(SEL_CAMPO)
    await campos3[0].click({ clickCount: 3 })
    await campos3[0].type('ZZPrimeroEnLaCola', { delay: 10 })
    await page.waitForTimeout(150)
    const ocultarYa = () => page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'hidden' })
      Object.defineProperty(document, 'hidden',          { configurable: true, get: () => true })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    const volverYa = () => page.evaluate(() => {
      Object.defineProperty(document, 'visibilityState', { configurable: true, get: () => 'visible' })
      Object.defineProperty(document, 'hidden',          { configurable: true, get: () => false })
      document.dispatchEvent(new Event('visibilitychange'))
    })
    await ocultarYa()                    // ← primer guardado, LENTO, queda en vuelo
    await volverYa()
    const campos4 = await page.$$(SEL_CAMPO)
    await campos4[0].click({ clickCount: 3 })
    await campos4[0].type('ZZSegundoEnLaCola', { delay: 5 })
    await page.waitForTimeout(100)
    await ocultarYa()                    // ← segundo, mientras el primero sigue en vuelo
    await page.waitForTimeout(16000)     // deja drenar los dos (6 s cada uno + latencia)
    scenario.saveStepDemoraMs = 0

    // ⚠️ Lo que distingue FIFO NO es el ORDEN en que salen —ése se conserva igual aunque los dos
    // corran en paralelo, y con esa versión la rotura (c) salía VERDE: la afirmación medía el aire—.
    // Lo que lo distingue es que **la segunda no SALE hasta que la primera ha terminado**. Con la
    // escritura frenada a 2,5 s, en cola hay ≥2,5 s entre las dos; saltándola, salen casi seguidas.
    const cuerpos = saves.map(s => JSON.stringify(s.payload || {}))
    const iPrimero = cuerpos.findIndex(t => t.includes('ZZPrimeroEnLaCola') && !t.includes('ZZSegundoEnLaCola'))
    const iSegundo = cuerpos.findIndex(t => t.includes('ZZSegundoEnLaCola'))
    const hueco = (iPrimero !== -1 && iSegundo !== -1) ? (saves[iSegundo]._t - saves[iPrimero]._t) : -1
    c.afirmar(`(5) el guardado disparado a oscuras ENTRA POR LA COLA, no la adelanta (hueco ${hueco} ms)`,
      iPrimero !== -1 && iSegundo !== -1 && iPrimero < iSegundo && hueco >= 4000,
      `orden ${JSON.stringify([iPrimero, iSegundo])} sobre ${saves.length} llamada(s) y ${hueco} ms entre ` +
      `las dos (se esperan ≥4000, lo que tarda la primera): si el disparo saltara la cola, el orden ` +
      `personas→vínculos dejaría de estar garantizado`)

    c.evidencia.llamadas = saves.length
    c.evidencia.elementos = campos.length
    return c
  } finally {
    scenario.saveStepFails = false
    scenario.saveStepDemoraMs = 0
    limpiar()
  }
}

const CAMINOS = [
  { nombre: 'alta-nueva',          fn: caminoAltaNueva,          minLlamadas: 1, minElementos: 1 },
  { nombre: 'ack-indistinguible',  fn: caminoAckIndistinguible,  minLlamadas: 1, minElementos: 2 },
  // El precalentado no pinta un error rojo cuando no había nada que calentar. Contra el
  // sistema real se declara NO CUBIERTO y sale sin tocar la pantalla (pedir el enlace dos
  // veces rotaría el token de los caminos siguientes), así que ahí no se le exige evidencia.
  { nombre: 'precalentado-sin-ruido', fn: caminoPrecalentadoSinRuido,
    minLlamadas: REAL ? 0 : 1, minElementos: REAL ? 0 : 1 },
  { nombre: 'precalentado-fallo-se-registra', fn: caminoPrecalentadoFalloSeRegistra,
    minLlamadas: REAL ? 0 : 1, minElementos: REAL ? 0 : 1 },
  { nombre: 'recuperar-aterrizar', fn: caminoRecuperarAterrizar, minLlamadas: 1, minElementos: 11 },
  // `0º.tricies.vicies.quater` — abrir el asistente cuesta UN viaje, no ocho.
  // ⚠️ El mínimo de llamadas es 1 A PROPÓSITO y NO se sube: la evidencia de este camino es
  // justamente que salgan POCAS. Exigirle un número alto sería premiar el defecto que mide.
  { nombre: 'un-viaje-al-abrir', fn: caminoUnViajeAlAbrir,
    minLlamadas: REAL ? 0 : 1, minElementos: REAL ? 0 : 1 },
  // `0º.tricies.vicies.semel` — un fallo de transporte NO puede decir «el enlace puede haber
  // caducado» ni mandar a la familia a rotar el token que tiene en la mano.
  // ⚠️ El mínimo de llamadas es 1 A PROPÓSITO: el arnés cuenta las que quedan en `calls` al
  // TERMINAR, y este camino lo vacía en cada una de sus cuatro fases para poder afirmar sobre
  // ella. Su evidencia real son sus trece afirmaciones, no un contador.
  { nombre: 'enlace-no-ha-caducado', fn: caminoEnlaceNoHaCaducado,
    minLlamadas: REAL ? 0 : 1, minElementos: REAL ? 0 : 1 },
  // 2026-08-26 — un fallo de carga NO puede decirse como «el colegio no tiene programas».
  { nombre: 'programas-no-se-inventan', fn: caminoProgramasNoSeInventan,
    minLlamadas: REAL ? 0 : 1, minElementos: REAL ? 0 : 1 },
  { nombre: 'guardar-paso',        fn: caminoGuardarPaso,        minLlamadas: 1, minElementos: 11 },
  { nombre: 'lo-tecleado-no-muere-con-la-pagina', fn: caminoLoTecleadoNoMuere,
    minLlamadas: 1, minElementos: 1 },
  // ①31 — la familia que se incorpora a mitad de curso no puede quedarse encerrada en el paso 1.
  { nombre: 'fecha-a-mitad-de-curso', fn: caminoFechaAMitadDeCurso, minLlamadas: 1, minElementos: 11 },
  { nombre: 'subir-documento',     fn: caminoSubirDocumento,     minLlamadas: 1, minElementos: 1 },
  // ①27 pieza 9 · DL-R19 — la foto se comprime en el navegador, y lo inmutable NO se toca.
  { nombre: 'imagen-se-comprime-al-subir', fn: caminoImagenSeComprime, minLlamadas: 1, minElementos: 1 },
  // Solo en real: rellena 2-7, admite el expediente y lee de vuelta los once pasos. Va
  // ANTES del tramo de firma porque es lo que lo destapa (sin `AD` no hay firma que pintar).
  ...(REAL ? [{ nombre: 'expediente-completo', fn: caminoExpedienteCompleto, minLlamadas: 8, minElementos: 11 }] : []),
  { nombre: 'tramo-firma',         fn: caminoTramoFirma,         minLlamadas: 1, minElementos: 11 },
  { nombre: 'paso8-al-dia',        fn: caminoPaso8AlDia,         minLlamadas: 1, minElementos: 5 },
  { nombre: 'paso8-sin-nada-que-elegir', fn: caminoPaso8SinNadaQueElegir, minLlamadas: 1, minElementos: 5 },
  // Ejercita el paso 4 DESDE LA PANTALLA también en simulado. Nació para contestar, sin
  // gastar una corrida de 35 min, si el `0 de 1` de la salud contra el sistema real era
  // del producto o del conductor. Se queda: era cobertura que faltaba.
  { nombre: 'programa-se-recupera', fn: caminoProgramaSeRecupera, minLlamadas: 1, minElementos: 2 },
  { nombre: 'salud-desde-la-pantalla', fn: caminoSaludDesdeLaPantalla, minLlamadas: 1, minElementos: 11 },
  // Defecto 3 de la definición de hecho: el cuestionario se apagaba entero, en silencio
  // y durante media hora, por un fallo pasajero del servidor. Ver el camino.
  { nombre: 'cuestionario-no-se-apaga', fn: caminoCuestionarioNoSeApaga, minLlamadas: 1, minElementos: 2 },
  // Cola 18.quater — la familia pide corregir su solicitud ya enviada.
  { nombre: 'pedir-correccion',    fn: caminoPedirCorreccion,    minLlamadas: 2, minElementos: 11 },
  // Paso 7 · el simulador de cuotas — y que un simulador caído NO impide enviar.
  // Contra el sistema real se declara NO CUBIERTO: el paso 7 exige el código de un solo
  // uso para guardar la preferencia, y ese código llega a un buzón que el arnés no lee.
  { nombre: 'simulador-paso7', fn: caminoSimuladorPaso7,
    minLlamadas: REAL ? 0 : 1, minElementos: REAL ? 0 : 2 },
  // `0º.quaterdecies` — un solicitante con VARIOS planes aplicables a la vez (cuota +
  // comedor) ve los dos, con su nombre y su total sumado. Contra el sistema real se
  // declara NO CUBIERTO: exige declarar dos plantillas aplicables a la vez en el catálogo.
  { nombre: 'simulador-no-recalcula-al-navegar', fn: caminoSimuladorNoRecalculaAlNavegar,
    minLlamadas: REAL ? 0 : 1, minElementos: REAL ? 0 : 2 },
  // `0º.tricies.vicies.sexies` — una simulación que NO LLEGA no puede salir por la misma
  // puerta que «este plan no admite cuotas»: la primera es un fallo y se dice; la segunda
  // es una respuesta legítima del colegio.
  { nombre: 'cuotas-no-llegan-no-se-miente', fn: caminoCuotasNoLleganNoSeMiente,
    minLlamadas: REAL ? 0 : 1, minElementos: REAL ? 0 : 2 },
  { nombre: 'simulador-paso7-varios-planes', fn: caminoSimuladorPaso7VariosPlanes,
    minLlamadas: REAL ? 0 : 1, minElementos: REAL ? 0 : 2 },
  // `③70` — la familia que YA ENVIÓ consulta sus cuotas en el paso 7: ve las cifras y
  // todas las formas de pago, y no puede elegir ninguna (la elección en firme es el paso 8).
  { nombre: 'simulador-tras-enviar', fn: caminoSimuladorTrasEnviar,
    minLlamadas: REAL ? 0 : 1, minElementos: REAL ? 0 : 2 },
  { nombre: 'quitar-de-la-solicitud', fn: caminoQuitarDeLaSolicitud, minLlamadas: 1, minElementos: 11 },
  // `①45` — el paso 2 recoge los idiomas que habla cada persona (opcional, varios).
  { nombre: 'idiomas-hablados', fn: caminoIdiomasHablados, minLlamadas: 1, minElementos: 11 },
  { nombre: 'sexo-desde-el-catalogo', fn: caminoSexoDesdeElCatalogo, minLlamadas: 1, minElementos: 11 },
  // `0º.tricies.octies` (D) — no manda ni una petición: mide lo que la pantalla DICE.
  // `0º.septvicies` — el asistente deja de escribir la fila invertida del par de hermanos
  // (DL-S45), y el lector del paso 3 la sigue viendo guardada en cualquier sentido.
  { nombre: 'vinculo-hermanos-una-sola-fila', fn: caminoVinculoHermanosUnaSolaFila,
    minLlamadas: 1, minElementos: 11 },
  // `0º.duodetricies` — editar un vínculo YA guardado llega al servidor con sus dos extremos
  // (sin ellos, el escritor lo descarta EN SILENCIO y la corrección se pierde).
  { nombre: 'editar-vinculo-guardado', fn: caminoEditarVinculoGuardado,
    minLlamadas: 1, minElementos: 11 },
  { nombre: 'aviso-de-vinculo-señala-donde-es', fn: caminoAvisoDeVinculoSeñalaDondeEs,
    minLlamadas: 0, minElementos: 11 },
  // DL-E49 §4/§9 — la familia AVISA al tutor que acaba de declarar (pedido por Diego).
  { nombre: 'avisar-al-otro-tutor', fn: caminoAvisarAlOtroTutor, minLlamadas: 1, minElementos: 11 },
  // Cola 18.bis.25 — lo que la familia escribió sigue ahí cuando vuelve.
  { nombre: 'respuestas-vuelven', fn: caminoRespuestasVuelven, minLlamadas: 1, minElementos: 11 },
  // ②24.sexies — cuando el servidor descarta el cuestionario, la familia se entera.
  { nombre: 'respuestas-rechazadas-se-dicen', fn: caminoRespuestasRechazadasSeDicen, minLlamadas: 1, minElementos: 11 },
  // 18.bis.84 — «apuntado» no es «guardado»: el asistente vuelve a preguntar cómo acabó el
  // trabajo que el KMS dejó apuntado, y lo dice cuando acaba mal o descarta lo escrito.
  { nombre: 'guardado-apuntado-se-vigila', fn: caminoGuardadoApuntadoSeVigila, minLlamadas: 1, minElementos: 11 },
  // Lo que la familia SUBIÓ sigue ahí cuando vuelve (síntoma de Diego, 2026-08-09).
  // Contra el sistema real el recorrido se declara NO CUBIERTO y sale sin tocar la
  // pantalla (el código de un solo uso llega a un buzón que el arnés no lee), así que
  // ahí no se le puede exigir evidencia pintada: se exigiría por algo que se declaró
  // que no se hace, y el veredicto acusaría al producto de una carencia del arnés.
  // La verja del código de un solo uso: pedirlo NO puede congelar la pantalla (clase #32).
  // Contra el sistema real se declara NO CUBIERTO (no se fuerza la verja ni se lee el buzón),
  // así que allí no se le exige evidencia.
  { nombre: 'codigo-sin-congelar', fn: caminoCodigoSinCongelar,
    minLlamadas: REAL ? 0 : 1, minElementos: REAL ? 0 : 1 },
  // `0º.tricies.nonies` — entrar por el enlace manda UN código y la pantalla lo dice; la verja
  // se remonta al rehidratar y ya no olvida que ese código va de camino.
  { nombre: 'codigo-al-entrar-por-enlace', fn: caminoCodigoAlEntrarPorEnlace,
    minLlamadas: REAL ? 0 : 1, minElementos: REAL ? 0 : 1 },
  // 2026-08-20 — la ventana de los 10 min es de INACTIVIDAD: la actividad la reinicia,
  // el aviso sale dos minutos antes y una RECARGA vuelve a pedir el código.
  { nombre: 'ventana-por-inactividad', fn: caminoVentanaPorInactividad,
    minLlamadas: REAL ? 0 : 1, minElementos: REAL ? 0 : 1 },
  { nombre: 'documentos-vuelven', fn: caminoDocumentosVuelven,
    minLlamadas: REAL ? 0 : 1, minElementos: REAL ? 0 : 3 },
  // DL-E49 §1 — el envío es POR TUTOR: quien termina envía su parte, y la solicitud solo
  // pasa a revisión cuando han enviado todos.
  { nombre: 'segundo-tutor-envia', fn: caminoSegundoTutorEnvia, minLlamadas: 2, minElementos: 2 },
  // DL-E49 §2 — cada tutor ve LO SUYO y lo de los menores, nunca lo del otro tutor.
  { nombre: 'segundo-tutor-no-ve-al-primero', fn: caminoSegundoTutorNoVeAlPrimero, minLlamadas: 2, minElementos: 2 },
  { nombre: 'hermanos-desiguales', fn: caminoHermanosDesiguales, minLlamadas: 2, minElementos: 5 },
  { nombre: 'los-dos-pagadores',   fn: caminoLosDosPagadores,    minLlamadas: 2, minElementos: 5 },
  // DL-E49 §3 — las declaraciones de la familia de un solo tutor llegan al libro con su texto.
  { nombre: 'declaraciones-tutor-unico', fn: caminoDeclaracionesTutorUnico, minLlamadas: 1, minElementos: 2 },
  // Cola 18.bis.21 — lo que se ve en pantalla y lo que se guarda dejan de diferir.
  { nombre: 'telefono-que-se-ve-se-guarda', fn: caminoTelefonoQueSeVeSeGuarda, minLlamadas: 1, minElementos: 11 },
  // Cola 18.bis — el aviso rojo de guardado deja de mentir: se apaga cuando el dato ya
  // está guardado, y la familia puede cerrarlo sin que eso finja que se guardó.
  { nombre: 'guardado-muerto-se-dice', fn: caminoGuardadoMuertoSeDice, minLlamadas: 1, minElementos: 11 },
  { nombre: 'aviso-guardado-se-apaga',  fn: caminoAvisoGuardadoSeApaga,  minLlamadas: 1, minElementos: 11 },
  { nombre: 'aviso-guardado-se-cierra', fn: caminoAvisoGuardadoSeCierra, minLlamadas: 1, minElementos: 11 },
  { nombre: 'cambio-del-colegio-se-dice', fn: caminoLoQueCambiaElColegioSeDice, minLlamadas: 1, minElementos: 11 },
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
