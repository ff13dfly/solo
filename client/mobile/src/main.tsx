import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.tsx'
import { ErrorProvider } from './context/ErrorContext'
import { initSimulatorPatch } from './lib/simulator-patch'

// Initialize sandbox mode if nested in iframe
initSimulatorPatch();

createRoot(document.getElementById('root')!).render(
  <ErrorProvider>
    <App />
  </ErrorProvider>
)
