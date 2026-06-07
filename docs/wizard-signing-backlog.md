# Backlog vivo — flujo de firma del wizard (/apply → /sign)

Backlog vivo del esfuerzo de implementación del **flujo de firma continuo** del wizard de admisiones (`/apply` → `/sign`, Steps 1→11), correspondiente a las sesiones **2026-06-07 / 2026-06-08**. Existe para que ningún item que Diego levantó se pierda entre sesiones. Es un backlog operativo, no un design log: para el modelo de autorización y las decisiones canónicas ver `CLAUDE.md` (§"Dos bearer tokens canónicos" + §"Wizard steps canónicos" + DL-E38).

## Hecho y desplegado

- [x] AD desbloquea step 8 (state-driven, Option A).
- [x] Merge de los steps 8-11 inline (flujo continuo 1→11).
- [x] Identidad de guardian derivada de (`resume_token` de grupo + email de acceso) en la entrada.
- [x] KMS proxy: config Script Properties (`KMS_DEPLOYMENT_URL` + `QB_SERVICE_TOKEN`) + auth Bearer OAuth en `kmsProxy_` (wizard backend @126). Causa: el KMS es `access:ANYONE` y rechazaba el POST anónimo con 401 (login page).
- [x] KMS handlers de firma blindados + reparto multi-pagador en `fin_saveBillingPartyFromWizard` (KMS @352).
- [x] Billing: prefill desde el guardian firmante + envía `payer_person_id` (default payer = firmante).
- [x] Reparto solo entre tutores (eliminada facturación a terceros) + proxy `saveBillingInfo_` forwarda `payers[]`.
- [x] DevLogger visible por defecto (revertido el gating no solicitado de KAL-NEW-6).
- [x] Botones de avance arriba y abajo en los pasos de firma.

## En curso

- [ ] Guardado en background + avance optimista en steps 8-10 (regla: avanzar a N+1 si N-1 ya guardado; un solo save en vuelo). Step 11 (acto de firma) permanece bloqueante. *(agente frontend en marcha)*

## Pendiente — prompt CLI ya entregado a Diego

- [ ] Rediseño billing: eliminar el formulario fiscal del Step 8 (los datos viven en el registro core del pagador) + el KMS deriva los fiscales (`fiscal_name` / `tax_id` / `address` / `billing_email`) desde `payer_person_id` + reparto con SLIDER + presets (100/0, 50/50, 0/100) auto-balanceado a 100%. ESTO arregla el error `payers[1].billing_email required` del split 50/50.

## Pendiente — prompt CLI consolidado de step-up (3 items, misma maquinaria) por entregar

- [ ] Ventana de step-up DESLIZANTE (inactividad real): re-marcar `stepup_ok_<group>` fresco en CADA acción autenticada (`saveStep`, `saveResponses`, `uploadDocument`, `serveDocument`, `saveBillingInfo`, `submitGdprConsents`, `confirmReview`, `initiateSigningSession`) para que la actividad continua lo mantenga vivo y solo 10 min de inactividad real disparen OTP. Bug observado 2026-06-07: el OTP expulsó a Diego a los 10 min PESE a tener actividad (durante el flujo de firma nada re-marca la frescura).
- [ ] Magic-link 10-min grace SIN OTP vía nonce single-use de ESE envío (no marcar el grupo fresco al enviar — un token filtrado podría disparar un envío y colarse). Nonce en el link, TTL 600s, un solo uso → marca step-up fresco → sin OTP; expirado/usado/token pelado → OTP. Preserva KAL-7.
- [ ] Gate de PII en `resumeSession_` (línea ~1840): hoy NO llama `assertStepUpFresh_` y devuelve persons/relations/responses/documents → un token filtrado puede LEER la PII vía API sin OTP. Gatear: devolver solo estado/metadata hasta que el step-up esté fresco; PII completa tras OTP/nonce. (Los endpoints de mutación + `serveDocument` bytes + `initiateSigningSession` YA están gateados server-side.)

## Pendiente — frontend pequeño

- [ ] Copy del banner: "Estado: Admitida" + "está en revisión" es incoherente. El título es state-aware (P216) pero el cuerpo es el string genérico "en revisión / contacta con admisiones". Hacer el cuerpo state-aware (Admitida → "Tu plaza está admitida — continúa con la firma", etc.).

## Observacional / a verificar

- [ ] Presentación de los documentos en el Step 10 (Carta de Admisión + Contrato) — cómo renderiza.
- [ ] Confirmar el flujo completo 1→11 hasta el acto de firma real (Step 11).
