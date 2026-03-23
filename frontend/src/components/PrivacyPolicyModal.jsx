import { useTranslation } from 'react-i18next';

export default function PrivacyPolicyModal({ show, onClose }) {
  const { t } = useTranslation();
  if (!show) return null;

  return (
    <>
      {/* Backdrop */}
      <div
        onClick={onClose}
        style={{
          position: 'fixed', inset: 0, zIndex: 1040,
          background: 'rgba(0,0,0,0.45)',
        }}
      />
      {/* Modal */}
      <div style={{
        position: 'fixed', inset: 0, zIndex: 1050,
        display: 'flex', alignItems: 'center', justifyContent: 'center',
        padding: '1rem',
        pointerEvents: 'none',
      }}>
        <div style={{
          background: '#fff', borderRadius: 12, maxWidth: 640, width: '100%',
          maxHeight: '80vh', display: 'flex', flexDirection: 'column',
          boxShadow: '0 8px 32px rgba(0,0,0,0.18)',
          pointerEvents: 'all',
        }}>
          <div style={{
            display: 'flex', alignItems: 'center', justifyContent: 'space-between',
            padding: '1rem 1.25rem', borderBottom: '1px solid var(--border)',
          }}>
            <h5 style={{ margin: 0, color: 'var(--teal-dk)', fontWeight: 700 }}>
              {t('legal.privacy_title')}
            </h5>
            <button onClick={onClose} style={{
              background: 'none', border: 'none', fontSize: '1.4rem',
              cursor: 'pointer', color: 'var(--muted)', lineHeight: 1,
            }}>&times;</button>
          </div>
          <div style={{ padding: '1.25rem', overflowY: 'auto' }}>
            <p style={{ color: 'var(--muted)', fontStyle: 'italic' }}>
              {t('legal.privacy_placeholder')}
            </p>
          </div>
        </div>
      </div>
    </>
  );
}
