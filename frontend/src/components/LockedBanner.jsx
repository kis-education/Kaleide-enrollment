import { useTranslation } from 'react-i18next';

export default function LockedBanner({ onUnlock, highlight }) {
  const { t } = useTranslation();
  return (
    <div style={{
      display: 'flex', alignItems: 'center', justifyContent: 'space-between',
      background: 'var(--teal-lt)', color: 'var(--teal-dk)',
      borderRadius: 8, padding: '8px 14px', marginBottom: 16, fontSize: '0.88rem',
      position: 'sticky', top: 0, zIndex: 40,
      boxShadow: '0 2px 8px rgba(0,0,0,0.10)',
    }}>
      <span><i className="bi bi-lock-fill me-2" />{t('locked.message')}</span>
      <button
        className={`btn-secondary-kis${highlight ? ' locked-edit-shake' : ''}`}
        style={{ padding: '4px 12px', fontSize: '0.85rem' }}
        onClick={onUnlock}
      >
        <i className="bi bi-pencil me-1" />{t('locked.edit')}
      </button>
    </div>
  );
}
