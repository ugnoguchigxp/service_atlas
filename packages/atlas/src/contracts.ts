import { z } from 'zod';

export const caseInput = z.strictObject({
  name: z.string().trim().min(1).max(120),
  targetUrl: z.url().refine(value => {
    const url = new URL(value);
    return url.protocol === 'https:' && !url.username && !url.password;
  }, '資格情報を含まないHTTPSの公開URLを指定してください'),
  scope: z.string().trim().min(1).max(4000),
  criteria: z.array(z.string().trim().min(1).max(500)).min(1).max(30),
  dataPolicy: z.literal('public-only'),
});
export type CaseInput = z.infer<typeof caseInput>;
export type BenchmarkCase = CaseInput & { id: string; createdAt: string };
export const observationSchema = z.object({
  probeId: z.string().min(1).max(200).optional(),
  request: z.object({method: z.enum(['GET','HEAD','POST','PUT','PATCH','DELETE','OPTIONS']), url: z.url(), headers: z.record(z.string(), z.string()).optional(), body: z.string().nullable().optional()}),
  response: z.object({status: z.number().int().min(100).max(599), headers: z.record(z.string(), z.string().nullable()), body: z.string()}),
  captureState: z.literal('complete'), observedAt: z.iso.datetime({offset: true}), durationMs: z.number().nonnegative(),
});
export const importInput = z.strictObject({caseId: z.string().uuid(), observations: z.array(observationSchema).min(1).max(100)});

const citation = z.strictObject({ artifactId: z.string().uuid(), quote: z.string().min(1).max(2000) });
export const reportSchema = z.strictObject({
  title: z.string().min(1),
  summary: z.string(),
  operations: z.array(z.strictObject({
    name: z.string(), method: z.string(), path: z.string(),
    inputs: z.string(), response: z.string(), authentication: z.string(),
    errors: z.string(), constraints: z.string(),
    provenance: z.enum(['http-observed', 'derived', 'hypothesis']),
    evidence: z.array(citation), unknowns: z.array(z.string()),
  })),
  assessments: z.array(z.strictObject({
    criterionIndex: z.number().int().nonnegative(),
    status: z.enum(['documented', 'partial', 'missing']),
    explanation: z.string(), evidence: z.array(citation),
  })),
  unknowns: z.array(z.string()),
});
export type SpecReport = z.infer<typeof reportSchema>;
export type Artifact = {
  id: string; attemptId: string; kind: string;
  provenance: 'derived' | 'run-record' | 'http-observed';
  sourceRef: string; sha256: string; content: string; createdAt: string;
};
export type CollectionMetric = { kind: string; status: 'ok' | 'unavailable'; durationMs: number; bytes: number; reason: string | null };
export type Attempt = {
  id: string; caseId: string; status: 'planning' | 'planned' | 'collecting' | 'collected' | 'analyzing' | 'ready' | 'blocked' | 'failed' | 'interrupted';
  accountAlias: string; runId: string | null; capabilityId: string | null;
  sourceKind: 'direct-http' | 'imported-evidence' | 'playwright-batch';
  createdAt: string; metrics: CollectionMetric[]; error: string | null;
};
export type AttemptDetail = Attempt & { artifacts: Artifact[]; report: SpecReport | null; reportRevision: number; reviewStatus: 'unreviewed'; sourceBinding: 'caller-declared' };

/** Validate references and exact excerpts; semantic correctness still needs review. */
export function validateReport(report: SpecReport, benchmark: BenchmarkCase, artifacts: Artifact[]) {
  const byId = new Map(artifacts.map(artifact => [artifact.id, artifact]));
  for (const item of [...report.operations, ...report.assessments]) {
    if ('status' in item && item.status !== 'missing' && item.evidence.length === 0)
      throw new Error('記述済み・一部記述の判定には根拠が必要です');
    if ('provenance' in item && item.provenance !== 'hypothesis' && item.evidence.length === 0)
      throw new Error('観測・派生仕様には根拠が必要です');
    for (const ref of item.evidence) {
      const artifact = byId.get(ref.artifactId);
      if (!artifact || !artifact.content.includes(ref.quote)) throw new Error('根拠IDまたは引用が保存資料と一致しません');
    }
    if ('provenance' in item && item.provenance === 'http-observed' && !item.evidence.some(ref => byId.get(ref.artifactId)?.provenance === 'http-observed'))
      throw new Error('派生資料だけでHTTP実観測を主張できません');
  }
  const indexes = report.assessments.map(item => item.criterionIndex);
  if (indexes.length !== benchmark.criteria.length || new Set(indexes).size !== indexes.length || indexes.some(index => index >= benchmark.criteria.length))
    throw new Error('事前に登録した評価項目を過不足なく評価してください');
}
