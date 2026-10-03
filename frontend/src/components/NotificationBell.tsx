import { useEffect, useRef, useState } from 'react';
import { api, type Notification } from '../api';

const POLL_MS = 5000;

/** Polls notifications every few seconds and shows them in a panel. */
export function NotificationBell() {
  const [items, setItems] = useState<Notification[]>([]);
  const [unread, setUnread] = useState(0);
  const [open, setOpen] = useState(false);
  const panel = useRef<HTMLDivElement>(null);

  async function refresh() {
    try {
      const res = await api.notifications();
      setItems(res.data);
      setUnread(res.unread_count);
    } catch {
      // Try again on the next tick.
    }
  }

  useEffect(() => {
    void refresh();
    const timer = setInterval(() => void refresh(), POLL_MS);
    return () => clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!open) return;
    const close = (e: MouseEvent) => {
      if (panel.current && !panel.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('mousedown', close);
    return () => document.removeEventListener('mousedown', close);
  }, [open]);

  return (
    <div className="bell" ref={panel}>
      <button className="ghost" aria-expanded={open} aria-label={`Notifications, ${unread} unread`} onClick={() => setOpen(!open)}>
        Notifications {unread > 0 && <span className="badge">{unread}</span>}
      </button>
      {open && (
        <div className="panel card" role="dialog" aria-label="Notifications">
          <div className="row between">
            <strong>Notifications</strong>
            {unread > 0 && (
              <button className="link" onClick={async () => { await api.markAllRead(); await refresh(); }}>
                Mark all read
              </button>
            )}
          </div>
          {items.length === 0 && <p className="muted small">Nothing yet. Payments you send or receive show up here.</p>}
          <ul className="plain">
            {items.map((n) => (
              <li key={n.id} className={n.read_at ? 'read' : 'unread'}>
                <button
                  className="notification"
                  onClick={async () => {
                    if (!n.read_at) await api.markRead(n.id);
                    await refresh();
                    if (typeof n.data.transfer_id === 'string') {
                      window.location.hash = `/transfers/${n.data.transfer_id}`;
                      setOpen(false);
                    }
                  }}
                >
                  <span>{n.message}</span>
                  <span className="muted small">{new Date(n.created_at).toLocaleString()}</span>
                </button>
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}
