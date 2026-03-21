import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useWizard } from '../../context/WizardContext';
import { gasCall } from '../../api';

function QuestionField({ question, value, onChange }) {
  const type = question.response_type_id?.toLowerCase?.() || 'text';

  if (type === 'boolean') {
    return (
      <div className="form-check form-switch">
        <input type="checkbox" className="form-check-input" role="switch"
          checked={!!value} onChange={e => onChange(e.target.checked)} />
        <label className="form-check-label">{question.question_text}</label>
        {question.help_text && <div className="form-text">{question.help_text}</div>}
      </div>
    );
  }

  if (type === 'select') {
    return (
      <div>
        <label className="form-label">{question.question_text}{question.is_required && ' *'}</label>
        {question.help_text && <div className="form-text mb-1">{question.help_text}</div>}
        {question.options?.length <= 5 ? (
          <div>
            {question.options.map(o => (
              <div key={o.option_id} className="form-check">
                <input type="radio" className="form-check-input"
                  name={`q_${question.question_id}`}
                  checked={value === o.option_value}
                  onChange={() => onChange(o.option_value)} />
                <label className="form-check-label">{o.text}</label>
              </div>
            ))}
          </div>
        ) : (
          <select className="form-select" value={value || ''} onChange={e => onChange(e.target.value)}>
            <option value="" />
            {question.options.map(o => <option key={o.option_id} value={o.option_value}>{o.text}</option>)}
          </select>
        )}
      </div>
    );
  }

  if (type === 'multi_select' || type === 'multi-select') {
    const sel = Array.isArray(value) ? value : [];
    return (
      <div>
        <label className="form-label">{question.question_text}{question.is_required && ' *'}</label>
        {question.help_text && <div className="form-text mb-1">{question.help_text}</div>}
        {question.options.map(o => (
          <div key={o.option_id} className="form-check">
            <input type="checkbox" className="form-check-input"
              checked={sel.includes(o.option_value)}
              onChange={e => {
                if (e.target.checked) onChange([...sel, o.option_value]);
                else onChange(sel.filter(v => v !== o.option_value));
              }} />
            <label className="form-check-label">{o.text}</label>
          </div>
        ))}
      </div>
    );
  }

  return (
    <div>
      <label className="form-label">{question.question_text}{question.is_required && ' *'}</label>
      {question.help_text && <div className="form-text mb-1">{question.help_text}</div>}
      <textarea className="form-control" rows={3}
        placeholder={question.placeholder_text || ''}
        value={value || ''}
        onChange={e => onChange(e.target.value)} />
    </div>
  );
}

function meetsConditions(question, applicant) {
  if (!question.conditions?.length) return true;
  return question.conditions.every(c => {
    if (c.condition_operator === 'age_gte' && applicant?.date_of_birth) {
      const age = (Date.now() - new Date(applicant.date_of_birth)) / (365.25 * 24 * 3600 * 1000);
      return age >= parseFloat(c.condition_value || 0);
    }
    return true;
  });
}

export default function Step5Questions({ onNext, onBack }) {
  const { t, i18n }  = useTranslation();
  const { applicationId, stepData, updateStep } = useWizard();

  const [sets,     setSets]     = useState([]);
  const [loading,  setLoading]  = useState(true);
  const [err,      setErr]      = useState('');
  const [responses, setResponses] = useState(stepData.questions || {});

  const applicants = stepData.applicants || [];
  const guardians  = stepData.guardians  || [];

  useEffect(() => {
    gasCall('fetchQuestions', { context_designation: 'Enrollment', language: i18n.language })
      .then(data => setSets(data.sets || []))
      .catch(e => setErr(e.message))
      .finally(() => setLoading(false));
  }, [i18n.language]); // eslint-disable-line

  const setResponse = (key, val) => setResponses(prev => ({ ...prev, [key]: val }));

  const handleNext = async () => {
    // Batch-save all responses
    const rows = Object.entries(responses).map(([key, val]) => {
      const [qid, respondentId] = key.split('__');
      return {
        question_id:   qid,
        respondent_id: respondentId || applicationId,
        response_text: Array.isArray(val) ? val.join(',') : String(val ?? ''),
        language:      i18n.language,
      };
    });
    if (rows.length && applicationId) {
      await gasCall('saveResponses', {
        application_id:              applicationId,
        respondent_id:               applicationId,
        respondent_type_category_id: 'client',
        responses:                   rows,
      }).catch(() => {});
    }
    updateStep('questions', responses);
    onNext('questions', responses);
  };

  if (loading) return <div className="spinner" />;
  if (err)     return <div className="field-error">{err}</div>;
  if (!sets.length) return (
    <>
      <div className="kis-card">
        <p style={{ color: 'var(--muted)' }}>{t('step5.no_questions')}</p>
      </div>
      <div className="d-flex justify-content-between mt-4">
        <button className="btn-secondary-kis" onClick={onBack}><i className="bi bi-arrow-left me-1" />{t('nav.back')}</button>
        <button className="btn-primary-kis" onClick={() => { updateStep('questions', {}); onNext('questions', {}); }}>{t('nav.continue')}<i className="bi bi-arrow-right ms-1" /></button>
      </div>
    </>
  );

  return (
    <>
      <div className="mb-2">
        <h2 style={{ color: 'var(--teal-dk)', fontWeight: 800 }}>{t('step.questions')}</h2>
        <p style={{ color: 'var(--muted)' }}>{t('step5.subtitle')}</p>
      </div>

      {sets.map(set => (
        <div key={set.set_id} className="kis-card">
          {set.designation && <h3 style={{ color: 'var(--teal-dk)', fontSize: '1.05rem' }}>{set.designation}</h3>}

          {(set.items || []).map(item => {
            const q = item.question;
            if (!q) return null;
            const isClientQ = q.audience_category_id === 'client';
            const isParticipantQ = q.audience_category_id === 'participant';

            if (isParticipantQ) {
              return applicants.map((a, ai) => {
                if (!meetsConditions(q, a)) return null;
                const key = `${q.question_id}__${a.applicant_id || a._uid}`;
                const name = [a.first_name, a.last_name].filter(Boolean).join(' ') || `Applicant ${ai + 1}`;
                return (
                  <div key={key} className="mb-4">
                    <p style={{ color: 'var(--muted)', fontSize: '0.8rem', marginBottom: 4 }}>
                      <i className="bi bi-person me-1" />{name}
                    </p>
                    <QuestionField question={q} value={responses[key]} onChange={v => setResponse(key, v)} />
                  </div>
                );
              });
            }

            if (isClientQ) {
              return guardians.map((g, gi) => {
                const key = `${q.question_id}__${g.guardian_id || g._uid}`;
                const name = [g.first_name, g.last_name].filter(Boolean).join(' ') || `Guardian ${gi + 1}`;
                return (
                  <div key={key} className="mb-4">
                    <p style={{ color: 'var(--muted)', fontSize: '0.8rem', marginBottom: 4 }}>
                      <i className="bi bi-person-fill me-1" />{name}
                    </p>
                    <QuestionField question={q} value={responses[key]} onChange={v => setResponse(key, v)} />
                  </div>
                );
              });
            }

            // General question (no audience filter)
            const key = `${q.question_id}__${applicationId}`;
            return (
              <div key={key} className="mb-4">
                <QuestionField question={q} value={responses[key]} onChange={v => setResponse(key, v)} />
              </div>
            );
          })}
        </div>
      ))}

      <div className="d-flex justify-content-between mt-4">
        <button className="btn-secondary-kis" onClick={onBack}>
          <i className="bi bi-arrow-left me-1" /> {t('nav.back')}
        </button>
        <button className="btn-primary-kis" onClick={handleNext}>
          {t('nav.continue')} <i className="bi bi-arrow-right ms-1" />
        </button>
      </div>
    </>
  );
}
