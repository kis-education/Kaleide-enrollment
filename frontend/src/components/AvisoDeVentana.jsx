import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useWizard, AVISO_ANTES_S } from '../context/WizardContext';

/**
 * AvisoDeVentana — «¿sigues ahí?», dos minutos antes de que caduque la sesión.
 *
 * Diego, 2026-08-20: *«No me parece mal un aviso dos minutos antes que el usuario tenga
 * que aceptar, pero solo si no ha estado haciendo clic, pasando de pantallas, etc.»*
 *
 * Lo segundo NO necesita una condición aparte, y por eso no la lleva: la actividad
 * REINICIA el contador (`touchActivity` → `refrescarVentana`), así que bajar de dos
 * minutos ya significa, por construcción, que nadie ha tocado la pantalla en ocho. Meter
 * además un «y si no hubo actividad» sería una segunda fuente de verdad sobre lo mismo,
 * y dos fuentes de verdad divergen.
 *
 * El botón es explícito («sigo aquí») porque un aviso que se quita solo no informa de
 * nada. Pulsarlo es actividad, así que reinicia el contador por el mismo camino que
 * cualquier otro clic — no hay una vía especial para este botón.
 *
 * ⛔ NO decide nada por su cuenta: quien manda es la marca del servidor. Esto solo pinta
 * el tiempo que el servidor dice que queda. Si la ventana caduca, el gate de entrada
 * (`mustPassEntryGate` en `WizardPage`) se cierra y pide el código, como siempre.
 *
 * Tiene SU PROPIO reloj de un segundo, y no el ticker de 30 s del contexto: para avisar
 * «dos minutos antes» hacen falta segundos, y subir la frecuencia del ticker del contexto
 * re-renderizaría el asistente entero cada segundo. Aquí solo se re-renderiza este
 * cartel.
 */
export default function AvisoDeVentana() {
  const { t } = useTranslation();
  const { stepUpVerifiedUntil, stepUpCierre, touchActivity, revokeStepUpFresh } = useWizard();
  const [ahora, setAhora] = useState(() => Date.now());

  useEffect(() => {
    const id = setInterval(() => setAhora(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);

  const restante = stepUpVerifiedUntil ? Math.round((stepUpVerifiedUntil - ahora) / 1000) : null;

  // Cuando la cuenta llega a cero, el candado se echa EN ESE MOMENTO. Sin esto, el
  // asistente seguiría pintado hasta el siguiente latido del contexto (30 s), y la familia
  // vería una pantalla que ya no sirve: el primer guardado que intentase sería rechazado.
  // Es una REVOCACIÓN, nunca una extensión — solo actúa sobre lo que el espejo local ya
  // da por caducado, y el servidor sigue siendo quien manda.
  useEffect(() => {
    if (restante !== null && restante <= 0) revokeStepUpFresh();
  }, [restante, revokeStepUpFresh]);

  if (restante === null) return null;
  if (restante <= 0 || restante > AVISO_ANTES_S) return null;

  const min = Math.floor(restante / 60);
  const seg = restante % 60;
  const reloj = `${min}:${String(seg).padStart(2, '0')}`;

  // ★ 2026-08-20 (Diego: *«es importante avisar que se va a cerrar por seguridad»*) — DOS avisos,
  // y la diferencia no es de redacción: es que el botón CAMBIA DE SENTIDO.
  //   · INACTIVIDAD → «¿sigues ahí?» + «Sigo aquí», que de verdad reinicia el contador.
  //   · TECHO (las 2 h desde que se tecleó el código) → ese botón NO PUEDE funcionar: el
  //     refresco devolverá 0 y la familia saldría igual. Ofrecerlo sería prometerle que se
  //     queda y echarla dos minutos después, que es peor que no avisar. Así que aquí NO hay
  //     botón: se dice que la sesión se cierra POR SEGURIDAD y que se le pedirá el código
  //     otra vez — que es exactamente lo que va a pasar, y no una avería.
  // Cuál de los dos manda lo dice el SERVIDOR (`step_up_cierre`), no una resta hecha aquí.
  const porTecho = stepUpCierre === 'TECHO';

  return (
    <div
      data-testid="aviso-ventana"
      data-cierre={porTecho ? 'TECHO' : 'INACTIVIDAD'}
      role="status"
      style={{
        position: 'fixed', left: 16, right: 16, bottom: 16, zIndex: 1080,
        maxWidth: 520, margin: '0 auto', padding: '12px 14px', borderRadius: 10,
        background: '#fff8e1', border: '1px solid #ffe08a',
        boxShadow: '0 6px 20px rgba(0,0,0,.12)',
        display: 'flex', alignItems: 'center', gap: 12, flexWrap: 'wrap',
      }}
    >
      <i
        className={porTecho ? 'bi bi-shield-lock' : 'bi bi-clock-history'}
        style={{ color: '#8a6d00', fontSize: '1.2rem' }}
      />
      <span style={{ flex: 1, minWidth: 200, fontSize: '0.9rem', color: '#5f4b00' }}>
        {t(porTecho ? 'stepup.aviso_techo' : 'stepup.aviso_ventana', { reloj })}
      </span>
      {!porTecho && (
        <button
          type="button"
          data-testid="aviso-ventana-sigo"
          className="btn-primary-kis"
          onClick={touchActivity}
        >
          {t('stepup.aviso_sigo_aqui')}
        </button>
      )}
    </div>
  );
}
