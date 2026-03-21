import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import LangToggle from '../components/LangToggle';
import { useWizard } from '../context/WizardContext';

const LOGO = 'https://raw.githubusercontent.com/kaleideschool/public/main/favicon.png';

export default function ConfirmationPage() {
  const { t }           = useTranslation();
  const { applicationId } = useWizard();

  return (
    <div className="wizard-layout">
      <header className="kis-header">
        <div className="brand">
          <img src={LOGO} alt="KIS" />
          <div>
            <div className="brand-name">Kaleide International School</div>
            <div className="brand-sub">{t('landing.header_sub')}</div>
          </div>
        </div>
        <LangToggle />
      </header>

      <div style={{ maxWidth: 600, margin: '60px auto', padding: '0 16px', textAlign: 'center' }}>
        <div className="confirmation-icon">
          <i className="bi bi-check-lg" />
        </div>

        <h1 style={{ color: 'var(--teal-dk)', fontWeight: 800, marginBottom: 8 }}>
          {t('confirmation.title')}
        </h1>
        <p style={{ color: 'var(--muted)', marginBottom: 8 }}>
          {t('confirmation.subtitle')}
        </p>

        {applicationId && (
          <div className="kis-card" style={{ textAlign: 'left', marginTop: 28 }}>
            <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--muted)' }}>
              {t('confirmation.app_id_label')}
            </p>
            <p style={{ margin: '4px 0 0', fontFamily: 'monospace', color: 'var(--teal-dk)', fontWeight: 700 }}>
              {applicationId}
            </p>
          </div>
        )}

        <div className="kis-card" style={{ textAlign: 'left', marginTop: 20 }}>
          <h3 style={{ color: 'var(--teal-dk)', marginTop: 0, fontSize: '1rem' }}>
            {t('confirmation.next_steps_title')}
          </h3>
          <ul style={{ color: 'var(--text)', lineHeight: 1.8, paddingLeft: 20 }}>
            <li>{t('confirmation.next_1')}</li>
            <li>{t('confirmation.next_2')}</li>
            <li>{t('confirmation.next_3')}</li>
          </ul>
        </div>

        <p style={{ color: 'var(--muted)', fontSize: '0.85rem', marginTop: 24 }}>
          {t('confirmation.contact_prefix')}{' '}
          <a href="mailto:admissions@kaleide.org" style={{ color: 'var(--teal-dk)' }}>
            admissions@kaleide.org
          </a>
        </p>
      </div>
    </div>
  );
}
