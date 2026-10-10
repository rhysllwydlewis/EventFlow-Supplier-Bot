import { readFile } from 'node:fs/promises';
import { parseArgs } from 'node:util';
import { railwayObservationSchema } from '../operator/assess.js';
import { ControlClient } from '../operator/client.js';
import { loadPreviousRun, renderMarkdown, runOperator, writeRunLog } from '../operator/run.js';

// Boots-on-the-ground operator for the deployed bot. Reads the live Control
// Centre, applies the written approval policy (src/operator/policy.ts) and
// writes a dated run log. Dry run unless --apply is passed.
//
//   CONTROL_ADMIN_KEY=... npm run operator -- --url https://<control-host> [--apply]
//        [--log-dir docs/operator-runs] [--railway-json observation.json]
//
// Exit codes: 0 = nothing needs the owner, 2 = owner needs to be told, 1 = failure.

async function main(): Promise<number> {
  const { values } = parseArgs({
    options: {
      url: { type: 'string' },
      apply: { type: 'boolean', default: false },
      'log-dir': { type: 'string', default: 'docs/operator-runs' },
      'railway-json': { type: 'string' },
      'stale-hours': { type: 'string' },
    },
  });

  const baseUrl = values.url ?? process.env.SUPPLIER_BOT_CONTROL_URL;
  const adminKey = process.env.CONTROL_ADMIN_KEY;
  if (!baseUrl) throw new Error('Pass --url or set SUPPLIER_BOT_CONTROL_URL');
  if (!adminKey) throw new Error('CONTROL_ADMIN_KEY is not set');
  if (!/^https:\/\//.test(baseUrl) && !/^http:\/\/(localhost|127\.0\.0\.1)/.test(baseUrl)) {
    throw new Error('Refusing to send the admin key over a non-HTTPS URL');
  }

  const logDir = values['log-dir'] ?? 'docs/operator-runs';
  const railway = values['railway-json']
    ? railwayObservationSchema.parse(JSON.parse(await readFile(values['railway-json'], 'utf8')))
    : null;
  const staleHours = values['stale-hours'] ? Number(values['stale-hours']) : undefined;
  if (staleHours !== undefined && !(staleHours > 0)) throw new Error('--stale-hours must be a positive number');

  const previous = await loadPreviousRun(logDir);
  const client = new ControlClient(baseUrl, adminKey);
  const log = await runOperator(client, baseUrl, {
    apply: values.apply ?? false,
    logDir,
    railway,
    ...(staleHours !== undefined ? { staleAfterHours: staleHours } : {}),
  });
  const paths = await writeRunLog(log, previous, logDir);

  process.stdout.write(`${renderMarkdown(log, previous)}\n`);
  process.stdout.write(`Run log written: ${paths.jsonPath}\n`);
  return log.notifyOwner.needed ? 2 : 0;
}

main()
  .then(code => {
    process.exitCode = code;
  })
  .catch(error => {
    // Never echo request bodies or headers here: the admin key travels in one.
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
