READ ~/.claude/AGENTS.md BEFORE ANYTHING (skip if missing).

# Service Atlas — agent guide

このプロジェクトを開始する際に initial_instructions MCP を一度だけ実行する。実行済みなら繰り返さない。ユーザーから提示された AGENTS.md 指示は引き続き適用する。

- packages/atlas: Zod契約、HTTP観測の取り込み、SQLite/Drizzle保存、Codex SDK仕様案、引用とハッシュの検証、Hono API/CLI。
- web: React/Tailwind/OpenUI。packages/design-system: 共有UIと帰属表示。
- docs: 観測結果と過去の評価。data: Git対象外の私的ローカルデータ。

変更前に目的・範囲・依存関係・完了条件を整理し、関連MODULE.md、既存LLM指示と共通機構を確認する。意味理解・分類・計画・状況選択はLLM、コードは入出力・外部接続・実行・状態・契約・権限を担当する。語句や個別対象への分岐で意味判断を置き換えない。専用実装には外部仕様・測定・再現可能な失敗などの根拠が必要。

検証は部分→結合→通し。担当外の失敗は報告し、依頼なしで修正しない。要件を弱めない。同目的の3ラウンド後、または根拠の増えない反復時は、次の編集・再試行前に目的・証拠・残作業を見直し、判断と次の一手を現在の会話に短く通知する。正常な長時間処理は経過時間だけで再起動しない。

`bun run verify` で型検査・Atlas試験・UI build。完了前に全差分、担当外変更、例固有分岐の追加有無を確認する。保存済み証拠は変更しない。別Codexタスクへの送信はユーザーの明示依頼なしに行わない。自動収集・外部サービス依存を追加する前に、本体の公開範囲と必須サービスを確認する。

AGENTS.md と CLAUDE.md は同一内容を維持する。
