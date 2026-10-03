import { useRef, useState } from 'react';
import { api, ApiError } from '../api';
import { Amount } from '../components/Amount';
import { PaymentAttempt } from '../idempotency';
import { shortId } from '../money';
import { useAsync } from '../useAsync';

const LABELS: Record<string, string> = { transfer: 'Transfer', deposit: 'Opening deposit', refund: 'Refund', adjustment: 'Ledger adjustment' };

export function TransferPage({ id }: { id: string }) {
  const detail = useAsync(() => api.transferDetail(id), [id]);
  const accounts = useAsync(() => api.accounts(), []);
  const [refundError, setRefundError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const attempt = useRef(new PaymentAttempt());

  if (detail.error) return <p className="error">{detail.error}</p>;
  const t = detail.data;
  if (!t) return <p className="muted">Loading…</p>;
  const mine = new Set(accounts.data?.map((a) => a.id));
  const canRefund = t.kind === 'transfer' && !t.refunded_by && mine.has(t.to_account_id);

  async function refund() {
    setBusy(true);
    setRefundError(null);
    try {
      const r = await api.refund(id, attempt.current.keyForSubmit());
      attempt.current.settle('definite');
      window.location.hash = `/transfers/${r.id}`;
    } catch (err) {
      const e = err instanceof ApiError ? err : new ApiError(0, 'unknown', 'Something went wrong');
      attempt.current.settle(e.uncertain ? 'uncertain' : 'definite');
      setRefundError(e.message);
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="narrow stack">
      <a href="#/history" className="small">← History</a>
      <h2>{LABELS[t.kind] ?? t.kind} <Amount value={t.amount} /></h2>
      <dl className="card details">
        <dt>From</dt><dd><code>{t.from_account_id}</code>{mine.has(t.from_account_id) && <span className="tag">yours</span>}</dd>
        <dt>To</dt><dd><code>{t.to_account_id}</code>{mine.has(t.to_account_id) && <span className="tag">yours</span>}</dd>
        <dt>Fee</dt><dd>{t.fee}</dd>
        <dt>When</dt><dd>{new Date(t.created_at).toLocaleString()}</dd>
        <dt>Transfer id</dt><dd><code>{t.id}</code></dd>
        {t.risk_decision && <><dt>Risk check</dt><dd>{t.risk_decision === 'review' ? <span className="tag warn">flagged for review</span> : 'approved'}</dd></>}
        {t.refund_of && <><dt>Refund of</dt><dd><a href={`#/transfers/${t.refund_of}`}>{shortId(t.refund_of)}</a></dd></>}
        {t.refunded_by && <><dt>Refunded by</dt><dd><a href={`#/transfers/${t.refunded_by}`}>{shortId(t.refunded_by)}</a></dd></>}
      </dl>

      <section className="card">
        <h3>Ledger entries</h3>
        <p className="muted small">Every movement is recorded as balanced debits and credits that can't be edited.</p>
        <div className="table-wrap">
          <table>
            <thead><tr><th>Account</th><th>Entry</th><th className="num">Amount</th></tr></thead>
            <tbody>
              {t.ledger_entries.map((e, i) => (
                <tr key={i}>
                  <td><code>{shortId(e.account_id)}</code>{mine.has(e.account_id) && <span className="tag">yours</span>}</td>
                  <td>{e.direction}</td>
                  <td className="num"><Amount value={e.amount} direction={e.direction} /></td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </section>

      {canRefund && (
        <section className="card">
          <h3>Refund</h3>
          <p className="muted small">Sends {t.amount} back to the sender as a new transfer. The original stays in the record. The sender's fee isn't refunded.</p>
          {refundError && <p className="error" role="alert">{refundError}</p>}
          <button className="primary" disabled={busy} onClick={() => void refund()}>{busy ? 'Refunding…' : `Refund ${t.amount}`}</button>
        </section>
      )}
    </div>
  );
}
