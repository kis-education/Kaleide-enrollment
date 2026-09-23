/**
 * `_manual.gs` — EL CAJÓN DE LAS SONDAS DEL ASISTENTE. **NO VIAJA AL PROYECTO.**
 *
 * ⛔ **ESTE FICHERO ESTÁ EN `.claspignore`: NO se sube con `clasp push` y NO está en el
 * despliegue.** Apps Script ANALIZA EL PROYECTO ENTERO en cada ejecución, y estas 51
 * funciones —2.497 líneas, el 17,1 % de `Code.js` antes de este cambio— **no las invoca
 * ninguna familia jamás** (medido el 2026-09-22: 74 apariciones de sus nombres fuera de su
 * definición y **las 74 son TEXTO** de mensajes de registro o de comentarios; CERO llamadas).
 * Se parseaban en las ~120 peticiones por hora del pulso y en todas las del camino vivo.
 *
 * ⚠️ **LO QUE ESTO VALE, SIN ADORNAR: entre 0,3 y 0,7 s por llamada** (proporcional a lo que
 * se quita, por el precedente MEDIDO del KMS: sacar su 21 % bajó el tiempo un 19,4 %). Es
 * real y es gratis — **y NO es lo que hace que entrar con el código de un solo uso tarde**.
 * Eso son los VIAJES al KMS (~11 s de puro salto cada uno), que esto no toca.
 *
 * ─────────────────────────────────────────────────────────────────────────────────────────
 * CÓMO SE EJECUTA UNA DE ESTAS SONDAS — EL CICLO DE TRES ÓRDENES
 * ─────────────────────────────────────────────────────────────────────────────────────────
 *
 *   1)  Comentar la línea `_manual.gs` de `backend/.claspignore`
 *       cd backend && NODE_USE_ENV_PROXY=1 clasp push --force     # el Head, CON las sondas
 *   2)  NODE_USE_ENV_PROXY=1 clasp run manual_<la sonda que toque>
 *   3)  Restaurar `backend/.claspignore` y **VOLVER A SUBIR**     # el Head, SIN ellas
 *
 * ⛔ **LA TERCERA NO ES OPCIONAL, Y AQUÍ TIENE UNA TRAMPA QUE NO TENÍA ANTES.** Mientras las
 * sondas vivían DENTRO de `Code.js`, encoger ese fichero las quitaba del Head solo con
 * subirlo. Ahora viven en un fichero APARTE, y **`clasp push` NO BORRA del Head un fichero
 * que ya está arriba**: si en el paso (3) `clasp` decide que «el proyecto ya está al día»,
 * no sube nada y `_manual.gs` **se queda arriba**. Por eso el paso (3) termina SIEMPRE
 * **LEYENDO EL HEAD** y comprobando que `_manual.gs` no está — nunca por el «ok» del push.
 *
 * ⛔ **Y LAS TRES DE LA TRAZA VIVEN AQUÍ** (`manual_trazarArranqueON` / `manual_trazarArranqueOFF`
 * / `manual_trazaDelArranque`, D171): para medir un arranque hay que subirlas con el ciclo de
 * arriba, medir, y volver a bajarlas. **No se quedan arriba «porque hacen falta a menudo».**
 *
 * ⛔ **LO QUE NO ESTÁ AQUÍ, Y ES A PROPÓSITO:** el disparador del espejo
 * (`espejoRefrescarCopias`, `①97`) y el absorbente `wizardWarmTrigger` **NO son `manual_*` y
 * se quedan en `Code.js`** — un disparador guarda el NOMBRE de su función y, si desaparece
 * del proyecto, **falla en silencio**. Comprobado el 2026-09-22: los dos únicos nombres de
 * disparador del proyecto son ésos, y ninguno de los 51 nombres de aquí es uno de ellos.
 *
 * ⛔ **Y `manual_setWizardNotifySecret` sigue en `backend/SetupDrainSecret.gs`**, que SÍ viaja:
 * son 20 líneas y es el sembrador de un secreto que Diego ejecuta desde el editor. Moverlo
 * aquí le obligaría al ciclo de tres órdenes para una cosa que no cuesta nada tener arriba.
 *
 * ⛔ **LAS FUNCIONES DE ABAJO SON COPIA VERBATIM de `backend/Code.js`**: no se ha tocado ni
 * una línea de ningún cuerpo. Si una deja de funcionar al subirla, es porque depende de algo
 * que cambió en `Code.js`, no porque se haya movido.
 */

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
 * KMS (`enr.tutorQueRecupera`), así que esto ejercita el camino VIVO de punta a punta.
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
 * quien resuelve es el KMS (`enr.tutorQueRecupera`) — camino VIVO de punta a punta.
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
 * EL INTERRUPTOR DE LA TRAZA (D171) — ENCIENDE la traza del arranque.
 *
 * Pone la Script Property `TRAZAR_ARRANQUE` a `'true'` y DEVUELVE lo que la propiedad
 * dice después de escribirla (releída). A partir de la siguiente ejecución, cada
 * pregunta al KMS deja su línea `[TRAZA]` y `hydrateSession_` cierra con el resumen del
 * arranque y el acierto/fallo de la copia caliente. Sin ningún dato de familia (KAL-11).
 *
 * SIN ARGUMENTOS a propósito, y son DOS funciones por lo mismo: el botón «Ejecutar» del
 * editor de Apps Script NO pasa parámetros, así que una sola `manual_trazarArranque(valor)`
 * recibiría `undefined` y apagaría la traza justo cuando se quiere encender.
 *
 * ⚠️ La memoria `_trazarArranqueCache_` es POR EJECUCIÓN: esta función no la toca y no
 * hace falta: la ejecución siguiente (la petición de la familia) lee la propiedad fresca.
 *
 * @returns {{ ok: boolean, accion: string, valor: (string|null), encendida: boolean }}
 */
function manual_trazarArranqueON() {
  PropertiesService.getScriptProperties().setProperty('TRAZAR_ARRANQUE', 'true');
  // Cada medición empieza en limpio: si quedaran líneas de un clic anterior, quien las
  // leyera después mezclaría dos arranques distintos y no lo sabría.
  _trazaBorrarCapturada_();
  return _trazarArranqueEstadoReleido_('ON');
}

/**
 * EL INTERRUPTOR DE LA TRAZA (D171) — APAGA la traza del arranque.
 *
 * BORRA la Script Property `TRAZAR_ARRANQUE` (no la deja en `'false'`: `_trazarActivo_()`
 * exige `=== 'true'`, así que ausente y `'false'` son lo mismo para el camino vivo, y
 * borrarla deja las propiedades del proyecto limpias). Devuelve lo que la propiedad dice
 * después: `valor: null` y `encendida: false` es lo que hay que ver.
 *
 * SIN ARGUMENTOS — mismo motivo que su gemela de arriba.
 *
 * @returns {{ ok: boolean, accion: string, valor: (string|null), encendida: boolean }}
 */
function manual_trazarArranqueOFF() {
  PropertiesService.getScriptProperties().deleteProperty('TRAZAR_ARRANQUE');
  return _trazarArranqueEstadoReleido_('OFF');
}

/**
 * EL INTERRUPTOR DE LA TRAZA (D171) — DEVUELVE la traza capturada, para poder leerla sin
 * abrir el registro de ejecuciones.
 *
 * Existe porque el registro de este proyecto NO se puede leer desde fuera: `clasp logs`
 * necesita un `projectId` declarado en `.clasp.json`, y este proyecto no lo declara. Sin
 * esto, las líneas `[TRAZA]` existen pero hay que copiarlas a mano de la pantalla
 * «Ejecuciones» — justo el trabajo que D171 quiere quitarle a Diego.
 *
 * SIN ARGUMENTOS, como sus dos hermanas, y por el mismo motivo: el botón «Ejecutar» del
 * editor no pasa parámetros.
 *
 * NO BORRA lo que devuelve: leer dos veces da lo mismo. Lo que empieza en limpio es
 * `manual_trazarArranqueON`, que tira lo capturado antes.
 *
 * ⛔ NO compone ningún texto: devuelve las MISMAS cadenas que ya se registraban — nombres
 * de acción, milisegundos, contadores y acierto/fallo de la copia. Ni un dato de familia.
 *
 * Y de paso relee el interruptor: quien lee la traza ve, desde OTRA ejecución, si quedó
 * encendido o apagado — que es lo que acredita de verdad al ON y al OFF (una función no se
 * acredita a sí misma).
 *
 * @returns {{ ok: boolean, encendida: boolean, n: number, lineas: string[] }}
 */
function manual_trazaDelArranque() {
  var lineas = _trazaCapturada_();
  var estado = _trazarArranqueEstadoReleido_('LEER');
  Logger.log('[TRAZA-INTERRUPTOR] LEER → ' + lineas.length + ' línea(s) capturada(s)');
  return { ok: true, encendida: estado.encendida, n: lineas.length, lineas: lineas };
}

/**
 * MEDIDA 2 — ¿QUÉ PETICIONES NO VOLVIERON? Devuelve las marcas de ENTRADA que NO tienen su
 * cierre: ésas son las ejecuciones que murieron sin llegar al `finally` de `doPost`.
 *
 * ⛔ POR QUÉ NO SIRVE LA TRAZA (D171) PARA ESTO: la traza acumula sus líneas EN MEMORIA y las
 * vuelca UNA vez, en el `finally`. Una ejecución que muere por el tope de Apps Script no llega
 * a ese `finally` ⇒ SUS líneas se pierden, que es exactamente el caso que hay que ver. Por eso
 * la marca de entrada se escribe YA, en su propia llave.
 *
 * ⛔ LO QUE NO LLEVA: ni un dato de familia. Solo el NOMBRE de la acción, milisegundos y un
 * identificador acuñado AQUÍ al azar — nunca el enlace, ni el correo, ni el expediente
 * (KAL-11 · §"PII solo en GAS").
 *
 * SIN GUION BAJO FINAL, como todas las `manual_*`: con él, GAS la volvería invisible en el
 * selector del editor.
 *
 * SOLO LEE: ni escribe, ni borra, ni apaga el interruptor.
 *
 * @returns {{ ok: boolean, encendida: boolean, n_vistas: number, no_volvieron: object[], en_vuelo: object[] }}
 */
function manual_peticionesQueNoVolvieron() {
  var estado = _trazarArranqueEstadoReleido_('PETICIONES');
  var cache = CacheService.getScriptCache();

  var ids = [];
  try {
    var crudo = cache.get(PET_INDICE_CLAVE_);
    if (crudo) ids = JSON.parse(crudo) || [];
  } catch (eIx) { ids = []; }

  var muertas = [];
  var enVuelo = [];
  var ahora = Date.now();

  // El techo de ejecución de Apps Script son 6 min: por debajo de eso, una entrada sin cierre
  // puede ser sencillamente una petición que TODAVÍA está corriendo. No se cuenta como muerta.
  var TECHO_MS = 6 * 60 * 1000;

  for (var i = 0; i < ids.length; i += PET_LOTE_) {
    var trozo = ids.slice(i, i + PET_LOTE_);
    var llaves = [];
    for (var j = 0; j < trozo.length; j++) {
      llaves.push('pet_a_' + trozo[j]);
      llaves.push('pet_c_' + trozo[j]);
    }
    var leidas = {};
    try { leidas = cache.getAll(llaves) || {}; } catch (eGa) { leidas = {}; }

    for (var k = 0; k < trozo.length; k++) {
      var id = trozo[k];
      var brutoA = leidas['pet_a_' + id];
      if (!brutoA) continue;                 // caducada (30 min): no dice nada
      var entrada = null;
      try { entrada = JSON.parse(brutoA); } catch (ePa) { continue; }
      if (leidas['pet_c_' + id]) continue;   // volvió: nada que reportar

      var edad = ahora - (entrada.t || 0);
      var fila = { id: id, accion: entrada.a, hace_ms: edad };
      if (edad > TECHO_MS) muertas.push(fila); else enVuelo.push(fila);
    }
  }

  Logger.log('[PETICIONES] vistas=' + ids.length +
             ' · no_volvieron=' + muertas.length +
             ' · en_vuelo=' + enVuelo.length);

  return {
    ok: true,
    encendida: estado.encendida,
    n_vistas: ids.length,
    no_volvieron: muertas,
    en_vuelo: enVuelo
  };
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

/**
 * ⛔ SONDA DE UNA NOCHE (2026-09-11) — ¿a qué dirección del KMS habla el asistente?
 *
 * Diego, 2026-09-10: «hay que conectar el wizard ya con el despliegue PostgreSQL». Antes de
 * cambiar nada hay que saber a dónde apunta hoy. Solo LEE una propiedad del proyecto; no escribe.
 * No es un secreto: es una dirección pública de despliegue. El testigo de servicio NO se imprime.
 */
function manual_diagADondeHablaElAsistente() {
  var p = PropertiesService.getScriptProperties();
  var url = p.getProperty('KMS_DEPLOYMENT_URL') || '(sin poner)';
  var l = [];
  l.push('KMS_DEPLOYMENT_URL = ' + url);
  l.push('QB_SERVICE_TOKEN puesto: ' + (p.getProperty('QB_SERVICE_TOKEN') ? 'sí' : 'NO'));
  l.push('¿es la URL del Head (/dev)? ' + (/\/dev\/?$/.test(url) ? 'SÍ' : 'no, es /exec'));
  var txt = l.join('\n');
  Logger.log(txt);
  return txt;
}

/**
 * ⛔ CAMBIA la dirección del KMS a la que habla el asistente. Sin argumento solo INFORMA.
 * @param {string} [url] la dirección nueva (tiene que acabar en /exec o /dev)
 */
function manual_apuntarElAsistenteAlKms(url) {
  var p = PropertiesService.getScriptProperties();
  var antes = p.getProperty('KMS_DEPLOYMENT_URL') || '(sin poner)';
  if (!url) {
    var m = 'AHORA: ' + antes + '\nSin argumento no se cambia nada.';
    Logger.log(m); return m;
  }
  // ⛔ Se comprueba la FORMA antes de escribir: una dirección sin `/exec` o `/dev` no es un
  //    despliegue de Apps Script, y dejarla puesta rompe TODO el asistente en silencio.
  if (!/^https:\/\/script\.google\.com\/.*\/(exec|dev)$/.test(String(url))) {
    var e = 'NO SE CAMBIA: «' + url + '» no tiene forma de dirección de despliegue de Apps Script.';
    Logger.log(e); return e;
  }
  p.setProperty('KMS_DEPLOYMENT_URL', String(url));
  var r = 'ANTES : ' + antes + '\nAHORA : ' + p.getProperty('KMS_DEPLOYMENT_URL');
  Logger.log(r); return r;
}

/**
 * ①97 — instala el disparador del espejo A MANO (idempotente), sin esperar a que entre
 * ninguna petición. Para `clasp run` o el editor de Apps Script.
 * @returns {Object}
 */
function manual_instalarElDisparadorDelEspejo() {
  var out = { antes: 0, despues: 0, creado: false, borrados: 0 };
  try {
    var mios = ScriptApp.getProjectTriggers().filter(function(t) {
      return t.getHandlerFunction() === ESPEJO_DISPARADOR_FN_;
    });
    out.antes = mios.length;
    for (var i = 1; i < mios.length; i++) { try { ScriptApp.deleteTrigger(mios[i]); out.borrados++; } catch (_e) {} }
    if (!mios.length) {
      ScriptApp.newTrigger(ESPEJO_DISPARADOR_FN_).timeBased().everyMinutes(ESPEJO_CADA_MIN_).create();
      out.creado = true;
    }
    // Comprobación POR LECTURA, nunca por el «ok» de la escritura.
    out.despues = ScriptApp.getProjectTriggers().filter(function(t) {
      return t.getHandlerFunction() === ESPEJO_DISPARADOR_FN_;
    }).length;
    out.veredicto = (out.despues === 1) ? 'VERDE — hay exactamente UN disparador del espejo'
                                        : 'ROJO — hay ' + out.despues;
  } catch (e) { out.veredicto = 'ROJO — ' + (e && e.message); }
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

/**
 * ①97 — SOLO LECTURA: ¿está el espejo caliente, y bajo qué claves? Devuelve CONTEOS y
 * booleanos — cero correos, cero nombres, cero identificadores completos (KAL-11).
 * @returns {Object}
 */
function manual_diagElEspejo() {
  var out = { diag: 'manual_diagElEspejo', disparadores_del_espejo: 0,
              disparadores_totales: 0, cursor: null, copias_vistas: 0, detalle: [] };
  try {
    var trs = ScriptApp.getProjectTriggers();
    out.disparadores_totales = trs.length;
    out.disparadores_del_espejo = trs.filter(function(t) {
      return t.getHandlerFunction() === ESPEJO_DISPARADOR_FN_;
    }).length;
  } catch (_e) {}
  var cache = CacheService.getScriptCache();
  try { out.cursor = cache.get(ESPEJO_CURSOR_KEY_); } catch (_e2) {}
  try {
    // Pregunta al KMS QUÉ claves debería haber, y comprueba cuáles están calientes.
    var r = kmsProxy_('enr.copiasDeLasSolicitudesVivas', { desde: 0, cuantas: ESPEJO_GRUPOS_POR_VUELTA_ }) || {};
    (r.copias || []).forEach(function(c) {
      if (!c || !c.enrollment_group_id || !c.n) return;
      var key = _wzCacheKey_('hyd', String(c.enrollment_group_id) + '_' + _wzN_(String(c.n), null));
      var raw = _wzCacheGetChunked_(cache, key);
      var vigente = null, personas = null;
      if (raw) {
        try {
          var env = JSON.parse(raw);
          vigente = (env && env.v === _versionDeClase_(String(c.enrollment_group_id), 'hyd'));
          personas = (env && env.data && env.data.persons) ? env.data.persons.length : 0;
        } catch (_e3) {}
      }
      out.copias_vistas++;
      out.detalle.push({ grupo: String(c.enrollment_group_id).slice(0, 8) + '…',
                         caliente: !!raw, version_vigente: vigente, personas_n: personas });
    });
  } catch (e) { out.error = String((e && e.message) || e).slice(0, 200); }
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

/**
 * Diagnóstico de solo lectura de datos (el contenido es un blob SINTÉTICO,
 * no hay datos personales en ningún punto). Mide, contra Drive real, el
 * tiempo de subir + leer + codificar en base64 para varias tallas hasta el
 * tope de `uploadDocument_` (10 MB), y la inflación real de codificar a
 * base64 — el camino que `getDocument_` recorre en cada descarga.
 *
 * Barrido de entrada + `finally` de salida (borrado físico, verificado por
 * lectura): ①27 punto 3.
 */
function manual_medirUmbralDeBytesConFicheroReal() {
  var out = { diag: 'manual_medirUmbralDeBytesConFicheroReal', barrido_entrada: 0, medidas: [], error: null };
  try {
    out.barrido_entrada = sondaUmbralBarrerEntrada_();

    var TALLAS = [
      100 * 1024,        // 100 KB
      1 * 1024 * 1024,   // 1 MB
      5 * 1024 * 1024,   // 5 MB
      10 * 1024 * 1024   // 10 MB — el tope de MAX_BYTES en uploadDocument_
    ];
    TALLAS.forEach(function(talla) {
      out.medidas.push(sondaUmbralMedirTalla_(talla));
    });
  } catch (e) {
    out.error = String((e && e.message) || e).slice(0, 300);
  } finally {
    // Barrido de SALIDA: por si esta misma corrida dejó algo a medias.
    try { out.residuo = sondaUmbralBarrerEntrada_(); } catch (eR) { out.residuo_error = String((eR && eR.message) || eR).slice(0, 200); }
  }
  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════════════
// 2026-09-23 — QUÉ CUESTIONARIO SE ESTÁ SIRVIENDO DE VERDAD, Y CON QUÉ PERSONAS
// ═══════════════════════════════════════════════════════════════════════════════════════
//
// SOLO LECTURA. No escribe ni una clave de caché, no toca el cupo público y no llama a
// `fetchQuestions_` (que SÍ escribiría la copia y gastaría el cupo ②54, compartido por todo
// el colegio). Lee la copia con el MISMO lector del camino vivo,
// `_catalogoDePreguntasDeLaCopia_`, así que lo que devuelve es literalmente lo que el paso 5
// recibiría hoy.
//
// ⛔ CERO DATOS PERSONALES (KAL-11): códigos, conteos, booleanos y prefijos de 8 caracteres.
// Ni un nombre, ni un correo, ni una fecha de nacimiento, ni un enunciado de pregunta.
//
// Separa las DOS explicaciones de `2026-09-23-el-paso-5-no-agrupa-por-hijo`:
//   (A) los alumnos no llegan  → `personas_por_tipo` sin `applicant` en la copia servida.
//   (B) las preguntas no dicen de quién son → el catálogo trae `repeat_over_person_type_id`
//       nulo Y `audience_category_id` que no es `participant`.

/**
 * Diagnostic — qué catálogo de preguntas hay HOY en la copia del asistente, y qué personas
 * lleva la copia de la solicitud que el clic serviría. Solo lectura.
 */
function manual_diagQueCuestionarioSeEstaSirviendo() {
  var out = {
    diag: 'manual_diagQueCuestionarioSeEstaSirviendo',
    cuando: new Date().toISOString(),
    solicitudes: [],
    combinaciones: [],
    catalogos: [],
    resumen: {},
    error: null
  };
  var cache = CacheService.getScriptCache();
  var combos = {};

  // ── §A · LAS SOLICITUDES VIVAS, tal y como las ve el repaso del espejo ────────────────
  // Mismo camino que `espejoRefrescarCopias` (lectura), pero SIN archivar nada.
  try {
    var r = kmsProxy_('enr.copiasDeLasSolicitudesVivas', { desde: 0, cuantas: 25 }) || {};
    var copias = r.copias || [];
    out.resumen.grupos_totales = r.grupos_totales || 0;
    out.resumen.copias_leidas = copias.length;

    for (var i = 0; i < copias.length; i++) {
      var c = copias[i] || {};
      var gid = c.enrollment_group_id ? String(c.enrollment_group_id) : '';
      var pl = c.payload || {};
      var g = pl.group || {};
      var prog = g['program_id'] ? String(g['program_id']) : '';
      var lang = g['preferred_language'] ? String(g['preferred_language']) : 'es';

      // Personas de la copia que ACABA de mandar el KMS, por tipo declarado. Solo conteos.
      var porTipoKms = {};
      var pers = pl.persons || [];
      for (var j = 0; j < pers.length; j++) {
        var t = (pers[j] && pers[j]['person_type_id']) ? String(pers[j]['person_type_id']) : '(sin tipo)';
        porTipoKms[t] = (porTipoKms[t] || 0) + 1;
      }

      // Y las de la copia YA ARCHIVADA en este proyecto — la que el clic sirve de verdad.
      var porTipoCopia = null;
      var copiaPresente = false;
      try {
        var clave = _wzCacheKey_('hyd', gid + '_' + _wzN_(c.n, null));
        var crudo = _wzCacheGetChunked_(cache, clave);
        if (crudo) {
          copiaPresente = true;
          var sobre = JSON.parse(crudo);
          var dat = (sobre && sobre.data) || {};
          var pc = dat.persons || [];
          porTipoCopia = {};
          for (var k = 0; k < pc.length; k++) {
            var t2 = (pc[k] && pc[k]['person_type_id']) ? String(pc[k]['person_type_id']) : '(sin tipo)';
            porTipoCopia[t2] = (porTipoCopia[t2] || 0) + 1;
          }
        }
      } catch (eC) { porTipoCopia = { error: String((eC && eC.message) || eC).slice(0, 120) }; }

      out.solicitudes.push({
        grupo8: gid.slice(0, 8),
        programa_declarado: !!prog,
        programa8: prog ? prog.slice(0, 8) : null,
        lang: lang,
        personas_kms_por_tipo: porTipoKms,
        copia_archivada_presente: copiaPresente,
        personas_copia_por_tipo: porTipoCopia
      });

      if (prog) combos[prog + '|' + lang] = { program_id: prog, lang: lang };
    }
  } catch (e) {
    out.error = String((e && e.message) || e).slice(0, 300);
  }

  // ── §B · EL CATÁLOGO QUE HAY EN LA COPIA, por combinación (PROGRAMA × idioma) ─────────
  var claves = Object.keys(combos);
  out.resumen.combinaciones = claves.length;
  for (var m = 0; m < claves.length; m++) {
    var cb = combos[claves[m]];
    out.combinaciones.push({ programa8: cb.program_id.slice(0, 8), lang: cb.lang });
    var ficha = {
      programa8: cb.program_id.slice(0, 8),
      lang: cb.lang,
      copia_presente: false,
      sets: [],
      preguntas_totales: 0,
      por_audiencia: {},
      por_repeat_over: {}
    };
    try {
      var cat = _catalogoDePreguntasDeLaCopia_('ENROLLMENT', cb.lang, cb.program_id);
      if (cat) {
        ficha.copia_presente = true;
        var sets = cat.sets || [];
        for (var s = 0; s < sets.length; s++) {
          var st = sets[s] || {};
          var items = st.items || [];
          var fichaSet = {
            set8: st.set_id ? String(st.set_id).slice(0, 8) : null,
            designacion: st.designation || null,   // configuración del centro, no dato personal
            preguntas: items.length,
            detalle: []
          };
          for (var q = 0; q < items.length; q++) {
            var qq = (items[q] && items[q].question) || null;
            if (!qq) { fichaSet.detalle.push({ q8: null, nota: 'item sin question' }); continue; }
            var aud = qq['audience_category_id'];
            var rep = qq['repeat_over_person_type_id'];
            var audTxt = (aud === undefined) ? '(ausente)' : (aud === null ? '(null)' : String(aud));
            var repTxt = (rep === undefined) ? '(ausente)' : (rep === null ? '(null)' : String(rep));
            fichaSet.detalle.push({
              q8: qq['question_id'] ? String(qq['question_id']).slice(0, 8) : null,
              audience_category_id: audTxt,
              repeat_over_person_type_id: repTxt
            });
            ficha.preguntas_totales++;
            ficha.por_audiencia[audTxt] = (ficha.por_audiencia[audTxt] || 0) + 1;
            ficha.por_repeat_over[repTxt] = (ficha.por_repeat_over[repTxt] || 0) + 1;
          }
          ficha.sets.push(fichaSet);
        }
      }
    } catch (eB) { ficha.error = String((eB && eB.message) || eB).slice(0, 200); }
    out.catalogos.push(ficha);
  }

  Logger.log(JSON.stringify(out, null, 2));
  return out;
}

/**
 * Diagnostic — la MISMA medida de arriba, devuelta como TEXTO plano en líneas.
 * `clasp run` imprime los objetos anidados como `[Object]`, así que lo que hay que leer
 * desde fuera tiene que salir aplanado. Sigue siendo SOLO LECTURA: llama a la sonda de
 * arriba y solo le da forma. ⛔ CERO datos personales (KAL-11).
 */
function manual_diagQueCuestionarioSeEstaSirviendoTexto() {
  var o = manual_diagQueCuestionarioSeEstaSirviendo();
  var L = [];
  L.push('== ' + o.cuando + ' == error=' + o.error);
  L.push('resumen: ' + JSON.stringify(o.resumen));
  (o.solicitudes || []).forEach(function(s) {
    L.push('SOLICITUD ' + s.grupo8 + ' lang=' + s.lang + ' prog=' + s.programa8 +
      ' copiaArchivada=' + s.copia_archivada_presente +
      ' | personasKMS=' + JSON.stringify(s.personas_kms_por_tipo) +
      ' | personasCOPIA=' + JSON.stringify(s.personas_copia_por_tipo));
  });
  (o.catalogos || []).forEach(function(c) {
    L.push('CATALOGO prog=' + c.programa8 + ' lang=' + c.lang + ' presente=' + c.copia_presente +
      ' preguntas=' + c.preguntas_totales +
      ' | porAudiencia=' + JSON.stringify(c.por_audiencia) +
      ' | porRepeatOver=' + JSON.stringify(c.por_repeat_over) +
      (c.error ? (' | error=' + c.error) : ''));
    (c.sets || []).forEach(function(st) {
      L.push('  SET ' + st.set8 + ' preguntas=' + st.preguntas + ' « ' + st.designacion + ' »');
      var porPar = {};
      (st.detalle || []).forEach(function(d) {
        var par = d.audience_category_id + ' / ' + d.repeat_over_person_type_id;
        porPar[par] = (porPar[par] || 0) + 1;
      });
      L.push('      aud/repeat: ' + JSON.stringify(porPar));
    });
  });
  var texto = L.join('\n');
  Logger.log(texto);
  return texto;
}

/**
 * Diagnostic — COMPARA, conjunto a conjunto, lo que hay GUARDADO en la copia del asistente
 * con lo que el KMS contesta AHORA para la misma combinación (programa × idioma).
 *
 * ⛔ SOLO LECTURA: llama al KMS por el transporte único (`kmsProxy_`) **sin pasar por
 * `fetchQuestions_`**, así que NO escribe la copia y NO gasta el cupo público ②54 (que es
 * compartido por todas las familias del colegio). ⛔ CERO datos personales (KAL-11): códigos,
 * conteos y la designación del conjunto, que es configuración del centro.
 *
 * Contesta la pregunta que separa las dos causas: un conjunto que sale SIN CUERPO ¿lo sirve
 * así el KMS (⇒ configuración del centro), o solo lo tiene así la copia guardada (⇒ una
 * lectura a medias que se quedó clavada)?
 */
function manual_diagElCatalogoGuardadoContraElVivo() {
  var L = [];
  try {
    var r = kmsProxy_('enr.copiasDeLasSolicitudesVivas', { desde: 0, cuantas: 25 }) || {};
    var combos = {};
    (r.copias || []).forEach(function(c) {
      var g = (c && c.payload && c.payload.group) || {};
      var prog = g['program_id'] ? String(g['program_id']) : '';
      if (!prog) return;
      var lang = g['preferred_language'] ? String(g['preferred_language']) : 'es';
      combos[prog + '|' + lang] = { program_id: prog, lang: lang };
    });

    Object.keys(combos).forEach(function(k) {
      var cb = combos[k];
      L.push('== prog=' + cb.program_id.slice(0, 8) + ' lang=' + cb.lang + ' ==');

      var guardado = _catalogoDePreguntasDeLaCopia_('ENROLLMENT', cb.lang, cb.program_id);
      var receptor = { locale: cb.lang, program_id: cb.program_id };
      var vivo = fetchQuestions_adaptKmsResponse_(kmsProxy_('qb-public.resolveSetForConsumer', {
        consumer_code: 'ADMISSIONS_WIZARD',
        context_code:  'ENROLLMENT',
        receptor:      receptor,
        school_id:     SCHOOL_ID,
      }), cb.lang);

      var porSet = {};
      function contar(cat, donde) {
        ((cat && cat.sets) || []).forEach(function(st) {
          var id = st.set_id ? String(st.set_id).slice(0, 8) : '(sin id)';
          if (!porSet[id]) porSet[id] = { designacion: st.designation || null, guardado: null, vivo: null };
          porSet[id].designacion = porSet[id].designacion || st.designation || null;
          porSet[id][donde] = ((st.items || []).length);
        });
      }
      contar(guardado, 'guardado');
      contar(vivo, 'vivo');

      L.push('  sets guardado=' + ((guardado && guardado.sets) || []).length +
             '  sets vivo=' + ((vivo && vivo.sets) || []).length);
      Object.keys(porSet).forEach(function(id) {
        var f = porSet[id];
        L.push('  SET ' + id + ' guardado=' + f.guardado + ' vivo=' + f.vivo +
               (f.guardado === f.vivo ? '  (igual)' : '  ⚠ DISTINTO') + ' « ' + f.designacion + ' »');
      });
    });
  } catch (e) {
    L.push('ERROR: ' + String((e && e.message) || e).slice(0, 300));
  }
  var texto = L.join('\n');
  Logger.log(texto);
  return texto;
}

/**
 * Diagnostic — ¿el conjunto que sale sin cuerpo se vacía por el PROGRAMA (D181) o viene
 * vacío de todas formas? Pregunta al KMS la MISMA combinación con programa y SIN programa,
 * y compara conjunto a conjunto. ⛔ SOLO LECTURA (no toca la copia ni el cupo público ②54)
 * y CERO datos personales.
 */
function manual_diagElConjuntoVacioEsDelPrograma() {
  var L = [];
  try {
    var r = kmsProxy_('enr.copiasDeLasSolicitudesVivas', { desde: 0, cuantas: 25 }) || {};
    var combos = {};
    (r.copias || []).forEach(function(c) {
      var g = (c && c.payload && c.payload.group) || {};
      var prog = g['program_id'] ? String(g['program_id']) : '';
      if (!prog) return;
      combos[prog + '|' + (g['preferred_language'] || 'es')] =
        { program_id: prog, lang: String(g['preferred_language'] || 'es') };
    });
    Object.keys(combos).forEach(function(k) {
      var cb = combos[k];
      function pedir(conPrograma) {
        var receptor = { locale: cb.lang };
        if (conPrograma) receptor.program_id = cb.program_id;
        return fetchQuestions_adaptKmsResponse_(kmsProxy_('qb-public.resolveSetForConsumer', {
          consumer_code: 'ADMISSIONS_WIZARD',
          context_code:  'ENROLLMENT',
          receptor:      receptor,
          school_id:     SCHOOL_ID,
        }), cb.lang);
      }
      var con = pedir(true), sin = pedir(false);
      var porSet = {};
      function contar(cat, donde) {
        ((cat && cat.sets) || []).forEach(function(st) {
          var id = st.set_id ? String(st.set_id).slice(0, 8) : '(sin id)';
          if (!porSet[id]) porSet[id] = { d: st.designation || null, con: null, sin: null };
          porSet[id][donde] = ((st.items || []).length);
        });
      }
      contar(con, 'con'); contar(sin, 'sin');
      L.push('== prog=' + cb.program_id.slice(0, 8) + ' lang=' + cb.lang + ' ==');
      L.push('  sets CON programa=' + ((con && con.sets) || []).length +
             '  SIN programa=' + ((sin && sin.sets) || []).length);
      Object.keys(porSet).forEach(function(id) {
        var f = porSet[id];
        L.push('  SET ' + id + ' conPrograma=' + f.con + ' sinPrograma=' + f.sin +
               (f.con === f.sin ? '  (igual)' : '  ⚠ LO VACÍA EL PROGRAMA') + ' « ' + f.d + ' »');
      });
    });
  } catch (e) { L.push('ERROR: ' + String((e && e.message) || e).slice(0, 300)); }
  var texto = L.join('\n');
  Logger.log(texto);
  return texto;
}

/**
 * Diagnostic — QUÉ CONDICIONES lleva cada pregunta del catálogo servido. Son configuración
 * del centro (tipo de condición, operador y valor declarado), no datos de nadie.
 * ⛔ SOLO LECTURA y CERO datos personales (KAL-11): ni una fecha de nacimiento, ni un nombre.
 *
 * Para qué: un conjunto cuyas preguntas TODAS exigen una edad puede dejar fuera a un hermano
 * entero. Si NINGÚN conjunto condiciona por edad, los dos hermanos tienen preguntas y la
 * pantalla tiene que agrupar por hijo.
 */
function manual_diagQueCondicionesLlevanLasPreguntas() {
  var L = [];
  try {
    var r = kmsProxy_('enr.copiasDeLasSolicitudesVivas', { desde: 0, cuantas: 25 }) || {};
    var combos = {};
    (r.copias || []).forEach(function(c) {
      var g = (c && c.payload && c.payload.group) || {};
      var prog = g['program_id'] ? String(g['program_id']) : '';
      if (!prog) return;
      combos[prog + '|' + (g['preferred_language'] || 'es')] =
        { program_id: prog, lang: String(g['preferred_language'] || 'es') };
    });
    Object.keys(combos).forEach(function(k) {
      var cb = combos[k];
      var cat = _catalogoDePreguntasDeLaCopia_('ENROLLMENT', cb.lang, cb.program_id);
      L.push('== prog=' + cb.program_id.slice(0, 8) + ' lang=' + cb.lang +
             ' copia=' + (!!cat) + ' ==');
      ((cat && cat.sets) || []).forEach(function(st) {
        var items = st.items || [];
        var conCond = 0, tipos = {};
        items.forEach(function(it) {
          var q = it && it.question;
          var cs = (q && q.conditions) || [];
          if (cs.length) conCond++;
          cs.forEach(function(cd) {
            var tipo = String((cd && (cd.condition_type || cd.condition_type_code ||
                         cd.type || cd.kind)) || '(sin tipo)');
            var op = String((cd && (cd.condition_operator || cd.operator)) || '');
            var val = String((cd && (cd.condition_value != null ? cd.condition_value :
                        (cd.value != null ? cd.value : ''))));
            var et = tipo + ' ' + op + ' ' + val;
            tipos[et] = (tipos[et] || 0) + 1;
          });
        });
        L.push('  SET ' + (st.set_id ? String(st.set_id).slice(0, 8) : '?') +
               ' preguntas=' + items.length + ' conCondicion=' + conCond +
               ' | ' + JSON.stringify(tipos) + ' « ' + st.designation + ' »');
      });
    });
  } catch (e) { L.push('ERROR: ' + String((e && e.message) || e).slice(0, 300)); }
  var texto = L.join('\n');
  Logger.log(texto);
  return texto;
}

/**
 * Diagnostic — ¿los DOS hermanos siguen VIVOS en la copia que sirve el clic? Aplica a las
 * personas de la copia archivada el MISMO juez del camino vivo (`wizardSoloVivas_`), que es
 * lo que decide quién sigue en la solicitud. ⛔ SOLO LECTURA y solo conteos (KAL-11).
 */
function manual_diagCuantosHermanosVivosLlevaLaCopia() {
  var L = [];
  try {
    var cache = CacheService.getScriptCache();
    var r = kmsProxy_('enr.copiasDeLasSolicitudesVivas', { desde: 0, cuantas: 25 }) || {};
    (r.copias || []).forEach(function(c) {
      var gid = c && c.enrollment_group_id ? String(c.enrollment_group_id) : '';
      if (!gid) return;
      var pl = c.payload || {};
      function porTipo(lista) {
        var o = {};
        (lista || []).forEach(function(p) {
          var t = (p && p['person_type_id']) ? String(p['person_type_id']) : '(sin tipo)';
          o[t] = (o[t] || 0) + 1;
        });
        return o;
      }
      var crudasKms = pl.persons || [];
      var vivasKms = wizardSoloVivas_(crudasKms);
      var linea = 'GRUPO ' + gid.slice(0, 8) + ' n=' + String(c.n || '').slice(0, 8) +
        ' | KMS crudas=' + JSON.stringify(porTipo(crudasKms)) +
        ' vivas=' + JSON.stringify(porTipo(vivasKms));
      try {
        var crudo = _wzCacheGetChunked_(cache, _wzCacheKey_('hyd', gid + '_' + _wzN_(c.n, null)));
        if (crudo) {
          var dat = (JSON.parse(crudo) || {}).data || {};
          var cp = dat.persons || [];
          linea += ' | COPIA crudas=' + JSON.stringify(porTipo(cp)) +
                   ' vivas=' + JSON.stringify(porTipo(wizardSoloVivas_(cp)));
        } else { linea += ' | COPIA ausente'; }
      } catch (e2) { linea += ' | COPIA error'; }
      L.push(linea);
    });
  } catch (e) { L.push('ERROR: ' + String((e && e.message) || e).slice(0, 300)); }
  var texto = L.join('\n');
  Logger.log(texto);
  return texto;
}

/**
 * Diagnostic — los dos últimos datos del servidor que pueden tumbar la agrupación por hijo,
 * y el cupo público. ⛔ SOLO LECTURA (no incrementa el cupo) y solo conteos y booleanos.
 *
 *  (1) ¿Cada persona de la copia lleva `person_id`? La pantalla agrupa por
 *      `person_id || _uid`: si los dos hermanos llegaran SIN identificador, los dos caerían
 *      en la misma casilla y la pantalla creería que hay UN solo hijo.
 *  (2) ¿Está gastado el cupo público del catálogo (②54)? Con el cupo agotado, la revalidación
 *      del navegador falla y el asistente se queda pintando el catálogo VIEJO que ese
 *      navegador tenga guardado (hasta 30 días, `QCACHE_LS_MAXAGE_MS`).
 */
function manual_diagLoQuePuedeTumbarLaAgrupacion() {
  var L = [];
  try {
    var r = kmsProxy_('enr.copiasDeLasSolicitudesVivas', { desde: 0, cuantas: 25 }) || {};
    (r.copias || []).forEach(function(c) {
      var pl = (c && c.payload) || {};
      var con = 0, sin = 0, idsDistintos = {};
      (pl.persons || []).forEach(function(p) {
        var id = p && p['person_id'] ? String(p['person_id']) : '';
        if (id) { con++; idsDistintos[id] = 1; } else { sin++; }
      });
      L.push('GRUPO ' + String(c.enrollment_group_id || '').slice(0, 8) +
        ' personas conPersonId=' + con + ' sinPersonId=' + sin +
        ' identificadoresDistintos=' + Object.keys(idsDistintos).length);
    });
  } catch (e) { L.push('ERROR personas: ' + String((e && e.message) || e).slice(0, 200)); }

  try {
    var cache = CacheService.getScriptCache();
    ['es-es', 'es', 'en', 'en-gb'].forEach(function(idioma) {
      var k = 'catrl_preguntas_' + SCHOOL_ID + '_' + idioma;
      var v = cache.get(k);
      L.push('CUPO ②54 ' + idioma + ' = ' + (v === null || v === undefined ? '(sin cuenta esta hora)' : v) +
             ' de 300');
    });
  } catch (e2) { L.push('ERROR cupo: ' + String((e2 && e2.message) || e2).slice(0, 200)); }

  var texto = L.join('\n');
  Logger.log(texto);
  return texto;
}
