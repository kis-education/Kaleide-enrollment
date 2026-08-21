import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useWizard } from '../../context/WizardContext';
import { gasCall, fetchLookups, identidadDelEnlace } from '../../api';
import { openDocument } from '../../utils/documentProxy';
import LockedBanner from '../../components/LockedBanner';
import StepNav from '../../components/StepNav';
import StepUpReverify from '../../components/StepUpReverify';
import * as log from '../../logger';
import { confirmarYQuitar } from '../../lib/quitar';

// WIZARD-DOCS (2026-06-13): adjuntador GENÉRICO opcional.
// Diego: "Hay una serie de casos tasados para subir archivos (DNI, etc.) pero no
// es necesario. Lo que haría falta es la posibilidad de subir archivos, NO
// obligatorio, y que el usuario decida qué archivo es: un adjuntador genérico,
// donde el usuario describe en una casilla qué tipo de archivo es."
// → Eliminamos la rejilla fija DOCUMENT_TYPES. El usuario añade N adjuntos; cada
//   uno = un archivo + una casilla de texto libre. Cero archivos es válido (no
//   obligatorio). El backend guarda la descripción en recFiles.description.
// ★ CORRECCIÓN 2026-08-04: esta nota decía «con un rec_type_code genérico ('OTHER')»
//   y ESO ERA EL DEFECTO, no el diseño. `'OTHER'` no existe en el catálogo del tenant:
//   el servidor rechazaba TODA subida de familia con [INVALID_REC_TYPE] mientras la
//   pantalla dejaba adjuntar y avanzar. El tipo lo pone el CATÁLOGO del centro, resuelto
//   por el KMS (DL-R16). Ver el bloque «EL TIPO DE DOCUMENTO LO PONE EL CATÁLOGO» en
//   `backend/Code.js`.
// ★ 18.bis.35 (2026-08-16): DESCRIBIR NO ES CLASIFICAR — la casilla de texto libre no le
//   asigna al papel su nivel de confidencialidad ni sus etiquetas, que es lo único que
//   decide quién puede verlo (DL-R07). Por eso este adjuntador pregunta ADEMÁS qué es cada
//   archivo, con las opciones que manda el propio KMS. Sigue sin haber tipos tasados ni
//   códigos escritos aquí: se ofrece lo que el colegio haya marcado como «lo aporta la
//   familia», y solo a partir del SEGUNDO (con uno, lo asigna el servidor).
//
// WIZARD-DOCS2 (2026-06-13): patrón "añadir ítem" como en Step2Persons (tutores/
// alumnos). Estado inicial = CERO paneles: solo el botón "Añadir archivo". Cada
// pulsación abre UN panel (descripción + selector). NO se auto-añade fila vacía
// tras subir; para otro archivo hay que volver a pulsar "Añadir archivo". Cada
// panel se puede quitar; quitar el último deja CERO paneles (sigue siendo
// opcional). Las subidas existentes (hidratación) se muestran como paneles ya
// completados.

// 18.bis.95 — LO QUE SE LE DICE A LA FAMILIA CUANDO LA FICHA DEL DOCUMENTO NO QUEDÓ ESCRITA.
// Los códigos los emite `_veredictoDeLaSubida_` (`backend/Code.js`), que es también quien
// decide que son DOS casos distintos y no uno. Esta tabla NO es la lista de
// `lib/rechazos.js`: aquélla gobierna si la COLA DE GUARDADO reintenta sola, y la subida de
// documentos no pasa por esa cola (`gasCall` directo, aquí abajo) ⇒ declarar estos códigos
// allí sería declararlos donde nadie pregunta. Medido el 2026-08-10.
const TEXTO_DE_SUBIDA_FALLIDA = {
  DOCUMENTO_NO_REGISTRADO: 'doc.upload_failed.not_registered',
  DOCUMENTO_SIN_VINCULAR:  'doc.upload_failed.not_linked',
  DOCUMENTO_SIN_DUENO:     'doc.upload_failed.no_owner',
};

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

let _rowSeq = 0;
const newRowId = () => `doc_row_${++_rowSeq}_${Date.now()}`;

/**
 * Una fila del adjuntador genérico: descripción (texto libre) + archivo.
 * Sube vía gasCall('uploadDocument', { description, … }) al seleccionar el archivo.
 */
function GenericAttachment({ row, personas, tiposDeDocumento, enrollmentGroupId, resumeToken, identidad, onUploaded, onDescriptionChange, onDuenoChange, onTipoChange, onRemove, onStepUpVerified, onActivity, onUploadStart, onUploadEnd }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState(row.file_id ? 'success' : '');
  const [fileId, setFileId] = useState(row.file_id || '');
  const [err,    setErr]    = useState('');
  const [viewing, setViewing] = useState(false);
  const [stepUpRetry, setStepUpRetry] = useState(null); // null | () => void

  const isStepUpError = (e) => e?.code === 'STEPUP_REQUIRED' || /STEPUP_REQUIRED/.test(e?.message || '');

  // 18.bis.35 — SOLO SE PREGUNTA A PARTIR DEL SEGUNDO TIPO, y no es una decisión de estilo:
  // el catálogo del centro es quien manda (DL-R16). Con NINGUNO marcado «lo aporta la familia»
  // no hay nada que ofrecer; con UNO, el servidor lo asigna él («un desplegable de una opción
  // no es elección», DL-R16 literal) y preguntarlo sería teatro. Con dos o más, elige la
  // familia — y entonces su respuesta es OBLIGATORIA: sin ella el KMS rechaza la subida.
  const tipos    = Array.isArray(tiposDeDocumento) ? tiposDeDocumento : [];
  const eligeTipo = tipos.length >= 2;

  // 0º.sexdecies — UNA VEZ SUBIDO, la familia no podía comprobar qué tipo declaró ni de quién
  // dijo que era: los dos desplegables se ocultan al confirmar la subida (a propósito — un
  // archivo ya subido tiene su respuesta escrita en el servidor, no en este formulario), y
  // hasta ahora no quedaba NADA en su lugar. El servidor SIEMPRE guardó las dos cosas
  // (DL-R16/DL-R17); esto solo las ENSEÑA de vuelta, en un texto de solo lectura.
  const tipoLabel = (code) => {
    if (!code) return '';
    const encontrado = tipos.find(tp => tp.code === code);
    return encontrado ? (encontrado.designation || encontrado.code) : code;
  };
  // `ownerIds` vacío es AMBIGUO tras el recorte de privacidad del servidor (DL-E49): puede ser
  // «de la solicitud» de verdad, o un documento del OTRO tutor cuyo identificador el servidor
  // ya no manda. Ante la duda se dice «de la solicitud» — nunca se arriesga a delatar al otro
  // tutor, y es la MISMA regla que ya sigue el resto del asistente ante ese recorte.
  const duenoLabel = (ownerIds) => {
    if (!Array.isArray(ownerIds) || !ownerIds.length) return t('doc.owner_application');
    const nombres = ownerIds
      .map(pid => (personas.find(p => p.person_id === pid) || {}).etiqueta)
      .filter(Boolean);
    return nombres.length ? nombres.join(', ') : t('doc.owner_application');
  };

  const doUpload = async (file) => {
    setStatus('uploading');
    setErr('');
    // 0º.quindecies (segunda pieza) — le dice al pulso que hay una subida en vuelo, para que
    // no le pida a la puerta del expediente la misma pregunta que ya está pagando esta subida.
    // Nunca toca el guardado de pasos ni ninguna comprobación de seguridad — solo evita que el
    // pulso se dispare en paralelo.
    if (onUploadStart) onUploadStart();
    try {
      const base64 = await fileToBase64(file);
      const data   = await gasCall('uploadDocument', {
        resume_token:        resumeToken, // KAL-4: required for IDOR defense
        enrollment_group_id: enrollmentGroupId,
        application_id:      enrollmentGroupId, // legacy alias
        base64,
        mimeType:    file.type,
        filename:    file.name,
        // WIZARD-DOCS: el usuario describe qué es el archivo (texto libre, opcional).
        description: (row.description || '').trim(),
        // 18.bis.35 · DL-R16 — QUÉ ES el archivo. Describir no es clasificar: la casilla de
        // arriba es texto libre y no le asigna al papel ni su nivel de confidencialidad ni sus
        // etiquetas. Se manda lo que la familia ELIGIÓ, tal cual, y solo si eligió: con 0 ó 1
        // tipo en el catálogo no se pregunta y lo resuelve el servidor. Aquí no se decide
        // nada — el navegador no clasifica documentos.
        ...(row.rec_type_code ? { rec_type_code: row.rec_type_code } : {}),
        // DL-R17 — DE QUIÉN es el documento. Se manda lo que la familia CONTESTÓ, tal cual:
        // «de la solicitud» viaja como respuesta EXPLÍCITA (`SOLICITUD`), no como la ausencia
        // de las dos. Si no contestó, no se manda nada y la regla de reparto por defecto —que
        // vive en el SERVIDOR, `_duenosDelDocumento_`— se lo asigna al tutor que lo sube. Aquí
        // no se decide nada: el navegador no reparte documentos.
        ...(row.dueno === 'SOLICITUD' ? { de_quien: 'SOLICITUD' }
           : row.dueno               ? { person_ids: [row.dueno] }
           : {}),
        // ②24 — quién está operando: el servidor exige el código de un solo uso y la
        // marca es DEL BUZÓN que se verificó, no del expediente entero.
        ...identidadDelEnlace(identidad),
      });
      setFileId(data.file_id);
      setStatus('success');
      // 0º.sexdecies — solo se pinta `owner_person_ids` cuando la familia CONTESTÓ (SOLICITUD
      // o una persona): sin respuesta, el servidor reparte al tutor que sube (DL-R17) y este
      // formulario no sabe a cuál — enseñar «de la solicitud» ahí sería INVENTAR la respuesta.
      // La fila se queda sin el campo hasta la próxima hidratación, que trae el reparto real.
      const duenoElegido =
        row.dueno === 'SOLICITUD' ? [] : row.dueno ? [row.dueno] : undefined;
      onUploaded(row.id, {
        file_id: data.file_id, file_name: file.name, description: (row.description || '').trim(),
        ...(duenoElegido !== undefined ? { owner_person_ids: duenoElegido } : {}),
      });
    } catch (e) {
      if (isStepUpError(e)) {
        log.warn('Step6: uploadDocument requires step-up');
        setStatus('');
        setStepUpRetry(() => () => doUpload(file));
        return;
      }
      log.error('Step6: uploadDocument failed', { message: e.message, code: e?.code });
      setStatus('error');
      // 18.bis.95 — cuando el servidor dice que la ficha del documento NO quedó escrita, se
      // explica en el idioma de la familia y se dice qué hacer, que NO es lo mismo en los dos
      // casos: si no consta en ninguna parte, volver a subirlo; si consta pero no quedó
      // enganchado al alumno, reintentar duplicaría, así que se pide avisar al colegio. El
      // resto de fallos se comporta byte-idéntico (mensaje del servidor tal cual).
      setErr(TEXTO_DE_SUBIDA_FALLIDA[e?.code] ? t(TEXTO_DE_SUBIDA_FALLIDA[e.code]) : e.message);
    } finally {
      if (onUploadEnd) onUploadEnd();
    }
  };

  const handleFile = (file) => {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { setErr(t('error.file_too_large')); return; }
    // 18.bis.35 — SE PREGUNTA DONDE LA FAMILIA PUEDE CONTESTAR. Cuando hay dos o más tipos,
    // el KMS RECHAZA la subida que no dice cuál (`REC_TYPE_REQUIRED`), así que dispararla sin
    // respuesta es mandar megabytes a un rechazo seguro y devolverle un mensaje lleno de
    // códigos internos. El servidor sigue siendo el suelo; esto solo evita el viaje inútil.
    // Mismo criterio (y misma función) que el tope de tamaño de la línea de arriba.
    if (eligeTipo && !row.rec_type_code) { setErr(t('doc.type_required')); return; }
    doUpload(file);
  };

  const handleView = async () => {
    if (!fileId || viewing) return;
    setViewing(true);
    try {
      await openDocument({ file_id: fileId, resume_token: resumeToken, ...identidadDelEnlace(identidad) }); // ②24
    } catch (e) {
      if (isStepUpError(e)) {
        log.warn('Step6: getDocument requires step-up');
        setStepUpRetry(() => () => handleView());
        return;
      }
      log.error('Step6: getDocument failed', { message: e.message });
      setErr(e.message);
    } finally {
      setViewing(false);
    }
  };

  const inputId = `file_${row.id}`;

  return (
    <div className="mb-4 doc-attachment" style={{ borderBottom: '1px solid var(--bg)', paddingBottom: 16 }}>
      <div className="d-flex justify-content-between align-items-start mb-2">
        <label className="form-label fw-semibold mb-0">{t('doc.describe_label')}</label>
        <button
          type="button"
          className="btn btn-link p-0 text-danger"
          style={{ fontSize: '0.85rem' }}
          onClick={() => onRemove(row.id)}
        >
          <i className="bi bi-x-circle me-1" />{t('doc.remove')}
        </button>
      </div>

      <input
        type="text"
        className="form-control mb-2"
        maxLength={200}
        placeholder={t('doc.describe_placeholder')}
        value={row.description || ''}
        onChange={e => onDescriptionChange(row.id, e.target.value)}
        disabled={status === 'success'}
      />

      {/* 18.bis.35 · DL-R16 — QUÉ ES ESTE ARCHIVO. La casilla de arriba es texto libre y sirve
          para que la familia se entienda con el colegio; NO clasifica: no le asigna al papel su
          nivel de confidencialidad ni sus etiquetas, que es lo único que decide quién puede
          verlo (DL-R07). Eso lo hace el TIPO, y por eso se pregunta aparte.
          Las opciones salen del catálogo del centro, tal y como las manda el KMS en las listas
          (`recTypesInterestedParty`) — aquí no hay ni un código escrito a mano.
          NINGUNA viene preseleccionada: elegir por la familia sería inventar la respuesta.
          Solo mientras se elige el archivo, por lo mismo que el desplegable de abajo: un archivo
          YA subido tiene su tipo escrito en el servidor y la hidratación no lo devuelve. */}
      {status !== 'success' && eligeTipo && (
        <>
          <label className="form-label fw-semibold mb-1" htmlFor={`tipo_${row.id}`}>
            {t('doc.type_label')}
          </label>
          <select
            id={`tipo_${row.id}`}
            className="form-select mb-1 doc-type"
            value={row.rec_type_code || ''}
            onChange={e => onTipoChange(row.id, e.target.value)}
          >
            <option value="">{t('doc.type_unset')}</option>
            {tipos.map(tp => (
              <option key={tp.code} value={tp.code}>{tp.designation || tp.code}</option>
            ))}
          </select>
          <p className="mb-2" style={{ color: 'var(--muted)', fontSize: '0.82rem' }}>
            {t('doc.type_hint')}
          </p>
        </>
      )}

      {/* DL-R17 — DE QUIÉN ES ESTE ARCHIVO. Con el archivo por fecha, esta respuesta es el
          único sitio donde consta a quién pertenece el papel: sin ella el fichero existe y
          no significa nada. Las personas que se ofrecen son las que la familia YA declaró en
          el paso 2 — no se teclean, se eligen.
          NINGUNA opción viene preseleccionada: elegir por la familia sería inventar la
          respuesta. Si no contesta, lo reparte el SERVIDOR (al tutor que lo sube), y el texto
          de abajo lo dice para que no sea una sorpresa. */}
      {/* Solo mientras se elige el archivo. Un archivo YA subido tiene su respuesta escrita en
          el servidor y la hidratación no la devuelve: enseñar aquí un desplegable vacío diría
          «no contestaste», que es falso. */}
      {status !== 'success' && (
        <>
          <label className="form-label fw-semibold mb-1" htmlFor={`dueno_${row.id}`}>
            {t('doc.owner_label')}
          </label>
          <select
            id={`dueno_${row.id}`}
            className="form-select mb-1 doc-owner"
            value={row.dueno || ''}
            onChange={e => onDuenoChange(row.id, e.target.value)}
          >
            <option value="">{t('doc.owner_unset')}</option>
            <option value="SOLICITUD">{t('doc.owner_application')}</option>
            {personas.map(p => (
              <option key={p.person_id} value={p.person_id}>{p.etiqueta}</option>
            ))}
          </select>
          <p className="mb-2" style={{ color: 'var(--muted)', fontSize: '0.82rem' }}>
            {t('doc.owner_hint')}
          </p>
        </>
      )}

      {status !== 'success' && (
        <div
          className="upload-zone"
          onDragOver={e => e.preventDefault()}
          onDrop={e => { e.preventDefault(); onActivity && onActivity(); handleFile(e.dataTransfer.files[0]); }}
          onClick={() => { onActivity && onActivity(); document.getElementById(inputId).click(); }}
        >
          <i className="bi bi-cloud-arrow-up" style={{ fontSize: '1.5rem', color: 'var(--teal)' }} />
          <p style={{ margin: '6px 0 0', color: 'var(--muted)', fontSize: '0.88rem' }}>
            {t('doc.drag_or_click')}
          </p>
          <input
            id={inputId}
            type="file"
            accept=".pdf,.jpg,.jpeg,.png"
            style={{ display: 'none' }}
            onChange={e => handleFile(e.target.files[0])}
          />
        </div>
      )}

      {status === 'uploading' && (
        <div className="upload-status" style={{ background: 'var(--teal-lt)', color: 'var(--teal-dk)' }}>
          <span className="spinner-border spinner-border-sm me-2" />{t('doc.uploading')}
        </div>
      )}
      {status === 'success' && (
        <div className="upload-status success">
          <i className="bi bi-check-circle me-1" />
          {t('doc.uploaded')}
          {/* EL NOMBRE DEL ARCHIVO, porque la descripción es OPCIONAL (2026-08-09).
              La casilla de arriba queda deshabilitada en cuanto el archivo está subido; si
              la familia no escribió nada —que es lo normal, el adjuntador no lo exige— el
              panel entero decía solo «Subido · Ver archivo». Tres archivos así son tres
              cajas idénticas y vacías: ESTÁN, pero no hay forma de saber cuál es cuál, que
              es lo mismo que no verlos. El nombre es dato de la propia subida, no una
              etiqueta nueva, así que no hay texto que traducir ni que pueda quedar obsoleto. */}
          {row.file_name && <> — <strong>{row.file_name}</strong></>}
          &nbsp;
          {fileId && (
            <button
              type="button"
              className="btn btn-link p-0"
              style={{ fontSize: 'inherit', verticalAlign: 'baseline' }}
              onClick={handleView}
              disabled={viewing}
            >
              {viewing
                ? <><span className="spinner-border spinner-border-sm me-1" style={{ width: '0.8em', height: '0.8em' }} />{t('doc.view')}</>
                : t('doc.view')}
            </button>
          )}
          {/* 0º.sexdecies — el tipo y el dueño YA se guardaron al subir (DL-R16/DL-R17); esto
              solo los enseña de vuelta, en texto — no vuelve a ser un formulario. Sin tipo
              resuelto (subida antigua, o el catálogo no dio ninguno) no se pinta esa línea. */}
          {row.rec_type_code && (
            <p className="mb-0 mt-1" style={{ color: 'var(--muted)', fontSize: '0.82rem' }}>
              {t('doc.type_summary', { tipo: tipoLabel(row.rec_type_code) })}
            </p>
          )}
          {row.owner_person_ids !== undefined && (
            <p className="mb-0" style={{ color: 'var(--muted)', fontSize: '0.82rem' }}>
              {t('doc.owner_summary', { duenio: duenoLabel(row.owner_person_ids) })}
            </p>
          )}
        </div>
      )}
      {status === 'error' && (
        <div className="upload-status error">
          <i className="bi bi-exclamation-circle me-1" />{err}
        </div>
      )}

      {/* DL-E39: la acción (subir/ver) devolvió STEPUP_REQUIRED → re-verificar y
          reintentar automáticamente la acción pendiente. */}
      {stepUpRetry && (
        <StepUpReverify
          // ②24 — el código va al buzón del tutor que opera, no siempre al del tutor 1.
          tokenPayload={{ resume_token: resumeToken, ...identidadDelEnlace(identidad) }}
          prompt={t('stepup.doc_reveal_prompt')}
          onVerified={() => {
            onStepUpVerified && onStepUpVerified();
            const retry = stepUpRetry;
            setStepUpRetry(null);
            retry();
          }}
        />
      )}
    </div>
  );
}

export default function Step6Documents({ onNext, onBack, locked, onUnlock, savePending }) {
  const { t, i18n }  = useTranslation();
  const {
    enrollmentGroupId, resumeToken, stepData, updateStep,
    markStepUpFresh, touchActivity,
    recoveryNonce, recoveredEmail,   // ②24 — quién está operando (identidad del enlace)
    beginUpload, endUpload,          // 0º.quindecies — el pulso se aparta mientras sube un documento
  } = useWizard();
  const identidad = { n: recoveryNonce, recoveredEmail };

  // DL-R17 — LAS PERSONAS QUE SE OFRECEN SON LAS QUE LA FAMILIA YA DECLARÓ, y se leen del
  // mismo sitio del que las lee el resto del asistente (`stepData.persons`). NO se teclean.
  //
  // El papel de cada una se LEE de su tipo declarado (`person_type_id`), NUNCA se deduce por
  // resta ni por exclusión (DL-E48): «tutor = el que no es alumno» produce basura en cuanto un
  // dominio no tiene tutores. Y las que la familia ya QUITÓ de la solicitud no se ofrecen —
  // mismo criterio que el servidor, que las descarta en todas partes.
  const personasDelDocumento = (() => {
    const vivas = (stepData.persons || []).filter(p => p && p.person_id && !p.deleted_at);
    const numerar = (tipo) => {
      let n = 0;
      return vivas.filter(p => p.person_type_id === tipo).map(p => {
        n += 1;
        const nombre = [p.first_name, p.last_name].filter(Boolean).join(' ').trim();
        const titulo = tipo === 'guardian' ? t('guardian.title', { n }) : t('applicant.title', { n });
        return { person_id: p.person_id, etiqueta: nombre ? `${titulo} — ${nombre}` : titulo };
      });
    };
    return [...numerar('guardian'), ...numerar('applicant')];
  })();

  // Semilla desde la hidratación: cada documento subido (origin='WIZARD') se
  // convierte en una fila ya-completada del adjuntador genérico. Si no hay
  // ninguno, arrancamos con CERO paneles (patrón "añadir ítem" de Step2Persons):
  // el usuario verá solo el botón "Añadir archivo".
  const seedRows = () =>
    (stepData.documents || [])
      .filter(d => d && d.file_id)
      .map(d => ({
        id:               newRowId(),
        description:      d.description || '',
        file_id:          d.file_id,
        file_name:        d.file_name || '',
        // 0º.sexdecies — el servidor SIEMPRE guardó el tipo y el dueño (DL-R16/DL-R17); lo
        // que faltaba era llevarlos de la hidratación a la fila para poder ENSEÑARLOS de
        // vuelta. `owner_person_ids` vacío es la respuesta EXPLÍCITA «de la solicitud», no
        // «no consta» — ver el JSDoc de `documents` en `enr_wizardHydrateCompute_` (KMS).
        rec_type_code:    d.rec_type_code || '',
        owner_person_ids: Array.isArray(d.owner_person_ids) ? d.owner_person_ids : [],
      }));

  const [rows, setRows] = useState(seedRows);

  // 18.bis.35 · DL-R16 — LOS TIPOS DE DOCUMENTO QUE LA FAMILIA PUEDE APORTAR.
  //
  // Salen del CATÁLOGO del centro y viajan por el canal que el asistente YA usa: el KMS los
  // mete en las mismas listas que sirven alergias, dietas y tipos de vínculo
  // (`recTypesInterestedParty`, `enr_wizardFetchLookups`). NO se abre ninguna llamada nueva y
  // aquí no se escribe ni un código: la lista es la que el colegio haya marcado como
  // «Aportado por: parte interesada», ni una más.
  //
  // DEGRADA SIN ROMPER, y por eso arranca vacío y ningún fallo se propaga: un centro que aún
  // no ha marcado ninguno —o una lectura que no llega— deja la pantalla exactamente como
  // estaba antes de esto (sin desplegable), y la familia sigue pudiendo adjuntar. Si además
  // el catálogo está sin configurar, el rechazo lo da el servidor NOMBRANDO qué falta, que es
  // lo que ya hacía. El mismo patrón de carga que `Step3Relations` usa para sus catálogos.
  //
  // ★ 2026-08-19 — Y EN EL IDIOMA QUE LA FAMILIA ESTÁ LEYENDO. El texto de cada opción es la
  // descripción que el centro escribió en la ficha del tipo; su versión en otro idioma vive
  // en el primitivo de traducciones del KMS y la resuelve el servidor
  // (`rec_resolveInterestedPartyType_`). Aquí solo se PIDE el idioma y se pinta lo que llega:
  // ni se traduce nada en el cliente ni se escribe un código a mano.
  //
  // El efecto DEPENDE del idioma a propósito: el interruptor EN/ES de la cabecera cambia
  // `i18n.language` sin desmontar el paso, así que sin esa dependencia la familia que lo
  // pulsara con el paso 6 abierto se quedaría con la lista del idioma anterior. Sin versión
  // guardada el servidor devuelve la descripción de la ficha, o sea lo mismo que ahora — el
  // cambio de idioma nunca deja la lista vacía.
  const [tiposDeDocumento, setTiposDeDocumento] = useState([]);
  useEffect(() => {
    fetchLookups(i18n.language)
      .then(data => {
        const tipos = (data && data.recTypesInterestedParty) || [];
        log.info('Step6: tipos de documento del catálogo', { count: tipos.length, idioma: i18n.language });
        if (tipos.length) setTiposDeDocumento(tipos.filter(tp => tp && tp.code));
      })
      .catch(err => log.error('Step6: fetchLookups failed', { message: err.message }));
  }, [i18n.language]);

  // RE-SEMBRADO: si los archivos del servidor llegan DESPUÉS de montar esta pantalla, la
  // lista los incorpora en vez de quedarse con la foto del primer instante.
  //
  // `useState(seedRows)` corre UNA sola vez, al montar. Hoy el asistente monta este paso
  // SIEMPRE con la hidratación ya resuelta (mientras carga pinta un esqueleto, y el aterrizaje
  // recalcula el paso), así que NO se ha conseguido reproducir desde la pantalla un caso en que
  // la lista se quedara vacía teniendo archivos — se intentó con la verja de datos personales y
  // con una recarga estando en el paso, y en las dos la lista salía completa. Esto es, por
  // tanto, una GUARDA: barata, y la única forma de que un cambio futuro en el orden de montaje
  // no vuelva a esconder lo que la familia subió. Es el mismo patrón que el paso de Salud ya
  // tiene (`Step4Health.jsx`, «Re-sync if stepData.health arrives after mount»).
  //
  // SOLO AÑADE lo que falta, NUNCA reemplaza: una fila a medio subir (sin `file_id` todavía) y
  // una ya listada se quedan intactas. Perder un adjunto en vuelo por «refrescar la lista»
  // sería peor que el fallo que esto previene.
  useEffect(() => {
    const delServidor = (stepData.documents || []).filter(d => d && d.file_id);
    if (!delServidor.length) return;
    setRows(prev => {
      const yaListados = new Set(prev.map(r => r.file_id).filter(Boolean));
      const nuevas = delServidor
        .filter(d => !yaListados.has(d.file_id))
        .map(d => ({
          id:               newRowId(),
          description:      d.description || '',
          file_id:          d.file_id,
          file_name:        d.file_name || '',
          rec_type_code:    d.rec_type_code || '',
          owner_person_ids: Array.isArray(d.owner_person_ids) ? d.owner_person_ids : [],
        }));
      return nuevas.length ? [...prev, ...nuevas] : prev;
    });
  }, [stepData.documents]); // eslint-disable-line

  useEffect(() => { log.info('[DBG docs] render', { locked, n_existing: (stepData.documents || []).length }); }, [locked]); // eslint-disable-line

  // `documents` derivado: solo las filas con un file_id subido (lo que persiste).
  const uploadedDocs = () => rows
    .filter(r => r.file_id)
    .map(r => ({ file_id: r.file_id, file_name: r.file_name || '', description: (r.description || '').trim() }));

  const handleDescriptionChange = (rowId, value) => {
    setRows(prev => prev.map(r => r.id === rowId ? { ...r, description: value } : r));
  };

  // DL-R17 — la respuesta a «de quién es» viaja con la subida (ver `doUpload`); aquí solo se
  // recuerda mientras la familia elige el archivo.
  const handleDuenoChange = (rowId, value) => {
    setRows(prev => prev.map(r => r.id === rowId ? { ...r, dueno: value } : r));
  };

  // 18.bis.35 — QUÉ ES el archivo. Igual que la respuesta de arriba: viaja con la subida
  // (ver `doUpload`); aquí solo se recuerda mientras la familia elige el archivo.
  const handleTipoChange = (rowId, value) => {
    setRows(prev => prev.map(r => r.id === rowId ? { ...r, rec_type_code: value } : r));
  };

  const handleUploaded = (rowId, doc) => {
    // WIZARD-DOCS2: NO se auto-añade una fila vacía tras subir. Para otro archivo,
    // el usuario vuelve a pulsar "Añadir archivo" (patrón Step2Persons).
    setRows(prev => prev.map(r => r.id === rowId ? { ...r, ...doc } : r));
  };

  const handleAddRow = () => {
    setRows(prev => [...prev, { id: newRowId(), description: '', dueno: '', rec_type_code: '', file_id: '', file_name: '' }]);
  };

  // Aviso de que un documento se retira, cuando el servidor no explica por qué no pudo.
  const [avisoQuitar, setAvisoQuitar] = useState('');
  // ②27 — quitar un documento exige el código de un solo uso, igual que subirlo. Guarda el
  // gesto pendiente para repetirlo tras verificar (null | () => void).
  const [quitarStepUp, setQuitarStepUp] = useState(null);

  const handleRemoveRow = (rowId) => {
    // WIZARD-DOCS2: quitar el último panel deja CERO paneles (sigue siendo opcional),
    // igual que se puede quitar un tutor/alumno en Step2Persons.
    //
    // ★ 2026-08-08 — y si el archivo YA SE SUBIÓ, el servidor tiene que enterarse. Antes
    // solo desaparecía el panel: el archivo seguía guardado, seguía contando como aportado
    // y volvía a salir al recuperar la solicitud. El archivo NO se destruye — queda marcado
    // para retirar, que es lo que puede hacer una familia; borrarlo de verdad es del colegio.
    const antes = rows;
    const fila  = antes.find(r => r.id === rowId) || {};
    confirmarYQuitar({
      resumeToken,
      identidad,                        // ②24 — el código va al buzón del tutor que opera
      clase: 'DOCUMENTO',
      id: fila.file_id,
      pregunta: t('quitar.confirmar_documento'),
      motivoPorDefecto: t('quitar.no_se_pudo'),
      motivoCodigo: t('quitar.necesita_codigo'),
      quitarDeLaPantalla: () => { setAvisoQuitar(''); setRows(antes.filter(r => r.id !== rowId)); },
      volverAPonerlo: () => setRows(antes),
      avisar: (m) => setAvisoQuitar(m || t('quitar.no_se_pudo')),
      // ②27 — el servidor pide el código: mismo trato que una subida gateada.
      pedirCodigo: (reintentar) => setQuitarStepUp(() => reintentar),
    });
  };

  const persist = () => updateStep('documents', uploadedDocs());

  const handleBack = () => { persist(); onBack(); };
  const handleNext = () => {
    const docs = uploadedDocs();
    log.info('Step6: onNext documents', { n: docs.length });
    updateStep('documents', docs);
    onNext('documents', docs);
  };

  return (
    <>
      <div className="mb-2">
        <h2 style={{ color: 'var(--teal-dk)', fontWeight: 800 }}>{t('step.documents')}</h2>
        <p style={{ color: 'var(--muted)' }}>{t('step6.subtitle')}</p>
      </div>

      <StepNav position="top" onBack={handleBack} onNext={handleNext} savePending={savePending} />

      {locked && <LockedBanner onUnlock={onUnlock} />}

      {/* ②27 — quitar un documento exige el código de un solo uso, igual que subirlo. Si la
          ventana se agotó, se pide aquí y al acertar se repite el gesto ya confirmado. */}
      {quitarStepUp && (
        <div className="mb-3">
          <StepUpReverify
            tokenPayload={{ resume_token: resumeToken, ...identidadDelEnlace(identidad) }}
            prompt={t('stepup.quitar_prompt')}
            onVerified={() => {
              markStepUpFresh();
              const reintentar = quitarStepUp;
              setQuitarStepUp(null);
              reintentar();
            }}
          />
        </div>
      )}

      <div className="kis-card" style={locked ? { pointerEvents: 'none', opacity: 0.7 } : {}}>
        {/* WIZARD-DOCS2: estado inicial sin paneles → solo aviso + botón "Añadir archivo"
            (patrón Step2Persons). Cada panel abre al pulsar el botón; se puede quitar. */}
        {avisoQuitar && (
          <div className="alert alert-warning py-2 px-3 mb-3" role="alert" style={{ fontSize: '0.9rem' }}>
            {avisoQuitar}
          </div>
        )}

        {rows.length === 0 && (
          <p className="mb-3" style={{ color: 'var(--muted)', fontSize: '0.9rem' }}>
            {t('doc.empty_hint')}
          </p>
        )}

        {rows.map(row => (
          <GenericAttachment
            key={row.id}
            row={row}
            personas={personasDelDocumento}
            tiposDeDocumento={tiposDeDocumento}
            enrollmentGroupId={enrollmentGroupId}
            resumeToken={resumeToken}
            identidad={identidad}
            onUploaded={handleUploaded}
            onDescriptionChange={handleDescriptionChange}
            onDuenoChange={handleDuenoChange}
            onTipoChange={handleTipoChange}
            onRemove={handleRemoveRow}
            onStepUpVerified={markStepUpFresh}
            onActivity={touchActivity}
            onUploadStart={beginUpload}
            onUploadEnd={endUpload}
          />
        ))}

        <button type="button" className="add-btn" onClick={handleAddRow}>
          <i className="bi bi-plus-lg me-1" /> {t('doc.add')}
        </button>
      </div>

      <div className="d-flex justify-content-between mt-4">
        <button className="btn-secondary-kis" onClick={handleBack}>
          <i className="bi bi-arrow-left me-1" /> {t('nav.back')}
        </button>
        <button className="btn-primary-kis" onClick={handleNext}>
          {t('nav.continue')} <i className="bi bi-arrow-right ms-1" />
        </button>
      </div>
    </>
  );
}
