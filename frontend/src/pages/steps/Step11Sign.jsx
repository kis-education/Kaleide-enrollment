import { useTranslation } from 'react-i18next';
import { SignSign } from '../signing/SigningSteps';

/**
 * Step 11 — S-SIGN (Firma electrónica Click & Sign).
 *
 * DL-E38 merge (flujo continuo 1→11): paso TERMINAL del wizard. Renderiza el
 * componente FUNCIONAL `SignSign` (el mismo que /sign usa vía SigningSteps),
 * autenticado por el `signing_token` per-guardian resuelto al entrar (server-side,
 * KAL-4). Incluye el gate INCONDICIONAL de step-up (DL-E39) + IP forense (DL-E39) +
 * polling del estado de la sesión Click & Sign. No avanza (es el último paso);
 * "Atrás" vuelve al Step 10 (onBack). La pantalla de éxito es terminal.
 *
 * El trabajo funcional vive en pages/signing/SigningSteps.jsx — NO se duplica aquí.
 */
export default function Step11Sign({ onBack, signingToken, signerCtx }) {
  const { t } = useTranslation();

  if (!signingToken) {
    return (
      <div className="kis-card" style={{ textAlign: 'center', padding: '40px 24px', color: 'var(--muted)' }}>
        <p style={{ fontSize: '1.6rem', marginBottom: 12 }} aria-hidden="true">🔒</p>
        <p style={{ margin: 0 }}>{t('step.signing.locked.body')}</p>
        <div style={{ marginTop: 24 }}>
          <button className="btn-secondary-kis" onClick={onBack}>
            <i className="bi bi-arrow-left me-1" /> {t('nav.back')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <SignSign
      signingToken={signingToken}
      signerCtx={signerCtx || {}}
      onDone={() => { /* terminal — stays on success screen */ }}
    />
  );
}
