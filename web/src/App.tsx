import { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { BrowserRouter, Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { api, onUnauthenticated, type Me } from './api';
import { Spinner } from './components/ui';
import { Header } from './components/Header';
import { LoginPage, SignupPage, InvitePage, ResetPasswordPage, ForgotPasswordPage } from './auth/AuthPages';
import { Dashboard } from './pages/Dashboard';
import { ProfilePage } from './pages/ProfilePage';
import { AdminPage } from './pages/AdminPage';
import { WorkspacePage } from './pages/WorkspacePage';
import { ProjectPage } from './project/ProjectPage';
import { StoryRedirect } from './pages/StoryRedirect';

export interface Instance {
  version: string;
  signup_allowed: boolean;
  needs_setup: boolean;
  email_enabled: boolean;
}

interface AuthCtx {
  me: Me | null;
  instance: Instance | null;
  setMe: (m: Me | null) => void;
  refreshMe: () => Promise<void>;
}
const Ctx = createContext<AuthCtx>(null!);
export const useAuth = () => useContext(Ctx);
export const useMe = () => useContext(Ctx).me!;

export function App() {
  const [me, setMe] = useState<Me | null>(null);
  const [instance, setInstance] = useState<Instance | null>(null);
  const [loading, setLoading] = useState(true);

  const refreshMe = useCallback(async () => {
    try {
      setMe(await api.get<Me>('/me'));
    } catch {
      setMe(null);
    }
  }, []);

  useEffect(() => {
    Promise.all([api.get<Instance>('/instance').then(setInstance), refreshMe()]).finally(() => setLoading(false));
    return onUnauthenticated(() => setMe(null));
  }, [refreshMe]);

  if (loading) {
    return (
      <div className="center-page">
        <Spinner />
      </div>
    );
  }

  return (
    <Ctx.Provider value={{ me, instance, setMe, refreshMe }}>
      <BrowserRouter>
        <Routes>
          <Route path="/login" element={<LoginPage />} />
          <Route path="/signup" element={<SignupPage />} />
          <Route path="/forgot-password" element={<ForgotPasswordPage />} />
          <Route path="/reset-password" element={<ResetPasswordPage />} />
          <Route path="/invite/:token" element={<InvitePage />} />
          <Route path="/*" element={<Authed />} />
        </Routes>
      </BrowserRouter>
    </Ctx.Provider>
  );
}

function Authed() {
  const { me, instance } = useAuth();
  const loc = useLocation();
  if (!me) {
    if (instance?.needs_setup) return <Navigate to="/signup" replace />;
    return <Navigate to={`/login?next=${encodeURIComponent(loc.pathname + loc.search)}`} replace />;
  }
  return (
    <div className="app">
      <Header />
      <main className="app-main">
        <Routes>
          <Route path="/" element={<Dashboard />} />
          <Route path="/profile" element={<ProfilePage />} />
          <Route path="/admin" element={<AdminPage />} />
          <Route path="/workspaces" element={<WorkspacePage />} />
          <Route path="/workspaces/:workspaceId" element={<WorkspacePage />} />
          <Route path="/stories/:storyId" element={<StoryRedirect />} />
          <Route path="/projects/:projectId/*" element={<ProjectPage />} />
          <Route path="*" element={<div className="page"><h1>Not found</h1></div>} />
        </Routes>
      </main>
    </div>
  );
}
