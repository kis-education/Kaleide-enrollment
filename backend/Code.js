/**
 * KIS ADMISSIONS BACKEND
 * Google Apps Script Web App — standalone project
 *
 * doGet  → health check
 * doPost → action dispatcher (routes on payload.action)
 *
 * Script Properties required:
 *   APPSHEET_APP_ID      — AppSheet app UUID
 *   APPSHEET_ACCESS_KEY  — AppSheet API access key
 *   RECAPTCHA_SECRET     — reCAPTCHA v3 secret key
 *
 * CORS restricted to: https://admissions.kaleide.org
 */

// ─── Constants ────────────────────────────────────────────────────────────────

const CORS_ORIGIN        = 'https://admissions.kaleide.org';
const DRIVE_FOLDER_NAME  = 'KIS Admissions Documents';
const SCHOOL_ID          = 'KIS';
const ADMISSIONS_EMAIL   = 'admissions@kaleide.org';
const FROM_NAME          = 'Kaleide International School';
const RESUME_BASE_URL    = 'https://admissions.kaleide.org/#/resume/';
const REPORT_BASE_URL    = 'https://admissions.kaleide.org/#/report/';
const LOGO_URL           = 'https://raw.githubusercontent.com/kaleideschool/public/main/favicon.png';
const APPSHEET_BASE_URL  = 'https://api.appsheet.com/api/v2/apps/';

// Consent statement texts — canonical wording used for GDPR audit trail.
// The React frontend (frontend/src/consentTexts.js) defines the same strings — keep in sync.
const CONSENT_TEXTS = {
  gdpr: {
    en: "I consent to the collection and processing of my personal data in accordance with Kaleide International School's Privacy Policy and applicable data protection legislation (GDPR).",
    es: "Consiento la recogida y el tratamiento de mis datos personales de acuerdo con la Política de Privacidad de Kaleide International School y la legislación de protección de datos aplicable (RGPD).",
  },
  legal: {
    en: "I confirm that the information provided in this application is accurate and complete to the best of my knowledge.",
    es: "Confirmo que la información proporcionada en esta solicitud es exacta y completa según mi leal saber y entender.",
  },
};

// Stable question UUIDs for enrollment question bank — never regenerate
const QB_PROFESSION_ID       = 'a1b2c3d4-0020-0000-0000-000000000000';
const QB_EMPLOYER_ID         = 'a1b2c3d4-0021-0000-0000-000000000000';
const QB_HAS_ADAPTATION_ID   = 'a1b2c3d4-0022-0000-0000-000000000000';
const QB_ADAPTATION_NOTES_ID = 'a1b2c3d4-0023-0000-0000-000000000000';

// ─── DL-E39 PII-primero — step-up re-auth (Fase A) ──────────────────────────
// Step-up = prueba-de-acceso-al-inbox (código fresco 6-díg al buzón) que
// compensa el resume_token largo (7 días, reutilizable). Una ventana DURA:
// tras un verifyEmail_ con stepup=true (o el consumo single-use de la gracia de
// magic-link) marcamos el grupo como "fresco" durante STEPUP_INACTIVITY_MS; los
// handlers que revelan/mutan PII sensible exigen esa marca fresca
// (assertStepUpFresh_). Reutiliza sendVerificationCode_/verifyEmail_ (endurecidos
// KAL-NEW-2) — NO hay token ni endpoint nuevo.
//
// ★ SEC-STEPUP (finding #55, 2026-06-11): la ventana es DURA (10 min EXACTOS desde
// la última RE-VERIFICACIÓN real), NO deslizante. El modelo anterior
// (P-STEPUP-SLIDING) re-extendía la marca en CADA save de PII y en CADA pulso
// getAdmissionState → 10 min se volvían infinitos mientras la pestaña pulsara/el
// usuario estuviera activo, y una RECARGA dentro de esa ventana viva entraba SIN
// OTP (bypass del PII-gate reportado por Diego). Ahora _markStepUpFresh_ se invoca
// SOLO en (1) OTP verificado y (2) consumo de la gracia — NUNCA en lecturas/saves.
// Pasados los 10 min, el PII-gate vuelve a exigir OTP. (El resume_token TTL de 7
// días sigue siendo el TTL de sesión; este es el TTL corto de re-verificación.)
const STEPUP_INACTIVITY_MS = 10 * 60 * 1000; // 10 min (ventana DURA, no deslizante)

// Magic-link grace (UX, no urgente): un magic link recién enviado NO exige OTP si
// se usa dentro de esta ventana. La gracia se vincula a un NONCE single-use de ESE
// envío (cache `mlnonce_<nonce>` = enrollment_group_id), NO al grupo — así un link
// filtrado/reusado/expirado SÍ cae al flujo OTP normal (KAL-7 intacto). El nonce se
// consume (borra) en el primer recovery. Ventana = 10 min exactos (TTL del nonce).
const MAGIC_LINK_GRACE_MS = 10 * 60 * 1000; // 10 min

// AppSheet table names matching the enr* / qb* schema (post DL-E15)
//
// DL-E15 reorganisation:
//   - `enrApplications`         → `enrEnrollments` (1 row per applicant, not per session)
//   - new `enrEnrollmentGroups` (1 row per wizard session — session-level fields live here)
//   - new `enrPrograms` / `enrProgramTypes` (admission programme catalog)
//   - `enrApplicationSources`   → `enrEnrollmentSources`
//   - `sysStates_T`             (universal state catalog; entity_type_code='ENR_ADMISSION_SCHOOL')
//
// Stage-1 notes:
//   - sysStates_T: entity_type_code='ENR_ADMISSION_SCHOOL'. PK=state_id, code field=state_code.
//   - sysStateTransitionLog: polymorphic on entity_type_code+entity_id. DL-S37.
//   - sysConsentsLog: polymorphic on entity_type_code+entity_id. Signer via signer_table+signer_id. DL-S44.
//   - sysPersonRelations: polymorphic via context_entity_type_code+context_entity_id. DL-S45.
//   · staging tables (persons/addresses/emails/phones/relations) FK → enrollment_group_id
//   · per-enrollment tables (documents/interviews/consents/state_log) FK → enrollment_id
const T = {
  ENROLLMENTS:          'enrEnrollments',        // rename of enrApplications
  ENROLLMENT_GROUPS:    'enrEnrollmentGroups',   // new — session header
  PROGRAMS:             'enrPrograms',           // new — admission programme catalog
  PROGRAM_TYPES:        'enrProgramTypes',       // new
  ENROLLMENT_SOURCES:   'enrEnrollmentSources',  // rename of enrApplicationSources
  STATES_T:             'sysStates_T',           // universal state catalog (entity_type_code='ENR_ADMISSION_SCHOOL')
  STATE_TRANSITION_LOG: 'sysStateTransitionLog', // polymorphic state log (DL-S37)
  CONSENTS_LOG:         'sysConsentsLog',         // polymorphic consents log (DL-S44)
  PERSONS:              'enrPersons',
  PERSON_NATIONALITIES: 'enrPersonNationalities',
  PERSON_IDS:           'enrPersonIDs',
  PERSON_LANGUAGES:     'enrPersonLanguages',
  ADDRESSES:            'enrAddresses',
  PERSON_ADDRESSES:     'enrPersonAddresses',
  EMAILS:               'enrEmails',
  // enrPersonEmails deleted 2026-05-17 (no canonical sys* equivalent; join omitted)
  PHONES:               'enrPhones',
  // enrPersonPhones deleted 2026-05-17 (no canonical sys* equivalent; join omitted)
  PERSON_RELATIONS:     'sysPersonRelations',    // polymorphic person relations (DL-S45)
  PREV_SCHOOLS:         'enrPreviousSchools',
  PERSON_MEDICAL:       'enrPersonMedicalConditions',
  PERSON_ALLERGIES:     'enrPersonFoodAllergies',
  PERSON_DIETARY:       'enrPersonDietaryRequirements',
  REC_FILES:            'recFiles',                // canonical document storage (DL-R09)
  REC_SCOPES:           'recScopes',               // file ↔ entity polymorphic M:N (DL-R13)
  INTERVIEWS:           'enrInterviews',
  QB_CONTEXTS:          'qbContexts',
  QB_SETS:              'qbQuestionSets',
  QB_SET_ITEMS:         'qbQuestionSetItems',
  QB_QUESTIONS:         'qbQuestions',
  QB_TRANSLATIONS:      'qbQuestionTranslations',
  QB_OPTIONS:           'qbAnswerOptions',
  QB_OPT_TRANS:         'qbAnswerOptionTranslations',
  QB_CONDITIONS:        'qbQuestionConditions',
  QB_RESPONSES:         'qbResponses',
  // Main SMS tables (used during application promotion)
  SMS_ADDRESSES:          'addresses_S',
  SMS_ADDRESS_LOG:        'addressLog',
  SMS_RELATIONAL_RECORDS: 'relationalRecords',
  SMS_PERSON_CATEGORIES:  'personCategoriesLog',
  // Signing session tables (DL-S46, DL-S47 — Ola 4 P37)
  // SIGNING_SESSION_DOCUMENTS borrado CLI 60 (sólo usado por getSigningTokenFromResumeToken_).
  // ADMISSION_DECISION, TENANT_CONFIG, FIN_PAYMENTS, BANK_ACCOUNTS, SUBSCRIPTION_TYPES
  // borrados CLI 60 (sólo usados por los endpoints huérfanos post CLI 59).
  // MILESTONES / MILESTONE_TYPES RE-AÑADIDOS por P237: resolveSigningToken_ deriva
  // los flags de steps (BILLING/GDPR/REVIEW) desde sysMilestones reales (estado
  // COMPLETED), resueltos vía el catálogo sysMilestoneTypes (invariante: la fila de
  // sysMilestones NO lleva milestone_type_code, solo milestone_type_id).
  SIGNING_SESSION_SIGNERS:   'sysSigningSessionSigners',
  SIGNING_SESSIONS:          'sysSigningSessions',
  MILESTONES:                'sysMilestones',
  MILESTONE_TYPES:           'sysMilestoneTypes',
  // Lookup / reference tables
  LOOKUP_ALLERGIES:       'foodAllergies',
  LOOKUP_DIETARY:         'dietaryRequirements',
  LOOKUP_MEDICAL:         'medicalConditions',
  LOOKUP_RELATION_TYPES:  'relationTypes',
};

/**
 * Returns the authenticated staff email for the current GAS execution context.
 * Used to populate changed_by, reviewed_by, and interviewer_id fields.
 * Returns null when the script runs in an unauthenticated context (e.g. public web app).
 * @returns {string|null}
 */
function getStaffEmail_() {
  try {
    const email = Session.getActiveUser().getEmail();
    return email || null;
  } catch (_) {
    return null;
  }
}

// ─── Log redaction (KAL-11) ───────────────────────────────────────────────────
// Closes the PII-in-logs vector identified in the 2026-05-29 audit. Apps Script
// Logger.log lines are persisted in Stackdriver (Google Cloud Logging) for the
// project owner — anyone with project access to the Cloud project can see them.
// Logging full emails / resume_tokens / UUIDs in clear is a GDPR pitfall and a
// leak of bearer secrets to anyone who later browses the logs.
//
// Use redact_() on any user-controlled or PII-bearing string BEFORE concatenating
// into Logger.log. Emails become `[EMAIL]`, UUIDs become `[UUID]`. For tokens
// where a stable prefix is useful for cross-referencing (e.g. resolveSigningToken_
// debug trace), prefer `token.substring(0,8) + '...'` directly — already in use.

/**
 * Redacts emails and UUIDs from a string so it is safe to write to Logger.log.
 * - Emails  → `[EMAIL]`
 * - UUIDs   → `[UUID]`  (matches 36-char canonical layout, hex + hyphens)
 * Returns the input unchanged for null/undefined.
 *
 * Idempotent: redacting an already-redacted string is a no-op.
 *
 * @param {*} s
 * @returns {string}
 */
function redact_(s) {
  if (s === null || s === undefined) return s;
  var v = String(s);
  v = v.replace(/[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}/g, '[EMAIL]');
  v = v.replace(/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi, '[UUID]');
  return v;
}

/**
 * KAL-NEW-10: sanitiza un mensaje de error antes de enviarlo al cliente anónimo
 * del wizard. Aplica redact_() (emails/UUIDs) y además colapsa nombres de columna
 * + valores rechazados de AppSheet y Drive file IDs que pueden filtrarse en errores
 * de Add/Edit, y recorta a 200 chars.
 *
 * Para diagnóstico interno usa Logger.log con el err.message COMPLETO (Stackdriver
 * es interno) — solo el OUTPUT al cliente se sanitiza. El `code` estructurado
 * (NOT_EDITABLE, RATE_LIMITED, UNAUTHORIZED, BAD_REQUEST...) se conserva aparte.
 */
function sanitizeErrorForClient_(err) {
  if (!err) return 'Internal error';
  var msg = String((err && err.message) || err);
  msg = redact_(msg);  // emails → [EMAIL], UUIDs → [UUID]
  // Colapsa leaks de nombre de columna AppSheet: "Column 'foo_bar' rejected value 'xyz'"
  msg = msg.replace(/Column\s+'[^']*'\s+rejected value\s+'[^']*'/gi, 'Validation error');
  // Colapsa Drive file IDs y tokens largos alfanuméricos (≥40 chars; UUIDs ya van a [UUID]=36)
  msg = msg.replace(/[A-Za-z0-9_-]{40,80}/g, '[ID]');
  if (msg.length > 200) msg = msg.slice(0, 200) + '…';
  return msg;
}

// ─── AppSheet Filter injection — defense in depth (KAL-5) ─────────────────────
// Closes the AppSheet Selector filter-injection vector identified in the
// 2026-05-29 audit. Without escape + validation, a user-controlled string like
//   primary_email = 'victim" || "1"="1'
// breaks out of the quoted literal in
//   '"primary_email" = "' + email + '" && NOT(ISBLANK([submitted_at]))'
// and returns every row in the table.
//
// Defense in depth: every call-site that concatenates user input into a
// Filter string MUST (1) assert the input shape with assertValidUuid_ /
// assertValidEmail_ / a whitelist BEFORE building the filter, AND
// (2) wrap the value with appsheetEscape_() in the concatenation. Either
// layer alone is insufficient — the validation may grow gaps as new shapes
// land, and the escape may be omitted on a new call-site by mistake.

/**
 * Escapes a string value for safe inclusion inside an AppSheet Filter
 * expression. AppSheet expects double-quoted strings; escape internal
 * `"` as `""` (the AppSheet convention). Returns empty string for
 * null/undefined. Always coerces to string before escaping.
 *
 * @param {*} v
 * @returns {string}
 */
function appsheetEscape_(v) {
  if (v === null || v === undefined) return '';
  return String(v).replace(/"/g, '""');
}

/**
 * Validates a UUID v4 format (36 chars, hex + hyphens in canonical layout).
 * Throws an Error if invalid. Use BEFORE concatenating UUIDs into a Filter.
 *
 * @param {*}      v
 * @param {string} [fieldName] for the error message
 */
function assertValidUuid_(v, fieldName) {
  if (typeof v !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(v)) {
    throw new Error('Invalid UUID for ' + (fieldName || 'field') + ': ' + JSON.stringify(v));
  }
}

/**
 * Validates a file_id for READ-ONLY lookups, tolerating LEGACY semantic ids
 * (KAL/F-17·#10, 2026-06-11). Documentos sembrados con design anterior llevan ids
 * NO-UUID tipo `file-kis-admission-letter-2026-001`; `assertValidUuid_` los rechaza
 * con BAD_REQUEST → el botón "Ver archivo" del wizard quedaba inerte (Hallazgo #10).
 *
 * Whitelist estricta `^[A-Za-z0-9._-]{1,128}$`: sin comillas → no rompe el AppSheet
 * Filter (KAL-5 capa 1); `appsheetEscape_()` en la concatenación es la capa 2. SOLO
 * para getDocument_ (lectura gateada por token + guard de propiedad IDOR). Las
 * escrituras y la emisión de ids nuevos siguen exigiendo UUID v4 (assertValidUuid_).
 *
 * @param {*}      v
 * @param {string} [fieldName]
 */
function assertValidFileIdForRead_(v, fieldName) {
  if (typeof v !== 'string' || !/^[A-Za-z0-9._-]{1,128}$/.test(v)) {
    const err = new Error('Invalid file_id for ' + (fieldName || 'field') + ': ' + JSON.stringify(v));
    err.code = 'BAD_REQUEST';
    throw err;
  }
}

/**
 * Validates an email shape (RFC-light + RFC-5321 max length of 254).
 * Throws an Error if invalid. Use BEFORE concatenating emails into a Filter.
 *
 * @param {*}      v
 * @param {string} [fieldName] for the error message
 */
function assertValidEmail_(v, fieldName) {
  if (typeof v !== 'string' || v.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(v)) {
    throw new Error('Invalid email for ' + (fieldName || 'field') + ': ' + JSON.stringify(v));
  }
}

/**
 * CLI 8 (DL-E42 + DL-E39 ENMIENDA 3) — defensa en profundidad: el email de cada
 * tutor es su CREDENCIAL DE IDENTIDAD per-guardian (recuperación + firma + decisiones
 * legales a su propio nombre), así que dos tutores del MISMO grupo NO pueden compartir
 * email. Rechaza si dos guardians distintos del payload comparten un email
 * (normalizado lowercase/trim). Un mismo guardian repitiendo su email (personal+trabajo)
 * NO es conflicto. Lanza `err.code='DUPLICATE_GUARDIAN_EMAIL'` → doPost lo mapea a
 * HTTP 200 {ok:false,error:{code,message}} (P72 estructurado, NUNCA 403). KAL-11: el
 * message NO incluye el email (PII); el frontend i18n por code.
 *
 * @param {Array} persons - payload de personas (guardians + applicants)
 * @throws {Error & {code:'DUPLICATE_GUARDIAN_EMAIL'}}
 */
function assertUniqueGuardianEmails_(persons) {
  if (!Array.isArray(persons)) return;
  var seenByEmail = {};  // normalizedEmail → guardian index
  persons.forEach(function(p, gi) {
    if (!p || p.person_type_id !== 'guardian') return;
    (p.emails || []).forEach(function(em) {
      var raw = ((em && (em.value || em.email_address)) || '').toString().trim().toLowerCase();
      if (!raw) return;
      try { assertValidEmail_(raw, 'guardian_email'); } catch (e) { return; } // shape-invalid → lo gatea otra validación
      if (seenByEmail[raw] !== undefined && seenByEmail[raw] !== gi) {
        var err = new Error('Two guardians share the same email; each guardian needs a distinct email (identity credential).');
        err.code = 'DUPLICATE_GUARDIAN_EMAIL';
        throw err;
      }
      seenByEmail[raw] = gi;
    });
  });
}

/**
 * CLI 8 (DL-E39 ENMIENDA 3 punto 4) — registra (best-effort) la ATESTACIÓN de tutor
 * único como acto declarativo en la fila del grupo `enrEnrollmentGroups`. Es un Edit
 * SEPARADO (solo PK + 4 campos de atestación) para que un silent-reject P72 (si las
 * columnas aún no existen en AppSheet) NO arrastre el save principal de personas —
 * solo se pierde la atestación, logueada (KAL-11 redactado). Destino justificado: la
 * atestación es GROUP-scoped y se captura en Step 2, ANTES de que existan filas
 * enrEnrollments (mismo motivo por el que los consents GDPR se difieren a submit);
 * el wizard es thin client que escribe a enr* (DL-E41). TODO Diego: alta de columnas.
 *
 * @param {string} enrollmentGroupId  derivado del token (KAL-4)
 * @param {{attested:boolean, attestant_guardian?:string, attested_at?:string, attestation_version?:string}} att
 */
function persistSoleGuardianAttestation_(enrollmentGroupId, att) {
  if (!att || att.attested !== true) return;
  try {
    appsheetRequest_(T.ENROLLMENT_GROUPS, 'Edit', [{
      enrollment_group_id:               enrollmentGroupId,
      sole_guardian_attested:            true,
      sole_guardian_attested_at:         att.attested_at || new Date().toISOString(),
      sole_guardian_attestant:           att.attestant_guardian || null,
      sole_guardian_attestation_version: att.attestation_version || null,
    }]);
    Logger.log(redact_('[persistSoleGuardianAttestation_] registrada atestación tutor único group=' +
      enrollmentGroupId + ' attestant=' + (att.attestant_guardian || '?') + ' ver=' + (att.attestation_version || '?')));
  } catch (e) {
    // P72 / columnas no creadas aún → no rompe el flujo (regla "la falta de columna
    // AppSheet NO congela"). Se loguea redactado; alta pendiente como TODO de Diego.
    Logger.log(redact_('[persistSoleGuardianAttestation_] best-effort fail (¿columnas no creadas? P72) group=' +
      enrollmentGroupId + ': ' + e.message));
  }
}

/**
 * CLI PHONE-E164 — valida formato E.164 canónico (`+<dialcode><national>`).
 * Defensa en profundidad: la fuente de verdad es el input validado/normalizado
 * del wizard (Step 2 + utils/phone.js); esto es la red de seguridad server-side.
 * Lanza Error con `code='INVALID_PHONE'` → doPost lo mapea a HTTP 200
 * {ok:false,error:{code,message}}. KAL-11: el message NO incluye el número (PII);
 * el frontend usa el `code` para el i18n.
 *
 * @param {*}      v
 * @param {string} [fieldName] para el message (sin el valor)
 */
function assertValidPhoneE164_(v, fieldName) {
  if (typeof v !== 'string' || !/^\+[1-9]\d{6,14}$/.test(v)) {
    var e = new Error('Invalid phone (E.164 required) for ' + (fieldName || 'field'));
    e.code = 'INVALID_PHONE';
    throw e;
  }
}

/**
 * Validates a SIGNING_TOKEN format. Unlike assertValidUuid_, accepts BOTH:
 *   - canonical UUID v4 with hyphens (36 chars)
 *   - dashless 32-hex (PackedUUID-style) — the format the KMS actually emits per
 *     signer (`_signing_generateSignerToken_`, e.g. 019c2aa3dc5243ef8633e00dd47644b3).
 *
 * P211 fix: the KMS emits signing_tokens dashless, but requireSigningToken_ /
 * resolveSigningToken_ validated with the STRICT assertValidUuid_ (KAL-5) → every
 * real token was rejected ("token no válido o caducado"). Mirrors the KMS-side
 * fix `sys_resolveRecipientEmailLoose_` (relax FORMAT only). Still hex-only, so the
 * appsheetEscape_ layer-2 on the Filter concatenation (KAL-5) remains the security
 * boundary — UNTOUCHED. Throws on anything that is not one of the two hex shapes.
 *
 * @param {*}      v
 * @param {string} [fieldName] for the error message
 */
function assertValidSigningToken_(v, fieldName) {
  if (typeof v === 'string') {
    var s = v.trim();
    if (/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s) ||
        /^[0-9a-f]{32}$/i.test(s)) {
      return;
    }
  }
  throw new Error('Invalid signing_token for ' + (fieldName || 'field') + ': ' + JSON.stringify(v));
}

// ─── IDOR defense (KAL-4) ─────────────────────────────────────────────────────
// Closes the Insecure Direct Object Reference vector identified in the
// 2026-05-29 audit. Mutation handlers (saveStep_, submitEnrollmentSession_,
// saveResponses_, uploadDocument_) used to trust `enrollment_group_id` from
// the payload directly, so anyone who knew or guessed a group_id could mutate
// another family's wizard.
//
// Defense: every mutation handler MUST derive the authorised group_id from
// the caller's resume_token (which is the family's bearer secret, set on the
// enrEnrollmentGroups row at init time). The payload may still echo back
// `enrollment_group_id` for legacy compat, but it must match the one resolved
// from the token — otherwise the request is rejected.

/**
 * Resolves resume_token from payload → enrollment_group_id from BD.
 * Throws if token missing, malformed, or no matching group found.
 * Returns the canonical group_id (NEVER trust the one from payload).
 *
 * Defense pattern KAL-4 (IDOR): caller must derive group_id from token,
 * not from the payload field directly. If payload also includes a
 * enrollment_group_id, MUST match the one resolved from token.
 *
 * @param {Object} payload - request payload (must contain `resume_token`)
 * @returns {string} canonical enrollment_group_id authorised by the token
 */
/**
 * Memo de LECTURA del gate KAL-4 (SPEC-WIZ-WARMUP-V2, 2026-06-12 — precedente
 * canónico #65/#67b: memo ScriptCache de identidad TTL 300s SOLO para lecturas).
 * requireResumeToken_ paga una lectura AppSheet (~2,5-5s) por llamada; en los
 * caminos que SIRVEN datos ya autorizados (getDocument_) ese coste dominaba el
 * e2e con el bundle caliente. Cachea token→groupId 300s con el MISMO cross-group
 * guard. NUNCA usar en handlers de mutación (saveStep_, submit…, actos de firma):
 * esos validan SIEMPRE en vivo. Lag aceptado ≤5 min para abandono/expiración/
 * rotación en lecturas (mismo trade-off aprobado del memo de requireSignerIdentity_);
 * el PII-gate de step-up (ventana dura 10 min) sigue evaluándose EN VIVO aparte.
 * @private
 */
function requireResumeTokenMemo_(payload) {
  _dbgEv_('gate', 'requireResumeToken (memo)');
  const token = payload && payload.resume_token;
  let cache = null, key = null;
  try {
    assertValidUuid_(token, 'resume_token');
    cache = CacheService.getScriptCache();
    key = 'rtmemo_' + sha256Hex_(Utilities.newBlob(String(token).trim()).getBytes()).slice(0, 40);
    const hit = cache.get(key);
    if (hit) {
      // Cross-group guard — paridad EXACTA con requireResumeToken_ (KAL-4).
      const payloadGroupId = payload && (payload.enrollment_group_id || payload.application_id);
      if (payloadGroupId && payloadGroupId !== hit) {
        throw new Error('Unauthorized: payload enrollment_group_id does not match resume_token grant');
      }
      return hit;
    }
  } catch (e) {
    if (e && /Unauthorized/.test(e.message || '')) throw e;
    // assert/cache falló → camino vivo (degradación limpia)
  }
  const groupId = requireResumeToken_(payload);
  try { if (cache && key) cache.put(key, groupId, 300); } catch (e2) { /* best-effort */ }
  return groupId;
}

function requireResumeToken_(payload) {
  _dbgEv_('gate', 'requireResumeToken (live)');
  const token = payload && payload.resume_token;
  assertValidUuid_(token, 'resume_token');
  const rows = appsheetRequest_(T.ENROLLMENT_GROUPS, 'Find', [], {
    Filter: '"resume_token" = "' + appsheetEscape_(token) + '"'
  });
  if (!rows || !rows.length) {
    throw new Error('Unauthorized: resume_token not recognized');
  }
  const group = rows[0];

  // === CLI 81 (S8 / KAL-NEW-7): TTL + abandoned_at gate ──────────────────────
  // Before this fix, an expired or phished-then-abandoned resume_token was
  // rejected by resumeSession_ (the read gate) but still ACCEPTED by every
  // mutation handler that derives its group via requireResumeToken_
  // (saveStep_, saveResponses_, uploadDocument_, submitEnrollmentSession_).
  // We mirror the exact canonical logic from resumeSession_ (~line 1118) so the
  // write gate and the read gate agree on what "valid token" means. No
  // expires_at column exists — the TTL is derived from created_at (7-day
  // window), and submitted groups are exempt (they must stay accessible so the
  // family can always view / be reopened for what they sent).
  if (group.abandoned_at) {
    Logger.log(redact_('[requireResumeToken_] reject: abandoned group=' + group.enrollment_group_id));
    throw new Error('Unauthorized: resume_token abandoned');
  }
  if (!group.submitted_at) {
    const RESUME_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
    const createdAt = group.created_at ? new Date(group.created_at).getTime() : 0;
    if (createdAt && (Date.now() - createdAt) > RESUME_TOKEN_TTL_MS) {
      Logger.log(redact_('[requireResumeToken_] reject: expired group=' + group.enrollment_group_id));
      throw new Error('Unauthorized: resume_token expired (7 days)');
    }
  }

  const tokenGroupId = group.enrollment_group_id;
  // SPEC-WIZ-WARMUP-V2: poblar el memo de LECTURA (rtmemo_) tras la validación
  // VIVA — así la primera llamada de lectura posterior (getDocument_) ya tiene el
  // gate caliente sin pagar otra lectura AppSheet. Best-effort; no cambia la
  // semántica de validación de NINGÚN caller (esto ES el resultado en vivo).
  try {
    CacheService.getScriptCache().put(
      'rtmemo_' + sha256Hex_(Utilities.newBlob(String(payload.resume_token).trim()).getBytes()).slice(0, 40),
      tokenGroupId, 300);
  } catch (eM) { /* best-effort */ }
  // Cross-group guard: if payload also provides group_id (legacy alias
  // `application_id` included), it MUST match the one resolved from token.
  const payloadGroupId = payload && (payload.enrollment_group_id || payload.application_id);
  if (payloadGroupId && payloadGroupId !== tokenGroupId) {
    throw new Error('Unauthorized: payload enrollment_group_id does not match resume_token grant');
  }
  return tokenGroupId;
}

/**
 * Canonical bearer-token gate for the SIGNING flow (`/sign` SigningWizardPage).
 * Parallel a `requireResumeToken_` (gate del wizard `/apply`).
 *
 * El wizard tiene DOS bearer secrets canónicos, ambos UUID v4 emitidos
 * server-side (no enumerables):
 *   - `resume_token`  → mutaciones de `/apply` (saveStep_, saveResponses_,
 *                       uploadDocument_, submitEnrollmentSession_). Resuelve el
 *                       enrollment_group_id desde enrEnrollmentGroups.
 *   - `signing_token` → mutaciones de `/sign` (saveBillingInfo_, submitGdprConsents_,
 *                       confirmReview_, initiateSigningSession_). Resuelve
 *                       signer + session + grupo vía `resolveSigningToken_`.
 *
 * KAL-4 IDOR: el signing_token se valida server-side (`resolveSigningToken_`
 * comprueba existencia en sysSigningSessionSigners + estado no terminal +
 * UUID estricto + appsheetEscape_). Defensa equivalente al resume_token —
 * ambos son UUID no enumerables. El `enrollment_group_id` autorizado se deriva
 * del token, NUNCA del payload.
 *
 * @param {Object} payload  debe contener `{ signing_token }`.
 * @returns {{ signing_token, signer_id, session_id, enrollment_group_id, guardian_person_id }}
 * @throws {Error} `BAD_REQUEST` si el signing_token no es UUID válido;
 *                 `UNAUTHORIZED` si no existe / expirado / revocado.
 */
function requireSigningToken_(payload) {
  const token = payload && payload.signing_token;
  assertValidSigningToken_(token, 'signing_token'); // P211: acepta UUID v4 o dashless 32-hex (formato KMS); throw BAD_REQUEST si malformado

  const resolved = resolveSigningToken_({ signing_token: token });
  if (!resolved || !resolved.valid) {
    const reason = (resolved && resolved.reason) || 'INVALID';
    const err = new Error('Unauthorized: signing_token ' + reason);
    err.code = 'UNAUTHORIZED';
    throw err;
  }
  return {
    signing_token:       String(token).trim(),
    signer_id:           resolved.signer_id           || null,
    session_id:          resolved.session_id          || null,
    enrollment_group_id: resolved.enrollment_group_id || null,
    guardian_person_id:  resolved.guardian_person_id  || null,
  };
}

/**
 * DL-A.3 — Gate UNIFICADO de identidad de firma (★ CANÓNICA DEFINITIVA, colapso del
 * `signing_token`). El wizard es UN flujo de 11 pasos con UN solo token email-bound:
 * el firmante se resuelve server-side de (resume_token → grupo, KAL-4) + (email tecleado
 * → guardian, a1). El `signing_token` deja de ser un bearer del cliente.
 *
 * Acepta DOS formas (orden de preferencia canónica):
 *   (a) { resume_token, recovered_email } → grupo (KAL-4) + guardian (a1). NO se resuelve
 *       el signing_token localmente: se REENVÍA la identidad al KMS, que lo colapsa
 *       server-side (enr_resolveSignerContext_). DL-E41: el wizard no computa firma.
 *   (b) { signing_token } → back-compat (bearer legacy, aún soportado en la transición).
 *
 * Devuelve `{ enrollment_group_id, guardian_person_id?, signing_token?, identity }`.
 * `identity` es el sub-objeto a reenviar al KMS (resume_token+recovered_email | signing_token).
 *
 * @param {Object} payload
 * @returns {{enrollment_group_id:string, guardian_person_id:(string|null),
 *            signing_token:(string|null), identity:Object}}
 * @throws code='UNAUTHORIZED' | 'BAD_REQUEST'
 */
function requireSignerContext_(payload) {
  payload = payload || {};

  // (a) Path canónico — colapso del bearer (resume_token + email).
  // IDENTITY-FROM-LINK (2026-06-11): basta el resume_token + el `n` (email_id) del enlace.
  // El recovered_email se deriva SERVER-SIDE del propio enlace (`n` = email_id → email del
  // guardian, validado contra el grupo del token) cuando el cliente no lo aporta
  // (F5/incógnito/pestaña nueva) → la firma resuelve identidad sin depender del cliente.
  if (payload.resume_token && !payload.signing_token) {
    const groupId = requireResumeToken_(payload);   // KAL-4 + TTL 7d + abandoned gate
    // IDENTITY-FROM-LINK: prioridad `n` (email_id del enlace) > recovered_email (compat).
    // resolveGuardianForRecovery_ lee enrEmails/persons lazy dentro del resolver.
    const effEmail = effectiveRecoveredEmail_(payload.recovered_email, groupId, payload.n);
    if (!effEmail) {
      // Sin `n` del enlace NI recovered_email del cliente → no se puede identificar al
      // guardian. Caer a (b) si hay signing_token; si no, error explícito.
      const err = new Error('Unauthorized: no se pudo identificar al firmante (falta `n` del enlace o recovered_email)');
      err.code = 'UNAUTHORIZED';
      throw err;
    }
    const guardianId = resolveGuardianForRecovery_(groupId, effEmail);
    if (!guardianId) {
      const err = new Error('Unauthorized: recovered_email no resuelve a un guardian del grupo');
      err.code = 'UNAUTHORIZED';
      throw err;
    }
    return {
      enrollment_group_id: groupId,
      guardian_person_id:  guardianId,
      signing_token:       null,
      identity: {
        resume_token:    String(payload.resume_token).trim(),
        recovered_email: effEmail,
      },
    };
  }

  // (b) Back-compat — bearer signing_token.
  const sctx = requireSigningToken_(payload);
  return {
    enrollment_group_id: sctx.enrollment_group_id,
    guardian_person_id:  sctx.guardian_person_id,
    signing_token:       sctx.signing_token,
    identity: { signing_token: sctx.signing_token },
  };
}

/**
 * PERF-WIZ (2026-06-11) — identidad de firmante LIGERA para los proxies de actos
 * ENCOLADOS y lecturas de firma. Misma autenticación de sesión que
 * requireSignerContext_ (requireResumeToken_ KAL-4 + TTL + abandoned, y el email
 * efectivo del enlace via effectiveRecoveredEmail_), pero SIN la validación local
 * del guardian (resolveGuardianForRecovery_, varias lecturas AppSheet): esa
 * validación la hace SIEMPRE el resolver ÚNICO del KMS (enr_resolveSignerContext_)
 * en el MISMO request síncrono del enqueue — si la identidad no resuelve, el KMS
 * lanza UNAUTHORIZED y este proxy lo propaga igual que antes. Dos resolvers
 * duplicados divergentes era el anti-patrón P245; el wizard pre-validando al
 * guardian costaba 20-40s por acto SIN añadir seguridad (KAL-4 vive server-side
 * en quien ESCRIBE). El acto real de firma del Step 11 NO usa este helper.
 *
 * @param {Object} payload — { resume_token, n?, recovered_email? } o { signing_token }
 * @returns {{enrollment_group_id:string, identity:Object}}
 */
function requireSignerIdentity_(payload) {
  payload = payload || {};
  if (payload.resume_token && !payload.signing_token) {
    // PERF-KMS2 (2026-06-11): memo ScriptCache de la derivación {groupId, effEmail}
    // (medida: 10-22s por llamada — 2-3 lecturas AppSheet a 4-7s/lectura). Reglas:
    //   - SOLO para los consumidores de este gate: lecturas (getSavedBillingSplits,
    //     initiateSigningSession create_only) y acks encolados (billing/gdpr/review).
    //     El ACTO real de firma (Step 11) va por requireSignerContext_ — NO toca esto;
    //     todo check de single-use vive server-side en el KMS (P222 intacta).
    //   - Clave = sha256(resume_token|n|recovered_email) → la rotación del token
    //     (sendMagicLink_) cambia la clave; la entrada vieja queda inalcanzable y expira.
    //   - TTL 300s. El KMS re-valida TODO (token/TTL/abandoned/guardian) en cada proxy —
    //     el memo solo ahorra la re-derivación wizard-side, no autoriza nada por sí solo.
    var memoKey = null;
    try {
      var memoRaw = [String(payload.resume_token).trim(), payload.n || '', payload.recovered_email || ''].join('|');
      var memoDig = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, memoRaw, Utilities.Charset.UTF_8);
      memoKey = 'sigid_' + memoDig.map(function(b) {
        var v = (b + 256) % 256; return (v < 16 ? '0' : '') + v.toString(16);
      }).join('');
      var memoHit = CacheService.getScriptCache().get(memoKey);
      if (memoHit) {
        var memoVal = JSON.parse(memoHit);
        if (memoVal && memoVal.g && memoVal.e) {
          return {
            enrollment_group_id: memoVal.g,
            identity: {
              resume_token:    String(payload.resume_token).trim(),
              recovered_email: memoVal.e,
            },
          };
        }
      }
    } catch (eMemo) { /* el memo nunca rompe el camino live */ }

    const groupId = requireResumeToken_(payload);   // KAL-4 + TTL 7d + abandoned gate
    const effEmail = effectiveRecoveredEmail_(payload.recovered_email, groupId, payload.n);
    if (!effEmail) {
      const err = new Error('Unauthorized: no se pudo identificar al firmante (falta `n` del enlace o recovered_email)');
      err.code = 'UNAUTHORIZED';
      throw err;
    }
    try {
      if (memoKey) {
        CacheService.getScriptCache().put(memoKey, JSON.stringify({ g: groupId, e: effEmail }), 300);
      }
    } catch (ePut) { /* best-effort */ }
    return {
      enrollment_group_id: groupId,
      identity: {
        resume_token:    String(payload.resume_token).trim(),
        recovered_email: effEmail,
      },
    };
  }
  const sctx = requireSigningToken_(payload);
  return {
    enrollment_group_id: sctx.enrollment_group_id,
    identity: { signing_token: sctx.signing_token },
  };
}

// ─── CLI 26 (2026-06-01) — State-gate for mutation endpoints ─────────────────
//
// Defense-in-depth against frontend bugs that let a family edit a submitted
// application. The wizard already hides Edit/Save UI when isSubmitted=true
// (see frontend WizardPage), but a malicious client could still POST to
// saveStep / saveResponses / uploadDocument with a valid resume_token after
// the group's submitted_at is set. This helper closes that hole.
//
// Editability model — conceptually a tiny state-machine gate, not a milestone:
//
//   submitted_at IS NULL                  → DRAFT             → editable
//   submitted_at IS NOT NULL, enrollments → RQ/IN/etc          → NOT editable
//                                           (KMS owns transitions
//                                            from here onwards)
//
// The "reopen" branch is server-side already (resumeSession_ overrides
// submitted_at to null when all enrollments are back in state IN — see
// the comment around line 1095). So checking submitted_at alone is
// sufficient: when the KMS reopens an application, the next resume sees
// submitted_at as null and the wizard becomes editable again.
//
// Editable state codes (canonical, hardcoded today; TODO mover a catálogo
// dinámico vía sysStateTransitions_T flags `is_editable_by_family`):
//   ['DRAFT', 'NEEDS_MORE_INFO']
//
// Rejection style — P72 silent reject pattern: throws an Error with
// `.code='NOT_EDITABLE'`, which doPost catches and turns into
// `{ ok: false, error: { code, message } }` over HTTP 200. Never HTTP 403.
//
// @param {string} enrollmentGroupId - already authorised via requireResumeToken_
// @throws {Error & {code: 'NOT_EDITABLE'}} when the group is locked
function assertGroupEditable_(enrollmentGroupId) {
  assertValidUuid_(enrollmentGroupId, 'enrollment_group_id');
  const rows = appsheetRequest_(T.ENROLLMENT_GROUPS, 'Find', [], {
    Filter: '"enrollment_group_id" = "' + appsheetEscape_(enrollmentGroupId) + '"'
  });
  const group = rows && rows[0];
  if (!group) {
    // Should be impossible — requireResumeToken_ already resolved a group.
    const err = new Error('Enrollment group not found');
    err.code = 'NOT_FOUND';
    throw err;
  }
  if (group.abandoned_at) {
    const err = new Error('Application has been abandoned and cannot be edited');
    err.code = 'NOT_EDITABLE';
    Logger.log(redact_('[assertGroupEditable_] reject group=' + enrollmentGroupId + ' reason=abandoned'));
    throw err;
  }
  if (group.submitted_at) {
    const err = new Error('Application has already been submitted and is locked for review; contact admissions to request changes');
    err.code = 'NOT_EDITABLE';
    Logger.log(redact_('[assertGroupEditable_] reject group=' + enrollmentGroupId + ' reason=submitted_at=' + group.submitted_at));
    throw err;
  }
  // Editable.
}

// ─── DL-E39 PII-primero — step-up re-auth helpers (Fase A) ──────────────────
//
// El step-up re-verifica acceso-al-inbox antes de revelar/mutar PII sensible.
// El resume_token (7 días, reutilizable) autoriza la SESIÓN; el step-up añade
// una prueba fresca de que quien opera AHORA controla el buzón. Reutilizamos
// el dispatcher sendVerificationCode_/verifyEmail_ (endurecido KAL-NEW-2:
// CSPRNG, rate-limit 5/h, TTL 10 min, lockout 5 intentos) — NO hay token nuevo.
//
// KAL-4 IDOR: el enrollment_group_id (y el signer en /sign) SIEMPRE se derivan
// del bearer token server-side, NUNCA del payload.

/**
 * Deriva el contexto autorizado (grupo + firmante si aplica) del bearer token
 * presente en el payload. Si hay signing_token (flujo /sign) → contexto de
 * firma (incluye guardian_person_id); si no → resume_token (flujo /apply).
 * KAL-4: el group SIEMPRE sale del token.
 *
 * @param {Object} p - payload con signing_token o resume_token
 * @returns {{ enrollment_group_id, ... }} contexto autorizado.
 *   - /sign: el objeto completo de requireSigningToken_
 *   - /apply: { enrollment_group_id } normalizado desde requireResumeToken_
 *     (que devuelve el group_id como string)
 * @private
 */
function _resolveStepUpGroup_(p) {
  if (p && p.signing_token) {
    return requireSigningToken_(p); // { enrollment_group_id, guardian_person_id, ... }
  }
  // requireResumeToken_ devuelve el enrollment_group_id como string.
  return { enrollment_group_id: requireResumeToken_(p) };
}

/**
 * Marca el grupo como "step-up fresco" durante STEPUP_INACTIVITY_MS — VENTANA DURA.
 *
 * ★ SEC-STEPUP (finding #55, 2026-06-11). Esta marca se acuña EXCLUSIVAMENTE en
 * eventos de RE-VERIFICACIÓN REAL del inbox:
 *   (1) verifyEmail_ con stepup:true (OTP fresco verificado), y
 *   (2) consumo single-use de la gracia de magic-link (mlgrace_<resume_token>,
 *       que prueba un envío reciente al inbox del expediente).
 *
 * NUNCA se re-escribe en una mera RESOLUCIÓN/LECTURA (hydrate, pulso
 * getAdmissionState, save de PII). Antes (P-STEPUP-SLIDING) cada save y cada
 * pulso re-extendían la ventana → 10 min se convertían en infinitos mientras la
 * pestaña estuviera abierta o el usuario activo, y una recarga dentro de esa
 * ventana viva entraba SIN OTP (bypass del PII-gate). Ahora la ventana es DURA:
 * 10 min EXACTOS desde la última re-verificación, sin extensión por uso. Pasados
 * los 10 min, el PII-gate vuelve a exigir OTP.
 *
 * Guarda el timestamp de EXPIRACIÓN (Date.now()+ventana) en el ScriptCache; el
 * gate compara contra Date.now(). El TTL del cache se alinea a la misma ventana.
 *
 * NO usar para "deslizar" la ventana en cada actividad — eso es precisamente el
 * bug que SEC-STEPUP cerró. Para una ventana viva más larga, el usuario re-OTPa.
 *
 * @param {string} enrollmentGroupId - ya derivado del token (KAL-4)
 * @param {string} [reason]          - etiqueta del evento (OTP|GRACE) para el log
 * @private
 */
function _markStepUpFresh_(enrollmentGroupId, reason) {
  CacheService.getScriptCache().put(
    'stepup_ok_' + enrollmentGroupId,
    String(Date.now() + STEPUP_INACTIVITY_MS),
    Math.ceil(STEPUP_INACTIVITY_MS / 1000)
  );
  Logger.log(redact_('[DBG stepup] mint reason=' + (reason || '?') + ' group=' + enrollmentGroupId + ' ttl_s=' + Math.ceil(STEPUP_INACTIVITY_MS / 1000)));
}

// ─── DL-A.5 (Opción A §2) — versión liveState por grupo (cheap-poll) ──────────
//
// El KMS hace doPost a `notifyLiveStateChange` cuando cambia estado/milestone de un
// grupo → bumpamos un contador efímero en ScriptCache (NO BD de negocio). El browser
// hace un poll ultra-ligero (`getLiveStateVersion`, solo lee este contador, SIN tocar
// AppSheet ni el KMS) on-focus + intervalo; SOLO cuando la versión sube hace el fetch
// de detalle del liveState (spec §2, push-half + cheap-poll-half). TTL 6h (máx del
// ScriptCache); el valor por defecto 0 es seguro (un reset solo fuerza una re-lectura).

var LIVE_VERSION_TTL_S_ = 21600;  // 6h — máximo del ScriptCache

function _liveVersionKey_(enrollmentGroupId) { return 'livever_' + enrollmentGroupId; }

/**
 * @param {string} enrollmentGroupId
 * @returns {number} versión actual (0 si no hay marca)
 * @private
 */
function _getLiveStateVersion_(enrollmentGroupId) {
  var v = CacheService.getScriptCache().get(_liveVersionKey_(enrollmentGroupId));
  return v ? Number(v) : 0;
}

/**
 * Incrementa la versión liveState del grupo (lo llama el notify del KMS). Best-effort.
 * @param {string} enrollmentGroupId
 * @returns {number} nueva versión
 * @private
 */
function _bumpLiveStateVersion_(enrollmentGroupId) {
  var next = _getLiveStateVersion_(enrollmentGroupId) + 1;
  CacheService.getScriptCache().put(_liveVersionKey_(enrollmentGroupId), String(next), LIVE_VERSION_TTL_S_);
  return next;
}

/**
 * IDENTITY-FROM-LINK (2026-06-11) — la gracia del magic-link (OTP-skip de 10 min) ya NO
 * viaja en `?n=` (ese param pasa a llevar el `email_id` del guardian, identidad — ver
 * resolveGuardianFromLinkParam_). La gracia se ANCLA al `resume_token` recién rotado:
 * al emitir un link se acuña un marcador single-use `mlgrace_<resume_token>` = group en
 * ScriptCache (TTL = ventana de gracia). El `resume_token` ya viaja en el path del link
 * y el frontend ya lo reenvía en cada llamada → cero param nuevo, cero schema nuevo.
 *
 * Propiedades de seguridad preservadas vs el modelo de nonce aleatorio:
 *  - Single-use: el primer recovery BORRA el marcador.
 *  - 10 min: TTL idéntico (MAGIC_LINK_GRACE_MS).
 *  - Anclado a un envío reciente de ESTE grupo: la rotación del token en la emisión
 *    crea el marcador con el token NUEVO; un token viejo/filtrado/reusado no tiene
 *    marcador → step_up_fresh=false → flujo OTP normal intacto (KAL-7).
 *
 * @param {string} resumeToken       - el resume_token (recién rotado) del envío
 * @param {string} enrollmentGroupId - ya derivado/validado server-side (KAL-4)
 * @private
 */
function _mintMagicLinkNonce_(resumeToken, enrollmentGroupId) {
  if (!resumeToken || !enrollmentGroupId) return;
  try { assertValidUuid_(resumeToken, 'resume_token'); } catch (e) { return; }
  CacheService.getScriptCache().put(
    'mlgrace_' + resumeToken,
    enrollmentGroupId,
    Math.ceil(MAGIC_LINK_GRACE_MS / 1000)
  );
}

/**
 * Consume (single-use) la gracia de magic-link anclada al `resume_token`: si existe el
 * marcador `mlgrace_<resume_token>` en cache y mapea al grupo esperado, lo BORRA y
 * devuelve true (gracia válida → sin OTP). Si no existe (expiró, ya usado, token viejo,
 * nunca emitido) o mapea a otro grupo → false (flujo OTP normal). El grupo esperado se
 * deriva SIEMPRE del resume_token server-side (KAL-4); el marcador solo confirma "este
 * click viene de un envío reciente de ESTE grupo".
 *
 * @param {string} resumeToken     - resume_token del payload (validado server-side antes)
 * @param {string} expectedGroupId - group derivado del resume_token
 * @returns {boolean}
 * @private
 */
function _consumeMagicLinkNonce_(resumeToken, expectedGroupId) {
  if (!resumeToken) return false;
  try { assertValidUuid_(resumeToken, 'resume_token'); } catch (e) { return false; }
  const cache = CacheService.getScriptCache();
  const key   = 'mlgrace_' + resumeToken;
  const mappedGroup = cache.get(key);
  if (!mappedGroup || mappedGroup !== expectedGroupId) {
    // Inexistente/expirado/usado o de otro grupo → sin gracia. KAL-7: preview ≤8.
    Logger.log(redact_('[DBG stepup] grace_hit=false consumed=false token=' + String(resumeToken).slice(0, 8) + '… group=' + expectedGroupId));
    return false;
  }
  cache.remove(key); // single-use ESTRICTO: el primer click BORRA la marca (no reusable)
  Logger.log(redact_('[DBG stepup] grace_hit=true consumed=true token=' + String(resumeToken).slice(0, 8) + '… group=' + expectedGroupId));
  return true;
}

/**
 * Gate de step-up (molde de assertGroupEditable_). Exige que el grupo tenga una
 * marca de step-up fresca (`stepup_ok_<group>` presente y no expirada). Si no →
 * throw Error con .code='STEPUP_REQUIRED'. El doPost mapea genéricamente
 * cualquier err.code → HTTP 200 { ok:false, error:{ code, message } } (líneas
 * ~531-535), así que NO se añade case nuevo en el dispatcher.
 *
 * @param {string} enrollmentGroupId - ya derivado del token (KAL-4)
 * @throws {Error & {code: 'STEPUP_REQUIRED'}} cuando falta marca o expiró
 * @private
 */
/**
 * Versión booleana del gate de step-up: ¿el grupo tiene una marca fresca y no
 * expirada? No lanza — para call-sites que solo quieren REPORTAR la frescura (p.ej.
 * el endpoint ligero getAdmissionState_). assertStepUpFresh_ la reusa.
 * @param {string} enrollmentGroupId - ya derivado del token (KAL-4)
 * @returns {boolean}
 * @private
 */
function _isStepUpFresh_(enrollmentGroupId) {
  const val = CacheService.getScriptCache().get('stepup_ok_' + enrollmentGroupId);
  const fresh = !!val && Number(val) >= Date.now();
  // SEC-STEPUP [DBG stepup]: edad/restante de la ventana DURA, redactado. Que el
  // próximo log lo cuente solo — sin re-extender nada (esto es solo lectura).
  if (val) {
    const remainingS = Math.max(0, Math.round((Number(val) - Date.now()) / 1000));
    Logger.log(redact_('[DBG stepup] read group=' + enrollmentGroupId + ' fresh=' + fresh + ' remaining_s=' + remainingS));
  } else {
    Logger.log(redact_('[DBG stepup] read group=' + enrollmentGroupId + ' fresh=false no_mark'));
  }
  return fresh;
}

function assertStepUpFresh_(enrollmentGroupId) {
  if (!_isStepUpFresh_(enrollmentGroupId)) {
    var err = new Error('Step-up re-verification required');
    err.code = 'STEPUP_REQUIRED';
    Logger.log(redact_('[assertStepUpFresh_] reject group=' + enrollmentGroupId));
    throw err;
  }
  // Fresco.
}

// ─── WIZARD-CACHE (2026-06-12, arquitectura dictada por Diego) ────────────────
//
// "Los datos cacheados los debería tener el Wizard: usuario pide magic link → el
// backend genera el link y solicita recursos al KMS → el KMS se los envía al
// Wizard Backend que los cachea → para cuando el usuario abra el wizard, el
// backend ya tiene todos los datos cacheados y los sirve de inmediato."
//
// Capas: este cache es la L1 (wizard-side, ScriptCache del wizard, TTL 1800s);
// el warm del KMS (SPEC-WIZ-WARMUP, _enqueueWarmHydrate_) se MANTIENE como L2 —
// abarata los pulls de esta capa.
//
// Troceo: port VERBATIM del código-de-oro del KMS (kis-app/kms-server/enr/
// signing-docs.gs — _enr_docCacheKey_/_enr_docCachePutChunked_/_enr_docCacheGetChunked_,
// reensamblado 364KB en 0,6s verificado 2026-06-12). Los valores grandes (hydrate
// 100-400KB, PDFs base64 287-373KB) NO caben en una clave ScriptCache (~100KB).
//
// Seguridad: claves keyed por resume_token (KAL-4: el grupo se deriva del token
// validado server-side en el SERVIDO; la rotación del token en sendMagicLink_
// invalida gratis — clave nueva). El cache NO salta NINGÚN gate: los lectores leen
// cache DESPUÉS de sus gates (requireResumeToken_ + step-up/PII) — solo cambia el
// ORIGEN de los datos. KAL-11: logs solo con token.slice(0,8).

/** Clave base del cache wizard (kind: 'hyd' | 'adm' | 'res' | 'mem' | 'doc').
 *
 * RE-LLAVEO V2.4 (pregunta de Diego 2026-06-12 17:08: "una vez cargada en el
 * servidor, ¿por qué no se queda ahí hasta que caduque la caché?"): las claves
 * iban atadas al resume_token y el token ROTA con cada magic link → clave nueva
 * → cache "perdido" aunque los bytes siguieran en ScriptCache. Claves ESTABLES:
 *   doc → file_id (bytes inmutables; la entrada guarda g=group_id y el servido
 *         verifica pertenencia post-gate — KAL-4; TTL 6h)
 *   mem → enrollment_group_id (members del paquete, de grupo)
 *   hyd/res/adm → enrollment_group_id + n (contexto per-guardian)
 * Frescura: live_version (v en la entrada) — los writes bumpan la versión del
 * grupo (_wzCacheInvalidate_) y cualquier entrada con v vieja es MISS. La
 * rotación del token deja de borrar nada: re-entrar 10 min después = HIT. */
function _wzCacheKey_(kind, suffix) { return 'wz_' + kind + '_' + suffix; }

/** Discriminador per-guardian para claves hyd/res/adm ('-' si no hay n). @private */
function _wzN_(n) { return String(n || '-').trim(); }

// URL /exec PROPIA para las auto-invocaciones del warm. El deployment es FIJO
// (CLAUDE.md: nunca se crea deployment nuevo — cambiaría la URL pública); fallback
// dinámico por si algún día rota.
var WIZARD_EXEC_URL_ = 'https://script.google.com/macros/s/AKfycbyzyAR6J3_2UAiE6tCyNHVawoGfMNNbZEaurp99cRI76IYbiqGVEeQQcTxsgAqUFnGk0w/exec';

/**
 * SPEC-WIZ-WARMUP-V2.1 (2026-06-12) — PARALELIZA el warm: dos ejecuciones HIJAS
 * concurrentes contra el propio /exec (UrlFetchApp.fetchAll). El PADRE es la
 * ejecución async que arrancó el kick del frontend (puede bloquear sin coste de
 * UX); los hijos corren en PARALELO (cuota GAS 30 concurrentes/usuario) → el
 * tiempo de pared del warm pasa de sum(fases) a max(fases). Motivo: round 5
 * (13:44Z) probó que el warm SECUENCIAL (hydrate 30-70s + res 25-30s + docs) no
 * ganaba la carrera del minuto muerto. Best-effort: timeout/cierre del padre no
 * mata a los hijos (ejecución sobrevive al corte del caller — verificado E1).
 * @private
 */
function _wzSelfFetchAll_(payloads) {
  try {
    if (!payloads || !payloads.length) return;
    var url = WIZARD_EXEC_URL_;
    try { var u = ScriptApp.getService().getUrl(); if (u) url = u; } catch (eU) { /* fallback const */ }
    var reqs = payloads.map(function(pl) {
      return {
        url: url, method: 'post', contentType: 'text/plain',
        payload: JSON.stringify(Object.assign({ action: 'warmBundle', _hp: '' }, pl)),
        followRedirects: false, muteHttpExceptions: true,
      };
    });
    UrlFetchApp.fetchAll(reqs);
  } catch (e) { Logger.log(redact_('[_wzSelfFetchAll_] non-fatal — ' + (e && e.message))); }
}

/**
 * SPEC-WIZ-WARMUP-V2.2 (2026-06-12, log real de Diego 15:06) — SINGLE-FLIGHT:
 * cuando el usuario clica ANTES de que el warm termine (click a los 26s del kick),
 * el camino vivo NO debe duplicar el trabajo del warm (la estampida multiplicaba
 * la latencia: hydrate 73,7s, initiate(read) 37-49s x3). Si hay un warm COCINANDO
 * este token (marcador wzck_*), el vivo ESPERA su resultado (sondeo del cache cada
 * 2s, con tope) en vez de competir. Marcador caído sin resultado o timeout → vivo.
 * @returns {?string} serialized del cache o null (→ camino vivo)
 * @private
 */
function _wzAwaitWarm_(markerKey, cacheKey, maxMs) {
  try {
    var cache = CacheService.getScriptCache();
    if (!cache.get(markerKey)) return null;
    Logger.log('[WZCACHE] single-flight: esperando warm en curso (' + markerKey.slice(0, 12) + '…)');
    var t0 = Date.now();
    while (Date.now() - t0 < maxMs) {
      Utilities.sleep(2000);
      var raw = _wzCacheGetChunked_(cache, cacheKey);
      if (raw) return raw;
      if (!cache.get(markerKey)) return null;
    }
  } catch (e) { /* best-effort → vivo */ }
  return null;
}

/**
 * Pase interno single-use (TTL 300s) para una fase hija del warm. Server-minted
 * (jamás derivable por el cliente); consumido en warmBundle_ al primer uso.
 * @private
 */
function _mintWarmPass_(item) {
  try {
    var pass = generateUuid_();
    CacheService.getScriptCache().put('wzwp_' + pass, JSON.stringify(item), 300);
    return pass;
  } catch (e) { return null; }
}

/** Guarda `serialized` en N trozos (<90KB) + clave _meta. TTL en segundos. Best-effort.
 *  (port verbatim de _enr_docCachePutChunked_, código-de-oro KMS signing-docs.gs) */
function _wzCachePutChunked_(cache, key, serialized, ttl) {
  try {
    var CH = 90000;
    var n = Math.ceil(serialized.length / CH);
    if (n < 1 || n > 12) return false;   // >~1MB: no cachear (degradación al camino vivo)
    var obj = {}; obj[key + '_meta'] = String(n);
    for (var i = 0; i < n; i++) obj[key + '_' + i] = serialized.substr(i * CH, CH);
    cache.putAll(obj, ttl || 1800);
    return true;
  } catch (e) { return false; }
}

/** Reensambla el serialized desde los trozos. null si miss/expirado (cualquier trozo ausente).
 *  (port verbatim de _enr_docCacheGetChunked_, código-de-oro KMS signing-docs.gs) */
function _wzCacheGetChunked_(cache, key) {
  try {
    var meta = cache.get(key + '_meta');
    if (!meta) return null;
    var n = Number(meta); if (!n || n < 1) return null;
    var keys = []; for (var i = 0; i < n; i++) keys.push(key + '_' + i);
    var parts = cache.getAll(keys);
    var s = '';
    for (var j = 0; j < n; j++) { var p = parts[key + '_' + j]; if (p == null) return null; s += p; }
    return s;
  } catch (e) { return null; }
}

/**
 * WIZARD-CACHE — invalida hyd/adm del token tras CUALQUIER escritura del grupo
 * (NUNCA servir stale tras un write). Borrar la clave _meta basta: el get troceado
 * devuelve null sin meta. Los docs (PDFs del paquete, inmutables) no se invalidan
 * aquí — si el KMS regenera el paquete cambian los file_id (clave distinta).
 * @private
 */
function _wzCacheInvalidate_(resumeToken) {
  // V2.4: las claves ya no llevan token — la invalidación canónica es BUMPAR la
  // live_version del grupo (todas las entradas guardan v y una v vieja es MISS).
  // El gate del writer ya pobló el memo del token → resolver el grupo es ~0ms.
  try {
    if (!resumeToken) return;
    var gid = requireResumeTokenMemo_({ resume_token: String(resumeToken).trim() });
    if (gid) _bumpLiveStateVersion_(gid);
  } catch (e) { /* best-effort */ }
}

/**
 * WIZARD-CACHE — transporte en LOTE al KMS (UrlFetchApp.fetchAll): GAS no tiene fetch
 * paralelo entre llamadas kmsProxy_ secuenciales; fetchAll sí concurre los pulls de
 * documentos del warm. URL/bearer/envelope/parse VERBATIM de kmsProxy_ (mismo
 * contrato); SOLO lo usa el warm (best-effort: cualquier fallo → null en esa posición).
 * @param {Array<{action:string, payload:Object}>} calls
 * @returns {Array<Object|null>} data del KMS por posición (null si falló)
 * @private
 */
function _wzKmsFetchAll_(calls) {
  try {
    var props        = PropertiesService.getScriptProperties();
    var kmsUrl       = props.getProperty('KMS_DEPLOYMENT_URL');
    var serviceToken = props.getProperty('QB_SERVICE_TOKEN');
    if (!kmsUrl || !serviceToken || !calls || !calls.length) {
      return (calls || []).map(function() { return null; });
    }
    var bearer = ScriptApp.getOAuthToken();
    var reqs = calls.map(function(c) {
      return {
        url:                kmsUrl,
        method:             'post',
        contentType:        'text/plain',
        headers:            { Authorization: 'Bearer ' + bearer },
        payload:            JSON.stringify({
          action:    c.action,
          payload:   Object.assign({ service_token: serviceToken }, c.payload || {}),
          requestId: generateUuid_(),
        }),
        followRedirects:    true,
        muteHttpExceptions: true,
      };
    });
    _dbgEv_('kms_call_batch', calls.map(function(c) { return c.action; }).join(','));
    var tFA = Date.now();
    var resps = UrlFetchApp.fetchAll(reqs);
    _dbgEv_('kms_resp_batch', (Date.now() - tFA) + 'ms');
    return resps.map(function(r) {
      try {
        if (r.getResponseCode() !== 200) return null;
        var j = JSON.parse(r.getContentText());
        return (j && j.success === true) ? j.data : null;
      } catch (e) { return null; }
    });
  } catch (e) {
    Logger.log(redact_('[_wzKmsFetchAll_] non-fatal — ' + (e && e.message)));
    return (calls || []).map(function() { return null; });
  }
}

/**
 * WIZARD-CACHE — el corazón: con el resume_token NUEVO (post-rotación) trae del KMS y
 * cachea wizard-side, troceado, keyed por token:
 *   (a) hydrate completo (enr.wizardHydrate) → wz_hyd_<token>
 *   (b) admission (con versión liveState wizard-side) → wz_adm_<token>
 *   (c) bytes de cada member del paquete de firma (enr.serveSigningDocument, el KMS
 *       sirve de SU cache troceado en ~0,6s) → wz_doc_<token>_<file_id>
 *
 * Identidad warm = la de _enqueueWarmHydrate_ (recovered_email = email destino del
 * link; language) → misma clave de warm KMS que el click real (WARM-KEY-PARITY).
 * Members: lector probado del paso 10 — enr.initiateSigningSession con
 * create_only:true (initiateSigningSession_, identidad {signing_token} = rama (b) de
 * requireSignerIdentity_) devuelve members[{file_id,…}] SIN despachar envelope; N
 * dinámico (lo que el hito declare). signing_token: del signing_context._signer_row
 * del hydrate; fallback el lector probado del wizard resolveGuardianSigningContext_
 * (mismo camino que el lazy resolver de getDocument_).
 *
 * Best-effort TOTAL: cualquier fallo → log redactado y seguir (nunca peor que hoy).
 * NUNCA lanza. KAL-4: todo keyed por el token; el SERVIDO re-valida el token.
 *
 * @param {string} resumeToken    token NUEVO del magic-link recién enviado
 * @param {string} recoveredEmail email destino del link (identidad warm)
 * @param {string} lang
 * @returns {{ok:boolean, hydrate:boolean, admission:boolean, members:number, docs:number, ms:number}}
 * @private
 */
/**
 * V2.1 — fase HIJA 'res': pre-computa el payload de resumeSession (la hidratacion
 * de entrada del magic link, ~25-30s de lecturas wizard-side) con el MISMO lector
 * del camino vivo (buildResumeSessionData_, cero divergencia) y lo cachea
 * wz_res_<token>. skipPiiGate=true: el warm corre ANTES del click (sin step-up);
 * la ENTREGA al cliente sigue gateada en resumeSession_ (precedente #69).
 * @private
 */
function _warmResumePhase_(it) {
  var out = { ok: false, resume: false, ms: 0 };
  var t0 = Date.now();
  try {
    var token = String(it.t).trim();
    try { assertValidUuid_(token, 'resume_token'); } catch (eV) { return out; }
    var cache = CacheService.getScriptCache();
    var grpRows = appsheetRequest_(T.ENROLLMENT_GROUPS, 'Find', [], {
      Filter: '"resume_token" = "' + appsheetEscape_(token) + '"'
    }) || [];
    if (grpRows.length && !grpRows[0].abandoned_at) {
      var groupId = grpRows[0].enrollment_group_id;
      var resKey = _wzCacheKey_('res', groupId + '_' + _wzN_(it.n));
      if (cache.get(resKey + '_meta')) { out.ok = true; out.resume = true; return out; }
      try { cache.put('wzck_res_' + groupId + '_' + _wzN_(it.n), '1', 240); } catch (eMr) {}
      var resData = buildResumeSessionData_(grpRows[0],
        { resume_token: token, n: it.n || null, recovered_email: it.e || null },
        false, { skipPiiGate: true });
      if (resData && resData.pii_gated !== true) {
        out.resume = _wzCachePutChunked_(cache, resKey,
          JSON.stringify({ v: _getLiveStateVersion_(groupId), data: resData }), 1800);
      }
      try { cache.remove('wzck_res_' + groupId + '_' + _wzN_(it.n)); } catch (eMr2) {}
    }
    out.ok = true;
  } catch (e) {
    Logger.log(redact_('[_warmResumePhase_] non-fatal — ' + (e && e.message)));
  }
  out.ms = Date.now() - t0;
  Logger.log('[WZCACHE] warm res done ' + JSON.stringify(out));
  return out;
}

/**
 * V2.3 (log Diego 16:59 — initiateSigningRead 71,5s: el warm cocinaba members
 * DESPUÉS del hydrate y el usuario llegaba al paso 10 antes) — fase HIJA 'mem':
 * members + bytes del paquete SIN depender del hydrate. Identidad resuelta
 * wizard-side por el MISMO camino lazy de getDocument_ (effectiveRecoveredEmail_
 * → resolveGuardianForRecovery_ → resolveGuardianSigningContext_); pre-AD o sin
 * sesión → no-op limpio. Marca wzck_mem para el single-flight del vivo.
 * @private
 */
function _warmMembersDocsPhase_(it) {
  var out = { ok: false, members: 0, docs: 0, ms: 0 };
  var t0 = Date.now();
  var token = String(it.t || '').trim();
  var cache = CacheService.getScriptCache();
  try {
    try { assertValidUuid_(token, 'resume_token'); } catch (eV) { return out; }
    var groupId = requireResumeTokenMemo_({ resume_token: token });
    if (cache.get(_wzCacheKey_('mem', groupId) + '_meta')) { out.ok = true; return out; }
    try { cache.put('wzck_mem_' + groupId, '1', 240); } catch (eM) {}
    var effEmail = effectiveRecoveredEmail_(it.e || null, groupId, it.n || null);
    var guardianId = effEmail ? resolveGuardianForRecovery_(groupId, effEmail) : null;
    var sctx = guardianId ? resolveGuardianSigningContext_(groupId, guardianId) : null;
    var signingToken = (sctx && sctx.signing_token) || null;
    if (signingToken) {
      // V2.4.1 (gap de 24,5s en getDocument, _dbg Diego 17:33): cebar el memo del
      // token de firma (docsigntok_) — la MISMA clave que el resolver lazy de
      // getDocument_ — para que servir bytes no re-pague la cadena de identidad.
      try {
        cache.put('docsigntok_' + sha256Hex_(
          Utilities.newBlob(groupId + '|' + guardianId).getBytes()).slice(0, 40), signingToken, 300);
      } catch (eTk) { /* best-effort */ }
      var prep = kmsProxy_('enr.initiateSigningSession', { signing_token: signingToken, create_only: true }) || {};
      var members = prep.members || [];
      out.members = members.length;
      if (members.length) {
        _wzCachePutChunked_(cache, _wzCacheKey_('mem', groupId),
          JSON.stringify({ v: _getLiveStateVersion_(groupId), data: prep }), 1800);
        var pendientes = members.map(function(m) { return m && m.file_id; }).filter(Boolean)
          .filter(function(fid) { return !cache.get(_wzCacheKey_('doc', fid) + '_meta'); });
        if (pendientes.length) {
          var results = _wzKmsFetchAll_(pendientes.map(function(fid) {
            return { action: 'enr.serveSigningDocument', payload: { signing_token: signingToken, file_id: fid } };
          }));
          pendientes.forEach(function(fid, i) {
            var d = results[i];
            if (d && d.base64 && _wzCachePutChunked_(cache, _wzCacheKey_('doc', fid),
              JSON.stringify(Object.assign({ g: groupId }, d)), 21600)) out.docs++;
          });
        }
      }
    }
    out.ok = true;
  } catch (e) {
    Logger.log(redact_('[_warmMembersDocsPhase_] non-fatal — ' + (e && e.message)));
  }
  try { cache.remove('wzck_mem_' + (typeof groupId !== 'undefined' && groupId ? groupId : token)); } catch (eR) {}
  out.ms = Date.now() - t0;
  Logger.log('[WZCACHE] warm mem done ' + JSON.stringify(out));
  return out;
}

function warmEntryBundle_(resumeToken, recoveredEmail, lang, nParam, groupIdParam) {
  var out = { ok: false, hydrate: false, admission: false, resume: false, members: 0, docs: 0, ms: 0 };
  var t0 = Date.now();
  try {
    if (!resumeToken) return out;
    var token = String(resumeToken).trim();
    try { assertValidUuid_(token, 'resume_token'); } catch (eV) { return out; }
    var tPrev = token.slice(0, 8) + '…';
    var cache = CacheService.getScriptCache();
    // V2.4: claves estables — gid del caller (warmSession_ ya gateó) o memo.
    var gidW = groupIdParam || requireResumeTokenMemo_({ resume_token: token });
    var nW = _wzN_(nParam);
    // V2.2 single-flight: marca "cocinando" para que el camino vivo espere en vez
    // de competir. hyd cubre hydrate+admission; mem cubre members. Se retiran al
    // completar cada tramo (y caducan solos si esta ejecución muere).
    try { cache.put('wzck_hyd_' + gidW + '_' + nW, '1', 240); } catch (eM1) {}

    // (a) Hydrate completo → wz_hyd_<token>. El KMS tiene SU warm (L2) → pull barato
    //     si el job KMS corrió; si no, se paga UNA vez aquí (no en el click del usuario).
    var data = null;
    var cachedRaw = _wzCacheGetChunked_(cache, _wzCacheKey_('hyd', gidW + '_' + nW));
    if (cachedRaw) {
      try {
        var envH = JSON.parse(cachedRaw);
        if (envH && envH.v === _getLiveStateVersion_(gidW)) { data = envH.data; out.hydrate = true; }
      } catch (e) { data = null; }
    }
    if (!data) {
      var tH = Date.now();
      data = kmsProxy_('enr.wizardHydrate', {
        resume_token:    token,
        recovered_email: recoveredEmail || null,
        language:        lang || null,
      }) || {};
      out.hydrate = _wzCachePutChunked_(cache, _wzCacheKey_('hyd', gidW + '_' + nW),
        JSON.stringify({ v: _getLiveStateVersion_(gidW), data: data }), 1800);
      Logger.log('[WZCACHE] warm hyd token=' + tPrev + ' cached=' + out.hydrate + ' ms=' + (Date.now() - tH));
    }

    var groupId     = (data && data.group && data.group.enrollment_group_id) || null;
    var guardianPid = (data && data.recovered_guardian_person_id) || null;

    // (b) signing_token del guardian — del signing_context del hydrate (fila
    //     _signer_row, KMS wizard-datalayer.gs); fallback: lector probado del wizard
    //     resolveGuardianSigningContext_(groupId, guardianPid) (mismo camino que el
    //     lazy resolver de getDocument_). Pre-AD/sin sesión → null → sin docs (OK).
    var sctxH = (data && data.signing_context) || null;
    var signingToken = (sctxH && sctxH._signer_row && sctxH._signer_row.signing_token) || null;
    var sessionId    = (sctxH && sctxH.session_id) || null;
    var signerId     = (sctxH && sctxH.signer_id) || null;
    if (!signingToken && groupId && guardianPid) {
      try {
        var sctxW = resolveGuardianSigningContext_(groupId, guardianPid);
        if (sctxW && sctxW.signing_token) {
          signingToken = sctxW.signing_token;
          sessionId    = sctxW.session_id;
          signerId     = sctxW.signer_id;
        }
      } catch (eS) { /* pre-AD o sin sesión: nada que calentar */ }
    }

    // (c) admission → wz_adm_<token>, con la versión liveState WIZARD-side: el pulse
    //     getLiveStateVersion sigue gobernando el refresh (si la versión sube, el
    //     servido invalida y va al vivo). signing_context en la SHAPE del wizard
    //     (resolveGuardianSigningContext_: {signer_id, session_id, guardian_person_id,
    //     signing_token}) — paridad de contrato con getAdmissionState_ live.
    if (data && data.admission && groupId) {
      var admSrc = data.admission;
      var admEntry = {
        v: _getLiveStateVersion_(groupId),
        n: String(nParam || ''),
        admission: {
          state_code:        admSrc.state_code || null,
          state_label:       admSrc.state_label || null,
          signing_ready:     !!admSrc.signing_ready,
          signing_status:    admSrc.signing_status || null,
          signing_available: !!admSrc.signing_available,
          signing_context:   (signingToken && guardianPid) ? {
            signer_id:          signerId || null,
            session_id:         sessionId || null,
            guardian_person_id: guardianPid,
            signing_token:      signingToken,
          } : null,
          editable:          !!admSrc.editable,
        },
      };
      out.admission = _wzCachePutChunked_(cache, _wzCacheKey_('adm', gidW + '_' + nW), JSON.stringify(admEntry), 1800);
    }
    try { cache.remove('wzck_hyd_' + gidW + '_' + nW); } catch (eM2) {}
    try { cache.put('wzck_mem_' + gidW, '1', 240); } catch (eM3) {}

    // (d)+(e) members+docs: movidos a _warmMembersDocsPhase_ (fase hija propia,
    // V2.3 — el paso 10 no debe esperar al hydrate). Aquí solo si este caller
    // llegó con signingToken ya resuelto y la fase mem no corrió aún.
    if (signingToken && !cache.get(_wzCacheKey_('mem', gidW) + '_meta')) {
      var members = [];
      try {
        var prep = kmsProxy_('enr.initiateSigningSession', { signing_token: signingToken, create_only: true }) || {};
        members = prep.members || [];
        // SPEC-WIZ-WARMUP-V2 (2026-06-12): cachear la RESPUESTA create_only entera
        // (members/state) → el initiateSigningRead del Step 10 (45-48s e2e, #65)
        // sirve de aqui post-gates. SOLO la lectura create_only; el ACTO (initiate)
        // jamas toca cache (P222).
        if (prep && members.length && groupId) {
          _wzCachePutChunked_(cache, _wzCacheKey_('mem', gidW),
            JSON.stringify({ v: _getLiveStateVersion_(gidW), data: prep }), 1800);
        }
      } catch (eM) {
        Logger.log(redact_('[WZCACHE] warm members FALLÓ token=' + tPrev + ' — ' + (eM && eM.message)));
      }
      out.members = members.length;
      try { cache.remove('wzck_mem_' + token); } catch (eM4) {}

      var pendientes = [];
      members.forEach(function(m) {
        var fid = m && m.file_id;
        if (!fid) return;
        if (cache.get(_wzCacheKey_('doc', fid) + '_meta')) return; // ya caliente
        pendientes.push(fid);
      });
      if (pendientes.length) {
        var tD = Date.now();
        var results = _wzKmsFetchAll_(pendientes.map(function(fid) {
          return { action: 'enr.serveSigningDocument', payload: { signing_token: signingToken, file_id: fid } };
        }));
        pendientes.forEach(function(fid, i) {
          var d = results[i];
          if (d && d.base64) {
            if (_wzCachePutChunked_(cache, _wzCacheKey_('doc', fid),
              JSON.stringify(Object.assign({ g: gidW }, d)), 21600)) out.docs++;
          }
        });
        Logger.log('[WZCACHE] warm docs token=' + tPrev + ' pedidos=' + pendientes.length +
                   ' cacheados=' + out.docs + ' ms=' + (Date.now() - tD));
      }
    }
    out.ok = true;
  } catch (e) {
    // Best-effort TOTAL (KAL-11: redactado). Nunca peor que hoy.
    Logger.log(redact_('[warmEntryBundle_] non-fatal — ' + (e && e.message)));
  }
  try {
    var cM = CacheService.getScriptCache();
    if (typeof gidW !== 'undefined' && gidW) {
      cM.remove('wzck_hyd_' + gidW + '_' + (typeof nW !== 'undefined' ? nW : '-'));
      cM.remove('wzck_mem_' + gidW);
    }
  } catch (eM5) { /* best-effort */ }
  out.ms = Date.now() - t0;
  Logger.log('[WZCACHE] warm bundle done ' + JSON.stringify(out));
  return out;
}

/**
 * SPEC-WIZ-WARMUP-V2 (2026-06-12) — ticket de warm opaco para la auto-invocación
 * concurrente del wizard a su propio /exec. El frontend NUNCA conoce el resume_token
 * nuevo (viaja solo por email), así que sendMagicLink_/initEnrollmentSession_ mintean
 * este ticket single-use (TTL 300s) que mapea SERVER-SIDE a los items de warm
 * [{t: resume_token, n: email_id, e: email destino, l: lang}]. El ticket NO es un
 * bearer de datos: solo dispara el warm (warmBundle_ devuelve conteos, jamás PII ni
 * tokens). KAL-7: viaja en el body JSON de la respuesta, nunca en URL; KAL-11: no se
 * loguea entero. Best-effort: si el mint falla, null → sin kick (camino vivo intacto).
 * @param {Array<{t:string,n:?string,e:?string,l:?string}>} items
 * @returns {string|null} ticket UUID o null
 * @private
 */
function _mintWarmTicket_(items) {
  try {
    if (!items || !items.length) return null;
    var ticket = generateUuid_();
    CacheService.getScriptCache().put('wzwt_' + ticket, JSON.stringify(items), 300);
    return ticket;
  } catch (e) { return null; }
}

/**
 * STUB de compatibilidad del mecanismo V1 (trigger one-shot, RETIRADO por
 * SPEC-WIZ-WARMUP-V2 2026-06-12 — el trigger de GAS no garantizaba arranque a
 * tiempo; log real de Diego: getDocument 38-46s en frío pese al "warm"). El warm
 * vivo es la auto-invocación concurrente al action `warmBundle` (fire-and-forget
 * del frontend con ticket; la ejecución invocada sigue viva server-side aunque el
 * caller corte — verificado 2026-06-12). Este stub solo absorbe triggers residuales
 * pre-deploy (se autoborra y NO hace trabajo). Eliminar en un deploy futuro.
 */
function wizardWarmTrigger() {
  try {
    ScriptApp.getProjectTriggers().forEach(function(tr) {
      if (tr.getHandlerFunction && tr.getHandlerFunction() === 'wizardWarmTrigger') {
        try { ScriptApp.deleteTrigger(tr); } catch (eD) {}
      }
    });
  } catch (eT) { /* best-effort */ }
  try { CacheService.getScriptCache().remove('wz_warmq'); } catch (eC) { /* limpia la cola V1 */ }
}

// ─── Entry points ─────────────────────────────────────────────────────────────

/**
 * Health check endpoint.
 * @param {Object} e - GAS event object
 * @returns {TextOutput}
 */
function doGet(e) {
  const out = ContentService.createTextOutput(
    JSON.stringify({ status: 'ok', ts: new Date().toISOString() })
  ).setMimeType(ContentService.MimeType.JSON);
  return setCorsHeaders_(out);
}

/**
 * Main dispatcher. Routes on payload.action.
 * Rejects requests with a filled honeypot field.
 * @param {Object} e - GAS event object
 * @returns {TextOutput}
 */
function doPost(e) {
  try {
    const payload = JSON.parse(e.postData.contents);
    _dbgStart_(payload); // DBG-TRACE: cronología server-side si _dbg:true

    // Honeypot guard — bots fill hidden fields, humans don't
    if (payload._hp && payload._hp !== '') {
      return jsonResponse_({ ok: false, error: 'Forbidden' }, 403);
    }

    const action = payload.action;
    let result;

    switch (action) {
      // ── DL-E15 actions (new canonical names) ────────────────────────────────
      // Legacy names are kept as aliases for transitional frontend compatibility.
      case 'initApplication':         // legacy alias
      case 'initEnrollmentSession':   result = initEnrollmentSession_(payload);   break;

      case 'resumeApplication':       // legacy alias
      case 'resumeSession':           result = resumeSession_(payload);           break;

      // PERF: estado de admisión LIGERO para el pulse de firma (no relee el expediente).
      case 'getAdmissionState':       result = getAdmissionState_(payload);       break;

      case 'submitApplication':       // legacy alias
      case 'submitEnrollmentSession': result = submitEnrollmentSession_(payload); break;

      // ── Actions that keep their name (payload shape may have changed) ───────
      case 'sendMagicLink':        result = sendMagicLink_(payload);        break;
      case 'saveStep':             result = saveStep_(payload);             break;
      case 'sendVerificationCode': result = sendVerificationCode_(payload); break;
      case 'verifyEmail':          result = verifyEmail_(payload);          break;
      case 'fetchQuestions':       result = fetchQuestions_(payload);       break;
      case 'saveResponses':        result = saveResponses_(payload);        break;
      case 'uploadDocument':       result = uploadDocument_(payload);       break;
      // CLI 82 (KAL-NEW-5 / Anexo A Opción A): proxy de bytes. Sirve documentos
      // PRIVADOS de Drive bajo gate de token (resume_token O signing_token) +
      // guard IDOR de propiedad. Sustituye los enlaces públicos de Drive.
      case 'getDocument':          result = getDocument_(payload);          break;
      case 'verifyRecaptcha':      result = verifyRecaptcha_(payload);      break;
      case 'fetchLookups':         result = fetchLookups_(payload);         break;
      case 'recognizeFamily':      result = recognizeFamily_(payload);      break;
      case 'reportUnsolicited':    result = reportUnsolicited_(payload);    break;
      case 'abandonSession':       result = abandonSession_(payload);       break;
      case 'resolveSigningToken':  result = resolveSigningToken_(payload);  break;
      // P215 opción (b) ELIMINADA (CLI AD-SPLIT): el selector in-app de firmante
      // ('selectSigner' + signing_candidates) queda descartado por razón legal —
      // la identidad se deriva server-side por recovery link per-guardian (Vía 1).
      // ── CLI 40 (2026-06-02) — WS4 4 endpoints firma proxy a KMS (P118, HC-1) ──
      // PROXIES finos al KMS con service token (patrón fetchQuestions_).
      // GATE-D resuelto (proxy vs directa) → proxy. GATE-B modo conservador en
      // submitGdprConsents (un set por sesión, sin fan-out per-guardian).
      // Implementación en sección "WS4 — Wizard pre-firma proxies a KMS".
      case 'saveBillingInfo':         result = saveBillingInfo_(payload);         break;
      case 'getSavedBillingSplits':   result = getSavedBillingSplits_(payload);   break;
      case 'submitGdprConsents':      result = submitGdprConsents_(payload);      break;
      case 'confirmReview':           result = confirmReview_(payload);           break;
      case 'initiateSigningSession':  result = initiateSigningSession_(payload);  break;
      // WPERF-2 — puente event-driven de drenado de la cola KMS. Lo dispara un bot
      // AppSheet Automation (on-data-change sobre sys_JobQueue) vía 'Call a webhook' →
      // POST aquí con { _secret }. Gateado por Script Property DRAIN_SHARED_SECRET
      // (no-op silencioso si no coincide, NUNCA 403 — §funciones-debug). Reenvía a
      // kmsProxy_('sys.drainJobQueue') (el KMS es el worker; el wizard es el puente
      // autenticado porque el KMS es USER_ACCESSING y no acepta el webhook directo).
      case 'drainJobQueue':           result = drainJobQueue_(payload);           break;
      // ── DL-A — capa de datos del wizard (wizard-datalayer-spec §1/§2) ────────
      // hydrateSession: hidratación consolidada (1 llamada = todo). DL-B la consume.
      // notifyLiveStateChange: lo llama SOLO el KMS (gate WIZARD_NOTIFY_SECRET) → bumpa
      //   la versión liveState del grupo. getLiveStateVersion: cheap-poll (solo versión).
      case 'hydrateSession':          result = hydrateSession_(payload);          break;
      case 'warmSession':             result = warmSession_(payload);             break;
      // SPEC-WIZ-WARMUP-V2 — auto-invocación concurrente del precalentado (fire-and-
      // forget del frontend tras pedir magic link; ticket single-use o KAL-4 directo).
      case 'warmBundle':              result = warmBundle_(payload);              break;
      case 'notifyLiveStateChange':   result = notifyLiveStateChange_(payload);   break;
      case 'getLiveStateVersion':     result = getLiveStateVersion_(payload);     break;
      // ── CLI 60 (2026-05-30): cases borrados ─────────────────────────────────
      // getTrackingData, getInterviewForEnrollment, getAdmissionDecisionForEnrollment,
      // getReservationPaymentInfo, getSigningTokenFromResumeToken eliminados —
      // sus consumidores frontend (TrackApplicationPage, Step8Status, Step9Interview,
      // Step10Decision, Step12Deposit) fueron borrados por CLI 59 al corregir el
      // wizard a 11 steps canónicos.
      default:
        return jsonResponse_({ ok: false, error: 'Unknown action: ' + action }, 400);
    }

    const dbgB = _dbgBlock_();
    return jsonResponse_(dbgB ? { ok: true, ...result, _dbg: dbgB } : { ok: true, ...result });

  } catch (err) {
    // KAL-11: log full message internally with email/UUID redaction (Stackdriver interno).
    Logger.log('doPost error: ' + redact_(err.message) + '\nstack: ' + (err.stack || 'n/a'));
    // CLI 26 (2026-06-01) — structured error code for state-gate rejections
    // (NOT_EDITABLE, set by assertGroupEditable_). Per the silent-reject style:
    // HTTP 200 + { ok: false, error: { code, message } } — never 403 — so the
    // client always parses the response uniformly and reads `error.code`.
    // KAL-NEW-10: el `message` libre se SANITIZA (nunca exponer nombres de columna
    // AppSheet, file IDs, ni PII cruda); el `code` se conserva para el i18n del frontend.
    if (err && err.code) {
      return jsonResponse_({
        ok: false,
        error: { code: err.code, message: sanitizeErrorForClient_(err) }
      });
    }
    return jsonResponse_({ ok: false, error: sanitizeErrorForClient_(err) }, 500);
  }
}

// ─── Security helpers ─────────────────────────────────────────────────────────

/**
 * Rate-limit + abuse-report gate for any code path that sends a magic link
 * email. Two layers:
 *
 *   - HARD BLOCK: if an email has been reported as "unsolicited" via the
 *     reportUnsolicited action, all magic links to it are blocked for
 *     ~6 hours (ScriptCache TTL). The cache key 'magic_blocked_<email>' is
 *     set by reportUnsolicited_.
 *   - RATE LIMIT: max 3 sends / email / hour. Sliding window via
 *     ScriptCache counter ('magic_count_<email>'). The 4th send within the
 *     window throws and is not sent.
 *
 * Both checks use ScriptCache (not UserCache) because the caller may be
 * anonymous and we want the limit to apply across all sessions.
 *
 * Throws on block; caller may catch and decide whether to surface the
 * error or swallow it (responding 200 anyway to avoid leaking which emails
 * are blocked — anti-enumeration).
 *
 * @param {string} email - already lowercased + trimmed
 */
function _checkMagicLinkRateLimit_(email) {
  if (!email) return;
  const cache = CacheService.getScriptCache();
  const blockKey = 'magic_blocked_' + Utilities.base64EncodeWebSafe(email);
  if (cache.get(blockKey)) {
    const err = new Error('Magic link sending is temporarily blocked for this address');
    err.code = 'BLOCKED_BY_REPORT';
    throw err;
  }
  const countKey = 'magic_count_' + Utilities.base64EncodeWebSafe(email);
  const count = parseInt(cache.get(countKey) || '0', 10);
  // KAL-NEW-12: cap bajado de 10 → 5 (el JSDoc/doc decían 3-5; 10 era demasiado
  // permisivo). 5 deja margen para typos sin reabrir UX a abuso.
  if (count >= 5) {
    const err = new Error('Too many magic-link requests for this email; try again in 1 hour');
    err.code = 'RATE_LIMITED';
    throw err;
  }
  cache.put(countKey, String(count + 1), 3600); // 1h TTL — sliding within window
}

/**
 * KAL-NEW-13 (2026-06-06): rate-limit DEDICADO para los códigos OTP del step-up
 * (DL-E39), separado del bucket de magic-link.
 *
 * Antes, `sendVerificationCode_` (rama stepup) compartía el bucket
 * `magic_count_<email>` (cap 5/h) con el envío de magic-links. En una sesión real
 * la familia recupera por magic-link (consume 1-2) y luego pulsa "enviar código"
 * varias veces para revelar PII / firmar — agotando el cupo compartido en
 * segundos. El resultado: el OTP deja de enviarse (RATE_LIMITED) y el usuario
 * percibe "el código no llega". El step-up es una acción intra-sesión legítima y
 * frecuente; merece su propio cupo, más holgado, sin contaminar el bucket
 * anti-abuso de magic-link (que protege contra spam de enlaces a terceros).
 *
 * Bucket `stepup_count_<group>` cap 8/h, scoped al GRUPO (ya derivado del token,
 * KAL-4) — no al email — porque el destino siempre es el primary_email del grupo
 * y el group viene del bearer token, no es enumerable.
 *
 * @param {string} groupId - enrollment_group_id ya derivado del token.
 */
function _checkStepUpCodeRateLimit_(groupId) {
  if (!groupId) return;
  const cache = CacheService.getScriptCache();
  const countKey = 'stepup_count_' + groupId;
  const count = parseInt(cache.get(countKey) || '0', 10);
  if (count >= 8) {
    const err = new Error('Too many verification-code requests; try again in 1 hour');
    err.code = 'RATE_LIMITED';
    throw err;
  }
  cache.put(countKey, String(count + 1), 3600); // 1h TTL — sliding within window
}

/**
 * KAL-6 / KAL-NEW-12: rate-limit por-IP/global (complementa el límite por-email).
 * Bucket `magic_count_ip_<ip>` cap 20/hora.
 *
 * IMPORTANTE: GAS NO expone la IP del caller desde `doPost(e)`. Mientras no haya
 * una fuente de IP real (proxy frontal o header `X-Forwarded-For` propagado), este
 * helper recibe `null` y vuelve SIN tocar el cache (noop, sin throw) — queda visible
 * y listo para wire-up futuro. NO inventes una fuente de IP que no exista.
 *
 * @param {string|null} ip - IP del caller, o null si no disponible (noop).
 */
function _checkMagicLinkRateLimitIp_(ip) {
  if (!ip) return; // IP no disponible en GAS doPost — noop hasta que haya proxy/XFF.
  const cache = CacheService.getScriptCache();
  const countKey = 'magic_count_ip_' + Utilities.base64EncodeWebSafe(String(ip));
  const count = parseInt(cache.get(countKey) || '0', 10);
  if (count >= 20) {
    const err = new Error('Too many requests from this network; try again in 1 hour');
    err.code = 'RATE_LIMITED';
    throw err;
  }
  cache.put(countKey, String(count + 1), 3600); // 1h TTL
}

// ─── Action handlers ──────────────────────────────────────────────────────────

/**
 * Comparación de tiempo (aprox.) constante para secretos compartidos. GAS no
 * expone crypto.timingSafeEqual; aplicar HMAC-SHA256 a ambos lados con una
 * clave aleatoria per-llamada produce digests de longitud fija cuya comparación
 * byte-a-byte (sin early-exit) no filtra ni la longitud ni un prefijo común de
 * los inputs. (P226 / KAL-NEW-4 menor — side-channel irrelevante en red, cerrado
 * por completitud.)
 * @private
 */
function constantTimeEquals_(a, b) {
  if (a == null || b == null) return false;
  const key = Utilities.getUuid();
  const ha = Utilities.computeHmacSha256Signature(String(a), key);
  const hb = Utilities.computeHmacSha256Signature(String(b), key);
  let diff = ha.length ^ hb.length;
  for (let i = 0; i < ha.length && i < hb.length; i++) {
    diff |= ha[i] ^ hb[i];
  }
  return diff === 0;
}

/**
 * Creates a new enrollment session (header row in enrEnrollmentGroups) — DL-E15.
 *
 * Unlike the legacy initApplication_, this no longer inserts into enrEnrollments
 * (per-applicant rows). Those are created later by submitEnrollmentSession_, one
 * per applicant person captured in the wizard. The session header carries the
 * email, language, resume token, source and program reference.
 *
 * GDPR consent is captured visually on the consent page but the formal consent
 * record is deferred to submit time (when enrollments exist to attach it to).
 * This avoids the awkward "consent attached to a non-existent enrollment" case
 * during the staging period.
 *
 * source_code: defaults to 'WEB_PUBLIC' (anonymous web wizard). Staff
 * initiating a session from the KMS pass 'KMS_INTERNAL' (D-E16): the
 * session is still resumed by the family via magic link from their own
 * device, but the origin is recorded for downstream reporting and for
 * promoteEnrollment_'s isFamiliesApp branch behaviour. For 'KMS_INTERNAL'
 * the reCAPTCHA token is optional (staff is already authenticated upstream).
 *
 * @param {Object} p - { primary_email, preferred_language?, program_id?,
 *                       source_code?, recaptcha_token? }
 * @returns {{ enrollment_group_id: string, resume_token: string,
 *             application_id: string }} (application_id is a legacy alias = enrollment_group_id)
 */
function initEnrollmentSession_(p) {
  const sourceCode = (p.source_code || 'WEB_PUBLIC').toUpperCase();
  // P226 / KAL-NEW-4 (audit 2026-06-05, decisión Diego 2026-06-09): 'FAMILIES_APP'
  // QUITADO de VALID_SOURCES. El if/else if de abajo solo gatea KMS_INTERNAL (secret)
  // y WEB_PUBLIC (reCAPTCHA fail-closed); 'FAMILIES_APP' caía al default → creaba
  // sesión + magic-link SIN reCAPTCHA ni secret (bypass del gate anti-bot). No hay
  // app de familias usándolo hoy; cuando exista se reañade CON su propia auth.
  // Cualquier petición con source_code:'FAMILIES_APP' ya NO es un source válido →
  // rechazada aquí con el error estructurado BAD_REQUEST (no 403).
  const VALID_SOURCES = ['WEB_PUBLIC', 'KMS_INTERNAL'];
  if (VALID_SOURCES.indexOf(sourceCode) === -1) {
    // err.code → doPost devuelve HTTP 200 { ok:false, error:{code,message} }
    // (silent-reject estructurado P72, NUNCA 403/500 crudo). Antes sin code
    // caía al 500 genérico; un source inválido es un BAD_REQUEST del cliente.
    const err = new Error('Invalid source_code: ' + sourceCode);
    err.code = 'BAD_REQUEST';
    throw err;
  }

  // KAL-NEW-4 (audit 2026-05-30): reCAPTCHA fail-CLOSED + gate de KMS_INTERNAL.
  // El wizard es anónimo (access: ANYONE_ANONYMOUS) → cualquier caller de internet
  // podía pasar source_code:'KMS_INTERNAL' para saltar reCAPTCHA. Ahora:
  //  - KMS_INTERNAL exige un shared secret (Script Property KMS_INTERNAL_SHARED_SECRET);
  //    si no coincide → rechazo (NO degradar silenciosamente a bypass).
  //  - WEB_PUBLIC es fail-closed: exige RECAPTCHA_SECRET configurado (antes, si la
  //    Script Property faltaba, la validación se saltaba — fail-open).
  const secret = PropertiesService.getScriptProperties().getProperty('RECAPTCHA_SECRET');
  if (sourceCode === 'KMS_INTERNAL') {
    const expectedInternal = PropertiesService.getScriptProperties().getProperty('KMS_INTERNAL_SHARED_SECRET');
    if (!expectedInternal || !constantTimeEquals_(p.kms_internal_secret, expectedInternal)) {
      throw new Error('Unauthorized source_code: KMS_INTERNAL');
    }
  } else if (sourceCode === 'WEB_PUBLIC') {
    if (!secret) {
      const err = new Error('reCAPTCHA not configured — contact admin');
      err.code = 'RECAPTCHA_NOT_CONFIGURED';
      throw err;
    }
    if (!p.recaptcha_token) throw new Error('Missing reCAPTCHA token');
    const rcResult = verifyRecaptcha_({ token: p.recaptcha_token });
    if (!rcResult.pass) throw new Error('reCAPTCHA verification failed');
  }

  // ── Single-session policy (Diego decision 2026-05-18) ─────────────────────
  // ── Selection heuristic refined twice (2026-05-19):
  //      v1 — "oldest wins" (wrong: oldest is usually the stale empty one)
  //      v2 — "most-recently-updated wins" (wrong: recency != progress —
  //           a fresh empty session beats an older half-filled one)
  //      v3 — "most progressed wins" (current):
  //
  // Score each candidate session by enrPersons count (cheap proxy for
  // "passed Step 1 and captured applicants/guardians"). Tiebreak by
  // updated_at DESC. Why person count: the wizard's first non-trivial
  // step is Step 2 (persons); a session with 0 persons is essentially
  // "user clicked init and bounced". A session with N persons has clearly
  // crossed the threshold of real engagement, and more persons reflect
  // more sibling capture / more progress overall.
  //
  // Cost: one extra Find on enrPersons per init when N candidates > 1.
  // Cheap enough — typical N is 1 or 2.
  //
  // Effect on Diego's day-3-third-attempt scenario: a half-filled session
  // (more persons) beats a freshly-bounced session (zero persons)
  // regardless of which has the more recent updated_at.
  const normalizedEmail = (p.primary_email || '').toLowerCase().trim();
  // KAL-5: validate before concatenating into AppSheet Filter (defense in depth)
  assertValidEmail_(normalizedEmail, 'primary_email');

  // ── Guard: already-submitted sessions block re-submission ─────────────────
  // If the email already has a submitted (non-abandoned) session, return early
  // without creating a new session or sending another magic link.
  // The frontend renders a "ya enviada / already submitted" screen.
  const existingSubmitted = appsheetRequest_(T.ENROLLMENT_GROUPS, 'Find', [], {
    Filter: '"primary_email" = "' + appsheetEscape_(normalizedEmail) + '" && NOT(ISBLANK([submitted_at])) && ISBLANK([abandoned_at])'
  }) || [];
  if (existingSubmitted.length) {
    const grp = existingSubmitted[0];
    // Send a magic link so the family can view their submitted application in
    // read-only mode. Rate-limit is checked but errors are swallowed — the
    // already_submitted response is always returned regardless.
    let warmTicketSubmitted = null;
    try {
      _checkMagicLinkRateLimit_(normalizedEmail);
      const lang = grp.preferred_language || (p.preferred_language || 'es');
      // DL-E38 a1: send to the email the family typed (per-guardian). In the
      // init path the group was located by primary_email==normalizedEmail, so
      // these coincide; non-primary-guardian recovery is served by the magic-link
      // recovery service (sendMagicLink_ → findOpenGroupsByGuardianEmail_).
      // WIZARD-TERMINAL P3: contenido gobernado por el KMS.
      sendViaKmsNotify_('WIZARD_MAGIC_LINK', normalizedEmail, {
        family_name:      '',
        resume_url:       RESUME_BASE_URL + grp.resume_token,
        report_url:       REPORT_BASE_URL + grp.resume_token,
        gdpr_block:       _kmsRenderGdprBlock_(false),
        admissions_email: ADMISSIONS_EMAIL,
      });
      // SPEC-WIZ-WARMUP-V2: el usuario clicará el link en ~1 min — precalienta.
      warmTicketSubmitted = _mintWarmTicket_([{ t: grp.resume_token, n: null, e: normalizedEmail, l: lang }]);
    } catch (e) {
      Logger.log('initEnrollmentSession_: could not send magic link for submitted session: ' + e.message);
    }
    return {
      already_submitted:   true,
      enrollment_group_id: grp.enrollment_group_id,
      application_id:      grp.enrollment_group_id,
      warm_ticket:         warmTicketSubmitted,
    };
  }

  const existingOpen = appsheetRequest_(T.ENROLLMENT_GROUPS, 'Find', [], {
    Filter: '"primary_email" = "' + appsheetEscape_(normalizedEmail) + '" && ISBLANK([submitted_at]) && ISBLANK([abandoned_at])'
  }) || [];
  if (existingOpen.length) {
    _checkMagicLinkRateLimit_(normalizedEmail);
    _checkMagicLinkRateLimitIp_(null /* KAL-6: IP source pending — GAS no expone IP; noop */);

    // Resolve person counts for all candidates in ONE query (filtered by OR).
    let personCountByGroup = {};
    if (existingOpen.length > 1) {
      try {
        const ids = existingOpen.map(g => g.enrollment_group_id);
        ids.forEach(id => assertValidUuid_(id, 'enrollment_group_id'));
        const filter = ids.map(id => '"enrollment_group_id" = "' + appsheetEscape_(id) + '"').join(' || ');
        const personRows = appsheetRequest_(T.PERSONS, 'Find', [], { Filter: filter }) || [];
        personRows.forEach(pr => {
          const k = pr.enrollment_group_id;
          personCountByGroup[k] = (personCountByGroup[k] || 0) + 1;
        });
      } catch (e) {
        // If the person-count query fails, fall back to updated_at-only sort.
        // Logged so we know to investigate but doesn't block the re-send.
        Logger.log('initEnrollmentSession_: person count query failed (falling back to updated_at): ' + e.message);
      }
    }

    const sorted = existingOpen.slice().sort((a, b) => {
      const ac = personCountByGroup[a.enrollment_group_id] || 0;
      const bc = personCountByGroup[b.enrollment_group_id] || 0;
      if (bc !== ac) return bc - ac;
      const au = new Date(a.updated_at || a.created_at || 0).getTime();
      const bu = new Date(b.updated_at || b.created_at || 0).getTime();
      return bu - au;
    });
    const winner = sorted[0];
    const losers = sorted.slice(1);

    // Auto-abandon the losers (best-effort; failure to mark does not block the
    // re-send to the winner). They'll otherwise resurface on the next init and
    // need to be re-evaluated.
    const nowIso = new Date().toISOString();
    losers.forEach(loser => {
      try {
        appsheetRequest_(T.ENROLLMENT_GROUPS, 'Edit', [{
          enrollment_group_id: loser.enrollment_group_id,
          abandoned_at:        nowIso,
          updated_at:          nowIso,
        }]);
        // KAL-11: redact UUID + email.
        Logger.log(redact_('initEnrollmentSession_: auto-abandoned ' + loser.enrollment_group_id +
                   ' (lower-progress parallel session for ' + normalizedEmail +
                   '; person_count=' + (personCountByGroup[loser.enrollment_group_id] || 0) + ')'));
      } catch (e) {
        Logger.log(redact_('initEnrollmentSession_: failed to auto-abandon ' + loser.enrollment_group_id + ': ' + e.message));
      }
    });
    const lang = winner.preferred_language || (p.preferred_language || 'es');
    // DL-E38 a1: send to the email the family typed (per-guardian); coincides with
    // winner.primary_email in the init path (group located by primary_email).
    // WIZARD-TERMINAL P3: contenido gobernado por el KMS.
    sendViaKmsNotify_('WIZARD_MAGIC_LINK', normalizedEmail, {
      family_name:      '',
      resume_url:       RESUME_BASE_URL + winner.resume_token,
      report_url:       REPORT_BASE_URL + winner.resume_token,
      gdpr_block:       _kmsRenderGdprBlock_(false),
      admissions_email: ADMISSIONS_EMAIL,
    });
    return {
      resumed:             true,
      count:               1,                // post-abandon: only the winner remains addressable
      abandoned_count:     losers.length,    // for frontend telemetry / debug
      enrollment_group_id: winner.enrollment_group_id,
      application_id:      winner.enrollment_group_id, // legacy alias
      // SPEC-WIZ-WARMUP-V2: precalienta el grupo superviviente para el click del link.
      warm_ticket:         _mintWarmTicket_([{ t: winner.resume_token, n: null, e: normalizedEmail, l: lang }]),
    };
  }

  const enrollmentGroupId = generateUuid_();
  const resumeToken       = generateUuid_();
  const now               = new Date().toISOString();
  const lang              = p.preferred_language || 'es';

  // ── Resolve source_id from enrEnrollmentSources (Capa 2 catalog) ───────────
  // sourceCode is already whitelist-validated above against VALID_SOURCES; escape
  // applied as defense in depth (KAL-5).
  let sourceId = null;
  try {
    const sources = appsheetRequest_(T.ENROLLMENT_SOURCES, 'Find', [], {
      Filter: '"source_code" = "' + appsheetEscape_(sourceCode) + '"'
    });
    if (sources && sources[0]) sourceId = sources[0].source_id;
  } catch (e) {
    // Non-fatal: source_id stays null if catalog not yet seeded
    Logger.log('initEnrollmentSession_: enrEnrollmentSources lookup failed: ' + e.message);
  }

  // ── Resolve program_id ─────────────────────────────────────────────────────
  // If the frontend supplied program_id, trust it. Otherwise resolve the active
  // ADMISSION_SCHOOL program for this tenant. If none exists yet, programId
  // stays null and the wizard proceeds — operationally Diego must seed an
  // active program in enrPrograms before the school goes live.
  let programId = p.program_id || null;
  if (!programId) {
    try {
      const programs = appsheetRequest_(T.PROGRAMS, 'Find', [], {
        Filter: '"school_id" = "' + appsheetEscape_(SCHOOL_ID) + '" && "program_type_code" = "ADMISSION_SCHOOL" && ISBLANK([deleted_at])'
      });
      if (programs && programs.length) programId = programs[0].program_id;
    } catch (e) {
      Logger.log('initEnrollmentSession_: enrPrograms lookup failed: ' + e.message);
    }
  }

  appsheetRequest_(T.ENROLLMENT_GROUPS, 'Add', [{
    enrollment_group_id:    enrollmentGroupId,
    school_id:              SCHOOL_ID,
    program_id:             programId,
    source_id:              sourceId,
    requester_person_table: null,  // resolved at submit when guardians are known
    requester_person_id:    null,
    primary_email:          p.primary_email,
    preferred_language:     lang,
    resume_token:           resumeToken,
    magic_link_token:       null,
    submitted_at:           null,
    desired_start_date:     null,  // staged here at saveStep('application'); propagated to enrEnrollments at submit
    source_locale:          lang,
    created_at:             now,
    updated_at:             now,
  }]);

  // NOTE: GDPR consent record is intentionally deferred to submit time.
  // At init we have no enrEnrollments to attach the consent to, and the
  // post-DL-S44 polymorphic sysConsentsLog is not yet wired here. The frontend
  // still shows and requires the consent checkbox; the audit-trail row is
  // created when submitEnrollmentSession_ runs, one consent per enrollment.

  // Rate-limit + abuse-report gate. Run BEFORE actually sending.
  // Throws on block — propagates to the doPost handler which returns 4xx.
  // Note: the session header row above was already inserted (we have an
  // enrollment_group_id). Throwing here leaves an orphan row, but the
  // resume_token is never delivered to the attacker so it is effectively
  // unreachable. Acceptable trade-off.
  _checkMagicLinkRateLimit_((p.primary_email || '').toLowerCase().trim());
  // WIZARD-TERMINAL P3: contenido gobernado por el KMS. Init de la 1ª solicitud →
  // isFirstApp true (muestra el bloque GDPR).
  sendViaKmsNotify_('WIZARD_MAGIC_LINK', p.primary_email, {
    family_name:      '',
    resume_url:       RESUME_BASE_URL + resumeToken,
    report_url:       REPORT_BASE_URL + resumeToken,
    gdpr_block:       _kmsRenderGdprBlock_(true),
    admissions_email: ADMISSIONS_EMAIL,
  });
  // NOTA (WIZARD-TERMINAL): el aviso interno "nueva sesión iniciada" + el de
  // "magic-link no solicitado" siguen por el path local (sendInternalEmail_) porque NO
  // están entre las 4 plantillas canónicas del KMS (WIZARD_INTERNAL_NOTIFICATION = submit).
  // Migrarlos requiere 2 plantillas KMS nuevas (fuera del alcance nombrado) — ver reporte.
  sendInternalEmail_(
    '[KIS Admissions] New enrollment session started',
    buildApplicationInitiatedBody_(enrollmentGroupId, p.primary_email, now)
  );

  // D-E18: recognize legacy families by email against personalData_S.
  // Non-fatal — if the lookup fails, recognition is empty and the wizard
  // proceeds as a fresh family. Internal call: skips reCAPTCHA (the init
  // call already burned the token) but inherits the rate limit.
  let recognition = { matched: false, persons: [] };
  try {
    recognition = recognizeFamily_({ primary_email: p.primary_email }, { internal: true });
  } catch (e) {
    Logger.log('initEnrollmentSession_: recognizeFamily_ failed (non-fatal): ' + e.message);
  }

  return {
    enrollment_group_id: enrollmentGroupId,
    resume_token:        resumeToken,
    source_code:         sourceCode,
    recognition:         recognition,
    // legacy alias for frontends that still read `application_id`
    application_id:      enrollmentGroupId,
  };
}

/**
 * D-E18: recognize whether a primary_email belongs to a family already
 * present in personalData_S (the SMS canonical person catalog).
 *
 * The wizard's GAS cannot reach the KMS (the KMS keeps executeAs:
 * USER_ACCESSING + access: DOMAIN — staff-only, no anonymous calls). So
 * the lookup is done here directly against AppSheet, against the same
 * tables the KMS reads. Stage 2 (Postgres) will collapse this to a
 * single SQL view shared by both apps; until then the duplication is
 * small (~30 lines).
 *
 * Resolution chain (mirrors kms-server/sys/admin.gs::sys_getAuthContext):
 *   email (lowercased, trimmed)
 *     → contactEmails.email
 *     → personalData_S.personal_id
 *
 * Returns only display fields (personal_id, first_name, last_name) — no
 * addresses, relations, or children. The wizard's Step2 banner uses these
 * to pre-fill the first guardian; accepting the match stamps personal_id
 * on the enrPersons row, which later drives the dedup branch in
 * promoteEnrollment_ for FAMILIES_APP migrations.
 *
 * Protection against bot enumeration of personalData_S:
 *   - reCAPTCHA v3 token required on every public call (same RECAPTCHA_SECRET
 *     Script Property used by initEnrollmentSession_)
 *   - Per-email rate limit: 5 lookups / minute via CacheService
 *
 * Internal callers (initEnrollmentSession_) pass { internal: true } as
 * the second argument — the reCAPTCHA token was already consumed by the
 * init call so it cannot be reused here. The rate limit still applies.
 *
 * @param {{ primary_email: string, recaptcha_token?: string }} p
 * @param {{ internal?: boolean }} [opts]
 * @returns {{ matched: boolean, persons: Array<{ personal_id: string, first_name: string, last_name: string }> }}
 */
function recognizeFamily_(p, opts) {
  const internal = !!(opts && opts.internal);
  const email = (p && p.primary_email || '').toString().toLowerCase().trim();
  if (!email) throw new Error('Missing primary_email');

  // ── reCAPTCHA gate for public calls (KAL-NEW-4: fail-CLOSED) ──────────────
  // Antes era fail-open (`if (secret)`): sin RECAPTCHA_SECRET la validación se
  // saltaba. Ahora el caller público exige el secret configurado. El call interno
  // (opts.internal — la familia ya pasó reCAPTCHA en init) sigue exento.
  if (!internal) {
    const secret = PropertiesService.getScriptProperties().getProperty('RECAPTCHA_SECRET');
    if (!secret) {
      const err = new Error('reCAPTCHA not configured — contact admin');
      err.code = 'RECAPTCHA_NOT_CONFIGURED';
      throw err;
    }
    if (!p.recaptcha_token) throw new Error('Missing reCAPTCHA token');
    const rc = verifyRecaptcha_({ token: p.recaptcha_token });
    if (!rc.pass) throw new Error('reCAPTCHA verification failed');
  }

  // ── Rate limit: 5/min per email (applies to internal and external) ─────────
  const cacheKey = 'recognize_' + Utilities.base64EncodeWebSafe(email);
  const cache = CacheService.getScriptCache();
  const count = parseInt(cache.get(cacheKey) || '0', 10);
  if (count >= 5) {
    throw new Error('Too many recognition queries for this email; try again in 1 minute');
  }
  cache.put(cacheKey, String(count + 1), 60);

  // ── email → contactEmails.personal_ids ─────────────────────────────────────
  // KAL-5: strict email-shape validation + AppSheet escape (defense in depth).
  // Previous implementation only stripped quotes — defective because it
  // silently accepted broken inputs and bypassed any later validation.
  assertValidEmail_(email, 'email');
  const emailRows = appsheetRequest_('contactEmails', 'Find', [], {
    Filter: '"email" = "' + appsheetEscape_(email) + '"'
  }) || [];

  const personalIds = emailRows
    .map(r => r.personal_id)
    .filter((id, i, arr) => id && arr.indexOf(id) === i);

  // KAL-10 (anti-enumeration): public callers receive a constant shape that
  // does NOT distinguish "matched" from "not matched". The dispatched public
  // endpoint sees only `{ matched: false, persons: [] }` regardless of the
  // actual lookup result. An attacker brute-forcing emails through the
  // public `recognizeFamily` action cannot tell which addresses belong to
  // an existing Kaleide family.
  //
  // The internal call from initEnrollmentSession_ (opts.internal === true)
  // still receives the real `{matched, persons[]}` payload because the
  // caller is already an authenticated session-creation flow: the family
  // explicitly typed that email into the wizard and we want to offer the
  // "we recognised you — prefill?" banner on Step 2. The recognition data
  // never leaves the backend except in the initEnrollmentSession response,
  // which only the family that just provided the email can see (and they
  // already know it).
  if (!personalIds.length) {
    return { matched: false, persons: [] };
  }

  // ── personal_ids → personalData_S display fields ───────────────────────────
  personalIds.forEach(id => assertValidUuid_(id, 'personal_id'));
  const filter = personalIds.map(id => '"personal_id" = "' + appsheetEscape_(id) + '"').join(' || ');
  const persons = appsheetRequest_('personalData_S', 'Find', [], { Filter: filter }) || [];

  // Public callers: silent ack, identical shape to "no match" — anti-enum.
  if (!internal) {
    return { matched: false, persons: [] };
  }

  return {
    matched: persons.length > 0,
    persons: persons.map(row => ({
      personal_id: row.personal_id,
      first_name:  row.first_name || '',
      last_name:   row.last_name  || '',
    })),
  };
}

/**
 * IDENTITY-FROM-LINK (2026-06-11) — resuelve el email del guardian que recupera A PARTIR
 * DEL PROPIO ENLACE, usando SOLO datos existentes: el parámetro `n` del magic link, que
 * desde ahora lleva el `email_id` (PK de la fila `enrEmails` del guardian al que se emitió
 * el link). El `email_id` es OPACO, sin PII, y YA EXISTE en la BD — cero columna nueva,
 * cero tabla nueva, cero almacenamiento nuevo.
 *
 * Modelo canónico de Diego (LA regla, cita literal — corrección de rumbo 2026-06-11):
 *   "Tienes herramientas y datos suficientes para resolver la identidad sabiendo el
 *    email con el que se solicita el link. No pienso crear un campo que solo sirve a
 *    uno de los tipos de programa."
 *
 * Esto SUPERSEDE el enfoque IDENTITY-BINDING (columna dedicada `recovery_guardian_email`,
 * vetado por Diego: específico de un tipo de programa). El `email_id` sirve a TODO tipo
 * de programa porque es un dato transversal del modelo de personas/emails.
 *
 * SEGURIDAD (KAL-4 / KAL-5):
 *  - `n` (email_id) JAMÁS se cree a ciegas: se lee la fila real `enrEmails[email_id=n]` y
 *    se VALIDA server-side que (a) pertenece al `enrollment_group_id` del resume_token
 *    (KAL-4 — el grupo SIEMPRE del token, nunca del payload) y (b) su persona es un
 *    guardian del grupo (o el fallback requester del email de creación, ya existente).
 *  - assertValidUuid_ + appsheetEscape_ (KAL-5 doble capa) antes de concatenar en el Filter.
 *  - Devuelve el VALUE (email) de la fila → alimenta `recovered_email` exactamente como el
 *    contrato del KMS espera (matchea por email). CERO cambio KMS.
 *  - Si `n` está ausente, malformado, no pertenece al grupo, o no resuelve a guardian →
 *    null limpio → el flujo degrada al modelo group-scoped intacto (sin gracia de identidad).
 *
 * @param {string} groupId   enrollment_group_id (DERIVADO del resume_token, KAL-4)
 * @param {string} nParam    p.n del payload (email_id candidato, de la URL del link)
 * @param {Array}  [emailsHint]  filas enrEmails del grupo ya leídas (evita re-Find)
 * @param {Array}  [personsHint] filas enrPersons del grupo ya leídas (evita re-Find)
 * @param {Object} [groupHint]   fila de grupo ya leída (para el fallback requester)
 * @returns {string|null} email (lowercased) del guardian, o null (degrada group-scoped)
 */
function resolveEmailFromLinkParam_(groupId, nParam, emailsHint, personsHint, groupHint) {
  if (!nParam) return null;
  var emailId;
  try {
    assertValidUuid_(nParam, 'n_email_id');
    emailId = String(nParam).trim();
  } catch (e) {
    return null; // `n` no es un email_id → ignorar limpio (degrada group-scoped)
  }
  try {
    assertValidUuid_(groupId, 'enrollment_group_id');
  } catch (e) {
    return null;
  }
  // Leer la fila enrEmails por su PK (email_id). KAL-5: assertValidUuid_ (arriba) +
  // appsheetEscape_ (aquí). Preferir el hint del batch del caller; si no, Find dirigido.
  var row = null;
  if (Array.isArray(emailsHint)) {
    row = emailsHint.find(function(e) { return e && e.email_id === emailId; }) || null;
  }
  if (!row) {
    var rows = appsheetRequest_(T.EMAILS, 'Find', [], {
      Filter: '"email_id" = "' + appsheetEscape_(emailId) + '"'
    }) || [];
    row = rows[0] || null;
  }
  if (!row) {
    Logger.log(redact_('[resolveEmailFromLinkParam_] email_id no existe n=' + emailId.slice(0, 8) + '… group=' + groupId));
    return null;
  }
  // KAL-4: la fila DEBE pertenecer al grupo del token. Sin esto, un email_id de OTRO
  // grupo (enumeración) resolvería identidad ajena.
  if (String(row.enrollment_group_id || '') !== String(groupId)) {
    Logger.log(redact_('[resolveEmailFromLinkParam_] email_id de OTRO grupo (rechazado) n=' + emailId.slice(0, 8) + '… group=' + groupId));
    return null;
  }
  var email = String(row.value || '').toLowerCase().trim();
  if (!email) return null;
  // VALIDAR que el email resuelve a un guardian del grupo (o el fallback requester del
  // email de creación) — reutiliza el resolver probado. Si no resuelve, no concedemos
  // identidad (group-scoped intacto).
  var guardianId = resolveGuardianForRecovery_(groupId, email, emailsHint, personsHint, groupHint);
  if (!guardianId) {
    Logger.log(redact_('[resolveEmailFromLinkParam_] email no resuelve a guardian (rechazado) n=' + emailId.slice(0, 8) + '… group=' + groupId));
    return null;
  }
  Logger.log(redact_('[resolveEmailFromLinkParam_] n→email→guardian OK n=' + emailId.slice(0, 8) + '… group=' + groupId));
  return email;
}

/**
 * IDENTITY-FROM-LINK (2026-06-11) — email de recuperación EFECTIVO para una resolución
 * de identidad. Precedencia (prioridad `n` > recovered_email):
 *   1. `nParam` (email_id del enlace) → email del guardian resuelto SERVER-SIDE contra BD
 *      (resolveEmailFromLinkParam_). Es la vía canónica: la identidad viaja en el enlace.
 *   2. `clientRecoveredEmail` del payload (compat secundario — F5/sessionStorage; respetado
 *      pero ya NO es la red de seguridad principal).
 * Devuelve null si ninguno aplica (→ degrada al modelo group-scoped intacto).
 *
 * @param {string|null} clientRecoveredEmail  p.recovered_email (puede faltar)
 * @param {string} groupId                    enrollment_group_id (derivado del token, KAL-4)
 * @param {string|null} nParam                p.n del payload (email_id del enlace)
 * @param {Array}  [emailsHint]               filas enrEmails del grupo ya leídas
 * @param {Array}  [personsHint]              filas enrPersons del grupo ya leídas
 * @param {Object} [groupHint]                fila de grupo ya leída
 * @returns {string|null}
 */
function effectiveRecoveredEmail_(clientRecoveredEmail, groupId, nParam, emailsHint, personsHint, groupHint) {
  // 1. Prioridad: identidad DEL ENLACE (`n` = email_id) resuelta server-side.
  var fromLink = resolveEmailFromLinkParam_(groupId, nParam, emailsHint, personsHint, groupHint);
  if (fromLink) return fromLink;
  // 2. Compat secundario: recovered_email del cliente (sessionStorage), si viene.
  if (clientRecoveredEmail) {
    try {
      assertValidEmail_(clientRecoveredEmail, 'recovered_email');
      return String(clientRecoveredEmail).toLowerCase().trim();
    } catch (e) { /* malformado → null, cae al fallback 3 */ }
  }
  // 3. FALLBACK CANÓNICO "identidad = solicitud + email" (Diego: la identidad NO PUEDE
  //    FALTAR POR CONSTRUCCIÓN). Si la sesión entra solo con el resume_token —recarga de
  //    una pestaña con token viejo, sin `n` ni recovered_email del cliente (log real de
  //    Diego 20:40: UNAUTHORIZED "falta n del enlace o recovered_email" pese a hidratar
  //    los datos)— la SOLICITUD conoce el email de su solicitante: `primary_email` es el
  //    ARTEFACTO Stage-1 = email personal del tutor 1 (el que creó la solicitud). Es el
  //    guardian por defecto canónico de una recuperación group-scoped sin discriminador.
  //    KAL-4: el groupId viene SIEMPRE del token (server-side); primary_email se lee de
  //    la fila de ESE grupo, jamás del payload. El `n` sigue teniendo prioridad cuando
  //    existe (firma per-guardian intacta); esto solo cubre el hueco "sin discriminador".
  try {
    var grow = groupHint;
    if (!grow && groupId) {
      var grows = appsheetRequest_(T.ENROLLMENT_GROUPS, 'Find', [], {
        Filter: '"enrollment_group_id" = "' + appsheetEscape_(groupId) + '"'
      }) || [];
      grow = grows.length ? grows[0] : null;
    }
    var pe = grow && grow.primary_email ? String(grow.primary_email).toLowerCase().trim() : '';
    if (pe) {
      try { assertValidEmail_(pe, 'primary_email'); return pe; }
      catch (e2) { /* primary_email malformado → null */ }
    }
  } catch (e3) { /* lectura falló → null (group-scoped, comportamiento previo) */ }
  return null;
}

/**
 * IDENTITY-FROM-LINK (2026-06-11) — localiza el `email_id` (PK de enrEmails) de la fila
 * del email DENTRO del grupo, para meterlo en el `n` del magic link. Es el dato opaco,
 * sin PII y ya existente que resuelve la identidad del guardian al recuperar (espejo
 * inverso de resolveEmailFromLinkParam_). KAL-5: assertValidUuid_ + assertValidEmail_ +
 * appsheetEscape_. Devuelve null si no hay match (→ `n` ausente → group-scoped intacto).
 *
 * @param {string} groupId enrollment_group_id (server-side)
 * @param {string} email   email del guardian destino (lowercased)
 * @returns {string|null} email_id (UUID) o null
 * @private
 */
function findEmailIdForGuardian_(groupId, email, emailsHint) {
  if (!groupId || !email) return null;
  var emailLc;
  try {
    assertValidUuid_(groupId, 'enrollment_group_id');
    assertValidEmail_(email, 'guardian_email');
    emailLc = String(email).toLowerCase().trim();
  } catch (e) {
    return null;
  }
  try {
    // PERF sendMagicLink (2026-06-12): emailsHint = filas enrEmails del MISMO grupo
    // ya bajadas por el caller (mismo filtro que abajo) — evita un Find serial.
    var rows = Array.isArray(emailsHint) ? emailsHint
      : appsheetRequest_(T.EMAILS, 'Find', [], {
          Filter: '"enrollment_group_id" = "' + appsheetEscape_(groupId) + '"'
        }) || [];
    var match = rows.find(function(r) {
      return r && String(r.value || '').toLowerCase().trim() === emailLc && r.email_id;
    });
    return match ? String(match.email_id) : null;
  } catch (e) {
    return null;
  }
}

/**
 * Resends magic link for an existing enrollment session.
 *
 * DL-E15: queries enrEnrollmentGroups (the session header) — primary_email,
 * preferred_language and resume_token now live there, not on enrEnrollments.
 *
 * Accepts the legacy `application_id` payload key as an alias for
 * `enrollment_group_id` so older frontend builds continue to work.
 *
 * @param {Object} p - { enrollment_group_id? | application_id? } or { primary_email }
 */
function sendMagicLink_(p) {
  const groupId = p.enrollment_group_id || p.application_id;

  if (groupId) {
    // Single-session link (e.g. from within the wizard)
    assertValidUuid_(groupId, 'enrollment_group_id');
    const rows = appsheetRequest_(T.ENROLLMENT_GROUPS, 'Find', [], {
      Filter: '"enrollment_group_id" = "' + appsheetEscape_(groupId) + '"'
    });
    const grp = rows && rows[0];
    if (!grp) throw new Error('Enrollment group not found');
    if (grp.abandoned_at) throw new Error('This application was abandoned');
    // DL-E38 a1: per-guardian destination — if the family is recovering with a
    // specific guardian email (matched server-side against enrEmails of the
    // group), send the link to THAT guardian; else fallback to the group
    // primary_email (GAP-2 / pre-Step-2). KAL-4: groupId derived from token-path
    // caller, recovered_email only ever a discriminator validated against real rows.
    let destEmail = grp.primary_email;
    let identityEmail = null; // IDENTITY-FROM-LINK: email del guardian destino (si resuelve)
    // PERF sendMagicLink (2026-06-12): UN batch paralelo de emails+persons del grupo
    // como hints de los 2 resolveGuardianForRecovery_ + findEmailIdForGuardian_
    // (antes: hasta 3 Finds SERIALES de las mismas tablas, ~3-5s cada uno).
    const grpIdEsc = appsheetEscape_(grp.enrollment_group_id);
    const hintRead = appsheetRequestBatch_([
      { table: T.EMAILS,  action: 'Find', selector: { Filter: '"enrollment_group_id" = "' + grpIdEsc + '"' } },
      { table: T.PERSONS, action: 'Find', selector: { Filter: '"enrollment_group_id" = "' + grpIdEsc + '"' } },
    ]);
    const emailsHint  = hintRead[0].ok ? (hintRead[0].data || []) : null;
    const personsHint = hintRead[1].ok ? (hintRead[1].data || []) : null;
    if (p.recovered_email && resolveGuardianForRecovery_(grp.enrollment_group_id, p.recovered_email, emailsHint, personsHint, grp)) {
      destEmail = String(p.recovered_email).toLowerCase().trim();
      identityEmail = destEmail;
    } else if (resolveGuardianForRecovery_(grp.enrollment_group_id, grp.primary_email, emailsHint, personsHint, grp)) {
      // Sin recovered_email explícito: si el primary_email resuelve a un guardian
      // (caso tutor-1 / artefacto Stage-1), ese es el guardian del enlace.
      identityEmail = String(grp.primary_email || '').toLowerCase().trim();
    }
    _checkMagicLinkRateLimit_((destEmail || '').toLowerCase().trim());
    _checkMagicLinkRateLimitIp_(null /* KAL-6: IP source pending — GAS no expone IP; noop */);

    // Renew token + created_at for non-submitted sessions so the new link is
    // always valid for a fresh 7-day window regardless of when the session was
    // originally created. Also invalidates any previously sent magic links.
    let tokenToSend = grp.resume_token;
    if (!grp.submitted_at) {
      const nowIso   = new Date().toISOString();
      const newToken = generateUuid_();
      appsheetRequest_(T.ENROLLMENT_GROUPS, 'Edit', [{
        enrollment_group_id: grp.enrollment_group_id,
        resume_token:        newToken,
        created_at:          nowIso,
        updated_at:          nowIso,
      }]);
      tokenToSend = newToken;
      // KAL-11: redact group_id UUID before persisting to Stackdriver.
      Logger.log(redact_('sendMagicLink_: renewed token for group ' + grp.enrollment_group_id));
    }

    // IDENTITY-FROM-LINK (2026-06-11): `n` := email_id de la fila enrEmails del guardian
    // destino (opaco, sin PII, ya existe). La identidad viaja EN EL ENLACE; cero columna.
    // Si el email no resuelve a un email_id de guardian (group-scoped legacy) → n null.
    const nEmailId = findEmailIdForGuardian_(grp.enrollment_group_id, identityEmail, emailsHint);
    // Gracia OTP-skip anclada al resume_token recién rotado (single-use, 10 min).
    _mintMagicLinkNonce_(tokenToSend, grp.enrollment_group_id);
    const langP1 = grp.preferred_language || 'es';
    // WIZARD-TERMINAL P3: el contenido lo gobierna el KMS. Path 1 (single session, p.ej.
    // desde dentro del wizard) → isFirstApp false (sin bloque GDPR).
    const resumeUrlP1 = RESUME_BASE_URL + tokenToSend + (nEmailId ? '?n=' + nEmailId : '');
    sendViaKmsNotify_('WIZARD_MAGIC_LINK', destEmail, {
      family_name:      '',
      resume_url:       resumeUrlP1,
      report_url:       REPORT_BASE_URL + tokenToSend,
      gdpr_block:       _kmsRenderGdprBlock_(false),
      admissions_email: ADMISSIONS_EMAIL,
    });
    // SPEC-WIZ-WARMUP-V2: ticket para que el frontend dispare warmBundle fire-and-forget
    // con el token NUEVO (que solo viaja por email). Identidad warm = la del click real.
    return { sent: true, warm_ticket: _mintWarmTicket_([{ t: tokenToSend, n: nEmailId, e: destEmail, l: langP1 }]) };
  } else if (p.primary_email) {
    // Find all non-abandoned sessions for this email — INCLUDING submitted/AD.
    // DL-E38: recovery MUST work for submitted/AD families so the magic link can
    // resume them into signing. We only exclude abandoned sessions; submitted
    // sessions get their EXISTING token sent (token renewal is skipped below for
    // them, mirroring Path 1's behaviour).
    assertValidEmail_(p.primary_email, 'primary_email');
    let rows = appsheetRequest_(T.ENROLLMENT_GROUPS, 'Find', [], {
      Filter: '"primary_email" = "' + appsheetEscape_(p.primary_email) + '" && ISBLANK([abandoned_at])'
    });
    // DL-E38 a1: a non-primary guardian recovers with their OWN email — locate
    // open group(s) via enrEmails (guardians) when primary_email doesn't match.
    // The link is sent to the typed email (p.primary_email) below, i.e. to the
    // guardian's own inbox.
    if (!rows || !rows.length) {
      rows = findOpenGroupsByGuardianEmail_(p.primary_email);
    }
    if (!rows || !rows.length) throw new Error('Enrollment group not found');
    _checkMagicLinkRateLimit_(p.primary_email.toLowerCase().trim());

    // Renew tokens + created_at for NON-submitted sessions before sending so the
    // new link is valid for a fresh 7-day window. Submitted/AD sessions keep
    // their EXISTING resume_token untouched (no created_at reset) — exactly like
    // Path 1 — so recovery into signing reuses the live token.
    const nowIso = new Date().toISOString();
    // PERF sendMagicLink (2026-06-12): renovaciones de token (Edits) + lectura de
    // enrEmails por grupo en UN solo batch paralelo (antes: 1 Edit serial por grupo
    // + 1 Find serial por findEmailIdForGuardian_, ~3-5s cada uno). Mismas filas,
    // mismos filtros — solo serie→paralelo. Si un Edit del batch falla, ese grupo
    // conserva su token original (mismo fallback que antes).
    const sorted = rows.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const renewSpecs = [];
    const renewIdx   = {};   // group_id → posicion en renewSpecs
    const newTokens  = {};   // group_id → token nuevo propuesto
    sorted.forEach(g => {
      if (g.submitted_at) return; // submitted: send existing token, do not renew
      const newToken = generateUuid_();
      newTokens[g.enrollment_group_id] = newToken;
      renewIdx[g.enrollment_group_id] = renewSpecs.length;
      renewSpecs.push({ table: T.ENROLLMENT_GROUPS, action: 'Edit', rows: [{
        enrollment_group_id: g.enrollment_group_id,
        resume_token:        newToken,
        created_at:          nowIso,
        updated_at:          nowIso,
      }] });
    });
    const emailSpecsBase = renewSpecs.length;
    sorted.forEach(g => {
      renewSpecs.push({ table: T.EMAILS, action: 'Find', selector: {
        Filter: '"enrollment_group_id" = "' + appsheetEscape_(g.enrollment_group_id) + '"' } });
    });
    const batchRes = appsheetRequestBatch_(renewSpecs);
    const emailsHintByGroup = {};
    sorted.forEach((g, i) => {
      const r = batchRes[emailSpecsBase + i];
      emailsHintByGroup[g.enrollment_group_id] = (r && r.ok) ? (r.data || []) : null;
    });
    const grps = sorted.map(g => {
      const gid = g.enrollment_group_id;
      if (!(gid in newTokens)) return g; // submitted: token vivo intacto
      const r = batchRes[renewIdx[gid]];
      if (r && r.ok) return { ...g, resume_token: newTokens[gid] };
      // KAL-11: redact group_id UUID.
      Logger.log(redact_('sendMagicLink_: failed to renew token for group ' + gid + ': ' + ((r && r.error) || 'batch error')));
      return g; // fall back to original token on error
    });

    // IDENTITY-FROM-LINK (2026-06-11): el link va al email tecleado (p.primary_email =
    // buzón del guardian dueño). `n` := email_id de la fila enrEmails de ESE email en
    // CADA grupo recuperado (opaco, sin PII, ya existe). La identidad viaja en el enlace.
    const identityEmail = p.primary_email.toLowerCase().trim();

    const lang = grps[0].preferred_language || 'es';
    if (grps.length === 1) {
      // Use the single-link template (with full security footer + GDPR block)
      // instead of the abridged multi template when there's actually only one
      // open session — which is the common case under the new single-session policy.
      const nEmailId = findEmailIdForGuardian_(grps[0].enrollment_group_id, identityEmail, emailsHintByGroup[grps[0].enrollment_group_id]);
      _mintMagicLinkNonce_(grps[0].resume_token, grps[0].enrollment_group_id);
      // WIZARD-TERMINAL P3: contenido gobernado por el KMS. isFirstApp false (recuperación).
      const resumeUrlR = RESUME_BASE_URL + grps[0].resume_token + (nEmailId ? '?n=' + nEmailId : '');
      sendViaKmsNotify_('WIZARD_MAGIC_LINK', p.primary_email, {
        family_name:      '',
        resume_url:       resumeUrlR,
        report_url:       REPORT_BASE_URL + grps[0].resume_token,
        gdpr_block:       _kmsRenderGdprBlock_(false),
        admissions_email: ADMISSIONS_EMAIL,
      });
      // SPEC-WIZ-WARMUP-V2: ticket de warm con el token (renovado o vivo) del grupo.
      return { sent: true, warm_ticket: _mintWarmTicket_([{ t: grps[0].resume_token, n: nEmailId, e: identityEmail, l: lang }]) };
    } else {
      // Un email_id por grupo (paralelo a los tokens): cada link lleva el `n` del email
      // del guardian en SU grupo. La gracia OTP-skip se ancla al resume_token de cada grupo.
      const nEmailIds = grps.map(g => findEmailIdForGuardian_(g.enrollment_group_id, identityEmail, emailsHintByGroup[g.enrollment_group_id]));
      grps.forEach(g => _mintMagicLinkNonce_(g.resume_token, g.enrollment_group_id));
      // WIZARD-TERMINAL P3: la lista de enlaces la pre-renderiza el wizard en UN placeholder;
      // el resto del contenido (saludo, footer) lo gobierna el KMS. El report link usa el
      // primer token (reportUnsolicited_ bloquea el email, no la sesión — cualquiera vale).
      sendViaKmsNotify_('WIZARD_MAGIC_LINK_MULTI', p.primary_email, {
        family_name:        '',
        resume_links_block: _kmsRenderResumeLinksBlock_(grps.map(g => g.resume_token), nEmailIds, lang),
        report_url:         REPORT_BASE_URL + grps[0].resume_token,
        admissions_email:   ADMISSIONS_EMAIL,
      });
      // SPEC-WIZ-WARMUP-V2: UN ticket que cubre los N grupos (warmBundle los recorre).
      return { sent: true, warm_ticket: _mintWarmTicket_(grps.map((g, i) => ({ t: g.resume_token, n: nEmailIds[i] || null, e: identityEmail, l: lang }))) };
    }
  } else {
    throw new Error('Missing enrollment_group_id or primary_email');
  }
}

/**
 * Marks an enrollment session as abandoned by the family.
 *
 * Triggered by the "Start over" affordance in the wizard. Sets
 * abandoned_at = now on the enrEnrollmentGroups row; the resume_token
 * stays in the database (for audit) but resumeSession_ refuses to load
 * it and sendMagicLink_ filters it out. After abandoning, a fresh init
 * with the same email creates a new session (the single-session check
 * in initEnrollmentSession_ ignores abandoned rows).
 *
 * Auth: the resume_token IS the authorisation. Only the family that has
 * the magic link can abandon, which matches the trust model of the rest
 * of the wizard.
 *
 * The row is NOT deleted. Staff may want to inspect abandoned sessions
 * for analytics (drop-off points) and to detect abuse patterns.
 *
 * @param {{ resume_token: string }} p
 * @returns {{ abandoned: boolean }}
 */
function abandonSession_(p) {
  const token = (p && p.resume_token || '').toString().trim();
  if (!token) throw new Error('Missing resume_token');
  assertValidUuid_(token, 'resume_token');

  const rows = appsheetRequest_(T.ENROLLMENT_GROUPS, 'Find', [], {
    Filter: '"resume_token" = "' + appsheetEscape_(token) + '"'
  });
  const grp = rows && rows[0];
  if (!grp) throw new Error('Enrollment group not found');
  if (grp.submitted_at) throw new Error('Cannot abandon a submitted application');
  if (grp.abandoned_at) return { abandoned: true }; // idempotent

  appsheetRequest_(T.ENROLLMENT_GROUPS, 'Edit', [{
    enrollment_group_id: grp.enrollment_group_id,
    abandoned_at:        new Date().toISOString(),
    updated_at:          new Date().toISOString(),
  }]);

  return { abandoned: true };
}

/**
 * Reports a magic-link email as unsolicited (recipient did not initiate
 * the enrollment session). Triggered from the link in the magic-link
 * email body ("Esto no es mío"). The resume_token IS the authorisation —
 * only the recipient of the email knows it.
 *
 * Effects:
 *   1. The session's primary_email is marked BLOCKED for ~6h in
 *      ScriptCache → _checkMagicLinkRateLimit_ refuses further sends.
 *   2. An internal email goes to ADMISSIONS_EMAIL with the report details
 *      so staff can decide whether to extend the block manually, revoke
 *      the session row, or follow up with the apparent victim.
 *   3. The session header is NOT deleted. Staff may want to inspect it.
 *
 * Returns success unconditionally to avoid leaking whether the token
 * was valid (anti-enumeration for the report endpoint itself).
 *
 * @param {{ resume_token: string }} p
 * @returns {{ reported: boolean }}
 */
function reportUnsolicited_(p) {
  const token = (p && p.resume_token || '').toString().trim();
  if (!token) return { reported: true }; // silent ack
  // Malformed tokens silently ack (anti-enumeration — same behaviour as
  // unknown-but-well-shaped tokens below).
  try {
    assertValidUuid_(token, 'resume_token');
  } catch (_) {
    return { reported: true };
  }

  try {
    const groups = appsheetRequest_(T.ENROLLMENT_GROUPS, 'Find', [], {
      Filter: '"resume_token" = "' + appsheetEscape_(token) + '"'
    });
    const group = groups && groups[0];
    if (!group) return { reported: true }; // silent ack

    const email = (group.primary_email || '').toLowerCase().trim();
    const nowIso = new Date().toISOString();

    // (1) Hard-block future magic-link sends to this address for ~6h.
    if (email) {
      const cache = CacheService.getScriptCache();
      const blockKey = 'magic_blocked_' + Utilities.base64EncodeWebSafe(email);
      cache.put(blockKey, '1', 21600); // 6h (ScriptCache max)
    }

    // (2) Invalidate the existing session by marking it abandoned. Without
    //     this step the reporter (or whoever holds the magic link) could
    //     still click and resume — defeating the "this isn't mine" claim.
    //     resumeSession_ refuses sessions with abandoned_at set.
    //     Submitted sessions are never invalidated (the family must always
    //     be able to view what they sent).
    if (!group.submitted_at && !group.abandoned_at) {
      try {
        appsheetRequest_(T.ENROLLMENT_GROUPS, 'Edit', [{
          enrollment_group_id: group.enrollment_group_id,
          abandoned_at:        nowIso,
          updated_at:          nowIso,
        }]);
        // KAL-11: redact UUID.
        Logger.log(redact_('reportUnsolicited_: abandoned ' + group.enrollment_group_id));
      } catch (abandonErr) {
        Logger.log(redact_('reportUnsolicited_: failed to abandon ' + group.enrollment_group_id + ': ' + abandonErr.message));
      }
    }

    sendInternalEmail_(
      '[KIS Admissions] Unsolicited magic-link reported',
      '<p>A recipient marked their enrollment magic-link as unsolicited.</p>'
      + '<ul>'
      + '<li><strong>Group ID:</strong> ' + (group.enrollment_group_id || '') + '</li>'
      + '<li><strong>Email:</strong> ' + email + '</li>'
      + '<li><strong>Created at:</strong> ' + (group.created_at || '') + '</li>'
      + '<li><strong>Reported at:</strong> ' + nowIso + '</li>'
      + (group.submitted_at ? '<li><strong>Note:</strong> session was already submitted; NOT abandoned (preserves family access to submitted record).</li>' : '<li><strong>Session abandoned:</strong> yes</li>')
      + '</ul>'
      + '<p>The email has been temporarily blocked (~6h) for new magic-link sends. '
      + 'Review the session and decide whether to extend the block, contact the apparent victim, or delete the row.</p>'
    );
  } catch (e) {
    Logger.log('reportUnsolicited_ swallowed error: ' + e.message);
  }
  return { reported: true };
}

// ─── DL-E38 REFINADO — recuperación única per-guardian (P215, GAP-1 a1) ──────
//
// La recuperación pasa de group-scoped a guardian-scoped SIN esquema nuevo:
// el `resume_token` sigue siendo de GRUPO (gate KAL-4 intacto), y el guardian
// que recupera se identifica server-side por el EMAIL que la familia tecleó,
// matcheado contra `enrEmails` del grupo filtrado a guardians. NUNCA se confía
// en un `guardian_person_id` crudo del payload. Los emails por-guardian ya
// viven en `enrEmails` (fuente canónica) — no se añade columna ad-hoc.

/**
 * Resuelve el guardian que recuperó el magic link a partir del email tecleado
 * (GAP-1 a1). Matchea `recoveredEmail` contra `enrEmails` del grupo, filtrado a
 * personas `person_type_id === 'guardian'`. KAL-5: assertValidEmail_ + lower/trim
 * antes; appsheetEscape_ en cualquier Filter. KAL-4: el groupId ya viene derivado
 * del token, nunca del payload.
 *
 * FALLBACK LEGADO (2026-06-11 — fix bug "email-de-creación huérfano"):
 * El email con el que la familia inició sesión (`primary_email` del grupo) se
 * registra en `enrEnrollmentGroups` pero NO genera una fila en `enrEmails` en el
 * momento de la creación — se crea la fila de email solo cuando el guardián es
 * persistido por el KMS (Step 2). En sesiones creadas por el PRIMER tutor que aún
 * no ha completado el Step 2 (o cuyo email-de-creación no fue vinculado al person_id
 * en la fila de enrEmails), el matcher principal no encuentra match. Fallback:
 *   1. Si hay filas enrEmails SIN person_id cuyo value coincide → resolver el
 *      guardian como `requester_person_id` del grupo (el primer guardian guardado).
 *   2. Si el email coincide con `primary_email` del grupo Y hay un `requester_person_id`
 *      que es un guardian → devolver ese requester_person_id.
 * KAL-4: en ambos casos el groupId viene del token; el person_id se resuelve desde
 * datos del servidor (nunca del payload).
 *
 * Matching canónico per-guardian — DEBE permanecer idéntico a
 * enr_resolveGuardianFromEmail_ (kms-server/enr/wizard-datalayer.gs) hasta
 * consolidación P245 (un solo resolver, probablemente KMS-side). Si diverge,
 * uno de los dos es incorrecto. Cross-ref: P245 + HYDRATE-FIX 2026-06-11.
 *
 * @param {string} groupId         enrollment_group_id (ya derivado del token)
 * @param {string} recoveredEmail  email que tecleó la familia (discriminador)
 * @param {Array}  [emailsHint]    filas enrEmails del grupo ya leídas (evita re-query)
 * @param {Array}  [personsHint]   filas enrPersons del grupo ya leídas (evita re-query)
 * @param {Object} [groupHint]     fila enrEnrollmentGroups ya leída (evita re-query)
 * @returns {string|null} guardian person_id, o null si ningún email de guardian matchea
 *                        (GAP-2: pre-Step-2 no hay filas → fallback group-scoped).
 */
function resolveGuardianForRecovery_(groupId, recoveredEmail, emailsHint, personsHint, groupHint) {
  if (!recoveredEmail) return null;
  var email;
  try {
    assertValidEmail_(recoveredEmail, 'recovered_email');
    email = String(recoveredEmail).toLowerCase().trim();
  } catch (e) {
    return null; // discriminador malformado → no-match (fallback group-scoped)
  }
  try {
    assertValidUuid_(groupId, 'enrollment_group_id');
  } catch (e) {
    return null;
  }
  var idEsc = appsheetEscape_(groupId);

  var emails = Array.isArray(emailsHint) ? emailsHint
    : (appsheetRequest_(T.EMAILS, 'Find', [], { Filter: '"enrollment_group_id" = "' + idEsc + '"' }) || []);
  var persons = Array.isArray(personsHint) ? personsHint
    : (appsheetRequest_(T.PERSONS, 'Find', [], { Filter: '"enrollment_group_id" = "' + idEsc + '"' }) || []);

  var guardianIds = {};
  persons.forEach(function(per) {
    if (per && per.person_type_id === 'guardian' && per.person_id) guardianIds[per.person_id] = true;
  });

  // ── Vía principal: enrEmails con person_id de guardian ────────────────────
  var match = emails.find(function(e) {
    return e && guardianIds[e.person_id] &&
           String(e.value || '').toLowerCase().trim() === email;
  });
  if (match) return match.person_id;

  // ── FALLBACK LEGADO: email-de-creación sin person_id en enrEmails ─────────
  // El email introductorio del tutor 1 puede estar en enrEmails SIN person_id
  // (la fila de email se crea pero no se vincula al person_id hasta que el KMS
  // persiste el guardian en el Step 2). Dos sub-casos:
  //   A. Fila enrEmails sin person_id cuyo value coincide.
  //   B. Email coincide con primary_email del grupo (artefacto Stage-1).
  // En ambos casos resolvemos guardian = requester_person_id del grupo (primer
  // guardian, backfilled por el KMS en wizard-gateway.gs:762-767), siempre que
  // ese person_id sea un guardian conocido. KAL-4 intacto: todo server-side.

  // Sub-caso A: fila enrEmails sin person_id que coincida con el email tecleado.
  var orphanMatch = emails.find(function(e) {
    return e && !e.person_id &&
           String(e.value || '').toLowerCase().trim() === email;
  });

  // Sub-caso B: email coincide con primary_email del grupo (necesita group row).
  var primaryEmailMatch = false;
  if (!orphanMatch) {
    var grpRows = null;
    if (groupHint && groupHint.enrollment_group_id) {
      grpRows = [groupHint];
    } else {
      try {
        grpRows = appsheetRequest_(T.ENROLLMENT_GROUPS, 'Find', [],
          { Filter: '"enrollment_group_id" = "' + idEsc + '"' }) || [];
      } catch (e) {
        grpRows = [];
      }
    }
    var grp = grpRows && grpRows[0];
    if (grp && String(grp.primary_email || '').toLowerCase().trim() === email) {
      primaryEmailMatch = true;
    }
  }

  if (orphanMatch || primaryEmailMatch) {
    // Necesitamos el requester_person_id del grupo.
    var grpForRequester = null;
    if (groupHint && groupHint.enrollment_group_id) {
      grpForRequester = groupHint;
    } else {
      try {
        var grpRows2 = appsheetRequest_(T.ENROLLMENT_GROUPS, 'Find', [],
          { Filter: '"enrollment_group_id" = "' + idEsc + '"' }) || [];
        grpForRequester = grpRows2[0] || null;
      } catch (e) {
        grpForRequester = null;
      }
    }
    var requesterId = grpForRequester && grpForRequester.requester_person_id;
    if (requesterId && guardianIds[requesterId]) {
      Logger.log(redact_('[resolveGuardianForRecovery_] fallback legacy-email match → requester_person_id=' +
                 requesterId + ' (group=' + groupId.substring(0, 8) + '...)'));
      return requesterId;
    }
  }

  return null;
}

/**
 * DL-E38 a1: localiza grupos recuperables (no abandonados — INCLUYE submitted/AD)
 * cuyo email de GUARDIAN coincide con el tecleado — para que un guardian no-primario pueda
 * recuperar con SU propio email (no solo el `primary_email` del grupo). El
 * magic link se envía al email tecleado (que es el del guardian dueño del buzón),
 * nunca al atacante. KAL-5: assertValidEmail_ + appsheetEscape_. Devuelve filas
 * de grupo completas (con resume_token/primary_email/preferred_language).
 *
 * @param {string} rawEmail
 * @returns {Array} filas enrEnrollmentGroups abiertas con guardian match
 */
function findOpenGroupsByGuardianEmail_(rawEmail) {
  var email;
  try { assertValidEmail_(rawEmail, 'primary_email'); email = String(rawEmail).toLowerCase().trim(); }
  catch (e) { return []; }

  var emailRows = appsheetRequest_(T.EMAILS, 'Find', [],
    { Filter: '"value" = "' + appsheetEscape_(rawEmail) + '"' }) || [];
  var matched = emailRows.filter(function(e) {
    return String(e.value || '').toLowerCase().trim() === email && e.enrollment_group_id;
  });
  if (!matched.length) return [];

  var groupIds = {};
  matched.forEach(function(e) { groupIds[e.enrollment_group_id] = true; });
  var ids = Object.keys(groupIds);
  try { ids.forEach(function(id) { assertValidUuid_(id, 'enrollment_group_id'); }); }
  catch (e) { return []; }
  var grpFilter = ids.map(function(id) { return '"enrollment_group_id" = "' + appsheetEscape_(id) + '"'; }).join(' || ');

  var groups  = appsheetRequest_(T.ENROLLMENT_GROUPS, 'Find', [], { Filter: grpFilter }) || [];
  var persons = appsheetRequest_(T.PERSONS,           'Find', [], { Filter: grpFilter }) || [];

  // Solo enviar si el email matcheado pertenece a un GUARDIAN del grupo (no a un
  // applicant) — evita mandar recuperación al email de un menor.
  var guardianEmailGroups = {};
  var guardianIdsByGroup = {};
  persons.forEach(function(per) {
    if (per.person_type_id === 'guardian') {
      (guardianIdsByGroup[per.enrollment_group_id] = guardianIdsByGroup[per.enrollment_group_id] || {})[per.person_id] = true;
    }
  });
  matched.forEach(function(e) {
    var g = guardianIdsByGroup[e.enrollment_group_id];
    if (g && g[e.person_id]) guardianEmailGroups[e.enrollment_group_id] = true;
  });

  // DL-E38: include submitted/AD sessions (only exclude abandoned) so a
  // non-primary guardian can recover with their own email post-submit and
  // resume into signing. Token renewal for submitted rows is skipped by the
  // caller (sendMagicLink_ Path 2), which sends their existing resume_token.
  return groups.filter(function(g) {
    return !g.abandoned_at && guardianEmailGroups[g.enrollment_group_id];
  });
}

/**
 * GAP-3 / P215: resuelve el estado real del expediente + (si Aprobado) el
 * contexto de firma del guardian que recuperó. Bloque ADITIVO — no rompe las
 * claves existentes de la respuesta de resumeSession_.
 *
 * Regla multi-enrollment (GAP step 1.1, default fijado): si las enrollments del
 * grupo divergen de estado, se elige el MENOS avanzado (menor display_order en
 * sysStates_T) para no exponer "Aprobada"/desbloquear firma mientras un hermano
 * sigue en revisión. Grupos de una sola enrollment (caso común) no se ven
 * afectados. La firma se ancla al GRUPO (sysSigningSessions.entity_id == group),
 * así que el gate AD es a nivel de grupo.
 *
 * P245 STRIKE 3 (anti-divergencia, 2026-06-11): la tripleta de campos de firma
 * `signing_ready` / `signing_status` / `signing_context` que emite esta función (el
 * PULSE del wizard, getAdmissionState) DEBE permanecer IDÉNTICA a la que emite el
 * hydrate del KMS (`kms-server/enr/wizard-datalayer.gs`, bloque admission +
 * `enr_resolveSigningStatus_`, port verbatim de `resolveSigningStatus_` de abajo).
 * Si divergen, el frontend recibe dos semánticas para el mismo grupo y el gate 7→8 se
 * rompe. Regla canónica de Diego: firma lista ⟺ existe signer con token (sesión DRAFT
 * cuenta; el envelope Click&Sign NO es la vara). P245 (un solo resolver) es PRIORIDAD-1
 * del backlog — tres divergencias en un día (editable / guardian-matching / signing).
 *
 * @param {string} groupId
 * @param {Array}  enrollments         filas enrEnrollments del grupo
 * @param {string|null} guardianPersonId  guardian resuelto server-side (a1)
 * @returns {{state_code, state_label, signing_available, signing_context, signing_ready, signing_status}}
 */
function buildAdmissionContext_(groupId, enrollments, guardianPersonId, persons, admHints) {
  // PERF-KMS2 (2026-06-11): admHints (OPCIONAL) = filas live ya bajadas por el caller en
  // su batch paralelo — {states, sessions, signersBySession}. Cada consumidor re-aplica
  // su filtro de siempre en memoria; sin hints, TODOS los reads quedan live (callers
  // existentes intactos). Medido: states_ms 10-13s + 2×(sessions+signers) ~9-12s seriales.
  admHints = admHints || {};
  // URGENT-PASS3 BUG A (2026-06-11): `editable` deriva del ESTADO REAL (no de submitted_at).
  // Sin enrollments → pre-submit puro → editable (borrador). Con estado real, lo gobierna el
  // estado: ∈ {DRAFT,IN,NEEDS_MORE_INFO} ⟺ editable; resto (RQ,PS,RS,AD,…) ⟺ enviada/locked.
  var out = { state_code: null, state_label: null, signing_available: false, signing_context: null, signing_ready: false, editable: true };
  if (!enrollments || !enrollments.length) return out;

  // Catálogo de estados ENR_ADMISSION_SCHOOL del tenant (mismo patrón que el
  // reopen-check de resumeSession_).
  var perfS0 = Date.now(); // PERF-KMS2 (no-op si PERF2_.adm inactivo)
  var allStates = Array.isArray(admHints.states)
    ? admHints.states
    : (appsheetRequest_(T.STATES_T, 'Find', [], {}) || []);
  if (PERF2_.adm) PERF2_.adm.states_ms = Date.now() - perfS0;
  var statesById = {};
  allStates.forEach(function(s) {
    if (s && s.school_id === SCHOOL_ID && s.entity_type_code === 'ENR_ADMISSION_SCHOOL' && !s.deleted_at) {
      statesById[s.state_id] = s;
    }
  });

  var enrStates = enrollments
    .map(function(e) { return statesById[e.current_state_id] || null; })
    .filter(Boolean);
  if (!enrStates.length) return out;

  enrStates.sort(function(a, b) {
    return (Number(a.display_order) || 0) - (Number(b.display_order) || 0);
  });
  var chosen = enrStates[0];
  out.state_code  = chosen.state_code  || null;
  out.state_label = chosen.designation || null; // 'designation' = label canónico (DL-S34)

  // URGENT-PASS3 BUG A: editabilidad state-driven (mismo conjunto que el KMS hydrate
  // wizard-datalayer.gs). Con estado real, locked salvo {DRAFT,IN,NEEDS_MORE_INFO}.
  var EDITABLE_STATE_CODES_ = { 'DRAFT': true, 'IN': true, 'NEEDS_MORE_INFO': true };
  out.editable = out.state_code ? !!EDITABLE_STATE_CODES_[out.state_code] : true;

  if (out.state_code === 'AD') {
    // Path 1 — guardian resolved from the email the family typed (a1, KAL-4).
    if (guardianPersonId) {
      var perfP1 = Date.now(); // PERF-KMS2
      out.signing_context = resolveGuardianSigningContext_(groupId, guardianPersonId,
        admHints.sessions, admHints.signersBySession);
      if (PERF2_.adm) PERF2_.adm.ctx_path1_ms = Date.now() - perfP1;
    }
    // Path 2 (DL-E38 cross-device fix) — the magic link carries NO guardian
    // discriminator (recovered_email is empty when the link is clicked on a
    // device where the family never typed their email, e.g. the email inbox on
    // the phone). Without a fallback, signing_available stays false forever and
    // the Step 7 → signing bridge never unlocks even though the file is AD and
    // a signing_token exists. Resolve the signer DETERMINISTICALLY from the
    // active signing session anchored to THIS group (entity_id == groupId),
    // which is itself authorised by the resume_token validated upstream. KAL-4
    // is preserved: the guardian/signer is derived server-side from real DB
    // rows tied to the token's group, NEVER from a free payload field. The
    // signing act protections (single-use/TTL/binding, P222) still live on the
    // signing endpoints — this only unlocks the entry bridge.
    if (!out.signing_context) {
      var perfP2 = Date.now(); // PERF-KMS2
      out.signing_context = resolveSigningContextFromSession_(groupId, persons,
        admHints.sessions, admHints.signersBySession);
      if (PERF2_.adm) PERF2_.adm.ctx_path2_ms = Date.now() - perfP2;
    }
    out.signing_available = !!out.signing_context;

    // P215 opción (a) RESUELTA (CLI AD-SPLIT, decisión Diego 2026-06-07): la
    // identidad de firma se deriva SOLO server-side — Path 1 (Vía 1, recovery link
    // per-guardian: guardian del recovered_email) o Path 2 (determinista cuando es
    // inequívoco). La opción (b) (selector in-app "¿quién eres?" / signing_candidates)
    // queda ELIMINADA: una auto-declaración de identidad in-app ANTES del acto de
    // firma debilita el binding legal del firmante. Familias con ≥2 guardians se
    // resuelven por el recovery link per-guardian (cada guardian recupera con SU
    // email → Path 1 deriva su signing_token, sin selector). CERO auto-declaración.

    // WIZARD-STEP7-COMPLETED (2026-06-07): terminal signing state. With both
    // guardians already signed, the deterministic paths above ALL resolve empty
    // (eligible signers filtered by !signed_at → 0; terminal session filtered out
    // by the non-terminal filter) → signing_available=false → the family fell
    // through to the "firma en preparación" banner forever, looking stuck even
    // though signing is DONE. Expose an ADDITIVE signing_status ∈
    // {NOT_INITIATED, IN_PROGRESS, COMPLETED} so the frontend can render a terminal
    // success state. Does NOT touch signing_available (the entry-bridge gate).
    // KAL-4: the group is token-authorised; nothing comes from the payload.
    var perfSt = Date.now(); // PERF-KMS2
    out.signing_status = resolveSigningStatus_(groupId, admHints.sessions, admHints.signersBySession);
    if (PERF2_.adm) PERF2_.adm.status_ms = Date.now() - perfSt;

    // WIZARD — AD unlocks step 8 (state-driven, Option A; decisión Diego 2026-06-07):
    // the ENTRY DOOR to step 8 (signing) is the AD admission state — NOT the
    // per-guardian signing_context resolution. The old door required
    // signing_available (a resolved per-guardian signing_token), which for
    // genuinely-ambiguous multi-guardian groups never resolved → the Step 7 banner
    // showed "la documentación de firma se está preparando" FOREVER even though
    // the file was AD. Per-guardian resolution was being enforced at the WRONG
    // place (the door); the door must be the AD state plus the existence of a
    // signing session anchored to the group. `signing_ready` is exactly that
    // coarse, group-level gate (a session exists ⟺ signing_status !== NOT_INITIATED).
    // The per-guardian, legally-binding identity still lives at the signing ACT
    // (the /sign endpoints, requireSigningToken_, single-use/TTL/binding per P222);
    // signing_context (when resolved) is just the convenience token the frontend
    // carries into /sign. If it can't be resolved here, the door still opens on AD
    // (signing_ready) and /sign resolves the signer from the email/link — never
    // silently locked. KAL-4 intact: everything is derived server-side from the
    // token's group, nothing from the payload.
    out.signing_ready = (out.signing_status !== 'NOT_INITIATED');
  }
  return out;
}

/**
 * WIZARD-STEP7-COMPLETED (2026-06-07): coarse signing lifecycle of the group,
 * INCLUDING the terminal COMPLETED case (which the entry-bridge resolvers
 * deliberately ignore — they only unlock pending signers). Returns one of:
 *
 *   - 'NOT_INITIATED' — no signing session anchored to the group at all.
 *   - 'COMPLETED'     — the relevant session is terminal COMPLETED, OR every
 *                       expected signer has a signed_at (the robust signal:
 *                       current_state_code may be unseeded, so signed_at takes
 *                       precedence).
 *   - 'IN_PROGRESS'   — a session exists with expected signers but not all have
 *                       signed yet (and it is not terminal-completed).
 *
 * Unlike the entry-bridge resolvers, this does NOT filter out terminal sessions
 * (COMPLETED is terminal, and that's exactly what we need to detect). Defensive:
 * any lookup failure logs (redacted, KAL-11) and degrades to the safest default
 * ('NOT_INITIATED'), never throwing. KAL-5: assertValidUuid_ + appsheetEscape_.
 *
 * @param {string} groupId  token-authorised enrollment_group_id (KAL-4)
 * @returns {'NOT_INITIATED'|'IN_PROGRESS'|'COMPLETED'}
 */
function resolveSigningStatus_(groupId, sessionsHint, signersBySessionHint) {
  try {
    assertValidUuid_(groupId, 'enrollment_group_id');
  } catch (e) { return 'NOT_INITIATED'; }

  // PERF-KMS2: sessionsHint = filas de sysSigningSessions del grupo ya bajadas (mismo
  // Filter entity_id) por el batch del caller; signersBySessionHint[session_id] = filas
  // de signers ya bajadas (mismo Filter session_id). Sin hints → reads live de siempre.
  var sessions;
  try {
    sessions = Array.isArray(sessionsHint)
      ? sessionsHint
      : (appsheetRequest_(T.SIGNING_SESSIONS, 'Find', [],
          { Filter: '"entity_id" = "' + appsheetEscape_(groupId) + '"' }) || []);
  } catch (e) {
    Logger.log('[resolveSigningStatus_] sessions lookup failed: ' + e.message);
    return 'NOT_INITIATED';
  }
  var live = sessions.filter(function(s) { return s && !s.deleted_at; });
  if (!live.length) return 'NOT_INITIATED';

  // Prefer a COMPLETED session if one exists; otherwise the most recent live
  // session (by created_at when available, else just the last one found).
  var completedSession = live.find(function(s) {
    return (s.current_state_code || '') === 'COMPLETED';
  });
  var session = completedSession || live.slice().sort(function(a, b) {
    return String(b.created_at || '').localeCompare(String(a.created_at || ''));
  })[0];

  // current_state_code is the cheap signal but may be unseeded — fall through to
  // the robust signed_at check below before trusting it for COMPLETED.
  var stateSaysCompleted = (session.current_state_code || '') === 'COMPLETED';

  var signers;
  try {
    signers = (signersBySessionHint && Array.isArray(signersBySessionHint[session.session_id]))
      ? signersBySessionHint[session.session_id]
      : (appsheetRequest_(T.SIGNING_SESSION_SIGNERS, 'Find', [],
          { Filter: '"session_id" = "' + appsheetEscape_(session.session_id) + '"' }) || []);
  } catch (e) {
    Logger.log('[resolveSigningStatus_] signers lookup failed: ' + e.message);
    // Session exists but signers unreadable: trust the state code if it says so,
    // else assume in progress (a session is anchored).
    return stateSaysCompleted ? 'COMPLETED' : 'IN_PROGRESS';
  }

  // Expected signers = not soft-deleted, expected_to_sign not explicitly false
  // (column may be unseeded → undefined, which we treat as "expected").
  var expected = signers.filter(function(r) {
    return r && !r.deleted_at && r.expected_to_sign !== false;
  });
  if (!expected.length) {
    // No expected signers known: trust the state code only.
    return stateSaysCompleted ? 'COMPLETED' : 'IN_PROGRESS';
  }

  var allSigned = expected.every(function(r) { return !!r.signed_at; });
  if (allSigned || stateSaysCompleted) return 'COMPLETED';
  return 'IN_PROGRESS';
}

/**
 * DL-E38 cross-device fallback: resolve the per-guardian signing context WITHOUT
 * a recovered_email discriminator, by reading the active (non-terminal) signing
 * session anchored to the group and its signer rows. Deterministic only — never
 * guesses among ambiguous signers:
 *
 *   - exactly ONE non-deleted signer with a signing_token → use it (the common
 *     single-guardian family, and the unambiguous multi-signer-but-one-pending
 *     case once others have signed).
 *   - multiple eligible signers BUT the group has exactly one guardian person →
 *     match the signer for that guardian.
 *   - otherwise (genuinely ambiguous: ≥2 guardians, ≥2 pending signers) → return
 *     null. P215 opción (a): cada guardian recupera con SU email (recovery link
 *     per-guardian) → Path 1 deriva su signing_token. SIN selector in-app
 *     (opción b descartada por razón legal — CERO auto-declaración de identidad).
 *
 * KAL-4: groupId is the token-authorised group; nothing comes from the payload.
 * KAL-5: assertValidUuid_ + appsheetEscape_ on every Filter.
 *
 * @param {string} groupId
 * @param {Array}  persons  enrPersons rows of the group (to count guardians)
 * @returns {{signer_id, session_id, guardian_person_id, signing_token}|null}
 */
function resolveSigningContextFromSession_(groupId, persons, sessionsHint, signersBySessionHint) {
  try {
    assertValidUuid_(groupId, 'enrollment_group_id');
  } catch (e) { return null; }

  // PERF-KMS2: hints opcionales del batch del caller (mismos Filters); sin ellos, live.
  var sessions;
  try {
    sessions = Array.isArray(sessionsHint)
      ? sessionsHint
      : (appsheetRequest_(T.SIGNING_SESSIONS, 'Find', [],
          { Filter: '"entity_id" = "' + appsheetEscape_(groupId) + '"' }) || []);
  } catch (e) {
    Logger.log('[resolveSigningContextFromSession_] sessions lookup failed: ' + e.message);
    return null;
  }
  var TERMINAL = { COMPLETED: 1, CANCELLED: 1, EXPIRED: 1 };
  var session = sessions.find(function(s) {
    return s && !s.deleted_at && !TERMINAL[s.current_state_code || ''];
  });
  if (!session) return null;
  try {
    assertValidUuid_(session.session_id, 'session_id');
  } catch (e) { return null; }

  var signers;
  try {
    signers = (signersBySessionHint && Array.isArray(signersBySessionHint[session.session_id]))
      ? signersBySessionHint[session.session_id]
      : (appsheetRequest_(T.SIGNING_SESSION_SIGNERS, 'Find', [],
          { Filter: '"session_id" = "' + appsheetEscape_(session.session_id) + '"' }) || []);
  } catch (e) {
    Logger.log('[resolveSigningContextFromSession_] signers lookup failed: ' + e.message);
    return null;
  }
  // Eligible = not soft-deleted, has a token, not already signed.
  var eligible = signers.filter(function(r) {
    return r && !r.deleted_at && r.signing_token && !r.signed_at;
  });
  if (!eligible.length) {
    // Everyone already signed (or no tokens) — nothing to unlock.
    return null;
  }

  var chosen = null;
  if (eligible.length === 1) {
    chosen = eligible[0];
  } else {
    // Ambiguous among signers → disambiguate only if the group has a single
    // guardian person (then the eligible signer for that guardian is the one).
    var guardianIds = {};
    var guardianCount = 0;
    (persons || []).forEach(function(per) {
      if (per && per.person_type_id === 'guardian' && per.person_id && !guardianIds[per.person_id]) {
        guardianIds[per.person_id] = true;
        guardianCount++;
      }
    });
    if (guardianCount === 1) {
      var onlyGuardian = Object.keys(guardianIds)[0];
      chosen = eligible.find(function(r) { return r.signer_person_id === onlyGuardian; }) || null;
    }
  }
  if (!chosen) return null; // ambiguo → recovery link per-guardian (Vía 1), sin selector in-app

  // KAL-7/11: never log the full token.
  Logger.log(redact_('[resolveSigningContextFromSession_] signing_token resuelto (cross-device) signer=' +
             chosen.signer_person_id + ' grupo=' + groupId + ' token=' +
             String(chosen.signing_token).substring(0, 8) + '...'));

  return {
    signer_id:          chosen.signer_id || null,
    session_id:         session.session_id || null,
    guardian_person_id: chosen.signer_person_id || null,
    signing_token:      chosen.signing_token,
  };
}

/**
 * GAP-3 / P215: lookup INVERSO (lo que hacía `getSigningTokenFromResumeToken_`
 * borrado en CLI 60, ahora PER-GUARDIAN): dado {grupo, guardian} → encuentra la
 * fila signer en una sesión de firma no-terminal anclada al grupo y devuelve su
 * `signing_token`. Read-only, gateado por el resume_token ya validado aguas
 * arriba. KAL-5: assertValidUuid_ + appsheetEscape_ en cada Filter.
 *
 * @param {string} groupId
 * @param {string} guardianPersonId
 * @returns {{signer_id, session_id, guardian_person_id, signing_token}|null}
 */
function resolveGuardianSigningContext_(groupId, guardianPersonId, sessionsHint, signersBySessionHint) {
  try {
    assertValidUuid_(groupId, 'enrollment_group_id');
    assertValidUuid_(guardianPersonId, 'guardian_person_id');
  } catch (e) { return null; }

  // PERF-KMS2: hints opcionales del batch del caller (mismos Filters); sin ellos, live.
  var sessions;
  try {
    sessions = Array.isArray(sessionsHint)
      ? sessionsHint
      : (appsheetRequest_(T.SIGNING_SESSIONS, 'Find', [],
          { Filter: '"entity_id" = "' + appsheetEscape_(groupId) + '"' }) || []);
  } catch (e) {
    Logger.log('[resolveGuardianSigningContext_] sessions lookup failed: ' + e.message);
    return null;
  }
  var TERMINAL = { COMPLETED: 1, CANCELLED: 1, EXPIRED: 1 };
  var session = sessions.find(function(s) {
    return s && !s.deleted_at && !TERMINAL[s.current_state_code || ''];
  });
  if (!session) return null;
  try {
    assertValidUuid_(session.session_id, 'session_id');
  } catch (e) { return null; }

  var signers;
  try {
    signers = (signersBySessionHint && Array.isArray(signersBySessionHint[session.session_id]))
      ? signersBySessionHint[session.session_id]
      : (appsheetRequest_(T.SIGNING_SESSION_SIGNERS, 'Find', [],
          { Filter: '"session_id" = "' + appsheetEscape_(session.session_id) + '"' }) || []);
  } catch (e) {
    Logger.log('[resolveGuardianSigningContext_] signers lookup failed: ' + e.message);
    return null;
  }
  var signer = signers.find(function(r) {
    return r && !r.deleted_at && r.signer_person_id === guardianPersonId;
  });
  if (!signer || !signer.signing_token) return null;

  // KAL-7/11: nunca loguear el token completo.
  Logger.log(redact_('[resolveGuardianSigningContext_] signing_token resuelto para guardian=' +
             guardianPersonId + ' grupo=' + groupId + ' token=' + String(signer.signing_token).substring(0, 8) + '...'));

  return {
    signer_id:          signer.signer_id || null,
    session_id:         session.session_id || null,
    guardian_person_id: guardianPersonId,
    signing_token:      signer.signing_token,
  };
}

/**
 * Accepts a resume_token and returns the full session state — DL-E15.
 *
 * Queries enrEnrollmentGroups (the session header) by resume_token, then loads:
 *   - the N enrEnrollments rows (only present after submit)
 *   - staging tables (persons, relations, documents, responses, interviews) by
 *     enrollment_group_id
 *
 * Compatibility shim: legacy frontends expect `{ application, ... }`. We expose
 * the group as `application` AND `group` (and the same payload also has a
 * top-level `enrollments` array). This dual-key shape is transitional debt —
 * delete the `application` alias once all frontend builds read `group`.
 *
 * @param {Object} p - { resume_token }
 * @returns {Object} { group, application(alias), enrollments[], persons[], ... }
 */
function resumeSession_(p) {
  assertValidUuid_(p && p.resume_token, 'resume_token');
  const groups = appsheetRequest_(T.ENROLLMENT_GROUPS, 'Find', [], {
    Filter: '"resume_token" = "' + appsheetEscape_(p.resume_token) + '"'
  });
  if (!groups || !groups.length) throw new Error('Invalid or expired resume token');

  const group = groups[0];
  const id    = group.enrollment_group_id;
  // Defense in depth (KAL-5): id is sourced from the DB and bound to the
  // resume_token we just validated above. Re-assert UUID shape before using
  // in concatenations below, in case the column ever contains arbitrary data.
  assertValidUuid_(id, 'enrollment_group_id');

  // ── Magic-link grace (UX, sin urgencia) ────────────────────────────────────
  // IDENTITY-FROM-LINK (2026-06-11): la gracia OTP-skip se ancla al resume_token recién
  // rotado (`mlgrace_<resume_token>`), NO al `?n=` (que ahora lleva el email_id, identidad).
  // Si el resume_token tiene un marcador de gracia válido, no usado y de ESTE grupo, lo
  // consumimos (single-use) y marcamos step-up fresco → el recovery NO exige OTP durante
  // 10 min. KAL-4: el grupo (id) se deriva del resume_token server-side. KAL-7: un token
  // viejo/filtrado/reusado no tiene marcador → step_up_fresh=false → flujo OTP normal.
  const stepUpFresh = _consumeMagicLinkNonce_(p && p.resume_token, id);
  if (stepUpFresh) _markStepUpFresh_(id, 'GRACE');

  // Refuse if the family explicitly abandoned this session via abandonSession_.
  // Submitted sessions stay resumable regardless (the family must always be
  // able to view what they sent), but an abandon-before-submit is final.
  if (group.abandoned_at) {
    throw new Error('This application was abandoned; start a new one from admissions.kaleide.org');
  }

  // Soft expiry: 7 days from created_at. The row stays in the database
  // (submitted_at / promoted_at semantics unaffected), but resume access
  // is denied past the window. Submitted sessions are always resumable —
  // the family must always be able to view what they sent.
  if (!group.submitted_at) {
    const RESUME_TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
    const createdAt = group.created_at ? new Date(group.created_at).getTime() : 0;
    if (createdAt && (Date.now() - createdAt) > RESUME_TOKEN_TTL_MS) {
      throw new Error('Resume link expired (7 days); contact admisiones@kaleide.org to reopen');
    }
  }


  // ── SPEC-WIZ-WARMUP-V2 (2026-06-12) — cache-first POST-GATES del payload de
  // resume (la hidratacion de entrada del magic link, la pieza mas visible de la
  // primera carga: ~25-30s de lecturas). El warm (warmBundle) lo cocina COMPLETO
  // keyed por token; la ENTREGA sigue gateada igual (PII solo con step-up fresco —
  // precedente #69: el warm pre-computa completo, el servido gatea). La entrada
  // guarda live_version + identidad `n`: version subida o guardian distinto → vivo.
  try {
    const wzResKey = _wzCacheKey_('res', id + '_' + _wzN_(p && p.n));
    let wzResRaw = _wzCacheGetChunked_(CacheService.getScriptCache(), wzResKey);
    if (!wzResRaw) {
      // single-flight: si el warm está cocinando este payload, esperar su resultado.
      _dbgEv_('wait', 'single-flight res');
      wzResRaw = _wzAwaitWarm_('wzck_res_' + id + '_' + _wzN_(p && p.n), wzResKey, 45000);
    }
    if (wzResRaw) {
      const entry = JSON.parse(wzResRaw);
      if (entry && entry.data && entry.v === _getLiveStateVersion_(id)) {
        Logger.log('[WZCACHE] HIT res token=' + String(p.resume_token).slice(0, 8) + '...');
        _dbgEv_('cache', 'HIT res');
        // V2.4.1: normalizar el token embebido (cocinado quizá pre-rotación).
        if (entry.data.group) entry.data.group.resume_token = String(p.resume_token).trim();
        if (entry.data.application) entry.data.application.resume_token = String(p.resume_token).trim();
        if (_isStepUpFresh_(id)) {
          return Object.assign({}, entry.data, { step_up_fresh: stepUpFresh });
        }
        // Sin step-up fresco: misma shape gateada del camino vivo (PII vaciada).
        return {
          group: entry.data.group,
          application: entry.data.group,
          enrollments: entry.data.enrollments || [],
          persons: [], relations: [], documents: [], responses: [], interviews: [],
          admission: entry.data.admission || null,
          recovered_guardian_person_id: entry.data.recovered_guardian_person_id || null,
          step_up_fresh: false,
          pii_gated: true,
        };
      }
      if (entry && entry.data) {
        // live_version subio o identidad distinta → NUNCA servir stale/ajeno.
        CacheService.getScriptCache().remove(wzResKey + '_meta');
        Logger.log('[WZCACHE] STALE res token=' + String(p.resume_token).slice(0, 8) + '... — invalidado');
      }
    }
  } catch (eWzRes) { /* best-effort → camino vivo */ }

  const data = buildResumeSessionData_(group, p, stepUpFresh);
  // Write-through SOLO del payload COMPLETO (el gateado es barato y parcial).
  if (data && data.pii_gated !== true) {
    try {
      _wzCachePutChunked_(CacheService.getScriptCache(),
        _wzCacheKey_('res', id + '_' + _wzN_(p && p.n)),
        JSON.stringify({ v: _getLiveStateVersion_(id), data: data }), 1800);
    } catch (eWzWt) { /* best-effort */ }
  }
  return data;
}

/**
 * SPEC-WIZ-WARMUP-V2 — camino de DATOS de resumeSession_, movido VERBATIM (regla
 * codigo-de-oro: mismas tablas, mismos filtros, mismo mapeo; cero redisenno) para
 * que el warm lo pre-compute y el live lo comparta (UN solo lector, sin divergencia).
 * Los GATES (token→grupo, gracia, abandoned, TTL) viven en resumeSession_ y corren
 * SIEMPRE en vivo. opts.skipPiiGate=true SOLO para el warm server-side (pre-computa
 * el payload completo; la entrega al cliente sigue gateada en el servido).
 * @private
 */
function buildResumeSessionData_(group, p, stepUpFresh, opts) {
  const id = group.enrollment_group_id;
  assertValidUuid_(id, 'enrollment_group_id');

  // ── Top-level reads in parallel ────────────────────────────────────────────
  // Pre-parallelization: 4 sequential ~600ms-1s Finds (~3-4s total).
  // Now: one fetchAll batch (~1s bounded by slowest).
  // Note: enrollments[] is needed for the interviews filter, but interviews
  // and qbResponses both share enrollment_group_id as a primary filter so we
  // can issue them with the group_id directly; interviews still need to be
  // post-filtered to enrollment_id once enrollments come back, but since
  // pre-submit there are zero enrollments anyway this is a non-issue in the
  // common case. For the post-submit case (rare in resume), we re-filter
  // client-side from the broader set already fetched.
  const idEsc = appsheetEscape_(id);
  const programIdEsc = appsheetEscape_(group.program_id);
  const schoolIdEsc = appsheetEscape_(SCHOOL_ID);
  const topRead = appsheetRequestBatch_([
    { table: T.ENROLLMENTS,      action: 'Find', selector: { Filter: '"enrollment_group_id" = "' + idEsc + '"' } },
    { table: T.PERSONS,          action: 'Find', selector: { Filter: '"enrollment_group_id" = "' + idEsc + '"' } },
    { table: T.PERSON_RELATIONS, action: 'Find', selector: { Filter: '"context_entity_id" = "' + idEsc + '" && "context_entity_type_code" = "ENR_ADMISSION_SCHOOL"' } },
    { table: T.REC_FILES,        action: 'Find', selector: { Filter: '"school_id" = "' + schoolIdEsc + '" && "origin_reference" = "' + idEsc + '"' } },
    { table: T.QB_RESPONSES,     action: 'Find', selector: { Filter: '"respondent_id" = "' + idEsc + '"' } },
    { table: T.EMAILS,           action: 'Find', selector: { Filter: '"enrollment_group_id" = "' + idEsc + '"' } },
    { table: T.PHONES,           action: 'Find', selector: { Filter: '"enrollment_group_id" = "' + idEsc + '"' } },
    { table: T.PROGRAMS,         action: 'Find', selector: { Filter: '"program_id" = "' + programIdEsc + '"' } },
  ]);
  const enrollments = topRead[0].ok ? (topRead[0].data || []) : [];
  const persons     = topRead[1].ok ? (topRead[1].data || []) : [];
  const allEmails   = topRead[5].ok ? (topRead[5].data || []) : [];
  const allPhones   = topRead[6].ok ? (topRead[6].data || []) : [];
  const relations   = (topRead[2].ok ? (topRead[2].data || []) : [])
    .map(r => ({ ...r, guardian_person_id: r.from_person_id, applicant_person_id: r.to_person_id }));

  // ── DL-E38 / P215 (GAP-1 a1): per-guardian recovery ────────────────────────
  // The guardian that recovered is resolved SERVER-SIDE from the email the
  // family typed (p.recovered_email), matched against enrEmails of the group
  // filtered to guardians — NEVER from a raw payload field (KAL-4). The
  // resume_token gate above already authorised the group; the guardian is an
  // ADDITIONAL discriminator re-resolved against real data on every call.
  // IDENTITY-FROM-LINK (2026-06-11): la identidad viaja en el ENLACE — `p.n` lleva el
  // email_id del guardian; resolveEmailFromLinkParam_ lo valida contra el grupo del token
  // (KAL-4) y devuelve su email. Prioridad `n` > recovered_email (compat). Reusa los hints
  // del batch (allEmails/persons/group) → sin re-Find. Sobrevive a F5/incógnito/pestañas
  // porque el enlace (no el cliente) porta la identidad.
  const effRecoveredEmail = effectiveRecoveredEmail_(p && p.recovered_email, id, p && p.n, allEmails, persons, group);
  const recoveredGuardianId = resolveGuardianForRecovery_(id, effRecoveredEmail, allEmails, persons, group);

  // P215: real admission state + (if AD) per-guardian signing context. Additive
  // block — existing keys untouched so current consumers keep working.
  const admission = buildAdmissionContext_(id, enrollments, recoveredGuardianId, persons);

  // P-PII-GATE: sin step-up fresco NO se devuelve PII del expediente
  // (persons/relations/health/documents/responses/interviews). Un resume_token
  // filtrado solo obtiene estado/metadata; la PII completa requiere step-up. La
  // frescura es real: nonce de magic-link recién consumido (arriba) u OTP previo
  // marcaron stepup_ok_<group> server-side (verifyEmail stepup:true). El frontend
  // muestra el StepUpGate y re-llama resumeSession tras el OTP (onVerified) → PII.
  // KAL-4: group (id) derivado del token, nunca del payload. (Bonus: corta antes
  // de los ~20 reads de detalle por persona.)
  if (!(opts && opts.skipPiiGate) && !_isStepUpFresh_(id)) {
    Logger.log(redact_('[resumeSession_] PII-gated (sin step-up) group=' + id));
    return {
      group,
      application: group,
      enrollments,
      persons: [], relations: [], documents: [], responses: [], interviews: [],
      admission,
      recovered_guardian_person_id: recoveredGuardianId,
      step_up_fresh: false,
      pii_gated: true,
    };
  }

  // Documents: dedup by file_id + shape for frontend.
  // CLI 82 / KAL-NEW-5: NO drive_url. Sólo metadatos + file_id; los bytes se
  // resuelven on-demand vía getDocument (proxy gateado por token). El enlace
  // público de Drive desaparece del shape — nunca llega al cliente.
  let documents = [];
  if (topRead[3].ok) {
    const fileById = {};
    // WIZARD-DOCS (2026-06-13) — bug "listado fantasma" del Step 7: el read filtra
    // recFiles por origin_reference=group_id, lo que captura TODO fichero del grupo,
    // incluido el PDF de consentimiento firmado (origin='WIZARD_SUBMIT', escrito por
    // submitEnrollmentSession_, Code.js:4275) y cualquier fichero generado por el
    // sistema / paquete de firma. El resumen de "documentos subidos" debe mostrar
    // SOLO las subidas REALES de la familia (las que pasan por uploadDocument_, que
    // escribe origin='WIZARD', Code.js:5161). Filtramos por ese conjunto exacto.
    (topRead[3].data || [])
      .filter(f => f && f.origin === 'WIZARD' && !f.deleted_at)
      .forEach(f => { fileById[f.file_id] = f; });
    documents = Object.values(fileById).map(f => ({
      document_id:   f.file_id,
      file_id:       f.file_id,
      document_type: _docTypeFromRecType_(f.rec_type_code),
      // WIZARD-DOCS: texto libre del adjuntador genérico (qué es el archivo). El
      // frontend lo muestra preferentemente sobre el label de tipo tasado.
      description:   f.description || '',
      file_name:     f.file_name,
      mimeType:      f.mime_type,
      uploaded_at:   f.created_at,
      rec_type_code: f.rec_type_code,
      status:        f.status,
    }));
  } else {
    Logger.log('resumeSession_: recFiles read failed (non-fatal): ' + topRead[3].error);
  }

  // qbResponses (RESP-FIX 2026-06-07): el read del batch (topRead[4]) trae SOLO las
  // guardadas bajo el group_id, pero saveResponses_ distribuye respondent_id de forma
  // polimórfica (Code.js:3399 `respondent_id || enrollmentGroupId`): preguntas
  // por-aplicante → bajo person_id; por-enrollment → bajo enrollment_id; por-grupo →
  // bajo group_id. El backfill anterior solo añadía enrollment_id y solo post-submit,
  // perdiendo las respuestas por-aplicante (la mayoría) al recuperar. Ampliamos a la
  // UNIÓN { group_id (ya traído) ∪ person_id ∪ enrollment_id } y corre SIEMPRE (las
  // respuestas por-person existen pre-submit). KAL-4: todos los ids salen de datos del
  // grupo derivados del token (persons/enrollments del topRead), nunca del payload.
  let responses = topRead[4].ok ? (topRead[4].data || []) : [];
  (function () {
    var seen = {};
    responses.forEach(function (r) { if (r && r.response_id) seen[r.response_id] = true; });
    // KAL-5 capa 1: assertValidUuid_ por id; defensivo (salta inválidos, no rompe).
    var extraIds = [];
    persons.forEach(function (pr) {
      if (pr && pr.person_id) {
        try { assertValidUuid_(pr.person_id, 'person_id'); extraIds.push(pr.person_id); } catch (e) { /* skip id no-UUID */ }
      }
    });
    enrollments.forEach(function (e) {
      if (e && e.enrollment_id) {
        try { assertValidUuid_(e.enrollment_id, 'enrollment_id'); extraIds.push(e.enrollment_id); } catch (e2) { /* skip */ }
      }
    });
    if (!extraIds.length) return;
    try {
      // KAL-5 capa 2: appsheetEscape_ en cada id (patrón del reader correcto :2443).
      var orFilter = '(' + extraIds.map(function (rid) {
        return '"respondent_id" = "' + appsheetEscape_(rid) + '"';
      }).join(' || ') + ')';
      var extra = appsheetRequest_(T.QB_RESPONSES, 'Find', [], { Filter: orFilter }) || [];
      extra.forEach(function (r) {
        if (r && r.response_id && !seen[r.response_id]) { seen[r.response_id] = true; responses.push(r); }
      });
    } catch (e) {
      // P72 / defensivo: no romper la recuperación por esto (KAL-11: log redactado).
      Logger.log(redact_('resumeSession_: qbResponses union read failed (non-fatal): ' + e.message));
    }
    // WPERF-4 (bug 2): instrumentación de la recuperación de respuestas para diagnosticar
    // el responses_n:0 pese a Step 5 completado. Si responses_n=0 aquí pero la familia
    // respondió, la causa más probable es que Step 5 persiste ahora en el KMS (WPERF-3,
    // qbAnswerSessions/qbAnswers u otro respondent model) y NO en la tabla qbResponses que
    // lee esta unión {group ∪ person ∪ enrollment}. KAL-11: solo contamos, no volcamos PII.
    try {
      const respondentSet = {};
      responses.forEach(function (r) { if (r && r.respondent_id) respondentSet[r.respondent_id] = true; });
      Logger.log('resumeSession_: qbResponses recovered responses_n=' + responses.length +
                 ' distinct_respondents=' + Object.keys(respondentSet).length +
                 ' extra_ids_probed=' + extraIds.length);
    } catch (eLog) { /* logging best-effort */ }
  })();

  let interviews = [];
  if (enrollments.length) {
    const eidFilter = enrollments.map(e => '"enrollment_id" = "' + appsheetEscape_(e.enrollment_id) + '"').join(' || ');
    interviews = appsheetRequest_(T.INTERVIEWS, 'Find', [], { Filter: eidFilter }) || [];
  }

  // Normalise date fields to ISO format before sending to the frontend
  group.desired_start_date = normalizeDate_(group.desired_start_date);

  // enrEnrollmentGroups does not have a desired_start_date column (it lives on
  // enrEnrollments), so saveStep('application') cannot persist it to the group row.
  // Fall back to the program's period_starts_on so the frontend baseline matches
  // what Step1Email computes — preventing a spurious save on every resume.
  if (!group.desired_start_date && group.program_id) {
    var progRows = topRead[7].ok ? (topRead[7].data || []) : [];
    var progRow  = progRows[0] || null;
    if (progRow && progRow.period_starts_on) {
      group.desired_start_date = normalizeDate_(progRow.period_starts_on);
    }
  }

  // Reopen check: if submitted_at is set but KMS moved all enrollments back to
  // IN state, the session should be editable again. AppSheet's Edit API cannot
  // reliably clear a DateTime field (null and '' are both silently ignored), so
  // we resolve editability here from the actual state — overriding submitted_at
  // in the response without touching AppSheet.
  if (group.submitted_at && enrollments.length > 0) {
    const allStates = appsheetRequest_(T.STATES_T, 'Find', [], {}) || [];
    const inState = allStates.find(function(r) {
      return r.school_id === SCHOOL_ID &&
             r.entity_type_code === 'ENR_ADMISSION_SCHOOL' &&
             r.state_code === 'IN' && !r.deleted_at;
    });
    if (inState && enrollments.every(function(e) { return e.current_state_id === inState.state_id; })) {
      group.submitted_at = null;
      // KAL-11: redact group_id UUID.
      Logger.log(redact_('resumeSession_: all enrollments in IN — wizard unlocked (submitted_at overridden in response for group ' + group.enrollment_group_id + ')'));
    }
  }

  if (!persons.length) {
    return {
      group,
      application: group, // legacy alias — TODO: drop once frontend uses `group`
      enrollments,
      persons: [], relations, documents, responses, interviews,
      admission,                                      // P215 (additive)
      recovered_guardian_person_id: recoveredGuardianId, // P215 (server-resolved, a1)
      step_up_fresh: stepUpFresh,                     // magic-link grace (no OTP si true)
    };
  }

  const personIds = persons.map(per => per.person_id);
  personIds.forEach(pid => assertValidUuid_(pid, 'person_id'));
  const pidFilter = personIds.map(pid => '"person_id" = "' + appsheetEscape_(pid) + '"').join(' || ');

  // 8 person-detail Finds in parallel (was sequential ~5-8s, now ~1s).
  const personDetailRead = appsheetRequestBatch_([
    { table: T.PERSON_NATIONALITIES, action: 'Find', selector: { Filter: pidFilter } },
    { table: T.PERSON_IDS,           action: 'Find', selector: { Filter: pidFilter } },
    { table: T.PERSON_LANGUAGES,     action: 'Find', selector: { Filter: pidFilter } },
    { table: T.PERSON_ADDRESSES,     action: 'Find', selector: { Filter: pidFilter } },
    { table: T.PREV_SCHOOLS,         action: 'Find', selector: { Filter: pidFilter } },
    { table: T.PERSON_MEDICAL,       action: 'Find', selector: { Filter: pidFilter } },
    { table: T.PERSON_ALLERGIES,     action: 'Find', selector: { Filter: pidFilter } },
    { table: T.PERSON_DIETARY,       action: 'Find', selector: { Filter: pidFilter } },
  ]);
  const pickRows = (i) => personDetailRead[i].ok ? (personDetailRead[i].data || []) : [];
  const nationalities    = pickRows(0);
  const personIds_       = pickRows(1);
  const languages        = pickRows(2);
  const personAddrJoins  = pickRows(3);
  const prevSchools      = pickRows(4);
  const medical          = pickRows(5);
  const allergies        = pickRows(6);
  const dietary          = pickRows(7);

  // Batch-fetch address value rows (emails/phones already fetched by enrollment_group_id in topRead).
  const addrIds = personAddrJoins.map(r => r.address_id).filter(Boolean);
  const valueRead = appsheetRequestBatch_([
    addrIds.length ? { table: T.ADDRESSES, action: 'Find', selector: { Filter: addrIds.map(x => '"address_id" = "' + appsheetEscape_(x) + '"').join(' || ') } }
                   : { table: T.ADDRESSES, action: 'Find', rows: [] },
  ]);
  const addressMap = {};
  if (valueRead[0].ok) (valueRead[0].data || []).forEach(r => { addressMap[r.address_id] = r; });

  const enrichedPersons = persons.map(person => {
    const pid      = person.person_id;
    const addrJoin = personAddrJoins.find(r => r.person_id === pid && r.is_default)
                  || personAddrJoins.find(r => r.person_id === pid)
                  || null;
    return {
      ...person,
      date_of_birth:     normalizeDate_(person.date_of_birth),
      nationalities:     nationalities.filter(n => n.person_id === pid),
      ids:               personIds_.filter(x => x.person_id === pid),
      languages:         languages.filter(x => x.person_id === pid),
      address:           addrJoin ? (addressMap[addrJoin.address_id] || null) : null,
      emails:            allEmails.filter(e => e.person_id === pid),
      phones:            allPhones.filter(ph => ph.person_id === pid),
      previous_schools:  prevSchools.filter(s => s.person_id === pid),
      medical:           medical.filter(x => x.person_id === pid),
      allergies:         allergies.filter(x => x.person_id === pid),
      dietary:           dietary.filter(x => x.person_id === pid),
    };
  });

  return {
    group,
    application: group, // legacy alias — TODO: drop once frontend uses `group`
    enrollments,
    persons: enrichedPersons,
    relations,
    documents,
    responses,
    interviews,
    admission,                                      // P215 (additive)
    recovered_guardian_person_id: recoveredGuardianId, // P215 (server-resolved, a1)
    step_up_fresh: stepUpFresh,                     // magic-link grace (no OTP si true)
  };
}

/**
 * PERF (2026-06-08): endpoint LIGERO de estado de admisión para el pulse de la
 * página de firma. `resumeSession_` relee TODO el expediente (persons + sub-reads
 * por persona + relations + documents + responses + interviews → ~20+ reads, 30-40s)
 * y el pulse lo disparaba repetidamente solapado → saturación. El pulse SOLO necesita
 * el estado de admisión + el contexto de firma, NO el expediente completo.
 *
 * Lee solo: grupo (vía token), enrollments del grupo, persons del grupo (para Path 2
 * de buildAdmissionContext_), y emails (lazy, solo si hay recovered_email) — más los
 * pocos reads internos de buildAdmissionContext_ (sysStates_T + signing session). NO
 * lee relations/documents/responses/interviews ni los sub-reads por persona.
 *
 * KAL-4: el grupo se deriva del resume_token server-side (requireResumeToken_), nunca
 * del payload. El guardian (Path 1) se re-resuelve del recovered_email contra datos
 * reales del grupo. step_up_fresh: si llega un nonce de magic-link válido lo consume
 * y marca fresco; si no, REPORTA la frescura actual del grupo (_isStepUpFresh_).
 *
 * @param {{ resume_token: string, recovered_email?: string, n?: string }} p
 * @returns {{ ok, state_code, state_label, signing_ready, signing_status, signing_context, signing_available, step_up_fresh }}
 */
function getAdmissionState_(p) {
  // KAL-4: grupo autorizado derivado del token (valida UUID + TTL + abandoned_at).
  const perfT0 = Date.now(); // PERF-KMS2
  const id = requireResumeTokenMemo_(p) /* PERF V2.1: lectura pura — memo del gate (mutaciones siguen en vivo) */;
  const perfGateMs = Date.now() - perfT0;

  // Magic-link grace (IDENTITY-FROM-LINK): anclada al resume_token recién rotado
  // (mlgrace_<resume_token>); single-use, 10 min → consume + marca fresco. Si no hay
  // marcador, REPORTAMOS la frescura vigente del grupo (no la cambiamos).
  let stepUpFresh = _consumeMagicLinkNonce_(p && p.resume_token, id);
  if (stepUpFresh) {
    _markStepUpFresh_(id, 'GRACE');
  } else {
    // ★ SEC-STEPUP (finding #55): el pulso es una LECTURA — REPORTA la frescura
    // vigente, NUNCA la re-extiende. Antes (P-STEPUP-SLIDING) este else re-escribía
    // stepup_ok_<group> en cada pulso → la ventana de 10 min se deslizaba indefinida
    // mientras la pestaña estuviera abierta, y una recarga dentro de esa ventana viva
    // entraba SIN OTP (bypass del PII-gate). La ventana es DURA: 10 min desde la última
    // RE-VERIFICACIÓN (OTP o gracia), sin extensión por uso. Solo se reporta aquí.
    stepUpFresh = _isStepUpFresh_(id);
  }

  // WIZARD-CACHE (2026-06-12) — cache-first: si el warm dejó wz_adm_<token> y la
  // versión liveState wizard-side NO subió desde que se cocinó, servimos de cache.
  // El pulse de live_version existente sigue gobernando el refresh: si la versión
  // subió respecto al cacheado → invalida y ve al vivo. Gates intactos:
  // requireResumeToken_ (KAL-4) + gracia/step-up ya corrieron arriba; step_up_fresh
  // SIEMPRE se computa en vivo (estado per-llamada, nunca del cache).
  try {
    const wzAdmKey = _wzCacheKey_('adm', id + '_' + _wzN_(p && p.n));
    const wzAdmRaw = _wzCacheGetChunked_(CacheService.getScriptCache(), wzAdmKey);
    if (wzAdmRaw) {
      const wzEntry = JSON.parse(wzAdmRaw);
      // IDENTIDAD (multi-tutor, 2026-06-12): en grupos submitted el token NO rota ->
      // dos tutores comparten clave. La entrada guarda el `n` con el que se cocino;
      // si el caller trae otro `n` (otro guardian) -> MISS al camino vivo (que
      // re-resuelve la identidad real). Mismo patron en wz_res/wz_mem.
      if (wzEntry && wzEntry.admission && wzEntry.v === _getLiveStateVersion_(id)) {
        const admC = wzEntry.admission;
        Logger.log('[WZCACHE] HIT adm token=' + String(p.resume_token).slice(0, 8) +
                   '… ms=' + (Date.now() - perfT0));
        _dbgEv_('cache', 'HIT adm');
        return {
          _perf:             (p && p._perf === true) ? { cache_hit: true, t_gate_ms: perfGateMs, t_total_ms: Date.now() - perfT0 } : undefined,
          ok:                true,
          state_code:        admC.state_code,
          state_label:       admC.state_label,
          signing_ready:     admC.signing_ready,
          signing_status:    admC.signing_status || null,
          signing_available: admC.signing_available,
          signing_context:   admC.signing_context,
          editable:          admC.editable,
          step_up_fresh:     stepUpFresh,
        };
      }
      if (wzEntry && wzEntry.admission) {
        // live_version subió respecto al cacheado → NUNCA servir stale: invalida y ve al vivo.
        CacheService.getScriptCache().remove(wzAdmKey + '_meta');
        Logger.log('[WZCACHE] STALE adm (live_version) token=' + String(p.resume_token).slice(0, 8) + '… — invalidado');
      }
    }
  } catch (eWzAdm) { /* best-effort → camino vivo */ }

  const idEsc = appsheetEscape_(id);
  const perfB0 = Date.now(); // PERF-KMS2
  const lightRead = appsheetRequestBatch_([
    { table: T.ENROLLMENTS,      action: 'Find', selector: { Filter: '"enrollment_group_id" = "' + idEsc + '"' } },
    { table: T.PERSONS,          action: 'Find', selector: { Filter: '"enrollment_group_id" = "' + idEsc + '"' } },
    // IDENTITY-FROM-LINK: la fila de grupo se usa como groupHint para el fallback
    // requester de resolveGuardianForRecovery_ (email de creación sin person_id). En
    // paralelo, sin coste de latencia adicional respecto al batch existente.
    { table: T.ENROLLMENT_GROUPS, action: 'Find', selector: { Filter: '"enrollment_group_id" = "' + idEsc + '"' } },
    // PERF-KMS2 (2026-06-11): 3 tablas más en el MISMO batch paralelo (cero latencia
    // extra) que antes se leían en SERIE aguas abajo (medido: states 10-13s + emails
    // ~3-5s + sessions 2×3-4s). Filtros VERBATIM de los lectores probados:
    // buildAdmissionContext_ (STATES_T sin filtro), resolveEmailFromLinkParam_/
    // findEmailIdForGuardian_ (EMAILS por grupo), resolveSigningStatus_/
    // resolveGuardianSigningContext_/resolveSigningContextFromSession_ (SESSIONS por
    // entity_id). Las filas viajan como hints opcionales — cada helper re-aplica su
    // filtro fino en memoria; sin hints, su camino live queda intacto.
    { table: T.STATES_T,          action: 'Find', selector: {} },
    { table: T.EMAILS,            action: 'Find', selector: { Filter: '"enrollment_group_id" = "' + idEsc + '"' } },
    { table: T.SIGNING_SESSIONS,  action: 'Find', selector: { Filter: '"entity_id" = "' + idEsc + '"' } },
  ]);
  const perfBatchMs = Date.now() - perfB0;
  const enrollments = lightRead[0].ok ? (lightRead[0].data || []) : [];
  const persons     = lightRead[1].ok ? (lightRead[1].data || []) : [];
  const groupRow    = (lightRead[2].ok && lightRead[2].data && lightRead[2].data[0]) || null;
  // PERF-KMS2: hints (null si su read del batch falló → los helpers caen a su live).
  const statesHint   = lightRead[3].ok ? (lightRead[3].data || []) : null;
  const emailsHint   = lightRead[4].ok ? (lightRead[4].data || []) : null;
  const sessionsHint = lightRead[5].ok ? (lightRead[5].data || []) : null;

  // PERF-KMS2: prefetch paralelo de signers de las sesiones VIVAS del grupo (≤2 típicas)
  // — mismo Filter session_id que los helpers; si falla, el helper lee live como siempre.
  let signersBySession = null;
  if (sessionsHint && sessionsHint.length) {
    try {
      const liveSessions = sessionsHint.filter(function(s) { return s && !s.deleted_at && s.session_id; });
      if (liveSessions.length) {
        const sigReads = appsheetRequestBatch_(liveSessions.map(function(s) {
          return { table: T.SIGNING_SESSION_SIGNERS, action: 'Find',
                   selector: { Filter: '"session_id" = "' + appsheetEscape_(s.session_id) + '"' } };
        }));
        signersBySession = {};
        liveSessions.forEach(function(s, i) {
          if (sigReads[i] && sigReads[i].ok) signersBySession[s.session_id] = sigReads[i].data || [];
        });
      }
    } catch (eSig) { signersBySession = null; /* helpers caen a live */ }
  }

  // IDENTITY-FROM-LINK (2026-06-11): la identidad viaja en el ENLACE — `p.n` (email_id) →
  // email del guardian, validado contra el grupo del token (KAL-4). Prioridad `n` >
  // recovered_email (compat). emails se leen lazy dentro del resolver (email_id Find
  // dirigido); persons/groupRow como hints para guardian + fallback requester.
  const perfG0 = Date.now(); // PERF-KMS2
  const effRecoveredEmail = effectiveRecoveredEmail_(p && p.recovered_email, id, p && p.n, emailsHint, persons, groupRow);
  const guardianId = resolveGuardianForRecovery_(id, effRecoveredEmail, emailsHint, persons, groupRow);
  const perfGuardianMs = Date.now() - perfG0;

  const perfA0 = Date.now();
  PERF2_.adm = {}; // recoge segmentos internos de buildAdmissionContext_
  const admission = buildAdmissionContext_(id, enrollments, guardianId, persons,
    { states: statesHint, sessions: sessionsHint, signersBySession: signersBySession });
  const perfAdmMs = Date.now() - perfA0;
  Logger.log('[PERF] getAdmissionState t_gate=' + perfGateMs + ' t_batch=' + perfBatchMs +
             ' t_guardian=' + perfGuardianMs + ' t_admission=' + perfAdmMs +
             ' adm=' + JSON.stringify(PERF2_.adm));
  const perfOut = (p && p._perf === true) ? { // post-gate (KAL-4); solo ms (KAL-11)
    t_gate_ms: perfGateMs, t_batch_ms: perfBatchMs, t_guardian_ms: perfGuardianMs,
    t_admission_ms: perfAdmMs, adm_segments: PERF2_.adm, t_total_ms: Date.now() - perfT0,
  } : undefined;

  // WIZARD-CACHE write-through (best-effort): el próximo pulse del MISMO estado sirve
  // de cache hasta que live_version suba (notify del KMS) o un write lo invalide.
  try {
    _wzCachePutChunked_(CacheService.getScriptCache(),
      _wzCacheKey_('adm', id + '_' + _wzN_(p && p.n)),
      JSON.stringify({ v: _getLiveStateVersion_(id), admission: {
        state_code:        admission.state_code,
        state_label:       admission.state_label,
        signing_ready:     admission.signing_ready,
        signing_status:    admission.signing_status || null,
        signing_available: admission.signing_available,
        signing_context:   admission.signing_context,
        editable:          admission.editable,
      } }), 1800);
  } catch (eWzWt) { /* best-effort */ }

  return {
    _perf:             perfOut,
    ok:                true,
    state_code:        admission.state_code,
    state_label:       admission.state_label,
    signing_ready:     admission.signing_ready,
    signing_status:    admission.signing_status || null,
    signing_available: admission.signing_available,
    signing_context:   admission.signing_context,
    editable:          admission.editable,   // URGENT-PASS3 BUG A: state-driven editabilidad
    step_up_fresh:     stepUpFresh,
  };
}

/**
 * Partial save for any wizard step — DL-E15.
 *
 * The payload key is `enrollment_group_id`; legacy `application_id` is accepted
 * as alias. All staging-table writes (persons/addresses/emails/phones/relations)
 * now FK to enrollment_group_id, not application_id.
 *
 * Step semantics:
 *   - `application` step name is kept (legacy) but its target is the GROUP row.
 *     desired_start_date and source_locale are written to enrEnrollmentGroups;
 *     they are propagated to each enrEnrollments at submit time.
 *   - `review` step is staff-side and drives status transitions on each enrollment
 *     in the group (the group itself has no state). Uses sysStates_T + sysStateTransitionLog.
 *
 * @param {Object} p - { enrollment_group_id?|application_id?, step, payload }
 */
function saveStep_(p) {
  // KAL-4: derive authorised group_id from resume_token; never trust the
  // payload's enrollment_group_id directly. Cross-check inside the helper.
  const enrollmentGroupId = requireResumeToken_(p);
  const { step, payload } = p;
  if (!step || !payload) throw new Error('Missing required fields');

  // CLI 26 (2026-06-01) — state-gate defense in depth. A submitted group is
  // locked for the family; only KMS staff can reopen it back to NEEDS_MORE_INFO
  // (which clears submitted_at via the reopen branch of resumeSession_).
  // The 'review' step in this handler used to be a staff-side state-transition
  // helper from a legacy flow; no current frontend caller invokes it, and the
  // canonical state-machine API lives in KMS — so gating it too is correct.
  assertGroupEditable_(enrollmentGroupId);
  _wzCacheInvalidate_(p && p.resume_token); // WIZARD-CACHE: NUNCA servir stale tras un write del grupo

  // ── DL-E39 step-up gate (PII-primero) ──────────────────────────────────────
  // Los steps que mutan PII sensible (Persons / Relations / Health) exigen un
  // step-up fresco. El step 'application' es de campos a nivel de grupo
  // (program_id, fechas, source) — no PII de personas — y NO se gatea para no
  // romper el avance temprano del wizard. 'questions'/'documents' no escriben
  // aquí (lo hacen saveResponses_/uploadDocument_, gateados por separado).
  // KAL-4: enrollmentGroupId ya viene de requireResumeToken_ (token), no payload.
  if (p.step === 'persons' || p.step === 'relations' || p.step === 'health') {
    assertStepUpFresh_(enrollmentGroupId);
  }
  // ★ SEC-STEPUP (finding #55): NO re-extender la ventana en un save (eso era
  // P-STEPUP-SLIDING — convertía 10 min en infinitos por uso → bypass del gate en
  // recarga). El gate de arriba ya exige frescura DURA de ≤10 min desde el OTP.

  // ── Thin-client (DL-E41 / WPERF-3): la escritura la hace el KMS (encola). ─────
  // El wizard valida (KAL-4 + step-up arriba) y PROXEA al endpoint del step; el KMS
  // re-deriva el grupo del resume_token (KAL-4) y encola la persistencia. Para
  // 'persons' el KMS pre-asigna los person_id y devuelve personIdMap (el frontend
  // estampa los IDs reales). NOTA WPERF-INT: smoke de las shapes persons/relations/
  // health (frontend payload ↔ enr_persist*_) tras integrar wperf-2 + deploy.
  let extra = null;
  switch (step) {
    case 'application':
      kmsProxy_('enr.wizardSaveStep', {
        resume_token:       p.resume_token,
        step:               'application',
        program_id:         payload.program_id || null,
        desired_start_date: payload.desired_start_date ? normalizeDate_(payload.desired_start_date) : null,
        source_locale:      payload.source || null,
      });
      break;
    // KAL-NEW-3 (2026-06-05): `case 'review'` eliminado — las transiciones ADMISSION
    // viven en el KMS (staff). step='review' cae al default → 'Unknown step: review'.
    case 'persons':
      // CLI 8: guard email único por tutor (defensa en profundidad) ANTES de proxear.
      assertUniqueGuardianEmails_(payload);
      extra = kmsProxy_('enr.wizardSavePersons', {
        resume_token: p.resume_token,
        persons:      Array.isArray(payload) ? payload : (payload.persons || []),
      });
      // CLI 8: atestación de tutor único — sigue siendo dato del payload (group-scoped).
      persistSoleGuardianAttestation_(enrollmentGroupId, p.sole_guardian_attestation);
      break;
    case 'relations':
      kmsProxy_('enr.wizardSaveRelations', {
        resume_token: p.resume_token,
        relations:    Array.isArray(payload) ? payload : (payload.relations || []),
      });
      break;
    case 'health':
      kmsProxy_('enr.wizardSaveHealth', {
        resume_token: p.resume_token,
        health:       Array.isArray(payload) ? payload : (payload.health || []),
      });
      break;
    case 'questions':
      // Responses are saved individually via saveResponses_ — nothing to do here
      break;
    case 'documents':
      // Documents are saved individually via uploadDocument_
      break;
    default:
      throw new Error('Unknown step: ' + step);
  }

  // El frontend (Step2 → WizardPage) consume _debug.personIdMap para estampar los
  // person_id reales. El KMS lo devuelve en `extra.personIdMap` (sin PII — solo
  // pares _uid ↔ person_id).
  const safeDebug = (extra && extra.personIdMap) ? { personIdMap: extra.personIdMap } : null;
  return { saved: true, step, _debug: safeDebug };
}

/**
 * Submits an enrollment session — DL-E15.
 *
 * Materialises N enrEnrollments rows (one per applicant person captured in the
 * staging tables), stamps submitted_at on the group, writes per-enrollment
 * status_log + consent rows, generates the consent PDF and sends the family +
 * internal confirmation emails.
 *
 * The initial state on each enrollment is resolved from sysStates_T
 * with state_code = 'RQ' (Requested). Per DL-E15
 * pendientes-flagged decision, RQ is the on-submit state (IN is reserved for
 * "wizard in progress" which post-DL-E15 no longer applies per row).
 *
 * @param {Object} p - { enrollment_group_id?|application_id?, esignature, consents, language }
 */
function submitEnrollmentSession_(p) {
  // KAL-4: derive authorised group_id from resume_token; never trust the
  // payload's enrollment_group_id directly. Cross-check inside the helper.
  const enrollmentGroupId = requireResumeToken_(p);

  // CLI 81 (S9 / SUBMIT-REPLAY): block re-submit of an already-submitted (or
  // abandoned) group. Without this gate a re-POST re-stamps submitted_at,
  // regenerates the PDF and re-sends the confirmation emails. The other three
  // mutation handlers (saveStep_, saveResponses_, uploadDocument_) already call
  // this guard since CLI 26 — submit was the one that slipped through. Throws
  // Error{code:'NOT_EDITABLE'} → doPost maps it to HTTP 200 {ok:false,error}.
  assertGroupEditable_(enrollmentGroupId);
  _wzCacheInvalidate_(p && p.resume_token); // WIZARD-CACHE: NUNCA servir stale tras un write del grupo

  const now = new Date().toISOString();

  // Load the group header
  const groups = appsheetRequest_(T.ENROLLMENT_GROUPS, 'Find', [], {
    Filter: '"enrollment_group_id" = "' + appsheetEscape_(enrollmentGroupId) + '"'
  });
  const group = groups && groups[0];
  if (!group) throw new Error('Enrollment group not found');

  // ── Resolve the initial state (RQ = Requested) ─────────────────────────────
  // Diego 2026-05-19 found that the AppSheet multi-AND filter on sysStates_T
  // wasn't selecting the right row: the wizard wrote to_state_id = UUID of IN
  // (a70e878a-...) into sysStateTransitionLog instead of UUID of RQ
  // (6e434294-...). Root cause: AppSheet's Selector expression parser
  // misbehaves with three chained "[col] = value AND [col] = value AND [col] = value"
  // — it appears to ignore the filter and return the full table. statusTypes[0]
  // then picks the first row by display_order, which for KIS is IN.
  //
  // Switching to fetch-all-then-filter in memory. For sysStates_T this is
  // ~10 rows so the cost is negligible. Safer than depending on a filter
  // parser quirk.
  const allStates = appsheetRequest_(T.STATES_T, 'Find', [], {}) || [];
  const rqStateRow = allStates.find(r =>
    r.school_id === SCHOOL_ID &&
    r.entity_type_code === 'ENR_ADMISSION_SCHOOL' &&
    r.state_code === 'RQ' &&
    !r.deleted_at
  );
  if (!rqStateRow || !rqStateRow.state_id) {
    Logger.log('submitEnrollmentSession_: sysStates_T has no RQ row for school=' + SCHOOL_ID +
               ' entity_type=ENR_ADMISSION_SCHOOL. Total rows scanned: ' + allStates.length +
               '. state_codes seen: ' + allStates.filter(r => r.school_id === SCHOOL_ID).map(r => r.state_code).join(','));
    throw new Error(
      'Configuration error: sysStates_T is missing an active row with state_code="RQ" + ' +
      'entity_type_code="ENR_ADMISSION_SCHOOL" for school "' + SCHOOL_ID + '". ' +
      'Seed it via Admin → Catálogos → Estados de programa before accepting submissions.'
    );
  }
  const rqStateId = rqStateRow.state_id;
  Logger.log('submitEnrollmentSession_: resolved RQ state_id=' + rqStateId);

  // ── Fetch persons captured in this group ───────────────────────────────────
  const allPersons = appsheetRequest_(T.PERSONS, 'Find', [], {
    Filter: '"enrollment_group_id" = "' + appsheetEscape_(enrollmentGroupId) + '"'
  }) || [];
  const guardians  = allPersons.filter(per => per.person_type_id === 'guardian');
  const applicants = allPersons.filter(per => per.person_type_id === 'applicant');

  if (!applicants.length) {
    throw new Error('No applicant person found in enrollment group');
  }

  // ── CLOSING VALIDATION (IMPL-H / W1 + W2) — VALIDATE BEFORE ANY WRITE ───────
  // W1 (order): every closing validation MUST run BEFORE the first write that
  // materialises the submission (requester Edit, enrEnrollments Add/Edit,
  // sysStateTransitionLog, submitted_at on enrEnrollmentGroups, consents). The
  // old gate sat at the end (after submitted_at was already stamped): a failed
  // gate left the group half-submitted (submitted_at set) and the retry hit
  // assertGroupEditable_'s NOT_EDITABLE → the family was stuck. Moving it here
  // makes the submit atomic for the user: validate everything, then materialise,
  // or abort clean writing nothing.
  //
  // Guardian phone gate: each guardian (the signer; Click & Sign requires it at
  // Step 11) must have ≥1 valid E.164 phone. SOSPECHA-2 fix — the old gate read
  // enrichedGuardians[].phones, but gPhoneJoins was hardcoded to [] (~line 2852),
  // so the gate threw INVALID_PHONE ALWAYS, regardless of the real value. We load
  // the guardians' real phones from enrPhones by enrollment_group_id (verbatim
  // gold-standard read resumeSession_:2191,2197) and nest by person_id
  // (resumeSession_:2409 pattern) so the some() iterates over real numbers.
  //
  // W2 (P259): AppSheet strips the leading '+' from enrPhones.value, so an E.164
  // value '+34609211201' is stored as '34609211201'. Normalise the STORED value
  // (re-prepend '+' when all-digits) before the strict regex; this only restores
  // the '+' AppSheet removed — it still requires a valid E.164 after normalising,
  // NOT "any digits". Fresh input keeps the strict-with-'+' check elsewhere.
  const gPersonIdsForGate = guardians.map(g => g.person_id).filter(Boolean);
  if (gPersonIdsForGate.length) {
    const allGuardianPhones = appsheetRequest_(T.PHONES, 'Find', [], {
      Filter: '"enrollment_group_id" = "' + appsheetEscape_(enrollmentGroupId) + '"'
    }) || [];
    const phonesByPerson = {};
    allGuardianPhones.forEach(ph => {
      const pid = ph.person_id;
      if (!pid) return;
      (phonesByPerson[pid] = phonesByPerson[pid] || []).push(ph);
    });
    guardians.forEach(g => {
      const phones = phonesByPerson[g.person_id] || [];
      const hasValidPhone = phones.some(ph => {
        let s = String(ph.value || ph.phone_number || '').trim();
        if (s && s[0] !== '+' && /^\d+$/.test(s)) s = '+' + s;   // P259: AppSheet quita el +
        return /^\+[1-9]\d{6,14}$/.test(s);                       // E.164 estricto tras normalizar
      });
      if (!hasValidPhone) {
        const e = new Error('Each guardian needs at least one valid E.164 phone');
        e.code = 'INVALID_PHONE';
        throw e;
      }
    });
  }

  // ── Identify the requester (first guardian) if not yet recorded ────────────
  if (!group.requester_person_id && guardians.length) {
    appsheetRequest_(T.ENROLLMENT_GROUPS, 'Edit', [{
      enrollment_group_id:    enrollmentGroupId,
      requester_person_table: 'enrPersons',
      requester_person_id:    guardians[0].person_id,
      updated_at:             now,
    }]);
  }

  // ── Create one enrEnrollments row per applicant (or update if re-submitting) ──
  // When a staff member reverts an application to IN and the family re-submits,
  // existing enrollment rows must be updated to RQ state rather than duplicated.
  const existingEnrollments = appsheetRequest_(T.ENROLLMENTS, 'Find', [], {
    Filter: '"enrollment_group_id" = "' + appsheetEscape_(enrollmentGroupId) + '"'
  }) || [];
  // Map applicant_person_id → existing enrollment_id for quick lookup
  const existingByApplicant = {};
  existingEnrollments.forEach(function(e) {
    if (e.applicant_person_id) existingByApplicant[e.applicant_person_id] = e.enrollment_id;
  });

  const desiredStartDate = p.desired_start_date || null;
  const enrollmentIds = [];
  applicants.forEach(applicant => {
    const existingId = existingByApplicant[applicant.person_id];
    const enrollmentId = existingId || generateUuid_();
    // submitted_at lives on enrEnrollmentGroups (the session header), NOT on
    // each enrEnrollments row — DL-E15. The per-enrollment "submitted" moment
    // is reflected by current_state_id transitioning to RQ (logged in
    // sysStateTransitionLog below). AppSheet rejected the whole row silently
    // when we tried to write submitted_at here ("'submitted_at' is not a
    // valid table column name") — caught 2026-05-18 by Diego's first
    // end-to-end test.
    if (existingId) {
      // Re-submit: update existing enrollment to RQ state
      appsheetRequest_(T.ENROLLMENTS, 'Edit', [{
        enrollment_id:      enrollmentId,
        current_state_id:   rqStateId,
        desired_start_date: desiredStartDate,
        updated_at:         now,
      }]);
    } else {
      appsheetRequest_(T.ENROLLMENTS, 'Add', [{
        enrollment_id:          enrollmentId,
        enrollment_group_id:    enrollmentGroupId,
        program_id:             group.program_id || null,
        school_id:              SCHOOL_ID,
        applicant_person_table: 'enrPersons',
        applicant_person_id:    applicant.person_id,
        current_state_id:       rqStateId,
        desired_start_date:     desiredStartDate,
        source_locale:          group.preferred_language || group.source_locale || 'es',
        created_at:             now,
        updated_at:             now,
      }]);
    }
    enrollmentIds.push(enrollmentId);

    // Per-enrollment state transition log entry (null → RQ).
    // mode_actually_used='MANUAL': the wizard submit IS the user's manual
    // action that triggers this transition; AUTOMATIC is reserved for
    // handler-fired transitions (timer expirations, upstream completion).
    // Consistent with the other transition log writes in this codebase
    // (promoteEnrollment_, the staff state-change flow) which also use MANUAL.
    appsheetRequest_(T.STATE_TRANSITION_LOG, 'Add', [{
      log_id:             generateUuid_(),
      school_id:          SCHOOL_ID,
      entity_type_code:   'ENR_ADMISSION_SCHOOL',
      entity_id:          enrollmentId,
      transition_id:      null,
      from_state_id:      null,
      to_state_id:        rqStateId,
      mode_actually_used: 'MANUAL',
      transitioned_by:    'SYSTEM:WIZARD',
      transitioned_at:    now,
      notes:              'Enrollment requested by family',
      created_at:         now,
      created_by:         'SYSTEM:WIZARD',
    }]);

    // ── P71 fix — dual-write canónico DL-S37 §workflow ────────────────────────
    // El Add anterior ya intenta escribir current_state_id, pero AppSheet
    // ha rechazado silenciosamente este campo en otras escrituras del wizard
    // (precedente: submitted_at, caught 2026-05-18 — ver comentario ~línea 1202).
    // Aplicar Edit explícito como en saveStep_ case 'review' y promoteEnrollment_.
    // Idempotente: si AppSheet ya escribió rqStateId en el Add, el Edit no
    // cambia nada; si no lo escribió, el Edit lo corrige.
    appsheetRequest_(T.ENROLLMENTS, 'Edit', [{
      enrollment_id:    enrollmentId,
      current_state_id: rqStateId,
      updated_at:       now,
    }]);
  });

  // ── Mark the group as submitted ────────────────────────────────────────────
  appsheetRequest_(T.ENROLLMENT_GROUPS, 'Edit', [{
    enrollment_group_id: enrollmentGroupId,
    submitted_at:        now,
    updated_at:          now,
  }]);

  const lang = p.language || group.preferred_language || 'es';

  // ── Log GDPR + legal consents (per enrollment) ─────────────────────────────
  // sysConsentsLog (DL-S44): polymorphic on entity_type_code + entity_id.
  // Signer: first guardian of the session (the family representative who submitted).
  // The GDPR consent that the family accepted on the consent page (deferred at
  // init time) is also recorded here, once per enrollment, alongside any
  // additional consents from the review step.
  const signerPersonId = guardians[0] ? guardians[0].person_id : null;
  let consentRows = [];
  const consents = Array.isArray(p.consents) ? p.consents.slice() : [];
  // Map legacy frontend consent type strings to canonical sysConsentsLog codes.
  // Frontend sends 'gdpr'; 'gdpr_data_processing' is a legacy alias.
  const CONSENT_TYPE_MAP = {
    gdpr:                  'GDPR_SCHOOL',
    gdpr_data_processing:  'GDPR_SCHOOL',
    image_rights:          'IMAGE_RIGHTS',
    commercial_comms:      'COMMERCIAL_COMMS',
    platform_groups:       'PLATFORM_GROUPS',
  };
  function canonicalConsentType_(raw) {
    return CONSENT_TYPE_MAP[raw] || raw.toUpperCase();
  }

  // Ensure GDPR consent is captured even if frontend forgot to include it
  if (!consents.some(c => c.type === 'gdpr' || c.type === 'gdpr_data_processing')) {
    consents.push({
      type: 'gdpr',
      accepted: true,
      consent_text_shown: CONSENT_TEXTS.gdpr.en + '\n\n' + CONSENT_TEXTS.gdpr.es,
    });
  }
  enrollmentIds.forEach(eid => {
    consents.forEach(c => {
      consentRows.push({
        consent_id:             generateUuid_(),
        school_id:              SCHOOL_ID,
        entity_type_code:       'ENR_ADMISSION_SCHOOL',
        entity_id:              eid,
        signer_table:           'enrPersons',
        signer_id:              signerPersonId,
        consent_type:           canonicalConsentType_(c.type),
        consent_use:            null,
        consented:              c.accepted,
        consent_text_shown:     c.consent_text_shown || (CONSENT_TEXTS[c.type] && CONSENT_TEXTS[c.type][lang]) || null,
        consent_text_version:   'v1',
        language:               lang,
        signed_method:          'WIZARD_CLICK_AND_SIGN',
        evidence_document_id:   null,
        signing_session_id:     null,
        consent_timestamp:      now,
        ip_address:             null,
        user_agent:             null,
        evidence_metadata_json: null,
        tsa_seal_id:            null,
        tsa_seal_timestamp:     null,
        created_at:             now,
        created_by:             'SYSTEM:WIZARD',
      });
    });
  });
  if (consentRows.length) appsheetRequest_(T.CONSENTS_LOG, 'Add', consentRows);

  // (Local var renamed to keep downstream PDF / email code unchanged below)
  const app = group;  // alias to minimise the diff in email/PDF builders

  // Enrich guardians with emails and phones for notifications
  const gPersonIds = guardians.map(g => g.person_id);
  // enrPersonEmails / enrPersonPhones deleted 2026-05-17 — notification enrichment unavailable.
  // Guardian primary_email from enrEnrollmentGroups is still used for magic links / receipts.
  const gEmailJoins = [];
  const gPhoneJoins = [];

  const gEmailIds = gEmailJoins.map(r => r.email_id).filter(Boolean);
  const gPhoneIds = gPhoneJoins.map(r => r.phone_id).filter(Boolean);
  const gEmailMap = {};
  if (gEmailIds.length) {
    (appsheetRequest_(T.EMAILS, 'Find', [], {
      Filter: gEmailIds.map(x => '"email_id" = "' + appsheetEscape_(x) + '"').join(' || ')
    }) || []).forEach(r => { gEmailMap[r.email_id] = r; });
  }
  const gPhoneMap = {};
  if (gPhoneIds.length) {
    (appsheetRequest_(T.PHONES, 'Find', [], {
      Filter: gPhoneIds.map(x => '"phone_id" = "' + appsheetEscape_(x) + '"').join(' || ')
    }) || []).forEach(r => { gPhoneMap[r.phone_id] = r; });
  }
  const enrichedGuardians = guardians.map(g => ({
    ...g,
    emails: gEmailJoins.filter(r => r.person_id === g.person_id).map(r => ({ ...r, ...(gEmailMap[r.email_id] || {}) })),
    phones: gPhoneJoins.filter(r => r.person_id === g.person_id).map(r => ({ ...r, ...(gPhoneMap[r.phone_id] || {}) })),
  }));

  // NOTE (IMPL-H): the guardian E.164 phone gate moved UP — it now runs as part
  // of the CLOSING VALIDATION block BEFORE any write (W1), reading real phones
  // from enrPhones (W2 / SOSPECHA-2 fix). It is intentionally gone from here so
  // no write precedes the validation. See the block right after the applicant
  // check above.

  // Fetch QB responses for enrollment-specific questions (profession, employer, adaptation)
  const enrQbIds = [QB_PROFESSION_ID, QB_EMPLOYER_ID, QB_HAS_ADAPTATION_ID, QB_ADAPTATION_NOTES_ID];
  const qbResRows = appsheetRequest_(T.QB_RESPONSES, 'Find', [], {
    Filter: '(' + [enrollmentGroupId].concat(enrollmentIds).map(rid => '"respondent_id" = "' + appsheetEscape_(rid) + '"').join(' || ') + ') && (' +
      enrQbIds.map(id => '"question_id" = "' + appsheetEscape_(id) + '"').join(' || ') + ')'
  }) || [];
  // Map question_id → last response_text (aggregates multiple if more than one respondent)
  const qbResponseMap = {};
  qbResRows.forEach(r => { qbResponseMap[r.question_id] = r.response_text; });

  // P262 (2026-06-25) — ELIMINADA la generación del "Signed Consent Record" PDF en el submit.
  // Por el principio de Diego (el wizard NO fabrica documentos; el motor del KMS genera) y tras
  // una auditoría read-only cross-repo: este PDF era REDUNDANTE — los consentimientos GDPR ya se
  // persisten CANÓNICAMENTE en `sysConsentsLog` (handler KMS `enr_submitGdprConsents`, Step 9: 24
  // campos por consentimiento incl. texto mostrado, versión, persona, timestamp, IP/UA y SELLO
  // TSA criptográfico). El PDF era WRITE-ONLY: NINGÚN lector en NINGUNO de los dos repos lo
  // consume (cero hits de `SIGNED_CONSENT`/`WIZARD_SUBMIT` como evidencia requerida; no se adjunta
  // a emails ni al paquete de firma). Las filas `recFiles` históricas con origin='WIZARD_SUBMIT'
  // quedan intactas (no se borra dato) — solo se deja de escribir y se elimina `generateConsentPdf_`.
  // Cross-ref: kis-app operational-pending §P262 + KMS `enr/signing-status.gs` (sysConsentsLog canónico).

  // Materialise scopes for pre-submit uploads: files captured during Step6
  // have a recFiles row but no recScopes (no enrollment_id existed yet).
  // Now that the N enrollments exist, fan out one scope per (file, enrollment).
  try {
    if (enrollmentIds.length) {
      const preSubmitFiles = appsheetRequest_(T.REC_FILES, 'Find', [], {
        Filter: '"school_id" = "' + appsheetEscape_(SCHOOL_ID) + '" && "origin" = "WIZARD" && "origin_reference" = "' + appsheetEscape_(enrollmentGroupId) + '"'
      }) || [];
      const newScopes = [];
      preSubmitFiles.forEach(f => {
        // Skip any file that already has a scope (idempotency on retry)
        const existing = appsheetRequest_(T.REC_SCOPES, 'Find', [], {
          Filter: '"school_id" = "' + appsheetEscape_(SCHOOL_ID) + '" && "file_id" = "' + appsheetEscape_(f.file_id) + '"'
        }) || [];
        if (existing.length) return;
        enrollmentIds.forEach((eid, i) => {
          newScopes.push({
            scope_id:               generateUuid_(),
            school_id:              SCHOOL_ID,
            file_id:                f.file_id,
            scope_type_code:        'enr_admission_school',
            scope_target_id:        eid,
            is_primary:             i === 0,
            shortcut_drive_file_id: null,
            created_at:             now,
            created_by:             'SYSTEM:WIZARD',
            updated_at:             now,
            updated_by:             'SYSTEM:WIZARD',
          });
        });
      });
      if (newScopes.length) appsheetRequest_(T.REC_SCOPES, 'Add', newScopes);
    }
  } catch (scopeErr) {
    Logger.log('rec scope materialisation error (non-fatal): ' + scopeErr.message);
  }

  // WIZARD-TERMINAL P3: confirmaci\u00f3n a la familia + notificaci\u00f3n interna v\u00eda el motor del
  // KMS (el contenido lo gobierna el KMS). El wizard pre-renderiza los nombres y la tabla.
  // P72: si el KMS falla, el throw propaga y el handler devuelve {ok:false} \u2014 NO cae a
  // Gmail local (single-source). El submit en s\u00ed ya est\u00e1 persistido arriba.
  const applicantNames = applicants.map(a => ((a.first_name || '') + ' ' + (a.last_name || '')).trim()).filter(Boolean).join(', ');
  sendViaKmsNotify_('WIZARD_FAMILY_CONFIRMATION', app.primary_email, {
    family_name:     '',
    applicant_names: applicantNames,
    enrollment_id:   enrollmentGroupId,
  });
  sendViaKmsNotify_('WIZARD_INTERNAL_NOTIFICATION', ADMISSIONS_EMAIL, {
    enrollment_id:    enrollmentGroupId,
    applicants_table: _kmsRenderApplicantsTable_(enrollmentGroupId, now, enrichedGuardians, applicants, app, qbResponseMap),
  });

  return {
    submitted:           true,
    enrollment_group_id: enrollmentGroupId,
    enrollment_ids:      enrollmentIds,
    // legacy alias \u2014 frontend builds reading application_id keep working
    application_id:      enrollmentGroupId,
  };
}

/**
 * Generates and emails a 6-digit verification code.
 *
 * Cache key uses the enrollment_group_id (accepts legacy application_id alias).
 *
 * @param {Object} p - { enrollment_group_id?|application_id?, primary_email }
 */
/**
 * Sends HTML email from the admissions@ alias via Gmail Advanced Service (raw RFC822).
 * Uses only gmail.send scope — avoids the Settings API scope escalation that
 * GmailApp.sendEmail triggers when sending from a non-primary alias.
 * The blank line separating headers from body is explicit (not filtered) so
 * Gmail can locate the body correctly.
 */
function sendAsAlias_(toEmail, subject, htmlBody, replyTo) {
  // DBG-TRACE: duración del envío de email (Gmail alias / fallback MailApp).
  var _dbgM0 = Date.now();
  _dbgEv_('mail_send', 'start');
  // KAL-NEW-13 (2026-06-06): robust delivery. The OTP step-up (DL-E39) surfaced
  // that a single un-caught failure inside the Gmail Advanced Service (alias not
  // configured as "Send mail as", advanced service disabled, transient Gmail
  // error) made the *whole* email silently fail to arrive — the family clicks
  // "send code" and nothing reaches the inbox. We now: (1) try the canonical
  // admissions@ alias send, (2) on ANY failure fall back to MailApp.sendEmail
  // from the deployer account so the message STILL gets delivered, and (3) log
  // the outcome (redacted, KAL-11) so the path is observable in Stackdriver.
  // Throw only if BOTH paths fail, so the dispatcher returns a clear error
  // instead of a happy { ok:true } over a message that never left.
  try {
    const encodedBody = Utilities.base64Encode(htmlBody, Utilities.Charset.UTF_8);
    const headers = [
      'From: ' + FROM_NAME + ' <' + ADMISSIONS_EMAIL + '>',
      'To: ' + toEmail,
      ...(replyTo ? ['Reply-To: ' + replyTo] : []),
      'Subject: =?UTF-8?B?' + Utilities.base64Encode(subject, Utilities.Charset.UTF_8) + '?=',
      'MIME-Version: 1.0',
      'Content-Type: text/html; charset=UTF-8',
      'Content-Transfer-Encoding: base64',
    ];
    const raw = Utilities.base64EncodeWebSafe(
      headers.join('\r\n') + '\r\n\r\n' + encodedBody
    ).replace(/=+$/, '');
    Gmail.Users.Messages.send({ raw: raw }, 'me');
    _dbgEv_('mail_sent', 'alias ' + (Date.now() - _dbgM0) + 'ms');
    Logger.log(redact_('[sendAsAlias_] sent via alias to=' + toEmail + ' subject=' + subject));
  } catch (aliasErr) {
    Logger.log(redact_('[sendAsAlias_] alias send FAILED (' + (aliasErr && aliasErr.message) +
      ') — falling back to MailApp deployer account for to=' + toEmail));
    try {
      MailApp.sendEmail({
        to: toEmail,
        subject: subject,
        htmlBody: htmlBody,
        name: FROM_NAME,
        ...(replyTo ? { replyTo: replyTo } : {}),
      });
      Logger.log(redact_('[sendAsAlias_] sent via MailApp fallback to=' + toEmail));
    } catch (fallbackErr) {
      Logger.log(redact_('[sendAsAlias_] BOTH alias and MailApp send failed for to=' + toEmail +
        ' — alias:' + (aliasErr && aliasErr.message) + ' fallback:' + (fallbackErr && fallbackErr.message)));
      const err = new Error('Email could not be delivered (alias + fallback both failed)');
      err.code = 'EMAIL_SEND_FAILED';
      throw err;
    }
  }
}

function sendVerificationCode_(p) {
  let enrollmentGroupId;
  let primary_email;

  if (p && p.stepup === true) {
    // ── DL-E39 step-up: re-verifica acceso-al-inbox antes de revelar/mutar PII.
    // KAL-4: el grupo SIEMPRE se deriva del bearer token (resume_token o
    // signing_token), NUNCA del payload. El email destino se resuelve
    // server-side leyendo el grupo — NUNCA del payload, para que un atacante
    // no pueda redirigir el código a su propio buzón.
    const ctx = _resolveStepUpGroup_(p);
    enrollmentGroupId = ctx.enrollment_group_id;
    if (!enrollmentGroupId) {
      const errBad = new Error('Unauthorized: token resolved to no group');
      errBad.code = 'UNAUTHORIZED';
      throw errBad;
    }
    const grpRows = appsheetRequest_(T.ENROLLMENT_GROUPS, 'Find', [], {
      Filter: '"enrollment_group_id" = "' + appsheetEscape_(enrollmentGroupId) + '"'
    });
    primary_email = grpRows && grpRows[0] && grpRows[0].primary_email;
    if (!primary_email) {
      const errNoEmail = new Error('No primary_email on file for this group');
      errNoEmail.code = 'BAD_REQUEST';
      throw errNoEmail;
    }
  } else {
    // ── Flujo NO-stepup (signup inicial): comportamiento intacto. El grupo y el
    // email vienen del payload (la familia aún no tiene token de sesión).
    enrollmentGroupId = p.enrollment_group_id || p.application_id;
    primary_email     = p.primary_email;
    if (!enrollmentGroupId || !primary_email) throw new Error('Missing enrollment_group_id or primary_email');
  }

  // Rate-limit antes de generar/enviar (throw RATE_LIMITED).
  // KAL-NEW-13 (2026-06-06): el step-up usa su PROPIO bucket (`stepup_count_<group>`,
  // cap 8/h) — NO el de magic-link. Compartirlo agotaba el cupo (5/h) tras un par de
  // recuperaciones + revelados y el OTP dejaba de llegar ("el código no llega"). El
  // signup inicial mantiene el bucket de magic-link por-email (anti-abuso de enlaces).
  if (p && p.stepup === true) {
    _checkStepUpCodeRateLimit_(enrollmentGroupId);
  } else {
    _checkMagicLinkRateLimit_(primary_email.toLowerCase().trim());
  }

  // KAL-NEW-2.a (audit 2026-05-30): código de 6 dígitos CSPRNG-grade. Math.random() es un
  // PRNG no-criptográfico cuyo estado se puede inferir; Utilities.getUuid() es crypto-grade
  // (mismo criterio que KAL-1 generateUuid_). Tomamos 8 hex chars → módulo al rango 6-díg
  // manteniendo la forma UX (XXXXXX).
  const uuidHex = Utilities.getUuid().replace(/-/g, '').slice(0, 8);
  const code = (100000 + (parseInt(uuidHex, 16) % 900000)).toString();
  const cache = CacheService.getScriptCache();
  cache.put('verify_' + enrollmentGroupId, code, 600); // 10 min TTL

  const lang = p.preferred_language || 'es';
  // WIZARD-TERMINAL P4 (P253): el render+env\u00edo del email OTP lo gobierna el KMS v\u00eda el
  // endpoint S\u00cdNCRONO sys-public.sendAuthCode (el c\u00f3digo NO se persiste en sysNotificationLog).
  // La generaci\u00f3n/cache/rate-limit del c\u00f3digo siguen AQU\u00cd (l\u00f3gica de auth) \u2014 solo el email
  // sale por el KMS. Sin fallback local: si el KMS falla, el throw propaga \u2192 {ok:false}.
  sendViaKmsAuthCode_(primary_email, { OTP_CODE: code, LANG: lang });

  return { sent: true };
}

/**
 * Verifies a 6-digit code.
 *
 * Per DL-E15 the legacy `email_confirmed` / `email_confirmed_at` columns are
 * eliminated (modeled as an EMAIL_VERIFICATION milestone, out of wizard scope).
 * Stage-1: we only validate the code from cache and return success. No DB
 * write is performed. The cache key uses enrollment_group_id (legacy
 * application_id accepted).
 *
 * @param {Object} p - { enrollment_group_id?|application_id?, code }
 */
function verifyEmail_(p) {
  // DL-E39 step-up: si p.stepup, el group se deriva del bearer token server-side
  // (KAL-4), ignorando el group del payload. El cache de código/lockout ya quedó
  // emitido bajo ese mismo group por sendVerificationCode_ (rama stepup).
  let enrollmentGroupId;
  if (p && p.stepup === true) {
    enrollmentGroupId = _resolveStepUpGroup_(p).enrollment_group_id;
    if (!enrollmentGroupId) {
      const errBad = new Error('Unauthorized: token resolved to no group');
      errBad.code = 'UNAUTHORIZED';
      throw errBad;
    }
  } else {
    enrollmentGroupId = p.enrollment_group_id || p.application_id;
  }
  const code = p.code;
  if (!enrollmentGroupId || !code) throw new Error('Missing enrollment_group_id or code');

  const cache    = CacheService.getScriptCache();

  // KAL-NEW-2.b: lockout de intentos (anti fuerza-bruta 10^6). 5 intentos fallidos
  // por group → TOO_MANY_ATTEMPTS sin revelar si el código era correcto. TTL 10 min
  // (mismo que el código). Acierto → borra contador + código.
  const attemptsKey = 'verify_attempts_' + enrollmentGroupId;
  const attempts = parseInt(cache.get(attemptsKey) || '0', 10);
  if (attempts >= 5) {
    const errLock = new Error('Too many verification attempts; request a new code');
    errLock.code = 'TOO_MANY_ATTEMPTS';
    throw errLock;
  }

  const stored = cache.get('verify_' + enrollmentGroupId);
  if (!stored) throw new Error('Verification code expired or not found');
  if (stored !== code.toString()) {
    cache.put(attemptsKey, String(attempts + 1), 600);
    throw new Error('Invalid verification code');
  }

  cache.remove(attemptsKey);
  cache.remove('verify_' + enrollmentGroupId);

  // DL-E39 step-up: acierto en flujo step-up → marca el grupo como fresco
  // durante STEPUP_INACTIVITY_MS. Los handlers de PII (assertStepUpFresh_)
  // pasarán hasta que la ventana expire. (Flujo NO-stepup intacto.)
  if (p && p.stepup === true) {
    _markStepUpFresh_(enrollmentGroupId, 'OTP');
  }

  // No DB write — `email_confirmed` columns are removed in DL-E15. The
  // EMAIL_VERIFICATION milestone (sysMilestones) will replace this when wired.
  return { verified: true };
}

/**
 * AppSheet almacena booleanos como "Y"/"N" (no true/false). Normaliza a boolean
 * JS los valores que AppSheet devuelve para columnas Yes/No. Usar SIEMPRE para
 * evaluar is_active y similares en memoria — nunca filtrar `= true` server-side.
 * @private
 */
function qbTruthy_(v) {
  return v === true || v === 'Y' || v === 'true' || v === 'TRUE' || v === '1';
}

/**
 * Fetches a question set with all translations, options, and conditions.
 *
 * Lookup uses qbContexts.context_code (stable UPPER_SNAKE id), not designation
 * (human-readable string subject to renaming/casing drift). Input is normalized
 * to UPPER + trim before the AppSheet Filter so case mismatches are impossible.
 * For backwards compat the legacy param name `context_designation` is still
 * accepted but treated as a code (must satisfy UPPER_SNAKE whitelist post-norm).
 *
 * @param {Object} p - { context_code, language } (legacy: context_designation)
 * @returns {Object} Nested question set structure
 */
function fetchQuestions_(p) {
  const raw = p.context_code != null ? p.context_code : p.context_designation;
  if (raw == null || raw === '') throw new Error('Missing context_code');
  if (typeof raw !== 'string') {
    throw new Error('Invalid context_code: ' + JSON.stringify(raw));
  }
  const contextCode = raw.trim().toUpperCase();
  // KAL-5 defense-in-depth: whitelist regex prevents injection. UPPER_SNAKE:
  // 1-64 chars, starts with letter, then letters/digits/underscore. El motor
  // qb-core re-valida, pero validamos aquí primero para fail-fast antes de la red.
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(contextCode)) {
    throw new Error('Invalid context_code: ' + JSON.stringify(raw));
  }

  const lang = p.language || 'es';

  // ── Q05-S5 (DL-Q05): proxy thin a KMS qb-public.resolveSetForConsumer ────
  // El motor reusable vive en kis-app/kms-server/qb/qb-core.gs y se expone
  // via doPost del KMS bajo `qb-public.resolveSetForConsumer` con auth por
  // service token. Script Properties `KMS_DEPLOYMENT_URL` + `QB_SERVICE_TOKEN`
  // son REQUERIDAS — el path legacy AppSheet fue eliminado (W1, 2026-06-11).
  const props        = PropertiesService.getScriptProperties();
  const kmsUrl       = props.getProperty('KMS_DEPLOYMENT_URL');
  const serviceToken = props.getProperty('QB_SERVICE_TOKEN');
  if (!kmsUrl || !serviceToken) {
    throw new Error('fetchQuestions_: Script Properties KMS_DEPLOYMENT_URL y QB_SERVICE_TOKEN son requeridas (path legacy eliminado W1-2026-06-11)');
  }

  if (kmsUrl && serviceToken) {
    const kmsPayload = {
      action: 'qb-public.resolveSetForConsumer',
      payload: {
        service_token: serviceToken,
        consumer_code: 'ADMISSIONS_WIZARD',
        context_code:  contextCode,
        receptor:      { locale: lang },
        school_id:     SCHOOL_ID,
      },
      requestId: generateUuid_(),
    };

    // El KMS es `access: ANYONE` → Google exige login de plataforma ANTES del
    // doPost. Sin el header Authorization, el POST se redirige a la página de
    // sign-in (HTML) → HTTP 401 y nunca llega al dispatcher qb-public. El Bearer
    // OAuth token autentica como la cuenta deployadora del wizard y pasa ese gate;
    // la auth de aplicación sigue siendo el service_token del payload. Mismo patrón
    // que kmsProxy_ (commit 7851f2a) — fetchQuestions_ había quedado sin él, así que
    // al activarse el path KMS (Script Properties puestas) las preguntas daban 401.
    const httpResp = UrlFetchApp.fetch(kmsUrl, {
      method:             'post',
      contentType:        'text/plain',
      headers:            { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      payload:            JSON.stringify(kmsPayload),
      followRedirects:    true,
      muteHttpExceptions: true,
    });

    const status = httpResp.getResponseCode();
    const text   = httpResp.getContentText();
    if (status !== 200) {
      throw new Error('KMS qb-public HTTP ' + status + ': ' + redact_(text.slice(0, 200)));
    }
    let envelope;
    try {
      envelope = JSON.parse(text);
    } catch (parseErr) {
      throw new Error('KMS qb-public: non-JSON response: ' + redact_(text.slice(0, 200)));
    }
    if (!envelope || envelope.success !== true) {
      const errPayload = envelope && envelope.error ? envelope.error : { code: 'UNKNOWN', message: 'no error object' };
      throw new Error('KMS qb-public ' + errPayload.code + ': ' + errPayload.message);
    }

    return fetchQuestions_adaptKmsResponse_(envelope.data, lang);
  }
}

/**
 * Diagnostic — vuelca el shape REAL que devuelve fetchQuestions_ para confirmar:
 *   - response_type_id es UUID o code legible (afecta render del tipo).
 *   - qbQuestionConditions guarda condition_operator/value plano O polimórfico
 *     (condition_ref_table/condition_ref_id → qbConditions / qbConditionGroups_T).
 *   - qbResponseTypes shape (qué columna tiene el code: 'response_type_code', 'code'...).
 * Aplica protocolo §0.bis del plan: dato real antes de fix.
 */
function manual_diagQbRenderShape() {
  Logger.log('=== manual_diagQbRenderShape ===');

  // [A] qbResponseTypes — necesitamos saber la columna que guarda el code legible.
  const rt = appsheetRequest_('qbResponseTypes', 'Find', [], {}) || [];
  Logger.log('[A] qbResponseTypes: ' + rt.length + ' rows');
  if (rt[0]) Logger.log('     KEYS=' + Object.keys(rt[0]).join(',') + ' | ROW0=' + JSON.stringify(rt[0]));

  // [B] qbQuestions — qué guarda response_type_id (uuid o code).
  const q = appsheetRequest_(T.QB_QUESTIONS, 'Find', [], {
    Filter: '"school_id" = "' + SCHOOL_ID + '"'
  }) || [];
  Logger.log('[B] qbQuestions: ' + q.length + ' rows');
  if (q[0]) Logger.log('     KEYS=' + Object.keys(q[0]).join(',') + ' | response_type_id=' + JSON.stringify(q[0].response_type_id) + ' | question_code=' + q[0].question_code);

  // [C] qbQuestionConditions — shape (polimórfico o plano).
  const cond = appsheetRequest_(T.QB_CONDITIONS, 'Find', [], {}) || [];
  Logger.log('[C] qbQuestionConditions: ' + cond.length + ' rows');
  if (cond[0]) Logger.log('     KEYS=' + Object.keys(cond[0]).join(',') + ' | ROW0=' + JSON.stringify(cond[0]));

  // [D] Si C tiene condition_ref_table, qué hay al otro lado:
  if (cond[0] && cond[0].condition_ref_table) {
    const refTable = cond[0].condition_ref_table;
    const refId = cond[0].condition_ref_id;
    Logger.log('[D] condition es polimórfica → resolver ' + refTable + ' id=' + refId);
    try {
      const ref = appsheetRequest_(refTable, 'Find', [], {}) || [];
      const match = ref.find(r => r[Object.keys(r)[0]] === refId || JSON.stringify(r).indexOf(refId) >= 0);
      if (match) Logger.log('     RESOLVED=' + JSON.stringify(match));
      else Logger.log('     no match en ' + refTable + ' (' + ref.length + ' filas totales)');
    } catch (e) { Logger.log('     error: ' + e.message); }
  }

  Logger.log('=== fin diag ===');
}

/**
 * Diagnostic del wizard (NO registrado en el dispatcher público — JSDoc Diagnostic).
 * Loguea el valor real de is_active/deleted_at para detectar quirks de filtro
 * server-side AppSheet (null vs "").
 */
function manual_diagFetchQuestions() {
  const cc = 'ENROLLMENT';
  Logger.log('=== manual_diagFetchQuestions (context_code=' + cc + ', school=' + SCHOOL_ID + ') ===');

  // ── Paso 1: qbContexts con el filtro completo del wizard ──────────────────
  const ctxFull = appsheetRequest_(T.QB_CONTEXTS, 'Find', [], {
    Filter: '"context_code" = "' + cc + '" && "school_id" = "' + SCHOOL_ID + '" && "is_active" = true'
  }) || [];
  Logger.log('[1] qbContexts (context_code + school_id + is_active=true): ' + ctxFull.length + ' rows');

  // ── Paso 1b: qbContexts SOLO por context_code (sin is_active) ─────────────
  const ctxCodeOnly = appsheetRequest_(T.QB_CONTEXTS, 'Find', [], {
    Filter: '"context_code" = "' + cc + '"'
  }) || [];
  Logger.log('[1b] qbContexts (context_code solo): ' + ctxCodeOnly.length + ' rows');

  // ── Paso 1c: TODOS los contexts, volcar valores reales ────────────────────
  const ctxAll = appsheetRequest_(T.QB_CONTEXTS, 'Find', [], {}) || [];
  Logger.log('[1c] qbContexts TODOS: ' + ctxAll.length + ' rows');
  ctxAll.forEach(c => Logger.log('     code=' + c.context_code + ' school=' + c.school_id +
    ' is_active=' + JSON.stringify(c.is_active) + ' deleted_at=' + JSON.stringify(c.deleted_at) +
    ' context_id=' + c.context_id));

  if (!ctxCodeOnly.length) { Logger.log('STOP: no context matches context_code — fin.'); return; }
  const contextId = ctxCodeOnly[0].context_id;

  // ── Paso 2: qbQuestionSets con el filtro actual del wizard (deleted_at="") ─
  const setsDeleted = appsheetRequest_(T.QB_SETS, 'Find', [], {
    Filter: '"context_id" = "' + contextId + '" && "deleted_at" = ""'
  }) || [];
  Logger.log('[2] qbQuestionSets (context_id + deleted_at=""): ' + setsDeleted.length + ' rows');

  // ── Paso 2b: qbQuestionSets SOLO por context_id ───────────────────────────
  const setsCtxOnly = appsheetRequest_(T.QB_SETS, 'Find', [], {
    Filter: '"context_id" = "' + contextId + '"'
  }) || [];
  Logger.log('[2b] qbQuestionSets (context_id solo): ' + setsCtxOnly.length + ' rows');

  // ── Paso 2c: TODOS los sets, volcar context_id + deleted_at reales ────────
  const setsAll = appsheetRequest_(T.QB_SETS, 'Find', [], {}) || [];
  Logger.log('[2c] qbQuestionSets TODOS: ' + setsAll.length + ' rows');
  setsAll.forEach(s => Logger.log('     set_code=' + s.set_code + ' context_id=' + s.context_id +
    ' deleted_at=' + JSON.stringify(s.deleted_at) + ' current_state_id=' + JSON.stringify(s.current_state_id)));

  Logger.log('=== fin diag ===');
}


/**
 * STOPGAP P116 — deriva `audience_category_id` desde el `question_code`.
 *
 * Limitación documentada Q05-S5 (ver `fetchQuestions_adaptKmsResponse_` infra):
 * el motor qb-core NO emite audience todavía, así que el adapter hardcodeaba
 * `audience_category_id: null`. Eso hacía que QbSetRenderer renderizara TODA
 * pregunta en la rama "general" (`meetsConditions(q, null, ...)`), y como AGE
 * sin `person.date_of_birth` retorna permissive `true`, el filtro de edad
 * quedaba inerte (bug: applicant 4yo veía preguntas AGE>=7).
 *
 * Mapeo por prefijo de `question_code`, derivado de los 5 sets KIS sembrados en
 * `kis-app/kms-server/qb/seeds-kis-admission.gs` (DL-Q04 header):
 *   - hygiene_*        → participant (KIS_HYGIENE_PROTOCOL, applicant_age 3-11)
 *   - voice_*          → participant (KIS_APPLICANT_VOICE, applicant_age >= 7)
 *   - family_values_*  → client      (KIS_FAMILY_VALUES, guardians)
 *   - applicant_*      → client      (KIS_APPLICANT_BACKGROUND — guardians SOBRE el applicant)
 *   - resto (dev_test_*, etc.) → null (general scope; INITIATOR_EMAIL evalúa OK sin persona)
 *
 * P116 cerrado (kis-app deploy @283, runtime filtering qbAudienceRules a nivel de
 * set) retiró la necesidad de este helper en el path canónico KMS. El helper
 * SOBREVIVE como stopgap P116 para el adapter `fetchQuestions_adaptKmsResponse_`
 * (que corre sobre la respuesta del KMS). Eliminar cuando el KMS exponga
 * audience_category_id canónica vía qbAudienceRules (Q05-S6 / CLI QB-4).
 * El path legacy AppSheet fue eliminado (W1, 2026-06-11).
 * NO inventar prefijos sin evidencia en el seeder.
 *
 * @param {string} code  question_code de la pregunta
 * @returns {string|null} 'participant' | 'client' | null
 * @private
 */
function deriveAudienceCategoryId_(code) {
  if (!code) return null;
  var c = String(code).toLowerCase();
  // Participant-scoped (preguntas sobre/del niño/a — su edad gobierna el filtro AGE):
  if (/^(hygiene_|voice_)/.test(c)) return 'participant';
  // Client-scoped (las responde el guardián adulto):
  if (/^(family_values_|applicant_)/.test(c)) return 'client';
  // Default null (general / unscoped — comportamiento previo).
  return null;
}


/**
 * Adapta la response del motor qb-core del KMS al shape legacy que el
 * frontend `QbSetRenderer` ya consume hoy (Step5Questions + Step7Review).
 *
 * KMS qb-core (Q05-S1) devuelve:
 *   { consumer_code, context_code, context_id, locale,
 *     sets: [{ set_id, set_code, designation, description, is_default_for_context,
 *              questions: [{ question_id, question_code, response_type_code,
 *                            designation, description, is_required, sequence,
 *                            answer_options: [{ option_id, option_value, display_order, designation, description }],
 *                            conditions: [{ question_condition_id, condition_ref_table, condition_ref_id }] }] }] }
 *
 * Wizard frontend espera (legacy shape pre-Q05-S5):
 *   { context, sets: [{ ...s, items: [{ ..., question: { ..., question_text, help_text,
 *                                                       placeholder_text, options: [{ ..., text }],
 *                                                       conditions: [...], response_type_id,
 *                                                       audience_category_id, is_required } }] }] }
 *
 * Mapeo aplicado:
 *   - q.designation                   → question.question_text
 *   - q.description                   → question.help_text (placeholder_text vacío — KMS no expone aún)
 *   - q.response_type_code            → question.response_type_id (lowercased; el render hace toLowerCase)
 *   - q.answer_options[i].designation → option.text
 *   - q.answer_options[i].option_value → option.option_value (passthrough)
 *   - q.conditions                    → question.conditions (passthrough — condition_ref_table/_id)
 *   - set.questions[i] (with sequence)→ set.items[j].question (con item.display_order = sequence)
 *
 * Limitación conocida Q05-S5: el motor qb-core hoy NO devuelve
 * `audience_category_id` (campo del fork legacy que QbSetRenderer usa para
 * fan-out per applicant / per guardian). En el path KMS, las preguntas se
 * renderizan como "general" (clave única = question_id__groupId). El
 * fan-out completo llega en Q05-S6 (DL-Q05) cuando audience filtering
 * server-side esté en qbAudienceRules + el motor pase el discriminador.
 *
 * @param {Object} kmsData — payload `data` del envelope KMS
 * @param {string} lang    — locale solicitado (passthrough en context)
 * @returns {Object}       — shape legacy fetchQuestions_
 * @private
 */
function fetchQuestions_adaptKmsResponse_(kmsData, lang) {
  if (!kmsData) return { sets: [] };

  const ctx = {
    context_id:    kmsData.context_id,
    context_code:  kmsData.context_code,
    designation:   kmsData.context_code,
    is_active:     true,
  };

  const sets = (kmsData.sets || []).map(s => {
    const items = (s.questions || []).map((q, idx) => {
      const options = (q.answer_options || []).map(o => ({
        option_id:     o.option_id,
        question_id:   q.question_id,
        option_value:  o.option_value,
        display_order: Number(o.display_order) || 0,
        is_active:     true,
        text:          o.designation || o.option_value || '',
      }));

      const adaptedQuestion = {
        question_id:        q.question_id,
        question_code:      q.question_code || null,
        // Render del frontend hace .toLowerCase() sobre response_type_id;
        // mantenemos el response_type_code crudo (es UPPER_SNAKE como BOOLEAN/SELECT/...).
        response_type_id:   q.response_type_code || 'text',
        response_type_code: q.response_type_code || null,
        is_required:        !!q.is_required,
        // P116 cerrado (KMS deploy @283 commit kis-app e9a424a): el engine
        // qb_resolveSetForConsumer aplica runtime filtering qbAudienceRules a
        // nivel de SET server-side, por lo que el filtro AGE ya descarta sets
        // no-aplicables antes de llegar al frontend. Aquí pasamos el campo
        // canónico que emita el KMS (puede ser null mientras Q05-S6 / CLI QB-4
        // no añadan audience_category_id per pregunta — informativo, no
        // determinante para filtrado).
        audience_category_id: q.audience_category_id || null,
        question_text:    q.designation  || '',
        help_text:        q.description  || '',
        placeholder_text: '',
        options:          options,
        conditions:       q.conditions   || [],
      };

      return {
        set_id:        s.set_id,
        question_id:   q.question_id,
        display_order: Number(q.sequence) || idx,
        question:      adaptedQuestion,
      };
    });

    return {
      set_id:                 s.set_id,
      set_code:               s.set_code || null,
      context_id:             kmsData.context_id,
      designation:            s.designation || '',
      description:            s.description || '',
      is_active:              true,
      is_default_for_context: !!s.is_default_for_context,
      items:                  items,
    };
  });

  return { context: ctx, sets: sets };
}

/**
 * Fetches lookup options for health fields (allergies, dietary, medical).
 * @returns {{ allergies: Array, dietary: Array, medical: Array }}
 */
function fetchLookups_() {
  // Thin-client (DL-E41 / WPERF-3): los catálogos del wizard (sin PII) los sirve el
  // KMS — el wizard deja de leer AppSheet directo. kmsProxy_ añade service_token +
  // Bearer OAuth; el KMS (enr.wizardFetchLookups) los valida y devuelve el mismo shape
  // { allergies, dietary, medical, relationTypes, programs } de { id, label }, con las
  // fechas de programa ya normalizadas server-side.
  return kmsProxy_('enr.wizardFetchLookups', { school_id: SCHOOL_ID });
}

/**
 * Batch-writes question responses.
 *
 * `respondent_id` defaults to the enrollment_group_id (pre-submit responses
 * are session-scoped). Legacy `application_id` is accepted as alias.
 *
 * @param {Object} p - { enrollment_group_id?|application_id?, respondent_id, respondent_type_category_id, responses: Array }
 */
function saveResponses_(p) {
  // KAL-4: derive authorised group_id from resume_token; never trust the
  // payload's enrollment_group_id directly. Cross-check inside the helper.
  const enrollmentGroupId = requireResumeToken_(p);
  // CLI 26 (2026-06-01) — reject responses for submitted/abandoned groups.
  assertGroupEditable_(enrollmentGroupId);
  // DL-E39 step-up gate: las respuestas del cuestionario son PII del expediente.
  // enrollmentGroupId viene del resume_token (KAL-4), nunca del payload.
  assertStepUpFresh_(enrollmentGroupId);
  _wzCacheInvalidate_(p && p.resume_token); // WIZARD-CACHE: NUNCA servir stale tras un write del grupo
  // ★ SEC-STEPUP (finding #55): NO re-extender la ventana por uso (P-STEPUP-SLIDING retirado — convertía 10 min en infinitos → bypass del PII-gate en recarga).
  const { respondent_id, respondent_type_category_id, responses } = p;
  if (!responses || !responses.length) return { saved: 0 };

  // KAL-4 PER-FILA (RESP-FIX 2026-06-08): las respuestas son per-participante — cada
  // fila lleva su propio `r.respondent_id` (el applicant). Validamos que CADA
  // respondent distinto del group_id (top-level + por fila) pertenezca al grupo del
  // token. El grupo SIEMPRE se deriva del resume_token (enrollmentGroupId), NUNCA del
  // payload. Un solo Find del grupo (KAL-5: appsheetEscape_ en el group_id) + check de
  // pertenencia contra el set de person_ids — evita N Finds y cubre todas las filas.
  var distinctRespondents = {};
  if (respondent_id && respondent_id !== enrollmentGroupId) distinctRespondents[respondent_id] = true;
  responses.forEach(function(r) {
    var rid = r && r.respondent_id;
    if (rid && rid !== enrollmentGroupId) distinctRespondents[rid] = true;
  });
  var respList = Object.keys(distinctRespondents);
  if (respList.length) {
    respList.forEach(function(rid) { assertValidUuid_(rid, 'respondent_id'); });  // KAL-5 capa 1
    var groupPersons = appsheetRequest_(T.PERSONS, 'Find', [], {
      Filter: '"enrollment_group_id" = "' + appsheetEscape_(enrollmentGroupId) + '"'  // KAL-5 capa 2
    }) || [];
    var validPersonIds = {};
    groupPersons.forEach(function(pp) { if (pp && pp.person_id) validPersonIds[pp.person_id] = true; });
    respList.forEach(function(rid) {
      if (!validPersonIds[rid]) {
        var err = new Error('Unauthorized: respondent_id does not belong to token group');
        err.code = 'UNAUTHORIZED';  // doPost → HTTP 200 {ok:false,error:{code,message}} (estructurado, no 403)
        throw err;
      }
    });
  }

  // Thin-client (DL-E41 / WPERF-3): la escritura de qbResponses la hace el KMS (encola
  // ENR_PERSIST_RESPONSES). El wizard valida (KAL-4 per-fila arriba) y proxea; el KMS
  // re-deriva el grupo del resume_token y re-valida que cada respondent ∈ grupo (KAL-4
  // defensa en profundidad). El response_id/responded_at los asigna el KMS.
  const outResponses = responses.map(r => ({
    set_id:                       r.set_id || null,
    question_id:                  r.question_id,
    respondent_id:                r.respondent_id || respondent_id || enrollmentGroupId,
    respondent_type_category_id:  respondent_type_category_id || 'client',
    response_text:                r.response_text || null,
    response_option_id:           r.response_option_id || null,
    response_numeric:             r.response_numeric || null,
    language:                     r.language || 'es',
  }));

  kmsProxy_('enr.wizardSaveResponses', { resume_token: p.resume_token, responses: outResponses });
  return { saved: outResponses.length };
}

/**
 * Maps a wizard document_type to a canonical recTypes_T code.
 * The values on the right must exist in the tenant's recTypes_T catalog
 * (Capa 3, DL-R08). If a document_type is not mapped here it falls through
 * to 'OTHER' — operationally that means the file uploads successfully but
 * sorts to the catch-all bucket.
 */
const REC_TYPE_BY_DOCUMENT_TYPE = {
  passport:              'ID_PASSPORT',
  birth_cert:            'BIRTH_CERTIFICATE',
  report_card:           'SCHOOL_REPORT',
  medical_cert:          'MEDICAL_CERTIFICATE',
  photo:                 'PHOTO_ID',
  signed_consent_record: 'SIGNED_CONSENT',
};

/**
 * Inverse lookup of REC_TYPE_BY_DOCUMENT_TYPE — given a recTypes_T code,
 * returns the wizard's legacy document_type key (used by the Step6 UI to
 * key uploaded files by type). Returns 'other' for unmapped codes.
 * @param {string} recTypeCode
 * @returns {string}
 */
function _docTypeFromRecType_(recTypeCode) {
  const keys = Object.keys(REC_TYPE_BY_DOCUMENT_TYPE);
  for (let i = 0; i < keys.length; i++) {
    if (REC_TYPE_BY_DOCUMENT_TYPE[keys[i]] === recTypeCode) return keys[i];
  }
  return 'other';
}

/**
 * Accepts a base64-encoded file, saves to Drive, writes a recFiles row.
 *
 * DL-R09 / DL-R13: documents now live in the rec* module (canonical):
 *   - recFiles row with status='ACTIVE', origin='WIZARD',
 *     origin_reference=enrollment_group_id (so submit can find pre-submit
 *     uploads of this session) and rec_type_code resolved from the wizard's
 *     legacy document_type.
 *   - recScopes are NOT written here. The canonical scope_type for admissions
 *     ('enr_admission_school' per config/kis/recScopeTypes_T.json) targets
 *     enrEnrollments.enrollment_id, which does not exist pre-submit. Scopes
 *     are materialised by submitEnrollmentSession_, one per applicant enrollment.
 *
 * Idempotency: an upload_idempotency_token (generated by the frontend per
 * file selection) avoids duplicate recFiles rows on retry. If a row already
 * exists with that token, return it.
 *
 * Accepts either `enrollment_group_id` or the legacy `application_id` alias.
 * Post-submit uploads (rare — most uploads happen pre-submit at Step6) pass
 * enrollment_id directly; in that case the primary scope is written immediately.
 *
 * @param {Object} p - { enrollment_id?|enrollment_group_id?|application_id?,
 *                       base64, mimeType, filename, document_type,
 *                       upload_idempotency_token? }
 * @returns {{ file_id: string, document_id: string }}
 *   (document_id is a legacy alias = file_id, kept for frontend compat)
 *   CLI 82 / KAL-NEW-5: drive_url removed — read-back is served on-demand via
 *   getDocument_ (proxy de bytes), never a public Drive link.
 */
function uploadDocument_(p) {
  // KAL-4: derive authorised group_id from resume_token; never trust the
  // payload's enrollment_group_id directly. Cross-check inside the helper.
  const enrollmentGroupId = requireResumeToken_(p);
  // CLI 26 (2026-06-01) — reject uploads for submitted/abandoned groups.
  // The `enrollmentId` branch below covers post-submit uploads where a
  // specific enrollment is targeted; if that enrollment exists, the group
  // must NOT be in submitted state for the family to keep editing documents.
  // KMS-driven uploads bypass this endpoint entirely.
  assertGroupEditable_(enrollmentGroupId);
  // DL-E39 step-up gate: subir documentos del expediente es PII sensible.
  // enrollmentGroupId viene del resume_token (KAL-4), nunca del payload.
  assertStepUpFresh_(enrollmentGroupId);
  _wzCacheInvalidate_(p && p.resume_token); // WIZARD-CACHE: NUNCA servir stale tras un write del grupo
  // ★ SEC-STEPUP (finding #55): NO re-extender la ventana por uso (P-STEPUP-SLIDING retirado — convertía 10 min en infinitos → bypass del PII-gate en recarga).
  const enrollmentId      = p.enrollment_id || null;
  const { base64, mimeType, filename, document_type } = p;
  if (!base64) throw new Error('Missing base64');
  // WIZARD-DOCS (2026-06-13): adjuntador genérico. La familia describe en texto
  // libre qué es cada archivo ("informe médico", "documento personal"…). No hay
  // tipos tasados obligatorios. KAL-5: sanitizamos el texto (tope 200 chars,
  // sin CR/LF para no contaminar logs — KAL-11). Se guarda en recFiles.description.
  // appsheetEscape_ se aplica más abajo SOLO si llega a un Filter (aquí no — va a
  // un Add como valor de columna; AppSheet API v2 parametriza el body JSON).
  let uploadDescription = (typeof p.description === 'string') ? p.description : '';
  uploadDescription = uploadDescription.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 200);
  if (enrollmentId) {
    assertValidUuid_(enrollmentId, 'enrollment_id');
    // KAL-4: post-submit uploads target a specific enrollment; verify it
    // belongs to the token's group.
    const enrollment = appsheetRequest_(T.ENROLLMENTS, 'Find', [], {
      Filter: '"enrollment_id" = "' + appsheetEscape_(enrollmentId) + '" && "enrollment_group_id" = "' + appsheetEscape_(enrollmentGroupId) + '"'
    });
    if (!enrollment || !enrollment.length) {
      throw new Error('Unauthorized: enrollment_id does not belong to token group');
    }
  }

  const idempotencyToken = p.upload_idempotency_token || generateUuid_();
  // KAL-5: idempotency token is server-generated UUID by default; if the
  // frontend supplied one, it must match UUID shape.
  assertValidUuid_(idempotencyToken, 'upload_idempotency_token');

  // Idempotency check — if a recFiles row already exists for this token, return it
  try {
    const existing = appsheetRequest_(T.REC_FILES, 'Find', [], {
      Filter: '"school_id" = "' + appsheetEscape_(SCHOOL_ID) + '" && "upload_idempotency_token" = "' + appsheetEscape_(idempotencyToken) + '"'
    }) || [];
    if (existing.length) {
      const row = existing[0];
      return {
        file_id:     row.file_id,
        document_id: row.file_id, // legacy alias
      };
    }
  } catch (_) { /* non-fatal: lookup might fail on first run if cache cold */ }

  // === CLI 82 / KAL-NEW-5 segunda parte: validación server-side =================
  // Allowlist MIME + magic-bytes + tope de tamaño. Cierra la segunda mitad de
  // KAL-NEW-5 (el sharing era sólo la primera). Los magic-bytes se comparan a
  // nivel de BYTE (no string): Utilities.base64Decode devuelve bytes con signo
  // (Java byte[], 0xFF → -1) y getDataAsString() los mutaría con UTF-8 — un
  // JPEG/PNG válido daría un falso MIME_MAGIC_MISMATCH. Por eso enmascaramos
  // con `& 0xFF` y comparamos contra el prefijo esperado.
  const ALLOWED_MIMES = {
    'application/pdf': [0x25, 0x50, 0x44, 0x46], // %PDF
    'image/jpeg':      [0xFF, 0xD8, 0xFF],
    'image/png':       [0x89, 0x50, 0x4E, 0x47], // \x89PNG
  };
  const MAX_BYTES = 10 * 1024 * 1024; // 10 MB

  if (!ALLOWED_MIMES[mimeType]) {
    const err = new Error('UNSUPPORTED_MIME: ' + mimeType);
    err.code = 'UNSUPPORTED_MIME';
    throw err;
  }
  const decoded = Utilities.base64Decode(base64);
  if (decoded.length > MAX_BYTES) {
    const err = new Error('FILE_TOO_LARGE: ' + decoded.length + ' bytes (max ' + MAX_BYTES + ')');
    err.code = 'FILE_TOO_LARGE';
    throw err;
  }
  const expectedMagic = ALLOWED_MIMES[mimeType];
  let magicOk = decoded.length >= expectedMagic.length;
  for (let mi = 0; magicOk && mi < expectedMagic.length; mi++) {
    if ((decoded[mi] & 0xFF) !== expectedMagic[mi]) magicOk = false;
  }
  if (!magicOk) {
    const err = new Error('MIME_MAGIC_MISMATCH: declared=' + mimeType);
    err.code = 'MIME_MAGIC_MISMATCH';
    throw err;
  }

  // ── Drive upload ───────────────────────────────────────────────────────────
  // CLI 82 / KAL-NEW-5: el fichero NO se comparte públicamente. El default de
  // Drive es privado al dueño del deployment (executeAs: USER_DEPLOYING). El
  // read-back se sirve vía getDocument_ (proxy de bytes gateado por token +
  // guard de propiedad).
  const blob   = Utilities.newBlob(decoded, mimeType, filename);
  const folder = getOrCreateDriveFolder_(DRIVE_FOLDER_NAME);
  const file   = folder.createFile(blob);

  const driveFileId   = file.getId();
  const fileId        = generateUuid_();
  const now           = new Date().toISOString();
  const recTypeCode   = REC_TYPE_BY_DOCUMENT_TYPE[document_type] || 'OTHER';

  // ── recFiles row (DL-R09) ──────────────────────────────────────────────────
  appsheetRequest_(T.REC_FILES, 'Add', [{
    file_id:                  fileId,
    school_id:                SCHOOL_ID,
    rec_type_code:            recTypeCode,
    drive_file_id:            driveFileId,
    drive_folder_id:          folder.getId(),
    file_name:                filename,
    original_filename:        filename,
    mime_type:                mimeType,
    file_size_bytes:          blob.getBytes().length,
    file_hash_sha256:         null,
    status:                   'ACTIVE',
    upload_idempotency_token: idempotencyToken,
    origin:                   'WIZARD',
    origin_reference:         enrollmentGroupId || enrollmentId,
    document_date:            null,
    signed_at:                null,
    // WIZARD-DOCS: texto libre del adjuntador genérico (qué es el archivo).
    description:              uploadDescription || null,
    language:                 null,
    was_originally_paper:     false,
    created_at:               now,
    created_by:               'SYSTEM:WIZARD',
    updated_at:               now,
    updated_by:               'SYSTEM:WIZARD',
  }]);

  // ── Primary scope (only if we already have an enrollment_id) ───────────────
  // Pre-submit uploads (enrollment_id == null) defer scopes to submitEnrollmentSession_.
  if (enrollmentId) {
    appsheetRequest_(T.REC_SCOPES, 'Add', [{
      scope_id:                generateUuid_(),
      school_id:               SCHOOL_ID,
      file_id:                 fileId,
      scope_type_code:         'enr_admission_school',
      scope_target_id:         enrollmentId,
      is_primary:              true,
      shortcut_drive_file_id:  null,
      created_at:              now,
      created_by:              'SYSTEM:WIZARD',
      updated_at:              now,
      updated_by:              'SYSTEM:WIZARD',
    }]);
  }

  return {
    file_id:     fileId,
    document_id: fileId, // legacy alias for frontends still reading document_id
  };
}

/**
 * CLI 82 / KAL-NEW-5 / Anexo A Opción A: proxy de bytes de un documento.
 *
 * El frontend llama getDocument({resume_token|signing_token, file_id}) y recibe
 * los bytes base64. El backend (manifest executeAs: USER_DEPLOYING → corre con
 * la identidad y el scope `drive` completo del dueño) lee el fichero PRIVADO de
 * Drive y lo entrega él mismo. Los ficheros ya NO son públicos (el sharing
 * público se eliminó en uploadDocument_ y generateConsentPdf_).
 *
 * Acepta los DOS gates canónicos del wizard (ver CLAUDE.md §"Dos bearer tokens
 * canónicos del wizard"):
 *   - resume_token  → flujo /apply (familia pre-firma). Grupo vía requireResumeToken_.
 *   - signing_token → flujo /sign (guardian firmante post-AD). Grupo vía requireSigningToken_.
 *
 * ⚠️ Guard IDOR de LECTURA obligatorio: como el backend corre como dueño puede
 * leer CUALQUIER fichero del dueño. Verificamos que el recFiles del file_id
 * pertenece al grupo del token (origin_reference == groupId). Sin esa
 * comprobación esto sería un IDOR de lectura de todo Drive. Mismo patrón KAL-4
 * aplicado a la lectura (CLAUDE.md §"IDOR — token enforcement obligatorio").
 *
 * DOC-BYTES (decisión Diego 2026-06-11, finding #56): el blob es EL camino canónico
 * (drive_view_url retirada de los members del KMS — los ficheros NO están compartidos
 * por enlace y NO deben estarlo). El response propaga además `sha256` (hex sobre los
 * bytes EXACTOS servidos), `mime_type` y `size_bytes`. Invariante: ese mismo PDF
 * (mismo sha256) es el que recibe Click & Sign — el hash permite verificar la
 * identidad documento-mostrado == documento-firmado.
 *
 * @param {{ resume_token?: string, signing_token?: string, file_id: string }} p
 * @returns {{ filename: string, mimeType: string, mime_type: string, base64: string, sha256: string|null, size_bytes: number|null }}
 */
function getDocument_(p) {
  // ── Gate dual: resume_token (/apply) O signing_token (/sign) ────────────────
  // El enrollment_group_id autorizado se deriva SIEMPRE del token server-side,
  // NUNCA del payload (KAL-4 IDOR).
  let groupId;
  let usedSigningToken = false;
  let kmsSigningToken = null;   // IDENTITY-COMPLETION (#30): signing_token a usar para el
                                // proxy KMS de PDFs de firma — del payload (compat) o
                                // resuelto SERVER-SIDE del grupo+guardian (resume_token).
  let resolveKmsSigningToken = function () { return null; }; // lazy (resume_token path)
  if (p && p.resume_token) {
    // PERF V2 (2026-06-12, puerta <5s de SPEC-WIZ-WARMUP-V2): el gate KAL-4 pagaba
    // una lectura AppSheet (~2,5-5s) POR CADA documento servido — con el bundle ya
    // caliente era el coste dominante del e2e (8,5/6,8s medidos). Memo de LECTURA
    // (precedente #65/#67b: requireSignerIdentity_/token lazy, TTL 300s, solo
    // lecturas): getDocument_ sirve bytes YA autorizados, el step-up gate (ventana
    // dura 10 min) sigue aplicando en vivo más abajo, y los handlers de MUTACIÓN
    // siguen en requireResumeToken_ live sin memo.
    groupId = requireResumeTokenMemo_(p);
    // IDENTITY-COMPLETION (#30): los PDF del paquete de firma (Carta/Contrato) los genera
    // y guarda el KMS (origin_reference='signing_package:…', NO el grupo) → el read local
    // de abajo NO los encuentra. Para servirlos bajo resume_token (sesión que sobrevive a
    // F5/incógnito), resolvemos el signing_token del guardian SERVER-SIDE: el `n` (email_id
    // del enlace, IDENTITY-FROM-LINK) → email → guardian → resolveGuardianSigningContext_,
    // y proxyamos al KMS igual que el flujo signing_token. KMS INTACTO: sigue recibiendo un
    // signing_token válido. Resolución LAZY: solo si el read local falla (es un PDF de firma,
    // no un documento subido por la familia) — sin coste en el path común de previews /apply.
    resolveKmsSigningToken = function () {
      try {
        // IDENTITY-FROM-LINK: la identidad sale del `n` (email_id) del enlace, resuelto
        // server-side contra el grupo del token (effectiveRecoveredEmail_ nueva firma:
        // (clientEmail, groupId, nParam)). recovered_email es compat secundario.
        const effEmail = effectiveRecoveredEmail_(p && p.recovered_email, groupId, p && p.n);
        const guardianId = effEmail ? resolveGuardianForRecovery_(groupId, effEmail) : null;
        if (!guardianId) return null;
        // PERF (log real Diego 20:32 — getDocument 37-40s e2e): esta resolución del
        // signing_token quedó fuera del memo @166 y pagaba la cadena completa por
        // CADA documento. Memo ScriptCache TTL 300s — SOLO para este camino de
        // LECTURA (servir bytes); el KMS re-valida el token + IDOR en vivo por
        // llamada (KAL-4) y el ACTO de firma no pasa por aquí (P222 intacta).
        const cache = CacheService.getScriptCache();
        const memoKey = 'docsigntok_' + sha256Hex_(
          Utilities.newBlob(groupId + '|' + guardianId).getBytes()).slice(0, 40);
        const hit = cache.get(memoKey);
        if (hit) return hit;
        const sctxSign = resolveGuardianSigningContext_(groupId, guardianId);
        const tok = (sctxSign && sctxSign.signing_token) || null;
        if (tok) cache.put(memoKey, tok, 300);
        return tok;
      } catch (eSign) { return null; }
    };
  } else if (p && p.signing_token) {
    const sctx = requireSigningToken_(p);
    groupId = sctx.enrollment_group_id;
    usedSigningToken = true;
    kmsSigningToken = sctx.signing_token;
  } else {
    const err = new Error('resume_token or signing_token required');
    err.code = 'BAD_REQUEST';
    throw err;
  }
  if (!groupId) {
    const err = new Error('Unauthorized: token resolved to no group');
    err.code = 'UNAUTHORIZED';
    throw err;
  }

  // DL-E39 step-up gate: servir el documento en CLARO (bytes) revela PII.
  // groupId ya viene del token (resume_token o signing_token), nunca del payload.
  assertStepUpFresh_(groupId);
  // ★ SEC-STEPUP (finding #55): NO re-extender la ventana por uso (P-STEPUP-SLIDING retirado — convertía 10 min en infinitos → bypass del PII-gate en recarga).

  const fileId = p.file_id;
  // F-17·#10 (2026-06-11): lectura tolera ids legacy semánticos (no-UUID) — validador
  // relajado + whitelist (sin comillas) + appsheetEscape_ abajo. NO usar assertValidUuid_
  // aquí: rechazaba `file-kis-admission-letter-2026-001` antes del lookup (Hallazgo #10).
  assertValidFileIdForRead_(fileId, 'file_id');

  // WIZARD-CACHE (2026-06-12) — cache-first POST-GATES (token + step-up YA corrieron;
  // el cache solo cambia el ORIGEN de los bytes, no salta ningún gate). Keyed por el
  // resume_token validado (KAL-4): un doc cacheado por el warm bajo el token X solo se
  // sirve al portador de X; la rotación del token invalida gratis. El camino vivo
  // (read local + proxy KMS) queda INTACTO como fallback.
  if (p && p.resume_token) {
    try {
      const wzDocT0 = Date.now();
      const wzDocKey = _wzCacheKey_('doc', fileId);
      const wzDocRaw = _wzCacheGetChunked_(CacheService.getScriptCache(), wzDocKey);
      if (wzDocRaw) {
        const dC = JSON.parse(wzDocRaw);
        // V2.4 — KAL-4: la clave ya no lleva token; la entrada guarda g=group_id de
        // ORIGEN y solo se sirve si coincide con el grupo del CALLER (derivado de su
        // token, post-gate). Mismatch → MISS → camino vivo (que re-valida pertenencia).
        if (dC && dC.base64 && dC.g === groupId) {
          Logger.log('[WZCACHE] HIT doc token=' + String(p.resume_token).slice(0, 8) +
                     '… file=' + String(fileId).slice(0, 8) + '… ms=' + (Date.now() - wzDocT0));
          return {
            filename:   dC.filename || null,
            mimeType:   dC.mime_type || dC.mimeType || null,
            mime_type:  dC.mime_type || dC.mimeType || null,
            base64:     dC.base64,
            sha256:     dC.sha256 || null,
            size_bytes: (typeof dC.size_bytes === 'number') ? dC.size_bytes : null,
          };
        }
      }
    } catch (eWzDoc) { /* best-effort → camino vivo intacto */ }
  }

  // P-DOCS: los PDF del paquete de firma (Carta/Contrato) los genera el KMS y viven
  // en el Drive del KMS → DriveApp local del wizard NO los lee. En el flujo /sign
  // (signing_token) proxyamos la lectura de bytes al KMS (dueño de los ficheros),
  // que re-valida el signing_token + IDOR server-side (KAL-4). Los docs subidos por
  // la familia en /apply (resume_token) viven en el Drive del wizard → lectura local.
  // Flujo signing_token (compat): proxy directo al KMS con el token del payload.
  if (usedSigningToken) {
    const d = kmsProxy_('enr.serveSigningDocument', { signing_token: kmsSigningToken, file_id: fileId });
    return {
      filename:   d.filename || null,
      mimeType:   d.mime_type || d.mimeType || null,
      mime_type:  d.mime_type || d.mimeType || null,
      base64:     d.base64,
      // DOC-BYTES: hash/size calculados por el KMS sobre los bytes EXACTOS servidos
      // (mismo sha256 que el PDF que recibe Click & Sign).
      sha256:     d.sha256 || null,
      size_bytes: (typeof d.size_bytes === 'number') ? d.size_bytes : null,
    };
  }

  // ── Guard IDOR de lectura: el recFiles debe pertenecer al grupo del token ───
  const rows = appsheetRequest_(T.REC_FILES, 'Find', [], {
    Filter: '"file_id" = "' + appsheetEscape_(fileId) +
            '" && "origin_reference" = "' + appsheetEscape_(groupId) + '"',
  }) || [];
  const row = rows.find(r => r && !r['deleted_at']);
  if (!row) {
    // IDENTITY-COMPLETION (#30): no es un documento subido por la familia (origin_reference
    // != grupo). Si bajo resume_token resolvemos (LAZY) un signing_token server-side, es un
    // PDF del paquete de firma (Carta/Contrato, origin_reference='signing_package:…') → lo
    // sirve el KMS (su dueño), que re-valida el signing_token + IDOR (KAL-4). KMS INTACTO.
    const lazyKmsToken = kmsSigningToken || resolveKmsSigningToken();
    if (lazyKmsToken) {
      const d = kmsProxy_('enr.serveSigningDocument', { signing_token: lazyKmsToken, file_id: fileId });
      // WIZARD-CACHE write-through (best-effort): la siguiente lectura del mismo doc
      // bajo este token sirve de cache (preview + reentradas), sin re-pagar el proxy.
      try {
        if (p && p.resume_token && d && d.base64) {
          _wzCachePutChunked_(CacheService.getScriptCache(),
            _wzCacheKey_('doc', fileId),
            JSON.stringify(Object.assign({ g: groupId }, d)), 21600);
        }
      } catch (eWzWt) { /* best-effort */ }
      return {
        filename:   d.filename || null,
        mimeType:   d.mime_type || d.mimeType || null,
        mime_type:  d.mime_type || d.mimeType || null,
        base64:     d.base64,
        // DOC-BYTES: mismo sha256 que el PDF que recibe Click & Sign (lo calcula el KMS).
        sha256:     d.sha256 || null,
        size_bytes: (typeof d.size_bytes === 'number') ? d.size_bytes : null,
      };
    }
    Logger.log(redact_('[getDocument_] UNAUTHORIZED file=' + fileId + ' group=' + groupId));
    const err = new Error('Unauthorized: file not in token group');
    err.code = 'UNAUTHORIZED';
    throw err;
  }
  if (!row.drive_file_id) {
    const err = new Error('Document has no drive file');
    err.code = 'NOT_FOUND';
    throw err;
  }

  // DOC-FALLBACK (2026-06-11): el Drive local del wizard NO es fiable — verificado en
  // producción que esta rama moría con "getFileById on object DriveApp" para los PDF
  // del paquete de firma (fila recFiles matcheó por grupo pero el fichero vive en el
  // Drive del KMS), dejando el visor del Step 10 en "Cargando…" eterno. Doctrina
  // thin-client (decisión Diego, blob KMS→wizard): si la lectura local falla, el
  // fallback es SIEMPRE el proxy al KMS (dueño de los ficheros), que re-valida el
  // signing_token + IDOR server-side (KAL-4). Solo si tampoco hay token de firma
  // resolvible se devuelve error estructurado (P72: ok:false, nunca HTTP 4xx).
  try {
    const blob  = DriveApp.getFileById(row.drive_file_id).getBlob();
    const bytes = blob.getBytes();
    return {
      filename:   row.file_name,
      mimeType:   row.mime_type,
      mime_type:  row.mime_type,
      base64:     Utilities.base64Encode(bytes),
      // DOC-BYTES: sha256 sobre los bytes EXACTOS servidos (paridad de contrato con
      // el camino KMS — permite verificación de integridad en cualquier consumidor).
      sha256:     sha256Hex_(bytes),
      size_bytes: bytes.length,
    };
  } catch (eDrive) {
    Logger.log(redact_('[getDocument_] Drive local FALLÓ file=' + fileId +
      ' — fallback proxy KMS. err=' + (eDrive && eDrive.message)));
    const fbToken = kmsSigningToken || resolveKmsSigningToken();
    if (fbToken) {
      const d = kmsProxy_('enr.serveSigningDocument', { signing_token: fbToken, file_id: fileId });
      // WIZARD-CACHE write-through (best-effort) — mismo motivo que el path lazy.
      try {
        if (p && p.resume_token && d && d.base64) {
          _wzCachePutChunked_(CacheService.getScriptCache(),
            _wzCacheKey_('doc', fileId),
            JSON.stringify(Object.assign({ g: groupId }, d)), 21600);
        }
      } catch (eWzWt2) { /* best-effort */ }
      return {
        filename:   d.filename || row.file_name || null,
        mimeType:   d.mime_type || d.mimeType || row.mime_type || null,
        mime_type:  d.mime_type || d.mimeType || row.mime_type || null,
        base64:     d.base64,
        sha256:     d.sha256 || null,
        size_bytes: (typeof d.size_bytes === 'number') ? d.size_bytes : null,
      };
    }
    const err = new Error('Document temporarily unavailable');
    err.code = 'DOC_UNAVAILABLE';
    throw err;
  }
}

/**
 * SHA256 hex (64 chars) de un array de bytes. DOC-BYTES 2026-06-11 — mismo
 * encoding que `_enr_computeSha256Hex_` del KMS (kms-server/enr/signing-status.gs).
 * @param {number[]} bytes
 * @returns {string}
 */
function sha256Hex_(bytes) {
  const digest = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, bytes);
  const hex = [];
  for (let i = 0; i < digest.length; i++) {
    const b = digest[i] < 0 ? digest[i] + 256 : digest[i];
    const h = b.toString(16);
    hex.push(h.length === 1 ? '0' + h : h);
  }
  return hex.join('');
}

/**
 * Verifies a reCAPTCHA v3 token against Google's API.
 * @param {Object} p - { token }
 * @returns {{ success: boolean, score: number, pass: boolean }}
 */
function verifyRecaptcha_(p) {
  const { token } = p;
  if (!token) throw new Error('Missing reCAPTCHA token');

  const secret   = PropertiesService.getScriptProperties().getProperty('RECAPTCHA_SECRET');
  // KAL-NEW-4: fail-closed — sin secret no se puede verificar → pass:false explícito
  // (evita la llamada de red con secret vacío que Google rechazaría igualmente).
  if (!secret) {
    return { success: false, score: 0, pass: false };
  }
  const response = UrlFetchApp.fetch('https://www.google.com/recaptcha/api/siteverify', {
    method:  'post',
    payload: { secret, response: token },
    muteHttpExceptions: true,
  });

  const result = JSON.parse(response.getContentText());
  return {
    success: result.success === true,
    score:   result.score || 0,
    pass:    result.success === true && (result.score || 0) >= 0.5,
  };
}

// ─── Step save helpers ────────────────────────────────────────────────────────


/**
 * Upserts guardian-applicant relations for an enrollment session.
 *
 * DL-E15 / DL-S45: sysPersonRelations scoped to context_entity_id=enrollment_group_id
 * (the session header). Relations are shared across all child enrollments.
 *
 * @param {string} enrollmentGroupId
 * @param {Array}  relations - [{ guardian_person_id, applicant_person_id, relation_type_id, is_custodial, is_pick_up_authorized }]
 */
function saveRelations_(enrollmentGroupId, relations) {
  if (!Array.isArray(relations)) return {};

  // Load relationTypes catalog to resolve inverse type for the reverse row (DL-S45).
  // Fallback to same type if catalog unavailable — silent degradation.
  const relTypesData = (() => {
    try {
      const res = appsheetRequest_(T.LOOKUP_RELATION_TYPES, 'Find', [], { Filter: 'true' });
      return (res && res.data) || [];
    } catch (_) { return []; }
  })();
  const typeById    = {};  // rowId → { is_symmetric, inverse_code }
  const typeByDesig = {};  // designation → rowId
  relTypesData.forEach(rt => {
    const id = rt['Row ID'] || rt.row_id;
    if (!id) return;
    typeById[id] = {
      is_symmetric: rt.is_symmetric === true || rt.is_symmetric === 'true' || rt.is_symmetric === 'TRUE' || rt.is_symmetric === 'Y',
      inverse_code: rt.inverse_code || null,
    };
    if (rt.relation_type_designation) typeByDesig[rt.relation_type_designation] = id;
  });

  function resolveInverseTypeId(fwdTypeId) {
    const info = typeById[fwdTypeId];
    if (!info) return fwdTypeId;                   // unknown type — keep same
    if (info.is_symmetric) return fwdTypeId;       // symmetric — same type for both directions
    // inverse_code may be a row ID (AppSheet Ref column) or a designation string — handle both
    const invId = info.inverse_code
      ? (typeById[info.inverse_code] ? info.inverse_code : typeByDesig[info.inverse_code])
      : null;
    return invId || fwdTypeId;                     // fallback: same if inverse not found
  }

  // DL-S45: sysPersonRelations is bidirectional — always insert 2 rows per pair
  // sharing the same pair_id (guardian→applicant + applicant→guardian).
  const newRelations = [];
  relations.filter(r => !r.relation_id).forEach(r => {
    const pairId     = generateUuid_();
    const now        = new Date().toISOString();
    const fwdTypeId  = r.relation_type_id || null;
    const invTypeId  = fwdTypeId ? resolveInverseTypeId(fwdTypeId) : null;
    const base = {
      school_id:                SCHOOL_ID,
      context_entity_type_code: 'ENR_ADMISSION_SCHOOL',
      context_entity_id:        enrollmentGroupId,
      pair_id:                  pairId,
      is_custodial:             r.is_custodial          || false,
      is_pick_up_authorized:    r.is_pick_up_authorized || false,
      is_school_rep:            false,
      is_emergency_contact:     false,
      created_at:               now,
      created_by:               'SYSTEM:WIZARD',
    };
    // Forward row: guardian/personA → applicant/personB uses the user-selected type
    newRelations.push(Object.assign({}, base, {
      relation_id:       generateUuid_(),
      from_person_table: 'enrPersons',
      from_person_id:    r.guardian_person_id || r.person_id_a,
      to_person_table:   'enrPersons',
      to_person_id:      r.applicant_person_id || r.person_id_b,
      relation_type_id:  fwdTypeId,
    }));
    // Inverse row: applicant/personB → guardian/personA uses the inverse type
    newRelations.push(Object.assign({}, base, {
      relation_id:       generateUuid_(),
      from_person_table: 'enrPersons',
      from_person_id:    r.applicant_person_id || r.person_id_b,
      to_person_table:   'enrPersons',
      to_person_id:      r.guardian_person_id  || r.person_id_a,
      relation_type_id:  invTypeId,
    }));
  });
  const existingRelations = relations.filter(r => r.relation_id).map(r => ({
    relation_id:           r.relation_id,
    from_person_id:        r.guardian_person_id || r.person_id_a,
    to_person_id:          r.applicant_person_id || r.person_id_b,
    relation_type_id:      r.relation_type_id      || null,
    is_custodial:          r.is_custodial          || false,
    is_pick_up_authorized: r.is_pick_up_authorized || false,
  }));

  const _debug = { newRelations: newRelations.length, existingRelations: existingRelations.length, firstNew: newRelations[0] || null };
  if (newRelations.length)      appsheetRequest_(T.PERSON_RELATIONS, 'Add',  newRelations, null, _debug);
  if (existingRelations.length) appsheetRequest_(T.PERSON_RELATIONS, 'Edit', existingRelations);
  return _debug;
}

/**
 * Upserts health records for each person.
 *
 * No FK to the session — rows key off person_id which already ties back to the
 * enrollment_group_id via enrPersons. The first arg is kept for signature
 * symmetry with the other step savers.
 *
 * @param {string} enrollmentGroupId  (unused; kept for symmetry)
 * @param {Array}  healthData - [{ person_id, allergies, dietary, medical }]
 */
function saveHealth_(enrollmentGroupId, healthData) {  // eslint-disable-line no-unused-vars
  if (!Array.isArray(healthData)) return;

  healthData.forEach(h => {
    const { person_id } = h;
    if (!person_id) return;

    if (Array.isArray(h.allergies)) {
      const rows = h.allergies.filter(x => !x.record_id).map(x => ({
        record_id:       generateUuid_(),
        person_id,
        food_allergy_id: x.food_allergy_id || null,
        observations:    x.observations || null,
      }));
      if (rows.length) appsheetRequest_(T.PERSON_ALLERGIES, 'Add', rows);
    }

    if (Array.isArray(h.dietary)) {
      const rows = h.dietary.filter(x => !x.record_id).map(x => ({
        record_id:    generateUuid_(),
        person_id,
        diet_id:      x.diet_id || null,
        observations: x.observations || null,
      }));
      if (rows.length) appsheetRequest_(T.PERSON_DIETARY, 'Add', rows);
    }

    if (Array.isArray(h.medical)) {
      const rows = h.medical.filter(x => !x.record_id).map(x => ({
        record_id:            generateUuid_(),
        person_id,
        medical_condition_id: x.medical_condition_id || null,
        observations:         x.observations || null,
      }));
      if (rows.length) appsheetRequest_(T.PERSON_MEDICAL, 'Add', rows);
    }
  });
}

// ENR-E6 (2026-06-06): saveInterviews_ + case 'interviews' eliminados del
// dispatcher anónimo. Las entrevistas son KMS staff-side (DL-E19), NO un step
// canónico del wizard (los 11 steps no incluyen 'interviews'); la función no
// tenía callers (0 hits frontend) y, bajo manifest ANYONE_ANONYMOUS, todo case
// es superficie de ataque sin auth. Paridad con la limpieza de case 'review'
// (KAL-NEW-3). Las entrevistas se gestionan en el KMS sobre tablas core.

// ─── Email helpers ────────────────────────────────────────────────────────────

/**
 * Sends a branded internal email to admissions@kaleide.org.
 * @param {string} subject
 * @param {string} bodyHtml - inner HTML content (no shell)
 */
function sendInternalEmail_(subject, bodyHtml) {
  sendAsAlias_(ADMISSIONS_EMAIL, subject, buildInternalEmail_(subject, bodyHtml));
}

// NOTA (WIZARD-TERMINAL P3, 2026-06-25): sendMagicLinkEmail_, sendMagicLinkMultiEmail_ y
// sendFamilyConfirmationEmail_ FUERON ELIMINADAS. El contenido de esos 3 emails (+ la
// notificacion interna de submit) lo gobierna ahora el motor del KMS via sendViaKmsNotify_
// (plantillas sysNotificationTemplates_T). El bloque GDPR / la lista multi-link / la tabla
// de solicitantes se pre-renderizan en helpers _kmsRender*_ (junto a sendViaKmsNotify_).

// ─── Email builders ───────────────────────────────────────────────────────────

/**
 * Wraps content in a branded internal email HTML shell.
 * @param {string} subject
 * @param {string} bodyHtml
 * @returns {string} Full HTML email
 */
function buildInternalEmail_(subject, bodyHtml) {
  return '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">'
    + '<meta name="viewport" content="width=device-width,initial-scale=1">'
    + '<title>' + subject + '</title>'
    + '<style>'
    + 'body{margin:0;padding:0;background:#f2f4f7;font-family:\'Plus Jakarta Sans\',Arial,sans-serif;color:#18222e}'
    + 'a{color:#00a19a}'
    + 'table{border-collapse:collapse;width:100%}'
    + 'td,th{padding:8px 12px;text-align:left;border-bottom:1px solid #e3e7ed}'
    + 'th{background:#f2f4f7;font-weight:600;color:#6b7c93;font-size:0.85em;text-transform:uppercase;letter-spacing:0.05em}'
    + '</style></head><body>'
    + '<table width="100%" cellpadding="0" cellspacing="0" style="background:#f2f4f7;padding:32px 0">'
    + '<tr><td align="center">'
    + '<table width="600" cellpadding="0" cellspacing="0" style="max-width:600px;background:#fff;border-radius:12px;overflow:hidden;box-shadow:0 2px 12px rgba(0,0,0,0.07)">'
    // Header
    + '<tr><td style="background:#ffffff;padding:20px 32px;border-bottom:3px solid #00a19a;">'
    + '<table><tr>'
    + '<td><img src="' + LOGO_URL + '" width="36" height="36" alt="KIS" style="border-radius:8px;vertical-align:middle;margin-right:12px;background:#e6f6f5;padding:4px"></td>'
    + '<td style="color:#007d77;font-size:1.15em;font-weight:700;vertical-align:middle">Kaleide International School</td>'
    + '</tr></table>'
    + '</td></tr>'
    // Body
    + '<tr><td style="padding:32px;">' + bodyHtml + '</td></tr>'
    // Footer
    + '<tr><td style="background:#f2f4f7;padding:20px 32px;font-size:0.85em;color:#6b7c93;border-top:1px solid #e3e7ed">'
    + 'KIS Admissions System &nbsp;&bull;&nbsp; '
    + '<a href="mailto:admissions@kaleide.org">admissions@kaleide.org</a> &nbsp;&bull;&nbsp; '
    + '<a href="https://www.kaleide.org">www.kaleide.org</a>'
    + '</td></tr>'
    + '</table>'
    + '</td></tr></table></body></html>';
}

/**
 * Wraps content in a family-facing branded email HTML shell.
 * @param {string} subject
 * @param {string} bodyHtml
 * @returns {string}
 */
function buildFamilyEmail_(subject, bodyHtml) {
  return buildInternalEmail_(subject, bodyHtml);
}

/**
 * Builds the HTML body for "Application Initiated" internal notification.
 */
function buildApplicationInitiatedBody_(applicationId, primaryEmail, timestamp) {
  const ts = formatTimestamp_(timestamp);
  return '<h2 style="color:#00a19a;margin-top:0">New Application Started</h2>'
    + '<table><thead><tr><th>Field</th><th>Value</th></tr></thead><tbody>'
    + '<tr><td><strong>Application ID</strong></td><td style="font-family:monospace">' + applicationId + '</td></tr>'
    + '<tr><td><strong>Primary Email</strong></td><td>' + primaryEmail + '</td></tr>'
    + '<tr><td><strong>Timestamp</strong></td><td>' + ts + '</td></tr>'
    + '<tr><td><strong>Status</strong></td><td><span style="background:#e6f6f5;color:#007d77;padding:2px 8px;border-radius:4px;font-size:0.9em">DRAFT</span></td></tr>'
    + '</tbody></table>';
}

/**
 * Builds the HTML body for "Application Submitted" internal notification.
 * Guardians are enriched persons (with .emails and .phones arrays).
 * desired_start_date is read from the application row.
 * profession/employer/adaptation are read from qbResponseMap keyed by stable question UUID.
 * @param {string} applicationId
 * @param {string} timestamp
 * @param {Array}  guardians
 * @param {Array}  applicants
 * @param {Object} app           - Application row (has desired_start_date, source)
 * @param {Object} qbResponseMap - { [question_id]: response_text }
 */
function buildApplicationSubmittedBody_(applicationId, timestamp, guardians, applicants, app, qbResponseMap) {
  const ts              = formatTimestamp_(timestamp);
  const qbMap           = qbResponseMap || {};
  const desiredStartDate = (app && app.desired_start_date) || '\u2014';

  let guardianRows = '';
  guardians.forEach((g, i) => {
    const emails = (g.emails || []).map(e =>
      (e.value || '') + (e.is_emergency ? ' <span style="background:#fff3ec;color:#c05800;padding:1px 5px;border-radius:3px;font-size:0.75em">Emergency</span>' : '')
    ).filter(e => e.trim()).join(', ');
    const phones = (g.phones || []).map(ph =>
      (ph.value || '') + (ph.is_whatsapp ? ' \uD83D\uDCAC' : '') + (ph.is_telegram ? ' \u2708\uFE0F' : '')
      + (ph.is_emergency ? ' <span style="background:#fff3ec;color:#c05800;padding:1px 5px;border-radius:3px;font-size:0.75em">Emergency</span>' : '')
    ).filter(Boolean).join(', ');

    guardianRows +=
      '<tr><td><strong>' + (g.first_name || '') + ' ' + (g.last_name || '') + '</strong>'
      + (i === 0 ? ' <span style="background:#e6f6f5;color:#007d77;padding:1px 6px;border-radius:4px;font-size:0.8em">Primary</span>' : '')
      + '</td>'
      + '<td>' + (emails || '\u2014') + '</td>'
      + '<td>' + (phones || '\u2014') + '</td></tr>';
  });

  let applicantRows = '';
  applicants.forEach(a => {
    applicantRows +=
      '<tr><td><strong>' + (a.first_name || '') + ' ' + (a.last_name || '') + '</strong></td>'
      + '<td>' + (a.date_of_birth || '\u2014') + '</td></tr>';
  });

  return '<h2 style="color:#00a19a;margin-top:0">Application Submitted \u2014 Action Required</h2>'
    + '<table style="margin-bottom:24px"><thead><tr><th colspan="2">Application Details</th></tr></thead><tbody>'
    + '<tr><td><strong>Application ID</strong></td><td style="font-family:monospace">' + applicationId + '</td></tr>'
    + '<tr><td><strong>Submitted At</strong></td><td>' + ts + '</td></tr>'
    + '<tr><td><strong>Desired Start Date</strong></td><td>' + desiredStartDate + '</td></tr>'
    + '<tr><td><strong>Source</strong></td><td>' + ((app && app.source) || '\u2014') + '</td></tr>'
    + '<tr><td><strong>Status</strong></td><td><span style="background:#fff3ec;color:#c05800;padding:2px 8px;border-radius:4px;font-size:0.9em">SUBMITTED</span></td></tr>'
    + '</tbody></table>'

    + '<h3 style="color:#6b7c93;font-size:0.9em;text-transform:uppercase;letter-spacing:0.05em">Guardians</h3>'
    + '<table style="margin-bottom:24px"><thead><tr><th>Name</th><th>Email</th><th>Phone</th></tr></thead><tbody>'
    + guardianRows + '</tbody></table>'

    + (qbMap[QB_PROFESSION_ID] || qbMap[QB_EMPLOYER_ID]
      ? '<h3 style="color:#6b7c93;font-size:0.9em;text-transform:uppercase;letter-spacing:0.05em">Guardian Details (from questions)</h3>'
        + '<table style="margin-bottom:24px"><thead><tr><th>Question</th><th>Response</th></tr></thead><tbody>'
        + (qbMap[QB_PROFESSION_ID] ? '<tr><td>Profession</td><td>' + qbMap[QB_PROFESSION_ID] + '</td></tr>' : '')
        + (qbMap[QB_EMPLOYER_ID]   ? '<tr><td>Employer</td><td>'   + qbMap[QB_EMPLOYER_ID]   + '</td></tr>' : '')
        + '</tbody></table>'
      : '')

    + '<h3 style="color:#6b7c93;font-size:0.9em;text-transform:uppercase;letter-spacing:0.05em">Applicants</h3>'
    + '<table style="margin-bottom:24px"><thead><tr><th>Name</th><th>Date of Birth</th></tr></thead><tbody>'
    + applicantRows + '</tbody></table>'

    + (qbMap[QB_HAS_ADAPTATION_ID] || qbMap[QB_ADAPTATION_NOTES_ID]
      ? '<h3 style="color:#6b7c93;font-size:0.9em;text-transform:uppercase;letter-spacing:0.05em">Applicant Details (from questions)</h3>'
        + '<table style="margin-bottom:24px"><thead><tr><th>Question</th><th>Response</th></tr></thead><tbody>'
        + (qbMap[QB_HAS_ADAPTATION_ID]   ? '<tr><td>Adaptation needs</td><td>' + qbMap[QB_HAS_ADAPTATION_ID]   + '</td></tr>' : '')
        + (qbMap[QB_ADAPTATION_NOTES_ID] ? '<tr><td>Adaptation notes</td><td>' + qbMap[QB_ADAPTATION_NOTES_ID] + '</td></tr>' : '')
        + '</tbody></table>'
      : '')

    + '<p style="background:#fff3ec;border-left:4px solid #f37021;padding:12px 16px;border-radius:0 6px 6px 0;color:#18222e">'
    + '<strong>Next step:</strong> Please review the application in the SMS and update the status accordingly.'
    + '</p>';
}

// ─── AppSheet API helper ──────────────────────────────────────────────────────

/**
 * Executes an AppSheet API v2 action on a table.
 * @param {string} table  - Table name
 * @param {string} action - 'Add', 'Edit', 'Find', 'Delete'
 * @param {Array}  rows   - Row objects (for Add/Edit)
 * @param {Object} selector - Optional selector options (for Find)
 * @returns {Array|null} Parsed rows array or null
 */
function appsheetRequest_(table, action, rows, selector, debugOut) {
  // DBG-TRACE: cada lectura/escritura AppSheet visible en el _dbg del frontend.
  const _dbgT0 = Date.now();
  _dbgEv_('as_call', table + '/' + action);
  const props  = PropertiesService.getScriptProperties();
  const appId  = props.getProperty('APPSHEET_APP_ID');
  const apiKey = props.getProperty('APPSHEET_ACCESS_KEY');

  if (!appId || !apiKey) throw new Error('AppSheet credentials not configured in Script Properties');

  const url  = APPSHEET_BASE_URL + appId + '/tables/' + encodeURIComponent(table) + '/Action';
  const body = { Action: action, Properties: { Locale: 'en-US' } };

  // AppSheet REST API v2 stores booleans as "TRUE"/"FALSE" strings in Google Sheets.
  // Sending JSON true/false causes silent row rejection — convert before sending.
  // null/undefined must also become "" — AppSheet silently rejects rows with JSON null values.
  const sanitize_ = (r) => {
    const out = {};
    for (const k in r) {
      const v = r[k];
      if (v === null || v === undefined) continue; // omit — AppSheet silently rejects "" on Enum/Ref columns
      else if (v === true)              out[k] = 'TRUE';
      else if (v === false)             out[k] = 'FALSE';
      else                              out[k] = v;
    }
    return out;
  };

  if (rows && rows.length > 0) body.Rows = rows.map(sanitize_);
  if (selector) {
    if (selector.Filter) {
      // Convert SQL-like Filter to AppSheet FILTER() formula syntax.
      // "column_name" = "value"  →  [column_name] = "value"
      // &&  →  AND,   ||  →  OR,   true/false  →  TRUE/FALSE
      const expr = selector.Filter
        .replace(/"(\w+)"\s*(=|!=|<=|>=|<|>)/g, '[$1] $2')
        .replace(/&&/g, 'AND')
        .replace(/\|\|/g, 'OR')
        .replace(/\btrue\b/g, 'TRUE')
        .replace(/\bfalse\b/g, 'FALSE');
      body.Properties.Selector = 'FILTER("' + table + '", ' + expr + ')';
    } else {
      body.Properties = { ...body.Properties, ...selector };
    }
  }

  const response = UrlFetchApp.fetch(url, {
    method:             'post',
    contentType:        'application/json',
    headers:            { ApplicationAccessKey: apiKey },
    payload:            JSON.stringify(body),
    muteHttpExceptions: true,
  });

  const statusCode = response.getResponseCode();
  const text       = response.getContentText();

  // KAL-11: response body can contain emails / UUIDs / PII verbatim (Add/Edit
  // echoes the row back). Redact before persisting to Stackdriver. Also trim
  // from 600 → 200 chars — enough for diagnostic HTTP errors, less surface
  // for PII to slip through the redactor.
  Logger.log('AppSheet ' + action + ' ' + table + ' → HTTP ' + statusCode + ' | ' + redact_(text.slice(0, 200)));
  if (debugOut) { debugOut.http = statusCode; debugOut.body = text.slice(0, 800); }

  if (statusCode < 200 || statusCode >= 300) {
    throw new Error('AppSheet HTTP ' + statusCode + ' on ' + table + '/' + action + ': ' + text.slice(0, 300));
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    throw new Error('AppSheet non-JSON response on ' + table + '/' + action + ': ' + text.slice(0, 400));
  }
  if (parsed && typeof parsed.error === 'string') {
    throw new Error('AppSheet error on ' + table + '/' + action + ': ' + parsed.error);
  }
  const resultRows = parsed.Rows || parsed.rows || null;
  if ((action === 'Add' || action === 'Edit') && rows && rows.length > 0) {
    if (!resultRows || resultRows.length === 0) {
      throw new Error('AppSheet silently rejected ' + action + ' on ' + table + ' (0 rows returned). Response: ' + text.slice(0, 400));
    }
  }
  _dbgEv_('as_resp', table + ' ' + (Date.now() - _dbgT0) + 'ms');
  return resultRows || parsed || null;
}

/**
 * Parallel sibling of appsheetRequest_. Dispatches N AppSheet API calls
 * concurrently via UrlFetchApp.fetchAll() and returns the per-spec
 * results in the same order. Used by the wizard's hot paths
 * (savePersons_, fetchLookups_, resumeSession_) to collapse what were
 * 5-11 sequential ~600ms-1s calls into a single round-trip-limited
 * batch (~1-1.5s total).
 *
 * Differs from appsheetRequest_:
 *   - Never throws — every spec returns { ok, data, error, http } so the
 *     caller decides whether one failure aborts everything or is logged
 *     and skipped. The current callers prefer "log and continue".
 *   - Specs with empty rows[] on Add/Edit/Delete are skipped at build
 *     time (returns { ok: true, data: [], skipped: true }) — matches the
 *     "write_" no-op semantics that savePersons_ used to do per write.
 *
 * Apps Script's fetchAll runs the underlying HTTP in parallel up to its
 * internal concurrency limit (empirically ~10-20 in flight at once is
 * fine; we never get close in this codebase).
 *
 * @param {Array<{ table: string, action: 'Find'|'Add'|'Edit'|'Delete', rows?: Array, selector?: Object }>} specs
 * @returns {Array<{ ok: boolean, data?: *, error?: string, http?: number, skipped?: boolean }>}
 */
function appsheetRequestBatch_(specs) {
  if (!specs || !specs.length) return [];
  const props  = PropertiesService.getScriptProperties();
  const appId  = props.getProperty('APPSHEET_APP_ID');
  const apiKey = props.getProperty('APPSHEET_ACCESS_KEY');
  if (!appId || !apiKey) throw new Error('AppSheet credentials not configured in Script Properties');

  const sanitize_ = (r) => {
    const out = {};
    for (const k in r) {
      const v = r[k];
      if (v === null || v === undefined) continue;
      else if (v === true)              out[k] = 'TRUE';
      else if (v === false)             out[k] = 'FALSE';
      else                              out[k] = v;
    }
    return out;
  };

  // Pre-decide skips so the per-spec result array maps 1:1 to the input.
  const built = specs.map(spec => {
    const writeAction = (spec.action === 'Add' || spec.action === 'Edit' || spec.action === 'Delete');
    if (writeAction && (!spec.rows || spec.rows.length === 0)) {
      return { skipped: true, spec };
    }
    const body = { Action: spec.action, Properties: { Locale: 'en-US' } };
    if (spec.rows && spec.rows.length > 0) body.Rows = spec.rows.map(sanitize_);
    if (spec.selector) {
      if (spec.selector.Filter) {
        const expr = spec.selector.Filter
          .replace(/"(\w+)"\s*(=|!=|<=|>=|<|>)/g, '[$1] $2')
          .replace(/&&/g, 'AND')
          .replace(/\|\|/g, 'OR')
          .replace(/\btrue\b/g, 'TRUE')
          .replace(/\bfalse\b/g, 'FALSE');
        body.Properties.Selector = 'FILTER("' + spec.table + '", ' + expr + ')';
      } else {
        body.Properties = Object.assign({}, body.Properties, spec.selector);
      }
    }
    return {
      skipped: false,
      spec,
      request: {
        url:                APPSHEET_BASE_URL + appId + '/tables/' + encodeURIComponent(spec.table) + '/Action',
        method:             'post',
        contentType:        'application/json',
        headers:            { ApplicationAccessKey: apiKey },
        payload:            JSON.stringify(body),
        muteHttpExceptions: true,
      },
    };
  });

  const dispatchIdx = []; // map dispatched-index → built-index, for stitching
  const requests = [];
  built.forEach((b, i) => {
    if (!b.skipped) { dispatchIdx.push(i); requests.push(b.request); }
  });
  const startMs = Date.now();
  _dbgEv_('as_batch_call', specs.map(function(sp) { return sp.table + '/' + sp.action; }).join(','));
  const responses = requests.length ? UrlFetchApp.fetchAll(requests) : [];
  _dbgEv_('as_batch_resp', requests.length + ' calls ' + (Date.now() - startMs) + 'ms');
  Logger.log('appsheetRequestBatch_: ' + requests.length + ' parallel calls in ' + (Date.now() - startMs) + 'ms');

  const out = new Array(specs.length);
  built.forEach((b, i) => {
    if (b.skipped) {
      out[i] = { ok: true, data: [], skipped: true };
    }
  });
  responses.forEach((response, j) => {
    const i = dispatchIdx[j];
    const spec = specs[i];
    const statusCode = response.getResponseCode();
    const text       = response.getContentText();
    if (statusCode < 200 || statusCode >= 300) {
      out[i] = { ok: false, http: statusCode, error: 'HTTP ' + statusCode + ' on ' + spec.table + '/' + spec.action + ': ' + text.slice(0, 200) };
      return;
    }
    let parsed;
    try { parsed = JSON.parse(text); } catch (_) {
      out[i] = { ok: false, http: statusCode, error: 'Non-JSON response on ' + spec.table + '/' + spec.action + ': ' + text.slice(0, 200) };
      return;
    }
    if (parsed && typeof parsed.error === 'string') {
      out[i] = { ok: false, http: statusCode, error: 'AppSheet error on ' + spec.table + '/' + spec.action + ': ' + parsed.error };
      return;
    }
    const resultRows = parsed.Rows || parsed.rows || null;
    if ((spec.action === 'Add' || spec.action === 'Edit') && spec.rows && spec.rows.length > 0) {
      if (!resultRows || resultRows.length === 0) {
        out[i] = { ok: false, http: statusCode, error: 'AppSheet silently rejected ' + spec.action + ' on ' + spec.table + ' (0 rows returned)' };
        return;
      }
    }
    out[i] = { ok: true, http: statusCode, data: resultRows || parsed || null };
  });
  return out;
}

// ─── PDF generation ───────────────────────────────────────────────────────────
// P262 (2026-06-25) — `generateConsentPdf_` (generaba el "Signed Consent Record" PDF en el
// submit) ELIMINADA. El wizard ya NO fabrica documentos (principio de Diego: el motor del KMS
// genera). Era REDUNDANTE con `sysConsentsLog` (KMS `enr_submitGdprConsents`, Step 9 — registro
// canónico de 24 campos por consentimiento incl. texto/versión/persona/timestamp/IP-UA + sello
// TSA) y WRITE-ONLY: ningún lector en ninguno de los dos repos lo consume. Las filas `recFiles`
// históricas con origin='WIZARD_SUBMIT' quedan intactas (no se borra dato). Ver el comentario en
// `submitEnrollmentSession_` + kis-app operational-pending §P262. (Helpers DocApp/Drive que SOLO
// usaba esta función quedan sin caller — inertes; no se borran por seguridad de blast-radius.)

// ─── Signing token resolution (Ola 4 — P37) ──────────────────────────────────

/**
 * P237 — Devuelve true si existe un milestone COMPLETED del type/anchor dados.
 * Fuente canónica de los flags de steps del wizard de firma.
 *
 * Resuelve `milestone_type_code` vía el catálogo `sysMilestoneTypes` (invariante
 * kis-app: la fila de `sysMilestones` NO lleva `milestone_type_code`, solo
 * `milestone_type_id` FK). `entity_type_code` y `entity_id` SÍ viven en la fila
 * (anchor escrito directo por el KMS).
 *
 * KAL-5: assertValidUuid_(entityId) + appsheetEscape_ en el Filter. entityTypeCode
 * y milestoneTypeCode son constantes server-side (no user input) → no requieren
 * escape. Defensa P72/KAL-11: ante read vacío/error devuelve false (no lanza),
 * loguea redactado.
 *
 * @param {string} entityTypeCode   'ENR_ADMISSION_SCHOOL' | 'SYS_SIGNING_SESSION_SIGNER'
 * @param {string} entityId         enrollment_group_id (BILLING) | signer_id (GDPR/REVIEW)
 * @param {string} milestoneTypeCode 'BILLING_STEP_COMPLETED' | 'GDPR_CONSENTS_SUBMITTED' | 'REVIEW_CONFIRMED'
 * @returns {boolean}
 */
/**
 * DL-E44 (2026-06-12) — hito DURABLE de grupo de progreso de firma, matcheado al
 * guardian via evidence_metadata_json.guardian_person_id (la fila milestone es
 * per-guardian, tipo is_repeatable). Una fila legacy sin guardian en evidencia
 * cuenta para cualquier firmante del grupo (degradacion conservadora: no re-pedir
 * un acto ya hecho). Mismo invariante de catalogo que isMilestoneCompleted_.
 * @private
 */
function isDurableSigningMilestoneCompleted_(groupId, guardianPersonId, milestoneTypeCode) {
  try {
    assertValidUuid_(groupId, 'enrollment_group_id');
  } catch (e) {
    return false;
  }
  try {
    var milestones = appsheetRequest_(T.MILESTONES, 'Find', [],
      { Filter: '"entity_id" = "' + appsheetEscape_(groupId) + '"' }) || [];
    if (!milestones.length) return false;
    var typeRows = appsheetRequest_(T.MILESTONE_TYPES, 'Find', [], {}) || [];
    var codeById = {};
    typeRows.forEach(function(t) { codeById[t.milestone_type_id] = t.milestone_type_code; });
    var gpid = String(guardianPersonId || '');
    for (var i = 0; i < milestones.length; i++) {
      var m = milestones[i];
      if (m.entity_type_code !== 'ENR_ADMISSION_SCHOOL') continue;
      if (m.deleted_at) continue;
      if (m.status !== 'COMPLETED') continue;
      var code = m.milestone_type_code || codeById[m.milestone_type_id] || null;
      if (code !== milestoneTypeCode) continue;
      var ev = {};
      try { ev = JSON.parse(m.evidence_metadata_json || '{}'); } catch (eEv) { ev = {}; }
      var evPid = String(ev.guardian_person_id || '');
      if (!evPid || (gpid && evPid === gpid)) return true;
    }
    return false;
  } catch (e2) {
    Logger.log(redact_('[isDurableSigningMilestoneCompleted_] read failed para ' + milestoneTypeCode + ': ' + e2.message));
    return false;
  }
}

function isMilestoneCompleted_(entityTypeCode, entityId, milestoneTypeCode) {
  try {
    assertValidUuid_(entityId, 'entityId');
  } catch (e) {
    Logger.log(redact_('[isMilestoneCompleted_] entityId inválido para ' + milestoneTypeCode + ': ' + e.message));
    return false;
  }

  try {
    var milestones = appsheetRequest_(T.MILESTONES, 'Find', [],
      { Filter: '"entity_id" = "' + appsheetEscape_(entityId) + '"' }) || [];
    if (!milestones.length) return false;

    // Catálogo: milestone_type_id → milestone_type_code (invariante: la fila NO lo lleva).
    var typeRows = appsheetRequest_(T.MILESTONE_TYPES, 'Find', [], {}) || [];
    var codeByTypeId = {};
    typeRows.forEach(function(t) {
      if (t && t['milestone_type_id']) codeByTypeId[t['milestone_type_id']] = t['milestone_type_code'];
    });

    return milestones.some(function(m) {
      if (!m || m['deleted_at']) return false;
      if (m['status'] !== 'COMPLETED') return false;
      if (m['entity_type_code'] !== entityTypeCode) return false;
      return codeByTypeId[m['milestone_type_id']] === milestoneTypeCode;
    });
  } catch (e) {
    // P72 / tabla no sembrada / columna ausente → no bloquear la resolución del token.
    Logger.log(redact_('[isMilestoneCompleted_] read defensivo (' + milestoneTypeCode +
      ' anchor=' + entityTypeCode + ') devuelve false: ' + e.message));
    return false;
  }
}

/**
 * Validates a guardian's signing_token against sysSigningSessionSigners and
 * resolves the associated signing session state.
 *
 * Queries AppSheet directly (same credentials as the rest of the wizard —
 * no KMS internal API call needed). Idempotent — read-only.
 *
 * Per roadmap §4.2 (wizard-admissions-roadmap.md) + DL-E24 §6.
 *
 * CLI 81 (S5 / KAL-NEW-1): the return shape NO LONGER includes signing_url —
 * the pre-auth resolve must not disclose the provider signing URL with only the
 * bearer token. signing_url[] is materialised by initiateSigningSession_.
 *
 * @param {{ signing_token: string }} p
 * @returns {{ valid: true, signer_id, session_id, enrollment_group_id,
 *             guardian_person_id, signer_role, signer_status, steps }
 *        | { valid: false, reason: 'INVALID'|'EXPIRED'|'REVOKED', state?: string }}
 */
function resolveSigningToken_(p) {
  if (!p || !p.signing_token) throw new Error('signing_token required');

  const token = String(p.signing_token).trim();

  // Audit: log attempt (partial token only — no PII)
  Logger.log('[resolveSigningToken_] attempt token=' + token.substring(0, 8) + '...');

  // P211: el KMS emite signing_tokens dashless (32-hex); el layout estricto UUID-v4
  // (KAL-5) los rechazaba todos. assertValidSigningToken_ acepta v4-con-guiones Y
  // dashless 32-hex (sigue hex-only). El appsheetEscape_ en la concatenación del
  // Filter (capa 2 KAL-5) permanece intacto como frontera de seguridad.
  try {
    assertValidSigningToken_(token, 'signing_token');
  } catch (_) {
    Logger.log('[resolveSigningToken_] token format invalid');
    return { valid: false, reason: 'INVALID' };
  }

  // 1. Lookup signer by signing_token via AppSheet Filter
  let signerRows;
  try {
    signerRows = appsheetRequest_(T.SIGNING_SESSION_SIGNERS, 'Find', [],
      { Filter: '"signing_token" = "' + appsheetEscape_(token) + '"' });
  } catch (findErr) {
    Logger.log('[resolveSigningToken_] sysSigningSessionSigners lookup failed: ' + findErr.message);
    return { valid: false, reason: 'INVALID' };
  }

  const signer = signerRows && signerRows.find(r => !r['deleted_at']);
  if (!signer) {
    Logger.log('[resolveSigningToken_] TOKEN_NOT_FOUND token=' + token.substring(0, 8) + '...');
    return { valid: false, reason: 'INVALID' };
  }

  const signerId  = signer['signer_id'];
  const sessionId = signer['session_id'];

  // 2. Load signing session (sessionId is DB-derived; assert UUID + escape)
  assertValidUuid_(sessionId, 'session_id');
  let sessionRows;
  try {
    sessionRows = appsheetRequest_(T.SIGNING_SESSIONS, 'Find', [],
      { Filter: '"session_id" = "' + appsheetEscape_(sessionId) + '"' });
  } catch (sessErr) {
    Logger.log('[resolveSigningToken_] sysSigningSessions lookup failed: ' + sessErr.message);
    return { valid: false, reason: 'INVALID' };
  }

  const session = sessionRows && sessionRows.find(s => !s['deleted_at']);
  if (!session) {
    Logger.log(redact_('[resolveSigningToken_] SESSION_NOT_FOUND session=' + sessionId));
    return { valid: false, reason: 'INVALID' };
  }

  // 3. Check terminal states
  const stateCode = session['current_state_code'] || '';
  if (stateCode === 'COMPLETED') {
    Logger.log(redact_('[resolveSigningToken_] SESSION_COMPLETED signer=' + signerId));
    return { valid: false, reason: 'REVOKED', state: stateCode };
  }
  if (stateCode === 'CANCELLED' || stateCode === 'EXPIRED') {
    Logger.log('[resolveSigningToken_] SESSION_TERMINAL state=' + stateCode);
    return { valid: false, reason: 'EXPIRED', state: stateCode };
  }

  // 4. entity_id = enrollment_group_id (DL-S46 polymorphic anchor)
  const enrollmentGroupId = session['entity_id'];

  // 5. Step completion states — P237 CERRADO: fuente canónica = milestones reales
  // en sysMilestones (estado COMPLETED), resueltos vía catálogo sysMilestoneTypes
  // (invariante kis-app: la fila NO lleva milestone_type_code). Anchors EXACTOS
  // según cómo los completa el KMS:
  //   BILLING_STEP_COMPLETED  → ENR_ADMISSION_SCHOOL    / enrollment_group_id (per-grupo)
  //   GDPR_CONSENTS_SUBMITTED → SYS_SIGNING_SESSION_SIGNER / signer_id        (per-firmante)
  //   REVIEW_CONFIRMED        → SYS_SIGNING_SESSION_SIGNER / signer_id        (per-firmante)
  // Ya NO se leen las cols DEROGADAS gdpr_step_completed_at / review_step_completed_at
  // (tombstone DL-E27/E28) ni el hardcode billing_confirmed=false (enrGroupBilling
  // CANCELADO DL-E28 §4/§12 — el billing canónico es finBillingParties + el milestone).
  // DL-E44 (2026-06-12): GDPR/REVIEW son ahora hitos DURABLES del GRUPO
  // (ENR_ADMISSION_SCHOOL / enrollment_group_id) con discriminador per-guardian en
  // evidence_metadata_json.guardian_person_id — sobreviven a la recreacion de la
  // sesion/firmante (antes: per-signer, entidad efimera → progreso orfano). Espejo
  // VERBATIM del lector canonico del KMS (sys/signing.gs sys_resolveSigningToken_).
  const billingConfirmed = isMilestoneCompleted_('ENR_ADMISSION_SCHOOL', enrollmentGroupId, 'BILLING_STEP_COMPLETED');
  const gdprCompleted    = isDurableSigningMilestoneCompleted_(enrollmentGroupId, signer['signer_person_id'], 'GDPR_CONSENTS_SUBMITTED')
                        || isMilestoneCompleted_('SYS_SIGNING_SESSION_SIGNER', signerId, 'GDPR_CONSENTS_SUBMITTED'); // fallback legacy pre-migracion
  const reviewCompleted  = isDurableSigningMilestoneCompleted_(enrollmentGroupId, signer['signer_person_id'], 'REVIEW_CONFIRMED')
                        || isMilestoneCompleted_('SYS_SIGNING_SESSION_SIGNER', signerId, 'REVIEW_CONFIRMED');       // fallback legacy pre-migracion
  const signed           = !!(signer['signed_at']);  // válido: campo real de la fila del signer

  Logger.log(redact_('[resolveSigningToken_] valid=true signer=' + signerId + ' group=' + enrollmentGroupId));

  return {
    valid:               true,
    signer_id:           signerId,
    session_id:          sessionId,
    enrollment_group_id: enrollmentGroupId,
    guardian_person_id:  signer['signer_person_id'] || null,
    signer_role:         signer['signer_role']       || null,
    signer_status:       stateCode,
    steps: {
      billing_confirmed: billingConfirmed,
      gdpr_completed:    gdprCompleted,
      gdpr_blocked:      false,  // sysConsentsLog check deferred per roadmap §4.5
      review_completed:  reviewCompleted,
      signed:            signed,
    },
    // signing_url removed (CLI 81 / S5 / KAL-NEW-1 mitigation Stage 1): the
    // pre-auth resolve must NOT disclose the materialised provider signing URL
    // with only the bearer token. The signing_url[] is returned exclusively by
    // initiateSigningSession_ (session.signerUrls) once the guardian is inside
    // the S-SIGN step and the token has already been stripped from the URL (S4).
    // SigningSteps.jsx reads signerUrls from initiateSigningSession, never from
    // resolveSigningToken — verified CLI 81.
  };
}

// ─── WS4 — Wizard pre-firma proxies a KMS (CLI 40, P118, GATE-D resuelto) ────
//
// Los 4 endpoints de firma (saveBillingInfo, submitGdprConsents, confirmReview,
// initiateSigningSession) son PROXIES finos al KMS con service token (patrón
// canónico fetchQuestions_, líneas ~1881-1945). El wizard family-facing es
// anónimo (`access: ANYONE_ANONYMOUS`) y NO puede llamar al KMS directamente
// — el KMS exige login Google (`Session.getActiveUser()`). Service token vía
// Script Properties `KMS_DEPLOYMENT_URL` + `QB_SERVICE_TOKEN` resuelve el
// puente anónimo↔KMS sin reimplementar lógica canónica.
//
// Cada proxy:
//   1. Valida el `signing_token` (flujo /sign) vía requireSigningToken_ (CLI 45).
//      El signing_token es el bearer canónico de las mutaciones /sign (paralelo
//      a resume_token para /apply). Resuelve signer/session/grupo server-side.
//   2. Reenvía `signing_token` al KMS (gate post-AD para Steps 8-11).
//   3. Construye envelope `{action, payload, requestId}` per contrato KMS
//      (apiCall en kms-server/_api.gs).
//   4. Devuelve la `data` del envelope (o re-lanza `error` para que el
//      wizard `doPost` lo mapee al `{ok:false, error:...}` canónico).
//
// MODO CONSERVADOR GATE-B (submitGdprConsents): un set de consentimientos por
// sesión / iniciador único, sin fan-out per-guardian. El estudio dual-parent
// (`docs/kms/research/dual-parent-question-respondent-model-2026-06.md`) sigue
// abierto — los proxies se ampliarán cuando GATE-B se resuelva.
//
// Cierra: P118 (4 endpoints firma) + HC-1 audit NIGHT-2.

/**
 * Helper común de proxy al KMS — réplica fina del patrón `fetchQuestions_`
 * (líneas ~1903-1945). Lee Script Properties, construye request al endpoint
 * `apiCall` del KMS y devuelve `envelope.data` o re-lanza `envelope.error`.
 *
 * @param {string} action — acción canónica del API_ROUTES del KMS
 *                          (`enr.saveBillingInfo`, `enr.submitGdprConsents`,
 *                          `enr.confirmReview`, `enr.initiateSigningSession`).
 * @param {Object} payload — payload del request KMS (sin envelope).
 * @returns {Object} `envelope.data` del KMS.
 * @throws {Error} con `.code` = código del KMS, `.message` = mensaje detallado.
 * @private
 */
/**
 * WPERF-2 — puente event-driven de drenado de la cola KMS sys_JobQueue.
 *
 * El wizard (backend PÚBLICO, ANYONE_ANONYMOUS) es el bridge AUTENTICADO entre el bot
 * AppSheet y el KMS: el KMS es USER_ACCESSING (exige login Google a nivel plataforma),
 * así que un webhook directo de AppSheet al KMS recibiría la página de login, NO el
 * dispatcher. En cambio el wizard sí acepta POST anónimo y reenvía vía kmsProxy_
 * (que adjunta el Bearer OAuth de la cuenta deployadora + el QB_SERVICE_TOKEN).
 *
 * GATE (§"funciones de diagnóstico/debug fuera del dispatcher público"): como CUALQUIER
 * action de doPost es invocable desde internet sin auth, este endpoint se gatea con un
 * secreto compartido en Script Property `DRAIN_SHARED_SECRET` comparado contra
 * `payload._secret`. Si no coincide (o no está configurado) → NO-OP SILENCIOSO
 * `{ drained:false }` (HTTP 200, NUNCA 403, NUNCA revela si el secreto existe). El
 * secreto solo autoriza DISPARAR el drenado; el trabajo real (y su auth KAL-4) vive en
 * el KMS (sys_drainJobQueue verifica además el QB_SERVICE_TOKEN). Red de seguridad si
 * el bot/secret fallan: el trigger time-driven KMS `sys_runJobQueue` (~1 min).
 *
 * @param {{ _secret?: string, limit?: number, schoolId?: string }} payload
 * @returns {{ drained: boolean, report?: Object }}
 */
function drainJobQueue_(payload) {
  payload = payload || {};
  const expected = PropertiesService.getScriptProperties().getProperty('DRAIN_SHARED_SECRET');
  const provided = payload._secret || '';
  if (!expected || String(provided) !== String(expected)) {
    Logger.log('[drainJobQueue_] _secret inválido/ausente — no-op silencioso (no 403)');
    return { drained: false };
  }
  try {
    const report = kmsProxy_('sys.drainJobQueue', {
      limit:    payload.limit || undefined,
      schoolId: payload.schoolId || undefined,
    });
    return { drained: true, report: report };
  } catch (e) {
    // Degradación: si el KMS no responde, el trigger time-driven drena igual. No-op.
    Logger.log('[drainJobQueue_] kmsProxy_ falló (red de seguridad: trigger ~1 min) — ' + redact_(e.message));
    return { drained: false };
  }
}

// ─── PERF-KMS2 (2026-06-11) — timing por segmento, dueño de cada segundo ─────
// Acumulador por-ejecución (los globals GAS viven una sola execution). Los
// endpoints instrumentados adjuntan `_perf` al response SOLO si el payload trae
// `_perf:true` Y el gate del bearer (KAL-4) ya pasó — nunca timing incondicional
// al público. KAL-11: solo nombres de segmento + ms, sin PII ni tokens.
var PERF2_ = { kms_fetch_ms: null, adm: null };

// ─── DBG-TRACE (petición Diego 2026-06-12 17:05): cronología server-side por request
// para el debug log del frontend. Evento = {t: ms desde recepción, e: tipo, d: detalle
// SIN PII/tokens (KAL-11)}. doPost adjunta `_dbg` SOLO si el payload trae `_dbg:true`.
// Estado global por ejecución — seguro en GAS (una ejecución = un hilo).
var DBGT_ = { on: false, t0: 0, ev: [] };
function _dbgStart_(payload) {
  DBGT_.on = !!(payload && payload._dbg === true);
  DBGT_.t0 = Date.now();
  DBGT_.ev = [];
}
function _dbgEv_(type, detail) {
  if (!DBGT_.on) return;
  try { DBGT_.ev.push({ t: Date.now() - DBGT_.t0, e: String(type), d: detail == null ? undefined : String(detail).slice(0, 120) }); } catch (e) {}
}
function _dbgBlock_() {
  if (!DBGT_.on) return undefined;
  return { server_ms: Date.now() - DBGT_.t0, received_at: new Date(DBGT_.t0).toISOString(), events: DBGT_.ev };
}

function kmsProxy_(action, payload) {
  const props        = PropertiesService.getScriptProperties();
  const kmsUrl       = props.getProperty('KMS_DEPLOYMENT_URL');
  const serviceToken = props.getProperty('QB_SERVICE_TOKEN');

  if (!kmsUrl || !serviceToken) {
    const err = new Error(
      'KMS proxy no configurado: Script Properties KMS_DEPLOYMENT_URL y QB_SERVICE_TOKEN requeridas'
    );
    err.code = 'KMS_NOT_CONFIGURED';
    throw err;
  }

  const envelope = {
    action:    action,
    payload:   Object.assign({ service_token: serviceToken }, payload || {}),
    requestId: generateUuid_(),
  };

  let httpResp;
  _dbgEv_('kms_call', action);
  const perfFetchT0 = Date.now(); // PERF-KMS2: aísla el hop HTTP wizard→KMS
  try {
    // El KMS es `access: ANYONE` → Google exige login a nivel de plataforma
    // ANTES de llegar al doPost. Un POST anónimo se redirige a la página de
    // sign-in (HTML) y nunca ejecuta el dispatcher → HTTP 401. El header
    // `Authorization: Bearer <OAuth token>` autentica la request como la
    // cuenta deployadora del wizard, pasando ese gate de plataforma. La
    // auth a nivel de aplicación sigue siendo el `service_token` en el
    // payload (DL-Q05 / QB_SERVICE_TOKEN) — el bearer solo abre la puerta.
    httpResp = UrlFetchApp.fetch(kmsUrl, {
      method:             'post',
      contentType:        'text/plain',
      headers:            { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() },
      payload:            JSON.stringify(envelope),
      followRedirects:    true,
      muteHttpExceptions: true,
    });
  } catch (netErr) {
    const err = new Error('KMS proxy network error: ' + netErr.message);
    err.code = 'KMS_NETWORK_ERROR';
    throw err;
  }
  PERF2_.kms_fetch_ms = Date.now() - perfFetchT0; // PERF-KMS2 (KAL-11: solo ms)
  _dbgEv_('kms_resp', action + ' ' + PERF2_.kms_fetch_ms + 'ms');
  Logger.log('[PERF] kmsProxy_ action=' + action + ' fetch_ms=' + PERF2_.kms_fetch_ms);

  const status = httpResp.getResponseCode();
  const text   = httpResp.getContentText();
  if (status !== 200) {
    const err = new Error('KMS proxy HTTP ' + status + ': ' + redact_(text.slice(0, 200)));
    err.code = 'KMS_HTTP_ERROR';
    throw err;
  }

  let resp;
  try {
    resp = JSON.parse(text);
  } catch (parseErr) {
    const err = new Error('KMS proxy non-JSON response: ' + redact_(text.slice(0, 200)));
    err.code = 'KMS_BAD_RESPONSE';
    throw err;
  }

  // Propaga el error del KMS tal cual al frontend (shape canónica
  // `{success:false, error:{code, message}}`).
  if (!resp || resp.success !== true) {
    const errPayload = resp && resp.error ? resp.error : { code: 'KMS_UNKNOWN', message: 'no error object' };
    const err = new Error(errPayload.message || ('KMS error: ' + errPayload.code));
    err.code = errPayload.code || 'KMS_UNKNOWN';
    throw err;
  }

  Logger.log('[kmsProxy_] action=' + action + ' ok requestId=' + envelope.requestId.substring(0, 8) + '...');
  return resp.data;
}

// ─── WIZARD-TERMINAL Parte 3/4 — envío de emails vía el motor único del KMS (P214) ──
// El contenido de los emails transaccionales del wizard lo gobierna el KMS (plantillas
// sysNotificationTemplates_T). El wizard ya NO renderiza/envía estos emails localmente:
// firma cada request con HMAC-SHA256 (secreto compartido NOTIFY_HMAC_SECRET) y delega.

/**
 * @private — hex estable de un byte[] firmado (output de computeHmacSha256Signature,
 * bytes -128..127). DEBE casar con notify_bytesToHex_ del KMS (notify-public.gs).
 */
function _kmsNotifyHex_(bytes) {
  var hex = '';
  for (var i = 0; i < bytes.length; i++) {
    var b = (bytes[i] & 0xFF).toString(16);
    if (b.length === 1) b = '0' + b;
    hex += b;
  }
  return hex;
}

/**
 * Envía una plantilla transaccional vía el endpoint firmado del KMS
 * `sys-public.sendNotification` (WIZARD-TERMINAL Parte 3, P214). Construye el contrato
 * canónico { template_code, recipient, context, nonce, timestamp, signature } con
 * canonical = template_code\nrecipient\nJSON.stringify(context)\nnonce\ntimestamp
 * (idéntico a notify-public.gs) y reusa kmsProxy_ (Bearer OAuth + envelope).
 *
 * Fail-closed: sin NOTIFY_HMAC_SECRET en Script Properties → throw NOTIFY_NOT_CONFIGURED
 * (el handler devuelve {ok:false}; NUNCA cae a Gmail local — single-source: el contenido
 * lo gobierna el KMS, P72). KAL-11: NO loguea el context (PII) en claro.
 *
 * @param {string} templateCode  uno de WIZARD_MAGIC_LINK | WIZARD_MAGIC_LINK_MULTI |
 *                               WIZARD_FAMILY_CONFIRMATION | WIZARD_INTERNAL_NOTIFICATION.
 * @param {string} recipient     email destino.
 * @param {Object} context       valores de placeholder (resume_url, gdpr_block, etc.).
 * @returns {Object} respuesta del KMS ({ sent, correlation_id }).
 */
function sendViaKmsNotify_(templateCode, recipient, context) {
  var secret = PropertiesService.getScriptProperties().getProperty('NOTIFY_HMAC_SECRET');
  if (!secret) {
    var e = new Error('NOTIFY_HMAC_SECRET no configurado en Script Properties del wizard — Diego debe copiarlo del KMS (manual_initNotifyHmacSecret)');
    e.code = 'NOTIFY_NOT_CONFIGURED';
    throw e;
  }
  context = context || {};
  var nonce = Utilities.getUuid();
  var ts = new Date().toISOString();
  var canonical = String(templateCode) + '\n' + String(recipient) + '\n' +
                  JSON.stringify(context) + '\n' + nonce + '\n' + ts;
  var sig = _kmsNotifyHex_(Utilities.computeHmacSha256Signature(canonical, secret));
  Logger.log(redact_('[sendViaKmsNotify_] template=' + templateCode + ' to=' + recipient));
  return kmsProxy_('sys-public.sendNotification', {
    template_code: templateCode,
    recipient:     recipient,
    context:       context,
    nonce:         nonce,
    timestamp:     ts,
    signature:     sig,
  });
}

/**
 * Envía el código OTP de verificación vía el endpoint SÍNCRONO firmado del KMS
 * `sys-public.sendAuthCode` (WIZARD-TERMINAL Parte 4, P253). Análogo a sendViaKmsNotify_
 * pero apuntando al endpoint síncrono de auth (render+envío inmediato, sin persistir el
 * código en sysNotificationLog). El contrato HMAC es idéntico. La generación/cache/
 * rate-limit del código siguen en el wizard (lógica de auth); solo render+envío van al KMS.
 *
 * @param {string} recipient  email destino (primary_email del grupo).
 * @param {Object} context    { OTP_CODE, LANG }.
 * @returns {Object} respuesta del KMS ({ sent }).
 */
function sendViaKmsAuthCode_(recipient, context) {
  var secret = PropertiesService.getScriptProperties().getProperty('NOTIFY_HMAC_SECRET');
  if (!secret) {
    var e = new Error('NOTIFY_HMAC_SECRET no configurado en Script Properties del wizard — Diego debe copiarlo del KMS (manual_initNotifyHmacSecret)');
    e.code = 'NOTIFY_NOT_CONFIGURED';
    throw e;
  }
  context = context || {};
  var templateCode = 'WIZARD_OTP';
  var nonce = Utilities.getUuid();
  var ts = new Date().toISOString();
  var canonical = templateCode + '\n' + String(recipient) + '\n' +
                  JSON.stringify(context) + '\n' + nonce + '\n' + ts;
  var sig = _kmsNotifyHex_(Utilities.computeHmacSha256Signature(canonical, secret));
  // KAL-11: NO loguear el OTP_CODE. Solo el destinatario redactado.
  Logger.log(redact_('[sendViaKmsAuthCode_] OTP to=' + recipient));
  return kmsProxy_('sys-public.sendAuthCode', {
    template_code: templateCode,
    recipient:     recipient,
    context:       context,
    nonce:         nonce,
    timestamp:     ts,
    signature:     sig,
  });
}

/**
 * @private — bloque HTML del aviso GDPR (bilingüe EN/ES), pre-renderizado por el wizard
 * para la plantilla magic-link (placeholder {{GDPR_BLOCK}}). Solo en la 1ª solicitud de
 * la familia (isFirstApp). Movido aquí desde el builder sendMagicLinkEmail_ (golden).
 * @param {boolean} isFirstApp
 * @returns {string} HTML o '' si no aplica.
 */
function _kmsRenderGdprBlock_(isFirstApp) {
  if (!isFirstApp) return '';
  return '<div style="margin:24px 0;padding:16px;background:#f2f4f7;border-left:4px solid #00a19a;border-radius:4px;font-size:0.9em;color:#4a5568;">'
    + '<strong>EN — Data Protection:</strong><br>' + CONSENT_TEXTS.gdpr.en
    + '<br><br>'
    + '<strong>ES — Protección de datos:</strong><br>' + CONSENT_TEXTS.gdpr.es
    + '<br><br><em>You accepted these terms when submitting the consent form. / Aceptaste estos términos al enviar el formulario de consentimiento.</em>'
    + '</div>';
}

/**
 * @private — bloque HTML de la lista de magic-links (recuperación multi-guardián),
 * pre-renderizado para la plantilla magic-link-multi (placeholder {{RESUME_LINKS_BLOCK}}).
 * Movido aquí desde el builder sendMagicLinkMultiEmail_ (golden). Cada link lleva su `?n=`
 * (email_id) paralelo al token, igual que el builder original.
 * @param {string[]} resumeTokens
 * @param {string[]} nEmailIds
 * @param {string}   lang
 * @returns {string} HTML.
 */
function _kmsRenderResumeLinksBlock_(resumeTokens, nEmailIds, lang) {
  var isEn = lang === 'en';
  return (resumeTokens || []).map(function(token, idx) {
    var nEmailId = (nEmailIds && nEmailIds[idx]) || null;
    var url = RESUME_BASE_URL + token + (nEmailId ? '?n=' + nEmailId : '');
    var label = isEn ? ('Application ' + (idx + 1)) : ('Solicitud ' + (idx + 1));
    return '<p style="margin:12px 0;"><a href="' + url + '" style="background:#00a19a;color:#fff;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:600;">' + label + '</a>'
      + '<span style="color:#6b7c93;font-size:0.85em;margin-left:12px;">' + url + '</span></p>';
  }).join('');
}

/**
 * @private — tabla HTML de solicitantes/tutores para el email interno de staff,
 * pre-renderizada para la plantilla internal-notification (placeholder {{APPLICANTS_TABLE}}).
 * Reusa el builder existente buildApplicationSubmittedBody_ (golden, ya arma la tabla).
 * @param {string} applicationId
 * @param {string} timestamp
 * @param {Array}  guardians
 * @param {Array}  applicants
 * @param {Object} app
 * @param {Object} qbResponseMap
 * @returns {string} HTML (cuerpo interno completo, que la plantilla envuelve).
 */
function _kmsRenderApplicantsTable_(applicationId, timestamp, guardians, applicants, app, qbResponseMap) {
  return buildApplicationSubmittedBody_(applicationId, timestamp, guardians, applicants, app, qbResponseMap);
}

/**
 * Step 8 S-BILLING — datos fiscales pagador (P49 — DL-E28 §4.3).
 *
 * Proxy fino al KMS `enr.saveBillingInfoQueued`. El wizard valida la identidad
 * del firmante (signing_token o resume_token+recovered_email) y reenvía los
 * datos fiscales del pagador. El KMS persiste en `finBillingParties` vía
 * `fin_saveBillingPartyFromWizard` (refactor CLI 84, P49/enrGroupBilling
 * CANCELADO 2026-06-03 — DL-E28 §4/§12) y completa el milestone BILLING_STEP_COMPLETED.
 *
 * Payload esperado (del frontend Step8Billing):
 *   { resume_token, signing_token, payer_type, payer_person_id?, fiscal_name,
 *     fiscal_tax_id?, fiscal_address_line1?, fiscal_address_city?,
 *     fiscal_postal_code?, fiscal_country?, billing_email,
 *     payers?: [{ payer_type:'GUARDIAN', payer_person_id, fiscal_name,
 *       fiscal_tax_id, fiscal_address_line1, fiscal_address_city,
 *       fiscal_postal_code, billing_email, split_percentage }] }
 * El reparto (`payers[]`) es solo entre tutores del grupo (sin facturación a
 * terceros). Se reenvía cuando el frontend lo manda; los campos single-payer
 * top-level se conservan por backwards-compat.
 *
 * @param {Object} p
 * @returns {Object} `data` del KMS (`{ billing_id, confirmed_at, already_confirmed? }`).
 */
function saveBillingInfo_(p) {
  // DL-A.3 — identidad unificada (★ CANÓNICA: colapso del signing_token). Acepta
  // (resume_token+recovered_email) [canónico] o signing_token [back-compat].
  // DL-A.4 — endpoint encolado: el KMS devuelve al instante {queued,job_id}.
  const sctx = requireSignerIdentity_(p); // PERF-WIZ: guardian lo valida el resolver único del KMS (anti-P245)
  // ★ SEC-STEPUP (finding #55): NO re-extender la ventana por uso (P-STEPUP-SLIDING retirado — convertía 10 min en infinitos → bypass del PII-gate en recarga).
  _wzCacheInvalidate_(p && p.resume_token); // WIZARD-CACHE: NUNCA servir stale tras un write del grupo

  return kmsProxy_('enr.saveBillingInfoQueued', Object.assign({}, sctx.identity, {
    // Canonical multi-payer reparto entre tutores (GUARDIAN only — sin facturación
    // a terceros). Se reenvía cuando el frontend lo manda; el KMS deriva grupo+signer
    // del token (KAL-4). Los campos single-payer top-level se mantienen por
    // backwards-compat con proxies/handlers que aún no leen `payers`.
    // CLI 10 (DL-E42 §3/§5): array de repartos PER-PARTICIPANTE (N subscriptions,
    // solo %). El KMS deriva grupo+enrollments del token (KAL-4) y valida que cada
    // enrollment_id ∈ grupo y cada pagador es guardian del grupo. Se reenvía solo en
    // modo "personalizar por hijo"; el default (un pagador para todos) sigue por
    // `payers`/single-payer (compat byte a byte con lo desplegado).
    per_participant:      (p.per_participant && p.per_participant.length) ? p.per_participant : undefined,
    payers:               (p.payers && p.payers.length) ? p.payers : undefined,
    payer_type:           p.payer_type           || null,
    payer_person_id:      p.payer_person_id      || null,
    fiscal_name:          p.fiscal_name          || null,
    fiscal_tax_id:        p.fiscal_tax_id        || null,
    fiscal_address_line1: p.fiscal_address_line1 || null,
    fiscal_address_city:  p.fiscal_address_city  || null,
    fiscal_postal_code:   p.fiscal_postal_code   || null,
    fiscal_country:       p.fiscal_country       || 'ES',
    billing_email:        p.billing_email        || null,
  }));
}

/**
 * WPERF-4 (bug 1) — Lee el reparto de facturación YA GUARDADO para rehidratar el
 * Step 8. Proxy fino a `enr.getSavedBillingSplits` (el KMS deriva grupo del token,
 * KAL-4). Devuelve `{ payers:[{payer_person_id, split_percentage, is_primary}],
 * per_participant:[{applicant_person_id, payers:[...]}] }`. Best-effort: si no hay
 * reparto guardado, ambos arrays vienen vacíos y el frontend cae a su seed default.
 *
 * @param {Object} p — { signing_token }
 * @returns {Object} `data` del KMS.
 */
function getSavedBillingSplits_(p) {
  // DL-A.3 — identidad unificada (colapso del signing_token). El KMS resuelve el
  // signer de (grupo+guardian) o del bearer legacy. Lectura → no se encola.
  const perfT0 = Date.now(); // PERF-KMS2
  const sctx = requireSignerIdentity_(p); // PERF-WIZ: guardian lo valida el resolver único del KMS (anti-P245)
  const perfIdentMs = Date.now() - perfT0;
  const perfP0 = Date.now();
  let data = kmsProxy_('enr.getSavedBillingSplits', sctx.identity);
  const perfProxyMs = Date.now() - perfP0;
  Logger.log('[PERF] getSavedBillingSplits t_identity=' + perfIdentMs + ' t_proxy=' + perfProxyMs +
             ' kms_fetch=' + PERF2_.kms_fetch_ms);
  if (p && p._perf === true) { // post-gate (KAL-4 ya pasó); solo segmentos+ms (KAL-11)
    data = Object.assign({}, data, { _perf: {
      t_identity_ms: perfIdentMs, t_proxy_ms: perfProxyMs,
      kms_fetch_ms: PERF2_.kms_fetch_ms, t_total_ms: Date.now() - perfT0,
    } });
  }
  return data;
}

/**
 * Step 9 S-GDPR — submit 7 consents GDPR (DL-E27 §2 reformulado per DL-S64 §2.4).
 *
 * MODO CONSERVADOR GATE-B (acordado 2026-06-01): un set de consentimientos por
 * sesión de firma / iniciador único, sin fan-out per-guardian. El estudio
 * dual-parent (`docs/kms/research/dual-parent-question-respondent-model-2026-06.md`)
 * sigue abierto — cuando GATE-B se resuelva, el proxy se ampliará per-guardian.
 *
 * Proxy fino al KMS `enr.submitGdprConsents`. El KMS:
 *   - Inserta N filas en sysConsentsLog (1 por consent).
 *   - Obtiene sello FreeTSA por consent (graceful fallback si TSA falla).
 *   - Si GDPR_SCHOOL rechazado → `{blocked:true}` SIN completar milestone.
 *   - Si no bloqueado → completa milestone GDPR_CONSENTS_SUBMITTED per signer.
 *
 * Payload esperado:
 *   { resume_token, signing_token, signer_ip?, consents: [
 *     { consent_type_code, consent_use?, consented, consent_text_shown,
 *       consent_text_version?, language?, signed_method?, user_agent?,
 *       evidence_metadata_json? }, ...
 *   ] }
 *
 * @param {Object} p
 * @returns {Object} `data` del KMS (`{ blocked, milestone?, consents_recorded, ... }`).
 */
function submitGdprConsents_(p) {
  // DL-A.3 — identidad unificada (colapso del signing_token). DL-A.4 — encolado
  // (era ~95s síncrono): el KMS devuelve al instante {queued,job_id}.
  const sctx = requireSignerIdentity_(p); // PERF-WIZ: guardian lo valida el resolver único del KMS (anti-P245)

  if (!Array.isArray(p.consents) || !p.consents.length) {
    throw new Error('consents must be a non-empty array');
  }
  // ★ SEC-STEPUP (finding #55): NO re-extender la ventana por uso (P-STEPUP-SLIDING retirado — convertía 10 min en infinitos → bypass del PII-gate en recarga).
  _wzCacheInvalidate_(p && p.resume_token); // WIZARD-CACHE: NUNCA servir stale tras un write del grupo

  // GATE-B modo conservador: pasamos el array consents[] tal cual sin
  // estructura per-guardian adicional. El handler KMS lo persiste como un
  // set para el signer del iniciador.
  return kmsProxy_('enr.submitGdprConsentsQueued', Object.assign({}, sctx.identity, {
    signer_ip:     p.signer_ip || null,
    consents:      p.consents,
  }));
}

/**
 * Step 10 S-REVIEW — confirma lectura de documentos (DL-E28 §6.2 reformulado
 * per DL-S64 §2.4).
 *
 * Proxy fino al KMS `enr.confirmReview`. El KMS completa el milestone
 * `REVIEW_CONFIRMED` para el signer (idempotente — si ya estaba COMPLETED
 * devuelve `{idempotent:true}`).
 *
 * Payload esperado: `{ resume_token, signing_token }`.
 *
 * @param {Object} p
 * @returns {Object} `data` del KMS (`{ idempotent, milestone }`).
 */
function confirmReview_(p) {
  // DL-A.3 — identidad unificada (colapso del signing_token). DL-A.4 — encolado.
  const sctx = requireSignerIdentity_(p); // PERF-WIZ: guardian lo valida el resolver único del KMS (anti-P245)
  // ★ SEC-STEPUP (finding #55): NO re-extender la ventana por uso (P-STEPUP-SLIDING retirado — convertía 10 min en infinitos → bypass del PII-gate en recarga).
  _wzCacheInvalidate_(p && p.resume_token); // WIZARD-CACHE: NUNCA servir stale tras un write del grupo

  // DL-E44 §2 (2026-06-12): reenviar accepted[] al KMS — antes se descartaba aquí
  // (solo viajaba la identidad) y el KMS no podía persistir las aceptaciones por
  // documento como evidencia del hito REVIEW_CONFIRMED. El KMS valida cada
  // file_id contra los documentos de la sesión del token (KAL-4) antes de persistir.
  const reviewBody = Object.assign({}, sctx.identity);
  if (Array.isArray(p && p.accepted)) reviewBody.accepted = p.accepted;
  return kmsProxy_('enr.confirmReviewQueued', reviewBody);
}

/**
 * Step 11 S-SIGN — inicia sesión de firma (DL-E28 §7-§13, §9.1).
 *
 * Proxy fino al KMS `enr.initiateSigningSession`. El KMS orquesta:
 *   (a) Genera/obtiene `pre_sign_file_id` de Carta + Contrato (CLI 32,
 *       `enr_generateSigningPackage_`).
 *   (b) Crea UNA sesión multi-documento vía `sys_createSigningSession_`
 *       (WS1b, framework DL-S46 §6) anclada a
 *       `(ENR_ADMISSION_SCHOOL, enrollment_group_id)`.
 *   (c) Invoca `sys_initiateSigningSession_` que dispatcha al driver
 *       Click & Sign real (CLI 25) — si las credenciales sandbox no están,
 *       el driver puede operar en modo mock via `is_mock=true` en
 *       `sysTenantServiceProviders_T`.
 *   (d) Devuelve signing_url + envelope_id + estado de la sesión.
 *
 * Payload esperado: `{ resume_token, signing_token? }`. El KMS resuelve
 * guardians, documentos y proveedor de firma desde el tenant config.
 *
 * @param {Object} p
 * @returns {Object} `data` del KMS (`{ session_id, envelopeId, signerUrls, state }`).
 */
/**
 * Inicia la sesión de firma (acto legal) vía el KMS.
 *
 * DL-E39 step-up: el acto de firma exige step-up fresco SIEMPRE (incondicional,
 * independiente de la ventana de inactividad) — firmar es la operación más
 * sensible del flujo. El enrollment_group_id se deriva del signing_token
 * (KAL-4), nunca del payload.
 *
 * @param {Object} p - { signing_token, client_ip? }
 *   - client_ip: EVIDENCIA forense del acto, NUNCA un gate. Es auto-reportada
 *     por el cliente y por tanto spoofable; se adjunta a la metadata del acto
 *     (KMS enr.initiateSigningSession) solo como pista, jamás para autorizar.
 */
function initiateSigningSession_(p) {
  // P-REVIEW-READONLY: create_only sólo CREA/garantiza la sesión DRAFT + tokens y
  // devuelve members/docs SIN despachar el envelope (KMS wizard-firma.gs).
  // Es preparación/lectura del Step 10, NO el acto legal de firma → no exige el
  // step-up INCONDICIONAL (ese gate es exclusivo del acto real, Step 11 sin create_only).
  const createOnly = !!(p && (p.create_only === true || p.create_only === 'true'));

  // DL-A.3 — identidad unificada (colapso del signing_token). DL-A.4 — encolado
  // (era 54-65s síncrono) + de-dupe server-side de create_only. El KMS resuelve
  // guardians/documentos/proveedor del grupo derivado de la identidad (KAL-4).
  // PERF-WIZ: la LECTURA create_only usa la identidad LIGERA (la validación del
  // guardian la hace el resolver único del KMS, anti-P245); el ACTO real de firma
  // (Step 11, sin create_only) conserva el camino COMPLETO de requireSignerContext_
  // — P222: las protecciones del acto jamás se adelgazan.
  const perfT0 = Date.now(); // PERF-KMS2
  const sctx = createOnly ? requireSignerIdentity_(p) : requireSignerContext_(p);
  const perfIdentMs = Date.now() - perfT0;

  // DL-E39: step-up INCONDICIONAL antes de iniciar el ACTO de firma (Step 11).
  // enrollment_group_id derivado de la identidad (KAL-4), nunca del payload.
  if (!createOnly) assertStepUpFresh_(sctx.enrollment_group_id);
  // ★ SEC-STEPUP (finding #55): NO re-extender la ventana por uso (P-STEPUP-SLIDING retirado — convertía 10 min en infinitos → bypass del PII-gate en recarga).

  // IP forense (best-effort): adjunta client_ip a la metadata del acto si el
  // cliente la reporta. KAL-11: redacta la IP en logs locales (no la imprimimos
  // aquí; la pasamos al KMS, que registra el acto en sysLegalActsLog).
  const clientIp = (p && typeof p.client_ip === 'string') ? p.client_ip.trim() : null;

  const proxyPayload = Object.assign({}, sctx.identity);
  if (createOnly) proxyPayload.create_only = true; // P-REVIEW-READONLY: NO despacha envelope
  if (clientIp) proxyPayload.client_ip = clientIp; // evidencia forense, NUNCA gate

  // DL-A.4 / DL-B — encolar SOLO el DISPATCH real (envelope, 54-65s síncronos). El
  // path create_only es una LECTURA/preparación idempotente del estado de la sesión
  // (members/state/signerUrls) que SignReview/SignSign consumen SÍNCRONAMENTE en el
  // mount + polling (initiateSigningRead) — encolarlo rompería esa lectura. El KMS ya
  // lo de-dupea/idempotentiza server-side; el single-flight de api.js lo de-dupea en
  // cliente. Por eso create_only → endpoint SÍNCRONO; dispatch → endpoint encolado.
  // SPEC-WIZ-WARMUP-V2 (2026-06-12) — cache-first POST-GATES de la LECTURA
  // create_only (members/state del paquete; 45-48s e2e en frio, #65). El warm la
  // cocina con el MISMO endpoint KMS; la entrada guarda live_version + `n` (stale
  // o guardian distinto → vivo). El ACTO real (sin create_only) JAMAS toca cache (P222).
  if (createOnly && p && p.resume_token) {
    try {
      const wzMemKey = _wzCacheKey_('mem', sctx.enrollment_group_id);
      const wzMemRaw = _wzCacheGetChunked_(CacheService.getScriptCache(), wzMemKey);
      if (wzMemRaw) {
        const memEntry = JSON.parse(wzMemRaw);
        if (memEntry && memEntry.data && memEntry.v === _getLiveStateVersion_(sctx.enrollment_group_id)) {
          Logger.log('[WZCACHE] HIT mem token=' + String(p.resume_token).slice(0, 8) + '...');
        _dbgEv_('cache', 'HIT mem');
          return (p._perf === true)
            ? Object.assign({}, memEntry.data, { _perf: { cache_hit: true, t_identity_ms: perfIdentMs, t_total_ms: Date.now() - perfT0 } })
            : memEntry.data;
        }
        if (memEntry && memEntry.data) {
          CacheService.getScriptCache().remove(wzMemKey + '_meta');
          Logger.log('[WZCACHE] STALE mem token=' + String(p.resume_token).slice(0, 8) + '... — invalidado');
        }
      }
      // V2.2 single-flight: si el warm está cocinando los members (log Diego 15:07 —
      // 2-3 lecturas create_only VIVAS de 37-49s compitiendo con el warm), esperar
      // su resultado (≤40s) antes de duplicar la lectura.
      if (!wzMemRaw) {
        _dbgEv_('wait', 'single-flight mem');
        const awaitedMem = _wzAwaitWarm_('wzck_mem_' + sctx.enrollment_group_id, wzMemKey, 40000);
        if (awaitedMem) {
          const memE2 = JSON.parse(awaitedMem);
          if (memE2 && memE2.data && memE2.v === _getLiveStateVersion_(sctx.enrollment_group_id)) {
            Logger.log('[WZCACHE] HIT mem (single-flight) token=' + String(p.resume_token).slice(0, 8) + '...');
            return (p._perf === true)
              ? Object.assign({}, memE2.data, { _perf: { cache_hit: true, single_flight: true, t_total_ms: Date.now() - perfT0 } })
              : memE2.data;
          }
        }
      }
    } catch (eWzMem) { /* best-effort → camino vivo */ }
  }

  const action = createOnly ? 'enr.initiateSigningSession' : 'enr.initiateSigningSessionQueued';
  const perfP0 = Date.now(); // PERF-KMS2
  let data = kmsProxy_(action, proxyPayload);
  const perfProxyMs = Date.now() - perfP0;
  Logger.log('[PERF] initiateSigningSession create_only=' + createOnly + ' t_identity=' + perfIdentMs +
             ' t_proxy=' + perfProxyMs + ' kms_fetch=' + PERF2_.kms_fetch_ms);
  // WIZARD-CACHE write-through de la lectura create_only (best-effort).
  if (createOnly && p && p.resume_token && data && data.members && data.members.length) {
    try {
      _wzCachePutChunked_(CacheService.getScriptCache(),
        _wzCacheKey_('mem', sctx.enrollment_group_id),
        JSON.stringify({ v: _getLiveStateVersion_(sctx.enrollment_group_id), data: data }), 1800);
    } catch (eWzWtM) { /* best-effort */ }
  }
  // PERF-KMS2: `_perf` SOLO en la LECTURA create_only (el ACTO real jamás se toca — P222)
  // y solo post-gate (KAL-4) bajo flag explícito. KAL-11: segmentos+ms, sin tokens.
  if (createOnly && p && p._perf === true) {
    data = Object.assign({}, data, { _perf: {
      t_identity_ms: perfIdentMs, t_proxy_ms: perfProxyMs,
      kms_fetch_ms: PERF2_.kms_fetch_ms, t_total_ms: Date.now() - perfT0,
    } });
  }
  return data;
}

// ─── DL-A — capa de datos del wizard (hidratación consolidada + liveState) ────

/**
 * DL-A.1 (spec §1) — Hidratación consolidada: UNA llamada devuelve TODO (datos 11 pasos
 * + lookups + qbResponses + contexto de firma + billing + versión liveState). Proxy fino
 * al KMS `enr.wizardHydrate` (DL-E41: el KMS es la fuente de verdad de datos; el wizard
 * transporta identidad y renderiza). KAL-4: el gate `requireResumeToken_` valida el
 * resume_token (grupo server-side); el guardian que recupera se resuelve server-side del
 * `recovered_email` (a1) — en el wizard para el gate, y de nuevo en el KMS.
 *
 * El frontend (DL-B) llena su store en memoria con este payload y NUNCA re-fetchea al
 * navegar (elimina resumeSession+fetchLookups+getSavedBillingSplits+resolveSigningToken
 * + los re-fetch por-navegación — causa raíz de la spec).
 *
 * @param {Object} p — { resume_token, recovered_email? }
 * @returns {Object} payload consolidado del KMS.
 */
/**
 * OTP-WARM pieza B (spec 2026-06-11): ceba la cache warm del hydrate DURANTE la ventana
 * del OTP, sin devolver PII. La idea de Diego ("por qué no está el wizard precargando
 * datos… sólo se pone a hidratar cuando introduzco el otp"): lo que el OTP autoriza es
 * VER la PII, no COCINARLA — la identidad (grupo) ya la da el resume_token. Este endpoint
 * dispara la MISMA ensamblación que hydrateSession_ (proxy enr.wizardHydrate, cuya cache
 * warm KMS-side se ceba en el write-through de SPEC-WIZ-WARMUP) y DESCARTA el resultado:
 * al cliente solo cruza {ok, warmed}. Tras validar el OTP, hydrateSession sirve warm-hit.
 *
 * Guardas: requireResumeToken_ (KAL-4) + rate-limit 1 warm/grupo/120s (es caro). El
 * frontend lo dispara fire-and-forget al pintar la pantalla OTP.
 */
function warmSession_(p) {
  const groupId = requireResumeToken_(p);
  const rlCache = CacheService.getScriptCache();
  const rlKey = 'warmrl_' + groupId;
  if (rlCache.get(rlKey)) return { ok: true, warmed: false, reason: 'RATE_LIMITED' };
  rlCache.put(rlKey, '1', 120);

  // Identidad efectiva — VERBATIM de hydrateSession_ (IDENTITY-FROM-LINK): la clave de
  // la cache warm KMS incluye recovered_email + locale; debe coincidir con la que usará
  // el hydrate real post-OTP o el warm no haría hit.
  let bindGroupRow = null;
  try {
    const bgRows = appsheetRequest_(T.ENROLLMENT_GROUPS, 'Find', [], {
      Filter: '"resume_token" = "' + appsheetEscape_(p.resume_token) + '"'
    });
    bindGroupRow = (bgRows && bgRows.length) ? bgRows[0] : null;
  } catch (e) { bindGroupRow = null; }
  const effRecoveredEmail = effectiveRecoveredEmail_(p && p.recovered_email, groupId, p && p.n, null, null, bindGroupRow);

  // WIZARD-CACHE (decisión Diego 2026-06-12): el warm de la pantalla OTP cocina el
  // bundle ENTERO wizard-side (hydrate troceado + admission + PDFs del paquete), no
  // solo el warm KMS — cubre la entrada SIN link fresco (en el caso normal el trigger
  // del envío del magic-link ya lo dejó caliente; warmEntryBundle_ es idempotente:
  // si wz_hyd_<token> ya está, reusa y solo completa lo que falte). La misma llamada
  // enr.wizardHydrate de antes vive DENTRO del bundle → el warm KMS (L2) se ceba igual.
  var w = warmEntryBundle_(String(p.resume_token).trim(), effRecoveredEmail || null,
    (p && p.language) ? String(p.language).trim() : null, (p && p.n) || null, groupId);
  if (!w.hydrate) {
    // Best-effort: un warm fallido no es error de cara al cliente (el hydrate real
    // post-OTP seguirá su camino normal). Log redactado para correlación.
    Logger.log(redact_('[warmSession_] warm FALLÓ group=' + groupId));
    return { ok: true, warmed: false, reason: 'WARM_FAILED' };
  }
  return { ok: true, warmed: true, docs: w.docs, members: w.members };
}

/**
 * SPEC-WIZ-WARMUP-V2 (2026-06-12, arquitectura dictada por Diego) — action pública del
 * precalentado del bundle de entrada. La dispara el frontend FIRE-AND-FORGET justo tras
 * pedir un magic link (auto-invocación concurrente del wizard a su propio /exec): la
 * ejecución invocada sigue viva server-side aunque el caller corte la conexión
 * (VERIFICADO 2026-06-12: curl -m 3 sobre warmSession → bundle cocinado, cache HIT).
 * PROHIBIDO el trigger temporal (mecanismo V1, retirado — no ganaba la carrera del
 * "minuto muerto"). NOTA de plataforma: UrlFetchApp NO soporta timeout configurable,
 * por eso el caller que corta es el frontend (browser), no el backend.
 *
 * Dos modos:
 *  - { ticket }: ticket opaco single-use (TTL 300s, _mintWarmTicket_) que mapea
 *    server-side a [{t,n,e,l}] — el frontend nunca conoce el resume_token nuevo.
 *    Ticket desconocido/expirado/reusado → {ok:false} silencioso (sin oráculo).
 *  - { resume_token, n?, language? }: passthrough a warmSession_ (gate KAL-4
 *    requireResumeToken_ dentro). Útil para verificación outside-in por curl.
 *
 * Seguridad: KAL-4 intacta (el warm se computa contra el grupo derivado del token
 * server-side; el servido re-valida gates token+step-up). Devuelve SOLO conteos.
 * Multi-familia: claves per-token/per-ticket, cero estructuras compartidas con RMW.
 */
function warmBundle_(p) {
  // ── Fase HIJA (V2.1): pase interno single-use minteado por el padre ──────────
  if (p && p.pass) {
    var ps = String(p.pass).trim();
    try { assertValidUuid_(ps, 'pass'); } catch (eVp) { return { ok: false }; }
    var pCache = CacheService.getScriptCache();
    var pKey = 'wzwp_' + ps;
    var pRaw = pCache.get(pKey);
    pCache.remove(pKey); // single-use SIEMPRE
    if (!pRaw) return { ok: false };
    var it0;
    try { it0 = JSON.parse(pRaw) || {}; } catch (ePp) { return { ok: false }; }
    if (!it0.t) return { ok: false };
    if (it0.phase === 'res') return _warmResumePhase_(it0);
    if (it0.phase === 'mem') return _warmMembersDocsPhase_(it0);
    // fase 'kms' — bundle KMS-side (hydrate+admission+members+docs), mismo gate
    // KAL-4 y rate-limit que el warm de la pantalla OTP (warmSession_).
    try {
      return warmSession_({ resume_token: it0.t, n: it0.n || null, recovered_email: it0.e || null, language: it0.l || null });
    } catch (eWk) {
      Logger.log(redact_('[warmBundle_] fase kms non-fatal — ' + (eWk && eWk.message)));
      return { ok: false };
    }
  }
  if (p && p.ticket) {
    var tk = String(p.ticket).trim();
    try { assertValidUuid_(tk, 'ticket'); } catch (eV) { return { ok: false }; }
    var cache = CacheService.getScriptCache();
    var key = 'wzwt_' + tk;
    var raw = cache.get(key);
    cache.remove(key); // single-use SIEMPRE (también si el parse falla)
    if (!raw) return { ok: false };
    var items = [];
    try { items = JSON.parse(raw) || []; } catch (eP) { return { ok: false }; }
    // V2.1: por cada item, DOS fases hijas CONCURRENTES (fetchAll al propio /exec):
    //  - 'res': payload de resume wizard-side (~25-30s) — lo primero que pide el click.
    //  - 'kms': hydrate+admission+members+bytes PDF (30-90s, dominado por el pull KMS).
    // Antes secuencial: el warm no ganaba la carrera del minuto muerto (round 5).
    var passes = [];
    items.forEach(function(it) {
      if (!it || !it.t) return;
      var pr = _mintWarmPass_({ t: it.t, n: it.n || null, e: it.e || null, l: it.l || null, phase: 'res' });
      var pk = _mintWarmPass_({ t: it.t, n: it.n || null, e: it.e || null, l: it.l || null, phase: 'kms' });
      // V2.3: fase 'mem' CONCURRENTE e independiente del hydrate — el paso 10
      // (members+docs) queda caliente aunque el usuario llegue en <60s.
      var pm = _mintWarmPass_({ t: it.t, n: it.n || null, e: it.e || null, l: it.l || null, phase: 'mem' });
      if (pr) passes.push({ pass: pr });
      if (pk) passes.push({ pass: pk });
      if (pm) passes.push({ pass: pm });
    });
    _wzSelfFetchAll_(passes);
    return { ok: true, phases: passes.length };
  }
  // Sin ticket: mismo gate y semántica que el warm de la pantalla OTP (KAL-4 dentro).
  return warmSession_(p);
}

function hydrateSession_(p) {
  const groupId = requireResumeToken_(p);  // KAL-4 + TTL 7d + abandoned gate

  // DL-B — gracia magic-link + gate PII (espejo EXACTO de resumeSession_:2116-2198).
  // El endpoint consolidado de DL-A (enr.wizardHydrate) NO conoce el step-up/nonce del
  // wizard (viven en SU ScriptCache), así que esas dos semánticas se aplican AQUÍ:
  //  (1) Gracia (IDENTITY-FROM-LINK): anclada al resume_token recién rotado
  //      (mlgrace_<resume_token>), NO al `?n=` (que ahora lleva email_id, identidad). Si
  //      el token tiene marcador válido (<10 min) → step-up fresco → sin OTP (step_up_fresh:true).
  //  (2) Gate PII (DL-E39): si el step-up NO está fresco, el cliente ANÓNIMO recibe SOLO
  //      lo no-PII (estructura + admission + lookups + versión) con pii_gated:true; la PII
  //      (persons/relations/documents/responses + billing) NUNCA cruza al cliente antes
  //      del OTP. El wizard backend (trusted) sí recibe todo del KMS, pero lo filtra.
  const graceOk = _consumeMagicLinkNonce_(p && p.resume_token, groupId);
  if (graceOk) _markStepUpFresh_(groupId, 'GRACE');
  const stepUpFresh = _isStepUpFresh_(groupId);

  // A (WIZARD-STEPUP) — gate ANTES de pagar el hydrate pesado. El gate PII (DL-E39)
  // estaba DESPUÉS del kmsProxy_ (~30s) → el OTP de entrada salía tras la espera. Ahora,
  // si el step-up NO está fresco, NO llamamos al KMS: el StepUpGate del frontend solo
  // necesita `group` (enrollment_group_id + resume_token), así que basta un read BARATO
  // de la fila de grupo — verbatim resumeSession_:2130-2135 (mismo selector + escape
  // KAL-5). requireResumeToken_ ya validó UUID + TTL + abandoned_at; si aun así groups
  // viene vacío, group:null es aceptable (el gate ya tiene el resume_token en su closure).
  if (!stepUpFresh) {
    const groups = appsheetRequest_(T.ENROLLMENT_GROUPS, 'Find', [], {
      Filter: '"resume_token" = "' + appsheetEscape_(p.resume_token) + '"'
    });
    const group = (groups && groups.length) ? groups[0] : null;
    // IMPL-F: consistencia ISO también en el path gateado. Este read barato NO llama al
    //   KMS → sin programas no hay fallback a period_starts_on; pero si la fila trae la
    //   fecha la normalizamos igual para no cruzar slash al cliente.
    if (group) group.desired_start_date = normalizeDate_(group.desired_start_date);
    return {
      group,
      enrollments:    [],
      admission:      null,
      lookups:        {},
      questions:      null,
      live_version:   0,
      persons:        [], relations: [], documents: [], responses: [],
      billing_splits: { payers: [], per_participant: [] },
      step_up_fresh:  false,
      pii_gated:      true,
    };
  }

  // IDENTITY-FROM-LINK (2026-06-11): deriva el recovered_email EFECTIVO server-side DEL
  // PROPIO ENLACE. `p.n` (email_id del enlace) → email del guardian, validado contra el
  // grupo del token (KAL-4) → el KMS recibe SIEMPRE la identidad del guardian que recuperó,
  // sin depender del cliente. Prioridad `n` > recovered_email (compat). Read barato de la
  // fila de grupo como groupHint (fallback requester del email de creación).
  let bindGroupRow = null;
  try {
    const bgRows = appsheetRequest_(T.ENROLLMENT_GROUPS, 'Find', [], {
      Filter: '"resume_token" = "' + appsheetEscape_(p.resume_token) + '"'
    });
    bindGroupRow = (bgRows && bgRows.length) ? bgRows[0] : null;
  } catch (e) { bindGroupRow = null; }
  const effRecoveredEmail = effectiveRecoveredEmail_(p && p.recovered_email, groupId, p && p.n, null, null, bindGroupRow);

  // DL-A §1 — UNA llamada al KMS devuelve TODO (lookups + datos 11 pasos + qbResponses
  // + admission + signing_context + billing_splits + live_version).
  // WIZARD-CACHE (2026-06-12): cache-first — si el warm (magic-link / pantalla OTP)
  // dejó wz_hyd_<token> wizard-side, servimos de ScriptCache local y ahorramos el hop
  // al KMS. Estamos en el path step-up FRESCO (el gate PII de arriba ya corrió — el
  // cache solo cambia el ORIGEN). Las adaptaciones post-proxy de abajo (questions/
  // fechas/phones/reopen) son EL MISMO código para ambos orígenes (idempotentes — el
  // cache guarda la respuesta RAW del KMS, como el warm). Write-through best-effort
  // en el camino vivo; los writes del grupo invalidan via _wzCacheInvalidate_.
  let data = null;
  const wzHydCache = CacheService.getScriptCache();
  const wzHydKey = _wzCacheKey_('hyd', groupId + '_' + _wzN_(p && p.n));
  try {
    const wzHydRaw = _wzCacheGetChunked_(wzHydCache, wzHydKey);
    if (wzHydRaw) {
      const envH = JSON.parse(wzHydRaw);
      data = (envH && envH.v === _getLiveStateVersion_(groupId)) ? envH.data : null;
      // V2.4.1 (regresión cazada por el _dbg de Diego 17:33 — "resume_token not
      // recognized" intermitente): el payload cacheado por GRUPO puede haberse
      // cocinado en una sesión con token YA ROTADO y lo lleva EMBEBIDO en la fila
      // del grupo → el frontend lo adoptaba. El gate de ESTA llamada ya validó que
      // el token del caller pertenece a este grupo → sobrescribir SIEMPRE.
      if (data && data.group) data.group.resume_token = String(p.resume_token).trim();
      if (data) Logger.log('[WZCACHE] HIT hyd token=' + String(p.resume_token).slice(0, 8) + '…');
        _dbgEv_('cache', 'HIT hyd');
    }
  } catch (eWzHyd) { data = null; /* best-effort → camino vivo */ }
  if (!data) {
    // V2.2 single-flight (log Diego 15:06 — hydrate 73,7s por ESTAMPIDA): si el warm
    // está cocinando este token, esperar su resultado (≤60s) en vez de lanzar un
    // segundo pull KMS que compite con él. Marcador caído / timeout → pull vivo.
    try {
      _dbgEv_('wait', 'single-flight hyd (warm en curso)');
      const awaited = _wzAwaitWarm_('wzck_hyd_' + groupId + '_' + _wzN_(p && p.n), wzHydKey, 60000);
      if (awaited) {
        const envH2 = JSON.parse(awaited);
        data = (envH2 && envH2.v === _getLiveStateVersion_(groupId)) ? envH2.data : null;
        if (data && data.group) data.group.resume_token = String(p.resume_token).trim(); // V2.4.1 (ver arriba)
        if (data) Logger.log('[WZCACHE] HIT hyd (single-flight) token=' + String(p.resume_token).slice(0, 8) + '…');
      }
    } catch (eAw) { data = null; }
  }
  if (!data) {
    data = kmsProxy_('enr.wizardHydrate', {
      resume_token:    String(p.resume_token).trim(),
      recovered_email: effRecoveredEmail || null,
      language:        (p && p.language) ? String(p.language).trim() : null,
    }) || {};
    try { _wzCachePutChunked_(wzHydCache, wzHydKey,
      JSON.stringify({ v: _getLiveStateVersion_(groupId), data: data }), 1800); } catch (eWzWt) { /* best-effort */ }
  }

  // DL-C-A (g): el KMS pliega el catálogo de preguntas (raw qb) en el hydrate. Lo
  // adaptamos aquí al shape { sets:[…] } que consume el frontend — mismo adaptador que
  // el path fetchQuestions legacy → el wizard ya NO necesita la llamada fetchQuestions
  // suelta (DL-C-B la elimina del frontend). No es PII (catálogo estático).
  if (data && data.questions) {
    try { data.questions = fetchQuestions_adaptKmsResponse_(data.questions, (p && p.language) || 'es'); }
    catch (e) { data.questions = { sets: [] }; }
  }

  // B (WIZARD-STEPUP) — honrar la frescura REAL de 10 min (decisión Diego). Antes se
  //   reportaba `step_up_fresh: graceOk` (solo el nonce de magic-link) → en una recarga
  //   sin nonce salía false aunque stepup_ok_<group> siguiera fresco (TTL 10 min) y el
  //   frontend re-gateaba (re-OTP en cada recarga). Aquí estamos en el path fresco
  //   (stepUpFresh === true), así que reusar la variable evita una 2ª lectura del cache.

  // IMPL-F (regresión DL-C) — normaliza desired_start_date a ISO YYYY-MM-DD + fallback a
  //   program.period_starts_on. enr.wizardHydrate devolvía la fila del KMS TAL CUAL (sin
  //   normalizeDate_) → la fecha cruzaba en slash ("05/01/2026") y el <input type="date">
  //   del Step 1 quedaba vacío. Verbatim del lector probado resumeSession_:2317,2323-2329,
  //   adaptado: aquí los programas llegan en data.lookups.programs
  //   ({ program_id, period_starts_on, … } — KMS wizard-gateway.gs:265-274), NO en topRead.
  if (data.group) {
    data.group.desired_start_date = normalizeDate_(data.group.desired_start_date);
    if (!data.group.desired_start_date && data.group.program_id) {
      const progs = (data.lookups && data.lookups.programs) || [];
      const prog  = progs.find(function(pr) { return pr && pr.program_id === data.group.program_id; });
      if (prog && prog.period_starts_on) {
        data.group.desired_start_date = normalizeDate_(prog.period_starts_on);
      }
    }
  }
  // La fecha canónica vive en enrEnrollments (no en el group); normaliza también
  //   enrollments[0].desired_start_date para que ambas vías crucen en ISO coherente
  //   (frontend WizardContext.jsx:698 considera ambas en su baseline de completitud).
  if (data.enrollments && data.enrollments[0] && data.enrollments[0].desired_start_date) {
    data.enrollments[0].desired_start_date = normalizeDate_(data.enrollments[0].desired_start_date);
  }

  // IMPL-J (extensión de §1.bis a date_of_birth) — el round-trip 2026-06-09 cazó que
  //   persons[].date_of_birth volvía en slash (MM/DD/YYYY) → el <input type="date"> del Step 2
  //   quedaba VACÍO. resumeSession_ SÍ normalizaba (verbatim :2403); hydrateSession_ (IMPL-F)
  //   normalizó solo desired_start_date. Aquí extendemos a cada persona. Solo date_of_birth es
  //   fecha en persons[]; place_of_birth NO es fecha.
  if (data.persons && data.persons.length) {
    data.persons.forEach(function(person) {
      if (person && person.date_of_birth) {
        person.date_of_birth = normalizeDate_(person.date_of_birth);
      }
    });
  }

  // PHONE-STORE (P259 / §1.ter) — el KMS hydrate devuelve enrPhones.value RAW (sin '+',
  //   AppSheet/Sheets lo pela). Reconstruimos E.164 con '+' aquí, capa de presentación del
  //   wizard (espejo del IMPL-J de date_of_birth y de la firma _signing_normalizePhoneE164_).
  //   Línea de reconstrucción VERBATIM del código-de-oro submitEnrollmentSession_:2717.
  if (data.persons && data.persons.length) {
    data.persons.forEach(function(person) {
      if (!person || !person.phones || !person.phones.length) return;
      person.phones.forEach(function(ph) {
        ['phone_number', 'value'].forEach(function(k) {
          var s = String(ph[k] == null ? '' : ph[k]).trim();
          if (s && s[0] !== '+' && /^\d+$/.test(s)) ph[k] = '+' + s;   // P259: AppSheet quita el +
        });
      });
    });
  }

  // REOPEN-FIX (regresión DL-C) — honra el reopen del KMS conducido por `admission.editable`.
  //   enr_wizardHydrate ya calcula `editable = !submitted_at || allInfo` (todas las enrollments
  //   en IN/NEEDS_MORE_INFO). Si el grupo trae `submitted_at` pero el KMS lo declara editable
  //   (reopen), anulamos `submitted_at` en la respuesta — restaura el efecto probado de
  //   resumeSession_:2344, CONDUCIDO por el `editable` del KMS (sin re-implementar el check de
  //   estado). El frontend (WizardContext) deriva el lock de `group.submitted_at` → así desbloquea
  //   la UI al reabrir.
  if (data.admission && data.admission.editable && data.group && data.group.submitted_at) {
    Logger.log(redact_('hydrateSession_: KMS admission.editable=true (reopen) — submitted_at overridden to null for group ' + data.group.enrollment_group_id));
    data.group.submitted_at = null;
  }

  return Object.assign({}, data, { step_up_fresh: stepUpFresh });
}

/**
 * DL-A.5 (Opción A §2) — Recibe el notify KMS→wizard de un cambio de estado/milestone y
 * bumpa la versión liveState del grupo (ScriptCache). NO es un endpoint de usuario: lo
 * llama SOLO el KMS (CALL_WEBHOOK_ASYNC). Gate por secreto compartido
 * `WIZARD_NOTIFY_SECRET` (Script Property); secreto inválido/ausente → no-op estructurado
 * `{ok:false}` (NUNCA 403, NUNCA revela si el grupo existe — patrón qb-public/drainJobQueue).
 *
 * @param {Object} p — { notify_secret, enrollment_group_id, reason? }
 * @returns {{ok:boolean, bumped?:boolean, version?:number, reason?:string}}
 */
function notifyLiveStateChange_(p) {
  p = p || {};
  const expected = PropertiesService.getScriptProperties().getProperty('WIZARD_NOTIFY_SECRET');
  const provided = p.notify_secret || '';
  if (!expected || String(provided).trim() !== String(expected).trim()) {
    Logger.log('[notifyLiveStateChange_] secreto inválido/ausente — no-op (estructurado, no 403)');
    return { ok: false, reason: 'UNAUTHORIZED' };
  }
  const groupId = p.enrollment_group_id;
  try { assertValidUuid_(groupId, 'enrollment_group_id'); } catch (e) { return { ok: false, reason: 'BAD_REQUEST' }; }
  const version = _bumpLiveStateVersion_(groupId);
  Logger.log(redact_('[notifyLiveStateChange_] bumped group=' + groupId + ' reason=' + (p.reason || '?') + ' -> v' + version));
  return { ok: true, bumped: true, version: version };
}

/**
 * DL-A.5 (Opción A §2) — Cheap-poll: devuelve SOLO la versión liveState del grupo. Lee el
 * ScriptCache (efímero), SIN tocar AppSheet ni el KMS — diseñado para llamarse con alta
 * frecuencia (on-focus + intervalo). El frontend solo hace el fetch de detalle del
 * liveState (o re-hidrata) cuando la versión sube respecto a la que tiene en memoria.
 *
 * El `enrollment_group_id` lo aporta el frontend (lo obtuvo de la hidratación). El valor
 * es un entero no sensible (cuenta de cambios); el bump exige el secreto del KMS, así que
 * la lectura abierta no es un vector (no expone datos). assertValidUuid_ por higiene.
 *
 * @param {Object} p — { enrollment_group_id }
 * @returns {{version:number}}
 */
function getLiveStateVersion_(p) {
  const groupId = p && p.enrollment_group_id;
  try { assertValidUuid_(groupId, 'enrollment_group_id'); } catch (e) { return { version: 0 }; }
  return { version: _getLiveStateVersion_(groupId) };
}

// ─── Promotion logic ──────────────────────────────────────────────────────────
// promoteEnrollment_ removed 2026-05-30 (CLI 63 — KAL-3 closed). The canonical
// operation lives in the KMS as enr.promoteToCore (kis-app/kms-server/enr/
// promote.gs), invoked by staff with real auth (DOMAIN restricted, @kaleide.org).
// See CLAUDE.md §Security and docs/kms/design-logs/enr-module-design-log.md DL-E36.

// ─── Utility helpers ──────────────────────────────────────────────────────────

/**
 * Returns true if the address object contains at least one meaningful field.
 * @param {Object} addr
 * @returns {boolean}
 */
function hasAddressData_(addr) {
  return !!(addr && (addr.address_line_1 || addr.city || addr.country_id || addr.zip));
}

/**
 * Generates a UUID v4 string.
 * @returns {string}
 */

// Change this constant when you change the Google Sheet regional settings.
// 'ES' = Spain / European = D/M/YYYY
// 'US' = United States    = M/D/YYYY
// NOTE: AppSheet API format is independent of Google Sheets regional settings — observed as M/D/YYYY
var APPSHEET_DATE_LOCALE = 'ES';

/**
 * Normalises any date string to ISO YYYY-MM-DD.
 *
 * Explicit format detection — does NOT rely on locale-dependent Date() parsing:
 *   1. YYYY-MM-DD       → already ISO, return as-is
 *   2. slash-separated  → detect D/M/YYYY vs M/D/YYYY:
 *      - first segment > 12  → must be a day  → D/M/YYYY
 *      - second segment > 12 → must be a day  → M/D/YYYY
 *      - both ≤ 12           → ambiguous, resolved by APPSHEET_DATE_LOCALE
 *
 * Returns null for falsy input.
 */
function normalizeDate_(dateStr) {
  if (!dateStr) return null;
  if (/^\d{4}-\d{2}-\d{2}/.test(dateStr)) return dateStr.slice(0, 10);
  var parts = dateStr.split('/');
  if (parts.length === 3) {
    var a = parseInt(parts[0], 10);
    var b = parseInt(parts[1], 10);
    var y = parts[2];
    var day, mon;
    if (a > 12)                            { day = a; mon = b; }   // unambiguously D/M
    else if (b > 12)                       { mon = a; day = b; }   // unambiguously M/D
    else if (APPSHEET_DATE_LOCALE === 'ES'){ day = a; mon = b; }   // ambiguous → ES
    else                                   { mon = a; day = b; }   // ambiguous → US
    return y + '-' + String(mon).padStart(2, '0') + '-' + String(day).padStart(2, '0');
  }
  Logger.log('normalizeDate_: unrecognised format "' + dateStr + '"');
  return dateStr;
}

/**
 * Generates a v4 UUID using Apps Script's crypto-grade SecureRandom-backed generator.
 *
 * Replaces previous Math.random()-based implementation (KAL-1 audit 2026-05-29):
 * Math.random() is a non-cryptographic PRNG whose internal state can be inferred
 * from a few observed outputs in V8, allowing prediction of subsequent tokens.
 * Critical because the same helper generates resume_token (auth secret of the
 * magic-link). Predictable tokens → attacker forges magic links of arbitrary
 * families and reads/modifies their submission.
 *
 * Utilities.getUuid() delegates to Google's SecureRandom (Java backend) —
 * cryptographically secure, same UUID v4 format, no consumer changes needed.
 *
 * Future canonical cleanup (roadmap item P???, Vía B): omit PK from Add payloads
 * entirely and rely on AppSheet's UNIQUEID() Initial Value per Diego 2026-05-30
 * observation. UNIQUEID is honored only when payload PK is absent; this helper's
 * value is currently sent explicitly, overriding AppSheet's secure generator.
 */
function generateUuid_() {
  return Utilities.getUuid();
}

/**
 * Formats an ISO timestamp in Atlantic/Canary timezone.
 * @param {string} isoString
 * @returns {string}
 */
function formatTimestamp_(isoString) {
  try {
    return Utilities.formatDate(
      new Date(isoString),
      'Atlantic/Canary',
      'dd MMM yyyy HH:mm:ss z'
    );
  } catch (_) {
    return isoString;
  }
}

/**
 * Gets or creates a Drive folder by name at the root.
 * @param {string} name
 * @returns {Folder}
 */
function getOrCreateDriveFolder_(name) {
  const folders = DriveApp.getFoldersByName(name);
  if (folders.hasNext()) return folders.next();
  return DriveApp.createFolder(name);
}


/**
 * One-shot maintenance: marks pre-existing orphan sessions as abandoned.
 *
 * Run MANUALLY from the Apps Script editor (Run → adminCleanupOrphanSessions)
 * once, after deploying the single-session policy (commit c8b4cc7). It
 * sweeps enrEnrollmentGroups for rows that:
 *
 *   - have no submitted_at  (never finished)
 *   - have no abandoned_at  (not yet marked)
 *   - are older than 30 days OR are duplicates of the same email
 *
 * and stamps abandoned_at = now on each. Future initEnrollmentSession_
 * calls then bypass them cleanly.
 *
 * Why 30 days (vs the 7-day resumeSession_ TTL):
 *   The TTL prevents new resumes but the rows still appear in
 *   sendMagicLink_'s by-email path until abandoned. A 30-day cutoff is
 *   conservative — old enough to be confidently dead, recent enough that
 *   genuine multi-week-old sessions aren't surprise-killed if a family
 *   reaches out to admisiones@.
 *
 * Why duplicates of same email:
 *   The new policy collapses to one open per email. Existing duplicates
 *   from before the policy must be reduced to one. Keeps the
 *   most-recently-updated non-abandoned row (proxy for "the one with
 *   actual work done on it"); marks the rest. NOTE: earlier draft of
 *   this script kept the OLDEST per email — that was wrong and was
 *   corrected 2026-05-19 after Diego's test produced the exact opposite
 *   of the intended outcome (the empty stale session won, the filled
 *   one was abandoned).
 *
 * Returns a summary { scanned, abandoned, kept } and logs each row id.
 * Safe to re-run — idempotent (skips already-abandoned rows).
 */
/**
 * Manually clears the magic-link block AND rate-limit counter for a given
 * email. Used to recover from a reportUnsolicited_ that locked the address
 * for ~6h, or from a rate-limit that the family triggered accidentally.
 *
 * Usage (manual, from Apps Script editor):
 *   1. Project Settings → Script Properties → set UNBLOCK_TARGET_EMAIL
 *      to the address to unblock (e.g. ground.contact@gmail.com)
 *   2. Editor → Run → adminUnblockEmail
 *   3. Look at the Execution log — confirms the cleared keys
 *   4. (Optional) Remove the Script Property afterwards
 *
 * Effects:
 *   - magic_blocked_<email>: removed (releases the 6h hard-block)
 *   - magic_count_<email>:   removed (resets rate-limit to 0/3)
 *
 * Does NOT undo:
 *   - abandoned_at on existing sessions (those stay abandoned — correct,
 *     they were reported as unsolicited; new init will create fresh)
 *   - the internal email already sent to staff (audit trail preserved)
 *
 * Idempotent: re-running with no cache entries is a no-op.
 *
 * @returns {{ ok: boolean, email?: string, reason?: string }}
 */
function adminUnblockEmail() {
  const props = PropertiesService.getScriptProperties();
  const email = (props.getProperty('UNBLOCK_TARGET_EMAIL') || '').toLowerCase().trim();
  if (!email) {
    Logger.log('adminUnblockEmail: Script Property UNBLOCK_TARGET_EMAIL is empty. ' +
               'Set it in Project Settings → Script Properties and re-run.');
    return { ok: false, reason: 'no_email_property' };
  }
  const cache = CacheService.getScriptCache();
  const blockKey = 'magic_blocked_' + Utilities.base64EncodeWebSafe(email);
  const countKey = 'magic_count_'   + Utilities.base64EncodeWebSafe(email);
  cache.remove(blockKey);
  cache.remove(countKey);
  // KAL-11: redact email — even admin tools shouldn't write plaintext PII to Stackdriver.
  Logger.log(redact_('adminUnblockEmail: cleared block + count for ' + email));
  return { ok: true, email: email };
}

function adminCleanupOrphanSessions() {
  const now = new Date();
  const CUTOFF_MS = 30 * 24 * 60 * 60 * 1000;
  const all = appsheetRequest_(T.ENROLLMENT_GROUPS, 'Find', [], {}) || [];
  const open = all.filter(g => !g.submitted_at && !g.abandoned_at);

  // Group by email to detect duplicates
  const byEmail = {};
  open.forEach(g => {
    const k = (g.primary_email || '').toLowerCase().trim();
    if (!k) return;
    (byEmail[k] = byEmail[k] || []).push(g);
  });

  const toAbandon = [];
  const kept = [];

  // Pre-fetch person counts for all candidate sessions in a few batched
  // queries (mirrors the live policy heuristic — see initEnrollmentSession_
  // for rationale: person count is a cheap proxy for progress, with
  // updated_at as tiebreaker).
  const personCountByGroup = {};
  const allCandidateIds = open.map(g => g.enrollment_group_id);
  // AppSheet Filter syntax tolerates fairly long OR expressions, but split
  // into chunks of 50 to stay safe.
  for (let i = 0; i < allCandidateIds.length; i += 50) {
    const chunk = allCandidateIds.slice(i, i + 50);
    try {
      const filter = chunk.map(id => '"enrollment_group_id" = "' + appsheetEscape_(id) + '"').join(' || ');
      const rows = appsheetRequest_(T.PERSONS, 'Find', [], { Filter: filter }) || [];
      rows.forEach(r => {
        const k = r.enrollment_group_id;
        personCountByGroup[k] = (personCountByGroup[k] || 0) + 1;
      });
    } catch (e) {
      Logger.log('adminCleanupOrphanSessions: person count chunk ' + i + ' failed: ' + e.message);
    }
  }

  Object.keys(byEmail).forEach(email => {
    // Sort: most progressed first (person count), then most-recently-updated.
    const sessions = byEmail[email].slice().sort((a, b) => {
      const ac = personCountByGroup[a.enrollment_group_id] || 0;
      const bc = personCountByGroup[b.enrollment_group_id] || 0;
      if (bc !== ac) return bc - ac;
      const au = new Date(a.updated_at || a.created_at || 0).getTime();
      const bu = new Date(b.updated_at || b.created_at || 0).getTime();
      return bu - au;
    });
    // Keep the most progressed; mark every other one as abandoned.
    // Edge: if the keeper is itself older than 30 days (by updated_at),
    // abandon it too — covers the "abandoned long ago" case.
    sessions.forEach((s, i) => {
      const lastTouched = new Date(s.updated_at || s.created_at).getTime();
      if (i === 0 && (now.getTime() - lastTouched) <= CUTOFF_MS) {
        kept.push(s);
      } else {
        toAbandon.push(s);
      }
    });
  });

  let actuallyAbandoned = 0;
  const failures = [];
  toAbandon.forEach(s => {
    try {
      appsheetRequest_(T.ENROLLMENT_GROUPS, 'Edit', [{
        enrollment_group_id: s.enrollment_group_id,
        abandoned_at:        now.toISOString(),
        updated_at:          now.toISOString(),
      }]);
      // KAL-11: redact group_id (UUID) and email before persisting to Stackdriver.
      Logger.log(redact_('abandoned: ' + s.enrollment_group_id + ' email=' + s.primary_email) + ' age_days=' + Math.round((now - new Date(s.created_at)) / 86400000));
      actuallyAbandoned++;
    } catch (e) {
      Logger.log(redact_('FAILED to abandon ' + s.enrollment_group_id + ': ' + e.message));
      failures.push({ id: s.enrollment_group_id, error: e.message.slice(0, 200) });
    }
  });

  const summary = {
    scanned:    open.length,
    toAbandon:  toAbandon.length,   // intended
    abandoned:  actuallyAbandoned,  // succeeded
    failed:     failures.length,
    kept:       kept.length,
    failures:   failures,
  };
  // KAL-11: summary.failures contains per-row {id: enrollment_group_id, error}.
  // Redact the UUIDs before persisting to Stackdriver.
  Logger.log(redact_('adminCleanupOrphanSessions summary: ' + JSON.stringify(summary)));
  return summary;
}

// === MANUAL TESTS ===
// Run these from the GAS editor after clasp push. They are not invoked by
// doPost — they are debug-only wrappers Diego can pick from the editor's
// function dropdown.

/**
 * KAL-5: tests the AppSheet Filter escape helper. Pure function, no DB call.
 * Logs each expected/actual pair so failures show up as `false` in the
 * execution log.
 */
function manual_testAppSheetEscape() {
  // Normal cases
  Logger.log('hola: ' + (appsheetEscape_('hola') === 'hola'));
  Logger.log('empty: ' + (appsheetEscape_('') === ''));
  Logger.log('null: ' + (appsheetEscape_(null) === ''));
  Logger.log('undefined: ' + (appsheetEscape_(undefined) === ''));
  // Coercion
  Logger.log('number 42: ' + (appsheetEscape_(42) === '42'));
  // Attack vector — the canonical KAL-5 injection payload
  Logger.log('inject: ' + (appsheetEscape_('victima" || "1"="1') === 'victima"" || ""1""=""1'));
  // Multiple quotes
  Logger.log('multi: ' + (appsheetEscape_('a"b"c') === 'a""b""c'));
}

/**
 * KAL-5: tests the validation assertions reject injection payloads and
 * accept legitimate inputs. Each PASS line confirms the assertion threw on
 * the malicious input; FAIL means the guard let it through.
 */
function manual_testFilterInjectionDefense() {
  // Email injection rejected
  try {
    assertValidEmail_('victima" || "1"="1', 'email');
    Logger.log('FAIL — assertion should have thrown for injection email');
  } catch (e) {
    Logger.log('PASS — injection email rejected: ' + e.message);
  }
  // UUID injection rejected
  try {
    assertValidUuid_('aaaa" OR "1"="1', 'uuid');
    Logger.log('FAIL — assertion should have thrown for injection UUID');
  } catch (e) {
    Logger.log('PASS — injection UUID rejected: ' + e.message);
  }
  // Non-string inputs rejected
  try {
    assertValidUuid_(null, 'uuid');
    Logger.log('FAIL — null should have thrown');
  } catch (e) {
    Logger.log('PASS — null UUID rejected: ' + e.message);
  }
  try {
    assertValidEmail_(undefined, 'email');
    Logger.log('FAIL — undefined should have thrown');
  } catch (e) {
    Logger.log('PASS — undefined email rejected: ' + e.message);
  }
  // Over-long email rejected
  try {
    assertValidEmail_('a'.repeat(255) + '@b.c', 'email');
    Logger.log('FAIL — over-long email should have thrown');
  } catch (e) {
    Logger.log('PASS — over-long email rejected: ' + e.message);
  }
  // Valid inputs accepted (do NOT throw)
  assertValidEmail_('test@example.com', 'email');
  assertValidUuid_('a8bf5292-eb12-43f8-9a82-1d2a39c11f4e', 'uuid');
  Logger.log('PASS — valid email + UUID accepted');
}

/**
 * KAL-4: tests that requireResumeToken_ enforces the IDOR boundary.
 * Pure-shape checks (no DB) for malformed/missing inputs; the DB-backed
 * cases are gated to allow Diego to plug real tokens.
 */
function manual_testRequireResumeToken() {
  // Caso 1: token válido → resuelve group_id correctamente
  // Diego: descomenta con un resume_token real conocido y verifica que retorna su group_id.
  // const groupId = requireResumeToken_({ resume_token: '<RESUME_TOKEN_REAL>' });
  // Logger.log('PASS — resolved group_id from real token: ' + groupId);

  // Caso 2: token malformado → throws
  try {
    requireResumeToken_({ resume_token: 'not-a-uuid' });
    Logger.log('FAIL — malformed token should have thrown');
  } catch (e) {
    Logger.log('PASS — malformed token rejected: ' + e.message);
  }

  // Caso 3: token válido pero payload claims different group_id → throws
  // Diego: descomenta con un resume_token real + un enrollment_group_id de OTRA familia
  // try {
  //   requireResumeToken_({
  //     resume_token: '<RESUME_TOKEN_REAL>',
  //     enrollment_group_id: '<GROUP_ID_DE_OTRA_FAMILIA>'
  //   });
  //   Logger.log('FAIL — cross-group payload should have thrown');
  // } catch (e) {
  //   Logger.log('PASS — cross-group payload rejected: ' + e.message);
  // }

  // Caso 4: payload sin resume_token → throws
  try {
    requireResumeToken_({});
    Logger.log('FAIL — missing token should have thrown');
  } catch (e) {
    Logger.log('PASS — missing token rejected: ' + e.message);
  }

  // Caso 5: token con shape válido pero NO existe en BD → throws
  try {
    requireResumeToken_({ resume_token: '00000000-0000-0000-0000-000000000000' });
    Logger.log('FAIL — unknown token should have thrown');
  } catch (e) {
    Logger.log('PASS — unknown token rejected: ' + e.message);
  }
}

/**
 * KAL-4: end-to-end IDOR defense smoke test for saveStep_.
 * Requires Diego to plug a real resume_token and a foreign group_id.
 */
function manual_testIdorDefenseSaveStep() {
  // Caso 1: saveStep con token y group_id matching → OK (sólo group-level edit).
  // Diego: descomenta con datos reales.
  // const ok = saveStep_({
  //   resume_token:        '<RESUME_TOKEN_REAL>',
  //   enrollment_group_id: '<GROUP_ID_DEL_MISMO_TOKEN>',
  //   step:                'application',
  //   payload:             { source: 'TEST_KAL4' }
  // });
  // Logger.log('PASS — same-group saveStep OK: ' + JSON.stringify(ok));

  // Caso 2: saveStep con token A pero group_id de familia B → throws "Unauthorized".
  // Diego: descomenta con un token real y un group_id de OTRA familia.
  // try {
  //   saveStep_({
  //     resume_token:        '<RESUME_TOKEN_REAL_A>',
  //     enrollment_group_id: '<GROUP_ID_FAMILIA_B>',
  //     step:                'application',
  //     payload:             { source: 'TEST_KAL4' }
  //   });
  //   Logger.log('FAIL — cross-group saveStep should have thrown');
  // } catch (e) {
  //   Logger.log('PASS — cross-group saveStep rejected: ' + e.message);
  // }
}

/**
 * CLI 26 (2026-06-01) — end-to-end test for the post-submit edit lock.
 *
 * Verifies the backend state-gate: once submitted_at IS NOT NULL on the
 * enrollment group row, saveStep_/saveResponses_/uploadDocument_ must reject
 * with err.code='NOT_EDITABLE' (which doPost converts to HTTP 200 + {ok:false,
 * error:{code:'NOT_EDITABLE',message:...}}).
 *
 * Cómo ejecutar desde el editor GAS:
 *
 *   1. Crea (o coge) un grupo SIN submitted_at. Ten a mano su resume_token.
 *   2. Edita las constantes RESUME_TOKEN_REAL y GROUP_ID abajo y guarda.
 *   3. Selecciona "manual_testApplicationEditRejectionOnSubmitted" en el
 *      selector de funciones del editor → Run.
 *   4. Lee los PASS/FAIL en View → Logs.
 *
 * Cobertura:
 *   - Caso 1: token válido + group en DRAFT (sin submitted_at) → saveStep OK.
 *   - Caso 2: forzamos submitted_at = now en el group (Edit directo a la
 *     tabla, simulando un submit que ya ocurrió) → siguiente saveStep falla
 *     con err.code='NOT_EDITABLE'.
 *   - Caso 3: limpiamos submitted_at de vuelta a null → saveStep OK otra vez
 *     (la KMS también restablece este campo cuando reabre a IN).
 *
 * Nota: el caso 2 marca el group como submitted en BD, así que tras el test
 * el group queda "enviado". Vuelve a DRAFT manualmente desde AppSheet si lo
 * necesitas para más pruebas, o usa el cleanup automático del caso 3.
 */
function manual_testApplicationEditRejectionOnSubmitted() {
  Logger.log('=== manual_testApplicationEditRejectionOnSubmitted ===');

  // ── EDITA ESTAS DOS CONSTANTES ANTES DE EJECUTAR ──────────────────────────
  const RESUME_TOKEN_REAL = '<RESUME_TOKEN_REAL>';  // p. ej. de un init/resume reciente
  const GROUP_ID          = '<ENROLLMENT_GROUP_ID>'; // del mismo grupo

  if (RESUME_TOKEN_REAL.indexOf('<') === 0) {
    Logger.log('SKIP — rellena RESUME_TOKEN_REAL y GROUP_ID arriba antes de ejecutar.');
    return;
  }

  // Caso 1: DRAFT (sin submitted_at) → saveStep OK
  try {
    const ok = saveStep_({
      resume_token:        RESUME_TOKEN_REAL,
      enrollment_group_id: GROUP_ID,
      step:                'application',
      payload:             { source: 'TEST_CLI26' }
    });
    Logger.log('PASS Caso 1 (DRAFT editable): saveStep OK → ' + JSON.stringify(ok));
  } catch (e) {
    Logger.log('FAIL Caso 1: esperaba OK en DRAFT, throw: ' + e.message + ' (code=' + (e.code || 'none') + ')');
    return;
  }

  // ── Forzar submitted_at = now para simular el estado post-submit ─────────
  const now = new Date().toISOString();
  appsheetRequest_(T.ENROLLMENT_GROUPS, 'Edit', [{
    enrollment_group_id: GROUP_ID,
    submitted_at:        now,
    updated_at:          now,
  }]);
  Logger.log('  setup: submitted_at=' + now + ' aplicado al group para Caso 2');

  // Caso 2: post-submit → saveStep DEBE rechazar con code='NOT_EDITABLE'
  try {
    saveStep_({
      resume_token:        RESUME_TOKEN_REAL,
      enrollment_group_id: GROUP_ID,
      step:                'application',
      payload:             { source: 'TEST_CLI26_post_submit' }
    });
    Logger.log('FAIL Caso 2: esperaba NOT_EDITABLE, saveStep pasó sin throw');
  } catch (e) {
    if (e.code === 'NOT_EDITABLE') {
      Logger.log('PASS Caso 2 (SUBMITTED bloqueado): rejected con code=NOT_EDITABLE → ' + e.message);
    } else {
      Logger.log('FAIL Caso 2: code esperado NOT_EDITABLE, recibido ' + (e.code || 'none') + ' / msg: ' + e.message);
    }
  }

  // ── También verificar saveResponses_ y uploadDocument_ ───────────────────
  try {
    saveResponses_({
      resume_token:        RESUME_TOKEN_REAL,
      enrollment_group_id: GROUP_ID,
      responses:           [{ question_id: 'fake-qid', response_text: 'should reject' }]
    });
    Logger.log('FAIL Caso 2b (saveResponses_): esperaba NOT_EDITABLE, pasó sin throw');
  } catch (e) {
    if (e.code === 'NOT_EDITABLE') {
      Logger.log('PASS Caso 2b (saveResponses_ SUBMITTED bloqueado): rejected con code=NOT_EDITABLE');
    } else {
      Logger.log('FAIL Caso 2b: code esperado NOT_EDITABLE, recibido ' + (e.code || 'none') + ' / msg: ' + e.message);
    }
  }

  // ── Caso 3: limpiar submitted_at (simula reopen por KMS) → editable de nuevo
  appsheetRequest_(T.ENROLLMENT_GROUPS, 'Edit', [{
    enrollment_group_id: GROUP_ID,
    submitted_at:        '',
    updated_at:          new Date().toISOString(),
  }]);
  Logger.log('  cleanup: submitted_at limpiado para Caso 3');

  try {
    const ok = saveStep_({
      resume_token:        RESUME_TOKEN_REAL,
      enrollment_group_id: GROUP_ID,
      step:                'application',
      payload:             { source: 'TEST_CLI26_reopen' }
    });
    Logger.log('PASS Caso 3 (reopen → editable): saveStep OK → ' + JSON.stringify(ok));
  } catch (e) {
    // Nota: AppSheet a veces ignora null/empty strings para DateTime; si esto
    // falla, el group puede quedar marcado submitted en BD. Revertir manualmente.
    Logger.log('FAIL Caso 3 (puede ser AppSheet no aceptó limpiar submitted_at): ' + e.message);
  }

  Logger.log('=== fin manual_testApplicationEditRejectionOnSubmitted ===');
}

/**
 * KAL-11: tests the redact_ helper covers emails + UUIDs and is idempotent.
 * Pure function, no DB call. Each PASS line confirms the substitution worked.
 */
function manual_testLogRedaction() {
  // Email basic
  Logger.log('PASS email: ' + (redact_('user@example.com saved row') === '[EMAIL] saved row'));
  // Email with plus alias + subdomain
  Logger.log('PASS email plus: ' + (redact_('a.b+tag@mail.kaleide.org logged in') === '[EMAIL] logged in'));
  // UUID lowercase
  Logger.log('PASS uuid lower: ' + (redact_('group=a8bf5292-eb12-43f8-9a82-1d2a39c11f4e') === 'group=[UUID]'));
  // UUID uppercase
  Logger.log('PASS uuid upper: ' + (redact_('id=A8BF5292-EB12-43F8-9A82-1D2A39C11F4E done') === 'id=[UUID] done'));
  // Both at once
  Logger.log('PASS both: ' + (redact_('foo@bar.com 11111111-2222-3333-4444-555555555555 ok') === '[EMAIL] [UUID] ok'));
  // Idempotent — re-redacting a redacted string is a no-op
  Logger.log('PASS idempotent: ' + (redact_(redact_('foo@bar.com')) === '[EMAIL]'));
  // null / undefined preserved
  Logger.log('PASS null: ' + (redact_(null) === null));
  Logger.log('PASS undef: ' + (redact_(undefined) === undefined));
  // Number coerced to string
  Logger.log('PASS number: ' + (redact_(42) === '42'));
  // No false positives on plain text
  Logger.log('PASS plain: ' + (redact_('nothing sensitive here') === 'nothing sensitive here'));
}

/**
 * KAL-10: tests that recognizeFamily_ returns the silent-ack constant shape
 * for public callers regardless of whether the email exists. Requires a known
 * existing email and a known non-existing email — Diego: fill the constants
 * below before running, or leave the shape-only assertions which require no DB.
 */
function manual_testRecognizeFamilyAntiEnum() {
  // Shape assertion — public response is ALWAYS {matched: false, persons: []}.
  // We can't easily test the matched case without a real email, but we can
  // verify the shape on a confirmed-non-existing email (no DB row required —
  // the contactEmails Find returns []).
  try {
    var out = recognizeFamily_({
      primary_email:   'no-such-email-' + Date.now() + '@example.invalid',
      recaptcha_token: '_bypass_' // RECAPTCHA_SECRET unset in dev → skips check
    });
    var shapeOk = out && out.matched === false && Array.isArray(out.persons) && out.persons.length === 0;
    Logger.log('PASS public shape (no-match): ' + shapeOk + ' (' + JSON.stringify(out) + ')');
  } catch (e) {
    Logger.log('SKIP public shape — reCAPTCHA configured: ' + e.message);
  }

  // Diego: descomenta y rellena con un email REAL conocido de Kaleide para
  // verificar que la respuesta pública aún es {matched: false, persons: []}
  // (el internal: true SÍ devolvería matched: true con nombres).
  // try {
  //   var publicOut = recognizeFamily_({ primary_email: '<EMAIL_REAL_KIS>', recaptcha_token: '_bypass_' });
  //   Logger.log('PASS anti-enum: ' + (publicOut.matched === false && publicOut.persons.length === 0) +
  //              ' (' + JSON.stringify(publicOut) + ')');
  //   var internalOut = recognizeFamily_({ primary_email: '<EMAIL_REAL_KIS>' }, { internal: true });
  //   Logger.log('PASS internal still gets names: ' + (internalOut.matched === true && internalOut.persons.length > 0));
  // } catch (e) {
  //   Logger.log('FAIL — recognizeFamily_ threw: ' + e.message);
  // }
}

/**
 * DL-Q05 Q05-S5 — smoke test cross-script wizard → KMS qb-public.
 *
 * Llama `fetchQuestions_({context_code:'ENROLLMENT', language:'es'})` y
 * loggea la response. Si las Script Properties `KMS_DEPLOYMENT_URL` y
 * `QB_SERVICE_TOKEN` están configuradas, la llamada va por HTTP al motor
 * canónico del KMS. Si no, falla con el mensaje legible
 * "Q05-S5 pending init: missing KMS_DEPLOYMENT_URL or QB_SERVICE_TOKEN".
 *
 * Procedimiento de uso:
 *   1. En el KMS GAS editor: ejecutar `manual_initQbServiceToken()` y copiar el token.
 *   2. En este wizard GAS editor → Project Settings → Script Properties:
 *        QB_SERVICE_TOKEN   = <token>
 *        KMS_DEPLOYMENT_URL = <URL /exec activa del KMS>
 *   3. Ejecutar esta función. Verificar en Logger que hay sets devueltos con
 *      shape legacy (items[].question.question_text + options[].text).
 */
function manual_testQbCrossScript() {
  const props = PropertiesService.getScriptProperties();
  const hasUrl   = !!props.getProperty('KMS_DEPLOYMENT_URL');
  const hasToken = !!props.getProperty('QB_SERVICE_TOKEN');
  Logger.log('Pre-check: KMS_DEPLOYMENT_URL=' + hasUrl + ', QB_SERVICE_TOKEN=' + hasToken);
  if (!hasUrl || !hasToken) {
    Logger.log('FAIL — Script Properties incompletas. Configura ambas y reintenta.');
    return;
  }

  try {
    const out = fetchQuestions_({ context_code: 'ENROLLMENT', language: 'es' });
    const setCount = (out.sets || []).length;
    const ctxCode  = out.context ? out.context.context_code : '(no context)';
    Logger.log('PASS — fetchQuestions_ devolvió ' + setCount + ' sets para context=' + ctxCode);
    (out.sets || []).forEach((s, si) => {
      const itemCount = (s.items || []).length;
      Logger.log('  set[' + si + ']: id=' + s.set_id
               + ' designation="' + (s.designation || '') + '"'
               + ' items=' + itemCount
               + ' default=' + !!s.is_default_for_context);
      (s.items || []).slice(0, 3).forEach((it, qi) => {
        const q = it.question || {};
        Logger.log('    item[' + qi + ']: question_id=' + q.question_id
                 + ' text="' + ((q.question_text || '').slice(0, 60)) + '"'
                 + ' type=' + q.response_type_id
                 + ' options=' + ((q.options || []).length)
                 + ' conditions=' + ((q.conditions || []).length));
      });
    });
    // Shape assertion mínima — el QbSetRenderer falla silenciosamente si
    // estos campos no existen. Hacemos check explícito aquí.
    const firstQ = ((out.sets || [])[0] || {}).items && out.sets[0].items[0]
      ? out.sets[0].items[0].question
      : null;
    if (firstQ) {
      const shapeOk = ('question_text' in firstQ) && ('options' in firstQ)
                   && ('response_type_id' in firstQ) && ('conditions' in firstQ);
      Logger.log((shapeOk ? 'PASS' : 'FAIL') + ' — legacy shape preserved (question_text, options, response_type_id, conditions present)');
    } else {
      Logger.log('SKIP — no questions to verify shape (puede que el set esté vacío en KMS)');
    }
  } catch (e) {
    Logger.log('FAIL — fetchQuestions_ threw: ' + e.message);
  }
}

/**
 * Builds a JSON TextOutput with CORS headers.
 * @param {Object} data
 * @param {number} [statusCode=200] - Unused in GAS (no real status codes), for documentation only
 * @returns {TextOutput}
 */
function jsonResponse_(data, statusCode) {
  const out = ContentService.createTextOutput(JSON.stringify(data))
    .setMimeType(ContentService.MimeType.JSON);
  return setCorsHeaders_(out);
}

/**
 * Sets CORS headers on a TextOutput.
 * GAS does not support arbitrary response headers on Web Apps, but we add what we can.
 * The actual CORS enforcement must be configured in the deployment settings.
 * @param {TextOutput} output
 * @returns {TextOutput}
 */
function setCorsHeaders_(output) {
  // Note: GAS Web Apps do not support custom response headers directly.
  // CORS is handled by the GAS runtime. The CORS_ORIGIN constant documents
  // the intended allowed origin; enforce it in the deployment and via
  // origin-checking logic in doPost if needed.
  return output;
}

/**
 * Diagnostic complementario — vuelca columnas reales de qbConditions_T y
 * qbDimensions_T (necesarias para aplanar conditions intra-set en el fix
 * del Step 5). §0.bis: dato real antes de asumir nombres de columna.
 */
function manual_diagQbConditionTables() {
  Logger.log('=== manual_diagQbConditionTables ===');

  const conds = appsheetRequest_('qbConditions_T', 'Find', [], {}) || [];
  Logger.log('[A] qbConditions_T: ' + conds.length + ' rows');
  if (conds[0]) Logger.log('     KEYS=' + Object.keys(conds[0]).join(',') + ' | ROW0=' + JSON.stringify(conds[0]));

  const dims = appsheetRequest_('qbDimensions_T', 'Find', [], {}) || [];
  Logger.log('[B] qbDimensions_T: ' + dims.length + ' rows');
  if (dims[0]) Logger.log('     KEYS=' + Object.keys(dims[0]).join(',') + ' | ROW0=' + JSON.stringify(dims[0]));

  const items = appsheetRequest_('qbConditionGroupItems_T', 'Find', [], {}) || [];
  Logger.log('[C] qbConditionGroupItems_T: ' + items.length + ' rows');
  if (items[0]) Logger.log('     KEYS=' + Object.keys(items[0]).join(',') + ' | ROW0=' + JSON.stringify(items[0]));

  const intraSetDims = dims.filter(d => (d.dimension_code || '').indexOf('question_response__') === 0);
  Logger.log('[D] Intra-set dimensions (code empieza con question_response__): ' + intraSetDims.length);
  intraSetDims.slice(0, 3).forEach(d => Logger.log('     ' + d.dimension_code));

  Logger.log('=== fin diag ===');
}

/**
 * Diagnostic — vuelca el estado completo de la fila enrEnrollmentGroups para un
 * resume_token concreto, para entender por qué resumeSession_ lanza
 * "Invalid or expired resume token" (= el Find por resume_token devuelve 0 filas,
 * Code.js L987). NO registrado en el dispatcher público (JSDoc Diagnostic):
 * se ejecuta a mano desde el editor GAS. §0.bis: dato real antes de fix.
 *
 * USO: Diego pega el token completo en `var token` abajo y ejecuta desde el
 * dropdown de funciones del editor GAS. Pega el log de [A][B][C] en el reporte.
 */
function manual_diagResumeToken() {
  var token = '9cb5883a-PEGA-EL-RESTO-AQUI';  // Diego completará desde el log
  Logger.log('=== manual_diagResumeToken (token preview: ' + token.slice(0, 8) + ') ===');

  // [A] Find por token exacto (lo que hace resumeSession_)
  try {
    var rows = appsheetRequest_(T.ENROLLMENT_GROUPS, 'Find', [], {
      Filter: '"resume_token" = "' + appsheetEscape_(token) + '"'
    });
    Logger.log('[A] Find por token: ' + (rows ? rows.length : 'null') + ' rows');
    if (rows && rows.length) {
      var grp = rows[0];
      Logger.log('     enrollment_group_id=' + grp.enrollment_group_id);
      Logger.log('     primary_email=' + redact_(grp.primary_email));
      Logger.log('     created_at=' + grp.created_at);
      Logger.log('     submitted_at=' + JSON.stringify(grp.submitted_at));
      Logger.log('     abandoned_at=' + JSON.stringify(grp.abandoned_at));
      Logger.log('     deleted_at=' + JSON.stringify(grp.deleted_at));
      // TTL check
      var TTL = 7 * 24 * 60 * 60 * 1000;
      if (grp.created_at) {
        var age = Date.now() - new Date(grp.created_at).getTime();
        Logger.log('     edad: ' + Math.round(age / 1000 / 3600) + 'h (TTL 168h) — ' + (age > TTL ? 'EXPIRADO' : 'dentro de TTL'));
      }
    }
  } catch (e) {
    Logger.log('[A] ERROR: ' + e.message);
  }

  // [B] Find TODAS las filas con token similar (por si hay typo/encoding)
  try {
    var all = appsheetRequest_(T.ENROLLMENT_GROUPS, 'Find', [], {}) || [];
    Logger.log('[B] enrEnrollmentGroups total rows: ' + all.length);
    var matching = all.filter(function (r) {
      return (r.resume_token || '').toLowerCase().indexOf(token.slice(0, 8).toLowerCase()) >= 0;
    });
    Logger.log('[B] filas con token-preview matching: ' + matching.length);
    matching.forEach(function (r) {
      Logger.log('     resume_token=' + r.resume_token + ' group_id=' + r.enrollment_group_id);
    });
  } catch (e) {
    Logger.log('[B] ERROR: ' + e.message);
  }

  // [C] Buscar por email de Diego (ground.contact@gmail.com) — la sesión de prueba debería ser suya
  try {
    var byEmail = appsheetRequest_(T.ENROLLMENT_GROUPS, 'Find', [], {
      Filter: '"primary_email" = "ground.contact@gmail.com"'
    }) || [];
    Logger.log('[C] sessions de Diego: ' + byEmail.length);
    byEmail.forEach(function (g) {
      Logger.log('     group_id=' + g.enrollment_group_id + ' token=' + (g.resume_token || '').slice(0, 8) + '...' +
        ' created=' + g.created_at + ' submitted=' + (g.submitted_at ? 'Y' : 'N') +
        ' abandoned=' + (g.abandoned_at ? 'Y' : 'N'));
    });
  } catch (e) {
    Logger.log('[C] ERROR: ' + e.message);
  }

  Logger.log('=== fin diag ===');
}

/**
 * Smoke test wrapper para los 4 proxies WS4 (CLI 40).
 *
 * Verifica que kmsProxy_ está bien configurado (Script Properties presentes)
 * y que cada proxy lanza el código de error esperado cuando recibe un payload
 * inválido (resume_token vacío, signing_token mal formado, etc.). NO ejerce
 * el flujo end-to-end — para eso ver `manual_testWs4ProxyFromWizard`.
 *
 * Salida esperada: 4 secciones (saveBilling / submitGdpr / confirmReview /
 * initiateSigning), cada una con PASS si el handler rechaza el payload inválido
 * con el código esperado (`Missing resume_token` o `Invalid UUID`).
 */
function manual_testWs4ProxyDryRun() {
  Logger.log('=== manual_testWs4ProxyDryRun — 4 proxies WS4 (CLI 40) ===');

  const props        = PropertiesService.getScriptProperties();
  const kmsUrl       = props.getProperty('KMS_DEPLOYMENT_URL');
  const serviceToken = props.getProperty('QB_SERVICE_TOKEN');
  Logger.log('[CFG] KMS_DEPLOYMENT_URL set=' + !!kmsUrl + ' QB_SERVICE_TOKEN set=' + !!serviceToken);
  if (!kmsUrl || !serviceToken) {
    Logger.log('  ⚠ Script Properties faltantes — kmsProxy_ devolverá KMS_NOT_CONFIGURED.');
  }

  const cases = [
    { name: 'saveBillingInfo_',        fn: saveBillingInfo_,        payload: {} },
    { name: 'submitGdprConsents_',     fn: submitGdprConsents_,     payload: {} },
    { name: 'confirmReview_',          fn: confirmReview_,          payload: {} },
    { name: 'initiateSigningSession_', fn: initiateSigningSession_, payload: {} },
  ];

  cases.forEach(function(c) {
    Logger.log('--- ' + c.name + ' empty payload ---');
    try {
      c.fn(c.payload);
      Logger.log('  ✗ FAIL — should have thrown for empty payload');
    } catch (e) {
      Logger.log('  ✓ PASS — threw: ' + e.message + (e.code ? ' (code=' + e.code + ')' : ''));
    }
  });

  Logger.log('=== fin manual_testWs4ProxyDryRun ===');
}

/**
 * Test de `requireSigningToken_` (CLI 45) — bearer gate canónico del flujo /sign.
 *
 * Casos (a-b automáticos; c-d requieren SIGNING_TOKEN_REAL):
 *   a) UUID malformado → throw BAD_REQUEST.
 *   b) UUID válido pero NO en sysSigningSessionSigners → throw UNAUTHORIZED.
 *   c) token expirado/revocado → throw UNAUTHORIZED (sesión COMPLETED/CANCELLED).
 *   d) token válido → returns { signing_token, signer_id, session_id,
 *      enrollment_group_id, guardian_person_id }.
 *
 * KAL-4 IDOR: el enrollment_group_id autorizado se deriva del token (server-side
 * via resolveSigningToken_), nunca del payload. Defensa equivalente al
 * resume_token — ambos UUID no enumerables validados server-side.
 */
function manual_testSigningTokenAuth() {
  Logger.log('=== manual_testSigningTokenAuth (CLI 45) ===');

  // a) UUID malformado → BAD_REQUEST
  try {
    requireSigningToken_({ signing_token: 'not-a-uuid' });
    Logger.log('  a) ✗ FAIL — should have thrown for malformed UUID');
  } catch (e) {
    var okA = (e.code === 'BAD_REQUEST') || /uuid/i.test(e.message);
    Logger.log('  a) ' + (okA ? '✓ PASS' : '✗ FAIL') + ' — threw: ' + e.message + (e.code ? ' (code=' + e.code + ')' : ''));
  }

  // b) UUID válido pero inexistente → UNAUTHORIZED
  try {
    requireSigningToken_({ signing_token: '00000000-0000-4000-8000-000000000000' });
    Logger.log('  b) ✗ FAIL — should have thrown for unknown token');
  } catch (e) {
    var okB = (e.code === 'UNAUTHORIZED');
    Logger.log('  b) ' + (okB ? '✓ PASS' : '✗ FAIL') + ' — threw: ' + e.message + (e.code ? ' (code=' + e.code + ')' : ''));
  }

  // c) + d) token real (rellenar)
  var SIGNING_TOKEN_REAL = 'REPLACE-WITH-REAL-SIGNING-TOKEN';
  if (SIGNING_TOKEN_REAL.indexOf('REPLACE-') === 0) {
    Logger.log('  c/d) (skip) — rellenar SIGNING_TOKEN_REAL para ejercer token válido / revocado.');
    Logger.log('=== fin manual_testSigningTokenAuth ===');
    return;
  }
  try {
    var ctx = requireSigningToken_({ signing_token: SIGNING_TOKEN_REAL });
    Logger.log('  d) ✓ resolved — signer_id=' + ctx.signer_id + ' session_id=' + ctx.session_id +
               ' group=' + ctx.enrollment_group_id);
  } catch (e) {
    Logger.log('  c/d) threw (token revocado/expirado/ inválido): ' + e.message + (e.code ? ' (code=' + e.code + ')' : ''));
  }
  Logger.log('=== fin manual_testSigningTokenAuth ===');
}

/**
 * Documentación operativa (no ejecutable directamente — Diego debe rellenar
 * los placeholders con datos reales). Simula la invocación de los 4 proxies
 * WS4 desde el wizard con un resume_token + signing_token reales.
 *
 * PRE-REQUISITOS:
 *   1. Una sesión DRAFT en enrEnrollmentGroups con resume_token conocido.
 *   2. Una signing_session ACTIVE asociada al grupo con un signer + signing_token.
 *   3. Script Properties KMS_DEPLOYMENT_URL + QB_SERVICE_TOKEN configuradas.
 *
 * USO:
 *   1. Rellenar RESUME_TOKEN_REAL y SIGNING_TOKEN_REAL abajo con valores
 *      del entorno de prueba.
 *   2. Ejecutar desde el editor GAS.
 *   3. Leer los logs paso a paso — cada proxy debe devolver `data` del KMS
 *      o lanzar un error con código KMS legible.
 */
function manual_testWs4ProxyFromWizard() {
  const RESUME_TOKEN_REAL  = 'REPLACE-WITH-REAL-RESUME-TOKEN';
  const SIGNING_TOKEN_REAL = 'REPLACE-WITH-REAL-SIGNING-TOKEN';

  if (RESUME_TOKEN_REAL.indexOf('REPLACE-') === 0) {
    Logger.log('manual_testWs4ProxyFromWizard: rellenar RESUME_TOKEN_REAL + SIGNING_TOKEN_REAL antes de ejecutar.');
    return;
  }

  Logger.log('=== manual_testWs4ProxyFromWizard ===');
  Logger.log('  resume_token=' + RESUME_TOKEN_REAL.slice(0, 8) + '...');
  Logger.log('  signing_token=' + SIGNING_TOKEN_REAL.slice(0, 8) + '...');

  const tries = [
    {
      name: 'saveBillingInfo (Step 8)',
      fn: function() {
        return saveBillingInfo_({
          resume_token:  RESUME_TOKEN_REAL,
          signing_token: SIGNING_TOKEN_REAL,
          payer_type:    'GUARDIAN',
          fiscal_name:   'TEST — manual_testWs4ProxyFromWizard',
          fiscal_tax_id: '12345678Z',
          billing_email: 'test@example.org',
        });
      },
    },
    {
      name: 'submitGdprConsents (Step 9) — modo conservador GATE-B',
      fn: function() {
        return submitGdprConsents_({
          resume_token:  RESUME_TOKEN_REAL,
          signing_token: SIGNING_TOKEN_REAL,
          consents: [{
            consent_type_code:  'GDPR_SCHOOL',
            consented:          true,
            consent_text_shown: 'TEST consent text',
          }],
        });
      },
    },
    {
      name: 'confirmReview (Step 10)',
      fn: function() {
        return confirmReview_({
          resume_token:  RESUME_TOKEN_REAL,
          signing_token: SIGNING_TOKEN_REAL,
        });
      },
    },
    {
      name: 'initiateSigningSession (Step 11)',
      fn: function() {
        return initiateSigningSession_({
          resume_token:  RESUME_TOKEN_REAL,
          signing_token: SIGNING_TOKEN_REAL,
        });
      },
    },
  ];

  tries.forEach(function(t) {
    Logger.log('--- ' + t.name + ' ---');
    try {
      const result = t.fn();
      Logger.log('  ✓ OK — data=' + JSON.stringify(result).slice(0, 300));
    } catch (e) {
      Logger.log('  ✗ THREW: ' + e.message + (e.code ? ' (code=' + e.code + ')' : ''));
    }
  });

  Logger.log('=== fin manual_testWs4ProxyFromWizard ===');
}

// ─── CLI 81 — Wizard signing_token URL clean + disclosure + TTL ──────────────
// Tests para S4 (frontend, verificable por grep) + S5 + S8 + S9. Ejecutar desde
// el GAS editor tras `clasp push --force`. Convención: sin trailing `_` para que
// aparezcan en el selector de funciones (CLAUDE.md §funciones manual_*).

/**
 * CLI 81 (S5 / KAL-NEW-1): verifica que resolveSigningToken_ ya no devuelve
 * signing_url en su shape de respuesta. El signing_url solo debe materializarse
 * desde initiateSigningSession_ (session.signerUrls).
 */
function manual_testResolveSigningTokenNoSigningUrl() {
  const TOKEN = 'REPLACE-WITH-REAL-SIGNING-TOKEN';
  if (TOKEN.indexOf('REPLACE-') === 0) {
    Logger.log('manual_testResolveSigningTokenNoSigningUrl: rellenar TOKEN con un signing_token real antes de ejecutar.');
    return;
  }
  Logger.log('=== manual_testResolveSigningTokenNoSigningUrl ===');
  const res = resolveSigningToken_({ signing_token: TOKEN });
  Logger.log('  resolved keys: ' + Object.keys(res).join(','));
  if ('signing_url' in res) {
    Logger.log('  ✗ FAIL: signing_url leaked from resolveSigningToken_');
  } else {
    Logger.log('  ✓ PASS: signing_url not present in resolveSigningToken_ response');
  }
}

/**
 * CLI 81 (S8 / KAL-NEW-7): verifica que requireResumeToken_ rechaza un
 * resume_token cuyo grupo está expirado (created_at > 7 días, sin submitted_at)
 * o abandonado. Rellena con un resume_token cuyo grupo cumpla esa condición —
 * o usa manual_diagResumeToken para inspeccionar created_at/abandoned_at antes.
 */
function manual_testResumeTokenExpired() {
  const TOKEN = 'REPLACE-WITH-EXPIRED-OR-ABANDONED-RESUME-TOKEN';
  if (TOKEN.indexOf('REPLACE-') === 0) {
    Logger.log('manual_testResumeTokenExpired: rellenar TOKEN con un resume_token expirado/abandonado antes de ejecutar.');
    return;
  }
  Logger.log('=== manual_testResumeTokenExpired ===');
  try {
    const groupId = requireResumeToken_({ resume_token: TOKEN });
    Logger.log('  ✗ FAIL: expired/abandoned token accepted, group=' + groupId);
  } catch (e) {
    Logger.log('  ✓ PASS: token rejected, error=' + e.message);
  }
}

/**
 * CLI 81 (S9 / SUBMIT-REPLAY): verifica que submitEnrollmentSession_ rechaza un
 * re-submit de un grupo ya enviado (submitted_at IS NOT NULL) con NOT_EDITABLE,
 * vía assertGroupEditable_. Rellena con un resume_token de un grupo ya submitted.
 */
function manual_testSubmitReplayRejected() {
  const TOKEN = 'REPLACE-WITH-RESUME-TOKEN-OF-SUBMITTED-GROUP';
  if (TOKEN.indexOf('REPLACE-') === 0) {
    Logger.log('manual_testSubmitReplayRejected: rellenar TOKEN con un resume_token de un grupo ya submitted antes de ejecutar.');
    return;
  }
  Logger.log('=== manual_testSubmitReplayRejected ===');
  try {
    const res = submitEnrollmentSession_({ resume_token: TOKEN });
    Logger.log('  ✗ FAIL: re-submit accepted, res=' + JSON.stringify(res).slice(0, 200));
  } catch (e) {
    if (e.code === 'NOT_EDITABLE') {
      Logger.log('  ✓ PASS: re-submit rejected with NOT_EDITABLE');
    } else {
      Logger.log('  ? UNEXPECTED error (not NOT_EDITABLE): ' + e.message + (e.code ? ' (code=' + e.code + ')' : ''));
    }
  }
}

// ─── CLI 82 — Wizard Drive privado + proxy bytes + MIME guard ────────────────
// Tests para S6 / KAL-NEW-5 (Anexo A Opción A). Ejecutar desde el GAS editor
// tras `clasp push --force`. Convención: sin trailing `_` para que aparezcan en
// el selector de funciones (CLAUDE.md §funciones manual_*).

/**
 * CLI 82 (KAL-NEW-5): guard IDOR de lectura de getDocument_.
 *
 * Caso 1 (automático con tokens reales): resume_token válido + file_id de OTRO
 *   grupo → UNAUTHORIZED (origin_reference != groupId del token).
 * Caso 2 (automático): file_id malformado → BAD_REQUEST (assertValidUuid_).
 * Caso 3 (automático): ni resume_token ni signing_token → BAD_REQUEST.
 *
 * Rellena MY_TOKEN con un resume_token real y OTHER_FILE_ID con un file_id
 * (UUID v4) que pertenezca a OTRO grupo familiar para ejercer el guard real.
 */
function manual_testGetDocumentIdorGuard() {
  Logger.log('=== manual_testGetDocumentIdorGuard (CLI 82 / KAL-NEW-5) ===');

  // Caso 3 — sin token → BAD_REQUEST
  try {
    getDocument_({ file_id: '00000000-0000-4000-8000-000000000000' });
    Logger.log('  ✗ FAIL Caso 3: aceptó llamada sin token');
  } catch (e) {
    Logger.log((e.code === 'BAD_REQUEST' ? '  ✓ PASS' : '  ? UNEXPECTED') +
      ' Caso 3 (sin token): ' + e.message + (e.code ? ' (code=' + e.code + ')' : ''));
  }

  // Caso 2 — file_id malformado → BAD_REQUEST (vía assertValidUuid_)
  const MY_TOKEN = 'REPLACE-WITH-REAL-RESUME-TOKEN';
  if (MY_TOKEN.indexOf('REPLACE-') === 0) {
    Logger.log('  (Casos 1-2 requieren MY_TOKEN real — rellena MY_TOKEN + OTHER_FILE_ID y re-ejecuta.)');
    Logger.log('=== fin manual_testGetDocumentIdorGuard ===');
    return;
  }
  try {
    getDocument_({ resume_token: MY_TOKEN, file_id: 'not-a-uuid' });
    Logger.log('  ✗ FAIL Caso 2: aceptó file_id malformado');
  } catch (e) {
    Logger.log((/uuid/i.test(e.message) ? '  ✓ PASS' : '  ? UNEXPECTED') +
      ' Caso 2 (file_id malformado): ' + e.message);
  }

  // Caso 1 — file_id de OTRO grupo con MY_TOKEN → UNAUTHORIZED
  const OTHER_FILE_ID = 'REPLACE-WITH-FILE-ID-FROM-ANOTHER-GROUP';
  if (OTHER_FILE_ID.indexOf('REPLACE-') === 0) {
    Logger.log('  (Caso 1 requiere OTHER_FILE_ID real de otro grupo — rellénalo y re-ejecuta.)');
    Logger.log('=== fin manual_testGetDocumentIdorGuard ===');
    return;
  }
  try {
    getDocument_({ resume_token: MY_TOKEN, file_id: OTHER_FILE_ID });
    Logger.log('  ✗ FAIL Caso 1: cross-group file ACEPTADO (IDOR de lectura abierto!)');
  } catch (e) {
    Logger.log((e.code === 'UNAUTHORIZED' ? '  ✓ PASS' : '  ? UNEXPECTED') +
      ' Caso 1 (cross-group): ' + e.message + (e.code ? ' (code=' + e.code + ')' : ''));
  }
  Logger.log('=== fin manual_testGetDocumentIdorGuard ===');
}

/**
 * CLI 82 (KAL-NEW-5 segunda parte): allowlist MIME + magic-bytes + tope server-
 * side en uploadDocument_.
 *
 * Requiere un RESUME_TOKEN real de un grupo EDITABLE (DRAFT) porque la
 * validación corre tras requireResumeToken_ + assertGroupEditable_. La
 * validación lanza ANTES de cualquier escritura a Drive — los casos negativos
 * no dejan side-effects.
 *
 * Caso A: mimeType 'text/html'        → UNSUPPORTED_MIME.
 * Caso B: PDF con magic-bytes inválidos → MIME_MAGIC_MISMATCH.
 * Caso C: PDF (magic OK) > 10 MB        → FILE_TOO_LARGE.
 */
function manual_testUploadDocumentMimeGuard() {
  Logger.log('=== manual_testUploadDocumentMimeGuard (CLI 82 / KAL-NEW-5) ===');
  const RESUME_TOKEN = 'REPLACE-WITH-EDITABLE-DRAFT-RESUME-TOKEN';
  if (RESUME_TOKEN.indexOf('REPLACE-') === 0) {
    Logger.log('manual_testUploadDocumentMimeGuard: rellenar RESUME_TOKEN con un resume_token de un grupo DRAFT editable.');
    return;
  }
  const b64 = function(s) { return Utilities.base64Encode(Utilities.newBlob(s).getBytes()); };

  // Caso A — UNSUPPORTED_MIME
  try {
    uploadDocument_({ resume_token: RESUME_TOKEN, base64: b64('<html></html>'),
      mimeType: 'text/html', filename: 'evil.html', document_type: 'passport' });
    Logger.log('  ✗ FAIL Caso A: text/html ACEPTADO');
  } catch (e) {
    Logger.log((e.code === 'UNSUPPORTED_MIME' ? '  ✓ PASS' : '  ? UNEXPECTED') +
      ' Caso A (text/html): ' + e.message + (e.code ? ' (code=' + e.code + ')' : ''));
  }

  // Caso B — MIME_MAGIC_MISMATCH (declara PDF pero los bytes no empiezan por %PDF)
  try {
    uploadDocument_({ resume_token: RESUME_TOKEN, base64: b64('NOT-A-REAL-PDF-FILE'),
      mimeType: 'application/pdf', filename: 'fake.pdf', document_type: 'passport' });
    Logger.log('  ✗ FAIL Caso B: PDF con magic inválido ACEPTADO');
  } catch (e) {
    Logger.log((e.code === 'MIME_MAGIC_MISMATCH' ? '  ✓ PASS' : '  ? UNEXPECTED') +
      ' Caso B (magic mismatch): ' + e.message + (e.code ? ' (code=' + e.code + ')' : ''));
  }

  // Caso C — FILE_TOO_LARGE (magic OK '%PDF' + relleno > 10 MB)
  try {
    const big = '%PDF-1.4\n' + new Array(11 * 1024 * 1024).join('A'); // ~11 MB
    uploadDocument_({ resume_token: RESUME_TOKEN, base64: b64(big),
      mimeType: 'application/pdf', filename: 'huge.pdf', document_type: 'passport' });
    Logger.log('  ✗ FAIL Caso C: PDF > 10 MB ACEPTADO');
  } catch (e) {
    Logger.log((e.code === 'FILE_TOO_LARGE' ? '  ✓ PASS' : '  ? UNEXPECTED') +
      ' Caso C (>10MB): ' + e.message + (e.code ? ' (code=' + e.code + ')' : ''));
  }
  Logger.log('=== fin manual_testUploadDocumentMimeGuard ===');
}

/**
 * KAL-NEW-3 test — saveStep_ ya NO acepta step='review' (sacado del dispatcher).
 * Un step='review' debe caer al `default:` del switch y lanzar 'Unknown step: review'.
 *
 * Pre-requisito: rellenar RESUME_TOKEN con el resume_token de un grupo en DRAFT
 * (submitted_at IS NULL), porque saveStep_ valida requireResumeToken_ +
 * assertGroupEditable_ ANTES de llegar al switch. Con un token inválido el throw
 * vendría de requireResumeToken_ (BAD_REQUEST/UNAUTHORIZED), no del default que
 * queremos verificar. Ejecutar desde el editor GAS y leer PASS/FAIL en Logs.
 */
function manual_testReviewStepRejected() {
  const RESUME_TOKEN = 'RELLENAR_CON_RESUME_TOKEN_DRAFT_REAL';
  Logger.log('=== manual_testReviewStepRejected ===');
  if (RESUME_TOKEN === 'RELLENAR_CON_RESUME_TOKEN_DRAFT_REAL') {
    Logger.log('  ? SKIP: rellena RESUME_TOKEN con un resume_token de un grupo DRAFT real.');
    return;
  }
  try {
    saveStep_({ resume_token: RESUME_TOKEN, step: 'review', payload: { status_code: 'RQ' } });
    Logger.log('  ✗ FAIL: saveStep_(step=review) NO lanzó — el case sigue vivo.');
  } catch (e) {
    const ok = /Unknown step:\s*review/.test(e.message || '');
    Logger.log((ok ? '  ✓ PASS' : '  ? UNEXPECTED') + ': ' + e.message +
      (e.code ? ' (code=' + e.code + ')' : ''));
  }
  Logger.log('=== fin manual_testReviewStepRejected ===');
}

/**
 * KAL-NEW-2.b — verifica el lockout de verifyEmail_ (5 intentos fallidos → 6º
 * TOO_MANY_ATTEMPTS). Self-contained: usa un group_id sintético en ScriptCache,
 * sin tocar BD. Limpia el cache al final. Ejecutar desde el editor GAS.
 */
function manual_testVerifyEmailLockout() {
  const cache = CacheService.getScriptCache();
  const gid = 'TEST-LOCKOUT-' + Utilities.getUuid().slice(0, 8);
  cache.put('verify_' + gid, '123456', 600);
  cache.remove('verify_attempts_' + gid);
  let pass = true;
  for (let i = 1; i <= 5; i++) {
    try {
      verifyEmail_({ enrollment_group_id: gid, code: '000000' });
      Logger.log('FAIL: intento %s debió lanzar', i); pass = false;
    } catch (e) {
      if (e.code === 'TOO_MANY_ATTEMPTS') { Logger.log('FAIL: bloqueó demasiado pronto (intento %s)', i); pass = false; }
      else Logger.log('intento %s → "%s" (esperado Invalid)', i, e.message);
    }
  }
  try {
    verifyEmail_({ enrollment_group_id: gid, code: '000000' });
    Logger.log('FAIL: 6º intento debió bloquear'); pass = false;
  } catch (e) {
    if (e.code === 'TOO_MANY_ATTEMPTS') Logger.log('PASS: 6º intento → TOO_MANY_ATTEMPTS');
    else { Logger.log('FAIL: 6º intento lanzó "%s" (esperado TOO_MANY_ATTEMPTS)', e.code || e.message); pass = false; }
  }
  cache.remove('verify_' + gid); cache.remove('verify_attempts_' + gid);
  Logger.log('=== manual_testVerifyEmailLockout: %s ===', pass ? 'PASS' : 'FAIL');
}

/**
 * KAL-NEW-4 — verifica reCAPTCHA fail-CLOSED. Temporalmente BORRA RECAPTCHA_SECRET
 * (backup + restore en finally), invoca initEnrollmentSession_ WEB_PUBLIC → debe
 * throw RECAPTCHA_NOT_CONFIGURED. ⚠️ Ejecutar SOLO desde el editor GAS (manipula una
 * Script Property de producción durante <1s; el finally garantiza el restore).
 */
function manual_testRecaptchaFailClosed() {
  const props = PropertiesService.getScriptProperties();
  const backup = props.getProperty('RECAPTCHA_SECRET');
  let pass = true;
  try {
    props.deleteProperty('RECAPTCHA_SECRET');
    try {
      initEnrollmentSession_({ source_code: 'WEB_PUBLIC', primary_email: 'test@kaleide.org' });
      Logger.log('FAIL: debió lanzar RECAPTCHA_NOT_CONFIGURED'); pass = false;
    } catch (e) {
      if (e.code === 'RECAPTCHA_NOT_CONFIGURED') Logger.log('PASS: WEB_PUBLIC sin secret → RECAPTCHA_NOT_CONFIGURED (fail-closed)');
      else { Logger.log('FAIL: lanzó "%s" (code=%s; esperado RECAPTCHA_NOT_CONFIGURED)', e.message, e.code); pass = false; }
    }
  } finally {
    if (backup == null) props.deleteProperty('RECAPTCHA_SECRET'); else props.setProperty('RECAPTCHA_SECRET', backup);
    Logger.log('RECAPTCHA_SECRET restaurado (%s)', backup == null ? 'estaba vacío' : 'OK');
  }
  Logger.log('=== manual_testRecaptchaFailClosed: %s ===', pass ? 'PASS' : 'FAIL');
}

/**
 * KAL-NEW-4 — verifica el gate de KMS_INTERNAL. Caso1: sin secret configurado →
 * Unauthorized. Caso2: secret configurado pero payload sin coincidir → Unauthorized.
 * Caso3: secret correcto → PASA el gate (falla después en email inválido, SIN escribir
 * BD). Backup+restore de KMS_INTERNAL_SHARED_SECRET en finally. Ejecutar desde editor GAS.
 */
function manual_testKmsInternalGate() {
  const props = PropertiesService.getScriptProperties();
  const KEY = 'KMS_INTERNAL_SHARED_SECRET';
  const backup = props.getProperty(KEY);
  let pass = true;
  try {
    // Caso 1 — sin secret configurado
    props.deleteProperty(KEY);
    try {
      initEnrollmentSession_({ source_code: 'KMS_INTERNAL', primary_email: 'x@kaleide.org' });
      Logger.log('FAIL caso1: debió lanzar Unauthorized'); pass = false;
    } catch (e) {
      if (/Unauthorized source_code: KMS_INTERNAL/.test(e.message)) Logger.log('PASS caso1: KMS_INTERNAL sin secret → Unauthorized');
      else { Logger.log('FAIL caso1: lanzó "%s"', e.message); pass = false; }
    }
    // Caso 2 — secret configurado, payload sin coincidir
    const testSecret = 'test-secret-' + Utilities.getUuid();
    props.setProperty(KEY, testSecret);
    try {
      initEnrollmentSession_({ source_code: 'KMS_INTERNAL', primary_email: 'x@kaleide.org' });
      Logger.log('FAIL caso2: debió lanzar Unauthorized'); pass = false;
    } catch (e) {
      if (/Unauthorized source_code: KMS_INTERNAL/.test(e.message)) Logger.log('PASS caso2: secret no coincide → Unauthorized');
      else { Logger.log('FAIL caso2: lanzó "%s"', e.message); pass = false; }
    }
    // Caso 3 — secret correcto: pasa el gate, falla después en email inválido (sin BD)
    try {
      initEnrollmentSession_({ source_code: 'KMS_INTERNAL', kms_internal_secret: testSecret, primary_email: 'not-an-email' });
      Logger.log('NOTE caso3: no lanzó — gate pasó (revisar si creó sesión)');
    } catch (e) {
      if (/Unauthorized source_code/.test(e.message)) { Logger.log('FAIL caso3: gate bloqueó secret válido: %s', e.message); pass = false; }
      else Logger.log('PASS caso3: gate pasó secret válido (falló después en "%s" — sin escribir BD)', e.message);
    }
  } finally {
    if (backup == null) props.deleteProperty(KEY); else props.setProperty(KEY, backup);
  }
  Logger.log('=== manual_testKmsInternalGate: %s ===', pass ? 'PASS' : 'FAIL');
}

/**
 * P226 / KAL-NEW-4 — verifica que el bypass de 'FAMILIES_APP' está cerrado:
 * source_code:'FAMILIES_APP' ya NO está en VALID_SOURCES → initEnrollmentSession_
 * lanza ANTES de cualquier reCAPTCHA/secret/escritura BD con err.code='BAD_REQUEST'
 * (doPost lo mapea a HTTP 200 { ok:false, error:{ code:'BAD_REQUEST', ... } }, no 403).
 * Función pura/segura — no toca BD, no requiere secretos. Lee PASS/FAIL en Logs.
 */
function manual_testFamiliesAppBypassClosed() {
  let pass = true;
  try {
    initEnrollmentSession_({ source_code: 'FAMILIES_APP', primary_email: 'attacker@x.com' });
    Logger.log('FAIL: FAMILIES_APP no fue rechazado — el bypass sigue abierto'); pass = false;
  } catch (e) {
    if (e.code === 'BAD_REQUEST' && /Invalid source_code/.test(e.message)) {
      Logger.log('PASS: FAMILIES_APP → BAD_REQUEST estructurado (bypass cerrado)');
    } else {
      Logger.log('FAIL: lanzó "%s" (code=%s; esperado BAD_REQUEST/Invalid source_code)', e.message, e.code); pass = false;
    }
  }
  // Sanity: un source desconocido cualquiera también cae como BAD_REQUEST.
  try {
    initEnrollmentSession_({ source_code: 'NOPE', primary_email: 'x@x.com' });
    Logger.log('FAIL: source desconocido no rechazado'); pass = false;
  } catch (e) {
    if (e.code === 'BAD_REQUEST') Logger.log('PASS: source desconocido → BAD_REQUEST');
    else { Logger.log('FAIL: source desconocido lanzó code=%s', e.code); pass = false; }
  }
  Logger.log('=== manual_testFamiliesAppBypassClosed: %s ===', pass ? 'PASS' : 'FAIL');
}

/**
 * KAL-NEW-10 test — sanitizeErrorForClient_ no filtra PII/internals al cliente.
 * Función pura, ejecutable desde el editor GAS sin tokens. Lee PASS/FAIL en Logs.
 */
function manual_testSanitizeErrorPII() {
  Logger.log('=== manual_testSanitizeErrorPII ===');
  var cases = [
    { name: 'email',        err: new Error('Add failed for user@kaleide.org row'),                 expect: function(o){ return o.indexOf('@') === -1 && o.indexOf('[EMAIL]') !== -1; } },
    { name: 'uuid',         err: new Error('group a8bf5292-eb12-43f8-9a82-1d2a39c11f4e not found'), expect: function(o){ return o.indexOf('[UUID]') !== -1; } },
    { name: 'column leak',  err: new Error("AppSheet: Column 'medical_notes' rejected value 'asthma'"), expect: function(o){ return /Validation error/.test(o) && o.indexOf('medical_notes') === -1 && o.indexOf('asthma') === -1; } },
    { name: 'file id',      err: new Error('Drive 1A2b3C4d5E6f7G8h9I0jK1l2M3n4O5p6Q7r8S9t0 denied'), expect: function(o){ return o.indexOf('[ID]') !== -1; } },
    { name: 'truncate',     err: new Error('palabra '.repeat(40)),                                  expect: function(o){ return o.length <= 201 && o.slice(-1) === '…'; } },
    { name: 'clean passes', err: new Error('Missing required fields'),                              expect: function(o){ return o === 'Missing required fields'; } },
    { name: 'null safe',    err: null,                                                              expect: function(o){ return o === 'Internal error'; } },
  ];
  var allPass = true;
  cases.forEach(function(c) {
    var out = sanitizeErrorForClient_(c.err);
    var ok = false;
    try { ok = c.expect(out); } catch (e) { ok = false; }
    if (!ok) allPass = false;
    Logger.log('  ' + (ok ? '✓ PASS' : '✗ FAIL') + ' [' + c.name + '] → ' + out);
  });
  Logger.log('=== manual_testSanitizeErrorPII: ' + (allPass ? 'PASS' : 'FAIL') + ' ===');
}

/**
 * Verificación P211 — antes/después del fix de formato del signing_token.
 * Toma el token real (dashless 32-hex emitido por el KMS) y muestra:
 *   - before: assertValidUuid_ (estricto KAL-5) lo RECHAZA.
 *   - after:  assertValidSigningToken_ lo ACEPTA + resolveSigningToken_ → {valid:true}.
 * Pasa el token por parámetro o usa el de prueba conocido.
 */
function manual_verifyP211Token(token) {
  var REAL = token || '019c2aa3dc5243ef8633e00dd47644b3';
  var out = { token: REAL };

  // BEFORE: validación estricta anterior (assertValidUuid_) → rechaza dashless
  try { assertValidUuid_(REAL, 'signing_token'); out.before_strictUuid = 'ACCEPTED (inesperado)'; }
  catch (e) { out.before_strictUuid = 'REJECTED → ' + e.message; }

  // AFTER: nueva validación de formato
  try { assertValidSigningToken_(REAL, 'signing_token'); out.after_looseFormat = 'ACCEPTED'; }
  catch (e) { out.after_looseFormat = 'REJECTED → ' + e.message; }

  // AFTER: resolución real contra sysSigningSessionSigners
  var res = resolveSigningToken_({ signing_token: REAL });
  out.resolve = res;

  // AFTER: el gate completo de los 4 proxies
  try {
    var sctx = requireSigningToken_({ signing_token: REAL });
    out.gate = { ok: true, enrollment_group_id: sctx.enrollment_group_id, signer_id: sctx.signer_id, session_id: sctx.session_id };
  } catch (e) {
    out.gate = { ok: false, error: e.message, code: e.code || null };
  }

  Logger.log('[manual_verifyP211Token] ' + JSON.stringify(out, null, 2));
  return out;
}

/**
 * DL-E38 / P215 — verifica la recuperación per-guardian (GAP-1 a1).
 *
 * Rellenar abajo con datos reales de una sesión de prueba:
 *   - RESUME_TOKEN_REAL: resume_token de un grupo con ≥1 guardian guardado (Step 2+).
 *   - GUARDIAN_EMAIL_REAL: email de uno de los guardians del grupo (debe existir en enrEmails).
 *
 * Verifica:
 *   (a) resolveGuardianForRecovery_ matchea el email → guardian_person_id.
 *   (b) resumeSession_({resume_token, recovered_email}) devuelve `admission`
 *       con state_code + state_label resueltos desde sysStates_T.
 *   (c) si el expediente está en AD, `admission.signing_available` + signing_context
 *       (con signing_token) resueltos para ESE guardian.
 *   (d) un email que NO es de guardian del grupo → guardian null (fallback).
 *
 * Lee PASS/FAIL en los Logs.
 */
function manual_testRecoveryPerGuardian() {
  Logger.log('=== manual_testRecoveryPerGuardian (DL-E38 / P215) ===');
  var RESUME_TOKEN_REAL   = 'REPLACE-WITH-REAL-RESUME-TOKEN';
  var GUARDIAN_EMAIL_REAL = 'REPLACE-WITH-REAL-GUARDIAN-EMAIL';

  if (RESUME_TOKEN_REAL.indexOf('REPLACE-') === 0 || GUARDIAN_EMAIL_REAL.indexOf('REPLACE-') === 0) {
    Logger.log('  (skip) — rellenar RESUME_TOKEN_REAL + GUARDIAN_EMAIL_REAL con datos reales.');
    Logger.log('=== fin manual_testRecoveryPerGuardian ===');
    return { skipped: true };
  }

  var out = {};
  // Resolver el grupo desde el token (como hace resumeSession_).
  var groups = appsheetRequest_(T.ENROLLMENT_GROUPS, 'Find', [], {
    Filter: '"resume_token" = "' + appsheetEscape_(RESUME_TOKEN_REAL) + '"'
  }) || [];
  if (!groups.length) {
    Logger.log('  ✗ FAIL — resume_token no resuelve a ningún grupo.');
    return { error: 'TOKEN_NOT_FOUND' };
  }
  var groupId = groups[0].enrollment_group_id;

  // (a) matching email → guardian
  var gId = resolveGuardianForRecovery_(groupId, GUARDIAN_EMAIL_REAL);
  out.a_guardian_matched = gId;
  Logger.log('  a) guardian_person_id=' + gId + ' → ' + (gId ? '✓ PASS' : '✗ FAIL (¿es guardian + email en enrEmails?)'));

  // (b)+(c) resumeSession_ con recovered_email
  var res = resumeSession_({ resume_token: RESUME_TOKEN_REAL, recovered_email: GUARDIAN_EMAIL_REAL });
  out.b_admission = res.admission || null;
  out.b_recovered_guardian = res.recovered_guardian_person_id || null;
  var bOk = !!(res.admission && (res.admission.state_code || res.enrollments.length === 0));
  Logger.log('  b) admission=' + JSON.stringify(res.admission) + ' recovered_guardian=' + out.b_recovered_guardian +
             ' → ' + (bOk ? '✓ PASS' : '✗ FAIL'));
  if (res.admission && res.admission.state_code === 'AD') {
    var cOk = !!(res.admission.signing_available && res.admission.signing_context && res.admission.signing_context.signing_token);
    Logger.log('  c) AD → signing_available=' + res.admission.signing_available +
               ' signing_context=' + JSON.stringify(res.admission.signing_context ? { signer_id: res.admission.signing_context.signer_id, has_token: !!res.admission.signing_context.signing_token } : null) +
               ' → ' + (cOk ? '✓ PASS' : '✗ FAIL (¿signer para este guardian en sesión no-terminal?)'));
  } else {
    Logger.log('  c) (n/a) — expediente no está en AD (state_code=' + (res.admission && res.admission.state_code) + '); signing_available debe ser false: ' + (res.admission && res.admission.signing_available));
  }

  // (d) email no-guardian → null
  var dId = resolveGuardianForRecovery_(groupId, 'definitely-not-a-guardian-' + Date.now() + '@example.com');
  out.d_nonguardian = dId;
  Logger.log('  d) email no-guardian → ' + dId + ' → ' + (dId === null ? '✓ PASS' : '✗ FAIL'));

  Logger.log('[manual_testRecoveryPerGuardian] ' + JSON.stringify(out, null, 2));
  Logger.log('=== fin manual_testRecoveryPerGuardian ===');
  return out;
}

/**
 * IDENTITY-FROM-LINK (2026-06-11) — verifica la identidad derivada DEL ENLACE (`n` =
 * email_id), sin columna nueva. SUPERSEDE manual_testIdentityBinding (vetado por Diego).
 *
 * Modelo canónico de Diego (LA regla, cita literal — corrección de rumbo): "Tienes
 * herramientas y datos suficientes para resolver la identidad sabiendo el email con el
 * que se solicita el link. No pienso crear un campo que solo sirve a uno de los tipos de
 * programa." → la identidad viaja en el `n` del enlace (email_id, opaco, ya existe).
 *
 * Caso real (mission): grupo e5bf6e89-…, tutor Diego 842951e3-…, email
 * ground.contact@gmail.com, email_id 81cfafbf-…. Ajustar abajo si difiere.
 *
 * Verifica:
 *   (a) emisión: findEmailIdForGuardian_(grupo, ground.contact) → email_id (81cfafbf…).
 *   (b) resolución: effectiveRecoveredEmail_ con token+n (sin recovered_email) → email →
 *       guardian 842951e3… (la identidad sale del enlace, no del cliente).
 *   (c) `n` (email_id) de OTRO grupo → rechazado (KAL-4 cross-group).
 *   (d) `n` basura (no-UUID / UUID inexistente) → ignorado limpio (KAL-5) → null.
 *   (e) sin `n` y sin recovered_email → null (group-scoped intacto).
 *
 * Ejecutar desde el editor GAS / clasp run; lee PASS/FAIL en Logs. NO envía email
 * (no llama sendMagicLink_); solo lee BD + ejercita los resolvers.
 */
function manual_testIdentityFromLink() {
  Logger.log('=== manual_testIdentityFromLink (IDENTITY-FROM-LINK) ===');
  var GROUP_ID_REAL       = 'e5bf6e89-6018-4d8e-9c1f-de3a9f5ece3d';
  var GUARDIAN_ID_REAL    = '842951e3'; // prefijo esperado del guardian (Diego)
  var GUARDIAN_EMAIL_REAL = 'ground.contact@gmail.com';

  var out = {};
  var pass = true;

  // (a) Emisión: localizar el email_id del guardian en su grupo.
  var nEmailId = findEmailIdForGuardian_(GROUP_ID_REAL, GUARDIAN_EMAIL_REAL);
  out.a_email_id = nEmailId;
  var aOk = !!nEmailId;
  if (!aOk) pass = false;
  Logger.log('  (a) findEmailIdForGuardian_ → n(email_id)=' + redact_(String(nEmailId)) + ' → ' +
             (aOk ? '✓ PASS' : '✗ FAIL (¿existe fila enrEmails para ese email en el grupo?)'));

  // (b) Resolución: token+n SIN recovered_email → email → guardian.
  var effFromLink = effectiveRecoveredEmail_(null, GROUP_ID_REAL, nEmailId);
  out.b_effective_email = effFromLink;
  var gFromLink = effFromLink ? resolveGuardianForRecovery_(GROUP_ID_REAL, effFromLink) : null;
  out.b_guardian_from_link = gFromLink;
  var bOk = !!(gFromLink && String(gFromLink).indexOf(GUARDIAN_ID_REAL) === 0);
  if (!bOk) pass = false;
  Logger.log('  (b) effectiveRecoveredEmail_(null, grupo, n) → email=' + redact_(String(effFromLink)) +
             ' guardian=' + String(gFromLink) + ' → ' +
             (bOk ? '✓ PASS (identidad DEL ENLACE, sin cliente)' : '✗ FAIL (esperado prefijo ' + GUARDIAN_ID_REAL + ')'));

  // (c) `n` de OTRO grupo → rechazado. Buscar un email_id que NO sea de este grupo.
  var otherEmailId = null;
  try {
    var anyEmails = appsheetRequest_(T.EMAILS, 'Find', [], {
      Filter: 'NOT("enrollment_group_id" = "' + appsheetEscape_(GROUP_ID_REAL) + '")'
    }) || [];
    var foreign = anyEmails.find(function(r) { return r && r.email_id; });
    otherEmailId = foreign ? foreign.email_id : null;
  } catch (e) { otherEmailId = null; }
  if (otherEmailId) {
    var effCross = effectiveRecoveredEmail_(null, GROUP_ID_REAL, otherEmailId);
    out.c_cross_group = effCross;
    var cOk = effCross === null;
    if (!cOk) pass = false;
    Logger.log('  (c) `n` de OTRO grupo → ' + String(effCross) + ' → ' +
               (cOk ? '✓ PASS (rechazado, KAL-4 cross-group)' : '✗ FAIL (resolvió identidad ajena!)'));
  } else {
    Logger.log('  (c) (n/a) — no se encontró un email_id de otro grupo para probar cross-group.');
  }

  // (d) `n` basura → ignorado limpio (KAL-5). Dos sub-casos: no-UUID y UUID inexistente.
  var effGarbage1 = effectiveRecoveredEmail_(null, GROUP_ID_REAL, 'not-a-uuid" || "1"="1');
  var effGarbage2 = effectiveRecoveredEmail_(null, GROUP_ID_REAL, Utilities.getUuid());
  out.d_garbage_noUuid = effGarbage1;
  out.d_garbage_unknownUuid = effGarbage2;
  var dOk = effGarbage1 === null && effGarbage2 === null;
  if (!dOk) pass = false;
  Logger.log('  (d) `n` basura (no-UUID + UUID inexistente) → ' + String(effGarbage1) + ' / ' + String(effGarbage2) +
             ' → ' + (dOk ? '✓ PASS (ignorado limpio, KAL-5)' : '✗ FAIL'));

  // (e) sin `n` y sin recovered_email → null (group-scoped intacto).
  var effNone = effectiveRecoveredEmail_(null, GROUP_ID_REAL, null);
  out.e_none = effNone;
  var eOk = effNone === null;
  if (!eOk) pass = false;
  Logger.log('  (e) sin `n` ni recovered_email → ' + String(effNone) + ' → ' +
             (eOk ? '✓ PASS (group-scoped intacto)' : '✗ FAIL'));

  Logger.log('[manual_testIdentityFromLink] ' + JSON.stringify(out, null, 2));
  Logger.log('=== manual_testIdentityFromLink: ' + (pass ? 'PASS' : 'FAIL') + ' ===');
  return out;
}

/**
 * IDENTITY-COMPLETION (2026-06-11) — test de la REENTRADA del FIRMANTE: la identidad del
 * acto de firma sale del TOKEN DE SESIÓN + el `n` del enlace, NUNCA del `signing_token`
 * volátil del cliente. Cierra las 3 🔴 de la auditoría de conformidad (filas 5, 29, 30),
 * complementando `manual_testIdentityFromLink` (que cubre la resolución base del `n`).
 *
 * Mecanismo canónico (IDENTITY-FROM-LINK, Diego 2026-06-11): la identidad viaja en el `n`
 * (= email_id de enrEmails) del magic link — dato OPACO, sin PII, YA EXISTENTE, SIN columna/
 * tabla/almacenamiento nuevo. El frontend persiste `n` en sessionStorage (recoveryNonce) y
 * lo REENVÍA en hydrate + pulse + LOS ACTOS DE FIRMA. El backend lo resuelve server-side
 * (resolveEmailFromLinkParam_ → email → guardian, validado contra el grupo del token, KAL-4).
 *
 * Límite honesto: si el cliente PIERDE el `n` (sessionStorage borrado Y sin recovered_email)
 * y reentra solo con el token → degrada a group-scoped (el fallback requester cubre al
 * tutor-1 solicitante; el tutor-2 sin `n` ni recovered_email no se identifica en ese caso
 * extremo). Esto es coherente con la decisión de Diego de NO crear almacenamiento server-side
 * de la identidad: el enlace ES el portador, y el cliente lo conserva entre reentradas.
 *
 * Gates (mapeo al prompt — model n=email_id):
 *   (a) emisión tutor-1 → `n` (email_id) localizable (findEmailIdForGuardian_).
 *   (b) reentrada del firmante con token + `n` (la firma lo reenvía) → requireSignerContext_
 *       resuelve el guardian SIN signing_token del cliente (path a) — fila 29/30.
 *   (c) getDocument_ bajo resume_token + `n` resuelve el signing_token SERVER-SIDE para el
 *       PDF de firma (resolveGuardianSigningContext_) — fila 30.
 *   (d) fallback requester → tutor-1 resuelve sin `n` (resolveGuardianForRecovery_).
 *   (e) sin `n` ni recovered_email → group-scoped limpio (degradación honesta).
 *
 * Read-only salvo (a) — NO ejecuta sendMagicLink_ (solo localiza el email_id, sin enviar
 * email ni rotar token). Ejecutar vía clasp run / editor GAS; lee PASS/FAIL en Logs.
 */
function manual_testIdentityReentry() {
  Logger.log('=== manual_testIdentityReentry (IDENTITY-COMPLETION — filas 5/29/30) ===');
  var GROUP_ID_REAL       = 'e5bf6e89-6018-4d8e-9c1f-de3a9f5ece3d';
  var GUARDIAN_ID_REAL    = '842951e3';
  var GUARDIAN_EMAIL_REAL = 'ground.contact@gmail.com';
  var out = {}; var pass = true;

  var grp = (appsheetRequest_(T.ENROLLMENT_GROUPS, 'Find', [], {
    Filter: '"enrollment_group_id" = "' + appsheetEscape_(GROUP_ID_REAL) + '"'
  }) || [])[0] || null;
  if (!grp) { Logger.log('  ✗ FAIL — GROUP_ID_REAL no existe.'); return { error: 'GROUP_NOT_FOUND' }; }

  // (a) Emisión: el `n` (email_id) del guardian es localizable (lo que va a la URL).
  var nEmailId = findEmailIdForGuardian_(GROUP_ID_REAL, GUARDIAN_EMAIL_REAL);
  out.a_email_id = nEmailId;
  var aOk = !!nEmailId;
  if (!aOk) pass = false;
  Logger.log('  (a) findEmailIdForGuardian_ → n(email_id)=' + redact_(String(nEmailId)) + ' → ' +
             (aOk ? '✓ PASS' : '✗ FAIL (¿existe fila enrEmails?)'));

  // (b) Reentrada del FIRMANTE con token + `n` (SIN signing_token del cliente — la firma
  //     reenvía la identidad de sesión). requireSignerContext_ resuelve el guardian. Filas 29/30.
  if (grp.resume_token) {
    try {
      var sctx = requireSignerContext_({ resume_token: grp.resume_token, n: nEmailId }); // sin signing_token
      out.b_signer = { group: sctx.enrollment_group_id, guardian: sctx.guardian_person_id };
      var bOk = !!(sctx.guardian_person_id && String(sctx.guardian_person_id).indexOf(GUARDIAN_ID_REAL) === 0
                   && sctx.enrollment_group_id === GROUP_ID_REAL && !sctx.signing_token);
      if (!bOk) pass = false;
      Logger.log('  (b) firma con token+n (sin signing_token cliente) → requireSignerContext_ guardian=' +
                 String(sctx.guardian_person_id) + ' → ' +
                 (bOk ? '✓ PASS (identidad del firmante de SESIÓN)' : '✗ FAIL'));
    } catch (e) {
      pass = false;
      Logger.log('  (b) requireSignerContext_ lanzó: ' + e.message + ' → ✗ FAIL');
    }
  } else { pass = false; Logger.log('  (b) ✗ FAIL — el grupo no tiene resume_token.'); }

  // (c) getDocument_ bajo resume_token + `n` resuelve el signing_token SERVER-SIDE (mismo
  //     camino que mi lazy resolver): n→email→guardian→resolveGuardianSigningContext_. Fila 30.
  var effForDoc = effectiveRecoveredEmail_(null, GROUP_ID_REAL, nEmailId);
  var gForDoc = effForDoc ? resolveGuardianForRecovery_(GROUP_ID_REAL, effForDoc) : null;
  var sigCtx = gForDoc ? resolveGuardianSigningContext_(GROUP_ID_REAL, gForDoc) : null;
  out.c_signing_token_resolved = !!(sigCtx && sigCtx.signing_token);
  // Honesto: si NO hay sesión de firma activa para este grupo (pre-AD), sigCtx==null —
  // entonces NO hay PDF de firma que servir (correcto). PASS si: o bien se resolvió el
  // token, o bien no hay sesión (degradación coherente, no un fallo de identidad).
  var cOk = (gForDoc && (sigCtx ? !!sigCtx.signing_token : true));
  if (!cOk) pass = false;
  Logger.log('  (c) getDocument_ resume_token+n → signing_token server-side=' +
             (sigCtx ? (sigCtx.signing_token ? 'RESUELTO' : 'sesión-sin-token') : 'sin-sesión-firma (pre-AD, OK)') +
             ' → ' + (cOk ? '✓ PASS' : '✗ FAIL'));

  // (d) Fallback requester: el solicitante (tutor-1) resuelve sin `n`.
  var dGuardian = resolveGuardianForRecovery_(GROUP_ID_REAL, GUARDIAN_EMAIL_REAL);
  out.d_requester_guardian = dGuardian;
  var dOk = !!(dGuardian && String(dGuardian).indexOf(GUARDIAN_ID_REAL) === 0);
  if (!dOk) pass = false;
  Logger.log('  (d) fallback requester → tutor-1 guardian=' + String(dGuardian) + ' → ' +
             (dOk ? '✓ PASS' : '✗ FAIL'));

  // (e) Sin `n` ni recovered_email → group-scoped limpio (degradación honesta).
  var effNone = effectiveRecoveredEmail_(null, GROUP_ID_REAL, null);
  out.e_effective_none = effNone;
  var eOk = effNone === null;
  if (!eOk) pass = false;
  Logger.log('  (e) sin n ni recovered_email → effectiveRecoveredEmail_=null (group-scoped limpio) → ' +
             (eOk ? '✓ PASS' : '✗ FAIL'));

  Logger.log('[manual_testIdentityReentry] ' + JSON.stringify(out, null, 2));
  Logger.log('=== manual_testIdentityReentry: ' + (pass ? 'PASS' : 'FAIL') + ' ===');
  return out;
}

/**
 * DL-E39 PII-primero — test del gate de step-up (Fase A).
 *
 * Ejecutar desde el editor GAS. Verifica la mecánica del gate
 * assertStepUpFresh_ + _markStepUpFresh_ contra el ScriptCache (NO toca BD):
 *   (a) sin marca           → assertStepUpFresh_ lanza STEPUP_REQUIRED.
 *   (b) tras _markStepUpFresh_(g) → pasa (no lanza).
 *   (c) marca EXPIRADA (timestamp en el pasado) → lanza STEPUP_REQUIRED.
 *   (d) NOTA: la firma (initiateSigningSession_) exige step-up INCONDICIONAL,
 *       independiente de la ventana de inactividad — no se cubre con cache aquí
 *       (requiere signing_token real); se documenta como recordatorio.
 *
 * GROUP_ID: cualquier UUID v4 sirve para el test de cache (no se lee de BD en
 * estos casos). RESUME_TOKEN: NO lo usa este test directamente — el gate opera
 * sobre el group ya derivado; se deja como nota para tests de integración.
 *
 * Lee PASS/FAIL en los Logs.
 */
function manual_testStepUpGate() {
  Logger.log('=== manual_testStepUpGate (DL-E39 Fase A) ===');
  var GROUP_ID     = 'REPLACE-WITH-REAL-GROUP-ID'; // UUID v4 cualquiera vale para el cache
  // var RESUME_TOKEN = 'REPLACE-WITH-REAL-RESUME-TOKEN'; // no usado por estos casos de cache
  if (GROUP_ID.indexOf('REPLACE-') === 0) {
    GROUP_ID = Utilities.getUuid(); // fallback: el gate de cache no necesita un grupo real
    Logger.log('  (info) GROUP_ID no rellenado → usando UUID efímero ' + GROUP_ID.slice(0, 8) + '...');
  }

  var cache = CacheService.getScriptCache();
  var key = 'stepup_ok_' + GROUP_ID;
  var pass = true;

  // Estado limpio
  cache.remove(key);

  // (a) sin marca → STEPUP_REQUIRED
  try {
    assertStepUpFresh_(GROUP_ID);
    Logger.log('  a) sin marca → ✗ FAIL (no lanzó)'); pass = false;
  } catch (e) {
    if (e && e.code === 'STEPUP_REQUIRED') Logger.log('  a) sin marca → ✓ PASS (STEPUP_REQUIRED)');
    else { Logger.log('  a) sin marca → ✗ FAIL (code=' + (e && e.code) + ')'); pass = false; }
  }

  // (b) tras _markStepUpFresh_ → pasa
  _markStepUpFresh_(GROUP_ID);
  try {
    assertStepUpFresh_(GROUP_ID);
    Logger.log('  b) tras _markStepUpFresh_ → ✓ PASS (no lanzó)');
  } catch (e) {
    Logger.log('  b) tras _markStepUpFresh_ → ✗ FAIL (lanzó code=' + (e && e.code) + ')'); pass = false;
  }

  // (c) marca expirada → STEPUP_REQUIRED
  cache.put(key, String(Date.now() - 1), 600);
  try {
    assertStepUpFresh_(GROUP_ID);
    Logger.log('  c) marca expirada → ✗ FAIL (no lanzó)'); pass = false;
  } catch (e) {
    if (e && e.code === 'STEPUP_REQUIRED') Logger.log('  c) marca expirada → ✓ PASS (STEPUP_REQUIRED)');
    else { Logger.log('  c) marca expirada → ✗ FAIL (code=' + (e && e.code) + ')'); pass = false; }
  }

  // (d) recordatorio firma incondicional
  Logger.log('  d) NOTA: initiateSigningSession_ exige step-up INCONDICIONAL ' +
             '(assertStepUpFresh_ siempre antes de iniciar el acto), independiente ' +
             'de la ventana de inactividad — verificar con signing_token real en integración.');

  // Limpieza
  cache.remove(key);

  Logger.log('=== manual_testStepUpGate: ' + (pass ? 'PASS' : 'FAIL') + ' ===');
  return { pass: pass };
}

/**
 * ★ SEC-STEPUP (finding #55, 2026-06-11) — test de la GRACIA de magic-link + la
 * VENTANA DURA de step-up. Ejecutar desde el editor GAS. Opera 100% sobre el
 * ScriptCache (no toca BD). Cubre los 4 casos del veredicto:
 *
 *   (i)   GRACIA SINGLE-USE: tras acuñar `mlgrace_<token>`, _consumeMagicLinkNonce_
 *         devuelve true UNA vez (borra la marca); la SEGUNDA resolución devuelve
 *         false → sin gracia → el gate exigiría OTP. (Cierra el bypass: la gracia
 *         NO se reusa en cada recarga.)
 *   (ii)  TTL DURO: una marca stepup_ok cuyo timestamp ya pasó → _isStepUpFresh_
 *         false (la ventana caduca a los 10 min sin extensión por uso).
 *   (iii) RENUEVA SOLO POR RE-VERIFICACIÓN: _markStepUpFresh_ (OTP/gracia) re-fija
 *         la ventana a now+10min; una LECTURA (_isStepUpFresh_) NO la mueve — dos
 *         lecturas consecutivas no extienden el tope (anti-slide).
 *   (iv)  SIN GRACIA NI OTP: ni marca de gracia ni stepup_ok → _isStepUpFresh_
 *         false → el PII-gate (hydrateSession_) devolvería pii_gated:true.
 *
 * Lee PASS/FAIL en los Logs.
 */
function manual_testStepUpGrace() {
  Logger.log('=== manual_testStepUpGrace (SEC-STEPUP #55) ===');
  var cache   = CacheService.getScriptCache();
  var GROUP   = Utilities.getUuid();
  var TOKEN   = Utilities.getUuid();
  var gKey    = 'mlgrace_' + TOKEN;
  var sKey    = 'stepup_ok_' + GROUP;
  var pass    = true;
  cache.remove(gKey); cache.remove(sKey);

  // (i) gracia single-use → consume y la 2ª resolución exige OTP
  _mintMagicLinkNonce_(TOKEN, GROUP);
  var first  = _consumeMagicLinkNonce_(TOKEN, GROUP);
  var second = _consumeMagicLinkNonce_(TOKEN, GROUP);
  if (first === true && second === false) {
    Logger.log('  i) gracia single-use → ✓ PASS (1ª=true, 2ª=false)');
  } else {
    Logger.log('  i) gracia single-use → ✗ FAIL (1ª=' + first + ', 2ª=' + second + ')'); pass = false;
  }

  // (ii) TTL duro: marca expirada → no fresca
  cache.put(sKey, String(Date.now() - 1), 600);
  if (_isStepUpFresh_(GROUP) === false) {
    Logger.log('  ii) TTL duro expirado → ✓ PASS (no fresca)');
  } else {
    Logger.log('  ii) TTL duro expirado → ✗ FAIL (reporta fresca)'); pass = false;
  }

  // (iii) re-verificación renueva; lectura NO desliza
  cache.remove(sKey);
  _markStepUpFresh_(GROUP, 'OTP');
  var topAfterMark = Number(cache.get(sKey));
  _isStepUpFresh_(GROUP);                 // LECTURA — no debe mover el tope
  _isStepUpFresh_(GROUP);                 // LECTURA — no debe mover el tope
  var topAfterReads = Number(cache.get(sKey));
  if (_isStepUpFresh_(GROUP) === true && topAfterReads === topAfterMark) {
    Logger.log('  iii) OTP renueva / lectura NO desliza → ✓ PASS (tope estable ' + topAfterMark + ')');
  } else {
    Logger.log('  iii) lectura desliza → ✗ FAIL (mark=' + topAfterMark + ' reads=' + topAfterReads + ')'); pass = false;
  }

  // (iv) sin gracia ni OTP → no fresca (pii_gated)
  cache.remove(gKey); cache.remove(sKey);
  var graceMiss = _consumeMagicLinkNonce_(TOKEN, GROUP);
  if (graceMiss === false && _isStepUpFresh_(GROUP) === false) {
    Logger.log('  iv) sin gracia ni OTP → ✓ PASS (pii_gated)');
  } else {
    Logger.log('  iv) sin gracia ni OTP → ✗ FAIL (grace=' + graceMiss + ', fresh=' + _isStepUpFresh_(GROUP) + ')'); pass = false;
  }

  cache.remove(gKey); cache.remove(sKey);
  Logger.log('=== manual_testStepUpGrace: ' + (pass ? 'PASS' : 'FAIL') + ' ===');
  return { pass: pass };
}

/**
 * URGENT-RECOVERY / 2026-06-11 — Diagnóstico de filas enrEmails de un grupo.
 *
 * Modelo canónico de Diego: "No existe email de grupo. Cualquier tutor recupera
 * con SU email personal. Los emails son los introducidos al acceder por primera vez —
 * el de creación es el email personal del tutor que inicia. Identidad = solicitud +
 * email." La columna primary_email de enrEnrollmentGroups es un ARTEFACTO Stage-1.
 *
 * Vuelca por Logs (KAL-11: valores redactados a primeros 3 chars + dominio):
 *   - primary_email del grupo + requester_person_id.
 *   - Cada fila enrEmails: email_id (first-8), value (redactado), person_id, email_type_id, is_active.
 *   - person_type_id de cada persona del grupo.
 *
 * Rellena GROUP_ID_REAL antes de ejecutar.
 */
function manual_diagGroupEmails() {
  var GROUP_ID_REAL = 'e5bf6e89-REPLACE-WITH-FULL-UUID'; // rellenar con el UUID completo

  Logger.log('=== manual_diagGroupEmails ===');
  if (GROUP_ID_REAL.indexOf('REPLACE-') >= 0) {
    Logger.log('  (skip) — rellenar GROUP_ID_REAL con el enrollment_group_id real.');
    return { skipped: true };
  }
  try { assertValidUuid_(GROUP_ID_REAL, 'enrollment_group_id'); }
  catch (e) { Logger.log('  ✗ UUID inválido: ' + e.message); return { error: 'INVALID_UUID' }; }

  var idEsc = appsheetEscape_(GROUP_ID_REAL);

  var grpRows = appsheetRequest_(T.ENROLLMENT_GROUPS, 'Find', [],
    { Filter: '"enrollment_group_id" = "' + idEsc + '"' }) || [];
  if (!grpRows.length) { Logger.log('  ✗ Grupo no encontrado.'); return { error: 'NOT_FOUND' }; }
  var grp = grpRows[0];
  Logger.log(redact_('  primary_email=' + (grp.primary_email || '(null)') +
             ' requester_person_id=' + (grp.requester_person_id || '(null)')));

  var persons = appsheetRequest_(T.PERSONS, 'Find', [],
    { Filter: '"enrollment_group_id" = "' + idEsc + '"' }) || [];
  Logger.log('  enrPersons count=' + persons.length);
  persons.forEach(function(p, i) {
    Logger.log(redact_('    [persona ' + i + '] person_id=' + (p.person_id || '(null)') +
               ' type=' + (p.person_type_id || '?') +
               ' name=' + (p.first_name || '') + ' ' + (p.last_name || '')));
  });

  var emailRows = appsheetRequest_(T.EMAILS, 'Find', [],
    { Filter: '"enrollment_group_id" = "' + idEsc + '"' }) || [];
  Logger.log('  enrEmails count=' + emailRows.length);
  emailRows.forEach(function(e, i) {
    // KAL-11: redact pero muestra los primeros chars para identificación
    var valRaw = String(e.value || '');
    var valShort = valRaw.length > 3 ? valRaw.substring(0, 3) + '...' + (valRaw.indexOf('@') >= 0 ? valRaw.substring(valRaw.indexOf('@')) : '') : valRaw;
    Logger.log('    [email ' + i + '] email_id=' + String(e.email_id || '').substring(0, 8) +
               '... value=' + valShort +
               ' person_id=' + (e.person_id || '(null/huérfano)') +
               ' email_type_id=' + (e.email_type_id || '(null)') +
               ' is_active=' + (e.is_active || '(null)'));
  });

  // Verificar si el resolver ya funciona (post-fix):
  var resolvedId = resolveGuardianForRecovery_(GROUP_ID_REAL, grp.primary_email, emailRows, persons, grp);
  Logger.log(redact_('  resolveGuardianForRecovery_(primary_email) → ' + (resolvedId || 'null') +
             ' ' + (resolvedId ? '✓ PASS (fallback funciona)' : '✗ FAIL')));

  Logger.log('=== fin manual_diagGroupEmails ===');
  return {
    primary_email_redacted: grp.primary_email ? grp.primary_email.substring(0, 3) + '...' : null,
    requester_person_id: grp.requester_person_id || null,
    enrEmails_count: emailRows.length,
    orphan_emails: emailRows.filter(function(e) { return !e.person_id; }).length,
    persons_count: persons.length,
    guardians_count: persons.filter(function(p) { return p.person_type_id === 'guardian'; }).length,
    resolver_result: resolvedId,
  };
}

/**
 * URGENT-RECOVERY / 2026-06-11 — Repara la fila enrEmails huérfana del tutor 1.
 *
 * El email de creación de la sesión se guarda en enrEnrollmentGroups.primary_email
 * pero la fila en enrEmails que corresponde a ese email puede tener person_id=null
 * porque cuando se creó el grupo, el tutor aún no tenía person_id asignado (se
 * asigna en el Step 2 via KMS enr_persistPersons_). Este helper vincula la fila
 * huérfana al requester_person_id del grupo.
 *
 * Operación: Edit enrEmails SET person_id = requester_person_id WHERE
 *   email_id = la fila huérfana (value = primary_email del grupo, person_id null).
 *
 * Rellena GROUP_ID_REAL antes de ejecutar. Lee PASS/FAIL en los Logs.
 * KAL-4: person_id resuelto desde datos del servidor (requester_person_id), no del payload.
 * KAL-5: groupId validado con assertValidUuid_ + appsheetEscape_.
 */
function manual_repairRequesterEmailLink() {
  var GROUP_ID_REAL = 'e5bf6e89-REPLACE-WITH-FULL-UUID'; // rellenar con el UUID completo

  Logger.log('=== manual_repairRequesterEmailLink ===');
  if (GROUP_ID_REAL.indexOf('REPLACE-') >= 0) {
    Logger.log('  (skip) — rellenar GROUP_ID_REAL con el enrollment_group_id real.');
    return { skipped: true };
  }
  try { assertValidUuid_(GROUP_ID_REAL, 'enrollment_group_id'); }
  catch (e) { Logger.log('  ✗ UUID inválido: ' + e.message); return { error: 'INVALID_UUID' }; }

  var idEsc = appsheetEscape_(GROUP_ID_REAL);

  // Leer el grupo para obtener primary_email + requester_person_id.
  var grpRows = appsheetRequest_(T.ENROLLMENT_GROUPS, 'Find', [],
    { Filter: '"enrollment_group_id" = "' + idEsc + '"' }) || [];
  if (!grpRows.length) { Logger.log('  ✗ Grupo no encontrado.'); return { error: 'NOT_FOUND' }; }
  var grp = grpRows[0];
  var primaryEmail = String(grp.primary_email || '').toLowerCase().trim();
  var requesterId = grp.requester_person_id;

  Logger.log(redact_('  primary_email=' + primaryEmail + ' requester_person_id=' + (requesterId || '(null)')));

  if (!primaryEmail) { Logger.log('  ✗ primary_email vacío — nada que reparar.'); return { error: 'NO_PRIMARY_EMAIL' }; }
  if (!requesterId) { Logger.log('  ✗ requester_person_id nulo — el Step 2 aún no se completó. Reparar tras Step 2.'); return { error: 'NO_REQUESTER_PERSON_ID' }; }

  // Verificar que requester_person_id es un guardian.
  var persons = appsheetRequest_(T.PERSONS, 'Find', [],
    { Filter: '"enrollment_group_id" = "' + idEsc + '"' }) || [];
  var requester = persons.find(function(p) { return p.person_id === requesterId; });
  if (!requester) { Logger.log(redact_('  ✗ requester_person_id=' + requesterId + ' no encontrado en enrPersons.')); return { error: 'REQUESTER_NOT_FOUND' }; }
  if (requester.person_type_id !== 'guardian') {
    Logger.log(redact_('  ✗ requester person_type_id=' + requester.person_type_id + ' (no es guardian) — PARA y reporta.'));
    return { error: 'REQUESTER_NOT_GUARDIAN' };
  }
  Logger.log(redact_('  requester es guardian ✓ — person_id=' + requesterId));

  // Encontrar la fila huérfana: value=primary_email Y person_id nulo/vacío.
  var emailRows = appsheetRequest_(T.EMAILS, 'Find', [],
    { Filter: '"enrollment_group_id" = "' + idEsc + '"' }) || [];
  var orphans = emailRows.filter(function(e) {
    return !e.person_id && String(e.value || '').toLowerCase().trim() === primaryEmail;
  });
  Logger.log('  enrEmails total=' + emailRows.length + ' orphans-matching-primary=' + orphans.length);

  if (!orphans.length) {
    // Puede que la fila ya tenga person_id (ya reparada o creada correctamente).
    var alreadyLinked = emailRows.find(function(e) {
      return e.person_id === requesterId && String(e.value || '').toLowerCase().trim() === primaryEmail;
    });
    if (alreadyLinked) {
      Logger.log('  (ya reparado) — la fila ya tiene person_id=' + requesterId + '. Sin acción.');
      return { already_repaired: true };
    }
    Logger.log('  (no hay fila huérfana con ese email) — puede que la fila no exista todavía. Sin acción.');
    return { no_orphan: true };
  }

  // Reparar todas las filas huérfanas (normalmente solo una).
  var repaired = 0;
  orphans.forEach(function(e) {
    try {
      appsheetRequest_(T.EMAILS, 'Edit', [{
        email_id:  e.email_id,
        person_id: requesterId,
      }]);
      repaired++;
      Logger.log('  ✓ Reparado email_id=' + String(e.email_id).substring(0, 8) + '... → person_id=' + requesterId.substring(0, 8) + '...');
    } catch (ex) {
      Logger.log('  ✗ Error reparando email_id=' + e.email_id + ': ' + ex.message);
    }
  });

  // Verificar que ahora el resolver funciona.
  var resolvedId = resolveGuardianForRecovery_(GROUP_ID_REAL, primaryEmail, null, null, grp);
  Logger.log(redact_('  post-repair: resolveGuardianForRecovery_(primary_email) → ' + (resolvedId || 'null') +
             ' ' + (resolvedId === requesterId ? '✓ PASS' : '✗ FAIL')));

  Logger.log('=== manual_repairRequesterEmailLink: ' + (repaired > 0 ? 'REPAIRED ' + repaired + ' fila(s)' : 'NOOP') + ' ===');
  return { repaired: repaired, person_id_linked: requesterId };
}

/**
 * P215 / WIZARD-STEP7-GATE — diagnóstico del gate de firma del Step 7.
 *
 * Rellena GROUP_ID (y opcionalmente RECOVERED_EMAIL) abajo, ejecuta desde el
 * editor GAS y lee los Logs. Vuelca, REDACTADO (KAL-11, token solo first-8):
 *   - state_code del expediente (vía buildAdmissionContext_).
 *   - si RECOVERED_EMAIL resuelve un guardian (Vía 1).
 *   - todas las sesiones de firma del grupo (entity_id, current_state_code, deleted_at).
 *   - todos los signers por sesión (¿tiene signing_token?, signed_at, deleted_at, person).
 *   - conteo de guardians del grupo.
 *   - resultado de Vía 1 (per-guardian) y Vía 2 (cross-device determinista) + candidatos.
 *
 * NO es un endpoint del dispatcher — solo se ejecuta desde el editor (auth owner).
 */
function manual_diagWizardSigningGate() {
  var GROUP_ID        = 'REPLACE-WITH-REAL-GROUP-ID';
  var RECOVERED_EMAIL = ''; // opcional: email tecleado por la familia (discriminador a1)

  Logger.log('=== manual_diagWizardSigningGate ===');
  if (GROUP_ID.indexOf('REPLACE-') === 0) {
    Logger.log('  ✗ Rellena GROUP_ID con un enrollment_group_id real antes de ejecutar.');
    return;
  }

  var idEsc = appsheetEscape_(GROUP_ID);

  // Enrollments + persons + emails del grupo.
  var enrollments = appsheetRequest_(T.ENROLLMENTS, 'Find', [],
    { Filter: '"enrollment_group_id" = "' + idEsc + '"' }) || [];
  var persons = appsheetRequest_(T.PERSONS, 'Find', [],
    { Filter: '"enrollment_group_id" = "' + idEsc + '"' }) || [];
  var emails = appsheetRequest_(T.EMAILS, 'Find', [],
    { Filter: '"enrollment_group_id" = "' + idEsc + '"' }) || [];

  var guardianCount = 0;
  persons.forEach(function(p) { if (p && p.person_type_id === 'guardian') guardianCount++; });
  Logger.log('  enrollments=' + enrollments.length + ' persons=' + persons.length +
             ' guardians=' + guardianCount);

  // Vía 1: ¿RECOVERED_EMAIL resuelve guardian?
  var recoveredGuardianId = resolveGuardianForRecovery_(GROUP_ID, RECOVERED_EMAIL || null, emails, persons);
  Logger.log(redact_('  recovered_email=' + (RECOVERED_EMAIL || '(vacío)') +
             ' → guardian=' + (recoveredGuardianId || 'null')));

  // Sesiones de firma del grupo.
  var sessions = appsheetRequest_(T.SIGNING_SESSIONS, 'Find', [],
    { Filter: '"entity_id" = "' + idEsc + '"' }) || [];
  Logger.log('  sesiones de firma ancladas al grupo: ' + sessions.length);
  sessions.forEach(function(s, i) {
    Logger.log('    [sesión ' + i + '] session_id=' + String(s.session_id || '').substring(0, 8) +
               '... state=' + (s.current_state_code || '(null)') +
               ' deleted_at=' + (s.deleted_at || '(no)'));
    if (s.session_id) {
      var signers = appsheetRequest_(T.SIGNING_SESSION_SIGNERS, 'Find', [],
        { Filter: '"session_id" = "' + appsheetEscape_(s.session_id) + '"' }) || [];
      signers.forEach(function(r) {
        Logger.log(redact_('       signer person=' + (r.signer_person_id || '(null)') +
                   ' hasToken=' + (!!r.signing_token) +
                   ' tokenPrev=' + (r.signing_token ? String(r.signing_token).substring(0, 8) + '...' : '(none)') +
                   ' signed_at=' + (r.signed_at || '(no)') +
                   ' deleted_at=' + (r.deleted_at || '(no)')));
      });
    }
  });

  // Vías de resolución (opción a: SOLO server-side; opción b in-app eliminada).
  var via1 = recoveredGuardianId ? resolveGuardianSigningContext_(GROUP_ID, recoveredGuardianId) : null;
  var via2 = resolveSigningContextFromSession_(GROUP_ID, persons);

  Logger.log('  Vía 1 (per-guardian a1): ' + (via1 ? 'RESUELTA (token=' +
             String(via1.signing_token).substring(0, 8) + '...)' : 'null'));
  Logger.log('  Vía 2 (cross-device determinista): ' + (via2 ? 'RESUELTA (token=' +
             String(via2.signing_token).substring(0, 8) + '...)' : 'null'));

  // WIZARD-STEP7-COMPLETED: estado de firma incl. terminal COMPLETED.
  var signingStatus = resolveSigningStatus_(GROUP_ID);
  Logger.log('  signing_status (lifecycle): ' + signingStatus);

  // Resultado final del gate tal como lo ve el frontend.
  var admission = buildAdmissionContext_(GROUP_ID, enrollments, recoveredGuardianId, persons);
  Logger.log('  >>> buildAdmissionContext_: state_code=' + admission.state_code +
             ' signing_available=' + admission.signing_available +
             ' signing_context=' + (admission.signing_context ? 'sí' : 'no') +
             ' signing_status=' + admission.signing_status);
  Logger.log('=== fin manual_diagWizardSigningGate ===');
  return admission;
}

/**
 * P237 — Verifica los 4 flags de steps que resolveSigningToken_ deriva desde
 * sysMilestones reales. Rellena GROUP_ID + SIGNER_ID (reales) arriba e imprime en
 * Logs cada flag + el anchor usado. KAL-11: ids redactados con redact_().
 */
function manual_testSigningStepsFromMilestones() {
  var GROUP_ID  = 'REPLACE-WITH-REAL-GROUP-ID';   // enrollment_group_id (anchor BILLING)
  var SIGNER_ID = 'REPLACE-WITH-REAL-SIGNER-ID';  // signer_id (anchor GDPR/REVIEW)

  Logger.log('=== manual_testSigningStepsFromMilestones ===');
  if (GROUP_ID.indexOf('REPLACE-') === 0 || SIGNER_ID.indexOf('REPLACE-') === 0) {
    Logger.log('  ✗ Rellena GROUP_ID y SIGNER_ID reales antes de ejecutar.');
    return;
  }

  var billing = isMilestoneCompleted_('ENR_ADMISSION_SCHOOL', GROUP_ID, 'BILLING_STEP_COMPLETED');
  var gdpr    = isMilestoneCompleted_('SYS_SIGNING_SESSION_SIGNER', SIGNER_ID, 'GDPR_CONSENTS_SUBMITTED');
  var review  = isMilestoneCompleted_('SYS_SIGNING_SESSION_SIGNER', SIGNER_ID, 'REVIEW_CONFIRMED');

  Logger.log(redact_('  group=' + GROUP_ID + ' signer=' + SIGNER_ID));
  Logger.log('  billing_confirmed (BILLING_STEP_COMPLETED @ ENR_ADMISSION_SCHOOL/grupo): ' + billing);
  Logger.log('  gdpr_completed    (GDPR_CONSENTS_SUBMITTED @ SYS_SIGNING_SESSION_SIGNER/signer): ' + gdpr);
  Logger.log('  review_completed  (REVIEW_CONFIRMED @ SYS_SIGNING_SESSION_SIGNER/signer): ' + review);
  Logger.log('  (signed se deriva de signer.signed_at en resolveSigningToken_, no de milestone)');
  Logger.log('=== fin manual_testSigningStepsFromMilestones ===');
  return { billing_confirmed: billing, gdpr_completed: gdpr, review_completed: review };
}

/**
 * RESP-FIX — Diagnóstico: cuenta cuántas filas qbResponses hay bajo cada clase de
 * respondent_id (group_id / person_id / enrollment_id) para un grupo real. Confirma
 * que el read unión de resumeSession_ ya recupera las respuestas por-aplicante.
 * Rellena GROUP_ID arriba. Read-only. NO registrado en doPost (diagnóstico). KAL-11.
 */
function manual_diagResponsesRetrieval() {
  var GROUP_ID = 'REPLACE-WITH-REAL-GROUP-ID';
  Logger.log('=== manual_diagResponsesRetrieval ===');
  if (GROUP_ID.indexOf('REPLACE-') === 0) {
    Logger.log('  ✗ Rellena GROUP_ID con un enrollment_group_id real.');
    return;
  }
  var idEsc       = appsheetEscape_(GROUP_ID);
  var persons     = appsheetRequest_(T.PERSONS, 'Find', [], { Filter: '"enrollment_group_id" = "' + idEsc + '"' }) || [];
  var enrollments = appsheetRequest_(T.ENROLLMENTS, 'Find', [], { Filter: '"enrollment_group_id" = "' + idEsc + '"' }) || [];

  var countFor = function (ids) {
    var valid = [];
    ids.forEach(function (rid) { if (rid) { try { assertValidUuid_(rid, 'id'); valid.push(rid); } catch (e) { /* skip */ } } });
    if (!valid.length) return 0;
    var f = '(' + valid.map(function (rid) { return '"respondent_id" = "' + appsheetEscape_(rid) + '"'; }).join(' || ') + ')';
    return (appsheetRequest_(T.QB_RESPONSES, 'Find', [], { Filter: f }) || []).length;
  };

  var byGroup      = countFor([GROUP_ID]);
  var byPerson     = countFor(persons.map(function (p) { return p.person_id; }));
  var byEnrollment = countFor(enrollments.map(function (e) { return e.enrollment_id; }));

  Logger.log(redact_('  group=' + GROUP_ID + ' persons=' + persons.length + ' enrollments=' + enrollments.length));
  Logger.log('  qbResponses by group_id:      ' + byGroup);
  Logger.log('  qbResponses by person_id:     ' + byPerson);
  Logger.log('  qbResponses by enrollment_id: ' + byEnrollment);
  Logger.log('=== fin manual_diagResponsesRetrieval ===');
  return { group: byGroup, person: byPerson, enrollment: byEnrollment };
}
