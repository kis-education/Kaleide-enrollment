import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { gasCall, initiateSigningRead } from '../../api';
import { useWizard } from '../../context/WizardContext';
import { fetchDocumentObjectUrl } from '../../utils/documentProxy';
import { SIGNING_CONSENTS, SIGNING_CONSENT_TEXT_VERSION } from '../../signingConsentTexts';
import StepUpReverify from '../../components/StepUpReverify';
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

// ─── Signing-step nav (top + bottom) ─────────────────────────────────────────
// WIZARD-UX (Diego 2026-06-07): "los botones de avanzar deben aparecer arriba y
// abajo, en las mismas ubicaciones que los paneles anteriores". The signing steps
// (8-11) are NOT plain StepNav steps — their "Next" is a per-step submit (async,
// with its own spinner/label and validation), so we render a dedicated nav block
// that mirrors StepNav's markup/styles but drives the step's own submit handler.
// It is rendered TWICE per step (top + bottom) sharing the same handlers/state.
//
// WIZARD — firma guardado background + avance optimista (Diego 2026-06-07): los
// pasos 8-10 (SignBilling/SignGdpr/SignReview) ya NO bloquean el botón mientras
// guardan. El submit dispara la persistencia en BACKGROUND (setPendingSave) y avanza
// de inmediato (regla N+1 si N-1 guardado: el siguiente paso espera el save de este
// vía awaitPendingSave). El indicador "Guardando…" lo gobierna `savePending`
// (hasPendingSave del contexto) — NO inhabilita el avance. El paso 11 (SignSign) SÍ
// sigue bloqueante: es el ACTO terminal de firma, no un avance. `submitting` se
// reserva para ese bloqueo terminal; los pasos optimistas pasan submitting=false +
// savePending para el label no-bloqueante.
export function SigningNav({ onBack, onSubmit, submitting, savePending = false, submitLabel, savingLabel, position = 'bottom', hideBack = false, submitDisabled = false }) {
  const { t } = useTranslation();
  const wrapClass = position === 'top'
    ? 'd-flex justify-content-between mb-3'
    : 'd-flex justify-content-between mt-3';
  // savePending → spinner + "Guardando…" label, pero el botón NO se inhabilita por
  // ello (avance optimista). `submitting` (bloqueo terminal de SignSign) sí lo
  // inhabilita; `submitDisabled` cubre las gates de validación per-step.
  const showSpinner = submitting || savePending;
  return (
    <div className={wrapClass}>
      {hideBack || !onBack
        ? <span />
        : (
          <button className="btn-secondary-kis" onClick={onBack} disabled={submitting}>
            <i className="bi bi-arrow-left me-1" />{t('nav.back')}
          </button>
        )}
      <button className="btn-primary-kis" onClick={onSubmit} disabled={submitting || submitDisabled}>
        {showSpinner
          ? <><span className="spinner-border spinner-border-sm me-2" />{savingLabel}</>
          : submitLabel}
      </button>
    </div>
  );
}

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
export function SignBilling({ signingToken, signerCtx, onDone, onBack }) {
  const { t } = useTranslation();
  const { stepData, setPendingSave, awaitPendingSave, hasPendingSave } = useWizard();
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

  // Construye las filas de reparto por defecto: firmante 100%, resto 0% (suma 100).
  // Fallback (/sign host sin stepData): una sola fila GUARDIAN (el firmante) al 100%.
  const seedPayers = () => {
    if (guardians.length) {
      const rows = guardians.map((g, i) => {
        const pid = g.person_id || g._uid;
        const isSigner = guardianPersonId ? pid === guardianPersonId : i === 0;
        return {
          key: 'g_' + (pid || i),
          payer_person_id: pid || (isSigner ? guardianPersonId : null) || null,
          name: fullNameOf(g) || t('signing.billing.split.guardian_fallback', { n: i + 1 }),
          split: isSigner ? 100 : 0,
        };
      });
      if (!rows.some(r => r.split === 100) && rows.length) rows[0].split = 100;
      return rows;
    }
    return [{ key: 'signer', payer_person_id: guardianPersonId || null, name: t('signing.billing.split.you'), split: 100 }];
  };

  const [payers, setPayers]         = useState([]);    // group-level (default colapsado)
  const [perChild, setPerChild]     = useState(false); // CLI 10: "personalizar por hijo"
  const [childSplits, setChildSplits] = useState({});  // applicant_person_id → payers[]
  const [err, setErr] = useState('');

  // Seed group-level + per-hijo una sola vez (cuando hay tutores/hijos).
  useEffect(() => {
    if (payers.length) return;
    setPayers(seedPayers());
    if (applicants.length) {
      const map = {};
      applicants.forEach(a => { map[a.person_id || a._uid] = seedPayers(); });
      setChildSplits(map);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guardians.length, applicants.length, guardianPersonId]);

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

  // WIZARD — guardado background + avance optimista (paso 8). (1) gate de validación;
  // (2) await del save previo en vuelo (surfacea un fallo anterior); (3) saveBillingInfo
  // en BACKGROUND; (4) avance inmediato (onDone). KAL-4/KAL-7 intactos: el KMS deriva
  // grupo/signer del token; el payload solo lleva % (group-level o per-hijo).
  const submit = async () => {
    const v = validate();
    if (v) { setErr(v); return; }
    try {
      await awaitPendingSave();
    } catch (e) {
      log.warn('SignBilling: previous signing-step save failed', { message: e.message });
      setErr(e?.message === 'NOT_EDITABLE' ? t('signing.billing.err_locked') : (e?.message || t('signing.generic_error')));
      return;
    }

    setErr('');
    // Default (colapsado) → payers[] group-level; "personalizar por hijo" → per_participant.
    const body = { signing_token: signingToken };
    if (perChild && applicants.length) body.per_participant = buildPerParticipantPayload();
    else body.payers = buildGroupPayload();
    // Background save (NO await aquí). El siguiente paso lo espera vía awaitPendingSave.
    const savePromise = gasCall('saveBillingInfo', body).catch(e => {
      log.error('SignBilling: saveBillingInfo failed (background)', { message: e.message });
      throw e; // se surface en el siguiente gate (awaitPendingSave del paso N+1)
    });
    setPendingSave(savePromise);
    onDone(); // avance optimista inmediato
  };

  // Avance optimista: `submitting=false` (no bloqueamos el botón); el spinner
  // "Guardando…" lo gobierna `savePending` (hasPendingSave del contexto).
  const nav = (position) => (
    <SigningNav
      position={position}
      onBack={onBack}
      onSubmit={submit}
      submitting={false}
      savePending={hasPendingSave}
      submitLabel={t('signing.billing.submit')}
      savingLabel={t('signing.saving')}
    />
  );

  return (
    <div className="kis-card">
      {nav('top')}
      <h2 style={{ color: 'var(--teal-dk)', fontWeight: 800, fontSize: '1.2rem' }}>{t('signing.billing.title')}</h2>
      <p style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>{t('signing.billing.subtitle')}</p>

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

      {err && <div className="field-error mt-2 p-2 rounded" style={{ background: '#ffeaea' }}>{err}</div>}
      {nav('bottom')}
    </div>
  );
}

// ─── Step 9 — GDPR (modo conservador GATE-B: UN set, sin fan-out per-guardian) ─

export function SignGdpr({ signingToken, signerCtx, lang, onDone, onBack }) {
  const { t } = useTranslation();
  const { setPendingSave, awaitPendingSave, hasPendingSave, stepData } = useWizard();

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
  const toggleGen = (code) => {
    const next = { ...genState, [code]: !genState[code] };
    persistConsents(next, imgState); setGenState(next);
  };
  const toggleImg = (subjectId, code) => {
    const next = { ...imgState, [subjectId]: { ...(imgState[subjectId] || {}), [code]: !(imgState[subjectId] && imgState[subjectId][code]) } };
    persistConsents(genState, next); setImgState(next);
  };

  // WIZARD — guardado background + avance optimista (paso 9). Mirror del patrón
  // /apply: (1) await del save de BILLING en vuelo (awaitPendingSave) — fuerza el lag
  // de un paso y surface un fallo de billing antes de proceder; (2) disparar ESTE
  // submitGdprConsents en BACKGROUND vía setPendingSave; (3) avanzar de inmediato.
  // Si el save de background rechaza, se surface en el siguiente gate (SignReview).
  const submit = async () => {
    const gdprSchool = generalConsents.find(c => c.blocking);
    if (gdprSchool && genState[gdprSchool.code] !== true) {
      setErr(t('signing.gdpr.must_accept_blocking'));
      return;
    }

    // Lag de un paso: espera el save de BILLING. Si falló, su rechazo se surface aquí
    // y NO avanzamos a Review.
    try {
      await awaitPendingSave();
    } catch (e) {
      log.warn('SignGdpr: previous billing save failed', { message: e.message });
      setErr(e?.message || t('signing.generic_error'));
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
    // Background save (NO await). `res.blocked` (rechazo de consentimiento bloqueante)
    // se convierte en un rechazo de la promesa para que el siguiente gate lo surface
    // — coherente con el resto de fallos de background. KAL-4/KAL-7 + payload intactos.
    const savePromise = gasCall('submitGdprConsents', { signing_token: signingToken, consents })
      .then(res => {
        if (res && res.blocked) {
          const blockErr = new Error('GDPR_BLOCKED');
          blockErr.gdprBlocked = true;
          throw blockErr;
        }
        return res;
      })
      .catch(e => {
        log.error('SignGdpr: submitGdprConsents failed (background)', { message: e.message });
        throw e;
      });
    setPendingSave(savePromise);
    onDone(); // avance optimista inmediato
  };

  const nav = (position) => (
    <SigningNav
      position={position}
      onBack={onBack}
      onSubmit={submit}
      submitting={false}
      savePending={hasPendingSave}
      submitLabel={t('signing.gdpr.submit')}
      savingLabel={t('signing.saving')}
    />
  );

  return (
    <div className="kis-card">
      {nav('top')}
      <h2 style={{ color: 'var(--teal-dk)', fontWeight: 800, fontSize: '1.2rem' }}>{t('signing.gdpr.title')}</h2>
      <p style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>{t('signing.gdpr.subtitle')}</p>

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

      {err && <div className="field-error mt-2 p-2 rounded" style={{ background: '#ffeaea' }}>{err}</div>}
      {nav('bottom')}
    </div>
  );
}

// ─── Step 10 — Review (paquete contractual + confirmación lectura) ────────────

export function SignReview({ signingToken, onDone, onBack }) {
  const { t } = useTranslation();
  const { isStepUpFresh, markStepUpFresh, setPendingSave, awaitPendingSave, hasPendingSave } = useWizard();
  const [members, setMembers] = useState(null); // null=loading, []=empty
  const [loadErr, setLoadErr] = useState('');
  const [read, setRead] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState('');
  // DL-E39: la revisión del paquete contractual carga documentos sensibles vía
  // getDocument (handler gateado). Si no hay step-up fresco — o el backend
  // devuelve STEPUP_REQUIRED — exigimos re-verificar antes de cargar/previsualizar.
  const [needStepUp, setNeedStepUp] = useState(!isStepUpFresh());
  const [reloadKey, setReloadKey] = useState(0);
  // CLI 82 / KAL-NEW-5: file_id → object URL (bytes vía getDocument + signing_token).
  // Sustituye los enlaces públicos de Drive (m.drive_view_url) por previews
  // servidas desde el proxy de bytes. Privados al dueño del deployment.
  const [docUrls, setDocUrls] = useState({});

  useEffect(() => {
    if (needStepUp) return undefined;
    let alive = true;
    // P-REVIEW-READONLY: Step 10 solo LEE los docs/members → create_only (NO despacha
    // el envelope). El dispatch real del acto de firma vive SOLO en Step 11 (SignSign).
    // Data-layer pieza 5: single-flight (de-dupe la tormenta de create_only concurrentes).
    initiateSigningRead(signingToken)
      .then(res => { if (alive) setMembers(Array.isArray(res.members) ? res.members : []); })
      .catch(e => {
        if (isStepUpRequiredError(e)) {
          log.warn('SignReview: initiateSigningSession requires step-up');
          if (alive) setNeedStepUp(true);
          return;
        }
        log.error('SignReview: initiateSigningSession failed', { message: e.message });
        if (alive) setLoadErr(e.message || t('signing.generic_error'));
      });
    return () => { alive = false; };
  }, [signingToken, needStepUp, reloadKey]); // eslint-disable-line

  // Resuelve los bytes de cada documento del paquete vía el proxy y construye
  // object URLs en memoria. Revoca todas las URLs al desmontar.
  useEffect(() => {
    if (!members || !members.length) return undefined;
    let alive = true;
    const created = [];
    members.forEach(m => {
      if (!m.file_id) return;
      fetchDocumentObjectUrl({ file_id: m.file_id, signing_token: signingToken })
        .then(({ url }) => {
          if (!alive) { URL.revokeObjectURL(url); return; }
          created.push(url);
          setDocUrls(prev => ({ ...prev, [m.file_id]: url }));
        })
        .catch(e => {
          if (isStepUpRequiredError(e)) { if (alive) setNeedStepUp(true); return; }
          log.error('SignReview: getDocument failed', { file_id: m.file_id, message: e.message });
        });
    });
    return () => { alive = false; created.forEach(u => URL.revokeObjectURL(u)); };
  }, [members, signingToken]); // eslint-disable-line

  // WIZARD — guardado background + avance optimista (paso 10). (1) await del save de
  // GDPR en vuelo (awaitPendingSave) — fuerza el lag de un paso y surface un fallo de
  // gdpr (incl. consentimiento bloqueante rechazado) antes de proceder; (2) disparar
  // confirmReview en BACKGROUND vía setPendingSave; (3) avanzar de inmediato a Sign.
  // SignSign hará a su vez await de ESTE confirmReview antes de iniciar el acto de
  // firma (dependencia de milestone). `submitting` se mantiene como gate de "click ya
  // procesado" para el await previo (puede tardar), pero NO bloquea el avance una vez
  // disparado el background save.
  const confirm = async () => {
    if (!read) { setErr(t('signing.review.must_read')); return; }
    setErr(''); setSubmitting(true);

    // Lag de un paso: espera el save de GDPR. Si falló (incl. bloqueante), su rechazo
    // se surface aquí y NO avanzamos a Sign.
    try {
      await awaitPendingSave();
    } catch (e) {
      log.warn('SignReview: previous gdpr save failed', { message: e.message });
      setErr(e?.gdprBlocked ? t('signing.gdpr.blocked') : (e?.message || t('signing.generic_error')));
      setSubmitting(false);
      return;
    }

    // Background save (NO await). SignSign lo espera vía awaitPendingSave antes de
    // iniciar el acto de firma. KAL-4/KAL-7 + payload intactos.
    const savePromise = gasCall('confirmReview', { signing_token: signingToken })
      .catch(e => {
        log.error('SignReview: confirmReview failed (background)', { message: e.message });
        throw e;
      });
    setPendingSave(savePromise);
    setSubmitting(false);
    onDone(); // avance optimista inmediato
  };

  const docLabel = (m) => t('signing.doc.' + (m.purpose_code || ''), { defaultValue: m.designation || m.purpose_code || t('signing.review.document') });

  // Top/bottom nav for the review step. `read` gates the submit (mirrors the
  // inline "must read" check); the spinner/label swap matches the other steps.
  // `submitting` cubre la ventana breve de await del save previo (gdpr) — bloquea el
  // botón mientras esperamos que el lag se resuelva. `savePending` (hasPendingSave)
  // muestra "Guardando…" no-bloqueante mientras confirmReview corre en background tras
  // el avance optimista. `read` es la gate de validación (confirmación de lectura).
  const nav = (position) => (
    <SigningNav
      position={position}
      onBack={onBack}
      onSubmit={confirm}
      submitting={submitting}
      savePending={hasPendingSave}
      submitDisabled={!read}
      submitLabel={t('signing.review.submit')}
      savingLabel={t('signing.saving')}
    />
  );

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
          tokenPayload={{ signing_token: signingToken }}
          prompt={t('stepup.review_prompt')}
          onVerified={() => {
            markStepUpFresh();
            setMembers(null);
            setDocUrls({});
            setNeedStepUp(false);
            setReloadKey(k => k + 1);
          }}
        />
        {backOnly('bottom')}
      </div>
    );
  }

  return (
    <div className="kis-card">
      {nav('top')}
      <h2 style={{ color: 'var(--teal-dk)', fontWeight: 800, fontSize: '1.2rem' }}>{t('signing.review.title')}</h2>
      <p style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>{t('signing.review.subtitle')}</p>

      {loadErr && (
        <div className="kis-card" style={{ textAlign: 'center', color: 'var(--muted)', background: 'var(--bg)' }}>
          <i className="bi bi-hourglass-split" style={{ fontSize: '1.5rem', display: 'block', marginBottom: 8 }} />
          {t('signing.review.package_loading')}
        </div>
      )}

      {!loadErr && members === null && (
        <div style={{ textAlign: 'center', padding: 24, color: 'var(--muted)' }}>
          <span className="spinner-border spinner-border-sm me-2" />{t('signing.review.docs_loading')}
        </div>
      )}

      {!loadErr && members !== null && members.length === 0 && (
        <div className="kis-card" style={{ textAlign: 'center', color: 'var(--muted)', background: 'var(--bg)' }}>
          <i className="bi bi-hourglass-split" style={{ fontSize: '1.5rem', display: 'block', marginBottom: 8 }} />
          {t('signing.review.package_loading')}
        </div>
      )}

      {!loadErr && members && members.length > 0 && (
        <>
          {members.map((m, i) => {
            const docUrl = m.file_id ? docUrls[m.file_id] : null;
            return (
            <div key={m.file_id || i} style={{ marginBottom: 18 }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <strong style={{ color: 'var(--teal-dk)', fontSize: '0.92rem' }}>{docLabel(m)}</strong>
                {docUrl && (
                  <a href={docUrl} target="_blank" rel="noreferrer" style={{ fontSize: '0.8rem', color: 'var(--teal-dk)' }}>
                    {t('signing.review.open_doc')} <i className="bi bi-box-arrow-up-right ms-1" />
                  </a>
                )}
              </div>
              {docUrl ? (
                <iframe
                  title={docLabel(m)}
                  src={docUrl}
                  style={{ width: '100%', height: 480, border: '1px solid var(--border)', borderRadius: 8 }}
                  sandbox="allow-scripts allow-same-origin allow-popups"
                />
              ) : m.file_id ? (
                <div style={{ textAlign: 'center', padding: 24, color: 'var(--muted)' }}>
                  <span className="spinner-border spinner-border-sm me-2" />{t('signing.review.docs_loading')}
                </div>
              ) : null}
            </div>
            );
          })}
          <div className="form-check mt-2">
            <input type="checkbox" className="form-check-input" id="review_read"
              checked={read} onChange={e => setRead(e.target.checked)} />
            <label className="form-check-label fw-semibold" htmlFor="review_read" style={{ fontSize: '0.88rem' }}>
              {t('signing.review.confirm_label')}
            </label>
          </div>
          {err && <div className="field-error mt-2 p-2 rounded" style={{ background: '#ffeaea' }}>{err}</div>}
          {nav('bottom')}
        </>
      )}
    </div>
  );
}

// ─── Step 11 — Sign (Click & Sign + polling) ─────────────────────────────────

export function SignSign({ signingToken, signerCtx, onDone, onBack }) {
  const { t } = useTranslation();
  const { isStepUpFresh, markStepUpFresh, awaitPendingSave } = useWizard();
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
      const res = await initiateSigningRead(signingToken);
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
      const res = await gasCall('initiateSigningSession', {
        signing_token: signingToken,
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
  }, [signingToken]); // eslint-disable-line

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
          tokenPayload={{ signing_token: signingToken }}
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
