/**
 * ②2 — LA VERJA DE LAS ENTRADAS PÚBLICAS: existe, es UNA SOLA, falla hacia cerrado,
 * y las tres puertas anónimas pasan por ella.
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
 * QUÉ AFIRMA (dos cosas, y las dos sobre el CÓDIGO REAL):
 *   (a) EJECUTA el veredicto real extraído del fuente, con 6 casos, incluidas las tres
 *       formas de fallar hacia cerrado. No repite su lógica: la corre.
 *   (b) las tres entradas públicas lo invocan, y en la de recuperación se invoca ANTES
 *       del primer viaje a AppSheet y NO lanza (un rechazo visible sería otro oráculo).
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

/** (b) Las tres entradas públicas pasan por la verja. */
function comprobarLasTresEntradas(fuenteLimpia) {
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
  return [...ejecutarVeredictoReal(limpia), ...comprobarLasTresEntradas(limpia)]
}
