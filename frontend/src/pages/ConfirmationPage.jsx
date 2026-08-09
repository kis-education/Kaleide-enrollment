import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Link } from 'react-router-dom';
import LangToggle from '../components/LangToggle';
import { useWizard } from '../context/WizardContext';
import { gasCall } from '../api';

const LOGO = 'https://raw.githubusercontent.com/kaleideschool/public/main/favicon.png';

export default function ConfirmationPage() {
  const { t }                        = useTranslation();
  const { enrollmentGroupId, resumeToken, recoveryNonce } = useWizard();

  // DL-E49 §5 — ACUSE al que envía antes que los demás. Se pregunta al servidor en vez de
  // deducirlo del resultado del envío porque el envío vuela en segundo plano (la pantalla
  // ya está aquí cuando termina). Si falla, no se dice nada: nunca se inventa un estado.
  const [partes, setPartes] = useState(null);
  useEffect(() => {
    if (!resumeToken) return;
    gasCall('estadoDeLasPartes', { resume_token: resumeToken, n: recoveryNonce || undefined })
      .then(setPartes)
      .catch(() => {});
  }, [resumeToken, recoveryNonce]);

  return (
    <div className="wizard-layout">
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

      <div style={{ maxWidth: 600, margin: '60px auto', padding: '0 16px', textAlign: 'center' }}>
        <div className="confirmation-icon">
          <i className="bi bi-check-lg" />
        </div>

        <h1 style={{ color: 'var(--teal-dk)', fontWeight: 800, marginBottom: 8 }}>
          {t('confirmation.title')}
        </h1>
        <p style={{ color: 'var(--muted)', marginBottom: 8 }}>
          {t('confirmation.subtitle')}
        </p>

        {enrollmentGroupId && (
          <div className="kis-card" style={{ textAlign: 'left', marginTop: 28 }}>
            <p style={{ margin: 0, fontSize: '0.85rem', color: 'var(--muted)' }}>
              {t('confirmation.app_id_label')}
            </p>
            <p style={{ margin: '4px 0 0', fontFamily: 'monospace', color: 'var(--teal-dk)', fontWeight: 700 }}>
              {enrollmentGroupId}
            </p>
          </div>
        )}

        {partes && partes.ya_envio && !partes.todas_enviadas && partes.faltan_nombres?.length > 0 && (
          <div className="kis-card" style={{ textAlign: 'left', marginTop: 20, borderLeft: '4px solid var(--teal-dk)' }}>
            <h3 style={{ color: 'var(--teal-dk)', marginTop: 0, fontSize: '1rem' }}>
              {t('confirmation.partes.title', { defaultValue: 'Tu parte está enviada' })}
            </h3>
            <p style={{ margin: 0, color: 'var(--text)', lineHeight: 1.7 }}>
              {t('confirmation.partes.body', {
                nombres: partes.faltan_nombres.join(', '),
                defaultValue: 'Hemos registrado tus respuestas. Para que el colegio pueda estudiar la solicitud falta que {{nombres}} complete su parte. Te avisaremos cuando esté.',
              })}
            </p>
          </div>
        )}

        <div className="kis-card" style={{ textAlign: 'left', marginTop: 20 }}>
          <h3 style={{ color: 'var(--teal-dk)', marginTop: 0, fontSize: '1rem' }}>
            {t('confirmation.next_steps_title')}
          </h3>
          <ul style={{ color: 'var(--text)', lineHeight: 1.8, paddingLeft: 20 }}>
            <li>{t('confirmation.next_1')}</li>
            <li>{t('confirmation.next_2')}</li>
            <li>{t('confirmation.next_3')}</li>
          </ul>
        </div>

        {resumeToken && (
          <div style={{ marginTop: 28 }}>
            <Link
              to="/apply"
              style={{
                display: 'inline-block',
                background: 'var(--teal-dk)',
                color: '#fff',
                padding: '10px 24px',
                borderRadius: 8,
                fontWeight: 700,
                textDecoration: 'none',
                fontSize: '0.95rem',
              }}
            >
              {t('confirmation.view_cta')}
            </Link>
          </div>
        )}

        <p style={{ color: 'var(--muted)', fontSize: '0.85rem', marginTop: 24 }}>
          {t('confirmation.contact_prefix')}{' '}
          <a href="mailto:admissions@kaleide.org" style={{ color: 'var(--teal-dk)' }}>
            admissions@kaleide.org
          </a>
        </p>
      </div>
    </div>
  );
}
