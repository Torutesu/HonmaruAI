> 履歴資料。以下は旧調査で、最新の判断には使わないでください。価格・権限・Apps・監査・競合優位の記述には未確認または誤りがあります。現行の基準は audit.md と matrix.md です。

# Kylon に寄せる — 差分の洗い出しと実装計画

調査日: 2026-10-15。対象: [kylon.io](https://kylon.io/)（Pure Reason Inc.、「Your first company harness. Where humans and agents run your business together」、2026-10-13 公開ローンチ）。

> 調査方法の制約: この環境からは kylon.io / docs.kylon.io / App Store に直接接続できない（プロキシが 403）。以下は検索インデックスの抜粋（kylon.io 各ページ、docs.kylon.io、App Store / Google Play の説明と更新履歴、ローンチ時の X 投稿、第三者レビュー）から組み立てた。ユースケースの個別タイトル、docs 各ページの本文、クレジット単価は取れていない。直接見られる環境で埋めること。

## 方針: Simple と Harness の二本立て

**今の Honmaru（判断カードのフィード + チャット）は一切消さない。** ワークスペースごとに「モード」を持たせる。

| モード | 中身 | 既定 |
|---|---|---|
| `simple` | 今の Honmaru。フィード、チャット、Routines、Playbook、Tools。 | 既存・新規ワークスペースすべて |
| `harness` | `simple` の全部に加えて、Kylon 相当の面: Apps / Tables、エージェントのメンバー化、Workflows、Follow-ups、Approvals、Skills、Credits | 管理者が切り替える |

- サーバーの機能はモードに関係なく存在する（API は `harness` でなくても動く）。モードは **見せ方** の切り替え。これでシンプル版のコードパスには一行も触らずに済む。
- 切り替えは `PUT /orgs/mode`（管理者のみ、`workspace.mode` 権限）。値は `org_settings.mode`。
- クライアントは `GET /orgs/mode` を読み、`harness` のときだけ新しいナビゲーションを出す。

## Kylon の機能と、Honmaru の現状

凡例: ✅ ある / △ 一部ある / ❌ ない

### 場所（Rooms / Threads）

| Kylon | Honmaru | 差分 |
|---|---|---|
| Rooms と Threads、@メンション | ✅ チャンネル（`b:` / `dm:` / `g:`）、スレッド、メンション | 呼び名だけ。Harness では「Room」と表示 |
| ルームに人・エージェント・アプリ・ファイルが同居 | △ エージェントはスレッドで返答、ファイルあり、アプリなし | **ルームにアプリを紐付ける**（Apps と一緒に作る） |
| ルームで「承認待ち」が見える | △ 判断カードはフィードにある | **ルームごとの承認待ち一覧**（Approvals） |
| エージェントの応答を止める | ❌ | 実行中のエージェント実行をキャンセル |
| ワークスペースをクライアントごとに分ける | ✅ ワークスペース切り替え | — |

### エージェント

| Kylon | Honmaru | 差分 |
|---|---|---|
| エージェントは「メンバー」: 名前・専門・プロフィール | △ `customAgents.js` の @handle（書くだけ、動かない） | **エージェントを一級のメンバーにする**（下の Agents v2） |
| エージェントごとの永続メモリ | ❌ チーム全体の Playbook だけ | **エージェント固有のメモリ** |
| 作成直後は非公開（作成者だけ）、管理者がルームと接続を割り当て | ❌ チーム／個人の二択 | **アクセス: 参加ルーム、使える接続、使える人** |
| Intelligence tier（Max / Standard / Lite、作成時に固定） | ❌ ワークスペースで一つのモデル | **tier をエージェントに持たせ、モデルに対応付け** |
| Agent speed（Fast / Pro / Max）をチャットで選ぶ | ❌ | 1 メッセージごとの速度指定 |
| 「メンションされたときだけ応答」 | ❌ | エージェント設定に追加 |
| Kylon-hosted と BYO（Claude Code / Codex / Devin / ACP） | △ `teammates.js`（Claude / Devin / Cursor / Codex をクラウド API で） | ローカル CLI ゲートウェイ（P2） |
| エージェント同士の受け渡し | △ スレッドで複数エージェントは返答できる | エージェントが別エージェントに仕事を渡す（P1） |

### 記憶と文脈

| Kylon | Honmaru | 差分 |
|---|---|---|
| Workspace Memory | ✅ Playbook（見える・直せる・消せる） | 呼び名だけ |
| エージェントのメモリ（会話をまたいで圧縮して保持） | ❌ | Agents v2 |
| Skills（チームのやり方。インストール・共有・組み合わせ） | △ エージェントの指示 Markdown、プリセット | **Skills: 再利用できる手順書。エージェントに付け外しする** |

### Workflows / Automations / Follow-ups

| Kylon | Honmaru | 差分 |
|---|---|---|
| 定期実行 | ✅ Routines（一文から頻度を読む、コスト表示） | — |
| トリガー: 手動 / cron / Webhook / データ変更 | △ cron のみ | **Workflows: 手動・Webhook・テーブル行の変更をトリガーに** |
| 実行履歴を見られる | △ 最後の実行だけ | **実行ごとの履歴** |
| エージェントを呼ぶ、処理を連鎖する | △ Routine はレポートを書くだけ | Workflow のステップ: エージェント実行・行の追加更新・承認カード・投稿 |
| Follow-ups（エージェントが後でもう一度やる。一覧で見てキャンセル） | △ `later.js`（人のリマインダー） | **Follow-ups: 会話・エージェント・時刻・指示。期限で実行してスレッドに投稿** |

### Apps / Tables（最大の穴）

| Kylon | Honmaru | 差分 |
|---|---|---|
| 会話から社内アプリを作る（請求書トラッカー、採用ボード、営業ダッシュボード、CRM） | ❌ | **Apps** |
| アプリごとのデータベース | ❌ | **Tables: 型付きの列と行。API とエージェントツールから読み書き** |
| ビュー: 表 / ボード / ダッシュボード | ❌ | アプリ定義にビューを持たせる（table / board / metrics） |
| バージョン履歴 | ❌ | アプリ定義の版を保存、戻せる |
| ルームやチャットに紐付け | ❌ | `app_links` |
| 公開（サブドメイン） | ❌ | 公開用の読み取り専用 URL（P1） |
| テンプレート（Sales CRM、採用、請求書） | ❌ | **テンプレート 3 本から始める** |
| モバイルの Apps タブ、DB ビューア | ❌ | Web 先行、iOS は P1 |

### 承認（Human in the loop）

| Kylon | Honmaru | 差分 |
|---|---|---|
| 重要な操作は人が承認 | ✅ 判断カードそのもの。代理エージェントの提案、自動承認ルール | — |
| 承認待ちの一覧（ルーム単位・自分宛て） | △ フィード | **Approvals 画面**: エージェント／ワークフロー由来の承認待ちを横断で |

### 連携・開発者向け

| Kylon | Honmaru | 差分 |
|---|---|---|
| 3,000+ 連携（OAuth / MCP） | △ Composio（Gmail / Slack / Notion / Google）、Smithery（Linear / Jira / HubSpot…） | 見せ方の拡張（P1） |
| Remote MCP・独自 API を接続として足す | ❌ | P1 |
| エージェントごとに使える接続を決める | ❌ | Agents v2 のアクセスに含める |
| Tools API（`/proxy/tools/*`）、Workspace CLI | △ MCP（判断の依頼・検索） | **MCP にテーブル・アプリ・フォローアップのツールを足す** |
| 組み込みデータソース（スクレイパー、People Data Labs 等） | △ Web 検索、ページ読み取り | P2 |
| 画像・動画・音声生成 | ❌ | P2 |

### 課金

| Kylon | Honmaru | 差分 |
|---|---|---|
| ワークスペース単位のクレジット（Core $100/月 1,000 クレジット、7 日トライアル） | △ 個人単位 Free / Pro、AI コストは `ledger.js` で記録 | **Credits: ワークスペースの残高、実行ごとの消費、尽きたら止める**（P1） |

### オンボーディング・モバイル

| Kylon | Honmaru | 差分 |
|---|---|---|
| エージェントとの音声通話で会社を説明して初期設定 | △ 文章での初期設定 | P2 |
| 音声入力・ディクテーション | △ Jam の文字起こし | P2 |
| iOS / Android / Mac | ✅ iOS（SwiftUI）、Mac / Windows（Electron）、Android（Expo PoC） | — |

## Kylon にないもの（すでに上回っているところ）

- **判断カードのフィード**: 「自分が今決めるべきもの」だけが一枚ずつ来る。Kylon は承認待ちがルームに散らばる。
- **受信トリガー**: Gmail / Slack / Notion / メールが自動で判断カードになる。
- **エンタープライズ**: SSO（OIDC / SAML）、SCIM、ハッシュチェーンの監査ログ、DLP、リーガルホールド、IP 制限。Kylon は SOC 2 も「進行中」。
- **コストを先に見せる**: Routine の 1 回あたりコスト。
- **人の代理エージェント**、休暇中の代理決裁、ハドル（Jam）。

## 進捗（2026-10-15 時点）

| 項目 | 状態 | 場所 |
|---|---|---|
| モード切り替え `simple` / `harness` | ✅ サーバー・Web。管理者のみ変更可。simple のエージェント・MCP は従来どおり | `worker/src/harness/mode.js`, `web-react/src/screens/Harness.tsx`（ハブ） |
| Tables（型付きの列、行の CRUD、絞り込み・並べ替え） | ✅ | `worker/src/harness/tables.js` |
| Apps（テンプレート 4 種、文章から生成、table / board / metrics ビュー、バージョンと復元、ルームへの紐付け） | ✅ サーバー・Web | `worker/src/harness/apps.js`, `templates.js` |
| Agents v2（専門、tier、エージェント固有メモリ、「覚えて」、呼べる人、名指しのときだけ応答） | ✅ harness モードでのみ有効 | `worker/src/harness/agents.js` |
| Skills（作成・付与・プロンプトへの注入） | ✅ | `worker/src/harness/skills.js` |
| Workflows（手動 / スケジュール / Webhook / 行の変化、6 種のステップ、実行履歴、承認で再開） | ✅ | `worker/src/harness/workflows.js` |
| Follow-ups（API とチャット「@agent follow up in 3 days: …」、一覧・キャンセル、毎分実行） | ✅ | `worker/src/harness/followups.js` |
| Approvals（自分の判断待ち・他人待ち） | ✅ | `GET /approvals` |
| MCP にテーブル・アプリ・ワークフロー・フォローアップのツール | ✅ harness モードのみ。書き込みは `write` スコープ | `worker/src/harness/mcpTools.js` |
| 監査ログ（モード変更、アプリ作成・削除、ワークフロー作成・削除、エージェントのプロフィール変更） | ✅ | — |
| Credits / Agent speed / 応答停止 / 公開 URL / Remote MCP 接続 / エージェント間の受け渡し | ⏳ フェーズ 2 | — |
| ルーム画面に紐付いたアプリを出す | ✅ Web（ルームの詳細パネル） | `web-react/src/components/RoomApps.tsx` |
| iOS（あなた → ハーネス: モード切り替え、Apps の表・ボード・集計と行の編集、Workflows の一覧・実行履歴・作成、Approvals、エージェントチーム、Skills） | ✅ 実装。CI の iOS ジョブ（macOS）で要ビルド確認 | `TikTokForWork/Features/Harness/`, `Services/HarnessService.swift` |
| Mac / Windows アプリ（Electron）: Web と同じ画面に加え「移動」メニュー（ハーネス ⌘⇧H、アプリ、ワークフロー、承認） | ✅ 既定はシンプルのまま | `apps/desktop/src/links.js` `goMenuItems` |
| 画像・動画生成、音声オンボーディング、ローカル CLI ゲートウェイ | ⏳ フェーズ 3 | — |

画面の確認: `E2E_SPEC=e2e/harness-tour.mjs ./e2e/run.sh` が実際の Worker と Web を立ち上げ、ハーネスの全画面をノート PC・スマホ幅で撮影する。

## 実装順

「Kylon の機能を 100% 再現」→「上回る」。

### フェーズ 1 — 土台と最大の穴（このブランチ）

1. **モード切り替え** `simple` / `harness`。サーバーと Web、テスト。
2. **Tables**: 列の型（text / number / date / select / checkbox / url / person）、行の CRUD、並べ替え・絞り込み。
3. **Apps**: テーブル + ビュー（table / board / metrics）の定義、バージョン、ルームへの紐付け、テンプレート（Sales CRM / 採用ボード / 請求書トラッカー）、自然文からの生成（モデルがあればモデル、なければテンプレート照合）。
4. **Agents v2**: 専門、tier、メモリ、アクセス（参加ルーム・接続・人）、メンション時のみ応答。
5. **Workflows**: トリガー（手動 / スケジュール / Webhook / 行の変更）、ステップ、実行履歴。
6. **Follow-ups**: 作成・一覧・キャンセル・期限で実行。
7. **Approvals**: エージェント／ワークフロー由来の承認待ち。
8. **Skills**: 手順書の作成・エージェントへの付与。
9. **MCP ツール追加**: tables / apps / follow-ups。

### フェーズ 2 — 100% に近づける

Credits、Agent speed、応答停止、公開 URL、Remote MCP 接続、エージェント間の受け渡し、iOS の Apps タブ。

### フェーズ 3 — 上回る

- **アプリの行の変化が判断カードになる**（例: 請求書が 14 日超過 → 担当者のフィードに「督促メールを送る？」）。Kylon はアプリと承認が別の面にある。
- **ワークフローの実行前コスト見積もり**。
- **監査ログにエージェントの全操作**（Kylon は「auditable」と言うだけ）。
