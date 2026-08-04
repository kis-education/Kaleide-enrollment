# 3. Assessment Matrix (`kis-app` @ `master`)

## K-1 · Cada carga hace 20 llamadas a AppSheet y termina **borrando** la caché

**Dónde**: `JavaScript.html:578-608` (cliente) + `Server.js:255-317` (servidor).

Secuencia real, en cadena, en cada carga de la app:

| Paso | Llamada | Lecturas AppSheet | Caché |
|---|---|---|---|
| 1 | `getStudentsAndLevels` | 2 (`personalData_S`, `educationLevel`) | lee/escribe `quickData_v1` |
| 2 | `initAppData` | 9 — **incluidas otra vez** alumnos y niveles | lee/escribe `initAppData_v2` |
| 3 | `refreshAppData` | 9 | **`cache.remove(...)` y vuelve a bajarlo todo** |

`refreshAppData` (`Server.js:313-317`) empieza por `CacheService.getUserCache().remove(CACHE_KEY)`.
Como el cliente lo llama **incondicionalmente** al terminar el paso 2 ("Keep cache warm",
`JavaScript.html:599`), el efecto neto es el contrario del que busca: la caché de 30 min **nunca
sobrevive** a la carga que la creó. El paso 2 sirve de caché sólo dentro de la misma sesión de
navegador; la siguiente carga vuelve a pagar las 9 lecturas frías. Y si el usuario abre la pestaña de
Impacts, `getACEData` añade 6 más (una de ellas, alumnos otra vez).

**Arreglo**

1. **Quitar la llamada a `refreshAppData` del arranque** (`JavaScript.html:599-605`). Dejarla
   colgada de un botón explícito de "recargar datos", que es para lo que sirve.
2. **Que el paso 1 sea de verdad un subconjunto**: `initAppData` ya devuelve `students` y `levels`;
   `getStudentsAndLevels` sólo debería usarse si `initAppData_v2` **no** está en caché. Con la caché
   viva (tras el punto 1), la carga típica pasa a **0 lecturas AppSheet**.
3. Si se quiere refresco en segundo plano de verdad, hacerlo *stale-while-revalidate*: servir la
   caché, y sólo re-bajar cuando el contenido tenga más de X minutos — **sin** borrar antes de bajar
   (hoy, si la re-bajada falla, el usuario se queda sin caché y sin datos).

**Impacto**: de 20 lecturas a 2-9 en la primera carga, y a ~0 en las siguientes dentro de la ventana
de 30 min.

---

## K-2 · React de desarrollo y Babel transpilando en el navegador, en producción

**Dónde**: `Index.html:21-23`.

**Medido en esta sesión** (descarga real desde unpkg):

| Recurso servido hoy | Bytes | Alternativa | Bytes |
|---|---|---|---|
| `react-dom@18.3.1/umd/react-dom.**development**.js` | **1.080.227** | `…production.min.js` | 131.835 |
| `react@18.3.1/umd/react.**development**.js` | **109.931** | `…production.min.js` | 10.751 |
| `@babel/standalone@7.24.7/babel.min.js` | **2.866.178** | — (ver abajo) | 0 |
| **Total** | **4.056.336 B ≈ 4,06 MB** | | **142.586 B ≈ 0,14 MB** |

Además de los bytes, el build de desarrollo de React ejecuta todas sus comprobaciones y avisos en
cada render, y Babel Standalone **transpila las 3.431 líneas de `JavaScript.html` en el hilo
principal en cada carga**, antes de que se pinte nada.

**Arreglo, en dos pasos de riesgo muy distinto**

1. **Inmediato y casi sin riesgo** — cambiar las dos URL a `production.min.js` en `Index.html:21-22`.
   Ahorra **1,05 MB** por carga y acelera cada render. Único cuidado: los avisos de React dejan de
   verse en consola (que es justo el punto de la build de producción).
2. **Mayor, con más ganancia** — precompilar el JSX y quitar Babel del navegador (−2,87 MB y el
   tiempo de transpilado). El repo hermano ya tiene la tubería montada
   (`kis-app/CLAUDE.md` §"KMS deploy flow": `vite build` → `wrap-for-gas.js` → CDN
   `kaleideschool/public`). Aplicar la misma receta a la Assessment Matrix. **Requiere** decidir el
   flujo de despliegue antes de tocar nada: hoy `JavaScript.html` se edita y se sube con `clasp push`
   sin paso de build.

Nota: `master` es la app **en uso real por el staff** — el punto 1 es un cambio de dos líneas
verificable abriendo la app; el punto 2 es un proyecto y necesita su ventana.

---

## K-3 · Cinco llamadas a AppSheet escritas a mano; el constructor de peticiones se ignora

**Dónde**: `Server.js:194` (`buildFetchRequest_`, el bueno), `:209` (`appsheetAdd_`), `:227`
(`singleFetch_`), `:680` (`updateObservation`), `:724` (dentro de `replaceObservationPrinciples`),
`:784` (`updateAssessment`).

Las cinco últimas repiten a mano la URL
(`https://api.appsheet.com/api/v2/apps/${APP_ID}/tables/${table}/Action`), la cabecera
`applicationAccessKey`, `muteHttpExceptions` y el envoltorio `{Action, Rows}`. `singleFetch_` es
especialmente llamativo: hace `Find` **sin usar** `buildFetchRequest_`, que existe justo encima y
construye exactamente esa petición.

Consecuencia concreta: la URL de AppSheet aparece en 5 sitios. En el wizard, ese mismo patrón
—"transporte paralelo", la URL fuera del helper— es una de las **cuatro formas** que persigue
`scripts/escrituras-directas.mjs`, precisamente porque dispersa el punto donde se usan las
credenciales.

**Arreglo**: un único

```javascript
function appsheetAction_(table, action, rows, selector) { … }   // Find | Add | Edit | Delete
```

`buildFetchRequest_` se queda como el constructor que alimenta a `fetchAll`; `appsheetAction_` lo
reutiliza para el caso de una sola llamada. Los cinco sitios pasan a una línea cada uno, y la URL y
la clave quedan en **un** punto.

---

## K-4 · El selector de alumnos, copiado tres veces; `educationLevel`, bajado dos veces seguidas

**Dónde**: `Server.js:283`, `:329` y `:460` — la misma expresión de 200 caracteres, incluido el id
mágico `"HxhXOk9OSm4XuruAEjCu27"`, **tres veces literal**. Si cambia el estado de "participante"
hay que acordarse de los tres.

**Arreglo**: `const SELECTOR_ALUMNOS_ACTIVOS = \`FILTER("${T.STUDENTS}", …)\`;` junto a `T`, y el id
mágico como constante con nombre (`const ESTADO_ACTIVO_ID = 'HxhXOk9OSm4XuruAEjCu27';`) y un
comentario de qué fila es.

**Y además**, en `getACEData` (`:455-458`):

```javascript
buildFetchRequest_(T.EDU_LEVELS, `FILTER("${T.EDU_LEVELS}", [level_type] = "Stage")`),
buildFetchRequest_(T.EDU_LEVELS, `FILTER("${T.EDU_LEVELS}", [level_type] = "Grade")`),
```

Dos peticiones a la **misma tabla** para partirla por una columna. Es una sola lectura y un
`filter()` en memoria (la tabla ya se baja entera en `_fetchAndCacheAppData:338`). Ahorra una
petición y deja el desglose donde se usa.

Los tres bucles de parseo de respuestas (`:290-299`, `:348-366`, `:466-483`) son también la misma
rutina triplicada: mismo `getResponseCode()`, mismo `JSON.parse` con `try/catch`, mismo formato de
error. Extraer `parsearLote_(raw, nombres)` y usarla en las tres.

---

---

**Índice de la revisión** · [00-README](00-README.md) · [01 backend del wizard](01-wizard-backend.md) · [02 frontend del wizard](02-wizard-frontend.md) · [03 Assessment Matrix](03-assessment-matrix.md) · [04 integración continua](04-integracion-continua.md)
