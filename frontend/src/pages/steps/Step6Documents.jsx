import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useWizard } from '../../context/WizardContext';
import { gasCall } from '../../api';
import { openDocument } from '../../utils/documentProxy';
import LockedBanner from '../../components/LockedBanner';
import StepUpReverify from '../../components/StepUpReverify';
import * as log from '../../logger';

const DOCUMENT_TYPES = [
  { key: 'passport',        labelKey: 'doc.passport'        },
  { key: 'birth_cert',      labelKey: 'doc.birth_cert'      },
  { key: 'report_card',     labelKey: 'doc.report_card'     },
  { key: 'medical_cert',    labelKey: 'doc.medical_cert'    },
  { key: 'photo',           labelKey: 'doc.photo'           },
];

function fileToBase64(file) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload  = () => resolve(reader.result.split(',')[1]);
    reader.onerror = reject;
    reader.readAsDataURL(file);
  });
}

function DocumentUploader({ docType, enrollmentGroupId, resumeToken, onUploaded, existing, onStepUpVerified, onActivity }) {
  const { t }    = useTranslation();
  const [status, setStatus] = useState(existing ? 'success' : '');
  // CLI 82 / KAL-NEW-5: ya no guardamos una drive_url pública; guardamos el
  // file_id interno y resolvemos los bytes on-demand vía getDocument.
  const [fileId, setFileId] = useState(existing?.file_id || '');
  const [err,    setErr]    = useState('');
  const [viewing, setViewing] = useState(false);
  // DL-E39: una acción gateada (subir/ver) puede devolver STEPUP_REQUIRED.
  // Guardamos la acción pendiente para reintentarla tras verificar.
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
        mimeType:      file.type,
        filename:      file.name,
        document_type: docType,
      });
      setFileId(data.file_id);
      setStatus('success');
      onUploaded({ document_type: docType, file_id: data.file_id });
    } catch (e) {
      // DL-E39: el backend exige step-up fresco → mostrar StepUpReverify + reintentar.
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
      // DL-E39: getDocument gateado → step-up + reintento.
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

  return (
    <div className="mb-4">
      <label className="form-label fw-semibold">{t(DOCUMENT_TYPES.find(d => d.key === docType)?.labelKey || docType)}</label>

      <div
        className="upload-zone"
        onDragOver={e => e.preventDefault()}
        onDrop={e => { e.preventDefault(); onActivity && onActivity(); handleFile(e.dataTransfer.files[0]); }}
        onClick={() => { onActivity && onActivity(); document.getElementById(`file_${docType}`).click(); }}
      >
        <i className="bi bi-cloud-arrow-up" style={{ fontSize: '1.5rem', color: 'var(--teal)' }} />
        <p style={{ margin: '6px 0 0', color: 'var(--muted)', fontSize: '0.88rem' }}>
          {t('doc.drag_or_click')}
        </p>
        <input
          id={`file_${docType}`}
          type="file"
          accept=".pdf,.jpg,.jpeg,.png"
          style={{ display: 'none' }}
          onChange={e => handleFile(e.target.files[0])}
        />
      </div>

      {status === 'uploading' && (
        <div className="upload-status" style={{ background: 'var(--teal-lt)', color: 'var(--teal-dk)' }}>
          <span className="spinner-border spinner-border-sm me-2" />{t('doc.uploading')}
        </div>
      )}
      {status === 'success' && (
        <div className="upload-status success">
          <i className="bi bi-check-circle me-1" />
          {t('doc.uploaded')} &nbsp;
          {/* DL-E39 ENMIENDA (gate de entrada): "Ver" siempre disponible — la PII
              está protegida por el gate de entrada del wizard. Al pulsar Ver el
              backend aún puede devolver STEPUP_REQUIRED si la frescura server-side
              expiró (defensa en profundidad, manejado en handleView). */}
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
  const [documents, setDocuments] = useState(stepData.documents || []);
  // DL-E39 ENMIENDA (gate de entrada): sin enmascarado per-campo. La PII está
  // protegida por el gate de entrada del wizard; aquí los documentos se muestran
  // con normalidad. markStepUpFresh/touchActivity siguen para el retry server-side
  // de subir/ver y para el reset del contador de inactividad.

  const handleUploaded = (doc) => {
    setDocuments(prev => {
      const next = prev.filter(d => d.document_type !== doc.document_type);
      return [...next, doc];
    });
  };

  const handleBack = () => {
    updateStep('documents', documents);
    onBack();
  };

  const handleNext = () => {
    log.info('Step6: onNext documents', documents);
    updateStep('documents', documents);
    onNext('documents', documents);
  };

  return (
    <>
      <div className="mb-2">
        <h2 style={{ color: 'var(--teal-dk)', fontWeight: 800 }}>{t('step.documents')}</h2>
        <p style={{ color: 'var(--muted)' }}>{t('step6.subtitle')}</p>
      </div>

      {locked && <LockedBanner onUnlock={onUnlock} />}

      <div className="kis-card" style={locked ? { pointerEvents: 'none', opacity: 0.7 } : {}}>
        {DOCUMENT_TYPES.map(doc => (
          <DocumentUploader
            key={doc.key}
            docType={doc.key}
            enrollmentGroupId={enrollmentGroupId}
            resumeToken={resumeToken}
            onUploaded={handleUploaded}
            existing={documents.find(d => d.document_type === doc.key)}
            onStepUpVerified={markStepUpFresh}
            onActivity={touchActivity}
          />
        ))}
      </div>

      <div className="d-flex justify-content-between mt-4">
        <button className="btn-secondary-kis" onClick={handleBack}>
          <i className="bi bi-arrow-left me-1" /> {t('nav.back')}
        </button>
        <button className="btn-primary-kis" onClick={handleNext} disabled={savePending}>
          {savePending
            ? <><span className="spinner-border spinner-border-sm me-1" style={{ width: '0.9em', height: '0.9em', borderWidth: '0.12em' }} />{t('wizard.saving_in_background')}</>
            : <>{t('nav.continue')} <i className="bi bi-arrow-right ms-1" /></>
          }
        </button>
      </div>
    </>
  );
}
