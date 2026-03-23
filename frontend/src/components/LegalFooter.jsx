import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import PrivacyPolicyModal from './PrivacyPolicyModal';

const LEGAL_NOTICE_URL = 'https://kaleide.org/es/legal-es/';

export default function LegalFooter() {
  const { t } = useTranslation();
  const [showPrivacy, setShowPrivacy] = useState(false);

  return (
    <>
      <footer style={{
        textAlign: 'center',
        padding: '1.5rem 1rem',
        fontSize: '0.78rem',
        color: 'var(--muted)',
        borderTop: '1px solid var(--border)',
        marginTop: 'auto',
      }}>
        <span>© {new Date().getFullYear()} Kaleide International School</span>
        <span style={{ margin: '0 0.5rem' }}>·</span>
        <a href={LEGAL_NOTICE_URL} target="_blank" rel="noopener noreferrer"
          style={{ color: 'var(--muted)' }}>
          {t('legal.notice_link')}
        </a>
        <span style={{ margin: '0 0.5rem' }}>·</span>
        <button onClick={() => setShowPrivacy(true)} style={{
          background: 'none', border: 'none', padding: 0,
          color: 'var(--muted)', cursor: 'pointer', fontSize: 'inherit',
          textDecoration: 'underline',
        }}>
          {t('legal.privacy_link')}
        </button>
      </footer>
      <PrivacyPolicyModal show={showPrivacy} onClose={() => setShowPrivacy(false)} />
    </>
  );
}
