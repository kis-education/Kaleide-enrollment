import { useEffect, useState } from 'react';
import { useParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { gasCall } from '../api';
import * as log from '../logger';

/**
 * /report/:token — destination of the "esto no es mío" link in magic-link
 * emails. Calls backend reportUnsolicited, which (a) blocks the email
 * address from receiving more magic links for ~6h, (b) notifies staff.
 *
 * Response is always success (anti-enumeration: never reveal whether the
 * token mapped to a real session). The UI shows a thank-you regardless.
 */
export default function ReportUnsolicitedPage() {
  const { token } = useParams();
  const { t } = useTranslation();
  const [state, setState] = useState('pending'); // 'pending' | 'done' | 'error'

  useEffect(() => {
    if (!token) {
      setState('done');
      return;
    }
    // KAL-7: strip the token from the URL bar before doing anything else.
    // The token is held in the closure for the gasCall below.
    try {
      const cleanUrl = window.location.pathname + window.location.search + '#/';
      window.history.replaceState(null, '', cleanUrl);
    } catch { /* non-fatal */ }
    // KAL-11: log only a token preview, never the full bearer secret.
    const tokenPreview = String(token).slice(0, 8) + '...';
    log.info('ReportUnsolicitedPage: reporting', { resume_token_preview: tokenPreview });
    gasCall('reportUnsolicited', { resume_token: token })
      .then(() => setState('done'))
      .catch(err => {
        log.warn('ReportUnsolicitedPage: backend returned error (treating as done)', { err: err && err.message });
        // Surface as "done" anyway — the user did their part. Internal alert went out
        // even on partial failure (see reportUnsolicited_ try/catch in backend).
        setState('done');
      });
  }, [token]);

  return (
    <div style={{
      maxWidth: 560,
      margin: '80px auto',
      padding: '32px 28px',
      background: '#fff',
      borderRadius: 12,
      boxShadow: '0 4px 24px rgba(13,148,136,0.08)',
      textAlign: 'center',
      fontFamily: '-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif',
    }}>
      {state === 'pending' ? (
        <>
          <div className="spinner" style={{ marginBottom: 20 }} />
          <p style={{ color: '#4a5568' }}>{t('report.pending', 'Procesando…')}</p>
        </>
      ) : (
        <>
          <div style={{
            width: 56, height: 56,
            background: '#ccfbf1',
            borderRadius: '50%',
            display: 'flex', alignItems: 'center', justifyContent: 'center',
            margin: '0 auto 20px',
            fontSize: 28,
          }}>✓</div>
          <h1 style={{ fontSize: '1.35rem', fontWeight: 700, color: '#0d9488', marginBottom: 12 }}>
            {t('report.thanks_title', 'Gracias por avisarnos')}
          </h1>
          <p style={{ color: '#555', lineHeight: 1.5, marginBottom: 12 }}>
            {t('report.thanks_body',
              'Hemos registrado tu reporte y bloqueado temporalmente nuevos envíos a tu correo. ' +
              'Nuestro equipo revisará el caso. No tienes que hacer nada más.')}
          </p>
          <p style={{ color: '#777', fontSize: '0.88rem' }}>
            {t('report.contact_hint', 'Si quieres contactar con nosotros: ')}
            <a href="mailto:admisiones@kaleide.org" style={{ color: '#0d9488' }}>
              admisiones@kaleide.org
            </a>
          </p>
        </>
      )}
    </div>
  );
}
