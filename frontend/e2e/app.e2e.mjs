// End-to-end test: drives the real app in Chrome against a running stack.
//   docker compose up -d --build   then   npm run e2e   (in frontend/)
// BASE_URL defaults to the compose frontend (nginx), which proxies /api to the API.
import assert from 'node:assert/strict';
import { after, before, test } from 'node:test';
import { chromium } from 'playwright-core';

const BASE = process.env.BASE_URL ?? 'http://localhost:8080';
let browser;
let page;
const errors = [];

async function api(path, { body, token, headers = {} } = {}) {
  const res = await fetch(`${BASE}/api/v1${path}`, {
    method: body ? 'POST' : 'GET',
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}), ...headers },
    body: body ? JSON.stringify(body) : undefined,
  });
  return res.json();
}

before(async () => {
  // Uses the Chrome already installed on the machine; set CHROME_CHANNEL=chromium for a downloaded one.
  browser = await chromium.launch({ channel: process.env.CHROME_CHANNEL ?? 'chrome', headless: true });
  page = await browser.newPage({ viewport: { width: 1280, height: 860 } });
  page.on('pageerror', (e) => errors.push(e.message));
  page.on('console', (m) => m.type() === 'error' && errors.push(m.text()));
});

after(async () => {
  await browser?.close();
});

test('register → open account → send → history → refund → notifications → webhook, with no browser errors', async () => {
  await page.goto(BASE);
  await page.getByRole('button', { name: 'New here? Create a user' }).click();
  await page.fill('#email', `e2e-${Date.now()}@example.com`);
  await page.fill('#password', 'e2e-password-1');
  await page.getByRole('button', { name: 'Create user' }).click();
  await page.getByRole('heading', { name: 'Accounts' }).waitFor();

  await page.fill('#first-name', 'Alice');
  await page.fill('#last-name', 'Smith');
  await page.fill('#starting-balance', '100.00');
  await page.getByRole('button', { name: 'Open account' }).click();
  await page.locator('.balance', { hasText: '100.00' }).waitFor();

  // A second user, created through the API, to pay and be paid by.
  const bob = await api('/auth/register', { body: { email: `e2e-bob-${Date.now()}@example.com`, password: 'e2e-password-2' } });
  const bobAccount = await api('/accounts', { body: { first_name: 'Bob', last_name: 'Jones', starting_balance: '50.00' }, token: bob.token });

  await page.getByRole('link', { name: 'Send money' }).click();
  await page.fill('#to', bobAccount.id);
  await page.fill('#amount', '30.00');
  await page.getByRole('button', { name: 'Send' }).click();
  const sent = await page.getByRole('status').innerText();
  assert.match(sent, /Sent 30\.00/);

  const myAccounts = await page.evaluate(async () => (await (await fetch('/api/v1/accounts', { headers: { authorization: `Bearer ${localStorage.getItem('mtm.token')}` } })).json()).data);
  const paid = await api('/transfers', { body: { from_account_id: bobAccount.id, to_account_id: myAccounts[0].id, amount: '5.00' }, token: bob.token, headers: { 'Idempotency-Key': `e2e-${Date.now()}` } });

  await page.getByRole('link', { name: 'History' }).click();
  await page.locator('tbody tr', { hasText: 'Received' }).waitFor();
  assert.equal(await page.locator('tbody tr').count(), 3);

  await page.goto(`${BASE}/#/transfers/${paid.id}`);
  await page.getByRole('heading', { name: 'Ledger entries' }).waitFor();
  await page.getByRole('button', { name: 'Refund 5.00' }).click();
  await page.locator('dt', { hasText: 'Refund of' }).waitFor();

  // Notifications travel API → outbox → relay → RabbitMQ → worker; the bell polls every 5s.
  await page.goto(`${BASE}/#/`);
  await page.locator('.badge').waitFor({ timeout: 20_000 });
  await page.getByRole('button', { name: /Notifications/ }).click();
  await page.getByText(/You sent 30\.00 to/).waitFor();
  await page.mouse.click(5, 500);

  await page.getByRole('link', { name: 'Developers' }).click();
  await page.fill('#webhook-url', 'https://example.com/hooks/payments');
  await page.getByRole('button', { name: 'Add webhook' }).click();
  assert.match(await page.locator('.secret').innerText(), /^whsec_/);

  // Balance: 100.00 − 30.00 − 0.30 fee (at 1%) + 5.00 − 5.00 refund.
  await page.goto(`${BASE}/#/`);
  await page.locator('.balance', { hasText: '69.70' }).waitFor();

  await page.setViewportSize({ width: 390, height: 844 });
  assert.equal(await page.evaluate(() => document.documentElement.scrollWidth > window.innerWidth), false, 'horizontal overflow at phone width');

  assert.deepEqual(errors, []);
});
