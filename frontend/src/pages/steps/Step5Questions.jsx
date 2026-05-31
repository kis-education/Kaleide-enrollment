import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useWizard } from '../../context/WizardContext';
import { gasCall } from '../../api';
import LockedBanner from '../../components/LockedBanner';
import QbSetRenderer from '../../shared/QbSetRenderer';
import * as log from '../../logger';

export default function Step5Questions({ onNext, onBack, locked, onUnlock, savePending }) {
  const { t, i18n }  = useTranslation();
  const { enrollmentGroupId, resumeToken, stepData, updateStep } = useWizard();

  const [sets,     setSets]     = useState([]);
  const [loading,  setLoading]  = useState(true);
  // stepData.questions is normalized to a dict by hydrateFromResume; fall back to {}
  // (never to [] — the dirty check compares against the dict shape).
  const [responses, setResponses] = useState(
    Array.isArray(stepData.questions) ? {} : (stepData.questions || {})
  );
  const [highlightEdit, setHighlightEdit] = useState(false);

  const persons = stepData.persons || [];

  useEffect(() => {
    gasCall('fetchQuestions', { context_code: 'ENROLLMENT', language: i18n.language })
      .then(data => setSets(data.sets || []))
      .catch(() => setSets([]))
      .finally(() => setLoading(false));
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

  if (loading) return <div className="spinner" />;
  if (!sets.length) return (
    <>
      <div className="kis-card">
        <p style={{ color: 'var(--muted)' }}>{t('step5.no_questions')}</p>
      </div>
      <div className="d-flex justify-content-between mt-4">
        <button className="btn-secondary-kis" onClick={handleBack}><i className="bi bi-arrow-left me-1" />{t('nav.back')}</button>
        <button className="btn-primary-kis" onClick={() => { updateStep('questions', {}); onNext('questions', {}); }} disabled={savePending}>
          {savePending
            ? <><span className="spinner-border spinner-border-sm me-1" style={{ width: '0.9em', height: '0.9em', borderWidth: '0.12em' }} />{t('wizard.saving_in_background')}</>
            : <>{t('nav.continue')}<i className="bi bi-arrow-right ms-1" /></>
          }
        </button>
      </div>
    </>
  );

  return (
    <>
      <div className="mb-2">
        <h2 style={{ color: 'var(--teal-dk)', fontWeight: 800 }}>{t('step.questions')}</h2>
        <p style={{ color: 'var(--muted)' }}>{t('step5.subtitle')}</p>
      </div>

      {locked && <LockedBanner onUnlock={onUnlock} highlight={highlightEdit} />}

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

      <div className="d-flex justify-content-between mt-4">
        <button className="btn-secondary-kis" onClick={handleBack}>
          <i className="bi bi-arrow-left me-1" /> {t('nav.back')}
        </button>
        <button className="btn-primary-kis" onClick={handleNext} disabled={savePending}>
          {savePending
            ? <><span className="spinner-border spinner-border-sm me-1" style={{ width: '0.9em', height: '0.9em', borderWidth: '0.12em' }} />{t('wizard.saving_in_background')}</>
            : <>{t('nav.continue')} <i className="bi bi-arrow-right ms-1" /></>
          }
        </button>
      </div>
    </>
  );
}
