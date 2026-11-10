import { useCallback, useEffect, useState, useSyncExternalStore } from 'react';
import { api, type Project } from './api';
import { loadPref, savePref } from './util';

// ---- Shared list of the user's projects (used by header, dashboard, workspaces)
let projectsCache: Project[] = [];
const projectListeners = new Set<() => void>();
let inflight: Promise<void> | null = null;

export function refreshProjects() {
  inflight ??= api
    .get<Project[]>('/projects')
    .then((p) => {
      projectsCache = p;
      projectListeners.forEach((l) => l());
    })
    .catch(() => {})
    .finally(() => {
      inflight = null;
    });
  return inflight;
}

export function useProjectsList(): Project[] {
  const list = useSyncExternalStore(
    (cb) => {
      projectListeners.add(cb);
      return () => projectListeners.delete(cb);
    },
    () => projectsCache,
  );
  useEffect(() => {
    void refreshProjects();
  }, []);
  return list;
}

export function usePref<T>(key: string, initial: T): [T, (v: T) => void] {
  const [v, setV] = useState<T>(() => loadPref(key, initial));
  const set = useCallback(
    (nv: T) => {
      setV(nv);
      savePref(key, nv);
    },
    [key],
  );
  return [v, set];
}

/** Fetch helper with reload. */
export function useFetch<T>(path: string | null, deps: unknown[] = []) {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(false);
  const load = useCallback(async () => {
    if (!path) return;
    setLoading(true);
    try {
      setData(await api.get<T>(path));
      setError(null);
    } catch (e) {
      setError(e);
    } finally {
      setLoading(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [path, ...deps]);
  useEffect(() => {
    void load();
  }, [load]);
  return { data, error, loading, reload: load, setData };
}
