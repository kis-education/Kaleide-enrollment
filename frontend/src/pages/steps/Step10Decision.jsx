import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useWizard } from '../../context/WizardContext';
import { useDecision } from '../../hooks/useDecision';

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

function formatDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return iso; }
}

const OUTCOME_COLOR = {
  AC:  '#2f9e44',
  WL:  '#1971c2',
  REJ: '#868e96',
  CAN: '#868e96',
};

const OUTCOME_BADGE_LABEL = {
  AC:  'decision.outcome.admitted',
  WL:  'decision.outcome.waitlisted',
  REJ: 'decision.outcome.rejected',
  CAN: 'decision.outcome.cancelled',
};

function OutcomeBadge({ outcome, t }) {
  const color = OUTCOME_COLOR[outcome] || 'var(--muted)';
  const labelKey = OUTCOME_BADGE_LABEL[outcome] || 'decision.outcome.admitted';
  return (
    <span
      role="status"
      style={{
        display: 'inline-block',
        background: color,
        color: '#fff',
        padding: '5px 18px',
        borderRadius: 20,
        fontWeight: 700,
        fontSize: '1rem',
        letterSpacing: '0.03em',
        marginBottom: 16,
      }}
    >
      {t(labelKey, { defaultValue: outcome })}
    </span>
  );
}

export default function Step10Decision({ onBack }) {
  const { t }                           = useTranslation();
  const { resumeToken, enrollmentGroupId } = useWizard();
  const { loading, error, decision }    = useDecision(resumeToken, enrollmentGroupId);
  const [expanded, setExpanded]         = useState(false);

  return (
    <div>
      <h1 style={{ color: 'var(--teal-dk)', fontWeight: 800, marginBottom: 4 }}>
        {t('decision.title')}
      </h1>
      <p style={{ color: 'var(--muted)', marginBottom: 28, fontSize: '0.9rem' }}>
        {t('decision.subtitle')}
      </p>

      {loading && (
        <div className="kis-card">
          <SkeletonBlock height={24} style={{ width: '50%' }} />
          <SkeletonBlock height={40} />
          <SkeletonBlock height={24} style={{ width: '70%' }} />
        </div>
      )}

      {!loading && error && (
        <div
          className="kis-card"
          style={{ borderLeft: '4px solid #f76707', color: 'var(--muted)', fontSize: '0.9rem' }}
        >
          {t('decision.error')}
        </div>
      )}

      {!loading && !error && !decision && (
        <div
          className="kis-card"
          style={{ display: 'flex', alignItems: 'flex-start', gap: 12, color: 'var(--muted)', fontSize: '0.9rem' }}
        >
          <span aria-hidden="true" style={{ fontSize: '1.4rem' }}>⏳</span>
          <span>{t('decision.empty')}</span>
        </div>
      )}

      {!loading && !error && decision && (
        <div className="kis-card">
          {/* Outcome badge */}
          {decision.decided_outcome && (
            <OutcomeBadge outcome={decision.decided_outcome} t={t} />
          )}

          {/* Decided at */}
          {decision.decided_at && (
            <p style={{ color: 'var(--muted)', fontSize: '0.85rem', marginBottom: 12 }}>
              {t('decision.decided_at_label')}: {formatDate(decision.decided_at)}
            </p>
          )}

          {/* Details grid */}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            {decision.academic_year_label && (
              <div style={{ fontSize: '0.9rem' }}>
                <span style={{ color: 'var(--muted)', fontWeight: 600, marginRight: 6 }}>
                  {t('decision.academic_year_label')}:
                </span>
                <span style={{ color: 'var(--text)' }}>{decision.academic_year_label}</span>
              </div>
            )}
            {decision.education_level_designation && (
              <div style={{ fontSize: '0.9rem' }}>
                <span style={{ color: 'var(--muted)', fontWeight: 600, marginRight: 6 }}>
                  {t('decision.education_level_label')}:
                </span>
                <span style={{ color: 'var(--text)' }}>{decision.education_level_designation}</span>
              </div>
            )}
            {decision.start_date_confirmed && (
              <div style={{ fontSize: '0.9rem' }}>
                <span style={{ color: 'var(--muted)', fontWeight: 600, marginRight: 6 }}>
                  {t('decision.start_date_label')}:
                </span>
                <span style={{ color: 'var(--text)' }}>{formatDate(decision.start_date_confirmed)}</span>
              </div>
            )}
            {decision.trial_period_days != null && decision.trial_period_days > 0 && (
              <div style={{ fontSize: '0.9rem' }}>
                <span style={{ color: 'var(--muted)', fontWeight: 600, marginRight: 6 }}>
                  {t('decision.trial_period_label')}:
                </span>
                <span style={{ color: 'var(--text)' }}>
                  {t('decision.trial_period_days', { count: decision.trial_period_days })}
                </span>
              </div>
            )}
          </div>

          {/* Specific conditions (collapsible) */}
          {decision.specific_conditions && (
            <div style={{ marginTop: 16, paddingTop: 14, borderTop: '1px solid var(--border)' }}>
              <div style={{ fontWeight: 600, fontSize: '0.85rem', color: 'var(--muted)', marginBottom: 6 }}>
                {t('decision.conditions_label')}
              </div>
              <p style={{ fontSize: '0.9rem', color: 'var(--text)', margin: 0 }}>
                {!expanded && decision.specific_conditions.length > 200
                  ? decision.specific_conditions.slice(0, 200) + '…'
                  : decision.specific_conditions}
              </p>
              {decision.specific_conditions.length > 200 && (
                <button
                  onClick={() => setExpanded(e => !e)}
                  style={{
                    background: 'none',
                    border: 'none',
                    color: 'var(--teal-dk)',
                    fontSize: '0.85rem',
                    fontWeight: 600,
                    cursor: 'pointer',
                    padding: '4px 0',
                  }}
                >
                  {expanded ? t('decision.conditions_collapse') : t('decision.conditions_expand')}
                </button>
              )}
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
