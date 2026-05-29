import { useEffect } from 'react';
import { useParams, useNavigate, Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import LangToggle from '../components/LangToggle';
import { useEnrollmentTrack } from '../hooks/useEnrollmentTrack';

const LOGO = 'https://raw.githubusercontent.com/kaleideschool/public/main/favicon.png';

// Inline state code → i18n key map.
// state_label from the backend (sysStates_T.designation) takes precedence;
// this map is a fallback for when the backend can't resolve the label.
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

export default function TrackApplicationPage() {
  const { token }   = useParams();
  const navigate    = useNavigate();
  const { t }       = useTranslation();
  const {
    loading, error, notSubmitted,
    group, enrollments, milestones, documents, signingSession,
  } = useEnrollmentTrack(token);

  // Redirect if application not yet submitted → back to wizard
  useEffect(() => {
    if (notSubmitted && token) {
      navigate('/resume/' + token, { replace: true });
    }
  }, [notSubmitted, token, navigate]);

  // Invalid / no token
  if (!token || error === 'no_token') {
    return (
      <div className="wizard-layout">
        <Header t={t} />
        <div style={{ maxWidth: 600, margin: '60px auto', padding: '0 16px', textAlign: 'center' }}>
          <h2 style={{ color: 'var(--teal-dk)' }}>{t('track.invalid_link_title')}</h2>
          <p style={{ color: 'var(--muted)' }}>{t('track.invalid_link_body')}</p>
          <Link to="/" style={{ color: 'var(--teal-dk)' }}>{t('track.go_home')}</Link>
        </div>
      </div>
    );
  }

  if (error && !notSubmitted) {
    return (
      <div className="wizard-layout">
        <Header t={t} />
        <div style={{ maxWidth: 600, margin: '60px auto', padding: '0 16px', textAlign: 'center' }}>
          <h2 style={{ color: 'var(--teal-dk)' }}>{t('track.invalid_link_title')}</h2>
          <p style={{ color: 'var(--muted)' }}>{t('track.invalid_link_body')}</p>
          <Link to="/" style={{ color: 'var(--teal-dk)' }}>{t('track.go_home')}</Link>
        </div>
      </div>
    );
  }

  return (
    <div className="wizard-layout">
      <Header t={t} />

      <div style={{ maxWidth: 680, margin: '40px auto', padding: '0 16px' }}>
        <h1 style={{ color: 'var(--teal-dk)', fontWeight: 800, marginBottom: 4 }}>
          {t('track.title')}
        </h1>
        {group && (
          <p style={{ color: 'var(--muted)', marginBottom: 28, fontSize: '0.9rem' }}>
            {group.primary_email}
          </p>
        )}

        {/* ── Section 1: Current State ─────────────────────────────────────── */}
        <section style={{ marginBottom: 28 }}>
          <SectionTitle>{t('track.state.current')}</SectionTitle>
          {loading ? (
            <div className="kis-card"><SkeletonBlock height={48} /><SkeletonBlock height={24} style={{ width: '60%' }} /></div>
          ) : (
            enrollments.map(enr => (
              <StateCard key={enr.enrollment_id} enr={enr} t={t} />
            ))
          )}
        </section>

        {/* ── Section 2: Milestones ─────────────────────────────────────────── */}
        <section style={{ marginBottom: 28 }}>
          <SectionTitle>{t('track.milestones.title')}</SectionTitle>
          {loading ? (
            <div className="kis-card">
              <SkeletonBlock /><SkeletonBlock /><SkeletonBlock />
            </div>
          ) : milestones.length === 0 ? (
            <div className="kis-card" style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>
              {t('track.milestones.empty')}
            </div>
          ) : (
            <div className="kis-card" style={{ padding: 0, overflow: 'hidden' }}>
              {milestones.map((m, i) => (
                <MilestoneRow
                  key={m.milestone_id}
                  milestone={m}
                  t={t}
                  isLast={i === milestones.length - 1}
                  signingSession={signingSession}
                />
              ))}
            </div>
          )}
        </section>

        {/* ── Section 3: Documents ─────────────────────────────────────────── */}
        <section style={{ marginBottom: 28 }}>
          <SectionTitle>{t('track.documents.title')}</SectionTitle>
          {loading ? (
            <div className="kis-card"><SkeletonBlock /><SkeletonBlock /></div>
          ) : documents.length === 0 ? (
            <div className="kis-card" style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>
              {t('track.documents.empty')}
            </div>
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

        {/* ── Footer ───────────────────────────────────────────────────────── */}
        <p style={{ color: 'var(--muted)', fontSize: '0.85rem', textAlign: 'center', marginTop: 32, marginBottom: 40 }}>
          {t('track.footer.contact')}{' '}
          <a href="mailto:admissions@kaleide.org" style={{ color: 'var(--teal-dk)' }}>
            admissions@kaleide.org
          </a>
        </p>
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

// ─── Sub-components ───────────────────────────────────────────────────────────

function Header({ t }) {
  return (
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

function StateCard({ enr, t }) {
  const stateCode  = enr.state_code  || '—';
  const stateLabel = enr.state_label || t(STATE_I18N_KEY[stateCode] || 'track.state.unknown', { defaultValue: stateCode });
  const color      = STATE_COLOR[stateCode] || 'var(--teal-dk)';

  return (
    <div className="kis-card">
      <div style={{ display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap' }}>
        <span style={{
          background: color,
          color: '#fff',
          padding: '4px 14px',
          borderRadius: 20,
          fontWeight: 700,
          fontSize: '0.95rem',
          letterSpacing: '0.03em',
        }}>
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
        <span style={{
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
        <span style={{ fontSize: '0.78rem', color, fontWeight: 600 }}>
          {t('track.milestone_status.' + status, { defaultValue: status })}
        </span>
        {firstPendingSigner && (
          <a
            href={firstPendingSigner.signing_url}
            target="_blank"
            rel="noopener noreferrer"
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
        {isDone && <span style={{ color: '#2f9e44', fontSize: '1rem' }}>✓</span>}
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
