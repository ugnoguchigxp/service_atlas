import { describe, expect, test } from 'vitest';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { buildEvidencePacket, verifyEvidencePacket, readEvidenceRange } from '../src/evidence.ts';
import { createApp } from '../src/app.ts';
import { serializedEvidence } from '../src/redaction.ts';
import { openStore } from '../src/store.ts';
import { importObservations } from '../src/import.ts';
import { analyzeAttempt } from '../src/batch.ts';
import { snapshot } from '../src/export.ts';
import type { Artifact } from '../src/contracts.ts';

const sha = (value: string) => createHash('sha256').update(value).digest('hex');
function observation(body: string, url = 'https://example.com/data') {
  return {request: {method: 'GET', url}, response: {status: 200, headers: {'Content-Type': 'text/csv'}, body}, captureState: 'complete', observedAt: '2026-10-25T00:00:00Z', durationMs: 1};
}
function artifact(body: string, url?: string): Artifact {
  const content = serializedEvidence(observation(body, url));
  return {id: randomUUID(), attemptId: randomUUID(), kind: 'http_request_response', sourceRef: url ?? 'https://example.com/data', provenance: 'http-observed', createdAt: '2026-10-25T00:00:00Z', content, sha256: sha(content)};
}
function packetArtifact(sources: Artifact[]): Artifact {
  const content = JSON.stringify(buildEvidencePacket(sources));
  return {...sources[0]!, id: randomUUID(), kind: 'evidence_packet', provenance: 'derived', content, sha256: sha(content)};
}

describe('compact evidence with retained originals', () => {
  test('scans every record and retains a late rare value without business-specific rules', () => {
    const csv = ['identifier,sequence,reading', ...Array.from({length: 2000}, (_, index) => `00${index},${index},${index === 1800 ? -4321 : index === 1900 ? 9000 : 0}`)].join('\n');
    const source = artifact(csv), original = source.content;
    const packet = buildEvidencePacket([source]);
    const view = packet.bodies[0]!.view as ReturnType<typeof csvSummary>;
    expect(view.recordsAfterFirst).toBe(2000);
    expect(view.columns[2]!.finiteNumberInterpretation).toMatchObject({min: -4321, max: 9000, minRecord: 1802});
    expect(view.examples.some(row => row.record === 1802)).toBe(true);
    expect(JSON.stringify(packet)).not.toContain(csv);
    expect(source.content).toBe(original); expect(sha(source.content)).toBe(source.sha256);
    expect(Buffer.byteLength(JSON.stringify(packet))).toBeLessThan(Buffer.byteLength(source.content) / 2);
  });
  test('preserves exact UTF-8 byte ranges and citations for BOM, CRLF and quoted multiline fields', () => {
    const body = '\ufeffidentifier,label\r\n001,"あ,い\r\nう"\r\n002,"二重""引用"\r\n';
    const source = artifact(body), packet = buildEvidencePacket([source]);
    const view = packet.bodies[0]!.view as ReturnType<typeof csvSummary>;
    expect(view.recordsAfterFirst).toBe(2);
    expect(view.firstRecord.byteStart).toBe(3);
    for (const example of [view.firstRecord, ...view.examples]) {
      const raw = Buffer.from(body).subarray(example.byteStart, example.byteEnd).toString('utf8');
      expect(JSON.stringify(raw).slice(1, -1)).toBe(example.quote);
      expect(source.content).toContain(example.quote);
    }
    expect(view.examples[0]!.cells[0]).toBe('001');
  });
  test('deduplicates byte-identical bodies and computes multiset differences, including duplicates', () => {
    const a = artifact('id,value\n1,a\n1,a\n2,b\n', 'https://example.com/data?x=1');
    const b = artifact('id,value\n1,a\n3,c\n', 'https://example.com/data?x=2');
    const c = artifact('id,value\n1,a\n1,a\n2,b\n', 'https://example.com/data?x=3');
    const packet = buildEvidencePacket([a, b, c]);
    expect(packet.bodies).toHaveLength(2);
    expect(packet.comparisons.find(item => packet.sources[item.source]!.artifactId === b.id)?.csv).toEqual({recordsAfterFirst: {shared: 1, removed: 2, added: 1}});
    expect(packet.sources.find(item => item.artifactId === a.id)!.body).toBe(packet.sources.find(item => item.artifactId === c.id)!.body);
  });
  test('keeps malformed data as an explicit gap and rejects altered source or forged statistics', () => {
    const malformed = buildEvidencePacket([artifact('a,b\n1,"unclosed')]);
    expect(malformed.bodies[0]!.view).toMatchObject({format: 'unparsed-csv'});
    const source = artifact('a,b\n1,2\n'), packet = packetArtifact([source]);
    expect(() => verifyEvidencePacket([source, packet])).not.toThrow();
    const changed = JSON.parse(packet.content); changed.bodies[0].view.recordsAfterFirst = 999;
    packet.content = JSON.stringify(changed); packet.sha256 = sha(packet.content);
    expect(() => verifyEvidencePacket([source, packet])).toThrow('参照');
    source.content += 'tamper';
    expect(() => buildEvidencePacket([source])).toThrow('ハッシュ');
  });
  test('does not turn an uncaptured header value into a literal string', () => {
    const source = artifact('a,b\n1,2\n');
    const value = JSON.parse(source.content); value.response.headers['x-example'] = null;
    source.content = serializedEvidence(value); source.sha256 = sha(source.content);
    expect(buildEvidencePacket([source]).responseHeaders.find(item => item.name === 'x-example')?.examples).toEqual([null]);
  });
  test('retains a captured request body and declares any bounded preview', () => {
    const source = artifact('a,b\n1,2\n');
    const value = JSON.parse(source.content); value.request.method = 'POST'; value.request.body = 'x'.repeat(2100);
    source.content = serializedEvidence(value); source.sha256 = sha(source.content);
    expect(buildEvidencePacket([source]).sources[0]!.requestBody).toMatchObject({characters: 2100, truncated: true});
  });
  test('reads only the requested exact range and rejects broken UTF-8 or excessive ranges', () => {
    const source = artifact('列,値\nあ,1\n');
    const start = Buffer.byteLength('列,値\n');
    expect(readEvidenceRange(source, start, start + Buffer.byteLength('あ,1\n')).excerpt).toBe('あ,1\n');
    expect(() => readEvidenceRange(source, start + 1, start + 3)).toThrow();
    expect(readEvidenceRange(artifact('\ufeffa,b\n1,2\n'), 0, 7).excerpt).toBe('\ufeffa,b\n');
    expect(() => readEvidenceRange(artifact('x'.repeat(9000)), 0, 9000)).toThrow('8KB');
  });
  test('analysis persists a verifiable packet, keeps raw evidence and validates both kinds of citations', async () => {
    const directory = mkdtempSync(join(tmpdir(), 'atlas-packet-')); const store = openStore(directory);
    try {
      const benchmark = store.createCase({name: 'fixture', targetUrl: 'https://example.com/', scope: 'public', criteria: ['rows'], dataPolicy: 'public-only'});
      const attempt = importObservations(store, {caseId: benchmark.id, observations: [observation('a,b\n1,2\n3,4\n')]});
      const original = attempt.artifacts[0]!;
      const app = createApp(store);
      const part = await app.request(`/api/benchmark/attempts/${attempt.id}/artifacts/${original.id}/body?start=4&end=8`);
      expect(part.status).toBe(200); expect((await part.json()).excerpt).toBe('1,2\n');
      expect((await app.request(`/api/benchmark/attempts/${attempt.id}/artifacts/${randomUUID()}/body?start=4&end=8`)).status).toBe(404);
      const result = await analyzeAttempt(store, attempt.id, async (_benchmark, input) => {
        const packet = input.artifacts.find(item => item.kind === 'evidence_packet')!;
        return {threadId: null, report: {title: 'fixture', summary: 'mechanical view', operations: [{name: 'fixture', method: 'GET', path: '/data', inputs: '', response: '2 records after first', authentication: 'unknown', errors: '', constraints: '', provenance: 'http-observed', unknowns: [], evidence: [{artifactId: original.id, quote: 'https://example.com/data'}, {artifactId: packet.id, quote: '"recordsAfterFirst":2'}]}], assessments: [{criterionIndex: 0, status: 'partial', explanation: 'observed', evidence: [{artifactId: packet.id, quote: '"recordsAfterFirst":2'}]}], unknowns: []}};
      });
      expect(result.status).toBe('ready');
      expect(result.artifacts.find(item => item.id === original.id)?.content).toBe(original.content);
      expect(snapshot(benchmark, result).manifest).toHaveLength(4);
    } finally {store.close(); rmSync(directory, {recursive: true, force: true});}
  });
});

// Test-facing structural shape, without coupling assertions to field meanings.
function csvSummary() {
  return {recordsAfterFirst: 0, columns: [] as {finiteNumberInterpretation: unknown}[], firstRecord: {record: 0, byteStart: 0, byteEnd: 0, cells: [] as string[], quote: ''}, examples: [] as {record: number; byteStart: number; byteEnd: number; cells: string[]; quote: string}[]};
}
