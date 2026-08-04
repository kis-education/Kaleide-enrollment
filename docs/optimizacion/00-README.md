# Revisión de optimización — 2026-08-04

Barrido de los repos de la sesión en busca de **duplicación, trabajo repetido, lecturas
redundantes y bucles caros**. Cada hallazgo lleva **archivo:línea**, la evidencia con la que se
sostiene (medida cuando se pudo medir), y la instrucción concreta de arreglo.

**Alcance revisado**

| Repo / rama | Qué es | Tamaño revisado |
|---|---|---|
| `kis-app` @ `develop` | **KMS** (GAS + React) | `kms-server/` **141.357** líneas · `frontend/src` **89.017** |
| `Kaleide-enrollment` @ `main` | Wizard de inscripción (GAS + React) | `backend/Code.js` 10.101 · `frontend/src` ~7.000 |
| `kis-app` @ `master` | Assessment Matrix (app legacy en producción) | `Server.js` 798 · `JavaScript.html` 3.431 |
| `public` | Bundle CDN del KMS (artefacto compilado) | no procede — es salida de build |

> **2.ª pasada (misma fecha): añadido el KMS.** La primera versión de este documento se hizo con un
> checkout que sólo tenía `master`, así que **no cubrió el KMS** — y el KMS es el **95 %** del
> código de este sistema (230.000 de 248.000 líneas). Traído `origin/develop` y revisado entero;
> los hallazgos están en [05-kms.md](05-kms.md) y entran en la tabla y en el orden de ataque de
> abajo. Lo dicho de `kis-app` @ `master` sigue refiriéndose a la Assessment Matrix.

**Regla que se ha seguido**: nada se afirma "por lectura del comentario". Donde el código dice un
número (p. ej. «states 10-13s»), se cita como medición **del propio repo**; donde se ha podido
medir aquí (bundles, pesos de CDN, conteos de call-sites, presencia de datos en el artefacto
publicado), va el número medido en esta sesión, con el método al lado.

---

## Resumen ordenado por impacto

Los cinco primeros son del KMS, y no por ser nuevos: es donde está el 95 % del código y donde el
trabajo repetido se multiplica por cada petición de cada usuario.

| # | Dónde | Problema | Impacto estimado |
|---|---|---|---|
| **M-1** | `kms-server/_shared/db.gs:205` + 1.928 call-sites | **El 98,5 % de las lecturas se baja la TABLA ENTERA** por HTTP y filtra en memoria (29 de 1.928 usan Selector) | sistémico — toca cada petición |
| **M-2** | `kms-server/_shared/db.gs:160` · `_shared/cache.gs` | Las **dos** mitigaciones ya están escritas y sin usar: memo por petición en **5** sitios, caché en **8** de 141.357 líneas | el remedio ya está construido |
| **M-3** | `kms-server/enr/wizard-gateway.gs:909-1230` | Guardados del wizard fila a fila (`db_insert` por hija) + `db_find` de tabla entera **por persona**; `db_insertBatch` existe y no se usa | decenas de peticiones por guardado |
| **M-6** | `kis-app/frontend` build | **2.449,70 kB en UN trozo**, 83 rutas, **cero** `React.lazy` | 2,45 MB por carga, medido |
| **M-7** | `kms-server/../lib/gas.js:26-75` | Los **50 mocks (280 kB)** viajan en el bundle publicado pese al comentario que lo niega | medido en `dist` |
| **W-1** | `backend/Code.js:3633,3784` | `sysStates_T` se lee ENTERA **dos veces** en la misma petición de recuperación, sin caché y sin los *hints* que el camino gemelo sí usa | **10-26 s** por recuperación |
| **W-2** | `backend/Code.js:3216,3301,3390` | Tres resolutores de firma con el **mismo preámbulo copiado**; en el camino de recuperación cada uno relee sesiones + firmantes | hasta **6 lecturas** seriales (≈9-12 s medidos en el propio código) |
| **W-3** | `backend/Code.js:6362-6366` | La verja de firma hace hasta **10 lecturas** donde bastan 3; `sysMilestoneTypes` (catálogo estático) se baja 5 veces | **~6-10 s** por acto de firma |
| **W-4** | `backend/Code.js:7245+7269/7298` · `3486-3500` | `requireResumeToken_` tira la fila que acaba de leer ⇒ segunda lectura idéntica; y la regla TTL/abandono está **duplicada y divergible** | 1 lectura extra por hidratación + riesgo de divergencia |
| **F-1** | `frontend/src/pages/ConsentPage.jsx` | Copia de `LandingPage.jsx` **ya divergida**: llama a `initEnrollmentSession` directo y ramifica en cliente — justo lo que WIZ-ENUM eliminó. Ruta viva `/consent` | corrección de seguridad revertida de facto en una ruta alcanzable |
| **K-1** | `kis-app/JavaScript.html:578-608` | Cada carga: `getStudentsAndLevels` → `initAppData` → `refreshAppData`, que **borra la caché** ⇒ 20 llamadas a AppSheet y caché de 30 min inservible entre cargas | ~2× el tiempo de arranque, siempre |
| **K-2** | `kis-app/Index.html:21-23` | React en build de **desarrollo** + Babel Standalone transpilando en el navegador | **4,06 MB** descargados por carga (medido) |
| **M-4** | `kms-server/teaching/teaching.gs` | La Assessment Matrix **portada al KMS**, con transporte propio a AppSheet que puentea `_shared/db.gs` (y con ello el memo, el perfilador y P255) | duplicación cross-repo |
| **M-5** | `kms-server/enr/wizard-datalayer.gs:94` ↔ wizard `Code.js:5927` | El traductor de filtros, **copiado en los dos repos**; sólo el del wizard tiene control de CI | riesgo del fallo silencioso del 2026-08-03 |
| **W-5** | `backend/Code.js:5956,6058` | `appsheetRequest_` y `appsheetRequestBatch_` duplican saneado, selector y parseo | divergencia futura |
| **F-2** | `frontend/src/context/WizardContext.jsx:1114` | El `value` del Provider es un objeto literal nuevo en cada render + tic de 30 s ⇒ **todo** re-renderiza cada 30 s; los 33 `useCallback` no sirven de nada | re-render global periódico |
| **W-6** | `backend/Code.js:2017,7804` | `kmsProxy_` en bucle serie existiendo ya `_wzKmsFetchAll_` (paralelo) | N× latencia en limpiezas |
| **F-3** | `frontend/src/components/DevLogger.jsx:17` | `package.json` entero incrustado en el bundle de producción | bytes + inventario de dependencias publicado |
| **K-3** | `kis-app/Server.js` (5 sitios) | Cinco llamadas a AppSheet escritas a mano; `singleFetch_` ignora `buildFetchRequest_` | duplicación pura |
| **K-4** | `kis-app/Server.js:283,329,460` | El selector gigante de alumnos, **copiado 3 veces**; `educationLevel` se baja 2 veces seguidas en `getACEData` | duplicación + 1 lectura de más |
| **W-7** | `backend/Code.js:3852-3884` | Enriquecido de personas: 10 `.filter()` sobre listas completas **por persona** | O(P×R) evitable |
| **F-5** | `frontend/` build | Sin *code-splitting* por ruta: 565 kB en un solo trozo; 232 de los 240 kB de CSS son Bootstrap entero | primera carga |
| **W-8** | `backend/Code.js` | 1.896 líneas (19 %) de `manual_*`/admin en el mismo archivo que el dispatcher anónimo | mantenimiento + riesgo |
| **M-8** | `kms-server/` (183 bucles) | Llamada a base de datos dentro del cuerpo de un bucle | priorizar los que están en camino de petición |
| **M-9** | `kms-server/sys/scheduled-rules.gs` | 5.640 líneas: ~190 de las 652 duplicadas del servidor y 13 bucles con BD | el de más riesgo al tocar |
| **M-10** | `kis-app/` raíz | `client_secret_….json` versionado y sin `.gitignore` (adyacente, no es optimización) | ver matiz en el documento |
| **F-6** | `frontend/package.json` | `react-bootstrap` declarado y **jamás importado** (7,6 MB en `node_modules`) | instalación de CI |
| **C-1** | `.github/workflows/deploy.yml` | 4 comprobaciones de ~1 s, cada una en su propio runner; Playwright se descarga sin caché en cada empujón | minutos de CI |

**Dónde está desarrollado cada hallazgo** (con la instrucción de arreglo):
`M-*` → [05-kms.md](05-kms.md) ·
`W-*` → [01-wizard-backend.md](01-wizard-backend.md) ·
`F-*` → [02-wizard-frontend.md](02-wizard-frontend.md) ·
`K-*` → [03-assessment-matrix.md](03-assessment-matrix.md) ·
`C-*` → [04-integracion-continua.md](04-integracion-continua.md).
Cada documento se queda por debajo del tope de 500 líneas de §"Máximo 500 líneas por documento vivo".

**Lo que NO resultó ser el problema, y conviene saberlo antes de empezar**: la duplicación de
bloques en el KMS es **baja** — 0,46 % en el servidor (652 líneas de 141.357) y 0,67 % en el
frontend (595 de 89.017), medido con detector de clones. No hace falta una campaña anti-copia-pega:
el coste del KMS está en **cómo habla con la base de datos**, no en cuántas veces se repite.

---

# Orden de ataque sugerido

**Paso 0 — MEDIR, porque la instrumentación ya está puesta y no se está usando**

0. Envolver el dispatcher del KMS con `db_callStatsBegin_()` / `db_callStatsEnd_()`
   (`_shared/db.gs:142-157`) y volcar `{n, tables}` al log por ruta. Sale **el número real de
   llamadas HTTP por endpoint**, y con él esta lista deja de estar ordenada por juicio y pasa a
   estarlo por medición. Es media hora y reordena todo lo que viene detrás.

**Primero — barato, medible, sin cambiar comportamiento**

1. **M-2 punto 1**: activar `db_readMemoEnable_()` en los handlers de **lectura** del KMS (2 líneas
   por handler, aditivo, sin tocar filtros). Es el mayor retorno por línea escrita de toda la lista.
2. **M-7**: sacar los mocks del bundle del KMS (`import()` dinámico), y verificar con
   `grep -c "app-2026-001" dist/assets/index.js` → 0.
3. **K-2 punto 1**: dos URL de `Index.html` → `production.min.js`. −1,05 MB por carga.
4. **K-1 punto 1**: quitar `refreshAppData` del arranque. La caché de 30 min empieza a servir.
5. **F-6**: desinstalar `react-bootstrap`. · **F-3**: `__APP_VERSION__` en vez de importar
   `package.json`. · **C-2**: cachear Playwright.

**Después — donde está el grueso del tiempo** (cada uno con su test de caracterización que compare
nº de lecturas y ms antes/después, según §"refactors preservan el código probado")

6. **M-3**: `db_insertBatch` en los guardados del wizard + sacar los `db_find` de los bucles de
   salud y NEAE. Es el camino de una familia real.
7. **M-2 punto 2**: cachear los catálogos (`sysStates_T` el primero) con el `CACHE_TTL_CATALOG` que
   ya está declarado.
8. **W-1**: hints + caché de `sysStates_T` en el camino de recuperación del wizard.
9. **W-3**: un lote para los hitos + caché del catálogo de tipos. · **W-2**: cargador único de
   sesión/firmantes. · **W-4**: la verja devuelve la fila.
10. **M-1 punto 3**: selectores en los handlers de lectura más llamados **según lo medido en el
    paso 0** — no a ojo, y no los 1.928 de golpe.

**Luego — duplicación con riesgo de divergencia**

11. **M-5**: portar el control de CI del traductor de filtros al KMS (barato, cierra el agujero hoy);
    después, una sola implementación en `_shared/`. Y corregir el comentario IMPL-K, que sigue
    describiendo el bug viejo e invita a volver a bajar tablas enteras.
12. **F-1**: resolver `/consent` (unificar o borrar) — y ampliar `ack-indistinguible` si se queda.
13. **M-4**: `teaching.gs` sobre `_shared/db.gs`, y decidir qué copia de la Assessment Matrix manda.
14. **W-5**, **K-3**, **K-4**: helpers únicos de acceso a AppSheet.
15. **F-2**: `useMemo` del `value` + ticker dirigido.

**Cuando toque, con su ventana**

16. **M-6**: partir el bundle del KMS por mundo — **y actualizar `wrap-for-gas.js` + `cdn-push.js`
    en el mismo cambio**, o se publica un bundle incompleto con un tag ya quemado.
17. **M-8**: bucles con BD que estén en camino de petición (los de `mig/` y `_robot.gs` pueden
    quedarse).
18. **W-8**: separar `manual_*` (y ampliar el control de CI a `backend/*.gs`).
19. **F-5**: división por rutas + poda del CSS del wizard.
20. **M-9**: unificar los tres evaluadores de `scheduled-rules.gs` — el de más riesgo, con test de
    caracterización y sin prisa. · **K-2 punto 2**: precompilar el JSX de la Assessment Matrix.

---

## Qué NO es un problema (comprobado, para que nadie lo "arregle")

- **`pdfjs` no está en el trozo principal** — `PdfViewer.jsx:44-51` ya lo carga con `import()`
  diferido, y el build lo confirma (`pdf-*.js` y `pdf.worker.min-*.mjs` son trozos aparte).
- **El sondeo del wizard ya es de dos etapas** — `WizardPage.jsx:150-190`: `getLiveStateVersion`
  (contador en ScriptCache, sin tocar AppSheet ni el KMS) y sólo si sube, `getAdmissionState`.
  Además salta el tic con la pestaña oculta, con un guardado en vuelo, o con otro sondeo en curso.
- **`api.js` ya de-duplica las llamadas en vuelo** — *single-flight* por token en
  `initiateSigningRead` y caché de bytes por `file_id` en `getDocumentBytes`.
- **`getAdmissionState_` ya está optimizado** — `Code.js:3987-4032` es el lote paralelo con hints
  que W-1 y W-2 piden replicar en el camino de recuperación. El patrón correcto ya existe en la
  casa; sólo se aplicó a uno de los dos llamantes.
- **La Assessment Matrix está bien memoizada en cliente** — `JavaScript.html` usa `useMemo` para los
  índices por id (`:1555-1560`) en vez de barrer listas dentro del render.

---

**Índice de la revisión** · [00-README](00-README.md) · [01 backend del wizard](01-wizard-backend.md) · [02 frontend del wizard](02-wizard-frontend.md) · [03 Assessment Matrix](03-assessment-matrix.md) · [04 integración continua](04-integracion-continua.md) · [05 KMS](05-kms.md)
