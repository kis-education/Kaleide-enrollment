/**
 * DL-E39 (PII-primero) — helpers de enmascarado client-side.
 *
 * Minimización por defecto: la PII sensible de menores (DOB, DNI/identidad,
 * dirección) se muestra ENMASCARADA salvo step-up fresco. Estos helpers NO son
 * seguridad por sí mismos (el dato sigue en memoria) — son minimización de
 * exposición visual (screen shares, hombro, inactividad). Coherentes con el
 * patrón de redacción del logger (KAL-11): nunca dejamos un preview que
 * identifique al menor.
 */

// DOB → "**/**/****" (oculta el valor entero — no exponemos ni el año).
export function maskDob(value) {
  if (!value) return '';
  return '**/**/****';
}

/**
 * Documento de identidad / DNI → `****` + últimos 4 (`****1234`).
 * Para valores de <=4 chars enmascara todo (sin filtrar la longitud útil).
 */
export function maskId(value) {
  if (!value) return '';
  const s = String(value).trim();
  if (s.length <= 4) return '****';
  return '****' + s.slice(-4);
}

/** Texto libre genérico (nombre de doc, dirección…) → marcador constante. */
export function maskText() {
  return '••••••••';
}
