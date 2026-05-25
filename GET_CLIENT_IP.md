# Obtener la IP del navegador del usuario desde Google Apps Script

Guía técnica del wizard de admisiones (`Kaleide-enrollment`). Patrón para capturar la IP pública del cliente en un handler del `backend/Code.js` — necesario para auditoría anti-abuso, rate-limiting por IP, registro de consentimientos firmados con valor probatorio (RGPD Art. 7.4) y trazabilidad del envío de un formulario público.

## Por qué no funciona desde el servidor

Apps Script ejecuta `doGet(e)` y `doPost(e)` en los servidores de Google, no en la máquina del cliente. El objeto `e` que llega al handler contiene `e.parameter` y `e.postData` (parámetros de URL y cuerpo de la request), pero **no incluye la IP del origen ni cabeceras de tránsito como `X-Forwarded-For`**. Cualquier intento de capturar IP en servidor produciría como mucho la IP del datacenter de Google que está atendiendo la petición — no la del usuario que rellena el wizard.

Tampoco hay API de sesión que la exponga: el wizard se despliega con `executeAs: USER_DEPLOYING` y `access: ANYONE_ANONYMOUS` (ver `CLAUDE.md` y DL-E23 del KMS), así que ni siquiera existe `Session.getActiveUser()` con un usuario identificable.

**Conclusión:** la IP del cliente debe capturarse desde el navegador y enviarse explícitamente al backend como parte del payload del `fetch` a `doPost`.

## Solución principal (cliente → servidor)

El cliente obtiene su IP pública con `fetch` contra un servicio público (`https://api.ipify.org?format=json`) y la envía al backend en el siguiente `gasCall`. El handler la recibe en `payload.client_ip` y la persiste donde corresponda (consentimiento, log de sesión, registro anti-abuso).

### Frontend — `frontend/src/`

Helper reutilizable en `frontend/src/utils/clientIp.js` (crear el archivo):

```javascript
// frontend/src/utils/clientIp.js
/**
 * Obtiene la IP pública del navegador. Cachea el resultado en memoria para
 * no golpear ipify en cada llamada del wizard. Devuelve null si el servicio
 * falla — el backend debe tolerarlo (campo opcional en el payload).
 */
let _ipCache  = null;
let _ipFlight = null;

export async function getClientIp() {
  if (_ipCache)  return _ipCache;
  if (_ipFlight) return _ipFlight;

  _ipFlight = fetch('https://api.ipify.org?format=json', {
    method: 'GET',
    cache:  'no-store',
  })
    .then(res  => res.json())
    .then(data => { _ipCache = data.ip || null; _ipFlight = null; return _ipCache; })
    .catch(()  => { _ipFlight = null; return null; });

  return _ipFlight;
}
```

Uso desde una página del wizard, antes de un `gasCall` que registre un consentimiento o cierre la sesión:

```javascript
// frontend/src/pages/ConsentPage.jsx (extracto)
import { gasCall } from '../api.js'
import { getClientIp } from '../utils/clientIp.js'

async function handleAcceptConsent(consentId, resumeToken) {
  const clientIp = await getClientIp();  // null si falla — backend lo tolera
  const res = await gasCall('recordConsent', {
    resume_token: resumeToken,
    consent_id:   consentId,
    client_ip:    clientIp,
  });
  // ...
}
```

El `gasCall` de `frontend/src/api.js` ya serializa el payload y lo envía a `doPost` con `Content-Type: text/plain` (para evitar preflight CORS contra `script.google.com`). El campo `client_ip` viaja como un atributo más del JSON del cuerpo.

### Backend — `backend/Code.js`

El dispatcher de `doPost` (línea 145) ya extrae `action` del body y rutea al handler privado correspondiente. Añadir el handler `recordConsent_` siguiendo la convención de naming del archivo (función privada con guión bajo final):

```javascript
// backend/Code.js
/**
 * Records a signed consent with provenance metadata (IP + UA).
 * Called from ConsentPage of the wizard.
 *
 * @param {{ resume_token: string, consent_id: string, client_ip?: string|null }} p
 * @returns {{ ok: true, consent_log_id: string }}
 */
function recordConsent_(p) {
  // Validación mínima
  if (!p.resume_token) throw new Error('resume_token is required');
  if (!p.consent_id)   throw new Error('consent_id is required');

  // Resolver la sesión del wizard a partir del resume_token (patrón ya usado
  // por resumeSession_, saveStep_, etc.).
  var groupId = _resolveGroupIdFromToken_(p.resume_token);
  if (!groupId) throw new Error('Invalid resume_token');

  // Sanitización ligera de la IP recibida del cliente. Las IPs públicas válidas
  // no exceden 45 caracteres (IPv6 representada como texto). Truncar y descartar
  // cualquier cosa anómala para evitar bloating del log.
  var clientIp = (p.client_ip || '').trim() || null;
  if (clientIp && clientIp.length > 45) clientIp = null;

  // Persistir en sysConsentsLog (tabla polimórfica transversal del KMS — ver
  // DL-S44 / DL-S49 en kis-app/docs/kms/design-logs/sys-module-design-log.md).
  var consentLogId = Utilities.getUuid();
  appsheetAdd_('sysConsentsLog', [{
    consent_log_id:    consentLogId,
    school_id:         _getSchoolId_(),
    entity_type_code:  'ENR_ADMISSION_SCHOOL',
    entity_id:         groupId,
    consent_id:        p.consent_id,
    signed_method:     'CLICKWRAP',
    client_ip:         clientIp,       // ← null si el cliente no la envió
    signed_at:         new Date().toISOString(),
    created_at:        new Date().toISOString(),
    created_by:        'wizard-public',
  }]);

  return { ok: true, consent_log_id: consentLogId };
}
```

Registrar la nueva acción en el switch del dispatcher de `doPost` (junto a `initEnrollmentSession`, `recognizeFamily`, `resumeSession`, etc.):

```javascript
// dentro de doPost(e), al final del switch sobre payload.action:
case 'recordConsent':
  result = recordConsent_(payload);
  break;
```

**Notas operativas:**

- `client_ip` es **opcional** en el payload. El backend no puede confiar en que llegue — el cliente puede bloquear `api.ipify.org`, estar offline, o tener una extensión que rompa el fetch. Tratar `null` como dato válido, no como error.
- **No usar la IP como mecanismo de autenticación ni de autorización.** Es trivialmente falsificable: el cliente puede enviar cualquier string en `client_ip`. Para gating real se usa `verifyRecaptcha_` (línea 1753 de `Code.js`) y el `resume_token` firmado. La IP es **dato auxiliar de auditoría**, nunca control de acceso.
- Si necesitas reducir spoofing en handlers críticos (firma con valor probatorio Art. 7.4 RGPD), considera hacer también desde el backend un `UrlFetchApp.fetch` a un servicio de IP — pero solo aporta sentido si quieres registrar la IP del datacenter de Google que originó la petición de verificación, que es distinto al uso normal. Para el wizard público basta con confiar en el cliente.

## Servicios alternativos de IP

Tres servicios públicos comunes, cualquiera sirve. Si uno falla, el helper puede caer al siguiente:

| Servicio | Endpoint | Respuesta | Coste | Observaciones |
|---|---|---|---|---|
| **ipify** | `https://api.ipify.org?format=json` | `{"ip": "203.0.113.42"}` | Gratis, sin auth, sin rate-limit publicado | Recomendado por defecto. HTTPS estable, respuesta mínima, dependencia pequeña. |
| **ipapi.co** | `https://ipapi.co/json/` | `{"ip": "203.0.113.42", "city": "...", "country": "ES", ...}` | Gratis hasta 1.000 req/día; planes pagos | Útil si además se quiere geolocalización aproximada (país/ciudad) en la misma llamada. Más metadata = más datos personales que tratar (ver RGPD abajo). |
| **ip-api.com** | `http://ip-api.com/json/` | `{"query": "203.0.113.42", "country": "Spain", ...}` | Gratis hasta 45 req/min para uso no comercial; HTTPS solo en planes pagos | **No HTTPS gratis** — limitación importante: el wizard se sirve por HTTPS (admissions.kaleide.org), llamar a `http://` desde HTTPS dispara mixed content blocking. Solo viable como fallback de último recurso. |

Patrón con fallback en el helper:

```javascript
const PROVIDERS = [
  'https://api.ipify.org?format=json',
  'https://ipapi.co/json/',
];

async function tryProvider(url) {
  const res  = await fetch(url, { cache: 'no-store' });
  const data = await res.json();
  return data.ip || data.query || null;
}

export async function getClientIp() {
  if (_ipCache) return _ipCache;
  for (const url of PROVIDERS) {
    try {
      const ip = await tryProvider(url);
      if (ip) { _ipCache = ip; return ip; }
    } catch (_) { /* probar siguiente */ }
  }
  return null;
}
```

## Consideración RGPD

La **IP pública de un usuario es un dato personal** según el art. 4.1 RGPD y la jurisprudencia europea (TJUE, asunto Breyer C-582/14, 2016): aunque por sí sola no identifica al usuario, combinada con otros datos disponibles para el responsable del tratamiento (sesión del wizard, email primario del solicitante, hora exacta) sí permite identificación indirecta. Su captura y registro constituye **tratamiento de dato personal** y requiere cumplir las obligaciones del Reglamento.

Es especialmente relevante para el wizard porque es **público anónimo** — la única traza identitaria del usuario antes de que rellene el formulario es precisamente esa IP. Tratarla con cuidado es parte del compromiso de proporcionalidad.

**Implicaciones concretas para el wizard:**

1. **Base legal del tratamiento.** Documentar en el Registro de Actividades de Tratamiento (RAT) del centro la finalidad por la que se registra la IP — típicamente **interés legítimo** (art. 6.1.f) en prevención de fraude y abuso (envíos masivos, suplantación), o **cumplimiento de obligación legal** cuando registra una firma electrónica con valor probatorio (Art. 7.4 RGPD demostración del consentimiento).

2. **Información en la política de privacidad.** La página de política de privacidad del wizard (`frontend/src/pages/PrivacyPolicyPage.jsx`) debe mencionar expresamente que se registra la IP del dispositivo en momentos clave: al firmar consentimientos, al solicitar magic link, al enviar el formulario final. No basta con un aviso genérico — el dato debe estar listado entre las categorías tratadas.

3. **Aviso visible en el momento de la captura.** En la página de consentimientos (`ConsentPage.jsx`), añadir bajo el botón de aceptación una nota como:

   > *"Al aceptar, se registra la fecha, hora y dirección IP de su dispositivo como evidencia del consentimiento, conforme al art. 7.4 del RGPD. Estos datos forman parte del registro de auditoría del centro y se conservan durante el plazo legal aplicable."*

4. **Minimización (art. 5.1.c).** Capturar IP solo en interacciones que la justifican:
   - **Sí:** firma de consentimientos, envío final del formulario, solicitud de magic link.
   - **No:** navegación entre pasos del wizard, validación inline de campos, autocompletado.

5. **Conservación.** La IP en `sysConsentsLog` se conserva el mismo plazo que el resto del registro al que pertenece. Para consentimientos RGPD (Art. 7.4) que prueban una manifestación de voluntad, el plazo recomendado es el periodo de prescripción aplicable a la relación contractual (típicamente 5 años desde el final del contrato; consultar con asesoría jurídica del centro). En `enrEnrollmentGroups` para sesiones abandonadas el plazo es más corto (90 días por defecto).

6. **Derecho de supresión.** Si un solicitante ejerce el derecho de supresión (art. 17) antes de que la solicitud se promueva a `personalData_S`, todo su rastro — incluida la IP en logs — se purga. Para consentimientos ya con valor probatorio (post-RS) que el centro debe conservar, anonimizar la IP reemplazándola por un hash irreversible documentando el procedimiento.

7. **Transferencias internacionales.** El servicio `ipify` (y alternativos) procesa la petición HTTP en sus servidores, que pueden estar fuera del EEE. El centro no transfiere la IP a esos servicios — el navegador del usuario sí, en una llamada que el wizard inicia. Documentar este punto en la política de privacidad si la asesoría jurídica del centro lo considera necesario.

## Referencias

- `CLAUDE.md` del wizard — manifest GAS (`executeAs: USER_DEPLOYING`, `access: ANYONE_ANONYMOUS`) y por qué el wizard es un proyecto GAS separado del KMS.
- `backend/Code.js:132` — `doGet(e)`: parámetros disponibles al servidor.
- `backend/Code.js:145` — `doPost(e)`: dispatcher principal del wizard, sigue el contrato `{action, _hp, ...payload}`.
- `backend/Code.js:1753` — `verifyRecaptcha_`: precedente de llamada externa con `UrlFetchApp.fetch` para verificación de un token entregado por el cliente.
- `frontend/src/api.js` — `gasCall(action, payload)`: cualquier campo del payload llega al handler. Ver el comentario sobre `Content-Type: text/plain` para evitar preflight CORS.
- DL-E22 del KMS (`kis-app/docs/kms/design-logs/enr-module-design-log.md`) — hardening del wizard público: rate-limit de magic links, TTL de `resume_token`, `reportUnsolicited_`. La IP es complemento natural de este hardening.
- DL-E23 — Frontera Wizard ↔ KMS: por qué no se puede ejecutar bajo `USER_ACCESSING` y `ANYONE_ANONYMOUS` a la vez.
- DL-S44 / DL-S49 (KMS) — `sysConsentsLog` y extensión Art. 7.4 RGPD: tabla polimórfica donde el wizard escribe los consentimientos.
- TJUE — sentencia Breyer (C-582/14, 19 oct 2016) — la IP pública es dato personal.
- Reglamento (UE) 2016/679 (RGPD) — arts. 4.1, 5.1.c, 6.1.f, 7.4, 13, 14, 17, 32.
- Documentación de servicios: [ipify](https://www.ipify.org/), [ipapi.co](https://ipapi.co/), [ip-api.com](https://ip-api.com/).
