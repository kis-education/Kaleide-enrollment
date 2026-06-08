import { createContext, useContext, useState, useCallback, useEffect } from 'react';
import * as log from '../logger';
import { purgeQuestionsCache } from '../api';  // WIZARD-PERF-CACHE-SKELETON: purgar cache de preguntas al limpiar sesión

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

const WizardContext = createContext(null);

// DL-E39 (PII-primero) — step-up re-auth + inactivity window.
// La PII sensible de menores (salud Art.9 RGPD, DNI, DOB, dirección) se muestra
// ENMASCARADA por defecto y se revela en claro solo tras un step-up (código
// fresco al buzón). El step-up "fresco" caduca a los 10 min de INACTIVIDAD.
export const STEPUP_WINDOW_MS = 10 * 60 * 1000; // 10 minutos

// Wizard canónico — 11 steps per roadmap (docs/kms/plan/wizard-admissions-roadmap.md
// líneas 17-27 + DL-E24 §3 + DL-E27 + DL-E28). NO inventar pasos extra. CLI 22 + CLI 28
// + Frontend-9-10 + Frontend-12 introdujeron "Status/Interview/Decision/Deposit/..."
// inventados; CLI 59 (2026-05-30) revirtió a este canon.
//
// 1-7 pre-AD (admisión decisión): ya implementados, formularios reales.
// 8-11 post-AD: placeholders informativos hasta que tengan backend.
//
// Endpoints futuros para 8-11 (no existen todavía):
//   8 S-BILLING  → enr.saveBillingInfo       (P49)
//   9 S-GDPR     → enr.submitGdprConsents    (DL-E27)
//  10 S-REVIEW   → enr.confirmReview         (DL-E28 §6)
//  11 S-SIGN     → enr.initiateSigningSession (DL-E28 §7-§13, P50)
export const STEPS = [
  // Steps 1-7: enrollment wizard pre-AD
  { key: 'email',       labelKey: 'step.email'           },
  { key: 'persons',     labelKey: 'step.persons'         },
  { key: 'relations',   labelKey: 'step.relations'       },
  { key: 'health',      labelKey: 'step.health'          },
  { key: 'questions',   labelKey: 'step.questions'       },
  { key: 'documents',   labelKey: 'step.documents'       },
  { key: 'review',      labelKey: 'step.review'          },
  // Steps 8-11: post-AD (locked hasta que admisiones acepte la solicitud).
  { key: 's_billing',   labelKey: 'step.billing.title'         },
  { key: 's_gdpr',      labelKey: 'step.gdpr.title'            },
  { key: 's_review',    labelKey: 'step.signing_review.title'  },
  { key: 's_sign',      labelKey: 'step.signing.title'         },
];

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
    const run = saveTailRef.current
      .catch(() => {})                 // un fallo previo no debe abortar la cola
      .then(() => saveFn());           // ejecuta EN ORDEN tras el anterior
    // El tail avanza pase lo que pase; el conteo decrece al settle.
    saveTailRef.current = run.then(
      () => { pendingCountRef.current -= 1; if (pendingCountRef.current <= 0) { pendingCountRef.current = 0; setSaveState('idle'); } },
      () => { pendingCountRef.current -= 1; if (pendingCountRef.current < 0) pendingCountRef.current = 0; setSaveState('error'); }
    );
    return run;
  }, []);

  /**
   * Devuelve una promesa que resuelve cuando la cola de saves está DRENADA
   * (todos los saves encolados han settleado). El submit final la awaita antes
   * de enviar. Safe incluso sin saves en vuelo (tail ya resuelto).
   */
  const awaitPendingSave = useCallback(() => {
    return saveTailRef.current.catch(() => {});
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

  // Marca actividad del usuario. VENTANA DESLIZANTE (data-layer pieza 6): mientras
  // el step-up SIGUE fresco, la actividad RE-EXTIENDE `stepUpVerifiedUntil` (now +
  // 10min) → un usuario activo rellenando PII nunca es expulsado a mitad de un save.
  // NUNCA resucita un step-up ya expirado (eso exige markStepUpFresh tras OTP): solo
  // prorroga una verificación viva. Sin tope absoluto que mate al usuario activo.
  const touchActivity = useCallback(() => {
    const now = Date.now();
    setLastActivityAt(now);
    setStepUpVerifiedUntil(prev => (prev && now < prev) ? now + STEPUP_WINDOW_MS : prev);
  }, []);

  // Tras un verifyEmail({stepup:true}) OK → step-up fresco durante 10 min.
  const markStepUpFresh = useCallback(() => {
    const now = Date.now();
    setStepUpVerifiedUntil(now + STEPUP_WINDOW_MS);
    setLastActivityAt(now);
    log.success('step-up: verificación fresca registrada (10 min)');
  }, []);

  // True si el step-up sigue fresco. Ventana DESLIZANTE: `stepUpVerifiedUntil` se
  // desliza con la actividad (touchActivity), así que basta comprobar el tope —
  // que ya no es fijo sino que avanza mientras el usuario interactúa. Sin actividad
  // durante 10 min, el tope no se desliza y caduca. Función pura (lee Date.now()).
  const isStepUpFresh = useCallback(() => {
    const now = Date.now();
    return !!stepUpVerifiedUntil && now < stepUpVerifiedUntil;
  }, [stepUpVerifiedUntil]);

  // Data-layer pieza 6 (sliding step-up): UN único listener global throttled (~30s)
  // de actividad real del usuario → touchActivity, para que la ventana de step-up se
  // DESLICE mientras el usuario está activo en CUALQUIER paso (antes solo unos pocos
  // botones llamaban touchActivity → un usuario activo a los 10 min recibía
  // STEPUP_REQUIRED en mitad de un save). El throttle evita re-extender en cada
  // mousemove; touchActivity solo prorroga si ya hay frescura (no la crea).
  useEffect(() => {
    let last = 0;
    const onActivity = () => {
      const now = Date.now();
      if (now - last < 30 * 1000) return;
      last = now;
      touchActivity();
    };
    const evs = ['mousemove', 'keydown', 'click', 'scroll', 'touchstart'];
    evs.forEach(e => window.addEventListener(e, onActivity, { passive: true }));
    return () => evs.forEach(e => window.removeEventListener(e, onActivity));
  }, [touchActivity]);

  const [recoveredEmail, setRecoveredEmailRaw] = useState(session.recoveredEmail || null);
  const setRecoveredEmail = useCallback((e) => {
    const v = e ? String(e).toLowerCase().trim() : null;
    setRecoveredEmailRaw(v);
    saveSession({ recoveredEmail: v });
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
    setStepUpVerifiedUntil(0);
    setLastActivityAt(Date.now());
    setRecoveredViaMagicLinkRaw(false);
    setOtpAutoSentForRecoveryRaw(false);
    // WIZARD-PERF-CACHE-SKELETON: el catálogo cacheado de preguntas NUNCA debe
    // sobrevivir al ciclo de auth — purgar al limpiar sesión (logout/clear/expiry).
    purgeQuestionsCache();
  }, []);

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
    if (data.step_up_fresh) {
      markStepUpFresh();
      markOtpAutoSentForRecovery();
      log.info('hydrateFromResume: magic-link grace activa (nonce válido <10min) — sin OTP');
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
    const submitted = !!group.submitted_at;
    setIsSubmitted(submitted);

    // P216: store the real admission state + per-guardian signing context the
    // backend resolved (additive block). Re-fetched on every resume → React
    // state only. The Step 7 banner reads admissionState.state_label; the
    // "continue to sign" advance reads signingContext (Phase 3).
    const adm = data.admission || null;
    setAdmissionState(adm);
    setSigningContext(adm && adm.signing_context ? adm.signing_context : null);
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

    // Land on the first incomplete step, or Review if everything's filled.
    // Submitted sessions land on Step 7 Review (index 6) — read-only view of what
    // was sent. The post-AD steps 8-11 (indices 7-10) stay locked until admisión
    // decisión flips them open (future feature; backend not implemented yet — CLI 59).
    if (submitted) { setCurrentStep(6); return; }
    const STEP_COUNT = 7; // only wizard steps 0-6 considered for non-submitted resume
    let target = STEP_COUNT - 1; // default to Review
    for (let i = 0; i < STEP_COUNT; i++) {
      if (!completed.has(i)) { target = i; break; }
    }
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
      setIsSubmitted(!!group.submitted_at);
      const adm = data.admission || null;
      setAdmissionState(adm);
      setSigningContext(adm && adm.signing_context ? adm.signing_context : null);
      return;
    }
    const adm = {
      state_code:        data.state_code,
      state_label:       data.state_label,
      signing_available: data.signing_available,
      signing_ready:     data.signing_ready,
      signing_status:    data.signing_status,
      signing_context:   data.signing_context,
    };
    setAdmissionState(adm);
    setSigningContext(data.signing_context || null);
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
      hydrateFromResume, refreshAdmissionState, clearSession,
      isSubmitted, setIsSubmitted,
      admissionState, signingContext,           // P216 (DL-E38)
      recoveredEmail, setRecoveredEmail,         // a1 discriminator (DL-E38)
      isStepUpFresh, markStepUpFresh, touchActivity, // DL-E39 step-up PII-primero
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
