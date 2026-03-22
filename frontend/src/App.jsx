import { Routes, Route, useLocation } from 'react-router-dom'
import { Suspense, useEffect } from 'react'
import { WizardProvider } from './context/WizardContext'
import LandingPage      from './pages/LandingPage'
import ConsentPage      from './pages/ConsentPage'
import WizardPage       from './pages/WizardPage'
import ResumePage       from './pages/ResumePage'
import ConfirmationPage from './pages/ConfirmationPage'
import DevLogger        from './components/DevLogger'
import * as log         from './logger'

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
      <DevLogger />
    </WizardProvider>
  )
}

export default App
