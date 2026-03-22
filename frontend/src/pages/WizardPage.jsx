import { useTranslation } from 'react-i18next';
import { useWizard } from '../context/WizardContext';
import * as log from '../logger';
import { gasCall } from '../api';
import LangToggle from '../components/LangToggle';
import WizardProgress from '../components/WizardProgress';
import { Toast, useToast } from '../components/Toast';

import Step1Email     from './steps/Step1Email';
import Step2Persons   from './steps/Step2Persons';
import Step3Relations from './steps/Step3Relations';
import Step4Health    from './steps/Step4Health';
import Step5Questions from './steps/Step5Questions';
import Step6Documents from './steps/Step6Documents';
import Step7Review    from './steps/Step7Review';

const LOGO = 'https://raw.githubusercontent.com/kaleideschool/public/main/favicon.png';

const STEP_COMPONENTS = [
  Step1Email,
  Step2Persons,
  Step3Relations,
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
    log.info(`WizardPage: handleNext step=${currentStep} stepKey=${stepKey}`);
    if (applicationId && stepKey) {
      try {
        log.info(`WizardPage: auto-saving step "${stepKey}" for application ${applicationId}`);
        await gasCall('saveStep', { application_id: applicationId, step: stepKey, payload: data });
        log.success(`WizardPage: saveStep "${stepKey}" OK`);
      } catch (err) {
        log.warn(`WizardPage: saveStep "${stepKey}" failed (non-blocking)`, { message: err.message });
      }
    } else {
      log.warn('WizardPage: skipping saveStep', { applicationId, stepKey });
    }
    const nextStep = Math.min(currentStep + 1, STEP_COMPONENTS.length - 1);
    log.info(`WizardPage: advancing to step ${nextStep}`);
    setCurrentStep(nextStep);
    window.scrollTo(0, 0);
  };

  const handleBack = () => {
    const prevStep = Math.max(currentStep - 1, 0);
    log.info(`WizardPage: going back to step ${prevStep}`);
    setCurrentStep(prevStep);
    window.scrollTo(0, 0);
  };

  const handleSaveLater = async () => {
    if (!applicationId) {
      log.warn('WizardPage: Save Later clicked but no applicationId in context');
      return;
    }
    log.info('WizardPage: sending magic link for Save & Continue Later', { applicationId });
    try {
      await gasCall('sendMagicLink', { application_id: applicationId });
      log.success('WizardPage: magic link sent');
      showToast(t('wizard.save_later_sent'));
    } catch (err) {
      log.error('WizardPage: sendMagicLink failed', { message: err.message });
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
