import { useCallback, useEffect, useRef, useState } from 'react';
import { api, type Activity, type FileAttachment, type StoryFull, type StoryState, type StoryType } from '../api';
import { useMe } from '../App';
import { useProject } from './store';
import { Avatar, ErrorText, InlineEdit, Markdown, Spinner, TypeIcon } from '../components/ui';
import { cx, fileSize, fullTime, isEstimatable, pointScale, stateActions, STATES_FOR, timeAgo } from '../util';

export function StoryEditor({ storyId, onClose }: { storyId: number; onClose?: () => void }) {
  const p = useProject();
  const me = useMe();
  const [story, setStory] = useState<StoryFull | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [tab, setTab] = useState<'comments' | 'activity'>('comments');
  const project = p.board?.project;
  const ro = !p.canEdit;

  const load = useCallback(async () => {
    try {
      setStory(await api.get<StoryFull>(`/projects/${p.projectId}/stories/${storyId}`));
    } catch (e) {
      setError(e);
    }
  }, [p.projectId, storyId]);

  useEffect(() => {
    void load();
  }, [load, p.version]);

  const close = () => (onClose ? onClose() : p.toggleExpanded(storyId, false));

  const save = async (patch: Record<string, unknown>) => {
    setError(null);
    try {
      setStory(await p.updateStory(storyId, patch));
    } catch (e) {
      setError(e);
    }
  };
  const call = async (fn: () => Promise<unknown>) => {
    setError(null);
    try {
      await fn();
      await load();
      void p.refresh();
    } catch (e) {
      setError(e);
    }
  };

  if (!story || !project) {
    return <div className="story-editor loading">{error ? <ErrorText error={error} /> : <Spinner />}</div>;
  }

  const base = `/projects/${p.projectId}/stories/${story.id}`;
  const following = story.follower_ids.includes(me.id);
  const estimatable = isEstimatable(story.story_type, project);

  return (
    <div className={cx('story-editor', `state-${story.current_state}`)} data-story-id={story.id} id={`story-${story.id}`}>
      <div className="editor-toolbar">
        <button className="icon-btn" onClick={close} title="Collapse" aria-label="Collapse story">
          ▾
        </button>
        <span className="story-id">
          <a href={`/projects/${p.projectId}/stories/${story.id}`} onClick={(e) => e.preventDefault()} title="Story link">
            #{story.id}
          </a>
          <button className="link-btn small" onClick={() => navigator.clipboard?.writeText(story.url)} title="Copy link">
            copy link
          </button>
        </span>
        <div className="spacer" />
        <button className={cx('btn small', following && 'active')} onClick={() => call(() => api[following ? 'del' : 'post'](`${base}/follow`))}>
          {following ? 'Following' : 'Follow'} · {story.follower_ids.length}
        </button>
        {!ro && (
          <>
            <button className="btn small" onClick={() => call(() => api.post(`${base}/clone`))} title="Clone story">
              Clone
            </button>
            <button
              className="btn small danger"
              onClick={async () => {
                if (!confirm(`Delete "${story.name}"? This cannot be undone.`)) return;
                await api.del(base);
                close();
                void p.refresh();
              }}
            >
              Delete
            </button>
          </>
        )}
      </div>

      <InlineEdit className="editor-name" value={story.name} onSave={(name) => save({ name })} multiline disabled={ro} />

      <div className="editor-grid">
        <label>Type</label>
        <select value={story.story_type} disabled={ro} onChange={(e) => save({ story_type: e.target.value as StoryType })}>
          {['feature', 'bug', 'chore', 'release'].map((t) => (
            <option key={t} value={t}>
              {t}
            </option>
          ))}
        </select>

        {estimatable && (
          <>
            <label>Points</label>
            <select value={story.estimate ?? ''} disabled={ro} onChange={(e) => save({ estimate: e.target.value === '' ? null : Number(e.target.value) })}>
              <option value="">Unestimated</option>
              {pointScale(project).map((n) => (
                <option key={n} value={n}>
                  {n} point{n === 1 ? '' : 's'}
                </option>
              ))}
            </select>
          </>
        )}

        <label>State</label>
        <div className="state-row">
          <select value={story.current_state} disabled={ro} onChange={(e) => save({ current_state: e.target.value as StoryState })}>
            {STATES_FOR[story.story_type].map((s) => (
              <option key={s} value={s}>
                {s === 'unscheduled' ? 'unscheduled (icebox)' : s}
              </option>
            ))}
          </select>
          {!ro &&
            stateActions(story).map((a) => (
              <button key={a.kind} className={cx('state-btn', a.kind)} onClick={() => save({ current_state: a.to })}>
                {a.label}
              </button>
            ))}
        </div>

        {story.story_type === 'release' && (
          <>
            <label>Release date</label>
            <input type="date" value={story.deadline ?? ''} disabled={ro} onChange={(e) => save({ deadline: e.target.value || null })} />
          </>
        )}

        {!project.automatic_planning && !['accepted', 'unscheduled'].includes(story.current_state) && (
          <>
            <label>Planned iteration</label>
            <input
              type="number"
              min={1}
              defaultValue={story.planned_iteration_number ?? ''}
              disabled={ro}
              onBlur={(e) => save({ planned_iteration_number: e.target.value ? Number(e.target.value) : null })}
              placeholder="Unplanned"
            />
          </>
        )}

        <label>Requester</label>
        <select value={story.requested_by_id ?? ''} disabled={ro} onChange={(e) => save({ requested_by_id: e.target.value ? Number(e.target.value) : null })}>
          <option value="">—</option>
          {p.members.map((m) => (
            <option key={m.person.id} value={m.person.id}>
              {m.person.name}
            </option>
          ))}
        </select>

        <label>Owners</label>
        <div className="chips">
          {story.owner_ids.map((id) => {
            const person = p.people.get(id);
            return (
              <span key={id} className="chip">
                <Avatar person={person} size={18} /> {person?.name ?? 'Unknown'}
                {!ro && (
                  <button className="chip-x" aria-label="Remove owner" onClick={() => save({ owner_ids: story.owner_ids.filter((o) => o !== id) })}>
                    ×
                  </button>
                )}
              </span>
            );
          })}
          {!ro && (
            <select value="" onChange={(e) => e.target.value && save({ owner_ids: [...story.owner_ids, Number(e.target.value)] })} className="add-select">
              <option value="">+ owner</option>
              {p.members
                .filter((m) => !story.owner_ids.includes(m.person.id) && m.role !== 'viewer')
                .map((m) => (
                  <option key={m.person.id} value={m.person.id}>
                    {m.person.name}
                  </option>
                ))}
            </select>
          )}
        </div>
      </div>

      <ErrorText error={error} />

      <BlockersSection story={story} base={base} call={call} ro={ro} />

      <section className="editor-section">
        <h4>Description</h4>
        <DescriptionEditor value={story.description} onSave={(description) => save({ description })} ro={ro} />
      </section>

      <section className="editor-section">
        <h4>Labels</h4>
        <LabelsEditor story={story} save={save} ro={ro} />
      </section>

      {project.enable_tasks && <TasksSection story={story} base={base} call={call} ro={ro} />}

      <ReviewsSection story={story} base={base} call={call} ro={ro} />

      <section className="editor-section">
        <div className="tabs small">
          <button className={cx('tab', tab === 'comments' && 'active')} onClick={() => setTab('comments')}>
            Comments ({story.comments.length})
          </button>
          <button className={cx('tab', tab === 'activity' && 'active')} onClick={() => setTab('activity')}>
            Activity
          </button>
        </div>
        {tab === 'comments' ? <CommentsSection story={story} base={base} call={call} ro={ro} /> : <StoryActivity base={base} version={p.version} />}
      </section>

      <div className="editor-footer muted small">
        Requested {fullTime(story.created_at)}
        {story.started_at && <> · started {fullTime(story.started_at)}</>}
        {story.accepted_at && <> · accepted {fullTime(story.accepted_at)}</>} · updated {timeAgo(story.updated_at)}
      </div>
    </div>
  );
}

type Call = (fn: () => Promise<unknown>) => Promise<void>;

function DescriptionEditor({ value, onSave, ro }: { value: string; onSave: (v: string) => Promise<void>; ro: boolean }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(value);
  useEffect(() => setDraft(value), [value]);
  if (!editing) {
    return (
      <div className={cx('description', !value && 'placeholder', !ro && 'editable')} onClick={() => !ro && setEditing(true)}>
        {value ? <Markdown text={value} /> : ro ? 'No description.' : 'Add a description (Markdown supported)…'}
      </div>
    );
  }
  return (
    <div className="description-edit">
      <textarea autoFocus rows={8} value={draft} onChange={(e) => setDraft(e.target.value)} />
      <div className="row gap">
        <button
          className="btn primary small"
          onClick={async () => {
            await onSave(draft);
            setEditing(false);
          }}
        >
          Save
        </button>
        <button
          className="btn small"
          onClick={() => {
            setDraft(value);
            setEditing(false);
          }}
        >
          Cancel
        </button>
        <span className="muted small">Markdown, @mentions and #story references supported</span>
      </div>
    </div>
  );
}

function LabelsEditor({ story, save, ro }: { story: StoryFull; save: (p: Record<string, unknown>) => Promise<void>; ro: boolean }) {
  const p = useProject();
  const [draft, setDraft] = useState('');
  const add = () => {
    const names = draft.split(',').map((s) => s.trim()).filter(Boolean);
    if (!names.length) return;
    setDraft('');
    void save({ labels: [...story.labels.map((l) => l.name), ...names] });
  };
  return (
    <div className="chips">
      {story.labels.map((l) => (
        <span key={l.id} className="label-chip big">
          {l.name}
          {!ro && (
            <button className="chip-x" aria-label={`Remove label ${l.name}`} onClick={() => save({ label_ids: story.label_ids.filter((x) => x !== l.id) })}>
              ×
            </button>
          )}
        </span>
      ))}
      {!ro && (
        <>
          <input
            className="label-input"
            list={`labels-${story.id}`}
            placeholder="Add label…"
            value={draft}
            onChange={(e) => setDraft(e.target.value)}
            onKeyDown={(e) => e.key === 'Enter' && add()}
            onBlur={add}
          />
          <datalist id={`labels-${story.id}`}>
            {p.labels
              .filter((l) => !story.label_ids.includes(l.id))
              .map((l) => (
                <option key={l.id} value={l.name} />
              ))}
          </datalist>
        </>
      )}
    </div>
  );
}

function BlockersSection({ story, base, call, ro }: { story: StoryFull; base: string; call: Call; ro: boolean }) {
  const [draft, setDraft] = useState('');
  const p = useProject();
  if (ro && story.blockers.length === 0 && story.blocking_story_ids.length === 0) return null;
  return (
    <section className="editor-section">
      <h4>Blockers</h4>
      {story.blocking_story_ids.length > 0 && (
        <div className="muted small">
          This story is blocking{' '}
          {story.blocking_story_ids.map((id) => (
            <a key={id} href={`#story-${id}`} onClick={(e) => (e.preventDefault(), p.toggleExpanded(id, true))}>
              #{id}{' '}
            </a>
          ))}
        </div>
      )}
      {story.blockers.map((b) => (
        <div key={b.id} className={cx('blocker', b.resolved && 'resolved')}>
          <input type="checkbox" checked={b.resolved} disabled={ro} title="Resolved" onChange={(e) => call(() => api.put(`${base}/blockers/${b.id}`, { resolved: e.target.checked }))} />
          <Markdown text={b.description} className="inline" />
          {!ro && (
            <button className="icon-btn" aria-label="Delete blocker" onClick={() => call(() => api.del(`${base}/blockers/${b.id}`))}>
              ×
            </button>
          )}
        </div>
      ))}
      {!ro && (
        <form
          className="row gap"
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft.trim()) return;
            void call(() => api.post(`${base}/blockers`, { description: draft })).then(() => setDraft(''));
          }}
        >
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Describe the blocker, or reference a story with #id" />
          <button className="btn small">Add blocker</button>
        </form>
      )}
    </section>
  );
}

function TasksSection({ story, base, call, ro }: { story: StoryFull; base: string; call: Call; ro: boolean }) {
  const [draft, setDraft] = useState('');
  const done = story.tasks.filter((t) => t.complete).length;
  return (
    <section className="editor-section">
      <h4>
        Tasks <span className="muted">({done}/{story.tasks.length})</span>
      </h4>
      {story.tasks.map((t, i) => (
        <div key={t.id} className={cx('task', t.complete && 'done')}>
          <input type="checkbox" checked={t.complete} disabled={ro} onChange={(e) => call(() => api.put(`${base}/tasks/${t.id}`, { complete: e.target.checked }))} aria-label="Complete" />
          <InlineEdit value={t.description} disabled={ro} onSave={(d) => call(() => api.put(`${base}/tasks/${t.id}`, { description: d }))} />
          {!ro && (
            <span className="task-actions">
              {i > 0 && (
                <button className="icon-btn" title="Move up" onClick={() => call(() => api.put(`${base}/tasks/${t.id}`, { position: i }))}>
                  ↑
                </button>
              )}
              <button className="icon-btn" aria-label="Delete task" onClick={() => call(() => api.del(`${base}/tasks/${t.id}`))}>
                ×
              </button>
            </span>
          )}
        </div>
      ))}
      {!ro && (
        <form
          className="row gap"
          onSubmit={(e) => {
            e.preventDefault();
            if (!draft.trim()) return;
            void call(() => api.post(`${base}/tasks`, { description: draft })).then(() => setDraft(''));
          }}
        >
          <input value={draft} onChange={(e) => setDraft(e.target.value)} placeholder="Add a task" />
          <button className="btn small">Add</button>
        </form>
      )}
    </section>
  );
}

function ReviewsSection({ story, base, call, ro }: { story: StoryFull; base: string; call: Call; ro: boolean }) {
  const p = useProject();
  const visibleTypes = p.reviewTypes.filter((t) => !t.hidden);
  if (ro && story.reviews.length === 0) return null;
  return (
    <section className="editor-section">
      <h4>Reviews</h4>
      {story.reviews.map((r) => (
        <div key={r.id} className={cx('review', `review-${r.status}`)}>
          <b>{r.review_type_name}</b>
          <select value={r.reviewer_id ?? ''} disabled={ro} onChange={(e) => call(() => api.put(`${base}/reviews/${r.id}`, { reviewer_id: e.target.value ? Number(e.target.value) : null }))}>
            <option value="">No reviewer</option>
            {p.members.map((m) => (
              <option key={m.person.id} value={m.person.id}>
                {m.person.name}
              </option>
            ))}
          </select>
          <select value={r.status} disabled={ro} onChange={(e) => call(() => api.put(`${base}/reviews/${r.id}`, { status: e.target.value }))}>
            <option value="unstarted">Unstarted</option>
            <option value="in_review">In review</option>
            <option value="pass">Pass</option>
            <option value="revise">Revise</option>
          </select>
          {!ro && (
            <button className="icon-btn" aria-label="Delete review" onClick={() => call(() => api.del(`${base}/reviews/${r.id}`))}>
              ×
            </button>
          )}
        </div>
      ))}
      {!ro && visibleTypes.length > 0 && (
        <select value="" className="add-select" onChange={(e) => e.target.value && call(() => api.post(`${base}/reviews`, { review_type_id: Number(e.target.value) }))}>
          <option value="">+ Add review</option>
          {visibleTypes.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      )}
    </section>
  );
}

function CommentsSection({ story, base, call, ro }: { story: StoryFull; base: string; call: Call; ro: boolean }) {
  const p = useProject();
  const me = useMe();
  const [text, setText] = useState('');
  const [files, setFiles] = useState<FileAttachment[]>([]);
  const [uploading, setUploading] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);

  const upload = async (list: FileList | File[]) => {
    setUploading(true);
    try {
      for (const f of Array.from(list)) {
        const attachment = await api.upload(p.projectId, f);
        setFiles((prev) => [...prev, attachment]);
      }
    } catch (e: any) {
      p.setFlash(e.message);
    } finally {
      setUploading(false);
    }
  };

  return (
    <div className="comments">
      {story.comments.map((c) => {
        const author = c.person_id ? p.people.get(c.person_id) : null;
        return (
          <div key={c.id} className="comment">
            <Avatar person={author} size={26} />
            <div className="comment-body">
              <div className="comment-head">
                <b>{author?.name ?? 'Former member'}</b> <span className="muted small" title={fullTime(c.created_at)}>{timeAgo(c.created_at)}</span>
                {c.commit_identifier && <span className="commit-tag">commit {c.commit_identifier.slice(0, 8)}</span>}
                {(c.person_id === me.id || p.isOwner) && !ro && (
                  <button className="link-btn small" onClick={() => confirm('Delete this comment?') && call(() => api.del(`${base}/comments/${c.id}`))}>
                    delete
                  </button>
                )}
              </div>
              {c.text && <Markdown text={c.text} />}
              {c.file_attachments.length > 0 && (
                <div className="attachments">
                  {c.file_attachments.map((f) => (
                    <a key={f.id} href={f.download_url} target="_blank" rel="noreferrer" className="attachment">
                      {f.content_type.startsWith('image/') ? <img src={f.download_url} alt={f.filename} loading="lazy" /> : <span className="file-icon">📄</span>}
                      <span>
                        {f.filename} <span className="muted small">{fileSize(f.size)}</span>
                      </span>
                    </a>
                  ))}
                </div>
              )}
            </div>
          </div>
        );
      })}
      {!ro && (
        <div
          className="comment-form"
          onDragOver={(e) => e.dataTransfer.types.includes('Files') && e.preventDefault()}
          onDrop={(e) => {
            if (e.dataTransfer.files.length) {
              e.preventDefault();
              void upload(e.dataTransfer.files);
            }
          }}
        >
          <textarea
            rows={3}
            value={text}
            onChange={(e) => setText(e.target.value)}
            placeholder="Add a comment… (Markdown, @mention people; drop files to attach; Ctrl+Enter to post)"
            onPaste={(e) => {
              if (e.clipboardData.files.length) {
                e.preventDefault();
                void upload(e.clipboardData.files);
              }
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter' && (e.metaKey || e.ctrlKey)) (e.currentTarget.form ?? e.currentTarget.parentElement)?.querySelector<HTMLButtonElement>('.post-btn')?.click();
            }}
          />
          {files.length > 0 && (
            <div className="pending-files">
              {files.map((f) => (
                <span key={f.id} className="chip">
                  📎 {f.filename}
                  <button className="chip-x" onClick={() => setFiles(files.filter((x) => x.id !== f.id))} aria-label="Remove file">
                    ×
                  </button>
                </span>
              ))}
            </div>
          )}
          <div className="row gap">
            <button
              className="btn primary small post-btn"
              disabled={uploading || (!text.trim() && !files.length)}
              onClick={() =>
                call(() => api.post(`${base}/comments`, { text, file_attachment_ids: files.map((f) => f.id) })).then(() => {
                  setText('');
                  setFiles([]);
                })
              }
            >
              Post comment
            </button>
            <button className="btn small" onClick={() => fileInput.current?.click()} disabled={uploading}>
              {uploading ? 'Uploading…' : 'Attach files'}
            </button>
            <input ref={fileInput} type="file" multiple hidden onChange={(e) => e.target.files && upload(e.target.files)} />
          </div>
        </div>
      )}
    </div>
  );
}

function StoryActivity({ base, version }: { base: string; version: number }) {
  const [items, setItems] = useState<Activity[] | null>(null);
  useEffect(() => {
    api.get<Activity[]>(`${base}/activity?limit=100`).then(setItems).catch(() => setItems([]));
  }, [base, version]);
  if (!items) return <Spinner />;
  return (
    <ul className="activity-list compact">
      {items.map((a) => (
        <li key={a.id}>
          <Avatar person={a.performed_by} size={18} /> <span>{a.message}</span> <span className="muted small" title={fullTime(a.occurred_at)}>{timeAgo(a.occurred_at)}</span>
        </li>
      ))}
    </ul>
  );
}

