# Unbrowse収集→外部API仕様書 ベンチマーク

2026-10-25。構想の正本は https://chatgpt.com/space/page_2b4d62992be8819188a20eb8d431352f 。

## 今回の目的と範囲

Unbrowseで外部から取得できる資料を使い、API操作、入力、応答、認証、エラー、制約を根拠付きで記述できるか測る。初期段階は公開データの小さな範囲と既存Run・学習成果の収集に限定する。対象・条件・期待項目を実行前に固定し、繰り返しは別の試行として保存する。

上流はe8f5f04b761a1ab64f7c1c93fea3552c0de5c813。公開クライアントのSDK・CLIと認証を再利用する。ブラウザ調査・index・runは上流の既存CLI/MCPで実行し、Atlasは外部IDからinspect/events/learned/harness/skillを再取得する。collectは対象SaaSの操作を開始・再送しない。UIに新しい操作DSLや調査エンジンは作らない。

## 評価

1. 部分: Zod契約、既知秘密値の除去、保存、改訂、根拠参照の整合性。
2. 結合: SDKの合成応答→保存→Codex相当の合成更新案→画面API→エクスポート。
3. 通し: 明示した対象で上流CLI/MCPによる調査→同じ外部IDのcollect→Codex SDKで仕様案→人による根拠確認。実認証・対象未指定では未実施とする。

計測: 取得経路、外部ID、取得日時、資料種別、呼び出し成否、所要時間、取得サイズ。上流申告のverifiedやcostは原形を保持し、Atlasの品質判定とは別扱い。SDK呼び出し件数を対象SaaSへのHTTP数として扱わない。

事前に登録した期待項目ごとにobserved/inferred/missingを記録する。observedには保存資料IDと一致する引用が必須。引用一致は意味の正しさの保証ではない。LLMの判定は未レビューの評価案。学習済みYAMLやskillは派生資料として扱い、HTTP本文を実観測した証拠とは区別する。推測だけのOpenAPIを確定仕様として出力しない。

API仕様案は各操作のmethod/path、入力・応答・エラー・認証・制約・未確認事項と出典を持つ。自由文の事実判断はCodex SDKに委ねる。Zodは形式、保存処理は参照と引用の存在を検証する。モデル名・対象語句による専用分岐は追加しない。

## UIと保存

React + Vite + Tailwind。Eumenesからshadcn系のButton/Input/Textarea/Card/Badge/Tabs、テーマと密度トークン、OpenUI SDK wrapperをコピーする。Hono Standardの同一origin構成を参考にHonoを接続する。元プロジェクトは変更しない。製品DB・設定・秘密はコピーしない。出典とファイルhashはui-source-manifest.jsonに記録する。

SQLite + better-sqlite3 + Drizzle、Zod。正本はSQLiteで、UIはAPI経由で取得する。試行と成果物は追記し、ファイル内容のhashと試行の帰属を分離する。起動時migration。ブラウザに認証トークンを送らない。ローカル限定127.0.0.1で起動する。

初期版は公開データ専用。既知の資格情報パターンは保存前に除去するが、任意の個人情報除去を保証しない。秘密や個人情報のあり得るHAR・画像・Traceの取り込みは今回の対象外。認証SaaSの通し検証は保存方針と対象を確定してから行う。

## 完了条件・残作業

- [x] 対象と期待項目の登録、証拠収集、仕様案、評価案、エクスポートが同じ試行IDで追える。
- [x] 取得失敗・未取得・派生資料を区別し、LLM案の引用を保存時に検査できる。
- [x] コピーしたDesignSystem・OpenUIを実際の結果閲覧で使える。
- [x] 部分→結合→UI確認を通し、実測と合成fixtureを区別して報告する。
- [x] 公開カタログの実測を行い、API仕様書にするための不足を記録する。
- [ ] Unbrowse認証後、新規のブラウザ観測と学習成果の取得を実測する。

2026-10-25の結果はbenchmark-results-2026-10-25.md。新規調査の認証は未完了であり、収集ベンチマーク全体の完了とはしない。

今回作らないもの: SaaS全体の自律探索、独自ブラウザ/Vault/キュー、汎用グラフ/ベクトルDB、能動的セキュリティ検証、サービス固有の意味判断。

## 変更前ベースライン

上流の型チェック・ビルド・check:public・check:plugins成功。上流testは128 pass/1 skip/8 fail。失敗はcookie-daemonのブラウザ検出6件、agent-mcps/mcp-proxyの環境設定参照2件。変更前から再現したため今回修正しない。
