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
export default function Step9Gdpr({ onAdvance, onBack, signingToken, signerCtx }) {
  const { t, i18n } = useTranslation();

  if (!signingToken) {
    return (
      <div className="kis-card" style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--muted)' }}>
        <p style={{ fontSize: '1.6rem', marginBottom: 12 }} aria-hidden="true">🔒</p>
        <p style={{ margin: 0 }}>{t('step.gdpr.locked.body')}</p>
        <div style={{ marginTop: 24 }}>
          <button className="btn-secondary-kis" onClick={onBack}>
            <i className="bi bi-arrow-left me-1" /> {t('nav.back')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <SignGdpr
      signingToken={signingToken}
      signerCtx={signerCtx}
      lang={lang_(i18n)}
      onDone={onAdvance}
      onBack={onBack}
    />
  );
}
