# 4. Integración continua (`.github/workflows/deploy.yml`)

## C-1 · Cuatro comprobaciones de un segundo, cuatro runners

**Dónde**: trabajos `escrituras-directas`, `selector-appsheet`, `receptor-firmado`,
`pantalla-del-cliente`.

Los cuatro son idénticos en forma: `checkout` → `setup-node@v4` → `node scripts/comprobar-X.mjs`. La
documentación de cada uno dice *«~1 s: sólo lee ficheros»*, pero cada trabajo arranca su propio
runner (~15-25 s de arranque + checkout + node). Se pagan ~4 arranques para ~4 segundos de trabajo.

**Arreglo**: un solo trabajo `controles-estaticos` con cuatro `steps` (cada uno con su `name`, así
la interfaz de GitHub sigue mostrando cuál falló) y `build: needs: [e2e, controles-estaticos]`. Se
pierde el paralelismo entre cuatro cosas que tardan un segundo; se ganan tres arranques de runner.

## C-2 · Playwright se descarga entero en cada empujón

**Dónde**: trabajo `e2e`, paso *Install Playwright*:

```yaml
npm install --no-save playwright
npx playwright install --with-deps chromium
```

Sin caché, en cada empujón a `main`. La descarga de Chromium son ~120-150 MB.

**Arreglo**: cachear el directorio de navegadores entre ejecuciones —

```yaml
- uses: actions/cache@v4
  with:
    path: ~/.cache/ms-playwright
    key: pw-${{ runner.os }}-chromium
```

— antes del paso de instalación. `playwright install` detecta el navegador ya presente y sale.
(El `--with-deps` instala paquetes de sistema y no se cachea; se puede dejar como está o separarlo.)

## C-3 · La batería recorre sus 6 caminos en serie porque comparte estado global

**Dónde**: `frontend/e2e/run-wizard.mjs:2397-2420` — bucle `for (const def of seleccionados)`, un
`browser.newContext()` por camino, en serie.

La razón por la que no se pueden paralelizar hoy está en el propio bucle: antes de cada camino se
reinicializan **variables de módulo compartidas** —`calls = []`, `unmockedActions = new Set()`,
`registrosDbg = []`, `enVuelo.n = 0`, `cuotaDelCamino`, `transporteDelCamino`,
`degradacionesDelCamino`—. Dos caminos a la vez se pisarían las evidencias mutuamente, y el arnés
juzga con esas variables.

**Arreglo** (sólo si el tiempo de CI molesta; no toca el producto): encapsular ese estado en un
objeto por camino (`const ctx = nuevoContextoDeCamino()`) que se pase a los ayudantes en vez de leer
del módulo, y luego lanzar los caminos con una concurrencia pequeña (2-3; más satura el runner y
falsearía la medición de *«avance óptimista ≤200 ms»* de `guardar-paso`, que **debe** quedar en
serie o con la máquina tranquila).

**Precaución**: el veredicto único (`VEREDICTO: VERDE|ROJO`) y el conteo de caminos declarados tienen
que seguir siendo exactos con concurrencia — es el muro de despliegue.

---

---

**Índice de la revisión** · [00-README](00-README.md) · [01 backend del wizard](01-wizard-backend.md) · [02 frontend del wizard](02-wizard-frontend.md) · [03 Assessment Matrix](03-assessment-matrix.md) · [04 integración continua](04-integracion-continua.md)
