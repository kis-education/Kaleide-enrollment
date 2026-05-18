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
const RESUME_BASE_URL    = 'https://admissions.kaleide.org/#/resume/';
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
//   - sysStates_T: entity_type_code='ENR_APPLICATION'. PK=state_id, code field=state_code.
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
  STATES_T:             'sysStates_T',           // universal state catalog (entity_type_code='ENR_APPLICATION')
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

      case 'promoteApplication':      // legacy alias
      case 'promoteEnrollment':       result = promoteEnrollment_(payload);       break;

      // ── Actions that keep their name (payload shape may have changed) ───────
      case 'sendMagicLink':        result = sendMagicLink_(payload);        break;
      case 'saveStep':             result = saveStep_(payload);             break;
      case 'sendVerificationCode': result = sendVerificationCode_(payload); break;
      case 'verifyEmail':          result = verifyEmail_(payload);          break;
      case 'fetchQuestions':       result = fetchQuestions_(payload);       break;
      case 'saveResponses':        result = saveResponses_(payload);        break;
      case 'uploadDocument':       result = uploadDocument_(payload);       break;
      case 'verifyRecaptcha':      result = verifyRecaptcha_(payload);      break;
      case 'fetchLookups':         result = fetchLookups_(payload);         break;
      case 'recognizeFamily':      result = recognizeFamily_(payload);      break;
      case 'diagTable':            result = diagTable_(payload);            break;
      case 'diagAllTables':        result = diagAllTables_();               break;
      default:
        return jsonResponse_({ ok: false, error: 'Unknown action: ' + action }, 400);
    }

    return jsonResponse_({ ok: true, ...result });

  } catch (err) {
    Logger.log('doPost error: ' + err.message + '\n' + err.stack);
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
  if (count >= 3) {
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

  const enrollmentGroupId = generateUuid_();
  const resumeToken       = generateUuid_();
  const now               = new Date().toISOString();
  const lang              = p.preferred_language || 'es';

  // ── Resolve source_id from enrEnrollmentSources (Capa 2 catalog) ───────────
  let sourceId = null;
  try {
    const sources = appsheetRequest_(T.ENROLLMENT_SOURCES, 'Find', [], {
      Filter: '"source_code" = "' + sourceCode + '"'
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
        Filter: '"school_id" = "' + SCHOOL_ID + '" && "program_type_code" = "ADMISSION_SCHOOL" && ISBLANK([deleted_at])'
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
    // desired_start_date NOT on enrEnrollmentGroups (propagated to enrEnrollments at submit from the request payload)
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
  // Defensive: strip double quotes to avoid mangling the AppSheet filter
  // expression. Valid emails never contain them after lowercase+trim.
  const safeEmail = email.replace(/"/g, '');
  const emailRows = appsheetRequest_('contactEmails', 'Find', [], {
    Filter: '"email" = "' + safeEmail + '"'
  }) || [];

  const personalIds = emailRows
    .map(r => r.personal_id)
    .filter((id, i, arr) => id && arr.indexOf(id) === i);
  if (!personalIds.length) {
    return { matched: false, persons: [] };
  }

  // ── personal_ids → personalData_S display fields ───────────────────────────
  const filter = personalIds.map(id => '"personal_id" = "' + id + '"').join(' || ');
  const persons = appsheetRequest_('personalData_S', 'Find', [], { Filter: filter }) || [];

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
    const rows = appsheetRequest_(T.ENROLLMENT_GROUPS, 'Find', [], {
      Filter: '"enrollment_group_id" = "' + groupId + '"'
    });
    const grp = rows && rows[0];
    if (!grp) throw new Error('Enrollment group not found');
    _checkMagicLinkRateLimit_((grp.primary_email || '').toLowerCase().trim());
    sendMagicLinkEmail_(grp.primary_email, grp.resume_token, grp.preferred_language || 'es');
  } else if (p.primary_email) {
    // Find all non-submitted sessions for this email
    const rows = appsheetRequest_(T.ENROLLMENT_GROUPS, 'Find', [], {
      Filter: '"primary_email" = "' + p.primary_email + '" && ISBLANK([submitted_at])'
    });
    if (!rows || !rows.length) throw new Error('Enrollment group not found');
    _checkMagicLinkRateLimit_(p.primary_email.toLowerCase().trim());
    const grps = rows.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const lang = grps[0].preferred_language || 'es';
    const tokens = grps.map(g => g.resume_token);
    sendMagicLinkMultiEmail_(p.primary_email, tokens, lang);
  } else {
    throw new Error('Missing enrollment_group_id or primary_email');
  }
  return { sent: true };
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
  const groups = appsheetRequest_(T.ENROLLMENT_GROUPS, 'Find', [], {
    Filter: '"resume_token" = "' + p.resume_token + '"'
  });
  if (!groups || !groups.length) throw new Error('Invalid or expired resume token');

  const group = groups[0];
  const id    = group.enrollment_group_id;

  // Per-applicant enrollment rows (empty until submit)
  const enrollments = appsheetRequest_(T.ENROLLMENTS, 'Find', [], {
    Filter: '"enrollment_group_id" = "' + id + '"'
  }) || [];

  const persons    = appsheetRequest_(T.PERSONS,       'Find', [], { Filter: '"enrollment_group_id" = "' + id + '"' }) || [];
  // DB stores from_person_id/to_person_id; add guardian_person_id/applicant_person_id aliases for frontend
  const relations  = (appsheetRequest_(T.PERSON_RELATIONS, 'Find', [], { Filter: '"context_entity_id" = "' + id + '" && "context_entity_type_code" = "ENR_APPLICATION"' }) || [])
    .map(r => ({ ...r, guardian_person_id: r.from_person_id, applicant_person_id: r.to_person_id }));
  // Documents: recFiles + recScopes (DL-R09 / DL-R13).
  // Pre-submit uploads are tracked by origin_reference=enrollment_group_id on recFiles.
  // Post-submit, the same files are scoped to each enrollment_id via recScopes.
  // We aggregate both paths so resume reflects the full document list.
  let documents = [];
  try {
    const preSubmitFiles = appsheetRequest_(T.REC_FILES, 'Find', [], {
      Filter: '"school_id" = "' + SCHOOL_ID + '" && "origin_reference" = "' + id + '"'
    }) || [];
    // De-dup by file_id and shape for frontend compatibility (drive_url, document_type)
    const fileById = {};
    preSubmitFiles.forEach(f => { fileById[f.file_id] = f; });
    documents = Object.values(fileById).map(f => ({
      document_id:   f.file_id,
      file_id:       f.file_id,
      document_type: _docTypeFromRecType_(f.rec_type_code),
      drive_url:     f.drive_file_id ? ('https://drive.google.com/file/d/' + f.drive_file_id + '/view') : '',
      uploaded_at:   f.created_at,
      rec_type_code: f.rec_type_code,
      status:        f.status,
    }));
  } catch (e) {
    Logger.log('resumeSession_: recFiles read failed (non-fatal): ' + e.message);
  }

  let interviews = [];
  if (enrollments.length) {
    const eidFilter = enrollments.map(e => '"enrollment_id" = "' + e.enrollment_id + '"').join(' || ');
    interviews = appsheetRequest_(T.INTERVIEWS, 'Find', [], { Filter: eidFilter }) || [];
  }
  // qbResponses respondent_id semantics: pre-submit it is the enrollment_group_id;
  // post-submit per-applicant responses may also exist keyed to enrollment_id.
  const respondentIds = [id].concat(enrollments.map(e => e.enrollment_id));
  const responses = appsheetRequest_(T.QB_RESPONSES, 'Find', [], {
    Filter: respondentIds.map(rid => '"respondent_id" = "' + rid + '"').join(' || ')
  }) || [];

  // Normalise date fields to ISO format before sending to the frontend
  group.desired_start_date = normalizeDate_(group.desired_start_date);

  if (!persons.length) {
    return {
      group,
      application: group, // legacy alias — TODO: drop once frontend uses `group`
      enrollments,
      persons: [], relations, documents, responses, interviews
    };
  }

  const personIds = persons.map(per => per.person_id);
  const pidFilter = personIds.map(pid => '"person_id" = "' + pid + '"').join(' || ');

  const nationalities     = appsheetRequest_(T.PERSON_NATIONALITIES, 'Find', [], { Filter: pidFilter }) || [];
  const personIds_        = appsheetRequest_(T.PERSON_IDS,           'Find', [], { Filter: pidFilter }) || [];
  const languages         = appsheetRequest_(T.PERSON_LANGUAGES,     'Find', [], { Filter: pidFilter }) || [];
  const personAddrJoins   = appsheetRequest_(T.PERSON_ADDRESSES,     'Find', [], { Filter: pidFilter }) || [];
  // enrPersonEmails / enrPersonPhones deleted 2026-05-17 — person→email/phone joins unavailable.
  // Actual email/phone values still stored in enrEmails/enrPhones by enrollment_group_id.
  const personEmailJoins  = [];
  const personPhoneJoins  = [];
  const prevSchools       = appsheetRequest_(T.PREV_SCHOOLS,         'Find', [], { Filter: pidFilter }) || [];
  const medical           = appsheetRequest_(T.PERSON_MEDICAL,       'Find', [], { Filter: pidFilter }) || [];
  const allergies         = appsheetRequest_(T.PERSON_ALLERGIES,     'Find', [], { Filter: pidFilter }) || [];
  const dietary           = appsheetRequest_(T.PERSON_DIETARY,       'Find', [], { Filter: pidFilter }) || [];

  // Batch-fetch address / email / phone value rows
  const addrIds  = personAddrJoins.map(r => r.address_id).filter(Boolean);
  const emailIds = personEmailJoins.map(r => r.email_id).filter(Boolean);
  const phoneIds = personPhoneJoins.map(r => r.phone_id).filter(Boolean);

  const addressMap = {};
  if (addrIds.length) {
    (appsheetRequest_(T.ADDRESSES, 'Find', [], {
      Filter: addrIds.map(x => '"address_id" = "' + x + '"').join(' || ')
    }) || []).forEach(r => { addressMap[r.address_id] = r; });
  }

  const emailMap = {};
  if (emailIds.length) {
    (appsheetRequest_(T.EMAILS, 'Find', [], {
      Filter: emailIds.map(x => '"email_id" = "' + x + '"').join(' || ')
    }) || []).forEach(r => { emailMap[r.email_id] = r; });
  }

  const phoneMap = {};
  if (phoneIds.length) {
    (appsheetRequest_(T.PHONES, 'Find', [], {
      Filter: phoneIds.map(x => '"phone_id" = "' + x + '"').join(' || ')
    }) || []).forEach(r => { phoneMap[r.phone_id] = r; });
  }

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
      emails:            personEmailJoins.filter(r => r.person_id === pid).map(r => ({ ...r, ...(emailMap[r.email_id] || {}) })),
      phones:            personPhoneJoins.filter(r => r.person_id === pid).map(r => ({ ...r, ...(phoneMap[r.phone_id] || {}) })),
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
  const enrollmentGroupId = p.enrollment_group_id || p.application_id;
  const { step, payload } = p;
  if (!enrollmentGroupId || !step || !payload) throw new Error('Missing required fields');

  const now = new Date().toISOString();

  // ── Update the GROUP row for session-level fields ──────────────────────────
  // (legacy: this used to touch enrApplications)
  const groupRow = { enrollment_group_id: enrollmentGroupId, updated_at: now };
  if (step === 'application') {
    // desired_start_date is NOT staged on enrEnrollmentGroups (column doesn't exist).
    // It propagates to each enrEnrollments row at submit time via the submit payload.
    // source maps to source_locale for now (real source_id was resolved at init).
    if (payload.program_id)  groupRow.program_id   = payload.program_id;
    if (payload.source)      groupRow.source_locale = payload.source;
  }
  // Note: `review` step no longer writes to the group — it walks enrollments below.
  appsheetRequest_(T.ENROLLMENT_GROUPS, 'Edit', [groupRow]);

  let extra = null;
  switch (step) {
    case 'application':
      // Group-level fields already written above
      break;
    case 'review': {
      // Log status transition across all enrollments in the group when a
      // status_code is supplied. Uses sysStates_T + sysStateTransitionLog (DL-S37).
      if (payload.status_code) {
        const newStateRows = appsheetRequest_(T.STATES_T, 'Find', [], {
          Filter: '"state_code" = "' + payload.status_code + '" && "school_id" = "' + SCHOOL_ID + '" && "entity_type_code" = "ENR_APPLICATION"'
        });
        const newStateId = newStateRows && newStateRows[0]
          ? newStateRows[0].state_id : null;
        if (newStateId) {
          const enrollments = appsheetRequest_(T.ENROLLMENTS, 'Find', [], {
            Filter: '"enrollment_group_id" = "' + enrollmentGroupId + '"'
          }) || [];
          enrollments.forEach(enr => {
            appsheetRequest_(T.STATE_TRANSITION_LOG, 'Add', [{
              log_id:              generateUuid_(),
              school_id:           SCHOOL_ID,
              entity_type_code:    'ENR_APPLICATION',
              entity_id:           enr.enrollment_id,
              transition_id:       null,
              from_state_id:       enr.current_state_id || null,
              to_state_id:         newStateId,
              mode_actually_used:  'MANUAL',
              transitioned_by:     getStaffEmail_() || 'SYSTEM:WIZARD',
              transitioned_at:     now,
              notes:               payload.reason || null,
              created_at:          now,
              created_by:          getStaffEmail_() || 'SYSTEM:WIZARD',
            }]);
            appsheetRequest_(T.ENROLLMENTS, 'Edit', [{
              enrollment_id:    enr.enrollment_id,
              current_state_id: newStateId,
              reviewed_by:      getStaffEmail_(),
              review_notes:     payload.review_notes || null,
              updated_at:       now,
            }]);
          });
        }
      }
      break;
    }
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

  return { saved: true, step, _debug: extra };
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
  const enrollmentGroupId = p.enrollment_group_id || p.application_id;
  if (!enrollmentGroupId) throw new Error('Missing enrollment_group_id');

  const now = new Date().toISOString();

  // Load the group header
  const groups = appsheetRequest_(T.ENROLLMENT_GROUPS, 'Find', [], {
    Filter: '"enrollment_group_id" = "' + enrollmentGroupId + '"'
  });
  const group = groups && groups[0];
  if (!group) throw new Error('Enrollment group not found');

  // ── Resolve the initial state (RQ = Requested) ─────────────────────────────
  const statusTypes = appsheetRequest_(T.STATES_T, 'Find', [], {
    Filter: '"state_code" = "RQ" && "school_id" = "' + SCHOOL_ID + '" && "entity_type_code" = "ENR_APPLICATION"'
  });
  const rqStateId = (statusTypes && statusTypes[0]) ? statusTypes[0].state_id : null;

  // ── Fetch persons captured in this group ───────────────────────────────────
  const allPersons = appsheetRequest_(T.PERSONS, 'Find', [], {
    Filter: '"enrollment_group_id" = "' + enrollmentGroupId + '"'
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

  // ── Create one enrEnrollments row per applicant ────────────────────────────
  // desired_start_date comes from the submit payload (not staged on the group).
  const desiredStartDate = p.desired_start_date || null;
  const enrollmentIds = [];
  applicants.forEach(applicant => {
    const enrollmentId = generateUuid_();
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
      submitted_at:           now,
      created_at:             now,
      updated_at:             now,
    }]);
    enrollmentIds.push(enrollmentId);

    // Per-enrollment state transition log entry (null → RQ)
    if (rqStateId) {
      appsheetRequest_(T.STATE_TRANSITION_LOG, 'Add', [{
        log_id:             generateUuid_(),
        school_id:          SCHOOL_ID,
        entity_type_code:   'ENR_APPLICATION',
        entity_id:          enrollmentId,
        transition_id:      null,
        from_state_id:      null,
        to_state_id:        rqStateId,
        mode_actually_used: 'AUTOMATIC',
        transitioned_by:    'SYSTEM:WIZARD',
        transitioned_at:    now,
        notes:              'Enrollment requested by family',
        created_at:         now,
        created_by:         'SYSTEM:WIZARD',
      }]);
    }
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
        entity_type_code:       'ENR_APPLICATION',
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
      Filter: gEmailIds.map(x => '"email_id" = "' + x + '"').join(' || ')
    }) || []).forEach(r => { gEmailMap[r.email_id] = r; });
  }
  const gPhoneMap = {};
  if (gPhoneIds.length) {
    (appsheetRequest_(T.PHONES, 'Find', [], {
      Filter: gPhoneIds.map(x => '"phone_id" = "' + x + '"').join(' || ')
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
    Filter: '(' + [enrollmentGroupId].concat(enrollmentIds).map(rid => '"respondent_id" = "' + rid + '"').join(' || ') + ') && (' +
      enrQbIds.map(id => '"question_id" = "' + id + '"').join(' || ') + ')'
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
        Filter: '"school_id" = "' + SCHOOL_ID + '" && "origin" = "WIZARD" && "origin_reference" = "' + enrollmentGroupId + '"'
      }) || [];
      const newScopes = [];
      preSubmitFiles.forEach(f => {
        // Skip any file that already has a scope (idempotency on retry)
        const existing = appsheetRequest_(T.REC_SCOPES, 'Find', [], {
          Filter: '"school_id" = "' + SCHOOL_ID + '" && "file_id" = "' + f.file_id + '"'
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

  GmailApp.sendEmail(primary_email, subject, '', {
    htmlBody: buildFamilyEmail_(subject, body),
    name: 'Kaleide International School',
  });

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
 * Fetches a question set with all translations, options, and conditions.
 * @param {Object} p - { context_designation, language }
 * @returns {Object} Nested question set structure
 */
function fetchQuestions_(p) {
  const { context_designation, language } = p;
  if (!context_designation) throw new Error('Missing context_designation');

  const lang = language || 'es';

  // Find matching context
  const contexts = appsheetRequest_(T.QB_CONTEXTS, 'Find', [], {
    Filter: '"designation" = "' + context_designation + '" && "school_id" = "' + SCHOOL_ID + '" && "is_active" = true'
  });
  if (!contexts || !contexts.length) throw new Error('Context not found: ' + context_designation);
  const context = contexts[0];

  // Find active question sets for this context
  const sets = appsheetRequest_(T.QB_SETS, 'Find', [], {
    Filter: '"context_id" = "' + context.context_id + '" && "is_active" = true'
  });
  if (!sets || !sets.length) return { sets: [] };

  const setIds       = sets.map(s => s.set_id);
  const setIdFilter  = setIds.map(id => '"set_id" = "' + id + '"').join(' || ');

  const setItems = appsheetRequest_(T.QB_SET_ITEMS, 'Find', [], { Filter: setIdFilter }) || [];
  const questionIds  = [...new Set(setItems.map(i => i.question_id))];

  if (!questionIds.length) return { sets };

  const qIdFilter = questionIds.map(id => '"question_id" = "' + id + '"').join(' || ');

  const [questions, allTranslations, allOptions, allConditions] = [
    appsheetRequest_(T.QB_QUESTIONS, 'Find', [], { Filter: qIdFilter }) || [],
    appsheetRequest_(T.QB_TRANSLATIONS, 'Find', [], { Filter: qIdFilter }) || [],
    appsheetRequest_(T.QB_OPTIONS, 'Find', [], { Filter: qIdFilter }) || [],
    appsheetRequest_(T.QB_CONDITIONS, 'Find', [], { Filter: qIdFilter }) || [],
  ];

  const optionIds = allOptions.map(o => o.option_id);
  const allOptionTranslations = optionIds.length
    ? appsheetRequest_(T.QB_OPT_TRANS, 'Find', [], {
        Filter: optionIds.map(id => '"option_id" = "' + id + '"').join(' || ')
      }) || []
    : [];

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

    const conditions = allConditions.filter(c => c.question_id === q.question_id);

    return {
      ...q,
      question_text:   translation?.question_text   || '',
      help_text:       translation?.help_text        || '',
      placeholder_text: translation?.placeholder_text || '',
      options,
      conditions,
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
 * Fetches lookup options for health fields (allergies, dietary, medical).
 * @returns {{ allergies: Array, dietary: Array, medical: Array }}
 */
function fetchLookups_() {
  const safe = (fn) => { try { return fn() || []; } catch (e) { Logger.log('fetchLookups_ error: ' + e.message); return []; } };

  // Filter: 'true' → FILTER("table", TRUE) — explicitly requests all rows
  const allergies     = safe(() => appsheetRequest_(T.LOOKUP_ALLERGIES,      'Find', [], { Filter: 'true' }));
  const dietary       = safe(() => appsheetRequest_(T.LOOKUP_DIETARY,        'Find', [], { Filter: 'true' }));
  const medical       = safe(() => appsheetRequest_(T.LOOKUP_MEDICAL,        'Find', [], { Filter: 'true' }));
  const relationTypes = safe(() => appsheetRequest_(T.LOOKUP_RELATION_TYPES, 'Find', [], { Filter: 'true' }));
  const programs      = safe(() => appsheetRequest_(T.PROGRAMS,              'Find', [], {
    Filter: '"school_id" = "' + SCHOOL_ID + '" && ISBLANK([deleted_at])'
  }));

  Logger.log('fetchLookups_ allergies[0]: '     + JSON.stringify(allergies[0]));
  Logger.log('fetchLookups_ dietary[0]: '       + JSON.stringify(dietary[0]));
  Logger.log('fetchLookups_ medical[0]: '       + JSON.stringify(medical[0]));
  Logger.log('fetchLookups_ relationTypes[0]: ' + JSON.stringify(relationTypes[0]));
  Logger.log('fetchLookups_ programs: '         + programs.length + ' rows');

  return {
    allergies:     allergies.map(r =>     ({ id: r['Row ID'] || r.row_id, label: r.food_allergy_designation })),
    dietary:       dietary.map(r =>       ({ id: r['Row ID'] || r.row_id, label: r.diet_designation })),
    medical:       medical.map(r =>       ({ id: r['Row ID'] || r.row_id, label: r.medical_condition_designation })),
    relationTypes: relationTypes.map(r => ({ id: r['Row ID'] || r.row_id, label: r.relation_type_designation })),
    programs:      programs.map(r => ({
      program_id:       r.program_id,
      designation:      r.designation,
      period_starts_on: r.period_starts_on || null,
      period_ends_on:   r.period_ends_on   || null,
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
  const enrollmentGroupId = p.enrollment_group_id || p.application_id;
  const { respondent_id, respondent_type_category_id, responses } = p;
  if (!responses || !responses.length) return { saved: 0 };

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
 * @returns {{ file_id: string, drive_url: string, document_id: string }}
 *   (document_id is a legacy alias = file_id, kept for frontend compat)
 */
function uploadDocument_(p) {
  const enrollmentId      = p.enrollment_id || null;
  const enrollmentGroupId = p.enrollment_group_id || p.application_id || null;
  const { base64, mimeType, filename, document_type } = p;
  if (!base64) throw new Error('Missing base64');
  if (!enrollmentId && !enrollmentGroupId) throw new Error('Missing enrollment_id or enrollment_group_id');

  const idempotencyToken = p.upload_idempotency_token || generateUuid_();

  // Idempotency check — if a recFiles row already exists for this token, return it
  try {
    const existing = appsheetRequest_(T.REC_FILES, 'Find', [], {
      Filter: '"school_id" = "' + SCHOOL_ID + '" && "upload_idempotency_token" = "' + idempotencyToken + '"'
    }) || [];
    if (existing.length) {
      const row = existing[0];
      return {
        file_id:     row.file_id,
        document_id: row.file_id,
        drive_url:   row.drive_file_id ? ('https://drive.google.com/file/d/' + row.drive_file_id + '/view') : '',
      };
    }
  } catch (_) { /* non-fatal: lookup might fail on first run if cache cold */ }

  // ── Drive upload ───────────────────────────────────────────────────────────
  const blob   = Utilities.newBlob(Utilities.base64Decode(base64), mimeType, filename);
  const folder = getOrCreateDriveFolder_(DRIVE_FOLDER_NAME);
  const file   = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  const driveFileId   = file.getId();
  const driveUrl      = file.getUrl();
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
    drive_url:   driveUrl,
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

  // Accumulate all rows first, then batch-write per table to stay within
  // AppSheet's API bandwidth quota (one call per table instead of one per person).
  const personsAdd  = [], personsEdit  = [];
  const nats        = [], ids          = [], langs        = [];
  const addresses   = [], personAddrs  = [];
  const emails      = [], personEmails = [];
  const phones      = [], personPhones = [];
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
    if (person.person_id) {
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
      personAddrs.push({ record_id: generateUuid_(), person_id: personId, address_id: addressId, is_default: true });
    }
    personAddressIds[personId] = addressId;
    if (personUid) personAddressIds[String(personUid)] = addressId;

    // ── Emails ────────────────────────────────────────────────────────────────
    if (Array.isArray(person.emails)) {
      person.emails.filter(e => !e.email_id).forEach(e => {
        const emailId = generateUuid_();
        emails.push({ email_id: emailId, enrollment_group_id: enrollmentGroupId, email_type_id: e.email_type_id || null, value: e.email_address || e.value, created_at: now });
        personEmails.push({ record_id: generateUuid_(), person_id: personId, email_id: emailId, is_default: e.is_default || false, is_emergency: e.is_emergency || false });
      });
    }

    // ── Phones ────────────────────────────────────────────────────────────────
    if (Array.isArray(person.phones)) {
      person.phones.filter(ph => !ph.phone_id).forEach(ph => {
        const phoneId = generateUuid_();
        phones.push({ phone_id: phoneId, enrollment_group_id: enrollmentGroupId, phone_nr_type_id: ph.phone_type_id || ph.phone_nr_type_id || null, value: ph.phone_number || ph.value, is_whatsapp: ph.is_whatsapp || false, is_telegram: ph.is_telegram || false, created_at: now });
        personPhones.push({ record_id: generateUuid_(), person_id: personId, phone_id: phoneId, is_default: ph.is_default || false, is_emergency: ph.is_emergency || false });
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
    emails: emails.length, personEmails: personEmails.length,
    phones: phones.length, personPhones: personPhones.length,
    schoolsAdd: schoolsAdd.length, schoolsEdit: schoolsEdit.length,
    firstNat: nats[0] || null,
    firstPhone: phones[0] ? { value: phones[0].value } : null,
    firstEmail: emails[0] ? { value: emails[0].value } : null,
    personIdMap,
  };

  // ── Batch writes (one API call per table) ─────────────────────────────────
  // Each write is isolated so a failure on one table doesn't stop the others.
  // Errors are collected in _debug.errors for visibility in the dev log.
  _debug.errors = {};
  const write_ = (table, action, rows, debugOut) => {
    if (!rows.length) return;
    try { appsheetRequest_(table, action, rows, null, debugOut); }
    catch (e) { _debug.errors[table + '/' + action] = e.message.slice(0, 200); }
  };

  write_(T.PERSONS,              'Edit', personsEdit);
  write_(T.PERSONS,              'Add',  personsAdd);
  write_(T.PERSON_NATIONALITIES, 'Add',  nats,       _debug);
  write_(T.PERSON_IDS,           'Add',  ids);
  write_(T.PERSON_LANGUAGES,     'Add',  langs);
  write_(T.ADDRESSES,            'Add',  addresses);
  write_(T.PERSON_ADDRESSES,     'Add',  personAddrs);
  write_(T.EMAILS,               'Add',  emails);
  // enrPersonEmails deleted 2026-05-17 — person→email join not written
  write_(T.PHONES,               'Add',  phones);
  // enrPersonPhones deleted 2026-05-17 — person→phone join not written
  write_(T.PREV_SCHOOLS,         'Add',  schoolsAdd);
  write_(T.PREV_SCHOOLS,         'Edit', schoolsEdit);

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

  // DL-S45: sysPersonRelations is bidirectional — always insert 2 rows per pair
  // sharing the same pair_id (guardian→applicant + applicant→guardian).
  const newRelations = [];
  relations.filter(r => !r.relation_id).forEach(r => {
    const pairId = generateUuid_();
    const now    = new Date().toISOString();
    const base   = {
      school_id:                SCHOOL_ID,
      context_entity_type_code: 'ENR_APPLICATION',
      context_entity_id:        enrollmentGroupId,
      pair_id:                  pairId,
      relation_type_id:         r.relation_type_id      || null,
      is_custodial:             r.is_custodial          || false,
      is_pick_up_authorized:    r.is_pick_up_authorized || false,
      is_school_rep:            false,
      is_emergency_contact:     false,
      created_at:               now,
      created_by:               'SYSTEM:WIZARD',
    };
    newRelations.push(Object.assign({}, base, {
      relation_id:       generateUuid_(),
      from_person_table: 'enrPersons',
      from_person_id:    r.guardian_person_id || r.person_id_a,
      to_person_table:   'enrPersons',
      to_person_id:      r.applicant_person_id || r.person_id_b,
    }));
    newRelations.push(Object.assign({}, base, {
      relation_id:       generateUuid_(),
      from_person_table: 'enrPersons',
      from_person_id:    r.applicant_person_id || r.person_id_b,
      to_person_table:   'enrPersons',
      to_person_id:      r.guardian_person_id || r.person_id_a,
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
  GmailApp.sendEmail(ADMISSIONS_EMAIL, subject, '', {
    htmlBody: buildInternalEmail_(subject, bodyHtml),
    name: 'KIS Admissions System',
  });
}

/**
 * Sends magic link email to the family.
 * @param {string} email
 * @param {string} resumeToken
 * @param {string} lang - 'en' or 'es'
 */
function sendMagicLinkEmail_(email, resumeToken, lang, isFirstApp) {
  const resumeUrl = RESUME_BASE_URL + resumeToken;
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

  const body = isEn
    ? '<p>Click the link below to access your application:</p>'
      + '<p style="margin:24px 0;"><a href="' + resumeUrl + '" style="background:#00a19a;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600;">Start Application</a></p>'
      + '<p style="color:#6b7c93;font-size:0.9em;">Or copy this URL into your browser:<br>' + resumeUrl + '</p>'
      + gdprBlock
      + '<p>This link will take you directly to your application. Keep it safe.</p>'
    : '<p>Haz clic en el enlace de abajo para acceder a tu solicitud:</p>'
      + '<p style="margin:24px 0;"><a href="' + resumeUrl + '" style="background:#00a19a;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600;">Iniciar solicitud</a></p>'
      + '<p style="color:#6b7c93;font-size:0.9em;">O copia esta URL en tu navegador:<br>' + resumeUrl + '</p>'
      + gdprBlock
      + '<p>Este enlace te lleva directamente a tu solicitud. Gu\u00e1rdalo en un lugar seguro.</p>';

  GmailApp.sendEmail(email, subject, '', {
    htmlBody: buildFamilyEmail_(subject, body),
    name: 'Kaleide International School',
  });
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

  const body = isEn
    ? '<p>We found ' + resumeTokens.length + ' open application(s) for your email. Click a link below to resume:</p>'
      + linkItems
      + '<p>Each link goes directly to that application. Keep them safe.</p>'
    : '<p>Hemos encontrado ' + resumeTokens.length + ' solicitud(es) abierta(s) para tu correo. Haz clic en un enlace para continuar:</p>'
      + linkItems
      + '<p>Cada enlace va directamente a esa solicitud. Gu\u00e1rdalos en un lugar seguro.</p>';

  GmailApp.sendEmail(email, subject, '', {
    htmlBody: buildFamilyEmail_(subject, body),
    name: 'Kaleide International School',
  });
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

  GmailApp.sendEmail(email, 'Kaleide enrollment application received / Solicitud de matr\u00edcula recibida', '', {
    htmlBody: buildFamilyEmail_('Enrollment application received', body),
    name: 'Kaleide International School',
  });
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

  Logger.log('AppSheet ' + action + ' ' + table + ' → HTTP ' + statusCode + ' | ' + text.slice(0, 600));
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
  pdfFile.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  docFile.setTrashed(true);

  return {
    drive_url:       pdfFile.getUrl(),
    drive_file_id:   pdfFile.getId(),
    drive_folder_id: folder.getId(),
    mime_type:       'application/pdf',
    file_name:       pdfBlob.getName(),
    file_size_bytes: pdfBlob.getBytes().length,
  };
}

// ─── Promotion logic ──────────────────────────────────────────────────────────

/**
 * Promotes a single submitted enrollment into the main SMS — DL-E15 §6.1.
 *
 * Operates per-enrollment (not per-session/group). The applicant of this
 * enrollment is promoted along with its guardians (from the parent group).
 * For sessions with multiple sibling enrollments, the caller must promote
 * each enrollment_id separately; this function deduplicates shared adults so
 * the second call doesn't create a duplicate personalData_S row for a guardian
 * already promoted by the first sibling.
 *
 * Source mode (group.source_code or legacy applicants source):
 *   - WEB_PUBLIC / enrollment_site: promote applicant + all guardians (unless
 *     already promoted in a prior call)
 *   - FAMILIES_APP: guardians already exist in SMS; only promote the applicant,
 *     and link them to the existing guardian personal_ids via relationalRecords.
 *
 * Dedupe rule: a person whose `personal_id` column on enrPersons is already
 * populated is considered already promoted; reuse that personal_id rather than
 * creating a new personalData_S row.
 *
 * @param {Object} p - { enrollment_id, person_personal_ids }
 *   person_personal_ids: { [enr_person_id]: sms_personal_id } — the caller may
 *     pre-allocate or look up existing personal_ids for shared adults.
 */
function promoteEnrollment_(p) {
  const enrollmentId = p.enrollment_id;
  // Legacy compat: if caller still sends application_id treat it as enrollment_id
  const fallbackId   = !enrollmentId && p.application_id ? p.application_id : null;
  const targetId     = enrollmentId || fallbackId;
  const personPersonalIds = p.person_personal_ids || {};
  if (!targetId) throw new Error('Missing enrollment_id');

  const now = new Date().toISOString();

  // ── Load the enrollment row ────────────────────────────────────────────────
  const enrs = appsheetRequest_(T.ENROLLMENTS, 'Find', [], {
    Filter: '"enrollment_id" = "' + targetId + '"'
  });
  const enrRow = enrs && enrs[0];
  if (!enrRow) throw new Error('Enrollment not found');

  // ── Load the parent group ──────────────────────────────────────────────────
  const groupId = enrRow.enrollment_group_id;
  const groups = appsheetRequest_(T.ENROLLMENT_GROUPS, 'Find', [], {
    Filter: '"enrollment_group_id" = "' + groupId + '"'
  });
  const groupRow = groups && groups[0];
  if (!groupRow) throw new Error('Parent enrollment group not found');

  // Resolve source: prefer group.source_id → lookup to enrEnrollmentSources;
  // fall back to a legacy `source` string on the group if present.
  let sourceCode = groupRow.source_code || groupRow.source || 'WEB_PUBLIC';
  if (groupRow.source_id && !groupRow.source_code) {
    try {
      const srcs = appsheetRequest_(T.ENROLLMENT_SOURCES, 'Find', [], {
        Filter: '"source_id" = "' + groupRow.source_id + '"'
      });
      if (srcs && srcs[0] && srcs[0].source_code) sourceCode = srcs[0].source_code;
    } catch (_) { /* keep default */ }
  }
  const isFamiliesApp = (sourceCode === 'FAMILIES_APP' || sourceCode === 'families_app');

  const desiredStartDate = enrRow.desired_start_date || groupRow.desired_start_date || null;

  // ── Persons to consider: applicant of this enrollment + ALL guardians of group ─
  const applicantPersonId = enrRow.applicant_person_id;
  const groupPersons = appsheetRequest_(T.PERSONS, 'Find', [], {
    Filter: '"enrollment_group_id" = "' + groupId + '"'
  }) || [];

  const guardianPersons  = groupPersons.filter(per => per.person_type_id === 'guardian');
  const applicantPerson  = groupPersons.find(per => per.person_id === applicantPersonId);
  if (!applicantPerson) throw new Error('Applicant person not found on enrollment');

  // Compose the working set: applicant + guardians
  const candidatePersons = [applicantPerson].concat(guardianPersons);

  // ── Dedupe of shared adults ────────────────────────────────────────────────
  // If a candidate person already has a `personal_id` column populated on the
  // enrPersons row, they've been promoted in a prior sibling call. Reuse it.
  // If the caller supplied person_personal_ids[<enr_person_id>] use that.
  const personalIdByPersonId = {};
  candidatePersons.forEach(per => {
    if (personPersonalIds[per.person_id]) {
      personalIdByPersonId[per.person_id] = personPersonalIds[per.person_id];
    } else if (per.personal_id) {
      personalIdByPersonId[per.person_id] = per.personal_id;
    }
  });

  // Persons we still need to address-promote: only those who don't have a
  // personalData_S row yet. For families_app the guardian addresses also stay.
  const personsAlreadyPromoted = candidatePersons.filter(per => personalIdByPersonId[per.person_id]).map(per => per.person_id);
  const personsToAddressPromote = isFamiliesApp
    ? [applicantPerson.person_id]   // guardians already in SMS
    : candidatePersons.map(per => per.person_id);

  // Final filter: don't re-promote addresses for adults already promoted
  const promotePersonIds = personsToAddressPromote.filter(pid => !personsAlreadyPromoted.includes(pid) || pid === applicantPerson.person_id);

  // ── Look up addresses for those persons ────────────────────────────────────
  const addrJoins = promotePersonIds.length
    ? appsheetRequest_(T.PERSON_ADDRESSES, 'Find', [], {
        Filter: promotePersonIds.map(pid => '"person_id" = "' + pid + '"').join(' || ')
      }) || []
    : [];

  const personAddrMap = {};
  addrJoins.forEach(j => {
    if (!personAddrMap[j.person_id] || j.is_default) {
      personAddrMap[j.person_id] = j.address_id;
    }
  });

  const uniqueAddrIds = [...new Set(Object.values(personAddrMap))];
  const addressMap    = {};
  if (uniqueAddrIds.length) {
    (appsheetRequest_(T.ADDRESSES, 'Find', [], {
      Filter: uniqueAddrIds.map(id => '"address_id" = "' + id + '"').join(' || ')
    }) || []).forEach(row => { addressMap[row.address_id] = row; });
  }

  const smsAddresses   = [];
  const smsAddressLogs = [];

  promotePersonIds.forEach(personId => {
    const personalId = personalIdByPersonId[personId];
    const addrId     = personAddrMap[personId];
    const addr       = addrId ? addressMap[addrId] : null;
    if (!addr || !personalId) return;

    const smsAddressId = generateUuid_();
    smsAddresses.push({
      address_id:     smsAddressId,
      personal_id:    personalId,
      school_id:      SCHOOL_ID,
      address_1:      addr.address_line_1 || null,
      address_2:      addr.address_line_2 || null,
      city_id:        addr.city           || null,
      province_id:    addr.province       || null,
      country_id:     addr.country_id     || null,
      zip:            addr.zip            || null,
    });
    smsAddressLogs.push({
      address_log_id: generateUuid_(),
      school_id:      SCHOOL_ID,
      personal_id:    personalId,
      address_id:     smsAddressId,
      active:         true,
      default:        true,
    });
  });

  if (smsAddresses.length)   appsheetRequest_(T.SMS_ADDRESSES,   'Add', smsAddresses);
  if (smsAddressLogs.length) appsheetRequest_(T.SMS_ADDRESS_LOG, 'Add', smsAddressLogs);

  // ── Link applicant ↔ guardians via relationalRecords ───────────────────────
  // Done always (not just families_app): the relations exist for every session.
  const relationalRecords = [];
  const groupRelations = appsheetRequest_(T.PERSON_RELATIONS, 'Find', [], {
    Filter: '"context_entity_id" = "' + groupId + '" && "context_entity_type_code" = "ENR_APPLICATION"'
  }) || [];

  groupRelations.forEach(rel => {
    // Only emit relational records that involve THIS enrollment's applicant
    if (rel.to_person_id !== applicantPerson.person_id) return;
    const guardianPersonalId  = personalIdByPersonId[rel.from_person_id];
    const applicantPersonalId = personalIdByPersonId[rel.to_person_id];
    if (!guardianPersonalId || !applicantPersonalId) return;
    relationalRecords.push({
      record_id:             generateUuid_(),
      school_id:             SCHOOL_ID,
      participant_id:        applicantPersonalId,
      relative_id:           guardianPersonalId,
      relation_id:           rel.relation_type_id || null,
      is_custodial:          rel.is_custodial          || false,
      is_pick_up_authorized: rel.is_pick_up_authorized || false,
      is_school_rep:         false,
      is_active:             true,
    });
  });
  if (relationalRecords.length) {
    appsheetRequest_(T.SMS_RELATIONAL_RECORDS, 'Add', relationalRecords);
  }

  // ── personCategoriesLog entry for the applicant ────────────────────────────
  const categoryLogs = [];
  if (desiredStartDate) {
    const applicantPersonalId = personalIdByPersonId[applicantPerson.person_id];
    if (applicantPersonalId) {
      categoryLogs.push({
        person_category_log_id: generateUuid_(),
        school_id:              SCHOOL_ID,
        personal_id:            applicantPersonalId,
        person_category_id:     'applicant',
        status_date:            desiredStartDate,
        last_known_status:      'desired_start: ' + desiredStartDate,
      });
      appsheetRequest_(T.SMS_PERSON_CATEGORIES, 'Add', categoryLogs);
    }
  }

  // ── Log promotion as a state transition on the enrollment ──────────────────
  const promotedStateRows = appsheetRequest_(T.STATES_T, 'Find', [], {
    Filter: '"state_code" = "PROMOTED" && "school_id" = "' + SCHOOL_ID + '" && "entity_type_code" = "ENR_APPLICATION"'
  });
  const promotedStateId = promotedStateRows && promotedStateRows[0]
    ? promotedStateRows[0].state_id : null;
  if (promotedStateId) {
    appsheetRequest_(T.STATE_TRANSITION_LOG, 'Add', [{
      log_id:             generateUuid_(),
      school_id:          SCHOOL_ID,
      entity_type_code:   'ENR_APPLICATION',
      entity_id:          targetId,
      transition_id:      null,
      from_state_id:      enrRow.current_state_id || null,
      to_state_id:        promotedStateId,
      mode_actually_used: 'MANUAL',
      transitioned_by:    getStaffEmail_() || 'SYSTEM:WIZARD',
      transitioned_at:    now,
      notes:              'Enrollment promoted to SMS',
      created_at:         now,
      created_by:         getStaffEmail_() || 'SYSTEM:WIZARD',
    }]);
    appsheetRequest_(T.ENROLLMENTS, 'Edit', [{
      enrollment_id:    targetId,
      current_state_id: promotedStateId,
      updated_at:       now,
    }]);
  }

  // Stamp promoted_at on the enrollment
  appsheetRequest_(T.ENROLLMENTS, 'Edit', [{
    enrollment_id: targetId,
    promoted_at:   now,
    updated_at:    now,
  }]);

  return {
    enrollment_id:        targetId,
    promoted_addresses:   smsAddresses.length,
    relational_records:   relationalRecords.length,
    category_log_entries: categoryLogs.length,
    // legacy alias for callers that still read application_id
    application_id:       targetId,
  };
}

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

function generateUuid_() {
  return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, c => {
    const r = Math.random() * 16 | 0;
    return (c === 'x' ? r : (r & 0x3 | 0x8)).toString(16);
  });
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
 * Diagnostic: tests Find on every enr* and sys* table used by the wizard.
 * Returns http_status + body_length per table so misconfigurations are visible.
 */
function diagAllTables_() {
  var props  = PropertiesService.getScriptProperties();
  var appId  = props.getProperty('APPSHEET_APP_ID');
  var apiKey = props.getProperty('APPSHEET_ACCESS_KEY');
  var tables = Object.values(T);
  var results = {};
  tables.forEach(function(table) {
    var url = APPSHEET_BASE_URL + appId + '/tables/' + encodeURIComponent(table) + '/Action';
    var res = UrlFetchApp.fetch(url, {
      method: 'post', contentType: 'application/json',
      headers: { ApplicationAccessKey: apiKey },
      payload: JSON.stringify({ Action: 'Find', Properties: { Locale: 'en-US' } }),
      muteHttpExceptions: true,
    });
    var status = res.getResponseCode();
    var text   = res.getContentText();
    results[table] = { http: status, len: text.length, ok: status >= 200 && status < 300 && text.length > 0, preview: text.slice(0, 120) };
  });
  return results;
}

/**
 * Diagnostic: returns raw AppSheet HTTP status + body for a table action.
 * Used to debug 200-with-empty-body responses without the JSON-parse wrapper.
 * @param {Object} p - { table, action? }
 */
function diagTable_(p) {
  const table  = p.table  || 'enrEnrollmentGroups';
  // Use p.appsheet_action to avoid collision with the outer routing p.action field
  const asAction = p.appsheet_action || 'Find';
  const props  = PropertiesService.getScriptProperties();
  const appId  = props.getProperty('APPSHEET_APP_ID');
  const apiKey = props.getProperty('APPSHEET_ACCESS_KEY');
  const url    = APPSHEET_BASE_URL + appId + '/tables/' + encodeURIComponent(table) + '/Action';
  const rowToAdd = p.row || null;
  const body   = { Action: asAction, Properties: { Locale: 'en-US' } };
  if (rowToAdd) body.Rows = [rowToAdd];
  const res    = UrlFetchApp.fetch(url, {
    method: 'post', contentType: 'application/json',
    headers: { ApplicationAccessKey: apiKey },
    payload: JSON.stringify(body),
    muteHttpExceptions: true,
  });
  const status = res.getResponseCode();
  const text   = res.getContentText();
  Logger.log('diagTable_ ' + table + '/' + asAction + ' → HTTP ' + status + ' | body(' + text.length + '): ' + text.slice(0, 800));
  Logger.log('curl: POST ' + url + ' | key prefix: ' + (apiKey || '').slice(0, 8) + '...');
  return { table, appsheet_action: asAction, http_status: status, body_length: text.length, body_preview: text.slice(0, 500), app_id: appId };
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
