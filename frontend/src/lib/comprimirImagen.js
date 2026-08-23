/**
 * ①27 pieza 9 · DL-R19 — OPTIMIZAR AL SUBIR: la imagen se comprime EN EL NAVEGADOR, y de
 * forma CONSERVADORA.
 *
 * ⛔ **UN SOLO SITIO decide si un archivo se recomprime y cómo.** Si mañana hay un segundo
 * adjuntador, llama aquí; no se escribe una segunda regla. Dos criterios sobre el mismo
 * archivo divergen, y aquí divergir significa estropear un documento que alguien firmó.
 *
 * ── LAS CUATRO BARANDILLAS, y ninguna es de estilo ────────────────────────────────────────
 *
 * 1 · **LO INMUTABLE NO SE TOCA NUNCA** (DL-R19). Un documento con valor probatorio
 *     recomprimido **deja de ser el que se firmó**. El dato viene del catálogo del colegio
 *     (`recTypes_T.is_immutable`, proyectado en `recTypesInterestedParty` por
 *     `rec_resolveInterestedPartyType_`) y es de **TRES estados**: sí · no · **no consta**.
 *     Solo se comprime con un **`false` explícito**; la ausencia se trata como inmutable.
 *     Falla hacia el lado seguro: como mucho se sube un archivo más grande, que es lo que
 *     pasaba ayer con todos.
 *
 * 2 · **CONSERVADOR POR UNA RAZÓN MEDIBLE, no por prudencia genérica** (DL-R19): apretar
 *     mucho una imagen escaneada **estropea su OCR** y el documento desaparece de la búsqueda
 *     por contenido (DL-R18). De ahí el lado largo de 2400 px —suficiente para leer un DNI o
 *     un informe— y la calidad 0,85, no 0,6.
 *
 * 3 · **SOLO LOS FORMATOS QUE SE RE-CODIFICAN EN SÍ MISMOS** — JPEG y WebP. El PDF no se
 *     toca (no es una imagen que el navegador pueda re-dibujar sin perder su texto y sus
 *     firmas) y el **PNG tampoco**: convertirlo a JPEG para «apretarlo» cambiaría la
 *     extensión y el tipo del archivo, y además emborrona el texto de una captura de
 *     pantalla, que es justo lo que un PNG suele ser. Manteniendo el mismo tipo, **el nombre
 *     y la extensión del archivo siguen siendo ciertos**.
 *
 * 4 · **NUNCA SE DEVUELVE ALGO PEOR QUE EL ORIGINAL.** Si el resultado no ahorra de verdad
 *     (`GANANCIA_MINIMA`), o si cualquier paso falla —un formato que el navegador no sabe
 *     descodificar, un lienzo sin contexto, memoria—, se devuelve **el archivo tal cual**.
 *     Esta función no puede impedir que una familia suba su documento.
 *
 * ⚠️ **NO cambia el tope de tamaño ni valida nada.** El tope de 10 MB y la exigencia del tipo
 * siguen donde estaban (`Step6Documents.jsx`), y **el servidor sigue siendo el suelo**: esto
 * solo hace que viajen menos bytes por el camino más lento del asistente.
 */

/** Lado largo máximo, en píxeles. Por debajo de esto NO se baja: barandilla 2 (OCR). */
export const TOPE_LADO_LARGO = 2400;

/** Calidad de re-codificación. Alta a propósito: barandilla 2. */
export const CALIDAD = 0.85;

/**
 * Por debajo de esto no se toca nada. Un archivo pequeño no tiene ahorro que dar y sí tiene
 * calidad que perder — y el viaje ya es corto.
 */
export const SUELO_BYTES = 700 * 1024;

/**
 * El resultado tiene que pesar como mucho esta fracción del original para valer la pena. Si
 * no, se sube el original: recomprimir «para nada» es perder calidad a cambio de nada.
 */
export const GANANCIA_MINIMA = 0.8;

/** Los únicos tipos que se re-codifican EN SÍ MISMOS — barandilla 3. */
export const TIPOS_RECOMPRIMIBLES = ['image/jpeg', 'image/webp'];

/**
 * ¿Se puede recomprimir este archivo? — la decisión, en un solo sitio y sin efectos.
 *
 * @param {?File} archivo
 * @param {?{code?: string, is_immutable?: boolean}} tipoDeclarado la opción del catálogo que
 *   corresponde al tipo elegido. **Ausente ⇒ NO se comprime** (barandilla 1).
 * @returns {{ comprimir: boolean, motivo: string }} el motivo se registra, nunca se le enseña
 *   a la familia: no es un problema suyo ni una decisión que ella tome.
 */
export function decidirCompresion(archivo, tipoDeclarado) {
  if (!archivo) return { comprimir: false, motivo: 'sin-archivo' };
  if (TIPOS_RECOMPRIMIBLES.indexOf(archivo.type) === -1) {
    return { comprimir: false, motivo: 'formato-no-recomprimible' };
  }
  if (!(archivo.size > SUELO_BYTES)) return { comprimir: false, motivo: 'por-debajo-del-suelo' };
  // Barandilla 1 — SOLO un «no» explícito del catálogo abre la puerta. `undefined` (el
  // servidor no proyectó el dato) y `true` se tratan igual: no se toca.
  if (!tipoDeclarado || tipoDeclarado.is_immutable !== false) {
    return { comprimir: false, motivo: 'inmutable-o-no-consta' };
  }
  return { comprimir: true, motivo: 'ok' };
}

/**
 * Descodifica el archivo a algo que se pueda dibujar. Devuelve `null` si el navegador no
 * sabe —un HEIC de un iPhone, por ejemplo—, y entonces se sube el original.
 */
async function decodificar_(archivo) {
  try {
    if (typeof createImageBitmap === 'function') return await createImageBitmap(archivo);
  } catch (e) { /* cae al camino de abajo */ }
  return await new Promise((resolve) => {
    let url = '';
    try {
      const img = new Image();
      url = URL.createObjectURL(archivo);
      img.onload  = () => { URL.revokeObjectURL(url); resolve(img); };
      img.onerror = () => { URL.revokeObjectURL(url); resolve(null); };
      img.src = url;
    } catch (e) {
      if (url) { try { URL.revokeObjectURL(url); } catch (e2) { /* ignorado */ } }
      resolve(null);
    }
  });
}

/**
 * Comprime la imagen si procede. **Siempre devuelve un archivo subible**: el nuevo o el que
 * entró.
 *
 * @param {File} archivo
 * @param {?{code?: string, is_immutable?: boolean}} tipoDeclarado ver `decidirCompresion`
 * @returns {Promise<{ archivo: File, comprimido: boolean, motivo: string,
 *                     bytesAntes: number, bytesDespues: number }>}
 */
export async function comprimirImagen(archivo, tipoDeclarado) {
  const bytesAntes = archivo ? archivo.size : 0;
  const salidaOriginal = (motivo) => ({
    archivo, comprimido: false, motivo, bytesAntes, bytesDespues: bytesAntes,
  });

  const decision = decidirCompresion(archivo, tipoDeclarado);
  if (!decision.comprimir) return salidaOriginal(decision.motivo);

  try {
    const fuente = await decodificar_(archivo);
    if (!fuente) return salidaOriginal('no-se-pudo-descodificar');

    const anchoOrig = fuente.width  || fuente.naturalWidth  || 0;
    const altoOrig  = fuente.height || fuente.naturalHeight || 0;
    if (!anchoOrig || !altoOrig) return salidaOriginal('sin-dimensiones');

    // NUNCA se agranda: `Math.min(1, …)`. Una foto ya pequeña conserva su tamaño y solo
    // se re-codifica, que es donde está el ahorro de una foto de móvil.
    const factor = Math.min(1, TOPE_LADO_LARGO / Math.max(anchoOrig, altoOrig));
    const ancho = Math.max(1, Math.round(anchoOrig * factor));
    const alto  = Math.max(1, Math.round(altoOrig  * factor));

    const lienzo = document.createElement('canvas');
    lienzo.width = ancho;
    lienzo.height = alto;
    const ctx = lienzo.getContext('2d');
    if (!ctx) return salidaOriginal('sin-lienzo');
    ctx.drawImage(fuente, 0, 0, ancho, alto);
    if (fuente.close) { try { fuente.close(); } catch (e) { /* ignorado */ } }

    const blob = await new Promise((resolve) => {
      try { lienzo.toBlob(resolve, archivo.type, CALIDAD); } catch (e) { resolve(null); }
    });
    if (!blob) return salidaOriginal('sin-resultado');

    // Barandilla 4 — si no ahorra de verdad, se sube el original.
    if (!(blob.size < bytesAntes * GANANCIA_MINIMA)) return salidaOriginal('sin-ganancia');

    // MISMO nombre y MISMO tipo (barandilla 3): la extensión sigue siendo cierta.
    const nuevo = new File([blob], archivo.name, {
      type: archivo.type,
      lastModified: archivo.lastModified || Date.now(),
    });
    return {
      archivo: nuevo, comprimido: true, motivo: 'comprimido',
      bytesAntes, bytesDespues: nuevo.size,
    };
  } catch (e) {
    return salidaOriginal('excepcion');
  }
}
