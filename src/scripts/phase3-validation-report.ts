import { closeMongo } from '../lib/mongo.js';
import { getSettings } from '../repositories/settings.repository.js';
import { getPhase3ValidationReport } from '../services/phase3-validation.service.js';

async function main(): Promise<void> {
  const settings = await getSettings();
  const report = await getPhase3ValidationReport(settings);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
}

main()
  .catch(error => {
    process.stderr.write(`${error instanceof Error ? error.stack || error.message : String(error)}\n`);
    process.exitCode = 1;
  })
  .finally(async () => {
    await closeMongo().catch(() => undefined);
  });
