import { useTranslation } from 'react-i18next';
import { useWizard } from '../context/WizardContext';

/**
 * 0º.tricies.octies (B) — QUE UN GUARDADO MUERTO SE VEA.
 *
 * El problema que cierra: `enr.wizardSaveStep` y sus hermanas NO escriben — APUNTAN el
 * trabajo y contestan `{ok:true, queued:true}`. La pantalla se bloquea diciendo «Esta
 * sección está guardada y bloqueada», la familia avanza, rellena salud, contesta el
 * cuestionario… y si el trabajo muere en la cola minutos después, NADIE se lo dice: el
 * rechazo ocurre cuando la respuesta ya se dio, así que no hay a quién decírselo ahí.
 * Medido el 2026-08-22: un segundo alumno dado de alta que no existía al recargar.
 *
 * ⛔ NO ofrece «Reintentar», y es a propósito: el asistente no sabe por qué murió, y
 * volver a mandar lo mismo puede morir igual. Lo que sirve es que la familia ABRA ese
 * paso y lo guarde otra vez — un guardado nuevo apaga el aviso solo (el servidor solo
 * mira el ÚLTIMO trabajo de cada paso).
 *
 * ⛔ Y NO se puede cerrar: mientras el dato no esté guardado, el aviso es la verdad.
 */
export default function AvisoGuardadosQueNoLlegaron() {
  const { t } = useTranslation();
  const { guardadosSinAterrizar } = useWizard();
  const pasos = Array.isArray(guardadosSinAterrizar) ? guardadosSinAterrizar : [];
  if (pasos.length === 0) return null;

  // El servidor manda CÓDIGOS de paso; el texto lo pone aquí cada idioma. Un código que no
  // conozcamos se muestra tal cual antes que callarse: callar es el defecto que esto cierra.
  const nombres = pasos.map((c) => t(`guardado_no_llego.paso.${c}`, { defaultValue: c }));

  return (
    <div
      className="alert alert-danger d-flex align-items-start gap-2 mt-3"
      role="alert"
      data-testid="aviso-guardado-no-llego"
    >
      <span aria-hidden="true">⚠️</span>
      <div>
        <strong>{t('guardado_no_llego.titulo')}</strong>
        <div data-testid="aviso-guardado-no-llego-pasos">
          {t('guardado_no_llego.cuerpo', { pasos: nombres.join(', ') })}
        </div>
      </div>
    </div>
  );
}
