import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useWizard } from '../../context/WizardContext';
import { gasCall } from '../../api';
import * as log from '../../logger';

const CONFIG_ERROR_CODES = ['NO_DEFAULT_BANK_ACCOUNT', 'NO_RESERVATION_SUBSCRIPTION_TYPE'];

function formatIban(iban) {
  if (!iban) return '';
  return iban.replace(/\s/g, '').replace(/(.{4})/g, '$1 ').trim();
}

function formatAmount(amount, currency = 'EUR') {
  try {
    return new Intl.NumberFormat('es-ES', {
      style: 'currency',
      currency,
      minimumFractionDigits: 2,
    }).format(amount);
  } catch {
    return `${amount} ${currency}`;
  }
}

function formatDate(iso) {
  if (!iso) return '';
  try {
    return new Date(iso).toLocaleDateString(undefined, {
      day: '2-digit', month: 'long', year: 'numeric',
    });
  } catch { return iso; }
}

function SkeletonBlock({ height = 24, width = '100%', style }) {
  return (
    <div style={{
      background: 'linear-gradient(90deg, #f0f0f0 25%, #e0e0e0 50%, #f0f0f0 75%)',
      backgroundSize: '200% 100%',
      animation: 'skeleton-shimmer 1.4s infinite',
      borderRadius: 6,
      height,
      width,
      marginBottom: 12,
      ...style,
    }} />
  );
}

function CopyButton({ text, copyLabel, copiedLabel }) {
  const [copied, setCopied] = useState(false);

  const handleCopy = () => {
    navigator.clipboard.writeText(text).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }).catch(() => {});
  };

  return (
    <button
      onClick={handleCopy}
      aria-label={copied ? copiedLabel : copyLabel}
      style={{
        background: copied ? '#2f9e44' : 'var(--teal-dk)',
        color: '#fff',
        border: 'none',
        borderRadius: 6,
        padding: '3px 10px',
        fontSize: '0.78rem',
        fontWeight: 600,
        cursor: 'pointer',
        transition: 'background 0.2s',
        flexShrink: 0,
        whiteSpace: 'nowrap',
      }}
    >
      {copied ? copiedLabel : copyLabel}
    </button>
  );
}

function DataRow({ icon, label, value, copyText, copyLabel, copiedLabel, isLast }) {
  return (
    <div style={{
      padding: '12px 16px',
      borderBottom: isLast ? 'none' : '1px solid var(--border)',
      display: 'flex',
      justifyContent: 'space-between',
      alignItems: 'center',
      gap: 8,
    }}>
      <div style={{ display: 'flex', gap: 10, alignItems: 'flex-start', minWidth: 0 }}>
        <span aria-hidden="true" style={{ fontSize: '1.1rem', flexShrink: 0, lineHeight: 1.4 }}>{icon}</span>
        <div style={{ minWidth: 0 }}>
          <div style={{ fontSize: '0.76rem', color: 'var(--muted)', marginBottom: 2 }}>{label}</div>
          <div style={{
            fontSize: '0.93rem',
            fontWeight: 600,
            color: 'var(--text)',
            fontFamily: 'monospace',
            wordBreak: 'break-all',
          }}>
            {value}
          </div>
        </div>
      </div>
      {copyText && (
        <CopyButton
          text={copyText}
          copyLabel={copyLabel}
          copiedLabel={copiedLabel}
        />
      )}
    </div>
  );
}

function useReservationPaymentInfo(resumeToken) {
  const [state, setState] = useState({ loading: true, error: null, data: null });

  useEffect(() => {
    if (!resumeToken) {
      setState({ loading: false, error: 'no_token', data: null });
      return;
    }
    log.info('useReservationPaymentInfo: fetching', { resumeToken });
    setState({ loading: true, error: null, data: null });

    gasCall('getReservationPaymentInfo', { resume_token: resumeToken })
      .then(data => {
        log.success('useReservationPaymentInfo: received', data);
        setState({ loading: false, error: null, data });
      })
      .catch(err => {
        log.error('useReservationPaymentInfo: error', { message: err.message });
        setState({ loading: false, error: err.message || 'unknown', data: null });
      });
  }, [resumeToken]);

  return state;
}

export default function Step12Deposit({ onBack }) {
  const { t } = useTranslation();
  const { resumeToken } = useWizard();
  const { loading, error, data } = useReservationPaymentInfo(resumeToken);

  const copiedLabel = t('step.deposit.copy.copied_feedback');
  const isConfigError = error && CONFIG_ERROR_CODES.some(code => error.includes(code));

  return (
    <div>
      <h1 style={{ color: 'var(--teal-dk)', fontWeight: 800, marginBottom: 4 }}>
        {t('step.deposit.title')}
      </h1>
      <p style={{ color: 'var(--muted)', marginBottom: 28, fontSize: '0.9rem' }}>
        {t('step.deposit.subtitle')}
      </p>

      {/* Loading */}
      {loading && (
        <div className="kis-card">
          <SkeletonBlock height={20} width="50%" />
          <SkeletonBlock height={48} />
          <SkeletonBlock height={48} />
          <SkeletonBlock height={48} />
          <SkeletonBlock height={48} />
        </div>
      )}

      {/* Error */}
      {!loading && error && (
        <div className="kis-card" style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>
          {isConfigError
            ? t('step.deposit.error.config')
            : t('step.deposit.error.generic')}
        </div>
      )}

      {/* PENDING — show bank transfer details */}
      {!loading && !error && data?.payment_status === 'PENDING' && (
        <>
          <p style={{ marginBottom: 16, fontSize: '0.95rem', color: 'var(--text)' }}>
            {t('step.deposit.status.pending.body')}
          </p>

          <div className="kis-card" style={{ padding: 0, overflow: 'hidden', marginBottom: 16 }}>
            <DataRow
              icon="💶"
              label={t('step.deposit.bank.amount_label')}
              value={formatAmount(data.amount, data.currency)}
              isLast={false}
            />
            <DataRow
              icon="🏦"
              label={t('step.deposit.bank.iban_label')}
              value={formatIban(data.bank?.iban)}
              copyText={data.bank?.iban?.replace(/\s/g, '')}
              copyLabel={t('step.deposit.copy.iban')}
              copiedLabel={copiedLabel}
              isLast={!data.bank?.bic && !data.concept_reference && !data.deadline}
            />
            {data.bank?.bic && (
              <DataRow
                icon="🔑"
                label={t('step.deposit.bank.bic_label')}
                value={data.bank.bic}
                isLast={!data.concept_reference && !data.deadline}
              />
            )}
            {data.concept_reference && (
              <DataRow
                icon="📝"
                label={t('step.deposit.bank.concept_label')}
                value={data.concept_reference}
                copyText={data.concept_reference}
                copyLabel={t('step.deposit.copy.concept')}
                copiedLabel={copiedLabel}
                isLast={!data.deadline}
              />
            )}
            {data.deadline && (
              <DataRow
                icon="📅"
                label={t('step.deposit.bank.deadline_label')}
                value={formatDate(data.deadline)}
                isLast
              />
            )}
          </div>

          <div style={{
            background: '#e8f4fd',
            border: '1px solid #bee3f8',
            borderRadius: 8,
            padding: '12px 16px',
            fontSize: '0.88rem',
            color: '#2c5282',
            marginBottom: 20,
          }}>
            <span aria-hidden="true">ℹ</span>{' '}
            {t('step.deposit.status.pending.info')}
          </div>
        </>
      )}

      {/* CONFIRMED */}
      {!loading && !error && data?.payment_status === 'CONFIRMED' && (
        <div className="kis-card">
          <div style={{ display: 'flex', alignItems: 'center', gap: 12, marginBottom: 10 }}>
            <span aria-hidden="true" style={{ fontSize: '1.4rem' }}>✅</span>
            <span style={{
              background: '#2f9e44',
              color: '#fff',
              padding: '4px 14px',
              borderRadius: 20,
              fontWeight: 700,
              fontSize: '0.95rem',
            }}>
              {t('step.deposit.status.confirmed.title')}
            </span>
          </div>
          {data.confirmed_at && (
            <p style={{ color: 'var(--muted)', fontSize: '0.88rem', marginBottom: 8 }}>
              {t('step.deposit.status.confirmed.date', { date: formatDate(data.confirmed_at) })}
            </p>
          )}
          <p style={{ fontSize: '0.9rem', color: 'var(--text)', margin: 0 }}>
            {t('step.deposit.status.confirmed.body')}
          </p>
          {data.receipt_file_id && (
            <div style={{ marginTop: 14 }}>
              <span style={{ color: 'var(--muted)', fontSize: '0.85rem' }}>
                {t('step.deposit.receipt_download')}
              </span>
            </div>
          )}
        </div>
      )}

      {/* NOT_APPLICABLE */}
      {!loading && !error && data?.payment_status === 'NOT_APPLICABLE' && (
        <div className="kis-card" style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>
          {t('step.deposit.status.not_applicable')}
        </div>
      )}

      <div style={{ display: 'flex', justifyContent: 'space-between', marginTop: 24, marginBottom: 32 }}>
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
