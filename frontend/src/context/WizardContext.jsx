import { createContext, useContext, useState, useCallback } from 'react';

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
    setStepData(prev => ({ ...prev, [stepKey]: data }));
  }, []);

  const hydrateFromResume = useCallback((appData) => {
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
    if (submitted) { setCurrentStep(6); return; }
    const verified = appData.application.email_confirmed;
    if (!verified) { setCurrentStep(0); return; }
    const hasGuardians  = (appData.guardians  || []).length > 0;
    const hasApplicants = (appData.applicants || []).length > 0;
    if (!hasGuardians)  { setCurrentStep(1); return; }
    if (!hasApplicants) { setCurrentStep(2); return; }
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
