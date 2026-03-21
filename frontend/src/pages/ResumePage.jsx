import { useEffect } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { gasCall } from '../api';
import { useWizard } from '../context/WizardContext';

export default function ResumePage() {
  const { token } = useParams();
  const navigate  = useNavigate();
  const { t }     = useTranslation();
  const { hydrateFromResume } = useWizard();

  useEffect(() => {
    if (!token) { navigate('/'); return; }
    gasCall('resumeApplication', { resume_token: token })
      .then(data => {
        hydrateFromResume(data);
        navigate('/apply');
      })
      .catch(() => {
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
