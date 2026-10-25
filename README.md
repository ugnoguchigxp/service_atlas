# Service Atlas

外部から観測したHTTP通信を根拠として、API仕様書案と未確認事項を整理するローカルワークスペース。

## 起動と検証

```sh
bun install
bun run browser:install
bun run dev
bun run verify
```

開発画面は `http://127.0.0.1:4317/`。`bun run build` 後は `bun start` でも起動できる。

React / Tailwind CSS / Design System / OpenUI、Hono、SQLite / Drizzle、Zod、Codex SDKを使用する。仕様案生成にはCodex側の利用設定が必要。収集用のオンラインサービスへの接続はない。収集にはローカルのPlaywright/Chromiumを使用する。

## 探索とLLMの呼び出し

1. 「探索計画を作成」で入口ページを機械的に観測し、Codex SDKを1回呼んで具体的な操作計画を保存する。
2. 保存した計画を確認し、「この計画で収集」でPlaywrightがまとめて実行する。この間のLLM呼び出しは0回。同じ計画は再利用できる。
3. 「一括精査・仕様書作成」で収集結果をCodex SDKへ1回渡し、既存の根拠検証と出力へ進む。

各段階は明示的な操作。自動の再計画・モデル再試行は行わない。失敗したSDK呼び出し試行も `llm_invocation` に残し、返却された入出力・キャッシュトークンとthread IDを `llm_result` に保存する。使用量が返らなかった場合はnullであり、0トークンと解釈しない。既存の過去試行にはこの記録がない。

CLI: `plan <caseId>`、`collect <計画を含むattemptId>`、`analyze <収集attemptId>`。`plan-import <plan.json>` は `{ "caseId": "UUID", "plan": ... }` を受け取り、手動計画ならLLM不要。

計画は最大20操作（navigate / click / fill / GET・HEAD request）。収集は90秒、ブラウザと直接取得を合わせ最大100通信。観測の追加待機は操作ごと0〜2000ms。対象と同じoriginのGET/HEADに限定し、ブラウザのリダイレクトは転送せず未取得として記録する。直接取得は転送前の3xx応答を保存する。Service Worker・WebSocketは対象外。外部CDN等の遮断による欠落は計画用の入口観測と収集の不足に記録する。

ページ操作に伴うdocument/xhr/fetchのうち計画で選んだ種類を捕捉し、直接requestはPlaywrightのAPIRequestContextを使う。本文の取得失敗、未完了、UTF-8外、保存上限256KB超過は完全な証拠にせず不足として残す。観測時間の終了は網羅性の保証ではない。計画作成用のページ本文や計画自体は、最終仕様の根拠入力から除外する。

## 観測の取り込み

対象と評価項目を画面で登録し、対象と同じoriginのHTTP観測JSONを取り込む。1件または配列を指定できる。ファイルは250KB以下。観測には以下を含める。

```json
{
  "request": {"method": "GET", "url": "https://example.com/items"},
  "response": {"status": 200, "headers": {"content-type": "application/json"}, "body": "[]"},
  "captureState": "complete",
  "observedAt": "2026-10-25T00:00:00Z",
  "durationMs": 120
}
```

CLIは `bun run cli help`。CLIのimportは `{ "caseId": "登録したUUID", "observations": [...] }` を受け取る。公開データのみを対象とする。観測元・完全性は登録者の申告であり、取り込み機能は通信を独立検証しない。

## 保存と仕様書

`data/atlas.sqlite` と `data/artifacts/` に証拠・仕様の改訂を保存する。`ATLAS_DATA_DIR` で変更できる。資格情報は保存前に除去し、証拠のハッシュと引用を検証する。HTTP実観測・派生資料・推測を分ける。意味の正しさと網羅性は未レビューとして明示する。

Codex SDKには保存した証拠と固定した評価項目を渡す。正解用の公開仕様は別領域に置く。Weathernewsで取得した18件の直接HTTP観測と生成済み仕様書は保持している。詳細は [実測結果](docs/weathernews-benchmark-results-2026-10-25.md) を参照。

旧ベースの帰属表示は `licenses/`、過去の計画と評価は `docs/archive/` に保存している。Playwrightの操作計画とLLM利用記録は既存の証拠ストアに保存する。


## LLMへ渡す証拠の削減

仕様生成は保存済みHTTP原本から作った `evidence_packet` だけを入力にする。CSV全文は渡さず、全レコードの機械走査による列構成候補・件数・分布・代表例と、要求の違い・本文一致・レコードの追加/欠落を渡す。同一本文は共有する。先頭レコードをヘッダー候補として分離し、業務上の型や値の意味は確定しない。例と値一覧は上限付きで、省略の存在を明示する。

原本は変更せず、IDとSHA-256、代表レコード番号・UTF-8 byte範囲・完全一致引用で追跡する。仕様案は原本と派生集計を区別して引用し、保存時にパケットを原本から再計算して検証する。原本の一部分だけ必要なら `/api/benchmark/attempts/<attemptId>/artifacts/<artifactId>/body?start=<byte>&end=<byte>` で8KB以内を取得できる。追加参照はLLMの自動起動を伴わない。

同じWeathernewsの16応答・同じモデル/推論設定で、生成入力は57,727→23,345トークン（59.6%減）。再計画・再取得は行っていない。詳細は実測結果と `data/live-weathernews-compact/` を参照。
