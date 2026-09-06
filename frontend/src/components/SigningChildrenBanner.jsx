import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useWizard } from '../context/WizardContext';
import { hermanosConSituacion } from '../lib/hermanos';

/**
 * `0º.tricies.novemtricies` §UX (2026-09-06) — durante la firma (Steps 8-11) la familia no
 * sabía de qué hijo era la matrícula que estaba firmando. Pregunta de Diego, 2026-08-26:
 * «se puede dar el caso que el tutor acceda con un enlace de uno de ellos ya con los dos
 * autorizados por la escuela (admitidos). ¿Qué ve el tutor en ese caso? ¿Los dos expedientes?
 * ¿Uno solo? ¿Debe seguir los dos enlaces?»
 *
 * ⛔ NO intenta adivinar A CUÁL de los admitidos corresponde la sesión de firma ACTIVA en
 * este instante. Eso exigiría cruzar el `signing_token` en curso con el ancla real de la
 * sesión (`sysSigningSessions.entity_id`, DL-S105 §10), y el lector que sirve las sesiones
 * de firma al asistente (`enr_wizardDatosDeFirma`, kis-app kms-server/enr/wizard-gateway.gs)
 * hoy filtra `entity_id === enrollmentGroupId` — SOLO encuentra las sesiones ancladas al
 * GRUPO (el modelo anterior a DL-S105 §10). Las sesiones reales, creadas desde ese cambio,
 * anclan a `entity_id = enrollmentId` de CADA hijo (`enr_initiateSigningSession`,
 * `sys_createSigningSession_({entity_id: enrollmentId, ...})`, wizard-firma.gs:786-789) — y
 * ÉSAS el lector de arriba no las ve. Ese hueco lo reconoce el propio código del KMS
 * («divergencia… es anterior a este cambio: cerrarla es otro trabajo y necesita medirse
 * contra datos reales antes de tocar el puente 7→8 de una familia») y NO se cierra aquí: es
 * KMS, toca el puente de entrada a la firma, y exige su propia medición contra datos reales.
 *
 * Con eso fuera de alcance esta noche, lo que SÍ se puede decir con seguridad —usando SOLO
 * `admissionState.por_alumno`, que ya llega al cliente y es fiable— es CUÁNTOS hijos están
 * admitidos y CÓMO SE LLAMAN:
 *   - con UNO solo, no hay ambigüedad posible: es ÉSE.
 *   - con VARIOS, se dice la verdad que sí se sabe (cuántos y quiénes) y se explica el
 *     mecanismo (el asistente los lleva de uno a otro automáticamente) — sin fingir saber
 *     cuál es "ahora".
 */
export default function SigningChildrenBanner() {
  const { t } = useTranslation();
  const { admissionState, stepData } = useWizard();

  const admitidos = useMemo(() => {
    const todos = hermanosConSituacion(admissionState?.por_alumno, stepData?.persons, t);
    return todos.filter(h => h.admitido);
  }, [admissionState, stepData, t]);

  if (!admitidos.length) return null;

  if (admitidos.length === 1) {
    return (
      <div
        data-testid="firma-hermano-unico"
        className="signing-child-banner"
        style={{
          background: '#e3f2fd', border: '1px solid #90caf9', borderRadius: 8,
          padding: '10px 14px', margin: '0 0 12px', color: '#0d47a1', fontSize: '0.92rem',
          display: 'flex', alignItems: 'center', gap: 8,
        }}
      >
        <i className="bi bi-person-check-fill" />
        <span>{t('signing.child.single', { name: admitidos[0].nombre })}</span>
      </div>
    );
  }

  return (
    <div
      data-testid="firma-hermanos-lista"
      className="signing-child-banner"
      style={{
        background: '#e3f2fd', border: '1px solid #90caf9', borderRadius: 8,
        padding: '10px 14px', margin: '0 0 12px', color: '#0d47a1', fontSize: '0.92rem',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontWeight: 700 }}>
        <i className="bi bi-people-fill" />
        <span>{t('signing.child.multiple_title', { n: admitidos.length })}</span>
      </div>
      <div style={{ marginTop: 6 }}>
        {admitidos.map((h, i) => (
          <div key={h.enrollment_id || i} data-testid="firma-hermano-item" style={{ fontWeight: 600 }}>
            {h.nombre}
          </div>
        ))}
      </div>
      <div style={{ marginTop: 6, fontWeight: 400 }}>{t('signing.child.multiple_body')}</div>
    </div>
  );
}
