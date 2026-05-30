import { useTranslation } from 'react-i18next';

/**
 * Step 10 — S-REVIEW (Revisión Carta de Admisión + Contrato + confirmación lectura).
 *
 * Canónico per DL-E28 §6 + roadmap. Se desbloquea post-AD.
 *
 * Incluye visualización de la decisión de admisión dentro del propio step (NO existe
 * un "Step Decision" separado — CLI 22/Frontend-9-10 lo inventaron erróneamente).
 *
 * TODO: implementación real cuando exista el endpoint backend `enr.confirmReview`
 * — viewer PDF de la Carta de Admisión y del Contrato + checkbox "He leído y comprendo
 * el contenido de ambos documentos". Por ahora placeholder informativo locked.
 */
export default function Step10Review({ onBack }) {
  const { t } = useTranslation();

  return (
    <div>
      <h1 style={{ color: 'var(--teal-dk)', fontWeight: 800, marginBottom: 8 }}>
        {t('step.signing_review.title')}
      </h1>
      <p style={{ color: 'var(--muted)', marginBottom: 24 }}>
        {t('step.signing_review.subtitle')}
      </p>

      <div
        className="kis-card"
        style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--muted)' }}
        aria-live="polite"
      >
        <p style={{ fontSize: '1.6rem', marginBottom: 12 }} aria-hidden="true">🔒</p>
        <p style={{ margin: '0 0 8px', fontWeight: 600, color: 'var(--text)' }}>
          {t('step.signing_review.locked.title')}
        </p>
        <p style={{ margin: 0, fontSize: '0.92rem' }}>
          {t('step.signing_review.locked.body')}
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
