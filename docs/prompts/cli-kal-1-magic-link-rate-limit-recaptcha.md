````
# OBLIGATORIO
La PRIMERA LÍNEA literal del reporte final debe ser exactamente:
**CLI KAL-1 — magic-link rate-limit + reCAPTCHA fail-closed + KMS_INTERNAL gate** finalizado.

# Lectura obligatoria previa
Lee estos archivos antes de operar para tener contexto sin re-derivarlo:
1. `/home/user/Kaleide-enrollment/CLAUDE.md` — convenciones wizard + branch canónico `main` (NUNCA `develop` ni ramas nuevas) + flow `clasp push --force` + `clasp deploy --deploymentId AKfycbyzyAR6J3_2UAiE6tCyNHVawoGfMNNbZEaurp99cRI76IYbiqGVEeQQcTxsgAqUFnGk0w`.
2. `/home/user/kis-app/docs/kms/plan/readiness-2026-06-03/06-security-findings-integration.md` §3.2 (KAL-NEW-2) + §3.3 (KAL-NEW-4) + §4 (KAL-NEW-12) — descripción canónica de los 3 hallazgos.
3. `/home/user/Kaleide-enrollment/backend/Code.js` líneas 512-630 (`_checkMagicLinkRateLimit_`, `initEnrollmentSession_`, validación reCAPTCHA + KMS_INTERNAL) y líneas 1899-1950 (`sendVerificationCode_` + `verifyEmail_`).

# Misión
Cerrar 4 hallazgos relacionados que comparten el archivo `backend/Code.js` y la superficie de email/auth pre-wizard, en un solo CLI sobre `main`:

- **KAL-NEW-2** — `sendVerificationCode_` usa `Math.random()` (no CSPRNG) para el código de 6 dígitos + `verifyEmail_` sin lockout de intentos (fuerza bruta de 10⁶) + ningún rate-limit en el dispatcher (`sendVerificationCode`).
- **KAL-NEW-4** — reCAPTCHA **fail-open** (`if (secret && ...)` línea ~568): si `RECAPTCHA_SECRET` no está configurado, la validación se salta silenciosamente. Además `source_code:'KMS_INTERNAL'` (línea ~566) salta reCAPTCHA y permite que cualquier caller anónimo abuse del bypass simplemente pasando ese source.
- **KAL-NEW-12** + **KAL-6** — `_checkMagicLinkRateLimit_` tiene cap `count >= 10` (línea 523) cuando el JSDoc y la doc dicen 3-5; además solo limita por-email, no por-IP/global.

# Trabajo paso a paso

1. **Preparar repo** (working directory = `/home/user/Kaleide-enrollment`):
   ```bash
   cd /home/user/Kaleide-enrollment
   git fetch origin main && git status
   # Trabajar SIEMPRE sobre main — NO crear branches (regla canónica wizard).
   ```

2. **Fix KAL-NEW-2.a — código de verificación CSPRNG** en `backend/Code.js` ~L1904:
   - Reemplazar `Math.floor(100000 + Math.random() * 900000).toString()` por un código derivado de `Utilities.getUuid()`:
     ```javascript
     // KAL-NEW-2: CSPRNG-grade 6-digit code (Utilities.getUuid is crypto-grade per KAL-1).
     // Take 6 hex chars → map to 6-digit decimal range to keep UX shape (XXXXXX).
     const uuidHex = Utilities.getUuid().replace(/-/g, '').slice(0, 8);
     const intVal = parseInt(uuidHex, 16);
     const code = (100000 + (intVal % 900000)).toString();
     ```
   - Añadir comentario explicando el rationale (KAL-NEW-2 audit 2026-05-30).

3. **Fix KAL-NEW-2.b — lockout en verifyEmail_** en `backend/Code.js` ~L1933:
   - Antes de verificar el código, leer un contador `verify_attempts_<group_id>` del ScriptCache.
   - Si `attempts >= 5` → throw error `code='TOO_MANY_ATTEMPTS'` (sin revelar si el código era correcto).
   - Si el código es incorrecto → incrementar contador + TTL 10 min (mismo TTL que el código).
   - Si el código es correcto → borrar contador + borrar código + `return {verified:true}`.
   - Patrón:
     ```javascript
     const attemptsKey = 'verify_attempts_' + enrollmentGroupId;
     const attempts = parseInt(cache.get(attemptsKey) || '0', 10);
     if (attempts >= 5) {
       const err = new Error('Too many verification attempts; request a new code');
       err.code = 'TOO_MANY_ATTEMPTS';
       throw err;
     }
     // ... existing logic ...
     if (stored !== code.toString()) {
       cache.put(attemptsKey, String(attempts + 1), 600);
       throw new Error('Invalid verification code');
     }
     cache.remove(attemptsKey);
     ```

4. **Fix KAL-NEW-2.c — rate-limit del dispatcher `sendVerificationCode`**:
   - En `sendVerificationCode_` (~L1899), llamar `_checkMagicLinkRateLimit_(primary_email)` ANTES de generar el código. Reusa el helper existente — mismo bucket que magic-link cubre el caso (un email no puede pedir >N códigos por hora).

5. **Fix KAL-NEW-12 + KAL-6 — rate-limit cap + por-IP**:
   - En `_checkMagicLinkRateLimit_` (~L523), cambiar `count >= 10` → `count >= 5` (margen para typos de Diego sin reabrir UX a abuso). Documentar en el comentario que el cap se bajó de 10→5 per KAL-NEW-12.
   - Añadir helper paralelo `_checkMagicLinkRateLimitIp_(ip)` con bucket `magic_count_ip_<ip>` cap `>= 20` / hora. NOTA importante: **GAS no expone IP directamente** desde `doPost(e)`. Documentar en el comentario del helper que mientras la IP no esté disponible se deja como **noop sin throw** (el helper recibe `null` y vuelve sin tocar el cache); cuando se exponga la IP (via proxy frontal o header `X-Forwarded-For` propagado), basta con llamar al helper con la IP resuelta. NO inventes una fuente de IP que no exista.
   - En `initEnrollmentSession_` y `sendMagicLink_`, llamar `_checkMagicLinkRateLimitIp_(null /* TODO: IP source pending */)` justo después de la llamada por-email. Cero efecto runtime; deja el helper visible para wire-up futuro.

6. **Fix KAL-NEW-4 — reCAPTCHA fail-CLOSED + KMS_INTERNAL bloqueado para anónimos**:
   - En `initEnrollmentSession_` (~L567): cambiar el patrón `if (secret && sourceCode === 'WEB_PUBLIC')` por:
     ```javascript
     // KAL-NEW-4: fail-closed — exigir RECAPTCHA_SECRET configurado para todo flujo WEB_PUBLIC.
     // El bypass por sourceCode='KMS_INTERNAL' queda restringido a callers internos (auth upstream).
     if (sourceCode === 'WEB_PUBLIC') {
       if (!secret) {
         const err = new Error('reCAPTCHA not configured — contact admin');
         err.code = 'RECAPTCHA_NOT_CONFIGURED';
         throw err;
       }
       if (!p.recaptcha_token) throw new Error('Missing reCAPTCHA token');
       const rcResult = verifyRecaptcha_({ token: p.recaptcha_token });
       if (!rcResult.pass) throw new Error('reCAPTCHA verification failed');
     }
     ```
   - **KMS_INTERNAL gate**: añadir validación de que el caller realmente sea KMS-interno antes de aceptar `sourceCode='KMS_INTERNAL'`. El wizard backend es anónimo (`access: ANYONE_ANONYMOUS`) → cualquier internet podría pasar `source_code:'KMS_INTERNAL'`. Stage 1 fix: exigir un Script Property `KMS_INTERNAL_SHARED_SECRET` y un campo `kms_internal_secret` en el payload que coincida; si no coincide → rechazar el sourceCode y caer en WEB_PUBLIC (que exige reCAPTCHA). Patrón:
     ```javascript
     if (sourceCode === 'KMS_INTERNAL') {
       const expected = PropertiesService.getScriptProperties().getProperty('KMS_INTERNAL_SHARED_SECRET');
       if (!expected || p.kms_internal_secret !== expected) {
         throw new Error('Unauthorized source_code: KMS_INTERNAL');
       }
     }
     ```
   - Aplicar el mismo gate de reCAPTCHA fail-closed a los otros 2 call-sites que leen `RECAPTCHA_SECRET` (~L827 en `sendMagicLink_`, ~L2883 en `submitEnrollmentSession_`/equivalente — verificar con grep `RECAPTCHA_SECRET` los 3 sitios y aplicar el patrón fail-closed sin cambiar la semántica de KMS_INTERNAL bypass donde aplique).

7. **Tests manuales `_manual.gs`** (regla CLAUDE.md §"Funciones manual_*"):
   - `manual_testVerifyEmailLockout` — simula 5 intentos fallidos seguidos del código → 6º intento debe rechazar con `TOO_MANY_ATTEMPTS`.
   - `manual_testRecaptchaFailClosed` — temporalmente borrar `RECAPTCHA_SECRET` Script Property (back-up + restore), invocar `initEnrollmentSession_({source_code:'WEB_PUBLIC', primary_email:'test@kaleide.org'})` → debe throw `RECAPTCHA_NOT_CONFIGURED`.
   - `manual_testKmsInternalGate` — invocar con `source_code:'KMS_INTERNAL'` sin secret → debe throw. Con secret correcto → debe pasar.
   - NUNCA con trailing underscore en wrappers `manual_*`.

8. **Deploy** desde `/home/user/Kaleide-enrollment/backend/`:
   ```bash
   cd /home/user/Kaleide-enrollment/backend
   clasp push --force
   clasp deploy \
     --deploymentId AKfycbyzyAR6J3_2UAiE6tCyNHVawoGfMNNbZEaurp99cRI76IYbiqGVEeQQcTxsgAqUFnGk0w \
     -d "KAL-NEW-2/4/12+KAL-6: CSPRNG verify code + lockout + reCAPTCHA fail-closed + KMS_INTERNAL gate + rate-limit cap 5 + IP placeholder"
   ```

9. **Commit + push** en `main`:
   ```bash
   cd /home/user/Kaleide-enrollment
   git add backend/Code.js
   git commit -m "security(wizard): rate-limit + CSPRNG verify code + reCAPTCHA fail-closed + KMS_INTERNAL gate (KAL-NEW-2/4/12 + KAL-6)"
   git push origin main
   ```

10. **Pre-requisitos operativos (Diego)** — añadir al reporte como tareas a ejecutar Diego antes del próximo go-live:
    - Crear Script Property `KMS_INTERNAL_SHARED_SECRET` con un UUID v4 (compartido con el KMS para que el call interno cross-script pueda autenticarse).
    - Verificar que `RECAPTCHA_SECRET` esté configurada (lo cual asumimos cierto en prod hoy).

# Reporte
- **Primera línea literal**: `**CLI KAL-1 — magic-link rate-limit + reCAPTCHA fail-closed + KMS_INTERNAL gate** finalizado.`
- Diff completo de `backend/Code.js`.
- Hashes commit + push.
- Output `clasp deploy`.
- Output ejecuciones `manual_testVerifyEmailLockout` / `manual_testRecaptchaFailClosed` / `manual_testKmsInternalGate` desde GAS editor (PASS/FAIL).
- Lista de Script Properties pendientes que Diego debe poblar.
````
