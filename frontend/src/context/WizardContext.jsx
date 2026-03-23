import { createContext, useContext, useState, useCallback, useEffect } from 'react';

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

const SESSION_KEY = 'kis_wizard_session';

function loadSession() {
  try { return JSON.parse(sessionStorage.getItem(SESSION_KEY) || 'null') || {}; } catch { return {}; }
}
function saveSession(patch) {
  try {
    const current = loadSession();
    sessionStorage.setItem(SESSION_KEY, JSON.stringify({ ...current, ...patch }));
  } catch { /* ignore */ }
}

export function WizardProvider({ children }) {
  const session = loadSession();
  const [applicationId, setApplicationIdRaw] = useState(session.applicationId || null);
  const [resumeToken,   setResumeTokenRaw]   = useState(session.resumeToken   || null);
  const [currentStep,   setCurrentStepRaw]   = useState(session.currentStep   || 0);
  const [stepData,      setStepData]         = useState(initialStepData);

  const setApplicationId = useCallback((id) => {
    setApplicationIdRaw(id);
    saveSession({ applicationId: id });
  }, []);
  const setResumeToken = useCallback((tok) => {
    setResumeTokenRaw(tok);
    saveSession({ resumeToken: tok });
  }, []);
  const setCurrentStep = useCallback((step) => {
    setCurrentStepRaw(step);
    saveSession({ currentStep: step });
  }, []);

  // Clear session when application is submitted
  const clearSession = useCallback(() => {
    try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
    setApplicationIdRaw(null);
    setResumeTokenRaw(null);
    setCurrentStepRaw(0);
    setStepData(initialStepData);
  }, []);

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
    const persons = appData.persons || [];
    const hasGuardians  = persons.some(p => p.person_type_id === 'guardian');
    const hasApplicants = persons.some(p => p.person_type_id === 'applicant');
    // No persons yet → always start at step 0 (start date), even if AppSheet set a default date
    if (!hasGuardians && !hasApplicants) { setCurrentStep(0); return; }
    const desiredStartDate = appData.application.desired_start_date;
    if (!desiredStartDate)          { setCurrentStep(0); return; }
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
      hydrateFromResume, clearSession,
      needsHydration: !!(applicationId && !stepData.email.verified),
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
