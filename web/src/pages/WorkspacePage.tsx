import { useEffect, useState } from 'react';
import { Link, useNavigate, useParams } from 'react-router-dom';
import { api, type Workspace } from '../api';
import { useProjectsList } from '../hooks';
import { ProjectProvider, useProject } from '../project/store';
import { CurrentBacklogPanel } from '../project/panels/Panels';
import { Spinner } from '../components/ui';
import { cx } from '../util';

export function WorkspacePage() {
  const { workspaceId } = useParams();
  const nav = useNavigate();
  const projects = useProjectsList();
  const [list, setList] = useState<Workspace[] | null>(null);
  const [editing, setEditing] = useState(false);
  const load = () => api.get<Workspace[]>('/my/workspaces').then(setList);
  useEffect(() => {
    void load();
  }, []);
  const ws = list?.find((w) => w.id === Number(workspaceId));

  useEffect(() => {
    if (list && !workspaceId && list.length) nav(`/workspaces/${list[0].id}`, { replace: true });
  }, [list, workspaceId, nav]);

  if (!list) return <div className="center-page"><Spinner /></div>;

  return (
    <div className="workspace-page">
      <div className="project-bar">
        <h1 className="project-name">Workspaces</h1>
        <nav className="project-tabs">
          {list.map((w) => (
            <Link key={w.id} to={`/workspaces/${w.id}`} className={cx('tab', w.id === ws?.id && 'active')}>
              {w.name}
            </Link>
          ))}
        </nav>
        <div className="spacer" />
        {ws && (
          <button className="btn small" onClick={() => setEditing(!editing)}>
            {editing ? 'Done' : 'Edit workspace'}
          </button>
        )}
        <button
          className="btn small primary"
          onClick={async () => {
            const name = prompt('Workspace name');
            if (!name) return;
            const w = await api.post<Workspace>('/my/workspaces', { name, project_ids: projects.slice(0, 3).map((p) => p.id) });
            await load();
            nav(`/workspaces/${w.id}`);
            setEditing(true);
          }}
        >
          + New workspace
        </button>
      </div>
      {list.length === 0 && (
        <div className="page">
          <div className="card empty-state">
            <h2>See several projects side by side</h2>
            <p>A workspace shows the current iteration and backlog of multiple projects at once. Create one to get started.</p>
          </div>
        </div>
      )}
      {ws && editing && (
        <div className="page">
          <div className="card">
            <h2>Projects in “{ws.name}”</h2>
            <div className="checks">
              {projects.map((p) => (
                <label key={p.id} className="check">
                  <input
                    type="checkbox"
                    checked={ws.project_ids.includes(p.id)}
                    onChange={async (e) => {
                      const ids = e.target.checked ? [...ws.project_ids, p.id] : ws.project_ids.filter((x) => x !== p.id);
                      await api.put(`/my/workspaces/${ws.id}`, { project_ids: ids });
                      void load();
                    }}
                  />
                  {p.name}
                </label>
              ))}
            </div>
            <div className="row gap">
              <button
                className="btn small"
                onClick={async () => {
                  const name = prompt('Rename workspace', ws.name);
                  if (name) {
                    await api.put(`/my/workspaces/${ws.id}`, { name });
                    void load();
                  }
                }}
              >
                Rename
              </button>
              <button
                className="btn small danger"
                onClick={async () => {
                  if (!confirm('Delete this workspace? Projects are not affected.')) return;
                  await api.del(`/my/workspaces/${ws.id}`);
                  await load();
                  nav('/workspaces');
                }}
              >
                Delete workspace
              </button>
            </div>
          </div>
        </div>
      )}
      {ws && (
        <div className="panels workspace-panels">
          {ws.project_ids.map((id) => (
            <ProjectProvider key={id} projectId={id}>
              <WorkspaceColumn />
            </ProjectProvider>
          ))}
        </div>
      )}
    </div>
  );
}

function WorkspaceColumn() {
  const p = useProject();
  const [adding, setAdding] = useState(false);
  if (!p.board) return <div className="panel"><Spinner /></div>;
  return (
    <div className="workspace-column">
      <Link className="workspace-project-name" to={`/projects/${p.projectId}`}>
        {p.board.project.name}
      </Link>
      <CurrentBacklogPanel adding={adding} setAdding={setAdding} />
    </div>
  );
}
