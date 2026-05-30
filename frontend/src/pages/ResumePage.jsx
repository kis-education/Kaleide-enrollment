import { useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { gasCall } from '../api';
import { useWizard } from '../context/WizardContext';
import * as log from '../logger';

/**
 * /resume/:token — magic-link landing.
 *
 * KAL-7 (security audit 2026-05-29): the resume_token used to remain visible
 * in the URL bar (browser history, screen shares, screenshots, Referer
 * header), which is a leak of a long-lived bearer secret. We now:
 *   1. Read the token from useParams() once.
 *   2. Strip it from the URL immediately via window.history.replaceState
 *      (path becomes `/#/apply` — no token).
 *   3. Pass the token to the resumeSession call from the closure (the
 *      WizardContext.hydrateFromResume stores it in sessionStorage for
 *      subsequent API calls).
 * Combined with the <meta name="referrer" content="no-referrer"> in
 * frontend/index.html (also KAL-7), this closes both the visual leak and
 * the Referer leak.
 *
 * KAL-11: previously logged the full resume_token via log.info — now logs
 * only the first 8 chars + '...' so the token is not reconstructable from
 * the dev console log stream.
 */
export default function ResumePage() {
  const { token } = useParams();
  const navigate  = useNavigate();
  const { t }     = useTranslation();
  const { hydrateFromResume } = useWizard();

  useEffect(() => {
    if (!token) {
      log.warn('ResumePage: no token in URL, redirecting to /');
      navigate('/');
      return;
    }

    // KAL-7: scrub the token from the URL bar / history BEFORE any await.
    // HashRouter means the path lives in location.hash. Replace the hash with
    // '#/apply' so the address bar drops the resume token. The token is held
    // in the closure for the gasCall below and persisted in sessionStorage
    // by hydrateFromResume for follow-up API calls.
    try {
      const cleanUrl = window.location.pathname + window.location.search + '#/apply';
      window.history.replaceState(null, '', cleanUrl);
    } catch (e) {
      // replaceState can throw in very old browsers / sandboxed iframes — non-fatal.
      log.warn('ResumePage: history.replaceState failed (non-fatal)', { message: e.message });
    }

    const tokenPreview = String(token).slice(0, 8) + '...';
    log.info('ResumePage: calling resumeSession', { resume_token_preview: tokenPreview });
    gasCall('resumeSession', { resume_token: token })
      .then(data => {
        // Post-DL-E15 shape uses `group`; legacy responses still use `application`.
        const grp = data.group || data.application;
        log.success('ResumePage: resumeSession succeeded', {
          enrollment_group_id: grp?.enrollment_group_id || grp?.application_id,
          submitted_at:        grp?.submitted_at,
        });
        hydrateFromResume(data);
        log.info('ResumePage: hydration complete, navigating to /apply');
        navigate('/apply', { replace: true });
      })
      .catch(err => {
        log.error('ResumePage: resumeSession failed', { message: err.message });
        navigate('/?resume_error=1', { replace: true });
      });
  }, [token]); // eslint-disable-line

  return (
    <div style={{ textAlign: 'center', paddingTop: 80 }}>
      <div className="spinner" />
      <p style={{ color: 'var(--muted)' }}>{t('resume.loading')}</p>
    </div>
  );
}
