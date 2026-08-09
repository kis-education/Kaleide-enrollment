/**
 * mock-backend.mjs — el backend SIMULADO contra el que corre la batería del wizard.
 *
 * NADA de esto toca datos reales ni manda un solo email: es un servidor local que
 * responde a las MISMAS acciones que el dispatcher de `backend/Code.js`, con datos
 * SINTÉTICOS (dominio `.invalid`, reservado por RFC 2606 — nunca puede ser el buzón
 * de una familia). El wizard compilado apunta aquí vía `VITE_GAS_ENDPOINT=/__gas`.
 *
 * Las FORMAS de respuesta están copiadas del contrato real, no inventadas:
 *   · hydrateSession  → backend/Code.js:7110 hydrateSession_ (bloque de retorno
 *                       :7143 gateado / :7302 fresco) + el bloque `admission` que
 *                       arma el KMS en kms-server/enr/wizard-gateway.gs:750.
 *   · sendMagicLink   → ack CONSTANTE `{sent:true, warm_ticket}` (WIZ-ENUM,
 *                       backend/Code.js `_magicLinkConstantAck_`).
 *   · saveStep / uploadDocument / getSubscriptionBudget / getSavedBillingSplits →
 *                       las respuestas que consumen WizardPage.handleNext,
 *                       Step6Documents.doUpload y Step8Billing.
 *
 * Un `action` que la batería NO conozca se responde con error explícito y se
 * CONTABILIZA como acción no simulada: es deriva de contrato y sale en el resumen.
 */

// ── Datos sintéticos (ningún dato real; `.invalid` nunca enruta) ──────────────
export const FIXTURE = {
  groupId:        '11111111-1111-4111-8111-111111111111',
  resumeToken:    '22222222-2222-4222-8222-222222222222',
  emailId:        '33333333-3333-4333-8333-333333333333',
  programId:      '44444444-4444-4444-8444-444444444444',
  guardian1Id:    'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  guardian2Id:    'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa',
  applicantId:    'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb',
  applicant2Id:   'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
  // El nombre que la batería localiza en el formulario y reescribe (marcador único).
  guardian1Name:  'RobotUnoE2E',
  applicantName:  'RobotHijoE2E',
  emailKnown:     'familia.conocida.e2e@example.invalid',
  emailUnknown:   'nadie.desconocido.e2e@example.invalid',
  startDateSep:   '2026-09-01',
  fileId:         'cccccccc-1111-4111-8111-cccccccccccc',
};

const guardian = (id, first) => ({
  person_id:       id,
  person_type_id:  'guardian',
  first_name:      first,
  last_name:       'PruebaE2E',
  date_of_birth:   '1985-05-05',
  phones:          [{ value: '+34600000001', is_default: 'TRUE' }],
  emails:          [{ value: FIXTURE.emailKnown, is_default: 'TRUE' }],
  nationalities:   [],
  ids:             [],
  address:         { address_line_1: 'Calle Falsa 1', city: 'Las Palmas', country_id: 'ES', zip: '35001' },
});

const applicant = (id, first) => ({
  person_id:       id,
  person_type_id:  'applicant',
  first_name:      first,
  last_name:       'PruebaE2E',
  date_of_birth:   '2018-03-03',
  phones:          [],
  emails:          [],
  nationalities:   [],
  ids:             [],
  allergies:       [],
  dietary:         [],
  medical:         [],
  address:         { address_line_1: 'Calle Falsa 1', city: 'Las Palmas', country_id: 'ES', zip: '35001' },
});

const LOOKUPS = {
  programs: [{
    program_id:       FIXTURE.programId,
    designation:      'Admisión Curso 2026/27 (E2E)',
    period_starts_on: FIXTURE.startDateSep,
  }],
  // ── LA FORMA ES LA DEL SERVIDOR DE VERDAD, no una inventada ─────────────────────
  // Aquí ponía `{relation_type_id, designation}`. El KMS sirve `{id, label}` — lo arma el
  // mapeo `lk()` de `kms-server/enr/wizard-gateway.gs:663-668` — y la pantalla lee `rt.id`
  // y `rt.label` (`Step3Relations.jsx:235-236`). Con la forma vieja NINGUNA opción del
  // desplegable tenía valor ⇒ no se podía elegir tipo ⇒ «Continuar» quedaba deshabilitado.
  // Un banco de pruebas que sirve un contrato distinto del real no puede cazar nada: por
  // eso la batería pasaba en verde con el paso 3 roto. Un simulado que miente es peor que
  // no tenerlo.
  relationTypes: [
    { id: 'rt_mother', label: 'Madre',  inverse_relation_type_id: 'rt_child' },
    { id: 'rt_father', label: 'Padre',  inverse_relation_type_id: 'rt_child' },
    { id: 'rt_child',  label: 'Hijo/a', inverse_relation_type_id: 'rt_mother' },
  ],
  // Catálogo de salud CON contenido. Estaba vacío, y un catálogo vacío no es un motivo
  // válido para no cubrir un paso — la propia batería lo prohíbe con todas las letras
  // («NO se admite como motivo "los datos simulados están vacíos": eso se ARREGLA»).
  // Sin él, el paso 4 no se podía ejercitar desde la pantalla ni en simulado, y por eso
  // un `0 de 1` contra el sistema real no se podía atribuir: ¿no guarda el producto, o no
  // registra la elección el robot? Con esto, esa pregunta se contesta sin gastar corrida.
  allergies: [
    { id: 'al_lactosa',   label: 'Lactosa' },
    { id: 'al_cacahuete', label: 'Cacahuete' },
  ],
  dietary: [
    { id: 'di_vegetariana', label: 'Vegetariana' },
    { id: 'di_halal',       label: 'Halal' },
  ],
  medical: [
    { id: 'me_asma',    label: 'Asma' },
    { id: 'me_alergia', label: 'Alergia estacional' },
  ],
};

/**
 * CATÁLOGO DE PREGUNTAS — real, no vacío. Hasta el 2026-08-04 este banco servía
 * `{ sets: [] }` en la hidratación Y en `fetchQuestions`: es decir, simulaba
 * PERMANENTEMENTE el estado que rompía a la familia (cuestionario apagado) y la batería
 * salía verde igual, porque nadie afirmaba nada sobre el paso 5. Ahora el banco sirve un
 * catálogo de verdad y el fallo se pide EXPLÍCITAMENTE con `scenario.preguntasMode`.
 *
 * Forma: la que emite `fetchQuestions_adaptKmsResponse_` del backend real.
 */
/** Lo que la familia dejó escrito en la primera pregunta. La batería lo busca EN PANTALLA. */
export const RESPUESTA_GUARDADA = 'lo que el robot dejo escrito'

const QUESTIONS = {
  context: { context_id: 'ctx-e2e', context_code: 'ENROLLMENT', designation: 'ENROLLMENT', is_active: true },
  sets: [{
    set_id: 'set-e2e-1',
    set_code: 'E2E_BASICO',
    context_id: 'ctx-e2e',
    designation: 'Preguntas del robot',
    description: '',
    is_active: true,
    is_default_for_context: true,
    items: [
      {
        set_id: 'set-e2e-1', question_id: 'q-e2e-1', display_order: 0,
        question: {
          question_id: 'q-e2e-1', question_code: 'e2e_texto',
          response_type_id: 'TEXT', response_type_code: 'TEXT',
          is_required: false, audience_category_id: null,
          question_text: 'Cuenta algo del robot', help_text: '', placeholder_text: '',
          options: [], conditions: [],
        },
      },
      {
        set_id: 'set-e2e-1', question_id: 'q-e2e-2', display_order: 1,
        question: {
          question_id: 'q-e2e-2', question_code: 'e2e_texto_2',
          response_type_id: 'TEXT', response_type_code: 'TEXT',
          is_required: false, audience_category_id: null,
          question_text: 'Y otra cosa más', help_text: '', placeholder_text: '',
          options: [], conditions: [],
        },
      },
    ],
  }],
};

/**
 * Construye la respuesta de `hydrateSession` para una ETAPA del expediente.
 * La etapa decide qué datos trae → y por tanto en qué paso aterriza el wizard
 * (WizardContext.hydrateFromResume infiere `completedSteps` de los datos).
 *
 * @param {'sin_fecha'|'hasta_preguntas'|'firma'} stage
 */
export function buildHydrate(stage, preguntasMode, respuestasMode) {
  const group = {
    enrollment_group_id: FIXTURE.groupId,
    resume_token:        FIXTURE.resumeToken,
    primary_email:       FIXTURE.emailKnown,
    program_id:          FIXTURE.programId,
    desired_start_date:  stage === 'sin_fecha' ? null : FIXTURE.startDateSep,
    submitted_at:        (stage === 'firma' || stage === 'enviada') ? '2026-07-01T10:00:00Z' : null,
  };

  const base = {
    group,
    enrollments:    [{ enrollment_id: 'e1', desired_start_date: group.desired_start_date }],
    persons:        [],
    relations:      [],
    documents:      [],
    responses:      [],
    lookups:        LOOKUPS,
    // El servidor ARREGLADO no manda `{sets:[]}` cuando falla: RETIRA la clave y marca
    // `questions_no_disponible` (backend/Code.js, wizardResolverPreguntasDeHidratacion_).
    // Por eso el modo de fallo aquí no siembra vacío — no manda catálogo.
    ...(preguntasMode === 'caido'
      ? { questions_no_disponible: true }
      : { questions: QUESTIONS }),
    billing_splits: { payers: [], per_participant: [] },
    live_version:   1,
    admission:      null,
    step_up_fresh:  true,   // gracia del magic-link → sin OTP (backend/Code.js:7124)
    pii_gated:      false,
  };

  if (stage === 'sin_fecha') return base;

  const persons = [
    guardian(FIXTURE.guardian1Id, FIXTURE.guardian1Name),
    guardian(FIXTURE.guardian2Id, 'RobotDosE2E'),
    applicant(FIXTURE.applicantId, FIXTURE.applicantName),
    // DOS aplicantes, no uno. Con uno solo la pantalla pintaba sus dos tarjetas YA
    // RELLENAS desde la hidratación ⇒ el paso salía LIMPIO, `isStepDirty` decía que no y
    // NO se guardaba nada: el alta de vínculos no se ejercitaba jamás. La familia del
    // robot contra el sistema real son 2 tutores y 2 hijos; el banco tiene que serlo
    // también o mide otro caso.
    applicant(FIXTURE.applicant2Id, 'RobotHijoDosE2E'),
  ];
  const relations = [
    { relation_id: 'r1', pair_id: 'p1', from_person_id: FIXTURE.guardian1Id, to_person_id: FIXTURE.applicantId,
      relation_type_id: 'rt_mother', is_custodial: 'TRUE', is_pick_up_authorized: 'TRUE' },
    { relation_id: 'r2', pair_id: 'p2', from_person_id: FIXTURE.guardian2Id, to_person_id: FIXTURE.applicantId,
      relation_type_id: 'rt_father', is_custodial: 'TRUE', is_pick_up_authorized: 'TRUE' },
  ];

  if (stage === 'hasta_preguntas') {
    // fecha + personas + relaciones + salud visitada + respuestas ⇒ completos 0..4,
    // documentos vacíos ⇒ primer paso incompleto = Documentos (índice 5).
    return {
      ...base,
      persons,
      relations,
      // La respuesta apunta a una pregunta REAL del catálogo y al sujeto con el que la
      // pantalla la busca. Antes era `q1` con un tutor: una pregunta que no existe y un
      // sujeto que no se usa, así que solo servía para dar el paso por visitado y NUNCA
      // llegaba a pintarse. Con eso, la batería no podía ver el defecto de la cola
      // 18.bis.25 (las respuestas no vuelven) — y no lo vio.
      // Las preguntas del catálogo del robot son GENERALES (`audience_category_id: null`),
      // y para ésas la pantalla compone la clave con el EXPEDIENTE
      // (`QbSetRenderer/index.jsx:172`), no con una persona.
      // `respuestasMode` decide CONTRA QUIÉN vuelve la respuesta:
      //   'ok'              → contra el EXPEDIENTE, que es como lo guarda el KMS arreglado.
      //   'contra_un_tutor' → contra el PRIMER TUTOR, que es como lo guardó durante un
      //                       tiempo y por lo que Diego vio su cuestionario EN BLANCO el
      //                       2026-08-09 (31 respuestas guardadas, 0 pintadas). La familia
      //                       debe seguir viendo lo que escribió: el dato viejo sigue en la
      //                       base de datos y no se le puede pedir que lo vuelva a teclear.
      responses: [
        {
          question_id: 'q-e2e-1',
          respondent_id: respuestasMode === 'contra_un_tutor' ? FIXTURE.guardian1Id : FIXTURE.groupId,
          response_text: RESPUESTA_GUARDADA,
        },
      ],
    };
  }

  if (stage === 'lista_para_enviar') {
    // Todo relleno HASTA documentos incluidos y SIN enviar ⇒ el primer paso incompleto es
    // Revisión (índice 6), que es donde vive el botón de enviar. Hacía falta un escalón
    // así: `hasta_preguntas` aterriza en Documentos y `enviada` ya está enviada, con lo
    // que ningún recorrido llegaba a pulsar «Enviar» sobre un expediente todavía abierto.
    return {
      ...base,
      persons,
      relations,
      responses: [{ question_id: 'q-e2e-1', respondent_id: FIXTURE.groupId, response_text: RESPUESTA_GUARDADA }],
      documents: [{ file_id: FIXTURE.fileId, filename: 'doc-e2e.pdf', description: 'Documento de prueba' }],
      recovered_guardian_person_id: FIXTURE.guardian1Id,
    };
  }

  if (stage === 'enviada') {
    // Expediente YA ENVIADO y SIN admitir: la familia aterriza en Revisión (índice 6)
    // viendo «solicitud enviada». Es la pantalla donde vive «necesito corregir algo»
    // (cola 18.quater). No es lo mismo que `firma`: ahí ya está admitida y el wizard
    // la lleva al tramo de firma, donde ese botón no pinta nada.
    return {
      ...base,
      persons,
      relations,
      responses: [{ question_id: 'q1', respondent_id: FIXTURE.guardian1Id, response_text: 'sí' }],
      recovered_guardian_person_id: FIXTURE.guardian1Id,
      admission: {
        state_code:        'RQ',
        state_label:       'Solicitada',
        editable:          false,     // enviada ⇒ bloqueada para editar
        signing_available: false,
        signing_ready:     false,
        signing_status:    null,
      },
    };
  }

  // stage === 'firma': expediente ADMITIDO, firma abierta para este guardian y
  // ningún sub-paso completado ⇒ aterriza en el primer paso de firma (índice 7).
  return {
    ...base,
    persons,
    relations,
    responses: [{ question_id: 'q1', respondent_id: FIXTURE.guardian1Id, response_text: 'sí' }],
    recovered_guardian_person_id: FIXTURE.guardian1Id,
    admission: {
      state_code:        'AD',
      state_label:       'Admitida',
      editable:          false,
      signing_available: true,
      signing_ready:     true,
      signing_status:    'READY',
      signing_context: {
        signer_id:  'signer-e2e-1',
        session_id: 'sess-e2e-1',
        steps: { billing_confirmed: false, gdpr_completed: false, review_completed: false, signed: false },
      },
    },
  };
}

/**
 * Devuelve el manejador de acciones. `scenario` es MUTABLE entre recorridos: cada
 * camino lo reconfigura antes de navegar (los recorridos corren en serie).
 */
export function createDispatcher(scenario, record) {
  const H = {
    // ── Portada ───────────────────────────────────────────────────────────────
    sendMagicLink: (p) => {
      if (scenario.magicLinkMode === 'legacy_error') {
        // El comportamiento PRE-WIZ-ENUM: el servidor delataba que el email no
        // tenía expediente. La batería lo usa para comprobar que el cliente YA NO
        // ramifica sobre esa señal (era el casi-incidente del 2026-07-27).
        return { ok: false, error: 'Enrollment group not found' };
      }
      // Ack CONSTANTE — idéntico exista o no el email (WIZ-ENUM / KAL-10).
      return { ok: true, sent: true, warm_ticket: '99999999-9999-4999-8999-999999999999' };
    },
    warmBundle:            () => ({ ok: true }),
    warmSession:           () => ({ ok: true, warmed: true }),
    verifyRecaptcha:       () => ({ ok: true, score: 0.9 }),
    initEnrollmentSession: (p) => ({ ok: true, enrollment_group_id: FIXTURE.groupId }),

    // ── Recuperación / sesión ────────────────────────────────────────────────
    hydrateSession: () => ({ ok: true, ...buildHydrate(scenario.stage, scenario.preguntasMode, scenario.respuestasMode) }),
    getAdmissionState: () => {
      const h = buildHydrate(scenario.stage);
      return { ok: true, ...(h.admission || { state_code: null }) };
    },
    getLiveStateVersion: () => ({ ok: true, version: 1 }),
    abandonSession:      () => ({ ok: true, abandoned: true }),
    // Cola 18.quater — la familia pide corregir. `correccionMode` decide qué contesta
    // el KMS: 'ok' (marca completada) o 'no_declarada' (el colegio aún no la declaró).
    // Los DOS tienen que verse distintos en pantalla; ése es el fondo del asunto.
    requestCorrection: () => (scenario.correccionMode === 'no_declarada'
      ? { ok: true, requested: false, marked: 0, reason: 'MILESTONE_TYPE_NOT_FOUND' }
      : { ok: true, requested: true, marked: 1 }),

    reportUnsolicited:   () => ({ ok: true }),

    // Cola 18.bis.8 — la familia QUITA algo de su solicitud. `quitarMode` decide qué
    // contesta el KMS, y los tres tienen que verse DISTINTOS en pantalla:
    //   · 'ok'         → se quitó de verdad;
    //   · 'no_se_puede'→ es el último tutor / el solicitante / el correo de vuelta;
    //   · 'enviada'    → la solicitud ya está enviada, no se quita nada.
    // El caso que protege es el segundo y el tercero: si la pantalla los trata como un
    // «sí», la familia cree que quitó a alguien que sigue en su expediente — y ése es
    // exactamente el defecto que este cambio vino a cerrar.
    retirarDelExpediente: (p) => {
      const it = (Array.isArray(p.retirar) ? p.retirar : [])[0] || {};
      if (scenario.quitarMode === 'enviada') {
        return { ok: true, retirados: 0, resultados: [],
          bloqueado: 'YA_ENVIADA',
          mensaje: 'Tu solicitud ya está enviada, así que desde aquí no se puede quitar nada. '
            + 'Puedes pedirnos que te la devolvamos para corregirla.' };
      }
      if (scenario.quitarMode === 'no_se_puede') {
        return { ok: true, retirados: 0, resultados: [{ clase: it.clase, id: it.id,
          estado: 'NO_SE_PUEDE',
          motivo: 'La solicitud necesita al menos un tutor. Añade el otro tutor primero y '
            + 'después quita éste.' }] };
      }
      return { ok: true, retirados: 1,
        resultados: [{ clase: it.clase, id: it.id, estado: 'QUITADO', arrastrado: 2 }] };
    },

    // ── Catálogos ────────────────────────────────────────────────────────────
    fetchLookups:   () => ({ ok: true, ...LOOKUPS }),
    fetchQuestions: () => (scenario.preguntasMode === 'caido'
      ? { ok: false, error: { code: 'E2E_QUESTIONS_DOWN', message: 'catálogo caído (simulado)' } }
      : { ok: true, ...QUESTIONS }),

    // ── Guardado de pasos ────────────────────────────────────────────────────
    saveStep: (p) => {
      if (scenario.saveStepFails) return { ok: false, error: { code: 'E2E_FORCED', message: 'fallo simulado' } };
      const _debug = {};
      if (p.step === 'persons' && Array.isArray(p.payload)) {
        _debug.personIdMap = p.payload.map((x, i) => ({ _uid: x._uid, person_id: x.person_id || `srv_person_${i}` }));
      }
      return { ok: true, saved: true, _debug };
    },
    saveResponses: () => ({ ok: true, saved: true }),
    saveNeae:      () => ({ ok: true, saved: true }),

    // ── DL-E49 §1 · EL ENVÍO ES POR TUTOR ────────────────────────────────────
    // La forma la copia del contrato real (`submitEnrollmentSession_` → los conteos que
    // devuelve `enr_persistSubmit_` del KMS). `scenario.partes` dice en qué momento de la
    // familia estamos: `'falta_el_otro'` = ha enviado uno de dos; `'todas'` = ya están.
    submitEnrollmentSession: () => {
      if (scenario.partes === 'falta_el_otro') {
        scenario.partes = 'todas';   // el SIGUIENTE envío es el del segundo tutor
        return { ok: true, submitted: true, enrollment_ids: ['e1'],
                 parcial: true, tutores_total: 2, tutores_que_enviaron: 1, falta_por_enviar: 1 };
      }
      return { ok: true, submitted: true, enrollment_ids: ['e1'],
               parcial: false, tutores_total: scenario.partes === 'todas' ? 2 : 1,
               tutores_que_enviaron: scenario.partes === 'todas' ? 2 : 1, falta_por_enviar: 0 };
    },
    estadoDeLasPartes: () => (scenario.partes === 'todas'
      ? { ok: true, tutores_total: 2, tutores_que_enviaron: 2, todas_enviadas: true,
          puede_seguir: false, ya_envio: true, faltan_nombres: [] }
      : { ok: true, tutores_total: 2, tutores_que_enviaron: 1, todas_enviadas: false,
          puede_seguir: false, ya_envio: true, faltan_nombres: ['RobotDosE2E PruebaE2E'] }),

    // ── Documentos ───────────────────────────────────────────────────────────
    uploadDocument: (p) => {
      if (!p.base64 || !p.filename) return { ok: false, error: { code: 'E2E_BAD_UPLOAD', message: 'sin bytes' } };
      return { ok: true, file_id: FIXTURE.fileId };
    },
    getDocument: () => ({ ok: true, base64: 'JVBERi0xLjQK', mimeType: 'application/pdf', filename: 'doc-e2e.pdf' }),

    // ── Verificación / step-up ───────────────────────────────────────────────
    sendVerificationCode: () => ({ ok: true, sent: true }),
    verifyEmail:          () => ({ ok: true, verified: true }),

    // ── Tramo de firma ───────────────────────────────────────────────────────
    getSubscriptionBudget:   () => ({ ok: true, subscriptions: [], modalities_available: false }),
    getSavedBillingSplits:   () => ({ ok: true, payers: [], per_participant: [] }),
    saveBillingInfo:         () => ({ ok: true, saved: true }),
    applyPaymentModality:    () => ({ ok: true, applied: true }),
    submitGdprConsents:      () => ({ ok: true, saved: true }),
    confirmReview:           () => ({ ok: true, confirmed: true }),
    initiateSigningSession:  () => ({ ok: true, members: [], steps: {} }),
  };

  return function dispatch(payload) {
    const action = payload && payload.action;
    const handler = H[action];
    record({ action, payload });
    if (!handler) {
      record.unmocked(action);
      return { ok: false, error: { code: 'E2E_UNMOCKED', message: `acción no simulada: ${action}` } };
    }
    try {
      return handler(payload) || { ok: true };
    } catch (e) {
      return { ok: false, error: { code: 'E2E_MOCK_ERROR', message: String(e && e.message || e) } };
    }
  };
}
