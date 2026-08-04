/**
 * codigos-de-consentimiento.mjs — comprueba que el wizard NUNCA fabrica un código de
 * consentimiento.
 *
 * QUÉ VIGILA, y por qué es un invariante de datos y no de estilo. `sysConsentsLog` es el
 * libro que prueba qué consintió una familia. Hasta el 2026-08-04 el resolvedor de tipos
 * del wizard tenía un respaldo `|| raw.toUpperCase()`: cualquier cadena sin correspondencia
 * en el catálogo se convertía en un «código» y se escribía en ese libro. MEDIDO en la base
 * antes de tocarlo: 12 filas con `consent_type='LEGAL'`, un código que no existe en el
 * catálogo Capa 2 y que nadie lee. Y el dispatcher del wizard es `ANYONE_ANONYMOUS`:
 * cualquiera en internet podía elegir el código que se escribía.
 *
 * QUÉ AFIRMA (ejecutando el resolvedor REAL extraído del fuente, no leyéndolo):
 *   1. todo código que el mapa emite está DENTRO del catálogo;
 *   2. un tipo desconocido LANZA (no devuelve nada, no inventa, no cae a un valor por
 *      defecto — que sería el mismo defecto con otra cara);
 *   3. los tipos que mandan nuestras propias pantallas se resuelven: o a un código del
 *      catálogo, o a `null` por estar declarados como «no es un consentimiento»;
 *   4. no queda en el fuente ningún respaldo del tipo `|| raw.toUpperCase()`.
 *
 * QUÉ NO AFIRMA: que el catálogo Capa 2 del KMS contenga exactamente esos cuatro códigos.
 * Eso vive en `kis-app/config/sys-consent-types.json` y se comprobó a mano; aquí se afirma
 * la relación entre el mapa del wizard y su propio espejo del catálogo. Si el catálogo del
 * KMS cambia, este espejo se actualiza en el MISMO cambio.
 *
 * LÍMITE HONESTO: es una extracción por texto del fuente (misma técnica que
 * `selector-appsheet.mjs`). Si alguien mueve el resolvedor a otro sitio o lo genera en
 * tiempo de ejecución, la extracción falla — y una extracción fallida es ROJA, nunca verde.
 *
 * Sin dependencias: solo texto y `new Function`.
 */

const NOMBRE_RESOLVEDOR = 'wizardCodigoDeConsentimiento_'

const NECESARIOS = [
  'CATALOGO_CONSENT_TYPES',
  'CONSENT_TYPE_MAP',
  'DECLARACIONES_NO_CONSENTIMIENTO',
  NOMBRE_RESOLVEDOR,
]

/** Extrae del fuente una declaración `var X = …;` o `function X(…) {…}` completa. */
function extraerBloque(fuente, nombre) {
  const inicios = [
    fuente.indexOf(`\nvar ${nombre} = `),
    fuente.indexOf(`\nfunction ${nombre}(`),
  ].filter(i => i >= 0)
  if (!inicios.length) return null
  const desde = Math.min(...inicios) + 1
  // Corte por equilibrio de llaves/corchetes: sirve igual para el objeto, el array y la
  // función. Se ignoran las llaves dentro de cadenas y de comentarios de línea.
  let i = desde, prof = 0, arrancó = false, enCadena = null, enComentario = false
  for (; i < fuente.length; i++) {
    const ch = fuente[i]
    if (enComentario) { if (ch === '\n') enComentario = false; continue }
    if (enCadena) {
      if (ch === '\\') { i++; continue }
      if (ch === enCadena) enCadena = null
      continue
    }
    if (ch === '/' && fuente[i + 1] === '/') { enComentario = true; continue }
    if (ch === '"' || ch === "'") { enCadena = ch; continue }
    if (ch === '{' || ch === '[') { prof++; arrancó = true; continue }
    if (ch === '}' || ch === ']') {
      prof--
      if (arrancó && prof === 0) return fuente.slice(desde, i + 1) + ';'
      continue
    }
    if (!arrancó && ch === ';') return fuente.slice(desde, i + 1)
  }
  return null
}

export function comprobarCodigos(fuente) {
  const fallos = []
  const piezas = []
  for (const nombre of NECESARIOS) {
    const bloque = extraerBloque(fuente, nombre)
    if (!bloque) {
      return {
        fallos: [],
        revisados: 0,
        motivoFatal: `no se encontró «${nombre}» en backend/Code.js — la comprobación no puede ` +
          'medir lo que dice medir, y eso NO es verde',
      }
    }
    piezas.push(bloque)
  }

  let resolver, catalogo, mapa
  try {
    const salida = new Function(`${piezas.join('\n')}\nreturn { r: ${NOMBRE_RESOLVEDOR}, c: CATALOGO_CONSENT_TYPES, m: CONSENT_TYPE_MAP };`)()
    resolver = salida.r; catalogo = salida.c; mapa = salida.m
  } catch (e) {
    return { fallos: [], revisados: 0, motivoFatal: `no se pudo ejecutar el resolvedor aislado: ${e && e.message}` }
  }

  // (1) todo lo que el mapa emite está en el catálogo.
  for (const [tipo, codigo] of Object.entries(mapa)) {
    if (!catalogo.includes(codigo)) {
      fallos.push({
        caso: `mapa: «${tipo}» → «${codigo}»`,
        dano: 'ese código NO está en el catálogo: se escribiría en el libro de consentimientos ' +
          'un valor que ningún catálogo define y que nadie sabe interpretar',
      })
    }
  }

  // (2) un tipo desconocido LANZA. Éste es el defecto exacto que se cerró.
  for (const desconocido of ['legalismo', 'lo_que_yo_quiera', 'GDPR_SCHOOL', '', null, 'image rights']) {
    let lanzó = false, devuelto
    try { devuelto = resolver(desconocido) } catch { lanzó = true }
    if (!lanzó) {
      fallos.push({
        caso: `tipo desconocido ${JSON.stringify(desconocido)}`,
        dano: `no lanzó: devolvió ${JSON.stringify(devuelto)}. Un tipo sin correspondencia tiene ` +
          'que ser un error accionable; cualquier valor que se devuelva acaba escrito en el ' +
          'libro de consentimientos como si fuera un código de catálogo',
      })
    }
  }

  // (3) lo que mandan nuestras propias pantallas se resuelve (o a código, o a `null`).
  //     `gdpr` + `legal` los manda Step7Review.jsx:188-189 en CADA envío: si alguno de los
  //     dos dejara de resolverse, ninguna familia podría enviar su solicitud.
  for (const [tipo, esperado] of [['gdpr', 'GDPR_SCHOOL'], ['legal', null], ['gdpr_data_processing', 'GDPR_SCHOOL']]) {
    let salida, error = null
    try { salida = resolver(tipo) } catch (e) { error = e }
    if (error || salida !== esperado) {
      fallos.push({
        caso: `tipo real de las pantallas «${tipo}»`,
        dano: error
          ? `lanzó «${error.message}»: nuestro propio cliente manda ese tipo, así que ninguna ` +
            'familia podría enviar su solicitud'
          : `devolvió ${JSON.stringify(salida)} en vez de ${JSON.stringify(esperado)}`,
      })
    }
  }

  // (4) no queda el respaldo que fabricaba códigos.
  if (/\|\|\s*\w+\.toUpperCase\(\)/.test(piezas.join('\n'))) {
    fallos.push({
      caso: 'respaldo `|| …toUpperCase()` en el resolvedor',
      dano: 'volvió el respaldo que fabricaba códigos de catálogo a partir de lo que llegara',
    })
  }

  return { fallos, revisados: Object.keys(mapa).length + 9, motivoFatal: null }
}
