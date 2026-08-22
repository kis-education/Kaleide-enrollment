import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useWizard } from '../../context/WizardContext';
import { fetchLookups } from '../../api';
import { translateRelationLabel } from '../../utils/enumLabels';
import LockedBanner from '../../components/LockedBanner';
import StepNav from '../../components/StepNav';
import * as log from '../../logger';

function parseBool(val) {
  if (typeof val === 'boolean') return val;
  // P89 — handle both AppSheet formats: "TRUE"/"FALSE" and "Y"/"N"
  if (typeof val === 'string') { const l = val.toLowerCase(); return l === 'true' || l === 'y' || val === '1'; }
  return Boolean(val);
}

function buildInitialRelations(persons, existingRelations) {
  const guardians  = persons.filter(p => p.person_type_id === 'guardian');
  const applicants = persons.filter(p => p.person_type_id === 'applicant');
  const existing   = existingRelations || [];

  // Guardian → Applicant relations
  const ga = guardians.flatMap(g => {
    const gId = g.person_id || g._uid;
    return applicants.map(a => {
      const aId = a.person_id || a._uid;
      const found = existing.find(
        r => (r.guardian_person_id === gId || r.person_id_a === gId || r.from_person_id === gId) &&
             (r.applicant_person_id === aId || r.person_id_b === aId || r.to_person_id === aId)
      );
      return found
        ? { ...found, _kind: 'ga', is_custodial: parseBool(found.is_custodial), is_pick_up_authorized: parseBool(found.is_pick_up_authorized) }
        // ── LOS DOS EXTREMOS SE LLAMAN person_id_a / person_id_b ─────────────────────
        // Y no es una preferencia de nombres: es el contrato del ÚNICO escritor. El KMS
        // descarta EN SILENCIO todo vínculo que no traiga los dos
        // (`enr_persistRelations_`, `kis-app/…/enr/wizard-gateway.gs:1031`: `if (!r ||
        // !r.person_id_a || !r.person_id_b) return;`) y de ahí salen `from_person_id` /
        // `to_person_id`.
        //
        // Aquí ponía `guardian_person_id` / `applicant_person_id`, así que **ningún
        // vínculo tutor↔hijo creado en esta pantalla llegaba a guardarse jamás** — sin
        // error, sin aviso: la familia veía el paso guardado y con él se perdían la
        // CUSTODIA y la AUTORIZACIÓN DE RECOGIDA. Medido por el robot el 2026-08-04 con
        // el navegador conduciendo el paso: `vinculos.n = 0` en la misma corrida en que
        // `personas.n = 4` salía en verde. Se escribía lo de al lado y esto no.
        //
        // Los nombres de tutor/aplicante nacieron en la LECTURA de vuelta, que los
        // estampa como alias de from/to (`backend/Code.js:3615`) — de ahí se copiaron a
        // la creación, donde no valen. Las parejas hermano↔hermano de más abajo SIEMPRE
        // usaron `person_id_a`/`person_id_b`, y por eso ésas sí se guardaban: la misma
        // pantalla nombraba de dos maneras la misma cosa. Ahora, de una.
        //
        // El ORDEN es parte del dato: `a` es el tutor y `b` el hijo, que es como el
        // escritor los coloca (`from` = a, `to` = b) y como la lectura los devuelve.
        : { _uid: `${gId}__${aId}`, _kind: 'ga', person_id_a: gId, person_id_b: aId, relation_type_id: '', is_custodial: false, is_pick_up_authorized: false };
    });
  });

  // Applicant → Applicant relations (unique pairs)
  const aa = [];
  for (let i = 0; i < applicants.length; i++) {
    for (let j = i + 1; j < applicants.length; j++) {
      const idA = applicants[i].person_id || applicants[i]._uid;
      const idB = applicants[j].person_id || applicants[j]._uid;
      const found = existing.find(
        r => (r.person_id_a === idA && r.person_id_b === idB) ||
             (r.person_id_a === idB && r.person_id_b === idA) ||
             (r.from_person_id === idA && r.to_person_id === idB) ||
             (r.from_person_id === idB && r.to_person_id === idA)
      );
      aa.push(found
        ? { ...found, _kind: 'aa' }
        : { _uid: `${idA}__${idB}`, _kind: 'aa', person_id_a: idA, person_id_b: idB, relation_type_id: '' }
      );
    }
  }

  return [...ga, ...aa];
}

export default function Step3Relations({ onNext, onBack, locked, onUnlock, savePending }) {
  const { t, i18n } = useTranslation();
  const { stepData, updateStep } = useWizard();

  const persons    = stepData.persons || [];
  const guardians  = persons.filter(p => p.person_type_id === 'guardian');
  const applicants = persons.filter(p => p.person_type_id === 'applicant');

  const [relations,     setRelations]     = useState(() => {
    const initial = buildInitialRelations(persons, stepData.relations);
    log.debug('Step3: init relations (buildInitialRelations)', {
      persons_ids: persons.map(p => ({ person_id: p.person_id, _uid: p._uid, type: p.person_type_id })),
      stepData_relations: stepData.relations,
      initial_relations: initial,
    });
    return initial;
  });
  const [relationTypes, setRelationTypes] = useState([]);
  const [highlightEdit, setHighlightEdit] = useState(false);

  useEffect(() => {
    // Idioma en la petición: la caché de catálogos va por idioma (ver `api.js`, 2026-08-19).
    fetchLookups(i18n.language)
      .then(data => {
        log.info('Step3: fetchLookups relationTypes', { count: data.relationTypes?.length, data: JSON.stringify(data.relationTypes) });
        if (data.relationTypes?.length) setRelationTypes(data.relationTypes);
      })
      .catch(err => log.error('Step3: fetchLookups failed', { message: err.message }));
  }, []);

  const updateRelation = (idx, updates) => {
    setRelations(prev => prev.map((r, i) => {
      if (i !== idx) return r;
      const merged = { ...r, ...updates };
      if (updates.is_custodial === true)          merged.is_pick_up_authorized = true;
      if (updates.is_pick_up_authorized === false) merged.is_custodial = false;
      return merged;
    }));
  };

  const handleBack = () => {
    updateStep('relations', relations);
    onBack();
  };

  // Every applicant must have at least one guardian relation with custodial or pick-up
  const uncoveredApplicants = applicants.filter(a => {
    const aId = a.person_id || a._uid;
    return !relations.some(r =>
      r._kind === 'ga' &&
      (r.applicant_person_id === aId || r.person_id_b === aId || r.to_person_id === aId) &&
      (r.is_custodial || r.is_pick_up_authorized)
    );
  });
  // TODO par necesita su tipo, no solo los tutor→hijo (2026-08-04). La asimetría anterior
  // (`r._kind === 'ga'`) dejaba salir el par hermano↔hermano con el tipo VACÍO, y
  // `sysPersonRelations.relation_type_id` es REQUERIDA (Ref) — medido contra AppSheet real:
  // «Can't add or update a row because a required value is missing. Missing value in column:
  // relation_type_id. Expected data type: Ref». El Add reventaba y **se perdía el paso
  // entero, incluidos los cuatro vínculos buenos**.
  // Se pide en vez de inventarlo: el desplegable del par de hermanos ya existe y sus opciones
  // salen del catálogo que sirve el KMS (`relationTypes`), así que aquí no se escribe ni un
  // código de dominio. No enviar el par sería la otra salida, y es peor: perdería en silencio
  // una relación que la familia declaró.
  // `0º.tricies.octies` (D) — SON DOS CASOS Y DEBEN DECIRLO. El aviso rojo era UNO solo y
  // decía «…para todos los TUTORES», pero la condición miraba TODOS los vínculos, incluidos
  // los de hermano↔hermano que añadió el TODO de arriba. Con los dos tutores ya rellenos y el
  // par de hermanos vacío, la familia leía un mensaje que la mandaba a mirar donde no era y
  // se quedaba atascada sin salida (le pasó a Diego, 2026-08-22). Se parte en dos por el
  // `_kind` que la propia pantalla ya usa para agrupar las tarjetas — no se inventa criterio.
  const missingRelationTypeGa = relations.some(r => r._kind === 'ga' && !r.relation_type_id);
  const missingRelationTypeAa = relations.some(r => r._kind === 'aa' && !r.relation_type_id);
  const missingRelationType = missingRelationTypeGa || missingRelationTypeAa;
  const validationOk = uncoveredApplicants.length === 0 && !missingRelationType;

  const handleNext = () => {
    if (relations.length > 0 && !validationOk) return;
    // ── UNA DECLARACIÓN, UNA FILA (DL-S45, decisión de Diego 2026-08-21) ─────────────
    // Aquí se empujaba ADEMÁS la fila INVERTIDA de cada par de hermanos nuevo, con el
    // motivo escrito «so both children can query their siblings». Eso era el modelo de
    // grafo bidireccional que Diego DEROGÓ: *«Ok, pues una sola fila»*. El KMS se
    // convirtió el mismo día —`enr_upsertRelation_` (`kis-app kms-server/enr/staging.gs`)
    // escribe UNA fila y su identidad es la terna `(grupo, a, b)`, así que la invertida
    // caía en OTRA clave y nacía como fila NUEVA—; el asistente NO se convirtió, y nadie
    // lo midió al cerrar aquello. Resultado medido: cada vínculo entre hermanos declarado
    // desde esta pantalla nacía DUPLICADO, y el KMS lo pintaba como «Guardado en dos
    // filas por el modelo anterior» para algo creado ese mismo día.
    //
    // ⛔ NO se reintroduce. Que el vínculo se vea desde LOS DOS hermanos lo resuelve el
    // LECTOR, no una segunda fila: `buildInitialRelations` (arriba) casa el par en los
    // dos sentidos (`a===idA && b===idB` **o** `a===idB && b===idA`, y lo mismo con
    // `from`/`to`), así que una sola fila —guardada en el sentido que sea— rellena la
    // ÚNICA tarjeta que esta pantalla pinta por pareja. Medido antes de retirar el
    // empujón; el camino `vinculo-hermanos-una-sola-fila` de la batería lo afirma.
    //
    // Strip _kind (UI-only) before saving so baseline comparison stays stable.
    const relationsToSave = [];
    relations.forEach(r => {
      // eslint-disable-next-line no-unused-vars
      const { _kind, _RowNumber, ...rClean } = r;
      relationsToSave.push(rClean);
    });
    updateStep('relations', relations);
    // Sort by relation_id so the order matches the baseline seeded in hydrateFromResume
    // (also sorted by relation_id). AppSheet API response order is arbitrary and differs
    // from buildInitialRelations order (guardians × applicants), causing false-positive
    // dirty saves on every resume.
    relationsToSave.sort((a, b) => (a.relation_id || '').localeCompare(b.relation_id || ''));
    log.info('Step3: onNext relations (relationsToSave)', relationsToSave);
    onNext('relations', relationsToSave);
  };

  if (!guardians.length || !applicants.length) {
    return (
      <>
        <div className="mb-2">
          <h2 style={{ color: 'var(--teal-dk)', fontWeight: 800 }}>{t('step.relations')}</h2>
        </div>
        <StepNav position="top" onBack={handleBack} onNext={handleNext} savePending={savePending} />
        <div className="kis-card">
          <p style={{ color: 'var(--muted)' }}>{t('step4.no_applicants')}</p>
        </div>
        <div className="d-flex justify-content-between mt-4">
          <button className="btn-secondary-kis" onClick={handleBack}>
            <i className="bi bi-arrow-left me-1" /> {t('nav.back')}
          </button>
          {/* WPERF-1 (criterios 1+2): no se bloquea ni muestra "Guardando…" por save en vuelo. */}
          <button className="btn-primary-kis" onClick={handleNext}>
            {t('nav.continue')} <i className="bi bi-arrow-right ms-1" />
          </button>
        </div>
      </>
    );
  }

  const gaRelations = relations.filter(r => r._kind === 'ga');
  const aaRelations = relations.filter(r => r._kind === 'aa');

  return (
    <>
      <div className="mb-2">
        <h2 style={{ color: 'var(--teal-dk)', fontWeight: 800 }}>{t('step.relations')}</h2>
        <p style={{ color: 'var(--muted)' }}>{t('step3.subtitle')}</p>
      </div>

      <StepNav position="top" onBack={handleBack} onNext={handleNext} savePending={savePending}
        nextDisabled={!locked && relations.length > 0 && !validationOk} />

      {locked && <LockedBanner onUnlock={onUnlock} highlight={highlightEdit} />}

      {!locked && uncoveredApplicants.length > 0 && (
        <div className="field-error mb-3">
          <i className="bi bi-exclamation-triangle-fill me-2" />
          {uncoveredApplicants.map(a => [a.first_name, a.last_name].filter(Boolean).join(' ') || t('applicant.unnamed')).join(', ')}
          {': '}{t('error.custodial_required')}
        </div>
      )}
      {!locked && missingRelationTypeGa && (
        <div className="field-error mb-3">
          <i className="bi bi-exclamation-triangle-fill me-2" />
          {t('error.relation_type_required')}
        </div>
      )}
      {!locked && missingRelationTypeAa && (
        <div className="field-error mb-3">
          <i className="bi bi-exclamation-triangle-fill me-2" />
          {t('error.relation_type_required_siblings')}
        </div>
      )}

      <div onClick={locked ? () => { setHighlightEdit(true); setTimeout(() => setHighlightEdit(false), 600); } : undefined}>
      <fieldset disabled={locked} style={{ border: 'none', padding: 0, margin: 0, pointerEvents: locked ? 'none' : undefined }}>

        {/* Guardian → Applicant */}
        {gaRelations.map((rel, relIdx) => {
          const idx = relations.indexOf(rel);
          // LOS TRES NOMBRES, o la tarjeta no se pinta (2026-08-04). `resumeSession_` estampa
          // el alias `guardian_person_id` (backend/Code.js:3615) pero `hydrateSession_` —que
          // es el camino VIVO— NO lo hace: sus filas traen `from_person_id`/`to_person_id` a
          // secas. Sin este tercer nombre, `find` no encontraba a nadie y el `return null` de
          // abajo **se comía todas las tarjetas tutor→hijo**: una familia que vuelve a su
          // solicitud veía el paso sin tarjetas, sin sus casillas de custodia y sin salida
          // (medido: 4 vínculos hidratados → 1 desplegable y 0 casillas en pantalla).
          const g = persons.find(p => (p.person_id || p._uid) === (rel.person_id_a || rel.guardian_person_id || rel.from_person_id));
          const a = persons.find(p => (p.person_id || p._uid) === (rel.person_id_b || rel.applicant_person_id || rel.to_person_id));
          if (!g || !a) return null;
          const gName = [g.first_name, g.last_name].filter(Boolean).join(' ') || t('guardian.title', { n: relIdx + 1 });
          const aName = [a.first_name, a.last_name].filter(Boolean).join(' ') || t('applicant.title', { n: relIdx + 1 });
          return (
            <div key={rel._uid || relIdx} className="kis-card mb-3">
              <div className="d-flex align-items-center gap-2 flex-wrap">
                <strong style={{ color: 'var(--teal-dk)' }}>{gName}</strong>
                <span style={{ color: 'var(--muted)' }}>{t('relation.is_of')}</span>
                <select
                  className="form-select form-select-sm"
                  style={{ width: 'auto', minWidth: 170 }}
                  value={rel.relation_type_id}
                  onChange={e => updateRelation(idx, { relation_type_id: e.target.value })}
                >
                  <option value="">{t('relation.none')}</option>
                  {relationTypes.filter(rt => rt.id).map(rt => (
                    <option key={rt.id} value={rt.id}>{translateRelationLabel(rt.label, t) || rt.id}</option>
                  ))}
                </select>
                <span style={{ color: 'var(--muted)' }}>{t('relation.of')}</span>
                <strong style={{ color: 'var(--teal-dk)' }}>{aName}</strong>
              </div>
              <div className="d-flex gap-4 mt-3">
                <div className="form-check mb-0">
                  <input type="checkbox" className="form-check-input"
                    id={`custodial_${idx}`}
                    checked={rel.is_custodial}
                    onChange={e => updateRelation(idx, { is_custodial: e.target.checked })} />
                  <label className="form-check-label small" htmlFor={`custodial_${idx}`}>
                    {t('relation.is_custodial')}
                  </label>
                </div>
                <div className="form-check mb-0">
                  <input type="checkbox" className="form-check-input"
                    id={`pickup_${idx}`}
                    checked={rel.is_pick_up_authorized}
                    onChange={e => updateRelation(idx, { is_pick_up_authorized: e.target.checked })} />
                  <label className="form-check-label small" htmlFor={`pickup_${idx}`}>
                    {t('relation.is_pickup')}
                  </label>
                </div>
              </div>
            </div>
          );
        })}

        {/* Applicant → Applicant */}
        {aaRelations.length > 0 && (
          <>
            <h6 className="mt-2 mb-2" style={{ color: 'var(--muted)' }}>{t('relation.between_applicants')}</h6>
            {aaRelations.map((rel, relIdx) => {
              const idx = relations.indexOf(rel);
              const pA = persons.find(p => (p.person_id || p._uid) === (rel.person_id_a || rel.from_person_id));
              const pB = persons.find(p => (p.person_id || p._uid) === (rel.person_id_b || rel.to_person_id));
              if (!pA || !pB) return null;
              const nameA = [pA.first_name, pA.last_name].filter(Boolean).join(' ') || t('applicant.unnamed');
              const nameB = [pB.first_name, pB.last_name].filter(Boolean).join(' ') || t('applicant.unnamed');
              return (
                <div key={rel._uid || relIdx} className="kis-card mb-3">
                  <div className="d-flex align-items-center gap-2 flex-wrap">
                    <strong style={{ color: 'var(--teal-dk)' }}>{nameA}</strong>
                    <span style={{ color: 'var(--muted)' }}>{t('relation.is_of')}</span>
                    <select
                      className="form-select form-select-sm"
                      style={{ width: 'auto', minWidth: 170 }}
                      value={rel.relation_type_id}
                      onChange={e => updateRelation(idx, { relation_type_id: e.target.value })}
                    >
                      <option value="">{t('relation.none')}</option>
                      {relationTypes.filter(rt => rt.id).map(rt => (
                        <option key={rt.id} value={rt.id}>{translateRelationLabel(rt.label, t) || rt.id}</option>
                      ))}
                    </select>
                    <span style={{ color: 'var(--muted)' }}>{t('relation.of')}</span>
                    <strong style={{ color: 'var(--teal-dk)' }}>{nameB}</strong>
                  </div>
                </div>
              );
            })}
          </>
        )}

      </fieldset>
      </div>

      <div className="d-flex justify-content-between mt-4">
        <button className="btn-secondary-kis" onClick={handleBack}>
          <i className="bi bi-arrow-left me-1" /> {t('nav.back')}
        </button>
        {/* WPERF-1 (criterios 1+2): no se bloquea por save en vuelo; solo gatea por validación. */}
        <button
          className="btn-primary-kis"
          onClick={handleNext}
          disabled={!locked && relations.length > 0 && !validationOk}
        >
          {t('nav.continue')} <i className="bi bi-arrow-right ms-1" />
        </button>
      </div>
    </>
  );
}
