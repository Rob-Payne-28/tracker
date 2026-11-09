import { useEffect, useState, type FormEvent } from 'react';
import { useNavigate } from 'react-router-dom';
import { api, type Project, type Role, type Webhook } from '../api';
import { useMe } from '../App';
import { useProject } from './store';
import { Avatar, ErrorText } from '../components/ui';
import { refreshProjects } from '../hooks';
import { timeAgo } from '../util';

export function ProjectSettings() {
  const p = useProject();
  return (
    <div className="page settings-page">
      {p.isOwner && <GeneralSettings />}
      <MembersSettings />
      {p.isOwner && <ReviewTypesSettings />}
      {p.canEdit && <IntegrationsSettings />}
      {p.isOwner && <WebhooksSettings />}
      {p.canEdit && <ImportSettings />}
      <DangerZone />
    </div>
  );
}

const WEEKDAYS = ['Sunday', 'Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday'];
const SCALES: Record<string, string> = { '0,1,2,3,5,8': 'Fibonacci (0,1,2,3,5,8)', '0,1,2,3': 'Linear (0,1,2,3)', '0,1,2,4,8': 'Powers of 2 (0,1,2,4,8)' };

function GeneralSettings() {
  const p = useProject();
  const project = p.board!.project;
  const [f, setF] = useState<Partial<Project>>(project);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => setF(project), [project]);
  const set = (k: keyof Project, v: unknown) => {
    setF({ ...f, [k]: v });
    setSaved(false);
  };
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    try {
      const keys: (keyof Project)[] = [
        'name', 'description', 'iteration_length', 'week_start_day', 'point_scale', 'initial_velocity', 'velocity_averaged_over',
        'bugs_and_chores_are_estimatable', 'automatic_planning', 'enable_tasks', 'public', 'start_date', 'time_zone',
      ];
      await api.put(`/projects/${project.id}`, Object.fromEntries(keys.map((k) => [k, f[k]])));
      setSaved(true);
      void p.refresh();
      void refreshProjects();
    } catch (err) {
      setError(err);
    }
  };
  const custom = !SCALES[f.point_scale ?? ''];
  return (
    <form className="card form" onSubmit={submit}>
      <h2>Project settings</h2>
      <div className="form-grid">
        <label>
          Name
          <input value={f.name ?? ''} onChange={(e) => set('name', e.target.value)} required />
        </label>
        <label className="span2">
          Description
          <textarea rows={2} value={f.description ?? ''} onChange={(e) => set('description', e.target.value)} />
        </label>
        <label>
          Iteration length
          <select value={f.iteration_length} onChange={(e) => set('iteration_length', Number(e.target.value))}>
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>
                {n} week{n > 1 ? 's' : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          Iterations start on
          <select value={f.week_start_day} onChange={(e) => set('week_start_day', e.target.value)}>
            {WEEKDAYS.map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </label>
        <label>
          Project start date
          <input type="date" value={f.start_date ?? ''} onChange={(e) => set('start_date', e.target.value)} />
        </label>
        <label>
          Time zone
          <input value={f.time_zone ?? ''} onChange={(e) => set('time_zone', e.target.value)} list="tz-list" />
          <datalist id="tz-list">
            {(Intl as any).supportedValuesOf?.('timeZone')?.map((tz: string) => <option key={tz} value={tz} />)}
          </datalist>
        </label>
        <label>
          Point scale
          <select value={custom ? 'custom' : f.point_scale} onChange={(e) => set('point_scale', e.target.value === 'custom' ? '0,1,2,3,4,5' : e.target.value)}>
            {Object.entries(SCALES).map(([v, l]) => (
              <option key={v} value={v}>
                {l}
              </option>
            ))}
            <option value="custom">Custom…</option>
          </select>
        </label>
        {custom && (
          <label>
            Custom scale
            <input value={f.point_scale ?? ''} onChange={(e) => set('point_scale', e.target.value)} placeholder="0,1,2,4,8,16" />
          </label>
        )}
        <label>
          Initial velocity
          <input type="number" min={1} value={f.initial_velocity} onChange={(e) => set('initial_velocity', Number(e.target.value))} />
        </label>
        <label>
          Velocity averaged over
          <select value={f.velocity_averaged_over} onChange={(e) => set('velocity_averaged_over', Number(e.target.value))}>
            {[1, 2, 3, 4, 5, 6, 8, 10].map((n) => (
              <option key={n} value={n}>
                {n} iteration{n > 1 ? 's' : ''}
              </option>
            ))}
          </select>
        </label>
      </div>
      <div className="checks">
        <label className="check">
          <input type="checkbox" checked={!!f.bugs_and_chores_are_estimatable} onChange={(e) => set('bugs_and_chores_are_estimatable', e.target.checked)} />
          Bugs and chores may be given points
        </label>
        <label className="check">
          <input type="checkbox" checked={!!f.automatic_planning} onChange={(e) => set('automatic_planning', e.target.checked)} />
          Automatic planning (fill iterations from the backlog by velocity). When off, plan stories into iterations manually.
        </label>
        <label className="check">
          <input type="checkbox" checked={!!f.enable_tasks} onChange={(e) => set('enable_tasks', e.target.checked)} />
          Enable tasks
        </label>
        <label className="check">
          <input type="checkbox" checked={!!f.public} onChange={(e) => set('public', e.target.checked)} />
          Public — anyone with the link can view (read-only)
        </label>
      </div>
      <ErrorText error={error} />
      <div className="row gap">
        <button className="btn primary">Save settings</button>
        {saved && <span className="muted">Saved.</span>}
      </div>
    </form>
  );
}

function MembersSettings() {
  const p = useProject();
  const me = useMe();
  const [email, setEmail] = useState('');
  const [role, setRole] = useState<Role>('member');
  const [invite, setInvite] = useState<string | null>(null);
  const [error, setError] = useState<unknown>(null);
  const add = async (e: FormEvent) => {
    e.preventDefault();
    setError(null);
    setInvite(null);
    try {
      const r = await api.post<{ invite_url?: string }>(`/projects/${p.projectId}/memberships`, email.includes('@') ? { email, role } : { username: email, role });
      setEmail('');
      if (r.invite_url) setInvite(r.invite_url);
      void p.refreshMeta();
    } catch (err) {
      setError(err);
    }
  };
  return (
    <div className="card">
      <h2>Members</h2>
      <table className="table">
        <thead>
          <tr>
            <th>Person</th>
            <th>Username</th>
            <th>Role</th>
            <th />
          </tr>
        </thead>
        <tbody>
          {p.members.map((m) => (
            <tr key={m.id}>
              <td>
                <Avatar person={m.person} size={22} /> {m.person.name} <span className="muted small">{m.person.email}</span>
              </td>
              <td>@{m.person.username}</td>
              <td>
                {p.isOwner ? (
                  <select
                    value={m.role}
                    onChange={async (e) => {
                      try {
                        await api.put(`/projects/${p.projectId}/memberships/${m.id}`, { role: e.target.value });
                        void p.refreshMeta();
                        void p.refresh();
                      } catch (err) {
                        setError(err);
                      }
                    }}
                  >
                    <option value="owner">Owner</option>
                    <option value="member">Member</option>
                    <option value="viewer">Viewer</option>
                  </select>
                ) : (
                  m.role
                )}
              </td>
              <td>
                {(p.isOwner || m.person.id === me.id) && (
                  <button
                    className="link-btn small danger"
                    onClick={async () => {
                      if (!confirm(m.person.id === me.id ? 'Leave this project?' : `Remove ${m.person.name}?`)) return;
                      try {
                        await api.del(`/projects/${p.projectId}/memberships/${m.id}`);
                        void p.refreshMeta();
                      } catch (err) {
                        setError(err);
                      }
                    }}
                  >
                    {m.person.id === me.id ? 'leave' : 'remove'}
                  </button>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {p.isOwner && (
        <form className="row gap wrap" onSubmit={add}>
          <input placeholder="Email or username" value={email} onChange={(e) => setEmail(e.target.value)} required />
          <select value={role} onChange={(e) => setRole(e.target.value as Role)}>
            <option value="member">Member</option>
            <option value="owner">Owner</option>
            <option value="viewer">Viewer</option>
          </select>
          <button className="btn primary">Add member</button>
        </form>
      )}
      {invite && (
        <div className="notice">
          No account existed for that email, so an invitation was created. Share this link with them:
          <code className="copyable" onClick={() => navigator.clipboard?.writeText(invite)}>
            {invite}
          </code>
        </div>
      )}
      <ErrorText error={error} />
    </div>
  );
}

function ReviewTypesSettings() {
  const p = useProject();
  const [name, setName] = useState('');
  return (
    <div className="card">
      <h2>Review types</h2>
      <p className="muted">Reviews let teammates sign off on code, design, QA and more before a story is accepted.</p>
      <ul className="plain-list">
        {p.reviewTypes.map((t) => (
          <li key={t.id} className="row gap">
            <span className={t.hidden ? 'muted' : ''}>{t.name}</span>
            <div className="spacer" />
            <button
              className="link-btn small"
              onClick={async () => {
                await api.put(`/projects/${p.projectId}/review_types/${t.id}`, { hidden: !t.hidden });
                void p.refreshMeta();
              }}
            >
              {t.hidden ? 'show' : 'hide'}
            </button>
            <button
              className="link-btn small danger"
              onClick={async () => {
                if (!confirm(`Delete review type "${t.name}" and all its reviews?`)) return;
                await api.del(`/projects/${p.projectId}/review_types/${t.id}`);
                void p.refreshMeta();
              }}
            >
              delete
            </button>
          </li>
        ))}
      </ul>
      <form
        className="row gap"
        onSubmit={async (e) => {
          e.preventDefault();
          await api.post(`/projects/${p.projectId}/review_types`, { name });
          setName('');
          void p.refreshMeta();
        }}
      >
        <input placeholder="New review type" value={name} onChange={(e) => setName(e.target.value)} required />
        <button className="btn">Add</button>
      </form>
    </div>
  );
}

function IntegrationsSettings() {
  const me = useMe();
  const url = `${location.origin}/api/v1/integrations/vcs?token=${me.api_token}`;
  return (
    <div className="card">
      <h2>Source control</h2>
      <p>
        Link commits to stories by referencing them in commit messages: <code>[#123]</code> adds a comment, <code>[Finishes #123]</code> (or Fixes / Completes) finishes the story,{' '}
        <code>[Delivers #123]</code> delivers it.
      </p>
      <p>
        In GitHub, GitLab or Gitea, add a <b>push webhook</b> (content type <code>application/json</code>) pointing to this URL. It contains <b>your</b> API token, so commits are recorded as you —
        consider a dedicated bot account.
      </p>
      <code className="copyable block" onClick={() => navigator.clipboard?.writeText(url)} title="Click to copy">
        {url}
      </code>
      <p className="muted small">
        Or post commits from CI with <code>POST /api/v1/source_commits</code> — see the <a href="/api/docs#/Integrations">API docs</a>.
      </p>
    </div>
  );
}

function WebhooksSettings() {
  const p = useProject();
  const [hooks, setHooks] = useState<Webhook[]>([]);
  const [url, setUrl] = useState('');
  const [error, setError] = useState<unknown>(null);
  const [result, setResult] = useState<string | null>(null);
  const load = () => api.get<Webhook[]>(`/projects/${p.projectId}/webhooks`).then(setHooks);
  useEffect(() => {
    void load();
  }, [p.projectId]); // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <div className="card">
      <h2>Webhooks</h2>
      <p className="muted">
        Every change in this project is POSTed as JSON to these URLs. Verify deliveries with the <code>X-Tracker-Signature</code> header (HMAC-SHA256 of the body with the secret).
      </p>
      <table className="table">
        <tbody>
          {hooks.map((h) => (
            <tr key={h.id}>
              <td>
                <div className="mono">{h.url}</div>
                <div className="muted small">
                  secret <code>{h.secret}</code>
                  {h.last_delivered_at && (
                    <>
                      {' '}
                      · last delivery {timeAgo(h.last_delivered_at)} — {h.last_error ? <span className="danger-text">{h.last_error}</span> : `HTTP ${h.last_status}`}
                    </>
                  )}
                </div>
              </td>
              <td className="nowrap">
                <label className="check small">
                  <input
                    type="checkbox"
                    checked={h.enabled}
                    onChange={async (e) => {
                      await api.put(`/projects/${p.projectId}/webhooks/${h.id}`, { enabled: e.target.checked });
                      void load();
                    }}
                  />
                  enabled
                </label>{' '}
                <button
                  className="link-btn small"
                  onClick={async () => {
                    const r = await api.post<{ status: number | null; error: string | null }>(`/projects/${p.projectId}/webhooks/${h.id}/test`);
                    setResult(r.error ? `Test failed: ${r.error}` : `Test delivered (HTTP ${r.status})`);
                    void load();
                  }}
                >
                  test
                </button>{' '}
                <button
                  className="link-btn small danger"
                  onClick={async () => {
                    if (!confirm('Delete this webhook?')) return;
                    await api.del(`/projects/${p.projectId}/webhooks/${h.id}`);
                    void load();
                  }}
                >
                  delete
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {result && <div className="notice">{result}</div>}
      <form
        className="row gap"
        onSubmit={async (e) => {
          e.preventDefault();
          setError(null);
          try {
            await api.post(`/projects/${p.projectId}/webhooks`, { url });
            setUrl('');
            void load();
          } catch (err) {
            setError(err);
          }
        }}
      >
        <input type="url" placeholder="https://example.com/hooks/tracker" value={url} onChange={(e) => setUrl(e.target.value)} required />
        <button className="btn">Add webhook</button>
      </form>
      <ErrorText error={error} />
    </div>
  );
}

function ImportSettings() {
  const p = useProject();
  const [result, setResult] = useState<{ imported: number; errors: { row: number; error: string }[] } | null>(null);
  const [error, setError] = useState<unknown>(null);
  return (
    <div className="card">
      <h2>Import & export</h2>
      <p>
        <a className="btn" href={`/api/v1/projects/${p.projectId}/export.csv`}>
          Export all stories (CSV)
        </a>
      </p>
      <p className="muted">
        Import a CSV with columns such as Title, Type, Estimate, Current State, Labels, Description, Requested By, Owned By, Comment, Task / Task Status. Exports from this server (and other
        trackers using these column names) import directly.
      </p>
      <input
        type="file"
        accept=".csv,text/csv"
        onChange={async (e) => {
          const file = e.target.files?.[0];
          if (!file) return;
          setError(null);
          setResult(null);
          try {
            setResult(await api.post(`/projects/${p.projectId}/import`, { csv: await file.text() }));
            void p.refresh();
            void p.refreshMeta();
          } catch (err) {
            setError(err);
          }
          e.target.value = '';
        }}
      />
      {result && (
        <div className="notice">
          Imported {result.imported} stories.
          {result.errors.length > 0 && (
            <ul>
              {result.errors.slice(0, 20).map((er) => (
                <li key={er.row}>
                  Row {er.row}: {er.error}
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
      <ErrorText error={error} />
    </div>
  );
}

function DangerZone() {
  const p = useProject();
  const nav = useNavigate();
  const project = p.board!.project;
  if (!p.isOwner) return null;
  return (
    <div className="card danger-card">
      <h2>Danger zone</h2>
      <div className="row gap wrap">
        <button
          className="btn"
          onClick={async () => {
            await api.put(`/projects/${project.id}`, { archived: !project.archived });
            void p.refresh();
            void refreshProjects();
          }}
        >
          {project.archived ? 'Unarchive project' : 'Archive project'}
        </button>
        <button
          className="btn danger"
          onClick={async () => {
            const typed = prompt(`This permanently deletes "${project.name}" and all its stories. Type the project name to confirm.`);
            if (typed !== project.name) return;
            await api.del(`/projects/${project.id}`);
            void refreshProjects();
            nav('/');
          }}
        >
          Delete project
        </button>
      </div>
    </div>
  );
}
