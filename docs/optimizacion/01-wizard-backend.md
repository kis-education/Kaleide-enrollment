# 1. Wizard — backend (`Kaleide-enrollment/backend/Code.js`)

## W-1 · `sysStates_T` se lee entera dos veces por recuperación (y sin caché)

**Dónde**
- `Code.js:3097` — `buildAdmissionContext_`: `appsheetRequest_(T.STATES_T, 'Find', [], {})` (sin filtro).
- `Code.js:3784` — `buildResumeSessionData_`, comprobación de reapertura: **la misma lectura otra vez**.
- `Code.js:3633` — `buildResumeSessionData_` llama a `buildAdmissionContext_(id, enrollments, recoveredGuardianId, persons)` **con 4 argumentos**: no pasa `admHints`.

**Por qué importa.** El propio código midió el coste y lo dejó escrito en `Code.js:3084`:

> `Medido: states_ms 10-13s + 2×(sessions+signers) ~9-12s seriales.`

Ese hallazgo se arregló **sólo en un camino**: `getAdmissionState_` (`:3987-4005`) mete `STATES_T`,
`EMAILS` y `SIGNING_SESSIONS` en el lote paralelo y los pasa como *hints*. El camino de
**recuperación** (`resumeSession_` → `buildResumeSessionData_`), que es el que ve la familia al
abrir su enlace, se quedó fuera: paga los 10-13 s **dos veces** (una en `buildAdmissionContext_`,
otra en la comprobación de reapertura de `:3784`), en serie.

Además `sysStates_T` es un **catálogo de tenant**: cambia cuando el staff toca la configuración de
estados, no dentro de la sesión de una familia. Hoy no se cachea en ningún sitio (los únicos cachés
son `wz_hyd/res/adm/doc/mem` y `rtmemo_`, todos por grupo o por token).

**Arreglo (dos pasos, independientes)**

1. **Pasar los hints que ya existen.** En `buildResumeSessionData_`, añadir `STATES_T` (y
   `SIGNING_SESSIONS`) al lote de `:3600-3609` y pasarlos a `buildAdmissionContext_` en `:3633`,
   copiando **literalmente** la forma del lote de `getAdmissionState_:3987-4005` (mismos filtros,
   misma construcción de `signersBySession` de `:4018-4032`). Reutilizar el mismo `allStates` para
   la comprobación de reapertura de `:3784` en vez de releer.
2. **Cachear el catálogo.** Helper nuevo, junto a los demás `_wz*`:

   ```javascript
   /** Catálogo de estados del tenant — estático dentro de una sesión. TTL 10 min. */
   function _catalogoEstados_() {
     var cache = CacheService.getScriptCache();
     var raw = _wzCacheGetChunked_(cache, 'wz_cat_states');
     if (raw) { try { return JSON.parse(raw); } catch (e) { /* miss */ } }
     var rows = appsheetRequest_(T.STATES_T, 'Find', [], {}) || [];
     try { _wzCachePutChunked_(cache, 'wz_cat_states', JSON.stringify(rows), 600); } catch (e) {}
     return rows;
   }
   ```

   y sustituir las dos lecturas crudas por `_catalogoEstados_()` cuando no haya hint.

**Riesgo**: bajo. No cambia filtros ni mapeos — cumple la regla §"refactors preservan el código
probado" porque el lote de `getAdmissionState_` **es** el lector probado que se copia.

**Comprobación**: `manual_*` de caracterización que imprima, para un `resume_token` real, el número
de llamadas AppSheet y los ms totales antes/después (el patrón de `PERF2_` ya existe).

---

## W-2 · Tres resolutores de firma con el mismo preámbulo copiado

**Dónde**: `Code.js:3216` (`resolveSigningStatus_`), `:3301` (`resolveSigningContextFromSession_`),
`:3390` (`resolveGuardianSigningContext_`).

Los tres empiezan con **el mismo bloque, palabra por palabra**:

1. `assertValidUuid_(groupId, …)` en `try/catch`;
2. sesiones: `sessionsHint` si es array, si no `Find` sobre `sysSigningSessions` con
   `"entity_id" = <grupo>`;
3. elección de sesión (dos criterios distintos — ésta es la única diferencia real);
4. firmantes: `signersBySessionHint[session_id]` si existe, si no `Find` sobre
   `sysSigningSessionSigners` con `"session_id" = …`;
5. filtro en memoria + log redactado.

Son ~40 líneas triplicadas. Y en el camino de recuperación (W-1: sin hints) `buildAdmissionContext_`
puede llamar a los tres (`:3127`, `:3145`, `:3170`) ⇒ **hasta 6 lecturas AppSheet seriales** para
mirar exactamente las mismas dos tablas.

**Arreglo**

```javascript
/**
 * Carga UNA vez las sesiones de firma del grupo y los firmantes de sus sesiones vivas.
 * Los tres resolutores consumen ESTA carga; ninguno vuelve a leer.
 * @returns {{sessions:Array, signersBySession:Object}}
 */
function _cargarFirmaDelGrupo_(groupId, sessionsHint, signersBySessionHint) { … }
```

- Construirlo copiando **verbatim** los `Filter` actuales (`"entity_id" = "…"` y
  `"session_id" = "…"`, con `appsheetEscape_`), sin rediseñar nada.
- Los firmantes de varias sesiones vivas van en **un solo** `appsheetRequestBatch_`, igual que ya
  hace `getAdmissionState_:4022`.
- Los tres resolutores pasan a recibir `{sessions, signersBySession}` y quedarse **sólo** con su
  lógica de elección/filtrado (que es lo único que difiere).
- `buildAdmissionContext_` llama a `_cargarFirmaDelGrupo_` una vez y reparte.

**Ganancia**: de hasta 6 lecturas a 2, y ~80 líneas menos.

---

## W-3 · La verja de firma hace hasta 10 lecturas donde bastan 3

**Dónde**: `Code.js:6362-6366`, dentro de `resolveSigningToken_` — que es lo que ejecutan
`requireSigningToken_` y `requireSignerContext_`, o sea **la verja de todos los endpoints de firma**.

```javascript
const billingConfirmed = isMilestoneCompleted_('ENR_ADMISSION_SCHOOL', enrollmentGroupId, 'BILLING_STEP_COMPLETED');
const gdprCompleted    = isDurableSigningMilestoneCompleted_(enrollmentGroupId, signer['signer_person_id'], 'GDPR_CONSENTS_SUBMITTED')
                      || isMilestoneCompleted_('SYS_SIGNING_SESSION_SIGNER', signerId, 'GDPR_CONSENTS_SUBMITTED');
const reviewCompleted  = isDurableSigningMilestoneCompleted_(enrollmentGroupId, signer['signer_person_id'], 'REVIEW_CONFIRMED')
                      || isMilestoneCompleted_('SYS_SIGNING_SESSION_SIGNER', signerId, 'REVIEW_CONFIRMED');
```

Cada una de esas 5 llamadas (`:6193` y `:6226`) hace **dos** lecturas: `sysMilestones` filtrado por
`entity_id` **+ `sysMilestoneTypes` ENTERA, sin filtro**. Y sólo hay **dos** `entity_id` distintos
(el grupo y el firmante). Resultado: hasta **10 lecturas** para responder a tres booleanos, con el
catálogo de tipos bajado **cinco veces seguidas**.

**Arreglo**

1. Un lote único al principio del bloque:

   ```javascript
   const lote = appsheetRequestBatch_([
     { table: T.MILESTONES,      action: 'Find', selector: { Filter: '"entity_id" = "' + appsheetEscape_(enrollmentGroupId) + '"' } },
     { table: T.MILESTONES,      action: 'Find', selector: { Filter: '"entity_id" = "' + appsheetEscape_(signerId) + '"' } },
     { table: T.MILESTONE_TYPES, action: 'Find', selector: {} },
   ]);
   ```
2. `isMilestoneCompleted_` e `isDurableSigningMilestoneCompleted_` pasan a aceptar
   `(…, hints)` con `{milestones, codeByTypeId}` y, con hints, **no leen nada** (mismo patrón
   `admHints` que ya usa `buildAdmissionContext_` — es la convención de la casa).
3. `sysMilestoneTypes` es catálogo estático: cachearlo igual que W-1 (`wz_cat_mstypes`, TTL 10 min).

Las dos funciones además **son casi la misma**: `isDurableSigningMilestoneCompleted_` es
`isMilestoneCompleted_` con `entity_type_code` fijo y una condición extra sobre
`evidence_metadata_json.guardian_person_id`. Unificar en una sola con parámetro opcional
`guardianPersonId` elimina ~30 líneas y garantiza que el invariante del catálogo
(`milestone_type_id → code`) sólo se implemente una vez.

---

## W-4 · La verja lee la fila del grupo y la tira; la regla de validez está duplicada

**Dónde**
- `Code.js:475-528` — `requireResumeToken_` hace `Find` sobre `enrEnrollmentGroups`, valida
  `abandoned_at` + TTL 7 días… y **devuelve sólo el `enrollment_group_id`**.
- `Code.js:7245` — `hydrateSession_` llama a `requireResumeToken_(p)` y acto seguido, en `:7269`
  (rama sin step-up) o `:7298` (rama fresca), **repite el mismo `Find` con el mismo filtro**.
- `Code.js:3459-3500` — `resumeSession_` **no** usa la verja: se hace su propio `Find` y
  **reimplementa** la comprobación de `abandoned_at` y el TTL de 7 días. El propio comentario de
  `:494` lo admite: *«We mirror the exact canonical logic from resumeSession_»*.

Dos copias de la misma regla de negocio ("qué es un token válido") que pueden diverger, y una
lectura AppSheet extra por hidratación.

**Arreglo**

```javascript
/** Verja canónica que además DEVUELVE la fila ya leída (nadie tiene que releerla). */
function requireResumeTokenRow_(payload) {
  // … cuerpo actual de requireResumeToken_ …
  return { groupId: tokenGroupId, group: group };
}
function requireResumeToken_(payload) { return requireResumeTokenRow_(payload).groupId; }
```

- `hydrateSession_:7245` → `const { groupId, group } = requireResumeTokenRow_(p);` y **borrar** los
  `Find` de `:7269` y `:7298`.
- `resumeSession_:3459-3500` → sustituir su `Find` + sus dos comprobaciones por
  `requireResumeTokenRow_(p)`, conservando los mensajes de error de cara al usuario (son distintos a
  propósito: *«This application was abandoned…»* vs *«Unauthorized…»*) mediante un `try/catch` que
  traduzca el código.

**Cuidado**: `requireResumeTokenMemo_` (`:449`) cachea sólo el id. Si un llamante necesita la fila,
debe ir por `requireResumeTokenRow_` (camino vivo); el memo se queda como está para las lecturas que
sólo necesitan el id.

---

## W-5 · `appsheetRequest_` y `appsheetRequestBatch_` duplican el mismo contrato

**Dónde**: `Code.js:5956` y `Code.js:6058`.

Está copiado, idéntico, en ambas: `sanitize_` (`:5972-5982` ≡ `:6065-6075`), la construcción del
`Selector` con `wizardTraducirFiltro_` (`:5985-5992` ≡ `:6085-6092`), y el parseo de respuesta
—`Rows || rows`, detección de `parsed.error`, rechazo silencioso de Add/Edit con 0 filas—
(`:6016-6030` ≡ `:6133-6148`).

Un cambio en el contrato de AppSheet (un campo nuevo, otra forma de error) hay que hacerlo hoy en
dos sitios; si sólo se hace en uno, las lecturas por lote y las sueltas empiezan a interpretar la
misma respuesta de forma distinta — exactamente la clase de fallo silencioso que documenta
§"Los filtros a AppSheet".

**Arreglo**: extraer tres helpers privados —`_asSanear_(row)`, `_asCuerpo_(spec)`,
`_asInterpretar_(spec, statusCode, text)`— y que las dos funciones públicas queden como lo único que
de verdad las diferencia: `UrlFetchApp.fetch` (lanza) vs `UrlFetchApp.fetchAll` (nunca lanza,
devuelve `{ok,…}` por posición). **No cambiar ninguna semántica** — el gate
`comprobar-selector-appsheet.mjs` seguirá vigilando la forma del filtro, y conviene ejecutarlo antes
y después.

---

## W-6 · `kmsProxy_` en bucle serie, teniendo ya el transporte paralelo escrito

**Dónde**
- `Code.js:2016-2026` — `initEnrollmentSession_` abandona los "perdedores" uno a uno.
- `Code.js:7804-7816` — `adminCleanupOrphanSessions` abandona N sesiones una a una.

`_wzKmsFetchAll_` (`:1174`) ya hace exactamente esto en paralelo con `UrlFetchApp.fetchAll`, con el
mismo sobre y el mismo bearer — pero **sólo lo usan las dos fases del warm** (`:1322`, `:1475`).

**Arreglo**: en ambos bucles, construir la lista y lanzarla de una:

```javascript
var res = _wzKmsFetchAll_(losers.map(function (l) {
  return { action: 'enr.wizardAbandonSession', payload: { resume_token: l.resume_token } };
}));
```

`_wzKmsFetchAll_` devuelve `null` por posición cuando falla, que es justo la semántica
*best-effort* que los dos sitios ya quieren (hoy lo consiguen con `try/catch` por vuelta).
Conservar el log redactado por posición.

---

## W-7 · Enriquecido de personas: 10 barridos por persona

**Dónde**: `Code.js:3852-3884`.

```javascript
const enrichedPersons = persons.map(person => ({
  …,
  nationalities: nationalities.filter(n => n.person_id === pid),
  ids:           personIds_.filter(x => x.person_id === pid),
  languages:     languages.filter(x => x.person_id === pid),
  emails:        allEmails.filter(e => e.person_id === pid),
  …               // 10 en total, + 2 .find() sobre personAddrJoins
}));
```

Con P personas y R filas por tabla es O(P × R) por cada una de las 10 tablas. Hoy P es pequeño
(2-6), así que **no es urgente**; se anota porque el arreglo es trivial y elimina el patrón antes de
que crezca.

**Arreglo**: un agrupador de una línea, aplicado una vez por tabla:

```javascript
function _porPersona_(filas) {
  var m = {};
  (filas || []).forEach(function (r) { (m[r.person_id] = m[r.person_id] || []).push(r); });
  return m;
}
```

y en el `map`: `nationalities: idxNacionalidades[pid] || []`. Pasa a O(P + R).

---

## W-8 · 1.896 líneas de utilidades de editor dentro del archivo del dispatcher anónimo

**Medido**: de las 10.101 líneas de `Code.js`, **1.896 (19 %)** pertenecen a las 43 funciones
`manual_*` más `adminUnblockEmail` / `adminCleanupOrphanSessions`.

Ese código **no es alcanzable desde `doPost`** (correcto), pero vive en el mismo archivo que el
`switch(action)` público. Consecuencias reales: el archivo no cabe en una lectura, y la regla de
CLAUDE.md §"Antes de cada push a main… verificar con grep que no se introdujeron cases con olor a
debug" existe precisamente porque la frontera es sólo convención.

**Arreglo**: mover a `backend/Manual.gs` (y, si se quiere, `backend/Diag.gs`). En Apps Script todos
los `.gs` del proyecto comparten **un único espacio global**: no hay imports que arreglar y `clasp
push` sube el directorio entero. `Code.js` baja a ~8.200 líneas y la frontera pasa a ser física.

**Verificación**: tras mover, `node scripts/comprobar-escrituras-directas.mjs` debe seguir VERDE —
ojo, ese control lee **`backend/Code.js`**; hay que ampliarlo para que recorra `backend/*.gs`
también, o las excepciones de la lista blanca (`manual_testApplicationEditRejectionOnSubmitted`,
`manual_repairRequesterEmailLink`) dejarían de estar vigiladas al cambiar de archivo.

---

---

**Índice de la revisión** · [00-README](00-README.md) · [01 backend del wizard](01-wizard-backend.md) · [02 frontend del wizard](02-wizard-frontend.md) · [03 Assessment Matrix](03-assessment-matrix.md) · [04 integración continua](04-integracion-continua.md)
