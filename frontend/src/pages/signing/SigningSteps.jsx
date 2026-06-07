import { useState, useEffect, useRef } from 'react';
import { useTranslation } from 'react-i18next';
import { gasCall } from '../../api';
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
 * Flujo funcional de firma (Steps 8-11) — vive en /sign (SigningWizardPage),
 * NO en el wizard /apply. Recibe `signingToken` + `signerCtx` (resueltos por
 * resolveSigningToken). Cada submit pasa `signing_token` al gasCall (auth
 * canónica del flujo /sign — requireSigningToken_ backend, CLI 45).
 *
 * Secuencia: billing → gdpr → review → sign. El sub-step inicial se deriva de
 * signerCtx.steps (billing_confirmed / gdpr_completed / review_completed / signed).
 */

const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/;
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
export function SigningNav({ onBack, onSubmit, submitting, submitLabel, savingLabel, position = 'bottom', hideBack = false, submitDisabled = false }) {
  const { t } = useTranslation();
  const wrapClass = position === 'top'
    ? 'd-flex justify-content-between mb-3'
    : 'd-flex justify-content-between mt-3';
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
        {submitting
          ? <><span className="spinner-border spinner-border-sm me-2" />{savingLabel}</>
          : submitLabel}
      </button>
    </div>
  );
}

// ─── Step 8 — Billing (+ reparto entre pagadores) ─────────────────────────────

const BLANK_PAYER_FIELDS = {
  fiscal_name: '', fiscal_tax_id: '', fiscal_address_line1: '',
  fiscal_address_city: '', fiscal_postal_code: '', billing_email: '',
};

export function SignBilling({ signingToken, signerCtx, onDone, onBack }) {
  const { t } = useTranslation();
  const { stepData } = useWizard();
  // Default payer = signing guardian (DL-E38: identity derived server-side from the
  // signing_token; client only echoes guardian_person_id for the KMS to disambiguate
  // which guardian pays in a multi-guardian family). KAL-4 stays intact — the KMS
  // re-derives enrollment_group_id + signer from the token, never from this payload.
  const guardianPersonId = signerCtx && signerCtx.guardian_person_id;
  const persons = (stepData && stepData.persons) || [];
  const guardians = persons.filter(p => p.person_type_id === 'guardian');
  const primaryEmail = (stepData && stepData.email && stepData.email.primary_email) || '';

  // Titular (default payer) fiscal fields — prefilled from the signing guardian.
  const [f, setF] = useState({ ...BLANK_PAYER_FIELDS, billing_phone: '' });
  // Reparto: one row per group guardian (GUARDIAN payer_type only — NO third-party
  // billing per Diego's decision). Each row carries a `split_percentage`. Default:
  // signing guardian 100%, the rest 0% (sums to 100). The titular's own fiscal data
  // lives in `f` (the first GUARDIAN row mirrors `f`); other guardian rows only need
  // a % (their fiscal data is already in core from onboarding — the KMS resolves it
  // by payer_person_id).
  const [payers, setPayers] = useState([]); // [{ key, payer_type:'GUARDIAN', payer_person_id, name, split, ...fiscal }]
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState('');
  const set = (k) => (e) => setF(prev => ({ ...prev, [k]: e.target.value }));

  const fullNameOf = (g) => [g.first_name, g.middle_name, g.last_name]
    .filter(x => x && String(x).trim()).join(' ').trim();

  // Prefill from the signing guardian's already-captured fiscal data (Persons step).
  // Best-effort: if the person record or any field isn't available client-side, the
  // field stays blank and remains editable. The /sign host (SigningSteps) has no
  // wizard stepData → prefill is a no-op there, which is acceptable (the family can
  // type the data); the critical payer_person_id is still sent from signerCtx.
  useEffect(() => {
    if (!guardianPersonId) return;
    const g = persons.find(p => (p.person_id || p._uid) === guardianPersonId);
    if (!g) return;
    const addr = g.address || {};
    setF(prev => ({
      ...prev,
      fiscal_name:          prev.fiscal_name          || fullNameOf(g),
      fiscal_tax_id:        prev.fiscal_tax_id        || (g.id_number || ''),
      fiscal_address_line1: prev.fiscal_address_line1 || (addr.address_line_1 || ''),
      fiscal_address_city:  prev.fiscal_address_city  || (addr.city || ''),
      fiscal_postal_code:   prev.fiscal_postal_code   || (addr.zip || ''),
      billing_email:        prev.billing_email        || primaryEmail,
    }));
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guardianPersonId]);

  // Seed the reparto rows from the group guardians: signing guardian 100%, rest 0%.
  // Runs once when guardians become available (prefer the signing guardian as the
  // 100% default; if it can't be identified — e.g. the /sign host with no stepData —
  // fall back to a single synthetic GUARDIAN row at 100% echoing signerCtx).
  useEffect(() => {
    if (payers.length) return;
    if (guardians.length) {
      const rows = guardians.map((g, i) => {
        const pid = g.person_id || g._uid;
        const isSigner = guardianPersonId ? pid === guardianPersonId : i === 0;
        return {
          key: 'g_' + (pid || i),
          payer_type: 'GUARDIAN',
          payer_person_id: pid || (isSigner ? guardianPersonId : null) || null,
          name: fullNameOf(g) || t('signing.billing.split.guardian_fallback', { n: i + 1 }),
          split: isSigner ? 100 : 0,
          ...BLANK_PAYER_FIELDS,
        };
      });
      // Guarantee exactly one 100% default even if the signer wasn't matched.
      if (!rows.some(r => r.split === 100) && rows.length) rows[0].split = 100;
      setPayers(rows);
    } else {
      // /sign host or no stepData: single synthetic GUARDIAN row (the signer) at 100%.
      setPayers([{
        key: 'signer',
        payer_type: 'GUARDIAN',
        payer_person_id: guardianPersonId || null,
        name: t('signing.billing.split.you'),
        split: 100,
        ...BLANK_PAYER_FIELDS,
      }]);
    }
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [guardians.length, guardianPersonId]);

  const setSplit = (key) => (e) => {
    const raw = e.target.value;
    const n = raw === '' ? 0 : Math.max(0, Math.min(100, Number(raw) || 0));
    setPayers(prev => prev.map(p => p.key === key ? { ...p, split: n } : p));
  };
  const totalSplit = payers.reduce((s, p) => s + (Number(p.split) || 0), 0);

  // Build the canonical payers[] contract (THIS shape is mirrored by the parallel
  // KMS agent). All rows are GUARDIAN payers (no third-party billing). The titular's
  // fiscal data (`f`) feeds the signing-guardian row so a single-payer family still
  // sends complete data; other guardian rows carry only a % (the KMS resolves their
  // fiscal data from core by payer_person_id).
  const buildPayersPayload = () => payers
    .filter(p => (Number(p.split) || 0) > 0 || payers.length === 1)
    .map(p => {
      const isTitular = guardianPersonId ? p.payer_person_id === guardianPersonId : p.split === 100;
      const fiscal = isTitular ? f : p;
      return {
        payer_type:           'GUARDIAN',
        payer_person_id:      p.payer_person_id || null,
        fiscal_name:          (fiscal.fiscal_name || p.name || '').trim() || null,
        fiscal_tax_id:        (fiscal.fiscal_tax_id || '').trim() || null,
        fiscal_address_line1: (fiscal.fiscal_address_line1 || '').trim() || null,
        fiscal_address_city:  (fiscal.fiscal_address_city || '').trim() || null,
        fiscal_postal_code:   (fiscal.fiscal_postal_code || '').trim() || null,
        billing_email:        (fiscal.billing_email || (isTitular ? f.billing_email : '') || '').trim() || null,
        split_percentage:     Number(p.split) || 0,
      };
    });

  const submit = async () => {
    if (!f.fiscal_name.trim())  { setErr(t('signing.billing.err_name')); return; }
    if (!EMAIL_RE.test(f.billing_email.trim())) { setErr(t('signing.billing.err_email')); return; }
    if (Math.round(totalSplit) !== 100) { setErr(t('signing.billing.split.err_sum', { total: totalSplit })); return; }

    setErr(''); setSubmitting(true);
    const payersPayload = buildPayersPayload();
    try {
      await gasCall('saveBillingInfo', {
        signing_token:        signingToken,
        // Canonical multi-payer contract (parallel KMS agent implements the same).
        payers:               payersPayload,
        // ── Backwards-compat single-payer fields (titular = default payer) ──
        // The current wizard proxy forwards these top-level fields; the new `payers`
        // array is forwarded once the proxy/KMS gain multi-payer support. Sending
        // both keeps today's single-payer flow working through the unmodified proxy.
        payer_type:           'GUARDIAN',
        // Default payer = the signing guardian. The KMS handler
        // (fin_saveBillingPartyFromWizard) REQUIRES payer_person_id for a GUARDIAN
        // payer to disambiguate which guardian pays in a multi-guardian family.
        payer_person_id:      guardianPersonId || undefined,
        fiscal_name:          f.fiscal_name.trim(),
        fiscal_tax_id:        f.fiscal_tax_id.trim() || null,
        fiscal_address_line1: f.fiscal_address_line1.trim() || null,
        fiscal_address_city:  f.fiscal_address_city.trim() || null,
        fiscal_postal_code:   f.fiscal_postal_code.trim() || null,
        billing_email:        f.billing_email.trim(),
        // Titular's split (for proxies that read split_percentage at top level).
        split_percentage:     (payersPayload.find(p => p.payer_person_id === (guardianPersonId || null)) || payersPayload[0] || {}).split_percentage,
      });
      onDone();
    } catch (e) {
      log.error('SignBilling: saveBillingInfo failed', { message: e.message });
      setErr(e.message === 'NOT_EDITABLE' ? t('signing.billing.err_locked') : (e.message || t('signing.generic_error')));
      setSubmitting(false);
    }
  };

  const field = (k, type = 'text', required = false) => (
    <div className="mb-3">
      <label className="form-label fw-semibold" style={{ fontSize: '0.85rem' }}>
        {t('signing.billing.field.' + k)}{required && ' *'}
      </label>
      <input type={type} className="form-control" value={f[k]} onChange={set(k)} />
    </div>
  );

  const nav = (position) => (
    <SigningNav
      position={position}
      onBack={onBack}
      onSubmit={submit}
      submitting={submitting}
      submitLabel={t('signing.billing.submit')}
      savingLabel={t('signing.saving')}
    />
  );

  const sumOk = Math.round(totalSplit) === 100;

  return (
    <div className="kis-card">
      {nav('top')}
      <h2 style={{ color: 'var(--teal-dk)', fontWeight: 800, fontSize: '1.2rem' }}>{t('signing.billing.title')}</h2>
      <p style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>{t('signing.billing.subtitle')}</p>
      {field('fiscal_name', 'text', true)}
      {field('fiscal_tax_id')}
      {field('fiscal_address_line1')}
      <div style={{ display: 'flex', gap: 12 }}>
        <div style={{ flex: 2 }}>{field('fiscal_address_city')}</div>
        <div style={{ flex: 1 }}>{field('fiscal_postal_code')}</div>
      </div>
      {field('billing_email', 'email', true)}
      {field('billing_phone', 'tel')}

      {/* ── Reparto entre pagadores (split) ──────────────────────────────────── */}
      <div style={{ marginTop: 20, paddingTop: 16, borderTop: '1px solid var(--border)' }}>
        <h3 style={{ color: 'var(--teal-dk)', fontWeight: 700, fontSize: '0.98rem', marginBottom: 4 }}>
          {t('signing.billing.split.title')}
        </h3>
        <p style={{ color: 'var(--muted)', fontSize: '0.84rem', marginBottom: 12 }}>
          {t('signing.billing.split.subtitle')}
        </p>

        {payers.map(p => (
          <div key={p.key} style={{ marginBottom: 12, padding: '10px 12px', background: 'var(--bg)', borderRadius: 8 }}>
            <div style={{ display: 'flex', alignItems: 'center', gap: 12 }}>
              <span style={{ flex: 1, fontWeight: 600, fontSize: '0.88rem' }}>{p.name}</span>
              <div style={{ display: 'flex', alignItems: 'center', gap: 6, width: 110 }}>
                <input
                  type="number" min="0" max="100"
                  className="form-control"
                  style={{ width: 72, textAlign: 'right' }}
                  value={p.split}
                  onChange={setSplit(p.key)}
                />
                <span style={{ fontWeight: 600, color: 'var(--muted)' }}>%</span>
              </div>
            </div>
          </div>
        ))}

        <div style={{
          marginTop: 12, display: 'flex', justifyContent: 'space-between', alignItems: 'center',
          fontSize: '0.88rem', fontWeight: 700,
          color: sumOk ? '#1b5e20' : '#a02020',
        }}>
          <span>{t('signing.billing.split.total')}</span>
          <span>{totalSplit}%</span>
        </div>
        {!sumOk && (
          <div className="field-error mt-1 p-2 rounded" style={{ background: '#ffeaea', fontSize: '0.82rem' }}>
            {t('signing.billing.split.err_sum', { total: totalSplit })}
          </div>
        )}
      </div>

      {err && <div className="field-error mt-2 p-2 rounded" style={{ background: '#ffeaea' }}>{err}</div>}
      {nav('bottom')}
    </div>
  );
}

// ─── Step 9 — GDPR (modo conservador GATE-B: UN set, sin fan-out per-guardian) ─

export function SignGdpr({ signingToken, lang, onDone, onBack }) {
  const { t } = useTranslation();
  // default: blocking consent unchecked, optional ones unchecked.
  const [state, setState] = useState(() => {
    const init = {}; SIGNING_CONSENTS.forEach(c => { init[c.code] = false; }); return init;
  });
  const [submitting, setSubmitting] = useState(false);
  const [err, setErr] = useState('');
  const toggle = (code) => setState(prev => ({ ...prev, [code]: !prev[code] }));

  const submit = async () => {
    const gdprSchool = SIGNING_CONSENTS.find(c => c.blocking);
    if (gdprSchool && state[gdprSchool.code] !== true) {
      setErr(t('signing.gdpr.must_accept_blocking'));
      return;
    }
    setErr(''); setSubmitting(true);
    const consents = SIGNING_CONSENTS.map(c => ({
      consent_type_code:    c.code,
      consent_use:          c.consent_use || null,
      consented:            state[c.code] === true,
      consent_text_shown:   c.text[lang],
      consent_text_version: SIGNING_CONSENT_TEXT_VERSION,
      language:             lang,
      signed_method:        'WEB_CLICK',
      user_agent:           navigator.userAgent,
    }));
    try {
      const res = await gasCall('submitGdprConsents', { signing_token: signingToken, consents });
      if (res.blocked) { setErr(t('signing.gdpr.blocked')); setSubmitting(false); return; }
      onDone();
    } catch (e) {
      log.error('SignGdpr: submitGdprConsents failed', { message: e.message });
      setErr(e.message || t('signing.generic_error'));
      setSubmitting(false);
    }
  };

  const nav = (position) => (
    <SigningNav
      position={position}
      onBack={onBack}
      onSubmit={submit}
      submitting={submitting}
      submitLabel={t('signing.gdpr.submit')}
      savingLabel={t('signing.saving')}
    />
  );

  return (
    <div className="kis-card">
      {nav('top')}
      <h2 style={{ color: 'var(--teal-dk)', fontWeight: 800, fontSize: '1.2rem' }}>{t('signing.gdpr.title')}</h2>
      <p style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>{t('signing.gdpr.subtitle')}</p>
      {SIGNING_CONSENTS.map(c => (
        <div key={c.code} className="consent-block" style={{ borderBottom: '1px solid var(--bg)', paddingBottom: 12, marginBottom: 12 }}>
          <p style={{ fontSize: '0.86rem', color: 'var(--text)', marginBottom: 8 }}>{c.text[lang]}</p>
          <div className="form-check">
            <input type="checkbox" className="form-check-input" id={'consent_' + c.code}
              checked={state[c.code]} onChange={() => toggle(c.code)} />
            <label className="form-check-label fw-semibold" htmlFor={'consent_' + c.code} style={{ fontSize: '0.85rem' }}>
              {c.label[lang]}{c.blocking && <span style={{ color: '#c0392b' }}> *</span>}
            </label>
          </div>
        </div>
      ))}
      {err && <div className="field-error mt-2 p-2 rounded" style={{ background: '#ffeaea' }}>{err}</div>}
      {nav('bottom')}
    </div>
  );
}

// ─── Step 10 — Review (paquete contractual + confirmación lectura) ────────────

export function SignReview({ signingToken, onDone, onBack }) {
  const { t } = useTranslation();
  const { isStepUpFresh, markStepUpFresh } = useWizard();
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
    gasCall('initiateSigningSession', { signing_token: signingToken })
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

  const confirm = async () => {
    if (!read) { setErr(t('signing.review.must_read')); return; }
    setErr(''); setSubmitting(true);
    try {
      await gasCall('confirmReview', { signing_token: signingToken });
      onDone();
    } catch (e) {
      log.error('SignReview: confirmReview failed', { message: e.message });
      setErr(e.message || t('signing.generic_error'));
      setSubmitting(false);
    }
  };

  const docLabel = (m) => t('signing.doc.' + (m.purpose_code || ''), { defaultValue: m.designation || m.purpose_code || t('signing.review.document') });

  // Top/bottom nav for the review step. `read` gates the submit (mirrors the
  // inline "must read" check); the spinner/label swap matches the other steps.
  const nav = (position) => (
    <SigningNav
      position={position}
      onBack={onBack}
      onSubmit={confirm}
      submitting={submitting}
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
  const { isStepUpFresh, markStepUpFresh } = useWizard();
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
  // DL-E39: gate INCONDICIONAL de firma — SIEMPRE exigimos step-up fresco antes
  // de iniciar el acto de firma, independiente de la inactividad. Si no está
  // fresco (o el backend devuelve STEPUP_REQUIRED) mostramos StepUpReverify.
  const [needStepUp, setNeedStepUp] = useState(!isStepUpFresh());
  const pollRef = useRef(null);
  const ipRef = useRef(undefined); // cache de la IP forense (best-effort)

  const refresh = async (initial) => {
    // IP forense best-effort: la obtenemos una vez y la adjuntamos como
    // client_ip (evidencia, nunca gate). KAL-7: nunca va en la URL.
    if (ipRef.current === undefined) {
      ipRef.current = await fetchClientIp();
    }
    try {
      const res = await gasCall('initiateSigningSession', {
        signing_token: signingToken,
        client_ip:     ipRef.current || undefined,
      });
      setSession(res);
      if (res.state === 'COMPLETED' && pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
      return res;
    } catch (e) {
      // Gate incondicional reforzado por el backend: re-pedimos step-up.
      if (isStepUpRequiredError(e)) {
        log.warn('SignSign: initiateSigningSession requires step-up');
        if (pollRef.current) { clearInterval(pollRef.current); pollRef.current = null; }
        setNeedStepUp(true);
        return undefined;
      }
      if (initial) setErr(e.message || t('signing.generic_error'));
      return undefined;
    }
  };

  const startSigning = () => {
    refresh(true);
    if (pollRef.current) clearInterval(pollRef.current);
    pollRef.current = setInterval(() => refresh(false), 5000);
  };

  useEffect(() => {
    // Sólo arrancamos el acto de firma si el step-up está fresco. Si no,
    // esperamos a que el usuario complete StepUpReverify (onVerified → start).
    if (!needStepUp) startSigning();
    return () => { if (pollRef.current) clearInterval(pollRef.current); };
  }, [signingToken]); // eslint-disable-line

  // Gate incondicional: re-verificación antes de poder firmar.
  if (needStepUp) {
    return (
      <div className="kis-card">
        {backNav('top')}
        <h2 style={{ color: 'var(--teal-dk)', fontWeight: 800, fontSize: '1.2rem' }}>{t('signing.signing.title')}</h2>
        <p style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>{t('stepup.sign_gate_body')}</p>
        <StepUpReverify
          tokenPayload={{ signing_token: signingToken }}
          prompt={t('stepup.sign_prompt')}
          onVerified={() => { markStepUpFresh(); setNeedStepUp(false); startSigning(); }}
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

  return (
    <div className="kis-card">
      {backNav('top')}
      <h2 style={{ color: 'var(--teal-dk)', fontWeight: 800, fontSize: '1.2rem' }}>{t('signing.signing.title')}</h2>
      <p style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>{t('signing.signing.subtitle')}</p>

      {session === null && (
        <div style={{ textAlign: 'center', padding: 24, color: 'var(--muted)' }}>
          <span className="spinner-border spinner-border-sm me-2" />{t('signing.saving')}
        </div>
      )}

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
      ) : session !== null && (
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

// ─── Orchestrator ─────────────────────────────────────────────────────────────

export default function SigningSteps({ signingToken, signerCtx }) {
  const { i18n } = useTranslation();
  const lang = lang_(i18n);
  const [sub, setSub] = useState(initialSubStep(signerCtx.steps));

  return (
    <>
      <Progress current={sub} />
      {sub === 0 && <SignBilling signingToken={signingToken} signerCtx={signerCtx} onDone={() => setSub(1)} />}
      {sub === 1 && <SignGdpr signingToken={signingToken} lang={lang} onDone={() => setSub(2)} onBack={() => setSub(0)} />}
      {sub === 2 && <SignReview signingToken={signingToken} onDone={() => setSub(3)} onBack={() => setSub(1)} />}
      {sub === 3 && <SignSign signingToken={signingToken} signerCtx={signerCtx} onBack={() => setSub(2)} onDone={() => { /* terminal — stays on success screen */ }} />}
    </>
  );
}
