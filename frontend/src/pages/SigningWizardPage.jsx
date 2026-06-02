import { useEffect, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { gasCall } from '../api';
import LangToggle from '../components/LangToggle';
import * as log from '../logger';
import SigningSteps from './signing/SigningSteps';

const LOGO = 'https://raw.githubusercontent.com/kaleideschool/public/main/favicon.png';
const ADMISSIONS_EMAIL = 'admissions@kaleide.org';

// Gate states for signing token resolution
const GATE = {
  LOADING:      'LOADING',
  NO_TOKEN:     'NO_TOKEN',
  INVALID:      'INVALID',
  EXPIRED:      'EXPIRED',
  REVOKED:      'REVOKED',
  GDPR_BLOCKED: 'GDPR_BLOCKED',
  READY:        'READY',
};

function Header() {
  const { t } = useTranslation();
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

function ContactCta({ t }) {
  return (
    <p style={{ marginTop: 24, color: 'var(--muted)', fontSize: '0.9rem' }}>
      <a
        href={`mailto:${ADMISSIONS_EMAIL}`}
        className="btn btn-outline-primary btn-sm"
        style={{ textDecoration: 'none' }}
      >
        {t('signing.contact_cta')}
      </a>
    </p>
  );
}

function GateScreen({ icon, iconColor, title, body, showContact }) {
  const { t } = useTranslation();
  return (
    <div className="wizard-layout">
      <Header />
      <div style={{ maxWidth: 560, margin: '60px auto', padding: '0 16px', textAlign: 'center' }}>
        <div style={{ fontSize: '3rem', color: iconColor, marginBottom: 16 }}>
          <i className={`bi ${icon}`} />
        </div>
        <h1 style={{ color: 'var(--teal-dk)', fontWeight: 800, marginBottom: 8 }}>{title}</h1>
        <p style={{ color: 'var(--muted)', lineHeight: 1.6 }}>{body}</p>
        {showContact && <ContactCta t={t} />}
      </div>
    </div>
  );
}

function ReadyView({ signerCtx, signingToken }) {
  const { t } = useTranslation();

  return (
    <div className="wizard-layout">
      <Header />
      <div style={{ maxWidth: 680, margin: '40px auto', padding: '0 16px' }}>
        <h1 style={{ color: 'var(--teal-dk)', fontWeight: 800, marginBottom: 4 }}>
          {t('signing.ready_title')}
        </h1>
        <p style={{ color: 'var(--muted)', marginBottom: 24 }}>
          {t('signing.ready_subtitle')}
        </p>

        {/* WS5 (CLI 45) — flujo funcional de firma billing → gdpr → review → sign.
            Vive aquí (/sign), NO en el wizard /apply. signingToken viene del query
            param resuelto por resolveSigningToken (signerCtx). */}
        <SigningSteps signingToken={signingToken} signerCtx={signerCtx} />
      </div>
    </div>
  );
}

export default function SigningWizardPage() {
  const [searchParams]        = useSearchParams();
  const [gate, setGate]       = useState(GATE.LOADING);
  const [signerCtx, setSignerCtx] = useState(null);
  const [signingToken, setSigningToken] = useState(null);
  const { t }                 = useTranslation();

  useEffect(() => {
    const token = searchParams.get('signing_token');

    if (!token) {
      log.warn('SigningWizardPage: no signing_token in URL');
      setGate(GATE.NO_TOKEN);
      return;
    }

    log.info('SigningWizardPage: resolving signing_token', { token: token.substring(0, 8) + '...' });
    setSigningToken(token);

    gasCall('resolveSigningToken', { signing_token: token })
      .then(data => {
        if (!data.valid) {
          const reason = data.reason || 'INVALID';
          log.warn('SigningWizardPage: token invalid', { reason, state: data.state });
          if (reason === 'REVOKED')  { setGate(GATE.REVOKED);  return; }
          if (reason === 'EXPIRED')  { setGate(GATE.EXPIRED);  return; }
          setGate(GATE.INVALID);
          return;
        }

        if (data.steps?.gdpr_blocked) {
          log.warn('SigningWizardPage: GDPR blocked', { signer_id: data.signer_id });
          setGate(GATE.GDPR_BLOCKED);
          return;
        }

        log.success('SigningWizardPage: token valid, signer ready', {
          signer_id:  data.signer_id,
          session_id: data.session_id,
          steps:      data.steps,
        });
        setSignerCtx(data);
        setGate(GATE.READY);
      })
      .catch(err => {
        log.error('SigningWizardPage: resolveSigningToken failed', { message: err.message });
        setGate(GATE.INVALID);
      });
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  // ── Gate rendering ─────────────────────────────────────────────────────────

  if (gate === GATE.LOADING) {
    return (
      <div className="wizard-layout">
        <Header />
        <div style={{ textAlign: 'center', paddingTop: 80 }}>
          <div className="spinner" />
          <p style={{ color: 'var(--muted)', marginTop: 12 }}>{t('signing.loading')}</p>
        </div>
      </div>
    );
  }

  if (gate === GATE.NO_TOKEN) {
    return (
      <GateScreen
        icon="bi-lock"
        iconColor="var(--muted)"
        title={t('signing.no_token_title')}
        body={t('signing.no_token_body')}
        showContact={false}
      />
    );
  }

  if (gate === GATE.INVALID) {
    return (
      <GateScreen
        icon="bi-x-circle"
        iconColor="#e03131"
        title={t('signing.invalid_title')}
        body={t('signing.invalid_body')}
        showContact
      />
    );
  }

  if (gate === GATE.EXPIRED) {
    return (
      <GateScreen
        icon="bi-clock"
        iconColor="#f08c00"
        title={t('signing.expired_title')}
        body={t('signing.expired_body')}
        showContact
      />
    );
  }

  if (gate === GATE.REVOKED) {
    return (
      <GateScreen
        icon="bi-check-circle"
        iconColor="var(--teal-dk)"
        title={t('signing.revoked_title')}
        body={t('signing.revoked_body')}
        showContact={false}
      />
    );
  }

  if (gate === GATE.GDPR_BLOCKED) {
    return (
      <GateScreen
        icon="bi-shield-x"
        iconColor="#e03131"
        title={t('signing.gdpr_blocked_title')}
        body={t('signing.gdpr_blocked_body')}
        showContact
      />
    );
  }

  // READY — render signing step router (WS5 — billing → gdpr → review → sign)
  return <ReadyView signerCtx={signerCtx} signingToken={signingToken} />;
}
