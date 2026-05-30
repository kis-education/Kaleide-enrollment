/**
 * QbSetRenderer — conditions helper (DL-Q05 §5 qb-render).
 *
 * Extracted 1:1 from the inline implementation in Step5Questions.jsx
 * (commit 0d0ab47) so multiple consumers — wizard, KMS qb-admin preview,
 * annual quality forms, pedagogic intake — share the same evaluator.
 *
 * Supported operators (matching DL-Q02 evaluator surface for the wizard subset):
 *   - age_gte  → person.date_of_birth derives age, compares >= condition_value
 *   - eq       → condition_value is "<question_id>:<expected_value>";
 *                lookup that question's response for the same person and compare.
 *
 * Unknown operators short-circuit to TRUE (permissive) to avoid blanking out
 * a question because of a typo in the catalog. The canonical evaluator (Q05-S1
 * in the KMS) will tighten this.
 */
export function meetsConditions(question, person, responses, personKey) {
  if (!question?.conditions?.length) return true;
  return question.conditions.every(c => {
    if (c.condition_operator === 'age_gte' && person?.date_of_birth) {
      const age = (Date.now() - new Date(person.date_of_birth)) / (365.25 * 24 * 3600 * 1000);
      return age >= parseFloat(c.condition_value || 0);
    }
    // eq condition: condition_value format is "question_id:expected_value"
    if (c.condition_operator === 'eq' && c.condition_value) {
      const [refQid, expectedVal] = c.condition_value.split(':');
      const responseKey = `${refQid}__${personKey}`;
      const actual = responses && responses[responseKey];
      // Compare as string; booleans stored as true/false
      return String(actual) === expectedVal || actual === (expectedVal === 'true');
    }
    return true;
  });
}
