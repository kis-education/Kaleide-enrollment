import { useTranslation } from 'react-i18next';

/**
 * Step 9 — S-GDPR (7 consentimientos GDPR por guardian + TSA).
 *
 * Canónico per DL-E27 + roadmap. Se desbloquea post-AD.
 *
 * TODO: implementación real cuando exista el endpoint backend `enr.submitGdprConsents`
 * (helper `sys_recordConsent_`) — checklist de 7 consentimientos por cada tutor más
 * stamp TSA timestamp. Por ahora placeholder informativo locked.
 */
export default function Step9Gdpr({ onBack }) {
  const { t } = useTranslation();

  return (
    <div>
      <h1 style={{ color: 'var(--teal-dk)', fontWeight: 800, marginBottom: 8 }}>
        {t('step.gdpr.title')}
      </h1>
      <p style={{ color: 'var(--muted)', marginBottom: 24 }}>
        {t('step.gdpr.subtitle')}
      </p>

      <div
        className="kis-card"
        style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--muted)' }}
        aria-live="polite"
      >
        <p style={{ fontSize: '1.6rem', marginBottom: 12 }} aria-hidden="true">🔒</p>
        <p style={{ margin: '0 0 8px', fontWeight: 600, color: 'var(--text)' }}>
          {t('step.gdpr.locked.title')}
        </p>
        <p style={{ margin: 0, fontSize: '0.92rem' }}>
          {t('step.gdpr.locked.body')}
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
