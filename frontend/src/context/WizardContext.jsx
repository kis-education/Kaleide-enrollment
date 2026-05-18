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
  // Post-DL-E15: identity is `enrollmentGroupId` (cabecera enrEnrollmentGroups).
  // Backward-compat: fall back to legacy `session.applicationId` so in-flight
  // sessions from before this refactor keep working until they expire.
  const [enrollmentGroupId, setEnrollmentGroupIdRaw] = useState(
    session.enrollmentGroupId || session.applicationId || null
  );
  const [resumeToken,   setResumeTokenRaw]   = useState(session.resumeToken   || null);
  const [currentStep,   setCurrentStepRaw]   = useState(session.currentStep   || 0);
  const [stepData,      setStepData]         = useState(initialStepData);
  // D-E18: recognition result from initEnrollmentSession. Survives reloads via
  // sessionStorage so Step2 can show the "we recognised your family" banner
  // even after the family resumes from magic link.
  const [recognition, setRecognitionRaw] = useState(
    session.recognition || { matched: false, persons: [] }
  );

  const setRecognition = useCallback((r) => {
    const safe = (r && typeof r === 'object') ? r : { matched: false, persons: [] };
    setRecognitionRaw(safe);
    saveSession({ recognition: safe });
  }, []);

  const setEnrollmentGroupId = useCallback((id) => {
    setEnrollmentGroupIdRaw(id);
    saveSession({ enrollmentGroupId: id });
  }, []);
  const setResumeToken = useCallback((tok) => {
    setResumeTokenRaw(tok);
    saveSession({ resumeToken: tok });
  }, []);
  const setCurrentStep = useCallback((step) => {
    setCurrentStepRaw(step);
    saveSession({ currentStep: step });
  }, []);

  // Clear session when enrollment group is submitted
  const clearSession = useCallback(() => {
    try { sessionStorage.removeItem(SESSION_KEY); } catch { /* ignore */ }
    setEnrollmentGroupIdRaw(null);
    setResumeTokenRaw(null);
    setCurrentStepRaw(0);
    setStepData(initialStepData);
    setRecognitionRaw({ matched: false, persons: [] });
  }, []);

  const updateStep = useCallback((stepKey, data) => {
    setStepData(prev => ({ ...prev, [stepKey]: data }));
  }, []);

  const hydrateFromResume = useCallback((data) => {
    // Post-DL-E15 shape: { group, enrollments[], persons[], relations[], ... }
    // Legacy shape (transitional): { application, persons[], relations[], ... }
    const group = data.group || data.application;
    setEnrollmentGroupId(group.enrollment_group_id || group.application_id);
    setResumeToken(group.resume_token);
    // The magic link token itself proves email ownership — treat as verified regardless
    // of the email_confirmed DB flag (which may lag or not have been written yet).
    setStepData(prev => ({
      ...prev,
      email: {
        primary_email:      group.primary_email      || '',
        verified:           true,
        desired_start_date: group.desired_start_date || '',
      },
      persons:   data.persons   || [],
      relations: data.relations || [],
      health:    (data.persons  || []).map(p => ({
        person_id: p.person_id,
        allergies: p.allergies || [],
        dietary:   p.dietary   || [],
        medical:   p.medical   || [],
      })),
    }));
    // Determine deepest incomplete step — group.submitted_at indicates submit
    const submitted = group.submitted_at;
    if (submitted) { setCurrentStep(6); return; }
    const persons = data.persons || [];
    const hasGuardians  = persons.some(p => p.person_type_id === 'guardian');
    const hasApplicants = persons.some(p => p.person_type_id === 'applicant');
    // No persons yet → always start at step 0 (start date), even if AppSheet set a default date
    if (!hasGuardians && !hasApplicants) { setCurrentStep(0); return; }
    const desiredStartDate = group.desired_start_date;
    if (!desiredStartDate)          { setCurrentStep(0); return; }
    if (!hasGuardians || !hasApplicants) { setCurrentStep(1); return; }
    const hasRelations = (data.relations || []).length > 0;
    if (!hasRelations)              { setCurrentStep(2); return; }
    setCurrentStep(3);
  }, []);

  return (
    <WizardContext.Provider value={{
      enrollmentGroupId, setEnrollmentGroupId,
      resumeToken,   setResumeToken,
      currentStep,   setCurrentStep,
      stepData,      updateStep,
      recognition,   setRecognition,
      hydrateFromResume, clearSession,
      needsHydration: !!(enrollmentGroupId && !stepData.email.verified),
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
