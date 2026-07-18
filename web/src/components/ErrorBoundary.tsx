import { useRouteError, isRouteErrorResponse } from 'react-router-dom'

export default function ErrorBoundary() {
  const error = useRouteError()
  const offline = typeof navigator !== 'undefined' && !navigator.onLine
  const detail = isRouteErrorResponse(error)
    ? `${error.status} ${error.statusText}`
    : error instanceof Error
      ? error.message
      : String(error)

  return (
    <main className="errpage" role="alert">
      <div className="errpage-card">
        <p className="errpage-kicker">Hemma·OS</p>
        <h1 className="errpage-title">
          {offline ? 'Du är offline' : 'Något gick fel'}
        </h1>
        <p className="errpage-lead">
          {offline
            ? 'Hemma·OS når inte molnet just nu. Dina ändringar sparas lokalt och synkas när du är tillbaka online.'
            : 'Ett oväntat fel uppstod. Ladda om sidan — dina sparade data finns kvar.'}
        </p>
        <div className="errpage-actions">
          <button className="btn btn-primary" onClick={() => window.location.reload()}>
            Försök igen
          </button>
          <a
            className="btn btn-ghost"
            href={import.meta.env.BASE_URL + '#/'}
            onClick={() => setTimeout(() => window.location.reload(), 0)}
          >
            Till startsidan
          </a>
        </div>
        {import.meta.env.DEV && (
          <details className="errpage-detail">
            <summary>Felinformation (dev)</summary>
            <pre>{detail}</pre>
          </details>
        )}
      </div>
    </main>
  )
}
