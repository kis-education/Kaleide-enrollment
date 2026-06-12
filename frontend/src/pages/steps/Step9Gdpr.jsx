import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { gasCall } from '../../api';
import { useWizard } from '../../context/WizardContext';
import StepShell from '../../components/StepShell';
import { SIGNING_CONSENTS, SIGNING_CONSENT_TEXT_VERSION } from '../../signingConsentTexts';
import { signingIdentity_, isStepUpRequiredError, lang_ } from './signingCommon';
import { stepLabelKey } from './catalog'; // #11: el nombre del paso sale del catálogo
import * as log from '../../logger';

/**
 * Step 9 — S-GDPR (consentimientos RGPD por guardian, matriz tutor×sujeto).
 *
 * REBUILD-8-11 (Diego 2026-06-11): paso REAL, ciudadano idéntico a los 1-7 — chasis
 * StepShell, guardado OPTIMISTA por la MISMA cola (enqueueSave → nube global), estado
 * del formulario en WizardContext (signingForms.gdpr — sobrevive a 9↔8/9↔10 en
 * memoria; se descarta si cambia SIGNING_CONSENT_TEXT_VERSION → re-consentir). El
 * payload de submitGdprConsents está COPIADO VERBATIM del SignGdpr probado (antiguo
 * pages/signing/* (monolito del antiguo host /sign), eliminado en este cambio), incluida la conversión
 * de `res.blocked` en rechazo de la promesa (nube 'error' + Reintentar).
 *
 * CLI 9 (DL-E42 §3): matriz tutor×sujeto. El guardian actual (derivado del token,
 * server-side) consiente:
 *  - GENERAL (GDPR_SCHOOL blocking + comms + platform groups): per-guardian, sujeto = él.
 *  - DERECHOS DE IMAGEN (4 usos): por CADA sujeto ∈ {participantes del grupo} ∪ {él
 *    mismo}. NUNCA por el otro tutor adulto. El otorgante NO viaja en el payload — el
 *    KMS lo deriva del token (KAL-4).
 */
export default function Step9Gdpr({ onAdvance, onBack, signingToken, resumeToken, signerCtx, locked, onUnlock }) {
  const { t, i18n } = useTranslation();
  const {
    enqueueSave, stepData, recoveredEmail, recoveryNonce,
    signingForms, updateSigningForm,
  } = useWizard();
  // MAPEO CENTRAL (Diego 2026-06-12): el candado viene de getStepEditMode via
  // props locked/onUnlock — este paso no computa su propio lock.
  const lang = lang_(i18n);

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

  // ── Estado del formulario — EN EL CONTEXTO (REBUILD-8-11) ─────────────────────
  // signingForms.gdpr = { gen, img, v }. Sustituye el sessionStorage del componente
  // antiguo: las marcas viven en memoria del contexto (sobreviven a desmontar el paso,
  // que era el objetivo; KAL-7: nada se persiste fuera de memoria). Si la versión del
  // texto legal cambió (v ≠ SIGNING_CONSENT_TEXT_VERSION), se descarta y se re-consiente.
  const form = (signingForms.gdpr && signingForms.gdpr.v === SIGNING_CONSENT_TEXT_VERSION)
    ? signingForms.gdpr : null;
  const genState = (form && form.gen) || {};
  const imgState = (form && form.img) || {};
  const [err, setErr] = useState('');

  useEffect(() => {
    const countTrue = (o) => Object.values(o || {}).filter(Boolean).length;
    log.info('[DBG gdpr] mount', {
      has_form: !!form,
      has_signerCtx: !!signerCtx,
      n_imageSubjects:   imageSubjects.length,
      restored_gen_true: countTrue(genState),
      restored_img_true: Object.values(imgState || {}).reduce((n, o) => n + countTrue(o), 0),
    });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Toggles → contexto (el valor del usuario manda toda la sesión).
  const writeForm = (gen, img) => updateSigningForm('gdpr', { gen, img, v: SIGNING_CONSENT_TEXT_VERSION });
  const toggleGen = (code) => writeForm({ ...genState, [code]: !genState[code] }, imgState);
  const toggleImg = (subjectId, code) => writeForm(genState, {
    ...imgState,
    [subjectId]: { ...(imgState[subjectId] || {}), [code]: !(imgState[subjectId] && imgState[subjectId][code]) },
  });

  // Avance OPTIMISTA uniforme con los pasos 1-7: (1) gate de validación LOCAL
  // (consentimiento bloqueante); (2) payload VERBATIM construido ANTES de encolar;
  // (3) enqueueSave SIN await previo → nube global; (4) avance inmediato.
  const submit = () => {
    if (locked) { onAdvance(); return; } // solo lectura: avanza sin guardar
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
    // VERBATIM (CLI 9): el otorgante NO viaja (server-side del token). Sujeto SÍ:
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
    // Factory encolada. `res.blocked` (rechazo de consentimiento bloqueante
    // server-side) se convierte en rechazo de la promesa → misma vía de surfacing
    // (nube 'error' + Reintentar). El payload se construye ANTES de encolar
    // (cierra sobre las marcas actuales, re-ejecutable). KAL-4/KAL-7 intactos.
    const payload = { ...signingIdentity_({ resumeToken, signingToken, n: recoveryNonce, recoveredEmail }), consents };
    enqueueSave(() => gasCall('submitGdprConsents', payload)
      .then(res => {
        if (res && res.blocked) {
          const blockErr = new Error('GDPR_BLOCKED');
          blockErr.gdprBlocked = true;
          throw blockErr;
        }
        // Baseline tras save OK (espejo de markStepSaved).
        updateSigningForm('gdpr', f => ({ ...(f || {}), baseline: { gen: genState, img: imgState } }));
        return res;
      })
      .catch(e => {
        // STEPUP_REQUIRED dentro de la cola: no se reintenta a ciegas — propaga a la nube.
        if (isStepUpRequiredError(e)) log.warn('Step9Gdpr: submitGdprConsents requires step-up (queued)');
        else log.error('Step9Gdpr: submitGdprConsents failed (background)', { message: e.message });
        throw e;
      }));
    onAdvance(); // avance optimista inmediato
  };

  return (
    <div className="kis-card">
      <StepShell
        title={t(stepLabelKey('s_gdpr'))}
        subtitle={t('signing.gdpr.subtitle')}
        onBack={onBack}
        onNext={submit}
        nextLabel={locked ? undefined : t('signing.gdpr.submit')}
        locked={locked}
        onUnlock={onUnlock}
        error={err}
      >
        {/* Consentimientos GENERALES (per-guardian: GDPR + comms + plataforma) */}
        {generalConsents.map(c => (
          <div key={c.code} className="consent-block" style={{ borderBottom: '1px solid var(--bg)', paddingBottom: 12, marginBottom: 12 }}>
            <p style={{ fontSize: '0.86rem', color: 'var(--text)', marginBottom: 8 }}>{c.text[lang]}</p>
            <div className="form-check">
              <input type="checkbox" className="form-check-input" id={'consent_' + c.code}
                checked={!!genState[c.code]} onChange={() => toggleGen(c.code)} />
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
