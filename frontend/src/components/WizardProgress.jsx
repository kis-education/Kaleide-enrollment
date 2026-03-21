import { useTranslation } from 'react-i18next';
import { STEPS } from '../context/WizardContext';

export default function WizardProgress({ currentStep }) {
  const { t } = useTranslation();

  return (
    <div className="wizard-progress">
      <div className="wizard-steps">
        {STEPS.map((step, idx) => {
          const state =
            idx < currentStep  ? 'completed' :
            idx === currentStep ? 'active'    : '';
          return (
            <div key={step.key} className={`wizard-step ${state}`}>
              {idx > 0 && (
                <div className={`step-connector ${idx <= currentStep ? 'completed' : ''}`} />
              )}
              <div className="step-num">
                {idx < currentStep
                  ? <i className="bi bi-check" />
                  : idx + 1
                }
              </div>
              <span className="d-none d-sm-inline">{t(step.labelKey)}</span>
            </div>
          );
        })}
      </div>
    </div>
  );
}
