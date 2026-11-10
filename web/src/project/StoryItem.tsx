import { useState, type DragEvent, type ReactNode } from 'react';
import type { Story } from '../api';
import { useProject, type Zone } from './store';
import { Avatar, TypeIcon } from '../components/ui';
import { cx, isEstimatable, pointScale, stateActions } from '../util';
import { StoryEditor } from './StoryEditor';

export function StoryItem({ story, zone, highlight }: { story: Story; zone?: Zone; highlight?: boolean }) {
  const { expanded } = useProject();
  if (expanded.has(story.id)) return <StoryEditor storyId={story.id} />;
  return <StoryPreview story={story} zone={zone} highlight={highlight} />;
}

export function StoryPreview({ story: s, zone, highlight }: { story: Story; zone?: Zone; highlight?: boolean }) {
  const p = useProject();
  const project = p.board!.project;
  const [busy, setBusy] = useState(false);
  const owners = s.owner_ids.map((id) => p.people.get(id)).filter(Boolean);
  const unestimated = s.estimate == null && isEstimatable(s.story_type, project) && s.current_state !== 'accepted';
  const draggable = p.canEdit && !!zone && s.current_state !== 'accepted';
  const behind = p.board!.releases.find((r) => r.story_id === s.id && r.behind_schedule);

  const act = async (patch: Record<string, unknown>) => {
    setBusy(true);
    try {
      await p.updateStory(s.id, patch);
    } catch (e: any) {
      p.setFlash(e.message);
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      className={cx('story', `state-${s.current_state}`, `type-${s.story_type}`, highlight && 'highlight', p.selected.has(s.id) && 'selected', p.dragging === s.id && 'dragging')}
      data-story-id={s.id}
      draggable={draggable}
      onDragStart={(e) => {
        e.dataTransfer.setData('text/plain', String(s.id));
        e.dataTransfer.effectAllowed = 'move';
        p.setDragging(s.id);
      }}
      onDragEnd={() => p.setDragging(null)}
      onClick={(e) => {
        if ((e.target as HTMLElement).closest('button, input, a, .no-expand')) return;
        p.toggleExpanded(s.id, true);
      }}
    >
      {p.canEdit && (
        <input
          type="checkbox"
          className="select-box no-expand"
          checked={p.selected.has(s.id)}
          onChange={() => p.toggleSelected(s.id)}
          aria-label={`Select ${s.name}`}
          title="Select for bulk actions"
        />
      )}
      <span className="story-type">
        <TypeIcon type={s.story_type} />
      </span>
      {isEstimatable(s.story_type, project) && !unestimated && (
        <span className="estimate" title={`${s.estimate} point${s.estimate === 1 ? '' : 's'}`}>
          {s.estimate}
        </span>
      )}
      <span className="story-name">
        {s.blocker_count > 0 && (
          <span className="flag blocked" title={`${s.blocker_count} unresolved blocker(s)`}>
            ⛔
          </span>
        )}
        {s.name}
        {s.labels.map((l) => (
          <span key={l.id} className="label-chip">
            {l.name}
          </span>
        ))}
        {owners.length > 0 && <span className="owners">({owners.map((o) => o!.initials).join(', ')})</span>}
        {s.story_type === 'release' && s.deadline && <span className={cx('deadline', behind && 'late')}>{behind ? '⚠ ' : ''}due {s.deadline}</span>}
      </span>
      <span className="story-meta">
        {s.comment_count > 0 && (
          <span className="meta-icon" title={`${s.comment_count} comment(s)`}>
            💬{s.comment_count}
          </span>
        )}
        {s.tasks_total > 0 && (
          <span className="meta-icon" title="Tasks completed">
            ☑{s.tasks_completed}/{s.tasks_total}
          </span>
        )}
        {s.reviews_total > 0 && (
          <span className={cx('meta-icon', s.reviews_passed === s.reviews_total && 'ok')} title="Reviews passed">
            ✔{s.reviews_passed}/{s.reviews_total}
          </span>
        )}
      </span>
      {p.canEdit && (
        <span className="story-actions">
          {unestimated ? (
            <span className="estimate-picker" title="Estimate">
              {pointScale(project).map((n) => (
                <button key={n} className="est-btn" disabled={busy} onClick={() => act({ estimate: n })}>
                  {n}
                </button>
              ))}
            </span>
          ) : (
            stateActions(s).map((a) => (
              <button key={a.kind} className={cx('state-btn', a.kind)} disabled={busy} onClick={() => act({ current_state: a.to })}>
                {a.label}
              </button>
            ))
          )}
        </span>
      )}
      {owners.length > 0 && (
        <span className="owner-avatars">
          {owners.slice(0, 2).map((o) => (
            <Avatar key={o!.id} person={o} size={18} />
          ))}
        </span>
      )}
    </div>
  );
}

/**
 * A list of stories that accepts drops. `items` mixes rendered nodes (headers etc.) and story ids;
 * only story rows are drop anchors.
 */
export function DropList({ zone, ids, children, emptyText }: { zone: Zone; ids: number[]; children: ReactNode; emptyText?: string }) {
  const p = useProject();
  const [indicator, setIndicator] = useState<{ id: number | null; where: 'before' | 'after' } | null>(null);
  const active = p.dragging != null && p.canEdit;

  const onDragOver = (e: DragEvent) => {
    if (!active) return;
    e.preventDefault();
    e.dataTransfer.dropEffect = 'move';
    const row = (e.target as HTMLElement).closest('[data-story-id]') as HTMLElement | null;
    if (row && ids.includes(Number(row.dataset.storyId))) {
      const r = row.getBoundingClientRect();
      const where = e.clientY < r.top + r.height / 2 ? 'before' : 'after';
      setIndicator({ id: Number(row.dataset.storyId), where });
    } else if (!row) {
      setIndicator({ id: ids.length ? ids[ids.length - 1] : null, where: 'after' });
    }
  };
  const onDrop = (e: DragEvent) => {
    if (!active) return;
    e.preventDefault();
    const id = Number(e.dataTransfer.getData('text/plain')) || p.dragging!;
    const ind = indicator;
    setIndicator(null);
    p.setDragging(null);
    if (!ind) return;
    void p.moveStory(id, zone, ind.id == null ? {} : ind.where === 'before' ? { before_id: ind.id } : { after_id: ind.id });
  };

  return (
    <div
      className={cx('drop-list', active && 'drop-active')}
      onDragOver={onDragOver}
      onDragLeave={(e) => {
        if (!(e.currentTarget as HTMLElement).contains(e.relatedTarget as Node)) setIndicator(null);
      }}
      onDrop={onDrop}
      data-zone={zone}
    >
      {indicator && <DropIndicatorStyle id={indicator.id} where={indicator.where} />}
      {children}
      {ids.length === 0 && <div className="empty-drop">{emptyText ?? 'Drag stories here'}</div>}
    </div>
  );
}

/** Draw the drop indicator via a scoped style rule so rows don't need to re-render. */
function DropIndicatorStyle({ id, where }: { id: number | null; where: 'before' | 'after' }) {
  if (id == null) return <style>{`.drop-list[data-zone] .empty-drop{outline:2px dashed var(--accent)}`}</style>;
  return <style>{`[data-story-id="${id}"]{box-shadow: inset 0 ${where === 'before' ? '3px' : '-3px'} 0 var(--accent) !important}`}</style>;
}
