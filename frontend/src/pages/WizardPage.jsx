import { useTranslation } from 'react-i18next';
import { useWizard } from '../context/WizardContext';
import { gasCall } from '../api';
import LangToggle from '../components/LangToggle';
import WizardProgress from '../components/WizardProgress';
import { Toast, useToast } from '../components/Toast';

import Step1Email     from './steps/Step1Email';
import Step2Guardians from './steps/Step2Guardians';
import Step3Applicants from './steps/Step3Applicants';
import Step4Health    from './steps/Step4Health';
import Step5Questions from './steps/Step5Questions';
import Step6Documents from './steps/Step6Documents';
import Step7Review    from './steps/Step7Review';

const LOGO = 'https://raw.githubusercontent.com/kaleideschool/public/main/favicon.png';

const STEP_COMPONENTS = [
  Step1Email,
  Step2Guardians,
  Step3Applicants,
  Step4Health,
  Step5Questions,
  Step6Documents,
  Step7Review,
];

export default function WizardPage() {
  const { t }                           = useTranslation();
  const { applicationId, currentStep, setCurrentStep, stepData } = useWizard();
  const { message: toastMsg, showToast } = useToast();

  const handleNext = async (stepKey, data) => {
    // Auto-save to backend
    if (applicationId && stepKey) {
      try {
        await gasCall('saveStep', { application_id: applicationId, step: stepKey, payload: data });
      } catch (_) { /* non-blocking */ }
    }
    setCurrentStep(s => Math.min(s + 1, STEP_COMPONENTS.length - 1));
    window.scrollTo(0, 0);
  };

  const handleBack = () => {
    setCurrentStep(s => Math.max(s - 1, 0));
    window.scrollTo(0, 0);
  };

  const handleSaveLater = async () => {
    if (!applicationId) return;
    try {
      await gasCall('sendMagicLink', { application_id: applicationId });
      showToast(t('wizard.save_later_sent'));
    } catch (_) {
      showToast(t('wizard.save_later_error'));
    }
  };

  const StepComponent = STEP_COMPONENTS[currentStep];

  return (
    <div className="wizard-layout">
      {/* Header */}
      <header className="kis-header">
        <div className="brand">
          <img src={LOGO} alt="KIS" />
          <div>
            <div className="brand-name">Kaleide International School</div>
            <div className="brand-sub">{t('landing.header_sub')}</div>
          </div>
        </div>
        <LangToggle />
      </header>

      {/* Progress */}
      <WizardProgress currentStep={currentStep} />

      {/* Save-later bar */}
      <div className="wizard-header-bar">
        <button className="save-later-btn" onClick={handleSaveLater}>
          <i className="bi bi-bookmark" /> {t('wizard.save_later')}
        </button>
      </div>

      {/* Step content */}
      <div className="wizard-body">
        <StepComponent
          onNext={handleNext}
          onBack={handleBack}
        />
      </div>

      <Toast message={toastMsg} />
    </div>
  );
}
