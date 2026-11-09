import { useEffect } from 'react';
import type { Activity, Notification } from './api';

type ActivityListener = (a: Activity) => void;
type NotificationListener = (n: Notification) => void;

/** One shared EventSource; reconnects when the set of subscribed projects changes. */
class Realtime {
  private es: EventSource | null = null;
  private projects = new Map<number, Set<ActivityListener>>();
  private notes = new Set<NotificationListener>();
  private timer: number | null = null;
  private key = '';

  subscribeProject(id: number, fn: ActivityListener) {
    if (!this.projects.has(id)) this.projects.set(id, new Set());
    this.projects.get(id)!.add(fn);
    this.schedule();
    return () => {
      const set = this.projects.get(id);
      set?.delete(fn);
      if (set && !set.size) this.projects.delete(id);
      this.schedule();
    };
  }

  subscribeNotifications(fn: NotificationListener) {
    this.notes.add(fn);
    this.schedule();
    return () => {
      this.notes.delete(fn);
      this.schedule();
    };
  }

  private schedule() {
    if (this.timer) clearTimeout(this.timer);
    this.timer = window.setTimeout(() => this.connect(), 50);
  }

  private connect() {
    const ids = [...this.projects.keys()].sort((a, b) => a - b);
    const key = ids.join(',');
    const wanted = ids.length > 0 || this.notes.size > 0;
    if (this.es && key === this.key && wanted) return;
    this.es?.close();
    this.es = null;
    this.key = key;
    if (!wanted) return;
    const es = new EventSource(`/api/v1/events${key ? `?project_ids=${key}` : ''}`);
    es.addEventListener('activity', (e) => {
      const a = JSON.parse((e as MessageEvent).data) as Activity;
      this.projects.get(a.project.id)?.forEach((fn) => fn(a));
    });
    es.addEventListener('notification', (e) => {
      const n = JSON.parse((e as MessageEvent).data) as Notification;
      this.notes.forEach((fn) => fn(n));
    });
    this.es = es;
  }
}

export const realtime = new Realtime();

export function useProjectActivity(projectId: number | undefined, fn: ActivityListener) {
  useEffect(() => {
    if (!projectId) return;
    return realtime.subscribeProject(projectId, fn);
  }, [projectId, fn]);
}
