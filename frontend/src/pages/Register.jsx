// Create an account.
//
// The password rules are the backend's rules. The UI repeats them so a user
// is not told "invalid input" after the fact, but the backend is what
// decides - a client-side rule is a convenience, never a control.
import { useState } from 'react';
import { Link, useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext.jsx';
import { errorMessage } from '../utils/format.js';

const MIN_PASSWORD_LENGTH = 10;

export default function Register() {
  const { register } = useAuth();
  const navigate = useNavigate();

  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState(null);
  const [busy, setBusy] = useState(false);

  const tooShort = password.length > 0 && password.length < MIN_PASSWORD_LENGTH;

  const submit = async (event) => {
    event.preventDefault();
    setBusy(true);
    setError(null);
    try {
      await register({ email, password });
      navigate('/', { replace: true });
    } catch (caught) {
      setError(errorMessage(caught, 'Could not create the account.'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="auth-shell">
      <div className="auth-card">
        <h1 className="auth-card__title">Create an account</h1>
        <p className="auth-card__subtitle">
          Accounts are local to this installation. Nothing is shared with anyone else.
        </p>

        {error ? (
          <div className="banner banner--danger" role="alert">
            <div className="banner__body">{error}</div>
          </div>
        ) : null}

        <form className="stack" onSubmit={submit}>
          <div className="field">
            <label className="field__label" htmlFor="register-email">
              Email
            </label>
            <input
              id="register-email"
              className="input"
              type="email"
              autoComplete="email"
              required
              value={email}
              onChange={(event) => setEmail(event.target.value)}
            />
          </div>

          <div className="field">
            <label className="field__label" htmlFor="register-password">
              Password
            </label>
            <input
              id="register-password"
              className="input"
              type="password"
              autoComplete="new-password"
              required
              minLength={MIN_PASSWORD_LENGTH}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
            {tooShort ? (
              <p className="field__error">Use at least {MIN_PASSWORD_LENGTH} characters.</p>
            ) : (
              <p className="field__hint">At least {MIN_PASSWORD_LENGTH} characters.</p>
            )}
          </div>

          <button type="submit" className="btn btn--primary btn--block" disabled={busy}>
            {busy ? 'Creating…' : 'Create account'}
          </button>
        </form>

        <p className="auth-card__footer">
          Already have an account? <Link to="/login">Sign in</Link>
        </p>
      </div>
    </div>
  );
}
