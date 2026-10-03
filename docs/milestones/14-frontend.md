# 14. React dashboard

**What.** `frontend/`: a React 19 + TypeScript app built with Vite, talking only to `/api/v1`.
- **Sign in / register.**
- **Overview:** accounts with balances and copyable ids, recent activity, open an account.
- **Send money:** choose a source account, paste a recipient id, enter an amount.
- **History:** All / Sent / Received / Refunds filters.
- **Transfer detail:** the ledger entries, and a refund button for transfers you received.
- **Notifications:** an unread badge polled every 5 seconds.
- **Developers:** add webhooks (secret shown once), inspect deliveries, deactivate.

**Why.** It makes the whole system visible: a payment, its fee, its ledger entries, the notification that arrives a moment later through RabbitMQ, and the webhook deliveries.

**How.**
- **Money stays a string** in the browser too: amounts are validated with the API's own pattern and displayed exactly as the API returns them. The browser never adds up money.
- **One idempotency key per intended payment** (`PaymentAttempt`). The key is created on first submit and kept while the outcome is uncertain (no response or a 5xx), so **Retry** reuses it and can't pay twice. A definite answer (2xx or 4xx) or any edit to the form starts a new payment.
- **Hash routing and a tiny `useAsync` hook** instead of a router and data library. Fewer dependencies for six screens.
- **The dev server proxies `/api`**, so the browser sees one origin and needs no CORS. In production nginx does the same (milestone 16).

**Bugs this milestone found in the backend.**
1. **Body-less POSTs got 415.** The refund and mark-read buttons send no body; the Vite proxy forwards those with chunked encoding, and the API treated "a body with no Content-Type" as non-JSON. The 415 check now only rejects bodies that declare a non-JSON type (still catching form posts), and the client sends `{}` for body-less POSTs. Regression test: an empty chunked POST with no Content-Type returns 204.
2. **The outbox relay crashed on a missed RabbitMQ heartbeat.** amqplib emits `'error'` before `'close'`; with no listener, Node killed the process before the clean "exit and restart" path could run, and notifications silently stopped. The publisher and consumer now handle `'error'` and let `'close'` stop the worker cleanly. Regression tests emit the same error on a live connection.

**Decisions.**
- **The token is in `localStorage`.** Simple, but readable by any script that manages to run on the page (XSS). An httpOnly cookie with CSRF protection would be safer, at the cost of a session layer.
- **Polling for notifications**, as explained in milestone 11.
- **The plan's "description" field isn't there:** transfers don't have one in the API.

**How it was tested.**
- 19 unit tests (Vitest): amount validation, key reuse on uncertain outcomes and a new key after definite ones or edits, and history filters and labels.
- A scripted walkthrough in real Chrome (`playwright-core` with the installed browser) against the full local stack (API, relay, notification worker, RabbitMQ, Redis, PostgreSQL): register, open an account, send 30.00 (fee 0.30), see history, refund a received payment from its detail page, receive 4 notifications through the event pipeline, add a webhook and see its secret, and check there's no horizontal overflow at phone width (390 px). Screenshots were checked by eye; the final balance of 69.70 matches the arithmetic. The walkthrough becomes a committed end-to-end test in milestone 17.
- CI gains a frontend job: install, typecheck, test, build.
