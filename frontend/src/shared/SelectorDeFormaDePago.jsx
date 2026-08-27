import React from 'react';
import { useTranslation } from 'react-i18next';

/**
 * ⭐ ELEGIR LA FORMA DE PAGO — UN SOLO SITIO, para los pasos 7 y 8.
 *
 * Sale de `selectorDelPlan` de `Step7Review.jsx` (`0º.tricies`, Diego 2026-08-22: *«no
 * quiero tarjetas, quiero un botón o desplegable que elija entre modalidades»*) y es COPIA
 * VERBATIM de su markup. El paso 8 seguía con UNA TARJETA POR MODALIDAD — justo lo que él
 * mandó quitar — porque era un segundo componente que pintaba lo mismo.
 *
 * ⛔ Con UNA sola forma de pago NO se pinta desplegable: un desplegable de una opción no es
 * una elección (mismo criterio que el tipo de documento del paso 6). Se dice cuál es.
 *
 * ⛔ UNA FORMA DE PAGO PUEDE NO TENER NOMBRE, y no es un dato que falte: es el plan que NO
 * ADMITE NINGUNA (permanencia, ampliación de horario — van por regla o a mano). Sin este
 * trozo la línea salía empezando por un « · » suelto.
 *
 * ⛔ AQUÍ NO SE CALCULA DINERO (DL-080-A): `money()` divide entre 100 y formatea.
 *
 * @param {Object[]} modalidades — { modality_id, modality_code, designation, installments,
 *                                   per_installment_cents, net_cents, currency_code,
 *                                   available, descuentos? }
 * @param {Object|null} elegida — la que manda hoy
 * @param {Function|null} onElegir — `null` ⇒ SOLO LECTURA (se enseñan todas, en texto)
 * @param {Function} money
 * @param {string} prefijo — prefijo de los `data-testid`
 * @param {string} idCampo
 * @param {boolean} deshabilitado — el desplegable se ve pero no deja cambiar (ya firmado)
 * @param {string|null} pieDeAviso — línea gris bajo el control (p. ej. «ya no se puede cambiar»)
 */
export default function SelectorDeFormaDePago({
  modalidades, elegida, onElegir, money, prefijo, idCampo, deshabilitado, pieDeAviso,
}) {
  const { t } = useTranslation();
  const lista = modalidades || [];
  if (!lista.length) return null;

  const etiqueta = (x) => {
    const nombre = x.designation || x.modality_code || '';
    if (x.available === false) {
      const noDisp = t('step7.sim.option_unavailable');
      return nombre ? nombre + ' — ' + noDisp : noDisp;
    }
    const importe = x.per_installment_cents != null
      ? t('step7.sim.installments', { n: x.installments, amount: money(x.per_installment_cents, x.currency_code) })
      : t('step7.sim.installments_varied', { n: x.installments });
    const total = t('step7.sim.total', { amount: money(x.net_cents, x.currency_code) });
    const cola = importe + ' · ' + total;
    return nombre ? nombre + ' · ' + cola : cola;
  };

  const nombresDeDescuento = elegida && elegida.available !== false && (elegida.descuentos || []).length > 0 && (
    <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginTop: 4 }}>
      {(elegida.descuentos || []).map(d => d.designation || d.policy_code).filter(Boolean).join(' · ')}
    </div>
  );

  // SOLO LECTURA — todas en texto, para poder compararlas; ninguna se elige.
  if (!onElegir) {
    return (
      <div data-testid={prefijo + '-forma-de-pago'}>
        {lista.map((x, i) => (
          <div key={x.modality_id || ('sin-modalidad-' + i)}
               data-testid={prefijo + '-modalidad'} data-modality-id={x.modality_id}
               style={{ fontSize: '0.86rem',
                        fontWeight: (elegida && x.modality_id === elegida.modality_id) ? 700 : 400 }}>
            {etiqueta(x)}
          </div>
        ))}
        {nombresDeDescuento}
        {pieDeAviso && (
          <div style={{ fontSize: '0.8rem', color: 'var(--muted)', marginTop: 8 }}>{pieDeAviso}</div>
        )}
      </div>
    );
  }

  const elegibles = lista.filter(x => x.available !== false);
  const hayQueElegir = elegibles.length > 1;
  return (
    <div data-testid={prefijo + '-forma-de-pago'}>
      {hayQueElegir ? (
        <>
          <label htmlFor={idCampo}
                 style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, marginBottom: 4 }}>
            {t('step7.sim.modality_label')}
          </label>
          <select
            id={idCampo}
            className="form-select form-select-sm"
            data-testid={prefijo + '-modalidad-selector'}
            style={{ maxWidth: 460 }}
            value={(elegida && elegida.modality_id) || ''}
            disabled={!!deshabilitado}
            onChange={e => onElegir(e.target.value)}
          >
            {lista.map(x => (
              <option key={x.modality_id} value={x.modality_id}
                      data-testid={prefijo + '-modalidad'} data-modality-id={x.modality_id}
                      disabled={x.available === false}>
                {etiqueta(x)}
              </option>
            ))}
          </select>
        </>
      ) : (
        elegida && (
          <div data-testid={prefijo + '-modalidad'} data-modality-id={elegida.modality_id}
               style={{ fontSize: '0.86rem' }}>
            {etiqueta(elegida)}
          </div>
        )
      )}
      {nombresDeDescuento}
      {pieDeAviso && (
        <div style={{ fontSize: '0.8rem', color: 'var(--muted)', marginTop: 8 }}>{pieDeAviso}</div>
      )}
    </div>
  );
}
