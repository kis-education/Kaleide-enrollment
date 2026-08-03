/**
 * selector-appsheet.mjs — comprueba que el backend traduce sus filtros al lenguaje que
 * AppSheet realmente entiende, y no a uno que se le parece.
 *
 * ── EL DEFECTO QUE ESTE MÓDULO VIGILA ────────────────────────────────────────────────
 * En el lenguaje de expresiones de AppSheet, `AND` y `OR` son FUNCIONES —`AND(a, b)`—,
 * no operadores que se ponen entre medias. El backend traducía `&&` haciendo
 * `.replace(/&&/g, 'AND')`, que produce:
 *
 *     FILTER("recFiles", [school_id] = "KIS" AND [origin_reference] = "G1")
 *
 * Eso NO da error. Devuelve **la tabla entera**. Y ahí está lo venenoso: un filtro
 * inválido devolvería 0 filas y saltaría a la vista al primer uso; éste devuelve de MÁS,
 * en silencio, y todo parece funcionar mientras cada familia recibe las filas de todas
 * las demás. Medido contra AppSheet real el 2026-08-03 en el repositorio hermano: esa
 * misma cadena devolvió 23 de 23 filas para un expediente que tenía 3.
 *
 * ── POR QUÉ ESTA COMPROBACIÓN Y NO LA BATERÍA DE NAVEGADOR ───────────────────────────
 * `npm run e2e:wizard` recorre los caminos de la familia contra un backend SIMULADO: no
 * llega a construir un Selector de AppSheet, así que **no puede salir roja por esto**.
 * Declararla como red de este cambio sería decorar. Esta comprobación sí puede: lee el
 * traductor REAL de `backend/Code.js`, lo ejecuta aislado y afirma sobre lo que produce.
 * No necesita `npm ci`, ni red, ni navegador.
 *
 * ── LO QUE AFIRMA, Y LO QUE NO ───────────────────────────────────────────────────────
 * Afirma que la traducción emite `AND(...)`/`OR(...)` como funciones, respeta paréntesis
 * y comillas, y no deja ningún `&&`/`||` suelto en la salida. NO afirma que el filtro
 * resultante devuelva las filas correctas — eso solo lo dice AppSheet, y se midió aparte.
 * Es una comprobación de la FORMA, que es justo donde estaba el fallo.
 */

/** Quita comentarios de línea y de bloque sin tocar el contenido de las cadenas. */
export function despojarComentarios(fuente) {
  let salida = ''
  let i = 0
  let comilla = null
  while (i < fuente.length) {
    const c = fuente[i]
    const d = fuente[i + 1]
    if (comilla) {
      salida += c
      if (c === '\\') { salida += d ?? ''; i += 2; continue }
      if (c === comilla) comilla = null
      i++
      continue
    }
    if (c === '"' || c === "'" || c === '`') { comilla = c; salida += c; i++; continue }
    if (c === '/' && d === '/') { while (i < fuente.length && fuente[i] !== '\n') i++; continue }
    if (c === '/' && d === '*') { i += 2; while (i < fuente.length && !(fuente[i] === '*' && fuente[i + 1] === '/')) i++; i += 2; continue }
    salida += c
    i++
  }
  return salida
}

const NOMBRE_TRADUCTOR = 'wizardTraducirFiltro_'
/** El traductor se apoya en el troceador; hay que llevarse los dos o no se ejecuta aislado. */
const NECESARIAS = ['wizardPartirNivelSuperior_', NOMBRE_TRADUCTOR]

/** Recorta el cuerpo de una función por equilibrio de llaves. Devuelve `null` si no está. */
function recortarFuncion(limpio, nombre) {
  const inicio = limpio.indexOf(`function ${nombre}(`)
  if (inicio < 0) return null
  const i = limpio.indexOf('{', inicio)
  if (i < 0) return null
  let nivel = 0
  for (let j = i; j < limpio.length; j++) {
    if (limpio[j] === '{') nivel++
    else if (limpio[j] === '}') { nivel--; if (nivel === 0) return limpio.slice(inicio, j + 1) }
  }
  return null
}

/**
 * Saca del fuente la función traductora —y aquello de lo que depende— y la devuelve ejecutable.
 * Si falta algo, se devuelve `null` con el motivo: una comprobación que no encuentra lo que
 * dice medir NO puede salir verde — eso sería afirmar en vacío.
 */
export function extraerTraductor(fuente) {
  const limpio = despojarComentarios(fuente)
  const trozos = []
  for (const nombre of NECESARIAS) {
    const codigo = recortarFuncion(limpio, nombre)
    if (!codigo) {
      return { fn: null, motivo: `no existe una función \`${nombre}\` en backend/Code.js — ` +
        'la traducción del filtro no está en una función propia y comprobable (o sigue incrustada ' +
        'dentro de appsheetRequest_, donde no se puede medir sin llamar a AppSheet)' }
    }
    trozos.push(codigo)
  }
  try {
    // eslint-disable-next-line no-new-func
    const fn = new Function(`${trozos.join('\n')}\nreturn ${NOMBRE_TRADUCTOR};`)()
    return { fn, motivo: null }
  } catch (e) {
    return { fn: null, motivo: `el traductor no se puede ejecutar aislado: ${e && e.message}` }
  }
}

/**
 * Los casos. Cada uno dice qué entra, qué tiene que salir, y POR QUÉ importa —
 * si un caso se cae, el mensaje tiene que explicar el daño, no solo la diferencia.
 */
export const CASOS = [
  {
    nombre: 'dos condiciones → AND() función',
    entrada: '"school_id" = "KIS" && "origin_reference" = "G1"',
    esperado: 'AND([school_id] = "KIS", [origin_reference] = "G1")',
    dano: 'con AND infijo, AppSheet devuelve la tabla ENTERA: cada familia vería los documentos de todas',
  },
  {
    nombre: 'tres condiciones → un solo AND() de tres',
    entrada: '"primary_email" = "a@b.c" && NOT(ISBLANK([submitted_at])) && ISBLANK([abandoned_at])',
    esperado: 'AND([primary_email] = "a@b.c", NOT(ISBLANK([submitted_at])), ISBLANK([abandoned_at]))',
    dano: 'es el filtro de la RECUPERACIÓN: si no acota, initEnrollmentSession_ coge el grupo de otra ' +
          'familia y le manda a quien teclee el email un enlace con el resume_token ajeno',
  },
  {
    nombre: 'alternativa → OR() función',
    entrada: '"address_id" = "A1" || "address_id" = "A2"',
    esperado: 'OR([address_id] = "A1", [address_id] = "A2")',
    dano: 'el arreglo del && cambió también la traducción del ||; probar solo una de las dos ramas no es probar',
  },
  {
    nombre: 'mezcla con paréntesis: el || va dentro del AND, no al revés',
    entrada: '("respondent_id" = "R1" || "respondent_id" = "R2") && "school_id" = "KIS"',
    esperado: 'AND(OR([respondent_id] = "R1", [respondent_id] = "R2"), [school_id] = "KIS")',
    dano: 'partir sin mirar los paréntesis invierte la precedencia y el filtro deja de significar lo que dice',
  },
  {
    nombre: 'un && DENTRO de una cadena entrecomillada no parte nada',
    entrada: '"nombre" = "Fulano && Mengano" && "school_id" = "KIS"',
    esperado: 'AND([nombre] = "Fulano && Mengano", [school_id] = "KIS")',
    dano: 'partir por texto plano rompería cualquier valor que contenga && y produciría un filtro inválido',
  },
  {
    nombre: 'una sola condición se queda como está',
    entrada: '"enrollment_group_id" = "G1"',
    esperado: '[enrollment_group_id] = "G1"',
    dano: 'envolver de más también cambia el significado; lo simple tiene que seguir simple',
  },
  {
    nombre: 'booleanos en mayúsculas',
    entrada: '"is_active" = true && "school_id" = "KIS"',
    esperado: 'AND([is_active] = TRUE, [school_id] = "KIS")',
    dano: 'AppSheet no entiende `true` en minúsculas',
  },
]

/** Ejecuta los casos. Devuelve `{ fallos, revisados, motivoFatal }`. */
export function comprobarTraductor(fuente) {
  const { fn, motivo } = extraerTraductor(fuente)
  if (!fn) return { fallos: [], revisados: 0, motivoFatal: motivo }

  const fallos = []
  for (const caso of CASOS) {
    let obtenido
    try {
      obtenido = String(fn(caso.entrada))
    } catch (e) {
      fallos.push({ caso, obtenido: `EXCEPCIÓN: ${e && e.message}` })
      continue
    }
    if (obtenido !== caso.esperado) fallos.push({ caso, obtenido })
    // Red de seguridad: ningún `&&`/`||` puede sobrevivir SIN traducir. Se miran solo los que
    // están FUERA de comillas — un `&&` dentro de un valor entrecomillado es texto legítimo y
    // debe pasar intacto. (Sin esta salvedad la propia comprobación daba por malo el caso que
    // precisamente verifica que las comillas se respetan.)
    else if (/&&|\|\|/.test(obtenido.replace(/"(?:[^"\\]|\\.)*"/g, '""'))) {
      fallos.push({ caso, obtenido: `${obtenido}  ← queda un && o || sin traducir fuera de comillas` })
    }
  }
  return { fallos, revisados: CASOS.length, motivoFatal: null }
}
