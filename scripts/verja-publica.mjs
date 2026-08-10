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
  else if (!/_asegurarVerjaPublica_|_verjaPublicaVeredicto_/.test(rec)) {
    fallos.push('`recognizeFamily_` no pasa por la verja')
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

export function comprobarVerjaPublica(fuente) {
  const limpia = sinComentarios(fuente)
  return [
    ...ejecutarVeredictoReal(limpia),
    ...comprobarLasEntradasDeAdmisiones(limpia),
    ...comprobarCodigoDeUnSoloUso(limpia),
    ...comprobarGuardarYSeguirLuego(limpia),
    ...comprobarParidadDelCodigo(limpia),
  ]
}
