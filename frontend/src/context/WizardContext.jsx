import { createContext, useContext, useState, useCallback } from 'react';

const WizardContext = createContext(null);

export const STEPS = [
  { key: 'email',     labelKey: 'step.email'     },
  { key: 'persons',   labelKey: 'step.persons'   },
  { key: 'relations', labelKey: 'step.relations' },
  { key: 'health',    labelKey: 'step.health'    },
  { key: 'questions', labelKey: 'step.questions' },
  { key: 'documents', labelKey: 'step.documents' },
  { key: 'review',    labelKey: 'step.review'    },
];

const initialStepData = {
  email:     { primary_email: '', verified: false },
  persons:   [],
  relations: [],
  health:    [],
  questions: [],
  documents: [],
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
    // The magic link token itself proves email ownership — treat as verified regardless
    // of the email_confirmed DB flag (which may lag or not have been written yet).
    setStepData(prev => ({
      ...prev,
      email: {
        primary_email:      appData.application.primary_email      || '',
        verified:           true,
        desired_start_date: appData.application.desired_start_date || '',
      },
      persons:   appData.persons   || [],
      relations: appData.relations || [],
    }));
    // Determine deepest incomplete step
    const submitted = appData.application.submitted_at;
    if (submitted) { setCurrentStep(6); return; }
    const desiredStartDate = appData.application.desired_start_date;
    if (!desiredStartDate)          { setCurrentStep(0); return; }
    const persons = appData.persons || [];
    const hasGuardians  = persons.some(p => p.person_type_id === 'guardian');
    const hasApplicants = persons.some(p => p.person_type_id === 'applicant');
    if (!hasGuardians || !hasApplicants) { setCurrentStep(1); return; }
    const hasRelations = (appData.relations || []).length > 0;
    if (!hasRelations)              { setCurrentStep(2); return; }
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
