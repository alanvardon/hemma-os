// AppShell — the authenticated app: the router, AuthGate (and so Supabase),
// every tool store and the update/persistence banners. Split out of App.tsx
// (plan 132) so App.tsx can branch to the public `#/lon/<token>` page
// (SalarySubmitPage) before any of this renders.
import { createHashRouter, Navigate, Outlet, RouterProvider, ScrollRestoration } from 'react-router-dom'
import AuthGate from './components/AuthGate'
import Home from './routes/Home'
import ScenariosDashboard from './routes/ScenariosDashboard'
import Bostadskalkyl from './routes/Bostadskalkyl'
import Konsultkalkyl from './routes/Konsultkalkyl'
import Lonevaxling from './routes/Lonevaxling'
import StudentLoan from './routes/StudentLoan'
import Bolanekoll from './routes/Bolanekoll'
import Manadsavslut from './routes/Manadsavslut'
import Hushallsbudget from './routes/Hushallsbudget'
import Huskalendern from './routes/Huskalendern'
import Loner from './routes/Loner'
import PersistenceNotice from './components/PersistenceNotice'
import UpdateNotice from './components/UpdateNotice'
import ErrorBoundary from './components/ErrorBoundary'
import OfflineBanner from './components/OfflineBanner'
import { ConfirmProvider } from './components/useConfirm'

function Layout() {
  return (
    <>
      <ScrollRestoration getKey={(location) => location.pathname} />
      <OfflineBanner />
      <Outlet />
    </>
  )
}

// A data router (not <HashRouter>) so React Router's View Transitions —
// `<Link viewTransition>` + useViewTransitionState — are available (plan 6).
// Still hash-based for GitHub Pages.
const router = createHashRouter([
  {
    element: <Layout />,
    errorElement: <ErrorBoundary />,
    children: [
      { path: '/', element: <Home /> },
      { path: '/bostadskalkyl', element: <ScenariosDashboard /> },
      { path: '/bostadskalkyl/new', element: <Bostadskalkyl /> },
      { path: '/bostadskalkyl/:id', element: <Bostadskalkyl /> },
      { path: '/konsultkalkyl', element: <Konsultkalkyl /> },
      { path: '/lonevaxling', element: <Lonevaxling /> },
      { path: '/student-loan', element: <StudentLoan /> },
      { path: '/bolanekoll', element: <Bolanekoll /> },
      { path: '/manadsavslut', element: <Manadsavslut /> },
      { path: '/hushallsbudget', element: <Hushallsbudget /> },
      { path: '/loner', element: <Loner /> },
      { path: '/huskalendern', element: <Huskalendern /> },
      // Catch-all: unknown hashes (incl. the magic-link `#access_token…`
      // callback, which supabase-js consumes on load) fall back to the hub
      // instead of React Router's error page — plan 16a.
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
])

export default function AppShell() {
  return (
    <>
      <AuthGate>
        <ConfirmProvider>
          <RouterProvider router={router} />
          <PersistenceNotice />
        </ConfirmProvider>
      </AuthGate>
      {/* Outside AuthGate: a stale bundle should offer a reload even from the
          login screen (plan 100). */}
      <UpdateNotice />
    </>
  )
}
