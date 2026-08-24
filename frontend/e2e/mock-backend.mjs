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
  // DL-E49 §2 — identidad PROPIA del segundo tutor (`caminoSegundoTutorNoVeAlPrimero`):
  // sin un email_id distinto del de guardian1, el mock no puede simular "entro como el
  // OTRO tutor" — sería el mismo `n` para los dos.
  emailId2:       '33333333-3333-4333-8333-333333333334',
  programId:      '44444444-4444-4444-8444-444444444444',
  guardian1Id:    'aaaaaaaa-1111-4111-8111-aaaaaaaaaaaa',
  guardian2Id:    'aaaaaaaa-2222-4222-8222-aaaaaaaaaaaa',
  applicantId:    'bbbbbbbb-1111-4111-8111-bbbbbbbbbbbb',
  applicant2Id:   'bbbbbbbb-2222-4222-8222-bbbbbbbbbbbb',
  // El nombre que la batería localiza en el formulario y reescribe (marcador único).
  guardian1Name:  'RobotUnoE2E',
  guardian2Name:  'RobotDosE2E',
  applicantName:  'RobotHijoE2E',
  emailKnown:     'familia.conocida.e2e@example.invalid',
  emailKnown2:    'familia.conocida.e2e.t2@example.invalid',
  emailUnknown:   'nadie.desconocido.e2e@example.invalid',
  startDateSep:   '2026-09-01',
  // El programa DECLARA su curso (inicio y fin). El paso 1 saca de aquí los límites del
  // campo de fecha: sin fin declarado, la mitad de arriba no se podría afirmar.
  endDateCourse:  '2027-06-30',
  fileId:         'cccccccc-1111-4111-8111-cccccccccccc',
};

const guardian = (id, first, email) => ({
  person_id:       id,
  person_type_id:  'guardian',
  first_name:      first,
  last_name:       'PruebaE2E',
  date_of_birth:   '1985-05-05',
  phones:          [{ value: '+34600000001', is_default: 'TRUE' }],
  emails:          [{ value: email || FIXTURE.emailKnown, is_default: 'TRUE' }],
  nationalities:   [],
  ids:             [],
  // ①45 — un idioma YA DECLARADO, con la forma EXACTA de la fila que devuelve el
  // hidratador real (`enr_wizardHydrateCompute_` → `attach('enrPersonLanguages',
  // 'languages')` adjunta la fila ENTERA, `record_id` incluido). Va aquí a propósito:
  // sin una fila ya guardada, la afirmación de que lo declarado NO se puede desmarcar
  // —los satélites del KMS son append-only— se comprobaría en vacío, que es peor que no
  // comprobarla. El alumno va con `[]` para medir el otro lado: declarar de cero.
  languages:       [{ record_id: 'lang_g1_es', person_id: id, language_id: 'es',
                      is_mother_tongue: 'TRUE', is_active: 'TRUE' }],
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
  languages:       [],   // ①45 — sin declarar: el otro lado del caso (ver `guardian`)
  allergies:       [],
  dietary:         [],
  medical:         [],
  // ⭐ 0º.vicies.septies (2026-08-22) — el APOYO EDUCATIVO, con los DOS nombres que el
  // asistente lee (`WizardContext`: `p.neae` = condiciones · `p.neae_support` = apoyos).
  // El KMS no los mandaba NUNCA (medido: cero apariciones de `neae` en
  // `enr/wizard-datalayer.gs`), así que el simulado tampoco podía; ahora los proyecta el
  // hidratador real y este molde es su copia declarada.
  neae:            [],
  neae_support:    [],
  address:         { address_line_1: 'Calle Falsa 1', city: 'Las Palmas', country_id: 'ES', zip: '35001' },
});

/**
 * `YYYY-MM-DD` → `MM/DD/YYYY` — el formato CRUDO en que la API de AppSheet devuelve las
 * columnas de fecha (mes primero). Lo usa el escenario hostil de ①31.
 */
const aFormatoAppSheet_ = (iso) => {
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(String(iso || ''));
  return m ? `${m[2]}/${m[3]}/${m[1]}` : String(iso || '');
};

/**
 * ①31 — el ESCENARIO HOSTIL de las fechas del programa.
 *
 * Por defecto los límites se sirven en ISO, que es lo que manda el servidor de verdad
 * desde el 2026-08-09 (`kis-app kms-server/enr/wizard-gateway.gs` los normaliza con
 * `utils_appsheetDateToIso_`). Con `scenario.formatoFechasPrograma = 'appsheet'` se
 * sirven en el formato AMERICANO en crudo de AppSheet ('MM/DD/YYYY'), que es como
 * viajaban ANTES del arreglo — el dato exacto que tumbaba a toda familia de «a mitad de
 * curso».
 *
 * ⚠️ HAY QUE APLICARLO EN LOS **DOS** SITIOS QUE SIRVEN CATÁLOGOS, y esto se descubrió
 * midiendo, no razonando: la pantalla casi nunca llama a `fetchLookups`, porque
 * `hydrateSession` YA devuelve `lookups` y el frontal siembra con eso su caché
 * (`frontend/src/api.js`, `primeLookups`). Un escenario aplicado solo a `fetchLookups`
 * NO llega a la pantalla y deja la comprobación pasando en vacío — que es peor que no
 * tenerla.
 */
function lookupsSegunEscenario_(scenario) {
  const modo = scenario && scenario.formatoFechasPrograma;
  // `0º.tricies.bis` — con UN SOLO programa la pantalla lo auto-elige, así que la
  // comprobación de «el programa guardado SE VE al volver» pasaría EN VACÍO, que es peor
  // que no tenerla. La palanca sirve un SEGUNDO programa para que haya algo que recuperar.
  //
  // ⛔ Va ANTES de la salida rápida de abajo, y NO es estilo: puesta después, la palanca
  // solo surtía efecto cuando además se estaba forzando el formato de fechas — y el camino
  // salía ROJO diciendo «el desplegable trajo 1 opción».
  const programas = (scenario && scenario.variosProgramas)
    ? LOOKUPS.programs.concat([{
        program_id:       'prog-2-e2e',
        designation:      'Otro programa (E2E)',
        period_starts_on: LOOKUPS.programs[0].period_starts_on,
        period_ends_on:   LOOKUPS.programs[0].period_ends_on,
      }])
    : LOOKUPS.programs;
  // 2026-08-22 — el catálogo de sexo NO llega (KMS que aún no lo sirve, o lectura caída).
  // Desde que se retiró el respaldo escrito a mano, ése es el caso que la pantalla tiene que
  // DECIR en vez de quedarse con un desplegable vacío y mudo. Va con su motivo, como el real.
  const sexo = (scenario && scenario.catalogoSexoVacio)
    ? { genderValues: [], genderValuesReason: 'CATALOGO_VACIO' }
    : {};
  if (modo !== 'appsheet' && modo !== 'ilegible') {
    return { ...LOOKUPS, programs: programas, ...sexo };
  }
  const convertir = modo === 'appsheet'
    ? aFormatoAppSheet_
    // 'ilegible' — un valor que NINGÚN lector de fechas puede interpretar. No es un caso
    // rebuscado: es lo que hay que ver para afirmar la REGLA DURA de ①31 — ante un límite
    // que no se entiende, la familia PASA. Con el formato de AppSheet no basta, porque hoy
    // ese SÍ se sabe leer (y se aplica bien), así que esa vuelta mide otra cosa.
    : () => 'sin fecha declarada';
  return {
    ...LOOKUPS,
    programs: programas.map((p) => ({
      ...p,
      period_starts_on: convertir(p.period_starts_on),
      period_ends_on:   convertir(p.period_ends_on),
    })),
    ...sexo,
  };
}

// `0º.tricies.quinquies` — marca de idempotencia → fichero ya guardado, como en `recFiles`.
const FICHEROS_POR_MARCA = new Map();
let _ficheroSeq = 0;

const LOOKUPS = {
  programs: [{
    program_id:       FIXTURE.programId,
    designation:      'Admisión Curso 2026/27 (E2E)',
    period_starts_on: FIXTURE.startDateSep,
    period_ends_on:   FIXTURE.endDateCourse,
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
  // ── 18.bis.35 · TIPOS DE DOCUMENTO QUE LA FAMILIA PUEDE APORTAR (DL-R16) ──────────
  // LA FORMA ES LA DEL SERVIDOR DE VERDAD: `{code, designation}`, tal cual la arma
  // `rec_resolveInterestedPartyType_` (`kis-app kms-server/rec/catalogue.gs`) y la sirve
  // `enr_wizardFetchLookups` bajo `recTypesInterestedParty`. Un simulado que sirve otro
  // contrato no puede cazar nada.
  //
  // DOS a propósito, y no es un adorno: con UNO el servidor asigna el tipo él solo y la
  // pantalla NO pregunta (DL-R16, «un desplegable de una opción no es elección»), así que
  // un banco con un solo tipo dejaría el desplegable sin pintar y la comprobación pasando
  // en vacío — que es peor que no tenerla. Los casos de 0 y de 1 NO están cubiertos por la
  // batería y se declaran como tales en `CLAUDE.md` §18.bis.35.
  // ①27 pieza 9 · DL-R19 — `is_immutable` VIAJA CON CADA OPCIÓN, y la forma es la del
  // servidor de verdad (`rec_resolveInterestedPartyType_`, `kis-app kms-server/rec/catalogue.gs`).
  // Los tres valores son los del catálogo REAL de fábrica (`config/rec-type-templates.html`):
  // los dos primeros no son inmutables y `CUSTODY_ORDER` sí. **El tercero está a propósito**:
  // sin un tipo inmutable delante, la afirmación de «lo inmutable no se recomprime» pasaría
  // EN VACÍO — que es peor que no tenerla.
  recTypesInterestedParty: [
    { code: 'APPLICATION_DOCUMENTATION', designation: 'Documentación de la solicitud', is_immutable: false },
    { code: 'MEDICAL_RECORD',            designation: 'Informe médico',                is_immutable: false },
    { code: 'CUSTODY_ORDER',             designation: 'Medida judicial de custodia',   is_immutable: true  },
  ],
  // ── `0º.tricies.duodecies` · DL-E51 — LOS VALORES QUE ADMITE EL SEXO ─────────────
  // LA FORMA ES LA DEL SERVIDOR DE VERDAD: `{code, designation, label_key}`, tal cual la
  // arma `enr_wizardFetchLookups` a partir del catálogo Capa 2 `person-gender-values`.
  //
  // ⚠️ Y LA LISTA ES DISTINTA DE LA ESCRITA A MANO EN LA PANTALLA, A PROPÓSITO: sirviendo
  // los mismos cuatro valores del respaldo, la comprobación de «las opciones salen del
  // catálogo» pasaría EN VACÍO — que es peor que no tenerla. Por eso son TRES: falta
  // `Male` (si apareciera, la pantalla estaría pintando su respaldo) y sobra `ZZ-E2E`,
  // que NO existe en ningún catálogo real y además NO tiene traducción, así que su
  // etiqueta ha de caer a la `designation` — la otra mitad de la regla.
  genderValues: [
    { code: 'Female',     designation: 'Femenino',  label_key: 'gender.Female' },
    { code: 'Non-binary', designation: 'No binario', label_key: 'gender.Non-binary' },
    { code: 'ZZ-E2E',     designation: 'Valor E2E',  label_key: 'gender.ZZ-E2E' },
  ],
  genderValuesReason: null,
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

/**
 * LOS TRES ARCHIVOS QUE LA FAMILIA YA SUBIÓ — los que el camino `documentos-vuelven`
 * busca EN PANTALLA al volver a entrar.
 *
 * ⚠️ LA FORMA ES LA DEL SERVIDOR, no una inventada: es exactamente lo que emite el
 * mapeo de `documents` del KMS (`kis-app kms-server/enr/wizard-datalayer.gs`, la
 * proyección de `recFiles`) y que `hydrateSession_` reenvía tal cual al cliente
 * (`backend/Code.js`, `return Object.assign({}, data, …)`). Incluye `description`
 * PORQUE ese mapeo la manda: hasta el 2026-08-09 NO viajaba, y por eso la familia
 * veía sus descripciones en blanco aunque las hubiera escrito. Si alguien vuelve a
 * quitarla del servidor, la afirmación de descripciones de este camino cae — que es
 * justo lo que tiene que pasar.
 */
export const DOCUMENTOS_GUARDADOS = [
  { file_id: 'dddddddd-1111-4111-8111-dddddddddddd', file_name: 'notas-curso-anterior.pdf',
    description: 'Notas del curso anterior', rec_type_code: 'ENR_DOC', created_at: '2026-08-01T09:00:00Z' },
  { file_id: 'dddddddd-2222-4222-8222-dddddddddddd', file_name: 'libro-de-familia.pdf',
    description: 'Libro de familia', rec_type_code: 'ENR_DOC', created_at: '2026-08-01T09:05:00Z' },
  { file_id: 'dddddddd-3333-4333-8333-dddddddddddd', file_name: 'informe-del-colegio.pdf',
    description: 'Informe del colegio anterior', rec_type_code: 'ENR_DOC', created_at: '2026-08-01T09:10:00Z' },
]

/**
 * LOS MISMOS TRES ARCHIVOS, SIN DESCRIPCIÓN — y NO es un caso rebuscado.
 *
 * La casilla de descripción es OPCIONAL por diseño (el adjuntador es genérico: la familia
 * sube lo que quiera y, si le apetece, dice qué es). Así que un expediente perfectamente
 * normal tiene archivos sin una sola letra de descripción. Si la pantalla solo sabe
 * enseñar la descripción, esos archivos salen como tres cajas vacías: están, pero la
 * familia no puede reconocer NINGUNO. Este es el conjunto con el que se mide eso.
 */
export const DOCUMENTOS_SIN_DESCRIPCION = DOCUMENTOS_GUARDADOS.map(
  ({ description, ...resto }) => resto)   // eslint-disable-line no-unused-vars

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
          // ③51 — esta pregunta DECLARA su control y la de abajo NO, siendo del MISMO tipo.
          // Es a propósito: así el camino comprueba a la vez que lo declarado manda y que la
          // caída al código del tipo sigue viva. Con las dos declaradas —o ninguna— la
          // afirmación pasaría sin distinguir una cosa de la otra.
          ui_widget: 'input',
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
      // ── 0º.tricies.decies — DOS preguntas DE ALUMNO (`audience_category_id:'participant'`),
      // y son DOS a propósito. El expediente del robot tiene DOS alumnos, así que:
      //   · intercalado (lo de antes) → P1·Jara, P1·Pepito, P2·Jara, P2·Pepito
      //   · agrupado    (lo de ahora) → Jara[P1,P2], Pepito[P1,P2]
      // Con UNA sola pregunta de alumno las dos secuencias serían IDÉNTICAS (Jara, Pepito) y
      // la afirmación de agrupación pasaría sin distinguir nada — peor que no tenerla.
      // Hasta hoy el catálogo del robot era GENERAL entero, así que la batería no podía ver
      // este defecto en absoluto: no pintaba ni un encabezado de sujeto.
      {
        set_id: 'set-e2e-1', question_id: 'q-e2e-3', display_order: 2,
        question: {
          question_id: 'q-e2e-3', question_code: 'e2e_alumno_1',
          response_type_id: 'TEXT', response_type_code: 'TEXT',
          is_required: false, audience_category_id: 'participant',
          question_text: 'Cómo le va en clase', help_text: '', placeholder_text: '',
          options: [], conditions: [],
        },
      },
      {
        set_id: 'set-e2e-1', question_id: 'q-e2e-4', display_order: 3,
        question: {
          question_id: 'q-e2e-4', question_code: 'e2e_alumno_2',
          response_type_id: 'TEXT', response_type_code: 'TEXT',
          is_required: false, audience_category_id: 'participant',
          question_text: 'Qué le gusta hacer', help_text: '', placeholder_text: '',
          options: [], conditions: [],
        },
      },
    ],
  }],
};

/**
 * DL-E49 §2 — espejo del recorte del SERVIDOR real (`enr_wizardPersonasVisiblesParaTutor_`,
 * kis-app/kms-server/enr/wizard-datalayer.gs, + su gemelo `buildResumeSessionData_` del
 * wizard). Sin esto el mock devolvería SIEMPRE el grupo entero — que es justo el defecto
 * que `caminoSegundoTutorNoVeAlPrimero` existe para cazar. `viewerN` es el `n` (email_id)
 * con el que la página pidió `hydrateSession`; `null`/desconocido ⇒ NINGÚN tutor (misma
 * regla que el servidor real: ante la duda, enseña de menos).
 * @private
 */
function viewerIdE2E_(viewerN) {
  return viewerN === FIXTURE.emailId2 ? FIXTURE.guardian2Id
    : viewerN === FIXTURE.emailId ? FIXTURE.guardian1Id
    : null;
}
function recortarPorTutorE2E_(data, viewerN) {
  if (!data.persons || !data.persons.length) return data;
  const viewerId = viewerIdE2E_(viewerN);
  const tipoPorId = {};
  let guardiansTotalCount = 0;
  data.persons.forEach(p => {
    if (!p || !p.person_id) return;
    tipoPorId[p.person_id] = p.person_type_id;
    if (p.person_type_id === 'guardian') guardiansTotalCount++;
  });
  return {
    ...data,
    persons: data.persons.filter(p => p.person_type_id !== 'guardian' || p.person_id === viewerId),
    relations: (data.relations || []).filter(r =>
      tipoPorId[r.from_person_id] !== 'guardian' || r.from_person_id === viewerId),
    responses: (data.responses || []).filter(r =>
      tipoPorId[r && r.respondent_id] !== 'guardian' || r.respondent_id === viewerId),
    guardians_total_count: guardiansTotalCount,
  };
}

/**
 * Construye la respuesta de `hydrateSession` para una ETAPA del expediente.
 * La etapa decide qué datos trae → y por tanto en qué paso aterriza el wizard
 * (WizardContext.hydrateFromResume infiere `completedSteps` de los datos).
 *
 * @param {'sin_fecha'|'hasta_preguntas'|'firma'} stage
 * @param {string} [viewerN] — el `n` (email_id) del enlace con el que se pidió esta
 *   hidratación; DL-E49 §2 recorta `persons`/`relations`/`responses` según quién pregunta.
 * @param {boolean} [tutorUnico]
 * @param {Array}  [documentos] — los archivos que la familia YA subió. Por defecto ninguno
 *   (que es lo que hace aterrizar en Documentos); con lista, el paso queda por visitado y
 *   el aterrizaje se va a Revisión, igual que en el sistema real.
 */
export function buildHydrate(stage, preguntasMode, respuestasMode, viewerN, tutorUnico, documentos, unSoloAlumno) {
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
    lookups:        LOOKUPS,   // lo sobrescriben los despachadores con `lookupsSegunEscenario_`
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

  // DL-E49 §3: la familia de UN SOLO TUTOR es un caso distinto, no una variante estética —
  // es el único en el que la pantalla pide las declaraciones (tutor único + patria potestad).
  // Con la familia de dos tutores del banco esas casillas no se pintan y el camino que las
  // mide no tendría nada que pulsar.
  const persons = [
    guardian(FIXTURE.guardian1Id, FIXTURE.guardian1Name, FIXTURE.emailKnown),
    ...(tutorUnico ? [] : [guardian(FIXTURE.guardian2Id, FIXTURE.guardian2Name, FIXTURE.emailKnown2)]),
    applicant(FIXTURE.applicantId, FIXTURE.applicantName),
    // DOS aplicantes, no uno. Con uno solo la pantalla pintaba sus dos tarjetas YA
    // RELLENAS desde la hidratación ⇒ el paso salía LIMPIO, `isStepDirty` decía que no y
    // NO se guardaba nada: el alta de vínculos no se ejercitaba jamás. La familia del
    // robot contra el sistema real son 2 tutores y 2 hijos; el banco tiene que serlo
    // también o mide otro caso.
    // `0º.tricies.sexdecies` (2026-08-22) — con UN SOLO alumno la pantalla NO debe pintar
    // el separador con peso: sin nada que separar es ruido. Se pide EXPLÍCITAMENTE con
    // `scenario.unSoloAlumno`; sin la palanca, DOS alumnos como siempre. Los vínculos de
    // la familia de dos tutores (`r1`/`r2`) NO nombran al segundo hijo, así que quitarlo
    // no deja ningún vínculo colgando.
    ...(unSoloAlumno ? [] : [applicant(FIXTURE.applicant2Id, 'RobotHijoDosE2E')]),
  ];
  // Con UN SOLO tutor, el vínculo que falta es el suyo con el segundo hijo: si se dejaran
  // los dos vínculos de la familia de dos tutores, uno apuntaría a un tutor que ya no está
  // y el paso de vínculos se quedaría incompleto para siempre. Una familia monoparental
  // tiene vínculo con TODOS sus hijos — que es justo lo que hay que simular.
  const relations = tutorUnico ? [
    { relation_id: 'r1', pair_id: 'p1', from_person_id: FIXTURE.guardian1Id, to_person_id: FIXTURE.applicantId,
      relation_type_id: 'rt_mother', is_custodial: 'TRUE', is_pick_up_authorized: 'TRUE' },
    { relation_id: 'r2', pair_id: 'p2', from_person_id: FIXTURE.guardian1Id, to_person_id: FIXTURE.applicant2Id,
      relation_type_id: 'rt_mother', is_custodial: 'TRUE', is_pick_up_authorized: 'TRUE' },
    // El par hermano↔hermano TAMBIÉN necesita su tipo declarado: `Step3Relations` no deja
    // avanzar con un vínculo sin tipo (`missingRelationType`), y con dos hijos ese par
    // existe siempre. Sin él, este camino se quedaría atrapado en el paso de vínculos.
    { relation_id: 'r3', pair_id: 'p3', from_person_id: FIXTURE.applicantId, to_person_id: FIXTURE.applicant2Id,
      relation_type_id: 'rt_child', is_custodial: 'FALSE', is_pick_up_authorized: 'FALSE' },
  ] : [
    { relation_id: 'r1', pair_id: 'p1', from_person_id: FIXTURE.guardian1Id, to_person_id: FIXTURE.applicantId,
      relation_type_id: 'rt_mother', is_custodial: 'TRUE', is_pick_up_authorized: 'TRUE' },
    { relation_id: 'r2', pair_id: 'p2', from_person_id: FIXTURE.guardian2Id, to_person_id: FIXTURE.applicantId,
      relation_type_id: 'rt_father', is_custodial: 'TRUE', is_pick_up_authorized: 'TRUE' },
  ];

  if (stage === 'hasta_preguntas') {
    // fecha + personas + relaciones + salud visitada + respuestas ⇒ completos 0..4,
    // documentos vacíos ⇒ primer paso incompleto = Documentos (índice 5).
    return recortarPorTutorE2E_({
      ...base,
      persons,
      relations,
      documents: documentos || [],
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
    }, viewerN);
  }

  if (stage === 'lista_para_enviar') {
    // Todo relleno HASTA documentos incluidos y SIN enviar ⇒ el primer paso incompleto es
    // Revisión (índice 6), que es donde vive el botón de enviar. Hacía falta un escalón
    // así: `hasta_preguntas` aterriza en Documentos y `enviada` ya está enviada, con lo
    // que ningún recorrido llegaba a pulsar «Enviar» sobre un expediente todavía abierto.
    return recortarPorTutorE2E_({
      ...base,
      persons,
      relations,
      responses: [{ question_id: 'q-e2e-1', respondent_id: FIXTURE.groupId, response_text: RESPUESTA_GUARDADA }],
      // ⭐ `0º.tricies.quindecies` — LOS SEIS CAMPOS QUE PROYECTA EL KMS REAL
      // (`enr_wizardHydrateCompute_`, `kms-server/enr/wizard-datalayer.gs`): `file_id`,
      // `rec_type_code`, `file_name`, `description`, `created_at`, `owner_person_ids`.
      // Antes el doble mandaba `filename` (clave que el KMS NO usa) y se dejaba los otros
      // tres, así que la batería no podía ver el defecto que este tramo cierra: el paso 6
      // salía SUCIO en cada pasada porque su proyección tenía TRES campos y la hidratación
      // SEIS. Un doble que no refleja el contrato deja la red midiendo otra cosa.
      documents: [{
        file_id: FIXTURE.fileId, rec_type_code: 'REC_TYPE_E2E', file_name: 'doc-e2e.pdf',
        description: 'Documento de prueba', created_at: '2026-08-01T10:00:00Z',
        owner_person_ids: [],
      }],
      recovered_guardian_person_id: viewerIdE2E_(viewerN) || FIXTURE.guardian1Id,
    }, viewerN);
  }

  if (stage === 'enviada') {
    // Expediente YA ENVIADO y SIN admitir: la familia aterriza en Revisión (índice 6)
    // viendo «solicitud enviada». Es la pantalla donde vive «necesito corregir algo»
    // (cola 18.quater). No es lo mismo que `firma`: ahí ya está admitida y el wizard
    // la lleva al tramo de firma, donde ese botón no pinta nada.
    return recortarPorTutorE2E_({
      ...base,
      persons,
      relations,
      responses: [{ question_id: 'q1', respondent_id: FIXTURE.guardian1Id, response_text: 'sí' }],
      recovered_guardian_person_id: viewerIdE2E_(viewerN) || FIXTURE.guardian1Id,
      admission: {
        state_code:        'RQ',
        state_label:       'Solicitada',
        editable:          false,     // enviada ⇒ bloqueada para editar
        signing_available: false,
        signing_ready:     false,
        signing_status:    null,
      },
    }, viewerN);
  }

  // stage === 'firma': expediente ADMITIDO, firma abierta para este guardian y
  // ningún sub-paso completado ⇒ aterriza en el primer paso de firma (índice 7).
  return recortarPorTutorE2E_({
    ...base,
    persons,
    relations,
    responses: [{ question_id: 'q1', respondent_id: FIXTURE.guardian1Id, response_text: 'sí' }],
    recovered_guardian_person_id: viewerIdE2E_(viewerN) || FIXTURE.guardian1Id,
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
  }, viewerN);
}

/**
 * Devuelve el manejador de acciones. `scenario` es MUTABLE entre recorridos: cada
 * camino lo reconfigura antes de navegar (los recorridos corren en serie).
 */
export function createDispatcher(scenario, record) {
  // El ticket del precalentado es de UN SOLO USO server-side (`_mintWarmTicket_`, TTL
  // 300 s): `warmBundle_` lo BORRA de la cache al primer uso. Sin esto el simulado
  // aceptaba el mismo ticket infinitas veces y el caso que de verdad ve la familia
  // —recarga, petición repetida, ticket caducado— no aparecía nunca.
  const ticketsGastados = new Set();
  // ── 18.bis.84 · EL SERVIDOR APUNTA EL TRABAJO Y LO HACE DESPUÉS ─────────────────────
  // Los seis guardados devuelven un identificador de trabajo (`job_id`) con el que se
  // puede preguntar más tarde cómo acabó. Aquí se emite SOLO cuando el camino lo pide
  // (`scenario.trabajoResultado`): así los demás recorridos siguen byte-idénticos —
  // sin identificador, el asistente no apunta nada y no pregunta nada.
  let contadorDeTrabajos = 0;
  const trabajoApuntado = () => (scenario.trabajoResultado ? `job-e2e-${++contadorDeTrabajos}` : null);

  // ── LA VENTANA DE INACTIVIDAD, MODELADA COMO LA MODELA EL SERVIDOR (2026-08-20) ──────
  // Copia la forma de `backend/Code.js` (`_markStepUpFresh_` / `_leerMarcaStepUp_` /
  // `_extenderVentanaStepUp_`): una marca con CADUCIDAD, BUZÓN y HUELLA DE PÁGINA VIVA.
  // No se inventa nada — es lo que hace el de verdad, y por eso el recorrido puede afirmar
  // sobre lo que la FAMILIA ve sin fingir el comportamiento del servidor.
  //
  // Se enciende SOLO con `scenario.ventanaViva`, para que los demás recorridos sigan
  // byte-idénticos: sin esa palanca, `hydrateSession` se comporta exactamente como antes.
  //
  // `scenario.ventanaMs` comprime los 10 minutos a unos pocos segundos. Lo que se comprime
  // es el RELOJ, no el mecanismo: el cliente pinta el aviso sobre el tiempo restante que
  // le manda el servidor, así que la secuencia que se observa es la misma que a los 10 min.
  // ★ 2026-08-20 — y con TECHO ABSOLUTO, copia declarada del modelo del servidor: la ventana
  // de arriba se reinicia con la actividad, el techo NO se reinicia con nada. `scenario.techoMs`
  // lo comprime igual que `ventanaMs` comprime la ventana; sin la palanca son 2 h, así que los
  // recorridos que no lo tocan quedan byte-idénticos.
  let marca = null;   // { exp, techo, persona, pagina }
  const ventanaMs = () => Number(scenario.ventanaMs) || 10 * 60 * 1000;
  const techoMs   = () => Number(scenario.techoMs)   || 2 * 60 * 60 * 1000;
  const acunar = (p) => {
    const techo = Date.now() + techoMs();
    marca = { exp: Math.min(Date.now() + ventanaMs(), techo), techo,
              persona: (p && p.n) || '', pagina: (p && p.pv) || '' };
  };
  const leerMarca = (p) => {
    if (!marca) return { fresh: false, restante_s: 0, cierre: 'INACTIVIDAD' };
    const persona = (p && p.n) || '';
    const pagina  = (p && p.pv) || '';
    const enVentana   = marca.exp >= Date.now() && marca.techo >= Date.now();
    // Misma regla y mismo comodín que el servidor: dos valores CONOCIDOS y distintos no
    // se transfieren; cuando uno de los dos lados no consta, se deja pasar.
    const mismaPersona = !marca.persona || !persona || marca.persona === persona;
    const mismaPagina  = !marca.pagina  || !pagina  || marca.pagina  === pagina;
    const fresh = enVentana && mismaPersona && mismaPagina;
    // CUÁL de los dos límites va a cerrar: lo resuelve el servidor, no el cliente.
    const cierre = (marca.exp >= marca.techo) ? 'TECHO' : 'INACTIVIDAD';
    return { fresh, restante_s: fresh ? Math.max(0, Math.ceil((marca.exp - Date.now()) / 1000)) : 0, cierre };
  };
  // Extiende, JAMÁS crea, y conserva el atado con el que la marca nació.
  const extender = () => {
    if (!marca || marca.exp < Date.now()) return 0;
    // El techo NO se mueve al extender: se capa contra él, como hace el servidor.
    const nueva = Math.min(Date.now() + ventanaMs(), marca.techo);
    if (nueva <= Date.now()) return 0;
    marca.exp = nueva;
    return Math.ceil((nueva - Date.now()) / 1000);
  };
  // Lo que el simulado le contesta a la puerta de datos personales. Con la palanca puesta
  // manda la MARCA; sin ella, el comportamiento de siempre (`scenario.otpSuperado`).
  const puertaAbierta = (p) => (scenario.ventanaViva ? leerMarca(p).fresh : !!scenario.otpSuperado);
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
    // Forma COPIADA de la rama de ticket de `warmBundle_` (backend/Code.js): un ticket
    // ya gastado o caducado NO es un fallo — es que no hay nada que calentar — y
    // contesta `{ok:true}`, la MISMA respuesta del ticket real y del señuelo (WIZ-ENUM:
    // si "nada que calentar" se distinguiera, volvería a haber por dónde preguntar si
    // ese correo tiene expediente). Un fallo de VERDAD sí sale nombrado y con `ok:false`.
    warmBundle: (p) => {
      if (scenario.warmFalla) {
        return { ok: false, error: { code: 'PRECALENTADO_FALLIDO', message: 'el precalentado falló de verdad' } };
      }
      const tk = p && p.ticket;
      if (tk) {
        if (ticketsGastados.has(tk)) return { ok: true };   // gastado ⇒ nada que calentar
        ticketsGastados.add(tk);
      }
      return { ok: true };
    },
    warmSession:           () => ({ ok: true, warmed: true }),
    verifyRecaptcha:       () => ({ ok: true, score: 0.9 }),
    initEnrollmentSession: (p) => ({ ok: true, enrollment_group_id: FIXTURE.groupId }),

    // ── Recuperación / sesión ────────────────────────────────────────────────
    // ①31 — los catálogos que la pantalla acaba usando salen por AQUÍ, no por
    // `fetchLookups` (ver `lookupsSegunEscenario_`): el frontal siembra su caché con los
    // `lookups` de la hidratación. Por eso el escenario de formato se aplica también aquí.
    hydrateSession: (p) => {
      // ── LA VERJA DE DATOS PERSONALES (DL-E39) ────────────────────────────────
      // Con `scenario.piiGated`, la PRIMERA hidratación llega SIN nada de la familia y
      // marcada `pii_gated:true` — la secuencia REAL de una familia cuyo enlace ya no
      // tiene gracia: el servidor no manda ni personas ni documentos hasta que se teclea
      // el código de un solo uso, y todo llega en la SEGUNDA hidratación. La forma es la
      // del contrato de verdad (`backend/Code.js`, la rama `if (!stepUpFresh)` de
      // `hydrateSession_`), no una inventada. `verifyEmail` abre la verja.
      if (scenario.piiGated && !puertaAbierta(p)) {
        return {
          ok: true,
          group: {
            enrollment_group_id: FIXTURE.groupId,
            resume_token:        FIXTURE.resumeToken,
            primary_email:       FIXTURE.emailKnown,
            program_id:          FIXTURE.programId,
            desired_start_date:  FIXTURE.startDateSep,
            submitted_at:        null,
          },
          enrollments:    [],
          admission:      null,
          lookups:        lookupsSegunEscenario_(scenario),
          questions:      null,
          live_version:   0,
          persons:        [], relations: [], documents: [], responses: [],
          billing_splits: { payers: [], per_participant: [] },
          step_up_fresh:  false,
          pii_gated:      true,
        };
      }
      const h = buildHydrate(scenario.stage, scenario.preguntasMode, scenario.respuestasMode, p && p.n, scenario.tutorUnico, scenario.documentos, scenario.unSoloAlumno);
      // ⭐ `0º.septvicies` — el vínculo entre hermanos GUARDADO EN EL SENTIDO CONTRARIO
      // (`from` = el hijo 2, `to` = el hijo 1) y en UNA sola fila, que es lo que el KMS
      // escribe desde DL-S45. Sirve para afirmar que el lector del paso 3 lo encuentra
      // igual: si `buildInitialRelations` mirase un solo extremo, la tarjeta del par
      // saldría VACÍA y la familia perdería de vista el vínculo que ya declaró.
      // SIN `pair_id` a propósito: DL-S45 dejó de escribirlo, así que el plegado de
      // `hydrateFromResume` tiene que sostenerse en su clave de dos extremos ordenados.
      if (scenario.vinculoHermanosInvertido) {
        h.relations = (h.relations || []).concat([{
          relation_id:           'r-herm-inv',
          from_person_id:        FIXTURE.applicant2Id,
          to_person_id:          FIXTURE.applicantId,
          relation_type_id:      'rt_child',
          is_custodial:          'FALSE',
          is_pick_up_authorized: 'FALSE',
        }]);
      }
      // ⭐ 0º.vicies.septies — el servidor SÍ manda apoyo educativo. Se pide con la palanca
      // porque, hasta hoy, el KMS NO lo mandaba nunca (medido) y el molde por defecto es el
      // de siempre: sin ella, la hidratación sale byte-idéntica a la de antes.
      if (scenario.neaeDelServidor) {
        (h.persons || []).forEach(pe => {
          if (pe && pe.person_type_id === 'applicant') {
            pe.neae = [{ category_code: 'SLD', diagnosis_status: 'DIAGNOSED', observations: '' }];
            pe.neae_support = [{ support_type: 'LOGOPEDIA', provider_scope: 'PRIOR_SCHOOL', observations: '' }];
          }
        });
      }
      const conVentana = scenario.ventanaViva
        ? { step_up_fresh: true, step_up_restante_s: leerMarca(p).restante_s, step_up_cierre: leerMarca(p).cierre }
        : {};
      return { ok: true, ...h, lookups: lookupsSegunEscenario_(scenario), ...conVentana };
    },
    // ⛔ EL PULSO ES UNA LECTURA. No toca la marca ni por asomo: si la extendiera, una
    // pestaña abandonada se quedaría viva sola, que es SEC-STEPUP (#55). El recorrido
    // `ventana-por-inactividad` lo AFIRMA haciendo latir el pulso y comprobando que el
    // tiempo restante sigue bajando.
    getAdmissionState: (p) => {
      const h = buildHydrate(scenario.stage, undefined, undefined, p && p.n, scenario.tutorUnico, scenario.documentos, scenario.unSoloAlumno);
      const conVentana = scenario.ventanaViva ? leerMarca(p) : null;
      // 0º.tricies.octies (B) — los pasos cuyo ÚLTIMO guardado murió en la cola del KMS.
      // Copia declarada del contrato real (`enr_guardadosQueNoLlegaron_`): CÓDIGOS de paso,
      // nunca el motivo del rechazo. `guardadosNoConsultables` simula el «no se pudo mirar»,
      // que NO es lo mismo que «no hay ninguno» — y ésa es la distinción que se afirma.
      const guardados = scenario.guardadosSinAterrizar
        ? { guardados_sin_aterrizar: scenario.guardadosSinAterrizar,
            guardados_no_consultables: !!scenario.guardadosNoConsultables }
        : {};
      return { ok: true, ...(h.admission || { state_code: null }), ...guardados,
               ...(conVentana ? { step_up_fresh: conVentana.fresh, step_up_restante_s: conVentana.restante_s,
                                  step_up_cierre: conVentana.cierre } : {}) };
    },
    // «Sigo aquí»: EXTIENDE si la marca sigue viva y el atado casa; si no, pide código.
    refrescarVentana: (p) => {
      if (!scenario.ventanaViva) return { ok: true, step_up_fresh: true, step_up_restante_s: 600 };
      if (!leerMarca(p).fresh) return { ok: false, error: { code: 'STEPUP_REQUIRED', message: 'Step-up re-verification required' } };
      const s = extender();
      if (!s) return { ok: false, error: { code: 'STEPUP_REQUIRED', message: 'Step-up re-verification required' } };
      return { ok: true, step_up_fresh: true, step_up_restante_s: s, step_up_cierre: leerMarca(p).cierre };
    },
    // El pulso solo pide el DETALLE cuando esta version SUBE (`WizardPage.jsx`), que es el
    // mecanismo real: el KMS la bumpa por `enr_notifyWizardLiveState_`. Desde
    // 0º.tricies.octies (B) eso incluye la muerte de un guardado — sin ese aviso la familia
    // no se enteraria hasta la siguiente escritura, que puede no llegar nunca. `scenario.
    // liveVersion` deja que el recorrido simule ese bump.
    getLiveStateVersion: () => ({ ok: true, version: Number(scenario.liveVersion) || 1 }),
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

    // DL-E49 §4/§9 — la familia AVISA al tutor que acaba de declarar: le manda SU enlace.
    // `avisarMode` decide qué contesta el servidor, y los tres tienen que verse DISTINTOS:
    //   · 'ok'            → el aviso salió, y la pantalla dice A QUIÉN (buzón tapado);
    //   · 'aun_no_consta' → su ficha todavía se está guardando: NO es un error, es «todavía
    //                       no» — el cliente reintenta solo antes de molestar a la familia;
    //   · 'no_se_pudo'    → no salió, y NO se puede decir «enviado».
    // El caso que protege es el tercero: si la pantalla lo trata como un sí, la familia se
    // queda esperando a un tutor al que nunca le llegó nada.
    avisarATutor: (p) => {
      if (scenario.avisarMode === 'aun_no_consta') return { ok: false, motivo: 'AUN_NO_CONSTA' };
      if (scenario.avisarMode === 'no_se_pudo')    return { ok: true, aviso_enviado: false };
      return { ok: true, aviso_enviado: true, person_id: p.person_id,
               destino_enmascarado: 'ju…@ej…' };
    },

    // ── Catálogos ────────────────────────────────────────────────────────────
    fetchLookups:   () => ({ ok: true, ...lookupsSegunEscenario_(scenario) }),
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
      return { ok: true, saved: true, _debug, job_id: trabajoApuntado() };
    },
    // ②24.sexies — el servidor RECHAZA las respuestas del tutor que ya envió su parte
    // (DL-E49 §6). La forma la copia del contrato real: `saveResponses_` lanza con
    // `err.code='PARTE_YA_ENVIADA'` y `doPost` lo entrega como `{ok:false, error:{code,message}}`
    // sobre HTTP 200 (patrón P72, nunca 403).
    saveResponses: () => (scenario.respuestasRechazadas
      ? { ok: false, error: { code: 'PARTE_YA_ENVIADA', message: 'este tutor ya envió su parte (simulado)' } }
      : { ok: true, saved: true, job_id: trabajoApuntado() }),
    saveNeae:      () => ({ ok: true, saved: true, job_id: trabajoApuntado() }),

    // ── 18.bis.84 · ¿CÓMO ACABÓ EL TRABAJO QUE SE APUNTÓ? ────────────────────────────
    // Forma copiada del contrato: `{trabajos:[{job_id, estado, motivo, descartes}]}`, en el
    // MISMO orden en que se preguntaron. `scenario.trabajoResultado` dice qué contesta:
    //   · 'hecho'       → entró entero (nada que decirle a la familia).
    //   · 'descartado'  → entró, pero el KMS descartó a propósito lo que el tutor escribió
    //                     (DL-E49 §6): reintentar lo descartaría igual.
    //   · 'invalidado'  → entró, y **de paso invalidó el envío previo de ese tutor** porque
    //                     editó después de enviar (DL-E49 §8, 2026-08-24). No es un fallo:
    //                     hay que decirle que vuelva a enviar, sin bloquearle nada.
    //   · 'fallido'     → el trabajo reventó: SÍ tiene sentido reintentarlo.
    //   · 'pendiente'   → sigue en marcha; el asistente no debe decir nada todavía.
    // Se responde SIEMPRE (aunque ningún camino lo pida) para que un latido de 30 s en un
    // recorrido largo no tope con una acción no simulada y ensucie la consola de la familia.
    estadoDelGuardado: (p) => {
      const ids = Array.isArray(p && p.job_ids) ? p.job_ids : [];
      const modo = scenario.trabajoResultado || 'hecho';
      return {
        ok: true,
        trabajos: ids.map(id => ({
          job_id:    id,
          estado:    (modo === 'descartado' || modo === 'invalidado') ? 'hecho' : modo,
          motivo:    modo === 'fallido' ? 'el trabajo no pudo completarse (simulado)' : null,
          // 2026-08-24 (DL-E49 §8) — el descarte de prueba era `skipped_already_submitted`, y
          // ese código **ya no lo emite nadie**: el bloqueo del que salía se retiró (el tutor
          // que ya envió SÍ sigue rellenando; lo que pasa es que su envío se invalida). Se usa
          // el descarte que SÍ sigue vivo, para que esta comprobación mida algo que puede
          // ocurrir de verdad en vez de un código imposible.
          descartes: modo === 'descartado' ? { fichas_de_otro_tutor_rechazadas_n: 1 }
                   : (modo === 'invalidado' ? { parte_invalidada: true } : null),
        })),
      };
    },

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
    // `0º.tricies.quinquies` — LA MARCA DE IDEMPOTENCIA, con el contrato del servidor real:
    // si el mismo envío ya se guardó, se devuelve el fichero QUE YA ESTABA en vez de crear
    // otro (`uploadDocument_` → `enr_wizardComprobarSubida` → `ya_subido.file_id`). Sin esto
    // el simulado devolvía SIEMPRE el mismo identificador y no se podía distinguir «no
    // duplicó» de «no distingue nada».
    uploadDocument: (p) => {
      if (!p.base64 || !p.filename) return { ok: false, error: { code: 'E2E_BAD_UPLOAD', message: 'sin bytes' } };
      // 18.bis.95 · el KMS dice que la ficha del documento NO quedó escrita. La forma la copia
      // del contrato real: `uploadDocument_` mira `file_persisted` y, si no consta, rechaza
      // con este código (`_veredictoDeLaSubida_`, `backend/Code.js`) en vez de confirmar una
      // subida que no existe para nadie. Se pide EXPLÍCITAMENTE con la palanca del escenario.
      if (scenario.subidaNoRegistrada) {
        return { ok: false, error: { code: 'DOCUMENTO_NO_REGISTRADO',
                                     message: 'El archivo se subió pero no quedó registrado en la solicitud: vuelve a intentarlo.' } };
      }
      // `0º.tricies.quinquies` — el servidor pide el código UNA vez, para poder medir el
      // reintento REAL (el de `setStepUpRetry`), que es el que tiene que reenviar la MISMA
      // marca. Un «volver a elegir el archivo» NO es un reintento: ahí el navegador no puede
      // saber que son los mismos bytes, y acuñar marca nueva es lo correcto.
      if (scenario.subidaPideCodigoUnaVez) {
        scenario.subidaPideCodigoUnaVez = false;
        return { ok: false, error: { code: 'STEPUP_REQUIRED', message: 'Step-up re-verification required' } };
      }
      const marca = p.upload_idempotency_token || '';
      if (marca && FICHEROS_POR_MARCA.has(marca)) {
        return { ok: true, file_id: FICHEROS_POR_MARCA.get(marca), repetido: true };
      }
      const fileId = `${FIXTURE.fileId}-${++_ficheroSeq}`;
      if (marca) FICHEROS_POR_MARCA.set(marca, fileId);
      return { ok: true, file_id: fileId };
    },
    getDocument: () => ({ ok: true, base64: 'JVBERi0xLjQK', mimeType: 'application/pdf', filename: 'doc-e2e.pdf' }),

    // ── Verificación / step-up ───────────────────────────────────────────────
    // `codigoFalla` deja al servidor RECHAZAR la petición del código con un código de
    // error real del contrato (`RATE_LIMITED` / `TOO_MANY_ATTEMPTS`, `backend/Code.js`).
    // Lo pide EXPLÍCITAMENTE el camino que mide que un «te lo hemos enviado» optimista se
    // corrige en pantalla cuando resulta ser mentira; sin la palanca, byte-idéntico.
    // La DEMORA de este viaje la inyecta el servidor de la batería (`scenario.codigoDemoraMs`),
    // no este manejador: aquí solo se decide QUÉ contesta, no CUÁNDO.
    sendVerificationCode: () => {
      if (scenario.codigoFalla) {
        return { ok: false, error: { code: scenario.codigoFalla,
                                     message: 'demasiadas peticiones de código' } };
      }
      return { ok: true, sent: true };
    },
    // El código correcto abre la verja de datos personales: a partir de aquí la
    // hidratación SÍ trae lo de la familia (mismo efecto que `_markStepUpFresh_` en el
    // servidor de verdad).
    verifyEmail:          (p) => {
      if (p && p.stepup) { scenario.otpSuperado = true; if (scenario.ventanaViva) acunar(p); }
      return { ok: true, verified: true };
    },

    // ── Paso 7 · el SIMULADOR de cuotas (orientativo, no compromete) ─────────
    // La forma la copia del contrato real (`enr_proyectarSimulacionesDelEnsayo_` del KMS).
    // Se sirven DOS formas de pago a propósito: con una sola, la comprobación de que la
    // familia PUEDE elegir pasaría en vacío, que es peor que no tenerla.
    simularCuotas: () => {
      // ⛔ El simulador CAÍDO responde `simulable:false`, NO `ok:false`: el despachador
      // real envuelve el resultado en `{ok:true, ...}` y este manejador NUNCA lanza por
      // un fallo de simulación (`enr_wizardSimularCuotas`, KMS). Fingirlo con `ok:false`
      // simularía un fallo de TRANSPORTE, que es otra cosa y otro camino.
      if (scenario.simulacionFalla) {
        return { ok: true, simulable: false, motivo: 'NO_SE_PUDO_SIMULAR', simulaciones: [] };
      }
      // `0º.tricies.sexdecies` (2026-08-22) — DOS HERMANOS, cada uno con SU presupuesto.
      // Sin esta palanca el simulado sirve planes de UN SOLO solicitante, así que la
      // comprobación del separador por alumno pasaría EN VACÍO (con un solo hijo no hay
      // nada que separar y la pantalla, a propósito, no pinta ningún nombre).
      if (scenario.dosSolicitantes) {
        const planDe = (personId, sufijo) => ({
          applicant_person_id: personId,
          template_id: 'tpl-' + sufijo, template_designation: 'Cuota escolar', motivo: null,
          modalidades: [
            { modality_id: 'mod-anual-' + sufijo, modality_code: 'ANNUAL', designation: 'Pago anual',
              installments: 1,
              cuotas: [{ due_date: '2027-09-01', concepto: 'Cuota escolar', amount_cents: 300000 }],
              per_installment_cents: null, gross_cents: 300000, discount_cents: 0,
              net_cents: 300000, currency_code: 'EUR', available: true, descuentos: [] },
            { modality_id: 'mod-mensual-' + sufijo, modality_code: 'MONTHLY', designation: 'Pago mensual',
              installments: 2,
              cuotas: [
                { due_date: '2027-09-01', concepto: 'Cuota escolar', amount_cents: 150000 },
                { due_date: '2027-10-01', concepto: 'Cuota escolar', amount_cents: 150000 },
              ],
              per_installment_cents: 150000, gross_cents: 300000, discount_cents: 0,
              net_cents: 300000, currency_code: 'EUR', available: true, descuentos: [] },
          ],
        });
        return {
          ok: true, simulable: true, motivo: null,
          simulaciones: [
            planDe(FIXTURE.applicantId, 'uno'),
            planDe(FIXTURE.applicant2Id, 'dos'),
          ],
        };
      }
      // `0º.quaterdecies` (2026-08-21) — UN NIÑO PUEDE TENER VARIOS PLANES A LA VEZ: cada
      // plantilla aplicable llega como SU PROPIA fila de `simulaciones`, con el MISMO
      // `applicant_person_id`. Se pide EXPLÍCITAMENTE con la palanca del escenario — sin
      // ella, un solo plan, byte-idéntico al de siempre.
      if (scenario.dosPlanes) {
        return {
          ok: true, simulable: true, motivo: null, huella: 'HUELLA-E2E-DOS-PLANES',
          simulaciones: [{
            applicant_person_id: FIXTURE.applicantId,
            template_id: 'tpl-cuota-e2e', template_designation: 'Cuota escolar', motivo: null,
            modalidades: [
              { modality_id: 'mod-cuota-e2e', modality_code: 'ANNUAL', designation: 'Pago anual',
                installments: 1, cuotas: [{ due_date: '2027-09-01', concepto: 'Cuota escolar', amount_cents: 300000 }],
                per_installment_cents: null, gross_cents: 300000, discount_cents: 0,
                net_cents: 300000, currency_code: 'EUR', available: true, descuentos: [] },
            ],
          }, {
            applicant_person_id: FIXTURE.applicantId,
            template_id: 'tpl-comedor-e2e', template_designation: 'Comedor', motivo: null,
            modalidades: [
              // `0º.tricies` — comedor tiene UNA sola forma de pago (como en el caso real de
              // Diego: 9 × 95,00 €) pero VARIOS vencimientos: sirve para comprobar que un
              // plan SIN selector también enseña su calendario entero. 8 × 150,00 € = el
              // mismo total de 1.200,00 € de antes, para no mover la suma del solicitante.
              { modality_id: 'mod-comedor-e2e', modality_code: 'MONTHLY', designation: 'Pago mensual',
                installments: 8,
                // `0º.tricies.ter` — ESTE es el caso del comedor real: TODAS sus filas llevan
                // descuento y el plan acaba en 0,00 €. Con descuento 0 la comprobación de la
                // columna pasaría en vacío, que es peor que no tenerla.
                cuotas: Array.from({ length: 8 }, (_, i) => ({
                  due_date: `2027-${String(9 + (i % 4)).padStart(2, '0')}-0${1 + Math.floor(i / 4)}`,
                  concepto: 'Comedor mediodía', amount_cents: 15000,
                  descuento_cents: 15000, neto_cents: 0 })),
                per_installment_cents: 15000, gross_cents: 120000, discount_cents: 120000,
                net_cents: 0, currency_code: 'EUR', available: true,
                descuentos: [{ policy_code: 'PROMO', designation: 'Promoción servicios accesorios' }] },
            ],
          }, {
            // ⭐ `0º.tricies` (segunda vuelta) — UN PLAN QUE NO ADMITE NINGUNA FORMA DE PAGO.
            // NO es lo mismo que el comedor de arriba, que tiene UNA: aquí no hay ninguna, y
            // el KMS lo devuelve con `modality_id`/`modality_code`/`designation` a **null**
            // (`fin_previewTemplateSchedule` simula con `candidates = [null]` + aviso
            // `NO_MODALITIES_ADMITTED`; lo proyecta `enr_proyectarSimulacionesDelEnsayo_`).
            // Esa forma es la que hacía que la línea empezara por un « · » suelto, y sin este
            // caso en el doble la comprobación pasaba en vacío sobre el comedor.
            applicant_person_id: FIXTURE.applicantId,
            template_id: 'tpl-permanencia-e2e', template_designation: 'Permanencia', motivo: null,
            modalidades: [
              { modality_id: null, modality_code: null, designation: null,
                installments: 2,
                cuotas: [
                  { due_date: '2027-09-01', concepto: 'Permanencia mañana', amount_cents: 25000 },
                  { due_date: '2027-10-01', concepto: 'Permanencia mañana', amount_cents: 25000 },
                ],
                per_installment_cents: 25000, gross_cents: 50000, discount_cents: 0,
                net_cents: 50000, currency_code: 'EUR', available: true, descuentos: [] },
            ],
          }],
        };
      }
      return {
        // ⭐ `0º.tricies.quindecies` — LA HUELLA VIAJA CON LA SIMULACIÓN, igual que en el
        // KMS real (`enr_simularCuotasDelGrupoCore_` la estampa en `out.huella`). Es lo
        // que decide, en el servidor Y en el navegador, si una simulación ya calculada
        // sigue valiendo. Sin ella aquí, el doble no reflejaría el contrato y el camino
        // `simulador-no-recalcula-al-navegar` pasaría midiendo otra cosa.
        // ⛔ El fallo (`NO_SE_PUDO_SIMULAR`, arriba) NO la lleva — tampoco la lleva el real.
        ok: true, simulable: true, motivo: null, huella: 'HUELLA-E2E-UN-PLAN',
        simulaciones: [{
          applicant_person_id: FIXTURE.applicantId,
          template_id: 'tpl-e2e', template_designation: 'Cuota escolar', motivo: null,
          modalidades: [
            // `0º.tricies.ter` — la fila lleva sus TRES cifras, como las proyecta el KMS.
            { modality_id: 'mod-anual-e2e', modality_code: 'ANNUAL', designation: 'Pago anual',
              installments: 1,
              cuotas: [{ due_date: '2027-09-01', concepto: 'Cuota escolar', amount_cents: 525000,
                         descuento_cents: 26500, neto_cents: 498500 }],
              per_installment_cents: null, gross_cents: 525000, discount_cents: 26500,
              net_cents: 498500, currency_code: 'EUR', available: true,
              descuentos: [{ policy_code: 'ANNUAL', designation: 'Descuento por pago anual' }] },
            { modality_id: 'mod-mensual-e2e', modality_code: 'MONTHLY', designation: 'Pago mensual',
              installments: 10,
              cuotas: Array.from({ length: 10 }, (_, i) => ({
                due_date: `2027-${String(9 + (i % 4)).padStart(2, '0')}-01`,
                concepto: 'Cuota escolar', amount_cents: 52500,
                descuento_cents: 0, neto_cents: 52500 })),
              per_installment_cents: 52500, gross_cents: 525000, discount_cents: 0,
              net_cents: 525000, currency_code: 'EUR', available: true, descuentos: [] },
          ],
        }],
      };
    },
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
