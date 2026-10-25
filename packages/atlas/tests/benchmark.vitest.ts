import { afterEach, describe, expect, test } from 'vitest';
import { mkdtempSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { openStore, type Store } from '../src/store.ts';
import { importObservations } from '../src/import.ts';
import { caseInput, importInput, validateReport, type SpecReport, type BenchmarkCase } from '../src/contracts.ts';
import { serializedEvidence } from '../src/redaction.ts';
import { createApp } from '../src/app.ts';
import { snapshot, markdown } from '../src/export.ts';
import { codexConfig, specificationInstructions, structuredOutputSchema } from '../src/codex.ts';
import { explorationPlan } from '../src/plan.ts';

const directories: string[] = []; const stores: Store[] = [];
function setup() {
  const directory = mkdtempSync(join(tmpdir(), 'atlas-test-')); directories.push(directory);
  const store = openStore(directory); stores.push(store);
  const benchmark = store.createCase({name: '合成fixture', targetUrl: 'https://example.com/', scope: '合成APIの証拠を取り込む', criteria: ['入力と応答を記述できる'], dataPolicy: 'public-only'});
  return {store, directory, benchmark};
}
afterEach(() => {stores.splice(0).forEach(store => {try {store.close();} catch {}}); directories.splice(0).forEach(path => rmSync(path, {recursive: true, force: true}));});
const observation = {
  request: {method: 'GET', url: 'https://example.com/items'},
  response: {status: 200, headers: {'content-type': 'application/json'}, body: '[]'},
  captureState: 'complete', observedAt: '2026-10-25T00:00:00Z', durationMs: 120,
};
function imported(store: Store, benchmark: BenchmarkCase) {
  return importObservations(store, {caseId: benchmark.id, observations: [observation]});
}
function report(artifactId: string): SpecReport {
  return {title: '合成fixture仕様案', summary: '画面確認用の合成資料です。',
    operations: [{name: '合成検索', method: 'GET', path: '/items', inputs: 'query: string', response: '本文は未確認', authentication: '未確認', errors: '未確認', constraints: '未確認', provenance: 'derived', evidence: [{artifactId, quote: '/items'}], unknowns: ['HTTP本文は未取得']}],
    assessments: [{criterionIndex: 0, status: 'partial', explanation: '入力は派生資料にあるが応答は未確認', evidence: [{artifactId, quote: '/items'}]}], unknowns: ['認証とエラーは未確認']};
}
describe('boundary contracts', () => {
  test('requires explicit public data policy and rejects unexpected execution settings', () => {
    const value = {name: 'x', targetUrl: 'https://example.com', scope: 'x', criteria: ['x'], dataPolicy: 'public-only'};
    expect(caseInput.safeParse(value).success).toBe(true);
    expect(caseInput.safeParse({...value, dataPolicy: 'private'}).success).toBe(false);
    expect(caseInput.safeParse({...value, targetUrl: 'https://user:secret@example.com'}).success).toBe(false);
    expect(caseInput.safeParse({...value, execute: 'arbitrary'}).success).toBe(false);
    expect(importInput.safeParse({caseId: crypto.randomUUID(), observations: [observation], execute: true}).success).toBe(false);
    expect(importInput.safeParse({caseId: crypto.randomUUID(), observations: [{...observation, captureState: 'partial'}]}).success).toBe(false);
  });
  test('redacts standard credential containers, query values and YAML without interpreting semantics', () => {
    const value = serializedEvidence({headers: [{name: 'Cookie', value: 'session=secret'}], Authorization: 'Bearer secret',
      nested: {access_token: 'top-secret'}, url: 'https://example.com/?token=url-secret&query=hello', yaml: 'password: yaml-secret\nquery: hello'});
    for (const secret of ['session=secret', 'Bearer secret', 'top-secret', 'url-secret', 'yaml-secret']) expect(value).not.toContain(secret);
    expect(value).toContain('hello');
  });
});
describe('import and persistence', () => {
  test('stores complete observations with provenance and removes credentials', () => {
    const {store, benchmark} = setup();
    const result = importObservations(store, {caseId: benchmark.id, observations: [{...observation, request: {...observation.request, headers: {Authorization: 'Bearer SECRET'}}}]});
    expect(result.status).toBe('collected'); expect(result.sourceKind).toBe('imported-evidence');
    expect(result.runId).toBeNull(); expect(result.artifacts).toHaveLength(1);
    expect(result.artifacts[0]!.provenance).toBe('http-observed');
    expect(JSON.stringify(result)).not.toContain('SECRET');
  });
  test('rejects mismatched origins and oversize evidence before creating a trial', () => {
    const {store, benchmark} = setup();
    expect(() => importObservations(store, {caseId: benchmark.id, observations: [{...observation, request: {...observation.request, url: 'https://other.example/items'}}]})).toThrow('一致');
    expect(() => importObservations(store, {caseId: benchmark.id, observations: [{...observation, response: {...observation.response, body: 'x'.repeat(256001)}}]})).toThrow('上限');
    expect(store.list().attempts).toHaveLength(0);
  });
  test('deduplicates bytes while preserving independent trial records', () => {
    const {store, directory, benchmark} = setup();
    const a = imported(store, benchmark), b = imported(store, benchmark);
    expect(store.list().attempts).toHaveLength(2);
    expect(a.artifacts[0]!.sha256).toBe(b.artifacts[0]!.sha256);
    expect(a.artifacts[0]!.id).not.toBe(b.artifacts[0]!.id);
    const files = readdirSync(join(directory, 'artifacts'), {recursive: true, withFileTypes: true}).filter(file => file.isFile());
    expect(files).toHaveLength(1);
  });
  test('opening another connection does not declare an active trial interrupted', () => {
    const {store, directory, benchmark} = setup();
    const attempt = store.createAttempt(benchmark.id, 'fixture');
    const second = openStore(directory); stores.push(second);
    expect(second.detail(attempt.id).status).toBe('collecting');
  });
  test('direct HTTP evidence retains its source after reopening', () => {
    const {store, directory, benchmark} = setup();
    const attempt = store.createAttempt(benchmark.id, 'public-no-key', {sourceKind: 'direct-http'});
    store.addArtifact(attempt.id, 'http_request_response', observation.request.url, observation, 'http-observed');
    const reopened = openStore(directory); stores.push(reopened);
    const saved = reopened.detail(attempt.id);
    expect(saved.sourceKind).toBe('direct-http'); expect(saved.runId).toBeNull();
    expect(saved.artifacts[0]!.provenance).toBe('http-observed');
  });
});
describe('specification evidence contract', () => {
  test('rejects cross-trial citations, false HTTP provenance and incomplete rubric coverage', async () => {
    const {store, benchmark} = setup();
    const a = imported(store, benchmark);
    const b = imported(store, benchmark);
    expect(() => validateReport(report(a.artifacts[0]!.id), benchmark, b.artifacts)).toThrow('根拠ID');
    const value = report(a.artifacts[0]!.id); value.operations[0]!.provenance = 'http-observed';
    expect(() => validateReport(value, benchmark, a.artifacts.map(item => ({...item, provenance: 'derived'})))).toThrow('HTTP実観測');
    value.operations[0]!.provenance = 'derived'; value.assessments = [];
    expect(() => validateReport(value, benchmark, a.artifacts)).toThrow('評価');
  });
  test('keeps versioned reports, detects conflicts and exports verifiable evidence', async () => {
    const {store, benchmark} = setup();
    const attempt = imported(store, benchmark);
    const value = report(attempt.artifacts[0]!.id);
    expect(store.saveReport(attempt.id, value, 0)).toBe(1);
    expect(() => store.saveReport(attempt.id, value, 0)).toThrow('更新');
    expect(store.saveReport(attempt.id, value, 1)).toBe(2);
    const detail = store.detail(attempt.id);
    expect(detail.reviewStatus).toBe('unreviewed'); expect(detail.status).toBe('ready');
    expect(snapshot(benchmark, detail).manifest).toHaveLength(1);
    expect(markdown(benchmark, detail)).toContain('未レビュー');
    detail.artifacts[0]!.content += 'tamper';
    expect(() => snapshot(benchmark, detail)).toThrow('ハッシュ');
  });
});
describe('API integration', () => {
  test('API import→SQLite/files→specification stand-in→export', async () => {
    const {store, benchmark} = setup();
    const app = createApp(store, {generate: async (_benchmark, attempt) => ({report: report(attempt.artifacts[0]!.id), threadId: null})});
    const collected = await app.request('/api/benchmark/import', {method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify({caseId: benchmark.id, observations: [observation]})});
    expect(collected.status).toBe(201); const attempt = await collected.json();
    const analyzed = await app.request(`/api/benchmark/attempts/${attempt.id}/analyze`, {method: 'POST'});
    expect(analyzed.status).toBe(200); expect((await analyzed.json()).reportRevision).toBe(1);
    const exported = await app.request(`/api/benchmark/attempts/${attempt.id}/export`);
    expect(exported.status).toBe(200); expect((await exported.json()).manifest).toHaveLength(4);
  });
  test('removed collection endpoint is absent and cross-site mutations are refused', async () => {
    const {store} = setup(); const app = createApp(store);
    expect((await app.request('/api/benchmark/collect', {method: 'POST'})).status).toBe(404);
    const overview = await (await app.request('/api/benchmark')).json();
    expect(overview).not.toHaveProperty('connection');
    expect((await app.request('/api/benchmark/cases', {method: 'POST', headers: {origin: 'https://untrusted.example'}})).status).toBe(403);
  });
  test('invalid model citations do not mark a trial complete', async () => {
    const {store, benchmark} = setup();
    const attempt = imported(store, benchmark);
    const app = createApp(store, {generate: async () => ({report: report(crypto.randomUUID()), threadId: null})});
    const result = await app.request(`/api/benchmark/attempts/${attempt.id}/analyze`, {method: 'POST'});
    expect(result.status).toBe(422); expect(store.detail(attempt.id).status).toBe('failed'); expect(store.detail(attempt.id).report).toBeNull();
    expect(store.detail(attempt.id).artifacts.filter(item => item.kind === 'http_request_response')).toHaveLength(1);
    expect(store.detail(attempt.id).artifacts.filter(item => item.kind === 'llm_invocation')).toHaveLength(1);
  });
});
test('Codex receives evidence-only instructions and no inherited execution tools', () => {
  expect(codexConfig.features.shell_tool).toBe(false); expect(codexConfig.features.multi_agent).toBe(false);
  expect(codexConfig.features.plugins).toBe(false); expect(codexConfig.project_doc_max_bytes).toBe(0);
  expect(specificationInstructions).toContain('対象サービスのAPIと収集ツール自身のAPIを区別');
});
test('planning output fits provider strict schemas without weakening action contracts', () => {
  const schema = structuredOutputSchema(explorationPlan);
  const encoded = JSON.stringify(schema);
  expect(encoded).not.toContain('"oneOf"');
  expect(encoded).not.toContain('"format":"uri"');
  expect(encoded).toContain('"anyOf"');
  const stepArray = schema.properties?.steps;
  if (!stepArray || typeof stepArray !== 'object') throw new Error('step array missing');
  const steps = stepArray.items;
  expect(steps).not.toBeInstanceOf(Array);
  if (!steps || typeof steps !== 'object' || Array.isArray(steps)) throw new Error('steps schema missing');
  expect(steps.anyOf).toHaveLength(4);
  expect(explorationPlan.safeParse({title: 'x', rationale: '', captureResourceTypes: ['fetch'], settleMs: 0,
    steps: [{action: 'request', purpose: 'x', method: 'POST', url: 'https://example.com'}]}).success).toBe(false);
  expect(explorationPlan.safeParse({title: 'x', rationale: '', captureResourceTypes: ['fetch'], settleMs: 0,
    steps: [{action: 'request', purpose: 'x', method: 'GET', url: 'not-a-url'}]}).success).toBe(false);
});
