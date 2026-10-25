import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useWizard } from '../context/WizardContext';
import { hermanosConSituacion } from '../lib/hermanos';
import {
  hayEstadoPorHijo, hijoResueltoEnPantalla, hijosPendientesEnPantalla,
} from '../lib/pantallaDeFirma';
import SigningChildrenBanner from './SigningChildrenBanner';

/**
 * ★ CLI 403 — EL SELECTOR DE HIJOS DEL TRAMO 8-11 (opción A, Diego 2026-10-25).
 *
 * El tramo final avanza POR PANTALLA: dentro de una pantalla el tutor atiende a TODOS los hijos
 * admitidos, eligiéndolos aquí, y la pantalla se alimenta de la sesión/token del hijo SELECCIONADO
 * (no del primer `.find()`). Esta fila dice, para la pantalla actual, qué hijo está RESUELTO y cuál
 * PENDIENTE, y deja elegir a cuál atender.
 *
 * ⛔ Con UN solo hijo admitido, o sin estado por hijo del servidor (`pasos` ausente), NO cambia nada:
 * se pinta el banner de siempre (`SigningChildrenBanner`). El candado del avance degrada igual (ver
 * `WizardPage.advanceSigningStep`): nunca atrapa a la familia.
 *
 * ⛔ NO decide seguridad ni identidad: el `enrollment_id` que emite por `onSelect` lo valida el
 * servidor contra el grupo del token (KAL-4). Aquí solo se PINTA lo que el servidor ya mandó.
 */
export default function SigningChildrenSelector({ screenId, selectedEnrollmentId, onSelect, resueltosLocales }) {
  const { t } = useTranslation();
  const { admissionState, stepData } = useWizard();

  const admitidos = useMemo(() => {
    const todos = hermanosConSituacion(admissionState?.por_alumno, stepData?.persons, t);
    return todos.filter((h) => h.admitido);
  }, [admissionState, stepData, t]);

  // Con 0/1 hijo admitido o sin estado por hijo ⇒ el banner de siempre (la pantalla no cambia).
  if (admitidos.length <= 1 || !hayEstadoPorHijo(admitidos)) {
    return <SigningChildrenBanner />;
  }

  const pendientes = hijosPendientesEnPantalla(admitidos, screenId, resueltosLocales);
  const pendiente = pendientes[0] || null;

  return (
    <div
      data-testid="selector-firma-hijos"
      className="signing-child-banner"
      style={{
        background: '#e3f2fd', border: '1px solid #90caf9', borderRadius: 8,
        padding: '10px 14px', margin: '0 0 12px', color: '#0d47a1', fontSize: '0.92rem',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700, marginBottom: 8 }}>
        <i className="bi bi-people-fill" />
        <span>{t('signing.selector.title', { n: admitidos.length })}</span>
      </div>
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        {admitidos.map((h, i) => {
          const resuelto  = hijoResueltoEnPantalla(h, screenId, resueltosLocales);
          const activo    = h.enrollment_id && h.enrollment_id === selectedEnrollmentId;
          return (
            <button
              key={h.enrollment_id || i}
              type="button"
              data-testid="selector-firma-hijo"
              data-enrollment={h.enrollment_id || ''}
              data-resuelto={resuelto ? 'true' : 'false'}
              data-selected={activo ? 'true' : 'false'}
              aria-current={activo ? 'true' : undefined}
              onClick={() => { if (onSelect && h.enrollment_id) onSelect(h.enrollment_id); }}
              style={{
                display: 'inline-flex', alignItems: 'center', gap: 6,
                padding: '6px 12px', borderRadius: 999, cursor: 'pointer',
                border: activo ? '2px solid #0d47a1' : '1px solid #90caf9',
                background: activo ? '#bbdefb' : '#fff',
                color: '#0d47a1', fontWeight: activo ? 700 : 600, fontSize: '0.9rem',
              }}
            >
              <i className={resuelto ? 'bi bi-check-circle-fill' : 'bi bi-circle'}
                 style={{ color: resuelto ? '#2e7d32' : '#90a4ae' }} />
              <span>{h.nombre}</span>
            </button>
          );
        })}
      </div>
      <div data-testid="selector-firma-pendientes" style={{ marginTop: 8, fontWeight: 400 }}>
        {pendiente
          ? t('signing.selector.falta', { name: pendiente.nombre })
          : t('signing.selector.todos_listos')}
      </div>
    </div>
  );
}
