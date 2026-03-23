import { useTranslation } from 'react-i18next';
import LangToggle from '../components/LangToggle';

const LOGO = 'https://raw.githubusercontent.com/kaleideschool/public/main/favicon.png';

export default function PrivacyPolicyPage() {
  const { t } = useTranslation();

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

      <div style={{ maxWidth: 720, margin: '0 auto', padding: '2rem 1rem' }}>
        <h1 style={{ color: 'var(--teal-dk)', fontWeight: 800, marginBottom: '1.5rem' }}>
          {t('legal.privacy_title')}
        </h1>

        <div className="kis-card mb-4">
          <p style={{ color: 'var(--muted)', fontStyle: 'italic' }}>
            {t('legal.privacy_placeholder')}
          </p>
        </div>
      </div>
    </div>
  );
}
