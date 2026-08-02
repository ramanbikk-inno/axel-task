/**
 * Load harness for the §11 target: 1,000 concurrent users, dashboard reads
 * under 2s and the paginated user list under 3s.
 *
 * Deliberately dependency-free (node:http only) so it runs in CI without
 * pulling a load-testing toolchain into the image. It is not a replacement for
 * a real distributed load test against production-shaped infrastructure - it
 * measures whether one instance and its connection pool hold up.
 *
 *   node test/load/concurrent-users.mjs --url http://localhost:3000/api/v1 \
 *     --email admin@example.com --password '...' --concurrency 1000 --seconds 30
 *
 * Exits non-zero if the p95 for any scenario misses its budget, so it can gate
 * a pipeline once someone points it at a deployed environment.
 */
import http from 'node:http';
import https from 'node:https';
import { URL } from 'node:url';

const args = new Map();
for (let i = 2; i < process.argv.length; i += 2) {
  args.set(process.argv[i].replace(/^--/, ''), process.argv[i + 1]);
}

const BASE = args.get('url') ?? 'http://localhost:3000/api/v1';
const EMAIL = args.get('email') ?? process.env.SUPER_ADMIN_EMAIL;
const PASSWORD = args.get('password') ?? process.env.SUPER_ADMIN_PASSWORD;
const CONCURRENCY = Number(args.get('concurrency') ?? 1000);
const SECONDS = Number(args.get('seconds') ?? 30);

if (!EMAIL || !PASSWORD) {
  console.error('Need --email and --password (or SUPER_ADMIN_EMAIL/SUPER_ADMIN_PASSWORD).');
  process.exit(2);
}

/** Budgets from spec §11 Performance & Scale Targets. */
const SCENARIOS = [
  { name: 'GET /profile/me', path: '/profile/me', budgetMs: 2000 },
  { name: 'GET /users?limit=100', path: '/users?page=1&limit=100', budgetMs: 3000 },
];

// One agent per protocol, with a socket pool wide enough that the harness
// itself is never the bottleneck being measured.
const agents = {
  'http:': new http.Agent({ keepAlive: true, maxSockets: CONCURRENCY + 50 }),
  'https:': new https.Agent({ keepAlive: true, maxSockets: CONCURRENCY + 50 }),
};

function request(method, path, { token, body } = {}) {
  const url = new URL(BASE + path);
  const client = url.protocol === 'https:' ? https : http;
  const payload = body === undefined ? null : Buffer.from(JSON.stringify(body));

  return new Promise((resolve) => {
    const startedAt = process.hrtime.bigint();
    const req = client.request(
      {
        protocol: url.protocol,
        hostname: url.hostname,
        port: url.port,
        path: url.pathname + url.search,
        method,
        agent: agents[url.protocol],
        headers: {
          ...(token ? { Authorization: `Bearer ${token}` } : {}),
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
        },
      },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
          resolve({ status: res.statusCode, ms, body: Buffer.concat(chunks).toString() });
        });
      },
    );
    req.on('error', (err) => {
      const ms = Number(process.hrtime.bigint() - startedAt) / 1e6;
      resolve({ status: 0, ms, error: err.message });
    });
    if (payload) req.write(payload);
    req.end();
  });
}

function percentile(sorted, p) {
  if (sorted.length === 0) return NaN;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[idx];
}

async function login() {
  const res = await request('POST', '/auth/login', { body: { email: EMAIL, password: PASSWORD } });
  if (res.status !== 200) {
    throw new Error(`login failed: ${res.status} ${res.body ?? res.error}`);
  }
  return JSON.parse(res.body).accessToken;
}

/** Hold `concurrency` requests in flight until the clock runs out. */
async function run(scenario, token) {
  const latencies = [];
  const errors = new Map();
  const deadline = Date.now() + SECONDS * 1000;

  const worker = async () => {
    while (Date.now() < deadline) {
      const res = await request('GET', scenario.path, { token });
      latencies.push(res.ms);
      if (res.status !== 200) {
        const key = res.error ?? `HTTP ${res.status}`;
        errors.set(key, (errors.get(key) ?? 0) + 1);
      }
    }
  };

  const startedAt = Date.now();
  await Promise.all(Array.from({ length: CONCURRENCY }, worker));
  const elapsedSec = (Date.now() - startedAt) / 1000;

  latencies.sort((a, b) => a - b);
  const errorCount = [...errors.values()].reduce((a, b) => a + b, 0);
  return {
    scenario,
    count: latencies.length,
    rps: latencies.length / elapsedSec,
    p50: percentile(latencies, 50),
    p95: percentile(latencies, 95),
    p99: percentile(latencies, 99),
    max: latencies[latencies.length - 1],
    errorCount,
    errors,
  };
}

const token = await login();
console.log(`${CONCURRENCY} concurrent callers, ${SECONDS}s per scenario, against ${BASE}\n`);

let failed = false;
for (const scenario of SCENARIOS) {
  const r = await run(scenario, token);
  const ok = r.errorCount === 0 && r.p95 <= scenario.budgetMs;
  failed ||= !ok;

  console.log(`${ok ? 'PASS' : 'FAIL'}  ${scenario.name}`);
  console.log(`      ${r.count} requests, ${r.rps.toFixed(0)} rps`);
  console.log(
    `      p50 ${r.p50.toFixed(0)}ms  p95 ${r.p95.toFixed(0)}ms  p99 ${r.p99.toFixed(0)}ms  max ${r.max.toFixed(0)}ms  (budget p95 <= ${scenario.budgetMs}ms)`,
  );
  if (r.errorCount > 0) {
    console.log(`      ${r.errorCount} failed: ${[...r.errors].map(([k, v]) => `${k} x${v}`).join(', ')}`);
  }
  console.log();
}

process.exit(failed ? 1 : 0);
