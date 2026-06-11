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
 *   - SIN toolbar de Chrome — cero print/download/anotación.
 *   - Ajuste a ancho por defecto (escala al contenedor) + devicePixelRatio (nitidez).
 *   - Botones grandes (táctiles) para móvil; el canvas escala al ancho del contenedor.
 *
 * VIEWER-SCROLL (Diego 2026-06-11: "No sé si la presentación del pdf se puede hacer
 * que las páginas salgan con un simple scroll, en vez de tener que pasar página por
 * página."): TODAS las páginas se renderizan apiladas (un <canvas> por página) dentro
 * del contenedor con scroll vertical — el scroll nativo (táctil en móvil) es el modo
 * primario de navegación. Los PDF del paquete son 3-6 páginas, así que se renderizan
 * todas en orden secuencial (sin lazy-loading — innecesario a este tamaño). Los
 * botones ‹ › quedan como salto-scroll a página anterior/siguiente y el indicador
 * "página i de N" refleja la página VISIBLE (scroll handler simple).
 *
 * pdf.js se carga por IMPORT DINÁMICO al montar el visor — los pasos 1-7 no pagan el
 * peso en el bundle inicial (Vite lo parte en chunk aparte; el worker va como asset
 * vía `?url`). La fuente de bytes es el object URL del cache del contexto (docCache /
 * loadDocument) — este componente NO toca el pipeline de descarga (getDocument +
 * sha256) ni mete tokens en URLs (KAL-7: el object URL es local al browser).
 */

// Carga única (module-level) de pdf.js + worker. Idempotente: el primer visor paga
// el import; los siguientes reutilizan la promesa.
// WEBKIT-COMPAT (Diego, iPhone 2026-06-11: "tarda una eternidad… y al final da fallo"):
// el build moderno de pdfjs-dist v6 usa Promise.withResolvers (ES2024) y otras APIs
// que los WebKit < 17.4 NO tienen → getDocument moría en iOS con el blob YA descargado
// (pdf.load_error tras la espera). El build LEGACY embebe los polyfills de core-js
// (verificado en node_modules: módulo TC39 Promise.withResolvers) — es la vía
// canónica de pdf.js para navegadores viejos. Mismo API, mismo worker por ?url.
let _pdfjsPromise = null;
function loadPdfjs_() {
  if (!_pdfjsPromise) {
    _pdfjsPromise = Promise.all([
      import('pdfjs-dist/legacy/build/pdf.mjs'),
      import('pdfjs-dist/legacy/build/pdf.worker.min.mjs?url'),
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

export default function PdfViewer({ data, url, title }) { // eslint-disable-line react/prop-types
  const { t } = useTranslation();
  const containerRef = useRef(null);
  const scrollRef = useRef(null);      // contenedor con scroll vertical (página visible + salto)
  const canvasRefs = useRef([]);       // un <canvas> por página, en orden
  const docRef = useRef(null);         // PDFDocumentProxy vivo (para destroy)
  const renderTasksRef = useRef([]);   // RenderTasks en vuelo (para cancel por página)
  const [doc, setDoc] = useState(null);
  const [numPages, setNumPages] = useState(0);
  const [visiblePage, setVisiblePage] = useState(1); // página visible en el scroll
  const [zoom, setZoom] = useState(1);               // 1 = ajuste a ancho del contenedor
  const [containerWidth, setContainerWidth] = useState(0);
  const [loadErr, setLoadErr] = useState(false);
  const [retryKey, setRetryKey] = useState(0); // WEBKIT-COMPAT: Reintentar re-dispara la carga

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

  const cancelRenderTasks_ = () => {
    renderTasksRef.current.forEach(task => { try { task.cancel(); } catch { /* ignore */ } });
    renderTasksRef.current = [];
  };

  // Carga del documento (import dinámico de pdf.js + getDocument sobre el object URL
  // del cache del contexto — pdf.js hace fetch local del blob, cero red).
  useEffect(() => {
    if (!url && !data) return undefined;
    let alive = true;
    setDoc(null); setLoadErr(false); setVisiblePage(1); setZoom(1);
    const _t0 = Date.now();
    // WEBKIT-COMPAT (log real iPhone 20:32): con `url:` pdf.js hace fetch del blob: y
    // WebKit responde status 0 → "Unexpected server response (0)". Preferimos `data:`
    // (bytes ya en memoria, cero fetch). pdf.js TRANSFIERE el buffer al worker (lo
    // desconecta) → SIEMPRE una copia, nunca el Uint8Array cacheado del contexto.
    loadPdfjs_()
      .then(lib => lib.getDocument(data ? { data: new Uint8Array(data) } : { url }).promise)
      .then(pdf => {
        if (!alive) { pdf.destroy(); return; }
        docRef.current = pdf;
        setDoc(pdf);
        setNumPages(pdf.numPages);
        if (scrollRef.current) scrollRef.current.scrollTop = 0;
        log.info('[pdf viewer] documento cargado', { ms: Date.now() - _t0, pages: pdf.numPages });
      })
      .catch(e => {
        log.warn('[pdf viewer] carga fallida', { message: e && e.message });
        if (alive) setLoadErr(true);
      });
    return () => {
      alive = false;
      cancelRenderTasks_();
      if (docRef.current) { try { docRef.current.destroy(); } catch { /* ignore */ } docRef.current = null; }
    };
  }, [url, data, retryKey]);

  // Render de TODAS las páginas apiladas, EN ORDEN secuencial (una a una — mantiene
  // la memoria contenida y las primeras páginas aparecen primero). Escala = ajuste-
  // a-ancho × zoom, con devicePixelRatio para nitidez (canvas interno más denso que
  // su CSS width). Re-render por zoom/ancho REUTILIZA los mismos <canvas> (resize
  // destruye el bitmap previo — no se acumulan canvases). Cancelación: cleanup
  // cancela los RenderTasks en vuelo (patrón renderTask.cancel, ahora por página).
  useEffect(() => {
    if (!doc || !containerWidth) return undefined;
    let alive = true;
    cancelRenderTasks_();
    (async () => {
      for (let i = 1; i <= doc.numPages; i++) {
        if (!alive) return;
        try {
          const page = await doc.getPage(i);
          if (!alive) return;
          const canvas = canvasRefs.current[i - 1];
          if (!canvas) continue;
          const base = page.getViewport({ scale: 1 });
          const fitScale = (containerWidth - 2) / base.width; // -2: borde del marco
          const scale = fitScale * zoom;
          const dpr = Math.min(window.devicePixelRatio || 1, 3);
          const viewport = page.getViewport({ scale: scale * dpr });
          canvas.width = Math.floor(viewport.width);
          canvas.height = Math.floor(viewport.height);
          canvas.style.width = Math.floor(viewport.width / dpr) + 'px';
          canvas.style.height = Math.floor(viewport.height / dpr) + 'px';
          const ctx = canvas.getContext('2d');
          const task = page.render({ canvasContext: ctx, viewport });
          renderTasksRef.current.push(task);
          await task.promise;
        } catch (e) {
          // RenderingCancelledException al cambiar zoom/desmontar rápido — esperado.
          if (e && e.name !== 'RenderingCancelledException') {
            log.warn('[pdf viewer] render fallido', { page: i, message: e && e.message });
          }
        }
      }
    })();
    return () => { alive = false; cancelRenderTasks_(); };
  }, [doc, zoom, containerWidth]);

  // Página visible: scroll handler simple — la última página cuyo top quedó por
  // encima del 40% del viewport del contenedor es la "actual". (Los PDF son 3-6
  // páginas; IntersectionObserver sería sobre-ingeniería aquí.)
  const handleScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const threshold = el.scrollTop + el.clientHeight * 0.4;
    let current = 1;
    canvasRefs.current.forEach((c, idx) => {
      if (c && c.offsetTop <= threshold) current = idx + 1;
    });
    setVisiblePage(current);
  }, []);

  // ‹ › = salto-scroll a página anterior/siguiente (el scroll es el modo primario).
  const go = useCallback((delta) => {
    const el = scrollRef.current;
    if (!el) return;
    const target = Math.min(Math.max(1, visiblePage + delta), numPages || 1);
    const canvas = canvasRefs.current[target - 1];
    if (canvas) el.scrollTo({ top: Math.max(0, canvas.offsetTop - 8), behavior: 'smooth' });
  }, [visiblePage, numPages]);
  const zoomBy = (delta) => setZoom(z => Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, Math.round((z + delta) * 100) / 100)));

  // Controles propios — botones GRANDES (táctiles) compartidos arriba y abajo.
  const navBtn = { border: '1px solid var(--border)', background: 'var(--surface)', color: 'var(--teal-dk)', borderRadius: 8, minWidth: 44, minHeight: 40, fontSize: '1rem', fontWeight: 700, cursor: 'pointer' };
  const controls = (position) => (
    <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, padding: '6px 4px', flexWrap: 'wrap', borderBottom: position === 'top' ? '1px solid var(--border)' : 'none', borderTop: position === 'bottom' ? '1px solid var(--border)' : 'none' }}>
      <span style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <button type="button" style={navBtn} disabled={visiblePage <= 1} onClick={() => go(-1)} aria-label={t('pdf.prev_page')}>
          <i className="bi bi-chevron-left" />
        </button>
        <span style={{ fontSize: '0.85rem', color: 'var(--text)', fontWeight: 600, minWidth: 90, textAlign: 'center' }}>
          {t('pdf.page_of', { i: visiblePage, n: numPages })}
        </span>
        <button type="button" style={navBtn} disabled={visiblePage >= numPages} onClick={() => go(1)} aria-label={t('pdf.next_page')}>
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
        <div style={{ marginTop: 12 }}>
          <button type="button" className="btn btn-outline-secondary btn-sm"
            onClick={() => setRetryKey(k => k + 1)}>
            <i className="bi bi-arrow-clockwise me-1" />{t('pdf.retry')}
          </button>
        </div>
      </div>
    );
  }

  return (
    <div ref={containerRef} role="document" aria-label={title || undefined}
      style={{ border: '1px solid var(--border)', borderRadius: 8, background: '#fff', overflow: 'hidden' }}>
      {controls('top')}
      {/* Lienzo: TODAS las páginas apiladas con scroll continuo (VIEWER-SCROLL); scroll
          horizontal solo si el usuario hace zoom-in. `position: relative` para que el
          offsetTop de los canvas sea relativo al contenedor de scroll (página visible +
          salto ‹ ›). RESPONSIVE-UI (2026-06-11): el alto se sube a min(85vh, 1100px)
          para que en monitores altos de escritorio el documento se vea grande sin
          recortarse; el vh mantiene la proporción contenida en móvil/tablet. El ancho lo
          gobierna el contenedor (fit-a-ancho vía ResizeObserver), ancho en el Step 10. */}
      <div ref={scrollRef} onScroll={handleScroll}
        style={{ position: 'relative', overflow: 'auto', maxHeight: 'min(85vh, 1100px)', minHeight: 320, background: 'var(--bg)', textAlign: 'center' }}>
        {doc ? (
          Array.from({ length: numPages }, (_, idx) => (
            <canvas key={idx}
              ref={el => { canvasRefs.current[idx] = el; }}
              style={{ display: 'block', boxShadow: '0 1px 4px rgba(0,0,0,0.18)', margin: '8px auto', verticalAlign: 'top' }} />
          ))
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
