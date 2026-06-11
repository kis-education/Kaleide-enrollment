import { useTranslation } from 'react-i18next';

/**
 * Reusable wizard step navigation block (Back / Continue).
 *
 * Renders ONLY the button markup — NO logic. Reproduces the exact markup/styles
 * used inline in every step today (btn-secondary-kis / btn-primary-kis, the
 * bi-arrow-left / bi-arrow-right icons) so the appearance is identical whether the
 * step renders it at the top or the bottom.
 *
 * WPERF-1 (criterios 1+2): el botón "Continuar" YA NO se deshabilita ni muestra
 * "Guardando…" mientras hay un save en vuelo — la navegación es no-bloqueante y el
 * estado de guardado se comunica en el SaveIndicator global (barra superior). El prop
 * `savePending` se conserva por compatibilidad de llamada pero ya no afecta al botón.
 *
 * WIZARD-UX (Diego 2026-06-07): each step renders this TWICE — once above the form
 * (position="top", margin-bottom) and once below (position="bottom", margin-top) —
 * so the user does not have to scroll to the end of a long step to find the buttons.
 * Both instances share the SAME handlers/state (the render is duplicated, not the
 * logic): pass the same onBack/onNext/savePending/nextDisabled to both.
 *
 * @param {Object}   props
 * @param {Function} props.onBack
 * @param {Function} props.onNext
 * @param {boolean} [props.savePending=false]  DEPRECATED (WPERF-1): ignorado; el save es no-bloqueante
 * @param {boolean} [props.nextDisabled=false] per-step gate (e.g. validation)
 * @param {string}  [props.nextHint]           VIEWER-UX: cuando nextDisabled, mensaje
 *                                             FIJO bajo el botón que EXPLICA por qué no
 *                                             avanza (queja Diego 2026-06-11: el botón
 *                                             gateado "parece que no hace nada")
 * @param {string}  [props.backLabel]          override (default t('nav.back'))
 * @param {string}  [props.nextLabel]          override (default t('nav.continue'))
 * @param {boolean} [props.hideBack=false]     hide Back (e.g. Step1, the first step)
 * @param {boolean} [props.hideNext=false]     hide Next (e.g. Step7 top — Back only)
 * @param {'top'|'bottom'} [props.position='bottom']
 */
export default function StepNav({
  onBack,
  onNext,
  savePending = false, // eslint-disable-line no-unused-vars — DEPRECATED (WPERF-1), conservado por compat de llamada
  nextDisabled = false,
  nextHint = '', // eslint-disable-line react/prop-types
  backLabel,
  nextLabel,
  hideBack = false,
  hideNext = false,
  position = 'bottom',
}) {
  const { t } = useTranslation();
  // bottom keeps the historical `mt-4`; top uses `mb-3` so it sits cleanly under
  // the header without pushing the form down too far.
  const wrapClass = position === 'top'
    ? 'd-flex justify-content-between mb-3'
    : 'd-flex justify-content-between mt-4';

  return (
    <div className={wrapClass}>
      {hideBack
        ? <span />  /* keep flex spacing so Next stays right-aligned */
        : (
          <button className="btn-secondary-kis" onClick={onBack}>
            <i className="bi bi-arrow-left me-1" /> {backLabel || t('nav.back')}
          </button>
        )}
      {!hideNext && (
        <div style={{ display: 'flex', flexDirection: 'column', alignItems: 'flex-end', maxWidth: '60%' }}>
          <button
            className="btn-primary-kis"
            onClick={onNext}
            disabled={nextDisabled}
          >
            {nextLabel || t('nav.continue')} <i className="bi bi-arrow-right ms-1" />
          </button>
          {/* VIEWER-UX: el botón gateado EXPLICA por qué no avanza — hint fijo, visible
              junto al botón (también el de ARRIBA, lejos del contador del cuerpo). */}
          {nextDisabled && nextHint && (
            <div role="status" aria-live="polite"
              style={{ fontSize: '0.78rem', color: 'var(--muted)', fontWeight: 600, marginTop: 4, textAlign: 'right' }}>
              <i className="bi bi-info-circle me-1" />{nextHint}
            </div>
          )}
        </div>
      )}
    </div>
  );
}
