import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useWizard } from '../context/WizardContext';

/**
 * WPERF-1 (criterios 2 + 3) — indicador de guardado global estilo Google Docs.
 *
 * Vive en la barra superior del wizard, FUERA de los botones de paso (los botones ya
 * no muestran "Guardando…"): la navegación nunca se bloquea por un save en vuelo, y el
 * estado de la cola se comunica aquí. Gobernado por `saveState` del WizardContext:
 *   - 'saving' → "Guardando…"
 *   - 'error'  → aviso rojo que DICE qué no se pudo guardar + "Reintentar" + una X para
 *                cerrarlo (cola 18.bis, Diego 2026-08-09)
 *   - 'idle'   → "Todos los cambios guardados" (solo si ya se guardó ≥1 paso, para no
 *                anunciar "guardado" en un wizard recién abierto)
 *
 * ── LA X CIERRA EL CARTEL, NO EL PROBLEMA ────────────────────────────────────────────
 * Diego pidió poder ocultar el aviso rojo. Cerrarlo NO toca el estado de la cola: si de
 * verdad queda algo sin guardar, `saveState` sigue en 'error', la última save fallida
 * sigue guardada para reintentarla, y el indicador se queda MUDO (`<span />`) — jamás
 * cae al «Todos los cambios guardados», que sería la mentira que este trabajo viene a
 * quitar. El cierre es por EPISODIO (`saveErrorSeq`): si vuelve a fallar un guardado, el
 * aviso reaparece, porque eso ya es una noticia nueva.
 *
 * Componente sin props: lee todo del contexto para poder colocarse en cualquier host
 * del wizard (es endpoint-agnóstico — sobrevive a la migración a KMS de Fase 2).
 */
export default function SaveIndicator() {
  const { t } = useTranslation();
  const { saveState, completedSteps, retryLastSave, saveErrorSeq, saveErrorQue } = useWizard();
  // Episodio de fallo que el usuario cerró a mano. `null` = no ha cerrado ninguno.
  const [episodioCerrado, setEpisodioCerrado] = useState(null);

  const base = { fontSize: '0.82rem', display: 'inline-flex', alignItems: 'center', gap: 6 };

  if (saveState === 'saving') {
    return (
      <span style={{ ...base, color: 'var(--muted)' }} aria-live="polite" data-testid="save-indicator-saving">
        <i className="bi bi-cloud-arrow-up" />
        {t('wizard.saving_in_background', 'Guardando…')}
      </span>
    );
  }

  if (saveState === 'error') {
    // Cerrado a mano: se calla, pero NO dice que esté guardado (el estado sigue en error).
    if (episodioCerrado === saveErrorSeq) return <span data-testid="save-indicator-mute" />;
    const texto = saveErrorQue
      ? t('wizard.save_error_step', 'No se ha podido guardar «{{paso}}». Lo que escribiste sigue aquí.', { paso: saveErrorQue })
      : t('wizard.save_error', 'No se ha podido guardar tu último cambio. Lo que escribiste sigue aquí.');
    return (
      <span style={{ ...base, color: '#a02020' }} aria-live="assertive" data-testid="save-indicator-error">
        <i className="bi bi-exclamation-triangle" />
        {texto}
        <button
          type="button"
          onClick={retryLastSave}
          data-testid="save-error-retry"
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
        <button
          type="button"
          onClick={() => setEpisodioCerrado(saveErrorSeq)}
          data-testid="save-error-dismiss"
          aria-label={t('wizard.dismiss_save_error', 'Ocultar este aviso')}
          title={t('wizard.dismiss_save_error', 'Ocultar este aviso')}
          style={{
            // La X es TEXTO, no un icono de fuente externa, y tiene caja propia: un botón
            // de cerrar cuyo único contenido es un glifo de la fuente de iconos DESAPARECE
            // si esa fuente no carga (CDN caído, red del colegio, modo de ahorro) — y
            // entonces el aviso vuelve a ser imposible de cerrar, que es el defecto que
            // esto viene a quitar. Medido con la batería: con la fuente bloqueada el botón
            // quedaba de 4×0 px y ni el navegador lo consideraba visible.
            background: 'transparent',
            border: 'none',
            color: '#a02020',
            fontSize: '1.05rem',
            lineHeight: '18px',
            width: 20,
            height: 20,
            cursor: 'pointer',
            padding: 0,
            marginLeft: 2,
          }}
        >
          <span aria-hidden="true">×</span>
        </button>
      </span>
    );
  }

  if (completedSteps.size > 0) {
    return (
      <span style={{ ...base, color: 'var(--muted)' }} aria-live="polite" data-testid="save-indicator-idle">
        <i className="bi bi-check2-circle" />
        {t('wizard.all_changes_saved', 'Todos los cambios guardados')}
      </span>
    );
  }

  return <span />;
}
