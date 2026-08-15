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

export function comprobarVerjaPublica(fuente) {
  const limpia = sinComentarios(fuente)
  return [
    ...ejecutarVeredictoReal(limpia),
    ...comprobarLasEntradasDeAdmisiones(limpia),
    ...comprobarCodigoDeUnSoloUso(limpia),
    ...comprobarGuardarYSeguirLuego(limpia),
    ...comprobarParidadDelCodigo(limpia),
    ...comprobarLosDocumentosDeLaFamilia(limpia),
    ...comprobarLaHidratacionDeEntrada(limpia),
    ...comprobarElEnvio(limpia),
    ...comprobarLaEntradaDelExpediente(limpia),
  ]
}
