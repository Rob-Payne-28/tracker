import { useEffect, useRef, useState } from 'react';
import { NavLink, Route, Routes, useNavigate, useParams } from 'react-router-dom';
import { api } from '../api';
import { ProjectProvider, useProject } from './store';
import { ErrorText, Modal, Spinner } from '../components/ui';
import { CurrentBacklogPanel, DonePanel, EpicsPanel, HistoryPanel, IceboxPanel, LabelsPanel, MyWorkPanel, PANEL_TITLES, SearchPanel, type PanelId } from './panels/Panels';
import { StoryEditor } from './StoryEditor';
import { ProjectSettings } from './ProjectSettings';
import { AnalyticsPage } from './AnalyticsPage';
import { usePref, useProjectsList } from '../hooks';
import { cx } from '../util';

export function ProjectPage() {
  const projectId = Number(useParams().projectId);
  return (
    <ProjectProvider projectId={projectId}>
      <ProjectLayout />
    </ProjectProvider>
  );
}

function ProjectLayout() {
  const p = useProject();
  if (p.error && !p.board) {
    return (
      <div className="page">
        <ErrorText error={p.error} />
      </div>
    );
  }
  if (!p.board) {
    return (
      <div className="center-page">
        <Spinner />
      </div>
    );
  }
  const project = p.board.project;
  const base = `/projects/${project.id}`;
  return (
    <div className="project-page">
      <div className="project-bar">
        <h1 className="project-name">{project.name}</h1>
        {project.archived && <span className="tag">archived</span>}
        {project.public && <span className="tag">public</span>}
        <nav className="project-tabs">
          <NavLink end to={base} className={({ isActive }) => cx('tab', isActive && 'active')}>
            Stories
          </NavLink>
          <NavLink to={`${base}/analytics`} className={({ isActive }) => cx('tab', isActive && 'active')}>
            Analytics
          </NavLink>
          <NavLink to={`${base}/settings`} className={({ isActive }) => cx('tab', isActive && 'active')}>
            {p.isOwner ? 'Settings' : 'Members'}
          </NavLink>
        </nav>
        <div className="spacer" />
        <VelocityBadge />
      </div>
      <Routes>
        <Route path="analytics" element={<AnalyticsPage />} />
        <Route path="settings/*" element={<ProjectSettings />} />
        <Route path="stories/:storyId" element={<Board deepLink />} />
        <Route path="*" element={<Board />} />
      </Routes>
    </div>
  );
}

function VelocityBadge() {
  const p = useProject();
  const [editing, setEditing] = useState(false);
  const b = p.board!;
  return (
    <div className="velocity-badge">
      {editing ? (
        <input
          type="number"
          min={1}
          autoFocus
          defaultValue={b.velocity}
          className="velocity-input"
          onBlur={(e) => {
            const v = Number(e.target.value);
            p.setVelocityOverride(v && v !== b.project.current_velocity ? v : null);
            setEditing(false);
          }}
          onKeyDown={(e) => e.key === 'Enter' && (e.target as HTMLInputElement).blur()}
          aria-label="What-if velocity"
        />
      ) : (
        <button className={cx('velocity', p.velocityOverride != null && 'override')} onClick={() => setEditing(true)} title="Click to try a different velocity (what-if)">
          Velocity <b>{b.velocity}</b>
        </button>
      )}
      {p.velocityOverride && (
        <button className="link-btn small" onClick={() => p.setVelocityOverride(null)}>
          reset
        </button>
      )}
    </div>
  );
}

const ALL_PANELS: PanelId[] = ['mywork', 'current', 'icebox', 'done', 'epics', 'labels', 'history'];
const SHORTCUTS: Record<string, PanelId> = { m: 'mywork', b: 'current', i: 'icebox', d: 'done', e: 'epics', l: 'labels', h: 'history' };

function Board({ deepLink }: { deepLink?: boolean }) {
  const p = useProject();
  const nav = useNavigate();
  const { storyId } = useParams();
  const [panels, setPanels] = usePref<PanelId[]>(`panels:${p.projectId}`, ['current', 'icebox']);
  const [search, setSearch] = useState<string | null>(null);
  const [searchDraft, setSearchDraft] = useState('');
  const [addingTo, setAddingTo] = useState<'backlog' | 'icebox' | null>(null);
  const [help, setHelp] = useState(false);
  const searchRef = useRef<HTMLInputElement>(null);

  const toggle = (id: PanelId) => setPanels(panels.includes(id) ? panels.filter((x) => x !== id) : [...panels, id]);
  const show = (id: PanelId) => !panels.includes(id) && setPanels([...panels, id]);
  const runSearch = (q: string) => {
    setSearchDraft(q);
    setSearch(q);
  };

  // Keyboard shortcuts
  useEffect(() => {
    const h = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement;
      if (t.closest('input, textarea, select, [contenteditable]') || e.metaKey || e.ctrlKey || e.altKey) return;
      if (e.key === '?') setHelp(true);
      else if (e.key === '/') {
        e.preventDefault();
        searchRef.current?.focus();
      } else if (e.key === 'a' && p.canEdit) {
        e.preventDefault();
        show('current');
        setAddingTo('backlog');
      } else if (e.key === 'A' && p.canEdit) {
        e.preventDefault();
        show('icebox');
        setAddingTo('icebox');
      } else if (SHORTCUTS[e.key]) toggle(SHORTCUTS[e.key]);
      else if (e.key === 'Escape') {
        p.clearSelected();
        setSearch(null);
      }
    };
    window.addEventListener('keydown', h);
    return () => window.removeEventListener('keydown', h);
  });

  // Scroll to a story when its anchor link (#story-123) is clicked in markdown.
  useEffect(() => {
    const h = (e: MouseEvent) => {
      const a = (e.target as HTMLElement).closest('a.story-ref') as HTMLAnchorElement | null;
      if (!a) return;
      e.preventDefault();
      const id = Number(a.getAttribute('href')!.replace('#story-', ''));
      nav(`/projects/${p.projectId}/stories/${id}`);
    };
    document.addEventListener('click', h);
    return () => document.removeEventListener('click', h);
  }, [nav, p.projectId]);

  return (
    <div className="board-wrap">
      <aside className="sidebar">
        {p.canEdit && (
          <button
            className="btn primary block"
            onClick={() => {
              show('current');
              setAddingTo('backlog');
            }}
          >
            + Add story
          </button>
        )}
        <form
          className="sidebar-search"
          onSubmit={(e) => {
            e.preventDefault();
            if (searchDraft.trim()) setSearch(searchDraft.trim());
          }}
        >
          <input ref={searchRef} type="search" placeholder="Search stories  ( / )" value={searchDraft} onChange={(e) => setSearchDraft(e.target.value)} aria-label="Search stories" />
        </form>
        <nav className="panel-toggles">
          {ALL_PANELS.map((id) => (
            <button key={id} className={cx('panel-toggle', panels.includes(id) && 'on')} onClick={() => toggle(id)}>
              <span className="dot" />
              {PANEL_TITLES[id]}
              <span className="kbd">{Object.entries(SHORTCUTS).find(([, v]) => v === id)?.[0]}</span>
            </button>
          ))}
        </nav>
        <div className="sidebar-foot">
          <button className="link-btn small" onClick={() => setHelp(true)}>
            Keyboard shortcuts (?)
          </button>
          <a className="link-btn small" href={`/api/v1/projects/${p.projectId}/export.csv`}>
            Export CSV
          </a>
        </div>
      </aside>

      <div className="panels">
        {search && <SearchPanel query={search} onClose={() => setSearch(null)} />}
        {ALL_PANELS.filter((id) => panels.includes(id)).map((id) => {
          const close = () => toggle(id);
          switch (id) {
            case 'mywork':
              return <MyWorkPanel key={id} onClose={close} />;
            case 'current':
              return <CurrentBacklogPanel key={id} onClose={close} adding={addingTo === 'backlog'} setAdding={(v) => setAddingTo(v ? 'backlog' : null)} />;
            case 'icebox':
              return <IceboxPanel key={id} onClose={close} adding={addingTo === 'icebox'} setAdding={(v) => setAddingTo(v ? 'icebox' : null)} />;
            case 'done':
              return <DonePanel key={id} onClose={close} />;
            case 'epics':
              return <EpicsPanel key={id} onClose={close} onSearch={runSearch} />;
            case 'labels':
              return <LabelsPanel key={id} onClose={close} onSearch={runSearch} />;
            case 'history':
              return <HistoryPanel key={id} onClose={close} />;
          }
        })}
        {panels.length === 0 && !search && <div className="empty panels-empty">Open a panel from the sidebar.</div>}
      </div>

      {p.selected.size > 0 && <BulkBar />}
      {p.flash && (
        <div className="flash" role="status" onClick={() => p.setFlash(null)}>
          {p.flash}
        </div>
      )}
      {deepLink && storyId && (
        <Modal title={`Story #${storyId}`} onClose={() => nav(`/projects/${p.projectId}`)} wide>
          <StoryEditor storyId={Number(storyId)} onClose={() => nav(`/projects/${p.projectId}`)} />
        </Modal>
      )}
      {help && <ShortcutHelp onClose={() => setHelp(false)} />}
    </div>
  );
}

function BulkBar() {
  const p = useProject();
  const projects = useProjectsList();
  const ids = [...p.selected];
  const run = async (body: Record<string, unknown>) => {
    try {
      await api.put(`/projects/${p.projectId}/stories/bulk`, { story_ids: ids, ...body });
      p.clearSelected();
      void p.refresh();
      void p.refreshMeta();
    } catch (e: any) {
      p.setFlash(e.message);
    }
  };
  return (
    <div className="bulk-bar" role="toolbar" aria-label="Bulk actions">
      <b>{ids.length} selected</b>
      <button className="btn small" onClick={() => run({ move: 'top_of_backlog' })}>
        Top of backlog
      </button>
      <button className="btn small" onClick={() => run({ move: 'bottom_of_backlog' })}>
        Bottom of backlog
      </button>
      <button className="btn small" onClick={() => run({ move: 'top_of_icebox' })}>
        To icebox
      </button>
      <button
        className="btn small"
        onClick={() => {
          const l = prompt('Add label(s), comma separated');
          if (l) void run({ add_labels: l.split(',').map((s) => s.trim()).filter(Boolean) });
        }}
      >
        Add label
      </button>
      <button
        className="btn small"
        onClick={() => {
          const l = prompt('Remove label(s), comma separated');
          if (l) void run({ remove_labels: l.split(',').map((s) => s.trim()).filter(Boolean) });
        }}
      >
        Remove label
      </button>
      <select
        className="small"
        value=""
        onChange={(e) => e.target.value && confirm('Move the selected stories to another project?') && run({ project_id: Number(e.target.value) })}
        aria-label="Move to project"
      >
        <option value="">Move to project…</option>
        {projects
          .filter((x) => x.id !== p.projectId && x.role !== 'viewer')
          .map((x) => (
            <option key={x.id} value={x.id}>
              {x.name}
            </option>
          ))}
      </select>
      <button
        className="btn small danger"
        onClick={async () => {
          if (!confirm(`Delete ${ids.length} stories?`)) return;
          await api.post(`/projects/${p.projectId}/stories/bulk_delete`, { story_ids: ids });
          p.clearSelected();
          void p.refresh();
        }}
      >
        Delete
      </button>
      <div className="spacer" />
      <button className="link-btn" onClick={p.clearSelected}>
        Clear
      </button>
    </div>
  );
}

function ShortcutHelp({ onClose }: { onClose: () => void }) {
  const rows: [string, string][] = [
    ['a', 'Add story to backlog'],
    ['A', 'Add story to icebox'],
    ['/', 'Search'],
    ['m', 'Toggle My Work'],
    ['b', 'Toggle Current/Backlog'],
    ['i', 'Toggle Icebox'],
    ['d', 'Toggle Done'],
    ['e', 'Toggle Epics'],
    ['l', 'Toggle Labels'],
    ['h', 'Toggle History'],
    ['Esc', 'Clear selection / close search'],
    ['?', 'This help'],
  ];
  return (
    <Modal title="Keyboard shortcuts" onClose={onClose}>
      <table className="table">
        <tbody>
          {rows.map(([k, d]) => (
            <tr key={k}>
              <td>
                <span className="kbd">{k}</span>
              </td>
              <td>{d}</td>
            </tr>
          ))}
        </tbody>
      </table>
      <h4>Search syntax</h4>
      <p className="small">
        Free text plus filters: <code>label:ui</code> <code>type:bug</code> <code>state:started</code> <code>owner:me</code> <code>requester:jd</code> <code>epic:"Onboarding"</code>{' '}
        <code>is:blocked</code> <code>has:attachment</code> <code>estimate:none</code> <code>id:12,14</code> <code>created_since:2026-01-01</code> <code>includedone:true</code>. Prefix with <code>-</code> to
        negate.
      </p>
    </Modal>
  );
}
