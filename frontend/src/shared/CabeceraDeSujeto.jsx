/**
 * CabeceraDeSujeto — 0º.tricies.sexdecies (2026-08-22)
 * ────────────────────────────────────────────────────────────────────────────────────
 * Diego, 2026-08-22, cita literal:
 *   «es difícil visualmente separar un hermano del otro. La letra es muy pequeña, no hay
 *    un elemento (un pill) que claramente separe visualmente lo que corresponde a cada
 *    hermano»
 *
 * Pasa en DOS sitios —el cuestionario del paso 5 y la simulación de cuotas del paso 7— y
 * hasta hoy NO SE PARECÍAN ENTRE SÍ: el cuestionario ponía el nombre en texto gris de
 * 0.8rem con un iconito (`QbSetRenderer/index.jsx`), y el simulador lo ponía en negrita de
 * 0.9rem sin icono ni recuadro (`Step7Review.jsx`). Ninguno de los dos ENCERRABA nada: a
 * media pantalla, entre veintitantas preguntas o entre tres planes de pago, no se ve dónde
 * cambia el sujeto.
 *
 * ⛔ ESTE ES EL ÚNICO SITIO QUE DECIDE CÓMO SE VE UN SEPARADOR DE SUJETO. Dos copias del
 * mismo encabezado divergen —es exactamente lo que acababa de pasar entre esas dos
 * pantallas—, así que cualquier tercer sitio que agrupe por persona usa ESTE componente y
 * su clase `.sujeto-bloque` (definidas las dos en `theme.css`), no un encabezado propio.
 *
 * ⛔ AQUÍ NO SE DECIDE DE QUIÉN ES NADA. El sujeto llega ya resuelto (lo declara el
 * catálogo con `audience_category_id` en el cuestionario, y el `applicant_person_id` de la
 * simulación en el paso 7). Esto solo pinta un nombre.
 *
 * `destacado` — CON UN SOLO SUJETO EN PANTALLA NO HAY NADA QUE SEPARAR, y una pastilla
 * grande entonces es ruido. En ese caso se pinta la línea DE SIEMPRE (gris, 0.8rem, con su
 * icono), byte-idéntica a la de antes de este cambio: la familia con un solo hijo ve
 * exactamente la pantalla que veía. El simulador, que con un solo solicitante no pintaba
 * NADA, sigue sin pintar nada — allí es su llamante quien no monta este componente.
 */
export default function CabeceraDeSujeto({ nombre, icono = 'bi-person', destacado = false }) {
  if (!nombre) return null;

  // Sin nada que separar: la línea de siempre, tal cual estaba (mismo elemento y mismo
  // estilo en línea, para que no cambie ni un píxel el caso de un solo hijo).
  if (!destacado) {
    return (
      <p style={{ color: 'var(--muted)', fontSize: '0.8rem', marginBottom: 4 }}>
        <i className={`bi ${icono} me-1`} />{nombre}
      </p>
    );
  }

  // La pastilla: NO se distingue solo por el color —lleva fondo, borde, cuerpo redondeado,
  // peso 700 y un tamaño legible—, para que quien no distingue el teal la reconozca igual.
  return (
    <div className="sujeto-pastilla" data-testid="sujeto-separador">
      <i className={`bi ${icono}`} aria-hidden="true" />
      <span>{nombre}</span>
    </div>
  );
}
