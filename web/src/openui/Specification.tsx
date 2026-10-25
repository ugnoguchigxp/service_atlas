import { createContext, useContext, Component, type ReactNode } from 'react';
import { z } from 'zod';
import { createLibrary, defineComponent, createParser, Renderer } from './sdk';
import { Badge } from '@atlas/design-system';
import type { AttemptDetail } from '../../../packages/atlas/src/contracts';

const Snapshot = createContext<AttemptDetail | null>(null);
const viewProps = z.strictObject({source: z.string().uuid()});
function SpecificationView({source}: z.infer<typeof viewProps>) {
  const attempt = useContext(Snapshot);
  if (attempt?.id !== source || !attempt.report) return <p role="alert">参照できる仕様案がありません。</p>;
  const report = attempt.report;
  return <article className="specification">
    <div className="flex flex-wrap items-center gap-2"><Badge variant="warning">未レビュー</Badge><span className="muted">改訂 {attempt.reportRevision} · Codex SDK</span></div>
    <h2>{report.title}</h2><p>{report.summary}</p>
    {report.operations.length === 0 && <p className="notice">API操作を裏付ける資料が不足しています。</p>}
    {report.operations.map((operation, index) => <section key={index} className="operation">
      <div className="flex flex-wrap items-center justify-between gap-2"><h3>{operation.name}</h3><Badge variant="outline">{operation.provenance === 'derived' ? '派生資料' : operation.provenance === 'hypothesis' ? '仮説' : 'HTTP観測'}</Badge></div>
      <code className="endpoint">{operation.method} {operation.path}</code>
      <dl>{([['入力', operation.inputs], ['応答', operation.response], ['認証', operation.authentication], ['エラー', operation.errors], ['制約', operation.constraints]] as const).map(([label, value]) => <div key={label}><dt>{label}</dt><dd>{value}</dd></div>)}</dl>
      {operation.evidence.map((ref, i) => <details key={i}><summary>根拠 {ref.artifactId.slice(0, 8)}</summary><blockquote>{ref.quote}</blockquote></details>)}
      {operation.unknowns.map((unknown, i) => <p key={i} className="muted">未確認 · {unknown}</p>)}
    </section>)}
    <h3>追加で確認すること</h3><ul>{report.unknowns.map((unknown, i) => <li key={i}>{unknown}</li>)}</ul>
  </article>;
}
const library = createLibrary({id: 'atlas-specification-v1', components: [defineComponent({
  name: 'ApiSpecification', description: '保存済みの根拠付きAPI仕様案を表示する', props: z.strictObject({request: viewProps}),
  component: ({props}) => <SpecificationView {...viewProps.parse(props.request)}/>,
})]});
class Boundary extends Component<{children: ReactNode}, {failed: boolean}> {
  state = {failed: false};
  static getDerivedStateFromError() {return {failed: true};}
  render() {return this.state.failed ? <p role="alert">仕様案を表示できません。JSON出力から内容を確認できます。</p> : this.props.children;}
}
export function compileSpecification(source: string) {
  const lang = `root = ApiSpecification(${JSON.stringify(viewProps.parse({source}))})`;
  const parsed = createParser(library.toJSONSchema()).parse(lang);
  if (!parsed.root || parsed.meta.errors.length || parsed.meta.unresolved.length || parsed.meta.incomplete) throw new Error('表示定義を確認してください');
  return {lang, parsed};
}
export default function Specification({attempt}: {attempt: AttemptDetail}) {
  const {lang} = compileSpecification(attempt.id);
  return <Snapshot.Provider value={attempt}><Boundary key={`${attempt.id}:${attempt.reportRevision}`}><Renderer response={lang} library={library} isStreaming={false} publishObservability={false}/></Boundary></Snapshot.Provider>;
}
