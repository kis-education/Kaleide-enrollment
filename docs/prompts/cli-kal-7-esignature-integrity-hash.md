````
# OBLIGATORIO
La PRIMERA LÍNEA literal del reporte final debe ser exactamente:
**CLI KAL-7 — esignature client integrity hash (KAL-NEW-9)** finalizado.

# Lectura obligatoria previa
Lee estos archivos antes de operar para tener contexto sin re-derivarlo:
1. `/home/user/Kaleide-enrollment/CLAUDE.md` — convenciones wizard + branch canónico `main` + flow `clasp push --force` + `clasp deploy --deploymentId AKfycbyzyAR6J3_2UAiE6tCyNHVawoGfMNNbZEaurp99cRI76IYbiqGVEeQQcTxsgAqUFnGk0w`.
2. `/home/user/kis-app/docs/kms/plan/readiness-2026-06-03/06-security-findings-integration.md` §4 (KAL-NEW-9) — _"Firma electrónica = texto libre forjable [...] mejora parcial por FNMT seal (CLI 64) — pero esignature cliente aún sin hash de integridad ni IP fiable"_.
3. `/home/user/Kaleide-enrollment/backend/Code.js` líneas 1543-1547 + 1598 + 3187 (los call-sites donde `esignature` se persiste a la fila — confirma con grep).
4. `/home/user/Kaleide-enrollment/CLAUDE.md` §"Edit-lock post-submit" + §"Dos bearer tokens canónicos" — para entender el modelo de auth del wizard.

# Misión
Cerrar la mitad accionable de **KAL-NEW-9** del audit 2026-05-30. El finding completo es que la "firma electrónica" del wizard (Step 7 review / consentimientos GDPR) es texto libre tipeado por el firmante — sin integridad criptográfica. Como el plan readiness anota: _"mejora parcial por FNMT seal (CLI 64) — pero esignature cliente aún sin hash de integridad"_. **Esta CLI cierra la mitad client-side: añadir un hash SHA-256 sobre `(esignature_text || resume_token || timestamp_emitido_servidor || canonical_payload)` que el backend genera y persiste como evidencia de integridad post-write. NO es una firma criptográfica jurídica (eso es FNMT vía CLI 64), pero impide que un atacante post-hoc modifique la fila esignature sin invalidar el hash.

NOTA importante: si Diego prefiere diferir esto hasta que llegue el refactor S-SIGN canónico (DL-S65 sysLegalActsLog) → este CLI puede esperar. Pero como item HARDENING aislable, vale la pena ejecutarlo: las filas con `esignature` de fast-path quedan tamper-evidence-able sin necesidad de DL-S65.

# Trabajo paso a paso

1. **Preparar repo** (working directory = `/home/user/Kaleide-enrollment`):
   ```bash
   cd /home/user/Kaleide-enrollment
   git fetch origin main && git status
   # Trabajar SIEMPRE sobre main — NO crear branches.
   ```

2. **Localizar los call-sites canónicos de `esignature`**:
   ```bash
   grep -nE "esignature|signature_text|signed_text" /home/user/Kaleide-enrollment/backend/Code.js | head -25
   ```
   Esperables (per audit): `Code.js:1598` (`saveStep_` consent step?), `Code.js:3187` (signing-side de proxies), `Code.js:1543-1547`. Verifica los 3 + cualquier otro que aparezca.

3. **Definir helper de hash** (cerca de `redact_` ~L155):
   ```javascript
   /**
    * KAL-NEW-9 (Stage 1 fast-path tamper-evidence): genera un hash SHA-256
    * canonical sobre (esignature_text + entity_id + emitted_at + resume_token_preview)
    * para detectar mutación post-write de la fila firmada. NO es firma criptográfica
    * jurídica — eso vive en la cadena FNMT seal (CLI 64) + Click & Sign envelope.
    * Esto es solo evidencia de integridad para fast-path acceptance Stage 1.
    *
    * El servidor guarda `esignature_text` + `esignature_hash` + `esignature_emitted_at`.
    * En auditoría: recomputar hash con los 4 inputs canonical → match indica fila no
    * mutada; mismatch indica mutación silenciosa.
    *
    * @param {string} esignatureText
    * @param {string} entityId
    * @param {string} emittedAt        ISO 8601 UTC
    * @param {string} tokenPreview     primeros 8 chars del bearer relevante
    * @returns {string} hex SHA-256
    */
   function computeEsignatureHash_(esignatureText, entityId, emittedAt, tokenPreview) {
     var canonical = [
       String(esignatureText || ''),
       String(entityId || ''),
       String(emittedAt || ''),
       String(tokenPreview || '')
     ].join('');  // ASCII unit separator — improbable en input legítimo
     var bytes = Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, canonical, Utilities.Charset.UTF_8);
     return bytes.map(function(b) {
       var hex = (b < 0 ? b + 256 : b).toString(16);
       return hex.length === 1 ? '0' + hex : hex;
     }).join('');
   }
   ```

4. **Aplicar a los call-sites identificados**:
   - Para cada call-site donde se persiste `esignature` (text libre tipeado por el firmante), generar `esignature_hash` ANTES del `appsheetRequest_(... 'Add', ...)` y añadirlo al payload.
   - Patrón:
     ```javascript
     var nowIso = new Date().toISOString();
     var tokenPreview = (resumeToken || signingToken || '').substring(0, 8);
     var hash = computeEsignatureHash_(payload.esignature, entityId, nowIso, tokenPreview);
     var row = {
       // ... resto del payload ...
       esignature:           payload.esignature,
       esignature_hash:      hash,
       esignature_emitted_at: nowIso,
     };
     ```
   - Si la columna `esignature_hash` no existe en AppSheet → DOCUMENTAR como acción pendiente para Diego (sección del reporte): "Diego debe añadir 2 columnas a la(s) tabla(s) X: `esignature_hash` (Text, max 64) + `esignature_emitted_at` (DateTime). Sin esas columnas, el silent reject P72 oculta el fix." NO intentes crear las columnas desde el código — eso es AppSheet UI (per CLAUDE.md regla de cambios AppSheet).

5. **Helper de verificación + test manual**:
   ```javascript
   /**
    * KAL-NEW-9: utility para Diego — recomputar el hash de una fila firmada
    * y comparar con el persistido. Diego ejecuta desde GAS editor sobre una
    * fila concreta (pasando el row_id) para auditar integridad.
    */
   function manual_verifyEsignatureIntegrity() {
     var ROW_ID = 'PASTE_ROW_ID_HERE';
     var TABLE = T.ENROLLMENT_GROUPS;  // o la tabla real donde vive la fila
     // ... leer la fila, recomputar hash con los 4 inputs canonical, comparar ...
     Logger.log('expected: ' + expected + '\nactual:   ' + actual + '\nmatch:    ' + (expected === actual));
   }
   ```

6. **Tests manuales `_manual.gs`** (regla CLAUDE.md, sin trailing underscore):
   - `manual_testEsignatureHashRoundtrip` — generar hash → recomputar → match. Mutar uno de los inputs → mismatch.

7. **Deploy** desde `/home/user/Kaleide-enrollment/backend/`:
   ```bash
   cd /home/user/Kaleide-enrollment/backend
   clasp push --force
   # SOLO clasp push (no deploy) si la única modificación toca tests + el helper computeEsignatureHash_ pero NO los call-sites — porque sin las columnas AppSheet añadidas, los call-sites silent-rejectarían.
   # Si Diego confirma columnas creadas en AppSheet ANTES del CLI → clasp deploy normal.
   ```
   El reporte debe llevar la decisión clara: si las columnas existen → deploy completo; si no → solo push + esperar a que Diego las cree, luego deploy en segundo CLI.

8. **Commit + push** en `main`:
   ```bash
   cd /home/user/Kaleide-enrollment
   git add backend/Code.js
   git commit -m "security(wizard): esignature_hash tamper-evidence Stage 1 (KAL-NEW-9 — fast-path)"
   git push origin main
   ```

# Pre-requisitos AppSheet (Diego)
- Añadir a la(s) tabla(s) que persisten `esignature`:
  - `esignature_hash` — Text, max 64 chars, Required=OFF (legacy rows sin hash deben coexistir).
  - `esignature_emitted_at` — DateTime, Required=OFF.
- Documentar la lista exacta de tablas afectadas en el reporte tras inventariar los call-sites del paso 2.

# Pruebas orientadas al fallo
- Antes del fix: una fila con `esignature` puede ser editada post-write en AppSheet UI sin dejar rastro detectable.
- Después del fix: edit la `esignature` post-write → `computeEsignatureHash_` recomputado con los 4 inputs originales NO matchea el hash persistido → `manual_verifyEsignatureIntegrity` detecta la mutación.

# Reporte
- **Primera línea literal**: `**CLI KAL-7 — esignature client integrity hash (KAL-NEW-9)** finalizado.`
- Lista de call-sites canónicos identificados (path + línea + tabla).
- Lista de tablas AppSheet que requieren las 2 columnas nuevas.
- Diff completo de `backend/Code.js`.
- Hash commit + push.
- Decisión deploy: solo `clasp push` (sin deploy) si columnas AppSheet pendientes, o deploy completo si Diego confirma columnas creadas.
- Output `manual_testEsignatureHashRoundtrip` (PASS/FAIL).
````
