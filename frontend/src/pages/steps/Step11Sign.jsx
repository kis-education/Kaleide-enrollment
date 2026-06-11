import { SignSign } from '../signing/SigningSteps';

/**
 * Step 11 — S-SIGN (Firma electrónica Click & Sign).
 *
 * DL-E38 merge (flujo continuo 1→11): paso TERMINAL del wizard. Renderiza el
 * componente FUNCIONAL `SignSign` (el mismo que /sign usa vía SigningSteps),
 * autenticado por el `signing_token` per-guardian resuelto al entrar (server-side,
 * KAL-4). Incluye el gate INCONDICIONAL de step-up (DL-E39) + IP forense (DL-E39) +
 * polling del estado de la sesión Click & Sign. No avanza (es el último paso);
 * "Atrás" vuelve al Step 10 (onBack). La pantalla de éxito es terminal.
 *
 * El trabajo funcional vive en pages/signing/SigningSteps.jsx — NO se duplica aquí.
 */
export default function Step11Sign({ onBack, signingToken, resumeToken, signerCtx }) {
  // WIZ-NAV-CANON (Diego 2026-06-11): sin gate de signing_token del cliente como puerta de
  // navegación. La navegación la gobierna el estado (WizardPage). El ACTO de firma Click &
  // Sign (SignSign) sigue siendo la frontera real — su identidad/irreductibilidad la
  // resuelve el backend; si no se puede identificar al firmante, el error vive EN el acto,
  // nunca como puerta del paso previo.
  return (
    <SignSign
      signingToken={signingToken}
      resumeToken={resumeToken}
      signerCtx={signerCtx || {}}
      onBack={onBack}
      onDone={() => { /* terminal — stays on success screen */ }}
    />
  );
}
