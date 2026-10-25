import { openStore } from './store.ts';
import { caseInput } from './contracts.ts';
import { importObservations } from './import.ts';
import { analyzeAttempt, preparePlan, collectPlan, savePlan } from './batch.ts';
import { markdown, snapshot } from './export.ts';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const [command, argument] = process.argv.slice(2);
if (!command || command === 'help') {
  console.log('atlas benchmark: status | case <public-case.json> | plan <caseId> | plan-import <plan.json> | collect <planAttemptId> | import <observations.json> | analyze <attemptId> | export <attemptId> | markdown <attemptId>');
} else {
  const store = openStore(resolve(process.env.ATLAS_DATA_DIR ?? 'data'));
  try {
    let result: unknown;
    if (command === 'status') result = store.list();
    else if (command === 'case') result = store.createCase(caseInput.parse(JSON.parse(readFileSync(argument!, 'utf8'))));
    else if (command === 'import') result = importObservations(store, JSON.parse(readFileSync(argument!, 'utf8')));
    else if (command === 'plan') result = await preparePlan(store, argument!);
    else if (command === 'plan-import') {
      const input = JSON.parse(readFileSync(argument!, 'utf8'));
      result = savePlan(store, input.caseId, input.plan);
    } else if (command === 'collect') result = await collectPlan(store, argument!);
    else if (command === 'analyze') result = await analyzeAttempt(store, argument!);
    else if (command === 'export' || command === 'markdown') {
      const attempt = store.detail(argument!); const benchmark = store.benchmark(attempt.caseId);
      result = command === 'markdown' ? markdown(benchmark, attempt) : snapshot(benchmark, attempt);
    } else throw new Error('unknown command');
    console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
    if (result && typeof result === 'object' && 'status' in result && result.status === 'failed') process.exitCode = 1;
  } catch {
    console.error('処理できませんでした。入力と保存済みの試行を確認してください。'); process.exitCode = 1;
  } finally {store.close();}
}
