import Database from 'better-sqlite3';
import { drizzle } from 'drizzle-orm/better-sqlite3';
import { migrate } from 'drizzle-orm/better-sqlite3/migrator';
import { desc, eq } from 'drizzle-orm';
import { createHash, randomUUID } from 'node:crypto';
import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as schema from './schema.ts';
import { caseInput, reportSchema, validateReport, type Artifact, type Attempt, type AttemptDetail, type BenchmarkCase, type CaseInput, type SpecReport } from './contracts.ts';
import { serializedEvidence, redact } from './redaction.ts';
import { verifyEvidencePacket } from './evidence.ts';

export class EvidenceSizeError extends Error {}

export function openStore(directory: string) {
  mkdirSync(directory, {recursive: true, mode: 0o700});
  const native = new Database(join(directory, 'atlas.sqlite'));
  native.pragma('journal_mode = WAL'); native.pragma('foreign_keys = ON'); native.pragma('busy_timeout = 5000');
  const db = drizzle(native, {schema});
  migrate(db, {migrationsFolder: fileURLToPath(new URL('../migrations', import.meta.url))});
  function benchmark(id: string): BenchmarkCase {
    const row = db.select().from(schema.benchmarkCases).where(eq(schema.benchmarkCases.id, id)).get();
    if (!row) throw new Error('対象のベンチマークがありません');
    return {...row.config, id: row.id, createdAt: row.createdAt};
  }
  function detail(id: string): AttemptDetail {
    const row = db.select().from(schema.attempts).where(eq(schema.attempts.id, id)).get();
    if (!row) throw new Error('対象の試行がありません');
    const evidence = db.select().from(schema.artifacts).where(eq(schema.artifacts.attemptId, id)).all().map(({relativePath, ...artifact}) => ({...artifact, content: readFileSync(join(directory, relativePath), 'utf8')}));
    const latest = db.select().from(schema.reports).where(eq(schema.reports.attemptId, id)).orderBy(desc(schema.reports.revision)).get();
    return {...row, artifacts: evidence, report: latest?.body ?? null, reportRevision: latest?.revision ?? 0, reviewStatus: 'unreviewed', sourceBinding: 'caller-declared'};
  }
  return {
    benchmark, detail, close: () => native.close(),
    list: () => ({
      cases: db.select().from(schema.benchmarkCases).orderBy(desc(schema.benchmarkCases.createdAt)).all().map(row => ({...row.config, id: row.id, createdAt: row.createdAt})),
      attempts: db.select().from(schema.attempts).orderBy(desc(schema.attempts.createdAt)).all(),
    }),
    createCase(input: CaseInput) {
      const config = caseInput.parse(redact(input));
      const id = randomUUID(); const createdAt = new Date().toISOString();
      db.insert(schema.benchmarkCases).values({id, config, createdAt}).run();
      return benchmark(id);
    },
    createAttempt(caseId: string, accountAlias: string, refs: {sourceKind?: Attempt['sourceKind']} = {}) {
      benchmark(caseId);
      const row: Attempt = {id: randomUUID(), caseId, accountAlias, runId: null, capabilityId: null, sourceKind: refs.sourceKind ?? 'imported-evidence', status: 'collecting', metrics: [], error: null, createdAt: new Date().toISOString()};
      db.insert(schema.attempts).values(row).run();
      return row;
    },
    updateAttempt(id: string, patch: Partial<Pick<Attempt, 'status' | 'metrics' | 'error' | 'capabilityId'>>) {
      const changed = db.update(schema.attempts).set(patch).where(eq(schema.attempts.id, id)).run();
      if (changed.changes !== 1) throw new Error('試行を更新できません');
    },
    addArtifact(attemptId: string, kind: string, sourceRef: string, value: unknown, provenance: Artifact['provenance']) {
      const content = serializedEvidence(value);
      if (Buffer.byteLength(content) > 256_000) throw new EvidenceSizeError('証拠は256KBを超えるため保存していません');
      const sha256 = createHash('sha256').update(content).digest('hex');
      const relativePath = join('artifacts', sha256.slice(0, 2), sha256);
      const path = join(directory, relativePath); mkdirSync(dirname(path), {recursive: true, mode: 0o700});
      if (!existsSync(path)) {
        const temp = `${path}.${randomUUID()}.tmp`;
        writeFileSync(temp, content, {mode: 0o600}); renameSync(temp, path);
      }
      const artifact = {id: randomUUID(), attemptId, kind, sourceRef, provenance, sha256, relativePath, createdAt: new Date().toISOString()};
      db.insert(schema.artifacts).values(artifact).onConflictDoNothing().run();
      return artifact.id;
    },
    saveReport(attemptId: string, body: SpecReport, expectedRevision: number, threadId: string | null = null) {
      return db.transaction(tx => {
        const attempt = detail(attemptId);
        if (attempt.reportRevision !== expectedRevision) throw new Error('仕様案が更新されています。再読込してください');
        const parsed = reportSchema.parse(redact(body));
        const cited = new Set([...parsed.operations, ...parsed.assessments].flatMap(item => item.evidence.map(ref => ref.artifactId)));
        for (const artifact of attempt.artifacts.filter(item => item.kind === 'evidence_packet' && cited.has(item.id))) verifyEvidencePacket(attempt.artifacts, artifact);
        validateReport(parsed, benchmark(attempt.caseId), attempt.artifacts);
        tx.insert(schema.reports).values({attemptId, revision: expectedRevision + 1, body: parsed, threadId, createdAt: new Date().toISOString()}).run();
        tx.update(schema.attempts).set({status: 'ready', error: null}).where(eq(schema.attempts.id, attemptId)).run();
        return expectedRevision + 1;
      });
    },
  };
}
export type Store = ReturnType<typeof openStore>;
