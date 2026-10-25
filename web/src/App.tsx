import { useEffect, useState, lazy, Suspense, type FormEvent, useCallback } from 'react';
import { ArrowDownToLine, ArrowRight, Braces, Check, Circle, Database, FileSearch, FlaskConical, Globe2, Layers3, Loader2, Plus } from 'lucide-react';
import { Badge, Button, Card, Input, Textarea, Tabs, TabsList, TabsTrigger, TabsContent } from '@atlas/design-system';
import { request, loadDetail, type Overview } from './api';
import type { AttemptDetail, BenchmarkCase } from '../../packages/atlas/src/contracts';
const Specification = lazy(() => import('./openui/Specification'));
const statusLabels: Record<string, string> = {planning: '計画作成中', planned: '計画あり', collecting: '収集中', collected: '資料取得済み', analyzing: '仕様案を作成中', ready: '仕様案あり', blocked: '接続待ち', failed: '要確認', interrupted: '中断'};
const defaultCriteria = ['APIのHTTPメソッドとパスを記述できる', '入力項目と確認できた型・条件を記述できる', '応答の構造と具体例を示せる', '認証条件を根拠付きで説明できる', 'エラー条件と未確認事項を区別できる'];

export default function App() {
  const [overview, setOverview] = useState<Overview>({cases: [], attempts: []});
  const [loaded, setLoaded] = useState(false);
  const [caseId, setCaseId] = useState('');
  const [attemptId, setAttemptId] = useState('');
  const [detail, setDetail] = useState<AttemptDetail | null>(null);
  const [creating, setCreating] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [importText, setImportText] = useState('');
  const selected = overview.cases.find(item => item.id === caseId);
  const attempts = overview.attempts.filter(item => item.caseId === caseId);
  const refresh = useCallback(async () => {
    const result = await request<Overview>(''); setOverview(result); setLoaded(true);
  }, []);
  useEffect(() => {refresh().catch(() => setError('保存済みの結果を読み込めませんでした。'));}, [refresh]);
  useEffect(() => {
    if (!caseId && overview.cases[0]) setCaseId(overview.cases[0].id);
  }, [caseId, overview.cases]);
  useEffect(() => {
    let active = true;
    if (!attemptId) {setDetail(null); return;}
    setDetail(null);
    const update = async () => {const value = await loadDetail(attemptId); if (active) setDetail(value);};
    update().catch(() => setError('試行の詳細を読み込めませんでした。'));
    const timer = setInterval(() => {update().catch(() => {}); refresh().catch(() => {});}, 2000);
    return () => {active = false; clearInterval(timer);};
  }, [attemptId, refresh]);
  async function execute(action: () => Promise<void>) {
    setBusy(true); setError('');
    try {await action();} catch (problem) {setError(problem instanceof Error ? problem.message : '処理に失敗しました。');}
    finally {setBusy(false); await refresh().catch(() => {});}
  }
  async function importEvidence(event: FormEvent) {
    event.preventDefault();
    await execute(async () => {
      const observations = JSON.parse(importText);
      const value = await request<AttemptDetail>('/import', {caseId, observations: Array.isArray(observations) ? observations : [observations]});
      setAttemptId(value.id); setDetail(value);
    });
  }
  const reportCount = overview.attempts.filter(attempt => attempt.status === 'ready').length;
  const modelCalls = detail?.artifacts.filter(item => item.kind === 'llm_invocation').length ?? 0;
  const hasPlan = detail?.artifacts.some(item => item.kind === 'exploration_plan');
  const documented = detail?.report?.assessments.filter(item => item.status === 'documented').length;
  return <div className="app-shell">
    <aside className="sidebar">
      <a href="/" className="brand"><span className="brand-mark"><Layers3 size={20}/></span><span>Service Atlas<small>OBSERVATION WORKSPACE</small></span></a>
      <div className="sidebar-section">WORKSPACE</div>
      <div className="nav-item active"><FlaskConical size={17}/>収集ベンチマーク<span className="nav-count">{overview.cases.length}</span></div>
      <div className="sidebar-section mt-9">調査対象</div>
      <div className="case-list">{overview.cases.map(item => <button key={item.id} className={`case-link ${item.id === caseId ? 'selected' : ''}`} onClick={() => {setCaseId(item.id); setAttemptId(''); setCreating(false);}}><Globe2 size={15}/><span>{item.name}</span></button>)}</div>
      <Button variant="ghost" className="justify-start" onClick={() => setCreating(true)}><Plus size={16} className="mr-2"/>対象を追加</Button>
      <div className="sidebar-footer"><Database size={15}/><span>ローカル保存<small>SQLite · 証拠と改訂を保持</small></span></div>
    </aside>
    <main>
      <header className="topbar"><span>Workspace <span className="mx-2 muted">/</span> 収集ベンチマーク</span><span className="muted">ローカルワークスペース</span></header>
      <div className="page">
        <div className="page-heading"><div><div className="eyebrow">COLLECTION BENCHMARK · PHASE 0</div><h1>観測から、API仕様へ。</h1><p className="muted">取得できた根拠と不足を並べて、仕様書に使えるかを確かめます。</p></div><Button onClick={() => setCreating(true)}><Plus size={16} className="mr-2"/>ベンチマークを作成</Button></div>
        {error && <div role="alert" className="error-box">{error}</div>}
        <div className="metric-grid">
          <Metric label="調査対象" value={String(overview.cases.length)} detail="範囲と評価項目を事前に固定" icon={<Globe2 size={18}/>}/>
          <Metric label="収集の試行" value={String(overview.attempts.length)} detail="失敗・中断も記録" icon={<Database size={18}/>}/>
          <Metric label="仕様書案" value={String(reportCount)} detail="根拠を検査済み · 内容は未レビュー" icon={<FileSearch size={18}/>}/>
        </div>
        {(creating || (loaded && !overview.cases.length)) && <CaseForm onCancel={() => setCreating(false)} onCreate={async input => {
          await execute(async () => {const value = await request<BenchmarkCase>('/cases', input); setCaseId(value.id); setAttemptId(''); setCreating(false);});
        }} busy={busy}/>}
        {selected && !creating && <>
          <section className="study-header"><div><div className="eyebrow">CURRENT STUDY</div><h2>{selected.name}</h2><p className="muted break-all">{selected.targetUrl}</p></div><Badge variant="outline">公開データ限定</Badge></section>
          <div className="workbench">
            <Card className="study-panel"><div className="panel-label"><span>01</span>調査条件</div><p>{selected.scope}</p><h3>事前に決めた評価項目</h3><ol className="criteria">{selected.criteria.map((criterion, index) => <li key={index}><span>{String(index + 1).padStart(2, '0')}</span>{criterion}</li>)}</ol><div className="notice">実際の観測、派生資料、推測を区別して評価します。</div></Card>
            <Card className="study-panel"><div className="panel-label"><span>02</span>計画して、まとめて収集</div><p className="muted">入口ページを確認し、LLMで探索計画を1回作成します。保存した計画の実行中はLLMを呼び出しません。</p><Button maxLabelLength={40} className="mb-5" loading={busy} onClick={() => execute(async () => {const value = await request<AttemptDetail>(`/cases/${caseId}/plan`, {}); setAttemptId(value.id); setDetail(value);})}>探索計画を作成（LLM 1回）</Button><h3>既存のHTTP観測を取り込む</h3><p className="muted">対象サービスのリクエストと応答を、ローカルJSONから取り込みます。</p><form onSubmit={importEvidence} className="form-stack"><label>観測ファイル<Input type="file" accept="application/json,.json" onChange={event => {const file = event.target.files?.[0]; if (!file) return; if (file.size > 250_000) {setError('250KB以下のファイルを選んでください。'); return;} file.text().then(setImportText).catch(() => setError('ファイルを読み込めませんでした。'));}}/></label><label>観測JSON<Textarea rows={5} value={importText} onChange={event => setImportText(event.target.value)} placeholder="観測1件、または観測の配列"/></label><Button loading={busy} disabled={!importText.trim()} type="submit"><ArrowDownToLine size={15} className="mr-2"/>観測を取り込む</Button></form><p className="footnote">必須項目: request / response / captureState / observedAt / durationMs。</p></Card>
          </div>
          <section className="results-section"><div className="flex items-center justify-between"><div><div className="eyebrow">RESULTS & EVIDENCE</div><h2>試行と根拠</h2></div><span className="muted">{attempts.length} trials</span></div>
            {attempts.length === 0 ? <Card className="empty-state"><FileSearch size={28}/><h3>まだ実測結果はありません</h3><p>資料を取得すると、取得できた内容と不足をここで比較できます。</p></Card> : <div className="trial-list">{attempts.map((attempt, index) => <button key={attempt.id} className={`trial ${attempt.id === attemptId ? 'selected' : ''}`} onClick={() => setAttemptId(attempt.id)}><span className="trial-index">{String(attempts.length - index).padStart(2, '0')}</span><div><strong>{statusLabels[attempt.status] ?? attempt.status}</strong><small>{new Date(attempt.createdAt).toLocaleString('ja-JP')} · {attempt.id.slice(0, 8)}</small></div><Badge variant="outline">{attempt.metrics.filter(metric => metric.status === 'ok').length} 資料</Badge><ArrowRight size={16}/></button>)}</div>}
          </section>
          {detail && detail.caseId === caseId && <Card className="detail-panel"><div className="detail-heading"><div><h2>試行 {detail.id.slice(0, 8)}</h2><p className="muted">最終記録: {statusLabels[detail.status]} · {detail.accountAlias}</p></div><div className="flex flex-wrap gap-2"><a className="download-link" href={`/api/benchmark/attempts/${detail.id}/export`}>Snapshot <ArrowDownToLine size={14}/></a>{detail.report && <a className="download-link" href={`/api/benchmark/attempts/${detail.id}/export?format=markdown`}>仕様書.md <ArrowDownToLine size={14}/></a>}{hasPlan && <Button maxLabelLength={40} variant="outline" disabled={busy} onClick={() => execute(async () => {const value = await request<AttemptDetail>(`/attempts/${detail.id}/collect`, {}); setAttemptId(value.id); setDetail(value);})}>この計画で収集（LLMなし）</Button>}<Button maxLabelLength={40} loading={busy} disabled={!detail.artifacts.some(item => item.kind === 'http_request_response') || ['planning', 'collecting', 'analyzing'].includes(detail.status)} onClick={() => execute(async () => {setDetail(await request<AttemptDetail>(`/attempts/${detail.id}/analyze`, {}));})}>一括精査・仕様書作成（LLM 1回）</Button></div></div>
            {detail.error && <p role="alert" className="error-box">{detail.error}</p>}
            <p className="footnote">取得経路: {detail.sourceKind === 'direct-http' ? '直接HTTPの実観測' : detail.sourceKind === 'playwright-batch' ? 'Playwrightによる計画・一括収集' : 'ローカルJSONの取り込み'} · 観測元は登録者の申告です。</p>
            {detail.sourceKind === 'playwright-batch' && <p className="notice">この試行のLLM呼び出し記録: {modelCalls}回（失敗を含む）。保存済み計画の再実行は0回。追加の再計画・精査は操作したときだけ実行します。</p>}
            <Tabs defaultValue="evidence"><TabsList><TabsTrigger value="evidence">収集した証拠</TabsTrigger><TabsTrigger value="spec">API仕様書案</TabsTrigger><TabsTrigger value="assessment">評価と不足</TabsTrigger></TabsList>
              <TabsContent value="evidence"><p className="footnote">所要時間は取得処理の時間、bytesは取得値のJSONサイズです。実通信量ではありません。</p><div className="evidence-grid">{detail.metrics.map((metric, index) => <div key={index} className="evidence-metric"><span>{metric.kind}</span><Badge variant={metric.status === 'ok' ? 'success' : 'warning'}>{metric.status === 'ok' ? '取得済み' : '未取得'}</Badge><small>{metric.durationMs} ms · {metric.bytes.toLocaleString()} bytes</small>{metric.reason && <p>{metric.reason}</p>}</div>)}</div>{detail.artifacts.map(artifact => <details className="artifact" key={artifact.id}><summary><Braces size={15}/><strong>{artifact.kind}</strong><span className="muted">{artifact.provenance === 'derived' ? '派生資料' : artifact.provenance === 'http-observed' ? 'HTTP実観測' : 'Run記録'}</span><span className="artifact-hash">{artifact.sha256.slice(0, 10)}</span></summary><p className="muted">証拠ID: {artifact.id}</p><pre>{artifact.content}</pre></details>)}</TabsContent>
              <TabsContent value="spec">{detail.report ? <Suspense fallback={<p><Loader2 size={16}/>表示を読み込んでいます</p>}><Specification attempt={detail}/></Suspense> : <div className="empty-state"><FileSearch size={24}/><h3>収集資料から仕様書案を作成できます</h3><p>Codex SDKが根拠と未確認事項を整理します。</p></div>}</TabsContent>
              <TabsContent value="assessment">{detail.report ? <><div className="assessment-summary"><strong>{documented} / {selected.criteria.length}</strong><span>記述済みと評価された項目（LLM案・未レビュー）</span></div>{detail.report.assessments.map(item => <div className="assessment" key={item.criterionIndex}>{item.status === 'documented' ? <Check size={18}/> : <Circle size={18}/>}<div><strong>{selected.criteria[item.criterionIndex]}</strong><p>{item.explanation}</p></div><Badge variant={item.status === 'documented' ? 'success' : 'outline'}>{({documented: '記述済み', partial: '一部', missing: '未確認'})[item.status]}</Badge></div>)}<p className="footnote">引用の一致を機械検証しています。意味の正しさと仕様の網羅性は、人による確認が必要です。</p></> : <p className="notice">仕様書案の作成後に、事前の評価項目と照合します。</p>}</TabsContent>
            </Tabs>
          </Card>}
        </>}
        <footer className="page-footer"><span>Service Atlas / Research preview</span><span>観測したことだけを、根拠とともに。</span></footer>
      </div>
    </main>
  </div>;
}
function Metric({label, value, detail, icon}: {label: string; value: string; detail: string; icon: React.ReactNode}) {
  return <Card className="metric"><div className="flex justify-between"><span>{label}</span><span className="muted">{icon}</span></div><strong>{value}<small>件</small></strong><p>{detail}</p></Card>;
}
function CaseForm({onCreate, onCancel, busy}: {onCreate: (input: unknown) => Promise<void>; onCancel: () => void; busy: boolean}) {
  const [name, setName] = useState(''); const [url, setUrl] = useState(''); const [scope, setScope] = useState(''); const [criteria, setCriteria] = useState(defaultCriteria.join('\n'));
  return <Card className="case-form"><div className="panel-label"><Plus size={16}/>新しいベンチマーク</div><form onSubmit={event => {event.preventDefault(); void onCreate({name, targetUrl: url, scope, criteria: criteria.split('\n').map(value => value.trim()).filter(Boolean), dataPolicy: 'public-only'});}} className="form-stack"><div className="form-grid"><label>対象の名前<Input required value={name} onChange={event => setName(event.target.value)} placeholder="サービス名・対象機能"/></label><label>公開URL<Input required type="url" value={url} onChange={event => setUrl(event.target.value)} placeholder="https://…"/></label></div><label>調査範囲<Textarea required value={scope} onChange={event => setScope(event.target.value)} placeholder="調べる機能、入力条件、今回の範囲"/></label><label>評価項目 <span className="muted">1行に1項目</span><Textarea required rows={5} value={criteria} onChange={event => setCriteria(event.target.value)}/></label><p className="notice">初回は公開データを使います。資格情報や個人情報を入力しないでください。</p><div className="flex justify-end gap-2"><Button type="button" variant="ghost" onClick={onCancel}>閉じる</Button><Button type="submit" loading={busy}>対象と評価項目を固定</Button></div></form></Card>;
}
