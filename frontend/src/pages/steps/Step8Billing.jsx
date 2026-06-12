import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { gasCall } from '../../api';
import { useWizard } from '../../context/WizardContext';
import StepShell from '../../components/StepShell';
import SplitEditor from '../../components/SplitEditor';
import { signingIdentity_, isStepUpRequiredError } from './signingCommon';
import { stepLabelKey } from './catalog'; // #11: el nombre del paso sale del catálogo
import * as log from '../../logger';

/**
 * Step 8 — S-BILLING (Reparto del pago entre tutores).
 *
 * REBUILD-8-11 (Diego 2026-06-11: "bórralos y reconstrúyelos desde cero"): paso REAL,
 * ciudadano idéntico a los 1-7 — chasis StepShell, guardado OPTIMISTA por la MISMA
 * cola FIFO (enqueueSave → nube global SaveIndicator), estado del formulario en
 * WizardContext (signingForms.billing: sobrevive a 8→9→8; el server solo siembra si
 * el usuario no tocó; baseline tras save OK). Los contratos de datos (payload de
 * saveBillingInfo group-level `payers[]` / per-hijo `per_participant[]`, lectura
 * getSavedBillingSplits, seedPayers) están COPIADOS VERBATIM del SignBilling probado
 * (antiguo pages/signing/* (monolito del antiguo host /sign), eliminado en este cambio).
 *
 * El formulario fiscal se eliminó (billing rediseño 2026-06-08): los datos fiscales
 * viven en el registro core del pagador y el KMS los deriva por payer_person_id.
 * CLI 10 (DL-E42 §3/§5): reparto per-PARTICIPANTE opcional (un reparto por hijo).
 * El KMS deriva grupo+enrollments del token (KAL-4) y mapea hijo → finSubscription.
 */
export default function Step8Billing({ onAdvance, onBack, signingToken, resumeToken, signerCtx, savedSplits: savedSplitsProp }) {
  const { t } = useTranslation();
  const {
    stepData, enqueueSave, recoveredEmail, recoveryNonce,
    signingForms, updateSigningForm, admissionState,
  } = useWizard();
  // Decisión Diego 2026-06-12: tras aceptar los documentos y enviarse a firma
  // (hito durable REVIEW_CONFIRMED), el wizard se BLOQUEA — solo lectura. El
  // backend además rechaza el acto con SIGNING_LOCKED (defensa en profundidad).
  const signingLocked = !!(admissionState && admissionState.signing_context
    && admissionState.signing_context.steps && admissionState.signing_context.steps.review_completed);
  // Default payer = signing guardian (DL-E38: identity derived server-side from the
  // token). KAL-4 intact — the KMS re-derives enrollment_group_id + signer from the
  // token, never from this payload.
  const guardianPersonId = signerCtx && signerCtx.guardian_person_id;
  const persons = (stepData && stepData.persons) || [];
  const guardians  = persons.filter(p => p.person_type_id === 'guardian');
  const applicants = persons.filter(p => p.person_type_id === 'applicant');

  const fullNameOf = (g) => [g.first_name, g.middle_name, g.last_name]
    .filter(x => x && String(x).trim()).join(' ').trim();

  // VERBATIM (WPERF-4 bug 1): rehidrata desde el reparto GUARDADO si existe (savedList =
  // [{payer_person_id, split_percentage}] de enr.getSavedBillingSplits). Si no hay
  // guardado, cae al default firmante 100% / resto 0%. Fallback (sin stepData):
  // una sola fila GUARDIAN (el firmante) al 100%.
  const seedPayers = (savedList) => {
    const savedByPid = {};
    (savedList || []).forEach(s => {
      if (s && s.payer_person_id != null) savedByPid[String(s.payer_person_id)] = Number(s.split_percentage) || 0;
    });
    const hasSaved = Object.keys(savedByPid).length > 0;
    if (guardians.length) {
      const rows = guardians.map((g, i) => {
        const pid = g.person_id || g._uid;
        const isSigner = guardianPersonId ? pid === guardianPersonId : i === 0;
        const split = hasSaved
          ? (savedByPid[String(pid)] != null ? savedByPid[String(pid)] : 0)
          : (isSigner ? 100 : 0);
        return {
          key: 'g_' + (pid || i),
          payer_person_id: pid || (isSigner ? guardianPersonId : null) || null,
          name: fullNameOf(g) || t('signing.billing.split.guardian_fallback', { n: i + 1 }),
          split,
        };
      });
      // Si el guardado no casó con ningún tutor (o no había guardado), garantiza un 100%.
      if (!rows.some(r => (Number(r.split) || 0) > 0) && rows.length) {
        const si = rows.findIndex(r => guardianPersonId && r.payer_person_id === guardianPersonId);
        rows[si >= 0 ? si : 0].split = 100;
      }
      return rows;
    }
    return [{ key: 'signer', payer_person_id: guardianPersonId || null, name: t('signing.billing.split.you'), split: 100 }];
  };

  // ── Estado del formulario — EN EL CONTEXTO (REBUILD-8-11) ─────────────────────
  // signingForms.billing = { payers, perChild, childSplits } | undefined (sin sembrar).
  // El componente solo SIEMBRA cuando el slice no existe; cada edición escribe al
  // contexto → navegar 8→9→8 conserva el reparto del usuario (no re-siembra del server).
  const form = signingForms.billing || null;
  const payers      = (form && form.payers) || [];
  const perChild    = !!(form && form.perChild);
  const childSplits = (form && form.childSplits) || {};
  const [err, setErr] = useState('');
  // Reparto YA GUARDADO leído del server (null = aún cargando) — SOLO alimenta la
  // siembra inicial; jamás pisa un formulario ya existente en el contexto.
  const [savedSplits, setSavedSplits] = useState(null);

  // Construye el slice sembrado completo desde un reparto guardado normalizado (o
  // defaults si src=null). Compartido por la siembra inmediata y la revalidación.
  const buildSeed_ = (src) => {
    const seeded = seedPayers(src ? src.payers : null);
    const map = {};
    if (applicants.length) {
      const perChildSaved = {};
      ((src && src.per_participant) || []).forEach(pp => {
        if (pp && pp.applicant_person_id) perChildSaved[String(pp.applicant_person_id)] = pp.payers;
      });
      applicants.forEach(a => { const k = a.person_id || a._uid; map[k] = seedPayers(perChildSaved[String(k)]); });
    }
    return { payers: seeded, perChild: false, childSplits: map };
  };

  // DL-B §1 VERBATIM: el reparto guardado YA viene en la hidratación consolidada
  // (savedSplitsProp, del store WizardContext.billingSplits). Si está presente lo
  // usamos directamente y NO hacemos la lectura getSavedBillingSplits por-entrada.
  // Solo caemos al fetch si el prop no llegó. Si el formulario YA existe en el
  // contexto (usuario tocó / siembra previa) ni siquiera leemos: su valor manda.
  // VIEWER-UX (revalidación silenciosa): el fetch corre EN BACKGROUND — la siembra
  // de abajo NO lo espera (el paso pinta interactivo al instante con defaults).
  useEffect(() => {
    let alive = true;
    if (form && (form.touched || form.seededFromServer)) return undefined; // el input del usuario manda — cero lecturas
    if (savedSplitsProp && typeof savedSplitsProp === 'object') {
      setSavedSplits({
        payers:          savedSplitsProp.payers || [],
        per_participant: savedSplitsProp.per_participant || [],
      });
      return undefined;
    }
    // IDENTITY-COMPLETION (#30): identidad de SESIÓN (resume_token preferente; el backend
    // resuelve el firmante server-side). El signing_token queda como compat. Si no hay
    // NINGUNA identidad → reparto vacío.
    if (!resumeToken && !signingToken) { setSavedSplits({ payers: [], per_participant: [] }); return undefined; }
    gasCall('getSavedBillingSplits', signingIdentity_({ resumeToken, signingToken, n: recoveryNonce, recoveredEmail }))
      .then(res => {
        const norm = (res && typeof res === 'object')
          ? { payers: res.payers || [], per_participant: res.per_participant || [] }
          : { payers: [], per_participant: [] };
        log.info('[DBG billing] saved splits', {
          group_payers: norm.payers.map(p => ({ pid8: log.sid(p.payer_person_id), split: p.split_percentage })),
          per_participant_n: norm.per_participant.length,
        });
        if (alive) setSavedSplits(norm);
      })
      .catch(e => {
        log.warn('[DBG billing] getSavedBillingSplits failed', { message: e && e.message });
        if (alive) setSavedSplits({ payers: [], per_participant: [] });
      });
    return () => { alive = false; };
  }, [signingToken, resumeToken, recoveryNonce, recoveredEmail]); // eslint-disable-line

  // Siembra INMEDIATA del formulario al CONTEXTO (VIEWER-UX, queja Diego: "sigue sin
  // hacer guardado optimista en el paso 8-9 […] clic → spinner"): el paso pinta
  // INTERACTIVO al instante. Si la hidratación consolidada (savedSplitsProp) o una
  // lectura previa (savedSplits) ya trajeron el reparto guardado, se siembra de ahí
  // (seededFromServer); si no, defaults (firmante 100%) SIN esperar al fetch — la
  // lectura de arriba pasa a revalidación en background (efecto de abajo).
  // updateSigningForm con función: si otra carrera ya sembró, NO se pisa.
  useEffect(() => {
    if (form) return;
    const fromProp = (savedSplitsProp && typeof savedSplitsProp === 'object')
      ? { payers: savedSplitsProp.payers || [], per_participant: savedSplitsProp.per_participant || [] } // eslint-disable-line react/prop-types
      : null;
    const src = fromProp || savedSplits; // null → defaults (siembra optimista)
    const seed = buildSeed_(src);
    log.info('[DBG billing] seed', {
      signer8:    guardianPersonId && log.sid(guardianPersonId),
      has_signerCtx: !!signerCtx,
      from:       fromProp ? 'hydration' : (savedSplits ? 'fetch' : 'defaults'),
      has_saved:  !!(src && (src.payers || []).length),
      guardians:  guardians.length,
      applicants: applicants.length,
      payers:     seed.payers.map(p => ({ key: p.key, pid8: log.sid(p.payer_person_id), split: p.split })),
    });
    updateSigningForm('billing', prev => prev || { ...seed, touched: false, seededFromServer: !!src });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guardians.length, applicants.length, guardianPersonId, savedSplits, form]);

  // REVALIDACIÓN SILENCIOSA (VIEWER-UX): cuando la lectura background resuelve con un
  // reparto realmente guardado y el usuario NO tocó nada (siembra default intacta),
  // re-siembra con el dato del server. Si tocó, su valor manda — el server no lo pisa.
  useEffect(() => {
    if (!savedSplits) return;
    const hasSaved = (savedSplits.payers || []).length > 0 || (savedSplits.per_participant || []).length > 0;
    if (!hasSaved) return;
    updateSigningForm('billing', f => {
      if (!f || f.touched || f.seededFromServer) return f; // el usuario (o el server) ya manda
      log.info('[DBG billing] revalidación silenciosa — re-siembra desde server');
      return { ...buildSeed_(savedSplits), touched: false, seededFromServer: true };
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [savedSplits]);

  // Ediciones del usuario → contexto (su valor manda toda la sesión; el server no lo
  // pisa — `touched` sella el slice contra la revalidación background).
  const setPayers     = (next) => updateSigningForm('billing', f => ({ ...(f || { perChild: false, childSplits: {} }), payers: next, touched: true }));
  const setPerChild   = (v)    => updateSigningForm('billing', f => ({ ...(f || { payers: [], childSplits: {} }), perChild: v, touched: true }));
  const setChildSplit = (key, next) => updateSigningForm('billing', f => ({
    ...(f || { payers: [], perChild: true }), childSplits: { ...((f && f.childSplits) || {}), [key]: next }, touched: true,
  }));

  const childKey = (a) => a.person_id || a._uid;
  // Solo ofrecemos "personalizar por hijo" cuando tiene sentido: ≥2 hijos y ≥2 tutores.
  const canPerChild = applicants.length > 1 && guardians.length > 1;

  // VERBATIM — is_primary del reparto = el pagador con mayor %, el primero en empate
  // (el KMS exige exactamente uno por reparto). Solo aplica al payload per-participante.
  const withPrimary = (rows) => {
    const active = rows.filter(r => (Number(r.split) || 0) > 0);
    const list = active.length ? active : rows.slice(0, 1);
    let primaryKey = list[0] && list[0].key, max = -1;
    list.forEach(r => { const s = Number(r.split) || 0; if (s > max) { max = s; primaryKey = r.key; } });
    return list.map(r => ({
      payer_type:       'GUARDIAN',
      payer_person_id:  r.payer_person_id || null,
      split_percentage: Number(r.split) || 0,
      is_primary:       r.key === primaryKey,
    }));
  };

  // VERBATIM — Group-level payload (compat byte a byte con lo desplegado): SOLO
  // payer_person_id + split (sin fiscales — el KMS los deriva de core; sin is_primary
  // — el KMS lo deriva).
  const buildGroupPayload = () => payers
    .filter(p => (Number(p.split) || 0) > 0 || payers.length === 1)
    .map(p => ({
      payer_type:       'GUARDIAN',
      payer_person_id:  p.payer_person_id || null,
      split_percentage: Number(p.split) || 0,
    }));

  // VERBATIM — Per-participante payload: un reparto por hijo (keyed por
  // applicant_person_id; el KMS resuelve enrollment + finSubscription, KAL-4).
  const buildPerParticipantPayload = () => applicants.map(a => ({
    applicant_person_id: childKey(a),
    payers:              withPrimary(childSplits[childKey(a)] || seedPayers()),
  }));

  // VERBATIM — Gate de avance: cada reparto activo suma 100 (±0.5 redondeo) y tiene
  // un primario (algún pagador con % > 0). Suma 100 por construcción — red de seguridad.
  const sumOk = (rows) => Math.abs(rows.reduce((s, r) => s + (Number(r.split) || 0), 0) - 100) <= 0.5;
  const validate = () => {
    if (perChild) {
      for (const a of applicants) {
        const rows = childSplits[childKey(a)] || [];
        if (!rows.length || !sumOk(rows) || !rows.some(r => (Number(r.split) || 0) > 0)) {
          return t('signing.billing.split.err_child', { name: fullNameOf(a) || t('signing.billing.split.child', { n: 1 }) });
        }
      }
      return '';
    }
    return (payers.length && sumOk(payers) && payers.some(r => (Number(r.split) || 0) > 0))
      ? '' : t('signing.billing.split.err_sum');
  };

  // Avance OPTIMISTA uniforme con los pasos 1-7: (1) gate de validación LOCAL;
  // (2) body construido ANTES de encolar (la factory cierra sobre los valores ACTUALES,
  // re-ejecutable por Reintentar); (3) enqueueSave SIN await previo → nube global;
  // (4) avance inmediato (onAdvance). Baseline al contexto tras save OK.
  // KAL-4/KAL-7 intactos: el KMS deriva grupo/signer del token; el payload solo lleva %.
  const submit = () => {
    if (signingLocked) { onAdvance(); return; } // solo lectura: avanza sin guardar
    const v = validate();
    if (v) { setErr(v); return; }
    setErr('');
    // IDENTITY-FROM-LINK: identidad canónica = resume_token + `n` (email_id del enlace);
    // el backend resuelve el firmante server-side. signing_token solo back-compat.
    const body = { ...signingIdentity_({ resumeToken, signingToken, n: recoveryNonce, recoveredEmail }) };
    if (perChild && applicants.length) body.per_participant = buildPerParticipantPayload();
    else body.payers = buildGroupPayload();
    log.info('[DBG billing] submit', {
      mode: (perChild && applicants.length) ? 'per_participant' : 'group',
      payers: body.payers && body.payers.map(p => ({ pid8: log.sid(p.payer_person_id), split: p.split_percentage })),
      per_participant_n: body.per_participant && body.per_participant.length,
    });
    const baselineSnapshot = { payers, perChild, childSplits };
    enqueueSave(() => gasCall('saveBillingInfo', body)
      .then(res => {
        // Baseline tras save OK (espejo de markStepSaved de los pasos 1-7).
        updateSigningForm('billing', f => ({ ...(f || baselineSnapshot), baseline: baselineSnapshot }));
        return res;
      })
      .catch(e => {
        // STEPUP_REQUIRED dentro de la cola: NO se reintenta a ciegas — se propaga y la
        // nube marca 'error' (el gate de step-up vive en los actos que lo exigen, DL-E39).
        if (isStepUpRequiredError(e)) log.warn('Step8Billing: saveBillingInfo requires step-up (queued)');
        else log.error('Step8Billing: saveBillingInfo failed (background)', { message: e.message });
        throw e; // surface vía SaveIndicator ('error' + Reintentar)
      }));
    onAdvance(); // avance optimista inmediato
  };

  return (
    <div className="kis-card">
      <StepShell
        title={t(stepLabelKey('s_billing'))}
        subtitle={t('signing.billing.subtitle')}
        onBack={onBack}
        onNext={submit}
        nextLabel={signingLocked ? undefined : t('signing.billing.submit')}
        error={err}
      >
        {signingLocked && (
          <p style={{ background: '#fff8e1', borderLeft: '4px solid #f0a500', padding: '10px 14px', borderRadius: 4, color: '#5c4400', fontSize: '0.9rem' }}>
            {t('signing.locked_note')}
          </p>
        )}
        <div style={{ marginTop: 8 }}>
          <h3 style={{ color: 'var(--teal-dk)', fontWeight: 700, fontSize: '0.98rem', marginBottom: 4 }}>
            {t('signing.billing.split.title')}
          </h3>
          <p style={{ color: 'var(--muted)', fontSize: '0.84rem', marginBottom: 16 }}>
            {t('signing.billing.split.subtitle')}
          </p>

          {/* CLI 10 — toggle "personalizar por hijo" (solo si ≥2 hijos y ≥2 tutores). */}
          {canPerChild && (
            <div className="form-check form-switch" style={{ marginBottom: 16 }}>
              <input className="form-check-input" type="checkbox" id="perChildToggle"
                checked={perChild} onChange={e => { setPerChild(e.target.checked); setErr(''); }} />
              <label className="form-check-label" htmlFor="perChildToggle" style={{ fontSize: '0.86rem', fontWeight: 600 }}>
                {t('signing.billing.split.per_child_toggle')}
              </label>
              <div style={{ fontSize: '0.78rem', color: 'var(--muted)', marginTop: 2 }}>
                {t('signing.billing.split.per_child_hint')}
              </div>
            </div>
          )}

          {/* Default COLAPSADO: un único reparto para todos los hijos (group-level). */}
          {!perChild && <SplitEditor payers={payers} onChange={setPayers} />}

          {/* Personalizar por hijo: un reparto por participante. */}
          {perChild && applicants.map(a => (
            <div key={childKey(a)} style={{ marginBottom: 18, paddingBottom: 14, borderBottom: '1px solid var(--border)' }}>
              <h4 style={{ color: 'var(--teal-dk)', fontWeight: 700, fontSize: '0.9rem', marginBottom: 10 }}>
                {fullNameOf(a) || t('signing.billing.split.child', { n: 1 })}
              </h4>
              <SplitEditor
                payers={childSplits[childKey(a)] || []}
                onChange={(next) => setChildSplit(childKey(a), next)}
              />
            </div>
          ))}
        </div>
      </StepShell>
    </div>
  );
}
