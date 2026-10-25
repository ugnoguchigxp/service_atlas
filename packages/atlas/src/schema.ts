import { sqliteTable, text, integer, uniqueIndex } from 'drizzle-orm/sqlite-core';
import type { CaseInput, CollectionMetric, SpecReport, Attempt, Artifact } from './contracts.ts';

export const benchmarkCases = sqliteTable('benchmark_cases', {
  id: text('id').primaryKey(), config: text('config_json', {mode: 'json'}).$type<CaseInput>().notNull(),
  createdAt: text('created_at').notNull(),
});
export const attempts = sqliteTable('benchmark_attempts', {
  id: text('id').primaryKey(), caseId: text('case_id').notNull().references(() => benchmarkCases.id),
  status: text('status').$type<Attempt['status']>().notNull(), accountAlias: text('account_alias').notNull(),
  runId: text('run_id'), capabilityId: text('capability_id'),
  sourceKind: text('source_kind').$type<Attempt['sourceKind']>().notNull(),
  metrics: text('metrics_json', {mode: 'json'}).$type<CollectionMetric[]>().notNull(),
  error: text('error'), createdAt: text('created_at').notNull(),
});
export const artifacts = sqliteTable('benchmark_artifacts', {
  id: text('id').primaryKey(), attemptId: text('attempt_id').notNull().references(() => attempts.id),
  kind: text('kind').notNull(), provenance: text('provenance').$type<Artifact['provenance']>().notNull(),
  sourceRef: text('source_ref').notNull(), sha256: text('sha256').notNull(),
  relativePath: text('relative_path').notNull(), createdAt: text('created_at').notNull(),
}, table => [uniqueIndex('artifact_acquisition').on(table.attemptId, table.kind, table.sourceRef, table.sha256)]);
export const reports = sqliteTable('benchmark_reports', {
  attemptId: text('attempt_id').notNull().references(() => attempts.id), revision: integer('revision').notNull(),
  body: text('body_json', {mode: 'json'}).$type<SpecReport>().notNull(),
  threadId: text('thread_id'), createdAt: text('created_at').notNull(),
}, table => [uniqueIndex('report_revision').on(table.attemptId, table.revision)]);
