/**
 * ②2 + ②12 + ②26 — LAS CINCO PUERTAS del asistente alcanzables desde internet.
 *
 * CUATRO son anónimas por diseño y pasan TODAS por UNA SOLA verja, que existe una vez y
 * falla hacia cerrado. LA QUINTA no debe ser anónima: exige el token de recuperación.
 *
 * LA QUINTA (②26, 2026-08-10): la rama por identificador de expediente de `sendMagicLink_`
 * —«Guardar y seguir luego»— no tenía ni verja ni credencial: solo comprobaba que el
 * identificador tuviera forma de UUID, y el identificador lo reparte el propio sistema
 * (`initEnrollmentSession` lo devuelve a cambio de un reCAPTCHA). Con él, cualquiera podía
 * hasta 5 veces por hora bombardear el buzón de esa familia, ROTAR su enlace vivo bajo los
 * pies de quien estuviera rellenando la solicitud, y agotarle el cupo (⇒ su recuperación
 * legítima de esa hora se rechaza). El token NO se filtra en la respuesta ⇒ no había toma
 * de control. La puerta correcta aquí NO es la verja sino el TOKEN: esta acción se llama
 * desde DENTRO del asistente, donde el token ya existe, así que exigirlo no le quita nada a
 * ninguna familia — y KAL-4 manda derivar el expediente del token, nunca del cuerpo.
 *
 * LA CUARTA (②12, 2026-08-09): la rama de alta de `sendVerificationCode_` manda un
 * código de un solo uso al correo que venga en el propio cuerpo de la petición, y
 * estaba sin verja — solo con cupo por-correo. Alcanzable desde internet sin
 * identificarse (`case 'sendVerificationCode'`, manifest ANYONE_ANONYMOUS) ⇒
 * bombardeo de correo a buzones ajenos y coste de reputación del remitente. No es
 * oráculo de existencia: el llamante ya conoce un identificador de grupo. La rama
 * step-up NO lleva verja a propósito (deriva grupo y correo del bearer, KAL-4, y su
 * cliente no manda token de reCAPTCHA) — y este control lo AFIRMA, para que nadie
 * se la ponga «por simetría» y rompa la comprobación de identidad de las familias.
 *
 * QUÉ DEFECTO VIGILA, y está MEDIDO (2026-08-09, contra `origin/main`):
 * `sendMagicLink_` —la puerta de recuperación, pública y anónima— devolvía desde el
 * 2026-07-27 la MISMA respuesta existiera o no la familia (WIZ-ENUM). Pero **el tiempo
 * no era el mismo**: con expediente hace dos viajes al KMS (renovar el enlace + mandar
 * el correo) y tarda ~46 s; sin expediente se queda en ~7 s. Cronometrando, cualquiera
 * con internet volvía a preguntar «¿esta familia está matriculando?» email a email —
 * exactamente lo que el ack constante vino a cerrar. Las otras dos entradas públicas
 * (`initEnrollmentSession_` y `recognizeFamily_`) sí tenían verja; ésta no.
 *
 * POR QUÉ SE CIERRA ASÍ Y NO IGUALANDO TIEMPOS: igualar obliga a retener cada petición
 * ~50 s, y Apps Script limita las ejecuciones simultáneas ⇒ unas pocas peticiones
 * dejarían la única puerta pública de admisiones sin atender. Sería cambiar un oráculo
 * por una caída. Se quita el trabajo caro del camino de quien no pasa la verja.
 *
 * QUÉ AFIRMA (tres cosas, y las tres sobre el CÓDIGO REAL):
 *   (a) EJECUTA el veredicto real extraído del fuente, con 6 casos, incluidas las tres
 *       formas de fallar hacia cerrado. No repite su lógica: la corre.
 *   (b) las cuatro entradas anónimas lo invocan; en la de recuperación se invoca ANTES
 *       del primer viaje a AppSheet y NO lanza (un rechazo visible sería otro oráculo);
 *       y en la del código de un solo uso se invoca en la rama de alta, ANTES del cupo
 *       y de cualquier viaje, y NO en la rama step-up.
 *   (c) la quinta —«Guardar y seguir luego»— EXIGE el token de recuperación, lo exige
 *       ANTES del cupo y del trabajo caro, y `sendMagicLink_` ya NO lee el identificador
 *       del expediente del cuerpo de la petición (si lo leyera, la puerta seguiría abierta).
 *
 * LÍMITE DECLARADO, igual que en `escrituras-directas.mjs`: es un detector por líneas,
 * no un analizador sintáctico. Un alias de la función o un `eval()` serían invisibles.
 * Y **no afirma que Google puntúe bien** — eso solo lo dice reCAPTCHA en ejecución.
 */

/** Extrae el cuerpo de una función de nivel superior (su `}` va en la columna 0). */
function cuerpoDe(fuente, nombre) {
  const re = new RegExp('function ' + nombre + '\\s*\\([^)]*\\)\\s*\\{([\\s\\S]*?)\\n\\}')
  const m = re.exec(fuente)
  return m ? m[1] : null
}

/** Quita los comentarios de línea y de bloque para que no cuenten como código. */
function sinComentarios(fuente) {
  return fuente
    .split('\n')
    .map((l) => l.replace(/^\s*\/\/.*$/, '').replace(/^\s*\*.*$/, '').replace(/^\s*\/\*.*$/, ''))
    .join('\n')
}

/**
 * (a) Ejecuta el veredicto REAL con dobles de `PropertiesService` y `verifyRecaptcha_`.
 * @returns {string[]} fallos
 */
function ejecutarVeredictoReal(fuenteLimpia) {
  const cuerpo = cuerpoDe(fuenteLimpia, '_verjaPublicaVeredicto_')
  if (cuerpo === null) {
    return ['no se encontró `_verjaPublicaVeredicto_` — el control está CIEGO: verde aquí NO equivale a comprobado']
  }
  const fallos = []
  const hacer = (secreto, token, respuesta) => {
    const fn = new Function('PropertiesService', 'verifyRecaptcha_', 'recaptchaToken', cuerpo)
    const props = { getScriptProperties: () => ({ getProperty: (k) => (k === 'RECAPTCHA_SECRET' ? secreto : null) }) }
    const verify = () => {
      if (respuesta instanceof Error) throw respuesta
      return respuesta
    }
    return fn(props, verify, token)
  }

  const casos = [
    // [qué, secreto, token, lo que responde Google, se espera ok]
    ['sin RECAPTCHA_SECRET configurado NO pasa', null, 'tok', { pass: true }, false],
    ['con el secreto vacío NO pasa', '', 'tok', { pass: true }, false],
    ['sin token del cliente NO pasa', 'sec', null, { pass: true }, false],
    ['si Google no da por buena la puntuación NO pasa', 'sec', 'tok', { success: true, score: 0.1, pass: false }, false],
    ['si falla la red al verificar NO pasa', 'sec', 'tok', new Error('red caída'), false],
    ['con secreto, token y puntuación buena SÍ pasa', 'sec', 'tok', { success: true, score: 0.9, pass: true }, true],
  ]
  for (const [queEs, secreto, token, respuesta, esperado] of casos) {
    let v
    try {
      v = hacer(secreto, token, respuesta)
    } catch (e) {
      fallos.push(`${queEs}: el veredicto LANZÓ (${e && e.message}) — tiene que devolver un veredicto, no lanzar`)
      continue
    }
    if (!v || typeof v.ok !== 'boolean') {
      fallos.push(`${queEs}: el veredicto no devuelve \`ok\` booleano`)
      continue
    }
    if (v.ok !== esperado) fallos.push(`${queEs}: devolvió ok=${v.ok}`)
    if (!v.ok && !v.code) fallos.push(`${queEs}: rechaza sin decir por qué (falta \`code\`)`)
  }
  return fallos
}

/**
 * 4 · el código de un solo uso (`sendVerificationCode_`): la rama de ALTA pasa por la
 * verja, antes del cupo y de cualquier viaje; la rama step-up NO la lleva.
 * @returns {string[]} fallos
 */
function comprobarCodigoDeUnSoloUso(fuenteLimpia) {
  const fallos = []
  const cuerpo = cuerpoDe(fuenteLimpia, 'sendVerificationCode_')
  if (cuerpo === null) {
    return ['no se encontró `sendVerificationCode_` — control CIEGO en la entrada del código de un solo uso']
  }

  // El manejador se parte en dos ramas: `if (p && p.stepup === true) { … } else { … }`.
  const iIf = cuerpo.search(/if\s*\(p\s*&&\s*p\.stepup\s*===\s*true\)/)
  const mElse = /\n\s*\}\s*else\s*\{/.exec(iIf >= 0 ? cuerpo.slice(iIf) : '')
  if (iIf < 0 || !mElse) {
    return ['no se distinguen las ramas step-up / alta de `sendVerificationCode_` — control CIEGO: verde aquí NO equivale a comprobado']
  }
  const ramaStepUp = cuerpo.slice(iIf, iIf + mElse.index)
  const ramaAlta = cuerpo.slice(iIf + mElse.index + mElse[0].length)

  // (i) La rama de alta pasa por la verja, y con la forma que BLOQUEA: pedir el
  //     veredicto y no actuar sobre él sería un no-op silencioso. Este manejador
  //     propaga el error al cliente y no hay oráculo de existencia que proteger.
  const iVerja = ramaAlta.search(/_asegurarVerjaPublica_\s*\(/)
  if (iVerja < 0) {
    fallos.push('la rama de ALTA de `sendVerificationCode_` NO pasa por la verja (`_asegurarVerjaPublica_`) — es el hueco de ②12: un código de un solo uso a un correo arbitrario')
  } else {
    // (ii) ANTES del cupo y de cualquier viaje: rechazar tarde deja que un sondeo
    //      agote el cupo de enlaces de una familia real, y gasta trabajo.
    const iCaro = ramaAlta.search(/_checkMagicLinkRateLimit_|appsheetRequest_|appsheetRequestBatch_|kmsProxy_|sendViaKms/)
    if (iCaro >= 0 && iCaro < iVerja) {
      fallos.push('en `sendVerificationCode_` el cupo o el trabajo caro ocurren ANTES de la verja — un sondeo sin token puede agotarle el cupo a una familia real')
    }
  }

  // (iii) La rama step-up NO lleva verja: su cliente (`StepUpGate`/`StepUpReverify`)
  //       no manda token de reCAPTCHA y deriva grupo y correo del bearer (KAL-4).
  //       Ponérsela «por simetría» rompería la comprobación de identidad.
  if (/_asegurarVerjaPublica_\s*\(|_verjaPublicaVeredicto_\s*\(/.test(ramaStepUp)) {
    fallos.push('la rama STEP-UP de `sendVerificationCode_` tiene verja — su cliente no manda token de reCAPTCHA: eso rompe la comprobación de identidad de las familias')
  }
  return fallos
}

/**
 * 5 · «Guardar y seguir luego» (`sendMagicLink_`, rama interna): NO es anónima — exige el
 * token de recuperación, y el expediente se deriva de él (KAL-4), nunca del cuerpo.
 * @returns {string[]} fallos
 */
function comprobarGuardarYSeguirLuego(fuenteLimpia) {
  const fallos = []
  const cuerpo = cuerpoDe(fuenteLimpia, 'sendMagicLink_')
  if (cuerpo === null) {
    return ['no se encontró `sendMagicLink_` — control CIEGO en la quinta puerta («Guardar y seguir luego»): verde aquí NO equivale a comprobado']
  }

  // (i) El expediente NO puede salir del cuerpo de la petición: es lo que hacía que esta
  //     puerta fuese alcanzable por cualquiera con un identificador que el sistema regala.
  if (/\bp\.(enrollment_group_id|application_id)\b/.test(cuerpo)) {
    fallos.push('`sendMagicLink_` lee el identificador del expediente del cuerpo de la petición (`p.enrollment_group_id`/`p.application_id`) — la quinta puerta sigue abierta (②26, KAL-4)')
  }

  // (ii) La rama interna se distingue por el token. Si no se distingue, no se puede medir.
  const iInterna = cuerpo.search(/if\s*\(p\s*&&\s*p\.resume_token\)/)
  if (iInterna < 0) {
    fallos.push('no se distingue la rama interna de `sendMagicLink_` por el `resume_token` — control CIEGO en la quinta puerta')
    return fallos
  }
  const iPublica = cuerpo.search(/else if \(p\.primary_email\)/)
  const ramaInterna = cuerpo.slice(iInterna, iPublica > iInterna ? iPublica : cuerpo.length)

  // (iii) En su forma VIVA: el memo de lectura tolera hasta 5 min de desfase, y esta rama
  //       ROTA el token — el propio memo lo prohíbe para mutaciones. Se mira ANTES que la
  //       presencia del gate para que el motivo sea el de verdad y no «falta el gate».
  if (/requireResumeTokenMemo_\s*\(/.test(ramaInterna)) {
    fallos.push('la rama «Guardar y seguir luego» usa el memo de LECTURA del gate (`requireResumeTokenMemo_`) — esta rama ROTA el token, así que tiene que validar SIEMPRE en vivo')
    return fallos
  }

  // (iv) Exige el token con el gate canónico KAL-4.
  const iGate = ramaInterna.search(/requireResumeToken_\s*\(/)
  if (iGate < 0) {
    fallos.push('la rama «Guardar y seguir luego» de `sendMagicLink_` NO exige el token de recuperación (`requireResumeToken_`) — es el hueco de ②26: rotar el enlace y bombardear el buzón de una familia ajena')
    return fallos
  }

  // (v) ANTES del cupo y del trabajo caro: quien no trae llave no debe poder gastar
  //     trabajo ni consumirle el cupo de recuperación a una familia real.
  const iCaro = ramaInterna.search(/_checkMagicLinkRateLimit_|appsheetRequest_|appsheetRequestBatch_|kmsProxy_|sendViaKms/)
  if (iCaro >= 0 && iCaro < iGate) {
    fallos.push('en «Guardar y seguir luego» el cupo o el trabajo caro ocurren ANTES de exigir el token — un sondeo sin llave puede gastarle el cupo a una familia real')
  }
  return fallos
}

/**
 * ②27 — PARIDAD DE PUERTAS: destruir y enviar no pueden exigir MENOS que corregir.
 *
 * EL DEFECTO QUE VIGILA, medido contra `origin/main` el 2026-08-10. Ocho manejadores de
 * mutación pedían el código de un solo uso (`assertStepUpFresh_`) y TRES no:
 *   · `retirarDelExpediente_` llevaba SOLO el token ⇒ con un token observado se podían
 *     borrar personas, correos, teléfonos, vínculos y documentos —hasta 50 por llamada—
 *     sin acreditar el buzón, mientras que cambiar una letra de un nombre sí lo pedía. Y
 *     la familia no puede deshacerlo.
 *   · `submitEnrollmentSession_` llevaba token + expediente editable, y no el código —
 *     siendo el acto que estampa el envío, cambia la situación del expediente y escribe N
 *     filas del libro de consentimientos ATRIBUIDAS A UN TUTOR REAL.
 *   · `applyPaymentModality_` (dinero: re-deriva el plan de pagos entero) no lo pedía, a
 *     diferencia de `saveBillingInfo_`, su hermano de la MISMA pantalla.
 *
 * QUÉ AFIRMA, sobre el código real:
 *   (i)  cada manejador de la lista invoca `assertStepUpFresh_`;
 *   (ii) lo invoca DESPUÉS de derivar el expediente del bearer (`requireResumeToken_` /
 *        `requireSignerIdentity_`) — un gate por delante estaría midiendo un expediente
 *        que no viene del token, que es justo lo que KAL-4 prohíbe;
 *   (iii) lo invoca ANTES del trabajo caro (viaje al KMS o a AppSheet) — rechazar después
 *        de haber escrito no es una puerta, es un parte de daños.
 *
 * QUÉ **NO** AFIRMA: que la ventana de 10 min sea correcta, ni que la marca sea del buzón
 * que opera (eso es ②24 y vive en `_isStepUpFresh_`), ni que el KMS re-valide. Y arrastra
 * el LÍMITE del módulo: detector por líneas, no analizador sintáctico.
 *
 * LAS EXENCIONES VAN DECLARADAS CON SU MOTIVO ESCRITO, porque una lista sin motivos se
 * convierte en el sitio donde se esconde el siguiente hueco.
 */
function comprobarParidadDelCodigo(fuenteLimpia) {
  const fallos = []

  // Manejadores de mutación que DEBEN exigir el código de un solo uso, y de qué gate de
  // identidad derivan el expediente (el código va DESPUÉS de él).
  const OBLIGADOS = [
    ['saveStep_',                'requireResumeToken_'],
    ['saveNeae_',                'requireResumeToken_'],
    ['saveResponses_',           'requireResumeToken_'],
    ['uploadDocument_',          'requireResumeToken_'],
    ['submitEnrollmentSession_', 'requireResumeToken_'],   // ②27
    ['retirarDelExpediente_',    'requireResumeToken_'],   // ②27
    // DL-E49 §4/§9 — «avisar al otro tutor» MANDA UN ENLACE DE ACCESO a la solicitud: con
    // un token observado y sin el código de un solo uso se podría colar a un tercero en
    // silencio, y la familia no se enteraría. Pide lo mismo que corregir una letra.
    ['avisarATutor_',            'requireResumeToken_'],
    // ⭐ 0º.vicies.sexies (2026-08-21) — `guardarModalidadPreferida_` estaba AQUÍ y se
    // RETIRÓ ENTERO, por decisión de Diego: la presentación de pagos del paso 7 es
    // meramente informativa, así que la marca de la tarjeta vive solo en el navegador y ya
    // no hay escritura que gatear. Se quita de la lista porque un obligado que no existe
    // deja el control MIDIENDO EL AIRE: pasaría en verde sin comprobar nada.
    // ⛔ NO confundirlo con `applyPaymentModality_` (más abajo, con su gate de firmante):
    // ésa es la elección EN FIRME del paso 8, es dinero, se firma, y sigue obligada.
    // 2026-08-20 · «sigo aquí» — reinicia el contador de los 10 min de inactividad. Es
    // una escritura sobre la propia marca del código de un solo uso, así que va por la
    // MISMA puerta que todo lo demás: primero el expediente del bearer (KAL-4), luego el
    // código. Y su handler EXTIENDE, jamás CREA — eso lo mide `manual_testStepUpGate`
    // (casos e/f/g), no este control, que solo afirma el ORDEN de las puertas.
    ['refrescarVentanaDeInactividad_', 'requireResumeToken_'],
    ['saveBillingInfo_',         'requireSignerIdentity_'],
    ['applyPaymentModality_',    'requireSignerIdentity_'], // ②27
    ['submitGdprConsents_',      'requireSignerIdentity_'],
    ['confirmReview_',           'requireSignerIdentity_'],
    ['initiateSigningSession_',  'requireSignerIdentity_'],
  ]

  // EXENTOS, con el motivo escrito (medidos el 2026-08-10):
  //   · `requestCorrection_`  — no toca ni un dato de la familia: completa UNA MARCA que
  //     dice que la familia pidió corregir. Exigirle el código sería poner un candado a
  //     una petición de ayuda, y su daño si se abusa es una marca de más.
  //   · `abandonSession_`     — es «empezar de nuevo», un gesto de la propia familia sobre
  //     una solicitud que aún NO ha enviado (el propio manejador rechaza las enviadas), y
  //     es el camino por el que se sale de una sesión equivocada.
  //   · `reportUnsolicited_`  — «esto no es mío», pulsado desde el correo por alguien que
  //     por definición NO controla el buzón del expediente. Pedirle el código sería pedirle
  //     justo lo que dice no tener.
  //   · `sendVerificationCode_` / `verifyEmail_` — SON el código; gatearlos consigo mismos
  //     dejaría a toda familia con la ventana caducada fuera para siempre.

  for (const [nombre, gateDeIdentidad] of OBLIGADOS) {
    const cuerpo = cuerpoDe(fuenteLimpia, nombre)
    if (cuerpo === null) {
      fallos.push(`no se encontró \`${nombre}\` — control CIEGO en la paridad de puertas (②27): verde aquí NO equivale a comprobado`)
      continue
    }
    const iCodigo = cuerpo.search(/assertStepUpFresh_\s*\(/)
    if (iCodigo < 0) {
      fallos.push(`\`${nombre}\` NO exige el código de un solo uso (\`assertStepUpFresh_\`) — es el hueco de ②27: destruir o enviar pidiendo menos que corregir`)
      continue
    }
    const iIdentidad = cuerpo.search(new RegExp(gateDeIdentidad + '\\s*\\('))
    if (iIdentidad < 0) {
      fallos.push(`\`${nombre}\` no deriva el expediente con \`${gateDeIdentidad}\` — sin eso el código de un solo uso mide un expediente que no viene del token (KAL-4)`)
      continue
    }
    if (iCodigo < iIdentidad) {
      fallos.push(`en \`${nombre}\` el código de un solo uso se exige ANTES de derivar el expediente del token — el expediente medido no vendría del bearer (KAL-4)`)
    }
    const iCaro = cuerpo.search(/kmsProxy_\s*\(|appsheetRequest_\s*\(|appsheetRequestBatch_\s*\(/)
    if (iCaro >= 0 && iCaro < iCodigo) {
      fallos.push(`en \`${nombre}\` el trabajo caro (KMS/AppSheet) ocurre ANTES de exigir el código de un solo uso — rechazar después de escribir no es una puerta`)
    }
  }
  return fallos
}

/** (b) Las tres entradas de la puerta de admisiones pasan por la verja. */
function comprobarLasEntradasDeAdmisiones(fuenteLimpia) {
  const fallos = []

  // La verja se declara UNA sola vez. Dos copias divergen — que es como nació el hueco.
  const nDecl = (fuenteLimpia.match(/function _verjaPublicaVeredicto_/g) || []).length
  if (nDecl !== 1) fallos.push(`se esperaba UNA declaración de \`_verjaPublicaVeredicto_\`, hay ${nDecl}`)

  // Nadie DECIDE por su cuenta si una llamada anónima pasa: la verja es el único sitio.
  // Se cuentan las invocaciones de `verifyRecaptcha_` fuera de ella.
  //
  // EXENCIÓN DECLARADA, con su motivo escrito (una sola, medida el 2026-08-09):
  //   `case 'verifyRecaptcha':` del despachador — NO es una verja, es el verificador
  //   crudo expuesto como acción, y tiene consumidor vivo: `Step7Review.jsx:259` lo
  //   llama antes de enviar la solicitud. Si alguien lo retira, esta cuenta lo dirá.
  const EXENTAS = [/case 'verifyRecaptcha':/]
  const cuerpoVerja = cuerpoDe(fuenteLimpia, '_verjaPublicaVeredicto_') || ''
  const lineasConUso = fuenteLimpia
    .split('\n')
    .filter((l) => /verifyRecaptcha_\s*\(/.test(l) && !/function verifyRecaptcha_/.test(l))
  const fueraDeLaVerja = lineasConUso.filter(
    (l) => !cuerpoVerja.includes(l) && !EXENTAS.some((re) => re.test(l))
  )
  if (fueraDeLaVerja.length) {
    fallos.push(`\`verifyRecaptcha_\` se invoca ${fueraDeLaVerja.length} vez(ces) fuera de la verja y sin exención declarada — la decisión tiene que estar en UN solo sitio`)
  }

  // 1 · crear una solicitud (rama WEB_PUBLIC).
  const init = cuerpoDe(fuenteLimpia, 'initEnrollmentSession_')
  if (init === null) fallos.push('no se encontró `initEnrollmentSession_` — control CIEGO en esa entrada')
  else if (!/_asegurarVerjaPublica_|_verjaPublicaVeredicto_/.test(init)) {
    fallos.push('`initEnrollmentSession_` no pasa por la verja')
  }

  // 2 · reconocer a la familia (llamada pública, no la interna).
  const rec = cuerpoDe(fuenteLimpia, 'recognizeFamily_')
  if (rec === null) fallos.push('no se encontró `recognizeFamily_` — control CIEGO en esa entrada')
  else {
    if (!/_asegurarVerjaPublica_|_verjaPublicaVeredicto_/.test(rec)) {
      fallos.push('`recognizeFamily_` no pasa por la verja')
    }
    // Y el camino PÚBLICO corta ANTES de consultar nada (②17). La respuesta a un llamante
    // público es constante desde KAL-10; lo que faltaba era que el RELOJ también lo fuera:
    // una consulta que ENCUENTRA cuesta más que una que no (con personas eran DOS lecturas,
    // sin ellas una), así que consultar y luego devolver el ack dejaba medible lo que el ack
    // esconde. Es el mismo oráculo por tiempo que se cerró en `sendMagicLink_` (②2).
    const iAck = rec.search(/return\s*\{\s*matched:\s*false\s*,\s*persons:\s*\[\s*\]\s*\}/)
    const iCaro = rec.search(/appsheetRequest_\s*\(|appsheetRequestBatch_\s*\(|kmsProxy_\s*\(/)
    if (iAck < 0) {
      fallos.push('`recognizeFamily_` ya no devuelve el ack constante `{matched:false, persons:[]}` — KAL-10 roto')
    } else if (iCaro >= 0 && iCaro < iAck) {
      fallos.push('en `recognizeFamily_` la consulta (AppSheet/KMS) ocurre ANTES del ack constante del camino público — el reloj vuelve a delatar si el correo existe')
    }
    // Y no vuelve a leer las tablas MAESTRAS de personas del colegio con la credencial de
    // AppSheet: ese reconocimiento se lo sirve el KMS (②17, tramo «reconocer a la familia»).
    if (/appsheetRequest_\s*\(\s*'contactEmails'|appsheetRequest_\s*\(\s*'personalData_S'/.test(rec)) {
      fallos.push('`recognizeFamily_` vuelve a leer `contactEmails`/`personalData_S` directamente de AppSheet — eso es lo que ②17 quitó')
    }
  }

  // 3 · recuperar el enlace — la que faltaba, y la que además NO puede lanzar.
  const magic = cuerpoDe(fuenteLimpia, 'sendMagicLink_')
  if (magic === null) {
    fallos.push('no se encontró `sendMagicLink_` — control CIEGO justo en la entrada que motivó este control')
    return fallos
  }
  const iVerja = magic.search(/_verjaPublicaVeredicto_\s*\(/)
  if (iVerja < 0) {
    fallos.push('la rama pública de `sendMagicLink_` NO pasa por la verja — es el hueco de ②2')
  } else {
    // ANTES del primer viaje a AppSheet de la rama pública: si el trabajo caro ya se
    // hizo, el tiempo vuelve a delatar aunque después se rechace.
    const ramaPublica = magic.slice(magic.search(/else if \(p\.primary_email\)/) >= 0 ? magic.search(/else if \(p\.primary_email\)/) : 0)
    const jVerja = ramaPublica.search(/_verjaPublicaVeredicto_\s*\(/)
    const jCaro = ramaPublica.search(/appsheetRequest_|appsheetRequestBatch_|findOpenGroupsByGuardianEmail_|kmsProxy_|initEnrollmentSession_/)
    if (jVerja < 0) fallos.push('la verja no está DENTRO de la rama pública de `sendMagicLink_`')
    else if (jCaro >= 0 && jCaro < jVerja) {
      fallos.push('en `sendMagicLink_` el trabajo caro (AppSheet/KMS) ocurre ANTES de la verja — el tiempo sigue delatando')
    }
    // Y el rechazo NO puede ser visible: tiene que devolver el mismo ack constante.
    const tras = magic.slice(iVerja, iVerja + 700)
    if (!/_magicLinkConstantAck_\s*\(/.test(tras)) {
      fallos.push('el rechazo de la verja en `sendMagicLink_` no devuelve el ack constante — un rechazo visible es otro oráculo')
    }
    if (/\bthrow\b/.test(tras.split('_magicLinkConstantAck_')[0] || '')) {
      fallos.push('el rechazo de la verja en `sendMagicLink_` LANZA — sería distinguible de un éxito')
    }
  }
  return fallos
}

/**
 * ②17, tramo «los documentos de la familia» — subir y ver un documento ya no lee AppSheet.
 *
 * Las tres lecturas que se movieron al KMS eran GUARDAS: (a) ¿el expediente de alumno al
 * que se cuelga el documento es de esta familia?, (b) ¿este mismo envío ya se guardó?, y
 * (c) ¿este documento está en el expediente del token? Las tres vivían aquí y necesitaban
 * la credencial de AppSheet de la aplicación entera, que alcanza CUALQUIER tabla.
 *
 * Lo que se afirma es lo observable en el fuente: los dos manejadores **no vuelven a leer**
 * `enrEnrollments` ni `recFiles` de AppSheet, y **sí** preguntan al KMS. Un manejador que
 * no se encuentre deja el control CIEGO y eso es ROJO, no verde.
 *
 * Lo que NO se afirma, y se dice: que el KMS conteste lo correcto. Eso no se lee aquí — se
 * mide contra el manejador del KMS, como se hizo con los tramos anteriores.
 */
function comprobarLosDocumentosDeLaFamilia(fuenteLimpia) {
  const fallos = []

  const casos = [
    {
      fn: 'uploadDocument_',
      tablas: /appsheetRequest_\s*\(\s*T\.ENROLLMENTS|appsheetRequest_\s*\(\s*T\.REC_FILES|appsheetRequest_\s*\(\s*'enrEnrollments'|appsheetRequest_\s*\(\s*'recFiles'/,
      pregunta: /kmsProxy_\s*\(\s*'enr\.wizardComprobarSubida'/,
      queEs: 'las dos comprobaciones previas a subir (el expediente de destino y el envío ya guardado)',
    },
    {
      fn: 'getDocument_',
      tablas: /appsheetRequest_\s*\(\s*T\.REC_FILES|appsheetRequest_\s*\(\s*'recFiles'/,
      pregunta: /_ficheroDelExpediente_\s*\(/,
      queEs: 'la guarda de IDOR que decide si el documento es de este expediente',
    },
  ]

  for (const c of casos) {
    const cuerpo = cuerpoDe(fuenteLimpia, c.fn)
    if (cuerpo === null) {
      fallos.push(`no se encontró \`${c.fn}\` — control CIEGO en ${c.queEs}`)
      continue
    }
    if (c.tablas.test(cuerpo)) {
      fallos.push(`\`${c.fn}\` vuelve a leer \`enrEnrollments\`/\`recFiles\` directamente de AppSheet — eso es lo que ②17 quitó (${c.queEs})`)
    }
    if (!c.pregunta.test(cuerpo)) {
      fallos.push(`\`${c.fn}\` ya no le pide al KMS ${c.queEs} — o se quitó la comprobación, o volvió a hacerse contra AppSheet`)
    }
  }

  // Y el ayudante que sirve la guarda de `getDocument_` tiene que seguir distinguiendo «no
  // está» de «no se pudo preguntar»: colapsarlas haría que un fallo pasajero le contestara
  // «no es tuyo» a la familia dueña del documento.
  const ayudante = cuerpoDe(fuenteLimpia, '_ficheroDelExpediente_')
  if (ayudante === null) {
    fallos.push('no se encontró `_ficheroDelExpediente_` — control CIEGO en la guarda de IDOR de los documentos')
  } else if (!/ok:\s*false/.test(ayudante)) {
    fallos.push('`_ficheroDelExpediente_` ya no distingue «no se pudo preguntar» de «no está» — un fallo pasajero le diría «no es tuyo» a la familia dueña del documento')
  }

  return fallos
}

/**
 * ②17 — la hidratación de entrada tiene UN SOLO lector, y está en el KMS.
 *
 * `resumeSession` era una SEGUNDA hidratación completa: leía ~24 tablas de AppSheet
 * directamente —salud, alergias, dieta y NEAE de menores incluidas— desde este proceso
 * público y anónimo. El frontal dejó de llamarla cuando el camino vivo pasó a ser
 * `hydrateSession` → KMS, pero el manejador siguió registrado en el despachador y su
 * precalentado ejecutaba esas lecturas en CADA envío de enlace. Se retiró entera.
 *
 * Lo que se afirma aquí es que NO VUELVE: ni la acción en el despachador, ni un segundo
 * lector de la hidratación en este repositorio. Y se ancla en lo que SÍ debe existir
 * —`hydrateSession_` pidiéndoselo al KMS— para que el control no pueda quedarse ciego.
 */
function comprobarLaHidratacionDeEntrada(fuenteLimpia) {
  const fallos = []

  if (/case\s+'resumeSession'\s*:/.test(fuenteLimpia)) {
    fallos.push('`resumeSession` vuelve a estar en el despachador público — era una segunda ' +
      'hidratación que leía ~24 tablas de AppSheet (salud, alergias, dieta y NEAE de menores) ' +
      'desde el proceso anónimo; el camino vivo es `hydrateSession` → KMS')
  }

  for (const muerta of ['buildResumeSessionData_', '_warmResumePhase_']) {
    if (new RegExp('function\\s+' + muerta + '\\s*\\(').test(fuenteLimpia)) {
      fallos.push('`' + muerta + '` ha vuelto — es el segundo lector de la hidratación que ②17 ' +
        'retiró; dos lectores del mismo dato divergen, y este leía AppSheet directamente')
    }
  }

  // El ancla: si el camino vivo desaparece o deja de preguntarle al KMS, este control estaría
  // afirmando la ausencia de algo en un fichero que ya no es el que cree estar midiendo.
  const vivo = cuerpoDe(fuenteLimpia, 'hydrateSession_')
  if (vivo === null) {
    fallos.push('no se encontró `hydrateSession_` — control CIEGO en la hidratación de entrada')
  } else if (!/kmsProxy_\s*\(\s*'enr\.wizardHydrate'/.test(fuenteLimpia)) {
    fallos.push('la hidratación de entrada ya no le pide los datos al KMS (`enr.wizardHydrate`) — ' +
      'o volvió a leer AppSheet por su cuenta, o el camino vivo cambió de nombre')
  }

  return fallos
}

/**
 * ②17 — el ENVÍO no lee AppSheet para validarse, y la isla muerta no vuelve.
 *
 * `submitEnrollmentSession_` hacía OCHO lecturas directas. Tres de ellas no las leía
 * nadie: dos estaban tras una guarda que nunca se cumplía, y la tercera —las respuestas
 * de profesión, empleador y adaptación— SÍ se ejecutaba en cada envío y su resultado se
 * descartaba. Esa tercera, además, corría DESPUÉS de que el KMS ya hubiera materializado
 * el expediente y fuera de todo `try`: un fallo suyo dejaba a la familia medio enviada y
 * atascada contra `NOT_EDITABLE`. Las otras tres vivas —la cabecera del expediente, las
 * personas y los teléfonos— las sirve ahora el KMS en UNA pregunta.
 *
 * Lo que se afirma es lo observable en el fuente: el manejador **no vuelve a leer** esas
 * cuatro tablas de AppSheet, **sí** le pregunta al KMS, y la isla muerta **no reaparece**.
 * Si el manejador no se encuentra, el control queda CIEGO y eso es ROJO, no verde.
 *
 * Lo que NO se afirma, y se dice: que el KMS conteste lo correcto, ni que la puerta E.164
 * siga juzgando bien. Eso no se lee aquí. Y quedan a propósito FUERA las dos lecturas de
 * `recFiles`/`recScopes` del mismo manejador: llevan dentro el literal del tipo de
 * expediente que DL-E48 prohíbe escribir a mano, y son tramo aparte.
 */
function comprobarElEnvio(fuenteLimpia) {
  const fallos = []

  const cuerpo = cuerpoDe(fuenteLimpia, 'submitEnrollmentSession_')
  if (cuerpo === null) {
    return ['no se encontró `submitEnrollmentSession_` — control CIEGO en el envío (②17)']
  }

  const tablasMigradas = [
    ['ENROLLMENT_GROUPS', 'enrEnrollmentGroups', 'la cabecera del expediente (el idioma)'],
    ['PERSONS', 'enrPersons', 'las personas que siguen en la solicitud'],
    ['PHONES', 'enrPhones', 'los teléfonos de la puerta E.164'],
    ['QB_RESPONSES', 'qbResponses', 'las respuestas que nadie leía'],
    ['EMAILS', 'enrEmails', 'los correos que nadie leía'],
  ]
  for (const [constante, tabla, queEs] of tablasMigradas) {
    const re = new RegExp('appsheetRequest_\\s*\\(\\s*(T\\.' + constante + "|'" + tabla + "')")
    if (re.test(cuerpo)) {
      fallos.push('`submitEnrollmentSession_` vuelve a leer `' + tabla + '` directamente de ' +
        'AppSheet — eso es lo que ②17 quitó (' + queEs + ')')
    }
  }

  if (!/kmsProxy_\s*\(\s*'enr\.wizardDatosDelEnvio'/.test(cuerpo)) {
    fallos.push('el envío ya no le pide al KMS lo que necesita para validarse ' +
      '(`enr.wizardDatosDelEnvio`) — o se quitó la comprobación, o volvió a hacerse contra AppSheet')
  }

  // La isla muerta: si vuelve, vuelve con ella la lectura que dejaba familias encalladas.
  for (const muerta of ['buildApplicationSubmittedBody_', '_kmsRenderApplicantsTable_']) {
    if (new RegExp('function\\s+' + muerta + '\\s*\\(').test(fuenteLimpia)) {
      fallos.push('`' + muerta + '` ha vuelto — es la isla sin llamantes que ②17 retiró, y era ' +
        'el único consumidor de la lectura de respuestas que se ejecutaba en cada envío sin que ' +
        'nadie mirara el resultado')
    }
  }

  // El ANCLA de que la puerta del teléfono sigue existiendo: sin esto, el control podría
  // salir verde sobre un manejador al que le hubieran quitado la validación entera.
  if (!/INVALID_PHONE/.test(cuerpo)) {
    fallos.push('la puerta del teléfono E.164 desapareció del envío — el control estaría ' +
      'afirmando que no lee AppSheet sobre un manejador que ya no valida nada')
  }

  return fallos
}

/**
 * ②17 (sexto tramo) — la CABECERA del expediente no se lee de AppSheet, y la lee UN SOLO sitio.
 *
 * Eran TRES lecturas y eran LA MISMA copiada tres veces
 * (`appsheetRequest_(T.ENROLLMENT_GROUPS, 'Find', …, {Filter:'"resume_token" = …'})`):
 * la rama de `hydrateSession_` con el candado puesto —cuya fila cruza ENTERA al navegador,
 * `magic_link_token` incluido—, el hint de identidad del mismo manejador, y `warmSession_`,
 * cuyo propio comentario decía «VERBATIM de hydrateSession_». Las tres las hacía este
 * proceso, que es público y anónimo, con la credencial de AppSheet de la aplicación entera.
 *
 * Lo que se afirma, y es lo observable en el fuente: los dos manejadores **no vuelven a
 * leer** `enrEnrollmentGroups` de AppSheet, los tres puntos **sí** preguntan al KMS por el
 * ayudante ÚNICO, y **no aparece un segundo lector** (dos lectores del mismo dato divergen —
 * la regresión que documenta §"Regla — refactors preservan el código probado"). El ANCLA es
 * que los dos manejadores sigan existiendo y sigan resolviendo la identidad del enlace: sin
 * él, el control afirmaría ausencias sobre un fichero que ya no es el que cree medir.
 *
 * Lo que NO se afirma, y se dice: que el KMS conteste la proyección correcta, ni que el
 * comportamiento ante fallo sea el debido (lanzar en la rama del candado, degradar en las
 * otras dos). Eso no se lee aquí — se midió aparte.
 */
function comprobarLaEntradaDelExpediente(fuenteLimpia) {
  const fallos = []

  const manejadores = [
    ['hydrateSession_', 'la hidratación de entrada (rama con el candado puesto + hint de identidad)'],
    ['warmSession_',    'el precalentado de la pantalla del código'],
  ]

  for (const [nombre, queEs] of manejadores) {
    const cuerpo = cuerpoDe(fuenteLimpia, nombre)
    if (cuerpo === null) {
      // ANCLA: sin el manejador, este control no puede medir lo que dice medir.
      fallos.push('no se encontró `' + nombre + '` — control CIEGO en la cabecera del expediente (②17)')
      continue
    }
    if (/appsheetRequest_\s*\(\s*(T\.ENROLLMENT_GROUPS|'enrEnrollmentGroups')/.test(cuerpo)) {
      fallos.push('`' + nombre + '` vuelve a leer `enrEnrollmentGroups` directamente de AppSheet — ' +
        'eso es lo que ②17 quitó de: ' + queEs + '. La fila entera (con `magic_link_token`) volvería a ' +
        'cruzar a este proceso público')
    }
    if (!/_expedienteDelToken_\s*\(/.test(cuerpo)) {
      fallos.push('`' + nombre + '` ya no le pide la cabecera al KMS (`_expedienteDelToken_`) — ' +
        'o se quitó, o volvió a resolverse por su cuenta')
    }
    // ANCLA 2: el punto de este tramo es alimentar la identidad del enlace. Si eso desaparece,
    // el «no lee AppSheet» sería cierto y vacío a la vez.
    if (!/effectiveRecoveredEmail_\s*\(/.test(cuerpo)) {
      fallos.push('`' + nombre + '` ya no resuelve la identidad del enlace (`effectiveRecoveredEmail_`) — ' +
        'el control estaría afirmando que no lee AppSheet sobre un manejador que ya no hace su trabajo')
    }
  }

  // UN SOLO lector: el ayudante existe, pregunta al KMS por la entrada declarada, y no hay
  // un segundo resolvedor de lo mismo.
  const ayudante = cuerpoDe(fuenteLimpia, '_expedienteDelToken_')
  if (ayudante === null) {
    fallos.push('no se encontró `_expedienteDelToken_` — control CIEGO: es el lector ÚNICO de la cabecera (②17)')
  } else if (!/kmsProxy_\s*\(\s*'enr\.wizardExpedienteDelToken'/.test(ayudante)) {
    fallos.push('`_expedienteDelToken_` ya no le pregunta al KMS (`enr.wizardExpedienteDelToken`) — ' +
      'si vuelve a leer AppSheet, el tramo está deshecho')
  }

  return fallos
}

/**
 * ②17 séptimo tramo — la ENTRADA de una solicitud nueva ya no lee AppSheet.
 *
 * `initEnrollmentSession_` hacía TRES lecturas directas desde este proceso público y
 * anónimo, todas filtradas por el correo tecleado: los expedientes ya enviados de ese
 * correo, los abiertos, y las personas de los candidatos **solo para contarlas**. Cruzaba
 * la fila ENTERA de cada expediente —con `magic_link_token`, un secreto de portador— y la
 * ficha ENTERA de cada persona, incluidos menores. Ahora las sirve el KMS
 * (`enr.wizardExpedientesDelCorreo`) por **UN SOLO ayudante**, `_expedientesDelCorreo_`.
 *
 * Se afirman cuatro cosas y DOS son anclas. Las anclas existen porque un control que solo
 * comprueba AUSENCIAS sale verde sobre un manejador vaciado o renombrado: si
 * `initEnrollmentSession_` desaparece, o deja de decidir la sesión única, este control
 * **no puede medir lo que dice medir** y lo dice con esas palabras en vez de callar.
 *
 * Lo que NO se afirma, y se dice: que el KMS conteste la proyección correcta, ni que el
 * ayudante falle cerrado como debe (lanzar, nunca degradar a «no hay expediente»). Eso no
 * se lee aquí — se midió aparte, ejecutando el manejador real con dobles.
 */
function comprobarLaEntradaDeLaSolicitud(fuenteLimpia) {
  const fallos = []

  const cuerpo = cuerpoDe(fuenteLimpia, 'initEnrollmentSession_')
  if (cuerpo === null) {
    // ANCLA 1: sin el manejador, este control es CIEGO.
    fallos.push('no se encontró `initEnrollmentSession_` — control CIEGO en la entrada de una ' +
      'solicitud nueva (②17)')
  } else {
    for (const [tabla, quePasaba] of [
      ['(T\\.ENROLLMENT_GROUPS|\'enrEnrollmentGroups\')',
        'la fila entera del expediente —con `magic_link_token` dentro— volvería a cruzar a este proceso público'],
      ['(T\\.PERSONS|\'enrPersons\')',
        'la ficha entera de cada persona, menores incluidos, volvería a cruzar solo para CONTARLAS'],
    ]) {
      if (new RegExp('appsheetRequest_\\s*\\(\\s*' + tabla).test(cuerpo)) {
        fallos.push('`initEnrollmentSession_` vuelve a leer ' + tabla.replace(/[\\()']/g, '') +
          ' directamente de AppSheet — ' + quePasaba)
      }
    }
    if (!/_expedientesDelCorreo_\s*\(/.test(cuerpo)) {
      fallos.push('`initEnrollmentSession_` ya no le pide los expedientes al KMS ' +
        '(`_expedientesDelCorreo_`) — o se quitó, o volvió a resolverlos por su cuenta')
    }
    // ANCLA 2: el manejador sigue DECIDIENDO la sesión única. Sin esto, «no lee AppSheet»
    // sería cierto y vacío a la vez — la política se habría escapado a otro sitio.
    if (!/personCountByGroup/.test(cuerpo) || !/wizardAbandonSession/.test(cuerpo)) {
      fallos.push('`initEnrollmentSession_` ya no decide la sesión única (puntuar por personas ' +
        'y abandonar a los perdedores) — el control estaría afirmando que no lee AppSheet sobre ' +
        'un manejador que ya no hace su trabajo')
    }
  }

  // UN SOLO lector: el ayudante existe y pregunta al KMS por la entrada declarada.
  const ayudante = cuerpoDe(fuenteLimpia, '_expedientesDelCorreo_')
  if (ayudante === null) {
    fallos.push('no se encontró `_expedientesDelCorreo_` — control CIEGO: es el lector ÚNICO de ' +
      'los expedientes de un correo (②17)')
  } else if (!/kmsProxy_\s*\(\s*'enr\.wizardExpedientesDelCorreo'/.test(ayudante)) {
    fallos.push('`_expedientesDelCorreo_` ya no le pregunta al KMS ' +
      '(`enr.wizardExpedientesDelCorreo`) — si vuelve a leer AppSheet, el tramo está deshecho')
  }

  return fallos
}

/**
 * ②17 octavo tramo — la RECUPERACIÓN DEL ENLACE por un correo tecleado.
 *
 * La rama pública de `sendMagicLink_` —la que cualquiera alcanza desde internet con el
 * correo que quiera— leía de AppSheet, con la credencial de la aplicación entera: los
 * expedientes de ese correo, TODAS las filas de `enrEmails` de ese buzón, y la ficha
 * COMPLETA de cada persona —MENORES INCLUIDOS— de los expedientes que casaran, solo para
 * comprobar que el correo es de un tutor. Ahora lo sirve el KMS
 * (`enr.wizardRecuperacionDelCorreo`) por **UN SOLO ayudante**, `_recuperacionDelCorreo_`.
 *
 * Se afirman SEIS cosas y DOS son anclas. Las anclas existen porque un control que solo
 * comprueba AUSENCIAS sale verde sobre un manejador vaciado o renombrado: si
 * `sendMagicLink_` desaparece, o su rama pública deja de devolver el acuse constante, este
 * control **no puede medir lo que dice medir** y lo dice con esas palabras en vez de callar.
 *
 * Lo que NO se afirma, y se dice: que el KMS conteste la proyección correcta, ni que la
 * guarda del tutor siga aplicándose allí, ni que el ayudante falle cerrado. Eso no se lee
 * aquí — se midió aparte, ejecutando el manejador real con dobles.
 */
function comprobarLaRecuperacionDelEnlace(fuenteLimpia) {
  const fallos = []

  const cuerpo = cuerpoDe(fuenteLimpia, 'sendMagicLink_')
  if (cuerpo === null) {
    // ANCLA 1: sin el manejador, este control es CIEGO.
    fallos.push('no se encontró `sendMagicLink_` — control CIEGO en la recuperación del ' +
      'enlace por un correo tecleado (②17)')
  } else {
    // La rama del token (camino 1) SIGUE leyendo la cabecera por su identificador y sus
    // hints: eso es OTRO tramo. Aquí solo se afirma lo de la rama PÚBLICA, y por eso se
    // mira lo que era exclusivo suyo: la lectura por `primary_email` y la de correos por
    // `"value"`, que no existen en ninguna otra parte de este manejador.
    if (/appsheetRequest(Batch)?_[\s\S]{0,400}?primary_email"\s*=/.test(cuerpo)) {
      fallos.push('`sendMagicLink_` vuelve a buscar expedientes por `primary_email` en AppSheet — ' +
        'la fila entera del expediente, con `magic_link_token` dentro, volvería a cruzar a este ' +
        'proceso público y anónimo')
    }
    if (/appsheetRequest(Batch)?_[\s\S]{0,400}?"value"\s*=/.test(cuerpo)) {
      fallos.push('`sendMagicLink_` vuelve a leer `enrEmails` por un correo ARBITRARIO — ' +
        'las filas de ese buzón volverían a cruzar a este proceso público y anónimo')
    }
    if (!/_recuperacionDelCorreo_\s*\(/.test(cuerpo)) {
      fallos.push('`sendMagicLink_` ya no le pide al KMS los expedientes recuperables ' +
        '(`_recuperacionDelCorreo_`) — o se quitó, o volvió a resolverlos por su cuenta')
    }
    // ANCLA 2: la rama pública sigue devolviendo el acuse constante (WIZ-ENUM). Sin esto,
    // «ya no lee AppSheet» sería cierto y vacío a la vez.
    if (!/_magicLinkConstantAck_\s*\(/.test(cuerpo)) {
      fallos.push('`sendMagicLink_` ya no devuelve el acuse constante de su rama pública ' +
        '(`_magicLinkConstantAck_`) — el control estaría afirmando que no lee AppSheet sobre un ' +
        'manejador que ya no hace su trabajo, y el oráculo de existencia estaría reabierto')
    }
  }

  // El lector viejo NO vuelve: era el que leía las fichas de las personas para comprobar el
  // papel de tutor. Su comprobación viajó al KMS junto con su lectura.
  if (/function\s+findOpenGroupsByGuardianEmail_\s*\(/.test(fuenteLimpia)) {
    fallos.push('`findOpenGroupsByGuardianEmail_` ha vuelto — sería un SEGUNDO lector del mismo ' +
      'dato, y volvería a bajar la ficha completa de cada persona (menores incluidos) a este ' +
      'proceso público solo para comprobar quién es tutor')
  }

  // UN SOLO lector: el ayudante existe y pregunta al KMS por la entrada declarada.
  const ayudante = cuerpoDe(fuenteLimpia, '_recuperacionDelCorreo_')
  if (ayudante === null) {
    fallos.push('no se encontró `_recuperacionDelCorreo_` — control CIEGO: es el lector ÚNICO de ' +
      'los expedientes recuperables de un correo (②17)')
  } else if (!/kmsProxy_\s*\(\s*'enr\.wizardRecuperacionDelCorreo'/.test(ayudante)) {
    fallos.push('`_recuperacionDelCorreo_` ya no le pregunta al KMS ' +
      '(`enr.wizardRecuperacionDelCorreo`) — si vuelve a leer AppSheet, el tramo está deshecho')
  }

  return fallos
}

/**
 * ②17 (noveno tramo) — LA IDENTIDAD DE QUIEN RECUPERA ya no se resuelve leyendo AppSheet.
 *
 * QUÉ DEFECTO VIGILA, medido contra `origin/main` el 2026-08-15. La cadena que decide DE
 * QUIÉN es un correo (o el identificador opaco `n` de un enlace) hacía hasta CINCO consultas
 * a AppSheet desde este proceso —público y anónimo— con la credencial de la aplicación
 * entera: las PERSONAS del expediente (la ficha COMPLETA de cada una, MENORES INCLUIDOS:
 * nombre, fecha de nacimiento, documento) **solo para saber quién es tutor**, sus correos, la
 * fila del `n` leída **por su clave y sin acotar al expediente**, y hasta dos veces la
 * cabecera. Y había DOS resolvedores del mismo dato —éste y `enr_resolveGuardianFromEmail_`
 * del KMS— que sus dos JSDoc declaraban obligados a permanecer IDÉNTICOS «hasta consolidación
 * P245»: ya habían divergido (éste descartaba a quien la familia había quitado con la bandera
 * `is_active` en falso; el del KMS no).
 *
 * QUÉ AFIRMA, sobre el código real:
 *   (i)   los tres eslabones (`resolveGuardianForRecovery_`, `resolveEmailFromLinkParam_`,
 *         `effectiveRecoveredEmail_`) NO vuelven a leer `enrPersons` / `enrEmails` /
 *         `enrEnrollmentGroups` de AppSheet;
 *   (ii)  los tres pasan por el ayudante ÚNICO (`_tutorQueRecupera_`) o por el lector único
 *         de la cabecera (`_expedienteDelToken_`, sexto tramo);
 *   (iii) el ayudante existe y pregunta a la entrada declarada del KMS;
 *   (iv)  el lector viejo NO reaparece: ni el gemelo con hints, ni `findEmailIdForGuardian_`;
 *   (v)   ANCLAS anti-vacío — los tres eslabones siguen existiendo, y `effectiveRecoveredEmail_`
 *         sigue decidiendo la PRECEDENCIA aquí (`sinRespaldo`, ②24.bis). Sin ellas, «ya no lee
 *         AppSheet» saldría verde sobre una cadena vaciada o renombrada, y este control diría
 *         que mide algo que no mide.
 *
 * QUÉ **NO** AFIRMA: que el KMS resuelva bien, ni que su criterio de fila viva sea el correcto,
 * ni que el ayudante falle cerrado. Eso no se lee aquí — se midió aparte, ejecutando el
 * manejador real del KMS con dobles. Y arrastra el LÍMITE del módulo: detector por líneas.
 */
function comprobarLaIdentidadDeQuienRecupera(fuenteLimpia) {
  const fallos = []
  const TABLAS = /T\.(PERSONS|EMAILS|ENROLLMENT_GROUPS)\b/

  const eslabones = [
    ['resolveGuardianForRecovery_', '_tutorQueRecupera_',
     'de quién es un correo dentro del expediente'],
    ['resolveEmailFromLinkParam_', '_tutorQueRecupera_',
     'a qué correo apunta el `n` del enlace'],
    ['effectiveRecoveredEmail_', '_tutorQueRecupera_|_expedienteDelToken_',
     'la precedencia de la identidad (`n` > correo del cliente > respaldo tutor 1)'],
  ]
  for (const [nombre, esperado, papel] of eslabones) {
    const cuerpo = cuerpoDe(fuenteLimpia, nombre)
    if (cuerpo === null) {
      // ANCLA: sin el eslabón, este control es CIEGO sobre él.
      fallos.push('no se encontró `' + nombre + '` — control CIEGO en ' + papel + ' (②17)')
      continue
    }
    if (/appsheetRequest(Batch)?_\s*\(/.test(cuerpo) && TABLAS.test(cuerpo)) {
      fallos.push('`' + nombre + '` vuelve a leer AppSheet (personas / correos / cabecera del ' +
        'expediente) — la ficha COMPLETA de cada persona, MENORES INCLUIDOS, volvería a cruzar a ' +
        'este proceso público y anónimo solo para saber quién es tutor')
    }
    if (!new RegExp('(' + esperado + ')\\s*\\(').test(cuerpo)) {
      fallos.push('`' + nombre + '` ya no pasa por el lector único del KMS (' +
        esperado.replace('|', ' / ') + ') — o se quitó, o volvió a resolver ' + papel + ' por su cuenta')
    }
  }

  // ANCLA: la PRECEDENCIA se decide AQUÍ, no en el KMS. Si `sinRespaldo` desaparece, el modo
  // estricto de ②24.bis (quién FIRMÓ un consentimiento) se habría perdido por el camino.
  const cadena = cuerpoDe(fuenteLimpia, 'effectiveRecoveredEmail_')
  if (cadena !== null && !/sinRespaldo/.test(cadena)) {
    fallos.push('`effectiveRecoveredEmail_` ya no distingue el modo declarado (`sinRespaldo`, ' +
      '②24.bis) — el respaldo «el tutor 1» volvería a poder atribuir una firma a quien quizá no la dio')
  }

  // UN SOLO lector: el ayudante existe y pregunta a la entrada declarada.
  const ayudante = cuerpoDe(fuenteLimpia, '_tutorQueRecupera_')
  if (ayudante === null) {
    fallos.push('no se encontró `_tutorQueRecupera_` — control CIEGO: es el ayudante ÚNICO por el ' +
      'que este proceso pregunta de quién es un correo (②17)')
  } else if (!/kmsProxy_\s*\(\s*'enr\.wizardTutorQueRecupera'/.test(ayudante)) {
    fallos.push('`_tutorQueRecupera_` ya no le pregunta al KMS (`enr.wizardTutorQueRecupera`) — ' +
      'si vuelve a leer AppSheet, el tramo está deshecho y vuelven los DOS resolvedores')
  }

  // Los lectores viejos NO vuelven. El gemelo se reconoce por su firma con hints; el espejo
  // del `email_id` por su nombre. Cualquiera de los dos sería un SEGUNDO lector del mismo dato.
  if (/function\s+resolveGuardianForRecovery_\s*\([^)]*Hint/.test(fuenteLimpia)) {
    fallos.push('`resolveGuardianForRecovery_` ha vuelto a su firma con hints de filas de AppSheet — ' +
      'sería otra vez el GEMELO del resolvedor del KMS, y los dos ya divergieron una vez (P245)')
  }
  if (/function\s+findEmailIdForGuardian_\s*\(/.test(fuenteLimpia)) {
    fallos.push('`findEmailIdForGuardian_` ha vuelto — sería una tercera pasada por `enrEmails` ' +
      'desde este proceso público, y su respuesta ya viene con la misma pregunta al KMS')
  }

  return fallos
}

/**
 * ②17 (décimo tramo) — QUIÉN PUEDE CONTESTAR ya no se resuelve bajando las fichas.
 *
 * QUÉ DEFECTO VIGILA, medido contra `origin/main` el 2026-08-15. `saveResponses_` bajaba la
 * ficha COMPLETA de cada persona del expediente —MENORES INCLUIDOS: nombre, fecha de
 * nacimiento, documento— a este proceso, que es público y anónimo, **solo para quedarse con
 * sus identificadores**. Y encima el conjunto que armaba **NO era el mismo** que el del
 * escritor (`enr_persistResponses_`, `kis-app kms-server/enr/wizard-gateway.gs`): aquí solo
 * contaban `enrPersons` y se descartaba además a quien la familia hubiera quitado con la
 * bandera `is_active`; allí cuentan también el propio expediente y sus expedientes de alumno,
 * y se filtra solo por `deleted_at`. ⇒ el asistente rechazaba con `UNAUTHORIZED` respuestas
 * que el KMS sí habría guardado, y `UNAUTHORIZED` **no está en `RECHAZOS_DEFINITIVOS`**
 * (`frontend/src/lib/rechazos.js`), así que la cola del asistente lo reintentaba para siempre.
 *
 * QUÉ AFIRMA, sobre el código real:
 *   (a) `saveResponses_` **no lee `enrPersons`** de AppSheet;
 *   (b) **sí** pregunta al KMS por el ayudante ÚNICO (`_respondentesAutorizados_`);
 *   (c) el ayudante existe y pregunta a la entrada declarada (`enr.wizardRespondentesAutorizados`);
 *   (d) ANCLAS anti-vacío — `saveResponses_` sigue derivando el expediente del token
 *       (`requireResumeToken_`), sigue exigiendo el código de un solo uso (`assertStepUpFresh_`)
 *       y sigue rechazando con `UNAUTHORIZED` al respondent ajeno. Sin ellas, «ya no lee
 *       AppSheet» saldría VERDE sobre un manejador vaciado, y este control diría que mide algo
 *       que no mide.
 *
 * QUÉ **NO** AFIRMA: que el KMS resuelva el conjunto bien, ni que su criterio de fila viva sea
 * el correcto, ni que el ayudante falle cerrado. Eso no se lee aquí — se midió aparte,
 * ejecutando el manejador real del KMS con dobles. Y arrastra el LÍMITE del módulo: detector
 * por líneas, no analizador sintáctico.
 */
function comprobarLasRespuestas(fuenteLimpia) {
  const fallos = []

  const cuerpo = cuerpoDe(fuenteLimpia, 'saveResponses_')
  if (cuerpo === null) {
    return ['no se encontró `saveResponses_` — control CIEGO en quién puede contestar (②17)']
  }

  // (a) la lectura que se fue.
  if (/appsheetRequest(Batch)?_\s*\(\s*(T\.PERSONS|'enrPersons')/.test(cuerpo)) {
    fallos.push('`saveResponses_` vuelve a leer `enrPersons` de AppSheet — la ficha COMPLETA ' +
      'de cada persona, MENORES INCLUIDOS, volvería a cruzar a este proceso público y anónimo ' +
      'solo para armar un conjunto de identificadores (②17)')
  }

  // (b) y quien la sustituye. UN SOLO lector.
  if (!/_respondentesAutorizados_\s*\(/.test(cuerpo)) {
    fallos.push('`saveResponses_` ya no pasa por el lector único (`_respondentesAutorizados_`) — ' +
      'o se quitó la comprobación de KAL-4, o volvió a armar el conjunto por su cuenta, y ' +
      'entonces vuelven los DOS criterios que ya divergieron')
  }

  // (c) el ayudante existe y pregunta a la entrada declarada.
  const ayudante = cuerpoDe(fuenteLimpia, '_respondentesAutorizados_')
  if (ayudante === null) {
    fallos.push('no se encontró `_respondentesAutorizados_` — control CIEGO: es el ayudante ' +
      'ÚNICO por el que este proceso pregunta quién puede ser sujeto de una respuesta (②17)')
  } else if (!/kmsProxy_\s*\(\s*'enr\.wizardRespondentesAutorizados'/.test(ayudante)) {
    fallos.push('`_respondentesAutorizados_` ya no le pregunta al KMS ' +
      '(`enr.wizardRespondentesAutorizados`) — si vuelve a leer AppSheet, el tramo está deshecho')
  }

  // (d) ANCLAS: las dos puertas y el rechazo siguen en pie.
  if (!/requireResumeToken_\s*\(/.test(cuerpo)) {
    fallos.push('`saveResponses_` ya no deriva el expediente del `resume_token` (KAL-4) — el ' +
      'control estaría afirmando ausencias sobre un manejador sin puerta')
  }
  if (!/assertStepUpFresh_\s*\(/.test(cuerpo)) {
    fallos.push('`saveResponses_` ya no exige el código de un solo uso (②27) — el control ' +
      'estaría afirmando ausencias sobre un manejador sin su segunda capa')
  }
  if (!/UNAUTHORIZED/.test(cuerpo)) {
    fallos.push('`saveResponses_` ya no rechaza al respondent ajeno (`UNAUTHORIZED`) — mover de ' +
      'dónde salen los ids NO puede llevarse por delante la comprobación que se hace con ellos')
  }

  return fallos
}

/**
 * ②17 (undécimo tramo) — LAS ETIQUETAS DE LOS DOCUMENTOS ya no se componen aquí.
 *
 * QUÉ DEFECTO VIGILA, medido contra `origin/main` el 2026-08-16. `submitEnrollmentSession_`
 * conservaba las DOS últimas lecturas directas a AppSheet del camino del envío: los ficheros
 * del paso 6 (`recFiles` por `origin_reference`) y el guarda de reintento (`recScopes`, **una
 * consulta POR FICHERO**). Las hacía este proceso, que es público y anónimo, con la credencial
 * de la aplicación entera. Y el guarda estaba **roto desde D78**: filtraba
 * `scope_type_code = 'enr_admission_school'` —un ámbito RETIRADO— mientras el KMS escribe ahí
 * el TEMA del documento ⇒ no casaba nunca y un reenvío DUPLICABA las etiquetas de todos los
 * documentos de la familia.
 *
 * QUÉ AFIRMA, sobre el código real:
 *   (a) `submitEnrollmentSession_` **no lee** `recFiles` ni `recScopes` de AppSheet;
 *   (b) **ya no manda** `rec_scopes` al KMS — si volviera, habría DOS composiciones del mismo
 *       dato y divergirían (§"Regla — refactors preservan el código probado");
 *   (c) el ámbito escrito a mano (`enr_admission_school`) no reaparece en el manejador;
 *   (d) ANCLAS anti-vacío — el manejador sigue existiendo, sigue llamando a
 *       `enr.wizardPersistSubmitSideEffects` y sigue mandándole los consentimientos. Sin ellas,
 *       «ya no lee AppSheet» saldría VERDE sobre un manejador vaciado.
 *
 * QUÉ **NO** AFIRMA: que el KMS componga las etiquetas correctas, ni que su guarda de
 * idempotencia acierte, ni que degrade en vez de tumbar el envío. Eso no se lee aquí — se midió
 * aparte, ejecutando el compositor real del KMS con dobles y comparándolo con el bloque de oro.
 * Y arrastra el LÍMITE del módulo: detector por líneas, no analizador sintáctico.
 */
function comprobarLasEtiquetasDelEnvio(fuenteLimpia) {
  const fallos = []

  const cuerpo = cuerpoDe(fuenteLimpia, 'submitEnrollmentSession_')
  if (cuerpo === null) {
    return ['no se encontró `submitEnrollmentSession_` — control CIEGO en las etiquetas de los documentos (②17)']
  }

  // (a) las dos lecturas que se fueron.
  for (const [constante, tabla, queEs] of [
    ['REC_FILES', 'recFiles', 'los documentos que la familia subió en el paso 6'],
    ['REC_SCOPES', 'recScopes', 'el guarda del reintento, una consulta POR FICHERO'],
  ]) {
    const re = new RegExp('appsheetRequest(Batch)?_\\s*\\(\\s*(T\\.' + constante + "|'" + tabla + "')")
    if (re.test(cuerpo)) {
      fallos.push('`submitEnrollmentSession_` vuelve a leer `' + tabla + '` directamente de ' +
        'AppSheet — eso es lo que ②17 quitó (' + queEs + ')')
    }
  }

  // (b) y no se vuelve a componer aquí lo que compone el KMS.
  if (/rec_scopes\s*:/.test(cuerpo)) {
    fallos.push('el envío vuelve a mandar `rec_scopes` a `enr.wizardPersistSubmitSideEffects` — ' +
      'las compone el KMS desde los documentos y expedientes reales del grupo; dos composiciones ' +
      'del mismo dato divergen')
  }

  // (c) el ámbito retirado, escrito a mano, no vuelve.
  if (/enr_admission_school|AMBITO_DEL_EXPEDIENTE/.test(cuerpo)) {
    fallos.push('reaparece el ámbito `enr_admission_school` escrito a mano en el envío — está ' +
      'RETIRADO desde D78 y era justo lo que dejaba el guarda del reintento sin casar nunca')
  }

  // (d) ANCLAS: sin ellas el control mediría un manejador vaciado.
  if (!/kmsProxy_\s*\(\s*'enr\.wizardPersistSubmitSideEffects'/.test(cuerpo)) {
    fallos.push('el envío ya no llama a `enr.wizardPersistSubmitSideEffects` — el control estaría ' +
      'afirmando ausencias sobre un manejador que ya no persiste nada')
  }
  // Se ancla en la LLAMADA, no en la palabra suelta: `/consents\s*:/` a secas casaba el `?:`
  // de `Array.isArray(p.consents) ? p.consents : []` y dejaba el ancla inerte (medido).
  if (!/kmsProxy_\s*\(\s*'enr\.wizardPersistSubmitSideEffects'\s*,\s*\{[^}]*\bconsents\s*:/.test(cuerpo)) {
    fallos.push('el envío ya no le manda los consentimientos al KMS — quitar de dónde salen las ' +
      'etiquetas NO puede llevarse por delante el libro de consentimientos')
  }

  return fallos
}

/**
 * ②17 (duodécimo tramo) — LA PUERTA y sus tres hermanas ya no leen `enrEnrollmentGroups`.
 *
 * QUÉ DEFECTO VIGILA, medido contra `origin/main` el 2026-08-16. CUATRO funciones repetían la
 * MISMA lectura directa de la cabecera del expediente desde este proceso, que es **público y
 * anónimo**, con la credencial de AppSheet de la aplicación entera:
 *   · `requireResumeToken_`  — el gate de TODA mutación, y la lectura MÁS LLAMADA del asistente;
 *   · `assertGroupEditable_` — la **SEGUNDA lectura de la MISMA fila en la MISMA petición**
 *     (sus cinco llamantes van inmediatamente precedidos del gate);
 *   · `abandonSession_` y `reportUnsolicited_` — otra vez, por `resume_token`.
 * Cruzaba la fila ENTERA, con `magic_link_token` (un secreto de portador) dentro. Ahora la
 * sirve el KMS proyectada a SIETE campos, por el lector ÚNICO `_expedienteDelToken_`, y
 * `assertGroupEditable_` no lee nada: reusa la fila que la puerta acaba de validar.
 *
 * QUÉ AFIRMA, sobre el código real:
 *   (a) ninguna de las cuatro vuelve a leer `enrEnrollmentGroups` de AppSheet;
 *   (b) las TRES que tienen token pasan por el lector ÚNICO, y en **modo TOLERANTE** — sin él
 *       la puerta del KMS rechazaría antes y el asistente no podría distinguir «caducado» de
 *       «no existe» (⇒ mensaje equivocado a una familia con la solicitud caducada);
 *   (c) `assertGroupEditable_` **no consulta por identificador** —ni AppSheet ni el KMS— y lee
 *       la memoria de EJECUCIÓN, que la puerta rellena. Un lector por id sería una puerta
 *       trasera a KAL-4, porque ahí el id llega como argumento;
 *   (d) ANCLAS anti-vacío — `requireResumeToken_` sigue existiendo, sigue validando la forma
 *       del token (`assertValidUuid_`), sigue aplicando el TTL de 7 días y sigue con el
 *       cross-group guard. Sin ellas, «ya no lee AppSheet» saldría VERDE sobre un gate vaciado.
 *
 * QUÉ **NO** AFIRMA: que el KMS proyecte los siete campos y no más, que el modo tolerante solo
 * ensanche qué token se acepta, ni que un token inexistente se siga rechazando. Eso no se lee
 * aquí — se midió aparte, ejecutando el manejador real del KMS con dobles. Y arrastra el LÍMITE
 * del módulo: detector por líneas, no analizador sintáctico.
 */
function comprobarLaPuerta(fuenteLimpia) {
  const fallos = []

  const conToken = [
    ['requireResumeToken_', 'el gate de TODA mutación, la lectura más llamada del asistente'],
    ['abandonSession_',     '«empezar de nuevo»'],
    ['reportUnsolicited_',  '«esto no es mío»'],
  ]

  for (const [nombre, queEs] of conToken) {
    const cuerpo = cuerpoDe(fuenteLimpia, nombre)
    if (cuerpo === null) {
      fallos.push('no se encontró `' + nombre + '` — control CIEGO en la puerta (②17 duodécimo tramo)')
      continue
    }
    if (/appsheetRequest(Batch)?_\s*\(\s*(T\.ENROLLMENT_GROUPS|'enrEnrollmentGroups')/.test(cuerpo)) {
      fallos.push('`' + nombre + '` vuelve a leer `enrEnrollmentGroups` directamente de AppSheet — ' +
        'eso es lo que ②17 quitó de: ' + queEs + '. La fila entera (con `magic_link_token`) ' +
        'volvería a cruzar a este proceso público y anónimo')
    }
    if (!/_expedienteDelToken_\s*\(/.test(cuerpo)) {
      fallos.push('`' + nombre + '` ya no le pide la cabecera al KMS por el lector ÚNICO ' +
        '(`_expedienteDelToken_`) — o se quitó, o volvió a resolverse por su cuenta, y dos ' +
        'lectores del mismo dato divergen')
    }
    if (!/tolerarSesionCerrada/.test(cuerpo)) {
      fallos.push('`' + nombre + '` pide la cabecera SIN el modo tolerante — la puerta del KMS ' +
        'rechazaría el token caducado o abandonado antes de devolver la fila, y este manejador ' +
        'perdería su propio rechazo (mensaje equivocado a la familia, o idempotencia rota)')
    }
  }

  // (c) la segunda lectura de la misma fila DESAPARECE, y no vuelve por la puerta de atrás.
  const editable = cuerpoDe(fuenteLimpia, 'assertGroupEditable_')
  if (editable === null) {
    fallos.push('no se encontró `assertGroupEditable_` — control CIEGO en la segunda lectura (②17)')
  } else {
    if (/appsheetRequest(Batch)?_\s*\(/.test(editable)) {
      fallos.push('`assertGroupEditable_` vuelve a leer AppSheet — era la SEGUNDA lectura de la ' +
        'MISMA fila en la MISMA petición; la puerta ya la trae')
    }
    if (/kmsProxy_\s*\(|_expedienteDelToken_\s*\(/.test(editable)) {
      fallos.push('`assertGroupEditable_` vuelve a consultar por el identificador de expediente — ' +
        'ahí el id llega como ARGUMENTO, así que un lector por id es una puerta trasera a KAL-4; ' +
        'debe reusar la fila que la puerta ya validó')
    }
    if (!/_memoCabeceraEjecucion_/.test(editable)) {
      fallos.push('`assertGroupEditable_` ya no lee la memoria de EJECUCIÓN — o volvió a leer por ' +
        'su cuenta, o dejó de comprobar la editabilidad')
    }
  }

  // La puerta tiene que RELLENAR esa memoria; si no, `assertGroupEditable_` fallaría cerrado
  // en TODA mutación y el control de arriba seguiría verde.
  const gate = cuerpoDe(fuenteLimpia, 'requireResumeToken_')
  if (gate !== null) {
    if (!/_memoCabeceraEjecucion_\s*\[/.test(gate)) {
      fallos.push('`requireResumeToken_` ya no deja la cabecera en la memoria de EJECUCIÓN — ' +
        '`assertGroupEditable_` fallaría cerrado en TODA mutación de la familia')
    }
    // (d) ANCLAS: sin ellas el control mediría un gate vaciado.
    if (!/assertValidUuid_\s*\(/.test(gate)) {
      fallos.push('`requireResumeToken_` ya no valida la FORMA del token (`assertValidUuid_`) — ' +
        'es la capa 1 de KAL-5 y va ANTES de tocar nada')
    }
    if (!/7\s*\*\s*24\s*\*\s*60\s*\*\s*60\s*\*\s*1000|RESUME_TOKEN_TTL_MS/.test(gate)) {
      fallos.push('`requireResumeToken_` ya no aplica el TTL de 7 días — mover de dónde sale la ' +
        'fila NO puede llevarse por delante el rechazo que se hace con ella')
    }
    if (!/does not match resume_token grant/.test(gate)) {
      fallos.push('`requireResumeToken_` ya no tiene el cross-group guard — KAL-4 exige que un ' +
        '`enrollment_group_id` del cuerpo que no case con el del token se rechace')
    }
  }

  // El lector único tiene que seguir distinguiendo los DOS fallos: «el KMS dijo que no» vs «no
  // se pudo preguntar». Colapsarlos convertiría un KMS caído en «tu enlace no vale».
  const ayudante = cuerpoDe(fuenteLimpia, '_expedienteDelToken_')
  if (ayudante === null) {
    fallos.push('no se encontró `_expedienteDelToken_` — control CIEGO: es el lector ÚNICO (②17)')
  } else if (!/rechazo/.test(ayudante)) {
    fallos.push('`_expedienteDelToken_` ya no distingue «el KMS rechazó el token» de «no se pudo ' +
      'preguntar» — con los dos colapsados, un KMS caído le diría a una familia legítima que su ' +
      'enlace no vale')
  }

  // ②17 (2026-08-19) — LA MISMA FICHA, DOS VECES POR PETICIÓN. La memoria de EJECUCIÓN sólo
  // se indexaba por identificador de expediente, y `_expedienteDelToken_` recibe un TOKEN ⇒
  // nadie la encontraba y `hydrateSession`/`warmBundle`/`warmSession` pagaban dos viajes al
  // KMS (13-31 s cada uno) por la MISMA fila del MISMO token.
  const clave = cuerpoDe(fuenteLimpia, '_memoCabeceraClave_')
  if (clave === null) {
    fallos.push('no se encontró `_memoCabeceraClave_` — control CIEGO sobre la memoria por token ' +
      '(②17, 2026-08-19)')
  } else if (!/tolerarSesionCerrada/.test(clave)) {
    fallos.push('la clave de la memoria de EJECUCIÓN ya no lleva la modalidad ' +
      '(`tolerarSesionCerrada`) — una cabecera obtenida CON tolerancia se le serviría a un ' +
      'llamante que NO la pidió, y ese llamante dejaría de rechazar un enlace caducado o ' +
      'abandonado')
  }
  if (ayudante !== null && (!/_memoCabeceraEjecucion_/.test(ayudante) ||
                            !/_memoCabeceraClave_\s*\(/.test(ayudante))) {
    fallos.push('`_expedienteDelToken_` no consulta la memoria de EJECUCIÓN por su clave — la ' +
      'MISMA ficha del MISMO token se vuelve a pedir al KMS dentro de la MISMA petición')
  }
  if (gate !== null && !/_memoCabeceraClave_\s*\(/.test(gate)) {
    fallos.push('`requireResumeToken_` deja la cabecera SOLO indexada por expediente — ' +
      '`_expedienteDelToken_` la pide por TOKEN, así que no la encuentra y vuelve a preguntar')
  }

  // ⛔ La rama que ROTA el enlace no puede servirse de esa memoria: la ficha guardada lleva
  // dentro el `resume_token` VIEJO, que tras la rotación ya no resuelve.
  const magic = cuerpoDe(fuenteLimpia, 'sendMagicLink_')
  if (magic === null) {
    fallos.push('no se encontró `sendMagicLink_` — control CIEGO en la rama que ROTA el token')
  } else if (/wizardTouchSession/.test(magic) && !/_olvidarCabeceraMemo_\s*\(/.test(magic)) {
    fallos.push('`sendMagicLink_` ROTA el token (`enr.wizardTouchSession`) y NO olvida la cabecera ' +
      'de la memoria de EJECUCIÓN — la ficha guardada lleva dentro el `resume_token` VIEJO, y ' +
      'servirla después de rotar sería devolver un enlace muerto')
  }

  return fallos
}

/**
 * ②17 (decimotercer tramo) — EL PULSO DE LA ADMISIÓN no lee AppSheet, y lo lee UN SOLO sitio.
 *
 * `getAdmissionState_` es una acción PÚBLICA del despachador anónimo y el cliente la dispara
 * repetidamente mientras la familia espera. Hacía TRES lecturas directas en un lote: los
 * expedientes de alumno, las personas del expediente —la ficha COMPLETA de cada una, MENORES
 * INCLUIDOS, solo para CONTAR tutores— y `sysStates_T` **SIN FILTRO: el catálogo de situaciones
 * ENTERO**. Su respaldo, `buildAdmissionContext_`, releía el catálogo por su cuenta.
 *
 * Lo que se afirma, y es lo observable en el fuente: los dos **no vuelven a leer** esas tres
 * tablas de AppSheet, los dos pasan por el lector ÚNICO `_pulsoDeLaAdmision_`, ese ayudante
 * pregunta a la ruta declarada, y el literal del dominio (`ENR_ADMISSION_SCHOOL`) **no vuelve**
 * a escribirse a mano en el filtro del catálogo (DL-E48).
 *
 * Las ANCLAS —sin ellas el control mediría manejadores vaciados—: `getAdmissionState_` sigue
 * derivando el expediente del token y sigue computando la frescura del código de un solo uso;
 * `buildAdmissionContext_` sigue eligiendo la situación por `display_order`.
 *
 * Lo que NO se afirma, y se dice: que el KMS conteste la proyección correcta, ni que el fallo
 * cerrado esté bien puesto. Eso no se lee aquí — se midió aparte.
 */
function comprobarElPulsoDeLaAdmision(fuenteLimpia) {
  const fallos = []

  const pulso = cuerpoDe(fuenteLimpia, 'getAdmissionState_')
  const contexto = cuerpoDe(fuenteLimpia, 'buildAdmissionContext_')
  if (pulso === null) {
    fallos.push('no se encontró `getAdmissionState_` — control CIEGO en el pulso de la admisión (②17)')
  }
  if (contexto === null) {
    fallos.push('no se encontró `buildAdmissionContext_` — control CIEGO en el pulso de la admisión (②17)')
  }
  if (pulso === null || contexto === null) return fallos

  const tablasMigradas = [
    ['ENROLLMENTS', 'enrEnrollments', 'los expedientes de alumno del grupo'],
    ['PERSONS', 'enrPersons', 'la ficha completa de cada persona, MENORES INCLUIDOS, solo para contar tutores'],
    ['STATES_T', 'sysStates_T', 'el catálogo de situaciones ENTERO, sin filtro'],
  ]
  for (const [nombre, cuerpo] of [['getAdmissionState_', pulso], ['buildAdmissionContext_', contexto]]) {
    for (const [constante, tabla, queEs] of tablasMigradas) {
      const re = new RegExp('appsheetRequest(Batch)?_\\s*\\([\\s\\S]{0,400}?(T\\.' + constante + "|'" + tabla + "')")
      if (re.test(cuerpo)) {
        fallos.push('`' + nombre + '` vuelve a leer `' + tabla + '` directamente de AppSheet — ' +
          'eso es lo que ②17 quitó del camino MÁS LLAMADO del expediente (' + queEs + ')')
      }
    }
  }

  // (b) los dos pasan por el lector ÚNICO.
  for (const [nombre, cuerpo] of [['getAdmissionState_', pulso], ['buildAdmissionContext_', contexto]]) {
    if (!/_pulsoDeLaAdmision_\s*\(/.test(cuerpo)) {
      fallos.push('`' + nombre + '` ya no pide el estado de la admisión por el lector ÚNICO ' +
        '(`_pulsoDeLaAdmision_`) — o se quitó, o volvió a resolverse por su cuenta, y dos ' +
        'lectores del mismo dato divergen')
    }
  }

  const ayudante = cuerpoDe(fuenteLimpia, '_pulsoDeLaAdmision_')
  if (ayudante === null) {
    fallos.push('no se encontró `_pulsoDeLaAdmision_` — control CIEGO: es el lector ÚNICO (②17)')
  } else if (!/kmsProxy_\s*\(\s*'enr\.wizardEstadoDeLaAdmision'/.test(ayudante)) {
    fallos.push('`_pulsoDeLaAdmision_` ya no pregunta a `enr.wizardEstadoDeLaAdmision` — el ' +
      'lector único dejó de apuntar a la entrada declarada del KMS')
  }

  // (c) DL-E48: el tipo de expediente NO se escribe a mano al filtrar el catálogo.
  if (/ENR_ADMISSION_SCHOOL/.test(contexto)) {
    fallos.push('`buildAdmissionContext_` vuelve a escribir a mano el tipo de expediente ' +
      '(`ENR_ADMISSION_SCHOOL`) — DL-E48 lo prohíbe: el dominio lo resuelve el KMS por la ' +
      'cadena del programa, y el filtro del catálogo viaja con su lectura')
  }

  // (d) ANCLAS: sin ellas el control mediría manejadores vaciados.
  if (!/requireResumeTokenMemo_\s*\(|requireResumeToken_\s*\(/.test(pulso)) {
    fallos.push('`getAdmissionState_` ya no deriva el expediente del `resume_token` — KAL-4 ' +
      'exige que salga del token y nunca del cuerpo; el control estaría afirmando que no lee ' +
      'AppSheet sobre un manejador sin puerta')
  }
  // `_leerMarcaStepUp_` es el mismo lector con el tiempo restante añadido (2026-08-20);
  // `_isStepUpFresh_` es su envoltorio booleano. Vale cualquiera de los dos.
  if (!/_isStepUpFresh_\s*\(|_leerMarcaStepUp_\s*\(/.test(pulso)) {
    fallos.push('`getAdmissionState_` ya no computa la frescura del código de un solo uso — es ' +
      'lo que decide si el `signing_token` se sirve o se redacta (SEC WIZ-SIGNTOKEN)')
  }
  // 2026-08-20 · ⛔ EL PULSO NO ESTIRA LA VENTANA. Es SEC-STEPUP (#55) escrito como
  // control: el pulso late SOLO cada pocos segundos, así que dejarle acuñar o extender la
  // marca mantendría viva una pestaña abandonada sin nadie delante. Quien la estira es
  // `refrescarVentanaDeInactividad_`, y lo dispara una persona. Se permite el
  // `_markStepUpFresh_` de la GRACIA del enlace, que es re-verificación real y ya estaba.
  if (/_extenderVentanaStepUp_\s*\(/.test(pulso)) {
    fallos.push('`getAdmissionState_` EXTIENDE la ventana del código de un solo uso — el pulso ' +
      'es un temporizador, no una persona: eso deja viva una pestaña abandonada (SEC-STEPUP #55)')
  }
  if (!/display_order/.test(contexto)) {
    fallos.push('`buildAdmissionContext_` ya no elige la situación por `display_order` — la ' +
      'DECISIÓN tenía que quedarse aquí; si se fue, el tramo movió más que el acceso al dato')
  }

  return fallos
}

/**
 * ②17 (decimocuarto tramo, 2026-08-16) — EL RACIMO DE FIRMA E HITOS.
 *
 * `resolveSigningToken_` resolvía el token de firma con SEIS lecturas directas a AppSheet
 * desde este proceso público y anónimo (`sysSigningSessionSigners` + `sysSigningSessions`,
 * y `sysMilestones` + `sysMilestoneTypes` DOS veces en sus dos ayudantes de hitos), siendo
 * su propio comentario el que se declaraba **«espejo VERBATIM del lector canónico del
 * KMS»** ⇒ dos lectores del mismo dato, que ya habían DIVERGIDO en cuatro puntos.
 *
 * Qué afirma, y por qué cada afirmación:
 *  (a) las cuatro tablas no vuelven a leerse aquí — es lo que el tramo quitó;
 *  (b) pasa por el lector ÚNICO, que apunta a la entrada declarada del KMS;
 *  (c) los dos ayudantes de hitos y su diagnóstico NO reaparecen: eran el segundo lector;
 *  (d) `signing_url` NO se copia a la respuesta — CLI 81 / S5 / KAL-NEW-1: el KMS SÍ lo
 *      devuelve, y devolverlo desde aquí reabriría una mitigación cerrada;
 *  (e) un fallo de TRANSPORTE no se disfraza de «token inválido»;
 *  (f) DL-E48: el tipo de expediente no vuelve a escribirse a mano;
 *  (g) ANCLAS — sin ellas, «ya no lee AppSheet» saldría VERDE sobre un gate vaciado.
 *
 * Lo que NO afirma: que el KMS resuelva bien el token. Eso vive en `kms-server/sys/signing.gs`
 * y **ninguna batería lo ejecuta**; se midió aparte, con un arnés efímero.
 */
function comprobarElRacimoDeFirma(fuenteLimpia) {
  const fallos = []

  const resolutor = cuerpoDe(fuenteLimpia, 'resolveSigningToken_')
  if (resolutor === null) {
    fallos.push('no se encontró `resolveSigningToken_` — control CIEGO en el racimo de firma (②17)')
    return fallos
  }

  // (a) las cuatro tablas migradas no vuelven al asistente.
  const tablasMigradas = [
    ['SIGNING_SESSION_SIGNERS', 'sysSigningSessionSigners', 'la fila del firmante, buscada por el token'],
    ['SIGNING_SESSIONS', 'sysSigningSessions', 'la sesión de firma'],
    ['MILESTONES', 'sysMilestones', 'los hitos del expediente'],
    ['MILESTONE_TYPES', 'sysMilestoneTypes', 'el catálogo de tipos de hito, ENTERO y sin filtro'],
  ]
  for (const [constante, tabla, queEs] of tablasMigradas) {
    const re = new RegExp('appsheetRequest(Batch)?_\\s*\\([\\s\\S]{0,400}?(T\\.' + constante + "|'" + tabla + "')")
    if (re.test(resolutor)) {
      fallos.push('`resolveSigningToken_` vuelve a leer `' + tabla + '` directamente de AppSheet — ' +
        'eso es lo que ②17 quitó del camino de FIRMA (' + queEs + ')')
    }
  }

  // (b) pasa por el lector ÚNICO, y el lector apunta a la entrada declarada.
  if (!/_resolucionDelTokenDeFirma_\s*\(/.test(resolutor)) {
    fallos.push('`resolveSigningToken_` ya no pide la resolución por el lector ÚNICO ' +
      '(`_resolucionDelTokenDeFirma_`) — o se quitó, o volvió a resolverse por su cuenta, y ' +
      'dos lectores del mismo dato divergen (ya lo hicieron: cuatro divergencias medidas)')
  }
  const lector = cuerpoDe(fuenteLimpia, '_resolucionDelTokenDeFirma_')
  if (lector === null) {
    fallos.push('no se encontró `_resolucionDelTokenDeFirma_` — control CIEGO: es el lector ÚNICO (②17)')
  } else if (!/kmsProxy_\s*\(\s*'enr\.resolveSigningToken'/.test(lector)) {
    fallos.push('`_resolucionDelTokenDeFirma_` ya no pregunta a `enr.resolveSigningToken` — el ' +
      'lector único dejó de apuntar a la entrada declarada del KMS')
  }

  // (c) el SEGUNDO lector no reaparece.
  for (const muerto of ['isMilestoneCompleted_', 'isDurableSigningMilestoneCompleted_',
    'manual_testSigningStepsFromMilestones']) {
    if (cuerpoDe(fuenteLimpia, muerto) !== null) {
      fallos.push('`' + muerto + '` ha vuelto al asistente — era el SEGUNDO lector de los hitos ' +
        'de firma, con el tipo de expediente escrito a mano y el ancla sin traducir (DL-E44/DL-S105 §10)')
    }
  }

  // (d) `signing_url` NO se devuelve desde la resolución previa a la firma.
  if (/signing_url/.test(resolutor)) {
    fallos.push('`resolveSigningToken_` vuelve a nombrar `signing_url` — el KMS SÍ lo devuelve, y ' +
      'copiarlo aquí REABRE la mitigación CLI 81 / S5 / KAL-NEW-1: la resolución previa a la firma ' +
      'no puede revelar la URL del proveedor con solo el bearer')
  }

  // (e) un fallo de TRANSPORTE se nombra, no se disfraza de token inválido.
  if (!/KMS_UNREACHABLE/.test(resolutor)) {
    fallos.push('`resolveSigningToken_` ya no distingue «no se pudo preguntar» de «el token no ' +
      'vale» — decirle a un tutor legítimo que su enlace de firma no sirve porque el KMS está ' +
      'caído es peor que el fallo (mismo criterio que la puerta)')
  }

  // (f) DL-E48.
  if (/ENR_ADMISSION_SCHOOL/.test(resolutor)) {
    fallos.push('`resolveSigningToken_` vuelve a escribir a mano el tipo de expediente ' +
      '(`ENR_ADMISSION_SCHOOL`) — DL-E48 lo prohíbe: la clase la lleva escrita la propia sesión de firma')
  }

  // (g) ANCLAS: sin ellas el control mediría un manejador vaciado.
  if (!/assertValidSigningToken_\s*\(/.test(resolutor)) {
    fallos.push('`resolveSigningToken_` ya no valida la FORMA del token (`assertValidSigningToken_`, ' +
      'P211: UUID v4 o 32-hex sin guiones) — el control estaría afirmando que no lee AppSheet sobre ' +
      'un manejador sin validación de entrada')
  }
  const puerta = cuerpoDe(fuenteLimpia, 'requireSigningToken_')
  if (puerta === null) {
    fallos.push('no se encontró `requireSigningToken_` — control CIEGO: es la puerta de los cuatro ' +
      'proxies de firma y el llamante vivo del resolutor')
  } else if (!/resolveSigningToken_\s*\(/.test(puerta) || !/UNAUTHORIZED/.test(puerta)) {
    fallos.push('`requireSigningToken_` dejó de resolver el token o de rechazar con `UNAUTHORIZED` — ' +
      'KAL-4: el expediente y el firmante salen del token, y un token que no vale no abre nada')
  }

  return fallos
}

/**
 * 0º.undevicies — DÓNDE aterriza un documento que sube una familia lo DICE el KMS, no
 * este proceso.
 *
 * Antes `uploadDocument_` creaba (o encontraba) el fichero en una carpeta suelta de su
 * propio Drive (`getOrCreateDriveFolder_('KIS Admissions Documents')`), fuera del árbol
 * único del archivo de registros que ya usa TODO lo que genera el KMS. Ahora le pregunta
 * al KMS la carpeta del día (`enr.carpetaDelArchivo`) y crea el fichero AHÍ.
 *
 * Lo que se afirma: `uploadDocument_` no vuelve a llamar a `getOrCreateDriveFolder_` (ni
 * la función sigue existiendo — es vestigial, sin más llamantes), SÍ le pregunta al KMS
 * dónde va el fichero, y sigue derivando el expediente del `resume_token` (KAL-4) antes
 * de tocar Drive.
 */
function comprobarLaCarpetaDelArchivo(fuenteLimpia) {
  const fallos = []

  const cuerpo = cuerpoDe(fuenteLimpia, 'uploadDocument_')
  if (cuerpo === null) {
    fallos.push('no se encontró `uploadDocument_` — control CIEGO en dónde aterriza un documento subido')
    return fallos
  }

  if (/getOrCreateDriveFolder_\s*\(/.test(cuerpo)) {
    fallos.push('`uploadDocument_` vuelve a llamar a `getOrCreateDriveFolder_` — eso es la carpeta ' +
      'suelta fuera del árbol único del archivo que 0º.undevicies quitó')
  }
  if (!/kmsProxy_\s*\(\s*'enr\.carpetaDelArchivo'/.test(cuerpo)) {
    fallos.push('`uploadDocument_` ya no le pregunta al KMS dónde va el fichero (`enr.carpetaDelArchivo`) — ' +
      'o se quitó la pregunta, o volvió a decidir la carpeta por su cuenta')
  }
  if (/function\s+getOrCreateDriveFolder_\s*\(/.test(fuenteLimpia)) {
    fallos.push('`getOrCreateDriveFolder_` sigue definida sin llamantes — es vestigial y debe retirarse ' +
      '(§"lo vestigial se ELIMINA en cuanto se detecta")')
  }

  // Ancla KAL-4: el expediente sigue saliendo del bearer, no del cuerpo — sin esto el
  // control podría salir verde sobre un manejador que perdió la comprobación de acceso.
  if (!/requireResumeToken_\s*\(\s*p\s*\)/.test(cuerpo)) {
    fallos.push('`uploadDocument_` ya no deriva el expediente del `resume_token` — KAL-4 rota')
  }

  return fallos
}

export function comprobarVerjaPublica(fuente) {
  const limpia = sinComentarios(fuente)
  return [
    ...ejecutarVeredictoReal(limpia),
    ...comprobarLasEntradasDeAdmisiones(limpia),
    ...comprobarCodigoDeUnSoloUso(limpia),
    ...comprobarGuardarYSeguirLuego(limpia),
    ...comprobarParidadDelCodigo(limpia),
    ...comprobarLosDocumentosDeLaFamilia(limpia),
    ...comprobarLaCarpetaDelArchivo(limpia),
    ...comprobarLaHidratacionDeEntrada(limpia),
    ...comprobarElEnvio(limpia),
    ...comprobarLaEntradaDelExpediente(limpia),
    ...comprobarLaEntradaDeLaSolicitud(limpia),
    ...comprobarLaRecuperacionDelEnlace(limpia),
    ...comprobarLaIdentidadDeQuienRecupera(limpia),
    ...comprobarLasRespuestas(limpia),
    ...comprobarLasEtiquetasDelEnvio(limpia),
    ...comprobarLaPuerta(limpia),
    ...comprobarElPulsoDeLaAdmision(limpia),
    ...comprobarElRacimoDeFirma(limpia),
  ]
}
