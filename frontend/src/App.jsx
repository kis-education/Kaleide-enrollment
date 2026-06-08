import { Routes, Route, Navigate, useLocation } from 'react-router-dom'
import { Suspense, useEffect, Component } from 'react'
import { WizardProvider } from './context/WizardContext'
import LandingPage      from './pages/LandingPage'
import ConsentPage      from './pages/ConsentPage'
import WizardPage       from './pages/WizardPage'
import ResumePage       from './pages/ResumePage'
import ReportUnsolicitedPage from './pages/ReportUnsolicitedPage'
import ConfirmationPage       from './pages/ConfirmationPage'
import PrivacyPolicyPage from './pages/PrivacyPolicyPage'
import DevLogger        from './components/DevLogger'
import * as log         from './logger'

class ErrorBoundary extends Component {
  constructor(props) { super(props); this.state = { error: null }; }
  static getDerivedStateFromError(error) { return { error }; }
  componentDidCatch(error, info) { log.error('React error boundary caught', { message: error.message, stack: error.stack, component: info.componentStack }); }
  render() {
    if (this.state.error) return (
      <div style={{ padding: 32, fontFamily: 'monospace', color: '#c0392b' }}>
        <strong>Something went wrong.</strong>
        <pre style={{ marginTop: 12, fontSize: '0.8rem', whiteSpace: 'pre-wrap' }}>{this.state.error.message}</pre>
        <button onClick={() => this.setState({ error: null })} style={{ marginTop: 16, padding: '6px 16px', cursor: 'pointer' }}>Try again</button>
      </div>
    );
    return this.props.children;
  }
}

function RouteLogger() {
  const location = useLocation()
  useEffect(() => {
    log.info(`navigate → ${location.pathname}${location.search}`)
  }, [location])
  return null
}

/**
 * DevLogger visible POR DEFECTO en dev Y en producción (restauración 2026-06-07).
 *
 * Contexto: KAL-NEW-6 (commit 889e117) gateó el panel a dev-only / opt-in en
 * producción como "hardening" de seguridad que Diego nunca pidió. Esta app es
 * un PROTOTIPO en depuración activa (no un servicio vivo para familias reales);
 * Diego necesita el logger visible por defecto para depurar los muchos bugs
 * abiertos. Por eso revertimos el gating no solicitado y dejamos el panel ON.
 *
 * Default: ON (dev y prod). Interruptor explícito de OFF preservado para cuando
 * la app salga a producción con familias reales — entonces se re-gatea a opt-in.
 * Apagar (cualquiera de los dos):
 *   - URL `?debug=0` (o `#…?debug=0`) — persiste el OFF en localStorage.
 *   - localStorage `kis_devlog = '0'` (set una vez; sobrevive navegación).
 * Volver a encender: `?debug=1` o borrar la clave de localStorage.
 *
 * El panel ya redacta PII (KAL-11 + KAL-NEW-11) y arranca colapsado.
 */
function shouldShowDevLogger() {
  try {
    const qs = new URLSearchParams(
      window.location.search || (window.location.hash.split('?')[1] || '')
    );
    const q = qs.get('debug');
    if (q === '0') { localStorage.setItem('kis_devlog', '0'); return false; }
    if (q === '1') { localStorage.removeItem('kis_devlog'); return true; }
    return localStorage.getItem('kis_devlog') !== '0';
  } catch (_) {
    return true; // default ON incluso si localStorage falla
  }
}

function App() {
  const showDevLogger = shouldShowDevLogger()

  useEffect(() => {
    log.info('App mounted', {
      endpoint: import.meta.env.VITE_GAS_ENDPOINT ? '✓ set' : '✗ MISSING',
      recaptcha: import.meta.env.VITE_RECAPTCHA_SITE_KEY ? '✓ set' : '✗ not set',
    })
    // DBG-SESSION marker: confirma que el E2E corre sobre el build instrumentado.
    log.warn('[DBG build] enr-debug-instrumentation-1 — pasada E2E (8 bugs)')
  }, [])

  return (
    <WizardProvider>
      <ErrorBoundary>
      <Suspense fallback={<div className="spinner" style={{ marginTop: 80 }} />}>
        <RouteLogger />
        <Routes>
          <Route path="/"                element={<LandingPage />}      />
          <Route path="/consent"         element={<ConsentPage />}      />
          <Route path="/apply"           element={<WizardPage />}       />
          <Route path="/resume/:token"   element={<ResumePage />}       />
          <Route path="/report/:token"   element={<ReportUnsolicitedPage />} />
          <Route path="/confirmation"    element={<ConfirmationPage />}   />
          <Route path="/privacy"         element={<PrivacyPolicyPage />} />
          {/* DL-E38: /sign eliminado (host técnico coyuntural). El wizard es UN flujo
              continuo 1→11 en /apply; los pasos de firma 8-11 se renderizan inline y el
              signing_token se resuelve server-side en la recuperación (nunca en la URL,
              KAL-7). Redirect sin lógica de token para bookmarks/links antiguos. */}
          <Route path="/sign"            element={<Navigate to="/apply" replace />} />
          <Route path="*"               element={<LandingPage />}        />
        </Routes>
      </Suspense>
      </ErrorBoundary>
      {showDevLogger && <DevLogger />}
    </WizardProvider>
  )
}

export default App
