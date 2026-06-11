import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { gasCall, initiateSigningRead } from '../../api';
import { useWizard } from '../../context/WizardContext';
import StepShell from '../../components/StepShell';
import StepUpReverify from '../../components/StepUpReverify';
import { signingIdentity_, isStepUpRequiredError } from './signingCommon';
import * as log from '../../logger';

/**
 * Step 10 — S-REVIEW (paquete contractual + confirmación de lectura, doc a doc).
 *
 * REBUILD-8-11 (Diego 2026-06-11): paso REAL, ciudadano idéntico a los 1-7 — chasis
 * StepShell, guardado OPTIMISTA por la MISMA cola (enqueueSave → nube global), y las
 * ACEPTACIONES por documento en WizardContext (signingForms.review — sobreviven a
 * navegar 10→11→10). Los contratos (initiateSigningRead create_only para members,
 * getDocument vía cache del contexto, confirmReview con accepted:[{file_id,
 * purpose_code, sha256}]) están COPIADOS VERBATIM del SignReview probado (antiguo
 * pages/signing/* (monolito del antiguo host /sign), eliminado en este cambio).
 *
 * Visor (decisión Diego 2026-06-11): UN documento a la vez, ancho completo,
 * "Documento i de N" + prev/siguiente, "He leído y acepto" POR documento
 * (auto-avanza al siguiente no aceptado), confirmar solo con todos aceptados.
 * El iframe va SIN atributo `sandbox`: Chrome BLOQUEA su visor PDF interno dentro
 * de iframes sandboxed (verificado con captura 2026-06-11) — el blob es nuestro
 * propio PDF contractual servido por object URL, no contenido de terceros.
 * Espera ACTIVA mientras el paquete se prepara (poll 6s + progreso visible),
 * JAMÁS "vuelve en unos minutos".
 */
export default function Step10Review({ onAdvance, onBack, signingToken, resumeToken }) {
  const { t } = useTranslation();
  const {
    isStepUpFresh, markStepUpFresh, enqueueSave,
    recoveredEmail, recoveryNonce,
    // STEP10-VIEWER: el cache de documentos vive en el CONTEXTO (object URLs + sha256
    // keyed por file_id) — navegar 10→11→10 NO refetchea.
    docCache, loadDocument, signingMembers, setSigningMembers,
    signingForms, updateSigningForm,
  } = useWizard();
  // members sembrados del cache del contexto → re-entrada al Step 10 pinta al
  // instante; el efecto de abajo los refresca igualmente en background.
  const [members, setMembers] = useState(signingMembers); // null=loading/preparando
  const [loadErr, setLoadErr] = useState('');
  const [err, setErr] = useState('');
  // DL-E39: la revisión del paquete contractual carga documentos sensibles vía
  // getDocument (handler gateado). Si no hay step-up fresco — o el backend
  // devuelve STEPUP_REQUIRED — exigimos re-verificar antes de cargar/previsualizar.
  const [needStepUp, setNeedStepUp] = useState(!isStepUpFresh());
  const [reloadKey, setReloadKey] = useState(0);
  // ESPERA ACTIVA (STEP-FRAMEWORK): cuando initiateSigningRead devuelve members vacíos
  // (el KMS aún genera la Carta/Contrato), reintento automático (poll corto) con
  // PROGRESO visible — nunca un muro "vuelve en unos minutos".
  const [attempt, setAttempt] = useState(0);
  const POLL_MS = 6000;        // reintento corto mientras el paquete se prepara
  const [idx, setIdx] = useState(0);            // documento visible (0-based)
  // ── Aceptaciones por documento — EN EL CONTEXTO (REBUILD-8-11) ────────────────
  // signingForms.review = { accepted: { [file_id]: true } } → sobrevive a 10→11→10.
  const accepted = (signingForms.review && signingForms.review.accepted) || {};
  const setAccepted = (next) => updateSigningForm('review', f => ({ ...(f || {}), accepted: next }));

  useEffect(() => {
    if (needStepUp) return undefined;
    let alive = true;
    let retryTimer = null;
    // P-REVIEW-READONLY VERBATIM: Step 10 solo LEE los docs/members → create_only (NO
    // despacha el envelope). El dispatch real del acto de firma vive SOLO en Step 11.
    // Data-layer pieza 5: single-flight (de-dupe la tormenta de create_only concurrentes).
    const _t0 = Date.now();
    log.info('[DBG review] initiateSigningRead start', { attempt });
    // IDENTITY-COMPLETION (#30): identidad de SESIÓN (resume_token + `n` del enlace).
    initiateSigningRead({ resumeToken, signingToken, n: recoveryNonce, recoveredEmail })
      .then(res => {
        const ms = Date.now() - _t0;
        const mem = Array.isArray(res.members) ? res.members : [];
        log.info('[DBG review] members', { ms, n: mem.length, attempt, files8: mem.map(m => log.sid(m.file_id)), states: mem.map(m => m.purpose_code || '?') });
        if (!alive) return;
        if (mem.length === 0) {
          // Si ya teníamos members (sembrados del cache del contexto), un read vacío
          // transitorio NO los pisa ni re-arranca la espera activa.
          if (Array.isArray(members) && members.length) return;
          // Paquete aún no listo → ESPERA ACTIVA: re-pollea solo; el render muestra
          // el progreso. members se mantiene en null ("preparando…", no "vacío").
          log.info('[DBG review] paquete no listo — reintento automático', { in_ms: POLL_MS, next_attempt: attempt + 1 });
          retryTimer = setTimeout(() => { if (alive) setAttempt(a => a + 1); }, POLL_MS);
          return;
        }
        setMembers(mem);
        setSigningMembers(mem); // cache del contexto (re-entrada instantánea)
      })
      .catch(e => {
        if (isStepUpRequiredError(e)) {
          log.warn('Step10Review: initiateSigningSession requires step-up');
          if (alive) setNeedStepUp(true);
          return;
        }
        // Un fallo de RED tampoco manda al cliente a "vuelve en unos minutos" —
        // reintento automático con el mismo poll. El error duro solo se muestra si
        // persiste tras varios intentos (loadErr).
        log.warn('Step10Review: initiateSigningRead failed — reintento automático', { attempt, message: e && e.message });
        if (!alive) return;
        // Con members ya sembrados del cache, el refresh fallido no degrada la pantalla.
        if (Array.isArray(members) && members.length) return;
        if (attempt >= 8) { setLoadErr(e.message || t('signing.generic_error')); return; }
        retryTimer = setTimeout(() => { if (alive) setAttempt(a => a + 1); }, POLL_MS);
      });
    return () => { alive = false; if (retryTimer) clearTimeout(retryTimer); };
  }, [signingToken, resumeToken, recoveryNonce, recoveredEmail, needStepUp, reloadKey, attempt]); // eslint-disable-line

  // STEP10-VIEWER VERBATIM (blob-only): resuelve los bytes de cada documento vía el
  // cache del CONTEXTO (loadDocument → object URL + sha256 keyed por file_id).
  // Cache-hit → CERO red (10→11→10 instantáneo). El visor usa SIEMPRE object URLs de
  // PDF (CSP frame-src blob:). NO se revoca nada al desmontar el step: la revocación
  // vive en WizardContext (clearSession / desmontaje del wizard).
  useEffect(() => {
    if (!members || !members.length) return undefined;
    let alive = true;
    members.forEach(m => {
      if (!m.file_id || docCache[m.file_id]) return; // ya en cache → no refetch
      const _t0 = Date.now();
      log.info('[DBG review] getDocument start', { file8: log.sid(m.file_id) });
      // IDENTITY-COMPLETION (#30): getDocument_ acepta resume_token + `n` (resuelve el
      // signing_token server-side del enlace para el proxy KMS) o signing_token (compat).
      loadDocument({
        file_id: m.file_id,
        ...(resumeToken
          ? { resume_token: resumeToken, n: recoveryNonce || undefined, recovered_email: recoveredEmail || undefined }
          : { signing_token: signingToken }),
      })
        .then((entry) => {
          log.info('[DBG review] getDocument OK', { file8: log.sid(m.file_id), ms: Date.now() - _t0, has_url: !!(entry && entry.url), has_sha256: !!(entry && entry.sha256) });
        })
        .catch(e => {
          log.warn('[DBG review] getDocument FAIL', { file8: log.sid(m.file_id), ms: Date.now() - _t0, code: e && e.code, message: e && e.message });
          if (isStepUpRequiredError(e)) { if (alive) setNeedStepUp(true); return; }
          log.error('Step10Review: getDocument failed', { file_id: m.file_id, message: e.message });
        });
    });
    return () => { alive = false; };
  }, [members, signingToken, resumeToken]); // eslint-disable-line

  // ── Derivados del visor (UN doc a la vez + aceptación por doc) ────────────────
  // N es DINÁMICO: los members que el paquete declara (cero hardcode de documentos).
  const docs = (members || []).filter(m => m.file_id);
  const total = docs.length;
  const safeIdx = Math.min(idx, Math.max(0, total - 1));
  const current = total ? docs[safeIdx] : null;
  const currentEntry = current ? docCache[current.file_id] : null;
  const acceptedCount = docs.filter(m => accepted[m.file_id]).length;
  const allAccepted = total > 0 && acceptedCount === total;

  // Aceptación explícita del documento visible; al aceptar, auto-avanza al siguiente
  // documento NO aceptado si lo hay ("aceptación de documentos uno a uno").
  const acceptCurrent = () => {
    if (!current) return;
    const next = { ...accepted, [current.file_id]: true };
    setAccepted(next);
    setErr('');
    const nextIdx = docs.findIndex(m => !next[m.file_id]);
    if (nextIdx >= 0) setIdx(nextIdx);
  };

  // Avance OPTIMISTA uniforme con los pasos 1-7: (1) gate LOCAL (todos los documentos
  // aceptados uno a uno — condición del ACTO confirmReview, no una puerta de navegación
  // nueva); (2) payload VERBATIM construido ANTES de encolar; (3) enqueueSave SIN await
  // previo → nube global; (4) avance inmediato. El Step 11 SÍ drena la cola
  // (awaitPendingSave) antes del acto de firma — único await legítimo.
  const confirm = () => {
    log.info('[DBG review] confirm CLICK', { accepted_n: acceptedCount, total: docs.length });
    if (!allAccepted) { setErr(t('signing.review.must_accept_all')); return; }
    setErr('');
    log.info('[DBG review] confirm — avanzando (confirmReview encolado)');
    // VERBATIM: el acto registra QUÉ versiones se aceptaron — accepted[] con
    // {file_id, purpose_code, sha256}. El sha256 sale del response de getDocument
    // (DOC-BYTES); se tolera null/ausente hasta que el backend lo emita y lo registre.
    // KAL-4/KAL-7 intactos (identidad server-side del token).
    const acceptedPayload = docs.map(m => ({
      file_id:      m.file_id,
      purpose_code: m.purpose_code || null,
      sha256:       (docCache[m.file_id] && docCache[m.file_id].sha256) || null,
    }));
    const payload = { ...signingIdentity_({ resumeToken, signingToken, n: recoveryNonce, recoveredEmail }), accepted: acceptedPayload };
    enqueueSave(() => gasCall('confirmReview', payload)
      .then(res => {
        // Baseline tras save OK (espejo de markStepSaved).
        updateSigningForm('review', f => ({ ...(f || {}), baseline: { accepted } }));
        return res;
      })
      .catch(e => {
        // STEPUP_REQUIRED dentro de la cola: no se reintenta a ciegas — propaga a la nube.
        if (isStepUpRequiredError(e)) log.warn('Step10Review: confirmReview requires step-up (queued)');
        else log.error('Step10Review: confirmReview failed (background)', { message: e.message });
        throw e;
      }));
    onAdvance(); // avance optimista inmediato
  };

  // El nombre del documento es DINÁMICO — del propio member que el paquete declara
  // (designation / purpose_code), con i18n key como preferencia y fallback a lo que el
  // KMS mande. Cero literales de documentos hardcodeados.
  const docLabel = (m) => t('signing.doc.' + (m.purpose_code || ''), { defaultValue: m.designation || m.purpose_code || t('signing.review.document') });
  // Lista de nombres de los documentos del paquete (para el subtítulo dinámico). Si el
  // paquete aún no cargó, cae al subtítulo genérico (sin nombrar Carta/Contrato a ciegas).
  const memberLabels = (members || []).map(docLabel);

  // DL-E39: gate step-up antes de revelar el paquete contractual (docs sensibles).
  if (needStepUp) {
    const backOnly = (position) => (
      <div className={position === 'top' ? 'd-flex justify-content-between mb-3' : 'd-flex justify-content-between mt-3'}>
        <button className="btn-secondary-kis" onClick={onBack}>
          <i className="bi bi-arrow-left me-1" />{t('nav.back')}
        </button>
        <span />
      </div>
    );
    return (
      <div className="kis-card">
        {backOnly('top')}
        <h2 style={{ color: 'var(--teal-dk)', fontWeight: 800, fontSize: '1.2rem' }}>{t('signing.review.title')}</h2>
        <p style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>{t('stepup.review_gate_body')}</p>
        <StepUpReverify
          /* IDENTITY-COMPLETION (#30): identidad de SESIÓN. _resolveStepUpGroup_ deriva
             el grupo del resume_token (preferente) o signing_token (compat). */
          tokenPayload={signingIdentity_({ resumeToken, signingToken, n: recoveryNonce, recoveredEmail })}
          prompt={t('stepup.review_prompt')}
          onVerified={() => {
            markStepUpFresh();
            // NO se purga el cache de docs del contexto — lo que falló por
            // STEPUP_REQUIRED nunca se cacheó (cache-miss limpio).
            setMembers(signingMembers);
            setNeedStepUp(false);
            setReloadKey(k => k + 1);
          }}
        />
        {backOnly('bottom')}
      </div>
    );
  }

  // El "Continuar" se bloquea por la gate de validación (lectura confirmada) Y por que
  // el paquete esté listo (members presentes). Hasta entonces la ESPERA es ACTIVA
  // (progreso visible). El subtítulo nombra los documentos REALES del paquete.
  const packageReady = !loadErr && Array.isArray(members) && members.length > 0;
  const subtitle = packageReady && memberLabels.length
    ? t('signing.review.subtitle_named', { docs: memberLabels.join(' · ') })
    : t('signing.review.subtitle');

  return (
    <div className="kis-card">
      <StepShell
        title={t('signing.review.title')}
        subtitle={subtitle}
        onBack={onBack}
        onNext={confirm}
        nextLabel={t('signing.review.submit')}
        nextDisabled={!allAccepted || !packageReady}
        error={err}
      >
        {/* ESPERA ACTIVA mientras el paquete se prepara — progreso visible + reintento
            automático, JAMÁS "vuelve en unos minutos". El error DURO (loadErr, tras 8
            reintentos) sí informa con un mensaje accionable (contactar admisiones). */}
        {loadErr ? (
          <div className="kis-card" style={{ textAlign: 'center', color: 'var(--muted)', background: 'var(--bg)' }}>
            <i className="bi bi-exclamation-triangle" style={{ fontSize: '1.5rem', display: 'block', marginBottom: 8, color: '#a02020' }} />
            {t('signing.review.package_error')}
          </div>
        ) : !packageReady ? (
          <div className="kis-card" style={{ textAlign: 'center', color: 'var(--muted)', background: 'var(--bg)' }}>
            <span className="spinner-border spinner-border-sm me-2" />
            {t('signing.review.package_preparing')}
            <div style={{ fontSize: '0.78rem', marginTop: 6 }}>{t('signing.review.package_auto_refresh')}</div>
          </div>
        ) : (
          <>
            {/* Visor AMPLIO: UN documento a la vez (ancho completo, alto generoso),
                navegación prev/siguiente + "documento i de N" y aceptación explícita
                POR documento. El object URL sale del cache del contexto (blob-only). */}
            {current && (
              <div style={{ marginBottom: 12 }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginBottom: 6 }}>
                  <strong style={{ color: 'var(--teal-dk)', fontSize: '1rem' }}>
                    {docLabel(current)}
                    {accepted[current.file_id] && (
                      <span style={{ marginLeft: 10, fontSize: '0.78rem', color: '#2e7d32', fontWeight: 700 }}>
                        <i className="bi bi-check-circle-fill me-1" />{t('signing.review.accepted')}
                      </span>
                    )}
                  </strong>
                  <span style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
                    <span style={{ fontSize: '0.82rem', color: 'var(--muted)', fontWeight: 600 }}>
                      {t('signing.review.doc_counter', { i: safeIdx + 1, n: total })}
                    </span>
                    {currentEntry && (
                      <a href={currentEntry.url} target="_blank" rel="noreferrer" style={{ fontSize: '0.8rem', color: 'var(--teal-dk)' }}>
                        {t('signing.review.open_doc')} <i className="bi bi-box-arrow-up-right ms-1" />
                      </a>
                    )}
                  </span>
                </div>

                {/* REBUILD-8-11: iframe SIN atributo `sandbox` — Chrome bloquea su visor
                    PDF interno dentro de iframes sandboxed (captura Diego 2026-06-11).
                    El src es un object URL de NUESTRO PDF contractual (blob del cache del
                    contexto), no contenido de terceros. */}
                {currentEntry ? (
                  <iframe
                    title={docLabel(current)}
                    src={currentEntry.url}
                    style={{ width: '100%', height: 'min(72vh, 880px)', minHeight: 420, border: '1px solid var(--border)', borderRadius: 8, background: '#fff' }}
                  />
                ) : (
                  <div style={{ textAlign: 'center', padding: 48, color: 'var(--muted)', border: '1px solid var(--border)', borderRadius: 8 }}>
                    <span className="spinner-border spinner-border-sm me-2" />{t('signing.review.docs_loading')}
                  </div>
                )}

                {/* Controles: anterior · aceptar este documento · siguiente */}
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap', marginTop: 10 }}>
                  <button type="button" className="btn-secondary-kis" disabled={safeIdx === 0}
                    onClick={() => { setErr(''); setIdx(safeIdx - 1); }}>
                    <i className="bi bi-chevron-left me-1" />{t('signing.review.prev_doc')}
                  </button>
                  {!accepted[current.file_id] ? (
                    <button type="button" className="btn-primary-kis" disabled={!currentEntry} onClick={acceptCurrent}>
                      <i className="bi bi-check2 me-1" />{t('signing.review.accept_doc')}
                    </button>
                  ) : (
                    <span style={{ fontSize: '0.86rem', color: '#2e7d32', fontWeight: 700 }}>
                      <i className="bi bi-check-circle-fill me-1" />{t('signing.review.accepted')}
                    </span>
                  )}
                  <button type="button" className="btn-secondary-kis" disabled={safeIdx >= total - 1}
                    onClick={() => { setErr(''); setIdx(safeIdx + 1); }}>
                    {t('signing.review.next_doc')}<i className="bi bi-chevron-right ms-1" />
                  </button>
                </div>

                {/* Progreso de aceptación — el ACTO "Confirmar y proceder a la firma" se
                    habilita SOLO cuando TODOS los documentos están aceptados. */}
                <p style={{ textAlign: 'center', fontSize: '0.82rem', color: allAccepted ? '#2e7d32' : 'var(--muted)', fontWeight: 600, marginTop: 10, marginBottom: 0 }}>
                  {t('signing.review.accept_progress', { accepted: acceptedCount, n: total })}
                </p>
              </div>
            )}
          </>
        )}
      </StepShell>
    </div>
  );
}
