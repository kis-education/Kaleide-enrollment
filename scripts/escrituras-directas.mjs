/**
 * escrituras-directas.mjs — EL detector de escrituras directas a AppSheet desde el
 * backend anónimo del wizard. Esta es la ÚNICA implementación: vive en el repositorio
 * cuyo código vigila, y el KMS la IMPORTA en vez de tener su propia copia.
 *
 * POR QUÉ IMPORTA (no es higiene, es seguridad). El backend de este repositorio se
 * despliega como `ANYONE_ANONYMOUS`: cualquiera en internet puede invocar lo que esté
 * registrado en su dispatcher. Un backend así con credenciales de ESCRITURA de AppSheet
 * es un vector de ataque directo. Por eso TODA escritura vive en el KMS (que sí tiene
 * identidad y permisos) y se alcanza vía `kmsProxy_('enr.wizard…')`. Las LECTURAS no son
 * el vector y siguen permitidas (fase P1-C pendiente).
 *
 * POR QUÉ VIVE AQUÍ Y NO EN EL KMS (corregido 2026-08-03). El control nació dentro de
 * `kis-app/scripts/check-quality-gates.mjs`, leyendo este repositorio como hermano de
 * checkout. En la integración continua del KMS ese hermano NO existe ⇒ el control se
 * declaraba INERTE y no comprobaba nada. La salida perezosa habría sido un credencial
 * con acceso cruzado a los dos repositorios; la correcta es ésta: el control se ejecuta
 * donde vive el código que vigila. El KMS sigue pudiendo ejecutarlo cuando tiene los dos
 * repositorios delante — pero importando ESTE fichero, no una copia. Dos copias del mismo
 * control divergen, y un control divergido miente.
 *
 * LÍMITE HONESTO (declarado, no maquillado): es un detector POR LÍNEAS con cierre de
 * ámbito por llave en columna 0 — asume el estilo de `backend/Code.js` (cuerpo abierto en
 * la MISMA línea, cierre `}` en columna 0). NO es un analizador sintáctico. Una escritura
 * camuflada en `eval()` o en `this['appsheet'+'Request_']` seguiría siendo invisible; para
 * eso hace falta un parser de verdad.
 */

function stripJsComments(src) {
  const REGEX_KEYWORDS = new Set(['return', 'typeof', 'instanceof', 'in', 'of', 'new', 'delete',
    'void', 'case', 'do', 'else', 'yield', 'await', 'throw'])
  /** ¿El `/` en `start` abre un literal de regex? Devuelve el índice tras el cierre, o -1. */
  const regexEnd = (s, start, prevSig, prevWord) => {
    if (prevSig === '<') return -1                                   // `</div>` (cierre JSX)
    if (prevSig === ')' || prevSig === ']') return -1                 // división tras llamada/índice
    if (prevSig === '"' || prevSig === "'" || prevSig === '`') return -1
    if (/[A-Za-z0-9_$]/.test(prevSig) && !REGEX_KEYWORDS.has(prevWord)) return -1
    let inClass = false
    for (let j = start + 1; j < s.length; j++) {
      const ch = s[j]
      if (ch === '\n') return -1                                     // no cruza la línea ⇒ no era regex
      if (ch === '\\') { j += 1; continue }
      if (inClass) { if (ch === ']') inClass = false; continue }
      if (ch === '[') { inClass = true; continue }
      if (ch === '/') {
        let k = j + 1
        while (k < s.length && /[a-z]/.test(s[k])) k += 1            // flags
        return k
      }
    }
    return -1
  }
  let out = ''
  let i = 0
  let quote = null
  let prevSig = ''     // último carácter de CÓDIGO significativo
  let prevWord = ''    // última palabra identificadora (para `return /re/`)
  const noteSig = (ch) => {
    prevSig = ch
    if (/[A-Za-z0-9_$]/.test(ch)) prevWord += ch
    else prevWord = ''
  }
  while (i < src.length) {
    const c = src[i]
    const nx = src[i + 1]
    if (quote) {
      out += c
      if (c === '\\') { out += nx === undefined ? '' : nx; i += 2; continue }
      if (c === quote) { quote = null; noteSig(c) }
      else if (c === '\n' && quote !== '`') { quote = null }   // cadena sin cerrar ⇒ NO arrastres el error
      i += 1
      continue
    }
    if (c === '"' || c === "'" || c === '`') { quote = c; out += c; i += 1; continue }
    if (c === '/' && nx === '/') {
      while (i < src.length && src[i] !== '\n') i += 1
      continue
    }
    if (c === '/' && nx === '*') {
      i += 2
      while (i < src.length && !(src[i] === '*' && src[i + 1] === '/')) {
        if (src[i] === '\n') out += '\n'   // preserva la numeración de líneas
        i += 1
      }
      i += 2
      continue
    }
    if (c === '/') {
      const end = regexEnd(src, i, prevSig, prevWord)
      if (end > i) { out += src.slice(i, end); noteSig('/'); i = end; continue }
    }
    out += c
    i += 1
    if (!/\s/.test(c)) noteSig(c)
  }
  return out
}
export { stripJsComments as despojarComentarios }

/**
 * Recorre el fuente del backend del wizard y devuelve las infracciones encontradas.
 *
 * Cubre CUATRO formas, porque las tres primeras son agujeros que ya se midieron de verdad
 * (auditoría de ceguera 2026-07-26, §4.2/§6.2) y la cuarta cierra la puerta de atrás:
 *   (i)   escritura con acción LITERAL — `appsheetRequest_(tabla, 'Add'|'Edit'|'Delete', …)`
 *         y specs de lote `{ table: …, action: 'Add' … }`.
 *   (ii)  ámbito: una escritura declarada como `const evil_ = () => …` colocada DESPUÉS de
 *         una función exenta HEREDABA su exención. Ahora el ámbito se ABRE también con
 *         función/flecha asignada, se APILA si va anidada, y se CIERRA con la llave en
 *         columna 0. Fuera de toda función NO hay exención posible.
 *   (iii) acción en VARIABLE — evadía el control, que exigía literales. Ahora es infracción
 *         POR SÍ MISMA: si no se puede demostrar que no es una escritura, no es segura.
 *   (iv)  transporte PARALELO — la URL de AppSheet fuera de los dos transportes canónicos
 *         haría INVISIBLE cualquier escritura para este control.
 *
 * @param {string} fuente  contenido de `backend/Code.js`
 * @param {string} etiqueta  cómo nombrar el fichero en los hallazgos
 * @returns {Array<{linea:number, funcion:string, motivo:string, texto:string}>}
 */
export function detectarEscriturasDirectas(fuente, etiqueta = 'backend/Code.js') {
  // Fuente SIN comentarios: una escritura MENCIONADA en un comentario no es una escritura,
  // y un `function x(` comentado no debe desplazar el ámbito.
  const texto = stripJsComments(fuente)

  // Funciones EXENTAS: alcanzables solo desde el editor del proyecto (la autenticación del
  // propietario las protege), NUNCA desde el dispatcher público.
  const EXENTAS = new Set([
    'manual_testApplicationEditRejectionOnSubmitted', // prueba del candado de edición
    'manual_repairRequesterEmailLink',                // reparación puntual de un correo huérfano
  ])
  const TRANSPORTES = new Set(['appsheetRequest_', 'appsheetRequestBatch_'])

  const RE_ESCRITURA   = /appsheetRequest_\(\s*[^,()]+,\s*['"](Add|Edit|Delete)['"]/
  const RE_LLAMADA     = /appsheetRequest_\(\s*([^,]+?)\s*,\s*([^,)]+)/
  const RE_LOTE_ESCR   = /action:\s*['"](Add|Edit|Delete)['"]/
  // Se exige `table:` en la MISMA línea para no confundirlo con el sobre de `kmsProxy_`
  // (`{ action: <var>, payload: … }`), que es una acción del KMS, no de AppSheet.
  const RE_LOTE_SPEC   = /table:\s*[^,}]+,\s*action:\s*([^,}]+)/
  const RE_FN_DECL     = /^(\s*)(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/
  const RE_FN_EXPR     = /^(\s*)(?:const|let|var)\s+([A-Za-z0-9_$]+)\s*=\s*(?:async\s*)?(?:function\b|\([^)]*\)\s*=>|[A-Za-z0-9_$]+\s*=>)/
  const RE_CIERRE      = /^\}/
  const entrecomillado = (s) => /^['"`]/.test((s || '').trim())

  const hallazgos = []
  let pila = []
  texto.split('\n').forEach((linea, i) => {
    const md = RE_FN_DECL.exec(linea) || RE_FN_EXPR.exec(linea)
    if (md) {
      if (md[1].length === 0) pila = [md[2]]   // función de nivel superior nueva
      else pila.push(md[2])                    // anidada dentro de la actual
    } else if (RE_CIERRE.test(linea)) {
      pila = []                                // fin del cuerpo ⇒ no hay exención heredable
    }
    const dentroDe = pila.length ? pila[pila.length - 1] : '<nivel superior>'
    // La exención se consulta contra la pila ENTERA (estar léxicamente dentro de una función
    // exenta sí exime), nunca contra «el último nombre visto» — ése era justo el agujero (ii).
    const exenta = pila.some((n) => EXENTAS.has(n))
    const anota = (motivo) => hallazgos.push({ linea: i + 1, funcion: dentroDe, motivo, texto: `${etiqueta}:${i + 1}` })

    if ((RE_ESCRITURA.test(linea) || RE_LOTE_ESCR.test(linea)) && !exenta) {
      anota(`escritura DIRECTA (Add/Edit/Delete) a AppSheet desde el backend anónimo — PROHIBIDO (vector de ataque). Porta la escritura al KMS vía kmsProxy_('enr.wizard…').`)
    }
    const mc = RE_LLAMADA.exec(linea)
    if (mc && !/function\s+appsheetRequest_/.test(linea) && !entrecomillado(mc[2]) && !exenta) {
      anota(`appsheetRequest_ con la ACCIÓN en variable o expresión ('${mc[2].trim().slice(0, 40)}') — PROHIBIDO: una acción no literal hace INDEMOSTRABLE que no sea un Add/Edit/Delete y evade el control. Pásala como literal ('Find') o porta la operación al KMS.`)
    }
    const mb = RE_LOTE_SPEC.exec(linea)
    if (mb && !entrecomillado(mb[1]) && !exenta) {
      anota(`spec de lote de AppSheet con la ACCIÓN en variable o expresión ('${mb[1].trim().slice(0, 40)}') — PROHIBIDO por la misma razón: la acción debe ser un literal auditable.`)
    }
    if (/APPSHEET_BASE_URL|api\.appsheet\.com/.test(linea)
        && !pila.some((n) => TRANSPORTES.has(n))
        && !/^\s*(?:const|let|var)\s+APPSHEET_BASE_URL\b/.test(linea)) {
      anota(`la URL de la API de AppSheet se usa FUERA de los transportes canónicos (${[...TRANSPORTES].join('/')}) — un transporte paralelo dejaría toda escritura INVISIBLE para este control.`)
    }
  })
  return hallazgos
}
