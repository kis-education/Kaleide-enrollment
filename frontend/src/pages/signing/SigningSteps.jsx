import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { gasCall, initiateSigningRead } from '../../api';
import { useWizard } from '../../context/WizardContext';
import { SIGNING_CONSENTS, SIGNING_CONSENT_TEXT_VERSION } from '../../signingConsentTexts';
import StepUpReverify from '../../components/StepUpReverify';
import StepShell from '../../components/StepShell';
import * as log from '../../logger';

/**
 * DL-E39 — IP forense client-side (best-effort) antes del ACTO de firma.
 * La IP es EVIDENCIA, nunca un gate: si el eco IP externo falla, continuamos sin
 * ella. NO se mete nada en la URL (KAL-7). Se pasa como client_ip en el payload
 * de initiateSigningSession.
 */
async function fetchClientIp() {
  try {
    const res = await fetch('https://api.ipify.org?format=json');
    if (!res.ok) return null;
    const data = await res.json();
    return data && data.ip ? data.ip : null;
  } catch (e) {
    // Best-effort: la IP es evidencia, no gate. Continuamos sin ella.
    log.warn('SignSign: fetchClientIp failed (best-effort, continuando sin IP)', { message: e.message });
    return null;
  }
}

const isStepUpRequiredError = (e) =>
  e?.code === 'STEPUP_REQUIRED' || /STEPUP_REQUIRED/.test(e?.message || '');

/**
 * Componentes funcionales de firma (Steps 8-11) — DL-E38: se renderizan INLINE en
 * el wizard /apply (WizardPage → Step8Billing/Step9Gdpr/Step10Review/Step11Sign →
 * SignBilling/SignGdpr/SignReview/SignSign). La ruta /sign y su host SigningWizardPage
 * fueron eliminados. Reciben `signingToken` + `signerCtx` (resueltos server-side por
 * resolveSigningToken al entrar a firma, KAL-7: el token NUNCA va en la URL). Cada
 * submit pasa `signing_token` al gasCall (auth canónica — requireSigningToken_ backend, CLI 45).
 *
 * Secuencia: billing → gdpr → review → sign. El sub-step inicial se deriva de
 * signerCtx.steps (billing_confirmed / gdpr_completed / review_completed / signed).
 */

export const SUBS = ['billing', 'gdpr', 'review', 'sign'];

/**
 * IDENTITY-FROM-LINK (Diego 2026-06-11) — identidad canónica del ACTO de firma. El backend
 * (requireSignerContext_) acepta DOS formas y prefiere (a): { resume_token } → grupo
 * (KAL-4) + guardian resuelto SERVER-SIDE del PROPIO ENLACE: `n` (email_id del enlace) →
 * email → guardian, validado contra el grupo del token. El { signing_token } es back-compat.
 *
 * Construimos el sub-objeto de identidad a fusionar en el payload de cada acto:
 *   - resume_token de SESIÓN (sobrevive a F5/incógnito; el firmante lo resuelve el servidor).
 *   - `n` (email_id del enlace) cuando lo tenemos → es la VÍA CANÓNICA de identidad: la
 *     identidad viaja en el enlace, no en el cliente (Diego: "resolver la identidad sabiendo
 *     el email con el que se solicita el link"). El backend lo valida contra BD (KAL-4/5).
 *   - recovered_email como COMPAT secundario (sessionStorage), si está.
 *   - si no hay resume_token, caemos al signing_token legacy.
 * NUNCA mandamos un guardian/grupo del cliente — el backend deriva la identidad del token+n.
 */
export function signingIdentity_({ resumeToken, signingToken, n, recoveredEmail }) {
  if (resumeToken) {
    const out = { resume_token: resumeToken };
    if (n) out.n = n;                                  // identidad del enlace (email_id)
    if (recoveredEmail) out.recovered_email = recoveredEmail; // compat secundario
    return out;
  }
  if (signingToken) return { signing_token: signingToken };
  return {};
}

export function lang_(i18n) { return i18n.language && i18n.language.indexOf('en') === 0 ? 'en' : 'es'; }

/**
 * DL-E38 merge — initial sub-step derived from signerCtx.steps. Shared by the
 * /sign orchestrator (SigningSteps) and the inline wizard merge (WizardPage):
 * a family who already did billing lands on GDPR, etc. Returns 0..3.
 */
export function initialSubStep(steps) {
  const s = steps || {};
  return !s.billing_confirmed ? 0
       : !s.gdpr_completed   ? 1
       : !s.review_completed ? 2
       : 3;
}

// ─── Progress bar ───────────────────────────────────────────────────────────

export function Progress({ current }) {
  const { t } = useTranslation();
  const labels = [
    t('signing.step_billing'), t('signing.step_gdpr'),
    t('signing.step_review'), t('signing.step_sign'),
  ];
  return (
    <div style={{ display: 'flex', gap: 6, marginBottom: 24 }}>
      {labels.map((lbl, i) => (
        <div key={i} style={{ flex: 1, textAlign: 'center' }}>
          <div style={{
            height: 4, borderRadius: 4,
            background: i <= current ? 'var(--teal-dk)' : 'var(--border)',
            marginBottom: 6,
          }} />
          <span style={{ fontSize: '0.72rem', color: i === current ? 'var(--teal-dk)' : 'var(--muted)', fontWeight: i === current ? 700 : 400 }}>
            {lbl}
          </span>
        </div>
      ))}
    </div>
  );
}

// ─── (Histórico) Signing-step nav — ELIMINADO por STEP-FRAMEWORK (Diego 2026-06-11) ──
// El `SigningNav` era el SEGUNDO chasis: una barra de navegación propia de los pasos
// 8-10 con su spinner "Guardando…" DENTRO del botón (guardado NO optimista, sin la
// nube global, tratado distinto de los pasos 1-7). Diego: "Aunque sea la misma ruta,
// se tratan de forma diferenciada. Tienes que unificar." Los pasos 8-10 usan AHORA el
// chasis único `StepShell` (StepNav estándar + nube SaveIndicator global), idéntico a
// los pasos 1-7. El guardado sigue siendo optimista vía la MISMA cola FIFO
// (setPendingSave → enqueueSave); el indicador de guardado es la nube global, no un
// spinner per-botón. El paso 11 (SignSign) conserva su back-nav propia: su "avance" es
// el ACTO terminal de firma (frontera Click & Sign), no un "Continuar" de paso.

// ─── Editor de UN reparto (1 / 2 / N pagadores) ───────────────────────────────
// Slider+presets (2 pagadores) o inputs con rebalanceo proporcional (>2) → la suma es
// 100 POR CONSTRUCCIÓN. Reutilizado por el caso group-level (default colapsado) y por
// cada hijo en modo per-participante (CLI 10). `payers`=[{ key, payer_person_id, name,
// split }]. Controlado: recibe `payers` + `onChange(nextPayers)`.
export function SplitEditor({ payers, onChange }) {
  const { t } = useTranslation();
  const two = payers.length === 2;
  const sliderA = two ? (Number(payers[0].split) || 0) : 0;
  const totalSplit = payers.reduce((s, p) => s + (Number(p.split) || 0), 0);

  // 2 pagadores: un slider reparte entre ambos (p0=a, p1=100-a → suma 100 exacta).
  const setSliderValue = (v) => {
    const a = Math.max(0, Math.min(100, Math.round(Number(v) || 0)));
    onChange(payers.length === 2
      ? [{ ...payers[0], split: a }, { ...payers[1], split: 100 - a }]
      : payers);
  };

  // >2 pagadores: input por pagador con REBALANCEO proporcional del resto → la suma se
  // mantiene exactamente 100 (el drift de redondeo se corrige en el último "otro").
  const setSplitRebalanced = (key) => (e) => {
    const v = Math.max(0, Math.min(100, Math.round(Number(e.target.value) || 0)));
    const others = payers.filter(p => p.key !== key);
    const otherSum = others.reduce((s, p) => s + (Number(p.split) || 0), 0);
    const remain = 100 - v;
    let acc = 0;
    const next = payers.map(p => {
      if (p.key === key) return { ...p, split: v };
      const share = others.length === 0 ? 0
        : (otherSum > 0 ? Math.round((Number(p.split) || 0) / otherSum * remain)
                        : Math.round(remain / others.length));
      acc += share;
      return { ...p, split: share };
    });
    const drift = 100 - (v + acc);
    if (drift !== 0) {
      for (let i = next.length - 1; i >= 0; i--) {
        if (next[i].key !== key) { next[i] = { ...next[i], split: Math.max(0, next[i].split + drift) }; break; }
      }
    }
    onChange(next);
  };

  const presetBtn = (label, a) => (
    <button type="button" className="btn btn-outline-secondary btn-sm" style={{ fontWeight: 600 }}
      onClick={() => setSliderValue(a)}>{label}</button>
  );

  // 1 pagador: no hay reparto que ajustar (100%).
  if (payers.length === 1) {
    return (
      <div style={{ padding: '12px 14px', background: 'var(--bg)', borderRadius: 8, display: 'flex', justifyContent: 'space-between', fontWeight: 600 }}>
        <span>{payers[0].name}</span><span>100%</span>
      </div>
    );
  }
  // 2 pagadores: slider + presets, auto-balanceado a 100%.
  if (two) {
    return (
      <div>
        <div style={{ display: 'flex', gap: 8, marginBottom: 14 }}>
          {presetBtn('100 / 0', 100)}
          {presetBtn('50 / 50', 50)}
          {presetBtn('0 / 100', 0)}
        </div>
        <div style={{ display: 'flex', justifyContent: 'space-between', fontWeight: 700, fontSize: '0.9rem', marginBottom: 6 }}>
          <span>{payers[0].name}: {sliderA}%</span>
          <span>{payers[1].name}: {100 - sliderA}%</span>
        </div>
        <input type="range" min="0" max="100" step="1" value={sliderA}
          onChange={e => setSliderValue(e.target.value)} style={{ width: '100%' }}
          aria-label={t('signing.billing.split.title')} />
      </div>
    );
  }
  // >2 pagadores: inputs con rebalanceo (suma 100 por construcción).
  return (
    <div>
      {payers.map(p => (
        <div key={p.key} style={{ marginBottom: 12, padding: '10px 12px', background: 'var(--bg)', borderRadius: 8 }}>
          <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
            <span style={{ flex: 1, fontWeight: 600, fontSize: '0.88rem' }}>{p.name}</span>
            <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: 110 }}>
              <input type="number" min="0" max="100" className="form-control"
                style={{ width: 72, textAlign: 'right' }} value={p.split}
                onChange={setSplitRebalanced(p.key)} />
              <span style={{ fontWeight: 600, color: 'var(--muted)' }}>%</span>
            </div>
          </div>
        </div>
      ))}
      <div style={{ marginTop: 4, display: 'flex', justifyContent: 'space-between', fontSize: '0.88rem', fontWeight: 700, color: '#1b5e20' }}>
        <span>{t('signing.billing.split.total')}</span>
        <span>{totalSplit}%</span>
      </div>
    </div>
  );
}

// ─── Step 8 — Reparto del pago (billing rediseño 2026-06-08 + CLI 10 per-participante) ─
// El formulario fiscal se eliminó: los datos fiscales viven en el registro core del
// pagador y el KMS los deriva por payer_person_id. Este paso muestra SOLO el reparto.
// CLI 10 (DL-E42 §3/§5): el reparto es per-PARTICIPANTE (un reparto por hijo), solo %.
//   · Default COLAPSADO = un único reparto para TODOS los hijos (= lo de hoy, group-level
//     → payload `payers[]`, compat byte a byte).
//   · "Personalizar por hijo" expande a N repartos, cada uno solo % entre tutores, suma
//     100, un primario → payload `per_participant:[{ applicant_person_id, payers[] }]`.
// El KMS deriva grupo+enrollments del token (KAL-4) y mapea cada hijo → su finSubscription.
export function SignBilling({ signingToken, resumeToken, signerCtx, savedSplits: savedSplitsProp, onDone, onBack }) {
  const { t } = useTranslation();
  const { stepData, enqueueSave, recoveredEmail, recoveryNonce } = useWizard();
  // Default payer = signing guardian (DL-E38: identity derived server-side from the
  // signing_token; client only echoes guardian_person_id for the KMS to disambiguate
  // which guardian pays in a multi-guardian family). KAL-4 stays intact — the KMS
  // re-derives enrollment_group_id + signer from the token, never from this payload.
  const guardianPersonId = signerCtx && signerCtx.guardian_person_id;
  const persons = (stepData && stepData.persons) || [];
  const guardians  = persons.filter(p => p.person_type_id === 'guardian');
  const applicants = persons.filter(p => p.person_type_id === 'applicant');

  const fullNameOf = (g) => [g.first_name, g.middle_name, g.last_name]
    .filter(x => x && String(x).trim()).join(' ').trim();

  // WPERF-4 (bug 1): rehidrata desde el reparto GUARDADO si existe (savedList =
  // [{payer_person_id, split_percentage}] de enr.getSavedBillingSplits). Si no hay
  // guardado, cae al default firmante 100% / resto 0%. Fallback (/sign sin stepData):
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

  const [payers, setPayers]         = useState([]);    // group-level (default colapsado)
  const [perChild, setPerChild]     = useState(false); // CLI 10: "personalizar por hijo"
  const [childSplits, setChildSplits] = useState({});  // applicant_person_id → payers[]
  const [err, setErr] = useState('');
  // WPERF-4 (bug 1): reparto YA GUARDADO (null = aún cargando; {payers,per_participant}).
  const [savedSplits, setSavedSplits] = useState(null);

  // DL-B §1: el reparto guardado YA viene en la hidratación consolidada (savedSplitsProp,
  // del store WizardContext.billingSplits). Si está presente lo usamos directamente y NO
  // hacemos la lectura getSavedBillingSplits por-entrada (elimina un round-trip por entrada
  // al Step 8). Solo caemos al fetch si el prop no llegó (p.ej. entrada sin hidratación
  // consolidada previa). WPERF-4 (bug 1): rehidratar 50/50 en vez de volver a 100/0.
  useEffect(() => {
    let alive = true;
    if (savedSplitsProp && typeof savedSplitsProp === 'object') {
      setSavedSplits({
        payers:          savedSplitsProp.payers || [],
        per_participant: savedSplitsProp.per_participant || [],
      });
      return undefined;
    }
    // IDENTITY-COMPLETION (#30): identidad de SESIÓN (resume_token preferente; el backend
    // resuelve el firmante server-side vía requireSignerContext_ + binding @157). El
    // signing_token queda como compat. Si no hay NINGUNA identidad → reparto vacío.
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

  // Seed group-level + per-hijo una sola vez, ESPERANDO a la lectura del reparto
  // guardado (savedSplits !== null) para rehidratar 50/50 si lo había (WPERF-4 bug 1).
  useEffect(() => {
    if (payers.length || savedSplits === null) return;
    const seeded = seedPayers(savedSplits.payers);
    log.info('[DBG billing] seed', {
      signer8:    guardianPersonId && log.sid(guardianPersonId),
      has_signerCtx: !!signerCtx,
      has_saved:  (savedSplits.payers || []).length > 0,
      guardians:  guardians.length,
      applicants: applicants.length,
      payers:     seeded.map(p => ({ key: p.key, pid8: log.sid(p.payer_person_id), split: p.split })),
    });
    setPayers(seeded);
    if (applicants.length) {
      const perChildSaved = {};
      (savedSplits.per_participant || []).forEach(pp => {
        if (pp && pp.applicant_person_id) perChildSaved[String(pp.applicant_person_id)] = pp.payers;
      });
      const map = {};
      applicants.forEach(a => { const k = a.person_id || a._uid; map[k] = seedPayers(perChildSaved[String(k)]); });
      setChildSplits(map);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guardians.length, applicants.length, guardianPersonId, savedSplits]);

  const childKey = (a) => a.person_id || a._uid;
  // Solo ofrecemos "personalizar por hijo" cuando tiene sentido: ≥2 hijos y ≥2 tutores
  // (con 1 hijo el per-hijo es idéntico al group-level; con 1 tutor no hay reparto).
  const canPerChild = applicants.length > 1 && guardians.length > 1;

  // is_primary del reparto = el pagador con mayor %, el primero en empate (el KMS exige
  // exactamente uno por reparto). Solo aplica al payload per-participante.
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

  // Group-level payload (compat byte a byte con lo desplegado): SOLO payer_person_id +
  // split (sin fiscales — el KMS los deriva de core; sin is_primary — el KMS lo deriva).
  const buildGroupPayload = () => payers
    .filter(p => (Number(p.split) || 0) > 0 || payers.length === 1)
    .map(p => ({
      payer_type:       'GUARDIAN',
      payer_person_id:  p.payer_person_id || null,
      split_percentage: Number(p.split) || 0,
    }));

  // Per-participante payload: un reparto por hijo (keyed por applicant_person_id; el KMS
  // resuelve el enrollment + la finSubscription server-side, KAL-4) con su is_primary.
  const buildPerParticipantPayload = () => applicants.map(a => ({
    applicant_person_id: childKey(a),
    payers:              withPrimary(childSplits[childKey(a)] || seedPayers()),
  }));

  // Gate de avance: cada reparto activo suma 100 (±0.5 redondeo) y tiene un primario
  // (algún pagador con % > 0). Suma 100 por construcción — esto es red de seguridad.
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

  // WIZARD — avance optimista REAL (paso 8, BILLING-EDIT causa 3 2026-06-11). (1) gate
  // de validación LOCAL; (2) encolar saveBillingInfo como FACTORY (enqueueSave encadena
  // la EJECUCIÓN en FIFO tras el save anterior — WizardContext); (3) avance inmediato
  // (onDone). YA NO hay `await awaitPendingSave()` previo: con actos de 53-62s ese await
  // bloqueaba cada "Siguiente" hasta drenar el acto anterior. Un fallo del acto anterior
  // se surfacea por la nube global (saveState 'error' + Reintentar re-encola SU factory,
  // WPERF-1), no bloqueando este submit. KAL-4/KAL-7 intactos: el KMS deriva
  // grupo/signer del token; el payload solo lleva % (group-level o per-hijo).
  const submit = () => {
    const v = validate();
    if (v) { setErr(v); return; }
    setErr('');
    // Default (colapsado) → payers[] group-level; "personalizar por hijo" → per_participant.
    // IDENTITY-FROM-LINK: identidad canónica = resume_token + `n` (email_id del enlace); el
    // backend resuelve el firmante server-side. signing_token solo back-compat. KAL-4 intacta.
    // El body se construye ANTES de encolar: la factory cierra sobre los valores ACTUALES
    // del form (no sobre estado mutable) y es re-ejecutable (botón Reintentar).
    const body = { ...signingIdentity_({ resumeToken, signingToken, n: recoveryNonce, recoveredEmail }) };
    if (perChild && applicants.length) body.per_participant = buildPerParticipantPayload();
    else body.payers = buildGroupPayload();
    log.info('[DBG billing] submit', {
      mode: (perChild && applicants.length) ? 'per_participant' : 'group',
      payers: body.payers && body.payers.map(p => ({ pid8: log.sid(p.payer_person_id), split: p.split_percentage })),
      per_participant_n: body.per_participant && body.per_participant.length,
    });
    enqueueSave(() => gasCall('saveBillingInfo', body).catch(e => {
      // STEPUP_REQUIRED dentro de la cola: NO se reintenta a ciegas — se propaga y la
      // nube marca 'error' (el gate de step-up vive en los actos que lo exigen, DL-E39).
      if (isStepUpRequiredError(e)) log.warn('SignBilling: saveBillingInfo requires step-up (queued)');
      else log.error('SignBilling: saveBillingInfo failed (background)', { message: e.message });
      throw e; // surface vía SaveIndicator ('error' + Reintentar)
    }));
    onDone(); // avance optimista inmediato
  };

  // STEP-FRAMEWORK: este acto es un PASO IDÉNTICO a los 1-7 — usa el chasis StepShell
  // (StepNav estándar arriba/abajo + nube global). El guardado es OPTIMISTA: `submit`
  // encola el save en la MISMA cola FIFO (enqueueSave) → la MISMA nube SaveIndicator;
  // el botón NUNCA muestra "Guardando…" ni se bloquea. El error inline lo pinta StepShell.
  return (
    <div className="kis-card">
      <StepShell
        title={t('signing.billing.title')}
        subtitle={t('signing.billing.subtitle')}
        onBack={onBack}
        onNext={submit}
        nextLabel={t('signing.billing.submit')}
        error={err}
      >
      {/* ── Reparto entre pagadores ──────────────────────────────────────────── */}
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
              onChange={(next) => setChildSplits(prev => ({ ...prev, [childKey(a)]: next }))}
            />
          </div>
        ))}
      </div>
      </StepShell>
    </div>
  );
}

// ─── Step 9 — GDPR (modo conservador GATE-B: UN set, sin fan-out per-guardian) ─

export function SignGdpr({ signingToken, resumeToken, signerCtx, lang, onDone, onBack }) {
  const { t } = useTranslation();
  const { enqueueSave, stepData, recoveredEmail, recoveryNonce } = useWizard();

  // CLI 9 (DL-E42 §3): matriz tutor×sujeto. El guardian actual (derivado del token,
  // signerCtx.guardian_person_id) consiente:
  //  - GENERAL (GDPR_SCHOOL blocking + comms + platform groups): per-guardian, sujeto = él mismo.
  //  - DERECHOS DE IMAGEN (4 usos): por CADA sujeto ∈ {participantes del grupo} ∪ {él mismo}.
  //    Como representante legal consiente por cada niño; y sus PROPIOS derechos de imagen.
  //    NUNCA por el otro tutor adulto (no aparece como sujeto). El otorgante NO viaja en
  //    el payload — el KMS lo deriva del signing_token (KAL-4).
  const fullName_ = (p) => [p.first_name, p.middle_name, p.last_name].filter(x => x && String(x).trim()).join(' ').trim();
  const persons = (stepData && stepData.persons) || [];
  const guardianPersonId = signerCtx?.guardian_person_id || null;
  const applicants = persons.filter(p => p.person_type_id === 'applicant');
  const selfGuardian = persons.find(p => (p.person_id || p._uid) === guardianPersonId) || null;
  // Sujetos de la matriz de imagen: niños del grupo + el propio tutor firmante.
  const imageSubjects = [
    ...applicants.map(a => ({
      id: a.person_id || a._uid, table: 'enrPersons',
      name: fullName_(a) || t('signing.gdpr.subject_child', { n: applicants.indexOf(a) + 1 }), kind: 'child',
    })).filter(s => s.id),
    ...(guardianPersonId ? [{
      id: guardianPersonId, table: 'enrPersons',
      name: (selfGuardian && fullName_(selfGuardian)) ? t('signing.gdpr.subject_self_named', { name: fullName_(selfGuardian) }) : t('signing.gdpr.subject_self'),
      kind: 'self',
    }] : []),
  ];
  const generalConsents = SIGNING_CONSENTS.filter(c => !c.consent_use);
  const imageConsents   = SIGNING_CONSENTS.filter(c => c.consent_use);
  // CLI 3 — los consentimientos marcados se PERSISTEN keyed por sesión de firma para que
  // sobrevivan a navegar atrás/adelante (9↔8). Antes el estado vivía solo en useState y se
  // perdía al desmontar SignGdpr en el back → al volver aparecía todo desmarcado. Mismo
  // patrón que el `navKey` del sub-step. KAL-7: NO se guarda ningún secreto (ni el
  // signing_token) — solo los booleans de consentimiento + la versión de texto, de modo que
  // si el texto legal cambia (SIGNING_CONSENT_TEXT_VERSION) se descarta lo guardado y se
  // re-consiente. Marcar NO envía nada (eso es submit/onDone); solo conserva las marcas.
  // Estado: genState[code] (generales) + imgState[subjectId][code] (matriz de imagen).
  // Persistido keyed por sesión (sobrevive 9↔8); se descarta si cambia la versión legal.
  const gdprKey = 'signGdpr_' + (signerCtx?.session_id || signerCtx?.signer_id || 'x');
  const buildInit = () => {
    const gen = {}; generalConsents.forEach(c => { gen[c.code] = false; });
    const img = {}; imageSubjects.forEach(s => { img[s.id] = {}; imageConsents.forEach(c => { img[s.id][c.code] = false; }); });
    try {
      const raw = sessionStorage.getItem(gdprKey);
      if (raw) {
        const saved = JSON.parse(raw);
        if (saved && saved.v === SIGNING_CONSENT_TEXT_VERSION) {
          if (saved.gen) generalConsents.forEach(c => { if (typeof saved.gen[c.code] === 'boolean') gen[c.code] = saved.gen[c.code]; });
          if (saved.img) imageSubjects.forEach(s => { if (saved.img[s.id]) imageConsents.forEach(c => { if (typeof saved.img[s.id][c.code] === 'boolean') img[s.id][c.code] = saved.img[s.id][c.code]; }); });
        }
      }
    } catch (e) { /* non-fatal — defaults */ }
    return { gen, img };
  };
  const [genState, setGenState] = useState(() => buildInit().gen);
  const [imgState, setImgState] = useState(() => buildInit().img);
  const persistConsents = (gen, img) => {
    try { sessionStorage.setItem(gdprKey, JSON.stringify({ v: SIGNING_CONSENT_TEXT_VERSION, gen, img })); }
    catch (e) { /* non-fatal */ }
  };
  const [err, setErr] = useState('');
  // DBG-SESSION (bug 5): si signerCtx es null en el 1er mount, gdprKey = 'signGdpr_x'
  // → la restauración de sessionStorage no casa con la key real (signGdpr_<session>)
  // y los consentimientos no se cargan al entrar (sí al re-entrar, ya con signerCtx).
  useEffect(() => {
    const countTrue = (o) => Object.values(o || {}).filter(Boolean).length;
    log.info('[DBG gdpr] mount', {
      gdprKey,
      has_signerCtx: !!signerCtx,
      session8: signerCtx && log.sid(signerCtx.session_id),
      signer8:  signerCtx && log.sid(signerCtx.signer_id),
      n_imageSubjects:   imageSubjects.length,
      restored_gen_true: countTrue(genState),
      restored_img_true: Object.values(imgState || {}).reduce((n, o) => n + countTrue(o), 0),
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);
  const toggleGen = (code) => {
    const next = { ...genState, [code]: !genState[code] };
    persistConsents(next, imgState); setGenState(next);
  };
  const toggleImg = (subjectId, code) => {
    const next = { ...imgState, [subjectId]: { ...(imgState[subjectId] || {}), [code]: !(imgState[subjectId] && imgState[subjectId][code]) } };
    persistConsents(genState, next); setImgState(next);
  };

  // WIZARD — avance optimista REAL (paso 9, BILLING-EDIT causa 3 2026-06-11). Mirror
  // del patrón /apply: (1) gate de validación LOCAL (consentimiento bloqueante);
  // (2) encolar submitGdprConsents como FACTORY (enqueueSave encadena la EJECUCIÓN en
  // FIFO tras el save de BILLING — sin `await awaitPendingSave()` previo que bloqueaba
  // este "Siguiente" 53-62s); (3) avanzar de inmediato. Un fallo de billing o de este
  // acto se surfacea por la nube global ('error' + Reintentar re-encola la factory).
  const submit = () => {
    const gdprSchool = generalConsents.find(c => c.blocking);
    if (gdprSchool && genState[gdprSchool.code] !== true) {
      setErr(t('signing.gdpr.must_accept_blocking'));
      return;
    }
    setErr('');
    const common = {
      consent_text_version: SIGNING_CONSENT_TEXT_VERSION,
      language:             lang,
      signed_method:        'WEB_CLICK',
      user_agent:           navigator.userAgent,
    };
    // CLI 9: el otorgante NO viaja (server-side del token). Sujeto SÍ:
    //  - generales → sujeto = el propio guardian firmante (sus datos/comms);
    //  - imagen → una fila por (sujeto, uso). El KMS valida que el sujeto ∈
    //    {participantes del grupo} ∪ {firmante}.
    const consents = [];
    generalConsents.forEach(c => consents.push({
      consent_type_code:    c.code,
      consent_use:          c.consent_use || null,
      consented:            genState[c.code] === true,
      consent_text_shown:   c.text[lang],
      subject_person_id:    guardianPersonId || null,
      subject_person_table: guardianPersonId ? 'enrPersons' : null,
      ...common,
    }));
    imageSubjects.forEach(s => imageConsents.forEach(c => consents.push({
      consent_type_code:    c.code,
      consent_use:          c.consent_use || null,
      consented:            !!(imgState[s.id] && imgState[s.id][c.code]),
      consent_text_shown:   c.text[lang],
      subject_person_id:    s.id,
      subject_person_table: s.table,
      ...common,
    })));
    log.info('[DBG gdpr] submit', {
      consents_n: consents.length,
      gen_true:   generalConsents.filter(c => genState[c.code] === true).length,
      img_true:   imageSubjects.reduce((n, s) => n + imageConsents.filter(c => !!(imgState[s.id] && imgState[s.id][c.code])).length, 0),
    });
    // Factory encolada (BILLING-EDIT causa 3). `res.blocked` (rechazo de consentimiento
    // bloqueante server-side) se convierte en rechazo de la promesa → misma vía de
    // surfacing (nube 'error' + Reintentar). El payload se construye ANTES de encolar
    // (cierra sobre las marcas actuales, re-ejecutable). KAL-4/KAL-7 + payload intactos.
    const payload = { ...signingIdentity_({ resumeToken, signingToken, n: recoveryNonce, recoveredEmail }), consents };
    enqueueSave(() => gasCall('submitGdprConsents', payload)
      .then(res => {
        if (res && res.blocked) {
          const blockErr = new Error('GDPR_BLOCKED');
          blockErr.gdprBlocked = true;
          throw blockErr;
        }
        return res;
      })
      .catch(e => {
        // STEPUP_REQUIRED dentro de la cola: no se reintenta a ciegas — propaga a la nube.
        if (isStepUpRequiredError(e)) log.warn('SignGdpr: submitGdprConsents requires step-up (queued)');
        else log.error('SignGdpr: submitGdprConsents failed (background)', { message: e.message });
        throw e;
      }));
    onDone(); // avance optimista inmediato
  };

  // STEP-FRAMEWORK: paso idéntico a los 1-7 vía StepShell — guardado optimista (la
  // MISMA cola/nube global), nav estándar, error inline. El consentimiento bloqueante
  // (RGPD) es la gate de validación dentro de `submit`.
  return (
    <div className="kis-card">
      <StepShell
        title={t('signing.gdpr.title')}
        subtitle={t('signing.gdpr.subtitle')}
        onBack={onBack}
        onNext={submit}
        nextLabel={t('signing.gdpr.submit')}
        error={err}
      >
      {/* Consentimientos GENERALES (per-guardian: GDPR + comms + plataforma) */}
      {generalConsents.map(c => (
        <div key={c.code} className="consent-block" style={{ borderBottom: '1px solid var(--bg)', paddingBottom: 12, marginBottom: 12 }}>
          <p style={{ fontSize: '0.86rem', color: 'var(--text)', marginBottom: 8 }}>{c.text[lang]}</p>
          <div className="form-check">
            <input type="checkbox" className="form-check-input" id={'consent_' + c.code}
              checked={genState[c.code]} onChange={() => toggleGen(c.code)} />
            <label className="form-check-label fw-semibold" htmlFor={'consent_' + c.code} style={{ fontSize: '0.85rem' }}>
              {c.label[lang]}{c.blocking && <span style={{ color: '#c0392b' }}> *</span>}
            </label>
          </div>
        </div>
      ))}

      {/* DERECHOS DE IMAGEN — matriz tutor×sujeto: un bloque por sujeto (cada niño + el
          propio tutor). El guardian consiente por cada hijo (representante legal) y sus
          propios derechos; NO aparece el otro tutor adulto como sujeto. */}
      {imageConsents.length > 0 && imageSubjects.length > 0 && (
        <div style={{ marginTop: 8 }}>
          <h3 style={{ color: 'var(--teal-dk)', fontWeight: 700, fontSize: '1rem', marginBottom: 4 }}>{t('signing.gdpr.image_rights_heading')}</h3>
          <p style={{ color: 'var(--muted)', fontSize: '0.84rem', marginBottom: 12 }}>{t('signing.gdpr.image_rights_subtitle')}</p>
          {imageSubjects.map(s => (
            <div key={s.id} className="border rounded p-2 mb-3" style={{ background: 'var(--bg)' }}>
              <div style={{ fontWeight: 700, fontSize: '0.9rem', marginBottom: 8, color: 'var(--teal-dk)' }}>
                <i className={`bi ${s.kind === 'self' ? 'bi-person-badge' : 'bi-person'} me-1`} />{s.name}
              </div>
              {imageConsents.map(c => (
                <div key={s.id + '_' + c.code} className="form-check" style={{ marginBottom: 6 }}>
                  <input type="checkbox" className="form-check-input" id={'img_' + s.id + '_' + c.code}
                    checked={!!(imgState[s.id] && imgState[s.id][c.code])} onChange={() => toggleImg(s.id, c.code)} />
                  <label className="form-check-label" htmlFor={'img_' + s.id + '_' + c.code} style={{ fontSize: '0.84rem' }}>
                    {c.label[lang]}
                  </label>
                </div>
              ))}
            </div>
          ))}
        </div>
      )}
      </StepShell>
    </div>
  );
}

// ─── Step 10 — Review (paquete contractual + confirmación lectura) ────────────

export function SignReview({ signingToken, resumeToken, onDone, onBack }) {
  const { t } = useTranslation();
  const {
    isStepUpFresh, markStepUpFresh, enqueueSave,
    recoveredEmail, recoveryNonce,
    // STEP10-VIEWER (Diego 2026-06-11): el cache de documentos vive en el CONTEXTO
    // (object URLs + sha256 keyed por file_id) — navegar 10→11→10 NO refetchea.
    docCache, loadDocument, signingMembers, setSigningMembers,
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
  // STEP-FRAMEWORK (Diego 2026-06-11): muere el anti-patrón "Paquete en preparación.
  // Vuelve en unos minutos." (cita: "No le puedo decir a un cliente del s.XXI que
  // vuelva en unos minutos"). Cuando initiateSigningRead devuelve members vacíos (el
  // KMS aún está generando la Carta/Contrato), NO mostramos un muro muerto: hacemos
  // ESPERA ACTIVA con reintento automático (poll corto) y PROGRESO visible. `attempt`
  // cuenta los reintentos para el feedback; el poll re-dispara el efecto vía reloadKey.
  const [attempt, setAttempt] = useState(0);
  const POLL_MS = 6000;        // reintento corto mientras el paquete se prepara
  // STEP10-VIEWER (cita Diego: "La navegación no obstante debería ser de aceptación de
  // documentos uno a uno. Presentarlo en un visor más amplio y pudiendo pasar de uno a
  // otro documento"): UN documento a la vez + aceptación explícita por documento.
  const [idx, setIdx] = useState(0);            // documento visible (0-based)
  const [accepted, setAccepted] = useState({}); // { [file_id]: true } — aceptación por doc

  useEffect(() => {
    if (needStepUp) return undefined;
    let alive = true;
    let retryTimer = null;
    // P-REVIEW-READONLY: Step 10 solo LEE los docs/members → create_only (NO despacha
    // el envelope). El dispatch real del acto de firma vive SOLO en Step 11 (SignSign).
    // Data-layer pieza 5: single-flight (de-dupe la tormenta de create_only concurrentes).
    const _t0 = Date.now();                          // DBG-SESSION timing (bug 7)
    log.info('[DBG review] initiateSigningRead start', { attempt });
    // IDENTITY-COMPLETION (#30): identidad de SESIÓN (resume_token + `n` del enlace).
    initiateSigningRead({ resumeToken, signingToken, n: recoveryNonce, recoveredEmail })
      .then(res => {
        const ms = Date.now() - _t0;
        const mem = Array.isArray(res.members) ? res.members : [];
        log.info('[DBG review] members', { ms, n: mem.length, attempt, files8: mem.map(m => log.sid(m.file_id)), states: mem.map(m => m.purpose_code || '?') });
        if (!alive) return;
        if (mem.length === 0) {
          // STEP10-VIEWER: si ya teníamos members (sembrados del cache del contexto),
          // un read vacío transitorio NO los pisa ni re-arranca la espera activa.
          if (Array.isArray(members) && members.length) return;
          // STEP-FRAMEWORK: paquete aún no listo → ESPERA ACTIVA. Re-pollea solo
          // (sin pedir al cliente "vuelve en unos minutos"); el render muestra el
          // progreso. members se mantiene en null (estado "preparando…", no "vacío").
          log.info('[DBG review] paquete no listo — reintento automático', { in_ms: POLL_MS, next_attempt: attempt + 1 });
          retryTimer = setTimeout(() => { if (alive) setAttempt(a => a + 1); }, POLL_MS);
          return;
        }
        setMembers(mem);
        setSigningMembers(mem); // STEP10-VIEWER: cache del contexto (re-entrada instantánea)
      })
      .catch(e => {
        if (isStepUpRequiredError(e)) {
          log.warn('SignReview: initiateSigningSession requires step-up');
          if (alive) setNeedStepUp(true);
          return;
        }
        // STEP-FRAMEWORK: un fallo de RED tampoco manda al cliente a "vuelve en unos
        // minutos" — reintento automático con el mismo poll (espera activa). El error
        // duro solo se muestra si persiste tras varios intentos (loadErr).
        log.warn('SignReview: initiateSigningRead failed — reintento automático', { attempt, message: e && e.message });
        if (!alive) return;
        // STEP10-VIEWER: con members ya sembrados del cache, el refresh fallido no
        // degrada la pantalla (seguimos mostrando el paquete cacheado).
        if (Array.isArray(members) && members.length) return;
        if (attempt >= 8) { setLoadErr(e.message || t('signing.generic_error')); return; }
        retryTimer = setTimeout(() => { if (alive) setAttempt(a => a + 1); }, POLL_MS);
      });
    return () => { alive = false; if (retryTimer) clearTimeout(retryTimer); };
  }, [signingToken, resumeToken, recoveryNonce, recoveredEmail, needStepUp, reloadKey, attempt]); // eslint-disable-line

  // STEP10-VIEWER (blob-only): resuelve los bytes de cada documento vía el cache del
  // CONTEXTO (loadDocument → object URL + sha256 keyed por file_id). Cache-hit → CERO
  // red y CERO '[DBG review] getDocument start' repetido (10→11→10 instantáneo). La
  // rama de URLs de visor de Drive (WPERF-4) se ELIMINÓ — el KMS ya no emite ese campo (DOC-BYTES);
  // el visor usa SIEMPRE object URLs de PDF (CSP frame-src blob: ya lo permite). NO se
  // revoca nada al desmontar el step: la revocación vive en WizardContext (clearSession
  // / desmontaje del wizard), nunca al salir del paso.
  useEffect(() => {
    if (!members || !members.length) return undefined;
    let alive = true;
    members.forEach(m => {
      if (!m.file_id || docCache[m.file_id]) return; // ya en cache → no refetch
      const _t0 = Date.now();                        // DBG-SESSION timing por doc (bug 7)
      log.info('[DBG review] getDocument start', { file8: log.sid(m.file_id) });
      // IDENTITY-COMPLETION (#30): identidad de SESIÓN. getDocument_ acepta resume_token + `n`
      // (resuelve el signing_token server-side del enlace para el proxy KMS de los PDF de
      // firma) o signing_token (compat). Preferimos resume_token (sobrevive a F5/incógnito).
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
          log.error('SignReview: getDocument failed', { file_id: m.file_id, message: e.message });
        });
    });
    return () => { alive = false; };
  }, [members, signingToken, resumeToken]); // eslint-disable-line

  // ── STEP10-VIEWER: derivados del visor (UN doc a la vez + aceptación por doc) ──
  // N es DINÁMICO: los members que el paquete declara (cero hardcode de documentos).
  const docs = (members || []).filter(m => m.file_id);
  const total = docs.length;
  const safeIdx = Math.min(idx, Math.max(0, total - 1));
  const current = total ? docs[safeIdx] : null;
  const currentEntry = current ? docCache[current.file_id] : null;
  const acceptedCount = docs.filter(m => accepted[m.file_id]).length;
  const allAccepted = total > 0 && acceptedCount === total;

  // Aceptación explícita del documento visible; al aceptar, auto-avanza al siguiente
  // documento NO aceptado si lo hay (cita Diego: "aceptación de documentos uno a uno").
  const acceptCurrent = () => {
    if (!current) return;
    const next = { ...accepted, [current.file_id]: true };
    setAccepted(next);
    setErr('');
    const nextIdx = docs.findIndex(m => !next[m.file_id]);
    if (nextIdx >= 0) setIdx(nextIdx);
  };

  // WIZARD — avance optimista REAL (paso 10, BILLING-EDIT causa 3 2026-06-11).
  // (1) gate de validación LOCAL (todos los documentos aceptados uno a uno);
  // (2) encolar confirmReview como FACTORY (enqueueSave encadena la EJECUCIÓN en FIFO
  // tras el save de GDPR — sin `await awaitPendingSave()` previo: ni bloqueo de 53-62s
  // ni el timeout-race de WPERF-4, que existía solo para acotar ese await); (3) avanzar
  // de inmediato a Sign. Un fallo de gdpr (incl. consentimiento bloqueante) o de este
  // acto se surfacea por la nube global ('error' + Reintentar re-encola la factory).
  // SignSign SÍ drena la cola (awaitPendingSave) antes de INICIAR el acto de firma —
  // único await legítimo (dependencia de milestone de revisión confirmada server-side).
  const confirm = () => {
    log.info('[DBG review] confirm CLICK', { accepted_n: acceptedCount, total: docs.length });
    // STEP10-VIEWER: la condición del ACTO confirmReview es que TODOS los members
    // estén aceptados uno a uno (no una puerta de navegación nueva — el gating entre
    // pasos sigue siendo del estado/hitos).
    if (!allAccepted) { setErr(t('signing.review.must_accept_all')); return; }
    setErr('');
    log.info('[DBG review] confirm — avanzando (confirmReview encolado)');

    // KAL-4/KAL-7 intactos (identidad server-side del token).
    // STEP10-VIEWER: el acto registra QUÉ versiones se aceptaron — accepted[] con
    // {file_id, purpose_code, sha256}. El sha256 sale del response de getDocument
    // (DOC-BYTES); se tolera null/ausente hasta que el backend lo emita y lo registre
    // (follow-up server-side pendiente — hoy el backend lo ignora sin romper).
    // El payload se construye ANTES de encolar (cierra sobre docs/docCache actuales,
    // re-ejecutable por el botón Reintentar).
    const acceptedPayload = docs.map(m => ({
      file_id:      m.file_id,
      purpose_code: m.purpose_code || null,
      sha256:       (docCache[m.file_id] && docCache[m.file_id].sha256) || null,
    }));
    const payload = { ...signingIdentity_({ resumeToken, signingToken, n: recoveryNonce, recoveredEmail }), accepted: acceptedPayload };
    enqueueSave(() => gasCall('confirmReview', payload)
      .catch(e => {
        // STEPUP_REQUIRED dentro de la cola: no se reintenta a ciegas — propaga a la nube.
        if (isStepUpRequiredError(e)) log.warn('SignReview: confirmReview requires step-up (queued)');
        else log.error('SignReview: confirmReview failed (background)', { message: e.message });
        throw e;
      }));
    onDone(); // avance optimista inmediato
  };

  // STEP-FRAMEWORK: el nombre del documento es DINÁMICO — del propio member que el
  // paquete declara (designation / purpose_code), con i18n key como preferencia y
  // fallback a lo que el KMS mande. Cero literales de documentos hardcodeados.
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
          /* IDENTITY-COMPLETION (#30): identidad de SESIÓN. _resolveStepUpGroup_ (@665)
             deriva el grupo del resume_token (preferente) o signing_token (compat); `n`/
             recovered_email son inocuos extra (el grupo sale del token). */
          tokenPayload={signingIdentity_({ resumeToken, signingToken, n: recoveryNonce, recoveredEmail })}
          prompt={t('stepup.review_prompt')}
          onVerified={() => {
            markStepUpFresh();
            // STEP10-VIEWER: NO se purga el cache de docs del contexto — si había
            // entradas válidas (otro paso las calentó), siguen sirviendo; lo que
            // falló por STEPUP_REQUIRED nunca se cacheó (cache-miss limpio).
            setMembers(signingMembers);
            setNeedStepUp(false);
            setReloadKey(k => k + 1);
          }}
        />
        {backOnly('bottom')}
      </div>
    );
  }

  // STEP-FRAMEWORK: el "Continuar" se bloquea por la gate de validación (lectura
  // confirmada) Y por que el paquete esté listo (members presentes). Hasta entonces el
  // botón está deshabilitado pero la ESPERA es ACTIVA (progreso visible), nunca un muro
  // "vuelve en unos minutos". El subtítulo nombra los documentos REALES del paquete.
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
      {/* STEP-FRAMEWORK: ESPERA ACTIVA mientras el paquete se prepara — progreso
          visible + reintento automático, JAMÁS "vuelve en unos minutos". Cubre los tres
          casos no-listos (cargando inicial, paquete vacío reintentando, fallo de red
          reintentando) con UN solo bloque de progreso. El error DURO (loadErr, tras 8
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
          {/* STEP10-VIEWER: UN documento a la vez en un visor AMPLIO (ancho completo,
              alto generoso), navegación prev/siguiente + "documento i de N" y
              aceptación explícita POR documento. El object URL sale del cache del
              contexto (blob-only — sin URLs de Drive). */}
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

              {currentEntry ? (
                <iframe
                  title={docLabel(current)}
                  src={currentEntry.url}
                  style={{ width: '100%', height: 'min(72vh, 880px)', minHeight: 420, border: '1px solid var(--border)', borderRadius: 8, background: '#fff' }}
                  sandbox="allow-scripts allow-same-origin allow-popups"
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

// ─── Step 11 — Sign (Click & Sign + polling) ─────────────────────────────────

export function SignSign({ signingToken, resumeToken, signerCtx, onDone, onBack }) { // eslint-disable-line no-unused-vars
  const { t } = useTranslation();
  const { isStepUpFresh, markStepUpFresh, awaitPendingSave, recoveredEmail, recoveryNonce } = useWizard();
  // Back-only nav (top + bottom). The Sign step's "advance" is the signing act
  // itself (launched from the per-signer buttons / polled to completion), so the
  // nav only carries "Atrás" → Review. Hidden once the session is COMPLETED (the
  // terminal success screen has its own Finish button). Mirrors StepNav spacing.
  const backNav = (position) => {
    if (!onBack) return null;
    return (
      <div className={position === 'top' ? 'd-flex justify-content-between mb-3' : 'd-flex justify-content-between mt-3'}>
        <button className="btn-secondary-kis" onClick={onBack}>
          <i className="bi bi-arrow-left me-1" />{t('nav.back')}
        </button>
        <span />
      </div>
    );
  };
  const [session, setSession] = useState(null); // { signerUrls, state }
  const [err, setErr] = useState('');
  // STOP-GAP (fix real = P-SIGN-ENGINE, KMS): el bug user-blocking + legal es que
  // RE-ENTRAR a Step 11 re-despachaba el envelope de Click&Sign (email legalmente
  // vinculante) en CADA mount, porque el backend no avanza fiable la sesión a
  // INITIATED y el check de idempotencia sigue viendo DRAFT. Mientras eso se
  // arregla server-side, el FRONTEND nunca dispara un re-dispatch al re-entrar:
  //   - On mount: lectura READ-ONLY del estado (create_only:true → NO despacha,
  //     NO exige step-up; wizard-firma.gs:215-224). Detecta si la sesión ya está
  //     iniciada (state != DRAFT, o signerUrls ya existen, o signerCtx.steps.signed).
  //   - Si ya iniciada → render de los enlaces / "firma en curso" + polling
  //     read-only (create_only), SIN despachar nunca.
  //   - El despacho REAL (non-create_only, que dispara el envelope) ocurre SOLO
  //     en acción EXPLÍCITA del usuario (botón "Enviar a firma") y SOLO desde
  //     estado no-iniciado (DRAFT). Tras dispararlo una vez → render "ya iniciada".
  // El gate de step-up + auth por signing_token se mantienen intactos.

  // `initiated`: la sesión ya tiene el envelope despachado (no hace falta — ni se
  // debe — re-disparar). Sembrada desde signerCtx (ya firmado) y refinada por la
  // lectura read-only de mount. Una vez true, NO se vuelve a poner false.
  const [initiated, setInitiated] = useState(!!(signerCtx?.steps && signerCtx.steps.signed));
  // DL-E39: gate INCONDICIONAL de firma — SIEMPRE exigimos step-up fresco antes
  // de DESPACHAR el acto de firma, independiente de la inactividad. Solo aplica al
  // dispatch real (botón explícito), nunca a la lectura read-only del estado.
  const [needStepUp, setNeedStepUp] = useState(!isStepUpFresh());
  const pollRef = useRef(null);
  const ipRef = useRef(undefined); // cache de la IP forense (best-effort)

  // ¿El `state` devuelto por el backend indica que la sesión YA fue iniciada
  // (envelope despachado)? Todo lo que no sea DRAFT/null/NOT_INITIATED cuenta como
  // iniciada — INITIATED, IN_PROGRESS, COMPLETED, etc.
  const isInitiatedState = (state) => {
    if (!state) return false;
    const s = String(state).toUpperCase();
    return s !== 'DRAFT' && s !== 'NOT_INITIATED';
  };

  // Lectura READ-ONLY del estado de la sesión: create_only:true crea/garantiza la
  // sesión DRAFT + tokens y devuelve members/state/signerUrls SIN despachar el
  // envelope (wizard-firma.gs:215-224) y SIN exigir step-up. Usado en mount y en
  // el polling — NUNCA re-despacha.
  const readState = async (initial) => {
    try {
      // Data-layer pieza 5: lectura de estado vía single-flight (de-dupe la tormenta
      // de create_only concurrentes). NUNCA despacha el envelope (STOP-GAP intacto).
      // IDENTITY-COMPLETION (#30): identidad de SESIÓN (resume_token preferente).
      const res = await initiateSigningRead({ resumeToken, signingToken });
      log.info('[DBG sign] readState', { initial, state: res && res.state, n_urls: ((res && res.signerUrls) || []).length });
      setSession(res);
      const urls = (res && res.signerUrls) || [];
      if (isInitiatedState(res && res.state) || urls.length > 0) setInitiated(true);
      if (res && res.state === 'COMPLETED' && pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return res;
    } catch (e) {
      if (initial) setErr(e.message || t('signing.generic_error'));
      return undefined;
    }
  };

  const startPolling = () => {
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => readState(false), 5000);
  };

  // DESPACHO REAL del envelope — SOLO desde acción explícita del usuario y SOLO
  // cuando la sesión NO está iniciada. Es el acto legal: exige step-up fresco
  // (gate incondicional DL-E39) + await del save de REVIEW (confirmReview) en
  // vuelo, ya que el acto depende del milestone de revisión confirmada server-side.
  const dispatchSigning = async () => {
    setErr('');
    log.warn('[DBG sign] dispatchSigning — DESPACHO DEL ENVELOPE (acto de firma)');
    // WIZARD — paso 11 BLOQUEANTE: await del save de REVIEW antes de despachar.
    try {
      await awaitPendingSave();
    } catch (e) {
      log.warn('SignSign: previous review save failed', { message: e.message });
      setErr(e?.message || t('signing.generic_error'));
      return;
    }
    // IP forense best-effort: evidencia, nunca gate. KAL-7: nunca va en la URL.
    if (ipRef.current === undefined) {
      ipRef.current = await fetchClientIp();
    }
    try {
      // IDENTITY-COMPLETION (#29): el acto legal reenvía la identidad de SESIÓN
      // (resume_token preferente; el firmante lo resuelve el backend server-side vía
      // requireSignerContext_ @157 + binding token→tutor). El signing_token queda como
      // compat. La mecánica Click & Sign (envelope, single-use/TTL/binding del ACTO,
      // P222) es server-side e intacta — solo cambia DE DÓNDE sale la identidad.
      const res = await gasCall('initiateSigningSession', {
        ...signingIdentity_({ resumeToken, signingToken, n: recoveryNonce, recoveredEmail }),
        client_ip:     ipRef.current || undefined,
      });
      setSession(res);
      setInitiated(true); // tras despachar una vez → no volver a despachar nunca
      if (!(res && res.state === 'COMPLETED')) startPolling();
    } catch (e) {
      // Gate incondicional reforzado por el backend: re-pedimos step-up.
      if (isStepUpRequiredError(e)) {
        log.warn('SignSign: initiateSigningSession requires step-up');
        setNeedStepUp(true);
        return;
      }
      setErr(e.message || t('signing.generic_error'));
    }
  };

  // Click del botón "Enviar a firma": si no hay step-up fresco, lo pedimos primero;
  // tras verificar, despachamos. Si ya está fresco, despachamos directamente.
  const onSendClick = () => {
    if (needStepUp) return; // el render muestra StepUpReverify; onVerified → dispatchSigning
    dispatchSigning();
  };

  useEffect(() => {
    // STOP-GAP: en mount SOLO leemos el estado (read-only, no despacha). El
    // despacho real lo dispara el usuario explícitamente. Esto garantiza que
    // re-montar / re-entrar a Step 11 NUNCA re-despacha el envelope.
    readState(true).then((res) => {
      // Si la sesión ya estaba iniciada, arrancamos el polling para reflejar el
      // progreso de firma — sin despachar.
      const urls = (res && res.signerUrls) || [];
      if (isInitiatedState(res && res.state) || urls.length > 0 || (signerCtx?.steps && signerCtx.steps.signed)) {
        startPolling();
      }
    });
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [signingToken, resumeToken]); // eslint-disable-line

  // Gate incondicional de step-up: SOLO se muestra cuando el usuario va a DESPACHAR
  // desde estado no-iniciado (no para la lectura read-only). Si la sesión ya está
  // iniciada, no exigimos step-up para ver los enlaces.
  if (needStepUp && !initiated) {
    return (
      <div className="kis-card">
        {backNav('top')}
        <h2 style={{ color: 'var(--teal-dk)', fontWeight: 800, fontSize: '1.2rem' }}>{t('signing.signing.title')}</h2>
        <p style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>{t('stepup.sign_gate_body')}</p>
        <StepUpReverify
          /* IDENTITY-COMPLETION (#29): identidad de SESIÓN (resume_token preferente). */
          tokenPayload={signingIdentity_({ resumeToken, signingToken, n: recoveryNonce, recoveredEmail })}
          prompt={t('stepup.sign_prompt')}
          onVerified={() => { markStepUpFresh(); setNeedStepUp(false); dispatchSigning(); }}
        />
        {backNav('bottom')}
      </div>
    );
  }

  if (err) {
    return (
      <div className="kis-card">
        {backNav('top')}
        <h2 style={{ color: 'var(--teal-dk)', fontWeight: 800, fontSize: '1.2rem' }}>{t('signing.signing.title')}</h2>
        <div className="field-error mt-2 p-2 rounded" style={{ background: '#ffeaea' }}>{err}</div>
        {backNav('bottom')}
      </div>
    );
  }

  const state = session && session.state;
  const completed = state === 'COMPLETED' || (signerCtx.steps && signerCtx.steps.signed);

  if (completed) {
    return (
      <div className="kis-card" style={{ textAlign: 'center', padding: '32px 20px' }}>
        <i className="bi bi-check-circle-fill" style={{ fontSize: '2.8rem', color: '#2e7d32' }} />
        <h3 style={{ color: '#1b5e20', marginTop: 16 }}>{t('signing.signing.completed_title')}</h3>
        <p style={{ color: '#2e4a2f', maxWidth: 440, margin: '8px auto 16px' }}>{t('signing.signing.completed_body')}</p>
        <button className="btn-primary-kis" onClick={onDone}>{t('signing.signing.finish')}</button>
      </div>
    );
  }

  const signerUrls = (session && session.signerUrls) || [];

  // STOP-GAP render: si la sesión NO está iniciada (DRAFT), NO despachamos en
  // background — mostramos intro + botón explícito "Enviar a firma". El usuario
  // dispara el envelope una sola vez, conscientemente. Re-entrar aquí con la
  // sesión ya iniciada cae en la rama `initiated` (enlaces + polling), nunca
  // re-despacha.
  if (!initiated) {
    return (
      <div className="kis-card">
        {backNav('top')}
        <h2 style={{ color: 'var(--teal-dk)', fontWeight: 800, fontSize: '1.2rem' }}>{t('signing.signing.title')}</h2>
        <p style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>{t('signing.signing.intro')}</p>
        {session === null && (
          <div style={{ textAlign: 'center', padding: 24, color: 'var(--muted)' }}>
            <span className="spinner-border spinner-border-sm me-2" />{t('signing.saving')}
          </div>
        )}
        <div className="d-flex justify-content-center mt-3">
          <button className="btn-primary-kis" disabled={session === null} onClick={onSendClick}>
            {t('signing.signing.start')}
          </button>
        </div>
        {backNav('bottom')}
      </div>
    );
  }

  return (
    <div className="kis-card">
      {backNav('top')}
      <h2 style={{ color: 'var(--teal-dk)', fontWeight: 800, fontSize: '1.2rem' }}>{t('signing.signing.title')}</h2>
      <p style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>{t('signing.signing.in_progress')}</p>

      {signerUrls.length > 0 ? (
        signerUrls.map((s, i) => {
          const url  = s.signing_url || s.url || s.signingUrl;
          const name = s.name || s.signer_name || t('signing.signing.sign_as_generic');
          return (
            <div key={i} style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', padding: '10px 0', borderBottom: '1px solid var(--bg)' }}>
              <span style={{ fontWeight: 600, fontSize: '0.9rem' }}>{name}</span>
              <button className="btn-primary-kis btn-sm" disabled={!url}
                onClick={() => url && window.open(url, '_blank', 'noopener')}>
                {t('signing.signing.sign_as', { name })}
              </button>
            </div>
          );
        })
      ) : (
        <p style={{ color: 'var(--muted)', fontSize: '0.88rem', textAlign: 'center', padding: 16 }}>
          {t('signing.signing.waiting')}
        </p>
      )}

      <p style={{ textAlign: 'center', fontSize: '0.78rem', color: 'var(--muted)', marginTop: 16 }}>
        <span className="spinner-border spinner-border-sm me-2" style={{ width: 12, height: 12 }} />
        {t('signing.signing.polling')}
      </p>
      {backNav('bottom')}
    </div>
  );
}

// DL-E38: el orchestrator `SigningSteps` default (host de /sign) se ELIMINÓ con el
// merge — el wizard renderiza los pasos de firma 8-11 inline (WizardPage → Step8-11
// → SignBilling/SignGdpr/SignReview/SignSign nombrados arriba), con el sub-step
// gobernado por WizardPage.enterSigning + initialSubStep. No queda default export.
