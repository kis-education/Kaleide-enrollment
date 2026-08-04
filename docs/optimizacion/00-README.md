# Revisión de optimización — 2026-08-04

Barrido de los tres repos de la sesión en busca de **duplicación, trabajo repetido, lecturas
redundantes y bucles caros**. Cada hallazgo lleva **archivo:línea**, la evidencia con la que se
sostiene (medida cuando se pudo medir), y la instrucción concreta de arreglo.

**Alcance revisado**

| Repo / rama | Qué es | Tamaño revisado |
|---|---|---|
| `Kaleide-enrollment` @ `main` | Wizard de inscripción (GAS + React) | `backend/Code.js` 10.101 líneas · `frontend/src` ~7.000 |
| `kis-app` @ `master` | Assessment Matrix (app legacy en producción) | `Server.js` 798 · `JavaScript.html` 3.431 |
| `public` | Bundle CDN del KMS (artefacto compilado) | no procede — es salida de build |

> El KMS (`kis-app` @ `develop`) **no está en este checkout**: sólo existen `master` y la rama de
> trabajo. Todo lo que aquí se dice de `kis-app` se refiere a la Assessment Matrix.

**Regla que se ha seguido**: nada se afirma "por lectura del comentario". Donde el código dice un
número (p. ej. «states 10-13s»), se cita como medición **del propio repo**; donde se ha podido
medir aquí (bundles, pesos de CDN, conteos), va el número medido en esta sesión.

---

## Resumen ordenado por impacto

| # | Dónde | Problema | Impacto estimado |
|---|---|---|---|
| **W-1** | `backend/Code.js:3633,3784` | `sysStates_T` se lee ENTERA **dos veces** en la misma petición de recuperación, sin caché y sin los *hints* que el camino gemelo sí usa | **10-26 s** por recuperación |
| **W-2** | `backend/Code.js:3216,3301,3390` | Tres resolutores de firma con el **mismo preámbulo copiado**; en el camino de recuperación cada uno relee sesiones + firmantes | hasta **6 lecturas** seriales (≈9-12 s medidos en el propio código) |
| **W-3** | `backend/Code.js:6362-6366` | La verja de firma hace hasta **10 lecturas** donde bastan 3; `sysMilestoneTypes` (catálogo estático) se baja 5 veces | **~6-10 s** por acto de firma |
| **W-4** | `backend/Code.js:7245+7269/7298` · `3486-3500` | `requireResumeToken_` tira la fila que acaba de leer ⇒ segunda lectura idéntica; y la regla TTL/abandono está **duplicada y divergible** | 1 lectura extra por hidratación + riesgo de divergencia |
| **F-1** | `frontend/src/pages/ConsentPage.jsx` | Copia de `LandingPage.jsx` **ya divergida**: llama a `initEnrollmentSession` directo y ramifica en cliente — justo lo que WIZ-ENUM eliminó. Ruta viva `/consent` | corrección de seguridad revertida de facto en una ruta alcanzable |
| **K-1** | `kis-app/JavaScript.html:578-608` | Cada carga: `getStudentsAndLevels` → `initAppData` → `refreshAppData`, que **borra la caché** ⇒ 20 llamadas a AppSheet y caché de 30 min inservible entre cargas | ~2× el tiempo de arranque, siempre |
| **K-2** | `kis-app/Index.html:21-23` | React en build de **desarrollo** + Babel Standalone transpilando en el navegador | **4,06 MB** descargados por carga (medido) |
| **W-5** | `backend/Code.js:5956,6058` | `appsheetRequest_` y `appsheetRequestBatch_` duplican saneado, selector y parseo | divergencia futura |
| **F-2** | `frontend/src/context/WizardContext.jsx:1114` | El `value` del Provider es un objeto literal nuevo en cada render + tic de 30 s ⇒ **todo** re-renderiza cada 30 s; los 33 `useCallback` no sirven de nada | re-render global periódico |
| **W-6** | `backend/Code.js:2017,7804` | `kmsProxy_` en bucle serie existiendo ya `_wzKmsFetchAll_` (paralelo) | N× latencia en limpiezas |
| **F-3** | `frontend/src/components/DevLogger.jsx:17` | `package.json` entero incrustado en el bundle de producción | bytes + inventario de dependencias publicado |
| **K-3** | `kis-app/Server.js` (5 sitios) | Cinco llamadas a AppSheet escritas a mano; `singleFetch_` ignora `buildFetchRequest_` | duplicación pura |
| **K-4** | `kis-app/Server.js:283,329,460` | El selector gigante de alumnos, **copiado 3 veces**; `educationLevel` se baja 2 veces seguidas en `getACEData` | duplicación + 1 lectura de más |
| **W-7** | `backend/Code.js:3852-3884` | Enriquecido de personas: 10 `.filter()` sobre listas completas **por persona** | O(P×R) evitable |
| **F-5** | `frontend/` build | Sin *code-splitting* por ruta: 565 kB en un solo trozo; 232 de los 240 kB de CSS son Bootstrap entero | primera carga |
| **W-8** | `backend/Code.js` | 1.896 líneas (19 %) de `manual_*`/admin en el mismo archivo que el dispatcher anónimo | mantenimiento + riesgo |
| **F-6** | `frontend/package.json` | `react-bootstrap` declarado y **jamás importado** (7,6 MB en `node_modules`) | instalación de CI |
| **C-1** | `.github/workflows/deploy.yml` | 4 comprobaciones de ~1 s, cada una en su propio runner; Playwright se descarga sin caché en cada empujón | minutos de CI |

**Dónde está desarrollado cada hallazgo** (con la instrucción de arreglo):
`W-*` → [01-wizard-backend.md](01-wizard-backend.md) ·
`F-*` → [02-wizard-frontend.md](02-wizard-frontend.md) ·
`K-*` → [03-assessment-matrix.md](03-assessment-matrix.md) ·
`C-*` → [04-integracion-continua.md](04-integracion-continua.md).
Cada documento se queda por debajo del tope de 500 líneas de §"Máximo 500 líneas por documento vivo".

---

# Orden de ataque sugerido

**Primero — barato, medible, sin cambiar comportamiento**

1. **K-2 punto 1**: dos URL de `Index.html` → `production.min.js`. −1,05 MB por carga.
2. **K-1 punto 1**: quitar `refreshAppData` del arranque. La caché de 30 min empieza a servir.
3. **F-6**: desinstalar `react-bootstrap`.
4. **F-3**: `__APP_VERSION__` en vez de importar `package.json`.
5. **C-2**: cachear Playwright.

**Después — el grueso de la latencia del wizard** (cada uno con su `manual_*` de caracterización que
compare nº de lecturas y ms antes/después, según §"refactors preservan el código probado")

6. **W-1**: hints + caché de `sysStates_T` en el camino de recuperación.
7. **W-3**: un lote para los hitos + caché del catálogo de tipos.
8. **W-2**: cargador único de sesión/firmantes.
9. **W-4**: la verja devuelve la fila.

**Luego — duplicación con riesgo de divergencia**

10. **F-1**: resolver `/consent` (unificar o borrar) — y ampliar `ack-indistinguible` si se queda.
11. **W-5**, **K-3**, **K-4**: helpers únicos de acceso a AppSheet.
12. **F-2**: `useMemo` del `value` + ticker dirigido.

**Cuando toque, con su ventana**

13. **W-8**: separar `manual_*` (y ampliar el control de CI a `backend/*.gs`).
14. **F-5**: división por rutas + poda del CSS.
15. **K-2 punto 2**: precompilar el JSX de la Assessment Matrix.

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

**Índice de la revisión** · [00-README](00-README.md) · [01 backend del wizard](01-wizard-backend.md) · [02 frontend del wizard](02-wizard-frontend.md) · [03 Assessment Matrix](03-assessment-matrix.md) · [04 integración continua](04-integracion-continua.md)
