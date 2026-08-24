import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useWizard } from '../context/WizardContext';
import { claveDelRechazoDefinitivo } from '../lib/rechazos';

/**
 * WPERF-1 (criterios 2 + 3) — indicador de guardado global estilo Google Docs.
 *
 * Vive en la barra superior del wizard, FUERA de los botones de paso (los botones ya
 * no muestran "Guardando…"): la navegación nunca se bloquea por un save en vuelo, y el
 * estado de la cola se comunica aquí. Gobernado por `saveState` del WizardContext:
 *   - 'saving' → "Guardando…"
 *   - 'error'  → aviso rojo que DICE qué no se pudo guardar + "Reintentar" + una X para
 *                cerrarlo (cola 18.bis, Diego 2026-08-09)
 *   - 'idle'   → "Todos los cambios guardados" (solo si ya se guardó ≥1 paso, para no
 *                anunciar "guardado" en un wizard recién abierto)
 *
 * ── LA X CIERRA EL CARTEL, NO EL PROBLEMA ────────────────────────────────────────────
 * Diego pidió poder ocultar el aviso rojo. Cerrarlo NO toca el estado de la cola: si de
 * verdad queda algo sin guardar, `saveState` sigue en 'error', la última save fallida
 * sigue guardada para reintentarla, y el indicador se queda MUDO (`<span />`) — jamás
 * cae al «Todos los cambios guardados», que sería la mentira que este trabajo viene a
 * quitar. El cierre es por EPISODIO (`saveErrorSeq`): si vuelve a fallar un guardado, el
 * aviso reaparece, porque eso ya es una noticia nueva.
 *
 * Componente sin props: lee todo del contexto para poder colocarse en cualquier host
 * del wizard (es endpoint-agnóstico — sobrevive a la migración a KMS de Fase 2).
 *
 * ── ②24.sexies · EL AVISO MIRA EL CÓDIGO DEL RECHAZO ─────────────────────────────────
 * Misma doctrina que `SubmitErrorBanner`, que ya resolvió este problema para el envío:
 * «No se ha podido guardar, reinténtalo» es un callejón sin salida cuando el motivo NO se
 * arregla reintentando — el servidor va a rechazar exactamente igual. Los códigos que
 * sabemos explicar dicen qué ha pasado y qué se puede hacer, y NO ofrecen «Reintentar»;
 * el RESTO sigue mostrando el texto de siempre, con su botón, byte-idéntico.
 *
 * ── 18.bis.85 · LA LISTA YA NO VIVE AQUÍ ─────────────────────────────────────────────
 * Vive en `lib/rechazos.js`, porque la cola de guardado necesita el MISMO criterio para no
 * reintentar sola un guardado condenado a fallar (y repetirle el susto a la familia). Dos
 * copias del mismo criterio divergen; una sola, no. Aquí solo se PREGUNTA.
 */

export default function SaveIndicator() {
  const { t } = useTranslation();
  const { saveState, completedSteps, retryLastSave, saveErrorSeq, saveErrorQue, saveErrorCodigo, debeReenviar, avisoDelColegio } = useWizard();
  // Episodio de fallo que el usuario cerró a mano. `null` = no ha cerrado ninguno.
  const [episodioCerrado, setEpisodioCerrado] = useState(null);

  const base = { fontSize: '0.82rem', display: 'inline-flex', alignItems: 'center', gap: 6 };

  // ⭐ DL-E49 §8 (2026-08-24) — el tutor que YA había enviado ha cambiado algo: su envío queda
  // invalidado y hay que decírselo. Va DELANTE del resto porque es lo que tiene que leer ahora;
  // **no bloquea nada** (sigue editando) y no ofrece botón: lo que tiene que hacer es volver al
  // paso de revisión y enviar. Se pinta también con la cola en reposo, que es justo cuando el
  // guardado ya entró y el envío ya no vale.
  // ⭐ DL-E63 (2026-08-24) — el colegio cambió algo de esta solicitud mientras la familia la
  // tenía abierta, y hay que DECÍRSELO. Reusa este mismo carril (no se abre un componente de
  // aviso nuevo) y **no bloquea nada**: la familia sigue rellenando. Va por delante del resto
  // porque es lo último que ha pasado. Sin datos de nadie: dice que hubo un cambio, no cuál.
  if (avisoDelColegio && saveState !== 'error') {
    return (
      <span style={{ ...base, color: '#0a5b8a' }} aria-live="polite" data-testid="save-indicator-aviso-colegio">
        <i className="bi bi-info-circle" />
        {avisoDelColegio.colision
          ? t('wizard.aviso_colegio_colision',
              'El colegio ha actualizado algunos datos de tu solicitud mientras editabas. Revisa lo que tenías a medias.')
          : t('wizard.aviso_colegio',
              'El colegio ha actualizado algunos datos de tu solicitud.')}
      </span>
    );
  }

  if (debeReenviar && saveState !== 'error') {
    return (
      <span style={{ ...base, color: '#8a5a00' }} aria-live="polite" data-testid="save-indicator-reenviar">
        <i className="bi bi-exclamation-circle" />
        {t('wizard.debe_reenviar',
           'Has cambiado datos de tu parte. Vuelve a enviarla para que la escuela la reciba.')}
      </span>
    );
  }

  if (saveState === 'saving') {
    return (
      <span style={{ ...base, color: 'var(--muted)' }} aria-live="polite" data-testid="save-indicator-saving">
        <i className="bi bi-cloud-arrow-up" />
        {t('wizard.saving_in_background', 'Guardando…')}
      </span>
    );
  }

  if (saveState === 'error') {
    // Cerrado a mano: se calla, pero NO dice que esté guardado (el estado sigue en error).
    if (episodioCerrado === saveErrorSeq) return <span data-testid="save-indicator-mute" />;
    const claveExplicada = claveDelRechazoDefinitivo(saveErrorCodigo);
    const texto = claveExplicada
      ? t(claveExplicada)
      : saveErrorQue
        ? t('wizard.save_error_step', 'No se ha podido guardar «{{paso}}». Lo que escribiste sigue aquí.', { paso: saveErrorQue })
        : t('wizard.save_error', 'No se ha podido guardar tu último cambio. Lo que escribiste sigue aquí.');
    return (
      <span style={{ ...base, color: '#a02020' }} aria-live="assertive" data-testid="save-indicator-error">
        <i className="bi bi-exclamation-triangle" />
        {texto}
        {/* Reintentar solo donde puede servir de algo: con un motivo que sabemos explicar,
            el servidor rechazaría igual y el botón sería un callejón sin salida. */}
        {!claveExplicada && (
        <button
          type="button"
          onClick={retryLastSave}
          data-testid="save-error-retry"
          style={{
            background: 'transparent',
            border: 'none',
            color: '#a02020',
            fontSize: '0.82rem',
            cursor: 'pointer',
            padding: '0 2px',
            textDecoration: 'underline',
          }}
        >
          {t('wizard.retry_save', 'Reintentar')}
        </button>
        )}
        <button
          type="button"
          onClick={() => setEpisodioCerrado(saveErrorSeq)}
          data-testid="save-error-dismiss"
          aria-label={t('wizard.dismiss_save_error', 'Ocultar este aviso')}
          title={t('wizard.dismiss_save_error', 'Ocultar este aviso')}
          style={{
            // La X es TEXTO, no un icono de fuente externa, y tiene caja propia: un botón
            // de cerrar cuyo único contenido es un glifo de la fuente de iconos DESAPARECE
            // si esa fuente no carga (CDN caído, red del colegio, modo de ahorro) — y
            // entonces el aviso vuelve a ser imposible de cerrar, que es el defecto que
            // esto viene a quitar. Medido con la batería: con la fuente bloqueada el botón
            // quedaba de 4×0 px y ni el navegador lo consideraba visible.
            background: 'transparent',
            border: 'none',
            color: '#a02020',
            fontSize: '1.05rem',
            lineHeight: '18px',
            width: 20,
            height: 20,
            cursor: 'pointer',
            padding: 0,
            marginLeft: 2,
          }}
        >
          <span aria-hidden="true">×</span>
        </button>
      </span>
    );
  }

  if (completedSteps.size > 0) {
    return (
      <span style={{ ...base, color: 'var(--muted)' }} aria-live="polite" data-testid="save-indicator-idle">
        <i className="bi bi-check2-circle" />
        {t('wizard.all_changes_saved', 'Todos los cambios guardados')}
      </span>
    );
  }

  return <span />;
}
