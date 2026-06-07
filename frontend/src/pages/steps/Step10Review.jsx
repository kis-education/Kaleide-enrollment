import { useTranslation } from 'react-i18next';
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
export default function Step10Review({ onAdvance, onBack, signingToken }) {
  const { t } = useTranslation();

  if (!signingToken) {
    return (
      <div className="kis-card" style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--muted)' }}>
        <p style={{ fontSize: '1.6rem', marginBottom: 12 }} aria-hidden="true">🔒</p>
        <p style={{ margin: 0 }}>{t('step.signing_review.locked.body')}</p>
        <div style={{ marginTop: 24 }}>
          <button className="btn-secondary-kis" onClick={onBack}>
            <i className="bi bi-arrow-left me-1" /> {t('nav.back')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <SignReview
      signingToken={signingToken}
      onDone={onAdvance}
      onBack={onBack}
    />
  );
}
