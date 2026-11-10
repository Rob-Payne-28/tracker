import { useCallback, useEffect, useState } from 'react';
import { Link, NavLink, useNavigate } from 'react-router-dom';
import { api, type Notification, type Project, type ResponseMeta } from '../api';
import { useAuth, useMe } from '../App';
import { Avatar, Dropdown } from './ui';
import { realtime } from '../realtime';
import { cx, timeAgo } from '../util';
import { useProjectsList } from '../hooks';

export function Header() {
  const me = useMe();
  const { setMe } = useAuth();
  const nav = useNavigate();
  const projects = useProjectsList();

  return (
    <header className="topbar">
      <Link to="/" className="brand">
        <img src="/favicon.svg" width={22} height={22} alt="" />
        <span>Tracker</span>
      </Link>
      <Dropdown
        className="project-switcher"
        trigger={() => <button className="topbar-btn">Projects ▾</button>}
      >
        {(close) => (
          <div className="menu">
            {projects.length === 0 && <div className="menu-empty">No projects yet</div>}
            {projects.map((p: Project) => (
              <Link key={p.id} to={`/projects/${p.id}`} className="menu-item" onClick={close}>
                {p.name}
              </Link>
            ))}
            <div className="menu-sep" />
            <Link to="/" className="menu-item" onClick={close}>
              All projects / create…
            </Link>
          </div>
        )}
      </Dropdown>
      <NavLink to="/workspaces" className={({ isActive }) => cx('topbar-link', isActive && 'active')}>
        Workspaces
      </NavLink>
      <div className="spacer" />
      <a className="topbar-link" href="/api/docs" target="_blank" rel="noreferrer">
        API
      </a>
      <Notifications />
      <Dropdown align="right" trigger={() => <button className="topbar-btn user-btn" aria-label="Account menu"><Avatar person={me} size={24} /></button>}>
        {(close) => (
          <div className="menu">
            <div className="menu-head">
              <b>{me.name}</b>
              <div className="muted">@{me.username}</div>
            </div>
            <Link className="menu-item" to="/profile" onClick={close}>
              Profile & API token
            </Link>
            {me.is_admin && (
              <Link className="menu-item" to="/admin" onClick={close}>
                Administration
              </Link>
            )}
            <button
              className="menu-item"
              onClick={async () => {
                await api.post('/auth/logout');
                setMe(null);
                nav('/login');
              }}
            >
              Sign out
            </button>
          </div>
        )}
      </Dropdown>
    </header>
  );
}

function Notifications() {
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const nav = useNavigate();
  const load = useCallback(async () => {
    const meta = {} as ResponseMeta;
    const list = await api.get<Notification[]>('/my/notifications?limit=30', meta);
    setItems(list);
    setUnread(Number(meta.headers.get('X-Unread-Count') ?? 0));
  }, []);
  useEffect(() => {
    void load();
    const off = realtime.subscribeNotifications(() => void load());
    const t = setInterval(() => void load(), 120_000);
    return () => {
      off();
      clearInterval(t);
    };
  }, [load]);

  return (
    <Dropdown
      align="right"
      trigger={() => (
        <button className="topbar-btn bell" aria-label={`Notifications (${unread} unread)`}>
          <svg width="18" height="18" viewBox="0 0 16 16" aria-hidden>
            <path d="M8 1.5a4 4 0 00-4 4v2.7L2.8 11h10.4L12 8.2V5.5a4 4 0 00-4-4zM6.5 12.5a1.5 1.5 0 003 0" fill="none" stroke="currentColor" strokeWidth="1.3" />
          </svg>
          {unread > 0 && <span className="badge">{unread > 99 ? '99+' : unread}</span>}
        </button>
      )}
    >
      {(close) => (
        <div className="menu notifications">
          <div className="menu-head row">
            <b>Notifications</b>
            <div className="spacer" />
            {unread > 0 && (
              <button
                className="link-btn"
                onClick={async () => {
                  await api.post('/my/notifications/mark_all_read');
                  void load();
                }}
              >
                Mark all read
              </button>
            )}
          </div>
          {items.length === 0 && <div className="menu-empty">Nothing yet. You'll be notified about mentions, ownership, deliveries and reviews.</div>}
          {items.map((n) => (
            <button
              key={n.id}
              className={cx('notification', !n.read_at && 'unread')}
              onClick={async () => {
                close();
                if (!n.read_at) await api.put(`/my/notifications/${n.id}`, { read: true });
                void load();
                if (n.project && n.story) nav(`/projects/${n.project.id}/stories/${n.story.id}`);
                else if (n.project) nav(`/projects/${n.project.id}`);
              }}
            >
              <Avatar person={n.performer} size={26} />
              <div>
                <div>{n.message}</div>
                {n.context && <div className="notification-context">{n.context.slice(0, 140)}</div>}
                <div className="muted small">
                  {n.project?.name} · {timeAgo(n.created_at)}
                </div>
              </div>
            </button>
          ))}
        </div>
      )}
    </Dropdown>
  );
}
