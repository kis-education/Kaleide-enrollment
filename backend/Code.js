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

// AppSheet table names matching the enr* / qb* schema
const T = {
  APPLICATIONS:         'enrApplications',
  STATUS_LOG:           'enrStatusLog',
  STATUS_TYPES:         'enrStatusTypes',
  CONSENTS:             'enrConsentsLog',
  PERSONS:              'enrPersons',
  PERSON_NATIONALITIES: 'enrPersonNationalities',
  PERSON_IDS:           'enrPersonIDs',
  PERSON_LANGUAGES:     'enrPersonLanguages',
  ADDRESSES:            'enrAddresses',
  PERSON_ADDRESSES:     'enrPersonAddresses',
  EMAILS:               'enrEmails',
  PERSON_EMAILS:        'enrPersonEmails',
  PHONES:               'enrPhones',
  PERSON_PHONES:        'enrPersonPhones',
  RELATIONS:            'enrRelations',
  PREV_SCHOOLS:         'enrPreviousSchools',
  PERSON_MEDICAL:       'enrPersonMedicalConditions',
  PERSON_ALLERGIES:     'enrPersonFoodAllergies',
  PERSON_DIETARY:       'enrPersonDietaryRequirements',
  DOCUMENTS:            'enrApplicationDocuments',
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
      case 'promoteApplication': result = promoteApplication_(payload); break;
      case 'fetchLookups':       result = fetchLookups_(payload);       break;
      default:
        return jsonResponse_({ ok: false, error: 'Unknown action: ' + action }, 400);
    }

    return jsonResponse_({ ok: true, ...result });

  } catch (err) {
    Logger.log('doPost error: ' + err.message + '\n' + err.stack);
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
  // Verify reCAPTCHA before writing anything to the database
  const secret = PropertiesService.getScriptProperties().getProperty('RECAPTCHA_SECRET');
  if (secret) {
    if (!p.recaptcha_token) throw new Error('Missing reCAPTCHA token');
    const rcResult = verifyRecaptcha_({ token: p.recaptcha_token });
    if (!rcResult.pass) throw new Error('reCAPTCHA verification failed');
  }

  const applicationId = generateUuid_();
  const resumeToken   = generateUuid_();
  const now           = new Date().toISOString();

  // Look up DRAFT status type id
  const statusTypes = appsheetRequest_(T.STATUS_TYPES, 'Find', [], {
    Filter: '"status_code" = "DRAFT" && "school_id" = "' + SCHOOL_ID + '"'
  });
  const draftTypeId = (statusTypes && statusTypes[0]) ? statusTypes[0].status_type_id : null;

  appsheetRequest_(T.APPLICATIONS, 'Add', [{
    application_id:     applicationId,
    school_id:          SCHOOL_ID,
    status_type_id:     draftTypeId,
    resume_token:       resumeToken,
    primary_email:      p.primary_email,
    preferred_language: p.preferred_language || 'es',
    email_confirmed:    false,
    desired_start_date: p.desired_start_date || null,
    source:             p.source || 'enrollment_site',
    created_at:         now,
    updated_at:         now,
  }]);

  // Record GDPR consent
  const lang = p.preferred_language || 'es';
  const gdprText = CONSENT_TEXTS.gdpr.en + '\n\n' + CONSENT_TEXTS.gdpr.es;
  appsheetRequest_(T.CONSENTS, 'Add', [{
    consent_id:         generateUuid_(),
    application_id:     applicationId,
    consent_type:       'gdpr_data_processing',
    consent_text_shown: gdprText,
    consented:          true,
    consent_timestamp:  now,
    language:           lang,
  }]);

  sendMagicLinkEmail_(p.primary_email, resumeToken, lang, true);
  sendInternalEmail_(
    '[KIS Admissions] New application started',
    buildApplicationInitiatedBody_(applicationId, p.primary_email, now)
  );

  return { application_id: applicationId, resume_token: resumeToken };
}

/**
 * Resends magic link for an existing application.
 * @param {Object} p - { application_id } or { primary_email }
 */
function sendMagicLink_(p) {
  if (p.application_id) {
    // Single-app link (e.g. from within the wizard)
    const rows = appsheetRequest_(T.APPLICATIONS, 'Find', [], {
      Filter: '"application_id" = "' + p.application_id + '"'
    });
    const app = rows && rows[0];
    if (!app) throw new Error('Application not found');
    sendMagicLinkEmail_(app.primary_email, app.resume_token, app.preferred_language || 'es');
  } else if (p.primary_email) {
    // Find all non-submitted applications for this email
    const rows = appsheetRequest_(T.APPLICATIONS, 'Find', [], {
      Filter: '"primary_email" = "' + p.primary_email + '" && ISBLANK([submitted_at])'
    });
    if (!rows || !rows.length) throw new Error('Application not found');
    const apps = rows.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
    const lang = apps[0].preferred_language || 'es';
    const tokens = apps.map(a => a.resume_token);
    sendMagicLinkMultiEmail_(p.primary_email, tokens, lang);
  } else {
    throw new Error('Missing application_id or primary_email');
  }
  return { sent: true };
}

/**
 * Accepts a resume_token and returns the full application state.
 * @param {Object} p - { resume_token }
 * @returns {Object} Full application state including all child records
 */
function resumeApplication_(p) {
  const apps = appsheetRequest_(T.APPLICATIONS, 'Find', [], {
    Filter: '"resume_token" = "' + p.resume_token + '"'
  });
  if (!apps || !apps.length) throw new Error('Invalid or expired resume token');

  const app = apps[0];
  const id  = app.application_id;

  const persons    = appsheetRequest_(T.PERSONS,       'Find', [], { Filter: '"application_id" = "' + id + '"' }) || [];
  const relations  = appsheetRequest_(T.RELATIONS,     'Find', [], { Filter: '"application_id" = "' + id + '"' }) || [];
  const documents  = appsheetRequest_(T.DOCUMENTS,     'Find', [], { Filter: '"application_id" = "' + id + '"' }) || [];
  const responses  = appsheetRequest_(T.QB_RESPONSES,  'Find', [], { Filter: '"respondent_id" = "' + id + '"' }) || [];
  // interview_type is a plain enum string; interviewer_id is a plain email string — no FK resolution
  const interviews = appsheetRequest_(T.INTERVIEWS,    'Find', [], { Filter: '"application_id" = "' + id + '"' }) || [];

  if (!persons.length) {
    return { application: app, persons: [], relations, documents, responses, interviews };
  }

  const personIds = persons.map(per => per.person_id);
  const pidFilter = personIds.map(pid => '"person_id" = "' + pid + '"').join(' || ');

  const nationalities     = appsheetRequest_(T.PERSON_NATIONALITIES, 'Find', [], { Filter: pidFilter }) || [];
  const personIds_        = appsheetRequest_(T.PERSON_IDS,           'Find', [], { Filter: pidFilter }) || [];
  const languages         = appsheetRequest_(T.PERSON_LANGUAGES,     'Find', [], { Filter: pidFilter }) || [];
  const personAddrJoins   = appsheetRequest_(T.PERSON_ADDRESSES,     'Find', [], { Filter: pidFilter }) || [];
  const personEmailJoins  = appsheetRequest_(T.PERSON_EMAILS,        'Find', [], { Filter: pidFilter }) || [];
  const personPhoneJoins  = appsheetRequest_(T.PERSON_PHONES,        'Find', [], { Filter: pidFilter }) || [];
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
    const addrJoin = personAddrJoins.find(r => r.person_id === pid && r.is_primary)
                  || personAddrJoins.find(r => r.person_id === pid)
                  || null;
    return {
      ...person,
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

  return { application: app, persons: enrichedPersons, relations, documents, responses, interviews };
}

/**
 * Partial save for any wizard step.
 * @param {Object} p - { application_id, step, payload }
 */
function saveStep_(p) {
  const { application_id, step, payload } = p;
  if (!application_id || !step || !payload) throw new Error('Missing required fields');

  // Update application record — include step-specific application-level fields
  const appRow = { application_id, updated_at: new Date().toISOString() };
  if (step === 'application') {
    appRow.desired_start_date = payload.desired_start_date || null;
    appRow.source             = payload.source             || 'enrollment_site';
  }
  if (step === 'review') {
    // reviewed_by is always the authenticated staff email — never a client-supplied value
    appRow.reviewed_by   = getStaffEmail_();
    appRow.review_notes  = payload.review_notes || null;
  }
  appsheetRequest_(T.APPLICATIONS, 'Edit', [appRow]);

  switch (step) {
    case 'application':
      // Application-level fields already written above
      break;
    case 'review': {
      // Log the status transition when a status_code is supplied
      if (payload.status_code) {
        const newStatusTypes = appsheetRequest_(T.STATUS_TYPES, 'Find', [], {
          Filter: '"status_code" = "' + payload.status_code + '" && "school_id" = "' + SCHOOL_ID + '"'
        });
        const newStatusTypeId = newStatusTypes && newStatusTypes[0]
          ? newStatusTypes[0].status_type_id : null;
        if (newStatusTypeId) {
          const currentApps = appsheetRequest_(T.APPLICATIONS, 'Find', [], {
            Filter: '"application_id" = "' + application_id + '"'
          });
          const currentApp = currentApps && currentApps[0];
          appsheetRequest_(T.STATUS_LOG, 'Add', [{
            log_id:              generateUuid_(),
            application_id,
            from_status_type_id: currentApp ? currentApp.status_type_id : null,
            to_status_type_id:   newStatusTypeId,
            changed_by:          getStaffEmail_(),
            changed_at:          new Date().toISOString(),
            reason:              payload.reason || null,
          }]);
          appsheetRequest_(T.APPLICATIONS, 'Edit', [{
            application_id,
            status_type_id: newStatusTypeId,
            updated_at:     new Date().toISOString(),
          }]);
        }
      }
      break;
    }
    case 'persons':
      savePersons_(application_id, payload);
      break;
    case 'relations':
      saveRelations_(application_id, payload);
      break;
    case 'health':
      saveHealth_(application_id, payload);
      break;
    case 'interviews':
      saveInterviews_(application_id, payload);
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

  return { saved: true, step };
}

/**
 * Marks application as submitted, logs status change, sends emails.
 * @param {Object} p - { application_id, esignature, consents }
 */
function submitApplication_(p) {
  const { application_id } = p;
  if (!application_id) throw new Error('Missing application_id');

  const now = new Date().toISOString();

  // Look up SUBMITTED status type id
  const statusTypes = appsheetRequest_(T.STATUS_TYPES, 'Find', [], {
    Filter: '"status_code" = "SUBMITTED" && "school_id" = "' + SCHOOL_ID + '"'
  });
  const submittedTypeId = (statusTypes && statusTypes[0]) ? statusTypes[0].status_type_id : null;

  // Get current status for log
  const apps = appsheetRequest_(T.APPLICATIONS, 'Find', [], {
    Filter: '"application_id" = "' + application_id + '"'
  });
  const app = apps && apps[0];
  if (!app) throw new Error('Application not found');

  // Stamp submitted_at and update status
  appsheetRequest_(T.APPLICATIONS, 'Edit', [{
    application_id,
    status_type_id: submittedTypeId,
    submitted_at:   now,
    updated_at:     now,
  }]);

  // Write status log entry
  appsheetRequest_(T.STATUS_LOG, 'Add', [{
    log_id:               generateUuid_(),
    application_id,
    from_status_type_id:  app.status_type_id,
    to_status_type_id:    submittedTypeId,
    changed_by:           getStaffEmail_() || 'applicant',
    changed_at:           now,
    reason:               'Application submitted by family',
  }]);

  const lang = p.language || 'es';

  // Log GDPR consent
  let consentRows = [];
  if (p.consents) {
    consentRows = p.consents.map(c => ({
      consent_id:         generateUuid_(),
      application_id,
      consent_type:       c.type,
      consent_text_shown: c.consent_text_shown || (CONSENT_TEXTS[c.type] && CONSENT_TEXTS[c.type][lang]) || null,
      consented:          c.accepted,
      consent_timestamp:  now,
      language:           lang,
    }));
    if (consentRows.length) appsheetRequest_(T.CONSENTS, 'Add', consentRows);
  }

  // Fetch persons for email summaries and PDF
  const allPersons = appsheetRequest_(T.PERSONS, 'Find', [], { Filter: '"application_id" = "' + application_id + '"' }) || [];
  const guardians  = allPersons.filter(per => per.person_type_id === 'guardian');
  const applicants = allPersons.filter(per => per.person_type_id === 'applicant');

  // Enrich guardians with emails and phones for notifications
  const gPersonIds = guardians.map(g => g.person_id);
  const gEmailJoins = gPersonIds.length
    ? appsheetRequest_(T.PERSON_EMAILS, 'Find', [], {
        Filter: gPersonIds.map(pid => '"person_id" = "' + pid + '"').join(' || ')
      }) || []
    : [];
  const gPhoneJoins = gPersonIds.length
    ? appsheetRequest_(T.PERSON_PHONES, 'Find', [], {
        Filter: gPersonIds.map(pid => '"person_id" = "' + pid + '"').join(' || ')
      }) || []
    : [];

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
    Filter: '"respondent_id" = "' + application_id + '" && (' +
      enrQbIds.map(id => '"question_id" = "' + id + '"').join(' || ') + ')'
  }) || [];
  // Map question_id → last response_text (aggregates multiple if more than one respondent)
  const qbResponseMap = {};
  qbResRows.forEach(r => { qbResponseMap[r.question_id] = r.response_text; });

  // Generate signed consent PDF and record in enrApplicationDocuments
  try {
    const pdfUrl = generateConsentPdf_(application_id, app, enrichedGuardians, applicants, consentRows, p.esignature || '', now, qbResponseMap);
    appsheetRequest_(T.DOCUMENTS, 'Add', [{
      document_id:   generateUuid_(),
      application_id,
      document_type: 'signed_consent_record',
      drive_url:     pdfUrl,
      uploaded_at:   now,
      uploaded_by:   'system',
    }]);
  } catch (pdfErr) {
    Logger.log('PDF generation error (non-fatal): ' + pdfErr.message);
  }

  // Send family confirmation (bilingual)
  sendFamilyConfirmationEmail_(app.primary_email, application_id, applicants, app.preferred_language || 'es');

  // Send internal notification
  sendInternalEmail_(
    '[KIS Admissions] Application submitted \u2014 action required',
    buildApplicationSubmittedBody_(application_id, now, enrichedGuardians, applicants, app, qbResponseMap)
  );

  return { submitted: true, application_id };
}

/**
 * Generates and emails a 6-digit verification code.
 * @param {Object} p - { application_id, primary_email }
 */
function sendVerificationCode_(p) {
  const { application_id, primary_email } = p;
  if (!application_id || !primary_email) throw new Error('Missing application_id or primary_email');

  const code = Math.floor(100000 + Math.random() * 900000).toString();
  const cache = CacheService.getScriptCache();
  cache.put('verify_' + application_id, code, 600); // 10 min TTL

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
 * Verifies a 6-digit code and marks email as confirmed.
 * @param {Object} p - { application_id, code }
 */
function verifyEmail_(p) {
  const { application_id, code } = p;
  if (!application_id || !code) throw new Error('Missing application_id or code');

  const cache    = CacheService.getScriptCache();
  const stored   = cache.get('verify_' + application_id);

  if (!stored) throw new Error('Verification code expired or not found');
  if (stored !== code.toString()) throw new Error('Invalid verification code');

  cache.remove('verify_' + application_id);

  appsheetRequest_(T.APPLICATIONS, 'Edit', [{
    application_id,
    email_confirmed:    true,
    email_confirmed_at: new Date().toISOString(),
    updated_at:         new Date().toISOString(),
  }]);

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

  Logger.log('fetchLookups_ relationTypes raw: ' + JSON.stringify(relationTypes));

  return {
    allergies:     allergies.map(r =>     ({ id: r.row_id, label: r.food_allergy_designation })),
    dietary:       dietary.map(r =>       ({ id: r.row_id, label: r.diet_designation         })),
    medical:       medical.map(r =>       ({ id: r.row_id, label: r.medical_condition_designation })),
    relationTypes: relationTypes.map(r => ({ id: r.row_id })),
  };
}

/**
 * Batch-writes question responses.
 * @param {Object} p - { application_id, respondent_id, respondent_type_category_id, responses: Array }
 */
function saveResponses_(p) {
  const { application_id, respondent_id, respondent_type_category_id, responses } = p;
  if (!responses || !responses.length) return { saved: 0 };

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

  appsheetRequest_(T.QB_RESPONSES, 'Add', rows);
  return { saved: rows.length };
}

/**
 * Accepts a base64-encoded file, saves to Drive, writes document record.
 * @param {Object} p - { application_id, base64, mimeType, filename, document_type }
 * @returns {{ drive_url: string, document_id: string }}
 */
function uploadDocument_(p) {
  const { application_id, base64, mimeType, filename, document_type } = p;
  if (!base64 || !application_id) throw new Error('Missing base64 or application_id');

  const blob   = Utilities.newBlob(Utilities.base64Decode(base64), mimeType, filename);
  const folder = getOrCreateDriveFolder_(DRIVE_FOLDER_NAME);
  const file   = folder.createFile(blob);
  file.setSharing(DriveApp.Access.ANYONE_WITH_LINK, DriveApp.Permission.VIEW);

  const driveUrl   = file.getUrl();
  const documentId = generateUuid_();
  const now        = new Date().toISOString();

  appsheetRequest_(T.DOCUMENTS, 'Add', [{
    document_id:     documentId,
    application_id,
    document_type:   document_type || 'other',
    drive_url:       driveUrl,
    uploaded_at:     now,
    uploaded_by:     'applicant',
  }]);

  return { document_id: documentId, drive_url: driveUrl };
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
 * Upserts persons (guardians and applicants) for an application.
 * Each person may have: nationalities, ids, languages, address, emails, phones.
 * Pass `copy_address_from_person_id` to reuse another person's address.
 * Previous schools are written for applicant-type persons.
 * @param {string} applicationId
 * @param {Array}  persons - array of person objects
 */
function savePersons_(applicationId, persons) {
  if (!Array.isArray(persons)) return;

  const personAddressIds = {}; // person_id → address_id, for address copy resolution

  persons.forEach((person, idx) => {
    const personId    = person.person_id || generateUuid_();
    const now         = new Date().toISOString();
    const isGuardian  = person.person_type_id === 'guardian';
    const isApplicant = person.person_type_id === 'applicant';

    // ── Core person row ───────────────────────────────────────────────────────
    const personRow = {
      person_id:      personId,
      application_id: applicationId,
      person_type_id: person.person_type_id || 'guardian',
      person_order:   idx + 1,
      first_name:     person.first_name     || null,
      middle_name:    person.middle_name    || null,
      last_name:      person.last_name      || null,
      date_of_birth:  person.date_of_birth  || null,
      place_of_birth: person.place_of_birth || null,
      gender:         person.gender         || null,
      created_at:     person.created_at     || now,
    };
    if (person.person_id) {
      appsheetRequest_(T.PERSONS, 'Edit', [personRow]);
    } else {
      appsheetRequest_(T.PERSONS, 'Add', [personRow]);
    }

    // ── Nationalities ─────────────────────────────────────────────────────────
    if (Array.isArray(person.nationalities)) {
      const newNats = person.nationalities.filter(n => !n.record_id).map(n => ({
        record_id:  generateUuid_(),
        person_id:  personId,
        country_id: n.country_id,
        is_primary: n.is_primary || false,
      }));
      if (newNats.length) appsheetRequest_(T.PERSON_NATIONALITIES, 'Add', newNats);
    }

    // ── IDs ───────────────────────────────────────────────────────────────────
    if (Array.isArray(person.ids)) {
      const newIds = person.ids.filter(x => !x.record_id).map(x => ({
        record_id:  generateUuid_(),
        person_id:  personId,
        id_type_id: x.id_type_id,
        id_number:  x.id_number,
        issued_by:  x.issued_by  || null,
        issued_at:  x.issued_at  || null,
        expires_at: x.expires_at || null,
      }));
      if (newIds.length) appsheetRequest_(T.PERSON_IDS, 'Add', newIds);
    }

    // ── Languages ─────────────────────────────────────────────────────────────
    if (Array.isArray(person.languages)) {
      const newLangs = person.languages.filter(x => !x.record_id).map(x => ({
        record_id:         generateUuid_(),
        person_id:         personId,
        language_id:       x.language_id,   // plain free text — no FK/Ref resolution; languages lookup not yet live
        is_mother_tongue:  x.is_mother_tongue || false,
      }));
      if (newLangs.length) appsheetRequest_(T.PERSON_LANGUAGES, 'Add', newLangs);
    }

    // ── Address ───────────────────────────────────────────────────────────────
    let addressId = null;
    if (person.copy_address_from_person_id && personAddressIds[person.copy_address_from_person_id]) {
      addressId = personAddressIds[person.copy_address_from_person_id];
    } else if (person.address && hasAddressData_(person.address)) {
      const newAddressId = generateUuid_();
      appsheetRequest_(T.ADDRESSES, 'Add', [{
        address_id:     newAddressId,
        application_id: applicationId,
        address_line_1: person.address.address_line_1 || null,
        address_line_2: person.address.address_line_2 || null,
        city:           person.address.city           || null,
        province:       person.address.province       || null,
        country_id:     person.address.country_id     || null,
        zip:            person.address.zip            || null,
        created_at:     now,
      }]);
      addressId = newAddressId;
    }
    if (addressId && !person.person_id) {
      appsheetRequest_(T.PERSON_ADDRESSES, 'Add', [{
        record_id:  generateUuid_(),
        person_id:  personId,
        address_id: addressId,
        label:      'home',
        is_primary: true,
      }]);
    }
    personAddressIds[personId] = addressId;

    // ── Emails ────────────────────────────────────────────────────────────────
    if (Array.isArray(person.emails)) {
      person.emails.filter(e => !e.email_id).forEach(e => {
        const emailId = generateUuid_();
        appsheetRequest_(T.EMAILS, 'Add', [{
          email_id:       emailId,
          application_id: applicationId,
          email_address:  e.email_address,
          created_at:     now,
        }]);
        appsheetRequest_(T.PERSON_EMAILS, 'Add', [{
          record_id:     generateUuid_(),
          person_id:     personId,
          email_id:      emailId,
          email_type_id: e.email_type_id || null,
          is_default:    e.is_default    || false,
          is_emergency:  e.is_emergency  || false,
        }]);
      });
    }

    // ── Phones ────────────────────────────────────────────────────────────────
    if (Array.isArray(person.phones)) {
      person.phones.filter(ph => !ph.phone_id).forEach(ph => {
        const phoneId = generateUuid_();
        appsheetRequest_(T.PHONES, 'Add', [{
          phone_id:       phoneId,
          application_id: applicationId,
          phone_number:   ph.phone_number,
          is_whatsapp:    ph.is_whatsapp || false,
          is_telegram:    ph.is_telegram || false,
          created_at:     now,
        }]);
        appsheetRequest_(T.PERSON_PHONES, 'Add', [{
          record_id:     generateUuid_(),
          person_id:     personId,
          phone_id:      phoneId,
          phone_type_id: ph.phone_type_id || null,
          is_default:    ph.is_default    || false,
          is_emergency:  ph.is_emergency  || false,
        }]);
      });
    }

    // ── Previous schools (applicants only) ────────────────────────────────────
    if (isApplicant && Array.isArray(person.previous_schools)) {
      const newSchools = person.previous_schools.filter(s => !s.previous_school_id).map(s => ({
        previous_school_id:          generateUuid_(),
        person_id:                   personId,
        school_name:                 s.school_name || null,
        city:                        s.city || null,
        country_id:                  s.country_id || null,
        from_year:                   s.from_year || null,
        to_year:                     s.to_year || null,
        education_level_description: s.education_level_description || null,
        language_of_instruction:     s.language_of_instruction || null,
      }));
      const existingSchools = person.previous_schools.filter(s => s.previous_school_id);
      if (newSchools.length)      appsheetRequest_(T.PREV_SCHOOLS, 'Add',  newSchools);
      if (existingSchools.length) appsheetRequest_(T.PREV_SCHOOLS, 'Edit', existingSchools);
    }
  });
}

/**
 * Upserts guardian-applicant relations for an application.
 * @param {string} applicationId
 * @param {Array}  relations - [{ guardian_person_id, applicant_person_id, relation_type_id, is_custodial, is_pick_up_authorized }]
 */
function saveRelations_(applicationId, relations) {
  if (!Array.isArray(relations)) return;

  const newRelations = relations.filter(r => !r.relation_id).map(r => ({
    relation_id:           generateUuid_(),
    application_id:        applicationId,
    guardian_person_id:    r.guardian_person_id,
    applicant_person_id:   r.applicant_person_id,
    relation_type_id:      r.relation_type_id      || null,
    is_custodial:          r.is_custodial          || false,
    is_pick_up_authorized: r.is_pick_up_authorized || false,
  }));
  const existingRelations = relations.filter(r => r.relation_id);
  if (newRelations.length)      appsheetRequest_(T.RELATIONS, 'Add',  newRelations);
  if (existingRelations.length) appsheetRequest_(T.RELATIONS, 'Edit', existingRelations);
}

/**
 * Upserts health records for each person.
 * @param {string} applicationId
 * @param {Array}  healthData - [{ person_id, allergies, dietary, medical }]
 */
function saveHealth_(applicationId, healthData) {
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
 * Upserts interview records for an application.
 * interview_type must be one of: family_interview | child_observation | follow_up
 * interviewer_id is a plain email string — written directly, no FK resolution.
 * @param {string} applicationId
 * @param {Array}  interviews - array of interview objects
 */
function saveInterviews_(applicationId, interviews) {
  if (!Array.isArray(interviews)) return;

  const staffEmail = getStaffEmail_();
  const now        = new Date().toISOString();

  const VALID_TYPES = ['family_interview', 'child_observation', 'follow_up'];

  const newInterviews = interviews.filter(i => !i.interview_id).map(i => ({
    interview_id:   generateUuid_(),
    application_id: applicationId,
    interview_type: VALID_TYPES.includes(i.interview_type) ? i.interview_type : null,
    interview_date: i.interview_date  || null,
    interviewer_id: i.interviewer_id  || staffEmail,  // plain email — no FK resolution
    format:         i.format          || null,
    risk_rating:    i.risk_rating     || null,
    notes:          i.notes           || null,
    flags:          i.flags           || null,
    created_at:     now,
  }));

  const existingInterviews = interviews.filter(i => i.interview_id).map(i => ({
    interview_id:   i.interview_id,
    application_id: applicationId,
    interview_type: VALID_TYPES.includes(i.interview_type) ? i.interview_type : null,
    interview_date: i.interview_date  || null,
    interviewer_id: i.interviewer_id  || staffEmail,  // plain email — no FK resolution
    format:         i.format          || null,
    risk_rating:    i.risk_rating     || null,
    notes:          i.notes           || null,
    flags:          i.flags           || null,
  }));

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
 */
function sendFamilyConfirmationEmail_(email, applicationId, applicants, lang) {
  const names = applicants.map(a => (a.first_name || '') + ' ' + (a.last_name || '')).join(', ');

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
      (e.email_address || '') + (e.is_emergency ? ' <span style="background:#fff3ec;color:#c05800;padding:1px 5px;border-radius:3px;font-size:0.75em">Emergency</span>' : '')
    ).filter(e => e.trim()).join(', ');
    const phones = (g.phones || []).map(ph =>
      (ph.phone_number || '') + (ph.is_whatsapp ? ' \uD83D\uDCAC' : '') + (ph.is_telegram ? ' \u2708\uFE0F' : '')
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
function appsheetRequest_(table, action, rows, selector) {
  const props  = PropertiesService.getScriptProperties();
  const appId  = props.getProperty('APPSHEET_APP_ID');
  const apiKey = props.getProperty('APPSHEET_ACCESS_KEY');

  if (!appId || !apiKey) throw new Error('AppSheet credentials not configured in Script Properties');

  const url  = APPSHEET_BASE_URL + appId + '/tables/' + encodeURIComponent(table) + '/Action';
  const body = { Action: action, Properties: { Locale: 'en-US' } };

  if (rows && rows.length > 0) body.Rows = rows;
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

  Logger.log('AppSheet ' + action + ' ' + table + ' → HTTP ' + statusCode + ' | ' + text.slice(0, 400));

  if (statusCode < 200 || statusCode >= 300) {
    throw new Error('AppSheet API error ' + statusCode + ' on ' + table + '/' + action + ': ' + text);
  }

  try {
    const parsed = JSON.parse(text);
    // AppSheet sometimes returns HTTP 200 with an error payload
    if (parsed && typeof parsed.error === 'string') {
      throw new Error('AppSheet error on ' + table + '/' + action + ': ' + parsed.error);
    }
    const resultRows = parsed.Rows || parsed.rows || null;
    // Warn if an Add/Edit returned no rows — indicates a silent rejection
    if ((action === 'Add' || action === 'Edit') && rows && rows.length > 0 && resultRows && resultRows.length === 0) {
      Logger.log('AppSheet warning: ' + action + ' on ' + table + ' sent ' + rows.length + ' row(s) but got 0 back — possible validation failure');
    }
    return resultRows || parsed || null;
  } catch (e) {
    if (e.message.startsWith('AppSheet')) throw e;
    return null;
  }
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
 * @param {Array}  consentRows   - Consent rows as written to enrConsentsLog
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
      (e.email_address || '') + (e.is_emergency ? ' [Emergency]' : '')
    ).filter(e => e.trim()).join(', ');
    const phones = (g.phones || []).map(ph =>
      (ph.phone_number || '') + (ph.is_whatsapp ? ' (WhatsApp)' : '') + (ph.is_telegram ? ' (Telegram)' : '')
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

  return pdfFile.getUrl();
}

// ─── Promotion logic ──────────────────────────────────────────────────────────

/**
 * Promotes a submitted application into the main SMS.
 * Checks application.source to determine promotion scope:
 *   - enrollment_site: promote all persons (guardians + applicants) to SMS
 *   - families_app: skip guardian promotion (they already exist); only promote
 *     the applicant(s) and create relationalRecords linking them to existing
 *     guardian personal_ids.
 *
 * For each promoted person, copies their primary address to addresses_S + addressLog.
 * Stores desired_start_date as a note on personCategoriesLog for each applicant.
 *
 * @param {Object} p - { application_id, person_personal_ids }
 *   person_personal_ids: { [enr_person_id]: sms_personal_id }
 *     For enrollment_site: include all persons.
 *     For families_app: include guardian existing personal_ids AND new applicant personal_ids.
 */
function promoteApplication_(p) {
  const { application_id, person_personal_ids = {} } = p;
  if (!application_id) throw new Error('Missing application_id');

  const now = new Date().toISOString();

  // Fetch application to determine source and desired_start_date
  const apps = appsheetRequest_(T.APPLICATIONS, 'Find', [], {
    Filter: '"application_id" = "' + application_id + '"'
  });
  const appRow = apps && apps[0];
  if (!appRow) throw new Error('Application not found');

  const source           = appRow.source || 'enrollment_site';
  const desiredStartDate = appRow.desired_start_date || null;

  const allPersonIds = Object.keys(person_personal_ids);
  if (!allPersonIds.length) return { promoted_addresses: 0 };

  // Fetch persons to distinguish guardians from applicants
  const allPersons = appsheetRequest_(T.PERSONS, 'Find', [], {
    Filter: allPersonIds.map(pid => '"person_id" = "' + pid + '"').join(' || ')
  }) || [];

  const guardianPersonIds  = allPersons.filter(p => p.person_type_id === 'guardian').map(p => p.person_id);
  const applicantPersonIds = allPersons.filter(p => p.person_type_id === 'applicant').map(p => p.person_id);

  // Determine which persons to promote addresses for
  const promotePersonIds = source === 'families_app'
    ? applicantPersonIds   // guardians already in SMS
    : allPersonIds;        // promote everyone

  // Find primary address for each person to promote
  const addrJoins = promotePersonIds.length
    ? appsheetRequest_(T.PERSON_ADDRESSES, 'Find', [], {
        Filter: promotePersonIds.map(pid => '"person_id" = "' + pid + '"').join(' || ')
      }) || []
    : [];

  const personAddrMap = {};
  addrJoins.forEach(j => {
    if (!personAddrMap[j.person_id] || j.is_primary) {
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
    const personalId = person_personal_ids[personId];
    const addrId     = personAddrMap[personId];
    const addr       = addrId ? addressMap[addrId] : null;
    if (!addr) return;

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

  // For families_app: create relationalRecords linking new applicants to existing guardians
  const relationalRecords = [];
  if (source === 'families_app' && applicantPersonIds.length && guardianPersonIds.length) {
    // Fetch enrRelations to get guardian ↔ applicant relationships
    const relations = appsheetRequest_(T.RELATIONS, 'Find', [], {
      Filter: '"application_id" = "' + application_id + '"'
    }) || [];

    relations.forEach(rel => {
      const guardianPersonalId  = person_personal_ids[rel.guardian_person_id];
      const applicantPersonalId = person_personal_ids[rel.applicant_person_id];
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
  }

  // Store desired_start_date for admissions team on personCategoriesLog for each applicant
  const categoryLogs = [];
  if (desiredStartDate) {
    applicantPersonIds.forEach(personId => {
      const personalId = person_personal_ids[personId];
      if (!personalId) return;
      categoryLogs.push({
        person_category_log_id: generateUuid_(),
        school_id:              SCHOOL_ID,
        personal_id:            personalId,
        person_category_id:     'applicant',
        status_date:            desiredStartDate,
        last_known_status:      'desired_start: ' + desiredStartDate,
      });
    });
    if (categoryLogs.length) {
      appsheetRequest_(T.SMS_PERSON_CATEGORIES, 'Add', categoryLogs);
    }
  }

  // Log promotion as a status transition
  const promotedStatusTypes = appsheetRequest_(T.STATUS_TYPES, 'Find', [], {
    Filter: '"status_code" = "PROMOTED" && "school_id" = "' + SCHOOL_ID + '"'
  });
  const promotedTypeId = promotedStatusTypes && promotedStatusTypes[0]
    ? promotedStatusTypes[0].status_type_id : null;
  if (promotedTypeId) {
    appsheetRequest_(T.STATUS_LOG, 'Add', [{
      log_id:              generateUuid_(),
      application_id,
      from_status_type_id: appRow.status_type_id || null,
      to_status_type_id:   promotedTypeId,
      changed_by:          getStaffEmail_(),
      changed_at:          now,
      reason:              'Application promoted to SMS',
    }]);
    appsheetRequest_(T.APPLICATIONS, 'Edit', [{ application_id, status_type_id: promotedTypeId, updated_at: now }]);
  }

  // Stamp promoted_at on the application
  appsheetRequest_(T.APPLICATIONS, 'Edit', [{
    application_id,
    promoted_at: now,
    updated_at:  now,
  }]);

  return {
    promoted_addresses:   smsAddresses.length,
    relational_records:   relationalRecords.length,
    category_log_entries: categoryLogs.length,
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
