// The session died.
//
// The app sends the user here when any request comes back 401 mid-session,
// instead of silently bouncing them to a login form they never left. The
// page says what happened and offers the way back.
import { Link, useLocation } from 'react-router-dom';

export default function SessionExpired() {
  const location = useLocation();
  const from = location.state?.from;

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <h1 className="auth-card__title">Your session expired</h1>
        <p className="auth-card__subtitle">
          Sign in again to pick up where you left off. Nothing was lost.
        </p>

        <div className="stack">
          <Link className="btn btn--primary btn--block" to="/login" state={from ? { from } : undefined}>
            Sign in again
          </Link>
          <Link className="btn btn--ghost btn--block" to="/">
            Back to investigations
          </Link>
        </div>
      </div>
    </div>
  );
}
