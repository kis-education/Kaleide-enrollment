import { useState, useEffect } from 'react';
import { gasCall } from '../api';
import * as log from '../logger';

/**
 * Fetches interview data for the given enrollment via resume_token.
 *
 * Returns: { loading, error, interview }
 *
 * - loading:   true while the request is in flight
 * - error:     string message if the fetch fails, null otherwise
 * - interview: { interview_id, interview_type, interview_date, format, location_text,
 *               meeting_url, interviewer_name, status } | null
 *
 * Returns the first FIRST_INTERVIEW row. If none exists, interview is null.
 */
export function useInterview(resumeToken, enrollmentId) {
  const [state, setState] = useState({
    loading: true,
    error: null,
    interview: null,
  });

  useEffect(() => {
    if (!resumeToken) {
      setState({ loading: false, error: 'no_token', interview: null });
      return;
    }

    log.info('useInterview: fetching interview data', { resumeToken });
    setState(s => ({ ...s, loading: true, error: null }));

    gasCall('getInterviewForEnrollment', {
      resume_token:  resumeToken,
      enrollment_id: enrollmentId || undefined,
    })
      .then(data => {
        const interviews = data.interviews || [];
        const first = interviews.find(i => i.interview_type === 'FIRST_INTERVIEW') || interviews[0] || null;
        log.success('useInterview: data received', { count: interviews.length, first });
        setState({ loading: false, error: null, interview: first });
      })
      .catch(err => {
        log.error('useInterview: error', { message: err.message });
        setState({ loading: false, error: err.message, interview: null });
      });
  }, [resumeToken, enrollmentId]); // eslint-disable-line

  return state;
}
