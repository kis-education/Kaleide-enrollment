import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useWizard } from '../context/WizardContext';
import * as log from '../logger';
import { gasCall, prefetchLookups } from '../api';
import LangToggle from '../components/LangToggle';
import LegalFooter from '../components/LegalFooter';
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
  const navigate                        = useNavigate();
  const {
    enrollmentGroupId, resumeToken,
    currentStep, setCurrentStep,
    stepData, updateStep,
    hydrateFromResume, needsHydration,
    clearSession,
    completedSteps, addCompletedStep, removeCompletedStep,
  } = useWizard();
  const { message: toastMsg, showToast } = useToast();
  const [saving,            setSaving]            = useState(false);
  const [sendingMagicLink,  setSendingMagicLink]  = useState(false);
  const [rehydrating,       setRehydrating]       = useState(false);
  const [abandoning,        setAbandoning]        = useState(false);

  // Kick off lookup prefetch immediately so Step3/Step4 get cached data.
  useEffect(() => { prefetchLookups(); }, []); // eslint-disable-line

  // On page reload, enrollmentGroupId is restored from sessionStorage but stepData is empty.
  // Auto-resume from the server to restore full wizard state.
  useEffect(() => {
    if (needsHydration && resumeToken) {
      setRehydrating(true);
      log.info('WizardPage: rehydrating session after reload', { enrollmentGroupId });
      gasCall('resumeSession', { resume_token: resumeToken })
        .then(data => {
          // hydrateFromResume now seeds completedSteps in context based on
          // which steps have data — no need to override here.
          hydrateFromResume(data);
          log.success('WizardPage: rehydration complete');
        })
        .catch(err => {
          log.error('WizardPage: rehydration failed', { message: err.message });
          navigate('/consent', { replace: true });
        })
        .finally(() => setRehydrating(false));
    } else if (!enrollmentGroupId) {
      log.warn('WizardPage: no enrollmentGroupId — redirecting to /consent');
      navigate('/consent', { replace: true });
    }
  }, []); // eslint-disable-line

const handleNext = async (stepKey, data) => {
    setSaving(true);
    log.info(`WizardPage: handleNext step=${currentStep} stepKey=${stepKey}`);
    if (enrollmentGroupId && stepKey) {
      try {
        log.info(`WizardPage: auto-saving step "${stepKey}" for enrollment group ${enrollmentGroupId}`);
        // Send both new and legacy keys so backend keeps working during the
        // parallel refactor — server-side will prefer enrollment_group_id.
        const saveResult = await gasCall('saveStep', {
          enrollment_group_id: enrollmentGroupId,
          application_id:      enrollmentGroupId, // legacy alias
          step:                stepKey,
          payload:             data,
        });
        log.success(`WizardPage: saveStep "${stepKey}" OK`, saveResult?._debug || {});

        // Stamp real person_ids returned from backend so Step3Relations can reference them
        if (stepKey === 'persons' && saveResult?._debug?.personIdMap?.length) {
          const map = {};
          saveResult._debug.personIdMap.forEach(({ _uid, person_id }) => { if (_uid) map[_uid] = person_id; });
          const updated = data.map(p => ({ ...p, person_id: p.person_id || (p._uid && map[p._uid]) || undefined }));
          updateStep('persons', updated);
        }
      } catch (err) {
        log.warn(`WizardPage: saveStep "${stepKey}" failed (non-blocking)`, { message: err.message });
        showToast(t('wizard.save_failed'));
      }
    } else {
      log.warn('WizardPage: skipping saveStep', { enrollmentGroupId, stepKey });
    }
    setSaving(false);
    addCompletedStep(currentStep);
    const nextStep = Math.min(currentStep + 1, STEP_COMPONENTS.length - 1);
    log.info(`WizardPage: advancing to step ${nextStep}`);
    setCurrentStep(nextStep);
    window.scrollTo(0, 0);
  };

  const handleBack = () => {
    addCompletedStep(currentStep);
    const prevStep = Math.max(currentStep - 1, 0);
    log.info(`WizardPage: going back to step ${prevStep}`);
    setCurrentStep(prevStep);
    window.scrollTo(0, 0);
  };

  const handleUnlock = () => {
    removeCompletedStep(currentStep);
  };

  const handleStartOver = async () => {
    if (!resumeToken) return;
    if (!window.confirm(t('wizard.abandon_confirm'))) return;
    log.info('WizardPage: abandoning session', { enrollmentGroupId });
    setAbandoning(true);
    try {
      await gasCall('abandonSession', { resume_token: resumeToken });
      log.success('WizardPage: session abandoned');
      clearSession();
      navigate('/consent');
    } catch (err) {
      log.error('WizardPage: abandonSession failed', { message: err.message });
      // Even on backend failure, clear local state — the user wanted out.
      // The backend session becomes a 7-day-expiring orphan instead of an
      // abandoned-marked row; acceptable degradation.
      clearSession();
      navigate('/consent');
    } finally {
      setAbandoning(false);
    }
  };

  const handleSaveLater = async () => {
    if (!enrollmentGroupId) {
      log.warn('WizardPage: Save Later clicked but no enrollmentGroupId in context');
      return;
    }
    log.info('WizardPage: sending magic link for Save & Continue Later', { enrollmentGroupId });
    setSendingMagicLink(true);
    try {
      await gasCall('sendMagicLink', {
        enrollment_group_id: enrollmentGroupId,
        application_id:      enrollmentGroupId, // legacy alias
      });
      log.success('WizardPage: magic link sent');
      showToast(t('wizard.save_later_sent'));
    } catch (err) {
      log.error('WizardPage: sendMagicLink failed', { message: err.message });
      showToast(t('wizard.save_later_error'));
    } finally {
      setSendingMagicLink(false);
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

      {/* Rehydrating overlay (page reload) */}
      {rehydrating && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: 'rgba(248,249,250,0.95)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          backdropFilter: 'blur(3px)',
        }}>
          <div className="spinner-border" role="status"
            style={{ color: 'var(--teal)', width: '3rem', height: '3rem' }} />
          <p style={{ marginTop: 16, color: 'var(--teal-dk)', fontWeight: 600, fontSize: '1rem' }}>
            {t('resume.loading')}
          </p>
        </div>
      )}

      {/* Saving overlay */}
      {(saving || sendingMagicLink) && (
        <div style={{
          position: 'fixed', inset: 0, zIndex: 9999,
          background: 'rgba(248,249,250,0.88)',
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          backdropFilter: 'blur(3px)',
        }}>
          <div className="spinner-border" role="status"
            style={{ color: 'var(--teal)', width: '3rem', height: '3rem' }} />
          <p style={{ marginTop: 16, color: 'var(--teal-dk)', fontWeight: 600, fontSize: '1rem' }}>
            {sendingMagicLink ? t('wizard.sending_magic_link') : t('wizard.saving')}
          </p>
        </div>
      )}

      {/* Progress */}
      <WizardProgress currentStep={currentStep} />

      {/* Save-later bar */}
      <div className="wizard-header-bar" style={{ display: 'flex', gap: 12, justifyContent: 'space-between', alignItems: 'center' }}>
        <button className="save-later-btn" onClick={handleSaveLater}>
          <i className="bi bi-bookmark" /> {t('wizard.save_later')}
        </button>
        <button
          onClick={handleStartOver}
          disabled={abandoning}
          style={{
            background: 'transparent',
            border: 'none',
            color: '#a02020',
            fontSize: '0.85rem',
            cursor: abandoning ? 'wait' : 'pointer',
            padding: '6px 10px',
            textDecoration: 'underline',
          }}
        >
          <i className="bi bi-arrow-counterclockwise" /> {t('wizard.abandon_link')}
        </button>
      </div>

      {/* Step content */}
      <div className="wizard-body">
        <StepComponent
          onNext={handleNext}
          onBack={handleBack}
          locked={completedSteps.has(currentStep)}
          onUnlock={handleUnlock}
        />
      </div>

      <Toast message={toastMsg} />
      <LegalFooter />
    </div>
  );
}
