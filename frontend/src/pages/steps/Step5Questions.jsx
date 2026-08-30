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
  const { enrollmentGroupId, resumeToken, stepData, updateStep, enqueueSave, recoveryNonce } = useWizard();

  // WIZARD-PERF-CACHE-SKELETON: paint instantáneo (stale-while-revalidate). Si hay
  // catálogo en sessionStorage (mismo idioma, no expirado) lo mostramos sin spinner
  // y revalidamos en background; si no, arrancamos en loading como antes.
  const _cached = readQuestionsCacheSync(i18n.language);
  const [sets,     setSets]     = useState(_cached?.sets || []);
  const [loading,  setLoading]  = useState(!_cached);
  // «NO HAY PREGUNTAS» Y «NO SE PUDO CARGAR» NO SON LO MISMO (2026-08-04). El `.catch`
  // dejaba `sets` vacío y la pantalla pintaba «No se encontraron preguntas»: al fallar el
  // catálogo se le decía a la familia una cosa FALSA, y «Continuar» guardaba vacío tan
  // ancho. Ahora el fallo se nombra, no deja avanzar, y ofrece reintentar.
  const [catalogoFallo, setCatalogoFallo] = useState(false);
  const [intento,       setIntento]       = useState(0);
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
      .then(data => { if (alive) { setSets(data.sets || []); setCatalogoFallo(false); } })
      // Con catálogo cacheado delante, una revalidación fallida no es un problema para la
      // familia (sigue viendo sus preguntas). SIN catálogo, sí lo es: se dice.
      .catch(() => { if (alive && !cached) { setSets([]); setCatalogoFallo(true); } })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; };
  }, [i18n.language, intento]); // eslint-disable-line

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
    // ⛔ `0º.tricies.septtricies` §9.4 — AQUÍ EL VACÍO SOLO PUEDE SER UN DEFECTO.
    // Aquí vivía `respondent_id: respondentId || enrollmentGroupId`, que archivaba la
    // respuesta A NOMBRE DE LA SOLICITUD cuando la mitad «de quién es» venía vacía —
    // **una atribución falsa, sin rastro**, y el mecanismo exacto que produjo las 21 filas
    // mal repartidas que midió el estudio.
    //
    // El caso legítimo YA TIENE SU PROPIA CLAVE: una pregunta general se compone como
    // `question_id__<grupo>` (`QbSetRenderer/index.jsx`), así que en el camino sano la
    // mitad de la clave **nunca viene vacía**. ⇒ un vacío aquí no es «una pregunta de la
    // solicitud»: es una clave mal compuesta, y taparla es esconder el defecto.
    //
    // ⛔ **NO se pierde la respuesta de la familia**: se descarta ESA fila y se dice; las
    // demás se guardan igual. Y el SUELO sigue siendo el servidor, que no falla cerrado
    // (es el suelo de un cliente que puede ir por detrás) — solo lo cuenta.
    const sinSujeto = [];
    const rows = Object.entries(responses).reduce((acc, [key, val]) => {
      const [qid, respondentId] = key.split('__');
      if (!respondentId) { sinSujeto.push(key); return acc; }
      acc.push({
        question_id:   qid,
        respondent_id: respondentId,
        response_text: Array.isArray(val) ? val.join(',') : String(val ?? ''),
        language:      i18n.language,
      });
      return acc;
    }, []);
    if (sinSujeto.length) {
      log.error('[Step5Questions] ' + sinSujeto.length + ' respuesta(s) con la clave sin ' +
                'sujeto — NO se archivan a nombre de la solicitud (0º.tricies.septtricies §9.4)',
                { claves: sinSujeto.map(k => k.split('__').map(x => log.sid(x)).join('__')) });
    }
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
        // DL-E49 §1 — el `n` del enlace identifica al tutor que está contestando. El
        // servidor lo resuelve a persona; el cliente NO decide quién es nadie.
        n:                           recoveryNonce || undefined,
        enrollment_group_id:         enrollmentGroupId,
        application_id:              enrollmentGroupId, // legacy alias
        respondent_id:               enrollmentGroupId,
        respondent_type_category_id: 'client',
        responses:                   rows,
      });
      // INDEPENDIENTE (2026-08-04): las respuestas no dependen de ningún guardado anterior
      // —van contra el expediente, que existe desde el paso 1—, así que NO se ponen a la
      // cola detrás de personas/vínculos/salud. Medido en campo: con 48 respuestas ya en el
      // estado de la pantalla, NINGUNA llamada salió en 60 s porque la cadena estaba
      // ocupada. Sigue contando para el indicador y sigue siendo reintentable.
      // `que`: el nombre del paso TAL COMO SE LEE en la pantalla — sin él, el aviso de fallo
      // decía «tu último cambio» y la familia no sabía QUÉ no se guardó (②24.sexies). Sale
      // del mismo texto que titula el paso, no de un mapeo escrito a mano.
      enqueueSave(saveFactory, { independiente: true, que: t('step.questions') });
    }
    log.info('Step5: onNext questions', responses);
    updateStep('questions', responses);
    onNext('questions', responses);
  };

  // When there are no questions, Continue persists an empty dict and advances.
  const handleContinueEmpty = () => { updateStep('questions', {}); onNext('questions', {}); };
  const nextHandler = sets.length ? handleNext : handleContinueEmpty;
  // Con el catálogo caído NO se avanza: avanzar guardaría un cuestionario vacío como si
  // la familia lo hubiera dejado en blanco a propósito. Ése era el daño real del defecto.
  const avanceBloqueado = loading || catalogoFallo;

  // Mejora 3a: la CABECERA se pinta SIEMPRE (incluso durante la carga); el spinner
  // vive SOLO en el área de contenido — la página ya no parece vacía/rota al esperar.
  return (
    <>
      <div className="mb-2">
        <h2 style={{ color: 'var(--teal-dk)', fontWeight: 800 }}>{t('step.questions')}</h2>
        <p style={{ color: 'var(--muted)' }}>{t('step5.subtitle')}</p>
      </div>

      <StepNav position="top" onBack={handleBack} onNext={nextHandler} savePending={savePending} nextDisabled={avanceBloqueado} />

      {locked && <LockedBanner onUnlock={onUnlock} highlight={highlightEdit} />}

      {loading ? (
        <StepSkeleton rows={5} />
      ) : catalogoFallo ? (
        <div className="kis-card" role="alert" data-e2e="catalogo-caido">
          <p style={{ color: 'var(--danger, #c92a2a)', fontWeight: 600, marginBottom: '.5rem' }}>
            {t('step5.catalog_failed')}
          </p>
          <button type="button" className="btn-primary-kis" data-e2e="catalogo-reintentar"
            onClick={() => { setLoading(true); setIntento(n => n + 1); }}>
            {t('step5.catalog_retry')}
          </button>
        </div>
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

      <StepNav onBack={handleBack} onNext={nextHandler} savePending={savePending} nextDisabled={avanceBloqueado} />
    </>
  );
}
