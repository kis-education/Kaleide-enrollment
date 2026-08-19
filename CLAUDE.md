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

**Consecuencia de diseño**: el resolvedor de la identidad incluye un fallback (2026-06-11) para el caso en que la fila de `enrEmails` correspondiente al email de creación esté sin `person_id` (bug de origen: `enr_persistPersons_` no vincula la fila huérfana al `person_id` del tutor 1). El fallback resuelve via `requester_person_id` del grupo. **Vive en el KMS** (`enr_resolveGuardianFromEmail_`, sub-casos A y B) desde ②17 noveno tramo — aquí solo queda el cliente fino `resolveGuardianForRecovery_`. Ver `kis-app/docs/kms/reports/2026-06-11-recovery-email-fix.md` + finding #39.

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

**El duodécimo, dado de alta el 2026-08-19:** `guardarModalidadPreferida_` — la forma de pago que
la familia elige en la SIMULACIÓN del paso 7. No compromete a nadie (la elección en firme es la del
paso 8, que es la que se firma), pero **es una escritura sobre el expediente de la familia** y va
por la misma puerta que las demás: un `resume_token` filtrado no debe poder tocarle nada sin
acreditar el buzón. Su hermano de la misma pantalla —`simularCuotas_`— **NO** lleva el código a
propósito: es una LECTURA que no muta nada, y pedirlo dejaría sin ver sus tarifas a la familia que
lleva más de diez minutos repasando su solicitud, que es exactamente cuando llega al paso 7.

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

**Control**: la comprobación de paridad **se ejecuta con `node scripts/comprobar-verja-publica.mjs`**;
su lógica vive en `scripts/verja-publica.mjs` (`comprobarParidadDelCodigo`) — ver §"Las CINCO puertas
del asistente" para qué NO afirma.

⚠️ **`scripts/verja-publica.mjs` NO se ejecuta: es el MÓDULO, no el control.** Lanzarlo a mano
**no imprime nada y sale con código 0** — que es exactamente la forma de un verde falso, y por eso
se dice aquí. El **runner** es `comprobar-verja-publica.mjs`, y es el que imprime el
`VEREDICTO:` de la última línea. *(Medido el 2026-08-10: dos manos distintas —el orquestador de la
rutina y su agente— cayeron en la misma trampa el mismo día, cada una por su lado, porque esta
línea nombraba el módulo. Un control que se da por pasado sin haberse ejecutado es peor que no
tenerlo.)*

#### El respaldo «si no consta, el tutor 1» vale para DOS usos y NO para el tercero (②24.bis, 2026-08-10)

**Un solo sitio resuelve qué buzón está operando** — `_identidadDelEnlace_` → `effectiveRecoveredEmail_`
(la identidad del enlace, `n` = `email_id`, validada contra el expediente del token). Su **paso 3** es
un respaldo: cuando no hay `n` ni `recovered_email`, **no devuelve «no se sabe», devuelve el
`primary_email` del expediente — o sea, el tutor 1**.

| Uso | ¿Respaldo? | Por qué |
|---|---|---|
| a qué buzón va el código de un solo uso | **SÍ** | como mucho lo manda a quien ya lo recibía |
| de quién es la marca de «recién verificado» (`assertStepUpFresh_`) | **SÍ** | ídem: el comportamiento de siempre |
| **quién FIRMÓ el consentimiento** (`sysConsentsLog`) | **NO** | es el REGISTRO LEGAL: atribuirle a alguien lo que quizá no dio es una mentira, no un valor por defecto |

**Quien atribuye pide el modo estricto y lo DECLARA** — `wizardTutorAtribuible_`, que es el MISMO
resolvedor con `{sinRespaldo:true}`. **PROHIBIDO escribir un segundo resolvedor** (dos lectores del
mismo dato divergen) y **prohibido retirar el respaldo** (dejaría a familias sin poder verificarse).
Con `null`, las reglas 2 y 3 de `wizardFirmanteDelConsentimiento_` (②29) por fin se alcanzan: un solo
tutor vivo ⇒ firma ese; varios ⇒ **no se registra a nombre de nadie** y se dice (registro redactado +
`consentimiento_sin_firmante` en la respuesta). Las **dos memorias de 300 s** llevan el modo en la
clave (`idlinkd_` declarada · `idlinkr_` con respaldo): compartirla las contamina y el fallo sale
intermitente.

**Este arreglo NO tiene prueba automática, y está DEMOSTRADO, no supuesto**: se rompió a propósito
tres veces (devolver la atribución al resolvedor con respaldo · ignorar `sinRespaldo` · compartir
clave de memoria) y **los nueve controles del repositorio salieron VERDES las tres veces** — la
batería corre contra un backend simulado que nunca ejecuta `backend/Code.js`. No se escribió una red
para tapar el hueco (§"La red es UNA"): lo que hay que hacer al tocar esto es **medirlo**.

#### Si el KMS DESCARTA lo que la familia escribió, el asistente lo dice — y no dice «guardado» (②24.sexies, 2026-08-10)

**El asistente no puede afirmar que algo se guardó: el KMS lo ENCOLA.** `enr.wizardSaveResponses`
apunta el trabajo y contesta `{ok:true, queued:true}` (`kis-app kms-server/enr/wizard-gateway.gs:236`);
quien escribe de verdad es el trabajador de la cola, después. Hasta el 2026-08-10 `saveResponses_`
llamaba al KMS **sin recoger su respuesta** y devolvía `{saved: N}` a pelo — una afirmación que ese
código no está en condiciones de hacer, y **falsa entera** en el caso que importa: el tutor que YA
envió su parte no sigue rellenando (DL-E49 §6), así que `enr_persistResponses_` devuelve
`{responses:0, skipped_already_submitted:true}` y **no escribe nada**. Medido: ese aviso **no
aparecía ni una vez** en todo este repositorio, y **no podía aparecer** — lo produce la cola, mucho
después, y nunca viaja en la respuesta.

**Por eso se PREGUNTA antes, con lo que ya existe.** `enr.wizardEstadoDeLasPartes` es una lectura
**síncrona** cuyo propósito declarado es exactamente ése —«¿puede este tutor seguir rellenando?»
(`wizard-gateway.gs:736`)— y el asistente ya la consumía en la pantalla de confirmación. **No se
construye mecanismo nuevo**: `_parteDeEsteTutorYaEnviada_` la reusa y, si consta que ese tutor ya
envió, `saveResponses_` rechaza con `PARTE_YA_ENVIADA` **antes** de encolar nada. KAL-4 intacta (el
expediente sale del `resume_token`; la persona la resuelve `wizardTutorQueOpera_` server-side y el
KMS la re-valida). **Degrada hacia GUARDAR**: sin tutor identificado o con la lectura caída devuelve
`false` — un dato que no se puede consultar no puede convertir esto en un asistente que se niega a
guardar. El suelo sigue siendo la regla del KMS; esto solo sirve para poder **decírselo a la familia**.

**En pantalla se reusa el carril global de guardado**, porque el paso avanza de forma optimista y un
aviso local moriría con el paso desmontado: el código del rechazo viaja hasta `SaveIndicator`
(`saveErrorCodigo`), que **pregunta a `lib/rechazos.js`** qué pasó y **no ofrece «Reintentar»**, que
aquí sería un callejón sin salida. El resto de fallos se comporta byte-idéntico.

**Y UN SOLO SITIO decide si un rechazo se reintenta: `frontend/src/lib/rechazos.js` (18.bis.85).**
La tabla `RECHAZOS_DEFINITIVOS` (código → texto) la leen los **dos** consumidores —el aviso, para
explicarlo y esconder el botón; la cola, para **no recordar** la escritura fallida y no volver a
mandarla sola cuando otra escritura tiene éxito (`alConfirmarEscritura`)—. **Falla hacia el lado
seguro**: lo no declarado se sigue reintentando como siempre, así que un corte de red nunca se
convierte en trabajo perdido. **Un código nuevo se declara con una línea AHÍ**, sin tocar ni el
contexto ni el aviso, y **jamás se escribe una segunda lista** (el mapa de `SubmitErrorBanner`
responde a otra pregunta: allí los códigos SÍ se reintentan con provecho, por eso conserva su botón).

⚠️ **Y no basta con dejar de reintentar**: sin más, el SIGUIENTE guardado que entra drena la cola y
la deja en «Todos los cambios guardados» **con el cuestionario de la familia tirado a la basura** —
antes eso no se veía porque el reintento, al volver a fallar, mantenía el rojo encendido. Por eso,
mientras un rechazo definitivo esté en pie, la cola **repone el aviso en vez de caer a 'idle'**, y
**en el mismo episodio**: un cartel que la familia ya cerró **no se le vuelve a abrir**. Lo cazó la
batería (`respuestas-rechazadas-se-dicen` salió ROJO en su afirmación (1) con la versión ingenua).

**La mitad del cliente SÍ tiene red; la del servidor NO, y está DEMOSTRADO.** El camino
`respuestas-rechazadas-se-dicen` de la batería salió **ROJO** las dos veces que se rompió lo visible
(quitando el mensaje explicado → rojo en (2) y (3); tragándose el rechazo en la factory de
`Step5Questions` → rojo en (1)). Pero al devolver `saveResponses_` a la mentira original (`saved: N`,
sin rechazo) **el camino siguió VERDE y los cuatro controles también**: la batería corre contra un
backend simulado que **nunca ejecuta `backend/Code.js`**. No se escribió una red para tapar el hueco
(§"La red es UNA") — lo que hay que hacer al tocar `saveResponses_` es **medirlo**.

### Dos bearer tokens canónicos del wizard — resume_token (/apply) + signing_token (/sign) (CLI 45, 2026-06-02)

> **★ ESTADO REAL POST-W2 (verificado 2026-06-11, gobierna esta sección). El modelo de "dos rutas de entrada" (`/apply` + `/sign`) descrito abajo está SUPERSEDIDO por el modelo ★ CANÓNICA DEFINITIVA (`kis-app/docs/kms/decisions/enr.md`): el wizard es UN flujo único de 11 pasos, UNA sola ruta (`/apply`), entrada única por recuperación de magic-link per-guardian.** Lo que sigue VIGENTE de esta sección es **solo el modelo de AUTORIZACIÓN** (KAL-4 IDOR: `enrollment_group_id` + signer derivados SIEMPRE server-side del token, NUNCA del payload; `requireResumeToken_` como gate de los 11 pasos). Lo que cambió en el CÓDIGO ya desplegado:
> - **`/sign` eliminada como ruta** (`frontend/src/App.jsx:100` → `<Navigate to="/apply" replace />`). Los Steps 8-11 (firma) viven INLINE en `WizardPage` (`steps/Step8..Step11`), no en un host separado. El puente Step 7→8 es `enterSigning` INLINE (`WizardPage.jsx:379`), gobernado por estado (`canAdvanceToSigning` `:793`: `state_code==='AD' && signing_ready && signing_status!=='COMPLETED'`).
> - **Recuperación guardian-scoped (a1, P215):** `resolveGuardianForRecovery_` resuelve el guardian del `recovered_email` server-side *(desde ②17 noveno tramo lo resuelve el KMS —`enr.wizardTutorQueRecupera`— y esto es un cliente fino; el matching no cambió)*; `buildAdmissionContext_` (`:1791`) devuelve el estado real (`sysStates_T`) + el `signing_context` per-guardian (Path1 del email / Path2 determinista de la sesión). El `resume_token` sigue siendo de GRUPO; el guardian es un discriminador re-resuelto contra datos reales por llamada (KAL-4 aprobado por Diego para a1). NO hay esquema nuevo.
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
> **Ahora**: el `n` del magic link (que YA viajaba — antes era un grace nonce aleatorio) pasa a llevar el **`email_id`** (PK de la fila `enrEmails` del guardian al que se emitió el link) — opaco, sin PII, ya existe. **Emisión** (`sendMagicLink_`): el `email_id` del tutor destino → `?n=<email_id>`. **Resolución** (`resolveEmailFromLinkParam_` dentro de `effectiveRecoveredEmail_`, usada por `getAdmissionState_`/`hydrateSession_`/`requireSignerContext_` — `resumeSession_` también la usaba, y se retiró en ②17): la fila del `n` se busca **solo dentro del expediente del `resume_token`** (KAL-4 por construcción) y ha de resolver a tutor → devuelve el email. **②17 noveno tramo: las dos cosas —emisión y resolución— las contesta la MISMA pregunta al KMS**, y `findEmailIdForGuardian_` se retiró → alimenta `recovered_email` (contrato KMS INTACTO). Prioridad `n` > `recovered_email` (compat secundario). La identidad sobrevive a F5/incógnito/pestañas: el frontend persiste el `n` (`recoveryNonce`) en sessionStorage y lo reenvía en hydrate + pulse + actos de firma.
>
> **Reglas canónicas inmiscibles**:
> - `n` (email_id) JAMÁS se cree a ciegas: SIEMPRE se valida contra BD que la fila pertenece al grupo del token (KAL-4) y resuelve a guardian. `assertValidUuid_` + `appsheetEscape_` (KAL-5); logs redactados (KAL-11).
> - `n` NO es un bearer (no autoriza por sí solo). El `enrollment_group_id` se deriva SIEMPRE del `resume_token`, nunca del payload.
> - La **gracia OTP-skip** se ancla al `resume_token` recién rotado (`mlgrace_<resume_token>`), NO a `n` (que ahora es identidad). Single-use + 10 min; un token viejo no tiene marcador → OTP normal (KAL-7 intacta).
> - Devuelve el EMAIL (no el `person_id`) porque el resolvedor matchea por email. **②17 noveno tramo (P245): ya NO hay dos resolvedores** — queda `enr_resolveGuardianFromEmail_` en el KMS, y el del asistente es un cliente fino suyo.
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
- **Las LECTURAS AppSheet directas permanecen** (`fetchLookups_`, `submitEnrollmentSession_`, `initEnrollmentSession_`, etc.) → la credencial AppSheet del wizard sigue siendo necesaria. Migrarlas es la fase **P1-C**, hoy `②17` de la cola, y se está haciendo **por tramos**: ya salieron las de **firma e hitos**, las de **reconocer a la familia** —`contactEmails` y `personalData_S`, que eran las dos únicas a las tablas MAESTRAS de personas del colegio (§"recognizeFamily")—, las **tres guardas de los documentos** (§"subir y ver un documento"), **la hidratación de entrada, que no se migró sino que se RETIRÓ** (§"②17 — la hidratación de entrada tenía DOS lectores"), **la validación del ENVÍO** (§"②17 — el envío ya no lee AppSheet"), **la CABECERA del expediente en el camino de entrada** (§"②17 — la CABECERA del expediente"), **la ENTRADA de una solicitud nueva** (§"②17 — la ENTRADA de una solicitud nueva") y **la RECUPERACIÓN DEL ENLACE por un correo tecleado** (§"②17 — la RECUPERACIÓN DEL ENLACE") y **la IDENTIDAD DE QUIEN RECUPERA** (§"②17 — la IDENTIDAD DE QUIEN RECUPERA") y **QUIÉN PUEDE CONTESTAR el cuestionario** (§"②17 — QUIÉN PUEDE CONTESTAR") y **las ETIQUETAS de los documentos del envío** (§"②17 — las ETIQUETAS de los documentos") y **LA PUERTA y sus tres hermanas** (§"②17 — LA PUERTA") y **EL PULSO DE LA ADMISIÓN** (§"②17 — EL PULSO") y **EL RACIMO DE FIRMA E HITOS** (§"②17 — EL RACIMO DE FIRMA"). **Medido el 2026-08-16: quedan 44 lecturas directas y NINGUNA en lote** (`grep -c 'appsheetRequest_('` menos la definición; ídem `appsheetRequestBatch_`). **De esas 44, solo DOS están en el camino vivo** —`sendMagicLink_` y `sendVerificationCode_`, las dos con su motivo escrito para no moverse—; las otras **42** viven en funciones `manual_*` de editor **y en `adminCleanupOrphanSessions`, que NO está en el despachador** ⇒ **no alcanzables desde internet**. Bajarlas mejora el recuento pero **no estrecha el agujero**, así que esto ya no se coge por el número. **`submitEnrollmentSession_`, `requireResumeToken_`, `assertGroupEditable_`, `getAdmissionState_`, `buildAdmissionContext_` y `resolveSigningToken_` están a CERO.** **La entrada sigue ABIERTA: la credencial sigue en el asistente** — acotarla por cliente es `②18`, y hoy es lo único que queda de peso en esta ficha.

### ②17 (2026-08-15) — subir y ver un documento ya no leen AppSheet: las tres guardas las sirve el KMS

**Eran TRES lecturas directas, y las tres eran GUARDAS** —comprobaciones de acceso, no
composición—: en `uploadDocument_`, *¿el expediente de alumno al que se cuelga el documento es de
esta familia?* (`enrEnrollments`) y *¿este mismo envío ya se guardó?* (`recFiles`, idempotencia); en
`getDocument_`, *¿este documento está en el expediente del token?* (`recFiles`, la guarda de IDOR).
Las tres las hacía **este** proceso, que es público y anónimo, **con la credencial de AppSheet de la
aplicación entera** — la que alcanza cualquier tabla porque la URL lleva la tabla como parámetro.

**Ahora las sirven dos entradas del KMS** (`kis-app kms-server/enr/wizard-gateway.gs`), con los
**mismos filtros**:

| Entrada | Qué contesta | Ayudante de este lado |
|---|---|---|
| `enr.wizardComprobarSubida` | las dos comprobaciones previas a subir, en **una sola pregunta** (antes eran dos idas y vueltas) | llamada directa en `uploadDocument_` |
| `enr.wizardFicheroDelExpediente` | la fila del documento, **proyectada a cuatro campos** (`file_id`, `drive_file_id`, `file_name`, `mime_type`) | `_ficheroDelExpediente_` |

**Lo que hay que retener al tocar esto:**

- **El expediente sale del `resume_token`, nunca del cuerpo** (KAL-4), y el nombre de la tabla **no
  viaja en la petición**. Un documento de otra familia responde **exactamente igual** que uno que no
  existe; un expediente de alumno ajeno **se rechaza nombrándolo**.
- **La proyección es la mitad del valor**: antes cruzaba aquí la ficha entera del documento (quién
  lo subió, cuándo, su descripción). Ahora, cuatro campos.
- **Los dos fallos NO pesan igual, y el criterio viejo se conserva**: no poder comprobar el
  **acceso** ⇒ no se sube (fallo cerrado — la lectura de AppSheet también lanzaba si se caía); no
  poder mirar si el envío **ya estaba** ⇒ se sube igual (el `catch (_)` de siempre; como mucho se
  repite un documento).
- **`_ficheroDelExpediente_` devuelve TRES cosas, no dos**: «no está» (→ se prueba el camino del
  paquete de firma, como antes) y «no se pudo preguntar» (→ lanza). **Colapsarlas le diría «no es
  tuyo» a la familia dueña del documento**, y por eso el control lo vigila.
- **El KMS copia la regla de qué identificador es legible** (`^[A-Za-z0-9._-]{1,128}$`, no un UUID):
  hay ficheros con identificador semántico heredado (F-17·#10) y un validador más estricto allí
  dejaría a una familia sin ver un documento suyo.

**Control**: `scripts/verja-publica.mjs` gana cinco afirmaciones —ninguno de los dos manejadores
vuelve a leer `enrEnrollments`/`recFiles` de AppSheet · los dos SÍ preguntan al KMS · el ayudante
sigue distinguiendo los dos fallos—. **Rojo demostrado las cinco.**

⚠️ **La batería NO cubre esto**: corre contra un backend simulado que **nunca ejecuta
`backend/Code.js`**. El lado del KMS tampoco lo cubre ningún control, así que se **midió aparte**
(12 afirmaciones sobre los manejadores reales, ejecutados con dobles, y la medición demostrada no
ciega). **Quien toque estos dos manejadores, que lo mida.**

### ②17 (2026-08-15) — la hidratación de entrada tenía DOS lectores: el muerto se RETIRÓ entero

**No era una migración: era código muerto que seguía ejecutándose.** `resumeSession` era una
**segunda hidratación completa** del expediente de la familia, y leía **~24 tablas de AppSheet
directamente** desde este proceso —público y anónimo— con la credencial de la aplicación entera:
personas, vínculos, documentos, respuestas, entrevistas, nacionalidades, documentos de identidad,
idiomas, direcciones, colegios previos y **salud, alergias, dieta y NEAE de menores**.

**Medido contra `origin/main` antes de tocar nada, y esto es lo que lo hizo accionable:**

| Qué se midió | Resultado |
|---|---|
| Llamadas del frontal a `resumeSession` | **CERO.** Sus 14 apariciones en `frontend/` son **comentarios**; el camino vivo es `hydrateSession` → KMS (`ResumePage.jsx:113`, `WizardPage.jsx:221,596`) |
| Quién llamaba a `buildResumeSessionData_` | **dos sitios, los dos retirados**: `resumeSession_` y la fase `'res'` del precalentado |
| Quién leía la memoria `wz_res_` que ese precalentado llenaba | **solo `resumeSession_`** |

⇒ **la fase `'res'` ejecutaba esas ~24 lecturas en CADA envío de enlace para llenar una memoria que
solo leía un manejador que nadie llamaba.** Trabajo real, coste real, valor cero.

**Lo retirado, y por qué se retira en vez de migrarse:** `resumeSession_` · `buildResumeSessionData_` ·
`_warmResumePhase_` · su `case` del despachador público · el reparto y el encolado de la fase `'res'` ·
y `manual_testResumeCacheHitRedactsToken`, que solo ejercitaba ese camino. **707 líneas.** Migrarlo al
KMS habría conservado un **segundo lector** de lo que el KMS ya sirve entero por `enr.wizardHydrate`
— justamente el anti-patrón que §"Regla — refactors preservan el código probado" prohíbe.

**Lo que NO se pierde, comprobado uno a uno:**

- **La reapertura** (`submitted_at → null` cuando el colegio devuelve el expediente a la familia) ya
  vivía **también** en `hydrateSession_` (busca `REOPEN-FIX`). Hoy vive **solo** ahí — ése es el
  arreglo, no un efecto colateral.
- **El precalentado del camino vivo NO se toca**: la fase `'kms'` calienta `wz_hyd_`, que es la que
  `hydrateSession_` lee; y la fase `'mem'` sigue igual. Lo retirado es la tercera.
- **Ningún ayudante queda huérfano** — se comprobaron los once que usaba (`_wzAwaitWarm_`,
  `_redactSigningTokenIfNotFresh_`, `_wzCacheKey_`, `_getLiveStateVersion_`…): todos conservan
  llamantes vivos.

**Recuento, con la forma de repetirlo** (`grep -c 'appsheetRequest_('` **menos 1**, la definición;
ídem `appsheetRequestBatch_`): **83 → 78** lecturas directas y **7 → 4** en lote. **Las llamadas al
KMS NO suben**: este tramo no añade ninguna entrada nueva, que es la diferencia con los tres
anteriores.

**Control**: `scripts/verja-publica.mjs` gana `comprobarLaHidratacionDeEntrada` — `resumeSession` no
vuelve al despachador · `buildResumeSessionData_` y `_warmResumePhase_` no vuelven · y **el ancla**:
`hydrateSession_` existe y sigue pidiéndole los datos al KMS, para que el control no pueda quedarse
ciego afirmando ausencias en un fichero que ya no mide. **Rojo demostrado las cinco**, cada una
nombrando su caso.

⚠️ **La batería NO cubre esto** — corre contra un backend simulado que **nunca ejecuta
`backend/Code.js`**. Lo que sí acredita es lo que importaba comprobar en el cliente: recorre el
camino de recuperación entero (`recuperar-aterrizar`) **sin llamar a `resumeSession` ni una vez**.

### ②17 (2026-08-15) — el ENVÍO ya no lee AppSheet para validarse, y de sus ocho lecturas TRES no las leía nadie

**El manejador del envío hacía OCHO lecturas directas. Al medirlas una a una contra `origin/main`,
tres resultaron no tener ni un consumidor** — y ése es el hallazgo, no la migración:

| | qué leía | qué pasaba |
|---|---|---|
| dos | correos y teléfonos por identificador | **no se ejecutaban nunca**: sus dos listas de partida eran literales `[]` desde que se borraron `enrPersonEmails`/`enrPersonPhones` (2026-05-17) |
| una | las respuestas de profesión, empleador y adaptación | **SÍ se ejecutaba en CADA envío** y su resultado se tiraba |

**Y la tercera no era solo trabajo tirado: era un modo de fallo que dejaba familias encalladas.**
Ocurría **DESPUÉS** de que el KMS ya hubiera materializado los expedientes y estampado el envío, y
**fuera de todo `try`** — y `appsheetRequest_` lanza siempre, no degrada. Si AppSheet fallaba en ese
punto, la familia se quedaba con la solicitud **medio enviada** y su reintento chocaba contra
`NOT_EDITABLE`: exactamente el atasco que el bloque W1 de ese mismo manejador dice haber cerrado
moviendo las validaciones delante de las escrituras. Lo provocaba un dato que **nadie mira**.

**Lo retirado, entero, por ser una isla sin llamantes:** las tres lecturas · sus variables de apoyo ·
las cuatro constantes de identificador de pregunta · y **`buildApplicationSubmittedBody_` +
`_kmsRenderApplicantsTable_`**, cuyo último consumidor desapareció al retirarse el PDF del envío
(P262) y los dos correos (2026-08-07). Medido: **cero llamantes** de las dos.

**Las tres lecturas VIVAS —la cabecera del expediente, las personas y los teléfonos— las sirve ahora
el KMS en UNA sola pregunta**, `enr.wizardDatosDelEnvio` (`kis-app kms-server/enr/wizard-gateway.gs`),
con los **mismos filtros por expediente** y el mismo criterio de fila viva.

**Lo que hay que retener al tocar esto:**

- **El expediente sale del `resume_token`** (KAL-4) y el nombre de la tabla **no viaja** en la
  petición. La puerta del KMS aplica el mismo plazo de 7 días y el mismo rechazo de sesión
  abandonada que `requireResumeToken_` ⇒ **cero cambio de comportamiento**, comprobado línea a línea.
- **La proyección es la mitad del valor**: de cada persona cruzan **el identificador y el papel**, y
  de cada teléfono **solo el número**. Nombres, fechas de nacimiento y documentos se quedan dentro
  del KMS. Antes cruzaba la ficha entera.
- **La normalización del teléfono y el E.164 estricto se conservan VERBATIM en el asistente.** Lo
  que se movió es de dónde sale el dato, no el criterio — mover la puerta entera al KMS habría sido
  rediseñar algo probado.
- **Falla CERRADO, y no es un detalle**: si el KMS no puede leer las personas o los teléfonos,
  **lanza**. Degradar a lista vacía dejaría pasar un envío sin alumno, o rechazaría a **toda**
  familia con un `INVALID_PHONE` falso que no puede corregir.
- **Por qué NO se reutiliza la hidratación** (el único lector solapado): `enr_wizardHydrate` recorta
  las personas a propósito y devuelve **un solo tutor** —el que mira— por privacidad entre tutores
  (DL-E49 §2). El envío necesita el conjunto completo para exigirle teléfono a cada uno, así que
  reutilizarla obligaría a abrir un rodeo dentro de la única función que decide esa privacidad.
- **Las dos lecturas de `recFiles`/`recScopes` del mismo manejador salieron en el UNDÉCIMO tramo**
  (§"②17 — las ETIQUETAS de los documentos", 2026-08-16). Aquí se dijo que no podían moverse porque
  «llevan dentro el literal `enr_admission_school` y DL-E48 prohíbe escribir a mano el tipo de
  expediente» — **eso era FALSO y aplazó el trabajo cuatro vueltas**: `enr_admission_school` en
  minúsculas no es un tipo de expediente, es un `scope_type_code`.

**Recuento, con la forma de repetirlo** (`grep -c 'appsheetRequest_('` **menos 1**, la definición):
**78 → 72** sueltas; las de lote se quedan en 4. En el manejador del envío: **8 → 2**.

**Control**: `scripts/verja-publica.mjs` gana `comprobarElEnvio` — el manejador no vuelve a leer
ninguna de las cinco tablas · **sí** le pregunta al KMS · la isla muerta no reaparece · y **el
ancla**, que la puerta E.164 sigue ahí, para que el control no pueda salir verde sobre un manejador
al que le hubieran quitado la validación. **Rojo demostrado seis veces**, cada una nombrando su caso
(incluido el renombrado, que deja el control CIEGO).

⚠️ **La batería NO cubre esto** — corre contra un backend simulado que **nunca ejecuta
`backend/Code.js`**. El lado del KMS tampoco lo cubre ningún control, así que se **midió aparte**:
**13 afirmaciones sobre el manejador real**, ejecutado con dobles, y **la medición se demostró no
ciega** rompiéndolo cuatro veces (ensanchar la proyección · aflojar el criterio de fila viva ·
degradar los teléfonos en vez de fallar cerrado · quitar el cinturón sobre el filtro).
**Quien toque este manejador, que lo mida.**

### ②17 (2026-08-15) — la ENTRADA de una solicitud nueva: los expedientes de un correo los sirve el KMS

**`initEnrollmentSession_` es la puerta por la que entra TODA familia nueva**, y hacía **TRES**
lecturas directas a AppSheet desde este proceso —público y anónimo—, las tres filtradas por el
**correo que la familia teclea**: los expedientes de ese correo **ya enviados**, los **abiertos**, y
las **personas** de los candidatos abiertos —que solo se usan para **CONTARLAS**, para decidir cuál
de dos sesiones en marcha va más avanzada—.

**Lo que cruzaba, y por eso este tramo vale lo que vale:** de cada expediente, la **fila entera**
—con **`magic_link_token`**, un secreto de portador, más `school_id`, `program_id`, `source_id`,
`requester_person_id`, `source_locale`, `submitted_at`, `abandoned_at`, `_RowNumber` y el bloque de
auditoría y borrado lógico completo—; y de cada persona, la **ficha entera** (nombre, fecha de
nacimiento, documento) **de menores incluidos**, para contarlas. Ahora lo sirve **una** entrada del
KMS, `enr.wizardExpedientesDelCorreo`, y lo consume **UN SOLO ayudante**, `_expedientesDelCorreo_`.

**Lo que hay que retener al tocar esto:**

- **LA DECISIÓN NO SE MOVIÓ.** La política de sesión única —puntuar cada candidato por número de
  personas, desempatar por fecha, abandonar a los perdedores— se queda **entera y verbatim** en este
  fichero. Cambia **de dónde salen las filas**, no qué se hace con ellas. Por eso la entrada
  devuelve las **dos listas** y un **recuento por expediente**, nunca un ganador ya elegido.
- **La proyección, medida contra `origin/main`:** de los enviados salen **tres** campos
  (`enrollment_group_id`, `resume_token`, `preferred_language`) y de los abiertos **cinco** (esos
  tres más `updated_at` y `created_at`, que solo alimentan el desempate). **De las personas no sale
  NADA: un número por expediente.**
- **Los dos fallos NO pesan igual, y se conserva el criterio del oro.** Las dos lecturas de
  expedientes **LANZAN** —`appsheetRequest_` lanzaba y aquí no había `try`—: decir «no hay ninguno»
  cuando en realidad no se pudo preguntar le abriría un expediente **NUEVO** a una familia que ya
  tiene el suyo, y le mandaría el enlace a un borrador vacío. El recuento de personas **degrada**
  (viaja `recuento_fallido`) para que se siga ordenando solo por fecha, como hacía su `catch`.
- **Con UN solo candidato abierto no se piden las personas**, igual que antes: son las mismas
  lecturas que hacía el oro, ni una más.
- **Auth: solo `service_token`, y se dice así.** Aquí no hay `resume_token` del que derivar nada
  (KAL-4) porque el expediente **todavía no existe**. El alcance lo acota la FORMA de la entrada —un
  correo, seis campos—, igual que en `enr.wizardReconocerFamilia`. Acotar por cliente es `②18`.

**Recuento, con la forma de repetirlo** (`grep -c 'appsheetRequest_('` **menos 1**, la definición):
**69 → 66** sueltas; las de lote se quedan en **4**. En este manejador: **3 → 0**.

**Control**: `scripts/verja-publica.mjs` gana `comprobarLaEntradaDeLaSolicitud` — el manejador no
vuelve a leer `enrEnrollmentGroups` ni `enrPersons` · **sí** le pide los expedientes al KMS por el
ayudante único · el ayudante existe y pregunta a la entrada declarada · y **dos anclas**: que el
manejador siga existiendo y que **siga decidiendo la sesión única**, para que el control no pueda
salir verde afirmando ausencias sobre un manejador vaciado. **Rojo demostrado SIETE veces**, cada
una nombrando su caso (dos de ellas dejando el control **CIEGO** a propósito).

⚠️ **La batería NO cubre esto** — corre contra un backend simulado que **nunca ejecuta
`backend/Code.js`**. El lado del KMS tampoco lo cubre ningún control, así que se **midió aparte**:
**20 afirmaciones** sobre el manejador real extraído del fuente y ejecutado con dobles,
**demostradas no ciegas** con seis roturas (ensanchar la proyección a la fila entera · el recuento
caído dejando de degradar · disfrazar de «no hay ninguno» **cada una** de las dos lecturas · quitar
el cinturón del recuento · renombrar el manejador → *«medición CIEGA»*). **Y la medición se corrigió
a sí misma dos veces:** su doble del validador de correo era **más estricto que el real** —el real
acepta comillas, que es justo por lo que existe el escape de capa 2— y su afirmación de fallo
cerrado se satisfacía con que lanzara **una** de las dos lecturas, dejando pasar que la otra se
disfrazara. **Quien toque este manejador, que lo mida.**

### ②17 (2026-08-15) — la IDENTIDAD DE QUIEN RECUPERA: había DOS resolvedores del mismo dato, y ya habían divergido

**La cadena que decide de quién es un correo —o el identificador opaco `n` de un enlace— hacía
hasta CINCO consultas a AppSheet** desde este proceso, que es público y anónimo, con la credencial
de la aplicación entera:

| Quién | Qué leía |
|---|---|
| `resolveGuardianForRecovery_` | las **personas** del expediente (la **ficha COMPLETA de cada una —MENORES INCLUIDOS**: nombre, fecha de nacimiento, documento— **solo para saber quién es tutor**), sus **correos**, y hasta **DOS veces** la cabecera (sub-casos A y B, cada uno con su propio `Find`) |
| `resolveEmailFromLinkParam_` | la fila del `n`, **leída por su clave y SIN acotar al expediente**, para rechazarla después |
| `findEmailIdForGuardian_` | otra pasada por los correos, para el `n` que se mete en el enlace |

**Ahora lo contesta el KMS en UNA pregunta** —`enr.wizardTutorQueRecupera`
(`kis-app kms-server/enr/wizard-gateway.gs`)— y la consume **UN SOLO ayudante**,
`_tutorQueRecupera_`. La respuesta son **tres campos**: identificador de persona, correo
normalizado e identificador opaco de correo. **De las personas no sale ni un campo.**

**Lo que hay que retener al tocar esto:**

- **LA PRECEDENCIA NO SE MOVIÓ.** `n` del enlace > correo que manda el cliente > respaldo «el
  tutor 1», y su **modo estricto** para atribuir una firma (`sinRespaldo`, ②24.bis): todo sigue
  **aquí, verbatim**, en `effectiveRecoveredEmail_` / `_identidadDelEnlace_`. Por eso la entrada
  acepta **uno y solo uno** de los dos discriminadores y nunca elige por el llamante.
- **Las GUARDAS sí viajaron, porque son inseparables de su lectura** (mismo criterio que
  `enr.wizardComprobarSubida` y que la guarda del tutor del octavo tramo): que la fila del `n`
  **pertenezca al expediente** ya no se comprueba *después* de bajarla — **se busca solo dentro del
  expediente**, así que una fila de otra familia no llega a existir para este proceso. Es **más
  estricto que el oro** y da el mismo resultado observable.
- **⚠️ Y CERRÓ UNA DIVERGENCIA REAL — la que los dos JSDoc anunciaban.** Ambos resolvedores decían
  que **DEBÍAN permanecer idénticos «hasta consolidación P245»**, y **ya no lo eran**: el de aquí
  descartaba a quien la familia había quitado con la bandera `is_active` en falso (arreglo del
  2026-08-09) y **el del KMS solo miraba `deleted_at`** — y siete de las tablas de admisión aún no
  lo tienen, así que su única vía de retirada hoy **es esa bandera**. Resultado: el KMS podía
  devolver como tutor a **alguien que la familia ya había quitado**. El resolvedor único usa ahora
  `sys_rowIsActiveLiveOptionalFlag_`, el gemelo declarado de `wizardFilaViva_`.
- **LANZA si no se puede preguntar, y es el criterio del oro**: las lecturas que sustituye **no
  estaban envueltas en `try`**. Decir «no es tutor» cuando en realidad no se pudo consultar dejaría
  a una familia sin firmar, sin ver su documento o sin recibir su enlace. Los llamantes que ya
  degradaban lo siguen haciendo en SU `try/catch` de siempre.
- **En `sendMagicLink_` la pregunta va ANTES de renovar el token**, y no es un detalle de orden: la
  renovación **rota** el token, y el viejo deja de resolver ⇒ preguntar después dejaría sin `n` el
  enlace de **toda** familia con borrador.
- **`email_id` NO depende del tutor, a propósito**: `findEmailIdForGuardian_` casaba **por el valor
  del correo y nada más**. Se copió verbatim, así que sigue habiendo `n` para correos que no
  resuelven a tutor — cambiarlo dejaría sin `n` a enlaces que hoy lo llevan.
- **Memoria de EJECUCIÓN, no de 300 s**: la cadena resuelve dos veces lo mismo en la misma petición
  (el `n` primero, su correo después). Se recuerda **solo mientras dura la ejecución** ⇒ cero riesgo
  de servir una identidad vieja. **No se toca la distinción de las dos memorias de ②24.bis**
  (`idlinkd_` / `idlinkr_`): esa clave lleva el MODO, y compartirla las contamina.

**Retirados enteros**, por ser segundos lectores del mismo dato: el **gemelo** de
`resolveGuardianForRecovery_` (127 líneas) · **`findEmailIdForGuardian_`** (su respuesta viene ya
con la misma pregunta) · y **`manual_testRecoveryPerGuardian`**, que estaba **ROTA desde el quinto
tramo** (llamaba a `resumeSession_`, **0 definiciones** en el proyecto ⇒ lanzaba antes de decir
nada). Los otros cinco diagnósticos de editor se reconectaron al camino vivo: entran por el
`resume_token`, que leen de la cabecera.

**Recuento, con la forma de repetirlo** (`grep -c 'appsheetRequest_('` **menos 1**, la definición;
ídem `appsheetRequestBatch_`): **64 → 58** sueltas y **2 → 1** en lote. Y lo que de verdad importa:
**el camino vivo baja de 27 a 19** —las otras 40 son de editor, no alcanzables desde internet—.

**Control**: `scripts/verja-publica.mjs` gana `comprobarLaIdentidadDeQuienRecupera` — los tres
eslabones no vuelven a leer personas / correos / cabecera de AppSheet · los tres pasan por el lector
único · el ayudante pregunta a la entrada declarada · **ni el gemelo con hints ni
`findEmailIdForGuardian_` reaparecen** · y **dos anclas**: los eslabones siguen existiendo y
`effectiveRecoveredEmail_` sigue distinguiendo el modo declarado, para que el control no salga verde
sobre una cadena vaciada o renombrada. **Rojo demostrado SIETE veces**, cada una nombrando su caso
(dos dejando el control **CIEGO**).

⚠️ **La batería NO cubre esto** — corre contra un backend simulado que **nunca ejecuta
`backend/Code.js`**. El lado del KMS tampoco lo cubre ningún control, así que se **midió aparte**:
**23 afirmaciones** sobre los manejadores reales extraídos del fuente y ejecutados con dobles,
**demostradas no ciegas** con **siete roturas** (ensanchar la proyección a la ficha entera · aceptar
el expediente del cuerpo · degradar la lectura caída a «no es tutor» · volver al criterio viejo
`!deleted_at` —que es la divergencia medida— · creerse un `n` que no es del expediente · quitar la
declaración pública de la ruta · renombrar el manejador → *«MEDICIÓN CIEGA»*). **Y la medición se
corrigió a sí misma:** la rotura del `n` ajeno salió **VERDE** al primer intento —era la ROTURA la
que era débil, no la afirmación— y hubo que hacerla realista para que mordiera.
**Quien toque esta cadena, que lo mida.**

### ②17 (2026-08-15) — QUIÉN PUEDE CONTESTAR: la ficha de cada persona bajaba entera para quedarse con un id

**`saveResponses_` bajaba la ficha COMPLETA de cada persona del expediente —MENORES INCLUIDOS:
nombre, fecha de nacimiento, documento— a este proceso, que es público y anónimo, SOLO para armar un
conjunto de identificadores** y comprobar que cada `respondent_id` es del expediente del token.

**Ahora los sirve el KMS proyectados a ids**, `enr.wizardRespondentesAutorizados`
(`kis-app kms-server/enr/wizard-gateway.gs`), y los consume **UN SOLO ayudante**,
`_respondentesAutorizados_`. La respuesta es `{ok, ids}` y **nada más**: de las personas no sale ni un
campo, y de qué tabla es cada sujeto **se queda dentro del KMS** (lo necesita el escritor, no esto).

**⚠️ Y CERRÓ UNA DIVERGENCIA MEDIDA — es la mitad del valor del tramo.** El conjunto se armaba aquí
con **OTRO criterio** que el del escritor (`enr_persistResponses_`, quien de verdad decide qué se
guarda):

| | el asistente autorizaba | el escritor autoriza |
|---|---|---|
| tablas | **solo `enrPersons`** | el propio expediente **+ `enrPersons` + `enrEnrollments`** |
| fila viva | `!deleted_at` **y** `is_active !== false` | **solo** `!deleted_at` |

⇒ el asistente rechazaba con `UNAUTHORIZED` respuestas que el KMS **sí habría guardado**. Y
`UNAUTHORIZED` **no está declarado en `RECHAZOS_DEFINITIVOS`** (`frontend/src/lib/rechazos.js`), así
que la cola **lo reintentaba para siempre**: el cuestionario de esa familia en un bucle que no podía
pasar nunca. Hoy hay **UN solo recorrido**, `enr_respondentesAutorizados_`, y es el del escritor.

**Lo que hay que retener al tocar esto:**

- **LA COMPROBACIÓN NO SE MOVIÓ.** La validación de forma (`assertValidUuid_`, KAL-5 capa 1) y el
  rechazo con `UNAUTHORIZED` siguen **enteros y verbatim aquí**. Cambia de dónde salen los
  identificadores, **no qué se hace con ellos** — y el control lo vigila con un ancla.
- **El expediente sale del `resume_token`** (KAL-4) y el nombre de la tabla **no viaja**. La puerta
  del KMS aplica el mismo plazo de 7 días y el mismo rechazo de sesión abandonada que
  `requireResumeToken_`, que además ya corrió antes aquí.
- **El orden se conserva**: token → código de un solo uso (`assertStepUpFresh_`, ②27) → la pregunta al
  KMS → apuntar el trabajo. **Y si no hay respondents distintos del expediente, NO se pregunta** —ni
  una llamada de más, igual que antes no había ni una lectura.
- **FALLA CERRADO: lanza.** La lectura que sustituye lanzaba (`appsheetRequest_` lanza siempre y ahí
  no había `try`). Un conjunto vacío rechazaría a **TODA** familia con un `UNAUTHORIZED` falso.
- **⚠️ El criterio del escritor sigue siendo `!deleted_at` a secas, y es deliberado.** Apretarlo a
  `sys_rowIsActiveLiveOptionalFlag_` **cambiaría qué se escribe** (dejaría de guardarse la respuesta
  de un sujeto retirado solo por la bandera) — otra decisión, con su propia medición. Lo que este
  tramo cierra es que hubiera **DOS** criterios; ahora se aprieta **en una línea**.
- **Lo que este tramo NO cierra, y se dice:** un `respondent_id` genuinamente ajeno **sigue** dando
  `UNAUTHORIZED`, que **sigue sin estar** en `RECHAZOS_DEFINITIVOS` ⇒ ese caso se reintentaría igual.
  No es alcanzable desde una pantalla legítima (la hidratación no enseña a nadie de otra familia), y
  declararlo toca la lista que gobierna **todas** las escrituras: se decide aparte, midiendo.

**Recuento, con la forma de repetirlo** (`grep -c 'appsheetRequest_('` **menos 1**, la definición;
ídem `appsheetRequestBatch_`): **58 → 57** sueltas, **1** en lote sin cambio. Y el camino vivo:
**19 → 18**; en este manejador, **1 → 0**.

**Control**: `scripts/verja-publica.mjs` gana `comprobarLasRespuestas` — el manejador no vuelve a leer
`enrPersons` de AppSheet · **sí** pregunta al KMS por el ayudante único · el ayudante existe y
pregunta a la ruta declarada · y **TRES anclas**: sigue derivando el expediente del token, sigue
exigiendo el código de un solo uso y sigue rechazando con `UNAUTHORIZED`, para que el control no
pueda salir verde sobre un manejador vaciado. **Rojo demostrado SIETE veces**, cada una nombrando su
caso (la del renombrado deja el control **CIEGO**).

⚠️ **La batería NO cubre esto** — corre contra un backend simulado que **nunca ejecuta
`backend/Code.js`**. El lado del KMS tampoco lo cubre ningún control, así que se **midió aparte**:
**21 afirmaciones** sobre los dos trozos reales extraídos del fuente y ejecutados con dobles,
**demostradas no ciegas** con **ocho roturas** (ensanchar la proyección a la ficha entera · aceptar el
expediente del cuerpo · degradar la lectura caída a conjunto vacío · volver al criterio viejo del
asistente · quitar el filtro por expediente · que el escritor vuelva a armar el conjunto por su cuenta
· quitar la declaración pública de la ruta · renombrar el manejador → *«medición CIEGA»*). **Y la
medición se corrigió a sí misma:** su afirmación de «el escritor no vuelve a leer por su cuenta» era
demasiado tosca — el escritor tiene **otra** lectura legítima de `enrPersons`, la que resuelve el
iniciador de la sesión — y hubo que acotarla al recorrido real. **Quien toque este manejador, que lo
mida.**

### ②17 (2026-08-16) — las ETIQUETAS de los documentos: el envío queda a CERO lecturas, y el guarda del reintento llevaba un día roto

**Eran las DOS ÚLTIMAS lecturas directas a AppSheet del camino del envío**, y enganchaban los
documentos que la familia sube en el paso 6 —cuando todavía no existe ningún expediente de alumno—
a los expedientes que acaban de nacer:

| Qué leía | Qué pasaba |
|---|---|
| `recFiles` por `school_id` + `origin='WIZARD'` + `origin_reference = <el grupo>` | los documentos del paso 6 |
| `recScopes` por `file_id` + `scope_type_code` | el guarda del reintento — **UNA CONSULTA POR FICHERO** |

Las hacía **este** proceso, que es público y anónimo, con la credencial de AppSheet de la
aplicación entera. **Ahora las etiquetas las compone el KMS**, en el mismo manejador que ya las
escribía (`enr.wizardPersistSubmitSideEffects` → `enr_ambitosDelEnvio_`,
`kis-app kms-server/enr/wizard-gateway.gs`), que ya tiene todo lo que hace falta: el grupo derivado
del `resume_token` por su propia puerta (KAL-4) y los expedientes que él mismo acaba de
materializar. **El asistente ya no manda `rec_scopes`.**

⚠️ **Y LA PREMISA QUE BLOQUEÓ ESTE TRAMO CUATRO VUELTAS ERA FALSA.** Decía —aquí y en el JSDoc del
KMS— que no se podía mover *«porque lleva dentro el literal `enr_admission_school` y DL-E48 prohíbe
escribir a mano el tipo de expediente»*. **`enr_admission_school` en MINÚSCULAS no es un tipo de
expediente**: es un `scope_type_code` de `recScopes`. El tipo de expediente es
`ENR_ADMISSION_SCHOOL`, en mayúsculas y contra `sysEntityTypes`, y **no aparecía en ese trozo**. Es
el precedente exacto de §"Un COMENTARIO del código no es criterio normativo" (`kis-app/CLAUDE.md`):
un comentario no cierra una pregunta de diseño, y éste aplazó trabajo cuatro veces.

⚠️ **Y EL GUARDA DEL REINTENTO ESTABA ROTO desde D78 (2026-08-15), un día.** Filtraba
`scope_type_code = 'enr_admission_school'` — un ámbito **RETIRADO** (`is_deprecated: true` en
`kis-app kms-server/config/rec-scope-type-templates.html`) —, mientras que el KMS escribe en ese
campo el **TEMA** del documento (`rec_temaPrincipalDelFichero_`, DL-R16) y dice de quién es con el
par canónico `(scope_entity_type_code, scope_target_id)`. ⇒ **el guarda no casaba NUNCA**, y un
reenvío —el caso normal cuando el colegio pide corregir algo— **duplicaba las etiquetas de todos
los documentos de la familia**. Hoy se pregunta lo que el guarda siempre quiso preguntar, en el
vocabulario de hoy: **¿este documento ya está enganchado a un expediente de este grupo?** — que es
exactamente el recorrido de `enr_getDocuments` (`enr/milestones.gs`), el lector canónico.

**Lo que hay que retener al tocar esto:**

- **EL CRITERIO NO SE MOVIÓ.** El filtro de los ficheros va **verbatim**, y `is_primary` lo sigue
  llevando **la primera ficha de alumno y solo ella** — con el **orden de los ALUMNOS declarados**,
  el mismo con el que `enr_persistSubmit_` construye `enrollment_ids`. Por eso el compositor recorre
  `enrPersons` → `applicant` → su expediente, en vez de leer `enrEnrollments` y fiarse del orden en
  que AppSheet devuelva las filas.
- **DEGRADA, no lanza, y es deliberado.** Se llega aquí con el envío **YA materializado** y
  `submitted_at` estampado: lanzar dejaría a la familia con la solicitud a medias y su reintento
  chocando contra `NOT_EDITABLE` — el atasco que el bloque W1 documenta. El asistente lo tenía en un
  `try` con «non-fatal» y **se conserva igual**. Lo peor que pasa es que los documentos queden sin
  enganchar y el reenvío lo arregle.
- **Menos viajes, no más**: el guarda costaba **una consulta por fichero**; ahora es **una sola**
  lectura de etiquetas por envío.
- **Las que lleguen en el cuerpo se IGNORAN, contadas y con ruido** (`rec_scopes_ignored`), igual
  que las anotaciones de situación de D33 — y **se les sigue exigiendo pertenencia** aunque no se
  escriban: un intento de colar el documento o el expediente de otra familia por una ruta pública es
  justo lo que hay que poder ver. Medido: el **ÚNICO** llamante vivo de esa ruta en los dos
  repositorios es este manejador, que en el mismo cambio deja de mandarlas.

**Recuento, con la forma de repetirlo** (`grep -c 'appsheetRequest_('` **menos 1**, la definición;
ídem `appsheetRequestBatch_`): **57 → 55** sueltas, **1** en lote sin cambio. El camino vivo:
**18 → 16**; en este manejador, **2 → 0**.

**Control**: `scripts/verja-publica.mjs` gana `comprobarLasEtiquetasDelEnvio` — el manejador no
vuelve a leer `recFiles`/`recScopes` · ya no manda `rec_scopes` · el ámbito retirado no reaparece
escrito a mano · y **DOS anclas**: sigue llamando a `enr.wizardPersistSubmitSideEffects` y sigue
mandándole los consentimientos, para que el control no salga verde sobre un manejador vaciado.
**Rojo demostrado SIETE veces**, cada una nombrando su caso (la del renombrado deja el control
**CIEGO**). **Y el control se corrigió a sí mismo:** el ancla de los consentimientos era
`/consents\s*:/` y casaba el `?:` de `Array.isArray(p.consents) ? p.consents : []` ⇒ **salía VERDE
con el ancla rota**; se acotó a la llamada real.

⚠️ **La batería NO cubre esto** — corre contra un backend simulado que **nunca ejecuta
`backend/Code.js`**. El lado del KMS tampoco lo cubre ningún control, así que se **midió aparte**:
**21 afirmaciones**, y la de más peso es que **ejecuta el bloque de ORO retirado y el compositor
nuevo sobre LOS MISMOS datos y compara** — ternas idénticas y en el mismo orden cuando no hay
etiquetas previas, y la **divergencia acreditada** cuando sí las hay (el oro no saltaba). **No
ciega, demostrado con siete roturas**: quitar el guarda · `is_primary` en todas · relanzar en vez de
degradar · volver al criterio viejo del ámbito retirado · invertir el orden · tomar el grupo del
cuerpo en vez del token · renombrar el compositor → *«MEDICIÓN CIEGA»*. **Y la medición se corrigió
a sí misma dos veces:** la rotura del orden **no se aplicaba** (era la rotura la que era débil, no
la afirmación) y la del renombrado **reventaba** en vez de declararse ciega. **Quien toque este
compositor, que lo mida.**

### ②17 (2026-08-16) — LA PUERTA: la lectura más llamada del asistente, y la que se hacía DOS VECES en la misma petición

**Eran CUATRO funciones repitiendo la MISMA lectura directa de `enrEnrollmentGroups`** —filtrada por
`resume_token`, o por el identificador que ese token acababa de autorizar— desde este proceso, que es
**público y anónimo**, con la credencial de AppSheet de la aplicación entera:

| Quién | Qué era |
|---|---|
| `requireResumeToken_` | **el gate de TODA mutación**, y la lectura **más llamada** del asistente |
| `assertGroupEditable_` | la **SEGUNDA lectura de la MISMA fila en la MISMA petición** |
| `abandonSession_` | «empezar de nuevo» |
| `reportUnsolicited_` | «esto no es mío» |

Cruzaba la **fila ENTERA**, con **`magic_link_token`** —un secreto de portador— dentro, más
`school_id`, `program_id`, `source_id`, `source_locale`, `preferred_language` y el bloque de
auditoría. **Ahora la sirve el KMS** por `enr.wizardExpedienteDelToken` —la entrada del sexto tramo,
**ampliada, no duplicada**— proyectada a **SIETE campos** (los cinco de antes más `abandoned_at` y
`created_at`, ninguno dato personal) y por el lector **ÚNICO** `_expedienteDelToken_`.

**Y la segunda lectura DESAPARECE, no se migra.** Se midió antes de tocar nada, contra
`origin/main`: los **CINCO** llamantes de `assertGroupEditable_` van **inmediatamente precedidos** de
`requireResumeToken_` (`saveStep_` `:4093/:4103` · `submitEnrollmentSession_` `:4216/:4226` ·
`saveResponses_` `:5389/:5391` · `uploadDocument_` `:5710/:5716` · `saveNeae_` `:6336/:6341`) ⇒ la
puerta deja la fila en una **memoria de EJECUCIÓN** (`_memoCabeceraEjecucion_`) y
`assertGroupEditable_` la lee de ahí. **No es caché** —muere con la petición, cero riesgo de servir
una fila vieja— y **no es un segundo resolvedor**: es esa misma fila, ya autorizada por el token.

**Lo que hay que retener al tocar esto:**

- **LA DECISIÓN NO SE MOVIÓ.** Los rechazos con sus **mensajes EXACTOS** (`resume_token abandoned`,
  el de caducidad que arregló `①22`), el TTL de 7 días desde `created_at`, la exención de los
  `submitted`, el memo de lectura `rtmemo_`, el **cross-group guard** y el **acuse silencioso
  anti-enumeración** de `reportUnsolicited_` siguen **aquí, verbatim**. Cambia **de dónde sale la
  fila**, no qué se hace con ella — y el control lo vigila con cuatro anclas.
- **Eso obligó al MODO TOLERANTE, y está ACOTADO Y DECLARADO.** `tolerar_sesion_cerrada` hace que la
  puerta del KMS acepte el token caducado o abandonado **y devuelva la fila**, para que el asistente
  aplique SUS rechazos. Ensancha **SOLO qué token se acepta**, JAMÁS **qué expediente** (sigue
  saliendo del token, KAL-4), sigue exigiendo el `service_token`, y un token **inexistente se
  rechaza SIEMPRE**. **No es capacidad nueva**: `enr.wizardAbandonSession` ya acepta hoy esos mismos
  tokens por la misma vía pública. Sin la bandera, los **tres llamantes del sexto tramo quedan
  byte-idénticos**. Si la puerta del KMS rechazara antes, `requireResumeToken_` no podría distinguir
  «caducado» de «no existe» y la familia con la solicitud caducada leería el mensaje equivocado.
- **⛔ `assertGroupEditable_` FALLA CERRADO con el `NOT_FOUND` de siempre si la memoria no está, y
  NUNCA vuelve a leer por identificador** —ni de AppSheet ni del KMS—: ahí el id llega como
  **argumento**, así que un lector por id sería una puerta trasera a KAL-4.
- **Los dos fallos NO pesan igual**, y el lector único gana un **tercer estado** para distinguirlos:
  «el KMS **contestó** que ese token no vale» (`rechazo`) ⇒ el rechazo propio del manejador; «**no se
  pudo preguntar**» (transporte) ⇒ **lanza `KMS_UNREACHABLE`**, nunca «tu enlace no vale». Decirle
  eso a una familia legítima porque el KMS está caído es peor que el fallo. **`ok` no cambió de
  valor** al añadirse `rechazo`, así que los tres llamantes del sexto tramo no ven diferencia.
  `reportUnsolicited_` da su acuse silencioso en los dos casos, como ya hacía por su `catch`.

⚠️ **Y una premisa del encargo era FALSA, medida:** decía que la lectura de `sendVerificationCode_`
(`:4799`) filtra por un identificador **«que viene en el cuerpo (rama de alta)»**. **No.** Está en la
rama **step-up**, y el identificador lo deriva `_resolveStepUpGroup_` **del bearer**. **Aun así NO
entra**, por un motivo distinto: es el respaldo del respaldo y **solo se alcanza cuando NO hay
`resume_token`** (camino de `signing_token`, `frontend/src/pages/steps/signingCommon.js:49`) — ahí no
hay token del que derivar la cabecera ni memoria que reusar, así que quitarla dejaría a esa familia
con `BAD_REQUEST` en lugar de su código.

**Recuento, con la forma de repetirlo** (`grep -c 'appsheetRequest_('` **menos 1**, la definición;
ídem `appsheetRequestBatch_`): **55 → 51** sueltas, **1** en lote sin cambio. El camino vivo:
**16 → 12**.

**Control**: `scripts/verja-publica.mjs` gana `comprobarLaPuerta` — las cuatro no vuelven a leer
`enrEnrollmentGroups` · las tres con token pasan por el lector único **y en modo tolerante** ·
`assertGroupEditable_` no consulta por identificador y lee la memoria · la puerta la rellena · y
**CUATRO anclas** (la puerta existe, valida la forma del token, aplica el TTL y conserva el
cross-group guard) para que «ya no lee AppSheet» no salga verde sobre un gate vaciado. **Rojo
demostrado NUEVE veces**, cada una nombrando su caso (la del renombrado deja el control **CIEGO**).

⚠️ **La batería NO cubre esto** — corre contra un backend simulado que **nunca ejecuta
`backend/Code.js`**. El lado del KMS tampoco lo cubre ningún control, así que se **midió aparte**:
**14 afirmaciones** sobre el manejador real extraído del fuente y ejecutado con dobles,
**demostradas no ciegas** con **seis roturas** (ensanchar la proyección · tomar el expediente del
cuerpo · quitarle el `service_token` al modo tolerante · tolerar siempre · aceptar el token
inexistente · renombrar el manejador → *«MEDICIÓN CIEGA»*). **Quien toque esta puerta, que lo mida.**

### ②17 (2026-08-19) — la cabecera se pedía DOS VECES por petición: la memoria estaba, y nadie la encontraba

**No es un tramo de migración: es la memoria del duodécimo, que solo se indexaba por una clave
que su único lector no tiene.** Medido en el registro real del asistente ya desplegado, con cada
pregunta al KMS costando **13-31 s**:

| Camino | Viajes a `enr.wizardExpedienteDelToken` |
|---|---|
| `hydrateSession` | t+410 ms (16,3 s) **y** t+43,3 s (18,1 s) |
| `warmBundle` | t+878 ms **y** t+26,3 s |
| `warmSession` | t+866 ms **y** t+19,5 s |

La primera es **la puerta** (`requireResumeToken_`); la segunda, el punto que necesita la cabecera
(`:8215`/`:8246`/`:8046`). **La misma fila, del mismo token, en la misma ejecución.** La memoria de
EJECUCIÓN `_memoCabeceraEjecucion_` ya existía —la escribe la puerta— pero **se indexaba por
identificador de expediente**, y `_expedienteDelToken_` recibe un **TOKEN** ⇒ no la encontraba nunca.
Ahora la consulta antes de salir al KMS. **Medido ejecutando las funciones reales con dobles:
2 → 1 viaje** en los tres caminos (la mutación ya estaba en 1).

**Lo que hay que retener al tocar esto:**

- **⛔ LA CLAVE LLEVA LA MODALIDAD DENTRO** (`_memoCabeceraClave_`, `tok:<token>|estricto` ·
  `|tolerarSesionCerrada`). La **fila** que devuelve el KMS es idéntica en los dos modos: lo que
  cambia es **qué token se acepta**. Sin la modalidad en la clave, una cabecera obtenida **con**
  tolerancia —la que se llevan `abandonSession_` y `reportUnsolicited_`, que operan a propósito
  sobre sesiones cerradas— se le serviría a un llamante estricto, y ese llamante **dejaría de
  rechazar un enlace caducado o abandonado**. Comprobado ejecutándolo: el estricto vuelve a
  preguntar.
- **La puerta archiva su fila bajo la clave ESTRICTA, y eso se demuestra, no se supone.** La pidió
  en modo tolerante, pero justo ahí acaban de aplicarse los **tres** rechazos —token que no resuelve
  · sesión abandonada · caducada a los 7 días salvo enviada— que son **verbatim** los tres de la
  puerta estricta del KMS (`enr_resolveWizardSession_`, del que ese gate es espejo declarado).
  **Si algún día se afloja uno de los tres, esa línea deja de ser cierta y se quita.**
- **⛔ La rama que ROTA el enlace la OLVIDA** (`_olvidarCabeceraMemo_`, tras
  `enr.wizardTouchSession` en las dos ramas de `sendMagicLink_`): la ficha guardada lleva dentro el
  `resume_token` **viejo**, que a partir de ahí ya no resuelve. Hoy nadie la leería después de rotar
  —es una barandilla para el camino futuro—, y se dice así.
- **Sigue siendo memoria de EJECUCIÓN, no caché**: muere con la petición, no tiene plazo, y no puede
  servir la fila de otra. **Solo se guarda el acierto** — un rechazo o una avería no se memorizan.
- **`assertGroupEditable_` no cambia**: sigue leyendo por identificador de expediente y sigue
  fallando cerrado con `NOT_FOUND` si no está (comprobado ejecutándolo).

**Control**: `scripts/verja-publica.mjs` gana cuatro afirmaciones dentro de `comprobarLaPuerta` —la
clave lleva la modalidad · `_expedienteDelToken_` consulta la memoria por su clave · la puerta la
indexa también por token · la rama que rota la olvida—. **Rojo demostrado las cuatro**, cada una
nombrando su caso.

⚠️ **La batería NO cubre esto** — corre contra un backend simulado que **nunca ejecuta
`backend/Code.js`**. Se **midió aparte**, ejecutando `requireResumeToken_`,
`_expedienteDelToken_`, `_memoCabeceraClave_`, `_olvidarCabeceraMemo_` y `assertGroupEditable_`
extraídos del fuente y corridos con dobles: **antes 2/2/2/1 viajes, después 1/1/1/1**, más las tres
afirmaciones de seguridad de arriba. **Quien toque esta memoria, que lo mida.**

### ②17 (2026-08-16) — EL PULSO: la acción más llamada mientras la familia espera, y bajaba el catálogo de situaciones ENTERO

**`getAdmissionState_` es una acción PÚBLICA del despachador anónimo**, y el cliente la dispara
**repetidamente** mientras la familia mira la pantalla. Hacía TRES lecturas directas a AppSheet en un
lote, con la credencial de la aplicación entera:

| Qué leía | Para qué, de verdad |
|---|---|
| `enrEnrollments` del expediente | **UN campo**: `current_state_id`. Cruzaba la fila entera |
| `enrPersons` del expediente | **la ficha COMPLETA de cada persona —MENORES INCLUIDOS**: nombre, fecha de nacimiento, documento— **solo para CONTAR tutores**, y solo cuando hay varios firmantes pendientes |
| `sysStates_T` **SIN FILTRO** | el **catálogo de situaciones ENTERO**, de todas las máquinas de estados de todos los colegios, para quedarse con las de una |

Y su respaldo, `buildAdmissionContext_`, **releía el catálogo por su cuenta** cuando el llamante no
se lo pasaba. **Ahora lo sirve el KMS en UNA pregunta** —`enr.wizardEstadoDeLaAdmision`
(`kis-app kms-server/enr/wizard-gateway.gs`)— y lo consume **UN SOLO ayudante**,
`_pulsoDeLaAdmision_`, con memoria de EJECUCIÓN. De los expedientes sale **un campo**, de las
personas **dos** y del catálogo **cuatro**.

**Lo que hay que retener al tocar esto:**

- **LA DECISIÓN NO SE MOVIÓ.** Elegir la situación **menos avanzada por `display_order`**,
  `derivarPantallaAdmision_` (las tres derivaciones de pantalla que DL-E41 ★ACOTACIÓN dejó a
  propósito de este lado), las Vías 1 y 2 del contexto de firma, `resolveSigningStatus_`, la memoria
  `wz_adm_`, la gracia del enlace y la frescura del código de un solo uso: **todo sigue aquí**.
  Cambia **de dónde salen las filas**, no qué se hace con ellas — y el control lo vigila con tres
  anclas.
- **El FILTRO del catálogo VIAJA con su lectura; la ELECCIÓN no.** Qué filas *son* el catálogo de
  este expediente (colegio + máquina declarada + no borradas) es inseparable de la lectura, igual
  que la guarda del tutor de la recuperación y que las dos comprobaciones de la subida.
- **⛔ Y con ese filtro SALE EL LITERAL DEL DOMINIO de este camino.** El oro comparaba
  `entity_type_code === 'ENR_ADMISSION_SCHOOL'` a mano — justo lo que DL-E48 prohíbe. Hoy el dominio
  lo resuelve el KMS por su cadena declarada (`program_id → enrPrograms → enrProgramTypes`) y **sin
  respaldo silencioso**: si el colegio no lo declara, `DOMAIN_NOT_DECLARED` nombrando el eslabón que
  falta. Observable: el pulso da error en lugar de enseñar la situación de un campamento leída de la
  máquina de admisión escolar. ⚠️ **NO era el último del fichero**: quedaban **CUATRO** ejecutables,
  y las **tres del racimo de hitos y firma** salieron en el decimocuarto tramo (§"②17 — EL RACIMO DE
  FIRMA"). **Re-medido el 2026-08-16 queda UNA**: `submitEnrollmentSession_:4676`.
- **⚠️ FALLA CERRADO, y esto CORRIGE el oro.** `appsheetRequestBatch_` **nunca lanza** (devuelve
  `{ok}` por elemento) ⇒ un fallo de AppSheet dejaba `enrollments = []` y `buildAdmissionContext_`
  retornaba en su primera línea con **`editable: true`** y `state_code` vacío: el servidor afirmando
  que la solicitud de una familia que **ya envió** se puede editar. *(Medido en el cliente: ese
  `editable:true` **no** llega a desbloquear la pantalla, porque `WizardContext.jsx:1310` solo lo
  aplica `if (data.state_code)`; lo que la familia **sí** observa es que la situación real de su
  expediente y el puente a la firma **desaparecen en silencio**.)* Hoy lanza — y el cliente ya sabe
  tratarlo: `.catch` + no avanza la versión ⇒ reintenta al tick siguiente **conservando lo que
  tenía**.
- **Las personas llegan YA filtradas** a quien sigue en la solicitud (el KMS aplica
  `sys_rowIsActiveLiveOptionalFlag_`, el gemelo declarado de `wizardSoloVivas_`), así que aquí ya no
  se cuela ese colador: llegan dos campos, no fichas.
- **El diagnóstico de editor `manual_diagWizardSigningGate` le pasa el `resume_token`** que lee de la
  cabecera. Sin él, `buildAdmissionContext_` falla cerrado — que es lo correcto: un catálogo que no
  se pudo leer no puede pasar por «no hay situación».

**Recuento, con la forma de repetirlo** (`grep -c 'appsheetRequest_('` **menos 1**, la definición;
ídem `appsheetRequestBatch_`): **51 → 50** sueltas y **1 → 0** en lote. El camino vivo: **12 → 10**;
en estos dos, **4 consultas → 0**.

**Control**: `scripts/verja-publica.mjs` gana `comprobarElPulsoDeLaAdmision` — los dos no vuelven a
leer `enrEnrollments`/`enrPersons`/`sysStates_T` · los dos pasan por el lector único · el ayudante
pregunta a la ruta declarada · el literal del dominio no reaparece · y **TRES anclas** (el expediente
sigue saliendo del token, la frescura del código de un solo uso sigue computándose, y la situación se
sigue eligiendo por `display_order`). **Rojo demostrado NUEVE veces**, cada una nombrando su caso (la
del renombrado deja el control **CIEGO**).

⚠️ **La batería NO cubre esto** — corre contra un backend simulado que **nunca ejecuta
`backend/Code.js`**. El lado del KMS tampoco lo cubre ningún control, así que se **midió aparte**:
**18 afirmaciones** sobre el manejador real extraído del fuente y ejecutado con dobles,
**demostradas no ciegas** con **cinco roturas** (ensanchar la proyección a la ficha entera · tomar el
expediente del cuerpo · disfrazar de «no hay» un fallo de lectura · quitar la declaración pública de
la ruta · renombrar el manejador → *«MEDICIÓN CIEGA»*). **Y la medición se corrigió a sí misma:** la
rotura del expediente tomado del cuerpo salió **VERDE** al primer intento —la afirmación miraba solo
la LONGITUD de la lista y el juego de pruebas tiene una fila por grupo—, y hubo que acotarla a **qué
fila** vuelve. **Quien toque este manejador, que lo mida.**

**Lo que apareció de paso, y se RETIRÓ en la vuelta siguiente:** `appsheetRequestBatch_` se quedó
**sin ni un llamante** (éste era su último). Aquí no se tocó —quitarlo obligaba a mirar tres
controles de seguridad, en un cambio que no iba de eso— y quedó anotado. **Se retiró entero el
2026-08-16**: ver §"②17 — el transporte en LOTE se RETIRA".

### ②17 (2026-08-16) — EL RACIMO DE FIRMA: había DOS lectores del mismo dato, y ya habían divergido en CUATRO puntos

**`resolveSigningToken_` resolvía el token de firma con SEIS lecturas directas a AppSheet** desde
este proceso, que es público y anónimo, con la credencial de la aplicación entera:

| Quién | Qué leía |
|---|---|
| `resolveSigningToken_` | la fila del **firmante** buscada por el token (`sysSigningSessionSigners`) y su **sesión de firma** (`sysSigningSessions`) |
| `isMilestoneCompleted_` | los **hitos** del expediente y el **catálogo de tipos de hito ENTERO, sin filtro** |
| `isDurableSigningMilestoneCompleted_` | **los mismos dos**, otra vez |

**Y su propio comentario se declaraba «espejo VERBATIM del lector canónico del KMS»** —
`sys_resolveSigningToken_`. Eran **dos lectores del mismo dato**, que es exactamente el anti-patrón
que §"Regla — refactors preservan el código probado" prohíbe. **Ahora lo resuelve el KMS** por
`enr.resolveSigningToken` —ruta que **ya existía y ya estaba declarada `'public'`**— y lo consume
**UN SOLO ayudante**, `_resolucionDelTokenDeFirma_`.

⚠️ **Y EL BLOQUEO ESCRITO ERA FALSO, dos vueltas.** Decía que *«autentica por el propio token de
firma ⇒ no hay token de recuperación del que derivar nada, y eso es otra decisión»*. Medido contra
`origin/master`: la ruta del KMS **ya acepta ese bearer del cuerpo**, ya está declarada pública
(*«token-gated; signer may be a family/external party»*) y su cabecera dice que la forma que
devuelve está *«preserved for the wizard»*. **No hacía falta ninguna decisión: hacía falta el
tramo.** Es el mismo precedente que el ámbito en minúsculas del undécimo — un comentario no cierra
una pregunta de diseño.

**⭐ Las CUATRO divergencias que cierra, todas a favor de la familia:**

| # | Qué | Qué le pasaba a la familia |
|---|---|---|
| 1 | **El ancla de la sesión (DL-S105 §10)** — desde ese cambio la sesión cuelga del **EXPEDIENTE del alumno**, no de la solicitud. El KMS traduce con el lector único `enr_signingGroupIdForSession_`; el asistente usaba `session['entity_id']` **crudo** | al tutor que **ya consintió y ya revisó** se le volvía a pedir todo, **cada vez** |
| 2 | **El tipo de expediente (DL-E48)** escrito a mano; el KMS usa la clase que la **propia sesión de firma ya lleva escrita** | en un campamento se buscaba el hito bajo una clase que no es la suya |
| 3 | **`gdpr_blocked`** se devolvía `false` a pelo (*«deferred per roadmap §4.5»*); el KMS lo **calcula** contra el libro de consentimientos | *(hoy **no se nota**: medido, ese campo **no tiene ni un consumidor en el frontal**. Se dice para que nadie lo cuente como arreglo visible)* |
| 4 | **El plazo y la invalidación por estado** — el KMS aplica el vencimiento de la sesión y el rol `INVALIDATES_SIGNING_TOKENS` del catálogo del colegio; aquí solo se miraban **tres códigos escritos a mano** | un token de una sesión vencida seguía valiendo |

**Lo que hay que retener al tocar esto:**

- **⛔ `signing_url` SE RECORTA AQUÍ, en el CONSUMIDOR — y no es estilo.** El KMS **sí** lo
  devuelve, y hace bien: esa ruta la usa también el panel del KMS, donde la URL es legítima. Pero
  CLI 81 / S5 / KAL-NEW-1 cerró que **la resolución previa a la firma no revele la URL del
  proveedor con solo el bearer**; copiarla desde aquí **reabriría esa mitigación**. Sigue llegando
  solo por `initiateSigningSession_` (`session.signerUrls`) — medido: `Step11Sign.jsx` la lee de
  ahí y **`resolveSigningToken` no tiene ni un llamante en el frontal**.
- **La VALIDACIÓN DE FORMA se queda aquí, verbatim** (`assertValidSigningToken_`, P211: UUID v4 con
  guiones **o** 32 hex sin guiones, que es como los emite el KMS). Rechazar la forma antes de gastar
  un viaje es lo mismo que hacía antes de gastar una lectura — medido: con un token malformado **no
  se pregunta al KMS**.
- **⚠️ FALLA CERRADO NOMBRANDO, y esto CORRIGE el oro.** El bloque retirado convertía un fallo de
  lectura de AppSheet en `{valid:false, reason:'INVALID'}` ⇒ la familia leía *«tu enlace de firma no
  vale»* cuando la verdad era que la base de datos no contestaba. Hoy **lanza `KMS_UNREACHABLE`**.
  Los dos caminos son igual de cerrados —ninguno deja pasar a nadie—, pero solo uno **nombra** el
  problema. Mismo criterio que la puerta (duodécimo tramo), y el código ya es vecino del fichero:
  `doPost` lo mapea uniforme como cualquier otro.
- **NO viaja ningún identificador de expediente ni nombre de tabla**: el cuerpo lleva **un solo
  campo**, el `signing_token`, que es la identidad de este camino (aquí no hay `resume_token` del
  que derivar nada — quien firma llega por su propio token). El KMS resuelve firmante, sesión y
  expediente server-side.

**Retirados enteros**, por ser el segundo lector: **`isMilestoneCompleted_`** ·
**`isDurableSigningMilestoneCompleted_`** · y **`manual_testSigningStepsFromMilestones`**, su único
llamante que quedaba —y **caducado por dentro**: buscaba los consentimientos y la revisión bajo el
ancla del firmante, que DL-E44 dejó como respaldo legado—. Con ellos salen del catálogo de tablas
`MILESTONES` y `MILESTONE_TYPES` (medido: **0 usos**).

**Recuento, con la forma de repetirlo** (`grep -c 'appsheetRequest_('` **menos 1**, la definición;
ídem `appsheetRequestBatch_`): **50 → 44** sueltas, **0** en lote. Y lo que de verdad importa:
**el camino vivo baja de 8 a DOS**.

**Control**: `scripts/verja-publica.mjs` gana `comprobarElRacimoDeFirma` — las cuatro tablas no
vuelven · pasa por el lector único, que apunta a la ruta declarada · los dos ayudantes y su
diagnóstico **no reaparecen** · `signing_url` no se copia · un KMS caído no se disfraza de token
inválido · el literal del dominio no vuelve · y **DOS anclas** (sigue validando la forma del token,
y `requireSigningToken_` sigue resolviendo y rechazando con `UNAUTHORIZED`). **Rojo demostrado ONCE
veces**, cada una nombrando su caso; la del renombrado deja el control **CIEGO**.

⚠️ **La batería NO cubre esto** — corre contra un backend simulado que **nunca ejecuta
`backend/Code.js`**, y **el acto de firmar está declarado fuera de cobertura a propósito**. El lado
del KMS tampoco lo cubre ningún control, así que se **midió aparte**: **16 afirmaciones** sobre el
manejador real extraído del fuente y ejecutado con dobles, **demostradas no ciegas** con **siete
roturas** (devolver `signing_url` · disfrazar el transporte caído · mandar el expediente en la
petición · volver a clavar `gdpr_blocked` en falso · preguntar antes de validar la forma · y el
renombrado, que debe salir **«MEDICIÓN CIEGA»**). **Y la medición se corrigió a sí misma:** su
rotura del renombrado **explotaba** en vez de declararse ciega —era la rotura la que era débil, no
la afirmación—, y hubo que aplicarla al FUENTE, que es donde alguien renombraría de verdad.
**Quien toque este manejador, que lo mida.**

### 18.bis.35 (2026-08-16) — el paso 6 deja ELEGIR qué es el documento, y con dos tipos declarados estaba ROTO de punta a punta

**Describir no es clasificar.** El paso 6 era un adjuntador genérico con una casilla de **texto
libre** donde la familia *describía* el archivo, y esa descripción va a `recFiles.description`. Un
texto no le asigna al papel **ni su nivel de confidencialidad ni sus etiquetas**, que es lo único
que decide quién puede verlo (DL-R07) ⇒ todo lo que sube una familia caía en un cajón único y el
reparto fallaba **en las dos direcciones**: la enfermera **no ve** un informe médico etiquetado de
admisión, y **todo el que tenga admisión sí lo ve**.

⛔ **Y no era solo alcance que faltaba: con DOS tipos declarados, adjuntar NO FUNCIONABA.** El KMS
rechaza con `REC_TYPE_REQUIRED` la subida que no dice cuál (*«el trabajo tiene que decir cuál»*), y
el asistente **no tenía forma de decirlo** ⇒ en cuanto el colegio marcase un segundo tipo como «lo
aporta la familia», **ninguna familia podría adjuntar nada**. Hoy funciona solo porque hay
exactamente uno marcado. **Por eso el orden obligado era: primero la pantalla, después los tipos.**

**Lo que ya estaba, y por eso este tramo es pequeño** (medido contra `origin/master` del KMS): el
KMS **ya mandaba las opciones** en las MISMAS listas que el asistente ya pide
(`recTypesInterestedParty`, `enr_wizardFetchLookups`) y **ya aceptaba y validaba** el código
elegido contra el catálogo (`enr_wizardPersistUpload`). El asistente **tiraba las dos cosas**: 0
apariciones de `recTypesInterestedParty` y `rec_type_code` solo en comentarios. **No se abrió
ninguna ruta nueva.**

**Lo que hay que retener al tocar esto:**

- **Se pregunta a partir del SEGUNDO tipo, y no es estilo.** Con **0** el servidor rechaza
  nombrando qué configurar; con **1** lo asigna él (*«un desplegable de una opción no es
  elección»*, DL-R16) y la pantalla no pregunta; **con 2 o más elige la familia**, y entonces su
  respuesta es **obligatoria**.
- **DEGRADA SIN ROMPER**: la lista arranca vacía y ningún fallo de lectura se propaga ⇒ un colegio
  que no ha marcado ninguno, o una lectura que no llega, deja la pantalla **exactamente como estaba**
  y la familia sigue adjuntando.
- **Ni un código escrito a mano**, ni en la pantalla ni en el servidor. El asistente **solo
  transporta** lo que contestó la familia: valida la FORMA (KAL-5 capa 1, la misma que un
  identificador de fichero legible — el colegio puede dar de alta códigos con la forma que quiera) y
  **quién es admisible lo dice el KMS** contra la lista viva. **Sin respaldo**: un respaldo escrito a
  mano fue exactamente el defecto que `'OTHER'` causó.
- **Se avisa DONDE la familia puede contestar**: con dos o más tipos, la pantalla no dispara la
  subida sin respuesta — mandar megabytes a un rechazo seguro y devolver un código interno es peor.
  **El servidor sigue siendo el suelo**; esto solo evita el viaje inútil.

**Control**: la batería gana **cuatro afirmaciones** en `subir-documento` —que se pregunte · que las
opciones salgan del **catálogo que manda el servidor** · que **ninguna** venga preseleccionada · y
que la respuesta **viaje en la petición**—, y el simulado sirve **dos** tipos a propósito: con uno
la pantalla no pinta el desplegable y la comprobación pasaría **en vacío**, que es peor que no
tenerla. **Rojo demostrado dos veces**: quitándole a la pantalla el envío del tipo → **ROJO**
nombrando el caso (*«rec_type_code recibido: undefined»*), y sustituyendo el catálogo por una lista
escrita a mano → **ROJO en las cuatro**.

⚠️ **LA MITAD DEL SERVIDOR NO TIENE RED, Y ESTÁ DEMOSTRADO — no supuesto.** Se rompió a propósito
el paso del tipo en `uploadDocument_` (que el `rec_type_code` validado **no viaje** al KMS) y **la
batería salió VERDE**, igual que los cuatro controles: corre contra un backend simulado que **nunca
ejecuta `backend/Code.js`**, así que sus afirmaciones miden lo que manda **el navegador**, no lo que
reenvía el servidor del asistente. **No se escribió una red para tapar el hueco** (prohibido durante
la misión). **Quien toque `uploadDocument_`, que lo mida.**

### ②17 (2026-08-16) — el transporte en LOTE se RETIRA: no era código muerto, era un escritor genérico esperando

**`appsheetRequestBatch_` se quedó sin ni un llamante** cuando el decimotercer tramo (el pulso de
la admisión) se llevó el último. Aquel tramo lo dejó **anotado y sin tocar**, con su motivo. Esta
vuelta lo retira entero: **118 líneas fuera**, una lápida de once en su sitio.

**Por qué no es solo limpieza, y es lo único que hay que retener:** este proceso es
`ANYONE_ANONYMOUS`, y lo que quedaba dormido aquí **no era un lector**. Su firma admite
`'Find'|'Add'|'Edit'|'Delete'` **sobre CUALQUIER tabla** —el nombre viaja como parámetro— y lee la
credencial de AppSheet de las propiedades del proyecto. O sea: un **escritor genérico y completo**,
listo para usar, dentro del mismo fichero cuyo invariante declarado es que **el asistente NO
ESCRIBE NUNCA en AppSheet**. No había agujero —nadie lo llamaba y no estaba en el despachador—,
pero un escritor que sobra en una superficie pública no se aparca: se quita (§"lo vestigial se
ELIMINA en cuanto se detecta", `kis-app/CLAUDE.md`).

**Lo que NO cambia, medido:** las **44** lecturas directas de `appsheetRequest_` siguen siendo 44
(esto no era una lectura) y las de lote siguen en **0**. Se repite con
`grep -c 'appsheetRequest_(' backend/Code.js` **menos 1**, la definición.

**Su nombre SÍ se conserva en los tres controles**, y es deliberado: en
`scripts/escrituras-directas.mjs` no es una exención que sobre —es la lista de transportes
permitidos— y en `personas-quitadas.mjs` y `verja-publica.mjs` forma parte de lo que vigilan. **Un
nombre que ya no existe en el código sigue valiendo para impedir que vuelva**; borrarlo de ahí sería
aflojar tres controles a cambio de nada.

**Control**: no se añade ninguna afirmación nueva —no hay comportamiento nuevo que afirmar—, pero
**sí se comprobó que retirar el nombre del código NO deja ciega la vigilancia**: se rompió a
propósito dos veces sobre el fichero ya retirado y `escrituras-directas` salió **ROJO las dos**,
nombrando fichero y línea — una escritura con acción literal (`appsheetRequest_(…, 'Add', …)`) y un
**transporte paralelo** (la URL de AppSheet montada a mano con `UrlFetchApp.fetch`). Restaurado,
**VERDE**. Los **cuatro** controles siguen verdes y la batería, **23 de 23**.

⚠️ **La batería NO cubre esto** — corre contra un backend simulado que **nunca ejecuta
`backend/Code.js`**. Aquí no hace falta más: lo retirado **no tenía llamantes**, y eso se acredita
con el `grep`, no con una prueba.

### ②17 (2026-08-15) — la RECUPERACIÓN DEL ENLACE: la ficha de cada persona, MENORES INCLUIDOS, solo para saber quién es tutor

**La rama pública de `sendMagicLink_` es la puerta por la que una familia vuelve a su solicitud**, y
la alcanza **cualquiera desde internet con el correo que quiera** (`ANYONE_ANONYMOUS`). Hacía tres
grupos de lecturas directas a AppSheet, **con la credencial de la aplicación entera**, todas
filtradas por ese correo tecleado:

| Qué leía | Qué cruzaba a este proceso |
|---|---|
| los expedientes cuyo **correo principal** casa | la fila **ENTERA**, con **`magic_link_token`** —un secreto de portador— más `school_id`, `program_id`, `source_id`, `requester_person_id`, `source_locale`, `updated_at`, `_RowNumber` y el bloque de auditoría |
| **todas** las filas de `enrEmails` de ese buzón | las filas enteras, en **todos** sus expedientes |
| las **personas** de los expedientes que casaran | la **ficha COMPLETA de cada una —MENORES INCLUIDOS**: nombre, fecha de nacimiento, documento— **solo para comprobar que el correo es de un tutor** |

**Ahora lo sirve una entrada del KMS**, `enr.wizardRecuperacionDelCorreo`
(`kis-app kms-server/enr/wizard-gateway.gs`), con los **mismos filtros**, y lo consume **UN SOLO
ayudante**, `_recuperacionDelCorreo_`. De cada expediente salen **CINCO campos**
(`enrollment_group_id`, `resume_token`, `preferred_language`, `submitted_at`, `created_at` — los que
este fichero demuestra usar) y de los correos **un identificador opaco por expediente**, el `n` del
enlace. **De las personas no sale ni un campo.**

**Lo que hay que retener al tocar esto:**

- **LA DECISIÓN NO SE MOVIÓ.** Preferir la lista del correo principal y caer a la del tutor solo si
  aquélla está vacía · ordenar por antigüedad · renovar o no el enlace · mandar uno o la lista de
  varios: todo eso sigue **aquí, verbatim**. Por eso la entrada devuelve **las dos listas por
  separado**, nunca una ya elegida.
- **La GUARDA del tutor SÍ viajó, porque es inseparable de su lectura.** «Solo mandar si el correo
  casado es de un **tutor**, no de un menor» era la única razón por la que se leían las personas ⇒
  se hace dentro del KMS, y así las fichas no cruzan. Mismo criterio que `enr.wizardComprobarSubida`:
  **las guardas viajan con su lectura; las decisiones, no.**
- **`findOpenGroupsByGuardianEmail_` se RETIRÓ entero** (72 líneas): su lógica es la que viajó, y
  dejarlo sería un **segundo lector del mismo dato**. Tenía **un solo llamante**, medido.
- **Los fallos NO pesan igual, y se conserva el criterio del oro.** Las lecturas de expedientes
  **LANZAN** —el oro lo decía con todas las letras: *«devolver [] diría "esta familia no tiene
  expediente" y el caller le abriría uno NUEVO»*—; la de correos **degrada** para el identificador
  del enlace (sin `n` el enlace se manda igual) y **falla cerrado** si es la única vía que queda.
- **Auth: solo `service_token`, y se dice así.** Aquí no hay `resume_token` del que derivar nada
  (KAL-4): quien pide la recuperación es, por definición, quien **no tiene** el enlace. El alcance lo
  acota la FORMA de la entrada —un correo, cinco campos y un identificador opaco—. Acotar por
  cliente es `②18`.
- **La anti-enumeración (WIZ-ENUM) no se toca:** la respuesta pública sigue siendo constante, y que
  la entrada del KMS lance no crea oráculo — el `catch` de siempre lo convierte en el mismo acuse.

⚠️ **Y ESTO CERRÓ UN AGUJERO REAL, medido el 2026-08-15.** La lectura de expedientes del lote de
entrada degradaba a `null` (`lecturaEntrada[0].ok ? … : null`) y **no se distinguía de «no hay
ninguno»**: si se caía y el buzón no casaba además por la vía del tutor —el caso normal del tutor 1,
cuya fila de correo puede no existir todavía—, el asistente **abría un expediente NUEVO y le mandaba
el enlace a un borrador vacío**. Ahora falla cerrado: mismo acuse, y **sin crear nada**.

**Recuento, con la forma de repetirlo** (`grep -c 'appsheetRequest_('` **menos 1**, la definición;
ídem `appsheetRequestBatch_`): **66 → 64** sueltas y **4 → 2** en lote. *(De las dos bajas de las
sueltas, **una es una MENCIÓN en un comentario**, no una lectura: los puntos de lectura retirados
son **una suelta y dos en lote**, que cubrían **cinco consultas** reales a AppSheet.)*

**Control**: `scripts/verja-publica.mjs` gana `comprobarLaRecuperacionDelEnlace` — el manejador no
vuelve a buscar expedientes por `primary_email` ni a leer `enrEmails` por un correo arbitrario · sí
le pide las dos listas al KMS por el ayudante único · el ayudante pregunta a la entrada declarada ·
**el lector viejo no reaparece** · y **dos anclas**: que el manejador siga existiendo y siga
devolviendo el acuse constante, para que el control no salga verde afirmando ausencias sobre un
manejador vaciado. **Rojo demostrado SIETE veces**, cada una nombrando su caso (dos dejando el
control **CIEGO**).

⚠️ **La batería NO cubre esto** — corre contra un backend simulado que **nunca ejecuta
`backend/Code.js`**. El lado del KMS tampoco lo cubre ningún control, así que se **midió aparte**:
**21 afirmaciones** sobre el manejador real extraído del fuente y ejecutado con dobles,
**demostradas no ciegas** con seis roturas (ensanchar la proyección a la fila entera · quitar la
guarda del tutor · disfrazar de «no hay ninguno» la lectura por correo principal · quitarle el fallo
cerrado a los correos · quitar el cinturón sobre el selector · renombrar el manejador → *«medición
CIEGA»*, no verde). **Quien toque este manejador, que lo mida.**

### ②17 (2026-08-15) — la CABECERA del expediente: tres copias de la misma lectura, y una cruzaba entera al navegador

**Eran TRES lecturas y eran LA MISMA copiada tres veces** —
`appsheetRequest_(T.ENROLLMENT_GROUPS, 'Find', [], { Filter: '"resume_token" = …' })`— en el camino
de ENTRADA: la rama de `hydrateSession_` con el **candado puesto** (`pii_gated`), el **hint de
identidad** del mismo manejador, y `warmSession_`, **cuyo propio comentario decía «VERBATIM de
`hydrateSession_`»**. Las tres las hacía este proceso, que es público y anónimo, con la credencial
de AppSheet de la aplicación entera.

**Y la primera no se quedaba aquí: devolvía la fila ENTERA al navegador** como `group`, dentro del
payload cuyo propósito declarado es *no cruzar datos personales antes del código de un solo uso*.
Iba dentro **`magic_link_token`** —un secreto de portador— además de `program_id`, `source_id`,
`school_id`, `preferred_language`, `created_at` y el bloque de auditoría entero.

**Lo que se midió antes de tocar nada** (contra `origin/main`, 2026-08-15) y decidió la proyección:

| Consumidor | Qué lee de verdad |
|---|---|
| cliente, rama con el candado | `enrollment_group_id` (`WizardContext.jsx:913`) · `resume_token` (`:914`) · `submitted_at` (`ResumePage.jsx:120`, solo registro). **`hydrateFromResume` RETORNA en `:946`** antes de tocar nada más |
| `effectiveRecoveredEmail_` (respaldo paso 3) | `primary_email` |
| `resolveGuardianForRecovery_` *(medición del sexto tramo; en el noveno dejó de leer nada — la cabecera solo alimenta ya el respaldo «tutor 1»)* | `primary_email` · `requester_person_id` · y `enrollment_group_id` |

⇒ **CINCO campos.** La entrada del KMS es `enr.wizardExpedienteDelToken`
(`kis-app kms-server/enr/wizard-gateway.gs`), y el asistente la consume por **UN SOLO ayudante**,
`_expedienteDelToken_`.

**Lo que hay que retener al tocar esto:**

- **CERO lecturas de más**: la fila la devuelve **la propia puerta** del KMS (`s.group`), que ya la
  lee por `resume_token` con el mismo filtro y el mismo criterio de fila viva. No se consulta nada
  aparte — medido: **una sola consulta** por llamada.
- **UN SOLO lector, y es la mitad del punto.** Antes había tres copias que podían divergir; ahora
  hay uno. **PROHIBIDO escribir un segundo**: es la regresión que documenta §"Regla — refactors
  preservan el código probado".
- **El comportamiento ante fallo NO era el mismo en los tres, y se conserva tal cual**: la rama del
  candado **LANZA** si no se pudo preguntar (`appsheetRequest_` lanzaba y ahí no había `try`), y el
  hint de identidad y el precalentado **degradan a `null`** (su `try/catch` de siempre) ⇒ identidad
  group-scoped, comportamiento previo exacto. Por eso el ayudante devuelve **`{ok, fila}`** y no un
  simple `null`.
- **`desired_start_date` dejó de normalizarse aquí, y no es un olvido**: en esa rama **no cruza**
  (el cliente retorna antes), y su sede canónica es `enrEnrollments`, no la cabecera. La
  normalización sigue viva en los otros cinco sitios que la usan.
- **La puerta del KMS aplica el mismo plazo de 7 días y el mismo rechazo de sesión abandonada** que
  `requireResumeToken_`, que además ya corrió antes en el asistente ⇒ cero cambio de comportamiento.

**Recuento, con la forma de repetirlo** (`grep -c 'appsheetRequest_('` **menos 1**, la definición):
**72 → 69** sueltas; las de lote se quedan en **4**.

**Control**: `scripts/verja-publica.mjs` gana `comprobarLaEntradaDelExpediente` — los dos
manejadores no vuelven a leer `enrEnrollmentGroups` de AppSheet · los tres puntos **sí** preguntan
al KMS por el ayudante único · el ayudante existe y pregunta a la entrada declarada · y **dos
anclas**: que los dos manejadores sigan existiendo y sigan resolviendo la identidad del enlace, para
que el control no pueda salir verde afirmando ausencias sobre un fichero que ya no mide. **Rojo
demostrado seis veces**, cada una nombrando su caso (incluidos los dos renombrados, que dejan el
control CIEGO).

⚠️ **La batería NO cubre esto** — corre contra un backend simulado que **nunca ejecuta
`backend/Code.js`**. El lado del KMS tampoco lo cubre ningún control, así que se **midió aparte**:
**14 afirmaciones sobre el manejador real**, extraído del fuente y ejecutado con dobles, y **la
medición se demostró no ciega** rompiéndola cinco veces (ensanchar la proyección a la fila entera ·
aceptar el expediente del cuerpo · disfrazar la lectura caída de «no hay expediente» · quitar la
declaración pública de la ruta · renombrar el manejador → *«medición CIEGA»*, no verde).
**Quien toque este manejador, que lo mida.**

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
- **Backend (defensa en profundidad)**: helper `assertGroupEditable_(enrollment_group_id)` en `backend/Code.js`, llamado al inicio de sus **CINCO** llamantes — `saveStep_`, `submitEnrollmentSession_`, `saveResponses_`, `uploadDocument_` y `saveNeae_`—, **siempre inmediatamente después de `requireResumeToken_`**. Si `submitted_at IS NOT NULL` o `abandoned_at IS NOT NULL`, throw con `err.code='NOT_EDITABLE'`. `doPost` mapea ese código a HTTP 200 + `{ok:false, error:{code:'NOT_EDITABLE', message}}` — patrón P72 silent reject estructurado, NUNCA HTTP 403. *(②17 duodécimo tramo, 2026-08-16: **ya no lee nada** — reusa la fila que la puerta acaba de validar, en la memoria de EJECUCIÓN, y falla cerrado con el mismo `NOT_FOUND` si no está. Ver §"②17 — LA PUERTA".)*

**Estados editables canónicos (regla derivada)**: solamente cuando `submitted_at IS NULL` (≡ DRAFT) y `abandoned_at IS NULL`. La rama "reopen" (KMS transiciona enrollments a IN para pedir más info) ya está cubierta server-side: **`hydrateSession_`** —el camino VIVO— sobrescribe `submitted_at = null` en la respuesta cuando la fase del expediente es editable (busca `REOPEN-FIX` en `backend/Code.js`). Por tanto el modelo conceptual del wizard es:

  - `submitted_at IS NULL`              → DRAFT (editable)
  - `submitted_at IS NOT NULL`          → RQ/IN/etc (no editable, KMS-territory)
  - reopen by KMS (fase editable)       → override de `hydrateSession_` → editable de nuevo

*(②17, 2026-08-15: esto lo hacía ADEMÁS `resumeSession_`, que se retiró. Era un segundo lector de la
misma hidratación y el frontal no lo llamaba; hoy la reapertura vive en **un solo sitio**.)*

EDITABLE_STATES en frontend (`WizardContext.jsx`) está hardcoded como `['DRAFT', 'NEEDS_MORE_INFO']` para documentar la intención conceptual. TODO operativo: cuando `sysStateTransitions_T` exponga un flag `is_editable_by_family`, derivar la lista dinámicamente y dejar de mapear vía `submitted_at` booleano.

**Test**: `manual_testApplicationEditRejectionOnSubmitted` en `backend/Code.js`. Diego rellena `RESUME_TOKEN_REAL` + `GROUP_ID` reales arriba del wrapper, ejecuta desde el editor GAS, y lee PASS/FAIL en Logs. Cubre 3 casos: DRAFT editable → forzar submitted_at → NOT_EDITABLE → limpiar submitted_at → editable de nuevo.

### recognizeFamily — silent ack anti-enumeración (KAL-10 cerrado 2026-05-30)

`recognizeFamily_` se invoca desde dos sitios:
- **Dispatcher público** (action `recognizeFamily` en `doPost`): cualquiera con internet puede llamarlo.
- **Internal call** desde `initEnrollmentSession_({...}, {internal: true})` — la familia acaba de introducir su email en la landing.

Sin contramedidas, el caller público recibe `{matched: boolean, persons: [{personal_id, first_name, last_name}...]}` — enumera direcciones de familias existentes y devuelve sus nombres. Vector clásico de enumeration.

**Defensa**: `recognizeFamily_` ahora distingue por `opts.internal`. El caller público (sin `internal: true`) recibe SIEMPRE `{matched: false, persons: []}` — shape constante, indistinguible entre "match" y "no match". El internal call sigue recibiendo el payload completo (con nombres) porque ese flujo ya validó que el caller es la familia (acaba de teclear su email + resolvió reCAPTCHA en el init).

#### ②17 (2026-08-15) — este manejador ya NO lee las tablas maestras, y su ack ya no delata por TIEMPO

**Aquí vivían las DOS ÚNICAS lecturas del asistente a las tablas MAESTRAS de personas del colegio**
—`contactEmails` (todos los correos de contacto de todo el mundo) y `personalData_S` (el registro de
personas del colegio ENTERO)—. Todo lo demás que este fichero lee directamente son tablas de
admisión, de firma o de catálogo. **Se las pide al KMS**: `enr.wizardReconocerFamilia`
(`kis-app kms-server/enr/wizard-gateway.gs`), que hace los **mismos dos filtros** —correo →
`personal_id`s → personas— y **proyecta solo los tres campos** que la pantalla enseña
(`Step2Persons.jsx:1123-1128`). La ficha entera de cada persona **ya no cruza** a este proceso, que
es público y anónimo. **Sin respaldo a AppSheet**: dos lectores del mismo dato divergen; si el KMS
no contesta, el reconocimiento queda vacío, que es lo que ya pasaba cuando la lectura fallaba.

**Lo que este tramo NO cierra, y se dice:** la credencial de AppSheet **sigue en el asistente** (`②17`
sigue abierta), y quien tenga el `service_token` puede preguntar correo a correo **sin el cupo de
aquí** — acotar por cliente es `②18`.

**Y el ack constante ya no delata por el RELOJ.** La respuesta pública era constante desde KAL-10,
pero **se consultaba igual antes de devolverla**: encontrar costaba dos lecturas y no encontrar una,
así que el tiempo decía lo que la respuesta callaba — el mismo defecto que se cerró en la
recuperación del enlace (②2). Ahora **corta antes de preguntar**: misma verja, mismo cupo, misma
respuesta y **el mismo tiempo**. **Ninguna familia lo nota**: esa acción pública **no tiene ni un
llamante en la aplicación** (medido contra `origin/main` — el frontal solo lee `recognition` de la
respuesta de `initEnrollmentSession`, `ConsentPage.jsx:68`).

**Control**: `scripts/verja-publica.mjs` lo vigila con **tres** afirmaciones nuevas — el ack va antes
de cualquier consulta · el ack constante sigue existiendo · el manejador no vuelve a leer
`contactEmails`/`personalData_S` de AppSheet. **Rojo demostrado las tres**, cada una nombrando su
caso. ⚠️ **La batería NO cubre esto**: corre contra un backend simulado que nunca ejecuta
`backend/Code.js` — lo que hay que hacer al tocar este manejador es **medirlo**.

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
**Y, ya detrás del token (②27), comprueba la PARIDAD**: que los **12 manejadores de mutación**
exigen el código de un solo uso, **tras** derivar el expediente del bearer y **antes** del trabajo
caro (§"El token es la PRIMERA capa…"). **NO afirma** que la ventana de 10 min sea correcta ni que
la marca sea del buzón que opera — eso es ②24 y vive en `_isStepUpFresh_`.
**Rojo demostrado veintiuna veces** antes de darlo por bueno — cinco en ②27 (quitando el código de
`retirarDelExpediente_` · quitándolo de `submitEnrollmentSession_` · exigiéndolo ANTES de derivar
el expediente en `applyPaymentModality_` · poniendo el viaje al KMS por delante del código ·
renombrando `assertStepUpFresh_`, que deja el control CIEGO en todos) y seis en ②2 (quitando la verja de
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

### Los permisos que declara el asistente — los cinco que hay, y por qué

Este backend es `ANYONE_ANONYMOUS` **pero `executeAs: USER_DEPLOYING`**, así que **cada permiso del
manifiesto lo consiente SOLO quien publica** —Diego— y pesa sobre TODO el proyecto. Ninguna familia
ni ningún profesor ve jamás esa pantalla de permisos. **Eso es exactamente lo contrario del KMS**
(`USER_ACCESSING` + `ANYONE`), donde el manifiesto lo consiente **cada usuario que entra**, y por
eso hay cosas que aquí son baratas y allí no.

La dirección correcta sigue siendo **retirar**, y **nunca se añade un permiso "por si acaso"**. Pero
la razón de fondo es más fina que «un permiso de más tumba el proyecto»: lo que tumba el proyecto es
un permiso **RESTRINGIDO** que la cuenta no pueda conceder — deja la autorización **a medias** y
`UrlFetchApp` empieza a fallar en todo (mismo mecanismo que las dos prohibiciones del KMS,
`kis-app/CLAUDE.md` §"RESTRICCIÓN DE DISEÑO — el KMS solo autoriza scopes SENSIBLES"). Un permiso
**sensible** se pide de forma incremental y **no** envenena la concesión.

`backend/appsscript.json` declara **cinco** y un servicio avanzado:

| Permiso | Nivel | Para qué, y quién lo usa |
|---|---|---|
| `script.external_request` | no sensible | `UrlFetchApp` — todo el tráfico saliente: AppSheet y el proxy al KMS (`kmsProxy_`) |
| `gmail.send` | **sensible** | mandar el correo **con el alias del colegio**: `sendAsAlias_` → `Gmail.Users.Messages.send` |
| `script.send_mail` | **sensible** | el **repliegue** de `sendAsAlias_`: si el alias falla, `MailApp.sendEmail` manda igual desde la cuenta que publica, para que la familia reciba su correo |
| `drive` (Drive **COMPLETO**) | restringido | los documentos que sube la familia: `getOrCreateDriveFolder_` + `folder.createFile` y la lectura de vuelta `DriveApp.getFileById` |
| `script.scriptapp` | sensible | `ScriptApp.getService().getUrl()`, `getOAuthToken()` (el bearer que abre la puerta del KMS) y los disparadores del proyecto |

Servicio avanzado: `{ "userSymbol": "Gmail", "serviceId": "gmail", "version": "v1" }` — es lo que
permite mandar el mensaje crudo RFC822 con **solo** `gmail.send`, sin escalar al permiso de Settings
que `GmailApp.sendEmail` con alias sí pediría.

**★ El asistente SÍ manda correo, y desde el 2026-08-19 es el único que lo manda (①51).** Lo que
**NO** hace es escribir el texto: las plantillas, el idioma, los marcadores y la identidad de correo
del colegio siguen viviendo en el KMS, que se los sirve ya renderizados
(`sys-public.renderNotification`) y recibe después el parte de lo que pasó
(`sys-public.logNotificationSent`). Cambió **quién ejecuta el envío**, no quién decide qué se manda.
Detalle en §"Email sending".

**Por qué el envío está AQUÍ y no en el KMS**, en una línea: `MailApp` —lo único que el KMS puede
usar— **no admite remitente**, así que su correo sale siempre desde la cuenta que lo publicó; y
poner `gmail.send` en el manifiesto del KMS se lo tragarían **todas** las familias. Aquí no se lo
traga nadie más que Diego.

Compruébalo antes de afirmar nada, contra `origin/main` y **nunca** contra el árbol de trabajo:

```bash
git show origin/main:backend/appsscript.json                                  # los cinco permisos
git show origin/main:backend/Code.js | grep -nE "Gmail\.Users|MailApp\."     # el ÚNICO transporte: sendAsAlias_
git show origin/main:backend/Code.js | grep -cE "^[^*/]*GmailApp\."           # 0 — GmailApp no se usa (escalaría permisos)
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

**Qué cubre** (`frontend/e2e/run-wizard.mjs`, Playwright headless contra el backend simulado de `e2e/mock-backend.mjs`): `alta-nueva` (portada → enlace enviado, UNA sola petición, el cliente NO decide recuperar-vs-crear) · `ack-indistinguible` (email conocido vs desconocido → misma pantalla y misma secuencia de llamadas; y con un servidor que delata, el cliente sigue sin ramificar — el guardarraíl del casi-incidente WIZ-ENUM) · `recuperar-aterrizar` (magic-link → aterriza en el paso donde estaba + token fuera de la barra, KAL-7) · `guardar-paso` (avance optimista ≤200 ms medido EN LA PÁGINA + el `saveStep` lleva el valor nuevo + persiste al volver atrás) · `subir-documento` (bytes reales + confirmación visible) · `tramo-firma` (expediente admitido aterriza en el paso 8 y lo pinta) · `precalentado-sin-ruido` (pedir el enlace dos veces NO deja ni un error en la consola de la familia: el ticket del precalentado es de un solo uso y «no había nada que calentar» no es un fallo) · `precalentado-fallo-se-registra` (y un fallo DE VERDAD sí se registra). **Estos dos van separados a propósito:** la declaración de error de consola vale para TODO el camino, así que juntos el segundo se tragaba el error del primero y la red no medía nada — medido rompiéndolo el 2026-08-15.

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

> **★ EL TEXTO LO PONE EL KMS; EL ENVÍO LO EJECUTA EL ASISTENTE (2026-08-19, ①51 opción A).**
> El motor de plantillas, el idioma, los marcadores y la identidad de correo del colegio **siguen
> en el KMS** y no vuelven aquí (eso lo retiró DL-S69 §6). Lo que volvió es el **transporte**:
> `sendAsAlias_`, con `gmail.send` (permiso **sensible**) y el alias `admissions@kaleide.org`,
> **porque `MailApp` —lo único que el KMS puede usar— no admite remitente** y su correo salía desde
> la cuenta que publicó el KMS (`developer@kaleide.org`, que es lo que Diego recibía). El texto
> histórico de abajo (el `GmailApp` local con plantillas propias) sigue SUPERSEDIDO: aquí no se
> construye ni una línea de correo.

### Lo que el wizard manda HOY — la lista, y cómo se comprueba (medido 2026-08-08)

**Son cuatro avisos + el código de un solo uso, y ninguno es la confirmación a la familia:** `WIZARD_MAGIC_LINK` y `WIZARD_MAGIC_LINK_MULTI` (a la familia, el enlace para volver a su solicitud) · `WIZARD_SESSION_STARTED` y `WIZARD_UNSOLICITED_REPORTED` (a admisiones, internos) · `WIZARD_OTP` (el código de un solo uso, por `sendViaKmsAuthCode_`). **La confirmación de «solicitud recibida» y los avisos del expediente NO los manda el wizard: los gobierna el motor de avisos del KMS a partir de los hitos** (los dos correos del envío se retiraron del wizard el 2026-08-07 y hoy cuelgan de la entrada en RQ).

**Un nombre de plantilla dentro de un comentario NO es un envío.** Antes de afirmar que el wizard manda algo, cuenta los llamadores contra `origin/main` — nunca contra el árbol de trabajo: `git show origin/main:backend/Code.js | grep -oE "sendViaKmsNotify_\('[A-Z_]+'" | sort -u`. Un `@param` obsoleto que nombraba `WIZARD_FAMILY_CONFIRMATION` (cero llamadores) hizo que **tres agentes distintos, en dos días**, le afirmaran a Diego que el wizard manda esa confirmación; tuvo que desmentirlo tres veces y estuvo a punto de frenar un despliegue.

---

Los emails del wizard los **renderiza el KMS y los envía este proyecto** (①51). El recorrido es
siempre el mismo y vive en **UN solo sitio**, `_kmsRenderizarYEnviar_`:

1. **pedir el texto** — `sys-public.renderNotification` devuelve asunto y cuerpo ya renderizados,
   en el idioma que toque, saneados de marcadores sin resolver (clase #34), más el **nombre visible**
   y la **dirección de respuesta** que el colegio declaró. **No escribe nada.**
2. **enviar** — `sendAsAlias_`: mensaje RFC822 crudo por `Gmail.Users.Messages.send` desde
   `admissions@kaleide.org`; si el alias falla por lo que sea, **repliegue a `MailApp`** para que el
   correo llegue igual; si fallan los dos, `EMAIL_SEND_FAILED` (nunca un `{ok:true}` sobre un correo
   que no salió).
3. **dar el parte** — `sys-public.logNotificationSent` escribe en `sysNotificationLog` **la misma
   fila de siempre**, con el resultado REAL y el texto exacto. Son dos llamadas porque el resultado
   solo se conoce **después** de enviar. El cuerpo no vuelve a cruzar la red: el KMS lo guardó bajo
   el `correlation_id`. Si el parte falla, **el recorrido de la familia no se rompe** —el correo ya
   salió— pero se registra en claro que *«el aviso SÍ salió, pero no queda constancia de qué se
   mandó»*.

**El código de un solo uso (`WIZARD_OTP`) NO da parte, y es deliberado** (P253): el KMS **rechaza**
registrarlo —la ruta del parte solo admite las plantillas transaccionales— y tampoco guarda su
texto. No añadir su registro «por coherencia».

**Los tres puntos donde falla cerrado:** sin `NOTIFY_HMAC_SECRET` → `NOTIFY_NOT_CONFIGURED`; sin
texto del KMS → `EMAIL_RENDER_FAILED` (**no se inventa un cuerpo**); sin plantilla sembrada, el KMS
lanza en vez de devolver un cuerpo vacío.

Contrato de firma y proxy (sin cambios desde P213/P214):

- **UN solo sitio firma** todas las llamadas de correo al KMS: `_kmsCorreoFirmado_` — contrato
  canónico `{ template_code, recipient, context, nonce, timestamp, signature }` con
  `canonical = template_code\nrecipient\nJSON.stringify(context)\nnonce\ntimestamp`, idéntico a
  `notify-public.gs`. Antes ese cálculo estaba **copiado** en las dos funciones de envío; dos copias
  del mismo cálculo divergen.
- `sendViaKmsNotify_` y `sendViaKmsAuthCode_` **conservan su nombre y su firma**: los nueve puntos de
  llamada del fichero no se tocaron. Por dentro delegan en `_kmsRenderizarYEnviar_`.
- La **generación, cache y cupo del código** de un solo uso siguen aquí (lógica de auth); lo que pasa
  por el KMS es el texto, nunca la decisión.
- **`sys-public.sendNotification` y `sys-public.sendAuthCode` siguen existiendo en el KMS** y son las
  que usa TODO lo demás (el motor de avisos por hitos). Este proyecto ya no las llama.

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
