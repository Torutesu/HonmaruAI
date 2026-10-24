# Kylon機能差分・受入条件

調査基準日: 2026-10-15。公開仕様とログイン済み画面、Honmaruのmainを照合。実装ありは限定範囲の状態であり、同等性の合格ではない。未実装は調査した主要コード経路で確認できなかった項目。

全95項目。優先度P0は権限・データ・実行の基盤、P1は日常業務の機能一致、P2はプロバイダ/配布/高度機能。全項目の受入試験が終わるまで「100%」と表示しない。

2026-10-23 公開状況: 原子的ルーム作成と3段階UI、保存色、役割変更・メンバーUIを本番公開済み。93c400d7のCIは全必須ジョブ成功。1dcf52cbで管理対象ルームの追加入口も共通化し、d8e85c76のWebデプロイで公開。10色パレット・Escape時の入力保持・CIバージョン修正もa673f31eで本番公開し、全必須CI成功と本番作成／再読み込みを確認。既定ルーム、プライバシー編集、全利用者・端末での検証は未完了。

## Rooms

[比較元の公式仕様](https://kylon.io/product/workspace)

| ID | 要件 | 現状 | 優先 | コード根拠 | 完了条件・残差 |
|---|---|---|---|---|---|
| KY-001 | 公開・非公開ルーム | 一部 | P0 | [worker/src/access.js](../../worker/src/access.js) | 管理対象ルームの公開閲覧と明示参加を分離し、原子的作成API・3段階UI・検索・参加UIを公開済み。保存色と再試行をテスト。既定ルーム・プライバシー編集・全HTTP/WS/検索の複数利用者による本番隔離検証は残る |
| KY-002 | DM・グループ・エージェントDM | 一部 | P1 | [worker/src/channels.js](../../worker/src/channels.js) | 各参加者の可視性と退出後のアクセスを実機で確認 |
| KY-003 | ホーム・最近・未読・メンション | 一部 | P1 | [web-react/src/components/ClassicList.tsx](../../web-react/src/components/ClassicList.tsx) | PR #443で左一覧のメンション絞り込みを公開。本番Macの空状態とローカル非空一覧・会話・下書き・アプリ維持を確認。一覧と通知既読位置の全端末一致は残る |
| KY-004 | ルームガイドライン | 一部 | P0 | [worker/src/harness/guidelines.js](../../worker/src/harness/guidelines.js) | 4096字・競合検知・毎ターン反映。BYOと全AI入口への適用が残る |
| KY-005 | オブジェクト固定スレッド | 一部 | P1 | [worker/src/harness/appConversations.js](../../worker/src/harness/appConversations.js) | 作成元スレッドの履歴・返信・既読を共用。独立アプリ／レコード会話に明示的AI返信・メンション・アプリ内通知・既読同期を追加。全体Activityの表示・既読・対象会話への移動を統合。独立会話のOSプッシュと実機比較未確認部分は残る |
| KY-006 | ルームへのリソース紐付け | 一部 | P0 | [worker/src/harness/apps.js](../../worker/src/harness/apps.js) | 所有ルームと参照リンクを区別し非公開データが他ルームへ漏れない |
| KY-007 | ルームメンバーとエージェント権限の分離 | 一部 | P0 | [worker/src/customAgents.js](../../worker/src/customAgents.js) | 明示的な人間・カスタムエージェント所属と役割変更UI、共通追加ダイアログを公開済み。本番で参加済み人間の除外・利用可能エージェント候補を確認。不足するエージェント利用権の明示付与・複数利用者による移譲・端末間の即時同期は残る |
| KY-008 | ルーム横断検索 | 一部 | P1 | [worker/src/channels.js](../../worker/src/channels.js) | メッセージだけでなくファイル本文・レコードも同じACLで検索 |
| KY-009 | ルームのアーカイブ・退出・削除 | 一部 | P1 | [worker/src/channelRoutes.js](../../worker/src/channelRoutes.js) | 管理対象ルームの最後の人間Admin保護、退出時の権限失効、削除後の閉鎖履歴、退会時の後任引き継ぎを公開済み。空のQAルームの可逆アーカイブを本番確認。自動GitHub除名・アカウント削除・復旧・保持期間・実行中自動化は残る |
| KY-010 | チャットから作業開始・送信先自動選択 | 一部 | P1 | [web-react/src/components/ClassicList.tsx](../../web-react/src/components/ClassicList.tsx) | 候補ルームに権限を適用し曖昧な送信先を確認 |

## Agents

[比較元の公式仕様](https://docs.kylon.io/agents/overview)

| ID | 要件 | 現状 | 優先 | コード根拠 | 完了条件・残差 |
|---|---|---|---|---|---|
| KY-011 | 新規エージェントの初期非公開 | 一部実装 | P0 | [worker/src/customAgents.js](../../worker/src/customAgents.js) | 標準作成・Markdown取込を作成者限定で原子的に保存。既存共有・Simpleを維持。外部teammate・全端末UIは残る |
| KY-012 | 名前・専門・ペルソナ・アバター | 一部 | P1 | [worker/src/customAgents.js](../../worker/src/customAgents.js) | 作成・編集・表示と日英入力を全対象クライアントで検証 |
| KY-013 | Fast/Pro/Maxの品質とコスト | 一部 | P1 | [worker/src/harness/agents.js](../../worker/src/harness/agents.js) | 現行lite/standard/maxとの差を定義し全実行経路で同じモデル選択と計測 |
| KY-014 | 独立したAgent Admin/Member | 一部実装 | P0 | [worker/src/harness/agentRoles.js](../../worker/src/harness/agentRoles.js) | 個別役割・制限付き共有・Memberによる通常メンバー追加削除・自己退出・作成者履歴を保持する所有者移譲・競合検出・最後の人間Admin保護を実装。Agent同士の役割・全実行経路のE2E・本番移譲検証は未完了 |
| KY-015 | 制限したエージェントへの直接APIアクセス | 一部 | P0 | [worker/src/harness/routes.js](../../worker/src/harness/routes.js) | 今回メモリ等・一覧・DM・編集を修正。全API/外部実行の経路監査が残る |
| KY-016 | Simpleへの切替で権限を緩めない | 実装あり | P0 | [worker/test/harness-agents.test.js](../../worker/test/harness-agents.test.js) | 両モードで非許可ユーザーとworkspace adminの直接アクセスを拒否 |
| KY-017 | メンション時のみ応答 | 一部 | P1 | [worker/src/harness/agents.js](../../worker/src/harness/agents.js) | 継続スレッド・直接DM・自動化の優先順位を統一 |
| KY-018 | スレッドの単一リーダーと引継ぎ | 一部 | P0 | [worker/src/channelRoutes.js](../../worker/src/channelRoutes.js) | 重複起動防止・明示handoff・失敗時のリーダー交代 |
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
| KY-027 | エージェント固有の永続記憶 | 一部 | P0 | [worker/src/harness/agents.js](../../worker/src/harness/agents.js) | 型・title・description・最大16,000字のbodyを後方互換で保存し、競合検知付き編集を追加。対応する研究実行は索引とフレーズ検索から必要な本文だけを権限再確認付きツールで取得。実画面・本番・全実行方式の検証は残る |
| KY-028 | preference/feedback/reference/context | 一部 | P1 | [worker/src/harness/agents.js](../../worker/src/harness/agents.js) | 4種のkind、型別・全文検索、詳細編集を追加。本文全体で重複を判定。意味的な重複統合・レビュー状態は残る |
| KY-029 | ルーム・人単位の記憶スコープ | 一部 | P0 | [worker/src/harness/agents.js](../../worker/src/harness/agents.js) | 新規チャット記憶を会話で分離。直接API・一覧・削除・実行時の隔離を検証。既存記憶の出典復元と人単位の横断設定は残る |
| KY-030 | 共有ナレッジと個人記憶の分離 | 一部 | P0 | [worker/src/memory.js](../../worker/src/memory.js) | Playbookと同一視せず出典・ACL・更新責任を保持 |
| KY-031 | 記憶のレビュー・スキル変換 | 一部 | P2 | [worker/src/harness/memoryEntries.js](../../worker/src/harness/memoryEntries.js) | 保持/修正/削除レビュー・版付き履歴・削除後の範囲付き証跡・本文と閲覧/実行範囲を維持するスキル変換は本番反映済み。再送時の重複防止と失敗時の一括取消はローカル全体テスト済み。変換の本番E2E、期限による再確認判定は残る |

## Skills

[比較元の公式仕様](https://docs.kylon.io/cli/workspace/skill)

| ID | 要件 | 現状 | 優先 | コード根拠 | 完了条件・残差 |
|---|---|---|---|---|---|
| KY-032 | スキル作成・編集・エージェントへの付与 | 一部 | P1 | [worker/src/harness/skills.js](../../worker/src/harness/skills.js) | 付与解除が次回の実行から反映し他エージェントは維持 |
| KY-033 | SKILL.mdパッケージと補助ファイル | 一部・本番反映 | P1 | [worker/src/harness/skills.js](../../worker/src/harness/skills.js) | SKILL.md・ZIP・フォルダーの確認後取り込み、相対パス検証、サイズ制限、補助バイナリ保存、権限付きページ読み込み・ZIP再出力を本番反映。Mac本番でZIPとフォルダーの日本語本文・補助ファイル一覧プレビューを確認。保存・再出力は自動テストで検証。補助ファイル編集、全アーカイブ形式、実機ドロップは残る |
| KY-034 | 必要時にスキル本文を読む | 一部 | P1 | [worker/src/harness/agents.js](../../worker/src/harness/agents.js) | 会話research・ワークフロー・予約実行に索引と権限再確認付き読込みツールを接続。ワークフロー・予約実行のモデル往復と利用量記録を模擬プロバイダーで検証。非research会話の20000字フォールバック制限、実モデルでの本番検証は残る |
| KY-035 | 組み込みスキル群 | 一部 | P1 | [worker/src/agentPresets.js](../../worker/src/agentPresets.js) | アプリ開発・資料・調査・ブラウザ・データ作業を個別検証 |
| KY-036 | private/publicと人間の所有者 | 一部 | P0 | [worker/src/harness/skills.js](../../worker/src/harness/skills.js) | 本文・パッケージ資産のprivate/workspace、所有者のみの共有変更、一覧/実行/ファイル読込みの権限確認を実装。記憶から変換したスキルは元の会話/エージェントの制限を継承し、再共有と別エージェントへの導入を拒否。共有リンク・明示agent grantモデル・本番複数ユーザー検証は残る |
| KY-037 | 共有URL・期限・失効・インポート | 未実装 | P2 | [worker/src/harness/skills.js](../../worker/src/harness/skills.js) | 複製は非公開・失効後ダウンロード不可・既存コピーとの区別 |

## Apps

[比較元の公式仕様](https://docs.kylon.io/cli/workspace/app)

| ID | 要件 | 現状 | 優先 | コード根拠 | 完了条件・残差 |
|---|---|---|---|---|---|
| KY-038 | 会話・テンプレートからDatabase App | 一部 | P1 | [worker/src/harness/appGeneration.js](../../worker/src/harness/appGeneration.js) | PR #443で元の依頼文の自動保存、元会話の表示、要求IDによる再送、保存済み生成定義の再利用、非公開元スレッドの公開範囲継承を追加（本番反映済み）。テンプレート照合とAI生成の区別、業務要件を保持する全体比較は継続 |
| KY-039 | アプリ単位のDBと複数entity | 一部 | P0 | [worker/src/harness/tables.js](../../worker/src/harness/tables.js) | アプリACLを継承する複数entityと型付きテーブルを追加。relationと参照整合性は残る |
| KY-040 | 標準CRUD・型検証 | 一部 | P0 | [worker/src/harness/tables.js](../../worker/src/harness/tables.js) | strict値検証・行CAS・HTTP/MCPページングを追加。参照整合性・スキーマ変更との競合は未実装 |
| KY-041 | 表・ボード・カレンダー | 一部 | P1 | [worker/src/harness/apps.js](../../worker/src/harness/apps.js) | table/board/metricsに終日calendarを追加。月移動・日付編集・未設定・閏日を検証。時刻・タイムゾーン付き予定とnative画面は残る |
| KY-042 | 保存ビュー・列順・幅・フィルタ・グループ | 一部 | P1 | [worker/src/harness/apps.js](../../worker/src/harness/apps.js) | 共有フィルター・グループに加え、個人ビュー・列順・列幅・選択中ビューのユーザー別保存を追加。権限分離・競合拒否。列の表示切替（タイトル常時表示）もユーザー別保存。ID・作成日時・更新日時の読取専用システム列、ヘッダーの昇順/降順/解除とフィルターを追加（初期非表示、個人設定に保存）。折り返しの個人設定保存・新規レコード入力ダイアログ・全画面表示を追加。全操作の完全一致は引き続き検証対象 |
| KY-043 | レコードに紐づく会話 | 一部 | P1 | [worker/src/harness/appConversations.js](../../worker/src/harness/appConversations.js) | 作成元スレッドの履歴・返信・既読を共用。独立アプリ／レコード会話に明示的AI返信・メンション・アプリ内通知・既読同期を追加。全体Activityの表示・既読・対象会話への移動を統合。独立会話のOSプッシュと実機比較未確認部分は残る |
| KY-044 | App APIの登録・OpenAPI・検証 | 一部 | P1 | [worker/src/harness/tableContract.js](../../worker/src/harness/tableContract.js) | テーブル単位のOpenAPI 3.1とstrict値検証を追加。独自API登録・契約固定・SDK生成は未実装 |
| KY-045 | Custom Appのソースコードと実行環境 | 一部 | P1 | [worker/src/harness/customRunner.js](../../worker/src/harness/customRunner.js) | HTML/CSS/JS生成・隔離UI・確認付きCRUD、公開済みサーバーJSのMac実行、固定API接続を追加。クラウド任意サーバー配布は残る |
| KY-046 | 下書き・プレビュー・DB fork | 一部 | P1 | [worker/src/harness/apps.js](../../worker/src/harness/apps.js) | 個人用DB fork、複数entityのプレビューSDK、差分レビュー付きの一括本番反映を追加。競合は反映を拒否。1回50行まで・反映後は再forkが必要。自動競合解消・選択的マージは残る |
| KY-047 | 承認されたcommitの公開 | 一部 | P0 | [worker/src/harness/apps.js](../../worker/src/harness/apps.js) | 保存済みversionをCASで公開し公開者を記録。Git commit単位の配布・別承認者の承認は残る |
| KY-048 | DB migration journal | 一部 | P0 | [worker/src/harness/apps.js](../../worker/src/harness/apps.js) | 追加専用migrationの原子適用・checksum・ID再試行・version競合を実装。破壊的変更・データ変換migrationは残る |
| KY-049 | 公開範囲private/workspace/public | 一部 | P0 | [worker/src/harness/apps.js](../../worker/src/harness/apps.js) | Database Appにprivate/workspaceの明示ポリシーを追加。Table・MCP・Home・Workflowにも適用。Custom Appの公開ホスト・匿名public・room grantsは未実装 |
| KY-050 | 独自ドメイン・DNS・環境変数 | 未実装 | P2 | [worker/src/harness/apps.js](../../worker/src/harness/apps.js) | ホスト競合・証明書・秘密値非表示・再デプロイ |
| KY-051 | デプロイ履歴・ログ・ロールバック | 一部 | P1 | [worker/src/harness/apps.js](../../worker/src/harness/apps.js) | 現行定義のversionと実デプロイの復元を区別 |
| KY-052 | App用Connection grant | 一部 | P0 | [worker/src/harness/apps.js](../../worker/src/harness/apps.js) | 個人/アプリ/固定URL/HTTP操作のgrant、暗号化資格情報、確認付きproxyを追加。組織共有grantとOAuth更新は残る |
| KY-053 | Appに同梱する自動化と差分検出 | 一部実装 | P1 | [worker/src/harness/appAutomationRelease.js](../../worker/src/harness/appAutomationRelease.js) | declared/liveのdrift・下書き停止・公開時反映 |
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
| KY-063 | Webhook rotation/revoke/held/replay | 一部（反映待ち） | P0 | [worker/src/harness/workflows.js](../../worker/src/harness/workflows.js) | 再発行・失効、停止中イベントの7日/1000件保持、明示IDによる古い順の再実行、二重起動防止を実装。確認時点の保留イベントを破棄するUIもローカル実装。中断した実行の復旧・本番と実画面の確認は残る。 |
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
| KY-071 | PDF・画像・CSV・テキストのプレビュー | 一部 | P1 | [web-react/src/components/DocumentPreview.tsx](../../web-react/src/components/DocumentPreview.tsx) | PR #476/#481を本番反映。PDF選択・検索ハイライト・拡大とCSV/テキスト検索を実装。PR #486でCSVダーク文字色を実画面修正し、後続のWeb/Workerデプロイ成功で公開を確認。全形式・大容量・モバイルの比較は残る |
| KY-072 | PDF/Word/Markdown/HTML書き出し | 一部 | P1 | [worker/src/files.js](../../worker/src/files.js) | 単なる元ファイルDLと形式変換を区別 |
| KY-073 | ファイルの版管理・復元 | 要検証 | P1 | [worker/src/files.js](../../worker/src/files.js) | コンテンツ版・競合・復元後の新しい版・参照履歴 |
| KY-074 | ファイルへの固定会話 | 一部（PR #486、公開済み） | P1 | [PR #486](https://github.com/Torutesu/HonmaruAI/pull/486) | ファイル単位の固定ID・同時初回作成・送信元ACLを実装。Web 887件／Workerファイル27件を検証。後続デプロイへの包含はコミット祖先関係で確認。再読込E2Eの当該ケース結果は要再確認。添付削除後も会話は通常履歴に残る。Kylonのファイルと会話の同時表示・全端末比較は残る |
| KY-075 | 公開共有の承認と失効 | 一部 | P0 | [worker/src/files.js](../../worker/src/files.js) | 共有範囲・承認者・リンク失効と監査を検証 |

## Connections

[比較元の公式仕様](https://docs.kylon.io/proxy/tools-api)

| ID | 要件 | 現状 | 優先 | コード根拠 | 完了条件・残差 |
|---|---|---|---|---|---|
| KY-076 | 連携カタログとOAuth接続 | 一部 | P1 | 該当実装は未特定 | 掲載件数ではなく認証/検索/読取/書込/解除を連携ごとに検証 |
| KY-077 | Remote MCP任意サーバー | 未実装 | P1 | 該当実装は未特定 | OAuth/API key・tool一覧・schema・SSRF制限・失効 |
| KY-078 | Custom API service | 一部 | P1 | [worker/src/harness/appCapabilities.js](../../worker/src/harness/appCapabilities.js) | 6種の公式API host・固定URL/操作・暗号化secret・応答上限・redirect禁止・write再送抑止を追加。任意hostとMCPは未対応 |
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

2026-10-18追記（レコード詳細）: テーブル・ボード・カレンダーから全項目の編集ダイアログを開き、ID・作成日時・更新日時を確認可能。変更フィールドのみを既存の競合検知付きAPIに保存。その後、アプリ／レコード固定会話（KY-005 / KY-043）、元スレッド、AI返信、メンション、全体Activity統合を追加して本番反映。上記行と検証記録に残差を記載し、完全一致とは扱わない。

### Room response update (2026-10-21)

KY-017 remains partial: implemented room-level Mentioned only with versioned saves, suppressing implicit continuations, proxy replies and automatic issue work while retaining explicit mentions and DMs. Production and native verification are pending.

Current https://docs.kylon.io/concepts/rooms describes suitable-agent routing and a Mentioned only switch; it explicitly has no separate user-facing Orchestrator role. KY-018 remains an unfulfilled tracking requirement for leadership/handoff/concurrency, but no unobserved leader-selection UI is invented. Automatic suitable-agent routing and explicit agent-to-agent handoff remain gaps.


2026-10-23追記（公開ルーム参加・管理）: 管理対象ルームの検索・参加UIをHarnessの新規メニューに接続。Kylon実画面で未参加のみの候補表示と512pxダイアログを確認し反映。RoomCreateDialogは後続変更で作成APIまで接続済み（検証記録のManaged-room creation route and UI wiring参照）。既存ルームを自動的に管理対象へ移行しない。Web全体133スイート955テスト通過。Worker全体206スイート1,576テストも通過。この追記時点では本番未反映で、KY-001/009を完了扱いしない。

### 2026-10-23 実画面で追加確認したルーム差分

| ID | 要件 | 現状 | 優先 | コード根拠 | 完了条件・残差 |
|---|---|---|---|---|---|
| KY-094 | ルーム受信Webhookから専用スレッドとエージェント実行 | 一部・未公開 | P1 | [roomHooks.js](../../worker/src/harness/roomHooks.js) | 名前付き管理・失効・専用スレッド・重複抑止・永続配送・権限再確認・確認付き再実行をローカル実装。返信保存時の原子的権限チェックとSimple配置の維持を検証。本番反映・実画面比較・複数利用者での本番受入は残る |
| KY-095 | ルームのカスタムビジュアルアップロード | 一部 | P1 | [RoomColorPicker.tsx](../../web-react/src/components/RoomColorPicker.tsx) | 本番Macで合成PNGのアップロード・一覧/ヘッダー表示・再読み込み保持・削除を確認。閲覧権限はAPIテスト済み。物理端末間反映と複数利用者での本番検証は残る。参照では入口のみ確認 |

既存のエージェント画像は公開URLを返すため、非公開ルーム画像へそのまま流用しない。既存MEDIA保存先は利用候補だが、ルームACLで認証する読み取り経路と失効後の表示破棄が必要。新規サービス契約は不要の設計方針とし、未実装を完了扱いしない。

2026-10-24追記: KY-018は世代で所有権を管理する明示引き継ぎ・履歴・停止操作と外部エージェントへの引き継ぎを実装したため「一部」に更新。失敗時の安全な自動交代、外部エージェントからの引き継ぎ開始、本番での実動作比較は未完了。OpenRouterツール実行はローカル検証段階。要件件数は完成率ではない。詳細なコミットと検証範囲はverification.mdを参照。
