import { useTranslation } from 'react-i18next';

/**
 * Step 11 — S-SIGN (Firma electrónica Click & Sign).
 *
 * Canónico per DL-E28 §7-§13 + P50 + roadmap. Es el último paso del wizard.
 * Se desbloquea post-AD (admisión decisión).
 *
 * La transferencia bancaria de reserva es una acción POST-firma (no un step del
 * wizard) — CLI 22/Frontend-12 lo inventaron erróneamente como Step 12 Deposit.
 *
 * Placeholder PERMANENTE — el flujo real de firma Click & Sign (signerUrls +
 * polling de estado) vive en SigningWizardPage (`/sign?signing_token=X`,
 * pages/signing/SigningSteps.jsx → SignSign). Estos steps de `/apply` son
 * post-submit y NUNCA se desbloquean por diseño (DL-E15 + CLI 45).
 */
export default function Step11Sign({ onBack }) {
  const { t } = useTranslation();

  return (
    <div>
      <h1 style={{ color: 'var(--teal-dk)', fontWeight: 800, marginBottom: 8 }}>
        {t('step.signing.title')}
      </h1>
      <p style={{ color: 'var(--muted)', marginBottom: 24 }}>
        {t('step.signing.subtitle')}
      </p>

      <div
        className="kis-card"
        style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--muted)' }}
        aria-live="polite"
      >
        <p style={{ fontSize: '1.6rem', marginBottom: 12 }} aria-hidden="true">🔒</p>
        <p style={{ margin: '0 0 8px', fontWeight: 600, color: 'var(--text)' }}>
          {t('step.signing.locked.title')}
        </p>
        <p style={{ margin: 0, fontSize: '0.92rem' }}>
          {t('step.signing.locked.body')}
        </p>
      </div>

      <div style={{ marginTop: 24 }}>
        <button className="btn-secondary-kis" onClick={onBack}>
          <i className="bi bi-arrow-left me-1" /> {t('nav.back')}
        </button>
      </div>
    </div>
  );
}
