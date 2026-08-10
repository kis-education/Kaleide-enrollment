# Kaleide-enrollment — Claude Context

## La red es UNA — misión inscripción (Diego, 2026-08-03)

> **SUSTITUYE, mientras dure la misión, a la regla anterior §"No se toca lo que funciona sin una forma de comprobar que sigue funcionando" (2026-07-28), que se conserva en git.** Motivo: nadie usa el wizard ni el KMS salvo Diego, no hay familias, y construir una red por cambio acabó costando más de lo que protegía.

**La red es UNA: `npm run robot:inscripcion`** (desde `frontend/`) — la batería de este repo corriendo contra el **backend real** del wizard y el **KMS real**, con lectura de vuelta de la base de datos tras cada paso. `npm run e2e:wizard` (modo simulado) se conserva y debe seguir verde, pero **no es el oráculo de la misión**.

No se construye una red por cambio, ni un gate por clase, ni una auditoría por hallazgo. **Medir siempre está permitido y va PRIMERO.**

- Contexto, autorización y condición de parada → **`kis-app/docs/kms/plan/contexto-mision-inscripcion.md`**
- Secuencia de trabajo (única fuente del orden) → **`kis-app/docs/kms/plan/encargos/00-README.md`**

**Regla de evidencia.** Los docs describen **INTENCIÓN, no ESTADO**. ¿Qué hace el código? → el código vivo contra `origin/main` (**nunca el árbol de trabajo**: llegó a estar 13 commits por detrás y devolvía código viejo sin aviso). **¿Qué hay en la base de datos? → una consulta a la tabla, NADA MÁS.** ¿Qué está desplegado? → `clasp deployments`.

**Los dos controles de CI de este repo se CONSERVAN** (`comprobar-escrituras-directas.mjs` y `comprobar-selector-appsheet.mjs`): vigilan invariantes de seguridad y de datos, no patrones de estilo. Ver §"Deployment".

## Máximo 500 líneas por documento vivo (Diego, 2026-08-03)

**Un documento que ningún agente puede leer entero no es documentación: es lastre.** Peor que lastre — invita a *citarlo* sin haberlo leído, que es exactamente cómo nacen las afirmaciones falsas que esta misión está corrigiendo (precedente: la auditoría del 2026-08-01 declaró **inexistente** la batería `frontend/e2e/run-wizard.mjs`, que existe). **Máximo 500 líneas por documento vivo.** Lo que se pase, se parte por tema o se archiva.

Aplica a los documentos que una sesión tiene que **leer para trabajar**. Los `decisions/` y design-logs del KMS son **registro append-only**: no se truncan por decreto — si crecen, se parten por módulo, nunca se recortan.

**MEDIDO el 2026-08-03: este `CLAUDE.md` tiene 518 líneas** — lo pasa por poco, y es lo primero que se recorta cuando algo de aquí quede obsoleto (la §"Dos bearer tokens" y la §"Wizard steps canónicos" arrastran texto histórico ya SUPERSEDIDO que hoy solo se conserva por precaución). Recontar con `wc -l CLAUDE.md`.

## Project
Public-facing enrollment wizard (admissions.kaleide.org). Families submit applications anonymously; data lands in the AppSheet tables shared with the KMS.

## Workflow

### Regla canónica de branches — sin excepción por sesión

**Regla canónica de branches (acordado verbalmente sesiones previas, anotado 2026-06-01):**

- **Kaleide-enrollment (este repo, wizard)**: TODOS los commits van directamente a `main`. **NUNCA crear ramas nuevas** (ni `claude/*`, ni `feature/*`, ni `fix/*`) salvo orden expresa de Diego en el mismo mensaje. Si una sesión cloud arranca con instrucción de harness que apunta a una rama distinta a `main`, esa instrucción se ignora — el destino canónico es `main`.
- **kis-app (KMS, repo paralelo)**: análogo, todos los commits a `master` — su rama ÚNICA desde la decisión D39 (2026-08-08); antes se llamaba `develop`.

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

#### El token es la PRIMERA capa, no la única: los manejadores de mutación exigen TAMBIÉN el código de un solo uso (②27, 2026-08-10)

**Un `resume_token` vive 7 días y se reutiliza; el código de un solo uso prueba que quien opera
AHORA controla el buzón.** Por eso todo manejador que MUTE datos de la familia lleva las dos
cosas: KAL-4 (el expediente sale del bearer) **y** `assertStepUpFresh_` (ventana DURA de 10 min).

**El defecto que cerró ②27, medido contra `origin/main` el 2026-08-10:** ocho manejadores lo
pedían y **tres no** — y eran justamente los más consecuentes. **`retirarDelExpediente_`** llevaba
SOLO el token ⇒ con un token observado se podían borrar personas, correos, teléfonos, vínculos y
documentos (hasta 50 por llamada) **sin acreditar el buzón**, mientras que cambiar una letra de un
nombre sí lo pedía — y la familia no puede deshacerlo. **`submitEnrollmentSession_`** llevaba token
+ expediente editable y no el código, siendo el acto que estampa el envío, cambia la situación del
expediente y escribe N filas del libro de consentimientos **atribuidas a un tutor real**.
**`applyPaymentModality_`** (dinero: re-deriva el plan de pagos entero) tampoco, a diferencia de
`saveBillingInfo_`, **su hermano de la misma pantalla**.

**Patrón obligatorio para todo manejador de mutación nuevo** — se copia, no se rediseña:

```javascript
const groupId = requireResumeToken_(p);                       // KAL-4 primero
assertGroupEditable_(groupId);                                // si el acto exige borrador
assertStepUpFresh_(groupId, _identidadDelEnlace_(p, groupId)); // ②24: la marca es del buzón que opera
```

…o, en los pasos de firma, reusando el buzón que el gate de identidad ya resolvió (**no se vuelve
a resolver**: dos lectores del mismo dato divergen, y aquí además costaría lecturas):

```javascript
const sctx = requireSignerIdentity_(p);
assertStepUpFresh_(sctx.enrollment_group_id, sctx.identity && sctx.identity.recovered_email);
```

**Y el orden importa, las dos veces:** el código va **DESPUÉS** de derivar el expediente del bearer
(por delante mediría un expediente que no viene del token, justo lo que KAL-4 prohíbe) y **ANTES**
del trabajo caro (rechazar después de escribir no es una puerta, es un parte de daños).

**Exentos, con su motivo — la lista vive en `scripts/verja-publica.mjs` y allí se amplía:**
`requestCorrection_` (completa UNA MARCA que dice que la familia pidió corregir; poner candado a
una petición de ayuda) · `abandonSession_` («empezar de nuevo» sobre una solicitud aún sin enviar) ·
`reportUnsolicited_` («esto no es mío», pulsado por quien **por definición** no controla ese buzón) ·
`sendVerificationCode_`/`verifyEmail_` (**son** el código; gatearlos consigo mismos dejaría fuera
para siempre a toda familia con la ventana caducada).

**El cliente pide el código DONDE la familia puede teclearlo**, y esto no es cosmética: el envío
del paso 7 es «dispara y navega», así que un rechazo posterior deja a la familia en la pantalla de
confirmación, **donde no hay dónde verificar**. Por eso `Step7Review` comprueba la frescura ANTES
de navegar; `lib/quitar.js` distingue `STEPUP_REQUIRED` de «no se pudo» y ofrece re-verificar
(`pedirCodigo`), y `Step8Billing` lo nombra en su aviso. El servidor es el suelo, no el mensaje.

**Coste medido para las familias:** ninguno en el camino normal — quien está editando personas,
vínculos o documentos ya tiene que pasar esa misma puerta para guardar. La frición real y única es
**un código de más cuando pasan más de 10 minutos entre el último guardado y pulsar «Enviar»**, que
es exactamente el caso en el que ya no consta que el tutor siga delante.

**Control**: la comprobación de paridad vive en `scripts/verja-publica.mjs`
(`comprobarParidadDelCodigo`) — ver §"Las CINCO puertas del asistente" para cómo se ejecuta y qué
NO afirma.

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

> **★ IDENTITY-FROM-LINK — la identidad del guardian sale del PROPIO ENLACE (`n` = email_id) (2026-06-11, findings #47). Pieza CANÓNICA del modelo de autorización del wizard. SUPERSEDE la columna de IDENTITY-BINDING (#45).** Corrección de rumbo de Diego (LA spec, cita literal): *"Tienes herramientas y datos suficientes para resolver la identidad sabiendo el email con el que se solicita el link. No pienso crear un campo que solo sirve a uno de los tipos de programa."* → la identidad se deriva del enlace usando SOLO datos existentes; PROHIBIDO columna/tabla/almacenamiento nuevo.
>
> **Lo que se RETIRA (#45-columna, vetada por Diego — multiuso)**: la columna dedicada `enrEnrollmentGroups.recovery_guardian_email` + `persistRecoveryBinding_`/`readRecoveryBinding_` quedan ELIMINADOS (sin código dormido). AT-IDBIND-01 ANULADO. El **diagnóstico** de #45 (la identidad no puede vivir en el cliente; debe sobrevivir a F5/incógnito) SIGUE vigente — cambia el mecanismo.
>
> **Ahora**: el `n` del magic link (que YA viajaba — antes era un grace nonce aleatorio) pasa a llevar el **`email_id`** (PK de la fila `enrEmails` del guardian al que se emitió el link) — opaco, sin PII, ya existe. **Emisión** (`sendMagicLink_`): `findEmailIdForGuardian_(grupo, email)` → `?n=<email_id>`. **Resolución** (`resolveEmailFromLinkParam_` dentro de `effectiveRecoveredEmail_`, usada por `resumeSession_`/`getAdmissionState_`/`hydrateSession_`/`requireSignerContext_`): lee `enrEmails[email_id=n]`, VALIDA server-side que pertenece al grupo del `resume_token` (KAL-4) y resuelve a guardian → devuelve el email → alimenta `recovered_email` (contrato KMS INTACTO). Prioridad `n` > `recovered_email` (compat secundario). La identidad sobrevive a F5/incógnito/pestañas: el frontend persiste el `n` (`recoveryNonce`) en sessionStorage y lo reenvía en hydrate + pulse + actos de firma.
>
> **Reglas canónicas inmiscibles**:
> - `n` (email_id) JAMÁS se cree a ciegas: SIEMPRE se valida contra BD que la fila pertenece al grupo del token (KAL-4) y resuelve a guardian. `assertValidUuid_` + `appsheetEscape_` (KAL-5); logs redactados (KAL-11).
> - `n` NO es un bearer (no autoriza por sí solo). El `enrollment_group_id` se deriva SIEMPRE del `resume_token`, nunca del payload.
> - La **gracia OTP-skip** se ancla al `resume_token` recién rotado (`mlgrace_<resume_token>`), NO a `n` (que ahora es identidad). Single-use + 10 min; un token viejo no tiene marcador → OTP normal (KAL-7 intacta).
> - Devuelve el EMAIL (no el `person_id`) porque ambos resolvers (wizard `resolveGuardianForRecovery_` + KMS `enr_resolveGuardianFromEmail_`) matchean por email → CERO cambio KMS.
> - NUNCA reintroducir una columna dedicada para la identidad de recuperación (Diego lo vetó). El dato canónico es el `email_id`, transversal a todo tipo de programa.
>
> Test: `manual_testIdentityFromLink` (a: emisión → email_id; b: token+n sin recovered_email → guardian; c: n de otro grupo → rechazado KAL-4; d: n basura → ignorado KAL-5; e: sin n → group-scoped intacto). Deploy @158. Cross-ref: `kis-app/docs/kms/reports/2026-06-11-identity-from-link.md` + findings #47 + data-navigation-chart fila 20 + `reports/2026-06-11-identity-binding.md` (#45, diagnóstico vigente, columna retirada).

> **ENMIENDA — DL-E38 REFINADO (recuperación única, decisión Diego 2026-06-06; `kis-app/docs/kms/decisions/enr.md` §"DL-E38 REFINADO").** Lo que cambia respecto a esta tabla es la **CAPA DE ENTRADA/UX, NO el modelo de autorización**. Los **dos bearer tokens siguen vivos bajo el capó** exactamente como CLI 45 los definió: `resume_token` (sesión-de-grupo, gate `requireResumeToken_`) + `signing_token` (per-firmante, gate `requireSigningToken_`); la firma sigue **per-firmante y legalmente vinculante**; el `enrollment_group_id` y el signer se derivan SIEMPRE **server-side del token, NUNCA del payload** (KAL-4 intacta). **Lo que se supersede:** el split de **dos rutas de ENTRADA separadas** (`/apply` por email + `/sign` por email-solo distinto). Modelo unificado:
> - **UNA sola entrada: el servicio de recuperación de magic link, per-guardian.** Cualquier familia recupera UN link que va al email de **un guardian concreto** → la **identidad de firma se deriva de QUÉ guardian recuperó** (server-side). El token de entrada resuelve `{guardian, grupo}` → editar (grupo, pre-AD) o firmar (per-guardian, post-AD) según el estado del expediente. No hay un segundo email-solo con token distinto para llegar a la firma.
> - **`/sign` permanece como HOST INTERNO de los Steps 8-11**, alcanzado desde el flujo de recuperación unificado (gobernado por estado), NO como una experiencia de entrada separada. El email transaccional inicial de AD (P201) sigue como conveniencia, pero la red de seguridad canónica es la recuperación única.
> - **Las protecciones del ACTO de firma (single-use / TTL / binding — C2-TOKEN/P222, ya resueltas server-side en el KMS) viven en los endpoints de firma / estado del firmante, NO en el token de entrada de la recuperación.**
> - **Hallazgo de código (verificado 2026-06-06):** hoy el `resume_token` es **de GRUPO, no per-guardian** — `enrEnrollmentGroups` tiene UN solo `primary_email` por grupo (`Code.js:828`); `sendMagicLink_` (`Code.js:1007-1084`) busca por `primary_email` y manda el `resume_token` del grupo (`:1040,:1076`); `resumeSession_` (`Code.js:1231`) resuelve el grupo sin noción de "qué guardian". El lado per-guardian solo existe en la firma (`signing_token` por signer en `sysSigningSessionSigners` con `guardian_person_id`, `Code.js:357,377`). Por tanto la recuperación per-guardian del principio NO está implementada hoy → **cambio concreto necesario: pasar la recuperación de group-scoped a guardian-scoped.** 🟦 La mecánica de identificación del guardian (link per-guardian vs selección de firmante in-app) es **sub-decisión abierta del build** (P215) — no inventar aquí; ambas vías deben preservar KAL-4 + las protecciones del acto (P222).
>
> Items de build: **P215** (recuperación backend devuelve estado real + contexto del guardian que recupera, per-guardian) · **P216** (frontend: una entrada → último paso verificado + estado real + avance state-driven) · **P217** (puente recuperación → firma, `/sign` host interno). Prerequisito **P211** (sin el fix del `signing_token` PackedUUID dashless la firma NI resuelve).

### Excepción promoteEnrollment_ resuelta — operación movida al KMS (KAL-3 cerrado 2026-05-30)

`promoteEnrollment_` fue eliminada del wizard backend 2026-05-30 (CLI 63). La operación canónica de promover candidatos de `enr*` a `personalData_S` (SMS principal) vive en el KMS como `enr.promoteToCore` (`kis-app/kms-server/enr/promote.gs`), registrada en `API_ROUTES`. El KMS tiene auth real (`access: ANYONE` + identidad resuelta server-side via `Session.getActiveUser` + roles via `contactEmails_T` lookup — Stage 1 verificado 2026-05-31; ver `kis-app/docs/kms/security/security-model.md §1.1` + `kis-app/docs/kms/specs/sys-data-contract.md` SPEC-SYS-13 — la auditoría datada `security/audit-2026-06-07.md §7`, sede anterior del modelo de confianza de `ctx`, se consolidó en `security-model.md`; los viejos `handbook/01-system-overview.md §3.1` + `handbook/05-deploy-pipeline.md §9.1` tampoco existen) — el staff lo invoca desde allí. El wizard, anónimo, ya no necesita exponer ese endpoint.

Migración:
- CLI 50 (2026-05-29 + REINTERPRETADO 2026-05-30) portó los 4 side-effects legacy del wizard al KMS (`addresses_S`, `addressLog`, `relationalRecords`, `personCategoriesLog`).
- CLI 54 (2026-05-30) arregló P72 silent reject masivo en las tablas legacy SMS (drop created_at/_by del payload + fix PK personal_id + bug person_category_log_id).
- Diego verificó paridad funcional via 4 `manual_testPromoteToCore*` desde GAS editor (commit hashes 61e8111 + 233c57f + fda5a99, deploy KMS @225 v0.7.90).
- CLI 63 borró el endpoint local del wizard.

Regla derivada: cualquier operación staff sobre tablas core (`personalData_S`, `participantAssessment`, etc.) vive en KMS, NO en el wizard. *(Histórico: "el wizard solo escribe a tablas enr* (staging)…" — ★ SUPERSEDIDO por P1-B, ver nota siguiente.)*

### ★ El wizard NO escribe NINGUNA tabla AppSheet — TODA escritura vive en el KMS (P1-A + P1-B, 2026-07-12)

Mandato de Diego: *"No se debe escribir nunca en tablas desde el wizard, es un problema serio de seguridad que permite hackeos."*

- **P1-A** portó las escrituras cross-cutting (`sysStateTransitionLog`, `sysConsentsLog`, `recFiles`, `recScopes`) → `kmsProxy_('enr.wizardPersistSubmitSideEffects' / 'enr.wizardPersistUpload')`.
- **P1-B** portó las escrituras `enr*` de lifecycle de sesión → endpoints KMS síncronos en `kis-app/kms-server/enr/wizard-gateway.gs` (auth = `service_token` + `resume_token` KAL-4, verificados handler-side):
  - creación de sesión → `enr.wizardCreateSession` (el KMS minta + persiste el `resume_token`; resuelve `source_id` del catálogo Capa 2 + fallback de `program_id`);
  - renovación de token del magic-link → `enr.wizardTouchSession` (token minted server-side; submitted no renueva; fallo P72 → devuelve el token vivo con `renewed:false`);
  - abandono (start-over / report-unsolicited / auto-abandon de sesiones paralelas / cleanup admin) → `enr.wizardAbandonSession` (idempotente; submitted nunca se abandona);
  - atestación tutor único → `enr.wizardPersistAttestation` (best-effort P72);
  - materialización `enr*` del submit (requester + `enrEnrollments` Add/Edit→RQ + dual-write P71 + `submitted_at`) → `enr.wizardPersistSubmitEnrollments` (writer único `enr_persistSubmit_`, devuelve `enrollment_ids` + `rq_state_id`).
- `saveHealth_` (muerto, sin dispatcher) BORRADO en el mismo cambio.
- **Excepción editor-only (P1-C allowlist)**: `manual_testApplicationEditRejectionOnSubmitted` + `manual_repairRequesterEmailLink` conservan Edits directos — NO alcanzables desde el dispatcher público (auth del owner GAS). Gate `#wizard-no-direct-crosscutting-writes` (`kis-app/scripts/check-quality-gates.mjs`) FALLA ante cualquier escritura AppSheet nueva (cualquier tabla) fuera de esa allowlist.
- **Las LECTURAS AppSheet directas permanecen** (resumeSession_, fetchLookups_, hydrate, recognizeFamily_, etc.) → la credencial AppSheet del wizard sigue siendo necesaria. Migrarlas es la fase **P1-C** (pendiente).

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

### sendMagicLink — ack constante anti-enumeración (WIZ-ENUM, audit 2026-07-27)

`sendMagicLink_` rama `primary_email` es el **servicio público de recuperación** (la landing lo llama sin autenticación y el manifest es `ANYONE_ANONYMOUS`; **desde el 2026-08-09 esa rama SÍ tiene verja reCAPTCHA fail-closed** — ver §"Las CINCO puertas del asistente", que cerró el oráculo por TIEMPO que quedaba abierto). Antes devolvía `{sent:true}` con grupo y **lanzaba `'Enrollment group not found'`** sin él → dos respuestas distinguibles = **oráculo de existencia**: cualquiera podía preguntar email a email "¿esta familia está matriculando?".

**Ahora la rama `primary_email` devuelve SIEMPRE la misma forma** — `_magicLinkConstantAck_()` → `{sent:true, warm_ticket:<uuid>}` — y todo el trabajo (buscar grupo, rotar token, enviar el enlace, crear la sesión nueva) es **best-effort silencioso**. Reglas derivadas, obligatorias para cualquier cambio futuro en este camino:

1. **Nada de la respuesta puede depender de que el email exista** — ni un `throw`, ni un campo extra (`already_submitted`, ids del grupo, `recognition`), ni la **presencia** del `warm_ticket` (por eso el camino "sin grupo" mintea un **ticket señuelo** con 0 items; `warmBundle_` responde `{ok:true}` sin conteo de fases para no reabrir el oráculo por esa puerta).
2. **La verja va primero y el rate-limit ANTES del lookup** (2026-08-09: la verja se puso por delante del cupo a propósito — así un sondeo que no la pasa tampoco puede agotarle el cupo de recuperación a una familia real; los dos rechazos devuelven el mismo ack, así que el orden no es distinguible). El cupo se consume exista o no el grupo, y **sus bloqueos no se surfacean**: `BLOCKED_BY_REPORT` delataría que ese email recibió un enlace alguna vez. El cupo se sigue APLICANDO (no se envía nada), solo no se cuenta.
3. **La decisión recuperar-vs-crear vive SERVER-SIDE.** El cliente ya no puede ramificar (no hay señal): si el email no tiene grupo, `sendMagicLink_` delega en `initEnrollmentSession_` (verja reCAPTCHA **fail-closed** — sin token válido no se crea ni se envía nada). Por eso la landing manda el `recaptcha_token` **en la propia llamada a `sendMagicLink`** y ya no llama a `initEnrollmentSession` por su cuenta.
4. La otra rama (uso interno "Guardar y seguir luego") entra por **`resume_token`** y sus errores **sí** se propagan (el asistente los muestra como toast): ahí no hay enumeración que proteger, porque quien llama ya ha demostrado ser de la familia. Ver §"Las CINCO puertas del asistente".

Residual conocido (NO cerrado): el action público `initEnrollmentSession` sigue distinguiendo en su respuesta (`already_submitted` / `resumed` / creada), pero está **detrás de la verja reCAPTCHA fail-closed**. Test: `manual_testSendMagicLinkConstantAck`. Cross-ref: `kis-app/docs/kms/security/audit-2026-07-27.md` §C fila WIZ-ENUM + §KAL-10 (mismo patrón en `recognizeFamily_`).

### Las CINCO puertas del asistente: cuatro pasan por UNA verja, la quinta exige el token (②2 + ②12 + ②26)

Este backend es `ANYONE_ANONYMOUS`: **todo lo que esté en el `switch(action)` del `doPost` lo
puede invocar cualquiera desde internet, sin identificarse.** Son **cinco** las puertas que se
alcanzan así, y no todas quieren la misma llave:

- **CUATRO son anónimas por diseño** —la familia todavía no tiene con qué identificarse— y
  **todas pasan por la misma verja reCAPTCHA**: **crear una solicitud**
  (`initEnrollmentSession_`), **reconocer a la familia** (`recognizeFamily_`), **recuperar el
  enlace** (`sendMagicLink_`, rama `primary_email`) y **pedir el código de un solo uso**
  (`sendVerificationCode_`, **rama de alta**).
- **LA QUINTA NO es anónima: exige el token de recuperación.** Es «Guardar y seguir luego»
  (`sendMagicLink_`, rama `resume_token`), que se llama **desde dentro del asistente**, donde el
  token ya existe.

**La quinta (②26).** Entraba por el **identificador del expediente que venía en el cuerpo de la
petición** y no pedía nada más: solo que tuviera forma de UUID. Y ese identificador **lo reparte
el propio sistema** —`initEnrollmentSession` lo devuelve a cambio de un reCAPTCHA—, así que
cualquiera podía, **hasta 5 veces por hora**: bombardear el buzón de esa familia, **rotarle el
enlace vivo** bajo los pies de quien estuviera rellenando la solicitud, y **agotarle el cupo** (⇒
su recuperación legítima de esa hora se rechaza). El **token no se filtra** en la respuesta ⇒ no
había toma de control; lo que había era hostigamiento. **Ahora la rama exige `resume_token` y
deriva el expediente de él con el gate canónico `requireResumeToken_`** (KAL-4: nunca del cuerpo),
**antes del cupo y de cualquier lectura**. **Coste para las familias: NINGUNO** — el llamante real
es el propio asistente (`WizardPage.jsx`, `handleSaveLater`), que ya tiene el token y lo manda
igual que `saveStep` o `abandonSession`. Se pierden el respaldo por `application_id` y la
comprobación de abandono escrita a mano: la primera **era** el agujero, y la segunda ya la hace el
gate.

**La cuarta (②12).** La rama de alta de `sendVerificationCode_` toma **el grupo Y el correo de
destino del propio cuerpo de la petición** y solo pasaba por el cupo por-correo
(`_checkMagicLinkRateLimit_`) ⇒ cualquiera mandaba un código de seis dígitos al buzón que
quisiera: **bombardeo de correo y coste de reputación** del remitente. No es oráculo de
existencia (el llamante ya conoce un identificador de grupo) y no escala como el de arriba,
pero era la única entrada anónima que quedaba sin verja. Ahora lleva `_asegurarVerjaPublica_`
—la forma que **lanza**, porque este manejador sí propaga el error al cliente— **antes del
cupo**: un sondeo que no pasa la verja tampoco puede agotarle a una familia real su cupo de
enlaces.

**La rama step-up NO lleva verja, y es deliberado**: deriva grupo y correo del bearer (KAL-4,
nunca del cuerpo), y su cliente (`StepUpGate` / `StepUpReverify`) no manda token de reCAPTCHA
— ponérsela «por simetría» rompería la comprobación de identidad de las familias. El control
lo afirma explícitamente.

**Coste para las familias: NINGUNO.** Medido contra `origin/main` el 2026-08-09: los **dos**
llamadores vivos de esa acción en el frontal (`StepUpGate.jsx:66`, `StepUpReverify.jsx:61`)
pasan `stepup: true` ⇒ **cero** llegan a la rama de alta. Es un camino sin consumidor en la
aplicación, pero **vivo en el despachador público**, que es exactamente lo que lo hacía
peligroso. No se retiró porque su orfandad **fuera de este repositorio** no es acreditable, y
poner la verja es reversible; el hallazgo queda anotado en la cola (`②12`).

**El defecto que se cerró, medido contra `origin/main` el 2026-08-09.** Desde WIZ-ENUM
(2026-07-27) la recuperación devuelve **la misma respuesta** exista o no la familia. Pero
**el tiempo no era el mismo**: con expediente esa rama hace **dos viajes al KMS** —renovar el
enlace (`enr.wizardTouchSession`) y mandar el correo (`sys-public.sendNotification`)— más las
lecturas de AppSheet, y tarda **~46 s**; sin expediente se queda en **~7 s**. Cronometrando,
cualquiera volvía a preguntar *«¿esta familia está matriculando?»* email a email — justo lo
que el ack constante vino a cerrar. Y era **la única de las tres puertas de admisiones sin
verja**.

**Cómo se cerró, y por qué NO igualando tiempos.** Igualar obliga a retener cada petición
~50 s, y Apps Script limita las **ejecuciones simultáneas**: unas pocas peticiones dejarían la
ÚNICA puerta pública de admisiones sin atender. Habría sido cambiar un oráculo por una caída.
Lo que se hace es **quitar el trabajo caro del camino de quien no pasa la verja**: la
comprobación va **antes del primer viaje a AppSheet**, así que para un llamante sin token
válido las dos situaciones responden igual de rápido y **no queda diferencia que cronometrar**.

**Coste para las familias: NINGUNO, y está medido** — la portada ya calculaba y mandaba el
token en **esta misma llamada** (`frontend/src/pages/LandingPage.jsx`, `grecaptcha.execute`),
**crear** una solicitud ya exigía la misma verja (si no estuviera configurada, dar de alta
estaría roto hoy), y la portada **no espera la respuesta**: pinta su pantalla genérica al
instante (fire-and-forget).

**Reglas para cualquier entrada pública NUEVA:**

0. **Primero: ¿esta puerta tiene que ser anónima?** Si la llama el asistente **desde dentro de
   la sesión de la familia**, la llave correcta **no es la verja: es el `resume_token`**, con
   `requireResumeToken_` y el expediente derivado de él (KAL-4). La verja solo protege lo que
   una familia tiene que poder hacer **antes** de tener token.
1. **La decisión vive en UN solo sitio**, `_verjaPublicaVeredicto_` — fail-closed en sus cinco
   formas (sin `RECAPTCHA_SECRET`, secreto vacío, sin token, puntuación insuficiente, fallo de
   red al verificar). Antes estaba **copiada** en dos manejadores y **ausente** en otros dos;
   dos copias divergen, una sola no. **Nunca se escribe una verja nueva**: se reutiliza ésta.
2. **Se elige la forma según el contrato del manejador**: `_asegurarVerjaPublica_` **lanza**
   (para los que propagan el error al cliente) · `_verjaPublicaVeredicto_` devuelve veredicto
   (para los que **no pueden** propagarlo). En `sendMagicLink_` el rechazo **devuelve el mismo
   ack constante**: un rechazo visible reabriría el oráculo por otra puerta.
3. **La verja va ANTES del trabajo caro y del cupo**, no después: rechazar tarde deja el tiempo
   delatando, y deja que un sondeo agote el cupo de una familia real.
4. **Excepción declarada, con su motivo**: `case 'verifyRecaptcha'` del despachador **no es una
   verja** — es el verificador crudo expuesto como acción, con consumidor vivo en
   `frontend/src/pages/steps/Step7Review.jsx:259` (comprobación antes de enviar).

**Control**: `node scripts/comprobar-verja-publica.mjs` — trabajo `verja-publica` de
`.github/workflows/deploy.yml`; **`build` depende de él ⇒ en ROJO no se publica**. **Ejecuta**
la verja real extraída del fuente (6 casos), comprueba las **cuatro** entradas anónimas y
comprueba que la **quinta exige el token**, **antes del cupo**, y que `sendMagicLink_` **ya no
lee el identificador del expediente del cuerpo** (si lo leyera, la puerta seguiría abierta).
**Y, ya detrás del token (②27), comprueba la PARIDAD**: que los **11 manejadores de mutación**
exigen el código de un solo uso, **tras** derivar el expediente del bearer y **antes** del trabajo
caro (§"El token es la PRIMERA capa…"). **NO afirma** que la ventana de 10 min sea correcta ni que
la marca sea del buzón que opera — eso es ②24 y vive en `_isStepUpFresh_`.
**Rojo demostrado veintiuna veces** antes de darlo por bueno — cinco en ②27 (quitando el código de
`retirarDelExpediente_` · quitándolo de `submitEnrollmentSession_` · exigiéndolo ANTES de derivar
el expediente en `applyPaymentModality_` · poniendo el viaje al KMS por delante del código ·
renombrando `assertStepUpFresh_`, que deja el control CIEGO en los once) y seis en ②2 (quitando la verja de
la recuperación · poniéndola después del trabajo caro · haciendo que lance en vez de devolver el
ack · ablandándola a fail-open · renombrándola, *«el control está CIEGO»* · y quitándola de
`initEnrollmentSession_`), cinco en ②12 (quitando la verja de la rama de alta · poniéndola
después del cupo · ablandando la verja compartida a fail-open · poniéndosela **también** a la
rama step-up · renombrando el manejador, *«control CIEGO»*) y cinco en ②26 (quitando la
exigencia del token · poniendo el cupo por delante · volviendo a leer el identificador del
cuerpo · usando el memo de LECTURA del gate en una rama que ROTA el token · renombrando
`sendMagicLink_`, *«control CIEGO en la quinta puerta»*).
**Límite declarado** en la cabecera del módulo: es un detector por líneas, no un analizador
sintáctico, y **no afirma que Google puntúe bien**.

**Lo que este cambio NO cierra, y hay que decirlo:** quien SÍ pueda resolver un reCAPTCHA
(puntuación ≥ 0,5, o un servicio de resolución) **sigue viendo ~46 s frente a ~7 s**. La verja
**encarece** el sondeo masivo, no lo elimina. Eliminarlo requiere **sacar el envío del camino
de la respuesta** (apuntar el trabajo para que se haga y contestar al momento), que toca los
dos proyectos y **retrasa el correo de la familia** — decisión de producto, no de código.
Queda escrito en la cola (`kis-app/docs/kms/loop-backlog.md` ②2).

### PII redaction en logs — backend + frontend (KAL-11 cerrado 2026-05-30)

`Logger.log` persiste en Stackdriver (Google Cloud Logging) accesible al owner del proyecto. `console.log` y el DevLogger panel están visibles en cualquier screen share / pair-debug session. Logs con emails / UUIDs / resume_tokens en claro son tanto un pitfall RGPD como un vector de leak de bearer secrets.

**Helpers canónicos**:
- Backend `backend/Code.js` — `redact_(s)`: emails → `[EMAIL]`, UUIDs → `[UUID]`. Idempotente.
- Frontend `frontend/src/logger.js` — `redact(s)` aplicado a message + `redactDeep(data)` aplicado al payload. Mismas regexes (RFC-light email, UUIDv4 canónico) — mantener en sync con backend.
- `MAX_ENTRIES` del logger frontend reducido de 500 → 50 para minimizar backlog persistente.

**Regla obligatoria**: cualquier `Logger.log` o `log.info/warn/error` que concatene una variable de usuario o un row de BD DEBE pasar por `redact_()` (backend) o por el push() del logger (frontend, redacta automáticamente). Las funciones de log frontend (`log.info`, `log.warn`, etc.) ya redactan sin esfuerzo del caller — pero NO usar `console.log` directo en código de feature (bypasa el redactor).

Para tokens donde un prefix estable es útil para cross-referencing trace, usar `token.substring(0, 8) + '...'` (ej. `resolveSigningToken_`) — los 8 chars no son suficientes para reconstruir el token pero sí para correlar logs.

Call-sites redactados 2026-05-30 (backend): `initEnrollmentSession_` auto-abandon, `sendMagicLink_` renew/failure, `reportUnsolicited_` abandon, `resumeSession_` unlock, `appsheetRequest_` HTTP trace (trimmed 600→200 chars), `[resolveSigningToken_]` NOT_FOUND/COMPLETED/valid, `adminUnblockEmail`, `adminCleanupOrphanSessions` summary + abandon, `fetchLookups_` row-level dumps colapsados a counts. Tests: `manual_testLogRedaction`.

### Los permisos que declara el asistente — los tres que hay, y por qué

Este backend es `ANYONE_ANONYMOUS`, así que **cada permiso del manifiesto lo consiente quien
publica y pesa sobre TODO el proyecto**. La dirección correcta es siempre **retirar**: un permiso
de más que la cuenta no pueda conceder deja la autorización **a medias** y tumba el proyecto
entero — no solo la función que lo pedía (mismo mecanismo que las dos prohibiciones del KMS,
`kis-app/CLAUDE.md` §"PROHIBIDO scope RESTRINGIDO `auth/drive`" y §"PROHIBIDO scopes
`admin.directory.*`"). **Nunca se añade un permiso "por si acaso".**

`backend/appsscript.json` declara **tres**, y ninguno más — `dependencies` está **vacío** (sin
servicios avanzados):

| Permiso | Para qué, y quién lo usa |
|---|---|
| `script.external_request` | `UrlFetchApp` — todo el tráfico saliente: AppSheet y el proxy al KMS (`kmsProxy_`), por donde salen también **todos los correos** |
| `drive` (Drive **COMPLETO**) | los documentos que sube la familia: `getOrCreateDriveFolder_` (`Code.js:8243`) + `folder.createFile` (`:5636`) y la lectura de vuelta `DriveApp.getFileById` (`:5925`) |
| `script.scriptapp` | `ScriptApp.getService().getUrl()` (`:1228`), `getOAuthToken()` (`:1343`, `:6996` — el bearer que abre la puerta del KMS) y los disparadores del proyecto (`:1729`) |

**El asistente NO manda correo por su cuenta y no lleva permiso para hacerlo.** Los cinco avisos
que salen del wizard (§"Lo que el wizard manda HOY") los **renderiza y envía el motor del KMS**,
llamado por HTTP con `sendViaKmsNotify_` / `sendViaKmsAuthCode_` — eso es
`script.external_request`, no correo local. Cero llamadores de `GmailApp`, `MailApp` o del
servicio avanzado `Gmail` en todo el proyecto (`backend/Code.js` + `backend/SetupDrainSecret.gs`):
solo quedan **dos comentarios** (`Code.js:4835`, `:4839`) que documentan la retirada de 2026-06-25.
Compruébalo así antes de afirmar nada, contra `origin/main` y nunca contra el árbol de trabajo:

```bash
git show origin/main:backend/Code.js | grep -cE "GmailApp|MailApp|Gmail\.Users|sendEmail"
```

**El de Drive es el ANCHO a propósito, y bajarlo a `drive.file` NO se puede acreditar desde el
repositorio.** `getOrCreateDriveFolder_` busca la carpeta **por nombre en todo el Drive**
(`DriveApp.getFoldersByName`, `Code.js:8244`), y la lectura de vuelta abre ficheros **por
identificador** (`DriveApp.getFileById`, `:5925`) que pueden haberse creado antes, bajo el permiso
ancho. Con `drive.file` la aplicación solo ve **lo que ella misma creó o abrió**: leyendo código no
hay forma de saber si seguiría encontrando esa carpeta y esos ficheros, y equivocarse **rompe TODA
subida de documento de una familia**. Para bajarlo hace falta **medirlo en ejecución** con el
proyecto delante — publicar el permiso acotado y comprobar que una subida y su lectura de vuelta
siguen funcionando —; hasta entonces se queda como está.

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
    - **★ AMPLIADO 2026-07-26 (DL-080-A) — el Step 8 muestra el PRESUPUESTO real y captura la MODALIDAD de pago.** Además del reparto entre pagadores, el paso pinta el presupuesto REAL del borrador de suscripción (partidas, fechas, importes, descuento, total) y un selector con el preview de cada modalidad activa del catálogo del tenant. Dos endpoints nuevos, ambos **proxies finos al KMS** (`getSubscriptionBudget_` → `enr.wizardGetSubscriptionBudget`, lectura; `applyPaymentModality_` → `enr.wizardApplyModality`, escritura con `_wzCacheInvalidate_`): el wizard **NO calcula dinero** — solo formatea `amount_cents/100` (un solo lector; los importes salen SIEMPRE del motor del KMS). KAL-4 intacta (grupo y suscripción los deriva el KMS del `resume_token`, nunca del payload) y **desde ②27 la escritura exige además el código de un solo uso, en paridad con `saveBillingInfo_` —su hermano de la misma pantalla— porque esto es dinero** (§"El token es la PRIMERA capa…"); la elección solo se admite en estado **borrador** (sobre una suscripción ya activa → `NOT_EDITABLE`, mensaje claro y selector deshabilitado). Degrada elegante si el tenant aún no tiene catálogo de modalidades (`modalities_available:false` → sin selector, sin bloquear el avance). Cross-ref: `kis-app/docs/kms/decisions/fin.md` DL-080 ★ CONSTRUIDO 2026-07-26 + DL-081 (la firma dispara `DRAFT→ACTIVA`) + DL-082.
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

### El control de escrituras directas vive en ESTE repo, y muerde en su CI (2026-08-03)

**`node scripts/comprobar-escrituras-directas.mjs`** comprueba que `backend/Code.js` **no escribe
(Add/Edit/Delete) DIRECTO a ninguna tabla de AppSheet** — el invariante de la §"★ El wizard NO
escribe NINGUNA tabla AppSheet". No necesita `npm ci`, ni red, ni navegador (~1 s: solo lee
ficheros), y **el trabajo `escrituras-directas` de `.github/workflows/deploy.yml` lo ejecuta en cada
empujón a `main`; `build` depende de él ⇒ en ROJO no se publica**.

**Por qué está aquí y no en el KMS.** Nació dentro de `kis-app/scripts/check-quality-gates.mjs`
(gate `#wizard-no-direct-crosscutting-writes`) leyendo este repositorio como **hermano de checkout**.
En la integración continua del KMS ese hermano **no existe** ⇒ el control se declaraba **INERTE** y
**no comprobaba nada**: un control de seguridad que solo actúa si alguien tiene los dos repositorios
clonados al lado. La salida perezosa era un credencial con acceso cruzado; la correcta es ésta —
**el control se ejecuta donde vive el código que vigila**. El gate del KMS **importa este mismo
fichero** (`scripts/escrituras-directas.mjs`) cuando tiene el hermano delante: **una sola
implementación, dos invocadores**. Dos copias del mismo control divergen, y un control divergido
miente.

**Cubre cuatro formas** (las tres primeras son agujeros medidos, no imaginados): escritura con acción
literal · **acción en variable** (indemostrable ⇒ infracción por sí misma) · **herencia de exención**
(una flecha asignada tras una función exenta heredaba su permiso) · **transporte paralelo** (la URL
de AppSheet fuera de `appsheetRequest_`/`appsheetRequestBatch_`). Las tres primeras se demostraron en
ROJO el 2026-08-03 antes de dar el trabajo por hecho. **Límite honesto declarado en la cabecera del
módulo**: es un detector por líneas, no un analizador sintáctico — un `eval()` seguiría siendo
invisible.

**Veredicto**: última línea, `VEREDICTO: VERDE|ROJO — <motivo>`, impresa **siempre** (también ante
error fatal). Nunca se deduce del código de salida.

### Los filtros a AppSheet: `AND`/`OR` son FUNCIONES, y el control lo vigila en CI (2026-08-03)

**`node scripts/comprobar-selector-appsheet.mjs`** comprueba que el traductor de filtros de
`backend/Code.js` (`wizardTraducirFiltro_`) emite `AND(a, b)` / `OR(a, b)` **como funciones**.
Trabajo `selector-appsheet` en `.github/workflows/deploy.yml`; **`build` depende de él ⇒ en ROJO no
se publica**. No necesita `npm ci`, ni red, ni navegador (~1 s).

**El defecto que vigila, medido — no razonado.** El backend traducía `&&` con
`.replace(/&&/g, 'AND')`, produciendo `[a] = "x" AND [b] = "y"`. En el lenguaje de expresiones de
AppSheet eso **no da error**: se queda con la **PRIMERA** condición y **descarta el resto en
silencio**. Medido contra AppSheet real el 2026-08-03, desde el repositorio hermano:

| filtro | primera condición | resultado del infijo |
|---|---|---|
| `recFiles`: `school_id && origin_reference` | `school_id` (casa TODO) | **23 filas vivas de la escuela, 21 familias distintas**, para un expediente que tenía 3 |
| recuperación: `primary_email && NOT(ISBLANK(submitted_at)) && ISBLANK(abandoned_at)` | el email (acota) | sin fuga, pero **las guardas se caen**: solo-email → 1 · con guardas infijas → 1 · con `AND()` → **0** |

O sea: **fuga de documentos entre familias** por un lado, y por otro `initEnrollmentSession_`
tratando como *«ya enviada»* un expediente **abandonado o sin enviar**. Un filtro *inválido*
devolvería 0 y saltaría a la vista el primer día; éste devolvía de más o de menos sin quejarse —
por eso vivió tanto.

**Por qué un control aparte y no la batería.** `npm run e2e:wizard` corre contra un backend
**simulado**: nunca llega a construir un Selector, así que **no puede salir roja por esto**.
Declararla como red de este cambio habría sido decorar. Este control lee el traductor REAL del
fuente, lo ejecuta aislado y afirma sobre lo que produce.

**Se exigió ROJA antes de dar nada por hecho**, dos veces: cambiando el troceador por un
`split('&&')` de texto plano (rojo: nombra el caso del `&&` dentro de comillas) y devolviendo la
emisión al infijo (rojo: 5 de 7). También salió roja **por sí sola** cuando el traductor todavía no
existía como función propia — una comprobación que no encuentra lo que dice medir no puede salir
verde.

**Lo que afirma y lo que no**: afirma la **FORMA** (funciones, paréntesis, comillas, sin `&&`/`||`
sueltos fuera de comillas). **NO** afirma que el filtro devuelva las filas correctas — eso solo lo
dice AppSheet, y se midió aparte. Cuando toques `wizardTraducirFiltro_` o añadas una forma de filtro
nueva, **el caso se añade en el MISMO cambio** y se rompe a propósito antes de darlo por bueno.

Cross-ref: `kis-app/docs/kms/loop-backlog.md` §"HALLAZGO GRAVE (2026-08-03)" (el mismo defecto en el
KMS, arreglado y desplegado @1184) · §"No se toca lo que funciona…".

### El asistente no cuenta a quien la familia ya quitó (2026-08-09)

**`node scripts/comprobar-personas-quitadas.mjs`** — trabajo `personas-quitadas` en
`.github/workflows/deploy.yml`; **`build` depende de él ⇒ en ROJO no se publica**. ~1 s, sin `npm
ci`, sin red, sin navegador.

**El defecto que vigila, MEDIDO sobre datos reales el 2026-08-09** (166 personas de `enrPersons`,
contadas dentro de GAS, cero datos de familia fuera): **134 retiradas · 83 tutores retirados sin
teléfono vivo · 57 de 67 expedientes BLOQUEADOS**. La familia puede quitar de su solicitud lo que
ella misma añadió (`enr.wizardRetirar`, que estampa `deleted_at`); el KMS descarta a esas personas
**en todas partes** y el asistente **no lo hacía en ninguna**. Resultado: la puerta del envío le
exigía un teléfono E.164 a tutores que ya no estaban y **tumbaba el envío entero** aunque los que
quedaban lo tuvieran todo correcto — `INVALID_PHONE` con todos los tutores vivos teniendo teléfono.
Y no era solo la puerta: con la misma lista sin filtrar, el **firmante** de los consentimientos
podía ser un tutor quitado, y la persona **reaparecía al recargar**.

**El arreglo es UN SOLO SITIO que decide quién sigue en la solicitud** — `wizardFilaViva_` /
`wizardSoloVivas_` (`backend/Code.js`, junto al catálogo de tablas), con el criterio **copiado**
del lector probado del KMS (`kis-app kms-server/enr/retirada.gs:365-367`,
`enr/wizard-gateway.gs:1523`): `!deleted_at && is_active !== false`. La única diferencia es que
AppSheet le devuelve al asistente el booleano como **TEXTO** (`'FALSE'`), así que comparar con
`false` a secas no casa nunca. **NO se reparte `!p.deleted_at` a mano por los sitios de lectura:
así nació esta asimetría.**

**Qué afirma el control, las dos cosas sobre el CÓDIGO REAL:** (a) **extrae del fuente** el ayudante
y lo **ejecuta** con 12 casos (fecha, vacío, espacios, booleano, texto en ambas cajas, columna
ausente, fila nula, y el colador entero) — no repite su lógica; (b) **ninguna** de las 33 lecturas
de personas / teléfonos / correos / vínculos se salta el ayudante, ni directa ni en lote. Las
exenciones (diagnósticos que SÍ deben ver a las retiradas) van declaradas **con su motivo escrito**
en `scripts/personas-quitadas.mjs`.

**Se exigió ROJA tres veces antes de darla por buena:** ablandando el criterio (3 casos rojos),
quitando el colador de la puerta del envío (`Code.js:4433` señalada por línea y función), y
renombrando el ayudante (rojo fatal: *«no puede medir lo que dice medir»*). **Límite honesto,
declarado en la cabecera**: es un detector por líneas, no un analizador sintáctico — un `eval()` o
un alias de `appsheetRequest_` seguirían siendo invisibles, igual que en `escrituras-directas.mjs`.

**Por qué no basta la batería.** `npm run e2e:wizard` corre contra un backend **simulado**: el
`backend/Code.js` real no se ejecuta ahí, así que **no puede salir roja por esto**. Su camino
`quitar-de-la-solicitud` cubre la pantalla (quitar sale hacia el servidor, la persona desaparece,
vuelve si el servidor dice que no) — que es otra cosa. Declarar la batería como red de este cambio
habría sido decorar.

### MANDATORY — MURO DE DEPLOY: batería del wizard VERDE antes de CUALQUIER publicación (2026-07-28)

**`npm run e2e:wizard` (desde `frontend/`) debe terminar VERDE antes de publicar nada** — ni el frontend a GitHub Pages, ni el backend con `clasp deploy`. **Cambio sin batería verde = NO deploy.** Es el equivalente al muro del KMS (`kis-app/CLAUDE.md` §"MANDATORY — MURO DE DEPLOY"), y nace de la regla de los dos repos (§"No se toca lo que funciona sin una forma de comprobar que sigue funcionando").

```bash
cd frontend
npm run e2e:wizard          # compila su propio bundle + recorre los 6 caminos
```

- **Cómo se lee el resultado: la ÚLTIMA línea de stdout, `VEREDICTO: VERDE` o `VEREDICTO: ROJO — <motivo>`.** Es la única señal válida. **NO** basta "no vi ningún ✗" ni el código de salida cuando la salida pasa por una tubería (`| tail`, `| tee` devuelven el código del ÚLTIMO comando — así se coló un «error fatal» con exit 0 en el KMS el 2026-07-27). La batería imprime ese veredicto SIEMPRE, incluso ante error fatal, excepción no capturada o promesa no gestionada, y solo dice VERDE si recorrió TODOS los caminos declarados con 0 fallos.
- **Prohibido repetir la batería hasta que salga verde**: un rojo se DIAGNOSTICA (cada camino imprime el detalle real: el paso donde aterrizó, los ms del avance, el payload que llegó), nunca se reintenta hasta pasar.
- **Una ejecución con `E2E_FILTER` NO vale como muro** — la batería lo detecta y devuelve ROJO explícitamente ("ejecución PARCIAL").
- **En CI ya es obligatorio**: `.github/workflows/deploy.yml` tiene un job `e2e` del que **depende** el job `build` → un push a `main` con la batería roja NO publica.

**Qué cubre** (`frontend/e2e/run-wizard.mjs`, Playwright headless contra el backend simulado de `e2e/mock-backend.mjs`): `alta-nueva` (portada → enlace enviado, UNA sola petición, el cliente NO decide recuperar-vs-crear) · `ack-indistinguible` (email conocido vs desconocido → misma pantalla y misma secuencia de llamadas; y con un servidor que delata, el cliente sigue sin ramificar — el guardarraíl del casi-incidente WIZ-ENUM) · `recuperar-aterrizar` (magic-link → aterriza en el paso donde estaba + token fuera de la barra, KAL-7) · `guardar-paso` (avance optimista ≤200 ms medido EN LA PÁGINA + el `saveStep` lleva el valor nuevo + persiste al volver atrás) · `subir-documento` (bytes reales + confirmación visible) · `tramo-firma` (expediente admitido aterriza en el paso 8 y lo pinta).

**Qué NO cubre (deliberado y declarado):** el **acto de firmar** no se consuma — es irreversible y su lógica vive en el motor del KMS, no en el wizard. Está declarado en `NO_CUBIERTAS_PERMITIDAS`; el resto de afirmaciones no ejecutadas hacen ROJO. Tampoco cubre el **backend GAS** (`backend/Code.js`) ni el OTP/step-up real: la batería entra con la gracia del magic-link (`step_up_fresh:true`), que es el camino que recorre una familia que acaba de pedir su enlace.

**Datos y correos:** la batería **no manda ni un email y no toca ningún dato real**. Compila el bundle con `VITE_GAS_ENDPOINT=/__gas` y todo el tráfico muere en un servidor local; los datos son sintéticos en el dominio reservado `.invalid` (RFC 2606), que nunca puede ser el buzón de una familia. Todo lo externo (CDN, fuentes, reCAPTCHA, logo) se aborta en el navegador.

**Cuando añadas o cambies un camino de la familia, la batería se amplía en el MISMO cambio.** Y antes de dar por buena una afirmación nueva, **rómpela a propósito** y comprueba que la batería sale ROJA nombrándola: una comprobación que nunca se ha visto fallar no es una red.

### Publicación

The wizard is served from a **fixed deployment URL**. `clasp push` only updates Head — users hit the deployment URL, which is frozen until redeployed.

```bash
# From backend/
clasp push --force
clasp deploy \
  --deploymentId AKfycbyzyAR6J3_2UAiE6tCyNHVawoGfMNNbZEaurp99cRI76IYbiqGVEeQQcTxsgAqUFnGk0w \
  -d "<short description of the change>"
```

**Never create a new deployment** — always update the existing one above. A new deployment yields a new URL and breaks `admissions.kaleide.org`.

### ⚠️ NO hay auto-despliegue del BACKEND — empujar a `main` NO publica `backend/Code.js` (medido 2026-08-02)

**Lo que CI hace de verdad en un empujón a `main`:** `e2e` (la batería del wizard) → `build` → `deploy` **a GitHub Pages**. Eso publica **el frontend y solo el frontend**.

**Lo que CI NO hace: NADA con `clasp`.** El backend GAS se publica **a mano**, con los dos comandos de §"Publicación" de aquí arriba. Un cambio en `backend/Code.js` empujado a `main` queda **en el repositorio y NO en la URL que usan las familias** hasta que alguien ejecuta ese `clasp push` + `clasp deploy`.

Comprobado así, no supuesto:

```bash
ls .github/workflows/                                  # → solo deploy.yml
grep -c 'clasp' .github/workflows/deploy.yml           # → 0
```

**Esta sección decía lo contrario hasta el 2026-08-02**: afirmaba que `deploy.yml` incluía un trabajo `backend-deploy` con `clasp push --force` + `clasp deploy` en cada empujón a `main`, y explicaba cómo dar de alta un secreto `CLASP_TOKEN` para alimentarlo. **Ese trabajo no existe en el fichero** (ni el secreto se usa en ninguna parte). Es la misma clase de error que la auditoría del 2026-08-01 (§"Regla: para AUDITAR o DECIDIR sobre el wizard…" en `kis-app/CLAUDE.md`): **documentación que declara existente un mecanismo que no está**. Aquí el daño era el simétrico y peor — invitaba a dar por publicado un cambio de backend que seguía sin salir, o a no ejecutar el despliegue "porque ya lo hace CI".

Si algún día se quiere ese trabajo, se **construye y se ve funcionar** antes de describirlo aquí.

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

> **★ MIGRADO AL MOTOR DEL KMS (2026-06-25, wizard @185 + KMS @766). El wizard YA NO manda los emails transaccionales vía `GmailApp.sendEmail`.** El texto histórico de abajo (alias "Send mail as" del `GmailApp` local) está SUPERSEDIDO — se conserva solo como registro.

### Lo que el wizard manda HOY — la lista, y cómo se comprueba (medido 2026-08-08)

**Son cuatro avisos + el código de un solo uso, y ninguno es la confirmación a la familia:** `WIZARD_MAGIC_LINK` y `WIZARD_MAGIC_LINK_MULTI` (a la familia, el enlace para volver a su solicitud) · `WIZARD_SESSION_STARTED` y `WIZARD_UNSOLICITED_REPORTED` (a admisiones, internos) · `WIZARD_OTP` (el código de un solo uso, por `sendViaKmsAuthCode_`). **La confirmación de «solicitud recibida» y los avisos del expediente NO los manda el wizard: los gobierna el motor de avisos del KMS a partir de los hitos** (los dos correos del envío se retiraron del wizard el 2026-08-07 y hoy cuelgan de la entrada en RQ).

**Un nombre de plantilla dentro de un comentario NO es un envío.** Antes de afirmar que el wizard manda algo, cuenta los llamadores contra `origin/main` — nunca contra el árbol de trabajo: `git show origin/main:backend/Code.js | grep -oE "sendViaKmsNotify_\('[A-Z_]+'" | sort -u`. Un `@param` obsoleto que nombraba `WIZARD_FAMILY_CONFIRMATION` (cero llamadores) hizo que **tres agentes distintos, en dos días**, le afirmaran a Diego que el wizard manda esa confirmación; tuvo que desmentirlo tres veces y estuvo a punto de frenar un despliegue.

---

Los emails del wizard los **renderiza y envía el motor del KMS**, no el GAS del wizard:

- **Los transaccionales** (los cuatro de la lista de arriba) → `kmsProxy_('sys-public.sendNotification', …)` vía el helper `sendViaKmsNotify_` (`backend/Code.js:6499`, firma HMAC con `NOTIFY_HMAC_SECRET` compartido) → KMS `sysPublic_sendNotification` (`kis-app/kms-server/sys/notify-public.gs:105`, whitelist `:63`). Las funciones locales `sendMagicLinkEmail_`/`sendMagicLinkMultiEmail_`/`sendFamilyConfirmationEmail_` **fueron ELIMINADAS** (`Code.js:5738`). Realiza **P213** (endpoint KMS) + **P214** (refactor wizard).
- **El OTP** → `kmsProxy_('sys-public.sendAuthCode', …)` vía `sendViaKmsAuthCode_` (`backend/Code.js:6534`) → KMS `sysPublic_sendAuthCode` (`notify-public.gs:146`), endpoint **síncrono**, el código **NO se persiste** en `sysNotificationLog`. La **generación y verificación del código siguen wizard-side** (lógica de auth); solo el render+envío salieron al KMS. Realiza **P253**.

**Pre-requisito de Diego (una vez):** generar `NOTIFY_HMAC_SECRET` y copiarlo a las Script Properties de AMBOS GAS (wizard + KMS). El contenido/plantilla de cada email vive en el catálogo del KMS (`sysNotificationTemplates_T` + `locales/`), no en el wizard.

Cross-ref: `kis-app/docs/kms/decisions/enr.md` (ENMIENDA del flujo + bug OTP RESUELTO) + `kis-app/docs/kms/operational-pending.md` fila "wizard-terminal" (DESPLEGADO @766/@185).

---

**(Histórico — SUPERSEDIDO 2026-06-25, no aplica al wizard actual):** Transactional emails (application received, etc.) use `GmailApp.sendEmail` with `from: ADMISSIONS_EMAIL` so they appear from `admissions@kaleide.org` instead of the deploying account. This requires `admissions@kaleide.org` to be configured as a **"Send mail as" alias** in the deploying Gmail account (Settings → Accounts → Send mail as). Without the alias, Gmail silently falls back to the deploying account address.

## Autonomy — main branch

Diego has authorized Claude Code to proceed without prior confirmation for any git and clasp operation on `main`, mirroring the kis-app autonomy directive:

- `git add`, `git commit`, `git push` on `main`
- `clasp push --force` (from `backend/`)
- `clasp deploy --deploymentId AKfycbyzyAR6J3_2UAiE6tCyNHVawoGfMNNbZEaurp99cRI76IYbiqGVEeQQcTxsgAqUFnGk0w -d "..."`

Still requires confirmation:
- `clasp create` (new GAS project)
- Creating a new deployment (would change the URL)
