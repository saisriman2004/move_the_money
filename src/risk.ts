import type { PoolClient } from 'pg';
import { config } from './config';
import { pool } from './db';
import { HttpError } from './errors';

export type RiskDecision = 'approve' | 'review' | 'reject';

/** Everything the rules look at, gathered from the database. Amounts are decimal strings. */
export interface RiskFacts {
  amount: string;
  transfersLastMinute: number;
  accountAgeHours: number;
  rejectionsLast10Minutes: number;
  /** Results of comparing the amount against each threshold, done in SQL. */
  amountAtLeastReview: boolean;
  amountAtLeastReject: boolean;
  amountAtLeastNewAccountReview: boolean;
}

export interface RiskAssessment {
  decision: RiskDecision;
  reasons: string[];
}

const SEVERITY: Record<RiskDecision, number> = { approve: 0, review: 1, reject: 2 };

/**
 * The rules, as a pure function so they're easy to read and test. Each rule can
 * raise the decision; the most severe one wins. These are deliberately simple
 * stand-ins for a real fraud model.
 */
export function assessRisk(facts: RiskFacts, rules = config.risk): RiskAssessment {
  const hits: [RiskDecision, string][] = [];
  if (facts.amountAtLeastReject) hits.push(['reject', 'amount_over_limit']);
  else if (facts.amountAtLeastReview) hits.push(['review', 'large_amount']);
  if (facts.transfersLastMinute >= rules.maxTransfersPerMinute) hits.push(['reject', 'too_many_transfers']);
  if (facts.rejectionsLast10Minutes >= rules.maxRecentRejections) hits.push(['reject', 'repeated_rejections']);
  if (facts.accountAgeHours < rules.newAccountHours && facts.amountAtLeastNewAccountReview) {
    hits.push(['review', 'new_account_large_transfer']);
  }
  const decision = hits.reduce<RiskDecision>((worst, [d]) => (SEVERITY[d] > SEVERITY[worst] ? d : worst), 'approve');
  return { decision, reasons: hits.map(([, reason]) => reason) };
}

/**
 * Gathers the facts for a transfer. Runs inside the transfer's transaction after
 * the source account is locked, so concurrent transfers from the same account
 * are serialized and the velocity count can't be raced.
 */
export async function gatherRiskFacts(client: PoolClient, fromAccountId: string, amount: string): Promise<RiskFacts> {
  const { rows } = await client.query<RiskFacts>(
    `SELECT $2::text AS "amount",
            (SELECT count(*)::int FROM transfers
              WHERE from_account_id = $1 AND kind = 'transfer' AND created_at > now() - interval '1 minute') AS "transfersLastMinute",
            (SELECT extract(epoch FROM now() - created_at) / 3600 FROM accounts WHERE id = $1)::float AS "accountAgeHours",
            (SELECT count(*)::int FROM risk_decisions
              WHERE from_account_id = $1 AND decision = 'reject' AND created_at > now() - interval '10 minutes') AS "rejectionsLast10Minutes",
            $2::numeric >= $3::numeric AS "amountAtLeastReview",
            $2::numeric >= $4::numeric AS "amountAtLeastReject",
            $2::numeric >= $5::numeric AS "amountAtLeastNewAccountReview"`,
    [fromAccountId, amount, config.risk.reviewAmount, config.risk.rejectAmount, config.risk.newAccountReviewAmount],
  );
  return rows[0]!;
}

/** Thrown for a rejected transfer; carries what's needed to record the rejection. */
export class RiskRejection extends HttpError {
  constructor(
    readonly reasons: string[],
    readonly attempt: { userId: string; fromAccountId: string; amount: string },
  ) {
    super(422, 'risk_rejected', 'Transfer declined by risk checks', { reasons });
  }
}

/**
 * Records a rejection. Called after the transfer's transaction has rolled back,
 * on its own connection, so the record survives and feeds the repeated-rejections rule.
 */
export async function recordRejection(rejection: RiskRejection): Promise<void> {
  const { userId, fromAccountId, amount } = rejection.attempt;
  await pool.query(
    `INSERT INTO risk_decisions (user_id, from_account_id, amount, decision, reasons) VALUES ($1, $2, $3, 'reject', $4)`,
    [userId, fromAccountId, amount, rejection.reasons],
  );
}
