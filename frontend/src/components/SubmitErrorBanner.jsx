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
 *
 * ★ 18.bis.21 — el aviso MIRA EL CÓDIGO del rechazo. «No se ha podido enviar, reinténtalo»
 * es un callejón sin salida cuando el motivo es un dato que hay que corregir: reintentar
 * vuelve a fallar exactamente igual. Los códigos que sabemos explicar dicen qué pasa y qué
 * hacer; el RESTO sigue mostrando el texto genérico de siempre, byte-idéntico.
 * ⚠️ El mensaje NUNCA lleva el número de teléfono (KAL-11): se nombra el paso, no el dato.
 */
const MOTIVOS_QUE_SABEMOS_EXPLICAR = {
  INVALID_PHONE: 'wizard.submit_failed.invalid_phone',
  // ②27 — el envío exige el código de un solo uso. El paso 7 lo pide ANTES de navegar,
  // así que esto es el respaldo del hueco que queda: que la ventana de 10 min se agote
  // entre esa comprobación y la llamada, que vuela en segundo plano. «Reintentar» no lo
  // arregla, así que el aviso dice lo que sí: volver al resumen y reenviar desde allí.
  STEPUP_REQUIRED: 'wizard.submit_failed.stepup_required',
};

export default function SubmitErrorBanner() {
  const { t } = useTranslation();
  const { submitError, retryLastSave, saveState } = useWizard();
  if (!submitError) return null;
  const codigo = typeof submitError === 'string' ? submitError : '';
  const claveMensaje = MOTIVOS_QUE_SABEMOS_EXPLICAR[codigo] || 'wizard.submit_failed';
  const retrying = saveState === 'saving';
  return (
    <div role="alert" aria-live="assertive" style={{
      position: 'fixed', top: 0, left: 0, right: 0, zIndex: 11000,
      background: '#a02020', color: '#fff', padding: '10px 16px',
      display: 'flex', alignItems: 'center', justifyContent: 'center', gap: 12,
      fontSize: '0.9rem', boxShadow: '0 2px 8px rgba(0,0,0,0.25)',
    }}>
      <i className="bi bi-exclamation-triangle-fill" />
      <span data-testid="submit-error-text">{t(claveMensaje)}</span>
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
