import { useState, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { useWizard } from '../../context/WizardContext';
import { gasCall } from '../../api';
import { openDocument } from '../../utils/documentProxy';
import LockedBanner from '../../components/LockedBanner';
import StepNav from '../../components/StepNav';
import StepUpReverify from '../../components/StepUpReverify';
import * as log from '../../logger';

// WIZARD-DOCS (2026-06-13): adjuntador GENÉRICO opcional.
// Diego: "Hay una serie de casos tasados para subir archivos (DNI, etc.) pero no
// es necesario. Lo que haría falta es la posibilidad de subir archivos, NO
// obligatorio, y que el usuario decida qué archivo es: un adjuntador genérico,
// donde el usuario describe en una casilla qué tipo de archivo es."
// → Eliminamos la rejilla fija DOCUMENT_TYPES. El usuario añade N adjuntos; cada
//   uno = un archivo + una casilla de texto libre. Cero archivos es válido (no
//   obligatorio). El backend guarda la descripción en recFiles.description con un
//   rec_type_code genérico ('OTHER').

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
function GenericAttachment({ row, enrollmentGroupId, resumeToken, onUploaded, onDescriptionChange, onRemove, onStepUpVerified, onActivity }) {
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
      await openDocument({ file_id: fileId, resume_token: resumeToken });
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
          {t('doc.uploaded')} &nbsp;
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
          tokenPayload={{ resume_token: resumeToken }}
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
  } = useWizard();

  // Semilla desde la hidratación: cada documento subido (origin='WIZARD') se
  // convierte en una fila ya-completada del adjuntador genérico. Si no hay
  // ninguno, arrancamos con UNA fila vacía lista para adjuntar (opcional).
  const seedRows = () => {
    const existing = (stepData.documents || []).filter(d => d && d.file_id);
    if (existing.length) {
      return existing.map(d => ({
        id:          newRowId(),
        description: d.description || '',
        file_id:     d.file_id,
        file_name:   d.file_name || '',
      }));
    }
    return [{ id: newRowId(), description: '', file_id: '', file_name: '' }];
  };

  const [rows, setRows] = useState(seedRows);

  useEffect(() => { log.info('[DBG docs] render', { locked, n_existing: (stepData.documents || []).length }); }, [locked]); // eslint-disable-line

  // `documents` derivado: solo las filas con un file_id subido (lo que persiste).
  const uploadedDocs = () => rows
    .filter(r => r.file_id)
    .map(r => ({ file_id: r.file_id, file_name: r.file_name || '', description: (r.description || '').trim() }));

  const handleDescriptionChange = (rowId, value) => {
    setRows(prev => prev.map(r => r.id === rowId ? { ...r, description: value } : r));
  };

  const handleUploaded = (rowId, doc) => {
    setRows(prev => {
      const next = prev.map(r => r.id === rowId ? { ...r, ...doc } : r);
      // Tras una subida exitosa, añadimos automáticamente una nueva fila vacía
      // para facilitar adjuntar otro (sin obligar).
      const hasEmpty = next.some(r => !r.file_id);
      return hasEmpty ? next : [...next, { id: newRowId(), description: '', file_id: '', file_name: '' }];
    });
  };

  const handleAddRow = () => {
    setRows(prev => [...prev, { id: newRowId(), description: '', file_id: '', file_name: '' }]);
  };

  const handleRemoveRow = (rowId) => {
    setRows(prev => {
      const next = prev.filter(r => r.id !== rowId);
      // Conservamos siempre al menos una fila vacía visible.
      return next.length ? next : [{ id: newRowId(), description: '', file_id: '', file_name: '' }];
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

      <div className="kis-card" style={locked ? { pointerEvents: 'none', opacity: 0.7 } : {}}>
        {rows.map(row => (
          <GenericAttachment
            key={row.id}
            row={row}
            enrollmentGroupId={enrollmentGroupId}
            resumeToken={resumeToken}
            onUploaded={handleUploaded}
            onDescriptionChange={handleDescriptionChange}
            onRemove={handleRemoveRow}
            onStepUpVerified={markStepUpFresh}
            onActivity={touchActivity}
          />
        ))}

        <button type="button" className="btn-secondary-kis" onClick={handleAddRow}>
          <i className="bi bi-plus-circle me-1" /> {t('doc.add')}
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
