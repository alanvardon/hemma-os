import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './styles/global.css'
import './styles/auth.css'
import './styles/home.css'
import './styles/flip-clock.css'
import './styles/components.css'
import './styles/konsultkalkyl.css'
import './styles/lonevaxling.css'
import './styles/student-loan.css'
import './styles/bolanekoll.css'
import './styles/manadsavslut.css'
import './styles/huskalendern.css'
import './styles/modals.css'
import './styles/dashboard.css'
import './styles/charts.css'
import './styles/transitions.css'
import './styles/hushallsbudget.css'
import './styles/touch-inputs.css'
import './styles/error.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
