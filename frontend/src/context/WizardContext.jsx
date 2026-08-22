import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import * as log from '../logger';
import { preparePersonsForUI } from '../pages/steps/personShape';
import i18n from '../i18n';                                   // DL-C-B (g): locale UI para sembrar el catálogo de preguntas del hydrate
import { purgeQuestionsCache, primeLookups, primeQuestions, getDocumentBytes, purgeDocumentBytesCache, alConfirmarEscritura, estadoDelGuardado, refrescarVentana } from '../api';  // 18.bis.84: preguntar cómo acabaron los guardados que el KMS dejó apuntados; WIZARD-PERF-CACHE-SKELETON: purgar cache de preguntas al limpiar sesión; DL-B: sembrar lookups del hydrate consolidado; DL-C-B: sembrar questions del hydrate; STEP10-VIEWER: bytes del paquete contractual → cache de object URLs del contexto
import { seReintentaTrasFallo, codigoDelDescarte } from '../lib/rechazos';       // 18.bis.85: el ÚNICO sitio que decide si un rechazo se vuelve a intentar (lo consulta también el aviso) · 18.bis.84: y el que traduce lo que el trabajo apuntado descartó

// P89 — Normalize AppSheet Y/N boolean strings to native booleans.
// Step2's preparePersonForUI and Step3's buildInitialRelations apply parseBool()
// to convert these, so the savedBaseline must be pre-normalized to the same shape
// or the dirty comparator sees false !== "Y" and fires spurious saves.
function normYN(v) {
  if (typeof v === 'boolean') return v;
  if (typeof v === 'string') {
    const l = v.toLowerCase();
    return l === 'true' || l === 'y' || v === '1';
  }
  return Boolean(v);
}

// WIZ-FINAL-GATE (2026-06-11) — normaliza el bloque `admission` que el backend
// devuelve (hydrate pesado, re-hydrate post-OTP, y pulse ligero) a la forma que
// consumen el gate del botón (canAdvanceToSigning) y los banners de WizardPage.
//
// CAUSA RAÍZ del bloqueo (verificado contra kis-app-perf/kms-server/enr/
// wizard-datalayer.gs:351-357): el `admission` de enr_wizardHydrate devuelve
// SOLO { state_code, state_label, signing_available, signing_context, editable } —
// NUNCA incluye `signing_status` NI `signing_ready`. La normalización previa
// (WIZARD-GATES BUG 2) derivaba signing_ready = (signing_status !== 'NOT_INITIATED'),
// pero con signing_status ausente eso colapsa a undefined → falsy → banner amarillo
// "se está preparando" SIEMPRE visible + canAdvanceToSigning false → botón
// deshabilitado, AUNQUE signing_context venga POBLADO (la firma SÍ está lista).
//
// Ground truth canónico (Code.js:1931+1947+1987): el backend solo resuelve
// signing_context cuando existe un signer per-guardian con signing_token (sesión
// de firma viva). Por tanto `signing_context` POBLADO ⟺ la firma está lista para
// ese guardian. Esa es la fuente de verdad — más fiable que un signing_status que
// el hydrate ni siquiera emite. Regla de derivación, en orden de prioridad:
//   1. signing_ready explícito del backend (si lo manda) MANDA.
//   2. si no, y hay signing_context con signing_token → READY (true).
//   3. si no, derivar de signing_status (!== NOT_INITIATED) cuando exista.
//   4. en último caso, signing_available && estado AD (la firma existe a nivel grupo).
// Análogamente sintetiza signing_status='READY' cuando no llega pero la firma está
// lista, para que canAdvanceToSigning (status !== 'COMPLETED') siga coherente.
function normalizeAdmission_(admRaw) {
  if (!admRaw) return null;
  const hasCtxToken = !!(admRaw.signing_context && admRaw.signing_context.signing_token);
  const statusKnown = admRaw.signing_status != null;
  // ready requiere una SEÑAL REAL: flag explícito, contexto con token, o status
  // conocido. Si el backend omite las tres (signing_available solo NO basta — puede
  // ser AD sin sesión de firma todavía), NO marcamos ready a la ligera → el banner
  // rojo/amarillo guía y el botón queda bloqueado hasta que haya señal de verdad.
  const ready =
    admRaw.signing_ready != null            ? !!admRaw.signing_ready
    : hasCtxToken                           ? true
    : statusKnown                           ? (admRaw.signing_status !== 'NOT_INITIATED')
    : false;
  // signing_status sintético solo si el backend no lo emite: si la firma está lista
  // y no completada → 'READY'; si no, 'NOT_INITIATED'. NUNCA pisa un status real
  // (incluido 'COMPLETED', que el banner/landing usan para el estado terminal).
  const status = statusKnown
    ? admRaw.signing_status
    : (ready ? 'READY' : 'NOT_INITIATED');
  return { ...admRaw, signing_ready: ready, signing_status: status };
}

const WizardContext = createContext(null);

// DL-E39 (PII-primero) — step-up re-auth + inactivity window.
// La PII sensible de menores (salud Art.9 RGPD, DNI, DOB, dirección) se muestra
// ENMASCARADA por defecto y se revela en claro solo tras un step-up (código
// fresco al buzón). El step-up "fresco" caduca a los 10 min de INACTIVIDAD.
export const STEPUP_WINDOW_MS = 10 * 60 * 1000; // 10 minutos

// 2026-08-20 — FRENO del «sigo aquí»: como mucho una llamada por minuto, por muchas
// pulsaciones que haya. Sin esto habría una petición por clic y por tecla. Un minuto es
// holgadísimo frente a los diez de la ventana.
export const REFRESCO_MINIMO_MS = 60 * 1000;

// Y el «sigo aquí» NI SIQUIERA SE PLANTEA mientras sobra ventana: solo a partir de la
// MITAD gastada. Con la ventana entera por delante no hay nada que reiniciar, así que
// llamar sería gasto puro — y, medido el 2026-08-20 en la batería, ruido de verdad: la
// petición se quedaba en vuelo al cambiar de pantalla, el navegador la abortaba y la
// familia veía un «network/fetch error» que no era suyo (tumbó `fecha-a-mitad-de-curso`).
// Con este umbral, quien está activo refresca UNA vez cada ~5 minutos en lugar de cada
// minuto, y la garantía es la misma: mientras haya actividad, el tiempo restante nunca
// llega a bajar de la mitad.
export const REFRESCO_UMBRAL_S = Math.round(STEPUP_WINDOW_MS / 2 / 1000);

// Cuánto antes de que caduque la ventana se le avisa a la familia. Diego, 2026-08-20:
// «No me parece mal un aviso dos minutos antes que el usuario tenga que aceptar, pero
// solo si no ha estado haciendo clic». Lo segundo sale SOLO: si ha estado clicando, el
// contador ya se reinició y nunca se baja de este umbral.
export const AVISO_ANTES_S = 120;

// Wizard canónico — 11 steps per roadmap (docs/kms/plan/wizard-admissions-roadmap.md
// líneas 17-27 + DL-E24 §3 + DL-E27 + DL-E28). NO inventar pasos extra.
// #11 (catálogo único de nombres de pasos): la lista STEPS que vivía aquí duplicaba
// el catálogo declarativo de pages/steps/catalog.js y ambas fuentes divergían
// ("Resumen" vs "Revisar y enviar"). ELIMINADA — el catálogo (STEP_CATALOG +
// stepLabelKey) es la ÚNICA fuente de ids y nombres de pasos; WizardProgress y los
// componentes de paso leen de él.

const initialStepData = {
  email:     { primary_email: '', verified: false },
  persons:   [],
  relations: [],
  health:    [],
  neae:      [],
  questions: [],
  documents: [],
};

const SESSION_KEY = 'kis_wizard_session';

function loadSession() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null') || {}; } catch { return {}; }
}
function saveSession(patch) {
  try {
    const current = loadSession();
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ ...current, ...patch }));
  } catch { /* ignore */ }
}

export function WizardProvider({ children }) {
  const session = loadSession();
  // Post-DL-E15: identity is `enrollmentGroupId` (cabecera enrEnrollmentGroups).
  // Backward-compat: fall back to legacy `session.applicationId` so in-flight
  // sessions from before this refactor keep working until they expire.
  const [enrollmentGroupId, setEnrollmentGroupIdRaw] = useState(
    session.enrollmentGroupId || session.applicationId || null
  );
  const [resumeToken,   setResumeTokenRaw]   = useState(session.resumeToken   || null);
  const [currentStep,   setCurrentStepRaw]   = useState(session.currentStep   || 0);
  const [stepData,      setStepData]         = useState(initialStepData);
  // Snapshot of step data AS LAST SAVED to the backend. Used by isStepDirty()
  // to skip redundant saveStep round-trips when the user clicks Next without
  // actually modifying anything. Updated by markStepSaved() after a successful
  // save, and seeded by hydrateFromResume() to reflect the just-loaded state.
  // Stored as a plain object (not Set/Map) so JSON.stringify works for diffing.
  // 2026-05-19 perf: Diego measured ~1-2s wasted per Next click when nothing
  // had changed; this baseline+diff pattern brings unchanged-step transitions
  // to ~50ms (UI only).
  const [savedBaseline, setSavedBaseline] = useState(initialStepData);
  // ── Data-layer pieza 2/3 — COLA DE ESCRITURA FIFO (autosave estilo Google Docs) ──
  // Antes: un único slot de promesa + handleNext BLOQUEABA el avance esperando el
  // save de N-1. Ahora: cola FIFO encadenada que corre los saves EN ORDEN en
  // background (preserva la dependencia persons→relations: el personIdMap del save
  // de personas se estampa antes de que arranque el save de relaciones), mientras la
  // navegación avanza al INSTANTE (no espera). El submit final SÍ espera el drenaje.
  //   - saveTailRef: cola del último save encolado (cada nuevo save .then() del tail).
  //   - pendingCountRef: saves en vuelo/pendientes (>0 ⇒ "Guardando…").
  //   - saveState: 'idle' (todo guardado) | 'saving' | 'error' (reintentando/falló).
  const saveTailRef     = useRef(Promise.resolve());
  const pendingCountRef = useRef(0);
  const [saveState, setSaveState] = useState('idle');
  const hasPendingSave = saveState === 'saving';
  // 0º.quindecies (segunda pieza) — la cola de arriba SOLO sabe de los guardados de paso;
  // una subida de documento (Step6Documents) es OTRO canal, directo por gasCall, que nunca
  // pasa por `enqueueSave`. El pulso (WizardPage) comprobaba `hasPendingSave` creyendo que
  // eso cubría «hay algo en vuelo», y no cubría subir un archivo — así se midió el choque
  // real: mientras un documento de 90 KB tardaba 96 s en subir, el pulso siguiente disparaba
  // igual `getAdmissionState` y pagaba su propia pregunta a la puerta del expediente en
  // paralelo. Este contador es SOLO para que el pulso se aparte — no toca el guardado de
  // pasos ni ninguna puerta de seguridad.
  const uploadsInFlightRef = useRef(0);
  const beginUpload = useCallback(() => { uploadsInFlightRef.current += 1; }, []);
  const endUpload = useCallback(() => { uploadsInFlightRef.current = Math.max(0, uploadsInFlightRef.current - 1); }, []);
  const hasUploadInFlight = useCallback(() => uploadsInFlightRef.current > 0, []);
  // ── El estado del aviso se cambia POR UN SOLO SITIO (cola 18.bis — la barra roja) ─────
  // `saveErrorSeq` cuenta los EPISODIOS de fallo: sube en cada entrada en 'error'. Sirve
  // para dos cosas que necesitan distinguir «sigue el mismo fallo» de «ha fallado otra
  // vez»: la X del aviso (cerrar el episodio actual, no cerrar los futuros) y el espejo
  // en pantalla. `saveErrorQue` es el NOMBRE de lo que no se pudo guardar, para que el
  // texto diga QUÉ pasó en vez de «Error al guardar» a secas.
  //
  // ②24.sexies — `saveErrorCodigo` viaja al lado del nombre por la MISMA razón por la que
  // `SubmitErrorBanner` mira el código del rechazo: hay motivos que «Reintentar» no arregla
  // (el servidor va a rechazar exactamente igual), y ofrecerlo es un callejón sin salida.
  // El aviso lo usa para explicar los que sabemos explicar; el resto se comporta como
  // siempre, byte-idéntico.
  const saveStateRef = useRef('idle');
  const [saveErrorSeq, setSaveErrorSeq] = useState(0);
  const [saveErrorQue, setSaveErrorQue] = useState('');
  const [saveErrorCodigo, setSaveErrorCodigo] = useState('');
  //
  // 18.bis.85 — `opts.mismoEpisodio` REPONE un aviso que sigue siendo cierto sin contarlo
  // como noticia nueva. Lo necesita el rechazo definitivo (abajo): mientras esté en pie hay
  // que volver a decirlo tras cada guardado que sí entra, y hacerlo subiendo el episodio
  // resucitaría un cartel que la familia ya cerró — el susto repetido que esto viene a quitar.
  const marcarEstadoDeGuardado_ = useCallback((siguiente, que, codigo, opts) => {
    saveStateRef.current = siguiente;
    setSaveState(siguiente);
    if (siguiente === 'error') { setSaveErrorQue(que || ''); setSaveErrorCodigo(codigo || ''); if (!(opts && opts.mismoEpisodio)) setSaveErrorSeq(n => n + 1); }
    else if (siguiente === 'idle') { setSaveErrorQue(''); setSaveErrorCodigo(''); }
  }, []);
  // UX-1 — aviso de validación GLOBAL: los steps lo setean (en vez de su banner local al
  // pie) y WizardPage lo pinta en la zona sticky superior. Se limpia al navegar/corregir.
  const [validationError, setValidationError] = useState('');
  // UX-3 — fallo del envío optimista del Step 7 (submit en background). Cuando el submit
  // de fondo falla, el rollback revierte isSubmitted y este flag dispara el aviso global
  // (toast visible en cualquier ruta, incl. /confirmation). Se limpia al reintentar OK.
  const [submitError, setSubmitError] = useState(false);
  // WPERF-1 criterio 3: referencia a la ÚLTIMA save factory que falló, para que el
  // SaveIndicator pueda ofrecer "Reintentar" y re-encolarla. Se limpia cuando la cola
  // drena sin errores. NOTA: solo re-ejecutable si la factory re-lanza la operación
  // (los saves /apply via enqueueSave(factory) lo hacen); un setPendingSave(promise)
  // ya iniciada re-resolvería la misma promesa settleada — los saves de paso usan
  // factories, que es el caso que cubre el botón.
  const lastFailedSaveRef = useRef(null);
  // Nombre en llano de lo que falló, para reponerlo tal cual al reintentar.
  const lastFailedQueRef = useRef('');
  // ── 18.bis.85 · UN RECHAZO DEFINITIVO SIGUE EN PIE AUNQUE OTRA COSA SÍ SE GUARDE ─────
  // `{que, codigo}` del último rechazo que el servidor repetiría idéntico, o `null`.
  // Los fallos NORMALES los tapa el propio reintento: mientras algo siga sin entrar, la
  // cola lo vuelve a mandar y el aviso se mantiene solo. Un rechazo definitivo NO se
  // reintenta —ése es el arreglo— y entonces el final feliz del SIGUIENTE guardado
  // (`pendingCount<=0 ⇒ 'idle'`) borraba el aviso y dejaba en pantalla «Todos los cambios
  // guardados» con el cuestionario de la familia tirado a la basura. MEDIDO: la batería lo
  // cazó a la primera. Mientras esto tenga valor, la cola nunca cae a 'idle': repone el
  // aviso tal cual (mismo episodio, así que un cartel cerrado sigue cerrado). Se va con la
  // pestaña; nada dentro de la sesión puede volver cierto lo que el servidor ya descartó.
  const rechazoDefinitivoRef = useRef(null);
  // ── 18.bis.84 · «APUNTADO» NO ES «GUARDADO»: HAY QUE VOLVER A PREGUNTAR ──────────────
  // El KMS no escribe los pasos en el acto: los APUNTA y los hace después. Por eso una
  // llamada de guardado que vuelve bien solo acredita que el servidor la aceptó, y la
  // familia leía «Todos los cambios guardados» aunque el trabajo acabara fallando — o
  // descartando a propósito lo que había escrito (el KMS no deja que un tutor toque la
  // ficha de otro, DL-E49 §2, ni guarda las respuestas de quien ya envió su parte, §6).
  //
  // Aquí se recuerdan los trabajos apuntados con la MISMA etiqueta en llano que ya usa el
  // aviso (`que`), y —cuando lo hay— la factory para poder reintentarlos: sin ella el
  // botón «Reintentar» sería un botón que no hace nada, que es peor que no tenerlo.
  //
  // Tope de 10: es lo que acepta el KMS de una vez, y sin tope una sesión larga acabaría
  // arrastrando una lista que crece sola. Se pierde con la pestaña, como todo lo demás.
  const trabajosApuntadosRef = useRef([]);   // [{ job_id, que, reintento }]
  const preguntandoPorTrabajosRef = useRef(false);
  // Guardados INDEPENDIENTES en vuelo (no van en el eslabón, pero el envío final SÍ tiene
  // que esperarlos). Se limpian al settle para que la lista no crezca durante la sesión.
  const sueltosRef = useRef([]);
  // WPERF-1 criterio 4 (auto-avance guard): se pone a true en CUALQUIER navegación
  // MANUAL (botón atrás/adelante, avance de firma). El JUMP async de enterSigning lo
  // resetea al hacer click y lo comprueba antes de saltar: si el usuario navegó a mano
  // tras el click, aborta el salto (no le pisa la pantalla ~19s después).
  const userTookControlRef = useRef(false);
  const markUserTookControl  = useCallback(() => { userTookControlRef.current = true;  }, []);
  const resetUserTookControl = useCallback(() => { userTookControlRef.current = false; }, []);

  /**
   * 18.bis.84 — RECUERDA un trabajo que el servidor dejó APUNTADO, para poder preguntar
   * después cómo acabó. Sin identificador no hay nada que apuntar (el paso no encoló nada)
   * y esto es no-op: ni ruido ni llamadas de más.
   *
   * Lo llama SOLO la cola (abajo) para todo lo que pasa por ella, y a mano el paso de salud
   * —que guarda las NEAE fuera de la cola a propósito— porque si no, ese guardado sería el
   * único que puede descartarse en silencio.
   *
   * @param {string} jobId identificador opaco que devuelve el servidor (sin datos personales).
   * @param {string} que   nombre en llano de lo que se guardaba, el MISMO que usa el aviso.
   * @param {() => Promise<any>} [reintento] factory para volver a mandarlo, si la hay.
   */
  const apuntarTrabajo = useCallback((jobId, que, reintento) => {
    if (!jobId || typeof jobId !== 'string') return;
    const ya = trabajosApuntadosRef.current;
    if (ya.some(t => t.job_id === jobId)) return;      // idempotente: nunca dos veces el mismo
    ya.push({ job_id: jobId, que: que || '', reintento: reintento || null });
    // Tope de 10 (lo que acepta el KMS de una vez). Se descarta lo MÁS VIEJO: un trabajo de
    // hace rato que sigue sin resolverse ya no se puede atribuir a nada que la familia
    // recuerde, y lo recién guardado es lo que de verdad importa contarle.
    if (ya.length > 10) ya.splice(0, ya.length - 10);
  }, []);

  /**
   * Encola una factory de save (función que devuelve la promesa del save). Se
   * ENCADENA tras el save anterior (orden FIFO garantizado) pero NO bloquea al
   * caller: la navegación llama enqueueSave y avanza de inmediato. Reintenta
   * errores TRANSITORIOS (red) hasta 2 veces con backoff; los errores de negocio
   * (STEPUP_REQUIRED, INVALID_PHONE, NOT_EDITABLE) NO se reintegran a ciegas —
   * los propaga la propia factory (que ya muestra su UI) y marca 'error'.
   * @param {() => Promise<any>} saveFn
   * @returns {Promise<any>} la promesa del save (para que el caller la awaite si quiere)
   */
  // ── UNA COLA ÚNICA MATA A QUIEN NO DEPENDE DE NADIE (medido 2026-08-04) ──────────────
  // La cola encadena TODO guardado detrás del anterior. Eso es correcto para lo que sí tiene
  // orden (personas → vínculos: el vínculo necesita el `person_id` que estampa el de
  // personas), y es MORTAL para lo que no: si una llamada anterior no vuelve, el eslabón
  // nunca avanza y **todo lo que venga detrás se queda dentro del navegador para siempre,
  // sin error y sin aviso**. Y no vuelve fácil: `gasCall` no lleva temporizador, y el doble
  // salto de GAS falla en su segundo tramo de forma reproducible.
  //
  // MEDIDO con el bundle real en navegador (reproducción con el servidor colgando UNA
  // respuesta): la 1.ª llamada sale y no vuelve; la familia corrige una respuesta y pulsa
  // Continuar, y la 2.ª **no sale en 30 s** — ni saldrá. En campo, el paso 5 mandó 48
  // respuestas al estado y **ninguna llamada salió en 60 s**.
  //
  // `independiente: true` saca de la cadena a los guardados que NO dependen de ningún otro
  // (las respuestas del cuestionario: van contra el expediente, que existe desde el paso 1).
  // Siguen contando para el indicador y siguen siendo reintentables — lo único que se les
  // quita es tener que esperar a algo con lo que no tienen nada que ver.
  const enqueueSave = useCallback((saveFn, opts) => {
    const independiente = !!(opts && opts.independiente);
    // Nombre EN LLANO de lo que se está guardando (p.ej. «Personas»). Opcional: quien no
    // lo pase deja el aviso genérico, nunca uno inventado.
    const que = (opts && opts.que) || '';
    pendingCountRef.current += 1;
    marcarEstadoDeGuardado_('saving');
    const _t0 = Date.now();                          // DBG-SESSION timing
    log.info('[DBG savequeue] enqueue', { pending: pendingCountRef.current, independiente });
    const run = independiente
      ? Promise.resolve().then(() => saveFn())       // sin esperar a nadie: no depende de nadie
      : saveTailRef.current
        .catch(() => {})               // un fallo previo no debe abortar la cola
        .then(() => saveFn());         // ejecuta EN ORDEN tras el anterior
    // El tail avanza pase lo que pase; el conteo decrece al settle. Un guardado
    // independiente NO entra en el tail: si entrara, volvería a poder bloquear a los que
    // sí van en orden, que es justo lo que se está corrigiendo.
    const seguimiento = run.then(
      // 18.bis.84 — el servidor dijo «apuntado», no «guardado». Se anota el identificador del
      // trabajo (si el paso encoló alguno) para poder preguntar después cómo acabó, con la
      // MISMA etiqueta en llano que usaría el aviso y con esta misma factory por si hay que
      // reintentarlo. Va DENTRO del final feliz a propósito: un guardado que ni siquiera
      // llegó a aceptarse ya se cuenta por el carril de error de aquí abajo.
      (res) => { apuntarTrabajo(res && res.job_id, que, saveFn); pendingCountRef.current -= 1; log.info('[DBG savequeue] done OK', { ms: Date.now() - _t0, pending: pendingCountRef.current }); if (pendingCountRef.current <= 0) { pendingCountRef.current = 0; lastFailedSaveRef.current = null; lastFailedQueRef.current = ''; const enPie = rechazoDefinitivoRef.current; if (enPie) marcarEstadoDeGuardado_('error', enPie.que, enPie.codigo, { mismoEpisodio: true }); else marcarEstadoDeGuardado_('idle'); } },
      // ── 18.bis.85 · UN RECHAZO DEFINITIVO NO SE GUARDA PARA REINTENTARLO ──────────────
      // Recordar la factory es lo que habilita los DOS reintentos: el botón «Reintentar» y
      // —el que muerde— el automático de `alConfirmarEscritura`. Con un rechazo que el
      // servidor repetiría idéntico (`PARTE_YA_ENVIADA`), reintentar es un viaje condenado
      // a fallar y le repite el susto a la familia como episodio nuevo. Así que no se
      // recuerda: los dos consumidores ya son no-op sin factory, sin repartir la decisión
      // por el fichero. El criterio vive en UN solo sitio (`lib/rechazos.js`), el mismo que
      // consulta el aviso — y todo lo que no esté declarado allí se sigue reintentando
      // igual que hasta hoy (un corte de red no puede convertirse en trabajo perdido).
      (e) => { pendingCountRef.current -= 1; const codigoFallo = e && e.code; const reintentable = seReintentaTrasFallo(codigoFallo); lastFailedSaveRef.current = reintentable ? saveFn : null; lastFailedQueRef.current = reintentable ? que : ''; if (!reintentable) rechazoDefinitivoRef.current = { que: que, codigo: codigoFallo }; log.warn('[DBG savequeue] done ERR', { ms: Date.now() - _t0, pending: pendingCountRef.current, code: codigoFallo, reintentable, message: e && e.message }); if (pendingCountRef.current < 0) pendingCountRef.current = 0; marcarEstadoDeGuardado_('error', que, codigoFallo); }
    );
    if (!independiente) saveTailRef.current = seguimiento;
    else {
      sueltosRef.current.push(seguimiento);
      seguimiento.then(() => { sueltosRef.current = sueltosRef.current.filter(p => p !== seguimiento); });
    }
    return run;
  }, [marcarEstadoDeGuardado_, apuntarTrabajo]);

  /**
   * WPERF-1 criterio 3: re-encola la última save que falló (la guarda
   * lastFailedSaveRef). Lo dispara el botón "Reintentar" del SaveIndicator. No-op si
   * no hay ninguna pendiente de reintento. Limpia la ref antes de re-encolar para no
   * reintentar dos veces la misma factory si el usuario hace doble click.
   */
  const retryLastSave = useCallback(() => {
    const fn = lastFailedSaveRef.current;
    if (!fn) return;
    const que = lastFailedQueRef.current;
    lastFailedSaveRef.current = null;
    log.info('[DBG savequeue] retry last failed save');
    enqueueSave(fn, { que });
  }, [enqueueSave]);

  /**
   * 18.bis.84 · PREGUNTA CÓMO ACABARON LOS GUARDADOS QUE EL SERVIDOR DEJÓ APUNTADOS.
   *
   * ── Por qué hace falta preguntar ─────────────────────────────────────────────────────
   * El KMS no escribe los pasos en el acto: los apunta y los hace después. Que la llamada
   * volviera bien solo acredita que la aceptó. Lo que pase luego —que el trabajo falle, o
   * que descarte a propósito lo que la familia escribió— **no llega por ningún sitio** si
   * nadie vuelve a preguntar. Hasta hoy no preguntaba nadie, y la pantalla se quedaba
   * diciendo «Todos los cambios guardados».
   *
   * ── Qué se hace con cada respuesta ───────────────────────────────────────────────────
   *   · `hecho` sin descartes → se olvida, en silencio. Era verdad y no hay nada que decir.
   *   · `hecho` CON descartes → rechazo DEFINITIVO: el servidor lo volvería a descartar,
   *     así que se dice con su motivo y NO se ofrece «Reintentar» (`lib/rechazos.js`).
   *   · `fallido` → se dice, y SÍ es reintentable: se repone la factory para que el botón
   *     «Reintentar» haga algo de verdad en vez de ser un botón muerto.
   *   · `pendiente` / `desconocido` → **no se toca nada**. «Desconocido» es «no se sabe»
   *     (también es lo que contesta el KMS para un trabajo que no es de este expediente,
   *     para no delatar que exista): tratarlo como fallo sería asustar a la familia con un
   *     problema inventado.
   *
   * ── No puede romper nada ─────────────────────────────────────────────────────────────
   * Nadie la espera y su fallo se registra y se sigue: si la consulta no se puede hacer, el
   * asistente se comporta exactamente como antes de existir esto.
   */
  const preguntarPorLosGuardados = useCallback(() => {
    const lote = trabajosApuntadosRef.current.slice(0, 10);
    if (!lote.length) return;
    if (preguntandoPorTrabajosRef.current) return;   // no solapar: una pregunta cada vez
    if (!resumeToken) return;                        // sin bearer no hay nada que preguntar
    preguntandoPorTrabajosRef.current = true;
    estadoDelGuardado(resumeToken, lote.map(x => x.job_id))
      .then((res) => {
        const trabajos = (res && Array.isArray(res.trabajos)) ? res.trabajos : [];
        const resueltos = new Set();
        trabajos.forEach((t, i) => {
          // El servidor contesta EN EL MISMO ORDEN en que se preguntó; aun así se casa por
          // identificador cuando viene, que es más barato que confiar y equivocarse de paso.
          const apuntado = (t && t.job_id && lote.find(x => x.job_id === t.job_id)) || lote[i];
          if (!apuntado) return;
          const codigo = codigoDelDescarte(t && t.descartes);
          if (codigo) {
            // Definitivo: queda EN PIE aunque otros guardados entren después (si no, el
            // siguiente final feliz drena la cola y repone «Todos los cambios guardados»
            // con lo de la familia tirado a la basura — 18.bis.85).
            log.warn('[DBG savequeue] el trabajo apuntado DESCARTÓ contenido', { que: apuntado.que, codigo });
            rechazoDefinitivoRef.current = { que: apuntado.que, codigo };
            lastFailedSaveRef.current = null;        // reintentar lo descartaría igual
            lastFailedQueRef.current = '';
            marcarEstadoDeGuardado_('error', apuntado.que, codigo);
            resueltos.add(apuntado.job_id);
          } else if (t && t.estado === 'fallido') {
            log.warn('[DBG savequeue] el trabajo apuntado FALLÓ', { que: apuntado.que, motivo: t.motivo || '' });
            lastFailedSaveRef.current = apuntado.reintento || null;
            lastFailedQueRef.current = apuntado.que || '';
            marcarEstadoDeGuardado_('error', apuntado.que);
            resueltos.add(apuntado.job_id);
          } else if (t && t.estado === 'hecho') {
            resueltos.add(apuntado.job_id);          // entró entero: nada que decir
          }
          // 'pendiente' / 'desconocido' → se queda apuntado y se vuelve a preguntar.
        });
        if (resueltos.size) {
          trabajosApuntadosRef.current = trabajosApuntadosRef.current.filter(x => !resueltos.has(x.job_id));
        }
      })
      .catch(err => log.warn('WizardContext: no se pudo preguntar por los guardados apuntados', { message: err && err.message }))
      .finally(() => { preguntandoPorTrabajosRef.current = false; });
  }, [resumeToken, marcarEstadoDeGuardado_]);

  // ── EL AVISO ROJO SE APAGA CUANDO DEJA DE SER CIERTO, NO CUANDO MOLESTA ──────────────
  // Diego, 2026-08-09: «si al final guarda por otro lado (como me ha pasado) la barra se
  // queda». La causa medida: el aviso solo se apagaba desde el final feliz de ESTA cola,
  // y hay guardados que persisten de verdad sin pasar por ella (subir un documento,
  // guardar las NEAE, quitar a alguien del expediente). El dato quedaba a salvo y el
  // aviso seguía diciendo lo contrario.
  //
  // Lo que se hace NO es apagarlo: es COMPROBARLO. Cuando el servidor acepta cualquier
  // escritura, el canal demostrablemente funciona ⇒ se REINTENTA aquí el guardado que
  // había fallado, y es la cola —el único sitio que gobierna el aviso— la que vuelve a
  // decidir: verde si ahora sí entra, rojo si sigue sin entrar. Así el aviso nunca miente
  // en ninguna de las dos direcciones, y NO hay ni un `setSaveState('idle')` repartido
  // por las pantallas.
  //
  // Sin bucles: solo una escritura CON ÉXITO dispara esto, el reintento pone el estado en
  // 'saving' (así que su propia confirmación no vuelve a entrar), y si el reintento falla
  // no llega ninguna confirmación nueva que lo repita.
  //
  // 18.bis.85 — y NO reintenta lo que el servidor va a rechazar igual: un rechazo definitivo
  // ni siquiera se guardó (ver el manejador de error de `enqueueSave`), así que aquí no hay
  // factory y esto es no-op. El aviso se queda como está, sin repetirle el susto a la familia.
  useEffect(() => alConfirmarEscritura(() => {
    if (saveStateRef.current !== 'error') return;
    const fn = lastFailedSaveRef.current;
    if (!fn) return;
    const que = lastFailedQueRef.current;
    lastFailedSaveRef.current = null;
    log.info('[DBG savequeue] el servidor aceptó otra escritura — se reintenta el guardado que había fallado');
    enqueueSave(fn, { que });
  }), [enqueueSave]);

  /**
   * Devuelve una promesa que resuelve cuando la cola de saves está DRENADA
   * (todos los saves encolados han settleado). El submit final la awaita antes
   * de enviar. Safe incluso sin saves en vuelo (tail ya resuelto).
   */
  const awaitPendingSave = useCallback(() => {
    const _t0 = Date.now();                          // DBG-SESSION timing
    log.info('[DBG savequeue] await start');
    // Los guardados INDEPENDIENTES no van en el eslabón (por eso no los bloquea nadie),
    // así que esperar solo al eslabón dejaría de esperarlos — y el envío final saldría con
    // el cuestionario todavía en vuelo. Se espera a AMBAS cosas: la cadena ordenada y los
    // sueltos. Sin esto, el arreglo del bloqueo habría cambiado una pérdida silenciosa por
    // otra.
    return Promise.all([saveTailRef.current, ...sueltosRef.current]).then(
      () => log.info('[DBG savequeue] await resolved', { ms: Date.now() - _t0 }),
      () => log.warn('[DBG savequeue] await rejected', { ms: Date.now() - _t0 })
    ).catch(() => {});
  }, []);

  /**
   * COMPAT: registra una promesa de save YA INICIADA en la cola (solo tracking +
   * drain + indicador). La usan los saves de firma (SignBilling/Gdpr/Review), que
   * ya se auto-serializan esperando `awaitPendingSave` del paso N-1 antes de lanzar
   * el suyo. Para saves donde importa el ORDEN de ejecución (persons→relations),
   * usar `enqueueSave(factory)` en su lugar (encadena la EJECUCIÓN, no solo el track).
   */
  const setPendingSave = useCallback((promise) => {
    return enqueueSave(() => promise);
  }, [enqueueSave]);
  // Steps the user has already passed. Initially empty; populated either by
  // forward navigation (WizardPage.handleNext → addCompletedStep) or by
  // hydration from a resumed session (hydrateFromResume infers from data).
  // Lifted into context (was WizardPage local state) so hydrate can seed it.
  const [completedSteps, setCompletedStepsRaw] = useState(new Set(session.completedSteps || []));

  const addCompletedStep = useCallback((idx) => {
    setCompletedStepsRaw(prev => {
      const next = new Set(prev); next.add(idx);
      saveSession({ completedSteps: [...next] });
      return next;
    });
  }, []);
  const removeCompletedStep = useCallback((idx) => {
    setCompletedStepsRaw(prev => {
      const next = new Set(prev); next.delete(idx);
      saveSession({ completedSteps: [...next] });
      return next;
    });
  }, []);
  // True once hydrateFromResume detects submitted_at IS NOT NULL, OR
  // Step7Review's handleSubmit succeeds.
  //
  // Drives read-only wizard mode: fields locked, no Edit button in
  // LockedBanner, no abandon. Conceptually this is the negation of
  // `isApplicationEditable_()` server-side — see backend Code.js for the
  // canonical editable-states list.
  //
  // Editability semantics — CLI 26 (2026-06-01):
  //   - Application is EDITABLE when `current_state_code ∈ EDITABLE_STATES`.
  //   - EDITABLE_STATES = ['DRAFT', 'NEEDS_MORE_INFO'] (frontend hardcoded;
  //     TODO mover a catálogo dinámico vía sysStateTransitions_T).
  //   - The wizard maps `current_state_code` to `submitted_at` boolean:
  //       submitted_at IS NULL  → DRAFT (editable)
  //       submitted_at IS NOT NULL → RQ/IN/etc (not editable)
  //     The KMS-driven "reopen to NEEDS_MORE_INFO" path is handled server-side
  //     in resumeSession_ (it overrides submitted_at to null when all
  //     enrollments are back in IN), so `isSubmitted=false` already covers it.
  const [isSubmitted, setIsSubmittedRaw] = useState(session.isSubmitted || false);
  const setIsSubmitted = useCallback((val) => {
    setIsSubmittedRaw(val);
    saveSession({ isSubmitted: val });
  }, []);

  // ── DL-E38 / P216 — admission state + per-guardian signing context ──────────
  // `admissionState` (P215 `admission` block) + `signingContext` are re-fetched
  // by resumeSession_ on every resume, so they live in React state only (NOT
  // persisted — avoids stashing the signing_token bearer secret in sessionStorage;
  // prompt §2.5 "solo el email"). `recoveredEmail` IS persisted: it's the a1
  // discriminator the frontend re-sends so the backend re-resolves the guardian
  // server-side on each call. Only the email is stored; never the token.
  const [admissionState, setAdmissionState] = useState(null);
  // Decisión Diego 2026-06-12 (lock EN VIVO): los flags de hitos del hydrate son de
  // la ENTRADA — si el usuario confirma la lectura en ESTA sesión, el bloqueo debe
  // engancharse al instante, sin esperar al re-hydrate ni al drenado del job.
  const [reviewConfirmedLocal, setReviewConfirmedLocalRaw] = useState(!!session.reviewConfirmedLocal);
  const setReviewConfirmedLocal = useCallback((v) => {
    setReviewConfirmedLocalRaw(!!v);
    saveSession({ reviewConfirmedLocal: !!v }); // sobrevive a F5 / navegación
  }, []);
  const [signingContext, setSigningContext] = useState(null);

  // ── STEP10-VIEWER (Diego 2026-06-11) — cache EN MEMORIA del paquete contractual ──
  // Queja literal: "si avanzo de los documentos a la firma y vuelvo a documentos, me
  // vuelve a cargar los documentos, no los almacena en memoria." Los object URLs (+
  // sha256/filename/mimeType — DOC-BYTES) viven AQUÍ keyed por file_id, NO en useState
  // local de SignReview → navegar 10→11→10 NO refetchea ni re-crea blobs. La lista de
  // members del paquete (`signingMembers`, metadata sin bytes) también se cachea para
  // que la re-entrada al Step 10 pinte al instante (se refresca en background).
  // Revocación de object URLs SOLO al limpiar sesión / desmontar el wizard (clearSession
  // + cleanup del provider), NUNCA al salir del step. KAL-7: nada de esto toca la URL ni
  // sessionStorage (los blobs son documentos contractuales — viven solo en memoria).
  const [docCache, setDocCache] = useState({});   // { [file_id]: { url, sha256, filename, mimeType } }
  const docCacheRef = useRef({});                 // espejo síncrono (race guard + revocación)
  const [signingMembers, setSigningMembersRaw] = useState(null); // null = nunca cargados
  const setSigningMembers = useCallback((members) => {
    setSigningMembersRaw(Array.isArray(members) && members.length ? members : null);
  }, []);

  // ── WIZARD-UX TASK-1 (Diego 2026-06-13) — memo EN MEMORIA del ESTADO de la sesión ──
  // de firma (Step 11). Queja literal: al volver atrás y re-avanzar al paso final, el
  // UI "parece que reenvía los documentos para la firma" porque cada re-entrada al Step
  // 11 disparaba un initiateSigningSession create_only (READ ~12s) + re-warm de docs.
  // El despacho real es SERVER-SIDE (kis-rule-0018) — esto NO reenvía nada — pero la
  // re-lectura cara + el spinner "Guardando…" lo PARECEN. Cacheamos aquí { state,
  // signerUrls } por sesión de navegación, igual que signingMembers: la re-entrada pinta
  // el ESTADO al instante desde memoria y solo refresca en background. Una transición
  // hacia un estado iniciado (INITIATED/IN_PROGRESS/COMPLETED) NUNCA retrocede a DRAFT.
  // NO se persiste (KAL-7: vive solo en memoria; un F5 re-lee del servidor, que es la
  // verdad). Se purga en clearSession (junto al resto del estado de firma).
  const [signingSession, setSigningSessionRaw] = useState(null); // null = nunca leído
  const setSigningSession = useCallback((next) => {
    setSigningSessionRaw(prev => {
      if (!next) return prev;   // no pisar con null/undefined
      // Monotonía: una vez iniciada (envelope despachado server-side), no volver a DRAFT.
      const initiated = (s) => {
        if (!s) return false;
        const u = String(s).toUpperCase();
        return u !== 'DRAFT' && u !== 'NOT_INITIATED';
      };
      if (prev && initiated(prev.state) && !initiated(next.state)) {
        // refresco transitorio "menos iniciado" → conserva el state ya iniciado
        // (la sesión no des-despacha) pero acepta members/urls nuevos.
        return { ...next, state: prev.state };
      }
      return next;
    });
  }, []);

  /**
   * Resuelve un documento del paquete a su entrada de cache { url, sha256, filename,
   * mimeType }. Pasa SIEMPRE por getDocumentBytes (api.js — única capa de fetch +
   * de-dupe, compartida con el warm prefetchDocuments) y crea el object URL UNA sola
   * vez por file_id. Idempotente y race-safe: si otro caller ya creó la entrada
   * mientras llegaban los bytes, se reutiliza la suya (sin fugar el blob duplicado).
   * @param {{file_id:string, resume_token?:string, signing_token?:string, n?:string, recovered_email?:string}} params
   * @returns {Promise<{url:string, sha256:string|null, filename:string|null, mimeType:string|null}>}
   */
  const loadDocument = useCallback(async (params) => {
    const fid = params && params.file_id;
    if (!fid) throw new Error('loadDocument: file_id required');
    if (docCacheRef.current[fid]) return docCacheRef.current[fid];
    const res = await getDocumentBytes(params);
    if (docCacheRef.current[fid]) return docCacheRef.current[fid]; // carrera: ya creada
    const bytes = Uint8Array.from(atob(res.base64), c => c.charCodeAt(0));
    const url = URL.createObjectURL(new Blob([bytes], { type: res.mimeType || 'application/pdf' }));
    const entry = {
      url,
      // WEBKIT-COMPAT (log real de Diego, iPhone 20:32): pdf.js con `url:` hace fetch
      // del blob: y WebKit devuelve status 0 → "Unexpected server response (0)". El
      // visor recibe los BYTES directamente (entry.bytes); el url queda para "Abrir
      // documento". OJO: pdf.js TRANSFIERE el buffer al worker (lo desconecta) — el
      // visor debe pasarle SIEMPRE una COPIA (new Uint8Array(bytes)), nunca este.
      bytes,
      sha256:   res.sha256 || null,   // DOC-BYTES: tolera ausente hasta que aterrice server-side
      filename: res.filename || null,
      mimeType: res.mimeType || null,
    };
    docCacheRef.current = { ...docCacheRef.current, [fid]: entry };
    setDocCache(docCacheRef.current);
    log.info('[doc cache] object URL creado', { file8: log.sid(fid), has_sha256: !!entry.sha256 });
    return entry;
  }, []);

  /** Revoca TODOS los object URLs y vacía el cache (+ la capa de bytes de api.js).
   *  SOLO se llama al limpiar sesión o al desmontar el provider del wizard —
   *  nunca al salir de un step (STEP10-VIEWER). */
  const revokeDocumentCache = useCallback(() => {
    Object.values(docCacheRef.current).forEach(e => {
      try { URL.revokeObjectURL(e.url); } catch { /* ignore */ }
    });
    docCacheRef.current = {};
    setDocCache({});
    setSigningMembersRaw(null);
    setSigningSessionRaw(null); // WIZARD-UX TASK-1: el memo de estado de firma muere con la sesión
    purgeDocumentBytesCache();
  }, []);

  // Desmontar el wizard entero (cierre de la SPA) → liberar los blobs.
  useEffect(() => () => {
    Object.values(docCacheRef.current).forEach(e => {
      try { URL.revokeObjectURL(e.url); } catch { /* ignore */ }
    });
  }, []);

  // ── DL-B §1/§2 — capa de datos consolidada (hydrateSession) ──────────────────
  // `billingSplits`: el reparto YA GUARDADO viene EN la hidratación consolidada
  // (DL-A enr.wizardHydrate → billing_splits) → el Step 8 ya no hace una lectura
  // getSavedBillingSplits por-entrada (spec §1). `liveVersion`: la versión liveState
  // del grupo (cheap-poll Opción A §2); el poll ultra-ligero la compara y SOLO cuando
  // sube hace el fetch de detalle. Ambos NO persistidos (se rehidratan en cada entrada).
  const [billingSplits, setBillingSplits] = useState(null);
  const [liveVersion, setLiveVersion]     = useState(0);

  // ── REBUILD-8-11 (Diego 2026-06-11) — formularios de los pasos de firma 8-10 ──
  // El input del usuario de los pasos de firma (reparto del 8, consentimientos del 9,
  // aceptaciones por documento del 10) vive AQUÍ, en memoria, igual que stepData para
  // los pasos 1-7: la siembra desde servidor solo aplica si el usuario NO tocó nada
  // (slice ausente); una vez editado, su valor MANDA toda la sesión (el server no lo
  // pisa) y sobrevive a navegar 8↔9↔10↔11 (los componentes desmontan, el contexto no).
  // Tras un save OK, el paso estampa su `baseline` en el slice (espejo de markStepSaved).
  // KAL-7: NADA de esto se persiste en sessionStorage (cero secretos/PII fuera de
  // memoria); un F5 re-siembra desde servidor, que ya tiene lo guardado.
  //   { billing: {payers, perChild, childSplits, baseline?},
  //     gdpr:    {gen, img, v},
  //     review:  {accepted} }
  const [signingForms, setSigningFormsRaw] = useState({});
  const updateSigningForm = useCallback((key, valueOrFn) => {
    setSigningFormsRaw(prev => ({
      ...prev,
      [key]: typeof valueOrFn === 'function' ? valueOrFn(prev[key]) : valueOrFn,
    }));
  }, []);

  // ── DL-E39 — step-up re-auth state (NO persistido) ───────────────────────────
  // `stepUpVerifiedUntil`: timestamp (ms) hasta el que el step-up se considera
  // fresco. `lastActivityAt`: última interacción del usuario; tras 10 min sin
  // actividad el step-up vuelve a expirar aunque la ventana absoluta no haya
  // pasado. Ambos viven SOLO en memoria — un reload exige re-verificar (más
  // seguro: nunca se persiste evidencia de "puedo ver PII" en sessionStorage).
  const [stepUpVerifiedUntil, setStepUpVerifiedUntil] = useState(0);
  // ★ 2026-08-20 — CUÁL de los dos límites va a cerrar la sesión: 'INACTIVIDAD' (se puede
  // reiniciar quedándose) o 'TECHO' (las 2 h desde que se tecleó el código; no se puede
  // reiniciar con nada). Lo dice el SERVIDOR, resuelto — aquí no se deduce restando números:
  // el cliente no echa cuentas sobre la ventana, por lo mismo que `step_up_restante_s`.
  const [stepUpCierre, setStepUpCierre] = useState('INACTIVIDAD');
  const [lastActivityAt, setLastActivityAt] = useState(() => Date.now());

  // DL-E39 ENMIENDA (gate de ENTRADA, Diego 2026-06-06): el step-up deja de ser
  // per-campo (verificar-para-ver) y pasa a ser un GATE DE ACCESO al wizard. Una
  // sesión RECUPERADA por magic-link (resume_token → expediente con PII existente)
  // exige superar el gate OTP antes de mostrar NINGÚN paso. `recoveredViaMagicLink`
  // marca exactamente esas sesiones; un arranque nuevo (/apply sin PII todavía, la
  // familia teclea+verifica su email en sesión) NO se gatea con OTP de datos.
  // Se persiste para que un reload de una sesión recuperada siga exigiendo el gate
  // (el flag NO es PII ni secreto — solo dice "esta sesión cargó datos existentes").
  const [recoveredViaMagicLink, setRecoveredViaMagicLinkRaw] = useState(
    !!session.recoveredViaMagicLink
  );
  const setRecoveredViaMagicLink = useCallback((v) => {
    setRecoveredViaMagicLinkRaw(!!v);
    saveSession({ recoveredViaMagicLink: !!v });
  }, []);

  // OTP-TRIGGER (Diego 2026-06-07): marca "ya auto-enviamos el OTP de entrada UNA
  // vez para esta sesión recuperada". Persiste en sessionStorage → solo la PRIMERA
  // recuperación auto-envía el código (req. b); un reload de la sesión recuperada o
  // una re-expiración de frescura NO re-auto-envían (req. c — el usuario pulsa "enviar
  // código"). NO es PII ni secreto. Se resetea en clearSession (logout/clear/expiry).
  const [otpAutoSentForRecovery, setOtpAutoSentForRecoveryRaw] = useState(
    !!session.otpAutoSentForRecovery
  );
  const markOtpAutoSentForRecovery = useCallback(() => {
    setOtpAutoSentForRecoveryRaw(true);
    saveSession({ otpAutoSentForRecovery: true });
  }, []);

  // Tick reactivo: fuerza re-render periódico para que el gate de entrada vuelva
  // a aparecer cuando expira la frescura por inactividad (isStepUpFresh() es una
  // función pura que lee Date.now(), pero sin un cambio de estado React no se
  // re-evalúa). El ticker corre cada 30s; barato y suficiente (la ventana es 10min).
  const [, setFreshnessTick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => setFreshnessTick(n => n + 1), 30 * 1000);
    return () => clearInterval(id);
  }, []);

  // ── LA ACTIVIDAD REAL REINICIA EL CONTADOR (Diego, 2026-08-20) ─────────────────
  // «Cada acción del usuario debe reiniciar el contador de 10 minutos». Un clic, una
  // tecla o un cambio de paso pasan por aquí.
  //
  // Y lo hace PIDIÉNDOSELO AL SERVIDOR, no estirando el espejo local: quien manda sigue
  // siendo la marca server-side, y el cliente solo refleja lo que le contestan. Estirar
  // el espejo por su cuenta es justo lo que producía el candado stale de #30 (la UI
  // desbloqueada más allá de lo que el backend honra).
  //
  // ⛔ NO LO LLAMA NINGÚN TEMPORIZADOR. Ni el pulso de admisión, ni el ticker de
  // frescura, ni un `setInterval`: eso sería SEC-STEPUP (#55) otra vez —una pestaña
  // abandonada sin nadie delante quedándose viva—. Solo eventos de una persona.
  //
  // FRENO de un minuto: sin él habría una llamada por pulsación. Un minuto es
  // holgadísimo frente a los 10 de la ventana (quien está activo la reinicia ocho veces
  // antes de que el aviso llegue a salir).
  //
  // ⛔ CON LA EXCEPCIÓN QUE LO HACE ÚTIL: dentro de la zona de aviso (los últimos dos
  // minutos) NO se frena nada. Es justo cuando la familia está diciendo «sigo aquí», y
  // tragarse ESA pulsación por un freno la echaría de su solicitud teniendo la mano en la
  // pantalla. Fuera de esa zona, el freno vale y no se nota; dentro, cada gesto cuenta —
  // y son a lo sumo un par de llamadas, porque la primera devuelve la ventana entera.
  const ultimoRefresco = useRef(0);
  const refrescandoVentana = useRef(false);
  // Espejos síncronos de lo que necesita el refresco. Se usan refs (y no las variables de
  // estado) para que `touchActivity` sea ESTABLE: se lo pasan por props unas cuantas
  // pantallas, y re-crearlo en cada cambio de estado remontaría sus manejadores.
  const resumeTokenRef = useRef(null);
  const stepUpVerifiedUntilRef = useRef(0);
  const recoveryNonceRef = useRef(null);
  const recoveredEmailRef = useRef(null);
  const touchActivity = useCallback(() => {
    const ahora = Date.now();
    setLastActivityAt(ahora);
    if (!resumeTokenRef.current) return;
    // Sin ventana viva no hay nada que reiniciar: la puerta ya está cerrada y quien
    // manda es el código. Pedir un refresco aquí solo sería una llamada a un rechazo.
    if (!(stepUpVerifiedUntilRef.current && ahora < stepUpVerifiedUntilRef.current)) return;
    if (refrescandoVentana.current) return;
    const restanteS = Math.round((stepUpVerifiedUntilRef.current - ahora) / 1000);
    if (restanteS > REFRESCO_UMBRAL_S) return;      // sobra ventana: no hay nada que reiniciar
    const enZonaDeAviso = restanteS <= AVISO_ANTES_S;
    if (!enZonaDeAviso && ahora - ultimoRefresco.current < REFRESCO_MINIMO_MS) return;
    ultimoRefresco.current = ahora;
    refrescandoVentana.current = true;
    refrescarVentana(resumeTokenRef.current, {
      n: recoveryNonceRef.current, recoveredEmail: recoveredEmailRef.current,
    })
      .then((r) => {
        const s = Number(r && r.step_up_restante_s) || 0;
        setStepUpVerifiedUntil(Date.now() + (s > 0 ? s * 1000 : STEPUP_WINDOW_MS));
        if (r && r.step_up_cierre) setStepUpCierre(r.step_up_cierre);
      })
      .catch((e) => {
        // El servidor dice que ya no hay ventana que estirar → se re-sincroniza el
        // espejo a «caducado» y el gate de entrada se cierra para TODA la UI, en vez de
        // dejar una pantalla abierta que el siguiente guardado va a rechazar igual.
        if (/STEPUP_REQUIRED/.test(String((e && (e.code || e.message)) || ''))) {
          setStepUpVerifiedUntil(0);
          log.warn('step-up: la ventana ya no se puede reiniciar — hace falta el código');
        }
        // Cualquier otro fallo (red, servidor caído) NO toca el espejo: un corte de red
        // no es motivo para echar a nadie de su solicitud.
      })
      .finally(() => { refrescandoVentana.current = false; });
  }, []);

  // Tras un verifyEmail({stepup:true}) OK → step-up fresco durante 10 min.
  //
  // 2026-08-20 — EL TIEMPO QUE QUEDA LO MANDA QUIEN LO SABE. Si el servidor reporta
  // `step_up_restante_s`, se usa ESE; los 10 min locales son solo el respaldo para una
  // respuesta que aún no lo traiga. Antes el cliente echaba su propia cuenta y divergía
  // de la del servidor (es el defecto que #30 documentó: tras un F5 a mitad de ventana
  // el espejo local sobrevivía más que la marca real). Y el aviso de los dos minutos se
  // pinta sobre este número, así que tiene que ser el de verdad, no una estimación.
  const markStepUpFresh = useCallback((restanteS, cierre) => {
    const now = Date.now();
    const ms = (Number(restanteS) > 0) ? Number(restanteS) * 1000 : STEPUP_WINDOW_MS;
    setStepUpVerifiedUntil(now + ms);
    setStepUpCierre(cierre || 'INACTIVIDAD');
    setLastActivityAt(now);
    log.success(`step-up: verificación fresca registrada (${Math.round(ms / 1000)} s)`);
  }, []);

  // #30 (lock proactivo, post-#55): revoca el espejo LOCAL de frescura. El servidor es
  // la verdad de la ventana DURA; el cliente solo conoce el booleano `step_up_fresh`
  // (sin remaining_s), así que tras un F5 a mitad de ventana el espejo local puede
  // sobrevivir más que la marca server-side. Cuando el servidor rechaza con
  // STEPUP_REQUIRED, esto re-sincroniza el espejo a "expirado" → el ticker de 30s
  // re-renderiza y el gate de entrada (mustPassEntryGate) se cierra para TODA la UI
  // PII, no solo para el save que falló. NUNCA extiende — solo revoca (anti-sliding).
  const revokeStepUpFresh = useCallback(() => {
    setStepUpVerifiedUntil(prev => {
      if (!prev) return prev;              // ya revocada: ni re-render ni registro de más
      log.warn('step-up: frescura revocada (el servidor la rechazó, o se agotó la cuenta atrás)');
      return 0;
    });
  }, []);

  // True si el step-up sigue fresco. ★ SEC-STEPUP: ventana DURA (no deslizante):
  // `stepUpVerifiedUntil` se fija una sola vez en markStepUpFresh (OTP/gracia) y
  // caduca a los 10 min sin extensión por uso — espejo EXACTO del servidor. Función
  // pura (lee Date.now()). El gate de entrada (WizardPage) deriva su candado de esto,
  // que a su vez se siembra SOLO del `step_up_fresh` que el servidor reporta.
  const isStepUpFresh = useCallback(() => {
    const now = Date.now();
    return !!stepUpVerifiedUntil && now < stepUpVerifiedUntil;
  }, [stepUpVerifiedUntil]);

  const [recoveredEmail, setRecoveredEmailRaw] = useState(session.recoveredEmail || null);
  const setRecoveredEmail = useCallback((e) => {
    const v = e ? String(e).toLowerCase().trim() : null;
    setRecoveredEmailRaw(v);
    saveSession({ recoveredEmail: v });
  }, []);

  // IDENTITY-FROM-LINK (2026-06-11): `recoveryNonce` = el `n` del magic link (email_id del
  // guardian, opaco). Es la VÍA CANÓNICA de identidad: la identidad viaja en el enlace, no
  // en el cliente. Se persiste en sessionStorage para SOBREVIVIR a F5/incógnito (tras la
  // limpieza KAL-7 de la URL, `n` ya no está en la barra → debe vivir en sessionStorage).
  // NO es un secreto bearer (no autoriza nada por sí solo; el backend lo valida contra el
  // grupo del resume_token, KAL-4/5). El frontend lo reenvía en hydrate + actos de firma.
  const [recoveryNonce, setRecoveryNonceRaw] = useState(session.recoveryNonce || null);
  const setRecoveryNonce = useCallback((n) => {
    const v = n ? String(n).trim() : null;
    setRecoveryNonceRaw(v);
    saveSession({ recoveryNonce: v });
  }, []);

  // ⭐ 0º.vicies.sexies (Diego, 2026-08-21) — LA FORMA DE PAGO MARCADA EN EL PASO 7 VIVE
  // SOLO EN EL NAVEGADOR. Cita literal: *«Se supone que la presentación de pagos es
  // meramente informativa. Ni siquiera va a ir en la hoja de resumen… Se puede guardar en
  // la memoria del navegador, pero ya está.»* Las tarjetas de «¿Cómo quedarían las cuotas?»
  // son un VISOR para comparar, no un formulario que deje constancia: la elección EN FIRME
  // es la del paso 8 (`enr.wizardApplyModality`, sobre la suscripción borrador), que es la
  // que se aplica y se firma — y ésa NO se toca.
  //
  // Es `{ [template_id]: modality_id }`: un solicitante puede tener varios planes a la vez
  // (cuota + comedor + permanencia) y cada uno lleva la suya.
  //
  // Se persiste con el MISMO mecanismo de sesión que el resto del estado del asistente
  // (`saveSession`, molde verbatim de `recoveryNonce` justo arriba) para que un F5 no borre
  // la marca. ⚠️ Degrada sin romper: si el navegador no deja escribir (modo privado,
  // almacenamiento bloqueado), `saveSession` se lo traga y la marca simplemente no
  // sobrevive al F5 — NUNCA un error delante de la familia. No hay ni un viaje al servidor.
  const [formaDePagoMarcada, setFormaDePagoMarcadaRaw] = useState(session.formaDePagoMarcada || {});
  const setFormaDePagoMarcada = useCallback((templateId, modalityId) => {
    if (!templateId || !modalityId) return;
    setFormaDePagoMarcadaRaw(prev => {
      const next = { ...(prev || {}), [templateId]: modalityId };
      saveSession({ formaDePagoMarcada: next });
      return next;
    });
  }, []);

  // Espejos síncronos para `touchActivity` (ver su declaración): un solo sitio los pone
  // al día, para que no puedan divergir de las variables de estado que reflejan.
  useEffect(() => { resumeTokenRef.current = resumeToken; }, [resumeToken]);
  useEffect(() => { stepUpVerifiedUntilRef.current = stepUpVerifiedUntil; }, [stepUpVerifiedUntil]);
  useEffect(() => { recoveryNonceRef.current = recoveryNonce; }, [recoveryNonce]);
  useEffect(() => { recoveredEmailRef.current = recoveredEmail; }, [recoveredEmail]);

  // ── LA ACTIVIDAD, ESCUCHADA DE UNA VEZ Y EN TODA LA APLICACIÓN ─────────────────
  // Diego: «clic, pasando de pantallas, etc.». Antes solo contaba el clic DENTRO del
  // contenido de algunos pasos (`StepShell`, Step2, Step4, Step6), así que teclear en un
  // campo, pulsar «Siguiente» o moverse por la cabecera no reiniciaba nada. Se escucha en
  // el documento, en fase de captura, y de forma pasiva: no interfiere con ningún gesto.
  //
  // ⛔ Los eventos son de una PERSONA a propósito (clic, tecla, gesto táctil). Nada de
  // temporizadores, `visibilitychange` ni `focus`: una pestaña que vuelve al primer plano
  // sola no es actividad, y contarla sería SEC-STEPUP (#55) por la puerta de atrás.
  useEffect(() => {
    const eventos = ['pointerdown', 'keydown'];
    const oyente = () => touchActivity();
    eventos.forEach(e => document.addEventListener(e, oyente, { capture: true, passive: true }));
    return () => eventos.forEach(e => document.removeEventListener(e, oyente, { capture: true }));
  }, [touchActivity]);

  // D-E18: recognition result from initEnrollmentSession. Survives reloads via
  // sessionStorage so Step2 can show the "we recognised your family" banner
  // even after the family resumes from magic link.
  const [recognition, setRecognitionRaw] = useState(
    session.recognition || { matched: false, persons: [] }
  );

  const setRecognition = useCallback((r) => {
    const safe = (r && typeof r === 'object') ? r : { matched: false, persons: [] };
    setRecognitionRaw(safe);
    saveSession({ recognition: safe });
  }, []);

  const setEnrollmentGroupId = useCallback((id) => {
    setEnrollmentGroupIdRaw(id);
    saveSession({ enrollmentGroupId: id });
  }, []);
  const setResumeToken = useCallback((tok) => {
    setResumeTokenRaw(tok);
    saveSession({ resumeToken: tok });
  }, []);
  const setCurrentStep = useCallback((step) => {
    log.info('[DBG nav] setCurrentStep', { step });   // DBG-SESSION: rastro de TODA navegación/salto
    setCurrentStepRaw(step);
    saveSession({ currentStep: step });
  }, []);

  // Clear session when enrollment group is submitted
  const clearSession = useCallback(() => {
    try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
    setEnrollmentGroupIdRaw(null);
    setResumeTokenRaw(null);
    setCurrentStepRaw(0);
    setStepData(initialStepData);
    setRecognitionRaw({ matched: false, persons: [] });
    setCompletedStepsRaw(new Set());
    setSavedBaseline(initialStepData);
    setIsSubmittedRaw(false);
    setAdmissionState(null);
    setSigningContext(null);
    setRecoveredEmailRaw(null);
    setRecoveryNonceRaw(null);
    setStepUpVerifiedUntil(0);
    setLastActivityAt(Date.now());
    setRecoveredViaMagicLinkRaw(false);
    setOtpAutoSentForRecoveryRaw(false);
    setSigningFormsRaw({}); // REBUILD-8-11: el input de firma muere con la sesión
    // WIZARD-PERF-CACHE-SKELETON: el catálogo cacheado de preguntas NUNCA debe
    // sobrevivir al ciclo de auth — purgar al limpiar sesión (logout/clear/expiry).
    purgeQuestionsCache();
    // STEP10-VIEWER: revocar los object URLs del paquete contractual + purgar la capa
    // de bytes. Es el ÚNICO punto (junto con el unmount del provider) donde se revoca.
    revokeDocumentCache();
  }, [revokeDocumentCache]);

  /**
   * True if the step's current data differs from what was last saved to the
   * backend (or last hydrated from a resume). Used by WizardPage.handleNext
   * to skip redundant saveStep round-trips when the user clicks Next without
   * changing anything.
   *
   * Implementation: deep equality via JSON.stringify. Sufficient for the
   * step data shapes (plain objects, arrays of plain objects, primitives —
   * no Dates / functions / Symbols). On parse-equal-but-encode-different
   * edge cases (e.g. property reordering during normalisation) the dirty
   * check returns TRUE, which is a false positive — benign, we just do
   * an unnecessary save. Worst case is the current behaviour.
   */
  // `data` is optional: if provided, compare it directly against the baseline
  // (avoids the React batching problem where updateStep() and onNext() are called
  // in the same tick — the state update hasn't committed yet, so stepData[stepKey]
  // would still be stale). Callers that have the fresh data should always pass it.
  const isStepDirty = useCallback((stepKey, data) => {
    try {
      const cur  = data !== undefined ? data : stepData[stepKey];
      const base = savedBaseline[stepKey];
      const curStr  = JSON.stringify(cur);
      const baseStr = JSON.stringify(base);
      if (curStr !== baseStr) {
        // ── Debug: find and log ALL field differences ──────────────────────────
        if (Array.isArray(cur) && Array.isArray(base)) {
          const diffs = [];
          for (let i = 0; i < Math.max(cur.length, base.length); i++) {
            const a = cur[i], b = base[i];
            if (JSON.stringify(a) !== JSON.stringify(b)) {
              const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
              for (const k of keys) {
                if (JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k])) {
                  diffs.push({ idx: i, key: k, cur: a?.[k], base: b?.[k] });
                }
              }
            }
          }
          log.warn(`[dirty] step=${stepKey} (array, ${diffs.length} diff(s))`, {
            diffs,
            cur_length: cur.length,
            base_length: base.length,
            cur_full: cur,
            base_full: base,
          });
        } else if (cur && base && typeof cur === 'object' && !Array.isArray(cur) && typeof base === 'object' && !Array.isArray(base)) {
          const keys = new Set([...Object.keys(cur), ...Object.keys(base)]);
          const diffs = {};
          for (const k of keys) {
            if (JSON.stringify(cur[k]) !== JSON.stringify(base[k])) {
              diffs[k] = { cur: cur[k], base: base[k] };
            }
          }
          log.warn(`[dirty] step=${stepKey} (object, ${Object.keys(diffs).length} diff(s))`, {
            diffs,
            cur_full: cur,
            base_full: base,
          });
        } else {
          log.warn(`[dirty] step=${stepKey} type/value mismatch`, {
            cur_type: typeof cur, cur_isArray: Array.isArray(cur), cur_full: cur,
            base_type: typeof base, base_isArray: Array.isArray(base), base_full: base,
          });
        }
        return true;
      }
      log.debug(`[clean] step=${stepKey} — not dirty, skip save`);
      return false;
    } catch (e) {
      log.error(`isStepDirty: exception for step=${stepKey}`, { message: e.message });
      return true; // err on the side of saving
    }
  }, [stepData, savedBaseline]);

  /**
   * Stamps `savedData` into the saved-baseline for `stepKey` so the next
   * isStepDirty() call returns false. Call this AFTER a successful saveStep
   * round-trip, passing the exact data that was sent to the backend.
   *
   * Do NOT read from stepData[stepKey] here — the save is async and
   * markStepSaved is captured in a closure at save-launch time. By the time
   * the await resolves, stepData may have advanced via updateStep() batching,
   * so stepData[stepKey] would be stale relative to what was actually saved.
   */
  const markStepSaved = useCallback((stepKey, savedData) => {
    log.success(`markStepSaved: ${stepKey}`, savedData);
    setSavedBaseline(prev => ({ ...prev, [stepKey]: savedData }));
  }, []);

  const updateStep = useCallback((stepKey, data) => {
    log.debug(`updateStep: ${stepKey}`, data);
    setStepData(prev => ({ ...prev, [stepKey]: data }));
  }, []);

  const hydrateFromResume = useCallback((data) => {
    // Post-DL-E15 shape: { group, enrollments[], persons[], relations[], ... }
    // Legacy shape (transitional): { application, persons[], relations[], ... }
    const group = data.group || data.application;
    setEnrollmentGroupId(group.enrollment_group_id || group.application_id);
    setResumeToken(group.resume_token);
    // DL-E39 gate de entrada: esta sesión cargó PII existente (recuperación por
    // magic-link, o rehidratación tras reload de una sesión ya recuperada). Marca
    // que el wizard debe quedar tras el gate OTP hasta que se verifique un código
    // fresco. NO marcamos step-up fresco aquí — el gate se muestra precisamente
    // porque isStepUpFresh() es false al recuperar.
    setRecoveredViaMagicLink(true);
    // Magic-link grace (UX): si el backend consumió un nonce single-use válido (<10
    // min del envío), devuelve step_up_fresh=true → el inbox ya está probado por ESE
    // envío, así que NO exigimos OTP: marcamos step-up fresco (pasa el gate de
    // entrada) y marcamos el auto-send como ya hecho (no dispares el OTP proactivo).
    // Si step_up_fresh es false (link >10 min, reusado, sin nonce, o filtrado/KAL-7),
    // NO tocamos nada → el gate OTP normal se aplica.
    // WIZARD-GATE-ORDER (diagnóstico, 2026-06-09): registra SIEMPRE el valor recibido
    // de step_up_fresh (incluido false) para verificar en el DevLogger si la frescura
    // (B) vuelve true dentro de los 10 min. Solo log, no cambia ninguna rama de lógica.
    log.info('hydrateFromResume: step_up_fresh recibido', { step_up_fresh: !!data.step_up_fresh });
    if (data.step_up_fresh) {
      markStepUpFresh(data.step_up_restante_s, data.step_up_cierre);
      markOtpAutoSentForRecovery();
      log.info('hydrateFromResume: magic-link grace activa (nonce válido <10min) — sin OTP');
    }

    // WIZARD-GATES BUG 1 — aterrizaje con esqueleto PII-gated.
    // Cuando el backend devuelve pii_gated:true + step_up_fresh:false, los datos de
    // personas/relaciones/admission vienen VACÍOS (skeleton). Si procesáramos el landing
    // aquí, computaríamos submitted=false + target=1 con datos fantasma, aterrizando en
    // el Step 1 con el wizard vacío ANTES del gate OTP. El estado mínimo ya está listo
    // (enrollmentGroupId + resumeToken + recoveredViaMagicLink=true) para que el
    // StepUpGate de WizardPage funcione. El aterrizaje REAL ocurre en el re-hydrate
    // post-OTP donde los datos son completos. Salir aquí sin tomar ninguna decisión
    // de landing ni de stepData.
    if (data.pii_gated && !data.step_up_fresh) {
      log.info('hydrateFromResume: pii_gated=true — skip landing, esperando OTP', { pii_gated: true });
      return;
    }
    // The magic link token itself proves email ownership — treat as verified regardless
    // of the email_confirmed DB flag (which may lag or not have been written yet).
    const persons   = data.persons   || [];
    // The backend always inserts 2 rows per relation pair (forward + inverse).
    // Step3Relations only knows and produces 1 row per pair, so we must
    // deduplicate here to keep the savedBaseline in the same shape as what
    // handleNext sends via onNext. Deduplicate by pair_id, preferring the row
    // whose from_person_id matches a guardian so the semantic direction is right.
    const guardianIds = new Set(persons.filter(p => p.person_type_id === 'guardian').map(p => p.person_id));
    const relationsRaw = data.relations || [];
    const relByPair = {};
    relationsRaw.forEach(r => {
      // pair_id groups forward+inverse rows for the same pair. If pair_id is null
      // (rows created before pair_id was introduced), fall back to a canonical key
      // derived from both person IDs sorted — guarantees forward and inverse always
      // collapse to the same entry regardless of which direction was stored first.
      const key = r.pair_id || [r.from_person_id, r.to_person_id].sort().join('__');
      if (!relByPair[key]) {
        relByPair[key] = r;
      } else {
        // Prefer the row whose from_person_id is a guardian
        if (guardianIds.has(r.from_person_id) && !guardianIds.has(relByPair[key].from_person_id)) {
          relByPair[key] = r;
        }
      }
    });
    // Strip AppSheet system column _RowNumber (changes between API calls, has no
    // semantic meaning for the enrollment data). Without stripping, the dirty check
    // always returns true for relations because _RowNumber in the baseline (set at
    // resume time) can differ from the row reference Step3 finds in existing data.
    // Sort by relation_id so the baseline order is deterministic regardless of the
    // AppSheet API response order, which may differ from Step3's buildInitialRelations
    // output order (guardians × applicants from persons array).
    // Also filter to only relations where BOTH persons exist in the current persons
    // list — ghost persons from previous sessions (deleted/replaced) inflate the
    // baseline count vs what buildInitialRelations produces, causing a permanent
    // false-positive dirty check on every resume.
    const personIds = new Set(persons.map(p => p.person_id).filter(Boolean));
    // eslint-disable-next-line no-unused-vars
    const relations = Object.values(relByPair)
      .filter(r => {
        const fromId = r.from_person_id || r.guardian_person_id;
        const toId   = r.to_person_id   || r.applicant_person_id;
        return personIds.has(fromId) && personIds.has(toId);
      })
      .map(({ _RowNumber, ...r }) => r)
      .sort((a, b) => (a.relation_id || '').localeCompare(b.relation_id || ''));
    // Backend returns qbResponses as `responses`; recFiles as `documents`.
    const responsesRaw = data.responses || [];
    // Step5Questions tracks responses as a dict { "${question_id}__${respondent_id}": responseText }
    // while the backend stores/returns them as an array. Normalize here so savedBaseline.questions
    // matches the shape Step5 sends via onNext — preventing a permanent false-positive dirty check.
    const responsesDict = {};
    responsesRaw.forEach(r => {
      if (r.question_id) responsesDict[`${r.question_id}__${r.respondent_id || ''}`] = r.response_text || '';
    });
    const documents = data.documents || [];
    const hydrated = {
      email: {
        primary_email:      group.primary_email      || '',
        verified:           true,
        // group.desired_start_date is ISO (normalizeDate_ applied in resumeSession_).
        // Seeding here lets Step7Review display the date correctly on resume, and
        // ensures startType detection in Step1Email ('YYYY-09-01'.slice(5,10)==='09-01')
        // works without requiring the family to re-enter the date.
        desired_start_date: group.desired_start_date || '',
        // program_id is NOT stored here — Step1Email initialises selectedProgramId
        // via useState('') and the useEffect auto-selects the single program from
        // fetchLookups(). savedBaseline.application.program_id (seeded below) is
        // what isStepDirty compares against, and that is already correct.
      },
      application: {
        // desired_start_date is staged to enrEnrollmentGroups at saveStep time
        // (backend normalizeDate_ → ISO). resumeSession_ also returns it as ISO
        // via group.desired_start_date. fetchLookups now returns period_starts_on
        // in ISO too, so effectiveDate from Step1Email will always be ISO → match.
        desired_start_date: group.desired_start_date || '',
        program_id:         group.program_id         || '',
      },
      // P89 — normalize Y/N booleans to native booleans so savedBaseline matches
      // the shape that preparePersonForUI (Step2) and buildInitialRelations (Step3)
      // produce. Without this, isStepDirty sees false !== "Y" on every navigation
      // and fires spurious saveStep calls even when nothing changed.
      // Fix saves espurios (Diego 2026-06-12): sembrar con la MISMA forma que el
      // Step 2 produce (preparePersonForUI — flats de nationality/id, _record_ids,
      // alias email/phone, booleanos) → stepData y baseline idénticos → el
      // dirty-check solo dispara con EDICIONES reales. Subsume el normYN parcial
      // previo (que arreglaba esta misma clase solo para booleanos).
      persons: preparePersonsForUI(persons),
      relations: relations.map(r => ({
        ...r,
        is_custodial:            normYN(r.is_custodial),
        is_pick_up_authorized:   normYN(r.is_pick_up_authorized),
        is_school_rep:           r.is_school_rep           !== undefined ? normYN(r.is_school_rep)           : r.is_school_rep,
        is_emergency_contact:    r.is_emergency_contact    !== undefined ? normYN(r.is_emergency_contact)    : r.is_emergency_contact,
      })),
      health: persons.filter(p => p.person_type_id === 'applicant').map(p => ({
        person_id: p.person_id,
        allergies: p.allergies || [],
        dietary:   p.dietary   || [],
        medical:   p.medical   || [],
      })),
      // NEAE staging (Paso 4 "Salud y apoyo"). Espejo de la hidratación de salud:
      // el backend adjunta `neae` (condiciones) + `neae_support` (apoyos) a cada
      // applicant. Degrada a [] si las tablas staging aún no existen.
      neae: persons.filter(p => p.person_type_id === 'applicant').map(p => ({
        person_id:  p.person_id,
        conditions: p.neae         || [],
        supports:   p.neae_support || [],
      })),
      questions: responsesDict,
      documents,
      // DL-E49 §2/§3 — `persons` ya viene recortado por el servidor a "yo + los
      // menores" (nunca el otro tutor). Este número es la ÚNICA señal que sale del
      // recorte: cuántos tutores tiene REALMENTE el expediente — para que la
      // pantalla de "tutor único" (§3) no confunda "solo veo 1" con "solo hay 1".
      guardians_total_count: data.guardians_total_count,
    };
    log.info('hydrateFromResume: seeding stepData + savedBaseline', {
      enrollmentGroupId: group.enrollment_group_id || group.application_id,
      persons_count: persons.length,
      relations_count: relations.length,
      health_count: hydrated.health?.length,
      questions_count: Object.keys(hydrated.questions || {}).length,
      documents_count: hydrated.documents?.length,
      application: hydrated.application,
      persons_ids: persons.map(p => ({ person_id: p.person_id, type: p.person_type_id })),
      relations_full: relations,
      persons_full: persons,
    });
    setStepData(prev => ({ ...prev, ...hydrated }));
    // Seed the saved baseline with the freshly-loaded data so isStepDirty()
    // correctly reports false for steps the user hasn't touched after resume.
    // Without this seed, every Next click after a resume would re-save even
    // when nothing changed.
    setSavedBaseline(prev => ({ ...prev, ...hydrated }));

    // ── Step-completion inference ───────────────────────────────────────────
    // Marks every step the family has visibly passed through, then jumps to
    // the deepest one with data so they land where they left off (with prior
    // steps locked for the LockedBanner unlock-to-edit pattern). Submitted
    // sessions always go straight to Review (step 6).
    //
    // URGENT-PASS3 BUG A (2026-06-11): "enviada" deriva del ESTADO REAL, NO de
    // submitted_at. Diego promovió el expediente borrador→RQ→PS→RS→AD desde el KMS,
    // pero submitted_at quedó vacío (las transiciones staff nunca lo reponen) → el
    // wizard creía DRAFT y pedía RE-ENVIAR en pleno AD. El backend ya resuelve la
    // editabilidad real del estado en `admission.editable` (state ∈ {DRAFT,IN,
    // NEEDS_MORE_INFO} ⟺ editable; resto ⟺ enviada/locked). Cuando hay estado real,
    // GOBIERNA `admission.editable`; sin estado (pre-submit puro), fallback al
    // submitted_at histórico. POST-W2: el avance/edición los gobierna el estado.
    const admRaw = data.admission || null;
    // WIZARD-GATES BUG 2 + WIZ-FINAL-GATE — normalización de signing_ready.
    const adm = normalizeAdmission_(admRaw);
    // WIZ-FINAL-GATE: el guardian que el backend resolvió server-side para esta
    // recuperación (enr_wizardHydrate.recovered_guardian_person_id, top-level). Lo
    // estampamos en el bloque admission para que el banner rojo "confirma tu email"
    // SOLO aparezca cuando NO hay identidad de guardian (ni contexto ni guardian
    // resuelto), nunca cuando el guardian sí se resolvió. NO es PII sensible (un id).
    if (adm && data.recovered_guardian_person_id != null) {
      adm.recovered_guardian_person_id = data.recovered_guardian_person_id;
    }
    const hasRealState = !!(adm && adm.state_code);
    const submitted = hasRealState
      ? (adm.editable === false)        // estado real: locked ⟺ no editable
      : !!group.submitted_at;           // pre-submit puro: fallback histórico
    setIsSubmitted(submitted);

    // P216: store the real admission state + per-guardian signing context the
    // backend resolved (additive block). Re-fetched on every resume → React
    // state only. The Step 7 banner reads admissionState.state_label; the
    // "continue to sign" advance reads signingContext (Phase 3).
    setAdmissionState(adm);
    setSigningContext(adm && adm.signing_context ? adm.signing_context : null);

    // ── DL-B §1/§2 — extras de la hidratación consolidada (hydrateSession) ──────
    // Catálogos: sembrar la caché de api.js → Step3/Step4/Step7 resuelven lookups
    // desde memoria sin fetch por-entrada. Billing splits: guardar para que el Step 8
    // rehidrate el reparto sin una lectura getSavedBillingSplits aparte. live_version:
    // baseline del cheap-poll (Opción A): el poll ligero solo refresca cuando sube.
    // 2026-08-19 — con el IDIOMA, mismo molde que `primeQuestions` dos líneas más abajo:
    // parte de estos catálogos ya depende del idioma (los tipos de documento del paso 6). El
    // sello que manda es el que trae la propia respuesta (`recTypesLocale`); esto es solo el
    // respaldo, y es el MISMO idioma con el que se pidió la hidratación (`language:
    // i18n.language`, `WizardPage.jsx` / `ResumePage.jsx`).
    if (data.lookups) primeLookups(data.lookups, i18n.language);
    // DL-C-B (g): el catálogo de preguntas viene plegado en el hydrate (DL-C-A) →
    // sembramos la cache (mismo patrón que primeLookups) bajo el locale UI actual.
    // Step5/Step7 lo resuelven de cache sin la llamada fetchQuestions suelta (~42s).
    if (data.questions) primeQuestions(i18n.language, data.questions);
    if (data.billing_splits) setBillingSplits(data.billing_splits);
    // GDPR-REHYDRATE (Diego 2026-06-11: "recupera el usuario pero no carga lo que había
    // guardado en los consentimientos"): el hydrate trae el set guardado del firmante
    // (sysConsentsLog → {gen, img, v}). Siembra SOLO si el usuario no tocó el slice en
    // esta sesión (sus ediciones mandan — regla REBUILD-8-11). Step9 valida v contra
    // SIGNING_CONSENT_TEXT_VERSION (texto legal nuevo → re-consentir, intencional).
    if (data.gdpr_consents && data.gdpr_consents.v) {
      setSigningFormsRaw(prev => (prev && prev.gdpr) ? prev : { ...(prev || {}), gdpr: data.gdpr_consents });
    }
    // Lock por hito durable (Diego 2026-06-12): si el server reporta REVIEW_CONFIRMED,
    // sincroniza el flag local (y su copia en sessionStorage) — el candado no depende
    // de la vida del componente ni de la navegación 7↔8.
    try {
      const stRD = data.admission && data.admission.signing_context && data.admission.signing_context.steps;
      if (stRD && stRD.review_completed) setReviewConfirmedLocal(true);
    } catch (eRD) { /* best-effort */ }
    // DL-E44 §2: las aceptaciones por documento del Step 10 rehidratan desde la
    // evidencia DURABLE del hito REVIEW_CONFIRMED (per-guardian, accepted[] del
    // hydrate) — nunca se re-piden. Mismo patrón que gdpr: siembra solo si el
    // usuario no tocó el slice review en esta sesión.
    if (Array.isArray(data.review_acceptances) && data.review_acceptances.length) {
      const acceptedMap = {};
      data.review_acceptances.forEach(a => { if (a && a.file_id) acceptedMap[a.file_id] = true; });
      setSigningFormsRaw(prev => (prev && prev.review) ? prev : { ...(prev || {}), review: { accepted: acceptedMap } });
    }
    if (data.live_version != null) setLiveVersion(Number(data.live_version) || 0);

    const hasGuardians     = persons.some(p => p.person_type_id === 'guardian');
    const hasApplicants    = persons.some(p => p.person_type_id === 'applicant');
    // desired_start_date lives on enrEnrollments (not the group row), so check
    // the first enrollment's date; fall back to group field for legacy sessions.
    const hasStartDate     = !!(data.enrollments?.[0]?.desired_start_date) || !!group.desired_start_date;
    const hasRelations     = relations.length > 0;
    // Step 3 (health), 4 (questions), 5 (documents) are visited even if the
    // family had nothing to declare. Best proxies we have without an explicit
    // current_step pointer on the group: persons exist → step 3 visited;
    // explicit response/document rows for higher steps.
    const visitedHealth    = hasGuardians && hasApplicants && hasRelations;
    const visitedQuestions = responsesRaw.length > 0;
    const visitedDocuments = documents.length > 0;

    const completed = new Set();
    if (hasStartDate)                       completed.add(0);
    if (hasGuardians && hasApplicants)      completed.add(1);
    if (hasRelations)                       completed.add(2);
    if (visitedHealth)                      completed.add(3);
    if (visitedQuestions)                   completed.add(4);
    if (visitedDocuments)                   completed.add(5);
    if (submitted) [0,1,2,3,4,5,6].forEach(i => completed.add(i));
    setCompletedStepsRaw(completed);
    saveSession({ completedSteps: [...completed] });

    // ── DBG-SESSION: resumen compacto de hidratación (prefijos 8 chars, sin PII) ──
    log.info('[DBG hydrate]', {
      submitted,
      completed: [...completed],
      applicants: persons.filter(p => p.person_type_id === 'applicant').length,
      guardians:  persons.filter(p => p.person_type_id === 'guardian').length,
      relations:  relations.length,
      responses_n: Object.keys(responsesDict).length,
      response_keys: Object.keys(responsesDict).map(k => k.split('__').map(x => log.sid(x)).join('__')),
      documents: documents.length,
      admission: adm ? {
        state_code:      adm.state_code,
        signing_ready:   adm.signing_ready,
        signing_status:  adm.signing_status,
        has_signing_ctx: !!adm.signing_context,
        steps:           adm.signing_context && adm.signing_context.steps,
      } : null,
    });

    // Land on the first incomplete step, or Review if everything's filled.
    // Submitted sessions land on Step 7 Review (index 6) — read-only view of what
    // was sent. The post-AD steps 8-11 (indices 7-10) stay locked until admisión
    // decisión flips them open (future feature; backend not implemented yet — CLI 59).
    if (submitted) {
      // WPERF-1 criterio 5: no hardcodear Review. Si el expediente está Aprobado (AD)
      // y la firma está EN CURSO (sesión lista para este guardian, no completada, con
      // sub-pasos), aterriza en el primer sub-paso de firma INCOMPLETO (Steps 8-11 =
      // índices 7-10) — derivado de admission.signing_context.steps — en vez de dejar a
      // la familia en Review sin pista de que debe firmar. En cualquier otro caso, Review (6).
      const STEP_FIRST_SIGNING = 7;
      const st = adm && adm.signing_context && adm.signing_context.steps;
      // DL-E44 (2026-06-12, log real de Diego 14:12Z): el avance lo gobiernan SOLO
      // el ESTADO y los HITOS — el signing_token NO es bearer de entrada (★ CANONICA)
      // y el hydrate puede traer el contexto SIN token (se resuelve server-side en
      // cada acto via resume_token+n). Exigirlo aqui re-aterrizaba en el paso 7 con
      // gdpr/review ya completados. Basta contexto presente + estado + hitos.
      const signingInProgress =
        adm && adm.state_code === 'AD' && adm.signing_ready
        && adm.signing_status !== 'COMPLETED'
        && adm.signing_context;
      if (signingInProgress && st) {
        // primer sub-paso incompleto: billing(0)→gdpr(1)→review(2)→sign(3).
        let sub = 3;
        if      (!st.billing_confirmed) sub = 0;
        else if (!st.gdpr_completed)    sub = 1;
        else if (!st.review_completed)  sub = 2;
        else if (!st.signed)            sub = 3;
        const target = STEP_FIRST_SIGNING + sub;
        for (let i = 0; i < target; i++) completed.add(i); // pasos previos completados → stepper coherente
        setCompletedStepsRaw(new Set(completed));
        saveSession({ completedSteps: [...completed] });
        log.info('[DBG hydrate] landing', { submitted: true, signing: true, sub, target });
        setCurrentStep(target);
        return;
      }
      log.info('[DBG hydrate] landing', { submitted: true, target: 6 });
      setCurrentStep(6);
      return;
    }
    const STEP_COUNT = 7; // only wizard steps 0-6 considered for non-submitted resume
    let target = STEP_COUNT - 1; // default to Review
    for (let i = 0; i < STEP_COUNT; i++) {
      if (!completed.has(i)) { target = i; break; }
    }
    log.info('[DBG hydrate] landing', { submitted: false, target });
    setCurrentStep(target);
  }, []);

  // ── Flag DERIVADO para el mapeo central (catalog.stepEditMode — decisión Diego
  //    2026-06-12, pasos 1-11 uniformes): la lectura está confirmada si lo dice el
  //    HITO DURABLE del server o la confirmación local de esta sesión (persistida).
  const reviewConfirmed = reviewConfirmedLocal
    || !!(admissionState && admissionState.signing_context
          && admissionState.signing_context.steps
          && admissionState.signing_context.steps.review_completed);


  // ── Admission-state PULSE (realtime bug, Diego 2026-06-07) ───────────────────
  // Refresca SOLO el sub-bloque de admisión (admissionState/signingContext/
  // isSubmitted) desde una respuesta de resumeSession, SIN tocar stepData /
  // savedBaseline / completedSteps / currentStep. Lo llama el poll de WizardPage
  // (~30s + focus) para que un cambio de estado en el KMS (admisión, reopen) se
  // refleje con el wizard abierto sin recargar — y SIN pisar la edición en curso
  // (no es hydrateFromResume; no reseed). Mismo cálculo de submitted_at que la
  // hidratación (línea ~542): importante para el caso reopen (KMS→IN deja
  // submitted_at=null) y para el caso admitida.
  const refreshAdmissionState = useCallback((data) => {
    if (!data) return;
    // Dos shapes posibles:
    //  (a) PESADO — resumeSession_: { group/application, admission:{...} }. Trae
    //      submitted_at → actualiza isSubmitted (incluye el override de reopen).
    //  (b) LIGERO — getAdmissionState_ (PERF, el pulse): plano { ok, state_code,
    //      state_label, signing_* }. NO trae submitted_at → no tocamos isSubmitted
    //      (el pulse solo refresca el bloque de admisión + signing context).
    if (data.group || data.application || data.admission) {
      const group = data.group || data.application || {};
      const admRaw = data.admission || null;
      // WIZARD-GATES BUG 2 + WIZ-FINAL-GATE: misma normalización que hydrateFromResume.
      const adm = normalizeAdmission_(admRaw);
      // URGENT-PASS3 BUG A: misma derivación state-driven que hydrateFromResume.
      // Un cambio de estado en el KMS (p.ej. AD, o reopen→IN) se refleja en el pulse
      // sin recargar: estado real → admission.editable gobierna; sin estado → submitted_at.
      const hasRealState = !!(adm && adm.state_code);
      setIsSubmitted(hasRealState ? (adm.editable === false) : !!group.submitted_at);
      setAdmissionState(adm);
      setSigningContext(adm && adm.signing_context ? adm.signing_context : null);
      return;
    }
    // WIZARD-GATES BUG 2 + WIZ-FINAL-GATE: misma normalización en el path ligero.
    const adm = normalizeAdmission_({
      state_code:        data.state_code,
      state_label:       data.state_label,
      signing_available: data.signing_available,
      signing_ready:     data.signing_ready,
      signing_status:    data.signing_status,
      signing_context:   data.signing_context,
      editable:          data.editable,
    });
    setAdmissionState(adm);
    // URGENT-PASS3 BUG A: el pulse ligero ahora trae `editable` (getAdmissionState_) →
    // refleja AD/reopen sin recargar. Si hay estado real, GOBIERNA editable; si no, no
    // tocamos isSubmitted (el pulse ligero no trae submitted_at — el caso pre-submit lo
    // cubrió ya la hidratación pesada).
    if (data.state_code) setIsSubmitted(data.editable === false);
    // El pulso ligero (getAdmissionState) puede NO traer signing_context aunque la
    // firma siga lista → NO borrar el token ya resuelto (vive en React state, KAL-7).
    // Solo actualizar si el pulso aporta uno nuevo; si no, preservar el existente.
    setSigningContext(prev => data.signing_context || prev);
  }, []);

  return (
    <WizardContext.Provider value={{
      enrollmentGroupId, setEnrollmentGroupId,
      resumeToken,   setResumeToken,
      currentStep,   setCurrentStep,
      stepData,      updateStep,
      recognition,   setRecognition,
      completedSteps, addCompletedStep, removeCompletedStep,
      isStepDirty, markStepSaved,
      setPendingSave, enqueueSave, awaitPendingSave, hasPendingSave, saveState,
      beginUpload, endUpload, hasUploadInFlight,      // 0º.quindecies — el pulso se aparta mientras sube un documento
      retryLastSave,                                              // WPERF-1 criterio 3
      apuntarTrabajo, preguntarPorLosGuardados,                   // 18.bis.84 — «apuntado» no es «guardado»: hay que volver a preguntar
      saveErrorSeq, saveErrorQue, saveErrorCodigo,                // cola 18.bis — aviso de guardado (episodio + qué falló + por qué, ②24.sexies)
      validationError, setValidationError,                        // UX-1 aviso sticky
      submitError, setSubmitError,                                // UX-3 fallo envío optimista
      markUserTookControl, resetUserTookControl, userTookControlRef, // WPERF-1 criterio 4
      hydrateFromResume, refreshAdmissionState, clearSession,
      isSubmitted, setIsSubmitted,
      admissionState, signingContext,           // P216 (DL-E38)
      reviewConfirmedLocal, setReviewConfirmedLocal, // lock en vivo post-confirm (Diego 2026-06-12)
      reviewConfirmed,                            // input del mapeo central (catalog.stepEditMode)
      docCache, loadDocument, signingMembers, setSigningMembers, // STEP10-VIEWER: cache en memoria del paquete contractual
      signingSession, setSigningSession,          // WIZARD-UX TASK-1: memo en memoria del estado de la sesión de firma (Step 11 idempotente)
      billingSplits, liveVersion, setLiveVersion, // DL-B §1/§2 (hydrate consolidado + cheap-poll)
      signingForms, updateSigningForm,            // REBUILD-8-11: formularios de firma en memoria
      recoveredEmail, setRecoveredEmail,         // a1 discriminator (DL-E38)
      recoveryNonce, setRecoveryNonce,           // IDENTITY-FROM-LINK: `n` = email_id del enlace
      formaDePagoMarcada, setFormaDePagoMarcada, // 0º.vicies.sexies: la marca del paso 7, solo en el navegador
      isStepUpFresh, markStepUpFresh, revokeStepUpFresh, touchActivity, // DL-E39 step-up PII-primero + #30 espejo revocable
      stepUpVerifiedUntil,                              // 2026-08-20: hasta cuándo, para el aviso de los dos minutos
      stepUpCierre,                                     // 2026-08-20: QUÉ lo cierra — 'INACTIVIDAD' | 'TECHO'
      recoveredViaMagicLink, setRecoveredViaMagicLink, // DL-E39 gate de entrada
      otpAutoSentForRecovery, markOtpAutoSentForRecovery, // OTP-TRIGGER: auto-send solo 1ª recuperación
      needsHydration: !!(enrollmentGroupId && !stepData.email.verified),
    }}>
      {children}
    </WizardContext.Provider>
  );
}

export function useWizard() {
  const ctx = useContext(WizardContext);
  if (!ctx) throw new Error('useWizard must be used inside WizardProvider');
  return ctx;
}
