/**
 * CLI for the ticket-drop simulation / load test.
 *
 *   npm run ticket-drop -- --requests 2000 --concurrency 300 --hot-seats 5
 *   npm run ticket-drop -- --strategy optimistic --mode direct
 *   npm run ticket-drop -- --compare        # all 4 strategy x mode combos, summary table
 *   npm run ticket-drop -- --compare --no-redis-lock   # send the whole herd to Postgres
 *
 * Exit code 1 if any correctness check fails, so it can gate CI.
 */
import { parseArgs } from 'node:util';
import { CHECKOUT_MODES, LOCK_STRATEGIES, type CheckoutMode, type LockStrategyName } from '../config';
import { DEFAULT_DROP_OPTIONS, formatReport, runTicketDrop, type TicketDropReport } from '../sim/ticketDrop';

const { values } = parseArgs({
  options: {
    url: { type: 'string', default: process.env.API_URL ?? 'http://localhost:4000' },
    requests: { type: 'string', default: String(DEFAULT_DROP_OPTIONS.requests) },
    concurrency: { type: 'string', default: String(DEFAULT_DROP_OPTIONS.concurrency) },
    users: { type: 'string', default: String(DEFAULT_DROP_OPTIONS.users) },
    'hot-seats': { type: 'string', default: String(DEFAULT_DROP_OPTIONS.hotSeats) },
    'seats-per-request': { type: 'string', default: String(DEFAULT_DROP_OPTIONS.seatsPerRequest) },
    strategy: { type: 'string', default: DEFAULT_DROP_OPTIONS.strategy },
    mode: { type: 'string', default: DEFAULT_DROP_OPTIONS.mode },
    'no-confirm': { type: 'boolean', default: false },
    'no-redis-lock': { type: 'boolean', default: false },
    compare: { type: 'boolean', default: false },
    json: { type: 'boolean', default: false },
  },
});

function check<T extends string>(name: string, v: string, allowed: readonly T[]): T {
  if (!allowed.includes(v as T)) throw new Error(`--${name} must be one of ${allowed.join(', ')}`);
  return v as T;
}

const base = {
  baseUrl: values.url!,
  requests: Number(values.requests),
  concurrency: Number(values.concurrency),
  users: Number(values.users),
  hotSeats: Number(values['hot-seats']),
  seatsPerRequest: Number(values['seats-per-request']),
  confirm: !values['no-confirm'],
  redisLock: !values['no-redis-lock'],
};

async function main() {
  const combos: { strategy: LockStrategyName; mode: CheckoutMode }[] = values.compare
    ? LOCK_STRATEGIES.flatMap((strategy) => CHECKOUT_MODES.map((mode) => ({ strategy, mode })))
    : [{ strategy: check('strategy', values.strategy!, LOCK_STRATEGIES), mode: check('mode', values.mode!, CHECKOUT_MODES) }];

  const reports: TicketDropReport[] = [];
  for (const combo of combos) {
    const report = await runTicketDrop({ ...base, ...combo }, (m) => console.error(`  .. ${m}`));
    reports.push(report);
    console.log(values.json ? JSON.stringify(report, null, 2) : formatReport(report));
  }

  if (reports.length > 1) {
    console.log('\n SUMMARY');
    console.table(
      reports.map((r) => ({
        strategy: r.options.strategy,
        mode: r.options.mode,
        'holds granted': r.holdPhase.successfulHolds,
        'p50 ms': r.holdPhase.latencyMs.p50,
        'p95 ms': r.holdPhase.latencyMs.p95,
        'p99 ms': r.holdPhase.latencyMs.p99,
        errors5xx: Object.entries(r.holdPhase.statusCounts)
          .filter(([k]) => k.startsWith('5') || k.startsWith('0'))
          .reduce((a, [, v]) => a + v, 0),
        passed: r.checks.passed,
      })),
    );
  }
  if (reports.some((r) => !r.checks.passed)) process.exitCode = 1;
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
