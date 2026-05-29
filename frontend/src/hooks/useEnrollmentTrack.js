import { useState, useEffect } from 'react';
import { gasCall } from '../api';
import * as log from '../logger';

/**
 * Fetches all tracking data for a submitted enrollment via resume_token.
 *
 * Returns: { loading, error, group, enrollments, milestones, documents, signingSession }
 *
 * - loading:        true while any request is in flight
 * - error:          string message if the token is invalid/expired, null otherwise
 * - group:          { enrollment_group_id, primary_email, submitted_at, program_id }
 * - enrollments:    [{ enrollment_id, state_code, state_label, desired_start_date }]
 * - milestones:     [] (empty if sysMilestones not yet live in AppSheet — Stage 1)
 * - documents:      [] (empty if recFiles has no entries for this group)
 * - signingSession: object | null
 *
 * If the application is NOT yet submitted (submitted_at = null), `notSubmitted`
 * is set to true and the caller should redirect to /resume/:token.
 */
export function useEnrollmentTrack(token) {
  const [state, setState] = useState({
    loading: true,
    error: null,
    notSubmitted: false,
    group: null,
    enrollments: [],
    milestones: [],
    documents: [],
    signingSession: null,
  });

  useEffect(() => {
    if (!token) {
      setState(s => ({ ...s, loading: false, error: 'no_token' }));
      return;
    }

    log.info('useEnrollmentTrack: fetching tracking data', { token });
    setState(s => ({ ...s, loading: true, error: null }));

    gasCall('getTrackingData', { resume_token: token })
      .then(data => {
        log.success('useEnrollmentTrack: data received', {
          enrollments: data.enrollments?.length,
          milestones:  data.milestones?.length,
          documents:   data.documents?.length,
        });
        setState({
          loading:       false,
          error:         null,
          notSubmitted:  false,
          group:         data.group         || null,
          enrollments:   data.enrollments   || [],
          milestones:    data.milestones    || [],
          documents:     data.documents     || [],
          signingSession: data.signing_session || null,
        });
      })
      .catch(err => {
        log.error('useEnrollmentTrack: error', { message: err.message });
        const notSubmitted = err.message && err.message.includes('not yet submitted');
        setState(s => ({
          ...s,
          loading:      false,
          error:        notSubmitted ? null : err.message,
          notSubmitted,
        }));
      });
  }, [token]);

  return state;
}
