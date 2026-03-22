import { Routes, Route, useLocation } from 'react-router-dom'
import { Suspense, useEffect, Component } from 'react'
import { WizardProvider } from './context/WizardContext'
import LandingPage      from './pages/LandingPage'
import ConsentPage      from './pages/ConsentPage'
import WizardPage       from './pages/WizardPage'
import ResumePage       from './pages/ResumePage'
import ConfirmationPage from './pages/ConfirmationPage'
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

function App() {
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
          <Route path="/confirmation"    element={<ConfirmationPage />} />
          <Route path="*"               element={<LandingPage />}      />
        </Routes>
      </Suspense>
      </ErrorBoundary>
      <DevLogger />
    </WizardProvider>
  )
}

export default App
