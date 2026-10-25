import { afterAll, afterEach, beforeAll, describe, expect, test, vi } from 'vitest';
import { chromium, type Browser } from 'playwright';
import { createServer, type Server } from 'node:http';
import { once } from 'node:events';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../src/store.ts';
import { preparePlan, collectPlan, savePlan, analyzeAttempt } from '../src/batch.ts';
import { validatePlan, type ExplorationPlan } from '../src/plan.ts';
import { executeBatch } from '../src/browser.ts';
import { createApp } from '../src/app.ts';
import type { generateReport } from '../src/codex.ts';
import type { captureBatch } from '../src/browser.ts';
import type { BenchmarkCase } from '../src/contracts.ts';

const resources: {directory: string; store: Store}[] = [];
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-batch-'));
  const store = openStore(directory); resources.push({directory, store});
  const benchmark = store.createCase({name: 'batch fixture', targetUrl: 'https://example.com/', scope: 'public read', criteria: ['response'], dataPolicy: 'public-only'});
  return {store, benchmark};
}
afterEach(() => resources.splice(0).forEach(({store, directory}) => {store.close(); rmSync(directory, {recursive: true, force: true});}));
const plan: ExplorationPlan = {title: 'fixture', rationale: 'compare', captureResourceTypes: ['xhr', 'fetch'], settleMs: 0, steps: [
  {action: 'request', method: 'GET', url: 'https://example.com/items?q=a', purpose: 'normal'},
  {action: 'request', method: 'GET', url: 'https://example.com/items', purpose: 'omitted'},
]};
const observation = {request: {method: 'GET' as const, url: 'https://example.com/items'}, response: {status: 200, headers: {'content-type': 'application/json'}, body: '{"items":[]}'}, captureState: 'complete' as const, observedAt: '2026-10-25T00:00:00Z', durationMs: 1};
const capture = vi.fn<typeof captureBatch>(async (_benchmark, _plan, sink) => {
  sink.observation(observation);
  sink.metric({kind: 'fixture', status: 'ok', durationMs: 1, bytes: 12, reason: null});
  return {captures: 1, gaps: 0, stepFailed: false, observationWindowClosed: true};
});

describe('batched model budget and persistence', () => {
  test('one planning call, zero calls across replays, one review, and durable usage', async () => {
    const {store, benchmark} = setup();
    const planner = vi.fn(async () => ({value: plan, threadId: 'planner', usage: {input_tokens: 100, cached_input_tokens: 10, output_tokens: 50}}));
    const prepared = await preparePlan(store, benchmark.id, {inspect: async () => ({url: benchmark.targetUrl, title: '', text: '', links: [], controls: [], limits: {textOmitted: false, linksOmitted: 0, controlsOmitted: 0}, gaps: []}), plan: planner});
    expect(prepared.status).toBe('planned'); expect(planner).toHaveBeenCalledTimes(1);
    const first = await collectPlan(store, prepared.id, capture);
    const second = await collectPlan(store, prepared.id, capture);
    expect(first.status).toBe('collected'); expect(second.id).not.toBe(first.id);
    expect(first.artifacts.filter(item => item.kind === 'llm_invocation')).toHaveLength(0);
    expect(second.artifacts.filter(item => item.kind === 'llm_invocation')).toHaveLength(0);
    expect(planner).toHaveBeenCalledTimes(1);
    const reviewer = vi.fn<typeof generateReport>(async (_benchmark, attempt) => ({report: {
      title: 'fixture', summary: 'observed', operations: [], unknowns: [],
      assessments: [{criterionIndex: 0, status: 'partial' as const, explanation: 'one response', evidence: [{artifactId: attempt.artifacts.find(item => item.kind === 'http_request_response')!.id, quote: 'items'}]}],
    }, threadId: 'review', usage: {input_tokens: 200, cached_input_tokens: 0, output_tokens: 60}}));
    const reviewed = await analyzeAttempt(store, first.id, reviewer);
    expect(reviewed.status).toBe('ready'); expect(reviewer).toHaveBeenCalledTimes(1);
    expect(reviewed.artifacts.filter(item => item.kind === 'llm_invocation')).toHaveLength(1);
    const result = reviewed.artifacts.find(item => item.kind === 'llm_result')!;
    expect(JSON.parse(result.content).usage.input_tokens).toBe(200);
    expect(store.detail(prepared.id).artifacts.filter(item => item.kind === 'llm_invocation')).toHaveLength(1);
  });
  test('failed planning is recorded without automatic retry', async () => {
    const {store, benchmark} = setup(); const planner = vi.fn(async () => {throw new Error('provider private error');});
    const result = await preparePlan(store, benchmark.id, {inspect: async () => ({url: '', title: '', text: '', links: [], controls: [], limits: {textOmitted: false, linksOmitted: 0, controlsOmitted: 0}, gaps: []}), plan: planner});
    expect(result.status).toBe('failed'); expect(planner).toHaveBeenCalledTimes(1);
    expect(result.artifacts.filter(item => item.kind === 'llm_invocation')).toHaveLength(1);
    expect(JSON.stringify(result)).not.toContain('provider private error');
  });
  test('rejects out-of-scope plans and unsupported writes before creating an attempt', () => {
    const {store, benchmark} = setup();
    expect(() => savePlan(store, benchmark.id, {...plan, steps: [{action: 'request', method: 'POST', url: benchmark.targetUrl, purpose: 'write'}]})).toThrow();
    expect(() => validatePlan(benchmark, {...plan, steps: [{action: 'navigate', url: 'https://other.example/', purpose: 'outside'}]})).toThrow('origin');
    expect(store.list().attempts).toHaveLength(0);
  });
  test('API plan import→collection→replay never requires a model', async () => {
    const {store, benchmark} = setup(); const planner = vi.fn(async () => {throw new Error('must not run');});
    const app = createApp(store, {plan: planner, capture});
    const saved = await app.request('/api/benchmark/plans', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({caseId: benchmark.id, plan})});
    expect(saved.status).toBe(201); const prepared = await saved.json();
    for (let index = 0; index < 2; index++) {
      const response = await app.request(`/api/benchmark/attempts/${prepared.id}/collect`, {method: 'POST'});
      expect(response.status).toBe(201); expect((await response.json()).status).toBe('collected');
    }
    expect(planner).not.toHaveBeenCalled();
  });
});

describe('real Chromium batch collection', () => {
  let browser: Browser; let server: Server; let outside: Server; let origin: string; let outsideUrl: string; let writes = 0; let outsideHits = 0;
  beforeAll(async () => {
    outside = createServer((_request, response) => {outsideHits++; response.end('outside');});
    outside.listen(0, '127.0.0.1'); await once(outside, 'listening');
    const outsideAddress = outside.address(); if (!outsideAddress || typeof outsideAddress === 'string') throw new Error('fixture address');
    outsideUrl = `http://127.0.0.1:${outsideAddress.port}/outside`;
    server = createServer((request, response) => {
      if (request.method === 'POST') {writes++; response.end('unexpected'); return;}
      if (request.url === '/items') {response.setHeader('content-type', 'application/json'); response.end('{"items":[1]}'); return;}
      if (request.url === '/redirect') {response.writeHead(302, {location: 'https://other.example/private'}); response.end('redirect'); return;}
      if (request.url === '/redirect-local') {response.writeHead(302, {location: outsideUrl}); response.end('redirect'); return;}
      response.setHeader('content-type', 'text/html');
      response.end('<label>Query<input /></label><button onclick="fetch(\'/items\')">Load data</button><script>fetch("/write",{method:"POST"}).catch(()=>{});</script>');
    });
    server.listen(0, '127.0.0.1'); await once(server, 'listening');
    const address = server.address(); if (!address || typeof address === 'string') throw new Error('fixture address');
    origin = `http://127.0.0.1:${address.port}`;
    browser = await chromium.launch({headless: true});
  });
  afterAll(async () => {await browser?.close(); if (server) await new Promise<void>(resolve => server.close(() => resolve())); if (outside) await new Promise<void>(resolve => outside.close(() => resolve()));});
  test('runs navigate/fill/click in one batch, records complete API response, blocks POST', async () => {
    const context = await browser.newContext({serviceWorkers: 'block'});
    const observations: typeof observation[] = []; const metrics: unknown[] = [];
    const benchmark: BenchmarkCase = {id: crypto.randomUUID(), createdAt: '', name: 'fixture', targetUrl: origin, scope: '', criteria: ['response'], dataPolicy: 'public-only'};
    try {
      const result = await executeBatch(context, benchmark, {...plan, settleMs: 100, steps: [
        {action: 'navigate', url: origin, purpose: 'entry'},
        {action: 'fill', locator: {by: 'label', value: 'Query'}, value: 'abc', purpose: 'input'},
        {action: 'click', locator: {by: 'role', role: 'button', name: 'Load data'}, purpose: 'read'},
      ]}, {observation: value => observations.push(value as typeof observation), metric: value => metrics.push(value)});
      expect(result.stepFailed).toBe(false); expect(result.captures).toBe(1); expect(writes).toBe(0);
      expect(observations[0]!.response.body).toBe('{"items":[1]}'); expect(observations[0]!.captureState).toBe('complete');
      expect(result.gaps).toBeGreaterThan(0);
    } finally {await context.close();}
  });
  test('direct requests record redirects without following them off origin', async () => {
    const context = await browser.newContext();
    const statuses: number[] = [];
    try {
      const benchmark: BenchmarkCase = {id: crypto.randomUUID(), createdAt: '', name: 'fixture', targetUrl: origin, scope: '', criteria: ['response'], dataPolicy: 'public-only'};
      const result = await executeBatch(context, benchmark, {...plan, steps: [{action: 'request', method: 'GET', url: `${origin}/redirect`, purpose: 'redirect'}]}, {observation: value => statuses.push(value.response.status), metric: () => {}});
      expect(result.stepFailed).toBe(false); expect(statuses).toEqual([302]);
    } finally {await context.close();}
  });
  test('browser navigation cannot follow a redirect outside the allowed origin', async () => {
    const context = await browser.newContext();
    try {
      const benchmark: BenchmarkCase = {id: crypto.randomUUID(), createdAt: '', name: 'fixture', targetUrl: origin, scope: '', criteria: ['response'], dataPolicy: 'public-only'};
      await executeBatch(context, benchmark, {...plan, captureResourceTypes: ['document'], steps: [{action: 'navigate', url: `${origin}/redirect-local`, purpose: 'redirect boundary'}]}, {observation: () => {}, metric: () => {}});
      expect(outsideHits).toBe(0);
    } finally {await context.close();}
  });
});
