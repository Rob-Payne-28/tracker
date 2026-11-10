import { useEffect, useState } from 'react';
import { api } from '../api';
import { useMe } from '../App';
import { Avatar, ErrorText } from '../components/ui';

interface AdminUser {
  id: number;
  name: string;
  email: string;
  initials: string;
  username: string;
  is_admin: boolean;
  is_active: boolean;
  invited: boolean;
  project_count: number;
  created_at: string;
}

export function AdminPage() {
  const me = useMe();
  const [users, setUsers] = useState<AdminUser[]>([]);
  const [settings, setSettings] = useState<{ allow_signup: boolean; base_url: string; email_enabled: boolean; max_upload_mb: number } | null>(null);
  const [link, setLink] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [f, setF] = useState({ name: '', email: '' });
  const load = () => Promise.all([api.get<AdminUser[]>('/admin/users').then(setUsers), api.get<typeof settings>('/admin/settings').then(setSettings)]).catch(setError);
  useEffect(() => {
    void load();
  }, []);
  if (!me.is_admin) return <div className="page">Administrator access required.</div>;
  const update = async (id: number, body: Record<string, unknown>) => {
    try {
      await api.put(`/admin/users/${id}`, body);
      void load();
    } catch (e) {
      setError(e);
    }
  };
  return (
    <div className="page">
      <h1>Administration</h1>
      {settings && (
        <div className="card">
          <h2>Instance</h2>
          <label className="check">
            <input
              type="checkbox"
              checked={settings.allow_signup}
              onChange={async (e) => {
                await api.put('/admin/settings', { allow_signup: e.target.checked });
                void load();
              }}
            />
            Allow anyone to sign up (otherwise accounts are created by invitation)
          </label>
          <p className="muted small">
            Base URL <code>{settings.base_url}</code> · Email {settings.email_enabled ? 'enabled' : 'not configured (set SMTP_URL)'} · Upload limit {settings.max_upload_mb} MB
          </p>
        </div>
      )}
      <div className="card">
        <h2>Users ({users.length})</h2>
        <div className="table-scroll">
          <table className="table">
            <thead>
              <tr>
                <th>User</th>
                <th>Projects</th>
                <th>Status</th>
                <th>Admin</th>
                <th />
              </tr>
            </thead>
            <tbody>
              {users.map((u) => (
                <tr key={u.id} className={u.is_active ? '' : 'muted'}>
                  <td>
                    <Avatar person={u} size={22} /> {u.name} <span className="muted small">@{u.username} · {u.email}</span>
                  </td>
                  <td>{u.project_count}</td>
                  <td>{u.invited ? 'invited' : u.is_active ? 'active' : 'deactivated'}</td>
                  <td>
                    <input type="checkbox" checked={u.is_admin} disabled={u.id === me.id} onChange={(e) => update(u.id, { is_admin: e.target.checked })} aria-label="Administrator" />
                  </td>
                  <td className="nowrap">
                    <button
                      className="link-btn small"
                      onClick={async () => setLink((await api.post<{ reset_url: string }>(`/admin/users/${u.id}/password_reset_link`)).reset_url)}
                    >
                      reset link
                    </button>{' '}
                    {u.id !== me.id && (
                      <>
                        <button className="link-btn small" onClick={() => update(u.id, { is_active: !u.is_active })}>
                          {u.is_active ? 'deactivate' : 'activate'}
                        </button>{' '}
                        <button
                          className="link-btn small danger"
                          onClick={async () => {
                            if (!confirm(`Permanently delete ${u.name}? Prefer deactivating.`)) return;
                            await api.del(`/admin/users/${u.id}`);
                            void load();
                          }}
                        >
                          delete
                        </button>
                      </>
                    )}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
        {link && (
          <div className="notice">
            Share this password reset link (valid 24h):{' '}
            <code className="copyable" onClick={() => navigator.clipboard?.writeText(link)}>
              {link}
            </code>
          </div>
        )}
        <h3>Invite a user</h3>
        <form
          className="row gap wrap"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              const r = await api.post<{ invite_url?: string }>('/admin/users', f);
              setLink(r.invite_url ?? null);
              setF({ name: '', email: '' });
              void load();
            } catch (err) {
              setError(err);
            }
          }}
        >
          <input placeholder="Name" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
          <input type="email" placeholder="Email" value={f.email} onChange={(e) => setF({ ...f, email: e.target.value })} required />
          <button className="btn primary">Create invitation</button>
        </form>
        <ErrorText error={error} />
      </div>
    </div>
  );
}
