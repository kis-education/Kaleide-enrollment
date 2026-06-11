import { useTranslation } from 'react-i18next';
// #11 (catálogo único de nombres de pasos): el stepper lee del MISMO catálogo
// declarativo que el resto del wizard (steps/catalog.js). La lista STEPS duplicada
// que vivía en WizardContext fue eliminada — dos fuentes divergían ("Resumen" vs
// "Revisar y enviar").
import { STEP_CATALOG } from '../pages/steps/catalog';

export default function WizardProgress({ currentStep }) {
  const { t } = useTranslation();

  return (
    <div className="wizard-progress">
      <div className="wizard-steps">
        {STEP_CATALOG.map((step, idx) => {
          const state =
            idx < currentStep  ? 'completed' :
            idx === currentStep ? 'active'    : '';
          return (
            <div key={step.id} className={`wizard-step ${state}`}>
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
