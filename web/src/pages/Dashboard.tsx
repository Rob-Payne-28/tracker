import { useEffect, useState, type FormEvent } from 'react';
import { Link, useNavigate } from 'react-router-dom';
import { api, type Project, type Story } from '../api';
import { ErrorText, TypeIcon } from '../components/ui';
import { refreshProjects, useProjectsList } from '../hooks';
import { useMe } from '../App';
import { cx } from '../util';

export function Dashboard() {
  const projects = useProjectsList();
  const me = useMe();
  const [creating, setCreating] = useState(false);
  const [showArchived, setShowArchived] = useState(false);
  const [archived, setArchived] = useState<Project[]>([]);
  const [work, setWork] = useState<{ owned: Story[]; to_accept: Story[]; to_review: Story[] } | null>(null);

  useEffect(() => {
    api.get<typeof work>('/my/work').then(setWork).catch(() => {});
  }, []);
  useEffect(() => {
    if (showArchived) api.get<Project[]>('/projects?include_archived=true').then((ps) => setArchived(ps.filter((p) => p.archived)));
  }, [showArchived]);

  const byId = new Map(projects.map((p) => [p.id, p]));

  return (
    <div className="page dashboard">
      <div className="row gap">
        <h1>Projects</h1>
        <div className="spacer" />
        <button className="btn primary" onClick={() => setCreating(true)}>
          + Create project
        </button>
      </div>
      {creating && <CreateProject onDone={() => setCreating(false)} />}
      {projects.length === 0 && !creating && (
        <div className="card empty-state">
          <h2>Welcome, {me.name.split(' ')[0]}!</h2>
          <p>Create your first project to start planning. Stories go into the icebox or backlog; Tracker fills iterations based on your team's velocity.</p>
          <button className="btn primary" onClick={() => setCreating(true)}>
            Create a project
          </button>
        </div>
      )}
      <div className="project-cards">
        {projects.map((p) => (
          <Link key={p.id} to={`/projects/${p.id}`} className="project-card">
            <div className="project-card-name">{p.name}</div>
            {p.description && <div className="muted small clamp">{p.description}</div>}
            <div className="project-card-stats">
              <span>
                Velocity <b>{p.current_velocity}</b>
              </span>
              <span>
                Iteration <b>{p.current_iteration_number}</b>
              </span>
              <span className="tag">{p.role}</span>
              {p.public && <span className="tag">public</span>}
            </div>
          </Link>
        ))}
      </div>
      <button className="link-btn small" onClick={() => setShowArchived(!showArchived)}>
        {showArchived ? 'Hide' : 'Show'} archived projects
      </button>
      {showArchived && (
        <ul className="plain-list">
          {archived.length === 0 && <li className="muted">No archived projects.</li>}
          {archived.map((p) => (
            <li key={p.id}>
              <Link to={`/projects/${p.id}`}>{p.name}</Link>
            </li>
          ))}
        </ul>
      )}

      {work && (work.owned.length > 0 || work.to_accept.length > 0 || work.to_review.length > 0) && (
        <div className="card">
          <h2>My work across projects</h2>
          <WorkList title="In my hands" stories={work.owned} projects={byId} />
          <WorkList title="Waiting for my acceptance" stories={work.to_accept} projects={byId} />
          <WorkList title="Reviews requested from me" stories={work.to_review} projects={byId} />
        </div>
      )}
    </div>
  );
}

function WorkList({ title, stories, projects }: { title: string; stories: Story[]; projects: Map<number, Project> }) {
  if (!stories.length) return null;
  return (
    <>
      <h4>{title}</h4>
      <ul className="work-list">
        {stories.map((s) => (
          <li key={s.id}>
            <Link to={`/projects/${s.project_id}/stories/${s.id}`} className={cx('work-item', `state-${s.current_state}`)}>
              <TypeIcon type={s.story_type} />
              <span className="work-name">{s.name}</span>
              <span className="tag small">{s.current_state}</span>
              <span className="muted small">{projects.get(s.project_id)?.name}</span>
            </Link>
          </li>
        ))}
      </ul>
    </>
  );
}

function CreateProject({ onDone }: { onDone: () => void }) {
  const nav = useNavigate();
  const [f, setF] = useState({ name: '', iteration_length: 1, week_start_day: 'Monday', point_scale: 'fibonacci', initial_velocity: 10, public: false });
  const [error, setError] = useState<unknown>(null);
  const submit = async (e: FormEvent) => {
    e.preventDefault();
    try {
      const p = await api.post<Project>('/projects', { ...f, time_zone: Intl.DateTimeFormat().resolvedOptions().timeZone });
      await refreshProjects();
      onDone();
      nav(`/projects/${p.id}`);
    } catch (err) {
      setError(err);
    }
  };
  return (
    <form className="card form" onSubmit={submit}>
      <h2>New project</h2>
      <div className="form-grid">
        <label className="span2">
          Project name
          <input autoFocus value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} required />
        </label>
        <label>
          Iteration length
          <select value={f.iteration_length} onChange={(e) => setF({ ...f, iteration_length: Number(e.target.value) })}>
            {[1, 2, 3, 4].map((n) => (
              <option key={n} value={n}>
                {n} week{n > 1 ? 's' : ''}
              </option>
            ))}
          </select>
        </label>
        <label>
          Iterations start on
          <select value={f.week_start_day} onChange={(e) => setF({ ...f, week_start_day: e.target.value })}>
            {['Monday', 'Tuesday', 'Wednesday', 'Thursday', 'Friday', 'Saturday', 'Sunday'].map((d) => (
              <option key={d}>{d}</option>
            ))}
          </select>
        </label>
        <label>
          Point scale
          <select value={f.point_scale} onChange={(e) => setF({ ...f, point_scale: e.target.value })}>
            <option value="fibonacci">Fibonacci (0,1,2,3,5,8)</option>
            <option value="linear">Linear (0,1,2,3)</option>
            <option value="powers_of_two">Powers of 2 (0,1,2,4,8)</option>
          </select>
        </label>
        <label>
          Initial velocity
          <input type="number" min={1} value={f.initial_velocity} onChange={(e) => setF({ ...f, initial_velocity: Number(e.target.value) })} />
        </label>
      </div>
      <label className="check">
        <input type="checkbox" checked={f.public} onChange={(e) => setF({ ...f, public: e.target.checked })} /> Public (read-only for anyone with the link)
      </label>
      <ErrorText error={error} />
      <div className="row gap">
        <button className="btn primary">Create project</button>
        <button type="button" className="btn" onClick={onDone}>
          Cancel
        </button>
      </div>
    </form>
  );
}
