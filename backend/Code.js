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

// ─── Tipos de consentimiento: el catálogo manda, y no se inventa ninguno ─────
//
// Aquí vivía, DENTRO de `submitEnrollmentSession_`, esto:
//
//     function canonicalConsentType_(raw) {
//       return CONSENT_TYPE_MAP[raw] || raw.toUpperCase();
//     }
//
// Ese `|| raw.toUpperCase()` **fabricaba un código de catálogo**: cualquier cadena que
// llegara sin correspondencia se convertía en un «código» y se ESCRIBÍA en
// `sysConsentsLog` — el libro que existe para probar qué consintió una familia. Y este
// backend es `ANYONE_ANONYMOUS`: cualquiera podía elegir el código.
//
// MEDIDO en la base antes de tocar nada (2026-08-04, consulta a `sysConsentsLog`): de
// 1.175 filas vivas, **12 con `consent_type='LEGAL'`** — un código que NO está en el
// catálogo Capa 2 (`kis-app/config/sys-consent-types.json`) y que **nadie lee** (grep en
// los dos repositorios: cero lectores). Salía del `type:'legal'` del paso 7, que no es un
// consentimiento sino la **atestación de exactitud** de la solicitud.
//
// Ahora: correspondencia EXPLÍCITA o error accionable. Nunca un código inventado, y nunca
// «otro valor por defecto» —que sería el mismo defecto con otra cara—. La atestación se
// EXIGE (el servidor pide lo mismo que la pantalla) pero no se registra como consentimiento:
// darle un código de catálogo propio sería inventarse una entrada del catálogo.
//
// El catálogo Capa 2 vive en el KMS; esta lista es su espejo y la comprobación
// `scripts/comprobar-codigos-de-consentimiento.mjs` exige que todo lo que este mapa emite
// esté dentro de ella.
var CATALOGO_CONSENT_TYPES = ['GDPR_SCHOOL', 'IMAGE_RIGHTS', 'COMMERCIAL_COMMS', 'PLATFORM_GROUPS',
                              'SOLE_GUARDIAN_ATTESTATION', 'PARENTAL_AUTHORITY'];

// Tipos que manda el cliente → código del catálogo. `gdpr_data_processing` es alias viejo.
//
// DL-E49 §3 (2026-08-09) — las DECLARACIONES del paso 2 (tutor único · patria potestad) se
// registran en el libro de consentimientos como lo que son: el texto exacto aceptado, quién
// y cuándo. No son consentimientos de tratamiento —nada se bloquea por su valor— pero SÍ son
// registro legal, y por eso tienen código de catálogo propio en vez de quedarse en una
// casilla suelta que no lee nadie (que es lo que había: `sole_guardian_*`, cero lectores).
var CONSENT_TYPE_MAP = {
  gdpr:                       'GDPR_SCHOOL',
  gdpr_data_processing:       'GDPR_SCHOOL',
  image_rights:               'IMAGE_RIGHTS',
  commercial_comms:           'COMMERCIAL_COMMS',
  platform_groups:            'PLATFORM_GROUPS',
  sole_guardian_attestation:  'SOLE_GUARDIAN_ATTESTATION',
  parental_authority:         'PARENTAL_AUTHORITY',
};

// Declaraciones que NO son consentimientos: se exigen, pero no van al libro de
// consentimientos porque no tienen (ni deben inventarse) un código de catálogo.
var DECLARACIONES_NO_CONSENTIMIENTO = { legal: 'atestación de exactitud de la solicitud' };

/**
 * Resuelve el código de catálogo de un tipo de consentimiento del cliente.
 *
 * @param {string} raw
 * @returns {string|null} el código del catálogo, o `null` si es una declaración que NO es
 *                        un consentimiento (y por tanto NO se registra).
 * @throws  {Error} `UNKNOWN_CONSENT_TYPE` si no tiene correspondencia — jamás se inventa.
 */
function wizardCodigoDeConsentimiento_(raw) {
  var clave = String(raw == null ? '' : raw).trim();
  if (Object.prototype.hasOwnProperty.call(CONSENT_TYPE_MAP, clave)) return CONSENT_TYPE_MAP[clave];
  if (Object.prototype.hasOwnProperty.call(DECLARACIONES_NO_CONSENTIMIENTO, clave)) return null;
  var e = new Error('Tipo de consentimiento sin correspondencia en el catálogo: "' + clave + '". ' +
    'La solicitud no se envía: un consentimiento solo se registra con un código del catálogo, ' +
    'nunca con uno inventado. Códigos válidos: ' + CATALOGO_CONSENT_TYPES.join(', ') + '.');
  e.code = 'UNKNOWN_CONSENT_TYPE';
  throw e;
}

// ②17 (2026-08-15) — aquí vivían los cuatro identificadores fijos de las preguntas de
// profesión, empleador y adaptación. Se retiran con la isla que los usaba: su único
// lector era la lectura del envío que nadie consumía, y el único constructor que los
// pintaba (`buildApplicationSubmittedBody_`) se quedó sin llamantes al retirarse el PDF
// del envío (P262) y los dos correos (2026-08-07). Las preguntas siguen existiendo en el
// banco y el asistente las sigue pintando: lo que se retira es la copia de sus
// identificadores en el código, que ya no la mira nadie.

// ─── DL-E39 PII-primero — step-up re-auth (Fase A) ──────────────────────────
// Step-up = prueba-de-acceso-al-inbox (código fresco 6-díg al buzón) que
// compensa el resume_token largo (7 días, reutilizable). Una ventana DURA:
// tras un verifyEmail_ con stepup=true (o el consumo single-use de la gracia de
// magic-link) marcamos el grupo como "fresco" durante STEPUP_INACTIVITY_MS; los
// handlers que revelan/mutan PII sensible exigen esa marca fresca
// (assertStepUpFresh_). Reutiliza sendVerificationCode_/verifyEmail_ (endurecidos
// KAL-NEW-2) — NO hay token ni endpoint nuevo.
//
// ★ LA VENTANA SE MIDE DESDE LA ÚLTIMA ACCIÓN REAL DE UNA PERSONA (Diego, 2026-08-20).
// Son 10 minutos de INACTIVIDAD, no 10 minutos de reloj: mientras alguien esté
// clicando, tecleando o cambiando de paso, el contador se reinicia y no se le vuelve a
// pedir el código. Quien deja de tocar la pantalla 10 minutos, sí. Cita literal:
// «Es muy incómodo para las familias tener que estar pidiendo el código cada 10 minutos
// […] Cada acción del usuario debe reiniciar el contador de 10 minutos».
//
// ⚠️ ESTO NO REABRE SEC-STEPUP (finding #55, 2026-06-11), y la diferencia es EL SUJETO.
// Lo que #55 cerró fue que el PULSO AUTOMÁTICO (`getAdmissionState`, que late solo cada
// pocos segundos) y cada save re-extendieran la marca: una pestaña abierta y SOLA se
// quedaba viva indefinidamente, y una RECARGA dentro de esa ventana entraba SIN código.
// Aquí la ventana la estira ÚNICAMENTE `refrescarVentanaDeInactividad_`, que la persona
// dispara con su actividad — el pulso y los saves siguen SIN tocarla, y se afirma en
// `getAdmissionState_`. Y la recarga queda MÁS cerrada que antes de este cambio: la
// marca va atada a una HUELLA DE PÁGINA VIVA que el navegador acuña en memoria de
// JavaScript y solo ahí (ni `sessionStorage` ni `localStorage`), así que una recarga la
// pierde, no la puede presentar y vuelve a pedir el código. Antes de hoy, una recarga
// dentro de los 10 minutos entraba sin pedir nada.
//
// Las TRES reglas que sostienen esto, y ninguna es opcional:
//   (1) la marca NACE solo en re-verificación real — OTP acertado o gracia del enlace;
//   (2) `refrescarVentanaDeInactividad_` EXTIENDE, JAMÁS CREA: sobre una marca caducada
//       lanza STEPUP_REQUIRED (no se resucita nada sin acreditar el buzón), y conserva
//       intactos el buzón (②24) y la huella de página con los que nació;
//   (3) el pulso es LECTURA: reporta la frescura vigente y su tiempo restante.
// (El resume_token TTL de 7 días sigue siendo el TTL de sesión; este es el TTL corto de
// re-verificación.)
const STEPUP_INACTIVITY_MS = 10 * 60 * 1000; // 10 min DESDE LA ÚLTIMA ACCIÓN REAL
// ⛔ TECHO ABSOLUTO desde que la familia tecleó el código (Diego, 2026-08-20). La ventana de
// arriba se REINICIA con la actividad; ésta NO se reinicia con nada. Sin ella, quien tuviera el
// enlace de una familia mientras hubiera una marca viva podía mantenerla indefinidamente
// —hasta los 7 días del propio enlace— sin más que pedir el refresco cada pocos minutos, porque
// la comprobación de la página viva es COMODÍN cuando el llamante no manda el dato (deliberado:
// sin ese comodín un paquete viejo en caché dejaría fuera a familias reales). Antes de que la
// ventana deslizara, la exposición estaba acotada a 10 min por verificación; el techo la
// devuelve a estar acotada. 2 h porque nadie rellena la solicitud dos horas seguidas.
const STEPUP_TECHO_MS = 2 * 60 * 60 * 1000; // 2 h DESDE LA VERIFICACIÓN, pase lo que pase

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
  // NEAE staging (Necesidades Específicas de Apoyo Educativo, RGPD Art. 9).
  // Captured in the Paso 4 "Salud y apoyo" sub-section (family declaration,
  // no signature). Append-only (DL-E16). Promoted to core neaeConditionsLog /
  // neaeSupportLog by the KMS (separate wave). Design: kis-app
  // docs/kms/design/neae-module-2026-07-12.md §5.
  PERSON_NEAE:          'enrPersonNeae',
  PERSON_NEAE_SUPPORT:  'enrPersonNeaeSupport',
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
  // ②17 (decimocuarto tramo, 2026-08-16): MILESTONES / MILESTONE_TYPES RETIRADOS del
  // catálogo. Los añadió P237 para que `resolveSigningToken_` derivase aquí los cuatro
  // indicadores de paso (facturación / consentimientos / revisión / firmado); hoy los
  // resuelve el KMS y **ningún sitio de este fichero los nombra ya** (medido: 0 usos).
  // Las dos de firma SÍ se quedan: las usa el diagnóstico de editor del gate de firma.
  SIGNING_SESSION_SIGNERS:   'sysSigningSessionSigners',
  SIGNING_SESSIONS:          'sysSigningSessions',
  // Lookup / reference tables
  LOOKUP_RELATION_TYPES:  'relationTypes',
};

// ─── Quién sigue en la solicitud y quién la familia ya quitó ────────────────────
//
// UN SOLO SITIO lo decide. Antes no lo decidía NADIE en el asistente: cada lectura
// de `enrPersons` se traía TODA persona que alguna vez estuvo en el expediente,
// incluidas las que la familia había quitado con `enr.wizardRetirar`. Consecuencias
// medidas el 2026-08-09 sobre datos reales (166 personas): 134 retiradas, 83 tutores
// retirados sin teléfono vivo, y **57 de 67 expedientes bloqueados** — la puerta del
// teléfono del envío le exigía un número a gente que ya no está, y tumbaba el envío
// entero aunque los tutores que quedan lo tuvieran todo correcto.
//
// El criterio se COPIA del KMS, que ya lo aplica en todas partes y es el lector
// probado: `!fila.deleted_at && fila.is_active !== false`
// (kis-app kms-server/enr/retirada.gs:365-367, enr/wizard-gateway.gs:1523,:1819).
// La única diferencia es la lectura del booleano: el KMS lo recibe ya normalizado y
// el asistente lo recibe crudo de AppSheet, que devuelve 'FALSE' como TEXTO.
//
// Nota medida: `enrPersons` NO tiene columna `is_active` (38 columnas, sin ella) —
// para personas manda `deleted_at`. La rama de `is_active` está porque otras tablas
// del asistente SÍ se retiran así, mientras no tengan el bloque de borrado lógico
// (retirada.gs:136-140), y el mismo ayudante las sirve a todas.

/**
 * ¿Esta fila sigue viva en el expediente?
 * @param {Object} fila fila cruda de AppSheet.
 * @return {boolean} false si la familia la quitó (o el KMS la desactivó).
 */
function wizardFilaViva_(fila) {
  if (!fila) return false;
  if (String(fila.deleted_at || '').trim()) return false;
  var act = fila.is_active;
  if (act === false) return false;
  var s = String(act === undefined || act === null ? '' : act).trim().toUpperCase();
  if (s === 'FALSE' || s === 'N' || s === 'NO' || s === '0') return false;
  return true;
}

/**
 * Quita de una lista de filas las que la familia ya quitó.
 * TODA lectura de personas / teléfonos / correos / vínculos del asistente pasa por aquí.
 * @param {Array<Object>} filas
 * @return {Array<Object>} solo las vivas (nunca null).
 */
function wizardSoloVivas_(filas) {
  return (filas || []).filter(wizardFilaViva_);
}

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
 * @param {string} resumeToken  bearer del grupo — el KMS deriva el group server-side (KAL-4)
 * @param {{attested:boolean, attestant_guardian?:string, attested_at?:string, attestation_version?:string}} att
 */
function persistSoleGuardianAttestation_(resumeToken, att) {
  if (!att || att.attested !== true) return;
  try {
    // P1-B (WIZARD-DIRECT-WRITE-MIGRATION): la escritura se porta al KMS (único escritor).
    // KAL-4: el grupo lo deriva el KMS del resume_token, no viaja ningún group_id.
    // Best-effort preservado: columnas sole_guardian_* quizá no creadas aún (P72) — el
    // KMS reporta persisted:false sin lanzar; cualquier otro fallo cae a este catch.
    const res = kmsProxy_('enr.wizardPersistAttestation', {
      resume_token:        resumeToken,
      attested:            true,
      attested_at:         att.attested_at || new Date().toISOString(),
      attestant_guardian:  att.attestant_guardian || null,
      attestation_version: att.attestation_version || null,
    });
    Logger.log(redact_('[persistSoleGuardianAttestation_] atestación tutor único → KMS persisted=' +
      (res && res.persisted) + ' attestant=' + (att.attestant_guardian || '?') + ' ver=' + (att.attestation_version || '?')));
  } catch (e) {
    // No rompe el flujo (regla "la falta de columna AppSheet NO congela"). Log redactado.
    Logger.log(redact_('[persistSoleGuardianAttestation_] best-effort fail (KMS proxy): ' + e.message));
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
 *
 * ★ 0º.quindecies (2026-08-21) — el acierto ARCHIVA TAMBIÉN LA FICHA, no solo el id, y
 * la deja en la memoria de EJECUCIÓN (`_memoCabeceraEjecucion_`, clave `estricto` —
 * ②17 duodécimo/2026-08-19 tramos). Medido en el registro real de Diego (2026-08-20):
 * `getAdmissionState_` empieza llamando A ESTA función, y cuando acierta (caso normal:
 * la familia ya llevaba activa unos segundos) el id vuelve en <1 ms — pero la memoria de
 * ejecución quedaba VACÍA porque solo la escribe el camino VIVO. Más abajo, en la MISMA
 * petición, `_expedienteDelToken_` volvía a preguntarle al KMS por la MISMA ficha
 * (`enr.wizardExpedienteDelToken`, 12,45 s medidos) SOLO porque su memoria no la
 * encontraba — el acierto de aquí no la había dejado. Con la ficha dentro del acierto,
 * ese segundo viaje se ahorra entero.
 *
 * ⛔ SOLO se archiva bajo la clave ESTRICTA, nunca la tolerante — mismo criterio EXACTO
 * que el camino vivo (ver el comentario de `requireResumeToken_` junto a esa escritura):
 * lo que vuelve de aquí YA pasó los tres rechazos de la puerta estricta (si no, habría
 * lanzado), así que archivarlo como estricto no cambia ni un rechazo.
 * ⛔ El TTL y el criterio de invalidación NO cambian: sigue siendo la MISMA entrada
 * `rtmemo_` de 300 s, sin invalidación explícita — el lag aceptado es el de siempre.
 * Un acierto con la forma VIEJA (solo el id, de una entrada sembrada antes de este
 * cambio) se trata como acierto sin ficha — degrada al comportamiento de ayer, nunca
 * revienta.
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
      let hitParsed = null;
      try { hitParsed = JSON.parse(hit); } catch (eParse) { hitParsed = null; }
      const hitGid = (hitParsed && hitParsed.gid) ? hitParsed.gid : (hitParsed ? null : hit);
      if (hitGid) {
        // Cross-group guard — paridad EXACTA con requireResumeToken_ (KAL-4).
        const payloadGroupId = payload && (payload.enrollment_group_id || payload.application_id);
        if (payloadGroupId && payloadGroupId !== hitGid) {
          throw new Error('Unauthorized: payload enrollment_group_id does not match resume_token grant');
        }
        if (hitParsed && hitParsed.fila) {
          _memoCabeceraEjecucion_[_memoCabeceraClave_(token, false)] = hitParsed.fila;
        }
        return hitGid;
      }
    }
  } catch (e) {
    if (e && /Unauthorized/.test(e.message || '')) throw e;
    // assert/cache falló → camino vivo (degradación limpia)
  }
  const groupId = requireResumeToken_(payload);
  try {
    if (cache && key) {
      const filaViva = _memoCabeceraEjecucion_[_memoCabeceraClave_(token, false)] || null;
      cache.put(key, JSON.stringify({ gid: groupId, fila: filaViva }), 300);
    }
  } catch (e2) { /* best-effort */ }
  return groupId;
}

function requireResumeToken_(payload, opciones) {
  _dbgEv_('gate', 'requireResumeToken (live)');
  const token = payload && payload.resume_token;
  assertValidUuid_(token, 'resume_token');

  // ②17 (DUODÉCIMO tramo) — la cabecera la sirve el KMS, por el lector ÚNICO
  // `_expedienteDelToken_`. Esta era la lectura directa a `enrEnrollmentGroups` MÁS LLAMADA
  // del asistente: la hacía este proceso, que es PÚBLICO y ANÓNIMO, con la credencial de
  // AppSheet de la aplicación entera (la que alcanza cualquier tabla, porque la URL lleva la
  // tabla como parámetro). Ahora cruzan SIETE campos, no la fila con `magic_link_token`.
  //
  // MODO TOLERANTE, y es lo que permite que LA DECISIÓN NO SE MUEVA: el KMS devuelve la fila
  // aunque el token esté caducado o la sesión abandonada, y los rechazos de abajo —con sus
  // mensajes EXACTOS, el de caducidad incluido (①22)— se siguen aplicando AQUÍ, verbatim.
  // Si la puerta del KMS rechazara antes, no se podría distinguir «caducado» de «no existe»
  // y la familia con la solicitud caducada leería el mensaje equivocado.
  //
  // ★ 0º.bis (2026-08-20) — si el payload YA trae el discriminador de identidad (`n` del
  // enlace, o `recovered_email` del cliente), se pregunta en la MISMA llamada: la puerta es
  // el PRIMER sitio de la petición que ve este payload, y la mayoría de sus llamantes piden
  // la identidad justo después (`_identidadDelEnlace_`, el patrón `assertStepUpFresh_` de
  // ②27). Precedencia n > recovered_email — la misma de `effectiveRecoveredEmail_`; sin
  // discriminador, cero cambio (ni un campo de más en el cuerpo que sale hacia el KMS).
  const nDiscPuerta = payload && payload.n ? String(payload.n).trim() : '';
  const correoDiscPuerta = (!nDiscPuerta && payload && payload.recovered_email)
    ? String(payload.recovered_email).toLowerCase().trim() : '';
  // ★ `0º.quindecies` hallazgo (2) (2026-08-23) — mismo motivo y mismo molde que la línea de
  // arriba, para las DOS comprobaciones previas a subir un documento. **Se declara en el
  // SEGUNDO ARGUMENTO, no se lee del payload**: así solo la pide `uploadDocument_`, que es
  // quien la necesita, y ninguna otra acción puede provocarla metiendo una marca en su
  // cuerpo. Sin `opciones`, cero cambio — ni un campo de más hacia el KMS.
  const subidaPuerta = (opciones && opciones.comprobarSubida) || null;
  const consulta = _expedienteDelToken_(token, {
    tolerarSesionCerrada: true,
    n: nDiscPuerta || null,
    correo: correoDiscPuerta || null,
    comprobarSubida: subidaPuerta,
  });
  if (!consulta.ok && !consulta.rechazo) {
    // NO se pudo PREGUNTAR (transporte). Se LANZA —como lanzaba `appsheetRequest_`, que aquí
    // no estaba envuelto en `try`— pero NUNCA como «no autorizado»: decirle a una familia
    // legítima que su enlace no vale porque el KMS está caído es peor que el fallo.
    const errT = new Error('No se pudo comprobar el enlace ahora mismo; inténtalo de nuevo en un momento');
    errT.code = 'KMS_UNREACHABLE';
    throw errT;
  }
  const group = consulta.fila;
  if (!group) {
    // `consulta.rechazo` (el KMS dijo que ese token no vale) o fila ausente ⇒ mismo mensaje
    // que daba el `!rows.length` de la lectura directa.
    throw new Error('Unauthorized: resume_token not recognized');
  }

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
      throw new Error('Unauthorized: resume_token expired (7 days); the family requests a new link from the start page by entering their email (that also resets the 7-day clock)');
    }
  }

  const tokenGroupId = group.enrollment_group_id;
  // ②17 (DUODÉCIMO tramo) — memoria de EJECUCIÓN: la fila que la puerta acaba de validar
  // queda disponible para `assertGroupEditable_`, que era la SEGUNDA lectura de esta MISMA
  // fila en la MISMA petición. No es caché (muere con la ejecución) y no es un segundo
  // resolvedor: es esta misma fila, ya autorizada por el token.
  _memoCabeceraEjecucion_[tokenGroupId] = group;
  // ②17 (2026-08-19) — MISMA memoria, MISMA escritura, SEGUNDO índice: por TOKEN, que es
  // como la pide `_expedienteDelToken_`. Sin él, la MISMA ficha se volvía a pedir al KMS
  // más abajo en la MISMA petición (13-31 s cada vez: `hydrateSession`, `warmBundle`,
  // `warmSession`).
  //
  // ⛔ SE ARCHIVA COMO ESTRICTA, Y ESO HAY QUE PODER DEMOSTRARLO. La fila se pidió en modo
  // tolerante (arriba), pero justo aquí ACABAN de aplicarse los TRES rechazos —token que no
  // resuelve · sesión abandonada · caducada a los 7 días salvo enviada— que son, VERBATIM,
  // los tres que la puerta estricta del KMS aplica sobre esta misma fila
  // (`enr_resolveWizardSession_`, del que este gate es espejo declarado). Habiendo pasado
  // los tres, una consulta estricta habría devuelto exactamente esto. Por eso, y SOLO por
  // eso, puede archivarse bajo la clave estricta.
  //
  // ⛔ Si algún día se AFLOJA cualquiera de los tres rechazos de arriba, esta línea deja de
  // ser cierta y hay que quitarla: pasaría a servirle a un llamante estricto una fila que el
  // KMS habría rechazado. La modalidad tolerante ya la archivó `_expedienteDelToken_`.
  _memoCabeceraEjecucion_[_memoCabeceraClave_(token, false)] = group;
  // SPEC-WIZ-WARMUP-V2: poblar el memo de LECTURA (rtmemo_) tras la validación
  // VIVA — así la primera llamada de lectura posterior (getDocument_) ya tiene el
  // gate caliente sin pagar otra lectura AppSheet. Best-effort; no cambia la
  // semántica de validación de NINGÚN caller (esto ES el resultado en vivo).
  //
  // ★ 0º.quindecies (2026-08-21) — lleva la FICHA, no solo el id. Este tramo es el
  // camino VIVO: lo recorre TODO llamante (mutaciones incluidas, vía requireResumeToken_
  // directo — nunca requireResumeTokenMemo_) cada vez que el acierto de caché de arriba
  // falla. Si aquí se siguiera guardando solo el id, una mutación (uploadDocument_, que
  // valida SIEMPRE en vivo, nunca por memo) dejaría la entrada de 300s en la forma VIEJA,
  // y el pulso que la siga (getAdmissionState_, que SÍ usa el memo) heredaría un acierto
  // sin ficha — exactamente el caso medido en el registro real de Diego, donde
  // uploadDocument_ y getAdmissionState_ caían en la MISMA ventana de 90 s. Con la ficha
  // aquí también, cualquier caller en vivo deja la caché lista para el memo que venga
  // detrás, sea cual sea el que la escribió primero.
  try {
    CacheService.getScriptCache().put(
      'rtmemo_' + sha256Hex_(Utilities.newBlob(String(payload.resume_token).trim()).getBytes()).slice(0, 40),
      JSON.stringify({ gid: tokenGroupId, fila: group }), 300);
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
    // ②17 (noveno tramo): la resolución la hace el KMS; aquí solo se decide la precedencia.
    const effEmail = effectiveRecoveredEmail_(payload.resume_token, payload.recovered_email, payload.n);
    if (!effEmail) {
      // Sin `n` del enlace NI recovered_email del cliente → no se puede identificar al
      // guardian. Caer a (b) si hay signing_token; si no, error explícito.
      const err = new Error('Unauthorized: no se pudo identificar al firmante (falta `n` del enlace o recovered_email)');
      err.code = 'UNAUTHORIZED';
      throw err;
    }
    const guardianId = resolveGuardianForRecovery_(payload.resume_token, effEmail);
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
    const effEmail = effectiveRecoveredEmail_(payload.resume_token, payload.recovered_email, payload.n);
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
// The "reopen" branch is server-side already: `hydrateSession_` (el camino VIVO)
// anula `submitted_at` en la respuesta cuando la fase del expediente es editable
// — busca REOPEN-FIX en este mismo fichero. So checking submitted_at alone is
// sufficient: when the KMS reopens an application, the next hydrate sees
// submitted_at as null and the wizard becomes editable again.
// (②17, 2026-08-15: esto lo hacía ADEMÁS `resumeSession_`, retirado — era un
//  segundo lector de la hidratación y el frontal no lo llamaba.)
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
  // ②17 (DUODÉCIMO tramo) — CERO lecturas: esta era la SEGUNDA lectura de la MISMA fila en
  // la MISMA petición. Sus CINCO llamantes van inmediatamente precedidos de
  // `requireResumeToken_` (medido contra `origin/main`), que ya la trae de la puerta y la
  // deja en la memoria de EJECUCIÓN.
  //
  // ⛔ Si no está, se FALLA CERRADO con el MISMO error de siempre. NUNCA se vuelve a leer
  // por el identificador: derivar el expediente de un id es lo que KAL-4 prohíbe, y aquí el
  // id llega como argumento — un lector por id sería una puerta trasera a esa regla.
  const group = _memoCabeceraEjecucion_[enrollmentGroupId];
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
  // ★ ORDEN CORREGIDO 2026-08-06 — antes el `signing_token` GANABA al `resume_token`.
  //
  // El step-up prueba UNA cosa: que tienes acceso al buzón del expediente. Para eso le
  // basta el GRUPO, y el `resume_token` lo da. Preguntar primero por el token de firma le
  // metía una dependencia dura de una sesión de firma VIVA y no terminal a algo que no
  // firma nada: si esa sesión no existía, el KMS respondía
  //   SIGNING_TOKEN_INVALID · "signing identity rejected: SESSION_NOT_FOUND"
  // y la familia que volvía tras el bloqueo de pantalla se quedaba fuera al pedir el OTP.
  //
  // La pista que lo delató (Diego, probándolo): al RECARGAR la página del OTP sí entraba.
  // La recarga rehace el estado sin arrastrar el token de firma, así que la misma llamada
  // caía a la rama del `resume_token` y resolvía sin problema. Esa asimetría era el bug.
  //
  // KAL-4 INTACTA: los dos tokens se verifican server-side y los dos derivan el grupo
  // server-side, NUNCA del payload. Solo cambia CUÁL se pregunta primero. El token de
  // firma sigue siendo la vía cuando de verdad se está en el tramo de firma y no hay
  // `resume_token` a mano.
  if (p && p.resume_token) {
    return { enrollment_group_id: requireResumeToken_(p) };
  }
  if (p && p.signing_token) {
    return requireSigningToken_(p); // { enrollment_group_id, guardian_person_id, ... }
  }
  // Sin ninguno de los dos: requireResumeToken_ lanza el UNAUTHORIZED que corresponde.
  return { enrollment_group_id: requireResumeToken_(p) };
}

/**
 * Marca el grupo como "step-up fresco" durante STEPUP_INACTIVITY_MS — VENTANA DURA.
 *
 * ★ ESTA MARCA NACE SOLO EN RE-VERIFICACIÓN REAL DEL BUZÓN. Dos eventos, y ninguno más:
 *   (1) verifyEmail_ con stepup:true (OTP fresco verificado), y
 *   (2) consumo single-use de la gracia de magic-link (mlgrace_<resume_token>,
 *       que prueba un envío reciente al inbox del expediente).
 *
 * ⛔ NUNCA se llama desde una LECTURA (hydrate, pulso getAdmissionState) ni desde un
 * save. Eso es exactamente el bug que SEC-STEPUP (#55) cerró: el pulso late SOLO, así
 * que dejarle re-escribir la marca hacía que una pestaña abierta y sin nadie delante se
 * quedara viva indefinidamente. Para ESTIRAR la ventana por actividad REAL de una
 * persona está `_extenderVentanaStepUp_`, que EXTIENDE y jamás CREA — ver allí.
 *
 * Guarda el timestamp de EXPIRACIÓN (Date.now()+ventana) en el ScriptCache; el
 * gate compara contra Date.now(). El TTL del cache se alinea a la misma ventana.
 *
 * ②24 (2026-08-10) — LA MARCA ES DEL TUTOR QUE SE VERIFICÓ, NO DEL EXPEDIENTE. Hasta
 * hoy la clave era `stepup_ok_<expediente>` a secas: un código pedido y acertado por UN
 * tutor abría la puerta para CUALQUIER identidad del mismo expediente — y los actos de
 * firma (consentimientos, confirmación de lectura, inicio de firma) SÍ llevan identidad,
 * así que la marca de uno servía para actuar como el otro. Ahora el valor guardado lleva,
 * además del instante de caducidad, A QUIÉN se le mandó el código; ver `_isStepUpFresh_`
 * para la regla exacta de comparación.
 *
 * 2026-08-20 — LA MARCA VA ATADA TAMBIÉN A LA PÁGINA VIVA QUE SE VERIFICÓ. Un tercer
 * dato al lado de los dos anteriores (caducidad y buzón): la huella que el navegador
 * acuña en memoria de JavaScript al cargar y que NO sobrevive a una recarga. Es lo que
 * hace que un F5 vuelva a pedir el código aunque la marca siga viva; ver
 * `_isStepUpFresh_` para la regla de comparación y su límite declarado.
 *
 * @param {string} enrollmentGroupId - ya derivado del token (KAL-4)
 * @param {string} [reason]          - etiqueta del evento (OTP|GRACE) para el log
 * @param {string|null} [personaEmail] - buzón del tutor que operó (`_identidadDelEnlace_`),
 *                                     o null si no se pudo identificar.
 * @param {string} [huellaPagina]    - huella de la página viva (`_huellaDePagina_`), o ''.
 * @private
 */
function _markStepUpFresh_(enrollmentGroupId, reason, personaEmail, huellaPagina) {
  var persona = _stepUpPersonaKey_(personaEmail);
  var huella  = _huellaPaginaLimpia_(huellaPagina);
  // ★ 2026-08-20 — la marca nace con su TECHO ABSOLUTO al lado (cuarto campo). El techo se
  // fija AQUÍ, en la verificación, y `_extenderVentanaStepUp_` lo conserva verbatim y jamás lo
  // mueve: es lo único que la actividad NO puede reiniciar.
  var ahora = Date.now();
  var techo = ahora + STEPUP_TECHO_MS;
  var exp = Math.min(ahora + STEPUP_INACTIVITY_MS, techo);
  var ttl = Math.ceil((exp - ahora) / 1000);
  CacheService.getScriptCache().put(
    'stepup_ok_' + enrollmentGroupId,
    String(exp) + '|' + persona + '|' + huella + '|' + String(techo),
    ttl
  );
  Logger.log(redact_('[DBG stepup] mint reason=' + (reason || '?') + ' group=' + enrollmentGroupId +
                     ' persona=' + (persona || '(sin identificar)') +
                     ' pagina=' + (huella || '(sin huella)') +
                     ' techo_s=' + Math.ceil(STEPUP_TECHO_MS / 1000) +
                     ' ttl_s=' + ttl));
}

/**
 * 2026-08-20 · HUELLA DE LA PÁGINA VIVA — la que el navegador acuña en memoria de
 * JavaScript y SOLO ahí (nunca `sessionStorage` ni `localStorage`, que sobreviven a la
 * recarga y anularían todo esto). Llega en `pv` de cualquier petición del asistente.
 *
 * NO es un secreto ni autoriza nada por sí sola: el expediente sigue saliendo del
 * `resume_token` (KAL-4). Es un DISCRIMINADOR de «la misma carga de página», igual que
 * el buzón de ②24 es el discriminador de «el mismo tutor».
 *
 * Se acepta solo la FORMA (hexadecimal/guiones, 8-64) porque el valor lo elige el
 * navegador; lo que no case se trata como «no consta» (cadena vacía), nunca como error:
 * un formato raro no puede dejar a una familia fuera de su propia solicitud.
 *
 * @param {string|null} v
 * @returns {string} huella normalizada, o '' si no consta / no tiene forma.
 * @private
 */
function _huellaPaginaLimpia_(v) {
  if (!v) return '';
  var t = String(v).trim().toLowerCase();
  return /^[a-f0-9-]{8,64}$/.test(t) ? t : '';
}

/**
 * La huella de página que trae ESTA petición. Un solo sitio la lee del cuerpo, para que
 * emisión y comprobación no puedan divergir (mismo motivo que `_stepUpCodeKey_`).
 * @param {Object} p cuerpo de la petición
 * @returns {string}
 * @private
 */
function _huellaDePagina_(p) {
  return _huellaPaginaLimpia_(p && p.pv);
}

/**
 * 2026-08-20 · EXTIENDE la ventana de inactividad — y JAMÁS la CREA.
 *
 * Lee la marca vigente y le sube SOLO la caducidad, conservando **intactos** el buzón
 * (②24) y la huella de página con los que nació. Es deliberado y es la mitad del
 * asunto: si re-acuñara con los datos del llamante, quien llegara sin huella (o con
 * otra) borraría el atado y una recarga podría estirarse a sí misma para siempre.
 *
 * Si NO hay marca —o ya caducó— devuelve false y no escribe nada: la ventana caducada
 * no se resucita sin volver a acreditar el buzón. Quien llama ya ha pasado
 * `assertStepUpFresh_`, así que este false solo puede darse por una carrera con la
 * caducidad; devolverlo (en vez de crear) es fallar cerrado.
 *
 * @param {string} enrollmentGroupId - ya derivado del token (KAL-4)
 * @returns {number} segundos que quedan tras extender, o 0 si no se extendió nada.
 * @private
 */
function _extenderVentanaStepUp_(enrollmentGroupId) {
  var cache = CacheService.getScriptCache();
  var val = cache.get('stepup_ok_' + enrollmentGroupId);
  if (!val) return 0;
  var partes = String(val).split('|');
  var ahora = Date.now();
  var exp = Number(partes[0]);
  if (!exp || exp < ahora) return 0;        // caducada ⇒ NO se resucita
  var persona = partes.length > 1 ? String(partes[1]) : '';
  var huella  = partes.length > 2 ? String(partes[2]) : '';
  // ⛔ EL TECHO NO SE MUEVE. Se lee de la marca y se vuelve a escribir VERBATIM: si se
  // recalculara aquí, cada refresco lo empujaría hacia adelante y el techo no existiría.
  // Una marca de antes de este cambio no lo lleva (tres campos) ⇒ se trata como «sin techo»,
  // igual que ayer; se agota sola en 10 min de inactividad y a partir de ahí toda marca nueva
  // nace con el suyo. Ése es todo el periodo de convivencia.
  var techo = partes.length > 3 ? Number(partes[3]) : 0;
  var nuevaExp = techo ? Math.min(ahora + STEPUP_INACTIVITY_MS, techo)
                       : ahora + STEPUP_INACTIVITY_MS;
  // ⛔ UN SOLO CORTE, y es éste. Con el techo alcanzado, `nuevaExp` ES el techo y por tanto ya
  // no está en el futuro ⇒ devuelve 0 y el manejador lanza STEPUP_REQUIRED. Aquí hubo un
  // `if (techo && techo <= ahora) return 0;` por delante: se retiró porque era REDUNDANTE —
  // romperlo a propósito no ponía roja la medición, que es como se descubrió que no cortaba
  // nada. Dos guardianes para lo mismo se acaban contradiciendo; éste basta.
  if (nuevaExp <= ahora) return 0;
  var ttl = Math.ceil((nuevaExp - ahora) / 1000);
  cache.put(
    'stepup_ok_' + enrollmentGroupId,
    String(nuevaExp) + '|' + persona + '|' + huella + '|' + (techo ? String(techo) : ''),
    ttl
  );
  Logger.log(redact_('[DBG stepup] extend group=' + enrollmentGroupId +
                     ' persona=' + (persona || '(sin identificar)') +
                     ' pagina=' + (huella || '(sin huella)') +
                     ' techo_restante_s=' + (techo ? Math.ceil((techo - ahora) / 1000) : '(sin techo)') +
                     ' ttl_s=' + ttl));
  return ttl;
}

/**
 * ②24 — HUELLA OPACA del buzón que operó. Es lo que se guarda junto a la marca de
 * step-up y lo que namespacea el código de un solo uso, su contador de intentos y su
 * cupo. Se guarda una huella y no el correo porque estas claves viven en un almacén
 * compartido de todo el proyecto y no tienen por qué llevar un dato personal (KAL-11).
 *
 * Devuelve cadena vacía cuando no hay identidad: eso es «no consta», y `_isStepUpFresh_`
 * lo trata como comodín (ver allí el porqué y su límite declarado).
 *
 * @param {string|null} email buzón efectivo del tutor (`_identidadDelEnlace_`).
 * @returns {string} 12 caracteres hexadecimales, o '' si no hay identidad.
 * @private
 */
function _stepUpPersonaKey_(email) {
  if (!email) return '';
  var limpio = String(email).toLowerCase().trim();
  if (!limpio) return '';
  var dig = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, limpio, Utilities.Charset.UTF_8);
  return dig.slice(0, 6).map(function (b) {
    var v = (b + 256) % 256; return (v < 16 ? '0' : '') + v.toString(16);
  }).join('');
}

/**
 * ②24 — claves del código de un solo uso del step-up, namespaceadas por buzón. UN SOLO
 * sitio las construye para que emisión (`sendVerificationCode_`) y canje (`verifyEmail_`)
 * no puedan divergir: si divergieran, el código emitido no se podría canjear nunca.
 * @private
 */
function _stepUpCodeKey_(groupId, personaEmail) {
  return 'stepup_verify_' + groupId + '_' + (_stepUpPersonaKey_(personaEmail) || '-');
}

/** ②24 — contador de intentos fallidos, por expediente Y buzón (ver `_stepUpCodeKey_`). */
function _stepUpAttemptsKey_(groupId, personaEmail) {
  return 'stepup_verify_attempts_' + groupId + '_' + (_stepUpPersonaKey_(personaEmail) || '-');
}

/**
 * ②24 · QUÉ BUZÓN ESTÁ OPERANDO — UN SOLO SITIO lo resuelve, y con memoria.
 *
 * No es un resolvedor nuevo: es `effectiveRecoveredEmail_` (identidad DEL ENLACE, `n` =
 * email_id, con la validación KAL-4 de que la fila es de este expediente) envuelto en una
 * memoria de 300 s, porque ahora lo pregunta CADA acto gateado y sin memoria costaría
 * 2-3 lecturas de AppSheet (10-22 s medidos) en cada guardado — que es exactamente el
 * coste que PERF-WIZ quitó de estos caminos.
 *
 * OJO a lo que devuelve cuando no hay `n` ni `recovered_email`: `effectiveRecoveredEmail_`
 * cae, por diseño (su respaldo, paso 3), al `primary_email` del expediente — el correo
 * personal del tutor 1. Es decir, **no devuelve «no se sabe», devuelve «el tutor 1»**.
 *
 * ②24.bis (2026-08-10) — ESO VALE PARA ELEGIR BUZÓN Y NO VALE PARA ATRIBUIR. Con respaldo,
 * una sesión sin discriminador se comporta exactamente como hasta hoy (el código va al
 * tutor 1 y la marca es del tutor 1) — inofensivo, porque como mucho manda el código a
 * quien ya lo recibía. Pero el mismo valor alimentaba **quién firma el consentimiento**, y
 * ahí un «tutor 1» inventado le atribuye a una persona algo que quizá no dio: el libro de
 * consentimientos es el REGISTRO LEGAL. Por eso quien atribuye pide `{sinRespaldo:true}`
 * (ver `wizardTutorAtribuible_`) y se lleva `null` cuando no consta — **no se retira el
 * respaldo, se separan los dos usos**, y sin un segundo resolvedor que pueda divergir.
 *
 * DOS MEMORIAS, Y NO SE CONTAMINAN. La parte compartida —la identidad DECLARADA (pasos 1 y
 * 2 de `effectiveRecoveredEmail_`: el `n` del enlace y el `recovered_email` del cliente)— es
 * la MISMA en los dos modos y se guarda una sola vez bajo `idlinkd_`. El respaldo vive
 * aparte, bajo `idlinkr_`, y solo lo consulta el modo indulgente. Así el modo estricto no
 * puede leer un valor que salió del respaldo (que es justo el fallo intermitente que habría
 * si compartieran clave), y no cuesta ni una lectura de más: en el camino normal (con `n`)
 * la identidad declarada resuelve y los dos modos la comparten.
 *
 * La clave de la memoria incluye el token de recuperación: cuando se rota (cada envío de
 * enlace) la entrada vieja queda inalcanzable y caduca sola. La memoria NO autoriza nada
 * — el expediente sigue derivándose del token en cada llamada (KAL-4).
 *
 * @param {Object} p payload del manejador (resume_token + `n` y/o recovered_email).
 * @param {string} groupId expediente YA autorizado (derivado del token — KAL-4).
 * @param {Object} [opts] { sinRespaldo:true } ⇒ solo la identidad DECLARADA; `null` si no consta.
 * @returns {string|null} buzón efectivo en minúsculas, o null si no hay forma de saberlo.
 * @private
 */
function _identidadDelEnlace_(p, groupId, opts) {
  if (!p || !groupId) return null;
  var sinRespaldo = !!(opts && opts.sinRespaldo);
  // 1. La identidad DECLARADA (pasos 1 y 2) — idéntica en los dos modos ⇒ UNA sola memoria.
  var declarada = _idLinkMemo_(p, groupId, 'idlinkd_', function () {
    return effectiveRecoveredEmail_((p && p.resume_token) || null, (p && p.recovered_email) || null,
      (p && p.n) || null, null, { sinRespaldo: true });
  });
  if (declarada || sinRespaldo) return declarada;
  // 2. Solo el modo indulgente añade el respaldo (`primary_email` = tutor 1), con SU memoria.
  //    Llegados aquí los pasos 1 y 2 ya dieron null, así que esta llamada solo paga el paso 3.
  return _idLinkMemo_(p, groupId, 'idlinkr_', function () {
    return effectiveRecoveredEmail_((p && p.resume_token) || null, (p && p.recovered_email) || null,
      (p && p.n) || null);
  });
}

/**
 * ②24.bis — memoria de 300 s de `_identidadDelEnlace_`, con la clave del MODO por delante.
 * Si los dos modos compartieran clave se contaminarían entre sí y el fallo sería
 * intermitente e imposible de diagnosticar; por eso el prefijo es parte de la clave.
 * La memoria NUNCA rompe el camino vivo: cualquier fallo suyo se traga y se calcula.
 *
 * @param {Object} p payload · @param {string} groupId · @param {string} prefijo clave del modo
 * @param {Function} calcular thunk que resuelve el buzón cuando no hay memoria.
 * @returns {string|null}
 * @private
 */
function _idLinkMemo_(p, groupId, prefijo, calcular) {
  var memoKey = null;
  try {
    var crudo = [String(p.resume_token || '').trim(), p.n || '', p.recovered_email || '', groupId].join('|');
    var dig = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, crudo, Utilities.Charset.UTF_8);
    memoKey = prefijo + dig.map(function (b) {
      var v = (b + 256) % 256; return (v < 16 ? '0' : '') + v.toString(16);
    }).join('');
    var hit = CacheService.getScriptCache().get(memoKey);
    if (hit) return hit === '-' ? null : hit;
  } catch (e) { /* la memoria NUNCA rompe el camino vivo */ }
  var email = null;
  try {
    email = calcular();
  } catch (e) {
    Logger.log(redact_('[_identidadDelEnlace_] no se pudo identificar el buzón: ' + e.message));
    email = null;
  }
  try { if (memoKey) CacheService.getScriptCache().put(memoKey, email || '-', 300); } catch (e) { /* best-effort */ }
  return email;
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
 * LECTOR ÚNICO de la marca de step-up: ¿sigue fresca, y CUÁNTO le queda?
 *
 * Devuelve las dos cosas porque el cliente necesita las dos: el booleano abre o cierra la
 * puerta, y los segundos son sobre los que pinta el aviso de los dos minutos. Antes solo
 * salía el booleano y el cliente echaba su propia cuenta de 10 min, que divergía de la
 * del servidor (el defecto que #30 documentó). No lanza.
 *
 * `_isStepUpFresh_` es su envoltorio booleano y `assertStepUpFresh_` el que lanza. UN
 * SOLO sitio compara, para que la puerta y lo que se le enseña a la familia no puedan
 * decir cosas distintas.
 *
 * ★ 0º.octies (2026-08-21) — `personaEmail` admite además una FUNCIÓN, y solo se invoca cuando la
 * marca guardada LLEVA buzón. No afloja nada y no es una excepción: es la MISMA comparación. Cuando
 * `marcada` está vacía (no hay marca, o es anterior a ②24), la regla `mismaPersona` de abajo vale
 * `true` **sea cual sea** `persona` ⇒ resolver la identidad no puede cambiar el resultado, y en el
 * pulso ese cálculo cuesta un viaje al KMS de 20-30 s. Lo que se evita es el CÁLCULO de un dato que
 * no se usa; el criterio, byte a byte, es el de siempre. ⛔ Y NO se toca al revés: cuando `marcada`
 * SÍ consta, la identidad se resuelve y se compara — pasarla vacía sería MÁS PERMISIVO (deshace el
 * atado al buzón de ②24) y eso es una regresión de seguridad, no una optimización.
 *
 * @param {string} enrollmentGroupId   - ya derivado del token (KAL-4)
 * @param {string|null|function():(string|null)} [personaEmail] - buzón que opera (②24), o el thunk
 *        que lo resuelve; se invoca SOLO si la marca lleva buzón (ver arriba).
 * @param {string} [huellaPagina]      - huella de la página viva (2026-08-20)
 * @returns {{fresh: boolean, restante_s: number}}
 * @private
 */
function _leerMarcaStepUp_(enrollmentGroupId, personaEmail, huellaPagina) {
  const val = CacheService.getScriptCache().get('stepup_ok_' + enrollmentGroupId);
  if (!val) {
    Logger.log(redact_('[DBG stepup] read group=' + enrollmentGroupId + ' fresh=false no_mark'));
    return { fresh: false, restante_s: 0, cierre: 'INACTIVIDAD' };
  }
  // El valor guardado es «<caducidad>|<huella del buzón>|<huella de la página viva>».
  // Una marca ANTERIOR a ②24 es solo el número, y una anterior al 2026-08-20 no trae la
  // tercera parte: las dos se leen igual y el campo que falta queda vacío (comodín).
  const partes = String(val).split('|');
  const exp = Number(partes[0]);
  const marcada = partes.length > 1 ? String(partes[1]) : '';
  const paginaMarcada = partes.length > 2 ? String(partes[2]) : '';
  // ★ 2026-08-20 — el TECHO ABSOLUTO. Por construcción `exp` nunca lo pasa (lo capan tanto el
  // que la crea como el que la extiende), así que esto es un cinturón: si alguna vez alguien
  // escribiera una caducidad por encima del techo, aquí se cierra igual. Marca sin techo (la
  // de antes de este cambio) ⇒ manda solo `exp`, como ayer.
  const techo = partes.length > 3 ? Number(partes[3]) : 0;
  // ★ 0º.octies — el buzón que opera solo se RESUELVE si la marca lleva uno con el que comparar
  // (ver la cabecera). Sin `marcada`, `mismaPersona` es `true` pase lo que pase aquí.
  const persona = marcada
    ? _stepUpPersonaKey_(typeof personaEmail === 'function' ? personaEmail() : personaEmail)
    : '';
  const pagina = _huellaPaginaLimpia_(huellaPagina);
  const enVentana = !!exp && exp >= Date.now() && (!techo || techo >= Date.now());
  // LA REGLA, y su límite declarado: la marca NO se transfiere entre DOS buzones
  // conocidos y distintos. Cuando uno de los dos lados no consta, se deja pasar — así
  // esto no rompe ningún camino que hoy no manda identidad, y no concede nada nuevo:
  // para tener marca hay que haber recibido el código, que va al buzón del que opera.
  // Lo que cierra es lo que estaba abierto: los actos que SÍ llevan identidad
  // (consentimientos, confirmación de lectura, inicio de firma) ya no pueden hacerse
  // en nombre de un tutor con la marca que se ganó otro.
  const mismaPersona = !marcada || !persona || marcada === persona;
  // 2026-08-20 · MISMA REGLA, MISMO LÍMITE, para la página viva: dos huellas conocidas y
  // distintas NO se transfieren ⇒ una RECARGA (que pierde la variable de memoria y acuña
  // otra) vuelve a pedir el código. Cuando uno de los dos lados no consta se deja pasar,
  // por lo mismo que en el buzón: un cliente que todavía no manda `pv` —un paquete viejo
  // en caché tras publicar— no puede quedarse fuera de su propia solicitud, y no se le
  // concede nada que no tuviera ya ayer. LÍMITE HONESTO, escrito para que nadie lo
  // sobrevenda: esto cierra la RECARGA DEL CLIENTE REAL, que es lo que Diego pidió; NO es
  // una defensa contra un llamante fabricado que sencillamente omita el campo — ése ya
  // tenía exactamente este mismo acceso antes de hoy.
  const mismaPagina = !paginaMarcada || !pagina || paginaMarcada === pagina;
  const fresh = enVentana && mismaPersona && mismaPagina;
  const remainingS = Math.max(0, Math.round((exp - Date.now()) / 1000));
  // ★ 2026-08-20 (Diego: *«es importante avisar que se va a cerrar por seguridad»*) — el
  // cliente necesita saber CUÁL de los dos límites es el que va a cerrar, porque el aviso no
  // puede ser el mismo. Si cierra por INACTIVIDAD, «¿sigues ahí?» con un botón que de verdad
  // reinicia el contador. Si cierra por el TECHO, ese botón NO PUEDE funcionar —el refresco
  // devolverá 0— y ofrecerlo sería prometer algo que no va a pasar: ahí el aviso dice que se
  // cierra por seguridad y que se pedirá el código otra vez.
  // Se manda RESUELTO desde aquí, no se deduce en el cliente restando números: dos fuentes de
  // verdad sobre lo mismo divergen (es la misma razón por la que `restante_s` lo manda el
  // servidor). Sin techo (marca de antes del cambio) ⇒ INACTIVIDAD, como ayer.
  const cierre = (techo && exp >= techo) ? 'TECHO' : 'INACTIVIDAD';
  Logger.log(redact_('[DBG stepup] read group=' + enrollmentGroupId + ' fresh=' + fresh +
                     ' remaining_s=' + remainingS +
                     ' persona=' + (persona || (marcada ? '(sin identificar)' : '(no consultado)')) +
                     ' marcada=' + (marcada || '(sin identificar)') +
                     (enVentana && !mismaPersona ? ' motivo=OTRO_TUTOR' : '') +
                     (enVentana && mismaPersona && !mismaPagina ? ' motivo=OTRA_PAGINA' : '')));
  return { fresh: fresh, restante_s: fresh ? remainingS : 0, cierre: cierre };
}

function _isStepUpFresh_(enrollmentGroupId, personaEmail, huellaPagina) {
  return _leerMarcaStepUp_(enrollmentGroupId, personaEmail, huellaPagina).fresh;
}

function assertStepUpFresh_(enrollmentGroupId, personaEmail, huellaPagina) {
  if (!_isStepUpFresh_(enrollmentGroupId, personaEmail, huellaPagina)) {
    var err = new Error('Step-up re-verification required');
    err.code = 'STEPUP_REQUIRED';
    Logger.log(redact_('[assertStepUpFresh_] reject group=' + enrollmentGroupId));
    throw err;
  }
  // Fresco.
}

/**
 * 2026-08-20 · «SIGO AQUÍ» — la actividad REAL de una persona reinicia el contador.
 *
 * Es lo que hace que la ventana sea de INACTIVIDAD y no de reloj (Diego, 2026-08-20).
 * La dispara el asistente cuando alguien clica, teclea o cambia de paso, con un freno de
 * un minuto en el cliente para no llamar por pulsación.
 *
 * ⛔ NO CREA NADA. Exige, y falla cerrado si falta cualquiera de las cuatro:
 *   1. el enlace (KAL-4: el expediente sale del `resume_token`, nunca del cuerpo);
 *   2. que la marca siga VIVA — sobre una caducada lanza STEPUP_REQUIRED y hay que
 *      volver a acreditar el buzón con el código;
 *   3. que el buzón case (②24) — la marca de un tutor no la estira otro;
 *   4. que la huella de página case — una recarga no puede estirarse a sí misma.
 * Y al extender conserva buzón y huella originales (`_extenderVentanaStepUp_`), para que
 * pasar por aquí no pueda AFLOJAR el atado con el que la marca nació.
 *
 * No hace ningún trabajo caro: es una sola escritura al ScriptCache, sin BD ni KMS.
 *
 * @param {{resume_token:string, n?:string, recovered_email?:string, pv?:string}} p
 * @returns {{ok:boolean, step_up_fresh:boolean, step_up_restante_s:number}}
 */
function refrescarVentanaDeInactividad_(p) {
  const enrollmentGroupId = requireResumeToken_(p);
  const persona = _identidadDelEnlace_(p, enrollmentGroupId);
  const pagina  = _huellaDePagina_(p);
  assertStepUpFresh_(enrollmentGroupId, persona, pagina);
  const restante = _extenderVentanaStepUp_(enrollmentGroupId);
  if (!restante) {
    // Carrera con la caducidad entre el gate y la escritura: se falla cerrado, no se crea.
    var err = new Error('Step-up re-verification required');
    err.code = 'STEPUP_REQUIRED';
    throw err;
  }
  // Tras extender, el límite que manda puede haber cambiado de INACTIVIDAD a TECHO (la
  // ventana ya viene recortada por el techo): se vuelve a LEER en vez de suponerlo.
  const tras = _leerMarcaStepUp_(enrollmentGroupId, persona, pagina);
  return { ok: true, step_up_fresh: true, step_up_restante_s: restante,
           step_up_cierre: tras.cierre };
}

/**
 * ★ SEC WIZ-SIGNTOKEN (audit 2026-07-22): el `signing_token` es el bearer del ACTO
 * de firma (consentimientos GDPR legalmente vinculantes). NO debe servirse al
 * cliente antes de que el step-up (DL-E39) pruebe posesión del buzón — de lo
 * contrario un resume_token filtrado obtiene el signing_token del signing_context
 * (getAdmissionState_ / resumeSession_ pii-gated) y forja los 7 consentimientos.
 *
 * Cuando `fresh` es false, devuelve una COPIA superficial del signing_context con
 * `signing_token` vaciado (null), conservando el resto de campos no sensibles
 * (signer_id / session_id / guardian_person_id) y los flags hermanos de nivel
 * superior (signing_available / signing_status / signing_ready) intactos. Fresco,
 * o signing_context nulo → passthrough sin cambios.
 *
 * @param {Object|null} signingContext
 * @param {boolean} fresh — resultado de _isStepUpFresh_ para el grupo del token.
 * @returns {Object|null}
 */
function _redactSigningTokenIfNotFresh_(signingContext, fresh) {
  if (!signingContext || fresh) return signingContext;
  var redacted = {};
  for (var k in signingContext) {
    if (Object.prototype.hasOwnProperty.call(signingContext, k)) redacted[k] = signingContext[k];
  }
  redacted.signing_token = null;
  return redacted;
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

/** Clave base del cache wizard (kind: 'hyd' | 'adm' | 'mem' | 'doc' | 'sim').
 *
 * RE-LLAVEO V2.4 (pregunta de Diego 2026-06-12 17:08: "una vez cargada en el
 * servidor, ¿por qué no se queda ahí hasta que caduque la caché?"): las claves
 * iban atadas al resume_token y el token ROTA con cada magic link → clave nueva
 * → cache "perdido" aunque los bytes siguieran en ScriptCache. Claves ESTABLES:
 *   doc → file_id (bytes inmutables; la entrada guarda g=group_id y el servido
 *         verifica pertenencia post-gate — KAL-4; TTL 6h)
 *   mem → enrollment_group_id (members del paquete, de grupo)
 *   hyd/adm → enrollment_group_id + n (contexto per-guardian)
 *   sim → enrollment_group_id (`0º.vicies.quinquies` — la simulación del paso 7
 *         no se filtra por tutor: todos ven las mismas plantillas de todos los
 *         solicitantes, igual que hoy). Frescura de DOS niveles, no solo `v`: la
 *         entrada guarda además `huella` (`enr_huellaDeLaSimulacion_`, KMS),
 *         derivada de lo que el centro declaró — un `v` distinto NO basta para
 *         tirarla, se comprueba antes por el camino barato (`simularCuotas_`).
 * Frescura de hyd/adm/mem/doc: live_version (v en la entrada) — los writes bumpan
 * la versión del grupo (_wzCacheInvalidate_) y cualquier entrada con v vieja es
 * MISS. La rotación del token deja de borrar nada: re-entrar 10 min después = HIT. */
// DL-E49 §2 — 'hyd'/'adm' llevan `v2` a propósito: el hydrate empezó a recortar
// por identidad y las entradas cacheadas ANTES de este cambio (mismo grupo+n, formato
// de clave idéntico) seguirían siendo HIT con el grupo entero sin recortar hasta
// caducar solas (TTL hasta 1800s). 'mem'/'doc' no llevan PII de persons/relations/
// responses — no necesitan el corte.
var _WZ_CACHE_KIND_V2_ = { hyd: 1, res: 1, adm: 1 };
function _wzCacheKey_(kind, suffix) {
  return 'wz_' + kind + (_WZ_CACHE_KIND_V2_[kind] ? 'v2' : '') + '_' + suffix;
}

/**
 * Discriminador per-guardian para claves hyd/res/adm. DL-E49 §2 (cache hazard hallado
 * al construir el recorte por tutor): con solo `n`, un tutor que recupera SIN enlace
 * (escribiendo su email en la pantalla de recuperación, sin `?n=`) caía siempre en el
 * mismo cubo `'-'` — antes era inocuo (la respuesta era la misma para cualquiera), pero
 * en cuanto el hydrate empezó a filtrar por identidad (§2), dos tutores sin `n` habrían
 * podido COMPARTIR la caché del otro: el segundo en llegar recibía los datos del
 * primero. Con email disponible y sin `n`, se deriva un hash corto del email (nunca el
 * email en claro dentro de una clave de ScriptCache); sin ninguno de los dos, '-'.
 * @private
 */
function _wzN_(n, email) {
  var nTrim = String(n || '').trim();
  if (nTrim) return nTrim;
  var e = String(email || '').trim().toLowerCase();
  if (!e) return '-';
  return 'e:' + Utilities.base64EncodeWebSafe(
    Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, e, Utilities.Charset.UTF_8)).slice(0, 16);
}

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
    var effEmail = effectiveRecoveredEmail_(token, it.e || null, it.n || null);
    var guardianId = effEmail ? resolveGuardianForRecovery_(token, effEmail) : null;
    // ②17: las filas de firma las sirve el KMS (acotadas al expediente del token), no
    // AppSheet. Sin ellas el resolvedor devuelve null — mismo comportamiento de antes
    // ante una lectura fallida: pre-AD o sin sesión, nada que calentar.
    var firmaKms = _datosDeFirmaDelExpediente_(token);
    var sctx = (guardianId && firmaKms)
      ? resolveGuardianSigningContext_(groupId, guardianId, firmaKms.sessions, firmaKms.signersBySession)
      : null;
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

/**
 * `0º.vicies.quinquies` (2026-08-22) — CALCULA la simulación del paso 7 (el motor
 * caro del KMS, `enr.simularCuotas`, ~89 s con el memo de `0º.vicies.ter`) y la deja
 * en caché — SIEMPRE. Es el ÚNICO sitio que escribe `wz_sim_<groupId>`; tanto el
 * calentado de fondo (`_warmSimularCuotasPhase_`) como el camino en vivo
 * (`simularCuotas_`, cuando su caché no vale) llaman AQUÍ — nunca cada uno a su
 * manera, para que no puedan divergir.
 *
 * El KMS devuelve la HUELLA junto con la simulación (`enr_huellaDeLaSimulacion_`,
 * DERIVADA de las circunstancias que el centro declaró — nunca una lista escrita a
 * mano); aquí solo se guarda tal cual.
 *
 * @param {string} groupId
 * @param {string} resumeToken
 * @returns {Object} la respuesta de `enr.simularCuotas` (byte-idéntica a la de hoy)
 * @private
 */
function _wzComputeYCachearSimulacion_(groupId, resumeToken) {
  var data = kmsProxy_('enr.simularCuotas', { resume_token: resumeToken });
  try {
    _wzCachePutChunked_(CacheService.getScriptCache(), _wzCacheKey_('sim', groupId),
      JSON.stringify({ v: _getLiveStateVersion_(groupId), huella: (data && data.huella) || null, data: data }),
      1800);
  } catch (eC) { /* best-effort: el cálculo ya se hizo, solo falla guardarlo */ }
  return data;
}

/**
 * FASE HIJA 'sim' del precalentado (`0º.vicies.quinquies`) — calienta de fondo la
 * simulación de cuotas del paso 7, CONCURRENTE e independiente del hydrate, mismo
 * criterio que la fase 'mem' (`_warmMembersDocsPhase_`, arriba): lo caro de esta
 * fase (~89 s) no puede retrasar lo que ya calienta la fase 'kms'.
 *
 * Marca `wzck_sim_<groupId>` mientras trabaja (para que dos disparos del mismo
 * enlace no calculen la misma simulación dos veces a la vez). Antes de recalcular,
 * si ya hay algo cacheado se le pregunta la HUELLA al camino barato (mismo criterio
 * que `simularCuotas_`: `v` casa ⇒ sigue valiendo sin preguntar nada; `v` no casa ⇒
 * se pregunta la huella) — si sigue valiendo, sale sin recalcular, para que una
 * familia que pide un segundo enlace ("guardar y seguir luego") no vuelva a pagar
 * un ensayo que su última edición no cambió.
 *
 * Best-effort SIEMPRE: un fallo aquí no le impide a la familia ver su simulación —
 * simplemente la pagará ella al llegar al paso 7, como hoy.
 *
 * @param {{t:string}} it
 * @returns {{ok:boolean, ms:number}}
 * @private
 */
function _warmSimularCuotasPhase_(it) {
  var out = { ok: false, ms: 0 };
  var t0 = Date.now();
  var token = String((it && it.t) || '').trim();
  var cache = CacheService.getScriptCache();
  var groupId;
  try {
    try { assertValidUuid_(token, 'resume_token'); } catch (eV) { return out; }
    groupId = requireResumeTokenMemo_({ resume_token: token });

    var yaCaliente = false;
    try {
      var raw = _wzCacheGetChunked_(cache, _wzCacheKey_('sim', groupId));
      if (raw) {
        var env = JSON.parse(raw);
        if (env && env.data && env.huella) {
          if (env.v === _getLiveStateVersion_(groupId)) {
            yaCaliente = true;
          } else {
            var chequeo = kmsProxy_('enr.wizardHuellaDeSimulacion', { resume_token: token });
            yaCaliente = !!(chequeo && chequeo.huella && chequeo.huella === env.huella);
          }
        }
      }
    } catch (eChk) { yaCaliente = false; }  // sin certeza de que siga valiendo → recalcula
    if (yaCaliente) { out.ok = true; return out; }

    if (cache.get('wzck_sim_' + groupId)) { out.ok = true; return out; } // ya en marcha
    try { cache.put('wzck_sim_' + groupId, '1', 300); } catch (eM) { /* best-effort */ }
    _wzComputeYCachearSimulacion_(groupId, token);
    out.ok = true;
  } catch (e) {
    Logger.log(redact_('[_warmSimularCuotasPhase_] non-fatal — ' + (e && e.message)));
  }
  try { cache.remove('wzck_sim_' + (groupId || token)); } catch (eR) { /* best-effort */ }
  out.ms = Date.now() - t0;
  Logger.log('[WZCACHE] warm sim done ' + JSON.stringify(out));
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
    var nW = _wzN_(nParam, recoveredEmail);
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
    //     _signer_row, KMS wizard-datalayer.gs); segunda vía: el resolvedor de este
    //     backend, que desde ②17 lee las MISMAS filas del KMS (mismo camino que el lazy
    //     resolver de getDocument_). Pre-AD/sin sesión → null → sin docs (OK).
    var sctxH = (data && data.signing_context) || null;
    var signingToken = (sctxH && sctxH._signer_row && sctxH._signer_row.signing_token) || null;
    var sessionId    = (sctxH && sctxH.session_id) || null;
    var signerId     = (sctxH && sctxH.signer_id) || null;
    if (!signingToken && groupId && guardianPid) {
      try {
        var firmaW = _datosDeFirmaDelExpediente_(token);
        var sctxW = firmaW
          ? resolveGuardianSigningContext_(groupId, guardianPid, firmaW.sessions, firmaW.signersBySession)
          : null;
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
        admission: (function () {
          // DL-E41 ★ ACOTACIÓN — del KMS se toman los HECHOS (fase, etiqueta de la fase,
          // estado de la firma); las TRES banderas de pantalla las deriva ESTE cliente con
          // su lector único. Antes se copiaban del KMS (`!!admSrc.signing_available`, etc.)
          // mientras el pulse las calculaba aquí: dos cálculos del mismo dato que YA
          // divergían en `signing_available`, y ese campo abre el avance 7→8.
          var ctx = (signingToken && guardianPid) ? {
            signer_id:          signerId || null,
            session_id:         sessionId || null,
            guardian_person_id: guardianPid,
            signing_token:      signingToken,
          } : null;
          var d = derivarPantallaAdmision_(admSrc.state_code || null,
                                           admSrc.signing_status || null, ctx);
          return {
            state_code:        admSrc.state_code || null,
            state_label:       admSrc.state_label || null,
            signing_status:    admSrc.signing_status || null,
            signing_context:   ctx,
            signing_ready:     d.signing_ready,
            signing_available: d.signing_available,
            editable:          d.editable,
          };
        })(),
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
 * WIZ-ENUM (audit 2026-07-27) — respuesta CONSTANTE del servicio de recuperación
 * por email (`sendMagicLink_`, rama `primary_email`). Devuelve SIEMPRE la MISMA
 * forma exista o no una solicitud para ese email: `{sent:true, warm_ticket:<uuid>}`.
 *
 * Por qué el ticket también en el camino "sin grupo": si `warm_ticket` solo
 * apareciera cuando hay algo que precalentar, su PRESENCIA volvería a ser el
 * oráculo de existencia que este fix cierra. Cuando no hay nada que calentar se
 * mintea un ticket SEÑUELO — un ticket real (misma forma UUID, mismo TTL 300 s,
 * single-use en `warmBundle_`) cuya lista de items está VACÍA: no dispara ningún
 * warm, no toca ninguna sesión y no revela nada. `warmBundle_` responde `{ok:true}`
 * para señuelo y real por igual (ver su rama de ticket).
 *
 * @param {?string} [ticket] - ticket real ya minteado, si lo hubo.
 * @returns {{sent: boolean, warm_ticket: ?string}}
 * @private
 */
function _magicLinkConstantAck_(ticket) {
  var t = ticket || null;
  if (!t) {
    try {
      t = generateUuid_();
      CacheService.getScriptCache().put('wzwt_' + t, '[]', 300); // señuelo: 0 items
    } catch (e) { t = null; }
  }
  return { sent: true, warm_ticket: t };
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

      // PERF: estado de admisión LIGERO para el pulse de firma (no relee el expediente).
      case 'getAdmissionState':       result = getAdmissionState_(payload);       break;

      case 'submitApplication':       // legacy alias
      case 'submitEnrollmentSession': result = submitEnrollmentSession_(payload); break;

      // ── Actions that keep their name (payload shape may have changed) ───────
      case 'sendMagicLink':        result = sendMagicLink_(payload);        break;
      case 'saveStep':             result = saveStep_(payload);             break;
      // NEAE staging (Paso 4 "Salud y apoyo"). Direct wizard-side write to the
      // enr* staging tables (mirror del capture de salud). KAL-4 + edit-lock +
      // append-only DL-E16, dentro del propio handler.
      case 'saveNeae':             result = saveNeae_(payload);             break;
      case 'sendVerificationCode': result = sendVerificationCode_(payload); break;
      case 'verifyEmail':          result = verifyEmail_(payload);          break;
      // 2026-08-20 — la actividad REAL de la familia reinicia el contador de los 10 min
      // (ventana de INACTIVIDAD, no de reloj). EXTIENDE, jamás CREA: ver el handler.
      case 'refrescarVentana':     result = refrescarVentanaDeInactividad_(payload); break;
      case 'fetchQuestions':       result = fetchQuestions_(payload);       break;
      case 'saveResponses':        result = saveResponses_(payload);        break;
      case 'estadoDeLasPartes':    result = estadoDeLasPartes_(payload);    break;
      // 18.bis.84 — LECTURA: ¿cómo acabaron los guardados que el KMS dejó apuntados?
      // Exenta del código de un solo uso, con el motivo escrito en su JSDoc (no muta
      // nada y no devuelve ni un dato personal).
      case 'estadoDelGuardado':    result = estadoDelGuardado_(payload);    break;
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
      // DL-080-A — Step 8: presupuesto del borrador + elección de modalidad.
      case 'getSubscriptionBudget':   result = getSubscriptionBudget_(payload);   break;
      case 'applyPaymentModality':    result = applyPaymentModality_(payload);    break;
      // Paso 7 · el simulador de cuotas (lectura) y la forma de pago elegida a título
      // ORIENTATIVO (mutación con la puerta completa de ②27). La firme es la del paso 8.
      case 'simularCuotas':           result = simularCuotas_(payload);           break;
      case 'requestCorrection':       result = requestCorrection_(payload);       break;
      case 'retirarDelExpediente':    result = retirarDelExpediente_(payload);    break;
      case 'avisarATutor':            result = avisarATutor_(payload);            break;
      case 'submitGdprConsents':      result = submitGdprConsents_(payload);      break;
      case 'confirmReview':           result = confirmReview_(payload);           break;
      case 'initiateSigningSession':  result = initiateSigningSession_(payload);  break;
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
 * Bucket cap 8/h, acotado al expediente (ya derivado del token, KAL-4) Y AL BUZÓN al que
 * va el código (②24, 2026-08-10). Antes era solo por expediente porque «el destino
 * siempre es el primary_email del grupo» — con el envío por tutor de DL-E49 eso dejó de
 * ser cierto: el destino es el buzón del tutor que opera, y un cupo compartido dejaba sin
 * códigos al segundo tutor en cuanto el primero gastaba los 8. El buzón NO es enumerable
 * (se deriva del enlace, nunca del cuerpo de la petición), así que no abre nada.
 *
 * @param {string} groupId - enrollment_group_id ya derivado del token.
 * @param {string|null} [personaEmail] - buzón destino (`_identidadDelEnlace_`).
 */
function _checkStepUpCodeRateLimit_(groupId, personaEmail) {
  if (!groupId) return;
  const cache = CacheService.getScriptCache();
  const countKey = 'stepup_count_' + groupId + '_' + (_stepUpPersonaKey_(personaEmail) || '-');
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
function initEnrollmentSession_(p, opts) {
  // WIZ-ENUM (audit 2026-07-27) — `internal`: la llamada viene de `sendMagicLink_`,
  // que YA consumió el cupo de magic-link (y ya aplicó el bloqueo por reporte) para
  // ESTA MISMA acción del usuario. Sin esta marca, un alta nueva gastaría DOS de los
  // 5 envíos/hora (uno por cada capa) → a partir del 3.er intento la familia se
  // quedaría sin correo, y como la respuesta es constante por diseño anti-enumeración,
  // el fallo sería INDISTINGUIBLE de un envío correcto. Mismo patrón `opts.internal`
  // que `recognizeFamily_` (KAL-10). SOLO exime del cupo: la verja reCAPTCHA
  // fail-closed de WEB_PUBLIC sigue aplicándose igual.
  const internal = !!(opts && opts.internal);
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
  if (sourceCode === 'KMS_INTERNAL') {
    const expectedInternal = PropertiesService.getScriptProperties().getProperty('KMS_INTERNAL_SHARED_SECRET');
    if (!expectedInternal || !constantTimeEquals_(p.kms_internal_secret, expectedInternal)) {
      throw new Error('Unauthorized source_code: KMS_INTERNAL');
    }
  } else if (sourceCode === 'WEB_PUBLIC') {
    // La comprobación vive en UN solo sitio (`_verjaPublicaVeredicto_`); aquí se
    // usa la forma que LANZA, que es el contrato de este manejador desde siempre.
    _asegurarVerjaPublica_(p.recaptcha_token);
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

  // ②17 (séptimo tramo): las TRES lecturas de este manejador —los expedientes ya enviados
  // de este correo, los abiertos, y las personas de los candidatos para CONTARLAS— las
  // sirve el KMS en UNA pregunta (`enr.wizardExpedientesDelCorreo`), proyectadas a los
  // campos que se usan aquí abajo. La DECISIÓN (puntuar, desempatar, abandonar perdedores)
  // NO se movió: sigue entera en este fichero, verbatim.
  const _expedientes = _expedientesDelCorreo_(normalizedEmail);

  // ── Guard: already-submitted sessions block re-submission ─────────────────
  // If the email already has a submitted (non-abandoned) session, return early
  // without creating a new session or sending another magic link.
  // The frontend renders a "ya enviada / already submitted" screen.
  const existingSubmitted = _expedientes.enviados;
  if (existingSubmitted.length) {
    const grp = existingSubmitted[0];
    // Send a magic link so the family can view their submitted application in
    // read-only mode. Rate-limit is checked but errors are swallowed — the
    // already_submitted response is always returned regardless.
    let warmTicketSubmitted = null;
    try {
      if (!internal) _checkMagicLinkRateLimit_(normalizedEmail);   // WIZ-ENUM: cupo ya consumido fuera
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
        lang:             lang,
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

  const existingOpen = _expedientes.abiertos;
  if (existingOpen.length) {
    if (!internal) {   // WIZ-ENUM: cupo ya consumido por `sendMagicLink_` para esta misma acción
      _checkMagicLinkRateLimit_(normalizedEmail);
      _checkMagicLinkRateLimitIp_(null /* KAL-6: IP source pending — GAS no expone IP; noop */);
    }

    // ②17: el recuento por expediente lo hace el KMS con el MISMO filtro y el MISMO colador
    // de personas retiradas — de las personas ya NO cruza ninguna ficha, solo un número.
    // Su respaldo también se conserva: si el recuento no se pudo hacer, se ordena solo por
    // fecha, exactamente como hacía el `catch` de aquí.
    const personCountByGroup = _expedientes.personasPorExpediente;
    if (_expedientes.recuentoFallido) {
      Logger.log('initEnrollmentSession_: person count query failed (falling back to updated_at)');
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
    // P1-B (WIZARD-DIRECT-WRITE-MIGRATION): la escritura se porta al KMS
    // (enr.wizardAbandonSession). KAL-4: el grupo lo deriva el KMS del resume_token
    // del PROPIO loser (fila ya leída de BD por este init), nunca de un id suelto.
    losers.forEach(loser => {
      try {
        kmsProxy_('enr.wizardAbandonSession', { resume_token: loser.resume_token });
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
      lang:             lang,
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

  const now  = new Date().toISOString();
  const lang = p.preferred_language || 'es';

  // ── P1-B (WIZARD-DIRECT-WRITE-MIGRATION): creación de sesión → KMS ─────────
  // La creación del grupo + emisión y persistencia del resume_token (CSPRNG) se
  // porta al KMS (enr.wizardCreateSession, DL-E41 §328 — el wizard deja de mintar/
  // persistir el token localmente). El KMS resuelve server-side:
  //   - source_id desde el catálogo Capa 2 (mismo resolver probado de
  //     enr_createEnrollment / enr.inviteFamily; sourceCode ya whitelist-validado aquí);
  //   - program_id fallback al programa ADMISSION_SCHOOL activo (no-fatal, null si el
  //     catálogo no está sembrado — mismo comportamiento del lookup histórico local);
  //   - columnas del Add verbatim del escritor dorado (histórico Code.js:2006-2022).
  const created = kmsProxy_('enr.wizardCreateSession', {
    primary_email:      p.primary_email,
    program_id:         p.program_id || null,
    source_code:        sourceCode,
    preferred_language: lang,
  });
  const enrollmentGroupId = created.enrollment_group_id;
  const resumeToken       = created.resume_token;

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
  if (!internal) _checkMagicLinkRateLimit_((p.primary_email || '').toLowerCase().trim());
  // WIZARD-TERMINAL P3: contenido gobernado por el KMS. Init de la 1ª solicitud →
  // isFirstApp true (muestra el bloque GDPR).
  sendViaKmsNotify_('WIZARD_MAGIC_LINK', p.primary_email, {
    family_name:      '',
    resume_url:       RESUME_BASE_URL + resumeToken,
    report_url:       REPORT_BASE_URL + resumeToken,
    gdpr_block:       _kmsRenderGdprBlock_(true),
    admissions_email: ADMISSIONS_EMAIL,
    lang:             lang,
  });
  // EMAIL-MIGRATION-2 (2026-06-25): el aviso interno "nueva sesión iniciada" migra al
  // motor único del KMS (plantilla kis-tpl-wizard-session-started). golden =
  // buildApplicationInitiatedBody_. El wizard pre-renderiza el timestamp con
  // formatTimestamp_ (igual que el golden) → {{STARTED_AT}}. P72: si el KMS falla el
  // throw propaga; NO cae a Gmail local (single-source). El header de sesión ya está
  // insertado arriba, así que el throw solo evita el aviso, no corrompe la sesión.
  try {
    sendViaKmsNotify_('WIZARD_SESSION_STARTED', ADMISSIONS_EMAIL, {
      enrollment_id: enrollmentGroupId,
      primary_email: p.primary_email,
      started_at:    formatTimestamp_(now),
    });
  } catch (notifyErr) {
    // El aviso interno es no-crítico para la familia (ya tiene su magic-link).
    Logger.log(redact_('initEnrollmentSession_: WIZARD_SESSION_STARTED notify failed (non-fatal): ' + (notifyErr && notifyErr.message)));
  }

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
    // Misma verja que las otras dos entradas públicas, en UN solo sitio.
    _asegurarVerjaPublica_(p.recaptcha_token);
  }

  // ── Rate limit: 5/min per email (applies to internal and external) ─────────
  const cacheKey = 'recognize_' + Utilities.base64EncodeWebSafe(email);
  const cache = CacheService.getScriptCache();
  const count = parseInt(cache.get(cacheKey) || '0', 10);
  if (count >= 5) {
    throw new Error('Too many recognition queries for this email; try again in 1 minute');
  }
  cache.put(cacheKey, String(count + 1), 60);

  // ── el reconocimiento lo resuelve el KMS — ②17 ────────────────────────────
  //
  // Aquí vivían las DOS ÚNICAS lecturas de este asistente a las tablas MAESTRAS de
  // personas del colegio: `contactEmails` (todos los correos de contacto de todo el
  // mundo) y `personalData_S` (el registro de personas del colegio ENTERO). El resto de
  // lo que este fichero lee directamente son tablas de admisión, de firma o de catálogo.
  //
  // Se las pide al KMS (`enr.wizardReconocerFamilia`), que hace los MISMOS dos filtros
  // —correo → `personal_id`s → personas— y devuelve **solo los tres campos** que la
  // pantalla enseña. La ficha entera de cada persona ya no cruza a este proceso, que es
  // público y anónimo.
  //
  // KAL-5 capa 1 se queda AQUÍ además de en el KMS: rechazar un correo mal formado antes
  // de salir a la red es más barato, y las dos capas juntas sobreviven la una a la otra.
  assertValidEmail_(email, 'email');

  // ── KAL-10, y ahora SIN oráculo por TIEMPO ────────────────────────────────
  // El llamante público recibe SIEMPRE la misma respuesta —`{matched:false, persons:[]}`—
  // así que consultar antes de devolverla era trabajo tirado. Hasta ahora se consultaba
  // igual, y eso dejaba un rastro medible: una consulta que encuentra tarda más que una
  // que no (con expediente eran DOS lecturas; sin él, una). Es exactamente el defecto que
  // se cerró en la recuperación del enlace (②2): la respuesta era constante y el RELOJ no.
  // Se corta ANTES de preguntar: mismo cupo, misma verja, misma respuesta y **el mismo
  // tiempo** existan o no personas con ese correo.
  //
  // Ninguna familia lo nota: esta acción pública **no tiene ni un llamante en la
  // aplicación** (medido contra `origin/main`: el frontal solo lee `recognition` de la
  // respuesta de `initEnrollmentSession`, `ConsentPage.jsx:68`). Vive en el despachador
  // público, que es lo que la hacía interesante para un sondeo.
  if (!internal) {
    return { matched: false, persons: [] };
  }

  // SIN RESPALDO a AppSheet, y es deliberado: dos lectores del mismo dato divergen. Si el
  // KMS no contesta, el reconocimiento queda vacío — exactamente lo que ya pasaba cuando
  // la lectura fallaba (`initEnrollmentSession_` lo envuelve en su propio catch y sigue).
  let personasKms = [];
  try {
    const resp = kmsProxy_('enr.wizardReconocerFamilia', { email: email });
    personasKms = (resp && resp.persons) || [];
  } catch (e) {
    Logger.log('recognizeFamily_: reconocimiento KMS fallido (no fatal): ' + redact_(e.message));
    personasKms = [];
  }

  // El camino INTERNO (`opts.internal`, desde `initEnrollmentSession_`) sí recibe el
  // resultado de verdad: la familia acaba de teclear ese correo y de pasar la verja, y es
  // lo que alimenta el aviso «reconocimos tu familia» del paso 2. Ese resultado no sale
  // del servidor salvo dentro de la respuesta de `initEnrollmentSession`, que solo ve
  // quien acaba de dar el correo (y por tanto ya sabe lo que le contamos).
  return {
    matched: personasKms.length > 0,
    // Mapeo VERBATIM de los tres campos que la pantalla consume (`Step2Persons.jsx`):
    // el KMS ya los proyecta, y se normalizan igual por si alguno viniera vacío.
    persons: personasKms.map(row => ({
      personal_id: row.personal_id,
      first_name:  row.first_name || '',
      last_name:   row.last_name  || '',
    })),
  };
}

/**
 * ②17 (noveno tramo, 2026-08-15) — EL ÚNICO SITIO por el que este proceso pregunta DE QUIÉN
 * es un correo (o el identificador opaco de un enlace) dentro de un expediente.
 *
 * Hasta hoy la cadena de identidad hacía hasta CINCO consultas a AppSheet **desde este
 * proceso, que es público y anónimo, con la credencial de la aplicación entera**: las
 * personas del expediente (la ficha COMPLETA de cada una —MENORES INCLUIDOS: nombre, fecha
 * de nacimiento, documento— solo para saber quién es tutor), sus correos, la fila del `n`
 * del enlace **leída por su clave y sin acotar al expediente**, y hasta dos veces la
 * cabecera. Ahora lo contesta el KMS en UNA pregunta: `enr.wizardTutorQueRecupera`.
 *
 * ⛔ **NO SE ESCRIBE UN SEGUNDO LECTOR.** Éste es el ayudante único; `resolveGuardianForRecovery_`
 * y `resolveEmailFromLinkParam_` son clientes suyos. El resolvedor de verdad vive en el KMS
 * (`enr_resolveGuardianFromEmail_`) y es ÚNICO desde este tramo (consolidación P245): antes
 * había un gemelo aquí que DEBÍA permanecer idéntico, y ya había divergido —el de aquí
 * descartaba a quien la familia había quitado con `is_active` en falso y el del KMS no—.
 *
 * ⚠️ **LANZA si no se puede preguntar, y es el criterio del oro, no una elección nueva:**
 * las lecturas que sustituye NO estaban envueltas en `try` (`appsheetRequest_` lanzaba).
 * Decir «no es tutor» cuando en realidad no se pudo consultar dejaría a una familia sin
 * firmar, sin ver su documento o sin recibir su enlace, y sin saber por qué. Los llamantes
 * que ya degradaban lo siguen haciendo en SU `try/catch` de siempre.
 *
 * MEMORIA DE EJECUCIÓN (no ScriptCache): la cadena resuelve dos veces lo mismo dentro de la
 * MISMA petición (`effectiveRecoveredEmail_` pregunta por el `n`, y después
 * `resolveGuardianForRecovery_` por el correo que salió de ahí). Se recuerda solo mientras
 * dura la ejecución ⇒ cero riesgo de servir una identidad vieja, a diferencia de un TTL.
 * La respuesta del `n` siembra además la entrada del correo que resolvió: es el MISMO dato,
 * contestado por el MISMO sitio, para el MISMO expediente.
 *
 * @param {string} resumeToken  el token de la sesión (KAL-4: el expediente sale de ÉL).
 * @param {Object} opciones     { correo } o { n } — UNO de los dos, nunca los dos.
 * @returns {{correo:(string|null), tutor:(string|null), email_id:(string|null)}}
 */
var _TUTOR_MEMO_ = {};   // vive lo que dura la ejecución de GAS, ni un ms más
function _tutorQueRecupera_(resumeToken, opciones) {
  var vacio = { correo: null, tutor: null, email_id: null };
  var token = resumeToken ? String(resumeToken).trim() : '';
  if (!token) return vacio;
  try { assertValidUuid_(token, 'resume_token'); } catch (e) { return vacio; }

  var o = opciones || {};
  var n      = o.n      ? String(o.n).trim() : '';
  var correo = o.correo ? String(o.correo).toLowerCase().trim() : '';
  if ((n && correo) || (!n && !correo)) return vacio;

  // Validación local ANTES del viaje: un discriminador basura se ignoraba limpio en el oro
  // (`resolveGuardianForRecovery_` / `resolveEmailFromLinkParam_` devolvían null sin leer).
  if (n) { try { assertValidUuid_(n, 'n_email_id'); } catch (e1) { return vacio; } }
  else   { try { assertValidEmail_(correo, 'recovered_email'); } catch (e2) { return vacio; } }

  var clave = token + '|' + (n ? 'n:' + n : 'c:' + correo);
  if (Object.prototype.hasOwnProperty.call(_TUTOR_MEMO_, clave)) return _TUTOR_MEMO_[clave];

  var r = kmsProxy_('enr.wizardTutorQueRecupera',
    n ? { resume_token: token, n: n } : { resume_token: token, correo: correo }) || {};
  var out = {
    correo:   r.correo   || null,
    tutor:    r.tutor    || null,
    email_id: r.email_id || null,
  };
  _TUTOR_MEMO_[clave] = out;
  // El camino del `n` ya contestó por SU correo: se siembra para que la segunda pregunta
  // de la misma petición no pague otro viaje. Mismo dato, mismo sitio, mismo expediente.
  if (n && out.correo) _TUTOR_MEMO_[token + '|c:' + out.correo] = out;
  return out;
}

/**
 * IDENTITY-FROM-LINK (2026-06-11) — resuelve el email del guardian que recupera A PARTIR
 * DEL PROPIO ENLACE, usando SOLO datos existentes: el parámetro `n` del magic link, que
 * lleva el `email_id` (PK de la fila `enrEmails` del guardian al que se emitió el link).
 * El `email_id` es OPACO, sin PII, y YA EXISTE en la BD — cero columna nueva.
 *
 * Modelo canónico de Diego (LA regla, cita literal — corrección de rumbo 2026-06-11):
 *   "Tienes herramientas y datos suficientes para resolver la identidad sabiendo el
 *    email con el que se solicita el link. No pienso crear un campo que solo sirve a
 *    uno de los tipos de programa."
 *
 * ②17 (noveno tramo, 2026-08-15): la lectura ya NO la hace este proceso. Se la pide al KMS
 * por el ayudante único `_tutorQueRecupera_`. Las DOS guardas viajaron CON su lectura,
 * porque son inseparables de ella y ése es el criterio de los tramos anteriores:
 *   · la fila del `n` **pertenece al expediente del token** (KAL-4) — allí ni se busca fuera
 *     del expediente, así que una fila ajena no llega a existir para este proceso;
 *   · ese correo **resuelve a un tutor**; si no, no se concede identidad (null limpio →
 *     degrada al modelo group-scoped intacto, exactamente como antes).
 *
 * @param {string} resumeToken  token de la sesión (KAL-4 — el expediente sale de ÉL)
 * @param {string} nParam       p.n del payload (email_id candidato, de la URL del link)
 * @returns {string|null} email (lowercased) del guardian, o null (degrada group-scoped)
 */
function resolveEmailFromLinkParam_(resumeToken, nParam) {
  if (!nParam) return null;
  var r = _tutorQueRecupera_(resumeToken, { n: nParam });
  if (!r.correo || !r.tutor) {
    Logger.log(redact_('[resolveEmailFromLinkParam_] `n` no resuelve a tutor de este expediente (rechazado)'));
    return null;
  }
  return r.correo;
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
 * ②24.bis (2026-08-10) — EL RESPALDO (paso 3) SE PUEDE DESACTIVAR, Y HAY QUE HACERLO PARA
 * ATRIBUIR. El paso 3 no dice «no se sabe»: dice «el tutor 1». Eso es lo correcto para
 * DECIDIR A QUÉ BUZÓN se manda el código de un solo uso y DE QUIÉN es la marca de step-up
 * (como mucho se comporta como siempre), y es MENTIRA cuando lo que se decide es QUIÉN
 * FIRMÓ un consentimiento (`sysConsentsLog` es el registro legal). Por eso el modo estricto
 * se DECLARA en la llamada — `opts.sinRespaldo:true` — en vez de existir un segundo
 * resolvedor que pudiera divergir de éste. Los pasos 1 y 2 son idénticos en los dos modos.
 *
 * ②17 (noveno tramo, 2026-08-15) — ESTA FUNCIÓN YA NO LEE APPSHEET, y su firma lo dice:
 * toma el `resume_token` en vez del identificador del expediente. Los pasos 1 y 3 eran las
 * dos lecturas que quedaban; hoy el paso 1 lo sirve `_tutorQueRecupera_` y el paso 3 la
 * cabecera del sexto tramo (`_expedienteDelToken_`, lector ÚNICO). Los `emailsHint` /
 * `personsHint` de la firma vieja **desaparecen**: no queda nada aquí a lo que alimentar.
 * ⛔ **LA PRECEDENCIA NO SE MOVIÓ**: sigue decidiéndose aquí, en el asistente. Lo único que
 * cambió es de dónde salen los datos con los que se decide.
 *
 * @param {string} resumeToken                token de la sesión (KAL-4)
 * @param {string|null} clientRecoveredEmail  p.recovered_email (puede faltar)
 * @param {string|null} nParam                p.n del payload (email_id del enlace)
 * @param {Object} [groupHint]                cabecera ya leída (evita re-preguntarla)
 * @param {Object} [opts]                     { sinRespaldo:true } ⇒ NO caer al `primary_email`
 *                                            (paso 3). Sin él, comportamiento de siempre.
 * @returns {string|null}
 */
function effectiveRecoveredEmail_(resumeToken, clientRecoveredEmail, nParam, groupHint, opts) {
  // 1. Prioridad: identidad DEL ENLACE (`n` = email_id) resuelta server-side.
  var fromLink = resolveEmailFromLinkParam_(resumeToken, nParam);
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
  //    una pestaña con token viejo, sin `n` ni recovered_email del cliente— la SOLICITUD
  //    conoce el email de su solicitante: `primary_email` es el ARTEFACTO Stage-1 = email
  //    personal del tutor 1 (el que creó la solicitud). Es el guardian por defecto canónico
  //    de una recuperación group-scoped sin discriminador.
  //    KAL-4: el expediente sale SIEMPRE del token (server-side); `primary_email` se lee de
  //    la cabecera de ESE expediente, jamás del payload.
  //
  //    ②24.bis — QUIEN QUIERE ATRIBUIR NO PASA DE AQUÍ. El respaldo devuelve «el tutor 1»,
  //    nunca «no se sabe»: sirve para elegir buzón (el código de un solo uso, la marca de
  //    step-up) y NO para decir quién firmó. El llamante que necesita la verdad lo declara
  //    con `opts.sinRespaldo` y se lleva `null`, que es la respuesta honesta.
  if (opts && opts.sinRespaldo) return null;
  try {
    // ②17 (sexto tramo): la cabecera la sirve el KMS, por su lector ÚNICO. Degrada a null
    // exactamente como el `try/catch` que envolvía aquí la lectura de AppSheet.
    var grow = groupHint || _expedienteDelToken_(resumeToken).fila;
    var pe = grow && grow.primary_email ? String(grow.primary_email).toLowerCase().trim() : '';
    if (pe) {
      try { assertValidEmail_(pe, 'primary_email'); return pe; }
      catch (e2) { /* primary_email malformado → null */ }
    }
  } catch (e3) { /* lectura falló → null (group-scoped, comportamiento previo) */ }
  return null;
}

/**
 * Resuelve el guardian de un email dentro del expediente del token (DL-E38 REFINADO a1).
 *
 * ②17 (noveno tramo, 2026-08-15) — YA NO RESUELVE NADA AQUÍ: se lo pregunta al KMS por el
 * ayudante único `_tutorQueRecupera_`. El resolvedor canónico —el matching per-guardian con
 * sus dos sub-casos legados (fila de correo huérfana sin persona vinculada · el correo que
 * casa con el `primary_email` de la cabecera, ambos resueltos al solicitante)— vive en
 * `enr_resolveGuardianFromEmail_` (`kis-app kms-server/enr/wizard-datalayer.gs`) y es el
 * ÚNICO del sistema desde este tramo (consolidación P245).
 *
 * Por qué se consolidó, medido: el gemelo que vivía aquí y el del KMS **DEBÍAN permanecer
 * idénticos** (los dos lo decían en su JSDoc) y **ya no lo eran** — éste descartaba a quien
 * la familia había quitado con la bandera `is_active` en falso (arreglo del 2026-08-09) y el
 * del KMS solo miraba `deleted_at`, que siete de las tablas de admisión todavía no tienen.
 *
 * Lo que este proceso —público y anónimo— deja de bajar: la ficha COMPLETA de cada persona
 * del expediente, MENORES INCLUIDOS, solo para saber quién es tutor.
 *
 * KAL-4: el expediente lo deriva el KMS del `resume_token`, NUNCA del cuerpo de la petición.
 *
 * @param {string} resumeToken     token de la sesión (KAL-4)
 * @param {string} recoveredEmail  email que tecleó la familia (discriminador)
 * @returns {string|null} guardian person_id, o null si ningún tutor de ese expediente lo tiene
 */
function resolveGuardianForRecovery_(resumeToken, recoveredEmail) {
  if (!recoveredEmail) return null;
  return _tutorQueRecupera_(resumeToken, { correo: recoveredEmail }).tutor;
}

// ②17 (noveno tramo, 2026-08-15) — aquí vivía `findEmailIdForGuardian_`, el espejo inverso
// de la resolución del enlace: localizaba el `email_id` de un correo DENTRO del expediente
// para meterlo en el `n` del magic link. Leía `enrEmails` otra vez desde este proceso. Su
// respuesta la da ahora la MISMA pregunta al KMS (`email_id` de `_tutorQueRecupera_`), que
// la calcula sobre las filas que ya tiene en la mano — cero consultas de más, y sin un
// segundo lector del mismo dato. Criterio copiado VERBATIM: casa por el VALOR del correo y
// nada más (cualquier fila viva del expediente, con o sin persona vinculada), así que sigue
// habiendo `n` para correos que no resuelven a tutor, igual que antes.

/**
 * Resends magic link for an existing enrollment session.
 *
 * DL-E15: queries enrEnrollmentGroups (the session header) — primary_email,
 * preferred_language and resume_token now live there, not on enrEnrollments.
 *
 * DOS CAMINOS con contratos de respuesta DISTINTOS:
 *   - `resume_token` (uso interno del wizard, "Guardar y seguir luego"): el
 *     grupo se DERIVA del token (KAL-4, `requireResumeToken_`) — NUNCA se lee
 *     del cuerpo de la petición. Los errores SÍ se propagan (el wizard los
 *     muestra como toast).
 *   - `primary_email` (servicio público de recuperación, la landing): respuesta
 *     CONSTANTE `{sent:true, warm_ticket:<uuid>}` exista o no una solicitud para
 *     ese email — WIZ-ENUM (audit 2026-07-27), mismo patrón anti-enumeración que
 *     `recognizeFamily_` (KAL-10). Nunca lanza por "no encontrado"/bloqueo/fallo
 *     de envío; el motivo real solo va a log redactado (KAL-11). Si el email no
 *     tiene grupo, la creación de la solicitud nueva se delega server-side a
 *     `initEnrollmentSession_` (verja reCAPTCHA fail-closed).
 *
 * @param {Object} p - { resume_token } or
 *                     { primary_email, preferred_language?, recaptcha_token? }
 */
function sendMagicLink_(p) {
  if (p && p.resume_token) {
    // ── LA QUINTA PUERTA, AHORA CON LLAVE (②26, 2026-08-10) ──────────────────
    // Rama INTERNA: "Guardar y seguir luego", que el asistente llama DESDE DENTRO
    // de la sesión de la familia — donde el resume_token ya existe.
    //
    // Hasta hoy esta rama entraba por el identificador del expediente que venía en
    // el CUERPO de la petición y NO pedía nada más: ni verja ni credencial, solo
    // que el identificador tuviera forma de UUID. Y el identificador lo reparte el
    // propio sistema (`initEnrollmentSession` lo devuelve a cambio de un reCAPTCHA).
    // Con él, cualquiera desde internet podía, hasta 5 veces por hora: bombardear el
    // buzón de esa familia, ROTAR su enlace vivo bajo los pies de quien estuviera
    // rellenando la solicitud, y agotarle el cupo (⇒ su recuperación legítima de esa
    // hora se rechaza). El token NO se filtraba en la respuesta ⇒ no había toma de
    // control; lo que había era hostigamiento.
    //
    // KAL-4: el grupo se DERIVA del token y NUNCA se lee del cuerpo. `requireResumeToken_`
    // es el gate canónico de las mutaciones de /apply — se reutiliza tal cual (trae el
    // rechazo de abandonado y el TTL de 7 días que esta rama comprobaba a mano), en su
    // forma VIVA: nunca el memo de lectura, porque esta rama ROTA el token.
    //
    // VA LO PRIMERO, antes del cupo y del resto de lecturas: mismo motivo que la verja
    // de la rama pública (②2) — quien no trae llave no debe poder gastar trabajo ni
    // consumirle el cupo a una familia real.
    const groupId = requireResumeToken_(p);

    // Lector PRESERVADO tal cual (era `:2609-2613` en origin/main): la fila del grupo se
    // lee por su identificador, ahora el que autoriza el token en vez del que llegaba en
    // el cuerpo. El gate ya bajó esta misma fila para validar el token, pero no la
    // devuelve; se paga una lectura de más antes que reescribir un gate del que cuelgan
    // todos los pasos del asistente. El rechazo de expediente abandonado ya lo hace el
    // gate (mismo mensaje para toda la familia de handlers), así que aquí desaparece.
    const rows = appsheetRequest_(T.ENROLLMENT_GROUPS, 'Find', [], {
      Filter: '"enrollment_group_id" = "' + appsheetEscape_(groupId) + '"'
    });
    const grp = rows && rows[0];
    if (!grp) throw new Error('Enrollment group not found');
    // DL-E38 a1: per-guardian destination — if the family is recovering with a
    // specific guardian email (matched server-side against enrEmails of the
    // group), send the link to THAT guardian; else fallback to the group
    // primary_email (GAP-2 / pre-Step-2). KAL-4: groupId derived from token-path
    // caller, recovered_email only ever a discriminator validated against real rows.
    let destEmail = grp.primary_email;
    // ②17 (noveno tramo, 2026-08-15): el lote paralelo de `enrEmails` + `enrPersons` que
    // alimentaba a los dos resolvedores y a `findEmailIdForGuardian_` DESAPARECE — bajaba a
    // este proceso público y anónimo la ficha COMPLETA de cada persona del expediente,
    // MENORES INCLUIDOS, solo para saber quién es tutor. Lo contesta el KMS, y la MISMA
    // pregunta devuelve además el `email_id` del enlace (antes, una tercera pasada).
    // ⛔ La DECISIÓN sigue aquí, verbatim: preferir el correo que la familia tecleó y caer al
    //    `primary_email` (tutor 1 / artefacto Stage-1) solo si aquél no resuelve a un tutor.
    // ⚠️ Va ANTES de renovar el token: la renovación lo ROTA, y el token viejo deja de
    //    resolver ⇒ preguntar después devolvería `n` vacío para toda familia con borrador.
    let nEmailId = null;
    const tutorTecleado = p.recovered_email
      ? _tutorQueRecupera_(p.resume_token, { correo: p.recovered_email })
      : null;
    if (tutorTecleado && tutorTecleado.tutor) {
      destEmail = String(p.recovered_email).toLowerCase().trim();
      nEmailId = tutorTecleado.email_id;
    } else {
      const tutorPrimario = _tutorQueRecupera_(p.resume_token, { correo: grp.primary_email });
      // Sin correo tecleado que resuelva: si el `primary_email` es de un tutor (caso
      // tutor-1 / artefacto Stage-1), ése es el tutor del enlace y de él sale el `n`.
      if (tutorPrimario.tutor) nEmailId = tutorPrimario.email_id;
    }
    _checkMagicLinkRateLimit_((destEmail || '').toLowerCase().trim());
    _checkMagicLinkRateLimitIp_(null /* KAL-6: IP source pending — GAS no expone IP; noop */);

    // Renew token + created_at for non-submitted sessions so the new link is
    // always valid for a fresh 7-day window regardless of when the session was
    // originally created. Also invalidates any previously sent magic links.
    // P1-B: la renovación la hace el KMS (enr.wizardTouchSession) — minta el token
    // nuevo server-side (CSPRNG) y lo persiste; si no pudo persistir (P72) devuelve
    // renewed:false con el token vivo (mismo fallback que el batch multi histórico).
    let tokenToSend = grp.resume_token;
    if (!grp.submitted_at) {
      const touch = kmsProxy_('enr.wizardTouchSession', { resume_token: grp.resume_token });
      tokenToSend = (touch && touch.resume_token) || grp.resume_token;
      // ⛔ ②17 (2026-08-19) — AQUÍ SE ROTA EL ENLACE, así que la cabecera que la puerta dejó
      // en la memoria de EJECUCIÓN queda CADUCA: lleva dentro el `resume_token` VIEJO, que a
      // partir de esta línea ya no resuelve. Se OLVIDA en el acto —la vieja y la nueva— para
      // que nadie, ni hoy ni en un camino futuro, sirva de memoria un enlace muerto. Esta
      // rama NUNCA se sirve de la memoria: su gate es `requireResumeToken_` en forma VIVA, y
      // corre ANTES de esta rotación.
      _olvidarCabeceraMemo_(p.resume_token, groupId);
      _olvidarCabeceraMemo_(tokenToSend, groupId);
      if (touch && touch.renewed) {
        // KAL-11: redact group_id UUID before persisting to Stackdriver.
        Logger.log(redact_('sendMagicLink_: renewed token for group ' + grp.enrollment_group_id));
      }
    }

    // IDENTITY-FROM-LINK (2026-06-11): `n` := email_id de la fila enrEmails del guardian
    // destino (opaco, sin PII, ya existe). La identidad viaja EN EL ENLACE; cero columna.
    // ②17: ya resuelto arriba, en la MISMA pregunta que dijo de quién es el correo. Sin
    // tutor que case → `nEmailId` queda null y el enlace sale sin `n`, igual que antes.
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
      lang:             langP1,
    });
    // SPEC-WIZ-WARMUP-V2: ticket para que el frontend dispare warmBundle fire-and-forget
    // con el token NUEVO (que solo viaja por email). Identidad warm = la del click real.
    return { sent: true, warm_ticket: _mintWarmTicket_([{ t: tokenToSend, n: nEmailId, e: destEmail, l: langP1 }]) };
  } else if (p.primary_email) {
    // ── WIZ-ENUM (audit 2026-07-27): ACK CONSTANTE anti-enumeración (KAL-10) ──
    // ANTES: grupo existente → `{sent:true}`; sin grupo → `throw 'Enrollment group
    // not found'`. Dos respuestas DISTINGUIBLES en un action del dispatcher público
    // (manifest ANYONE_ANONYMOUS, sin verja reCAPTCHA) ⇒ oráculo: cualquiera con
    // internet podía preguntar "¿esta familia está matriculando?" email a email.
    // AHORA: TODO el trabajo (buscar grupo, rotar token, mandar el enlace, o crear
    // la sesión nueva) es BEST-EFFORT SILENCIOSO y la respuesta es SIEMPRE la misma
    // forma — `_magicLinkConstantAck_()`. Mismo patrón que `recognizeFamily_`
    // (KAL-10, shape constante para el caller público) y `reportUnsolicited_`
    // (ack incondicional). Lo "no encontrado" solo se registra en log REDACTADO
    // (KAL-11), nunca en la respuesta.
    //
    // La decisión recuperar-vs-crear vive AHORA SERVER-SIDE (antes la tomaba el
    // cliente ramificando sobre el propio oráculo: la landing leía "not found" y
    // llamaba a initEnrollmentSession). Ver la rama "sin grupo" abajo.
    assertValidEmail_(p.primary_email, 'primary_email');
    const typedEmail = p.primary_email.toLowerCase().trim();

    // ── LA VERJA, LO PRIMERO (②2, 2026-08-09) ────────────────────────────────
    // El ACK ya era indistinguible (WIZ-ENUM), pero EL TIEMPO NO: con expediente
    // esta rama hace dos viajes al KMS (renovar el enlace + mandar el correo) y
    // tarda ~46 s; sin expediente se queda en ~7 s. Cronometrando, cualquiera con
    // internet volvía a preguntar «¿esta familia está matriculando?» email a email,
    // que es EXACTAMENTE lo que el ack constante vino a cerrar.
    //
    // Se cierra quitando el trabajo caro del camino de quien no pasa la verja —
    // NO igualando tiempos con una espera. Igualar habría obligado a retener cada
    // petición ~50 s, y Apps Script limita las ejecuciones simultáneas: unas pocas
    // peticiones dejarían la ÚNICA puerta pública de admisiones sin atender. Se
    // habría cambiado un oráculo por una caída.
    //
    // Coste para las familias: NINGUNO. La portada ya calcula y manda este token
    // en esta misma llamada (`LandingPage.jsx`, `grecaptcha.execute`), y crear una
    // solicitud YA exigía la misma verja — si no estuviera configurada, dar de alta
    // estaría roto hoy. Además la portada NO espera la respuesta (fire-and-forget):
    // pinta su pantalla genérica al instante.
    //
    // NUNCA lanza: un error aquí solo puede distinguirse de un éxito ⇒ mismo ack.
    const verja = _verjaPublicaVeredicto_(p.recaptcha_token);
    if (!verja.ok) {
      Logger.log(redact_('sendMagicLink_: suppressed for ' + typedEmail +
                 ' (' + verja.code + ') — constant ack (②2)'));
      return _magicLinkConstantAck_();
    }

    // Rate-limit ANTES del lookup: el cupo se consume igual exista o no el grupo
    // (comprobarlo DESPUÉS haría que "no consumir cupo" fuese otro oráculo). Un
    // bloqueo NO se surface: `BLOCKED_BY_REPORT` delata que ese email recibió un
    // enlace alguna vez, y `RATE_LIMITED` delataría el tráfico previo del email.
    // Se traga y se devuelve el mismo ack — el cupo SÍ se aplica (no se envía nada).
    try {
      _checkMagicLinkRateLimit_(typedEmail);
      _checkMagicLinkRateLimitIp_(null /* KAL-6: IP source pending — GAS no expone IP; noop */);
    } catch (eRate) {
      Logger.log(redact_('sendMagicLink_: suppressed for ' + typedEmail +
                 ' (' + ((eRate && eRate.code) || 'RATE') + ') — constant ack'));
      return _magicLinkConstantAck_();
    }

    try {
      // ── ②17 OCTAVO TRAMO (2026-08-15): LAS LECTURAS LAS HACE EL KMS ─────────
      // Este proceso es PÚBLICO Y ANÓNIMO y hasta hoy preguntaba a AppSheet, con la
      // credencial de la aplicación ENTERA, filtrando por un correo que teclea
      // cualquiera: los expedientes de ese correo, TODAS las filas de `enrEmails` de
      // ese buzón, y la ficha COMPLETA de cada persona —MENORES INCLUIDOS— de los
      // expedientes que casaran, solo para comprobar que el correo es de un tutor.
      // Ahora lo sirve `enr.wizardRecuperacionDelCorreo` con los MISMOS filtros,
      // proyectado a cinco campos por expediente y un identificador opaco por
      // expediente. Lector ÚNICO: `_recuperacionDelCorreo_`.
      //
      // ⛔ LA DECISIÓN NO SE MUEVE: preferir la lista del correo principal y caer a la
      // del tutor sigue AQUÍ, verbatim — por eso llegan las dos listas por separado.
      //
      // DL-E38: la recuperación DEBE funcionar para expedientes ya enviados / admitidos,
      // para que el enlace los devuelva a la firma. Solo se excluyen los abandonados; a
      // los enviados se les manda su token EXISTENTE (abajo se salta su renovación,
      // igual que en el camino 1).
      const recuperacion = _recuperacionDelCorreo_(p.primary_email);
      // DL-E38 a1: un tutor NO principal recupera con SU propio correo — el KMS localiza
      // esos expedientes por `enrEmails` (y comprueba ahí dentro que la fila es de un
      // tutor, no de un menor). El enlace se manda al correo tecleado, o sea al buzón de
      // ese tutor.
      let rows = recuperacion.porCorreoPrincipal;
      if (!rows || !rows.length) {
        rows = recuperacion.porTutor;
      }
      if (!rows || !rows.length) {
        // WIZ-ENUM: sin grupo NO se lanza — ack constante. Y como la landing ya no
        // puede ramificar (no hay señal), la creación de la solicitud nueva se hace
        // AQUÍ, best-effort, delegando en el escritor probado `initEnrollmentSession_`
        // (mismos parámetros que la landing le pasaba: primary_email + idioma +
        // recaptcha_token). Su verja reCAPTCHA sigue siendo FAIL-CLOSED y es la que
        // gobierna la creación: sin token válido NO se crea nada y NO se manda nada
        // (un bot sin reCAPTCHA no gana capacidad nueva; el action `initEnrollmentSession`
        // ya era público con esa misma verja). El `resume_token` que devuelve NO se
        // propaga al cliente (KAL-7: viaja solo por email).
        Logger.log(redact_('sendMagicLink_: no open group for ' + typedEmail + ' — constant ack (WIZ-ENUM)'));
        let created = null;
        try {
          created = initEnrollmentSession_({
            primary_email:      p.primary_email,
            preferred_language: p.preferred_language || 'es',
            recaptcha_token:    p.recaptcha_token || null,
            source_code:        'WEB_PUBLIC',
          }, { internal: true });   // WIZ-ENUM: el cupo de magic-link YA se consumió arriba
        } catch (eInit) {
          // Sin reCAPTCHA válido / rate-limit / fallo del KMS → no se crea sesión.
          // NUNCA se surface (delataría el camino tomado). KAL-11: redactado.
          Logger.log(redact_('sendMagicLink_: new-session fallback not performed (' +
                     ((eInit && eInit.message) || 'unknown') + ')'));
        }
        return _magicLinkConstantAck_(created && created.warm_ticket);
      }

      // Renew tokens + created_at for NON-submitted sessions before sending so the
      // new link is valid for a fresh 7-day window. Submitted/AD sessions keep
      // their EXISTING resume_token untouched (no created_at reset) — exactly like
      // Path 1 — so recovery into signing reuses the live token.
      // P1-B (WIZARD-DIRECT-WRITE-MIGRATION): las renovaciones (Edits) se portan al KMS
      // — un enr.wizardTouchSession por grupo NO-submitted (el KMS minta y persiste el
      // token server-side). Si una renovación falla, ese grupo conserva su token
      // original (mismo fallback que el batch histórico). La lectura de enrEmails por
      // grupo sigue en UN batch paralelo (read-only, PERF 2026-06-12 intacta).
      const sorted = rows.sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
      const newTokens = {};   // group_id → token nuevo persistido por el KMS
      sorted.forEach(g => {
        if (g.submitted_at) return; // submitted: send existing token, do not renew
        try {
          const touch = kmsProxy_('enr.wizardTouchSession', { resume_token: g.resume_token });
          // ⛔ ②17 (2026-08-19) — misma rotación, mismo olvido que en la rama de arriba.
          _olvidarCabeceraMemo_(g.resume_token, g.enrollment_group_id);
          if (touch && touch.resume_token) _olvidarCabeceraMemo_(touch.resume_token, g.enrollment_group_id);
          if (touch && touch.renewed && touch.resume_token) {
            newTokens[g.enrollment_group_id] = touch.resume_token;
          } else {
            // KAL-11: redact group_id UUID.
            Logger.log(redact_('sendMagicLink_: token not renewed for group ' + g.enrollment_group_id + ' (KMS fallback — keeps live token)'));
          }
        } catch (e) {
          Logger.log(redact_('sendMagicLink_: failed to renew token for group ' + g.enrollment_group_id + ': ' + e.message));
        }
      });
      // ②17 (octavo tramo): el `email_id` de ESTE buzón en CADA expediente ya viene
      // resuelto por el KMS —que es quien lee `enrEmails`—, de modo que aquí no se
      // vuelve a AppSheet ni cruzan filas de correos. Sigue siendo "el identificador
      // del MISMO expediente": el mapa está indexado por expediente, así que no puede
      // colarse un `email_id` ajeno en el enlace. Sin él → `n` ausente → enlace
      // group-scoped, exactamente el respaldo de antes.
      const identificadorDeCorreo = recuperacion.identificadorDeCorreo;
      const grps = sorted.map(g => {
        const gid = g.enrollment_group_id;
        return (gid in newTokens) ? { ...g, resume_token: newTokens[gid] } : g;
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
        const nEmailId = identificadorDeCorreo[grps[0].enrollment_group_id] || null;
        _mintMagicLinkNonce_(grps[0].resume_token, grps[0].enrollment_group_id);
        // WIZARD-TERMINAL P3: contenido gobernado por el KMS. isFirstApp false (recuperación).
        const resumeUrlR = RESUME_BASE_URL + grps[0].resume_token + (nEmailId ? '?n=' + nEmailId : '');
        sendViaKmsNotify_('WIZARD_MAGIC_LINK', p.primary_email, {
          family_name:      '',
          resume_url:       resumeUrlR,
          report_url:       REPORT_BASE_URL + grps[0].resume_token,
          gdpr_block:       _kmsRenderGdprBlock_(false),
          admissions_email: ADMISSIONS_EMAIL,
          lang:             lang,
        });
        // SPEC-WIZ-WARMUP-V2: ticket de warm con el token (renovado o vivo) del grupo.
        // WIZ-ENUM: misma forma de respuesta que el camino "sin grupo".
        return _magicLinkConstantAck_(_mintWarmTicket_([{ t: grps[0].resume_token, n: nEmailId, e: identityEmail, l: lang }]));
      } else {
        // Un email_id por grupo (paralelo a los tokens): cada link lleva el `n` del email
        // del guardian en SU grupo. La gracia OTP-skip se ancla al resume_token de cada grupo.
        const nEmailIds = grps.map(g => identificadorDeCorreo[g.enrollment_group_id] || null);
        grps.forEach(g => _mintMagicLinkNonce_(g.resume_token, g.enrollment_group_id));
        // WIZARD-TERMINAL P3: la lista de enlaces la pre-renderiza el wizard en UN placeholder;
        // el resto del contenido (saludo, footer) lo gobierna el KMS. El report link usa el
        // primer token (reportUnsolicited_ bloquea el email, no la sesión — cualquiera vale).
        sendViaKmsNotify_('WIZARD_MAGIC_LINK_MULTI', p.primary_email, {
          family_name:        '',
          resume_links_block: _kmsRenderResumeLinksBlock_(grps.map(g => g.resume_token), nEmailIds, lang),
          report_url:         REPORT_BASE_URL + grps[0].resume_token,
          admissions_email:   ADMISSIONS_EMAIL,
          lang:               lang,
        });
        // SPEC-WIZ-WARMUP-V2: UN ticket que cubre los N grupos (warmBundle los recorre).
        // WIZ-ENUM: misma forma de respuesta que el camino "sin grupo".
        return _magicLinkConstantAck_(_mintWarmTicket_(grps.map((g, i) => ({ t: g.resume_token, n: nEmailIds[i] || null, e: identityEmail, l: lang }))));
      }
    } catch (eSend) {
      // WIZ-ENUM: cualquier fallo del camino de envío (AppSheet, KMS notify, …) se
      // traga y devuelve el MISMO ack. Un error propagado aquí solo puede ocurrir
      // cuando el grupo EXISTE → sería un oráculo residual. KAL-11: log redactado.
      Logger.log(redact_('sendMagicLink_: send path failed for ' + typedEmail + ' — constant ack (' +
                 ((eSend && eSend.message) || 'unknown') + ')'));
      return _magicLinkConstantAck_();
    }
  } else {
    throw new Error('Missing resume_token or primary_email');
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

  // ②17 (DUODÉCIMO tramo) — la cabecera la sirve el KMS, por el lector ÚNICO. Modo TOLERANTE
  // porque este manejador EXISTE para operar sobre sesiones que la puerta rechazaría: su
  // idempotencia («ya estaba abandonada») lo exige, y el oro leía la fila sin filtro alguno.
  // LA DECISIÓN NO SE MUEVE: los tres rechazos de abajo siguen aquí, verbatim.
  const consulta = _expedienteDelToken_(token, { tolerarSesionCerrada: true });
  if (!consulta.ok && !consulta.rechazo) {
    // No se pudo PREGUNTAR: se lanza (el oro lanzaba), pero sin decir «no existe» —
    // «empezar de nuevo» que falla por un KMS caído no debe parecer un enlace inválido.
    const errT = new Error('No se pudo comprobar el enlace ahora mismo; inténtalo de nuevo en un momento');
    errT.code = 'KMS_UNREACHABLE';
    throw errT;
  }
  const grp = consulta.fila;
  if (!grp) throw new Error('Enrollment group not found');
  if (grp.submitted_at) throw new Error('Cannot abandon a submitted application');
  if (grp.abandoned_at) return { abandoned: true }; // idempotent

  // P1-B (WIZARD-DIRECT-WRITE-MIGRATION): la escritura se porta al KMS
  // (enr.wizardAbandonSession). KAL-4: el grupo lo deriva el KMS del resume_token.
  // El KMS re-chequea submitted/abandoned server-side (mismas reglas de arriba).
  kmsProxy_('enr.wizardAbandonSession', { resume_token: token });

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
    // ②17 (DUODÉCIMO tramo) — la cabecera la sirve el KMS, por el lector ÚNICO. Modo
    // TOLERANTE: quien dice «esto no es mío» puede tener delante una sesión ya abandonada o
    // caducada, y el oro leía la fila sin filtro. LOS DOS FALLOS ACABAN IGUAL —acuse
    // silencioso— porque cualquier respuesta distinta reabriría el oráculo de existencia que
    // este manejador cierra a propósito; antes ocurría por el `catch` de fuera, ahora se dice.
    const consulta = _expedienteDelToken_(token, { tolerarSesionCerrada: true });
    if (!consulta.ok) {
      Logger.log(redact_('reportUnsolicited_: no se pudo resolver el expediente — ' +
        (consulta.motivo || '') + ' (acuse silencioso)'));
      return { reported: true };
    }
    const group = consulta.fila;
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
        // P1-B: escritura portada al KMS (enr.wizardAbandonSession). KAL-4: el grupo
        // sale del resume_token (que ES la autorización de este endpoint).
        kmsProxy_('enr.wizardAbandonSession', { resume_token: token });
        // KAL-11: redact UUID.
        Logger.log(redact_('reportUnsolicited_: abandoned ' + group.enrollment_group_id));
      } catch (abandonErr) {
        Logger.log(redact_('reportUnsolicited_: failed to abandon ' + group.enrollment_group_id + ': ' + abandonErr.message));
      }
    }

    // EMAIL-MIGRATION-2 (2026-06-25): el aviso interno "magic-link no solicitado" migra
    // al motor único del KMS (plantilla kis-tpl-wizard-unsolicited-reported). golden = HTML
    // inline de esta función. El wizard pre-renderiza el <li> de estado de sesión
    // (abandonada vs ya enviada) → {{SESSION_STATUS_NOTE}}; el resto del cuerpo (incluido
    // el aviso de bloqueo ~6h) lo provee la plantilla. P72/anti-enumeración: si el KMS
    // falla, se traga el error (el endpoint devuelve {reported:true} igual).
    var sessionStatusNote = group.submitted_at
      ? '<li><strong>Note:</strong> session was already submitted; NOT abandoned (preserves family access to submitted record).</li>'
      : '<li><strong>Session abandoned:</strong> yes</li>';
    sendViaKmsNotify_('WIZARD_UNSOLICITED_REPORTED', ADMISSIONS_EMAIL, {
      enrollment_id:       group.enrollment_group_id || '',
      reporter_email:      email,
      created_at:          group.created_at || '',
      reported_at:         nowIso,
      session_status_note: sessionStatusNote,
    });
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

// ②17 (noveno tramo, 2026-08-15) — aquí vivía el GEMELO de `resolveGuardianForRecovery_`,
// el que resolvía de verdad: leía `enrPersons` y `enrEmails` del expediente —la ficha
// COMPLETA de cada persona, MENORES INCLUIDOS, solo para saber quién es tutor— y hasta DOS
// veces la cabecera, todo desde este proceso público y anónimo con la credencial de la
// aplicación entera. Su JSDoc y el del KMS decían, los dos, que DEBÍAN permanecer idénticos
// «hasta consolidación P245»; ya habían divergido (éste descartaba a quien la familia había
// quitado con `is_active` en falso, el del KMS no). Ésta ES esa consolidación: el resolvedor
// ÚNICO es `enr_resolveGuardianFromEmail_` del KMS, servido por `enr.wizardTutorQueRecupera`,
// y aquí queda un cliente fino del mismo nombre — vive con el resto de la cadena de identidad,
// junto a `_tutorQueRecupera_`. PROHIBIDO escribir un segundo lector.

// ②17 (octavo tramo, 2026-08-15) — aquí vivía `findOpenGroupsByGuardianEmail_`, que
// localizaba los expedientes en los que el correo tecleado es de un TUTOR. Leía
// `enrEmails` por un correo ARBITRARIO y luego `enrEnrollmentGroups` + `enrPersons`
// —fichas COMPLETAS de menores incluidas— desde este proceso público y anónimo, solo
// para comprobar el papel de tutor. Esa comprobación es inseparable de la lectura, así
// que viajó CON ella al KMS (`enr.wizardRecuperacionDelCorreo` → `por_tutor`), y aquí
// no queda un segundo lector del mismo dato. Su ÚNICO llamante era la rama pública de
// `sendMagicLink_`, que hoy pide las dos listas por `_recuperacionDelCorreo_`.

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
 * cuenta; el envelope Click&Sign NO es la vara).
 *
 * ⚠️ ESTA divergencia SIGUE ABIERTA — la de P245 no. El 2026-08-15 (②17, noveno tramo) se
 * consolidó el resolvedor de la IDENTIDAD del tutor: hoy hay uno solo, y vive en el KMS.
 * Lo que aquí se describe es OTRA cosa —la tripleta de campos de FIRMA que emiten dos
 * sitios distintos— y ese emparejamiento sigue sostenido por disciplina, sin control que
 * lo vigile. No confundir el cierre de una con el de la otra.
 *
 * @param {string} groupId
 * @param {Array}  enrollments         filas enrEnrollments del grupo
 * @param {string|null} guardianPersonId  guardian resuelto server-side (a1)
 * @returns {{state_code, state_label, signing_available, signing_context, signing_ready, signing_status}}
 */
/**
 * DL-E41 ★ ACOTACIÓN 2026-08-02 — LAS TRES DERIVACIONES DE PANTALLA, EN UN SOLO SITIO.
 *
 * `editable`, `signing_available` y `signing_ready` **no son hechos del expediente**: son
 * decisiones de presentación de ESTE cliente («¿puedo editar?», «¿enseño el puente a la
 * firma?», «¿desbloqueo el avance?»). Diego lo cerró así: *«el KMS no tiene por qué saber
 * nada de la estructura o del funcionamiento del Wizard… los estados de pantalla del wizard
 * los gestiona el wizard»*.
 *
 * Hasta el 2026-08-03 se calculaban en DOS sitios —aquí y en el KMS— y **YA DIVERGÍAN**, no
 * en teoría: para un expediente admitido cuyo contexto de firma no resuelve, el KMS decía
 * `signing_available: (state === 'AD')` → **true**, y este cliente decía `!!signing_context`
 * → **false**. Ese campo gobierna el avance 7→8. El propio KMS lo admitía en un comentario:
 * «DEBEN permanecer idénticos a buildAdmissionContext_ del wizard». Dos cosas que «deben
 * permanecer idénticas» a base de buena voluntad acaban divergiendo — y aquí ya lo habían
 * hecho.
 *
 * Son funciones PURAS de datos que quien llama ya tiene: cero lecturas nuevas, cero latencia
 * (esta ruta es justo donde vivió la regresión de 68 s, así que eso importa).
 *
 * @param {string|null} stateCode       fase real del expediente (HECHO, viene del KMS).
 * @param {string|null} signingStatus   estado de la firma (HECHO, viene del KMS).
 * @param {Object|null} signingContext  contexto de firma ya resuelto por este cliente.
 * @returns {{editable:boolean, signing_available:boolean, signing_ready:boolean}}
 */
var WIZ_EDITABLE_STATE_CODES_ = { 'DRAFT': true, 'IN': true, 'NEEDS_MORE_INFO': true };

function derivarPantallaAdmision_(stateCode, signingStatus, signingContext) {
  return {
    // Sin estado real (pre-envío) el borrador es editable; con estado, lo gobierna el estado.
    editable:          stateCode ? !!WIZ_EDITABLE_STATE_CODES_[stateCode] : true,
    // Hay puente a la firma si HAY contexto de firma resuelto — no por estar en 'AD'.
    signing_available: !!signingContext,
    signing_ready:     (signingStatus !== 'NOT_INITIATED'),
  };
}

function buildAdmissionContext_(groupId, enrollments, guardianPersonId, persons, admHints) {
  // admHints (OPCIONAL) = {situaciones, sessions, signersBySession, resumeToken}.
  //  · `situaciones` — ②17 (decimotercer tramo): el catálogo de situaciones **servido por el
  //    KMS**, YA ACOTADO al colegio y a la máquina de estados DECLARADA del expediente
  //    (`enr.wizardEstadoDeLaAdmision`). Aquí NO se vuelve a filtrar por colegio ni por tipo:
  //    ese filtro es inseparable de la lectura y viajó con ella. **Y con él se fue el literal
  //    `ENR_ADMISSION_SCHOOL`, que DL-E48 prohíbe escribir a mano**: el dominio lo resuelve el
  //    KMS por la cadena `program_id → enrPrograms → enrProgramTypes`. Si el caller no las
  //    trae, se piden aquí con `resumeToken` (mismo patrón que las filas de firma).
  //  · `sessions` / `signersBySession` — ②17: filas de firma **servidas por el KMS**. Si el
  //    caller no las trae, se piden aquí con `resumeToken` (ver el bloque del estado 'AD').
  //    YA NO hay lectura directa de AppSheet para estas dos: sin filas se degrada como
  //    siempre hizo el `catch` (NOT_INITIATED / null).
  admHints = admHints || {};
  // URGENT-PASS3 BUG A (2026-06-11): `editable` deriva del ESTADO REAL (no de submitted_at).
  // Sin enrollments → pre-submit puro → editable (borrador). Con estado real, lo gobierna el
  // estado: ∈ {DRAFT,IN,NEEDS_MORE_INFO} ⟺ editable; resto (RQ,PS,RS,AD,…) ⟺ enviada/locked.
  var out = { state_code: null, state_label: null, signing_available: false, signing_context: null, signing_ready: false, editable: true };
  if (!enrollments || !enrollments.length) return out;

  // Catálogo de situaciones del expediente — lo sirve el KMS, ya acotado (②17).
  var perfS0 = Date.now(); // PERF-KMS2 (no-op si PERF2_.adm inactivo)
  var allStates = admHints.situaciones;
  if (!Array.isArray(allStates)) {
    // ⛔ FALLA CERRADO. La lectura que esto sustituye (`appsheetRequest_`) LANZABA, y aquí no
    // había `try`: seguir con el catálogo vacío devolvería `editable:true` para una familia
    // que ya envió, que es la degradación que este tramo vino a corregir.
    var pulso = _pulsoDeLaAdmision_(admHints.resumeToken);
    if (!pulso.ok) {
      var ePulso = new Error('No se pudo leer el catálogo de situaciones del expediente.');
      ePulso.code = 'KMS_UNREACHABLE';
      throw ePulso;
    }
    allStates = pulso.situaciones;
  }
  if (PERF2_.adm) PERF2_.adm.states_ms = Date.now() - perfS0;
  var statesById = {};
  allStates.forEach(function(s) {
    if (s && s.state_id) statesById[s.state_id] = s;
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
  // Lector ÚNICO de las derivaciones de pantalla (ver derivarPantallaAdmision_).
  out.editable = derivarPantallaAdmision_(out.state_code, out.signing_status, null).editable;

  if (out.state_code === 'AD') {
    // ②17 — las filas de firma las sirve el KMS, NO AppSheet. Si quien llama ya las
    // bajó (el pulso las pide una sola vez), se reusan; si no, se piden aquí con el
    // `resume_token` que ese mismo llamante trae (KAL-4: el KMS deriva el expediente del
    // token, aquí no viaja ningún id). Se pide DENTRO del `if` a propósito: un expediente
    // que aún no está admitido no tiene sesión de firma que mirar, y era el caso común.
    if (!Array.isArray(admHints.sessions) && admHints.resumeToken) {
      var firmaKms = _datosDeFirmaDelExpediente_(admHints.resumeToken);
      if (firmaKms) {
        admHints = {
          situaciones:      admHints.situaciones,
          resumeToken:      admHints.resumeToken,
          sessions:         firmaKms.sessions,
          signersBySession: firmaKms.signersBySession,
        };
      }
    }
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
    out.signing_available = derivarPantallaAdmision_(out.state_code, out.signing_status, out.signing_context).signing_available;

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
    out.signing_ready = derivarPantallaAdmision_(out.state_code, out.signing_status, out.signing_context).signing_ready;
  }
  return out;
}

// ─── ②17 · LAS FILAS DE FIRMA LAS SIRVE EL KMS, NO AppSheet ────────────────────
//
// **Éste es el MODELO, no un respaldo** (cola `②17`, `kis-app/docs/kms/loop-backlog.md`).
// Este backend es público y anónimo (`ANYONE_ANONYMOUS`) y guarda la credencial de
// AppSheet de la aplicación ENTERA: la URL lleva la tabla como parámetro, así que esa
// llave alcanza CUALQUIER tabla. Las tres resoluciones de firma de aquí abajo leían con
// ella `sysSigningSessions` y `sysSigningSessionSigners` — detrás hay identidades de
// firmantes y sus `signing_token`. Ahora las filas vienen del KMS
// (`enr.wizardDatosDeFirma`), que las acota **al expediente del `resume_token`** y no
// acepta ningún identificador del cuerpo de la petición.
//
// ⚠️ NO queda respaldo que vuelva a leer AppSheet a pelo, y es deliberado: dos lectores
// del mismo dato divergen (precedente §"refactors preservan el código probado"). Sin
// filas, cada resolución degrada EXACTAMENTE como su `catch` de siempre
// ('NOT_INITIATED' la de estado, `null` las dos de contexto).
//
// Lo que este cambio NO cierra, y hay que decirlo: la credencial de AppSheet **sigue
// haciendo falta** para el resto de lecturas directas de este fichero. Esto ESTRECHA el
// agujero; no lo cierra.

/**
 * Memoria de ESTA ejecución (no ScriptCache): varias resoluciones del mismo expediente
 * en la misma petición comparten una sola llamada al KMS. Una ejecución de GAS es un
 * hilo, así que es seguro; y al vivir solo lo que vive la petición, no puede servir
 * filas rancias.
 * @private
 */
var _FIRMA_MEMO_ = {};

/**
 * Las filas de firma del expediente del `resume_token`, pedidas al KMS (②17).
 *
 * KAL-4: el expediente lo deriva el KMS del token; aquí NO se manda ningún id de grupo,
 * sesión ni firmante. KAL-11: log redactado, nunca el token entero.
 *
 * @param {string} resumeToken
 * @returns {{sessions:Object[], signersBySession:Object<string,Object[]>}|null}
 *          `null` si no hay token, si el KMS falla o si la respuesta no trae sesiones —
 *          quien llama degrada como si la lectura hubiera fallado (que es lo que pasó).
 * @private
 */
function _datosDeFirmaDelExpediente_(resumeToken) {
  var token = resumeToken ? String(resumeToken).trim() : '';
  if (!token) return null;
  try { assertValidUuid_(token, 'resume_token'); } catch (e) { return null; }
  if (Object.prototype.hasOwnProperty.call(_FIRMA_MEMO_, token)) return _FIRMA_MEMO_[token];

  var out = null;
  try {
    var r = kmsProxy_('enr.wizardDatosDeFirma', { resume_token: token }) || {};
    if (Array.isArray(r.sessions)) {
      var porSesion = (r.signers_by_session && typeof r.signers_by_session === 'object')
        ? r.signers_by_session : {};
      out = { sessions: r.sessions, signersBySession: porSesion };
    } else {
      Logger.log('[_datosDeFirmaDelExpediente_] respuesta sin sesiones — se degrada');
    }
  } catch (e) {
    Logger.log(redact_('[_datosDeFirmaDelExpediente_] lectura KMS fallida — ' + (e && e.message)));
  }
  _FIRMA_MEMO_[token] = out;
  return out;
}

/**
 * Memoria de ESTA ejecución (no ScriptCache) — misma justificación que `_FIRMA_MEMO_`: el
 * pulso resuelve el mismo expediente hasta dos veces en la misma petición (una en
 * `getAdmissionState_` y otra en el respaldo de `buildAdmissionContext_`). Vive lo que vive
 * la petición ⇒ cero riesgo de servir filas rancias.
 * @private
 */
var _PULSO_MEMO_ = {};

/**
 * EL PULSO DE LA ADMISIÓN — lo que hace falta para saber en qué situación está el
 * expediente del `resume_token`, servido por el KMS (②17, decimotercer tramo).
 *
 * **LECTOR ÚNICO.** Sustituye al lote de TRES lecturas directas a AppSheet que hacía
 * `getAdmissionState_` —una acción PÚBLICA del despachador anónimo, disparada repetidamente
 * mientras la familia espera— más el respaldo de `buildAdmissionContext_`. Bajaba la ficha
 * COMPLETA de cada persona **—MENORES INCLUIDOS**— y el catálogo de situaciones ENTERO.
 * **PROHIBIDO escribir un segundo lector**: es la regresión que documenta §"Regla — refactors
 * preservan el código probado".
 *
 * KAL-4: el expediente lo deriva el KMS del token; aquí NO se manda ningún id de grupo, y el
 * nombre de la tabla no viaja. KAL-11: log redactado, nunca el token entero.
 *
 * ⛔ **DEVUELVE DOS COSAS, y hay que respetarlo** (mismo motivo que `_expedienteDelToken_`):
 *   · `{ok:true,  expedientes, personas, situaciones}` → los datos.
 *   · `{ok:false, motivo}`                             → **no se pudo preguntar** (o el KMS
 *     rechazó). NO es «no hay expediente»: quien llama **falla cerrado**, porque decir «no hay
 *     nada» hace que `buildAdmissionContext_` devuelva `editable:true` para una familia que ya
 *     envió, y borra de su pantalla la situación real y el puente a la firma.
 *
 * @param {string} resumeToken
 * @returns {{ok:boolean, expedientes:Object[], personas:Object[], situaciones:Object[], motivo:(string|null)}}
 * @private
 */
function _pulsoDeLaAdmision_(resumeToken) {
  var token = resumeToken ? String(resumeToken).trim() : '';
  var fallo = function(motivo) {
    // 0º.tricies.octies (B): con el pulso caído NO se afirma «todos tus guardados llegaron».
    // Lista vacía + «no se pudo mirar» — la diferencia entre las dos es EL defecto que se cierra.
    return { ok: false, expedientes: [], personas: [], situaciones: [], motivo: motivo,
             guardados_sin_aterrizar: [], guardados_no_consultables: true };
  };
  if (!token) return fallo('sin resume_token');
  try { assertValidUuid_(token, 'resume_token'); }
  catch (e) { return fallo('resume_token con forma inválida'); }
  if (Object.prototype.hasOwnProperty.call(_PULSO_MEMO_, token)) return _PULSO_MEMO_[token];

  var out;
  try {
    var r = kmsProxy_('enr.wizardEstadoDeLaAdmision', { resume_token: token }) || {};
    if (Array.isArray(r.expedientes) && Array.isArray(r.personas) && Array.isArray(r.situaciones)) {
      out = {
        ok:          true,
        expedientes: r.expedientes,
        personas:    r.personas,
        situaciones: r.situaciones,
        motivo:      null,
        // 0º.tricies.octies (B) — los pasos cuyo último guardado murió en la cola. El KMS manda
        // CÓDIGOS de paso, nunca el motivo literal del rechazo (puede nombrar columna y valor).
        // Un KMS viejo no manda el campo ⇒ lista vacía y «no consultable», que es la verdad.
        guardados_sin_aterrizar:   Array.isArray(r.guardados_sin_aterrizar) ? r.guardados_sin_aterrizar : [],
        guardados_no_consultables: (r.guardados_sin_aterrizar === undefined) || !!r.guardados_no_consultables,
      };
    } else {
      Logger.log('[_pulsoDeLaAdmision_] respuesta incompleta del KMS — se falla cerrado');
      out = fallo('respuesta incompleta');
    }
  } catch (e2) {
    var msg = (e2 && e2.message) || String(e2);
    Logger.log(redact_('[_pulsoDeLaAdmision_] lectura KMS fallida — ' + msg));
    out = fallo(msg);
  }
  _PULSO_MEMO_[token] = out;
  return out;
}

/**
 * La fila de UN documento del expediente del `resume_token`, pedida al KMS (②17).
 *
 * Sustituye a la lectura directa de `recFiles` que hacía la guarda de IDOR de
 * `getDocument_`. Mismo filtro (el documento **y** el expediente del token), y del otro
 * lado solo salen los cuatro campos que hacen falta para servir los bytes: el resto de la
 * ficha del documento ya no cruza a este proceso público.
 *
 * KAL-4: el expediente lo deriva el KMS del token; aquí NO se manda ningún id de grupo.
 * KAL-11: log redactado.
 *
 * ⚠️ **Devuelve TRES cosas, no dos, y por eso no basta con `null`:** quien llama tiene que
 * poder distinguir «este documento no está en tu expediente» (→ se prueba el camino del
 * paquete de firma, como siempre) de «no se pudo preguntar» (→ se lanza, como lanzaba la
 * lectura de AppSheet). Colapsarlas haría que un fallo pasajero le dijera «no es tuyo» a
 * la familia dueña del documento.
 *
 * @param {string} resumeToken
 * @param {string} fileId
 * @returns {{ok:boolean, fila:Object|null}} `ok:false` ⇒ no se pudo preguntar ·
 *          `ok:true, fila:null` ⇒ no está en este expediente.
 * @private
 */
function _ficheroDelExpediente_(resumeToken, fileId) {
  var token = resumeToken ? String(resumeToken).trim() : '';
  if (!token) return { ok: true, fila: null };
  try { assertValidUuid_(token, 'resume_token'); } catch (e) { return { ok: true, fila: null }; }

  try {
    var r = kmsProxy_('enr.wizardFicheroDelExpediente', {
      resume_token: token,
      file_id:      fileId,
    }) || {};
    return { ok: true, fila: r.fichero || null };
  } catch (e2) {
    Logger.log(redact_('[_ficheroDelExpediente_] lectura KMS fallida — ' +
      ((e2 && e2.message) || e2)));
    return { ok: false, fila: null };
  }
}

/**
 * ②17 (sexto tramo · ampliado en el DUODÉCIMO) — LA CABECERA del expediente que deriva el
 * `resume_token`, pedida al KMS. **UN SOLO lector.** Lo llaman:
 *   · los TRES puntos del camino de ENTRADA (sexto tramo) — `hydrateSession_` dos veces (la
 *     rama con el candado puesto y el hint de identidad) y `warmSession_`, cuyo propio
 *     comentario decía «VERBATIM de hydrateSession_»;
 *   · **LA PUERTA y sus tres hermanas** (duodécimo tramo) — `requireResumeToken_`,
 *     `abandonSession_` y `reportUnsolicited_`, que repetían la MISMA lectura directa de
 *     `enrEnrollmentGroups` por `resume_token` desde este proceso público y anónimo.
 *
 * PROHIBIDO escribir un segundo lector de esto: dos lectores del mismo dato divergen, y esa
 * es la regresión que documenta §"Regla — refactors preservan el código probado".
 *
 * KAL-4: aquí NO se manda ningún identificador de grupo — el KMS lo deriva del token con su
 * puerta. El nombre de la tabla tampoco viaja. KAL-11: log redactado.
 *
 * ── `opciones.tolerarSesionCerrada` (duodécimo tramo) ──────────────────────────────────
 * Sin ella, la puerta del KMS aplica su TTL de 7 días y su rechazo de sesión abandonada —el
 * comportamiento de siempre, y el de los TRES llamantes del sexto tramo, que **quedan
 * byte-idénticos**—. Con ella, el KMS **acepta el token caducado o abandonado y devuelve la
 * fila**, para que el asistente aplique SUS PROPIOS rechazos con sus MENSAJES EXACTOS
 * (`resume_token abandoned` · `resume_token expired (7 days); …`). Ensancha **qué token se
 * acepta**, JAMÁS qué expediente: sigue saliendo del token y solo del token. Un token
 * INEXISTENTE se rechaza siempre.
 *
 * ⚠️ **Devuelve TRES cosas, y hay que respetarlo** (mismo motivo que `_ficheroDelExpediente_`,
 * que distingue sus dos fallos):
 *   · `{ok:true,  fila:<obj>}`                → la cabecera.
 *   · `{ok:true,  fila:null}`                 → no había token que preguntar (vacío o mal
 *     formado). No es un fallo: es que no hay nada que resolver.
 *   · `{ok:false, rechazo:<msg>}`             → **el KMS CONTESTÓ que ese token no vale**
 *     (`UNAUTHORIZED`/`BAD_REQUEST`). Es una RESPUESTA, no una avería.
 *   · `{ok:false, rechazo:null, motivo:<msg>}` → **no se pudo preguntar** (transporte: el KMS
 *     no responde, no está configurado, o devuelve algo ilegible). NO es «no hay expediente»,
 *     y decírselo así a una familia legítima sería peor que el fallo.
 *
 * ⛔ **`ok` NO cambió de valor al añadirse `rechazo`**: un rechazo del KMS ya caía en este
 * `catch` y salía como `ok:false`, y sigue saliendo así. Los tres llamantes del sexto tramo
 * leen `.fila` (y uno, `.ok`) y no ven diferencia alguna. `rechazo` es información NUEVA para
 * quien la quiera, no un cambio de contrato.
 *
 * Quién hace qué con cada caso, hoy:
 *   · la rama del candado de `hydrateSession_` LANZA si `!ok` (la lectura de AppSheet que
 *     vivía ahí no estaba envuelta en `try`, y `appsheetRequest_` lanza siempre);
 *   · el hint de identidad y el precalentado DEGRADAN a `null` (su `try/catch` de siempre)
 *     ⇒ identidad group-scoped, que es el comportamiento previo exacto;
 *   · `requireResumeToken_` / `abandonSession_` distinguen: `rechazo` ⇒ su propio
 *     `Unauthorized`/`not found`; transporte caído ⇒ LANZAN `KMS_UNREACHABLE`, nunca
 *     «tu enlace no vale»;
 *   · `reportUnsolicited_` da su acuse silencioso en los dos casos (anti-enumeración).
 *
 * ── ★ 0º.bis (2026-08-20) — `opciones.n` / `opciones.correo`: la IDENTIDAD en la MISMA
 * pregunta ──────────────────────────────────────────────────────────────────────────────
 * Medido en un registro real del asistente (2026-08-19): pedir la cabecera y, después,
 * de quién es el enlace (`_tutorQueRecupera_` → `enr.wizardTutorQueRecupera`) son DOS viajes
 * de 13-31 s cada uno — y el segundo resuelve la MISMA sesión con el MISMO enlace que el
 * primero ya tenía en la mano. Si el llamante trae UNO de los dos discriminadores (nunca los
 * dos — precedencia `n` > `correo`, la de `effectiveRecoveredEmail_`, forzada aquí para que
 * jamás viajen juntos), el cuerpo se lo lleva a la MISMA pregunta, y **el resultado se archiva
 * donde `_tutorQueRecupera_` lo busca** (`_TUTOR_MEMO_`, misma clave, mismas dos entradas que
 * archiva su propia respuesta) — para que la primera llamada de `_tutorQueRecupera_` que venga
 * después en esta ejecución sea un acierto de memoria, no un segundo viaje.
 *
 * Solo se archiva el ACIERTO (`identidad.ok`) — un fallo de identidad NO se memoriza, por el
 * mismo motivo que la cabecera: es barato de repetir y memorizarlo convertiría un tropiezo
 * puntual en el veredicto de una llamada futura que ni siquiera lo pidió.
 *
 * @param {string} resumeToken
 * @param {{tolerarSesionCerrada?:boolean, n?:string, correo?:string}} [opciones]
 * @returns {{ok:boolean, fila:Object|null, rechazo:(string|null), motivo:(string|null)}}
 * @private
 */
function _expedienteDelToken_(resumeToken, opciones) {
  var token = resumeToken ? String(resumeToken).trim() : '';
  if (!token) return { ok: true, fila: null, rechazo: null, motivo: null };
  try { assertValidUuid_(token, 'resume_token'); }
  catch (e) { return { ok: true, fila: null, rechazo: null, motivo: null }; }

  var tolerante = !!(opciones && opciones.tolerarSesionCerrada);
  // ★ 0º.bis — precedencia n > correo, FORZADA aquí: nunca se mandan los dos juntos al KMS
  // (que los rechazaría enteros, cabecera incluida — el KMS no elige por el llamante).
  var nDisc      = (opciones && opciones.n)      ? String(opciones.n).trim() : '';
  var correoDisc = (opciones && opciones.correo && !nDisc)
    ? String(opciones.correo).toLowerCase().trim() : '';
  // ★ `0º.quindecies` hallazgo (2) — las DOS comprobaciones previas a subir un documento,
  // en la MISMA pregunta que la cabecera. Se pide POR SU NOMBRE (el llamante lo declara);
  // no se adivina de que el cuerpo traiga una marca suelta.
  var subida = (opciones && opciones.comprobarSubida && typeof opciones.comprobarSubida === 'object')
    ? opciones.comprobarSubida : null;

  // ②17 (2026-08-19) — LA MISMA FICHA SE PEDÍA DOS VECES POR PETICIÓN. Medido en el log
  // real del asistente desplegado: `hydrateSession` emitía `enr.wizardExpedienteDelToken`
  // en t+410 ms (16 s) y otra vez en t+43 s (18 s); ídem `warmBundle` y `warmSession`. La
  // primera es la PUERTA (`requireResumeToken_`), la segunda el punto que necesita la
  // cabecera. Es la MISMA fila, del MISMO token, en la MISMA ejecución.
  //
  // La memoria de EJECUCIÓN ya existía (duodécimo tramo) pero SOLO se indexaba por
  // identificador de expediente, y aquí lo que hay es un TOKEN ⇒ nadie la encontraba.
  // Ahora se consulta por token. Sigue siendo memoria de EJECUCIÓN —muere con la
  // petición—: NO es caché, no tiene plazo, y no puede servir una fila de otra petición.
  //
  // El acierto de la cabecera SOLO sirve de atajo cuando NO se pide identidad: si se pide,
  // hace falta ir al KMS igual (la cabecera ya la tenemos, pero la identidad no).
  var clave = _memoCabeceraClave_(token, tolerante);
  var yaResuelta = _memoCabeceraEjecucion_[clave];
  if (yaResuelta && !nDisc && !correoDisc && !subida) {
    return { ok: true, fila: yaResuelta, rechazo: null, motivo: null };
  }

  var cuerpo = { resume_token: token };
  if (tolerante) cuerpo.tolerar_sesion_cerrada = true;
  if (nDisc) cuerpo.n = nDisc; else if (correoDisc) cuerpo.correo = correoDisc;
  if (subida) cuerpo.comprobar_subida = subida;

  try {
    var r = kmsProxy_('enr.wizardExpedienteDelToken', cuerpo) || {};
    var fila = r.expediente || null;
    // Solo se guarda el ACIERTO. Un rechazo o una avería NO se memorizan: son baratos de
    // repetir y memorizarlos convertiría un tropiezo puntual en el veredicto de toda la
    // petición.
    if (fila) _memoCabeceraEjecucion_[clave] = fila;
    // ★ 0º.bis — la identidad viajó en la MISMA respuesta: se archiva donde
    // `_tutorQueRecupera_` la busca (mismo formato `{correo,tutor,email_id}`, misma
    // convención de clave — la pedida, y si resolvió por `n`, también la de su correo).
    if ((nDisc || correoDisc) && r.identidad && r.identidad.ok) {
      var outIdent = {
        correo: r.identidad.correo || null,
        tutor: r.identidad.tutor || null,
        email_id: r.identidad.email_id || null,
      };
      _TUTOR_MEMO_[token + '|' + (nDisc ? 'n:' + nDisc : 'c:' + correoDisc)] = outIdent;
      if (nDisc && outIdent.correo) _TUTOR_MEMO_[token + '|c:' + outIdent.correo] = outIdent;
    }
    // ★ `0º.quindecies` hallazgo (2) — la comprobación de la subida viajó en la MISMA
    // respuesta: se archiva donde `uploadDocument_` la busca. Se guarda TAMBIÉN el rechazo
    // (`ok:false`), a diferencia de la cabecera: aquí el «no» ES la respuesta —el expediente
    // no es de esta familia— y quien la lee tiene que poder distinguirlo de «no pregunté».
    if (subida && r.comprobacion_subida) {
      _SUBIDA_MEMO_[_memoSubidaClave_(token, subida)] = r.comprobacion_subida;
    }
    return { ok: true, fila: fila, rechazo: null, motivo: null };
  } catch (e2) {
    var msg = (e2 && e2.message) || String(e2);
    // El KMS CONTESTÓ (error de negocio, llega en JSON con su código) vs. NO se pudo
    // preguntar (`kmsProxy_` marca el transporte ilegible con sus propios códigos
    // `KMS_HTTP_ERROR` / `KMS_BAD_RESPONSE` / `KMS_NOT_CONFIGURED`). Confundirlos es lo que
    // convertiría un KMS caído en «tu enlace no vale».
    var codigo = (e2 && e2.code) || '';
    var contestado = codigo === 'UNAUTHORIZED' || codigo === 'BAD_REQUEST';
    Logger.log(redact_('[_expedienteDelToken_] ' + (contestado ? 'token rechazado por el KMS' :
      'lectura KMS fallida') + ' — ' + msg));
    return { ok: false, fila: null, rechazo: contestado ? msg : null, motivo: msg };
  }
}

/**
 * ②17 (duodécimo tramo) — memoria de EJECUCIÓN de la cabecera que ya validó la puerta.
 *
 * NO es un segundo resolvedor y NO es una memoria de 300 s: vive solo mientras dura ESTA
 * ejecución de Apps Script (el ámbito global se recrea en cada petición) ⇒ cero riesgo de
 * servir una fila vieja, que es lo que descarta el reparo obvio a cachear una cabecera.
 *
 * Existe porque `assertGroupEditable_` era la SEGUNDA lectura de la MISMA fila en la MISMA
 * petición: sus CINCO llamantes van inmediatamente precedidos de `requireResumeToken_`
 * (medido contra `origin/main`: `saveStep_` `:4093/:4103`, `submitEnrollmentSession_`
 * `:4216/:4226`, `saveResponses_` `:5389/:5391`, `uploadDocument_` `:5710/:5716`,
 * `saveNeae_` `:6336/:6341`). La puerta ya trae la fila; guardarla aquí la ahorra entera.
 *
 * ⛔ Quien la lea y NO la encuentre **falla cerrado con el error de siempre** — JAMÁS vuelve
 * a leer por un identificador: derivar el expediente de un id es exactamente lo que KAL-4
 * prohíbe.
 * @private
 */
var _memoCabeceraEjecucion_ = {};

/**
 * ②17 (2026-08-19) — la CLAVE de esa memoria cuando lo que hay es un TOKEN.
 *
 * ⛔ **LLEVA LA MODALIDAD DENTRO, y no es decoración.** `_expedienteDelToken_` pregunta de
 * DOS maneras: la ESTRICTA (la puerta del KMS aplica su TTL de 7 días y su rechazo de
 * sesión abandonada) y la TOLERANTE (`tolerarSesionCerrada`, que acepta el token caducado o
 * abandonado y devuelve la fila igual). La FILA que vuelve es idéntica en ambas — lo que
 * cambia es QUÉ TOKEN se acepta. Si la clave no llevara la modalidad, una cabecera obtenida
 * CON tolerancia se le serviría a un llamante que NO la pidió, y ese llamante dejaría de
 * rechazar un enlace caducado o abandonado. Eso cambia comportamiento: prohibido.
 *
 * El prefijo evita chocar con el índice por identificador de expediente que
 * `assertGroupEditable_` lee (misma memoria, misma escritura, dos índices).
 * @private
 */
function _memoCabeceraClave_(token, tolerante) {
  return 'tok:' + String(token || '').trim() + '|' + (tolerante ? 'tolerarSesionCerrada' : 'estricto');
}

/**
 * ★ `0º.quindecies` hallazgo (2) (2026-08-23) — memoria de EJECUCIÓN de la comprobación
 * previa a subir un documento, cuando viajó pegada a la cabecera.
 *
 * Igual que su hermana de la cabecera: vive lo que dura ESTA ejecución de Apps Script y ni
 * un ms más ⇒ NO es caché, no tiene plazo y no puede servir la respuesta de otra petición.
 *
 * ⛔ **LA CLAVE LLEVA DENTRO LOS DOS DISCRIMINADORES**, y no es decoración: la respuesta
 * depende del `enrollment_id` (¿es de esta familia?) Y de la marca del envío (¿ya se
 * guardó?). Una clave que solo mirara el token le serviría a una subida la respuesta de
 * otra — que es exactamente el defecto que la idempotencia existe para evitar.
 * @private
 */
var _SUBIDA_MEMO_ = {};

/** @private — la clave de `_SUBIDA_MEMO_`; ver por qué lleva los dos discriminadores. */
function _memoSubidaClave_(token, subida) {
  var s = subida || {};
  return 'sub:' + String(token || '').trim() +
    '|e:' + String(s.enrollment_id || '') +
    '|m:' + String(s.upload_idempotency_token || '');
}

/**
 * ②17 (2026-08-19) — OLVIDA la cabecera guardada para un token (las DOS modalidades) y su
 * índice por expediente.
 *
 * ⛔ Existe por la ROTACIÓN del enlace: `sendMagicLink_` llama a `enr.wizardTouchSession`,
 * que minta un `resume_token` NUEVO y deja el viejo sin resolver. La ficha que la puerta
 * dejó en la memoria lleva DENTRO el token VIEJO ⇒ servirla después de rotar sería devolver
 * un enlace muerto. Se olvida en el acto: la memoria nunca es la autoridad, solo un ahorro.
 * @private
 */
function _olvidarCabeceraMemo_(token, groupId) {
  try {
    delete _memoCabeceraEjecucion_[_memoCabeceraClave_(token, true)];
    delete _memoCabeceraEjecucion_[_memoCabeceraClave_(token, false)];
    if (groupId) delete _memoCabeceraEjecucion_[groupId];
  } catch (e) { /* best-effort: olvidar no puede tumbar el envío del enlace */ }
}

/**
 * ②17 (séptimo tramo) — los expedientes de UN correo, servidos por el KMS.
 *
 * ÚNICO lector de lo que `initEnrollmentSession_` hacía con TRES lecturas directas a
 * AppSheet desde este proceso, que es **público y anónimo**: los expedientes ya enviados
 * de ese correo, los abiertos, y las personas de los candidatos —que solo se CUENTAN—.
 * Las sirve `enr.wizardExpedientesDelCorreo` con los MISMOS filtros y proyectadas a los
 * campos que este fichero demuestra usar.
 *
 * ⛔ **FALLA CERRADO — LANZA, no degrada, y es deliberado.** Las dos lecturas de
 * expedientes que sustituye lanzaban (`appsheetRequest_` lanza siempre y aquí no había
 * `try`). Devolver «no hay ninguno» cuando en realidad no se pudo preguntar le abriría un
 * expediente NUEVO a una familia que ya tiene el suyo, y le mandaría un enlace a un
 * borrador vacío. El único fallo que SÍ degrada es el recuento de personas, que viaja en
 * `recuentoFallido` para que el llamante conserve su respaldo (ordenar solo por fecha).
 *
 * @param {string} email correo ya normalizado y validado por el llamante (KAL-5 capa 1).
 * @returns {{enviados:Array, abiertos:Array, personasPorExpediente:Object, recuentoFallido:boolean}}
 */
function _expedientesDelCorreo_(email) {
  var r = kmsProxy_('enr.wizardExpedientesDelCorreo', { email: email }) || {};
  return {
    enviados:              Array.isArray(r.enviados) ? r.enviados : [],
    abiertos:              Array.isArray(r.abiertos) ? r.abiertos : [],
    personasPorExpediente: r.personas_por_expediente || {},
    recuentoFallido:       !!r.recuento_fallido,
  };
}

/**
 * ②17 (octavo tramo) — los expedientes RECUPERABLES de un correo tecleado, servidos por
 * el KMS. **Lector ÚNICO** de lo que la rama pública de `sendMagicLink_` hacía con lecturas
 * directas a AppSheet desde este proceso, que es **público y anónimo**:
 *
 *   · los expedientes cuyo **correo principal** casa con el tecleado,
 *   · los que le tocan **como tutor** (vía `enrEmails` → `enrPersons`, la comprobación que
 *     evita mandarle la recuperación al buzón de un menor),
 *   · y el `email_id` de ese buzón en cada uno — el `n` del enlace.
 *
 * Los sirve `enr.wizardRecuperacionDelCorreo` con los MISMOS filtros y proyectados a los
 * cinco campos que este fichero demuestra usar. **Deja de cruzar**: las filas enteras de
 * `enrEmails` de ese buzón, la **ficha COMPLETA de cada persona —MENORES INCLUIDOS— de los
 * expedientes que casen** (que solo servía para comprobar el papel de tutor), y la fila
 * entera del expediente con `magic_link_token` dentro.
 *
 * ⛔ **LO QUE SE DECIDE NO SE MUEVE:** preferir la lista del correo principal y caer a la
 * del tutor solo si aquélla está vacía, ordenar por antigüedad, renovar o no el enlace,
 * mandar uno o la lista de varios — todo eso se queda AQUÍ, verbatim. Por eso este ayudante
 * devuelve **las dos listas por separado**, nunca una ya elegida.
 *
 * ⛔ **FALLA CERRADO — LANZA, no degrada, y es deliberado.** El llamante envuelve todo su
 * camino en un `try` que devuelve el acuse constante, así que una lectura caída acaba en el
 * MISMO acuse **y sin crear nada**. Devolver «no hay ninguno» en su lugar haría que
 * `initEnrollmentSession_` le abriera un expediente NUEVO a una familia que ya tiene el
 * suyo, y le mandara el enlace a un borrador vacío. *(Eso era un agujero REAL del código
 * anterior: su lectura de expedientes degradaba a `null` y no se distinguía de «ninguno».)*
 *
 * @param {string} email correo ya normalizado y validado por el llamante (KAL-5 capa 1).
 * @returns {{porCorreoPrincipal:Array, porTutor:Array, identificadorDeCorreo:Object,
 *            identificadorFallido:boolean}}
 */
function _recuperacionDelCorreo_(email) {
  var r = kmsProxy_('enr.wizardRecuperacionDelCorreo', { email: email }) || {};
  return {
    porCorreoPrincipal:    Array.isArray(r.por_correo_principal) ? r.por_correo_principal : [],
    porTutor:              Array.isArray(r.por_tutor) ? r.por_tutor : [],
    identificadorDeCorreo: r.identificador_de_correo || {},
    identificadorFallido:  !!r.identificador_fallido,
  };
}

/**
 * ②17 (décimo tramo) — QUIÉNES pueden ser sujeto de una respuesta en el expediente del
 * `resume_token`, servido por el KMS. **Lector ÚNICO** de lo que `saveResponses_` armaba
 * bajando la ficha COMPLETA de cada persona del expediente —MENORES INCLUIDOS: nombre,
 * fecha de nacimiento, documento— a este proceso, que es **público y anónimo**, solo para
 * quedarse con sus identificadores. De la entrada del KMS salen ids y nada más.
 *
 * ⛔ **Y CIERRA UNA DIVERGENCIA MEDIDA.** Este conjunto se armaba aquí con OTRO criterio que
 * el del escritor: aquí solo contaban las personas (`enrPersons`) y se descartaba además a
 * quien la familia hubiera quitado con la bandera `is_active`; el escritor
 * (`enr_persistResponses_`) cuenta además el propio expediente y sus expedientes de alumno, y
 * filtra solo por `deleted_at`. Resultado: el asistente rechazaba con `UNAUTHORIZED`
 * respuestas que el KMS sí habría guardado — y `UNAUTHORIZED` **no está declarado como
 * rechazo definitivo** (`frontend/src/lib/rechazos.js`), así que la cola del asistente lo
 * reintentaba **para siempre**. Ahora hay UN solo recorrido, y es el del escritor.
 *
 * KAL-4: aquí NO se manda ningún identificador de grupo — el KMS lo deriva del token con su
 * puerta (mismo plazo de 7 días y mismo rechazo de sesión abandonada que
 * `requireResumeToken_`, que además ya corrió antes). El nombre de la tabla tampoco viaja.
 *
 * ⛔ **FALLA CERRADO — LANZA, no degrada.** La lectura que sustituye lanzaba
 * (`appsheetRequest_` lanza siempre y ahí no había `try`). Devolver un conjunto vacío
 * rechazaría a TODA familia con un `UNAUTHORIZED` falso; devolver «todo vale» abriría la
 * comprobación de acceso.
 *
 * @param {string} resumeToken el token del que el KMS deriva el expediente (KAL-4)
 * @returns {Object} conjunto `{ id: true }` de sujetos autorizados
 * @private
 */
function _respondentesAutorizados_(resumeToken) {
  var r = kmsProxy_('enr.wizardRespondentesAutorizados', { resume_token: resumeToken }) || {};
  var conjunto = {};
  (Array.isArray(r.ids) ? r.ids : []).forEach(function(id) { if (id) conjunto[String(id)] = true; });
  return conjunto;
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

  // ②17: `sessionsHint` = filas de `sysSigningSessions` del expediente, servidas por el
  // KMS (`enr.wizardDatosDeFirma`, mismo filtro `entity_id` de siempre);
  // `signersBySessionHint[session_id]` = sus firmantes (mismo filtro `session_id`).
  // SIN filas se degrada EXACTAMENTE como la rama `catch` de antes: 'NOT_INITIATED'.
  if (!Array.isArray(sessionsHint)) {
    Logger.log('[resolveSigningStatus_] sin filas de firma (②17) → NOT_INITIATED');
    return 'NOT_INITIATED';
  }
  var sessions = sessionsHint;
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

  var signers = (signersBySessionHint && Array.isArray(signersBySessionHint[session.session_id]))
    ? signersBySessionHint[session.session_id]
    : null;
  if (!signers) {
    // ②17: sin firmantes legibles — MISMA salida que la rama `catch` de antes. Hay sesión
    // anclada: si el estado dice COMPLETED se le cree, si no, en curso.
    Logger.log('[resolveSigningStatus_] sin firmantes de la sesión (②17)');
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

  // ②17: las filas las sirve el KMS y llegan como hints (mismos filtros de siempre).
  // Sin ellas se degrada EXACTAMENTE como la rama `catch` de antes: null.
  if (!Array.isArray(sessionsHint)) {
    Logger.log('[resolveSigningContextFromSession_] sin filas de firma (②17) → null');
    return null;
  }
  var sessions = sessionsHint;
  var TERMINAL = { COMPLETED: 1, CANCELLED: 1, EXPIRED: 1 };
  var session = sessions.find(function(s) {
    return s && !s.deleted_at && !TERMINAL[s.current_state_code || ''];
  });
  if (!session) return null;
  try {
    assertValidUuid_(session.session_id, 'session_id');
  } catch (e) { return null; }

  var signers = (signersBySessionHint && Array.isArray(signersBySessionHint[session.session_id]))
    ? signersBySessionHint[session.session_id]
    : null;
  if (!signers) {
    Logger.log('[resolveSigningContextFromSession_] sin firmantes de la sesión (②17) → null');
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

  // ②17: las filas las sirve el KMS y llegan como hints (mismos filtros de siempre).
  // Sin ellas se degrada EXACTAMENTE como la rama `catch` de antes: null.
  if (!Array.isArray(sessionsHint)) {
    Logger.log('[resolveGuardianSigningContext_] sin filas de firma (②17) → null');
    return null;
  }
  var sessions = sessionsHint;
  var TERMINAL = { COMPLETED: 1, CANCELLED: 1, EXPIRED: 1 };
  var session = sessions.find(function(s) {
    return s && !s.deleted_at && !TERMINAL[s.current_state_code || ''];
  });
  if (!session) return null;
  try {
    assertValidUuid_(session.session_id, 'session_id');
  } catch (e) { return null; }

  var signers = (signersBySessionHint && Array.isArray(signersBySessionHint[session.session_id]))
    ? signersBySessionHint[session.session_id]
    : null;
  if (!signers) {
    Logger.log('[resolveGuardianSigningContext_] sin firmantes de la sesión (②17) → null');
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
 * PERF (2026-06-08): endpoint LIGERO de estado de admisión para el pulse de la
 * página de firma. `resumeSession_` relee TODO el expediente (persons + sub-reads
 * por persona + relations + documents + responses + interviews → ~20+ reads, 30-40s)
 * y el pulse lo disparaba repetidamente solapado → saturación. El pulse SOLO necesita
 * el estado de admisión + el contexto de firma, NO el expediente completo.
 *
 * ②17 (decimotercer tramo): **este manejador YA NO lee AppSheet.** Los expedientes de alumno,
 * las personas (proyectadas a papel + identificador, para la Vía 2 de
 * `buildAdmissionContext_`) y el catálogo de situaciones —ya acotado al colegio y a la máquina
 * DECLARADA— los sirve el KMS en UNA pregunta (`_pulsoDeLaAdmision_`). Las filas de firma, la
 * cabecera y la identidad del tutor ya venían del KMS de tramos anteriores. NO lee
 * relations/documents/responses/interviews ni los sub-reads por persona.
 *
 * ⛔ **FALLA CERRADO**: si el KMS no contesta, LANZA. Antes el lote de AppSheet degradaba en
 * silencio (`appsheetRequestBatch_` nunca lanza) y devolvía `editable:true` con `state_code`
 * vacío — el servidor afirmando que la solicitud de una familia que ya envió se puede editar,
 * y su situación real y el puente a la firma borrados de la pantalla. El cliente ya sabe tratar
 * un fallo del pulso (`WizardPage.jsx`: `.catch` + no avanza la versión ⇒ reintenta al tick
 * siguiente conservando lo que ya tenía).
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
  // ②24 — de qué buzón es la marca (UN SOLO resolvedor, con memoria).
  //
  // ★ 0º.octies (2026-08-21) — se resuelve PEREZOSAMENTE, y esto es lo único que cambió aquí.
  // Resolverlo cuesta un viaje al KMS de 20-30 s cuando su memoria de 300 s (`idlinkd_`) no
  // acierta, y el pulso late una y otra vez mientras la familia mira la pantalla. Medido en el
  // registro real del 2026-08-20: `getAdmissionState` tardó 31.467 ms diciendo «HIT adm» —el dato
  // ESTABA guardado— porque antes se habían pagado 29.086 ms en `enr.wizardTutorQueRecupera`.
  // ⛔ NO es un segundo resolvedor ni una identidad de repuesto: es EL MISMO, llamado solo cuando
  // su valor puede cambiar el resultado (ver `_leerMarcaStepUp_`). Se memoiza en la ejecución para
  // que dos usos dentro de esta misma petición no paguen dos veces.
  let _identidadHecha = false;
  let _identidadValor = null;
  const identidadDelBuzon = function () {
    if (!_identidadHecha) { _identidadValor = _identidadDelEnlace_(p, id); _identidadHecha = true; }
    return _identidadValor;
  };
  const paginaViva = _huellaDePagina_(p);
  let stepUpRestanteS = 0;
  let stepUpCierre = 'INACTIVIDAD';
  if (stepUpFresh) {
    // La gracia CREA la marca ⇒ aquí el buzón hace falta SIEMPRE (es a quien queda atada).
    _markStepUpFresh_(id, 'GRACE', identidadDelBuzon(), paginaViva);
    stepUpRestanteS = Math.ceil(STEPUP_INACTIVITY_MS / 1000);
  } else {
    // ⛔ EL PULSO ES UNA LECTURA — REPORTA la frescura vigente y lo que le queda, y NUNCA
    // la re-extiende. Esto es SEC-STEPUP (#55) y sigue exactamente igual de cerrado tras
    // el cambio del 2026-08-20: el pulso late SOLO cada pocos segundos, así que dejarle
    // tocar la marca mantendría viva una pestaña abandonada sin nadie delante. Quien
    // estira la ventana es `refrescarVentanaDeInactividad_`, y lo dispara la ACTIVIDAD
    // REAL de una persona, no un temporizador. NO llamar aquí a `_markStepUpFresh_` ni a
    // `_extenderVentanaStepUp_`.
    const marca = _leerMarcaStepUp_(id, identidadDelBuzon, paginaViva);
    stepUpFresh = marca.fresh;
    stepUpRestanteS = marca.restante_s;
    stepUpCierre = marca.cierre;
  }

  // WIZARD-CACHE (2026-06-12) — cache-first: si el warm dejó wz_adm_<token> y la
  // versión liveState wizard-side NO subió desde que se cocinó, servimos de cache.
  // El pulse de live_version existente sigue gobernando el refresh: si la versión
  // subió respecto al cacheado → invalida y ve al vivo. Gates intactos:
  // requireResumeToken_ (KAL-4) + gracia/step-up ya corrieron arriba; step_up_fresh
  // SIEMPRE se computa en vivo (estado per-llamada, nunca del cache).
  //
  // ⛔ LA CLAVE LLEVA EL BUZÓN DENTRO A PROPÓSITO, Y NO SE AFLOJA PARA GANAR VELOCIDAD (②24).
  // Es una frontera de PRIVACIDAD ENTRE TUTORES: en un expediente ya enviado el `resume_token` NO
  // rota, así que dos tutores de la misma familia comparten token. Sin el buzón en la clave, a uno
  // se le serviría la foto guardada del OTRO — muchísimo peor que cualquier espera. Quien venga a
  // «simplificar» esta clave, que lea antes ②24 y el §"Un COMENTARIO del código no es criterio
  // normativo" de `kis-app/CLAUDE.md`.
  //
  // ★ 0º.octies — el discriminador sale de `_wzN_` con el `n`/`recovered_email` CRUDOS del payload,
  // NO de la identidad resuelta ⇒ construir esta clave no cuesta ni un viaje al KMS. Por eso el
  // reorden perezoso de arriba es posible sin tocar el alcance de la clave.
  try {
    const wzAdmKey = _wzCacheKey_('adm', id + '_' + _wzN_(p && p.n, p && p.recovered_email));
    const wzAdmRaw = _wzCacheGetChunked_(CacheService.getScriptCache(), wzAdmKey);
    if (wzAdmRaw) {
      const wzEntry = JSON.parse(wzAdmRaw);
      // IDENTIDAD (multi-tutor, 2026-06-12): en grupos submitted el token NO rota ->
      // dos tutores comparten clave. La entrada guarda el `n` con el que se cocino;
      // si el caller trae otro `n` (otro guardian) -> MISS al camino vivo (que
      // re-resuelve la identidad real). Mismo patron en wz_mem.
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
          // ★ SEC WIZ-SIGNTOKEN: no servir el signing_token pre-step-up.
          signing_context:   _redactSigningTokenIfNotFresh_(admC.signing_context, stepUpFresh),
          editable:          admC.editable,
          guardados_sin_aterrizar:   Array.isArray(admC.guardados_sin_aterrizar) ? admC.guardados_sin_aterrizar : [],
          guardados_no_consultables: (admC.guardados_sin_aterrizar === undefined) || !!admC.guardados_no_consultables,
          step_up_fresh:     stepUpFresh,
          step_up_restante_s: stepUpRestanteS,
          step_up_cierre:     stepUpCierre,
        };
      }
      if (wzEntry && wzEntry.admission) {
        // live_version subió respecto al cacheado → NUNCA servir stale: invalida y ve al vivo.
        CacheService.getScriptCache().remove(wzAdmKey + '_meta');
        Logger.log('[WZCACHE] STALE adm (live_version) token=' + String(p.resume_token).slice(0, 8) + '… — invalidado');
      }
    }
  } catch (eWzAdm) { /* best-effort → camino vivo */ }

  // ②17 (decimotercer tramo) — las TRES lecturas de AppSheet que vivían aquí (los expedientes
  // de alumno, las personas y el catálogo de situaciones SIN FILTRO) las sirve el KMS en UNA
  // pregunta, por el lector ÚNICO `_pulsoDeLaAdmision_`. El expediente lo deriva el KMS del
  // `resume_token` (KAL-4): aquí no viaja ningún id ni ningún nombre de tabla.
  //
  // Lo que ya venía del KMS de tramos anteriores y NO se toca: la CABECERA (sexto tramo,
  // `_expedienteDelToken_`), la IDENTIDAD del tutor (noveno, `enr.wizardTutorQueRecupera`) y
  // las FILAS DE FIRMA (`enr.wizardDatosDeFirma`, pedidas dentro de `buildAdmissionContext_`
  // y solo si el expediente está admitido).
  //
  // ⛔ FALLA CERRADO, y esto CORRIGE el oro: el lote `appsheetRequestBatch_` NUNCA lanzaba,
  // así que un fallo de AppSheet dejaba `enrollments = []` ⇒ `editable:true` para una familia
  // que ya envió, con su situación real y el puente a la firma borrados de la pantalla.
  const perfB0 = Date.now(); // PERF-KMS2
  const pulso = _pulsoDeLaAdmision_(p && p.resume_token);
  const perfBatchMs = Date.now() - perfB0;
  if (!pulso.ok) {
    const ePulso = new Error('No se pudo leer el estado de la solicitud.');
    ePulso.code = 'KMS_UNREACHABLE';
    throw ePulso;
  }
  // Las personas llegan YA filtradas a quien sigue en la solicitud (el KMS aplica
  // `sys_rowIsActiveLiveOptionalFlag_`, gemelo declarado de `wizardSoloVivas_`) y proyectadas
  // a `{person_id, person_type_id}` — los DOS únicos campos que la Vía 2 toca.
  const enrollments = pulso.expedientes;
  const persons     = pulso.personas;
  const statesHint  = pulso.situaciones;

  // IDENTITY-FROM-LINK (2026-06-11): la identidad viaja en el ENLACE — `p.n` (email_id) →
  // email del guardian, resuelto contra el expediente del token (KAL-4). Prioridad `n` >
  // recovered_email (compat).
  // ②17 (noveno tramo): la resolución la hace el KMS; la cabecera va como hint del respaldo
  // «tutor 1» para no volver a pedirla (lector ÚNICO del sexto tramo). Degrada a null igual.
  const perfG0 = Date.now(); // PERF-KMS2
  const groupRow = _expedienteDelToken_(p && p.resume_token).fila;
  const effRecoveredEmail = effectiveRecoveredEmail_(p && p.resume_token, p && p.recovered_email, p && p.n, groupRow);
  const guardianId = resolveGuardianForRecovery_(p && p.resume_token, effRecoveredEmail);
  const perfGuardianMs = Date.now() - perfG0;

  const perfA0 = Date.now();
  PERF2_.adm = {}; // recoge segmentos internos de buildAdmissionContext_
  // ②17: las filas de firma ya no viajan desde el batch de AppSheet — se piden al KMS
  // con este token, y solo si el expediente está admitido.
  const admission = buildAdmissionContext_(id, enrollments, guardianId, persons,
    { situaciones: statesHint, resumeToken: (p && p.resume_token) || null });
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
      _wzCacheKey_('adm', id + '_' + _wzN_(p && p.n, p && p.recovered_email)),
      JSON.stringify({ v: _getLiveStateVersion_(id), admission: {
        state_code:        admission.state_code,
        state_label:       admission.state_label,
        signing_ready:     admission.signing_ready,
        signing_status:    admission.signing_status || null,
        signing_available: admission.signing_available,
        signing_context:   admission.signing_context,
        editable:          admission.editable,
        // Viaja en la cache porque el KMS BUMPA la versión del grupo al morir un guardado
        // (`sys_jobQueue_markFailed_`) ⇒ una entrada con un aviso caducado ya no se sirve.
        guardados_sin_aterrizar:   pulso.guardados_sin_aterrizar,
        guardados_no_consultables: pulso.guardados_no_consultables,
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
    // ★ SEC WIZ-SIGNTOKEN: no servir el signing_token pre-step-up.
    signing_context:   _redactSigningTokenIfNotFresh_(admission.signing_context, stepUpFresh),
    editable:          admission.editable,   // URGENT-PASS3 BUG A: state-driven editabilidad
    guardados_sin_aterrizar:   pulso.guardados_sin_aterrizar,
    guardados_no_consultables: pulso.guardados_no_consultables,
    step_up_fresh:     stepUpFresh,
    step_up_restante_s: stepUpRestanteS,
    step_up_cierre:     stepUpCierre,
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
  // (which clears submitted_at via the reopen branch of hydrateSession_).
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
    // ②24 — la puerta pregunta por el BUZÓN que opera: la marca de otro tutor no vale.
    assertStepUpFresh_(enrollmentGroupId, _identidadDelEnlace_(p, enrollmentGroupId), _huellaDePagina_(p));
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
  // 18.bis.84 — `extra` guarda la respuesta del KMS de ESTE paso, sea cual sea el paso.
  // Antes solo se recogía la de 'persons' (por el `personIdMap`) y las otras tres se
  // tiraban a la basura: con ellas se iba el `job_id` del trabajo que el KMS deja
  // APUNTADO, y sin ese identificador nadie puede preguntar después cómo acabó.
  let extra = null;
  switch (step) {
    case 'application':
      extra = kmsProxy_('enr.wizardSaveStep', {
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
        // DL-E49 §2 — defensa en profundidad: el KMS rechaza tocar la fila YA EXISTENTE
        // de OTRO tutor. Resuelto del enlace (IDENTITY-FROM-LINK), NUNCA del payload.
        writer_person_id: wizardTutorQueOpera_(p, enrollmentGroupId),
      });
      // CLI 8: atestación de tutor único — sigue siendo dato del payload (group-scoped).
      // P1-B: viaja el resume_token (el KMS deriva el grupo, KAL-4), no el group_id.
      persistSoleGuardianAttestation_(p.resume_token, p.sole_guardian_attestation);
      break;
    case 'relations':
      extra = kmsProxy_('enr.wizardSaveRelations', {
        resume_token: p.resume_token,
        relations:    Array.isArray(payload) ? payload : (payload.relations || []),
        writer_person_id: wizardTutorQueOpera_(p, enrollmentGroupId),
      });
      break;
    case 'health':
      extra = kmsProxy_('enr.wizardSaveHealth', {
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
  // 18.bis.84 — el identificador del trabajo APUNTADO viaja de vuelta para que el
  // asistente pueda preguntar después cómo acabó. Es opaco (no lleva ni un dato de la
  // familia) y `null` cuando el paso no encola nada ('questions'/'documents', que guardan
  // por su propio camino). Nadie AUTORIZA nada con él: la puerta sigue siendo el token.
  return { saved: true, step, _debug: safeDebug, job_id: (extra && extra.job_id) || null };
}

/**
 * Submits an enrollment session — DL-E15.
 *
 * Materialises N enrEnrollments rows (one per applicant person captured in the
 * staging tables), stamps submitted_at on the group, writes per-enrollment
 * status_log + consent rows y genera el PDF de consentimiento.
 *
 * NO MANDA NINGUN CORREO (retirados el 2026-08-07, re-verificado el 2026-08-08).
 * Ni la confirmacion a la familia ni el aviso interno a admisiones salen de aqui:
 * los dos los gobierna el motor de avisos del KMS a partir de la entrada en RQ
 * (kis-rule-0014 y kis-rule-0015, ancladas a SUBMITTED_STATE_ENTERED_AT). Ver el
 * comentario largo al final de esta funcion. Este JSDoc afirmo lo contrario hasta
 * el 2026-08-08 y tres agentes distintos lo repitieron a Diego como si fuera cierto.
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
  // abandoned) group. Without this gate a re-POST re-stamps submitted_at y
  // regenera el PDF. (La coletilla "and re-sends the confirmation emails" era
  // cierta en CLI 81 y dejo de serlo el 2026-08-07: este handler ya no manda
  // correo alguno. Corregida el 2026-08-08.) The other three
  // mutation handlers (saveStep_, saveResponses_, uploadDocument_) already call
  // this guard since CLI 26 — submit was the one that slipped through. Throws
  // Error{code:'NOT_EDITABLE'} → doPost maps it to HTTP 200 {ok:false,error}.
  assertGroupEditable_(enrollmentGroupId);

  // ②27 — ENVIAR EXIGE LO MISMO QUE EDITAR. Este manejador llevaba token + expediente
  // editable, pero NO el código de un solo uso, que sí piden los pasos de PII
  // (`saveStep_` persons/relations/health, `saveResponses_`, `uploadDocument_`). Y el
  // envío es el acto MÁS consecuente de todo el asistente: estampa `submitted_at`, cambia
  // la situación del expediente a RQ y escribe N filas del libro de consentimientos
  // ATRIBUIDAS A UN TUTOR REAL (RGPD + declaración de exactitud). El código de un solo uso
  // es exactamente lo que acredita que ese tutor está delante. Puerta copiada literal de
  // `saveStep_`: identidad del enlace (②24) + ventana DURA de 10 min (SEC-STEPUP #55).
  // El cliente comprueba la frescura ANTES de navegar (Step7Review) para que la familia
  // pueda re-verificar donde sí hay pantalla para hacerlo; esto es el suelo del servidor.
  assertStepUpFresh_(enrollmentGroupId, _identidadDelEnlace_(p, enrollmentGroupId), _huellaDePagina_(p));

  _wzCacheInvalidate_(p && p.resume_token); // WIZARD-CACHE: NUNCA servir stale tras un write del grupo

  // ── UN CONSENTIMIENTO QUE NADIE DIO NO SE REGISTRA (2026-08-04) ──────────────────────
  //
  // Aquí vivía esto, con el comentario «Ensure GDPR consent is captured even if frontend
  // forgot to include it»:
  //
  //     if (!consents.some(c => c.type === 'gdpr' || …)) {
  //       consents.push({ type: 'gdpr', accepted: true, consent_text_shown: … });
  //     }
  //
  // Es decir: si el consentimiento RGPD no llegaba, **el servidor lo inventaba y lo marcaba
  // como ACEPTADO**, y lo escribía en `sysConsentsLog` firmado con la identidad del primer
  // tutor. Eso no es un dato por defecto: es **registrar que una familia consintió algo que
  // nunca consintió**, en la tabla que existe precisamente para probar lo contrario. Y el
  // dispatcher de este backend es `ANYONE_ANONYMOUS`: cualquiera en internet podía provocarlo
  // llamando a `submitEnrollmentSession` sin consentimientos.
  //
  // MEDIDO antes de quitarlo, para saber si rompía algo: el cliente **siempre** manda el
  // consentimiento (`Step7Review.jsx:188-189`, incondicional) y **siempre aceptado**, porque
  // el envío está gateado antes (`:145-146`: sin marcar, `return` con error y no se envía).
  // El único otro llamante es `manual_testSubmitReplayRejected`, que espera `NOT_EDITABLE` —
  // lanza mucho antes de llegar aquí. ⇒ Para el camino de la familia esto es **byte-neutro**.
  //
  // Y donde antes había una invención silenciosa ahora hay un **error explícito**: cambiar una
  // mentira callada por una caída callada no habría sido arreglarlo. El servidor exige lo
  // mismo que exige la pantalla — ni más (no inventa) ni menos (no deja pasar un expediente
  // sin la base legal para tratarlo).
  // Se comprueba ANTES de crear nada: si faltara el consentimiento y se lanzara al final,
  // el envío quedaría a medias — expedientes creados y transición hecha, sin base legal.
  var _consentsIn = Array.isArray(p.consents) ? p.consents : [];
  var gdprDado = _consentsIn.filter(function (c) {
    return c && (c.type === 'gdpr' || c.type === 'gdpr_data_processing');
  })[0];
  if (!gdprDado) {
    var eSinGdpr = new Error('La solicitud no incluye el consentimiento de protección de datos. ' +
      'Sin él no se puede tramitar, y el servidor no lo da por dado en tu nombre: márcalo en la ' +
      'pantalla de revisión y vuelve a enviar.');
    eSinGdpr.code = 'GDPR_CONSENT_REQUIRED';
    throw eSinGdpr;
  }
  if (gdprDado.accepted !== true) {
    var eNoAcep = new Error('El consentimiento de protección de datos figura como NO aceptado. ' +
      'La solicitud no se envía: sin esa base legal no se pueden tratar los datos de la familia.');
    eNoAcep.code = 'GDPR_CONSENT_REFUSED';
    throw eNoAcep;
  }

  // ── LA ATESTACIÓN DE EXACTITUD SE EXIGE, PERO NO ES UN CONSENTIMIENTO ────────────────
  // La pantalla de revisión la exige (`Step7Review.jsx:146`) y hasta hoy el servidor NO la
  // comprobaba: solo la ESCRIBÍA, con un código inventado (ver `wizardCodigoDeConsentimiento_`).
  // Ahora el servidor exige lo mismo que la pantalla, y no la registra como consentimiento.
  var _atestacion = _consentsIn.filter(function (c) { return c && c.type === 'legal'; })[0];
  if (!_atestacion || _atestacion.accepted !== true) {
    var eSinAtest = new Error('Falta la declaración de que los datos de la solicitud son exactos. ' +
      'Márcala en la pantalla de revisión y vuelve a enviar.');
    eSinAtest.code = 'ACCURACY_ATTESTATION_REQUIRED';
    throw eSinAtest;
  }
  // Y los tipos se resuelven ANTES de crear nada: si alguno no tuviera correspondencia en el
  // catálogo, el envío no puede quedarse a medias (expedientes creados, transición hecha) por
  // un fallo que se destapa al escribir los consentimientos.
  _consentsIn.forEach(function (c) { wizardCodigoDeConsentimiento_(c && c.type); });

  const now = new Date().toISOString();

  // ── ②17 — lo que el envío necesita para validarse se lo PREGUNTA AL KMS ────────────
  // Aquí había TRES lecturas directas a AppSheet —la cabecera del expediente, las personas
  // y los teléfonos—, hechas desde este proceso, que es público y anónimo, con la
  // credencial de AppSheet de la aplicación entera. Ahora son UNA sola pregunta
  // (`enr.wizardDatosDelEnvio`), con los MISMOS filtros por expediente y el mismo criterio
  // de fila viva, y el nombre de la tabla no viaja en la petición. KAL-4 intacta: el
  // expediente lo re-deriva el KMS del `resume_token`, nunca del cuerpo.
  //
  // Y la ficha de cada persona ya NO cruza entera: el KMS proyecta el papel y el
  // identificador, y de los teléfonos solo el número. Nombres, fechas de nacimiento y
  // documentos se quedan dentro del KMS.
  //
  // FALLA CERRADO, igual que antes: `appsheetRequest_` lanzaba siempre, y `kmsProxy_`
  // propaga. Degradar aquí sería peor que el fallo — «no hay nadie» dejaría pasar un envío
  // sin alumno, y «no hay teléfonos» rechazaría a toda familia con un motivo falso.
  const datosEnvio = kmsProxy_('enr.wizardDatosDelEnvio', { resume_token: p.resume_token });

  const allPersons = (datosEnvio && datosEnvio.personas) || [];
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
  // Step 11) must have ≥1 valid E.164 phone. SOSPECHA-2 fix — la puerta vieja leía una
  // lista de teléfonos que SIEMPRE venía vacía, así que lanzaba INVALID_PHONE pasara lo
  // que pasara, tuviera la familia teléfono o no. Se arregló leyendo los teléfonos reales
  // del expediente y agrupándolos por persona, y desde ②17 (2026-08-15) esos teléfonos
  // los sirve el KMS (`enr.wizardDatosDelEnvio`) con el mismo filtro por expediente.
  //
  // W2 (P259): AppSheet strips the leading '+' from enrPhones.value, so an E.164
  // value '+34609211201' is stored as '34609211201'. Normalise the STORED value
  // (re-prepend '+' when all-digits) before the strict regex; this only restores
  // the '+' AppSheet removed — it still requires a valid E.164 after normalising,
  // NOT "any digits". Fresh input keeps the strict-with-'+' check elsewhere.
  //
  // ②17: los teléfonos vienen de la MISMA pregunta al KMS de más arriba, ya acotados al
  // expediente y ya filtrados de vivos. La normalización P259 y el E.164 estricto se
  // conservan aquí VERBATIM: lo que se movió es de dónde sale el dato, no el criterio.
  const gPersonIdsForGate = guardians.map(g => g.person_id).filter(Boolean);
  if (gPersonIdsForGate.length) {
    const allGuardianPhones = (datosEnvio && datosEnvio.telefonos) || [];
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

  // ── P1-B (WIZARD-DIRECT-WRITE-MIGRATION): materialización enr* del submit → KMS ──
  // requester (primer guardian) + 1 enrEnrollments por aplicante (Add, o Edit→RQ en
  // re-submit de reopen) + dual-write P71 + submitted_at en el grupo — TODO lo persiste
  // el KMS (enr.wizardPersistSubmitEnrollments → writer único enr_persistSubmit_,
  // paridad verbatim con el código histórico de este handler, incluida la resolución
  // del estado RQ fetch-all-then-filter y su fail-fast de configuración). KAL-4: el
  // grupo se re-deriva del resume_token server-side; aplicantes/guardians salen de
  // enrPersons del grupo en el KMS — nada de ids del payload. Síncrono: un fallo
  // propaga (sin éxito falso), coherente con la semántica histórica.
  // Devuelve enrollment_ids con los que este handler construye los consentimientos que
  // persiste enr.wizardPersistSubmitSideEffects (P1-A). El wizard YA NO fija ni registra el
  // estado (D33 / DL-S115): la ficha nace en su estado de partida y la marca
  // APPLICATION_FORM_COMPLETED —completada KMS-side por enr.wizardPersistSubmitEnrollments—
  // dispara la transición por el motor, que deja el rastro en sysStateTransitionLog.

  // QUIÉN OPERA se resuelve ANTES de escribir nada, y en sus DOS lecturas del mismo
  // resolvedor — que dan lo mismo salvo en un caso, y ese caso es justo el que ②24.bis vino
  // a arreglar:
  //   · `tutorQueOpera` (CON respaldo) acredita la parte del tutor (DL-E49 §1). Si la sesión
  //     entra sin discriminador, sigue diciendo «el tutor 1», exactamente como hasta hoy —
  //     y el KMS lo re-valida contra los tutores declarados del grupo.
  //   · `tutorAtribuible` (SIN respaldo) es el único que puede alimentar la ATRIBUCIÓN del
  //     consentimiento: ahí «el tutor 1» por defecto no es un dato, es una suposición
  //     escrita en un registro legal. Cuando no consta devuelve null, y entonces las reglas
  //     2 y 3 de `wizardFirmanteDelConsentimiento_` —que con el respaldo NO SE ALCANZABAN
  //     NUNCA— deciden: un solo tutor vivo ⇒ firma ese; varios ⇒ no se registra.
  // Que diverjan es DELIBERADO. No cuesta lecturas: los dos comparten la memoria de la
  // identidad declarada (`_identidadDelEnlace_`), y solo el primero paga el respaldo.
  const tutorQueOpera   = wizardTutorQueOpera_(p, enrollmentGroupId);
  const tutorAtribuible = wizardTutorAtribuible_(p, enrollmentGroupId);

  const desiredStartDate = p.desired_start_date || null;
  const persistRes = kmsProxy_('enr.wizardPersistSubmitEnrollments', {
    resume_token:       p.resume_token,
    desired_start_date: desiredStartDate,
    // DL-E49 §1 — el envío es POR TUTOR: quien envía se resuelve server-side desde su
    // propio enlace, y el KMS lo re-valida contra los tutores declarados del grupo.
    submitted_by_person_id: tutorQueOpera,
  });
  const enrollmentIds = (persistRes && persistRes.enrollment_ids) || [];
  Logger.log('submitEnrollmentSession_: KMS persisted enrollments=' + enrollmentIds.length);

  // D33 / DL-S115 — el wizard YA NO fabrica la fila de transición de estado. La transición
  // IN→RQ la ejecuta el motor del KMS al completarse la marca APPLICATION_FORM_COMPLETED, y
  // es él quien deja el rastro en sysStateTransitionLog. El KMS ya descartaba estas filas
  // (enr_wizardPersistSubmitSideEffects → state_transitions_ignored); aquí se retiran de raíz.

  // ②17: el idioma del expediente lo devuelve la misma pregunta al KMS. Antes salía de la
  // cabecera que este manejador releía por su cuenta —la TERCERA lectura de la misma fila
  // en un solo envío, después de `requireResumeToken_` y `assertGroupEditable_`—; hoy la
  // sirve la puerta del KMS, que ya la tenía leída. Mismo respaldo a 'es' que siempre.
  const lang = p.language || (datosEnvio && datosEnvio.idioma) || 'es';

  // ── Log GDPR + legal consents (per enrollment) ─────────────────────────────
  // sysConsentsLog (DL-S44): polymorphic on entity_type_code + entity_id.
  // The GDPR consent that the family accepted on the consent page (deferred at
  // init time) is also recorded here, once per enrollment, alongside any
  // additional consents from the review step.
  //
  // ② 29 (2026-08-10) — QUIÉN FIRMA. Aquí ponía `guardians[0].person_id`: el firmante del
  // registro legal era **el primero que devolviera AppSheet**. Con el envío por partes
  // (DL-E49 §5) eso le atribuye a un tutor lo que consintió el otro. Ahora lo decide
  // `wizardFirmanteDelConsentimiento_` a partir del tutor que opera (resuelto arriba desde
  // su propio enlace). Si no se puede atribuir a nadie, NO se escribe el consentimiento —
  // ni con un firmante inventado ni con `signer_id` vacío.
  // ②24.bis — y se le pasa `tutorAtribuible`, NO `tutorQueOpera`: con el respaldo, «no
  // consta» llegaba aquí disfrazado de «el tutor 1» y las reglas 2 y 3 eran inalcanzables.
  const signerPersonId = wizardFirmanteDelConsentimiento_(tutorAtribuible, guardians);
  let consentRows = [];
  const consents = Array.isArray(p.consents) ? p.consents.slice() : [];
  // El mapa de tipos y su resolvedor viven en el ámbito del módulo
  // (`wizardCodigoDeConsentimiento_`): un solo sitio, y comprobable desde fuera.

  // ②29 — SIN FIRMANTE NO SE REGISTRA, Y SE DICE. Se llega aquí con el envío YA
  // materializado (`enr.wizardPersistSubmitEnrollments`, arriba: expedientes creados y
  // `submitted_at` estampado) ⇒ lanzar dejaría el expediente A MEDIAS y a la familia
  // atascada en `NOT_EDITABLE` al reintentar — el mismo fallo que la regla W1 de esta
  // función documenta y que por eso mueve TODAS las validaciones antes de la primera
  // escritura. Y retener el envío por esto también sería peor: es la doctrina que el KMS
  // ya tomó para el caso gemelo («sin saber QUIÉN envía no se puede acreditar a nadie… se
  // comporta como antes y se DICE, con el motivo, en vez de dejar un atasco sin
  // diagnóstico», `enr_persistSubmit_`). Así que no se atribuye, no se calla: queda en el
  // registro (redactado, KAL-11) y VUELVE al llamante en la respuesta.
  if (!signerPersonId) {
    Logger.log(redact_('[submitEnrollmentSession_] ②29: no se puede atribuir el consentimiento ' +
      'a ningún tutor (no consta quién opera —¿llegó el `n` del enlace?— y hay ' +
      guardians.length + ' tutores vivos, así que tampoco hay uno solo posible). ' +
      'NO se registra en el libro de consentimientos en nombre de nadie. grupo=' +
      String(enrollmentGroupId)));
  }

  (signerPersonId ? enrollmentIds : []).forEach(eid => {
    consents.forEach(c => {
      // `null` ⇒ NO es un consentimiento (la atestación de exactitud del paso 7). Se exigió
      // arriba; no se registra en el libro de consentimientos con un código que no existe.
      var codigo = wizardCodigoDeConsentimiento_(c && c.type);
      if (!codigo) return;
      consentRows.push({
        consent_id:             generateUuid_(),
        school_id:              SCHOOL_ID,
        entity_type_code:       'ENR_ADMISSION_SCHOOL',
        entity_id:              eid,
        signer_table:           'enrPersons',
        signer_id:              signerPersonId,
        consent_type:           codigo,
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
  // P1-A: `consentRows` (registro LEGAL de consentimientos) se PORTA al KMS al final
  // del submit — el wizard anónimo ya no escribe sysConsentsLog directo.

  // NOTE (IMPL-H): the guardian E.164 phone gate moved UP — it now runs as part
  // of the CLOSING VALIDATION block BEFORE any write (W1), reading real phones
  // from enrPhones (W2 / SOSPECHA-2 fix). It is intentionally gone from here so
  // no write precedes the validation. See the block right after the applicant
  // check above.

  // ②17 (2026-08-15) — AQUÍ VIVÍAN TRES LECTURAS A APPSHEET QUE NADIE LEÍA. Se retiran.
  //
  // Eran las de `enrEmails` por `email_id`, `enrPhones` por `phone_id` y `qbResponses`
  // (profesión, empleador y adaptación). Las dos primeras estaban guardadas tras
  // `if (gEmailIds.length)` / `if (gPhoneIds.length)`, y sus dos orígenes —`gEmailJoins`
  // y `gPhoneJoins`— eran literales `[]` desde que `enrPersonEmails`/`enrPersonPhones`
  // se borraron (2026-05-17): **no se ejecutaban nunca**. La tercera SÍ se ejecutaba en
  // CADA envío, y su resultado (`qbResponseMap`) tampoco tenía un solo lector — su único
  // consumidor histórico era `buildApplicationSubmittedBody_`, que se quedó sin llamantes
  // al retirarse el PDF (P262) y los dos correos del envío (2026-08-07).
  //
  // ⚠️ Y no era solo trabajo tirado: esa lectura ocurría DESPUÉS de que el KMS ya hubiera
  // materializado los expedientes y estampado `submitted_at` (`enr.wizardPersistSubmitEnrollments`,
  // más arriba), y NO estaba dentro de ningún `try`. Si AppSheet fallaba —y
  // `appsheetRequest_` lanza siempre, sin degradar—, la familia se quedaba con la
  // solicitud MEDIO ENVIADA y su reintento chocaba contra `NOT_EDITABLE`: exactamente el
  // atasco que describe el bloque W1 de más arriba, provocado por un dato que nadie mira.
  //
  // Con esto el envío deja de hacer una ida y vuelta a AppSheet y pierde un modo de fallo
  // que dejaba familias encalladas. La isla entera —las cuatro constantes `QB_*`,
  // `buildApplicationSubmittedBody_` y `_kmsRenderApplicantsTable_`— se retira también:
  // medido contra `origin/main`, ninguna de las dos funciones tenía llamantes.

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

  // ②17 (2026-08-16) — AQUÍ VIVÍAN LAS DOS ÚLTIMAS LECTURAS DIRECTAS A APPSHEET DEL ENVÍO.
  //
  // Eran las que enganchaban los documentos del paso 6 a los expedientes que acaban de nacer:
  // `recFiles` (los ficheros con `origin_reference = <el grupo>`) y `recScopes` (el guarda que
  // evita duplicar al reintentar). Las hacía ESTE proceso, que es público y anónimo, con la
  // credencial de AppSheet de la aplicación entera — y la segunda corría UNA VEZ POR FICHERO.
  //
  // Ahora las etiquetas las compone el KMS, en `enr.wizardPersistSubmitSideEffects` (helper
  // `enr_ambitosDelEnvio_`), que ya tiene lo que hace falta: el grupo derivado del
  // `resume_token` por su propia puerta (KAL-4) y los expedientes que él mismo acaba de
  // materializar. El asistente ya NO manda `rec_scopes`: si las mandara, habría DOS
  // composiciones del mismo dato y divergirían.
  //
  // ⚠️ LA PREMISA QUE BLOQUEÓ ESTE TRAMO CUATRO VUELTAS ERA FALSA, y conviene dejarlo escrito:
  // se decía que este trozo no se podía mover porque «lleva dentro el literal
  // `enr_admission_school` y DL-E48 prohíbe escribir a mano el tipo de expediente».
  // `enr_admission_school` en MINÚSCULAS **no es un tipo de expediente**: era un
  // `scope_type_code` de `recScopes` —y desde D78 uno RETIRADO—. El tipo de expediente es
  // `ENR_ADMISSION_SCHOOL`, en mayúsculas y contra `sysEntityTypes`, y aquí no aparecía.
  //
  // Y el guarda del reintento estaba MIRANDO UN VALOR QUE EL KMS YA NO ESCRIBE: filtraba por
  // ese ámbito retirado mientras el KMS escribe el TEMA del documento (D78/DL-R16), así que no
  // casaba nunca ⇒ un reenvío duplicaba las etiquetas de todos los documentos. El KMS pregunta
  // ahora lo que el guarda siempre quiso preguntar: ¿ya está este documento enganchado a un
  // expediente de este grupo?

  // ── P1-A: escrituras cross-cutting del submit → KMS (único escritor) ──────────
  // sysConsentsLog + recScopes se persisten en el KMS, que re-deriva el grupo del
  // resume_token (KAL-4) y fuerza school_id server-side. El wizard anónimo ya NO tiene
  // write directo a sys*/rec*. Síncrono (mirror del proxy de documentos): un fallo se
  // propaga (sin éxito falso) — coherente con la semántica síncrona del código original.
  kmsProxy_('enr.wizardPersistSubmitSideEffects', {
    resume_token:      p.resume_token,
    consents:          consentRows,
  });

  // ── Los dos correos del envio los pide el KMS, NO el wizard (tramo D, Paso 2) ──
  // Retirados el 2026-08-07. El wizard reporta un HECHO ("la familia envio el
  // formulario") y quien decide que se manda es la configuracion del centro:
  //   · a la familia   -> kis-rule-0014 "Solicitud recibida - confirmacion a la familia"
  //   · a admisiones   -> kis-rule-0015 "Solicitud recibida - aviso interno staff"
  // Las dos cuelgan de la entrada en RQ (SUBMITTED_STATE_ENTERED_AT, occurrence FIRST).
  //
  // POR QUE AHORA, medido el 2026-08-07: Diego encendio kis-rule-0014, y hay 13 pasos a
  // RQ registrados => la regla YA tiene de donde arrancar. Con estas dos llamadas vivas,
  // la siguiente solicitud enviada mandaria el MISMO correo DOS VECES a la misma familia.
  // (Un agente sostuvo que no podia dispararse "porque el envio no registra paso alguno";
  // la medicion lo desmiente: los pasos se registran, y los fabrica este mismo fichero.)
  //
  // PROHIBIDO devolver estas llamadas: duplicarian el correo. Si algun dia la familia deja
  // de recibirlo, lo que falla es la regla del centro, y se arregla en su pantalla.

  // -- DL-E49 §5 · ACUSE AL QUE ENVIA ANTES QUE LOS DEMAS -------------------------------
  // Espejo exacto de DL-E43 §2: su envio esta REGISTRADO, y se le dice que aun falta que
  // los demas tutores completen su parte. Sin esto envia, no pasa nada visible, y no
  // entiende por que. Estos conteos los calcula el KMS (unico sitio que sabe que partes
  // constan); aqui solo se reenvian a la pantalla de confirmacion.
  //
  // El CORREO de ese acuse NO se encadena aqui: cuelga del paso «la parte de un tutor esta
  // enviada» y lo declara el centro en su pantalla de avisos (DL-E44 §4), igual que los dos
  // correos del envio que se retiraron de este mismo fichero el 2026-08-07.
  return {
    submitted:           true,
    enrollment_group_id: enrollmentGroupId,
    enrollment_ids:      enrollmentIds,
    // legacy alias \u2014 frontend builds reading application_id keep working
    application_id:      enrollmentGroupId,
    // Parcial = tu parte quedo registrada, pero la solicitud todavia NO pasa a revision.
    parcial:              !!(persistRes && persistRes.partial),
    tutores_total:        (persistRes && persistRes.tutores_total) || 0,
    tutores_que_enviaron: (persistRes && persistRes.tutores_que_enviaron) || 0,
    falta_por_enviar:     (persistRes && persistRes.falta_por_enviar) || 0,
    // ②29 — el libro de consentimientos es el REGISTRO LEGAL: si no se pudo atribuir a
    // quien consintió, no se escribe a nombre de nadie, y el hecho SALE de aquí en vez de
    // quedarse solo en el registro del servidor. Campos añadidos (nadie los leía antes):
    // el que no los conoce sigue funcionando igual.
    consentimientos_registrados: consentRows.length,
    consentimiento_sin_firmante: !signerPersonId,
  };
}

/**
 * Generates and emails a 6-digit verification code.
 *
 * Cache key uses the enrollment_group_id (accepts legacy application_id alias).
 *
 * @param {Object} p - { enrollment_group_id?|application_id?, primary_email }
 */
// ★ 2026-08-19 (①51) — este comentario decía que «el wizard envía CERO emails localmente»
// y ya NO es cierto: `sendAsAlias_` está RESTAURADA y es el único transporte de correo de
// este proyecto. Lo que sí sigue siendo cierto, y es la mitad que importa: **el RENDER vive
// en el KMS** — plantillas, idioma, marcadores e identidad de correo. Aquí no hay ni una
// plantilla ni una línea de HTML de correo. Se envía desde aquí porque `MailApp` no admite
// remitente y porque este proyecto es el único de los dos cuyos permisos consiente
// exclusivamente quien publica. Todo el camino está en `_kmsRenderizarYEnviar_`.

function sendVerificationCode_(p) {
  let enrollmentGroupId;
  let primary_email;
  // ②24 — huella del buzón al que va el código. Namespacea el código, su contador de
  // intentos y su cupo, y es lo que `verifyEmail_` estampa en la marca de step-up.
  let personaEmail = null;

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
    // ②24 (2026-08-10) — EL CÓDIGO VA AL BUZÓN DEL TUTOR QUE ESTÁ OPERANDO.
    //
    // Hasta hoy salía SIEMPRE a `primary_email`, que no es «el correo del expediente»:
    // es el correo personal del TUTOR 1 (artefacto Stage-1, ver §"Modelo canónico de
    // email de recuperación" del CLAUDE.md de este repositorio). Con el envío por tutor
    // de DL-E49 §1, el tutor 2 que agotaba los 10 minutos de gracia de su enlace pedía
    // el código y el código se iba al buzón del otro: no podía volver a entrar en su
    // propia solicitud.
    //
    // El buzón lo resuelve el MISMO sitio que todo lo demás (`_identidadDelEnlace_` →
    // `effectiveRecoveredEmail_`, identidad DEL ENLACE con la validación KAL-4 de que la
    // fila es de este expediente). Nunca del cuerpo de la petición: un atacante no puede
    // redirigirse el código a su propio buzón.
    //
    // Sin discriminador (`n` ni `recovered_email`) ese resolvedor cae, por su propio
    // diseño, al `primary_email` del expediente ⇒ una sesión que no se identifica se
    // comporta EXACTAMENTE como hasta hoy. La lectura de la fila de grupo de abajo se
    // conserva como último respaldo (y para el error claro si el expediente no tiene
    // ningún correo con el que hacer nada).
    //
    // Sin `else` a propósito: `scripts/verja-publica.mjs` parte este manejador en sus dos
    // ramas por el PRIMER `} else {`, así que un if/else anidado aquí le movería el corte
    // y le haría ver la lectura de abajo como si fuera de la rama de alta. Es el límite
    // declarado de ese control (detector por líneas, no analizador sintáctico) y la
    // respuesta correcta es no darle una forma ambigua, no aflojarlo.
    personaEmail = _identidadDelEnlace_(p, enrollmentGroupId);
    primary_email = personaEmail;
    if (!primary_email) {
      const grpRows = appsheetRequest_(T.ENROLLMENT_GROUPS, 'Find', [], {
        Filter: '"enrollment_group_id" = "' + appsheetEscape_(enrollmentGroupId) + '"'
      });
      primary_email = grpRows && grpRows[0] && grpRows[0].primary_email;
    }
    if (!primary_email) {
      const errNoEmail = new Error('No primary_email on file for this group');
      errNoEmail.code = 'BAD_REQUEST';
      throw errNoEmail;
    }
  } else {
    // ── Flujo NO-stepup (signup inicial). El grupo y el email vienen del PAYLOAD
    // (la familia aún no tiene token de sesión).
    //
    // ②12 (2026-08-09) — VERJA PÚBLICA fail-closed. Esta rama es alcanzable desde
    // internet sin identificarse (`case 'sendVerificationCode'` del despachador,
    // manifest ANYONE_ANONYMOUS) y toma el correo de destino del propio cuerpo de
    // la petición ⇒ sin verja, cualquiera manda un código de un solo uso al buzón
    // que quiera: bombardeo de correo y coste de reputación del remitente. Aquí NO
    // hay oráculo de existencia que proteger (el llamante ya conoce un
    // identificador de grupo) y este manejador SÍ propaga el error al cliente, así
    // que se usa la forma que LANZA. La decisión sigue viviendo en UN solo sitio
    // (`_verjaPublicaVeredicto_`); esto es su envoltorio, no una verja nueva.
    //
    // Va ANTES del cupo por-correo (`_checkMagicLinkRateLimit_`, más abajo) por el
    // mismo motivo que en `sendMagicLink_`: un sondeo que no pasa la verja tampoco
    // debe poder agotarle a una familia real su cupo de enlaces.
    //
    // La rama step-up NO la lleva y no debe llevarla: su cliente no manda token de
    // reCAPTCHA, deriva grupo y correo del bearer (KAL-4) y ponerle verja rompería
    // la comprobación de identidad de las familias.
    _asegurarVerjaPublica_(p && p.recaptcha_token);

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
    // ②24 — el cupo es POR BUZÓN, no por expediente: con dos tutores operando a la vez,
    // un cupo compartido hacía que el primero en gastar 8 dejara al otro sin códigos.
    _checkStepUpCodeRateLimit_(enrollmentGroupId, personaEmail);
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
  // ★ SEC WIZ-STEPUP-CACHE (audit 2026-07-22): NAMESPACING de la clave OTP. El
  // camino step-up y el camino signup NO comparten la clave de cache. El camino
  // signup (NO-stepup, sin token/reCAPTCHA) toma group+email del PAYLOAD, así que
  // un atacante con un resume_token filtrado podía POST signup con SU propio email
  // → el servidor cacheaba el código bajo `verify_<G>` y se lo enviaba al atacante,
  // que luego lo canjeaba en el canje step-up (que leía esa MISMA clave) → step-up
  // fresco → PII completa del menor (colapso de DL-E39). Con el namespacing, el
  // canje step-up SOLO confía en `stepup_verify_<G>`, sembrado EXCLUSIVAMENTE por el
  // camino step-up (que deriva el grupo del token, KAL-4, y envía al primary_email
  // REAL del grupo — nunca a un email del payload). El signup no puede sembrar esa
  // clave. El camino signup conserva `verify_<G>` intacto (byte-neutro).
  //
  // ②24 (2026-08-10): la clave del step-up lleva además la HUELLA DEL BUZÓN al que se
  // manda el código. Dos motivos, los dos medidos contra el envío por tutor de DL-E49:
  // (1) con los dos tutores operando a la vez, la clave compartida hacía que el segundo
  // código PISARA al primero y el primer tutor tecleara un código ya inválido; (2) un
  // código emitido para un buzón no puede canjearse en nombre de otro (`verifyEmail_`
  // deriva la misma huella del mismo sitio).
  const codeKey = (p && p.stepup === true)
    ? _stepUpCodeKey_(enrollmentGroupId, personaEmail)
    : 'verify_' + enrollmentGroupId;
  cache.put(codeKey, code, 600); // 10 min TTL

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

  // ★ SEC WIZ-STEPUP-CACHE (audit 2026-07-22): el canje step-up lee/limpia bajo la
  // clave NAMESPACED `stepup_verify_<G>` (+ su propio bucket de lockout), NUNCA la
  // clave `verify_<G>` del signup. Así el código canjeado en step-up SOLO puede
  // haber sido emitido por el camino step-up (que envía al primary_email real del
  // grupo derivado del token). El camino signup conserva `verify_<G>` /
  // `verify_attempts_<G>` intactos (byte-neutro). Ver sendVerificationCode_.
  //
  // ②24 (2026-08-10): en el step-up la clave lleva la HUELLA DEL BUZÓN, derivada del
  // MISMO sitio que la usó al emitir (`_identidadDelEnlace_` → `_stepUpCodeKey_`). Así un
  // código que se mandó al buzón de un tutor no se puede canjear en nombre de otro, y dos
  // tutores operando a la vez no se pisan el código.
  const isStepUp = (p && p.stepup === true);
  const personaEmail = isStepUp ? _identidadDelEnlace_(p, enrollmentGroupId) : null;
  const codeKey = isStepUp
    ? _stepUpCodeKey_(enrollmentGroupId, personaEmail)
    : 'verify_' + enrollmentGroupId;

  // KAL-NEW-2.b: lockout de intentos (anti fuerza-bruta 10^6). 5 intentos fallidos
  // por group → TOO_MANY_ATTEMPTS sin revelar si el código era correcto. TTL 10 min
  // (mismo que el código). Acierto → borra contador + código.
  const attemptsKey = isStepUp
    ? _stepUpAttemptsKey_(enrollmentGroupId, personaEmail)
    : 'verify_attempts_' + enrollmentGroupId;
  const attempts = parseInt(cache.get(attemptsKey) || '0', 10);
  if (attempts >= 5) {
    const errLock = new Error('Too many verification attempts; request a new code');
    errLock.code = 'TOO_MANY_ATTEMPTS';
    throw errLock;
  }

  const stored = cache.get(codeKey);
  if (!stored) throw new Error('Verification code expired or not found');
  if (stored !== code.toString()) {
    cache.put(attemptsKey, String(attempts + 1), 600);
    throw new Error('Invalid verification code');
  }

  cache.remove(attemptsKey);
  cache.remove(codeKey);

  // DL-E39 step-up: acierto en flujo step-up → marca el grupo como fresco
  // durante STEPUP_INACTIVITY_MS. Los handlers de PII (assertStepUpFresh_)
  // pasarán hasta que la ventana expire. (Flujo NO-stepup intacto.)
  // ②24: la marca se estampa A NOMBRE DEL BUZÓN al que se mandó el código — es lo único
  // que el acierto demuestra. Ver `_leerMarcaStepUp_` para la regla de comparación.
  //
  // 2026-08-20 · Y TAMBIÉN A NOMBRE DE LA PÁGINA VIVA QUE ACERTÓ (`pv`). Es EL sitio donde
  // el atado se acuña: quien tecleó el código estaba en ESTA carga de página, y una recarga
  // —que pierde la variable de memoria y acuña otra— vuelve a pedir el código. Si esta
  // llamada se quedara sin la huella, el atado no existiría para el camino principal y todo
  // lo demás sería decorativo.
  if (isStepUp) {
    _markStepUpFresh_(enrollmentGroupId, 'OTP', personaEmail, _huellaDePagina_(p));
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
  //
  // ★ 2026-08-04 — este camino tenía su PROPIA copia del salto HTTP al KMS (el mismo
  // `UrlFetchApp.fetch` + Bearer + parseo, escrito aparte). Dos transportes del mismo
  // salto DIVERGEN, y éste divergió justo donde importa: cuando `kmsProxy_` aprendió a
  // reintentar el `echo` ilegible, las PREGUNTAS se habrían quedado sin reintento, y su
  // fallo medido —«KMS qb-public: non-JSON response: <!doctype html…»— es exactamente
  // el que el reintento cura. Ahora usa el transporte ÚNICO: uno solo que arreglar.
  return fetchQuestions_adaptKmsResponse_(kmsProxy_('qb-public.resolveSetForConsumer', {
    consumer_code: 'ADMISSIONS_WIZARD',
    context_code:  contextCode,
    receptor:      { locale: lang },
    school_id:     SCHOOL_ID,
  }), lang);
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


/*
 * ── `deriveAudienceCategoryId_` ELIMINADA (2026-08-04) ────────────────────────────────
 * Deducía si una pregunta era del alumno o del tutor **por el PREFIJO de su código**
 * (`hygiene_`, `voice_` → participante; `family_values_`, `applicant_` → cliente). Eso es
 * el cuestionario de UN colegio escrito dentro del wizard: cambia un código en el catálogo
 * y el wizard clasifica mal sin enterarse. Además **no tenía ni un llamante** (medido con
 * grep: solo su propia definición), así que se borra en vez de sustituirse. Si algún día
 * hace falta esa clasificación, la emite el KMS con la pregunta — no la adivina el cliente.
 */


/**
 * Adapta la response del motor qb-core del KMS al shape legacy que el
 * frontend `QbSetRenderer` ya consume hoy (Step5Questions + Step7Review).
 *
 * KMS qb-core (Q05-S1) devuelve:
 *   { consumer_code, context_code, context_id, locale,
 *     sets: [{ set_id, set_code, designation, description, is_default_for_context,
 *              questions: [{ question_id, question_code, response_type_code, ui_widget,
 *                            designation, description, is_required, sequence,
 *                            answer_options: [{ option_id, option_value, display_order, designation, description }],
 *                            conditions: [{ question_condition_id, condition_ref_table, condition_ref_id }] }] }] }
 *
 * Wizard frontend espera (legacy shape pre-Q05-S5):
 *   { context, sets: [{ ...s, items: [{ ..., question: { ..., question_text, help_text,
 *                                                       placeholder_text, options: [{ ..., text }],
 *                                                       conditions: [...], response_type_id,
 *                                                       ui_widget, audience_category_id, is_required } }] }] }
 *
 * Mapeo aplicado:
 *   - q.designation                   → question.question_text
 *   - q.description                   → question.help_text (placeholder_text vacío — KMS no expone aún)
 *   - q.response_type_code            → question.response_type_id (lowercased; el render hace toLowerCase)
 *   - q.ui_widget                     → question.ui_widget (③51 — el CONTROL declarado, passthrough)
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
  // «EL SERVIDOR NO CONTESTÓ» NO ES «ESTE COLEGIO NO TIENE PREGUNTAS» (2026-08-04).
  //
  // Aquí ponía `if (!kmsData) return { sets: [] };`: un payload AUSENTE del KMS —o sea,
  // un FALLO— salía por la misma puerta que un catálogo legítimamente vacío. Con las dos
  // cosas indistinguibles, ningún consumidor podía decidir bien: el frontend guardaba ese
  // vacío como catálogo bueno y lo servía media hora (`api.js`, ventana de revalidación).
  // Un catálogo vacío sigue siendo representable —`{sets:[]}` con `kmsData` presente—;
  // lo que ya no se representa como vacío es el fallo.
  if (!kmsData) {
    var eSinCatalogo = new Error('El servicio de preguntas no devolvió catálogo. ' +
      'No es que este colegio no tenga preguntas: es que la respuesta vino vacía.');
    eSinCatalogo.code = 'QUESTIONS_CATALOG_UNAVAILABLE';
    throw eSinCatalogo;
  }

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
        // ③51 (2026-08-16) — CON QUÉ CONTROL se pinta la pregunta, tal y como lo DECLARA la
        // ficha del tipo de respuesta en el KMS (`qbResponseTypes.ui_widget`, emitido por
        // `qb_core_enrichQuestion_`). Se pasa VERBATIM: quien decide es el renderer
        // (`QbSetRenderer/index.jsx`), que cae al código del tipo cuando no viene o no lo
        // reconoce — así una familia nunca se queda sin poder contestar. Aquí no se traduce
        // ni se valida contra ninguna lista: sería una segunda copia del vocabulario.
        ui_widget:          q.ui_widget || null,
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
 * Resuelve el catálogo de preguntas que viaja PLEGADO en la hidratación, distinguiendo
 * las dos cosas que hasta hoy se confundían:
 *
 *   - el KMS mandó catálogo → se adapta al shape `{ context, sets }` del cliente;
 *   - el KMS no lo mandó, o el adaptador reventó → **no hay catálogo**: se RETIRA la
 *     clave `questions` y se marca `questions_no_disponible`.
 *
 * Por qué retirar la clave en vez de mandar `{sets:[]}`: `{sets:[]}` significa «este
 * colegio no tiene preguntas», y el cliente tiene derecho a creérselo y cachearlo. Un
 * fallo no puede viajar con ese disfraz — la ausencia de la clave hace que el cliente
 * pida el catálogo por su cuenta (`fetchQuestions`), que es un fallo NO pegajoso.
 *
 * Muta `data` y lo devuelve (el llamante ya trabaja sobre ese objeto).
 *
 * @param {Object} data — payload de hidratación (se muta)
 * @param {string} lang
 * @returns {Object} el mismo `data`
 * @private
 */
function wizardResolverPreguntasDeHidratacion_(data, lang) {
  if (!data) return data;
  if (!data.questions) return data;   // el KMS no plegó catálogo: el cliente lo pedirá
  try {
    data.questions = fetchQuestions_adaptKmsResponse_(data.questions, lang || 'es');
  } catch (e) {
    delete data.questions;
    data.questions_no_disponible = true;
    Logger.log('[hydrate] catálogo de preguntas NO disponible (no se manda vacío para que ' +
               'nadie lo cachee como bueno): ' + redact_(String(e && e.message)).slice(0, 160));
  }
  return data;
}

/**
 * Fetches lookup options for health fields (allergies, dietary, medical).
 * @returns {{ allergies: Array, dietary: Array, medical: Array }}
 */
function fetchLookups_(p) {
  // Thin-client (DL-E41 / WPERF-3): los catálogos del wizard (sin PII) los sirve el
  // KMS — el wizard deja de leer AppSheet directo. kmsProxy_ añade service_token +
  // Bearer OAuth; el KMS (enr.wizardFetchLookups) los valida y devuelve el mismo shape
  // { allergies, dietary, medical, relationTypes, programs } de { id, label }.
  //
  // ①31 — las fechas de programa (`period_starts_on` / `period_ends_on`) llegan en ISO
  // `YYYY-MM-DD`. Esta línea ya lo afirmaba desde antes y era FALSA: el KMS las mandaba
  // EN CRUDO, en el formato americano de AppSheet, y quien construyó los límites del paso 1
  // se creyó la afirmación ⇒ toda familia de «a mitad de curso» quedaba bloqueada. Desde el
  // 2026-08-09 es cierta, y lo es EN UN SOLO SITIO: `enr_wizardFetchLookups` normaliza con
  // `utils_appsheetDateToIso_` (`kis-app kms-server/enr/wizard-gateway.gs`). Si alguien
  // quita esa normalización, esta frase vuelve a ser mentira — se comprueba allí, no aquí.
  //
  // ★ 2026-08-19 — EL IDIOMA VIAJA. Los tipos de documento que la familia puede aportar
  // (`recTypesInterestedParty`, el desplegable del paso 6) salen del catálogo del centro, y
  // desde hoy en el idioma que la familia esté leyendo cuando el centro ha guardado esa
  // versión (primitivo de traducciones del KMS, resuelto en `rec_resolveInterestedPartyType_`).
  // Aquí NO se traduce nada ni se decide nada: se reenvía el idioma que manda la pantalla y
  // se devuelve lo que conteste el KMS. Sin idioma —o sin versión guardada— la respuesta es
  // exactamente la de siempre: la descripción de la ficha.
  var idioma = (p && p.language) ? String(p.language).trim() : '';
  return kmsProxy_('enr.wizardFetchLookups', { school_id: SCHOOL_ID, language: idioma || null });
}

/**
 * Batch-writes question responses.
 *
 * `respondent_id` defaults to the enrollment_group_id (pre-submit responses
 * are session-scoped). Legacy `application_id` is accepted as alias.
 *
 * @param {Object} p - { enrollment_group_id?|application_id?, respondent_id, respondent_type_category_id, responses: Array }
 */
/**
 * DL-E49 §1 · QUIÉN ESTÁ OPERANDO — el tutor que tiene el asistente delante.
 *
 * NO es un mecanismo nuevo: reusa la identidad que YA viaja en el propio enlace del tutor
 * (IDENTITY-FROM-LINK, `n` = email_id de `enrEmails`) y su resolvedor probado
 * (`effectiveRecoveredEmail_` → `resolveGuardianForRecovery_`, ambos con la validación
 * KAL-4 de que la fila pertenece al grupo del token). DL-E49 §9 lo dice tal cual: «la
 * identidad del tutor que entra ya se resuelve server-side desde el propio enlace».
 *
 * Devuelve el `person_id` del tutor, o `null` si no se puede identificar — y `null` NUNCA
 * bloquea: el KMS, que es quien decide, trata la ausencia de identidad como «no consta» y
 * se comporta como hasta hoy. Bloquear aquí convertiría un dato que falta en un asistente
 * que no guarda.
 *
 * @param {Object} p payload del handler (lleva resume_token y, si el tutor entró por su
 *                   enlace, `n`; `recovered_email` es el compat secundario).
 * @param {string} groupId grupo YA autorizado (derivado del resume_token — KAL-4).
 * @returns {string|null} person_id del tutor que opera.
 */
/**
 * DL-E49 §5 · ¿QUÉ TUTORES HAN ENVIADO SU PARTE Y CUÁLES FALTAN?
 *
 * Lectura. La usa la pantalla de confirmación para acusar recibo al que envía antes que
 * los demás: su envío consta, y falta que los otros completen su parte. Proxy fino al KMS
 * —el asistente no calcula nada— y la identidad del que pregunta se resuelve server-side
 * desde su propio enlace, no se acepta del cliente.
 *
 * @param {Object} p { resume_token, n? }
 */
function estadoDeLasPartes_(p) {
  // KAL-4: el grupo SIEMPRE del resume_token, nunca del payload.
  var groupId = requireResumeToken_(p);
  return kmsProxy_('enr.wizardEstadoDeLasPartes', {
    resume_token: p.resume_token,
    person_id:    wizardTutorQueOpera_(p, groupId),
  });
}

/**
 * 18.bis.84 · ¿CÓMO ACABÓ UN GUARDADO QUE EL KMS DEJÓ APUNTADO?
 *
 * ── El defecto que esto cierra ──────────────────────────────────────────────────────
 * El KMS NO guarda los pasos del asistente en el acto: los APUNTA para hacerlos después y
 * contesta «apuntado». Si el trabajador que los ejecuta falla, o descarta contenido a
 * propósito (el KMS rechaza que un tutor toque la ficha de otro, DL-E49 §2; y descarta las
 * respuestas del tutor que ya envió su parte, §6), **la familia ya leyó «Todos los cambios
 * guardados» y nadie se entera nunca**. Los seis guardados devuelven ahora el identificador
 * del trabajo; esto es lo que permite volver a preguntar por él.
 *
 * ── Por qué es un PROXY FINO y no un cálculo ────────────────────────────────────────
 * La verdad de cómo acabó un trabajo vive en el KMS, que es donde está la cola. El
 * asistente no deduce nada: pregunta y devuelve lo que le contesten.
 *
 * ── Autorización ────────────────────────────────────────────────────────────────────
 * KAL-4 LO PRIMERO: el expediente sale del bearer, jamás del cuerpo de la petición. Los
 * identificadores de trabajo NO autorizan nada — el KMS contesta `'desconocido'` para el
 * que no sea de ese expediente, sin delatar que exista.
 *
 * ── EXENTO del código de un solo uso (`assertStepUpFresh_`), con su motivo escrito ──
 * Es una LECTURA que **no muta ni un dato de la familia** y **no devuelve ni un dato
 * personal**: solo dice si un trabajo del PROPIO expediente —del que ya se tiene el token—
 * acabó bien, mal o sigue en marcha. Gatearla con el código sería peor que inútil: quien
 * más necesita enterarse de que su guardado se descartó es justamente quien lleva un rato
 * sin verificarse, y entonces el asistente se quedaría mudo en el único momento que
 * importa. Tampoco lleva verja reCAPTCHA: no es una puerta anónima, se llama desde dentro
 * de la sesión de la familia (§"Las CINCO puertas del asistente", regla 0).
 *
 * @param {Object} p { resume_token, job_ids: string[] }
 * @returns {Object} { trabajos: [{ job_id, estado, motivo, descartes }] } en el mismo orden.
 */
function estadoDelGuardado_(p) {
  requireResumeToken_(p);   // KAL-4, LO PRIMERO: sin bearer válido no se pregunta nada.
  // Tope de 10 — el mismo que acepta el KMS. Recortar aquí evita un rechazo por tamaño que
  // el asistente no sabría explicarle a nadie.
  var ids = (p && Array.isArray(p.job_ids) ? p.job_ids : [])
    .filter(function (x) { return typeof x === 'string' && x; })
    .slice(0, 10);
  if (!ids.length) return { trabajos: [] };
  return kmsProxy_('enr.wizardEstadoDelTrabajo', {
    resume_token: p.resume_token,
    job_ids:      ids,
  });
}

function wizardTutorQueOpera_(p, groupId, opts) {
  try {
    // ②24 — el buzón lo resuelve UN SOLO SITIO (`_identidadDelEnlace_`, con memoria):
    // el mismo que decide a quién se le manda el código de un solo uso y de quién es la
    // marca de step-up. Aquí solo se traduce ese buzón a persona.
    // ②24.bis — `opts` viaja tal cual: el modo estricto se DECLARA, no se duplica el
    // resolvedor (dos lectores del mismo dato divergen).
    var email = _identidadDelEnlace_(p, groupId, opts);
    if (!email) return null;
    // ②17 (noveno tramo): la traducción buzón→persona la hace el KMS. El expediente sale
    // del token (KAL-4), igual que antes lo sacaba `groupId`, que ya venía derivado de él.
    return resolveGuardianForRecovery_(p && p.resume_token, email) || null;
  } catch (e) {
    Logger.log(redact_('[wizardTutorQueOpera_] no se pudo identificar al tutor: ' + e.message));
    return null;
  }
}

/**
 * ②24.bis · EL TUTOR AL QUE SE PUEDE ATRIBUIR ALGO — sin respaldo, o nadie.
 *
 * NO es un resolvedor nuevo: es `wizardTutorQueOpera_` pidiéndole al ÚNICO resolvedor que
 * NO caiga a «el tutor 1» (`effectiveRecoveredEmail_`, paso 3). Existe con nombre propio
 * porque el uso es distinto y hay que poder buscarlo: quien ATRIBUYE un acto a una persona
 * —hoy, quién firmó el consentimiento (②29)— necesita saber cuándo NO consta, y el respaldo
 * nunca dice eso. Los otros dos usos del mismo buzón (a qué correo va el código de un solo
 * uso, de quién es la marca de step-up) SIGUEN con respaldo y no se tocan: ahí devolver «el
 * tutor 1» es, como mucho, el comportamiento de siempre.
 *
 * @param {Object} p payload del manejador (resume_token + `n` y/o recovered_email).
 * @param {string} groupId expediente YA autorizado (derivado del token — KAL-4).
 * @returns {string|null} person_id del tutor que consta, o null = «no consta».
 */
function wizardTutorAtribuible_(p, groupId) {
  return wizardTutorQueOpera_(p, groupId, { sinRespaldo: true });
}

/**
 * ②29 · EL CONSENTIMIENTO SE ATRIBUYE A QUIEN LO DIO — NUNCA «AL PRIMERO DE LA LISTA»
 *
 * El libro de consentimientos (`sysConsentsLog`) es el REGISTRO LEGAL: su `signer_id` dice
 * QUIÉN consintió. Hasta el 2026-08-10 el envío lo rellenaba con `guardians[0].person_id`,
 * es decir, con **el orden en que AppSheet devolviera las filas**. Desde que el envío es POR
 * TUTOR (DL-E49 §1/§5 — cada tutor manda su parte con su propio enlace), eso le atribuía a
 * un tutor un consentimiento que **no dio él**.
 *
 * Aquí NO se resuelve la identidad: la resuelve `wizardTutorAtribuible_` (el MISMO resolvedor
 * de siempre, desde el propio enlace del tutor —IDENTITY-FROM-LINK—, pidiéndole el modo SIN
 * respaldo). Esta función solo DECIDE si se puede atribuir el consentimiento a alguien, y es
 * pura a propósito (sin lecturas, sin fechas) para poder comprobarse desde fuera con
 * `scripts/`-style extraction.
 *
 * ②24.bis (2026-08-10) — LAS REGLAS 2 Y 3 NO SE ALCANZABAN NUNCA. El llamante le pasaba el
 * tutor resuelto CON respaldo, y el respaldo nunca devuelve null: ante «no consta» entregaba
 * el `primary_email` del expediente (el tutor 1). Así que este `if (tutorQueOpera)` se
 * cumplía SIEMPRE y las dos ramas honestas de abajo eran código muerto. Ahora recibe null
 * cuando de verdad no consta. Quien cambie el llamante tiene que seguir pasándole el
 * ESTRICTO: con el indulgente, esta función vuelve a ser un `if` con una sola salida.
 *
 * Las tres reglas, en orden:
 *   1. Si el tutor que opera resolvió Y es un tutor VIVO de este grupo → firma ÉL.
 *      (La pertenencia se re-comprueba aquí, KAL-4 en profundidad, igual que la re-comprueba
 *      el KMS con `submitted_by_person_id` en `enr_persistSubmit_`.)
 *   2. Si NO resolvió y el grupo tiene UN SOLO tutor vivo → firma ese. No es deducción por
 *      resta (prohibida, DL-E48): el conjunto de posibles remitentes tiene un solo elemento.
 *      Es la MISMA regla que ya aplica el KMS (`wizard-gateway.gs`, `partes.tutores.length === 1`).
 *   3. En cualquier otro caso → `null` = **no se atribuye a nadie**. El llamante NO escribe
 *      la fila: ni con un firmante inventado, ni con `null` en `signer_id`.
 *
 * @param {string|null} tutorQueOpera  person_id devuelto por `wizardTutorAtribuible_` (el modo
 *                                     SIN respaldo), o null = «no consta quién opera».
 * @param {Array}       tutoresVivos   tutores VIVOS del grupo (ya pasados por `wizardSoloVivas_`).
 * @returns {string|null} person_id del firmante, o null si no se puede atribuir.
 */
function wizardFirmanteDelConsentimiento_(tutorQueOpera, tutoresVivos) {
  var vivos = (Array.isArray(tutoresVivos) ? tutoresVivos : []).filter(function (g) {
    return g && g.person_id;
  });
  if (tutorQueOpera) {
    var esDeEsteGrupo = vivos.some(function (g) { return g.person_id === tutorQueOpera; });
    // Declarado pero ajeno al grupo ⇒ NO se cae al «primero»: eso es justo lo que había que
    // cerrar, y además sería registrar una firma de otra familia en un libro de solo añadir.
    return esDeEsteGrupo ? tutorQueOpera : null;
  }
  if (vivos.length === 1) return vivos[0].person_id;
  return null;
}

function saveResponses_(p) {
  // KAL-4: derive authorised group_id from resume_token; never trust the
  // payload's enrollment_group_id directly. Cross-check inside the helper.
  const enrollmentGroupId = requireResumeToken_(p);
  // CLI 26 (2026-06-01) — reject responses for submitted/abandoned groups.
  assertGroupEditable_(enrollmentGroupId);
  // DL-E39 step-up gate: las respuestas del cuestionario son PII del expediente.
  // enrollmentGroupId viene del resume_token (KAL-4), nunca del payload.
  // ②24: y la marca tiene que ser DEL BUZÓN que opera, no de cualquiera del expediente.
  assertStepUpFresh_(enrollmentGroupId, _identidadDelEnlace_(p, enrollmentGroupId), _huellaDePagina_(p));
  _wzCacheInvalidate_(p && p.resume_token); // WIZARD-CACHE: NUNCA servir stale tras un write del grupo
  // ★ SEC-STEPUP (finding #55): NO re-extender la ventana por uso (P-STEPUP-SLIDING retirado — convertía 10 min en infinitos → bypass del PII-gate en recarga).
  const { respondent_id, respondent_type_category_id, responses } = p;
  if (!responses || !responses.length) return { saved: 0 };

  // KAL-4 PER-FILA (RESP-FIX 2026-06-08): las respuestas son per-participante — cada
  // fila lleva su propio `r.respondent_id` (el applicant). Validamos que CADA
  // respondent distinto del group_id (top-level + por fila) pertenezca al grupo del
  // token. El grupo SIEMPRE se deriva del resume_token (enrollmentGroupId), NUNCA del
  // payload.
  //
  // ②17 (décimo tramo, 2026-08-15): el conjunto autorizado ya NO se arma aquí bajando la
  // ficha COMPLETA de cada persona del expediente —MENORES INCLUIDOS: nombre, fecha de
  // nacimiento, documento— a este proceso público y anónimo solo para quedarse con sus
  // identificadores. Lo sirve el KMS proyectado a ids, con el MISMO recorrido que aplica el
  // escritor. La validación de forma (KAL-5 capa 1) y el rechazo se quedan aquí, verbatim.
  var distinctRespondents = {};
  if (respondent_id && respondent_id !== enrollmentGroupId) distinctRespondents[respondent_id] = true;
  responses.forEach(function(r) {
    var rid = r && r.respondent_id;
    if (rid && rid !== enrollmentGroupId) distinctRespondents[rid] = true;
  });
  var respList = Object.keys(distinctRespondents);
  if (respList.length) {
    respList.forEach(function(rid) { assertValidUuid_(rid, 'respondent_id'); });  // KAL-5 capa 1
    var validPersonIds = _respondentesAutorizados_(p && p.resume_token);
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

  // DL-E49 §1 — QUIÉN contesta viaja aparte de DE QUIÉN es cada respuesta. Se resuelve
  // aquí, server-side, desde el enlace del tutor; el KMS lo re-valida contra el grupo.
  // Se resuelve UNA vez: lo usan la comprobación de abajo y el propio envío al KMS.
  const tutorQueContesta = wizardTutorQueOpera_(p, enrollmentGroupId);

  // ── ②24.sexies · SI ESTAS RESPUESTAS NO SE VAN A GUARDAR, SE DICE ────────────────────
  //
  // El KMS ya tiene la regla (DL-E49 §6): el tutor que YA envió su parte no sigue
  // rellenando — `enr_persistResponses_` devuelve `{responses:0,
  // skipped_already_submitted:true}` y NO escribe nada.
  //
  // El problema no era la regla: era que el asistente NO SE ENTERABA, y encima MENTÍA.
  // Medido contra `origin/main` el 2026-08-10: (a) la llamada al KMS se hacía sin recoger
  // su respuesta y se devolvía `{saved: N}` a pelo, así que el asistente afirmaba haber
  // guardado N respuestas que el KMS había descartado; (b) `skipped_already_submitted` no
  // aparecía NI UNA vez en todo este repositorio; y (c) —lo que decide el diseño de este
  // arreglo— `enr.wizardSaveResponses` **ENCOLA** el trabajo y contesta
  // `{ok:true, queued:true}` (`kis-app kms-server/enr/wizard-gateway.gs:236`), de modo que
  // ese aviso lo produce el trabajador de la cola MUCHO DESPUÉS y **nunca puede llegar en
  // la respuesta**. Recoger el retorno, por sí solo, no habría enterado a nadie.
  //
  // Por eso se PREGUNTA antes, y se pregunta con lo que YA existe: `enr.wizardEstadoDeLasPartes`
  // es una lectura SÍNCRONA cuyo propósito declarado es exactamente éste — «¿puede este
  // tutor seguir rellenando?» (`wizard-gateway.gs:736`) — y el asistente ya la consume en la
  // pantalla de confirmación. No se construye mecanismo nuevo: se usa el que estaba puesto.
  //
  // KAL-4 intacta: el expediente sale del `resume_token` y la persona por la que se pregunta
  // se resuelve SERVER-SIDE desde el enlace del tutor (nunca del cuerpo); el KMS la
  // re-valida contra los tutores declarados de ese expediente.
  if (_parteDeEsteTutorYaEnviada_(p, tutorQueContesta)) {
    const err = new Error('Este tutor ya envió su parte: sus respuestas del cuestionario no se guardan');
    err.code = 'PARTE_YA_ENVIADA';   // doPost → HTTP 200 {ok:false,error:{code,message}}
    Logger.log(redact_('[saveResponses_] rechazo: la parte de este tutor ya está enviada (DL-E49 §6)'));
    throw err;
  }

  const respuestaKms = kmsProxy_('enr.wizardSaveResponses', {
    resume_token:           p.resume_token,
    answered_by_person_id:  tutorQueContesta,
    responses:              outResponses,
  }) || {};

  // Defensa en profundidad: si algún día el endpoint deja de encolar y responde en el acto,
  // su descarte llega por aquí y se propaga IGUAL. Hoy no puede pasar (encola), y por eso
  // NO es la comprobación principal — es el respaldo, no la puerta.
  if (respuestaKms.skipped_already_submitted) {
    const err = new Error('Este tutor ya envió su parte: sus respuestas del cuestionario no se guardan');
    err.code = 'PARTE_YA_ENVIADA';
    throw err;
  }

  // NO se dice «guardadas»: el KMS las ENCOLA y las escribe después. `saved: N` era una
  // afirmación que este código no está en condiciones de hacer — y era falsa entera cuando
  // el KMS las descartaba. Se dice lo que de verdad consta: cuántas se aceptaron para
  // guardar, y si el servidor confirmó haberlas puesto en cola.
  //
  // 18.bis.84 — y se devuelve el identificador del trabajo apuntado, que es lo único que
  // permite preguntar DESPUÉS cómo acabó. La comprobación de arriba solo caza lo que ya
  // consta ANTES de encolar; lo que el trabajador descarte al ejecutarse solo se sabe
  // preguntando por este identificador.
  return {
    encoladas: outResponses.length,
    queued:    respuestaKms.queued === true,
    job_id:    respuestaKms.job_id || null,
  };
}

/**
 * ②24.sexies · ¿LA PARTE DE ESTE TUTOR YA ESTÁ ENVIADA?
 *
 * Proxy fino a la lectura que YA existe (`enr.wizardEstadoDeLasPartes`, la misma que usa
 * `estadoDeLasPartes_` para la pantalla de confirmación). El asistente no calcula nada: la
 * regla vive en el KMS, que es donde están los datos.
 *
 * DEGRADA HACIA GUARDAR, siempre. Sin tutor identificado devuelve `false` (el KMS tampoco
 * cierra a nadie que no consta), y si la lectura falla devuelve `false`: un dato que no se
 * puede consultar NO puede convertir esto en un asistente que se niega a guardar. El suelo
 * sigue siendo la regla del KMS — esto solo sirve para poder DECÍRSELO a la familia.
 *
 * @param {Object} p payload del manejador (lleva `resume_token`).
 * @param {string|null} personId tutor que opera, YA resuelto server-side (KAL-4).
 * @returns {boolean} true solo si consta que ese tutor ya envió su parte.
 * @private
 */
function _parteDeEsteTutorYaEnviada_(p, personId) {
  if (!personId) return false;
  try {
    const estado = kmsProxy_('enr.wizardEstadoDeLasPartes', {
      resume_token: p.resume_token,
      person_id:    personId,
    }) || {};
    return estado.ya_envio === true;
  } catch (e) {
    Logger.log(redact_('[_parteDeEsteTutorYaEnviada_] no se pudo comprobar — se sigue guardando: ' + e.message));
    return false;
  }
}

/*
 * ── EL TIPO DE DOCUMENTO LO PONE EL CATÁLOGO, NO EL CLIENTE (2026-08-04) ──────────────
 *
 * Aquí vivían `REC_TYPE_BY_DOCUMENT_TYPE` (seis tipos tasados escritos a mano) y su
 * lectura inversa `_docTypeFromRecType_`. Los DOS quedan ELIMINADOS, y no por limpieza:
 * el mapa era el defecto.
 *
 * Medido en la corrida del robot del 2026-08-04, desde el navegador:
 *     ✗ el servidor RECHAZÓ uploadDocument — [INVALID_REC_TYPE]
 *       El tipo de documento "OTHER" no está entre los que la familia puede aportar…
 *       Permitidos: APPLICATION_DOCUMENTATION
 * La pantalla dejaba adjuntar el archivo y dejaba avanzar; el servidor lo tiraba. Para la
 * familia, un documento que cree haber entregado y que NO está.
 *
 * La causa exacta: desde WIZARD-DOCS (2026-06-13) el paso 6 es un **adjuntador genérico**
 * —la familia describe en texto libre qué es cada archivo y NO elige tipo
 * (`Step6Documents.jsx`, `gasCall('uploadDocument', …)` sin `document_type`)—, así que
 * `document_type` llegaba SIEMPRE `undefined` y el respaldo `|| 'OTHER'` inventaba un
 * código que **no existe en el catálogo del tenant**. Un respaldo escrito a mano no es una
 * red: es una invención que el catálogo no tiene por qué respaldar.
 *
 * Quien decide es `recTypes_T`, y lo resuelve el KMS en un solo sitio
 * (`enr_wizardPersistUpload` → `rec_resolveInterestedPartyType_`, DL-R16): **ninguno**
 * marcado como aportado por la familia ⇒ error que dice qué configurar; **uno** ⇒ lo asigna
 * el servidor; **varios** ⇒ **elige la familia**. En los tres casos el tipo sale del catálogo
 * del tenant, y ninguno es un default silencioso.
 *
 * ★ 18.bis.35 (2026-08-16) — EL TERCER CASO YA TIENE PANTALLA, Y ANTES NO LA TENÍA. Este
 * bloque decía «ahora el wizard **no manda tipo**», y con eso el caso de varios tipos estaba
 * ROTO de punta a punta: el KMS lanzaba `REC_TYPE_REQUIRED` («la subida tiene que decir
 * cuál») y el asistente no tenía forma de decirlo ⇒ ninguna familia podía adjuntar nada en
 * cuanto el centro marcaba un segundo tipo. Hoy el paso 6 pregunta **qué es** cada archivo
 * con las opciones que el propio KMS manda en las listas (`recTypesInterestedParty`), y la
 * respuesta viaja en `rec_type_code`. El asistente sigue sin elegir, sin listar códigos a
 * mano y sin respaldo: solo transporta lo que contestó la familia.
 */

/**
 * Accepts a base64-encoded file, saves to Drive, writes a recFiles row.
 *
 * DL-R09 / DL-R13: documents now live in the rec* module (canonical):
 *   - recFiles row with status='ACTIVE', origin='WIZARD',
 *     origin_reference=enrollment_group_id (so submit can find pre-submit
 *     uploads of this session). El `rec_type_code` viaja SOLO cuando la familia
 *     lo eligió en el paso 6 (a partir del segundo tipo marcado «lo aporta la
 *     familia»); el asistente nunca lo decide ni lo inventa, y quién es
 *     admisible lo dice el catálogo del tenant dentro del KMS (DL-R16) — ver el
 *     bloque «EL TIPO DE DOCUMENTO LO PONE EL CATÁLOGO» aquí arriba.
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
 *                       base64, mimeType, filename, description?,
 *                       upload_idempotency_token? }
 * @returns {{ file_id: string, document_id: string }}
 *   (document_id is a legacy alias = file_id, kept for frontend compat)
 *   CLI 82 / KAL-NEW-5: drive_url removed — read-back is served on-demand via
 *   getDocument_ (proxy de bytes), never a public Drive link.
 */
/**
 * 18.bis.95 · ¿LA FICHA DEL DOCUMENTO QUEDÓ ESCRITA?
 *
 * A diferencia de los seis guardados que ENCOLAN (18.bis.84), `enr.wizardPersistUpload` es
 * SÍNCRONO: escribe `recFiles` y `recScopes` en el acto y **dice cómo le fue** —
 * `{ok:true, file_persisted, scope_persisted, file_id}` (`kis-app kms-server/enr/
 * wizard-gateway.gs:567`, `:586`, `:590`). Hasta hoy el asistente tiraba esa respuesta y
 * confirmaba igual. Los bytes SÍ están en Drive (los sube este mismo fichero, antes de
 * llamar al KMS), pero **sin la ficha, el documento no existe para nadie**: no lo ve el
 * colegio ni la familia al recargar. Confirmarlo era la mentira.
 *
 * DOS CASOS, y NO son el mismo — de ahí dos códigos:
 *   · `file_persisted !== true` → la ficha NO se escribió (rechazo silencioso P72). El
 *     documento no consta en ninguna parte ⇒ **volver a subirlo es lo correcto**.
 *   · `scope_persisted === false` → la ficha SÍ está (el colegio la ve por el expediente),
 *     pero **no quedó enganchada al alumno**. Volver a subir crearía un duplicado, así que
 *     el texto NO invita a reintentar: pide avisar al colegio.
 *
 * `scope_persisted === null` (o ausente) NO es un fallo: es que no se intentó ningún
 * enganche. Es el caso NORMAL de la familia — `recScopeRow` solo se construye cuando llega
 * `enrollment_id`, que hoy no manda ningún cliente vivo (medido el 2026-08-10:
 * `frontend/src/pages/steps/Step6Documents.jsx:66` no lo envía) porque los enganches los
 * materializa `submitEnrollmentSession_` al enviar.
 *
 * FALLA HACIA CERRADO A PROPÓSITO: si la respuesta no trae `file_persisted`, tampoco consta
 * que se escribiera, y confirmar sería exactamente el defecto que esto quita. El KMS lo
 * devuelve SIEMPRE en su único camino de éxito (los demás lanzan, y `kmsProxy_` propaga).
 *
 * @param {Object} respuestaKms lo que devolvió `enr.wizardPersistUpload`.
 * @returns {?{code: string, message: string}} null si la ficha consta escrita y enganchada.
 * @private
 */
function _veredictoDeLaSubida_(respuestaKms) {
  var r = respuestaKms || {};
  if (r.file_persisted !== true) {
    return {
      code: 'DOCUMENTO_NO_REGISTRADO',
      message: 'El archivo se subió pero no quedó registrado en la solicitud: vuelve a intentarlo.',
    };
  }
  if (r.scope_persisted === false) {
    return {
      code: 'DOCUMENTO_SIN_VINCULAR',
      message: 'El documento se guardó pero no se pudo asociar a la solicitud. No lo vuelvas a subir: avisa al colegio.',
    };
  }
  // DL-R17 — TERCER caso, y por la MISMA razón que los dos de arriba: con el archivo por
  // fecha, de quién es el documento no se deduce de dónde está guardado — solo consta si esa
  // fila se escribió (DL-R20). Si la familia dijo «este es el informe de Lucía» y ese vínculo
  // no quedó, el documento está pero no significa nada, y confirmarlo sería la misma mentira.
  // Volver a subirlo DUPLICARÍA (la ficha sí está) ⇒ el texto pide avisar al colegio.
  // `personas_pedidas === 0` es el caso normal de «de la solicitud»: no hay nada que fallar.
  if (r.personas_pedidas > 0 && r.personas_persisted !== r.personas_pedidas) {
    return {
      code: 'DOCUMENTO_SIN_DUENO',
      message: 'El documento se guardó pero no ha quedado registrado de quién es. No lo vuelvas a subir: avisa al colegio.',
    };
  }
  return null;
}

/**
 * DL-R17 · DE QUIÉN ES ESTE DOCUMENTO — y la REGLA DE REPARTO POR DEFECTO, en el servidor.
 *
 * El paso 6 pregunta de quién es cada archivo: **de la solicitud**, o de **una o varias
 * personas concretas** de la solicitud. Con el archivo por fecha (DL-R01), esa declaración es
 * el ÚNICO mapa que dice a quién pertenece el papel (DL-R20): sin ella el fichero existe y no
 * significa nada.
 *
 * ⛔ **LOS DOCUMENTOS SIN PERSONA ASIGNADA VAN AL TUTOR QUE LOS SUBIÓ.** Es la regla de reparto
 * por defecto, DECLARADA: no se quedan sin dueño ni se etiquetan en todos. Y vive AQUÍ, en el
 * servidor, no en el navegador — un cliente que no mande el campo (o una versión vieja de la
 * pantalla en la pestaña de alguien) obtiene exactamente el mismo reparto.
 *
 * «De la solicitud» es una respuesta EXPLÍCITA, no la ausencia de respuesta: llega como
 * `de_quien = 'SOLICITUD'` y significa «no lo cuelgues de ninguna persona». Sus etiquetas son
 * las del expediente, que estampa el envío (`submitEnrollmentSession_`). Por eso NO se le
 * aplica el reparto por defecto: la familia ya contestó.
 *
 * Quién es «el tutor que lo subió» lo resuelve el ÚNICO resolvedor que ya existe
 * (`wizardTutorAtribuible_` → `_identidadDelEnlace_` → `resolveGuardianForRecovery_`), en su
 * modo SIN respaldo (②24.bis): esto ATRIBUYE un documento a una persona, y el respaldo «el
 * tutor 1» atribuiría a un tutor un papel que subió otro. Si de verdad no consta quién opera,
 * el documento se queda como «de la solicitud» —que es lo que pasaba hasta hoy— y se REGISTRA;
 * inventar un dueño sería peor que no tenerlo.
 *
 * @param {Object} p payload del manejador (`de_quien`, `person_ids`, resume_token, `n`…).
 * @param {string} groupId expediente YA autorizado (derivado del token — KAL-4).
 * @returns {string[]} person_id de los dueños declarados. Vacío = «de la solicitud».
 * @private
 */
function _duenosDelDocumento_(p, groupId) {
  const pedidas = Array.isArray(p && p.person_ids) ? p.person_ids.filter(Boolean).map(String) : [];
  if (pedidas.length) return pedidas;
  // Respuesta explícita «de la solicitud» ⇒ no se cuelga de nadie, y el reparto NO se aplica.
  if (p && String(p.de_quien || '') === 'SOLICITUD') return [];
  const tutor = wizardTutorAtribuible_(p, groupId);
  if (!tutor) {
    Logger.log(redact_('[_duenosDelDocumento_] no consta quién opera y no se declaró dueño: ' +
      'el documento queda como «de la solicitud» (DL-R17) — no se inventa un dueño.'));
    return [];
  }
  return [tutor];
}

/**
 * DL-R16 · QUÉ ES EL DOCUMENTO — la respuesta que la familia dio en el paso 6, validada.
 *
 * Quien MANDA es el catálogo del centro, y lo resuelve el KMS en un solo sitio
 * (`rec_resolveInterestedPartyType_`): con **0** tipos marcados «lo aporta la familia» la
 * subida se rechaza con un error que NOMBRA qué configurar; con **1** lo asigna el servidor
 * («un desplegable de una opción no es elección», DL-R16) y la pantalla no pregunta nada; **a
 * partir del segundo elige la familia**, y entonces su respuesta TIENE que viajar — si no
 * viaja, el KMS rechaza con `REC_TYPE_REQUIRED` y el archivo se queda fuera.
 *
 * ⛔ Aquí NO se elige el tipo, ni se ofrece lista, ni hay respaldo: eso sería volver a decidir
 * en el cliente lo que decide el catálogo, que es exactamente el defecto que borró `'OTHER'`
 * (ver el bloque «EL TIPO DE DOCUMENTO LO PONE EL CATÁLOGO»). Lo único que pasa aquí es la
 * validación de FORMA (KAL-5 capa 1), para no gastar un viaje con basura; QUÉ códigos son
 * admisibles lo dice el KMS contra la lista viva del centro, y su rechazo es el suelo.
 *
 * La forma admitida es la MISMA que la de un identificador de fichero legible
 * (`^[A-Za-z0-9._-]{1,128}$`, sin comillas ⇒ no rompe el Selector de AppSheet). Los códigos de
 * fábrica son MAYÚSCULAS_CON_GUION_BAJO, pero el centro puede dar de alta el suyo y el KMS **no
 * le impone forma alguna** (medido el 2026-08-16: `rec_upsertRecType` solo exige que el código
 * exista y no colisione) — un validador más estricto aquí dejaría a una familia sin poder subir
 * un documento por un código perfectamente válido de su colegio. Mismo precedente que
 * `assertValidFileIdForRead_` (F-17·#10).
 *
 * @param {Object} p payload del manejador.
 * @returns {string|null} el código elegido, o `null` si la familia no eligió (0 ó 1 opción).
 * @private
 */
function _tipoDeDocumentoElegido_(p) {
  const raw = p && p.rec_type_code;
  if (raw == null || raw === '') return null;   // no eligió ⇒ lo resuelve el catálogo, en el KMS
  const v = String(raw).trim();
  if (!/^[A-Za-z0-9._-]{1,128}$/.test(v)) {
    const err = new Error('Invalid rec_type_code: ' + JSON.stringify(raw));
    err.code = 'BAD_REQUEST';
    throw err;
  }
  return v;
}

function uploadDocument_(p) {
  // KAL-4: derive authorised group_id from resume_token; never trust the
  // payload's enrollment_group_id directly. Cross-check inside the helper.
  //
  // ★ `0º.quindecies` hallazgo (2) (2026-08-23) — LOS DOS DISCRIMINADORES DE LA COMPROBACIÓN
  // PREVIA SE PREPARAN AQUÍ, ANTES DE LA PUERTA, para que viajen pegados a ella. Son cálculo
  // PURO (leer el cuerpo y, si falta, acuñar una marca): no leen nada y no deciden nada.
  //
  // ⛔ NO SE VALIDA LA FORMA AQUÍ, y es deliberado: `assertValidUuid_` sigue donde estaba, más
  // abajo, para que el orden de los rechazos no cambie ni un ápice (hoy un `resume_token`
  // malformado se rechaza ANTES que un `enrollment_id` malformado, y así se queda). Lo que se
  // hace es NO PLEGAR lo que no tiene forma de UUID: si no la tiene, la comprobación se pide
  // aparte como siempre y el `assertValidUuid_` de abajo la rechaza igual.
  const idempotencyToken = p.upload_idempotency_token || generateUuid_();
  const enrollmentId     = p.enrollment_id || null;
  const _pareceUuid_ = function(v) { return !!v && /^[0-9a-fA-F-]{36}$/.test(String(v)); };
  const plegableSubida = (!enrollmentId || _pareceUuid_(enrollmentId)) && _pareceUuid_(idempotencyToken)
    ? { enrollment_id: enrollmentId || null, upload_idempotency_token: idempotencyToken }
    : null;

  const enrollmentGroupId = requireResumeToken_(p, { comprobarSubida: plegableSubida });
  // CLI 26 (2026-06-01) — reject uploads for submitted/abandoned groups.
  // The `enrollmentId` branch below covers post-submit uploads where a
  // specific enrollment is targeted; if that enrollment exists, the group
  // must NOT be in submitted state for the family to keep editing documents.
  // KMS-driven uploads bypass this endpoint entirely.
  assertGroupEditable_(enrollmentGroupId);
  // DL-E39 step-up gate: subir documentos del expediente es PII sensible.
  // enrollmentGroupId viene del resume_token (KAL-4), nunca del payload.
  // ②24: la marca tiene que ser del buzón que opera.
  assertStepUpFresh_(enrollmentGroupId, _identidadDelEnlace_(p, enrollmentGroupId), _huellaDePagina_(p));
  _wzCacheInvalidate_(p && p.resume_token); // WIZARD-CACHE: NUNCA servir stale tras un write del grupo
  // ★ SEC-STEPUP (finding #55): NO re-extender la ventana por uso (P-STEPUP-SLIDING retirado — convertía 10 min en infinitos → bypass del PII-gate en recarga).
  const { base64, mimeType, filename } = p;
  if (!base64) throw new Error('Missing base64');
  // WIZARD-DOCS (2026-06-13): adjuntador genérico. La familia describe en texto
  // libre qué es cada archivo ("informe médico", "documento personal"…). No hay
  // tipos tasados obligatorios. KAL-5: sanitizamos el texto (tope 200 chars,
  // sin CR/LF para no contaminar logs — KAL-11). Se guarda en recFiles.description.
  // appsheetEscape_ se aplica más abajo SOLO si llega a un Filter (aquí no — va a
  // un Add como valor de columna; AppSheet API v2 parametriza el body JSON).
  let uploadDescription = (typeof p.description === 'string') ? p.description : '';
  uploadDescription = uploadDescription.replace(/[\r\n\t]+/g, ' ').trim().slice(0, 200);
  // 18.bis.35 — QUÉ tipo de documento dijo la familia que es. Describir no es clasificar: la
  // casilla de texto de arriba no le asigna al papel ni su nivel de confidencialidad ni sus
  // etiquetas; el TIPO sí, y es lo único que decide quién puede verlo (DL-R16 + DL-R07).
  // Se valida la FORMA aquí y se decide el código en el catálogo, dentro del KMS.
  const tipoDeDocumento = _tipoDeDocumentoElegido_(p);
  if (enrollmentId) assertValidUuid_(enrollmentId, 'enrollment_id');

  // KAL-5: idempotency token is server-generated UUID by default; if the
  // frontend supplied one, it must match UUID shape.
  // (Se acuña arriba, antes de la puerta, para poder plegar la comprobación previa — ver el
  // bloque `0º.quindecies` del principio. La validación se queda AQUÍ, en su orden de siempre.)
  assertValidUuid_(idempotencyToken, 'upload_idempotency_token');

  // ②17 — LAS DOS COMPROBACIONES PREVIAS LAS HACE EL KMS, en una sola pregunta.
  //
  // Antes eran dos lecturas de AppSheet desde aquí: (1) ¿el expediente de alumno es de esta
  // familia? (KAL-4, sobre `enrEnrollments`) y (2) ¿este mismo envío ya se había guardado?
  // (idempotencia, sobre `recFiles`). Las dos las sirve ahora `enr.wizardComprobarSubida`,
  // con los MISMOS filtros, para que este proceso —público y anónimo— deje de necesitar la
  // credencial de AppSheet de la aplicación entera.
  //
  // Los dos fallos NO pesan igual, y se tratan igual que antes:
  //   · con `enrollment_id`, no poder comprobarlo ⇒ NO se sube (es una comprobación de
  //     acceso; antes la lectura de AppSheet también lanzaba si se caía).
  //   · sin `enrollment_id`, lo único en juego es la idempotencia ⇒ se sigue subiendo, que
  //     es lo que hacía el `catch (_)` de siempre. Como mucho se repite un documento.
  //
  // ★ `0º.quindecies` hallazgo (2) (2026-08-23) — Y AHORA LA RESPUESTA YA ESTÁ AQUÍ, sin un
  // segundo viaje. La puerta de arriba la trajo pegada a la cabecera (molde DL-E57), porque
  // `enr.comprobarSubidaDeDocumento` re-resolvía la sesión ENTERA desde cero para contestar
  // lo que la puerta acababa de contestar. **LA DECISIÓN NO SE MUEVE**: los dos fallos se
  // siguen pesando exactamente igual, unas líneas más abajo de donde se pesaban.
  //
  // ⛔ Si por lo que sea NO viene plegada (el KMS no la mandó, o los discriminadores no tenían
  // forma de UUID), se pide APARTE como siempre. Nunca se da por buena una comprobación de
  // acceso que no se ha hecho.
  let yaSubido = null;
  const plegada = plegableSubida
    ? _SUBIDA_MEMO_[_memoSubidaClave_(p.resume_token, plegableSubida)]
    : null;
  try {
    const previo = plegada || (kmsProxy_('enr.wizardComprobarSubida', {
      resume_token:             p.resume_token,
      enrollment_id:            enrollmentId || null,
      upload_idempotency_token: idempotencyToken,
    }) || {});
    if (previo && previo.ok === false) {
      // El KMS CONTESTÓ que no. Se re-lanza con su código para que el `catch` de abajo aplique
      // la MISMA decisión que aplicaba cuando esto era una llamada aparte.
      const eNo = new Error(previo.error || 'No se pudo comprobar el envío previo');
      eNo.code = previo.code || '';
      throw eNo;
    }
    yaSubido = (previo && previo.ya_subido) || null;
  } catch (eComprobar) {
    if (enrollmentId) throw eComprobar;   // fail-closed: la comprobación de acceso manda
    Logger.log(redact_('[uploadDocument_] no se pudo comprobar el envío previo — se sube igual: ' +
      ((eComprobar && eComprobar.message) || eComprobar)));
  }
  if (yaSubido && yaSubido.file_id) {
    return {
      file_id:     yaSubido.file_id,
      document_id: yaSubido.file_id, // legacy alias
    };
  }

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
  //
  // 0º.undevicies (2026-08-21) — la carpeta la DICE el KMS, no este proceso.
  // Antes: getOrCreateDriveFolder_(DRIVE_FOLDER_NAME) creaba (o encontraba) una
  // carpeta suelta en el Drive de la cuenta que publicó el asistente, fuera del
  // árbol único del archivo de registros (`rec_carpetaDelDia_`) que ya usa TODO
  // lo que genera el KMS. Quién ESCRIBE no cambia (el asistente sigue creando
  // el fichero, con su propia credencial de Drive); quién DECIDE, sí.
  // Si el KMS no puede decir la carpeta (REC_ARCHIVE_ROOT_NOT_CONFIGURED), NO
  // SE SUBE: el error se propaga tal cual — guardar en un sitio inventado es
  // peor que no guardar (`rec/archivo.gs`, kis-app).
  const carpeta = kmsProxy_('enr.carpetaDelArchivo', { resume_token: p.resume_token });
  const blob   = Utilities.newBlob(decoded, mimeType, filename);
  const folder = DriveApp.getFolderById(carpeta.folder_id);
  const file   = folder.createFile(blob);

  const driveFileId   = file.getId();
  const fileId        = generateUuid_();
  const now           = new Date().toISOString();

  // ── recFiles row (DL-R09) — P1-A: metadata VERBATIM; la escribe el KMS ───────
  // El BLOB ya está en Drive (arriba, wizard-side con el scope drive); aquí solo se
  // construye la fila de metadata (mismas columnas) que persistirá el KMS.
  const recFileRow = {
    file_id:                  fileId,
    school_id:                SCHOOL_ID,
    // QUÉ ES EL DOCUMENTO — la respuesta de la familia, CUANDO la hubo (18.bis.35, DL-R16).
    // Va solo si eligió, y solo se le pregunta a partir del SEGUNDO tipo marcado «lo aporta
    // la familia»: con 0 ó 1 no viaja nada y lo resuelve el catálogo del centro dentro del
    // KMS (`enr_wizardPersistUpload` → `rec_resolveInterestedPartyType_`), igual que hasta
    // hoy. Lo que NO puede pasar es que el asistente elija por su cuenta o invente un código
    // de respaldo — eso es lo que el servidor rechazaba con [INVALID_REC_TYPE].
    ...(tipoDeDocumento ? { rec_type_code: tipoDeDocumento } : {}),
    drive_file_id:            driveFileId,
    drive_folder_id:          folder.getId(),
    file_name:                filename,
    original_filename:        filename,
    mime_type:                mimeType,
    file_size_bytes:          blob.getBytes().length,
    // `file_hash_sha256` es REQUERIDA en recFiles: mandarla en `null` (o no mandarla)
    // hace que AppSheet rechace la fila ENTERA con HTTP 400 y `db_insert` lance
    // DB_ERROR — es decir, TODA subida de documento de una familia fallaba. Medido el
    // 2026-08-02 con `manual_capturarErrorSubida` (kis-app), columna a columna.
    // Se calcula aquí porque es aquí donde están los bytes: `decoded` ya pasó el límite
    // de tamaño y la comprobación de número mágico, así que es exactamente el
    // contenido que se acaba de subir a Drive.
    file_hash_sha256:         sha256Hex_(decoded),
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
  };

  // ── Primary scope (only if we already have an enrollment_id) ───────────────
  // Pre-submit uploads (enrollment_id == null) defer scopes to submitEnrollmentSession_.
  const recScopeRow = enrollmentId ? {
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
  } : null;

  // ── P1-A: recFiles + recScope → KMS (único escritor). El wizard anónimo ya NO
  // escribe recFiles/recScopes directo. KAL-4: grupo del resume_token; school_id +
  // origin_reference forzados server-side. Síncrono (mirror de enr_persistDocument_).
  // DL-R17 — DE QUIÉN es el documento. La regla de reparto por defecto ya se aplicó arriba
  // (`_duenosDelDocumento_`, en el servidor). El KMS comprueba que cada persona es de ESTE
  // expediente (KAL-4) y escribe una fila de `recScopes` por cada una.
  const duenos = _duenosDelDocumento_(p, enrollmentGroupId);

  const persistencia = kmsProxy_('enr.wizardPersistUpload', {
    resume_token:        p.resume_token,
    rec_file:            recFileRow,
    rec_scope:           recScopeRow,
    rec_scope_personas:  duenos,
  });

  // 18.bis.95 — LA RESPUESTA DEL KMS SE MIRA. Este endpoint es SÍNCRONO y dice si la ficha
  // quedó escrita; tirar ese dato y devolver `{file_id}` era confirmarle a la familia una
  // subida que podía no constar en ninguna parte. El veredicto vive en UN solo sitio
  // (`_veredictoDeLaSubida_`), que es también el que distingue los dos casos.
  const problemaDeLaSubida = _veredictoDeLaSubida_(persistencia);
  if (problemaDeLaSubida) {
    Logger.log(redact_('[uploadDocument_] ' + problemaDeLaSubida.code +
      ' — la ficha del documento no consta escrita en el KMS (file_persisted=' +
      String(persistencia && persistencia.file_persisted) + ', scope_persisted=' +
      String(persistencia && persistencia.scope_persisted) + ')'));
    const errSubida = new Error(problemaDeLaSubida.message);
    errSubida.code = problemaDeLaSubida.code;   // doPost → HTTP 200 {ok:false,error:{code,message}}
    throw errSubida;
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
        const effEmail = effectiveRecoveredEmail_(p && p.resume_token, p && p.recovered_email, p && p.n);
        const guardianId = effEmail ? resolveGuardianForRecovery_(p && p.resume_token, effEmail) : null;
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
        // ②17: las filas de firma las sirve el KMS, acotadas al expediente del token.
        // Sin ellas → null, y el llamante degrada igual que antes (no hay PDF de firma
        // que servir por esta vía).
        const firmaDoc = _datosDeFirmaDelExpediente_(p && p.resume_token);
        const sctxSign = firmaDoc
          ? resolveGuardianSigningContext_(groupId, guardianId, firmaDoc.sessions, firmaDoc.signersBySession)
          : null;
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
  // ②24: la marca tiene que ser del buzón que opera.
  assertStepUpFresh_(groupId, _identidadDelEnlace_(p, groupId), _huellaDePagina_(p));
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
  // ②17: la fila la sirve el KMS (`enr.wizardFicheroDelExpediente`), con el MISMO filtro
  // —`file_id` + `origin_reference` = el expediente del token— y proyectando solo los
  // cuatro campos que hacen falta para servir los bytes. Así este proceso —público y
  // anónimo— deja de leer `recFiles` con la credencial de AppSheet de la aplicación entera.
  //
  // Se distinguen las DOS respuestas, y la diferencia importa: «no está» sigue cayendo al
  // camino del paquete de firma (que es lo que hacía antes), mientras que «no se pudo
  // preguntar» LANZA — como lanzaba la lectura de AppSheet si se caía. Degradar un fallo a
  // «no está» le contestaría «no es tuyo» a una familia que sí es la dueña del documento.
  const consulta = _ficheroDelExpediente_(p && p.resume_token, fileId);
  if (!consulta.ok) {
    const errLect = new Error('No se pudo leer el documento del expediente.');
    errLect.code = 'INTERNAL_ERROR';
    throw errLect;
  }
  const row = consulta.fila;
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

/**
 * LA VERJA PÚBLICA — el ÚNICO sitio donde se decide si una llamada ANÓNIMA puede
 * hacer trabajo caro (leer expedientes, mandar correo, crear una solicitud).
 *
 * Por qué existe en un solo sitio: este backend es `ANYONE_ANONYMOUS`, así que
 * TODA su superficie pública comparte el mismo problema, y hasta el 2026-08-09
 * la comprobación estaba COPIADA en dos manejadores (`initEnrollmentSession_` y
 * `recognizeFamily_`) y AUSENTE en el tercero (`sendMagicLink_`, rama pública) —
 * que es justamente la puerta de recuperación. Tres copias divergen; una sola no.
 *
 * FAIL-CLOSED, igual que las dos copias que sustituye (KAL-NEW-4): sin
 * `RECAPTCHA_SECRET` configurado NO se pasa (nunca se degrada a bypass), sin
 * token NO se pasa, y un fallo de red al verificar tampoco pasa.
 *
 * Devuelve un VEREDICTO en vez de lanzar, porque los tres llamantes tienen
 * contratos distintos: dos propagan el error (el cliente lo pinta) y el tercero
 * NO puede propagarlo — cualquier diferencia visible en su respuesta reabre el
 * oráculo de enumeración que `_magicLinkConstantAck_()` cierra (WIZ-ENUM).
 *
 * @param {?string} recaptchaToken token v3 que envió el cliente (puede faltar)
 * @returns {{ok: boolean, code: ?string, message: ?string}}
 * @private
 */
function _verjaPublicaVeredicto_(recaptchaToken) {
  var secret = PropertiesService.getScriptProperties().getProperty('RECAPTCHA_SECRET');
  if (!secret) {
    return { ok: false, code: 'RECAPTCHA_NOT_CONFIGURED', message: 'reCAPTCHA not configured — contact admin' };
  }
  if (!recaptchaToken) {
    return { ok: false, code: 'RECAPTCHA_MISSING', message: 'Missing reCAPTCHA token' };
  }
  var rc;
  try {
    rc = verifyRecaptcha_({ token: recaptchaToken });
  } catch (e) {
    // Fallo de red / respuesta ilegible de Google → NO se pasa (fail-closed).
    return { ok: false, code: 'RECAPTCHA_FAILED', message: 'reCAPTCHA verification failed' };
  }
  if (!rc || !rc.pass) {
    return { ok: false, code: 'RECAPTCHA_FAILED', message: 'reCAPTCHA verification failed' };
  }
  return { ok: true, code: null, message: null };
}

/**
 * Envoltorio que LANZA — para los manejadores públicos cuyo contrato SÍ propaga
 * el error al cliente (`initEnrollmentSession_`, `recognizeFamily_`). Conserva
 * literalmente los mensajes y el `err.code` que esos dos ya devolvían, para no
 * cambiar lo que ve el frontend.
 *
 * @param {?string} recaptchaToken
 * @private
 */
function _asegurarVerjaPublica_(recaptchaToken) {
  var v = _verjaPublicaVeredicto_(recaptchaToken);
  if (v.ok) return;
  var err = new Error(v.message);
  if (v.code === 'RECAPTCHA_NOT_CONFIGURED') err.code = 'RECAPTCHA_NOT_CONFIGURED';
  throw err;
}

// ─── Step save helpers ────────────────────────────────────────────────────────


// NOTE: saveRelations_ DELETED 2026-06-26 (P280 dead-code). It had ZERO callers
// in the wizard — the live relations path moved to the KMS: saveStep_ → case
// 'relations' → kmsProxy_('enr.wizardSaveRelations', …). The local function was
// self-contained dead code (sysPersonRelations bidirectional insert lived here
// pre-DL-C migration). History preserved in git.

// NOTE: saveHealth_ DELETED 2026-07-12 (P1-B dead-code). It had ZERO callers —
// the live health path moved to the KMS: saveStep_ → case 'health' →
// kmsProxy_('enr.wizardSaveHealth', …) → enr_persistHealth_ (KMS is the single
// writer). The local function still wrote DIRECTLY to enrPersonFoodAllergies /
// enrPersonDietaryRequirements / enrPersonMedicalConditions (last direct enr*
// health writes in this backend). History preserved in git.

/**
 * NEAE staging capture — Paso 4 "Salud y apoyo" (DL-E16 append-only).
 *
 * Espejo del capture de salud del wizard, adaptado a NEAE (Necesidades
 * Específicas de Apoyo Educativo, RGPD Art. 9). Escribe SOLO a las tablas
 * staging `enrPersonNeae` + `enrPersonNeaeSupport` (nunca al core — el KMS
 * promociona a `neaeConditionsLog`/`neaeSupportLog` en otra ola). La familia es
 * anónima y sin identidad legal en el wizard → la declaración se captura como
 * borrador SIN firma; la atestación ocurre en la firma de matrícula (design §3).
 *
 * Seguridad (mismas capas que los demás handlers de mutación):
 *   - KAL-4 IDOR: `enrollment_group_id` derivado del `resume_token`, NUNCA del
 *     payload; cada `person_id` se valida contra las personas del grupo del token.
 *   - Edit-lock: `assertGroupEditable_` rechaza grupos ya enviados/abandonados.
 *   - KAL-5: `assertValidUuid_` + `appsheetEscape_` en todo filtro.
 *   - KAL-11: logs redactados (`redact_`).
 *
 * Código defensivo (Diego 2026-06-06 / P72): las tablas staging pueden no existir
 * todavía en AppSheet. Los writes se envuelven en try/catch — una tabla ausente
 * o un silent reject se LOGUEA (redactado) y degrada sin romper el flujo de la
 * familia y SIN fingir éxito de fila. La falta de tabla NO bloquea el paso.
 *
 * @param {Object} p - { resume_token, neae: [ { person_id, conditions:[…], supports:[…], source_locale } ] }
 */
function saveNeae_(p) {
  // KAL-4: derive the authorised group_id from resume_token; never trust the
  // payload's enrollment_group_id. The KMS re-derives the group from the token too.
  const enrollmentGroupId = requireResumeToken_(p);

  // Edit-lock defense in depth: a submitted/abandoned group is not editable by
  // the family. Throws Error{code:'NOT_EDITABLE'} → doPost maps to HTTP 200
  // {ok:false,error} (P72 structured reject, never HTTP 403).
  assertGroupEditable_(enrollmentGroupId);

  // ★ SEC WIZ-NEAE (audit 2026-07-22): los datos NEAE son PII de salud sensible del
  // menor — exigen step-up fresco (DL-E39), en paridad EXACTA con el case 'health'
  // de saveStep_ (que ya gatea persons/relations/health). Sin este gate un
  // resume_token filtrado podía escribir/enriquecer NEAE sin probar posesión del
  // buzón. KAL-4: enrollmentGroupId derivado del token, nunca del payload.
  // ②24: la marca tiene que ser del buzón que opera.
  assertStepUpFresh_(enrollmentGroupId, _identidadDelEnlace_(p, enrollmentGroupId), _huellaDePagina_(p));
  _wzCacheInvalidate_(p && p.resume_token); // WIZARD-CACHE: no servir stale tras un write del grupo

  const neaeData = Array.isArray(p && p.neae) ? p.neae
                 : (p && p.neae && Array.isArray(p.neae.neae) ? p.neae.neae : []);
  if (!Array.isArray(neaeData) || !neaeData.length) {
    // Nada que encolar ⇒ no hay trabajo por el que preguntar (18.bis.84).
    return { saved: true, step: 'neae', job_id: null };
  }

  // THIN-CLIENT (2026-07-12): la escritura del staging NEAE vive en el KMS (único
  // escritor con auth+validación) — espejo EXACTO del proxy de salud del case
  // 'health' de saveStep_. El wizard YA NO escribe enrPersonNeae/Support directo:
  // proxea al endpoint del KMS, que re-deriva el grupo del resume_token (KAL-4),
  // valida person∈grupo, y persiste append-only (DL-E16). Cero writes locales.
  const respuestaKms = kmsProxy_('enr.wizardSaveNeae', {
    resume_token: p.resume_token,
    neae:         neaeData,
  }) || {};

  // 18.bis.84 — igual que los demás guardados: el KMS APUNTA el trabajo y lo hace después,
  // así que este `saved: true` solo dice «aceptado», nunca «escrito». El identificador es
  // lo único que permite preguntar más tarde cómo acabó.
  return { saved: true, step: 'neae', job_id: respuestaKms.job_id || null };
}

// ENR-E6 (2026-06-06): saveInterviews_ + case 'interviews' eliminados del
// dispatcher anónimo. Las entrevistas son KMS staff-side (DL-E19), NO un step
// canónico del wizard (los 11 steps no incluyen 'interviews'); la función no
// tenía callers (0 hits frontend) y, bajo manifest ANYONE_ANONYMOUS, todo case
// es superficie de ataque sin auth. Paridad con la limpieza de case 'review'
// (KAL-NEW-3). Las entrevistas se gestionan en el KMS sobre tablas core.

// ─── Email helpers ────────────────────────────────────────────────────────────

// EMAIL-MIGRATION-2 (2026-06-25): sendInternalEmail_ ELIMINADO. Las 2 notificaciones
// staff-internas que lo usaban (sesión iniciada + magic-link no solicitado) pasaron al
// motor único del KMS vía sendViaKmsNotify_ (plantillas kis-tpl-wizard-session-started /
// kis-tpl-wizard-unsolicited-reported), y NO vuelven: aquí no se construye texto de correo.
// ★ 2026-08-19 (①51): lo que sí volvió es el TRANSPORTE — `sendAsAlias_`, para que el correo
// salga con el alias del colegio en vez de con la cuenta que publicó el KMS. Esta línea
// decía «el wizard ya NO envía email localmente» y era la que quedaba desfasada.

// NOTA (WIZARD-TERMINAL P3, 2026-06-25; ACTUALIZADA 2026-08-08): sendMagicLinkEmail_,
// sendMagicLinkMultiEmail_ y sendFamilyConfirmationEmail_ FUERON ELIMINADAS. El bloque GDPR /
// la lista multi-link / la tabla de solicitantes se pre-renderizan en helpers _kmsRender*_
// (junto a sendViaKmsNotify_).
//
// OJO — esta nota decia que el KMS gobierna "esos 3 emails + la notificacion interna de
// submit" via sendViaKmsNotify_, y se leia como si el wizard siguiera pidiendo la
// confirmacion a la familia. NO la pide. Desde el 2026-08-07 el wizard solo manda los
// CUATRO avisos de sendViaKmsNotify_ (los dos magic-link a la familia + los dos internos a
// admisiones) y el codigo de un solo uso; la lista exacta esta en el JSDoc de
// sendViaKmsNotify_. La confirmacion a la familia y los avisos del expediente los decide la
// configuracion del centro en el motor de avisos del KMS, a partir de los hitos.

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


// ─── AppSheet API helper ──────────────────────────────────────────────────────

/**
 * Parte una expresión por el operador dado, pero SOLO al NIVEL SUPERIOR: ignora los que
 * caen dentro de paréntesis o dentro de una cadena entrecomillada.
 *
 * Partir por texto plano (un `split('&&')`) rompería dos cosas reales de este backend:
 * los filtros que agrupan alternativas entre paréntesis —`(a || b) && c`, que hay— y
 * cualquier valor que contenga `&&` dentro de las comillas.
 *
 * @param {string} expr
 * @param {string} op  '&&' o '||'
 * @returns {string[]} las partes, sin espacios sobrantes y sin vacíos
 */
function wizardPartirNivelSuperior_(expr, op) {
  var partes = [], nivel = 0, comilla = false, actual = '';
  for (var i = 0; i < expr.length; i++) {
    var c = expr.charAt(i);
    if (c === '"') comilla = !comilla;
    if (!comilla) {
      if (c === '(') nivel++;
      if (c === ')') nivel--;
      if (nivel === 0 && expr.substr(i, op.length) === op) {
        partes.push(actual); actual = ''; i += op.length - 1; continue;
      }
    }
    actual += c;
  }
  partes.push(actual);
  return partes
    .map(function (p) { return p.trim(); })
    .filter(function (p) { return p.length; });
}

/**
 * Traduce un filtro estilo SQL al lenguaje de expresiones de AppSheet.
 *
 *   "columna" = "valor"   →   [columna] = "valor"
 *   a && b                →   AND(a, b)          ← FUNCIÓN, no infijo
 *   a || b                →   OR(a, b)
 *   true / false          →   TRUE / FALSE
 *
 * ── POR QUÉ ESTO NO ES UN `.replace(/&&/g,'AND')` (medido, 2026-08-03) ────────────────
 * Durante mucho tiempo lo fue, y producía `[a] = "x" AND [b] = "y"`. En AppSheet `AND` es
 * una FUNCIÓN, no un operador infijo, y esa forma **no da error**: se queda con la PRIMERA
 * condición y **descarta el resto en silencio**. Medido contra AppSheet real, sin margen:
 *
 *   · `recFiles` con `school_id` como primera condición → devolvía las 23 filas VIVAS DE LA
 *     ESCUELA (21 familias distintas) para un expediente que tenía 3. Cada familia recibía
 *     los documentos de todas las demás.
 *   · `enrEnrollmentGroups` con el email como primera condición → sin fuga (el email acota),
 *     pero las guardas se caían: `email` solo → 1 fila · `email && NOT(ISBLANK(submitted_at))
 *     && ISBLANK(abandoned_at)` infijo → 1 · la misma con `AND()` → 0. Es decir, un grupo
 *     ABANDONADO o SIN ENVIAR se trataba como «ya enviada» en `initEnrollmentSession_`.
 *
 * Un filtro inválido devolvería 0 y saltaría a la vista el primer día; éste devolvía de MÁS
 * o de menos sin quejarse. Por eso vivió tanto.
 *
 * Comprobado por `scripts/comprobar-selector-appsheet.mjs` (trabajo de integración continua),
 * que ejecuta esta misma función aislada. La batería de navegador NO cubre esto: corre contra
 * un backend simulado y nunca llega a construir un Selector.
 *
 * @param {string} filtro
 * @returns {string} la expresión en el lenguaje de AppSheet
 */
function wizardTraducirFiltro_(filtro) {
  function conv(expr) {
    expr = String(expr).trim();
    // Quita un paréntesis envolvente redundante — pero solo si de verdad envuelve al TODO.
    if (expr.charAt(0) === '(' && expr.charAt(expr.length - 1) === ')') {
      var dentro = expr.slice(1, -1);
      if (wizardPartirNivelSuperior_(dentro, '&&').length +
          wizardPartirNivelSuperior_(dentro, '||').length >= 2) expr = dentro;
    }
    var ands = wizardPartirNivelSuperior_(expr, '&&');
    if (ands.length > 1) return 'AND(' + ands.map(conv).join(', ') + ')';
    var ors = wizardPartirNivelSuperior_(expr, '||');
    if (ors.length > 1) return 'OR(' + ors.map(conv).join(', ') + ')';
    return expr
      .replace(/"(\w+)"\s*(=|!=|<=|>=|<|>)/g, '[$1] $2')
      .replace(/\btrue\b/g, 'TRUE')
      .replace(/\bfalse\b/g, 'FALSE');
  }
  return conv(filtro);
}

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
      const expr = wizardTraducirFiltro_(selector.Filter);
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

// ─── appsheetRequestBatch_ — RETIRADO (②17, 2026-08-16) ──────────────────────
// El transporte en LOTE a AppSheet se ELIMINA: el decimotercer tramo de ②17 (el pulso de la
// admisión) se llevó a su ÚLTIMO llamante, y este proceso es PÚBLICO Y ANÓNIMO. No era solo
// código muerto — era un escritor GENÉRICO (Add/Edit/Delete sobre CUALQUIER tabla, con la
// credencial dentro) esperando a que alguien lo llamase, en el mismo fichero donde el
// invariante es que el asistente NO ESCRIBE NUNCA en AppSheet (§"El wizard NO escribe
// NINGUNA tabla AppSheet"). Lo vestigial se elimina en cuanto se detecta.
//
// Su nombre SÍ sobrevive en los tres controles del repositorio —escrituras-directas,
// personas-quitadas y verja-publica— y es DELIBERADO: ahí no es una exención que sobre, es
// la vigilancia de que no vuelva. El código retirado está en git.

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
 * ②17 (decimocuarto tramo, 2026-08-16) — LECTOR ÚNICO de la resolución del token de firma.
 *
 * Le pide al KMS `enr.resolveSigningToken` —ruta que YA existía y YA está declarada
 * `'public'` (`kis-app kms-server/_api.gs:75` + `:1265`, *«token-gated; signer may be a
 * family/external party»*)— lo que este fichero resolvía por su cuenta con SEIS lecturas
 * directas a AppSheet desde un proceso público y anónimo:
 *   · `sysSigningSessionSigners` + `sysSigningSessions` (`resolveSigningToken_`), y
 *   · `sysMilestones` + `sysMilestoneTypes`, DOS VECES, en los ayudantes de hitos
 *     `isMilestoneCompleted_` / `isDurableSigningMilestoneCompleted_`, hoy RETIRADOS.
 *
 * El comentario del bloque retirado se declaraba a sí mismo **«espejo VERBATIM del lector
 * canónico del KMS»** ⇒ eran DOS lectores del mismo dato, que es exactamente el anti-patrón
 * que §"Regla — refactors preservan el código probado" prohíbe. **PROHIBIDO escribir un
 * segundo**: la resolución de la firma se pide aquí y solo aquí.
 *
 * ⛔ **NO se manda ningún identificador de expediente ni el nombre de ninguna tabla.** El
 * bearer que viaja es el `signing_token`, que es la identidad de este camino (no hay
 * `resume_token` del que derivar nada: quien firma llega por su propio token). El KMS
 * resuelve firmante, sesión y expediente server-side desde la fila del token.
 *
 * ⚠️ **Devuelve TRES cosas, y hay que respetarlo** (mismo criterio que `_expedienteDelToken_`
 * y `_ficheroDelExpediente_`, que distinguen sus fallos):
 *   · `{ok:true,  resolucion:<obj>}`  → la respuesta del KMS, tal cual (válida o no válida:
 *     un `{valid:false, reason:'EXPIRED'}` es una RESPUESTA, no una avería).
 *   · `{ok:false, motivo:<msg>}`      → **no se pudo preguntar** (transporte: el KMS no
 *     responde, no está configurado, o devuelve algo ilegible).
 *
 * **Y esto CORRIGE el oro, a propósito.** El bloque retirado convertía un fallo de lectura
 * de AppSheet en `{valid:false, reason:'INVALID'}` ⇒ la familia leía *«tu enlace de firma no
 * vale»* cuando la verdad era que la base de datos no contestaba. Los dos caminos son
 * igual de CERRADOS (ninguno deja pasar a nadie), pero solo uno **nombra** el problema —
 * §"Falla hacia cerrado y NOMBRANDO". Mismo precedente que `KMS_UNREACHABLE` en la puerta.
 *
 * @param {string} token  el `signing_token` YA validado de forma por `assertValidSigningToken_`
 * @returns {{ok:boolean, resolucion:(Object|null), motivo:(string|null)}}
 * @private
 */
function _resolucionDelTokenDeFirma_(token) {
  try {
    var r = kmsProxy_('enr.resolveSigningToken', { signing_token: String(token).trim() }) || {};
    return { ok: true, resolucion: r, motivo: null };
  } catch (e) {
    var msg = (e && e.message) || String(e);
    Logger.log(redact_('[_resolucionDelTokenDeFirma_] no se pudo preguntar al KMS — ' + msg));
    return { ok: false, resolucion: null, motivo: msg };
  }
}

/**
 * Valida el `signing_token` de un tutor contra `sysSigningSessionSigners` y resuelve el
 * estado de su sesión de firma. Idempotente — solo lectura.
 *
 * ②17 (decimocuarto tramo, 2026-08-16): **ya NO lee AppSheet.** Lo resuelve el KMS por el
 * lector ÚNICO `_resolucionDelTokenDeFirma_` (ver su cabecera). Lo que se queda AQUÍ —y
 * hay que conservarlo— es la **validación de forma** del token (P211: acepta UUID v4 con
 * guiones Y `dashless` de 32 hex, porque el KMS emite los suyos así) y el **recorte de
 * `signing_url`**, que se explica abajo.
 *
 * ⛔ **`signing_url` SE RECORTA AQUÍ, en el CONSUMIDOR — y no es un detalle de estilo.**
 * El KMS SÍ lo devuelve, y hace bien: esa misma ruta la usa el panel del KMS, donde la URL
 * del proveedor es legítima. Pero CLI 81 / S5 / KAL-NEW-1 cerró que **la resolución
 * PRE-AUTENTICACIÓN no revele la URL materializada del proveedor con solo el bearer**;
 * devolverla desde aquí REABRIRÍA esa mitigación. La URL sigue llegando SOLO por
 * `initiateSigningSession_` (`session.signerUrls`), una vez el tutor ya está dentro del
 * paso S-SIGN y el token ya salió de la barra de direcciones (S4). `SigningSteps.jsx` lee
 * `signerUrls` de ahí, nunca de esta función — verificado CLI 81.
 *
 * ⭐ **Y esto arregla CUATRO divergencias medidas contra `origin/master` el 2026-08-16**,
 * todas a favor de la familia:
 *   1. **El ancla de la sesión (DL-S105 §10).** Desde ese cambio la sesión cuelga del
 *      EXPEDIENTE del alumno, no de la solicitud. El KMS traduce con el lector único
 *      `enr_signingGroupIdForSession_` antes de buscar los hitos durables; aquí se usaba
 *      `session['entity_id']` **crudo** ⇒ al tutor que YA consintió y YA revisó **se le
 *      volvía a pedir todo, cada vez**.
 *   2. **El tipo de expediente (DL-E48).** Estaba escrito a mano (`ENR_ADMISSION_SCHOOL`);
 *      el KMS usa la clase que la propia sesión de firma ya lleva escrita ⇒ en un
 *      campamento se buscaba el hito bajo una clase que no es la suya.
 *   3. **`gdpr_blocked`** se devolvía `false` a pelo («deferred per roadmap §4.5»); el KMS
 *      lo CALCULA contra `sysConsentsLog`. Cambia el comportamiento, a mejor.
 *   4. **El plazo y la invalidación por estado**: el KMS aplica el vencimiento de la sesión
 *      (`expires_at`) y el rol `INVALIDATES_SIGNING_TOKENS` del catálogo del colegio, que
 *      aquí no existían — solo se miraban tres códigos escritos a mano.
 *
 * Per roadmap §4.2 (wizard-admissions-roadmap.md) + DL-E24 §6.
 *
 * @param {{ signing_token: string }} p
 * @returns {{ valid: true, signer_id, session_id, enrollment_group_id,
 *             guardian_person_id, signer_role, signer_status, steps }
 *        | { valid: false, reason: 'INVALID'|'EXPIRED'|'REVOKED', state?: string }}
 * @throws code='KMS_UNREACHABLE' si no se pudo PREGUNTAR (transporte) — nunca se disfraza
 *         de «token inválido».
 */
function resolveSigningToken_(p) {
  if (!p || !p.signing_token) throw new Error('signing_token required');

  const token = String(p.signing_token).trim();

  // Auditoría: solo el prefijo (KAL-11) — nunca el token entero.
  Logger.log('[resolveSigningToken_] attempt token=' + token.substring(0, 8) + '...');

  // P211: el KMS emite signing_tokens dashless (32-hex); el layout estricto UUID-v4
  // (KAL-5) los rechazaba todos. assertValidSigningToken_ acepta v4-con-guiones Y
  // dashless 32-hex (sigue hex-only). Se conserva AQUÍ: rechazar la forma antes de
  // gastar un viaje al KMS es lo mismo que hacía antes de gastar una lectura.
  try {
    assertValidSigningToken_(token, 'signing_token');
  } catch (_) {
    Logger.log('[resolveSigningToken_] token format invalid');
    return { valid: false, reason: 'INVALID' };
  }

  const r = _resolucionDelTokenDeFirma_(token);
  if (!r.ok) {
    // No se pudo PREGUNTAR. Decirle a un tutor legítimo que su enlace de firma no vale
    // porque el KMS está caído es peor que el fallo: se nombra.
    const errK = new Error('No se pudo resolver el token de firma: ' + (r.motivo || 'KMS no disponible'));
    errK.code = 'KMS_UNREACHABLE';
    throw errK;
  }

  const res = r.resolucion || {};
  if (!res.valid) {
    const reason = res.reason || 'INVALID';
    Logger.log('[resolveSigningToken_] invalid token: ' + reason);
    const fuera = { valid: false, reason: reason };
    if (res.state) fuera.state = res.state;
    return fuera;
  }

  Logger.log(redact_('[resolveSigningToken_] valid=true signer=' + (res.signer_id || '') +
    ' group=' + (res.enrollment_group_id || '')));

  const steps = res.steps || {};
  return {
    valid:               true,
    signer_id:           res.signer_id           || null,
    session_id:          res.session_id          || null,
    enrollment_group_id: res.enrollment_group_id || null,
    guardian_person_id:  res.guardian_person_id  || null,
    signer_role:         res.signer_role         || null,
    signer_status:       res.signer_status       || null,
    steps: {
      billing_confirmed: !!steps.billing_confirmed,
      gdpr_completed:    !!steps.gdpr_completed,
      gdpr_blocked:      !!steps.gdpr_blocked,
      review_completed:  !!steps.review_completed,
      signed:            !!steps.signed,
    },
    // `signing_url` NO se copia — ver el ⛔ de la cabecera (CLI 81 / S5 / KAL-NEW-1).
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
// WIZ-ENUM residual (verificación 2026-07-28): actions ANÓNIMOS cuya propiedad de
// seguridad ES la respuesta CONSTANTE (anti-enumeración KAL-10). Para ellos el trace
// `_dbg` NO se activa NUNCA, aunque el caller lo pida: la LISTA DE EVENTOS delata el
// camino tomado y reabre justo el oráculo que cierra `_magicLinkConstantAck_`. Medido
// en producción: un email CON grupo emite `kms_call enr.wizardTouchSession` +
// `kms_call sys-public.sendNotification`; uno SIN grupo emite solo los dos Find. Es
// decir, `{"_dbg":true}` convertía el ack constante en un oráculo de existencia
// legible por cualquiera desde internet.
var DBG_ENUM_SENSITIVE_ACTIONS_ = ['sendMagicLink', 'recognizeFamily', 'reportUnsolicited'];

function _dbgStart_(payload) {
  var action = payload && payload.action;
  var sensitive = DBG_ENUM_SENSITIVE_ACTIONS_.indexOf(String(action)) !== -1;
  DBGT_.on = !!(payload && payload._dbg === true) && !sensitive;
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

  // ── El salto se REINTENTA, y por eso el `requestId` NO cambia entre intentos ──
  //
  // MEDIDO el 2026-08-04 contra el `/exec` del KMS (8 peticiones seguidas): **2 de 8**
  // devolvieron una página de Google —la de identificarse, y la de Drive con 404— en
  // vez del JSON. Es el segundo tramo del doble salto de una web app de GAS (el `echo`),
  // y **releerlo NO recupera**: 3 relecturas de cada `Location:` fallido dieron otra vez
  // la página. Lo que sí recupera es **repetir la petición**.
  //
  // Repetirla era inaceptable —la acción YA se ejecutó cuando el `echo` falla, así que un
  // reintento de `enr.wizardCreateSession` crearía DOS expedientes y uno de
  // `sys-public.sendNotification` mandaría DOS correos—, así que primero se arregló el
  // otro lado: el `doPost` del KMS guarda su respuesta bajo el `requestId` y un POST
  // repetido con el MISMO `requestId` **devuelve la guardada sin re-ejecutar nada**
  // (`kis-app/kms-server/_index.gs`, caché `xsreq_`, 10 min). Por eso el sobre se arma
  // FUERA del bucle: reusar el `requestId` es lo que hace seguro el reintento.
  //
  // Solo se reintenta lo que NO se pudo LEER (respuesta no-JSON o HTTP ≠ 200). Un error
  // de negocio del KMS llega en JSON y se propaga tal cual, sin repetirse.
  //
  // Lo que la familia veía sin esto: «tu enlace no funciona» (rebote a la portada con
  // `resume_error=1`) cuando el que falló fue el transporte, no su expediente.
  const KMS_INTENTOS = 3;
  let status = 0;
  let text   = '';
  let resp   = null;
  let ultimoFallo = null;   // {codigo, mensaje} del último intento ilegible
  for (let intento = 1; intento <= KMS_INTENTOS; intento++) {
    let httpResp;
    _dbgEv_('kms_call', action + (intento > 1 ? ' (reintento ' + intento + ')' : ''));
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
      ultimoFallo = { codigo: 'KMS_NETWORK_ERROR', mensaje: 'KMS proxy network error: ' + netErr.message };
      httpResp = null;
    }
    if (httpResp) {
      PERF2_.kms_fetch_ms = Date.now() - perfFetchT0; // PERF-KMS2 (KAL-11: solo ms)
      _dbgEv_('kms_resp', action + ' ' + PERF2_.kms_fetch_ms + 'ms');
      Logger.log('[PERF] kmsProxy_ action=' + action + ' fetch_ms=' + PERF2_.kms_fetch_ms);
      status = httpResp.getResponseCode();
      text   = httpResp.getContentText();
      if (status !== 200) {
        ultimoFallo = { codigo: 'KMS_HTTP_ERROR', mensaje: 'KMS proxy HTTP ' + status + ': ' + redact_(text.slice(0, 200)) };
      } else {
        try {
          resp = JSON.parse(text);
          ultimoFallo = null;
          break;                                   // se leyó la respuesta: se acabó
        } catch (parseErr) {
          ultimoFallo = { codigo: 'KMS_BAD_RESPONSE', mensaje: 'KMS proxy non-JSON response: ' + redact_(text.slice(0, 200)) };
        }
      }
    }
    Logger.log('[kmsProxy_] transporte ilegible en el intento ' + intento + '/' + KMS_INTENTOS +
               ' de ' + action + ' — ' + (ultimoFallo && ultimoFallo.codigo));
    if (intento < KMS_INTENTOS) Utilities.sleep(1200);
  }
  if (ultimoFallo) {
    const err = new Error(ultimoFallo.mensaje);
    err.code = ultimoFallo.codigo;
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
 * Envía HTML desde el alias admissions@ por el servicio avanzado de Gmail (RFC822 crudo).
 * Usa SOLO el permiso `gmail.send` — evita la escalada al permiso de Settings que
 * `GmailApp.sendEmail` dispara al mandar desde un alias que no es el primario.
 * La línea en blanco que separa cabeceras y cuerpo es explícita (no filtrada) para que
 * Gmail localice el cuerpo correctamente.
 *
 * ★ RESTAURADA 2026-08-19 (①51 opción A). Es el MISMO código que funcionó hasta `9544b50`
 * (2026-06-26), recuperado de git y copiado VERBATIM — no se rediseña lo que ya estaba
 * probado (§"Regla — refactors preservan el código probado"). Lo ÚNICO que cambia respecto
 * a entonces es de dónde salen el asunto y el cuerpo: ya no los construye el asistente,
 * se los pide al KMS (`sys-public.renderNotification`), y el nombre visible con la dirección
 * de respuesta vienen en esa misma respuesta.
 *
 * POR QUÉ AQUÍ Y NO EN EL KMS: este proyecto es `executeAs: USER_DEPLOYING` ⇒ **el único
 * que consiente sus permisos es quien publica**. El KMS es `USER_ACCESSING` + `ANYONE` ⇒
 * ahí lo consentiría cada familia y cada profesor que entra, y subiría el listón de
 * verificación de la aplicación. `gmail.send` es un permiso **SENSIBLE** («Send email on
 * your behalf»), no restringido: el apagón del 2026-06-25 lo causaron permisos
 * RESTRINGIDOS, que un no-owner no puede consentir ⇒ concesión PARCIAL. Eso aquí no aplica.
 *
 * @param {string} toEmail
 * @param {string} subject
 * @param {string} htmlBody
 * @param {string} [replyTo]
 * @param {string} [fromName]  nombre visible; si falta, el del centro por defecto.
 */
function sendAsAlias_(toEmail, subject, htmlBody, replyTo, fromName) {
  // DBG-TRACE: duración del envío de email (Gmail alias / fallback MailApp).
  var _dbgM0 = Date.now();
  _dbgEv_('mail_send', 'start');
  var nombreVisible = fromName || FROM_NAME;
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
      'From: ' + nombreVisible + ' <' + ADMISSIONS_EMAIL + '>',
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
    return 'ALIAS';
  } catch (aliasErr) {
    Logger.log(redact_('[sendAsAlias_] alias send FAILED (' + (aliasErr && aliasErr.message) +
      ') — falling back to MailApp deployer account for to=' + toEmail));
    try {
      MailApp.sendEmail({
        to: toEmail,
        subject: subject,
        htmlBody: htmlBody,
        name: nombreVisible,
        ...(replyTo ? { replyTo: replyTo } : {}),
      });
      Logger.log(redact_('[sendAsAlias_] sent via MailApp fallback to=' + toEmail));
      return 'REPLIEGUE';
    } catch (fallbackErr) {
      Logger.log(redact_('[sendAsAlias_] BOTH alias and MailApp send failed for to=' + toEmail +
        ' — alias:' + (aliasErr && aliasErr.message) + ' fallback:' + (fallbackErr && fallbackErr.message)));
      const err = new Error('Email could not be delivered (alias + fallback both failed)');
      err.code = 'EMAIL_SEND_FAILED';
      throw err;
    }
  }
}

/**
 * @private Firma y llama a una de las rutas de correo del KMS. UN solo sitio arma el
 * contrato canónico { template_code, recipient, context, nonce, timestamp, signature }
 * con canonical = template_code\nrecipient\nJSON.stringify(context)\nnonce\ntimestamp
 * (idéntico a `notify-public.gs`) — antes estaba copiado en las dos funciones de envío, y
 * dos copias del mismo cálculo divergen.
 *
 * Fail-closed: sin NOTIFY_HMAC_SECRET en Script Properties → throw NOTIFY_NOT_CONFIGURED.
 * KAL-11: NO loguea el context (PII) ni el código de un solo uso.
 *
 * @param {string} accion        p.ej. 'sys-public.renderNotification'.
 * @param {string} templateCode
 * @param {string} recipient
 * @param {Object} context       lo que se FIRMA (va tal cual en la petición).
 * @param {Object} [extra]       campos adicionales NO firmados (p.ej. el parte de entrega).
 */
function _kmsCorreoFirmado_(accion, templateCode, recipient, context, extra) {
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
  return kmsProxy_(accion, Object.assign({
    template_code: templateCode,
    recipient:     recipient,
    context:       context,
    nonce:         nonce,
    timestamp:     ts,
    signature:     sig,
  }, extra || {}));
}

/**
 * @private EL ÚNICO camino por el que sale un correo de este proyecto: pide el texto al
 * KMS, lo envía con el alias del colegio, y —salvo el código de un solo uso— le devuelve al
 * KMS el parte de lo que pasó para que quede constancia de qué se le mandó a esa familia.
 *
 * Son DOS llamadas porque **el resultado solo se conoce después de enviar**: una fila que
 * dijera «enviado» antes de enviar sería mentira. El texto NO vuelve a cruzar la red en la
 * segunda — el KMS lo guarda bajo el `correlation_id`, así que el rastro es exactamente lo
 * que él renderizó.
 *
 * Si el PARTE falla, el recorrido de la familia NO se rompe (el correo ya salió) pero se
 * registra en claro que **el aviso SÍ salió y no queda constancia de qué se mandó** — misma
 * redacción que usa el KMS para ese mismo daño (P72).
 *
 * @param {string} templateCode
 * @param {string} recipient
 * @param {Object} context
 * @returns {{ sent: boolean, correlation_id: ?string, logged?: boolean, via?: string }}
 */
function _kmsRenderizarYEnviar_(templateCode, recipient, context) {
  var r = _kmsCorreoFirmado_('sys-public.renderNotification', templateCode, recipient, context);
  if (!r || !r.rendered) {
    var eR = new Error('El KMS no devolvió el texto de la plantilla ' + templateCode);
    eR.code = 'EMAIL_RENDER_FAILED';
    throw eR;
  }

  var via = null, errorEnvio = null;
  try {
    via = sendAsAlias_(recipient, r.subject, r.body, r.reply_to, r.sender_name);
  } catch (envErr) {
    errorEnvio = (envErr && envErr.message) || String(envErr);
  }

  // El código de un solo uso NO se registra (P253): el KMS ni siquiera acepta su parte.
  if (!r.loggable || !r.correlation_id) {
    if (errorEnvio) throw withEmailSendCode_(errorEnvio);
    return { sent: true, correlation_id: null, via: via };
  }

  var logged = false;
  try {
    var res = _kmsCorreoFirmado_('sys-public.logNotificationSent', templateCode, recipient, context, {
      correlation_id: r.correlation_id,
      outcome:        errorEnvio ? 'FAILED' : 'SENT',
      error:          errorEnvio || null,
    });
    logged = !!(res && res.logged);
  } catch (logErr) {
    Logger.log(redact_('[_kmsRenderizarYEnviar_] el aviso SÍ salió, pero no queda constancia de ' +
      'qué se mandó (falló el parte al KMS): ' + ((logErr && logErr.message) || logErr)));
  }
  if (!logged && !errorEnvio) {
    Logger.log(redact_('[_kmsRenderizarYEnviar_] el aviso SÍ salió, pero no queda constancia de ' +
      'qué se mandó (el KMS no pudo escribir el registro) — template=' + templateCode));
  }

  if (errorEnvio) throw withEmailSendCode_(errorEnvio);
  return { sent: true, correlation_id: r.correlation_id, logged: logged, via: via };
}

/** @private Error de envío ya registrado, con su código canónico. */
function withEmailSendCode_(mensaje) {
  var e = new Error(mensaje);
  e.code = 'EMAIL_SEND_FAILED';
  return e;
}

/**
 * Envía una plantilla transaccional. **El TEXTO lo pone el KMS; el ENVÍO lo ejecuta este
 * proyecto** (①51 opción A, 2026-08-19): pide el texto ya renderizado y en el idioma que
 * toque a `sys-public.renderNotification`, lo manda con el alias del colegio
 * (`sendAsAlias_`, permiso **sensible** `gmail.send`) y devuelve el parte a
 * `sys-public.logNotificationSent` para que quede constancia de qué se mandó. Todo eso vive
 * en `_kmsRenderizarYEnviar_` — aquí no hay lógica, para que los siete puntos de llamada no
 * se enteren del cambio.
 *
 * POR QUÉ SALE DE AQUÍ: `MailApp` (lo único que el KMS puede usar) **no admite remitente**,
 * así que su correo sale siempre desde la cuenta que lo publicó. Este proyecto es
 * `executeAs: USER_DEPLOYING` ⇒ el único que consiente sus permisos es quien publica; el KMS
 * es `USER_ACCESSING` + `ANYONE` ⇒ allí el permiso de correo se lo tragaría cada familia.
 * **Lo que NO se mueve es el texto**: plantillas, idioma, marcadores e identidad de correo
 * siguen siendo del KMS, y este proyecto NO vuelve a tener plantillas propias ni HTML inline
 * (eso lo retiró DL-S69 §6 y no vuelve).
 *
 * Fail-closed: sin NOTIFY_HMAC_SECRET en Script Properties → throw NOTIFY_NOT_CONFIGURED;
 * sin texto del KMS → EMAIL_RENDER_FAILED (**no se inventa un cuerpo**); si fallan el alias
 * Y su repliegue → EMAIL_SEND_FAILED, nunca un `{ok:true}` sobre un correo que no salió.
 * KAL-11: NO loguea el context (PII) en claro.
 *
 * LO QUE ESTE FICHERO MANDA DE VERDAD (medido el 2026-08-08 contra origin/main con
 * `grep -oE "sendViaKmsNotify_\('[A-Z_]+'" backend/Code.js | sort -u` — son CUATRO):
 *   · WIZARD_MAGIC_LINK           -> a la familia: el enlace para volver a su solicitud
 *   · WIZARD_MAGIC_LINK_MULTI     -> a la familia: varios enlaces cuando tiene N grupos
 *   · WIZARD_SESSION_STARTED      -> a admisiones (interno): alguien empezo una solicitud
 *   · WIZARD_UNSOLICITED_REPORTED -> a admisiones (interno): enlace reportado como no pedido
 * Mas el codigo de un solo uso (WIZARD_OTP), que va por sendViaKmsAuthCode_, no por aqui.
 *
 * LA CONFIRMACION A LA FAMILIA Y LOS AVISOS DEL EXPEDIENTE NO LOS MANDA EL WIZARD:
 * los gobierna el motor de avisos del KMS a partir de los hitos. `WIZARD_FAMILY_CONFIRMATION`
 * y `WIZARD_INTERNAL_NOTIFICATION` figuraban aqui como valores admitidos hasta el 2026-08-08
 * y NINGUNO tenia ni tiene llamador — el nombre de una plantilla dentro de un comentario NO
 * es un envio. Ese renglon hizo que tres agentes distintos le afirmaran a Diego que el wizard
 * manda la confirmacion de "solicitud recibida"; es falso, y estuvo a punto de frenar un
 * despliegue. Si anades una plantilla, anadela aqui Y comprueba el grep de arriba.
 *
 * @param {string} templateCode  uno de WIZARD_MAGIC_LINK | WIZARD_MAGIC_LINK_MULTI |
 *                               WIZARD_SESSION_STARTED | WIZARD_UNSOLICITED_REPORTED.
 * @param {string} recipient     email destino.
 * @param {Object} context       valores de placeholder (resume_url, gdpr_block, etc.).
 *                               Incluye `lang` — el IDIOMA de la familia. El KMS lo lee
 *                               para elegir la version de la plantilla en ese idioma
 *                               (18.bis.18). Antes no viajaba y por eso la plantilla
 *                               llevaba los dos idiomas dentro del mismo cuerpo.
 * @returns {Object} respuesta del KMS ({ sent, correlation_id }).
 */
function sendViaKmsNotify_(templateCode, recipient, context) {
  Logger.log(redact_('[sendViaKmsNotify_] template=' + templateCode + ' to=' + recipient));
  return _kmsRenderizarYEnviar_(templateCode, recipient, context || {});
}

/**
 * Envía el código de un solo uso. Mismo camino que `sendViaKmsNotify_` —el KMS renderiza,
 * este proyecto envía con el alias— con UNA diferencia que NO es opcional: **el código NO se
 * registra** (P253). El KMS ni siquiera acepta su parte de entrega: la ruta del registro solo
 * admite las plantillas transaccionales, así que `WIZARD_OTP` rebota con BAD_REQUEST. Eso
 * convierte P253 en estructura en vez de una nota al margen — y el texto del código tampoco
 * se guarda a la espera del parte. La generación / cache / cupo del código siguen aquí
 * (lógica de auth); solo el texto y el envío pasan por el otro lado.
 *
 * @param {string} recipient  email destino (primary_email del grupo).
 * @param {Object} context    { OTP_CODE, LANG }.
 * @returns {Object} respuesta del KMS ({ sent }).
 */
function sendViaKmsAuthCode_(recipient, context) {
  // KAL-11: NO loguear el OTP_CODE. Solo el destinatario redactado.
  Logger.log(redact_('[sendViaKmsAuthCode_] OTP to=' + recipient));
  return _kmsRenderizarYEnviar_('WIZARD_OTP', recipient, context || {});
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
  // ★ SEC WIZ-SIGNTOKEN (audit 2026-07-22): step-up fresco OBLIGATORIO antes de
  // persistir datos de firma (paridad con initiateSigningSession_). Un resume_token
  // filtrado NO puede forjar consentimientos/billing sin probar posesión del buzón.
  // enrollment_group_id derivado del token (KAL-4), nunca del payload.
  // ②24: el buzón ya lo resolvió `requireSignerIdentity_` — se reusa, no se vuelve a
  // resolver (dos lectores del mismo dato divergen; y aquí además costaría lecturas).
  assertStepUpFresh_(sctx.enrollment_group_id, sctx.identity && sctx.identity.recovered_email, _huellaDePagina_(p));
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
 * DL-080-A (B1) — Step 8: PRESUPUESTO del borrador + previews de modalidad.
 *
 * Proxy fino a `enr.wizardGetSubscriptionBudget`. El KMS deriva el grupo del
 * `resume_token` (KAL-4) y devuelve el presupuesto REAL del/los borrador(es) —
 * partidas, fechas, importes, descuento, reparto — más el preview read-only de cada
 * modalidad activa del catálogo del tenant. LECTURA → NO invalida caché.
 *
 * El wizard NO calcula dinero: solo formatea `amount_cents/100` (un solo lector,
 * guardarraíl money DL-080-A).
 *
 * @param {Object} p — { resume_token, n?, recovered_email? } o { signing_token }
 * @returns {Object} `data` del KMS — { subscriptions:[…], modalities_available }
 */
function getSubscriptionBudget_(p) {
  // Mismo gate de identidad que las demás LECTURAS del bloque Step 8
  // (getSavedBillingSplits_): el KMS re-valida token/guardián en el proxy.
  const sctx = requireSignerIdentity_(p);
  return kmsProxy_('enr.wizardGetSubscriptionBudget', sctx.identity);
}

/**
 * DL-080-A (B1) — Step 8: APLICA la modalidad elegida por la familia al BORRADOR.
 *
 * Proxy a `enr.wizardApplyModality`. El KMS valida server-side (KAL-4) que la
 * suscripción pertenece al grupo del token, exige estado BORRADOR (si no →
 * `NOT_EDITABLE`), y re-deriva el plan con el motor (`fin_upsertSubscriptionItem`
 * con `modality_id`). Devuelve el presupuesto YA refrescado — el frontend repinta
 * sin segunda llamada.
 *
 * KAL-5 capa 1 wizard-side: los dos UUID se validan ANTES de salir de aquí.
 * ESCRITURA → invalida la caché del grupo (nunca servir stale tras un write).
 *
 * @param {Object} p — { resume_token|signing_token, subscription_id, modality_id }
 * @returns {Object} `data` del KMS — { applied, already?, items_updated, budget }
 */
function applyPaymentModality_(p) {
  p = p || {};
  const subscriptionId = p.subscription_id ? String(p.subscription_id).trim() : '';
  const modalityId     = p.modality_id     ? String(p.modality_id).trim()     : '';
  assertValidUuid_(subscriptionId, 'subscription_id');   // KAL-5 capa 1
  assertValidUuid_(modalityId,     'modality_id');

  const sctx = requireSignerIdentity_(p);
  // ②27 — LA MODALIDAD DE PAGO ES DINERO, Y SU HERMANO DE LA MISMA PANTALLA YA LO PEDÍA.
  // `saveBillingInfo_` (el reparto entre pagadores, mismo paso 8) exige el código de un
  // solo uso desde WIZ-SIGNTOKEN; elegir CÓMO se paga —que re-deriva el plan entero con el
  // motor del KMS— no lo pedía. Un `resume_token` filtrado podía cambiarle el calendario de
  // pagos a una familia sin acreditar el buzón. Puerta copiada literal de
  // `saveBillingInfo_`: el buzón ya lo resolvió `requireSignerIdentity_` y se REUSA (dos
  // lectores del mismo dato divergen, y aquí además costaría lecturas).
  assertStepUpFresh_(sctx.enrollment_group_id, sctx.identity && sctx.identity.recovered_email, _huellaDePagina_(p));
  _wzCacheInvalidate_(p && p.resume_token); // WIZARD-CACHE: nunca stale tras un write

  return kmsProxy_('enr.wizardApplyModality', Object.assign({}, sctx.identity, {
    subscription_id: subscriptionId,
    modality_id:     modalityId,
  }));
}

/**
 * PASO 7 · EL SIMULADOR DE CUOTAS — lectura, orientativa y sin compromiso (Diego 2026-08-19).
 *
 * Cita literal de Diego: «el paso 7 debería mostrar un pequeño simulador de las tarifas que
 * se aplicarían, permitiendo elegir la modalidad de pago. […] Esto no es una elección en
 * firme, es una simulación. La elección en firme se da en el paso 8, porque es la que se va
 * a firmar.»
 *
 * Proxy FINO a `enr.simularCuotas`. El KMS deriva el expediente del `resume_token` (KAL-4),
 * resuelve qué plantilla le toca a cada alumno y ensaya el calendario SIN escribir nada
 * (`fin.previewTemplateSchedule`). **El asistente NO calcula dinero**: pide y formatea
 * `amount_cents/100`, exactamente igual que el paso 8 — un segundo sitio que calculara
 * importes es lo que DL-080-A prohíbe.
 *
 * LECTURA ⇒ no invalida caché. Y **no lleva el código de un solo uso a propósito**: no muta
 * nada y no devuelve ni un dato personal más allá de los identificadores que la propia
 * sesión ya tiene; pedirlo dejaría sin ver sus tarifas a la familia que lleva más de diez
 * minutos repasando su solicitud, que es justo cuando llega al paso 7.
 *
 * ⭐ `0º.vicies.quinquies` (2026-08-22) — CACHE-FIRST, con una comprobación BARATA
 * antes de creerse la caché. El calentado de fondo (`_warmSimularCuotasPhase_`,
 * fase 'sim' del precalentado) suele dejar el resultado listo ANTES de que la
 * familia llegue al paso 7. DOS niveles, del más barato al más caro:
 *
 *   1. **`v` casa** (nada ha escrito en el grupo desde que se cacheó) → la foto es
 *      byte-idéntica a la de hoy: se sirve TAL CUAL, sin ni una llamada más.
 *   2. **`v` no casa** (algo escribió — puede ser una alergia, puede ser el
 *      programa) → se pregunta la HUELLA por el camino barato
 *      (`enr.wizardHuellaDeSimulacion`, que NUNCA ensaya una plantilla). Si casa
 *      con la que se guardó, la simulación sigue siendo la misma — se sirve TAL
 *      CUAL. (Hasta `0º.vicies.sexies` se refrescaba además `preferred_modality_id`;
 *      ese concepto se retiró entero y ya no hay nada que refrescar.)
 *
 * Solo si no hay caché o la huella no casa se paga el cálculo completo —
 * EXACTAMENTE el mismo que hacía esta función antes de hoy.
 *
 * @param {Object} p — { resume_token }
 * @returns {Object} `data` del KMS — { ok, motivo, simulaciones, huella }
 */
function simularCuotas_(p) {
  // KAL-4: el expediente sale del token, nunca del cuerpo. El KMS lo re-deriva igual.
  var groupId = requireResumeToken_(p);
  var token = String(p.resume_token).trim();
  try {
    var cache = CacheService.getScriptCache();
    var raw = _wzCacheGetChunked_(cache, _wzCacheKey_('sim', groupId));
    if (raw) {
      var env = JSON.parse(raw);
      if (env && env.data && env.huella) {
        var liveNow = _getLiveStateVersion_(groupId);
        if (env.v === liveNow) {
          Logger.log('[WZCACHE] HIT sim (sin escrituras) token=' + token.slice(0, 8) + '…');
          return env.data;
        }
        var chequeo = kmsProxy_('enr.wizardHuellaDeSimulacion', { resume_token: token });
        if (chequeo && chequeo.huella && chequeo.huella === env.huella) {
          // ⭐ 0º.vicies.sexies — antes se refrescaba aquí `preferred_modality_id`, el único
          // campo que podía cambiar sin mover la huella. Ese concepto se RETIRÓ ENTERO
          // (la marca de la forma de pago vive ahora solo en el navegador), así que la foto
          // cacheada se sirve TAL CUAL: no queda nada que refrescar.
          var dataFresca = env.data;
          // Se re-archiva con la `v` de ahora para que la PRÓXIMA lectura entre por
          // el nivel 1 (sin ni siquiera preguntar la huella) mientras nada más cambie.
          try {
            _wzCachePutChunked_(cache, _wzCacheKey_('sim', groupId),
              JSON.stringify({ v: liveNow, huella: env.huella, data: dataFresca }), 1800);
          } catch (eRewrite) { /* best-effort */ }
          Logger.log('[WZCACHE] HIT sim (huella casa) token=' + token.slice(0, 8) + '…');
          return dataFresca;
        }
      }
    }
  } catch (eR) { /* degrada al cálculo completo — nunca romper el paso 7 por esto */ }
  return _wzComputeYCachearSimulacion_(groupId, token);
}


/**
 * La familia PIDE CORREGIR una solicitud que ya envió (cola 18.quater, decisión de
 * Diego 2026-08-07, opción C).
 *
 * Hasta hoy, la familia que se equivocaba no tenía ningún botón: tenía que escribir a
 * admisiones y esperar a que alguien del colegio devolviera la solicitud a borrador a
 * mano.
 *
 * Proxy FINO a `enr.wizardRequestCorrection`. El wizard NO decide nada: no mira en qué
 * situación está el expediente, no lo reabre, no manda ningún correo. El KMS completa
 * UNA MARCA —el hecho de que la familia lo pidió— y lo que ocurra después lo declara
 * el colegio con sus avisos automáticos.
 *
 * KAL-4: el grupo lo deriva el KMS del `resume_token`; aquí se valida primero con
 * `requireResumeToken_` (defensa en dos capas, igual que el resto de mutaciones).
 * ESCRITURA ⇒ se invalida la caché del grupo (nunca servir algo viejo tras escribir).
 *
 * El KMS puede responder `requested:false` con un motivo —por ejemplo si el colegio
 * todavía no ha declarado la marca—. Eso se devuelve TAL CUAL: la pantalla tiene que
 * poder decirle a la familia que escriba a admisiones en vez de dejarla esperando un
 * «hecho» que no ha hecho nada.
 *
 * @param {{ resume_token:string, note?:string }} p
 * @returns {{ ok:boolean, requested:boolean, marked:number, reason?:string }}
 */
function requestCorrection_(p) {
  p = p || {};
  requireResumeToken_(p);                    // KAL-4 capa wizard (el KMS re-valida)
  _wzCacheInvalidate_(p.resume_token);       // WIZARD-CACHE: nunca stale tras un write
  return kmsProxy_('enr.wizardRequestCorrection', {
    resume_token: String(p.resume_token),
    note: p.note ? String(p.note).slice(0, 500) : null,
  });
}

/**
 * La familia QUITA de su solicitud algo que ella misma añadió: una persona, un correo, un
 * teléfono, un vínculo o un documento subido.
 *
 * Hasta hoy el asistente sabía añadir y corregir, y NO sabía quitar: este despachador tenía
 * 46 acciones y ninguna borraba. Una familia que metía un tutor por error no podía
 * deshacerlo, y esas personas acababan en el resumen y en el paquete de firma.
 *
 * Proxy FINO a `enr.wizardRetirar`. El wizard NO decide nada: no mira en qué situación está
 * el expediente, no elige qué se puede quitar, no borra nada por su cuenta — y **no escribe
 * en ninguna tabla**, que es la regla de este repositorio desde P1-A/P1-B.
 *
 * KAL-4: el expediente lo deriva el KMS del `resume_token`; aquí se valida primero con
 * `requireResumeToken_`. Lo que se quita viaja IDENTIFICADO en `retirar[]` — nunca «lo que
 * no venga en el mensaje se borra», que con un envío a medias vaciaría el expediente entero.
 *
 * ②27 — y además EXIGE EL CÓDIGO DE UN SOLO USO, en paridad con los manejadores de edición:
 * quitar es destructivo e irreversible para la familia, así que no puede pedir menos que
 * corregir. Ver el cuerpo para por qué NO lleva `assertGroupEditable_`.
 *
 * ESCRITURA ⇒ se invalida la caché del grupo (nunca servir algo viejo tras escribir).
 *
 * La respuesta trae el veredicto DE CADA elemento (`QUITADO` / `YA_ESTABA` / `RECHAZADO` /
 * `NO_SE_PUEDE` / `NO_SE_PUDO`) y, cuando la solicitud ya está enviada, un `bloqueado` con
 * su `mensaje`. Se devuelve TAL CUAL: la pantalla tiene que poder distinguir «se fue» de
 * «no se pudo», porque decirle a una familia que quitó algo que sigue ahí es justo el fallo
 * que esto viene a cerrar.
 *
 * @param {{ resume_token:string, retirar:Array<{clase:string,id:string}> }} p
 * @returns {{ ok:boolean, retirados:number, resultados:Array<Object>,
 *             bloqueado?:string, mensaje?:string }}
 */
function retirarDelExpediente_(p) {
  p = p || {};
  var grupoDeQuitar = requireResumeToken_(p);  // KAL-4 capa wizard (el KMS re-valida)
  // ②27 — DESTRUIR EXIGE LO MISMO QUE CORREGIR. Hasta hoy este manejador llevaba SOLO el
  // token, mientras que cambiar una letra de un nombre (`saveStep_` paso 'persons') sí
  // pedía el código de un solo uso. O sea: con un token observado se podían borrar
  // personas, correos, teléfonos, vínculos y documentos —hasta 50 por llamada— sin
  // acreditar el buzón, y la familia no puede deshacerlo. La puerta es la MISMA que la de
  // los OCHO manejadores que ya la llevaban, copiada literal de `saveStep_`: identidad del enlace
  // (②24 — la marca es del buzón que operó, la de otro tutor no vale) y ventana DURA de
  // 10 min sin extensión por uso (SEC-STEPUP finding #55).
  assertStepUpFresh_(grupoDeQuitar, _identidadDelEnlace_(p, grupoDeQuitar), _huellaDePagina_(p));
  // NO se añade `assertGroupEditable_` aquí, y es deliberado: el KMS ya exige el borrador
  // y contesta con un `{bloqueado:'YA_ENVIADA', mensaje:…}` ESCRITO PARA LA FAMILIA
  // (kis-app kms-server/enr/retirada.gs) que la pantalla enseña tal cual. Un `throw`
  // NOT_EDITABLE por delante cambiaría ese mensaje por el genérico «no se pudo» — sería
  // paridad de forma pagada con una peor respuesta a la familia.
  _wzCacheInvalidate_(p.resume_token);       // WIZARD-CACHE: nunca stale tras un write
  var lote = Array.isArray(p.retirar) ? p.retirar : [];
  // Tope defensivo: quitar es un acto de la familia sobre su propia pantalla, no un lote
  // masivo. Un mensaje con miles de elementos es ruido o un abuso, no un uso.
  if (lote.length > 50) {
    var e = new Error('Demasiados elementos a quitar de una vez.');
    e.code = 'BAD_REQUEST';
    throw e;
  }
  return kmsProxy_('enr.wizardRetirar', {
    resume_token: String(p.resume_token),
    retirar: lote.map(function (it) {
      return {
        clase: it && it.clase ? String(it.clase).toUpperCase().slice(0, 20) : '',
        id:    it && it.id    ? String(it.id).slice(0, 64) : '',
      };
    }),
  });
}

/**
 * DL-E49 §4/§9 — LA FAMILIA AVISA AL TUTOR QUE ACABA DE DECLARAR.
 *
 * Manda a ESE tutor su propio enlace de la solicitud, para que no dependa de que alguien
 * se lo diga. Es el **EMPUJÓN** que faltaba: declarar al segundo tutor ya se podía, y él
 * ya podía pedir su enlace tecleando SU correo en la portada — pero nadie se lo decía.
 *
 * ⛔ NO ES UN SEGUNDO REMITENTE. Proxy fino a `enr.avisarATutorDeLaSolicitud`, que delega
 * en `enr_addGuardianCore_` — la MISMA pieza que usa la escuela (`enr.addGuardianToApplication`).
 * Aquí no se compone ningún correo ni se escribe en ninguna tabla.
 *
 * LAS DOS PUERTAS, EN ESTE ORDEN (§"El token es la PRIMERA capa…", ②27):
 *   1. KAL-4 — el expediente sale del `resume_token`, NUNCA del cuerpo.
 *   2. El código de un solo uso, **a nombre del buzón que opera** (②24) y **antes** del
 *      viaje al KMS. Esto MANDA UN ENLACE DE ACCESO a la solicitud: con un token observado
 *      y sin candado se podría colar a un tercero en silencio. Pide lo mismo que corregir
 *      una letra de un nombre, que es lo mínimo defendible.
 *
 * NO lleva `assertGroupEditable_` a propósito: el KMS ya exige el asistente abierto
 * (`enr_assertWizardOpen_`) y contesta con un motivo accionable que la pantalla enseña;
 * un `NOT_EDITABLE` por delante lo sustituiría por el genérico «no se pudo».
 *
 * @param {Object} p — { resume_token, person_id, n?/recovered_email? }
 * @returns {Object} `data` del KMS: `{ok:true, aviso_enviado, destino_enmascarado, …}` o
 *   `{ok:false, motivo:'AUN_NO_CONSTA'|'SIN_CORREO'|'NO_ES_TUTOR'}`.
 */
function avisarATutor_(p) {
  p = p || {};
  var grupoDelAviso = requireResumeToken_(p);   // KAL-4 — primero, y el KMS lo re-valida.
  assertStepUpFresh_(grupoDelAviso, _identidadDelEnlace_(p, grupoDelAviso), _huellaDePagina_(p));
  return kmsProxy_('enr.avisarATutorDeLaSolicitud', {
    resume_token: String(p.resume_token),
    person_id:    p.person_id ? String(p.person_id).slice(0, 64) : '',
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
  // DL-A.3 — identidad unificada (colapso del signing_token). DL-A.4 — encolado
  // (era ~95s síncrono): el KMS devuelve al instante {queued,job_id}.
  const sctx = requireSignerIdentity_(p); // PERF-WIZ: guardian lo valida el resolver único del KMS (anti-P245)
  // ★ SEC WIZ-SIGNTOKEN (audit 2026-07-22): step-up fresco OBLIGATORIO antes de
  // persistir consentimientos GDPR (legalmente vinculantes). Paridad con
  // initiateSigningSession_. Grupo derivado del token (KAL-4), nunca del payload.
  // ②24: y a nombre del buzón que opera — la marca de un tutor no firma por el otro.
  assertStepUpFresh_(sctx.enrollment_group_id, sctx.identity && sctx.identity.recovered_email, _huellaDePagina_(p));

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
  // ★ SEC WIZ-SIGNTOKEN (audit 2026-07-22): step-up fresco OBLIGATORIO antes de
  // confirmar la revisión (evidencia del acto de firma). Paridad con
  // initiateSigningSession_. Grupo derivado del token (KAL-4), nunca del payload.
  // ②24: y a nombre del buzón que opera.
  assertStepUpFresh_(sctx.enrollment_group_id, sctx.identity && sctx.identity.recovered_email, _huellaDePagina_(p));
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
  // ②24: y a nombre del buzón que opera — nadie inicia la firma del otro con la marca
  // que se ganó él. El buzón ya lo resolvió el gate de identidad: se reusa.
  if (!createOnly) assertStepUpFresh_(sctx.enrollment_group_id, sctx.identity && sctx.identity.recovered_email, _huellaDePagina_(p));
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
 *
 * `0º.septies` (2026-08-21): el freno se comprueba en DOS capas — primero por token (sin viaje),
 * después la de siempre por expediente. Ver el comentario dentro de la función.
 */
/**
 * Llave del freno del precalentado por TOKEN — `0º.septies` (2026-08-21).
 *
 * Existe para poder frenar ANTES de la puerta, que hoy cuesta un viaje al KMS de ~22 s. El token
 * es la única identidad que el llamante trae sin coste, y **un token pertenece a un solo
 * expediente**, así que por ese eje el freno no se afloja.
 *
 * Va RESUMIDA (`sha256` truncado, mismo molde que el memo de lectura del gate `rtmemo_`): el
 * `resume_token` es un secreto de portador y no se escribe en claro (KAL-11).
 *
 * Token ausente o malformado → `null` ⇒ NO se frena aquí y `requireResumeToken_` lo rechaza igual
 * que siempre (`assertValidUuid_` → `BAD_REQUEST`): comportamiento byte-idéntico al de antes.
 * @private
 */
function _warmRateLimitTokenKey_(token) {
  try {
    assertValidUuid_(token, 'resume_token');
    return 'warmrltok_' + sha256Hex_(Utilities.newBlob(String(token).trim()).getBytes()).slice(0, 40);
  } catch (e) {
    return null;
  }
}

function warmSession_(p) {
  // ⛔ `0º.septies` (2026-08-21) — EL FRENO VA DELANTE DEL TRABAJO CARO. Esto es EL MODELO, no un
  //    respaldo: mismo criterio que §"Las CINCO puertas del asistente" (*«la verja va ANTES del
  //    trabajo caro y del cupo»*). MEDIDO en el registro real de Diego del 2026-08-20: una SEGUNDA
  //    llamada de precalentado gastó 24.200 ms —22.023 de ellos en el viaje
  //    `enr.wizardExpedienteDelToken` que hace `requireResumeToken_`— para acabar contestando
  //    `RATE_LIMITED`. El freno mira una memoria local y cuesta microsegundos.
  //
  //    SON DOS CAPAS, y la segunda NO SE TOCA. La de abajo (por EXPEDIENTE, `warmrl_<groupId>`)
  //    sigue exactamente donde estaba y con la misma llave, así que el freno NO se afloja aunque el
  //    enlace ROTE — y rota: `sendMagicLink_` lo renueva por `enr.wizardTouchSession`, con cupo de
  //    hasta 5 por hora y buzón (`_checkMagicLinkRateLimit_`). La capa nueva va por TOKEN, la llave
  //    que el llamante YA trae sin coste, y solo puede AÑADIR cortes: nunca quitarlos. En el peor
  //    caso (token rotado) el comportamiento es el de siempre — se paga el viaje y frena la capa 2.
  //
  //    KAL-4 INTACTA: el expediente lo sigue derivando la puerta DEL ENLACE, jamás del cuerpo de la
  //    petición. La llave va resumida (`sha256`), como el memo del gate: el token es un secreto de
  //    portador y no se escribe en claro en ningún sitio (KAL-11).
  const rlCache = CacheService.getScriptCache();
  const rlTokenKey = _warmRateLimitTokenKey_(p && p.resume_token);
  if (rlTokenKey) {
    if (rlCache.get(rlTokenKey)) return { ok: true, warmed: false, reason: 'RATE_LIMITED' };
    rlCache.put(rlTokenKey, '1', 120);
  }

  const groupId = requireResumeToken_(p);
  const rlKey = 'warmrl_' + groupId;
  if (rlCache.get(rlKey)) return { ok: true, warmed: false, reason: 'RATE_LIMITED' };
  rlCache.put(rlKey, '1', 120);

  // Identidad efectiva — VERBATIM de hydrateSession_ (IDENTITY-FROM-LINK): la clave de
  // la cache warm KMS incluye recovered_email + locale; debe coincidir con la que usará
  // el hydrate real post-OTP o el warm no haría hit.
  // ②17 (sexto tramo): la cabecera la sirve el KMS (`_expedienteDelToken_`, lector ÚNICO).
  //   Degrada a null exactamente como el `try/catch` que había aquí — sin fila, la identidad
  //   vuelve a ser group-scoped, que es el comportamiento previo.
  const bindGroupRow = _expedienteDelToken_(p.resume_token).fila;
  const effRecoveredEmail = effectiveRecoveredEmail_(p && p.resume_token, p && p.recovered_email, p && p.n, bindGroupRow);

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
 *    Ticket desconocido/expirado/reusado → NO hay nada que calentar: {ok:true} (la
 *    MISMA respuesta del ticket real y del señuelo — sin oráculo) + log. Solo un
 *    ticket MAL FORMADO es un fallo: {ok:false, error:{code:'TICKET_MALFORMADO'}}.
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
    if (it0.phase === 'mem') return _warmMembersDocsPhase_(it0);
    // `0º.vicies.quinquies` — fase 'sim': la simulación de cuotas del paso 7.
    if (it0.phase === 'sim') return _warmSimularCuotasPhase_(it0);
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
    // ── «NO HABÍA NADA QUE CALENTAR» NO ES UN FALLO (2026-08-15) ──────────────
    // El ticket es SINGLE-USE y dura 300 s: que ya esté gastado (la familia recargó,
    // el navegador repitió la petición) o caducado es lo NORMAL, no una avería. Al
    // devolver `{ok:false}` sin más, el sobre de `doPost` sale con `ok:false`
    // (`jsonResponse_({ok:true, ...result})` — el resultado pisa al sobre), y el
    // cliente lo trata como error del servidor: `api.js` escribe un ERROR ROJO en la
    // consola de la familia («Unknown server error», porque tampoco había `error`)
    // para algo que fue bien. El precalentado es best-effort POR CONTRATO — no puede
    // usar el canal de error del sobre para decir "no había nada".
    //
    // Se distingue AQUÍ, en el único sitio que sabe cuál de las dos cosas pasó:
    //   · ticket mal formado          → FALLO del llamante  → `ok:false` NOMBRADO.
    //   · gastado / caducado / vacío  → nada que calentar   → `ok:true` y al log.
    // WIZ-ENUM: la respuesta del camino "nada que calentar" es la MISMA `{ok:true}`
    // del ticket real y del señuelo (`_magicLinkConstantAck_`), así que sigue sin
    // haber por dónde preguntar si ese correo tiene expediente.
    var tk = String(p.ticket).trim();
    try { assertValidUuid_(tk, 'ticket'); }
    catch (eV) { return { ok: false, error: { code: 'TICKET_MALFORMADO', message: 'ticket inválido' } }; }
    var cache = CacheService.getScriptCache();
    var key = 'wzwt_' + tk;
    var raw = cache.get(key);
    cache.remove(key); // single-use SIEMPRE (también si el parse falla)
    if (!raw) {
      Logger.log('[warmBundle_] nada que calentar: ticket gastado o caducado');
      return { ok: true };
    }
    var items = [];
    try { items = JSON.parse(raw) || []; }
    catch (eP) {
      Logger.log('[warmBundle_] nada que calentar: ticket ilegible en cache');
      return { ok: true };
    }
    // V2.1: por cada item, fases hijas CONCURRENTES (fetchAll al propio /exec):
    //  - 'kms': hydrate+admission+members+bytes PDF (30-90s, dominado por el pull KMS).
    //  - 'mem': members + bytes del paquete de firma, independiente del hydrate.
    //  - 'sim': la simulación de cuotas del paso 7 (`0º.vicies.quinquies`) — ~89 s,
    //    independiente de las otras dos, para que esté lista antes de que la familia
    //    llegue al paso 7 (el listón de Diego: «cuando lleguen todo debe ser
    //    instantáneo»). Best-effort: si no calienta a tiempo, el paso 7 la calcula
    //    ella misma, como hoy.
    // Antes secuencial: el warm no ganaba la carrera del minuto muerto (round 5).
    // ②17 (2026-08-15): había una fase 'res' que precocinaba el payload de
    // `resumeSession` con ~24 lecturas directas a AppSheet —salud, alergias, dieta y
    // NEAE de menores incluidas— en CADA envío de enlace. Se retiró con el manejador:
    // su memoria solo la leía `resumeSession`, y el frontal no lo llamaba desde que el
    // camino vivo pasó a ser `hydrateSession` → KMS. Lo que calienta el camino vivo es
    // la fase 'kms', que sigue intacta.
    var passes = [];
    items.forEach(function(it) {
      if (!it || !it.t) return;
      var pk = _mintWarmPass_({ t: it.t, n: it.n || null, e: it.e || null, l: it.l || null, phase: 'kms' });
      // V2.3: fase 'mem' CONCURRENTE e independiente del hydrate — el paso 10
      // (members+docs) queda caliente aunque el usuario llegue en <60s.
      var pm = _mintWarmPass_({ t: it.t, n: it.n || null, e: it.e || null, l: it.l || null, phase: 'mem' });
      var psim = _mintWarmPass_({ t: it.t, n: it.n || null, e: it.e || null, l: it.l || null, phase: 'sim' });
      if (pk) passes.push({ pass: pk });
      if (pm) passes.push({ pass: pm });
      if (psim) passes.push({ pass: psim });
    });
    _wzSelfFetchAll_(passes);
    // WIZ-ENUM: el CONTEO de fases se queda en el log, no en la respuesta — un
    // ticket señuelo (`_magicLinkConstantAck_`, 0 items) daría `phases:0` frente a
    // `phases:3` de uno real, reabriendo por esta puerta el oráculo de existencia.
    // Ningún consumidor lee `phases` (el frontend hace fire-and-forget `.catch()`).
    Logger.log('[warmBundle_] ticket kicked, phases=' + passes.length);
    return { ok: true };
  }
  // Sin ticket: mismo gate y semántica que el warm de la pantalla OTP (KAL-4 dentro).
  var wsOut = warmSession_(p);
  // `0º.vicies.quinquies` — esta llamada YA es fire-and-forget desde el cliente
  // (ResumePage.jsx, tras clicar el enlace: `setTimeout(...).catch(()=>{})`). El
  // hydrate de arriba YA quedó caliente antes de esta línea — no se le resta ni un
  // milisegundo—; AHORA, en la misma ejecución ya olvidada por el navegador, se
  // calienta TAMBIÉN la simulación del paso 7 en su propia fase (mismo mecanismo
  // del ticket — `_mintWarmPass_`/`_wzSelfFetchAll_` —, nunca uno nuevo). Sin
  // `resume_token` o con uno inválido, `_warmSimularCuotasPhase_` no hace nada.
  try {
    var psimDirecto = _mintWarmPass_({
      t: p && p.resume_token, n: (p && p.n) || null,
      e: (p && p.recovered_email) || null, l: (p && p.language) || null, phase: 'sim',
    });
    if (psimDirecto) _wzSelfFetchAll_([{ pass: psimDirecto }]);
  } catch (eSimDirecto) { /* best-effort — nunca puede tumbar el warm de siempre */ }
  return wsOut;
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
  // ②24 — la marca es del buzón que operó, no del expediente entero (un solo resolvedor).
  const personaEmail = _identidadDelEnlace_(p, groupId);
  const paginaViva = _huellaDePagina_(p);
  if (graceOk) _markStepUpFresh_(groupId, 'GRACE', personaEmail, paginaViva);
  const marcaStepUp = _leerMarcaStepUp_(groupId, personaEmail, paginaViva);
  const stepUpFresh = marcaStepUp.fresh;
  // 2026-08-20 — el cliente necesita saber CUÁNTO le queda, no solo si está fresco: con
  // el booleano a secas su espejo local echaba su propia cuenta de 10 min y divergía de
  // la del servidor (el defecto que #30 documentó). Ahora la cuenta la manda quien la
  // tiene, y el aviso de los dos minutos se pinta sobre el tiempo REAL.
  const stepUpRestanteS = marcaStepUp.restante_s;
  const stepUpCierre = marcaStepUp.cierre;

  // A (WIZARD-STEPUP) — gate ANTES de pagar el hydrate pesado. El gate PII (DL-E39)
  // estaba DESPUÉS del kmsProxy_ (~30s) → el OTP de entrada salía tras la espera. Ahora,
  // si el step-up NO está fresco, NO montamos el expediente: el StepUpGate del frontend
  // solo necesita `group` (enrollment_group_id + resume_token), así que basta la CABECERA.
  //
  // ②17 (sexto tramo): esa cabecera la sirve el KMS (`_expedienteDelToken_`, lector ÚNICO)
  //   PROYECTADA a cinco campos — antes se leía `enrEnrollmentGroups` directamente y la
  //   fila ENTERA cruzaba a este proceso público y de ahí al navegador, `magic_link_token`
  //   incluido. Medido el 2026-08-15: en esta rama el cliente solo usa
  //   `enrollment_group_id` (`WizardContext.jsx:913`), `resume_token` (`:914`) y
  //   `submitted_at` (`ResumePage.jsx:120`, registro) — `hydrateFromResume` RETORNA en
  //   `:946` antes de tocar nada más. Por eso ya no se normaliza `desired_start_date`:
  //   no cruza (y su sede canónica es `enrEnrollments`, no la cabecera).
  //
  // Comportamiento ante fallo IDÉNTICO al de la lectura que vivía aquí: `appsheetRequest_`
  //   LANZA y este punto no la envolvía en `try` ⇒ «no se pudo preguntar» LANZA. «No hay
  //   fila» sigue siendo `group:null`, que el gate acepta (ya tiene el token en su closure).
  if (!stepUpFresh) {
    const consultaCab = _expedienteDelToken_(p.resume_token);
    if (!consultaCab.ok) {
      const eCab = new Error('No se pudo leer la cabecera del expediente.');
      eCab.code = 'INTERNAL_ERROR';
      throw eCab;
    }
    const group = consultaCab.fila;
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
      step_up_restante_s: 0,
      pii_gated:      true,
    };
  }

  // IDENTITY-FROM-LINK (2026-06-11): deriva el recovered_email EFECTIVO server-side DEL
  // PROPIO ENLACE. `p.n` (email_id del enlace) → email del guardian, validado contra el
  // grupo del token (KAL-4) → el KMS recibe SIEMPRE la identidad del guardian que recuperó,
  // sin depender del cliente. Prioridad `n` > recovered_email (compat). La cabecera del
  // expediente va como groupHint (respaldo requester del email de creación).
  // ②17 (sexto tramo): la sirve el KMS (`_expedienteDelToken_`, lector ÚNICO). Los dos
  //   campos que el resolvedor lee del hint —`primary_email` y `requester_person_id`— están
  //   en la proyección, igual que `enrollment_group_id`, que es la guarda con la que
  //   `resolveGuardianForRecovery_` decide si el hint sirve. Degrada a null exactamente como
  //   el `try/catch` que había aquí ⇒ identidad group-scoped, comportamiento previo.
  const bindGroupRow = _expedienteDelToken_(p.resume_token).fila;
  const effRecoveredEmail = effectiveRecoveredEmail_(p && p.resume_token, p && p.recovered_email, p && p.n, bindGroupRow);

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
  const wzHydKey = _wzCacheKey_('hyd', groupId + '_' + _wzN_(p && p.n, p && p.recovered_email));
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
      const awaited = _wzAwaitWarm_('wzck_hyd_' + groupId + '_' + _wzN_(p && p.n, p && p.recovered_email), wzHydKey, 60000);
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
  //
  // ★ 2026-08-04 — aquí vivía `catch (e) { data.questions = { sets: [] }; }`: CUALQUIER
  //   excepción del adaptador se convertía en un catálogo VACÍO que viajaba al cliente
  //   con pinta de bueno. El cliente lo sembraba (`primeQuestions`) y lo servía de su
  //   caché durante la ventana de revalidación (30 min) SIN volver a salir a red: un
  //   fallo de un segundo apagaba el cuestionario media hora, con «Continuar» guardando
  //   vacío y sin que nada se lo dijera a la familia. Ahora el fallo NO se disfraza de
  //   catálogo: se retira la clave y se marca, para que el cliente sepa que no tiene
  //   catálogo (y lo pida por su cuenta) en vez de creerse que no hay preguntas.
  wizardResolverPreguntasDeHidratacion_(data, (p && p.language) || 'es');

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

  // REOPEN-FIX (regresión DL-C) — honra la reapertura: si el grupo trae `submitted_at` pero
  //   el expediente está en una fase editable (reapertura del KMS), anulamos `submitted_at` en
  //   la respuesta. ②17 (2026-08-15): éste es ya el ÚNICO sitio donde vive la reapertura — el
  //   lector del que se copió (`resumeSession_`) se retiró con el resto de esa segunda
  //   hidratación, así que aquí no hay nada que «restaurar»: hay que conservarlo. El frontend
  //   (WizardContext) deriva el bloqueo de `group.submitted_at`, así que esto desbloquea la UI.
  //
  //   2026-08-03: antes esto lo CONDUCÍA el `editable` que mandaba el KMS. Ya no: esa bandera
  //   es una decisión de pantalla de ESTE cliente (DL-E41 ★ACOTACIÓN) y se deriva aquí, del
  //   HECHO que sí manda el KMS —la fase—, con el mismo derivador único que usa el resto. No
  //   es «re-implementar el check»: es dejar de tener DOS que pueden decir cosas distintas.
  var _reabierto = data.admission
    && derivarPantallaAdmision_(data.admission.state_code || null, null, null).editable;
  if (_reabierto && data.group && data.group.submitted_at) {
    Logger.log(redact_('hydrateSession_: fase editable (reapertura) — submitted_at anulado para el grupo ' + data.group.enrollment_group_id));
    data.group.submitted_at = null;
  }

  return Object.assign({}, data, { step_up_fresh: stepUpFresh, step_up_restante_s: stepUpRestanteS,
                                   step_up_cierre: stepUpCierre });
}

/**
 * DL-A.5 (Opción A §2) — Recibe el notify KMS→wizard de un cambio de estado/milestone y
 * bumpa la versión liveState del grupo (ScriptCache). NO es un endpoint de usuario: lo
 * llama SOLO el KMS (CALL_WEBHOOK_ASYNC). Gate por secreto compartido
 * `WIZARD_NOTIFY_SECRET` (Script Property); secreto inválido/ausente → no-op estructurado
 * `{ok:false}` (NUNCA 403, NUNCA revela si el grupo existe — patrón qb-public).
 *
 * @param {Object} p — { notify_secret, enrollment_group_id, reason? }
 * @returns {{ok:boolean, bumped?:boolean, version?:number, reason?:string}}
 */
/**
 * DL-S106 — Verifica un aviso FIRMADO del KMS: firma, ventana y no-repetición, EN ESE ORDEN
 * y ANTES de mirar nada del contenido. Espejo exacto de `notify_verifySignedRequest_` del
 * KMS (`kms-server/sys/notify-public.gs`), que es el que ya verifica lo que este wizard le
 * manda desde P214 — mismo algoritmo, mismo separador, misma anchura de ventana, misma
 * codificación hexadecimal, y reusando `_kmsNotifyHex_` (no hay un segundo byte→hex).
 *
 * El canónico tiene las MISMAS CINCO RANURAS que el probado, en el mismo orden:
 *   accion \n 'wizard' \n JSON.stringify(event) \n nonce \n timestamp
 * La ranura 2 lleva la constante `'wizard'` (en el probado dice a quién va; aquí el
 * destinatario es un solo sistema). Eso da SEPARACIÓN DE DOMINIO en los dos sentidos: un
 * mensaje wizard→KMS lleva un email en esa ranura, así que jamás vale aquí; y uno de aquí
 * jamás vale allí, porque su accion no está en la lista blanca de plantillas del KMS.
 *
 * RECHAZO EN SILENCIO: devuelve la MISMA forma sea cual sea el motivo. Distinguir «firma
 * mala» de «caducado» de «repetido» le diría al atacante qué está afinando. El registro
 * interno sí distingue, redactado (KAL-11).
 *
 * Dónde recuerda los sucesos ya aplicados: `CacheService.getScriptCache()`, con TTL IGUAL a
 * la ventana. El compromiso es deliberado y hay que decirlo: esa memoria es DESALOJABLE, y
 * por eso la ventana es estrecha — con ventana de 5 min y TTL de 5 min, la memoria solo
 * tiene que sobrevivir lo que dura la ventana.
 *
 * @param {Object} p            cuerpo recibido: { action, event, nonce, timestamp, signature }.
 * @param {string} expectedAction  accion que este receptor acepta (atada a la firma).
 * @returns {{ok:boolean, event?:Object}}
 */
const KMS_NOTICE_WINDOW_MS_ = 5 * 60 * 1000;   // ±5 min — misma anchura que el KMS
const KMS_NOTICE_NONCE_TTL_S_ = 300;           // = ventana: fuera de ella, el paso 2 ya rechaza

function verifySignedKmsNotice_(p, expectedAction) {
  const deny = function(motivo) {
    Logger.log('[verifySignedKmsNotice_] rechazado — ' + motivo);
    return { ok: false };
  };
  const secret = PropertiesService.getScriptProperties().getProperty('NOTIFY_HMAC_SECRET');
  if (!secret) return deny('NOTIFY_HMAC_SECRET no configurado (fallo cerrado)');

  const event = (p && p.event) || null;
  if (!event || typeof event !== 'object') return deny('sin objeto event');

  // 1 — FIRMA. Nada del contenido se mira antes de esto.
  const canonical = String(expectedAction) + '\n' + 'wizard' + '\n' +
                    JSON.stringify(event) + '\n' + String(p.nonce) + '\n' + String(p.timestamp);
  const computed = _kmsNotifyHex_(Utilities.computeHmacSha256Signature(canonical, secret));
  if (!p.signature || String(p.signature).trim().toLowerCase() !== computed) {
    return deny('firma invalida o ausente');
  }

  // 2 — VENTANA. La firma CUBRE el timestamp, así que no es reescribible.
  let ts = new Date(p.timestamp).getTime();
  if (isNaN(ts)) ts = Number(p.timestamp);
  if (isNaN(ts) || Math.abs(Date.now() - ts) > KMS_NOTICE_WINDOW_MS_) {
    return deny('fuera de ventana');
  }

  // 3 — NO-REPETICION. KAL-5: validar la forma del identificador antes de usarlo de clave.
  try { assertValidUuid_(p.nonce, 'nonce'); } catch (e) { return deny('nonce con forma invalida'); }
  const cache = CacheService.getScriptCache();
  const key = 'kmsnotice_nonce_' + p.nonce;
  if (cache.get(key)) return deny('repetido (nonce ya usado) ' + String(p.nonce).slice(0, 8));
  cache.put(key, '1', KMS_NOTICE_NONCE_TTL_S_);

  return { ok: true, event: event };
}

function notifyLiveStateChange_(p) {
  p = p || {};
  // DL-S106 — VERIFICAR ANTES DE MIRAR. Ni un solo campo del contenido se toca hasta que la
  // firma, la ventana y la no-repetición hayan pasado. Antes bastaba con repetir el secreto
  // que venía en el propio cuerpo, y esta función es alcanzable desde internet sin
  // autenticación (está en el `switch(action)` del doPost `ANYONE_ANONYMOUS`).
  const v = verifySignedKmsNotice_(p, 'notifyLiveStateChange');
  if (!v.ok) return { ok: false, reason: 'UNAUTHORIZED' };
  const groupId = v.event.enrollment_group_id;
  try { assertValidUuid_(groupId, 'enrollment_group_id'); } catch (e) { return { ok: false, reason: 'BAD_REQUEST' }; }
  const version = _bumpLiveStateVersion_(groupId);
  Logger.log(redact_('[notifyLiveStateChange_] bumped group=' + groupId + ' reason=' + (v.event.reason || '?') + ' -> v' + version));
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

// EL ORDEN EN QUE LLEGAN LAS FECHAS DE AppSheet — y NO depende de la configuración
// regional de la hoja de cálculo.
//
// La API de AppSheet devuelve las columnas de fecha en formato AMERICANO, `M/D/YYYY`
// (mes primero). Eso está medido, y lo dicen también los dos lectores del KMS que leen
// exactamente lo mismo: `utils_appsheetDateToIso_` (`kis-app kms-server/_shared/utils.gs:65`,
// «AppSheet API v2 returns Date/DateTime-typed columns in US locale format») y
// `auth_parseWindowDateParts_` (`_shared/auth.gs`).
//
// ①31 (2026-08-09) — esto valía `'ES'`, y la nota de al lado ya decía que el formato es
// M/D/YYYY: la constante contradecía a su propio comentario. Consecuencia real: la rama
// ambigua de `normalizeDate_` (los dos primeros números ≤ 12) leía `'09/01/2026'` como
// el 9 de ENERO en vez del 1 de SEPTIEMBRE — la fecha de incorporación de una familia
// que empieza en septiembre se guardaba movida ocho meses, sin ningún aviso.
//
// Solo gobierna el caso AMBIGUO: `13/…` o `…/13` se resuelven por sí solos y no la miran.
// Esta constante NO es un ajuste de la hoja de cálculo: es el formato de la API.
var APPSHEET_DATE_LOCALE = 'US';

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
      const rows = wizardSoloVivas_(appsheetRequest_(T.PERSONS, 'Find', [], { Filter: filter }));
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
      // P1-B: escritura portada al KMS (enr.wizardAbandonSession). KAL-4: el grupo lo
      // deriva el KMS del resume_token de la PROPIA fila leída (nunca un id suelto).
      kmsProxy_('enr.wizardAbandonSession', { resume_token: s.resume_token });
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
  // Desde ②17 el camino público **no consulta nada**: corta con la respuesta constante
  // antes de preguntar al KMS (así el reloj tampoco delata si el correo existe). Por eso
  // esta comprobación no necesita ni base de datos ni correo real: si algún día vuelve a
  // consultar antes de responder, aquí no se notará — lo que lo vigila es
  // `scripts/comprobar-verja-publica.mjs`.
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
 * WIZ-ENUM (audit 2026-07-27) — verifica que `sendMagicLink_` (rama `primary_email`)
 * devuelve una respuesta INDISTINGUIBLE exista o no una solicitud para el email.
 *
 * Casos:
 *   (a) Email SIN grupo (aleatorio, inexistente): NO lanza, devuelve
 *       `{sent:true, warm_ticket:<uuid>}`, y NO crea sesión (sin reCAPTCHA válido
 *       la creación server-side no se ejecuta) → se comprueba que no aparece
 *       ninguna fila en enrEnrollmentGroups para ese email.
 *   (b) Email bloqueado por reporte (`BLOCKED_BY_REPORT` simulado en ScriptCache):
 *       tampoco lanza — mismo ack (un bloqueo delataría que ese email existió).
 *   (c) Email CON grupo real (OPT-IN — Diego rellena EXISTING_EMAIL abajo):
 *       misma forma exacta que (a). ATENCIÓN: este caso SÍ envía el magic link
 *       real y rota el resume_token de esa sesión — por eso está desactivado por
 *       defecto. Al ejecutarlo, la familia recibe el correo.
 *
 * Todo lo demás (el envío real, la rotación del token) se verifica por el flujo
 * legítimo: el caso (c) manda el email; el caso (a) no manda nada.
 */
function manual_testSendMagicLinkConstantAck() {
  var EXISTING_EMAIL = ''; // ← Diego: rellena SOLO si quieres ejecutar el caso (c).

  function shapeOf(o) {
    if (!o || typeof o !== 'object') return 'NOT_OBJECT';
    return Object.keys(o).sort().join(',') + '|sent=' + o.sent +
           '|warm_ticket=' + (o.warm_ticket ? 'uuid' : String(o.warm_ticket));
  }

  // ── (a) email inexistente ────────────────────────────────────────────────
  var ghost = 'wizenum-' + Date.now() + '-' + Math.floor(Math.random() * 1e6) + '@example.invalid';
  var shapeA = null;
  try {
    var outA = sendMagicLink_({ primary_email: ghost });
    shapeA = shapeOf(outA);
    Logger.log('PASS (a) no-group NO lanza — shape: ' + shapeA);
    Logger.log('PASS (a) sent===true: ' + (outA && outA.sent === true));
  } catch (eA) {
    Logger.log('FAIL (a) — sendMagicLink_ lanzó para un email sin grupo: ' + eA.message);
  }
  // Sin reCAPTCHA válido, el fallback de creación NO debe haber creado nada.
  try {
    var created = appsheetRequest_(T.ENROLLMENT_GROUPS, 'Find', [], {
      Filter: '"primary_email" = "' + appsheetEscape_(ghost) + '"'
    }) || [];
    Logger.log('PASS (a) sin efectos (0 sesiones creadas): ' + (created.length === 0) +
               ' (rows=' + created.length + ')');
  } catch (eF) {
    Logger.log('SKIP (a) verificación de efectos — Find falló: ' + eF.message);
  }

  // ── (b) email bloqueado por reporte → mismo ack, sin BLOCKED_BY_REPORT ────
  var blocked = 'wizenum-blk-' + Date.now() + '@example.invalid';
  try {
    CacheService.getScriptCache().put(
      'magic_blocked_' + Utilities.base64EncodeWebSafe(blocked), '1', 120);
    var outB = sendMagicLink_({ primary_email: blocked });
    Logger.log('PASS (b) bloqueado NO lanza — shape: ' + shapeOf(outB));
    Logger.log('PASS (b) shape idéntica a (a): ' + (shapeOf(outB) === shapeA));
  } catch (eB) {
    Logger.log('FAIL (b) — el bloqueo se filtró como error: ' + (eB && eB.code) + ' ' + eB.message);
  } finally {
    try { CacheService.getScriptCache().remove('magic_blocked_' + Utilities.base64EncodeWebSafe(blocked)); } catch (eR) {}
  }

  // ── (c) email CON grupo (opt-in; ENVÍA email real) ───────────────────────
  if (!EXISTING_EMAIL) {
    Logger.log('SKIP (c) — rellena EXISTING_EMAIL para comparar con un grupo real ' +
               '(ojo: envía el magic link de verdad y rota el resume_token).');
    return;
  }
  try {
    var outC = sendMagicLink_({ primary_email: EXISTING_EMAIL });
    Logger.log('PASS (c) shape: ' + shapeOf(outC));
    Logger.log('PASS (c) INDISTINGUIBLE de (a): ' + (shapeOf(outC) === shapeA));
    Logger.log('NOTA (c): el magic link se ha enviado de verdad (flujo legítimo intacto).');
  } catch (eC) {
    Logger.log('FAIL (c) — sendMagicLink_ lanzó para un email CON grupo: ' + eC.message);
  }
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
      mimeType: 'text/html', filename: 'evil.html' });
    Logger.log('  ✗ FAIL Caso A: text/html ACEPTADO');
  } catch (e) {
    Logger.log((e.code === 'UNSUPPORTED_MIME' ? '  ✓ PASS' : '  ? UNEXPECTED') +
      ' Caso A (text/html): ' + e.message + (e.code ? ' (code=' + e.code + ')' : ''));
  }

  // Caso B — MIME_MAGIC_MISMATCH (declara PDF pero los bytes no empiezan por %PDF)
  try {
    uploadDocument_({ resume_token: RESUME_TOKEN, base64: b64('NOT-A-REAL-PDF-FILE'),
      mimeType: 'application/pdf', filename: 'fake.pdf' });
    Logger.log('  ✗ FAIL Caso B: PDF con magic inválido ACEPTADO');
  } catch (e) {
    Logger.log((e.code === 'MIME_MAGIC_MISMATCH' ? '  ✓ PASS' : '  ? UNEXPECTED') +
      ' Caso B (magic mismatch): ' + e.message + (e.code ? ' (code=' + e.code + ')' : ''));
  }

  // Caso C — FILE_TOO_LARGE (magic OK '%PDF' + relleno > 10 MB)
  try {
    const big = '%PDF-1.4\n' + new Array(11 * 1024 * 1024).join('A'); // ~11 MB
    uploadDocument_({ resume_token: RESUME_TOKEN, base64: b64(big),
      mimeType: 'application/pdf', filename: 'huge.pdf' });
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
 * NEAE staging capture test — verifica que saveNeae_ escribe el set NEAE de un
 * applicant al staging (`enrPersonNeae` + `enrPersonNeaeSupport`) con la semántica
 * append-only DL-E16 (supersede de la fila activa previa) y payload 1:1.
 *
 * Pre-requisito: rellenar RESUME_TOKEN con el resume_token de un grupo DRAFT real
 * y PERSON_ID con el person_id de un applicant de ESE grupo. Como las tablas
 * staging pueden no existir todavía en AppSheet, el handler degrada defensivo
 * (P72) — un "deferred/failed" en Logs con las tablas ausentes es el resultado
 * ESPERADO (no un fallo del handler). Con las tablas creadas, verificar en
 * AppSheet que aparecen las filas is_active=TRUE + provenance=FAMILY_DECLARED.
 * Ejecutar desde el editor GAS (o `clasp run manual_testNeaeStaging`) y leer Logs.
 */
function manual_testNeaeStaging() {
  const RESUME_TOKEN = 'RELLENAR_CON_RESUME_TOKEN_DRAFT_REAL';
  const PERSON_ID    = 'RELLENAR_CON_PERSON_ID_APPLICANT_DEL_GRUPO';
  Logger.log('=== manual_testNeaeStaging ===');
  if (RESUME_TOKEN.indexOf('RELLENAR') === 0 || PERSON_ID.indexOf('RELLENAR') === 0) {
    Logger.log('  ? SKIP: rellena RESUME_TOKEN (grupo DRAFT) + PERSON_ID (applicant del grupo).');
    return;
  }
  try {
    const res = saveNeae_({
      resume_token: RESUME_TOKEN,
      neae: [{
        person_id: PERSON_ID,
        source_locale: 'es',
        conditions: [
          { category_code: 'ASD', diagnosis_status: 'DIAGNOSED', observations: 'Informe psicopedagógico disponible.' },
          { category_code: 'LANGUAGE', diagnosis_status: 'IN_EVALUATION', observations: null },
        ],
        supports: [
          { support_type: 'LOGOPEDIA', provider_scope: 'PRIOR_SCHOOL', is_current: false, observations: 'Apoyo en el centro anterior.' },
          { support_type: 'EXTERNAL_PSYCH', provider_scope: 'EXTERNAL_CURRENT', is_current: true, observations: null },
        ],
      }],
    });
    Logger.log('  ✓ saveNeae_ devolvió: ' + JSON.stringify(res) +
      ' (revisar en AppSheet enrPersonNeae/enrPersonNeaeSupport las filas is_active=TRUE; con tablas ausentes, ver "deferred/failed" arriba — esperado P72).');
  } catch (e) {
    Logger.log('  ✗ FAIL (excepción no tolerada): ' + e.message + (e.code ? ' (code=' + e.code + ')' : ''));
  }
  Logger.log('=== fin manual_testNeaeStaging ===');
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

// ②17 (noveno tramo, 2026-08-15) — aquí vivía `manual_testRecoveryPerGuardian`, y estaba
// ROTA desde el quinto tramo: su comprobación (b)/(c) llamaba a `resumeSession_`, que se
// RETIRÓ entero (0 definiciones en el proyecto) ⇒ ejecutarla lanzaba antes de decir nada.
// Sus otras dos comprobaciones —un correo de tutor resuelve, uno que no lo es devuelve
// nada— las cubren hoy `manual_testIdentityFromLink` y `manual_testIdentityReentry`, que
// además ejercitan el camino VIVO: el resolvedor ÚNICO del KMS por
// `enr.wizardTutorQueRecupera`. Se retira en vez de reescribirse porque una prueba que
// nunca puede pasar es peor que ninguna (§"CITAR una prueba `manual_*` obliga a COMPROBAR
// QUE EXISTE").

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
 *   (a) emisión: el `email_id` del tutor es localizable (lo que va al `n` de la URL).
 *   (b) resolución: effectiveRecoveredEmail_ con token+n (sin recovered_email) → email →
 *       guardian 842951e3… (la identidad sale del enlace, no del cliente).
 *   (c) `n` (email_id) de OTRO expediente → rechazado (KAL-4 cross-group).
 *   (d) `n` basura (no-UUID / UUID inexistente) → ignorado limpio (KAL-5) → null.
 *   (e) sin `n` y sin recovered_email, en modo DECLARADO → null (②24.bis: el respaldo
 *       «tutor 1» existe y NO es un fallo; lo que se afirma es que se puede desactivar).
 *
 * ②17 (noveno tramo, 2026-08-15): la cadena entra por el `resume_token`, no por el
 * identificador del expediente — se lee de la cabecera al arrancar. Y quien resuelve es el
 * KMS (`enr.wizardTutorQueRecupera`), así que esto ejercita el camino VIVO de punta a punta.
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

  // La cadena entra por el TOKEN (②17 noveno tramo): se lee de la cabecera del expediente.
  var grpFL = (appsheetRequest_(T.ENROLLMENT_GROUPS, 'Find', [], {
    Filter: '"enrollment_group_id" = "' + appsheetEscape_(GROUP_ID_REAL) + '"'
  }) || [])[0] || null;
  var TOKEN = grpFL && grpFL.resume_token;
  if (!TOKEN) { Logger.log('  ✗ FAIL — el expediente no existe o no tiene resume_token.'); return { error: 'TOKEN_NOT_FOUND' }; }

  // (a) Emisión: localizar el email_id del tutor en su expediente (lo pregunta el KMS).
  var nEmailId = _tutorQueRecupera_(TOKEN, { correo: GUARDIAN_EMAIL_REAL }).email_id;
  out.a_email_id = nEmailId;
  var aOk = !!nEmailId;
  if (!aOk) pass = false;
  Logger.log('  (a) email_id del tutor → n=' + redact_(String(nEmailId)) + ' → ' +
             (aOk ? '✓ PASS' : '✗ FAIL (¿existe fila enrEmails para ese email en el expediente?)'));

  // (b) Resolución: token+n SIN recovered_email → email → guardian.
  var effFromLink = effectiveRecoveredEmail_(TOKEN, null, nEmailId);
  out.b_effective_email = effFromLink;
  var gFromLink = effFromLink ? resolveGuardianForRecovery_(TOKEN, effFromLink) : null;
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
    var effCross = effectiveRecoveredEmail_(TOKEN, null, otherEmailId);
    out.c_cross_group = effCross;
    var cOk = effCross === null;
    if (!cOk) pass = false;
    Logger.log('  (c) `n` de OTRO grupo → ' + String(effCross) + ' → ' +
               (cOk ? '✓ PASS (rechazado, KAL-4 cross-group)' : '✗ FAIL (resolvió identidad ajena!)'));
  } else {
    Logger.log('  (c) (n/a) — no se encontró un email_id de otro grupo para probar cross-group.');
  }

  // (d) `n` basura → ignorado limpio (KAL-5). Dos sub-casos: no-UUID y UUID inexistente.
  var effGarbage1 = effectiveRecoveredEmail_(TOKEN, null, 'not-a-uuid" || "1"="1');
  var effGarbage2 = effectiveRecoveredEmail_(TOKEN, null, Utilities.getUuid());
  out.d_garbage_noUuid = effGarbage1;
  out.d_garbage_unknownUuid = effGarbage2;
  var dOk = effGarbage1 === null && effGarbage2 === null;
  if (!dOk) pass = false;
  Logger.log('  (d) `n` basura (no-UUID + UUID inexistente) → ' + String(effGarbage1) + ' / ' + String(effGarbage2) +
             ' → ' + (dOk ? '✓ PASS (ignorado limpio, KAL-5)' : '✗ FAIL'));

  // (e) sin `n` y sin recovered_email, en modo DECLARADO (②24.bis) → null. En modo
  //     indulgente el respaldo devuelve el `primary_email` (tutor 1) A PROPÓSITO: eso NO
  //     es un fallo, y afirmar lo contrario era lo que esta comprobación hacía mal.
  var effNone = effectiveRecoveredEmail_(TOKEN, null, null, null, { sinRespaldo: true });
  out.e_none_declarada = effNone;
  var eOk = effNone === null;
  if (!eOk) pass = false;
  Logger.log('  (e) sin `n` ni recovered_email, modo declarado → ' + String(effNone) + ' → ' +
             (eOk ? '✓ PASS (no se atribuye a nadie)' : '✗ FAIL'));

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
 *   (a) emisión tutor-1 → `n` (email_id) localizable (lo da el KMS con el mismo resolvedor).
 *   (b) reentrada del firmante con token + `n` (la firma lo reenvía) → requireSignerContext_
 *       resuelve el guardian SIN signing_token del cliente (path a) — fila 29/30.
 *   (c) getDocument_ bajo resume_token + `n` resuelve el signing_token SERVER-SIDE para el
 *       PDF de firma (resolveGuardianSigningContext_) — fila 30.
 *   (d) fallback requester → tutor-1 resuelve sin `n` (resolveGuardianForRecovery_).
 *   (e) sin `n` ni recovered_email, en modo DECLARADO (②24.bis) → no se atribuye a nadie.
 *
 * ②17 (noveno tramo, 2026-08-15): la cadena entra por el `resume_token` de la cabecera, y
 * quien resuelve es el KMS (`enr.wizardTutorQueRecupera`) — camino VIVO de punta a punta.
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
  var nEmailId = grp.resume_token
    ? _tutorQueRecupera_(grp.resume_token, { correo: GUARDIAN_EMAIL_REAL }).email_id : null;
  out.a_email_id = nEmailId;
  var aOk = !!nEmailId;
  if (!aOk) pass = false;
  Logger.log('  (a) email_id del tutor → n=' + redact_(String(nEmailId)) + ' → ' +
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
  var effForDoc = effectiveRecoveredEmail_(grp.resume_token, null, nEmailId);
  var gForDoc = effForDoc ? resolveGuardianForRecovery_(grp.resume_token, effForDoc) : null;
  // ②17: las filas de firma las sirve el KMS (mismo camino que el lazy resolver real).
  var firmaDiag = grp.resume_token ? _datosDeFirmaDelExpediente_(grp.resume_token) : null;
  var sigCtx = (gForDoc && firmaDiag)
    ? resolveGuardianSigningContext_(GROUP_ID_REAL, gForDoc, firmaDiag.sessions, firmaDiag.signersBySession)
    : null;
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
  var dGuardian = resolveGuardianForRecovery_(grp.resume_token, GUARDIAN_EMAIL_REAL);
  out.d_requester_guardian = dGuardian;
  var dOk = !!(dGuardian && String(dGuardian).indexOf(GUARDIAN_ID_REAL) === 0);
  if (!dOk) pass = false;
  Logger.log('  (d) fallback requester → tutor-1 guardian=' + String(dGuardian) + ' → ' +
             (dOk ? '✓ PASS' : '✗ FAIL'));

  // (e) Sin `n` ni recovered_email, en modo DECLARADO (②24.bis) → no se atribuye a nadie.
  //     En modo indulgente el respaldo devuelve el tutor 1 A PROPÓSITO: no es un fallo.
  var effNone = effectiveRecoveredEmail_(grp.resume_token, null, null, null, { sinRespaldo: true });
  out.e_effective_none_declarada = effNone;
  var eOk = effNone === null;
  if (!eOk) pass = false;
  Logger.log('  (e) sin n ni recovered_email, modo declarado → ' + String(effNone) + ' → ' +
             (eOk ? '✓ PASS (no se atribuye a nadie)' : '✗ FAIL'));

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

  // (e) 2026-08-20 — la actividad EXTIENDE una marca viva, y conserva su atado.
  cache.remove(key);
  _markStepUpFresh_(GROUP_ID, 'OTP', null, 'aaaaaaaa1111');
  var antes = String(cache.get(key) || '').split('|')[0];
  Utilities.sleep(1100);
  var restante = _extenderVentanaStepUp_(GROUP_ID);
  var despues = String(cache.get(key) || '').split('|');
  if (restante > 0 && Number(despues[0]) > Number(antes) && despues[2] === 'aaaaaaaa1111') {
    Logger.log('  e) actividad extiende y conserva la huella → ✓ PASS');
  } else {
    Logger.log('  e) actividad extiende y conserva la huella → ✗ FAIL (' + String(cache.get(key)) + ')'); pass = false;
  }

  // (f) sobre una marca CADUCADA no se resucita nada.
  cache.put(key, String(Date.now() - 1) + '|' + '|' + 'aaaaaaaa1111', 600);
  if (_extenderVentanaStepUp_(GROUP_ID) === 0) Logger.log('  f) caducada NO se resucita → ✓ PASS');
  else { Logger.log('  f) caducada NO se resucita → ✗ FAIL'); pass = false; }

  // (g) la huella de OTRA página no vale (la recarga vuelve a pedir el código).
  cache.remove(key);
  _markStepUpFresh_(GROUP_ID, 'OTP', null, 'aaaaaaaa1111');
  if (_isStepUpFresh_(GROUP_ID, null, 'aaaaaaaa1111') && !_isStepUpFresh_(GROUP_ID, null, 'bbbbbbbb2222')) {
    Logger.log('  g) huella de otra página NO vale → ✓ PASS');
  } else { Logger.log('  g) huella de otra página NO vale → ✗ FAIL'); pass = false; }
  cache.remove(key);

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
 * ★ SEC WIZ-STEPUP-CACHE (audit 2026-07-22) — test del NAMESPACING de la clave OTP.
 * Ejecutar desde el editor GAS (o clasp run). Opera 100% sobre el ScriptCache (no
 * toca BD, no envía email). Demuestra que el bypass queda cerrado y el flujo legítimo
 * intacto, verificando el aislamiento de claves que sendVerificationCode_/verifyEmail_
 * usan según `p.stepup`:
 *
 *   (a) BYPASS CERRADO: un código sembrado bajo `verify_<G>` (lo que hace el camino
 *       SIGNUP con el email del atacante, SIN token/reCAPTCHA) NO existe bajo
 *       `stepup_verify_<G>` (lo que LEE el canje step-up) → el canje step-up no lo ve.
 *   (b) FLUJO LEGÍTIMO INTACTO: un código sembrado bajo `stepup_verify_<G>` (lo que
 *       hace el camino STEP-UP, que envía al primary_email REAL del grupo) SÍ es la
 *       clave que lee el canje step-up.
 *   (c) SIGNUP INTACTO: el camino signup sigue usando `verify_<G>` (byte-neutro).
 *
 * Nota: usamos las MISMAS expresiones de clave que el código de producción para que
 * el test falle si alguien renombra una sola de las dos ramas.
 *
 * Lee PASS/FAIL en los Logs.
 */
function manual_testStepUpKeyNamespacing() {
  Logger.log('=== manual_testStepUpKeyNamespacing (SEC WIZ-STEPUP-CACHE) ===');
  var cache = CacheService.getScriptCache();
  var G = Utilities.getUuid();
  var signupKey = 'verify_' + G;         // clave del camino signup (payload email)
  var stepupKey = 'stepup_verify_' + G;  // clave del camino step-up (primary_email real)
  var pass = true;
  cache.remove(signupKey); cache.remove(stepupKey);

  // (a) BYPASS: el atacante siembra bajo la clave signup; el canje step-up lee la
  //     clave step-up → NO encuentra el código → bypass cerrado.
  cache.put(signupKey, '111111', 600);
  var stepupSeesSignupCode = cache.get(stepupKey);
  if (stepupSeesSignupCode === null) {
    Logger.log('  a) bypass (signup siembra, step-up lee) → ✓ PASS (step-up NO ve el código del atacante)');
  } else {
    Logger.log('  a) bypass → ✗ FAIL (step-up leyó ' + stepupSeesSignupCode + ' del camino signup)'); pass = false;
  }

  // (b) LEGÍTIMO: el camino step-up siembra bajo su propia clave; el canje step-up
  //     lee esa MISMA clave → el flujo de recuperación real sigue funcionando.
  cache.put(stepupKey, '654321', 600);
  var stepupSeesStepupCode = cache.get(stepupKey);
  if (stepupSeesStepupCode === '654321') {
    Logger.log('  b) legítimo (step-up siembra y lee) → ✓ PASS (canje step-up ve su propio código)');
  } else {
    Logger.log('  b) legítimo → ✗ FAIL (esperaba 654321, leyó ' + stepupSeesStepupCode + ')'); pass = false;
  }

  // (c) SIGNUP intacto: la clave del camino signup NO se contamina con la del step-up.
  var signupStill = cache.get(signupKey);
  if (signupStill === '111111') {
    Logger.log('  c) signup intacto (verify_<G> byte-neutro) → ✓ PASS');
  } else {
    Logger.log('  c) signup intacto → ✗ FAIL (verify_<G> = ' + signupStill + ')'); pass = false;
  }

  cache.remove(signupKey); cache.remove(stepupKey);
  Logger.log('=== manual_testStepUpKeyNamespacing: ' + (pass ? 'PASS' : 'FAIL') + ' ===');
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
  // ②17 (noveno tramo): el resolvedor vive en el KMS y entra por el token, no por el id.
  var resolvedId = resolveGuardianForRecovery_(grp.resume_token, grp.primary_email);
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
  // ②17 (noveno tramo): el resolvedor vive en el KMS y entra por el token, no por el id.
  var resolvedId = resolveGuardianForRecovery_(grp.resume_token, primaryEmail);
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

  // ②17 (noveno tramo): la cadena de identidad entra por el TOKEN, así que se lee la
  // cabecera del expediente para tenerlo (este diagnóstico es de editor, no del dispatcher).
  var grp = (appsheetRequest_(T.ENROLLMENT_GROUPS, 'Find', [],
    { Filter: '"enrollment_group_id" = "' + idEsc + '"' }) || [])[0] || null;

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
  // ②17 (noveno tramo): el resolvedor vive en el KMS y entra por el token, no por el id.
  var recoveredGuardianId = resolveGuardianForRecovery_(grp && grp.resume_token, RECOVERED_EMAIL || null);
  Logger.log(redact_('  recovered_email=' + (RECOVERED_EMAIL || '(vacío)') +
             ' → guardian=' + (recoveredGuardianId || 'null')));

  // Sesiones de firma del grupo. ②17: este diagnóstico es de EDITOR (no lo alcanza nadie
  // desde internet), así que sigue leyendo AppSheet directo — pero las MISMAS filas se
  // pasan luego a los resolvedores como hints, que es lo que hace en producción el KMS.
  var sessions = appsheetRequest_(T.SIGNING_SESSIONS, 'Find', [],
    { Filter: '"entity_id" = "' + idEsc + '"' }) || [];
  var signersBySessionDiag = {};
  Logger.log('  sesiones de firma ancladas al grupo: ' + sessions.length);
  sessions.forEach(function(s, i) {
    Logger.log('    [sesión ' + i + '] session_id=' + String(s.session_id || '').substring(0, 8) +
               '... state=' + (s.current_state_code || '(null)') +
               ' deleted_at=' + (s.deleted_at || '(no)'));
    if (s.session_id) {
      var signers = appsheetRequest_(T.SIGNING_SESSION_SIGNERS, 'Find', [],
        { Filter: '"session_id" = "' + appsheetEscape_(s.session_id) + '"' }) || [];
      signersBySessionDiag[s.session_id] = signers;
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
  // ②17: los resolvedores YA NO leen AppSheet — reciben las filas. Aquí se les pasan las
  // que este diagnóstico acaba de leer, en el mismo orden que el KMS las sirve.
  var via1 = recoveredGuardianId
    ? resolveGuardianSigningContext_(GROUP_ID, recoveredGuardianId, sessions, signersBySessionDiag)
    : null;
  var via2 = resolveSigningContextFromSession_(GROUP_ID, persons, sessions, signersBySessionDiag);

  Logger.log('  Vía 1 (per-guardian a1): ' + (via1 ? 'RESUELTA (token=' +
             String(via1.signing_token).substring(0, 8) + '...)' : 'null'));
  Logger.log('  Vía 2 (cross-device determinista): ' + (via2 ? 'RESUELTA (token=' +
             String(via2.signing_token).substring(0, 8) + '...)' : 'null'));

  // WIZARD-STEP7-COMPLETED: estado de firma incl. terminal COMPLETED.
  var signingStatus = resolveSigningStatus_(GROUP_ID, sessions, signersBySessionDiag);
  Logger.log('  signing_status (lifecycle): ' + signingStatus);

  // Resultado final del gate tal como lo ve el frontend.
  // ②17 (decimotercer tramo): el catálogo de situaciones lo sirve el KMS por el lector ÚNICO
  // (`_pulsoDeLaAdmision_`), así que este diagnóstico le pasa el `resume_token` de la cabecera
  // que ya leyó. Sin él, `buildAdmissionContext_` fallaría cerrado — que es lo correcto: un
  // catálogo que no se pudo leer no puede pasar por «no hay situación».
  var admission = buildAdmissionContext_(GROUP_ID, enrollments, recoveredGuardianId, persons,
    { sessions: sessions, signersBySession: signersBySessionDiag,
      resumeToken: (grp && grp.resume_token) || null });
  Logger.log('  >>> buildAdmissionContext_: state_code=' + admission.state_code +
             ' signing_available=' + admission.signing_available +
             ' signing_context=' + (admission.signing_context ? 'sí' : 'no') +
             ' signing_status=' + admission.signing_status);
  Logger.log('=== fin manual_diagWizardSigningGate ===');
  return admission;
}

// ②17 (decimocuarto tramo, 2026-08-16) — AQUÍ vivía `manual_testSigningStepsFromMilestones`.
// Se RETIRA con los dos ayudantes de hitos que ejercitaba (`isMilestoneCompleted_` /
// `isDurableSigningMilestoneCompleted_`): era su ÚNICO llamante que quedaba, y medía un
// camino que ya no existe. Además había caducado por dentro — buscaba GDPR/REVIEW bajo
// `SYS_SIGNING_SESSION_SIGNER`, que DL-E44 dejó como respaldo legado: los hitos vivos son
// DURABLES del grupo, con el tutor en la evidencia. Conservarlo dejaba un SEGUNDO lector
// del mismo dato, divergente y con el tipo de expediente escrito a mano (DL-E48).
// Hoy los cuatro indicadores los resuelve el KMS; para verlos, `resolveSigningToken_`.

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

/**
 * EMAIL-MIGRATION-2 (2026-06-25) — setter param-accepting del secreto HMAC compartido.
 * Pone la Script Property `NOTIFY_HMAC_SECRET` AL VALOR DADO (no genera uno nuevo) para
 * que el orquestador siembre el MISMO valor en wizard + KMS en una sola operación
 * `clasp run --params` SIN exponer el secreto. NO loguea el valor (KAL-11) — solo su
 * longitud. Espejo exacto del homónimo del KMS (kms-server/_manual.gs). Este es el
 * setter de la CLAVE CORRECTA que firma sendViaKmsNotify_/sendViaKmsAuthCode_
 * (`NOTIFY_HMAC_SECRET`), distinto de `WIZARD_NOTIFY_SECRET` (gate KMS→wizard de
 * notifyLiveStateChange — NO tocar aquí).
 *
 * @param {string} value El secreto compartido (mismo en wizard y KMS).
 * @returns {{ ok: boolean, len: number }}
 */
function manual_setNotifyHmacSecret(value) {
  PropertiesService.getScriptProperties().setProperty('NOTIFY_HMAC_SECRET', value);
  return { ok: true, len: (value || '').length };
}

/**
 * RED del receptor firmado (DL-S106). Comprueba que `notifyLiveStateChange_` RECHAZA lo que
 * tiene que rechazar y ACEPTA lo legítimo. No se registra en el dispatcher: se ejecuta con la
 * auth del propietario (`clasp run`).
 *
 * Un receptor al que nunca se le ha visto rechazar nada no está verificando: está dejando
 * pasar. Por eso los cuatro rechazos son la parte importante, y la aceptación solo demuestra
 * que el candado no está cerrado de más.
 *
 * NO manda ningún correo, NO toca AppSheet y NO usa datos reales: el identificador de grupo
 * es sintético y lo único que la aceptación escribe es un contador en la memoria efímera.
 *
 * VEREDICTO en la ÚLTIMA línea, SIEMPRE — también ante excepción.
 */
function manual_testSignedWebhookReceiver() {
  var fallos = [];
  var lineas = [];
  try {
    var secret = PropertiesService.getScriptProperties().getProperty('NOTIFY_HMAC_SECRET');
    if (!secret) throw new Error('NOTIFY_HMAC_SECRET no configurado en este GAS — la red no puede firmar nada');

    var firmar = function(event, nonce, ts) {
      var canonical = 'notifyLiveStateChange' + '\n' + 'wizard' + '\n' +
                      JSON.stringify(event) + '\n' + nonce + '\n' + ts;
      return _kmsNotifyHex_(Utilities.computeHmacSha256Signature(canonical, secret));
    };
    var sobre = function(event, nonce, ts) {
      return { action: 'notifyLiveStateChange', event: event, nonce: nonce,
               timestamp: ts, signature: firmar(event, nonce, ts) };
    };
    var evento = function() {
      return { enrollment_group_id: Utilities.getUuid(), reason: 'PRUEBA', at: new Date().toISOString() };
    };
    var afirmar = function(nombre, obtenido, esperadoOk) {
      var ok = !!(obtenido && obtenido.ok) === esperadoOk;
      lineas.push((ok ? '  ok  ' : '  FALLO ') + nombre + ' → ok=' + !!(obtenido && obtenido.ok) +
                  ' (esperado ' + esperadoOk + ')');
      if (!ok) fallos.push(nombre);
    };

    // (a) sin firma — es también la FORMA LEGADA (el secreto dentro del cuerpo), que a partir
    //     de ahora tiene que rechazarse igual que cualquier otra cosa sin firmar.
    afirmar('(a) sin firma / forma legada con el secreto en el cuerpo',
            notifyLiveStateChange_({ notify_secret: 'lo-que-sea',
                                     enrollment_group_id: Utilities.getUuid() }), false);

    // (b) firma invalida — un solo caracter cambiado.
    var b = sobre(evento(), Utilities.getUuid(), new Date().toISOString());
    b.signature = (b.signature.charAt(0) === 'a' ? 'b' : 'a') + b.signature.slice(1);
    afirmar('(b) firma invalida (un caracter cambiado)', notifyLiveStateChange_(b), false);

    // (c) caducado — firmado CORRECTAMENTE, pero fuera de ventana. Comprueba que la firma no
    //     basta por si sola: repetir un mensaje viejo intacto tiene que fallar igual.
    var tsViejo = new Date(Date.now() - 20 * 60 * 1000).toISOString();
    afirmar('(c) caducado (20 min, firma correcta)',
            notifyLiveStateChange_(sobre(evento(), Utilities.getUuid(), tsViejo)), false);

    // (d) repetido — el MISMO identificador de suceso dos veces dentro de la ventana. El
    //     primero tiene que pasar; el segundo, no.
    var nonceRep = Utilities.getUuid();
    var evRep = evento();
    var tsRep = new Date().toISOString();
    var primero = notifyLiveStateChange_(sobre(evRep, nonceRep, tsRep));
    afirmar('(d.1) primero con ese identificador de suceso', primero, true);
    afirmar('(d.2) repetido con el MISMO identificador', notifyLiveStateChange_(sobre(evRep, nonceRep, tsRep)), false);

    // (e) legitimo con identificador fresco.
    afirmar('(e) legitimo, identificador fresco',
            notifyLiveStateChange_(sobre(evento(), Utilities.getUuid(), new Date().toISOString())), true);

  } catch (e) {
    fallos.push('EXCEPCION: ' + (e && e.message));
    lineas.push('  FALLO excepcion — ' + (e && e.message));
  } finally {
    lineas.forEach(function(l) { Logger.log(l); });
    var veredicto = fallos.length
      ? 'VEREDICTO: ROJO — ' + fallos.length + ' caso(s): ' + fallos.join(' · ')
      : 'VEREDICTO: VERDE';
    Logger.log(veredicto);
    return lineas.join('\n') + '\n' + veredicto;
  }
}

/**
 * Diagnostic (solo conteos, CERO datos de familia) — ¿a cuántos expedientes les
 * está pidiendo el asistente el teléfono de un tutor que la familia YA QUITÓ?
 *
 * El gemelo de este instrumento vive en el KMS (`manual_diagPersonasRetiradasDelAsistente`),
 * porque el proyecto del asistente no tiene `clasp run` enlazado y desde ahí sí se puede
 * ejecutar; lee las MISMAS tablas. Éste queda aquí para poder repetir la medida desde el
 * editor del asistente.
 *
 * Devuelve SOLO números y nombres de columna (§"PII solo en GAS, revisión humana en UI").
 */
function manual_diagPersonasRetiradas() {
  var personas  = appsheetRequest_(T.PERSONS, 'Find', [], {}) || [];
  var telefonos = appsheetRequest_(T.PHONES,  'Find', [], {}) || [];

  var columnas = personas.length ? Object.keys(personas[0]) : [];
  function telefonoValido_(ph) {
    var s = String(ph.value || ph.phone_number || '').trim();
    if (s && s[0] !== '+' && /^\d+$/.test(s)) s = '+' + s;
    return /^\+[1-9]\d{6,14}$/.test(s);
  }

  var vivosPorPersona = {};
  telefonos.forEach(function (ph) {
    if (!wizardFilaViva_(ph) || !telefonoValido_(ph)) return;
    if (ph.person_id) vivosPorPersona[ph.person_id] = (vivosPorPersona[ph.person_id] || 0) + 1;
  });

  var out = {
    columnas_de_enrPersons: columnas.length,
    tiene_deleted_at: columnas.indexOf('deleted_at') >= 0,
    tiene_is_active: columnas.indexOf('is_active') >= 0,
    personas_totales: personas.length,
    personas_retiradas: 0,
    tutores_totales: 0,
    tutores_retirados: 0,
    tutores_retirados_sin_telefono_vivo: 0,
    solicitantes_retirados: 0,
    expedientes_totales: 0,
    expedientes_bloqueados_por_un_tutor_retirado_sin_telefono: 0,
    telefonos_totales: telefonos.length,
    telefonos_retirados: 0
  };
  telefonos.forEach(function (ph) { if (!wizardFilaViva_(ph)) out.telefonos_retirados++; });

  var expedientes = {};
  personas.forEach(function (p) {
    var gid = p.enrollment_group_id || '(sin grupo)';
    expedientes[gid] = expedientes[gid] || { bloquea: 0 };
    var esTutor = p.person_type_id === 'guardian';
    if (esTutor) out.tutores_totales++;
    if (wizardFilaViva_(p)) return;
    out.personas_retiradas++;
    if (p.person_type_id === 'applicant') out.solicitantes_retirados++;
    if (!esTutor) return;
    out.tutores_retirados++;
    if (!vivosPorPersona[p.person_id]) {
      out.tutores_retirados_sin_telefono_vivo++;
      expedientes[gid].bloquea++;
    }
  });
  out.expedientes_totales = Object.keys(expedientes).length;
  Object.keys(expedientes).forEach(function (gid) {
    if (expedientes[gid].bloquea > 0) out.expedientes_bloqueados_por_un_tutor_retirado_sin_telefono++;
  });

  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

/**
 * 0º.undevicies — CUÁNTOS documentos quedan en la carpeta VIEJA (la que creaba
 * getOrCreateDriveFolder_ antes de este cambio). Solo cuenta: no mueve nada,
 * no imprime ni un dato personal (KAL-11). Moverlos es decisión de Diego.
 */
function manual_diagFicherosEnCarpetaVieja() {
  var filtro = '"school_id" = "' + appsheetEscape_(SCHOOL_ID) + '" && "origin" = "WIZARD"';
  var filas = appsheetRequest_(T.REC_FILES, 'Find', [], { Filter: filtro }) || [];
  var out = { ficheros_del_asistente_en_recFiles: filas.length };
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}
