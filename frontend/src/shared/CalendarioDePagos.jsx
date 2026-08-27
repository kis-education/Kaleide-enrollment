import React from 'react';
import { useTranslation } from 'react-i18next';
import { fechaLegible } from '../utils/fechas'; // 0º.vicies.sexies: EL único formateador

/**
 * ⭐ EL CALENDARIO DE PAGOS — UN SOLO SITIO, para los pasos 7 y 8.
 *
 * Sale de `tablaDeDesglose` de `Step7Review.jsx` (`0º.vicies.sexies` pieza 3 + `0º.tricies.ter`)
 * y es COPIA VERBATIM de su markup: mismas columnas, mismo criterio de cuándo salen las dos
 * de descuento, mismo subtotal. Lo único que cambia es de dónde llegan las filas.
 *
 * ⛔ SE COMPARTE, NO SE DUPLICA, y el motivo está medido: el paso 8 se había quedado DOS
 * pasadas por detrás del 7 —tres columnas, sin descuento y sin subtotal— siendo la MISMA
 * pantalla de dinero. Dos componentes que pintan lo mismo divergen; éste es el arreglo de
 * fondo (`CLAUDE.md` §"Regla — refactors preservan el código probado").
 *
 * ⚠️ Las dos pantallas beben de fuentes DISTINTAS a propósito —el 7 del ENSAYO, el 8 del
 * BORRADOR REAL— así que se igualan en FORMA, **jamás se funden en una sola lectura**. Por
 * eso cada página normaliza SUS datos a esta forma y este componente no lee nada.
 *
 * ⛔ AQUÍ NO SE CALCULA DINERO (DL-080-A): `money()` divide entre 100 y formatea, y nada
 * más. Ni una suma, ni una resta, ni un porcentaje — las tres cifras de cada fila y las tres
 * del subtotal las PROYECTA el KMS.
 *
 * @param {Object[]} filas — { concepto, due_date, amount_cents, descuento_cents, neto_cents }
 * @param {Object|null} subtotal — { gross_cents, discount_cents, net_cents } o null
 * @param {string} moneda
 * @param {Function} money — el formateador de la página (no se importa: cada paso tiene el suyo)
 * @param {string} prefijo — prefijo de los `data-testid` ('paso7' | 'paso8')
 * @param {string} lang
 */
export default function CalendarioDePagos({ filas, subtotal, moneda, money, prefijo, lang }) {
  const { t } = useTranslation();
  if (!filas || !filas.length) return null;

  // ⛔ Las dos columnas nuevas SOLO salen cuando este plan tiene descuento: con tres
  // columnas la tabla se lee en un móvil, con cinco no. Sin descuento, el markup queda
  // BYTE-IDÉNTICO al de antes de que existieran.
  const hayDescuento = !!(subtotal && Number(subtotal.discount_cents || 0) > 0);
  const importe = (v) => (v == null ? '—' : money(v, moneda));

  return (
    <div data-testid={prefijo + '-desglose'} style={{ marginTop: 10 }}>
      <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--teal-dk)', marginBottom: 4 }}>
        {t('step7.sim.breakdown_title')}
      </div>
      <div style={{ overflowX: 'auto' }}>
        <table style={{ width: '100%', fontSize: '0.8rem', borderCollapse: 'collapse' }}>
          <thead>
            <tr style={{ color: 'var(--muted)', textAlign: 'left' }}>
              <th style={{ fontWeight: 600, padding: '2px 6px 2px 0' }}>{t('step7.sim.breakdown_concept')}</th>
              <th style={{ fontWeight: 600, padding: '2px 6px' }}>{t('step7.sim.breakdown_date')}</th>
              <th style={{ fontWeight: 600, padding: '2px 0 2px 6px', textAlign: 'right' }}>
                {hayDescuento ? t('step7.sim.breakdown_gross') : t('step7.sim.breakdown_amount')}
              </th>
              {hayDescuento && (
                <>
                  <th style={{ fontWeight: 600, padding: '2px 0 2px 6px', textAlign: 'right' }}>
                    {t('step7.sim.breakdown_discount')}
                  </th>
                  <th style={{ fontWeight: 600, padding: '2px 0 2px 6px', textAlign: 'right' }}>
                    {t('step7.sim.breakdown_net')}
                  </th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {filas.map((c, i) => (
              <tr key={i} data-testid={prefijo + '-desglose-fila'} style={{ borderTop: '1px solid var(--border)' }}>
                <td data-testid={prefijo + '-desglose-concepto'} style={{ padding: '3px 6px 3px 0' }}>{c.concepto || '—'}</td>
                <td data-testid={prefijo + '-desglose-fecha'} style={{ padding: '3px 6px' }}>{fechaLegible(c.due_date, lang) || '—'}</td>
                <td style={{ padding: '3px 0 3px 6px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {money(c.amount_cents, moneda)}
                </td>
                {hayDescuento && (
                  <>
                    <td data-testid={prefijo + '-desglose-descuento'}
                        style={{ padding: '3px 0 3px 6px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {importe(c.descuento_cents)}
                    </td>
                    <td data-testid={prefijo + '-desglose-neto'}
                        style={{ padding: '3px 0 3px 6px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {importe(c.neto_cents)}
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
          {/* EL SUBTOTAL — el escalón que faltaba entre las filas y el total. */}
          {subtotal && (
            <tfoot>
              <tr data-testid={prefijo + '-subtotal-plan'}
                  style={{ borderTop: '2px solid var(--border)', fontWeight: 700 }}>
                <td colSpan={2} style={{ padding: '5px 6px 3px 0' }}>{t('step7.sim.subtotal')}</td>
                <td data-testid={prefijo + '-subtotal-bruto'}
                    style={{ padding: '5px 0 3px 6px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {money(subtotal.gross_cents, moneda)}
                </td>
                {hayDescuento && (
                  <>
                    <td data-testid={prefijo + '-subtotal-descuento'}
                        style={{ padding: '5px 0 3px 6px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {money(subtotal.discount_cents, moneda)}
                    </td>
                    <td data-testid={prefijo + '-subtotal-neto'}
                        style={{ padding: '5px 0 3px 6px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {money(subtotal.net_cents, moneda)}
                    </td>
                  </>
                )}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    </div>
  );
}
