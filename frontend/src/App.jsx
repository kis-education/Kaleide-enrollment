import { Routes, Route, useLocation } from 'react-router-dom'
import { Suspense, useEffect, Component } from 'react'
import { WizardProvider } from './context/WizardContext'
import LandingPage      from './pages/LandingPage'
import ConsentPage      from './pages/ConsentPage'
import WizardPage       from './pages/WizardPage'
import ResumePage       from './pages/ResumePage'
import ReportUnsolicitedPage from './pages/ReportUnsolicitedPage'
import ConfirmationPage       from './pages/ConfirmationPage'
import PrivacyPolicyPage from './pages/PrivacyPolicyPage'
import SigningWizardPage from './pages/SigningWizardPage'
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
 * KAL-NEW-6 + restauración 2026-06-06: el DevLogger se rinde SIEMPRE en dev, y
 * en producción SOLO cuando se opta-in explícitamente. Esto restaura el panel
 * que "desapareció" (gateado a dev-only por KAL-NEW-6 commit 889e117, invisible
 * en el build de producción que sirve admissions.kaleide.org) sin reabrir la
 * exposición por defecto a cualquier familia anónima en un screen-share.
 *
 * Opt-in en producción (cualquiera de los dos):
 *   - URL `?debug=1` (o `#…?debug=1`) — persiste en localStorage para reloads.
 *   - localStorage `kis_devlog = '1'` (set una vez; sobrevive navegación).
 * Desactivar: `?debug=0` o borrar la clave de localStorage.
 *
 * El panel ya redacta PII (KAL-11 + KAL-NEW-11) y arranca colapsado, así que el
 * riesgo residual es bajo; el opt-in lo deja invisible para el tráfico normal.
 */
function shouldShowDevLogger() {
  if (!import.meta.env.PROD) return true; // dev: siempre visible
  try {
    const qs = new URLSearchParams(
      window.location.search || (window.location.hash.split('?')[1] || '')
    );
    const q = qs.get('debug');
    if (q === '1') { localStorage.setItem('kis_devlog', '1'); return true; }
    if (q === '0') { localStorage.removeItem('kis_devlog'); return false; }
    return localStorage.getItem('kis_devlog') === '1';
  } catch (_) {
    return false;
  }
}

function App() {
  const showDevLogger = shouldShowDevLogger()

  useEffect(() => {
    log.info('App mounted', {
      endpoint: import.meta.env.VITE_GAS_ENDPOINT ? '✓ set' : '✗ MISSING',
      recaptcha: import.meta.env.VITE_RECAPTCHA_SITE_KEY ? '✓ set' : '✗ not set',
    })
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
          <Route path="/sign"            element={<SigningWizardPage />} />
          <Route path="*"               element={<LandingPage />}        />
        </Routes>
      </Suspense>
      </ErrorBoundary>
      {showDevLogger && <DevLogger />}
    </WizardProvider>
  )
}

export default App
