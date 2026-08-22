/**
 * EL ÚNICO formateador de fechas del asistente.
 *
 * ⭐ 0º.vicies.sexies (Diego, 2026-08-21) — el recuadro de cuotas del paso 7 enseñaba la fecha
 * EN CRUDO (`2026-09-01`). Cita literal: *«el formato de fecha tampoco está bien
 * (2026-09-01)»*. Medido antes de escribir esto: el asistente NO tenía ningún ayudante de
 * fechas —ni en `lib/` ni en `utils/`—, así que cada sitio que necesitara una fecha legible
 * se la habría inventado.
 *
 * ⛔ NI UN FORMATO ESCRITO A MANO NI UN SEGUNDO AYUDANTE: dos formateadores divergen, y
 * entonces la misma fecha se lee de dos maneras en dos sitios de la misma pantalla.
 *
 * ⚠️ DEGRADA AL VALOR ORIGINAL. Una fecha que no se puede interpretar se devuelve tal cual
 * llegó — NUNCA «Invalid Date» delante de una familia, y nunca vacío (que sería peor: la
 * familia dejaría de ver el dato sin saber que existe).
 *
 * @param {string|Date|null} valor  fecha ISO (`2026-09-01`) o `Date`.
 * @param {string} [lang]           idioma de la familia (`es` / `en`); por defecto, el del navegador.
 * @returns {string} la fecha legible, o el valor original si no se puede interpretar.
 */
export function fechaLegible(valor, lang) {
  if (valor == null || valor === '') return '';
  const crudo = String(valor);
  try {
    // Una fecha ISO de solo día (`2026-09-01`) se interpreta como UTC si se pasa entera a
    // `new Date`, y en husos al oeste eso la retrasa un día. Se construye por partes para
    // que el 1 de septiembre sea el 1 de septiembre en cualquier sitio.
    const soloDia = /^(\d{4})-(\d{2})-(\d{2})$/.exec(crudo);
    const d = soloDia
      ? new Date(Number(soloDia[1]), Number(soloDia[2]) - 1, Number(soloDia[3]))
      : (valor instanceof Date ? valor : new Date(crudo));
    if (!d || isNaN(d.getTime())) return crudo;
    return new Intl.DateTimeFormat(lang || undefined,
      { day: 'numeric', month: 'long', year: 'numeric' }).format(d);
  } catch {
    return crudo;
  }
}
