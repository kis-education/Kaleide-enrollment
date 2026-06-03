# CLIs KAL-* — Wizard hardening lanzables 2026-06-03

Prompts CLI redactados por sesión cloud orquestadora 2026-06-03 para los items
KAL-NEW-* (audit 2026-05-30) + KAL-* legacy del wizard que están **abiertos y
lanzables sin dependencias**. Cada prompt va en un solo code-block 4-backtick,
listo para copy-paste de un click al CLI local.

**Branch canónico**: TODOS los CLIs aquí van directo a `main` del repo
`Kaleide-enrollment`. NUNCA `develop`. NUNCA branches nuevas. Per CLAUDE.md
§"Regla canónica de branches".

## Tabla resumen

| CLI | Hallazgo(s) | Sev | Compl | Archivo |
|----|-------------|:---:|:-----:|---------|
| **KAL-1** | KAL-NEW-2 + KAL-NEW-4 + KAL-NEW-12 + KAL-6 | 🟠 | M | `cli-kal-1-magic-link-rate-limit-recaptcha.md` |
| **KAL-2** | KAL-NEW-3 | 🟡 | S | `cli-kal-2-remove-review-case-dispatcher.md` |
| **KAL-3** | KAL-NEW-6 | 🟡 | S | `cli-kal-3-devlogger-gate-prod.md` |
| **KAL-4** | KAL-NEW-8 | 🟡 | M | `cli-kal-4-csp-sri-hardening.md` |
| **KAL-5** | KAL-NEW-11 | 🟡 | S | `cli-kal-5-frontend-log-redaction-deeper.md` |
| **KAL-6** | KAL-NEW-10 | 🟡 | S | `cli-kal-6-pii-error-messages-sanitize.md` |
| **KAL-7** | KAL-NEW-9 (mitad fast-path) | 🟡 | M | `cli-kal-7-esignature-integrity-hash.md` |

## Orden recomendado de ejecución

Todos son ortogonales — pueden lanzarse en paralelo. Pero por valor de
hardening + complejidad de testing:

1. **KAL-1** (magic-link/reCAPTCHA) — mayor valor, fix de superficie pública.
2. **KAL-2** (dispatcher cleanup) — trivial, cierra vector residual.
3. **KAL-3** (DevLogger gate) — frontend-only, sin backend.
4. **KAL-6** (error message sanitize) — backend-only, sin frontend.
5. **KAL-5** (logger PII expansion) — frontend-only, sin backend.
6. **KAL-4** (CSP + SRI) — requiere testing local meticuloso, riesgo de romper
   el wizard si la CSP queda demasiado restrictiva.
7. **KAL-7** (esignature hash) — requiere pre-cond AppSheet columnas + dudoso
   si vale la pena cerrar la mitad fast-path antes de que DL-S65/sysLegalActsLog
   lo cubra canónicamente. Si Diego prefiere esperar al refactor S-SIGN, diferir.

## Items KAL-NEW-* YA cerrados (no requieren CLI)

- **KAL-NEW-1** — closed in commit `1b369ab` (CLI 81: signing_token URL clean + resolveSigningToken disclosure restricted).
- **KAL-NEW-5** — closed in commit `7ad0788` (CLI 82: Drive privado + proxy bytes + MIME guard).
- **KAL-NEW-7** — closed in commit `1b369ab` (CLI 81: TTL `resume_token` en `requireResumeToken_`).
- **SUBMIT-REPLAY** — closed in commit `1b369ab` (CLI 81: `assertGroupEditable_` en `submitEnrollmentSession_`).
- **KAL-1/2/3/4/5/7/10/11** — closed in commits previos (ver CLAUDE.md §Security).

## Items BLOQUEADOS por dependencia (no incluidos en este lote)

- **SSRF-1 / SSRF-KEY** del driver Click & Sign → vive en KMS (`kis-app/develop`),
  no en wizard. Diferible Stage 1 si CLI 83 (PRIVESC) se cierra primero.
- **KAL-NEW-9 mitad canónica** — espera al refactor S-SIGN + DL-S65
  `sysLegalActsLog` (vive en KMS, no en wizard). Este lote solo cubre la mitad
  fast-path client-side (KAL-7).

## Cross-refs canónicos

- `/home/user/kis-app/docs/kms/plan/readiness-2026-06-03/06-security-findings-integration.md` — análisis de hallazgos de los 5 audits del wizard.
- `/home/user/Kaleide-enrollment/CLAUDE.md` §Security — historia de items KAL-* cerrados.
- `/home/user/kis-app/docs/kms/prompts/security-CLI-{20,21,23,24,25}-*.md` — prompts antiguos pre-readiness; algunos cubren mismos hallazgos pero apuntan a `develop` (rama equivocada por inercia 2026-05-29) → estos KAL-N prompts los reemplazan y usan `main` canónico.
