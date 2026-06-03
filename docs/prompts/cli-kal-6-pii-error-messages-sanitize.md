````
# OBLIGATORIO
La PRIMERA LÍNEA literal del reporte final debe ser exactamente:
**CLI KAL-6 — sanitizar mensajes de error AppSheet al cliente (KAL-NEW-10)** finalizado.

# Lectura obligatoria previa
Lee estos archivos antes de operar para tener contexto sin re-derivarlo:
1. `/home/user/Kaleide-enrollment/CLAUDE.md` — convenciones wizard + branch canónico `main` + flow `clasp push --force` + `clasp deploy --deploymentId AKfycbyzyAR6J3_2UAiE6tCyNHVawoGfMNNbZEaurp99cRI76IYbiqGVEeQQcTxsgAqUFnGk0w`.
2. `/home/user/kis-app/docs/kms/plan/readiness-2026-06-03/06-security-findings-integration.md` §4 (KAL-NEW-10) — _"PII de AppSheet en mensajes de error al cliente anónimo"_. Citas: `Code.js:2932,337`.
3. `/home/user/Kaleide-enrollment/backend/Code.js` líneas ~330-410 (`doPost` catch + error envelope) + ~L2900-2950 (zona uploadDocument / appsheetRequest_ error handling).

# Misión
Cerrar **KAL-NEW-10** del audit 2026-05-30: los catches en `doPost` y en helpers tipo `appsheetRequest_` exponen `err.message` literal al cliente anónimo. Cuando AppSheet rechaza un payload, el mensaje a veces incluye nombres de columnas, valores rechazados, IDs internos, snippets del filter, o emails/UUIDs en el contexto del error. El frontend del wizard recibe eso, lo loguea (pasa por redactDeep que enmascara emails/UUIDs pero no nombres de columnas + valores PII), y opcionalmente lo muestra al usuario.

# Trabajo paso a paso

1. **Preparar repo** (working directory = `/home/user/Kaleide-enrollment`):
   ```bash
   cd /home/user/Kaleide-enrollment
   git fetch origin main && git status
   # Trabajar SIEMPRE sobre main — NO crear branches.
   ```

2. **Inventario de catches que serializan `err.message` al cliente**:
   ```bash
   grep -nE "JSON\.stringify.*err\.|err\.message|message:.*err" /home/user/Kaleide-enrollment/backend/Code.js | head -40
   grep -nE "appsheetRequest_|catch.*\{" /home/user/Kaleide-enrollment/backend/Code.js | head -40
   ```
   Anota los call-sites canónicos. Esperables:
   - `doPost` catch (~L330): construye la respuesta JSON al cliente. SI incluye `err.message` literal → vector.
   - `appsheetRequest_` / `appsheetRequestBatch_`: si hace throw con `err.message` que viene del body de AppSheet → indirecto pero igualmente fugable a través del catch superior.
   - `sendMagicLink_` / `submitEnrollmentSession_` / `uploadDocument_`: cualquier handler que haga `throw new Error('Ya existe...' + email)` o similar (construye mensajes con PII).

3. **Definir helper de sanitización**: añadir a `backend/Code.js` (cerca de `redact_` ya existente, ~L155):
   ```javascript
   /**
    * KAL-NEW-10: sanitiza un mensaje de error antes de enviarlo al cliente
    * anónimo del wizard. Aplica redact_() para emails/UUIDs y además recorta
    * el mensaje a 200 chars + collapsa rutas Drive / nombres de columnas
    * AppSheet que pueden filtrarse en errores de Add/Edit.
    *
    * Para diagnóstico interno usa Logger.log con el err.message COMPLETO
    * (Stackdriver es interno) — solo el OUTPUT al cliente se sanitiza.
    */
   function sanitizeErrorForClient_(err) {
     if (!err) return 'Internal error';
     var msg = String(err.message || err);
     msg = redact_(msg);  // emails → [EMAIL], UUIDs → [UUID]
     // Collapse AppSheet column-name leaks: "Column 'foo_bar' rejected value 'xyz'"
     msg = msg.replace(/Column '[^']*' rejected value '[^']*'/gi, 'Validation error');
     // Collapse Drive file IDs (44-char alnum_)
     msg = msg.replace(/[A-Za-z0-9_-]{40,80}/g, '[FILE_ID]');
     // Recortar a 200 chars
     if (msg.length > 200) msg = msg.slice(0, 200) + '…';
     return msg;
   }
   ```

4. **Aplicar a `doPost` catch**: en el catch principal del dispatcher (~L330), reemplazar el `err.message` literal por `sanitizeErrorForClient_(err)`:
   ```javascript
   } catch (err) {
     // KAL-11: log full message internally with redaction of emails/UUIDs.
     Logger.log('doPost error: ' + redact_(err.message) + '\nstack: ' + (err.stack || 'n/a'));
     // KAL-NEW-10: sanitize public-facing message — NEVER expose AppSheet
     // column-name details, Drive file IDs, or raw PII in error envelope.
     return ContentService.createTextOutput(JSON.stringify({
       ok: false,
       error: {
         code: err.code || 'INTERNAL_ERROR',
         message: sanitizeErrorForClient_(err)
       }
     })).setMimeType(ContentService.MimeType.JSON);
   }
   ```
   La estructura exacta dependerá del envelope actual. Conserva los códigos de error estructurados (`NOT_EDITABLE`, `RATE_LIMITED`, `UNAUTHORIZED`, `BAD_REQUEST`...) que los handlers asignan — son necesarios para que el frontend muestre el mensaje correcto al usuario; solo sanitizes el `message` libre.

5. **Aplicar a handlers que construyen mensajes con PII**: revisar los call-sites del paso 2 y para cada `throw new Error('...' + email + '...')` o equivalente:
   - Si el throw lleva `err.code` correcto y el mensaje es genérico → dejarlo.
   - Si el throw embebe email/nombre/etc. directamente → reemplazar por una versión genérica + log interno con detalle:
     ```javascript
     Logger.log('[handler X] reject: <detalle con redact_(...)>');
     const e = new Error('Operation failed for this email');
     e.code = 'BAD_REQUEST';
     throw e;
     ```
   - Prioridad alta: cualquier mensaje que el cliente vea en pantalla (banner de error en Step 1, validación en Step 2, etc.).

6. **NO romper el patrón P72/NOT_EDITABLE estructurado**: el envelope `{ok:false, error:{code, message}}` debe mantener `code` literal (frontend mappea código → mensaje localizado en `i18n`). Solo el `message` se sanitiza, el `code` se conserva.

7. **Tests manuales `_manual.gs`** (regla CLAUDE.md, sin trailing underscore):
   - `manual_testSanitizeErrorPII` — pasar errores con email/UUID/file_id al helper y verificar output.
   - Si tiene acceso a `clasp run` (Diego), `manual_*` tests ejecutables. Si no, instrucciones del wrapper del editor GAS.

8. **Deploy** desde `/home/user/Kaleide-enrollment/backend/`:
   ```bash
   cd /home/user/Kaleide-enrollment/backend
   clasp push --force
   clasp deploy \
     --deploymentId AKfycbyzyAR6J3_2UAiE6tCyNHVawoGfMNNbZEaurp99cRI76IYbiqGVEeQQcTxsgAqUFnGk0w \
     -d "KAL-NEW-10: sanitize error messages before client envelope"
   ```

9. **Commit + push** en `main`:
   ```bash
   cd /home/user/Kaleide-enrollment
   git add backend/Code.js
   git commit -m "security(wizard): sanitize AppSheet error messages before client envelope (KAL-NEW-10)"
   git push origin main
   ```

# Pruebas orientadas al fallo
- Antes del fix: forzar un Add a AppSheet con una columna inválida (vía `manual_*`) → el mensaje devuelto al cliente menciona la columna.
- Después del fix: el mismo error → cliente recibe `{ok:false, error:{code:'INTERNAL_ERROR', message:'Validation error'}}` (genérico).
- Pero `Logger.log` debe seguir mostrando el mensaje completo (interno) para que Diego pueda diagnosticar.

# Reporte
- **Primera línea literal**: `**CLI KAL-6 — sanitizar mensajes de error AppSheet al cliente (KAL-NEW-10)** finalizado.`
- Diff completo de `backend/Code.js`.
- Lista de handlers tocados (path + función).
- Output `manual_testSanitizeErrorPII` (PASS/FAIL).
- Hash commit + push.
- Output `clasp deploy`.
````
