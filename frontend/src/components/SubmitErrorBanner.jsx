import { useTranslation } from 'react-i18next';
import { useWizard } from '../context/WizardContext';

/**
 * UX-3 — aviso GLOBAL de fallo del envío optimista del Step 7.
 *
 * El submit del Step 7 es optimista: la UI asume "enviado" y navega a /confirmation de
 * inmediato, mientras `submitEnrollmentSession` vuela en background por el carril de
 * `enqueueSave`. Si ese submit FALLA, la factory revierte el estado optimista
 * (setIsSubmitted(false) → edición re-habilitada) y enciende `submitError`. Este banner —
 * montado en App, FUERA de las rutas y por encima de los overlays — lo hace visible en
 * CUALQUIER ruta (incl. /confirmation, donde el SaveIndicator del wizard no se renderiza),
 * para que un fallo NUNCA quede como "enviado" silencioso. El botón reintenta vía
 * `retryLastSave` (re-encola la MISMA factory completa); al resolver, la factory limpia
 * `submitError` y restaura isSubmitted=true.
 */
export default function SubmitErrorBanner() {
  const { t } = useTranslation();
  const { submitError, retryLastSave, saveState } = useWizard();
  if (!submitError) return null;
  const retrying = saveState === 'saving';
  return (
    <div role="alert" aria-live="assertive" style={{
      position: 'fixed', top: 0, left: 0, right: 0, zIndex: 11000,
      background: '#a02020', color: '#fff', padding: '10px 16px',
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12,
      fontSize: '0.9rem', boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
    }}>
      <i className="bi bi-exclamation-triangle-fill" />
      <span>{t('wizard.submit_failed')}</span>
      <button
        type="button"
        onClick={retryLastSave}
        disabled={retrying}
        style={{
          background: '#fff', color: '#a02020', border: 'none', borderRadius: 4,
          padding: '4px 10px', cursor: retrying ? 'wait' : 'pointer', fontWeight: 600,
        }}
      >
        {retrying ? t('wizard.saving_in_background', 'Guardando…') : t('wizard.submit_retry')}
      </button>
    </div>
  );
}
