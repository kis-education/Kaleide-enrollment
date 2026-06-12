import { createContext, useContext, useState, useCallback, useEffect, useRef } from 'react';
import * as log from '../logger';
import i18n from '../i18n';                                   // DL-C-B (g): locale UI para sembrar el catálogo de preguntas del hydrate
import { purgeQuestionsCache, primeLookups, primeQuestions, getDocumentBytes, purgeDocumentBytesCache } from '../api';  // WIZARD-PERF-CACHE-SKELETON: purgar cache de preguntas al limpiar sesión; DL-B: sembrar lookups del hydrate consolidado; DL-C-B: sembrar questions del hydrate; STEP10-VIEWER: bytes del paquete contractual → cache de object URLs del contexto

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
  // WPERF-1 criterio 4 (auto-avance guard): se pone a true en CUALQUIER navegación
  // MANUAL (botón atrás/adelante, avance de firma). El JUMP async de enterSigning lo
  // resetea al hacer click y lo comprueba antes de saltar: si el usuario navegó a mano
  // tras el click, aborta el salto (no le pisa la pantalla ~19s después).
  const userTookControlRef = useRef(false);
  const markUserTookControl  = useCallback(() => { userTookControlRef.current = true;  }, []);
  const resetUserTookControl = useCallback(() => { userTookControlRef.current = false; }, []);

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
  const enqueueSave = useCallback((saveFn) => {
    pendingCountRef.current += 1;
    setSaveState('saving');
    const _t0 = Date.now();                          // DBG-SESSION timing
    log.info('[DBG savequeue] enqueue', { pending: pendingCountRef.current });
    const run = saveTailRef.current
      .catch(() => {})                 // un fallo previo no debe abortar la cola
      .then(() => saveFn());           // ejecuta EN ORDEN tras el anterior
    // El tail avanza pase lo que pase; el conteo decrece al settle.
    saveTailRef.current = run.then(
      () => { pendingCountRef.current -= 1; log.info('[DBG savequeue] done OK', { ms: Date.now() - _t0, pending: pendingCountRef.current }); if (pendingCountRef.current <= 0) { pendingCountRef.current = 0; lastFailedSaveRef.current = null; setSaveState('idle'); } },
      (e) => { pendingCountRef.current -= 1; lastFailedSaveRef.current = saveFn; log.warn('[DBG savequeue] done ERR', { ms: Date.now() - _t0, pending: pendingCountRef.current, code: e && e.code, message: e && e.message }); if (pendingCountRef.current < 0) pendingCountRef.current = 0; setSaveState('error'); }
    );
    return run;
  }, []);

  /**
   * WPERF-1 criterio 3: re-encola la última save que falló (la guarda
   * lastFailedSaveRef). Lo dispara el botón "Reintentar" del SaveIndicator. No-op si
   * no hay ninguna pendiente de reintento. Limpia la ref antes de re-encolar para no
   * reintentar dos veces la misma factory si el usuario hace doble click.
   */
  const retryLastSave = useCallback(() => {
    const fn = lastFailedSaveRef.current;
    if (!fn) return;
    lastFailedSaveRef.current = null;
    log.info('[DBG savequeue] retry last failed save');
    enqueueSave(fn);
  }, [enqueueSave]);

  /**
   * Devuelve una promesa que resuelve cuando la cola de saves está DRENADA
   * (todos los saves encolados han settleado). El submit final la awaita antes
   * de enviar. Safe incluso sin saves en vuelo (tail ya resuelto).
   */
  const awaitPendingSave = useCallback(() => {
    const _t0 = Date.now();                          // DBG-SESSION timing
    log.info('[DBG savequeue] await start');
    return saveTailRef.current.then(
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

  // ★ SEC-STEPUP (finding #55, 2026-06-11): la ventana de step-up es DURA (10 min
  // EXACTOS desde el OTP/gracia), NO deslizante. Antes la actividad re-extendía
  // `stepUpVerifiedUntil` en el cliente → divergía de la ventana DURA del servidor
  // y dejaba la UI desbloqueada (candado stale) más allá de lo que el backend honra
  // (que ahora exige re-OTP pasados los 10 min en cada write de PII). touchActivity
  // se conserva como marca de actividad SIN extender la frescura — el cliente espeja
  // EXCLUSIVAMENTE la verdad del servidor (step_up_fresh del hydrate/pulso).
  const touchActivity = useCallback(() => {
    setLastActivityAt(Date.now());
  }, []);

  // Tras un verifyEmail({stepup:true}) OK → step-up fresco durante 10 min.
  const markStepUpFresh = useCallback(() => {
    const now = Date.now();
    setStepUpVerifiedUntil(now + STEPUP_WINDOW_MS);
    setLastActivityAt(now);
    log.success('step-up: verificación fresca registrada (10 min)');
  }, []);

  // #30 (lock proactivo, post-#55): revoca el espejo LOCAL de frescura. El servidor es
  // la verdad de la ventana DURA; el cliente solo conoce el booleano `step_up_fresh`
  // (sin remaining_s), así que tras un F5 a mitad de ventana el espejo local puede
  // sobrevivir más que la marca server-side. Cuando el servidor rechaza con
  // STEPUP_REQUIRED, esto re-sincroniza el espejo a "expirado" → el ticker de 30s
  // re-renderiza y el gate de entrada (mustPassEntryGate) se cierra para TODA la UI
  // PII, no solo para el save que falló. NUNCA extiende — solo revoca (anti-sliding).
  const revokeStepUpFresh = useCallback(() => {
    setStepUpVerifiedUntil(0);
    log.warn('step-up: frescura revocada (servidor reportó STEPUP_REQUIRED)');
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
      markStepUpFresh();
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
      persons: persons.map(p => ({
        ...p,
        phones: Array.isArray(p.phones) ? p.phones.map(ph => ({
          ...ph,
          is_default:   normYN(ph.is_default),
          is_emergency: normYN(ph.is_emergency),
          is_whatsapp:  normYN(ph.is_whatsapp),
          is_telegram:  normYN(ph.is_telegram),
        })) : p.phones,
        emails: Array.isArray(p.emails) ? p.emails.map(e => ({
          ...e,
          is_default:   normYN(e.is_default),
          is_emergency: normYN(e.is_emergency),
        })) : p.emails,
      })),
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
      questions: responsesDict,
      documents,
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
    if (data.lookups) primeLookups(data.lookups);
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
      const signingInProgress =
        adm && adm.state_code === 'AD' && adm.signing_ready
        && adm.signing_status !== 'COMPLETED'
        && adm.signing_context && adm.signing_context.signing_token;
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
      retryLastSave,                                              // WPERF-1 criterio 3
      validationError, setValidationError,                        // UX-1 aviso sticky
      submitError, setSubmitError,                                // UX-3 fallo envío optimista
      markUserTookControl, resetUserTookControl, userTookControlRef, // WPERF-1 criterio 4
      hydrateFromResume, refreshAdmissionState, clearSession,
      isSubmitted, setIsSubmitted,
      admissionState, signingContext,           // P216 (DL-E38)
      docCache, loadDocument, signingMembers, setSigningMembers, // STEP10-VIEWER: cache en memoria del paquete contractual
      billingSplits, liveVersion, setLiveVersion, // DL-B §1/§2 (hydrate consolidado + cheap-poll)
      signingForms, updateSigningForm,            // REBUILD-8-11: formularios de firma en memoria
      recoveredEmail, setRecoveredEmail,         // a1 discriminator (DL-E38)
      recoveryNonce, setRecoveryNonce,           // IDENTITY-FROM-LINK: `n` = email_id del enlace
      isStepUpFresh, markStepUpFresh, revokeStepUpFresh, touchActivity, // DL-E39 step-up PII-primero + #30 espejo revocable
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
