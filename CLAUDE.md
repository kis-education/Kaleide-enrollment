# Kaleide-enrollment — Claude Context

## Project
Public-facing enrollment wizard (admissions.kaleide.org). Families submit applications anonymously; data lands in the AppSheet tables shared with the KMS.

## Stack
- **Google Apps Script** backend (`backend/Code.js`) — manifest `executeAs: USER_DEPLOYING`, `access: ANYONE_ANONYMOUS`. This is the inverse of the KMS (USER_ACCESSING + DOMAIN) and the two cannot share a single GAS project — see DL-E23.
- **Static frontend** (`frontend/`) served from the wizard's deployment URL.

## Security

### Regla — funciones de diagnóstico/debug fuera del dispatcher público

El manifest `access: ANYONE_ANONYMOUS` significa que CUALQUIER función registrada en el switch(action) de `doPost` es invocable desde internet sin autenticación. Reglas obligatorias para futuras sesiones:

1. **Funciones con JSDoc Diagnostic/Debug/Test/Dev NO se registran en el dispatcher**. Si necesitas ejecutarlas, lánzalas desde el GAS editor (donde la auth del owner las protege).
2. **Si por excepción una función de debug DEBE ser callable vía API** (ej. para verificación remota durante deploys): gating con secreto compartido en Script Properties que solo Diego conoce. Header `X-Diag-Secret` o param explícito.
3. **Cualquier helper que acepte `table`, `action`, `payload` o equivalente arbitrario como input** queda prohibido en el dispatcher público, sin excepciones. Es vector instantáneo de RCE/data exfiltration.
4. **Antes de cada push a main** que modifique el dispatcher: verificar con grep que no se introdujeron cases con olor a debug.

Precedente: KAL-2 (`diagAllTables` + `diagTable`) cerrado 2026-05-30 en CLI 43 tras audit security 2026-05-29 — había RW total a la BD sin auth.

### Generación de UUID — Vía A actual + Vía B canónica pendiente

- **Actual (KAL-1 cerrado 2026-05-30)**: `generateUuid_()` usa `Utilities.getUuid()` crypto-grade. Todos los `resume_token`, PKs y nonces generados client-side son seguros.
- **Canónico (roadmap P108, no urgente)**: omitir PK del payload de Add y dejar que AppSheet aplique `UNIQUEID(...)` del Initial Value. Eliminaría la necesidad de `generateUuid_()` para PKs. resume_token y otros secretos no-PK seguirían usando `Utilities.getUuid()` o se configuraría `Initial Value: UNIQUEID(...)` también en columnas no-PK que requieran UUID.

### Filter injection AppSheet — defensa en profundidad (KAL-5 cerrado 2026-05-30)

AppSheet Selector se construye via string concatenation con user input. Sin escape ni validación, vector clásico de SQL-injection-equivalente: un email tipo `victima" || "1"="1` rompe el filtro y devuelve todas las filas.

**Defensa obligatoria en TODO call-site nuevo que meta user input en un Filter**:
1. **Validación estricta del input** ANTES: `assertValidUuid_` para UUIDs, `assertValidEmail_` para emails, whitelist (regex `^[A-Z0-9_]+$` o equivalente) para codes/enums.
2. **Escape universal** con `appsheetEscape_()` en la concatenación (red de seguridad si la validación olvida algún caso).

Las 2 capas son obligatorias. Nunca solo una.

Cross-ref: commit `CLI46` cierra los 15+ call-sites originales (initEnrollmentSession_, recognizeFamily_, sendMagicLink_, abandonSession_, reportUnsolicited_, resumeSession_, saveStep_, submitEnrollmentSession_, uploadDocument_, fetchQuestions_, fetchLookups_, resolveSigningToken_, promoteEnrollment_, adminCleanupOrphanSessions, getTrackingData_, getInterviewForEnrollment_, getAdmissionDecisionForEnrollment_, getReservationPaymentInfo_, getSigningTokenFromResumeToken_). Helpers en backend/Code.js cerca del inicio del archivo, justo antes de `// ─── Entry points ───`. Tests manuales: `manual_testAppSheetEscape_` y `manual_testFilterInjectionDefense_`.

## Deployment

The wizard is served from a **fixed deployment URL**. `clasp push` only updates Head — users hit the deployment URL, which is frozen until redeployed.

```bash
# From backend/
clasp push --force
clasp deploy \
  --deploymentId AKfycbyzyAR6J3_2UAiE6tCyNHVawoGfMNNbZEaurp99cRI76IYbiqGVEeQQcTxsgAqUFnGk0w \
  -d "<short description of the change>"
```

**Never create a new deployment** — always update the existing one above. A new deployment yields a new URL and breaks `admissions.kaleide.org`.

### Auto-deploy via GitHub Actions (CI backend-deploy job)

`.github/workflows/deploy.yml` includes a `backend-deploy` job that runs `clasp push --force` + `clasp deploy --deploymentId` on every push to `main`. It requires a GitHub secret:

- **`CLASP_TOKEN`**: JSON content of `~/.clasprc.json` from Diego's local machine (contains OAuth refresh token). Add via: GitHub repo → Settings → Secrets → Actions → New secret → name `CLASP_TOKEN` → paste the full contents of `~/.clasprc.json`.

Without this secret the job fails silently — the frontend-deploy (Pages) is unaffected.

### Smoke test technique — dos pasos (2026-05-29)

GAS web apps devuelven una respuesta en **dos pasos**: la primera request al `/exec` recibe un HTTP 302 con `Location: https://script.googleusercontent.com/macros/echo?user_content_key=...`. El JSON real está en ese segundo URL. `curl -L` NO funciona correctamente porque convierte el POST a GET en el redirect y el endpoint echo devuelve una página de error de Google Drive en holandés. La técnica correcta para smoke tests desde CLI:

```bash
# Paso 1: POST sin seguir redirects, captura la Location header
LOCATION=$(curl -s -D - -o /dev/null -X POST "$GAS_URL" \
  -H "Content-Type: text/plain" \
  -d '{"action":"...","_hp":"","key":"value"}' \
  --max-time 60 | grep -i '^location:' | tr -d '\r' | awk '{print $2}')

# Paso 2: GET al echo URL
curl -s "$LOCATION" --max-time 30
```

Verificado: el deploy @92 (CLI 17) responde correctamente con este patrón. `admissions.kaleide.org` funciona OK desde browsers (manejan el redirect nativo).

## Email sending

Transactional emails (application received, etc.) use `GmailApp.sendEmail` with `from: ADMISSIONS_EMAIL` so they appear from `admissions@kaleide.org` instead of the deploying account. This requires `admissions@kaleide.org` to be configured as a **"Send mail as" alias** in the deploying Gmail account (Settings → Accounts → Send mail as). Without the alias, Gmail silently falls back to the deploying account address.

## Autonomy — main branch

Diego has authorized Claude Code to proceed without prior confirmation for any git and clasp operation on `main`, mirroring the kis-app autonomy directive:

- `git add`, `git commit`, `git push` on `main`
- `clasp push --force` (from `backend/`)
- `clasp deploy --deploymentId AKfycbyzyAR6J3_2UAiE6tCyNHVawoGfMNNbZEaurp99cRI76IYbiqGVEeQQcTxsgAqUFnGk0w -d "..."`

Still requires confirmation:
- `clasp create` (new GAS project)
- Creating a new deployment (would change the URL)
