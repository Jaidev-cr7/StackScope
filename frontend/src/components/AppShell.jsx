// The application shell.
//
// The top bar is the only chrome in the app: it says where you are, who you
// are, and gives you one way out (sign out). Everything else lives in the
// page, so a page never has to think about layout.
import { NavLink, useNavigate } from 'react-router-dom';

import { useAuth } from '../auth/AuthContext.jsx';

export default function AppShell({ children }) {
  const { user, logout } = useAuth();
  const navigate = useNavigate();

  const signOut = async () => {
    await logout();
    navigate('/login', { replace: true });
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <NavLink to="/" className="topbar__brand">
          <span className="topbar__mark" aria-hidden="true">
            CI
          </span>
          CI Investigator
        </NavLink>

        <nav className="topbar__nav" aria-label="Main">
          <NavLink to="/" className="btn btn--ghost btn--sm" end>
            Investigations
          </NavLink>
        </nav>

        <div className="topbar__spacer" />

        <div className="topbar__user">
          <span>{user?.email}</span>
          <button type="button" className="btn btn--ghost btn--sm" onClick={signOut}>
            Sign out
          </button>
        </div>
      </header>

      <main className="page">{children}</main>
    </div>
  );
}
