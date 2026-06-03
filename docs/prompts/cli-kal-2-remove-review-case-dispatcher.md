````
# OBLIGATORIO
La PRIMERA LÍNEA literal del reporte final debe ser exactamente:
**CLI KAL-2 — sacar `case 'review'` del dispatcher saveStep_ (KAL-NEW-3)** finalizado.

# Lectura obligatoria previa
Lee estos archivos antes de operar para tener contexto sin re-derivarlo:
1. `/home/user/Kaleide-enrollment/CLAUDE.md` — convenciones wizard + branch canónico `main` + flow `clasp push --force` + `clasp deploy --deploymentId AKfycbyzyAR6J3_2UAiE6tCyNHVawoGfMNNbZEaurp99cRI76IYbiqGVEeQQcTxsgAqUFnGk0w`.
2. `/home/user/kis-app/docs/kms/plan/readiness-2026-06-03/06-security-findings-integration.md` §4 (KAL-NEW-3) — descripción canónica.
3. `/home/user/Kaleide-enrollment/backend/Code.js` líneas 1390-1450 (`case 'review':` dentro de `saveStep_`) + grep `case 'review'` para todos los call-sites.

# Misión
Cerrar **KAL-NEW-3** del audit 2026-05-30: el handler `saveStep_(step='review')` permite a cualquier titular del `resume_token` registrar transiciones de estado en `sysStateTransitionLog` (ej. forzar `status_code='RQ'` o similar) sobre la enrollment del grupo familiar. Aunque `assertGroupEditable_` (CLI 26) bloquea post-submit, en DRAFT el step `review` sigue siendo escribible por la familia → autoescalada de estado no debe vivir en el wizard anónimo.

Análisis canónico (per §4 hallazgos diferibles): _"el residual post-CLI 26 no es explotable en producción si Diego no expone el wizard sin auth, pero conviene sacar `case 'review'` del dispatcher público"_. El wizard NO necesita `step='review'` para nada — el submit canónico vive en `submitEnrollmentSession_` (otro action), y la propia rama `case 'review'` solo escribe a `sysStateTransitionLog` cuando se pasa `status_code` explícito, que ningún flujo legítimo del cliente hace hoy.

# Trabajo paso a paso

1. **Preparar repo** (working directory = `/home/user/Kaleide-enrollment`):
   ```bash
   cd /home/user/Kaleide-enrollment
   git fetch origin main && git status
   # Trabajar SIEMPRE sobre main — NO crear branches.
   ```

2. **Verificar que no hay consumidor frontend de `step:'review'`** antes de borrar:
   ```bash
   grep -rnE "step.*review|saveStep.*review" /home/user/Kaleide-enrollment/frontend/src/ | grep -v "node_modules"
   ```
   - Si el grep devuelve algún call legítimo (Step7Review.handleSubmit o similar) → re-leerlo y confirmar que llama a `submitEnrollmentSession_` no a `saveStep_({step:'review'})`. El flujo canónico de cierre del wizard es `submitEnrollmentSession`, NO `saveStep('review')`.
   - Si encuentras un consumidor REAL → para inmediatamente, reporta y NO procedas. El plan original asumía cero consumidores.

3. **Borrar la rama `case 'review':` de `saveStep_`** en `backend/Code.js` ~L1394:
   - Eliminar el bloque completo desde `case 'review': {` hasta su `break;` (~L1394 a ~L1455 aprox — incluye toda la lógica de `status_code` + `appsheetRequest_(T.STATES_T,...)` + `appsheetRequest_(T.STATE_TRANSITION_LOG,...)` + `appsheetRequest_(T.ENROLLMENTS, 'Edit',...)`).
   - Mantener el `switch (step)` (otros cases siguen vivos: `application`, etc.).
   - Si el `default:` tiene un throw `Unknown step`, eso ya cubre la regresión (un `step:'review'` llegará al default).
   - Si NO existe `default:` con throw, AÑADIR uno:
     ```javascript
     default:
       throw new Error('Unknown saveStep step: ' + step);
     ```

4. **Audit comentado**: dejar un comentario en el sitio del switch indicando el cierre:
   ```javascript
   // KAL-NEW-3 (2026-06-03): `case 'review'` eliminado. Las transiciones de estado
   // ADMISSION (RQ/IN/AD/...) viven en el KMS (operación staff autenticada),
   // NUNCA en el wizard anónimo. El cierre del wizard usa submitEnrollmentSession_.
   ```

5. **Tests manuales `_manual.gs`** (regla CLAUDE.md §"Funciones manual_*", sin trailing underscore):
   - `manual_testReviewStepRejected` — invocar `saveStep_({resume_token: '<UUID válido>', step: 'review', status_code: 'RQ'})` debe throw `Unknown saveStep step: review`. Wrapper que rellena `resume_token` real con el de un grupo de prueba que Diego conoce.

6. **Deploy** desde `/home/user/Kaleide-enrollment/backend/`:
   ```bash
   cd /home/user/Kaleide-enrollment/backend
   clasp push --force
   clasp deploy \
     --deploymentId AKfycbyzyAR6J3_2UAiE6tCyNHVawoGfMNNbZEaurp99cRI76IYbiqGVEeQQcTxsgAqUFnGk0w \
     -d "KAL-NEW-3: remove case 'review' from saveStep_ dispatcher"
   ```

7. **Commit + push** en `main`:
   ```bash
   cd /home/user/Kaleide-enrollment
   git add backend/Code.js
   git commit -m "security(wizard): remove case 'review' from saveStep_ dispatcher (KAL-NEW-3)"
   git push origin main
   ```

# Reporte
- **Primera línea literal**: `**CLI KAL-2 — sacar \`case 'review'\` del dispatcher saveStep_ (KAL-NEW-3)** finalizado.`
- Diff completo de `backend/Code.js` (líneas eliminadas + default añadido).
- Output del grep paso 2 confirmando que no hay consumidor frontend de `step:'review'`.
- Hashes commit + push.
- Output `clasp deploy`.
- Output ejecución `manual_testReviewStepRejected` desde GAS editor (PASS = throws Unknown step).
````
