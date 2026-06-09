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
  const { enrollmentGroupId, resumeToken, stepData, updateStep, enqueueSave } = useWizard();

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

  // ── DBG-SESSION (bug 2): qué llega al render. audience_category_id + has_q por
  // pregunta + nº de hijos/tutores + claves de respuesta (prefijos 8 chars) son
  // suficientes para decidir A (persons vacío) vs B (catálogo sin item.question)
  // vs C (meetsConditions filtra). Se re-emite cuando cambian sets/persons/responses.
  useEffect(() => {
    if (loading) return;
    try {
      const summary = (sets || []).map(s => ({
        set8: log.sid(s.set_id),
        has_designation: !!s.designation,
        n_items: (s.items || []).length,
        qs: (s.items || []).map(it => ({
          q8:    log.sid((it.question && it.question.question_id) || it.question_id),
          has_q: !!it.question,
          aud:   it.question ? (it.question.audience_category_id || 'general/null') : '—',
          rtype: it.question && (it.question.response_type_code || it.question.response_type_id),
          n_cond: it.question && (it.question.conditions || []).length,
        })),
      }));
      log.info('[DBG Step5] catalog', {
        n_sets:     (sets || []).length,
        applicants: persons.filter(p => p.person_type_id === 'applicant').length,
        guardians:  persons.filter(p => p.person_type_id === 'guardian').length,
        n_responses: Object.keys(responses || {}).length,
        response_keys: Object.keys(responses || {}).map(k => k.split('__').map(x => log.sid(x)).join('__')),
        sets: summary,
      });
    } catch (e) {
      log.warn('[DBG Step5] catalog log failed', { message: e.message });
    }
  }, [sets, persons, responses, loading]); // eslint-disable-line

  const setResponse = (key, val) => setResponses(prev => ({ ...prev, [key]: val }));

  const handleBack = () => {
    updateStep('questions', responses);
    onBack();
  };

  const handleNext = () => {
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
    // §8 AVANCE OPTIMISTA (espejo de Step7Review.submitFactory). A diferencia del resto
    // de pasos, Step5 NO enruta su save por WizardPage.handleNext → tenía su propio
    // `await gasCall('saveResponses')` inline (~21.5s E2E) que BLOQUEABA el avance. Ahora
    // se encola una factory RE-EJECUTABLE por el carril global (saveState → SaveIndicator:
    // "Guardando…/Error+Reintentar") y se navega al instante SIN await. El contrato del
    // payload NO cambia. En error la respuesta NO se pierde: enqueueSave marca
    // saveState='error' y guarda la factory en lastFailedSaveRef → SaveIndicator ofrece
    // "Reintentar" (retryLastSave re-encola ESTA misma factory). Por eso la factory NO
    // lleva `.catch` que trague el error: debe propagarlo a la cola.
    if (rows.length && enrollmentGroupId) {
      const saveFactory = () => gasCall('saveResponses', {
        resume_token:                resumeToken, // KAL-4: required for IDOR defense
        enrollment_group_id:         enrollmentGroupId,
        application_id:              enrollmentGroupId, // legacy alias
        respondent_id:               enrollmentGroupId,
        respondent_type_category_id: 'client',
        responses:                   rows,
      });
      enqueueSave(saveFactory);
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
