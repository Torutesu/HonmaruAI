# Kylon機能差分・受入条件

調査基準日: 2026-10-15。公開仕様とログイン済み画面、Honmaruのmainを照合。実装ありは限定範囲の状態であり、同等性の合格ではない。未実装は調査した主要コード経路で確認できなかった項目。

全93項目。優先度P0は権限・データ・実行の基盤、P1は日常業務の機能一致、P2はプロバイダ/配布/高度機能。全項目の受入試験が終わるまで「100%」と表示しない。

## Rooms

[比較元の公式仕様](https://kylon.io/product/workspace)

| ID | 要件 | 現状 | 優先 | コード根拠 | 完了条件・残差 |
|---|---|---|---|---|---|
| KY-001 | 公開・非公開ルーム | 一部 | P0 | [worker/src/access.js](../../worker/src/access.js) | 非メンバー・管理者・ゲストのHTTP/WS/検索すべてで隔離を検証 |
| KY-002 | DM・グループ・エージェントDM | 一部 | P1 | [worker/src/channels.js](../../worker/src/channels.js) | 各参加者の可視性と退出後のアクセスを実機で確認 |
| KY-003 | ホーム・最近・未読・メンション | 一部 | P1 | [web-react/src/components/ClassicList.tsx](../../web-react/src/components/ClassicList.tsx) | 一覧と通知既読位置が複数端末で一致 |
| KY-004 | ルームガイドライン | 一部 | P0 | [worker/src/harness/guidelines.js](../../worker/src/harness/guidelines.js) | 4096字・競合検知・毎ターン反映。BYOと全AI入口への適用が残る |
| KY-005 | オブジェクト固定スレッド | 未実装 | P1 | [worker/src/channels.js](../../worker/src/channels.js) | file/app/record/workflowごとに唯一の会話を再利用 |
| KY-006 | ルームへのリソース紐付け | 一部 | P0 | [worker/src/harness/apps.js](../../worker/src/harness/apps.js) | 所有ルームと参照リンクを区別し非公開データが他ルームへ漏れない |
| KY-007 | ルームメンバーとエージェント権限の分離 | 一部 | P0 | [worker/src/customAgents.js](../../worker/src/customAgents.js) | ルーム追加時に不足するエージェント利用権を表示し明示付与 |
| KY-008 | ルーム横断検索 | 一部 | P1 | [worker/src/channels.js](../../worker/src/channels.js) | メッセージだけでなくファイル本文・レコードも同じACLで検索 |
| KY-009 | ルームのアーカイブ・退出・削除 | 一部 | P1 | [worker/src/channelRoutes.js](../../worker/src/channelRoutes.js) | 復旧・保持期間・実行中自動化の扱いを定義して検証 |
| KY-010 | チャットから作業開始・送信先自動選択 | 一部 | P1 | [web-react/src/components/ClassicList.tsx](../../web-react/src/components/ClassicList.tsx) | 候補ルームに権限を適用し曖昧な送信先を確認 |

## Agents

[比較元の公式仕様](https://docs.kylon.io/agents/overview)

| ID | 要件 | 現状 | 優先 | コード根拠 | 完了条件・残差 |
|---|---|---|---|---|---|
| KY-011 | 新規エージェントの初期非公開 | 一部実装 | P0 | [worker/src/customAgents.js](../../worker/src/customAgents.js) | 標準作成・Markdown取込を作成者限定で原子的に保存。既存共有・Simpleを維持。外部teammate・全端末UIは残る |
| KY-012 | 名前・専門・ペルソナ・アバター | 一部 | P1 | [worker/src/customAgents.js](../../worker/src/customAgents.js) | 作成・編集・表示と日英入力を全対象クライアントで検証 |
| KY-013 | Fast/Pro/Maxの品質とコスト | 一部 | P1 | [worker/src/harness/agents.js](../../worker/src/harness/agents.js) | 現行lite/standard/maxとの差を定義し全実行経路で同じモデル選択と計測 |
| KY-014 | 独立したAgent Admin/Member | 未実装 | P0 | [worker/src/harness/agents.js](../../worker/src/harness/agents.js) | 最後の人間Admin・所有者移譲・自己退出・将来加入者の全社権限を検証 |
| KY-015 | 制限したエージェントへの直接APIアクセス | 一部 | P0 | [worker/src/harness/routes.js](../../worker/src/harness/routes.js) | 今回メモリ等・一覧・DM・編集を修正。全API/外部実行の経路監査が残る |
| KY-016 | Simpleへの切替で権限を緩めない | 実装あり | P0 | [worker/test/harness-agents.test.js](../../worker/test/harness-agents.test.js) | 両モードで非許可ユーザーとworkspace adminの直接アクセスを拒否 |
| KY-017 | メンション時のみ応答 | 一部 | P1 | [worker/src/harness/agents.js](../../worker/src/harness/agents.js) | 継続スレッド・直接DM・自動化の優先順位を統一 |
| KY-018 | スレッドの単一リーダーと引継ぎ | 未実装 | P0 | [worker/src/channelRoutes.js](../../worker/src/channelRoutes.js) | 重複起動防止・明示handoff・失敗時のリーダー交代 |
| KY-019 | エージェント同士のループ抑止 | 一部 | P0 | [worker/src/customAgents.js](../../worker/src/customAgents.js) | 明示宛先以外の自動再起動を防ぎ最大handoff回数を記録 |
| KY-020 | 実行停止・キャンセル伝播 | 一部 | P0 | [worker/src/agentRunner.js](../../worker/src/agentRunner.js) | 停止でモデル・ツール・子実行を中断し課金とUI状態を確定 |
| KY-021 | ターンごとの実行プロセス | 一部 | P1 | [worker/src/agentRunner.js](../../worker/src/agentRunner.js) | 開始/ツール/失敗/完了を永続化し権限ある人だけ追跡 |
| KY-022 | クラウド隔離コンピューター | 未実装 | P0 | [worker/src/agentRunner.js](../../worker/src/agentRunner.js) | 任意コード・ファイル・ネットワークを実行単位で隔離 |
| KY-023 | ローカルゲートウェイ・再接続 | 一部 | P1 | [worker/src/harness/gateways.js](../../worker/src/harness/gateways.js) | Mac mini隔離JS・常駐・ログイン時接続・プロセス/ランタイム復旧と本番個人DMの実ツール往復を検証。物理再起動・スリープ復帰の実機試験は残る |
| KY-024 | Codex/Claude Code/Devinの実行選択 | 一部 | P1 | [worker/src/teammates.js](../../worker/src/teammates.js) | クラウドAPI接続とローカルCLIを区別して実機で検証 |
| KY-025 | ACP接続契約 | 未実装 | P2 | [worker/src/teammates.js](../../worker/src/teammates.js) | initialize/session/prompt/cancelと認証・権限更新・切断を検証 |
| KY-026 | 既存ChatGPT契約でクラウドCodex | 要検証 | P2 | [worker/src/teammates.js](../../worker/src/teammates.js) | 提供元条件と対応実行方式の確認後に隔離環境で検証 |

## Memory

[比較元の公式仕様](https://docs.kylon.io/concepts/memory)

| ID | 要件 | 現状 | 優先 | コード根拠 | 完了条件・残差 |
|---|---|---|---|---|---|
| KY-027 | エージェント固有の永続記憶 | 一部 | P0 | [worker/src/harness/agents.js](../../worker/src/harness/agents.js) | 文章リストから型・title・description・bodyを持つエントリへ後方互換で拡張 |
| KY-028 | preference/feedback/reference/context | 一部 | P1 | [worker/src/harness/agents.js](../../worker/src/harness/agents.js) | 4種のkindの保存・検証を追加。型別検索・編集・重複統合・レビュー状態は残る |
| KY-029 | ルーム・人単位の記憶スコープ | 一部 | P0 | [worker/src/harness/agents.js](../../worker/src/harness/agents.js) | 新規チャット記憶を会話で分離。直接API・一覧・削除・実行時の隔離を検証。既存記憶の出典復元と人単位の横断設定は残る |
| KY-030 | 共有ナレッジと個人記憶の分離 | 一部 | P0 | [worker/src/memory.js](../../worker/src/memory.js) | Playbookと同一視せず出典・ACL・更新責任を保持 |
| KY-031 | 記憶のレビュー・スキル変換 | 未実装 | P2 | [worker/src/harness/skills.js](../../worker/src/harness/skills.js) | 手順をスキルへ変換して記憶との二重更新を防止 |

## Skills

[比較元の公式仕様](https://docs.kylon.io/cli/workspace/skill)

| ID | 要件 | 現状 | 優先 | コード根拠 | 完了条件・残差 |
|---|---|---|---|---|---|
| KY-032 | スキル作成・編集・エージェントへの付与 | 一部 | P1 | [worker/src/harness/skills.js](../../worker/src/harness/skills.js) | 付与解除が次回の実行から反映し他エージェントは維持 |
| KY-033 | SKILL.mdパッケージと補助ファイル | 未実装 | P1 | [worker/src/harness/skills.js](../../worker/src/harness/skills.js) | frontmatter検証・scripts/templatesの相対パス・安全な展開 |
| KY-034 | 必要時にスキル本文を読む | 未実装 | P1 | [worker/src/harness/agents.js](../../worker/src/harness/agents.js) | 現状の全文注入を索引＋必要時読込みへ変更 |
| KY-035 | 組み込みスキル群 | 一部 | P1 | [worker/src/agentPresets.js](../../worker/src/agentPresets.js) | アプリ開発・資料・調査・ブラウザ・データ作業を個別検証 |
| KY-036 | private/publicと人間の所有者 | 一部 | P0 | [worker/src/harness/skills.js](../../worker/src/harness/skills.js) | 本文のprivate/workspace・所有者の共有変更・実行時隔離。パッケージ資産とgrantモデルは残る |
| KY-037 | 共有URL・期限・失効・インポート | 未実装 | P2 | [worker/src/harness/skills.js](../../worker/src/harness/skills.js) | 複製は非公開・失効後ダウンロード不可・既存コピーとの区別 |

## Apps

[比較元の公式仕様](https://docs.kylon.io/cli/workspace/app)

| ID | 要件 | 現状 | 優先 | コード根拠 | 完了条件・残差 |
|---|---|---|---|---|---|
| KY-038 | 会話・テンプレートからDatabase App | 一部 | P1 | [worker/src/harness/apps.js](../../worker/src/harness/apps.js) | テンプレート照合とAI生成の区別を明示し業務要件を保持 |
| KY-039 | アプリ単位のDBと複数entity | 未実装 | P0 | [worker/src/harness/tables.js](../../worker/src/harness/tables.js) | 単一JSON行テーブルから所有権・型・relationを備えたデータ契約へ拡張 |
| KY-040 | 標準CRUD・型検証 | 一部 | P0 | [worker/src/harness/tables.js](../../worker/src/harness/tables.js) | strict値検証・行CAS・HTTP/MCPページングを追加。参照整合性・スキーマ変更との競合は未実装 |
| KY-041 | 表・ボード・カレンダー | 一部 | P1 | [worker/src/harness/apps.js](../../worker/src/harness/apps.js) | table/board/metricsに終日calendarを追加。月移動・日付編集・未設定・閏日を検証。時刻・タイムゾーン付き予定とnative画面は残る |
| KY-042 | 保存ビュー・列順・幅・フィルタ・グループ | 一部 | P1 | [worker/src/harness/apps.js](../../worker/src/harness/apps.js) | 共通ビューと利用者ビューの変更競合を検証 |
| KY-043 | レコードに紐づく会話 | 未実装 | P1 | [worker/src/harness/apps.js](../../worker/src/harness/apps.js) | 同一entity/recordの会話が重複しない |
| KY-044 | App APIの登録・OpenAPI・検証 | 一部 | P1 | [worker/src/harness/tableContract.js](../../worker/src/harness/tableContract.js) | テーブル単位のOpenAPI 3.1とstrict値検証を追加。独自API登録・契約固定・SDK生成は未実装 |
| KY-045 | Custom Appのソースコードと実行環境 | 未実装 | P1 | [worker/src/harness/apps.js](../../worker/src/harness/apps.js) | 任意UI/サーバー処理を既存Honmaruと隔離して実行 |
| KY-046 | 下書き・プレビュー・DB fork | 未実装 | P1 | [worker/src/harness/apps.js](../../worker/src/harness/apps.js) | プレビューの書込みが本番DBを変更しない |
| KY-047 | 承認されたcommitの公開 | 未実装 | P0 | [worker/src/harness/apps.js](../../worker/src/harness/apps.js) | 承認対象commit・公開範囲を固定し更新後の古い承認を拒否 |
| KY-048 | DB migration journal | 未実装 | P0 | [worker/src/harness/apps.js](../../worker/src/harness/apps.js) | migrationを一度だけ適用し改変検知・再試行を検証 |
| KY-049 | 公開範囲private/workspace/public | 一部 | P0 | [worker/src/harness/apps.js](../../worker/src/harness/apps.js) | Database Appにprivate/workspaceの明示ポリシーを追加。Table・MCP・Home・Workflowにも適用。Custom Appの公開ホスト・匿名public・room grantsは未実装 |
| KY-050 | 独自ドメイン・DNS・環境変数 | 未実装 | P2 | [worker/src/harness/apps.js](../../worker/src/harness/apps.js) | ホスト競合・証明書・秘密値非表示・再デプロイ |
| KY-051 | デプロイ履歴・ログ・ロールバック | 一部 | P1 | [worker/src/harness/apps.js](../../worker/src/harness/apps.js) | 現行定義のversionと実デプロイの復元を区別 |
| KY-052 | App用Connection grant | 未実装 | P0 | [worker/src/harness/apps.js](../../worker/src/harness/apps.js) | ブラウザに資格情報を渡さずserver proxyで毎回再認可 |
| KY-053 | Appに同梱する自動化と差分検出 | 未実装 | P1 | [worker/src/harness/workflows.js](../../worker/src/harness/workflows.js) | declared/liveのdrift・下書き停止・公開時反映 |
| KY-054 | テンプレート共有とバージョン | 未実装 | P2 | [worker/src/harness/templates.js](../../worker/src/harness/templates.js) | 秘密情報・実データを除去して固定バージョンで共有 |
| KY-055 | App移動・削除とデータ保持 | 一部 | P0 | [worker/src/harness/apps.js](../../worker/src/harness/apps.js) | ルーム移動時に会話ACLを再確認し削除時DB保持方針を明示 |

## Automations

[比較元の公式仕様](https://docs.kylon.io/cli/workspace/workflow)

| ID | 要件 | 現状 | 優先 | コード根拠 | 完了条件・残差 |
|---|---|---|---|---|---|
| KY-056 | 手動・スケジュール・Webhook・レコード変更 | 一部 | P1 | [worker/src/harness/workflows.js](../../worker/src/harness/workflows.js) | 現在4種。cron/every/at・deleteイベントと時差/DSTを追加 |
| KY-057 | 型付きイベントフィルタ | 一部 | P1 | [worker/src/harness/workflows.js](../../worker/src/harness/workflows.js) | missing/null/数値/配列・変更前後・重複配信を検証 |
| KY-058 | 保存定義の不変revision | 一部 | P0 | [worker/src/harness/workflows.js](../../worker/src/harness/workflows.js) | 新規runの定義を原子的に保存し承認後も同じ手順で再開。定義revision履歴・比較UI・旧runの移行は残る |
| KY-059 | TypeScript SDKと永続checkpoint | 未実装 | P1 | [worker/src/harness/workflows.js](../../worker/src/harness/workflows.js) | 再開時に完了済み外部操作を繰り返さない |
| KY-060 | 条件分岐・batch・制限付き並列 | 未実装 | P1 | [worker/src/harness/workflows.js](../../worker/src/harness/workflows.js) | 部分失敗・ページング・取りこぼし率を結果に含める |
| KY-061 | 実行履歴・step結果 | 一部 | P1 | [worker/src/harness/workflows.js](../../worker/src/harness/workflows.js) | 全ステップの入力出力・エラー・コスト・権限を追跡 |
| KY-062 | 署名付きWebhookと再送防止 | 一部 | P0 | [worker/src/harness/workflows.js](../../worker/src/harness/workflows.js) | URL secretだけでなく署名・期限・event IDを検証 |
| KY-063 | Webhook rotation/revoke/held/replay | 未実装 | P0 | [worker/src/harness/workflows.js](../../worker/src/harness/workflows.js) | 停止中イベント保持と明示再実行・失効を検証 |
| KY-064 | 承認待ち・継続 | 一部 | P0 | [worker/src/harness/workflows.js](../../worker/src/harness/workflows.js) | 承認者・操作内容・revisionを固定し二重承認を排除 |
| KY-065 | 停止・再開・アーカイブ | 一部 | P1 | [worker/src/harness/workflows.js](../../worker/src/harness/workflows.js) | スケジュール停止と実行キャンセルを区別 |
| KY-066 | 実行者の権限を再検証 | 一部 | P0 | [worker/src/harness/agents.js](../../worker/src/harness/agents.js) | 今回Agent grantの再確認を追加。部屋/DB/Connection/依頼者権限は継続監査 |
| KY-067 | 実行予算と自動pause | 未実装 | P0 | [worker/src/ledger.js](../../worker/src/ledger.js) | 日/週/月上限・同時実行の残高競合・回復時の挙動 |
| KY-068 | 一回限りのFollow-up | 一部 | P1 | [worker/src/harness/followups.js](../../worker/src/harness/followups.js) | 相対/絶対時刻・スレッド・通知先・停止・権限変更後を検証 |
| KY-069 | Follow-upの実ツール実行 | 未実装 | P1 | [worker/src/harness/followups.js](../../worker/src/harness/followups.js) | 現状はモデル文章かリマインダー。外部状態を実確認して根拠と一緒に返す |

## Files

[比較元の公式仕様](https://docs.kylon.io/cli/workspace/file)

| ID | 要件 | 現状 | 優先 | コード根拠 | 完了条件・残差 |
|---|---|---|---|---|---|
| KY-070 | アップロード・フォルダ・生成者フィルタ | 一部 | P1 | [worker/src/files.js](../../worker/src/files.js) | 作成者/アップロード者・最近/フォルダの両表示 |
| KY-071 | PDF・画像・CSV・テキストのプレビュー | 一部 | P1 | [web-react/src/components/Attachments.tsx](../../web-react/src/components/Attachments.tsx) | 形式別エラー・大容量・モバイル・本文検索を検証 |
| KY-072 | PDF/Word/Markdown/HTML書き出し | 一部 | P1 | [worker/src/files.js](../../worker/src/files.js) | 単なる元ファイルDLと形式変換を区別 |
| KY-073 | ファイルの版管理・復元 | 要検証 | P1 | [worker/src/files.js](../../worker/src/files.js) | コンテンツ版・競合・復元後の新しい版・参照履歴 |
| KY-074 | ファイルへの固定会話 | 未実装 | P1 | [worker/src/channels.js](../../worker/src/channels.js) | ファイルを開くと同一の会話が復元 |
| KY-075 | 公開共有の承認と失効 | 一部 | P0 | [worker/src/files.js](../../worker/src/files.js) | 共有範囲・承認者・リンク失効と監査を検証 |

## Connections

[比較元の公式仕様](https://docs.kylon.io/proxy/tools-api)

| ID | 要件 | 現状 | 優先 | コード根拠 | 完了条件・残差 |
|---|---|---|---|---|---|
| KY-076 | 連携カタログとOAuth接続 | 一部 | P1 | 該当実装は未特定 | 掲載件数ではなく認証/検索/読取/書込/解除を連携ごとに検証 |
| KY-077 | Remote MCP任意サーバー | 未実装 | P1 | 該当実装は未特定 | OAuth/API key・tool一覧・schema・SSRF制限・失効 |
| KY-078 | Custom API service | 未実装 | P1 | 該当実装は未特定 | 許可hostとsecret保管・最小権限proxyを実装 |
| KY-079 | Agent単位のConnection grant | 一部 | P0 | [worker/src/agentTools.js](../../worker/src/agentTools.js) | 人の接続とagent/app/workflowの利用権を分離 |
| KY-080 | Tools discovery/execute/native proxy/upload | 一部 | P1 | [worker/src/mcp.js](../../worker/src/mcp.js) | 同一principalとスコープでREST/CLI/MCPを提供 |
| KY-081 | LINE公式アカウント受信 | 未実装 | P1 | 該当実装は未特定 | 署名検証・接続単位のイベント保存・LINE Inbox |
| KY-082 | データプロバイダの組込み | 一部 | P2 | [worker/src/agentResearch.js](../../worker/src/agentResearch.js) | 検索以外の人/企業/SEO/地図/TikTok等を実契約APIで検証 |
| KY-083 | 画像・動画・音声生成 | 未実装 | P2 | [worker/src/agentTools.js](../../worker/src/agentTools.js) | job進捗・失敗・成果物保持・事前費用見積もり |
| KY-084 | モデル互換proxy | 一部 | P2 | [worker/src/orgAI.js](../../worker/src/orgAI.js) | 対応API・stream・使用量計上・providerエラーを検証 |
| KY-085 | Workspace CLIの全操作 | 未実装 | P1 | [worker/src/mcp.js](../../worker/src/mcp.js) | JSON出力・scope・ユーザー/agent principal・終了コード・失敗閉鎖 |

## Commercial

[比較元の公式仕様](https://kylon.io/pricing)

| ID | 要件 | 現状 | 優先 | コード根拠 | 完了条件・残差 |
|---|---|---|---|---|---|
| KY-086 | workspace共有クレジット | 一部 | P0 | [worker/src/ledger.js](../../worker/src/ledger.js) | 個人Free/Proと独立した残高予約・確定・取消・同時実行 |
| KY-087 | 月次更新・trial・追加pack | 未実装 | P1 | 該当実装は未特定 | 期限・繰越・アップグレード/ダウングレード時期・二重請求防止 |
| KY-088 | 残高不足時停止と通知 | 一部 | P0 | [worker/src/gate.js](../../worker/src/gate.js) | モデルだけでなくtool/workflow/app実行も予算制御 |
| KY-089 | agent数上限 | 一部 | P1 | [worker/src/customAgents.js](../../worker/src/customAgents.js) | 固定最大数ではなくplan別active数・trial数を制御 |
| KY-090 | 音声入力・AIとの音声会話 | 一部 | P2 | [web-react/src/components/JamPanel.tsx](../../web-react/src/components/JamPanel.tsx) | 人同士のJamとAI音声通話を区別して検証 |
| KY-091 | Web/Mac/iOS/Androidの機能一致 | 一部 | P1 | [apps/mobile/README.md](../../apps/mobile/README.md) | 端末ごとの操作・通知・ファイル・オフラインを受入試験 |
| KY-092 | ユーザーごとのSimple表示維持 | 一部 | P0 | [web-react/src/utils/harness.ts](../../web-react/src/utils/harness.ts) | 今回Web/Electronブラウザ設定を追加。native/端末間同期は未実装 |
| KY-093 | Simpleデータを破壊しない拡張 | 実装あり | P0 | [worker/src/harness/mode.js](../../worker/src/harness/mode.js) | 既定Simple・追加schema・切替で削除しない。リリース時に回帰試験 |

2026-10-16追記: 会話スコープ記憶、予約実行の会話アクセス再検証、フォローアップの一覧・ホーム・MCPの隔離、run定義固定を追加。詳細は [検証記録](verification.md)。
