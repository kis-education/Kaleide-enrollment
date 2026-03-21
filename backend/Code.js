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

// AppSheet table names matching the enr* / qb* schema
const T = {
  APPLICATIONS:       'enrApplications',
  STATUS_LOG:         'enrStatusLog',
  STATUS_TYPES:       'enrStatusTypes',
  CONSENTS:           'enrConsentsLog',
  GUARDIANS:          'enrGuardians',
  APPLICANTS:         'enrApplicants',
  GUARDIAN_APPLICANT: 'enrGuardianApplicantRelations',
  GUARDIAN_CONTACTS:  'enrGuardianContacts',
  PREV_SCHOOLS:       'enrPreviousSchools',
  MEDICAL:            'enrApplicantMedicalConditions',
  ALLERGIES:          'enrApplicantFoodAllergies',
  DIETARY:            'enrApplicantDietaryRequirements',
  DOCUMENTS:          'enrApplicationDocuments',
  QB_CONTEXTS:        'qbContexts',
  QB_SETS:            'qbQuestionSets',
  QB_SET_ITEMS:       'qbQuestionSetItems',
  QB_QUESTIONS:       'qbQuestions',
  QB_TRANSLATIONS:    'qbQuestionTranslations',
  QB_OPTIONS:         'qbAnswerOptions',
  QB_OPT_TRANS:       'qbAnswerOptionTranslations',
  QB_CONDITIONS:      'qbQuestionConditions',
  QB_RESPONSES:       'qbResponses',
};

// ─── Entry points ─────────────────────────────────────────────────────────────

/**
 * Health check endpoint.
 * @param {Object} e - GAS event object
 * @returns {TextOutput}
 */
function doGet(e) {
  Logger.log('[doGet] Health check called');
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
  const t0 = Date.now();
  try {
    let payload;
    try {
      payload = JSON.parse(e.postData.contents);
    } catch (parseErr) {
      Logger.log('[doPost] Failed to parse request body: ' + parseErr.message);
      return jsonResponse_({ ok: false, error: 'Invalid request body' }, 400);
    }

    const action = payload.action;
    Logger.log('[doPost] Incoming action: ' + action + ' | _hp present: ' + (payload._hp !== undefined));

    // Honeypot guard — bots fill hidden fields, humans don't
    if (payload._hp && payload._hp !== '') {
      Logger.log('[doPost] HONEYPOT triggered — rejecting request for action: ' + action);
      return jsonResponse_({ ok: false, error: 'Forbidden' }, 403);
    }

    let result;

    switch (action) {
      case 'initApplication':      result = initApplication_(payload);      break;
      case 'sendMagicLink':        result = sendMagicLink_(payload);        break;
      case 'resumeApplication':    result = resumeApplication_(payload);    break;
      case 'saveStep':             result = saveStep_(payload);             break;
      case 'submitApplication':    result = submitApplication_(payload);    break;
      case 'sendVerificationCode': result = sendVerificationCode_(payload); break;
      case 'verifyEmail':          result = verifyEmail_(payload);          break;
      case 'fetchQuestions':       result = fetchQuestions_(payload);       break;
      case 'saveResponses':        result = saveResponses_(payload);        break;
      case 'uploadDocument':       result = uploadDocument_(payload);       break;
      case 'verifyRecaptcha':      result = verifyRecaptcha_(payload);      break;
      default:
        Logger.log('[doPost] Unknown action: ' + action);
        return jsonResponse_({ ok: false, error: 'Unknown action: ' + action }, 400);
    }

    const elapsed = Date.now() - t0;
    Logger.log('[doPost] Action "' + action + '" completed successfully in ' + elapsed + 'ms');
    return jsonResponse_({ ok: true, ...result });

  } catch (err) {
    const elapsed = Date.now() - t0;
    Logger.log('[doPost] Unhandled error after ' + elapsed + 'ms: ' + err.message + '\n' + err.stack);
    return jsonResponse_({ ok: false, error: err.message }, 500);
  }
}

// ─── Action handlers ──────────────────────────────────────────────────────────

/**
 * Creates a new application in DRAFT status, sends magic link and internal notification.
 * @param {Object} p - { primary_email, preferred_language?, recaptcha_token? }
 * @returns {{ application_id: string, resume_token: string }}
 */
function initApplication_(p) {
  Logger.log('[initApplication] Start — email: ' + p.primary_email + ' | lang: ' + (p.preferred_language || 'es'));

  const applicationId = generateUuid_();
  const resumeToken   = generateUuid_();
  const now           = new Date().toISOString();
  Logger.log('[initApplication] Generated IDs — application_id: ' + applicationId + ' | resume_token: ' + resumeToken);

  // Look up DRAFT status type id
  Logger.log('[initApplication] Looking up DRAFT status type for school: ' + SCHOOL_ID);
  const statusTypes = appsheetRequest_(T.STATUS_TYPES, 'Find', [], {
    Filter: '"status_code" = "DRAFT" && "school_id" = "' + SCHOOL_ID + '"'
  });
  const draftTypeId = (statusTypes && statusTypes[0]) ? statusTypes[0].status_type_id : null;
  Logger.log('[initApplication] DRAFT status_type_id: ' + draftTypeId + (draftTypeId ? '' : ' (WARNING: not found — status will be null)'));

  Logger.log('[initApplication] Adding application row to AppSheet');
  appsheetRequest_(T.APPLICATIONS, 'Add', [{
    application_id:     applicationId,
    school_id:          SCHOOL_ID,
    status_type_id:     draftTypeId,
    resume_token:       resumeToken,
    primary_email:      p.primary_email,
    preferred_language: p.preferred_language || 'es',
    email_confirmed:    false,
    created_at:         now,
    updated_at:         now,
  }]);
  Logger.log('[initApplication] Application row added OK');

  Logger.log('[initApplication] Sending magic link email to: ' + p.primary_email);
  sendMagicLinkEmail_(p.primary_email, resumeToken, p.preferred_language || 'es');
  Logger.log('[initApplication] Magic link email sent OK');

  Logger.log('[initApplication] Sending internal notification email');
  sendInternalEmail_(
    '[KIS Admissions] New application started',
    buildApplicationInitiatedBody_(applicationId, p.primary_email, now)
  );
  Logger.log('[initApplication] Internal notification sent OK');

  Logger.log('[initApplication] Complete — application_id: ' + applicationId);
  return { application_id: applicationId, resume_token: resumeToken };
}

/**
 * Resends magic link for an existing application.
 * @param {Object} p - { application_id } or { primary_email }
 */
function sendMagicLink_(p) {
  Logger.log('[sendMagicLink] Start — lookup by: ' + (p.application_id ? 'application_id=' + p.application_id : 'primary_email=' + p.primary_email));

  let app;
  if (p.application_id) {
    const rows = appsheetRequest_(T.APPLICATIONS, 'Find', [], {
      Filter: '"application_id" = "' + p.application_id + '"'
    });
    app = rows && rows[0];
    Logger.log('[sendMagicLink] Lookup by application_id — found: ' + (app ? 'yes' : 'no'));
  } else if (p.primary_email) {
    const rows = appsheetRequest_(T.APPLICATIONS, 'Find', [], {
      Filter: '"primary_email" = "' + p.primary_email + '"'
    });
    Logger.log('[sendMagicLink] Lookup by email — total rows found: ' + (rows ? rows.length : 0));
    // Send to most recent application
    app = rows && rows.sort((a, b) => new Date(b.created_at) - new Date(a.created_at))[0];
    Logger.log('[sendMagicLink] Most recent application: ' + (app ? app.application_id : 'none'));
  }

  if (!app) {
    Logger.log('[sendMagicLink] ERROR — application not found');
    throw new Error('Application not found');
  }

  Logger.log('[sendMagicLink] Sending magic link email to: ' + app.primary_email + ' | lang: ' + (app.preferred_language || 'es'));
  sendMagicLinkEmail_(app.primary_email, app.resume_token, app.preferred_language || 'es');
  Logger.log('[sendMagicLink] Email sent OK');
  return { sent: true };
}

/**
 * Accepts a resume_token and returns the full application state.
 * @param {Object} p - { resume_token }
 * @returns {Object} Full application state including all child records
 */
function resumeApplication_(p) {
  Logger.log('[resumeApplication] Start — resume_token: ' + p.resume_token);

  const apps = appsheetRequest_(T.APPLICATIONS, 'Find', [], {
    Filter: '"resume_token" = "' + p.resume_token + '"'
  });
  Logger.log('[resumeApplication] Token lookup — rows found: ' + (apps ? apps.length : 0));

  if (!apps || !apps.length) {
    Logger.log('[resumeApplication] ERROR — invalid or expired token');
    throw new Error('Invalid or expired resume token');
  }

  const app = apps[0];
  const id  = app.application_id;
  Logger.log('[resumeApplication] Application found — id: ' + id + ' | email_confirmed: ' + app.email_confirmed + ' | submitted_at: ' + (app.submitted_at || 'null'));

  Logger.log('[resumeApplication] Fetching child records for application_id: ' + id);
  const [guardians, applicants, documents, responses] = [
    appsheetRequest_(T.GUARDIANS, 'Find', [], { Filter: '"application_id" = "' + id + '"' }) || [],
    appsheetRequest_(T.APPLICANTS, 'Find', [], { Filter: '"application_id" = "' + id + '"' }) || [],
    appsheetRequest_(T.DOCUMENTS, 'Find', [], { Filter: '"application_id" = "' + id + '"' }) || [],
    appsheetRequest_(T.QB_RESPONSES, 'Find', [], { Filter: '"respondent_id" = "' + id + '"' }) || [],
  ];
  Logger.log('[resumeApplication] Child records — guardians: ' + guardians.length + ' | applicants: ' + applicants.length + ' | documents: ' + documents.length + ' | responses: ' + responses.length);

  // Enrich guardians with contacts
  const guardianIds = guardians.map(g => g.guardian_id);
  let contacts = [];
  if (guardianIds.length) {
    Logger.log('[resumeApplication] Fetching guardian contacts for ' + guardianIds.length + ' guardian(s)');
    contacts = appsheetRequest_(T.GUARDIAN_CONTACTS, 'Find', [], {
      Filter: guardianIds.map(gid => '"guardian_id" = "' + gid + '"').join(' || ')
    }) || [];
    Logger.log('[resumeApplication] Guardian contacts found: ' + contacts.length);
  }

  // Enrich applicants with health + previous schools
  const applicantIds = applicants.map(a => a.applicant_id);
  let prevSchools = [], allergies = [], dietary = [], medical = [];
  if (applicantIds.length) {
    Logger.log('[resumeApplication] Fetching health/school data for ' + applicantIds.length + ' applicant(s)');
    const applicantFilter = applicantIds.map(aid => '"applicant_id" = "' + aid + '"').join(' || ');
    [prevSchools, allergies, dietary, medical] = [
      appsheetRequest_(T.PREV_SCHOOLS, 'Find', [], { Filter: applicantFilter }) || [],
      appsheetRequest_(T.ALLERGIES, 'Find', [], { Filter: applicantFilter }) || [],
      appsheetRequest_(T.DIETARY, 'Find', [], { Filter: applicantFilter }) || [],
      appsheetRequest_(T.MEDICAL, 'Find', [], { Filter: applicantFilter }) || [],
    ];
    Logger.log('[resumeApplication] Applicant enrichment — prevSchools: ' + prevSchools.length + ' | allergies: ' + allergies.length + ' | dietary: ' + dietary.length + ' | medical: ' + medical.length);
  }

  Logger.log('[resumeApplication] Complete — returning full application state');
  return {
    application: app,
    guardians: guardians.map(g => ({
      ...g,
      contacts: contacts.filter(c => c.guardian_id === g.guardian_id),
    })),
    applicants: applicants.map(a => ({
      ...a,
      previous_schools: prevSchools.filter(s => s.applicant_id === a.applicant_id),
      allergies:         allergies.filter(x => x.applicant_id === a.applicant_id),
      dietary:           dietary.filter(x => x.applicant_id === a.applicant_id),
      medical:           medical.filter(x => x.applicant_id === a.applicant_id),
    })),
    documents,
    responses,
  };
}

/**
 * Partial save for any wizard step.
 * @param {Object} p - { application_id, step, payload }
 */
function saveStep_(p) {
  const { application_id, step, payload } = p;
  Logger.log('[saveStep] Start — application_id: ' + application_id + ' | step: ' + step + ' | payload type: ' + (Array.isArray(payload) ? 'array[' + payload.length + ']' : typeof payload));

  if (!application_id || !step || !payload) {
    Logger.log('[saveStep] ERROR — missing required fields (application_id: ' + !!application_id + ', step: ' + !!step + ', payload: ' + !!payload + ')');
    throw new Error('Missing required fields');
  }

  Logger.log('[saveStep] Updating application updated_at timestamp');
  appsheetRequest_(T.APPLICATIONS, 'Edit', [{
    application_id,
    updated_at: new Date().toISOString(),
  }]);

  switch (step) {
    case 'guardians':
      Logger.log('[saveStep] Routing to saveGuardians_ — count: ' + (Array.isArray(payload) ? payload.length : 'n/a'));
      saveGuardians_(application_id, payload);
      break;
    case 'applicants':
      Logger.log('[saveStep] Routing to saveApplicants_ — count: ' + (Array.isArray(payload) ? payload.length : 'n/a'));
      saveApplicants_(application_id, payload);
      break;
    case 'health':
      Logger.log('[saveStep] Routing to saveHealth_ — count: ' + (Array.isArray(payload) ? payload.length : 'n/a'));
      saveHealth_(application_id, payload);
      break;
    case 'documents':
      Logger.log('[saveStep] Step "documents" — individual documents saved via uploadDocument_, skipping batch save');
      break;
    default:
      Logger.log('[saveStep] ERROR — unknown step: ' + step);
      throw new Error('Unknown step: ' + step);
  }

  Logger.log('[saveStep] Complete — step "' + step + '" saved OK');
  return { saved: true, step };
}

/**
 * Marks application as submitted, logs status change, sends emails.
 * @param {Object} p - { application_id, esignature, consents }
 */
function submitApplication_(p) {
  const { application_id } = p;
  Logger.log('[submitApplication] Start — application_id: ' + application_id);

  if (!application_id) {
    Logger.log('[submitApplication] ERROR — missing application_id');
    throw new Error('Missing application_id');
  }

  const now = new Date().toISOString();

  // Look up SUBMITTED status type id
  Logger.log('[submitApplication] Looking up SUBMITTED status type');
  const statusTypes = appsheetRequest_(T.STATUS_TYPES, 'Find', [], {
    Filter: '"status_code" = "SUBMITTED" && "school_id" = "' + SCHOOL_ID + '"'
  });
  const submittedTypeId = (statusTypes && statusTypes[0]) ? statusTypes[0].status_type_id : null;
  Logger.log('[submitApplication] SUBMITTED status_type_id: ' + submittedTypeId + (submittedTypeId ? '' : ' (WARNING: not found)'));

  // Get current status for log
  Logger.log('[submitApplication] Fetching current application record');
  const apps = appsheetRequest_(T.APPLICATIONS, 'Find', [], {
    Filter: '"application_id" = "' + application_id + '"'
  });
  const app = apps && apps[0];
  if (!app) {
    Logger.log('[submitApplication] ERROR — application not found: ' + application_id);
    throw new Error('Application not found');
  }
  Logger.log('[submitApplication] Found application — current status_type_id: ' + app.status_type_id);

  // Stamp submitted_at and update status
  Logger.log('[submitApplication] Stamping submitted_at and updating status');
  appsheetRequest_(T.APPLICATIONS, 'Edit', [{
    application_id,
    status_type_id: submittedTypeId,
    submitted_at:   now,
    updated_at:     now,
  }]);
  Logger.log('[submitApplication] Application record updated OK');

  // Write status log entry
  Logger.log('[submitApplication] Writing status log entry (DRAFT → SUBMITTED)');
  appsheetRequest_(T.STATUS_LOG, 'Add', [{
    log_id:               generateUuid_(),
    application_id,
    from_status_type_id:  app.status_type_id,
    to_status_type_id:    submittedTypeId,
    changed_by:           'applicant',
    changed_at:           now,
    reason:               'Application submitted by family',
  }]);
  Logger.log('[submitApplication] Status log entry written OK');

  // Log GDPR consent
  if (p.consents) {
    Logger.log('[submitApplication] Writing ' + p.consents.length + ' consent record(s)');
    const consentRows = p.consents.map(c => ({
      consent_id:        generateUuid_(),
      application_id,
      consent_type:      c.type,
      consented:         c.accepted,
      consent_timestamp: now,
      language:          p.language || 'es',
    }));
    if (consentRows.length) {
      appsheetRequest_(T.CONSENTS, 'Add', consentRows);
      Logger.log('[submitApplication] Consent records written OK');
    }
  } else {
    Logger.log('[submitApplication] No consent records provided');
  }

  // Fetch guardians and applicants for email summaries
  Logger.log('[submitApplication] Fetching guardians and applicants for email');
  const guardians  = appsheetRequest_(T.GUARDIANS, 'Find', [], { Filter: '"application_id" = "' + application_id + '"' }) || [];
  const applicants = appsheetRequest_(T.APPLICANTS, 'Find', [], { Filter: '"application_id" = "' + application_id + '"' }) || [];
  Logger.log('[submitApplication] Found ' + guardians.length + ' guardian(s), ' + applicants.length + ' applicant(s) for email summary');

  const guardianIds = guardians.map(g => g.guardian_id);
  let contacts = [];
  if (guardianIds.length) {
    contacts = appsheetRequest_(T.GUARDIAN_CONTACTS, 'Find', [], {
      Filter: guardianIds.map(gid => '"guardian_id" = "' + gid + '"').join(' || ')
    }) || [];
    Logger.log('[submitApplication] Found ' + contacts.length + ' guardian contact(s)');
  }

  // Send family confirmation (bilingual)
  Logger.log('[submitApplication] Sending family confirmation email to: ' + app.primary_email);
  sendFamilyConfirmationEmail_(app.primary_email, application_id, applicants, app.preferred_language || 'es');
  Logger.log('[submitApplication] Family confirmation email sent OK');

  // Send internal notification
  Logger.log('[submitApplication] Sending internal submission notification');
  sendInternalEmail_(
    '[KIS Admissions] Application submitted \u2014 action required',
    buildApplicationSubmittedBody_(application_id, now, guardians, contacts, applicants)
  );
  Logger.log('[submitApplication] Internal notification sent OK');

  Logger.log('[submitApplication] Complete — application ' + application_id + ' submitted successfully');
  return { submitted: true, application_id };
}

/**
 * Generates and emails a 6-digit verification code.
 * @param {Object} p - { application_id, primary_email }
 */
function sendVerificationCode_(p) {
  const { application_id, primary_email } = p;
  Logger.log('[sendVerificationCode] Start — application_id: ' + application_id + ' | email: ' + primary_email);

  if (!application_id || !primary_email) {
    Logger.log('[sendVerificationCode] ERROR — missing application_id or primary_email');
    throw new Error('Missing application_id or primary_email');
  }

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const cache = CacheService.getScriptCache();
  cache.put('verify_' + application_id, code, 600); // 10 min TTL
  Logger.log('[sendVerificationCode] Code generated and stored in cache (TTL 600s) for application_id: ' + application_id);

  const lang = p.preferred_language || 'es';
  Logger.log('[sendVerificationCode] Sending verification email in lang: ' + lang + ' to: ' + primary_email);

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

  Logger.log('[sendVerificationCode] Verification email sent OK to: ' + primary_email);
  return { sent: true };
}

/**
 * Verifies a 6-digit code and marks email as confirmed.
 * @param {Object} p - { application_id, code }
 */
function verifyEmail_(p) {
  const { application_id, code } = p;
  Logger.log('[verifyEmail] Start — application_id: ' + application_id + ' | code length: ' + (code ? code.toString().length : 0));

  if (!application_id || !code) {
    Logger.log('[verifyEmail] ERROR — missing application_id or code');
    throw new Error('Missing application_id or code');
  }

  const cache    = CacheService.getScriptCache();
  const stored   = cache.get('verify_' + application_id);
  Logger.log('[verifyEmail] Cache lookup — stored code present: ' + (stored ? 'yes' : 'no (expired or not found)'));

  if (!stored) {
    Logger.log('[verifyEmail] ERROR — code expired or not found for application_id: ' + application_id);
    throw new Error('Verification code expired or not found');
  }
  if (stored !== code.toString()) {
    Logger.log('[verifyEmail] ERROR — code mismatch for application_id: ' + application_id);
    throw new Error('Invalid verification code');
  }

  Logger.log('[verifyEmail] Code matched — removing from cache');
  cache.remove('verify_' + application_id);

  Logger.log('[verifyEmail] Marking email_confirmed=true in AppSheet');
  appsheetRequest_(T.APPLICATIONS, 'Edit', [{
    application_id,
    email_confirmed:    true,
    email_confirmed_at: new Date().toISOString(),
    updated_at:         new Date().toISOString(),
  }]);

  Logger.log('[verifyEmail] Complete — email confirmed OK for application_id: ' + application_id);
  return { verified: true };
}

/**
 * Fetches a question set with all translations, options, and conditions.
 * @param {Object} p - { context_designation, language }
 * @returns {Object} Nested question set structure
 */
function fetchQuestions_(p) {
  const { context_designation, language } = p;
  Logger.log('[fetchQuestions] Start — context: ' + context_designation + ' | lang: ' + (language || 'es'));

  if (!context_designation) {
    Logger.log('[fetchQuestions] ERROR — missing context_designation');
    throw new Error('Missing context_designation');
  }

  const lang = language || 'es';

  // Find matching context
  Logger.log('[fetchQuestions] Looking up context: ' + context_designation + ' for school: ' + SCHOOL_ID);
  const contexts = appsheetRequest_(T.QB_CONTEXTS, 'Find', [], {
    Filter: '"designation" = "' + context_designation + '" && "school_id" = "' + SCHOOL_ID + '" && "is_active" = true'
  });
  if (!contexts || !contexts.length) {
    Logger.log('[fetchQuestions] ERROR — context not found: ' + context_designation);
    throw new Error('Context not found: ' + context_designation);
  }
  const context = contexts[0];
  Logger.log('[fetchQuestions] Context found — context_id: ' + context.context_id);

  // Find active question sets for this context
  Logger.log('[fetchQuestions] Fetching active question sets for context_id: ' + context.context_id);
  const sets = appsheetRequest_(T.QB_SETS, 'Find', [], {
    Filter: '"context_id" = "' + context.context_id + '" && "is_active" = true'
  });
  if (!sets || !sets.length) {
    Logger.log('[fetchQuestions] No active question sets found — returning empty');
    return { sets: [] };
  }
  Logger.log('[fetchQuestions] Found ' + sets.length + ' question set(s)');

  const setIds       = sets.map(s => s.set_id);
  const setIdFilter  = setIds.map(id => '"set_id" = "' + id + '"').join(' || ');

  Logger.log('[fetchQuestions] Fetching set items for ' + setIds.length + ' set(s)');
  const setItems = appsheetRequest_(T.QB_SET_ITEMS, 'Find', [], { Filter: setIdFilter }) || [];
  const questionIds  = [...new Set(setItems.map(i => i.question_id))];
  Logger.log('[fetchQuestions] Set items: ' + setItems.length + ' | unique question IDs: ' + questionIds.length);

  if (!questionIds.length) {
    Logger.log('[fetchQuestions] No questions in sets — returning sets without items');
    return { sets };
  }

  const qIdFilter = questionIds.map(id => '"question_id" = "' + id + '"').join(' || ');

  Logger.log('[fetchQuestions] Fetching questions, translations, options, and conditions');
  const [questions, allTranslations, allOptions, allConditions] = [
    appsheetRequest_(T.QB_QUESTIONS, 'Find', [], { Filter: qIdFilter }) || [],
    appsheetRequest_(T.QB_TRANSLATIONS, 'Find', [], { Filter: qIdFilter }) || [],
    appsheetRequest_(T.QB_OPTIONS, 'Find', [], { Filter: qIdFilter }) || [],
    appsheetRequest_(T.QB_CONDITIONS, 'Find', [], { Filter: qIdFilter }) || [],
  ];
  Logger.log('[fetchQuestions] Fetched — questions: ' + questions.length + ' | translations: ' + allTranslations.length + ' | options: ' + allOptions.length + ' | conditions: ' + allConditions.length);

  const optionIds = allOptions.map(o => o.option_id);
  let allOptionTranslations = [];
  if (optionIds.length) {
    Logger.log('[fetchQuestions] Fetching option translations for ' + optionIds.length + ' option(s)');
    allOptionTranslations = appsheetRequest_(T.QB_OPT_TRANS, 'Find', [], {
      Filter: optionIds.map(id => '"option_id" = "' + id + '"').join(' || ')
    }) || [];
    Logger.log('[fetchQuestions] Option translations: ' + allOptionTranslations.length);
  }

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
      question_text:    translation?.question_text    || '',
      help_text:        translation?.help_text        || '',
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

  Logger.log('[fetchQuestions] Complete — returning ' + enrichedSets.length + ' enriched set(s) with ' + enrichedQuestions.length + ' question(s)');
  return { context, sets: enrichedSets };
}

/**
 * Batch-writes question responses.
 * @param {Object} p - { application_id, respondent_id, respondent_type_category_id, responses: Array }
 */
function saveResponses_(p) {
  const { application_id, respondent_id, respondent_type_category_id, responses } = p;
  Logger.log('[saveResponses] Start — application_id: ' + application_id + ' | respondent_id: ' + respondent_id + ' | responses: ' + (responses ? responses.length : 0));

  if (!responses || !responses.length) {
    Logger.log('[saveResponses] No responses to save — returning 0');
    return { saved: 0 };
  }

  const now  = new Date().toISOString();
  const rows = responses.map(r => ({
    response_id:                  generateUuid_(),
    school_id:                    SCHOOL_ID,
    set_id:                       r.set_id || null,
    question_id:                  r.question_id,
    respondent_id:                respondent_id || application_id,
    respondent_type_category_id:  respondent_type_category_id || 'client',
    response_text:                r.response_text || null,
    response_option_id:           r.response_option_id || null,
    response_numeric:             r.response_numeric || null,
    language:                     r.language || 'es',
    responded_at:                 now,
  }));

  Logger.log('[saveResponses] Writing ' + rows.length + ' response row(s) to AppSheet');
  appsheetRequest_(T.QB_RESPONSES, 'Add', rows);
  Logger.log('[saveResponses] Complete — ' + rows.length + ' responses saved OK');
  return { saved: rows.length };
}

/**
 * Accepts a base64-encoded file, saves to Drive, writes document record.
 * @param {Object} p - { application_id, base64, mimeType, filename, document_type }
 * @returns {{ drive_url: string, document_id: string }}
 */
function uploadDocument_(p) {
  const { application_id, base64, mimeType, filename, document_type } = p;
  const approxSizeKb = Math.round((base64 ? base64.length * 0.75 / 1024 : 0));
  Logger.log('[uploadDocument] Start — application_id: ' + application_id + ' | filename: ' + filename + ' | mimeType: ' + mimeType + ' | document_type: ' + document_type + ' | approx size: ' + approxSizeKb + 'KB');

  if (!base64 || !application_id) {
    Logger.log('[uploadDocument] ERROR — missing base64 or application_id');
    throw new Error('Missing base64 or application_id');
  }

  Logger.log('[uploadDocument] Decoding base64 and creating blob');
  const blob   = Utilities.newBlob(Utilities.base64Decode(base64), mimeType, filename);

  Logger.log('[uploadDocument] Getting/creating Drive folder: ' + DRIVE_FOLDER_NAME);
  const folder = getOrCreateDriveFolder_(DRIVE_FOLDER_NAME);

  Logger.log('[uploadDocument] Uploading file to Drive');
  const file   = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  const driveUrl   = file.getUrl();
  const documentId = generateUuid_();
  const now        = new Date().toISOString();
  Logger.log('[uploadDocument] File uploaded to Drive — url: ' + driveUrl + ' | document_id: ' + documentId);

  Logger.log('[uploadDocument] Writing document record to AppSheet');
  appsheetRequest_(T.DOCUMENTS, 'Add', [{
    document_id:     documentId,
    application_id,
    document_type:   document_type || 'other',
    drive_url:       driveUrl,
    uploaded_at:     now,
    uploaded_by:     'applicant',
  }]);

  Logger.log('[uploadDocument] Complete — document_id: ' + documentId);
  return { document_id: documentId, drive_url: driveUrl };
}

/**
 * Verifies a reCAPTCHA v3 token against Google's API.
 * @param {Object} p - { token }
 * @returns {{ success: boolean, score: number, pass: boolean }}
 */
function verifyRecaptcha_(p) {
  const { token } = p;
  Logger.log('[verifyRecaptcha] Start — token length: ' + (token ? token.length : 0));

  if (!token) {
    Logger.log('[verifyRecaptcha] ERROR — missing token');
    throw new Error('Missing reCAPTCHA token');
  }

  const secret   = PropertiesService.getScriptProperties().getProperty('RECAPTCHA_SECRET');
  Logger.log('[verifyRecaptcha] RECAPTCHA_SECRET configured: ' + (secret ? 'yes' : 'NO — missing!'));

  Logger.log('[verifyRecaptcha] Calling Google siteverify API');
  const response = UrlFetchApp.fetch('https://www.google.com/recaptcha/api/siteverify', {
    method:  'post',
    payload: { secret, response: token },
    muteHttpExceptions: true,
  });

  const result = JSON.parse(response.getContentText());
  const pass   = result.success === true && (result.score || 0) >= 0.5;
  Logger.log('[verifyRecaptcha] Result — success: ' + result.success + ' | score: ' + result.score + ' | pass: ' + pass + (result['error-codes'] ? ' | errors: ' + result['error-codes'].join(',') : ''));

  return {
    success: result.success === true,
    score:   result.score || 0,
    pass,
  };
}

// ─── Step save helpers ────────────────────────────────────────────────────────

/**
 * Upserts guardians and their contacts for an application.
 * @param {string} applicationId
 * @param {Array}  guardians - array of guardian objects with optional contacts array
 */
function saveGuardians_(applicationId, guardians) {
  if (!Array.isArray(guardians)) {
    Logger.log('[saveGuardians] WARNING — payload is not an array, skipping');
    return;
  }
  Logger.log('[saveGuardians] Processing ' + guardians.length + ' guardian(s) for application_id: ' + applicationId);

  guardians.forEach((g, idx) => {
    const isNew      = !g.guardian_id;
    const guardianId = g.guardian_id || generateUuid_();
    Logger.log('[saveGuardians] Guardian ' + (idx + 1) + '/' + guardians.length + ' — id: ' + guardianId + ' | action: ' + (isNew ? 'Add' : 'Edit') + ' | name: ' + (g.first_name || '') + ' ' + (g.last_name || ''));

    const guardianRow = {
      guardian_id:          guardianId,
      application_id:       applicationId,
      guardian_order:       idx + 1,
      first_name:           g.first_name || null,
      middle_name:          g.middle_name || null,
      last_name:            g.last_name || null,
      date_of_birth:        g.date_of_birth || null,
      place_of_birth:       g.place_of_birth || null,
      nationality_id:       g.nationality_id || null,
      id_type_id:           g.id_type_id || null,
      id_number:            g.id_number || null,
      profession:           g.profession || null,
      employer:             g.employer || null,
      address_line_1:       g.address_line_1 || null,
      address_line_2:       g.address_line_2 || null,
      city:                 g.city || null,
      province:             g.province || null,
      country_id:           g.country_id || null,
      zip:                  g.zip || null,
      is_primary_contact:   g.is_primary_contact || false,
      is_emergency_contact: g.is_emergency_contact || false,
      created_at:           g.created_at || new Date().toISOString(),
    };

    if (g.guardian_id) {
      appsheetRequest_(T.GUARDIANS, 'Edit', [guardianRow]);
    } else {
      appsheetRequest_(T.GUARDIANS, 'Add', [guardianRow]);
    }

    // Upsert contacts
    if (Array.isArray(g.contacts)) {
      const newContacts      = g.contacts.filter(c => !c.contact_id).map(c => ({
        contact_id:   generateUuid_(),
        guardian_id:  guardianId,
        contact_type: c.contact_type,
        value:        c.value,
        is_default:   c.is_default || false,
        is_emergency: c.is_emergency || false,
        is_whatsapp:  c.is_whatsapp || false,
        is_telegram:  c.is_telegram || false,
      }));
      const existingContacts = g.contacts.filter(c => c.contact_id);

      Logger.log('[saveGuardians] Guardian ' + (idx + 1) + ' contacts — new: ' + newContacts.length + ' | existing (edit): ' + existingContacts.length);
      if (newContacts.length)      appsheetRequest_(T.GUARDIAN_CONTACTS, 'Add',  newContacts);
      if (existingContacts.length) appsheetRequest_(T.GUARDIAN_CONTACTS, 'Edit', existingContacts);
    }
  });

  Logger.log('[saveGuardians] All guardians processed OK');
}

/**
 * Upserts applicants and their sub-records.
 * @param {string} applicationId
 * @param {Array}  applicants
 */
function saveApplicants_(applicationId, applicants) {
  if (!Array.isArray(applicants)) {
    Logger.log('[saveApplicants] WARNING — payload is not an array, skipping');
    return;
  }
  Logger.log('[saveApplicants] Processing ' + applicants.length + ' applicant(s) for application_id: ' + applicationId);

  applicants.forEach((a, idx) => {
    const isNew       = !a.applicant_id;
    const applicantId = a.applicant_id || generateUuid_();
    Logger.log('[saveApplicants] Applicant ' + (idx + 1) + '/' + applicants.length + ' — id: ' + applicantId + ' | action: ' + (isNew ? 'Add' : 'Edit') + ' | name: ' + (a.first_name || '') + ' ' + (a.last_name || ''));

    const applicantRow = {
      applicant_id:               applicantId,
      application_id:             applicationId,
      applicant_order:            idx + 1,
      first_name:                 a.first_name || null,
      middle_name:                a.middle_name || null,
      last_name:                  a.last_name || null,
      date_of_birth:              a.date_of_birth || null,
      place_of_birth:             a.place_of_birth || null,
      nationality_id:             a.nationality_id || null,
      id_type_id:                 a.id_type_id || null,
      id_number:                  a.id_number || null,
      gender:                     a.gender || null,
      mother_tongue_language:     a.mother_tongue_language || null,
      other_languages:            a.other_languages || null,
      desired_education_level_id: a.desired_education_level_id || null,
      desired_start_date:         a.desired_start_date || null,
      address_same_as_guardian_id: a.address_same_as_guardian_id || null,
      address_line_1:             a.address_line_1 || null,
      address_line_2:             a.address_line_2 || null,
      city:                       a.city || null,
      province:                   a.province || null,
      country_id:                 a.country_id || null,
      zip:                        a.zip || null,
      has_adaptation_needs:       a.has_adaptation_needs || false,
      adaptation_notes:           a.adaptation_notes || null,
      is_sibling:                 a.is_sibling || false,
      is_alumni_family:           a.is_alumni_family || false,
      is_transfer:                a.is_transfer || false,
      created_at:                 a.created_at || new Date().toISOString(),
    };

    if (a.applicant_id) {
      appsheetRequest_(T.APPLICANTS, 'Edit', [applicantRow]);
    } else {
      appsheetRequest_(T.APPLICANTS, 'Add', [applicantRow]);
    }

    // Previous schools
    if (Array.isArray(a.previous_schools)) {
      const newSchools = a.previous_schools.filter(s => !s.previous_school_id).map(s => ({
        previous_school_id:          generateUuid_(),
        applicant_id:                applicantId,
        school_name:                 s.school_name || null,
        city:                        s.city || null,
        country_id:                  s.country_id || null,
        from_year:                   s.from_year || null,
        to_year:                     s.to_year || null,
        education_level_description: s.education_level_description || null,
        language_of_instruction:     s.language_of_instruction || null,
      }));
      const existingSchools = a.previous_schools.filter(s => s.previous_school_id);
      Logger.log('[saveApplicants] Applicant ' + (idx + 1) + ' schools — new: ' + newSchools.length + ' | existing (edit): ' + existingSchools.length);
      if (newSchools.length)      appsheetRequest_(T.PREV_SCHOOLS, 'Add',  newSchools);
      if (existingSchools.length) appsheetRequest_(T.PREV_SCHOOLS, 'Edit', existingSchools);
    }

    // Guardian–applicant relations
    if (Array.isArray(a.relations)) {
      const newRelations = a.relations.filter(r => !r.relation_id).map(r => ({
        relation_id:           generateUuid_(),
        guardian_id:           r.guardian_id,
        applicant_id:          applicantId,
        relation_type_id:      r.relation_type_id || null,
        is_custodial:          r.is_custodial || false,
        is_pick_up_authorized: r.is_pick_up_authorized || false,
      }));
      Logger.log('[saveApplicants] Applicant ' + (idx + 1) + ' relations — new: ' + newRelations.length);
      if (newRelations.length) appsheetRequest_(T.GUARDIAN_APPLICANT, 'Add', newRelations);
    }
  });

  Logger.log('[saveApplicants] All applicants processed OK');
}

/**
 * Upserts health records for each applicant.
 * @param {string} applicationId
 * @param {Array}  healthData - [{ applicant_id, allergies, dietary, medical }]
 */
function saveHealth_(applicationId, healthData) {
  if (!Array.isArray(healthData)) {
    Logger.log('[saveHealth] WARNING — payload is not an array, skipping');
    return;
  }
  Logger.log('[saveHealth] Processing health data for ' + healthData.length + ' applicant record(s), application_id: ' + applicationId);

  healthData.forEach((h, idx) => {
    const { applicant_id } = h;
    if (!applicant_id) {
      Logger.log('[saveHealth] WARNING — record ' + (idx + 1) + ' missing applicant_id, skipping');
      return;
    }
    Logger.log('[saveHealth] Applicant ' + (idx + 1) + ' (' + applicant_id + ') — allergies: ' + (h.allergies ? h.allergies.length : 0) + ' | dietary: ' + (h.dietary ? h.dietary.length : 0) + ' | medical: ' + (h.medical ? h.medical.length : 0));

    if (Array.isArray(h.allergies)) {
      const rows = h.allergies.filter(x => !x.record_id).map(x => ({
        record_id:       generateUuid_(),
        applicant_id,
        food_allergy_id: x.food_allergy_id || null,
        observations:    x.observations || null,
      }));
      if (rows.length) {
        Logger.log('[saveHealth] Adding ' + rows.length + ' allergy record(s) for applicant: ' + applicant_id);
        appsheetRequest_(T.ALLERGIES, 'Add', rows);
      }
    }

    if (Array.isArray(h.dietary)) {
      const rows = h.dietary.filter(x => !x.record_id).map(x => ({
        record_id:    generateUuid_(),
        applicant_id,
        diet_id:      x.diet_id || null,
        observations: x.observations || null,
      }));
      if (rows.length) {
        Logger.log('[saveHealth] Adding ' + rows.length + ' dietary record(s) for applicant: ' + applicant_id);
        appsheetRequest_(T.DIETARY, 'Add', rows);
      }
    }

    if (Array.isArray(h.medical)) {
      const rows = h.medical.filter(x => !x.record_id).map(x => ({
        record_id:            generateUuid_(),
        applicant_id,
        medical_condition_id: x.medical_condition_id || null,
        observations:         x.observations || null,
      }));
      if (rows.length) {
        Logger.log('[saveHealth] Adding ' + rows.length + ' medical record(s) for applicant: ' + applicant_id);
        appsheetRequest_(T.MEDICAL, 'Add', rows);
      }
    }
  });

  Logger.log('[saveHealth] All health records processed OK');
}

// ─── Email helpers ────────────────────────────────────────────────────────────

/**
 * Sends a branded internal email to admissions@kaleide.org.
 * @param {string} subject
 * @param {string} bodyHtml - inner HTML content (no shell)
 */
function sendInternalEmail_(subject, bodyHtml) {
  Logger.log('[sendInternalEmail] Sending to: ' + ADMISSIONS_EMAIL + ' | subject: ' + subject);
  GmailApp.sendEmail(ADMISSIONS_EMAIL, subject, '', {
    htmlBody: buildInternalEmail_(subject, bodyHtml),
    name: 'KIS Admissions System',
  });
  Logger.log('[sendInternalEmail] Sent OK');
}

/**
 * Sends magic link email to the family.
 * @param {string} email
 * @param {string} resumeToken
 * @param {string} lang - 'en' or 'es'
 */
function sendMagicLinkEmail_(email, resumeToken, lang) {
  const resumeUrl = RESUME_BASE_URL + resumeToken;
  Logger.log('[sendMagicLinkEmail] Sending to: ' + email + ' | lang: ' + lang + ' | resume_url: ' + resumeUrl);

  const isEn = lang === 'en';

  const subject = isEn
    ? 'Your Kaleide application link'
    : 'Tu enlace de solicitud de Kaleide';

  const body = isEn
    ? '<p>Click the link below to access or resume your application:</p>'
      + '<p style="margin:24px 0;"><a href="' + resumeUrl + '" style="background:#00a19a;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600;">Resume Application</a></p>'
      + '<p style="color:#6b7c93;font-size:0.9em;">Or copy this URL into your browser:<br>' + resumeUrl + '</p>'
      + '<p>This link will take you directly to your application. Keep it safe.</p>'
    : '<p>Haz clic en el enlace de abajo para acceder o continuar tu solicitud:</p>'
      + '<p style="margin:24px 0;"><a href="' + resumeUrl + '" style="background:#00a19a;color:#fff;padding:12px 28px;border-radius:6px;text-decoration:none;font-weight:600;">Continuar solicitud</a></p>'
      + '<p style="color:#6b7c93;font-size:0.9em;">O copia esta URL en tu navegador:<br>' + resumeUrl + '</p>'
      + '<p>Este enlace te lleva directamente a tu solicitud. Gu\u00e1rdalo en un lugar seguro.</p>';

  GmailApp.sendEmail(email, subject, '', {
    htmlBody: buildFamilyEmail_(subject, body),
    name: 'Kaleide International School',
  });
  Logger.log('[sendMagicLinkEmail] Sent OK to: ' + email);
}

/**
 * Sends bilingual EN/ES confirmation email to the family on submission.
 */
function sendFamilyConfirmationEmail_(email, applicationId, applicants, lang) {
  const names = applicants.map(a => (a.first_name || '') + ' ' + (a.last_name || '')).join(', ');
  Logger.log('[sendFamilyConfirmationEmail] Sending to: ' + email + ' | applicants: ' + names + ' | lang: ' + lang);

  const body =
    '<h2 style="color:#00a19a;">Thank you / Gracias</h2>' +
    '<p><strong>EN:</strong> Your enrollment application has been received. We will review it and be in touch shortly.</p>' +
    '<p><strong>Applicant(s):</strong> ' + names + '</p>' +
    '<p><strong>Application ID:</strong> ' + applicationId + '</p>' +
    '<hr style="border:none;border-top:1px solid #e3e7ed;margin:24px 0;">' +
    '<p><strong>ES:</strong> Hemos recibido tu solicitud de matr\u00edcula. La revisaremos y nos pondremos en contacto contigo en breve.</p>' +
    '<p><strong>Alumno/s:</strong> ' + names + '</p>' +
    '<p><strong>N\u00famero de solicitud:</strong> ' + applicationId + '</p>';

  GmailApp.sendEmail(email, 'Kaleide enrollment application received / Solicitud de matr\u00edcula recibida', '', {
    htmlBody: buildFamilyEmail_('Enrollment application received', body),
    name: 'Kaleide International School',
  });
  Logger.log('[sendFamilyConfirmationEmail] Sent OK to: ' + email);
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
 */
function buildApplicationSubmittedBody_(applicationId, timestamp, guardians, contacts, applicants) {
  const ts = formatTimestamp_(timestamp);

  let guardianRows = '';
  guardians.forEach((g, i) => {
    const gContacts = contacts.filter(c => c.guardian_id === g.guardian_id);
    const emails    = gContacts.filter(c => c.contact_type === 'email').map(c => c.value).join(', ');
    const phones    = gContacts.filter(c => c.contact_type === 'phone').map(c =>
      c.value + (c.is_whatsapp ? ' \uD83D\uDCAC' : '') + (c.is_telegram ? ' \u2708\uFE0F' : '')
    ).join(', ');

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
      + '<td>' + (a.date_of_birth || '\u2014') + '</td>'
      + '<td>' + (a.desired_start_date || '\u2014') + '</td></tr>';
  });

  return '<h2 style="color:#00a19a;margin-top:0">Application Submitted \u2014 Action Required</h2>'
    + '<table style="margin-bottom:24px"><thead><tr><th colspan="2">Application Details</th></tr></thead><tbody>'
    + '<tr><td><strong>Application ID</strong></td><td style="font-family:monospace">' + applicationId + '</td></tr>'
    + '<tr><td><strong>Submitted At</strong></td><td>' + ts + '</td></tr>'
    + '<tr><td><strong>Status</strong></td><td><span style="background:#fff3ec;color:#c05800;padding:2px 8px;border-radius:4px;font-size:0.9em">SUBMITTED</span></td></tr>'
    + '</tbody></table>'

    + '<h3 style="color:#6b7c93;font-size:0.9em;text-transform:uppercase;letter-spacing:0.05em">Guardians</h3>'
    + '<table style="margin-bottom:24px"><thead><tr><th>Name</th><th>Email</th><th>Phone</th></tr></thead><tbody>'
    + guardianRows + '</tbody></table>'

    + '<h3 style="color:#6b7c93;font-size:0.9em;text-transform:uppercase;letter-spacing:0.05em">Applicants</h3>'
    + '<table style="margin-bottom:24px"><thead><tr><th>Name</th><th>Date of Birth</th><th>Desired Start Date</th></tr></thead><tbody>'
    + applicantRows + '</tbody></table>'

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
function appsheetRequest_(table, action, rows, selector) {
  const props  = PropertiesService.getScriptProperties();
  const appId  = props.getProperty('APPSHEET_APP_ID');
  const apiKey = props.getProperty('APPSHEET_ACCESS_KEY');

  if (!appId || !apiKey) {
    Logger.log('[appsheetRequest] ERROR — AppSheet credentials not set in Script Properties (APPSHEET_APP_ID: ' + !!appId + ', APPSHEET_ACCESS_KEY: ' + !!apiKey + ')');
    throw new Error('AppSheet credentials not configured in Script Properties');
  }

  const rowCount = rows ? rows.length : 0;
  const filterSnippet = selector && selector.Filter ? selector.Filter.substring(0, 80) : '';
  Logger.log('[appsheetRequest] → ' + action + ' ' + table + (rowCount > 0 ? ' [' + rowCount + ' row(s)]' : '') + (filterSnippet ? ' | Filter: ' + filterSnippet : ''));

  const url  = APPSHEET_BASE_URL + appId + '/tables/' + encodeURIComponent(table) + '/Action';
  const body = { Action: action, Properties: { Locale: 'en-US' } };

  if (rows && rows.length > 0) body.Rows = rows;
  if (selector)                body.Properties = { ...body.Properties, ...selector };

  const t0 = Date.now();
  const response = UrlFetchApp.fetch(url, {
    method:             'post',
    contentType:        'application/json',
    headers:            { ApplicationAccessKey: apiKey },
    payload:            JSON.stringify(body),
    muteHttpExceptions: true,
  });

  const statusCode = response.getResponseCode();
  const elapsed    = Date.now() - t0;
  const text       = response.getContentText();

  if (statusCode < 200 || statusCode >= 300) {
    Logger.log('[appsheetRequest] ERROR — HTTP ' + statusCode + ' on ' + table + '/' + action + ' (' + elapsed + 'ms) | response: ' + text.substring(0, 200));
    throw new Error('AppSheet API error ' + statusCode + ' on ' + table + '/' + action + ': ' + text);
  }

  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch (_) {
    Logger.log('[appsheetRequest] WARNING — could not parse JSON response for ' + table + '/' + action + ' (' + elapsed + 'ms)');
    return null;
  }

  const resultRows = parsed.Rows || parsed.rows || parsed || null;
  const resultCount = Array.isArray(resultRows) ? resultRows.length : (resultRows ? 1 : 0);
  Logger.log('[appsheetRequest] ← HTTP ' + statusCode + ' ' + table + '/' + action + ' (' + elapsed + 'ms) | rows returned: ' + resultCount);

  return resultRows;
}

// ─── Utility helpers ──────────────────────────────────────────────────────────

/**
 * Generates a UUID v4 string.
 * @returns {string}
 */
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
  Logger.log('[getOrCreateDriveFolder] Looking for folder: ' + name);
  const folders = DriveApp.getFoldersByName(name);
  if (folders.hasNext()) {
    const folder = folders.next();
    Logger.log('[getOrCreateDriveFolder] Existing folder found: ' + folder.getId());
    return folder;
  }
  Logger.log('[getOrCreateDriveFolder] Folder not found — creating new folder: ' + name);
  const newFolder = DriveApp.createFolder(name);
  Logger.log('[getOrCreateDriveFolder] Created folder: ' + newFolder.getId());
  return newFolder;
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
