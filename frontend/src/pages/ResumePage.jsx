import { useEffect, useState } from 'react';
import { useParams, useSearchParams, useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { gasCall } from '../api';
import { useWizard } from '../context/WizardContext';
import { clasificarFalloDeEntrada, seReintentaSolo } from '../lib/fallosDeEntrada';
import * as log from '../logger';

/**
 * /resume/:token — magic-link landing.
 *
 * KAL-7 (security audit 2026-05-29): the resume_token used to remain visible
 * in the URL bar (browser history, screen shares, screenshots, Referer
 * header), which is a leak of a long-lived bearer secret. We now:
 *   1. Read the token from useParams() once.
 *   2. Strip it from the URL immediately via window.history.replaceState
 *      (path becomes `/#/apply` — no token).
 *   3. Pass the token to the resumeSession call from the closure (the
 *      WizardContext.hydrateFromResume stores it in sessionStorage for
 *      subsequent API calls).
 * Combined with the <meta name="referrer" content="no-referrer"> in
 * frontend/index.html (also KAL-7), this closes both the visual leak and
 * the Referer leak.
 *
 * KAL-11: previously logged the full resume_token via log.info — now logs
 * only the first 8 chars + '...' so the token is not reconstructable from
 * the dev console log stream.
 */
// E (carga por etapas): el hydrate tarda ~30s; en vez de un texto único, el mensaje
// rota por estas etapas (i18n) para dar sensación de avance. Topado al último índice
// (no da la vuelta). El intervalo se limpia en cleanup y al resolver/rechazar la promesa.
const RESUME_STAGE_KEYS = ['resume.stage.verifying', 'resume.stage.recovering', 'resume.stage.almost'];

// WIZARD-UX TASK-2 (Diego 2026-06-13): barra de progreso durante la hidratación post
// magic-link. El hydrate consolidado tarda ~30s de media (medido); el usuario solo veía
// un spinner + texto rotativo, sin noción de "cuánto queda". Estimamos el tiempo medio y
// avanzamos la barra ASINTÓTICAMENTE hacia el final SIN completarla en falso: se acerca a
// ~95% siguiendo una curva que desacelera (1 - e^-t/τ), de modo que si tarda más de lo
// estimado NUNCA "miente" llegando al 100%. Al resolver el hydrate, snap a 100% antes de
// navegar. Es puramente UX de carga — no toca auth ni datos.
const RESUME_EST_MS = 30000;   // duración media estimada del hydrate (ms)
const RESUME_TICK_MS = 250;    // refresco de la barra
const RESUME_ASYMPTOTE = 0.95; // techo del progreso "en curso" (nunca 100% hasta resolver)

// ★ `0º.tricies.vicies.semel` (2026-08-25) — LA CARGA NO SE RINDE A LA PRIMERA.
//
// El navegador se rinde antes que el servidor: el registro real del 2026-08-25 enseña un
// `sendMagicLink` muerto con `network/fetch error: Load failed` a los **41,6 s** — y el correo
// SALIÓ igual, 2 minutos después. La hidratación pesa más que ese envío, así que cae por lo
// mismo. Hasta hoy ese parpadeo tiraba a la familia a la portada con un cartel FALSO.
//
// ⛔ El reintento NO es un retardo a ciegas ni una política de latencia: solo entra la clase
// de fallo «no hubo respuesta» (ver `lib/fallosDeEntrada.js`). Un enlace que el servidor
// RECHAZÓ por su nombre no se reintenta — se dice, y se ofrece la salida que corresponde.
//
// ⭐ Y reintentar DESDE ESTA MISMA PÁGINA es además lo que salva la entrada sin código: el
// intento que murió en el transporte SÍ llegó al servidor (por eso el correo salía), así que
// consumió la gracia del enlace y dejó la marca de step-up **atada a esta página viva**
// (`_markStepUpFresh_` con la huella `pv` que acuña `api.js` una vez por carga). Mientras no
// se recargue, esa marca sigue valiendo ⇒ el reintento entra SIN pedir código. Recargar o
// volver a abrir el enlace acuña otra huella y ahí sí se pide — eso es de diseño (2026-08-20).
const RESUME_REINTENTOS_MS = [1500, 4000]; // dos reintentos automáticos, con espera creciente

export default function ResumePage() {
  const { token } = useParams();
  const [searchParams] = useSearchParams();
  const navigate  = useNavigate();
  const { t, i18n } = useTranslation();
  const { hydrateFromResume, recoveredEmail, setRecoveryNonce } = useWizard();
  const [stage, setStage] = useState(0);
  // progress ∈ [0,1]; arranca en 0, se acerca asintóticamente a RESUME_ASYMPTOTE
  // mientras corre el hydrate, y salta a 1 al resolver (justo antes de navegar).
  const [progress, setProgress] = useState(0);
  // ★ `0º.tricies.vicies.semel` — el fallo se queda EN ESTA PÁGINA, con el token en la mano.
  // Irse a la portada era el defecto de fondo: allí el token ya no existe, así que la única
  // salida que se podía ofrecer era «pide otro enlace» — que ROTA el bueno.
  // `fallo` = null mientras carga; `{ clase, mensaje }` cuando ya no se puede seguir.
  const [fallo, setFallo] = useState(null);
  // Cuántos reintentos AUTOMÁTICOS se han gastado ya (se enseña en pantalla: «seguimos
  // cargando»), y el disparador del reintento que pide la familia con el botón.
  const [reintentoAuto, setReintentoAuto] = useState(0);
  const [intentoManual, setIntentoManual] = useState(0);

  // IDENTITY-FROM-LINK (2026-06-11): `?n=<email_id>` del magic link lleva la IDENTIDAD del
  // guardian (email_id, opaco, sin PII). Se captura aquí (en el hash, antes del scrub KAL-7
  // que reemplaza el hash por #/apply y lo elimina de la barra) y se PERSISTE en
  // sessionStorage (setRecoveryNonce) para sobrevivir a F5/incógnito y alimentar la
  // identidad en hydrate + actos de firma. El backend lo valida contra el grupo del
  // resume_token (KAL-4/5). NO es un bearer (no autoriza por sí solo). KAL-7: no se loguea
  // entero. La gracia OTP-skip YA NO viaja en `n` (se ancla al resume_token server-side).
  const linkN = searchParams.get('n') || null;

  useEffect(() => {
    if (!token) {
      log.warn('ResumePage: no token in URL, redirecting to /');
      navigate('/');
      return;
    }

    // KAL-7: scrub the token from the URL bar / history BEFORE any await.
    // HashRouter means the path lives in location.hash. Replace the hash with
    // '#/apply' so the address bar drops the resume token. The token is held
    // in the closure for the gasCall below and persisted in sessionStorage
    // by hydrateFromResume for follow-up API calls.
    try {
      const cleanUrl = window.location.pathname + window.location.search + '#/apply';
      window.history.replaceState(null, '', cleanUrl);
    } catch (e) {
      // replaceState can throw in very old browsers / sandboxed iframes — non-fatal.
      log.warn('ResumePage: history.replaceState failed (non-fatal)', { message: e.message });
    }

    // E: rota el mensaje de carga cada 7s, topado al último índice (no da la vuelta).
    const stageTimer = setInterval(() => {
      setStage(s => Math.min(s + 1, RESUME_STAGE_KEYS.length - 1));
    }, 7000);

    // WIZARD-UX TASK-2: barra de progreso asintótica. progress = ASYMPTOTE·(1 - e^-t/τ)
    // → crece rápido al principio y desacelera, sin alcanzar nunca el 100% mientras el
    // hydrate sigue en vuelo. τ se calibra para que a RESUME_EST_MS la barra esté ~al 86%
    // del techo (t=τ·2 ≈ duración estimada). Degrada con elegancia: si tarda más, sigue
    // acercándose al techo sin completarse en falso.
    const tau = RESUME_EST_MS / 2;
    const startedAt = Date.now();
    const progressTimer = setInterval(() => {
      const elapsed = Date.now() - startedAt;
      const p = RESUME_ASYMPTOTE * (1 - Math.exp(-elapsed / tau));
      setProgress(prev => (p > prev ? p : prev)); // monótona — nunca retrocede
    }, RESUME_TICK_MS);

    // IDENTITY-FROM-LINK: persiste el `n` (email_id) en sessionStorage → la identidad del
    // enlace sobrevive a F5/incógnito y se reenvía en getAdmissionState + actos de firma.
    if (linkN) setRecoveryNonce(linkN);

    // El efecto puede desmontarse (o volver a arrancar con el botón) mientras hay una
    // hidratación en vuelo: `cancelado` impide que la respuesta tardía pinte encima.
    let cancelado = false;
    let reintentoTimer = null;
    const tokenPreview = String(token).slice(0, 8) + '...';

    const parar = () => { clearInterval(stageTimer); clearInterval(progressTimer); if (reintentoTimer) clearTimeout(reintentoTimer); };

    /**
     * UN intento de hidratación. `nAuto` = cuántos reintentos automáticos se llevan gastados.
     * ⛔ El token NO cambia entre intentos: se reintenta con el MISMO enlace, nunca se pide
     * uno nuevo (pedirlo lo ROTA y deja muerto el que la familia tiene en el correo).
     */
    const intentar = (nAuto) => {
      log.info('ResumePage: calling hydrateSession', { resume_token_preview: tokenPreview, reintento: nAuto });
      // DL-B §1 — hidratación CONSOLIDADA (hydrateSession): UNA llamada trae datos 11
      // pasos + lookups + qbResponses + admission + signing_context + billing_splits +
      // live_version. IDENTITY-FROM-LINK: `n` (email_id del enlace) resuelve la identidad
      // del guardian server-side (KAL-4); la gracia OTP-skip se ancla al resume_token. El
      // recovered_email persistido queda como compat secundario.
      gasCall('hydrateSession', { resume_token: token, recovered_email: recoveredEmail || undefined, n: linkN || undefined, language: i18n.language })
        .then(data => {
          if (cancelado) return;
          // Post-DL-E15 shape uses `group`; legacy responses still use `application`.
          const grp = data.group || data.application;
          log.success('ResumePage: resumeSession succeeded', {
            enrollment_group_id: grp?.enrollment_group_id || grp?.application_id,
            submitted_at:        grp?.submitted_at,
          });
          hydrateFromResume(data);
          // SPEC-WIZ-WARMUP-V2.1 (2026-06-12): kick fire-and-forget del precalentado
          // TAMBIEN al entrar — cubre las entradas sin kick de envio (email de la
          // Carta, link antiguo, click mas rapido que el minuto muerto): mientras la
          // familia recorre los pasos, el backend cocina docs/members/hydrate para
          // el paso 10. Gate KAL-4 + rate-limit (120s/grupo) server-side; best-effort.
          // Retraso de 4s: con todo ya caliente el kick es casi no-op server-side, pero
          // su respuesta ocupaba una conexión del navegador compitiendo con las cargas
          // inmediatas del usuario (log Diego 18:07: getDocument server 1,2s pero 13,7s
          // percibidos por contención del transporte). Primero el usuario, luego el warm.
          setTimeout(() => { gasCall('warmBundle', { resume_token: token, n: linkN || undefined }).catch(() => {}); }, 4000);
          log.info('ResumePage: hydration complete, navigating to /apply');
          parar();
          setProgress(1); // TASK-2: snap a 100% al resolver (la única vez que llega al final)
          navigate('/apply', { replace: true });
        })
        .catch(err => {
          if (cancelado) return;
          // ⛔ AQUÍ ESTABA EL DEFECTO: un solo `catch` que mandaba TODO a la portada con
          // «el enlace puede haber caducado». La clase la decide UN SOLO SITIO
          // (`lib/fallosDeEntrada.js`), y de ella depende la salida que se ofrece.
          const clase = clasificarFalloDeEntrada(err);
          log.error('ResumePage: hydrateSession failed', { message: err.message, code: err.code || null, clase, reintento: nAuto });

          if (seReintentaSolo(clase) && nAuto < RESUME_REINTENTOS_MS.length) {
            // Todavía queda margen: se REINTENTA con el mismo enlace y se DICE en pantalla.
            setReintentoAuto(nAuto + 1);
            reintentoTimer = setTimeout(() => { if (!cancelado) intentar(nAuto + 1); }, RESUME_REINTENTOS_MS[nAuto]);
            return;
          }

          parar();
          if (clase === 'ENLACE_NO_VALE') {
            // La ÚNICA clase en la que pedir otro enlace es la salida correcta: el que la
            // familia tiene no la va a llevar a ninguna parte. La portada ya trae el cartel
            // y la casilla del correo (`landing.resume_error`).
            navigate('/?resume_error=1', { replace: true });
            return;
          }
          // Las otras dos se quedan AQUÍ, con el token vivo, y ofrecen reintentar.
          setFallo({ clase, mensaje: (err && err.message) || '' });
        });
    };

    intentar(0);

    return () => { cancelado = true; parar(); };
  }, [token, intentoManual]); // eslint-disable-line

  // TASK-2: % entero para la barra + aria. En curso se topa a RESUME_ASYMPTOTE (95%);
  // solo el snap final (progress===1) muestra 100%.
  const pct = Math.round(progress * 100);

  // ★ `0º.tricies.vicies.semel` — LA PANTALLA DEL FALLO, con el enlace todavía en la mano.
  //
  // ⛔ AQUÍ NO SE OFRECE PEDIR OTRO ENLACE, y no es un olvido: pedirlo ROTA el token y deja
  // muerto el que la familia acaba de recibir (2 minutos de espera, medidos) para chocar con
  // lo mismo. La única clase en la que pedir otro es la salida correcta —el enlace muerto de
  // verdad— ni siquiera llega hasta aquí: se va a la portada, que ya tiene ese cartel y esa
  // casilla. Lo que se ofrece aquí es REINTENTAR CON EL MISMO ENLACE.
  if (fallo) {
    const esNombrado = fallo.clase === 'ERROR_NOMBRADO';
    return (
      <div style={{ textAlign: 'center', paddingTop: 80, padding: '80px 24px 0' }} data-testid="resume-fallo">
        <div className="kis-card" style={{ maxWidth: 520, margin: '0 auto', textAlign: 'left' }}>
          <h2 style={{ fontSize: '1.15rem', marginBottom: 12 }}>
            <i className="bi bi-exclamation-triangle-fill" style={{ color: '#f37021', marginRight: 8 }} />
            {t(esNombrado ? 'resume.fail.named_title' : 'resume.fail.retry_title')}
          </h2>
          <p style={{ color: 'var(--muted)' }} data-testid="resume-fallo-cuerpo">
            {t(esNombrado ? 'resume.fail.named_body' : 'resume.fail.retry_body')}
          </p>
          {esNombrado && fallo.mensaje && (
            <p style={{ color: 'var(--muted)', fontSize: '0.9rem' }} data-testid="resume-fallo-motivo">{fallo.mensaje}</p>
          )}
          <button
            type="button"
            className="btn-kis"
            data-testid="resume-reintentar"
            onClick={() => {
              // MISMO enlace, mismo `n`: se vuelve a montar el efecto con el token de la URL
              // que ya está en el closure. Cero peticiones de enlace nuevo.
              setFallo(null);
              setReintentoAuto(0);
              setProgress(0);
              setStage(0);
              setIntentoManual(n => n + 1);
            }}
          >{t('resume.fail.retry_btn')}</button>
        </div>
      </div>
    );
  }

  return (
    <div style={{ textAlign: 'center', paddingTop: 80 }}>
      <div className="spinner" />
      <p style={{ color: 'var(--muted)' }} aria-live="polite">
        {reintentoAuto > 0 ? t('resume.stage.retrying') : t(RESUME_STAGE_KEYS[stage])}
      </p>
      {/* Barra de progreso asintótica (TASK-2). Indica avance estimado sin completarse
          en falso; el aria-valuenow refleja el % para lectores de pantalla. */}
      <div
        role="progressbar"
        aria-valuenow={pct}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-label={t(RESUME_STAGE_KEYS[stage])}
        style={{
          maxWidth: 320, margin: '20px auto 0', height: 8, borderRadius: 999,
          background: 'rgba(0,0,0,0.08)', overflow: 'hidden',
        }}
      >
        <div style={{
          width: `${pct}%`, height: '100%', borderRadius: 999,
          background: 'var(--teal-dk, #0f766e)',
          transition: 'width 0.3s ease-out',
        }} />
      </div>
    </div>
  );
}
