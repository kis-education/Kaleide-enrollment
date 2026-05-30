import { meetsConditions } from './conditions';

/**
 * QbSetRenderer — shared question-set renderer (DL-Q05 §5 Capa D qb-render).
 *
 * Single React component consumed by:
 *   - Wizard Step5Questions.jsx (write mode)
 *   - Future KMS qb-admin preview (Q05-S4)
 *   - Future annual quality form / pedagogic intake consumers (Q05-S6/S7)
 *
 * Render rules (matches the legacy inline behaviour 1:1 — see Step5Questions.jsx
 * pre-Q05-S3 commit 0d0ab47):
 *   - Iterate sets → items → questions.
 *   - For each question, fan out by audience_category_id:
 *       · participant → one input per applicant person
 *       · client      → one input per guardian person
 *       · (other)     → one input keyed to the enrollment group id
 *   - Filter individual fan-out instances via meetsConditions().
 *   - Render input by response_type_id (BOOLEAN, SELECT, MULTI_SELECT, TEXT, NUMBER).
 *   - readOnly: render the stored value instead of an interactive input.
 *
 * Props
 * -----
 *   sets         array  Enriched sets from the backend (shape returned by
 *                       fetchQuestions / qb.resolveSetForConsumer).
 *   responses    object Map keyed `${question_id}__${respondentKey}`.
 *   persons      array  Persons in scope. Each entry needs person_type_id
 *                       ('applicant' | 'guardian'), date_of_birth (for age_gte),
 *                       and either person_id or _uid for the response key.
 *   groupId      string Fallback respondent key for non-audience questions.
 *   onResponse   fn     (key, value) => void. Required unless readOnly.
 *   readOnly     bool   When true, render values instead of inputs.
 *   locale       string Currently unused; reserved for future i18n hooks.
 *   t            fn     i18next translator (used for fallback person names).
 */
export default function QbSetRenderer({
  sets = [],
  responses = {},
  persons = [],
  groupId,
  onResponse,
  readOnly = false,
  locale,
  t,
}) {
  const applicants = persons.filter(p => p.person_type_id === 'applicant');
  const guardians  = persons.filter(p => p.person_type_id === 'guardian');

  const setResponse = (key, val) => {
    if (readOnly || typeof onResponse !== 'function') return;
    onResponse(key, val);
  };

  const tr = typeof t === 'function' ? t : (s => s);

  return (
    <>
      {sets.map(set => (
        <div key={set.set_id} className="kis-card">
          {set.designation && (
            <h3 style={{ color: 'var(--teal-dk)', fontSize: '1.05rem' }}>{set.designation}</h3>
          )}

          {(set.items || []).map(item => {
            const q = item.question;
            if (!q) return null;
            const isClientQ      = q.audience_category_id === 'client';
            const isParticipantQ = q.audience_category_id === 'participant';

            if (isParticipantQ) {
              return applicants.map((a, ai) => {
                const personKey = a.person_id || a._uid;
                if (!meetsConditions(q, a, responses, personKey)) return null;
                const key = `${q.question_id}__${personKey}`;
                const name = [a.first_name, a.last_name].filter(Boolean).join(' ')
                  || `${tr('applicant.title', { n: ai + 1 }) || 'Applicant'} ${ai + 1}`;
                return (
                  <div key={key} className="mb-4">
                    <p style={{ color: 'var(--muted)', fontSize: '0.8rem', marginBottom: 4 }}>
                      <i className="bi bi-person me-1" />{name}
                    </p>
                    <QuestionField
                      question={q}
                      value={responses[key]}
                      onChange={v => setResponse(key, v)}
                      readOnly={readOnly}
                    />
                  </div>
                );
              });
            }

            if (isClientQ) {
              return guardians.map((g, gi) => {
                const personKey = g.person_id || g._uid;
                if (!meetsConditions(q, g, responses, personKey)) return null;
                const key = `${q.question_id}__${personKey}`;
                const name = [g.first_name, g.last_name].filter(Boolean).join(' ')
                  || `${tr('guardian.title', { n: gi + 1 }) || 'Guardian'} ${gi + 1}`;
                return (
                  <div key={key} className="mb-4">
                    <p style={{ color: 'var(--muted)', fontSize: '0.8rem', marginBottom: 4 }}>
                      <i className="bi bi-person-fill me-1" />{name}
                    </p>
                    <QuestionField
                      question={q}
                      value={responses[key]}
                      onChange={v => setResponse(key, v)}
                      readOnly={readOnly}
                    />
                  </div>
                );
              });
            }

            // General question (no audience filter) — keyed to the group id.
            const key = `${q.question_id}__${groupId}`;
            return (
              <div key={key} className="mb-4">
                <QuestionField
                  question={q}
                  value={responses[key]}
                  onChange={v => setResponse(key, v)}
                  readOnly={readOnly}
                />
              </div>
            );
          })}
        </div>
      ))}
    </>
  );
}

// ─── Internal: single input renderer ─────────────────────────────────────────

function QuestionField({ question, value, onChange, readOnly }) {
  const type = question.response_type_id?.toLowerCase?.() || 'text';

  // ── readOnly path: render value as plain text, regardless of type ──────────
  if (readOnly) {
    const display = formatReadOnlyValue(question, value);
    return (
      <div>
        <label className="form-label">
          {question.question_text}{question.is_required && ' *'}
        </label>
        <div style={{ color: 'var(--text)', fontWeight: 500, fontSize: '0.92rem' }}>
          {display || <span style={{ color: 'var(--muted)' }}>—</span>}
        </div>
      </div>
    );
  }

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
        {(question.options || []).map(o => (
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

  if (type === 'number') {
    return (
      <div>
        <label className="form-label">{question.question_text}{question.is_required && ' *'}</label>
        {question.help_text && <div className="form-text mb-1">{question.help_text}</div>}
        <input type="number" className="form-control"
          placeholder={question.placeholder_text || ''}
          value={value ?? ''}
          onChange={e => onChange(e.target.value === '' ? '' : Number(e.target.value))} />
      </div>
    );
  }

  // Default: text / textarea
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

function formatReadOnlyValue(question, value) {
  if (value === null || value === undefined || value === '') return '';
  const type = question.response_type_id?.toLowerCase?.() || 'text';

  if (type === 'boolean') {
    return value ? '✓' : '✗';
  }

  if (type === 'select') {
    const opt = (question.options || []).find(o => o.option_value === value);
    return opt ? opt.text : String(value);
  }

  if (type === 'multi_select' || type === 'multi-select') {
    const sel = Array.isArray(value) ? value : String(value).split(',').filter(Boolean);
    return sel
      .map(v => {
        const opt = (question.options || []).find(o => o.option_value === v);
        return opt ? opt.text : v;
      })
      .join(', ');
  }

  return String(value);
}

export { QuestionField, formatReadOnlyValue };
