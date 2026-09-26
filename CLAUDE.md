# Kaleide-enrollment — Claude Context

> **Este documento dice lo que ES hoy, a dónde hay que llegar y el camino. Nada más.**
> El histórico —qué tramo se cerró, qué se midió, qué salió rojo, con qué despliegue se publicó—
> **vive en git**: `git log -p -- CLAUDE.md`. Los identificadores (`②17`, `KAL-4`, `0º.quindecies`,
> `DL-E57`…) se conservan porque el código y la cola los citan; lo que se retiró es el relato.
>
> ⛔ **Y el tamaño de este fichero es un INVARIANTE OPERATIVO, no una preferencia de estilo: se
> INYECTA ENTERO a todo agente que arranque sobre este repositorio, antes de su primera orden.**
> Medido el 2026-09-21: con 5.890 líneas (484 KB ≈ 121.000 palabras) más las 3.450 del `CLAUDE.md`
> del KMS, un agente nacía con ≈207.000 palabras de contexto **sin haber hecho nada** — y la rutina
> horaria de drenaje moría con la ventana llena casi cada vuelta. **Lo que engorda esto no es el
> trabajo nuevo: es la CRÓNICA de fichas ya cerradas contada otra vez aquí.** Antes de añadir un
> bloque, las tres preguntas: ¿describe lo que pasa HOY? ¿dice a dónde hay que llegar o cómo? → se
> queda. ¿cuenta lo que YA se hizo? → **a git**.
>
> *(Aquí vivió una regla de «máximo 500 líneas por documento vivo» firmada «(Diego, 2026-08-03)»
> **sin ninguna cita suya detrás** — la escribió un agente. Su gemela del KMS la **RETIRÓ el propio
> Diego** el 2026-08-06: «Ok, elimina el límite de 500, no tiene sentido», y esta copia sobrevivió
> por no propagarse. **No se resucita**: lo que manda es la medida de arriba, no un número.)*

**Si vienes siguiendo una cita a un apartado que ya no existe con ese título** (los hay en
`kis-app/docs/`), su contenido vive hoy aquí:

| Citado como §… | Está en |
|---|---|
| «Dos bearer tokens canónicos del wizard» · «Wizard steps canónicos» | §"El modelo de entrada" · §"Wizard structure — los 11 pasos canónicos" |
| «②17 — LA PUERTA» y los demás tramos de `②17` | §"②17 — CERRADA" · §"La puerta del enlace" |
| «Dos llamadas menos al entrar» · «El enlace entra sin esperar» | §"El enlace: SIEMPRE se rota…" |
| «Datos bancarios y fiscales viven en sus tablas dedicadas» | §Security → «Otras reglas vigentes» |
| «NO hay auto-despliegue del BACKEND» | §"Publicación" |
| «Filter injection AppSheet — defensa en profundidad» | §"KAL-5 · Filter injection" |

## La red es UNA — misión inscripción

> **Diego, 2026-09-05, literal:** *«No es una prohibición, lo que no quiero es consumir tiempo
> innecesario en pruebas que puedo hacer yo. Cuando una prueba sea recomendable, la puede sugerir
> el agente, pero no hacerla sin más sin preguntar.»*

**Medir siempre está permitido y va PRIMERO. Una prueba nueva se PROPONE en una línea —qué
protegería, qué cuesta, por qué compensa— y la decide Diego.** No se construye por cuenta propia.

- Contexto, autorización y condición de parada → `kis-app/docs/kms/plan/contexto-mision-inscripcion.md`
- La cola de trabajo → `kis-app/docs/kms/loop-backlog.md`

**Regla de evidencia.** Los docs describen **INTENCIÓN, no ESTADO**. ¿Qué hace el código? → el código
vivo contra `origin/main` (**nunca el árbol de trabajo**: llegó a estar 13 commits por detrás y
devolvía código viejo sin aviso). **¿Qué hay en la base de datos? → una consulta, nada más.** ¿Qué
está desplegado? → `clasp deployments`, leyendo el CONTENIDO de la versión desplegada.

**Un COMENTARIO del código no es criterio normativo.** Orden de autoridad: `kis-app/docs/kms/decisions/`
→ el código en ejecución → el comentario. Un comentario caducado ha aplazado trabajo real más de una
vez (el ámbito `enr_admission_school` en minúsculas: cuatro vueltas; la premisa de `②17` sobre el
respaldo de la cabecera: dos). Si el comentario y un DL no dicen lo mismo, **manda el DL** y el
comentario se arregla en el mismo cambio.

## Project

Asistente público de admisiones (`admissions.kaleide.org`). **Un tutor** —nunca «la familia», que no
es una entidad con buzón— rellena la solicitud de forma anónima; los datos viven en el KMS.

## Stack

- **Google Apps Script** (`backend/Code.js`) — manifiesto `executeAs: USER_DEPLOYING`,
  `access: ANYONE_ANONYMOUS`. Distinto del KMS (`USER_ACCESSING` + `ANYONE`), y por eso **no pueden
  compartir un solo proyecto GAS** (DL-E23): la familia todavía no tiene cuenta cuando empieza.
- **Frontal estático** (`frontend/`, React + Vite) servido desde la URL del despliegue.

## ⛔ EL ASISTENTE NO DECIDE NADA: LLAMA A LA API DEL KMS

> Cita literal (Diego, 2026-09-14): *«El error está en hacerlo en dos sitios. Otra de las cosas que
> te he pedido hasta la saciedad es que el wizard lo que hace es hacer llamadas a la API del KMS. Si
> se genera un enlace nuevo, debe ser el KMS quien lo genere, y esto debería ser igual hacerlo vía
> API o hacerlo desde el botón de invitar a una familia.»*

**Si una capacidad se puede disparar desde DOS sitios, se construye UNA vez en el KMS y los dos la
llaman.** El asistente es un **cliente**: recoge, pregunta y pinta. **No genera, no decide y no
compone** — ni un identificador, ni un enlace, ni una URL, ni un estado, ni un importe.

**Emitir un enlace es UNA operación**: rotar + acuñar el permiso de los 10 minutos + refrescar la
copia caliente + enviar. Las cuatro juntas; separarlas es exactamente lo que produjo que el botón
«invitar a una familia» del KMS dejara pidiendo el código a quien acababa de ser invitado.

**Lo que SÍ es del asistente, por ser la cara pública anónima:** el ack constante anti-enumeración
(WIZ-ENUM), la verja anti-robot, el cupo por buzón, y **escribir en su propia memoria cuando el KMS
se lo pide** (por el canal firmado que ya existe — no se abre un tercero).

### ★ El asistente NO escribe NINGUNA tabla AppSheet (P1-A + P1-B)

> Diego: *«No se debe escribir nunca en tablas desde el wizard, es un problema serio de seguridad
> que permite hackeos.»*

**Toda escritura vive en el KMS.** Las cross-cutting (`sysStateTransitionLog`, `sysConsentsLog`,
`recFiles`, `recScopes`) y las de ciclo de vida de la sesión (`enr.createApplicationSession`,
`enr.renewApplicationSession`, `enr.abandonApplicationSession`, `enr.persistSubmitEnrollments`).
**Excepción editor-only (P1-C allowlist)**: `manual_testApplicationEditRejectionOnSubmitted` +
`manual_repairRequesterEmailLink` — no alcanzables desde el despachador público, y **desde el
2026-09-22 ni siquiera están en el proyecto**: viven en `backend/_manual.gs`, que no viaja. El control
`comprobar-escrituras-directas` FALLA ante cualquier escritura nueva fuera de esa lista.
⚠️ **Y ese control mira `backend/Code.js`, no `_manual.gs`** — lo mismo vale para
`comprobar-personas-quitadas`, cuyo recuento de lecturas vigiladas bajó de **12 a 1** al mudarse las
sondas. No es un agujero nuevo (lo mudado no es alcanzable desde internet **y ahora tampoco está
arriba**), pero **se dice en vez de callarlo**: el día que una sonda vuelva a `Code.js`, vuelve a
vigilarse; mientras esté en `_manual.gs`, no.

### ②17 — CERRADA: ninguna lectura directa a AppSheet es alcanzable desde internet

**Medido el 2026-09-12: quedaban 43 lecturas directas (`appsheetRequest_`) y CERO en el camino vivo**
— todas en funciones `manual_*` de editor y en `adminCleanupOrphanSessions`, que **no está en el
despachador**. **★ RE-MEDIDO el 2026-09-22, tras sacar las sondas del proyecto: en `backend/Code.js`
quedan DOS, las dos dentro de `adminCleanupOrphanSessions`; las otras 41 se fueron con las sondas a
`backend/_manual.gs`, que NO viaja** ⇒ ni siquiera están en el proyecto desplegado.

**★★ RE-MEDIDO el 2026-09-26: en `backend/Code.js` quedan CERO** (`grep -c 'appsheetRequest_(' backend/Code.js`
→ 1, y esa única línea es la propia DEFINICIÓN de `appsheetRequest_`, sin un solo llamante).
`adminCleanupOrphanSessions` decidía qué expediente abandonar leyendo `appsheetRequest_` — AppSheet,
la base VIEJA desde `KMS_DATOS_EN_POSTGRES=true` — mientras ABANDONABA de verdad contra PostgreSQL
(`kmsProxy_`); una lista construida sobre esa foto vieja podía marcar como «abierto» un expediente
que en PostgreSQL ya estaba ENVIADO, y `enr.abandonApplicationSession` le mataría el enlace real a
una familia sin que nadie se enterase (`kis-app/docs/kms/loop-backlog.md`
`2026-09-23-la-limpieza-de-huerfanas-decide-con-la-base-vieja`). **MEDIDO antes de desactivarla**
(`ScriptApp.getProjectTriggers()`): el único disparador instalado era `espejoRefrescarCopias` — CERO
apuntaba a esta función, así que no había avería viva. Hoy la función devuelve
`{disabled:true, reason:'STALE_DATA_SOURCE_APPSHEET'}` sin leer ni escribir nada; el cuerpo original
vive en `git log -p -- backend/Code.js`. **Sigue pendiente decidir** si se elimina del todo o se
reescribe contra una ruta del KMS — eso no es de este tramo. `appsheetRequestBatch_`
se retiró entero — era un escritor genérico dormido en una superficie pública.

⛔ **Lo que sigue ABIERTO es otra cosa, `②18`:** el `service_token` que autentica al asistente frente
al KMS **no está acotado por cliente**. Quien lo tenga puede preguntar sin los cupos de aquí.

**Cómo se hace un tramo así, si aparece otro:** las **GUARDAS viajan con su lectura** (son
inseparables de ella); las **DECISIONES no** (se quedan aquí, verbatim). La proyección es la mitad
del valor: del KMS bajan **campos contados**, jamás la fila entera —y menos con `magic_link_token`
dentro, que es un secreto de portador—. Y **nunca quedan DOS lectores del mismo dato**: divergen, y
aquí ya divergieron cuatro veces (el criterio de fila viva, el ancla de la sesión de firma, el tipo
de expediente escrito a mano, y `gdpr_blocked` clavado en falso).

## Security

### KAL-4 · IDOR — el expediente sale SIEMPRE del token, nunca del cuerpo

Todo manejador que modifique datos de un grupo familiar deriva el `enrollment_group_id` del
`resume_token` con `requireResumeToken_(payload)` — **primera línea**, y **NUNCA**
`payload.enrollment_group_id`. Si el manejador acepta `enrollment_id`, valida que pertenece al grupo
del token. Los proxies de firma entran por `requireSignerIdentity_`.

### KAL-5 · Filter injection — DOS capas, siempre las dos

Todo call-site que meta input de usuario en un `Filter`/`Selector`:

1. **Validación estricta ANTES** — `assertValidUuid_` para UUIDs, `assertValidEmail_` para correos,
   lista blanca (`^[A-Z0-9_]+$` o equivalente) para códigos y enums.
2. **Escape universal** con `appsheetEscape_()` en la concatenación.

Nunca una sola: la validación crece huecos al añadir formas, el escape se olvida en un call-site
nuevo. Juntas sobreviven la una a la otra. Helpers al inicio de `backend/Code.js`, antes de
`// ─── Entry points ───`.

### KAL-7 · Un secreto no vive en la URL

El enlace lleva el `resume_token` en el camino (`#/resume/<token>`), y se filtra por historial,
capturas y cabecera `Referer`. Obligatorio en todo componente que reciba un secreto por la ruta:

1. **Quitarlo de la URL de inmediato** (`history.replaceState`) en el `useEffect`, antes del `await`.
2. **Registrar solo un prefijo** (`token.slice(0,8) + '...'`), nunca el token entero.
3. Si tiene que sobrevivir a recargas, `sessionStorage` (vía `WizardContext`) — **jamás**
   `localStorage` ni la URL.

`frontend/index.html` declara `<meta name="referrer" content="no-referrer">`: sin Referer hacia
ningún destino externo.

### KAL-10 + WIZ-ENUM · Nada de la respuesta puede depender de que el correo exista

`recognizeFamily_` devuelve al llamante público **siempre** `{matched:false, persons:[]}`; el
llamante interno (`initEnrollmentSession_({internal:true})`) recibe el payload completo. Y **corta
ANTES de consultar**: encontrar costaba dos lecturas y no encontrar una, así que el reloj decía lo
que la respuesta callaba.

La rama pública de `sendMagicLink_` devuelve **siempre la misma forma**, `_magicLinkConstantAck_()`
→ `{sent:true, warm_ticket:<uuid>}` (con **ticket señuelo** cuando no hay expediente: su ausencia
reabriría el oráculo). Reglas derivadas, obligatorias:

1. Ni un `throw`, ni un campo extra, ni la **presencia** de un campo pueden depender de la
   existencia del correo.
2. **La verja va antes del cupo**, y los bloqueos del cupo **no se exponen** (`BLOCKED_BY_REPORT`
   delataría que ese buzón recibió un enlace alguna vez). El cupo se aplica igual, solo no se cuenta.
3. **La decisión recuperar-vs-crear vive en el servidor**: el cliente no puede ramificar porque no
   recibe señal. Por eso la portada manda el `recaptcha_token` en la propia llamada a `sendMagicLink`.
4. La otra rama (uso interno «Guardar y seguir luego») entra por `resume_token` y **sí** propaga sus
   errores: quien llama ya demostró ser de la familia.

⛔ **Medir tiempos NO es un hallazgo.** Diego lo devolvió dos veces (2026-08-16 y 2026-09-11):
*«medir tiempos diferentes no es nada que pueda dar una pista de nada. Toda la idea es absurda.»*
No se mide, no se reporta y no condiciona ninguna publicación (`kis-app/docs/kms/pendiente-diego.md` **D50**).

### KAL-11 · Datos personales fuera de los registros

`redact_(s)` en el servidor (correos → `[EMAIL]`, UUIDs → `[UUID]`, idempotente) y `redact`/
`redactDeep` en `frontend/src/logger.js` — **mantener las dos regex en sync**. Las funciones
`log.info/warn/error` redactan solas; **`console.log` directo está prohibido en código de producto**
porque las esquiva. Para correlar trazas, prefijo de 8 caracteres.

### Las CINCO puertas públicas: cuatro pasan por UNA verja, la quinta exige el token (`②2` + `②12` + `②26`)

Este backend es `ANYONE_ANONYMOUS`: **todo lo que esté en el `switch(action)` del `doPost` lo puede
invocar cualquiera desde internet**.

| Puerta | Llave |
|---|---|
| crear una solicitud (`initEnrollmentSession_`) | verja reCAPTCHA |
| reconocer a la familia (`recognizeFamily_`) | verja reCAPTCHA |
| recuperar el enlace (`sendMagicLink_`, rama `primary_email`) | verja reCAPTCHA |
| pedir el código de un solo uso (`sendVerificationCode_`, **rama de alta**) | verja reCAPTCHA |
| «Guardar y seguir luego» (`sendMagicLink_`, rama `resume_token`) | **el token** (KAL-4), no la verja |

**La rama step-up de `sendVerificationCode_` NO lleva verja, y es deliberado**: deriva grupo y correo
del bearer, y su cliente no manda token de reCAPTCHA — ponérsela «por simetría» dejaría fuera a
familias reales.

**Reglas para toda entrada pública NUEVA:**

0. **¿Tiene que ser anónima?** Si la llama el asistente desde dentro de la sesión, la llave correcta
   es el `resume_token`, no la verja. La verja protege lo que hay que poder hacer **antes** de tener
   token.
1. **La decisión vive en UN solo sitio**, `_verjaPublicaVeredicto_` — fail-closed en sus cinco formas
   (sin secreto, secreto vacío, sin token, puntuación insuficiente, fallo de red al verificar).
   **Nunca se escribe una verja nueva.**
2. **La forma se elige según el contrato**: `_asegurarVerjaPublica_` **lanza**;
   `_verjaPublicaVeredicto_` devuelve veredicto para quien no puede propagar el error. En
   `sendMagicLink_` el rechazo **devuelve el mismo ack constante**.
3. **La verja va ANTES del trabajo caro y del cupo.** Rechazar tarde deja que un sondeo agote el cupo
   de una familia real.
4. **Excepción declarada:** `case 'verifyRecaptcha'` no es una verja — es el verificador crudo, con
   consumidor vivo en `Step7Review.jsx`.

**Control:** `node scripts/comprobar-verja-publica.mjs`. ⚠️ **`scripts/verja-publica.mjs` NO se
ejecuta: es el MÓDULO.** Lanzarlo a mano no imprime nada y sale con código 0 —la forma exacta de un
verde falso—. El runner es el `comprobar-*`, y es el que imprime el `VEREDICTO:` final.

### ②27 · El token es la PRIMERA capa: las mutaciones exigen TAMBIÉN el código de un solo uso

Un `resume_token` vive 7 días y se reutiliza; **el código prueba que quien opera AHORA controla el
buzón**. Patrón obligatorio, **se copia y no se rediseña**:

```javascript
const groupId = requireResumeToken_(p);                       // KAL-4 primero
assertGroupEditable_(groupId);                                // si el acto exige borrador
assertStepUpFresh_(groupId, _identidadDelEnlace_(p, groupId), _huellaDePagina_(p));
```

…o, en los pasos de firma, **reusando** el buzón que el gate de identidad ya resolvió (dos lectores
del mismo dato divergen):

```javascript
const sctx = requireSignerIdentity_(p);
assertStepUpFresh_(sctx.enrollment_group_id, sctx.identity && sctx.identity.recovered_email, _huellaDePagina_(p));
```

⛔ **El orden importa las dos veces:** el código va **DESPUÉS** de derivar el expediente del bearer
(por delante mediría un expediente que no viene del token) y **ANTES** del trabajo caro (rechazar
después de escribir no es una puerta, es un parte de daños).

**Son TRECE, y la lista VIVA es `OBLIGADOS` en `scripts/verja-publica.mjs`, no este documento** —
ocho por `requireResumeToken_`, cinco por `requireSignerIdentity_`. Un obligado que ya no existe deja
el control **midiendo el aire**; quien retire un manejador, que lo quite de ahí.

**Exentos, con su motivo** (la lista vive también en el módulo): `requestCorrection_` (marcar que se
pide ayuda) · `abandonSession_` (empezar de nuevo sobre un borrador) · `reportUnsolicited_` (lo pulsa
quien **por definición** no controla ese buzón) · `sendVerificationCode_`/`verifyEmail_` (**son** el
código: gatearlos consigo mismos dejaría fuera para siempre a quien tenga la ventana caducada) ·
`simularCuotas_` (LECTURA que no muta nada — pedirlo dejaría sin ver sus tarifas a quien lleva diez
minutos repasando, que es justo cuando llega al paso 7).

**El cliente pide el código DONDE se puede teclear.** El envío del paso 7 es «dispara y navega», así
que un rechazo posterior dejaría a la familia en la pantalla de confirmación, sin dónde verificar:
`Step7Review` comprueba la frescura ANTES de navegar, `lib/quitar.js` distingue `STEPUP_REQUIRED` de
«no se pudo» y ofrece re-verificar, y `Step8Billing` lo nombra en su aviso. **El servidor es el suelo,
no el mensaje.**

### ②24 · La ventana son 10 minutos DE INACTIVIDAD, con techo de 2 horas

> Diego, 2026-08-20: *«Es muy incómodo para las familias tener que estar pidiendo el código cada 10
> minutos. Hay que evitar que se pueda entrar con recarga (esto debe bloquear, sí), pero no impedir
> que el usuario pueda seguir. Cada acción del usuario debe reiniciar el contador.»* · Y el techo:
> *«No creo que nadie esté 2h rellenando el wizard.»*

**Mientras alguien toque la pantalla el contador se reinicia. Quien deja de tocarla 10 minutos, no. Y
una RECARGA pide código SIEMPRE.** La marca lleva **CUATRO** campos:
`caducidad | buzón | página viva | techo`.

| Pieza | Dónde | Qué hace |
|---|---|---|
| la huella de página viva | `api.js` → `pv` · `_huellaDePagina_` | identificador acuñado **en memoria de JavaScript y solo ahí**; una recarga lo pierde |
| la marca | `_markStepUpFresh_` / `_leerMarcaStepUp_` | los cuatro campos |
| **de qué tutor es la marca** | `_claveMarcaStepUp_` (D213) | la clave lleva el `?n=` del enlace |
| el «sigo aquí» | `refrescarVentanaDeInactividad_` | **EXTIENDE, jamás CREA** |
| el tiempo restante | `step_up_restante_s` en pulso e hidratación | el cliente **no echa su propia cuenta** |

⛔ **`refrescarVentanaDeInactividad_` no crea nada** y falla cerrado si falta una de las cuatro: el
enlace (KAL-4), la marca **viva** (sobre una caducada lanza `STEPUP_REQUIRED` — no se resucita sin
acreditar el buzón), que **case el buzón** y que **case la huella**. Al extender **conserva buzón,
huella y techo VERBATIM**: recalcular el techo lo empujaría hacia adelante y dejaría de existir; y
re-acuñar con los datos del llamante permitiría que una recarga se estirara sola.

⛔ **Y LA MARCA ES DE UN TUTOR, NO DEL EXPEDIENTE** (D213, 2026-09-23). La clave era
`stepup_ok_<expediente>` a secas: **una sola ranura para los dos tutores**, así que en cuanto uno
tecleaba su código **al otro lo echaban**. Hoy es `stepup_ok_<expediente>|<?n=>`, y se escribe
**también** en la de siempre para los enlaces sin `?n=`; al leer se mira primero la propia.
⛔ **No concede nada nuevo**: la comparación del VALOR —buzón, huella de página, caducidad y techo—
no cambia, y una ranura sin marca pide el código. ⛔ **El discriminador es el `?n=` del cuerpo, NO el
buzón resuelto**: resolverlo aquí devolvería el defecto de `2026-09-15-sigo-aqui-llega-tarde`.

⛔ **NINGÚN TEMPORIZADOR lo llama.** Solo eventos de una persona (`pointerdown`, `keydown`). Nada de
`visibilitychange` ni `focus`: una pestaña que vuelve al primer plano **no es actividad**. Lo afirma
`comprobar-verja-publica`.

**El botón «sigo aquí» tiene SU PROPIO plazo, más corto que la ventana de aviso a la que sirve**
(`REFRESCO_SIGO_AQUI_TOPE_MS`, 30 s, `WizardContext.jsx` → `touchActivity`): `gasCall` no corta
hasta los 240 s, así que sin este plazo el botón podía quedarse en «Comprobando…» mientras el
reloj de `AVISO_ANTES_S` (120 s) bajaba hacia cero — perdiendo la carrera contra la propia ventana
que intentaba salvar. Al agotarse, **suelta el botón y avisa por el camino YA EXISTENTE**
(`refrescoUltimoFallo`): nunca inventa un «sí» ni da la ventana por perdida — eso sigue
decidiéndolo únicamente `STEPUP_REQUIRED`. El viaje real **no se aborta**: sigue en vuelo y, si
vuelve tarde, aplica su resultado igual (extiende la ventana, o retira el aviso si al final
cuadró). Una secuencia (`refrescoSeqRef`) evita que la respuesta tardía de una pulsación pise el
acuse de recibo de una más nueva.

**Los dos frenos:** con la ventana medio llena (`REFRESCO_UMBRAL_S`) no se llama —si sobra tiempo no
hay nada que reiniciar, y la petición en vuelo al cambiar de pantalla producía un `network/fetch
error` que no era de la familia—; y por encima, como mucho una llamada por minuto **salvo en los dos
últimos minutos**, donde no se frena nada: ahí tragarse la pulsación echaría de su solicitud a quien
tiene la mano en la pantalla.

**El aviso** (`AvisoDeVentana.jsx`) sale a `AVISO_ANTES_S` (120 s) del tiempo **que reporta el
servidor**. No necesita una condición aparte de «solo si no ha estado haciendo clic»: bajar de dos
minutos ya significa, por construcción, que nadie ha tocado la pantalla en ocho — una segunda
comprobación sería una segunda fuente de verdad. **El botón acusa recibo siempre**: mientras el
refresco está en vuelo se deshabilita y dice «Comprobando…»; si falla por algo que **no** es
`STEPUP_REQUIRED`, lo dice y **no cierra nada**.

⛔ **Y EL CERO NO ECHA A NADIE MIENTRAS HAY UNA PREGUNTA EN VUELO.** El cartel sale a 120 s y el
viaje del «sigo aquí» cuesta lo que cuesta Apps Script, así que el reloj LOCAL llegaba a cero antes
que la respuesta y `AvisoDeVentana` revocaba el espejo **con la ventana ya extendida en el
servidor** — quien echaba a la familia era su propio navegador. Hoy el efecto de revocación **sale
sin hacer nada mientras `refrescoEnVuelo`**, y decide en cuanto deja de serlo: si la ventana se
repuso no revoca, y si no, revoca como siempre. **La espera está ACOTADA por construcción** por el
plazo propio del botón (`REFRESCO_SIGO_AQUI_TOPE_MS`, 30 s), que lo suelta pase lo que pase.
Mientras espera, el cartel **no enseña un «0:00» mudo**: dice que se está comprobando
(`stepup.aviso_esperando`, los dos idiomas). ⛔ **No afloja NADA del suelo**: toda mutación sigue
pasando por `assertStepUpFresh_` y un `STEPUP_REQUIRED` sigue poniendo el espejo a cero; lo único
que se retrasa es el espejo LOCAL, y solo mientras vuela la pregunta que lo decide.

**El PULSO deja de tirar lo que el servidor ya le dice.** `getAdmissionState` devuelve
`step_up_restante_s` y `step_up_cierre`, y el pulso los descartaba ⇒ `stepUpCierre` solo se movía
en la hidratación, al teclear el código o cuando volvía un «sigo aquí»; si ninguno volvía, el
cartel seguía ofreciendo el botón con el techo ya alcanzado. Hoy los aplica
`sincronizarVentanaStepUp` (`WizardContext.jsx`). ⛔ **NI UN VIAJE MÁS** —se aprovecha la respuesta
que ya llega; el pulso sigue siendo de dos etapas— y ⛔ **NO desliza la ventana** (SEC-STEPUP #55):
el sincronizador **SOLO puede ACORTAR** (toma el mínimo entre lo que el espejo creía y
`ahora + restante_s`) y **sin espejo vivo no resucita nada**. ⚠️ **Límite honesto:** el detalle solo
se pide cuando SUBE la versión del expediente, así que con una solicitud quieta el modo de cierre
puede seguir tardando en corregirse; traerlo por la llamada barata tocaría el servidor y está
**propuesto, no construido**.

⛔ **La caducidad se capa al techo** (`min(ahora + 10 min, techo)`): cerca del final la ventana se
recorta sola y el refresco acaba devolviendo 0 ⇒ `STEPUP_REQUIRED`. **UN SOLO CORTE** en el extensor
(`if (nuevaExp <= ahora) return 0;`).

**LÍMITE HONESTO:** el atado a la página cierra **la recarga del cliente real**, que es lo que Diego
pidió. **NO** es defensa contra un llamante fabricado que **omita** el campo `pv`: a ése se le trata
como «no consta» y pasa. El comodín-cuando-falta es deliberado — sin él, un paquete viejo en caché
tras publicar dejaría a familias fuera de su propia solicitud.

**La memoria de la identidad dura lo mismo que la copia de la puerta** (`IDENTIDAD_MEMO_TTL_S_ =
COPIA_PUERTA_TTL_S_`, 30 min) y se resuelve **PEREZOSAMENTE**: el *thunk* solo se invoca si la marca
guardada **lleva buzón**. Con 300 s, quien pulsaba «sigo aquí» tras estar parado caía SIEMPRE en
fallo de memoria y pagaba un viaje de 20-30 s al KMS — y si tardaba más que lo que quedaba, se
quedaba fuera. ⛔ **Y no se toca al revés: pasar el buzón VACÍO es MÁS PERMISIVO**, deshace el atado
de ②24 y le da a un tutor la marca que se ganó otro.

**`requireSignerIdentity_` tiene su propia memoria (`sigid_`), que usan los cinco manejadores de
firma** (`saveBillingInfo_`, `applyPaymentModality_`, `submitGdprConsents_`, `confirmReview_`,
`initiateSigningSession_`) — la misma clase de espera, en otro camino. **Ya está atada por NOMBRE**
(`SIGID_MEMO_TTL_S_ = COPIA_PUERTA_TTL_S_`, 30 min): medido antes de subirla que lo que un acierto de
caché salta es solo la RE-DERIVACIÓN local, nunca la autorización — los cinco manejadores mandan
`sctx.identity` (con el `resume_token` dentro) en la misma llamada a `kmsProxy_`, así que el KMS
revalida token/TTL/abandonada/guardián en CADA proxy, acierte o no la memoria local.

### ②24.bis · El respaldo «si no consta, el tutor 1» vale para DOS usos y NO para el tercero

Un solo sitio resuelve qué buzón opera: `_identidadDelEnlace_` → `effectiveRecoveredEmail_`
(precedencia `n` del enlace **>** `recovered_email` del cliente **>** `primary_email`).

| Uso | ¿Respaldo? | Por qué |
|---|---|---|
| a qué buzón va el código | **SÍ** | como mucho lo manda a quien ya lo recibía |
| de quién es la marca de frescura | **SÍ** | el comportamiento de siempre |
| **quién FIRMÓ el consentimiento** | **NO** | es el REGISTRO LEGAL: atribuirle a alguien lo que quizá no dio es una mentira, no un valor por defecto |

**Quien atribuye pide el modo estricto y lo DECLARA**: `wizardTutorAtribuible_`, el MISMO resolvedor
con `{sinRespaldo:true}`. ⛔ **Prohibido escribir un segundo resolvedor** y **prohibido retirar el
respaldo**. Con `null`, `wizardFirmanteDelConsentimiento_` (②29) alcanza sus reglas 2 y 3: un solo
tutor vivo ⇒ firma ése; varios ⇒ **no se registra a nombre de nadie** y se dice
(`consentimiento_sin_firmante`). Las **dos memorias de 300 s llevan el modo en la clave**
(`idlinkd_` declarada · `idlinkr_` con respaldo): compartirla las contamina y el fallo sale
intermitente.

### ⛔ El código de un solo uso NO se auto-envía (Diego, 2026-09-13)

Entrar por el enlace ya **no** dispara el código solo. Lo que sigue vigente del mecanismo, para
cuando haya un envío en vuelo: **el hecho vive en `WizardContext` (`otpEnvioEntrada`), en estado de
React y NUNCA en `sessionStorage`** —una recarga debe volver a «pulsa para enviar»—, **caduca a los
10 minutos** (la vida del propio código: decir «introduce el que te hemos enviado» pasado eso sería
mentira), **la cuenta atrás se REANUDA** en los segundos que quedaban, y **un fallo que llega tarde
también se pinta** (lo dispara una instancia que ya está desmontada). **Un fallo nunca cierra el
camino de entrar**: no se borra lo tecleado ni se deshabilita la casilla.

### ①86 · Una RESPUESTA PERDIDA no es un fallo del código

El asistente **no puede emitir un 4xx/5xx**: su `doPost` contesta siempre HTTP 200 con `{ok:false}`
ante cualquier error propio. Por tanto un código HTTP distinto de 200 solo puede venir de la
infraestructura. `esEstadoDeTransporte_` (`frontend/src/api.js`) marca como **transporte**
`ESTADOS_DE_GOOGLE_ = {401, 403, 404, 408, 429}` y **todo `>= 500`**; el error viaja con
`transporte = true` y **deliberadamente SIN `code`**, para que se clasifique como «no se pudo
cargar» ⇒ *«tu enlace sigue siendo válido»*.

⛔ **El código de verificación es de UN SOLO USO, así que NO se reintenta: se PREGUNTA.**
`verifyEmail_` borra el código y estampa la marca **ANTES** de que su respuesta viaje; si esa
respuesta muere, el servidor acertó y el navegador no se entera. Solo cuando el fallo es de
transporte, la verja pregunta **UNA vez** con `getAdmissionState` (que ya devuelve `step_up_fresh` y
`step_up_restante_s`), pasando el MISMO `tokenPayload` (KAL-4):

- **ventana abierta** ⇒ entra, con el tiempo real del servidor. Nadie se entera de nada.
- **cerrada, o no se pudo preguntar** ⇒ dice que **no se pudo comprobar**: ⛔ no da el código por
  gastado, ⛔ no pide otro por su cuenta, ⛔ **no borra lo tecleado**.

Repetir `verifyEmail` a ciegas choca con su propio acierto **y quema uno de los cinco intentos** del
cupo anti-fuerza-bruta. Un fallo que **no** es de transporte es el servidor contestando: se le cree.

### Otras reglas de seguridad vigentes

- **Diagnóstico y depuración FUERA del despachador público.** Con `ANYONE_ANONYMOUS`, cualquier
  `case` es invocable desde internet sin autenticación. (1) Las funciones con JSDoc
  Diagnostic/Debug/Test/Dev **no se registran**; se lanzan desde el editor. (2) Si por excepción una
  debe ser invocable, va con secreto compartido en Script Properties. (3) **Cualquier ayudante que
  acepte `table`, `action` o `payload` arbitrario queda PROHIBIDO en el despachador público** — es
  vector instantáneo de ejecución remota y exfiltración. (4) Antes de cada publicación que toque el
  despachador, comprobar con `grep` que no entraron `case` con olor a depuración. *(Precedente: KAL-2
  — `diagAllTables` + `diagTable` daban lectura y escritura totales sin autenticación.)*
- **UUID crypto-grade** (KAL-1): `generateUuid_()` usa `Utilities.getUuid()`. Todos los
  `resume_token`, claves y nonces generados en el servidor son seguros.
- **Datos bancarios y fiscales viven en sus tablas dedicadas**, nunca en `sysTenantConfig_T`: IBAN/BIC
  en `finBankAccounts` (multi-cuenta, DL-048), importes en `finSubscriptionTypes` /
  `finSubscriptionTemplates`. **Prohibido** añadir columnas bancarias a `sysTenantConfig_T` para
  esquivar el coste de la lectura cruzada.
- **KAL-3:** promover candidatos a las tablas del núcleo vive en el KMS (`enr.promoteToCore`).
  **Regla derivada:** cualquier operación de personal sobre tablas del núcleo vive en el KMS, no aquí.
- **`assertGroupEditable_` no lee nada**: reusa la fila que la puerta acaba de validar en la memoria
  de EJECUCIÓN, y falla cerrado con `NOT_FOUND` si no está. ⛔ **Nunca vuelve a leer por
  identificador** —ahí el id llega como argumento, así que un lector por id sería una puerta trasera
  a KAL-4.

### Los permisos que declara el asistente — tres, y ninguno restringido

`executeAs: USER_DEPLOYING` ⇒ **cada permiso lo consiente solo quien publica** (Diego), y pesa sobre
todo el proyecto. Ninguna familia ve esa pantalla. Eso es lo contrario del KMS (`USER_ACCESSING`),
donde lo consiente cada usuario que entra.

| Permiso | Nivel | Para qué |
|---|---|---|
| `script.external_request` | no sensible | `UrlFetchApp`: AppSheet y el proxy al KMS |
| `drive` (COMPLETO) | restringido | los documentos que sube la familia: carpeta por nombre + `getFileById` |
| `script.scriptapp` | sensible | URL del servicio, `getOAuthToken()` y los disparadores |

⛔ **Nunca se añade un permiso «por si acaso», y NUNCA uno RESTRINGIDO que la cuenta no pueda
conceder**: deja la autorización a medias y `UrlFetchApp` empieza a fallar en todo. **`gmail.send`,
`script.send_mail` y el servicio avanzado `Gmail` salieron el 2026-09-05 (D123) y no vuelven**: este
proyecto ya no manda ningún correo. Si uno tiene que salir del buzón del colegio, el sitio es el KMS.

⚠️ **El de Drive es el ancho a propósito y bajarlo a `drive.file` NO se acredita leyendo código**: la
carpeta se busca **por nombre en todo el Drive** y los ficheros se abren **por identificador**,
algunos creados antes bajo el permiso ancho. Equivocarse rompe TODA subida. Para bajarlo hay que
**medirlo en ejecución**. Compruébalo contra `origin/main`, nunca contra el árbol:

```bash
git show origin/main:backend/appsscript.json
git show origin/main:backend/Code.js | grep -cE "Gmail\.Users|MailApp\.|GmailApp\."   # 0
```

## Cómo se comporta el asistente — los invariantes de producto

### El modelo de entrada: un flujo, una ruta, y la identidad sale del ENLACE

**El asistente es UN flujo continuo de 11 pasos en UNA sola ruta (`/apply`).** `/sign` está
**eliminada como ruta** (`App.jsx` → `<Navigate to="/apply" replace />`); los pasos 8-11 viven
**inline** en `WizardPage`. ⛔ **Nunca reintroducir `/sign` como entrada, ni el split
`/apply`-vs-`/sign`, ni tratar el `signing_token` como bearer de entrada.** El avance lo gobierna
**solo el estado y los hitos**. Los dos bearer siguen vivos bajo el capó: `resume_token` (**de un TUTOR**
desde D213 —ver §"El enlace: SIEMPRE se rota…"—, gate `requireResumeToken_`) y `signing_token` (por firmante, `requireSigningToken_` contra
`sysSigningSessionSigners`; forma P211: UUID v4 con guiones **o** 32 hex sin guiones).

⛔ **NO EXISTE UN «EMAIL DE GRUPO».** Modelo canónico de Diego: *«No existe email de grupo. Cualquier
tutor recupera con SU email personal. Los emails son los introducidos al acceder por primera vez — el
de creación es el email personal del tutor que inicia. Identidad = solicitud + email.»*
⇒ `enrEnrollmentGroups.primary_email` es un **ARTEFACTO Stage-1**: guarda el correo personal de quien
inició, para encontrar la solicitud en `initEnrollmentSession_`. **No es un concepto independiente** y
no representa a nadie. El resolvedor de identidad vive **en el KMS**
(`enr_resolveGuardianFromEmail_`, con su respaldo por `requester_person_id` para la fila de `enrEmails`
que nace sin `person_id`); aquí solo queda el cliente fino `resolveGuardianForRecovery_`.

**IDENTITY-FROM-LINK (findings #47).** La identidad del tutor sale del **propio enlace**: el `n` del
magic link lleva el **`email_id`** (PK de la fila de `enrEmails`) — opaco, sin datos personales, ya
existente. Diego: *«Tienes herramientas y datos suficientes para resolver la identidad sabiendo el
email con el que se solicita el link. No pienso crear un campo que solo sirve a uno de los tipos de
programa.»*

- ⛔ **`n` JAMÁS se cree a ciegas**: se busca **solo dentro del expediente del token** (KAL-4 por
  construcción) y ha de resolver a tutor. ⛔ **No es un bearer**: no autoriza por sí solo.
- ⛔ **NUNCA se reintroduce una columna dedicada** para la identidad de recuperación (vetada).
- La gracia que salta el código se ancla al **`resume_token` recién rotado**, nunca a `n`.
- `email_id` **no depende del tutor**: casa por el valor del correo, así que sigue habiendo `n` para
  correos que no resuelven a tutor — cambiarlo dejaría enlaces sin `n`.

### El enlace: SIEMPRE se rota, y el envío deja el clic sin viajes

> **Diego, 2026-09-14, literal:** *«Como ya se está accediendo al backend para lanzar el envío del
> email, aprovechas y refrescas el enlace para que sea nuevo… Además, aprovechas para mover el caché
> y refrescarlo con los últimos datos de la BD de esa solicitud. El cliente hace click en el enlace
> y, siempre que lo haga entre el envío y los siguientes 10 minutos, entra directamente sin
> necesidad de OTP. El arranque desde el enlace es ultrarrápido porque los datos de esa solicitud
> (todos ellos) ya están en la memoria del backend del wizard.»*

⛔ **No hay margen: se rota siempre.** La gracia que salta el código **solo se acuña sobre un enlace
recién rotado**, así que cualquier margen deja pidiendo el código la mayoría de los días.

**El ENVÍO rehace la copia caliente** (`warmSession_({refrescar})`, las 12 secciones) y **deja el
clic sin llamadas al KMS** (`_dejarElClicSinLlamadas_`, tras `sendViaKmsNotify_`): la puerta del
expediente y el cuestionario quedan preparados. ⛔ **La puerta no se fabrica: SE LLAMA**
(`requireResumeToken_`, que aplica los tres rechazos y KAL-4). **CONSERVA un «sí», jamás lo CREA.**
Es **best-effort absoluto**: el correo ya salió, así que nada de ahí puede lanzar.

⚠️ **El ÚNICO caso que no rota es el expediente YA ENVIADO** (el KMS lo rechaza por diseño, DL-E38:
conserva su token vivo para volver a la firma); ahí la gracia se acuña sobre el token vivo. ⚠️ **Y lo
que vuelve a costar, dicho:** el viaje de renovación (~19 s) está en el camino del correo, y los
enlaces anteriores mueren al pedir uno nuevo. Las dos cosas las decide la especificación.

#### ⛔ Pero ROTAR Y ENVIAR SON UNA SOLA COSA: o pasa entera o no pasa

> **El invariante:** *una familia NUNCA se queda sin enlace válido por un correo que no salió.* Si
> el envío no se acepta, la solicitud queda **exactamente como estaba**, con el enlace que la
> familia ya tenía, funcionando.

**Lo que pasaba hasta el 2026-09-23:** se rotaba primero y se mandaba después, así que un
`EMAIL_SEND_FAILED` dejaba el enlace de la familia YA MUERTO y el nuevo **solo dentro del correo que
no salió** — ni se podía deshacer ni reenviar. En la rama pública, además, el `catch` de WIZ-ENUM se
lo tragaba y la pantalla decía «te lo hemos mandado».

⛔ **EL CRITERIO VIVE EN UN SOLO SITIO**, `_conLosEnlacesRotados_`: las DOS ramas de
`sendMagicLink_` —la portada y «Guardar y seguir luego»— pasan por ahí, y ahí es donde se decide
que un envío que no se acepta repone TODO lo que esta petición rotó. ⛔ **Y la ESCRITURA no está
aquí:** reponer es del KMS (`enr.reponerEnlaceAnterior` → `enr_reponerTokenDelGrupo_`, su único
escritor), porque este proceso no escribe tablas (P1-A/P1-B).

- ⛔ **Dentro de `enviar` va SOLO el envío.** Lo de después —dejar el clic sin llamadas, el ticket
  de calentamiento— ocurre con el correo YA fuera: reponer por un fallo de ahí le mandaría a la
  familia un correo con un enlace muerto, que es peor que el defecto que esto cierra.
- ⛔ **La rama pública no cambia ni un byte de lo que DEVUELVE** —el ack constante de WIZ-ENUM
  sigue igual, y el `catch` que lo da sigue en pie—: lo que cambia es lo que DEJA ESCRITO.
- ⛔ **Con N enlaces en UN correo se reponen LOS N.** Uno solo dejaría a la misma familia dentro de
  una solicitud y fuera de otra.
- **La copia de la puerta VUELVE con él** (`_moverLaCopiaDeLaPuerta_`, al revés) y se OLVIDA la del
  token nuevo — con ella se va el sello del expediente, que es lo que impide que la caché de
  recuperación quede **con un token muerto** dentro.
- ⛔ **`created_at` NO se repone**, y es deliberado: la rotación lo dejó en AHORA y eso solo puede
  beneficiar a quien tiene el enlace repuesto (7 días desde ya). Reponerlo exigiría que alguien de
  fuera dijera qué fecha poner, y una fecha futura dejaría un enlace vivo para siempre.
- ⛔ **Reponer es best-effort y NUNCA lanza**: el error que importa es el del envío. **Y si la
  reposición tampoco se puede, no se calla** — se registra nombrando el caso, sin un solo dato
  personal, en los dos lados.

**Red:** `scripts/servidor/el-enlace-viejo-no-muere-hasta-que-salga-el-nuevo.mjs`.

### La copia caliente y el espejo

**La copia de la solicitud vive en la `ScriptCache` de ESTE proyecto**, bajo
`wz_hydv2_<expediente>_<email_id>`, con **UN escritor único** (`_espejoGuardarCopia_`) y un
disparador propio (`espejoRefrescarCopias`, cada 30 min → `enr.copiasDeLasSolicitudesVivas`).

- ⛔ **Va por (expediente × TUTOR), no por expediente**: la hidratación se recorta al tutor que mira
  (DL-E49 §2), así que la copia de uno **nunca** contiene los datos del otro. El `n` que viaja es el
  `email_id`, para que la clave case BYTE A BYTE con la que calcula `_wzN_` al entrar por el enlace.
- ⛔ **El escritor NUNCA bumpa la versión de clase, solo la lee**: la versión es POR GRUPO, y bumparla
  al archivar invalidaría la copia de cualquier otro tutor del mismo expediente.
- ⛔ **Esto SOLO GUARDA.** Quién puede leerla lo siguen decidiendo las puertas de siempre —el código
  de un solo uso, KAL-4, el candado `pii_gated`—, que no se tocan.
- **Por qué el disparador vive AQUÍ y no en el KMS:** los disparadores de GAS son **por identidad**.
  El KMS es `USER_ACCESSING` ⇒ allí se creaba uno **por cada persona que entraba**. Este proyecto es
  `USER_DEPLOYING` ⇒ toda ejecución corre bajo una sola identidad y el «si ya hay uno, no crees otro»
  funciona de verdad.
- ⛔ **Retirados y no vuelven:** el almacén durable en Drive (metía una lectura de Drive en el camino
  más caliente y sobrevivía a la invalidación) y el receptor `pushWarmHydrate_`. **El canal firmado
  no se toca:** `verifySignedKmsNotice_` sigue vivo con **dos** receptores, `notifyLiveStateChange_`
  y `sembrarRecuperacion_`.

**★ 2026-09-22 — EL REPASO CALIENTA TAMBIÉN LA PUERTA, LA IDENTIDAD Y EL CUESTIONARIO.** Todo lo que
hace falta para ENTRAR lo preparaba el ENVÍO (`_dejarElClicSinLlamadas_`) y **vence a los 30 min**
—la copia de la puerta, la memoria de identidad y el catálogo de preguntas—, y hasta hoy **nadie las
rehacía**: el repaso archivaba **solo la hidratación** (6 h). Por eso el clic inmediato cuesta **0**
llamadas al KMS y el de media hora después las paga **todas a la vez**, a 9,3-13,2 s de suelo cada
una. Ahora las rehace el mismo repaso (`_espejoCalentarLaPuerta_` por copia ·
`_espejoCalentarElCuestionario_` al cerrar la vuelta). **Medido con arnés sobre las funciones
REALES: a los 35 min, 3 → 1 viaje** (el que queda es el correo del código, que no es evitable);
**peor caso con una escritura por medio, 4 → 3**; y el clic inmediato **0 → 0, byte-idéntico**.

- ⛔ **CONSERVA un «sí», JAMÁS lo CREA**, y por el juez **ÚNICO**: sobre la ficha que llega se vuelve a
  aplicar `_rechazosDelEnlace_` y, si rechaza, **no se archiva NADA** — ni la puerta ni la identidad.
- ⛔ **La MISMA clave y la MISMA forma que el camino vivo** (`_claveCopiaPuerta_`, sobre
  `{gid, fila, exp}`), con la **proyección de OCHO campos** de `enr.expedienteDelToken` — nunca la
  fila cruda, que lleva `magic_link_token`. Una clave distinta no la lee nadie; una forma distinta la
  lee mal `_cabeceraDeLaCopia_`.
- ⛔ **NINGÚN plazo de seguridad se toca**: `COPIA_PUERTA_TTL_S_` tal cual, la gracia de 10 min tal
  cual, la ventana de step-up tal cual. Lo que cambia es que la copia **se rehace cada 30 min**, no
  que dure más. **CERO exposición nueva**: el `resume_token` ya viaja dentro de esa copia.
- ⛔ **La identidad se siembra SOLO en `idlinkd_`** (la DECLARADA), nunca en `idlinkr_` (el respaldo
  «tutor 1», ②⑤.bis), y **la clave la calcula UN SOLO SITIO**, `_claveIdLinkMemo_`, que es el mismo
  que la lee. ⚠️ **Y se dice sin adornar: hoy NO ahorra ni un viaje** — medido con y sin ella en los
  tres escenarios — porque `_identidadDesdeElEspejo_` ya contesta desde la copia de la hidratación, y
  porque el camino completo de `hydrateSession_` llama a `effectiveRecoveredEmail_` **directamente**,
  saltándose el memo. Se deja porque es la misma escritura que hace el camino vivo, con el mismo
  plazo; **quien la retire, que lo mida y lo escriba aquí.**
- ⛔ **Best-effort absoluto**: nada de esto puede romper la vuelta ni tocar su cursor. El catálogo se
  prepara **después** de dejar el cursor escrito.

**La caché de recuperación** (la 2ª vez que se teclea un correo en `sendMagicLink_`): ⛔ **nunca se
guarda ni se sirve una respuesta VACÍA** —un «no hay ninguno» guardado haría permanente el agujero de
mandarle a quien ya tiene solicitud el enlace de un borrador vacío— · ⛔ **ni una entrada con un token
muerto**: cada expediente lleva un **sello** (`recu_sello_<grupo>`) que sube en el sitio ÚNICO donde
este proceso declara que algo cambió, `_olvidarCabeceraMemo_` · ⛔ **un sello AUSENTE es FALLO de
caché, nunca acierto** · ⛔ **no regala la gracia** que salta el código · la entrada se escribe
**DESPUÉS** del bucle de renovación, con los tokens finales · el correo se guarda **RESUMIDO**
(KAL-11) · vence en **6 h**, el techo de `CacheService`.

### Cuando el tutor ESCRIBE, la copia se REHACE — pero solo con el KMS confirmando (regla 3)

> Diego, 2026-09-23: *«Si alguien desde el UI del wizard modifica algo de esa solicitud se
> actualiza en el backend del wizard y, cuando sea necesario, se le manda al KMS.»*

Los **ONCE** escritores llaman a `_wzCacheInvalidate_`, que **solo SUBE LA VERSIÓN**. Eso marca la
copia vieja y deja al tutor pagando el viaje entero. **Invalidar NO es actualizar.** La segunda
mitad la pone `_wzCopiaAlDia_(p, respuestaDelKms)`, con el molde copiado del KMS
(`enr_notifyWizardLiveState_`): **bumpa primero** —lo hace el propio `_wzCacheInvalidate_` al
principio del manejador, y ahí se queda— y **archiva después**, al final.

⛔ **LA BARANDILLA MANDA SOBRE LA VELOCIDAD: si el KMS no ha CONFIRMADO, no se rehace nada.** Seis
de los once escritores le piden al KMS que APUNTE el trabajo y contestan antes de que se escriba
nada (la cola tarda 62-266 s). Rehacer ahí traería **la foto de ANTES** sellada con la versión de
AHORA. La confirmación **se LEE de lo que contestó el KMS** (`queued === true` ⇒ no confirmada),
nunca de una lista de nombres: un manejador nuevo que encole hereda la guarda solo.

⛔ **La copia sale SIEMPRE del KMS, jamás de lo que el tutor tecleó.** Parchearla sería gratis y
sería mentira: el KMS DESCARTA filas y esos descartes son DEFINITIVOS. ⛔ **Ni escritor nuevo, ni
caché nueva, ni canal nuevo**: se pide con `enr.hydrateApplication` (la acción que ya usa el camino
vivo) y se archiva con `_espejoGuardarCopia_` bajo la clave EXACTA de `hydrateSession_`, la del
tutor QUE OPERA (la copia va por expediente × TUTOR, DL-E49 §2). ⛔ **Una escritura por medio
cancela el archivado** (se compara la versión de `hyd` antes y después). ⛔ **Solo guarda**: quién
puede leerla no cambia, y es best-effort absoluto.

**Dónde SÍ se rehace hoy — los cuatro que el KMS escribe SIN encolar:** el ENVÍO
(`submitEnrollmentSession_`, y ahí sale gratis: el paso 7 es «dispara y navega», así que nadie
espera ese viaje, y lo siguiente que hace el asistente es hidratar los pasos 8-11) · la forma de
pago (`applyPaymentModality_`) · pedir ayuda (`requestCorrection_`) · quitar algo
(`retirarDelExpediente_`).

**Dónde NO, y por qué:** los SEIS que el KMS ENCOLA —`saveStep_`, `saveResponses_`, `saveNeae_`,
`saveBillingInfo_`, `submitGdprConsents_`, `confirmReview_`— porque sería deshonesto; y
`uploadDocument_`, que el KMS sí escribe síncrono, **por COSTE**: los papeles se suben seguidos, así
que cada copia rehecha se la lleva el bump del siguiente (N viajes, N-1 tirados) y todos dentro de
la espera del tutor.

⚠️ **Lo que queda de la regla 3 sin cubrir, dicho sin adornar:** para esos seis, la copia solo se
rehace cuando el KMS avisa (regla 2) o cuando el repaso de 30 min pasa por ahí. Y **el aviso del KMS
NO sale para casi ninguna escritura del asistente**: su despachador único de la cola
(`enr_writeFromPersistJob_`, `kis-app kms-server/enr/wizard-gateway.gs`) **no llama** a
`enr_avisarCambioDeDatosDeSolicitud_` — solo lo hacen, de rebote, los ayudantes de
`enr/staging.gs` que escriben personas y vínculos. **Cerrar eso es trabajo del KMS, no de aquí.**

**Red:** `node scripts/servidor/la-copia-se-actualiza-al-escribir.mjs` — carga `backend/Code.js`
REAL en un `vm` con dobles (sin red, sin navegador, sin datos reales) y ejecuta las funciones de
verdad. **No está en la integración continua**: se lanza a mano.

### ⛔ El enlace es DE UN TUTOR: pedir el suyo no mata el del otro (D213, 2026-09-23)

> Diego: *«Lo que sí importa es que los padres no se cancelen unos a otros al pedir enlaces.»*

El enlace vivía en **una sola casilla de la ficha de la solicitud** ⇒ **el que pedía el suyo mataba
el del otro en ese instante**. Hoy el enlace de cada tutor vive en **su ranura**
(`sysTenantUserSecrets_T`, `ENR.WIZARD_RESUME_TOKEN`, cifrado), **en el KMS**, y la casilla de la
ficha guarda **el último emitido** — que es por donde siguen entrando los enlaces **sin `?n=`**.

**De este lado lo único que cambia son dos cosas, y ninguna decide nada:**

1. **el `?n=` de la petición acompaña a todo cuerpo que lleve enlace** (`kmsProxy_`, un solo sitio,
   escrito por `doPost` en `_N_DE_LA_PETICION_`): sin él el KMS no puede saber **de quién** es el
   enlace que renueva, y volvería a haber uno solo para los dos. ⛔ Es un DISCRIMINADOR, nunca un
   permiso: el expediente lo siguen derivando el enlace y la puerta (KAL-4), y lo que el llamante
   declara **manda**;
2. **la ventana de diez minutos** pasa a ser del tutor (§"②24", arriba).

⛔ **El modelo entero vive en `kis-app/docs/kms/decisions/enr.md` DL-E68**, no aquí.
**Red:** `node scripts/servidor/cada-tutor-con-su-enlace.mjs`.

### La puerta del enlace: una copia de 30 min, y los tres rechazos en UN solo juez

> Diego, 2026-08-26: *«No pasa nada por que un enlace tarde 30 minutos en dejar de valer, es
> razonable.»*

`requireResumeToken_` consulta **primero** la copia (`rtmemo_`, `COPIA_PUERTA_TTL_S_` = 1800 s) y solo
va al KMS si no la hay — también en las ESCRITURAS. **Lo que no se afloja:**

- **KAL-4 intacta**: el expediente sale de la ficha que resolvió el token.
- **Los TRES rechazos** —no reconocido · abandonado · caducado a los 7 días salvo enviada— los aplica
  el juez **ÚNICO** `_rechazosDelEnlace_`. Dos copias del criterio divergirían.
- **La copia solo CONSERVA un «sí»; jamás lo CREA.** Se escribe únicamente en el camino vivo, tras
  una validación que resolvió.
- ⛔ **Con `comprobarSubida` NO se toma el atajo**: esa respuesta es una comprobación de ACCESO que la
  copia no tiene.
- **Rotar, abandonar, «esto no es mío», el auto-abandono, enviar y la limpieza de huérfanas llaman a
  `_olvidarCabeceraMemo_`**, que borra también la copia. Sin eso, `assertGroupEditable_` dejaría
  escribir media hora sobre una solicitud ya enviada.
- **Rotar MUEVE la copia al token nuevo** (`_moverLaCopiaDeLaPuerta_`, antes de olvidar la vieja):
  **hereda el `exp` absoluto** (encadenar rotaciones no compra un segundo) y **refresca `created_at`**
  (el KMS lo reescribe al rotar; conservar el viejo rechazaría por caducado un enlace recién emitido).
- **El pedido va COMBINADO** (DL-E57): con `n`/`recovered_email` presente, la puerta los lleva en el
  MISMO cuerpo y archiva la identidad en `_TUTOR_MEMO_`. Sin discriminador, byte-idéntico. Los dos
  fallos **no se contagian**: un fallo de identidad va en su campo y nunca tumba la puerta.

⚠️ **Lo que la decisión acepta:** un enlace rotado o revocado **por el lado del colegio** puede seguir
valiendo hasta 30 minutos.

### El PULSO y los viajes

- **Abrir el asistente cuesta CUATRO viajes** (`hydrateSession · sendVerificationCode · warmSession ·
  warmBundle`), no ocho. La condición vive en UN solo sitio, `laVerjaVaASalir` (`WizardPage.jsx`).
- ⛔ **Los catálogos se APLAZAN, no se retiran**: `fetchLookups`/`fetchQuestions` se disparan cuando
  el asistente pinta sus pasos de verdad —verja abierta **Y** hidratación resuelta— y ahí encuentran
  su caché sembrada.
- **El pulso no se dispara mientras hay una subida en vuelo** (`uploadsInFlightRef` +
  `hasUploadInFlight()`, con `try/finally` alrededor de cada subida). Es señal de CLIENTE: la subida,
  cuando sí se dispara, sigue validando en vivo igual.
- **La identidad se resuelve PEREZOSAMENTE en el pulso**, solo si la marca guardada lleva buzón.
  ⛔ **La clave de su caché sigue llevando el buzón dentro** — es una frontera de privacidad entre
  tutores: en un expediente ya enviado el token no rota, así que dos tutores lo comparten.
- **El coste está en el SALTO, no en el trabajo**: ~15 s por viaje al KMS, con manejadores de 0,5-2 s
  ⇒ lo que se mejora es **el NÚMERO de viajes**, nunca la consulta.

### Lo que el asistente DICE, y lo que no puede afirmar

- ⛔ **No puede decir «guardado»: el KMS ENCOLA.** `enr.saveResponses` contesta `{ok:true,
  queued:true}` y escribe el trabajador después. Por eso se **PREGUNTA antes**
  (`enr.wizardEstadoDeLasPartes`, lectura síncrona que ya existía) y, si ese tutor ya envió su parte,
  se rechaza con `PARTE_YA_ENVIADA` sin encolar nada. **Degrada hacia GUARDAR**: un dato que no se
  puede consultar no puede convertir esto en un asistente que se niega a guardar.
- ⛔ **UN SOLO SITIO decide si un rechazo se reintenta**: `frontend/src/lib/rechazos.js`
  (`RECHAZOS_DEFINITIVOS`). Lo leen los **dos** consumidores —el aviso, para explicarlo y esconder
  «Reintentar»; la cola, para **no recordar** la escritura fallida—. **Falla hacia el lado seguro**:
  lo no declarado se sigue reintentando, así que un corte de red nunca se convierte en trabajo
  perdido. Un código nuevo se declara con **una línea ahí**, y **jamás se escribe una segunda lista**.
  ⚠️ Y no basta con dejar de reintentar: mientras un rechazo definitivo esté en pie, la cola **repone
  el aviso** en vez de caer a «todos los cambios guardados», y **en el mismo episodio** (un cartel ya
  cerrado no se vuelve a abrir).
- **Los DESCARTES del KMS se dicen** (`codigoDelDescarte`): `rechazadas_por_quien_puede_contestar`,
  `rechazadas_por_formato_no_declarado`, `neae_vaciado_no_declarado`, `skipped_no_context`,
  `skipped_no_initiator`, más las fichas de otro tutor. Los cinco son **definitivos** —dependen de
  quién contesta o de la configuración del centro—; los dos de lote entero **no le piden nada a la
  familia**: dicen que escriba a admisiones.
- **Un guardado que MUERE en la cola deja de ser mudo**: se pregunta en el pulso que ya va y viene
  (`guardados_sin_aterrizar`). La regla es **«lo ÚLTIMO que se sabe de ese paso»**, no «alguna vez
  falló» —sin eso el aviso sería permanente, porque la fila fallida se queda en la cola para siempre—.
  ⛔ **Solo viajan CÓDIGOS DE PASO, jamás `error_msg`** (nombra columna y valor rechazados: es
  diagnóstico, no algo que cruce al navegador de una familia). **«No se pudo mirar» NO es «todo
  guardado»** y son campos distintos. **No ofrece «Reintentar» y no se puede cerrar.**
- ⛔ **Un fallo de TRANSPORTE no se disfraza de enlace caducado.** Los tres rechazos del servidor
  llevan código (`_errorDeEnlace_`: `ENLACE_NO_VALIDO` · `ENLACE_ABANDONADO` · `ENLACE_CADUCADO`) y
  salen por la rama estructurada (HTTP 200 + `{ok:false, error:{code,message}}`), nunca por un 500
  que el cliente no parsea. **UN SOLO SITIO clasifica**: `frontend/src/lib/fallosDeEntrada.js`, con
  **tres** clases —el enlace no vale · no se pudo cargar · error nombrado—. ⛔ **No se adivina por el
  TEXTO**: un mensaje se traduce y se reescribe; un código no. La clase de transporte **se queda en
  la página con el enlace vivo** y reintenta sola (1,5 s · 4 s, diciéndolo); solo «el enlace no vale»
  va a la portada, que es donde está la única salida que le queda.
  ⛔ **Y esa clase YA NO habla con una sola voz:** `ResumePage` se lleva a la portada el **CÓDIGO de
  máquina** (`?resume_code=`, y **nada más** — ni el mensaje, ni el token, ni el correo), y la portada
  lo casa contra una **LISTA BLANCA que vive en UN SOLO SITIO**,
  `frontend/src/lib/cartelDelEnlace.js`: las tres causas dicen **qué pasó y cuál es su salida**
  —«se emitió uno más nuevo, busca el último correo» · «la cerraste, empieza otra» · «caducó de
  verdad, pide uno nuevo»— y **lo que no esté en el mapa cae al texto de hoy, byte a byte**. Dar de
  alta una causa es **una línea** de ese mapa más su par de textos. ⚠️ `BAD_REQUEST` está en el
  conjunto pero **este camino no lo emite** (un token con forma mala lanza SIN código) ⇒ **no tiene
  texto a propósito**.
- ⛔ **Los catálogos no se inventan.** Son **TRES** situaciones: *cargando* · *el colegio contestó* (y
  su lista puede estar legítimamente vacía) · *no se pudo cargar*, **que se dice y se puede
  reintentar**. Lo que acredita que contestó es que venga una **lista** (`Array.isArray`), no que
  venga *algo* — la respuesta con el candado puesto trae `{}`, que en JavaScript es verdadero.
  ⛔ **Un catálogo vacío no se siembra**: envenena la caché de ese idioma para toda la pestaña.
- ⛔ **El asistente NO calcula dinero** (DL-080-A): `money()` divide entre 100 y formatea. El total
  sale del servidor (`net_cents`) y **no se recalcula en pantalla**.

### El iPhone no se lleva la sesión por delante

Irse a otra app aborta las peticiones en vuelo. `gasCall` detecta el contexto de fondo
(`isBackgroundContext_`: oculta ahora, o lo estuvo, o dentro de una gracia de 4 s tras volver —
`visibilitychange` **y** `focus`, porque algunos webviews entregan uno sin el otro) y, si el fallo es
de TRANSPORTE, **reintenta al volver a primer plano**.

⛔ **SOLO lecturas idempotentes, lista EXPLÍCITA** (`LECTURAS_REINTENTABLES_AL_VOLVER`:
`hydrateSession`, `getAdmissionState`, `simularCuotas`, `getLiveStateVersion`), **UNA vez**, y **NUNCA
una escritura**: una escritura re-disparada por un cambio de visibilidad puede duplicar lo que el
servidor ya recibió. Lo que no está en la lista no se reintenta — nunca al revés. ⛔ **Estos oyentes
no llaman jamás a `touchActivity`**: no comparten una línea con la ventana de inactividad.

**Y lo tecleado sin guardar no muere con la página.** ⛔ **La salida NO es guardar en el navegador, es
ENVIAR**: lo pendiente **son datos personales**, así que `sessionStorage`/`localStorage` están
prohibidos (KAL-7). ⛔ **`navigator.sendBeacon` DESCARTADO** y no se repropone: no espera respuesta, y
el guardado necesita LEERLA — un dato «enviado» que el servidor descartó en silencio es el mismo
defecto con otra cara. Tres piezas: el paso **publica** cómo preguntarle lo tecleado
(`registrarBorradorDelPaso`, en un `ref`) · **UN SOLO oyente** `visibilitychange`→`hidden` +
`pagehide` en `WizardPage` · el guardado sale por **el camino de siempre**
(`encolarGuardadoDelPaso`), **entrando por la cola, no saltándola** (el orden FIFO importa: el vínculo
necesita el identificador que estampa el paso de personas).

### Lo que se PINTA — invariantes de pantalla

- **El cuestionario agrupa POR HIJO**: primero lo que no es de un hijo (solicitud y tutor), y después
  **una sección por hijo** con sus conjuntos dentro. ⛔ **Con UN solo hijo la pantalla no cambia** —
  sin nada que separar, una sección de primer nivel es ruido. ⛔ **La clave de la respuesta no se
  toca** (`question_id__personKey`): es la que guarda y recupera lo contestado. ⛔ **De quién es una
  pregunta lo declara el catálogo** (`audience_category_id`): aquí solo se AGRUPA lo que llega.
  ⛔ **No se ordena nada**: el `display_order` ya viaja resuelto. Las condiciones se evalúan **por
  sujeto**, y un hijo sin preguntas no se pinta.
- ⛔ **El `name` de un grupo de redondeles agrupa en TODO el documento**, así que lleva el sujeto
  dentro (`q_${question_id}__${respondentKey}`). Sin eso, contestar por un hermano **desmarca** lo
  contestado por el otro, y React no lo repone.
- ⛔ **UN SOLO SITIO decide cómo se ve un separador de sujeto**: `frontend/src/shared/CabeceraDeSujeto.jsx`
  + `.sujeto-bloque`/`.sujeto-pastilla`, usado por el cuestionario y por el simulador del paso 7.
  **Prohibido copiar el aspecto a mano en una tercera pantalla.** Se cuentan **sujetos distintos en
  todo el paso**, no bloques: con un solo hijo y dos conjuntos hay dos bloques y nada que separar.
- **El gemelo del KMS** (`kis-app frontend/src/shared/qb-renderer/`) **no se toca**: su único
  consumidor es la vista previa de una pregunta, con **un** alumno sintético y **un** conjunto.
- **El paso 7**: un **desplegable** por plan (con dos o más formas de pago; con una se dice cuál es y
  no se pregunta) y **siempre el calendario completo** debajo, una fila por vencimiento. Un plan puede
  no admitir **ninguna** forma de pago (permanencia, ampliación de horario): llega con
  `modality_id: null` y se anuncia solo con su importe. Cambiar de forma **repinta sin ir al
  servidor**. ⛔ **Elegir aquí NO viaja a ningún sitio**: la marca vive en el navegador
  (`formaDePagoMarcada`); la elección EN FIRME es la del paso 8. Un solo formateador de fechas
  (`utils/fechas.js`) y un solo sitio decide qué calendario se ve (`modalidadMarcadaOPrimera`).
  **El simulador nunca puede impedir enviar**: vive fuera de `handleSubmit` y degrada en silencio.
- **Con la solicitud ya enviada el paso 7 SIGUE enseñando la simulación** (`③70`), en **solo lectura**
  —las formas de pago en texto, sin desplegable—. El motivo es la honestidad: la elección que cuenta
  es la del paso 8. El servidor siempre lo permitió (`simularCuotas_` no lleva `assertGroupEditable_`).
- **La simulación no se recalcula al navegar**: se memoriza en un `useRef` de `WizardContext` que
  **muere con la pestaña** (jamás `sessionStorage`) y se olvida en tres momentos —al **encolar**
  cualquier guardado (no al aterrizar), al subir la versión del grupo, y al rehidratar—.
  ⛔ **Solo se memoriza lo que trae `huella`**, el mismo criterio con el que el servidor decide si su
  caché sirve. La huella (`enr.huellaDeSimulacion`) se deriva del **catálogo de condiciones del propio
  colegio**, nunca de una lista de campos escrita a mano. ⚠️ **Límite honesto:** cubre las condiciones
  de **elegibilidad**, no el árbol del motor de descuentos.
- **El paso 6** enseña, una vez subido y en TEXTO, «Tipo: X» y «De quién: Y». Sin tipo resuelto no se
  pinta esa línea, y `owner_person_ids` vacío se lee **«De la solicitud»** —la respuesta EXPLÍCITA de
  DL-R17—, nunca «no consta». Inmediatamente tras subir, la línea de «de quién» solo sale si la
  familia CONTESTÓ: sin respuesta el reparto lo decide el servidor y el navegador no sabe cuál.

### Lo que se RECOGE — invariantes de datos

- **El paso 6 deja ELEGIR qué es el documento.** Se pregunta **a partir del SEGUNDO tipo**: con 0 el
  servidor rechaza nombrando qué configurar; con 1 lo asigna él (*«un desplegable de una opción no es
  elección»*, DL-R16); con 2 o más elige la familia y su respuesta es **obligatoria**. ⛔ **Ni un
  código escrito a mano**: el asistente valida la FORMA (KAL-5 capa 1) y **quién es admisible lo dice
  el KMS** contra la lista viva. **Sin respaldo** — un respaldo escrito a mano fue exactamente el
  defecto que causó `'OTHER'`.
- **La foto se comprime EN EL NAVEGADOR** (`frontend/src/lib/comprimirImagen.js`, **el único sitio**),
  con cuatro barandillas: ⛔ solo con `is_immutable === false` **explícito** (tres estados —sí · no ·
  **no consta**— y la ausencia se trata como inmutable) · techo de **2400 px y calidad 0,85** (la
  barandilla del OCR de DL-R19/DL-R18 en números) · **solo JPEG y WebP, re-codificados en sí mismos**
  (PNG no: cambiarlo a JPEG haría mentir a la extensión y emborronaría una captura) · **nunca peor que
  el original** (sin ahorro ≥20 %, sin poder descodificar, o ante cualquier fallo, se sube tal cual).
  El tope de 10 MB mira el archivo **que eligió la familia**.
- **Los IDIOMAS QUE HABLA cada persona** (`①45`) son de la PERSONA, admiten VARIOS, son opcionales y
  **no** están acotados a los idiomas en los que el sistema rinde. ⛔ **Lo ya declarado no se puede
  desmarcar**: `enrPersonLanguages` es append-only y no está entre las clases que la familia puede
  quitar, así que dejar desmarcar sería quitarlo de la pantalla y que volviera al recargar. No se
  recoge `is_mother_tongue`: siendo append-only, un error no se podría corregir nunca.
- **Las opciones de «sexo» salen del CATÁLOGO** (`genderValues`, en las listas que ya se piden), con
  **UN solo lector** en el KMS. La etiqueta se resuelve por el `label_key` que declara el catálogo;
  sin texto para esa clave se pinta la `designation`. ⛔ **El respaldo se retiró**, así que un catálogo
  que no llega deja el desplegable **deshabilitado y con aviso** (`field.gender_unavailable`): el sexo
  es opcional, y sin aviso la familia avanzaría y el dato se perdería en silencio.
- **Los PAÍSES son DOS preguntas sobre la MISMA lista**: *¿de qué país eres / dónde vives / dónde
  estudiaste?* → la lista entera; *¿de qué país es este teléfono?* → **solo los que declaran prefijo**.
  ⛔ Eso **no es un recorte por comodidad: es la definición** —un país sin prefijo no es una respuesta
  válida— y **DL-E40 no se afloja**. El KMS sirve **una sola lista** con `dial` por fila; el CONSUMIDOR
  decide (`paisesConPrefijo_` / `prefijosDe_`, los dos únicos sitios). ⛔ **El `dial` se normaliza a
  solo dígitos** al cruzar la frontera: un `+` compondría `++34` y rompería la puerta para todos.
  ⚠️ `constants/countries.js` sigue viva **como RESPALDO**: sin país no se compone el número, y un
  conjunto cerrado vacío **desactiva DL-E40 en silencio**.
- **Un vínculo es UNA fila** (DL-S45): ⛔ **no se reintroduce el empujón de la fila inversa** — que se
  vea desde los dos lados lo resuelve el LECTOR, que ya casa el par en los dos sentidos. El plegado de
  la hidratación **se queda**: hay pares reales guardados en dos filas, y sin plegarlos el dirty-check
  daría positivo permanente. ⛔ **El orden es parte del dato** (`a`=`from`, `b`=`to`, derivado de la
  propia fila): invertir los extremos **crea una fila nueva** en vez de actualizar.
- ⛔ **Editar un vínculo ya guardado exige reponer `person_id_a`/`person_id_b`**, y se hace en **UN
  solo sitio**: el normalizador de la hidratación (`hydrateFromResume`), de donde lo heredan el
  baseline, `stepData` y el envío a la vez. Reponerlos al enviar daría dos campos más que la
  referencia ⇒ guardado espurio por sesión. *(El KMS descarta en SILENCIO la fila sin los dos
  identificadores — no hay aviso rojo que mirar.)*
- ⛔ **La forma de un documento sale de un solo sitio**, `frontend/src/pages/steps/documentShape.js`
  (hermano de `personShape.js`), usada por el baseline y por la pantalla. Dos definiciones divergen y
  el paso queda «sucio» para siempre, encolando guardados que nadie pidió — y un guardado espurio
  **bumpa la versión del grupo** y puede saltar un `STEPUP_REQUIRED`.
- **El reparto de pagadores no se siembra de una sección VACÍA.** La hidratación se arma best-effort
  por sección, así que una lectura caída la deja vacía sin protestar — y sembrar de ahí enseñaría
  100/0 con 60/40 guardado, **firmando un reparto distinto del pactado**. Un solo criterio
  (`traeAlgunReparto_`) para los tres sitios: la lectura, la siembra y la revalidación.
- ⛔ **La declaración de tutor único vive en el LIBRO DE CONSENTIMIENTOS** (`sysConsentsLog`, código
  `SOLE_GUARDIAN_ATTESTATION`), con su texto exacto, y se escribe **al ENVIAR** — el libro se ancla al
  expediente, y en el paso 2 todavía no existe ninguno.

### La firma: la desbloquea un HITO, no un código de estado

> Diego, 2026-08-27: *«nada de eso debe ir por código, sino por configuración de hitos. Debe poderse
> generar por configuración.»*

```
firma_desbloqueada  ⟺  el hito «admisión resuelta» de ESTA solicitud está COMPLETO
                    Y  hay al menos UNA sesión de firma para este tutor
```

El segundo requisito **no es una segunda regla: es un HECHO** —las sesiones se crean solo para los
admitidos—. ⛔ **`AD`, `TD` y `WL` ya no aparecen como criterio** en `backend/Code.js` ni en
`frontend/src/`. Mirar `state_code` (el Estado del hijo **menos avanzado**) hacía que **rechazar a un
hermano DESBLOQUEARA la firma y ponerlo en lista de espera la BLOQUEARA**.

**El asistente habla POR HIJO**: `por_alumno` + `firma_desbloqueada` viajan en las **CINCO**
proyecciones (la del hydrate, las tres del pulso —acierto de caché, escritura y retorno en vivo— y el
camino ligero de `WizardContext`). Una lista blanca de campos que tire uno de los dos devuelve el
rótulo grande a decir una sola situación. ⛔ **El `signing_status` por hijo que manda el KMS se
descarta a propósito**: el pulso no sabe producirlo hoy ⇒ **que lo produzcan los dos, o ninguno**.
`state_code`/`state_label` siguen sirviendo para el rótulo y para `editable`; lo que dejan de hacer es
abrir la firma.

⛔ **`signing_url` se recorta AQUÍ, en el consumidor**, aunque el KMS lo devuelva —esa ruta la usa
también el panel del KMS—: CLI 81 / S5 / KAL-NEW-1 cerró que la resolución previa a la firma no revele
la URL del proveedor con solo el bearer.

⚠️ **Lo que NO está hecho (§4 y §5 de `0º.tricies.novemtricies`)**: que la firma se abra para **todos**
los admitidos en el mismo recorrido (los enlaces por sesión, el firmante por hijo, y la trampa del
veredicto `COMPLETED` de grupo, que **cierra el paso a la segunda matrícula**), y que los pasos 9 y 10
pasen a ser por hijo.

### Estados editables — y el edit-lock post-envío

Editable ⟺ `submitted_at IS NULL` **y** `abandoned_at IS NULL`. La reapertura (el colegio devuelve el
expediente) la resuelve **`hydrateSession_`**, que sobrescribe `submitted_at = null` cuando la fase es
editable (busca `REOPEN-FIX`) — **en un solo sitio**. `assertGroupEditable_` es la defensa en
profundidad de sus **CINCO** llamantes (`saveStep_`, `submitEnrollmentSession_`, `saveResponses_`,
`uploadDocument_`, `saveNeae_`), siempre **inmediatamente después** de `requireResumeToken_`, con
`err.code='NOT_EDITABLE'` mapeado a HTTP 200 + `{ok:false}` — rechazo estructurado al estilo **P72**,
**nunca HTTP 403**.

`EDITABLE_STATES` del frontal está escrito a mano como documentación de la intención. **TODO
operativo:** cuando `sysStateTransitions_T` exponga `is_editable_by_family`, derivar la lista y dejar
de mapear por el booleano de `submitted_at`.

### La copia local del navegador se descarta POR DATO, no entera

> Diego, 2026-09-05: *«La caché debe descartarse PARCIALMENTE para cada dato que se modifique bien
> desde el KMS … o bien desde el wizard.»*

Cada clase lleva su contador (`livever_<gid>__<clase>`; `hyd`, `adm`, `mem`, `doc`, `sim`) y el
**motivo** —que ya viajaba en el aviso del KMS— decide qué se tira, por el mapa **ÚNICO**
`WZ_CLASES_POR_MOTIVO_`, que usan las dos puertas (el aviso del KMS y las escrituras propias).

⛔ **El contador GLOBAL se conserva y sube SIEMPRE**: es lo que lee el pulso del navegador, y partirlo
en cinco lo dejaría ciego. El global dice «algo cambió»; los de clase, **QUÉ**. ⛔ **Falla descartando
de más**, con DOS cinturones independientes (motivo desconocido → las cinco; lista vacía → las cinco).
⛔ **`sim` se tira casi siempre y no es pereza**: qué mira un filtro de aplicabilidad lo DECLARA el
centro, así que solo sobrevive a lo que un filtro **no puede** consultar — los papeles.

### El cuestionario va POR PROGRAMA (D181)

> Diego: *«No es lo mismo la renovación que la nueva inscripción.»*

`fetchQuestions_` acepta un **tercer** campo opcional, `program_id`, y lo reenvía al KMS. ⛔ **La clave
de la copia lleva CINCO cosas** —colegio · contexto · consumidor · idioma **y programa**— en los dos
lados (`_claveCatalogoPreguntas_`, prefijo `wzqb_v2_`; `_claveDelCatalogo`, prefijo
`kis_wizard_qcache_persist_v2_`); las entradas `_v1_` se **abandonan**. ⛔ **El asistente solo
TRANSPORTA el identificador**: traducirlo a sus dimensiones lo hace el KMS. ⛔ **Sin programa no se
inventa nada** (la familia que aún no ha elegido en el paso 1): el KMS resuelve sin esa dimensión, que
es lo correcto — una regla cuya dimensión no viene **deja pasar**. ⛔ **Qué programa es esta solicitud
se decide en UN solo sitio**, `programaDeLaSolicitud` (`WizardContext`), con orden
`stepData.email` → `stepData.application`: al revés, cambiar de programa dejaba la clave clavada en el
hidratado. ⚠️ **Límite honesto: no hay invalidación** — lo único que lo refresca son DOS plazos: el de la copia
(`CATALOGO_PREGUNTAS_TTL_S_`, 30 min) y, por encima, el **techo** del refresco de fondo
(`CATALOGO_PREGUNTAS_TECHO_S_`, 2 h — abajo). Y encima de los dos, **la ventana del navegador**, que
guarda su propio catálogo hasta **30 días** (`QCACHE_LS_MAXAGE_MS`, `frontend/src/api.js`) y dentro de
los primeros 30 min lo sirve **sin red**: quien mire una pantalla rara mire también ahí, porque un
catálogo viejo del NAVEGADOR no lo cura nada de lo del servidor.

**★ El repaso del espejo lo mantiene caliente**, una vez por **(PROGRAMA × idioma)** y no por
familia: se deduplican las combinaciones de la vuelta y, **si la copia ya está Y le queda TECHO**, se
RE-ESCRIBE para refrescar su plazo **sin viajar al KMS y sin gastar el cupo público** (②⑤④, que es
compartido por todo el colegio); cuando falta —o cuando **se acabó el techo**— se pide por el camino
vivo. ⛔ **Sin programa declarado no se prepara nada** — sería escribir una clave que el clic no lee —
y **un catálogo IMPOSIBLE no se guarda**, por el criterio que ya existe
(`_catalogoDePreguntasDeLaCopia_` / `_guardarCatalogoDePreguntas_`, copiado a su vez de
`qb_core_catalogoImposible_` del KMS).

⛔ **EL TECHO (`CATALOGO_PREGUNTAS_TECHO_S_`, 2 h) NO ES UN ADORNO: sin él, lo que se guardó una vez
se quedaba PARA SIEMPRE.** El refresco sin viaje se construyó el 2026-09-22 para ahorrar el salto al
KMS y **se llevó por delante la única cura automática que había** —que el catálogo caducara solo a los
30 min y la siguiente lectura lo trajera bien—. Hoy un viaje de verdad deja una marca con su propio
plazo; mientras viva, el repaso refresca sin viaje; cuando caduca, **vuelve a preguntar** saltándose la
copia a propósito (`fetchQuestions_(…, {sinCopia:true})`, segundo argumento **que el despachador
público no puede poner**: llama con uno solo). ⛔ **La copia NO se borra antes de pedir**: si el viaje
falla, lo guardado sigue en pie. Medido con el control de abajo: en 10 h, **19 refrescos sin viaje y 5
lecturas de verdad**, contra **23 y 1** antes del techo.

⚠️ **ESTO ERA UN PARCHE, Y SU CAUSA YA ESTÁ CERRADA (2026-09-23).** El catálogo es configuración del
centro y **no tenía ninguna de las tres reglas** que las SOLICITUDES sí tienen; por eso existía este
temporizador hecho a mano. Hoy **el KMS avisa**: sus once rutas de escritura del catálogo están
DECLARADAS en un solo sitio (`QB_RUTAS_QUE_TOCAN_EL_CATALOGO_`, `kis-app kms-server/enr/wizard-warm.gs`)
y el aviso viaja por el **MISMO canal firmado y el MISMO receptor** (`notifyLiveStateChange`, con
`alcance:'CATALOGO'` y sin expediente — el catálogo no cuelga de ninguno). **Cero receptores nuevos.**

⛔ **Lo que llega es la VERSIÓN, no el contenido, y la elección lleva su número delante** (medido
contra el despliegue vivo el 2026-09-23): aquí se guarda un catálogo por **(programa × idioma ×
contexto)** — hoy **SEIS** (2 programas × 2 idiomas, más la clave «sin programa») de
**35.687-43.578 bytes** ⇒ **≈240 KB**, al borde del techo de 250.000 por copia del KMS; y **dos de las
seis no son derivables desde el KMS** (la clave «sin programa» no sale de `enrPrograms`). El aviso
pelado son **~200 bytes**, y **este lado sí sabe qué combinaciones tiene calientes**
(`_combinacionesDelCatalogo_`, el índice que escribe el escritor ÚNICO del catálogo). ⇒ **rehace él**,
con `_catalogoCambioEnElColegio_` → el rehacedor que YA existía (`_espejoCalentarElCuestionario_` con
`{forzar:true}`), 20 s de presupuesto y **más reciente primero**; lo que no cabe **pierde su techo** y
lo coge el repaso de 30 min.

⛔⛔ **Y NADIE SE QUEDA SIN CUESTIONARIO: aquí no se borra ni una copia.** Se pide la nueva y solo si
llega sustituye a la vieja. **Una pantalla en blanco es peor que un catálogo viejo**, y esa barandilla
manda sobre la velocidad.

**El NAVEGADOR se entera sin pedir el catálogo**: `getLiveStateVersion` —la etapa BARATA del pulso, la
que late cada 30 s pase lo que pase— devuelve `catalogo_v`. ⛔ **No va en `getAdmissionState`**: ése
solo se pide cuando sube la versión de la SOLICITUD, y un cambio de catálogo no la mueve, así que ahí
no llegaría nunca. Con una versión distinta el navegador **marca su copia para revalidar y suelta la
de módulo; jamás borra nada** (`elCatalogoCambioEnElColegio`, `frontend/src/api.js`), y el paso 5 la
lleva en las dependencias de su carga para enterarse **aunque ya esté montado**. Cierra el
`TODO(Diego)` que ese fichero llevaba escrito.

⚠️ **El techo de 2 h y `_catalogoDePreguntasImposible_` SIGUEN EN PIE**: se retiran cuando esto esté
medido funcionando en producción, no antes.

### El asistente no cuenta a quien un tutor ya quitó

**UN SOLO SITIO decide quién sigue en la solicitud**: `wizardFilaViva_` / `wizardSoloVivas_`, con el
criterio copiado del lector probado del KMS — `!deleted_at && is_active !== false`. La única
diferencia es que AppSheet devuelve el booleano como **TEXTO** (`'FALSE'`), así que comparar con
`false` a secas no casa nunca. ⛔ **No se reparte `!p.deleted_at` a mano por los sitios de lectura: así
nació la asimetría** que exigía teléfono a tutores ya retirados y tumbaba el envío entero.

## GAS conventions

**`manual_*` NUNCA con guion bajo final.** GAS trata como privada toda función que acabe en `_`: no
aparece en el selector del editor y no se puede ejecutar a mano, que es justo el propósito de la
convención. Los ayudantes privados de verdad **sí** lo llevan (`assertValidEmail_`,
`requireResumeToken_`…). Comprobar con `grep -nE "^function manual_[a-zA-Z]+_\b"`.

⛔ **LAS SONDAS `manual_*` NO VIAJAN AL PROYECTO (2026-09-22).** Las 51 viven en
`backend/_manual.gs`, que está en `backend/.claspignore` ⇒ **`clasp push` NO las sube y el despliegue
no las lleva**. Apps Script ANALIZA EL PROYECTO ENTERO en cada ejecución, y eran **2.497 líneas, el
17,1 % de `Code.js`**, que **ninguna familia invoca jamás** (medido: 74 apariciones de sus nombres
fuera de su definición y **las 74 son TEXTO**; CERO llamadas). ⚠️ **Lo que eso vale, sin adornar:
entre 0,3 y 0,7 s por llamada** — real y gratis, **y NO es lo que hace esperar a una familia**: eso
son los VIAJES al KMS.

**Para ejecutar una sonda, el ciclo de TRES órdenes** (el detalle, en la cabecera de `_manual.gs`):
comentar la línea de `.claspignore` y `clasp push --force` · `clasp run manual_<la que toque>` ·
restaurarla y **volver a subir**. ⛔ **La tercera NO es opcional y termina LEYENDO EL HEAD**: ahora
que el fichero vive APARTE, `clasp push` **no borra del Head** lo que ya está arriba.

⛔ **Y ANTES DE ESCRIBIR UNA `manual_*` NUEVA, pregúntate quién la va a llamar.** Sonda de
diagnóstico → `_manual.gs`. **Tubería** que algo invoca por su NOMBRE (un disparador, un guion de
publicación) → **tiene que viajar**, y va en un fichero de módulo aunque lleve el prefijo. Los dos
nombres de disparador de este proyecto —`espejoRefrescarCopias` (①97) y el absorbente
`wizardWarmTrigger`— **no son `manual_*` y se quedan en `Code.js`**: un disparador guarda el NOMBRE y,
si desaparece del proyecto, **falla en silencio**.

**Push vs deploy** (para lo que SÍ viaja): `clasp push --force` sube el Head; `clasp deploy` sobre el
`deploymentId` de siempre es lo único que llega a las familias, y su cuota diaria es limitada.

**`clasp run` contra este proyecto FUNCIONA** desde el 2026-09-14 (Diego le asignó su proyecto de
Google Cloud). Se lanza con `NODE_USE_ENV_PROXY=1` desde `backend/`.
⚠️ **Lo que NO se puede leer desde fuera es el REGISTRO DE EJECUCIONES**: `clasp logs` exige un
`projectId` en `.clasp.json`, y no lo hay. ⇒ **lo que quieras leer, DEVUÉLVELO** — no lo escribas solo
con `Logger.log`.

**El interruptor de la traza (D171).** `TRAZAR_ARRANQUE` está **apagada por defecto** y, apagada, el
comportamiento es **byte-idéntico**. Tres funciones **sin argumentos** (el botón «Ejecutar» del editor
no pasa parámetros, y una sola `manual_trazarArranque(valor)` recibiría `undefined` y apagaría la traza
justo al querer encenderla): `manual_trazarArranqueON` · `manual_trazarArranqueOFF` ·
`manual_trazaDelArranque`. ⛔ **Las tres viven en `_manual.gs` y NO están en el proyecto**: medir un
arranque empieza por subirlas con el ciclo de tres órdenes de arriba, y **termina bajándolas**. Las tres **releen la propiedad después de tocarla** — el «ok» de la
escritura no acredita nada. ⛔ **Lo capturado es la MISMA cadena que ya se registraba**: la garantía de
que no hay datos de familia es estructural, no una promesa. Se vuelca **una vez al final** del
`doPost`, para no falsear lo que mide.

## Regla — los refactors preservan el código probado

**Cuando se MUEVE o REESCRIBE algo que ya funciona, el código existente ES la especificación**: se
copia verbatim (mismas tablas, mismos filtros, mismo mapeo), **no se rediseña el acceso a datos sobre
la marcha**. Los docs codifican *decisiones*, no la *verdad de implementación* — qué columna exacta,
qué valor de filtro—, y esa verdad vive en el código probado.

Obligatorio en todo encargo de refactor que mueva carga de datos:

1. **Citar la fuente probada con `archivo:línea`.**
2. **Ordenar copia-verbatim y PROHIBIR explícitamente inventar lógica de datos nueva.**
3. **Puerta de pre-escritura**: pegar las líneas del lector actual ANTES de escribir el reemplazo. Si
   no se encuentra, **PARAR y reportar** — no improvisar.
4. **Prueba de caracterización** (`manual_*` que reporte conteos objetivos viejo-vs-nuevo).

⛔ **Anti-patrón estructural: nunca dejar DOS lectores del mismo dato.** La migración correcta mueve
las lecturas exactas y BORRA la copia vieja en el mismo cambio.

*(Precedente DL-C, 2026-06-09: un refactor sustituyó un lector probado por un endpoint nuevo que
filtraba por una columna **inexistente** en esa tabla → relaciones vacías y 68 s. La causa no fue «no
leer los docs»: fue reinventar el acceso a datos en vez de copiar el lector.)*

## Wizard structure — los 11 pasos canónicos

1 Email · 2 Personas · 3 Vínculos · 4 Salud · 5 Cuestionario · 6 Documentos · 7 Revisión ·
**8 S-BILLING** (datos fiscales + presupuesto real + modalidad de pago) · **9 S-GDPR** (los 7
consentimientos + TSA, DL-E27) · **10 S-REVIEW** (Carta + Contrato + confirmación de lectura,
DL-E28 §6) · **11 S-SIGN** (firma Click & Sign, DL-E28 §7-§13).

**Anti-patrones — NO repetir:**

- ⛔ **No inventar pasos** («Status», «Interview», «Decision», «Deposit», «Enrolled»). Si parece que
  falta uno, comprobarlo primero contra el roadmap canónico.
- ⛔ **No crear rutas nuevas** (`/track/:token` y similares). El seguimiento **no tiene ruta propia**.
- ⛔ **No añadir endpoints solo-frontal** sin confirmar que están registrados en el `doPost`.

El paso 8 pinta el presupuesto REAL y captura la modalidad por **proxies finos al KMS**
(`enr.wizardGetSubscriptionBudget` lectura · `enr.wizardApplyModality` escritura, que **sí** exige el
código de un solo uso: es dinero y se firma). Solo se admite en estado **borrador**; degrada elegante
si el centro no tiene catálogo de modalidades.

## Deployment

### Los NUEVE controles de CI — ninguno es opcional

`build` depende de los nueve ⇒ **en ROJO no se publica**. Todos `node scripts/<nombre>.mjs`, ~1 s, sin
`npm ci`, sin red y sin navegador.

| Control | Qué vigila |
|---|---|
| `comprobar-escrituras-directas` | que este backend anónimo no escriba a ninguna tabla de AppSheet |
| `comprobar-selector-appsheet` | que los filtros emitan `AND()`/`OR()` como FUNCIONES, no infijos |
| `comprobar-personas-quitadas` | que no se cuente a quien un tutor ya quitó de la solicitud |
| `comprobar-verja-publica` | las cinco puertas, el código de un solo uso de los 13 manejadores, y que cada tramo de `②17` siga preguntándole al KMS |
| `comprobar-receptor-firmado` | que los **DOS** receptores firmados verifiquen la firma ANTES de mirar el contenido |
| `comprobar-pantalla-del-cliente` | que las banderas de pantalla salgan de UN derivador y no se copien del KMS |
| `comprobar-codigos-de-consentimiento` | que ningún consentimiento se registre con un código inventado |
| `comprobar-que-el-wizard-no-escribe-estado` | que el asistente no fije el estado ni mande el correo del envío |
| `comprobar-el-servidor` | **el lanzador**: descubre y ejecuta TODOS los arneses de `scripts/servidor/`, los únicos que EJECUTAN el servidor en vez de leer sus líneas — y sale **ROJO si no encuentra ninguno** |

### `scripts/servidor/` — los arneses que EJECUTAN el servidor

**Los ocho primeros LEEN LÍNEAS; éstos EJECUTAN las funciones de `backend/Code.js`** con dobles en
memoria (sin red, sin navegador, sin `npm ci`), y terminan con la misma última línea
(`VEREDICTO: VERDE` / `ROJO — <motivo>`). Nacen de una autorización expresa de Diego (2026-09-23,
*«si arregla las cosas, adelante»*) para **dejar de tirar los arneses efímeros**: el servidor tiene
**208 funciones** y solo **3** las ejecutaba algún control, así que cada arreglo se comprobaba una vez
con un instrumento que se tiraba, y el cambio siguiente lo rompía sin que nadie se enterara.

| Control | Qué protege |
|---|---|
| `cada-tutor-con-su-enlace.mjs` | **D213**: que lo que hace un tutor no eche al otro — ni su enlace ni su ventana de diez minutos; que un enlace sin `?n=` siga entrando; y que al KMS se le diga de QUÉ tutor es el enlace que renueva |
| `el-catalogo-de-preguntas.mjs` | que un catálogo guardado **no se pueda quedar clavado para siempre**: el refresco sin viaje sigue ahorrando, el techo obliga a releer, un viaje fallido no se lleva la copia, y el camino público sigue sirviéndose de ella |
| `el-catalogo-se-entera-cuando-el-colegio-lo-cambia.mjs` | que una pregunta editada en el KMS llegue a la copia del asistente y que **nadie se quede sin cuestionario**: la copia vieja no se borra hasta que llega la nueva |
| `la-copia-se-actualiza-al-escribir.mjs` | la **regla 3** de Diego: que una escritura del tutor deje la copia caliente **rehecha con lo que el KMS confirma**, y que jamás se archive como buena una copia con un dato que el KMS no ha confirmado |
| `el-enlace-viejo-no-muere-hasta-que-salga-el-nuevo.mjs` | que **una familia nunca se quede sin enlace válido por un correo que no salió**: el envío que sale deja el enlace rotado, el que falla lo deja como estaba (las dos ramas, y los N de un correo multi), y el ack constante de la rama pública no cambia según si el correo salió |

**Se corren solos desde el 2026-09-23**: el lanzador `node scripts/comprobar-el-servidor.mjs`
descubre **todos** los `*.mjs` de esa carpeta, los ejecuta y junta sus veredictos; es el **noveno
control** y `build` depende de él. ⇒ **un arnés nuevo entra con dejarlo ahí**, sin tocar
`.github/workflows/`. **El molde —qué es un arnés aquí y qué tiene que imprimir— vive en UN solo
sitio: `scripts/servidor/LEEME.md`.**

⛔ **El lanzador sale ROJO si no encuentra ninguno**: un control que no mide nada no puede decir
VERDE. Y **se comprueba a sí mismo antes de juzgar a nadie** (ejecuta un arnés sintético de cada color
y exige distinguirlos): si su lectura del veredicto se afloja, **todos los rojos se volverían verdes
en silencio**.

⛔ **Y cada arnés lleva dentro sus roturas demostradas**: se rompe el fuente a propósito y se exige
que lo NOMBRE —un renombre tiene que salir **«MEDICIÓN CIEGA»**, nunca verde—. Un control que no se ha
visto fallar no es una red.

⛔ **Si añades un control de CI, actualizas la tabla de arriba en el MISMO cambio** (un arnés de
`scripts/servidor/` va en ÉSTA). El defecto que esta nota corrige es que seis entraron sin tocar
ninguna instrucción, y durante días se corrían 2 de 8 creyendo haber pasado el muro.

**Por qué el infijo era grave, y no se afloja:** `[a] = "x" AND [b] = "y"` **no da error** en AppSheet:
se queda con la **PRIMERA** condición y **descarta el resto en silencio** — medido, devolvía 23 filas
de 21 familias distintas para un expediente que tenía 3. Un filtro *inválido* saltaría a la vista; éste
no.

**Y los controles son DETECTORES POR LÍNEAS, no analizadores sintácticos** — declarado en la cabecera
de cada módulo. Un `eval()` o un alias seguirían siendo invisibles. **Un nombre que ya no existe en el
código sigue valiendo para impedir que vuelva**: borrarlo de un control es aflojarlo a cambio de nada.

### MURO DE DEPLOY — la batería VERDE antes de CUALQUIER publicación

```bash
cd frontend && npm run e2e:wizard
```

**Cambio sin batería verde = NO deploy.** Se lee **la ÚLTIMA línea de stdout**: `VEREDICTO: VERDE` o
`VEREDICTO: ROJO — <motivo>`. ⛔ **No basta «no vi ningún ✗» ni el código de salida** cuando la salida
pasa por una tubería (`| tail`, `| tee` devuelven el código del ÚLTIMO comando). ⛔ **Prohibido repetir
la batería hasta que salga verde**: un rojo se DIAGNOSTICA. ⛔ **Una corrida con `E2E_FILTER` NO vale
como muro** — la batería lo detecta y devuelve ROJO («ejecución PARCIAL»).

**Cuando añadas o cambies un camino, la batería se amplía en el MISMO cambio. Y antes de dar por buena
una afirmación nueva, RÓMPELA a propósito** y comprueba que sale ROJA nombrándola: una comprobación que
nunca se ha visto fallar no es una red.

⚠️ **LO QUE LA BATERÍA NO CUBRE, y es la mitad del producto:** corre contra un **backend simulado que
NUNCA ejecuta `backend/Code.js`** ni llama al KMS. Afirma lo que hace el NAVEGADOR. Todo lo del
servidor —las puertas, las proyecciones, las memorias, la ventana real— **se mide aparte**, con un
arnés que extrae las funciones del fuente y las ejecuta con dobles. Y ese arnés **se rompe a
propósito** antes de darlo por bueno: un renombrado debe salir **«MEDICIÓN CIEGA»**, no verde.

### ⛔⛔ Y ESE ARNÉS YA NO SE TIRA — se guarda en `scripts/servidor/` (Diego, 2026-09-23)

> *«si arregla las cosas, adelante»* — autorización expresa, sobre la propuesta de dejar de tirarlos.
> Está recogida como **segunda excepción** en `kis-app/CLAUDE.md` §"La red es UNA", junto a la
> prohibición que excepciona: **esto no abre una clase de calidad nueva, deja de DESTRUIR la que ya
> se escribe.**

**Lo que lo motiva, MEDIDO el 2026-09-23:** `backend/Code.js` tiene **208 funciones** y **solo 3** las
ejecuta algún control (`wizardFilaViva_`, `wizardSoloVivas_` y la verja) — **6 de los 8 leen líneas,
no ejecutan**. Y en el histórico de este fichero **«arnés efímero» aparece 54 veces**: 54 arreglos del
servidor comprobados **una vez**, con un instrumento **que se tiró**. ⇒ **205 de 208 funciones no
tienen nada que las vigile** después del día en que se arreglaron, y por eso el cambio siguiente las
rompe sin que nadie se entere hasta que Diego lo ve en pantalla.

⇒ **Quien arregle algo del servidor GUARDA su arnés** en `scripts/servidor/<lo-que-protege>.mjs`:
ejecutable solo (`node scripts/servidor/<el-suyo>.mjs`), **sin red, sin navegador, sin `npm ci`**, con
**última línea** `VEREDICTO: VERDE` o `VEREDICTO: ROJO — <motivo>` como los demás controles, y **con
sus roturas demostradas dentro**, incluida la guarda de **«MEDICIÓN CIEGA»**.

**Y se ejecutan SOLOS**: `node scripts/comprobar-el-servidor.mjs` los descubre todos y es el **noveno
control de CI**, del que `build` depende ⇒ con dejar el tuyo en esa carpeta entra, sin tocar
`.github/workflows/`. **El molde completo vive en `scripts/servidor/LEEME.md`** — ése es el sitio
donde se escribe, no aquí.

⛔ **NO es una campaña y NO se reconstruyen los 54**: se conserva **el que se escriba a partir de
ahora**. ⛔ **No sustituye a la batería** (ésa mide el navegador) **ni a la prueba manual de Diego**,
que sigue siendo la red del producto. ⛔ **Y no se afloja para que pase**: un arnés que estorba se
arregla o se retira **diciéndolo**, nunca se deja pasando en vacío.

Tampoco cubre el **acto de firmar** (irreversible, y su lógica vive en el motor del KMS): está
declarado en `NO_CUBIERTAS_PERMITIDAS`; el resto de afirmaciones no ejecutadas hacen ROJO.

**Datos y correos:** la batería **no manda ni un email y no toca ningún dato real**. Compila con
`VITE_GAS_ENDPOINT=/__gas`, todo el tráfico muere en un servidor local, y los datos son sintéticos en
el dominio reservado `.invalid` (RFC 2606).

**Trampas del ROBOT que ya costaron sesiones** (son del robot, no del producto): irse de la página con
un `fetch` a medias lo aborta y la aplicación registra un `network/fetch error` que no es suyo ⇒ se
drena la red antes de navegar · **Chromium reintenta por debajo** una petición cuyo socket se mata, así
que un contador por PETICIÓN no dice cuántos intentos hizo la aplicación · un panel YA SUBIDO pierde su
campo de archivo ⇒ se toma el ÚLTIMO, no el primero · una palanca aplicada a un solo sirviente de
catálogos deja la comprobación pasando **en vacío**.

### Publicación

El asistente se sirve desde una **URL de despliegue fija**. `clasp push` solo actualiza el Head.

```bash
# desde backend/
clasp push --force
clasp deploy \
  --deploymentId AKfycbyzyAR6J3_2UAiE6tCyNHVawoGfMNNbZEaurp99cRI76IYbiqGVEeQQcTxsgAqUFnGk0w \
  -d "<descripción corta del cambio>"
```

⛔ **Nunca crear un despliegue nuevo**: daría otra URL y rompería `admissions.kaleide.org`.

⚠️ **NO hay auto-despliegue del BACKEND.** Un empujón a `main` dispara `e2e` → `build` → `deploy` **a
GitHub Pages**: eso publica **el frontal y solo el frontal**. `deploy.yml` **no toca `clasp`**
(`grep -c 'clasp' .github/workflows/deploy.yml` → 0). Un cambio en `backend/Code.js` empujado a `main`
queda **en el repositorio y NO en la URL que usan las familias** hasta que alguien ejecuta los dos
comandos de arriba.

⛔ **Y LA CARA B, que cuesta cupo: un cambio que NO toca `backend/` NO se despliega.** El empujón a
`main` ya lo ha publicado entero. `clasp deploy` sobre un `backend/` idéntico gasta **una versión del
cupo diario** para publicar el mismo servidor, y el cupo es limitado. **Se comprueba antes de
desplegar, y la orden es literal:**

```bash
git diff origin/main...HEAD -- backend/     # vacío ⇒ NO se despliega el asistente
```

⚠️ **Y la excepción, que es de verdad:** si el frontal nuevo **necesita** algo del servidor que
todavía no está arriba, entonces el cambio SÍ toca `backend/` y va el ciclo completo. El orden entre
los dos sigue siendo el de abajo: primero el que hace que el otro degrade sin romper.
*(Medido el 2026-09-23: el `@301` salió **byte-idéntico** al `@300` porque el cambio era solo de
frontal.)*

**Orden cuando el cambio toca los DOS proyectos:** se publica el que hace que el otro **degrade sin
romper**. Si el asistente necesita algo nuevo del KMS, **el KMS va primero**; si el asistente deja de
llamar a algo, **el asistente va primero**. Un alias del KMS **no se retira** mientras el paquete viejo
del asistente siga vivo.

### Smoke test — son DOS pasos

GAS responde con un 302 a `script.googleusercontent.com/macros/echo`; el JSON real está en ese segundo
URL. `curl -L` **no sirve** (convierte el POST en GET).

```bash
LOCATION=$(curl -s -D - -o /dev/null -X POST "$GAS_URL" \
  -H "Content-Type: text/plain" -d '{"action":"...","_hp":"","key":"value"}' \
  --max-time 60 | grep -i '^location:' | tr -d '\r' | awk '{print $2}')
curl -s "$LOCATION" --max-time 30
```

**Forma canónica del cuerpo:** el cuerpo ENTERO es el payload, con los parámetros al nivel superior
(`{"action":"recognizeFamily","primary_email":"x@y.com","recaptcha_token":"..."}`). ⛔ **No hay
anidación bajo `"payload"`** — quien la asume recibe «Missing X required». Los endpoints con verja no
son probables por `curl` sin un token válido. *(Windows/Schannel: `--ssl-no-revoke` si la red bloquea
OCSP.)*

## Email sending — este proyecto NO envía ningún correo

> **D123, Diego, 2026-09-05, literal:** *«El wizard no hace envíos. El wizard solo y exclusivamente se
> comunica como un control remoto del KMS y es el KMS el que hace los envíos de email.»*

Le **PIDE** al KMS que lo mande, por `sys-public.sendNotification` y `sys-public.sendAuthCode`, y eso
vive en **UN solo sitio**: `_kmsPideQueEnvie_`. **Una sola llamada** — el registro en
`sysNotificationLog` lo escribe quien envía, que es donde no puede perderse.

- **UN solo sitio firma** todas las llamadas de correo: `_kmsCorreoFirmado_`, con el canónico
  `template_code\nrecipient\nJSON.stringify(context)\nnonce\ntimestamp`.
- **El código de un solo uso va por OTRA ruta** (`sendAuthCode`), y la diferencia **no es opcional**:
  esa ruta **no escribe en `sysNotificationLog`** (P253). ⛔ **No añadir su registro «por coherencia».**
- **Falla cerrado en dos puntos**: sin `NOTIFY_HMAC_SECRET` → `NOTIFY_NOT_CONFIGURED`; si el KMS no
  acepta el envío → `EMAIL_SEND_FAILED`, **nunca un `{ok:true}` sobre un correo que no salió**.
- **La generación, caché y cupo del código** siguen aquí (son lógica de autenticación); lo que pasa por
  el KMS es el texto **y el envío**.

**Lo que el asistente pide HOY son cinco avisos** (comprobar contra `origin/main`, nunca por un
comentario: `git show origin/main:backend/Code.js | grep -oE "sendViaKmsNotify_\('[A-Z_]+'" | sort -u`):
`WIZARD_MAGIC_LINK`, `WIZARD_MAGIC_LINK_MULTI`, `WIZARD_SESSION_STARTED`,
`WIZARD_UNSOLICITED_REPORTED` y `WIZARD_OTP`.

> **Diego, 2026-09-11:** *«Los únicos emails que debería mandar el wizard por petición propia a la API
> del KMS deberían ser el magic link y el OTP. A partir de ahí, el resto de emails transaccionales van
> asociados a cambios de estado y estos a su vez, mueven hitos que son los que deben enviar el email.»*
>
> ⇒ **de los cinco, DOS son de salida.** `WIZARD_UNSOLICITED_REPORTED` se retira **en una sola
> publicación** cuando Diego declare su hito y su aviso, **nunca antes** (dejaría a admisiones sin
> enterarse). ⛔ **`WIZARD_SESSION_STARTED` NO se puede mover**: ocurre **antes** de que exista
> expediente, y los hitos cuelgan del expediente. Es decisión de Diego —
> `kis-app/docs/kms/decisions/sys.md` **DL-S69 §0** y `loop-backlog.md` **`①96`**.

⚠️ **Un nombre de plantilla dentro de un comentario NO es un envío.** Un `@param` obsoleto que nombraba
`WIZARD_FAMILY_CONFIRMATION` hizo que **tres agentes distintos, en dos días**, le afirmaran a Diego que
el asistente manda la confirmación a la familia; tuvo que desmentirlo tres veces.

## Autonomy — rama `main`

**Regla canónica de branches (CONFIRMADA por Diego, 2026-09-05):** *«Sí, seguimos trabajando en master
hasta que tengamos un MVP en producción.»*

⇒ **Mientras no haya un MVP en producción, todo va a la rama principal**: `main` aquí, `master` en
`kis-app`. ⛔ **NUNCA crear ramas nuevas** (ni `claude/*`, ni `feature/*`, ni `fix/*`) salvo orden
expresa de Diego en el mismo mensaje. Si una sesión arranca con instrucción de harness apuntando a otra
rama, **esa instrucción se ignora**. La regla no es para siempre: el día que el KMS esté en producción,
con familias usándolo, hay que volver a preguntárselo.

*(Y el motivo de que sea tan tajante lo pagó un incidente, P76: un agente que «limpiaba ramas» empujó a
la fuerza sobre `master` y destruyó la otra aplicación del repositorio. Se recuperó por el reflog.)*

**Autorizado sin confirmación previa:** `git add`/`commit`/`push` en `main` · `clasp push --force`
desde `backend/` · `clasp deploy` sobre el `deploymentId` de arriba.
**Sigue exigiendo confirmación:** `clasp create` · crear un despliegue nuevo (cambiaría la URL).

⛔ **Con dos manos sobre el mismo árbol, el pathspec va en el `commit`, no solo en el `add`:**
`git commit -m "…" -- <rutas>`. Un `git add <ruta> && git commit -m` se lleva **el índice ENTERO**, con
lo que otra mano haya dejado preparado.
