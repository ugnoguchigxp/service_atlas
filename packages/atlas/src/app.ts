import { Hono } from 'hono';
import { bodyLimit } from 'hono/body-limit';
import { caseInput } from './contracts.ts';
import { openStore, type Store } from './store.ts';
import { importObservations } from './import.ts';
import { generateReport } from './codex.ts';
import { analyzeAttempt, preparePlan, collectPlan, savePlan } from './batch.ts';
import type { generatePlan } from './codex.ts';
import type { inspectTarget, captureBatch } from './browser.ts';
import { explorationPlan } from './plan.ts';
import { readEvidenceRange } from './evidence.ts';
import { markdown, snapshot } from './export.ts';
import { resolve } from 'node:path';
import { z } from 'zod';

export function createApp(store: Store, deps: {
  generate?: typeof generateReport;
  plan?: typeof generatePlan;
  inspect?: typeof inspectTarget;
  capture?: typeof captureBatch;
} = {}) {
  const app = new Hono();
  app.use('/api/*', bodyLimit({maxSize: 256_000}));
  app.use('/api/*', async (context, next) => {
    // Local UI is same-origin; reject cross-site browser mutations and remote hosts.
    const host = new URL(context.req.url).hostname;
    if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return context.json({error: 'ローカル接続のみ利用できます'}, 403);
    const origin = context.req.header('origin');
    if (context.req.header('sec-fetch-site') === 'cross-site' || (origin && origin !== new URL(context.req.url).origin))
      return context.json({error: '同じ画面から操作してください'}, 403);
    context.header('Cache-Control', 'no-store');
    await next();
  });
  app.onError((error, context) => context.json({error: error instanceof z.ZodError ? '入力内容を確認してください' : '処理に失敗しました。試行の状態を確認してください。'}, 400));
  app.get('/api/benchmark', context => context.json(store.list()));
  app.post('/api/benchmark/cases', async context => context.json(store.createCase(caseInput.parse(await context.req.json())), 201));
  app.get('/api/benchmark/attempts/:id', context => context.json(store.detail(context.req.param('id'))));
  app.get('/api/benchmark/attempts/:id/artifacts/:artifactId/body', context => {
    const artifact = store.detail(context.req.param('id')).artifacts.find(item => item.id === context.req.param('artifactId'));
    if (!artifact) return context.json({error: 'この試行に原本がありません'}, 404);
    const range = z.strictObject({start: z.coerce.number().int().nonnegative(), end: z.coerce.number().int().positive()})
      .parse({start: context.req.query('start'), end: context.req.query('end')});
    return context.json(readEvidenceRange(artifact, range.start, range.end));
  });
  app.post('/api/benchmark/import', async context => context.json(importObservations(store, await context.req.json()), 201));
  app.post('/api/benchmark/cases/:id/plan', async context => {
    const result = await preparePlan(store, context.req.param('id'), deps);
    return context.json(result, result.status === 'failed' ? 422 : 201);
  });
  app.post('/api/benchmark/plans', async context => {
    const input = z.strictObject({caseId: z.string().uuid(), plan: explorationPlan}).parse(await context.req.json());
    return context.json(savePlan(store, input.caseId, input.plan), 201);
  });
  app.post('/api/benchmark/attempts/:id/collect', async context => {
    const result = await collectPlan(store, context.req.param('id'), deps.capture);
    return context.json(result, result.status === 'failed' ? 422 : 201);
  });
  app.post('/api/benchmark/attempts/:id/analyze', async context => {
    const id = context.req.param('id');
    const attempt = store.detail(id);
    if (['planning', 'planned', 'analyzing', 'collecting'].includes(attempt.status) || !attempt.artifacts.some(item => item.kind === 'http_request_response'))
      return context.json({error: '先に資料を取得するか、現在の処理完了を待ってください'}, 409);
    const result = await analyzeAttempt(store, id, deps.generate);
    return context.json(result, result.status === 'failed' ? 422 : 200);
  });
  app.get('/api/benchmark/attempts/:id/export', context => {
    const attempt = store.detail(context.req.param('id')); const benchmark = store.benchmark(attempt.caseId);
    const asMarkdown = context.req.query('format') === 'markdown';
    context.header('Content-Disposition', `attachment; filename="atlas-${attempt.id}.${asMarkdown ? 'md' : 'json'}"`);
    if (asMarkdown) return context.text(markdown(benchmark, attempt));
    return context.json(snapshot(benchmark, attempt));
  });
  return app;
}
let singleton: ReturnType<typeof createApp> | undefined;
// Lazy initialization avoids opening a product DB while importing app contracts/tests.
const app = new Hono();
app.all('*', context => {
  singleton ??= createApp(openStore(resolve(process.env.ATLAS_DATA_DIR ?? 'data')));
  return singleton.fetch(context.req.raw);
});
export default app;
