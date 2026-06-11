// ─────────────────────────────────────────────────────────────────────────────
// STEP-FRAMEWORK (Diego 2026-06-11) — Catálogo DECLARATIVO de pasos del wizard.
//
// Cita de Diego: "Se pierde la lógica de los pasos 1-7 en los 8-11. […] Tienes que
// unificar. Yo simplificaría: catálogo de pasos, elementos reutilizables en cada paso.
// Para otros programas (campamentos, etc.) te va a venir bien."
//
// Este archivo es la PRIMERA instancia del catálogo: el programa de ADMISIONES KIS
// (11 pasos canónicos). La estructura queda lista para que OTRO programa (campamentos,
// etc.) declare el suyo simplemente exportando otro array con la misma forma — el
// chasis único (StepShell + WizardPage) no cambia, solo consume el catálogo.
//
// CADA paso es un ciudadano IDÉNTICO: el mismo chasis le da guardado optimista con
// nube (SaveIndicator global + cola FIFO de WizardContext), candado por estado real,
// navegación estándar (Atrás/Continuar), validación inline y precarga al entrar. Los
// pasos 8-11 (firma) dejan de ser "tratados de forma diferenciada" — son pasos como
// los demás, con su savePolicy declarada.
//
// FORMA DE UN PASO:
//   {
//     id:         clave estable del paso ('email', 's_billing', …) — = stepData key / saveStep step
//     labelKey:   i18n key del título del stepper
//     component:  el componente React del cuerpo del paso
//     savePolicy: 'wizard' | 'act' | 'none'
//                  - 'wizard': guardado optimista vía saveStep (/apply, pasos 1-6).
//                    El chasis (WizardPage.handleNext) encola el save y avanza al
//                    instante; la nube global muestra el estado.
//                  - 'act':    el paso PERSISTE vía su propio endpoint de acto
//                    (saveBillingInfo / submitGdprConsents / confirmReview /
//                    initiateSigningSession), también en BACKGROUND vía la MISMA cola
//                    (setPendingSave → enqueueSave) → la MISMA nube global. El acto
//                    decide la identidad del firmante server-side (KAL-4). Regla de
//                    oro del acto: fallo VISIBLE inline, jamás éxito falso.
//                  - 'none':   paso sin persistencia propia (review pre-submit, sign
//                    terminal). El submit del Step 7 es el envío; el Step 11 es el acto
//                    terminal de firma (su propia frontera bloqueante).
//     lockPolicy: 'completed' | 'state' | 'never'
//                  - 'completed': se bloquea cuando el paso está en completedSteps
//                    (patrón LockedBanner "sección guardada y bloqueada", pasos 1-6).
//                  - 'state':     editabilidad gobernada por el estado real del
//                    expediente (post-submit / firma) — el candado lo decide
//                    isSubmitted / admissionState, no la navegación local.
//                  - 'never':     nunca se bloquea localmente (Step 7 Review, que ya
//                    refleja estado real; Step 11 Sign terminal).
//     preload:    array de claves de precarga a disparar AL ENTRAR al paso (el chasis
//                  las ejecuta best-effort). Hoy: 'documents' (paquete contractual del
//                  Step 10 — members + bytes — para que pinte sin "vuelve en unos
//                  minutos"). Vacío = sin precarga.
//   }
//
// Los nombres/propósito de los 11 pasos vienen del roadmap canónico
// (docs/kms/plan/wizard-admissions-roadmap.md líneas 17-27 + DL-E24 §3 + DL-E27 +
// DL-E28). NO inventar pasos extra (ver §"Wizard structure" en CLAUDE.md).
// ─────────────────────────────────────────────────────────────────────────────

import Step1Email      from './Step1Email';
import Step2Persons    from './Step2Persons';
import Step3Relations  from './Step3Relations';
import Step4Health     from './Step4Health';
import Step5Questions  from './Step5Questions';
import Step6Documents  from './Step6Documents';
import Step7Review     from './Step7Review';
import Step8Billing    from './Step8Billing';
import Step9Gdpr       from './Step9Gdpr';
import Step10Review    from './Step10Review';
import Step11Sign      from './Step11Sign';

/**
 * Catálogo de pasos del programa ADMISIONES KIS — 11 pasos canónicos.
 * Primera instancia del catálogo declarativo. Otros programas exportarían otro array.
 */
export const ADMISSIONS_STEPS = [
  // ── Pasos 1-7: wizard pre-AD (familia anónima, /apply, resume_token) ──────────
  { id: 'email',      labelKey: 'step.email',                component: Step1Email,     savePolicy: 'wizard', lockPolicy: 'completed', preload: [] },
  { id: 'persons',    labelKey: 'step.persons',              component: Step2Persons,   savePolicy: 'wizard', lockPolicy: 'completed', preload: [] },
  { id: 'relations',  labelKey: 'step.relations',            component: Step3Relations, savePolicy: 'wizard', lockPolicy: 'completed', preload: [] },
  { id: 'health',     labelKey: 'step.health',               component: Step4Health,    savePolicy: 'wizard', lockPolicy: 'completed', preload: [] },
  { id: 'questions',  labelKey: 'step.questions',            component: Step5Questions, savePolicy: 'wizard', lockPolicy: 'completed', preload: [] },
  { id: 'documents',  labelKey: 'step.documents',            component: Step6Documents, savePolicy: 'wizard', lockPolicy: 'completed', preload: [] },
  { id: 'review',     labelKey: 'step.review',               component: Step7Review,    savePolicy: 'none',   lockPolicy: 'never',     preload: [] },
  // ── Pasos 8-11: firma post-AD (mismo chasis; cada acto persiste vía su endpoint) ─
  { id: 's_billing',  labelKey: 'step.billing.title',        component: Step8Billing,   savePolicy: 'act',    lockPolicy: 'state',     preload: [] },
  { id: 's_gdpr',     labelKey: 'step.gdpr.title',           component: Step9Gdpr,      savePolicy: 'act',    lockPolicy: 'state',     preload: [] },
  // Step 10: precarga del paquete contractual (members + doc URLs) AL ENTRAR → render
  // dinámico de los members sin "vuelve en unos minutos" (espera activa con reintento).
  { id: 's_review',   labelKey: 'step.signing_review.title', component: Step10Review,   savePolicy: 'act',    lockPolicy: 'state',     preload: ['documents'] },
  { id: 's_sign',     labelKey: 'step.signing.title',        component: Step11Sign,     savePolicy: 'none',   lockPolicy: 'never',     preload: [] },
];

/** Índice 0-based del primer paso de firma (Step 8). Derivado del catálogo. */
export const FIRST_SIGNING_INDEX = ADMISSIONS_STEPS.findIndex(s => s.savePolicy === 'act');

/** El catálogo activo del wizard. Cambiar esta línea = cambiar de programa. */
export const STEP_CATALOG = ADMISSIONS_STEPS;

/** Array de componentes (compat con el viejo STEP_COMPONENTS de WizardPage). */
export const STEP_COMPONENTS = STEP_CATALOG.map(s => s.component);
