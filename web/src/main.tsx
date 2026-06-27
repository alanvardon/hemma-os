import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './styles/tokens.css'
import './styles/global.css'
import './styles/home.css'
import './styles/components.css'
import './styles/konsultkalkyl.css'
import './styles/lonevaxling.css'
import './styles/bolanekoll.css'
import './styles/manadsavslut.css'
import './styles/modals.css'
import './styles/charts.css'
import './styles/transitions.css'
// Imported last: scoped under .hb-root, it overrides the shared generic-name
// rules (field / sum-card / mobile-bar / chart-overlay) on the budget route.
import './styles/hushallsbudget.css'
import App from './App.tsx'

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
