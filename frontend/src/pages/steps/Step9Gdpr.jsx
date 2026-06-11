import { useTranslation } from 'react-i18next';
import { SignGdpr, lang_ } from '../signing/SigningSteps';

/**
 * Step 9 — S-GDPR (7 consentimientos GDPR por guardian + TSA).
 *
 * DL-E38 merge (flujo continuo 1→11): renderiza el componente FUNCIONAL `SignGdpr`
 * (el mismo que /sign usa vía SigningSteps), autenticado por el `signing_token`
 * per-guardian resuelto al entrar (server-side, KAL-4 — los consentimientos quedan
 * vinculados al guardian conocido). El submit (submitGdprConsents) ES el "Siguiente";
 * al completar avanza `currentStep` (onAdvance) y "Atrás" vuelve al Step 8 (onBack).
 *
 * El trabajo funcional vive en pages/signing/SigningSteps.jsx — NO se duplica aquí.
 */
export default function Step9Gdpr({ onAdvance, onBack, signingToken, resumeToken, signerCtx }) {
  const { i18n } = useTranslation();

  // WIZ-NAV-CANON (Diego 2026-06-11): sin gate de signing_token del cliente. La navegación
  // la gobierna el estado (WizardPage); la identidad del firmante la resuelve el backend del
  // resume_token de sesión (requireSignerContext_, @157). El error de identidad, si lo hay,
  // vive EN el acto (submitGdprConsents), no como puerta de navegación.
  return (
    <SignGdpr
      signingToken={signingToken}
      resumeToken={resumeToken}
      signerCtx={signerCtx}
      lang={lang_(i18n)}
      onDone={onAdvance}
      onBack={onBack}
    />
  );
}
