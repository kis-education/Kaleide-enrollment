import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useWizard } from '../../context/WizardContext';
import { useEnrollmentTrack } from '../../hooks/useEnrollmentTrack';

const STATE_I18N_KEY = {
  RQ:       'track.state.RQ',
  IN:       'track.state.IN',
  AC:       'track.state.AC',
  AD:       'track.state.AD',
  WL:       'track.state.WL',
  REJ:      'track.state.REJ',
  CAN:      'track.state.CAN',
  PROMOTED: 'track.state.PROMOTED',
};

const STATE_COLOR = {
  RQ:       'var(--teal-dk)',
  IN:       '#f76707',
  AC:       '#2f9e44',
  AD:       '#2f9e44',
  WL:       '#1971c2',
  REJ:      '#c92a2a',
  CAN:      '#868e96',
  PROMOTED: '#2f9e44',
};

const MILESTONE_STATUS_COLOR = {
  PENDING:     '#868e96',
  IN_PROGRESS: '#f76707',
  COMPLETED:   '#2f9e44',
  EXEMPTED:    '#1971c2',
};

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

function SectionTitle({ children }) {
  return (
    <h2 style={{
      fontSize: '0.8rem',
      fontWeight: 700,
      textTransform: 'uppercase',
      letterSpacing: '0.08em',
      color: 'var(--muted)',
      marginBottom: 8,
    }}>
      {children}
    </h2>
  );
}

function EmptyState({ icon, message }) {
  return (
    <div
      className="kis-card"
      style={{ display: 'flex', alignItems: 'center', gap: 10, color: 'var(--muted)', fontSize: '0.9rem' }}
    >
      <span aria-hidden="true" style={{ fontSize: '1.2rem' }}>{icon}</span>
      <span>{message}</span>
    </div>
  );
}

function StateCard({ enr, t }) {
  const stateCode  = enr.state_code  || '—';
  const stateLabel = enr.state_label || t(STATE_I18N_KEY[stateCode] || 'track.state.unknown', { defaultValue: stateCode });
  const color      = STATE_COLOR[stateCode] || 'var(--teal-dk)';

  return (
    <div className="kis-card">
      {enr.applicant_name && (
        <p style={{ fontWeight: 600, fontSize: '0.95rem', marginBottom: 10, color: 'var(--text)' }}>
          {enr.applicant_name}
          {enr.applicant_dob && (
            <span style={{ fontWeight: 400, color: 'var(--muted)', fontSize: '0.85rem', marginLeft: 8 }}>
              · {formatDate(enr.applicant_dob)}
            </span>
          )}
        </p>
      )}
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span
          role="status"
          aria-live="polite"
          aria-label={t('track.state.current') + ': ' + stateLabel}
          style={{
            background: color,
            color: '#fff',
            padding: '4px 14px',
            borderRadius: 20,
            fontWeight: 700,
            fontSize: '0.95rem',
            letterSpacing: '0.03em',
          }}
        >
          {stateLabel}
        </span>
        {enr.desired_start_date && (
          <span style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>
            {t('track.state.start_date')}: {formatDate(enr.desired_start_date)}
          </span>
        )}
      </div>
    </div>
  );
}

function MilestoneRow({ milestone, t, isLast, signingSession }) {
  const status = milestone.status || 'PENDING';
  const color  = MILESTONE_STATUS_COLOR[status] || '#868e96';
  const isDone = status === 'COMPLETED' || status === 'EXEMPTED';
  const hasSigningPending = signingSession
    && signingSession.entity_id === milestone.entity_id
    && !isDone
    && milestone.category === 'SIGNING';
  const signerPending = hasSigningPending
    && signingSession.signers.some(s => s.status === 'PENDING' && s.signing_url);
  const firstPendingSigner = signerPending
    && signingSession.signers.find(s => s.status === 'PENDING' && s.signing_url);

  return (
    <div style={{
      padding: '12px 16px',
      borderBottom: isLast ? 'none' : '1px solid var(--border)',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: 8,
    }}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
        <span aria-hidden="true" style={{
          width: 10, height: 10, borderRadius: '50%',
          background: color, flexShrink: 0, display: 'inline-block',
        }} />
        <span style={{ fontSize: '0.9rem', color: 'var(--text)' }}>
          {milestone.label || milestone.milestone_type_code || milestone.milestone_id}
        </span>
        {milestone.completed_at && (
          <span style={{ color: 'var(--muted)', fontSize: '0.8rem' }}>
            {formatDate(milestone.completed_at)}
          </span>
        )}
      </div>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, flexShrink: 0 }}>
        <span
          aria-label={t('track.milestone_status.' + status, { defaultValue: status })}
          style={{ fontSize: '0.78rem', color, fontWeight: 600 }}
        >
          {t('track.milestone_status.' + status, { defaultValue: status })}
        </span>
        {firstPendingSigner && (
          <a
            href={firstPendingSigner.signing_url}
            target="_blank"
            rel="noopener noreferrer"
            aria-label={t('track.cta.sign') + ' — ' + (milestone.label || milestone.milestone_type_code || '')}
            style={{
              background: 'var(--teal-dk)',
              color: '#fff',
              padding: '3px 10px',
              borderRadius: 6,
              fontSize: '0.78rem',
              fontWeight: 600,
              textDecoration: 'none',
            }}
          >
            {t('track.cta.sign')}
          </a>
        )}
        {isDone && <span aria-hidden="true" style={{ color: '#2f9e44', fontSize: '1rem' }}>✓</span>}
      </div>
    </div>
  );
}

function DocumentRow({ doc, t, isLast }) {
  return (
    <div style={{
      padding: '12px 16px',
      borderBottom: isLast ? 'none' : '1px solid var(--border)',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: 8,
    }}>
      <div>
        <span style={{ fontSize: '0.9rem', color: 'var(--text)' }}>
          {doc.file_name || doc.document_type || doc.rec_type_code || doc.file_id}
        </span>
        {doc.created_at && (
          <span style={{ color: 'var(--muted)', fontSize: '0.8rem', marginLeft: 10 }}>
            {formatDate(doc.created_at)}
          </span>
        )}
      </div>
      {doc.drive_url && (
        <a
          href={doc.drive_url}
          target="_blank"
          rel="noopener noreferrer"
          aria-label={t('track.cta.download') + ': ' + (doc.file_name || doc.document_type || doc.rec_type_code || '')}
          style={{
            color: 'var(--teal-dk)',
            fontSize: '0.85rem',
            fontWeight: 600,
            textDecoration: 'none',
            flexShrink: 0,
          }}
        >
          {t('track.cta.download')}
        </a>
      )}
    </div>
  );
}

function formatDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, { day: '2-digit', month: 'short', year: 'numeric' });
  } catch { return iso; }
}

export default function Step8Status({ onBack }) {
  const { t }          = useTranslation();
  const { resumeToken } = useWizard();
  const {
    loading, error,
    group, enrollments, milestones, documents, signingSession,
  } = useEnrollmentTrack(resumeToken);

  const [activeTab, setActiveTab] = useState(0);

  const isMulti   = !loading && enrollments.length > 1;
  const safeIdx   = Math.min(activeTab, Math.max(0, enrollments.length - 1));
  const activeEnr = enrollments[safeIdx] || null;

  const activeMilestones = activeEnr
    ? milestones.filter(m => m.entity_id === activeEnr.enrollment_id)
    : milestones;

  return (
    <div>
      <h1 style={{ color: 'var(--teal-dk)', fontWeight: 800, marginBottom: 4 }}>
        {t('track.title')}
      </h1>
      {group && (
        <p style={{ color: 'var(--muted)', marginBottom: 28, fontSize: '0.9rem' }}>
          {group.primary_email}
        </p>
      )}

      {error && (
        <div className="kis-card" style={{ color: 'var(--muted)', textAlign: 'center' }}>
          {t('track.invalid_link_body')}
        </div>
      )}

      {!error && (
        <>
          {isMulti && (
            <div
              role="tablist"
              aria-label={t('track.applicant_tabs.label')}
              style={{ display: 'flex', gap: 8, marginBottom: 20, flexWrap: 'wrap' }}
            >
              {enrollments.map((enr, idx) => {
                const label   = enr.applicant_name || t('track.applicant_tab.unnamed', { n: idx + 1 });
                const isActive = idx === safeIdx;
                return (
                  <button
                    key={enr.enrollment_id}
                    role="tab"
                    aria-selected={isActive}
                    onClick={() => setActiveTab(idx)}
                    style={{
                      padding: '7px 18px',
                      borderRadius: 20,
                      border: '2px solid ' + (isActive ? 'var(--teal-dk)' : 'var(--border)'),
                      background: isActive ? 'var(--teal-dk)' : '#fff',
                      color: isActive ? '#fff' : 'var(--text)',
                      fontWeight: isActive ? 700 : 500,
                      fontSize: '0.88rem',
                      cursor: 'pointer',
                    }}
                  >
                    {label}
                  </button>
                );
              })}
            </div>
          )}

          <section aria-label={t('track.state.current')} style={{ marginBottom: 28 }}>
            <SectionTitle>{t('track.state.current')}</SectionTitle>
            {loading ? (
              <div className="kis-card">
                <SkeletonBlock height={48} />
                <SkeletonBlock height={24} style={{ width: '60%' }} />
              </div>
            ) : activeEnr ? (
              <StateCard enr={activeEnr} t={t} />
            ) : null}
          </section>

          <section style={{ marginBottom: 28 }}>
            <SectionTitle>{t('track.milestones.title')}</SectionTitle>
            {loading ? (
              <div className="kis-card">
                <SkeletonBlock /><SkeletonBlock /><SkeletonBlock />
              </div>
            ) : activeMilestones.length === 0 ? (
              <EmptyState icon="📋" message={t('track.empty.milestones')} />
            ) : (
              <div className="kis-card" style={{ padding: 0, overflow: 'hidden' }}>
                {activeMilestones.map((m, i) => (
                  <MilestoneRow
                    key={m.milestone_id}
                    milestone={m}
                    t={t}
                    isLast={i === activeMilestones.length - 1}
                    signingSession={signingSession}
                  />
                ))}
              </div>
            )}
          </section>

          <section style={{ marginBottom: 28 }}>
            <SectionTitle>{t('track.documents.title')}</SectionTitle>
            {loading ? (
              <div className="kis-card"><SkeletonBlock /><SkeletonBlock /></div>
            ) : documents.length === 0 ? (
              <EmptyState icon="📄" message={t('track.empty.documents')} />
            ) : (
              <div className="kis-card" style={{ padding: 0, overflow: 'hidden' }}>
                {documents.map((doc, i) => (
                  <DocumentRow
                    key={doc.file_id}
                    doc={doc}
                    t={t}
                    isLast={i === documents.length - 1}
                  />
                ))}
              </div>
            )}
          </section>
        </>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 8, marginBottom: 32 }}>
        <button className="btn-secondary-kis" onClick={onBack}>
          <i className="bi bi-arrow-left me-1" /> {t('nav.back')}
        </button>
      </div>

      <style>{`
        @keyframes skeleton-shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `}</style>
    </div>
  );
}
