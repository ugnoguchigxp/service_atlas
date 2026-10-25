import { createHash, randomUUID } from 'node:crypto';
import type { AttemptDetail } from './contracts.ts';
import { captureBatch, inspectTarget } from './browser.ts';
import { generatePlan, generateReport, type ModelUsage } from './codex.ts';
import { validatePlan, type ExplorationPlan } from './plan.ts';
import type { Store } from './store.ts';
import { buildEvidencePacket } from './evidence.ts';
import { serializedEvidence } from './redaction.ts';

async function modelCall<T extends {usage?: ModelUsage | null; threadId: string | null}>(store: Store, id: string, phase: 'planning' | 'review', invoke: () => Promise<T>) {
  const callId = randomUUID();
  // Persist before invocation so failed calls are counted too; never retry here.
  store.addArtifact(id, 'llm_invocation', callId, {phase, requestedAt: new Date().toISOString()}, 'run-record');
  try {
    const result = await invoke();
    store.addArtifact(id, 'llm_result', callId, {phase, status: 'completed', threadId: result.threadId, usage: result.usage ?? null}, 'run-record');
    return result;
  } catch (error) {
    store.addArtifact(id, 'llm_result', callId, {phase, status: 'failed', usage: null}, 'run-record');
    throw error;
  }
}

export async function preparePlan(store: Store, caseId: string, deps: {inspect?: typeof inspectTarget; plan?: typeof generatePlan} = {}) {
  const benchmark = store.benchmark(caseId);
  const attempt = store.createAttempt(caseId, 'local-playwright', {sourceKind: 'playwright-batch'});
  store.updateAttempt(attempt.id, {status: 'planning'});
  try {
    const context = await (deps.inspect ?? inspectTarget)(benchmark);
    store.addArtifact(attempt.id, 'planning_context', benchmark.targetUrl, context, 'derived');
    const result = await modelCall(store, attempt.id, 'planning', () => (deps.plan ?? generatePlan)(benchmark, context));
    const plan = validatePlan(benchmark, result.value);
    store.addArtifact(attempt.id, 'exploration_plan', 'plan', plan, 'derived');
    store.updateAttempt(attempt.id, {status: 'planned'});
  } catch {
    store.updateAttempt(attempt.id, {status: 'failed', error: '計画を作成できませんでした。自動でLLMを再呼び出ししていません。'});
  }
  return store.detail(attempt.id);
}

export function savePlan(store: Store, caseId: string, value: unknown) {
  const plan = validatePlan(store.benchmark(caseId), value);
  const attempt = store.createAttempt(caseId, 'local-plan', {sourceKind: 'playwright-batch'});
  store.addArtifact(attempt.id, 'exploration_plan', 'plan', plan, 'derived');
  store.updateAttempt(attempt.id, {status: 'planned'});
  return store.detail(attempt.id);
}

export function readPlan(store: Store, attempt: AttemptDetail): ExplorationPlan {
  const artifact = attempt.artifacts.find(item => item.kind === 'exploration_plan');
  if (!artifact || createHash('sha256').update(artifact.content).digest('hex') !== artifact.sha256)
    throw new Error('保存済み計画がないか、ハッシュが一致しません');
  return validatePlan(store.benchmark(attempt.caseId), JSON.parse(artifact.content));
}

/** Every replay gets fresh evidence, with no planner or reviewer invocation. */
export async function collectPlan(store: Store, planAttemptId: string, capture: typeof captureBatch = captureBatch) {
  const source = store.detail(planAttemptId);
  const plan = readPlan(store, source);
  const benchmark = store.benchmark(source.caseId);
  const attempt = store.createAttempt(source.caseId, 'local-playwright', {sourceKind: 'playwright-batch'});
  store.addArtifact(attempt.id, 'exploration_plan', planAttemptId, plan, 'derived');
  const metrics: AttemptDetail['metrics'] = [];
  try {
    const result = await capture(benchmark, plan, {
      observation: observation => {store.addArtifact(attempt.id, 'http_request_response', observation.request.url, observation, 'http-observed');},
      metric: metric => {metrics.push(metric); store.updateAttempt(attempt.id, {metrics});},
    });
    store.addArtifact(attempt.id, 'batch_result', 'collection', result, 'run-record');
    const failed = result.stepFailed || result.captures === 0;
    store.updateAttempt(attempt.id, {status: failed ? 'failed' : 'collected', metrics, error: failed ? '計画の実行または本文取得が完了していません。取得済みの証拠を保持しました。' : null});
  } catch {
    store.updateAttempt(attempt.id, {status: 'failed', metrics, error: '収集を完了できませんでした。取得済みの証拠を保持し、LLMの自動再計画は行っていません。'});
  }
  return store.detail(attempt.id);
}

export async function analyzeAttempt(store: Store, id: string, generate: typeof generateReport = generateReport) {
  let attempt = store.detail(id);
  if (['planning', 'planned', 'collecting', 'analyzing'].includes(attempt.status) || !attempt.artifacts.some(item => item.kind === 'http_request_response'))
    throw new Error('先にHTTP観測を取得するか、現在の処理完了を待ってください');
  const packet = buildEvidencePacket(attempt.artifacts);
  const content = serializedEvidence(JSON.stringify(packet));
  if (!attempt.artifacts.some(item => item.kind === 'evidence_packet' && item.content === content))
    store.addArtifact(id, 'evidence_packet', 'review-input/v1', content, 'derived');
  attempt = store.detail(id);
  store.updateAttempt(id, {status: 'analyzing', error: null});
  try {
    const result = await modelCall(store, id, 'review', () => generate(store.benchmark(attempt.caseId), attempt));
    store.saveReport(id, result.report, attempt.reportRevision, result.threadId);
  } catch {
    store.updateAttempt(id, {status: 'failed', error: '仕様案の生成または根拠検証に失敗しました。収集済み資料は保持し、LLMを自動再呼び出ししていません。'});
  }
  return store.detail(id);
}
