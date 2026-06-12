import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useWizard } from '../context/WizardContext';
import * as log from '../logger';
import { gasCall, prefetchLookups, prefetchQuestions, prefetchDocuments } from '../api';
import LangToggle from '../components/LangToggle';
import SaveIndicator from '../components/SaveIndicator';
import LoadingSpinner from '../components/LoadingSpinner';
import StepSkeleton from '../components/StepSkeleton';  // DL-C-B (b): render progresivo durante la rehidratación
import LegalFooter from '../components/LegalFooter';
import WizardProgress from '../components/WizardProgress';
import StepUpReverify from '../components/StepUpReverify';
import StepUpGate from '../components/StepUpGate';
import { Toast, useToast } from '../components/Toast';

// STEP-FRAMEWORK (Diego 2026-06-11) — el wizard consume el CATÁLOGO DECLARATIVO de
// pasos (steps/catalog.js). Los 11 pasos canónicos del programa ADMISIONES KIS son la
// primera instancia; otro programa (campamentos, etc.) declararía otro catálogo sin
// tocar este chasis. STEP_COMPONENTS deriva del catálogo (compat con el viejo array).
// FIRST_SIGNING_INDEX (primer paso savePolicy:'act') sustituye el 7 hardcodeado.
import { STEP_CATALOG, STEP_COMPONENTS, FIRST_SIGNING_INDEX } from './steps/catalog';

const LOGO = 'https://raw.githubusercontent.com/kaleideschool/public/main/favicon.png';

export default function WizardPage() {
  const { t, i18n }                     = useTranslation();
  const navigate                        = useNavigate();
  const {
    enrollmentGroupId, resumeToken,
    currentStep, setCurrentStep,
    stepData, updateStep,
    hydrateFromResume, refreshAdmissionState, needsHydration,
    clearSession,
    completedSteps, addCompletedStep, removeCompletedStep,
    isStepDirty, markStepSaved,
    setPendingSave, enqueueSave, hasPendingSave, saveState,
    validationError, setValidationError,                          // UX-1 aviso sticky
    markUserTookControl, resetUserTookControl, userTookControlRef, // WPERF-1 criterio 4
    isSubmitted,
    admissionState, signingContext,
    loadDocument,                               // STEP10-VIEWER: cache de docs del contexto
    billingSplits, liveVersion, setLiveVersion, // DL-B §1/§2
    markStepUpFresh, revokeStepUpFresh, // #30: espejo local revocable (lock proactivo)
    isStepUpFresh, recoveredViaMagicLink,
    otpAutoSentForRecovery, markOtpAutoSentForRecovery, // OTP-TRIGGER
    recoveredEmail, setRecoveredEmail,
    recoveryNonce, // IDENTITY-FROM-LINK: `n` = email_id del enlace (identidad canónica)
  } = useWizard();
  const { message: toastMsg, showToast } = useToast();
  const [saving,            setSaving]            = useState(false);
  const [sendingMagicLink,  setSendingMagicLink]  = useState(false);
  const [rehydrating,       setRehydrating]       = useState(false);
  const [abandoning,        setAbandoning]        = useState(false);
  // DL-E39: si saveStep (PII) devuelve STEPUP_REQUIRED, guardamos la acción
  // pendiente (re-lanzar handleNext con los mismos args) para reintentar tras
  // verificar. null | { stepKey, data }.
  const [stepUpPending,     setStepUpPending]     = useState(null);
  // DL-E38 merge (flujo continuo 1→11): contexto del firmante (steps
  // billing_confirmed/gdpr_completed/review_completed/signed) resuelto vía
  // resolveSigningToken cuando la familia entra a los Steps 8-11 inline. Permite
  // (a) aterrizar en el sub-paso correcto al reanudar a mitad de firma y (b) que
  // SignSign detecte el estado terminal. NO persistido (vive en React state; el
  // signing_token bearer no se guarda en sessionStorage — KAL-7).
  const [signerCtx,         setSignerCtx]         = useState(null);
  // P215 opción (b) ELIMINADA (CLI AD-SPLIT): el selector in-app de firmante
  // ('selectSigner' + signing_candidates) queda descartado por razón legal — la
  // identidad de firma se deriva SOLO server-side (recovery link per-guardian,
  // Vía 1; o resolución determinista, Vía 2). CERO auto-declaración de identidad.

  // Kick off lookup prefetch immediately so Step3/Step4 get cached lookups.
  // SPEC-WIZ-LAZY (cold-load spec §3): además, calienta el CATÁLOGO pesado de
  // preguntas en BACKGROUND desde el montaje del wizard para que esté listo al
  // llegar al Step 5, SIN bloquear el primer render — Steps 1-4 solo necesitan
  // `programs`/lookups, nunca el catálogo. `prefetchQuestions` es idempotente y
  // fire-and-forget (comparte el dedup `_questionsFlight` con el `fetchQuestions`
  // del Step 5 → colapsa a UNA sola llamada de red) y traga errores (best-effort:
  // si no llegó a tiempo, el Step 5 hace su propio fetch con su loader). NO altera
  // el invariante del Step 5 (set completo o loader, nunca parcial). Esto desacopla
  // el catálogo del primer paint (parte frontend de SPEC-WIZ-LAZY; la opción (a) de
  // quitar el plegado del hydrate es backend y queda fuera de este carril FE).
  useEffect(() => { prefetchLookups(); prefetchQuestions(i18n.language); }, []); // eslint-disable-line

  // WPERF-1 criterio "eager docs": si el expediente está Aprobado (AD) y la firma está
  // lista para este guardian (no completada), calienta el paquete contractual (members
  // + bytes getDocument ~40s) para que S-REVIEW pinte sin esperar. Best-effort: si el
  // step-up aún no está fresco, getDocument falla silenciosamente y la caché se purga
  // (re-fetch normal al llegar a Review). Se dispara solo para firmantes reales (no en
  // cada /apply) para no malgastar cuota GAS. KAL-7: el token vive en React state.
  // STEP10-VIEWER: el warm escribe en EL cache del CONTEXTO (loadDocument → object URLs
  // + sha256 keyed por file_id en WizardContext) — un solo cache, no dos paralelos.
  // Identidad de SESIÓN preferente (resume_token + `n`); signing_token solo compat.
  const warmDocuments = () => {
    prefetchDocuments(
      {
        resumeToken,
        signingToken: signingContext?.signing_token || null,
        n: recoveryNonce,
        recoveredEmail,
      },
      loadDocument
    );
  };
  useEffect(() => {
    if (admissionState?.state_code === 'AD'
        && admissionState?.signing_ready
        && admissionState?.signing_status !== 'COMPLETED'
        && (resumeToken || signingContext?.signing_token)) {
      warmDocuments();
    }
  }, [admissionState?.state_code, admissionState?.signing_ready, admissionState?.signing_status, resumeToken, signingContext?.signing_token]); // eslint-disable-line

  // STEP-FRAMEWORK preload del catálogo: al ENTRAR a un paso cuyo catálogo declara
  // `preload: ['documents']` (Step 10 s_review), dispara el MISMO warm (mismo cache del
  // contexto). Best-effort: con el cache caliente es no-op (loadDocument es idempotente
  // y getDocumentBytes de-dupea los vuelos).
  useEffect(() => {
    const entry = STEP_CATALOG[currentStep];
    if (entry && Array.isArray(entry.preload) && entry.preload.includes('documents')) {
      warmDocuments();
    }
  }, [currentStep]); // eslint-disable-line

  // ── Admission-state PULSE (realtime bug, Diego 2026-06-07) ───────────────────
  // El estado de admisión (admissionState/signingContext/isSubmitted) solo se
  // poblaba vía hydrateFromResume, que corre únicamente tras reload (needsHydration).
  // Con el wizard abierto, un cambio en el KMS (admisión, reopen) nunca se reflejaba.
  // Pulso: cada ~30s + al recuperar foco la ventana, re-llamamos resumeSession y
  // actualizamos SOLO el bloque de admisión (refreshAdmissionState NO toca stepData/
  // savedBaseline/completedSteps/currentStep → no pisa la edición en curso).
  // Guardas: requiere resumeToken; SALTA si hay un save en vuelo (no competir) o si
  // la pestaña está oculta (ahorra cuota GAS). Las últimas guardas/valores se leen
  // por ref para que el interval (effect []) no se recree en cada toggle de save.
  // KAL-7/KAL-11: el resume_token viaja en el body POST (no en URL), y los logs solo
  // emiten err.message — nunca el token.
  // DL-E38 a1 / P215: discriminador de guardian. Precedencia: el email tecleado
  // en la recuperación per-guardian (`recoveredEmail`) MANDA; si no existe (p.ej.
  // sesión normal sin recovery link), caemos al email VERIFICADO de la sesión
  // (`stepData.email.primary_email`, una vez `verified`). Así Path 1 del backend
  // (resolveGuardianForRecovery_) resuelve DETERMINISTAMENTE el guardian que está
  // ACCEDIENDO — desambiguando grupos multi-guardian por el email que la familia
  // realmente usa. KAL-4 intacta: el backend re-resuelve el guardian server-side
  // contra enrEmails del grupo; este email es solo un discriminador, nunca un claim
  // de autorización.
  const verifiedSessionEmail =
    (stepData?.email?.verified && stepData.email.primary_email) ? stepData.email.primary_email : null;
  const effectiveRecoveredEmail = recoveredEmail || verifiedSessionEmail || undefined;

  // DL-B §2 — liveState desacoplado, cheap-poll de DOS ETAPAS (Opción A). El poll de
  // DETECCIÓN-DE-CAMBIO (getLiveStateVersion) es ULTRA-LIGERO: solo lee un contador del
  // ScriptCache del wizard (que el KMS bumpa por doPost al cambiar estado/milestone) —
  // NO toca AppSheet ni el KMS. SOLO cuando la versión SUBE respecto a la que tenemos en
  // memoria hacemos el fetch de DETALLE (getAdmissionState) → refreshAdmissionState (que
  // actualiza SOLO el slice de admisión/firma; NUNCA stepData/currentStep/landing). Antes:
  // getAdmissionState directo cada 30s (lectura AppSheet en cada tick). Ahora: lectura
  // pesada solo cuando algo cambió de verdad.
  const pulseRef = useRef({ resumeToken: null, enrollmentGroupId: null, effectiveRecoveredEmail: undefined, recoveryNonce: undefined, hasPendingSave: false, liveVersion: 0 });
  pulseRef.current = { resumeToken, enrollmentGroupId, effectiveRecoveredEmail, recoveryNonce, hasPendingSave, liveVersion };
  const pulseInFlightRef = useRef(false);
  useEffect(() => {
    const tick = () => {
      const { resumeToken: rt, enrollmentGroupId: gid, effectiveRecoveredEmail: re, recoveryNonce: rn, hasPendingSave: pending, liveVersion: knownVer } = pulseRef.current;
      if (!rt || !gid) return;                            // sin sesión → nada que sincronizar
      if (pending) return;                                // save en vuelo → saltar este tick
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') return; // pestaña oculta → saltar
      if (pulseInFlightRef.current) return;               // ya hay un pulse en vuelo → no solapar
      pulseInFlightRef.current = true;
      // ── Etapa 1 — detección de cambio ULTRA-LIGERA (solo la versión, sin AppSheet/KMS).
      gasCall('getLiveStateVersion', { enrollment_group_id: gid })
        .then(verRes => {
          const v = (verRes && Number(verRes.version)) || 0;
          if (v <= (Number(knownVer) || 0)) return; // sin cambios → NO leer detalle
          // ── Etapa 2 — la versión subió → fetch de DETALLE del liveState.
          log.info('[DBG cheap-poll] version subió', { from: knownVer, to: v });
          return gasCall('getAdmissionState', { resume_token: rt, recovered_email: re || undefined, n: rn || undefined })
            .then(data => {
              log.info('[DBG pulse] getAdmissionState', { state_code: data && data.state_code, signing_ready: data && data.signing_ready, signing_status: data && data.signing_status, has_ctx: !!(data && data.signing_context) });
              refreshAdmissionState(data);     // SOLO slice admisión/firma — nunca datos/nav
              setLiveVersion(v);               // avanza la baseline (no re-disparar el mismo cambio)
            });
        })
        .catch(err => log.warn('WizardPage: liveState cheap-poll failed', { message: err.message }))
        .finally(() => { pulseInFlightRef.current = false; });
    };
    const id = setInterval(tick, 30 * 1000);
    const onFocus = () => tick();
    window.addEventListener('focus', onFocus);
    return () => { clearInterval(id); window.removeEventListener('focus', onFocus); };
  }, []); // eslint-disable-line

  // On page reload, enrollmentGroupId is restored from sessionStorage but stepData is empty.
  // Auto-resume from the server to restore full wizard state.
  useEffect(() => {
    if (needsHydration && resumeToken) {
      setRehydrating(true);
      log.info('WizardPage: rehydrating session after reload', { enrollmentGroupId });
      // DL-E38 a1 / P215: re-send the email the family typed (persisted in
      // WizardContext as `recoveredEmail`) so the backend re-resolves WHICH
      // guardian recovered (server-side, KAL-4) and can unlock the per-guardian
      // signing context. Without it, every wizard rehydration was group-scoped
      // and `admission.signing_available` stayed false for multi-guardian
      // families even though a signing_token existed — Step 7 → /sign bridge
      // never unlocked. Mirrors ResumePage:59. Absent (cross-device) → falls
      // back to the deterministic session-anchored resolution / signer selector.
      // DL-B §1 — hidratación CONSOLIDADA: UNA llamada (hydrateSession → KMS
      // enr.wizardHydrate) trae datos 11 pasos + lookups + qbResponses + admission
      // + signing_context + billing_splits + live_version. Sustituye la cascada
      // resumeSession + fetchLookups + getSavedBillingSplits + resolveSigningToken.
      gasCall('hydrateSession', { resume_token: resumeToken, recovered_email: effectiveRecoveredEmail, n: recoveryNonce || undefined, language: i18n.language })
        .then(data => {
          // hydrateFromResume now seeds completedSteps in context based on
          // which steps have data — no need to override here.
          hydrateFromResume(data);
          log.success('WizardPage: rehydration complete');
        })
        .catch(err => {
          log.error('WizardPage: rehydration failed', { message: err.message });
          navigate('/consent', { replace: true });
        })
        .finally(() => setRehydrating(false));
    } else if (!enrollmentGroupId) {
      log.warn('WizardPage: no enrollmentGroupId — redirecting to /consent');
      navigate('/consent', { replace: true });
    }
  }, []); // eslint-disable-line

const handleNext = async (stepKey, data, extra = null) => {
    log.info(`WizardPage: handleNext step=${currentStep} stepKey=${stepKey}`);
    setValidationError('');  // UX-1: limpia el aviso sticky al avanzar de paso
    markUserTookControl(); // WPERF-1 criterio 4: nav manual → invalida un JUMP de enterSigning pendiente

    // Data-layer pieza 2: el avance YA NO bloquea esperando el save de N-1. El save
    // se ENCOLA (enqueueSave) y corre en background EN ORDEN FIFO (la cola preserva
    // persons→relations: el save de relaciones se ejecuta tras el de personas, que
    // ya estampó el personIdMap). La navegación avanza al instante; el indicador
    // "Guardando…/Todo guardado/Error" (saveState) cubre el estado. El submit final
    // (Step7Review) sí espera el drenaje de la cola (awaitPendingSave).

    const needsSave = !!(enrollmentGroupId && stepKey && isStepDirty(stepKey, data));
    if (!needsSave && enrollmentGroupId && stepKey) {
      log.info(`WizardPage: step "${stepKey}" clean — skipping save`);
    }
    if (needsSave) {
      log.info(`WizardPage: step "${stepKey}" dirty — encolando save en background`, { data });
      // Data-layer pieza 2: encolar una FACTORY (no una promesa ya iniciada) para que
      // la cola FIFO ejecute este save EN ORDEN tras el anterior (preserva la
      // dependencia persons→relations) sin bloquear la navegación.
      enqueueSave(async () => {
        try {
          // Send both new and legacy keys so backend keeps working during the
          // parallel refactor — server-side will prefer enrollment_group_id.
          const saveResult = await gasCall('saveStep', {
            resume_token:        resumeToken, // KAL-4: required for IDOR defense
            enrollment_group_id: enrollmentGroupId,
            application_id:      enrollmentGroupId, // legacy alias
            step:                stepKey,
            payload:             data,
            ...(extra || {}),   // CLI 8: campos extra del paso (p.ej. sole_guardian_attestation)
          });
          log.success(`WizardPage: saveStep "${stepKey}" OK (background)`, saveResult?._debug || {});

          // Stamp real person_ids returned from backend so Step3Relations
          // can reference them. With optimistic advance the user may already
          // be on Step 3 when this resolves — Step 3 will re-render once
          // updateStep fires, picking up the real ids.
          if (stepKey === 'persons' && saveResult?._debug?.personIdMap?.length) {
            const map = {};
            saveResult._debug.personIdMap.forEach(({ _uid, person_id }) => { if (_uid) map[_uid] = person_id; });
            const updated = data.map(p => ({ ...p, person_id: p.person_id || (p._uid && map[p._uid]) || undefined }));
            log.debug('WizardPage: stamping personIdMap into stepData.persons', { map, updated_ids: updated.map(p => ({ _uid: p._uid, person_id: p.person_id })) });
            updateStep('persons', updated);
          }
          log.debug(`WizardPage: calling markStepSaved("${stepKey}") with saved data`, data);
          markStepSaved(stepKey, data);
        } catch (err) {
          // DL-E39: el backend exige step-up fresco para guardar PII →
          // mostrar StepUpReverify y reintentar este mismo paso tras verificar.
          if (err?.code === 'STEPUP_REQUIRED' || /STEPUP_REQUIRED/.test(err?.message || '')) {
            log.warn(`WizardPage: saveStep "${stepKey}" requires step-up`);
            // #30: el servidor dice que la ventana DURA expiró → revocar el espejo
            // local para que el gate de entrada se cierre en TODA la UI PII (no solo
            // el modal de reintento). Cubre el F5 a mitad de ventana, donde el espejo
            // local (sembrado a 10 min completos en hydrate) sobrevivía al servidor.
            revokeStepUpFresh();
            setStepUpPending({ stepKey, data, extra });
            throw err;
          }
          // CLI PHONE-E164: rechazo estructurado de formato de teléfono (defensa
          // backend). El gate primario es el frontend (Step2 handleNext); esto cubre
          // el caso de que el formato inválido llegue igualmente al backend.
          if (err?.code === 'INVALID_PHONE') {
            log.warn(`WizardPage: saveStep "${stepKey}" rejected — INVALID_PHONE`);
            showToast(t('step2.phone.invalid'));
            throw err;
          }
          log.warn(`WizardPage: saveStep "${stepKey}" failed (background)`, { message: err.message });
          showToast(t('wizard.save_failed'));
          throw err; // surface al drenaje de la cola — submit lo maneja con gracia
        }
      });
    } else {
      log.warn('WizardPage: skipping saveStep', { enrollmentGroupId, stepKey, dirty: needsSave });
    }
    // Note: setSaving / "Guardando..." indicator is now driven by hasPendingSave
    // from context, not by this local saving flag. Local flag retained but unused
    // (TODO cleanup: remove the local saving state once we confirm no callers).
    addCompletedStep(currentStep);
    const nextStep = Math.min(currentStep + 1, STEP_COMPONENTS.length - 1);
    log.info(`WizardPage: advancing to step ${nextStep}`);
    setCurrentStep(nextStep);
    window.scrollTo(0, 0);
  };

  // DL-E39: reintenta el saveStep que disparó STEPUP_REQUIRED, ahora que el
  // step-up está fresco server-side. NO re-avanza la UI (handleNext ya avanzó
  // optimistamente); sólo re-emite la persistencia del paso pendiente.
  const retryStepUpSave = async () => {
    if (!stepUpPending) return;
    const { stepKey, data, extra } = stepUpPending;
    setStepUpPending(null);
    if (!(enrollmentGroupId && stepKey)) return;
    const savePromise = (async () => {
      try {
        const saveResult = await gasCall('saveStep', {
          resume_token:        resumeToken,
          enrollment_group_id: enrollmentGroupId,
          application_id:      enrollmentGroupId,
          step:                stepKey,
          payload:             data,
          ...(extra || {}),   // CLI 8: preserva sole_guardian_attestation en el reintento
        });
        log.success(`WizardPage: saveStep "${stepKey}" OK (step-up retry)`, saveResult?._debug || {});
        if (stepKey === 'persons' && saveResult?._debug?.personIdMap?.length) {
          const map = {};
          saveResult._debug.personIdMap.forEach(({ _uid, person_id }) => { if (_uid) map[_uid] = person_id; });
          const updated = data.map(p => ({ ...p, person_id: p.person_id || (p._uid && map[p._uid]) || undefined }));
          updateStep('persons', updated);
        }
        markStepSaved(stepKey, data);
      } catch (err) {
        if (err?.code === 'STEPUP_REQUIRED' || /STEPUP_REQUIRED/.test(err?.message || '')) {
          revokeStepUpFresh(); // #30: re-sincroniza el espejo local con la verdad del servidor
          setStepUpPending({ stepKey, data, extra });
          return;
        }
        log.warn(`WizardPage: saveStep "${stepKey}" failed (step-up retry)`, { message: err.message });
        showToast(t('wizard.save_failed'));
      }
    })();
    setPendingSave(savePromise);
  };

  const handleBack = () => {
    setValidationError('');  // UX-1: limpia el aviso sticky al retroceder
    markUserTookControl(); // WPERF-1 criterio 4
    addCompletedStep(currentStep);
    const prevStep = Math.max(currentStep - 1, 0);
    log.info(`WizardPage: going back to step ${prevStep}`);
    setCurrentStep(prevStep);
    window.scrollTo(0, 0);
  };

  // DL-E38 merge — STEP_FIRST_SIGNING = índice 0-based del primer paso de firma
  // (Step 8 = índice 7). Los Steps 8-11 (índices 7-10) NO usan saveStep (PII /apply);
  // cada uno persiste vía su propio endpoint de firma (saveBillingInfo / submitGdpr
  // Consents / confirmReview / initiateSigningSession) con el signing_token. Su
  // "Siguiente" es el submit del componente funcional, que al completar llama a
  // advanceSigningStep para mover currentStep — SIN pasar por handleNext (que
  // dispararía un saveStep erróneo contra los endpoints /apply).
  // STEP-FRAMEWORK: derivado del catálogo (primer paso savePolicy:'act'), no 7 mágico.
  const STEP_FIRST_SIGNING = FIRST_SIGNING_INDEX;

  const advanceSigningStep = () => {
    markUserTookControl(); // WPERF-1 criterio 4: avanzar la firma a mano invalida un JUMP pendiente
    addCompletedStep(currentStep);
    const nextStep = Math.min(currentStep + 1, STEP_COMPONENTS.length - 1);
    log.info(`WizardPage: advancing signing step ${currentStep} → ${nextStep}`);
    setCurrentStep(nextStep);
    window.scrollTo(0, 0);
  };

  // DL-E38 merge — puente Step 7 → firma INLINE (antes navigate('/sign')).
  // Resuelve el signing_context per-guardian (signing_token ya server-side, KAL-4),
  // llama resolveSigningToken para obtener `steps` (billing/gdpr/review/signed) y
  // aterriza en el sub-paso correcto: una familia que ya hizo billing entra en GDPR,
  // etc. (resume mid-signing). Marca completados los pasos previos al de aterrizaje
  // para que el top-nav resalte coherente. Si el token aún no se resolvió (caso raro
  // multi-guardian ambiguo), muestra el toast recuperable — NUNCA entra a firmar sin
  // identidad (los consentimientos GDPR son per-guardian). KAL-7: el token NUNCA va
  // en la URL — vive en signingContext (React state) + se pasa por props a los steps.
  const enterSigning = () => {
    // WIZ-NAV-CANON (Diego 2026-06-11) — "NO HAY DIFERENCIA entre pasar del 4 al 5 o
    // del 7 al 8. Esto lo controlan única y exclusivamente el estado de la máquina de
    // estados y los hitos." La navegación 7→8 es una transición de paso NORMAL gobernada
    // SOLO por el estado (canAdvance: AD + signing_ready + no COMPLETED). NUNCA pide al
    // CLIENTE un signing_token/contexto como precondición de NAVEGAR: el firmante lo
    // resuelve el BACKEND en el momento del ACTO (saveBillingInfo/submitGdprConsents/
    // confirmReview/initiateSigningSession derivan la identidad del resume_token de
    // sesión vía requireSignerContext_ + binding server-side, @157). Si en el acto no
    // se puede identificar al firmante, el ERROR DEL ACTO lo dice ahí — jamás bloquea
    // esta navegación previa. KAL-4 intacta (identidad siempre server-side del token).
    // El contexto del firmante (sub-pasos billing/gdpr/review/signed) viene en la
    // hidratación consolidada (signingContext.steps) cuando existe — informativo, no gate.
    log.info('[DBG enterSigning] click (state-driven, sin gate de ctx)', {
      has_ctx: !!(signingContext && signingContext.signing_token),
      admission_steps: signingContext && signingContext.steps,
    });
    markUserTookControl();
    if (signingContext) setSignerCtx(signingContext); // alimenta members/estado de los Steps 8-11 (best-effort)
    addCompletedStep(6);
    setCurrentStep(STEP_FIRST_SIGNING);
    window.scrollTo(0, 0);
  };

  const handleUnlock = () => {
    removeCompletedStep(currentStep);
  };

  const handleStartOver = async () => {
    if (!resumeToken) return;
    if (!window.confirm(t('wizard.abandon_confirm'))) return;
    log.info('WizardPage: abandoning session', { enrollmentGroupId });
    setAbandoning(true);
    try {
      await gasCall('abandonSession', { resume_token: resumeToken });
      log.success('WizardPage: session abandoned');
      clearSession();
      navigate('/consent');
    } catch (err) {
      log.error('WizardPage: abandonSession failed', { message: err.message });
      // Even on backend failure, clear local state — the user wanted out.
      // The backend session becomes a 7-day-expiring orphan instead of an
      // abandoned-marked row; acceptable degradation.
      clearSession();
      navigate('/consent');
    } finally {
      setAbandoning(false);
    }
  };

  const handleSaveLater = async () => {
    if (!enrollmentGroupId) {
      log.warn('WizardPage: Save Later clicked but no enrollmentGroupId in context');
      return;
    }
    log.info('WizardPage: sending magic link for Save & Continue Later', { enrollmentGroupId });
    setSendingMagicLink(true);
    try {
      const sent = await gasCall('sendMagicLink', {
        enrollment_group_id: enrollmentGroupId,
        application_id:      enrollmentGroupId, // legacy alias
      });
      // SPEC-WIZ-WARMUP-V2: kick fire-and-forget del precalentado (ticket opaco;
      // el token rotado solo viaja por email — ver LandingPage para el racional).
      if (sent && sent.warm_ticket) gasCall('warmBundle', { ticket: sent.warm_ticket }).catch(() => {});
      log.success('WizardPage: magic link sent');
      showToast(t('wizard.save_later_sent'));
    } catch (err) {
      log.error('WizardPage: sendMagicLink failed', { message: err.message });
      showToast(t('wizard.save_later_error'));
    } finally {
      setSendingMagicLink(false);
    }
  };

  const StepComponent = STEP_COMPONENTS[currentStep];

  // RESPONSIVE-UI (2026-06-11): el paso de REVISIÓN DE DOCUMENTOS (s_review, Step 10)
  // ensancha el contenedor del wizard para que el visor PDF aproveche el ancho del
  // monitor. Derivado del CATÁLOGO (id), no de un índice mágico. El resto de pasos
  // mantiene el ancho de lectura cómodo (.wizard-body). Solo layout — cero lógica.
  const isWideStep = STEP_CATALOG[currentStep]?.id === 's_review';

  // ── WIZ-NAV-CANON (Diego 2026-06-11) — fuente de verdad ÚNICA del gate 7→8 + banners ──
  // "NO HAY DIFERENCIA entre pasar del 4 al 5 o del 7 al 8. Esto lo controlan única y
  // exclusivamente el estado de la máquina de estados y los hitos." La navegación 7→8 la
  // gobierna SOLO el estado: AD + signing_ready + no COMPLETED. CERO dependencia del
  // signing_context del CLIENTE para NAVEGAR (eliminado el segundo sistema de gating). El
  // firmante lo resuelve el BACKEND en el ACTO (requireSignerContext_ del resume_token,
  // @157) — si falla, el error vive EN el acto, no aquí.
  const _gateState   = admissionState?.state_code || null;
  const _gateReady   = !!admissionState?.signing_ready;
  const _gateStatus  = admissionState?.signing_status || null;
  const _hasCtx      = !!(signingContext && signingContext.signing_token); // SOLO informativo
  const _hasGuardian = !!admissionState?.recovered_guardian_person_id;      // SOLO informativo
  const canAdvance =
    currentStep === 6
    && _gateState === 'AD'
    && _gateReady
    && _gateStatus !== 'COMPLETED';
  // Banner amarillo: ÚNICO aviso de navegación restante — expediente Aprobado pero la
  // firma TODAVÍA NO está iniciada server-side (signing_ready:false real) y no completada.
  // Es la única razón legítima por la que el avance permanece bloqueado (la sesión de firma
  // del grupo aún no existe, P200/P201). NO depende del contexto del cliente.
  const showYellowBanner =
    currentStep === 6
    && _gateState === 'AD'
    && !_gateReady
    && _gateStatus !== 'COMPLETED';
  // Banner rojo "confirma tu email": ELIMINADO como BLOQUEADOR de navegación (WIZ-NAV-CANON).
  // La identidad del firmante NO es una precondición de navegar — el aviso de "no pudimos
  // identificarte, entra desde tu enlace" solo puede aparecer EN el acto que falle (Steps
  // 8-10), nunca como puerta del Step 7. Ya no existe la variable showRedBanner.
  const _bannerLabel = canAdvance ? 'none' : (showYellowBanner ? 'yellow' : 'none');
  // Instrumentación: una línea por evaluación del gate. has_ctx/has_guardian quedan SOLO
  // como informativos — NO participan en el veredicto de navegación (canAdvance/banner).
  log.info('[DBG gate]', {
    state: _gateState, signing_ready: _gateReady, status: _gateStatus,
    canAdvance, banner: _bannerLabel,
    _info_has_ctx: _hasCtx, _info_has_guardian: _hasGuardian,
  });

  // WIZARD-GATE-ORDER (Diego 2026-06-09) — Mientras una sesión RECUPERADA por
  // magic-link se está rehidratando (resume_token presente + rehydrating===true),
  // mostrar un LOADER NEUTRO en vez del shell del wizard con StepSkeleton. Sin esto,
  // como `mustPassEntryGate` exige `!rehydrating`, durante la rehidratación se caía al
  // return del shell (header + stepper + esqueletos) → flash de "pantalla desbloqueada
  // con datos fantasma" ANTES del OTP. Este early-return va ANTES del cálculo de
  // `mustPassEntryGate`: al terminar la rehidratación (!rehydrating) el flujo sigue
  // intacto y el gate decide wizard (si fresco, B) u OTP (si no). NO aplica a un
  // arranque NUEVO (sin recoveredViaMagicLink/resumeToken) → ese sigue al wizard normal.
  // Reutiliza LoadingSpinner (neutro, sin header/stepper/StepSkeleton) — patrón ResumePage.
  // CLI IMPL-E (2026-06-09): este loader cubre AHORA AMBOS hydrates de una sesión
  // recuperada — (1) el hydrate de reload pre-OTP (efecto needsHydration, descubre
  // el gate) y (2) el hydrate POST-OTP (onVerified del StepUpGate, trae la PII). El
  // segundo también marca rehydrating=true/false, así que el formulario nunca se
  // renderiza con stepData vacío durante esa rehidratación (~17-44s). La condición
  // NO cambia — sigue (recoveredViaMagicLink && resumeToken && rehydrating).
  if (recoveredViaMagicLink && resumeToken && rehydrating) {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <LoadingSpinner messages={['resume.loading', 'loading.rotating.2', 'loading.rotating.3']} />
      </div>
    );
  }

  // DL-E39 ENMIENDA — GATE DE ENTRADA (Diego 2026-06-06). Una sesión recuperada
  // por magic-link (resume_token → expediente con PII existente) NO muestra NINGÚN
  // paso ni dato hasta superar el OTP de entrada. El gate reaparece tras 10 min de
  // inactividad (isStepUpFresh() pasa a false; el ticker de WizardContext fuerza
  // el re-render). NO aplica a un arranque nuevo (/apply sin PII, la familia
  // verifica su email en sesión): esos no son recoveredViaMagicLink. El gate
  // espera a que termine la rehidratación (necesita el resumeToken del expediente).
  const mustPassEntryGate = recoveredViaMagicLink && !rehydrating && resumeToken && !isStepUpFresh();
  if (mustPassEntryGate) {
    return (
      <StepUpGate
        /* OTP-WARM: el warm pre-OTP lleva LA MISMA identidad que usará el hydrate
           post-OTP (abajo) — n + recovered_email + language entran en la clave de
           la cache warm del KMS; sin ellos el warm no haría hit. Sin PII: warmSession
           devuelve solo {ok,warmed}. sendVerificationCode ignora los extras. */
        tokenPayload={{ resume_token: resumeToken, recovered_email: effectiveRecoveredEmail, n: recoveryNonce || undefined, language: i18n.language }}
        onVerified={() => {
          markStepUpFresh();
          // P-PII-GATE: la resumeSession previa al OTP llegó gateada (sin PII,
          // pre-step-up). Tras el OTP el backend marcó el grupo fresco (verifyEmail
          // stepup:true) → re-hidratamos para cargar la PII del expediente ahora
          // permitida. Sin esto el stepData quedaría vacío tras pasar el gate.
          // CLI IMPL-E: marcar rehydrating=true/false como el hydrate de reload
          // (efecto needsHydration arriba) para que el loader neutro de
          // WIZARD-GATE-ORDER cubra TAMBIÉN este tramo. Sin esto, entre
          // markStepUpFresh() (mustPassEntryGate→false) y la resolución del
          // hydrate (~17-44s) se renderizaba el formulario con stepData VACÍO.
          setRehydrating(true);
          gasCall('hydrateSession', { resume_token: resumeToken, recovered_email: effectiveRecoveredEmail, n: recoveryNonce || undefined, language: i18n.language })
            .then(data => { hydrateFromResume(data); log.success('WizardPage: rehydrate post step-up OK'); })
            .catch(err => log.error('WizardPage: rehydrate post step-up failed', { message: err.message }))
            .finally(() => setRehydrating(false));
        }}
        shouldAutoSend={!otpAutoSentForRecovery}
        onAutoSent={markOtpAutoSentForRecovery}
      />
    );
  }

  return (
    <div className="wizard-layout">
      {/* UX-1: zona superior STICKY — header + stepper + SaveIndicator + resumen de
          validación. z-index por debajo de los overlays (9999/10000); fondo opaco para
          que el contenido no se transparente al hacer scroll. Los overlays internos son
          position:fixed → no los afecta el sticky. */}
      <div className="wizard-sticky-top" style={{ position: 'sticky', top: 0, zIndex: 500, background: 'var(--bg, #f8f9fa)' }}>
      {/* Header */}
      <header className="kis-header">
        <div className="brand">
          <img src={LOGO} alt="KIS" />
          <div>
            <div className="brand-name">Kaleide International School</div>
            <div className="brand-sub">{t('landing.header_sub')}</div>
          </div>
        </div>
        <LangToggle />
      </header>

      {/* DL-C-B (b): el overlay opaco full-page de rehidratación se sustituyó por un
          StepSkeleton en el área de contenido (más abajo) → render progresivo: el shell
          (header + progress) es visible desde el primer frame, no una pantalla tapada. */}

      {/* Saving overlay. WIZARD-UX: rotating reassuring copy (context-specific first). */}
      {(saving || sendingMagicLink) && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: 'rgba(248,249,250,0.88)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          backdropFilter: 'blur(3px)',
        }}>
          <LoadingSpinner messages={
            sendingMagicLink
              ? ['wizard.sending_magic_link', 'loading.rotating.2', 'loading.rotating.3']
              : ['wizard.saving', 'loading.rotating.2', 'loading.rotating.4']
          } />
        </div>
      )}

      {/* DL-E39: step-up requerido al guardar PII (saveStep → STEPUP_REQUIRED).
          Modal de re-verificación; al verificar, markStepUpFresh + reintento. */}
      {stepUpPending && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 10000,
          background: 'rgba(20,30,30,0.55)',
          display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16,
          backdropFilter: 'blur(2px)',
        }}>
          <div style={{ maxWidth: 460, width: '100%' }}>
            <StepUpReverify
              tokenPayload={{ resume_token: resumeToken }}
              prompt={t('stepup.save_prompt')}
              onVerified={() => { markStepUpFresh(); retryStepUpSave(); }}
            />
            <div style={{ textAlign: 'center', marginTop: 10 }}>
              <button
                type="button"
                className="btn btn-link btn-sm"
                style={{ color: '#fff' }}
                onClick={() => setStepUpPending(null)}
              >
                {t('stepup.cancel')}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Progress */}
      <WizardProgress currentStep={currentStep} />

      {/* Submitted notice — replaces Save-later bar when session is read-only.
          CLI 26 (2026-06-01): expanded copy to point families to admissions email
          when they need changes — the wizard cannot reopen a submitted
          application; only KMS staff can transition it back to NEEDS_MORE_INFO. */}
      {isSubmitted ? (
        <>
        <div style={{
          background: '#e8f5e9', borderBottom: '2px solid #43a047',
          padding: '12px 20px', display: 'flex', alignItems: 'flex-start', gap: 12,
          color: '#1b5e20', fontSize: '0.9rem',
        }}>
          <i className="bi bi-check-circle-fill" style={{ fontSize: '1.2rem', marginTop: 2 }} />
          <div>
            <div style={{ fontWeight: 700, marginBottom: 2 }}>
              {/* P216: real admission state (sysStates_T designation), not the
                  binary "enviada". Falls back to the legacy title pre-resume. */}
              {admissionState?.state_label
                ? t('submitted.real_state', { state: admissionState.state_label })
                : t('submitted.locked.title')}
            </div>
            <div style={{ fontWeight: 400 }}>
              {/* P-BANNER: cuerpo state-aware (AD→sigue con la firma, IN→falta info,
                  resto→genérico "en revisión"). Fallback i18n al body genérico para
                  cualquier state_code sin copy dedicado. El título ya es state-aware (P216). */}
              {admissionState?.state_code
                ? t('submitted.body_by_state.' + admissionState.state_code, t('submitted.locked.body'))
                : t('submitted.locked.body')}
            </div>
            {/* WIZ-NAV-CANON (Diego 2026-06-11): el banner rojo "confirma tu email" se
                ELIMINÓ como BLOQUEADOR de navegación. La identidad del firmante NO es una
                precondición de navegar — "si no me identifica bien en el paso 7 no debería
                dejarme pasar del 1 al 2 tampoco". El aviso de "no pudimos identificarte,
                entra desde tu enlace" solo puede surgir EN el acto que falle (Steps 8-10),
                resuelto server-side del resume_token (requireSignerContext_, @157). Aquí
                showRedBanner es constante false. */}

            {/* DL-E38 merge (flujo continuo 1→11, Diego 2026-06-07): el avance a la
                firma deja de ser un salto a /sign con un botón verde especial. Ahora
                es el "Siguiente" estándar del wizard que avanza currentStep 7→8 INLINE
                (Steps 8-11 renderizan los componentes funcionales de firma dentro del
                propio wizard — ver Step8Billing..Step11Sign). La PUERTA al Step 8 sigue
                siendo state-driven: estado AD + sesión de firma del grupo existe
                (`signing_ready`) + no COMPLETED. El CLICK resuelve el signing_token
                per-guardian (signingContext, server-side, KAL-4) y entra a la firma;
                si no está resuelto (raro multi-guardian ambiguo) muestra el toast
                recuperable — NUNCA entra a firmar sin identidad (GDPR es per-guardian).
                KAL-7: el token NUNCA va en la URL — vive en React state + props. La
                identidad legalmente vinculante sigue en el ACTO de firma
                (requireSigningToken_, P222) — sin cambios. */}
            {/* WIZARD — nav arriba/abajo (Diego 2026-06-07): el botón de avance a
                la firma ya NO vive en este banner. Ahora lo renderiza el panel del
                Step 7 (Step7Review) ARRIBA y ABAJO, en las mismas ubicaciones que
                los StepNav de los pasos 1-6 (via onAdvanceToSigning + canAdvance
                ToSigning, gobernado por estado AD + signing_ready). Evita el botón
                suelto descolocado en el banner. */}

            {/* P215 opción (b) ELIMINADA (CLI AD-SPLIT): el selector in-app
                "¿quién eres?" queda descartado por razón legal (auto-declaración de
                identidad antes del acto de firma). Familias con ≥2 guardians se
                resuelven por el recovery link per-guardian (cada guardian recupera
                con SU email → Vía 1 deriva su signing_token, sin selector). */}

            {/* WIZARD-STEP7-COMPLETED (2026-06-07): expediente Admitido (AD) y la
                firma YA COMPLETADA (todos los guardians firmaron / sesión terminal
                COMPLETED). Antes este caso caía al banner "firma en preparación"
                para siempre, porque los resolvers del puente de entrada filtran
                signers !signed_at → 0 elegibles y la sesión terminal por el filtro
                non-terminal → signing_available=false + sin candidatos. El backend
                ahora expone admission.signing_status='COMPLETED' (aditivo) y aquí
                mostramos un estado terminal de ÉXITO en lugar del banner mudo. NO
                toca el modelo de autorización (KAL-4). */}
            {currentStep === 6
              && admissionState?.state_code === 'AD'
              && admissionState?.signing_status === 'COMPLETED' && (
              <div
                style={{
                  marginTop: 12, display: 'flex', alignItems: 'flex-start', gap: 8,
                  background: '#e8f5e9', border: '1px solid #a5d6a7', borderRadius: 8,
                  padding: '10px 12px', color: '#1b5e20', fontSize: '0.88rem',
                }}
              >
                <i className="bi bi-check-circle-fill" style={{ marginTop: 2, color: '#2e7d32' }} />
                <div>
                  <div style={{ fontWeight: 700 }}>{t('wizard.signing_completed_title')}</div>
                  <div style={{ marginTop: 2 }}>{t('wizard.signing_completed_body')}</div>
                </div>
              </div>
            )}

            {/* WIZARD — AD unlocks step 8 (Option A, 2026-06-07): expediente Admitido
                (AD) pero la sesión de firma TODAVÍA NO existe a nivel de grupo
                (signing_ready=false ⟺ signing_status='NOT_INITIATED') y NO está
                completada. Este es el ÚNICO caso en que el avance permanece bloqueado:
                la firma aún no se ha iniciado server-side (P200/P201). Antes este
                banner se mostraba también cuando la firma SÍ estaba lista pero el
                token per-guardian no se había resuelto (multi-guardian ambiguo) →
                puerta cerrada para siempre. Ahora el gate es la EXISTENCIA de la
                sesión (la puerta = estado AD + sesión), no la resolución per-guardian
                — esa identidad vive en el ACTO de firma (/sign, P222), no en la puerta.
                NO toca el modelo de autorización (KAL-4: el signing_token sigue
                server-side). */}
            {showYellowBanner && (
              <div
                style={{
                  marginTop: 12, display: 'flex', alignItems: 'flex-start', gap: 8,
                  background: '#fff8e1', border: '1px solid #ffe082', borderRadius: 8,
                  padding: '10px 12px', color: '#7a5c00', fontSize: '0.85rem',
                }}
              >
                <i className="bi bi-hourglass-split" style={{ marginTop: 2 }} />
                <span>{t('submitted.signing_preparing')}</span>
              </div>
            )}
          </div>
        </div>
        {/* REBUILD-8-11 (2026-06-11): la nube de guardado post-submit vive en la MISMA
            wizard-header-bar y POSICIÓN que en los pasos 1-7 (una sola nube en pantalla
            — la instancia que BILLING-EDIT causa 2 metió dentro del header verde se
            integra aquí). Los botones save-later/abandonar no aplican a una solicitud
            enviada → huecos vacíos para conservar el layout homogéneo de la barra. */}
        <div className="wizard-header-bar" style={{ display: 'flex', gap: 12, justifyContent: 'space-between', alignItems: 'center' }}>
          <span />
          <SaveIndicator />
          <span />
        </div>
        </>
      ) : (
        /* Save-later bar */
        <div className="wizard-header-bar" style={{ display: 'flex', gap: 12, justifyContent: 'space-between', alignItems: 'center' }}>
          <button className="save-later-btn" onClick={handleSaveLater}>
            <i className="bi bi-bookmark" /> {t('wizard.save_later')}
          </button>

          {/* WPERF-1 criterios 2+3: indicador global estilo Google Docs (3 estados +
              botón Reintentar en error), extraído a su propio componente. Vive aquí, en
              la barra superior, FUERA de los botones de paso. NUNCA bloquea la navegación. */}
          <SaveIndicator />

          <button
            onClick={handleStartOver}
            disabled={abandoning}
            style={{
              background: 'transparent',
              border: 'none',
              color: '#a02020',
              fontSize: '0.85rem',
              cursor: abandoning ? 'wait' : 'pointer',
              padding: '6px 10px',
              textDecoration: 'underline',
            }}
          >
            <i className="bi bi-arrow-counterclockwise" /> {t('wizard.abandon_link')}
          </button>
        </div>
      )}

      {/* UX-1: resumen de validación en la zona sticky superior (antes salía al pie de
          cada paso). El step eleva su aviso al contexto (validationError); aquí se pinta. */}
      {validationError && (
        <div role="alert" aria-live="assertive" style={{
          background: '#ffeaea', borderBottom: '2px solid #a02020',
          padding: '10px 20px', display: 'flex', alignItems: 'center', gap: 8,
          color: '#a02020', fontSize: '0.9rem',
        }}>
          <i className="bi bi-exclamation-triangle-fill" />
          <span>{validationError}</span>
        </div>
      )}
      </div>{/* /wizard-sticky-top (UX-1) */}

      {/* Step content — DL-C-B (b): durante la rehidratación pintamos el shell
          (header + progress, ya arriba) + un StepSkeleton en el área de contenido,
          en vez de un overlay opaco que tapa todo. El primer paint es inmediato; el
          store se rellena cuando llega el hydrate. */}
      <div className={`wizard-body${isWideStep ? ' wizard-body--wide' : ''}`}>
        {/* SPEC-WIZ-SHELL (cold-load spec §2): el shell (header + WizardProgress, en
            la zona sticky de arriba) pinta al instante, antes de que resuelva el
            hydrate/fetchQuestions. Durante la rehidratación mostramos en el área de
            contenido el LOADER ROTATIVO de IMPL-E (LoadingSpinner, mensajes
            tranquilizadores) SOBRE el StepSkeleton — REUSANDO el mismo componente del
            loader de resume (líneas ~463), no se inventa uno nuevo. Invariantes §2: no
            muestra PII (solo esqueleto + spinner) y no permite interacción que dispare
            un save antes de tener datos (el StepComponent interactivo no se monta hasta
            !rehydrating). El early-return neutro de sesión recuperada por magic-link
            (WIZARD-GATE-ORDER, arriba) queda intacto — su gate de seguridad no cambia. */}
        {rehydrating ? (
          <>
            <LoadingSpinner variant="inline" messages={['resume.loading', 'loading.rotating.2', 'loading.rotating.3']} />
            <StepSkeleton rows={6} />
          </>
        ) : (
        <StepComponent
          onNext={handleNext}
          onBack={handleBack}
          locked={completedSteps.has(currentStep)}
          onUnlock={isSubmitted ? null : handleUnlock}
          savePending={hasPendingSave}
          /* DL-E38 merge + REBUILD-8-11: props para los Steps 8-11 de firma inline.
             onAdvance mueve currentStep SIN saveStep (cada step de firma persiste vía
             su propio endpoint, encolado en la MISMA cola FIFO → misma nube).
             signingToken/signerCtx alimentan los pasos reconstruidos en steps/Step8..11.
             Ignorados por los Steps 1-7. */
          onAdvance={advanceSigningStep}
          signingToken={signingContext?.signing_token || null}
          /* WIZ-NAV-CANON: el resume_token de SESIÓN es la identidad canónica que los
             actos de firma (Steps 8-11) reenvían al backend; éste resuelve el firmante
             server-side (requireSignerContext_ + binding, @157). El signing_token del
             cliente queda como back-compat opcional, NUNCA como precondición de entrar. */
          resumeToken={resumeToken}
          signerCtx={signerCtx}
          /* DL-B §1: el reparto de billing YA GUARDADO viene en la hidratación
             consolidada → el Step 8 lo consume del store en vez de hacer una lectura
             getSavedBillingSplits por-entrada. null = aún no hidratado (cae a su fetch). */
          savedSplits={billingSplits}
          /* DL-E38 merge: Step 7 advance-to-signing (state-driven). The Step 7
             panel renders the same "Continuar" action TOP and BOTTOM (mirroring the
             standard StepNav positions of steps 1-6) when the file is Approved (AD),
             the group signing session exists (signing_ready) and is not COMPLETED.
             enterSigning resolves the per-guardian signing_token server-side (KAL-4)
             and advances INLINE to Step 8. */
          onAdvanceToSigning={enterSigning}
          canAdvanceToSigning={canAdvance}
        />
        )}
      </div>

      <Toast message={toastMsg} />
      <LegalFooter />
    </div>
  );
}
