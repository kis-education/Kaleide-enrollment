import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useWizard } from '../../context/WizardContext';
import { gasCall, fetchQuestions, readQuestionsCacheSync } from '../../api';
import LockedBanner from '../../components/LockedBanner';
import StepSkeleton from '../../components/StepSkeleton';
import StepNav from '../../components/StepNav';
import QbSetRenderer from '../../shared/QbSetRenderer';
import * as log from '../../logger';

export default function Step5Questions({ onNext, onBack, locked, onUnlock, savePending }) {
  const { t, i18n }  = useTranslation();
  const { enrollmentGroupId, resumeToken, stepData, updateStep } = useWizard();

  // WIZARD-PERF-CACHE-SKELETON: paint instantáneo (stale-while-revalidate). Si hay
  // catálogo en sessionStorage (mismo idioma, no expirado) lo mostramos sin spinner
  // y revalidamos en background; si no, arrancamos en loading como antes.
  const _cached = readQuestionsCacheSync(i18n.language);
  const [sets,     setSets]     = useState(_cached?.sets || []);
  const [loading,  setLoading]  = useState(!_cached);
  // stepData.questions is normalized to a dict by hydrateFromResume; fall back to {}
  // (never to [] — the dirty check compares against the dict shape).
  const [responses, setResponses] = useState(
    Array.isArray(stepData.questions) ? {} : (stepData.questions || {})
  );
  const [highlightEdit, setHighlightEdit] = useState(false);

  const persons = stepData.persons || [];

  useEffect(() => {
    // WIZARD-UX: shared module cache in api.js (keyed by language). Solo cacheamos
    // el CATÁLOGO de preguntas; las respuestas del usuario siguen en stepData.
    // WIZARD-PERF-CACHE-SKELETON: SWR — si ya hay cache fresco (sessionStorage del
    // mismo idioma) NO mostramos spinner; revalidamos en background y reconciliamos.
    let alive = true;
    const cached = readQuestionsCacheSync(i18n.language);
    if (cached) { setSets(cached.sets || []); setLoading(false); }
    else { setLoading(true); }
    fetchQuestions(i18n.language)
      .then(data => { if (alive) setSets(data.sets || []); })
      .catch(() => { if (alive && !cached) setSets([]); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [i18n.language]); // eslint-disable-line

  const setResponse = (key, val) => setResponses(prev => ({ ...prev, [key]: val }));

  const handleBack = () => {
    updateStep('questions', responses);
    onBack();
  };

  const handleNext = async () => {
    // Batch-save all responses
    const rows = Object.entries(responses).map(([key, val]) => {
      const [qid, respondentId] = key.split('__');
      return {
        question_id:   qid,
        respondent_id: respondentId || enrollmentGroupId,
        response_text: Array.isArray(val) ? val.join(',') : String(val ?? ''),
        language:      i18n.language,
      };
    });
    if (rows.length && enrollmentGroupId) {
      await gasCall('saveResponses', {
        resume_token:                resumeToken, // KAL-4: required for IDOR defense
        enrollment_group_id:         enrollmentGroupId,
        application_id:              enrollmentGroupId, // legacy alias
        respondent_id:               enrollmentGroupId,
        respondent_type_category_id: 'client',
        responses:                   rows,
      }).catch(() => {});
    }
    log.info('Step5: onNext questions', responses);
    updateStep('questions', responses);
    onNext('questions', responses);
  };

  // When there are no questions, Continue persists an empty dict and advances.
  const handleContinueEmpty = () => { updateStep('questions', {}); onNext('questions', {}); };
  const nextHandler = sets.length ? handleNext : handleContinueEmpty;

  // Mejora 3a: la CABECERA se pinta SIEMPRE (incluso durante la carga); el spinner
  // vive SOLO en el área de contenido — la página ya no parece vacía/rota al esperar.
  return (
    <>
      <div className="mb-2">
        <h2 style={{ color: 'var(--teal-dk)', fontWeight: 800 }}>{t('step.questions')}</h2>
        <p style={{ color: 'var(--muted)' }}>{t('step5.subtitle')}</p>
      </div>

      <StepNav position="top" onBack={handleBack} onNext={nextHandler} savePending={savePending} nextDisabled={loading} />

      {locked && <LockedBanner onUnlock={onUnlock} highlight={highlightEdit} />}

      {loading ? (
        <StepSkeleton rows={5} />
      ) : !sets.length ? (
        <div className="kis-card">
          <p style={{ color: 'var(--muted)' }}>{t('step5.no_questions')}</p>
        </div>
      ) : (
        <div onClick={locked ? () => { setHighlightEdit(true); setTimeout(() => setHighlightEdit(false), 600); } : undefined}>
          <fieldset disabled={locked} style={{ border: 'none', padding: 0, margin: 0, pointerEvents: locked ? 'none' : undefined }}>
            <QbSetRenderer
              sets={sets}
              responses={responses}
              persons={persons}
              groupId={enrollmentGroupId}
              onResponse={setResponse}
              t={t}
              locale={i18n.language}
              initiatorEmail={stepData.email?.primary_email}
            />
          </fieldset>
        </div>
      )}

      <StepNav onBack={handleBack} onNext={nextHandler} savePending={savePending} nextDisabled={loading} />
    </>
  );
}
