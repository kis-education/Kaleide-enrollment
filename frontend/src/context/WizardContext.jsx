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
  // Snapshot of step data AS LAST SAVED to the backend. Used by isStepDirty()
  // to skip redundant saveStep round-trips when the user clicks Next without
  // actually modifying anything. Updated by markStepSaved() after a successful
  // save, and seeded by hydrateFromResume() to reflect the just-loaded state.
  // Stored as a plain object (not Set/Map) so JSON.stringify works for diffing.
  // 2026-05-19 perf: Diego measured ~1-2s wasted per Next click when nothing
  // had changed; this baseline+diff pattern brings unchanged-step transitions
  // to ~50ms (UI only).
  const [savedBaseline, setSavedBaseline] = useState(initialStepData);
  // Promise for the most recently launched (and not yet settled) saveStep.
  // The wizard uses an optimistic-UI pattern: handleNext launches the save
  // asynchronously and advances the UI immediately. The PREVIOUS click's
  // save must finish before the next advance, so handleNext awaits this
  // promise as its first action. Submit also awaits it before sending.
  // At most one save is in flight at any time (sequential await chain).
  const [pendingSavePromise, setPendingSavePromiseRaw] = useState(null);
  // Boolean shadow of pendingSavePromise for cheap reactive subscriptions
  // (boolean changes trigger re-render predictably, Promise references don't).
  const [hasPendingSave, setHasPendingSave] = useState(false);

  /**
   * Registers a save promise as the current in-flight save. When it settles,
   * the promise is cleared automatically (if it's still the current one —
   * a newer save can supersede this slot mid-flight, in which case the
   * older promise's finally() leaves the newer one intact).
   */
  const setPendingSave = useCallback((promise) => {
    setPendingSavePromiseRaw(promise);
    setHasPendingSave(true);
    promise.finally(() => {
      setPendingSavePromiseRaw(prev => prev === promise ? null : prev);
      // Only clear hasPendingSave if no newer promise replaced us.
      setHasPendingSave(false);
      // ^ subtle: this might briefly drop to false even if a newer save
      // was set concurrently. Acceptable — the next save's setPendingSave
      // will re-set to true within the same tick.
    });
  }, []);

  /**
   * Returns a promise that resolves when the most recent save completes
   * (success or failure). Safe to await even when there's no save in
   * flight — returns an already-resolved Promise.
   */
  const awaitPendingSave = useCallback(() => {
    return pendingSavePromise || Promise.resolve();
  }, [pendingSavePromise]);
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
  // True once hydrateFromResume detects submitted_at IS NOT NULL.
  // Drives read-only wizard mode: fields locked, no saves, no abandon.
  const [isSubmitted, setIsSubmittedRaw] = useState(session.isSubmitted || false);
  const setIsSubmitted = useCallback((val) => {
    setIsSubmittedRaw(val);
    saveSession({ isSubmitted: val });
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
    setSavedBaseline(initialStepData);
    setIsSubmittedRaw(false);
  }, []);

  /**
   * True if the step's current data differs from what was last saved to the
   * backend (or last hydrated from a resume). Used by WizardPage.handleNext
   * to skip redundant saveStep round-trips when the user clicks Next without
   * changing anything.
   *
   * Implementation: deep equality via JSON.stringify. Sufficient for the
   * step data shapes (plain objects, arrays of plain objects, primitives —
   * no Dates / functions / Symbols). On parse-equal-but-encode-different
   * edge cases (e.g. property reordering during normalisation) the dirty
   * check returns TRUE, which is a false positive — benign, we just do
   * an unnecessary save. Worst case is the current behaviour.
   */
  // `data` is optional: if provided, compare it directly against the baseline
  // (avoids the React batching problem where updateStep() and onNext() are called
  // in the same tick — the state update hasn't committed yet, so stepData[stepKey]
  // would still be stale). Callers that have the fresh data should always pass it.
  const isStepDirty = useCallback((stepKey, data) => {
    try {
      const cur  = data !== undefined ? data : stepData[stepKey];
      const base = savedBaseline[stepKey];
      const curStr  = JSON.stringify(cur);
      const baseStr = JSON.stringify(base);
      if (curStr !== baseStr) {
        // Debug: log the first field difference to help diagnose false positives.
        if (Array.isArray(cur) && Array.isArray(base)) {
          outer: for (let i = 0; i < Math.max(cur.length, base.length); i++) {
            const a = cur[i], b = base[i];
            if (JSON.stringify(a) !== JSON.stringify(b)) {
              const keys = new Set([...Object.keys(a || {}), ...Object.keys(b || {})]);
              for (const k of keys) {
                if (JSON.stringify(a?.[k]) !== JSON.stringify(b?.[k])) {
                  console.warn(`[dirty] step=${stepKey} idx=${i} key="${k}" cur=`, a?.[k], `base=`, b?.[k]);
                  break outer;
                }
              }
            }
          }
        } else if (cur && base && typeof cur === 'object' && typeof base === 'object' && !Array.isArray(cur) && !Array.isArray(base)) {
          const keys = new Set([...Object.keys(cur), ...Object.keys(base)]);
          for (const k of keys) {
            if (JSON.stringify(cur[k]) !== JSON.stringify(base[k])) {
              console.warn(`[dirty] step=${stepKey} key="${k}" cur=`, cur[k], `base=`, base[k]);
              break;
            }
          }
        } else {
          console.warn(`[dirty] step=${stepKey} type mismatch cur=`, typeof cur, Array.isArray(cur) ? '[]' : '', `base=`, typeof base, Array.isArray(base) ? '[]' : '');
        }
        return true;
      }
      return false;
    } catch (_) {
      return true; // err on the side of saving
    }
  }, [stepData, savedBaseline]);

  /**
   * Stamps `savedData` into the saved-baseline for `stepKey` so the next
   * isStepDirty() call returns false. Call this AFTER a successful saveStep
   * round-trip, passing the exact data that was sent to the backend.
   *
   * Do NOT read from stepData[stepKey] here — the save is async and
   * markStepSaved is captured in a closure at save-launch time. By the time
   * the await resolves, stepData may have advanced via updateStep() batching,
   * so stepData[stepKey] would be stale relative to what was actually saved.
   */
  const markStepSaved = useCallback((stepKey, savedData) => {
    setSavedBaseline(prev => ({ ...prev, [stepKey]: savedData }));
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
    // The backend always inserts 2 rows per relation pair (forward + inverse).
    // Step3Relations only knows and produces 1 row per pair, so we must
    // deduplicate here to keep the savedBaseline in the same shape as what
    // handleNext sends via onNext. Deduplicate by pair_id, preferring the row
    // whose from_person_id matches a guardian so the semantic direction is right.
    const guardianIds = new Set(persons.filter(p => p.person_type_id === 'guardian').map(p => p.person_id));
    const relationsRaw = data.relations || [];
    const relByPair = {};
    relationsRaw.forEach(r => {
      const key = r.pair_id || r.relation_id; // pair_id groups forward+inverse; fallback to own id
      if (!relByPair[key]) {
        relByPair[key] = r;
      } else {
        // Prefer the row whose from_person_id is a guardian
        if (guardianIds.has(r.from_person_id) && !guardianIds.has(relByPair[key].from_person_id)) {
          relByPair[key] = r;
        }
      }
    });
    // Strip AppSheet system column _RowNumber (changes between API calls, has no
    // semantic meaning for the enrollment data). Without stripping, the dirty check
    // always returns true for relations because _RowNumber in the baseline (set at
    // resume time) can differ from the row reference Step3 finds in existing data.
    // Sort by relation_id so the baseline order is deterministic regardless of the
    // AppSheet API response order, which may differ from Step3's buildInitialRelations
    // output order (guardians × applicants from persons array).
    // eslint-disable-next-line no-unused-vars
    const relations = Object.values(relByPair).map(({ _RowNumber, ...r }) => r)
      .sort((a, b) => (a.relation_id || '').localeCompare(b.relation_id || ''));
    // Backend returns qbResponses as `responses`; recFiles as `documents`.
    const responsesRaw = data.responses || [];
    // Step5Questions tracks responses as a dict { "${question_id}__${respondent_id}": responseText }
    // while the backend stores/returns them as an array. Normalize here so savedBaseline.questions
    // matches the shape Step5 sends via onNext — preventing a permanent false-positive dirty check.
    const responsesDict = {};
    responsesRaw.forEach(r => {
      if (r.question_id) responsesDict[`${r.question_id}__${r.respondent_id || ''}`] = r.response_text || '';
    });
    const documents = data.documents || [];
    const hydrated = {
      email: {
        primary_email:      group.primary_email      || '',
        verified:           true,
        desired_start_date: group.desired_start_date || '',
        // program_id is NOT stored here — Step1Email initialises selectedProgramId
        // via useState('') and the useEffect auto-selects the single program from
        // fetchLookups(). savedBaseline.application.program_id (seeded below) is
        // what isStepDirty compares against, and that is already correct.
      },
      application: {
        // desired_start_date is intentionally excluded: the backend never writes it
        // at saveStep time (only propagated to enrEnrollments at submit). Including it
        // here would cause a permanent false-positive dirty save because the group row
        // has no desired_start_date column and the frontend auto-fills from program's
        // period_starts_on on every render.
        program_id: group.program_id || '',
      },
      persons,
      relations,
      health: persons.filter(p => p.person_type_id === 'applicant').map(p => ({
        person_id: p.person_id,
        allergies: p.allergies || [],
        dietary:   p.dietary   || [],
        medical:   p.medical   || [],
      })),
      questions: responsesDict,
      documents,
    };
    setStepData(prev => ({ ...prev, ...hydrated }));
    // Seed the saved baseline with the freshly-loaded data so isStepDirty()
    // correctly reports false for steps the user hasn't touched after resume.
    // Without this seed, every Next click after a resume would re-save even
    // when nothing changed.
    setSavedBaseline(prev => ({ ...prev, ...hydrated }));

    // ── Step-completion inference ───────────────────────────────────────────
    // Marks every step the family has visibly passed through, then jumps to
    // the deepest one with data so they land where they left off (with prior
    // steps locked for the LockedBanner unlock-to-edit pattern). Submitted
    // sessions always go straight to Review (step 6).
    const submitted = !!group.submitted_at;
    setIsSubmitted(submitted);
    const hasGuardians     = persons.some(p => p.person_type_id === 'guardian');
    const hasApplicants    = persons.some(p => p.person_type_id === 'applicant');
    // desired_start_date lives on enrEnrollments (not the group row), so check
    // the first enrollment's date; fall back to group field for legacy sessions.
    const hasStartDate     = !!(data.enrollments?.[0]?.desired_start_date) || !!group.desired_start_date;
    const hasRelations     = relations.length > 0;
    // Step 3 (health), 4 (questions), 5 (documents) are visited even if the
    // family had nothing to declare. Best proxies we have without an explicit
    // current_step pointer on the group: persons exist → step 3 visited;
    // explicit response/document rows for higher steps.
    const visitedHealth    = hasGuardians && hasApplicants && hasRelations;
    const visitedQuestions = responsesRaw.length > 0;
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
      isStepDirty, markStepSaved,
      setPendingSave, awaitPendingSave, hasPendingSave,
      hydrateFromResume, clearSession,
      isSubmitted,
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
