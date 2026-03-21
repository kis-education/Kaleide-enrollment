import { createContext, useContext, useState, useCallback } from 'react';
import * as log from '../logger';

const WizardContext = createContext(null);

export const STEPS = [
  { key: 'email',       labelKey: 'step.email'       },
  { key: 'guardians',   labelKey: 'step.guardians'   },
  { key: 'applicants',  labelKey: 'step.applicants'  },
  { key: 'health',      labelKey: 'step.health'      },
  { key: 'questions',   labelKey: 'step.questions'   },
  { key: 'documents',   labelKey: 'step.documents'   },
  { key: 'review',      labelKey: 'step.review'      },
];

const initialStepData = {
  email:      { primary_email: '', verified: false },
  guardians:  [],
  applicants: [],
  health:     [],
  questions:  [],
  documents:  [],
};

export function WizardProvider({ children }) {
  const [applicationId, setApplicationId] = useState(null);
  const [resumeToken,   setResumeToken]   = useState(null);
  const [currentStep,   setCurrentStep]   = useState(0);
  const [stepData,      setStepData]      = useState(initialStepData);

  const updateStep = useCallback((stepKey, data) => {
    log.info(`WizardContext: updateStep "${stepKey}"`, { recordCount: Array.isArray(data) ? data.length : typeof data });
    setStepData(prev => ({ ...prev, [stepKey]: data }));
  }, []);

  const hydrateFromResume = useCallback((appData) => {
    log.info('WizardContext: hydrateFromResume start', {
      application_id:  appData.application?.application_id,
      email_confirmed: appData.application?.email_confirmed,
      submitted_at:    appData.application?.submitted_at,
      guardians:       (appData.guardians  || []).length,
      applicants:      (appData.applicants || []).length,
      documents:       (appData.documents  || []).length,
      responses:       (appData.responses  || []).length,
    });

    setApplicationId(appData.application.application_id);
    setResumeToken(appData.application.resume_token);
    setStepData(prev => ({
      ...prev,
      email: {
        primary_email: appData.application.primary_email || '',
        verified: appData.application.email_confirmed || false,
      },
      guardians:  appData.guardians  || [],
      applicants: appData.applicants || [],
    }));

    // Determine current step from application state
    const submitted = appData.application.submitted_at;
    if (submitted) {
      log.info('WizardContext: resuming to step 6 (already submitted)');
      setCurrentStep(6); return;
    }
    const verified = appData.application.email_confirmed;
    if (!verified) {
      log.info('WizardContext: resuming to step 0 (email not verified)');
      setCurrentStep(0); return;
    }
    const hasGuardians  = (appData.guardians  || []).length > 0;
    const hasApplicants = (appData.applicants || []).length > 0;
    if (!hasGuardians)  {
      log.info('WizardContext: resuming to step 1 (no guardians)');
      setCurrentStep(1); return;
    }
    if (!hasApplicants) {
      log.info('WizardContext: resuming to step 2 (no applicants)');
      setCurrentStep(2); return;
    }
    log.info('WizardContext: resuming to step 3 (has guardians + applicants)');
    setCurrentStep(3);
  }, []);

  return (
    <WizardContext.Provider value={{
      applicationId, setApplicationId,
      resumeToken,   setResumeToken,
      currentStep,   setCurrentStep,
      stepData,      updateStep,
      hydrateFromResume,
    }}>
      {children}
    </WizardContext.Provider>
  );
}

export function useWizard() {
  const ctx = useContext(WizardContext);
  if (!ctx) throw new Error('useWizard must be used inside WizardProvider');
  return ctx;
}
