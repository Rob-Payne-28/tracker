import { Fragment, useEffect, useState, type ReactNode } from 'react';
import { api, qs, type Activity, type Epic, type Iteration, type Story, type StoryType } from '../../api';
import { useProject, type Zone } from '../store';
import { DropList, StoryItem } from '../StoryItem';
import { Avatar, ErrorText, InlineEdit, Markdown, Spinner } from '../../components/ui';
import { addDays, cx, fullTime, isEstimatable, pointScale, shortDate, storyPoints, timeAgo } from '../../util';

export type PanelId = 'mywork' | 'current' | 'icebox' | 'done' | 'epics' | 'labels' | 'history' | 'search';

export const PANEL_TITLES: Record<PanelId, string> = {
  mywork: 'My Work',
  current: 'Current Iteration / Backlog',
  icebox: 'Icebox',
  done: 'Done',
  epics: 'Epics',
  labels: 'Labels',
  history: 'Project History',
  search: 'Search',
};

export function Panel({ id, title, meta, onClose, actions, children }: { id: string; title: ReactNode; meta?: ReactNode; onClose?: () => void; actions?: ReactNode; children: ReactNode }) {
  return (
    <section className={cx('panel', `panel-${id}`)} aria-label={typeof title === 'string' ? title : id}>
      <header className="panel-head">
        <h3>{title}</h3>
        {meta && <span className="panel-meta">{meta}</span>}
        <div className="spacer" />
        {actions}
        {onClose && (
          <button className="icon-btn" onClick={onClose} aria-label="Close panel" title="Close panel">
            ×
          </button>
        )}
      </header>
      <div className="panel-body">{children}</div>
    </section>
  );
}

// ---------------------------------------------------------------------------------------------
// New story form

export function NewStoryForm({ zone, onDone }: { zone: Zone; onDone: () => void }) {
  const p = useProject();
  const project = p.board!.project;
  const [f, setF] = useState({ name: '', story_type: 'feature' as StoryType, estimate: '' as string, description: '', labels: '' });
  const [error, setError] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const submit = async (keepOpen: boolean) => {
    if (!f.name.trim()) return;
    setBusy(true);
    try {
      const firstUnstarted = zone === 'backlog' ? firstBacklogStory(p) : undefined;
      await p.createStory({
        name: f.name,
        story_type: f.story_type,
        estimate: f.estimate === '' ? null : Number(f.estimate),
        description: f.description,
        labels: f.labels.split(',').map((s) => s.trim()).filter(Boolean),
        current_state: zone === 'icebox' ? 'unscheduled' : 'unstarted',
        ...(firstUnstarted ? { before_id: firstUnstarted } : {}),
      });
      if (keepOpen) setF({ ...f, name: '', description: '', estimate: '' });
      else onDone();
    } catch (e) {
      setError(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <form
      className="story-editor new-story"
      onSubmit={(e) => {
        e.preventDefault();
        void submit(false);
      }}
      onKeyDown={(e) => e.key === 'Escape' && onDone()}
    >
      <textarea autoFocus rows={2} placeholder="Story title" value={f.name} onChange={(e) => setF({ ...f, name: e.target.value })} onKeyDown={(e) => {
        if (e.key === 'Enter' && !e.shiftKey) {
          e.preventDefault();
          void submit(e.metaKey || e.ctrlKey);
        }
      }} />
      <div className="row gap wrap">
        <select value={f.story_type} onChange={(e) => setF({ ...f, story_type: e.target.value as StoryType })} aria-label="Story type">
          <option value="feature">Feature</option>
          <option value="bug">Bug</option>
          <option value="chore">Chore</option>
          <option value="release">Release</option>
        </select>
        {isEstimatable(f.story_type, project) && (
          <select value={f.estimate} onChange={(e) => setF({ ...f, estimate: e.target.value })} aria-label="Estimate">
            <option value="">Unestimated</option>
            {pointScale(project).map((n) => (
              <option key={n} value={n}>
                {n} pts
              </option>
            ))}
          </select>
        )}
        <input placeholder="labels, comma separated" value={f.labels} onChange={(e) => setF({ ...f, labels: e.target.value })} list="new-story-labels" />
        <datalist id="new-story-labels">
          {p.labels.map((l) => (
            <option key={l.id} value={l.name} />
          ))}
        </datalist>
      </div>
      <textarea rows={3} placeholder="Description (Markdown)" value={f.description} onChange={(e) => setF({ ...f, description: e.target.value })} />
      <ErrorText error={error} />
      <div className="row gap">
        <button className="btn primary small" disabled={busy || !f.name.trim()}>
          Add story
        </button>
        <button type="button" className="btn small" onClick={onDone}>
          Cancel
        </button>
        <span className="muted small">Enter to save · Ctrl+Enter to save and add another</span>
      </div>
    </form>
  );
}

function firstBacklogStory(p: ReturnType<typeof useProject>): number | undefined {
  for (const it of p.board!.iterations) {
    for (const id of it.story_ids) {
      const s = p.stories.get(id);
      if (s && (s.current_state === 'unstarted' || s.current_state === 'planned' as any)) return id;
    }
  }
  return undefined;
}

// ---------------------------------------------------------------------------------------------
// Current iteration + backlog

export function CurrentBacklogPanel({ onClose, adding, setAdding }: { onClose?: () => void; adding: boolean; setAdding: (v: boolean) => void }) {
  const p = useProject();
  const b = p.board!;
  const project = b.project;
  const ids = [...b.iterations.flatMap((i) => i.story_ids.filter((id) => p.stories.get(id)?.current_state !== 'accepted')), ...b.unplanned_ids];
  const backlogPoints = b.iterations.filter((i) => i.scope === 'backlog').reduce((n, i) => n + i.points, 0);
  return (
    <Panel
      id="current"
      title="Current / Backlog"
      meta={
        <span title="Velocity">
          v{b.velocity}
          {p.velocityOverride ? ' (what-if)' : ''} · {backlogPoints} pts in backlog
        </span>
      }
      onClose={onClose}
      actions={
        p.canEdit && (
          <button className="btn small add-story" onClick={() => setAdding(true)}>
            + Add story
          </button>
        )
      }
    >
      {adding && <NewStoryForm zone="backlog" onDone={() => setAdding(false)} />}
      <DropList zone="backlog" ids={ids} emptyText="The backlog is empty. Add a story or drag one from the icebox.">
        {b.iterations.map((it) => (
          <Fragment key={it.number}>
            <IterationHeader it={it} />
            {it.story_ids.map((id) => {
              const s = p.stories.get(id);
              return s ? <StoryItem key={id} story={s} zone="backlog" /> : null;
            })}
          </Fragment>
        ))}
        {b.unplanned_ids.length > 0 && (
          <>
            <div className="iteration-head unplanned">
              <span>Unplanned backlog</span>
              <span className="muted">Set a planned iteration on stories to schedule them</span>
            </div>
            {b.unplanned_ids.map((id) => {
              const s = p.stories.get(id);
              return s ? <StoryItem key={id} story={s} zone="backlog" /> : null;
            })}
          </>
        )}
      </DropList>
      {project.automatic_planning && b.iterations.length > 0 && <div className="muted small panel-foot">Iterations are projected from velocity {b.velocity}.</div>}
    </Panel>
  );
}

function IterationHeader({ it }: { it: Iteration }) {
  const p = useProject();
  const [editing, setEditing] = useState(false);
  const isCurrent = it.scope === 'current';
  const strength = Math.round(it.team_strength * 100);
  return (
    <div className={cx('iteration-head', it.scope)}>
      <span className="it-num">{it.number}</span>
      <span className="it-dates">
        {shortDate(it.start)} – {shortDate(addDays(it.finish, -1))}
      </span>
      {isCurrent && <span className="it-tag">Current</span>}
      {strength !== 100 && <span className="it-strength" title="Team strength">{strength}%</span>}
      <div className="spacer" />
      <span className="it-points" title={isCurrent ? 'Accepted / total points (capacity)' : 'Points (capacity)'}>
        {isCurrent ? `${it.accepted_points} of ${it.points}` : it.points} pts{it.capacity != null && <span className="muted"> / {Math.round(it.capacity * 10) / 10}</span>}
      </span>
      {p.canEdit && (
        <button className="icon-btn small" title="Edit iteration (team strength, length)" onClick={() => setEditing(!editing)}>
          ⚙
        </button>
      )}
      {editing && <IterationOverrideEditor it={it} onClose={() => setEditing(false)} />}
    </div>
  );
}

function IterationOverrideEditor({ it, onClose }: { it: Iteration; onClose: () => void }) {
  const p = useProject();
  const [strength, setStrength] = useState(Math.round(it.team_strength * 100));
  const [length, setLength] = useState(it.length);
  const project = p.board!.project;
  return (
    <div className="popover" onClick={(e) => e.stopPropagation()}>
      <b>Iteration {it.number}</b>
      <label>
        Team strength %
        <input type="number" min={0} max={500} value={strength} onChange={(e) => setStrength(Number(e.target.value))} />
      </label>
      <label>
        Length (weeks)
        <input type="number" min={1} max={8} value={length} onChange={(e) => setLength(Number(e.target.value))} />
      </label>
      <div className="row gap">
        <button
          className="btn primary small"
          onClick={async () => {
            await api.put(`/projects/${p.projectId}/iteration_overrides/${it.number}`, {
              team_strength: strength / 100,
              length: length === project.iteration_length ? null : length,
            });
            onClose();
            void p.refresh();
          }}
        >
          Save
        </button>
        <button
          className="btn small"
          onClick={async () => {
            await api.del(`/projects/${p.projectId}/iteration_overrides/${it.number}`);
            onClose();
            void p.refresh();
          }}
        >
          Reset
        </button>
        <button className="btn small" onClick={onClose}>
          Cancel
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// Icebox

export function IceboxPanel({ onClose, adding, setAdding }: { onClose?: () => void; adding: boolean; setAdding: (v: boolean) => void }) {
  const p = useProject();
  const ids = p.board!.icebox_ids;
  const pts = ids.reduce((n, id) => n + storyPoints(p.stories.get(id)!, p.board!.project), 0);
  return (
    <Panel
      id="icebox"
      title="Icebox"
      meta={`${ids.length} stories · ${pts} pts`}
      onClose={onClose}
      actions={
        p.canEdit && (
          <button className="btn small add-story" onClick={() => setAdding(true)}>
            + Add story
          </button>
        )
      }
    >
      {adding && <NewStoryForm zone="icebox" onDone={() => setAdding(false)} />}
      <DropList zone="icebox" ids={ids} emptyText="Ideas and unprioritised stories live here.">
        {ids.map((id) => {
          const s = p.stories.get(id);
          return s ? <StoryItem key={id} story={s} zone="icebox" /> : null;
        })}
      </DropList>
    </Panel>
  );
}

// ---------------------------------------------------------------------------------------------
// Done

export function DonePanel({ onClose }: { onClose?: () => void }) {
  const p = useProject();
  const [its, setIts] = useState<Iteration[] | null>(null);
  const [limit, setLimit] = useState(5);
  const total = p.board!.done_iteration_count;
  useEffect(() => {
    api.get<Iteration[]>(`/projects/${p.projectId}/iterations?scope=done&limit=${limit}`).then(setIts).catch(() => setIts([]));
  }, [p.projectId, limit, p.version]);
  return (
    <Panel id="done" title="Done" meta={`${total} iteration${total === 1 ? '' : 's'}`} onClose={onClose}>
      {!its && <Spinner />}
      {its && its.length === 0 && <div className="empty">Completed iterations will appear here.</div>}
      {its &&
        [...its].reverse().map((it) => (
          <Fragment key={it.number}>
            <div className="iteration-head done">
              <span className="it-num">{it.number}</span>
              <span className="it-dates">
                {shortDate(it.start)} – {shortDate(addDays(it.finish, -1))}
              </span>
              {it.team_strength !== 1 && <span className="it-strength">{Math.round(it.team_strength * 100)}%</span>}
              <div className="spacer" />
              <span className="it-points">{it.points} pts</span>
            </div>
            <StoryListWithMap stories={it.stories ?? []} />
          </Fragment>
        ))}
      {its && limit < total && (
        <button className="btn small block" onClick={() => setLimit(limit + 10)}>
          Show older iterations
        </button>
      )}
    </Panel>
  );
}

/** Renders stories that may not be part of the board (e.g. done or search results). */
function StoryListWithMap({ stories }: { stories: Story[] }) {
  const p = useProject();
  return (
    <>
      {stories.map((s) => (
        <StoryItem key={s.id} story={p.stories.get(s.id) ?? s} />
      ))}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// My work

export function MyWorkPanel({ onClose }: { onClose?: () => void }) {
  const p = useProject();
  const [data, setData] = useState<{ owned: Story[]; to_accept: Story[]; to_review: Story[] } | null>(null);
  useEffect(() => {
    api.get<typeof data>(`/my/work?project_id=${p.projectId}`).then(setData).catch(() => {});
  }, [p.projectId, p.version]);
  return (
    <Panel id="mywork" title="My Work" onClose={onClose}>
      {!data && <Spinner />}
      {data && (
        <>
          <SubList title="Owned by me" stories={data.owned} empty="Nothing in progress. Pick something from the backlog!" />
          <SubList title="Delivered — waiting for my acceptance" stories={data.to_accept} />
          <SubList title="Reviews requested from me" stories={data.to_review} />
        </>
      )}
    </Panel>
  );
}

function SubList({ title, stories, empty }: { title: string; stories: Story[]; empty?: string }) {
  if (!stories.length && !empty) return null;
  return (
    <>
      <div className="sub-head">
        {title} <span className="muted">({stories.length})</span>
      </div>
      {stories.length ? <StoryListWithMap stories={stories} /> : <div className="empty">{empty}</div>}
    </>
  );
}

// ---------------------------------------------------------------------------------------------
// Search

export function SearchPanel({ query, onClose }: { query: string; onClose?: () => void }) {
  const p = useProject();
  const [res, setRes] = useState<{ stories: Story[]; epics: Epic[]; total_points: number; total_points_completed: number } | null>(null);
  const [error, setError] = useState<unknown>(null);
  useEffect(() => {
    setRes(null);
    setError(null);
    api
      .get<NonNullable<typeof res>>(`/projects/${p.projectId}/search${qs({ query })}`)
      .then(setRes)
      .catch(setError);
  }, [p.projectId, query, p.version]);
  return (
    <Panel id="search" title={`Search: ${query}`} meta={res && `${res.stories.length} stories · ${res.total_points} pts`} onClose={onClose}>
      <ErrorText error={error} />
      {!res && !error && <Spinner />}
      {res?.epics.map((e) => (
        <div key={e.id} className="search-epic">
          Epic: <b>{e.name}</b>
        </div>
      ))}
      {res && res.stories.length === 0 && <div className="empty">No stories match. Tip: add includedone:true to include accepted stories.</div>}
      {res && <StoryListWithMap stories={res.stories} />}
    </Panel>
  );
}

// ---------------------------------------------------------------------------------------------
// Labels

export function LabelsPanel({ onClose, onSearch }: { onClose?: () => void; onSearch: (q: string) => void }) {
  const p = useProject();
  return (
    <Panel id="labels" title="Labels" meta={`${p.labels.length}`} onClose={onClose}>
      {p.labels.length === 0 && <div className="empty">Labels you add to stories show up here.</div>}
      <ul className="label-list">
        {p.labels.map((l) => (
          <li key={l.id}>
            <button className="label-chip big" onClick={() => onSearch(`label:"${l.name}"`)}>
              {l.name}
            </button>
            {l.epic_id && <span className="muted small">epic</span>}
            <span className="muted small">{l.story_count} stories</span>
            <div className="spacer" />
            {p.canEdit && (
              <>
                <button
                  className="link-btn small"
                  onClick={async () => {
                    const name = prompt('Rename label', l.name);
                    if (name && name !== l.name) {
                      try {
                        await api.put(`/projects/${p.projectId}/labels/${l.id}`, { name });
                        void p.refreshMeta();
                        void p.refresh();
                      } catch (e: any) {
                        p.setFlash(e.message);
                      }
                    }
                  }}
                >
                  rename
                </button>
                {!l.epic_id && (
                  <button
                    className="link-btn small danger"
                    onClick={async () => {
                      if (!confirm(`Delete label "${l.name}" from ${l.story_count} stories?`)) return;
                      await api.del(`/projects/${p.projectId}/labels/${l.id}`);
                      void p.refreshMeta();
                      void p.refresh();
                    }}
                  >
                    delete
                  </button>
                )}
              </>
            )}
          </li>
        ))}
      </ul>
    </Panel>
  );
}

// ---------------------------------------------------------------------------------------------
// Epics

export function EpicsPanel({ onClose, onSearch }: { onClose?: () => void; onSearch: (q: string) => void }) {
  const p = useProject();
  const [adding, setAdding] = useState(false);
  const [name, setName] = useState('');
  const [open, setOpen] = useState<number | null>(null);
  const [drag, setDrag] = useState<number | null>(null);
  return (
    <Panel
      id="epics"
      title="Epics"
      meta={`${p.epics.length}`}
      onClose={onClose}
      actions={
        p.canEdit && (
          <button className="btn small add-story" onClick={() => setAdding(true)}>
            + Add epic
          </button>
        )
      }
    >
      {adding && (
        <form
          className="story-editor new-story"
          onSubmit={async (e) => {
            e.preventDefault();
            try {
              await api.post(`/projects/${p.projectId}/epics`, { name });
              setName('');
              setAdding(false);
              void p.refreshMeta();
            } catch (err: any) {
              p.setFlash(err.message);
            }
          }}
        >
          <input autoFocus placeholder="Epic name" value={name} onChange={(e) => setName(e.target.value)} />
          <div className="row gap">
            <button className="btn primary small" disabled={!name.trim()}>
              Add epic
            </button>
            <button type="button" className="btn small" onClick={() => setAdding(false)}>
              Cancel
            </button>
          </div>
        </form>
      )}
      {p.epics.length === 0 && !adding && <div className="empty">Epics group related stories via a label and track progress.</div>}
      {p.epics.map((e) =>
        open === e.id ? (
          <EpicEditor key={e.id} epic={e} onClose={() => setOpen(null)} onSearch={onSearch} />
        ) : (
          <div
            key={e.id}
            className={cx('epic', drag === e.id && 'dragging')}
            draggable={p.canEdit}
            onDragStart={(ev) => {
              ev.dataTransfer.setData('application/x-epic', String(e.id));
              setDrag(e.id);
            }}
            onDragEnd={() => setDrag(null)}
            onDragOver={(ev) => drag && ev.preventDefault()}
            onDrop={async (ev) => {
              ev.preventDefault();
              const id = drag;
              setDrag(null);
              if (!id || id === e.id) return;
              await api.put(`/projects/${p.projectId}/epics/${id}`, { before_id: e.id });
              void p.refreshMeta();
            }}
            onClick={() => setOpen(e.id)}
          >
            <div className="epic-name">{e.name}</div>
            <EpicProgress e={e} />
          </div>
        ),
      )}
    </Panel>
  );
}

function EpicProgress({ e }: { e: Epic }) {
  const pct = e.points_total ? Math.round((e.points_accepted / e.points_total) * 100) : e.stories_total ? Math.round((e.stories_accepted / e.stories_total) * 100) : 0;
  const inProgress = (e.state_counts.started ?? 0) + (e.state_counts.finished ?? 0) + (e.state_counts.delivered ?? 0) + (e.state_counts.rejected ?? 0);
  return (
    <div className="epic-progress">
      <div className="bar" role="progressbar" aria-valuenow={pct} aria-valuemin={0} aria-valuemax={100}>
        <div className="bar-done" style={{ width: `${pct}%` }} />
        <div className="bar-progress" style={{ width: `${e.stories_total ? (inProgress / e.stories_total) * 100 : 0}%` }} />
      </div>
      <span className="muted small">
        {e.stories_accepted}/{e.stories_total} stories · {e.points_accepted}/{e.points_total} pts
      </span>
    </div>
  );
}

function EpicEditor({ epic, onClose, onSearch }: { epic: Epic; onClose: () => void; onSearch: (q: string) => void }) {
  const p = useProject();
  const [full, setFull] = useState<Epic | null>(null);
  const [comment, setComment] = useState('');
  const base = `/projects/${p.projectId}/epics/${epic.id}`;
  const load = () => api.get<Epic>(base).then(setFull);
  useEffect(() => {
    void load();
  }, [epic.id, p.version]); // eslint-disable-line react-hooks/exhaustive-deps
  const save = async (patch: Record<string, unknown>) => {
    try {
      await api.put(base, patch);
      void load();
      void p.refreshMeta();
    } catch (e: any) {
      p.setFlash(e.message);
    }
  };
  const e = full ?? epic;
  return (
    <div className="story-editor epic-editor">
      <div className="editor-toolbar">
        <button className="icon-btn" onClick={onClose} aria-label="Collapse epic">
          ▾
        </button>
        <b>Epic</b>
        <div className="spacer" />
        <button className="btn small" onClick={() => onSearch(`epic:"${e.name}" includedone:true`)}>
          Show stories
        </button>
        {p.canEdit && (
          <button
            className="btn small danger"
            onClick={async () => {
              if (!confirm(`Delete epic "${e.name}"? Its label and stories are kept.`)) return;
              await api.del(base);
              onClose();
              void p.refreshMeta();
            }}
          >
            Delete
          </button>
        )}
      </div>
      <InlineEdit className="editor-name" value={e.name} onSave={(name) => save({ name })} disabled={!p.canEdit} />
      <div className="editor-grid">
        <label>Label</label>
        <InlineEdit value={e.label.name} onSave={(name) => save({ label: { name } })} disabled={!p.canEdit} />
      </div>
      <EpicProgress e={e} />
      <section className="editor-section">
        <h4>Description</h4>
        <InlineEdit value={e.description} multiline placeholder="Describe the epic…" onSave={(description) => save({ description })} disabled={!p.canEdit} />
        {e.description && <Markdown text={e.description} />}
      </section>
      <section className="editor-section">
        <h4>Comments</h4>
        {(full?.comments ?? []).map((c) => {
          const author = c.person_id ? p.people.get(c.person_id) : null;
          return (
            <div key={c.id} className="comment">
              <Avatar person={author} size={22} />
              <div className="comment-body">
                <div className="comment-head">
                  <b>{author?.name}</b> <span className="muted small">{timeAgo(c.created_at)}</span>
                </div>
                <Markdown text={c.text} />
              </div>
            </div>
          );
        })}
        {p.canEdit && (
          <form
            className="row gap"
            onSubmit={async (ev) => {
              ev.preventDefault();
              if (!comment.trim()) return;
              await api.post(`${base}/comments`, { text: comment });
              setComment('');
              void load();
            }}
          >
            <input value={comment} onChange={(ev) => setComment(ev.target.value)} placeholder="Comment on this epic" />
            <button className="btn small">Post</button>
          </form>
        )}
      </section>
    </div>
  );
}

// ---------------------------------------------------------------------------------------------
// History

export function HistoryPanel({ onClose }: { onClose?: () => void }) {
  const p = useProject();
  const [items, setItems] = useState<Activity[]>([]);
  const [limit, setLimit] = useState(50);
  useEffect(() => {
    api.get<Activity[]>(`/projects/${p.projectId}/activity?limit=${limit}`).then(setItems).catch(() => {});
  }, [p.projectId, limit, p.version]);
  return (
    <Panel id="history" title="Project History" onClose={onClose}>
      <ul className="activity-list">
        {items.map((a) => {
          const story = a.primary_resources.find((r) => r.kind === 'story');
          return (
            <li key={a.id}>
              <Avatar person={a.performed_by} size={22} />
              <div>
                <div>
                  {a.message}
                  {story && p.stories.has(story.id) && (
                    <button className="link-btn small" onClick={() => p.toggleExpanded(story.id, true)}>
                      show
                    </button>
                  )}
                </div>
                <div className="muted small" title={fullTime(a.occurred_at)}>
                  {timeAgo(a.occurred_at)}
                </div>
              </div>
            </li>
          );
        })}
      </ul>
      {items.length >= limit && (
        <button className="btn small block" onClick={() => setLimit(limit + 50)}>
          Load more
        </button>
      )}
    </Panel>
  );
}
