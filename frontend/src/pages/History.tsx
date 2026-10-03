import { useState } from 'react';
import { api } from '../api';
import { Amount } from '../components/Amount';
import { describe, filterHistory, type HistoryFilter } from '../history';
import { shortId } from '../money';
import { useAsync } from '../useAsync';

const FILTERS: [HistoryFilter, string][] = [['all', 'All'], ['sent', 'Sent'], ['received', 'Received'], ['refunds', 'Refunds']];

export function History() {
  const accounts = useAsync(() => api.accounts(), []);
  const [accountId, setAccountId] = useState('');
  const [filter, setFilter] = useState<HistoryFilter>('all');
  const current = accountId || accounts.data?.[0]?.id || '';
  const history = useAsync(() => (current ? api.history(current) : Promise.resolve([])), [current]);
  const rows = filterHistory(history.data ?? [], filter);

  return (
    <div className="stack">
      <div className="row between wrap">
        <h2>History</h2>
        <select aria-label="Account" value={current} onChange={(e) => setAccountId(e.target.value)}>
          {accounts.data?.map((a) => <option key={a.id} value={a.id}>{a.first_name} {a.last_name} · {shortId(a.id)} · {a.balance}</option>)}
        </select>
      </div>
      <div className="tabs" role="tablist">
        {FILTERS.map(([key, label]) => (
          <button key={key} role="tab" aria-selected={filter === key} onClick={() => setFilter(key)}>{label}</button>
        ))}
      </div>
      {history.error && <p className="error">{history.error}</p>}
      <div className="table-wrap card">
        <table>
          <thead>
            <tr><th>When</th><th>What</th><th>Other account</th><th className="num">Amount</th><th className="num">Fee</th><th /></tr>
          </thead>
          <tbody>
            {rows.map((t) => (
              <tr key={t.id} onClick={() => (window.location.hash = `/transfers/${t.id}`)} className="clickable">
                <td className="muted small">{new Date(t.created_at).toLocaleString()}</td>
                <td>{describe(t)}</td>
                <td>{t.kind === 'deposit' || t.kind === 'adjustment' ? <span className="muted">Platform funding</span> : <code>{shortId(t.direction === 'debit' ? t.to_account_id : t.from_account_id)}</code>}</td>
                <td className="num"><Amount value={t.amount} direction={t.direction} /></td>
                <td className="num muted">{t.direction === 'debit' && t.fee !== '0.00' ? t.fee : ''}</td>
                <td>{t.risk_decision === 'review' && <span className="tag warn">review</span>}</td>
              </tr>
            ))}
            {rows.length === 0 && !history.loading && (
              <tr><td colSpan={6} className="muted">Nothing here.</td></tr>
            )}
          </tbody>
        </table>
      </div>
      <p className="muted small">Shows the latest 100 movements.</p>
    </div>
  );
}
