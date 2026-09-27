import { createContext, useContext, useEffect, useState } from 'react';
import { Link, NavLink, Navigate, Route, Routes, useNavigate } from 'react-router-dom';
import { api, auth, type User } from './api';
import AdminPage from './pages/AdminPage';
import CheckoutPage from './pages/CheckoutPage';
import EventPage from './pages/EventPage';
import EventsPage from './pages/EventsPage';
import LoginPage from './pages/LoginPage';
import MyBookingsPage from './pages/MyBookingsPage';

interface AuthCtx {
  user: User | null;
  login: (name: string) => Promise<void>;
  logout: () => void;
}
const AuthContext = createContext<AuthCtx>(null!);
export const useAuth = () => useContext(AuthContext);

export default function App() {
  const [user, setUser] = useState<User | null>(null);
  const [ready, setReady] = useState(false);
  const navigate = useNavigate();

  useEffect(() => {
    if (!auth.token) return setReady(true);
    api<{ user: User }>('/auth/me')
      .then(({ data }) => setUser(data.user))
      .catch(() => (auth.token = null))
      .finally(() => setReady(true));
  }, []);

  const login = async (name: string) => {
    const { data } = await api<{ user: User; token: string }>('/auth/login', { method: 'POST', body: { name } });
    auth.token = data.token;
    setUser(data.user);
  };
  const logout = () => {
    auth.token = null;
    setUser(null);
    navigate('/login');
  };

  if (!ready) return null;

  const navClass = ({ isActive }: { isActive: boolean }) =>
    `px-3 py-1.5 rounded-md text-sm ${isActive ? 'bg-slate-900 text-white' : 'text-slate-600 hover:bg-slate-200'}`;

  return (
    <AuthContext.Provider value={{ user, login, logout }}>
      <header className="border-b bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-2 px-4 py-3">
          <Link to="/" className="mr-4 font-semibold tracking-tight">
            🎟️ SeatLock
          </Link>
          {user && (
            <nav className="flex flex-wrap gap-1">
              <NavLink to="/" end className={navClass}>
                Events
              </NavLink>
              <NavLink to="/bookings" className={navClass}>
                My bookings
              </NavLink>
              {user.isAdmin && (
                <NavLink to="/admin" className={navClass}>
                  Admin
                </NavLink>
              )}
            </nav>
          )}
          {user && (
            <div className="ml-auto flex items-center gap-3 text-sm">
              <span className="text-slate-500">
                {user.name}
                {user.isAdmin && ' (admin)'}
              </span>
              <button onClick={logout} className="text-slate-600 underline">
                Log out
              </button>
            </div>
          )}
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-6">
        <Routes>
          <Route path="/login" element={user ? <Navigate to="/" /> : <LoginPage />} />
          <Route path="/" element={<RequireUser><EventsPage /></RequireUser>} />
          <Route path="/events/:eventId" element={<RequireUser><EventPage /></RequireUser>} />
          <Route path="/checkout/:holdId" element={<RequireUser><CheckoutPage /></RequireUser>} />
          <Route path="/bookings" element={<RequireUser><MyBookingsPage /></RequireUser>} />
          <Route path="/admin" element={<RequireUser><AdminPage /></RequireUser>} />
          <Route path="*" element={<Navigate to="/" />} />
        </Routes>
      </main>
    </AuthContext.Provider>
  );
}

function RequireUser({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  return user ? <>{children}</> : <Navigate to="/login" />;
}

export function ErrorBox({ error }: { error: string | null }) {
  if (!error) return null;
  return <div className="rounded-md border border-red-200 bg-red-50 px-3 py-2 text-sm text-red-700">{error}</div>;
}
