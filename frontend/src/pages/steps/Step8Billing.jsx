import { useTranslation } from 'react-i18next';

/**
 * Step 8 — S-BILLING (Datos fiscales del responsable del pago).
 *
 * Canónico per roadmap (docs/kms/plan/wizard-admissions-roadmap.md líneas 17-27)
 * + DL-E27 §2/§4 + P49. Se desbloquea post-AD (admisión decisión).
 *
 * TODO: implementación real cuando exista el endpoint backend `enr.saveBillingInfo`
 * y la hoja `enrGroupBilling` (P49) — formulario con razón social, CIF/NIF, domicilio
 * fiscal y datos del pagador. Por ahora placeholder informativo locked.
 */
export default function Step8Billing({ onBack }) {
  const { t } = useTranslation();

  return (
    <div>
      <h1 style={{ color: 'var(--teal-dk)', fontWeight: 800, marginBottom: 8 }}>
        {t('step.billing.title')}
      </h1>
      <p style={{ color: 'var(--muted)', marginBottom: 24 }}>
        {t('step.billing.subtitle')}
      </p>

      <div
        className="kis-card"
        style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--muted)' }}
        aria-live="polite"
      >
        <p style={{ fontSize: '1.6rem', marginBottom: 12 }} aria-hidden="true">🔒</p>
        <p style={{ margin: '0 0 8px', fontWeight: 600, color: 'var(--text)' }}>
          {t('step.billing.locked.title')}
        </p>
        <p style={{ margin: 0, fontSize: '0.92rem' }}>
          {t('step.billing.locked.body')}
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
