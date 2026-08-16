/**
 * GAS API client.
 * Every call includes _hp (honeypot — empty, untouched by real users).
 */

// ─── Lookups cache ────────────────────────────────────────────────────────────
// fetchLookups result is static for the lifetime of the page — cache it.
// prefetchLookups() kicks off the request early; fetchLookups() returns the
// cached promise (or value) so steps get the result immediately if it's ready.
let _lookupsCache  = null;
let _lookupsFlight = null;

export function prefetchLookups() {
  if (_lookupsCache || _lookupsFlight) return;
  _lookupsFlight = gasCall('fetchLookups', {})
    .then(data  => { _lookupsCache = data; _lookupsFlight = null; return data; })
    .catch(_err => { _lookupsFlight = null; });
}

/**
 * DL-B §1 — Siembra la caché de lookups desde la hidratación consolidada
 * (hydrateSession devuelve `lookups`). Tras esto, fetchLookups()/prefetchLookups()
 * resuelven DESDE MEMORIA sin tocar la red → cero fetch de catálogos por-entrada
 * (Step3/Step4/Step7). Idempotente: solo siembra si trae datos y no había caché.
 * @param {Object} lookups — { allergies, dietary, medical, relationTypes, programs }
 */
export function primeLookups(lookups) {
  if (!lookups || typeof lookups !== 'object') return;
  if (_lookupsCache) return;
  _lookupsCache  = lookups;
  _lookupsFlight = null;
}

/**
 * Persists the NEAE (Necesidades Específicas de Apoyo Educativo) declaration
 * captured in the Paso 4 "Salud y apoyo" sub-section. Direct wizard-side write
 * to the enr* staging tables (action 'saveNeae'). KAL-4: the backend derives the
 * group from the resume_token and validates each person_id against it.
 *
 * @param {string} resumeToken  the family session bearer token
 * @param {Array}  neaeData     [{ person_id, conditions:[…], supports:[…], source_locale }]
 * @param {{n?:string, recoveredEmail?:string}} [identidad] ②24 — quién está operando.
 */
export function saveNeae(resumeToken, neaeData, identidad) {
  return gasCall('saveNeae', {
    resume_token: resumeToken, neae: neaeData, ...identidadDelEnlace(identidad),
  });
}

/**
 * ②24 (2026-08-10) — QUIÉN ESTÁ OPERANDO, en el sub-objeto que el servidor espera.
 *
 * El servidor resuelve el tutor DEL PROPIO ENLACE (`n` = el identificador de la fila de
 * correo, IDENTITY-FROM-LINK) y lo valida contra el expediente del token;
 * `recovered_email` es el respaldo secundario. Nunca mandamos un tutor ni un expediente
 * elegidos por el cliente.
 *
 * Va en TODA llamada que el servidor protege con el código de un solo uso, porque desde
 * ②24 la marca de step-up es DEL BUZÓN que se verificó: si la petición no dice quién
 * opera, el servidor la atiende como al tutor 1 — que es justo el fallo que ②24 cierra
 * (el tutor 2 pedía su código y le llegaba al otro).
 *
 * Es el mismo contrato que `signingIdentity_` de los pasos de firma; aquí vive la forma
 * general para el resto de pasos. Un solo sitio la construye.
 *
 * @param {{n?:string, recoveredEmail?:string}} [identidad]
 * @returns {{n?:string, recovered_email?:string}}
 */
export function identidadDelEnlace(identidad) {
  const id = identidad || {};
  const out = {};
  if (id.n) out.n = id.n;                                          // identidad del enlace
  if (id.recoveredEmail) out.recovered_email = id.recoveredEmail;  // respaldo secundario
  return out;
}

/**
 * La familia pide poder corregir una solicitud que YA envió (cola 18.quater).
 *
 * El wizard no decide nada: manda el hecho y devuelve lo que el KMS conteste. Puede
 * volver `requested:false` con un motivo (p.ej. que el colegio aún no lo tenga
 * declarado) — la pantalla DEBE distinguirlo de un «sí», porque decirle a una familia
 * que su petición está cursada cuando no lo está la deja esperando para siempre.
 *
 * @param {string} resumeToken
 * @param {string} [note] lo que la familia quiere corregir, en sus palabras
 */
export function requestCorrection(resumeToken, note) {
  return gasCall('requestCorrection', { resume_token: resumeToken, note: note || null });
}

/**
 * 18.bis.84 · ¿CÓMO ACABARON LOS GUARDADOS QUE EL KMS DEJÓ APUNTADOS?
 *
 * El servidor NO guarda los pasos en el acto: los apunta y los hace después. Que una
 * llamada de guardado vuelva bien solo significa «apuntado», nunca «escrito» — así que sin
 * esta pregunta la familia leía «Todos los cambios guardados» aunque el trabajo acabara
 * fallando o descartando lo que había escrito.
 *
 * LECTURA — por eso NO entra en `ACCIONES_QUE_ESCRIBEN`: que se pueda preguntar no dice
 * absolutamente nada sobre si una escritura entra, y meterla ahí apagaría el aviso rojo
 * por el motivo equivocado.
 *
 * El expediente lo deriva el servidor del `resume_token` (KAL-4); los identificadores no
 * autorizan nada — uno ajeno vuelve como `'desconocido'`, sin delatar que exista.
 *
 * @param {string} resumeToken
 * @param {string[]} jobIds hasta 10 (el tope lo recorta también el servidor).
 * @returns {Promise<{trabajos: Array<{job_id:string, estado:string, motivo:?string, descartes:?Object}>}>}
 */
export function estadoDelGuardado(resumeToken, jobIds) {
  return gasCall('estadoDelGuardado', {
    resume_token: resumeToken,
    job_ids: (Array.isArray(jobIds) ? jobIds : []).slice(0, 10),
  });
}

/**
 * La familia QUITA de su solicitud algo que ella misma añadió (cola 18.bis.8).
 *
 * Hasta hoy los botones de quitar solo borraban de la pantalla: al guardar se mandaba la
 * lista superviviente y el KMS hacía upsert de lo que llegaba, sin tocar lo que dejaba de
 * venir. Es decir, quitar NO se guardaba nunca.
 *
 * Lo que se quita viaja IDENTIFICADO — nunca «lo que no mando, bórralo»: un guardado a
 * medias vaciaría la solicitud entera. El expediente lo deriva el servidor del enlace de
 * la familia, jamás de lo que mande la pantalla.
 *
 * Clases admitidas: `PERSONA` · `CORREO` · `TELEFONO` · `VINCULO` · `DOCUMENTO`.
 *
 * La respuesta trae el veredicto de CADA elemento (`QUITADO`, `YA_ESTABA`, `RECHAZADO`,
 * `NO_SE_PUEDE`, `NO_SE_PUDO`) y, si la solicitud ya está enviada, `bloqueado` + `mensaje`.
 * Quien llame TIENE que mirarlo: decirle a una familia que quitó algo que sigue ahí es
 * exactamente el fallo que esto cierra.
 *
 * ②27 — el servidor protege esto con el código de un solo uso (quitar no puede pedir menos
 * que corregir), así que la llamada dice QUIÉN OPERA, como toda llamada gateada (②24).
 *
 * @param {string} resumeToken
 * @param {Array<{clase:string,id:string}>} elementos
 * @param {{n?:string, recoveredEmail?:string}} [identidad]
 */
export function retirarDelExpediente(resumeToken, elementos, identidad) {
  return gasCall('retirarDelExpediente', {
    resume_token: resumeToken,
    ...identidadDelEnlace(identidad),
    retirar: Array.isArray(elementos) ? elementos : [],
  });
}

/**
 * DL-E49 §4/§9 — avisa al tutor DECLARADO mandándole SU propio enlace de la solicitud.
 *
 * Sin esto, un segundo tutor solo entra si alguien se lo dice: puede pedir su enlace
 * tecleando su correo en la portada, pero nadie le avisa de que tiene una parte que
 * rellenar — y la solicitud se queda esperándole indefinidamente (DL-E49 §1).
 *
 * A quién se avisa lo dice el `person_id` de la ficha; **el correo lo resuelve el servidor**
 * de lo que la familia ya declaró, así que por aquí no se puede mandar el enlace a una
 * dirección arbitraria. El expediente lo deriva el servidor del enlace de la familia
 * (KAL-4), y exige además el código de un solo uso (②27) — por eso la llamada dice QUIÉN
 * OPERA, como toda llamada gateada (②24).
 *
 * @param {string} resumeToken
 * @param {string} personId — la ficha del tutor a avisar
 * @param {{n?:string, recoveredEmail?:string}} [identidad]
 */
export function avisarATutor(resumeToken, personId, identidad) {
  return gasCall('avisarATutor', {
    resume_token: resumeToken,
    ...identidadDelEnlace(identidad),
    person_id: personId,
  });
}

export function fetchLookups() {
  if (_lookupsCache)  return Promise.resolve(_lookupsCache);
  if (_lookupsFlight) return _lookupsFlight;
  _lookupsFlight = gasCall('fetchLookups', {})
    .then(data  => { _lookupsCache = data; _lookupsFlight = null; return data; })
    .catch(err  => { _lookupsFlight = null; throw err; });
  return _lookupsFlight;
}

// ─── Signing-session READ single-flight (data-layer pieza 5: corta la tormenta) ──
// `initiateSigningSession` con create_only:true es una LECTURA del estado de la
// sesión de firma (miembros, sub-pasos completados). SignReview (mount) + SignSign
// (mount) + re-mounts concurrentes la disparaban por separado → tormenta de llamadas
// concurrentes que AppSheet throttlea a 30-60s. Single-flight por signing_token:
// mientras hay una lectura EN VUELO para ese token, los demás llamantes comparten la
// MISMA promesa. Al settle se limpia → la siguiente lectura (tras un cambio de estado)
// va fresca (sin cache stale).
//   IMPORTANTE: SOLO de-duplica la LECTURA create_only:true. El DISPATCH real del
//   envelope (initiateSigningSession SIN create_only, en SignSign por acción explícita
//   del usuario) NUNCA pasa por aquí — el STOP-GAP de SignSign se preserva intacto.
//   IDENTITY-COMPLETION (#30): acepta la identidad de SESIÓN ({ resumeToken, n,
//   recoveredEmail } preferente; { signingToken } compat). IDENTITY-FROM-LINK: bajo
//   resume_token el backend (requireSignerContext_) resuelve el firmante del `n` (email_id
//   del enlace) → email → guardian, validado contra el grupo del token → la lectura del
//   estado de firma sobrevive a F5/incógnito sin signing_token en React state. Compat: un
//   argumento string se trata como signingToken (back-compat de llamadas antiguas).
const _signingReadFlight = {};   // { [identityKey]: promise }
export function initiateSigningRead(identity) {
  const id = (typeof identity === 'string')
    ? { signingToken: identity }
    : (identity || {});
  const resumeToken   = id.resumeToken || null;
  const signingToken  = id.signingToken || null;
  const n             = id.n || null;
  const recoveredEmail = id.recoveredEmail || null;
  if (!resumeToken && !signingToken) {
    return Promise.reject(new Error('initiateSigningRead: resume_token or signing_token required'));
  }
  // Single-flight key: el resume_token de sesión (preferente) o el signing_token.
  const key = resumeToken ? ('r:' + resumeToken) : ('s:' + signingToken);
  if (_signingReadFlight[key]) return _signingReadFlight[key];
  const tokenPayload = resumeToken
    ? { resume_token: resumeToken, n: n || undefined, recovered_email: recoveredEmail || undefined }
    : { signing_token: signingToken };
  const flight = gasCall('initiateSigningSession', { ...tokenPayload, create_only: true })
    .finally(() => { delete _signingReadFlight[key]; });
  _signingReadFlight[key] = flight;
  return flight;
}

// ─── Documents (paquete de firma) eager cache (WPERF-1 criterio "eager docs") ───
// `getDocument` (proxy de bytes) es la llamada MÁS lenta del paquete contractual
// (~40s medidos). Espejo de prefetchLookups/prefetchQuestions: cuando un firmante
// entra (expediente AD + firma lista), calentamos la LISTA de docs (initiateSigningRead
// → members) y, best-effort, los BYTES de cada doc, para que al llegar a S-REVIEW las
// previews pinten sin esperar. Se cachea la PROMESA de bytes ({base64,mimeType,filename,
// sha256 — DOC-BYTES}) por file_id (capa de fetch/de-dupe ÚNICA). El cache DURADERO del
// visor (object URLs + sha256) vive en WizardContext (STEP10-VIEWER, decisión Diego
// 2026-06-11: "si avanzo de los documentos a la firma y vuelvo a documentos, me vuelve a
// cargar los documentos, no los almacena en memoria") — el `loadDocument` del contexto
// pasa SIEMPRE por aquí, así que warm y visor comparten UNA sola vía de bytes (no hay dos
// caches que diverjan). Errores (típicamente STEPUP_REQUIRED si el step-up no está fresco
// todavía al montar) → la entrada se purga → cache-miss silencioso, idéntico al actual.
// STEP10-VIEWER (blob-only): la rama WPERF-4 de URLs de visor de Drive se ELIMINÓ — el KMS ya no
// emite ese campo (DOC-BYTES) y el visor usa SIEMPRE object URLs de PDF.
const _docBytesCache = {};   // { [file_id]: Promise<{base64,mimeType,filename,sha256?}> }

export function getDocumentBytes({ file_id, resume_token, signing_token, n, recovered_email }) {
  if (!file_id) return Promise.reject(new Error('getDocumentBytes: file_id required'));
  if (_docBytesCache[file_id]) return _docBytesCache[file_id];
  // IDENTITY-COMPLETION (#30): `n` (email_id del enlace) + recovered_email para que
  // getDocument_ resuelva el signing_token server-side bajo resume_token (PDF de firma).
  const flight = gasCall('getDocument', { file_id, resume_token, signing_token, n, recovered_email })
    .catch(err => { delete _docBytesCache[file_id]; throw err; });   // NO cachear fallos
  _docBytesCache[file_id] = flight;
  return flight;
}

/** STEP10-VIEWER: purga la capa de bytes (la llama WizardContext al limpiar sesión,
 *  junto con la revocación de los object URLs del cache del contexto). */
export function purgeDocumentBytesCache() {
  for (const k in _docBytesCache) delete _docBytesCache[k];
}

/**
 * Warm del paquete contractual en background (WPERF-1 + preload `documents` del
 * catálogo STEP-FRAMEWORK). STEP10-VIEWER: escribe en EL cache del contexto — recibe
 * `loadDocument` (WizardContext), que resuelve bytes vía getDocumentBytes (de-dupe) y
 * persiste el object URL + sha256 keyed por file_id en el contexto. Un solo cache.
 * @param {{resumeToken?:string, signingToken?:string, n?:string, recoveredEmail?:string}} identity
 * @param {(params:Object)=>Promise<Object>} loadDocument — del WizardContext
 */
export function prefetchDocuments(identity, loadDocument) {
  const id = (typeof identity === 'string') ? { signingToken: identity } : (identity || {});
  if ((!id.resumeToken && !id.signingToken) || typeof loadDocument !== 'function') return;
  const docIdentity = id.resumeToken
    ? { resume_token: id.resumeToken, n: id.n || undefined, recovered_email: id.recoveredEmail || undefined }
    : { signing_token: id.signingToken };
  initiateSigningRead(id)
    .then(res => {
      const members = Array.isArray(res && res.members) ? res.members : [];
      members.forEach(m => {
        if (!m.file_id) return;
        loadDocument({ file_id: m.file_id, ...docIdentity }).catch(() => {});
      });
    })
    .catch(() => {});
}

// ─── Questions cache ──────────────────────────────────────────────────────────
// The question DEFINITION catalog (fetchQuestions → { sets: [...] }) is static for
// the lifetime of the page, mirror of the lookups cache — but KEYED BY LANGUAGE
// because questions are localized (fetchQuestions receives language: i18n.language).
// This caches ONLY the catalog of questions, NOT the user's RESPONSES (those live
// in WizardContext / stepData.questions and are unaffected). context_code is fixed
// to 'ENROLLMENT' exactly as the call-sites used inline.
// WIZARD-UX (Diego 2026-06-07): Step5 + Step7 used to fetch this independently on
// every mount → re-fetched on every back/forward. Now they share the cache.
const _questionsCache  = {};   // { [lang]: data }  (module memory — dies on reload)
const _questionsFlight = {};   // { [lang]: promise }

// WIZARD-PERF-CACHE-SKELETON (Diego 2026-06-07): capa stale-while-revalidate en
// sessionStorage para que el paso de Preguntas PINTE de inmediato tras un reload
// (la cache de módulo se pierde al recargar). El catálogo de preguntas es
// CONTENIDO PÚBLICO del tenant (NO PII de la familia) → se guarda en claro en
// sessionStorage (decisión documentada: cifrar sería seguridad de teatro porque la
// clave viviría en el bundle; las RESPUESTAS de la familia NUNCA se cachean aquí).
// Frescura atada al ciclo step-up: TTL = STEPUP_WINDOW_MS (10 min, espejado local
// para evitar import circular con WizardContext) + purga explícita en clearSession
// (WizardContext llama purgeQuestionsCache()). Defensivo: parseo/quota fallan →
// cache-miss silencioso, comportamiento idéntico al actual.
const QCACHE_PREFIX = 'kis_wizard_qcache_v2_'; // v2: invalida la caché vieja con códigos (pre QB-TRANS designation fix)
const QCACHE_TTL_MS = 10 * 60 * 1000; // espejo de STEPUP_WINDOW_MS (WizardContext)

// ─── SPEC-WIZ-BROWSERCACHE: catálogo PERSISTENTE en localStorage (2ª+ visita) ───
// La capa sessionStorage de arriba (QCACHE_PREFIX) muere al CERRAR el navegador (es
// por sesión). Este SPEC añade una capa localStorage PERSISTENTE para que la 2ª y
// siguientes visitas del MISMO navegador (incluso días después, sesión nueva) pinten
// el Step 5 al instante (sub-segundo) desde el catálogo cacheado, revalidando por
// versión. Se ancla a las MISMAS funciones que ya lee el wizard (readQuestionsCacheSync
// / fetchQuestions / _persistQuestions / purgeQuestionsCache) — NO crea un lector nuevo.
//
// KAL-7 (invariante "NO PII en localStorage"): SOLO se persiste el CATÁLOGO
// (estructura + traducciones + condiciones), que es contenido PÚBLICO tenant-estático
// y NO-PII. Las RESPUESTAS y datos de la familia NUNCA tocan esta capa (viven en
// WizardContext/stepData). El catálogo se purga además al limpiar sesión (no sobrevive
// al ciclo de auth — purgeQuestionsCache, espejo de la capa de sesión).
//
// catalog_version (PENDIENTE spec §7.5 — RESUELTO con degradación defensiva): hoy el
// backend NO expone un identificador de versión del catálogo (fetchQuestions devuelve
// { ctx, sets } sin version/etag — verificado en backend/Code.js:3746
// fetchQuestions_adaptKmsResponse_). Per la regla "la falta de campo backend NO congela
// el frontend", derivamos catalog_version client-side como hash estable del payload del
// catálogo y revalidamos best-effort por TTL corto. Invariante "revalidación obligatoria
// por versión" satisfecha: NUNCA servimos el cacheado indefinidamente — pasada la ventana
// QCACHE_LS_REVALIDATE_MS la siguiente visita dispara un fetch de revalidación en
// background y REEMPLAZA el catálogo si el hash (versión) cambió; un tope duro
// QCACHE_LS_MAXAGE_MS descarta cache verdaderamente vieja.
// TODO(Diego): cuando el backend exponga un catalog_version barato (p.ej. updated_at máx
// de las tablas qb del context, SIN columnas ad-hoc — spec §7.5 opción (a); o derivado
// del prewarm de SPEC-WIZ-PREWARM), cambiar la revalidación a una llamada LIGERA de
// versión en vez del fetch pesado de fetchQuestions → la 2ª visita queda sin red visible
// también fuera de la ventana corta (acceptance criterion pleno).
const QCACHE_LS_PREFIX        = 'kis_wizard_qcache_persist_v1_';
const QCACHE_LS_REVALIDATE_MS = 30 * 60 * 1000;            // 30 min: dentro de la ventana se sirve de localStorage SIN red; fuera, se revalida en background
const QCACHE_LS_MAXAGE_MS     = 30 * 24 * 60 * 60 * 1000;  // 30 días: tope duro — cache más vieja se descarta como fría

/** catalog_version client-side: hash estable y barato (FNV-1a 32-bit) del catálogo. */
function _catalogVersion(data) {
  const str = JSON.stringify((data && data.sets) || []);
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = (h + ((h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24))) >>> 0;
  }
  return ('00000000' + h.toString(16)).slice(-8);
}

/** Lee la entrada PERSISTENTE de localStorage → { data, v, storedAt } o null (ausente/corrupto/>MAXAGE). */
function _readPersistedQuestions(key) {
  try {
    const raw = localStorage.getItem(QCACHE_LS_PREFIX + key);
    if (!raw) return null;
    const parsed = JSON.parse(raw);
    if (!parsed || !parsed.data || !parsed.storedAt || (Date.now() - parsed.storedAt) > QCACHE_LS_MAXAGE_MS) {
      localStorage.removeItem(QCACHE_LS_PREFIX + key);
      return null;
    }
    return parsed;
  } catch { return null; }
}

/**
 * Lectura SÍNCRONA del catálogo cacheado en sessionStorage (paint instantáneo).
 * Esta lectura sync NO calienta la cache de MÓDULO a propósito: en un reload SIN
 * hydrate (familia sin resume reciente) el módulo arranca frío → fetchQuestions
 * revalida por red (SWR) y refresca el catálogo. §11: cuando SÍ hubo hydrate, es
 * `primeQuestions` (no esta lectura) quien ceba `_questionsCache[lang]` → entonces
 * fetchQuestions short-circuita y sirve de memoria SIN red. El path del hydrate
 * (prime) gana; el SWR solo actúa cuando no hubo prime. Devuelve null si
 * ausente/expirado/corrupto.
 * @param {string} lang
 * @returns {Object|null}
 */
export function readQuestionsCacheSync(lang) {
  const key = lang || 'es';
  if (_questionsCache[key]) return _questionsCache[key];
  try {
    const raw = sessionStorage.getItem(QCACHE_PREFIX + key);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.data && parsed.expiresAt && Date.now() <= parsed.expiresAt) {
        return parsed.data;
      }
      sessionStorage.removeItem(QCACHE_PREFIX + key);
    }
  } catch { /* cae a la capa persistente de localStorage */ }
  // SPEC-WIZ-BROWSERCACHE: la capa de sesión murió (navegador cerrado / sesión nueva)
  // → sirve el catálogo PERSISTENTE de localStorage para paint instantáneo. NO ceba la
  // cache de módulo (igual que la lectura de sesión): así fetchQuestions revalida por
  // versión en background cuando la entrada esté fuera de la ventana de frescura.
  const persisted = _readPersistedQuestions(key);
  return persisted ? persisted.data : null;
}

/**
 * UN CATÁLOGO VACÍO NO SE GUARDA COMO BUENO (2026-08-04).
 *
 * El cuestionario se apagaba entero, en silencio y durante media hora, por esta cadena:
 * el servidor convertía cualquier fallo en `{sets:[]}` → la hidratación lo sembraba aquí
 * como catálogo bueno → `fetchQuestions` cortocircuitaba contra esa caché y NO volvía a
 * salir a red en toda la ventana de revalidación (30 min) → ni recargar lo arreglaba, y
 * «Continuar» guardaba vacío sin decirle nada a la familia.
 *
 * La raíz era que un vacío podía significar dos cosas incompatibles («falló» / «este
 * colegio no tiene preguntas») y el código no podía distinguirlas. El servidor ya no las
 * confunde (retira la clave cuando falla, en vez de mandar vacío); aquí ponemos la otra
 * mitad: **el vacío nunca se CACHEA**. Si el catálogo llega vacío se sirve igual —una
 * escuela puede no tener preguntas— pero no se guarda, así que la siguiente vez se vuelve
 * a preguntar. Coste: una llamada de más en el caso raro de catálogo legítimamente vacío.
 * A cambio, ningún fallo se queda pegado.
 *
 * MEDIDO contra el sistema real (2026-08-04, `fetchQuestions` sobre el despliegue vivo):
 * 6 conjuntos / 53 preguntas ⇒ hoy un `{sets:[]}` de este tenant SOLO puede ser un fallo.
 */
function _catalogoUtilizable(data) {
  return !!(data && typeof data === 'object' && Array.isArray(data.sets) && data.sets.length > 0);
}

function _persistQuestions(key, data) {
  if (!_catalogoUtilizable(data)) return;   // ver _catalogoUtilizable: el vacío no se cachea
  _questionsCache[key] = data;
  try {
    sessionStorage.setItem(QCACHE_PREFIX + key, JSON.stringify({ data, expiresAt: Date.now() + QCACHE_TTL_MS }));
  } catch { /* quota/serialization → cache de módulo basta */ }
  // SPEC-WIZ-BROWSERCACHE: capa PERSISTENTE (sobrevive al cierre del navegador) +
  // catalog_version derivado, para servir la 2ª+ visita al instante y revalidar por
  // versión. Best-effort: quota/serialización fallan → silencioso (la cache de
  // sesión/módulo basta; comportamiento idéntico al actual).
  try {
    localStorage.setItem(QCACHE_LS_PREFIX + key, JSON.stringify({ data, v: _catalogVersion(data), storedAt: Date.now() }));
  } catch { /* quota/serialization → silencioso */ }
}

/** Purga toda la cache de preguntas (módulo + sessionStorage + localStorage persistente). Llamado por clearSession. */
export function purgeQuestionsCache() {
  for (const k in _questionsCache) delete _questionsCache[k];
  try {
    for (let i = sessionStorage.length - 1; i >= 0; i--) {
      const k = sessionStorage.key(i);
      if (k && k.indexOf(QCACHE_PREFIX) === 0) sessionStorage.removeItem(k);
    }
  } catch { /* ignore */ }
  // SPEC-WIZ-BROWSERCACHE: purga también la capa PERSISTENTE — el catálogo cacheado
  // NUNCA debe sobrevivir al ciclo de auth (espejo de la decisión de la capa de sesión).
  try {
    for (let i = localStorage.length - 1; i >= 0; i--) {
      const k = localStorage.key(i);
      if (k && k.indexOf(QCACHE_LS_PREFIX) === 0) localStorage.removeItem(k);
    }
  } catch { /* ignore */ }
}

/**
 * DL-C-A/B (g): siembra la cache del catálogo de preguntas desde la hidratación
 * consolidada (hydrate.questions ya adaptado a { sets:[…] } por el backend del wizard).
 * Análogo a primeLookups → Step5/Step7 resuelven `fetchQuestions(lang)` de cache, SIN la
 * llamada suelta de red (~42s). Idempotente; persiste a sessionStorage (sobrevive reload).
 * Si data es falsy no hace nada (cae al fetch de red como fallback).
 * @param {string} lang
 * @param {Object} data — catálogo { sets:[…] }
 */
export function primeQuestions(lang, data) {
  // `typeof data === 'object'` dejaba pasar `{sets:[]}` como catálogo bueno: era el
  // primer eslabón del apagón silencioso del cuestionario. Ver `_catalogoUtilizable`.
  if (!_catalogoUtilizable(data)) return;
  const key = lang || 'es';
  _persistQuestions(key, data);
}

function _doFetchQuestions(lang) {
  return gasCall('fetchQuestions', { context_code: 'ENROLLMENT', language: lang });
}

export function prefetchQuestions(lang) {
  const key = lang || 'es';
  if (_questionsCache[key] || _questionsFlight[key]) return;
  // SPEC-WIZ-BROWSERCACHE: catálogo persistente FRESCO → ceba el módulo sin red.
  const persisted = _readPersistedQuestions(key);
  if (persisted && (Date.now() - persisted.storedAt) < QCACHE_LS_REVALIDATE_MS) {
    _questionsCache[key] = persisted.data;
    return;
  }
  _questionsFlight[key] = _doFetchQuestions(key)
    .then(data  => { _persistQuestions(key, data); delete _questionsFlight[key]; return data; })
    .catch(_err => { delete _questionsFlight[key]; });
}

export function fetchQuestions(lang) {
  const key = lang || 'es';
  if (_questionsCache[key])  return Promise.resolve(_questionsCache[key]);
  if (_questionsFlight[key]) return _questionsFlight[key];
  // SPEC-WIZ-BROWSERCACHE: si hay catálogo persistente FRESCO (dentro de la ventana de
  // revalidación) sírvelo SIN red — 2ª visita sub-segundo, sin llamada visible en
  // DevTools Network — y ceba el módulo. Fuera de la ventana NO cortocircuita → cae al
  // fetch de red de abajo, que revalida y, vía _persistQuestions, REEMPLAZA el catálogo
  // (y su catalog_version) si el staff lo editó. readQuestionsCacheSync ya da el paint
  // instantáneo desde localStorage mientras esta revalidación corre en background.
  const persisted = _readPersistedQuestions(key);
  if (persisted && (Date.now() - persisted.storedAt) < QCACHE_LS_REVALIDATE_MS) {
    _questionsCache[key] = persisted.data;
    return Promise.resolve(persisted.data);
  }
  _questionsFlight[key] = _doFetchQuestions(key)
    .then(data  => { _persistQuestions(key, data); delete _questionsFlight[key]; return data; })
    .catch(err  => { delete _questionsFlight[key]; throw err; });
  return _questionsFlight[key];
}

import * as log from './logger';

const GAS_ENDPOINT = import.meta.env.VITE_GAS_ENDPOINT;

// ── UN SOLO SITIO AVISA DE QUE EL SERVIDOR ACEPTÓ UNA ESCRITURA ───────────────────────
// El aviso rojo «no se pudo guardar» dependía de UNA sola puerta: el final feliz de la
// cola de guardado (`WizardContext.enqueueSave`). Todo lo que persiste SIN pasar por esa
// cola dejaba el rojo encendido para siempre aunque el dato ya estuviera a salvo. MEDIDO
// contra `origin/main` el 2026-08-09 — tres caminos vivos que guardan de verdad y no la
// tocan: subir un documento (`pages/steps/Step6Documents.jsx:66`), guardar las NEAE
// (`pages/steps/Step4Health.jsx:397`) y quitar a alguien del expediente
// (`lib/quitar.js:62`). Es exactamente lo que le pasó a Diego: «si al final guarda por
// otro lado, la barra se queda».
//
// Aquí NO se decide nada: este módulo solo EMITE «el servidor aceptó una escritura».
// Qué hacer con eso lo decide el ÚNICO sitio que ya gobierna el aviso — la cola de
// guardado. Emitirlo desde el único punto por el que pasa TODO el tráfico evita repartir
// `setSaveState('idle')` por las pantallas, que es como nacen los estados que se
// contradicen.
//
// LÍMITE HONESTO: la lista es explícita. Una acción de escritura NUEVA que no se añada
// aquí simplemente no apagará el aviso — falla hacia el lado seguro (rojo de más, nunca
// verde de mentira). Las LECTURAS no entran nunca: que un hidratado funcione no dice
// absolutamente nada sobre si una escritura entra.
const ACCIONES_QUE_ESCRIBEN = new Set([
  'saveStep', 'saveResponses', 'saveNeae', 'uploadDocument', 'retirarDelExpediente',
  'saveBillingInfo', 'submitGdprConsents', 'confirmReview', 'applyPaymentModality',
  'submitEnrollmentSession', 'requestCorrection',
]);

const _oyentesEscritura = new Set();

/**
 * Suscribe un oyente a «el servidor ACEPTÓ una escritura». Devuelve la función para
 * darse de baja (pensada para usarse tal cual como limpieza de un `useEffect`).
 * @param {(action: string) => void} fn
 * @returns {() => void}
 */
export function alConfirmarEscritura(fn) {
  _oyentesEscritura.add(fn);
  return () => { _oyentesEscritura.delete(fn); };
}

/**
 * Calls the GAS backend with the given action and payload.
 * @param {string} action
 * @param {Object} payload
 * @returns {Promise<Object>} Parsed response (ok: true guaranteed, or throws)
 */
export async function gasCall(action, payload = {}) {
  if (!GAS_ENDPOINT) {
    log.error('gasCall: VITE_GAS_ENDPOINT is not configured');
    throw new Error('VITE_GAS_ENDPOINT is not configured.');
  }

  // Sanitise payload for logging (omit base64 blobs)
  const logPayload = { ...payload };
  if (logPayload.base64) logPayload.base64 = `[base64 ~${Math.round((payload.base64?.length || 0) * 0.75 / 1024)}KB]`;

  log.info(`→ GAS ${action}`, logPayload);
  log.debug(`→ GAS ${action} (raw payload keys)`, { keys: Object.keys(payload), enrollment_group_id: payload.enrollment_group_id || payload.application_id || null });

  // DBG-TRACE (Diego 2026-06-12): pedir al backend la cronología server-side de la
  // request (gates, llamadas wizard→KMS con inicio/duración, HIT/MISS de cache,
  // esperas single-flight). Vuelve como `_dbg` y se vuelca al debug log abajo.
  const body = JSON.stringify({ action, _hp: '', _dbg: true, ...payload });
  const t0   = performance.now();

  // ── UNA LLAMADA QUE NO VUELVE NO PUEDE DURAR PARA SIEMPRE (medido 2026-08-04) ─────────
  // `fetch` sin `signal` no tiene límite: si el servidor no contesta, la promesa NO se
  // resuelve NUNCA. Y eso no se queda en una llamada — la cola de guardados encadena, así
  // que una sola que no vuelve deja al navegador **guardando nada, en silencio, para
  // siempre**. Reproducido con el bundle real: servidor que no contesta una respuesta ⇒ el
  // guardado siguiente no sale en 30 s ni saldría nunca.
  //
  // El tope NO es una política de latencia: el sistema real tarda 34-48 s por llamada
  // medidos, y el propio arnés espera hasta 240 s a que cargue el cuestionario. Es una red
  // contra el caso «no vuelve»: pasado el tope se ABORTA y el error entra por el camino que
  // ya existe (la cola marca `error` y ofrece «Reintentar»), en vez de quedarse colgado.
  // Reintentar es seguro: las escrituras del KMS usan claves deterministas, así que repetir
  // cae en la misma fila.
  const TOPE_MS = 240000;
  const abortador = (typeof AbortController !== 'undefined') ? new AbortController() : null;
  const corte = abortador ? setTimeout(() => abortador.abort(), TOPE_MS) : null;
  let res;
  try {
    res = await fetch(GAS_ENDPOINT, {
      method:  'POST',
      headers: { 'Content-Type': 'text/plain' }, // avoid CORS preflight on GAS
      body,
      ...(abortador ? { signal: abortador.signal } : {}),
    });
  } catch (fetchErr) {
    const abortada = fetchErr && (fetchErr.name === 'AbortError' || /abort/i.test(fetchErr.message || ''));
    if (abortada) {
      log.error(`gasCall ${action}: sin respuesta en ${TOPE_MS} ms — se corta`, { action });
      const e = new Error(`El servidor no respondió a "${action}". Vuelve a intentarlo.`);
      e.code = 'SIN_RESPUESTA';
      throw e;
    }
    log.error(`gasCall ${action}: network/fetch error`, { message: fetchErr.message });
    throw fetchErr;
  } finally {
    if (corte) clearTimeout(corte);
  }

  const elapsed = Math.round(performance.now() - t0);
  log.info(`← HTTP ${res.status} (${elapsed}ms) for ${action}`);

  if (!res.ok) {
    log.error(`gasCall ${action}: HTTP ${res.status}`, { status: res.status, statusText: res.statusText });
    throw new Error('Network error: ' + res.status);
  }

  let data;
  try {
    data = await res.json();
  } catch (jsonErr) {
    log.error(`gasCall ${action}: failed to parse JSON response`, { message: jsonErr.message });
    throw new Error('Invalid JSON response from server');
  }

  // DBG-TRACE: cronología server-side → debug log. Formato compacto: cada evento
  // "t+<ms> <tipo> <detalle>" — permite ver cuándo el backend recibió, cuándo llamó
  // al KMS, cuándo contestó el KMS, y de dónde salió cada dato (cache/vivo/espera).
  if (data && data._dbg) {
    try {
      log.info(`[SRV ${action}] server_ms=${data._dbg.server_ms} recibido=${data._dbg.received_at}`, {
        events: (data._dbg.events || []).map(ev => `t+${ev.t}ms ${ev.e}${ev.d ? ' ' + ev.d : ''}`),
      });
    } catch (eDbg) { /* best-effort */ }
  }

  if (!data.ok) {
    log.error(`gasCall ${action}: server returned ok=false`, { error: data.error, full: data });
    // data.error may be a string (err.message) or a structured object {code, message}
    // (NOT_EDITABLE, KMS_NOT_CONFIGURED, FORBIDDEN, …). Normalize so Error.message is
    // human-readable instead of "[object Object]" (M1 readiness-2026-06-03).
    const msg = (data.error && typeof data.error === 'object')
      ? (data.error.message || data.error.code)
      : data.error;
    const err = new Error(msg || 'Unknown server error');
    // Preserve the structured error code (STEPUP_REQUIRED, NOT_EDITABLE,
    // TOO_MANY_ATTEMPTS, RATE_LIMITED, …) on the Error so callers can branch on
    // err.code without string-matching the human-readable message. The message
    // already collapses code→message for display; this keeps the machine code too.
    if (data.error && typeof data.error === 'object' && data.error.code) {
      err.code = data.error.code;
    }
    throw err;
  }

  log.success(`✓ ${action} OK`, data);
  log.debug(`← GAS ${action} (full response)`, data);
  // El servidor aceptó una ESCRITURA: se avisa, no se decide (ver el bloque de arriba).
  // Un oyente que reviente no puede tumbar el guardado que acaba de ir bien.
  if (ACCIONES_QUE_ESCRIBEN.has(action) && _oyentesEscritura.size) {
    for (const fn of _oyentesEscritura) {
      try { fn(action); } catch (eOyente) { log.warn('alConfirmarEscritura: oyente falló', { message: eOyente && eOyente.message }); }
    }
  }
  return data;
}
