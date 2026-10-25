import { createHash } from 'node:crypto';
import { parse } from 'csv-parse/sync';
import { z } from 'zod';
import { observationSchema, type Artifact } from './contracts.ts';

const digest = (value: string) => createHash('sha256').update(value).digest('hex');
const limit = (value: string, size = 120) => value.length <= size ? value : {prefix: value.slice(0, size), characters: value.length, sha256: digest(value), truncated: true};
type CsvRecord = {cells: string[]; record: number; byteStart: number; byteEnd: number; quote: string};

/** RFC-style CSV parsing only. No column names, business types or sentinel meanings. */
function csvRecords(body: string): CsvRecord[] {
  const entries = z.array(z.object({record: z.array(z.string()), raw: z.string(), info: z.object({records: z.number().int().positive()})}))
    .parse(parse(body, {bom: true, raw: true, info: true, relax_column_count: true, max_record_size: 256_000}));
  let cursor = 0, bytes = 0;
  return entries.map(entry => {
    const start = body.indexOf(entry.raw, cursor);
    if (start < 0) throw new Error('CSV原文の位置を検証できません');
    const byteStart = bytes + Buffer.byteLength(body.slice(cursor, start));
    const byteEnd = byteStart + Buffer.byteLength(entry.raw);
    cursor = start + entry.raw.length; bytes = byteEnd;
    return {cells: entry.record, record: entry.info.records, byteStart, byteEnd, quote: JSON.stringify(entry.raw).slice(1, -1)};
  });
}

function csvView(rows: CsvRecord[]) {
  const data = rows.slice(1);
  const width = rows.reduce((maximum, row) => Math.max(maximum, row.cells.length), 0);
  const widths: Record<string, number> = {};
  for (const row of data) widths[row.cells.length] = (widths[row.cells.length] ?? 0) + 1;
  const selected = new Set<number>();
  if (data.length) {selected.add(0); selected.add(data.length - 1);}
  const columns = Array.from({length: Math.min(width, 64)}, (_, index) => {
    const values = new Map<string, {count: number; row: number}>();
    let absent = 0, numericCount = 0, minimum = Infinity, maximum = -Infinity;
    let minRow = 0, maxRow = 0;
    data.forEach((row, rowIndex) => {
      const value = row.cells[index];
      if (value === undefined) {absent++; return;}
      const previous = values.get(value); values.set(value, {count: (previous?.count ?? 0) + 1, row: previous?.row ?? rowIndex});
      const numeric = value.trim() ? Number(value) : NaN;
      if (Number.isFinite(numeric)) {
        numericCount++;
        if (numeric < minimum) {minimum = numeric; minRow = rowIndex;}
        if (numeric > maximum) {maximum = numeric; maxRow = rowIndex;}
      }
    });
    const ordered = [...values].sort(([a], [b]) => a < b ? -1 : a > b ? 1 : 0);
    const byFrequency = [...ordered].sort((a, b) => b[1].count - a[1].count);
    const rare = [...ordered].sort((a, b) => a[1].count - b[1].count).slice(0, 2);
    for (const entry of [ordered[0], ordered.at(-1), ...rare]) if (entry) selected.add(entry[1].row);
    if (numericCount) {selected.add(minRow); selected.add(maxRow);}
    return {index, firstRecordValue: limit(rows[0]?.cells[index] ?? ''), absent, empty: values.get('')?.count ?? 0, distinct: values.size,
      lexicalMin: ordered[0] ? limit(ordered[0][0]) : null, lexicalMax: ordered.at(-1) ? limit(ordered.at(-1)![0]) : null,
      finiteNumberInterpretation: numericCount ? {count: numericCount, min: minimum, max: maximum, minRecord: data[minRow]?.record, maxRecord: data[maxRow]?.record} : null,
      frequent: byFrequency.slice(0, 2).map(([value, item]) => [limit(value), item.count]), rare: rare.map(([value, item]) => [limit(value), item.count])};
  });
  const sample = (row: CsvRecord) => ({record: row.record, byteStart: row.byteStart, byteEnd: row.byteEnd, cells: row.cells.slice(0, 64).map(value => limit(value)), cellsOmitted: Math.max(0, row.cells.length - 64), quote: limit(row.quote, 800)});
  const selectedRows = [...selected];
  return {format: 'csv', allRecords: rows.length, firstRecord: rows[0] ? sample(rows[0]) : null, recordsAfterFirst: data.length,
    firstRecordRole: 'header candidate only; header presence and business types are not decided by code',
    widthCountsAfterFirst: widths, columns, columnsOmitted: Math.max(0, width - columns.length),
    examples: selectedRows.slice(0, 8).map(index => sample(data[index]!)), candidateExamplesOmitted: Math.max(0, selectedRows.length - 8)};
}

function difference(left: CsvRecord[], right: CsvRecord[]) {
  const counts = (rows: CsvRecord[]) => {
    const map = new Map<string, number>();
    for (const row of rows.slice(1)) {const key = JSON.stringify(row.cells); map.set(key, (map.get(key) ?? 0) + 1);}
    return map;
  };
  const a = counts(left), b = counts(right);
  let shared = 0;
  for (const [key, count] of a) shared += Math.min(count, b.get(key) ?? 0);
  return {recordsAfterFirst: {shared, removed: Math.max(0, left.length - 1) - shared, added: Math.max(0, right.length - 1) - shared}};
}

export function buildEvidencePacket(artifacts: Artifact[]) {
  const originals = artifacts.filter(item => item.kind === 'http_request_response').sort((a, b) => a.createdAt.localeCompare(b.createdAt));
  const bodies: {sha256: string; bytes: number; source: number; view: unknown}[] = [];
  const bodyIds = new Map<string, number>(); const csv = new Map<number, CsvRecord[]>();
  const headers = new Map<string, {sources: number[]; values: Set<string | null>}>();
  const sources = originals.map((artifact, index) => {
    if (digest(artifact.content) !== artifact.sha256) throw new Error('原本のハッシュが一致しません');
    const observation = observationSchema.parse(JSON.parse(artifact.content));
    if (artifact.provenance !== 'http-observed') throw new Error('HTTP原本の由来が不正です');
    for (const [key, value] of Object.entries(observation.response.headers)) {
      const item = headers.get(key) ?? {sources: [], values: new Set<string | null>()};
      item.sources.push(index); item.values.add(value); headers.set(key, item);
    }
    const body = observation.response.body, bodyHash = digest(body);
    const responseContentType = Object.entries(observation.response.headers).find(([key]) => key.toLowerCase() === 'content-type')?.[1] ?? null;
    const contentType = responseContentType?.split(';')[0].trim().toLowerCase();
    const bodyKey = `${contentType}:${bodyHash}`;
    let bodyId = bodyIds.get(bodyKey);
    if (bodyId === undefined) {
      bodyId = bodies.length; bodyIds.set(bodyKey, bodyId);
      let view: unknown;
      if (contentType === 'text/csv' || contentType === 'application/csv') {
        try {
          const records = csvRecords(body); csv.set(bodyId, records);
          const summary = csvView(records); view = summary;
          for (const row of [summary.firstRecord, ...summary.examples]) if (row && typeof row.quote === 'string' && !artifact.content.includes(row.quote)) throw new Error('CSV引用が原本に一致しません');
        } catch {
          csv.delete(bodyId); view = {format: 'unparsed-csv', reason: 'CSV解析・原本アンカー検証に失敗', preview: limit(body, 200)};
        }
      } else {
        try {view = body.length <= 2000 ? {format: 'json', value: JSON.parse(body)} : {format: 'unexpanded', preview: limit(body, 200)};}
        catch {view = {format: 'unexpanded', preview: limit(body, 200)};}
      }
      bodies.push({sha256: bodyHash, bytes: Buffer.byteLength(body), source: index, view});
    }
    const urlQuote = JSON.stringify(observation.request.url).slice(1, -1);
    const statusQuote = `"status": ${observation.response.status}`;
    const rawQuotes = [urlQuote, statusQuote].filter(quote => artifact.content.includes(quote));
    return {artifactId: artifact.id, sha256: artifact.sha256, provenance: artifact.provenance, method: observation.request.method, url: observation.request.url,
      requestHeaders: observation.request.headers ?? null, status: observation.response.status, contentType: responseContentType,
      ...(observation.request.body !== undefined ? {requestBody: observation.request.body === null ? null : limit(observation.request.body, 2000)} : {}),
      body: bodyId, rawQuotes};
  });
  const baseline = new Map<string, number>();
  const comparisons = sources.flatMap((source, index) => {
    const url = new URL(source.url), key = `${source.method} ${url.origin}${url.pathname}`;
    const previous = baseline.get(key);
    if (previous === undefined) {baseline.set(key, index); return [];}
    const before = sources[previous]!, previousUrl = new URL(before.url);
    const keys = new Set([...previousUrl.searchParams.keys(), ...url.searchParams.keys()]);
    const queryChanges = [...keys].filter(name => JSON.stringify(previousUrl.searchParams.getAll(name)) !== JSON.stringify(url.searchParams.getAll(name)))
      .map(name => ({name, before: previousUrl.searchParams.getAll(name), after: url.searchParams.getAll(name)}));
    const a = csv.get(before.body), b = csv.get(source.body);
    return [{baseline: previous, source: index, queryChanges, statusBefore: before.status, statusAfter: source.status, sameBody: bodies[before.body]!.sha256 === bodies[source.body]!.sha256,
      ...(a && b ? {csv: difference(a, b)} : {})}];
  });
  return {version: 1, scope: 'Mechanical observations only. All CSV records parsed; bounded value/examples are not exhaustive enums or business types. Body offsets are UTF-8 bytes; record numbers include the first record.',
    sources, bodies, responseHeaders: [...headers].map(([name, item]) => ({name, sources: item.sources, uniqueValues: item.values.size, examples: [...item.values].slice(0, 2).map(value => value === null ? null : limit(value)), examplesOmitted: Math.max(0, item.values.size - 2)})),
    comparisons, rawAccess: 'Original HTTP artifacts are retained in the same attempt and snapshot; use artifactId + sha256 and CSV record/byte range for exact retrieval. Unexpanded content must not be assumed.'};
}

export function verifyEvidencePacket(artifacts: Artifact[], packet?: Artifact) {
  const candidates = packet ? [packet] : artifacts.filter(item => item.kind === 'evidence_packet');
  if (!candidates.length) return;
  const expected = JSON.stringify(buildEvidencePacket(artifacts));
  for (const item of candidates) {
    if (digest(item.content) !== item.sha256 || JSON.stringify(JSON.parse(item.content)) !== expected)
      throw new Error('解析パケットまたは原本との参照が一致しません');
  }
}

/** Bounded, read-only access to retained bodies; no model invocation or new request. */
export function readEvidenceRange(artifact: Artifact, start: number, end: number) {
  if (artifact.kind !== 'http_request_response' || digest(artifact.content) !== artifact.sha256) throw new Error('原本がないかハッシュが一致しません');
  const body = Buffer.from(observationSchema.parse(JSON.parse(artifact.content)).response.body);
  if (!Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end <= start || end > body.length || end - start > 8192)
    throw new Error('原本の範囲は有効なUTF-8境界かつ8KB以内で指定してください');
  const excerpt = new TextDecoder('utf-8', {fatal: true, ignoreBOM: true}).decode(body.subarray(start, end));
  return {artifactId: artifact.id, sha256: artifact.sha256, bodySha256: digest(body.toString('utf8')), byteStart: start, byteEnd: end, bodyBytes: body.length, excerpt};
}
