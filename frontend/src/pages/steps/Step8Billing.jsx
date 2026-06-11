import { SignBilling } from '../signing/SigningSteps';

/**
 * Step 8 — S-BILLING (Datos fiscales del responsable del pago).
 *
 * DL-E38 merge (flujo continuo 1→11): este step ya NO es un placeholder. Renderiza
 * el componente FUNCIONAL `SignBilling` (el mismo que /sign usa vía SigningSteps),
 * autenticado por el `signing_token` per-guardian ya resuelto al entrar (server-side,
 * KAL-4). El submit del componente (saveBillingInfo) ES el "Siguiente" de este paso;
 * al completar avanza `currentStep` (onNext) y "Atrás" vuelve al Step 7 (onBack).
 *
 * El trabajo funcional vive en pages/signing/SigningSteps.jsx — NO se duplica aquí.
 */
export default function Step8Billing({ onAdvance, onBack, signingToken, resumeToken, signerCtx, savedSplits }) {
  // WIZ-NAV-CANON (Diego 2026-06-11): este paso ya NO se bloquea por la ausencia de
  // signing_token en el cliente. La navegación 7→8 la gobierna SOLO el estado (WizardPage
  // canAdvance); aquí siempre renderizamos el acto. La identidad del firmante la resuelve
  // el BACKEND a partir del resume_token de sesión (requireSignerContext_, @157). Si no se
  // pudiese identificar al firmante, el error vive EN el acto (SignBilling), no como puerta.
  return (
    <SignBilling
      signingToken={signingToken}
      resumeToken={resumeToken}
      signerCtx={signerCtx}
      savedSplits={savedSplits}
      onDone={onAdvance}
      onBack={onBack}
    />
  );
}
