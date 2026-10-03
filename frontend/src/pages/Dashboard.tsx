import { useState, type FormEvent } from 'react';
import { api, ApiError, type Account } from '../api';
import { Amount } from '../components/Amount';
import { describe } from '../history';
import { shortId, validateAmount } from '../money';
import { useAsync } from '../useAsync';

export function Dashboard() {
  const accounts = useAsync(() => api.accounts(), []);
  const [selected, setSelected] = useState<string | null>(null);
  const current = selected ?? accounts.data?.[0]?.id ?? null;

  return (
    <div className="stack">
      <section>
        <div className="row between">
          <h2>Accounts</h2>
        </div>
        {accounts.error && <p className="error">{accounts.error}</p>}
        {accounts.data && accounts.data.length === 0 && <p className="muted">You don't have an account yet. Open one below.</p>}
        <div className="accounts">
          {accounts.data?.map((a) => (
            <AccountCard key={a.id} account={a} selected={a.id === current} onSelect={() => setSelected(a.id)} />
          ))}
        </div>
      </section>

      <div className="grid-2">
        <section className="card">
          <h3>Recent activity {current && <span className="muted small">in {shortId(current)}</span>}</h3>
          {current ? <RecentActivity accountId={current} /> : <p className="muted">Open an account to see activity.</p>}
        </section>
        <section className="card">
          <h3>Open an account</h3>
          <OpenAccount onOpened={(a) => { void accounts.reload(); setSelected(a.id); }} />
        </section>
      </div>
    </div>
  );
}

function AccountCard({ account, selected, onSelect }: { account: Account; selected: boolean; onSelect: () => void }) {
  const [copied, setCopied] = useState(false);
  return (
    <div className={`card account ${selected ? 'selected' : ''}`}>
      <button className="account-select" onClick={onSelect} aria-pressed={selected}>
        <span className="muted small">{account.first_name} {account.last_name}</span>
        <span className="balance">{account.balance}</span>
      </button>
      <div className="row between small">
        <code title={account.id}>{shortId(account.id)}</code>
        <button
          className="link"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(account.id);
              setCopied(true);
              setTimeout(() => setCopied(false), 1500);
            } catch {
              window.prompt('Account id', account.id);
            }
          }}
        >
          {copied ? 'Copied' : 'Copy id'}
        </button>
      </div>
    </div>
  );
}

function RecentActivity({ accountId }: { accountId: string }) {
  const history = useAsync(() => api.history(accountId, 6), [accountId]);
  if (history.error) return <p className="error">{history.error}</p>;
  if (!history.data) return <p className="muted">Loading…</p>;
  if (history.data.length === 0) return <p className="muted">No activity yet.</p>;
  return (
    <>
      <ul className="plain activity">
        {history.data.map((t) => (
          <li key={t.id}>
            <a href={`#/transfers/${t.id}`} className="row between">
              <span>
                {describe(t)} <span className="muted small">{new Date(t.created_at).toLocaleString()}</span>
                {t.risk_decision === 'review' && <span className="tag warn">review</span>}
              </span>
              <Amount value={t.amount} direction={t.direction} />
            </a>
          </li>
        ))}
      </ul>
      <a href="#/history" className="small">All history →</a>
    </>
  );
}

function OpenAccount({ onOpened }: { onOpened: (a: Account) => void }) {
  const [first, setFirst] = useState('');
  const [last, setLast] = useState('');
  const [balance, setBalance] = useState('');
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  async function submit(e: FormEvent) {
    e.preventDefault();
    const invalid = validateAmount(balance);
    if (invalid) return setError(invalid);
    setBusy(true);
    setError(null);
    try {
      onOpened(await api.openAccount(first, last, balance.trim()));
      setFirst('');
      setLast('');
      setBalance('');
    } catch (err) {
      setError(err instanceof ApiError ? err.message : 'Something went wrong');
    } finally {
      setBusy(false);
    }
  }

  return (
    <form className="form" onSubmit={submit}>
      <div className="row">
        <label>First name<input id="first-name" required value={first} onChange={(e) => setFirst(e.target.value)} /></label>
        <label>Last name<input id="last-name" required value={last} onChange={(e) => setLast(e.target.value)} /></label>
      </div>
      <label>Starting balance<input id="starting-balance" inputMode="decimal" placeholder="100.00" required value={balance} onChange={(e) => setBalance(e.target.value)} /></label>
      {error && <p className="error" role="alert">{error}</p>}
      <button className="primary" disabled={busy}>{busy ? 'Opening…' : 'Open account'}</button>
    </form>
  );
}
