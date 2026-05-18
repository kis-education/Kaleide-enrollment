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
  // Steps the user has already passed. Initially empty; populated either by
  // forward navigation (WizardPage.handleNext → addCompletedStep) or by
  // hydration from a resumed session (hydrateFromResume infers from data).
  // Lifted into context (was WizardPage local state) so hydrate can seed it.
  const [completedSteps, setCompletedStepsRaw] = useState(new Set(session.completedSteps || []));

  const addCompletedStep = useCallback((idx) => {
    setCompletedStepsRaw(prev => {
      const next = new Set(prev); next.add(idx);
      saveSession({ completedSteps: [...next] });
      return next;
    });
  }, []);
  const removeCompletedStep = useCallback((idx) => {
    setCompletedStepsRaw(prev => {
      const next = new Set(prev); next.delete(idx);
      saveSession({ completedSteps: [...next] });
      return next;
    });
  }, []);
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
    setCompletedStepsRaw(new Set());
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
    const persons   = data.persons   || [];
    const relations = data.relations || [];
    // Backend returns qbResponses as `responses`; recFiles as `documents`.
    const responses = data.responses || [];
    const documents = data.documents || [];
    setStepData(prev => ({
      ...prev,
      email: {
        primary_email:      group.primary_email      || '',
        verified:           true,
        desired_start_date: group.desired_start_date || '',
      },
      persons,
      relations,
      health: persons.map(p => ({
        person_id: p.person_id,
        allergies: p.allergies || [],
        dietary:   p.dietary   || [],
        medical:   p.medical   || [],
      })),
      questions: responses,
      documents,
    }));

    // ── Step-completion inference ───────────────────────────────────────────
    // Marks every step the family has visibly passed through, then jumps to
    // the deepest one with data so they land where they left off (with prior
    // steps locked for the LockedBanner unlock-to-edit pattern). Submitted
    // sessions always go straight to Review (step 6).
    const submitted = !!group.submitted_at;
    const hasGuardians     = persons.some(p => p.person_type_id === 'guardian');
    const hasApplicants    = persons.some(p => p.person_type_id === 'applicant');
    const hasStartDate     = !!group.desired_start_date;
    const hasRelations     = relations.length > 0;
    // Step 3 (health), 4 (questions), 5 (documents) are visited even if the
    // family had nothing to declare. Best proxies we have without an explicit
    // current_step pointer on the group: persons exist → step 3 visited;
    // explicit response/document rows for higher steps.
    const visitedHealth    = hasGuardians && hasApplicants && hasRelations;
    const visitedQuestions = responses.length > 0;
    const visitedDocuments = documents.length > 0;

    const completed = new Set();
    if (hasStartDate)                       completed.add(0);
    if (hasGuardians && hasApplicants)      completed.add(1);
    if (hasRelations)                       completed.add(2);
    if (visitedHealth)                      completed.add(3);
    if (visitedQuestions)                   completed.add(4);
    if (visitedDocuments)                   completed.add(5);
    if (submitted) [0,1,2,3,4,5,6].forEach(i => completed.add(i));
    setCompletedStepsRaw(completed);
    saveSession({ completedSteps: [...completed] });

    // Land on the first incomplete step, or Review if everything's filled.
    // Submitted sessions go to Review (read-only view of what was sent).
    if (submitted) { setCurrentStep(6); return; }
    const STEP_COUNT = 7;
    let target = STEP_COUNT - 1; // default to Review
    for (let i = 0; i < STEP_COUNT; i++) {
      if (!completed.has(i)) { target = i; break; }
    }
    setCurrentStep(target);
  }, []);

  return (
    <WizardContext.Provider value={{
      enrollmentGroupId, setEnrollmentGroupId,
      resumeToken,   setResumeToken,
      currentStep,   setCurrentStep,
      stepData,      updateStep,
      recognition,   setRecognition,
      completedSteps, addCompletedStep, removeCompletedStep,
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
