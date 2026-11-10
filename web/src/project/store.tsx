import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { api, type Activity, type Board, type Epic, type LabelWithCounts, type Membership, type Person, type ReviewType, type Story, type StoryFull } from '../api';
import { useProjectActivity } from '../realtime';

export type Zone = 'backlog' | 'icebox';

export interface ProjectStore {
  projectId: number;
  board: Board | null;
  error: unknown;
  stories: Map<number, Story>;
  members: Membership[];
  people: Map<number, Person>;
  labels: LabelWithCounts[];
  epics: Epic[];
  reviewTypes: ReviewType[];
  canEdit: boolean;
  isOwner: boolean;
  /** Bumped whenever any project data changes (used by expanded editors to refetch). */
  version: number;
  refresh: () => Promise<void>;
  refreshMeta: () => Promise<void>;
  updateStory: (id: number, patch: Record<string, unknown>) => Promise<StoryFull>;
  createStory: (data: Record<string, unknown>) => Promise<StoryFull>;
  moveStory: (id: number, zone: Zone, where: { before_id?: number; after_id?: number }) => Promise<void>;
  // UI state
  expanded: Set<number>;
  toggleExpanded: (id: number, open?: boolean) => void;
  selected: Set<number>;
  toggleSelected: (id: number) => void;
  clearSelected: () => void;
  dragging: number | null;
  setDragging: (id: number | null) => void;
  flash: string | null;
  setFlash: (msg: string | null) => void;
  velocityOverride: number | null;
  setVelocityOverride: (v: number | null) => void;
}

const Ctx = createContext<ProjectStore | null>(null);
export const useProject = () => useContext(Ctx)!;

export function ProjectProvider({ projectId, children }: { projectId: number; children: ReactNode }) {
  const [board, setBoard] = useState<Board | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [members, setMembers] = useState<Membership[]>([]);
  const [labels, setLabels] = useState<LabelWithCounts[]>([]);
  const [epics, setEpics] = useState<Epic[]>([]);
  const [reviewTypes, setReviewTypes] = useState<ReviewType[]>([]);
  const [version, setVersion] = useState(0);
  const [expanded, setExpanded] = useState<Set<number>>(new Set());
  const [selected, setSelected] = useState<Set<number>>(new Set());
  const [dragging, setDragging] = useState<number | null>(null);
  const [flash, setFlashState] = useState<string | null>(null);
  const [velocityOverride, setVelocityOverride] = useState<number | null>(null);
  const flashTimer = useRef<number>(0);
  const versionRef = useRef(0);

  const setFlash = useCallback((msg: string | null) => {
    setFlashState(msg);
    clearTimeout(flashTimer.current);
    if (msg) flashTimer.current = window.setTimeout(() => setFlashState(null), 5000);
  }, []);

  const refresh = useCallback(async () => {
    try {
      const b = await api.get<Board>(`/projects/${projectId}/board${velocityOverride ? `?velocity=${velocityOverride}` : ''}`);
      versionRef.current = b.project.version;
      setBoard(b);
      setVersion((v) => v + 1);
      setError(null);
    } catch (e) {
      setError(e);
    }
  }, [projectId, velocityOverride]);

  const refreshMeta = useCallback(async () => {
    const [m, l, e, r] = await Promise.all([
      api.get<Membership[]>(`/projects/${projectId}/memberships`),
      api.get<LabelWithCounts[]>(`/projects/${projectId}/labels`),
      api.get<Epic[]>(`/projects/${projectId}/epics`),
      api.get<ReviewType[]>(`/projects/${projectId}/review_types`),
    ]);
    setMembers(m);
    setLabels(l);
    setEpics(e);
    setReviewTypes(r);
  }, [projectId]);

  useEffect(() => {
    setBoard(null);
    setExpanded(new Set());
    setSelected(new Set());
    void refresh();
    void refreshMeta().catch(() => {});
  }, [projectId]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (board) void refresh();
  }, [velocityOverride]); // eslint-disable-line react-hooks/exhaustive-deps

  // Realtime: debounce refreshes triggered by other people's (or our own) changes.
  const pending = useRef<number>(0);
  const onActivity = useCallback(
    (a: Activity) => {
      if (a.project_version <= versionRef.current) return;
      clearTimeout(pending.current);
      pending.current = window.setTimeout(() => {
        void refresh();
        if (/label|epic|membership|review|project/.test(a.kind) || a.kind === 'story_create_activity') void refreshMeta().catch(() => {});
      }, 150);
    },
    [refresh, refreshMeta],
  );
  useProjectActivity(projectId, onActivity);

  const stories = useMemo(() => new Map((board?.stories ?? []).map((s) => [s.id, s])), [board]);
  const people = useMemo(() => new Map(members.map((m) => [m.person.id, m.person])), [members]);
  const role = board?.project.role ?? null;

  const updateStory = useCallback(
    async (id: number, patch: Record<string, unknown>) => {
      const s = await api.put<StoryFull>(`/projects/${projectId}/stories/${id}`, patch);
      await refresh();
      if ('labels' in patch || 'label_ids' in patch) void refreshMeta().catch(() => {});
      return s;
    },
    [projectId, refresh, refreshMeta],
  );

  const createStory = useCallback(
    async (data: Record<string, unknown>) => {
      const s = await api.post<StoryFull>(`/projects/${projectId}/stories`, data);
      await refresh();
      void refreshMeta().catch(() => {});
      return s;
    },
    [projectId, refresh, refreshMeta],
  );

  const moveStory = useCallback(
    async (id: number, zone: Zone, where: { before_id?: number; after_id?: number }) => {
      const s = stories.get(id);
      if (!s || where.before_id === id || where.after_id === id) return;
      const patch: Record<string, unknown> = { ...where };
      if (zone === 'icebox' && s.current_state !== 'unscheduled') {
        if (s.current_state !== 'unstarted') {
          setFlash('Only unstarted stories can be moved to the icebox.');
          return;
        }
        patch.current_state = 'unscheduled';
      }
      if (zone === 'backlog' && s.current_state === 'unscheduled') patch.current_state = 'unstarted';
      try {
        await updateStory(id, patch);
      } catch (e: any) {
        setFlash(e.message);
      }
    },
    [stories, updateStory, setFlash],
  );

  const value: ProjectStore = {
    projectId,
    board,
    error,
    stories,
    members,
    people,
    labels,
    epics,
    reviewTypes,
    canEdit: role === 'owner' || role === 'member',
    isOwner: role === 'owner',
    version,
    refresh,
    refreshMeta,
    updateStory,
    createStory,
    moveStory,
    expanded,
    toggleExpanded: (id, open) =>
      setExpanded((prev) => {
        const n = new Set(prev);
        const want = open ?? !n.has(id);
        if (want) n.add(id);
        else n.delete(id);
        return n;
      }),
    selected,
    toggleSelected: (id) =>
      setSelected((prev) => {
        const n = new Set(prev);
        if (n.has(id)) n.delete(id);
        else n.add(id);
        return n;
      }),
    clearSelected: () => setSelected(new Set()),
    dragging,
    setDragging,
    flash,
    setFlash,
    velocityOverride,
    setVelocityOverride,
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
