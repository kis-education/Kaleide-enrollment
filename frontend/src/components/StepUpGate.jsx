import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { gasCall } from '../api';
import * as log from '../logger';
import LangToggle from './LangToggle';

const LOGO = 'https://raw.githubusercontent.com/kaleideschool/public/main/favicon.png';

// Espera CORTA entre peticiones de código, por RELOJ (no por el viaje del servidor).
// Sirve para no molestar y para no quemar el cupo de la familia a base de clics; no es
// una espera a que conteste nadie.
const REENVIO_ESPERA_S = 45;

/**
 * StepUpGate — DL-E39 ENMIENDA (gate de ENTRADA, Diego 2026-06-06).
 *
 * Modelo DEFINITIVO (supersede el step-up per-campo): para ACCEDER al wizard de
 * una solicitud RECUPERADA por magic-link hacen falta DOS cosas: el magic link
 * (resume_token, ya consumido al llegar aquí) Y un OTP corto (código de 6 díg.
 * enviado al buzón del expediente). Hasta superar el gate NO se muestra NINGÚN
 * paso ni dato. Tras introducir el OTP correcto → entra al wizard completo, con
 * los datos visibles con normalidad (sin enmascarado per-campo).
 *
 * Esta pantalla:
 *   1. Al montar, envía un código fresco SOLO si shouldAutoSend=true (la PRIMERA
 *      recuperación de la sesión, req. b). En reload/re-expiración (shouldAutoSend
 *      =false) NO auto-envía — muestra el botón "enviar código" para que el usuario
 *      lo pida (req. c, Diego 2026-06-07). El backend deriva email+group del bearer
 *      token SERVER-SIDE (KAL-4) — NUNCA mandamos el email del payload.
 *   2. Input de 6 dígitos + "Verificar" (verifyEmail, {stepup:true}). En éxito
 *      invoca onVerified() → el padre marca step-up fresco (10 min) y renderiza
 *      el wizard.
 *
 * ── PEDIR EL CÓDIGO NO BLOQUEA NADA (clase #32 «fire-and-forget», 2026-08-20) ──
 * MEDIDO en el registro real de Diego (2026-08-19): `sendVerificationCode` tardó
 * **77 s** de reloj (73 s de servidor: dos viajes al KMS para resolver de quién es el
 * buzón + uno para APUNTAR el envío). Y ese viaje **no manda el correo**: solo lo
 * apunta; lo manda después un repaso que tarda de media otros ~56 s. Mientras tanto
 * `codeSent` era falso ⇒ la casilla del código DESHABILITADA, «Acceder» DESHABILITADO
 * y «reenviar» también: la familia miraba una tarjeta congelada durante minuto y pico,
 * y el código podía llegarle al buzón ANTES de que la pantalla la dejara teclearlo.
 *
 * Ahora `sendCode` **dispara y sigue**: marca «enviado» y desbloquea la casilla EN EL
 * MISMO gesto, y la petición vuela por su cuenta. Reglas que sostienen eso:
 *   · El fallo NO se traga: si la petición acaba mal, el aviso optimista se SUSTITUYE
 *     por el error real (`errorMessage`). Un «te lo hemos enviado» que era mentira se
 *     corrige en pantalla, no se queda.
 *   · Un fallo NUNCA cierra el camino de entrar: no se borra lo tecleado ni se vuelve a
 *     deshabilitar la casilla — la familia puede tener en la mano un código de un envío
 *     anterior que sigue siendo válido.
 *   · «Reenviar» se limita por RELOJ (`REENVIO_ESPERA_S`, con cuenta atrás visible),
 *     no por el viaje. Es una decisión de no molestar y de no quemar el cupo de la
 *     familia (5-8/hora server-side), NO una espera al servidor.
 *   · Lo tecleado solo se borra cuando la familia PIDE otro código a propósito
 *     (`{manual:true}`); el auto-envío al montar no borra nada.
 *
 * KAL-7 / KAL-11: nunca metemos el código/token en la URL ni logueamos el código
 * completo.
 *
 * @param {Object}   props
 * @param {Function} props.onVerified     Callback tras verificación OK.
 * @param {Object}   props.tokenPayload   Bearer token a reenviar ({ resume_token }).
 *                   El backend deriva email+group del token; NUNCA mandamos email.
 * @param {boolean}  props.shouldAutoSend Auto-enviar el código al montar (true solo
 *                   la 1ª recuperación). Default true (retrocompat).
 * @param {Function} [props.onAutoSent]   Callback tras el auto-envío (el padre marca
 *                   la sesión como "ya auto-enviada" para no repetir en reloads).
 * @param {Object}   [props.envioPrevio]  `0º.tricies.nonies` — `{at, error}` del ÚLTIMO código
 *                   pedido en esta carga de página, guardado FUERA de este componente porque
 *                   la verja se REMONTA (ver el bloque de abajo). `at` = instante del envío;
 *                   `error` = el fallo cuya instancia ya no existe para contarlo.
 * @param {Function} [props.onEnvioPedido]  Se llama al pedir un código (el padre apunta el
 *                   instante para que sobreviva al remontaje).
 * @param {Function} [props.onEnvioFallido] Se llama si esa petición acaba mal, con el texto.
 */
export default function StepUpGate({
  onVerified, tokenPayload = {}, shouldAutoSend = true, onAutoSent,
  envioPrevio = null, onEnvioPedido, onEnvioFallido,
}) {
  const { t } = useTranslation();

  // ── `0º.tricies.nonies` (2026-08-22) — LA VERJA SE REMONTA, Y ANTES LO OLVIDABA TODO ──────
  // Al entrar por el enlace, `WizardPage` monta esta verja (que auto-envía el código), y acto
  // seguido su efecto de rehidratación pone `rehydrating=true` ⇒ el padre devuelve el loader
  // neutro y ESTA instancia se DESMONTA. Cuando la hidratación vuelve (15-40 s), se monta una
  // SEGUNDA instancia con todo su estado local a cero: decía «pulsa para recibir tu código»,
  // con la casilla DESHABILITADA y el botón «Enviar» LIBRE — mientras el primer código ya iba
  // camino del buzón. La familia no tenía más remedio que pulsar para poder teclear, y ese
  // segundo envío INVALIDA al primero (el servidor guarda un solo código por buzón).
  //
  // Diego (2026-08-22): «Si acceder vía enlace automáticamente envía otp, debe informar de
  // ello.» ⇒ se conserva el auto-envío (quitarlo añadiría a TODA familia el minuto y pico que
  // tarda el envío, y ese envío ya está en marcha mientras rehidrata) y se hace que la verja
  // RECUERDE: el hecho vive en `WizardContext` y entra aquí por `envioPrevio`.
  // ⛔ La marca CADUCA con el propio código. El servidor lo guarda 10 min (`cache.put(codeKey,
  // code, 600)`), así que pasados esos 10 min decirle a la familia «introduce el código que te
  // hemos enviado» sería mentira — el que tiene ya no vale. Sin este límite, la verja que
  // reaparece tras 10 min de inactividad heredaría un «enviado» viejo en vez de pedirle que
  // pulse (req. c). Fuera de la vigencia, comportamiento EXACTO de antes de este cambio.
  const MARCA_VIGENCIA_MS = 10 * 60 * 1000;
  const vigente      = (ts) => !!ts && (Date.now() - ts) < MARCA_VIGENCIA_MS;
  const yaPedidoAt   = vigente(envioPrevio && envioPrevio.at) ? envioPrevio.at : null;
  const falloPrevio  = vigente(envioPrevio && envioPrevio.errorAt) ? (envioPrevio.error || '') : '';
  const restanteDe   = (at) => (at ? Math.max(0, REENVIO_ESPERA_S - Math.floor((Date.now() - at) / 1000)) : 0);

  const [verifying, setVerifying] = useState(false);
  const [codeSent,  setCodeSent]  = useState(!!yaPedidoAt);
  const [code,      setCode]      = useState('');
  const [err,       setErr]       = useState(falloPrevio);
  const [info,      setInfo]      = useState(yaPedidoAt ? t('stepup.code_sent') : '');
  // Segundos que faltan para poder volver a pedir el código. Cuenta atrás visible. Arranca
  // donde la dejó la instancia anterior: si no, el remontaje regalaba un botón libre y con él
  // el segundo código que pisa al primero.
  const [espera,    setEspera]    = useState(restanteDe(yaPedidoAt));
  // Evita doble envío en el StrictMode double-mount de dev y en re-renders.
  const autoSentRef = useRef(false);
  const esperaRef   = useRef(null);

  const pararEspera = () => {
    if (esperaRef.current) { clearInterval(esperaRef.current); esperaRef.current = null; }
  };
  // `segundos` permite REANUDAR la cuenta atrás donde la dejó la instancia anterior tras el
  // remontaje; sin argumento arranca entera, como siempre.
  const arrancarEspera = (segundos = REENVIO_ESPERA_S) => {
    pararEspera();
    if (segundos <= 0) { setEspera(0); return; }
    setEspera(segundos);
    esperaRef.current = setInterval(() => {
      setEspera(s => {
        if (s <= 1) { pararEspera(); return 0; }
        return s - 1;
      });
    }, 1000);
  };
  // Al desmontar (la verja se cierra en cuanto se entra) no queda ningún temporizador vivo.
  useEffect(() => pararEspera, []);

  // ── `0º.tricies.nonies` — UN FALLO QUE LLEGA TARDE TAMBIÉN SE PINTA ────────────────────
  // El caso que faltaba: el auto-envío lo dispara la instancia 1, la petición tarda, y para
  // cuando el servidor rechaza, esa instancia YA está desmontada por la rehidratación. Su
  // `.catch` sigue corriendo (el cierre sobrevive) pero sus `setErr`/`setEspera` no pintan
  // nada — y la instancia 2, montada con «te hemos enviado un código», se quedaba diciendo
  // una mentira, con el botón en su espera, ante un código que NUNCA salió.
  // Por eso el fallo viaja por el contexto y esta instancia lo adopta cuando llega.
  const falloAplicadoRef = useRef(null);
  const errorAtActual = (envioPrevio && envioPrevio.errorAt) || null;
  useEffect(() => {
    if (!errorAtActual || falloAplicadoRef.current === errorAtActual) return;
    falloAplicadoRef.current = errorAtActual;
    if (!vigente(errorAtActual)) return;
    setInfo('');
    setErr((envioPrevio && envioPrevio.error) || t('stepup.err_generic'));
    // Sin código en vuelo no hay a quién esperar: se puede volver a pedir ya.
    pararEspera();
    setEspera(0);
    // ⛔ Lo tecleado y la casilla NO se tocan: la familia puede tener en la mano un código
    // válido de un envío anterior, y quitárselo por el fallo del último la deja fuera.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [errorAtActual]);

  const errorMessage = (e) => {
    const codeOrMsg = e?.code || e?.message || '';
    if (/TOO_MANY_ATTEMPTS/.test(codeOrMsg)) return t('stepup.err_too_many_attempts');
    if (/RATE_LIMITED/.test(codeOrMsg))      return t('stepup.err_rate_limited');
    return e?.message || t('stepup.err_generic');
  };

  /**
   * Pide un código y SIGUE — no espera a que el servidor conteste para desbloquear.
   *
   * @param {Object}  [opts]
   * @param {boolean} [opts.manual] La familia lo PIDIÓ a propósito (botón). Solo
   *                  entonces se borra lo tecleado: el código anterior ya no vale y
   *                  dejar el valor viejo en pantalla confunde (Diego 2026-06-07). El
   *                  auto-envío al montar NO borra nada.
   */
  const sendCode = ({ manual = false } = {}) => {
    if (manual) setCode('');
    setErr('');
    // ── FIRE-AND-FORGET (clase #32) ──────────────────────────────────────────
    // Se dice «enviado» y se desbloquea la casilla EN EL MISMO gesto. La petición
    // vuela por su cuenta; su resultado solo puede CORREGIR lo dicho, nunca retrasarlo.
    setCodeSent(true);
    setInfo(t('stepup.code_sent'));
    arrancarEspera();
    // `0º.tricies.nonies`: el hecho sale del componente ANTES del viaje, para que un remontaje
    // a mitad de la petición encuentre la verja ya en «enviado» y con su cuenta atrás corriendo.
    if (onEnvioPedido) onEnvioPedido();
    // NO mandamos email — el backend lo deriva del token (server-side, KAL-4).
    gasCall('sendVerificationCode', { stepup: true, ...tokenPayload })
      .then(() => { log.info('StepUpGate: código de entrada solicitado'); })
      .catch(e => {
        log.error('StepUpGate: sendVerificationCode failed', { message: e.message });
        // El aviso optimista era mentira: se retira y se pone el error real. Lo que NO
        // se toca es el camino de ENTRAR — ni se borra lo tecleado ni se vuelve a
        // deshabilitar la casilla: la familia puede tener en la mano un código válido
        // de un envío anterior, y quitárselo por un fallo del último intento la deja
        // fuera sin motivo.
        setInfo('');
        setErr(errorMessage(e));
        // Y sin código en vuelo no hay a quién esperar: se puede reintentar ya.
        pararEspera();
        setEspera(0);
        // `0º.tricies.nonies`: el fallo lo provoca una instancia que puede estar ya
        // DESMONTADA (el remontaje de arriba) — sin sacarlo del componente, sus `setErr` y
        // `setEspera` se pierden y la familia se queda con un «te lo hemos enviado» falso y
        // el botón bloqueado 45 s por un código que nunca salió.
        if (onEnvioFallido) onEnvioFallido(errorMessage(e));
      });
  };

  // Auto-envío al montar SOLO la primera recuperación (shouldAutoSend). En reload de
  // una sesión recuperada o re-expiración de frescura (shouldAutoSend=false) NO se
  // auto-envía: el gate aparece con el botón "enviar código" para que el usuario lo
  // pida (req. c). autoSentRef cubre el StrictMode double-mount.
  useEffect(() => {
    if (autoSentRef.current) return;
    autoSentRef.current = true;
    // `0º.tricies.nonies`: esta instancia puede ser la SEGUNDA (el remontaje). Si ya se pidió
    // un código, se reanuda su cuenta atrás en vez de ofrecer el botón libre. No se re-envía
    // nada: solo se recupera lo que la instancia anterior sabía.
    const restante = restanteDe(yaPedidoAt);
    if (restante > 0) arrancarEspera(restante);
    if (shouldAutoSend) {
      sendCode({ manual: false });
      if (onAutoSent) onAutoSent();
    }
    // OTP-WARM pieza A (decisión Diego 2026-06-11: "por qué no está el wizard
    // precargando datos… sólo se pone a hidratar cuando introduzco el otp"): mientras
    // el usuario teclea el código, el servidor cocina el snapshot del hydrate y lo
    // deja en la cache warm (warmSession devuelve SOLO {ok,warmed} — cero PII pre-OTP;
    // gate KAL-4 por resume_token + rate-limit server-side 120s/grupo). Fire-and-forget:
    // su fallo no afecta al flujo (el hydrate post-OTP seguiría el camino frío normal).
    gasCall('warmSession', { ...tokenPayload })
      .then(r => log.info('StepUpGate: warmSession', { warmed: !!(r && r.warmed), reason: (r && r.reason) || null }))
      .catch(e => log.warn('StepUpGate: warmSession failed (best-effort)', { message: e.message }));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const verify = async () => {
    const clean = (code || '').trim();
    if (!/^\d{6}$/.test(clean)) { setErr(t('stepup.err_code_format')); return; }
    setErr(''); setInfo(''); setVerifying(true);
    try {
      await gasCall('verifyEmail', { code: clean, stepup: true, ...tokenPayload });
      log.success('StepUpGate: verificación de entrada OK');
      setCode('');
      onVerified();
    } catch (e) {
      log.error('StepUpGate: verifyEmail failed', { message: e.message });
      setErr(errorMessage(e));
      setVerifying(false);
    }
  };

  return (
    <div style={{
      minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center',
      padding: 16, background: 'var(--bg, #f8f9fa)',
    }}>
      <div className="kis-card" style={{
        maxWidth: 440, width: '100%', padding: '28px 26px', textAlign: 'center',
      }}>
        <div style={{ display: 'flex', justifyContent: 'flex-end', marginBottom: 4 }}>
          <LangToggle />
        </div>
        <img src={LOGO} alt="KIS" style={{ height: 48, marginBottom: 14 }} />

        <div style={{ display: 'inline-flex', alignItems: 'center', gap: 8, marginBottom: 8 }}>
          <i className="bi bi-shield-lock-fill" style={{ color: 'var(--teal-dk)', fontSize: '1.3rem' }} />
          <strong style={{ color: 'var(--teal-dk)', fontSize: '1.1rem' }}>
            {t('stepup.gate_title')}
          </strong>
        </div>
        <p style={{ color: 'var(--muted)', fontSize: '0.9rem', marginBottom: 10 }}>
          {t(codeSent ? 'stepup.gate_subtitle' : 'stepup.gate_subtitle_unsent')}
        </p>
        <p style={{ color: 'var(--muted)', fontSize: '0.8rem', marginBottom: 18 }}>
          <i className="bi bi-clock me-1" />{t('stepup.gate_duration_note')}
        </p>

        {/* OTP-TRIGGER: cuando NO se auto-envió (reload / re-expiración), invita a
            pedir el código manualmente. Se oculta en cuanto se envía uno. */}
        {!codeSent && (
          <p style={{ color: 'var(--teal-dk)', fontSize: '0.85rem', marginBottom: 16 }}>
            <i className="bi bi-envelope me-1" />{t('stepup.press_to_send')}
          </p>
        )}

        <div style={{ display: 'flex', flexDirection: 'column', gap: 10, alignItems: 'center' }}>
          <input
            type="text"
            inputMode="numeric"
            autoComplete="one-time-code"
            maxLength={6}
            className="form-control"
            style={{ maxWidth: 180, letterSpacing: '0.35em', textAlign: 'center', fontWeight: 700, fontSize: '1.15rem' }}
            placeholder="••••••"
            value={code}
            disabled={!codeSent || verifying}
            onChange={e => setCode(e.target.value.replace(/\D/g, '').slice(0, 6))}
            onKeyDown={e => { if (e.key === 'Enter') verify(); }}
          />
          <button
            className="btn-primary-kis"
            style={{ minWidth: 180 }}
            onClick={verify}
            disabled={verifying || !codeSent || code.length !== 6}
          >
            {verifying
              ? <><span className="spinner-border spinner-border-sm me-2" />{t('stepup.verifying')}</>
              : <><i className="bi bi-box-arrow-in-right me-1" />{t('stepup.gate_enter')}</>}
          </button>
          {/* La espera es por RELOJ, no por el viaje: mientras corre la cuenta atrás el
              botón dice cuánto falta, así la familia sabe que no está roto. */}
          <button
            type="button"
            data-testid="stepup-reenviar"
            className="btn btn-link btn-sm p-0"
            style={{ fontSize: '0.85rem' }}
            onClick={() => sendCode({ manual: true })}
            disabled={espera > 0}
          >
            {espera > 0
              ? t('stepup.resend_in', { s: espera })
              : (codeSent ? t('stepup.resend') : t('stepup.send'))}
          </button>
        </div>

        {info && (
          <div className="mt-3" data-testid="stepup-enviado" style={{ color: 'var(--teal-dk)', fontSize: '0.84rem' }}>
            <i className="bi bi-check-circle me-1" />{info}
          </div>
        )}
        {err && (
          <div className="field-error mt-3 p-2 rounded" data-testid="stepup-error" style={{ background: '#ffeaea', fontSize: '0.85rem' }}>
            {err}
          </div>
        )}
      </div>
    </div>
  );
}
