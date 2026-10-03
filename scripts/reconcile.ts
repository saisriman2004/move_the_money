// One-off reconciliation: prints the report and exits 1 on any mismatch,
// so it can run from cron or a CI job. Usage: npm run reconcile
import { closePool } from '../src/db';
import { reconcile } from '../src/reconciliation';

reconcile()
  .then((report) => {
    console.log(JSON.stringify(report, null, 2));
    if (report.status !== 'reconciled') process.exitCode = 1;
  })
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(closePool);
