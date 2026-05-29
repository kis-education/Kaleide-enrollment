import { useTranslation } from 'react-i18next';
import { STEPS } from '../../context/WizardContext';
import { useWizard } from '../../context/WizardContext';

export default function WizardStepPlaceholder({ onBack }) {
  const { t }           = useTranslation();
  const { currentStep } = useWizard();
  const step            = STEPS[currentStep];

  return (
    <div>
      <h1 style={{ color: 'var(--teal-dk)', fontWeight: 800, marginBottom: 24 }}>
        {t(step?.labelKey || 'step.placeholder')}
      </h1>
      <div className="kis-card" style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--muted)' }}>
        <p style={{ fontSize: '1.2rem', marginBottom: 8 }}>🔒</p>
        <p style={{ margin: 0 }}>{t('step.placeholder_body')}</p>
      </div>
      <div style={{ marginTop: 24 }}>
        <button className="btn-secondary-kis" onClick={onBack}>
          <i className="bi bi-arrow-left me-1" /> {t('nav.back')}
        </button>
      </div>
    </div>
  );
}
