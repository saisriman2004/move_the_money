import { useState, type FormEvent } from 'react';
import { api, ApiError, type Webhook } from '../api';
import { useAsync } from '../useAsync';

const EVENTS = ['transfer.completed', 'transfer.refunded', 'account.created'];

export function Developers() {
  const hooks = useAsync(() => api.webhooks(), []);
  const [url, setUrl] = useState('');
  const [events, setEvents] = useState<string[]>(['transfer.completed']);
  const [secret, setSecret] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  async function create(e: FormEvent) {
    e.preventDefault();
    setError(null);
    try {
      const created = await api.createWebhook(url, events);
      setSecret(created.secret);
      setUrl('');
      void hooks.reload();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    }
  }

  return (
    <div className="stack">
      <h2>Developers</h2>
      <section className="card">
        <h3>Add a webhook</h3>
        <p className="muted small">
          We POST signed JSON to your URL when these events happen. Verify the <code>Webhook-Signature</code> header with your secret
          and reject old timestamps.
        </p>
        <form className="form" onSubmit={create}>
          <label>Endpoint URL<input id="webhook-url" type="url" required placeholder="https://example.com/hooks/payments" value={url} onChange={(e) => setUrl(e.target.value)} /></label>
          <fieldset>
            <legend>Events</legend>
            {EVENTS.map((ev) => (
              <label key={ev} className="check">
                <input type="checkbox" checked={events.includes(ev)} onChange={(e) => setEvents(e.target.checked ? [...events, ev] : events.filter((x) => x !== ev))} />
                <code>{ev}</code>
              </label>
            ))}
          </fieldset>
          {error && <p className="error" role="alert">{error}</p>}
          <button className="primary" disabled={events.length === 0}>Add webhook</button>
        </form>
        {secret && (
          <div className="callout" role="status">
            <strong>Signing secret: copy it now, it won't be shown again.</strong>
            <code className="secret">{secret}</code>
          </div>
        )}
      </section>

      <section>
        <h3>Your webhooks</h3>
        {hooks.data?.length === 0 && <p className="muted">None yet.</p>}
        {hooks.data?.map((h) => <WebhookRow key={h.id} hook={h} onChanged={() => void hooks.reload()} />)}
      </section>
    </div>
  );
}

function WebhookRow({ hook, onChanged }: { hook: Webhook; onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const deliveries = useAsync(() => (open ? api.deliveries(hook.id) : Promise.resolve([])), [open, hook.id]);
  return (
    <div className="card stack-sm">
      <div className="row between wrap">
        <div>
          <code>{hook.url}</code> {hook.active ? <span className="tag ok">active</span> : <span className="tag">inactive</span>}
          <div className="muted small">{hook.events.join(', ')}</div>
        </div>
        <div className="row">
          <button className="ghost" onClick={() => setOpen(!open)} aria-expanded={open}>{open ? 'Hide deliveries' : 'Deliveries'}</button>
          {hook.active && <button className="ghost danger" onClick={async () => { await api.deleteWebhook(hook.id); onChanged(); }}>Deactivate</button>}
        </div>
      </div>
      {open && (
        <div className="table-wrap">
          <table>
            <thead><tr><th>Event</th><th>Status</th><th className="num">Attempts</th><th>Last response</th><th>Next attempt</th></tr></thead>
            <tbody>
              {deliveries.data?.map((d) => (
                <tr key={d.id}>
                  <td><code>{d.event_type}</code><div className="muted small">{new Date(d.created_at).toLocaleString()}</div></td>
                  <td><span className={`tag ${d.status === 'succeeded' ? 'ok' : d.status === 'dead' ? 'bad' : 'warn'}`}>{d.status}</span></td>
                  <td className="num">{d.attempts}</td>
                  <td className="small">{d.last_status_code ?? ''} {d.last_error ?? ''}</td>
                  <td className="small muted">{d.status === 'pending' ? new Date(d.next_attempt_at).toLocaleTimeString() : ''}</td>
                </tr>
              ))}
              {deliveries.data?.length === 0 && <tr><td colSpan={5} className="muted">No deliveries yet.</td></tr>}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}
