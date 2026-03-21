import { useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { gasCall } from '../api';
import { useWizard } from '../context/WizardContext';
import * as log from '../logger';

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
    log.info('ResumePage: calling resumeApplication', { resume_token: token });
    gasCall('resumeApplication', { resume_token: token })
      .then(data => {
        log.success('ResumePage: resumeApplication succeeded', {
          application_id: data.application?.application_id,
          status_type_id: data.application?.status_type_id,
        });
        hydrateFromResume(data);
        log.info('ResumePage: hydration complete, navigating to /apply');
        navigate('/apply');
      })
      .catch(err => {
        log.error('ResumePage: resumeApplication failed', { message: err.message });
        navigate('/?resume_error=1');
      });
  }, [token]); // eslint-disable-line

  return (
    <div style={{ textAlign: 'center', paddingTop: 80 }}>
      <div className="spinner" />
      <p style={{ color: 'var(--muted)' }}>{t('resume.loading')}</p>
    </div>
  );
}
