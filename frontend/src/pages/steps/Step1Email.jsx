import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useWizard } from '../../context/WizardContext';
import { fetchLookups } from '../../api';
import LockedBanner from '../../components/LockedBanner';
import StepNav from '../../components/StepNav';
import * as log from '../../logger';

/**
 * Un valor de fecha reducido a `YYYY-MM-DD`, o '' si no hay nada utilizable.
 *
 * Existe para que TODAS las comparaciones de fecha de este paso se hagan sobre la misma
 * forma: el programa puede traer la fecha con hora (según de dónde venga la fila) y el
 * `<input type="date">` siempre da `YYYY-MM-DD`. Comparar las dos formas en crudo haría
 * que una fecha idéntica pareciera distinta.
 */
const onlyDate = (v) => (v ? String(v).slice(0, 10) : '');

export default function Step1Email({ onNext, savePending, locked, onUnlock }) {
  const { t, i18n } = useTranslation();
  const { stepData, updateStep } = useWizard();

  const data  = stepData.email;
  const email = data.primary_email || '';

  const [programs,          setPrograms]          = useState(null); // null = loading
  const [selectedProgramId, setSelectedProgramId] = useState(data.program_id || '');
  // El modo de incorporación NO se decide con una fecha escrita a mano en el código: se
  // DERIVA de la fecha de inicio que declara el programa (`period_starts_on`, que este
  // componente ya carga). Antes se comparaba contra el literal '09-01' ⇒ un curso que
  // empezara cualquier otro día hacía aparecer a una familia normal como «a mitad de
  // curso». Aquí solo se guarda la elección EXPLÍCITA de la familia; `null` = todavía no
  // ha elegido, y entonces manda lo declarado.
  const [startTypeChoice,  setStartTypeChoice]  = useState(null);
  const [desiredStartDate, setDesiredStartDate] = useState(onlyDate(data.desired_start_date));
  const [highlightEdit,    setHighlightEdit]    = useState(false);

  const selectedProgram = (programs || []).find(p => p.program_id === selectedProgramId) || null;
  // Las DOS fuentes declaradas de este paso. Vacías = el programa no lo declara; en ese
  // caso no se inventa ningún valor (ni el 1 de septiembre, ni unos límites a ojo).
  const programStartsOn = onlyDate(selectedProgram?.period_starts_on);
  const programEndsOn   = onlyDate(selectedProgram?.period_ends_on);

  // Sin elección explícita: es «incorporación estándar» solo cuando no hay fecha guardada
  // o cuando la guardada ES la que declara el programa. Si el programa no declara fecha de
  // inicio, una fecha guardada NO se puede afirmar que sea la de inicio ⇒ se muestra como
  // «a mitad de curso», que enseña el dato en vez de esconderlo (degrada sin romper).
  const startType = startTypeChoice
    || (desiredStartDate && onlyDate(desiredStartDate) !== programStartsOn ? 'midterm' : 'september');

  useEffect(() => {
    fetchLookups()
      .then(lookups => {
        const progs = lookups.programs || [];
        setPrograms(progs);
        // Auto-select when only one programme is available
        if (!selectedProgramId && progs.length === 1) {
          setSelectedProgramId(progs[0].program_id);
          if (!desiredStartDate && progs[0].period_starts_on) {
            setDesiredStartDate(onlyDate(progs[0].period_starts_on));
          }
        }
      })
      .catch(() => setPrograms([]));
  }, []); // eslint-disable-line

  const handleProgramChange = (programId) => {
    setSelectedProgramId(programId);
    const prog = (programs || []).find(p => p.program_id === programId);
    if (prog?.period_starts_on && startType === 'september') {
      setDesiredStartDate(onlyDate(prog.period_starts_on));
    }
  };

  const handleStartType = (type) => {
    setStartTypeChoice(type);
    if (type === 'september') {
      setDesiredStartDate(programStartsOn);
    } else {
      setDesiredStartDate('');
    }
  };

  const handleContinue = () => {
    // In september mode the date picker is hidden; use program's period_starts_on as fallback.
    const effectiveDate = desiredStartDate || (startType === 'september' ? programStartsOn : '');
    const emailData = { primary_email: email, verified: true, desired_start_date: effectiveDate, program_id: selectedProgramId };
    log.info('Step1: onNext application', { emailData, effectiveDate, selectedProgramId });
    updateStep('email', emailData);
    onNext('application', { desired_start_date: effectiveDate, program_id: selectedProgramId });
  };

  // La fecha tecleada se comprueba AQUÍ, donde se teclea (DL-E40), contra el curso que
  // DECLARA el programa. Sin límites, el campo admitía 1990 o 2050. Un límite que el
  // programa no declara no se inventa: esa mitad simplemente no se exige.
  const typedDate  = startType === 'midterm' ? onlyDate(desiredStartDate) : '';
  const beforeMin  = !!(typedDate && programStartsOn && typedDate < programStartsOn);
  const afterMax   = !!(typedDate && programEndsOn   && typedDate > programEndsOn);
  const dateOutOfRange = beforeMin || afterMax;

  // Fecha para leer, en el idioma de la familia; si no se puede formatear, se enseña tal cual.
  const humanDate = (iso) => {
    if (!iso) return '';
    const d = new Date(iso + 'T00:00:00');
    return isNaN(d.getTime()) ? iso : d.toLocaleDateString(i18n.language);
  };
  const rangeMessage = !dateOutOfRange ? ''
    : (programStartsOn && programEndsOn)
      ? t('start.date_out_of_range', { from: humanDate(programStartsOn), to: humanDate(programEndsOn) })
      : beforeMin
        ? t('start.date_before_min', { from: humanDate(programStartsOn) })
        : t('start.date_after_max',  { to:   humanDate(programEndsOn) });

  // September mode: date is implicit (not shown) — only program selection needed.
  // Midterm mode: user must enter a specific date, and it must fall inside the declared period.
  const canContinue = selectedProgramId
    && (startType === 'september' ? true : (!!desiredStartDate && !dateOutOfRange));

  return (
    <>
      <div className="mb-2">
        <h2 style={{ color: 'var(--teal-dk)', fontWeight: 800 }}>{t('step.email')}</h2>
      </div>

      {/* WIZARD-UX: navegación arriba (Step1 = primer paso → solo "Continuar"). */}
      <StepNav position="top" hideBack onNext={handleContinue} nextDisabled={!canContinue}
        nextHint={rangeMessage} savePending={savePending} />

      {locked && <LockedBanner onUnlock={onUnlock} highlight={highlightEdit} />}

      {email && (
        <div className="alert alert-success d-flex align-items-center gap-2 mb-4">
          <i className="bi bi-check-circle-fill" />
          {t('step1.verified', { email })}
        </div>
      )}

      <div onClick={locked ? () => { setHighlightEdit(true); setTimeout(() => setHighlightEdit(false), 600); } : undefined}>
      <fieldset disabled={locked} style={{ border: 'none', padding: 0, margin: 0, pointerEvents: locked ? 'none' : undefined }}>
      <div className="p-3 rounded" style={{ background: 'var(--teal-lt)' }}>
        <h6 style={{ color: 'var(--teal-dk)', marginBottom: 12 }}>{t('step1.start_date_title')}</h6>
        <div className="row g-3">
          <div className="col-md-4">
            <label className="form-label">{t('field.program')}</label>
            {programs === null ? (
              <div className="d-flex align-items-center gap-2" style={{ height: 38 }}>
                <div className="spinner-border spinner-border-sm" role="status" style={{ color: 'var(--teal)' }} />
              </div>
            ) : programs.length === 0 ? (
              <p className="text-muted small mb-0">{t('step1.no_programs')}</p>
            ) : (
              <select
                className="form-select"
                value={selectedProgramId}
                onChange={e => handleProgramChange(e.target.value)}
              >
                {programs.length > 1 && <option value="">{t('step1.select_program')}</option>}
                {programs.map(p => (
                  <option key={p.program_id} value={p.program_id}>{p.designation}</option>
                ))}
              </select>
            )}
          </div>
          <div className="col-md-8">
            <label className="form-label">{t('field.start_type')}</label>
            <div className="d-flex gap-3">
              <div className="form-check">
                <input type="radio" className="form-check-input" name="startType" id="sep"
                  checked={startType === 'september'} onChange={() => handleStartType('september')} />
                <label className="form-check-label" htmlFor="sep">{t('start.september')}</label>
              </div>
              <div className="form-check">
                <input type="radio" className="form-check-input" name="startType" id="mid"
                  checked={startType === 'midterm'} onChange={() => handleStartType('midterm')} />
                <label className="form-check-label" htmlFor="mid">{t('start.midterm')}</label>
              </div>
            </div>
          </div>
          {startType === 'midterm' && (
            <div className="col-md-5">
              <label className="form-label">{t('field.start_date')}</label>
              {/* `min`/`max` salen del curso que DECLARA el programa (`period_starts_on` /
                  `period_ends_on`); lo que el programa no declara no se acota. React omite
                  el atributo cuando el valor es undefined. */}
              <input type="date"
                className={'form-control' + (dateOutOfRange ? ' is-invalid' : '')}
                min={programStartsOn || undefined}
                max={programEndsOn   || undefined}
                value={desiredStartDate}
                onChange={e => setDesiredStartDate(e.target.value)} />
              {rangeMessage && (
                <div className="invalid-feedback d-block">{rangeMessage}</div>
              )}
              <div className="disclaimer-box mt-2">
                {t('start.disclaimer_en')}
                <hr style={{ margin: '6px 0' }} />
                {t('start.disclaimer_es')}
              </div>
            </div>
          )}
        </div>
      </div>
      </fieldset>
      </div>

      <div className="d-flex justify-content-end mt-3">
        {/* WPERF-1 (criterios 1+2): el botón no se bloquea ni muestra "Guardando…" por un
            save en vuelo — el SaveIndicator global lo comunica. Solo gatea por validación. */}
        <button
          className="btn-primary-kis"
          onClick={handleContinue}
          disabled={!canContinue}
        >
          {t('nav.continue')} <i className="bi bi-arrow-right ms-1" />
        </button>
      </div>
    </>
  );
}
