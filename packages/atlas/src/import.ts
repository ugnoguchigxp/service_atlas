import { importInput, type CollectionMetric } from './contracts.ts';
import { serializedEvidence } from './redaction.ts';
import { EvidenceSizeError, type Store } from './store.ts';

/** Import caller-provided observations; no external service or network execution. */
export function importObservations(store: Store, value: unknown) {
  const input = importInput.parse(value);
  const benchmark = store.benchmark(input.caseId);
  const origin = new URL(benchmark.targetUrl).origin;
  for (const observation of input.observations) {
    const url = new URL(observation.request.url);
    if (url.origin !== origin || url.username || url.password) throw new Error('対象環境と観測元が一致しません');
    if (Buffer.byteLength(serializedEvidence(observation)) > 256_000) throw new EvidenceSizeError('観測が保存上限を超えています');
  }
  const attempt = store.createAttempt(input.caseId, 'local-import');
  const metrics: CollectionMetric[] = [];
  try {
    for (const observation of input.observations) {
      store.addArtifact(attempt.id, 'http_request_response', observation.request.url, observation, 'http-observed');
      metrics.push({kind: observation.probeId ?? 'http_request_response', status: 'ok', durationMs: observation.durationMs, bytes: Buffer.byteLength(serializedEvidence(observation)), reason: null});
    }
    store.updateAttempt(attempt.id, {status: 'collected', metrics});
    return store.detail(attempt.id);
  } catch (error) {
    store.updateAttempt(attempt.id, {status: 'failed', metrics, error: '観測の保存が完了しませんでした。'});
    throw error;
  }
}
