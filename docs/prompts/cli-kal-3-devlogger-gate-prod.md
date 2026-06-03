````
# OBLIGATORIO
La PRIMERA LÍNEA literal del reporte final debe ser exactamente:
**CLI KAL-3 — DevLogger gate prod + console.log hygiene (KAL-NEW-6)** finalizado.

# Lectura obligatoria previa
Lee estos archivos antes de operar para tener contexto sin re-derivarlo:
1. `/home/user/Kaleide-enrollment/CLAUDE.md` — convenciones wizard + branch canónico `main` + flow `clasp push --force` + `clasp deploy --deploymentId AKfycbyzyAR6J3_2UAiE6tCyNHVawoGfMNNbZEaurp99cRI76IYbiqGVEeQQcTxsgAqUFnGk0w`.
2. `/home/user/kis-app/docs/kms/plan/readiness-2026-06-03/06-security-findings-integration.md` §4 (KAL-NEW-6) — _"mismo patrón que KIS-8 KMS-side"_.
3. `/home/user/Kaleide-enrollment/frontend/src/App.jsx` línea 65 (`<DevLogger />`) + `frontend/src/logger.js` (redactor canónico KAL-11).
4. `/home/user/Kaleide-enrollment/frontend/src/components/DevLogger.jsx` (componente que renderiza el panel flotante).

# Misión
Cerrar **KAL-NEW-6** del audit 2026-05-30: el componente `<DevLogger />` se renderiza siempre en `App.jsx` → cualquier familia con devtools abiertos o pantalla compartida ve el panel flotante con logs (que llevan redacción KAL-11 pero igualmente exponen flujo + estados internos). En el KMS, el equivalente KIS-8 ya está gateado a runtime (Script Property / build flag); aquí aplicamos el mismo patrón.

# Trabajo paso a paso

1. **Preparar repo** (working directory = `/home/user/Kaleide-enrollment`):
   ```bash
   cd /home/user/Kaleide-enrollment
   git fetch origin main && git status
   # Trabajar SIEMPRE sobre main — NO crear branches.
   ```

2. **Investigación inicial**:
   ```bash
   ls /home/user/Kaleide-enrollment/frontend/src/components/DevLogger.jsx
   grep -n "DevLogger\|process\.env\|import\.meta\.env" /home/user/Kaleide-enrollment/frontend/src/App.jsx /home/user/Kaleide-enrollment/frontend/src/components/DevLogger.jsx
   cat /home/user/Kaleide-enrollment/frontend/package.json | head -20
   cat /home/user/Kaleide-enrollment/frontend/vite.config.* 2>/dev/null | head -30
   ```
   Confirma:
   - ¿El wizard frontend usa Vite? (Si sí: `import.meta.env.PROD` está disponible.)
   - ¿O un build script custom? (entonces deducir cómo detectar prod.)

3. **Implementar gate**:

   **Opción A (preferida si Vite)**: gate por `import.meta.env.PROD` (falsy en dev `npm run dev`, truthy en build). En `App.jsx`:
   ```jsx
   import DevLogger from './components/DevLogger'
   // ...
   {!import.meta.env.PROD && <DevLogger />}
   ```

   **Opción B (si build custom)**: añadir Script Property en el backend `WIZARD_DEV_LOGGER_ENABLED` y exponerla via un nuevo endpoint público de healthcheck (sin payload sensible) — pero esto añade superficie. Preferir Opción A salvo que Vite no esté.

   **Opción C (mínimo viable)**: gatear por hostname del navegador en runtime:
   ```jsx
   const isDevHost = typeof window !== 'undefined' && (
     window.location.hostname === 'localhost' ||
     window.location.hostname === '127.0.0.1' ||
     window.location.hostname.endsWith('.local')
   );
   {isDevHost && <DevLogger />}
   ```
   Esto cubre el caso real (Diego corre `localhost:5173` en dev) y deja `admissions.kaleide.org` sin el panel.

   Elige Opción A si Vite está; sino Opción C como fallback. Documenta la elección en el commit message.

4. **Console.log hygiene** (parte del KAL-NEW-6 — `console.log` directos saltan el redactor):
   - `grep -rnE "^(\s+)?console\.(log|debug|info)" /home/user/Kaleide-enrollment/frontend/src/` y para cada match (excluyendo `frontend/src/logger.js` que es el redactor canónico):
     - Si el log es informativo del flow → reemplazar por `log.info(...)` (import desde `'./logger'`).
     - Si es debug temporal → eliminar.
     - NO crear más vectores de leak. La redacción canónica vive en `logger.js`.
   - Si la lista es grande (>20 sitios), reportar al final y cubrir solo los call-sites en `pages/` + `components/` que no estén dentro de un guard `if (isDev)`. Los `console.error` los puedes dejar (errores son menos sensibles que info).

5. **Build + deploy frontend** (frontend del wizard, no del KMS):
   ```bash
   cd /home/user/Kaleide-enrollment/frontend
   # Verifica primero cómo se build el frontend del wizard:
   ls package.json && cat package.json | head -30
   # Si Vite: npm run build (o el script equivalente)
   # El frontend del wizard NO va a CDN externa — está servido como assets estáticos.
   # Verificar cómo se sirve hoy (GitHub Pages? Apps Script? El CLAUDE.md menciona admissions.kaleide.org).
   ```
   Revisa `.github/workflows/deploy.yml` para el deploy real del frontend (GitHub Pages habitualmente).

6. **Deploy backend (solo si tocaste backend, en este CLI no se debería)**: no hace falta `clasp deploy` si el cambio es 100% frontend. Pero verifica con `git diff --stat`.

7. **Commit + push** en `main`:
   ```bash
   cd /home/user/Kaleide-enrollment
   git add frontend/src/App.jsx
   git add frontend/src/components/DevLogger.jsx  # si lo modificaste
   git add frontend/src/  # cualquier console.log → log.info que cambiaste
   git commit -m "security(wizard): DevLogger gate to dev-only + console.log → log.* hygiene (KAL-NEW-6)"
   git push origin main
   ```
   El push a `main` dispara el workflow GitHub Pages que despliega el frontend.

# Pruebas orientadas al fallo
- Antes del fix: abrir `https://admissions.kaleide.org/#/apply`, hacer F12 → debe verse el DevLogger flotante.
- Después del fix + deploy: misma URL, F12 → DevLogger NO debe aparecer. En dev (`npm run dev` o `localhost`) sí debe aparecer.

# Reporte
- **Primera línea literal**: `**CLI KAL-3 — DevLogger gate prod + console.log hygiene (KAL-NEW-6)** finalizado.`
- Diff completo de `App.jsx` + cualquier otro frontend file tocado.
- Cuál opción elegiste (A/B/C) y por qué.
- Output del grep `console.log` antes/después.
- Hashes commit + push.
- URL del workflow GitHub Pages que disparaste (si aplica).
- Verificación visual: confirmar que en `admissions.kaleide.org` post-deploy NO se ve el DevLogger.
````
