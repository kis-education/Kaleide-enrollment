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
  const {
    stepUpVerifiedUntil, stepUpCierre, touchActivity, revokeStepUpFresh,
    refrescoEnVuelo, refrescoUltimoFallo,
  } = useWizard();
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
  //
  // ★ 2026-09-22 (Diego, con captura del paso 4: contador 0:44 y botón en «Comprobando…»:
  // *«Me sigue sacando aunque pulse que sigo aquí. No sé por qué no es inmediato.»*) —
  // EL CERO NO ECHA A NADIE MIENTRAS HAY UNA PREGUNTA EN VUELO. Quien le echaba era su
  // PROPIO navegador: el cartel sale a 120 s (`AVISO_ANTES_S`), el clic llega a los ~44 s
  // y el viaje del «sigo aquí» cuesta lo que cuesta Apps Script (5.070 ms en un caso
  // medido, 60.919 ms en otro), así que el reloj local llegaba a cero ANTES de que
  // volviese la respuesta — cuando el servidor YA había escrito la marca nueva y venía a
  // contestar `step_up_restante_s: 600`. Se revocaba el espejo y salía la verja sobre una
  // ventana que estaba viva.
  //
  // La espera está ACOTADA POR CONSTRUCCIÓN: el botón tiene su propio plazo de 30 s
  // (`REFRESCO_SIGO_AQUI_TOPE_MS`), que suelta `refrescoEnVuelo` pase lo que pase ⇒ como
  // mucho la revocación se retrasa 30 s más allá del cero, nunca indefinidamente. Y en
  // cuanto deja de haber pregunta en vuelo se decide con lo que haya: si la ventana se
  // repuso, `restante` ya es > 0 y no se revoca nada; si no, se revoca como siempre.
  //
  // ⛔ ESTO NO AFLOJA NADA DEL SUELO. El servidor sigue siendo quien manda: toda mutación
  // pasa por `assertStepUpFresh_`, y un `STEPUP_REQUIRED` sigue poniendo el espejo a cero
  // por el `catch` que ya existe en `touchActivity`. Lo único que se retrasa es el espejo
  // LOCAL, y solo mientras hay en vuelo la pregunta cuyo resultado lo decide.
  useEffect(() => {
    if (refrescoEnVuelo) return;   // hay una pregunta en vuelo: su respuesta es quien decide
    if (restante !== null && restante <= 0) revokeStepUpFresh();
  }, [restante, refrescoEnVuelo, revokeStepUpFresh]);

  if (restante === null) return null;
  // Mientras se espera esa respuesta con el reloj ya en cero, el cartel NO se desmonta ni
  // se queda enseñando un «0:00» mudo: sigue diciendo que se está comprobando, que es lo
  // único cierto en ese instante. El botón ya lo dice por su lado (`aviso_comprobando`);
  // lo que faltaba era que el TEXTO no afirmara un cero que todavía no está decidido.
  const esperandoRespuesta = refrescoEnVuelo && restante <= 0;
  if (restante <= 0 && !esperandoRespuesta) return null;
  if (restante > AVISO_ANTES_S) return null;

  // Se capa a cero: con una pregunta en vuelo `restante` puede haber pasado de cero, y un
  // reloj en negativo («-1:-3») no lo lee nadie. Ese caso no pinta el reloj, pero el valor
  // se calcula igualmente y no puede quedar en una forma que no signifique nada.
  const restanteAPintar = Math.max(0, restante);
  const min = Math.floor(restanteAPintar / 60);
  const seg = restanteAPintar % 60;
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
      data-esperando={esperandoRespuesta ? '1' : '0'}
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
        {esperandoRespuesta
          ? t('stepup.aviso_esperando')
          : t(porTecho ? 'stepup.aviso_techo' : 'stepup.aviso_ventana', { reloj })}
        {/* 0º.tricies.quater — cuando el techo está a punto de alcanzarse el clic SÍ
            extiende, pero por un margen que a simple vista es imperceptible (el número
            sigue bajando casi igual), y hasta que esa respuesta no vuelve la pantalla
            sigue ofreciendo el botón como si fuera a servir de algo. Este aviso breve
            dice que el clic SÍ se registró aunque el reloj apenas se haya movido — no
            reemplaza al cambio a modo TECHO (que llega en cuanto el servidor lo confirma
            y ya oculta el botón), es lo que cubre el hueco ANTES de esa confirmación. */}
        {!porTecho && refrescoUltimoFallo && (
          <span data-testid="aviso-ventana-fallo" style={{ display: 'block', marginTop: 4, fontSize: '0.8rem' }}>
            {t('stepup.aviso_no_se_pudo')}
          </span>
        )}
      </span>
      {!porTecho && (
        <button
          type="button"
          data-testid="aviso-ventana-sigo"
          className="btn-primary-kis"
          disabled={refrescoEnVuelo}
          aria-busy={refrescoEnVuelo}
          onClick={touchActivity}
        >
          {refrescoEnVuelo ? t('stepup.aviso_comprobando') : t('stepup.aviso_sigo_aqui')}
        </button>
      )}
    </div>
  );
}
