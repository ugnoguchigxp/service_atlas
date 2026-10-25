import { createHash } from 'node:crypto';
import type { AttemptDetail, BenchmarkCase } from './contracts.ts';

export function markdown(benchmark: BenchmarkCase, attempt: AttemptDetail) {
  const report = attempt.report;
  if (!report) throw new Error('仕様案はまだありません');
  return [
    `# ${report.title}`, '', '**状態: 未レビューの仕様案**', '',
    `対象: ${benchmark.targetUrl}`, `範囲: ${benchmark.scope}`, `試行: ${attempt.id} / 改訂: ${attempt.reportRevision}`, '',
    report.summary, '',
    ...report.operations.flatMap(operation => [
      `## ${operation.name}`, `\`${operation.method} ${operation.path}\``,
      `根拠の由来: ${operation.provenance}`, '',
      `入力: ${operation.inputs}`, `応答: ${operation.response}`, `認証: ${operation.authentication}`,
      `エラー: ${operation.errors}`, `制約: ${operation.constraints}`, '',
      ...operation.evidence.map(ref => `- 根拠 ${ref.artifactId}: ${JSON.stringify(ref.quote)}`),
      ...operation.unknowns.map(value => `- 未確認: ${value}`), '',
    ]),
    '## 事前評価項目（LLM案）', '',
    ...report.assessments.map(item => `- ${benchmark.criteria[item.criterionIndex]}: ${item.status} — ${item.explanation}`), '',
    '## 未確認事項', ...report.unknowns.map(value => `- ${value}`), '',
    '## 証拠manifest', '',
    ...attempt.artifacts.map(artifact => `- ${artifact.id} / ${artifact.kind} / ${artifact.provenance} / SHA-256: ${artifact.sha256}`),
    '', '学習済み定義と実HTTP観測を区別しています。引用の一致だけでは意味の正しさを保証しません。',
  ].join('\n');
}
export function snapshot(benchmark: BenchmarkCase, attempt: AttemptDetail) {
  return {
    schemaVersion: 1, createdAt: new Date().toISOString(), benchmark, attempt,
    manifest: attempt.artifacts.map(({id, sha256, content}) => {
      if (createHash('sha256').update(content).digest('hex') !== sha256) throw new Error('証拠ファイルのハッシュが一致しません');
      return {id, sha256};
    }),
  };
}
