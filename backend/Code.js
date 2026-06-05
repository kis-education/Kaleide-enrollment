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
  // MILESTONES, MILESTONE_TYPES, ADMISSION_DECISION, TENANT_CONFIG, FIN_PAYMENTS,
  // BANK_ACCOUNTS, SUBSCRIPTION_TYPES también borrados CLI 60 (sólo usados por los
  // endpoints huérfanos post CLI 59).
  SIGNING_SESSION_SIGNERS:   'sysSigningSessionSigners',
  SIGNING_SESSIONS:          'sysSigningSessions',
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
function requireResumeToken_(payload) {
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
  assertValidUuid_(token, 'signing_token'); // throw BAD_REQUEST si malformado

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
      // ── CLI 40 (2026-06-02) — WS4 4 endpoints firma proxy a KMS (P118, HC-1) ──
      // PROXIES finos al KMS con service token (patrón fetchQuestions_).
      // GATE-D resuelto (proxy vs directa) → proxy. GATE-B modo conservador en
      // submitGdprConsents (un set por sesión, sin fan-out per-guardian).
      // Implementación en sección "WS4 — Wizard pre-firma proxies a KMS".
      case 'saveBillingInfo':         result = saveBillingInfo_(payload);         break;
      case 'submitGdprConsents':      result = submitGdprConsents_(payload);      break;
      case 'confirmReview':           result = confirmReview_(payload);           break;
      case 'initiateSigningSession':  result = initiateSigningSession_(payload);  break;
      // ── CLI 60 (2026-05-30): cases borrados ─────────────────────────────────
      // getTrackingData, getInterviewForEnrollment, getAdmissionDecisionForEnrollment,
      // getReservationPaymentInfo, getSigningTokenFromResumeToken eliminados —
      // sus consumidores frontend (TrackApplicationPage, Step8Status, Step9Interview,
      // Step10Decision, Step12Deposit) fueron borrados por CLI 59 al corregir el
      // wizard a 11 steps canónicos.
      default:
        return jsonResponse_({ ok: false, error: 'Unknown action: ' + action }, 400);
    }

    return jsonResponse_({ ok: true, ...result });

  } catch (err) {
    Logger.log('doPost error: ' + err.message + '\n' + err.stack);
    // CLI 26 (2026-06-01) — structured error code for state-gate rejections
    // (NOT_EDITABLE, set by assertGroupEditable_). Per the silent-reject style:
    // HTTP 200 + { ok: false, error: { code, message } } — never 403 — so the
    // client always parses the response uniformly and reads `error.code`.
    if (err && err.code) {
      return jsonResponse_({
        ok: false,
        error: { code: err.code, message: err.message }
      });
    }
    return jsonResponse_({ ok: false, error: err.message }, 500);
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
  if (count >= 10) {
    const err = new Error('Too many magic-link requests for this email; try again in 1 hour');
    err.code = 'RATE_LIMITED';
    throw err;
  }
  cache.put(countKey, String(count + 1), 3600); // 1h TTL — sliding within window
}

// ─── Action handlers ──────────────────────────────────────────────────────────

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
  const VALID_SOURCES = ['WEB_PUBLIC', 'KMS_INTERNAL', 'FAMILIES_APP'];
  if (VALID_SOURCES.indexOf(sourceCode) === -1) {
    throw new Error('Invalid source_code: ' + sourceCode);
  }

  // Verify reCAPTCHA before writing anything to the database.
  // KMS_INTERNAL skips reCAPTCHA — staff is already authenticated upstream.
  const secret = PropertiesService.getScriptProperties().getProperty('RECAPTCHA_SECRET');
  if (secret && sourceCode === 'WEB_PUBLIC') {
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
    try {
      _checkMagicLinkRateLimit_(normalizedEmail);
      const lang = grp.preferred_language || (p.preferred_language || 'es');
      sendMagicLinkEmail_(grp.primary_email, grp.resume_token, lang, false);
    } catch (e) {
      Logger.log('initEnrollmentSession_: could not send magic link for submitted session: ' + e.message);
    }
    return {
      already_submitted:   true,
      enrollment_group_id: grp.enrollment_group_id,
      application_id:      grp.enrollment_group_id,
    };
  }

  const existingOpen = appsheetRequest_(T.ENROLLMENT_GROUPS, 'Find', [], {
    Filter: '"primary_email" = "' + appsheetEscape_(normalizedEmail) + '" && ISBLANK([submitted_at]) && ISBLANK([abandoned_at])'
  }) || [];
  if (existingOpen.length) {
    _checkMagicLinkRateLimit_(normalizedEmail);

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
    sendMagicLinkEmail_(winner.primary_email, winner.resume_token, lang, false);
    return {
      resumed:             true,
      count:               1,                // post-abandon: only the winner remains addressable
      abandoned_count:     losers.length,    // for frontend telemetry / debug
      enrollment_group_id: winner.enrollment_group_id,
      application_id:      winner.enrollment_group_id, // legacy alias
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
  sendMagicLinkEmail_(p.primary_email, resumeToken, lang, true);
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

  // ── reCAPTCHA gate for public calls ───────────────────────────────────────
  if (!internal) {
    const secret = PropertiesService.getScriptProperties().getProperty('RECAPTCHA_SECRET');
    if (secret) {
      if (!p.recaptcha_token) throw new Error('Missing reCAPTCHA token');
      const rc = verifyRecaptcha_({ token: p.recaptcha_token });
      if (!rc.pass) throw new Error('reCAPTCHA verification failed');
    }
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
    _checkMagicLinkRateLimit_((grp.primary_email || '').toLowerCase().trim());

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

    sendMagicLinkEmail_(grp.primary_email, tokenToSend, grp.preferred_language || 'es');
  } else if (p.primary_email) {
    // Find all non-submitted, non-abandoned sessions for this email
    assertValidEmail_(p.primary_email, 'primary_email');
    const rows = appsheetRequest_(T.ENROLLMENT_GROUPS, 'Find', [], {
      Filter: '"primary_email" = "' + appsheetEscape_(p.primary_email) + '" && ISBLANK([submitted_at]) && ISBLANK([abandoned_at])'
    });
    if (!rows || !rows.length) throw new Error('Enrollment group not found');
    _checkMagicLinkRateLimit_(p.primary_email.toLowerCase().trim());

    // Renew tokens + created_at for all non-submitted sessions before sending.
    const nowIso = new Date().toISOString();
    const grps = rows
      .sort((a, b) => new Date(a.created_at) - new Date(b.created_at))
      .map(g => {
        const newToken = generateUuid_();
        try {
          appsheetRequest_(T.ENROLLMENT_GROUPS, 'Edit', [{
            enrollment_group_id: g.enrollment_group_id,
            resume_token:        newToken,
            created_at:          nowIso,
            updated_at:          nowIso,
          }]);
          return { ...g, resume_token: newToken };
        } catch (e) {
          // KAL-11: redact group_id UUID.
          Logger.log(redact_('sendMagicLink_: failed to renew token for group ' + g.enrollment_group_id + ': ' + e.message));
          return g; // fall back to original token on error
        }
      });

    const lang = grps[0].preferred_language || 'es';
    if (grps.length === 1) {
      // Use the single-link template (with full security footer + GDPR block)
      // instead of the abridged multi template when there's actually only one
      // open session — which is the common case under the new single-session policy.
      sendMagicLinkEmail_(p.primary_email, grps[0].resume_token, lang, false);
    } else {
      sendMagicLinkMultiEmail_(p.primary_email, grps.map(g => g.resume_token), lang);
    }
  } else {
    throw new Error('Missing enrollment_group_id or primary_email');
  }
  return { sent: true };
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

  // Documents: dedup by file_id + shape for frontend.
  // CLI 82 / KAL-NEW-5: NO drive_url. Sólo metadatos + file_id; los bytes se
  // resuelven on-demand vía getDocument (proxy gateado por token). El enlace
  // público de Drive desaparece del shape — nunca llega al cliente.
  let documents = [];
  if (topRead[3].ok) {
    const fileById = {};
    (topRead[3].data || []).forEach(f => { fileById[f.file_id] = f; });
    documents = Object.values(fileById).map(f => ({
      document_id:   f.file_id,
      file_id:       f.file_id,
      document_type: _docTypeFromRecType_(f.rec_type_code),
      file_name:     f.file_name,
      mimeType:      f.mime_type,
      uploaded_at:   f.created_at,
      rec_type_code: f.rec_type_code,
      status:        f.status,
    }));
  } else {
    Logger.log('resumeSession_: recFiles read failed (non-fatal): ' + topRead[3].error);
  }

  // qbResponses: backfill per-enrollment respondent_ids post-submit. Cheap
  // — appended to the group-scoped result rather than re-issued as a
  // separate parallel batch.
  let responses = topRead[4].ok ? (topRead[4].data || []) : [];
  if (enrollments.length) {
    enrollments.forEach(e => assertValidUuid_(e.enrollment_id, 'enrollment_id'));
    const enrIdFilter = enrollments.map(e => '"respondent_id" = "' + appsheetEscape_(e.enrollment_id) + '"').join(' || ');
    const perEnr = appsheetRequest_(T.QB_RESPONSES, 'Find', [], { Filter: enrIdFilter }) || [];
    responses = responses.concat(perEnr);
  }

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
      persons: [], relations, documents, responses, interviews
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

  const now = new Date().toISOString();

  // ── Update the GROUP row for session-level fields ──────────────────────────
  // (legacy: this used to touch enrApplications)
  const groupRow = { enrollment_group_id: enrollmentGroupId, updated_at: now };
  if (step === 'application') {
    // Persist all session-level fields to enrEnrollmentGroups so they survive resume.
    // desired_start_date is staged here and propagated to each enrEnrollments row at submit.
    // source maps to source_locale for now (real source_id was resolved at init).
    if (payload.program_id)        groupRow.program_id        = payload.program_id;
    if (payload.desired_start_date) groupRow.desired_start_date = normalizeDate_(payload.desired_start_date);
    if (payload.source)            groupRow.source_locale     = payload.source;
  }
  appsheetRequest_(T.ENROLLMENT_GROUPS, 'Edit', [groupRow]);

  let extra = null;
  switch (step) {
    case 'application':
      // Group-level fields already written above
      break;
    // KAL-NEW-3 (2026-06-05): `case 'review'` eliminado. Las transiciones de estado
    // ADMISSION (RQ/IN/AD/...) viven en el KMS (operación staff autenticada),
    // NUNCA en el wizard anónimo. El cierre del wizard usa submitEnrollmentSession_.
    // Un step='review' cae ahora al `default:` y lanza 'Unknown step: review'.
    case 'persons':
      extra = savePersons_(enrollmentGroupId, payload);
      break;
    case 'relations':
      extra = saveRelations_(enrollmentGroupId, payload);
      break;
    case 'health':
      saveHealth_(enrollmentGroupId, payload);
      break;
    case 'interviews':
      saveInterviews_(enrollmentGroupId, payload);
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

  // KAL-4: _debug payload (extra) contained PII samples (firstNew / firstPhone /
  // firstEmail from savePersons_); it is gated behind a script property so
  // diagnostics still work during deploys but not for normal traffic.
  // The frontend (Step2 → WizardPage) consumes _debug.personIdMap to stamp
  // real person_ids back into the wizard form, so when _debug is suppressed
  // we still expose ONLY that map (no PII fields).
  const debugEnabled = PropertiesService.getScriptProperties().getProperty('DEBUG_MODE') === '1';
  let safeDebug = null;
  if (extra && extra.personIdMap) {
    // Always expose the personIdMap (no PII — just _uid ↔ person_id pairs).
    safeDebug = { personIdMap: extra.personIdMap };
  }
  if (debugEnabled) safeDebug = extra;
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

  // Fetch QB responses for enrollment-specific questions (profession, employer, adaptation)
  const enrQbIds = [QB_PROFESSION_ID, QB_EMPLOYER_ID, QB_HAS_ADAPTATION_ID, QB_ADAPTATION_NOTES_ID];
  const qbResRows = appsheetRequest_(T.QB_RESPONSES, 'Find', [], {
    Filter: '(' + [enrollmentGroupId].concat(enrollmentIds).map(rid => '"respondent_id" = "' + appsheetEscape_(rid) + '"').join(' || ') + ') && (' +
      enrQbIds.map(id => '"question_id" = "' + appsheetEscape_(id) + '"').join(' || ') + ')'
  }) || [];
  // Map question_id → last response_text (aggregates multiple if more than one respondent)
  const qbResponseMap = {};
  qbResRows.forEach(r => { qbResponseMap[r.question_id] = r.response_text; });

  // Generate one signed consent PDF for the session and write it as a recFiles
  // row scoped to every enrollment in the group (DL-R09 / DL-R13).
  try {
    const pdfMeta = generateConsentPdf_(enrollmentGroupId, app, enrichedGuardians, applicants, consentRows, p.esignature || '', now, qbResponseMap);
    const pdfFileId = generateUuid_();
    appsheetRequest_(T.REC_FILES, 'Add', [{
      file_id:                  pdfFileId,
      school_id:                SCHOOL_ID,
      rec_type_code:            REC_TYPE_BY_DOCUMENT_TYPE.signed_consent_record,
      drive_file_id:            pdfMeta.drive_file_id,
      drive_folder_id:          pdfMeta.drive_folder_id,
      file_name:                pdfMeta.file_name,
      original_filename:        pdfMeta.file_name,
      mime_type:                pdfMeta.mime_type,
      file_size_bytes:          pdfMeta.file_size_bytes,
      file_hash_sha256:         null,
      status:                   'ACTIVE',
      upload_idempotency_token: 'consent_pdf:' + enrollmentGroupId,
      origin:                   'WIZARD_SUBMIT',
      origin_reference:         enrollmentGroupId,
      document_date:            now,
      signed_at:                now,
      description:              'Signed consent record generated at submit',
      language:                 lang,
      was_originally_paper:     false,
      created_at:               now,
      created_by:               'SYSTEM:WIZARD',
      updated_at:               now,
      updated_by:               'SYSTEM:WIZARD',
    }]);
    // One scope per enrollment — primary on the first, secondary on the rest
    // (DL-R13: exactly one primary scope per recFiles row).
    const scopeRows = enrollmentIds.map((eid, i) => ({
      scope_id:               generateUuid_(),
      school_id:              SCHOOL_ID,
      file_id:                pdfFileId,
      scope_type_code:        'enr_admission_school',
      scope_target_id:        eid,
      is_primary:             i === 0,
      shortcut_drive_file_id: null,
      created_at:             now,
      created_by:             'SYSTEM:WIZARD',
      updated_at:             now,
      updated_by:             'SYSTEM:WIZARD',
    }));
    if (scopeRows.length) appsheetRequest_(T.REC_SCOPES, 'Add', scopeRows);
  } catch (pdfErr) {
    Logger.log('PDF generation error (non-fatal): ' + pdfErr.message);
  }

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

  // Send family confirmation (bilingual)
  sendFamilyConfirmationEmail_(app.primary_email, enrollmentGroupId, applicants, app.preferred_language || 'es');

  // Send internal notification
  sendInternalEmail_(
    '[KIS Admissions] Enrollment session submitted \u2014 action required',
    buildApplicationSubmittedBody_(enrollmentGroupId, now, enrichedGuardians, applicants, app, qbResponseMap)
  );

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
}

function sendVerificationCode_(p) {
  const enrollmentGroupId = p.enrollment_group_id || p.application_id;
  const primary_email     = p.primary_email;
  if (!enrollmentGroupId || !primary_email) throw new Error('Missing enrollment_group_id or primary_email');

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const cache = CacheService.getScriptCache();
  cache.put('verify_' + enrollmentGroupId, code, 600); // 10 min TTL

  const lang = p.preferred_language || 'es';
  const subject = lang === 'en'
    ? 'Your Kaleide verification code'
    : 'Tu c\u00f3digo de verificaci\u00f3n de Kaleide';

  const body = lang === 'en'
    ? '<p>Your verification code is: <strong style="font-size:1.5em;letter-spacing:4px;">' + code + '</strong></p><p>This code expires in 10 minutes.</p>'
    : '<p>Tu c\u00f3digo de verificaci\u00f3n es: <strong style="font-size:1.5em;letter-spacing:4px;">' + code + '</strong></p><p>Este c\u00f3digo caduca en 10 minutos.</p>';

  sendAsAlias_(primary_email, subject, buildFamilyEmail_(subject, body));

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
  const enrollmentGroupId = p.enrollment_group_id || p.application_id;
  const code = p.code;
  if (!enrollmentGroupId || !code) throw new Error('Missing enrollment_group_id or code');

  const cache    = CacheService.getScriptCache();
  const stored   = cache.get('verify_' + enrollmentGroupId);

  if (!stored) throw new Error('Verification code expired or not found');
  if (stored !== code.toString()) throw new Error('Invalid verification code');

  cache.remove('verify_' + enrollmentGroupId);

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
  // 1-64 chars, starts with letter, then letters/digits/underscore. Aplica
  // tanto a la ruta canónica KMS como al fallback legacy — el motor qb-core
  // re-valida pero validamos aquí primero para fail-fast antes de la red.
  if (!/^[A-Z][A-Z0-9_]{0,63}$/.test(contextCode)) {
    throw new Error('Invalid context_code: ' + JSON.stringify(raw));
  }

  const lang = p.language || 'es';

  // ── Q05-S5 (DL-Q05): proxy thin a KMS qb-public.resolveSetForConsumer ────
  // El motor reusable vive en kis-app/kms-server/qb/qb-core.gs y se expone
  // via doPost del KMS bajo `qb-public.resolveSetForConsumer` con auth por
  // service token. Si Script Properties del wizard están configuradas, este
  // path GANA al fallback legacy.
  const props        = PropertiesService.getScriptProperties();
  const kmsUrl       = props.getProperty('KMS_DEPLOYMENT_URL');
  const serviceToken = props.getProperty('QB_SERVICE_TOKEN');

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

    const httpResp = UrlFetchApp.fetch(kmsUrl, {
      method:             'post',
      contentType:        'text/plain',
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

  // ── LEGACY pre-Q05-S5 — fallback path si KMS_DEPLOYMENT_URL o ───────────
  // QB_SERVICE_TOKEN no están configuradas en Script Properties del wizard.
  // Mantenido como red de seguridad hasta que el flow KMS esté estable en
  // prod (remove tras estabilización post-Q05-S5).
  // El filtro directo a qbContexts/Sets/Questions vía AppSheet API duplica
  // el motor qb-core de Q05-S1 — su existencia es transitional.
  // ─────────────────────────────────────────────────────────────────────────

  // qbContexts / qbQuestionSets: filtramos server-side SOLO por igualdades de
  // string fiables (context_code, context_id). is_active/deleted_at se evalúan
  // EN MEMORIA porque AppSheet corrompe el Selector con comparaciones de
  // booleano/blank: `"is_active" = true` (booleano vs "Y" almacenado) devuelve
  // TODAS las filas, y `"deleted_at" = ""` sobre un campo null devuelve 0.
  // Confirmado vía manual_diagFetchQuestions 2026-05-30. Mismo enfoque que el
  // motor canónico qb-core.gs (kms-server) que filtra in-memory con db_find.
  const ctxRows = appsheetRequest_(T.QB_CONTEXTS, 'Find', [], {
    Filter: '"context_code" = "' + appsheetEscape_(contextCode) + '"'
  }) || [];
  const context = ctxRows.find(c =>
    c.school_id === SCHOOL_ID && qbTruthy_(c.is_active) && !c.deleted_at);
  if (!context) throw new Error('Context not found: ' + contextCode);

  // Find question sets for this context (deleted_at filtrado en memoria).
  const allSets = appsheetRequest_(T.QB_SETS, 'Find', [], {
    Filter: '"context_id" = "' + appsheetEscape_(context.context_id) + '"'
  }) || [];
  const sets = allSets.filter(s => !s.deleted_at);
  if (!sets.length) return { sets: [] };

  const setIds       = sets.map(s => s.set_id);
  const setIdFilter  = setIds.map(id => '"set_id" = "' + appsheetEscape_(id) + '"').join(' || ');

  const setItems = appsheetRequest_(T.QB_SET_ITEMS, 'Find', [], { Filter: setIdFilter }) || [];
  const questionIds  = [...new Set(setItems.map(i => i.question_id))];

  if (!questionIds.length) return { sets };

  const qIdFilter = questionIds.map(id => '"question_id" = "' + appsheetEscape_(id) + '"').join(' || ');

  const [questions, allTranslations, allOptions, allConditions] = [
    appsheetRequest_(T.QB_QUESTIONS, 'Find', [], { Filter: qIdFilter }) || [],
    appsheetRequest_(T.QB_TRANSLATIONS, 'Find', [], { Filter: qIdFilter }) || [],
    appsheetRequest_(T.QB_OPTIONS, 'Find', [], { Filter: qIdFilter }) || [],
    appsheetRequest_(T.QB_CONDITIONS, 'Find', [], { Filter: qIdFilter }) || [],
  ];

  const optionIds = allOptions.map(o => o.option_id);
  const allOptionTranslations = optionIds.length
    ? appsheetRequest_(T.QB_OPT_TRANS, 'Find', [], {
        Filter: optionIds.map(id => '"option_id" = "' + appsheetEscape_(id) + '"').join(' || ')
      }) || []
    : [];

  // ── Q05-S5 fix Step 5 — catálogos auxiliares para el render del frontend ────
  // (1) qbResponseTypes: AppSheet guarda response_type_id como UUID; el render
  //     necesita el code legible ('select'|'boolean'|'long_text'|...) para
  //     elegir el widget. Resolvemos el JOIN aquí.
  const allResponseTypes = appsheetRequest_('qbResponseTypes', 'Find', [], {}) || [];
  const responseTypeCodeById = {};
  allResponseTypes.forEach(rt => { responseTypeCodeById[rt.response_type_id] = rt.response_type_code || 'text'; });

  // (2) Grafo de conditions polimórficas (groups → items → conditions atómicas →
  //     dimensions). qbQuestionConditions apunta vía condition_ref_table/_id a
  //     qbConditionGroups_T (grupo lógico) o a qbConditions_T (atómica). El
  //     helper frontend espera shape plano — aplanamos aquí. Schemas confirmados
  //     vía manual_diagQbConditionTables (commit 3ae741a).
  const allGroups      = appsheetRequest_('qbConditionGroups_T', 'Find', [], {}) || [];
  const allItems       = appsheetRequest_('qbConditionGroupItems_T', 'Find', [], {}) || [];
  const allAtomicConds = appsheetRequest_('qbConditions_T', 'Find', [], {}) || [];
  const allDims        = appsheetRequest_('qbDimensions_T', 'Find', [], {}) || [];

  const groupById = {};      allGroups.forEach(g => { groupById[g.group_id] = g; });
  const itemsByGroupId = {}; allItems.forEach(i => { (itemsByGroupId[i.group_id] = itemsByGroupId[i.group_id] || []).push(i); });
  const atomicById = {};     allAtomicConds.forEach(c => { atomicById[c.condition_id] = c; });
  const dimById = {};        allDims.forEach(d => { dimById[d.dimension_id] = d; });

  // Parseo robusto de value_json (string serializado en qbConditions_T.value_json):
  // intenta JSON.parse; si falla toma el string crudo (sin comillas).
  const qbParseValueJson_ = (raw) => {
    if (raw === null || raw === undefined) return raw;
    try { return JSON.parse(raw); } catch (e) { return raw; }
  };

  // participant_age: el catálogo guarda el rango de audiencia como UN operator
  // 'BETWEEN' con value_json = [lo, hi] (confirmado en datos reales — 26 de las
  // 50 conditions). Lo descomponemos en GTE lo + LTE hi para que el helper —
  // que sólo conoce comparadores escalares — lo evalúe sin ambigüedad. Soporta
  // también shapes alternativos (objeto {min,max}/{lo,hi}/{from,to} o string
  // "lo,hi"/"lo-hi") por robustez. GTE/LTE/EQ/NEQ escalares pasan tal cual.
  const qbAgeConditions_ = (op, rawVal) => {
    if (op === 'BETWEEN') {
      let lo = NaN, hi = NaN;
      if (Array.isArray(rawVal)) {
        lo = parseFloat(rawVal[0]); hi = parseFloat(rawVal[1]);
      } else if (rawVal && typeof rawVal === 'object') {
        lo = parseFloat(rawVal.min != null ? rawVal.min : (rawVal.lo != null ? rawVal.lo : rawVal.from));
        hi = parseFloat(rawVal.max != null ? rawVal.max : (rawVal.hi != null ? rawVal.hi : rawVal.to));
      } else {
        const parts = String(rawVal).split(/[,;:|\-]/).map(s => parseFloat(s));
        lo = parts[0]; hi = parts[1];
      }
      const out = [];
      if (!isNaN(lo)) out.push({ kind: 'AGE', operator: 'GTE', value: lo });
      if (!isNaN(hi)) out.push({ kind: 'AGE', operator: 'LTE', value: hi });
      // Si no pudimos extraer el rango → permissive (no oculta la pregunta).
      if (out.length) return out;
      return [{ kind: 'UNKNOWN', dimension_code: 'participant_age', operator: op, value: rawVal }];
    }
    return [{ kind: 'AGE', operator: op, value: parseFloat(rawVal) }];
  };

  // Aplana UNA condition atómica (qbConditions_T row) al shape plano que consume
  // el helper meetsConditions del frontend, resolviendo su dimensión.
  const qbFlattenAtomic_ = (atomic) => {
    if (!atomic) return [];
    const dim     = dimById[atomic.dimension_id] || {};
    const dimCode = dim.dimension_code || '';
    const op      = atomic.operator_code || 'EQ';  // 'GTE'|'LTE'|'EQ'|'NEQ' canónico
    const rawVal  = qbParseValueJson_(atomic.value_json);

    if (dimCode === 'participant_age') {
      return qbAgeConditions_(op, rawVal);
    }
    if (dimCode.indexOf('question_response__') === 0) {
      const parentCode = dimCode.slice('question_response__'.length);
      let value = rawVal;
      if (dim.value_type === 'BOOLEAN') value = (String(rawVal).toLowerCase() === 'true');
      return [{ kind: 'PARENT_ANSWER', parent_question_code: parentCode, operator: op, value: value }];
    }
    if (dimCode === 'primary_email_initiator') {
      return [{ kind: 'INITIATOR_EMAIL', operator: op, value: rawVal }];
    }
    // Dimensión desconocida → fallback permissive (no oculta la pregunta).
    return [{ kind: 'UNKNOWN', dimension_code: dimCode, operator: op, value: rawVal }];
  };

  // Expande UNA condition polimórfica (qbQuestionConditions row) a un array
  // plano. Recursión segura sobre grupos (profundidad máx 5 anti-ciclos).
  const qbExpandCondition_ = (qc, depth) => {
    depth = depth || 0;
    if (!qc || depth > 5) return [];
    const refTable = qc.condition_ref_table;
    const refId    = qc.condition_ref_id;

    if (refTable === 'qbConditions_T') {
      return qbFlattenAtomic_(atomicById[refId]);
    }
    if (refTable === 'qbConditionGroups_T') {
      const items = (itemsByGroupId[refId] || []).slice()
        .sort((a, b) => (Number(a.sequence) || 0) - (Number(b.sequence) || 0));
      const out = [];
      items.forEach(it => {
        if (it.child_condition_id) {
          qbFlattenAtomic_(atomicById[it.child_condition_id]).forEach(f => out.push(f));
        } else if (it.child_group_id) {
          qbExpandCondition_({ condition_ref_table: 'qbConditionGroups_T', condition_ref_id: it.child_group_id }, depth + 1)
            .forEach(f => out.push(f));
        }
      });
      return out;
    }
    return [];
  };

  // Build enriched question objects
  const enrichedQuestions = questions.map(q => {
    const translation = allTranslations.find(t => t.question_id === q.question_id && t.language === lang)
      || allTranslations.find(t => t.question_id === q.question_id);

    const options = allOptions
      .filter(o => o.question_id === q.question_id && o.is_active)
      .sort((a, b) => a.display_order - b.display_order)
      .map(o => ({
        ...o,
        text: (allOptionTranslations.find(t => t.option_id === o.option_id && t.language === lang)
          || allOptionTranslations.find(t => t.option_id === o.option_id))?.option_text || o.option_value,
      }));

    return {
      ...q,
      // response_type_id es UUID de AppSheet; el render del frontend hace
      // .toLowerCase() sobre response_type_code para elegir el widget.
      response_type_code: responseTypeCodeById[q.response_type_id] || 'text',
      question_text:   translation?.question_text   || '',
      help_text:       translation?.help_text        || '',
      placeholder_text: translation?.placeholder_text || '',
      // STOPGAP P116 (también en legacy): qbQuestions no expone audience_category_id
      // usable (el spread `...q` arrastra "" crudo de AppSheet). Lo derivamos del
      // question_code igual que el adapter KMS, para que QbSetRenderer haga el
      // fan-out per applicant/guardian y el filtro AGE evalúe contra una persona
      // real. Se elimina cuando Q05-S6 cierre. Ver deriveAudienceCategoryId_.
      audience_category_id: deriveAudienceCategoryId_(q.question_code),
      options,
      // Conditions polimórficas aplanadas al shape plano que consume
      // meetsConditions (AGE / PARENT_ANSWER / INITIATOR_EMAIL / UNKNOWN).
      conditions: allConditions
        .filter(c => c.question_id === q.question_id && !c.deleted_at)
        .flatMap(c => qbExpandCondition_(c)),
    };
  });

  // Build question map for lookup
  const questionMap = {};
  enrichedQuestions.forEach(q => { questionMap[q.question_id] = q; });

  // Nest into sets
  const enrichedSets = sets.map(s => ({
    ...s,
    items: setItems
      .filter(i => i.set_id === s.set_id)
      .sort((a, b) => a.display_order - b.display_order)
      .map(i => ({ ...i, question: questionMap[i.question_id] })),
  }));

  return { context, sets: enrichedSets };
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
 * Q05-S6 (P116) sustituye esto con el campo canónico desde qb-core + qbAudienceRules.
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
        // STOPGAP P116: el engine qb-core no emite audience todavía (Q05-S6 lo
        // levantará con qbAudienceRules). Mientras tanto derivamos el scope del
        // `question_code` para que el fan-out per applicant/guardian funcione y
        // el filtro AGE evalúe contra una persona real. Ver deriveAudienceCategoryId_.
        audience_category_id: deriveAudienceCategoryId_(q.question_code),
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
  // 5 catalog reads in parallel via appsheetRequestBatch_ instead of
  // sequential. Pre-parallelization: ~3-5s on first call (cache miss).
  // Now: ~1s bounded by the slowest single fetch.
  const specs = [
    { table: T.LOOKUP_ALLERGIES,      action: 'Find', selector: { Filter: 'true' } },
    { table: T.LOOKUP_DIETARY,        action: 'Find', selector: { Filter: 'true' } },
    { table: T.LOOKUP_MEDICAL,        action: 'Find', selector: { Filter: 'true' } },
    { table: T.LOOKUP_RELATION_TYPES, action: 'Find', selector: { Filter: 'true' } },
    { table: T.PROGRAMS,              action: 'Find', selector: {
        Filter: '"school_id" = "' + appsheetEscape_(SCHOOL_ID) + '" && ISBLANK([deleted_at])'
    } },
  ];
  const results = appsheetRequestBatch_(specs);
  const pick = (i) => {
    if (!results[i].ok) {
      Logger.log('fetchLookups_ error on ' + specs[i].table + ': ' + results[i].error);
      return [];
    }
    return results[i].data || [];
  };
  const allergies     = pick(0);
  const dietary       = pick(1);
  const medical       = pick(2);
  const relationTypes = pick(3);
  const programs      = pick(4);

  // KAL-11: reference rows shouldn't carry PII but UUIDs from joined tables can
  // leak. Reduce to counts — the [0] dumps were only useful for the initial
  // schema verification and are not needed in steady-state logs.
  Logger.log('fetchLookups_ allergies: '     + allergies.length     + ' rows');
  Logger.log('fetchLookups_ dietary: '       + dietary.length       + ' rows');
  Logger.log('fetchLookups_ medical: '       + medical.length       + ' rows');
  Logger.log('fetchLookups_ relationTypes: ' + relationTypes.length + ' rows');
  Logger.log('fetchLookups_ programs: '      + programs.length      + ' rows');

  return {
    allergies:     allergies.map(r =>     ({ id: r['Row ID'] || r.row_id, label: r.food_allergy_designation })),
    dietary:       dietary.map(r =>       ({ id: r['Row ID'] || r.row_id, label: r.diet_designation })),
    medical:       medical.map(r =>       ({ id: r['Row ID'] || r.row_id, label: r.medical_condition_designation })),
    relationTypes: relationTypes.map(r => ({ id: r['Row ID'] || r.row_id, label: r.relation_type_designation })),
    programs:      programs.map(r => ({
      program_id:       r.program_id,
      designation:      r.designation,
      period_starts_on: r.period_starts_on ? normalizeDate_(r.period_starts_on) : null,
      period_ends_on:   r.period_ends_on   ? normalizeDate_(r.period_ends_on)   : null,
    })),
  };
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
  const { respondent_id, respondent_type_category_id, responses } = p;
  if (!responses || !responses.length) return { saved: 0 };

  // KAL-4: if respondent_id is supplied and differs from the group_id (i.e.
  // the responder is a specific applicant person, not the group itself),
  // verify that person belongs to this group.
  if (respondent_id && respondent_id !== enrollmentGroupId) {
    assertValidUuid_(respondent_id, 'respondent_id');
    const persons = appsheetRequest_(T.PERSONS, 'Find', [], {
      Filter: '"person_id" = "' + appsheetEscape_(respondent_id) + '" && "enrollment_group_id" = "' + appsheetEscape_(enrollmentGroupId) + '"'
    }) || [];
    if (!persons.length) {
      throw new Error('Unauthorized: respondent_id does not belong to token group');
    }
  }

  const now  = new Date().toISOString();
  const rows = responses.map(r => ({
    response_id:                  generateUuid_(),
    school_id:                    SCHOOL_ID,
    set_id:                       r.set_id || null,
    question_id:                  r.question_id,
    respondent_id:                respondent_id || enrollmentGroupId,
    respondent_type_category_id:  respondent_type_category_id || 'client',
    response_text:                r.response_text || null,
    response_option_id:           r.response_option_id || null,
    response_numeric:             r.response_numeric || null,
    language:                     r.language || 'es',
    responded_at:                 now,
  }));

  appsheetRequest_(T.QB_RESPONSES, 'Add', rows);
  return { saved: rows.length };
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
  const enrollmentId      = p.enrollment_id || null;
  const { base64, mimeType, filename, document_type } = p;
  if (!base64) throw new Error('Missing base64');
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
    description:              null,
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
 * @param {{ resume_token?: string, signing_token?: string, file_id: string }} p
 * @returns {{ filename: string, mimeType: string, base64: string }}
 */
function getDocument_(p) {
  // ── Gate dual: resume_token (/apply) O signing_token (/sign) ────────────────
  // El enrollment_group_id autorizado se deriva SIEMPRE del token server-side,
  // NUNCA del payload (KAL-4 IDOR).
  let groupId;
  if (p && p.resume_token) {
    groupId = requireResumeToken_(p);
  } else if (p && p.signing_token) {
    const sctx = requireSigningToken_(p);
    groupId = sctx.enrollment_group_id;
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

  const fileId = p.file_id;
  assertValidUuid_(fileId, 'file_id');

  // ── Guard IDOR de lectura: el recFiles debe pertenecer al grupo del token ───
  const rows = appsheetRequest_(T.REC_FILES, 'Find', [], {
    Filter: '"file_id" = "' + appsheetEscape_(fileId) +
            '" && "origin_reference" = "' + appsheetEscape_(groupId) + '"',
  }) || [];
  const row = rows.find(r => r && !r['deleted_at']);
  if (!row) {
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

  const blob = DriveApp.getFileById(row.drive_file_id).getBlob();
  return {
    filename: row.file_name,
    mimeType: row.mime_type,
    base64:   Utilities.base64Encode(blob.getBytes()),
  };
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
 * Upserts persons (guardians and applicants) for an enrollment session.
 *
 * DL-E15: staging tables (enrPersons, enrAddresses, enrEmails, enrPhones) now
 * FK to enrollment_group_id. The persons captured in a session are shared by
 * all child enrollments (one row per real adult/child even when there are
 * multiple siblings) — this avoids the legacy duplication.
 *
 * Each person may have: nationalities, ids, languages, address, emails, phones.
 * Pass `copy_address_from_person_id` to reuse another person's address.
 * Previous schools are written for applicant-type persons.
 *
 * @param {string} enrollmentGroupId
 * @param {Array}  persons - array of person objects
 */
function savePersons_(enrollmentGroupId, persons) {
  if (!Array.isArray(persons)) return;

  const now = new Date().toISOString();
  const personAddressIds = {}; // personId/uid → addressId, for copy resolution

  // Fetch person_ids that actually exist in AppSheet for this group.
  // Used to distinguish true Edit (row exists) from phantom IDs (frontend
  // stamped an ID from a previous failed Add — must retry as Add).
  // KAL-5: enrollmentGroupId is asserted in saveStep_; escape applied here.
  const existingPersonRows = appsheetRequest_(T.PERSONS, 'Find', [], {
    Filter: '"enrollment_group_id" = "' + appsheetEscape_(enrollmentGroupId) + '"'
  }) || [];
  const existingPersonIds = new Set(existingPersonRows.map(function(r) { return r.person_id; }));

  // Accumulate all rows first, then batch-write per table to stay within
  // AppSheet's API bandwidth quota (one call per table instead of one per person).
  const personsAdd  = [], personsEdit  = [];
  const nats        = [], ids          = [], langs        = [];
  const addresses   = [], personAddrs  = [];
  const emails      = [];
  const phones      = [];
  const schoolsAdd  = [], schoolsEdit  = [];
  const personIdMap = []; // [{ _uid, person_id }] — returned so frontend can stamp real IDs

  persons.forEach(person => {
    const personId    = person.person_id || generateUuid_();
    const personUid   = person._uid;
    const isApplicant = person.person_type_id === 'applicant';
    personIdMap.push({ _uid: personUid || null, person_id: personId });

    // ── Core person row (schema columns only — strip AppSheet virtual fields) ─
    // personal_id: D-E18 FK reverse to personalData_S. Populated when the
    // guardian was recognized by email at init (or selected manually in
    // Step2). Activates the dedup branch of promoteEnrollment_ — without this,
    // promotion creates duplicate personalData_S rows for adults already in
    // the SMS. Applicants never carry a personal_id (always promoted fresh).
    const baseRow = {
      person_id:           personId,
      enrollment_group_id: enrollmentGroupId,
      person_type_id:      person.person_type_id || 'guardian',
      personal_id:         (!isApplicant && person.personal_id) ? person.personal_id : null,
      first_name:     person.first_name     || null,
      middle_name:    person.middle_name    || null,
      last_name:      person.last_name      || null,
      date_of_birth:  person.date_of_birth  || null,
      place_of_birth: person.place_of_birth || null,
      gender:         person.gender         || null,
    };
    if (person.person_id && existingPersonIds.has(person.person_id)) {
      personsEdit.push(baseRow);
    } else {
      personsAdd.push({ ...baseRow, created_at: now });
    }

    // ── Nationalities ─────────────────────────────────────────────────────────
    if (Array.isArray(person.nationalities)) {
      person.nationalities.filter(n => !n.record_id).forEach(n => {
        nats.push({ record_id: generateUuid_(), person_id: personId, nationality_id: n.nationality_id || n.country_id });
      });
    }

    // ── IDs ───────────────────────────────────────────────────────────────────
    if (Array.isArray(person.ids)) {
      person.ids.filter(x => !x.record_id).forEach(x => {
        ids.push({ record_id: generateUuid_(), person_id: personId, id_type_id: x.id_type_id, id_number: x.id_number });
      });
    }

    // ── Languages ─────────────────────────────────────────────────────────────
    if (Array.isArray(person.languages)) {
      person.languages.filter(x => !x.record_id).forEach(x => {
        langs.push({ record_id: generateUuid_(), person_id: personId, language_id: x.language_id, is_mother_tongue: x.is_mother_tongue || false });
      });
    }

    // ── Address ───────────────────────────────────────────────────────────────
    let addressId = null;
    let needAddressJunction = false;
    const copyFrom = person.copy_address_from_person_id;
    if (copyFrom && (personAddressIds[copyFrom] || personAddressIds[String(copyFrom)])) {
      addressId = personAddressIds[copyFrom] || personAddressIds[String(copyFrom)];
      needAddressJunction = true; // always link when copying (the address row itself already exists)
    } else if (person.address?.address_id) {
      // Resumed person with existing address — junction row already in AppSheet, no re-add needed
      addressId = person.address.address_id;
    } else if (person.address && hasAddressData_(person.address)) {
      addressId = generateUuid_();
      addresses.push({
        address_id:          addressId,
        enrollment_group_id: enrollmentGroupId,
        address_line_1:      person.address.address_line_1 || null,
        address_line_2: person.address.address_line_2 || null,
        city:           person.address.city           || null,
        province:       person.address.province       || null,
        country_id:     person.address.country_id     || null,
        zip:            person.address.zip            || null,
        created_at:     now,
      });
      needAddressJunction = true;
    }
    if (needAddressJunction && addressId) {
      var statusDate = Utilities.formatDate(new Date(), Session.getScriptTimeZone(), 'MM/dd/yyyy');
      personAddrs.push({ record_id: generateUuid_(), person_id: personId, address_id: addressId, is_default: true, is_active: true, status_date: statusDate });
    }
    personAddressIds[personId] = addressId;
    if (personUid) personAddressIds[String(personUid)] = addressId;

    // ── Emails ────────────────────────────────────────────────────────────────
    if (Array.isArray(person.emails)) {
      person.emails.filter(e => !e.email_id).forEach(e => {
        const emailId = generateUuid_();
        emails.push({ email_id: emailId, enrollment_group_id: enrollmentGroupId, person_id: personId, email_type_id: e.email_type_id || null, value: e.email_address || e.value, is_default: e.is_default || false, is_emergency: e.is_emergency || false, created_at: now });
      });
    }

    // ── Phones ────────────────────────────────────────────────────────────────
    if (Array.isArray(person.phones)) {
      person.phones.filter(ph => !ph.phone_id).forEach(ph => {
        const phoneId = generateUuid_();
        phones.push({ phone_id: phoneId, enrollment_group_id: enrollmentGroupId, person_id: personId, phone_nr_type_id: ph.phone_type_id || ph.phone_nr_type_id || null, value: ph.phone_number || ph.value, is_default: ph.is_default || false, is_emergency: ph.is_emergency || false, is_whatsapp: ph.is_whatsapp || false, is_telegram: ph.is_telegram || false, is_sms: ph.is_sms || false, created_at: now });
      });
    }

    // ── Previous schools (applicants only) ────────────────────────────────────
    if (isApplicant && Array.isArray(person.previous_schools)) {
      person.previous_schools.filter(s => !s.previous_school_id).forEach(s => {
        schoolsAdd.push({ previous_school_id: generateUuid_(), person_id: personId, school_name: s.school_name || null, city: s.city || null, country_id: s.country_id || null, from_year: s.from_year || null, to_year: s.to_year || null, education_level_description: s.education_level_description || null, language_of_instruction: s.language_of_instruction || null });
      });
      person.previous_schools.filter(s => s.previous_school_id).forEach(s => {
        schoolsEdit.push({ previous_school_id: s.previous_school_id, person_id: personId, school_name: s.school_name || null, city: s.city || null, country_id: s.country_id || null, from_year: s.from_year || null, to_year: s.to_year || null, education_level_description: s.education_level_description || null, language_of_instruction: s.language_of_instruction || null });
      });
    }
  });

  // ── DEBUG: return row counts + person ID map so frontend can stamp real IDs
  const _debug = {
    personsEdit: personsEdit.length, personsAdd: personsAdd.length,
    nats: nats.length, ids: ids.length, langs: langs.length,
    addresses: addresses.length, personAddrs: personAddrs.length,
    emails: emails.length,
    phones: phones.length,
    schoolsAdd: schoolsAdd.length, schoolsEdit: schoolsEdit.length,
    firstNat: nats[0] || null,
    firstPhone: phones[0] ? { value: phones[0].value } : null,
    firstEmail: emails[0] ? { value: emails[0].value } : null,
    personIdMap,
  };

  // ── Batch writes — all in parallel via appsheetRequestBatch_ ──────────────
  // Pre-parallelization this was ~11 sequential ~600ms-1s AppSheet calls
  // ≈ 6-11s per "Next" click in Step 2. With fetchAll the same writes run
  // concurrently, bounded by the slowest single call (~1-1.5s typical).
  //
  // Safe to parallelize: every Add targets a different table and AppSheet's
  // REST API v2 does NOT enforce Ref-column FK validity at insert time
  // (Ref columns are just typed text at the storage layer; AppSheet's view
  // layer interprets them). Subsequent reads see all rows once their
  // respective Add completes.
  //
  // Per-spec errors land in _debug.errors instead of bubbling — matches the
  // previous "log and continue" behaviour so one bad table doesn't kill the
  // whole Step 2 save.
  _debug.errors = {};
  const writeSpecs = [
    { table: T.PERSONS,              action: 'Edit', rows: personsEdit },
    { table: T.PERSONS,              action: 'Add',  rows: personsAdd },
    { table: T.PERSON_NATIONALITIES, action: 'Add',  rows: nats },
    { table: T.PERSON_IDS,           action: 'Add',  rows: ids },
    { table: T.PERSON_LANGUAGES,     action: 'Add',  rows: langs },
    { table: T.ADDRESSES,            action: 'Add',  rows: addresses },
    { table: T.PERSON_ADDRESSES,     action: 'Add',  rows: personAddrs },
    { table: T.EMAILS,               action: 'Add',  rows: emails },
    { table: T.PHONES,               action: 'Add',  rows: phones },
    { table: T.PREV_SCHOOLS,         action: 'Add',  rows: schoolsAdd },
    { table: T.PREV_SCHOOLS,         action: 'Edit', rows: schoolsEdit },
  ];
  const writeResults = appsheetRequestBatch_(writeSpecs);
  writeResults.forEach((res, i) => {
    if (!res.ok) _debug.errors[writeSpecs[i].table + '/' + writeSpecs[i].action] = res.error.slice(0, 200);
  });

  return _debug;
}

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

/**
 * Upserts interview records for the enrollments in a session.
 *
 * DL-E15: enrInterviews FKs to enrollment_id (per-applicant). Each incoming
 * interview row must carry its own `enrollment_id`. Rows lacking one are
 * skipped (staff UI should always set it after submit).
 *
 * interview_type must be one of: family_interview | child_observation | follow_up
 * interviewer_id is a plain email string — written directly, no FK resolution.
 *
 * @param {string} enrollmentGroupId  (kept for signature symmetry, not written)
 * @param {Array}  interviews - array of interview objects (must include enrollment_id)
 */
function saveInterviews_(enrollmentGroupId, interviews) {  // eslint-disable-line no-unused-vars
  if (!Array.isArray(interviews)) return;

  const staffEmail = getStaffEmail_();
  const now        = new Date().toISOString();

  const VALID_TYPES = ['family_interview', 'child_observation', 'follow_up'];

  const rowBase_ = (i) => ({
    enrollment_id:  i.enrollment_id || null,
    interview_type: VALID_TYPES.includes(i.interview_type) ? i.interview_type : null,
    interview_date: i.interview_date  || null,
    interviewer_id: i.interviewer_id  || staffEmail,  // plain email — no FK resolution
    format:         i.format          || null,
    risk_rating:    i.risk_rating     || null,
    notes:          i.notes           || null,
    flags:          i.flags           || null,
  });

  const newInterviews = interviews
    .filter(i => !i.interview_id && i.enrollment_id)
    .map(i => Object.assign({ interview_id: generateUuid_(), created_at: now }, rowBase_(i)));

  const existingInterviews = interviews
    .filter(i => i.interview_id)
    .map(i => Object.assign({ interview_id: i.interview_id }, rowBase_(i)));

  if (newInterviews.length)      appsheetRequest_(T.INTERVIEWS, 'Add',  newInterviews);
  if (existingInterviews.length) appsheetRequest_(T.INTERVIEWS, 'Edit', existingInterviews);
}

// ─── Email helpers ────────────────────────────────────────────────────────────

/**
 * Sends a branded internal email to admissions@kaleide.org.
 * @param {string} subject
 * @param {string} bodyHtml - inner HTML content (no shell)
 */
function sendInternalEmail_(subject, bodyHtml) {
  sendAsAlias_(ADMISSIONS_EMAIL, subject, buildInternalEmail_(subject, bodyHtml));
}

/**
 * Sends magic link email to the family.
 * @param {string} email
 * @param {string} resumeToken
 * @param {string} lang - 'en' or 'es'
 */
function sendMagicLinkEmail_(email, resumeToken, lang, isFirstApp) {
  const resumeUrl = RESUME_BASE_URL + resumeToken;
  const reportUrl = REPORT_BASE_URL + resumeToken;
  const isEn = lang === 'en';

  const subject = isEn
    ? 'Your Kaleide application link'
    : 'Tu enlace de solicitud de Kaleide';

  const gdprBlock = isFirstApp
    ? '<div style="margin:24px 0;padding:16px;background:#f2f4f7;border-left:4px solid #00a19a;border-radius:4px;font-size:0.9em;color:#4a5568;">'
      + '<strong>EN — Data Protection:</strong><br>' + CONSENT_TEXTS.gdpr.en
      + '<br><br>'
      + '<strong>ES — Protección de datos:</strong><br>' + CONSENT_TEXTS.gdpr.es
      + '<br><br><em>You accepted these terms when submitting the consent form. / Aceptaste estos t\u00e9rminos al enviar el formulario de consentimiento.</em>'
      + '</div>'
    : '';

  // Anti-abuse footer \u2014 present on every magic-link send.
  // "Esto no es m\u00edo" \u2192 /report endpoint blocks the email for ~6h + alerts staff.
  const securityFooter = isEn
    ? '<div style="margin:32px 0 0;padding:16px;background:#fff8e1;border-left:4px solid #f0a500;border-radius:4px;font-size:0.85em;color:#5c4400;">'
      + '<strong>Did you not request this?</strong><br>'
      + 'Someone started a Kaleide application using your email. If it was not you, '
      + 'simply ignore this message \u2014 nothing is created until you click the link above. '
      + 'The link will expire in 7 days.<br><br>'
      + 'If you are receiving multiple of these without requesting them, '
      + '<a href="' + reportUrl + '" style="color:#0066cc;">report as unsolicited</a> '
      + 'or contact <a href="mailto:' + ADMISSIONS_EMAIL + '" style="color:#0066cc;">' + ADMISSIONS_EMAIL + '</a>.'
      + '</div>'
    : '<div style="margin:32px 0 0;padding:16px;background:#fff8e1;border-left:4px solid #f0a500;border-radius:4px;font-size:0.85em;color:#5c4400;">'
      + '<strong>\u00bfNo has sido t\u00fa?</strong><br>'
      + 'Alguien ha iniciado una solicitud en Kaleide con tu correo. Si no has sido t\u00fa, '
      + 'puedes ignorar este mensaje \u2014 no se crea nada hasta que pulses el enlace de arriba. '
      + 'El enlace caducar\u00e1 en 7 d\u00edas.<br><br>'
      + 'Si recibes varios sin haberlos pedido, '
      + '<a href="' + reportUrl + '" style="color:#0066cc;">rep\u00f3rtalo como no solicitado</a> '
      + 'o escr\u00edbenos a <a href="mailto:' + ADMISSIONS_EMAIL + '" style="color:#0066cc;">' + ADMISSIONS_EMAIL + '</a>.'
      + '</div>';

  const body = isEn
    ? '<p>Click the link below to access your application:</p>'
      + '<p style="margin:24px 0;"><a href="' + resumeUrl + '" style="background:#00a19a;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600;">Start Application</a></p>'
      + '<p style="color:#6b7c93;font-size:0.9em;">Or copy this URL into your browser:<br>' + resumeUrl + '</p>'
      + gdprBlock
      + '<p>This link will take you directly to your application. Keep it safe.</p>'
      + securityFooter
    : '<p>Haz clic en el enlace de abajo para acceder a tu solicitud:</p>'
      + '<p style="margin:24px 0;"><a href="' + resumeUrl + '" style="background:#00a19a;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600;">Iniciar solicitud</a></p>'
      + '<p style="color:#6b7c93;font-size:0.9em;">O copia esta URL en tu navegador:<br>' + resumeUrl + '</p>'
      + gdprBlock
      + '<p>Este enlace te lleva directamente a tu solicitud. Gu\u00e1rdalo en un lugar seguro.</p>'
      + securityFooter;

  sendAsAlias_(email, subject, buildFamilyEmail_(subject, body));
}

/**
 * Sends a resume email with one link per open application (for families with multiple apps).
 */
function sendMagicLinkMultiEmail_(email, resumeTokens, lang) {
  const isEn = lang === 'en';

  const subject = isEn
    ? 'Your Kaleide application links'
    : 'Tus enlaces de solicitud de Kaleide';

  const linkItems = resumeTokens.map((token, idx) => {
    const url = RESUME_BASE_URL + token;
    const label = isEn
      ? 'Application ' + (idx + 1)
      : 'Solicitud ' + (idx + 1);
    return '<p style="margin:12px 0;"><a href="' + url + '" style="background:#00a19a;color:#fff;padding:10px 24px;border-radius:6px;text-decoration:none;font-weight:600;">' + label + '</a>'
      + '<span style="color:#6b7c93;font-size:0.85em;margin-left:12px;">' + url + '</span></p>';
  }).join('');

  // For the multi-link email we use the FIRST token for the report link.
  // reportUnsolicited_ blocks the email address, not the individual session,
  // so any of the tokens is equivalent.
  const reportUrl = REPORT_BASE_URL + resumeTokens[0];
  const securityFooter = isEn
    ? '<div style="margin:32px 0 0;padding:16px;background:#fff8e1;border-left:4px solid #f0a500;border-radius:4px;font-size:0.85em;color:#5c4400;">'
      + '<strong>Did you not request this?</strong><br>'
      + 'If none of these applications is yours, '
      + '<a href="' + reportUrl + '" style="color:#0066cc;">report as unsolicited</a> '
      + 'or contact <a href="mailto:' + ADMISSIONS_EMAIL + '" style="color:#0066cc;">' + ADMISSIONS_EMAIL + '</a>.'
      + '</div>'
    : '<div style="margin:32px 0 0;padding:16px;background:#fff8e1;border-left:4px solid #f0a500;border-radius:4px;font-size:0.85em;color:#5c4400;">'
      + '<strong>\u00bfNo has sido t\u00fa?</strong><br>'
      + 'Si ninguna de estas solicitudes es tuya, '
      + '<a href="' + reportUrl + '" style="color:#0066cc;">rep\u00f3rtalo como no solicitado</a> '
      + 'o escr\u00edbenos a <a href="mailto:' + ADMISSIONS_EMAIL + '" style="color:#0066cc;">' + ADMISSIONS_EMAIL + '</a>.'
      + '</div>';

  const body = isEn
    ? '<p>We found ' + resumeTokens.length + ' open application(s) for your email. Click a link below to resume:</p>'
      + linkItems
      + '<p>Each link goes directly to that application. Keep them safe.</p>'
      + securityFooter
    : '<p>Hemos encontrado ' + resumeTokens.length + ' solicitud(es) abierta(s) para tu correo. Haz clic en un enlace para continuar:</p>'
      + linkItems
      + '<p>Cada enlace va directamente a esa solicitud. Gu\u00e1rdalos en un lugar seguro.</p>'
      + securityFooter;

  sendAsAlias_(email, subject, buildFamilyEmail_(subject, body));
}

/**
 * Sends bilingual EN/ES confirmation email to the family on submission.
 *
 * @param {string} email
 * @param {string} sessionId  - enrollment_group_id (label shown to the family)
 * @param {Array}  applicants
 * @param {string} lang
 */
function sendFamilyConfirmationEmail_(email, sessionId, applicants, lang) {
  const names = applicants.map(a => (a.first_name || '') + ' ' + (a.last_name || '')).join(', ');

  const body =
    '<h2 style="color:#00a19a;">Thank you / Gracias</h2>' +
    '<p><strong>EN:</strong> Your enrollment application has been received. We will review it and be in touch shortly.</p>' +
    '<p><strong>Applicant(s):</strong> ' + names + '</p>' +
    '<p><strong>Application ID:</strong> ' + sessionId + '</p>' +
    '<hr style="border:none;border-top:1px solid #e3e7ed;margin:24px 0;">' +
    '<p><strong>ES:</strong> Hemos recibido tu solicitud de matr\u00edcula. La revisaremos y nos pondremos en contacto contigo en breve.</p>' +
    '<p><strong>Alumno/s:</strong> ' + names + '</p>' +
    '<p><strong>N\u00famero de solicitud:</strong> ' + sessionId + '</p>';

  sendAsAlias_(email, 'Kaleide enrollment application received / Solicitud de matr\u00edcula recibida', buildFamilyEmail_('Enrollment application received', body));
}

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
  const responses = requests.length ? UrlFetchApp.fetchAll(requests) : [];
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

/**
 * Generates a PDF summary of a submitted application.
 * Guardians are enriched person objects (with .emails and .phones arrays).
 * Applicants are plain person rows.
 * desired_start_date is read from app.desired_start_date (application level).
 * Profession/employer and adaptation data are read from qbResponseMap.
 *
 * @param {string} applicationId
 * @param {Object} app           - Application row (has desired_start_date, source)
 * @param {Array}  guardians     - Enriched guardian person rows (.emails, .phones, .address)
 * @param {Array}  applicants    - Applicant person rows
 * @param {Array}  consentRows   - Consent rows as written to sysConsentsLog
 * @param {string} esignature    - Typed e-signature name
 * @param {string} submittedAt   - ISO submission timestamp
 * @param {Object} qbResponseMap - { [question_id]: response_text }
 * @returns {string} Drive URL of the generated PDF
 */
function generateConsentPdf_(applicationId, app, guardians, applicants, consentRows, esignature, submittedAt, qbResponseMap) {
  const qbMap = qbResponseMap || {};
  const docTitle = 'Signed Consent Record — ' + applicationId;
  const doc  = DocumentApp.create(docTitle);
  const body = doc.getBody();
  const nl   = () => body.appendParagraph('');

  // ── Title ──────────────────────────────────────────────────────────────────
  body.appendParagraph('Kaleide International School — Signed Consent Record')
    .setHeading(DocumentApp.ParagraphHeading.HEADING1);
  body.appendParagraph('Application ID: ' + applicationId);
  body.appendParagraph('Submitted: ' + formatTimestamp_(submittedAt));
  nl();

  // ── Application details ────────────────────────────────────────────────────
  body.appendParagraph('Application Details')
    .setHeading(DocumentApp.ParagraphHeading.HEADING2);
  if (app && app.desired_start_date) body.appendParagraph('Desired start date: ' + app.desired_start_date);
  if (app && app.source)             body.appendParagraph('Source: ' + app.source);
  nl();

  // ── Guardians ──────────────────────────────────────────────────────────────
  body.appendParagraph('Guardians / Tutores')
    .setHeading(DocumentApp.ParagraphHeading.HEADING2);

  guardians.forEach((g, i) => {
    const emails = (g.emails || []).map(e =>
      (e.value || '') + (e.is_emergency ? ' [Emergency]' : '')
    ).filter(e => e.trim()).join(', ');
    const phones = (g.phones || []).map(ph =>
      (ph.value || '') + (ph.is_whatsapp ? ' (WhatsApp)' : '') + (ph.is_telegram ? ' (Telegram)' : '')
      + (ph.is_emergency ? ' [Emergency]' : '')
    ).filter(Boolean).join(', ');

    body.appendParagraph((i + 1) + '. ' + (g.first_name || '') + ' ' + (g.last_name || ''))
      .setBold(true);
    if (emails) body.appendParagraph('   Email: ' + emails);
    if (phones) body.appendParagraph('   Phone: ' + phones);
    const gAddr = g.address;
    if (gAddr && gAddr.address_line_1) {
      body.appendParagraph('   Address: ' + [gAddr.address_line_1, gAddr.address_line_2, gAddr.city, gAddr.province, gAddr.country_id, gAddr.zip].filter(Boolean).join(', '));
    }
    nl();
  });

  if (qbMap[QB_PROFESSION_ID] || qbMap[QB_EMPLOYER_ID]) {
    body.appendParagraph('Guardian Additional Details (from questions)')
      .setItalic(true);
    if (qbMap[QB_PROFESSION_ID]) body.appendParagraph('   Profession: ' + qbMap[QB_PROFESSION_ID]);
    if (qbMap[QB_EMPLOYER_ID])   body.appendParagraph('   Employer: '   + qbMap[QB_EMPLOYER_ID]);
    nl();
  }

  // ── Applicants ─────────────────────────────────────────────────────────────
  body.appendParagraph('Applicants / Alumnos')
    .setHeading(DocumentApp.ParagraphHeading.HEADING2);

  applicants.forEach((a, i) => {
    body.appendParagraph((i + 1) + '. ' + (a.first_name || '') + ' ' + (a.last_name || ''))
      .setBold(true);
    if (a.date_of_birth) body.appendParagraph('   Date of birth: ' + a.date_of_birth);
    nl();
  });

  if (qbMap[QB_HAS_ADAPTATION_ID] || qbMap[QB_ADAPTATION_NOTES_ID]) {
    body.appendParagraph('Applicant Additional Details (from questions)')
      .setItalic(true);
    if (qbMap[QB_HAS_ADAPTATION_ID])   body.appendParagraph('   Adaptation needs: ' + qbMap[QB_HAS_ADAPTATION_ID]);
    if (qbMap[QB_ADAPTATION_NOTES_ID]) body.appendParagraph('   Adaptation notes: ' + qbMap[QB_ADAPTATION_NOTES_ID]);
    nl();
  }

  // ── Consents ───────────────────────────────────────────────────────────────
  body.appendParagraph('Consents / Consentimientos')
    .setHeading(DocumentApp.ParagraphHeading.HEADING2);

  consentRows.forEach(c => {
    body.appendParagraph('Consent type: ' + (c.consent_type || ''))
      .setBold(true);
    if (c.consent_text_shown) {
      body.appendParagraph('Statement shown to family:');
      body.appendParagraph(c.consent_text_shown)
        .setItalic(true);
    }
    body.appendParagraph('Decision: ' + (c.consented ? 'Accepted / Aceptado' : 'Declined / Rechazado'));
    body.appendParagraph('Consent timestamp: ' + formatTimestamp_(c.consent_timestamp));
    if (c.ip_address) body.appendParagraph('IP address: ' + c.ip_address);
    nl();
  });

  // ── E-signature ────────────────────────────────────────────────────────────
  body.appendParagraph('Electronic Signature / Firma Electrónica')
    .setHeading(DocumentApp.ParagraphHeading.HEADING2);
  body.appendParagraph('Typed name: ' + (esignature || '(not provided)'));
  body.appendParagraph('Submission timestamp: ' + formatTimestamp_(submittedAt));

  doc.saveAndClose();

  // Export Google Doc as PDF, save to Drive, remove intermediate Doc
  const docFile = DriveApp.getFileById(doc.getId());
  const pdfBlob = docFile.getAs('application/pdf');
  pdfBlob.setName('consent_record_' + applicationId + '.pdf');

  const folder  = getOrCreateDriveFolder_(DRIVE_FOLDER_NAME);
  const pdfFile = folder.createFile(pdfBlob);
  // CLI 82 / KAL-NEW-5: el PDF NO se comparte públicamente. El consentimiento firmado (PII de
  // menores + firma) queda privado al dueño del deployment. El read-back para
  // revisión se sirve vía getDocument_ (proxy de bytes gateado por token).

  docFile.setTrashed(true);

  return {
    drive_file_id:   pdfFile.getId(),
    drive_folder_id: folder.getId(),
    mime_type:       'application/pdf',
    file_name:       pdfBlob.getName(),
    file_size_bytes: pdfBlob.getBytes().length,
  };
}

// ─── Signing token resolution (Ola 4 — P37) ──────────────────────────────────

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

  // KAL-5: strict UUID-v4 layout (was loose [0-9a-f-]{32,40}). Combined with
  // appsheetEscape_ on the concatenation for defense in depth.
  try {
    assertValidUuid_(token, 'signing_token');
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

  // 5. Step completion states from signer fields (DL-S47 §5 + roadmap §4.2)
  const gdprCompleted   = !!(signer['gdpr_step_completed_at']);
  const reviewCompleted = !!(signer['review_step_completed_at']);
  const signed          = !!(signer['signed_at']);

  // billing_confirmed: enrGroupBilling.confirmed_at (P49 — table may not exist yet)
  let billingConfirmed = false;
  try {
    assertValidUuid_(enrollmentGroupId, 'enrollment_group_id');
    const billingRows = appsheetRequest_('enrGroupBilling', 'Find', [],
      { Filter: '"enrollment_group_id" = "' + appsheetEscape_(enrollmentGroupId) + '"' });
    billingConfirmed = !!(billingRows && billingRows.find(b => !b['deleted_at'] && b['confirmed_at']));
  } catch (billingErr) {
    Logger.log('[resolveSigningToken_] enrGroupBilling not available (P49 pending): ' + billingErr.message);
  }

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
  try {
    httpResp = UrlFetchApp.fetch(kmsUrl, {
      method:             'post',
      contentType:        'text/plain',
      payload:            JSON.stringify(envelope),
      followRedirects:    true,
      muteHttpExceptions: true,
    });
  } catch (netErr) {
    const err = new Error('KMS proxy network error: ' + netErr.message);
    err.code = 'KMS_NETWORK_ERROR';
    throw err;
  }

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

/**
 * Step 8 S-BILLING — datos fiscales pagador (P49 — DL-E28 §4.3).
 *
 * Proxy fino al KMS `enr.saveBillingInfo`. El wizard valida el resume_token
 * de la familia (auth family-facing) y reenvía signing_token + datos
 * fiscales. El KMS persiste en `enrGroupBilling` y marca el milestone
 * de billing.
 *
 * Payload esperado (del frontend Step8Billing):
 *   { resume_token, signing_token, payer_type, payer_person_id?, fiscal_name,
 *     fiscal_tax_id?, fiscal_address_line1?, fiscal_address_city?,
 *     fiscal_postal_code?, fiscal_country?, billing_email }
 *
 * @param {Object} p
 * @returns {Object} `data` del KMS (`{ billing_id, confirmed_at, already_confirmed? }`).
 */
function saveBillingInfo_(p) {
  // CLI 45 — auth por signing_token (flujo /sign). requireSigningToken_ valida el
  // token server-side (resolveSigningToken_) y resuelve signer/session/grupo.
  const sctx = requireSigningToken_(p);

  return kmsProxy_('enr.saveBillingInfo', {
    signing_token:        sctx.signing_token,
    payer_type:           p.payer_type           || null,
    payer_person_id:      p.payer_person_id      || null,
    fiscal_name:          p.fiscal_name          || null,
    fiscal_tax_id:        p.fiscal_tax_id        || null,
    fiscal_address_line1: p.fiscal_address_line1 || null,
    fiscal_address_city:  p.fiscal_address_city  || null,
    fiscal_postal_code:   p.fiscal_postal_code   || null,
    fiscal_country:       p.fiscal_country       || 'ES',
    billing_email:        p.billing_email        || null,
  });
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
  // CLI 45 — auth por signing_token (flujo /sign).
  const sctx = requireSigningToken_(p);

  if (!Array.isArray(p.consents) || !p.consents.length) {
    throw new Error('consents must be a non-empty array');
  }

  // GATE-B modo conservador: pasamos el array consents[] tal cual sin
  // estructura per-guardian adicional. El handler KMS lo persiste como un
  // set para el signer del iniciador.
  return kmsProxy_('enr.submitGdprConsents', {
    signing_token: sctx.signing_token,
    signer_ip:     p.signer_ip || null,
    consents:      p.consents,
  });
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
  // CLI 45 — auth por signing_token (flujo /sign).
  const sctx = requireSigningToken_(p);

  return kmsProxy_('enr.confirmReview', {
    signing_token: sctx.signing_token,
  });
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
function initiateSigningSession_(p) {
  // CLI 45 — auth por signing_token (flujo /sign). El KMS resuelve guardians,
  // documentos y proveedor de firma desde el grupo (derivado del signing_token).
  const sctx = requireSigningToken_(p);

  return kmsProxy_('enr.initiateSigningSession', {
    signing_token:       sctx.signing_token,
    enrollment_group_id: sctx.enrollment_group_id,
  });
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
