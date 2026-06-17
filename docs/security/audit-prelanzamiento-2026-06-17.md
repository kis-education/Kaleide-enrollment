# Auditoría de seguridad pre-lanzamiento — Wizard de inscripción (2026-06-17)

## Veredicto

Auditoría de seguridad **READ-ONLY** del wizard (backend `backend/Code.js` + verificación frontend KAL-7) realizada la noche del 2026-06-17 antes del lanzamiento.

**VEREDICTO: VERDE — sin hallazgos críticos ni altos.**

Todos los invariantes KAL-1..KAL-11 + identity-from-link + edit-lock + dos-bearer-tokens + gate step-up de PII (DL-E39) se sostienen. El wizard es apto para lanzamiento desde la óptica de seguridad.

## Invariantes verificados (PASS)

| Invariante | Verificación | Resultado |
|---|---|---|
| **KAL-1** (UUID crypto-grade) | `generateUuid_()` usa `Utilities.getUuid()`; todos los `resume_token`, PKs y nonces son no-enumerables. | PASS |
| **KAL-4** (IDOR) | `enrollment_group_id` derivado SIEMPRE del token, nunca del payload. Validación per-fila en `saveResponses_`. Cross-group guard en `requireResumeToken_` (`Code.js:516`). | PASS |
| **KAL-5** (filter injection) | 106 call-sites con `appsheetEscape_` + `assertValid*` (`assertValidUuid_`/`assertValidEmail_`/whitelist). Cero interpolación cruda de user input en Selectors. | PASS |
| **KAL-7** (token URL clean) | Token solo por path; logs solo prefix `slice(0,8)`. **Frontend verificado**: `<meta name="referrer" content="no-referrer">` en `index.html` + `window.history.replaceState` en `ResumePage.jsx:78` y `ReportUnsolicitedPage.jsx:29`. | PASS |
| **KAL-10** (anti-enumeración) | `recognizeFamily_` devuelve shape constante `{matched:false, persons:[]}` para el caller público; payload completo solo en el internal call. | PASS |
| **KAL-11** (PII redaction) | `redact_` (emails → `[EMAIL]`, UUIDs → `[UUID]`) + `sanitizeErrorForClient_` aplicados en logs y respuestas de error. | PASS |
| **identity-from-link** | `n` = `email_id` validado server-side contra el grupo del token (`resolveEmailFromLinkParam_`, `Code.js:2230`); `n` no es bearer, no autoriza por sí solo. | PASS |
| **dispatcher público** | 30 cases; cero acepta `table`/`action`/`payload` arbitrario. `drainJobQueue`/`notify` gateados por secreto en Script Property con no-op silencioso. | PASS |
| **exposición PII (gate step-up DL-E39)** | Gate step-up en TODAS las lecturas de PII — `resumeSession_`/`hydrateSession_`/`getDocument_` devuelven `[]` + `pii_gated:true` sin OTP fresco. OTP CSPRNG, TTL 10 min, lockout a 5 intentos, destino resuelto server-side. | PASS |
| **integración wizard↔KMS** | `kmsProxy_` con bearer OAuth + `QB_SERVICE_TOKEN`; identidad resuelta server-side; el KMS re-valida KAL-4. | PASS |
| **reCAPTCHA + rate-limits** | reCAPTCHA fail-closed. Rate-limits: magic-link 5/h, step-up OTP 8/h, recognize 5/min. | PASS |

## Hallazgos (ninguno bloqueante)

- 🟡 **MEDIO** (informativo, NO se actúa pre-lanzamiento): oráculo de enumeración fino en `initEnrollmentSession_` — las ramas `already_submitted`/`resumed`/creación son distinguibles para un caller que supere reCAPTCHA, permitiendo inferir (con coste reCAPTCHA + rate-limit 5/h por email) si un email tiene solicitud. **Mitigado**: no expone nombres ni PII, y el magic link siempre va al email tecleado. Fix opcional futuro: homogeneizar el shape de las tres ramas. **Decisión: NO tocar pre-lanzamiento** (coste/beneficio desfavorable; el vector de nombres de `recognizeFamily_` ya está cerrado por KAL-10).

- ⚪ **BAJO**: `getLiveStateVersion_` — lectura abierta que devuelve solo un contador entero no sensible (el bump del contador exige secreto KMS). No-vector; comportamiento correcto.

## Robustez positiva observada

- `uploadDocument_` con validación de magic-bytes + allowlist MIME + tope de 10 MB.
- Ventana de step-up dura, sin renovación deslizante (sliding) — finding #55.
- Gracia del magic-link single-use anclada al `resume_token` recién rotado.
- Drive privado + proxy de bytes (sin enlaces públicos a documentos).
- `constantTimeEquals_` (comparación HMAC) para el secreto `KMS_INTERNAL`.

## Checklist de lanzamiento (seguridad)

- [x] Backend: invariantes KAL-* PASS.
- [x] Frontend: KAL-7 (meta referrer + replaceState) verificado.
- [x] Sin hallazgos críticos/altos.
- [ ] (Diego, post-lanzamiento opcional) homogeneizar shape de `initEnrollmentSession_` si se quiere cerrar el oráculo MEDIO.

---

Auditoría realizada en sesión nocturna autónoma 2026-06-17; archivo auditado `backend/Code.js` (9571 líneas) + verificación frontend KAL-7.
