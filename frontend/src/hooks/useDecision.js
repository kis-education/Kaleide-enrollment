import { useState, useEffect } from 'react';
import { gasCall } from '../api';
import * as log from '../logger';

/**
 * Fetches admission decision data for the given enrollment via resume_token.
 *
 * Returns: { loading, error, decision }
 *
 * - loading:  true while the request is in flight
 * - error:    string message if the fetch fails, null otherwise
 * - decision: { decided_at, decided_outcome, academic_year_label, education_level_designation,
 *               start_date_confirmed, trial_period_days, specific_conditions } | null
 *
 * If no decision exists yet, decision is null.
 */
export function useDecision(resumeToken, enrollmentId) {
  const [state, setState] = useState({
    loading: true,
    error: null,
    decision: null,
  });

  useEffect(() => {
    if (!resumeToken) {
      setState({ loading: false, error: 'no_token', decision: null });
      return;
    }

    log.info('useDecision: fetching admission decision', { resumeToken });
    setState(s => ({ ...s, loading: true, error: null }));

    gasCall('getAdmissionDecisionForEnrollment', {
      resume_token:  resumeToken,
      enrollment_id: enrollmentId || undefined,
    })
      .then(data => {
        const decision = data.decision || null;
        log.success('useDecision: data received', { decided_at: decision?.decided_at });
        setState({ loading: false, error: null, decision });
      })
      .catch(err => {
        log.error('useDecision: error', { message: err.message });
        setState({ loading: false, error: err.message, decision: null });
      });
  }, [resumeToken, enrollmentId]); // eslint-disable-line

  return state;
}
