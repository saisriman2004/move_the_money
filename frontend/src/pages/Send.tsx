import { useRef, useState, type FormEvent } from 'react';
import { api, ApiError, type Transfer } from '../api';
import { PaymentAttempt } from '../idempotency';
import { shortId, validateAmount } from '../money';
import { useAsync } from '../useAsync';

type Result =
  | { kind: 'sent'; transfer: Transfer; replayed: boolean }
  | { kind: 'error'; message: string; reasons?: string[]; canRetry: boolean };

export function Send() {
  const accounts = useAsync(() => api.accounts(), []);
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [amount, setAmount] = useState('');
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<Result | null>(null);
  const attempt = useRef(new PaymentAttempt());

  const source = from || accounts.data?.[0]?.id || '';
  // Any change makes it a different payment, which needs a different key.
  const edit = (set: (v: string) => void) => (v: string) => {
    attempt.current.reset();
    setResult(null);
    set(v);
  };

  async function submit(e?: FormEvent) {
    e?.preventDefault();
    const invalid = validateAmount(amount) ?? (to.trim() ? null : 'Enter the account id to pay');
    if (invalid) return setResult({ kind: 'error', message: invalid, canRetry: false });
    setBusy(true);
    const key = attempt.current.keyForSubmit();
    try {
      const { transfer, replayed } = await api.transfer(source, to.trim(), amount.trim(), key);
      attempt.current.settle('definite');
      setResult({ kind: 'sent', transfer, replayed });
      setAmount('');
      void accounts.reload();
    } catch (err) {
      const e2 = err instanceof ApiError ? err : new ApiError(0, 'unknown', 'Something went wrong');
      attempt.current.settle(e2.uncertain ? 'uncertain' : 'definite');
      setResult({
        kind: 'error',
        message: e2.uncertain ? `${e2.message} Retrying is safe: it reuses the same idempotency key, so you can't be charged twice.` : e2.message,
        reasons: Array.isArray(e2.body.reasons) ? (e2.body.reasons as string[]) : undefined,
        canRetry: e2.uncertain,
      });
    } finally {
      setBusy(false);
    }
  }

  const sourceAccount = accounts.data?.find((a) => a.id === source);

  return (
    <div className="narrow stack">
      <h2>Send money</h2>
      <form className="card form" onSubmit={submit}>
        <label>
          From
          <select id="from" value={source} onChange={(e) => edit(setFrom)(e.target.value)}>
            {accounts.data?.map((a) => (
              <option key={a.id} value={a.id}>
                {a.first_name} {a.last_name} · {shortId(a.id)} · {a.balance}
              </option>
            ))}
          </select>
        </label>
        <label>
          To account id
          <input id="to" list="own-accounts" placeholder="Paste the recipient's account id" value={to} onChange={(e) => edit(setTo)(e.target.value)} />
          <datalist id="own-accounts">
            {accounts.data?.filter((a) => a.id !== source).map((a) => <option key={a.id} value={a.id}>{a.first_name} {a.last_name} (yours)</option>)}
          </datalist>
        </label>
        <label>
          Amount
          <input id="amount" inputMode="decimal" placeholder="25.00" value={amount} onChange={(e) => edit(setAmount)(e.target.value)} />
        </label>
        {sourceAccount && <p className="muted small">Available: {sourceAccount.balance}. A fee may be added on top.</p>}
        <button className="primary" disabled={busy || !source}>{busy ? 'Sending…' : 'Send'}</button>
      </form>

      {result?.kind === 'sent' && (
        <div className="card success" role="status">
          <strong>{result.replayed ? 'Already sent' : 'Sent'}</strong> {result.transfer.amount}
          {result.transfer.fee !== '0.00' && <> (fee {result.transfer.fee})</>} to {shortId(result.transfer.to_account_id)}.
          {result.replayed && <p className="small">The server recognised this as a retry of an earlier submission and didn't move the money again.</p>}
          {result.transfer.risk_decision === 'review' && <p className="small">This transfer went through but was flagged for review.</p>}
          <p><a href={`#/transfers/${result.transfer.id}`}>View transfer and ledger entries →</a></p>
        </div>
      )}
      {result?.kind === 'error' && (
        <div className="card failure" role="alert">
          <p>{result.message}</p>
          {result.reasons && <ul>{result.reasons.map((r) => <li key={r}><code>{r}</code></li>)}</ul>}
          {result.canRetry && <button className="primary" onClick={() => void submit()} disabled={busy}>Retry</button>}
        </div>
      )}
    </div>
  );
}
