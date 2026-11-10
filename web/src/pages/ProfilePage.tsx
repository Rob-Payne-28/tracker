import { useState, type FormEvent } from 'react';
import { api, type Me } from '../api';
import { useAuth, useMe } from '../App';
import { ErrorText } from '../components/ui';

export function ProfilePage() {
  const me = useMe();
  const { setMe } = useAuth();
  const [f, setF] = useState({ name: me.name, initials: me.initials, username: me.username, email: me.email, time_zone: me.time_zone, email_notifications: me.email_notifications });
  const [pw, setPw] = useState({ current_password: '', new_password: '' });
  const [msg, setMsg] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [showToken, setShowToken] = useState(false);

  const save = async (e: FormEvent, body: Record<string, unknown>) => {
    e.preventDefault();
    setError(null);
    setMsg(null);
    try {
      setMe(await api.put<Me>('/me', body));
      setMsg('Saved.');
      setPw({ current_password: '', new_password: '' });
    } catch (err) {
      setError(err);
    }
  };

  return (
    <div className="page narrow">
      <h1>Profile</h1>
      <form className="card form" onSubmit={(e) => save(e, { ...f, ...(f.email !== me.email ? { current_password: pw.current_password } : {}) })}>
        <div className="form-grid">
          <label>
            Name
            <input value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
          </label>
          <label>
            Initials
            <input value={f.initials} maxLength={4} onChange={(e) => setF({ ...f, initials: e.target.value })} />
          </label>
          <label>
            Username <span className="muted small">(for @mentions)</span>
            <input value={f.username} onChange={(e) => setF({ ...f, username: e.target.value })} pattern="[A-Za-z0-9_]{2,30}" />
          </label>
          <label>
            Email
            <input type="email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} />
          </label>
          <label>
            Time zone
            <input value={f.time_zone} onChange={(e) => setF({ ...f, time_zone: e.target.value })} />
          </label>
        </div>
        {f.email !== me.email && (
          <label>
            Current password (required to change email)
            <input type="password" value={pw.current_password} onChange={(e) => setPw({ ...pw, current_password: e.target.value })} />
          </label>
        )}
        <label className="check">
          <input type="checkbox" checked={f.email_notifications} onChange={(e) => setF({ ...f, email_notifications: e.target.checked })} /> Email me notifications (when the server has email
          configured)
        </label>
        <button className="btn primary">Save profile</button>
      </form>

      <form className="card form" onSubmit={(e) => save(e, pw)}>
        <h2>Change password</h2>
        <label>
          Current password
          <input type="password" value={pw.current_password} onChange={(e) => setPw({ ...pw, current_password: e.target.value })} autoComplete="current-password" />
        </label>
        <label>
          New password
          <input type="password" minLength={8} value={pw.new_password} onChange={(e) => setPw({ ...pw, new_password: e.target.value })} autoComplete="new-password" required />
        </label>
        <button className="btn">Change password</button>
      </form>

      <div className="card">
        <h2>API token</h2>
        <p>
          Use this token to call the <a href="/api/docs">Tracker API</a>: send it as the <code>X-TrackerToken</code> header.
        </p>
        <div className="row gap">
          <code className="copyable" onClick={() => navigator.clipboard?.writeText(me.api_token)} title="Click to copy">
            {showToken ? me.api_token : '•'.repeat(24)}
          </code>
          <button className="btn small" onClick={() => setShowToken(!showToken)}>
            {showToken ? 'Hide' : 'Show'}
          </button>
          <button
            className="btn small danger"
            onClick={async () => {
              if (!confirm('Regenerate your API token? Integrations using the old token will stop working.')) return;
              setMe(await api.post<Me>('/me/regenerate_api_token'));
              setShowToken(true);
            }}
          >
            Regenerate
          </button>
        </div>
        <pre className="code-sample">{`curl -H "X-TrackerToken: ${showToken ? me.api_token : '$TOKEN'}" ${location.origin}/api/v1/projects`}</pre>
      </div>
      {msg && <div className="notice">{msg}</div>}
      <ErrorText error={error} />
    </div>
  );
}
