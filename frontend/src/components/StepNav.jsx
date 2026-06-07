import { useTranslation } from 'react-i18next';

/**
 * Reusable wizard step navigation block (Back / Continue).
 *
 * Renders ONLY the button markup — NO logic. Reproduces the exact markup/styles
 * used inline in every step today (btn-secondary-kis / btn-primary-kis, the
 * bi-arrow-left / bi-arrow-right icons, and the savePending → spinner +
 * `wizard.saving_in_background` swap) so the appearance is identical whether the
 * step renders it at the top or the bottom.
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
 * @param {boolean} [props.savePending=false]  background save in flight → spinner label
 * @param {boolean} [props.nextDisabled=false] per-step gate (e.g. validation) — combined with savePending
 * @param {string}  [props.backLabel]          override (default t('nav.back'))
 * @param {string}  [props.nextLabel]          override (default t('nav.continue'))
 * @param {boolean} [props.hideBack=false]     hide Back (e.g. Step1, the first step)
 * @param {boolean} [props.hideNext=false]     hide Next (e.g. Step7 top — Back only)
 * @param {'top'|'bottom'} [props.position='bottom']
 */
export default function StepNav({
  onBack,
  onNext,
  savePending = false,
  nextDisabled = false,
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
        <button
          className="btn-primary-kis"
          onClick={onNext}
          disabled={savePending || nextDisabled}
        >
          {savePending
            ? <><span className="spinner-border spinner-border-sm me-1" style={{ width: '0.9em', height: '0.9em', borderWidth: '0.12em' }} />{t('wizard.saving_in_background')}</>
            : <>{nextLabel || t('nav.continue')} <i className="bi bi-arrow-right ms-1" /></>
          }
        </button>
      )}
    </div>
  );
}
