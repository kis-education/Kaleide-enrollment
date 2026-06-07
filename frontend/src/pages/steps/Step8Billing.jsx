import { useTranslation } from 'react-i18next';
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
export default function Step8Billing({ onAdvance, onBack, signingToken }) {
  const { t } = useTranslation();

  if (!signingToken) {
    return (
      <div className="kis-card" style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--muted)' }}>
        <p style={{ fontSize: '1.6rem', marginBottom: 12 }} aria-hidden="true">🔒</p>
        <p style={{ margin: 0 }}>{t('step.billing.locked.body')}</p>
        <div style={{ marginTop: 24 }}>
          <button className="btn-secondary-kis" onClick={onBack}>
            <i className="bi bi-arrow-left me-1" /> {t('nav.back')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <SignBilling
      signingToken={signingToken}
      onDone={onAdvance}
      onBack={onBack}
    />
  );
}
