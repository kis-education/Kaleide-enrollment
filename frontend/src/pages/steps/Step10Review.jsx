import { SignReview } from '../signing/SigningSteps';

/**
 * Step 10 — S-REVIEW (Revisión Carta de Admisión + Contrato + confirmación lectura).
 *
 * DL-E38 merge (flujo continuo 1→11): renderiza el componente FUNCIONAL `SignReview`
 * (el mismo que /sign usa vía SigningSteps), autenticado por el `signing_token`
 * per-guardian resuelto al entrar (server-side, KAL-4). Incluye el step-up DL-E39
 * antes de revelar el paquete contractual + el proxy de bytes (getDocument). El
 * submit (confirmReview) ES el "Siguiente"; al completar avanza `currentStep`
 * (onAdvance) y "Atrás" vuelve al Step 9 (onBack).
 *
 * El trabajo funcional vive en pages/signing/SigningSteps.jsx — NO se duplica aquí.
 */
export default function Step10Review({ onAdvance, onBack, signingToken, resumeToken }) {
  // WIZ-NAV-CANON (Diego 2026-06-11): sin gate de signing_token del cliente. La navegación
  // la gobierna el estado (WizardPage); la identidad del firmante la resuelve el backend del
  // resume_token de sesión (requireSignerContext_, @157). El error de identidad, si lo hay,
  // vive EN el acto (confirmReview / lectura del paquete), no como puerta de navegación.
  return (
    <SignReview
      signingToken={signingToken}
      resumeToken={resumeToken}
      onDone={onAdvance}
      onBack={onBack}
    />
  );
}
