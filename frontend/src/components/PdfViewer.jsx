import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import * as log from '../logger';

/**
 * VIEWER-UX (Diego 2026-06-11) — visor de PDF PROPIO (pdf.js) para el paquete
 * contractual del Step 10.
 *
 * Queja literal: "Esto claramente es un visor de google drive, no es una inserción
 * de un blob." + "Y es imposible de manejar." — el iframe con object URL delegaba el
 * render en el visor PDF nativo de Chrome (toolbar ajena con print/download/anotación,
 * render a dos columnas apretado) y en iOS Safari los PDF multipágina en iframe NI
 * renderizan. Este componente renderiza NUESTRO blob a <canvas> con pdf.js:
 *   - UNA página visible, controles propios: ‹ página i de N ›, zoom −/+.
 *   - Ajuste a ancho por defecto (escala al contenedor) + devicePixelRatio (nitidez).
 *   - SIN toolbar de Chrome — cero print/download/anotación.
 *   - Botones grandes (táctiles) para móvil; el canvas escala al ancho del contenedor.
 *
 * pdf.js se carga por IMPORT DINÁMICO al montar el visor — los pasos 1-7 no pagan el
 * peso en el bundle inicial (Vite lo parte en chunk aparte; el worker va como asset
 * vía `?url`). La fuente de bytes es el object URL del cache del contexto (docCache /
 * loadDocument) — este componente NO toca el pipeline de descarga (getDocument +
 * sha256) ni mete tokens en URLs (KAL-7: el object URL es local al browser).
 */

// Carga única (module-level) de pdf.js + worker. Idempotente: el primer visor paga
// el import; los siguientes reutilizan la promesa.
let _pdfjsPromise = null;
function loadPdfjs_() {
  if (!_pdfjsPromise) {
    _pdfjsPromise = Promise.all([
      import('pdfjs-dist'),
      import('pdfjs-dist/build/pdf.worker.min.mjs?url'),
    ]).then(([lib, workerUrl]) => {
      lib.GlobalWorkerOptions.workerSrc = workerUrl.default;
      return lib;
    }).catch(e => { _pdfjsPromise = null; throw e; });
  }
  return _pdfjsPromise;
}

const ZOOM_MIN = 0.6;
const ZOOM_MAX = 3;
const ZOOM_STEP = 0.25;

export default function PdfViewer({ url, title }) { // eslint-disable-line react/prop-types
  const { t } = useTranslation();
  const containerRef = useRef(null);
  const canvasRef = useRef(null);
  const docRef = useRef(null);        // PDFDocumentProxy vivo (para destroy)
  const renderTaskRef = useRef(null); // RenderTask en vuelo (para cancel)
  const [doc, setDoc] = useState(null);
  const [numPages, setNumPages] = useState(0);
  const [pageNum, setPageNum] = useState(1);
  const [zoom, setZoom] = useState(1);          // 1 = ajuste a ancho del contenedor
  const [containerWidth, setContainerWidth] = useState(0);
  const [loadErr, setLoadErr] = useState(false);

  // Ancho del contenedor (ajuste a ancho por defecto + responsive en rotación móvil).
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return undefined;
    setContainerWidth(el.clientWidth);
    const ro = new ResizeObserver(entries => {
      const w = entries[0] && entries[0].contentRect && Math.floor(entries[0].contentRect.width);
      if (w) setContainerWidth(w);
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Carga del documento (import dinámico de pdf.js + getDocument sobre el object URL
  // del cache del contexto — pdf.js hace fetch local del blob, cero red).
  useEffect(() => {
    if (!url) return undefined;
    let alive = true;
    setDoc(null); setLoadErr(false); setPageNum(1); setZoom(1);
    const _t0 = Date.now();
    loadPdfjs_()
      .then(lib => lib.getDocument({ url }).promise)
      .then(pdf => {
        if (!alive) { pdf.destroy(); return; }
        docRef.current = pdf;
        setDoc(pdf);
        setNumPages(pdf.numPages);
        log.info('[pdf viewer] documento cargado', { ms: Date.now() - _t0, pages: pdf.numPages });
      })
      .catch(e => {
        log.warn('[pdf viewer] carga fallida', { message: e && e.message });
        if (alive) setLoadErr(true);
      });
    return () => {
      alive = false;
      if (renderTaskRef.current) { try { renderTaskRef.current.cancel(); } catch { /* ignore */ } }
      if (docRef.current) { try { docRef.current.destroy(); } catch { /* ignore */ } docRef.current = null; }
    };
  }, [url]);

  // Render de la página visible a <canvas>: escala = ajuste-a-ancho × zoom, con
  // devicePixelRatio para nitidez (el canvas interno es más denso que su CSS width).
  useEffect(() => {
    if (!doc || !containerWidth || !canvasRef.current) return undefined;
    let alive = true;
    doc.getPage(pageNum).then(page => {
      if (!alive || !canvasRef.current) return;
      const base = page.getViewport({ scale: 1 });
      const fitScale = (containerWidth - 2) / base.width; // -2: borde del marco
      const scale = fitScale * zoom;
      const dpr = Math.min(window.devicePixelRatio || 1, 3);
      const viewport = page.getViewport({ scale: scale * dpr });
      const canvas = canvasRef.current;
      canvas.width = Math.floor(viewport.width);
      canvas.height = Math.floor(viewport.height);
      canvas.style.width = Math.floor(viewport.width / dpr) + 'px';
      canvas.style.height = Math.floor(viewport.height / dpr) + 'px';
      const ctx = canvas.getContext('2d');
      if (renderTaskRef.current) { try { renderTaskRef.current.cancel(); } catch { /* ignore */ } }
      const task = page.render({ canvasContext: ctx, viewport });
      renderTaskRef.current = task;
      task.promise.catch(e => {
        // RenderingCancelledException al cambiar de página/zoom rápido — esperado.
        if (e && e.name !== 'RenderingCancelledException') {
          log.warn('[pdf viewer] render fallido', { message: e && e.message });
        }
      });
    }).catch(e => {
      log.warn('[pdf viewer] getPage fallido', { page: pageNum, message: e && e.message });
    });
    return () => { alive = false; };
  }, [doc, pageNum, zoom, containerWidth]);

  const go = useCallback((delta) => {
    setPageNum(p => Math.min(Math.max(1, p + delta), numPages || 1));
  }, [numPages]);
  const zoomBy = (delta) => setZoom(z => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round((z + delta) * 100) / 100)));

  // Controles propios — botones GRANDES (táctiles) compartidos arriba y abajo.
  const navBtn = { border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--teal-dk)', borderRadius: 8, minWidth: 44, minHeight: 40, fontSize: '1rem', fontWeight: 700, cursor: 'pointer' };
  const controls = (position) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '6px 4px', flexWrap: 'wrap', borderBottom: position === 'top' ? '1px solid var(--border)' : 'none', borderTop: position === 'bottom' ? '1px solid var(--border)' : 'none' }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button type="button" style={navBtn} disabled={pageNum <= 1} onClick={() => go(-1)} aria-label={t('pdf.prev_page')}>
          <i className="bi bi-chevron-left" />
        </button>
        <span style={{ fontSize: '0.85rem', color: 'var(--text)', fontWeight: 600, minWidth: 90, textAlign: 'center' }}>
          {t('pdf.page_of', { i: pageNum, n: numPages })}
        </span>
        <button type="button" style={navBtn} disabled={pageNum >= numPages} onClick={() => go(1)} aria-label={t('pdf.next_page')}>
          <i className="bi bi-chevron-right" />
        </button>
      </span>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button type="button" style={navBtn} disabled={zoom <= ZOOM_MIN} onClick={() => zoomBy(-ZOOM_STEP)} aria-label={t('pdf.zoom_out')}>
          <i className="bi bi-dash-lg" />
        </button>
        <span style={{ fontSize: '0.8rem', color: 'var(--muted)', fontWeight: 600, minWidth: 44, textAlign: 'center' }}>
          {Math.round(zoom * 100)}%
        </span>
        <button type="button" style={navBtn} disabled={zoom >= ZOOM_MAX} onClick={() => zoomBy(ZOOM_STEP)} aria-label={t('pdf.zoom_in')}>
          <i className="bi bi-plus-lg" />
        </button>
      </span>
    </div>
  );

  if (loadErr) {
    return (
      <div style={{ textAlign: 'center', padding: 32, color: 'var(--muted)', border: '1px solid var(--border)', borderRadius: 8 }}>
        <i className="bi bi-file-earmark-pdf" style={{ fontSize: '1.4rem', display: 'block', marginBottom: 6 }} />
        {t('pdf.load_error')}
      </div>
    );
  }

  return (
    <div ref={containerRef} role="document" aria-label={title || undefined}
      style={{ border: '1px solid var(--border)', borderRadius: 8, background: '#fff', overflow: 'hidden' }}>
      {controls('top')}
      {/* Lienzo: UNA página visible; scroll horizontal solo si el usuario hace zoom-in. */}
      <div style={{ overflow: 'auto', maxHeight: 'min(72vh, 880px)', minHeight: 320, background: 'var(--bg)', textAlign: 'center' }}>
        {doc ? (
          <canvas ref={canvasRef} style={{ display: 'inline-block', boxShadow: '0 1px 4px rgba(0,0,0,0.18)', margin: '8px 0' }} />
        ) : (
          <div style={{ padding: 48, color: 'var(--muted)' }}>
            <span className="spinner-border spinner-border-sm me-2" />{t('pdf.rendering')}
          </div>
        )}
      </div>
      {controls('bottom')}
    </div>
  );
}
