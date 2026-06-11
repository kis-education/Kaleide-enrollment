import { useEffect } from 'react';
import { useWizard } from '../context/WizardContext';
import StepNav from './StepNav';
import LockedBanner from './LockedBanner';

/**
 * STEP-FRAMEWORK (Diego 2026-06-11) — CHASIS ÚNICO de un paso del wizard.
 *
 * Cita de Diego: "Aunque sea la misma ruta, se tratan de forma diferenciada. Tienes
 * que unificar." Antes los pasos 1-7 usaban StepNav + LockedBanner + la nube global
 * (SaveIndicator), mientras los 8-11 usaban un `SigningNav` propio con su spinner
 * "Guardando…" DENTRO del botón → guardado NO optimista, sin la nube, tratado distinto.
 *
 * StepShell es la carrocería compartida por TODO paso (catálogo declarativo en
 * steps/catalog.js):
 *   - Navegación estándar (Atrás / Continuar) ARRIBA y ABAJO, idéntica a los pasos
 *     1-6 (mismo StepNav, mismos estilos btn-secondary-kis / btn-primary-kis).
 *   - Candado por estado: LockedBanner ("sección guardada y bloqueada") cuando
 *     `locked` (gobernado por el catálogo: completedSteps para 1-6, estado real para
 *     8-10). El cuerpo queda en un <fieldset disabled> cuando bloqueado.
 *   - Guardado OPTIMISTA con NUBE: el indicador de guardado es la nube GLOBAL
 *     (SaveIndicator en la barra superior, gobernada por saveState de WizardContext).
 *     El botón "Continuar" NUNCA muestra "Guardando…" ni se bloquea por un save en
 *     vuelo — la navegación es no-bloqueante (WPERF-1). Los actos de firma (8-10)
 *     persisten vía la MISMA cola FIFO (setPendingSave → enqueueSave) → la MISMA nube.
 *   - Errores de acto INLINE: `error` se pinta bajo el cuerpo (regla de oro del acto:
 *     fallo visible, jamás éxito falso).
 *   - Validación: `validationError` global (sticky) la pinta WizardPage arriba; el
 *     error per-paso (`error`) va inline aquí.
 *   - Precarga al entrar: `preload` (del catálogo) se dispara una vez al montar.
 *   - touchActivity: cualquier interacción resetea el contador de inactividad del
 *     step-up (DL-E39) — un usuario activo nunca es expulsado a mitad de un paso.
 *
 * El cuerpo del paso (formulario) va como `children`. El paso declara su título,
 * subtítulo, handlers de nav, su gate de validación (nextDisabled) y su error inline.
 */
export default function StepShell({
  title,
  subtitle,
  onBack,
  onNext,
  nextLabel,
  backLabel,
  nextDisabled = false,
  /** VIEWER-UX: mensaje fijo bajo el botón Continuar cuando está deshabilitado —
   *  EXPLICA por qué no avanza (e.g. "Acepta los N documentos…"). */
  nextHint = '', // eslint-disable-line react/prop-types
  hideBack = false,
  hideNext = false,
  locked = false,
  onUnlock = null,
  highlight = false,
  error = '',
  /** array de funciones de precarga a ejecutar AL ENTRAR (best-effort, una vez). */
  preload = null,
  children,
}) {
  const { touchActivity } = useWizard();

  // Precarga al entrar (catálogo preload[]). Best-effort: cada función traga sus
  // propios errores. Se dispara una sola vez al montar el paso.
  useEffect(() => {
    if (!preload || !preload.length) return;
    preload.forEach(fn => { try { fn(); } catch { /* best-effort */ } });
  }, []); // eslint-disable-line

  const nav = (position) => (
    <StepNav
      position={position}
      onBack={onBack}
      onNext={onNext}
      nextDisabled={nextDisabled}
      nextHint={nextHint}
      nextLabel={nextLabel}
      backLabel={backLabel}
      hideBack={hideBack}
      hideNext={hideNext}
    />
  );

  return (
    <>
      {(title || subtitle) && (
        <div className="mb-2">
          {title    && <h2 style={{ color: 'var(--teal-dk)', fontWeight: 800 }}>{title}</h2>}
          {subtitle && <p style={{ color: 'var(--muted)' }}>{subtitle}</p>}
        </div>
      )}

      {nav('top')}

      {locked && <LockedBanner onUnlock={onUnlock} highlight={highlight} />}

      <div onClick={locked ? undefined : touchActivity}>
        <fieldset
          disabled={locked}
          style={{ border: 'none', padding: 0, margin: 0, pointerEvents: locked ? 'none' : undefined }}
        >
          {children}
        </fieldset>
      </div>

      {error && (
        <div className="field-error mt-2 p-2 rounded" role="alert" aria-live="assertive" style={{ background: '#ffeaea' }}>
          {error}
        </div>
      )}

      {nav('bottom')}
    </>
  );
}
