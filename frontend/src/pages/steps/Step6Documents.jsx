import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useWizard } from '../../context/WizardContext';
import { gasCall } from '../../api';

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

function DocumentUploader({ docType, applicationId, onUploaded, existing }) {
  const { t }    = useTranslation();
  const [status, setStatus] = useState(existing ? 'success' : '');
  const [url,    setUrl]    = useState(existing?.drive_url || '');
  const [err,    setErr]    = useState('');

  const handleFile = async (file) => {
    if (!file) return;
    if (file.size > 10 * 1024 * 1024) { setErr(t('error.file_too_large')); return; }
    setStatus('uploading');
    setErr('');
    try {
      const base64 = await fileToBase64(file);
      const data   = await gasCall('uploadDocument', {
        application_id: applicationId,
        base64,
        mimeType:      file.type,
        filename:      file.name,
        document_type: docType,
      });
      setUrl(data.drive_url);
      setStatus('success');
      onUploaded({ document_type: docType, drive_url: data.drive_url });
    } catch (e) {
      setStatus('error');
      setErr(e.message);
    }
  };

  return (
    <div className="mb-4">
      <label className="form-label fw-semibold">{t(DOCUMENT_TYPES.find(d => d.key === docType)?.labelKey || docType)}</label>

      <div
        className="upload-zone"
        onDragOver={e => e.preventDefault()}
        onDrop={e => { e.preventDefault(); handleFile(e.dataTransfer.files[0]); }}
        onClick={() => document.getElementById(`file_${docType}`).click()}
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
          <a href={url} target="_blank" rel="noreferrer">{t('doc.view')}</a>
        </div>
      )}
      {status === 'error' && (
        <div className="upload-status error">
          <i className="bi bi-exclamation-circle me-1" />{err}
        </div>
      )}
    </div>
  );
}

export default function Step6Documents({ onNext, onBack }) {
  const { t }  = useTranslation();
  const { applicationId, stepData, updateStep } = useWizard();
  const [documents, setDocuments] = useState(stepData.documents || []);

  const handleUploaded = (doc) => {
    setDocuments(prev => {
      const next = prev.filter(d => d.document_type !== doc.document_type);
      return [...next, doc];
    });
  };

  const handleNext = () => {
    updateStep('documents', documents);
    onNext('documents', documents);
  };

  return (
    <>
      <div className="mb-2">
        <h2 style={{ color: 'var(--teal-dk)', fontWeight: 800 }}>{t('step.documents')}</h2>
        <p style={{ color: 'var(--muted)' }}>{t('step6.subtitle')}</p>
      </div>

      <div className="kis-card">
        {DOCUMENT_TYPES.map(doc => (
          <DocumentUploader
            key={doc.key}
            docType={doc.key}
            applicationId={applicationId}
            onUploaded={handleUploaded}
            existing={documents.find(d => d.document_type === doc.key)}
          />
        ))}
      </div>

      <div className="d-flex justify-content-between mt-4">
        <button className="btn-secondary-kis" onClick={onBack}>
          <i className="bi bi-arrow-left me-1" /> {t('nav.back')}
        </button>
        <button className="btn-primary-kis" onClick={handleNext}>
          {t('nav.continue')} <i className="bi bi-arrow-right ms-1" />
        </button>
      </div>
    </>
  );
}
