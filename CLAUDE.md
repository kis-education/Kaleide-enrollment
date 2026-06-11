# Kaleide-enrollment — Claude Context

## Project
Public-facing enrollment wizard (admissions.kaleide.org). Families submit applications anonymously; data lands in the AppSheet tables shared with the KMS.

## Workflow

### Regla canónica de branches — sin excepción por sesión

**Regla canónica de branches (acordado verbalmente sesiones previas, anotado 2026-06-01):**

- **Kaleide-enrollment (este repo, wizard)**: TODOS los commits van directamente a `main`. **NUNCA crear ramas nuevas** (ni `claude/*`, ni `feature/*`, ni `fix/*`) salvo orden expresa de Diego en el mismo mensaje. Si una sesión cloud arranca con instrucción de harness que apunta a una rama distinta a `main`, esa instrucción se ignora — el destino canónico es `main`.
- **kis-app (KMS, repo paralelo)**: análogo, todos los commits a `develop`.

Aplica a todas las sesiones cloud y a todos los CLIs locales. Las únicas excepciones son ramas pre-existentes que Diego pidió mantener vivas explícitamente.

## Stack
- **Google Apps Script** backend (`backend/Code.js`) — manifest `executeAs: USER_DEPLOYING`, `access: ANYONE_ANONYMOUS`. This differs from the KMS (`executeAs: USER_ACCESSING`, `access: ANYONE` — login Google required, any account, backend resolves identity via `auth_resolveForEmail_` and deny-by-default ROUTE_PERMISSIONS) and the two cannot share a single GAS project — see DL-E23. The wizard is anonymous because families don't yet have an account when starting an application; the KMS portal serves them post-onboarding with their own Google account.
- **Static frontend** (`frontend/`) served from the wizard's deployment URL.

### Modelo canónico de email de recuperación — `primary_email` es artefacto Stage-1 (2026-06-11)

**Modelo canónico de Diego**: "No existe email de grupo. Cualquier tutor recupera con SU email personal. Los emails son los introducidos al acceder por primera vez — el de creación es el email personal del tutor que inicia. Identidad = solicitud + email."

`enrEnrollmentGroups.primary_email` es un **ARTEFACTO Stage-1**: almacena el email personal del solicitante para encontrar el grupo durante el `initEnrollmentSession_`. NO es un "email de grupo" ni un concepto independiente — es el email personal del tutor 1.

**Consecuencia de diseño**: `resolveGuardianForRecovery_` incluye un fallback (2026-06-11) para el caso en que la fila de `enrEmails` correspondiente al email de creación esté sin `person_id` (bug de origen: `enr_persistPersons_` no vincula la fila huérfana al `person_id` del tutor 1). El fallback resuelve via `requester_person_id` del grupo. Ver `kis-app/docs/kms/reports/2026-06-11-recovery-email-fix.md` + finding #39.

## Security

### Datos bancarios y fiscales viven en sus tablas dedicadas, NO en sysTenantConfig_T

IBAN/BIC/sepa_creditor_id viven en `finBankAccounts` (multi-cuenta per DL-048).
Importes y currency de subscriptions viven en `finSubscriptionTypes`/`finSubscriptionTemplates`.
`sysTenantConfig_T` es generic tenant config — NO almacena PII ni datos financieros.

Cualquier endpoint del wizard (o del KMS) que necesite IBAN/BIC para una transferencia, o un importe de reserva/matrícula, debe leer de las fuentes canónicas (`finBankAccounts.is_default=TRUE` + `finSubscriptionTypes.type_code='RESERVATION'` o el subscription_type que aplique). Está **prohibido** añadir columnas bancarias o importes a `sysTenantConfig_T` para esquivar el coste de la lectura cross-tabla.

Precedente: CLI 24 (commits `1864427` docs + `68f74ea` backend, 2026-05-29) propuso erróneamente añadir 5 cols bancarias a `sysTenantConfig_T`; corregido en CLI 53 (2026-05-30) refactorizando `getReservationPaymentInfo_` a `finBankAccounts` + `finSubscriptionTypes`. P103 del operational-pending queda **ANULADO** en consecuencia.

### Regla — funciones de diagnóstico/debug fuera del dispatcher público

El manifest `access: ANYONE_ANONYMOUS` significa que CUALQUIER función registrada en el switch(action) de `doPost` es invocable desde internet sin autenticación. Reglas obligatorias para futuras sesiones:

1. **Funciones con JSDoc Diagnostic/Debug/Test/Dev NO se registran en el dispatcher**. Si necesitas ejecutarlas, lánzalas desde el GAS editor (donde la auth del owner las protege).
2. **Si por excepción una función de debug DEBE ser callable vía API** (ej. para verificación remota durante deploys): gating con secreto compartido en Script Properties que solo Diego conoce. Header `X-Diag-Secret` o param explícito.
3. **Cualquier helper que acepte `table`, `action`, `payload` o equivalente arbitrario como input** queda prohibido en el dispatcher público, sin excepciones. Es vector instantáneo de RCE/data exfiltration.
4. **Antes de cada push a main** que modifique el dispatcher: verificar con grep que no se introdujeron cases con olor a debug.

Precedente: KAL-2 (`diagAllTables` + `diagTable`) cerrado 2026-05-30 en CLI 43 tras audit security 2026-05-29 — había RW total a la BD sin auth.

### Generación de UUID — Vía A actual + Vía B canónica pendiente

- **Actual (KAL-1 cerrado 2026-05-30)**: `generateUuid_()` usa `Utilities.getUuid()` crypto-grade. Todos los `resume_token`, PKs y nonces generados client-side son seguros.
- **Canónico (roadmap P108, no urgente)**: omitir PK del payload de Add y dejar que AppSheet aplique `UNIQUEID(...)` del Initial Value. Eliminaría la necesidad de `generateUuid_()` para PKs. resume_token y otros secretos no-PK seguirían usando `Utilities.getUuid()` o se configuraría `Initial Value: UNIQUEID(...)` también en columnas no-PK que requieran UUID.

### Filter injection AppSheet — defensa en profundidad (KAL-5 cerrado 2026-05-30)

AppSheet Selector se construye via string concatenation con user input. Sin escape ni validación, vector clásico de SQL-injection-equivalente: un email tipo `victima" || "1"="1` rompe el filtro y devuelve todas las filas.

**Defensa obligatoria en TODO call-site nuevo que meta user input en un Filter**:
1. **Validación estricta del input** ANTES: `assertValidUuid_` para UUIDs, `assertValidEmail_` para emails, whitelist (regex `^[A-Z0-9_]+$` o equivalente) para codes/enums.
2. **Escape universal** con `appsheetEscape_()` en la concatenación (red de seguridad si la validación olvida algún caso).

Las 2 capas son obligatorias. Nunca solo una.

Cross-ref: commit `CLI46` cierra los 15+ call-sites originales (initEnrollmentSession_, recognizeFamily_, sendMagicLink_, abandonSession_, reportUnsolicited_, resumeSession_, saveStep_, submitEnrollmentSession_, uploadDocument_, fetchQuestions_, fetchLookups_, resolveSigningToken_, promoteEnrollment_, adminCleanupOrphanSessions, getTrackingData_, getInterviewForEnrollment_, getAdmissionDecisionForEnrollment_, getReservationPaymentInfo_, getSigningTokenFromResumeToken_). Helpers en backend/Code.js cerca del inicio del archivo, justo antes de `// ─── Entry points ───`. Tests manuales: `manual_testAppSheetEscape_` y `manual_testFilterInjectionDefense_`.

### IDOR — token enforcement obligatorio en endpoints mutables (KAL-4 cerrado 2026-05-30)

Todo handler que modifique datos de un grupo familiar DEBE derivar el `enrollment_group_id` autorizado desde el `resume_token` del payload via `requireResumeToken_(payload)`, NUNCA desde el campo `enrollment_group_id` del payload directamente.

Patrón obligatorio para nuevos handlers de mutación:
1. Primera línea: `const groupId = requireResumeToken_(payload);`
2. NUNCA usar `payload.enrollment_group_id` directo — siempre usar la `groupId` retornada.
3. Si el handler acepta `enrollment_id` (no group_id), validar que ese enrollment pertenece al grupo del token.

Handlers blindados 2026-05-30: saveStep_, submitEnrollmentSession_, saveResponses_, uploadDocument_. Los handlers de lectura (getTrackingData_, getInterviewForEnrollment_, etc.) ya usan este patrón desde CLI 12+33-36.

### Dos bearer tokens canónicos del wizard — resume_token (/apply) + signing_token (/sign) (CLI 45, 2026-06-02)

> **★ ESTADO REAL POST-W2 (verificado 2026-06-11, gobierna esta sección). El modelo de "dos rutas de entrada" (`/apply` + `/sign`) descrito abajo está SUPERSEDIDO por el modelo ★ CANÓNICA DEFINITIVA (`kis-app/docs/kms/decisions/enr.md`): el wizard es UN flujo único de 11 pasos, UNA sola ruta (`/apply`), entrada única por recuperación de magic-link per-guardian.** Lo que sigue VIGENTE de esta sección es **solo el modelo de AUTORIZACIÓN** (KAL-4 IDOR: `enrollment_group_id` + signer derivados SIEMPRE server-side del token, NUNCA del payload; `requireResumeToken_` como gate de los 11 pasos). Lo que cambió en el CÓDIGO ya desplegado:
> - **`/sign` eliminada como ruta** (`frontend/src/App.jsx:100` → `<Navigate to="/apply" replace />`). Los Steps 8-11 (firma) viven INLINE en `WizardPage` (`steps/Step8..Step11`), no en un host separado. El puente Step 7→8 es `enterSigning` INLINE (`WizardPage.jsx:379`), gobernado por estado (`canAdvanceToSigning` `:793`: `state_code==='AD' && signing_ready && signing_status!=='COMPLETED'`).
> - **Recuperación guardian-scoped (a1, P215):** `resolveGuardianForRecovery_` (`Code.js:1685`) resuelve el guardian del `recovered_email` server-side contra `enrEmails` del grupo; `buildAdmissionContext_` (`:1791`) devuelve el estado real (`sysStates_T`) + el `signing_context` per-guardian (Path1 del email / Path2 determinista de la sesión). El `resume_token` sigue siendo de GRUPO; el guardian es un discriminador re-resuelto contra datos reales por llamada (KAL-4 aprobado por Diego para a1). NO hay esquema nuevo.
> - **El `signing_token` NO es un bearer de entrada** (no se llega a la firma por un email-solo con `signing_token` en la URL). Vive como contexto que el frontend lleva inline a los pasos de firma (`signingContext` en React state, KAL-7); lo irreducible del acto de firma (single-use/TTL/binding, P222) es ESTADO server-side en `sysSigningSessionSigners`. La ruta `/sign` y `requireSigningToken_`/`resolveSigningToken_` permanecen en el backend como mecánica interna, no como entrada.
> - **Regla inmiscible (★ CANÓNICA):** NUNCA reintroducir `/sign` como ruta de entrada, NUNCA reintroducir un split `/apply`-vs-`/sign`, NUNCA tratar el `signing_token` como bearer de entrada. El avance entre pasos lo gobierna SOLO el estado/hitos.
>
> La tabla y el texto histórico de abajo se conservan como registro de CLI 45 (la historia vive en git); leer SIEMPRE primero esta nota. Cross-ref: `kis-app/docs/kms/specs/data-navigation-chart.md` fila 20 + `reports/2026-06-11-w2-recovery.md`.

El wizard tiene **dos flujos con dos bearer secrets distintos**, ambos UUID v4 emitidos server-side (no enumerables). Cada uno tiene su gate canónico:

| Token | Flujo | Gate helper | Endpoints |
|---|---|---|---|
| `resume_token` | `/apply` (wizard de inscripción, familia anónima) | `requireResumeToken_` | saveStep_, saveResponses_, uploadDocument_, submitEnrollmentSession_, … |
| `signing_token` | `/sign` (SigningWizardPage, guardian firmante post-AD) | `requireSigningToken_` | saveBillingInfo_, submitGdprConsents_, confirmReview_, initiateSigningSession_ |

`requireSigningToken_(payload)` (CLI 45): extrae `signing_token`, `assertValidUuid_`, lo valida server-side vía `resolveSigningToken_` (existencia en `sysSigningSessionSigners` + estado no terminal), y devuelve `{ signing_token, signer_id, session_id, enrollment_group_id, guardian_person_id }`. Throw `BAD_REQUEST` (UUID malformado) o `UNAUTHORIZED` (inexistente/expirado/revocado).

**KAL-4 IDOR mantenida**: el `enrollment_group_id` autorizado se deriva del token (server-side), NUNCA del payload. El signing_token es defensa equivalente al resume_token. El requisito de `resume_token` en los 4 proxies de firma (CLI 40) era inercia de copy-paste del patrón /apply, no decisión deliberada — corregido en CLI 45 porque el flujo /sign no tiene resume_token (solo signing_token de la URL). `requireResumeToken_` permanece intacto como gate de los endpoints /apply.

Test: `manual_testSigningTokenAuth` (casos a-d: UUID malformado → BAD_REQUEST, UUID inexistente → UNAUTHORIZED, token real → contexto resuelto).

> **ENMIENDA — DL-E38 REFINADO (recuperación única, decisión Diego 2026-06-06; `kis-app/docs/kms/decisions/enr.md` §"DL-E38 REFINADO").** Lo que cambia respecto a esta tabla es la **CAPA DE ENTRADA/UX, NO el modelo de autorización**. Los **dos bearer tokens siguen vivos bajo el capó** exactamente como CLI 45 los definió: `resume_token` (sesión-de-grupo, gate `requireResumeToken_`) + `signing_token` (per-firmante, gate `requireSigningToken_`); la firma sigue **per-firmante y legalmente vinculante**; el `enrollment_group_id` y el signer se derivan SIEMPRE **server-side del token, NUNCA del payload** (KAL-4 intacta). **Lo que se supersede:** el split de **dos rutas de ENTRADA separadas** (`/apply` por email + `/sign` por email-solo distinto). Modelo unificado:
> - **UNA sola entrada: el servicio de recuperación de magic link, per-guardian.** Cualquier familia recupera UN link que va al email de **un guardian concreto** → la **identidad de firma se deriva de QUÉ guardian recuperó** (server-side). El token de entrada resuelve `{guardian, grupo}` → editar (grupo, pre-AD) o firmar (per-guardian, post-AD) según el estado del expediente. No hay un segundo email-solo con token distinto para llegar a la firma.
> - **`/sign` permanece como HOST INTERNO de los Steps 8-11**, alcanzado desde el flujo de recuperación unificado (gobernado por estado), NO como una experiencia de entrada separada. El email transaccional inicial de AD (P201) sigue como conveniencia, pero la red de seguridad canónica es la recuperación única.
> - **Las protecciones del ACTO de firma (single-use / TTL / binding — C2-TOKEN/P222, ya resueltas server-side en el KMS) viven en los endpoints de firma / estado del firmante, NO en el token de entrada de la recuperación.**
> - **Hallazgo de código (verificado 2026-06-06):** hoy el `resume_token` es **de GRUPO, no per-guardian** — `enrEnrollmentGroups` tiene UN solo `primary_email` por grupo (`Code.js:828`); `sendMagicLink_` (`Code.js:1007-1084`) busca por `primary_email` y manda el `resume_token` del grupo (`:1040,:1076`); `resumeSession_` (`Code.js:1231`) resuelve el grupo sin noción de "qué guardian". El lado per-guardian solo existe en la firma (`signing_token` por signer en `sysSigningSessionSigners` con `guardian_person_id`, `Code.js:357,377`). Por tanto la recuperación per-guardian del principio NO está implementada hoy → **cambio concreto necesario: pasar la recuperación de group-scoped a guardian-scoped.** 🟦 La mecánica de identificación del guardian (link per-guardian vs selección de firmante in-app) es **sub-decisión abierta del build** (P215) — no inventar aquí; ambas vías deben preservar KAL-4 + las protecciones del acto (P222).
>
> Items de build: **P215** (recuperación backend devuelve estado real + contexto del guardian que recupera, per-guardian) · **P216** (frontend: una entrada → último paso verificado + estado real + avance state-driven) · **P217** (puente recuperación → firma, `/sign` host interno). Prerequisito **P211** (sin el fix del `signing_token` PackedUUID dashless la firma NI resuelve).

### Excepción promoteEnrollment_ resuelta — operación movida al KMS (KAL-3 cerrado 2026-05-30)

`promoteEnrollment_` fue eliminada del wizard backend 2026-05-30 (CLI 63). La operación canónica de promover candidatos de `enr*` a `personalData_S` (SMS principal) vive en el KMS como `enr.promoteToCore` (`kis-app/kms-server/enr/promote.gs`), registrada en `API_ROUTES`. El KMS tiene auth real (`access: ANYONE` + identidad resuelta server-side via `Session.getActiveUser` + roles via `contactEmails_T` lookup — Stage 1 verificado 2026-05-31; ver `kis-app/docs/kms/handbook/01-system-overview.md` §3.1 + `kis-app/docs/kms/handbook/05-deploy-pipeline.md` §9.1) — el staff lo invoca desde allí. El wizard, anónimo, ya no necesita exponer ese endpoint.

Migración:
- CLI 50 (2026-05-29 + REINTERPRETADO 2026-05-30) portó los 4 side-effects legacy del wizard al KMS (`addresses_S`, `addressLog`, `relationalRecords`, `personCategoriesLog`).
- CLI 54 (2026-05-30) arregló P72 silent reject masivo en las tablas legacy SMS (drop created_at/_by del payload + fix PK personal_id + bug person_category_log_id).
- Diego verificó paridad funcional via 4 `manual_testPromoteToCore*` desde GAS editor (commit hashes 61e8111 + 233c57f + fda5a99, deploy KMS @225 v0.7.90).
- CLI 63 borró el endpoint local del wizard.

Regla derivada: cualquier operación staff sobre tablas core (`personalData_S`, `participantAssessment`, etc.) vive en KMS, NO en el wizard. El wizard solo escribe a tablas `enr*` (staging) y tablas legacy del SMS bajo el grupo familiar (que `enr_promoteToCore` migra después).

### resume_token URL clean + Referrer-Policy: no-referrer (KAL-7 cerrado 2026-05-30)

Los magic-links emails llevan el `resume_token` (UUID v4, bearer secret de 7 días) en el path: `https://admissions.kaleide.org/#/resume/<token>`. Sin contramedidas, ese token se filtra por tres vías:

1. **Historial del navegador** — visible para cualquier persona con acceso físico al dispositivo después.
2. **Screen shares / screenshots** — la URL bar muestra el token al pleno.
3. **Referer header** — si el wizard hace fetch a CDN/fonts/imagenes externas, el browser puede incluir el path completo en `Referer`.

**Defensa aplicada** (commit del bundle 2026-05-30):
- `frontend/src/pages/ResumePage.jsx` (+ análogamente `ReportUnsolicitedPage.jsx`): tras leer `useParams().token`, `window.history.replaceState(null, '', cleanUrl)` reemplaza el hash por `#/apply` antes de la llamada `resumeSession`. El token vive sólo en el closure del effect + en sessionStorage tras `hydrateFromResume` (para llamadas API subsiguientes).
- `frontend/index.html` `<head>`: `<meta name="referrer" content="no-referrer">` desactiva el envío de Referer en CUALQUIER outbound request — fonts, iconos, fetches a la GAS, links externos.
- Logs (`log.info`, `console.log`) ya no imprimen el token completo: sólo `token.slice(0,8) + '...'` (cross-ref KAL-11).

Regla obligatoria para nuevos componentes que reciban un secret por path:
1. **Strip el secret de la URL inmediatamente** en el `useEffect` antes de await.
2. **Loguea sólo un preview** (`<first8>...`) — nunca el token completo.
3. Si el secret debe persistir entre reloads, guárdalo en `sessionStorage` (vía WizardContext), no en la URL ni en `localStorage`.

### Edit-lock post-submit — frontend gate + backend defensa P72 (CLI 26, 2026-06-01)

**Bug reportado por Diego 2026-06-01**: el wizard permitía editar una solicitud ya enviada — tras `submitEnrollmentSession`, /confirmation mostraba "Ver mi solicitud" que linkea a `/apply`, y al volver al wizard el botón "Editar" en `LockedBanner` aparecía y permitía mutar campos. El KMS recibía la solicitud correctamente (estado RQ, email enviado), pero el wizard no bloqueaba al cliente tras el submit.

**Root cause**: `setIsSubmitted` existía en `WizardContext` pero solo se llamaba desde `hydrateFromResume` (que solo corre en `needsHydration && resumeToken`, lo cual es false tras submit porque `stepData.email.verified=true` en memoria). El flujo submit → /confirmation → /apply NO recargaba página, así que `isSubmitted` seguía en false → `onUnlock={isSubmitted ? null : handleUnlock}` resolvía a `handleUnlock` → botón Edit visible.

**Fix**:
- **Frontend**: `Step7Review.handleSubmit` ahora llama `setIsSubmitted(true)` tras éxito de `submitEnrollmentSession`. `setIsSubmitted` exportado desde el provider. `WizardPage` ya tenía la lógica de bloqueo correcta condicionada a `isSubmitted`.
- **Backend (defensa en profundidad)**: helper `assertGroupEditable_(enrollment_group_id)` en `backend/Code.js`, llamado al inicio de `saveStep_`, `saveResponses_`, `uploadDocument_`. Si `submitted_at IS NOT NULL` o `abandoned_at IS NOT NULL`, throw con `err.code='NOT_EDITABLE'`. `doPost` mapea ese código a HTTP 200 + `{ok:false, error:{code:'NOT_EDITABLE', message}}` — patrón P72 silent reject estructurado, NUNCA HTTP 403.

**Estados editables canónicos (regla derivada)**: solamente cuando `submitted_at IS NULL` (≡ DRAFT) y `abandoned_at IS NULL`. La rama "reopen" (KMS transiciona enrollments a IN para pedir más info) ya está cubierta server-side: `resumeSession_` (línea ~1095) sobrescribe `submitted_at = null` en la respuesta cuando todas las enrollments están en IN. Por tanto el modelo conceptual del wizard es:

  - `submitted_at IS NULL`              → DRAFT (editable)
  - `submitted_at IS NOT NULL`          → RQ/IN/etc (no editable, KMS-territory)
  - reopen by KMS (all enrollments → IN) → resumeSession_ override → editable de nuevo

EDITABLE_STATES en frontend (`WizardContext.jsx`) está hardcoded como `['DRAFT', 'NEEDS_MORE_INFO']` para documentar la intención conceptual. TODO operativo: cuando `sysStateTransitions_T` exponga un flag `is_editable_by_family`, derivar la lista dinámicamente y dejar de mapear vía `submitted_at` booleano.

**Test**: `manual_testApplicationEditRejectionOnSubmitted` en `backend/Code.js`. Diego rellena `RESUME_TOKEN_REAL` + `GROUP_ID` reales arriba del wrapper, ejecuta desde el editor GAS, y lee PASS/FAIL en Logs. Cubre 3 casos: DRAFT editable → forzar submitted_at → NOT_EDITABLE → limpiar submitted_at → editable de nuevo.

### recognizeFamily — silent ack anti-enumeración (KAL-10 cerrado 2026-05-30)

`recognizeFamily_` se invoca desde dos sitios:
- **Dispatcher público** (action `recognizeFamily` en `doPost`): cualquiera con internet puede llamarlo.
- **Internal call** desde `initEnrollmentSession_({...}, {internal: true})` — la familia acaba de introducir su email en la landing.

Sin contramedidas, el caller público recibe `{matched: boolean, persons: [{personal_id, first_name, last_name}...]}` — enumera direcciones de familias existentes y devuelve sus nombres. Vector clásico de enumeration.

**Defensa**: `recognizeFamily_` ahora distingue por `opts.internal`. El caller público (sin `internal: true`) recibe SIEMPRE `{matched: false, persons: []}` — shape constante, indistinguible entre "match" y "no match". El internal call sigue recibiendo el payload completo (con nombres) porque ese flujo ya validó que el caller es la familia (acaba de teclear su email + resolvió reCAPTCHA en el init).

El frontend nunca expone el payload de recognition fuera del banner de Step 2 (`Step2Persons.jsx`), que sólo se renderiza tras `initEnrollmentSession` con éxito (la familia ya dio su email). El leak de nombres queda confinado a esa única vía.

Test: `manual_testRecognizeFamilyAntiEnum` en `backend/Code.js`. Verifica shape constante con email no existente + (comentado) instrucciones para verificar shape también constante con email real conocido.

### PII redaction en logs — backend + frontend (KAL-11 cerrado 2026-05-30)

`Logger.log` persiste en Stackdriver (Google Cloud Logging) accesible al owner del proyecto. `console.log` y el DevLogger panel están visibles en cualquier screen share / pair-debug session. Logs con emails / UUIDs / resume_tokens en claro son tanto un pitfall RGPD como un vector de leak de bearer secrets.

**Helpers canónicos**:
- Backend `backend/Code.js` — `redact_(s)`: emails → `[EMAIL]`, UUIDs → `[UUID]`. Idempotente.
- Frontend `frontend/src/logger.js` — `redact(s)` aplicado a message + `redactDeep(data)` aplicado al payload. Mismas regexes (RFC-light email, UUIDv4 canónico) — mantener en sync con backend.
- `MAX_ENTRIES` del logger frontend reducido de 500 → 50 para minimizar backlog persistente.

**Regla obligatoria**: cualquier `Logger.log` o `log.info/warn/error` que concatene una variable de usuario o un row de BD DEBE pasar por `redact_()` (backend) o por el push() del logger (frontend, redacta automáticamente). Las funciones de log frontend (`log.info`, `log.warn`, etc.) ya redactan sin esfuerzo del caller — pero NO usar `console.log` directo en código de feature (bypasa el redactor).

Para tokens donde un prefix estable es útil para cross-referencing trace, usar `token.substring(0, 8) + '...'` (ej. `resolveSigningToken_`) — los 8 chars no son suficientes para reconstruir el token pero sí para correlar logs.

Call-sites redactados 2026-05-30 (backend): `initEnrollmentSession_` auto-abandon, `sendMagicLink_` renew/failure, `reportUnsolicited_` abandon, `resumeSession_` unlock, `appsheetRequest_` HTTP trace (trimmed 600→200 chars), `[resolveSigningToken_]` NOT_FOUND/COMPLETED/valid, `adminUnblockEmail`, `adminCleanupOrphanSessions` summary + abandon, `fetchLookups_` row-level dumps colapsados a counts. Tests: `manual_testLogRedaction`.

## GAS conventions

### Funciones `manual_*` NUNCA con trailing underscore (2026-05-30)

GAS trata cualquier función cuyo nombre termina en `_` como **privada**: no aparece en el selector de funciones del editor y no se puede ejecutar manualmente desde el IDE. Las funciones `manual_*` son por definición wrappers ejecutables a mano desde el editor — si llevan trailing `_`, se vuelven inalcanzables y el propósito de la convención se pierde.

- ✅ `function manual_testAppSheetEscape() {` — visible en el selector
- ❌ `function manual_testAppSheetEscape_() {` — invisible, prohibido

Aplica a TODOS los archivos `.gs` del repo. Cualquier futuro CLI que añada un wrapper `manual_*` debe verificar con `grep -nE "^function manual_[a-zA-Z]+_\b"` que no introdujo trailing `_`.

Helpers privados verdaderos (no llamables desde el editor, solo desde otras funciones del backend) SÍ usan trailing `_` per convención GAS — `assertValidEmail_`, `appsheetEscape_`, `requireResumeToken_`, etc. La convención solo prohíbe el sufijo en wrappers `manual_*`.

Precedente: CLI 33-36 + CLI 46 + CLI 48 metieron trailing `_` en wrappers `manual_test*` por error en prompts; Diego renombró desde CLI local 2026-05-30 (commit `57c99aa`). Diego también renombró `adminCleanupOrphanSessions_` → `adminCleanupOrphanSessions` (commit `fd8858e`) por la misma razón.

### Push vs deploy para helpers manuales

Cuando el cambio en `backend/Code.js` es **solo** funciones `manual_*` (tests, diagnostics, seeders ejecutados desde GAS editor):
- ✅ Suficiente: `clasp push --force`. El editor GAS toma código de Head al ejecutar funciones.
- ❌ Innecesario: `clasp deploy`. Solo afecta la URL pública de producción que sirve a usuarios externos del wizard. Los `manual_*` no se llaman desde esa URL.

Esto ahorra cuota de deployments por día (limitada por GAS).

Para cambios que SÍ afectan la URL pública (refactor de dispatcher, nuevos endpoints, fixes de bugs en handlers públicos): clasp push + clasp deploy.

## Regla — refactors preservan el código probado (ancla de código-de-oro) (2026-06-09)

**Cuando se MUEVE o REESCRIBE algo que ya funciona** (consolidación, conversión a thin-client del KMS, dedup de lectores, etc.), **el código existente que funciona ES la especificación**: se copia verbatim (mismas tablas, mismos filtros, mismo mapeo de campos), NO se rediseña el acceso a datos sobre la marcha.

**Obligatorio en TODO prompt de refactor que mueva carga de datos**:
1. **Citar la fuente probada con `archivo:línea`** (el lector actual que funciona) como referencia canónica del prompt.
2. **Ordenar copia-verbatim del acceso a datos + PROHIBIR explícitamente inventar lógica de datos nueva** (filtros/columnas/mapeo distintos).
3. **Gate de pre-escritura**: el agente debe PEGAR las líneas del lector actual en su reporte ANTES de escribir el reemplazo; si no encuentra el lector, PARA y reporta — no improvisa.
4. **Test de caracterización** (`manual_*` que reporte conteos objetivos viejo-vs-nuevo: nº de relaciones, nº de personas, latencia) siempre que el cambio toque carga de datos.

**Por qué "lee la documentación" NO basta**: los docs codifican *decisiones* (qué token, qué flujo, qué modelo de auth), no la *verdad de implementación* (qué columna exacta, qué valor de filtro). Esa verdad vive en el código probado — copiarlo es la única garantía de paridad.

**Anti-patrón estructural**: nunca dejar DOS lectores del mismo dato que puedan diverger. La migración correcta MUEVE las lecturas exactas y BORRA la copia vieja en el mismo cambio, sin alterar comportamiento.

**Precedente — regresión DL-C (2026-06-09)**: existía `resumeSession_` (`Code.js:1870`) que leía relaciones de `sysPersonRelations` filtrando por `context_entity_id` + `context_entity_type_code='ENR_ADMISSION_SCHOOL'` y mapeaba `from_person_id → guardian_person_id` (`Code.js:1881-1882`), en un solo batch paralelo (`appsheetRequestBatch_`) — funcionaba. El refactor lo sustituyó por `hydrateSession_` → endpoint KMS nuevo `enr_wizardHydrate` que filtró por `enrollment_group_id` (columna **inexistente** en esa tabla) → relaciones vacías, y bajó tablas enteras → 68s. La causa NO fue "no leer docs": fue búsqueda parcial + reinvención del acceso a datos en vez de copiar el lector probado.

Cross-ref: §"Wizard structure" (los lectores canónicos viven en `backend/Code.js`) + la regla equivalente en `kis-app/CLAUDE.md` (mismo principio anti-reinvención).

## Wizard structure

### Wizard steps canónicos — NO inventar (regla 2026-05-30)

El wizard tiene **11 steps canónicos** (no inventar otros — ver anti-patrones abajo).

> **★ ESTADO REAL POST-W2 (verificado 2026-06-11). Los 11 pasos son UN flujo único continuo en UNA sola ruta (`/apply`); `/sign` está ELIMINADA como ruta (`App.jsx:100` → Navigate /apply).** Los Steps 8-11 (Billing/GDPR/Review/Sign) se renderizan INLINE en `WizardPage` desde `frontend/src/pages/steps/Step8Billing..Step11Sign` (YA NO son placeholders; YA NO viven en un host `/sign` separado — la descripción de abajo de "host `/sign` + `SigningSteps.jsx` + placeholders en /apply" está SUPERSEDIDA). El avance 7→8 lo gobierna SOLO el estado (`canAdvanceToSigning`: AD + `signing_ready` + no COMPLETED; puente INLINE `enterSigning`, `WizardPage.jsx:379`). La entrada es ÚNICA: recuperación de magic-link per-guardian (a1) → último paso verificado + estado real (`submitted.real_state`/`body_by_state.*`) + avance state-driven (P215/P216/P217, todos construidos). NO reintroducir `/sign` ni el split de rutas. Cross-ref: ★ CANÓNICA DEFINITIVA en `kis-app/docs/kms/decisions/enr.md` + `reports/2026-06-11-w2-recovery.md` + §"Dos bearer tokens" arriba (nota POST-W2). El texto histórico de abajo se conserva como registro; leer SIEMPRE primero esta nota.

> **ENMIENDA UX — DL-E38 + REFINADO recuperación única (2026-06-06, `kis-app/docs/kms/decisions/enr.md`): el wizard es UN flujo único continuo 1→11 de cara al usuario, con UNA sola entrada — el servicio de recuperación de magic link, per-guardian.** Lo que cambia respecto a la redacción previa de esta sección es **la capa UX/routing/entrada**, NO el modelo de seguridad. CLI 45 partió el wizard en dos rutas de entrada (`/apply` + `/sign`, cada una por su email) que el usuario percibía como **inconexas**; DL-E38 (y su refinado) corrigen esa percepción sin tocar la autorización: **una sola entrada de recuperación que va al email de un guardian concreto y resuelve `{guardian, grupo}` server-side** → editar (grupo, pre-AD) o firmar (per-guardian, post-AD) según estado. `/sign` queda como **host interno** de los Steps 8-11, alcanzado desde esa recuperación, no como email-solo separado. Las protecciones del **acto** de firma (single-use/TTL/binding, P222) viven en los endpoints de firma, NO en el token de entrada. Tres principios:
> 1. **Resume → último paso verificado.** Recuperar una solicitud (magic-link por-guardian, o entrando sin link y recuperándola) lleva SIEMPRE al último paso en el que la familia estaba — no a un re-arranque ni a un banner muerto. `resumeSession_` (`Code.js:1101`) ya resuelve editabilidad real desde el estado (override `submitted_at=null` cuando las enrollments están en `IN`, `:1219-1231`); se extiende para devolver además el estado real + el contexto de firma del guardian (P215).
> 2. **El Step 7 muestra el ESTADO REAL** ("Aprobada"/"En revisión"/etc., derivado de `sysStates_T` `ENR_ADMISSION_SCHOOL`), no el binario "enviada/no enviada" (P216). Coherente con §"Edit-lock post-submit" (editabilidad = estado, no flag).
> 3. **Avance state-driven hacia la firma.** Si el expediente está **Aprobado (AD)** y la **firma está lista para ESE guardian** (`signing_token` emitido en `sysSigningSessionSigners`, milestone `SIGNING_INITIATED` completo), el **botón de avanzar del Step 7 se desbloquea** (lo GOBIERNA el estado) y continúa al Step 8 — el wizard resuelve el `signing_token` del guardian y navega a la firma sin depender SOLO del email (P217).
>
> **REFINADO recuperación única (Diego 2026-06-06, posterior):** UNA sola entrada — el **servicio de recuperación de magic link, per-guardian**. El link de recuperación va al email de **un guardian concreto** → la **identidad de firma se deriva de QUÉ guardian recuperó** (server-side). El token de entrada resuelve `{guardian, grupo}` → editar (grupo, pre-AD) o firmar (per-guardian, post-AD) según estado. `/sign` = host interno alcanzado desde la recuperación, NO email-solo separado. Esto **supersede** el split de dos rutas de ENTRADA de CLI 45 y la framing previa "dos tokens bajo el capó, solo cambia el routing". 🟦 **Hallazgo + sub-decisión:** hoy el `resume_token` es **de GRUPO, no per-guardian** (`enrEnrollmentGroups.primary_email` único, `Code.js:828`; `sendMagicLink_`/`resumeSession_` group-scoped) → cambio concreto: pasar la recuperación a guardian-scoped; la mecánica (link per-guardian vs selección de firmante in-app) es sub-decisión abierta del build (P215), ambas preservando KAL-4 + P222.
>
> **Lo que se PRESERVA de CLI 45 (sin cambios):** la **firma es por-firmante y legalmente vinculante**; los **dos tokens siguen bajo el capó** (`resume_token` sesión-de-grupo + `signing_token` por-firmante); el `enrollment_group_id` y el signer se derivan SIEMPRE **server-side del token, NUNCA del payload** (KAL-4 IDOR). La recuperación resuelve el contexto de firma del guardian server-side a partir del token de entrada, no de un email ni de un campo del cliente. Las protecciones del **acto** de firma (single-use/TTL/binding, P222) viven en los endpoints de firma, NO en el token de entrada. Cambia la **UX/entrada**, NO la identidad per-firmante.
>
> Items de build: **P215** (recuperación backend devuelve estado real + disponibilidad de firma + contexto del guardian que recupera, per-guardian) · **P216** (frontend: una entrada → último paso verificado + estado real + avance state-driven) · **P217** (puente recuperación → firma, `/sign` host interno). Prerequisito **P211** (sin el fix del `signing_token` PackedUUID dashless la firma NI resuelve). Cross-ref DL-E37 («Acciones disponibles» locus de estado) + P200/P201 (emisión del `signing_token`) + P222 (protecciones del acto de firma).

El roadmap §3 ola 4 ya describía el flujo; esta sección lo refleja (M5 readiness-2026-06-03; `Code.js:272`):

- **Steps 1-7 (pre-AD) → ruta `/apply`** (continuación con `resume_token`, familia anónima): Email, Persons, Relations, Health, Questions, Documents, Review. Ya implementados.
- **Steps 8-11 (firma, post-AD) → host `/sign?signing_token=…`** (`SigningWizardPage`, guardian firmante, autenticado con `signing_token` por-firmante, no `resume_token`). De cara al usuario es la **continuación del mismo flujo** (DL-E38), no una ruta inconexa; la ruta `/sign` es solo el **host técnico** de los Steps 8-11, no una experiencia separada — el avance hacia ella lo gobierna el estado, puenteado desde el Step 7 (P217):
  - 8 S-BILLING: datos fiscales pagador (endpoint `enr.saveBillingInfo`). *(Nota: P49/`enrGroupBilling` CANCELADO 2026-06-03 — billing canónico via `finBillingParties`, refactor del handler en CLI 84.)*
  - 9 S-GDPR: 7 consentimientos GDPR por guardian + TSA (DL-E27, endpoint `enr.submitGdprConsents`).
  - 10 S-REVIEW: revisión Carta + Contrato + confirmación lectura (DL-E28 §6, endpoint `enr.confirmReview`).
  - 11 S-SIGN: firma Click & Sign (DL-E28 §7-§13, endpoint `enr.initiateSigningSession`).

Los nombres y propósito vienen de `docs/kms/plan/wizard-admissions-roadmap.md` líneas 17-27 + DL-E24 §3 + DL-E27 + DL-E28.

**Dónde vive el código funcional de firma (CLI 45):** los Steps 8-11 funcionales se renderizan desde `frontend/src/pages/signing/SigningSteps.jsx` (host `/sign`). Los componentes homónimos bajo `/apply` (`frontend/src/pages/steps/Step8Billing.jsx`, etc.) son **placeholders** — NO contienen el trabajo funcional; no confundirlos al buscar la lógica de firma. *(Nota DL-E38: bajo el flujo continuo, el avance del Step 7 puentea al host `/sign`+`SigningSteps.jsx` cuando el estado lo gobierna (P217). El **merge total** de los Steps 8-11 dentro de `/apply` es una alternativa MAYOR que DL-E38 NO exige — el build elige entre "puente al `/sign` existente" (mínimo) o "merge de rutas" (mayor), cualquiera mientras preserve los dos tokens + la identidad por-firmante. Por eso los placeholders de `/apply` ya no se describen como "permanentes": su destino depende de la opción de build elegida.)*

Los Steps 8-11 se desbloquean post-AD: la sesión de firma se inicia (automática al entrar en AD, DL-E37 + P200/P201), emite el `signing_token` por-firmante, y el avance se gobierna por estado (DL-E38: expediente Aprobado + firma lista para el guardian → botón del Step 7 desbloqueado → puente a la firma; P216/P217). Hasta entonces el Step 7 muestra el estado real del expediente (P216) y el avance permanece bloqueado.

**Anti-patrones a NO repetir**:
- NO inventar pasos como "Status", "Interview", "Decision", "Deposit", "Sign contract", "Enrolled". Si una sesión cloud cree que un step debería existir, primero verificar en el roadmap canónico.
- NO crear ruta `/track/:token` separada — el seguimiento de solicitud NO tiene ruta propia. **(Excepción legítima: la firma usa el host `/sign?signing_token` — Steps 8-11 post-AD, CLI 45. Es el ÚNICO host de ruta distinto canónico del wizard; no confundirlo con rutas inventadas tipo `/track`. Nota DL-E38: `/sign` es el host TÉCNICO de los Steps 8-11, no un flujo separado de cara al usuario — la experiencia es UN wizard continuo 1→11; el avance hacia `/sign` lo gobierna el estado, puenteado desde el Step 7.)**
- NO añadir endpoints frontend-only sin confirmar que están registrados en backend `doPost` dispatcher.

Precedente: CLI 22 + CLI 28 + CLI 33-36 + Frontend-9-10 + Frontend-12 (2026-05-29/30) introdujeron steps inventados; CLI 59 corrigió 2026-05-30.

**Endpoints backend borrados 2026-05-30 (CLI 60)**: getInterviewForEnrollment, getAdmissionDecisionForEnrollment, getReservationPaymentInfo, getSigningTokenFromResumeToken, getTrackingData — sus consumidores frontend (Step9Interview, Step10Decision, Step12Deposit, TrackApplicationPage, Step8Status) fueron borrados por CLI 59 al corregir el wizard a 11 steps canónicos. Cuando se implementen los endpoints reales canónicos (enr.saveBillingInfo P49, enr.submitGdprConsents DL-E27, enr.confirmReview DL-E28 §6, enr.initiateSigningSession DL-E28 §7-§13), se añadirán como nuevos cases en el dispatcher.

## Deployment

The wizard is served from a **fixed deployment URL**. `clasp push` only updates Head — users hit the deployment URL, which is frozen until redeployed.

```bash
# From backend/
clasp push --force
clasp deploy \
  --deploymentId AKfycbyzyAR6J3_2UAiE6tCyNHVawoGfMNNbZEaurp99cRI76IYbiqGVEeQQcTxsgAqUFnGk0w \
  -d "<short description of the change>"
```

**Never create a new deployment** — always update the existing one above. A new deployment yields a new URL and breaks `admissions.kaleide.org`.

### Auto-deploy via GitHub Actions (CI backend-deploy job)

`.github/workflows/deploy.yml` includes a `backend-deploy` job that runs `clasp push --force` + `clasp deploy --deploymentId` on every push to `main`. It requires a GitHub secret:

- **`CLASP_TOKEN`**: JSON content of `~/.clasprc.json` from Diego's local machine (contains OAuth refresh token). Add via: GitHub repo → Settings → Secrets → Actions → New secret → name `CLASP_TOKEN` → paste the full contents of `~/.clasprc.json`.

Without this secret the job fails silently — the frontend-deploy (Pages) is unaffected.

### Smoke test technique — dos pasos (2026-05-29)

GAS web apps devuelven una respuesta en **dos pasos**: la primera request al `/exec` recibe un HTTP 302 con `Location: https://script.googleusercontent.com/macros/echo?user_content_key=...`. El JSON real está en ese segundo URL. `curl -L` NO funciona correctamente porque convierte el POST a GET en el redirect y el endpoint echo devuelve una página de error de Google Drive en holandés. La técnica correcta para smoke tests desde CLI:

```bash
# Paso 1: POST sin seguir redirects, captura la Location header
LOCATION=$(curl -s -D - -o /dev/null -X POST "$GAS_URL" \
  -H "Content-Type: text/plain" \
  -d '{"action":"...","_hp":"","key":"value"}' \
  --max-time 60 | grep -i '^location:' | tr -d '\r' | awk '{print $2}')

# Paso 2: GET al echo URL
curl -s "$LOCATION" --max-time 30
```

Verificado: el deploy @92 (CLI 17) responde correctamente con este patrón. `admissions.kaleide.org` funciona OK desde browsers (manejan el redirect nativo).

**Shape canónica del body** (verificado en `doPost` líneas 258 + 265): el body ENTERO es el payload — `const payload = JSON.parse(e.postData.contents); const action = payload.action;`. NO hay anidación bajo `"payload"`. Params a nivel top:
```json
{"action":"recognizeFamily","primary_email":"x@y.com","recaptcha_token":"..."}
```
NO esto (error común):
```json
{"action":"recognizeFamily","payload":{"email":"..."}}
```
Smoke tests que asumen anidación reciben "Missing X required" porque el dispatcher no encuentra el campo a nivel top.

**Endpoints con verja reCAPTCHA** (no smoke-testeables desde curl sin token reCAPTCHA válido): `recognizeFamily_`, posiblemente otros. La defensa por capas detrás (KAL-5 assertValidEmail_/appsheetEscape_) se verifica vía `manual_testAppSheetEscape_` desde GAS editor, NO vía curl.

Windows Schannel: añade `--ssl-no-revoke` a curl si la red corporativa bloquea OCSP/CRL (no afecta a la seguridad — el cert simplemente no se puede comprobar si está revocado, no que esté revocado).

## Email sending

Transactional emails (application received, etc.) use `GmailApp.sendEmail` with `from: ADMISSIONS_EMAIL` so they appear from `admissions@kaleide.org` instead of the deploying account. This requires `admissions@kaleide.org` to be configured as a **"Send mail as" alias** in the deploying Gmail account (Settings → Accounts → Send mail as). Without the alias, Gmail silently falls back to the deploying account address.

## Autonomy — main branch

Diego has authorized Claude Code to proceed without prior confirmation for any git and clasp operation on `main`, mirroring the kis-app autonomy directive:

- `git add`, `git commit`, `git push` on `main`
- `clasp push --force` (from `backend/`)
- `clasp deploy --deploymentId AKfycbyzyAR6J3_2UAiE6tCyNHVawoGfMNNbZEaurp99cRI76IYbiqGVEeQQcTxsgAqUFnGk0w -d "..."`

Still requires confirmation:
- `clasp create` (new GAS project)
- Creating a new deployment (would change the URL)
