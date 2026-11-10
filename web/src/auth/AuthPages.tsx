import { useEffect, useState, type FormEvent, type ReactNode } from 'react';
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom';
import { api, type Me } from '../api';
import { useAuth } from '../App';
import { ErrorText } from '../components/ui';

function AuthShell({ title, children, footer }: { title: string; children: ReactNode; footer?: ReactNode }) {
  return (
    <div className="auth-page">
      <div className="auth-card">
        <div className="auth-logo">
          <img src="/favicon.svg" width={36} height={36} alt="" />
          <span>Tracker</span>
        </div>
        <h1>{title}</h1>
        {children}
      </div>
      {footer && <div className="auth-footer">{footer}</div>}
    </div>
  );
}

function useNextPath() {
  const [params] = useSearchParams();
  const next = params.get('next');
  return next && next.startsWith('/') && !next.startsWith('//') ? next : '/';
}

function useAfterLogin() {
  const { setMe } = useAuth();
  const nav = useNavigate();
  const next = useNextPath();
  return (me: Me) => {
    setMe(me);
    nav(next, { replace: true });
  };
}

export function LoginPage() {
  const { me, instance } = useAuth();
  const after = useAfterLogin();
  const nav = useNavigate();
  const next = useNextPath();
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (me) nav(next, { replace: true });
    else if (instance?.needs_setup) nav('/signup', { replace: true });
  }, [me, instance, nav, next]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      after(await api.post<Me>('/auth/login', { email, password }));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthShell
      title="Sign in"
      footer={
        <>
          {instance?.signup_allowed && (
            <>
              New here? <Link to="/signup">Create an account</Link> ·{' '}
            </>
          )}
          <Link to="/forgot-password">Forgot password?</Link>
        </>
      }
    >
      <form onSubmit={submit} className="form">
        <label>
          Email or username
          <input autoFocus value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="username" required />
        </label>
        <label>
          Password
          <input type="password" value={password} onChange={(e) => setPassword(e.target.value)} autoComplete="current-password" required />
        </label>
        <ErrorText error={error} />
        <button className="btn primary block" disabled={busy}>
          {busy ? 'Signing in…' : 'Sign in'}
        </button>
      </form>
    </AuthShell>
  );
}

export function SignupPage() {
  const { instance } = useAuth();
  const after = useAfterLogin();
  const [f, setF] = useState({ name: '', email: '', password: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  if (instance && !instance.signup_allowed) {
    return (
      <AuthShell title="Sign-up is closed" footer={<Link to="/login">Back to sign in</Link>}>
        <p>This server only accepts new accounts by invitation. Ask an administrator or project owner to invite you.</p>
      </AuthShell>
    );
  }
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setBusy(true);
    setError(null);
    try {
      after(await api.post<Me>('/auth/signup', f));
    } catch (err) {
      setError(err);
    } finally {
      setBusy(false);
    }
  };
  return (
    <AuthShell title={instance?.needs_setup ? 'Set up your Tracker' : 'Create your account'} footer={!instance?.needs_setup && <>Have an account? <Link to="/login">Sign in</Link></>}>
      {instance?.needs_setup && <p className="muted">This is a fresh installation. The first account becomes the administrator.</p>}
      <form onSubmit={submit} className="form">
        <label>
          Full name
          <input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
        </label>
        <label>
          Email
          <input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} autoComplete="email" required />
        </label>
        <label>
          Password <span className="muted">(8+ characters)</span>
          <input type="password" minLength={8} value={f.password} onChange={(e) => setF({ ...f, password: e.target.value })} autoComplete="new-password" required />
        </label>
        <ErrorText error={error} />
        <button className="btn primary block" disabled={busy}>
          {busy ? 'Creating…' : 'Create account'}
        </button>
      </form>
    </AuthShell>
  );
}

export function InvitePage() {
  const { token } = useParams();
  const after = useAfterLogin();
  const [info, setInfo] = useState<{ email: string; name: string; projects: string[] } | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [name, setName] = useState('');
  const [password, setPassword] = useState('');
  useEffect(() => {
    api
      .get<{ email: string; name: string; projects: string[] }>(`/auth/invitation/${token}`)
      .then((i) => {
        setInfo(i);
        setName(i.name);
      })
      .catch(setError);
  }, [token]);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      after(await api.post<Me>(`/auth/invitation/${token}/accept`, { name, password }));
    } catch (err) {
      setError(err);
    }
  };
  return (
    <AuthShell title="Accept invitation" footer={<Link to="/login">Already set up? Sign in</Link>}>
      {!info && <ErrorText error={error} />}
      {info && (
        <form onSubmit={submit} className="form">
          <p>
            You've been invited as <b>{info.email}</b>
            {info.projects.length > 0 && <> to {info.projects.map((p) => `“${p}”`).join(', ')}</>}.
          </p>
          <label>
            Full name
            <input value={name} onChange={(e) => setName(e.target.value)} required />
          </label>
          <label>
            Choose a password
            <input type="password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required autoComplete="new-password" />
          </label>
          <ErrorText error={error} />
          <button className="btn primary block">Join</button>
        </form>
      )}
    </AuthShell>
  );
}

export function ForgotPasswordPage() {
  const { instance } = useAuth();
  const [email, setEmail] = useState('');
  const [sent, setSent] = useState(false);
  return (
    <AuthShell title="Reset password" footer={<Link to="/login">Back to sign in</Link>}>
      {!instance?.email_enabled ? (
        <p>Email is not configured on this server. Ask an administrator to generate a password reset link for you.</p>
      ) : sent ? (
        <p>If an account exists for that address, a reset link is on its way.</p>
      ) : (
        <form
          className="form"
          onSubmit={async (e) => {
            e.preventDefault();
            await api.post('/auth/password_reset', { email });
            setSent(true);
          }}
        >
          <label>
            Email
            <input type="email" value={email} onChange={(e) => setEmail(e.target.value)} required autoFocus />
          </label>
          <button className="btn primary block">Send reset link</button>
        </form>
      )}
    </AuthShell>
  );
}

export function ResetPasswordPage() {
  const [params] = useSearchParams();
  const after = useAfterLogin();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<unknown>(null);
  return (
    <AuthShell title="Choose a new password">
      <form
        className="form"
        onSubmit={async (e) => {
          e.preventDefault();
          try {
            after(await api.post<Me>('/auth/password_reset/confirm', { token: params.get('token'), password }));
          } catch (err) {
            setError(err);
          }
        }}
      >
        <label>
          New password
          <input type="password" minLength={8} value={password} onChange={(e) => setPassword(e.target.value)} required autoFocus autoComplete="new-password" />
        </label>
        <ErrorText error={error} />
        <button className="btn primary block">Save password</button>
      </form>
    </AuthShell>
  );
}
