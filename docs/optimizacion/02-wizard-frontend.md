# 2. Wizard — frontend (`Kaleide-enrollment/frontend/src`)

## F-1 · `ConsentPage` es una copia de `LandingPage` que ya divergió (y en seguridad)

**Dónde**: `pages/ConsentPage.jsx` (220 líneas) vs `pages/LandingPage.jsx` (222). Ruta viva en
`App.jsx:90` (`/consent`), y `WizardPage` navega a ella cuando falla la rehidratación.

Ambos ficheros comparten, casi línea por línea: layout `wizard-layout`, bloque de consentimiento
GDPR bilingüe, modal de privacidad, honeypot, reCAPTCHA, validación de email y estados de error.
Lo que **no** comparten es lo importante:

| | `LandingPage` | `ConsentPage` |
|---|---|---|
| Llamada | `sendMagicLink` — **una sola** | `initEnrollmentSession` **directo** |
| Decisión recuperar-vs-crear | servidor | **cliente** (`setResumeToken(data.resumed ? … )`) |
| Siembra estado desde la respuesta | no (acuse constante) | **sí** (`setEnrollmentGroupId`, `setRecognition`) |

Es decir: `ConsentPage` sigue haciendo exactamente lo que WIZ-ENUM (§"sendMagicLink — ack constante
anti-enumeración", punto 3) eliminó de la landing — *«el cliente ya no puede ramificar»* — y lo hace
en una ruta que un usuario puede alcanzar. La batería `ack-indistinguible` cubre `/`, **no**
`/consent`, así que este camino no está vigilado.

**Arreglo (elegir uno, no ambos)**

- **Si `/consent` debe existir**: extraer el tronco común a `components/PortadaConsentimiento.jsx`
  (layout + GDPR + modal + honeypot + validación) y que las dos páginas sean sólo el manejador de
  envío. `ConsentPage` pasa a usar `sendMagicLink` como la landing. Añadir `/consent` al camino
  `ack-indistinguible` de la batería **en el mismo cambio**.
- **Si no debe existir** (lo que sugiere el modelo canónico de entrada única): borrarla y cambiar el
  `navigate('/consent')` de `WizardPage` por `navigate('/')`.

**Esto no es sólo limpieza**: mientras `/consent` viva como está, la corrección anti-enumeración
está revertida en una de las dos puertas.

---

## F-2 · El `value` del contexto se recrea en cada render, y hay un tic de 30 s que fuerza renders

**Dónde**: `context/WizardContext.jsx:1114` (el `<WizardContext.Provider value={{ … }}>`) y
`:494-498` (el `setInterval` de 30 s de `freshnessTick`).

El provider pasa un **objeto literal nuevo** en cada render. En React eso significa que **todo**
consumidor de `useWizard()` re-renderiza siempre que el provider renderice, sin importar qué campo
haya cambiado. Los **33** `useCallback`/`useMemo` del fichero (medidos) están estabilizando
funciones que después viajan dentro de un objeto inestable: no evitan ni un render.

Encima hay un ticker que **provoca** un render del provider cada 30 s, por diseño
(`:491-493`: *«fuerza re-render periódico para que el gate de entrada vuelva a aparecer cuando expira
la frescura»*). Es decir: cada 30 s re-renderiza el árbol entero del wizard —incluido
`Step2Persons` (1.045 líneas) y el visor de PDF—, esté o no cerca de expirar la ventana.

**Arreglo**

1. Envolver el valor: `const value = useMemo(() => ({ … }), [ …dependencias reales… ]);` y
   `<WizardContext.Provider value={value}>`. Con los `useCallback` que ya existen, la lista de
   dependencias son casi sólo los estados.
2. Sustituir el ticker ciego por uno **dirigido**: en vez de latir cada 30 s siempre, programar un
   único `setTimeout` para el instante `stepUpVerifiedUntil` (cuando expira de verdad) y
   reprogramarlo en `markStepUpFresh` / `revokeStepUpFresh`. Un render en el momento exacto en vez
   de 120 renders por hora.
3. Opcional, si tras 1 y 2 sigue habiendo renders caros: partir el contexto en dos providers
   (datos del expediente / estado de sesión-firma), que es lo que hace que un cambio de
   `admissionState` no toque a quien sólo lee `stepData`.

**Comprobación**: React DevTools Profiler, o el criterio que la batería ya mide —el avance óptimista
≤200 ms de `guardar-paso`— no debe empeorar.

---

## F-3 · El `package.json` entero viaja en el bundle de producción

**Dónde**: `components/DevLogger.jsx:17` → `import pkg from '../../package.json';`

**Comprobado**: tras `npm run build`, `dist/assets/index-*.js` contiene literalmente
`"react-bootstrap":"^2.10.10","react-dom":"^18.3.1",…` — el manifiesto completo, con `scripts` y
`devDependencies`.

**Arreglo**: en `vite.config.js`

```javascript
import { readFileSync } from 'node:fs';
const { version } = JSON.parse(readFileSync('./package.json', 'utf8'));
export default defineConfig({
  plugins: [react()],
  base: '/',
  define: { __APP_VERSION__: JSON.stringify(version) },
});
```

y en `DevLogger.jsx` usar `__APP_VERSION__` en vez de `pkg.version` (declararlo en el `globals` del
`eslint.config.js`).

---

## F-4 · El panel de depuración se publica y está encendido por defecto en producción

**Dónde**: `App.jsx:57-69` (`shouldShowDevLogger`, *default ON*) + `components/DevLogger.jsx` (317
líneas, entra siempre en el trozo principal).

Está **documentado y decidido** así a propósito (`App.jsx:38-56`) mientras el wizard sea un
prototipo, así que no es un defecto: es deuda con fecha de caducidad. Se anota aquí sólo porque el
propio comentario dice *«entonces se re-gatea a opt-in»* y ese momento —familias reales— es el
mismo en el que conviene además **cargarlo con `React.lazy`**, para que ni el código ni sus 317
líneas entren en el trozo inicial de quien no lo abre.

---

## F-5 · Sin división por rutas: 565 kB en un solo trozo; el CSS es Bootstrap entero

**Medido** (`npm run build`, vite 5.4.21):

```
dist/assets/index-BA5Qy1-P.js     565,50 kB │ gzip: 162,42 kB
dist/assets/index-BKxntCHc.css    239,74 kB │ gzip:  33,07 kB
dist/assets/pdf-BQ2CYUUw.js       531,32 kB │ gzip: 161,17 kB   ← ya perezoso ✓
dist/assets/pdf.worker.min-*.mjs 1.299,17 kB                    ← ya perezoso ✓
(!) Some chunks are larger than 500 kB after minification
```

Lo de `pdfjs` está **bien resuelto** (`components/PdfViewer.jsx:44-51`, `import()` diferido). Lo que
falta:

1. **Rutas**: `App.jsx:4-12` importa las 7 páginas de forma estática. Una familia en la portada
   descarga el wizard completo, los 11 pasos y el tramo de firma. `React.lazy` + el `<Suspense>`
   que **ya está puesto** en `App.jsx:85`:

   ```javascript
   const WizardPage = lazy(() => import('./pages/WizardPage'));
   ```

   Aplicarlo al menos a `WizardPage`, `ConfirmationPage` y `PrivacyPolicyPage`.
2. **CSS**: `main.jsx:5` importa `bootstrap/dist/css/bootstrap.min.css` entero — **232 de los
   239,74 kB**; el CSS propio (`theme.css`) son 12,6 kB. Se usan ~70 familias de clases distintas
   (medido sobre los `className` del código). Dos vías: importar sólo las partes de Bootstrap que se
   usan desde el SCSS fuente, o pasar el CSS por PurgeCSS en el build. Ojo: hay clases construidas
   dinámicamente, así que PurgeCSS necesita `safelist`.

---

## F-6 · `react-bootstrap` está declarado y no se usa

**Comprobado**: `grep -rn "react-bootstrap" src/ e2e/` → **cero** referencias. La única aparición en
`dist/` es el texto del `package.json` incrustado por F-3. Pesa **4,3 MB** (+3,3 MB de `@restart`)
en `node_modules`, que CI instala en cada empujón (`npm ci` en los trabajos `e2e` y `build`).

**Arreglo**: `npm uninstall react-bootstrap` y confirmar que la batería sigue VERDE.

---

## F-7 · Cuatro pares de funciones casi idénticas en `api.js`

**Dónde**: `api.js:13-18` (`prefetchLookups`) vs `:47-54` (`fetchLookups`); `:324-336`
(`prefetchQuestions`) vs `:338-357` (`fetchQuestions`).

En cada par, el cuerpo es el mismo salvo por qué hace con el resultado (uno devuelve la promesa, el
otro la descarta) y por el `catch` (uno traga, otro relanza).

**Arreglo**: un `_asegurar(clave, cargar)` que devuelva siempre la promesa en vuelo o el valor
cacheado; `prefetchX` queda como `_asegurar(...).catch(() => {})`. Menor, pero mantiene sincronizadas
las tres capas de caché (módulo / `sessionStorage` / `localStorage`), que hoy hay que tocar por
duplicado.

---

---

**Índice de la revisión** · [00-README](00-README.md) · [01 backend del wizard](01-wizard-backend.md) · [02 frontend del wizard](02-wizard-frontend.md) · [03 Assessment Matrix](03-assessment-matrix.md) · [04 integración continua](04-integracion-continua.md) · [05 KMS](05-kms.md)
