# 5. KMS (`kis-app` @ `develop`)

Añadido en la 2.ª pasada. La primera revisión no cubrió el KMS: el checkout sólo tenía `master`
(Assessment Matrix). Traído `origin/develop` a un árbol de trabajo aparte y revisado entero.

**Tamaño real** — el KMS es **23 veces** el wizard:

| | Ficheros | Líneas |
|---|---|---|
| `kms-server/` (GAS) | 234 `.gs` | **141.357** |
| `frontend/src` (React) | 287 `.js/.jsx` | **89.017** |
| `docs/` | 315 `.md` | 18 MB |

**Lo primero, porque cambia cómo se leen el resto de hallazgos**: la duplicación de bloques en el
KMS es **baja**. Medida con detector de clones (ventana de 15 líneas, normalizando espacios y
comentarios, creciendo hasta el clon maximal):

| | Líneas duplicadas | Sobre el total | Clones ≥25 líneas |
|---|---|---|---|
| `kms-server/` | 652 | **0,46 %** | 7 |
| `frontend/src` | 595 | **0,67 %** | 5 |

Para 230.000 líneas eso es **bueno**, y descarta el hallazgo fácil ("está lleno de copia-pega").
El problema del KMS no es que se repita el código: es **cómo habla con la base de datos**.

---

## Resumen

| # | Dónde | Problema | Evidencia |
|---|---|---|---|
| **M-1** | `_shared/db.gs:205` + 1.928 call-sites | **El 98,5 % de las lecturas se baja la TABLA ENTERA** por HTTP y filtra en memoria | medido: 29 de 1.928 usan Selector |
| **M-2** | `_shared/db.gs:160-191` · `_shared/cache.gs` | Las **dos** mitigaciones existen y están sin usar: memo por petición en **5** sitios, caché en **8** | medido |
| **M-3** | `enr/wizard-gateway.gs:909-1230` | Guardados del wizard: **un `db_insert` por fila hija**, y en salud/NEAE un `db_find` de tabla entera **por persona** | 9 bucles con BD dentro |
| **M-4** | `teaching/teaching.gs` | La Assessment Matrix **portada al KMS**, con su propia capa de transporte a AppSheet que **puentea `_shared/db.gs`** | 2 funciones que duplican `db_buildFindReq_`/`db_post_` |
| **M-5** | `enr/wizard-datalayer.gs:94` ↔ wizard `Code.js:5927` | El traductor de filtros está **copiado en los dos repos**; sólo uno tiene control de CI | copia verbatim |
| **M-6** | `frontend/` build | **2.449,70 kB en UN solo trozo**, 83 rutas, **cero** `React.lazy` | medido con `npm run build` |
| **M-7** | `frontend/src/lib/gas.js:26-75` | Los **50 ficheros de mocks (280 kB)** viajan en el bundle de producción pese al comentario que dice lo contrario | medido: `app-2026-001` aparece en `dist/assets/index.js` |
| **M-8** | 183 bucles | Llamada a BD dentro del cuerpo de un bucle en todo el servidor | medido |
| **M-9** | `sys/scheduled-rules.gs` | 5.640 líneas; concentra la mayor duplicación interna (62 líneas ×2, 26 ×3) y 13 bucles con BD | medido |
| **M-10** | raíz del repo | `client_secret_…json` **versionado y sin `.gitignore`** | adyacente, ver nota |

---

## M-1 · El 98,5 % de las lecturas se baja la tabla entera

**Dónde**: `_shared/db.gs:205` (`db_find`) y sus **1.928** call-sites.

El contrato está escrito en el propio JSDoc (`db.gs:194-196`):

> *Fetches **all rows** from a table and filters them in memory. Stage 1 limitation: AppSheet Find
> returns all rows; filtering is client-side.*

El tercer parámetro, `selector`, es el que hace que **AppSheet** filtre y devuelva sólo las filas
que importan. Medido sobre los 1.928 call-sites (analizador que equilibra paréntesis, no `grep`):

| Forma de la llamada | Call-sites | % | Qué viaja por la red |
|---|---:|---:|---|
| `db_find('tabla')` | 1.105 | **57,3 %** | la tabla entera |
| `db_find('tabla', {filtro})` | 794 | **41,2 %** | la tabla entera, y se filtra en JS |
| `db_find('tabla', null, selector)` | **29** | **1,5 %** | sólo las filas pedidas |

Tablas con más call-sites: `enrEnrollments` (61), `personalData_S` (60), **`sysStates_T` (58)**,
`enrPersons` (53), `docDocuments` (50).

`sysStates_T` es la misma tabla que el wizard midió en **10-13 s** por lectura completa
(`Kaleide-enrollment/backend/Code.js:3084`). En el KMS se lee desde 58 sitios distintos, casi
siempre entera.

**Por qué no es "así es AppSheet"**: el propio repo demuestra lo contrario. `enr_wizardHydrate`
(`enr/wizard-datalayer.gs:195-234`) usa selectores para **16 tablas** en una sola pasada paralela, y
el comentario de `:80-90` trae la medición que lo respalda —`recFiles`: 23 filas sin selector, **3**
con él—. La técnica está probada, documentada y funcionando; sólo se aplicó al camino del wizard.

**Arreglo — por capas, sin tocar 1.928 sitios**

1. **Ninguna reescritura masiva.** Priorizar por tabla × frecuencia: `sysStates_T`,
   `sysStateTransitions_T`, `sysMilestoneTypes`, `sysTenantMilestones_T` son **catálogos** — van al
   punto 2, no al selector. `enrEnrollments`, `personalData_S`, `enrPersons`, `docDocuments` son
   tablas de datos que crecen: ésas sí piden selector.
2. **Extraer el traductor de filtros a `_shared/`** (hoy vive en `enr/wizard-datalayer.gs:94`, ver
   M-5) y darle a `db_find` una forma cómoda —`db_findWhere(tabla, sqlFilter)`— que construya el
   Selector. Así el camino corto deja de ser el caro.
3. **Empezar por los handlers de lectura más llamados** (`enr/applications.gs`, `admin/people.gs`,
   `doc/documents.gs`), midiendo antes y después con `db_callStatsBegin_`/`db_callStatsEnd_`, que
   **ya existen** en `db.gs:142-157` justo para esto.

---

## M-2 · Las dos mitigaciones ya están construidas, y casi nadie las usa

Hay **dos** amortiguadores escritos, probados y documentados. Su adopción, medida:

**(a) Memo de lecturas por petición** — `db_readMemoEnable_` (`db.gs:160`) hace que la misma tabla
se baje **una sola vez por ejecución** en vez de una vez por `db_find`. Con el 98,5 % de lecturas
bajando tablas enteras, es exactamente el remedio.

> **Activado en 5 sitios**: `sys/template-sandbox.gs:198,538` · `sys/guarded-delete.gs:893` ·
> `fin/template-preview.gs:75` · `qb/api.gs:84`.

Los cinco son *sandbox*, *preview* y QB. **Ningún camino de lectura principal lo activa** — ni
`enr/applications.gs`, ni `admin/people.gs`, ni `doc/documents.gs`, ni `fin/subscriptions.gs`.

**(b) Caché** — `_shared/cache.gs` define `CACHE_TTL_CATALOG = 21600` (6 h, el máximo de GAS) y
documenta para qué es: *«Use ScriptCache for Capa 2/3 catalogs shared across users»*, con convención
de clave y todo (`'<schoolId>:<table>:<variant>:v1'`).

> **8 call-sites** de `cache_get`/`cache_set` en 141.357 líneas.

Es decir: la política de caché de catálogos está **escrita y no aplicada**. `sysStates_T` —58
call-sites, 10-13 s por lectura— no se cachea en ningún sitio.

**Arreglo, por orden de coste**

1. **Activar el memo en los handlers de lectura** (2 líneas por handler):

   ```javascript
   db_readMemoEnable_();
   try { /* … cuerpo actual, sin tocar … */ }
   finally { db_readMemoDisable_(); }
   ```

   Es aditivo y no cambia ni un filtro: sólo evita rebajar la misma tabla dentro de la misma
   ejecución. **Sólo en endpoints de LECTURA** — el propio módulo lo advierte, y con razón: en un
   handler que escribe, el memo puede servir una foto previa a la escritura.
2. **Cachear los catálogos** con el TTL que ya está declarado, empezando por `sysStates_T`,
   `sysStateTransitions_T`, `sysMilestoneTypes`, `sysEntityTypes`. Invalidar desde los handlers de
   administración que los editan (que son pocos y conocidos).
3. **Medir con lo que ya hay**: `db_callStatsBegin_()` / `db_callStatsEnd_()` alrededor del
   dispatcher, volcando `{n, tables}` al log. Da el número de llamadas HTTP reales por ruta y
   convierte esta sección en una lista de prioridades ordenada por medición y no por intuición.

---

## M-3 · Los guardados del wizard escriben fila a fila, y releen tablas enteras por persona

**Dónde**: `enr/wizard-gateway.gs` — los endpoints que **el wizard llama en el camino de una
familia real** (`enr.wizardSavePersons`, `wizardSaveHealth`, `wizardSaveNeae`,
`wizardSaveResponses`, `wizardPersistSubmitSideEffects`).

Bucles con llamada a base de datos **dentro del cuerpo**:

| Línea | Bucle | Dentro |
|---|---|---|
| `:909` | por nacionalidad | `db_insert('enrPersonNationalities')` |
| `:929` | por documento de identidad | `db_insert('enrPersonIDs')` |
| `:950` | por idioma | `db_insert('enrPersonLanguages')` |
| `:975` | por colegio anterior | `db_update` + `db_insert('enrPreviousSchools')` |
| `:1039` | por entrada de salud | **`db_find(tabla, {person_id})` — tabla ENTERA** + N `db_update` + N `db_insert` |
| `:1156` | por entrada NEAE | **2 × `db_find` de tabla entera** + N `db_update` + N `db_insert` |
| `:1356` | por respuesta | `db_update`/`db_insert('qbAnswers')` |
| `:316/:345/:385` | por transición / consentimiento / scope | `db_insert` uno a uno |

Una familia con 2 tutores y 2 solicitantes guardando el paso 4 dispara **decenas de peticiones HTTP
secuenciales**, y varias de ellas se bajan tablas completas.

**Lo que hace que esto sea fácil de arreglar**: `db_insertBatch(table, rows)` **ya existe**
(`_shared/db.gs:613`) y no se usa en ninguno de estos bucles.

**Arreglo**

1. **Acumular y escribir una vez por tabla.** En vez de `db_insert` dentro del `forEach`, juntar las
   filas y hacer un `db_insertBatch` por tabla al terminar el bucle. Mismas filas, mismo orden,
   mismos valores — sólo cambia el transporte.
2. **Sacar los `db_find` del bucle.** En salud (`:1069`) y NEAE (`:1169`, `:1207`) la lectura es por
   `person_id`: leer **una vez** para todos los `person_id` del trabajo (un `db_findMany`, o un
   `db_find` con selector `OR` sobre los ids — el patrón exacto está en
   `wizard-datalayer.gs:288-298`) e indexar en memoria por persona.
3. **Verificación obligatoria**: estos endpoints son escritura. El repo tiene `db_insertVerified_`
   y `db_updateVerified_` (`db.gs:580`, `:657`) para el rechazo silencioso de AppSheet (P72); al
   pasar a lote hay que conservar esa verificación —comprobando el número de filas devueltas por el
   `Add` en lote— o el fallo silencioso vuelve por la puerta de atrás.

---

## M-4 · La Assessment Matrix vive dos veces, y su copia del KMS puentea la capa de datos

**Dónde**: `kms-server/teaching/teaching.gs` (499 líneas) frente a `kis-app` @ `master` `Server.js`.

Su propio comentario lo dice (`teaching.gs:40`): *«Only active enrolled participants (**mirrors the
master branch FILTER selector**)»*. Consecuencias medidas:

1. **El selector gigante de alumnos, con su id mágico `HxhXOk9OSm4XuruAEjCu27`, está en 4 sitios**:
   `master/Server.js:283`, `:329`, `:460` y `develop/kms-server/teaching/teaching.gs:41`. Es el
   hallazgo K-4 de la primera pasada, ahora **cross-repo y cross-rama**.
2. **`teaching_req_` (`:63`) y `teaching_fetch_` (`:78`) duplican `db_buildFindReq_` (`db.gs:237`) y
   `db_post_` (`db.gs:790`)**: misma URL, mismas cabeceras, mismo cuerpo, mismo parseo. Y al
   puentear la capa compartida se pierden **todos** sus servicios: `db_isAbsentTable_` (P255), el
   memo de lecturas (M-2), y `db_callStatsCount_` — o sea, **este módulo es invisible al perfilador
   del propio repo**.
3. **La doble lectura de `educationLevel`** (`:243` Stage, `:245` Grade) está replicada tal cual
   desde `master/Server.js:455-458`. Una lectura y un `filter()` bastan.

El patrón "la URL de AppSheet fuera del helper compartido" es justo el que el wizard persigue en CI
como **transporte paralelo** (`Kaleide-enrollment/scripts/escrituras-directas.mjs`, cuarta forma).
Aquí no hay control equivalente, y por eso pasó.

**Arreglo**: `teaching_req_` → `db_buildFindReq_`; `teaching_fetch_` → `db_post_`/`db_find`;
`STUDENT_SELECTOR_` a una constante compartida. Y decidir **qué copia manda**: mientras la
Assessment Matrix siga viva en `master` y portada en `develop`, cualquier cambio de negocio hay que
hacerlo dos veces o divergen (que es exactamente lo que dice §"Anti-patrón estructural" de
`CLAUDE.md`: *nunca dejar DOS lectores del mismo dato que puedan diverger*).

---

## M-5 · El traductor de filtros está copiado en los dos repos; sólo uno tiene red

**Dónde**: `kms-server/enr/wizard-datalayer.gs:52-113` (`enr_wizardPartirNivelSuperior_` +
`enr_wizardSelector_`) ≡ `Kaleide-enrollment/backend/Code.js:5876-5946`
(`wizardPartirNivelSuperior_` + `wizardTraducirFiltro_`). Misma lógica, mismo troceo por nivel
superior, misma emisión `AND(...)`/`OR(...)`, hasta el mismo comentario con la misma medición del
2026-08-03.

El wizard tiene un control de CI que ejecuta **su** traductor y afirma sobre lo que produce
(`scripts/comprobar-selector-appsheet.mjs`, trabajo `selector-appsheet`, del que depende `build`).
**El KMS no tiene ninguno.** Si la copia del KMS deriva —un caso nuevo, una comilla, un paréntesis—
nada lo caza, y el modo de fallo es el ya conocido: AppSheet **no da error**, se queda con la primera
condición y devuelve de más.

Esto es literalmente lo que advierte el `CLAUDE.md` del wizard sobre el *otro* control:
*«Dos copias del mismo control divergen, y un control divergido miente»* — la lección se aplicó al
detector de escrituras y no al traductor.

**Arreglo (en este orden)**

1. **Ahora**: portar `comprobar-selector-appsheet.mjs` al KMS apuntando a `enr_wizardSelector_`, con
   los mismos casos. Barato, y cierra el agujero hoy.
2. **Después**: mover el traductor a `_shared/` dentro del KMS (donde además lo necesitan los otros
   1.899 call-sites, M-1 punto 2) y dejar **una** implementación por repo, cada una con su control.

**Nota de deriva ya visible**: el comentario IMPL-K de `wizard-datalayer.gs:258-267` sigue afirmando
que *«AppSheet NO honra el selector multi-cláusula `&&` server-side»* y por eso re-filtra en memoria.
Ese diagnóstico es el del **bug viejo**, ya corregido por `enr_wizardSelector_` unas líneas más
arriba. El re-filtrado no hace daño (es defensa en profundidad y así está declarado), pero el texto
induce a error: invita a la siguiente sesión a concluir que los selectores no sirven y a volver a
bajar tablas enteras. **Actualizar el comentario.**

---

## M-6 · 2,45 MB en un solo trozo, 83 rutas, cero carga diferida

**Medido** (`npm run build`, vite 5.4.21, 448 módulos):

```
dist/assets/index.css     40,37 kB │ gzip:   7,77 kB
dist/assets/vendor.js    266,68 kB │ gzip:  84,70 kB
dist/assets/index.js   2.449,70 kB │ gzip: 586,44 kB   ← todo el KMS, en uno
(!) Some chunks are larger than 500 kB after minification
```

Coincide con el artefacto publicado: `public/kms-app.js` son **2.457.191 bytes**.

**Cero** `React.lazy` y cero `import()` dinámico en las 89.017 líneas del frontend (comprobado). Las
**83 rutas** (`AdminWorld` 49, `ServicesWorld` 17, `PortalWorld` 12, `App` 5) se importan estáticas.
Resultado: un docente que sólo abre la matriz de evaluación descarga finanzas, documentos,
migraciones, administración de QB y el portal de familias.

**Además, el `manualChunks` que sí existe protege de algo que ya no aplica.** `vite.config.js:14-16`
lo justifica así: *«so each `<script>` block stays under ~894 KB — the empirical GAS
document.write() safe limit»*. Pero desde el flujo CDN (`CLAUDE.md` §"KMS deploy flow": la plantilla
GAS se queda en ~16 kB y el JS lo sirve jsDelivr) ese límite **ya no gobierna** — y de hecho
`index.js` lo triplica sin consecuencias. O sea: se separa `vendor` por un motivo caducado, y no se
separa lo que de verdad conviene.

**Arreglo**

1. **Partir por mundo**, que es la frontera natural y ya está en el árbol de ficheros:

   ```javascript
   const AdminWorld    = lazy(() => import('./worlds/admin/AdminWorld'));
   const ServicesWorld = lazy(() => import('./worlds/services/ServicesWorld'));
   const PortalWorld   = lazy(() => import('./worlds/portal/PortalWorld'));
   ```

   Con `<Suspense>` en el router. El portal de familias —el mundo con más usuarios y menos
   pantallas— deja de arrastrar el mundo de administración.
2. **Dentro de `admin`, partir las páginas gordas** por ruta: `ApplicationDetailPage` (3.347
   líneas), `DocumentDetailPage` (1.917), `AdminFinancePage` (1.853), `SubscriptionsTab` (1.691),
   `BankStatementsPage` (1.676).
3. **Actualizar el comentario de `vite.config.js`** para que diga el motivo vigente, o retirar el
   `manualChunks` de vendor si ya no cumple ninguna función.

**Cuidado con el despliegue**: `scripts/wrap-for-gas.js` lee **nombres de fichero fijos**
(`entryFileNames: 'assets/index.js'`) y envuelve **dos** trozos en IIFE. Partir en más trozos exige
actualizar ese script y `cdn-push.js` **en el mismo cambio**, o se publica un bundle incompleto —
y, por la regla de tags inmutables de jsDelivr, con un tag quemado.

---

## M-7 · Los 50 ficheros de mocks viajan a producción

**Dónde**: `frontend/src/lib/gas.js:26-75` — **49 `import` estáticos** de `./mocks/*.json`
(50 ficheros, **280 kB** en disco).

El fichero afirma que no es problema (`gas.js:82`): *«conserva MOCK_MODE=false literal (dead-code
eliminado, cero cambio)»*.

**Comprobado sobre el bundle construido, y no es así**:

| Marcador del mock | Veces en `dist/assets/index.js` |
|---|---|
| `app-2026-001` | **2** |
| `grp-2026-001` | **1** |
| `prog-admission-2026-27` | **2** |

Los datos de prueba están dentro del artefacto que se publica. Rollup elimina la **rama**
`if (MOCK_MODE)`, pero el objeto `MOCKS` sigue siendo alcanzable y arrastra los JSON importados.

**Arreglo**: cortar el vínculo estático, que es lo único que Rollup no puede deshacer solo —

```javascript
// Los mocks SOLO existen en el bundle de e2e/desarrollo.
const MOCKS = IS_E2E ? (await import('./mocks/index.js')).default : {};
```

o, más simple y sin `await` en el módulo: mover `MOCKS` a `gas.mocks.js`, importarlo con `import()`
dinámico dentro de la rama e2e, y dejar `gas.js` sin ninguna referencia estática a `./mocks/`.

**Verificación**: reconstruir y comprobar que `grep -c "app-2026-001" dist/assets/index.js` da **0**.
Es exactamente la comprobación que faltaba para que el comentario del código fuera cierto.

---

## M-8 · 183 bucles con una llamada a base de datos dentro

**Medido** con un detector que sigue las llaves (marca el cuerpo de cada `for`/`while`/`forEach`/
`map`/… y mira si dentro —excluyendo la línea de cabecera— cae `db_find`/`db_insert`/`db_update`/
`db_post_`/`UrlFetchApp.fetch`): **183** cuerpos de bucle.

Reparto por fichero: `sys/scheduled-rules.gs` 13 · `enr/wizard-gateway.gs` 9 (M-3) ·
`admin/people.gs` 8 · `qb/admin-write.gs` 8 · `mig/legacy-billing-diag.gs` 6 ·
`fin/tax-resolvable.gs` 5 · `sys/migration-f4.gs` 5 · `sys/rbac-functionalities.gs` 5 ·
`sys/signing.gs` 5.

**No todos son un defecto**, y conviene decirlo: en migraciones (`mig/`, `sys/migration-f*`) y en el
robot de limpieza (`_robot.gs`) escribir fila a fila es legítimo —son operaciones puntuales, no
caminos de usuario—. **La prioridad es lo que está en un camino de petición**: `enr/wizard-gateway`
(M-3), `admin/people`, `qb/admin-write`, `sys/signing`, `fin/*`.

**Arreglo**: el mismo de M-3 —`db_insertBatch` para las escrituras, y sacar las lecturas fuera del
bucle indexando en memoria—. Priorizar con `db_callStatsEnd_` en vez de a ojo: la ruta que más
llamadas HTTP haga es la que se toca primero.

---

## M-9 · `sys/scheduled-rules.gs`: 5.640 líneas, y donde más se repite el código

Es el fichero más grande del servidor y concentra a la vez las dos cosas:

- **La mayor duplicación interna del KMS**: clon de **62 líneas** (`:3468` ≡ `:3727`), de **26
  líneas ×3** (`:848`, `:3531`, `:3792`), de 15 ×3 (`:684`, `:3405`, `:3645`) y de 16 ×2 (`:4032` ≡
  `:4538`). Son ~190 de las 652 líneas duplicadas de todo `kms-server/`.
- **13 bucles con llamada a BD dentro** y 67 call-sites de `db_find`.

El patrón que se repite (tres copias casi iguales alrededor de `:848` / `:3531` / `:3792`) sugiere
tres variantes del mismo evaluador de reglas que fueron creciendo por separado.

**Arreglo**: antes de tocar nada, **leer las tres copias juntas y decidir cuál es la buena** — es
código de motor, y la regla §"refactors preservan el código probado" aplica en su forma más
estricta: la versión que funciona **es** la especificación. Unificar en un solo evaluador con
parámetros, con un test de caracterización que compare, sobre las mismas reglas de entrada, las
acciones que produce la versión vieja y la nueva. Es el trabajo de más riesgo de esta lista y el que
menos conviene hacer con prisa.

---

## M-10 · `client_secret_….json` versionado en la raíz (adyacente, no es optimización)

**Dónde**: `client_secret_402626947179-….apps.googleusercontent.com.json`, en la raíz del repo,
commit `ef2079a9` *«New client secret»*, y **no está en `.gitignore`**.

Es de tipo `installed` (cliente de escritorio — el de `clasp`). Conviene la precisión: Google y el
RFC 8252 asumen que el secreto de un cliente *installed* **no puede mantenerse secreto**, así que
esto **no es** una filtración de credencial de servidor. Pero sigue siendo un fichero de credenciales
en la historia de git de un repositorio con acceso compartido, y el patrón invita a que el día que
se añada un cliente *web* (ése sí confidencial) acabe en el mismo sitio.

**Arreglo**: añadir `client_secret_*.json` a `.gitignore`, sacar el fichero del árbol
(`git rm --cached`), y guardarlo fuera del repo. Reescribir la historia sólo si se decide rotar el
cliente — para un cliente *installed* no es urgente.

---

## Qué NO es un problema en el KMS (comprobado)

- **La duplicación de bloques es baja**: 0,46 % en el servidor, 0,67 % en el frontend. No hace falta
  una campaña anti-copia-pega.
- **Los selectores multi-cláusula escritos a mano están BIEN**: los ~30 que hay en `sys/sequences`,
  `sys/import-*`, `doc/templates` usan `AND(...)` como **función**. Buscado el patrón infijo en todo
  `kms-server/`: **cero coincidencias**. El defecto del 2026-08-03 está cerrado en el código.
- **`enr_wizardHydrate` es el ejemplo a seguir, no a arreglar** (`enr/wizard-datalayer.gs:195-234`):
  16 tablas con selector en una pasada paralela, hints a los consumidores para evitar viajes aguas
  abajo, y `softFail` por tabla. Es el patrón que M-1 y M-2 piden extender al resto.
- **La capa de datos está bien pensada**: `db_findMany` (paralelo), memo por petición, prewarm,
  omisión de tablas ausentes, verificación de escritura contra el rechazo silencioso de AppSheet y
  contador de llamadas. El problema no es que falte infraestructura — es que **no se usa** (M-2).
- **El frontend usa React Query y `useMemo` con criterio**; el problema del cliente es de empaquetado
  (M-6, M-7), no de renders.

---

**Índice de la revisión** · [00-README](00-README.md) · [01 backend del wizard](01-wizard-backend.md) · [02 frontend del wizard](02-wizard-frontend.md) · [03 Assessment Matrix](03-assessment-matrix.md) · [04 integración continua](04-integracion-continua.md) · [05 KMS](05-kms.md)
