import { useTranslation } from 'react-i18next';
import { useWizard } from '../../context/WizardContext';
import { useInterview } from '../../hooks/useInterview';

function SkeletonBlock({ height = 60, style }) {
  return (
    <div
      style={{
        background: 'linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%)',
        backgroundSize: '200% 100%',
        animation: 'skeleton-shimmer 1.4s infinite',
        borderRadius: 8,
        height,
        marginBottom: 12,
        ...style,
      }}
    />
  );
}

function formatDateTime(iso, locale) {
  if (!iso) return '';
  try {
    return new Intl.DateTimeFormat(locale, {
      weekday: 'short',
      day: '2-digit',
      month: 'short',
      year: 'numeric',
      hour: '2-digit',
      minute: '2-digit',
    }).format(new Date(iso));
  } catch { return iso; }
}

function FormatRow({ interview, t }) {
  const fmt = interview.format;
  if (fmt === 'VIDEO_CALL') {
    return (
      <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginTop: 8 }}>
        <span style={{ fontSize: '1.1rem' }}>🎥</span>
        <div>
          <div style={{ color: 'var(--text)', fontSize: '0.9rem', fontWeight: 600 }}>
            {t('interview.format.VIDEO_CALL')}
          </div>
          {interview.meeting_url && (
            <a
              href={interview.meeting_url}
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: 'var(--teal-dk)', fontSize: '0.85rem', fontWeight: 600, wordBreak: 'break-all' }}
            >
              {interview.meeting_url}
            </a>
          )}
        </div>
      </div>
    );
  }
  if (fmt === 'PHONE') {
    return (
      <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginTop: 8 }}>
        <span style={{ fontSize: '1.1rem' }}>📞</span>
        <span style={{ color: 'var(--text)', fontSize: '0.9rem' }}>
          {t('interview.format.PHONE')}
        </span>
      </div>
    );
  }
  // Default: IN_PERSON
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', gap: 10, marginTop: 8 }}>
      <span style={{ fontSize: '1.1rem' }}>📍</span>
      <div>
        <div style={{ color: 'var(--text)', fontSize: '0.9rem', fontWeight: 600 }}>
          {t('interview.format.IN_PERSON')}
        </div>
        {interview.location_text && (
          <div style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>
            {interview.location_text}
          </div>
        )}
      </div>
    </div>
  );
}

export default function Step9Interview({ onBack }) {
  const { t, i18n }         = useTranslation();
  const { resumeToken, enrollmentGroupId } = useWizard();
  const { loading, error, interview } = useInterview(resumeToken, enrollmentGroupId);

  const locale = i18n.language || 'es';

  return (
    <div>
      <h1 style={{ color: 'var(--teal-dk)', fontWeight: 800, marginBottom: 4 }}>
        {t('interview.title')}
      </h1>
      <p style={{ color: 'var(--muted)', marginBottom: 28, fontSize: '0.9rem' }}>
        {t('interview.subtitle')}
      </p>

      {loading && (
        <div className="kis-card">
          <SkeletonBlock height={24} style={{ width: '40%' }} />
          <SkeletonBlock height={48} />
          <SkeletonBlock height={24} style={{ width: '60%' }} />
        </div>
      )}

      {!loading && error && (
        <div
          className="kis-card"
          style={{ borderLeft: '4px solid #f76707', color: 'var(--muted)', fontSize: '0.9rem' }}
        >
          {t('interview.error')}
        </div>
      )}

      {!loading && !error && !interview && (
        <div
          className="kis-card"
          style={{ display: 'flex', alignItems: 'flex-start', gap: 12, color: 'var(--muted)', fontSize: '0.9rem' }}
        >
          <span aria-hidden="true" style={{ fontSize: '1.4rem' }}>⏳</span>
          <span>{t('interview.empty')}</span>
        </div>
      )}

      {!loading && !error && interview && (
        <div className="kis-card">
          {/* Date/time */}
          <div style={{ display: 'flex', alignItems: 'center', gap: 10, marginBottom: 6 }}>
            <span style={{ fontSize: '1.1rem' }}>📅</span>
            <span style={{ fontWeight: 700, fontSize: '1rem', color: 'var(--text)' }}>
              {formatDateTime(interview.interview_date, locale)}
            </span>
          </div>

          {/* Format + location/url */}
          <FormatRow interview={interview} t={t} />

          {/* Interviewer */}
          {interview.interviewer_name && (
            <div
              style={{
                marginTop: 16,
                paddingTop: 14,
                borderTop: '1px solid var(--border)',
                color: 'var(--muted)',
                fontSize: '0.85rem',
              }}
            >
              {t('interview.interviewer_label')}:{' '}
              <span style={{ color: 'var(--text)', fontWeight: 600 }}>
                {interview.interviewer_name}
              </span>
            </div>
          )}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 24, marginBottom: 32 }}>
        <button className="btn-secondary-kis" onClick={onBack}>
          <i className="bi bi-arrow-left me-1" /> {t('nav.back')}
        </button>
      </div>

      <style>{`
        @keyframes skeleton-shimmer {
          0%   { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>
    </div>
  );
}
