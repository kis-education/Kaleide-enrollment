import { useTranslation } from 'react-i18next';
import { useWizard } from '../context/WizardContext';

/**
 * WPERF-1 (criterios 2 + 3) — indicador de guardado global estilo Google Docs.
 *
 * Vive en la barra superior del wizard, FUERA de los botones de paso (los botones ya
 * no muestran "Guardando…"): la navegación nunca se bloquea por un save en vuelo, y el
 * estado de la cola se comunica aquí. Gobernado por `saveState` del WizardContext:
 *   - 'saving' → "Guardando…"
 *   - 'error'  → "Error al guardar" + botón "Reintentar" (re-encola la última save fallida)
 *   - 'idle'   → "Todos los cambios guardados" (solo si ya se guardó ≥1 paso, para no
 *                anunciar "guardado" en un wizard recién abierto)
 *
 * Componente sin props: lee todo del contexto para poder colocarse en cualquier host
 * del wizard (es endpoint-agnóstico — sobrevive a la migración a KMS de Fase 2).
 */
export default function SaveIndicator() {
  const { t } = useTranslation();
  const { saveState, completedSteps, retryLastSave } = useWizard();

  const base = { fontSize: '0.82rem', display: 'inline-flex', alignItems: 'center', gap: 6 };

  if (saveState === 'saving') {
    return (
      <span style={{ ...base, color: 'var(--muted)' }} aria-live="polite">
        <i className="bi bi-cloud-arrow-up" />
        {t('wizard.saving_in_background', 'Guardando…')}
      </span>
    );
  }

  if (saveState === 'error') {
    return (
      <span style={{ ...base, color: '#a02020' }} aria-live="assertive">
        <i className="bi bi-exclamation-triangle" />
        {t('wizard.save_error', 'Error al guardar')}
        <button
          type="button"
          onClick={retryLastSave}
          style={{
            background: 'transparent',
            border: 'none',
            color: '#a02020',
            fontSize: '0.82rem',
            cursor: 'pointer',
            padding: '0 2px',
            textDecoration: 'underline',
          }}
        >
          {t('wizard.retry_save', 'Reintentar')}
        </button>
      </span>
    );
  }

  if (completedSteps.size > 0) {
    return (
      <span style={{ ...base, color: 'var(--muted)' }} aria-live="polite">
        <i className="bi bi-check2-circle" />
        {t('wizard.all_changes_saved', 'Todos los cambios guardados')}
      </span>
    );
  }

  return <span />;
}
