import { useState, useEffect, useRef, useCallback } from 'react';
import { useTranslation } from 'react-i18next';
import { useNavigate } from 'react-router-dom';
import { useWizard } from '../../context/WizardContext';
import { stepLabelKey } from './catalog'; // #11: el nombre del paso sale del catálogo
import { gasCall, fetchLookups, fetchQuestions, requestCorrection, identidadDelEnlace,
         simularCuotas } from '../../api';
import StepNav from '../../components/StepNav';
// 0º.tricies.sexdecies — el separador por sujeto es el MISMO que el del cuestionario.
import CabeceraDeSujeto from '../../shared/CabeceraDeSujeto';
import StepUpReverify from '../../components/StepUpReverify';
import { openDocument } from '../../utils/documentProxy';
import { translateRelationLabel, translateGender, translateIdType } from '../../utils/enumLabels';
import { fechaLegible } from '../../utils/fechas'; // 0º.vicies.sexies: EL único formateador
import { CONSENT_TEXTS } from '../../consentTexts';
import * as log from '../../logger';

const RECAPTCHA_SITE_KEY = import.meta.env.VITE_RECAPTCHA_SITE_KEY;

// AppSheet returns booleans as "TRUE"/"FALSE" strings — normalise before rendering.
function parseBool(val) {
  if (typeof val === 'boolean') return val;
  if (typeof val === 'string')  return val.toLowerCase() === 'true' || val === '1';
  return Boolean(val);
}

/**
 * «Necesito corregir algo» — para la familia que ya envió y se dio cuenta de un error
 * (cola 18.quater, decisión de Diego 2026-08-07).
 *
 * Antes de esto, la familia que se equivocaba no tenía dónde pulsar: tenía que escribir
 * a admisiones y esperar. Ahora lo pide desde aquí y el colegio se entera al momento.
 *
 * TRES ESTADOS Y NI UNO MÁS, y el tercero es el que importa:
 *   · cerrado    — un enlace discreto, para no competir con «solicitud enviada»
 *   · abierto    — un hueco para escribir QUÉ quiere corregir, y el botón de enviar
 *   · contestado — lo que de verdad pasó
 *
 * POR QUÉ ESTO **NO** CIERRA AL INSTANTE (y sí lo hace el resto de la aplicación): la
 * regla de cerrar en el envío existe porque la fila optimista ya le enseña al usuario
 * el resultado. Aquí no hay ninguna fila que enseñar, y el resultado **no se puede
 * adivinar**: el KMS puede contestar que la petición quedó cursada, o que no —por
 * ejemplo, si el colegio aún no lo tiene declarado—. Fingir un «hecho» dejaría a la
 * familia esperando una respuesta que nadie va a mandar. Así que se espera la respuesta
 * real y se dice cuál de las dos fue.
 */
function CorrectionRequest({ resumeToken, t }) {
  const [abierto, setAbierto] = useState(false);
  const [texto, setTexto]     = useState('');
  const [enviando, setEnviando] = useState(false);
  const [resultado, setResultado] = useState(null);   // 'ok' | 'no' | 'error'

  async function enviar() {
    setEnviando(true);
    try {
      const r = await requestCorrection(resumeToken, texto);
      setResultado(r && r.requested ? 'ok' : 'no');
      if (!r || !r.requested) {
        log.warn('Step7: la petición de corrección no quedó cursada', { reason: r && r.reason });
      }
    } catch (e) {
      log.error('Step7: requestCorrection failed', { message: e.message });
      setResultado('error');
    } finally {
      setEnviando(false);
    }
  }

  if (resultado === 'ok') {
    return (
      <p data-testid="correction-result-ok"
         style={{ color: '#1b5e20', fontSize: '0.9rem', marginTop: 14, marginBottom: 0 }}>
        <i className="bi bi-check-circle-fill me-2" />{t('step7.correction_sent')}
      </p>
    );
  }
  // Ni cursada ni error del transporte: en los dos casos la familia necesita SABER que
  // esto no ha llegado, y qué hacer en su lugar. Un aviso callado sería lo mismo que
  // no tener el botón, pero además engañoso.
  if (resultado === 'no' || resultado === 'error') {
    return (
      <p data-testid="correction-result-failed"
         style={{ color: '#b23c17', fontSize: '0.9rem', marginTop: 14, marginBottom: 0 }}>
        <i className="bi bi-exclamation-triangle-fill me-2" />{t('step7.correction_failed')}
      </p>
    );
  }

  if (!abierto) {
    return (
      <button type="button" className="btn btn-link p-0 mt-3"
        data-testid="correction-open"
        style={{ fontSize: '0.9rem', color: 'var(--teal-dk)' }}
        onClick={() => setAbierto(true)}>
        <i className="bi bi-pencil-square me-2" />{t('step7.correction_cta')}
      </button>
    );
  }

  return (
    <div className="mt-3" data-testid="correction-form">
      <label className="form-label fw-semibold" htmlFor="correction_note" style={{ fontSize: '0.9rem' }}>
        {t('step7.correction_label')}
      </label>
      <textarea id="correction_note" className="form-control" rows={3} maxLength={500}
        data-testid="correction-note"
        placeholder={t('step7.correction_placeholder')}
        value={texto} onChange={e => setTexto(e.target.value)} />
      <div className="d-flex gap-2 mt-2">
        <button type="button" className="btn btn-outline-secondary btn-sm"
          onClick={() => { setAbierto(false); setTexto(''); }} disabled={enviando}>
          {t('common.cancel')}
        </button>
        <button type="button" className="btn btn-primary btn-sm"
          data-testid="correction-send" onClick={enviar} disabled={enviando}>
          {enviando ? t('step7.correction_sending') : t('step7.correction_send')}
        </button>
      </div>
    </div>
  );
}

/**
 * PASO 7 · EL SIMULADOR DE CUOTAS — orientativo, y lo dice (Diego, 2026-08-19).
 *
 * Cita literal de Diego: «el paso 7 debería mostrar un pequeño simulador de las tarifas que
 * se aplicarían, permitiendo elegir la modalidad de pago. […] Esto no es una elección en
 * firme, es una simulación. La elección en firme se da en el paso 8, porque es la que se va
 * a firmar.»
 *
 * ⛔ ESTO NO PUEDE IMPEDIR QUE UNA FAMILIA ENVÍE SU SOLICITUD, y es lo más importante del
 * bloque: vive FUERA del camino de `handleSubmit`, no comparte con él ni un estado, y
 * cualquier fallo suyo —la lectura, el guardado de la elección, el servidor entero— se
 * queda dentro de este recuadro. Si no carga, el paso 7 se ve exactamente como antes.
 *
 * LA FORMA está COPIADA de `Step8Billing.jsx` (carga · error de lectura que degrada ·
 * tarjeta por forma de pago · opción no disponible atenuada con su motivo), no rediseñada.
 *
 * ⛔ AQUÍ NO SE CALCULA DINERO: `money()` divide entre 100 y formatea, y nada más. Los
 * importes salen SIEMPRE del motor del KMS — un segundo sitio que los calculara es
 * exactamente lo que DL-080-A prohíbe.
 *
 * ⭐ `③70` (Diego, 2026-08-21) — MODO SOLO LECTURA, para la familia que YA ENVIÓ. Cita
 * literal: *«si una familia entra en el wizard se va a quedar en el paso 7… A lo mejor lo
 * que sí puede hacer en esta pantalla es consultar la simulación, ver los distintos planes
 * o modalidades»*. Con `soloLectura`, el MISMO componente pinta las mismas cifras y el
 * mismo calendario, pero **sin el desplegable**: las formas de pago se enseñan como texto,
 * una línea por cada una, para que se puedan comparar. Es un solo componente a propósito —
 * un segundo que pintara lo mismo divergiría (§"Regla — refactors preservan el código
 * probado").
 *
 * ⛔ Y el motivo por el que en solo lectura NO se ofrece elegir es de HONESTIDAD, no de
 * seguridad: con la solicitud ya enviada, la elección que cuenta es la del paso 8 (la que
 * se firma), así que un control que invita a elegir prometería algo que esta pantalla no
 * puede dar. *(Medido el 2026-08-22 contra `origin/main`: `guardarModalidadPreferida` **no
 * existe ya** —ni en `backend/Code.js` ni en el frontal, lo retiró `0º.vicies.sexies`— y
 * marcar una forma de pago **no viaja a ningún sitio**; por tanto NO habría error de
 * `NOT_EDITABLE` que evitar. La premisa contraria, que llegó escrita en el encargo, era
 * FALSA.)*
 */
function SimulacionDeCuotas({ resumeToken, applicants, t, lang, soloLectura }) {
  const [sim, setSim]             = useState(null);   // null = calculando
  // ⛔⛔ `0º.tricies.vicies.sexies` (2026-08-26) — «NO HAY CUOTAS» Y «NO ME HAN LLEGADO»
  // NO SON LO MISMO. Es el mismo defecto que el paso 1 arregló ese mismo día, en el paso 7.
  //
  // Diego: *«Ahora no carga ninguna cuota en el wizard en el paso 7»*, con este recuadro
  // diciéndole *«Todavía no podemos mostrarte una simulación de las cuotas. El colegio te
  // informará de los importes cuando estudie tu solicitud.»* En su propio registro
  // `simularCuotas` había SALIDO y el navegador la había cortado a los 240.000 ms sin
  // respuesta: no es que no hubiera cuotas, es que no llegaron — y la pantalla hablaba del
  // colegio, que no tenía nada que ver.
  //
  // La causa era este componente: el `.catch` hacía `setSim({simulable:false})` («degrada y
  // calla») ⇒ un fallo de TRANSPORTE salía por la MISMA puerta que «este plan no admite
  // cuotas», que es una respuesta legítima del servidor.
  //
  // Desde aquí hay TRES situaciones, no dos: calculando · el servidor contestó (y su
  // respuesta puede ser legítimamente que no hay cuotas) · no se pudo calcular. La tercera
  // se DICE y se puede reintentar, nunca se disfraza de la segunda.
  //
  // ⚠️ Esto NO hace que las cuotas lleguen — mientras `simularCuotas` tarde más de cuatro
  // minutos la familia seguirá sin verlas; eso lo cierra `0º.tricies.vicies.quinquies`.
  // Aquí solo se deja de mentir.
  const [simNoLlego, setSimNoLlego] = useState(false);
  // ⭐ 0º.vicies.sexies — LA MARCA VIVE SOLO EN EL NAVEGADOR (decisión de Diego, 2026-08-21:
  // *«la presentación de pagos es meramente informativa… se puede guardar en la memoria del
  // navegador, pero ya está»*). Es `{ [template_id]: modality_id }` —un solicitante puede
  // tener varios planes a la vez y cada uno lleva la suya— y la guarda `WizardContext` con
  // el MISMO mecanismo de sesión que el resto del estado, así que sobrevive a un F5 sin un
  // solo viaje al servidor. ⛔ La elección EN FIRME es la del paso 8, y ésa no se toca.
  const { formaDePagoMarcada, setFormaDePagoMarcada,
          leerSimulacionMemo, guardarSimulacionMemo } = useWizard();
  const seleccion = formaDePagoMarcada || {};

  // ⭐ `0º.tricies.quindecies` (Diego, 2026-08-22) — AL VOLVER AL PASO 7 NO SE VUELVE A
  // PEDIR LA SIMULACIÓN si nada ha cambiado. Este componente se DESMONTA al pulsar
  // «Atrás» (`WizardPage` pinta un solo paso), así que su `useState` se pierde y este
  // efecto volvía a disparar `simularCuotas` al regresar — MEDIDO: 2 llamadas en un
  // 7→6→7 sin tocar nada. El servidor sí sabe no recalcular, pero la familia pagaba
  // igual el viaje entero a Apps Script (decenas de segundos) y veía el recuadro volver
  // a «cargando».
  //
  // La memoria vive en `WizardContext` (sobrevive al desmontaje, muere con la pestaña) y
  // se OLVIDA sola en cuanto se encola CUALQUIER guardado o sube la versión del grupo.
  // ⛔ Aquí NO se decide nada más: ni plazos, ni qué es «lo mismo» — eso lo gobierna el
  // contexto, en un solo sitio.
  // `vivo` era una variable del efecto; ahora que la petición también se dispara desde el
  // botón de reintento hacen falta las dos guardas que aquélla daba: seguir montado, y que
  // la respuesta que llega sea la de la ÚLTIMA petición (una vieja no puede pisar a la
  // nueva). Sin esto el reintento podría quedar tapado por la respuesta del intento
  // anterior.
  const montado = useRef(true);
  const peticion = useRef(0);
  useEffect(() => () => { montado.current = false; }, []);

  const pedirSimulacion = useCallback((forzar) => {
    setSimNoLlego(false);
    setSim(null);
    if (!resumeToken) { setSim({ simulable: false, simulaciones: [] }); return; }
    if (!forzar) {
      const memorizada = leerSimulacionMemo && leerSimulacionMemo(resumeToken);
      if (memorizada) { setSim(memorizada); return; }
    }
    const mia = ++peticion.current;
    const vigente = () => montado.current && mia === peticion.current;
    simularCuotas(resumeToken)
      .then(res => {
        if (!vigente()) return;
        // ⛔ Lo que acredita que el servidor CONTESTÓ es que venga una respuesta con forma
        // de respuesta. Sin ella no hay nada que enseñar: es un fallo de carga, y como tal
        // se trata — no como un «este plan no admite cuotas», que sí es una respuesta.
        if (!res || typeof res !== 'object') {
          setSimNoLlego(true);
          setSim({ simulable: false, simulaciones: [] });
          return;
        }
        // ⛔ SOLO SE MEMORIZA LO QUE LLEGÓ. Guardar un fallo dejaría el simulador apagado el
        // resto de la sesión y el botón de reintento no serviría de nada.
        if (guardarSimulacionMemo) guardarSimulacionMemo(resumeToken, res);
        setSim(res);
      })
      .catch(e => {
        // El resto del paso 7 tiene que funcionar igual —un simulador caído NO puede
        // impedir enviar la solicitud— pero ya no se calla: se dice y se puede reintentar.
        log.warn('Step7: simularCuotas failed', { message: e && e.message });
        if (!vigente()) return;
        setSimNoLlego(true);
        setSim({ simulable: false, simulaciones: [] });
      });
  }, [resumeToken, leerSimulacionMemo, guardarSimulacionMemo]);

  useEffect(() => { pedirSimulacion(false); }, [pedirSimulacion]);

  const money = (cents, currency) => {
    const n = Number(cents || 0) / 100;
    try {
      return new Intl.NumberFormat(undefined, { style: 'currency', currency: currency || 'EUR' }).format(n);
    } catch (e) { return n.toFixed(2) + ' ' + (currency || 'EUR'); }
  };

  // Marcar es INSTANTÁNEO y no viaja a ningún sitio: esto compara opciones, no deja
  // constancia de nada. Antes costaba DOS viajes al KMS (42 s de reloj medidos el
  // 2026-08-22) para anotar un dato que no leía nadie — y que además no llegaba a
  // escribirse (`"saved": false`).
  const elegir = (templateId, modalityId) => setFormaDePagoMarcada(templateId, modalityId);

  const nombreDe = (personId) => {
    const a = (applicants || []).find(x => (x.person_id || x._uid) === personId);
    return a ? [a.first_name, a.last_name].filter(Boolean).join(' ').trim() : '';
  };

  // ⭐ 0º.tricies (Diego, 2026-08-22, TERCERA pasada sobre esta pantalla) — UN SELECTOR,
  // NO TARJETAS. Cita literal: *«sigue sin dejar elegir la modalidad. Lo que ofrece son dos
  // tarjetas, pero yo no quiero tarjetas, quiero un botón o desplegable que elija entre
  // modalidades y las muestre con todos los conceptos (matrícula, fecha etc.)»*.
  //
  // Las dos pasadas anteriores dieron por buena la pantalla sin que hiciera esto. Lo que
  // cambia aquí es SOLO la forma de elegir; el calendario lo pinta `tablaDeDesglose` justo
  // debajo, y se repinta solo porque la marca vive en el estado del navegador.
  //
  // ⛔ Con UNA sola forma de pago NO se pinta desplegable: un desplegable de una opción no
  // es una elección (mismo criterio que el tipo de documento del paso 6). Se dice cuál es y
  // se enseña su calendario — que es exactamente lo que pidió Diego para comedor y
  // ampliación de horario, que no ofrecen alternativa.
  //
  // ⛔ AQUÍ NO SE CALCULA DINERO (DL-080-A): `money()` divide entre 100 y formatea.
  // ⛔ UNA FORMA DE PAGO PUEDE NO TENER NOMBRE, y no es un dato que falte: es el caso de un
  // plan que NO ADMITE NINGUNA forma de pago (permanencia, ampliación de horario — van por
  // regla o a mano). El KMS lo devuelve así a propósito: `fin_previewTemplateSchedule`
  // simula con `candidates = [null]` + aviso `NO_MODALITIES_ADMITTED`, y
  // `enr_proyectarSimulacionesDelEnsayo_` emite UNA modalidad con
  // `modality_id`/`modality_code`/`designation` a `null` y su calendario entero.
  // Sin este trozo, la línea salía empezando por un « · » suelto.
  const etiquetaDeModalidad = (x) => {
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

  const selectorDelPlan = (plan) => {
    const modalidades = plan.modalidades || [];
    if (!modalidades.length) return null;
    const m = modalidadMarcadaOPrimera(plan);

    // ⭐ `③70` — SOLO LECTURA (solicitud ya enviada): las formas de pago se enseñan TODAS,
    // en texto, para que se puedan comparar; ninguna se puede elegir. El calendario que se
    // ve debajo sigue siendo el de `modalidadMarcadaOPrimera`, que aquí resuelve a la
    // primera DISPONIBLE (o a la que la familia marcó antes de enviar, si la marca sigue
    // en la sesión del navegador). Se marca cuál es, para que la tabla no parezca huérfana.
    if (soloLectura) {
      return (
        <div data-testid="paso7-forma-de-pago">
          {modalidades.map((x, i) => (
            <div
              key={x.modality_id || ('sin-modalidad-' + i)}
              data-testid="paso7-modalidad"
              data-modality-id={x.modality_id}
              style={{
                fontSize: '0.86rem',
                fontWeight: (m && x.modality_id === m.modality_id) ? 700 : 400,
              }}
            >
              {etiquetaDeModalidad(x)}
            </div>
          ))}
          {m && m.available !== false && (m.descuentos || []).length > 0 && (
            <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginTop: 4 }}>
              {(m.descuentos || []).map(d => d.designation || d.policy_code).filter(Boolean).join(' · ')}
            </div>
          )}
        </div>
      );
    }

    const elegibles = modalidades.filter(x => x.available !== false);
    const hayQueElegir = elegibles.length > 1;
    const idCampo = 'paso7-modalidad-' + String(plan.template_id || 'plan');
    return (
      <div data-testid="paso7-forma-de-pago">
        {hayQueElegir ? (
          <>
            <label htmlFor={idCampo}
                   style={{ display: 'block', fontSize: '0.82rem', fontWeight: 600, marginBottom: 4 }}>
              {t('step7.sim.modality_label')}
            </label>
            <select
              id={idCampo}
              className="form-select form-select-sm"
              data-testid="paso7-modalidad-selector"
              style={{ maxWidth: 460 }}
              value={(m && m.modality_id) || ''}
              onChange={e => elegir(plan.template_id, e.target.value)}
            >
              {modalidades.map(x => (
                <option
                  key={x.modality_id}
                  value={x.modality_id}
                  data-testid="paso7-modalidad"
                  data-modality-id={x.modality_id}
                  disabled={x.available === false}
                >
                  {etiquetaDeModalidad(x)}
                </option>
              ))}
            </select>
          </>
        ) : (
          m && (
            <div data-testid="paso7-modalidad" data-modality-id={m.modality_id}
                 style={{ fontSize: '0.86rem' }}>
              {etiquetaDeModalidad(m)}
            </div>
          )
        )}
        {/* ⛔ 0º.vicies.sexies pieza 5 — FUERA el «te ahorras». El NOMBRE del descuento
            aplicado SÍ se queda (es un dato del plan, y así lo enseña también el simulador
            del KMS); lo que se retira es la cifra de ahorro. */}
        {m && m.available !== false && (m.descuentos || []).length > 0 && (
          <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginTop: 4 }}>
            {(m.descuentos || []).map(d => d.designation || d.policy_code).filter(Boolean).join(' · ')}
          </div>
        )}
      </div>
    );
  };

  // La forma de pago QUE CUENTA para el total de un plan: la que la familia eligió en
  // ESE plan si la hay, si no la primera DISPONIBLE (nunca una atenuada con `available:false`).
  const modalidadMarcadaOPrimera = (plan) => {
    const elegidaId = seleccion[plan.template_id];
    if (elegidaId) {
      const m = (plan.modalidades || []).find(x => x.modality_id === elegidaId);
      if (m) return m;
    }
    const disponibles = (plan.modalidades || []).filter(m => m.available !== false);
    return disponibles[0] || (plan.modalidades || [])[0] || null;
  };

  // ⭐ 0º.vicies.sexies pieza 3 — EL DESGLOSE, con la MISMA forma que el simulador de
  // plantillas del KMS (`SubscriptionTemplateDetailPage.jsx`, `simRows`): una fila por
  // vencimiento con `{ concepto, fecha, importe }`, ordenadas por fecha. Diego: *«Debería
  // indicar los conceptos desglosados, con sus fechas de pago. Tal y como se hace en el
  // simulador de plantillas del KMS.»*
  //
  // ⛔ AQUÍ NO SE CALCULA DINERO (DL-080-A): `money()` divide entre 100 y formatea, y nada
  // más. Ni una suma, ni una resta, ni un porcentaje — los importes vienen tal cual del
  // motor del KMS, que ya los repartió con el mismo repartidor del cobro real.
  const desgloseDe = (plan) => {
    const m = modalidadMarcadaOPrimera(plan);
    return m ? (m.cuotas || []) : [];
  };

  const tablaDeDesglose = (plan) => {
    const filas = desgloseDe(plan);
    if (!filas.length) return null;
    const m = modalidadMarcadaOPrimera(plan);
    const moneda = m && m.currency_code;

    // ⭐ `0º.tricies.ter` (Diego, 2026-08-22) — LA COLUMNA DE DESCUENTO. Cita literal: *«el
    // comedor y la permanencia sí aplican el descuento, pero pasa muy desapercibido. No se
    // indica el importe del descuento por pago anual, faltan totales, subtotales»*. El
    // calendario enseñaba el BRUTO por fila y el plan su NETO: nueve filas de 95,00 € y un
    // total de 0,00 €, sin nada en medio.
    //
    // ⛔ AQUÍ NO SE CALCULA DINERO (DL-080-A): las tres cifras de cada fila y las tres del
    // subtotal las PROYECTA el KMS desde el motor. `money()` divide entre 100 y formatea, y
    // nada más — ni una suma, ni una resta, ni un porcentaje.
    //
    // ⛔ Y las dos columnas nuevas SOLO salen cuando este plan tiene descuento: con tres
    // columnas la tabla se lee en un móvil, con cinco no. Sin descuento, el markup queda
    // BYTE-IDÉNTICO al de antes de este cambio.
    const hayDescuento = !!(m && Number(m.discount_cents || 0) > 0);
    const importe = (v) => (v == null ? '—' : money(v, moneda));

    return (
      <div data-testid="paso7-desglose" style={{ marginTop: 10 }}>
        <div style={{ fontSize: '0.8rem', fontWeight: 700, color: 'var(--teal-dk)', marginBottom: 4 }}>
          {t('step7.sim.breakdown_title')}
        </div>
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
              <tr key={i} data-testid="paso7-desglose-fila" style={{ borderTop: '1px solid var(--border)' }}>
                <td data-testid="paso7-desglose-concepto" style={{ padding: '3px 6px 3px 0' }}>{c.concepto || '—'}</td>
                <td data-testid="paso7-desglose-fecha" style={{ padding: '3px 6px' }}>{fechaLegible(c.due_date, lang) || '—'}</td>
                <td style={{ padding: '3px 0 3px 6px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {money(c.amount_cents, moneda)}
                </td>
                {hayDescuento && (
                  <>
                    <td data-testid="paso7-desglose-descuento"
                        style={{ padding: '3px 0 3px 6px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {importe(c.descuento_cents)}
                    </td>
                    <td data-testid="paso7-desglose-neto"
                        style={{ padding: '3px 0 3px 6px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {importe(c.neto_cents)}
                    </td>
                  </>
                )}
              </tr>
            ))}
          </tbody>
          {/* EL SUBTOTAL DEL PLAN — las tres cifras que el KMS ya proyectaba y que solo se
              enseñaba una (el neto). Es el escalón que faltaba entre las filas y el total. */}
          {m && (
            <tfoot>
              <tr data-testid="paso7-subtotal-plan"
                  style={{ borderTop: '2px solid var(--border)', fontWeight: 700 }}>
                <td colSpan={2} style={{ padding: '5px 6px 3px 0' }}>{t('step7.sim.subtotal')}</td>
                <td data-testid="paso7-subtotal-bruto"
                    style={{ padding: '5px 0 3px 6px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                  {money(m.gross_cents, moneda)}
                </td>
                {hayDescuento && (
                  <>
                    <td data-testid="paso7-subtotal-descuento"
                        style={{ padding: '5px 0 3px 6px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {money(m.discount_cents, moneda)}
                    </td>
                    <td data-testid="paso7-subtotal-neto"
                        style={{ padding: '5px 0 3px 6px', textAlign: 'right', whiteSpace: 'nowrap' }}>
                      {money(m.net_cents, moneda)}
                    </td>
                  </>
                )}
              </tr>
            </tfoot>
          )}
        </table>
      </div>
    );
  };

  // ⚠️ `0º.tricies.ter` — POR QUÉ ESTE TOTAL NO LO PROYECTA EL SERVIDOR, dicho entero.
  // El encargo pedía que lo hiciera, y NO SE PUEDE mientras la elección de forma de pago
  // viva solo en el navegador: es una decisión de Diego (`0º.vicies.sexies` retiró el
  // guardado de esa preferencia a propósito, porque marcar en el paso 7 es COMPARAR, no
  // comprometerse). El KMS no sabe qué modalidad ha marcado la familia en cada plan, así
  // que no puede sumar los subtotales que le corresponden. Proyectar un total por CADA
  // combinación posible sería combinatorio.
  //
  // ⛔ Lo que sí se cumple: **NO se añade ni una operación de dinero nueva**. Ésta es la
  // ÚNICA suma del asistente, la que ya existía, y se queda aislada aquí. Todo lo demás
  // —las tres cifras de cada vencimiento y las tres del subtotal de cada plan— viene ya
  // calculado del motor del KMS.
  const totalSolicitante = (planes) => {
    let cents = 0; let currency = null; let alguna = false;
    planes.forEach(plan => {
      const m = modalidadMarcadaOPrimera(plan);
      if (m) { cents += Number(m.net_cents || 0); currency = currency || m.currency_code || 'EUR'; alguna = true; }
    });
    return alguna ? { cents, currency: currency || 'EUR' } : null;
  };

  const planesConOpciones = ((sim && sim.simulaciones) || []).filter(x => (x.modalidades || []).length > 0);

  // Agrupados por SOLICITANTE, en el orden de llegada — un niño puede traer varios
  // planes (cuota + comedor + permanencia), uno por plantilla aplicable (2026-08-21).
  const porSolicitante = [];
  const indicePorSolicitante = new Map();
  planesConOpciones.forEach(plan => {
    let grupo = indicePorSolicitante.get(plan.applicant_person_id);
    if (!grupo) {
      grupo = { applicant_person_id: plan.applicant_person_id, planes: [] };
      indicePorSolicitante.set(plan.applicant_person_id, grupo);
      porSolicitante.push(grupo);
    }
    grupo.planes.push(plan);
  });

  return (
    <div className="kis-card mt-3" data-testid="paso7-simulador">
      <h3 style={{ color: 'var(--teal-dk)', marginTop: 0, fontSize: '1rem' }}>
        {t('step7.sim.title')}
      </h3>
      {/* Lo que ESTO es, dicho con todas las letras y siempre visible — también mientras
          carga y también cuando no hay nada que enseñar. */}
      <p data-testid="paso7-simulador-aviso"
         style={{ color: 'var(--muted)', fontSize: '0.85rem', marginBottom: 12 }}>
        {t('step7.sim.disclaimer')}
        {soloLectura && ' ' + t('step7.sim.readonly_note')}
      </p>

      {sim === null && (
        <p style={{ color: 'var(--muted)', fontSize: '0.84rem', marginBottom: 0 }}>
          {t('step7.sim.loading')}
        </p>
      )}

      {/* NO SE PUDO CALCULAR — se dice, y se puede volver a intentar con el mismo enlace. */}
      {sim !== null && simNoLlego && (
        <div data-testid="paso7-simulador-fallo">
          <p className="text-danger small mb-1">{t('step7.sim.failed')}</p>
          <button type="button" className="btn btn-sm btn-outline-secondary"
                  data-testid="paso7-simulador-reintentar"
                  onClick={() => pedirSimulacion(true)}>
            {t('step7.sim.retry')}
          </button>
        </div>
      )}

      {/* EL SERVIDOR CONTESTÓ y no hay cuotas que enseñar — respuesta legítima. */}
      {sim !== null && !simNoLlego && !planesConOpciones.length && (
        <p data-testid="paso7-simulador-vacio"
           style={{ color: 'var(--muted)', fontSize: '0.84rem', marginBottom: 0 }}>
          {t('step7.sim.unavailable')}
        </p>
      )}

      {porSolicitante.map(sol => {
        const nombre = porSolicitante.length > 1 ? nombreDe(sol.applicant_person_id) : '';
        // UN solo plan por solicitante ⇒ markup BYTE-IDÉNTICO al de antes de que un niño
        // pudiera tener varios planes a la vez: ni envoltorio de plan, ni total sumado.
        if (sol.planes.length === 1) {
          return (
            <div key={sol.applicant_person_id}
                 className={nombre ? 'sujeto-bloque' : undefined}
                 style={nombre ? undefined : { marginBottom: 18 }}>
              {/* 0º.tricies.sexdecies — el MISMO separador que el cuestionario. Con UN solo
                  solicitante `nombre` es '' ⇒ ni pastilla ni área: la pantalla queda como
                  estaba (allí no hay nada que separar y el plan ya se nombra a sí mismo). */}
              <CabeceraDeSujeto nombre={nombre} destacado />
              {selectorDelPlan(sol.planes[0])}
              {tablaDeDesglose(sol.planes[0])}
            </div>
          );
        }

        const total = totalSolicitante(sol.planes);
        return (
          <div key={sol.applicant_person_id} data-testid="paso7-solicitante"
               className={nombre ? 'sujeto-bloque' : undefined}
               style={nombre ? undefined : { marginBottom: 24 }}>
            <CabeceraDeSujeto nombre={nombre} destacado />
            {sol.planes.map(plan => (
              <div key={plan.template_id} data-testid="paso7-plan" data-template-id={plan.template_id}
                   style={{ marginBottom: 14 }}>
                <div data-testid="paso7-plan-nombre"
                     style={{ fontWeight: 600, fontSize: '0.86rem', marginBottom: 6, color: 'var(--muted)' }}>
                  {plan.template_designation || t('step7.sim.plan_generic')}
                </div>
                {selectorDelPlan(plan)}
                {tablaDeDesglose(plan)}
              </div>
            ))}
            {total && (
              <div data-testid="paso7-total-solicitante"
                   style={{ fontWeight: 700, fontSize: '0.88rem', marginTop: 4 }}>
                {t('step7.sim.total_solicitante', { amount: money(total.cents, total.currency) })}
              </div>
            )}
          </div>
        );
      })}

    </div>
  );
}

// ─── Presentational components ────────────────────────────────────────────────

function SectionCard({ title, icon, children }) {
  return (
    <div className="kis-card mb-3" style={{ padding: '16px 20px' }}>
      <div style={{
        display: 'flex', alignItems: 'center', gap: 8,
        marginBottom: 14, paddingBottom: 10,
        borderBottom: '1px solid var(--border)',
      }}>
        {icon && <i className={`bi ${icon}`} style={{ color: 'var(--teal)', fontSize: '1rem' }} />}
        <span style={{ fontWeight: 700, fontSize: '0.92rem', color: 'var(--teal-dk)', textTransform: 'uppercase', letterSpacing: '0.04em' }}>
          {title}
        </span>
      </div>
      {children}
    </div>
  );
}

function DataRow({ label, value }) {
  if (value === null || value === undefined || value === '' || value === false) return null;
  return (
    <div style={{ display: 'flex', gap: 12, padding: '5px 0', fontSize: '0.88rem', borderBottom: '1px solid var(--bg)' }}>
      <span style={{ color: 'var(--muted)', minWidth: 170, flexShrink: 0 }}>{label}</span>
      <span style={{ color: 'var(--text)', fontWeight: 500 }}>{String(value)}</span>
    </div>
  );
}

function Chip({ children, color }) {
  const bg   = color === 'orange' ? 'var(--orange-lt)' : color === 'red' ? '#fde8e8' : 'var(--teal-lt)';
  const text = color === 'orange' ? 'var(--orange)'   : color === 'red' ? '#c0392b'  : 'var(--teal-dk)';
  return (
    <span style={{
      display: 'inline-block', background: bg, color: text,
      borderRadius: 20, padding: '2px 10px', fontSize: '0.75rem',
      fontWeight: 600, marginRight: 4, marginBottom: 2, lineHeight: 1.6,
    }}>
      {children}
    </span>
  );
}

// ─── reCAPTCHA ────────────────────────────────────────────────────────────────

function loadRecaptcha(siteKey) {
  return new Promise(resolve => {
    if (window.grecaptcha) { resolve(window.grecaptcha); return; }
    const s = document.createElement('script');
    s.src = `https://www.google.com/recaptcha/api.js?render=${siteKey}`;
    s.onload = () => window.grecaptcha.ready(() => resolve(window.grecaptcha));
    document.head.appendChild(s);
  });
}

// ─── Main component ───────────────────────────────────────────────────────────

export default function Step7Review({ onBack, onAdvanceToSigning, canAdvanceToSigning }) {
  const { t, i18n }  = useTranslation();
  const navigate     = useNavigate();
  const lang         = i18n.language?.startsWith('en') ? 'en' : 'es';
  const { enrollmentGroupId, resumeToken, stepData, awaitPendingSave, hasPendingSave, isSubmitted, setIsSubmitted,
          enqueueSave, setSubmitError, setValidationError, recoveryNonce, recoveredEmail,
          isStepUpFresh, markStepUpFresh } = useWizard(); // UX-3 + UX-1 + ②24 + ②27

  // DL-E39 ENMIENDA (gate de ENTRADA, Diego 2026-06-06): el enmascarado per-campo
  // se ELIMINA. Toda la PII queda protegida por el GATE DE ENTRADA del wizard
  // (StepUpGate en WizardPage): una sesión recuperada por magic-link no llega a
  // renderizar ningún paso hasta superar el OTP. Por tanto, una vez aquí, el
  // resumen agregado se muestra con normalidad — sin reveal-per-campo.

  // `neae` es el apoyo educativo del paso 4 «Salud y apoyo»: una entrada por solicitante,
  // { person_id, conditions:[], supports:[] } — MISMA forma que maneja el paso 4
  // (Step4Health.jsx:328) y que el servidor devuelve al rehidratar (Code.js:4095-4103).
  // Sin recogerlo aquí, la familia no podía repasar antes de enviar lo que había declarado.
  const { email, persons, documents, relations, health, neae, questions } = stepData;
  const guardians  = (persons || []).filter(p => p.person_type_id === 'guardian');
  const applicants = (persons || []).filter(p => p.person_type_id === 'applicant');

  // Salud y apoyo educativo se pintan en el MISMO recuadro porque son el mismo paso y el
  // mismo grado de sensibilidad. Se unen por persona: una familia puede haber declarado
  // solo apoyo (sin alergias) y ese caso también tiene que verse.
  const saludYApoyo = (() => {
    const porPersona = new Map();
    const tomar = (pid) => {
      if (!porPersona.has(pid)) {
        porPersona.set(pid, { person_id: pid, allergies: [], dietary: [], medical: [], conditions: [], supports: [] });
      }
      return porPersona.get(pid);
    };
    (health || []).forEach(h => {
      const e = tomar(h.person_id);
      e.allergies = h.allergies || [];
      e.dietary   = h.dietary   || [];
      e.medical   = h.medical   || [];
    });
    (neae || []).forEach(n => {
      const e = tomar(n.person_id);
      e.conditions = n.conditions || [];
      e.supports   = n.supports   || [];
    });
    return [...porPersona.values()];
  })();

  // GA relations: have guardian_person_id + applicant_person_id (live or resumed)
  const gaRelations = (relations || []).filter(r =>
    r._kind === 'ga' || (r.guardian_person_id && r.applicant_person_id)
  );

  // Lookup tables — needed to resolve IDs to labels
  const [lookups, setLookups] = useState({
    relationTypes: [], allergies: [], dietary: [], medical: [],
  });
  // Question sets — to resolve qid → question text
  const [questionSets, setQuestionSets] = useState([]);

  useEffect(() => {
    // Idioma en la petición: la caché de catálogos va por idioma (ver `api.js`, 2026-08-19).
    fetchLookups(i18n.language)
      .then(data => setLookups({
        relationTypes: data.relationTypes || [],
        allergies:     data.allergies     || [],
        dietary:       data.dietary       || [],
        medical:       data.medical       || [],
      }))
      .catch(() => {});
    // WIZARD-UX: cached question catalog shared with Step5 (keyed by language).
    fetchQuestions(lang)
      .then(data => setQuestionSets(data.sets || []))
      .catch(() => {});
  }, []); // eslint-disable-line

  const allQuestions = questionSets.flatMap(s => s.questions || []);

  // Resolve a lookup ID to its human-readable label
  const resolveLabel = (list, id) => {
    const found = list.find(x => x.id === id);
    return found ? (found.label || found.id) : (id || '');
  };

  // ─── Submit logic ──────────────────────────────────────────────────────────

  const [consentGdpr,  setConsentGdpr]  = useState(false);
  const [consentLegal, setConsentLegal] = useState(false);
  const [submitting,   setSubmitting]   = useState(false);
  const [err,          setErr]          = useState('');
  // ②27 — el envío exige el código de un solo uso (escribe el libro de consentimientos a
  // nombre de un tutor real). Si la ventana se agotó, se pide AQUÍ y no después: el envío
  // es «dispara y navega», así que un rechazo posterior deja a la familia en la pantalla de
  // confirmación, donde no hay dónde verificar.
  //
  // Es un BOOLEANO, no la función de envío guardada. Guardar la función parece más directo y
  // es una trampa: la guardada se queda con el `isStepUpFresh` del render en que se guardó
  // —que por definición dijo «no fresco»—, así que al reintentar volvería a decir lo mismo y
  // la familia se quedaría dando vueltas pidiendo códigos que sí acertó. Con el booleano, el
  // reintento lo lanza el render VIVO y se salta la comprobación explícitamente
  // (`yaVerificado`), que además es obligatorio: `markStepUpFresh` es asíncrono y su efecto
  // todavía no se ve en la misma vuelta.
  const [pidiendoCodigo, setPidiendoCodigo] = useState(false);
  // UX-1: eleva el aviso de validación (consents/recaptcha) a la zona sticky superior.
  useEffect(() => { setValidationError(err); }, [err, setValidationError]);
  useEffect(() => () => setValidationError(''), [setValidationError]);

  // `opciones.yaVerificado` SOLO lo pasa el reintento tras acertar el código (ver abajo). El
  // botón lo llama como `onClick={handleSubmit}`, así que aquí llega un evento del navegador:
  // no tiene esa propiedad ⇒ la comprobación se hace, que es lo correcto.
  const handleSubmit = async (opciones) => {
    const yaVerificado = !!(opciones && opciones.yaVerificado === true);
    if (!consentGdpr)  { setErr(t('error.consent_required')); return; }
    if (!consentLegal) { setErr(t('error.consent_required')); return; }

    // ②27 — ANTES de asumir el envío y navegar: si la ventana del código de un solo uso se
    // agotó, el servidor va a rechazar el envío. Se pide el código aquí, donde la familia
    // TIENE dónde teclearlo, en vez de dejarla en /confirmation con un aviso rojo que
    // «Reintentar» no puede arreglar. Al verificar se repite este mismo envío entero.
    if (!yaVerificado && !isStepUpFresh()) {
      setErr('');
      setPidiendoCodigo(true);
      return;
    }
    setPidiendoCodigo(false);

    setErr('');
    setSubmitting(true);
    log.info('Step7: handleSubmit — submitting enrollment', { enrollmentGroupId, hasPendingSave });

    // ── Tramo SÍNCRONO (antes de asumir el envío): drenar saves pendientes + reCAPTCHA.
    //    Si el reCAPTCHA o la red fallan aquí, NO asumimos un submit que ni arrancó —
    //    error inline normal, sin estado optimista.
    try {
      if (hasPendingSave) {
        try { await awaitPendingSave(); }
        catch (_) { /* errors already toasted */ }
      }
      if (RECAPTCHA_SITE_KEY) {
        const rc = await loadRecaptcha(RECAPTCHA_SITE_KEY);
        const token = await rc.execute(RECAPTCHA_SITE_KEY, { action: 'submit' });
        const rcResult = await gasCall('verifyRecaptcha', { token });
        if (!rcResult.pass) {
          setErr(t('error.recaptcha_failed'));
          setSubmitting(false);
          return;
        }
      }
    } catch (e) {
      setErr(e.message);
      setSubmitting(false);
      return;
    }

    // DL-E49 §3 — las declaraciones que la familia aceptó en el paso 2, tal y como las
    // aceptó. Solo se registra lo que consta aceptado: si el paso 2 no las capturó (familia
    // de dos tutores, o sesión vieja anterior a este cambio), la lista sale VACÍA y no se
    // escribe nada — nunca se reconstruye un texto que quizá nadie vio.
    const declaracion = stepData.sole_guardian_attestation;
    const declaracionesDelPaso2 = [];
    if (declaracion?.attested && declaracion?.texts?.sole_guardian) {
      declaracionesDelPaso2.push({
        type:               'sole_guardian_attestation',
        accepted:           true,
        consent_text_shown: declaracion.texts.sole_guardian,
      });
    }
    if (declaracion?.parental_authority_attested && declaracion?.texts?.parental_authority) {
      declaracionesDelPaso2.push({
        type:               'parental_authority',
        accepted:           true,
        consent_text_shown: declaracion.texts.parental_authority,
      });
    }

    // ── UX-3: ENVÍO OPTIMISTA. Tras pasar validaciones + reCAPTCHA, asumimos el estado de
    //    inmediato y navegamos; el submit vuela en background por el carril de saveState
    //    (SaveIndicator), NO bloquea el botón. NO cambia el contrato del payload.
    const payload = {
      resume_token:        resumeToken, // KAL-4: required for IDOR defense
      // DL-E49 §1 — el `n` del enlace identifica al tutor que ESTÁ ENVIANDO su parte. Lo
      // resuelve el servidor a persona; el cliente no declara identidades.
      n:                   recoveryNonce || undefined,
      enrollment_group_id: enrollmentGroupId,
      application_id:      enrollmentGroupId,
      desired_start_date:  email?.desired_start_date || null,
      program_id:          email?.program_id         || null,
      language:            lang,
      consents: [
        { type: 'gdpr',  accepted: consentGdpr,  consent_text_shown: CONSENT_TEXTS.gdpr[lang]  },
        { type: 'legal', accepted: consentLegal, consent_text_shown: CONSENT_TEXTS.legal[lang] },
        // DL-E49 §3 — las DECLARACIONES del paso 2 (tutor único · patria potestad) viajan
        // al libro de consentimientos con el TEXTO EXACTO que se mostró y el momento en que
        // se aceptaron, que es lo que las hace valer como registro legal. Van aquí, en el
        // envío, porque el libro se ancla al EXPEDIENTE y el expediente nace al enviar.
        ...declaracionesDelPaso2,
      ],
    };

    // Factory RE-EJECUTABLE (retryLastSave la re-lanza tal cual desde lastFailedSaveRef):
    // lanza la operación COMPLETA cada vez. Éxito → estado enviado consolidado
    // (isSubmitted=true, aviso limpio). Fallo → ROLLBACK del estado optimista
    // (setIsSubmitted(false) re-habilita edición) + flag de aviso global; RE-LANZA el error
    // para que el carril marque saveState='error' → SaveIndicator pinta "Reintentar"
    // (retryLastSave re-encola ESTA misma factory). Un submit fallido NUNCA queda como
    // "enviado" silencioso (red de seguridad — es más consecuente que un save: transiciona a
    // RQ + dispara emails + crea enrollments).
    const submitFactory = () => gasCall('submitEnrollmentSession', payload)
      .then(res => { setIsSubmitted(true); setSubmitError(false); return res; })
      // 18.bis.21 — el aviso de fallo guarda el CÓDIGO del rechazo, no un simple «sí».
      // Sin él, un envío tumbado por la puerta de teléfono del servidor solo decía
      // «reinténtalo»: reintentar volvía a fallar igual, para siempre, y la familia nunca
      // sabía qué arreglar. Cualquier valor sigue siendo «verdadero» → el banner aparece
      // exactamente igual que antes para los códigos que no sabe explicar.
      .catch(e => { setIsSubmitted(false); setSubmitError(e?.code || true); throw e; });

    setSubmitError(false);
    setIsSubmitted(true);        // optimista: bloquea edición (Edit-lock post-submit, CLI 26)
    setSubmitting(false);
    enqueueSave(submitFactory);  // background → saveState 'saving' → 'idle' | 'error'
    navigate('/confirmation');   // navegación inmediata, sin esperar al submit
  };

  // ─── Render helpers ────────────────────────────────────────────────────────

  function renderGuardian(g, idx) {
    return (
      <SectionCard
        key={g.person_id || g._uid || idx}
        title={`${t('guardian.title', { n: idx + 1 })} — ${[g.first_name, g.last_name].filter(Boolean).join(' ')}`}
        icon="bi-person-fill"
      >
        <DataRow label={t('field.first_name')}    value={g.first_name} />
        <DataRow label={t('field.middle_name')}   value={g.middle_name} />
        <DataRow label={t('field.last_name')}     value={g.last_name} />
        <DataRow label={t('field.date_of_birth')} value={g.date_of_birth} />
        <DataRow label={t('field.place_of_birth')}value={g.place_of_birth} />
        <DataRow label={t('field.nationality')}   value={g.nationalities?.[0]?.country_id} />
        {g.ids?.[0] && (
          <DataRow label={t('field.id_number')} value={`${translateIdType(g.ids[0].id_type_id, t)}: ${g.ids[0].id_number}`} />
        )}
        <DataRow label={t('field.address_line_1')} value={g.address?.address_line_1} />
        <DataRow label={t('field.address_line_2')} value={g.address?.address_line_2} />
        <DataRow label={t('field.city')}           value={g.address?.city} />
        <DataRow label={t('field.province')}       value={g.address?.province} />
        <DataRow label={t('field.zip')}            value={g.address?.zip} />
        <DataRow label={t('field.country')}        value={g.address?.country_id} />

        {(g.emails || []).map((e, ei) => {
          const addr = e.email_address || e.value || '';
          if (!addr) return null;
          const typeKey = `email_type.${e.email_type_id || e.type}`;
          const typeLabel = e.email_type_id && i18n.exists(typeKey) ? t(typeKey) : e.email_type_id || '';
          return (
            <div key={ei} style={{ display: 'flex', gap: 12, padding: '5px 0', fontSize: '0.88rem', borderBottom: '1px solid var(--bg)', alignItems: 'center' }}>
              <span style={{ color: 'var(--muted)', minWidth: 170, flexShrink: 0 }}>{t('contact.email')}</span>
              <span style={{ color: 'var(--text)', fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                {addr}
                {typeLabel              && <Chip>{typeLabel}</Chip>}
                {parseBool(e.is_default)   && <Chip>{t('contact.is_default')}</Chip>}
                {parseBool(e.is_emergency) && <Chip color="orange">{t('contact.is_emergency')}</Chip>}
              </span>
            </div>
          );
        })}

        {(g.phones || []).map((ph, pi) => {
          const num = ph.phone_number || ph.value || '';
          if (!num) return null;
          const typeKey = `phone_type.${ph.phone_type_id || ph.phone_nr_type_id}`;
          const typeLabel = (ph.phone_type_id || ph.phone_nr_type_id) && i18n.exists(typeKey) ? t(typeKey) : (ph.phone_type_id || ph.phone_nr_type_id || '');
          return (
            <div key={pi} style={{ display: 'flex', gap: 12, padding: '5px 0', fontSize: '0.88rem', borderBottom: '1px solid var(--bg)', alignItems: 'center' }}>
              <span style={{ color: 'var(--muted)', minWidth: 170, flexShrink: 0 }}>{t('contact.phone')}</span>
              <span style={{ color: 'var(--text)', fontWeight: 500, display: 'flex', alignItems: 'center', gap: 6, flexWrap: 'wrap' }}>
                {num}
                {typeLabel                  && <Chip>{typeLabel}</Chip>}
                {parseBool(ph.is_whatsapp)   && <Chip>WhatsApp</Chip>}
                {parseBool(ph.is_telegram)   && <Chip>Telegram</Chip>}
                {parseBool(ph.is_default)    && <Chip>{t('contact.is_default')}</Chip>}
                {parseBool(ph.is_emergency)  && <Chip color="orange">{t('contact.is_emergency')}</Chip>}
              </span>
            </div>
          );
        })}
      </SectionCard>
    );
  }

  function renderApplicant(a, idx) {
    return (
      <SectionCard
        key={a.person_id || a._uid || idx}
        title={`${t('applicant.title', { n: idx + 1 })} — ${[a.first_name, a.last_name].filter(Boolean).join(' ')}`}
        icon="bi-person-hearts"
      >
        <DataRow label={t('field.first_name')}    value={a.first_name} />
        <DataRow label={t('field.middle_name')}   value={a.middle_name} />
        <DataRow label={t('field.last_name')}     value={a.last_name} />
        <DataRow label={t('field.date_of_birth')} value={a.date_of_birth} />
        <DataRow label={t('field.place_of_birth')}value={a.place_of_birth} />
        <DataRow label={t('field.gender')}        value={translateGender(a.gender, t)} />
        <DataRow label={t('field.nationality')}   value={a.nationalities?.[0]?.country_id} />
        <DataRow label={t('field.mother_tongue')} value={a.mother_tongue} />
        <DataRow label={t('field.start_date')}    value={email?.desired_start_date} />
        {(a.previous_schools || []).map((s, si) => (
          <div key={si} style={{ padding: '8px 0 4px', borderBottom: '1px solid var(--bg)' }}>
            <div style={{ display: 'flex', gap: 12, fontSize: '0.88rem' }}>
              <span style={{ color: 'var(--muted)', minWidth: 170, flexShrink: 0 }}>{t('applicant.prev_school')} {si + 1}</span>
              <span style={{ color: 'var(--text)', fontWeight: 500 }}>{s.school_name || '—'}</span>
            </div>
            {(s.from_year || s.to_year) && (
              <div style={{ display: 'flex', gap: 12, fontSize: '0.84rem', marginTop: 2 }}>
                <span style={{ minWidth: 170, flexShrink: 0 }} />
                <span style={{ color: 'var(--muted)' }}>
                  {s.from_year && `${t('field.from_year')}: ${s.from_year}`}
                  {s.from_year && s.to_year && ' · '}
                  {s.to_year && `${t('field.to_year')}: ${s.to_year}`}
                  {s.city && ` · ${s.city}`}
                  {s.country_id && ` (${s.country_id})`}
                </span>
              </div>
            )}
            {(s.education_level_description || s.language_of_instruction) && (
              <div style={{ display: 'flex', gap: 12, fontSize: '0.84rem', marginTop: 2 }}>
                <span style={{ minWidth: 170, flexShrink: 0 }} />
                <span style={{ color: 'var(--muted)' }}>
                  {s.education_level_description && `${t('field.edu_level_desc')}: ${s.education_level_description}`}
                  {s.education_level_description && s.language_of_instruction && ' · '}
                  {s.language_of_instruction && `${t('field.lang_instruction')}: ${s.language_of_instruction}`}
                </span>
              </div>
            )}
          </div>
        ))}
      </SectionCard>
    );
  }

  // ─── Render ────────────────────────────────────────────────────────────────

  return (
    <>
      <div className="mb-3">
        {/* #11: cabecera = MISMO nombre que el stepper (catálogo único). Antes usaba
            la key paralela step7.title ("Resumen") mientras el stepper decía
            step.review ("Revisar y enviar") — Diego pidió "Resumen" en ambos. */}
        <h2 style={{ color: 'var(--teal-dk)', fontWeight: 800 }}>{t(stepLabelKey('review'))}</h2>
        <p style={{ color: 'var(--muted)' }}>{t('step7.subtitle')}</p>
      </div>

      {/* WIZARD-UX: navegación arriba en Step7. Por defecto SOLO "Atrás" (el submit
          es el botón terminal de abajo — no se convierte en StepNav genérico,
          KAL/edit-lock intactos). DL-E38 merge (Diego 2026-06-07): cuando el
          expediente está Aprobado y la firma del grupo está lista
          (canAdvanceToSigning), el "Siguiente" del Step 7 AVANZA a la firma inline —
          mismo botón arriba Y abajo, en las ubicaciones de los pasos 1-6. */}
      <StepNav
        position="top"
        onBack={onBack}
        onNext={onAdvanceToSigning}
        hideNext={!canAdvanceToSigning}
      />

      {/* ②27 — el envío escribe el libro de consentimientos a nombre de un tutor real, así
          que el servidor exige el código de un solo uso igual que para editar. Si la ventana
          se agotó se pide AQUÍ, antes de navegar: en /confirmation no habría dónde. */}
      {pidiendoCodigo && (
        <div className="mb-3" data-testid="submit-stepup">
          <StepUpReverify
            // ②24 — el código va al buzón del tutor que opera, no siempre al del tutor 1.
            tokenPayload={{ resume_token: resumeToken,
                            ...identidadDelEnlace({ n: recoveryNonce, recoveredEmail }) }}
            prompt={t('stepup.submit_prompt')}
            // El reintento lo lanza el `handleSubmit` de ESTE render (vivo), saltándose la
            // comprobación: `markStepUpFresh` aún no se ve en esta vuelta, y el servidor ya
            // tiene la marca puesta por `verifyEmail_`, que es la que manda.
            onVerified={() => {
              markStepUpFresh();
              setPidiendoCodigo(false);
              handleSubmit({ yaVerificado: true });
            }}
          />
        </div>
      )}

      {/* ── Email / Start Date ── */}
      <SectionCard title={t('review.email')} icon="bi-envelope-fill">
        <DataRow label={t('field.primary_email')} value={email?.primary_email} />
        <DataRow label={t('review.verified')} value={email?.verified ? t('yes') : t('no')} />
        <DataRow label={t('field.start_date')} value={email?.desired_start_date} />
      </SectionCard>

      {/* DL-E39 ENMIENDA (gate de entrada): el resumen agregado se muestra con
          normalidad — la PII está protegida por el StepUpGate de entrada, no por
          enmascarado per-campo. */}
      {/* ── Guardians ── */}
      {guardians.map((g, i) => renderGuardian(g, i))}

      {/* ── Applicants ── */}
      {applicants.map((a, i) => renderApplicant(a, i))}

      {/* ── Relations ── */}
      {gaRelations.length > 0 && (
        <SectionCard title={t('step.relations')} icon="bi-diagram-3-fill">
          {gaRelations.map((r, i) => {
            const gId = r.guardian_person_id || r.person_id_a;
            const aId = r.applicant_person_id || r.person_id_b;
            const g = (persons || []).find(p => (p.person_id || p._uid) === gId);
            const a = (persons || []).find(p => (p.person_id || p._uid) === aId);
            if (!g || !a) return null;
            const gName = [g.first_name, g.last_name].filter(Boolean).join(' ');
            const aName = [a.first_name, a.last_name].filter(Boolean).join(' ');
            const relLabel = r.relation_type_id
              ? translateRelationLabel(resolveLabel(lookups.relationTypes, r.relation_type_id), t)
              : '—';
            return (
              <div key={i} style={{ display: 'flex', gap: 12, padding: '7px 0', fontSize: '0.88rem', borderBottom: '1px solid var(--bg)', alignItems: 'center', flexWrap: 'wrap' }}>
                <span style={{ color: 'var(--text)', fontWeight: 600, minWidth: 0 }}>
                  {gName}
                  <span style={{ color: 'var(--muted)', fontWeight: 400 }}> → </span>
                  {aName}
                </span>
                <span style={{ marginLeft: 'auto', display: 'flex', gap: 4, flexWrap: 'wrap', justifyContent: 'flex-end' }}>
                  {relLabel                            && <Chip>{relLabel}</Chip>}
                  {parseBool(r.is_custodial)          && <Chip>{t('relation.is_custodial')}</Chip>}
                  {parseBool(r.is_pick_up_authorized) && <Chip>{t('relation.is_pickup')}</Chip>}
                </span>
              </div>
            );
          })}
        </SectionCard>
      )}

      {/* ── Health + apoyo educativo (paso 4 «Salud y apoyo») ── */}
      {saludYApoyo.some(h => h.allergies?.length || h.dietary?.length || h.medical?.length || h.conditions?.length || h.supports?.length) && (
        <SectionCard title={t('step.health')} icon="bi-heart-pulse-fill">
          {saludYApoyo.map((h, hi) => {
            const applicant = (persons || []).find(p => (p.person_id || p._uid) === h.person_id);
            const name = applicant
              ? [applicant.first_name, applicant.last_name].filter(Boolean).join(' ')
              : null;
            const hasAny = h.allergies?.length || h.dietary?.length || h.medical?.length || h.conditions?.length || h.supports?.length;
            if (!hasAny) return null;
            return (
              <div key={hi} style={{ marginBottom: hi < saludYApoyo.length - 1 ? 14 : 0 }}>
                {name && applicants.length > 1 && (
                  <p style={{ fontWeight: 700, fontSize: '0.85rem', color: 'var(--teal-dk)', marginBottom: 6, marginTop: hi > 0 ? 4 : 0 }}>
                    {name}
                  </p>
                )}
                {(h.allergies || []).length > 0 && (
                  <div style={{ display: 'flex', gap: 8, padding: '5px 0', fontSize: '0.88rem', borderBottom: '1px solid var(--bg)', alignItems: 'flex-start' }}>
                    <span style={{ color: 'var(--muted)', minWidth: 170, flexShrink: 0 }}>{t('health.allergies')}</span>
                    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {h.allergies.map((a, ai) => {
                        const label = a.label || resolveLabel(lookups.allergies, a.food_allergy_id);
                        return (
                          <Chip key={ai} color="red">
                            {label}{a.observations ? ` — ${a.observations}` : ''}
                          </Chip>
                        );
                      })}
                    </span>
                  </div>
                )}
                {(h.dietary || []).length > 0 && (
                  <div style={{ display: 'flex', gap: 8, padding: '5px 0', fontSize: '0.88rem', borderBottom: '1px solid var(--bg)', alignItems: 'flex-start' }}>
                    <span style={{ color: 'var(--muted)', minWidth: 170, flexShrink: 0 }}>{t('health.dietary')}</span>
                    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {h.dietary.map((d, di) => {
                        const label = d.label || resolveLabel(lookups.dietary, d.diet_id);
                        return (
                          <Chip key={di} color="orange">
                            {label}{d.observations ? ` — ${d.observations}` : ''}
                          </Chip>
                        );
                      })}
                    </span>
                  </div>
                )}
                {(h.medical || []).length > 0 && (
                  <div style={{ display: 'flex', gap: 8, padding: '5px 0', fontSize: '0.88rem', borderBottom: '1px solid var(--bg)', alignItems: 'flex-start' }}>
                    <span style={{ color: 'var(--muted)', minWidth: 170, flexShrink: 0 }}>{t('health.medical')}</span>
                    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {h.medical.map((m, mi) => {
                        const label = m.label || resolveLabel(lookups.medical, m.medical_condition_id);
                        return (
                          <Chip key={mi}>
                            {label}{m.observations ? ` — ${m.observations}` : ''}
                          </Chip>
                        );
                      })}
                    </span>
                  </div>
                )}
                {/* Apoyo educativo — mismas dos partes que en el paso 4 (necesidades / apoyos),
                    con sus mismos rótulos: aquí no se inventa ninguna etiqueta nueva. */}
                {(h.conditions || []).length > 0 && (
                  <div style={{ display: 'flex', gap: 8, padding: '5px 0', fontSize: '0.88rem', borderBottom: '1px solid var(--bg)', alignItems: 'flex-start' }}>
                    <span style={{ color: 'var(--muted)', minWidth: 170, flexShrink: 0 }}>{t('neae.review_conditions')}</span>
                    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {h.conditions.map((c, ci) => {
                        // La situación del diagnóstico va pegada a la etiqueta: sin ella,
                        // «TEA» no distingue una sospecha de un dictamen.
                        const label = t('neae.cat.' + c.category_code, { defaultValue: c.category_code });
                        const diag  = c.diagnosis_status
                          ? t('neae.diag.' + c.diagnosis_status, { defaultValue: '' })
                          : '';
                        return (
                          <Chip key={ci}>
                            {diag ? `${label} · ${diag}` : label}{c.observations ? ` — ${c.observations}` : ''}
                          </Chip>
                        );
                      })}
                    </span>
                  </div>
                )}
                {(h.supports || []).length > 0 && (
                  <div style={{ display: 'flex', gap: 8, padding: '5px 0', fontSize: '0.88rem', borderBottom: '1px solid var(--bg)', alignItems: 'flex-start' }}>
                    <span style={{ color: 'var(--muted)', minWidth: 170, flexShrink: 0 }}>{t('neae.review_supports')}</span>
                    <span style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
                      {h.supports.map((s, si) => {
                        const label = t('neae.sup.' + s.support_type, { defaultValue: s.support_type });
                        const scope = s.provider_scope
                          ? t('neae.scope.' + s.provider_scope, { defaultValue: '' })
                          : '';
                        return (
                          <Chip key={si}>
                            {scope ? `${label} · ${scope}` : label}{s.observations ? ` — ${s.observations}` : ''}
                          </Chip>
                        );
                      })}
                    </span>
                  </div>
                )}
              </div>
            );
          })}
        </SectionCard>
      )}

      {/* ── Questions ──
          DL-Q05 Q05-S3 decision: NOT migrated to <QbSetRenderer readOnly />.
          The review pane renders a flat list of "label + value" rows inside a
          single SectionCard, skipping empty responses. The shared renderer
          fans out per audience + person and emits one .kis-card per set,
          which clashes with the review layout. Keeping the dedicated DataRow
          path here is shorter than rebuilding that summary on top of the
          renderer's per-input markup. */}
      {allQuestions.length > 0 && Object.keys(questions || {}).length > 0 && (
        <SectionCard title={t('step.questions')} icon="bi-chat-square-text-fill">
          {Object.entries(questions || {}).map(([key, val], i) => {
            if (val === '' || val === null || val === undefined || val === false) return null;
            const [qid] = key.split('__');
            const q = allQuestions.find(qq => qq.question_id === qid);
            if (!q) return null;
            const displayVal = Array.isArray(val) ? val.join(', ') : String(val);
            return <DataRow key={i} label={q.question_text || qid} value={displayVal} />;
          })}
        </SectionCard>
      )}

      {/* ── Documents ── */}
      {(documents || []).length > 0 && (
        <SectionCard title={t('step.documents')} icon="bi-folder-fill">
          {documents.map((d, i) => {
            // WIZARD-DOCS (2026-06-13): adjuntador genérico → mostramos el texto
            // libre del usuario (description). Compat: filas antiguas con un tipo
            // tasado siguen mostrando su label vía doc.<document_type>; fallback al
            // nombre del archivo o un genérico si no hay descripción.
            const docKey = `doc.${d.document_type}`;
            const label = (d.description && d.description.trim())
              ? d.description.trim()
              : (d.document_type && d.document_type !== 'other' && i18n.exists(docKey))
                ? t(docKey)
                : (d.file_name || t('doc.generic_label'));
            return (
              <div key={i} style={{ display: 'flex', gap: 12, padding: '5px 0', fontSize: '0.88rem', borderBottom: '1px solid var(--bg)', alignItems: 'center' }}>
                <span style={{ color: 'var(--muted)', minWidth: 170, flexShrink: 0 }}>{label}</span>
                <span style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                  <i className="bi bi-check-circle-fill" style={{ color: '#2e7d32', fontSize: '0.9rem' }} />
                  <span style={{ color: 'var(--text)', fontWeight: 500 }}>{t('doc.uploaded')}</span>
                  {/* CLI 82 / KAL-NEW-5: ver el documento vía proxy de bytes
                      (getDocument + resume_token), nunca un enlace público. */}
                  {d.file_id && (
                    <button type="button" className="btn btn-link p-0"
                      style={{ fontSize: '0.8rem', color: 'var(--teal-dk)', verticalAlign: 'baseline' }}
                      onClick={() => openDocument({ file_id: d.file_id, resume_token: resumeToken, ...identidadDelEnlace({ n: recoveryNonce, recoveredEmail }) })
                        .catch(e => log.error('Step7: getDocument failed', { message: e.message }))}>
                      <i className="bi bi-box-arrow-up-right ms-1" />
                    </button>
                  )}
                </span>
              </div>
            );
          })}
        </SectionCard>
      )}

      {isSubmitted ? (
        <>
          <div className="kis-card mt-3" style={{ textAlign: 'center', padding: '32px 20px' }}>
            <i className="bi bi-check-circle-fill" style={{ fontSize: '2.8rem', color: '#2e7d32' }} />
            <h3 style={{ color: '#1b5e20', marginTop: 16, marginBottom: 8 }}>
              {t('step7.submitted_title')}
            </h3>
            <p style={{ color: '#2e4a2f', marginBottom: 0, maxWidth: 440, margin: '0 auto' }}>
              {t('step7.submitted_note')}
            </p>
          </div>
          <div className="kis-card mt-3" style={{ textAlign: 'left' }}>
            <h3 style={{ color: 'var(--teal-dk)', marginTop: 0, fontSize: '1rem' }}>
              {t('confirmation.next_steps_title')}
            </h3>
            <ul style={{ color: 'var(--text)', lineHeight: 1.8, paddingLeft: 20, marginBottom: 0 }}>
              <li>{t('confirmation.next_1')}</li>
              <li>{t('confirmation.next_2')}</li>
              <li>{t('confirmation.next_3')}</li>
            </ul>
            <CorrectionRequest resumeToken={resumeToken} t={t} />
          </div>
          {/* ⭐ `③70` — la familia que YA ENVIÓ también puede CONSULTAR la simulación.
              Hasta hoy este recuadro solo se pintaba en la rama «todavía no enviada», así
              que quien volvía a entrar se quedaba en el paso 7 con los pasos previos
              bloqueados y SIN NINGUNA CIFRA. El servidor siempre lo permitió:
              `simularCuotas_` lleva solo `requireResumeToken_` —ni `assertGroupEditable_`
              ni código de un solo uso, a propósito, porque es una LECTURA—, así que aquí
              no hace falta tocar nada del backend. Va en SOLO LECTURA: se ven las cifras y
              todas las formas de pago, no se elige ninguna. */}
          <SimulacionDeCuotas resumeToken={resumeToken} applicants={applicants} t={t} lang={lang} soloLectura />
          {/* DL-E38 merge: bottom nav mirrors the top — Back + (state-driven)
              advance-to-signing "Continuar". Same positions as steps 1-6. */}
          <StepNav
            position="bottom"
            onBack={onBack}
            onNext={onAdvanceToSigning}
            hideNext={!canAdvanceToSigning}
          />
        </>
      ) : (
        <>
          {/* Paso 7 · el simulador de cuotas. Va ANTES del botón de enviar y NO lo gatea:
              es un recuadro aparte, sin ningún estado compartido con `handleSubmit`. */}
          <SimulacionDeCuotas resumeToken={resumeToken} applicants={applicants} t={t} lang={lang} />

          <div className="kis-card mt-3">
            <h3 style={{ color: 'var(--teal-dk)', marginTop: 0, fontSize: '1rem' }}>{t('step7.legal_title')}</h3>

            <div className="consent-block">
              <p className="consent-text"><strong>EN:</strong> {CONSENT_TEXTS.gdpr.en}</p>
              <p className="consent-text"><strong>ES:</strong> {CONSENT_TEXTS.gdpr.es}</p>
              <div className="form-check">
                <input type="checkbox" className="form-check-input" id="consent_gdpr"
                  checked={consentGdpr} onChange={e => setConsentGdpr(e.target.checked)} />
                <label className="form-check-label fw-semibold" htmlFor="consent_gdpr">
                  {t('consent.gdpr_accept')}
                </label>
              </div>
            </div>

            <div className="consent-block">
              <p className="consent-text"><strong>EN:</strong> {CONSENT_TEXTS.legal.en}</p>
              <p className="consent-text"><strong>ES:</strong> {CONSENT_TEXTS.legal.es}</p>
              <div className="form-check">
                <input type="checkbox" className="form-check-input" id="consent_legal"
                  checked={consentLegal} onChange={e => setConsentLegal(e.target.checked)} />
                <label className="form-check-label fw-semibold" htmlFor="consent_legal">
                  {t('consent.legal_accept')}
                </label>
              </div>
            </div>

          </div>

          {/* UX-1: el aviso de validación se muestra en la zona sticky superior (WizardPage). */}

          <div className="d-flex justify-content-between mt-4">
            <button className="btn-secondary-kis" onClick={onBack} disabled={submitting}>
              <i className="bi bi-arrow-left me-1" /> {t('nav.back')}
            </button>
            <button className="btn-primary-kis" onClick={handleSubmit} disabled={submitting}>
              {submitting
                ? <><span className="spinner-border spinner-border-sm me-2" />{t('step7.submitting')}</>
                : <><i className="bi bi-send me-1" />{t('step7.submit')}</>
              }
            </button>
          </div>

          <p style={{ textAlign: 'center', fontSize: '0.75rem', color: 'var(--muted)', marginTop: 12 }}>
            {t('step7.recaptcha_notice')}
          </p>
        </>
      )}
    </>
  );
}
