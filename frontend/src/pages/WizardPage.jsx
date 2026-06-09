import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useWizard } from '../context/WizardContext';
import * as log from '../logger';
import { gasCall, prefetchLookups, prefetchDocuments } from '../api';
import LangToggle from '../components/LangToggle';
import SaveIndicator from '../components/SaveIndicator';
import LoadingSpinner from '../components/LoadingSpinner';
import StepSkeleton from '../components/StepSkeleton';  // DL-C-B (b): render progresivo durante la rehidratación
import LegalFooter from '../components/LegalFooter';
import WizardProgress from '../components/WizardProgress';
import StepUpReverify from '../components/StepUpReverify';
import StepUpGate from '../components/StepUpGate';
import { Toast, useToast } from '../components/Toast';

import Step1Email      from './steps/Step1Email';
import Step2Persons    from './steps/Step2Persons';
import Step3Relations  from './steps/Step3Relations';
import Step4Health     from './steps/Step4Health';
import Step5Questions  from './steps/Step5Questions';
import Step6Documents  from './steps/Step6Documents';
import Step7Review     from './steps/Step7Review';
import Step8Billing    from './steps/Step8Billing';
import Step9Gdpr       from './steps/Step9Gdpr';
import Step10Review    from './steps/Step10Review';
import Step11Sign      from './steps/Step11Sign';
import { initialSubStep } from './signing/SigningSteps';

const LOGO = 'https://raw.githubusercontent.com/kaleideschool/public/main/favicon.png';

// 11 steps canónicos (CLI 59 — roadmap líneas 17-27 + DL-E24 §3 + DL-E27 + DL-E28).
// Steps 1-7 reales pre-AD, 8-11 placeholders locked post-AD.
const STEP_COMPONENTS = [
  Step1Email,     // 1
  Step2Persons,   // 2
  Step3Relations, // 3
  Step4Health,    // 4
  Step5Questions, // 5
  Step6Documents, // 6
  Step7Review,    // 7
  Step8Billing,   // 8  — S-BILLING (placeholder hasta P49 + enr.saveBillingInfo)
  Step9Gdpr,      // 9  — S-GDPR    (placeholder hasta DL-E27 + enr.submitGdprConsents)
  Step10Review,   // 10 — S-REVIEW  (placeholder hasta DL-E28 §6 + enr.confirmReview)
  Step11Sign,     // 11 — S-SIGN    (placeholder hasta DL-E28 §7-§13 + enr.initiateSigningSession)
];

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
    setPendingSave, enqueueSave, awaitPendingSave, hasPendingSave, saveState,
    validationError, setValidationError,                          // UX-1 aviso sticky
    markUserTookControl, resetUserTookControl, userTookControlRef, // WPERF-1 criterio 4
    isSubmitted,
    admissionState, signingContext,
    billingSplits, liveVersion, setLiveVersion, // DL-B §1/§2
    markStepUpFresh,
    isStepUpFresh, recoveredViaMagicLink,
    otpAutoSentForRecovery, markOtpAutoSentForRecovery, // OTP-TRIGGER
    recoveredEmail, setRecoveredEmail,
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

  // Kick off lookup prefetch immediately so Step3/Step4 get cached lookups. El
  // catálogo de PREGUNTAS ya NO se prefetcha suelto (DL-C-B g): viene plegado en el
  // hydrate (DL-C-A) y lo siembra hydrateFromResume → Step5/Step7 lo leen de cache.
  useEffect(() => { prefetchLookups(); }, []); // eslint-disable-line

  // WPERF-1 criterio "eager docs": si el expediente está Aprobado (AD) y la firma está
  // lista para este guardian (no completada), calienta el paquete contractual (members
  // + bytes getDocument ~40s) para que S-REVIEW pinte sin esperar. Best-effort: si el
  // step-up aún no está fresco, getDocument falla silenciosamente y la caché se purga
  // (re-fetch normal al llegar a Review). Se dispara solo para firmantes reales (no en
  // cada /apply) para no malgastar cuota GAS. KAL-7: el token vive en React state.
  useEffect(() => {
    if (admissionState?.state_code === 'AD'
        && admissionState?.signing_ready
        && admissionState?.signing_status !== 'COMPLETED'
        && signingContext?.signing_token) {
      prefetchDocuments(signingContext.signing_token);
    }
  }, [admissionState?.state_code, admissionState?.signing_ready, admissionState?.signing_status, signingContext?.signing_token]); // eslint-disable-line

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
  const pulseRef = useRef({ resumeToken: null, enrollmentGroupId: null, effectiveRecoveredEmail: undefined, hasPendingSave: false, liveVersion: 0 });
  pulseRef.current = { resumeToken, enrollmentGroupId, effectiveRecoveredEmail, hasPendingSave, liveVersion };
  const pulseInFlightRef = useRef(false);
  useEffect(() => {
    const tick = () => {
      const { resumeToken: rt, enrollmentGroupId: gid, effectiveRecoveredEmail: re, hasPendingSave: pending, liveVersion: knownVer } = pulseRef.current;
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
          return gasCall('getAdmissionState', { resume_token: rt, recovered_email: re || undefined })
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
      gasCall('hydrateSession', { resume_token: resumeToken, recovered_email: effectiveRecoveredEmail, language: i18n.language })
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
  const STEP_FIRST_SIGNING = 7;

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
    // DL-B §3 — autoridad de navegación ÚNICA, SIN JUMP. Eliminado el resolveSigningToken
    // async que saltaba currentStep al sub-paso "más avanzado" ~19s después del click
    // (causa del bug "al tocar billing salta al paso 11" y de pisar la pantalla del
    // usuario). Ahora el avance a la firma es una transición de paso NORMAL (7→8) que
    // gobierna el ESTADO (el botón solo aparece con AD + signing_ready, ver
    // canAdvanceToSigning); a partir de ahí el usuario avanza 8→9→10→11 él mismo.
    // El contexto del firmante (sub-pasos billing/gdpr/review/signed) YA viene en la
    // hidratación consolidada (signingContext.steps) — no hace falta resolveSigningToken.
    // KAL-7: el token vive en signingContext (React state), nunca en la URL.
    const token = signingContext?.signing_token;
    log.info('[DBG enterSigning] click (sin JUMP)', { has_token: !!token, admission_steps: signingContext && signingContext.steps });
    if (!token) {
      showToast(t('wizard.signing_confirm_email'));
      return;
    }
    markUserTookControl();
    if (signingContext) setSignerCtx(signingContext); // alimenta members/estado de los Steps 8-11
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
      await gasCall('sendMagicLink', {
        enrollment_group_id: enrollmentGroupId,
        application_id:      enrollmentGroupId, // legacy alias
      });
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
        tokenPayload={{ resume_token: resumeToken }}
        onVerified={() => {
          markStepUpFresh();
          // P-PII-GATE: la resumeSession previa al OTP llegó gateada (sin PII,
          // pre-step-up). Tras el OTP el backend marcó el grupo fresco (verifyEmail
          // stepup:true) → re-hidratamos para cargar la PII del expediente ahora
          // permitida. Sin esto el stepData quedaría vacío tras pasar el gate.
          gasCall('hydrateSession', { resume_token: resumeToken, recovered_email: effectiveRecoveredEmail, language: i18n.language })
            .then(data => { hydrateFromResume(data); log.success('WizardPage: rehydrate post step-up OK'); })
            .catch(err => log.error('WizardPage: rehydrate post step-up failed', { message: err.message }));
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
            {/* DL-C-B (c): expediente APROBADO (signing_available) pero SIN contexto de
                firma resuelto (signing_context:null — p.ej. la familia no recuperó por
                el email de su guardian) → mensaje claro guía a recuperar, en vez de un
                dead-end mudo en el Step 7. */}
            {admissionState?.signing_available && !signingContext && (
              <div style={{ marginTop: 8, fontWeight: 600, color: '#bf360c' }}>
                <i className="bi bi-info-circle" style={{ marginRight: 6 }} />
                {t('wizard.signing_confirm_email')}
              </div>
            )}

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
            {currentStep === 6
              && admissionState?.state_code === 'AD'
              && !admissionState?.signing_ready
              && admissionState?.signing_status !== 'COMPLETED' && (
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
      <div className="wizard-body">
        {rehydrating ? <StepSkeleton rows={6} /> : (
        <StepComponent
          onNext={handleNext}
          onBack={handleBack}
          locked={completedSteps.has(currentStep)}
          onUnlock={isSubmitted ? null : handleUnlock}
          savePending={hasPendingSave}
          /* DL-E38 merge: props para los Steps 8-11 de firma inline. onAdvance
             mueve currentStep SIN saveStep (cada step de firma persiste vía su
             propio endpoint). signingToken/signerCtx alimentan los componentes
             funcionales reutilizados de SigningSteps. Ignorados por los Steps 1-7. */
          onAdvance={advanceSigningStep}
          signingToken={signingContext?.signing_token || null}
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
          canAdvanceToSigning={
            currentStep === 6
            && admissionState?.state_code === 'AD'
            && admissionState?.signing_ready
            && admissionState?.signing_status !== 'COMPLETED'
          }
        />
        )}
      </div>

      <Toast message={toastMsg} />
      <LegalFooter />
    </div>
  );
}
