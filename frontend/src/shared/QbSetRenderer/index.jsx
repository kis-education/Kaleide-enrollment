import { useEffect } from 'react';
import { meetsConditions } from './conditions';
import * as log from '../../logger';

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
  initiatorEmail,
}) {
  const applicants = persons.filter(p => p.person_type_id === 'applicant');
  const guardians  = persons.filter(p => p.person_type_id === 'guardian');

  // ── ÚNICO SITIO DEL ASISTENTE QUE DECIDE DE QUIÉN ES UNA RESPUESTA AL PINTARLA ──────
  // Una pregunta GENERAL la contesta el EXPEDIENTE: su clave es `question_id__<grupo>`,
  // y así la compone este mismo componente más abajo y así la guarda hoy el KMS.
  //
  // Pero durante un tiempo el KMS guardó esas respuestas contra el PRIMER TUTOR del grupo
  // (el iniciador de la sesión de respuestas, que no es el sujeto de la respuesta). Al
  // volver, ninguna clave casaba y el cuestionario salía EN BLANCO con las respuestas
  // guardadas y servidas correctamente: 31 contestadas, 0 pintadas (medido 2026-08-09).
  // El escritor ya está arreglado y lo guardado se migró, pero una respuesta que la
  // familia dejó escrita NO se vuelve a perder por venir atribuida a otro: si de una
  // pregunta general llega UNA respuesta y no trae la clave del expediente, se pinta
  // igual. Una pregunta general tiene UNA respuesta por expediente, así que no hay a
  // quién confundir.
  //
  // Se normaliza AQUÍ, una sola vez y antes de nada, para que el valor que se pinta y las
  // condiciones que deciden si la pregunta se ve miren EXACTAMENTE lo mismo. Repartir
  // esta regla entre el pintado y las condiciones es cómo vuelven a divergir.
  const respuestasEfectivas = (() => {
    if (!groupId || !responses) return responses;
    const generales = [];
    sets.forEach(set => (set.items || []).forEach(item => {
      const q = item.question;
      const aud = q && q.audience_category_id;
      if (q && q.question_id && aud !== 'participant' && aud !== 'client') generales.push(q.question_id);
    }));
    let out = responses;
    generales.forEach(qid => {
      const claveDelExpediente = `${qid}__${groupId}`;
      if (out[claveDelExpediente] !== undefined && out[claveDelExpediente] !== '') return;
      const suelta = Object.keys(responses).find(
        k => k.startsWith(`${qid}__`) && responses[k] !== undefined && responses[k] !== ''
      );
      if (!suelta) return;
      if (out === responses) out = { ...responses };
      out[claveDelExpediente] = responses[suelta];
    });
    return out;
  })();

  // Map question_code → question_id, derivado de las preguntas recibidas. Lo
  // necesita meetsConditions para resolver las conditions PARENT_ANSWER (que
  // sólo traen parent_question_code) a la clave de respuesta `${id}__${personKey}`.
  const codeToId = {};
  sets.forEach(set => (set.items || []).forEach(item => {
    const q = item.question;
    if (q && q.question_code) codeToId[q.question_code] = q.question_id;
  }));

  // Email del iniciador (Step 1). El consumidor lo pasa explícito; como red de
  // seguridad para otros consumidores, lo leemos de la sesión del wizard.
  const effectiveInitiatorEmail = initiatorEmail != null ? initiatorEmail : readInitiatorEmail();
  const condCtx = { codeToId, initiatorEmail: effectiveInitiatorEmail };

  // ── DBG-SESSION (bug 2 caso C): por cada pregunta×persona, si meetsConditions la
  // muestra u oculta. En un useEffect (NO en render) para no hacer setState durante
  // el render. Prefijos 8 chars, sin PII. Revela si las preguntas existen pero un
  // filtro de condiciones (AGE/PARENT_ANSWER/INITIATOR_EMAIL) las descarta todas.
  useEffect(() => {
    try {
      const decisions = [];
      sets.forEach(set => (set.items || []).forEach(item => {
        const q = item.question;
        if (!q) { decisions.push({ set8: log.sid(set.set_id), q: 'NO_item.question' }); return; }
        const q8 = log.sid(q.question_id);
        const aud = q.audience_category_id;
        if (aud === 'participant') {
          if (!applicants.length) { decisions.push({ q8, aud, shown: false, reason: 'no_applicants' }); return; }
          applicants.forEach(a => {
            const pk = a.person_id || a._uid;
            decisions.push({ q8, aud, person8: log.sid(pk), shown: meetsConditions(q, a, respuestasEfectivas, pk, condCtx) });
          });
        } else if (aud === 'client') {
          if (!guardians.length) { decisions.push({ q8, aud, shown: false, reason: 'no_guardians' }); return; }
          guardians.forEach(g => {
            const pk = g.person_id || g._uid;
            decisions.push({ q8, aud, person8: log.sid(pk), shown: meetsConditions(q, g, respuestasEfectivas, pk, condCtx) });
          });
        } else {
          decisions.push({ q8, aud: aud || 'general/null', shown: meetsConditions(q, null, respuestasEfectivas, groupId, condCtx) });
        }
      }));
      const shown = decisions.filter(d => d.shown).length;
      log.info('[DBG QbRender] decisions', { total: decisions.length, shown, hidden: decisions.length - shown, decisions });
    } catch (e) {
      log.warn('[DBG QbRender] log failed', { message: e.message });
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sets, persons, responses]);

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

          {agruparPorSujeto_(set).map((bloque, bi) => {
            // ── Preguntas DE LA SOLICITUD: se pintan igual que siempre, una por una y
            // sin encabezado — no tienen sujeto que agrupar (su clave es el expediente).
            if (bloque.tipo === 'general') {
              const q = bloque.pregunta;
              // Conditions (INITIATOR_EMAIL, etc.) se evalúan con la clave de grupo.
              if (!meetsConditions(q, null, respuestasEfectivas, groupId, condCtx)) return null;
              const key = `${q.question_id}__${groupId}`;
              return (
                <div key={key} className="mb-4">
                  <QuestionField
                    question={q}
                    value={respuestasEfectivas[key]}
                    onChange={v => setResponse(key, v)}
                    readOnly={readOnly}
                  />
                </div>
              );
            }

            // ── Preguntas CON AUDIENCIA declarada: un área por sujeto, con su nombre UNA
            // vez y todas sus preguntas debajo (0º.tricies.decies).
            const esAlumno = bloque.audiencia === 'participant';
            const sujetos  = esAlumno ? applicants : guardians;
            const icono    = esAlumno ? 'bi-person' : 'bi-person-fill';

            return sujetos.map((persona, pi) => {
              const personKey = persona.person_id || persona._uid;
              // Las condiciones se siguen evaluando POR SUJETO: una pregunta que no aplica
              // a este hijo no sale en SU grupo. Si no le queda ninguna, el grupo no se pinta.
              const suyas = bloque.preguntas.filter(
                q => meetsConditions(q, persona, respuestasEfectivas, personKey, condCtx));
              if (!suyas.length) return null;
              const name = [persona.first_name, persona.last_name].filter(Boolean).join(' ')
                || (esAlumno
                  ? `${tr('applicant.title', { n: pi + 1 }) || 'Applicant'} ${pi + 1}`
                  : `${tr('guardian.title',  { n: pi + 1 }) || 'Guardian'} ${pi + 1}`);
              return (
                <div key={`qb-sujeto-${bi}-${personKey}`} className="mb-4"
                     data-qb-sujeto={personKey}>
                  <p style={{ color: 'var(--muted)', fontSize: '0.8rem', marginBottom: 4 }}>
                    <i className={`bi ${icono} me-1`} />{name}
                  </p>
                  {suyas.map(q => {
                    // ⛔ LA CLAVE NO CAMBIA: es la que guarda y recupera la respuesta.
                    const key = `${q.question_id}__${personKey}`;
                    return (
                      <div key={key} className="mb-3">
                        <QuestionField
                          question={q}
                          value={respuestasEfectivas[key]}
                          onChange={v => setResponse(key, v)}
                          readOnly={readOnly}
                        />
                      </div>
                    );
                  })}
                </div>
              );
            });
          })}
        </div>
      ))}
    </>
  );
}

// ─── 0º.tricies.decies (2026-08-22) · LAS PREGUNTAS SE AGRUPAN POR SUJETO ────────────
//
// Diego, 2026-08-22: «tampoco salen agrupadas. Tienes que ir al alimón, mirando a quién le
// corresponden. Lo lógico es que dentro de cada pill, haya un área de agrupación por sujeto».
//
// El recorrido de siempre era pregunta×sujeto (`items.map` por fuera, `applicants.map` por
// dentro) ⇒ con dos hijos salía: pregunta 1 de Jara · pregunta 1 de Pepito · pregunta 2 de
// Jara… La familia saltaba de un hijo a otro en CADA línea y tenía que leer el nombre en
// todas para saber a quién contestaba. Esta función invierte el recorrido: reparte los
// elementos del conjunto en BLOQUES, y quien pinta recorre sujeto → sus preguntas.
//
// ⛔ EL SITIO DEL BLOQUE ES EL DE SU PRIMERA PREGUNTA, no el final del conjunto. Un conjunto
// que mezcla preguntas de la solicitud con preguntas de alumno conserva así el orden en que
// el colegio las declaró; empujar los grupos al final movería preguntas que hoy salen arriba.
// Con un conjunto homogéneo —el caso normal— el resultado es idéntico a cualquier otra regla.
//
// ⛔ SOLO agrupa lo que tiene AUDIENCIA declarada (`participant`/`client`). Una pregunta de
// la solicitud no tiene sujeto: se queda como bloque suelto y se pinta EXACTAMENTE como hoy.
//
// ⛔ NO decide de quién es una pregunta: eso lo declara el catálogo (`audience_category_id`) y
// llega ya resuelto. Aquí solo se AGRUPA lo que llega, conservando el orden de `set.items`
// (que es el `sequence`/`display_order` del conjunto) dentro de cada sujeto.
function agruparPorSujeto_(set) {
  const bloques = [];
  const abierto = {};   // audiencia → el bloque ya abierto, para que TODAS caigan en él
  (set.items || []).forEach(item => {
    const q = item && item.question;
    if (!q) return;
    const aud = q.audience_category_id;
    if (aud !== 'participant' && aud !== 'client') {
      bloques.push({ tipo: 'general', pregunta: q });
      return;
    }
    if (!abierto[aud]) {
      abierto[aud] = { tipo: 'audiencia', audiencia: aud, preguntas: [] };
      bloques.push(abierto[aud]);
    }
    abierto[aud].preguntas.push(q);
  });
  return bloques;
}

// Lee el email del iniciador desde la sesión del wizard (sessionStorage
// 'kis_wizard_session' → stepData.email.primary_email). Fallback cuando el
// consumidor no pasa initiatorEmail como prop. Ver WizardContext SESSION_KEY.
function readInitiatorEmail() {
  try {
    const s = JSON.parse(sessionStorage.getItem('kis_wizard_session') || 'null');
    return (s && s.email && s.email.primary_email) || '';
  } catch (e) {
    return '';
  }
}

// ─── Internal: single input renderer ─────────────────────────────────────────

// ─── ③51 (2026-08-16) · EL CONTROL LO DECIDE LO DECLARADO, NO EL CÓDIGO DEL TIPO ─────
//
// La ficha de un tipo de respuesta DECLARA con qué control se pinta (`ui_widget`, catálogo
// Capa 2 del KMS `config/qb-response-types.html`). Hasta ③51 esa declaración NO LLEGABA aquí
// y este fichero elegía por el CÓDIGO del tipo: cambiar el control declarado no tenía NINGÚN
// efecto, y los dos tipos de escala —declarados `scale_buttons`— se pintaban como un área de
// texto libre.
//
// ⛔ LA CAÍDA NO ES ADORNO: sin control declarado, o con uno que este fichero no sabe pintar,
// se pinta EXACTAMENTE lo de siempre. Una familia no puede quedarse sin poder contestar
// porque el colegio declare un control que la pantalla aún no conoce.
//
// El vocabulario vive en el catálogo y AQUÍ; el servidor lo transporta VERBATIM sin
// validarlo (una tercera copia de la lista es justo el defecto que ③51 cerró).
const CONTROLES_QUE_SE_SABEN_PINTAR = ['input', 'textarea', 'switch', 'radio_or_select', 'checkboxes'];

function controlDeLaPregunta(question) {
  const declarado = (question.ui_widget || '').toString().trim().toLowerCase();
  if (declarado && CONTROLES_QUE_SE_SABEN_PINTAR.includes(declarado)) return declarado;
  if (declarado) {
    // `scale_buttons` cae aquí HOY, y se dice: el control declarado no dice de 1 a cuánto va
    // la escala, y sacar el rango del código del tipo sería volver a elegir por el código —
    // exactamente lo que ③51 cierra. Decisión abierta anotada en la cola (③51).
    console.warn(`[QbSetRenderer] control declarado "${declarado}" que esta pantalla aún no sabe pintar — se pinta el de siempre (por el código del tipo).`);
  }
  // CAÍDA: el código del tipo, tal y como se elegía hasta ③51. Verbatim.
  const type = (question.response_type_code || question.response_type_id || 'text').toString().toLowerCase();
  if (type === 'boolean') return 'switch';
  if (type === 'select') return 'radio_or_select';
  if (type === 'multi_select' || type === 'multi-select') return 'checkboxes';
  if (type === 'number') return 'number';
  return 'textarea';
}

function QuestionField({ question, value, onChange, readOnly }) {
  // ③51 — el CONTROL sale de lo declarado (`ui_widget`), con caída al código del tipo.
  const control = controlDeLaPregunta(question);

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

  if (control === 'switch') {
    return (
      <div className="form-check form-switch">
        <input type="checkbox" className="form-check-input" role="switch"
          checked={!!value} onChange={e => onChange(e.target.checked)} />
        <label className="form-check-label">{question.question_text}</label>
        {question.help_text && <div className="form-text">{question.help_text}</div>}
      </div>
    );
  }

  if (control === 'radio_or_select') {
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

  if (control === 'checkboxes') {
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

  if (control === 'number') {
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

  if (control === 'input') {
    return (
      <div>
        <label className="form-label">{question.question_text}{question.is_required && ' *'}</label>
        {question.help_text && <div className="form-text mb-1">{question.help_text}</div>}
        <input type="text" className="form-control"
          placeholder={question.placeholder_text || ''}
          value={value || ''}
          onChange={e => onChange(e.target.value)} />
      </div>
    );
  }

  // Default (control 'textarea' y la CAÍDA de todo lo que no se sepa pintar): área de texto.
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
  // ③51 — el MISMO resolvedor que elige el control: cómo se muestra una respuesta guardada y
  // con qué se contestó son la misma pregunta. Dos criterios aquí divergirían (una pregunta
  // declarada de casillas mostraría su lista sin unir).
  const control = controlDeLaPregunta(question);

  if (control === 'switch') {
    return value ? '✓' : '✗';
  }

  if (control === 'radio_or_select') {
    const opt = (question.options || []).find(o => o.option_value === value);
    return opt ? opt.text : String(value);
  }

  if (control === 'checkboxes') {
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
