import { timingSafeEqual } from 'node:crypto';
import { chmodSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
import { getDomain } from 'tldts';

const PORT = 3001;
const NEGATIVE = '... /ᐠ - ˕ -マ';
const POSITIVE = '!! (˵◝ ⩊  ◜˵マ';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const WEEK = 7 * 24 * HOUR;
function validDomain(domain) {
  if (typeof domain !== 'string' || domain.length === 0 || domain.length > 253) return false;
  const labels = domain.split('.');
  return labels.length >= 2
    && labels.every(label => /^[a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?$/.test(label))
    && !(labels.length === 4 && labels.every(label => /^[0-9]+$/.test(label)));
}

function reply(body, status, headers = {}) {
  return new Response(body, {
    status,
    headers: { 'Cache-Control': 'no-store', ...headers },
  });
}

function authorized(req, token) {
  if (!token || token.length < 32) return false;
  const actual = Buffer.from(req.headers.get('authorization') || '');
  const expected = Buffer.from(`Bearer ${token}`);
  return actual.length === expected.length && timingSafeEqual(actual, expected);
}

export function createApprovalService({
  metricsToken = process.env.TLS_METRICS_TOKEN || '',
  now = () => Date.now(),
  database = new Database(':memory:'),
} = {}) {
  database.exec(`
    PRAGMA journal_mode = WAL;
    PRAGMA busy_timeout = 100;
    CREATE TABLE IF NOT EXISTS approvals (
      hostname TEXT NOT NULL,
      registered_domain TEXT NOT NULL,
      approved_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS approvals_hostname ON approvals(hostname, approved_at);
    CREATE INDEX IF NOT EXISTS approvals_domain ON approvals(registered_domain, approved_at);
    CREATE INDEX IF NOT EXISTS approvals_time ON approvals(approved_at);
  `);
  const prune = database.query('DELETE FROM approvals WHERE approved_at <= ?');
  const hostnameApprovals = database.query('SELECT COUNT(*) AS count, MIN(approved_at) AS oldest FROM approvals WHERE hostname = ? AND approved_at > ?');
  const domainApprovals = database.query('SELECT COUNT(*) AS count, MIN(approved_at) AS oldest FROM approvals WHERE registered_domain = ? AND approved_at > ?');
  const allApprovals = database.query('SELECT COUNT(*) AS count, MIN(approved_at) AS oldest FROM approvals WHERE approved_at > ?');
  const record = database.query('INSERT INTO approvals (hostname, registered_domain, approved_at) VALUES (?, ?, ?)');
  const approve = database.transaction((hostname, registeredDomain, time) => {
    prune.run(time - WEEK);
    const limits = [
      [hostnameApprovals.get(hostname, time - 10 * MINUTE), 3, 10 * MINUTE],
      [domainApprovals.get(registeredDomain, time - HOUR), 10, HOUR],
      [domainApprovals.get(registeredDomain, time - WEEK), 40, WEEK],
      [allApprovals.get(time - HOUR), 100, HOUR],
    ];
    let retryAfter = 0;
    for (const [window, limit, duration] of limits) {
      if (window.count >= limit) retryAfter = Math.max(retryAfter, window.oldest + duration - time);
    }
    if (retryAfter > 0) return Math.ceil(retryAfter / 1000);
    record.run(hostname, registeredDomain, time);
    return 0;
  });
  const metrics = { started_at: now(), approved: 0, denied: 0, rate_limited: 0, errors: 0 };

  return function handleApproval(req) {
    const url = new URL(req.url);
    if (req.method !== 'GET') return reply(`method not allowed${NEGATIVE}`, 405);
    if (url.pathname === '/health') return reply('oki', 200);
    if (url.pathname === '/ready') {
      try {
        database.query('SELECT 1').get();
        return reply('oki', 200);
      } catch {
        return reply(`tls approval unavailable${NEGATIVE}`, 503);
      }
    }
    if (url.pathname === '/metrics') {
      if (!authorized(req, metricsToken)) return reply(`access denied${NEGATIVE}`, 403);
      return Response.json(metrics, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (url.pathname !== '/') return reply(`not found${NEGATIVE}`, 404);
    const domain = (url.searchParams.get('domain') ?? url.searchParams.get('server_name') ?? '').toLowerCase();
    if (!domain || !validDomain(domain)) {
      metrics.denied++;
      return reply(`${domain ? 'invalid domain' : 'missing domain'}${NEGATIVE}`, 400);
    }
    const registeredDomain = getDomain(domain, { allowPrivateDomains: true }) || domain;
    try {
      const retryAfter = approve.immediate(domain, registeredDomain, now());
      if (retryAfter) {
        metrics.denied++;
        metrics.rate_limited++;
        return reply(`certificate request limit reached${NEGATIVE}`, 429, { 'Retry-After': String(retryAfter) });
      }
    } catch {
      metrics.denied++;
      metrics.errors++;
      return reply(`tls approval unavailable${NEGATIVE}`, 503);
    }
    metrics.approved++;
    return reply(`yes${POSITIVE}`, 200);
  };
}

if (import.meta.main) {
  try {
    const directory = join(import.meta.dir, '../../data');
    mkdirSync(directory, { recursive: true, mode: 0o700 });
    const filename = join(directory, 'tls-approval.db');
    const database = new Database(filename, { create: true });
    chmodSync(filename, 0o600);
    const server = Bun.serve({ hostname: '127.0.0.1', port: PORT, fetch: createApprovalService({ database }) });
    console.log(`tls server listening on ${server.port}${POSITIVE}`);
  } catch {
    console.error(`tls approval startup failed${NEGATIVE}`);
    process.exit(1);
  }
}
