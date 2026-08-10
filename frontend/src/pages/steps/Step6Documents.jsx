import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useWizard } from '../../context/WizardContext';
import { gasCall, identidadDelEnlace } from '../../api';
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
//   pantalla dejaba adjuntar y avanzar. El tipo lo pone ahora el catálogo, resuelto por
//   el KMS (DL-R16); el wizard no manda ninguno. Ver el bloque «EL TIPO DE DOCUMENTO LO
//   PONE EL CATÁLOGO» en `backend/Code.js`.
//
// WIZARD-DOCS2 (2026-06-13): patrón "añadir ítem" como en Step2Persons (tutores/
// alumnos). Estado inicial = CERO paneles: solo el botón "Añadir archivo". Cada
// pulsación abre UN panel (descripción + selector). NO se auto-añade fila vacía
// tras subir; para otro archivo hay que volver a pulsar "Añadir archivo". Cada
// panel se puede quitar; quitar el último deja CERO paneles (sigue siendo
// opcional). Las subidas existentes (hidratación) se muestran como paneles ya
// completados.

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
function GenericAttachment({ row, enrollmentGroupId, resumeToken, identidad, onUploaded, onDescriptionChange, onRemove, onStepUpVerified, onActivity }) {
  const { t } = useTranslation();
  const [status, setStatus] = useState(row.file_id ? 'success' : '');
  const [fileId, setFileId] = useState(row.file_id || '');
  const [err,    setErr]    = useState('');
  const [viewing, setViewing] = useState(false);
  const [stepUpRetry, setStepUpRetry] = useState(null); // null | () => void

  const isStepUpError = (e) => e?.code === 'STEPUP_REQUIRED' || /STEPUP_REQUIRED/.test(e?.message || '');

  const doUpload = async (file) => {
    setStatus('uploading');
    setErr('');
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
        // ②24 — quién está operando: el servidor exige el código de un solo uso y la
        // marca es DEL BUZÓN que se verificó, no del expediente entero.
        ...identidadDelEnlace(identidad),
      });
      setFileId(data.file_id);
      setStatus('success');
      onUploaded(row.id, { file_id: data.file_id, file_name: file.name, description: (row.description || '').trim() });
    } catch (e) {
      if (isStepUpError(e)) {
        log.warn('Step6: uploadDocument requires step-up');
        setStatus('');
        setStepUpRetry(() => () => doUpload(file));
        return;
      }
      log.error('Step6: uploadDocument failed', { message: e.message });
      setStatus('error');
      setErr(e.message);
    }
  };

  const handleFile = (file) => {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { setErr(t('error.file_too_large')); return; }
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
  const { t }  = useTranslation();
  const {
    enrollmentGroupId, resumeToken, stepData, updateStep,
    markStepUpFresh, touchActivity,
    recoveryNonce, recoveredEmail,   // ②24 — quién está operando (identidad del enlace)
  } = useWizard();
  const identidad = { n: recoveryNonce, recoveredEmail };

  // Semilla desde la hidratación: cada documento subido (origin='WIZARD') se
  // convierte en una fila ya-completada del adjuntador genérico. Si no hay
  // ninguno, arrancamos con CERO paneles (patrón "añadir ítem" de Step2Persons):
  // el usuario verá solo el botón "Añadir archivo".
  const seedRows = () =>
    (stepData.documents || [])
      .filter(d => d && d.file_id)
      .map(d => ({
        id:          newRowId(),
        description: d.description || '',
        file_id:     d.file_id,
        file_name:   d.file_name || '',
      }));

  const [rows, setRows] = useState(seedRows);

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
          id:          newRowId(),
          description: d.description || '',
          file_id:     d.file_id,
          file_name:   d.file_name || '',
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

  const handleUploaded = (rowId, doc) => {
    // WIZARD-DOCS2: NO se auto-añade una fila vacía tras subir. Para otro archivo,
    // el usuario vuelve a pulsar "Añadir archivo" (patrón Step2Persons).
    setRows(prev => prev.map(r => r.id === rowId ? { ...r, ...doc } : r));
  };

  const handleAddRow = () => {
    setRows(prev => [...prev, { id: newRowId(), description: '', file_id: '', file_name: '' }]);
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
            enrollmentGroupId={enrollmentGroupId}
            resumeToken={resumeToken}
            identidad={identidad}
            onUploaded={handleUploaded}
            onDescriptionChange={handleDescriptionChange}
            onRemove={handleRemoveRow}
            onStepUpVerified={markStepUpFresh}
            onActivity={touchActivity}
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
