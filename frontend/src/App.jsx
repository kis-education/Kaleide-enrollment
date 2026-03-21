import { Routes, Route } from 'react-router-dom'
import { Suspense } from 'react'
import { WizardProvider } from './context/WizardContext'
import LandingPage      from './pages/LandingPage'
import WizardPage       from './pages/WizardPage'
import ResumePage       from './pages/ResumePage'
import ConfirmationPage from './pages/ConfirmationPage'

function App() {
  return (
    <WizardProvider>
      <Suspense fallback={<div className="spinner" style={{ marginTop: 80 }} />}>
        <Routes>
          <Route path="/"                element={<LandingPage />}      />
          <Route path="/apply"           element={<WizardPage />}       />
          <Route path="/resume/:token"   element={<ResumePage />}       />
          <Route path="/confirmation"    element={<ConfirmationPage />} />
          <Route path="*"               element={<LandingPage />}      />
        </Routes>
      </Suspense>
    </WizardProvider>
  )
}

export default App
