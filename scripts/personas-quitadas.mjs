/**
 * personas-quitadas.mjs — el asistente NO puede volver a contar a quien la familia quitó.
 *
 * QUÉ VIGILA, y por qué existe
 * ────────────────────────────
 * La familia puede QUITAR de su solicitud lo que ella misma añadió (`enr.wizardRetirar`,
 * que estampa `deleted_at`). El KMS descarta a esas personas en todas partes; el asistente
 * NO lo hacía en ninguna. Medido el 2026-08-09 sobre datos reales (166 personas):
 * 134 retiradas · 83 tutores retirados sin teléfono vivo · **57 de 67 expedientes
 * bloqueados** — la puerta del envío le exigía un teléfono E.164 a tutores que ya no
 * estaban, y tumbaba el envío entero aunque los que quedaban lo tuvieran todo correcto.
 *
 * Dos afirmaciones, las dos sobre el CÓDIGO REAL de `backend/Code.js`:
 *
 *   (A) El ÚNICO sitio que decide «viva o retirada» se comporta como debe. No se copia
 *       aquí su lógica: se EXTRAE la función del fuente y se EJECUTA. Si alguien la
 *       ablanda, los casos salen rojos.
 *   (B) Ninguna lectura de personas / teléfonos / correos / vínculos se salta ese sitio.
 *       Ésta es la que impide que la asimetría vuelva a nacer: se nace repartiendo
 *       `!p.deleted_at` a mano por trece sitios y olvidándose del catorceavo.
 *
 * LÍMITE HONESTO, declarado: es un detector por líneas, no un analizador sintáctico.
 * Una lectura construida por `eval()` o a través de un alias de `appsheetRequest_`
 * seguiría siendo invisible — igual que en `escrituras-directas.mjs`.
 *
 * Sin dependencias: solo texto. No necesita `npm ci`, ni red, ni navegador (~1 s).
 */

/** Tablas cuyas filas puede quitar la familia. Sus lecturas deben pasar por el ayudante. */
const TABLAS_VIGILADAS = ['PERSONS', 'PHONES', 'EMAILS', 'PERSON_RELATIONS']

/**
 * Funciones que SÍ pueden leer en crudo, con su motivo. Una exención sin motivo escrito
 * no es una exención: es un olvido con permiso.
 */
const EXENTAS = {
  manual_diagPersonasRetiradas:
    'es el instrumento que CUENTA las retiradas — filtrarlas dejaría el conteo a cero y la medida sin sentido',
  manual_testIdentityFromLink:
    'busca a propósito una fila de OTRO grupo para comprobar que se rechaza (KAL-4); no le importa si está viva',
  manual_diagResumeToken:
    'diagnóstico: vuelca el expediente TAL CUAL está para entender por qué falla, retiradas incluidas',
  manual_repairRequesterEmailLink:
    'repara el vínculo del solicitante leyendo el estado real de la tabla, sin criterio de vida',
  manual_testRecoveryPerGuardian:
    'prueba manual que inspecciona el expediente completo',
  manual_diagResponsesRetrieval:
    'diagnóstico de respuestas: cuenta sobre el expediente entero',
  manual_diagGroupEmails:
    'diagnóstico: enseña los correos y personas del expediente TAL CUAL están, para ver qué falta o sobra',
  manual_diagWizardSigningGate:
    'diagnóstico de la puerta de firma: mira el expediente completo, retiradas incluidas',
}

/** Casos que se ejecutan contra la función REAL extraída del fuente. */
const CASOS = [
  { nombre: 'fila normal',                     fila: { person_id: 'a' },                          viva: true,
    dano: 'una persona que la familia no ha quitado desaparecería de su propia solicitud' },
  { nombre: 'deleted_at con fecha',            fila: { person_id: 'a', deleted_at: '2026-08-09T10:00:00Z' }, viva: false,
    dano: 'la persona quitada vuelve a contar: es el bloqueo que dejó a 57 de 67 expedientes sin poder enviarse' },
  { nombre: 'deleted_at vacío',                fila: { person_id: 'a', deleted_at: '' },          viva: true,
    dano: 'AppSheet devuelve texto vacío en las columnas sin valor; tomarlo por «borrada» vaciaría los expedientes' },
  { nombre: 'deleted_at solo espacios',        fila: { person_id: 'a', deleted_at: '   ' },       viva: true,
    dano: 'igual que el vacío: un espacio no es una fecha de borrado' },
  { nombre: 'is_active booleano false',        fila: { person_id: 'a', is_active: false },        viva: false,
    dano: 'las tablas sin bloque de borrado se retiran así (retirada.gs:136-140); ignorarlo las resucita' },
  { nombre: 'is_active texto FALSE',           fila: { person_id: 'a', is_active: 'FALSE' },      viva: false,
    dano: 'AppSheet devuelve los booleanos como TEXTO: comparar con false a secas nunca casa y la fila revive' },
  { nombre: 'is_active texto false minúscula', fila: { person_id: 'a', is_active: 'false' },      viva: false,
    dano: 'misma trampa con otra caja de letras' },
  { nombre: 'is_active texto TRUE',            fila: { person_id: 'a', is_active: 'TRUE' },       viva: true,
    dano: 'una fila activa marcada como retirada desaparecería de la solicitud' },
  { nombre: 'is_active ausente',               fila: { person_id: 'a' },                          viva: true,
    dano: 'enrPersons NO tiene esa columna (38 columnas, medido): su ausencia NO puede significar «retirada»' },
  { nombre: 'fila nula',                       fila: null,                                        viva: false,
    dano: 'un hueco de la lista no es una persona viva' },
]

/** Extrae el cuerpo de una función del fuente, contando llaves. */
function extraerFuncion_(fuente, nombre) {
  const i = fuente.indexOf(`function ${nombre}(`)
  if (i < 0) return null
  const j = fuente.indexOf('{', i)
  if (j < 0) return null
  let nivel = 0
  for (let k = j; k < fuente.length; k++) {
    const c = fuente[k]
    if (c === '{') nivel++
    else if (c === '}') { nivel--; if (nivel === 0) return fuente.slice(i, k + 1) }
  }
  return null
}

/** Nombre de la función en la que cae una línea (la última `function X(` por encima). */
function funcionDeLaLinea_(lineas, indice) {
  for (let k = indice; k >= 0; k--) {
    const m = /^\s*(?:async\s+)?function\s+([A-Za-z0-9_$]+)\s*\(/.exec(lineas[k])
    if (m) return m[1]
  }
  return '(nivel superior)'
}

/**
 * @param {string} fuente contenido de backend/Code.js
 * @return {{casosMal:Array, casosRevisados:number, lecturasCrudas:Array, lecturasRevisadas:number, motivoFatal:string|null}}
 */
export function comprobarPersonasQuitadas(fuente) {
  const vacio = { casosMal: [], casosRevisados: 0, lecturasCrudas: [], lecturasRevisadas: 0 }

  // ── (A) el ayudante REAL, extraído y ejecutado ─────────────────────────────
  const fnViva = extraerFuncion_(fuente, 'wizardFilaViva_')
  if (!fnViva) {
    return { ...vacio, motivoFatal:
      'no se encuentra `wizardFilaViva_` en backend/Code.js — o se ha renombrado, o ya no hay un solo sitio ' +
      'que decida quién sigue en la solicitud; en cualquier caso esta comprobación no puede medir lo que dice medir' }
  }
  const fnSolo = extraerFuncion_(fuente, 'wizardSoloVivas_')
  if (!fnSolo) {
    return { ...vacio, motivoFatal:
      'no se encuentra `wizardSoloVivas_` en backend/Code.js — es la puerta por la que pasan todas las lecturas' }
  }

  let viva, soloVivas
  try {
    // eslint-disable-next-line no-new-func
    const fabrica = new Function(`${fnViva}\n${fnSolo}\nreturn { wizardFilaViva_, wizardSoloVivas_ }`)
    const api = fabrica()
    viva = api.wizardFilaViva_
    soloVivas = api.wizardSoloVivas_
  } catch (e) {
    return { ...vacio, motivoFatal: `el ayudante no se puede ejecutar aislado: ${e && e.message}` }
  }

  const casosMal = []
  for (const caso of CASOS) {
    let obtenido
    try { obtenido = viva(caso.fila) } catch (e) { obtenido = `excepción: ${e && e.message}` }
    if (obtenido !== caso.viva) casosMal.push({ caso, obtenido })
  }

  // El colador entero, no solo la decisión de una fila.
  try {
    const filtrado = soloVivas([{ p: 1 }, { p: 2, deleted_at: '2026-01-01' }, null, { p: 3, is_active: 'FALSE' }])
    if (!Array.isArray(filtrado) || filtrado.length !== 1 || filtrado[0].p !== 1) {
      casosMal.push({
        caso: { nombre: 'wizardSoloVivas_ sobre una lista mezclada', viva: '[{p:1}]',
          dano: 'el colador deja pasar filas quitadas (o se come las vivas) aunque la decisión por fila sea correcta' },
        obtenido: JSON.stringify(filtrado),
      })
    }
    if (soloVivas(null).length !== 0 || soloVivas(undefined).length !== 0) {
      casosMal.push({
        caso: { nombre: 'wizardSoloVivas_ sin lista', viva: '[]',
          dano: 'una lectura que falló devuelve null; si el colador revienta, revienta el envío entero' },
        obtenido: 'no devolvió lista vacía',
      })
    }
  } catch (e) {
    casosMal.push({
      caso: { nombre: 'wizardSoloVivas_ sobre una lista mezclada', viva: '[{p:1}]',
        dano: 'el colador lanza en vez de filtrar' },
      obtenido: `excepción: ${e && e.message}`,
    })
  }

  // ── (B) ninguna lectura se salta el ayudante ───────────────────────────────
  const lineas = fuente.split('\n')
  const lecturasCrudas = []
  let lecturasRevisadas = 0

  const patronDirecto = new RegExp(`appsheetRequest_\\(\\s*T\\.(${TABLAS_VIGILADAS.join('|')})\\s*,`)
  const patronBatch = new RegExp(`table:\\s*T\\.(${TABLAS_VIGILADAS.join('|')})\\b`)

  for (let i = 0; i < lineas.length; i++) {
    const linea = lineas[i]
    if (/^\s*(\/\/|\*|\/\*)/.test(linea)) continue

    // Lectura directa: `appsheetRequest_(T.X, 'Find', …)`.
    const mD = patronDirecto.exec(linea)
    if (mD) {
      lecturasRevisadas++
      const fn = funcionDeLaLinea_(lineas, i)
      if (EXENTAS[fn]) continue
      // El envoltorio puede estar en esta línea o en las dos anteriores (asignaciones partidas).
      const contexto = [lineas[i - 2] || '', lineas[i - 1] || '', linea].join('\n')
      if (!contexto.includes('wizardSoloVivas_')) {
        lecturasCrudas.push({ linea: i + 1, fn, tabla: mD[1], texto: linea.trim().slice(0, 110), forma: 'lectura directa' })
      }
      continue
    }

    // Lectura en lote: `{ table: T.X, action: 'Find', … }`. Aquí el colador NO va en la
    // línea del lote (eso solo pediría las filas), sino donde se CONSUME el resultado.
    const mB = patronBatch.exec(linea)
    if (mB) {
      lecturasRevisadas++
      const fn = funcionDeLaLinea_(lineas, i)
      if (EXENTAS[fn]) continue
      const ventana = lineas.slice(i, Math.min(i + 30, lineas.length)).join('\n')
      if (!ventana.includes('wizardSoloVivas_')) {
        lecturasCrudas.push({ linea: i + 1, fn, tabla: mB[1], texto: linea.trim().slice(0, 110), forma: 'lectura en lote' })
      }
    }
  }

  return { casosMal, casosRevisados: CASOS.length + 2, lecturasCrudas, lecturasRevisadas, motivoFatal: null }
}
