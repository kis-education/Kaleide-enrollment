// ─────────────────────────────────────────────────────────────────────────────
// documentShape.js — forma CANÓNICA de un documento del paso 6 (módulo PURO, sin
// imports de contexto/componentes → importable desde `WizardContext` sin ciclos).
//
// `0º.tricies.quindecies` (Diego, 2026-08-22: *«Las cuotas se siguen recalculando
// aunque no cambie absolutamente nada»*). Hermano exacto de `personShape.js`, y por
// el mismo motivo: el dirty-check compara JSON EXACTO contra el baseline sembrado en
// la hidratación, así que **quien siembra y quien envía tienen que producir la misma
// forma o el paso sale sucio para siempre**.
//
// LO MEDIDO (2026-08-22, contra `origin/main` y `origin/master`):
//   · el KMS hidrata cada documento con SEIS campos — `file_id`, `rec_type_code`,
//     `file_name`, `description`, `created_at`, `owner_person_ids`
//     (`enr_wizardHydrateCompute_`, `kms-server/enr/wizard-datalayer.gs`);
//   · `uploadedDocs()` de `Step6Documents` producía TRES;
//   ⇒ `isStepDirty('documents', …)` daba positivo en CADA pasada por el paso 6 y se
//     encolaba un `saveStep` que la familia no pidió.
//
// Y ese guardado espurio NO es inofensivo aunque el servidor no escriba nada
// (`saveStep_` case 'documents' es un no-op DECLARADO — los documentos los guarda
// `uploadDocument_`): **bumpa la versión del grupo** (`_wzCacheInvalidate_`,
// `backend/Code.js`) ⇒ tira las cachés de hidratación, admisión, miembros y **la de la
// simulación de cuotas**, así que el paso 7 se cae al nivel 2 de su caché y vuelve a
// pagar. Además pasa por `assertStepUpFresh_`, así que puede saltarle a la familia un
// `STEPUP_REQUIRED` por un guardado que nunca pidió.
//
// ⛔ ESTA FUNCIÓN ES EL ÚNICO SITIO donde se decide esa forma. La usan LOS DOS lados
// —`WizardContext.hydrateFromResume` para el baseline y `Step6Documents.uploadedDocs`
// para lo que se envía—; dos definiciones divergirían y el defecto volvería.
//
// ⛔ Y NO se aplica a `stepData.documents`: `seedRows()` LEE `rec_type_code` y
// `owner_person_ids` de ahí para poder enseñar de vuelta qué es cada archivo y de quién
// es (`0º.sexdecies`). Lo que se normaliza es la forma, no lo que la pantalla muestra —
// por eso los dos campos ENTRAN en la forma en vez de recortarse.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Un documento con la forma que produce el paso 6.
 *
 * `created_at` se DESCARTA a propósito: la pantalla no lo produce ni lo usa, así que
 * conservarlo en el baseline dejaría un campo fantasma que el envío nunca tendría.
 * `upload_token` solo viaja cuando existe (una subida recién hecha) — igual que hoy.
 *
 * @param {Object} d fila del paso o documento de la hidratación
 * @returns {Object} `{file_id, file_name, description, rec_type_code, owner_person_ids[, upload_token]}`
 */
export function formaDeDocumentoDelPaso_(d) {
  const doc = d || {};
  return {
    file_id:          doc.file_id,
    file_name:        doc.file_name || '',
    description:      (doc.description || '').trim(),
    rec_type_code:    doc.rec_type_code || '',
    owner_person_ids: Array.isArray(doc.owner_person_ids) ? doc.owner_person_ids : [],
    ...(doc.upload_token ? { upload_token: doc.upload_token } : {}),
  };
}

/**
 * La lista entera, ya filtrada a los documentos que EXISTEN en el servidor. Una fila
 * a medio subir (sin `file_id`) no es un documento todavía y nunca entra — mismo
 * criterio que tenía `uploadedDocs()` antes de este cambio.
 *
 * @param {Array<Object>} docs
 * @returns {Array<Object>}
 */
export function formaDeDocumentosDelPaso_(docs) {
  return (Array.isArray(docs) ? docs : []).filter(d => d && d.file_id).map(formaDeDocumentoDelPaso_);
}
