/**
 * QbSetRenderer — conditions helper (DL-Q05 §5 qb-render).
 *
 * Evaluator compartido por wizard, KMS qb-admin preview, annual quality forms,
 * pedagogic intake.
 *
 * Shape PLANO nuevo (backend `qbExpandCondition_` aplana el polimorfismo
 * groups → items → conditions atómicas → dimensions a este shape):
 *   { kind: 'AGE',             operator: 'GTE'|'LTE'|'EQ'|'NEQ', value: <number> }
 *   { kind: 'PARENT_ANSWER',   parent_question_code: <string>, operator: 'EQ'|'NEQ', value: <string|bool> }
 *   { kind: 'INITIATOR_EMAIL', operator: 'EQ'|'NEQ', value: <string> }
 *   { kind: 'UNKNOWN', dimension_code, operator, value }   // permissive — nunca oculta
 *
 * Shape LEGACY (backward-compat con consumidores antiguos):
 *   { condition_operator: 'age_gte', condition_value: <number> }
 *   { condition_operator: 'eq',      condition_value: '<question_id>:<expected>' }
 *
 * Semántica: el array `conditions` se evalúa con AND implícito — la pregunta se
 * muestra sólo si TODAS se cumplen. Operadores/kinds desconocidos → permissive
 * (true) para no ocultar una pregunta por un typo del catálogo. EXCEPCIÓN
 * deliberada: PARENT_ANSWER con parent sin responder devuelve false (la
 * bifurcación condicional no debe aparecer hasta que el padre se responda).
 *
 * @param {Object} question                     pregunta enriquecida (con .conditions)
 * @param {Object} person                       persona en scope (date_of_birth para AGE)
 * @param {Object} responses                    map `${question_id}__${personKey}` → valor
 * @param {string} personKey                    clave de la persona/grupo en `responses`
 * @param {Object} [ctx]                         { codeToId, initiatorEmail }
 * @param {Object} [ctx.codeToId]                question_code → question_id (PARENT_ANSWER)
 * @param {string} [ctx.initiatorEmail]          email del iniciador (INITIATOR_EMAIL)
 */
export function meetsConditions(question, person, responses, personKey, ctx = {}) {
  if (!question?.conditions?.length) return true;
  const codeToId = ctx.codeToId || {};
  const initiatorEmail = ctx.initiatorEmail || '';

  return question.conditions.every(c => {
    if (!c) return true;

    // ── Shape PLANO nuevo ────────────────────────────────────────────────────
    if (c.kind) {
      return evalFlatCondition(c, { person, responses, personKey, codeToId, initiatorEmail });
    }

    // ── Shape LEGACY (backward-compat) ───────────────────────────────────────
    if (c.condition_operator === 'age_gte' && person?.date_of_birth) {
      return computeAge(person.date_of_birth) >= parseFloat(c.condition_value || 0);
    }
    if (c.condition_operator === 'eq' && c.condition_value) {
      const [refQid, expectedVal] = String(c.condition_value).split(':');
      const actual = responses && responses[`${refQid}__${personKey}`];
      return String(actual) === expectedVal || actual === (expectedVal === 'true');
    }
    // Operador legacy desconocido → permissive.
    return true;
  });
}

// ─── Internal ────────────────────────────────────────────────────────────────

function evalFlatCondition(c, { person, responses, personKey, codeToId, initiatorEmail }) {
  const op = String(c.operator || '').toUpperCase();

  switch (c.kind) {
    case 'AGE': {
      // Sin date_of_birth no se puede evaluar → permissive (no blanquea).
      if (!person?.date_of_birth) return true;
      const age = computeAge(person.date_of_birth);
      const target = parseFloat(c.value);
      if (Number.isNaN(target)) return true;
      switch (op) {
        case 'GTE': return age >= target;
        case 'LTE': return age <= target;
        case 'EQ':  return Math.floor(age) === Math.floor(target);
        case 'NEQ': return Math.floor(age) !== Math.floor(target);
        default:    return true; // permissive
      }
    }

    case 'PARENT_ANSWER': {
      const parentId = codeToId[c.parent_question_code];
      const responseKey = parentId ? `${parentId}__${personKey}` : null;
      const actual = responseKey ? (responses && responses[responseKey]) : undefined;
      const answered = actual !== undefined && actual !== null && actual !== '';
      const matches = compareAnswer(actual, c.value);
      switch (op) {
        // Parent sin responder → la bifurcación NO aparece todavía.
        case 'EQ':  return answered && matches;
        case 'NEQ': return answered && !matches;
        default:    return true; // permissive
      }
    }

    case 'INITIATOR_EMAIL': {
      const actual = String(initiatorEmail || '').trim().toLowerCase();
      const expected = String(c.value == null ? '' : c.value).trim().toLowerCase();
      switch (op) {
        case 'EQ':  return actual === expected;
        case 'NEQ': return actual !== expected;
        default:    return true; // permissive
      }
    }

    case 'UNKNOWN':
    default:
      // Dimensión no soportada → permissive (nunca oculta por desconocimiento).
      return true;
  }
}

function computeAge(dob) {
  return (Date.now() - new Date(dob)) / (365.25 * 24 * 3600 * 1000);
}

function compareAnswer(actual, expected) {
  if (typeof expected === 'boolean') {
    if (typeof actual === 'boolean') return actual === expected;
    return String(actual).toLowerCase() === String(expected);
  }
  return String(actual) === String(expected);
}
