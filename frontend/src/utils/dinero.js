/**
 * EL ÚNICO formateador de importes del asistente — el hermano de `fechas.js`.
 *
 * ⛔ AQUÍ NO SE CALCULA DINERO (DL-080-A): divide entre 100 y formatea, y nada más. El importe
 * lo decide el KMS; el asistente lo ESCRIBE.
 *
 * Por qué existe (drenaje `:08` v1177, 2026-11-19): el paso 7 y el paso 8 llevaban CADA UNO su
 * copia de `money()`, byte a byte iguales, y la pasaban como propiedad a los componentes
 * compartidos (`CalendarioDePagos`, `SelectorDeFormaDePago`, el reparto). Dos copias de un
 * criterio de DINERO divergen —la de fechas ya lo hizo (`dateFmt`, retirado el 2026-08-27)—,
 * y entonces el mismo importe se lee distinto en dos pantallas de la misma solicitud.
 *
 * ⛔ El comportamiento es el de las dos copias, SIN cambiar un byte: separadores del navegador,
 * y la moneda de la fila —que desde el drenaje v1172 el KMS ya manda con la del centro cuando
 * la fila no la trae—; el `'EUR'` de abajo es solo el último respaldo de un dato ausente.
 *
 * @param {number|string|null} cents   importe en céntimos.
 * @param {string} [currency]          código ISO de la moneda (`EUR`).
 * @returns {string} el importe legible.
 */
export function importeLegible(cents, currency) {
  const n = Number(cents || 0) / 100;
  try {
    return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'EUR' }).format(n);
  } catch (e) { return n.toFixed(2) + ' ' + (currency || 'EUR'); }
}
