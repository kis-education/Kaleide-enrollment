import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';

const LEGAL_NOTICE_URL = 'https://kaleide.org/es/legal-es/';

export default function LegalFooter() {
  const { t } = useTranslation();
  return (
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
      <Link to="/privacy" style={{ color: 'var(--muted)' }}>
        {t('legal.privacy_link')}
      </Link>
    </footer>
  );
}
