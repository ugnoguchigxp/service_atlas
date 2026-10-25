import type { Attempt, AttemptDetail, BenchmarkCase } from '../../packages/atlas/src/contracts';
export type Overview = { cases: BenchmarkCase[]; attempts: Attempt[] };
export async function request<T>(path: string, body?: unknown): Promise<T> {
  const response = await fetch(`/api/benchmark${path}`, body === undefined ? undefined : {
    method: 'POST', headers: {'content-type': 'application/json'}, body: JSON.stringify(body),
  });
  const result = await response.json();
  if (!response.ok) throw new Error(typeof result.error === 'string' ? result.error : '処理が完了していません。試行の詳細を確認してください。');
  return result as T;
}
export const loadDetail = (id: string) => request<AttemptDetail>(`/attempts/${encodeURIComponent(id)}`);
