# 16. Containerized full stack

**What.** `docker compose up -d --build` runs the whole platform:
- PostgreSQL, Redis and RabbitMQ
- a one-shot `migrate` job
- the API
- four workers: outbox relay, notifications, webhooks, reconciliation
- the web app on nginx

Open http://localhost:8080.

**How.**
- **One backend image** (`Dockerfile`, multi-stage): a build stage compiles TypeScript with dev dependencies; the runtime stage has only production dependencies, the compiled `dist/` and the migrations, and runs as the unprivileged `node` user. The API, `migrate` and each worker are the same image with a different command.
- **Frontend image** (`frontend/Dockerfile`): Vite builds static files; nginx serves them with a Content-Security-Policy and long caching for hashed assets, and proxies `/api/` to the API, so the browser sees a single origin (no CORS needed). The API runs with `TRUST_PROXY=1` so per-IP limits see the real client.
- **Startup order:** PostgreSQL healthy → `migrate` completes successfully → API and workers start. Every long-running service has a health check: the API's `/ready`, each worker's `/health` on its metrics port, and nginx's `/health`.
- **Restarts are part of the design:** workers exit when they lose RabbitMQ (milestones 7 and 14), and `restart: unless-stopped` brings them back.

**Problems the containers found.**
1. **The frontend wasn't self-contained.** `vite.config.ts` uses `process`, whose types were silently coming from the backend's `node_modules` one folder up. In a clean image the build failed, and the new CI frontend job would have too. Fixed by declaring `@types/node` in the frontend.
2. **nginx's health check failed inside the container.** Busybox `wget` resolves `localhost` to IPv6 `::1`, and nginx was only listening on IPv4. nginx now listens on both, and the check uses `127.0.0.1`.
3. **Credentials.** The compose RabbitMQ uses a dedicated `mtm` user instead of `guest`, and development, tests and CI now all use the same one.

**What can fail.**
- While RabbitMQ is starting, the workers crash-loop: each attempt to connect fails, the process exits, and Docker restarts it. In testing they restarted 5 times each before RabbitMQ was ready. It's harmless, but a connect retry with backoff at startup would be cleaner.
- `JWT_SECRET` has a demo default in the compose file. A real deployment must set it, along with real database and broker credentials.
- There's no TLS: in production a load balancer or ingress terminates it in front of nginx.

**How it was tested.**
- `docker compose up -d --build --wait` brought all 9 long-running services to healthy, and the backend test suite (249) passed against the compose RabbitMQ and Redis.
- The browser end-to-end test (`frontend/e2e/app.e2e.mjs`, `npm run e2e`) passed against the containerized app through nginx: register, open an account, send 30.00 (fee 0.30), history, refund, a notification through the event pipeline, a webhook secret, a final balance of 69.70, no horizontal overflow at phone width, and no browser console errors.
- Restarting RabbitMQ under the running stack: the relay, notification and webhook workers logged the lost connection, were restarted by Docker, became healthy again, and the end-to-end test passed afterwards.
