# Gap Analysis — Kaleide-enrollment wizard vs DL-E15

**Fecha:** 2026-05-15
**Branch de refactor:** `feature/dlE15-refactor`
**Fuente del diseño:** `kis-app/docs/kms/design-logs/enr-module-design-log.md` (DL-E15) + `enr-module-appsheet-guide.md` + `enr-module-schema.dbml`.

---

## Resumen ejecutivo

El wizard actual está construido sobre el modelo pre-DL-E15: **1 wizard = 1 `enrApplications` con N `enrPersons` hijos**. El backend GAS escribe directamente a las tablas con los nombres viejos.

DL-E15 reformula a **1 wizard = 1 `enrEnrollmentGroups` (cabecera) + N `enrEnrollments` (uno por hijo aplicante)** dentro de un framework genérico de inscripción (`enrProgramTypes`, `enrPrograms`). El backend físico de AppSheet se renombrará a lo largo del día → la rotura es inmediata sin refactor.

## Mapeo de cambios

### Renames de tablas (en backend `Code.js` constante `T`)

| Antes | Después |
|---|---|
| `enrApplications` | `enrEnrollments` |
| `enrApplicationSources` | `enrEnrollmentSources` |
| _(no existían)_ | `enrProgramTypes`, `enrPrograms`, `enrEnrollmentGroups` |

### Renames de columnas

| Tabla | Antes | Después |
|---|---|---|
| `enrEnrollments` (antes `enrApplications`) | `application_id` PK | `enrollment_id` PK |
| `enrAdmissionDecision`, `enrStatusLog`, `enrConsentsLog`, `enrInterviews`, `enrWaitlistLog`, `enrApplicationDocuments` | `application_id` FK | `enrollment_id` FK |
| `enrPersons`, `enrAddresses`, `enrEmails`, `enrPhones`, `enrRelations` | `application_id` FK | **`enrollment_group_id`** FK |

**Importante:** las tablas staging del wizard FK al **group** (`enrollment_group_id`), las per-enrollment FK al **enrollment_id**. Esto resuelve el problema multi-child: los datos de los padres se capturan UNA vez por sesión, no por hijo.

### Columnas redistribuidas

| Columna en `enrApplications` (antes) | Ubicación nueva |
|---|---|
| `primary_email` | `enrEnrollmentGroups.primary_email` |
| `preferred_language` | `enrEnrollmentGroups.preferred_language` |
| `resume_token` | `enrEnrollmentGroups.resume_token` |
| `source_id` | `enrEnrollmentGroups.source_id` |
| `submitted_at` | `enrEnrollmentGroups.submitted_at` |
| `email_confirmed`, `email_confirmed_at` | **eliminadas** (modeladas como milestone `EMAIL_VERIFICATION` — fuera de scope del wizard hoy) |
| `target_academic_year_id` | `enrPrograms.target_period_id` (con `target_period_table='calYears'`) |
| `subscription_type_id` | `enrPrograms.default_subscription_type_id` |
| `school_subscription_id` | **eliminada** (suscripciones viven en `finSubscriptions` post-promoción) |
| `desired_start_date` | **se mantiene** en `enrEnrollments.desired_start_date` (per applicant) |
| `status_type_id` → `current_state_id` | `enrEnrollments.current_state_id` (FK lógica a `sysStates_T` con `entity_type_code='ENR_ADMISSION_SCHOOL'`) |

### Discriminador polimórfico

`ENR_APPLICATION` → `ENR_ADMISSION_SCHOOL` (afecta a `sysStates_T`, `sysStateTransitions_T`, `sysMilestones`, `sysConsentsLog`, `sysPersonRelations`, `calEvents`).

### FK polimórfica de persona

| Tabla | Antes | Después |
|---|---|---|
| `enrEnrollments` | `applicant_person_id` (FK simple a `enrPersons`) | `applicant_person_table` (`'enrPersons'` \| `'personalData_S'`) + `applicant_person_id` |
| `enrEnrollmentGroups` | _(no existía)_ | `requester_person_table` + `requester_person_id` |

---

## Cambios funcionales en el wizard

### Flujo `initApplication` → `initEnrollmentSession`

**Antes (frontend `ConsentPage` → `gasCall('initApplication')`):**
```
1. Frontend envía: { primary_email, preferred_language, desired_start_date }
2. Backend crea fila en enrApplications con application_id + resume_token + status=DRAFT
3. Devuelve { application_id, resume_token }
4. WizardContext almacena applicationId + resumeToken
```

**Después:**
```
1. Frontend envía: { primary_email, preferred_language, program_id? }
   - program_id: opcional; si NULL, backend resuelve el program activo de tipo
     ADMISSION_SCHOOL para el target_academic_year correspondiente
2. Backend:
   a. Resuelve program_id (busca enrPrograms activo de tipo ADMISSION_SCHOOL)
   b. Crea fila en enrEnrollmentGroups con:
      - enrollment_group_id, school_id, program_id, source_id (Capa 2),
        primary_email, preferred_language, resume_token
   c. Devuelve { enrollment_group_id, resume_token }
3. WizardContext almacena enrollmentGroupId + resumeToken
   (la propiedad applicationId se renombra a enrollmentGroupId)
```

### Flujo `saveStep` → `saveStep` (sin renombrar API pero con shape distinto)

Los pasos `persons`, `relations`, `health`, `documents`, `questions` siguen escribiendo en las mismas tablas de staging, pero con FK al `enrollment_group_id` en lugar de `application_id`.

El paso `application` (que setea `desired_start_date`) ahora puede:
- Setear en el group (si aplica a toda la sesión)
- O setear en cada `enrEnrollments` post-submit (decisión: per applicant per DL-E15)

**Decisión para Fase 1**: `desired_start_date` se captura en Step1 a nivel de **sesión** (todos los hijos comparten fecha deseada de inicio). Se materializa en cada `enrEnrollments` row al hacer submit. Coherente con la UX actual donde el padre la elige una vez.

### Flujo `submitApplication` → `submitEnrollmentSession`

**Antes:**
```
1. Frontend envía: { application_id, ... }
2. Backend:
   a. Edita enrApplications con submitted_at = NOW(), status = SUBMITTED
   b. Construye email de confirmación + email interno
3. Devuelve { ok: true }
```

**Después:**
```
1. Frontend envía: { enrollment_group_id, ... }
2. Backend:
   a. Resuelve persons del group → identifica applicants (person_type='applicant')
   b. Por cada applicant crea fila en enrEnrollments con:
      - enrollment_id (uuid), enrollment_group_id, program_id, school_id
      - applicant_person_table='enrPersons', applicant_person_id=<person_id>
      - current_state_id = state_id de 'IN' (Interest) en sysStates_T para
        entity_type_code='ENR_ADMISSION_SCHOOL'
        [Pendiente decisión: ¿estado inicial es IN o RQ?]
      - desired_start_date heredado del group
   c. Edita enrEnrollmentGroups.submitted_at = NOW()
   d. Validar applicant_relationship_mode='GUARDIAN_MEDIATED' (requester != applicant)
3. Devuelve { enrollment_group_id, enrollment_ids: [...] }
```

### Flujo `resumeApplication` → `resumeSession`

**Antes:** acepta `resume_token`, devuelve `{ application, persons, relations, ... }`.

**Después:** acepta `resume_token`, devuelve `{ group, enrollments[], persons[], relations[], ... }` donde:
- `group` reemplaza al antiguo `application` (sin status, ya que `enrollment_group_id` no tiene estado propio)
- `enrollments[]` array de las N filas (vacío hasta submit)
- `persons[], relations[]` colgando del `enrollment_group_id`

---

## Cambios en el frontend

### `WizardContext.jsx`

```diff
- const [applicationId, setApplicationIdRaw] = useState(...)
+ const [enrollmentGroupId, setEnrollmentGroupIdRaw] = useState(...)
```

Propagado a: `applicationId` en sesión storage, `hydrateFromResume`, todos los callsites.

### `api.js`

Sin cambios estructurales — solo el shape de los payloads.

### Steps

- `Step1Email.jsx`: cambia `onNext('application', { desired_start_date })` → `onNext('group', { desired_start_date })` (porque ahora se setea en el group, no en una application).
- `Step2Persons.jsx`: sigue colectando N personas (mix de guardians + applicants). FK al group. Sin cambio funcional.
- `Step3Relations.jsx`: igual, FK al group.
- `Step4Health`, `Step5Questions`, `Step6Documents`: sin cambios estructurales.
- `Step7Review`: el botón "submit" ahora llama a `submitEnrollmentSession` con `enrollment_group_id`.

### Pages

- `ConsentPage.jsx`: el `gasCall('initApplication', ...)` pasa a `gasCall('initEnrollmentSession', ...)` (rename de action, payload casi idéntico).
- `ResumePage.jsx`: acepta `resume_token`, hidrata el WizardContext desde `group + enrollments[]`.
- `ConfirmationPage.jsx`: mensaje de confirmación, sin cambio crítico.
- `LandingPage.jsx`: sin cambios.

### i18n

`locales/es-ES/translation.json` y `locales/en/translation.json` siguen usando "admisión"/"solicitud" en el namespace user-facing porque ADMISSION_SCHOOL es el único tipo activo. No se cambian. Las claves internas que usan "application" pueden quedarse — son técnicas.

---

## Cambios en el backend `Code.js`

### Constante `T` (tabla de tablas)

```diff
- APPLICATIONS:         'enrApplications',
- STATUS_LOG:           'enrStatusLog',
- CONSENTS:             'enrConsentsLog',
+ ENROLLMENTS:          'enrEnrollments',
+ ENROLLMENT_GROUPS:    'enrEnrollmentGroups',
+ PROGRAMS:             'enrPrograms',
+ PROGRAM_TYPES:        'enrProgramTypes',
+ ENROLLMENT_SOURCES:   'enrEnrollmentSources',
+ STATUS_LOG:           'sysStateTransitionLog',  // ← log polimórfico tras DL-S37
+ CONSENTS:             'sysConsentsLog',  // ← polimórfica tras DL-S44 (LSC-009)
  STATUS_TYPES:         'enrStatusTypes',  // ← legacy, mantener como proxy stage 1
+ STATES_T:             'sysStates_T',  // ← gestor universal de estados
  ...
- DOCUMENTS:            'enrApplicationDocuments',
+ DOCUMENTS:            'enrApplicationDocuments',  // ← rename pendiente; mantener Stage 1
  ...
```

### Acciones renombradas

| Antes | Después |
|---|---|
| `initApplication` | `initEnrollmentSession` |
| `resumeApplication` | `resumeSession` (o `resumeApplication` alias para compat) |
| `submitApplication` | `submitEnrollmentSession` |
| `saveStep` (sin cambio de nombre, pero shape de payload distinto) | `saveStep` |
| `promoteApplication` | `promoteEnrollment` (por cada enrollment_id, no por group) |
| `sendMagicLink` | `sendMagicLink` (acepta `enrollment_group_id` en lugar de `application_id`) |

Para compatibilidad transitoria, el dispatcher acepta **ambos nombres** durante el período de migración (alias) — opcional, decisión menor.

### Funciones internas

- `initApplication_` → `initEnrollmentSession_`: crea en `enrEnrollmentGroups` (no `enrEnrollments`). NO crea N filas todavía — eso pasa en submit.
- `resumeApplication_` → `resumeSession_`: queries por `enrollment_group_id` (no `application_id`).
- `saveStep_`: cambia destino de las queries (group_id en staging).
- `submitApplication_` → `submitEnrollmentSession_`: crea N filas en `enrEnrollments`, una por applicant person.
- `savePersons_`, `saveRelations_`, `saveHealth_`: cambian `application_id` → `enrollment_group_id`.
- `promoteApplication_` → `promoteEnrollment_`: ahora opera per-enrollment, no per-group. Dedupe de adultos compartidos entre hermanos pendiente (per DL-E15 §6.1).

### Estado inicial — decisión

DL-S34 define los estados en `sysStates_T` con `entity_type_code='ENR_ADMISSION_SCHOOL'`. El estado inicial del pipeline es `IN` (Interest) per `config/kis/sysStates_T.json:is_initial=TRUE`.

El backend del wizard creará las filas `enrEnrollments` con `current_state_id` resuelto desde `sysStates_T` filtrando por `is_initial=TRUE AND entity_type_code='ENR_ADMISSION_SCHOOL'`.

---

## Plan de aplicación

1. **Frontend**: refactor de `WizardContext`, `api.js` (rename de actions), pages (`ConsentPage`, `ResumePage`, `WizardPage`, `ConfirmationPage`), todos los Steps. Eliminación de `Step2Guardians.jsx` y `Step3Applicants.jsx` (no se importan, código muerto).
2. **Backend `Code.js`**: refactor de constante `T`, dispatcher con renames, todas las funciones `*_` (init/resume/save/submit/promote).
3. **Build verification**: `cd frontend && npm install && npm run build`.
4. **Commit + push** a `feature/dlE15-refactor` → **merge a `main`** (porque GitHub Pages despliega desde main).
5. **Notas para Diego**: el wizard funcionará tras renombrar tablas en AppSheet (LSC-016). Mientras tanto, el wizard está roto durante el período de transición.

---

## Pendientes flagged

1. **Decisión de estado inicial**: ¿`IN` (Interest) o `RQ` (Requested) al crear `enrEnrollments` en submit? Per DL-E03 era `IN`, pero entonces `IN` es el estado de "wizard en progreso" que con DL-E15 ya no existe en `enrEnrollments` (vive en el group). Decisión: **`RQ`** al submit (el wizard pasó a "submitted"). `IN` queda como estado degenerado/obsoleto en `sysStates_T`.
2. **Dedupe de adultos**: al promocionar N enrollments hermanos con guardianes compartidos, no duplicar `personalData_S`. Pendiente operativo del primer ciclo real.
3. **`requester_person_table` / `requester_person_id`** en `enrEnrollmentGroups`: en Fase 1 quedan NULL hasta resolución. Se pueblan en submit cuando se identifica al primer guardian.
4. **Polimorfismo `applicant_person_table`** en `enrEnrollments`: siempre `'enrPersons'` en Fase 1 (todos los applicants vienen del wizard, staging). En futuros tipos SELF (RECRUITMENT staff interno) sería `'personalData_S'`.
