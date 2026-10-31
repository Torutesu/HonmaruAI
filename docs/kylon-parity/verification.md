# 検証記録

2026-10-16、ローカルの `codex/kylon-parity`。本番へのデプロイ・DB移行は未実施。

- Worker: `npm test -- --run` — 190 files / 1,220 tests passed。
- Web: `npm test -- --run` — 75 files / 709 tests passed。
- Web: `tsc --noEmit` と Vite production build 成功。既存の大きいチャンク警告あり。
- 最後のモード切替調整後、harness-mode の5テストと型チェックを再実行。
- ローカルのAPIモックを使用して実際のHarnessHubを表示し、Simple専用設定で拡張メニューが消え、共有ワークスペースのHarness設定が維持されることをブラウザで確認。検証用ページは削除。
- `git diff --check` 成功。

追加した回帰テストは、Simpleでも適用するエージェントアクセス制御、管理者による私有エージェントへの迂回拒否、権限剥奪後の予約実行、ガイドラインの4096文字制限・競合更新・部屋間分離、ワークスペース／セッション切替時の古いモード・管理権限の混入防止、ブラウザ専用Simple設定を対象とする。

これはKylonとの完全一致の証明ではない。本番のモデル呼び出し、BYO接続、アプリビルド／公開、全ネイティブ画面、課金、外部コネクタのE2Eは未検証。未実装・一部実装は matrix.md に残している。

## 2026-10-16 継続実装

会話スコープの記憶と記憶一覧UI、型の保存、予約実行の会話認可、Follow-upの一覧／ホーム／MCP／取消認可、ワークフローrunの定義固定と履歴の認可を追加。

全Worker再実行は191ファイル・1,227テスト中1,223成功、4失敗。内訳は、旧コードをロード済みの実行中に追加したDM認可テスト1件と、個人エージェントの明示的な部屋共有の回帰（同じ未消費モックによる後続失敗を含む）。後者は、プロフィール未設定のエージェントに限って既存の部屋への明示追加を維持する形で修正した。

修正後、影響する `agents`・`harness-memory-scope`・`harness-agents`・`harness-workflows`・`harness-mcp` の5ファイル59テストが成功。別途 `harness-apps`・`harness-guidelines` の12テストも成功。最終ツリーでの全Worker一括再実行は未実施。Web全709テスト、型チェック、本番ビルドは成功。

追加の検証対象: 部屋／DM／組織間の記憶隔離、スコープ単位の重複・削除、旧記憶の互換、非公開部屋のスコープ一覧、権限剥奪後の投稿、承認待ち中の定義変更、定義を公開向けに編集した後の古い非公開run履歴、Follow-upの一覧・ホーム・取消。

旧記憶の出典を自動推定して移動してはいない。新しい定義スナップショットがない旧runの履歴は現在のワークフロー定義で認可する。完全なresource ACL、実行リース・外部作用の冪等性、旧データ移行、Gateway、Custom App公開基盤は未完了。

## Calendar

終日カレンダービューを追加。既存Tableの同じ行を日付単位に表示し、日付変更は既存の更新APIを通す。日時イベント・繰り返し予定・タイムゾーン変換には未対応。無効日付は削除せず「日付未設定」に表示する。

WorkerのAppsテスト10件成功。Web全76ファイル711テスト成功、型チェック・本番ビルド成功。カレンダーの閏日、年またぎ、日付編集、未設定レコード表示を検証した。

### 継続実装後の再実行結果

Worker全体の2回目は191ファイル・1,231テスト中1,230成功、1失敗。失敗は、実行開始後に追加したcalendarテストが開始時に読み込まれた旧Appsモジュールに対して動いたもの（calendarをtableへフォールバック）。新しいプロセスでApps全10テストを再実行し成功。既存Simple共有の回帰とDM認可テストは全体再実行でも成功した。変更中の全体実行と最終コードの個別実行を合算して「最終ツリーで全体一括成功」とは表記しない。

Webの最終実行は76ファイル・711テスト成功。ローカルコミット: `9c794d59`（認可・記憶・run定義）、`6278d6c4`（終日カレンダー）。本番未反映。

## Database Appの公開範囲と検証記録の訂正

2026-10-16: `hx_app_access` と所有者向け共有UIを追加。private/workspaceの変更はversion競合を検知し、HTTPのApp/Table、Home、MCP、Workflowの閲覧・実行・row triggerへ適用する。既存Appはworkspace共有を維持する。新規作成時に入力の`by`で所有者を偽装できた経路も修正。

前回の「カレンダー追加後の型チェック成功」は誤記だった。シェルが型チェックの失敗後もビルドへ進んでおり、App.definitionの型宣言不足を見落としていた。今回型宣言を追加し、`tsc --noEmit`を単独実行してexit code 0を確認した。今後は各検証の終了コードを別々に確認する。

変更対象Worker 7ファイル76テスト成功。Web全77ファイル713テスト成功。型チェックexit 0、本番ビルドexit 0（大きなchunkの既存警告あり）。MCPのcalendar集計がrowsを参照して失敗する不具合も修正・テストした。

### 最終固定ツリーの全体検証

コード変更を止めた状態でWorker全体を再実行し、191ファイル・1,235テストすべて成功（exit 0）。Webは77ファイル・713テストすべて成功（exit 0）。合計1,948テスト。型チェックとVite本番ビルドもそれぞれ単独コマンドでexit 0を確認した。先行実行で発生していた旧モジュールと新テストの混在は、この実行にはない。

## レコード契約と競合更新（2026-10-16）

- テーブル単位のOpenAPI 3.1、選択式strict検証、更新/削除のupdatedAt照合、Webのトークン送信と再読込を追加。
- コードを固定した全Worker実行: 191ファイル / 1,238テスト成功（exit 0、291.98秒）。Web: 77ファイル / 713テスト成功。型チェック単独実行とproduction buildもexit 0。既存の大きいチャンク警告あり。
- 全Worker実行の完了後、MCPのread_app/query_rows/add_row/update_rowに `rowVersions` を追加。既存のフラットな行形式を保持し、列名と競合しない別フィールドで更新トークンを返す。最終変更後はApps/MCP/Workflowsの3ファイル31テストを再実行し成功。全Worker一括の再実行はこの追加前。
- 追加テスト: stale PATCH/DELETE/MCP更新の拒否、同じスナップショットによる同時更新は一方のみ成功、更新時刻の単調増加、strict検証の実在日付・型・URL・選択肢・未知列・不正な入力形状、無効な部分更新の原子性、従来の値変換互換、契約取得の組織認可。
- 本番反映は未実施。契約バージョン固定、列定義変更との競合、参照整合性、ページング、Custom App公開基盤は未対応。

## 本番反映準備とページング（2026-10-16）

ユーザーから本番反映の指示を受領。mainの1.3.4更新を取り込み、PR #284でリリース検証を開始。Webの自動配布は同じコミットのWorker移行・デプロイ成功後に進むよう変更した。ローカルCLIのCloudflare認証およびgit push認証がなかったため、接続済みGitHub経由でソースを登録し、Git tree SHAの一致を確認した。

HTTP/MCPにoffset/limit、total/nextOffsetを追加。フィルタ・並べ替え後にページを切り、無効なJSON/列/ページ指定は400。オフセットは現時点のデータに対するもので、ページ間の編集を固定するスナップショットではない。Appビューは500件で切らずテーブル上限まで集計する。関連3ファイル33テスト成功。501件追加したAppで集計が増える回帰テストを含む。

## 本番公開完了（2026-10-16）

PR [#284](https://github.com/Torutesu/HonmaruAI/pull/284) をmainへマージ。公開コミットは `5ca1d2336fad155420c6157b54aac41aef094e82`、treeは `06bcab242110541217fcd3bec0975cc6acda363b`。Worker全191ファイル1,240テスト、Web全77ファイル713テスト、PR CIのE2E・Windows・iOS・Desktop・共有コード/モバイル・参照relayが成功。

- [Worker本番公開](https://github.com/Torutesu/HonmaruAI/actions/runs/38843394789): 再テスト、D1 schema/追加定義、Worker公開、health検証すべて成功。
- [Web本番公開](https://github.com/Torutesu/HonmaruAI/actions/runs/38843394874): 同じコミットのWorker成功を待って公開し、独自ドメインも検証成功。
- `https://app.honmaruai.com` と `https://honmaru-web.pages.dev` が `/assets/index-C6nZGYeY.js` を配信。APIホストを指定したローカル本番ビルドとも一致。旧ファイルは `/assets/index-CXdw59BZ.js`。
- 本番 `/health` はok、encryption.all=true。未認証のApps/Tables/Home/テーブル契約は401。公開ブラウザーで起動画面とサインイン画面を確認。
- ロック解除後、ログイン済みMacアプリを再読込し、本番のハーネス画面で「このブラウザではシンプル版を使う」チェックボックスの表示を確認。ホーム・アプリ一覧・ワークフロー一覧も読み込み完了し、正常な空状態を表示した。共有モードや設定の変更、レコード作成は行っていない。Simple切替の実クリック、データのある画面、全機能の本番E2Eを検証したという意味ではない。

100%同等には未達。比較表の未実装・一部実装・未検証は引き続き残る。今回、Kylonの最新作成画面でも初期非公開・既存ルームへのアクセスなし・作成後の実行方式変更不可を再確認した（エージェントは作成せず）。

## 新規Harnessエージェントの初期非公開（2026-10-16）

標準作成・Markdown取込で、クライアントのteam指定よりも作成者限定を優先。エージェントとprofileをD1 batchで原子的に保存し、旧profileなしエージェントに限るルーム配置互換処理へ入らないようにした。所有者は作成後に共有へ変更できる。既存エージェントの更新・Simpleワークスペースの作成動作は保持。ブラウザだけSimple表示にしても、共有ワークスペースがHarnessなら初期非公開を適用する。

初回の関連2ファイル41テスト成功。非所有者・管理者の一覧/直接profile/編集拒否、Simpleへの切替後の維持、所有者による明示共有を確認。全体実行でテスト追加位置の誤り（未定義変数）を検出して停止し、修正。ルーム配置例外の検証を新規作成テストに限定した最終コードで再検証する。Web全713テスト、型チェック単独実行、本番ビルド成功。Studioの外部teammate作成と全端末UIは未対応のためKY-011は一部実装。

最終のAgents/Harness Agents/Workflows 3ファイル53テスト成功。Homeの従来テストは作成時共有を前提としていたため、非公開状態の非表示を先に確認し、所有者が共有へ変更してから表示を検証するよう更新した。最終全体実行はPR CIで確認する。

最終コード固定後、Worker全191ファイル1,241テスト成功（exit 0）、Web全713テスト成功。日本語の実効アクセス表示修正後の型チェックと本番APIホスト指定ビルドも成功。PR [#285](https://github.com/Torutesu/HonmaruAI/pull/285) の全CI（Worker/Web/Relay/Desktop/Shared core and mobile/E2E/Windows/iOS）が成功。公開対象コミットは `ba8457344fbac097ab36a534bf6056817f18a8ee`、treeは `58992379022656ea08730adf705d11eb231e30c1`。

[Worker公開](https://github.com/Torutesu/HonmaruAI/actions/runs/38885271177) と [Web公開](https://github.com/Torutesu/HonmaruAI/actions/runs/38885271261) が順番に成功。独自ドメインとPagesドメインで `/assets/index-BBTj9qSU.js` を確認し、ローカル本番APIホスト指定ビルドとも一致。本番healthはok/encryption.all=true、未認証agents一覧は401。

ログイン済みMacアプリを再読込し、新規作成フォームで「自分だけ」選択済み・「チーム全員」無効を確認。保存せずキャンセルし、本番エージェントは作成していない。実データ作成・共有変更の本番操作まで検証したという意味ではない。

## スキルの非公開本文と実行時隔離（2026-10-16・未公開）

private/workspace・所有者の共有変更・version競合検知・作成とpolicyの原子保存を追加。HTTPの一覧/CRUD/agent付与一覧、実行時の直接会話、所有者membership、共有解除後の反映、旧共有スキルを検証。privateへのworkspace admin迂回はない。スキル一覧のagentリンクも閲覧可能なものだけに限定。

コード固定後のWorker全192ファイル1,245テスト、Web全713テスト、型チェックが成功。追加4テストは二つの表示モードでの非許可者/管理者の直接CRUD拒否、共有解除と競合、実行プロンプト隔離、membership剥奪、旧データ互換、作成時policy失敗のrollbackを含む。まだ本番未反映。


## Mac mini execution foundation (2026-10-16, not yet deployed)

The user authorized an existing-contract-only local Mac mini execution path.
Apple container 1.5.0 was installed under the user directory from its signed,
notarized installer payload. The actual VM smoke returned 42 as Linux UID 65534,
denied host-home access/root writes/outbound network, and stopped a runaway loop.
No test containers remained afterward. No production gateway credential was created.

Gateway HTTP tests pass (4): owner-only logs, administrator registration, hashed
credentials, exclusive claims, idempotent submissions, wrong-node/replay refusal,
cancellation/revocation, expiration without a connected node and membership removal.
Portable local runner/client tests pass (4). Web TypeScript, all 713 tests and
production build pass. Frozen full Worker suite: 193 files / 1,249 tests pass (295.81 seconds).
See [operator instructions and remaining limitations](../mac-mini-gateway.md).
KY-023 becomes partial; KY-022 remains missing because an offline local JavaScript
VM is not a complete cloud computer with files/network/agent tools.

Additional real-VM checks: AbortSignal cancellation and output overflow both stopped
the workload, bounded output, and left no containers running. Gateway screen state
(including a one-time token) is remounted on workspace/session changes.

The real-VM startup-cancel and lease-loss checks also passed: refusal of a heartbeat
stopped the workload and suppressed result submission. No containers remained.
A final audit found that two-second node polling could exhaust the existing team
quota. Polling is now every five seconds, with separate edge/per-node buckets.
The new regression test verifies human/node and node/node quota isolation and limits.


## PR 287 production rollout (2026-10-16)

- PR: https://github.com/Torutesu/HonmaruAI/pull/287
- Merge: `9637e58f7038c95ad51c00d9058266b284f06b94`.
- Final tree: `002cef7bbe2616d32e89844f7654c16355b736b7` (local/uploaded match).
- PR CI: all nine jobs passed, including Worker 193 files / 1,250 tests,
  Windows Edge, iOS, E2E and the portable gateway tests.
- Worker deployment: https://github.com/Torutesu/HonmaruAI/actions/runs/38893095555 (success).
- Web deployment: https://github.com/Torutesu/HonmaruAI/actions/runs/38893095395 (success).
- Both public web origins serve `/assets/index-BOvdznfG.js`, matching the local production build.
- Public API health: ok; encryption.all true. Unauthenticated gateway list and node claim both return 401.
- Authenticated desktop UI: the Harness hub preserves the Simple-only preference and now opens
  Execution nodes. The registration form, offline-JavaScript restrictions, input editor and
  requester history render without an API error. No production credential/node/job has been created.
- An existing desktop session referenced a removed lazy Profile chunk after an earlier deployment;
  restarting the app recovered its authenticated state. This cache/reload experience remains follow-up work.
- Main CI's E2E job alone timed out waiting for an existing group-unread marker. The same code passed
  E2E on both branch and PR runs. Only this failed job was rerun; job 116952265995 succeeded. The same timeout is present
  in pre-change main job 116926221866, so this remains a known intermittent read-state issue.

The registration action is prepared but awaits action-time confirmation required by the computer-use
policy for creating new security-sensitive access. Mac mini runtime smoke is complete; production
control-plane-to-node execution has not yet been tested. Kylon parity remains incomplete.

## Production Mac mini connection — 2026-10-16

User explicitly approved node registration, local token storage and connection. Registered Mac mini in Select using the authenticated production UI. Token saved outside Git with directory 0700/file 0600; token hidden immediately afterward. Started gateway against the deployed Worker. UI showed latest connection and a successful job at 20:54 JST: `return input * 2` with input `21` returned `42`. Runtime list was empty after completion. Screenshot: `/tmp/honmaru-mac-mini-connected.png`. This verifies the production control plane → local VM → production result path. Gateway remains a local process, without reboot autostart; full Kylon parity and hosted service readiness remain incomplete.

## Login autostart and Harness layout — 2026-10-17

Installed an owner-only standalone gateway snapshot and `com.honmaru.gateway` LaunchAgent outside the repository. Verified process-crash restart and Apple container runtime recovery. The runtime status command can exit successfully while stopped; the service now checks the reported running state before claiming jobs. Eight gateway tests and the real VM isolation/timeout smoke passed. This starts after user login/FileVault unlock; physical reboot and sleep/wake have not been exercised.

PR #288 adds personal-DM-only execution tools and explicit MCP execute scope. All CI jobs passed on `177b1e38c0579ba2042e9572a5527a44198dbea6`; merged as `90985de8c65cbb6b08ff7bf1539be7b578cfbc70`. Production deployment succeeded (run 38926623954). At 00:59 JST, the private Mac実行アシスタント conversation requested `return input * 2` with input 21. The agent returned 42 and execution ID `89627f7a-7b10-4a7f-bbab-d61b60d09c27`; the execution history independently showed `succeeded` at 00:59:24 with `{"value":42}`. Screenshots: `/tmp/honmaru-agent-mac-production.png` and `/tmp/honmaru-mac-agent-execution-history.png`.

PR #289 changes Harness-only navigation, conversation filters/header, member list/detail and profile/persona cards using the authenticated Kylon desktop UI as a reference. Local fixture checks cover profile edit, Skills and Files navigation. Web 713 tests, TypeScript and build pass. The fixture contains synthetic data and is not production evidence. Simple keeps the original navigation and scoped styling. Full visual/functional parity is still incomplete.

UI PR #289 merged as `1a942e1408f9601e83270b5df568ba7c47c74778`; Deploy Web run 38928004094 succeeded. The production domain serves `index-0esrv_5x.js`. Verified new rail, member list, profile/persona and Message → private chat in the authenticated desktop app. Local Simple fixture retains the old appearance. Follow-up localization corrects labels observed in production.

## Room resource UI — 2026-10-17

Compared authenticated Kylon room Apps and Automations panels: 360px rounded right panel, count/close header, centered empty state, and a creation button that prepares an unsent chat prompt. Implemented equivalent Harness room panels plus existing editor/management links. Scope workflows by matching room steps or the room's app tables; workspace/viewer changes reset the panel. Existing room schedules remain accessible. Simple navigation and styles are unchanged.

PR #292 merged as `c21fafc0bca76e41948c7a91ea9b89a8c9f49e56`; Deploy Web 38930823962 succeeded and app.honmaruai.com served `index-v5kndd_-.js`. Web 713 tests, TypeScript and build passed. Authenticated desktop verified both empty panels and the workflow editor. Screenshots: `/tmp/honmaru-apps-room-production.png`, `/tmp/honmaru-workflows-room-production.png`. No paid services or subscriptions added.

This verifies navigation/layout, not full parity: populated Kylon app/workflow detail states were unavailable in the observed room, and arbitrary natural-language creation is not proven end-to-end. Dedicated existing generation/template/workflow editors remain available.

## 2026-10-17 — natural-language resource creation and app details

- Observed Kylon on a real empty `UI確認用タスク` app: creation asks for confirmation; app opens beside its conversation in a pale-green frame, with overview/data viewer/customization/sharing controls. The test app contains zero records and no paid integration.
- Room Apps/Automations creation now selects an explicit composer mode. Sending the description calls the persisted resource API and opens the resulting app/workflow; it no longer only prefills a prompt. Failures retain the draft; duplicate clicks are locked during generation.
- Workflow generation uses the existing workspace AI provider and allowance. It validates step types, schedule ranges and the requester's access to referenced rooms/tables/agents, and persists disabled with no next-run timestamp. Model unavailability/errors are visible; no invented generic automation substitutes for the request.
- App generation resolves room views to canonical conversation keys. Apps created in private conversations start private. Room listings resolve the same keys.
- App details remain beside chat on wide screens and offer overview, data viewer, record search/editing, fields, sharing and versions. Existing Simple presentation/code remains available; no new service/subscription introduced.
- Local verification: TypeScript, production build, 713 frontend tests; targeted Worker apps/workflows suite 34 tests; browser fixture checked room list → detail → data viewer and natural-language send → saved app detail.
- Limits: this is not a claim of complete Kylon parity. App generation currently produces structured table/board/calendar/metrics apps, not arbitrary bespoke application source. Room creation uses an explicit mode; ordinary unrelated chat is not intercepted. Kylon's richer filtering/grouping/custom-code editor remain separate gaps.

Production verification for the generation release (PRs #294–295):

- Worker deploy `38993071418` and Web deploys `38993071427`, `38993634676` succeeded. Worker release commit: `f7d87b6f7ee0d254ccbf8029549e7bb113d460b6`; UI polish: `9af941d2206f492be93fa051c6776a0d5879b155`.
- In Select → private Mac実行アシスタント chat, a Japanese description created `UI確認用タスク` with exactly タスク名/担当者/期限/状態, zero initial records, and table/board/calendar views. Reload retained the generated definition. Sharing showed 自分だけ.
- A Japanese description created `本番確認フロー`, a manual workflow containing one post to the same private chat. It initially showed paused, Run disabled, and no history. After explicit activation and one manual run, production history showed 完了 / ルームに投稿 — OK at 2026-10-17 11:18:58 JST and the exact requested message appeared in the private chat. Returned the workflow to off after the test.
- Full local Worker suite: 193 files / 1,254 tests passed, followed by the additional private-DM generation test (16 workflow tests passed). Production deployment's full test gate passed with the extra test included.
- Private conversation identifiers are displayed as readable private-chat labels in the follow-up UI polish.

## Custom app releases and appearance (2026-10-17)

Custom HTML/CSS/JavaScript can be generated from a prompt using the existing AI allowance, edited, previewed, saved as a draft and explicitly published. The overview runs the published source; changing a draft does not change it. Owner/admin permission, optimistic version checks and audit events apply to release writes. Prior source can be restored to a draft and reviewed before publication. Generic app edits cannot inject executable source.

The runner is served by the existing Worker, with no new hosting contract. Two opaque-origin sandboxes, restrictive response CSP and a source-checked message bridge expose a snapshot of the current app's table. Preview rejects writes. Published apps may request create/update/delete on that same table, with an explicit host-side confirmation for each change and existing server validation/row CAS. No session token, remote script, external connection, host filesystem, arbitrary table lookup or automatic mutation tool is supplied. Server-side JavaScript execution remains a separate Mac gateway capability, not an implied capability of generated UI. Company Harness boundaries are workspace → resource ACL → release authority → scoped capability → audit; write requests cannot select another table and do not execute before a person confirms the exact values outside the generated frame.

Harness colors now follow the existing system/light/dark preference, including chat, app details, workflows, menus and inputs. Simple mode remains available and its selectors are unchanged.

Remaining parity: unattended app writes and external integrations, multi-entity schema migration and preview database forks, code-generated server actions and full Kylon editing behavior are not complete. This release must not be described as 100% parity.

Validation for the custom-app release: all 193 Worker test files / 1,258 tests and 78 web test files / 716 tests pass. Desktop CSP coverage passes all 68 tests. Browser verification confirmed scoped reads and blocked external fetch/navigation in nested frames. Production Worker deployment 38995504158 and web deployment 38996431515 succeeded; the dedicated runner responds with its restrictive CSP. The production app “UI確認用タスク” generated a Japanese task dashboard and saved it as version 2 without changing records. Desktop 1.3.4's additional CSP blocked its frame, so 1.3.5 permits only the runner path and was signed/notarized by successful workflow 38996816514. The downloaded universal ZIP matched SHA-256 1f058dc029b59ee34c799ecb7f756ef620eb3c7215e56159e440283a926dcc79; codesign and spctl accepted the installed build. On Mac 1.3.5, the real generated dashboard rendered in preview, was published as version 3, survived reload, and displayed correctly in both light and dark themes. No records were changed. The original System appearance preference was restored. Release https://github.com/Torutesu/HonmaruAI/releases/tag/v1.3.5 is published as Latest. Final web contrast deployment 38996992862 succeeded. Production screenshots: /tmp/honmaru-custom-app-production-dark.png and /tmp/honmaru-custom-app-production-light.png.


## Company app runtime extension (2026-10-17)

The app detail has an execution infrastructure panel for server actions, databases and personal connections. Actions are generated using the existing allowance, reviewed as drafts, explicitly published at a fixed revision and executed on an existing Mac gateway. App/caller-scoped job links are created atomically with the queue entry; claims, completion and reads recheck app access. The own-agent DM and MCP execution tools can discover and execute published app actions. MCP invocation requires the execute scope. No new execution service or contract is introduced.

Additional entities inherit the parent app ACL on the existing table API. Additive schema plans support create_entity and add_columns only; migration IDs, content checksums and database revisions make replay safe and reject conflicts or changed plans. The journal and schema updates commit together. Once a schema is managed by migrations, generic app/table edits cannot bypass it. A transactionally read private DB snapshot supports strict, revision-checked writes without mutating production; the custom primary-table preview uses that snapshot when present. Fork size is bounded, and forks are never automatically merged into production.

Connections are personal and app-scoped, with exact HTTPS endpoint/method grants. Credentials are context-bound and encrypted with the existing data key, never returned to generated code or discovery. Supported API hosts: api.github.com, api.notion.com, slack.com, www.googleapis.com, sheets.googleapis.com, api.open-meteo.com. Write paths are restricted to supported business resource APIs. The generated frame requests host approval showing the exact URL/method/body or the published action code/input. No arbitrary URL, credential, or code substitution is accepted from the frame. Outbound redirects are refused; response bodies are bounded to 200KB and requests to 15 seconds. External writes record their request ID before sending, refuse duplicates, and retain an unknown state on ambiguous failures rather than automatically retrying.

This does not claim 100% Kylon parity. Remaining capabilities include relational constraints, destructive/data-transforming migrations, preview-to-production data merge, arbitrary-host/MCP connectors, OAuth refresh and organization-shared connection grants, distributed workflow checkpoints and the other open acceptance criteria in matrix.md. Local and production acceptance results are recorded below after verification.

Acceptance evidence for Company runtime (PRs #305–309):

- Worker deployment `39001133466` succeeded with all 194 files / 1,268 tests passing. Web deployment `39002572210` succeeded; the final local web suite passed 78 files / 719 tests, TypeScript and production build. The runner URL carries `?v=2` to invalidate the prior five-minute SDK cache.
- In the authenticated Mac 1.3.5 app, Select → Mac実行アシスタント → UI確認用タスク → 実行基盤, natural-language server generation returned `add_numbers`. The model returned a full function rather than its body. PR #309 strengthens the prompt and adapts a complete named function into an awaited sandbox invocation; the regression is covered by the 10-test Company integration suite.
- The reviewed addition function was saved and published as action version 2. After selecting the existing Mac mini node, production input {"a":20,"b":22} completed as succeeded with stdout "42", stderr empty and exitCode 0. An earlier empty input failed validation as expected. Screenshot: /tmp/honmaru-company-action-production.png. The selector required foreground native interaction; the node was present and online.
- A personal, app-scoped, unauthenticated GET connection to the public HonmaruAI GitHub repository saved successfully. Its request returned an upstream HTTP 403, so live external connectivity is not recorded as passing. No external write, message, credential registration, or new paid contract was performed.
- Gateway service `com.honmaru.gateway` was running. All 8 gateway tests passed. Actual local VM smoke checks passed: addition returned 42 under non-root Linux; host home absent, root filesystem read-only, outbound network unavailable, and runaway execution terminated. These are local isolation checks, not proof of the new production app-action path.
- Native screen capture intermittently failed but recovered. The production UI generated and applied migration_1792211951362, adding a customers entity (name/text, email/email), with schema v1 and a journal entry. A private fork received one test record while the production data viewer and published dashboard still showed zero records. After restarting the native shell, the published dashboard rendered through custom-app-runner?v=2. No production business records were changed. Simple mode remains in the source and no new subscription was added.
- A second unauthenticated, personal GET connection (public_weather) successfully returned Open-Meteo JSON in production. Evidence screenshots: /tmp/honmaru-company-connection-production.png and /tmp/honmaru-company-database-production.png. GitHub-specific authentication/rate-limit behavior is still not accepted as passing.

- The own-agent DM requested the published action using the app tools and reported result 42, execution ID `8f54a293-fea9-4486-8c0b-4ecc3b953b4d`. The independent execution-node history confirmed the new succeeded job at 13:44:05 JST, distinct from the direct UI job at 13:43:18.
- PRs #310–311 address two observed preview startup issues: a missed cached-frame ready event and a first read occurring before the private fork finishes loading. Frame initialization now has an idempotent load fallback; preview mounting waits for the private snapshot. Focused regression suite: 8 tests passed; TypeScript passed. PR #310 deployment `39003822342` passed all 78 web files / 720 tests.
- Final Web deployment `39003996419` succeeded with 78 files / 721 tests. On the restarted native app, the public dashboard showed zero records, while the private preview loaded its one test record and showed 総件数: 1 / 未着手: 1. Screenshot: /tmp/honmaru-company-private-preview-production.png. This confirms the private-first startup fix on the actual desktop shell.
- Final Worker deployment `39003111482` (commit 14466ba6488595537f7cd10db4aa08b4f4a3e3f3, generator normalization) completed successfully, including the full test gate, D1 migrations, deploy and verification. Existing-column duplicate notices were handled by the established idempotent migration script. The production endpoints and web release are deployed; the explicit parity gaps above remain open.

## 2026-10-17 — app library, SVG icons and reviewed database merges

- Compared logged-in Kylon native app list and data viewer: 52px rail, compact outlined icons, search, pale green framed app cards, restrained detail toolbar and white data surface.
- Harness now opens Apps directly from the rail, uses SVG compose/members/apps/integration/app symbols, provides app search and compact framed cards. Simple mode remains independently styled.
- Local browser visual checks: light and dark library/detail; search no-results state; corrected preview frame stretching after visual inspection. Fixture contained synthetic data only and was removed after verification.
- Web: 79 files / 724 tests pass; TypeScript and production build pass. Worker: 194 files / 1,272 tests pass.
- Database forks now retain an immutable baseline and offer explicit three-way merge review. Atomic D1 receipt guards reject concurrent production or fork changes, including a transaction-time race test. Applied forks are sealed; retry is idempotent. Secondary entities are available to the private preview SDK.
- Limits: 50 changed rows per merge, no schema merge, no selective conflict resolution, older forks need recreation. Row workflows are not automatically triggered by a merge. These are documented gaps, not 100% parity.
- PR #313 includes initial UI and merge functionality. Production acceptance is recorded separately after deployment completes.

### Production acceptance (2026-10-17, 17:40 JST)

- Worker deploy run `39016758769`: success (test gate, D1 migration, deployment and verification).
- Web runs `39016758752`, `39017245462` and final label correction `39018106879`: success.
- Final application code on main: `a37da78a77b3711baf81c6b74070c4d9019d68d9` (PRs #313–315).
- Native Honmaru in Select: direct Apps rail navigation, new searchable framed cards, app detail and compact data toolbar confirmed on production. Agent/DM metadata now reads “プライベートチャット” instead of internal channel identifiers.
- Existing app remains at zero production records; its prior private preview record remains intact. The new merge-preview endpoint correctly rejects the legacy fork without a merge baseline. Successful merge and race paths were tested in isolated Worker tests, not by overwriting this existing production preview.
- Production dark screenshots: `/tmp/honmaru-ui-apps-dark-production.png` and `/tmp/honmaru-ui-data-dark-production.png`. Light and dark layout inspection completed locally; production light-theme switching was not conclusively verified.

### Live previews and detail menus (2026-10-17, 18:00 JST)

- PRs #317 and #318 deployed successfully: Web runs `39019025699` and `39019085661`. Final application revision `40254b8562fab73d597e13d1de85554595971eca`.
- App cards render the authorized published HTML or actual table data. Viewport observation bounds active previews; custom thumbnails have no mutation, server-action or external-connection API capability.
- Detail menus provide copy link, browser-local pin/unpin and navigation to app/data/execution/settings. Links include validated app/workspace IDs; workspace switching checks membership. Pin preferences store only IDs and resolve names through the authorized app list.
- Native production acceptance: published app (0 production records), detail menu, data viewer, pin/unpin and workspace-aware detail URL confirmed. Verification pin was removed afterward. Dark and light actual thumbnails visually confirmed. Capture initially failed but succeeded after raising the native window.
- Screenshots: `/tmp/honmaru-live-app-card-production.png`, `/tmp/honmaru-live-app-card-light-production.png`, `/tmp/honmaru-live-detail-menu-production.png`.
- Web: 81 files / 729 tests pass; TypeScript and production build pass. No backend or paid service changes; Simple remains available.
- Not 100% parity: pins are browser-local, custom thumbnail secondary entities are not loaded, and the complete Kylon filter/group/view editing UI remains a gap. Broader connector/workflow/database limitations above still apply.

### Saved filters, grouping and synchronized pins (2026-10-17)

- Kylon native reference: Filter/Group open a 320px summary popover with “なし” and an adjustment action. Kylon's adjustment opens its app conversation with a draft. Honmaru retains the compact summary and provides direct structured editing without paid model calls.
- Web validation: 83 files / 732 tests pass. Focus/30-second pin refresh, account-scope changes, editor save/rejection and draft retention are covered. TypeScript and production build pass; local light/dark editor rendering and selected-value save checked in a browser.
- Worker validation: full local suite 194 files / 1,275 tests pass; the expanded focused suite passes 27 tests, including two subsequently added revoked-access/persistence cases. Distinct authenticated sessions share the same user's pins while another user's list stays empty. Guest/nonmember/unknown-app/invalid payload paths are rejected; stale view edits return 409.
- PR #319 implements server storage, shared filters/grouping and guarded view saves. #320 improves synchronized feedback and input validation. #321 bounds overflow and documents semantics. No new services, dependencies or paid model calls; Simple mode remains available.
- Synchronization is eventual: refresh when returning to a visible client and every 30 seconds while visible. This is not a claim of physical two-device acceptance. Browser-only legacy IDs remain locally intact but are not automatically imported across accounts.
- Limits: filters are AND-combined, one grouping column per table/board, shared creator/admin view editor. Column order/width, personal views and complete product parity remain open.

#### Production acceptance (2026-10-17, 18:38 JST)

- Worker run `39020514730`: success, including all **194 files / 1,277 tests**, schema/column migrations and deployment verification. Web run `39020514713` and final Web run `39021051852`: success. Final application revision: `1a7db882048626a67c4755c6fa47835c91febabd`.
- Native production UI in Select: pinned UI確認用タスク; saved a table filter `状態 = 未着手`; saved grouping by 状態. The summary displayed the saved condition and the table displayed 未着手 / 進行中 / 完了 group headings with zero records.
- Quit and relaunched Honmaru. The server-backed pin returned in navigation; opening it and the data viewer restored both the filter badge and the three group headings. No browser-only pin cache is written by the new implementation.
- Cleanup through the UI: removed the verification filter and saved, selected グループ化なし and saved, unpinned the verification app. Filter badge, group headings and pinned navigation disappeared as expected. Production records remained zero; existing custom HTML still rendered. Existing private database forks were not modified.
- Screenshot during acceptance: `/tmp/honmaru-saved-filter-group-production.png`. Local light/dark editor checks and production dark review completed. Physical two-device verification was not performed; independent-session synchronization and isolation were exercised by server integration tests.

## Personal views / column layout — 2026-10-17

Kylon native UI inspected: field popover with reorder grips, new-view action drafting a chat request. Draft cleared without sending or billing. Honmaru offers direct personal-view creation/rename without an AI call, separate shared/personal filters, column reorder via drag or arrow buttons, 80–600px widths via number input or header drag/keyboard. Local actual AppView verified: owner column moved first, task width 320px, personal clone selected with the same layout.

Focused server coverage: second authenticated session restores preferences; another user sees none; stale writes get 409; guest/outside member denied; revoked app ACL denies read/write; shared version unchanged. React coverage keeps layout drafts after a rejected save. Production verified below. Full Kylon parity is not asserted; column visibility and complete menu equivalence remain outside this increment.

Additional checks: 375×812 dark-theme toolbar exposed a left-clipped field popover after wrapping. Narrow-screen positioning was fixed and visually rechecked with all labels and Save visible. Final web suite: 85 files / 734 tests. Local full Worker suite: 194 files / 1,278 tests, plus focused 29-test run including the subsequently added ACL-revocation case. Session-switch load guards prevent stale personal UI from surviving a client/account change.

The broader CI Shared core/mobile job fails before its tests because repository VERSION is 1.3.4 while desktop package manifests are 1.3.5. Both values predate these changes (local baseline 5a48281e); no version manifest was changed here. This is separate from the Web and Worker deploy gates and must not be reported as a fully green repository CI.

Production acceptance: Worker run 39028509104 succeeded with all 194 files / 1,279 tests, schema migration, deploy and verification. Web runs 39028509151, 39029135643 and 39029967693 succeeded. In Select / UI確認用タスク, created the personal view 自分のタスク, moved 担当者 before タスク名 and saved the latter at 320px. Quit and relaunched Honmaru; opening the data viewer restored the selected personal view, reordered header and 320px width. The field popover shows the persisted values. Native light/dark verified; restored the original System theme. Production records remain zero, shared views and pin unchanged. Personal view intentionally remains available to its creator. Screenshot: /tmp/honmaru-personal-view-production.png. Independent physical-device testing is not claimed.

Native numeric entry exposed misleading disabled Save when a cleared value was displayed as 180px; fixed by showing invalid values and a range hint. The final native screen confirmed the hint with a 32px draft; no invalid value was persisted. Escape propagation from the personal popover also needed containment so it closes the menu without navigating away. A stale lazy chunk during live rollout resolved on reload; this does not establish seamless hot-upgrade support.

## Column visibility and version alignment (2026-10-17)

Personal layouts now store hidden column IDs alongside order and widths. The first/title field remains visible, including when a malformed client tries to hide it. Hidden columns retain their position and width when revealed; header resizing preserves the full layout. Group headers span only visible columns. Eye/eye-off buttons expose their state and a disabled title-field explanation. Shared definitions and Simple mode are unchanged.

Local verification: web 85 files / 734 tests; Worker app suite 29 tests including same-user session restoration, isolation, stale revision rejection, hidden-ID normalization and reveal preserving layout; web typecheck/build; version consistency at 1.3.5. Version checks now also cover lockfile root/workspace entries. Kylon native field menu inspected directly: title always visible, other fields have eye controls. Production acceptance is recorded after deployment.

Release: PR #328, main `01969cc112b432215ef3b9aae339526f629bc6a9`. CI run 39031579073: Worker 194 files / 1279 tests, web 85 / 734, core 6 / 41, mobile typechecks and iOS/Android export, E2E, gateway, relay, desktop all passed (native iOS/Windows jobs skipped on this push). Mobile ESLint also passed locally after declaring the CommonJS config environment. Deploy Worker 39031579051 and Deploy Web 39031579049 succeeded. Worker version `3e03cfb7-ac7a-400a-9c31-d9cd082014e3`; production web HTTP 200 and health `ok:true` verified.

Visual validation: local real browser with a fixture row, hide owner → resize title → reload → reveal owner; title stayed 190px and owner returned in its original position. Light 375×812 and dark desktop menus inspected. Fixtures and browser viewport override removed. Native production acceptance completed after the Mac became available: in the existing personal view 自分のタスク, hid 担当者, saved, fully quit and relaunched the native app, reopened the data viewer, and confirmed the selected personal view, hidden owner column and title width 320px restored. The title visibility control remained disabled. Revealed 担当者 and saved again; its original first position and 180px width returned. Production records remained at zero. Screenshot evidence: /tmp/honmaru-column-visibility-restored.png. The initial in-place reload briefly showed a blank window; a full app restart loaded the published version successfully.

## System columns (2026-10-18)

ID / 作成日時 / 更新日時 are read-only display columns sourced from row metadata, never schema fields or editable values. Reserved IDs `$row.id`, `$row.createdAt`, `$row.updatedAt` cannot collide with generated user-column IDs. New and older layouts hide them by default; explicit layouts can show, reorder and resize them. Reset hides the three metadata fields again. Existing user columns and title visibility are preserved. Backend normalization accepts only these reserved IDs plus current schema columns. No schema migration or new service is required; Simple mode is unchanged.

Kylon native field menu inspected: the three metadata fields are hidden initially and the eye control reveals ID in the table. Reference setting restored afterward. Local web typecheck/build and Worker app suite (29 tests) passed, including old-layout normalization and same-user session persistence. Production visual acceptance follows deployment.

Release acceptance: PR #427 merged as `8ca6490dd2591fd9002e7a5ca28ea097f902c6c3`. CI 39094639159 passed all applicable jobs (native iOS/Windows jobs skipped); web 86 files / 738 tests, Worker 194 files / 1279 tests. Deploy Worker 39094639194 and Deploy Web 39094639169 succeeded. Worker version `8e9ee18d-a9a6-4050-9bbe-109acbb843f6`.

Real local browser: fixture row displayed actual row ID and distinct created/updated timestamps as non-editable text. Showing all three, reload, ID width 190px and reorder, reset-to-hidden, dark desktop and light 375×812 layout verified. Temporary fixtures and viewport override removed.

Native production Mac: existing 自分のタスク initially retained four visible user columns, original order and title width 320px; all system fields were hidden. Enabled the three fields, saved, completely quit/relaunched Honmaru, reopened the data viewer, and verified all three system headers and selected personal view restored. Captured `/tmp/honmaru-system-columns-production.png`. Restored all three to hidden afterward, preserving user column order/width and zero production records. No new charges/services, schema changes or Simple-mode changes. System-field values were checked using local fixture data; the production app intentionally remained empty. This completes system-column display acceptance, not a claim of complete Kylon product parity.

## System-column sorting and filtering (2026-10-18)

System metadata is now accepted for view sort/filter references and evaluated from row metadata, never editable values. Shared and personal view definitions persist these queries; schema-only grouping, calendar and numeric metric fields remain separate. Timestamp sorts compare instants, not offset-bearing strings; missing timestamps sort last. Timestamp filters compare at the second precision shown in the UI, so server milliseconds do not make equality impossible. Invalid timestamp comparisons match no records. ID filters support the existing text operators.

Kylon native header verified to cycle ascending → descending → cleared; reference restored. Honmaru headers use the same cycle and SVG direction indicators, with aria-sort and edit-permission/busy handling. Date filter controls use datetime-local with seconds, serialize to UTC, and display local time on reopening. Initial local validation: web 86 files / 740 tests, Worker app suite 32 tests, typecheck and production build passed. Coverage includes offset chronology, null dates, metadata spoofing, multiple conditions, per-user persistence and shared-definition isolation. Production acceptance follows deployment.

Real local browser verification used the actual AppView and worker computeView with three fixture rows. Created timestamps included mixed UTC offsets and missing values. Header clicks produced chronological ascending/descending order with missing timestamps last; reload retained descending state. A local-time cutoff at 2026-10-18 10:30 selected the expected row, persisted across reload, and reopened with the same local-time summary. Combining it with an ID equality condition retained the expected row. The 375×812 dark editor showed both conditions, datetime input and Save within the viewport. Temporary fixtures, development server and viewport override were removed.

Production acceptance: PR #429 merged as `a47029911c8f21433acc8ec1715e969c6f78961d`. CI 39097853718 passed all applicable jobs (native iOS/Windows jobs skipped). Worker: 194 files / 1,282 tests; web: 86 files / 740 tests. Deploy Worker 39097853720 and Deploy Web 39097853745 succeeded; Worker version `6249f5a2-5ad1-41cf-9971-9afa8d1d6d6e`. Production web returned HTTP 200 and API health reported `ok:true`.

Native production acceptance in Select / UI確認用タスク / 自分のタスク: enabled the three system fields; saved ID ascending, createdAt ascending, then updatedAt ascending and descending. Saved three combined filters: ID contains `row_`, createdAt before local `2026-10-18 13:55:56`, updatedAt not empty. The native datetime picker successfully supplied a second-precision value. Fully quit/relaunched Honmaru, reopened the data viewer and confirmed the selected personal view, updatedAt descending arrow and all three filter summaries restored. Screenshot: `/tmp/honmaru-system-query-production.png`.

Cleanup: removed the verification filters, exercised sort clearing, restored the original title ascending sort and hid all three system columns. User column order (owner, title, deadline, status), title width 320px, other widths and original theme remained unchanged. Production records stayed zero; no records, private database forks or custom-app content were changed. New charges/services and Simple-mode changes: none. Real row ordering/filter results were verified with local fixture data and server tests; physical cross-device testing and full Kylon product parity are not claimed.

## Data-viewer interaction gaps (2026-10-18)

Native Kylon inspected without creating records or sending agent messages: the new-record button opens a centered form with all fields, cancel/create actions, and a member selector; the data-viewer overflow menu offers text wrapping. The view-create plus sits beside view tabs, refresh beside the breadcrumb, with fullscreen and close controls at the panel edge. Reference returned to its original empty viewer.

Honmaru now opens a typed record form before calling the existing strict-validation create API. Cancel writes nothing; failures retain the draft; pending submission prevents duplicate clicks and dismissal. Person fields use current workspace member names when available and preserve unknown legacy values in the inline editor. Text wrapping is a per-user, per-view layout preference, preserved through width/visibility edits and view cloning. The overflow check state only changes after saving. Added panel fullscreen/exit, relocated the view-create plus and refresh, and reduced toolbar button backgrounds. Simple mode and existing records are unchanged; no new services or schema migration.

Local real browser: cancel retained one fixture row, successful typed creation produced two rows with title/newline, owner and status intact. Wrapping retained newlines and expanded row heights after reload. Member names rendered in inline selectors. Fullscreen and Escape exit worked. Light desktop and dark 375×812 new-record dialogs inspected with all controls inside the viewport. Initial web suite: 88 files / 743 tests; worker app suite: 32 tests including independent-session layout restoration; typecheck and build pass. Production acceptance follows deployment. These close specific observed gaps, not complete Kylon product parity (agent-request controls, record conversations and other matrix items remain).

Production acceptance: PR #431 merged as `523dc1b283ac175ca3419cdc3d91485d83812fc5`. CI 39099579357 passed all applicable jobs (native iOS/Windows jobs skipped). Web: 88 files / 743 tests; Worker: 194 files / 1,282 tests. Deploy Worker 39099579364 and Deploy Web 39099579387 succeeded; Worker version `89ad4f78-629f-45fa-97f8-46cfb8f44423`. Public web HTTP 200 and health `ok:true` verified.

Native production Mac: new-record dialog showed all four fields and the workspace member selector. Entered a verification title and cancelled; record count stayed zero. Fullscreen hid the rail and Escape restored normal presentation. Enabled text wrapping for 自分のタスク, fully quit/relaunched Honmaru and reopened the data viewer: same personal view, original column order/320px title width/title ascending sort, and wrapping checked. Screenshots: `/tmp/honmaru-record-dialog-production.png`, `/tmp/honmaru-wrap-restored-production.png`. Disabled wrapping afterward to restore the original preference. No production records or private database forks were changed. Temporary screen-capture failure recovered before acceptance; no remaining screen-access blocker.

Additional reference audit: Kylon's empty room automation setup action populates a chat draft. The draft was cleared without sending, creating an automation or incurring a new charge. Execution-history screens could not be compared against existing reference data. App/record conversations and agent-request actions remain distinct gaps; this release does not establish 100% UI or product equivalence.


## 2026-10-18 — レコード詳細の編集導線

- Kylon実画面でアプリチャットを開き、アプリ作成元の既存スレッドを表示することと「現在のデータ表示」の文脈表示を確認。メッセージは送信していない。この固定会話は本差分では未実装。
- Honmaruのテーブルに詳細を開くアイコン、ボード／カレンダーのタイトルに詳細操作を追加。詳細では非表示列も含む全フィールドと読み取り専用のID・作成日時・更新日時を表示。
- 新規作成と編集で入力UIを共用。編集は変更したフィールドだけを送信し、空欄はnullで明示的に消去。所属していない旧担当者の値も選択肢に残し、無関係な変更で消さない。
- 開いた時点のupdatedAtを既存updateRow APIに渡す。競合や失敗でダイアログを閉じず入力を保持。ワークスペース/API変更時には編集中のレコードをクリアする。
- ローカルの実AppViewとメモリー内APIを使って、表→詳細→キャンセルで未変更、タイトル変更と数値の空欄保存、ボードからの再表示をブラウザで確認。ダーク画面と375×812のライト画面で表示を確認。検証fixtureは出荷しない。
- シンプル版の経路・課金・外部サービス設定・DBスキーマは変更なし。Kylonのレコード詳細そのものは参照データが空のため未比較であり、100%の外観一致とは扱わない。
- 本番反映: PR #433、commit `4952daea62d4ce80fcdf99b87522a4e686003d95`。Deploy Web `39101468115` 成功。`app.honmaruai.com` が新しい `index-yjSDTaKD.js` を配信し、詳細UIのコードを含むことを確認。
- 本番Mac再起動後、個人ビュー「自分のタスク」、列順、タスク名幅320、既存ソートが復元。共用の新規レコードフォームで担当者選択・日付・状態を表示し、キャンセル後0件を確認。既存アプリが空なので、本番での既存行の編集確認は未実施（ローカルで検証済み）。
- Webテスト88ファイル745件、型チェック、ビルド、Deploy Web内テストが成功。Workerコードの変更／再デプロイはない。


## 2026-10-18 — アプリ・レコード固定会話

- 前回CI `39101468062` はWorker・E2Eを含め成功。Windows/iOSのネイティブジョブはpush時の仕様によりskip。
- アプリヘッダーの会話アイコンで左にチャット、右にデータを表示。Kylon実画面の左右配置、データ表示文脈、入力欄の配置を参照。レコード詳細には独立したチャットを併設。
- `GET/POST /apps/:id/conversation` はアプリまたはtableId/rowIdの固定スコープを使う。読取だけではレコードを作らず、送信に限り既存D1へ保存。アプリとentity/recordが同じなら同じthreadIdになる。
- 毎回非ゲスト所属・現在のアプリACL・テーブル所属・レコード存在を検証。ルームリンクから権限を広げない。送信IDの一意制約で二重投稿を防ぎ、同じIDで本文が違う再送は409。最新50件とカーソルによる過去履歴、表示中10秒ごとの取得を提供。
- UIの送信失敗で下書きと送信IDを保持。会話切替後の古い応答を破棄し、取得失敗時は表示履歴を消す。メッセージはプレーンテキストとして描画。表示末尾の追従と過去履歴のスクロール位置保持を実装。
- ローカル実AppViewでアプリ／レコードへ別々に送信、再読み込み後の復元・分離、ライト／ダーク、375×812で開閉とレコードチャット入力を確認。UI検証APIはローカルストレージ。実サーバーはCloudflareテストDBで独立セッション・権限変更・ページング・同時再送・別アプリ／別行の隔離を確認。
- 新規サービス・課金・AI呼び出しなし。Simpleの既存会話経路は変更しない。
- 残差: 作成元ルームの既存スレッド再利用、AI／エージェント返信、メンション、既読・通知・全体検索は本差分に含まれない。Kylonのレコード会話実画面は参照データが空で未比較。100%同等とは扱わない。
- 配信前のクライアント監査で、任意のtableId/rowIdにundefinedを含めるとURLSearchParamsが文字列化し、アプリ会話がレコード会話として扱われる不具合を検出。未指定キーを省略する修正とAPIクライアントの回帰テストを追加。修正前のDeploy Web `39102291660` はWorker待機中にキャンセルし、先行公開を防止。送信アイコンも既存の紙飛行機アイコンに統一。
- 本番反映: PR #435（Worker `c2636de20e01e70c72a61c0cd1a43fedf39ae2cf`）、PR #436（Web `0caad2c26cec98d0d84082dfd66fec9fe0399850`）。Deploy Worker `39102291675` 成功、195ファイル／1,286テスト成功、D1追加後のWorker版 `679e8eb5-3f19-4950-acfa-081071188380`。Deploy Web `39103307331` 成功、90ファイル／749テスト成功、公開bundle `index-BqeC-04z.js`。
- 本番Macを完全終了・再起動し、新しい会話アイコン、カスタムアプリとチャットの併用、データビューアーでの「現在のデータ表示: 自分のタスク」、会話更新、閉じて再表示まで正常応答を確認。個人ビュー・列順・タスク名幅320・既存ソートは維持。
- 本番の確認用アプリは0件で、会話も空のまま。実利用データにテスト投稿は追加していない。本番でのレコード会話送信は未実施であり、ローカル実画面＋CloudflareテストDBの検証と区別する。証跡: `/tmp/honmaru-app-conversation-production.png`、`/tmp/honmaru-record-conversation-light.png`、`/tmp/honmaru-record-chat-mobile-dark.png`。
- 本番の入力欄へ確認用テキストを入力して送信ボタンの有効化を確認し、送信せず消去して無効化へ戻ることを確認。修正版PR CI `39102860525` はWorker・E2E・iOS・Windowsを含む全ジョブ成功、同ブランチCI `39102859147` も成功。
- 最終main CI `39103307321` の初回は既存tenant-isolationのネットワーク制限網羅テスト1件が300秒でtimeout（1,285件成功、assertion不一致なし）。同ファイル単独実行は3件成功・39.52秒。テスト条件は緩めず再実行。attempt 2 / Worker job `117607490411` は195ファイル／1,286件すべて成功（750.90秒）、最終main CIの全対象ジョブ成功。iOS/Windowsはpush条件によりskipで、修正版PR CIでは両方成功済み。

## 2026-10-18 — 作成元スレッド・AI返信・メンション通知

- Kylon実機でアプリチャットが作成元ルームの既存スレッドへ遷移し、データビューアーを右側に残すことを再確認。`@`でルーム全体／エージェント／メンバー候補を表示することを確認し、入力は送信せず消去。
- アプリ作成APIの`sourceThreadId`で元スレッドを保持。既存アプリでは作成者がリンク済みルームのスレッドを選択できる。元スレッドの履歴を読む権限とアプリ権限を毎回確認し、以後の返信は既存`/channels/messages`経路へ渡す。元の会話・通知・AI・DLP・送信重複防止を共用し、引き継ぎ前の独立アプリ会話も保持する。
- 独立したアプリ／レコード会話の`@AI`は既存AI設定・利用枠・利用台帳を利用。アプリ説明、対象レコード、当該会話だけを入力に使い、他レコードの会話は含めない。返信の重複起動防止、応答期限、利用枠なし／失敗表示、生成後の権限再確認を追加。新しいプロバイダー契約・キー・課金設定なし。外部AIを使う検証呼び出しはしない。
- メンション候補は既存の入力補完を共用。独立会話では現在アクセスできる非ゲストだけにアプリ内通知を保存。通知から対象のアプリ／レコード会話を開き、既読をサーバー保存して端末間で共有。作成元スレッドでは既存のActivity／通知経路を使用。
- Company Harnessの境界: 会話単位の権限・履歴・AI入力を分離、AIは説明への返信のみで任意ツールやデータ変更を自動実行しない。引き継ぎは監査記録を残す。Simpleの画面・既存チャット経路を維持。
- ローカル実AppViewで引き継ぎ候補選択、元会話の表示、メンション候補のキーボード選択、返信・AI表示、通知からレコードを開く操作、再読み込み後の既読保存を確認。UIのAI返信は明示したfixtureであり、実プロバイダーの回答検証とは区別する。サーバーではCloudflareテストDBとモデルスタブで保存・隔離・重複防止・失効時拒否を検証。
- 残差: 独立会話の通知はアプリ内通知で、OSプッシュ／メール／全体Activity統合は未実装。参照Kylonは0件のためレコード会話の外観は未比較。作成元未記録の既存アプリは手動選択が必要で、全Kylon機能の100%一致とはしない。
- 全体Workerテストでは1,291件成功・SQLのworkspace条件監査1件失敗。AI状態更新の2つのSQLへorg_idとapp_idを追加し、監査基準は変えず関連12件成功を確認。Web 91ファイル／751件、型チェック、ビルド成功。最終全体検証と本番確認は下記に追記する。

- PR #438 (`4836984a4c776cfe275746a61221e04f379b0ee6`) のmain CI `39107675945` はWorker・E2Eを含む対象全ジョブ成功（push条件のWindows/iOSはskip）。Deploy Worker `39107675968` は196ファイル／1,292件成功、D1追加と公開後health成功。Worker版 `e4063ee7-a487-45b3-8c16-48273d705583`。
- 最終確認で連続投稿時に後続質問が先行AIジョブの文脈へ入る可能性を修正。PR #439 (`16de939dce49973feac5a76ad522485945cea7f4`) は履歴を呼び出し元messageIdまでに制限し、回帰テストを追加。メンション候補のカーソル追従と狭い会話欄の幅も調整。関連Worker 12件、Web 751件、型チェック／ビルド成功。
- PR #439のDeploy Worker `39108909310` は196ファイル／1,292件すべて成功（528.24秒）。本番Worker版 `c409967c-d0ea-4002-a8c1-f897d16692b9`、公開後healthのokを確認。Deploy Web `39108909350` は91ファイル／751件成功、公開・ドメイン確認まで成功。`app.honmaruai.com` とpages.devが同じ `index-BcIIzOGI.js` を配信。
- 本番Macの最終UI確認時、操作ツールがロック中と報告（2026-10-18 16:46以降）。解除依頼は送信済み。今回の新機能について本番の再起動後・ログイン済み画面確認は未完了であり、ローカル実画面の確認と区別する。本番ユーザーへのテスト投稿やAIの実呼び出しは行っていない。
- 最終main CI `39108909309` はWorker・E2E・Web・Desktop・共通コード／mobile・relay・gatewayの全対象ジョブ成功。Windows/iOSのネイティブジョブはpush条件によりskip。新規契約・課金設定なし、Simple経路維持。

## 2026-10-18 — アプリ会話の全体Activity統合

- 前回の本番実機確認ブロックは解除。Macアプリを完全終了・再起動し、通知の空状態、元スレッド候補の取得、@channel／AI／メンバーの入力候補を確認。確認入力は送信せず消去。本番データと会話は0件のまま。ダーク画面証跡: `/tmp/honmaru-inherited-production.png`。
- アプリ／レコードのメンションとAI返信を全体Activityへ統合。既存アプリ内通知と同じ既読行を使用し、個別・一括既読を共有。読取時にアプリ／レコードの現在権限を再検証し、他ユーザーへの既読変更・削除済みレコード・非公開化後の漏洩をテスト。
- Activityから対象アプリとレコードの会話を開くURLを生成。再読み込み後も対象を保持。新着は受信者限定の既存relayイベントでActivityを再取得。本文をイベントに含めない。
- ローカルの実ClassicList→実AppViewでメンション一覧、正確なレコードへの遷移、再読み込み復元を確認。表示データはfixture。Worker関連26件、Web 752件、型チェック成功。OSプッシュは引き続き未実装。新規契約・課金なし、Simpleのチャット経路を維持。

- PR #442、main `afff8b1892b309a94308c8f75cad4cd70b599c62` の配信完了。Deploy Worker `39110540076` は196ファイル／1,293件成功、DB移行・health確認まで成功。Worker版 `f0d9107e-fa76-4227-8008-3770f7094d73`。Deploy Web `39110540241` は752件成功、本番とPagesで `index-C3QvFzI4.js` を配信。main CI `39110540113` の全対象ジョブ成功（push条件のiOS/Windowsはskip）。
- Kylonの「@自分」は左の会話リストを絞り込み、中央のスレッドと右のアプリを維持する。現Honmaruの全体Activityへ切り替える動作とは差分が残る。通知統合だけでUI忠実度の達成とは扱わない。

## 2026-10-18 — 生成時の作成元自動保存と再送

- ルーム内の自然文アプリ生成、およびアプリ一覧からルームを指定する生成で、依頼文を作成元スレッドに保存する。完成後はデータビューアーと元会話を同時表示。アプリ一覧の生成後URLは会話表示を保持し、再読み込み後も復元する。
- requestIdをユーザー・ワークスペース単位で保存し、同じ要求の再送は同じアプリを返す。異なる本文で同じIDは409。生成中の同時要求をリースで排他し、期限切れ処理の後着結果は採用しない。保存済みの生成定義を再利用し、DB保存の再試行でモデルを再呼び出ししない。
- 作成元が非公開ルーム／DMの場合は初期非公開。入力channelと元スレッドが食い違う場合は実際の元スレッドが基準。直接作成・テンプレート・自然文生成すべてに適用。アプリ、テーブル、公開設定、最初のバージョン、サンプル、ルームリンク、作成元、生成完了記録を一つのD1 batchで保存する。
- 生成前のDLP、生成後の所属・会話アクセス再検証、原子的保存失敗時のrollbackを追加。生成依頼のスレッドに通常チャットAIを重ねて起動しない。Simpleの既存送信経路を維持。
- Worker関連5ファイル68件、Web全91ファイル753件、型チェック、ビルド成功。モデルはスタブのみ。ローカル実HarnessAppsで自然文作成→元会話の自動表示→再読込を確認。証跡 `/tmp/honmaru-generated-source-chat.png`。本番のユーザーデータへテスト投稿や課金モデル呼び出しは行わない。
- 本差分は公開準備中。ワークフロー生成の元スレッド自動保存、独立アプリ通知のOSプッシュ、Kylonの左リスト内メンション表示、全機能・全画面の完全一致は未完了。モデルの応答受信と生成定義保存の間にプロセスが失われる場合まで、外部モデル呼び出しのexactly-onceを保証するものではない。

## 2026-10-18 — 左一覧のメンション絞り込みと三列維持（公開前）

- Harnessの「@あなた」は全体Activityへの画面切替をやめ、左の会話一覧だけを未読メンション／DMで絞り込む。ホームへ戻る操作も選択中の会話・下書き・アプリを維持する。SimpleのActivity経路はそのまま。
- ルームメンションを選択すると対象メッセージ／スレッドへ移動。独立アプリのメンションは対象アプリ／レコードの会話URLへ移動し、既読を既存APIへ保存する。既読メンションは除外。
- アプリ表示時に左一覧を隠していたデスクトップCSSを修正し、1101px以上で三列を維持。アプリと左一覧の幅を調整し、1500px以下の三列表示ではルームの操作名をアイコンに省略（アクセシブル名・ツールチップは保持）。タブとルーム名の見切れを修正。
- ローカル実ClassicList＋AppView、1280×720で「ホーム→@あなた→ホーム→@あなた」を操作し、中央の会話・未送信下書き・右のアプリが維持されることを確認。空状態の証跡 `/tmp/honmaru-mentions-preserve-app.png`。別fixtureで未読DM／ルームメンション／アプリメンションを確認し、既読ルームの除外、ルームの対象メッセージ表示、アプリ会話URL遷移を確認。実サービスへの投稿はない。
- Web全753件、型チェック、本番ビルド成功。参照Kylonの実データが空のため、非空一覧の表示を完全一致とまでは判定しない。PR #443 のCI／本番反映待ちの間の追加実装であり、このUI差分も本番未反映。

## 2026-10-18: source conversation release and custom app render handshake

- PR #443 merged as `efb65d31`, preserving main's permission/concurrency fixes and the intervening attachment change (#444). PR CI `39113116310` passed all jobs; the same-head push Worker suite passed 196 files / 1,396 tests. Production Worker `39114239275` and Web `39114239282` were still running at this checkpoint.
- Native Honmaru 1.3.5 displayed an empty custom-app frame despite saved nonempty HTML. A page reload remained blank after 45 seconds; quitting/relaunching restored the main UI. These native symptoms are **not yet proven fixed**. Screenshot: `/tmp/honmaru-native-custom-blank.png`.
- The production runner rendered HTML and completed its read-only SDK request in both the in-app browser and Chrome. The installed desktop CSP/config matched the repository, so no security policy was relaxed.
- The new runner acknowledges the inner document load and accepts only one initialization per frame. The host retries initialization after the runner-ready event, tracks the current render attempt, exposes a 15-second failure/retry UI, and discards old acknowledgements. Runner URL v3 avoids reusing a cached v2 response; the existing opaque-origin sandboxes and network/navigation restrictions are retained.
- Local actual browser check: sending initialization twice produced one code execution and one render acknowledgement. Actual `CustomAppFrame` check: an unreachable endpoint displayed retry after 15 seconds; retry returned to loading; restoring the endpoint rendered the document and SDK result and removed loading. Screenshot: `/tmp/honmaru-render-recovery.png`. No model call, production message, or production data write was made.
- Local validation on `efb65d31`: Worker app tests 34 passed; Web 93 files / 820 tests passed; TypeScript and production build passed. Native production recovery remains an acceptance check after deployment, not a claim from these tests.

## 2026-10-18: generated app completion replies and chat cards

- #443 production Worker `39114239275` and Web `39114239282` succeeded. Worker version `28dc1aa2-ac4d-46f6-a651-3a98dd5790e0`, asset `index-DD93yiK-.js`. Native relaunch verified the left mention empty state and existing custom HTML/SDK output (`/tmp/honmaru-custom-production-443.png`). This does not establish the cause of the earlier native blank frame.
- #445 (`6857eb04`) Worker `39115772044` and Web `39115772088` completed deployment and verification successfully.
- Kylon's actual source thread includes a completion reply and actual app preview with pin/open controls (`/tmp/kylon-source-thread-app-reference.png`). Honmaru generation now commits its completion reply atomically with the app. Publication failure or a deleted source leaves no success reply; request replay cannot duplicate it. No additional model call is needed.
- Canonical same-workspace app links render cards fetched using the current viewer's authenticated API. Cross-workspace, malformed and denied links cannot expose previews; late responses from a previous session are discarded. Preview frames receive no mutation API. Chat cards open the existing side app panel; pins use the existing server synchronization. Simple does not add these cards.
- An actual browser component fixture verified light/dark appearance, pin state and the open callback. It exposed and helped fix an excessively tall preview. Evidence: `/tmp/honmaru-result-card-light.png`, `/tmp/honmaru-result-card-dark.png`. The fixture retained its draft, but this is not a production nonempty-thread end-to-end check. No production message or paid model call was made.
- Local Web: 94 files / 823 tests; related Worker: 2 files / 50 tests; TypeScript and production build passed. This card slice still awaits CI/deployment. Workflow origin threads, OS push and other matrix gaps remain; no 100% equivalence claim.
- Post-#445 native relaunch verified the actual `custom-app-runner?v=3` document, saved HTML, SDK row count and absence of a stuck loading indicator. Screenshot `/tmp/honmaru-native-render-v3.png`. This confirms this launch, not permanent elimination of intermittent native reload failures.
- Integrated actual ClassicList/AppView fixture caught a hidden-panel bug: a previously open thread took precedence over the card's app panel. Cards now use the existing panel-switch action. Verified app/source conversation display, room draft preservation and thread draft restoration on return; Simple shows the same reply without app cards. Screenshot `/tmp/honmaru-chat-card-integrated.png`. At 1280px, nested app chat/data remains cramped compared with Kylon's central source-thread layout; this is an explicit remaining UI difference.

## 2026-10-18: source thread beside its app

- Harness source-thread cards retain the actual thread and its composer in the center while opening the app at right, instead of closing the thread and duplicating its history inside a narrow app chat. The original room stays mounted behind this layout, preserving its draft. Simple retains the previous layout.
- At desktop widths above 1100px the room is visually replaced by the selected source thread; app chat remains optional. Smaller widths retain the existing app overlay and return to the still-open thread on close. The explicit app close button now calls onClose, while Back retains the resource-navigation behavior. Back-stack dismissal closes the app before the underlying thread.
- Actual ClassicList/AppView fixture verified 1280px light/dark, left mention filtering without losing thread/app/draft, 1024px overlay and close-to-thread restoration. Screenshots `/tmp/honmaru-source-thread-app-light.png` and `/tmp/honmaru-source-thread-app-dark.png`. No model calls or production writes. This slice is not deployed yet; automatic generation-to-central-thread navigation and thread title/menu parity remain separate gaps.
- Final local checks for this layout: Web 94 files / 823 tests, TypeScript and production build passed. Browser back-stack layer order preserves the underlying thread, and cards opened from Activity fall back to the canonical app route rather than a hidden side panel.

## 2026-10-18: navigate generation to its saved source thread

- Room app generation now reads the saved, authorized source conversation after publication and opens the actual thread beside the app. If the source read fails or no source exists, it falls back to the app conversation; a source-read failure does not re-run app generation.
- Completion does not navigate over a different active room or session, and unmounted-session responses are discarded. A draft edited while generation is running is retained. Only an unchanged submitted prompt is cleared, including its stored draft when the user moved to another room. Workflow completion receives the same session/room and draft guards.
- Actual ClassicList fixture with a controllable completion response verified generation-to-source-thread/app, preservation of a draft edited while waiting, and remaining in a different room with that room's draft intact after the late response. `/tmp/honmaru-generation-central-thread.png`. These use stub generation responses, no model calls or production data writes. Automatic source navigation from the global Apps library remains separate.
- Local validation: Web 94 files / 823 tests and TypeScript passed. Production build passed. This navigation slice is not yet deployed.

## 2026-10-18: release integration and asynchronous conversation isolation

- PRs #446, #447 and #448 passed all PR CI targets, including Worker, Windows, iOS and end-to-end, and merged without squashing their stacked ancestry. Worker deployment `39118408100` passed 196 files / 1,397 tests and published version `06186827-04e6-4347-ba6a-cba87ff2dcc4`. Web deployment `39118662926` for main `da14da8f` succeeded; both Pages and the custom domain serve `index-Bv-d5WwR.js`. The queued intermediate #447 Web run was superseded by #448, which contains all three changes.
- PR #449 protects the global Apps library against generation completion after unmount/account changes or different navigation and preserves a revised prompt. Web: 95 files / 826 tests, TypeScript and build passed. All PR CI targets passed; merged at `e49cff01`. Web `39119757963` deployed `index-CCD1mpMG.js`, verified on the custom domain. Automatic global-library navigation to the central source thread is still a separate gap.
- PR #450 keeps source-candidate results/errors and inheritance completion scoped to their initiating conversation. The previous implementation could refresh the old API with the new panel's epoch after a scope change. Regressions verify that old account content never enters the new panel; Web: 94 files / 825 tests, TypeScript and build passed. All PR CI targets passed; merged at `5b6fddfd`. Web `39120018840` deployed `index-DokuSEgE.js`, independently verified on the custom domain.
- Native screen control works while the Mac is unlocked. The existing published custom app was blank again and Force Reload left the desktop shell blank. Full quit/relaunch restored its HTML and SDK count of zero. This recurrence is unresolved; it must not be reported as fixed by #445. No security policy was weakened.
- In the authenticated production app, app conversation loading, authorized source-candidate lookup and the @ mention list (AI, channel and member) were checked without selecting a source or sending a message. The temporary `@` input was cleared. Screenshot: `/tmp/honmaru-production-app-mentions.png`. No model calls, production records/messages or paid services were created.
- Combined #449/#450 integration validation: Web 95 files / 828 tests, TypeScript and production build passed. This does not substitute for each PR's CI and production deployment.
- The merged main tree `0ce0096f` exactly matches that combined integration test tree. A post-#449 native relaunch verified the existing Sales CRM's three records and that the explicit Close button returns to `#/list` rather than the app library. Records were only read. Main's post-merge CI is a separate still-running verification; the PR checks and production deployments above have completed.

## 2026-10-18: global app-library source navigation

- Room-targeted generation in the global Apps library now enters a workspace-qualified source-app route. The chat list loads the saved source through the current authenticated API, waits for its room, and opens the real thread beside the app. An existing app conversation's source label also links to that route.
- Missing/denied sources or an unavailable room fall back to the app conversation. Manual navigation invalidates pending source results and consumes the route, so neither a late reply nor a reload steals the selected room. Workspace switching uses the existing membership-checked route handling. Simple does not open the app/source panel.
- The actual ClassicList/AppView browser fixture exposed an effect-order conflict: the normal room-change reset closed the new app panel. Source opening now runs after that reset. The completed fixture verified the central source thread/right app and existing drafts, delayed-response cancellation with the research room and draft retained, missing-source fallback URL, and Simple's existing UI. Screenshot `/tmp/honmaru-global-source-navigation.png`; fixture and server removed after verification.
- Route parsing, malformed targets, room-generation navigation, and the source link are covered by component/unit tests. Full Web: 95 files / 830 tests; TypeScript and build passed. No production messages, model calls or new paid services. This slice awaits PR CI and deployment; full thread title/menu parity and intermittent native blank/reload behavior remain unresolved.


## 2026-10-20: document previews, file conversations and native recovery

- PR #481 PDF text selection/search layer is deployed: Web run `39424495346` succeeded. Local PDF search highlights were checked at 100% and 150% zoom. This does not verify every document, encoding or mobile layout.
- PR #482 prevents a delayed channel DELETE response from closing the newly selected conversation. CI `39423105068` passed; Web deployment `39425294009` succeeded.
- PR #486 adds one persistent ordinary channel thread per sent file. Local Web 887 tests and Worker file 27 tests passed, covering concurrent creation, independent attachments, unsent/deleted sources, DM isolation, outsider denial and deleted conversation roots. Document, image, media and generic attachment controls use the same route. Latest head `71ee6db20f68b6df9ec8864dfdd9219a26db5f4f` is not yet merged/deployed; CI `39426961064` is running. A local real-component CSV preview exposed black table text in dark mode; explicit inherited table text color fixed it and was visually checked. The screenshot is local `/tmp/honmaru-file-conversation-dark.png`. File/conversation side-by-side fidelity remains unverified; removing an attachment does not remove its ordinary conversation history.
- PR #485 bounds navigation network fetch to eight seconds. Web deployment `39427072533` succeeded, and the production custom-domain `sw.js` contains the deadline and 503 retry fallback. An already running Mac 1.3.6 still became blank on reload; Force Reload did not recover it. Normal quit/relaunch restored the authenticated workspace, and a subsequent reload reached the chat UI. The cause and complete fix remain unproven; neither the fallback nor a single successful reload establishes resolution. No storage was cleared.
- PR #483 manual update failure feedback and #484 main-frame navigation watchdog passed CI and merged. The installed signed/notarized Mac remains 1.3.6, which does not contain these two fixes. PR #487 prepares shared version 1.3.7; local desktop 14 files / 101 tests and shared version consistency pass. Its CI and signed release are pending. The prior automatic installation stall also remains unresolved.
- No production messages, records, paid model calls or new subscriptions were created for these checks. Simple mode remains available; these scoped checks do not establish complete Kylon parity or Company Harness readiness.

## 2026-10-20: Mac 1.3.8 and pending skills/memory integration

- Signed Mac release `39439107732` succeeded; `v1.3.8` was published at 14:36:51 UTC. The installed app updated from 1.3.7 through its normal update menu. Info.plist reports 1.3.8; codesign verification and Gatekeeper assessment passed. Login and Harness mode returned after restart. A subsequent Cmd+R displayed the chat UI, and the existing custom task app rendered its zero-record dashboard. Evidence: `/tmp/honmaru-138-reload.png`, `/tmp/honmaru-138-custom-app.png`. The new bounded local diagnostic log records navigation/DOM/finish events. One successful reload does not resolve the earlier intermittent blank-screen issue.
- File conversation backend deployment `39435091238` succeeded on retry after a Cloudflare D1 internal error. Web deployment `39438413546` also succeeded. Message pin-version changes in main `741cc52c` have separate, still-running deployment runs `39439617205` / `39439617294`; do not conflate the releases.
- PR #495 implements standalone SKILL.md preview/private save/export, with bounded YAML parsing and preservation of additional metadata. It does not import ZIP/folder/support files, install automatically, or grant access from metadata. After merging the pin-version migration, 33 related Worker tests passed. CI and production rollout remain pending.
- PR #496 exposes the existing four memory kinds, search, type filters and conversation/shared labels. Its first CI revealed a duplicate Japanese Context key; commit `6485ee8f` removes the duplicate and passed `tsc -b web-react`. Earlier `tsc --noEmit` reporting was insufficient evidence for the production build. Review validation dates, structured titles/bodies and on-demand reads remain unimplemented.
- PR #497 adds bounded retry only for D1 internal error 7500 with a reference. SQL/authentication errors still fail deployment; duplicate columns remain the already-applied signal. Twelve migration/dependency tests pass. Not deployed yet.
- Kylon's logged-in agent Skills UI was inspected directly: installed rows, author labels, individual menus, a 512px Add Skills dialog, search and Available/Installed tabs, with folder/ZIP import. Reference screenshot: `/tmp/kylon-skill-add-reference.png`. PR #498 implements the installed list and searchable installation dialog with existing APIs and light/dark tokens. Local real-component fixtures verified install count changes and search focus. Screenshots: `/tmp/honmaru-skill-catalog-light.png`, `/tmp/honmaru-skill-catalog-dark.png`. Package import and bundled skills remain absent; the UI is not fully equivalent.
- Local integration branch `codex/pending-ui-integration` combines #495–#498, resolving import and translation conflicts while preserving both features. Web 116 files / 901 tests, production TypeScript build, Vite build and 12 release/migration tests passed. The branch is pushed for CI but is not main or production. Browser interaction is currently disabled in Work settings and the GitHub connector is unavailable; regular Git push and public GitHub API reads remain usable.
- No production messages, record changes, agent skill assignments, paid model calls or new subscriptions were created during these checks. Simple mode remains in the code; no claim of complete Company Harness readiness or 100% parity is made.

### 2026-10-21: authenticated member and skill screen isolation
- Agent/member and skill screens now remount their local selection, drafts and request state when the API base, workspace or authenticated session changes. Agent detail load revisions are invalidated on effect cleanup.
- Regression tests explicitly resolve an old member-list response after the new workspace response, and reject an old skill-list request after a session change. Current data stays visible and the previous session's error does not appear. Four focused tests pass; `tsc -b web-react` passes.
- These changes are on `codex/pending-ui-integration`, not yet deployed. At verification, CI 39440097131 passed Web, E2E, Windows, iOS and other completed jobs; Worker npm test remained in progress. Production Worker 39439617205 remained in its Test step, and Web 39439617294 waited for that Worker deployment. No restart or success was inferred from elapsed time.

### 2026-10-21: import from the agent skill catalog
- Added a themed drop/select area and instruction preview inside the agent Add skills dialog. The existing validated SKILL.md preview endpoint runs before Save; Save creates a private skill and adds the returned object to the available catalog without a second fetch. Installation remains an explicit action in the same dialog, avoiding duplicate creation on installation failures.
- Catalog import flow test verifies that preview causes neither saving nor installation and that reviewed metadata/body reach the save callback. Seven related tests and production TypeScript build pass. ZIP/folder assets remain unsupported, and this iteration has not been visually verified or deployed.
- Catalog import labels now follow Japanese/English locale selection and expose a processing status. Added regression coverage for rejecting unsupported/oversized files before API calls and retaining the reviewed draft after a failed save so it can be retried. All four catalog tests and production TypeScript build pass. Visual verification remains outstanding.

### 2026-10-21: production stale module failure reproduced
- Native Honmaru 1.3.8 was readable and showed the existing custom app. Clicking Members reproduced the error boundary: `Failed to fetch dynamically imported module: https://app.honmaruai.com/assets/HarnessAgents-B7Q87iit.js`.
- Added bounded recovery in the React error boundary only for same-origin hashed application module fetch errors. It preserves the URL, skips offline cases, persists a five-minute session guard before reload, and retains manual recovery if storage is unavailable. Two tests cover matching, unrelated/external URLs, offline, repeated failures and blocked storage; production TypeScript build passes.
- This code is not deployed. Manual Reload on the existing production error led to a blank screen despite desktop load diagnostics reporting DOM/finish/stop. Therefore the broader intermittent blank-screen issue remains unresolved and the new recovery must not be represented as proven end-to-end restoration.

### 2026-10-21: asset cache validation
- Native production Force Reload still showed no web accessibility content. Public HTTP inspection returned 403, so no response-body claim is made for the production failed asset.
- Code review found the service worker accepted any successful response for hashed JS/CSS, including a Pages HTML fallback, and replayed it indefinitely. Added MIME validation before using or caching executable/style asset responses; a previously invalid cache entry is fetched again and replaced only with a valid response.
- Service worker suite: 21 tests pass, including HTML fallback not being cached and recovery from an existing bad asset cache. This closes a demonstrated code-level failure path, but does not prove the production blank-screen root cause or its resolution.

### 2026-10-21: native recovery after an empty completed document
- Desktop previously cancelled its only watchdog on `did-finish-load`; production evidence showed that event can occur while the entire window remains empty. Added an optional delayed content probe after completion, scoped to the app origin. Only an explicit false result on the same live navigation opens the existing native retry dialog. Failed inspections and navigation/destroy races do not trigger it.
- The probe returns a boolean only. Diagnostics record a bounded `blank` event, without URL or page text. This provides a recovery control; it does not repair or prove the cause of the underlying failed render.
- Desktop full suite: 15 files, 110 tests pass. Changes are not yet included in a signed release or production deployment.

### 2026-10-21: complete installed skill instructions
- Found a mismatch: skills accept up to 8000 characters but `prepareAgent` silently truncated each installed procedure at 4000. Removed that second truncation so valid saved procedures retain their final checks and steps.
- Worker access suite: six tests pass, including a real D1-backed skill creation/install and preparation with a final instruction past character 4000; the private procedure remains absent in shared-room preparation. No paid model call was made. On-demand skill loading and package support remain incomplete.
- Native restart replaced the empty window with the independent startup recovery panel; ordinary application content still did not load. GitHub unauthenticated API limit resets at 2026-10-20 15:52:44 UTC; repeated polling is deferred until then.

### 2026-10-21: downstream skill execution audit
- Preparation-level complete-body regression is not proof of full model delivery. `customAgents.askAgent` truncates the assembled instructions at 20000 characters; workflow agent steps at 12000; follow-ups at 8000. Room guidelines prepend additional text. Multiple valid skills or a long persona can therefore still lose final instructions.
- KY-034 stays unimplemented. The required change spans on-demand reading with installation/visibility/membership rechecks, research tool execution, non-tool model fallback, workflows and follow-ups. Do not claim lazy loading or full skill delivery based on `prepareAgent` tests alone.
- KY-033 now distinguishes implemented but unshipped standalone SKILL.md handling from absent folder/ZIP/support-file behavior. No completion status was assigned to those package requirements.

### 2026-10-21: on-demand skill reader foundation
- Added a server-bound `read_installed_skill` tool factory. Identity, workspace, agent and conversation are captured by the caller, not supplied by model arguments. Every read rechecks current membership, agent grant, conversation access, installation and private-skill visibility; denial returns a uniform unavailable response.
- Nine Worker access tests pass, covering full procedure reads, uninstall after tool creation, membership removal, revoked agent access and attempted identity/context substitution.
- This factory is not yet connected to model execution. KY-034 remains unimplemented end-to-end; conversation research, fallback models, workflows and follow-ups still need integration and actual provider-request regression coverage.

### 2026-10-21: conversation research uses the skill index
- Prepared agents now carry a separate research instruction set containing skill ID/name/description rather than bodies, plus the permission-checked reader tools. Channel execution attaches those tools per agent. Room guidelines are preserved in both instruction sets. The existing non-research path retains its full-body instruction source.
- Model request interception confirms the first research request excludes the procedure, the function output in the second request includes it, and a non-research provider receives the procedure rather than a catalog it cannot read. Research tool output now serializes structured results as JSON rather than `[object Object]`.
- Three Worker suites / 27 tests pass, using fake provider responses only. Workflows/follow-ups, fallback aggregate size limits, the tool-output size bound, and deployment remain outstanding. This does not complete KY-034.

### 2026-10-21: skill reader output keeps the full valid procedure
- Skill reader now returns plain instruction text rather than JSON metadata/body. This keeps even quote/newline-heavy 8000-character procedures below the research loop's 20000-character tool-output limit and avoids treating frontmatter metadata as executable permissions.
- A D1-backed test prepares an installed private skill, verifies the research catalog excludes its final instruction, reads it through the returned tool and confirms the entire body/final instruction fits the output bound. Two suites / 16 tests pass.
- Workflow/follow-up currently use the single-call `harness/model.js` completer rather than the research loop. Integrating lazy reads there requires a bounded tool loop with the existing allowance and usage accounting, and a full-instruction fallback when a provider refuses tools. These routes remain outstanding.

### 2026-10-21: bounded lazy skill reads for scheduled execution
- Added a bounded chat-completion tool loop to the shared harness completer, used by workflow agent steps and follow-ups. Up to three tool rounds precede a final answer request, with a twelve-call tool budget and shared request deadline. Successful rounds enter the usage ledger; the existing allowance is consumed once and released/settled in the existing finally block.
- Initial HTTP 400/422 tool refusals retry without tools using full instructions. Other failures do not repeatedly retry. Workflow context explicitly disables private skill access, including through later tool reads; follow-ups keep their creator/conversation context.
- Four suites / 47 tests passed, then the access suite passed all 11 tests after adding owner/private-workflow exclusion coverage. Tool-loop tests verify request sequencing, full-instruction fallback and bounded rounds with fake responses. End-to-end workflow/follow-up tool invocation and ledger assertions still need dedicated coverage; no real paid provider call or production rollout occurred.

### 2026-10-21: workflow and follow-up integration verified
- Added D1-backed entry-point regressions for manual workflow agent steps and due follow-ups. Each creates/installs a shared skill, intercepts the first completion returning a skill read, verifies the second request contains the actual procedure, and checks the persisted completed result.
- Both model rounds are recorded in `ai_calls` with the expected owner/purpose/token counts, and no allowance reservation remains. The workflow suite passes all 24 tests; only mock provider calls were used.
- Full integrated Worker regression started in exec session 17351, output `/tmp/honmaru-worker-integrated-full.log`; completion is not yet known. Production deployment and real UI recovery remain unverified.

### 2026-10-21: skill action menu reference and behavior
- Read-only native Kylon inspection confirmed the installed skill overflow contains a compact trash-icon removal action. Closed the reference menu without changing skills.
- Honmaru's installed skill action now uses the existing trash vector icon and a compact rounded menu; outside pointer and Escape dismiss it, Escape/selection restore focus, and dismissal never removes a skill. Five related UI tests and production TypeScript build pass. The updated menu has not yet been visually rendered in Honmaru or deployed.
- Production Mac recovered to normal UI after the earlier restart and delay; Members, agent profile and the old skill UI were readable. This is not proof that unshipped recovery code fixed the incident. Latest Web full suite passed 909 tests before this menu addition; full Worker session 17351 remains running.

### 2026-10-21: member suggestion session isolation
- While auditing creator display, found member suggestions cached by API/workspace only. Cache and stale fallback now include the authenticated session; the hook suppresses the previous scope's list immediately during a scope change, before the new effect completes.
- Regression verifies a new session whose initial fetch fails does not receive the earlier session's member list, then loads its own list independently. Five focused tests and production TypeScript build pass. Human-readable skill creator names remain an outstanding UI/API change.

### 2026-10-21: integrated Worker regression and creator labels
- Full Worker session 17351 completed successfully: 200 files / 1467 tests, 567.63 seconds. This covers the integrated backend through scheduled lazy-read integration; the creator-name change below was added afterward and checked with focused suites.
- Skill queries now include the owner's display name (login fallback) as an additive `createdByName` field, retaining the original ownership ID and visibility predicates. Catalog labels/search use the name when supplied and remain compatible with older API responses.
- Focused Worker access/agent suites pass 24 tests, including creation, listing and installed-skill display names with private visibility preserved. Catalog tests pass five tests including display/search by creator name; production TypeScript build passed with the UI change.

### 2026-10-21: support-file package validation foundation
- Added one portable relative-path validator and decoded-package validator for forthcoming folder/ZIP imports. Rejects traversal, absolute/Windows paths, control characters, non-normalized Unicode, device names, links, case collisions, file/directory conflicts, invalid UTF-8 root instructions and size/count excess. Binary support files retain their bytes.
- Limits: 64 files, 1 MiB per support file, 8 MiB total decoded package; SKILL.md retains its stricter parser limit. Seventeen tests pass.
- Not connected to import routes or persistence yet. ZIP decoding must enforce expansion bounds before allocating decoded entries; passing this validator after an unbounded unzip is explicitly insufficient. Export, asset reads, UI and production verification remain required.

### 2026-10-21: bounded skill ZIP decoding
- Added a strict single-disk ZIP reader for stored/deflated UTF-8 entries using existing Workers node:zlib support (https://developers.cloudflare.com/workers/runtime-apis/nodejs/zlib/). Validates central/local metadata, CRC, ranges, path normalization and file types; rejects encrypted/unsupported formats and links. A single common folder wrapper is stripped only after validating original paths.
- Inflate has an enforced maximum output length, tested in workerd with a compressed body whose declared size is maliciously small. Decoded package limits remain enforced. Two suites / 21 tests pass, covering stored/deflated binary round trips, folder wrapping, traversal, symlinks, corruption and truncation.
- Decoder is not yet exposed through import routes or UI. Persistence, asset reads and package export remain pending. ZIP64/multi-disk/encrypted archives are deliberately unsupported, and no filesystem extraction or code execution occurs.

### 2026-10-21: persisted support files and agent reads
- Added additive `hx_skill_files` storage in existing D1. Skill creation batches body, visibility and validated binary support-file rows atomically. Existing body edits preserve attachments; deletion cascades to them. Explicit replacement through the ordinary edit API is rejected rather than silently dropping files.
- Authenticated `/skills/:id/files` lists paths/sizes or downloads a requested path with attachment/no-store/nosniff headers. Existing skill visibility is checked before listing/reading. No public asset URL is introduced.
- Installed-skill tools now list/read support files with the same per-call membership, agent, conversation, installation and private-context checks. Text and binary reads are paginated below tool output limits; scripts are read as data only.
- Two Worker suites / 38 tests pass, including byte preservation, unauthorized private downloads, invalid imports leaving no rows, edit preservation, deletion cleanup, pagination, binary encoding and uninstall between pages. Earlier package/access run passed 30 tests. Import ZIP/folder routes, export and UI remain pending; migration and production rollout have not occurred.


### 2026-10-21 — Portable skill packages (integration branch, not deployed)

- ZIP and folder previews do not write to D1. Confirmed private saves atomically preserve body, metadata and support-file bytes; unauthorized export returns 404. Stored ZIP exports retain binary and Japanese filenames, independently validated with Python zipfile (CRC/readback).
- Added web ZIP/folder pickers, manifest review and authenticated ZIP download. Existing Markdown import and Simple mode remain available. No service or billing configuration changes.
- Focused Worker tests: 37 passed across access, ZIP and package validation. Web suite: 914/915 passed initially; existing recording replay timing assertion failed, then its 25-test file passed in isolation. TypeScript project build and Vite production build passed.
- Not claimed: deployed package migration, production package behavior or visual fidelity of the new controls. GitHub connector remains unavailable; browser automation remains disabled. CI/deployment checks must use verified branch SHAs.


### 2026-10-21 — Folder drop and import visuals (follow-up)

- Native Kylon dialog rechecked: import panel uses an upload symbol and folder/ZIP icon actions; folders can be dropped anywhere in the dialog.
- Added dialog-wide drops, nested directory batch reads with file/byte/entry/deadline limits, and matching compact import actions using native SVG icons and existing theme tokens. No new service dependencies.
- Web suite 917/917 passed; TypeScript project build and production Vite build passed. Actual Honmaru rendering of this follow-up remains unverified until deployment.
- Earlier package commit bfb17486 passed CI 39452261977 and was fast-forwarded to main through ordinary Git. Worker 39454753727 / Web 39454754007 deployment started; completion must be checked separately.


### 2026-10-21 — Production package verification

- Worker bfb17486 deployment 39454753727 succeeded, including D1 migration and deploy checks. Web 25ffa970 deployment 39457096303 succeeded. Matching branch CI runs 39452261977 and 39455211066 both succeeded; bfb17486 main CI 39454753761 also succeeded.
- Native Honmaru AI reloaded successfully, then opened agent Skills and the new dialog. Dark palette, upload/folder/ZIP icons and review panel observed directly. ZIP and folder fixtures both returned preview-only, Japanese description/body and templates/report.txt (43 B) from production. Neither was saved or installed.
- macOS picker selection initially left Open/Upload disabled; keyboard focus on the selected column and refreshed app binding allowed completion. CUA also intermittently returned noWindowsAvailable/cannotClickOffscreenElement/ScreenCaptureKit errors. No product change was needed for selecting the files; do not classify these transient observations as a fixed product defect.
- Native Escape after preview also closed the underlying agent screen. Added a shell Escape guard for an open native dialog so its cancel handler owns closing. This final guard passed the 917-test Web suite, TypeScript project build and Vite build; its production behavior still needs verification after deployment.
- Shell HTTP health requests return 403 in this execution environment. Production workflow health checks and authenticated native previews provide the available verification. Folder drag is tested in code, not yet through native drag input. Simple mode and billing/service configuration were not changed.


### 2026-10-21 — Final native check for 1dd4ebe9

- Web deployment 39459192447 succeeded. In the native production app, Escape now closes the skill dialog while retaining #/agent-team, the selected Mac execution assistant and Skills tab. No fixture was saved or installed.
- A reload after deployment again produced an empty native web view, despite load diagnostics recording dom/finish/stop. Quitting and reopening Honmaru AI 1.3.8 restored the normal signed-in UI without clearing data. The intermittent blank reload remains unresolved; do not claim that the earlier web cache changes eliminated it. The newer native blank-document recovery code on main is not in the installed 1.3.8 binary.
- Latest main CI 39459192388 is checked separately from completed Web deployment. This evidence-only note is left local to avoid interrupting the running code CI with another documentation push.

### Native blank-load diagnostics follow-up (2026-10-21)

- Added HTTP status and deduplicated main-frame script/preload error categories to the bounded local diagnostics. Raw URLs, source paths and console messages are not persisted.
- Desktop suite: 15 files / 112 tests passed, including frame isolation, navigation reset and restart persistence.
- Native production app currently renders the selected agent Skills screen normally. Intermittent reload blankness remains unresolved; these diagnostics are not a claimed root-cause fix and require a signed desktop release before installed clients receive them.
- At this check, main CI 39459192388 still has Worker and E2E running; other required completed jobs are successful.

### Finder ZIP compatibility (2026-10-21)

- Reproduced a real import failure using macOS `ditto -c -k --sequesterRsrc --keepParent` on the disposable preview fixture. The archive contains `__MACOSX` AppleDouble sidecars; before the fix it incorrectly reported missing root SKILL.md.
- After the fix, the same native archive parses as `preview-only` and exposes only `templates/report.txt` (43 bytes). Finder sidecars and .DS_Store are excluded after path, mode, expansion and CRC validation; ordinary hidden assets are retained. The expanded archive record bound accommodates 64 actual files plus metadata/directory records.
- Mac 1.3.9 release preparation is preserved on local branch `codex/mac-release-1-3-9-preparation` (840d7ed9). GitHub rejected the workflow update because the OAuth connection lacks `workflow` scope. No signed 1.3.9 was built or published; no workaround to that permission restriction was attempted. The active branch retains the existing workflows/version.
- Worker package/ZIP/access suites: 40 tests passed with worker-local Vitest 4.1.11. An initial root-runner invocation used Vitest 5 and collected no tests; that invocation is not counted as validation.

### Agent Skills vertical alignment (2026-10-21)

- Direct native screenshots at the same 1920px window width showed Honmaru repeating the Skills title and placing the permission explanation above the catalog, shifting the main controls roughly 90px below the reference after accounting for the native title bar. Removed the duplicate heading and retained the permission explanation below the catalog.
- Full Web suite 917/917, project TypeScript build and Vite production build passed. Production screenshot verification remains pending deployment.

- Deployment dispatched at cd4a98f4: Worker 39461307176; Web 39461307131 (waiting for matching Worker); main CI 39461306982. During the deploy wait, the installed production app reproduced the pre-fix missing-root error for the native ZIP. This is a before-fix observation, not a failed verification of the new code. The selected fixture remains disposable and was never saved/installed.
- Native file picker tip: selected ZIP may show Open disabled in AX; the selected file exposes `Finder項目を開く`, which successfully opens that exact file. No app filter change was made.

### Japanese Mac package names and localized import feedback (2026-10-21)

- A second native `ditto` fixture with Japanese folder/file names reproduced rejection: macOS wrote strict UTF-8 bytes without the UTF-8 ZIP flag and decomposed the voiced characters. Import now uses fatal UTF-8 decoding regardless of that flag and normalizes ZIP/folder paths to NFC before validating duplicate paths. The same native archive now produces `ガイド.txt`; malformed UTF-8 and normalized collisions remain rejected.
- Worker ZIP/package/access tests: 43/43 passed, including folder-preview HTTP collision rejection and no database writes. Web full suite: 918/918; TypeScript project build and Vite production build passed.
- Known import validation errors use Japanese translations. A truly empty skill catalog now says to import a skill instead of claiming every skill is already installed. Unknown error details remain visible.
- These follow-up changes are not yet deployed; the prior cd4a98f4 Worker/Web deployments remain authoritative live jobs.

### In-place agent creation and role audit (2026-10-21)

- Native Kylon Members → New agent opens a centered form for avatar/name/specialty/runtime/intelligence. Honmaru previously navigated to the legacy agent list. Added a Harness-only creation dialog, retaining the detailed legacy editor and Simple route. Workspace AI is the actual supported runtime in this form; external-provider creation parity is not claimed.
- Name, specialty and tier are submitted in one request. Agent and profile are written in the existing D1 batch; invalid initial profiles create no partial agent. Creation makes no model call, starts personal/private and places the agent in no room. Stable request handle and pending guard prevent duplicate UI submissions; errors preserve the form.
- Web 920 tests and TypeScript passed; Vite build passed. Worker existing agents/teammates/Harness agents: 49 tests passed. Production rendering of this new dialog is not yet verified.
- Official https://docs.kylon.io/agents/access specifies independent Agent Admin/Member roles, human-admin continuity and controlled grants. Current Honmaru still uses owner/workspace permissions plus access/people, and list queries hide other personal agents. KY-014 remains missing; the creation dialog does not resolve those authorization gaps. Current reference Aris profile exposed only Profile/Skills tabs, so no Access-tab screenshot was inferred.
- Closing the skill dialog now clears its transient error and retained unsaved preview; the native before-fix screen showed the import error leaking onto the underlying Skills page.

### Existing native release route

- Prepared desktop package/lock version 1.3.9 without changing any workflow. Existing `Mac signed release` can build/sign/notarize/publish this version through its existing workflow_dispatch entry point once this commit reaches main. The tag-trigger experiment stays reverted; no additional credential scope is required to keep the source ready. Dispatch itself still requires an authenticated Actions connection or the user’s existing GitHub UI.

### Production ZIP fix verified / profile metadata follow-up (2026-10-21)

- cd4a98f4 main CI 39461306982 completed successfully. Worker deployment 39461307176 completed successfully. Reopened the same `/tmp/honmaru-finder-skill.zip` in the signed production app: the previously failing archive now shows `preview-only`, its Japanese description/body and only `templates/report.txt · 43 B`. No save/install was performed.
- 2491ceb2 is on main: Worker deployment 39463912416; Web 39463912373; main CI 39463912399. Japanese filename fixes, localized feedback, in-place creation and desktop source version 1.3.9 are in that revision. At observation they were running/pending, not verified published.
- Prepared profile metadata parity: author and original creation date, briefcase/brain/person/calendar icons, Fast/Pro/Max labels and inline tier selector. Access information remains visible. Creation timestamp is exposed from stored created_at, never guessed from updated_at, and survives edits in the API regression test.
- Profile follow-up: Web 920 tests, TypeScript and Vite pass; Worker agents/Harness agents 44 tests pass. Native rendering remains pending deployment.
- Requested the user execute the existing Mac signed release workflow (main, publish=true), since this connection cannot dispatch Actions. This requests the concrete existing release operation without new workflow permissions. Web/API work continues independently.

### Inline persona editing (2026-10-21)

- Matched the observed Kylon inline Markdown editor, cancel/save controls and pencil menu. Switching profile tabs preserves the draft. The discussion action opens the existing agent conversation; AI self-editing is still a separate gap.
- Persona saves atomically compare the original instructions, reject stale writers with 409, and update only instructions so concurrent name/profile edits survive. Failed saves preserve the draft; explicit reload discards it. Read-only members have no edit controls. Simple mode retains its existing editor/API behavior.
- Web 923 tests, Worker agents/Harness agents 45 tests, TypeScript and Vite build passed. Native production rendering and deployment of this change are pending.
- At the latest check, 2491ceb2 main CI and Worker deployment were still running; its Web deployment was pending. No deployment completion inferred.

### Profile edit dialog parity (2026-10-21)

- Read native Kylon profile edit dialog and screenshot: 512px dialog, 80px avatar, display name, specialty/help text, intelligence and explicit Cancel/Save. Closed reference without changing its data.
- Implemented the same dialog structure in Harness, explicit whole-form save, failed-draft preservation and disabled unchanged save. Existing access/mention controls remain under Advanced settings; Simple editor retained. Existing picture avatars remain unchanged; photo upload and generated avatar parity are not implemented by this change.
- Extended profile API to save name/emoji and profile fields in one D1 batch. Validation precedes writes; instructions and handle are preserved. Profile patches now update only supplied columns so unrelated concurrent access edits are not overwritten.
- Web 924 tests, Worker agents/Harness agents 46 tests, TypeScript and Vite passed. Production rendering remains pending deployment; no complete parity claim.

### Profile picture controls (2026-10-21)

- Reused existing agent avatar upload/delete API in the Harness profile dialog. Clicking the avatar opens a file picker; accepted raster images (PNG/JPEG/WebP/GIF up to 2 MiB) remain local previews until Save. Preview URLs are released. Switching to an emoji removes an existing picture only on Save.
- Profile and media writes use separate existing endpoints: on media failure, the already saved profile remains visible and the dialog explicitly reports partial success, retains the image and permits retry. This is not an atomic media/profile transaction.
- Web 925 tests, TypeScript and Vite pass. New regression checks reject SVG, confirm no upload before Save, and verify local preview cleanup. Existing server image validation/ACL remain unchanged. Native live rendering remains pending deployment.
- Latest known release jobs: e43500f0 CI 39466316845, Web 39466316606 and Worker 39466316407 were pending behind 2491ceb2 Worker 39463912416. c07fa992 pending deploys were superseded/cancelled by the newer main revision. Public HTTP probes returned 403 from this environment, so they did not establish production bundle contents.

### Avatar preview parity (2026-10-21)

- Observed native Kylon avatar viewer: square 768px dialog, contain-fit image, close control and bottom-centered minus/reset/plus toolbar. Closed reference without changing data.
- Added Harness avatar preview using existing image or emoji, 50–400% zoom, reset, bounded pointer pan above 100%, keyboard +/-/0 and fallback on image errors. Responsive viewport bounds and existing light/dark tokens retained.
- Web 926 tests, TypeScript and Vite pass. Native rendering awaits publication; drag/zoom bounds and image failure are covered by component regression.
- Current release queue: ccc64f0e CI 39466618112 running, Web 39466618065 pending. e43500f0 Worker 39466316407 pending behind 2491ceb2 Worker 39463912416 (still running). Avatar-preview commit is held locally to avoid repeatedly cancelling the running main CI while additional UI work is prepared.

### Shared dialog keyboard behavior (2026-10-21)

- The shared Dialog focused the first matching input even when hidden and let Tab reach the obscured page. It also captured the initial close callback and could close multiple nested dialogs.
- Added visible/enabled focus-stop filtering, Tab/Shift-Tab containment, topmost-only Escape handling and the current close callback. IME composition is respected; prior focus is restored. Used by the new profile/avatar dialogs and existing Simple dialogs without removing their controls.
- Web 927 tests, TypeScript and Vite pass. Regression covers hidden file inputs, wrapping in both directions, nested modal exclusion, updated callbacks, IME Escape and focus restoration. Native keyboard verification remains pending publication.

### Theme refinement and production recovery evidence (2026-10-21)

- Profile/new-agent dialogs now use the reference-sized title, 24px inner spacing, borderless footer and theme-aware olive action colors; profile/persona outlines use the border role instead of hover fill. Removed empty description spacing. Web 927 tests and Vite pass.
- Verified Worker 2491ceb2 job 39463912416: full tests, D1 migrations, deployment and verification all succeeded; completed 2026-10-20 17:32:33 UTC. This proves that backend revision only, not newer queued revisions. GitHub public REST quota then reached zero until epoch 1792518783.
- Installed app still 1.3.8: Cmd-R yielded an empty dark content area although diagnostics recorded navigation/DOM/finish/stop. Force-reload did not restore it immediately. Quit/relaunch restored the signed app through its loading fallback into authenticated chat, and Members retrieved the existing agent. No unlock issue, account reset or data deletion. New desktop recovery source is prepared in 1.3.9; signed release remains unverified.

### Room-level agent response policy (2026-10-21)

- Added versioned Mentioned only room setting, API and Harness room-details switch. Uses room resolution/private membership checks and existing build permission. Concurrent stale saves return 409; UI retains the saved switch state after failure and offers reload.
- Enabled policy suppresses implicit thread continuation, human-proxy replies and automatic issue/report work. Explicit agent mentions and agent DMs remain available. Policy continues to apply after switching to Simple; no policy means unchanged legacy behavior. Does not add suitable-agent routing or autonomous handoff.
- Web 928 tests, TypeScript and Vite pass. Worker response/agents/guidelines tests 51 pass; existing proxy/autobuild/enqueue/channel regressions 26 pass; expanded autobuild suite 5 pass, including a configured provider receiving no automatic run in mentioned-only rooms. All providers mocked; no paid calls.
- New table hx_room_responses uses the existing schema migration route. This backend/UI change is not published yet; queued production work remains separate.

### Queued response policy revalidation (2026-10-21)

- Found that runProxy rechecked room access but not the new Mentioned only setting at dequeue time. Added a current-policy check before provider/allowance lookup, so queued proxy work cannot bypass a subsequently enabled room setting.
- Proxy suite 12 tests passes, including no provider request/reply after the setting changes. Harness agents suite 16 tests passes, including runQueuedAgents returning without work after the same setting change.
- Full Worker suite is running in exec session 97774 with output /tmp/honmaru-room-policy-full-worker.log, started before this final queued-proxy patch; targeted suites above cover the final edits. Do not infer full-suite completion until its process exits.

### Room setting state feedback (2026-10-21)

- GET response settings now returns the existing build capability; the UI disables writes without it. Loading is explicit; 409 disables the stale switch until reload, and failed changes retain the stored state. Session/room/API-origin changes remount the setting to avoid cross-context results.
- Web 929 tests, TypeScript, Vite and response API test pass. Full Worker session 97774 remains live, not completed.

### Initial suitable-agent routing (2026-10-21)

- Added a local routing pass for clear new human requests in Harness rooms when Mentioned only is off. Only placed, accessible agents that permit unmentioned use are candidates. Specialty/description terms influence selection; stable room-member order provides the fallback. No extra model call is used to classify.
- Explicit addressees, quoted/code-only requests, status/acknowledgement phrases, agent-authored messages and existing human threads do not create automatic assignments. Simple keeps its previous routing. Room/agent mention-only policies win.
- This is intentionally recorded as partial routing parity: multilingual/ambiguous intent, complex task selection and agent-to-agent handoff remain incomplete. It is not evidence of a full semantic router.
- Worker routing/agents/autobuild regression 55 tests passed; after refining named-human/status exclusions, routing/Harness-agent suites 19 passed. Full Worker session 97774 started before this routing change, remains in progress, and cannot establish this new path on its own.

### Full-suite rerun with fixed sources (2026-10-21)

- Session 97774 completed with 202 files/1505 tests passing and one proxy test failing (expected null; received {act: none}). This run began before queued-proxy source changes but discovered the later-added test; it cannot certify the final tree. The failure matches the old path, but stale loading is a hypothesis until a frozen rerun passes.
- Started full Worker rerun at source commit e2166a6a, session 25135, log /tmp/honmaru-frozen-worker-suite.log. Worker source/tests must remain unchanged until it finishes. No new deployments are being inferred from local results.

### Version consistency and production screen evidence (2026-10-21)

- Public GitHub Actions confirmed ccc64f0e Web deploy success and e43500f0 Worker deploy success. CI ccc64f0e failed only the shared/mobile version consistency job; Worker, Web, desktop, gateway, relay and end-to-end jobs succeeded.
- Aligned VERSION, web, mobile and Apple marketing versions with the prepared desktop 1.3.9. Version check, mobile lint/typecheck, core typecheck, final Web TypeScript and Vite build pass. This does not establish a signed 1.3.9 desktop release.
- Native production screenshot capture recovered. The authenticated app displayed creator/date and inline persona, and opened the profile dialog with picture/name/specialty/intelligence controls and disabled unchanged Save. No production profile data was changed. The earlier stale-shell inference is not established.
- Plain HTTP probe still returned Cloudflare 403 / error 1010. Official documentation identifies browser-signature denial; this does not establish an outage for authenticated native users. No security settings were weakened.
- Local native preview displayed the revised dialog spacing and action colors. Keyboard interaction did not reliably change its AX state; do not claim native keyboard verification. Temporary QA entrypoints and preview servers were removed/stopped before the final production build.

- Frozen Worker rerun completed successfully at e2166a6a: 204 files, 1509 tests, 590.12 seconds. The previous mixed-source failure is resolved on the fixed tree. Production native Cancel also returned to the unchanged profile successfully.

### Native light-theme check and CI recovery (2026-10-21)

- Reopened an isolated native preview using the production appearance/theme/App styles. Screenshot confirms white dialog surface, neutral fields, olive disabled action and 512px layout. Escape closed the dialog; reopening restored it. Subsequent repeated keyboard events did not consistently update focus, so complete native focus-loop acceptance remains unproven. No production data or provider calls were involved. Temporary preview files/processes were removed again.
- Observed Kylon Japanese profile labels are 専門分野 and インテリジェンス; aligned these translations.
- ca4dd1af CI shared/core/mobile job now succeeds after the version fix. Web, desktop, relay and gateway jobs also succeeded. Worker and E2E remain running; Deploy Web waits for matching Worker deployment. Run IDs: CI 39471093108, Web 39471093226, Worker 39471093391.

### Managed-agent editing policy consistency (2026-10-21)

- Audit found profile/skills editing restricted to maker/admin while persona and avatar routes still allowed any callable team agent to be changed. Saved Harness profiles now enforce the same maker/admin policy in those routes, independently of Simple/Harness presentation. Legacy unprofiled shared agents retain collaborative editing.
- Agent listings now expose canEdit consistently with this policy. Avatar permissions are checked before storing bytes and again before updating the agent. Existing private-agent visibility checks remain in force.
- Agents/Harness-agent regression: 49 tests pass, including persona refusal, avatar upload/delete refusal, no stored rejected upload, both modes, maker/admin success, and legacy shared editing. This closes a bypass; it does not implement independent Agent Admin/Member grants, transfer or last-admin invariants.

### Evidence reconciliation (2026-10-21)

- Japanese profile label update passes all 929 Web tests.
- GitHub confirms PR #486 merged at 2026-10-20 13:58 UTC, commit 82132822a6019ec5f97efa4287163e0318ca8d99. Git ancestry confirms it is included in both successfully deployed Web ccc64f0e and Worker e43500f0. Removed stale “unpublished/CI running” wording for its file-conversation and CSV-dark fixes without upgrading overall parity acceptance.
- New editing-policy full Worker suite remains live in session 96006, fixed source 66d2975c. No Worker source/test changes during that run.

### Descriptive intelligence chooser (2026-10-21)

- Native Kylon profile edit screenshot shows Fast/Pro/Max listbox options with descriptive text, selected checkmark, and a description in the selected field. Closed list then cancelled without modifying the reference agent.
- Replaced the plain select in Honmaru creation/edit/profile with a shared themed combobox. Added descriptions, selected checkmark, compact profile trigger, arrow/Home/End navigation, explicit commit, outside dismissal, first-Escape list dismissal and disabled protection. Fixed-position menu is clamped to the viewport to escape dialog scroll clipping, opens upward when needed and closes on surrounding scroll/resize. No reference cost ratios are asserted for Honmaru's configurable providers.
- Web 930 tests passed; added geometry and navigation/commit/Escape/outside/disabled tests. Subsequent resize-event guard targeted test passed. Native candidate preview was blank on this attempt, so visual acceptance remains pending. Temporary preview entrypoints/processes removed.

### Managed-policy full regression and chooser observation (2026-10-21)

- Frozen Worker suite at source 66d2975c completed: 204 files / 1510 tests passed in 459.84s. Web chooser final TypeScript and Vite build also passed.
- Restarted isolated native preview using explicit loopback IPv4. The new descriptive field rendered in the light-theme screenshot; AX showed all listbox candidates after activation. The subsequent screenshot did not show the menu, and the native tool later returned noWindowsAvailable. This is not sufficient to certify menu painting/placement; acceptance remains pending. Preview process/server and temporary entrypoints were removed.
- Prior ca4dd1af CI E2E completed successfully; Worker tests and matching deployment remained running at the latest inspection.

### Structured agent memory (2026-10-21)

- Added hx_memory_entries beside existing memory rows: title, description, multiline body (16,000 characters), version and update metadata. Existing short notes retain text/source/scope and read as version 0. Full-body deduplication prevents different long entries with identical 500-character prefixes from collapsing.
- Added maker/admin-only PUT editing with expectedVersion and atomic scope/text/metadata updates. Shared-vs-conversation identity must match exactly; stale writes return 409. FK cascade removes structured data on forgetting.
- Research-capable execution receives a bounded recent-memory index and read_agent_memory. The reader binds workspace/agent/user/room on the server and rechecks membership, agent grant and room access on every call. The non-research execution path keeps its legacy bounded short notes; complete equivalence across all providers remains unproven.
- Added detailed memory editor and expandable body, search across title/description/body, legacy conversion, failure draft retention and versioned client requests. Existing quick-add remains. Native visual acceptance and production deployment for this feature remain pending.
- Worker agents/Harness/research regression 57 tests passed; subsequent Harness suite with full-body deduplication and concurrent-writer test passed 20 tests. Web full suite 932 passed; final memory component/API suites 6 passed after one additional API serialization test.

### Deployment wait investigation (2026-10-21)

- ca4dd1af CI and Worker deployment succeeded. Its Web job still awaited the backend because the dependency helper, with no exact run for a Worker-path commit inside a multi-commit push, selected a newer pending descendant before the already deployed compatible descendant.
- Updated the helper to accept a proven successful descendant while newer compatible builds are pending. Exact failures and newest compatible failed runs remain failures; unrelated branches and commits never satisfy the gate. All 10 helper tests pass. Existing running workflows retain their checked-out helper, so this does not claim they were updated in place.

### Memory editor visual repair (2026-10-21)

- Native Japanese preview exposed a real layout defect: generic dlg-input height 36px overrode textarea rows, reducing the body to one line. Added dedicated editor theme/size styles, 72px description and 240px body, and a visible kind label with matching select styling.
- A new native light-theme screenshot shows multiline Japanese body, paragraph breaks, all fields and footer within the 1200×900 window. Cancel returned to the preview controls without saving. Dark-mode button automation then failed with elementHasNoFrame/noWindowsAvailable; dark visual acceptance remains pending. No production data or provider calls were used. Temporary preview files/server/process were removed.
- Structured memory full Worker run remains live in session 8595 at fixed Worker source 8e2840a6. These follow-up changes are Web-only.

### Dark native rendering and intelligence interaction verified (2026-10-21)

- Identified a preview-only difference: production desktop already sets backgroundThrottling:false, but the temporary Electron preview did not. Matching that setting restored stable AX and completed animation frames. Earlier dim screenshots are consistent with a paused preview animation, not evidence of wrong production theme tokens.
- Captured native dark memory editor with readable Japanese labels/body, preserved paragraphs, full-height textarea and olive action. Combined with the previous light screenshot, both themes are visually checked for this form at 1200×900.
- Captured the dark intelligence menu with descriptions, selected checkmark and upward placement. Found Max was incorrectly translated to 最大 through a generic dictionary key; tier labels now stay Fast/Pro/Max. Verified updated Max text, ArrowDown/Enter selection updating the draft and enabling Save, and Escape closing only the list while preserving the draft. No production data/model calls occurred.
- Temporary fixtures and preview processes were removed. Worker source remains fixed for full suite 8595.

- Final Web validation after native repairs: 128 files / 933 tests pass; TypeScript and Vite build pass.

- GitHub CI 39473592694 at 56cdf860 completed successfully. Worker deployment 39473592619 was still active; Web 39473592695 pending behind the earlier Web run, which uses the old dependency helper. Held subsequent commits to let these releases drain instead of extending their wait.

### Resumed validation and deployment reconciliation (2026-10-21)

- GitHub confirms CI 39473592694, Worker 39473592619 and Web 39473592695 at 56cdf860 all succeeded. Earlier ca4dd1af deployments also completed successfully; the old queue is drained.
- The previous local Worker session/log did not survive the environment restart. Its completion is unproven. Started a fresh frozen-source full suite; do not count the interrupted run as passing.
- Fresh Web regression: 933 tests pass. TypeScript and Vite build pass. Deployment dependency helper: 10 tests pass.
- Before restart, isolated dark memory editor at 390×844 showed title, description, type, multiline body and footer within the viewport. This is narrow desktop preview evidence, not mobile-device acceptance. Temporary QA entrypoints removed.
- Native production app displayed member/profile screens without changing user data. Reload then yielded a blank window with successful screenshot capture. Latest-shell visual acceptance remains unresolved; this is not a screen-lock finding.

- Native blank reload recovered after ordinary app quit/relaunch, without clearing storage or changing security settings. The latest deployed profile now shows 専門分野 / インテリジェンス and the descriptive dropdown. Dark screenshot verified visible options/checkmark; Escape closed only the dropdown and Cancel returned unchanged. Max still displayed 最大 on deployed 56cdf860, as expected before the queued fix. Reload reliability remains unresolved.
- Pushed structured-memory/editor/deployment-helper bundle as 66b6e422. CI 39564737472, Worker 39564737446 and Web 39564737444 started; no completion claim yet.

### Scoped memory search and reference recheck (2026-10-21)

- Frozen Worker regression for deployed candidate 66b6e422: 204 files / 1513 tests passed in 543.51 seconds, exit 0.
- Added search_agent_memory for entries outside the recent 40-entry prompt index. Literal-phrase search covers title/description/full body, returns at most 20 metadata summaries plus truncation flag, and keeps full bodies behind read_agent_memory. Workspace, agent and conversation are server-bound; every call checks current membership, agent grant and conversation access. No external search service or model request is introduced. This is not semantic retrieval or cross-provider completion.
- Rechecked native Kylon agent detail: Profile/Skills only in this account. Add Skills shows folder/ZIP import, author/name/type/description search and available/installed counts. No data imported or reference settings changed. Honmaru memory UI is functional work, not yet visually accepted against an observed Kylon memory screen.

- Search regression: Harness agents, memory scope, agent research and research suites all pass (4 files / 37 tests). Includes an older entry absent from the prompt, case-insensitive ASCII phrase match, literal wildcard handling, bounded results, cross-room/workspace denial and membership/agent-grant revocation. New search is not yet deployed.

### Skill icons and type search (2026-10-21)

- Native reference inspection showed distinct skill symbols and name/author/type/description search. Honmaru previously rendered every skill as a book and omitted metadata.type from search.
- Added local vector file-chart, palette, globe, rocket and map-pin symbols, semantic name defaults, and an allowlisted metadata.icon override. Unknown/imported URLs never load external images; no capabilities are inferred or granted from an icon. metadata.type now participates in catalog search; malformed non-string values are ignored.
- Native isolated 1200×900 preview verified the final list in both light and dark themes, including blue browser/location and purple understanding icons. This matches category distinctions, not proprietary brand artwork. No production skills or paid provider calls were created. Temporary fixture files and preview processes removed before build.
- Final Web regression: 129 files / 935 tests pass. TypeScript and Vite build pass. Tests cover type filtering and invalid/prototype/remote-URL icon metadata fallback.

### Manual memory audit trail (2026-10-21)

- Added registered audit events for successful manual memory creation/update/delete. Records actor, custom-agent identity, memory ID, kind/version or deleted count, and shared/conversation scope classification. Never includes title, description, body or conversation key/name. Duplicate creates, stale/denied updates and no-op deletes do not produce successful-change events.
- Tests found that audit entity type agent is reserved for a personal/API identity and obscures custom-agent IDs. New memory events use custom_agent; actor identity remains protected by the existing encrypted audit path.
- Harness agents, audit privacy and audit failure regression: 3 files / 28 tests pass. Checks decrypted audit entries, actor/resource identity, forbidden content absence, and admin-only log access. This covers manual memory routes; chat-created notes, automatic pruning and other execution lifecycles still need coverage. Existing audit delivery remains best effort, not transactional compliance evidence.
- Release 10c3ee15 (search and icons) is pushed: CI 39566569890 active; Worker 39566569838 and Web 39566569782 pending. Prior CI 39564737472 was superseded/cancelled; its independently gated Worker deployment 39564737446 completed tests and entered column migration. Earlier local frozen full suite remains 1513 passing. No claim of latest production completion.
- Company Harness remains incomplete: independent Agent Admin/Member, ownership transfer and last-human-admin invariants are still open, as tracked in KY-014.

### Migration inspection before redundant ALTERs (2026-10-21)

- Current migrations contain 131 statements, including 94 ALTERs across 29 tables. Added one batched PRAGMA table_info inspection and skip only simple ADD COLUMN statements whose table/column pair is positively present. CREATE/index statements, missing columns and unparsed SQL still execute in original order. Existing transient retries, duplicate-column tolerance and fatal-error results remain.
- Inspection failure, malformed JSON, unexpected result counts or unsuccessful queries fall back to individual migration checks. No user-table data is queried. Reference: https://developers.cloudflare.com/d1/sql-api/sql-statements/ .
- An initial table-valued PRAGMA query was rejected by actual local D1 with SQLITE_AUTH; replaced it with supported PRAGMA statements. Actual Wrangler local D1 verified two-table batched result order and exact existing-column identification in isolated /tmp storage. Eight helper tests pass, including fail/fallback cases and retained fatal errors. Production speed improvement remains unmeasured until deployment.
- GitHub confirms Worker 39564737446 and Web 39564737444 at 66b6e422 completed successfully. Search/icons release 10c3ee15 has begun its own CI and deployment jobs.

- Authenticated production native verification after 66b6e422: detailed memory dialog opens with dark themed title/description/kind/multiline body/footer. Japanese pasted title and paragraph-separated body render correctly; Save changes from disabled to enabled when required fields are present. Cancel returns to the zero-entry memory list without saving test data. A transient ScreenCaptureKit invalid-parameter error recovered via fresh AX observation; no unlock request was necessary. This verifies form behavior, not production persistence or provider retrieval.

### Independent agent-role foundation, not yet wired or published (2026-10-21)

- Added additive hx_agent_access version/mutation state and hx_agent_members with stable user IDs and admin/member roles. agentRoles.js reads roles only for active non-guest workspace members; maker remains an implicit admin. Writes recheck actor/target membership, current agent/profile, owner protection and a remaining human admin inside the D1 batch, with a version claim and per-mutation token so a losing writer cannot alter grants.
- Role foundation plus existing Harness-agent regression: 2 files / 27 tests pass. Covers delegation, member refusal, guest refusal, removed workspace member, stale writes, concurrent grant winners, last active admin refusal, and concurrent self-demotions leaving one admin.
- This module is deliberately not imported by production routes yet. Existing permissions are unchanged. It currently refuses personal/unprofiled legacy agents rather than broadening them silently. KY-014 stays incomplete.
- Next required integration: use role checks in mayAccessAgent/filterResponders, custom-agent persona/avatar/delete and client capability projection, plus Harness profile/memory/skill routes. Expose versioned member management through opaque workspace refs and a reviewed UI. Audit role mutations. Add ownership transfer/self-exit semantics and explicit personal-agent sharing; check workspace leave/rejoin handling so old grants are not accidentally revived. Verify every execution path and both modes before treating independent roles as available.

### Agent-role integration and restricted personal sharing (2026-10-21)

- Wired independent roles through visibility, responder filtering, Harness edits, persona/avatar/delete and both Simple/Harness client capabilities. Members can use an assigned agent; admins can edit it and manage roles. Role endpoints expose opaque workspace references, not raw identity IDs. Registered role-change audit events omit private agent content.
- Assigning a role to a personal agent atomically changes it to a shared agent with private access (maker plus assigned people), clearing any dormant broad profile policy. Returning to personal clears grants and advances the access version. Delegated roles bind to the workspace membership creation timestamp so leaving/rejoining does not revive them. The maker remains protected; the last active human admin cannot demote/remove themselves.
- Related backend integration: five suites / 72 tests passed, followed by seven role tests including personal reversion and restricted re-sharing. Full Worker regression running at the time of this entry. Web: 130 files / 938 tests pass; TypeScript and production build pass. Migration/dependency helpers: 18 tests pass.
- Isolated native Electron preview verified Japanese labels, light/dark surfaces, member selection enabling explicit sharing, conflict text and preserved input. Increased dark-mode explanatory text contrast. No production grants or test memberships were created. Save-success/refresh-failure now disables further saves until a successful reload.
- KY-014 is partial: ownership transfer, general-member self-exit, every execution path and production sharing persistence remain unverified/incomplete. The additional access dialog is not claimed as pixel-identical to an observed Kylon dialog.
- GitHub release 10c3ee15 Worker 39566569838 and Web 39566569782 succeeded. CI 39566569890 failed only its E2E channel-reading-position assertion; all other executed jobs passed. Downloaded logs identify a reader scrolled up being pulled to the bottom. Updated the React scroll handler to release following before its state update can trigger the mutation observer; the next CI E2E must validate this correction.

- Frozen Worker integration regression completed: 205 files / 1,523 tests pass in 558.55 seconds. Final UI sharing-refresh correction has four dialog tests passing and TypeScript/build success (previous full Web: 938 tests; one regression added afterward). Release 39b83393 pushed to main: CI 39570998153, Worker 39570998080 and Web 39570998203 are queued at this checkpoint. Production completion and the E2E scroll correction are not yet confirmed.

### Ordinary member management and self-removal (2026-10-21)

- Rechecked https://docs.kylon.io/agents/access . Ordinary named Members may add/remove ordinary Members; admin promotion/demotion/removal remains Admin-only. Updated both the preflight decision and atomic D1 version-claim predicate. A concurrent promotion prevents a stale member removal from removing the new admin. Maker protection and last-human-admin checks remain.
- Member UI offers ordinary-member operations without an Admin selector. Remove myself prepares a removal that still needs Save. Successful self-removal closes directly, avoiding an expected 404 being reported as a refresh failure; the parent reloads its directory. A separate workspace-wide grant may still allow access. No ownership transfer or agent-to-agent grants yet.
- Backend: five related suites / 76 tests pass. Web: 130 files / 940 tests pass; TypeScript and production build pass. Tests include opaque-ref API operations, own removal, escalation refusal, concurrent promotion/removal, and resetting a dormant everyone/people profile during restricted personal sharing.
- Native isolated fixture verified light/dark member list, explicit self-removal selection and successful close. No real membership or access changes were made during UI verification. Prior release 39b83393 Worker deployment is in its Test step; CI/Web still queued at this checkpoint.

### Owner transfer with immutable creator attribution (2026-10-21)

- Added versioned owner-only transfer to another active human Agent Admin. The D1 batch rechecks ownership, live membership, recipient role, agent/profile scope and version. The previous owner remains a named Admin and can subsequently remove themselves. Concurrent transfers have one winner. Ownership transfer has a registered audit event with opaque member reference and version.
- Added nullable custom_agents.created_by_login via schema plus migration; first transfer retains the original owner in it. Client creator attribution uses that immutable value, while mine/ownership permissions use the current owner. Simple mode now distinguishes createdByMe from mine so a recipient is not mislabelled as the creator. Legacy rows use the existing owner until first transfer.
- UI exposes transfer only to the current owner, lists existing Admins as recipients, requires explicit submission and retains a conflicting selection. Native isolated preview found a clipped member list in the taller dialog; prevented list flex-shrinking and verified body scrolling, disabled/selected transfer action, new owner label and former owner's self-removal action. No production ownership changed during verification.
- Targeted Worker: three suites / 68 tests pass, including client attribution, API owner restriction, stale version, concurrent transfer and former-owner exit. Web: 130 files / 941 tests pass; TypeScript and build pass. Full frozen Worker regression is running in /tmp/honmaru-transfer-worker-full.log. No claim of production availability yet.
- Prior release 39b83393: gateway, relay, shared/mobile, web and desktop CI jobs have passed; Worker and E2E are running. Worker deployment is testing; Web deployment awaits it. Latest general-member and ownership additions have not been pushed yet, to retain that E2E result.

- Additional transfer verification: actual local Wrangler D1 applied the nullable creator column to a preexisting custom_agents table and retained its legacy row/owner unchanged. Added a parent-screen regression proving that closing access reloads the directory and dismisses an agent after revocation (two HarnessAgents tests pass). Localized owner/membership validation failures; TypeScript/build pass.
- Downloaded completed E2E job logs for CI 39570998153: ALL PASSED, including the formerly failing channel newest-message/reading-position test. At this checkpoint Worker deployment has passed testing and migrations and entered Deploy; Web still depends on that result. Local ownership full-suite session remains live, not restarted.
- Kylon native reload briefly showed a blank page; normal quit/relaunch restored the authenticated workspace. Rechecked its profile: this account still exposes Profile/Skills only. Access-dialog visual equivalence remains unverified despite the public access specification; no reference data was changed.

- Ownership integration full Worker regression completed: 205 files / 1,529 tests pass in 553.97 seconds. A final wording correction changes the protected-role error from maker to owner; targeted role tests follow it. Full result log: /tmp/honmaru-transfer-worker-full.log.
- Release 39b83393 Worker 39570998080 and Web 39570998203 completed successfully. Authenticated native production restart retained the workspace/session and opened the new access dialog: creator list, Japanese fields, dark surfaces and disabled Share and save without a selection are correct. Closed without granting access. This proves production read/UI loading, not ownership transfer or cross-user persistence (those additions remain unpublished).

### Separate workspace administration from managed-agent editing (2026-10-21)

- Found and removed a remaining workspace-admin bypass for callable agents with a saved Harness profile: profile, persona, avatar and deletion now require the owner or an explicit Agent Admin role. Client edit/delete capabilities match. Returned save/avatar objects now carry the profile-policy marker as well as the role. Legacy unprofiled Simple agents retain shared editing and workspace-admin deletion.
- Updated the old regression that implicitly treated workspace administration as Agent Admin. Tests explicitly grant the agent role before asserting edit success. Added denial checks in both modes for a workspace admin with ordinary agent membership; explicit promotion enables editing, and demotion revokes it again. Read-only UI regression confirms no profile/advanced-edit controls.
- Five related Worker suites / 80 tests pass. HarnessAgents two tests and TypeScript pass. Full Worker regression running in /tmp/honmaru-admin-separation-full.log (session 17136); do not restart merely because no incremental test output appears. No further Worker source changes during that run.
- Release 3d4de4b3 is already pushed: CI 39574218157, Worker 39574218123, Web 39574218054. At this checkpoint web/desktop/shared/mobile/gateway/relay CI jobs passed, Worker/E2E run, and Web deployment waits for Worker. This additional admin-separation fix is not yet published.
- At this 2026-10-21 checkpoint, remaining role gaps included workspace-member-removal handoff (team removal can currently orphan an agent), automatic membership-pruning/account-deletion lifecycle, agent-to-agent role grants, access-request approvals and restricted directory metadata. Access-request approvals were subsequently implemented in the 2026-10-26 entry at the end of this file; the other gaps remain part of the full Company Harness target.

### Workspace departure lifecycle audit (2026-10-21)

- Rechecked https://kylon.io/help/removed-member-content: removal and self-departure preview responsibilities and select a successor. Room administration, agent administration/ownership and custom skills require handoff; apps and automations persist, and computers lose access. Connection ownership also needs an explicit lifecycle rather than accidental deletion.
- Current `worker/src/team.js:removeMember` deletes membership, then removes connections, room/group membership and sidebar state. It does not transfer managed-agent ownership or named administration. `web-react/src/screens/Team.tsx` sends only the member reference; it has no responsibility preview or successor selection. This is an open parity gap, not covered by the new standalone agent-owner transfer.
- Other entry points needing the same policy are repository-membership pruning in `db.js:retainMemberships` and account deletion in `account.js`. The failed-join rollback in `domains.js` is a separate operation and should not transfer resources.
- Acceptance requires atomic live membership/role checks with removal and handoff, stable creator attribution, no recipient who is concurrently departing, and an actionable conflict when responsibilities change after preview. Cover both self-departure and admin removal, remaining room/agent admins, node token revocation, repeat requests and rejoining without old grants. No real member was removed during this audit.
- Additional admin-separation web regression: 130 files / 942 tests pass (`/tmp/honmaru-admin-separation-web-full.log`). Native production access dialog is reachable with the existing authenticated session; screen capture works. This check does not claim the unpublished admin-separation build is already live.
- Frozen admin-separation Worker regression completed successfully: 205 files / 1,530 tests in 567.40 seconds (`/tmp/honmaru-admin-separation-full.log`). Production web build also passes. The prior ownership release's GitHub E2E job passed; its Worker/deployment runs are tracked separately from these local results.

### Managed-agent handoff during workspace departure (2026-10-21)

- Added an authorized `/members/departure` preview, sharing the removal authority checks. It lists live managed-agent ownership/administration, an opaque preview version and eligible human successor references. It excludes ordinary grants, stale grants from an earlier membership, deleted/provider agents and legacy unprofiled Simple agents. No agent instructions or identity IDs are returned by the preview.
- Removal now claims a nonce receipt and transfers managed-agent responsibilities in the same D1 batch as membership deletion. It rechecks actor/target membership age and roles, last workspace owner, recipient membership and the entire responsibility snapshot. A conflicting or missing handoff leaves both agents and membership unchanged. New owners retain original creator attribution and existing visibility; successors receive named administration. Departing explicit grants are removed. Existing member audit events record only successor reference and transferred count.
- Team removal/self-departure opens a dialog with an expandable agent list, role labels and required successor selection. Preview errors disable removal; submission errors retain the selection. Native isolated preview verified light/dark appearance, long-name wrapping, selection gating and successful completion with a local mock. No production members, grants or owners were changed in this verification.
- Related Worker/migration tests: three suites / 45 pass, including permission denial, stale preview, recipient departure during the transaction, newly assigned responsibility after an empty preview, owned-agent transfer and delegated-admin transfer. A multiline migration statement initially failed the existing deploy parser test; changed it to the repository's one-line migration format and reran successfully. Web: 131 files / 944 tests pass; TypeScript and production build pass.
- Full Worker regression started with frozen source in `/tmp/honmaru-departure-worker-full.log`, session 87496. This departure implementation is not yet pushed or deployed. Prior admin-separation release a2cd35fe remains in CI 39576116892 / Worker 39576116862 / Web 39576116891 at this checkpoint.
- This completes only the managed-agent portion of workspace departure. Room and custom-skill administration, connection ownership continuity, node revocation, repository membership pruning/account deletion, legacy Simple ownership lifecycle and full multi-user production verification remain open; do not describe this as complete Kylon offboarding.

### Skill ownership and permanent computer revocation on departure (2026-10-21)

- The frozen agent-departure regression finished with 204 passing files / 1,536 passing tests and one failure: a concurrent last-owner departure correctly retained membership but returned `departure-conflict` instead of the established `last-owner` code. Restored the specific reason after a failed transaction claim; the original concurrency regression passes unchanged.
- Added nullable `hx_skills.owner_id`, falling back to the immutable creator for legacy rows. Departure preview and its atomic snapshot now include owned custom skills. Transfer changes ownership, increments sharing versions and preserves visibility, files/content and creator attribution. Skill reads, sharing and edit/delete controls use the current owner. Mutations recheck live membership/ownership, including an ownership change between read and write. Current-owner account IDs are not added to client responses.
- The same departure transaction permanently revokes computers registered by the departing member and cancels their queued/running jobs, including other requesters' jobs on those computers and the departing requester's jobs on other computers. Unrelated computers and jobs remain unchanged. A rejoining owner cannot reuse the revoked token. Automatic GitHub membership pruning/account deletion still require equivalent lifecycle handling.
- UI adds a collapsible custom-skills list and explains computer disconnection. A skill-only departure still requires a successor. Added pending-submit/close and stale-response regressions; native isolated preview checked both themes, collapsed lists and readable explanatory text without changing real memberships or tokens.
- Five related Worker suites / 72 tests pass, including existing owner concurrency, skill read/write ownership races, private skill transfer/rejoin, token revocation/rejoin, unaffected jobs and legacy skill migration replay. Web: 131 files / 947 tests pass; TypeScript and production build pass. Full frozen Worker regression now runs in `/tmp/honmaru-skill-departure-worker-full.log`, session 52874. Do not modify Worker source or restart that live run merely for quiet output.
- Prior admin-separation release a2cd35fe is fully successful: CI 39576116892, Worker deployment 39576116862 and Web deployment 39576116891. The departure changes are still local pending their full regression and deployment.
- Remaining departure gaps include room administration, independently delegated skill administration, connection continuity, automatic membership pruning/account deletion, legacy Simple ownership and multi-user production verification. No claim of complete Kylon parity.

### Room administration reference audit (2026-10-21)

- Read https://kylon.io/help/member-and-admin-permissions and inspected the authenticated Kylon general Room. The header has a separate member-count button. Its centered Room members dialog offers Add member, avatar/name rows and per-row role menus; the agent row is an Admin and offers Make member / Remove member. The human owner row displays Admin without a role control in this observed state. No roles or memberships were changed.
- The Room menu separately opens Room settings: icon, a disabled name for the all-members Room, mentioned-only response switch, collapsed Webhook section and Cancel/Save footer. This account's default Room does not expose archive/delete in the observed menu. Closed settings without saving. Do not infer that all ordinary Rooms have the same disabled controls.
- Official room-specific rules distinguish ordinary editing/member management/archive from Admin-only role changes, public/private changes and deletion. Workspace admins may archive/delete even from outside a Room; this must not grant message-reading access. Default/fixed-membership rooms require separate lifecycle restrictions.
- Honmaru currently stores creator attribution in `businesses.created_by` and presence in `conversation_members`; neither is an independent room-admin role. Its channel details show people/tools in a side panel, and private-member removal currently lacks an Admin-versus-Member distinction. A proper implementation must add live membership-bound roles, controls matching those capabilities, admin-removal/last-human-admin protections and atomic departure handoff. Merely rewriting creator attribution is not room-role parity.
- The general help page's broad agent-deletion wording differs from the more specific independent-agent access documentation. Keep that discrepancy explicit; do not silently undo tested private-agent restrictions or infer read access from workspace administration. Restricted directory/administrative deletion needs a separate policy audit.
- The observed default/all-members Room still offers Remove member on its agent row, while the human owner has no role menu. Fixed-membership restrictions therefore must distinguish the relevant human/agent subject and room policy; a blanket ban on every member action would not reproduce the observed interface.

### Departure release validation (2026-10-21)

- Frozen agent/skill/computer departure Worker regression completed: 205 files / 1,542 tests pass in 557.97 seconds (`/tmp/honmaru-skill-departure-worker-full.log`). The previously failing concurrent-last-owner test passes unchanged.
- Final review found that a supplied preview version was ignored when there were no responsibilities. Now any supplied stale version is rejected, including when the person left/rejoined after opening an empty preview. Older clients may still omit a preview for an empty departure. Added that regression; the final change passes team/owner suites, 39 tests (`/tmp/honmaru-empty-departure-tests.log`). Deployment CI will repeat the full suite against this final commit.
- Authenticated native production access-list read succeeded against the prior a2cd35fe deployment. Owner label and Japanese role explanations display correctly. No production grants or members were changed; the new departure flow awaits deployment and is not claimed live at this checkpoint.

### Independent room-role foundation (2026-10-21)

- Added internal `roomRoleState`, `initializeRoomRoles` and `setRoomRole` helpers plus additive `hx_room_access` / `hx_room_roles` tables. These are not exposed through a route yet: existing Simple room behavior is unchanged, and no live room is initialized by this commit.
- Models human and agent Admin/Member roles independently from workspace/agent administration. Human grants bind to workspace membership and, for private rooms, that room membership; agent grants bind to the current room assignment and agent identity. Guest administration is refused. Only an active creator may initialize an unmanaged room. Role mutations require a live human Room Admin, use version/nonce guards and preserve at least one human admin.
- Two suites / 14 tests pass (`/tmp/honmaru-room-roles-tests.log`), covering migration replay, initialization authority, agent administration, last-human protection, stale membership/assignment grants, concurrent edits and a target rejoining between read and transaction.
- Required next integration before exposing this publicly: guard member/agent removal and room deletion/privacy controls; preserve/rebind grants during privacy transitions; implement atomic departure handoff; provide capability-driven role menus matching the observed Kylon dialog. Public-room explicit membership versus all-workspace/default-room membership still needs reference verification. Archived-room lifecycle and agent tool actors also remain to be integrated. Do not claim room-role feature parity from these isolated helpers.
- Departure release a2c32f40 is on main. CI 39580238057 has passed desktop/web/shared-mobile/gateway/relay; Worker and E2E run. Worker deployment 39580238150 and Web deployment 39580238110 are still in progress at this checkpoint.


### Managed room membership removal — 2026-10-21

The existing human and agent removal endpoints now apply managed room roles. Ordinary members cannot remove an admin; the last active human admin cannot leave even when an agent is an admin. Membership removal and role cleanup share a versioned D1 transaction, including a live membership fingerprint check so a concurrent rejoin is retained. Unmanaged Simple rooms and group conversations keep their existing removal behavior.

Validation: room role unit and HTTP integration tests plus existing closed-conversation and agent suites: 3 files, 47 tests passed. Covers admin removal rejection, self-departure after handoff, agent admin removal, last-human protection, concurrent rejoin, and unchanged legacy paths. No production members were removed during verification.

This remains backend groundwork: room-role initialization is not exposed in the UI/API until managed room deletion, privacy transitions and workspace departure handoff also enforce the same rules. Therefore this is not a claim of completed room UI or 100% parity.


### Deployment and reference follow-up — 2026-10-21

For a2c32f40, Worker deployment run 39580238150 passed 205 suites / 1,543 tests, then failed during Cloudflare D1 schema import with `Not currently importing anything.` Web run 39580238110 correctly stopped rather than publish against an unconfirmed backend. The CI E2E failure was the workspace-removal step still locating the retired inline `.pill-btn`, not a failed browser download (the latter recovered through a fallback). Updated it to use the departure dialog's enabled confirmation button, retaining the actual member removal and live socket eviction assertions.

Published b3de38b4 to main. Worker run 39581977613 and CI run 39581977628 started. Requested Deploy Web for current main through workflow_dispatch (HTTP 204), so it waits for this release's Worker rather than retrying the failed exact older dependency. Local full Worker validation is running from the frozen 62cfb035 sources in `/tmp/honmaru-room-worker-full.log`. No successful deployment of b3de38b4 is claimed yet.

Native Kylon reference: chat's New menu explicitly contains New thread, New room, Join public room, New agent, Invite member, and Invite your agent. The room-creation dialog is a three-step flow, approximately 512px wide. Step one has stacked public/private selection cards, a footer progress indicator, Cancel and Next. Public says all workspace members can access; private says invited members only. This confirms public read access but does not establish whether membership/notifications are automatic: the separate Join public room action requires keeping access and joined state distinct. Inspection stopped without creating a room.

Managed-room rollout dependencies: enforce deletion with an atomic policy-version claim; remove membership/role/assignment rows in the same transaction and prevent recreation from inheriting old roles; handle archived resources during workspace departure; transfer private-room administration only to a person with explicitly permitted membership; rebind active grants during privacy changes so switching private/public cannot revive stale grants. Expose initialization and member-role editing only after these paths are covered. Simple mode is a presentation choice, never a bypass for a managed room's security policy.


### Additional room-creation reference and deployment correction

Kylon's second creation step shows a room color picker, name field, and Guidelines textarea with a 4,096-character counter. Step three explicitly states that all workspace members can view a public room, while separately selecting the initial members. It includes member search, Select all, human/agent avatar rows, selection count and Create. The observed agent Aris was initially selected. The form was closed with Escape without creating a room. This strengthens the distinction between public read access and explicit joined membership; the room-role foundation's public-membership model must be updated before activation.

Correction to the preceding deployment expectation: Deploy Web workflow_dispatch does **not** execute its Worker-dependency gate (both gate steps currently have push-only conditions). Run 39582144951 deployed b3de38b4 Web successfully while Worker 39581977613 was still running. This is not combined production completion. Do not use manual Web dispatch before verifying its matching Worker in future. The push gate remains intact; no workflow protections were changed. The prior statement that this manually dispatched run would wait was incorrect. The new departure dialog fails closed if preview loading fails. Worker completion and the authenticated preview still require verification.


### Explicit public-room membership — 2026-10-21

The frozen 62cfb035 Worker tree passed the full local suite: 206 files / 1,552 tests in 527.61s. CI b3de38b4's End to end job then passed with the updated departure dialog confirmation.

Follow-up changes now separate managed public-room joined membership from public read access. Human room roles always bind to an explicit conversation membership and its join stamp, regardless of visibility. Initialization atomically joins an eligible public-room creator and grants their first admin role. Leaving a managed public room removes membership and roles under the existing version claim, without revoking ordinary workspace members' public reading rights. Private/public transitions preserve current grants but cannot resurrect grants attached to a previous join. Unmanaged Simple rooms still use the previous behavior; no public role-initialization API is exposed yet.

Validation: 3 suites / 50 tests passed, including the actual managed public-room leave HTTP endpoint, public access after leaving, fresh membership without revived admin rights, privacy toggles, and the existing private/group/agent suites. Latest local verification logs: `/tmp/honmaru-public-room-endpoint-tests.log`; the earlier full-suite evidence applies to 62cfb035, not to these subsequent edits.


### Managed room deletion lifecycle — 2026-10-21

Managed room deletion now requires a live room admin or a workspace admin/owner. The workspace lifecycle permission does not grant private message reading. The D1 transaction rechecks policy version, actor membership and current role, including archived rooms, so a demoted or departed actor cannot complete a stale deletion.

A deleted managed room retains an archived/private business row and a deleted policy marker. This is necessary because legacy conversation access is keyed by the room slug: physically removing that row could make old messages public or attach them to a recreated name. Deletion clears joined members, agent assignments and room-specific role/guideline/response settings. It retains historical content and existing card attribution under the closed room instead of unfiling managed-room cards into public workspace visibility. Normal Simple room deletion remains unchanged.

Same-name creation cannot revive a deleted managed room. Adding members is guarded inside the insert. Admin API lists exclude deleted rooms, and its member/restore/rename paths cannot repopulate or restore them. Legacy card recipients/senders retain the existing right to their own cards. The normal UI still does not expose managed-role initialization: default-room protection, workspace departure handoff, public join UI, full room creation and the remaining administrative mutation paths must be completed before enabling it. A future managed creation API must use stable unique IDs rather than reuse deleted slugs, allowing the same display name without reusing historical identity.

Validation: 5 related suites / 78 tests passed, followed by 3 suites / 40 tests after final defensive changes. Covers HTTP authorization, archived private-room lifecycle administration, demotion races, same-name recreation denial, retained private read boundaries, admin API restoration denial, and schema migration replay. Full Worker validation will run on the committed snapshot. No real production rooms or memberships were deleted.


### Room creation UI reference implementation — 2026-10-21

Added RoomCreateDialog as a not-yet-connected component, following the observed Kylon three-step creation flow: public/private choice, color/name/4,096-character guidelines, then searchable human/agent membership selection. The 512px dialog includes progress dots, back navigation, filtered select-all, selection count, pending-write close protection, duplicate-submit protection, a stable request identifier for backend idempotency, and retained input/selection on failure. Shared SVG icons now include room, private room and bot glyphs; Japanese copy was added.

Native Electron fixture verification covered light and dark appearance, visibility steps, name/guidelines entry, color selection and a deliberately rejected local save retaining members. No production API was called by the fixture. The temporary fixture files and Vite/Electron processes were removed/stopped. All Web tests passed (132 files / 949 tests), TypeScript and production Vite build passed. The component is intentionally not presented as a working production creation flow until its atomic backend and remaining role lifecycle paths are connected.

Release b3de38b4: Worker run 39581977613 and its CI Worker job in run 39581977628 completed successfully; the E2E job already passed. Web run 39582144951 had completed successfully. The newer local room-deletion/explicit-membership changes and RoomCreateDialog are separate, not part of that deployed revision.


### Resume validation and deletion races — 2026-10-23

The frozen 5f84c223 full Worker run completed successfully: 206 suites / 1,561 tests in 540.71 seconds. A subsequent review found that a deletion retry could treat a managed tombstone as an unmanaged room because active role-state reads exclude deleted rooms. Added an explicit policy check before returning a legacy fallback. Also guarded the legacy physical DELETE in SQL against any managed policy initialized after the route's initial read; a rejected delete now stops before membership cleanup or card unfiling. Three targeted suites / 39 tests passed, including retry and initialization-race regression coverage.

Fetched origin/main on resumption: remote advanced to eb2e7e36 with agent-thread mention behavior and signed iOS release changes. These must be integrated without overwriting their changes before publishing this branch. The previous full-suite evidence predates that integration.


### Managed-room activation path audit — 2026-10-23

Before connecting RoomCreateDialog, the following concrete mutation paths remain open and must share managed-room lifecycle rules:

- `adminApi.js:changeChannelMembers` still calls the legacy access-layer remove helper directly, including batch removals. It needs one atomic version claim for the entire requested set, preserving at least one eligible human admin; sequential removals can otherwise partially succeed before a later rejection. Adding and removing the same member must have an explicit, deterministic rule.
- `team.js:changeRole` can demote a room admin to guest and delete public joined memberships. The live last-admin invariant must be checked inside the membership update, and stale grants must not revive if the person later becomes a member again.
- `memberDeparture.js` snapshots only managed agents and owned skills. Add active, nondeleted managed room responsibilities (including archived rooms), successor eligibility for each room, snapshot/version gating, and role handoff in the same departure transaction. Do not implicitly invite a successor into private rooms merely because they are a workspace admin.
- `adminApi.js` and `scim.js` workspace removals call the shared departure function but currently provide no resource preview/successor. Their external protocol needs a clear conflict response or explicitly configured successor policy.
- `db.js:retainMemberships` and `account.js` delete workspace memberships directly. They cannot inherit the shared function's protection without explicit integration; avoid claiming coverage from ordinary member-removal tests.

Room creation should use a new stable opaque room identifier, an idempotency receipt bound to actor and canonical request, and one D1 transaction to insert private/public room metadata, joined humans/agents, initial human admin, color and guidelines. The existing Simple name-based upsert remains separate. Only expose the UI once the above lifecycle paths and creation transaction are covered.

RoomCreateDialog now preserves the request identifier for identical retries and changes it for edited drafts, with member identifiers sorted for canonical submission. Filtered Select all exposes mixed state and keeps hidden selections. Four UI tests and TypeScript passed. The merged Worker suite is still running under session 47835; this audit does not claim it completed.


### Atomic admin API room membership changes — 2026-10-23

Merged Worker snapshot 09450d93 passed all 206 suites / 1,563 tests in 437.73s. Subsequent implementation adds managed-room member edits to the admin API: adding and removing are gated by one room-version claim, the full live role/membership snapshot, and the added members' workspace membership stamps. A rejected removal cannot leave additions partially applied. The last eligible human admin is retained; an ordinary room member cannot remove admins; archived/deleted managed rooms never fall back to legacy mutation. Workspace API authority does not implicitly grant room-admin membership.

Targeted verification passed 2 suites / 36 tests, including the real admin API's rejected last-admin removal with an addition, subsequent successful addition, and a rejoining add target causing no partial changes. Remaining activation dependencies in the prior audit still apply, especially guest demotion and workspace departure handoff. These changes are not yet deployed.


### Guest demotion and room administration — 2026-10-23

Workspace role changes to guest now include a live SQL last-human-room-admin condition. It includes archived, nondeleted managed rooms and valid workspace/room join stamps; agent admins cannot replace the last human. A successful guest change increments affected room policy versions and clears that person's room grants in the same D1 batch, so subsequent promotion to ordinary membership cannot restore old room administration. Existing owner checks and Simple behavior remain in place.

Verification: room roles, team, owners and guest limits suites passed (4 files / 68 tests). The new regression verifies rejection before a successor exists, successful demotion after another human is made admin, and no grant resurrection after promotion. Remaining limitations: automatic membership pruning/account deletion and full workspace departure handoff still need integration; no managed-room creation API is enabled yet.


### Room administration in workspace departure — 2026-10-23

Departure responsibilities now include valid human administrator grants in managed nondeleted rooms, including archived rooms. Room policy versions are part of the reviewed snapshot. Eligible successor choices must already belong to every affected room; the server repeats this check, and the departure transaction verifies membership before granting successor administration and removing the departing person's grants/membership. No private-room invitation is implicit. The UI lists room responsibilities and requires a successor even when there are no agents or skills. Existing no-room handoff response shape is preserved.

Validation: Worker room/team/owner suites passed 64 tests; departure UI passed 6 tests; TypeScript passed. Concurrent guest-demotion regression also proves two human admins cannot both become guests in an archived room even when an agent remains admin. Remaining review: successor room rejoin stamps during handoff, automatic pruning/account deletion, creation API and production connection. This is not deployed yet.

### Explicit public-room joining — 2026-10-23

Added authenticated `POST /channels/join` for managed public rooms. A single D1 transaction checks current public/unarchived/nondeleted state and nonguest workspace membership, increments the room version, removes obsolete person grants, and inserts the caller's explicit room membership. Repeated and simultaneous joins are idempotent. The endpoint cannot join a different user through request fields. Simple rooms retain their existing behavior. Departure UI now explains that successors must already belong to every listed room and gives the correct action when there are no eligible candidates.

Validation: room roles suite passed 30 tests, including duplicate joins, stale admin grants, guest/nonmember/private/archived/deleted/legacy rejection, authenticated route behavior and privacy changing before commit. Departure UI passed its 6 existing tests. The second supplied test filename did not exist; the 30-test result covers only room-roles.test.js. The earlier successor join-stamp guard also passed room/team suites (55 tests). Public join UI, managed creation, remaining lifecycle paths, full regression and deployment are still pending; this entry is not production verification.

### Public-room discovery and join UI — 2026-10-23

Harness New menu now opens a search dialog backed by authenticated `/channels/public-rooms` and `/channels/join`. Discovery excludes private, archived, deleted and unmanaged rooms, requires a current nonguest workspace membership, and counts current human memberships rather than stale join rows. UI excludes already-joined rooms, preserves search on failure, prevents duplicate submits/closing during enrollment, and ignores late navigation after workspace unmount. Simple's menu remains unchanged.

Native Kylon inspection confirmed the public-room entry uses a search icon, a 512px centered dialog, public-room search input, no ordinary footer, and an empty state when there are no unjoined rooms (general was already joined). Updated our initial implementation to exclude joined rooms and match that structure. Locally inspected the real component in an isolated Electron fixture in light/dark themes and searched for an already-joined room; corrected clipped focus styling. Fixture made no production API requests and was removed afterwards. Kylon had no unjoined room rows available, so populated-row visual parity is not yet verified.

Validation: room roles/discovery 31 tests and RoomJoinDialog 3 tests passed; TypeScript and Vite build passed. Full regression and production deployment remain pending. Managed creation and remaining lifecycle protections are still incomplete; the UI does not imply 100% parity.

### Release regression checkpoint — 2026-10-23

At code revision 4ccfd36c (subsequent 623fa4e9 changes documentation only), full Worker regression completed successfully: 206 files / 1,576 tests, 701.63 seconds, exit 0 (`/tmp/honmaru-room-join-worker-full.log`). Full Web regression: 133 files / 955 tests (`/tmp/honmaru-room-join-web-full.log`). TypeScript and Vite build also passed. No Worker source/test edits occurred during the full run.

Before this release, GitHub API confirmed production Worker run 39758211720 and CI 39758211514 on eb2e7e36 succeeded; the latest Web deployment remained 39582144951 on b3de38b4. Pushing this release must be followed by its own Worker, Web and CI result checks; local tests do not prove production deployment.

### Room member count follow-up — 2026-10-23

Public-room discovery now counts active assigned agents alongside current human workspace members. Deleted agents and stale human membership rows do not inflate the displayed count. This aligns the roster concept with the observed Kylon room header (one human plus Aris = two members). Room role/discovery suite passed 31 tests, including removal of a workspace member and soft deletion of an assigned agent. This follow-up is local while release 4bb40836 deploys; the populated Kylon discovery row remains unobserved.

Release 4bb40836 was pushed to main. GitHub started Worker 39897252414, CI 39897252362, and Web 39897252380. All were in progress at the last check; deployment success is not yet established.

### Managed-room invite route — 2026-10-23

The existing `/channels/members` POST now accepts managed public rooms and uses their explicit membership list instead of their public reading audience. Managed additions go through the same transactional authorization/snapshot helper as admin API changes. A public reader or guest cannot invite someone merely by reading the room; an eligible joined ordinary member can. Existing private Simple additions retain their fallback behavior. Route regression verifies denied outsider/guest attempts, successful ordinary-member invitation, and duplicate invitation returning zero. Room/admin API suites passed 47 tests.

Release 4bb40836 status: Desktop, Reference web client, Shared core/mobile, Reference relay and Local gateway CI jobs passed; Worker and End to end remained in progress, as did Worker/Web deployment. This follow-up is not part of that release. Before managed creation activation, agent-add authorization, legacy initialization races, remaining lifecycle routes and default-room policy still need review.

### Managed-room agent invitations — 2026-10-23

Managed agent additions now claim the room version and verify current nonguest explicit room membership, the actor's join stamp, live agent scope/profile/people/individual grants, and duplicate handles inside the write transaction. Successful additions clear obsolete room-agent grants before inserting the assignment. Failed access or membership checks change nothing. The legacy insert now refuses any managed-room policy, closing the initialization race between fallback selection and insertion; Simple/group behavior remains on its existing path.

Validation: room roles, agents and Harness agents suites passed 94 tests. Regressions cover reader denial, readdition without revived admin role, access becoming personal before commit, people-based sharing, current/stale explicit grants and legacy insertion after policy initialization. This follow-up is local and not yet deployed. Release 4bb40836: Worker deployment and CI Worker were testing; E2E was running; Web correctly waited for the matching Worker deployment.

### Human invitation fallback guard — 2026-10-23

Added an explicit legacy-only option to the low-level membership insert, used by the interactive channel-member route after its unmanaged check. The SQL refuses insertion if a managed policy appears before the batch, and the route returns conflict rather than announcing a successful addition. Trusted onboarding/domain and other existing callers retain their current behavior; those lifecycle paths still require separate review. Room, invitation and channel suites passed 51 tests. Release 4bb40836's Worker, CI and Web runs were still in progress at this check; no newer commit was pushed to cancel that CI.

### Atomic managed-room creation core — 2026-10-23

Added `createManagedRoom` with request-bound receipts, opaque room IDs independent of display names, persisted color, and a single D1 batch covering room visibility, room policy, creator administration, selected human/agent membership and guidelines. Canonical duplicate submissions return the same room; a changed draft cannot reuse the request ID. Deleted-room retries cannot recreate old history, while a new request can reuse the display name with a distinct identity. Creator and selected people join stamps/roles are checked inside the transaction, as are current agent access and duplicate handles. Private agent addition does not implicitly grant agent access to other people.

Creation/room suites passed 45 tests (8 creation tests), including simultaneous retries, deleted-room retry, same-name new identity, guest/invalid selections, membership/agent access races, rejoined-creator replay and injected transaction failure rolling back every row. The schema/migration adds only `hx_room_creations`. The core is not exposed by an HTTP route or connected to the dialog yet: remaining lifecycle access paths must be reconciled before activation. Local changes are not included in the in-progress 4bb40836 deployment.

### Managed-room archive lifecycle — 2026-10-23

Managed room archive/restore now checks explicit eligible participation or current workspace owner/admin authority. Public reading alone does not grant archive rights. The batch binds the actor workspace/room membership stamps and room version, preserves membership/roles, and rejects deleted tombstones. Workspace admins may archive/restore a private room without joining or gaining reading access. Existing `/businesses/archive` and `/businesses/unarchive` routes use the helper; their legacy writes refuse a newly initialized managed policy. Simple behavior remains otherwise unchanged. Default-room policy and admin API archive routing still require separate integration.

Room, businesses and audit-archive suites passed 60 tests, including an HTTP public-reader denial and joined-member archive/restore. Release 4bb40836 E2E completed successfully; other required CI jobs except Worker had passed, Worker was still testing, and Web waited for its matching Worker deployment. This lifecycle follow-up is not deployed.

### Admin API lifecycle consistency — 2026-10-23

Admin API PATCH uses the managed-room transaction for archive/restore and optional rename, incrementing the same room policy version. Combined rename/archive checks all permissions before either write. A workspace owner outside a room may archive/restore it but cannot rename it or gain membership. A stale supplied version leaves both fields unchanged. Legacy combined updates use a D1 batch guarded against managed-policy initialization. Room/admin API suites passed 56 tests, including mixed changes, stale versions, unauthorized mixed patches and private restoration without enrollment. Release 4bb40836 was still in progress at the last check; this follow-up remains local.

### Interactive managed-room rename — 2026-10-23

The `/businesses` PUT route now uses the managed-room transaction for renaming, requiring eligible explicit membership, incrementing the policy version and retaining archive state. The low-level legacy rename refuses managed policies, preventing fallback races. Existing early guest/read checks remain (the guest route returns its existing 400 before mutation). Room/business suites passed 48 tests; denied operations leave the version unchanged, and a joined member can rename an archived room without restoring it. Release 4bb40836 CI completed successfully; Worker deployment remained active and Web was still waiting for it. This follow-up is local.

### Room privacy mutation core and release completion — 2026-10-23

Added versioned `setRoomPrivacy` for managed active rooms. Only a current eligible human room admin may change visibility; workspace authority alone is insufficient. The transaction rechecks the admin's join stamp and role, preserves explicit people/agent assignments and roles, and rejects stale versions/rejoined admins. Room/private-card suites passed 50 tests, including access becoming public and then private without implicit membership. This core is not exposed to HTTP/UI yet; live websocket eviction/cache updates must accompany activation.

Release 4bb40836 is now deployed: Worker 39897252414 success, CI 39897252362 success (including E2E), Web 39897252380 success after waiting for its Worker dependency. Later commits remain local. Native Honmaru opened the existing Simple workspace and switched back to Select/Harness; the app was reloaded for the latest UI, with final public-room dialog inspection still pending at this entry.

Native post-deploy check for 4bb40836: Honmaru AI initially showed the existing ShogunAI Simple workspace and its conversations, then returned to Select/Harness. Cmd-R produced a blank window; quitting/relaunching recovered the application and loaded the new bundle. In Select, New → Join public room displayed the Japanese 512px dark dialog, fetched the empty candidate list without an error, and entering `planning` changed the empty-state text to no matching rooms. Escape closed it. No room was joined or created and no permissions were changed. The transient reload blank needs separate investigation; this observation verifies the deployed search/empty state, not populated-room enrollment or 100% parity.

### Legacy admin bulk membership fallback — 2026-10-23

The admin API's unmanaged-room fallback now performs additions/removals in one D1 batch. Every statement requires no managed policy, an existing private room, the acting owner's current membership stamp, and the complete selected workspace-member snapshot. A policy initialized after the earlier unmanaged read or a selected person rejoining causes all writes to be skipped. The response/audit only includes rows actually changed. Existing Simple admin API behavior remains covered. Room/admin suites passed 61 tests, including both initialization and membership races. This follow-up is not deployed.

### Managed-room creation route and UI wiring — 2026-10-23

Added authenticated/rate-limited POST `/channels/rooms`, calling the atomic creation core and returning the caller's authorized business list. Creation announcements compute a separate visible list for each workspace member; private room names are not broadcast to outsiders. Identical retries return 200 with the same identity; a first successful creation returns 201. Harness New room and the room-section add button open the three-step dialog; Dashboard submits the draft, updates the business list and selects the new conversation. Simple keeps its inline channel form. Late completion after the workspace changes does not navigate the next workspace.

Worker creation/room suites passed 54 tests, including real HTTP auth, guest denial, idempotent replay and private-room exclusion from another member's list. Dialog suites passed 7 tests; TypeScript passed. This is local wiring, not a production activation claim. Integrated native creation, color display, remaining lifecycle/security paths and full regression are still required before publishing this batch.

### 2026-10-23 — room color restoration and creation UI verification

- Managed room creation colors now survive business-list reloads; Harness renders the corresponding room/locked-room glyph in that color. Simple mode retains its existing hash/lock rendering. The API test checks saved color and private-room exclusion for a nonparticipant.
- Local native Electron preview verified dark and light creation steps, palette opening, member selection, Japanese labels/input and final callback payload (name, public visibility, color, human/agent IDs and retry ID). This was an isolated UI fixture, not a production room creation or an integrated API test. Temporary preview source files were removed afterward.
- Full Web regression: 133 files, 955 tests pass. TypeScript project build and Vite production build pass. Existing bundle-size/dynamic-import warnings remain.
- Full Worker regression is running against this code snapshot; production deployment is still pending at this entry.

- ec69247f full Worker regression completed: 207 files / 1600 tests pass in 471.95s (`/tmp/honmaru-managed-rooms-worker-full.log`). Release-dependency and migration tooling: 18 tests pass.
- ec69247f pushed to main; release runs: CI 39900294340, Worker 39900294328, Web 39900294316. The normal push path preserves the matching-Worker gate before Web publication. Completion is not yet established by this entry.

### 2026-10-23 — explicit managed-room membership in details

- Room details now list explicit human participants and assigned custom agents for managed rooms. Workspace-wide connected tools and the synthetic personal AI no longer inflate that room's membership. Legacy Simple details retain their existing behavior.
- Saved business metadata and the conversation header count active humans plus assigned agents. Detail rows display room roles; invite controls require an eligible participant and agent removal controls distinguish Admin from Member. These controls supplement, rather than replace, existing server mutation authorization.
- Managed public-room invitations now open the room member picker instead of the workspace invitation flow.
- Focused Worker regression: room creation, channel panels and businesses, 31 tests pass. Added HTTP assertions cover explicit membership, public nonparticipant and invited guest capabilities, Admin agent removal restrictions, and joining/count changes. Full Web regression: 955 tests pass; TypeScript and Vite builds pass (final role-label adjustment also typechecked/built).
- Not yet deployed; Kylon's compact member popover and role editing UI remain open.

- Added a draft 448px RoomMembersDialog matching the observed Kylon member modal: round avatars, compact rows, role labels/actions, light/dark tokens. Two component tests cover readonly capability rendering and failed/pending mutation behavior. Native isolated preview confirms Japanese light/dark layout and the failure message/menu; temporary fixture removed. This component is not wired into production navigation yet: the versioned role HTTP controller and lifecycle integration still need completion before publication.

### 2026-10-23 — ec69247f production release and role UI connection

- CI 39900294340, Deploy Worker 39900294328 and Deploy Web 39900294316 all succeeded. The Web job waited for the matching Worker.
- Native production Mac app: created an empty private room named `UI検証 2026-10-23` in Select, with purple color and no additional people/agents. Creation completed, the conversation opened, and purple locked-room icons appeared in the sidebar/header. Keep this empty room temporarily for subsequent member-dialog verification, then archive it. No AI/provider call was triggered.
- Cmd+R again produced a blank window after initial content disappeared; quit/relaunch restored the workspace. This is reproducible on installed desktop 1.3.8 and remains unresolved; successful relaunch is not a fix.
- c70043ab full Worker regression: 207 files / 1601 tests passed in 433.03s. This predates the role HTTP/controller changes below.
- Connected the compact member dialog to managed-room header/menu/mobile entry points, with role-version mutations and existing person/agent removal APIs. Added authenticated role endpoint resolving human public refs, exposing capability flags without raw user IDs. Self and last-human-admin rows remain static; server protections remain authoritative. Agent profile clicks select the corresponding permitted agent in Harness members.
- Role HTTP and related regression: 70 tests passed, including unauthorized promotion, raw-ID rejection, stale version, last-admin preservation and agent Admin assignment. Controller/dialog tests cover version submission, failure refresh, duplicate suppression and stale unmount completion. Web full suite: 135 files / 960 tests passed; TypeScript passed after the final entry-point wiring. The new role UI is not yet deployed at this entry.

### 2026-10-23 — desktop diagnostic release and persistent startup fallback

- Installed signed Mac is still 1.3.8. Read-only extraction of its ASAR source confirms it lacks the later blank-root probe and script/response diagnostic classifications present in current desktop source; its CSP matches the repository. No installed binary or account storage was modified.
- Existing `Mac signed release` workflow was successfully dispatched through the authenticated API for main with publish enabled (HTTP 204), run 39902613713 at e8e5af3d. It builds/signs/notarizes and verifies before publishing, preserving other platforms' update feeds. At this entry it is building; no 1.3.9 publication or installation is claimed.
- Added startup-v2.js: recovery markup remains available after initial React rendering, and a later empty root restarts its delayed retry explanation. Root content hides it through the existing stylesheet. Session/storage and automatic reload behavior are unchanged. A new asset URL avoids cache-first clients retaining the previous script; startup-v1 remains for older cached documents.
- Startup/service-worker focused tests: 28 pass; Vite build passes. Native local static fixture verified normal content hides the panel, clearing the root reveals the Japanese dark recovery panel, the timeout changes its wording, and a later instrumented retry restored the normal fixture.
- One earlier retry of the same static fixture produced an empty white window. After adding only navigation/status event logging to the temporary Electron runner, both menu reload and retry succeeded with main-frame HTTP 200 and DOM/finish/stop events. This is evidence of intermittent behavior, not a root-cause diagnosis or a verified production fix. Temporary fixture source and runner instrumentation were removed/restored.

### 2026-10-23 — member release and native update verification

- e8e5af3d: full local Worker regression passed 207 files / 1602 tests (724.33s). CI 39902344753, Worker deployment 39902344766 and Web deployment 39902344790 all completed successfully.
- Signed/notarized Mac release 39902613713 succeeded. Normal in-app update installed 1.3.9, confirmed by Info.plist and versioned load diagnostics. Authenticated Select workspace and the private QA room remained available. Cmd+R loaded normal content in this attempt; intermittent blank rendering is not declared resolved. The new diagnostics recorded HTTP 200 and a script-error classification without blank/fail events; no page text or credentials were recorded.
- Member action popup now bounds its position to the viewport, follows scrolling/resizing, supports arrows/Home/End, closes on outside pointer/focus, and restores trigger focus on Escape. Error-state layout changes reposition it. Dark destructive/error text uses a brighter token.
- Local native synthetic-data preview verified dark/light menus, bottom-row placement, keyboard navigation, Escape focus restoration, and failed role change retaining the current role. No production permissions or paid providers were used. Full Web suite passed 135 files / 961 tests before the final CSS/position-dependency adjustment; focused verification and build are repeated below before publishing. TypeScript passed, including the startup test's Node type reference.
- Final focused controller/dialog/startup tests: 10 passed; Vite build passed after the last adjustments. Production e8e5af3d reload restored the selected room and showed the new `メンバー（1）` entry.
- d9e38961 Web deployment 39904130148 succeeded. Its CI 39904130081 is still running (Worker/E2E at last check); the preceding e8e5af3d complete CI is green.
- Production member dialog loaded the sole explicit human participant as Admin, correctly without self-role controls. Add opened the existing people picker. Simple local preference on/off restored the classic UI and Harness UI respectively without changing workspace mode or losing the QA room/agent.
- Read-only Kylon comparison identified a remaining empty-add-list difference: Kylon explains everyone has joined and offers workspace invitation; Honmaru still uses a generic no-matches picker. No invite was sent.
- On a later reload, installed 1.3.9 again showed a blank dark content surface. HTTP 200/script-error/DOM/finish/stop were recorded; the native recovery did not report blank. Toggling native window zoom restored the AX content tree, while screenshots remained blank and a room click did not visibly respond. Force reload did not immediately restore rendering. These observations distinguish accessible content from visible painting but do not establish a root cause. Window size was restored. No cache/session data or security settings were changed.

### 2026-10-23 — unified managed-room member picker

- Previous d9e38961 CI 39904130081 completed successfully, including Worker and E2E. Web deployment 39904130148 succeeded. Native restart restored the authenticated workspace after the recorded blank reload.
- Managed-room Add now stays within a 512px dialog. Joined humans are excluded; currently permitted addable custom agents come from authenticated channel details. The empty state matches the observed Kylon explanation and workspace-invite entry. Opening that entry does not send an invite. Simple/unmanaged conversations keep the existing picker.
- People are submitted as one existing bulk request; agents use existing individually guarded requests. This is not a newly atomic cross-kind transaction. A partial failure reloads candidates, excludes successful additions from retry, retains unsuccessful selections and displays the error. A failed refresh blocks further submission. Scope changes/unmount stop subsequent requests and callbacks. Already-dispatched requests can still complete on the server.
- Full Web regression: 136 files / 965 tests pass; TypeScript and Vite build pass. Tests cover partial success/retry, unmount between steps, duplicate submission prevention and pending close prevention. Native synthetic-data preview verified Japanese empty state, light/dark styling, multi-selection and error retention; no production members/agents were added and no provider calls were made.
- Electron's official background-throttling documentation and issue #42378 were consulted as diagnostic leads only. That Windows hidden-window report does not prove the cause of this Mac reload issue, and no speculative runtime/security setting changes were shipped.
- 93c400d7 Web deployment 39905036582 completed successfully. Native 1.3.9 initially blanked on reload again; normal quit/relaunch recovered. The production Add dialog then showed Mac実行アシスタント as an available agent, excluded the joined human, and had Add disabled with zero selections. No addition was submitted. The empty private QA room `UI検証 2026-10-23` was archived through the normal recoverable UI and disappeared from the sidebar; the existing agent remained.
- Follow-up prepared: all managed-room `addingTo` entries (row menu, private-room nudge, mobile sheet and detail panel/settings) render the same picker through RoomMembers.initialAdding. Authoritative details load before showing candidates; Back returns to the members list. Simple/unmanaged entries still use PeoplePicker. Full Web suite 136 files / 966 tests passes; 11 focused member tests, TypeScript and Vite build pass. This follow-up is not yet published; 93c400d7 CI 39905036583 is still running (Worker/E2E at last check), so it was not cancelled by another push. Direct-entry production verification remains pending.

### 2026-10-23 — bounded native inspection diagnostics prepared

- Prepared desktop 1.3.10 (not yet released). The existing delayed content probe now records start/visible/error/5-second-timeout outcomes and bounded window flags (visible=1, minimized=2, focused=4, loading=8). Unknown or stalled inspection is not treated as an empty document and does not trigger automatic reload. Late results after navigation/destruction are ignored.
- Console diagnostics distinguish CSP-policy and JavaScript exception categories from generic errors, recording each category once per navigation. Messages, URLs, DOM text and account data are never persisted. The existing 64-event local bound is preserved.
- Desktop suite: 15 files / 118 tests pass, including inspection failure/hang, stale results, classification privacy, persistence and updater/feed behavior. No CSP, sandbox, certificate checks, authentication or background execution settings were weakened.
- Controlled local file fixture (Electron 44.5.1, no network/Vite/React/auth/preload) rendered successfully with backgroundThrottling true and false; keyboard and in-page reloads visibly incremented a fixture-only counter. This did not reproduce the production issue and does not establish the setting as causal or prove resolution. Temporary runner restored and fixture removed.
- At last check, 93c400d7 CI 39905036583 has Web/E2E/Desktop and other required jobs successful, Worker still live. Do not cancel/restart it merely because of elapsed time. Pending 1dcf52cb web entry-point update and this desktop diagnostic change remain unpublished until the next push/release verification.

### 2026-10-23 — ten-color room palette and release version correction

- Fresh native Kylon inspection shows Rose, Orange, Yellow, Green, Teal, Lake, Blue, Indigo, Purple and Pink in two rows of five, using room icons on pale rounded squares. Honmaru's create-room palette now follows that order and treatment with localized labels; persisted legacy olive/red/gray colors remain readable and accepted. Custom visual upload and the full room settings dialog remain gaps.
- Worker creation accepts the new keys and tests verify saved/listed colors and idempotent retries for all five newly accepted keys. Focused Worker: 16 tests pass. Full Web: 136 files / 967 tests pass; TypeScript, production build and version consistency check pass. Native synthetic preview verified light/dark palettes and Lake selection changing the accessible trigger label. No production room was created.
- d8e85c76 Web deployment 39906203165 succeeded. Signed/notarized Mac 1.3.10 release 39906218417 succeeded. The existing 93c400d7 CI 39905036583 finished successfully. d8e85c76 CI revealed desktop 1.3.10 disagreed with shared VERSION 1.3.9; all manifest/native marketing versions are now aligned to 1.3.10. This corrects source consistency and does not claim new mobile binaries were published.
- Follow-up palette interaction: Escape closes only the color popover, returns focus and preserves the draft; outside pointer dismisses it and choosing a color returns focus. Native Japanese keyboard verification preserved the entered room name. Full Web now 136 files / 968 tests passes; TypeScript/build pass.
- Mac 1.3.10 was installed through the normal update UI. The native version menu confirms 1.3.10 and authenticated startup/reload rendered successfully in this observation. Bounded diagnostics show policy-error and inspect-visible (window-state 5); this is not proof that the intermittent blank rendering defect is resolved.
- Direct-entry production verification on Mac 1.3.10: temporarily restored the existing empty private QA room, opened Channel settings → Add people, and observed the unified picker with only the permitted Mac assistant and Add(0) disabled. Close returned to the member list, then the conversation. No members/agents/messages were added. Re-archived the QA room through normal UI and verified it disappeared from the sidebar.
- Public production /health reports ok=true and all encryption checks enabled. This is an availability/configuration observation, not functional parity proof.
- The intermittent blank render reproduced on Mac 1.3.10 at 05:55:46 UTC after Cmd+R. HTTP 200, policy-error, DOM/finish/stop were recorded; at 05:56:16 UTC inspection reported window-state=5 and inspect-visible, while native screenshot remained blank and AX exposed only window chrome. This narrows the symptom to content existing without native visible/accessible content; it does not establish a compositor/GPU cause. Restart used for recovery; no session/cache clearing or security relaxation.
- Upstream leads consulted: [Electron #52809](https://github.com/electron/electron/issues/52809) requires toggling background throttling while hidden (Honmaru does not do this), so it is not an established match. [Electron 44.7.2 notes](https://releases.electronjs.org/release/v44.7.2) document background-app click and interrupted-update fixes; runtime update evaluation remains separate from proving this blank-render fix.
- Recovery restart restored authenticated Harness UI. A brief Simple-mode frame appeared while workspace configuration loaded; `useWorkspaceMode` defaults to Simple until its scoped request resolves. This is a separate initial-loading polish gap, not lost workspace data or evidence of a mode authorization bypass.
- Release a673f31e completed successfully: CI [39907680271](https://github.com/Torutesu/HonmaruAI/actions/runs/39907680271), Worker [39907680174](https://github.com/Torutesu/HonmaruAI/actions/runs/39907680174), Web [39907680188](https://github.com/Torutesu/HonmaruAI/actions/runs/39907680188). All required CI jobs succeeded, including Shared core/mobile, Worker and E2E; optional iOS/Windows jobs were skipped by workflow conditions. Worker post-deployment health remained normal.
- Native production verification after Web release displayed all ten Japanese color labels and matching icon palette. Escape preserved `UI色検証 2026-10-23` and restored trigger focus; Lake selection changed the trigger label. Created this empty private QA room with zero selected people/agents, observed member count 1 and the room icon, then reloaded successfully and observed the saved room/icon again. No messages or AI/provider calls were submitted.
- Archived the new empty color QA room through the normal recoverable flow and verified it disappeared from the sidebar; the existing Mac assistant remained. Simple mode and pre-existing room colors remain supported.

### 2026-10-23 — unified managed-room settings prepared

- Managed rooms now open a 448px settings dialog with a shared ten-color icon picker, room name and mentioned-only response switch. Simple/unmanaged channel tools remain available unchanged; existing managed-room row menus retain archive/leave/member actions. Custom visuals, default-room identity protection, advanced webhook settings and the full Kylon room menu remain gaps.
- A versioned D1 batch commits name, appearance and response preference together. Both room and response versions are checked; active membership identity is checked again in the write transaction, including departure/rejoin and guest downgrade. Public visibility or workspace admin role alone does not authorize editing. Appearance overrides preserve immutable creation fingerprints/receipts and appear in personalized business lists and creation retries. The existing response endpoint now uses the same managed-room membership/version guard.
- Focused Worker: 4 files / 43 tests pass, including competing writers, rollback, stale versions, ACLs, immutable receipt replay and permission changes during a write. Full Web: 137 files / 974 tests pass; TypeScript and Vite build pass. Full Worker validation is still running; this change is not yet published.
- Native synthetic preview verified light and dark layouts, ten-color palette, Escape focus return, name/response editing, save/reopen, read-only membership explanation, conflict draft preservation and explicit latest-settings reload. System-following dark mode revealed insufficient error contrast; it now uses the same brighter error color as explicit dark mode. No external AI calls, invitations or new services were used.
- Full local Worker completed: 208 files / 1,624 tests passed (561 seconds). Source 310fb06e pushed; CI 39911757377, Worker 39911757396 and Web 39911757356 started. Web waits for the matching Worker release. Production verification remains pending.
- Fresh native Kylon read-only inspection confirms the six-item room menu (search, copy link, pin home, guidelines, settings, mute) and a 512px guidelines dialog with a 4096-character count and a tall textarea. Closed without saving. Honmaru's existing guidelines editor remains in channel details; a matching menu/dialog is still a gap.
- Worker 39911757396 and Web 39911757356 deployed successfully. Public /health remains ok with all encryption checks enabled. CI E2E failed its delayed-message pin assertion; that assertion waits for both a pinned class and a synthetic body marker, so this alone cannot distinguish pin rollback from an authoritative response replacing the marker. Existing monotonic pin merge tests and full Worker tests pass. CI Worker is still running; no claim of all-green CI or resolved E2E instability.
- Native production after deployment: restored the existing empty private `UI色検証 2026-10-23` room and opened the new dialog. Saved the name `UI設定検証 2026-10-23`, Indigo color and mentioned-only enabled together. Sidebar/header updated; reopening the server-backed settings confirmed all three values. No messages or provider calls were sent. The pre-existing Mac reload blank recurred at 06:41 UTC (HTTP 200, policy-error, DOM/finish/stop); normal quit/relaunch recovered authenticated UI, without clearing data or weakening security.
- After a full application quit/relaunch, the saved name, Indigo trigger and mentioned-only switch `on` were still present. Restored the original name, Lake color and response `off`, saved successfully, then archived the room using its existing row menu and verified it disappeared while the Mac assistant remained. Returned to the original ShogunAI Research screen; Simple-mode channel tools remain visible.
- CI attempt 1 finished with all required jobs successful except the delayed-pin E2E assertion; only failed jobs were rerun on the same 310fb06e commit (attempt 2). No production code was changed merely to make that check pass.
- CI attempt 2 also failed, on a different existing E2E scenario: marking a group message unread returned to the phone list but `.slk-side .cl-thread.unread[data-view^="g:"]` never appeared. The delayed-pin scenario passed this time; it is not proven fixed. Downloaded the test artifact and inspected the Kenji failure screenshot: group row visible, not bold/unread. All other required CI jobs remain successful. Do not claim green CI.
- Targeted pin/cache/arrival investigation: 3 files / 52 tests pass. Code review shows `reads_changed` events and `/channels` read snapshots lack a mutation revision; a later-arriving read event can raise the local/server read position after explicit unread. This is a concrete ordering risk, not yet a proven sole cause of the E2E failure. Next work should cover ordered read/unread state and snapshot merging without suppressing legitimate reads on another device, then rerun E2E.

### 2026-10-23 — revision-ordered read/unread state prepared

- Added a monotonically increasing D1 read revision for each account/workspace/conversation key. Read and explicit unread use atomic SQL RETURNING, so acknowledgments identify the exact committed write rather than a later readback. Existing clients retain timestamp fields; current clients receive revisions through HTTP, personalized reads_changed events, thread activity acknowledgments and channel-list snapshots.
- The web reducer accepts newer revisions even when the timestamp intentionally moves backward, ignores delayed/duplicate older revisions and still accepts a later legitimate read from another device. Thread read/unread writes now share a per-thread ordered queue. Channel-list snapshots use the same revision filter instead of replacing newer local state wholesale.
- Focused real-D1/API tests: 41 pass, including concurrent writes returning distinct revisions and snapshots matching the final mutation. Full Web: 138 files / 977 tests pass; TypeScript and Vite build pass. Full Worker test run is in progress. Not deployed yet.
- E2E now retains the existing phone mark-unread assertion, then injects an older read notification and checks that unread remains, then performs a genuine newer read and checks that it clears through realtime delivery. This regression has not yet completed against the full stack. The earlier pin-marker failure remains an independent intermittent failure, not claimed fixed.
- A separate legacy-schema migration test passes: an existing read timestamp survives deployment with revision 0, and its next write returns revision 1. This new test ran separately after the full Worker run started. Full Web rerun remains 138 files / 977 passing tests.
- Full local Worker completed successfully: 208 files / 1,626 tests (468 seconds), plus the separately executed legacy migration regression. Source 26948c7d is on main; CI 39915669560, Worker 39915669536 and Web 39915669447 remain in progress at this checkpoint. Web waits for the matching Worker deployment.
- Fresh native Kylon room-search observation: the room menu opens a compact search bar over the upper-right conversation, not the global search palette. Searching existing text showed a per-message 1 / 1 counter, yellow highlights and previous/newer navigation; closing made no content changes. Honmaru still needs a room-scoped, permission-checked paginated search endpoint and matching room search/menu UI. Existing thread search is not equivalent to room search.
- Revision ordering currently covers channel snapshots and read mutation notifications/acknowledgments. Thread-list snapshots do not yet carry these revisions; physical multi-device verification and the independent intermittent pin-marker E2E failure remain open. This is not 100% parity or a complete resolution of every read-state race.
- CI End to end job 120288587008 succeeded on 26948c7d, including the existing phone group mark-unread scenario, the injected older-revision notification and the subsequent real newer read through realtime delivery. Its delayed-pin scenario also passed in this run; the historical intermittent failure is not thereby declared fixed. Native Simple-mode dark UI is currently visibly rendered; production reload verification awaits the matching Web deployment.
- Release 26948c7d completed: CI [39915669560](https://github.com/Torutesu/HonmaruAI/actions/runs/39915669560), Worker [39915669536](https://github.com/Torutesu/HonmaruAI/actions/runs/39915669536), Web [39915669447](https://github.com/Torutesu/HonmaruAI/actions/runs/39915669447) all succeeded. All required CI jobs passed; iOS/Windows were skipped by existing workflow conditions. Public Worker health returned ok with all encryption checks enabled.
- Native production smoke check after Web publication: Cmd+R in the Select workspace rendered the Harness chat list and existing Mac assistant in dark mode, confirmed by both accessibility and screenshot. Switched back to the original ShogunAI Research Simple screen; its channel settings and list controls remained available. No messages, agent runs, invitations or new services were created. This checks rendering/navigation after publication, not physical multi-device read ordering; the intermittent blank-render issue remains open despite this successful reload.

### 2026-10-23 — scoped room search and room action menu prepared

- Managed Harness rooms now have the observed six-item menu order and matching icon types: room search, copy link, pin home, guidelines, settings and mute. Existing pin, notification and settings operations are reused. Guidelines currently opens the existing automation/details editor; the separate Kylon guidelines modal and its stronger managed-membership guard remain gaps. Simple/unmanaged settings entry is unchanged.
- Room search uses a dedicated authenticated endpoint resolving the exact conversation before querying it. It excludes deleted messages and thread-only replies, includes replies explicitly sent to the room, treats SQL wildcard characters literally and pages without timestamp-tie loss. Focused real-D1/API tests: 33 pass, including private-room refusal and 33 matches spanning two pages.
- The compact room search bar shares thread search behavior, including counts, ring navigation, literal text highlights, query cancellation and retry. Room results load older history beyond the former 20-page citation cap; canceled selections do not jump later, stalled cursors fail, and history merge preserves currently loaded/newly arrived messages. Full Web: 139 files / 980 tests pass; TypeScript and production build pass. Full Worker run remains in progress.
- Native local synthetic-data preview verified the six-entry menu, light/dark search bar, two matching messages, 1/2 to 2/2 navigation, yellow highlights, repeated Cmd+F focus and Escape returning focus to the menu trigger. No production messages, providers or permissions were changed. Temporary preview was closed and its source fixtures removed. Production publication and smoke checks remain pending.
- Full local Worker completed: 209 files / 1,629 tests passed (434 seconds). No backend changes were made during that run.
- Search source 05e65a0a is on main. CI 39919211404, Worker 39919211438 and Web 39919211399 are still live at the next checkpoint; no new push cancels those jobs.

### 2026-10-23 — dedicated room guidelines dialog prepared

- The managed-room menu now opens a 512px guidelines dialog with a tall text area, 4096-character counter, cancellation and versioned save. Conflict responses preserve the draft, disable resubmission and require explicit replacement with the latest contents. Read-only visitors can select/copy text. A pending write blocks duplicate submission/dismissal; a late response from another room cannot close or unlock the current form.
- Managed guideline writes recheck active non-guest room membership incarnation and room access revision in the SQL write itself. Public visibility/workspace administration alone is insufficient. Deleted/archived managed rooms cannot fall through to legacy writes. SQL RETURNING supplies the exact winning guideline revision. Legacy Simple/unmanaged guideline behavior remains supported; broader delegated/BYO-agent turn coverage is still incomplete.
- Focused Worker: 35 tests pass across existing guidelines/agent tests and six new managed-room tests, covering private/public access, membership departure/rejoin, guest downgrade, archive races and competing writes. Full Web: 140 files / 983 tests pass; TypeScript and Vite build pass. Full local Worker is running; these changes are not published yet.
- Native synthetic-data preview verified dark and light dialog layouts, Japanese editing/count updates, Escape dismissal and a 409 response retaining the draft. Subsequent native AX/screenshot observations became inconsistent; final read-only/unstyled-retry adjustments were verified by the repeated Web suite/build, with fresh production visual confirmation pending. Temporary preview processes and source fixtures were removed. No production guideline, message, membership or provider was changed.
- Full local Worker finished successfully: 210 files / 1,635 tests (437 seconds). Managed-room details now opens the same guidelines dialog as the header menu; legacy inline code is preserved. Full Web rerun stays 140 files / 983 passing tests, with TypeScript/build successful. Prior search release E2E and Worker deployment tests remain live; guideline commits are local pending that gate.
- Search release 05e65a0a completed successfully: CI [39919211404](https://github.com/Torutesu/HonmaruAI/actions/runs/39919211404), Worker [39919211438](https://github.com/Torutesu/HonmaruAI/actions/runs/39919211438), Web [39919211399](https://github.com/Torutesu/HonmaruAI/actions/runs/39919211399). All required CI jobs including E2E passed. Public Worker health stayed normal with encryption checks enabled.
- Native production verification: restored the existing empty private color QA room, opened the six-item room menu and its compact room-search bar, searched UI確認 and observed the successful 0 / 0 response and disabled result navigation. This checks authenticated production search/empty state, not nonzero history navigation; the latter was covered by real-D1 and local UI tests. No messages or provider calls were submitted. Re-archived the QA room and confirmed it disappeared while the Mac assistant remained, then returned to the original ShogunAI Simple workspace with channel settings available.
- The installed 1.3.10 blank-on-reload defect reproduced at 07:56:50 UTC: HTTP 200, policy-error and DOM/finish/stop, followed by normal quit before delayed inspection. Normal restart restored authenticated content. The policy category also occurs on successful startup, so it is not established as causal. No cache/authentication/security settings were changed.
- Guideline commits f60e0532 and f214d124 are now on main. Matching f214d124 CI 39921164176, Worker 39921164173 and Web 39921164107 are running. Do not cancel them with a further push; production guideline dialog verification remains pending.

### 2026-10-23 — desktop runtime update candidate

- Prepared desktop 1.3.11 with Electron pinned to 44.9.3 and the repository-wide version manifests aligned. Official 44.9.3 notes list Chromium/ANGLE/Skia and related backports; they do not establish a fix for Honmaru's intermittent blank reload. Existing sandbox, isolation, web security and authentication handling are unchanged.
- Desktop suite: 15 files / 118 tests pass. Version consistency and whitespace checks pass. A local unsigned macOS arm64 package built successfully with Electron 44.9.3. This is a build check, not signed production publication.
- An isolated temporary profile rendered the production welcome page, including after two reload actions. No authentication/profile data was copied and no provider calls were made; the temporary launcher suppressed URL-handler registration and was removed after closing the preview. Authenticated blank-reload recovery is still unverified on the candidate. The installed production app is still 1.3.10.
- Guideline CI 39921164176 is now successful, including Worker and E2E. Worker 39921164173 and dependent Web 39921164107 remain in progress at this checkpoint.
- Guideline release f214d124 is now fully deployed: CI 39921164176, Worker 39921164173 and Web 39921164107 all succeeded. Public health returned ok with every encryption check enabled.
- Native production reload rendered the authenticated Harness room successfully. The dedicated dark dialog displayed the 4096 counter and focused text area; a temporary 18-character Japanese guideline saved, reappeared on reopening, was replaced with the original empty body, and reopened as 0 / 4096 with unchanged-save disabled. No messages, agent runs or new services were created. This verifies persistence and presentation, not guideline application across all external/delegated agents.
- The QA room was re-archived and disappeared from the Harness directory while the Mac assistant remained. Returned to ShogunAI Simple mode and observed its channel-settings control. A subsequent optional attempt to restore the exact original channel hit ScreenCaptureKit -3811 (capture failure, not a lock indication); no unlock request or security-setting change was made.
- Runtime source and verification are on main at 6c168a95. CI 39923683360, Web 39923683317 and signed Mac draft build 39923731891 are in progress. Do not push over these runs. Desktop 1.3.11 is not yet published or installed; wait for CI, signed artifacts and update-feed checks before publication. The local unsigned package is only a build artifact under /tmp.

### 2026-10-23 — room chrome fidelity refinement

- Matched the observed Kylon room-menu names (room guidelines/settings/mute and home pin), added the room-guidelines title and placeholder, and adjusted its title size, 24px content inset, footer spacing and theme-aware primary button. Managed Harness room headers omit duplicate star/section buttons; home pin remains in the room menu and section movement in the existing context menu. Simple and unmanaged headers retain their existing controls.
- Full Web: 140 files / 983 tests pass; TypeScript and Vite production build pass. Native capture still returns ScreenCaptureKit -3811, so the actual local component was inspected in the in-app browser instead: light/dark screenshots, Japanese input, 8 / 4096 counter and enabled save state verified. The preview used synthetic empty data only and its files/tab/processes were removed. These refinements are not yet deployed.
- Signed desktop build 39923731891 failed twice before signing at security set-key-partition-list. Installed app-builder-lib 26.15.3 creates a random keychain password but passes the certificate password to that operation. The npm-distributed 26.16.1 source passes keychainPassword through importCerts correctly. Preparing the targeted builder update; no signing or notarization requirements are bypassed.
- Builder fix prepared: electron-builder pinned to 26.16.1, with its lockfile updated. Verified the installed app-builder-lib now uses the generated keychain password for set-key-partition-list. Desktop 15 files / 118 tests and version consistency pass; unsigned local arm64 packaging with the new builder succeeds. This does not yet prove signed/notarized CI success. Existing CI 39923683360 still has Worker/E2E live, so this fix and the UI refinement are committed locally without canceling that run.

### 2026-10-23 — guidelines communication recovery

- Guideline reads and saves now have a 15-second deadline. A stalled read offers explicit reload. An uncertain save retains the draft, releases the dialog's busy state, blocks resubmission and requires explicit readback; aborting a request does not imply server rollback. A late success cannot close the dialog after the timeout. Confirmed HTTP failures retain the existing handling.
- Added regressions for stalled reads, aborted save signals, preserved input, enabled dismissal, blocked retry, late responses and explicit retrieval of a remotely saved value. Full Web: 140 files / 985 tests pass; TypeScript passes after correcting the test callback return type; Vite production build passes. No backend behavior, schema or Simple mode was changed.
- Prior runtime CI 39923683360 completed its Worker job successfully (E2E already passed). Source 7221980f is pushed to main, including UI fidelity, bounded guideline requests and the builder fix. New Desktop release 39925718141, CI 39925691248 and Web 39925691254 are live. Draft release 421598715 (v1.3.11) still has zero assets and is unpublished; its target was updated to 7221980f before the new build. No new push should cancel these checks.

### 2026-10-23 — external teammate room guidelines prepared

- The shared external-teammate start/continue path now reads the room's current guidelines for each turn. The snapshot stays in that turn's task, not the provider's workspace-wide agent configuration or task title. Explicitly cleared guidelines are sent as an empty revision so a retained remote session is told to discard earlier room rules. Rooms with no saved guideline document retain the legacy request text.
- Focused teammate and managed-guideline tests: 12 pass. Added a real-D1/mocked-provider regression for initial instructions, a cleared follow-up, separate-room isolation and unchanged shared configuration. A cross-workspace isolation assertion was then added before the full run. Full Worker is running unchanged in exec session 63493; log /tmp/honmaru-teammate-guidelines-full.log. This work is uncommitted and unpublished pending the suite. No real provider call or new spend occurred.
- Native screen capture recovered on a later attempt and showed the installed app's original ShogunAI General Simple screen with channel settings. This does not verify the pending Web refinement or the still-unpublished Mac 1.3.11.
- Web 39925691254 succeeded for 7221980f. Native production verification after ordinary restart: the managed room header no longer shows duplicate star/section controls, the six menu labels match the observed Kylon room menu, and the dark guideline dialog shows the revised title, placeholder, spacing and themed buttons. No guideline or message was changed. Re-archived the QA room, confirmed it disappeared while the Mac assistant remained, then returned to ShogunAI General Simple with channel settings available.
- Installed 1.3.10 blank reload reproduced again at 08:36:53 UTC. Raising the window did not fix it; its 30-second diagnostic reported window-state 5 and inspect-visible despite the blank screenshot/AX. Ordinary quit/restart restored authenticated content. This narrows the evidence to a visible-content/paint discrepancy, not a proven root cause; 1.3.11 remains unpublished and unverified for authenticated reload.
- Full external-teammate Worker suite completed: 210 files / 1,636 tests pass (665 seconds), including the cross-workspace assertion. Backend sources were unchanged throughout the run.
- Signed Mac build 39925718141 and update-feed check succeeded. The authoritative release listing now identifies draft 421613251 for v1.3.11, targeting 7221980f, with the universal ZIP/DMG, blockmaps and latest-mac.yml. Do not publish the earlier empty draft ID. Downloaded ZIP SHA-512 matches the update feed; extracted app reports 1.3.11; codesign --verify --deep --strict passes and spctl accepts it as Notarized Developer ID. It remains unpublished/uninstalled until matching CI completes; authenticated reload behavior on 1.3.11 remains unverified.

### 2026-10-23 — signed Mac publication and authenticated reload

- Matching CI 39925691248, Web 39925691254 and signed Desktop 39925718141 succeeded for 7221980f. Published release v1.3.11 (421613251) with the verified universal artifacts and update feed. Installed through the existing app updater; installed app reports 1.3.11 and Electron framework 44.9.3. No security settings or authenticated profile data were changed.
- Authenticated Simple reload rendered successfully. The actual Harness reload at 08:57:49 UTC also rendered the Chat directory, Mac assistant and empty conversation state; screenshot and AX were rechecked after continuation. Returned to the original ShogunAI Simple workspace with channel settings visible. These successful observations do not establish that intermittent blank rendering is eliminated.
- Kylon itself temporarily rendered blank after its refresh prompt; normal quit/relaunch restored it. This is evidence to consider, not proof of a shared cause. Observed Kylon general-room settings prohibit renaming its all-member room and include an advanced webhook management entry. No reference settings, webhook or credentials were created. Default-room identity and webhook UI remain parity gaps.
- Backend 4deac0b5 is on main with CI 39927678270 and Worker 39927678274 still running. Public health returns ok and all encryption checks enabled; this alone does not prove that new backend deployment completed.

### 2026-10-23 — room settings save scope isolation

- Reset busy/pending state when the settings dialog changes room or account scope. Only the matching save generation can release its pending guard, so an older request cannot unlock or close a newer room's in-flight save.
- Added a two-room/two-pending-save regression covering editable destination state, stale completion, guarded dismissal and current completion callbacks. Focused seven tests and TypeScript pass. Full Web suite passed; deployment remains pending the previous live CI gates.

- Worker deployment 39927678274 completed successfully. The matching overall CI remains live; do not cancel it with a push.
- Room settings reads/saves now have a 15-second deadline including JSON-body retrieval. Uncertain writes retain the draft, release busy state, and require explicit readback before resubmission. Regression tests cover stalled read bodies, stalled writes, abort signals, late success and authoritative readback. Full Web 140 files / 988 tests, TypeScript and production build pass. No new provider calls or paid services.

### 2026-10-23 — room settings visual alignment

- Rechecked the actual Kylon settings dialog. Moved the response-method heading outside its bordered card, matched the round room-icon treatment and 18px title, and made primary/switch colors use Harness theme roles instead of a fixed olive fill. Cancel uses the observed transparent treatment. This only changes RoomSettings; Simple dialogs are untouched.
- Inspected the actual component in a temporary local preview with synthetic data in both light and dark themes; round icon, separate heading/card, readable text and themed switch/buttons rendered correctly. Focused RoomSettings nine tests pass. Preview files/tab/server removed. This visual change is not yet published; current main ebd12338 CI 39929806436 and Web 39929806392 remain the release being checked.

### 2026-10-23 — room inbound webhook evidence

- Opened Kylon room settings > advanced > Webhook > Manage. This is a separate dialog with a name input (deployment-notification example), a disabled Create webhook button until named, an empty list, and explanatory text that every received event opens a dedicated thread in this room for its agents. Closed without creating credentials or changing reference data.
- Honmaru Tools API/Webhooks is outbound workspace event delivery, while Harness workflow hooks execute a defined workflow. Neither currently provides this room-scoped inbound-event/thread contract. A link to either existing screen would not complete the observed requirement.
- Implementation must bind hooks to room identity, check current creator membership and room activity at receipt/dispatch, durably deduplicate deliveries into exactly one root thread, and select only room-authorized agents under current cost/permission limits. Credential creation/revocation must be explicit; no reference or production credentials were generated during this inspection. Existing Simple outbound hooks must remain unchanged. Lifecycle/replay behavior of a created Kylon hook has not been verified.

### 2026-10-23 — room settings visual release verified

- Previous CI 39929806436 and Web 39929806392 succeeded for ebd12338. Web regression on the visual revision: 140 files / 988 tests pass, TypeScript and Vite build pass. Pushed 1a591186 after the previous CI completed. Web 39931795023 succeeded; CI 39931795095 remains live.
- Installed Mac 1.3.11 rendered the published room settings with round icon, heading outside the response card and dark theme colors. Opened the existing private empty QA room, read settings only, and saved a screenshot at /tmp/honmaru-room-settings-production-20261023.png. No message, provider call or setting edit was made.
- Authenticated reload at 09:27:12 UTC on 1.3.11 produced a blank dark content area; AX also lacked application content. Ordinary quit/restart restored it. The updated Electron runtime therefore does not eliminate the intermittent blank-render problem. No security settings, profile or credentials were changed.
- Re-archived the temporary QA room and confirmed it disappeared while the Mac assistant remained. Restored ShogunAI General Simple mode and verified its channel-settings control is available.

### 2026-10-23 — native process diagnosis prepared

- The existing load log records generic renderer disappearance but no GPU exits or termination reasons. Added bounded GPU/renderer reason categories to the same local diagnostic recorder, using Electron's documented child-process-gone and render-process-gone events. No raw names, service names, URLs, exit descriptions, page text or images are recorded. Listener cleanup follows window destruction; diagnostic failure cannot affect native recovery.
- Desktop full suite: 16 files / 121 tests pass; an additional persistence test then passes with the focused diagnostic suite (8 tests). Main-process syntax and whitespace checks pass. This is instrumentation, not a fix for blank rendering, and it is not installed in the released 1.3.11. No automatic recovery, renderer settings or security controls were changed.
- Primary API references: https://www.electronjs.org/docs/latest/api/app#event-child-process-gone and https://www.electronjs.org/docs/latest/api/web-contents#event-render-process-gone . Stable reason codes: 0 unknown; 1 clean exit; 2 abnormal exit; 3 killed; 4 crashed; 5 out of memory; 6 launch failed; 7 integrity failure; 8 memory eviction.

### 2026-10-23 — diagnostic desktop candidate 1.3.12

- Prepared version 1.3.12 across required version manifests for the native process diagnostics. Version consistency and Desktop full suite (16 files / 122 tests) pass. Local unsigned macOS arm64 packaging succeeded under /tmp/honmaru-1.3.12-build. This is not a signed/released/installed build and does not establish a blank-render fix.
- Source inspection found existing bounded locale startup, independent empty-root fallback and load recovery; no verified double-reload cause was found. Existing safeguards remain enabled. Current CI 39931795095 is still live; hold source push and signed workflow dispatch until it completes.

### 2026-10-23 — private room visual storage in progress

- Added uncommitted room-visual metadata storage and matching schema/migration table. The pointer update shares the managed-room access version and rechecks the current non-guest membership incarnation atomically, preventing stale uploads after leave/rejoin. Object keys are internal validated identifiers; no public image URL is generated.
- Five focused real-D1 tests pass: versioned replace/remove, room outsider/workspace admin refusal, separate organization isolation, rejected arbitrary keys/active image types, membership race and archived room refusal. Initial schema test failed because a SQL line comment was flattened by the existing test loader; changed it to a block comment and the rerun passed. This is an unfinished backend foundation: image byte validation/storage, authenticated retrieval, upload/delete API, list/header presentation and picker UI remain to connect. Do not publish or claim the feature complete yet.

- Room visual raw-image POST, authenticated GET and versioned DELETE are now connected locally. API tests cover a real R2 roundtrip, no-store/nosniff headers, unauthenticated and private-room outsider refusal, no access through the public media route, stale deletion, byte-signature/type mismatch and membership revocation during object retrieval. Eight focused tests pass. A failed metadata call checks whether bytes were committed before orphan cleanup; it must not delete a committed image after an uncertain response. No production objects were created. Picker/list/header integration and full regression tests remain unfinished.
- Previous CI 39931795095 succeeded. Pushed only committed desktop/verification source through 5b214522 and dispatched the existing Mac Desktop release workflow. Uncommitted room-visual files are deliberately absent from that build. Publication remains gated on CI, signature/notarization, feed and artifact checks.

- Connected room visual editor to the color palette with upload/remove actions, an authenticated object-URL image component, and managed-room list/header rendering. Room metadata emits only a visual revision, never the storage key, and visual changes broadcast permission-filtered business snapshots. Unsaved settings must be saved first; upload locks the parent form/dismissal, bounded failures require readback, and component scope changes abort/ignore stale requests and revoke image URLs.
- Web focused 13 tests and TypeScript pass; Worker related room visual/settings/creation 41 tests pass. Started full Worker run in session 33277 (log /tmp/honmaru-room-visual-worker-full.log) and full Web in session 94568 (/tmp/honmaru-room-visual-web-full.log). Freeze backend sources during this run. Feature remains uncommitted/unpublished pending full checks and actual preview.

- Full Web completed: 142 files / 992 tests pass. Actual local component preview used a synthetic PNG and in-memory responses only. Light/dark presentation and deleting the visual back to the existing color icon were verified. Found and fixed default button padding squeezing the image into an oval; it now renders round. Japanese light screenshot: /tmp/honmaru-room-visual-preview-20261023.png. Preview files/tab/server removed. Actual file-chooser upload and production visual verification remain pending; the local preview is not end-to-end backend proof. Full Worker session 33277 is still running unchanged.

- Mac Desktop release 39933821081 succeeded. Draft release 421671833 / v1.3.12 targets 5b2145228761d008c9c0f4ffbc645e13c0d65d90 and contains universal ZIP/DMG, blockmaps and latest-mac.yml. Downloaded ZIP SHA-512 matches its feed, extracted app reports 1.3.12, codesign --verify --deep --strict exits 0, and spctl accepts Notarized Developer ID. Files are /tmp/Honmaru-AI-1.3.12-universal-mac.zip, /tmp/latest-mac-1.3.12.yml and /tmp/honmaru-signed-1.3.12/Honmaru AI.app. Do not publish until CI 39933800344 completes; it remains unpublished/uninstalled at this checkpoint.

- Added an integrated RoomSettings regression for upload timeout followed by authoritative readback with the same room version, then a successful new attempt. Parent form/dismissal remain locked only during the write and the editor resets its uncertain outcome after readback. The focused settings suite now has 10 passing tests; TypeScript passes. Initial new test had an object-literal typo, corrected before execution. Backend sources remain frozen for session 33277.

- Full Worker completed successfully: 211 files / 1,644 tests in 469 seconds; backend unchanged during the run. Image menu/action/error text now follows locale, and an uploaded visual is announced as a custom room icon rather than a color. Latest focused 12 UI tests, TypeScript, full Web 142 files / 993 tests and production build pass. Production upload and physical multidevice validation are still pending.

### 2026-10-23 — installed diagnostic update and current CI finding

- Published v1.3.12 after CI 39933800344 and Desktop 39933821081 succeeded and signature/notarization/feed checks passed. The normal native updater downloaded and restarted the installed app; installed CFBundleShortVersionString now reads 1.3.12. The initial loading fallback transitioned to authenticated ShogunAI General without a successful reload click. Existing Simple navigation and channel settings remain visible. This is not proof that intermittent blank rendering is fixed.
- Room visuals source e01fe64a is pushed. CI 39935681536, Worker deployment 39935681525 and Web deployment 39935681425 were revalidated live. CI End to end job 120354517910 failed: the mark-unread test received a successful revisioned unread response but timed out waiting for .slk-side .cl-thread.unread[data-view^="g:"]. Other completed CI jobs succeeded. Exact failing test is e2e/spec.mjs around line 3458; full job log saved at /tmp/honmaru-e01-e2e.log. Investigate read synchronization before claiming release verification; production image upload is still pending.

- Investigating the unread failure found a concrete React ordering hazard: socket activity depended on a variable assigned inside the message state updater, which React may defer. Replaced that dependency with independently timestamp-ordered activity updates; delayed history/duplicate/thread-only events do not overwrite the current sidebar activity. This is a candidate fix, not yet proof of the CI failure cause. Focused read/activity suites: 7 tests pass; full Web: 143 files / 995 tests pass; TypeScript passes. Local real-Worker/D1 E2E is running in session 38438, log /tmp/honmaru-activity-e2e.log, currently applying local migrations. Preserve the running job; do not restart on an observation timeout.

- Downloaded CI artifact 12494305768 and inspected /tmp/honmaru-e01-shots/fail-1792749828398-kenji.png: the phone did return to its list, but the group row remained non-bold without an unread marker. This rules out a failure to return to the list as the observed symptom. The candidate fix remains unproven until E2E finishes. Local session 38438 completed migration/browser setup and is now at “5. Drive it”; keep that same running session. Remote runs remain live and have not been restarted or canceled.

### 2026-10-23 — production room image verification

- e01fe64a Worker deployment 39935681525 and Web deployment 39935681425 succeeded. CI 39935681536 completed with the previously identified unread E2E failure; do not describe it as green.
- Installed Mac 1.3.12, authenticated private Select workspace: restored the existing empty UI色検証 room, uploaded a synthetic 96×96 PNG through the native file chooser, and observed successful custom-image rendering in room settings, sidebar, header and empty state. A reload retained the image and reopening settings reported a custom visual. Screenshot: /tmp/honmaru-room-image-production.png. Removing the image restored the original lake icon. Re-archived the QA room, confirmed it disappeared while the Mac assistant remained, and returned to ShogunAI General Simple. No messages/provider calls or real personal images were sent. Physical multidevice checks remain pending; KY-095 is partial.
- Local E2E session 38438 finished with 19 failures. The first command-palette checks used Control+k on macOS; the Japanese workbench check then failed before restoring English, cascading into English-label failures. The unread step failed before reaching the unread action, so this run does not prove or disprove the activity fix. Changed the three remaining hard-coded palette shortcuts to the platform-aware Meta/Control expression already used elsewhere. A new full run is live in session 97959, log /tmp/honmaru-activity-e2e-mac-fixed.log.

- Added the bounded JSON input parser for future room inbound webhooks: mandatory stable eventId, normalized 1–4000-character text, 32 KiB streaming cap, strict UTF-8 JSON, and no acceptance of caller-supplied routing/authorship. Three focused Worker tests pass. This is only input handling: no public endpoint, credentials, database receipt, thread creation or agent dispatch is connected yet; KY-094 remains missing. Local E2E session 97959 continues against the existing built source. Also moved Japanese-workbench account-language restoration into the test cleanup hook so an assertion failure does not contaminate subsequent tests.

- E2E session 97959 completed with one failure; the read/unread/forward test passed. The remaining long-reply test reported textarea/layer scrollHeight 308 and scrollTop 68 for both, with height 240, but assumed any scrollbar consumes width. macOS overlay scrollbars correctly report width zero. Changed the test to require actual overflow and a positive scroll position on every platform, retaining the width-consuming scrollbar requirement on Linux/Windows. This does not change product rendering. Syntax check passes. Full E2E rerun session 66360 is live at /tmp/honmaru-activity-e2e-final.log; do not restart before completion.

- Added room webhook identity helpers: 256-bit random bearer secret with persisted SHA-256 digest only; stable organization/hook/event-scoped key and existing message-client-ID-compatible identity; separate payload digest detects changed content under a reused event ID. Secret rotation does not change event identity. Eight focused input/identity tests pass. These helpers are not an exposed webhook and do not themselves provide durable exactly-once processing, revocation, membership checks or dispatch. No production credential was created. Full E2E session 66360 reached browser driving and remains live.

- Added uncommitted hx_room_hooks schema/migration and DB management functions: atomic creation checks the original membership incarnation, list excludes secrets, versioned rotate/revoke, and authentication rechecks active room and original membership. Three real-D1 tests pass for lifecycle, private-room outsider/admin isolation, separate organization denial, stale versions, membership reincarnation and archive. No API route/UI or event-to-thread delivery yet; do not deploy this as a complete inbound webhook. Authentication is only a preflight; eventual message insert must recheck the same grant atomically to prevent revocation races. E2E session 66360 continues against its already-started local app; no live backend source it imports was modified.

### 2026-10-23 — full local E2E passes, delivery started

- Session 66360 completed with exit 0 and ALL PASSED in /tmp/honmaru-activity-e2e-final.log. This covers the corrected activity path, unread action, platform shortcuts, Japanese cleanup and long-reply scrolling. Pushed committed source through 57e5a642 to main. New live runs: CI 39940180694, Worker 39940180570, Web 39940180698. Uncommitted hx_room_hooks schema/management is excluded. The committed input/identity helpers have no public route. Do not claim production delivery of the activity fix until deployment and CI finish.

- Added uncommitted atomic room-hook event receipt/root-message insertion. Stable event identity returns the existing root on retry and rejects changed payloads; a D1 batch rechecks hook version/revocation and creator membership incarnation at write time. Six focused real-D1 tests pass, including four concurrent deliveries creating exactly one root, stale authenticated grant after revocation or rejoin, secret rotation and room access. Synthetic webhook author identity is stored separately from people; display-name integration, authenticated public endpoint, broadcasts, thread metadata and agent dispatch remain unfinished. Do not claim end-to-end receipt or publish it yet.

- Connected uncommitted /hx/rooms/webhooks management API (GET list, POST create, PUT rotate/revoke) through session membership, room visibility and harness.build permission; response is no-store and audit omits credentials. Seven focused DB/API tests pass, including invalid session and private-room outsider refusal. Initial test used the createSession helper incorrectly; corrected its required access-token argument and string return value before passing. Public delivery endpoint, webhook author presentation, durable dispatch/broadcast and management UI remain incomplete.

- Connected uncommitted POST /hooks/rooms/:id with bearer-only secret (not query), pre-body authentication, chat rate limit, bounded input reader and atomic event insert. HTTP test proves 201 initial receipt, 200 same-event replay, 409 changed payload and 401 invalid/revoked credentials; eight focused tests pass. Response is no-store. Broadcast, durable agent dispatch, webhook author display and management UI remain missing: successful receipt currently means durable root message only, not completed AI execution. Revalidated CI 39940180694, Worker 39940180570 and Web 39940180698 as live for previously pushed 57e5a642; no new push or restart.

- Added explicit Webhook · <name> author lookup to conversation/history/search/activity SQL paths, scoped by both org and channel. A revoked hook keeps its historical source name. Presentation test verifies no human authorRef/mine identity and no credential exposure, plus cross-org message lookup refusal. Related room-hook/channel tests: 2 files / 17 pass. Full Worker regression and actual display still pending; this source remains uncommitted/unpublished.

- Connected best-effort targeted live delivery after room webhook receipt (including replays, whose message IDs remain stable). The helper checks an active room, message scope and each current member's resolveChannel access before building personalized events; ten room-hook tests pass, including private-room outsider exclusion and archive suppression using a captured relay boundary. This is not durable live delivery and not physical multidevice proof. The final membership-to-socket race relies on relay enforcement and remains to verify. Agent dispatch and management UI remain unfinished.

- Inspection found targeted relay events previously trusted the HTTP-built audience. Added fail-closed org membership, active room and resolveChannel checks at the relay boundary for targeted b: channel_message events. Real socket test delivers before departure, removes membership, submits stale delivery, and uses a subsequent permitted event as a barrier to prove the private body is absent. Related relay/room-hook tests: 25 pass. Initial managed-room fixture failed its membership snapshot gate for numeric user IDs; replaced with a direct ordinary private-room fixture to isolate relay behavior. That managed-room creation/numeric-ID issue remains to investigate; not claimed fixed.

- Reproduced the managed-room fixture failure with legacy Admin/Engineer role casing. listMembers lowercases role names, but the SQL membership snapshot compared raw role text, falsely treating an unchanged membership as concurrent change. Normalize SQL role text and cast IDs to the same string representation. Regression failed before the change and now passes; room creation/hooks/relay suites: 3 files / 42 tests pass. This fixes snapshot representation, without changing membership grants.

- Added standalone uncommitted RoomWebhooks UI for list/create/rotate/revoke and one-time secret display, bounded requests, uncertain-write readback and unmount cancellation. Two component tests pass (secret dismissal, write-timeout retry lock); TypeScript passed before the subsequent scope-guard refinement. It is not yet mounted in RoomSettings, translated across locales or visually verified. Do not claim the user-facing management feature is available.

- Mounted webhook management behind RoomSettings → 詳細設定 → Webhook → 管理 for eligible members. It loads only on demand, returns to the original settings and blocks entry while room edits are unsaved. The management subtree is keyed by API/org/session/channel and is removed on scope changes. Added theme-token styling. Integrated test verifies lazy loading and return navigation; settings/webhook UI suites 13 pass, TypeScript passes. Japanese strings need localization; visual reference comparison and physical UI verification remain pending.

- Converted room webhook management and advanced-settings UI to the existing English-key localization system with Japanese entries; other locales fall back to English. Reused existing Create webhook/Revoke/Manage/etc. translations after TypeScript caught duplicate keys. Settings/webhook/i18n suites: 15 tests pass; TypeScript rerun passes. No visual parity or full localization claim is made yet.

- RoomWebhooks now owns its API/org/session/channel remount boundary, independently of its parent. Added late-create-response regression: switching rooms aborts the old request and the old name/secret never appear in the new room. Full Web suite: 144 files / 999 tests pass. Started full Worker suite in session 92829, log /tmp/honmaru-room-hooks-worker-full.log; freeze backend sources until completion. Previously pushed CI 39940180694 still has live E2E/Worker jobs; all completed required jobs currently succeed. Worker/Web deployment runs remain live.

### 2026-10-23 — Webhook list recovery and published CI verification

- GitHub REST confirms commit 57e5a642 runs CI 39940180694, Deploy Worker 39940180570, and Deploy Web 39940180698 all completed successfully. These runs do not cover the uncommitted full room webhook implementation.
- RoomWebhooks now distinguishes an initial list failure from a successfully loaded empty list. Creation stays disabled until the existing hooks have been read; a successful Reload list restores creation. Regression checks failure display, disabled creation, and successful recovery. Focused Webhook UI suite: 4 tests passed.
- Full Worker session 92829 remains live (PID 27527 observed with active workerd child); no backend changes made while it runs.
- Kylon screenshot was readable, but subsequent native interaction returned noWindowsAvailable. This is not evidence of a locked Mac or of UI parity; visual verification remains pending.

### 2026-10-23 — Webhook dialog fidelity

Kylon native app inspection recovered after rebinding the app. Its Webhook dialog stacks over room settings, has a 512px-wide card, a horizontal name/create row, and a Close footer. Honmaru now preserves the underlying room settings, uses the observed dialog width and horizontal form, and provides the footer return action; small screens wrap the form. Reload appears when useful (failure or existing entries), rather than occupying the empty reference layout. RoomSettings/RoomWebhooks 15 tests passed. No Kylon credentials or events created; reference dialogs closed without saving.

Local visual preview remains unverified: both IAB and Chrome tooling report local browser use disabled in Work settings. Temporary preview server and files removed. Existing AgentRunner inspection shows session-based dispatch and dequeue-before-run semantics; webhook execution must use an explicit webhook grant and durable recovery instead of impersonating a login session or claiming exactly-once AI execution. Full Worker session 92829 is still running; backend unchanged.

### 2026-10-23 — Room webhook execution grant

- Full Worker run 92829 completed successfully: 214 files / 1,664 tests. This is the baseline before the later guest-case correction and does not include the new execution-grant module. Full Web layout run 15356 also completed successfully: 144 files / 1,000 tests.
- Added roomHookExecutionGrant as a standalone, not-yet-wired execution-time resolver. It joins the stored event receipt, exact source message, hook, creator membership incarnation, conversation membership, active business and room access. It applies current harness.build permission without minting a session or exposing a secret. Tests cover valid receipt, wrong workspace/missing receipt, revocation, mixed-case guest downgrade, rejoin, archived room, and deleted source message.
- Corrected existing room hook authentication/write SQL to normalize membership role casing. A Guest downgrade after authentication now prevents the atomic receipt/message write. Focused final suite: 2 files / 16 tests passed.
- Remaining: durable dispatch/recovery, integration with the agent runner under the dedicated grant, execution results/status presentation, visual verification and production release of the full webhook feature. No claim of completed agent execution. Backend baseline freeze ended after full test completion.

### 2026-10-23 — Durable room webhook handoff

Added hx_room_hook_dispatch to schema and migrations. Receipt, root message, and pending handoff now commit in the same D1 batch; a trigger-induced dispatch insertion failure verifies rollback of all three. Event replay creates no second handoff. Added an unconnected drain with bounded batches, 60-second claims, a 10-second queue request timeout, bounded exponential retry, fresh execution-grant checks, lease-guarded finalization, and acceptance only on HTTP 202. Tests cover 503/retry, concurrent claim exclusion, revoked grants, and recovery after an abandoned lease expires. Combined hooks/grant suite passed 20 tests; after adding abandoned-lease coverage, hooks suite passed 16 tests (grant suite unchanged, 5 previously passed).

This drain is deliberately not called by public routes/cron yet: AgentRunner must first support room_hook jobs and durable execution status. Queue acceptance is not model execution success. No claim of exactly-once external model execution, no new services, and no production deployment of this unfinished feature.

### 2026-10-23 — Webhook agent jobs

Added runRoomHookAgents: stored receipt/grant resolution, current channel resolution, normal permitted responder selection, and internal payer identity without a login token. Shared runAgents accepts an optional authorization guard and checks it before provider work, before each responder, before model invocation, and before normal/error reply persistence. Existing callers retain default behavior. AgentRunner now recognizes room_hook jobs with their own receipt/key namespace, retains them through execution, stores outcomes, and marks previously started jobs interrupted rather than silently repeating an unknown external call. Unknown job kinds are rejected.

Combined grant/runner suite: 13 tests passed. Additional interrupted-run regression added and executed separately. These tests prove selection/authorization and queue lifecycle, not an actual external AI answer. The dispatcher remains unconnected to public/cron entrypoints until result presentation, authorized retry, per-agent async teammate revocation, and end-to-end checks are implemented. No production webhook release yet.

### 2026-10-23 — Webhook reply path and revocation during model response

Exercised the actual runRoomHookAgents → responder selection → runAgents → model adapter → thread message persistence path with a mocked OpenAI Responses endpoint. Verified an agent-authored reply is saved under the exact webhook event root; no external API call or charge was made. A second test revokes the hook inside the mocked model response and confirms zero reply rows and cancelled/answered=0. Fixed shared runner success counting to increment only after a model answer has been persisted, not before the final authorization check/write. Ran the existing agents suite alongside the webhook grant/run suite to cover ordinary behavior.

Remaining limitations: the final authorization read and message insert are separate DB operations; an atomic guarded reply write is still needed for the narrow revoke-between-check-and-insert race. External teammate asynchronous completion also needs source-grant propagation. Dispatcher public/cron wiring, user-facing status/retry, real UI verification, full regression and production deployment remain unfinished.

### 2026-10-23 — Atomic webhook reply authorization

Closed the documented source-grant check/insert race for ordinary model replies. The internal roomHookSource flag now reaches postMessage; its INSERT predicate checks the stored event/root, hook revocation, creator membership incarnation/non-guest role, room membership, and active room in the same SQLite statement. Normal and error replies use the predicate. A test wrapper revokes the hook immediately before executing the prepared INSERT and proves no reply is inserted (webhook_revoked/403). The real mocked-model path and ordinary agents/channels regressions pass: 3 files / 51 tests.

Still open: propagation through asynchronous external teammate runs, agent-specific permission changes during execution, user-visible durable statuses/retry, entrypoint wiring, full regression/visual QA and production deployment. The new guard is internal; it is not exposed as a client-provided authorization override.

### 2026-10-23 — Delayed external teammate replies retain webhook authority

Added ai_teammate_runs.room_hook_source in schema/migration and propagated the stored root through new/continued teammate runs. A start revalidates the source grant, channel, thread and creator login before adapter dispatch. A subsequent human-initiated turn clears the source field rather than inheriting an old automation grant. Started/status messages and final teammate replies use the same atomic webhook reply predicate; mismatched source/thread results are discarded.

Regression tests use mocked Anthropic requests only. They start a real teammate code path from a stored webhook event, verify source ID persistence, then complete asynchronously: an active hook saves its answer, a revoked hook saves none. Existing plus delayed-completion teammate suite: 8 tests passed. Earlier combined teammate/grant suite: 17 tests passed. This prevents publication after source revocation; it does not claim to cancel an already-running external service task or undo its incurred usage. User-facing status/retry, agent-specific grant changes, entrypoint wiring and full release verification remain.

### 2026-10-23 — Recent webhook event status

Authorized room webhook GET now includes the latest 20 non-deleted source events without event bodies/secrets. An internal bounded AgentRunner status endpoint returns only row ID, state and answer count, distinguishing queued from completed outcomes. Status resolution degrades to unknown on unavailable runner responses; a finished operation without saved model answers is not reported as a saved reply. The management UI lists event source name/time/status and supports refreshing through Reload list.

Tests: existing hooks/queue suites 23 pass; status mapper 2 pass; Webhook UI 5 pass (queued/unknown never rendered as Reply saved), earlier settings+webhooks 15 pass before this added UI test. Typecheck executed separately. Visual rendering of the newly added event list remains unverified due browser tooling disabled. External teammate running/completion state needs to be reconciled into this view, and retry is not implemented yet. No full feature production deployment or dispatcher entrypoint wiring.

### 2026-10-23 — External execution status in webhook history

Room event history now aggregates external run/running/failure counts scoped by workspace, source event and channel, with a supporting index in schema/migration. Active external work takes priority over an ended dispatcher; failure/budget and external completion have distinct states. External completion deliberately does not claim a reply was saved. The UI includes localized labels. Runner status outage still permits presentation of authoritative external run state. Cancelled/interrupted runner states remain visible.

Mapper+hook tests: 20 passed before additional SQL-isolation test; final hooks suite verifies foreign workspace/channel runs do not contaminate counts. Webhook UI 5 tests passed; TypeScript check passed. Retry UI, entrypoint wiring, complete regression/real-render validation and production release are still pending.

### 2026-10-23 — Versioned manual webhook retry backend

AgentRunner now exposes an internal retry operation that resolves the current source grant, requires the original creator ID, refuses an external run still in progress, and compares the observed terminal result timestamp inside the storage transaction. Only failed/interrupted/no-agent results qualify. Interruption requires an explicit boolean acknowledgement. Previous outcomes are preserved in history; the original receipt remains so provider redelivery cannot trigger another run. Queue capacity and already-queued work are enforced transactionally. Result versions are monotonic relative to queuedAt, avoiding a same-millisecond repeat matching an old version.

Queue tests passed 9 cases, including four concurrent retry requests producing one queued job, history retention, running/finished/cancelled/stale rejection and interruption acknowledgement. Internal status returns the version when available. This is not yet exposed through the authenticated management route or UI; those still require scope/creator checks and result-refresh handling. No new model execution or charges in verification.

### 2026-10-23 — Authenticated webhook retry UI

Connected retry to the authenticated room-management PUT action. It rechecks source workspace/channel and original creator, forwards the observed result version, and leaves uncertain responses requiring list readback. Event status now exposes canRetry only for current original-creator grants and eligible versioned terminal states. The UI sends nothing on the first interrupted Retry click; it explains unknown prior outcome, then sends an explicit acknowledgement on the second action. Accepted retries switch to queued and remove retry controls.

HTTP test verifies interrupted status/version eligibility, rejection without acknowledgement, successful acknowledged retry, rejection of the stale duplicate, and queued/non-retryable readback through the real Durable Object. Final hooks suite 18 tests passed; UI suite 6 passed; TypeScript passed. Earlier hooks/status suite 21 passed. Confirmation styling uses existing theme tokens. Real rendered verification remains pending; initial dispatcher/public-cron wiring and complete feature release are not done.

### 2026-10-23 — Public receipt and scheduled handoff connected

Public webhook receipt now attempts a bounded handoff for its exact workspace/message alongside live broadcast; a queue outage does not undo a durable receipt. The existing minute cron drains pending handoffs. Drain batches use concurrent, individually claimed jobs with existing request timeouts instead of serial waits that could exceed the background deadline.

Connected suites passed 38 tests. The public HTTP regression then explicitly verified accepted dispatch, duplicate delivery producing one queued job, real AgentRunner alarm execution, and no_agents outcome for a room without responders (18 hooks tests pass). The mocked-model reply and external teammate completion tests from prior checkpoints cover those execution paths without paid calls. Full Worker and Web suites restarted against this connected implementation; no production publish has occurred. Agent-specific permission revocation during execution, rendered UI verification and full release validation still remain.

### 2026-10-23 — Inspect existing conversation before retry

Full connected Web suite finished: 1,002 tests pass. Worker session 51933 remains active; no backend changes during that run. Browser inventory again returned local browser use disabled in Work settings, so no rendered proof is claimed.

Added View conversation to each recent webhook event using the shared thread-link helper with explicit workspace context. Following the link closes room settings so the existing thread is visible; links do not navigate during an in-flight management mutation. This completes the missing inspection step in the interrupted-retry guidance. Focused settings/webhook UI suite: 18 tests pass; TypeScript passes. Full Web suite predates this link addition.

### 2026-10-23 — Webhook credential copy controls

Added URL and authorization-header copy buttons using the existing Icon component. A rejected/unavailable Clipboard API produces manual-copy guidance, never a false Copied confirmation. Mutation/hide/unmount scopes invalidate late copy notices; secrets remain one-time component state and are not added to persistent storage. Explicit user clicks copy them to the clipboard as expected. Focused settings/webhooks suite: 20 tests pass, including clipboard success/failure and hiding the credential; TypeScript passes. Worker full session 51933 remains running; backend unchanged during it. Rendered validation remains outstanding.

### 2026-10-23 — Final Web build and current agent access resolver

Latest production Web build succeeded; latest full Web suite passed 1,005 tests. Worker full session 51933 is still live. Added a new, currently unreferenced roomHookAgentAllowed helper that resolves the current source/channel and normal respondingAgents permissions again. Its isolated test proves an initially allowed agent becomes disallowed after profile restriction and deletion. Existing backend files remain unchanged while the baseline Worker suite runs; integrating this resolver and atomic per-agent write authorization is still pending.

Requested browser-setting enablement asynchronously because tools explicitly report local browser use disabled in Work settings. No unlock request or alternate browser bypass attempted. User response/actual rendered UI validation still pending.

### 2026-10-23 — Deployment ordering and execution-time agent permissions

User reported local browser use enabled. The next documented IAB tab inventory still returned `Local browser use is disabled in Work settings`; real rendered validation remains pending, and no alternative automation bypass was attempted.

The running Worker baseline (session 51933) reported the schema/index ordering regression. Removed idx_teammate_runs_hook from schema.sql; migrations.sql still creates it after adding room_hook_source. Added an old-table deploy/replay regression checking preserved run status/cost/source and index columns. Focused migration suite: 10 passed. The baseline remains live and predates this fix; it is not evidence of a clean current full suite.

Integrated fresh responder authorization per agent before model calls/replies and into delayed teammate completion. Existing general source authorization is unchanged. Model-response tests now revoke agent profile access or delete the agent during the mocked provider response and prove no reply is persisted or counted. Three focused suites: 22 passed. Expanded the delayed completion regression to active/revoked/deleted-agent cases: all 9 teammate tests passed. The external fixture explicitly addresses @claude, matching actual routing. No real paid provider calls were made. Atomic per-agent write authorization, final full Worker validation, rendered UI validation and feature release remain outstanding. Latest complete Web result is still 1,005 passed plus successful build.

### 2026-10-23 — Atomic agent permission at reply insertion

Added agent existence/profile/access/explicit membership-incarnation checks to the same SQL statement as webhook reply insertion. Keeps owner, people-list, explicit team role and unprofiled Simple room-placement permissions; removed/stale grants cannot write. New regressions mutate profile/scope/deletion immediately before INSERT and assert no persisted reply. Source-revocation regression now creates an eligible agent so the denial cannot be a missing-agent false positive. The last external-adapter start check also recomputes responder access.

Focused execution, teammates, public webhook and migration suites: 57 tests passed. The prior full Worker run naturally completed with 215 passing files and only the known schema/index failure (1,694 passed, 1 failed); the attempted interrupt found no process because it was already terminal. Started a fresh full Worker run against current code: session 77990, log /tmp/honmaru-hook-final-worker-full.log. No current full-pass or feature deployment claimed. KY-094 status now accurately records local partial implementation, with rendered/production/multi-user acceptance still incomplete.

### 2026-10-23 — Native Kylon webhook visual reference checked again

Native Kylon interaction succeeded after one transient capture error: opened room menu, settings, advanced settings and Webhook management. Captured the actual layered 512px dialog at /tmp/kylon-webhook-reference-20261023.png. Confirmed description, horizontal name/create row, example placeholder, empty message, footer Close and return to the underlying settings. Closed settings without saving or creating a webhook.

Matched the local dialog description/placeholder/empty wording, added the missing advanced-settings description card, and connected the dialog lede to its existing accessible description. Scoped field/focus colors now use Harness theme tokens. These are source changes, not proof of Honmaru rendered parity. Focused settings/webhook tests: 20 passed; TypeScript passed. Started fresh Web full suite and production build. Worker full session 77990 remains active with backend unchanged since that run began. Production feature release remains pending.

Current Web validation completed: 144 files / 1,005 tests passed, production build succeeded. Existing bundle-size/ineffective dynamic-import warnings remain. Worker session 77990 was polled and is still live; no full backend result yet.

### 2026-10-23 — Keyboard submission and app viewer reference

Webhook creation now uses a native submit form. Enter submits a trimmed name, composition Enter (including Safari keyCode 229) does not submit, and the existing synchronous in-flight guard prevents duplicate submission. Focused settings/webhook suite: 21 passed; TypeScript passed; full Web suite: 1,006 passed; production build succeeded. Worker full session 77990 remains live and unchanged.

Native Kylon existing app data viewer was inspected: More contains text wrapping, and column header clicks cycle ascending → descending → unsorted. Returned the column to unsorted and closed the app panel. Honmaru source already implements that cycle via nextColumnSort and the wrap-text menu; this source comparison does not prove rendered parity. Native app observation is usable despite intermittent capture/window errors. After full backend validation and normal deployment, use Honmaru native UI to verify the new Webhook screen; local browser setting remains unresolved, but it need not prevent native production verification.

GitHub API confirmed the latest existing main revision 57e5a642 has completed successful CI, Web deploy and Worker deploy. No remote run is live; no new code pushed in this checkpoint.

### 2026-10-23 — Full backend passed and release dispatched

Worker full session 77990 completed successfully: 217 files / 1,707 tests passed, 870.72 seconds. Latest Web suite remains 1,006 passing tests, with successful typecheck and production build. Worktree was clean at code commit cc7ef49d6c175794731432cfbcb83edd2909ffe2. Fetched main, verified fast-forward ancestry, then pushed cc7ef49d to main successfully. No workflow edits or test-gate bypass.

GitHub runs for that exact revision: Deploy Worker 39948523401 in progress; Deploy Web 39948523367 in progress; CI 39948523403 queued. These are release-start evidence, not deployment-completion evidence. Pre-release production /health returned ok:true. Native Honmaru production app was observed on ShogunAI General in Simple mode; no settings changed. New Webhook UI and production behavior still require post-deploy validation. Do not push another revision while these release runs remain active.

### 2026-10-23 — Follow-up managed-room role normalization

While auditing all-member room integration points, found managed-room SQL treated mixed-case Guest as eligible even though central role checks normalize names. Added regressions for Guest/GUEST editing, response changes, archiving and a demotion immediately before the write batch: all three newly added tests failed against cc7ef49d. Normalized role comparisons in roomRoles, roomSettings and roomCreation, including transactional guards; existing custom non-guest titles remain eligible. Four related suites passed 100 tests after the fix. A new full Worker validation is running at /tmp/honmaru-room-guest-worker-full.log; this is a follow-up, not included in the active cc7ef49d release.

Latest cc7ef49d remote status: Web, Desktop, Local gateway, Reference relay and Shared core/mobile CI jobs succeeded; Worker and E2E still running. Worker deployment is testing, Web deployment waits for the matching Worker. No second revision pushed while those runs are active. Default all-member room identity/auto-join remains unimplemented; inspected creation/membership entrypoints but did not alter existing General rooms or silently widen room audiences.

### 2026-10-23 — Native production validation room prepared

In the installed Honmaru Mac app, switched from ShogunAI General (Simple) to the personal Select workspace (Harness), and created private room `QA Webhook 2026-10-23` through the three-step UI. Selected no additional people or agents. Final room header shows one member; no message sent, no hook credential created, no provider invoked. Screenshot: /tmp/honmaru-webhook-qa-room.png. Keep this room until post-release verification, then archive it and restore ShogunAI General.

Observed a remaining Harness composer fidelity gap: the old always-visible FormatBar, decision action and scheduling chevron remain, unlike the compact reference composer. Source is ClassicList.tsx main composer around line 5426. No speculative controls added; reference new-thread/add-menu behavior needs inspection before changing this surface. Simple mode must retain current tools and layout.

Exact cc7ef49d release runs remain live (Worker tests / Web waiting for Worker / E2E in progress). Follow-up role-normalization full Worker session 38964 is still live. No subsequent push or deployment completion claimed.

### 2026-10-23 Harness composer compact menu (local)
- Native Kylon composer inspected: plus menu, mention, connections, new-thread toggle. Harness main composer now puts attach, mention, integration management, formatting, decision and scheduling into a plus menu. Simple toolbar retained. Theme tokens support light/dark; Escape, outside dismissal and keyboard navigation included.
- Web: 145 files / 1007 tests passed; TypeScript and Vite build passed. Rendered verification and deployment pending. New-thread mode and dictation parity remain incomplete; integration management does not claim per-message connection selection.

### 2026-10-23 Harness composer dictation (local)
- Added microphone control only where browser speech recognition exists. Stops accepting results after manual edits, draft clearing/sending, room/workspace changes, unmount or disabled state. Recognition failure is visible. No automatic send. Simple remains unchanged.
- Web 146 files / 1009 tests passed, TypeScript and Vite build passed. Regression tests cover late transcripts after typing, sending and room changes; unsupported clients hide control. Real microphone, rendering and production deployment remain unverified.

### 2026-10-23 release gates and dictation boundaries
- cc7ef49d: CI39948523403, Worker39948523401, Web39948523367 all completed success. Guest normalization follow-up: Worker217 files/1710 tests passed.
- Dictation caps text at the composer 4000-character boundary and stops capture on recognition error; 4 focused tests and TypeScript passed. Physical microphone verification remains pending.

### 2026-10-23 production Webhook native verification
- Native Honmaru AI 1.3.12, Select private room QA Webhook 2026-10-23 (1 member): opened room settings → advanced → manage. Live Webhook list loaded empty; input enabled and empty-name creation disabled. Dark screenshot: /tmp/honmaru-webhook-production-20261023.png. Escape closed child only and restored focus to Manage in parent. No credentials created, no message or model execution.
- Reload/Force Reload produced blank native surface; diagnostics recorded inspect-visible despite blank screenshot/AX. Full app quit and launch restored actual web UI. Root cause remains unresolved; restart is recovery evidence only, not a fix.
- New revision 9e71d4c6 runs: Worker39950951411, CI39950951389, Web39950951507 confirmed in progress. Do not overlap with another push.

### 2026-10-23 native reload follow-up
- After successful full restart and Webhook inspection, dismissed parent settings and performed normal Cmd-R again. This time AX returned the actual room, messages empty state and composer, with the same signed-in workspace. Reload failure is intermittent, not reliably reproduced on every reload. No renderer fix is claimed.
- Read loadRecovery/main/CSP/attention implementation; no evidence yet identifies a root cause. Avoid disabling GPU/security or resetting persisted user data based on this observation alone. Current 9e71d4c6 CI/Worker/Web handles were re-polled and all remain in progress.

### 2026-10-23 new-thread composer mode (local)
- Added Harness-only new-thread toggle, translated placeholder/send label and success opening of delivered root via existing thread API. Simple unchanged. Pending/retry delivery retains only the in-memory navigation intent; navigation, toggle cancellation and unmount invalidate it. Reload does not resurrect an old navigation intent. Scheduled messages do not open a nonexistent root.
- Web147 files/1012 tests, TypeScript and Vite build passed. Hook regression exercises single opening, changed room, leave/return, off/on and unmount. Full send UI/native production verification remains pending; no 100% parity claim.

### 2026-10-23 composer intent isolation follow-up
- New-thread pending navigation now invalidates on auth session/API changes and opening a different thread in the same room, using an opaque memoized scope instead of delimiter-joined identifiers. Dictation remounts when signed-in user changes.
- Web147 files/1013 tests and TypeScript passed. Session/selected-thread regression added. Native send verification remains pending.

### 2026-10-23 composer keyboard menu follow-up
- Plus trigger ArrowDown/ArrowUp opens first/last enabled menu action; Home/End/arrows navigate. Tab restores the trigger before native traversal, formatting receives keyboard focus, blur closes stale popovers. IME events retain existing guard.
- Web147 files/1014 tests and TypeScript passed. Native production verification pending. Prior 9e71d4c6 CI/Worker/Web confirmed still in progress; no overlapping push.

### 2026-10-23 production Webhook light theme
- Native Honmaru1.3.12: changed original System theme to Light in profile, opened QA room settings → advanced → manage. Empty list loaded; input, labels, dividers and disabled create button rendered without clipping. Screenshot /tmp/honmaru-webhook-light-20261023.png. No credential created. Closed child then parent and restored System (AX selected=1) after inspection.
- Exact 9e71d4c6 CI jobs: gateway, desktop, relay, web, shared/mobile and E2E successful; Worker test in progress. Worker deploy also in Test; Web deploy waiting for matching Worker. These are live waits, not a deployment failure.

### 2026-10-23 composer visual reference correction
- Re-inspected actual Kylon native screenshot: new-thread control sits immediately after plus, icon-only when inactive; label appears only while active. Replaced edit-pencil icon with branching-lines icon, moved control left, made label conditional, and matched Harness ordinary placeholder. Simple remains unchanged. Reference toggle restored inactive; no messages sent.
- Web147 files/1014 tests, TypeScript and Vite build passed. Honmaru rendered comparison remains pending deployment.

### 2026-10-23 room header reference alignment
- Actual Kylon screenshot shows cube for Apps, lightning for Automation, folder for Files and @自分 filter. Updated only Harness room actions/filter accordingly; Simple toolbar and translation of its Automations unchanged. TypeScript and diff check passed. Rendered Honmaru check pending.

### 2026-10-23 composer production regression
- 9e71d4c6 CI/Worker/Web all successful. Pushed33263ecf; Web39953346717 succeeded, CI39953346715 remains active.
- Native 9e71d4c6 showed increasing plus controls (AX2→7; screenshot5) after restart. Found duplicate sibling React keys for HarnessComposerMenu and HarnessDictation in that revision.33263ecf already differentiates dictation with userId; follow-up now gives explicit menu:/dictation: prefixes plus account scope. Native verification of corrected revision remains pending, so root-cause resolution is not yet proven.
- Cmd-R blank surface recurred; full restart recovered. This is a separate unresolved issue.

### 2026-10-23 native production composer and thread send
- Loaded33263ecf after full native restart. One plus button, new-thread toggle and microphone displayed. Mode enabled changed placeholder/send label, plus menu opened with actions and disabled decision/scheduling for empty draft. No duplicate plus controls during these interactions. Explicit key-prefix follow-up1218239c not yet deployed.
- In private QA Webhook2026-10-23 (member count1), sent self-only plain UI test message. It appeared in sidebar as a new thread; delivery opened thread automatically and focused reply composer. No AI reply, external integration or credential creation was invoked. Evidence /tmp/honmaru-composer-production-20261023.png and /tmp/honmaru-new-thread-production-20261023.png.
- Found remaining rendered discrepancy: thread reply composer still uses old attachment/format toolbar. Main composer improvement does not prove reply-composer parity. Native capture intermittently returned SCStream-3811; refreshing AX recovered without re-sending.

### 2026-10-23 compact reply composer (local)
- Inspected Kylon actual existing thread: reply placeholder, plus, mic and send. Harness reply composer now uses shared plus menu and guarded dictation, with unique scoped sibling keys. Formatting and Also-send-to-conversation retained in menu; active broadcast visible in bar. Simple unchanged. Unsupported decision/scheduling actions omitted.
- Web147 files/1015 tests, TypeScript and Vite build passed. Native production reply verification pending.

### 2026-10-23 new-thread recovered delivery follow-up
- Failed-send settlement from socket, fresh history, or retry now passes the confirmed server message to the scoped new-thread intent. Existing matching/dedup rules retained; restored outbox entries have no resurrected navigation callback. Microtask for history settlement avoids state changes during render. Scope invalidation still prevents unrelated navigation.
- Web147 files/1015 tests, TypeScript and Vite build passed. Actual network-loss delivery E2E not yet verified.

### 2026-10-23 narrow composer popover correction
- Existing ClassicList.css hides .slk-format below719px; new Harness formatting popover inherited that rule and would show no controls. Added more-specific popover-only display override, wrapping, width bound, scrollable menu height and larger coarse-pointer targets. Simple mobile toolbar remains unchanged.
- Vite production build and diff check passed. Physical mobile/keyboard viewport verification remains pending; desktop screenshot is not evidence for mobile usability.

### 2026-10-23 main composer formatting native verification
- Production33263ecf native Mac: typed local draft Formatting check, selected only check, opened plus → Formatting → Bold. Actual textarea became Formatting *check*, with check still selected. Confirms selection survives both menu transitions and formatting applies to selected range. Cleared draft afterward; did not send it. One plus remained throughout.
- CI39953346715 job audit: gateway/E2E/relay/shared-mobile/desktop/web succeeded; Worker npm test remains active. Reply changes not pushed over live CI.

### 2026-10-23 production compact reply delivery
- CI39953346715 succeeded; pushed3eaa287c. Web39954932116 succeeded; CI39954932158 remains active.
- Native Mac restart loaded new reply composer: one plus, microphone and send, with スレッドに返信… placeholder; old always-visible formatting/attachment controls absent. Sent one plain reply in self-only QA thread. Pending marker disappeared, reply count became1 and sidebar preview updated. Evidence /tmp/honmaru-reply-production-20261023.png. No external recipients/AI invocation requested.
- Physical microphone, mobile viewport, network-loss send and intermittent reload blank remain unverified/unresolved; reply delivery success is not full parity.

### 2026-10-23 bounded native layout diagnostics (local)
- Added renderer probe returning only integer flags0..127: root exists1, child elements2, nonzero root bounds4, root/ancestor visibility8, body text presence16, visible media32, visible startup panel64. Main validates range before recording layout-state. No text/URL/style values/screenshots/credentials persisted. Recovery still uses text/media presence; flags provide evidence, not a root-cause fix.
- Desktop17 files/125 tests passed, including hidden ancestors/zero-size root/transparent media and output-only flags. Requires a future desktop build/install before collecting new native evidence; web deployment alone cannot enable it.

### 2026-10-23 diagnostic desktop candidate1.3.13
- Updated required shared version manifests to1.3.13; version consistency passed. Desktop17 files/125 tests passed after bump.
- Local unsigned arm64 package succeeded at /tmp/honmaru-1.3.13-build/mac-arm64/Honmaru AI.app. Inspected app.asar: version1.3.13 and layoutProbe.js included. Not installed over signed app; not released. Signed/notarized build and native diagnostic collection remain pending.
- CI39954932158 was confirmed live; source push/release dispatch deferred until it completes.

### 2026-10-23 native reply broadcast toggle verification
- Production3eaa287c, self-only QA thread: plus menu exposed attachment, mention, integrations, formatting and Also send to conversation. Toggling the latter changed accessible checked state0→1 and showed the composer indicator. Toggled back to0; Escape closed menu and returned focus to plus. No message sent and original preference restored. Actual broadcast delivery remains unverified.
- Browser control still reports disabled despite user enabling it; native Mac accessibility remains usable. This is not a Mac lock diagnosis.

### 2026-10-23 Kylon reply connection submenu reference
- Native Kylon existing UI確認用タスク thread, read-only plus menu: File add with Cmd+U hint, Mention, Use connection submenu. Submenu accessibility lists Gmail, Google Calendar, GitHub, Notion, Google Drive, Slack, LINE Official Account, MCP Server, Linear, Read AI, Vocci, Plaud, Outlook, Google Sheets and Manage integrations. Screenshot /tmp/kylon-reply-connections-20261023.png. Escape restored original thread; no provider authorization started.
- Honmaru current composer routes Manage integrations to Tools; this is not equivalent to the observed submenu. Repository search found no message-level connectionIds/connection_ids/selectedConnections/integrationIds plumbing. App-specific hx_app_connections is a separate personal app capability and must not be assumed to authorize chat agent execution. Follow-up requires inspecting account/provider inventory, selected-connection message metadata, ownership checks at execution, and draft reset behavior before claiming parity.

### 2026-10-23 Harness reply count presentation correction (local)
- Kylon reference shows a horizontal divider above a prominent reply count. Harness now uses a top divider and14px semibold count, retaining theme colors. Removed separator role only for settled Harness counts so their text is not presentational to accessibility; loading/error status remains intact, Simple markup/styles unchanged. Native production AX previously omitted the settled count.
- TypeScript and Vite production build passed (/tmp/honmaru-thread-count-build.log). Native verification of changed count awaits deployment; CI39954932158 remains running, so no overlapping push performed.

### 2026-10-23 diagnostic release dispatched
- Prior CI39954932158 completed success. Pushed5b29ce89 to main only after terminal result. New CI39957222600 and Deploy Web39957222746 observed in progress at exact head5b29ce89eeaf00454cbd8bcdf78349f03013ac4d. Mac signed release39957249737 dispatched publish=false and queued at same head. Not yet published/installed/verified. Do not dispatch duplicate or push over these live runs.
- Connection execution audit: GET /connectors requires existing Composio configuration, returns personal active provider status for ingest; it is not an agent execution grant. agentTools currently exposes private connected sources only when personal=true; channelRoutes sets that only for root direct-agent conversations. A shared-room connection picker must carry explicit message-scoped ownership/audience authorization through execution rather than turn on personal tools for all room replies.

### 2026-10-23 production reply count and attachment shortcut candidate
- Deploy Web39957222746 succeeded for5b29ce89. Native Mac Cmd+R loaded successfully this attempt; reopened QA thread. AX now exposes 返信1件 as text; screenshot confirms divider above semibold count in dark theme. Evidence /tmp/honmaru-reply-count-production-20261023.png. One successful reload does not resolve intermittent blank.
- Local Harness composer supports primary-modifier+U for attachment picker in main/reply forms and plus menu, with platform-specific visible shortcut hint. IME, repeated/handled keys, Alt/Shift combinations excluded. Simple retains its prior handlers. Relevant keyboard/menu tests2 files16 tests, TypeScript and Vite build passed. Native picker verification/deployment pending.
- CI39957222600 and Mac signed release39957249737 remain active; do not publish/push over them.

### 2026-10-23 thread reload continuity gap
- Native production5b29ce89, QA thread open, Cmd+R: app loaded successfully but returned to room; manually reopening sidebar thread restored it. Kylon reference maintains an explicit thread URL. ClassicList openAt does not set a thread hash; linked-thread consumption deliberately replaces ordinary thread hashes with #/list, preserving only file-thread hashes. General thread navigation continuity is not achieved.
- Follow-up must extend canonical thread URLs and close/back handling together, guarding stale locate requests, room/workspace changes, and app-source panes; avoid a session-only workaround or changing Simple navigation. Current linkedIntent/linkedRoute/pendingLinkedThread and displayedFileRoute effects require coordinated changes and navigation tests.
- Full Web tests after attachment shortcut:147 files1016 tests passed (/tmp/honmaru-attachment-web-full.log). Draft421844628 for1.3.13 targets5b29ce89; assets still empty while Mac signed release39957249737 is building. CI39957222600 still live.

### 2026-10-23 Harness thread URL continuity candidate (local)
- Direct Harness thread opening now retains canonical workspace/thread URL from list/current-thread destinations, without replacing unrelated navigation. Incoming Harness thread links are retained; already-open matching thread avoids duplicate locate/reopen. Close consumes only the displayed matching thread URL; Simple ordinary-thread behavior remains unchanged. File route matching also accepts valid unqualified thread links.
- BackStack now syncs on address changes as well as layer depth, so switching threads at the same pane depth still permits Back to close the new pane. Added regression case for same-depth thread URL switch and close without stale object traversal.
- Related route/file/backstack28 tests passed; TypeScript, Vite build and full Web147 files1017 tests passed (/tmp/honmaru-thread-route-web.log). Real reload, Close/Escape/Back and workspace-switch verification still required after deployment. CI39957222600 and Mac release39957249737 remain active, no overlapping push.

### 2026-10-23 signed1.3.13 artifact verification
- Mac signed release39957249737 completed success. Draft421844628 remains unpublished at exact target5b29ce89eeaf00454cbd8bcdf78349f03013ac4d; ZIP/DMG/blockmaps/latest-mac.yml present.
- Downloaded ZIP /tmp/Honmaru-AI-1.3.13-universal-mac.zip:224215388 bytes, SHA512 matches /tmp/latest-mac-1.3.13.yml. Extracted app /tmp/honmaru-signed-1.3.13/Honmaru AI.app reports1.3.13. codesign --verify --deep --strict succeeded; spctl accepted Notarized Developer ID.
- CI39957222600 still in progress. Do not publish draft or install until matching CI succeeds. Diagnostic collection and actual blank-screen fix remain pending.

### 2026-10-23 thread route scope review
- Narrowed duplicate-locate bypass to a one-use record of this component's own hash update with identical resourceClient scope (base URL, workspace, session). Matching thread ID alone is insufficient after account changes or external navigation. Manual navigation clears the intent. TypeScript and Vite build passed. Native integration remains pending deployment.
- CI39957222600: E2E, gateway, Desktop, Web, shared/mobile and relay succeeded; Worker remains active. Signed1.3.13 is still a verified unpublished draft.

### 2026-10-23 Mac1.3.13 published and installed
- CI39957222600 completed success for5b29ce89. Revalidated matching CI/Mac workflow success and draft target; published release421844628 (v1.3.13) at2026-10-23T13:14:26Z.
- Native1.3.12 updater found1.3.13, downloaded, and offered restart. Restart action timed out in CUA, but installed Info.plist now1.3.13 and native app reopened logged in with QA room available. Diagnostics show1.3.13 startup.
- Signed archive layoutProbe.js/main.js/loadDiagnostics.js byte-for-byte match5b29ce89 source. Blank reload reproduction/diagnostic flag collection remains ongoing. Attachment shortcut and thread URL changes remain local/unpushed.

### 2026-10-23 diagnostic blank reproduction on1.3.13
- Cmd+R from loaded QA room reproduced blank native viewport and absent HTML accessibility tree. At13:16:31Z diagnostics: window-state5 (visible/focused/not minimized/not loading), layout-state63 (root exists/children/nonzero bounds/visible ancestors, text and visible media; no startup panel), inspect-visible. This contradicts a simple empty DOM/load failure explanation; investigate native painting/compositing or view attachment. No GPU/security settings changed. Screenshot /tmp/honmaru-1.3.13-blank-20261023.png.
- Quit/reopen initiated to restore usable app; do not claim fix from successful cold start.

### 2026-10-23 production thread continuity and attachment shortcut
- Pushed867b1afa after prior CI/release completion. Deploy Web39960018712 succeeded; CI39960018746 is active. Native1.3.13 opened QA thread and address became canonical #/t/<id>/<org>; Cmd+R restored that same parent and reply. Close returned to #/list and room. Open+Escape also returned to room. Browser Back and cross-workspace restoration remain unverified.
- In focused reply input Cmd+U opened native file chooser; cancelled with no upload. Main plus menu displayed ⌘U. Screenshot /tmp/honmaru-attachment-shortcut-production-20261023.png. Menu closed with Escape.
- Two additional reload attempts (empty chat and room) rendered successfully, so room selection alone does not determine blank behavior. No GPU/security changes. Official Electron APIs/issues investigated but no source proved root cause; do not treat older blank-window reports as this diagnosis.

### 2026-10-23 manual workspace navigation regression (local fix)
- Production867b1afa actual QA thread → workspace picker → ShogunAI returned automatically to Select: preserved thread URL triggered Dashboard external-link org switching. Manual picker/profile switching now replaces object URL with current mode destination before Dashboard remount, while external-link effects retain onSwitchOrg directly. Native verification pending deployment.
- Escape in workspace menu also closed underlying thread. WorkspaceSwitcher now consumes Escape and restores trigger focus, while ignoring IME Escape. Regression test added. TypeScript/Vite and full Web148 files1018 tests passed (/tmp/honmaru-workspace-navigation-web.log).
- Native Honmaru and Kylon navigation menus expose screen destinations, no history Back command; actual browser Back remains unverified because browser controller unavailable. CI39960018746 confirmed active; no push over it.

### 2026-10-23 workspace dialog Escape follow-up
- AddWorkspace had the same unconsumed document Escape as the picker. It now prevents/default-stops the key and returns focus to the workspace trigger when dismissed. No create/join action performed. Both picker/dialog regression tests passed; TypeScript and Vite build passed (/tmp/honmaru-workspace-dialog-build.log). CI39960018746 remains running, changes local until terminal result.

### 2026-10-23 production workspace navigation verification
- Deploy Web39962345274 succeeded at b4f5f436. Native Mac1.3.13 reloaded production and opened the existing QA thread. Workspace picker Escape and Add workspace dialog Escape each dismissed only their overlay, preserved thread URL/content, and restored trigger focus. No workspace creation/join performed.
- From the QA thread, manually selected ShogunAI: URL became #/list, Simple workspace rendered, picker confirmed ShogunAI selected without bouncing to Select. Returned to Select QA room successfully. Screenshot /tmp/honmaru-workspace-roundtrip-20261023.png. Browser Back and cross-account behavior remain unverified.
- After user reported browser enabled, cua.listTabs(browser=iab) still returned Local browser use is disabled in Work settings. Native verification remains available. CI39962345236 remains in progress; no overlapping production push.

### 2026-10-23 inventory consistency audit
- Found JSON status drift from matrix/code for KY-014, KY-033, KY-034, KY-074. Updated these four from missing to partial, retaining explicit remaining acceptance gaps. Current 95-item inventory:73 partial,18 missing,2 implemented,2 unverified. These are categorical counts, not a completion percentage. The previously reported69/22 split was stale.
- Inspected role ownership/CAS, skill catalog/read tool wiring, package handling, and stable file conversation tests. Re-ran agent-roles, harness-skill-package, harness-skills-access, files:4 files75 tests passed (/tmp/honmaru-parity-audit-tests.log). This does not prove native/provider/all-client parity.
- Added scripts/check-kylon-parity.mjs to fail on duplicate/missing IDs or divergent status between JSON and matrix; verified all95 entries agree. No product behavior, permissions, paid services, or Simple settings changed.

### 2026-10-23 workflow webhook credential lifecycle fix (local)
- Found updateWorkflow retained hook_secret when changing away from webhook and reused it on return, reviving an old integration URL. Trigger and credential now change in the same SQL update: leaving webhook clears it; returning generates a new credential; ordinary edits and pause/resume preserve the current credential. No schema or Simple mode change.
- Added HTTP regression covering pause409, manual404, old credential404 after return, fresh credential202 and successful run. All25 harness-workflows tests passed (/tmp/honmaru-webhook-lifecycle-tests.log). Explicit rotate/revoke UI, held events and replay remain unimplemented; KY-063 is not complete.
- CI39962345236 still in progress, so fix remains local pending prior run completion. Native app access currently reports Mac locked; no new empty-viewport evidence obtained.

### 2026-10-23 explicit workflow webhook rotation/revocation (local)
- Added editor-only POST /workflows/:id/webhook with rotate/revoke, explicit observed-secret CAS (including null for revoked state), audit events excluding credentials, and conflict rejection. Rotation immediately rejects old credentials; revocation leaves existing runs untouched and blocks subsequent requests. Ordinary workflow edits no longer recreate a revoked credential. No schema change.
- Workflow detail now offers Japanese/English confirmation controls, revoked-state explanation, and new URL display through the existing secret-visible editor detail. Actual native visual verification remains pending because CUA reported Mac locked; no live credentials rotated/revoked.
- HTTP coverage includes unauthorized403, malformed400, concurrent rotation200/409, stale revoke409, old credential404, fresh credential202, and revoked-state persistence across edit. Workflow26 tests, full Web1019 tests, TypeScript and Vite build passed. Logs /tmp/honmaru-webhook-rotation-{tests,web,build,vite}.log.
- KY-063 is partial/local; held events and explicit replay remain gaps. Inventory consistency check passes95 entries. CI39962345236 still Worker in_progress; all other required jobs observed success. No overlapping production push.

### 2026-10-23 workflow webhook UI integration checks
- Added HarnessWorkflows component tests exercising the real confirmation handlers: cancel causes no API call; revoke submits the observed credential and removes the old URL; reactivation uses explicit null and shows returned URL; conflict remains an error without success replacement; read-only viewer has no secret controls. Three tests passed (/tmp/honmaru-webhook-controls-tests.log). This is component verification, not a native screenshot comparison.
- Full Worker suite launched (/tmp/honmaru-webhook-worker-full.log), live exec session91518; no terminal result yet. Prior CI39962345236 remains in_progress. Do not restart these solely for lack of output or push over live CI.
- Re-read https://docs.kylon.io/cli/workspace/workflow on2026-10-23: paused webhook deliveries retained7 days, maximum1000/endpoint; resume does not replay; explicit replay oldest first, default25/max100. Paused workflows also permit explicit manual runs. Honmaru currently rejects paused manual run and paused webhook events; these remain concrete gaps. No actual external effects triggered in this audit.

### 2026-10-23 paused webhook retention and explicit replay
- Added additive hx_workflow_held_events table. Paused valid webhook requests now return202/held instead of409, preserve full parsed input for7 days up to1000 pending events per workflow, and start no run. Atomic insertion rechecks current trigger/credential/pause state and cap. Expired payloads are removed on arrival and scheduled sweep.
- Editor detail exposes pending count, oldest expiry, and oldest25 IDs/timestamps. Confirmation sends the exact reviewed IDs (up to100 per API call); resume alone does not replay. SQL transaction allocates run+definition and consumes event together, preventing concurrent duplicate dispatch. Replay tracks runs in normal history; interrupted execution recovery remains a gap, not a claim of exactly-once external effects. Explicit all-held discard not yet implemented.
- Incoming live deliveries also recheck current credential/enabled state in the run insertion, closing revocation-during-body-read race. Existing run execution is not cancelled by revocation. No schema ALTER or Simple data deletion.
- Workflow and migration39 tests passed (/tmp/honmaru-held-final-tests.log); UI5 tests, full Web149 files1024 tests, TypeScript, Vite and diff check passed. Native visual verification pending. Older full Worker suite session91518 remains live and is not evidence for all current changes.
- Prior CI39962345236 completed success. Preparing production push after these checks; follow the new exact revision through Worker migration/deploy and dependent Web deploy.

### 2026-10-23 webhook lifecycle production dispatch
- Pushed15f24b70 to main after prior CI success. Exact-head runs: CI39965668546 queued, Deploy Worker39965668748 in_progress, Deploy Web39965668547 in_progress. Web waits for matching Worker deployment. Production success and native screenshots remain unproven; do not push another revision over these runs.

### 2026-10-23 explicit manual run while paused (local)
- Aligned pause semantics with observed official workflow CLI documentation: pause prevents automatic triggers, not explicit manual execution. Removed the manual endpoint's enabled gate and enabled Run now in paused detail; the UI explains the distinction. This does not resume schedules or replay held events. Existing ACL checks remain.
- Added API regression for paused scheduled workflow: explicit run201/done, workflow remains disabled with null nextRunAt, later cron produces zero runs. Updated old generated-workflow409 expectation to verify no message before explicit run, one message afterward, and continued paused state. UI test verifies no update/replay call on manual action.
- Workflow30 tests and UI6 tests passed; TypeScript/Vite and diff check passed. Logs /tmp/honmaru-paused-manual-{worker,web,build,vite}.log. Changes remain local while exact15f24b70 CI39965668546, Worker39965668748 and Web39965668547 are live.

### 2026-10-23 held-event discard confirmation (local)
- Added editor-only discard endpoint with explicit reviewed event IDs, max1000, validation, and credential-free audit count. SQL deletes only pending events in the authorized org/workflow; already-dispatched, other workflows, and later arrivals are preserved. Retrying the same IDs is harmless. No production events discarded.
- Summary is one bounded read so count/oldest batch/discard snapshot agree. UI confirms permanent removal without execution, allows cancellation, and sends the exact snapshot rather than an unrestricted delete-all. Paused workflows can discard without enabling.
- Workflow31 tests, UI7 tests, TypeScript/Vite and diff check passed (/tmp/honmaru-held-discard-{worker,web,build,vite}.log). Native visual verification remains pending.
- Older full Worker exec91518 completed success:217 files1712 tests,702s. Because later edits occurred during its run, treat it as prior baseline evidence, not current-head proof. Current production runs39965668546/39965668748/39965668547 were rechecked in_progress; no overlapping push.

### 2026-10-23 workflow detail account/workspace isolation (local)
- Workflow screen previously retained open detail and confirmation state across prop scope changes; a late detail response could populate the next scope. Adopted the existing Agents/Skills scoped-component pattern keyed by base URL/workspace/session, remounting all detail, credential and confirmation state on scope changes.
- Added regressions for each scope field and late prior-account detail resolution; no old URL/controls appear and no mutation is made by switching. Workflow UI11 tests passed; full Web149 files1030 tests, TypeScript/Vite and diff check passed (/tmp/honmaru-workflow-scope-{tests,web,build,vite}.log).
- Native getApp still reports Mac locked; no visual claim. Production15f24b70 runs39965668546/39965668748/39965668547 were rechecked in_progress; scope/manual/discard follow-ups remain local until these terminate.

### 2026-10-23 workflow detail request ordering (local)
- Added latest-selection request ownership: delayed success or failure from an older workflow selection cannot replace the latest selected detail or its error. Returning to list invalidates detail ownership. Post-action detail refresh updates only the still-open matching workflow; completion after Back no longer reopens it. Delete completion also preserves a different current workflow.
- Added delayed resolve/reject selection and finish-after-Back regressions. All14 workflow UI tests, TypeScript/Vite and diff checks passed (/tmp/honmaru-workflow-selection-{tests,build,vite}.log). Native visual check still pending.
- Rechecked exact15f24b70 CI39965668546, Worker39965668748, Web39965668547: all in_progress. No duplicate deployment or overlapping push.

### 2026-10-23 workflow stored step result disclosure (local)
- Run history previously rendered only the first160 characters of output with no way to read the stored remainder. Added native details/summary disclosure with short preview, full stored multiline output/error as React text, and step timestamp. Empty-output steps remain plain status rows. Theme tokens and wrapping used; no unsanitized HTML execution.
- Added long multiline output/error and HTML-as-text regression. Workflow UI15 tests, TypeScript/Vite and diff check passed (/tmp/honmaru-workflow-run-detail-{tests,build,vite}.log). Native light/dark visual comparison remains pending; this does not establish Kylon layout parity or untruncated upstream provider output.
- Current Worker full suite started at unchanged Worker code from0caa7321: exec80837, /tmp/honmaru-workflow-current-worker-full.log. Production15f24b70 jobs observed live: CI Worker npm test and E2E; Deploy Worker Test; Deploy Web waits for matching backend. No overlapping push.

### 2026-10-23 production gate failure and scoped expiry correction
- Deploy Worker39965668748 failed in Test at15f24b70. Downloaded completed workflow logs: workspace-queries.test.js found harness/workflows.js unscoped query count2→3. The new global expiry DELETE was the added query. Deploy Web39965668547 also terminated failure; no successful release of15f24b70 is established. CI39965668546 remains live, do not push over it.
- Corrected scheduled expiry sweep to enumerate at most100 workspaces then delete expired payloads with explicit org_id per statement. No allowlist/CI/workflow changes. Added cross-workspace cleanup regression preserving unexpired input and starting no runs. Workflow+workspace-query34 tests passed (/tmp/honmaru-held-cleanup-scope-tests.log).
- Exec80837 full Worker run predates this correction; inspect its actual result and do not count it as a complete test of the correction. The planned manual history refresh UI was deferred to prioritize this deployment failure.

### 2026-10-23 explicit workflow detail refresh (local)
- Added header Refresh action to reload history, credential and held-event state while preserving the current route/detail. It clears pending confirmations so stale reviewed state is not carried into refreshed data. It never starts, enables, replays or mutates workflows. Existing guarded refresh prevents reopening after leaving detail.
- UI regression verifies new run/held events display, stale confirmation removed, and no mutation/run/replay API calls. All16 workflow UI tests, TypeScript/Vite and diff check passed (/tmp/honmaru-workflow-refresh-{tests,build,vite}.log). Japanese label added.
- CI39965668546 remains in_progress; failed Deploy Worker/Web await a corrected future revision. Full Worker exec80837 remains live; no restart or overlapping push.

### 2026-10-23 corrected release preflight
- CI39965668546 terminated failure: downloaded Worker job120454772293 log confirms only workspace-queries failure (unscoped expiry DELETE),216 files/1714 tests passed,1 failure. Full log /tmp/honmaru-ci-39965668546-worker.log. The correction at1498c9fe passed the exact guard and regression suite34 tests. Deploy Worker/Web also terminal failure, so no live prior deployment will be overwritten.
- Current Web full suite149 files1035 tests passed (/tmp/honmaru-workflow-redeploy-web.log). Version check all1.3.13, parity inventory consistency and git diff checks passed. Preparing next main push containing manual pause semantics, discard, scope/selection guards, full step output, refresh, and scoped expiry correction. Full Worker80837 is still live and will be inspected separately.

### 2026-10-23 corrected production deployment dispatched
- Pushedb5695f71 to main after prior CI/deploys terminated. Exact revision: CI39968582213 queued, Deploy Worker39968582122 in_progress, Deploy Web39968582170 in_progress. Publication remains pending; do not overlap another push.

### 2026-10-23 lazy held webhook payload inspection (local)
- Added editor-only GET /workflows/:id/webhook/events/:eventId scoped by workspace/workflow/event and pending/unexpired state. Summary continues to omit bodies. It returns stored parsed input only, never starts a run.
- Replay confirmation now offers per-event received-payload disclosure; content is requested only on expansion, deduplicates in-flight loads, remains React text, and clears with the scoped screen. Closing/reopening a failed disclosure permits retry.
- Added owner/member, wrong-workflow, expired input, no-run, no eager load, cached expansion and HTML-as-text regressions. Worker+query guard35 tests, UI17 tests, TypeScript/Vite and diff check passed (/tmp/honmaru-held-preview-{worker,web,build,vite}.log). Native visual comparison remains pending. Full Worker80837 predates these changes and is still live; do not treat its result as current preview coverage.

### 2026-10-23 workflow delete review (local)
- Detail Delete previously sent the irreversible DELETE immediately. Added named confirmation explaining workflow/history removal and that prior effects are not undone; Cancel performs no API call. Confirmation resets on resource/scope change and refresh. Toggle/Delete entry buttons now disable while an action is busy. No real workflow deleted.
- Added confirmation/cancellation regression. Workflow UI18 tests, TypeScript/Vite and diff check passed (/tmp/honmaru-workflow-delete-{tests,build,vite}.log). Native visual verification remains pending.
- Worker80837 remains live; its log includes the known pre-correction workspace-query failure, so not a current-head pass. Corrected b5695f71 CI39968582213/Worker39968582122/Web39968582170 were rechecked in_progress. No duplicate runs or overlapping push.

### 2026-10-23 native automation creation reference and latest web verification
- Native Kylon is accessible again. The room Automations panel shows a 360px floating panel, workflow count, centered lightning empty state and Set up an automation button. Clicking that button closes the panel and prefills the room composer with the Japanese automation request. No message was sent; the inspection draft was cleared. Existing Honmaru HarnessRoomResources/ClassicList implements this transition; this observation alone does not prove visual parity.
- Native production Honmaru existing 本番確認フロー detail still shows the older disabled manual-run control, without Refresh or output disclosure; pending-release controls must not be reported as visually verified. No workflow executed, enabled or deleted.
- Latest full Web suite passed149 files/1037 tests (/tmp/honmaru-workflow-final-web.log), including held input preview and delete review. Worker80837 is now terminal:1716 passed,1 failed, sole failure the pre-correction unscoped expiry query. This is not a current-head pass; corrected scoped cleanup and preview already passed35 targeted tests.
- Corrected b5695f71 Deploy Worker passed Test and entered D1 column migrations. CI Web/relay/shared core/E2E/desktop/gateway succeeded; CI Worker remains running. Web deploy awaits matching backend. No overlapping push.

### 2026-10-23 room resource empty-state fidelity follow-up
- Compared native Kylon and Honmaru empty automation panels: same360px panel and44px icon tile; Honmaru's22px icon and12px CTA were visibly larger/smaller respectively. Set empty-state icon18px, room-only heading weight500, and CTA14px/20px with6px12px padding to match the reference proportions. Simple and global empty states remain unchanged. Vite production build and diff check passed. Native verification of this local adjustment awaits deployment.
- b5695f71 Deploy Worker39968582122 and Deploy Web39968582170 both completed success. CI39968582213 remains live in Worker tests; hold follow-up push until terminal.

### 2026-10-23 Mac reload blank reproduction after successful web deployment
- Cmd+R on installed1.3.13 again produced a blank native viewport with no AX HTML. Invoking the advertised window enlarge action restored the AX HTML tree but the screenshot remained blank. Resizing is therefore not a verified recovery. Full quit/reopen restored visible chat. This strengthens the native-painting hypothesis but does not identify a root cause or prove a fix. No GPU/security flags changed.

- After relaunch, native production workflow detail visibly shows Refresh, enabled manual-run button while automatic execution remains paused, and expandable stored output. Expanded an existing run successfully; screenshot /tmp/honmaru-workflow-production-output-20261023.png. No run or destructive action submitted. This verifies rendering/disclosure only, not end-to-end replay or external effects.

### 2026-10-23 repaint investigation and full current Worker verification
- Re-read installed1.3.13 diagnostics for14:32:40Z reload: response200, policy-error, DOM/finish/stop, then visible/focused/not-loading window flags5 and layout flags63. No JavaScript-error/GPU-gone entry for this reload in the bounded log. This does not prove absence of every renderer/compositor fault.
- Electron official webContents.invalidate documentation confirms it schedules a full window repaint (https://www.electronjs.org/docs/latest/api/web-contents#contentsinvalidate). It remains a candidate experiment, not an implemented or verified fix.
- Started current Worker full suite including held-payload preview: exec74917, /tmp/honmaru-current-held-preview-worker-full.log. Keep this handle; do not restart because of a polling timeout. Prior CI39968582213 is still authoritative in_progress; no overlapping push.

### 2026-10-23 follow-up deployment and payload inspection retry
- Prior CI39968582213 completed success. Pushed5398048c to main after all prior jobs terminated: Deploy Worker39971156160, CI39971156168, Deploy Web39971156141 are in_progress. Includes lazy held payload preview, delete confirmation and room resource proportions. No successful deployment of this revision yet claimed.
- Added explicit Retry beside held-input inspection errors, preserving lazy fetch/cache/in-flight guards and never replaying the event. Regression covers failed fetch then successful retry, error removal and zero replay calls. Workflow UI19 tests, TypeScript/Vite and diff check passed (/tmp/honmaru-held-preview-retry-{tests,types,build}.log). This follow-up remains local while deployment runs.

### 2026-10-23 production room creation flow and hover contrast
- Confirmed current source wires RoomCreateDialog through Dashboard POST /channels/rooms; corrected stale matrix prose that said it was disconnected. Native production navigation New message → New room displayed visibility, name/guidelines, and searchable member/agent selection in the three-step dialog. Entered a temporary name and closed without creating a room or inviting anyone. This verifies the rendered flow, not a completed production creation.
- Reproduced primary Create button white-on-light hover in dark mode. Generic .dlg-btn.primary:hover:not(:disabled) outranked the room base background while retaining white text. Added explicit room-specific primary hover colors to RoomCreateDialog and RoomMemberPicker, preserving their existing olive/white palette and disabled behavior. Vite build and diff check pass; corrected native hover rendering awaits deployment.

### 2026-10-23 shared dialog hover cascade correction
- Audited all custom primary dialog styles after the native room-create contrast reproduction. AppRecordDialog had the same exposure: themed background/foreground but generic primary hover overriding only background. Lowered the neutral hover rule specificity with :where and made primary hover opacity-only, retaining each primary color pair. Neutral, danger, link and disabled styling remain explicitly defined. Room-specific fixes remain valid.
- Full Web149 files/1038 tests and Vite build passed (/tmp/honmaru-dialog-hover-{web,build}.log); these tests do not prove CSS rendering. Native light/dark hover verification remains pending deployment. Worker full suite74917 and5398048c CI/deploy jobs were confirmed still live this turn; no duplicate run/push.

### 2026-10-23 scheduled model tool deadline
- Missing-feature review confirmed follow-ups/workflow agents currently receive skill/memory tools, not the full external connector catalog. Do not mark KY-069 fulfilled. Found the shared model loop bounded HTTP calls but awaited tool.run indefinitely, preventing a reliable external-tool execution deadline.
- Bound each tool wait to the remaining overall deadline, clear its timer on completion, and return unknown/null after expiration without retry or final model claims. Already-started operations are not guaranteed cancelled; cancellation/idempotent external actions remain separate requirements.
- Tool-loop4 tests passed (/tmp/honmaru-scheduled-tool-deadline.log), including a never-resolving tool and no retry. Initial test collided with an older persistent mock; isolated its endpoint and reran successfully. Worker full74917 predates this edit and remains running, so its eventual result is not evidence for this correction.

### 2026-10-23 failed follow-up result handling
- If an available model returned no result, follow-ups previously posted the original instruction and marked it done. Now records failed and posts no claimed completion. Existing no-provider allowance fallback remains an explicitly labelled reminder. Added HTTP503 regression verifying failed status and no instruction-as-answer post. Workflow/model-loop38 tests pass (/tmp/honmaru-followup-no-result-tests.log).
- Full Worker74917 terminated failure:216 files/1719 tests passed,1 model-tool deadline test timed out. This run started before the deadline implementation/test edits, but included the new test; it is mixed-state evidence, not a frozen current-head result. Fresh targeted model-loop run and combined38-test run pass. Full log /tmp/honmaru-current-held-preview-worker-full.log.

### 2026-10-23 local native light/dark hover verification
- Browser controller still reports disabled; native Chrome successfully opened an isolated localhost fixture importing the actual Dialog.css and RoomCreateDialog.css. Click/hover Create in both explicit themes preserved background rgb(117,124,78), white text and opacity0.88, rather than the previous white-on-light result. Saved /tmp/honmaru-dialog-hover-dark.png and /tmp/honmaru-dialog-hover-light.png. This is CSS fixture verification, not full production layout or accessibility contrast certification.
- Closed only the created tab and removed the temporary fixture. No application data saved, no paid calls. Worker full suite remains at unchanged Worker code from b76794ea: exec61513, /tmp/honmaru-worker-followup-final-full.log.

### 2026-10-23 room primary contrast follow-up
- Numeric sRGB compositing audit of the verified hover colors found white text on #757c4e with opacity0.88 only3.55:1 on the light dialog and4.07:1 on dark. Changed room creation/member picker action color to #697144 and kept primary hover opaque; white/action contrast is5.19:1 in either theme. Disabled opacity remains intentionally distinct. Vite build and diff checks passed. Earlier fixture screenshots show the previous olive shade, not this final adjustment; final production visual check remains pending.
- Revalidated5398048c jobs: Worker deploy Test and CI Worker/E2E remain live; other CI web/desktop/relay/shared/gateway passed. Full Worker61513 remains live at unchanged Worker code.

### 2026-10-23 agent follow-up history UI
- Agent profile previously loaded scheduled follow-ups only and exposed no execution results. Added status selector for scheduled/running/done/failed/cancelled, refresh, loading/error/empty states and expandable stored result/timestamp. Cancel is only offered for scheduled items. Fetches are scoped to the current agent and stale responses are ignored. Existing backend access-filtered status endpoint reused; no Worker changes during full suite61513.
- Added inert result rendering and delayed old-status regression. Full Web150 files/1040 tests and TypeScript passed (/tmp/honmaru-followup-history-{web,types}.log). Japanese statuses added. Native fidelity/deployment still pending; backend200-row cap and lack of pagination remain, so this is not complete historical coverage.

### 2026-10-23 follow-up cancel and release gate verification
- Added scheduled-item cancellation failure/retry regression: failed cancellation preserves the item and reports error; refresh makes no cancellation call; successful cancellation reloads the list. All3 follow-up UI tests pass (/tmp/honmaru-followup-history-cancel-tests.log).
-5398048c CI39971156168 and Deploy Worker39971156160 completed success. Deploy Web39971156141 remains live; do not overlap the next push. Current Worker full61513 also remains live without Worker edits.

-5398048c Deploy Web39971156141 now completed success as well. Held payload inspection, delete confirmation and resource icon proportions are deployed; explicit payload Retry, contrast correction, follow-up failure handling/history and tool deadline are still local. Current Worker61513 remains live; no overlapping next push.

### 2026-10-23 frozen Worker and latest Web release preflight
- Worker61513 completed success:217 files/1721 tests,776.46s (/tmp/honmaru-worker-followup-final-full.log). Worker code remained unchanged from b76794ea during this run; it covers deadline and no-result follow-up fixes. Latest Web150 files/1041 tests also passed (/tmp/honmaru-release-followup-web.log). Version1.3.13 and parity inventory consistency passed.
- Prior5398048c CI/Worker/Web all succeeded. Preparing follow-up release with explicit payload Retry, dialog contrast/cascade fixes, scheduled tool deadline, follow-up failure handling and agent follow-up status/results UI. Native tool currently reports Mac locked; no new visual verification claimed.

### 2026-10-24 agent-filtered follow-up retrieval and release failure
- Added optional agentId filtering to the existing follow-up endpoint/client and apply it in SQL before the200-row workspace cap. Agent history UI requests its agent directly. Conversation authorization still filters returned rows; existing channel-list behavior is retained. Regression seeds201 other-agent rows and verifies the target remains visible while an inaccessible conversation is excluded. Worker/query-guard37 tests and UI3 tests pass; TypeScript/Vite pass after locale fix. Paging remains incomplete.
-7120d536 Deploy Web39974382803 failed Build against the Worker. Exact job120485074465 log /tmp/honmaru-web-deploy-39974382803.log confirms two TS1117 duplicate keys in ja.ts. Running/Failed already existed as single-quoted entries; newly added duplicate labels were removed in a dedicated correction. Previous TypeScript evidence preceded the final translation insertion and was insufficient as final-head proof. Rechecked corrected TypeScript and Vite successfully (/tmp/honmaru-followup-agent-filter-{types,build}.log). CI39974382715 and Worker39974382976 remain live; no overlapping push.

### 2026-10-24 authorized follow-up history pagination
- Added opt-in paged follow-up GET with50 visible rows and keyset continuation ordered by due_at/id. Filters workspace/status/agent/channel before scanning, checks conversation access, and encodes only the last visible record in a scope-bound validated cursor. Hidden rows never become response cursors. Existing unpaged callers retain their contract. A10000-row scan ceiling returns explicit503 rather than silently pretending history is complete.
- Agent history now loads more pages, deduplicates IDs, preserves loaded rows on page failure, and ignores obsolete scope/status responses. Added55-visible/201-hidden tied-date HTTP pagination, invalid/scope-changed cursor and UI append/retry regressions. Worker/query guard38 tests, full Web150 files/1042 tests, TypeScript/Vite and diff checks pass (/tmp/honmaru-followup-pages-{worker,web,types,build}.log). Native pagination verification and production remain pending; mutations while paging are not a frozen historical snapshot.
- Prior7120d536 CI39974382715/Worker39974382976 remain live; Web39974382803 failed duplicate translations (already locally corrected). No overlapping push.

### 2026-10-24 history cursor workspace binding and CI diagnosis
- Bound history cursors to orgId as well as channel/agent/status; a cursor from another workspace is rejected before any database read. Worker/query guard38 tests pass (/tmp/honmaru-followup-cursor-scope.log).
- Downloaded failed7120d536 CI Web job120485074262 and E2E job120485074298 logs: both fail on the same two ja.ts duplicate keys, not separate runtime regressions. Locally corrected704e90f1 and subsequent type/build checks pass. CI Worker and Deploy Worker39974382976 still in Test. Native tool again reports Mac locked; requested availability asynchronously and continued independent work.

### 2026-10-24 prior release terminal state
- Rechecked authoritative GitHub run state:7120d536 Deploy Worker39974382976 completed success; CI39974382715 and Deploy Web39974382803 completed failure. Both known failed frontend jobs report duplicate translation keys already corrected in704e90f1. Backend publication is successful, but this does not establish frontend publication or visual verification.
- Current-head full Worker run18754 remains live with Worker sources frozen. Native Honmaru observation still reports the Mac locked; no actual screen result is claimed. Version1.3.13 and parity inventory consistency pass; the inventory remains74 partial/17 missing/2 implemented/2 unverified and is not a completion percentage.
- Re-ran TypeScript and Vite against currentabb9ba2f sources successfully (/tmp/honmaru-final-history-{types,build}.log); removed generated compiler metadata. Full Worker still running; release remains held for its result.

### 2026-10-24 frozen history release preflight
- Current Worker run18754 completed success:217 files/1723 tests,607.95s (/tmp/honmaru-worker-history-final-full.log). Worker sources remained unchanged throughout this run.
- Added a delayed additional-page/status-switch regression; all5 AgentFollowups tests pass (/tmp/honmaru-history-status-race.log). Old scheduled results and cursors cannot overwrite the newly selected failed history. This is behavior coverage, not native visual fidelity proof.
- Preparing corrected frontend/paged-history publication after prior jobs terminated. Final source TypeScript/Vite and version/parity checks pass; native confirmation remains pending.

### 2026-10-24 corrected history release and source conversation links
- Pushedd2036da7 to main. Deploy Web39977408841, CI39977408288 and Deploy Worker39977408079 are confirmed in_progress. No publication success claimed yet.
- Added View conversation to follow-up history when the stored threadId exists, using the owning API workspace and the shared thread-route encoder. Threadless records show no invented destination. Six follow-up UI tests, TypeScript and Vite pass (/tmp/honmaru-followup-thread-{links,types,build}.log). Link regression verifies workspace scope and reserved-character encoding. This follow-up remains local until current deployment jobs finish; native verification is pending.

### 2026-10-24 all-status follow-up history
- Rechecked official https://docs.kylon.io/concepts/followups: list defaults to pending and status all includes fired/cancelled/failed. Added all to the existing status selector and both legacy/paged query contracts, retaining scheduled defaults and workspace/agent/conversation authorization. Reuses existing Japanese All translation.
- Worker workflow37 tests and workspace query guard2 tests pass; UI7 tests, TypeScript/Vite and diff check pass (/tmp/honmaru-followup-all-{worker,scope,web,types,build}.log). New regression checks mixed states, inaccessible conversations, other agents/workspaces and unchanged default filtering. UI only offers Cancel on scheduled rows. Source-thread-link frontend full suite also passed150 files/1044 tests (/tmp/honmaru-source-thread-web-full.log), before this all-status addition.
- Native access still reports locked. Currentd2036da7 CI has successful Web/Desktop/Relay/Shared/Gateway jobs, with Worker/E2E and both deployments still live; no overlapping push.

### 2026-10-24 follow-up thread delivery integrity
- Found runDueFollowups marked done even when postMessage returned a failed delivery (such as a deleted thread root). Scheduling now rejects missing/deleted/reply/cross-conversation roots, execution rechecks the root before model work, and absence of a posted row is recorded as failure instead of done. Existing room-level reminders remain supported.
- Workflow/query-guard40 tests pass (/tmp/honmaru-followup-delivery.log), including invalid target rejection and a root deleted between reservation and execution. Initial new test used the wrong clock option (at rather than now); corrected and reran. No production data changed. Full cross-feature regression remains to run for this new validation.

### 2026-10-24 memory scope terminology
- Official https://docs.kylon.io/concepts/memory distinguishes individual agent memory from Workspace Knowledge. The agent memory selector, entry label and explanatory copy previously called unscoped agent memory Shared knowledge. Renamed these to Agent memory in English/Japanese to describe the actual storage scope. Conversation labels and all data/access behavior are unchanged. Workspace Knowledge parity remains incomplete.
- Memory/agent UI7 tests, final TypeScript/Vite and diff checks pass (/tmp/honmaru-memory-scope-labels-{tests,types,build}.log). Worker full78774 remains live with sources frozen atf7a90435.

### 2026-10-24 follow-up delivery and memory release preflight
- Frozen Worker run78774 completed success:217 files/1725 tests,480.62s (/tmp/honmaru-followup-delivery-full.log). Worker sources stayed atf7a90435 throughout. This includes all-status history and thread-destination/delivery failure checks. Latest Web150 files/1045 tests also pass (/tmp/honmaru-memory-and-history-web-full.log), including source thread links and memory terminology.
- d2036da7 CI39977408288 completed success. Deploy Worker39977408079 remains in Test and Deploy Web39977408841 waits for the matching Worker. Additional local commits are not yet published; no overlapping push. Native visual verification remains unavailable.

### 2026-10-24 history release publication and next deploy
- d2036da7 CI39977408288, Deploy Worker39977408079 and Deploy Web39977408841 all completed success. Pushedc1f673ce only after those jobs terminated; new CI39980117529, Worker39980117483 and Web39980117365 are in_progress.
- Direct urllib reads from this machine of app.honmaruai.com, honmaru-web.pages.dev and the configured Worker /health returned403. App response is Cloudflare plain text error1010. This is failed verification from this client, not evidence of an application outage or successful visual rendering. No bypass attempted. Native UI still reports Mac locked.

### 2026-10-24 durable agent memory retention
- Found addAgentMemory deleted older stored entries after each insertion beyond the200-entry recent index. Removed that implicit pruning: recent prompt/list reads remain bounded, while stored notes and full bodies persist until explicit removal. Existing search_agent_memory already searches outside the recent index with workspace/agent/conversation authorization. Full management UI pagination remains to implement, so retention does not prove complete memory management.
- Memory-scope/query guard8 tests pass (/tmp/honmaru-memory-retention.log). Regression retains202 notes and the oldest full body, verifies the200-entry read bound, and confirms duplicate detection still finds the old entry. No production data restoration is claimed for entries previously pruned. This correction is local whilec1f673ce deployment runs.

### 2026-10-24 retained memory management pagination
- Added opt-in50-entry keyset pages to the existing authorized agent-memory endpoint. Cursor binds workspace, agent and canonical conversation; existing recent-index API remains unchanged. Agent profile now appends/deduplicates pages and discards obsolete scope responses. Creation resets the continuation with a fresh first page.
- Regression walks204 visible tied-date records beyond the previous200 limit, excludes private scope, and rejects cross-scope/malformed cursors. Worker/query guard9 tests, full Web150 files/1045 tests, TypeScript/Vite and client paging6 tests pass (/tmp/honmaru-memory-pages-{worker,web,types,build,client}.log). Native rendering remains pending. Current client search still filters loaded entries only; server-side management search is outstanding.

### 2026-10-24 full saved-memory management search
- Added bounded literal query and kind filters before memory pagination, across title/description/full body while keeping the server-authorized agent/conversation scope. Continuations bind the query and kind too. Agent management submits search explicitly, resets page state and uses the existing generation guard; status text describes loaded count rather than implying the page is the entire store. Existing local-only list use remains supported.
- Worker/query guard10 tests and full Web150 files/1047 tests pass (/tmp/honmaru-memory-search-{worker,web}.log); final TypeScript/Vite after count-label translation also pass. Tests cover full body beyond the short summary, kind intersection, private scope exclusion, invalid input and mismatched search cursor. Native UI and production are pending. Priorc1f673ce CI/Worker/Web remain live.

### 2026-10-24 memory search loading states
- Search/page loads now show Loading rather than a premature empty state, and form submission is guarded while busy. Memory UI8 tests, TypeScript/Vite and diff check pass (/tmp/honmaru-memory-loading-{tests,types,build}.log).
- Started frozen Worker full45670 atba93fc57 Worker sources (/tmp/honmaru-memory-retained-full.log). Keep Worker unchanged until terminal. Priorc1f673ce CI/Worker/Web remain in_progress.

### 2026-10-24 memory browser integration regression
- Added agent-profile integration test navigating to Memory, submitting query/kind, fetching a saved result, failing the next-page request, and retrying while retaining the first page. HarnessAgents3 tests pass (/tmp/honmaru-memory-browser-ui.log). This verifies component/API wiring and retry behavior; it does not replace native visual verification. Frozen Worker45670 andc1f673ce deployment remain live.

### 2026-10-24 retained memory full release preflight
- Frozen Worker45670 completed success:217 files/1728 tests,460.38s (/tmp/honmaru-memory-retained-full.log), with Worker sources unchanged fromba93fc57. Latest Web150 files/1049 tests and final TypeScript pass (/tmp/honmaru-memory-final-{web,types}.log). Last Vite build also passed after the loading-state change.
- Priorc1f673ce CI39980117529 and deployments39980117483/39980117365 remain live. Memory retention, management paging/search and loading/retry UI changes are not yet published. Native verification remains pending.

### 2026-10-24 memory review gap confirmation
- Re-read https://docs.kylon.io/tutorials/use-workspace-memory and https://docs.kylon.io/concepts/memory: review records evidence and a validation date after checking an entry; ordinary editing must not refresh validation. Current memoryEntries/schema/UI have version/updatedAt but no review/evidence state. KY-031 remains missing. Next implementation must bind review to the checked content version, preserve agent/conversation authorization and distinguish edited-since-review from validated content; no review is inferred from successful saving.
- c1f673ce CI39980117529, Worker39980117483 and Web39980117365 completed success before1edd8100 was pushed. Current memory release CI39982782545, Worker39982782482 and Web39982782555 are confirmed in_progress.

### 2026-10-24 version-bound memory review
- Added a separate latest-review table recording evidence, reviewer, timestamp and checked content version. Atomic conditional write refuses a stale version or wrong agent/conversation/workspace. Paged management reads mark review current only when content version still matches; editing does not change validation time. Agent admins can use the existing protected PUT memory route with an explicit review suffix; evidence is excluded from audit metadata.
- Added evidence-required review dialog, conflict-preserving input, read-only body and current/changed-since-review display. Worker memory/query guard11 tests and full Web151 files/1050 tests, TypeScript/Vite and diff checks pass (/tmp/honmaru-memory-review-{worker,web,types,build}.log). API-level role tests, full Worker regression, native layout and publication remain pending. Current record is latest review, not a complete review history; automated review-due policy and memory-to-skill conversion remain unimplemented.

### 2026-10-24 memory review HTTP access verification
- Added real-route regression: an ordinary agent member and workspace admin without agent edit rights cannot review; owner can review with evidence; later editing preserves validation time and marks the review stale; old-version review returns409 and fresh-version review restores current. Agent/memory/query guard38 tests pass (/tmp/honmaru-memory-review-access.log).

### 2026-10-24 memory review presentation
- Grouped review details under the memory body within the main content column, rather than a competing horizontal row column. Evidence uses the existing memory text treatment. Added current/stale review state and non-editor action visibility regression; review/list10 tests, TypeScript/Vite and diff checks pass (/tmp/honmaru-memory-review-state-{ui,types,build}.log). Native tool still reports locked, so visual fidelity is not claimed.
- Frozen Worker review suite43807 remains live at0382acf4 Worker sources. Prior memory publication CI39982782545/Worker39982782482/Web39982782555 remains in_progress.

### 2026-10-24 memory review full preflight
- Frozen Worker43807 completed success:217 files/1730 tests,461.75s (/tmp/honmaru-memory-review-full.log), with Worker unchanged from0382acf4. Latest Web151 files/1051 tests pass (/tmp/honmaru-review-final-web.log); latest TypeScript/Vite and version1.3.13 checks pass.
- Prior memory release CI39982782545 succeeded; Worker39982782482 and Web39982782555 still live. No overlapping push; review publication and native confirmation remain pending.

### 2026-10-24 complete review contract gap audit
- Official https://docs.kylon.io/cli/workspace/memory specifies keep/update/delete, atomic update+validation, and verdict/evidence history. Current implementation supports keep and latest evidence only. Added explicit rejection of unsupported verdicts instead of silently treating them as keep; memory/query guard12 tests pass (/tmp/honmaru-memory-review-verdict.log). Atomic update/delete review and immutable evidence history remain separate unfinished requirements; no full review parity claim.
- Memory retention release1edd8100 CI39982782545/Worker39982782482/Web39982782555 completed success before5db7f3c7 push. Review CI39985555305/Worker39985555451/Web39985555298 now in_progress. Native tool still reports locked.

### 2026-10-24 append-only review evidence storage
- Keep reviews now append evidence/history and update the current review together in a D1 batch. Failed version/scope checks create neither record. Existing latest review is backfilled once by idempotent schema application; earlier already-overwritten evidence cannot be reconstructed. History shares memory deletion lifecycle through its foreign key; deleted-memory audit retention remains a separate unfinished policy.
- Agent/memory/query guard40 tests passed before the schema backfill; subsequent memory/query guard14 tests include repeated-schema backfill preservation and pass (/tmp/honmaru-review-history-{write,migration}.log). History read API/UI and full regression are pending; this storage change is local while review release deploys.

### 2026-10-24 scoped review history and resumed native verification
- Added a read API scoped to workspace, agent, memory and resolved conversation; scope-bound keyset cursors page 50 reviews with reviewer display name, version, evidence and time. Added history dialog with preserved rows on paging failures, retry, deduplication and inert text rendering. Worker memory tests13 and related UI13 pass. Full Web152 files/1052 tests pass; final TypeScript/Vite and history rendering regression pass after visual fixes.
- Native access resumed. Production Integrations/API & Webhook empty states and agent memory tab loaded successfully. Screenshot: /tmp/honmaru-api-webhook-production-20261024.png. Kylon member/profile UI inspected again. These observations do not verify delivery retries or new history API publication.
- New history dialog checked with local sample data in Chrome in both themes; corrected overly bright dark divider, small timestamp and lost evidence line breaks. Screenshots: /tmp/honmaru-memory-history-{dark,light}-20261024.png. Temporary preview files/server/tab removed.
- Frozen Worker full89788 is running against c4be1e97 Worker sources (/tmp/honmaru-history-full-worker.log). Review release5db7f3c7 CI39985555305/Worker39985555451/Web39985555298 remains pending as of last check. No overlapping push; new history is local, not deployed.

### 2026-10-24 review history release preflight
- Frozen Worker89788 completed success:217 files/1734 tests,523.91s (/tmp/honmaru-history-full-worker.log), with Worker sources unchanged fromc4be1e97. Added a subsequent HTTP-only regression proving readers can see evidence/reviewer names and lose history access when agent access becomes private; agent HTTP28 tests pass (/tmp/honmaru-history-http.log).
- Final Web152 files/1053 tests and TypeScript pass (/tmp/honmaru-history-release-{web,types}.log). Includes read-only profile-to-history routing with the selected conversation. Final Vite build passed after the visual stylesheet adjustment. Publication remains gated on prior5db7f3c7 jobs completing.

### 2026-10-24 atomic update reviews
- Rechecked official https://docs.kylon.io/cli/workspace/memory via direct public fetch after web open failed: update flags plus validation must apply in one write; keep/update/delete verdicts and evidence form history. Implemented update review using the same D1 batch as conditional content/version writes and latest validation. Omitted fields retain values. Concurrent stale edits append no evidence, and an injected content-write failure rolls back the preceding history insertion. Delete review and deleted-memory audit retention remain unfinished.
- Review dialog optionally edits title/description/body/kind and submits evidence in the same request; conflict preserves input. History distinguishes keep/update. Existing edit-only path does not validate. Agent/memory44 tests and full Web152 files/1054 tests, TypeScript/Vite pass (/tmp/honmaru-review-update-{final-worker,web,final-types,build}.log). Native update-dialog verification and full Worker regression remain pending.
- Previous5db7f3c7 CI39985555305/Web39985555298/Worker39985555451 all succeeded before2ad87cc8 was pushed. History release runs: CI39988318219, Web39988318168, Worker39988317968; no overlapping push.

### 2026-10-24 review dialog visual corrections
- Native Chrome sample-data verification in both themes found keep-review body preview inheriting a light background with light text. Scoped preview to dialog color roles, retained line breaks and readable body typography. Enlarged update body input to match the memory editor.
- Injected sample conflict showed error below the visible scrolling body; added scroll-into-view on error while retaining inputs. Native screenshot confirms error and evidence visible together. Artifacts: /tmp/honmaru-review-body-dark-20261024.png, /tmp/honmaru-review-update-dark-20261024.png, /tmp/honmaru-review-update-light-20261024.png. Initial fixture omitted HarnessWorkspace color roles; corrected fixture before these final observations. Preview files/server/tab removed.
- TypeScript/Vite and review/editor3 tests pass (/tmp/honmaru-review-visual-{types,build,ui}.log). Frozen Worker full59431 continues against3c36b3e8 Worker sources (/tmp/honmaru-review-update-full-worker.log); do not modify Worker until terminal. History release CI39988318219/Web39988318168/Worker39988317968 still in progress. Visual fixes and update review not yet published.

### 2026-10-24 memory search empty-state distinction
- Saved searches and kind filters now render no-matches text when zero rows return, instead of implying there are no saved memories. Uses applied parent filters, so typing an unsubmitted query does not change the empty state. Loading still suppresses premature no-results text. Related UI14 tests, TypeScript/Vite pass (/tmp/honmaru-memory-empty-{filter,types,build}.log).
- Delete-review audit gap confirmed in current schema: hx_memory_review_history has memory FK ON DELETE CASCADE. A delete verdict must preserve scoped evidence separately before deleting, with current agent/conversation access on reads; generic workspace audit must not receive private evidence. No delete support claimed. Frozen Worker59431 remains live, and history release CI39988318219/Web39988318168/Worker39988317968 remains live.

### 2026-10-24 update-review full preflight
- Frozen Worker59431 completed success:217 files/1738 tests,484.82s (/tmp/honmaru-review-update-full-worker.log), unchanged Worker sources from3c36b3e8. Final Web152 files/1055 tests pass (/tmp/honmaru-review-release-final-web.log); latest TypeScript/Vite, version1.3.13 and parity inventory checks pass. Native sample verification covers both themes, body contrast and visible conflict errors; production update-review E2E remains pending.
- History release2ad87cc8 CI39988318219 succeeded; Web39988318168 and Worker39988317968 are still running. Do not push overlapping release.

### 2026-10-24 scoped audit retention and delete-review backend
- Added hx_memory_review_audit with immutable-at-insert workspace/agent/conversation scope, version, verdict, evidence, reviewer and time; no memory body copy and no cascade from memory deletion. Schema backfills existing review history idempotently; an insert trigger writes audit evidence in the same transaction as keep/update/delete review. History reads now use retained evidence with exact agent/workspace/conversation filters; HTTP route retains current access checks.
- Delete verdict conditionally writes history/audit for the expected version then deletes only when that exact new audit exists, in one D1 batch. Stale/wrong-scope/repeated delete creates no extra event. Related agent/memory47 tests pass (/tmp/honmaru-review-delete-tests.log), including retained evidence, idempotent migration and update rollback of audit. Delete UI, aggregate history for deleted entries, HTTP delete coverage and full regression still pending.
- Release-ready update-review commit is67b11d48 (full Worker1738/Web1055 plus native sample checks). Subsequent audit/delete work is local and not release-ready; do not push it merely to publish the already-verified update-review commit. Previous history deployment remains active as last checked.

### 2026-10-24 delete-review UI and aggregate history
- Added scoped agent memory review log using the same scope-bound 50-row keyset paging as individual history, including deleted entries. Individual and aggregate cursors cannot be interchanged. Returns memory IDs without copying deleted bodies. Memory scope selector now includes retained audit scopes but still resolves current room access; revoked members lose both scope discovery and history access.
- Review dialog offers deletion with required evidence plus explicit irreversible-deletion checkbox; duplicate submits are guarded. Keeps existing keep/update paths. History shows delete verdict and memory ID in aggregate view. Related agent/memory48 tests, final cursor18 tests and full Web152 files/1057 tests pass; TypeScript/Vite pass (/tmp/honmaru-review-{log-access,log-cursors,delete-full-web,delete-ui-types,delete-build}.log). Full Worker regression and native deletion-dialog/aggregate-history verification remain pending. No production data deleted during verification.
- History release2ad87cc8 CI39988318219 succeeded; Worker39988317968 and Web39988318168 still live. Update-review67b11d48 is verified but not yet published; subsequent delete/audit changes require full regression before publication.

### 2026-10-24 delete-review and retained-log native sample verification
- Native Chrome sample fixture confirms evidence alone leaves deletion disabled; explicit confirmation enables the action, and simulated submission completes without production writes. Changed deletion helper text to ask why the entry should be removed, and warning/error color to Harness danger tokens for legibility.
- Retained aggregate history rendered in light/dark with delete verdict, memory ID, evidence, reviewer and time. Screenshots: /tmp/honmaru-review-delete-dark-20261024.png and /tmp/honmaru-review-deleted-log-{light,dark}-20261024.png. Temporary preview files/server/tab removed. TypeScript/Vite and review/history5 tests pass (/tmp/honmaru-review-delete-visual-{types,build,ui}.log).
- History release2ad87cc8 CI39988318219/Web39988318168/Worker39988317968 all completed success. New delete/audit/update batch awaits frozen full Worker32975 againsta35a9f4c Worker sources (/tmp/honmaru-review-delete-full-worker.log), plus production publication. No next push yet.

### 2026-10-24 review-log scope switching and next conversion gap
- Added profile-level integration test: open agent-scope log, close, select a conversation, reopen, then resolve the old request. Current conversation evidence remains, late previous-scope evidence is absent. Profile5 tests pass (/tmp/honmaru-review-log-scope-ui.log).
- Memory-to-skill implementation gap: memory body limit16000 vs skill MAX_SKILL_CHARS8000 and clean() truncation; name120 vs80 and description500 vs200 also differ. Calling createSkill directly would lose content. Default workspace visibility could widen private conversation access; existing private skill execution is owner-direct-agent only. Conversion must preserve complete source text and source audience/execution scope, install atomically, and avoid deleting source on partial failure. No conversion support claimed.
- Updated KY-031 acceptance text to distinguish already published keep/history from local update/delete/audit work. Full frozen Worker32975 remains live; do not modify its Worker sources while running.

### 2026-10-24 complete review verdict release preflight
- Frozen Worker32975 completed success:217 files/1742 tests,476.63s (/tmp/honmaru-review-delete-full-worker.log), unchanged Worker sources froma35a9f4c. Final Web152 files/1058 tests and TypeScript pass (/tmp/honmaru-review-log-final-{web,types}.log); Vite passed after final deletion helper/warning contrast edits. Native local sample proof covers keep/update/delete dialogs and retained history in both themes; no production deletion was performed.
- Previous2ad87cc8 CI39988318219/Web39988318168/Worker39988317968 all succeeded before next push. Publishing the reviewed update/delete/audit/UI batch together; production E2E confirmation remains pending, memory-to-skill and review-due policy remain incomplete.

### 2026-10-24 lossless skill fields and memory scope visual check
- Skill limits now match structured memory title120/description500/body16000. Oversized create/update rejects before mutation, including a combined generated SKILL.md over64KiB. Japanese maximum-length save/export/import is covered. This is groundwork; memory-to-skill conversion is still not implemented. Its access/atomicity contract is in memory-skill-conversion.md.
- Fixed the native-gray memory conversation selector with Harness color roles and spacing. Native Chrome sample profile verified in both themes and conversation selection. Corrected the fixture to include the actual shell.harness-workspace wrapper before final proof; missing-wrapper colors are not production defects. Screenshots: /tmp/honmaru-memory-scope-{dark,light}-20261024.png. Temporary preview files, tab and server removed.
- Worker full217 files/1745 tests passed in483.78s, unchanged Worker sources from3841e02b (/tmp/honmaru-skill-limits-full-worker.log). Web152 files/1058 tests, TypeScript/Vite and version/inventory checks passed. Related skill tests59 passed. No Simple logic changed.
- Prior review release1e3bcdf9 CI39992192192/Web39992192154/Worker39992192160 all completed success before the next publication. Native production currently showed the pre-refresh memory page; newest deployment E2E still pending.

### 2026-10-24 inherited skill access foundation
- Added source-scope records and current-access checks across skill list/get/agent catalog/export and supporting file reads. Execution restricts conversation-derived skills to the source agent and canonical conversation. Agent-wide source skills retain source-agent authorization. Unscoped workspace/private behavior remains covered by existing regressions.
- Scoped skills cannot be reshared through the existing visibility endpoint or installed on another agent. Losing room membership revokes the conversion owner's access too; losing agent/workspace access revokes agent-wide derived access. Agent deletion leaves inaccessible provenance rather than widening permissions.
- Related skill/package/ZIP49 tests passed (/tmp/honmaru-source-skill-access.log), followed by23 access tests including support-file revocation (/tmp/honmaru-source-skill-files.log). No conversion endpoint or atomic source removal exists yet, and no scoped production skill was created. This foundation is local and requires conversion integration/full regression before publication.

### 2026-10-24 atomic memory-to-skill conversion and initial UI
- Added a human-authorized POST conversion endpoint using displayed expectedVersion and a replay ID bound to actor/source/scope/keep choice. One conditional D1 batch creates a complete skill, its inherited scope and private policy, replay record and source-agent installation, then optionally removes the original. Concurrent duplicate calls return the same skill; a conflicting replay choice is rejected. Empty legacy descriptions use the title in SKILL.md and retain the original empty description in metadata.
- Injected installation failure rolls back skills, scope and replay records and retains memory. Maximum Japanese fields survive export/import; stale version and wrong conversation create no skill; source conversation remains the execution boundary. Related HTTP/skill58 tests pass (/tmp/honmaru-memory-conversion-api.log).
- Added an editor-only conversion action and confirmation dialog showing target agent, inherited scope and keep-source choice. Errors retain input/retry identity; changing keep choice uses a new identity. Related UI17 tests pass (/tmp/honmaru-memory-conversion-ui.log). Full regressions, native visual checks and publication are pending; no production conversion was performed.

### 2026-10-24 conversion native UI verification
- Japanese local sample profile verified: opens conversion, previews complete body, displays inherited-access explanation and keep-source choice, shows simulated failure and closes after retry succeeds. No production memory was converted/deleted. Light/dark screenshots: /tmp/honmaru-memory-conversion-{light,dark}-20261024.png.
- Native175% zoom found summary elements missing from the dialog Tab order. Added the first details summary to focus stops, then verified Tab moves from body disclosure to keep-source checkbox and scrolls it into view while footer buttons remain visible. Screenshot: /tmp/honmaru-memory-conversion-keyboard-20261024.png. Reset zoom and closed the temporary tab/server; preview files removed.
- Split memory body and action buttons into separate wrapping rows; capped conversion body preview height and scroll errors into view. Screenshot: /tmp/honmaru-memory-actions-light-20261024.png. Full Web153 files/1060 tests, TypeScript/Vite pass after adjustments (/tmp/honmaru-memory-conversion-final-{web,build}.log).
- Frozen Worker12436 against6134a8ca remains running (/tmp/honmaru-memory-conversion-full-worker.log). Previous1947cf76 CI40056902291 and Worker40056902238 remain in testing; Web40056902268 waits for the matching Worker. No overlapping publication.

### 2026-10-24 derived skill scope display
- Added typed sourceScope metadata to the web client. Catalog rows identify conversation/agent restrictions, and the global library replaces the misleading disabled Only me selector with inherited-scope text. A profile's install candidates exclude skills restricted to another source agent; server checks remain authoritative.
- Full Web153 files/1061 tests, TypeScript and Vite pass (/tmp/honmaru-memory-conversion-scope-{web,build}.log), including regression for inherited-access text and absence of the sharing selector. Worker sources remain frozen from6134a8ca for full12436. Production publication is still gated on that full run and prior1947cf76 deployment jobs.

### 2026-10-24 scoped conversion release preflight
- Frozen full Worker regression completed:217 files/1752 tests,537.34s (/tmp/honmaru-memory-conversion-full-worker.log). Final Web153 files/1061 tests, TypeScript/Vite already passed; version1.3.13 and inventory checks pass. Native sample catalog confirms inherited-scope label (/tmp/honmaru-derived-skill-scope-20261024.png).
- Prior1947cf76 CI40056902291, Worker40056902238 and Web40056902268 all completed success before publication. Native Honmaru is accessible again; its open memory page still shows the previously loaded frontend and requires refresh for current release verification. Production conversion E2E remains pending; no production memory was deleted.

### 2026-10-24 live Kylon catalog search comparison
- Reopened the authenticated native Kylon app. Profile icons are already present in Honmaru production (decorative SVGs are absent from AX text); no duplicate icons were added. Current Kylon profile has Profile/Skills tabs; Honmaru keeps its additional Memory/Follow-ups controls.
- Kylon Add skills search changes both tab counts (observed installed23 to3 for artifact). Honmaru previously filtered rows while retaining total counts. Both counts now use their respective search matches. Added regression for author search, switching tabs, no matches and clearing search.
- Native Chrome temporary sample confirms Japanese labels, available0/installed1 for alice, matching installed row, and available1 restored on clear. Temporary fixture, server and tab removed. Updated private-skill help to distinguish inherited memory restrictions. No production data changed.
- Full Web153 files/1062 tests, TypeScript/Vite and diff checks pass (/tmp/honmaru-skill-search-count-{web,build}.log). Existing releaseffe1563d CI40058200605/Worker40058200644/Web40058200604 still live; Web waits for Worker, other CI jobs including E2E succeeded. This search/help change awaits those jobs before publication.

### 2026-10-24 execution authorization through research
- Existing runAgents authorization checked around model execution but did not reach askAgent/research. Passed the guard through, checking before each model round, after model responses and before each function tool call. Revocation after an in-flight tool prevents another model request containing its output; already-started external actions cannot be undone. Plain completion also checks before/after its request.
- Research suite10 tests pass (/tmp/honmaru-agent-research-revocation.log), including no initial call after revocation, no tool after revocation during a model call, no next model call after a tool revokes access, and askAgent guard propagation without fallback. Unguarded callers retain previous behavior. Normal conversation execution still needs a current-request authorization callback; this change currently strengthens callers such as room webhooks that already supply one. Full regression/publication pending.
- Releaseffe1563d Worker40058200644 and Web40058200604 completed success; CI40058200605 still live. Search-count commit84c9f8bd is separately verified and not yet pushed. No overlapping publication.

### 2026-10-24 normal conversation execution grant
- Added persisted request grant resolution for normal queued/inline agent execution: current session, workspace sign-in rules and membership, original message author, undeleted source, current room access and current responder permissions. Each authorization check rejects changed body/channel/parent/author and agents no longer eligible. AgentRunner uses the same preflight resolver and passes its authorizer through runAgents to research.
- Related agent/research suites73 tests passed (/tmp/honmaru-normal-agent-grants.log); the added private-agent-access regression passed with the31-test Harness agents suite (/tmp/honmaru-agent-grant-private.log). Message edit, deleted agent, sign-out and actor substitution revoke execution. Existing Simple behavior remains in the passing agents regressions; full Worker regression still pending.
- Priorffe1563d CI40058200605 completed success. Published only already-verified UI commit84c9f8bd; Web40059384522 succeeded, CI40059384616 remains live. Research/grant changes are local and not included in that publication.

### 2026-10-24 normal execution grant full regression
- Frozen Worker sources frome7c8f745 passed217 files/1758 tests in476.82s (/tmp/honmaru-agent-grants-full-worker.log). The research authorization changes preserve the existing Simple and Harness regression coverage. No test failure was inferred from the runtime's existing body/content-type warnings.
- Version1.3.13 consistency and working-tree diff checks passed. Web sources remain the already-verified/published84c9f8bd build. These Worker changes await priorCI40059384616 completion before publication; native refresh remains unverified due to the operation tool's lock response.

### 2026-10-24 durable normal agent execution results
- Normal AgentRunner alarm jobs now persist running/finished/failed/cancelled/no-agents outcomes before removing their queued job. Finding a prior running result after a restart records interrupted without executing it again. Result persistence failure retains the queued job; retry records uncertainty without repeating external work. Proxy behavior remains unchanged. Storage failures back off15 seconds instead of immediately rescheduling.
- This relies on the documented one-alarm-at-a-time guarantee per Durable Object (https://developers.cloudflare.com/durable-objects/api/alarms/); at-least-once alarm retries are explicitly handled. No model/tool exactly-once claim is made: already-started external effects cannot be undone, and ordinary request enqueue fallback/outbox integration remains a separate gap.
- Helper and normal-agent39 tests passed (/tmp/honmaru-agent-job-results-final.log), including real Durable Object result persistence, interrupted recovery, lost terminal write, rejected start write and storage-error backoff. Earlier related3 suites68 tests passed. Research cancellation now propagates through askAgent to suppress generic failure replies after cancellation; research/room-hook30 tests passed (/tmp/honmaru-agent-cancel-propagation.log). Full regression/publication pending. This is execution-state groundwork, not a completed agent-to-agent handoff.

### 2026-10-24 skill search release delivery verification
- UI release84c9f8bd CI40059384616 and Web40059384522 both completed success. Deployment verification logs confirm both https://honmaru-web.pages.dev and https://app.honmaruai.com served index-CBoMnX_f.js at2026-10-24T03:43:12Z. This verifies asset delivery, not authenticated production interaction. Native refresh remains pending the computer-use lock issue.
- Execution grant full regression1758 tests already passed; additional durable-result Worker sources remain frozen frome0a47752 for full87689 (/tmp/honmaru-agent-results-full-worker.log). Publish the combined server batch only after that run succeeds.

### 2026-10-24 execution grant and durable-result release preflight
- Frozen Worker sources frome0a47752 passed218 files/1764 tests in450.89s (/tmp/honmaru-agent-results-full-worker.log). Full87689 completed normally; no rerun was started because of observation delays. Web remains the verified84c9f8bd source.
- Prior84c9f8bd CI40059384616/Web40059384522 completed success before this publication. Publish execution grants, research cancellation propagation and durable normal-job outcomes together. Authenticated native verification is still pending; no complete handoff or 100% parity claim.

### 2026-10-24 normal agent execution status reads and Harness UI
- Added GET /channels/agent-runs with at most20 unique source IDs. Current membership, room resolution, exact canonical conversation, source kind and deletion are checked for the entire batch before querying AgentRunner. The internal /agent-status route returns only allowlisted status/count/version metadata. An old accepted receipt alone is unknown; only a real pending normal job indicates queued. Proxy and webhook jobs do not contaminate normal status.
- Targeted Worker2 suites/11 tests pass (/tmp/honmaru-agent-status-tests.log): bounded input, legacy receipt handling, terminal precedence, metadata sanitization, mixed private/public denial, absent binding, auth and deleted source. Full Worker run is pending against frozen server sources.
- Harness conversation/thread panels batch up to20 recent persisted human messages, poll active jobs, bound initially unknown/error retries, abort and discard responses on scope changes, and clear stale running state after request failure. Simple does not mount the component or make these reads. Finished means handler termination, not external task success; no unsafe retry button was added.
- Web154 files/1066 tests passed before the final disclosure-arrow/title presentation adjustment; TypeScript/Vite passed. Actual component shown through the in-app browser with disposable mocked execution states: Japanese collapsed/expanded, explicit light and dark, and360px content width. This is local rendering evidence, not authenticated production E2E. Native Honmaru still returned locked even after the user's unlocked confirmation; the in-app browser could open production but was signed out. No production data was changed for these checks.
- Frozen status-API Worker sources passed219 files/1767 tests in538.19s (/tmp/honmaru-agent-status-full-worker.log). Final UI154 files/1066 tests plus TypeScript/Vite passed after the presentation adjustment (/tmp/honmaru-agent-status-web-final.log, /tmp/honmaru-agent-status-build-final.log). Version1.3.13 and inventory consistency checks passed; inventory remains95 items (75 partial,16 missing,2 implemented,2 unverified), not a completion percentage.
- Inspection found cancellation could return before the final typing-progress event. Moved its cleanup into finally; cancellation now emits done without posting a reply. The added regression initially failed because its relay fixture only handled broadcast events, while this room uses recipient deliveries; corrected the fixture to inspect both actual envelope shapes. Final related4 suites/55 tests pass (/tmp/honmaru-agent-status-cancel-final.log). The full1767 run predates this small cleanup; final source is covered by the related regression and still awaits CI.
- Previous main8f09705e CI40061007684 and Worker40061007668 still run their Worker test steps. This new change is held locally until those terminal results; no overlapping push or deployment. Temporary local fixture files/server were removed/stopped.

### 2026-10-24 execution-status publication and handoff persistence
- Previous8f09705e CI40061007684 and Worker40061007668 completed success. Pushed verified status UI/API commit1646634f to main; new CI40062249359, Worker40062249318 and Web40062249296 are running. No overlapping push occurred.
- Added internal assignment-generation state, immutable handoff records and a delivery outbox in schema/migrations. Each independently requested initial agent retains its own assignment. Ownership transfer, an inert visible agent message and pending delivery are atomic. Same-payload retries reuse the original event; conflicting IDs, concurrent losers, self/cyclic/exhausted transfers and stale completion are rejected. Target claim is one-time; cancelled pending work cannot claim execution. A forced outbox insertion failure rolls the whole transaction back.
- Added current-origin/target grant helpers: original human author/session/source remains intact; Harness room mode, current readable canonical room, source fingerprint, current target membership and invocation access are checked separately from original responder selection. No new access grant is implicit. The normal grant shares the origin resolver and additionally rejects non-human-message kinds.
- Assignment/grant/research3 suites/51 tests passed (/tmp/honmaru-agent-assignment-grants-final.log). The run exposed an existing test timing assumption: a reply may appear before the same Durable Object alarm persists its terminal result. The regression now waits for that running result to settle without rerunning execution. Initial foundation tests6 and combined tests41 also passed. Full Worker regression pending. Runtime handoff/tool/dispatcher/chain UI is NOT connected; these helpers are groundwork, not completed handoff or parity.

### 2026-10-24 execution-status release verified; handoff control signal
- Status release1646634f CI40062249359, Worker40062249318 and Web40062249296 completed success. Web verification logs show both https://honmaru-web.pages.dev and https://app.honmaruai.com serving index-BvwBrpL_.js at2026-10-24T04:37:30Z. Authenticated native UI remains unverified because the Mac tool still reports locked. A direct local Worker health read received Cloudflare1010/403; no client filtering was bypassed. The successful deploy's Verify step remains the health evidence.
- Full handoff-foundation run73149 completed with218 passing files and2 failing migration files (1766 passing,9 failing tests) in658.31s (/tmp/honmaru-agent-assignment-full-worker.log). All failures were the new multiline CREATE TABLE statements passed to the line-oriented migration executor. Flattened those migration statements, preserving their SQL semantics; migration/read-version2 suites/11 tests then passed (/tmp/honmaru-agent-assignment-migrations.log). This full run is not recorded as successful.
- Added private WeakSet/WeakMap runtime control signals. A trusted handoff tool runs before ordinary sibling functions; successful handoff suppresses remaining functions, generated final text and another model round. Failed handoff leaves the turn intact; a JSON-shaped result cannot forge the control signal. askAgent preserves the outcome and runAgents does not create a fallback failure reply for it. Existing ordinary function tools remain parallel. Related research/agents/assignment3 suites/54 tests passed (/tmp/honmaru-agent-control-target.log). No production handoff tool is registered yet.
- Runtime integration review found prerequisites before enabling handoff: the existing uncertain enqueue-to-inline fallback can duplicate a source execution, and ownership cleanup must remain retryable if its durable write fails. Implement the normal request's atomic message/outbox and retry-only delivery path first; ensure completion/interruption persistence cannot leave a running assignment falsely active. Prepared dispatcher/runtime code is intentionally not connected until these invariants are satisfied. External teammate generation fencing, non-research providers, chain/stop UI and production end-to-end checks remain incomplete.

### 2026-10-24 atomic normal-request outbox
- Harness production sends now resolve intended responders before persistence and save the source message, attachment claims and a normal agent delivery outbox in one D1 batch. A dispatch insertion failure rolls everything back; client-send replay keeps the original message/outbox. The outbox stores the server's hashed session key, selected agent IDs and a source fingerprint, not another copy of the request body or a raw session credential.
- Delivery uses bounded leases/backoff, targeted immediate dispatch and the minute drain. Only202 confirms queue acceptance. A lost acknowledgement or queue failure remains pending and never falls back to a second inline model run. Simple and explicit inline development mode retain their existing paths. Execution rechecks the outbox snapshot and original responder IDs; edits/sign-out revoke it rather than silently running a different request or newly matching agent.
- Read-only status decorates unknown runner state with pending_delivery/cancelled from authorized source dispatch metadata, without exposing session keys. The Harness panel distinguishes queue acknowledgement pending from execution queued/running and keeps polling pending delivery beyond the bounded legacy-unknown retries.
- Initial4 Worker suites59 tests passed (/tmp/honmaru-agent-request-target.log); final related request/agents/enqueue/files4 suites77 tests passed (/tmp/honmaru-agent-request-final-target.log). Coverage includes atomic rollback with an attachment, send replay, acknowledgement loss/no inline answer, identical delivery retry, scoped pending status and edit/sign-out invalidation. Web154 files/1067 tests, TypeScript and Vite passed (/tmp/honmaru-agent-request-web-full.log, /tmp/honmaru-agent-request-build.log). Full combined Worker regression and publication pending. Handoff tool registration/runner wiring remains intentionally inactive until terminal ownership cleanup is recoverable too.

### 2026-10-24: pending delivery UI and settlement recovery preparation

- Commit `a8df9c96`: normal Harness request outbox. Its full Worker regression is still running under PID 33294 at this observation; `/tmp/honmaru-agent-request-full-worker.log` is the same run, not a restarted test.
- IAB local Vite preview used the actual `AgentRunStatus` component, Japanese locale, `shell harness-workspace` / `classic slk` ancestor styles, and a mocked `pending_delivery` response. Expanded and collapsed states were inspected in explicit light and dark themes in a 360px content region. The request excerpt truncates, status remains readable, and icons/labels do not overlap. The temporary preview files and server were removed/stopped. This is component rendering evidence, not authenticated production or Kylon equivalence evidence.
- Native Honmaru screen retrieval still reported a locked Mac after the user's unlocked confirmation. No authenticated screen verification is claimed.
- Isolated settlement callback prototype in `/tmp/honmaru-agent-job-settlement.mjs` passed four Node tests: failed cross-store settlement retains running/queued state; recovery does not repeat execution; failed recovery remains retryable; terminal cleanup is idempotent; handoff uses a separate result namespace. Not yet integrated into the running Worker regression snapshot.
- Latest inspected main CI / Worker / Web deployment runs (`40062249359`, `40062249318`, `40062249296`, commit `1646634f`) all completed successfully. New local commits remain unpublished pending regression completion.

### 2026-10-24: terminal settlement integrated

- The unchanged `a8df9c96` Worker snapshot completed: **221 files / 1,783 tests passed**, 706.89s (`/tmp/honmaru-agent-request-full-worker.log`). This supersedes the in-progress observation above.
- `runTrackedAgentJob` now awaits idempotent cross-store settlement outside the execution-error catch, before recording the terminal result or deleting the job. A settlement failure preserves running/queued state; recovery settles interruption without repeating model/tool work. Result namespaces support a future handoff job independently of normal source-message jobs.
- Normal AgentRunner jobs settle only their source assignment's generation zero. Advanced handoff generations and existing terminal records cannot be overwritten. The actual handoff dispatcher/tool remains unconnected; this is recovery infrastructure, not a claim of completed agent delegation.
- After integration, **4 files / 64 tests passed** (`agent-job-result`, `agent-assignments`, `agent-enqueue`, `agents`; `/tmp/honmaru-agent-settlement-target.log`, 22.19s). Includes an actual D1 trigger failure followed by recovery, scoped org checks, preservation of the delegated owner, and no repeated execution. No full Worker rerun was needed solely to repeat the prior result; CI will validate the final snapshot.

### 2026-10-24: local durable agent handoff execution

- Added `handoff_to_agent` to durable Harness room research runs, separate handoff queue receipts/results, bounded delivery retry/minute drain, and exact-generation terminal settlement. Original human origin remains unchanged; the target receives an explicit brief. Source final text is suppressed after a successful trusted control handoff. Simple/explicit-inline paths retain their behavior.
- Related runtime tests: **5 files / 81 passed**, 22.48s (`/tmp/honmaru-handoff-runtime-final-target.log`). A mocked source model hands off, a mocked target model answers in the original thread, and replay does not call either model again. Additional checks cover source edits after lost queue acknowledgement, handoff receipt isolation and cleanup of only the matching target generation.
- External teammate callbacks, broader provider handling, atomic final-write fencing, chain/stop UI, and live Kylon/production comparison remain incomplete. No parity completion claim.

### 2026-10-24: handoff history client prepared

- `AgentRunStatus` accepts bounded assignment metadata, shows the current assignee and expandable handoff chain, and keeps polling while a delegated target is active even if the original normal job has finished. Existing source-only responses remain supported. Assignment cancellation uses a generic stopped label rather than incorrectly claiming an access change.
- Actual component preview in IAB: Japanese, explicit light/dark themes, 360px content region, current assignee, one timestamped hop, collapsed/expanded history. Added an explicit history disclosure icon after visual inspection. No live Kylon or authenticated production equivalence is claimed. Temporary preview files/server/tab were cleaned up.
- Web regression **154 files / 1,068 tests passed**, TypeScript and Vite build passed (`/tmp/honmaru-handoff-status-web.log`, `/tmp/honmaru-handoff-status-web-build.log`). The new test proves continued polling after source completion and terminal polling stop after the delegated target finishes.
- API integration remains pending. The metadata-only query helper is prepared at `/tmp/honmaru-agent-assignment-status.js`; it must be connected only after all source messages pass conversation-read authorization. No session hashes, source fingerprints, handoff briefs or agent instructions should be returned. The ongoing Worker regression is still the unchanged `da0023cc` snapshot (session 15789, PID 36301).

### 2026-10-24: history API, stop control and atomic reply fence

- Prior handoff snapshot `da0023cc`: full Worker regression **221 files / 1,793 tests passed**, 542.84s (`/tmp/honmaru-handoff-runtime-full-worker.log`, session 15789 terminal success).
- Connected persisted assignment/hop metadata to the conversation status endpoint after validating every source message. Returned data excludes session hashes, fingerprints, actor IDs, briefs and instructions. Current requester/manager capability determines `canStop`.
- Stop endpoint rechecks membership/policy, readable conversation, source and assignment scope, requester or `agent.manage_others`, and observed generation. It is idempotent for already-cancelled work and returns conflict for changed/terminal work. The client does not claim successful stop after a lost acknowledgement and refreshes after a generation conflict.
- Assigned normal/error replies now check live ownership, exact generation, room/thread and unchanged live source inside the INSERT statement. A stop/handoff/source edit between an earlier authorization check and the write cannot publish a stale reply.
- Worker integration: **6 files / 101 tests passed**, 18.06s (`/tmp/honmaru-handoff-status-stop-worker.log`); after tightening the SQL source room/kind/thread predicate, **2 files / 51 tests passed**, 9.51s (`/tmp/honmaru-handoff-fence-final.log`). Includes scoped metadata/stop rights, foreign-message batch rejection, denied/stale stop requests, cancelled delivery and late-reply rejection.
- Web: **155 files / 1,072 tests passed**, TypeScript and Vite build passed (`/tmp/honmaru-handoff-stop-web.log`, `/tmp/honmaru-handoff-stop-web-build.log`). IAB local actual-component preview in Japanese at 360px content width checked light/dark stop button, explanatory text, and acknowledged stopped state with active count/button removed. This uses mocked responses, not authenticated production. Preview artifacts/server/tab removed.
- Main `033620e5` CI `40064671781` completed success. Worker `40064671824` remained live in Test, Web `40064671829` was waiting for the matching Worker; no new deployment was pushed over them.

### 2026-10-24: external teammate turn version fence

- Added default-zero `turn_version` to external teammate runs; continuing a remote session atomically advances the local version. Settlement now matches the original workspace and observed version as well as running status.
- A new regression proves an old poll cannot mark a newer turn idle or overwrite its usage/event cursor; a current poll settles once. Another proves legacy zero-version compatibility and rejects cross-workspace settlement.
- **4 files / 17 tests passed** (external teammate suites, new turn fence, read-version migration; `/tmp/honmaru-external-turn-fence.log`, 8.78s). The first command misspelled `migration.test.js` as `migrations.test.js`; it did not run that file. Ran the correctly named migration suite separately: **1 file / 10 tests passed**, 3.27s (`/tmp/honmaru-external-turn-migration.log`). No claim that the misspelled target ran.
- External handoff eligibility remains disabled pending persisted assignment callback fencing and durable/idempotent reply publication. This change does not complete external multi-agent delegation.
- Latest checks still showed main `033620e5` Worker deployment `40064671824` live in Test and Web `40064671829` waiting. The CI run for that commit succeeded; no deployment was restarted or replaced on observation delay.

### 2026-10-24: external completed-result outbox

- Non-proxy external runs atomically save terminal state and a bounded result-publication payload. A failed outbox insert rolls state/event/cost changes back. The watcher drains pending results even when the remote run is already terminal, so a lost local reply no longer requires repeating remote execution.
- Delivery has a lease/backoff and persisted client-message identity. A test forces failure after reply insertion but before acknowledgement; retry leaves exactly one agent message. Payloads are cleared after publication/cancellation. Agent identity is captured and checked; existing webhook reply guards remain applied. Proxy action proposals are deliberately excluded until their own action idempotency is implemented.
- **6 files / 30 tests passed**, 12.63s (`/tmp/honmaru-teammate-result-outbox.log`), covering existing external teammate integrations and migrations. Added explicit proxy exclusion verification afterward: **1 file / 4 tests passed**, 2.71s (`/tmp/honmaru-teammate-result-final.log`).
- Main `033620e5` is fully verified: CI `40064671781`, Worker `40064671824`, Web `40064671829` all completed success. Worker Verify succeeded. Web Verify logs confirm both `https://honmaru-web.pages.dev` and `https://app.honmaruai.com` serve `index-pMJBFx2w.js` at 2026-10-24T05:21:59–05:22:00Z. This is deployment/asset verification, not authenticated UI verification.

### 2026-10-24: inbound external agent handoff bridge

- Qualified external teammates can receive a durable handoff. Assignment ID/generation/agent identity persist through remote run start/continuation and the publication outbox. Start and callback recheck original human authority and target availability; callbacks use the atomic source/ownership reply fence.
- Pending external work/publication retains assignment ownership across normal/handoff job completion or recovery. A duplicate target execution observes pending remote work instead of restarting it. Existing assigned remote work refuses overlapping continuation. Reply delivery identity can replay an already-persisted assigned message without creating a new one; failed finalization is retried before delivery acknowledgement.
- Tests use mocked Anthropic endpoints: normal completion, explicit stop, sign-out before completion, and failure to save assignment completion after the reply landed. The final case verifies pending ownership survives a runner interruption and retry produces one remote execution and one final reply.
- **9 files / 96 tests passed**, 20.26s (`/tmp/honmaru-external-assignment-final-target.log`). Added lookup indexes only in ordered column migrations (not schema.sql before old columns exist); final migration validation **2 files / 11 tests passed**, 4.20s (`/tmp/honmaru-external-assignment-migrations.log`).
- Remote teammates still cannot initiate the local controlled handoff tool themselves. Other model-provider tool support and authenticated production/Kylon verification remain incomplete. No claim of full delegation or 100% parity.

### 2026-10-24: workspace query audit correction

- CI `40066192513` at `74226777` completed with 222 files / 1801 tests passing and one audit failure: the unscoped `teammates.js` query count decreased from 4 to 3, but its baseline was stale. Lowered the baseline (no relaxation of workspace isolation); the two audit tests pass in `/tmp/honmaru-workspace-count-fix.log`.
- Full Worker run started at `044496b7` remains in progress (`/tmp/honmaru-external-assignment-full-worker.log`). Its initial snapshot has the old audit baseline; the baseline-only correction was tested separately while it ran. Do not label that full run as validation of the subsequent commit without qualifying this change.
- Browser inventory still reports native Mac access locked despite the user confirming it is usable. IAB successfully reaches the production welcome screen, but has no signed-in session. This does not verify authenticated application UI. No repeated unlock request was sent.

### 2026-10-24: assignment identity presentation and verification

- Full Worker run completed: **223 files / 1806 tests passed**, 498.19s (`/tmp/honmaru-external-assignment-full-worker.log`). Runtime sources stayed at `044496b7` during this run; the audit baseline correction was applied while it ran, and its separate two-test check also passed. The avatar metadata changes below were made only after this run completed.
- Assignment status now includes existing agent emoji/avatar metadata for current ownership and both sides of each handoff. The UI reuses AgentAvatar, retains a vector fallback, and wraps long identities in narrow layouts. API scope/private-data checks remain in place.
- Post-change Worker validation: **2 files / 43 tests passed**, 8.45s (`/tmp/honmaru-assignment-avatar-worker.log`). Frontend status suite **8 tests passed**; TypeScript and Vite production build succeeded (`/tmp/honmaru-run-avatar-build.log`). Actual component with fixture data inspected through IAB at 360px content width in light/dark modes, expanded history and long names. Temporary preview files/server/tabs removed. Not authenticated production verification.
- `74226777` CI and Worker deployment failed only the stale query-count audit; Worker stopped at Test. Web stopped waiting for that Worker. All three runs are terminal; the revision did not deploy. The corrected revision may now be dispatched without replacing live jobs.

### 2026-10-24: handoff timestamps follow app locale

- Handoff history uses the selected application locale with cached Intl formatting, rather than the browser's default language. Invalid saved locale identifiers fall back to English; malformed timestamps remain omitted. Display uses local time, with the original timestamp retained in the time element.
- Status/date-format suites: **2 files / 18 tests passed**. Added Japanese, German, malformed locale and malformed date cases. TypeScript and Vite production build passed (`/tmp/honmaru-handoff-locale-build.log`).
- Main `ca7c25af` was pushed successfully. Its CI `40067260591`, Worker `40067260596`, Web `40067260615` were confirmed in progress. Timestamp follow-up remains local until those jobs complete; no overlapping deployment was dispatched.

### 2026-10-24: OpenRouter tool execution for Harness

- Added opt-in Harness tool loop for the existing OpenRouter provider; Simple remains ordinary completion. No new provider credentials, hosted services or paid-model substitutions. Trusted handoff, current grant checks, bounded rounds/calls/output/deadline, call-ID result reuse and no replay after uncertain model response are covered.
- Targeted validation **4 files / 66 tests passed**, 13.01s (`/tmp/honmaru-openrouter-tools-final.log`). Added lost-response and progress-callback revocation tests afterward: **12 tool-loop tests passed**, 2.83s (`/tmp/honmaru-openrouter-tools-recovery.log`). Provider calls were mocked, not live production execution.
- First targeted attempt failed because a persistent mock leaked into the next test; replaced it with the exact seven expected responses. Both subsequent runs passed. Model-specific live compatibility and outbound remote-agent delegation remain unverified/incomplete.

### 2026-10-24: preserve assignment controls during queue status outages

- The reader-scoped status route now loads current D1 request/assignment metadata even when the runner binding is absent, its status call fails, or its response has invalid/mixed identities. Queue availability remains explicitly false; missing queue state is not represented as successful execution. A D1 failure remains an unavailable response.
- The UI preserves fresh partial metadata and stop controls with an explicit unavailable-status notice, polls active assignments, and bounds terminal/unknown retries. It still clears stale data on a failed whole request or account/conversation change.
- Worker route/query checks: **2 files / 46 tests passed**, 14.32s (`/tmp/honmaru-partial-status-worker.log`), including actual stop calls during three simulated runner outages and foreign-message batch rejection. Frontend status suite **12 tests passed**; TypeScript and Vite build succeeded (`/tmp/honmaru-partial-status-build.log`).
- The full Worker run in `/tmp/honmaru-openrouter-full-worker.log` started at `7fa2e4a0` and is still active. Subsequent status-route changes were independently validated above while that run was active; do not present the ongoing run as a frozen full-suite validation of this later change.

### 2026-10-24: uncertain tool deadlines

- OpenRouter tool waits are now bounded by the execution deadline. Timeout suppresses sibling tools, subsequent model rounds and any prewritten draft; an already-started external operation may still complete and is never retried automatically. The interruption result propagates to persisted assignment status instead of marking ownership finished.
- Targeted final validation: **3 files / 68 tests passed**, 13.83s (`/tmp/honmaru-tool-deadline-settlement.log`). Includes a never-resolving tool and an actual D1 assignment transitioned to interrupted. Initial test used a deadline inside the final-answer-only window and therefore never invoked a tool; corrected the fixture to advance time after the initial model response. The standalone final tool suite passed 13 tests.
- The previously started full run remains active, and has now observed the newly edited test while earlier modules may have been loaded. It reports a timeout in that new test. This mixed-source run cannot establish full validation of the final revision. Let it finish; run the final committed Worker snapshot without source/test edits afterward. Do not restart solely due to observation timeout.
- Updated KY-018 from missing to partial based on durable handoff evidence; all unresolved automatic takeover, remote outbound delegation and live verification requirements remain explicit. Inventory remains a coverage checklist, not a completion percentage.

### 2026-10-24: fixed runtime snapshot verification and release

- The previous mixed-source run terminated with 223 files / 1818 tests passed and one new deadline-test timeout; it was not treated as final validation.
- A fresh run with runtime/test sources fixed at `f454957c` completed successfully: **224 files / 1823 tests passed**, 482.65s (`/tmp/honmaru-f454957c-full-worker.log`). During that run only a design document was committed in this checkout; subsequent app-automation development occurred in a separate worktree. Web full suite: **155 files / 1077 tests passed** (`/tmp/honmaru-f454957c-full-web.log`).
- Prior main `ca7c25af` CI `40067260591`, Worker `40067260596`, Web `40067260615` all completed success. Worker/Web Verify steps succeeded. Web logs confirm both production domains serve `index-D1vSGfrU.js` at 2026-10-24T05:54:25Z. Authenticated production functionality remains unverified.
- App automation foundation is isolated on `codex/app-automations` at `cbabe3f2`; it is not included in this release. Its worktree registration failed because the thread exceeds 100 attachments; checkout remains at `/Users/tt/.codex/worktrees/app-automations/Honmaru`. Do not create a duplicate checkout.

### App automation integration (2026-10-24)

Merged isolated app automation work into the primary branch at `8e752136`, preserving preceding main documentation. Worker frozen full suite passed 225 files / 1854 tests; subsequent follow-up origin/migration fix passed 4 files / 108 targeted tests. Latest Web full suite passed 158 files / 1089 tests and Vite production build succeeded (`/tmp/honmaru-b47-full-web.log`, `/tmp/honmaru-b47-build.log`). KY-053 moves from missing to partial based on concrete implementation; inventory counts do not measure parity. Authenticated real-screen comparison remains unavailable, and no 100% claim is made. Existing source/step editing limitations and reconciliation edge cases are recorded in app-automation-contract.md.

### App automation UI follow-up verification

Primary runtime commit `c49aae04` (resource-name review, minute-precision follow-up editing, in-app execution history) passed the full Web suite: 160 files / 1093 tests, 3.61s (`/tmp/honmaru-c49-full-web.log`). Production build also succeeded (`/tmp/honmaru-c49-build.log`) with existing chunk/dynamic-import warnings. No Worker runtime changes followed cfece088's push. Its CI 40071366860, Web 40071366835 and Worker 40071366840 are still confirmed in progress; hold the next push until all are terminal. Authenticated real-screen operation/Kylon parity remains unverified.

### Local rendered automation review check

Rendered the actual AppAutomations component with explicit fixture data using the app's index/appearance/theme/App/Harness/Workspace styles in IAB at localhost. Expanded the drift comparison and switched to dark theme; screenshot inspection shows two readable columns, named targets, schedule/timezone, review checkbox and execution-history control. Saved evidence: `/tmp/honmaru-automation-dark-preview.png`. Initial screenshot omitted global styles and is not used as final styling evidence. Temporary fixture files and Vite server were removed/stopped after inspection. This confirms one local desktop viewport with fixture data only, not authenticated production operation or Kylon visual equivalence. Mobile/theme edge cases remain unverified.

### Unsaved-edit final Web verification

Runtime `dfbe5021` passed Web 160 files / 1094 tests (`/tmp/honmaru-dfbe-full-web.log`), TypeScript (`/tmp/honmaru-dfbe-types.log`) and production build (`/tmp/honmaru-dfbe-build.log`). At the latest GitHub job inspection, cfece088's Web deploy is waiting for matching Worker deployment; Worker deploy runs its Test step; CI Worker and E2E tests are active. CI Local gateway, Desktop, Shared core/mobile, Reference web client and Reference relay have succeeded. No failed job was reported, but overall success remains unproven until active jobs terminate.

### App automation production release verified

At cfece088, CI 40071366860, Worker 40071366840 and Web 40071366835 all completed successfully. Worker version is 9e40b6e8-9dc4-491d-af5f-21b04bbb39b6. Web deployment logs confirm both honmaru-web.pages.dev and app.honmaruai.com serve index-Bwh8qCgT.js at 2026-10-24T06:58Z. IAB rendered the production welcome screen after startup; it has no signed-in session. Native inventory still reports locked despite the user's confirmation, so authenticated UI equivalence is not verified and no repeated unlock request was made.

The queued follow-ups through ce76f62d include readable resource names, minute-precision follow-ups, execution history, unsaved-edit protection and a waiting/terminal continuation guard. Latest Web validation remains 160 files / 1094 tests plus TypeScript/build; continuation tests passed 2 files / 96 tests. These follow-ups are separate from the production release verified above.

### Single active workflow execution

Workflow admission now atomically excludes other running/waiting runs for the same workspace/workflow. Concurrent triggers create one run/definition and one set of side effects. Automatic webhook overlap returns 202 with an explicit skipped reason; manual UI calls return 409; MCP returns a structured skipped outcome. Held webhook replay retains events it could not start. A partial index supports active-run lookup without rewriting historical runs. This does not provide durable crash recovery or terminate pre-existing stuck executions.

Final targeted validation: 5 files / 116 tests passed, 16.39s (`/tmp/honmaru-workflow-admission-complete.log`), covering concurrent admission, approval wait, terminal release, webhook acknowledgement, held replay, MCP, app lifecycle, migrations and query isolation. Initial added test had createWorkflow arguments in the wrong order; corrected before final validation. No new service or Simple runtime changes. Preceding 65b03455 CI/deploy jobs remain in progress; do not replace them with a new push.

### Automation history identity change

AutomationRuns now clears results on workflow/API identity changes and reloads an expanded history for the new identity. Request generations fence stale responses; an older request finishing cannot release the new request's busy state. Four focused UI tests passed, including outstanding-response and API-switch cases (`/tmp/honmaru-automation-history-identity.log`); TypeScript and Vite production build passed (`/tmp/honmaru-history-identity-build.log`). Worker runtime/test files remain fixed at e32acec4 while the full Worker suite runs in session 63500.

### Full Web validation after history identity fix

Web runtime 3db9fcc3 passed all 160 files / 1096 tests in 4.00s (`/tmp/honmaru-3db9-full-web.log`). The full Worker run remains live in session 63500; network/body warnings in its log are not a terminal result. Prior production candidate 65b03455's three GitHub runs also remain in progress. No overlapping deployment was pushed and no full Worker success is claimed yet.

### Per-run elapsed duration

App automation history displays localized elapsed duration only for terminal runs with valid nonnegative start/finish timestamps. The label explicitly includes approval waiting time; it does not represent model compute time or credit usage. Running/waiting/unknown status and invalid timestamps omit duration. Five focused history tests pass (`/tmp/honmaru-run-duration.log`); TypeScript and production build pass (`/tmp/honmaru-run-duration-build.log`). No authenticated screen or Kylon-equivalence claim. The earlier 1096-test full Web run predates this duration addition. Worker source/tests remain fixed for the still-live full run.

### Frozen admission Worker and final duration Web validation

Full Worker source/test snapshot e32acec4 completed successfully: 225 files / 1861 tests, 494.16s (`/tmp/honmaru-admission-full-worker.log`, session 63500 terminal exit 0). Only Web/docs changed while it ran; no Worker edits were introduced. Runtime warnings did not produce failed tests. Latest Web runtime 48d03565 passed 160 files / 1097 tests, 3.81s (`/tmp/honmaru-48d-full-web.log`); its TypeScript/build already passed. These are local validation results, not authenticated production parity evidence.

At 2026-10-24T07:10Z, prior candidate 65b03455 CI 40072311299, Web 40072311252 and Worker 40072311345 remain in progress. Hold follow-up publication until they are terminal. The now-completed local Worker session must not be polled or restarted without a new validation reason.

### Active execution history refresh

Expanded automation history refreshes every ten seconds while it contains running/waiting executions, without overlapping fetches. Closing, completion, errors and unmount stop polling; existing identity fencing remains. Full Web passed 160 files / 1099 tests, 3.35s (`/tmp/honmaru-history-refresh-full-web.log`). TypeScript initially rejected the new timer tests' act callback returning VitestUtils; changed those callbacks to return void, then TypeScript/build and seven focused tests passed (`/tmp/honmaru-history-refresh-build.log`, `/tmp/honmaru-history-refresh-final.log`). No Worker runtime changes after the frozen 1861-test success. Previous production jobs still active; this remains unpushed.

### Production candidate 65b03455 completed

CI 40072311299, Worker 40072311345 and Web 40072311252 all completed successfully. Worker version edfc9345-6824-4f4b-ab23-9a5d2cd9a583 was published. Web deployment logs confirm both honmaru-web.pages.dev and app.honmaruai.com serve index-CFCp44d2.js at 2026-10-24T07:18:57Z. This proves delivery of the preceding resource-name/history/unsaved-edit/continuation fixes, not authenticated UI equivalence. Follow-up admission and history refinements through 20d55ee6 may now be pushed without overlapping the previous release. Frozen Worker 1861 tests and latest Web 1099 tests remain the validation evidence for that follow-up.

### Failure pause notification validation and local rendering

Web at f85ab7df passed 161 files / 1105 tests (`/tmp/honmaru-safety-full-web.log`). Full Worker run is active in session 95952 (`/tmp/honmaru-safety-full-worker.log`) with Worker runtime/tests fixed at this commit; do not alter them until it terminates. No final Worker result yet.

Rendered actual WorkflowNotices and AutomationRuns in IAB with explicit fixture data, full existing global/Harness styles, Japanese locale and a 360px content wrapper. Expanded notifications/history, inspected light/dark screenshots, and confirmed readable wrapped explanations and resume controls. Evidence `/tmp/honmaru-safety-dark.png`, `/tmp/honmaru-safety-light.png`. Temporary fixture/server/tab removed. This is local component rendering, not authenticated production/Kylon comparison. Notice acknowledgement/resume mutations were not exercised against production. Automation-thread delivery remains unimplemented.

### Source-thread rendering and preceding production evidence

At ca5aceaa, full Web passed 162 files / 1107 tests (`/tmp/honmaru-ca5-full-web.log`). The integrated full Worker run remains active with Worker source/tests fixed at ca5aceaa (`/tmp/honmaru-ca5-full-worker.log`); no terminal success is claimed yet. The preceding frozen f85ab7df run passed 226 files / 1868 tests but excludes the source/delivery follow-ups.

Rendered the actual WorkflowSource component with full application styles, Japanese locale, dark theme and 360px content wrapper. Selected a fixture root and exercised the mocked save: candidates become the bound-thread summary and notification explanation. Screenshot `/tmp/honmaru-source-bound-dark.png`. This is local fixture rendering, not a production mutation or authenticated Kylon comparison. Temporary preview files/server/tab were removed. Native app inventory still reports locked despite the user's confirmation; no repeated unlock request was made.

Deployment logs for prior cb32be63 confirm Worker version dddca3ee-1282-40f1-b4fd-b1539449d78c and index-CnQhrqAV.js served by both honmaru-web.pages.dev and app.honmaruai.com. CI 40073736042, Worker 40073735968 and Web 40073736102 all succeeded. The newer safety/source/notification changes have not yet been pushed at this entry.

During follow-up review, fixed the expanded source picker to reload after workflow/API identity changes instead of leaving an empty open panel. An out-of-order old response cannot replace current candidates. Three focused tests and TypeScript passed (`/tmp/honmaru-source-identity.log`). Full final Web/build is being rerun; Worker source/tests remain unchanged.

Final Web after the expanded-picker identity correction: 162 files / 1108 tests passed (`/tmp/honmaru-source-final-web.log`); production build passed (`/tmp/honmaru-source-final-build.log`). Existing bundle-size/dynamic-import warnings remain.

### Integrated source notification validation complete

The fixed Worker snapshot ca5aceaa passed 226 files / 1870 tests in 676.89s (`/tmp/honmaru-ca5-full-worker.log`, terminal exit 0). No Worker source/test changes were made during that run; only Web identity handling and documentation changed. Together with final Web 162 files / 1108 tests, TypeScript/build, version consistency and parity-inventory checks, this validates the queued failure pause, creator notices, source binding, fenced automatic thread delivery and picker changes locally. It does not establish full Kylon parity or authenticated production behavior. Prior production jobs are all terminal success, so the candidate can be published without overlapping them.

### Workflow safety/source production release a69a59a6

CI 40076372682, Worker 40076372731 and Web 40076372675 all completed successfully. The Worker migrated production D1, published version 83ba5ef4-60f6-4117-be44-6e097bc9cf9c, and passed its health check. Web deployment logs confirm index-CfG-n2sf.js served by both honmaru-web.pages.dev and app.honmaruai.com at 2026-10-24T08:17:39Z. Logs: `/tmp/honmaru-a69a59a6-120820466084.log`, `/tmp/honmaru-a69a59a6-120820465520.log`.

IAB reloaded production and rendered the welcome screen after startup. It has no authenticated session; native inventory still reports locked despite user confirmation, and browser inventory exposes only IAB/MCP Apps. Accordingly authenticated production controls and Kylon visual equivalence remain unverified. The local screenshot above is explicitly fixture evidence. A direct local Python URL request returned 403; production asset evidence comes from the successful deployment verification, not that failed request.

Remaining source gap: ClassicList workflow generation passes prompt/channel but does not persist/capture the originating root like app generation does. The manual picker is not automatic origin handoff. No new paid service was added and Simple-specific source was not changed by this release. Full parity remains incomplete. This entry records the published runtime and does not itself require a deployment.

### Workflow source navigation and rendered check

WorkflowSource now exposes an existing workspace-scoped thread route from the authorized bound source. The workflow detail supplies its workspace ID, so navigating to the original conversation uses the normal thread permission/routing path. Added the existing message icon, readable inline spacing, a 36px minimum target height and keyboard focus ring. Focused source/workflow tests passed 2 files / 24 tests (`/tmp/honmaru-workflow-origin-link.log`); TypeScript/build passed. Final full Web passed 162 files / 1108 tests (`/tmp/honmaru-source-link-full-web.log`) and build passed (`/tmp/honmaru-source-link-final-build.log`).

Rendered the actual component with full application styles, Japanese locale, explicit bound-source fixture and 360px wrapper in IAB. Inspected light/dark screenshots and Tab focus on the link. Evidence `/tmp/honmaru-source-thread-link-dark.png`, `/tmp/honmaru-source-thread-link-light.png`. This confirms local rendering and the generated route, not authenticated production navigation or Kylon equivalence. Temporary server/tab/fixture files removed.

The full Worker snapshot e0c5de2a remains live in session 95098 (`/tmp/honmaru-workflow-origin-full-worker.log`). Worker source/tests have remained fixed while only Web/docs were refined. Do not restart the suite or claim its final result until the existing handle is terminal. These origin-capture/navigation changes remain unpublished; the last verified production runtime is a69a59a6.

### Durable workflow detail routes

Added workspace-scoped `#/workflows/<id>/<org>` links. Chat generation, workflow-list selection and notice navigation now use this route instead of the single global sessionStorage handoff. The detail screen opens the requested workflow on remount; back/delete clear the detail route, and changing a route key remounts isolated detail state. Dashboard waits for the correct workspace before rendering a requested workflow, switches only to a known workspace, and drops unauthorized foreign targets to the workflow list. This workspace-switch branch follows the existing app/thread routing pattern but is not an authenticated cross-workspace browser verification.

Route/parser and workflow-screen tests passed 2 files / 44 tests (`/tmp/honmaru-workflow-route-final.log`), including valid workspace scope, malformed/ambiguous targets, requested-detail loading and navigation callbacks. The first added route test incorrectly treated a valid plain workspace ID as invalid; corrected the malformed fixture rather than narrowing the shared workspace format. Final Web passed 162 files / 1111 tests (`/tmp/honmaru-workflow-route-full-web.log`); TypeScript/build passed (`/tmp/honmaru-workflow-route-build.log`). These are in-app hash links; native/shared external-path linking is not added by this change.

Worker session 95098 was polled and remains active at this entry, with its e0c5de2a source/test snapshot unchanged. All later modifications are Web/docs only. No deployment of these queued changes has been claimed.

### Persistent generation retry identity

Chat app/workflow generation now stores only an opaque request ID under a hash of backend/workspace/user/resource kind/channel/prompt/timezone. It does not store prompt text or session credentials. Unresolved identities do not expire automatically, because a lost success response must not turn into a second creation. Confirmed success conditionally clears only its own ID. Web Locks serialize identity selection across tabs when supported; storage failures retain an in-memory retry, including write-only quota failures. Clearing a completed request in another tab supersedes stale persisted memory. Without storage, persistence across reload is unavailable; without Web Locks, cross-tab atomic selection is not guaranteed.

Six helper tests cover module reload with retained storage, identity separation, storage failures, conditional cleanup and another tab's completion. The final full Web run passed 163 files / 1117 tests (`/tmp/honmaru-generation-retry-final-web.log`), with TypeScript/build success (`/tmp/honmaru-generation-retry-final-build.log`). This is programmatic persistence evidence, not a real browser/device restart verification. Worker snapshot e0c5de2a remains unchanged during the still-live full run 95098. Previous production a69a59a6's CI/Worker/Web were freshly rechecked and all are successful; remote main is still that commit.

The asynchronous retry-identity acquisition now rechecks the active resource client/cache before starting generation, so a workspace/account switch while awaiting a browser lock cannot dispatch from the old view. Final Web remains 163 files / 1117 tests (`/tmp/honmaru-generation-final-web.log`), with TypeScript/build success (`/tmp/honmaru-generation-final-build.log`). This guard has suite/type coverage but no dedicated delayed-lock UI integration test. Worker run 95098 remains live and unchanged.

### Workflow origin full Worker validation completed

The frozen e0c5de2a Worker snapshot completed successfully: 227 files / 1878 tests, 926.32s (`/tmp/honmaru-workflow-origin-full-worker.log`, session 95098 terminal exit 0). Only Web/docs changed during this run. The latest Web is 163 files / 1117 tests plus TypeScript/build (`/tmp/honmaru-generation-final-web.log`, `/tmp/honmaru-generation-final-build.log`). Version and parity-inventory consistency checks pass. Prior production jobs are terminal success and remote main was verified at a69a59a6, so the queued origin capture, source link, durable workflow route and persistent generation retry changes can now be published. This is local validation, not authenticated Kylon parity evidence.

### Source-origin visibility and creation replies

Review of origin capture identified that mayViewWorkflow checked executable resource references but not the source conversation. A workflow generated in a private origin could therefore expose its name/steps to members with access to its public destinations. Visibility now also requires current source-conversation access for sourced workflows. The same guard covers list/detail and frozen execution history. A test verifies denial, grant and subsequent revocation while executable steps still point to a public room. This is a read-access inheritance change; it does not add a general transactional snapshot of all permissions or change approval recipients.

Generated workflows now commit one localized creation reply in the origin thread in the same batch as publication/source binding. The reply links to the workspace-scoped workflow detail and states that automatic triggers remain paused. Escaped labels prevent names from altering Markdown links. Stored-message mirroring and live broadcast occur after commit; completed retries recover mirroring without storing another reply. Broadcast itself may be repeated on retry and uses the existing message ID. Failed publication cannot leave a success reply.

Targeted Worker creation/workflow/migration validation passed 3 files / 68 tests (`/tmp/honmaru-workflow-origin-announcement-final.log`), including localized escaped replies and publication rollback. Web passed 163 files / 1117 tests (`/tmp/honmaru-origin-announcement-full-web.log`), TypeScript/build passed (`/tmp/honmaru-origin-announcement-build.log`). The source picker now explains inherited conversation access. Real authenticated rendering of this latest wording is not verified.

Because 050e458c does not include the source visibility correction, cancellation was requested for its in-progress Worker 40078972389, Web 40078972408 and CI 40078972406 before publishing a corrected candidate. At the pre-cancellation observation Worker was in Test and Web was waiting for Worker; do not claim this candidate deployed. Previous verified production is a69a59a6. This corrected Worker runtime requires a new whole-suite run; the prior 1878-test success covers only e0c5de2a.

Cancellation is now confirmed terminal for all three 050e458c runs. Job-step evidence: Worker 120828335577 skipped Migrate D1, column additions, Deploy and Verify; Web 120828335524 cancelled its dependency wait and skipped Deploy to Pages/Verify. Therefore 050e458c did not publish or migrate production. The corrected frozen Worker snapshot is 03f73405, running in session 30731 with `/tmp/honmaru-workflow-origin-private-full-worker.log`; do not alter its Worker source/tests or restart it before terminal completion.

### Creation-result links in actual message rendering

The message renderer recognized canonical app Markdown links but not workflow links, so a stored workflow creation reply would display its destination as text. Added a narrow workflow-link parser using the validated workspace-scoped route and rendered it as a same-tab anchor. It does not promote arbitrary relative URLs or external hosts into internal workflow destinations; code blocks stay literal and app links retain their behavior. Focused parser/message tests passed 2 files / 40 tests (`/tmp/honmaru-workflow-message-links.log`). TypeScript/build passed (`/tmp/honmaru-workflow-message-links-build.log`); final Web passed 164 files / 1120 tests (`/tmp/honmaru-workflow-message-links-full-web.log`).

In IAB, a temporary fixture used actual renderRich, parseRoute and HarnessWorkflows with mocked API data. Clicked the creation-result link, verified the detail target, reloaded it, expanded source metadata, opened the list and repeated list→detail→back. Final screenshot `/tmp/honmaru-workflow-created-detail-dark.png` uses the real shell.harness-workspace styling ancestor. The first screenshot omitted that ancestor and is not used as final styling evidence; the first list fixture omitted notices, then was corrected to return items before verifying back navigation again. No production writes or external sends occurred. This is local Web component/routing evidence, not native-client or authenticated production/Kylon equivalence. Temporary fixture/server/tab removed.

Worker full run 30731 remains active at this entry, unchanged at 03f73405. No new deployment was pushed over the cancelled 050e458c candidate; corrected rollout still awaits its full regression result.


## 2026-10-24 — workflow origin production release 024494d0

Deploy Worker run 40080421759 / job 120832623426 and Deploy Web run 40080421755 / job 120832623557 completed successfully. The final integrated Worker suite passed 227 files / 1882 tests in 821.16s before migrations and publication. Worker version is 63bb678e-e530-4822-9af6-2754bb1a8b8e; deployed health returned ok with required encryption enabled. Both honmaru-web.pages.dev and app.honmaruai.com served index-Tjpo3J4L.js at 2026-10-24T09:19:27Z. Logs: /tmp/honmaru-024494d0-120832623426.log and /tmp/honmaru-024494d0-120832623557.log.

In-app browser opened the production URL and reached the Japanese welcome page after startup. It has no authenticated session, so this only verifies public boot, not authenticated workflow behavior or Kylon fidelity. Temporary browser tab was closed. Separate CI run 40080421762 remains active in its Worker job; E2E and all other enabled jobs have succeeded. Windows/iOS jobs were skipped, not tested.

This release includes automatic origin capture, durable generation request identities, atomic creation replies with clickable workflow links, workspace-scoped detail routes, source-inherited visibility and execution-time source-authority checks. Simple code remains preserved, and no new paid service was added. Full parity remains unproven; daily/weekly/monthly usage guardrails need per-run attribution (existing ai_calls only records org/user/purpose) before faithful implementation.

Final CI confirmation: run 40080421762 completed success on 2026-10-24. All enabled jobs succeeded; Windows/iOS remained skipped. This confirms CI for production 024494d0, not subsequent usage-attribution work.


## Usage release regression (2026-10-24)

Frozen Worker snapshot 2114e825 passed 228 files / 1885 tests, 663.93s (/tmp/honmaru-workflow-usage-full-worker.log), session 64251 terminal exit 0. Subsequent primary commits only alter Web/docs. Web at 31b91117 passed 165 files / 1123 tests plus TypeScript/build; version/inventory checks passed. Publish this usage-history change separately from the incomplete budget work in codex/app-automations.


## Usage history production confirmation (2026-10-24)

Release 62966a05: Deploy Worker 40082622507, Deploy Web 40082622488 and CI 40082622492 all completed successfully. Worker deployment regression: 228 files / 1885 tests. Web deployment regression: 165 files / 1123 tests. All enabled CI jobs passed; Windows and iOS were skipped, not tested. Worker version 23f9f016-98a9-401e-babc-8b8eef125294. Both production web domains served index-DT8T6-oj.js at 09:57:43 UTC. This release adds recorded provider token usage and elapsed execution time; it does not include the incomplete budget branch.

After the user confirmed the Mac was operable, native app inventory still returned a locked-Mac error. Only the in-app browser was available, with no tabs. Authenticated production UI verification remains unconfirmed; the tool error is not evidence that the user's Mac is actually locked. No further unlock request was made.

## Source-thread filter navigation release preparation (2026-10-24)

Authenticated native CUA access recovered. Inspected Honmaru app gallery previews, custom app details/actions, data viewer and saved personal layout in dark mode. Compared Kylon's live data viewer: Filter > Adjust filters opens the creation thread beside the app. The release implements that navigation through the existing ACL-checked source resolver, carrying an allowlisted data section into the side panel. Missing/inaccessible source falls back to app conversation with the data viewer retained. No message is sent by navigation. Shared views retain a separate direct-edit option; personal views retain direct editing as primary.

This release includes only those Web changes, isolated from the unpublished workflow-budget branch. Local release Web regression passed 165 files / 1126 tests (/tmp/honmaru-source-ui-release-tests.log). Production validation and deployment results will be recorded separately. Current changes do not establish complete Kylon parity or cross-device persistence verification.

## Source navigation production deployment and native verification (2026-10-24)

Published deedd61a via Deploy Web 40090321552 / job 120861490259 (success). Deployment logs confirm app.honmaruai.com and honmaru-web.pages.dev both serve index-CmmdbpvL.js; deployed preview is https://2161f51c.honmaru-web.pages.dev. Public IAB boot rendered the signed-out landing screen. CI 40090321810 was still running Worker/E2E at the last observation; completed jobs passed, Windows/iOS skipped.

Native Honmaru initially became visually blank after Reload/Force Reload. Local bounded diagnostics recorded HTTP 200, policy-error, layout-state 63 and inspect-visible despite the blank screenshot. A full UI quit/relaunch restored the saved login/workspace; no settings/data were deleted. Root cause remains unproven and must not be described as fixed.

On the updated authenticated app, selected the shared test view and verified Filter exposes both Adjust filters and direct edit. Adjust filters navigated through source=1&section=data, then (because the test app has no linked source) to section=data&chat=1. Screenshot/AX confirmed app conversation alongside the data viewer, not the custom app overview. No messages/model calls were made. Closed chat and restored the original personal view with task-name width 320. This proves the missing-source fallback only; the linked native-thread case still requires live verification.

## macOS reload repaint experiment (2026-10-24)

Reproduced native blank content after reload with DOM still present. Rebinding CUA did not restore it; toggling macOS full screen restored both AX content and visible pixels, and returning to ordinary mode retained them. Installed Electron framework is 44.9.3. Related upstream https://releases.electronjs.org/pr/52844 describes a hidden-view/background-throttling surface problem but is already included in this version; it is not proof of this root cause.

Added a macOS-only webContents.invalidate() on did-finish-load to request a full repaint without geometry changes or another reload. API confirmed in installed Electron typings (and https://github.com/electron/electron/blob/main/docs/api/web-contents.md). Desktop 17 files / 125 tests passed, dist:dir succeeded (/tmp/honmaru-reload-repaint-tests.log, -build.log). Launched the exact local dist/mac-arm64/Honmaru AI.app via CUA; normal and forced reload both retained AX content, and screenshot confirmed the normal-reload rendered screen. Limited successful reproduction testing, not proof all compositor failures are resolved.

Updating /Applications/Honmaru AI.app was refused by macOS (Operation not permitted). Original installed app.asar and backup /tmp/honmaru-before-repaint-20261024.app both remain SHA256 1d2095e42c42c86cfab85771b1cc475e70e1b5d65237266222ca17d72e44a603; tested build hash is be310c2980b288b4f74f7f73f950a3c763c74bc3ed4486023b6488e5396b476d. Existing installed app relaunched afterward. Local fix is not installed and no signed desktop release has been published.

## Contextual filter/group adjustment draft (2026-10-24)

Authenticated Kylon group adjustment was observed inserting an unsent draft naming app/table/view in the source thread. The inserted test draft was cleared without sending. Honmaru now routes shared group adjustment like filter adjustment and carries bounded (1000-character) plain-text draft context through source and missing-source fallback routes. Existing source-thread draft text takes precedence over a suggested draft. The app-conversation fallback seeds only its initial draft; refresh does not overwrite user edits. No automatic message sending/model call. Direct editors and personal-view behavior remain available.

Web 165 files / 1129 tests passed (/tmp/honmaru-adjustment-context-full-web.log), including Unicode/query delimiter round-trip, oversized route draft rejection, group routing/direct editor, and unsent fallback draft preservation during refresh. TypeScript/build passed (/tmp/honmaru-context-draft-build.log). Live validation and deployment pending. This does not implement general persistent drafts for detached app conversations across unmounts; do not claim that broader capability.

## Context draft production verification (2026-10-24)

Deploy Web 40091123260 / job 120863833075 succeeded for 8cec22b0. Native authenticated test app shared view exposed Group adjustment and direct group editing. Adjustment traversed source route to the missing-source fallback and displayed the exact app/table/view-named group instruction in the unsent composer alongside the data viewer; screenshot inspected. No message was sent. Cleared the generated draft, closed chat, restored the prior personal view and returned to gallery. Linked-source path still not live-verified. CI 40091123237 was in progress.

Observed remaining issue: fallback retains draft in URL after seeding the composer, so reopening/reloading can restore an instruction the user cleared. Consume the seed once and remove it from the current matching hash after initialization. General app-conversation draft preservation across unmounts remains separate work. Installed old desktop still exhibits reload blanking, recovered by full-screen toggle for this test; repaint fix is source/local-build only.

## One-shot adjustment draft consumption (2026-10-24)

The missing-source composer now acknowledges its initial suggestion. AppView marks it consumed for later panel reopen and removes draft from the current matching app-conversation hash, retaining data/chat parameters and notifying the router. The hash helper refuses other apps/orgs/drafts and source navigation routes. Existing edited composer text survives removal of the prop. No message is sent. Full Web passed 165 files / 1131 tests; final router notification addition passed build and the related route/conversation/app suites (/tmp/honmaru-consume-draft-tests.log, -final-build.log, -final-tests.log). Live confirmation of clear/close/reopen still pending.

## One-shot draft production verification (2026-10-24)

Deploy Web 40091492120 / job 120864914485 succeeded for a1357a7a. Logs verify both public hosts serve index-AXNY97Ts.js (preview https://92981157.honmaru-web.pages.dev). Native authenticated UI: shared test view > group adjustment seeded the expected context; resulting hash was section=data&chat=1 without draft. Cleared the composer, closed it, reopened it, and checked after conversation loading: composer remained empty and send disabled. Screenshot/AX inspected. No messages sent. Restored prior personal view. Linked-source live case remains separate/unverified.

CI 40091492136 latest snapshot: desktop, web, relay, gateway, shared core/mobile success; Worker and E2E still running; Windows/iOS skipped. Installed desktop happened to reload normally in this pass, so the blanking issue is intermittent; local repaint test success should not be overstated as an exhaustive fix.

## Linked-source browser regression coverage added (2026-10-24)

Added e2e/app-source-navigation.mjs to the existing real-stack CI spec. It refuses non-loopback API hosts, creates a private fixture room and model-free generated app with captured source, opens adjustment through the UI, requires both the original thread and data toolbar, checks contextual draft, then revisits and requires the pre-existing unsent draft to survive. Before/after source-message IDs/bodies must match, proving navigation did not post. Captures app-source-adjustment.png and restores workspace mode. This is disposable local CI data, not production messages. JavaScript syntax checks passed; the new browser regression has not run yet, so it is not completion evidence.

### 2026-10-24 — App and record draft persistence (local verification)

- Added local unsent-text persistence scoped to API origin, account, workspace, app, table and record. The captured account/session must still match before storage reads/writes; credentials are not included in stored keys. Storage failures leave the editor usable.
- Restored text takes priority over adjustment suggestions. Sending failures retain it; successful sends remove it. Screen closure/reopening and switching records retain independent drafts.
- Local Web suite: 166 files / 1,134 tests passed; TypeScript and production build passed. Added model-free local E2E fixture for reload restoration and no automatic posting; that new fixture has not run yet.
- This does not synchronize drafts between devices. Current CI for 5bd0081c was still running Worker and E2E at verification time; retain that run rather than cancelling it with another push. Production deployment of this draft change remains pending.

- Follow-up: included `hx-app-draft:` in account-data cleanup, so logout and expired-session cleanup also remove these new drafts. Account cleanup plus draft/conversation regression tests: 3 files / 19 tests passed; production build passed. Not yet deployed.

### 2026-10-24 — Source navigation E2E failure investigation

- CI 40091937164 E2E job 120866335391 failed only the new source-navigation step: waiting for `.slk-thread-pane .slk-composer textarea` exceeded 20 seconds. Worker was still running; this is not an overall pass.
- The fixture changes workspace mode and creates a private room via API after the page has mounted. Added a reload before UI navigation so mode/sidebar data are read again. This is a test-setup hypothesis, not a confirmed product fix; rerun is required.
- Added failure screenshot capture from the fixture's own page before closing it, improving evidence for any remaining failure. Node syntax and diff checks passed.
- Kylon empty test table was observed cycling task-name sort through ascending, descending, and none; restored none. Existing Honmaru `nextColumnSort` header path already implements that cycle. No message or record was created in Kylon.

### 2026-10-24 — Draft persistence production verification

- Deploy Web 40092758483 / job 120868651145 succeeded for f1121b9e. Both app.honmaruai.com and honmaru-web.pages.dev served `index-B9GKy666.js`; preview https://2fa5104a.honmaru-web.pages.dev.
- Authenticated installed Mac app, existing empty UI確認用タスク: entered a harmless unsent draft, closed/reopened the app conversation, and reloaded the page. Both restored the exact text. Empty message history remained visible. Cleared the test draft and closed the panel; no message was sent and no record was added. Screenshot of restored text: `/tmp/honmaru-app-draft-production.png`.
- First reload reproduced the installed desktop's intermittent blank rendering; toggling fullscreen and back restored it. The later reload worked normally. The previously tested native repaint patch still has not been installed in /Applications, so this defect remains open.
- CI 40092758479: Web, desktop, gateway, relay and shared/mobile successful at observation; Worker and E2E still in progress. Linked-source E2E outcome remains unverified.

### 2026-10-24 — Signed desktop update preparation

- Repository signing-secret name inventory includes all five required Mac signing/notarization settings (values not read or printed). Prior Mac signed release workflow 39957249737 succeeded; published release is v1.3.13. This provides an existing distribution path without a new service subscription.
- Prepared version 1.3.14 consistently across VERSION, desktop/web/mobile manifests and native marketing versions. Dependency versions unchanged. Version checker passed, desktop 17 files / 125 tests passed, mobile lint and typecheck passed.
- Native repaint code from edf07ece is included. No signed v1.3.14 build has been dispatched or published yet; installed app remains unchanged. Current f1121b9e CI still running; avoid cancelling it with a new main push.

### 2026-10-24 — Typed workflow condition foundation

- Added `workflowConditions.js`: declarative all/any/not, strict scalar equality and numeric ordering, text containment, list membership and explicit existence checks. Missing/null/type mismatches remain distinct; paths use own properties only and reject prototype keys. Definitions have explicit depth, node, group, path and literal bounds and normalize to independent copies.
- Worker runtime tests: 1 file / 4 tests passed, covering composition, normalization isolation, missing/null/false/zero, coercion refusal, inherited-property refusal and invalid/excessive predicates.
- This is a foundation only: not connected to workflow execution/editor, not deployed, no durable decision checkpoint yet. KY-059/KY-060 remain incomplete. Signed desktop build 40093136992 uses 8f9c791f, before this code, and remains independent.

### 2026-10-24 — Durable node checkpoint foundation

- Added internal D1 node checkpoints with atomic competing claims, attempt/owner fencing, bounded leases, immutable completed results and definition fingerprint conflicts. Expired pure nodes can be reclaimed; expired external-effect nodes become `unknown` and cannot be automatically replayed. Current run status fences renewal and completion.
- Real Worker/D1 tests: 1 file / 5 tests passed for competing claims, stale owners, renewal, expiry ambiguity, cross-workspace denial, definition conflicts, terminal runs and oversized results. Schema and additive migration supplied, not deployed.
- Not yet connected to `continueRun`; local-effect transaction integration, reconciliation UI, durable graph scheduler and approval/batch continuation remain outstanding. No exactly-once guarantee is claimed.
- E2E job 120868651352 of CI 40092758479 failed again, this time clicking the filter button (not the original thread-pane wait). Screenshot artifact investigation is in progress; Worker remains running.

### 2026-10-24 — Signed 1.3.14 published and installed

- Mac signed workflow 40093136992 / job 120869764348 succeeded at 8f9c791f. Signing, notarization, codesign deep/strict validation, Gatekeeper acceptance and update-feed checks passed. Desktop delta from released 1.3.13 is the did-finish-load repaint request plus version metadata.
- Published release 422712245, https://github.com/Torutesu/HonmaruAI/releases/tag/v1.3.14 at 2026-10-24T12:22:49Z. Used the installed app's Check for Updates and Restart and Update controls. No manual /Applications overwrite or protection bypass.
- Installed Info.plist and native menu both report 1.3.14. Installed codesign validation and spctl assessment passed (`Notarized Developer ID`). Login/workspace retained, app gallery and custom app detail loaded, and a normal reload restored the custom detail without fullscreen workaround. Initial launch briefly showed the loading-timeout fallback before resolving; a single successful reload does not prove elimination of an intermittent defect.
- Screenshot: `/tmp/honmaru-1.3.14-installed.png`. Source-navigation diagnostics alone were pushed to `codex/source-navigation-diagnostics` (3769b46d), CI 40093649099, so experimental workflow foundations are not published. Primary working branch restored to codex/skill-folder-drop-ui.

### 2026-10-24 — Native board filter cross-check

- On installed 1.3.14 / production Web, opened existing empty UI確認用タスク, switched to 状態別カンバン and opened the filter popover successfully. Both adjustment and direct-edit actions appeared. Screenshot `/tmp/honmaru-board-filter-production.png`.
- The active-view save remounts the filter control after the personal preference revision changes; retried only after observing the new accessibility target. This does not yet establish the cause of the CI actionability timeout. No filter or record was changed; restored 自分のタスク and confirmed saved column widths (180/320/180/180).
- Diagnostic CI 40093649099 / E2E 120871291797 remained running at observation. Do not infer its outcome from this native test.

### 2026-10-24 — App section route restoration

- Native verification exposed that choosing Data viewer through the app menu only updated component state; reloading the standalone custom app returned to its published UI. Added allowed app-section routes for overview/data/custom/backend/settings and routed menu, breadcrumb and section-tab selections through them.
- Standalone routes retain conversation, record and draft parameters. Embedded panels and source-thread routes do not overwrite the chat URL. Unknown sections remain rejected. Existing access checks for editing/backend remain unchanged.
- Web suite: 166 files / 1,135 tests passed; TypeScript and production build passed. Not deployed yet; native reload verification of this change remains pending. This is independent of the CI filter click interception investigation.

### 2026-10-24 — Isolated app section production rollout

- Published main commit `2b98dc5c` containing only the tested standalone app-section restoration and synchronized 1.3.14 version metadata. Experimental workflow predicates/checkpoint storage and migrations remain unpublished on the working branch.
- Deploy Web `40095102010` and CI `40095102163` were running at this observation; Web, Desktop, Gateway and Relay jobs passed. This entry is not a deployment-success assertion.
- Native CUA is available after the user confirmed their Mac is operable. Existing empty test app retained its personal view and 180/320/180/180 column widths; filter popover opened and closed normally. No records, filters or messages were changed.

### 2026-10-24 — App section rollout verified; remaining native defect

- Deploy Web `40095102010` / job `120875575649` succeeded for `2b98dc5c`. Both production hostnames serve `index-BV3CHoAt.js`; preview `https://f27efaea.honmaru-web.pages.dev`.
- Native test: selected Data viewer through the app menu, observed `section=data` in the URL, reloaded and confirmed Data viewer, personal view 自分のタスク and widths 180/320/180/180 restored. Screenshot `/tmp/honmaru-app-section-production.png`.
- A preceding reload on Mac 1.3.14 produced a blank native surface, recovered by entering/exiting OS fullscreen. Thus 1.3.14's did-finish-load invalidation is insufficient to claim resolution. Subsequent reload succeeded; intermittent rendering remains open. No data cleared or security settings changed.
- Local Worker foundation suite finished: 230 files / 1,894 tests passed, 1030.95s; log `/tmp/honmaru-workflow-foundation-full-worker.log`. Foundations are still unpublished and not connected to the executor.
- Diagnostic E2E `40094411272` / job `120873660901` failed on navigation 2. Hit-test data shows duplicate controls: the retained source pane behind the foreground standalone app. Fixed locators to `.shell > .hx-app-detail` without force-click or bypassing assertions; published only that test correction and diagnostics as `be16d549`. CI `40095296928` is pending; no E2E success claimed.

### 2026-10-24 — Covered conversation accessibility and floating app gap

- Covered ClassicList remained in the accessibility tree behind a standalone app. Added a React 18-compatible DOM ref that toggles native inert while the shell marks the list inactive, preserving mounted drafts. E2E additionally checks a retained source composer cannot accept focus behind the app and becomes interactive on return. Web 166 files / 1,135 tests and production build passed; E2E and publication pending.
- Reference Kylon app menu contains Share, Copy link, floating display and navigation pin. Opened floating display on the existing empty test app, observed a bottom-right approximately 480×640 panel with app chat, fullscreen and close. Screenshot `/tmp/kylon-floating-app-reference.png`; closed it without record/message changes. Added KY-096 as missing, bringing the inventory to 96. Drag, resize and persistence behavior still need reference verification.
- Electron upstream issue https://github.com/electron/electron/issues/52809 describes blank native surfaces restored by resizing despite invalidate, but its background-throttling toggle condition differs from Honmaru (constant false). Similarity is not proof of identical root cause; no security/GPU switch or speculative downgrade was applied.

### 2026-10-24 — Floating app implementation awaiting browser acceptance

- Implemented workspace-owned floating apps (initial 480×640, viewport-clamped), pointer drag/resize, arrow-key movement and Shift-arrow sizing, section-aware return to standalone view, and credential/workspace/Simple transition clearing. Floating UI remains separate from the mounted conversation. Entry appears on overview/data; unsaved editor/backend/settings forms are not moved. No record/model API is called by the display action itself.
- Tests cover bounds on desktop/phone/display change, keeping the conversation component mounted, keyboard movement, restoring the current app section, and workspace/session/Simple clearing. Web 168 files / 1,139 tests and production build passed (`/tmp/honmaru-floating-full-tests.log`, `/tmp/honmaru-floating-build.log`).
- Added CI browser acceptance for opening through the app menu, keyboard movement, keeping the app across workspace-screen navigation, shrinking viewport and closing. Isolated UI branch `codex/floating-app-ui` at `624fb061`, CI `40096210006`, Worker job `120878904365`, E2E job `120878904399`; queued/running at observation. Not deployed; no screenshot/native success claim.
- Main `be16d549` E2E job `120876409224` succeeded after foreground scoping; Worker was still running. Covered-conversation-only branch `0973ace8` CI `40095849691` is also running.

### 2026-10-24 — Floating activation validation follow-up

- Main CI `40095296928` at `be16d549` completed successfully, including Worker and source-navigation E2E.
- Covered-conversation E2E `120877832824` failed at the immediate navigation-2 interaction assertion, after finding the still-mounted old thread before source route resolution completed. Updated the regression to wait for the standalone screen to detach and ClassicList inert to clear before validating source interaction; no force-click or assertion bypass.
- Floating app controls now become inert beneath shell dialogs/search/shortcuts while retaining their section and geometry; the resize handle is hidden in fullscreen. Targeted suite: 2 files / 5 tests passed; TypeScript/build passed (`/tmp/honmaru-floating-interaction-tests.log`, `/tmp/honmaru-floating-interaction-build.log`).
- Updated isolated branch to `70bbe1a8`; CI `40096641038` pending while prior `40096210006` remained live. Not deployed; native floating acceptance remains pending.
- Rechecked reference floating menu: Share, Copy link, navigation pin. Attempted pointer drag returned CUA noWindowsAvailable, so reference dragging remains unverified. AX/menu operations still worked; closed the reference floating panel and left existing records/messages unchanged.
- npm registry reports 45.0.0 latest and 44.9.3 latest 44.x. Official 45.0.0 notes list the similar hidden-window/background-throttling fix as also backported to 44 (#52863), not a 45-only remedy. No runtime upgrade was made on this evidence. Source: https://github.com/electron/electron/releases/tag/v45.0.0 .

### 2026-10-24 — Compact floating toolbar candidate

- Reference floating app uses icon-only new-record/filter/group/field actions at its narrow width. Added a container-scoped compact toolbar, leaving normal app screens unchanged. Record search remains available via a labeled expandable search button. The container is the toolbar, not the floating window, to avoid changing the fullscreen element's containing block.
- Web 168 files / 1,140 tests and build passed (`/tmp/honmaru-floating-compact-tests.log`, `/tmp/honmaru-floating-compact-build.log`). Added browser coverage for opening, entering and clearing floating record search before shrinking the viewport and closing.
- Isolated candidate `e364b7ee` on `codex/floating-app-compact`, CI `40096922652`, E2E `120881012988`, Worker `120881013033`, all live at observation. Base candidate `70bbe1a8`, CI `40096641038`, E2E `120880294831`, Worker `120880295160` remains live; did not restart it merely because it was still running. No floating production deployment yet.

### 2026-10-24 — Floating baseline browser acceptance passed

- `70bbe1a8` E2E `120880294831` (run `40096641038`) succeeded. Report confirms source navigation/draft preservation and the appended floating open, keyboard move, screen-navigation retention, viewport clamp and close checks passed. Worker remained live at the last poll.
- Downloaded and inspected `/tmp/honmaru-e2e-40096641038/app-floating.png`: floating app remains inside the 700×600 viewport with reachable header controls. Baseline toolbar is still text-heavy; compact candidate addresses it and remains unverified. Other artifacts: app-draft-restored.png and app-source-adjustment.png.
- Added pointer drag/resize acceptance using a hit-tested, noninteractive visible header region and resize handle. No force-click. Isolated candidate `1df56f7b` (`codex/floating-app-pointer`), CI `40097466835`, jobs `120882610467` and `120882610518` live. Compact predecessor `e364b7ee` CI `40096922652` also live. No floating production deployment yet.

### 2026-10-24 — Compact browser acceptance and final frame candidate

- Compact candidate `e364b7ee` E2E `120881012988` succeeded. Inspected `/tmp/honmaru-e2e-40096922652/app-floating.png`: narrow toolbar uses labeled icon controls and expandable search; header remains reachable. The screenshot exposed an inherited green canvas and duplicate inner frame.
- Scoped the floating panel to theme surface tokens and a single frame, with a compact back control. Production build passed (`/tmp/honmaru-floating-neutral-build.log`); no broader app styling changed. Isolated final candidate `89ca9b78`, CI `40098027193`, contains only previously reviewed UI/E2E changes and the five-line frame correction; experimental Worker foundations are excluded.
- Baseline CI `40096641038` completed successfully, including Worker. Pointer candidate `40097466835` remains in progress; no pointer acceptance or production floating deployment claimed yet.
- User confirmed the Mac is operable. Native observation nevertheless returned locked; did not repeat the unlock request. IAB can load the production sign-in landing page but is unauthenticated, so it cannot establish signed-in native acceptance.

### 2026-10-24 — Pointer resize defect found and corrected

- Pointer E2E `120882610518` failed: header dragging passed, but resize did not change dimensions. The app surface has z-index 35 while its sibling resize handle used auto stacking, placing the handle behind the surface. Set the handle to z-index 36 (still inside the floating root stacking context); fullscreen continues hiding it.
- Added a center-point hit-test assertion before real pointer resize, without forced clicks. Syntax/diff checks and production build passed (`/tmp/honmaru-floating-resize-build.log`).
- Isolated corrected release candidate `0a35e031`, CI `40098208292`, replaces `89ca9b78` on the release branch. No production floating release yet; exact-candidate E2E and native acceptance remain pending.

### 2026-10-24 — Floating appearance acceptance coverage

- Added actual-browser checks for fullscreen viewport coverage, hidden resize handle while fullscreen, restored geometry after exit, system dark surface response and header-icon contrast of at least 3:1. Captures `app-floating-dark.png`. Syntax and diff checks passed; runtime acceptance is not yet established.
- Test-only isolated candidate `c4a23fad`, CI `40098460056`, is based on corrected release `0a35e031`. No production UI changes beyond that release candidate. Kept existing release CI `40098208292` running; its Worker `120884850915` and E2E `120884850923` were revalidated live.

### 2026-10-24 — Corrected pointer acceptance passed

- Release candidate `0a35e031` E2E `120884850923` completed successfully. Real pointer drag and resize, hit-test reachability, compact search, source/draft navigation, viewport clamping and close checks passed.
- Inspected `/tmp/honmaru-e2e-40098208292/app-floating.png`: neutral single frame, compact header controls and visible bottom-right resize handle. Downloaded report and source/draft screenshots alongside it.
- Worker job `120884850915` remains live. Worker tree hash is identical to the successful baseline `70bbe1a8` (`394461faba418be498f89f1762692ea85e8e3e55`); no Worker changes are in this candidate. Appearance/fullscreen E2E `120885526052` remains live; production is still `be16d549` (Web from `2b98dc5c`). Native CUA still reports locked despite the user's unlocked state; did not repeat an unlock request.

### 2026-10-24 — Floating appearance passed; production rollout started

- Appearance E2E `120885526052` (run `40098460056`, `c4a23fad`) succeeded, including actual pointer movement/resizing, fullscreen bounds and geometry restoration, dark surface and header-icon contrast. Inspected `/tmp/honmaru-e2e-40098460056/app-floating-dark.png`: dark frame, toolbar and icons remain readable without a white inner canvas.
- Fast-forwarded remote main from `be16d549` to `c4a23fad`. Web deployment `40099242847` / job `120887790982` is live; matching main CI `40099242855` is live. Production completion is not yet claimed. Worker retests remain running; its unchanged tree matches the fully successful baseline, and the deployment retains its Worker dependency gate.

### 2026-10-24 — Floating UI deployed

- Deploy Web `40099242847` / job `120887790982` succeeded at main `c4a23fad`. Preview https://e9e5d002.honmaru-web.pages.dev ; deployment verified both public hostnames serve `index-LTBSxNFZ.js`. Independent local curl of https://app.honmaruai.com/ confirmed the same asset (urllib received 403; curl succeeded).
- Corrected release CI `40098208292` Worker also succeeded; all its required jobs passed. Appearance E2E passed; its redundant Worker and main CI remain live. No new paid service was created, and Simple remains separate. Native signed-in acceptance remains unverified because CUA still reports the Mac locked despite the user's confirmation.

### 2026-10-24 — Preserve floating chat during section navigation

- Found that FloatingAppWorkspace passed its updated current section back as AppView.initialSection. Since AppView's loading callback depends on that input, section changes reran the initialization effect and closed/reset conversation state. Store the initial section separately from the current docking section.
- Focused 2 files / 5 tests and build passed (`/tmp/honmaru-floating-section-tests.log`, `/tmp/honmaru-floating-section-build.log`). Added actual-browser coverage keeping a draft while switching overview/data and then clearing it without posting.
- Isolated candidate `da873700`, CI `40099503526`, is live on codex/floating-app-conversation. Not yet deployed. Production remains c4a23fad, whose Deploy Web succeeded; main CI continues.

### 2026-10-24 — Floating conversation containment

- Found the mobile app-chat CSS used viewport-fixed positioning, so a conversation inside a floating app could cover unrelated workspace content. Desktop-width windows also used a 300px chat grid inside a 480px panel. Added a panel-width marker and contained overlay for narrow floating panels; wide/fullscreen layouts retain their existing split behavior, with the mobile fullscreen overlay contained in its body.
- Focused tests (2 files / 5 tests) and build passed (`/tmp/honmaru-floating-chat-bounds-tests.log`, `/tmp/honmaru-floating-chat-bounds-build.log`). E2E now asserts chat bounds and captures narrow/desktop screenshots while retaining an unsent draft across section changes.
- Isolated candidate `c56117fd`, CI `40099663595`, is queued. Previous section-state candidate CI `40099503526` remains live and was not restarted. Production c4a23fad deployment remains successful, main CI `40099242855` still live.

### 2026-10-24 — Main floating release E2E passed

- Main `c4a23fad` CI `40099242855` E2E `120887791175` completed successfully. This independently reran the same deployed floating pointer/fullscreen/dark/source-draft acceptance; Worker `120887791164` remains live.
- Additional chat-state candidate `40099503526` and containment candidate `40099663595` were revalidated running. Their production rollout remains pending; existing successful deployment is unchanged.

### 2026-10-24 — Floating chat menu stacking regression

- Section-state E2E `120888547416` (run `40099503526`) failed at selecting the overview menu item: chat message content intercepted the pointer. The header establishes stacking level 5, while chat used 160 (and the first containment patch used 40), so the nested menu could not rise above the sibling chat.
- Lowered only floating chat overlays to level 4, beneath the existing header but above body content. Kept normal pointer acceptance; no force-click or assertion removal. Build passed (`/tmp/honmaru-floating-chat-layer-build.log`).
- Updated bounds branch from `c56117fd` to `99673f54`; new CI `40100257163` is pending. Earlier run `40099663595` was still live at observation and may be cancelled by workflow concurrency. This supersession fixes an evidenced defect, not an observation timeout. No additional production deployment yet.

### 2026-10-24 — Atomic local workflow checkpoint commits

- Added an internal D1 batch primitive to commit local effects together with their immutable completion result. A deliberate status-CHECK fence aborts the whole transaction for missing/wrong/expired/pure/terminal claims; a zero-row UPDATE alone would not roll back later statements. Any effect statement error also rolls back completion and earlier writes.
- Real workerd/D1 suite: 1 file / 8 tests passed (`/tmp/honmaru-checkpoint-atomic-tests.log`), including simultaneous commits using the same lease (only one effect), failed-effect rollback, stale ownership/expiry, cross-org and terminal-run fencing.
- This remains unpublished foundation code. Callers must still bind current resource ACLs in effect statements; lease ownership is not authorization. Existing local-effect services must be integrated, external-effect reconciliation and graph scheduling remain incomplete. No runtime durability or exactly-once external-effect claim.
- Main c4a23fad CI `40099242855` completed all required jobs successfully, including Worker. Floating chat candidate CI `40100257163` was revalidated live.

### 2026-10-24 — Conditional steps with persisted decisions

- Connected optional declarative `when` predicates to workflow definition normalization and execution. Unmatched steps record `skipped` without performing their effect; step numbering remains stable. Decisions use pure node checkpoints fingerprinted from normalized conditions and are committed before the executor follows them. Replays retain the original boolean and reject definition drift. Current automation/source authorization is rechecked after a matching checkpoint before the effect.
- Five real Worker suites / 77 tests passed (`/tmp/honmaru-conditional-runtime-tests.log`): predicates, checkpoint concurrency/replay, existing workflows, safety stops and creation. The integration test creates complementary conditions, confirms only the matching message exists, and reads both durable decisions.
- Unpublished on primary working branch. Requires additive checkpoint migration and broader regression before deployment. Condition editing/generation UI, full branch/batch/parallel graphs, local-effect service integration, external-effect reconciliation and recovery scheduling are still incomplete. This does not establish general durable execution.

### 2026-10-24 — Floating conversation corrections deployed

- Candidate `99673f54` E2E `120890920284` succeeded. Inspected narrow and desktop screenshots under `/tmp/honmaru-e2e-40100257163/`: conversation remains inside the app, composer and header stay reachable. Test also switches sections via normal menu clicks and preserves the unsent draft without posting.
- Promoted isolated candidate to main. Deploy Web `40101126064` / job `120893313510` succeeded; preview https://05c9c77c.honmaru-web.pages.dev . Deployment verified both public hostnames, and independent curl confirmed app.honmaruai.com serves `index-C1RRr81p.js`. Main CI `40101126065` remains live. No workflow foundation/editor code was included.

### 2026-10-24 — Typed condition editor and broad regression

- Added an optional condition editor to existing step editing: input/row/before/step sources, typed scalar comparisons, typed candidate lists, all/any/not groups, and bounded nesting/size. Changing action type retains its execution condition while discarding obsolete action fields. Empty numeric input stays empty, not silently converted to zero.
- Focused UI 3 files / 13 tests and TypeScript/build passed. Full Web 169 files / 1,144 tests passed (`/tmp/honmaru-conditional-full-web.log`). Worker full regression is live in session `39690`, log `/tmp/honmaru-conditional-full-worker.log`, frozen Worker tree `c7d8b95233053f28c4f58a6142d210502de1f3ab`; do not restart while live.
- Condition editor and Worker runtime remain unpublished. Real rendered condition-editor acceptance, generation guidance, complete recovery/branch graphs and external-effect reconciliation remain outstanding.

### 2026-10-24 — Conditional workflow browser acceptance candidate

- Workflow details now show readable typed conditions, including nested all/any/not and the difference between null and absent properties. Focused UI 3 files / 6 tests and build passed (`/tmp/honmaru-condition-review-tests.log`, `/tmp/honmaru-condition-review-build.log`).
- Added local-only, model-free E2E: create a private fixture room; build a two-clause condition via the actual UI; save; verify typed API persistence; reload details; confirm readable predicates; execute an unmatched input and assert skipped status with no room message changes. Captures editor/detail/failure screenshots.
- Isolated candidate `e6890d2c` on codex/workflow-conditions, CI `40101607430`, includes only condition runtime/editor/tests and the additive checkpoint table. No production rollout yet. Existing full Worker regression session `39690` remains live with unchanged Worker tree.

## Native production acceptance and compact focus follow-up (2026-10-24)

Production `99673f54` / `index-C1RRr81p.js` was checked in the signed-in Honmaru AI 1.3.14 native app after reload. The empty UI test app retained its personal data view and column widths when floating, changing between app and data sections with chat open, closing chat, moving by pointer, resizing from 480×640 to 600×700, and returning to the standalone data view. No messages or records were created. Screenshots: `/tmp/honmaru-floating-chat-production-native.png` and `/tmp/honmaru-floating-resized-production-native.png`. Native control recovered; the earlier capture blocker no longer applies. This does not establish restart persistence or complete Kylon parity.

Production main CI `40101126065` browser E2E passed; Worker was still running at this check. Deploy Web `40101126064` succeeded. Follow-up `5f8624c3` makes covered compact app content inert and hides the breadcrumb in narrow floating headers. Local build and syntax/diff checks passed; isolated candidate `c1e81790949bd0e7f2d4f00b235e361200bd4e60` on `codex/floating-chat-focus` excludes unpublished workflow changes and awaits CI. It is not yet production. Conditional workflow candidate `e6890d2c` CI `40101607430` remained in progress.

## Conditional workflow editor CI follow-up (2026-10-24)

Candidate e6890d2c E2E job 120894750480 failed waiting for Save workflow. Both workflow-condition-editor.png and workflow-condition-failure.png in `/tmp/honmaru-e2e-40101607430` showed that the builder had disappeared, first replaced by loading and then the empty workflow list. The floating provider's Dashboard key included asynchronously discovered workspaceMode, remounting all descendants when that value changed. Commit 84ed19b9 removes only the mode from that key; organization/credential boundaries remain keyed and the provider itself still clears floating state on mode changes. Its focused 4 tests and web build passed. Browser acceptance remains pending, not claimed fixed solely from unit tests.

Commit b9d16efe adds a real-column selector for current/previous record predicates, including nested groups, storing stable column IDs. Focused 4 tests and web build passed. Candidate d03d3ba7ee8f6c24b8a1bcc2617c066eb169bbad on codex/workflow-conditions includes these corrections and has been pushed for repeat browser acceptance; no production promotion occurred. Worker source is unchanged while full local Worker session 39690 remains live.

## Natural-language workflow conditions (2026-10-24)

The full frozen Worker tree c7d8b95233053f28c4f58a6142d210502de1f3ab completed successfully: 230 files / 1,899 tests, log `/tmp/honmaru-conditional-full-worker.log`, session 39690 terminal exit 0. Production 99673f54 main CI 40101126065 completed successfully for every required job (optional Windows/iOS skipped).

The workflow generation prompt now describes typed step conditions, exact input/row/before/previous-step paths, stable column IDs, missing-value behavior and the actual per-step skip semantics. Model-free generation tests verify persisted typed conditions, paused creation, unmatched execution with no extra message, and rejection of malformed numeric predicates. Focused creation/condition tests: 2 files / 18 passed (`/tmp/honmaru-generated-conditions-tests.log`). This is not evidence of real-model reliability or general branch/parallel support. Generation changes have not yet been included in a release candidate or production. d03d3ba7 candidate CI 40102575042 and floating focus c1e81790 CI 40102273418 were still running at this check.

## Condition reference validation (2026-10-24)

Commit a0a988c7 rejects condition references to the same or a future step, zero/negative/fractional/leading-zero/non-numeric step numbers, recursively through all/any/not. Earlier one-based steps remain supported. This prevents an absent future output from silently selecting a branch (including exists:false). Focused workflow and creation tests passed: 2 files / 63 tests (`/tmp/honmaru-condition-references-tests.log`). This change and natural-language prompt commit 41bbcd19 remain outside the currently running d03d3ba7 candidate. Existing candidate CI handles were revalidated live rather than restarted.

## Integrated conditional workflow candidate (2026-10-24)

Prepared and pushed codex/workflow-conditions-final at 0b4d7e42a27b767934620600abd58e9bfcdf2e76, parent d03d3ba7. This combines typed natural-language conditions, step-reference validation, localized skipped history, current column names in saved condition descriptions, and compact floating focus handling. No unrelated documentation or budget work is included. Primary web suite passed: 169 files / 1,148 tests (`/tmp/honmaru-conditional-final-web.log`); build passed after the display changes. Candidate browser coverage additionally checks skipped history after reload. The two earlier CI handles 40102575042 and 40102273418 were confirmed running and were not restarted or cancelled. This integrated candidate has not been deployed.

## Floating reference comparison and focus acceptance (2026-10-24)

Kylon native inspection recovered and its floating chat control was exercised without sending a message. The observed URL briefly changed to `/threads/pending/app/35a852ca0267`, with a thread-loading state behind the floating app, before returning to the source thread; a successful completed app-chat layout was not established. Reference screenshot `/tmp/kylon-floating-chat-comparison.png` retains the source thread and 480×640 floating data viewer. This is evidence of a possible navigation/layout difference from Honmaru's contained conversation, not proof of fidelity. Do not declare floating chat parity complete.

Floating-focus candidate c1e81790 browser job 120896691758 (CI 40102273418) completed successfully, covering covered-content focus prevention, chat section transitions, drag/resize/fullscreen and dark appearance. Its Worker job and both conditional-workflow candidate CIs were still running at this check.

## Conditional workflow browser acceptance (2026-10-24)

Candidate d03d3ba7 E2E job 120897730745 (CI 40102575042) passed after removing workspace-mode remounts. Downloaded and visually inspected `/tmp/honmaru-e2e-40102575042/workflow-condition-editor.png` and `workflow-condition-detail.png`: typed amount >=100 and currency JPY conditions persist and are readable after reload; the model-free fixture also verifies unmatched execution creates no message. The editor currently stacks full-width controls and occupies excessive vertical space; compact grouped condition layout remains a UI quality gap. The labels are Japanese even under the English fixture locale, another remaining localization gap. This pass does not cover subsequent generation/reference/history additions in 0b4d7e42, whose CI 40103229488 remains live. Worker jobs on both earlier candidates were also still live.

## Floating focus promotion and condition layout (2026-10-24)

Floating candidate c1e81790949bd0e7f2d4f00b235e361200bd4e60 completed every required job in CI 40102273418; optional iOS/Windows jobs skipped. Fast-forwarded origin/main from 99673f54 to c1e81790, initiating production Deploy Web. Deployment completion and public asset verification remain pending. This promotes only compact header/focus corrections, not conditional workflows.

Commit 618a9cc6 wraps condition controls according to available node width: source/field, comparison and value share rows when space allows and wrap for nested/narrow editors. Build and syntax checks passed (`/tmp/honmaru-condition-layout-build.log`); E2E now includes 390px layout/no-horizontal-overflow assertion and a mobile screenshot. This visual correction is not in the running integrated candidate 0b4d7e42.

## Floating focus production and condition editor localization (2026-10-24)

Deploy Web 40103746484 / job 120901033104 succeeded for c1e81790. Both production domains serve index-F9It5Vxz.js; independently fetched app.honmaruai.com with curl and confirmed the same asset. Preview: https://11366034.honmaru-web.pages.dev. Signed-in native revalidation of this exact deployment remains pending; preceding production was tested natively.

Condition editor visible labels, operators, candidate controls and accessible labels now follow useT, including the conditional-step checkbox. English/Japanese live-switch coverage and step editor tests passed: 2 files / 7 tests (`/tmp/honmaru-condition-locale-tests.log`); build passed after removing a duplicate existing Remove translation key (`/tmp/honmaru-condition-locale-build.log`). E2E selectors accept either locale. Saved-condition prose still needs localization, and the compact layout/localization changes are not in currently running 0b4d7e42 CI.

## Responsive localized conditional workflow release (2026-10-24)

Integrated candidate 0b4d7e42 E2E job 120899477750 (CI 40103229488) passed, including saved/skipped execution history. Current release candidate 51f93b1424db01dcddd9bf7987a6a3dea0fbd75a on codex/conditional-workflow-release is based on production c1e81790 and includes responsive condition controls plus localized editing and saved descriptions. It excludes docs and unrelated work; 24 files, additive checkpoint table only. Focused description/editor tests passed (2 files / 7 tests), web build passed. New 390px overflow/browser screenshot coverage remains pending in this candidate. It is not deployed. Older Worker jobs were still running at the latest check.

## Signed-in production focus acceptance (2026-10-24)

Reloaded Honmaru AI 1.3.14 on production c1e81790, reopened the empty UI test app as a floating panel, and opened its conversation without sending any text. The compact title stayed on one row; the covered table/actions disappeared from the accessibility tree when chat opened. Personal view 自分のタスク and widths 180/320/180/180 remained intact. Screenshot `/tmp/honmaru-floating-focus-production.png` inspected. KY-096 evidence updated without claiming full reference parity. KY-060 now records partial candidate implementation; batch/parallel/general branching and rollout remain incomplete.

## Internal durable business-state foundation (2026-10-24)

Added workflowState.js plus additive hx_workflow_state_versions schema/migration. Writes require a live checkpoint owner/attempt and running run, enforce workflow-wide expected revision, retain pending/passed/failed versions, and validate bounded lossless JSON. Read views distinguish prior accepted business results from resumable progress; failed progress retires the checkpoint view. Head revision and selected state are read in one query. Four real D1 tests passed (`/tmp/honmaru-workflow-state-tests.log`), covering concurrent writers, stale/expired/stopped/cross-workspace writes, view semantics and invalid payloads.

This is internal storage only, not the TypeScript SDK or a public runtime API. Current source/resource authorization must still be integrated with an activation-scoped transport and commit-time revocation fences before exposure. No executing workflow calls these helpers yet; no automatic recovery or exactly-once external-effect claim. It is excluded from candidate 51f93b14 and must not ride that production deployment accidentally. KY-059 remains unfulfilled.

## Release candidate visual acceptance (2026-10-24)

51f93b14 E2E 120901818963 (CI 40104011140) passed. Inspected `/tmp/honmaru-e2e-40104011140/workflow-condition-editor.png`, `workflow-condition-editor-mobile.png`, and `workflow-condition-run.png`: desktop predicates fit horizontal rows, 390px controls wrap without document overflow, English labels and saved descriptions are consistent, and completed run history shows the condition-mismatch skip. Worker job 120901818855 remained live. Its Worker tree 297f5ea7a76a3fd07b82fc32e90aa41b0960351a matches fully passed integrated CI 40103229488. No production rollout of conditional workflows yet.

Internal state normalization commit 4ae183e6 rejects accessor, hidden and symbol properties before serialization, preventing silent loss or getter invocation. Five DB/normalization tests passed (`/tmp/honmaru-workflow-state-json-tests.log`). This remains excluded from the release candidate.

## Run-scoped internal state reads (2026-10-25)

State reads now require an active checkpoint owner/attempt and derive the workflow from that running execution. Arbitrary workflow-ID reads are removed. Expired, stale, stopped and cross-workspace reads return unavailable; a later authorized run can recover the previous accepted business result. Six D1/state-validation tests passed (`/tmp/honmaru-workflow-state-read-tests.log`). Transport identity, current source/resource ACLs and commit-time revocation remain prerequisites before public exposure. This change is excluded from 51f93b14, whose Worker CI job 120901818855 remains live.

## Current membership fence for internal state (2026-10-25)

Internal state reads/writes now include current creator membership in the same SQL statement as the lease/run fence, rejecting removed users and guest downgrades even after a lease was issued. Seven real D1/normalization tests passed (`/tmp/honmaru-workflow-state-membership-tests.log`). Resource/source-room access and activation-scoped transport remain unfinished; this is not sufficient public API authorization. The state module remains excluded from release candidate 51f93b14. Native Kylon comparison is temporarily unavailable because the control tool returned a locked-Mac result; no new permission or unlock prompt was requested.

## Conditional release promotion (2026-10-25)

Exact candidate 51f93b1424db01dcddd9bf7987a6a3dea0fbd75a completed all required checks in CI 40104011140, including Worker and End to end. Confirmed remote main was c1e81790, then fast-forwarded only codex/conditional-workflow-release to main. Primary branch business-state changes remain excluded. Deploy Worker 40105554127 / job 120906384574 is testing; Deploy Web 40105554060 / job 120906384400 waits for its matching backend deployment. Main CI 40105554195 is running. This records promotion, not completed production rollout.

User reported the Mac operable; a fresh native getApp attempt still returned a locked-Mac tool result. No successful new native verification is claimed and no repeated unlock request was issued. Existing signed-in proof remains for c1e81790.

## Business-state retention boundary (2026-10-25)

The unpublished state-version schema no longer cascades from execution history: run_id remains immutable provenance, while workflow ownership retains its deletion cascade. A regression test deletes the originating run, verifies the prior accepted result remains readable from a subsequent leased run, rejects a stale revision, saves the next revision, and confirms workflow deletion removes retained state. Eight real D1/normalization tests passed in /tmp/honmaru-workflow-state-retention-tests.log. This schema has not been deployed; no production table rebuild is needed for this still-unreleased foundation. Source authorization and runtime SDK integration remain incomplete.

## Atomic source-access fence for internal business state (2026-10-25)

State read/write SQL now checks current source creator and conversation access in the lease/CAS statement, using the same channel-family predicates as workflow safety notices. New real D1 tests cover private-room removal, public visibility restoration, archival, unknown channel rejection, creator mismatch and group membership removal. Ten tests passed in /tmp/honmaru-workflow-state-source-tests.log. Agent/direct-message branch-specific coverage and activation-scoped transport/runtime integration remain pending; no public endpoint or production rollout is claimed. Full Worker suite session 91607 started before this edit against 333c05b5 and remains live; it must not be represented as frozen coverage of this later change.

## Agent and DM source revocation coverage (2026-10-25)

Twelve internal-state tests passed (/tmp/honmaru-workflow-state-agent-tests.log). Added actual D1 checks for a DM peer leaving the workspace, agent people-list revocation, an explicit current-membership role restoring access, an obsolete membership epoch losing access, and agent deletion denying reads/writes. These prove the covered storage fences only; activation-scoped runtime integration and real execution remain unfinished. Production rollout jobs 40105554127/40105554060 remain live at the latest poll.

## Saved workflow editing candidate (2026-10-25)

Primary e48fe59b adds detail-to-editor navigation with existing trigger/steps/conditions retained. Save submits the observed updatedAt; the backend advances its timestamp monotonically and atomically compares the observed row timestamp, refusing stale/racing writes. A conflict preserves the editor draft. Web 25 tests, Worker workflow 50 tests and web build passed (logs /tmp/honmaru-workflow-edit-{web-tests,worker-tests,build}.log). Model-free E2E now edits a saved condition, reloads and verifies persistence. Isolated release e3d547370248a894a8dfc0fe927b9be032a29b98 on codex/workflow-edit-release contains only these seven files atop 51f93b14, excluding the unfinished state store. CI 40106345694 is running. Not deployed.

Local full Worker session 91607 completed successfully: 231 files / 1,914 tests, /tmp/honmaru-state-foundation-full-worker.log, 483.61 seconds. It started at 333c05b5 before subsequent edits, so this run is not exact-HEAD full-suite evidence. Source permission changes have separate focused 12-test evidence.

Main 51f93b14 E2E 120906385089 passed. Deploy Worker 40105554127 continues testing and Deploy Web 40105554060 awaits it. A fresh native Honmaru selection still returned the control tool's locked-Mac result; latest production native verification remains unavailable.

## Workflow edit scheduling semantics (2026-10-25)

Editing an unchanged enabled trigger now preserves the database's current next_run_at in SQL, including a scheduler advancement concurrent with editor loading. Disabling clears it; reenabling or changing the schedule recalculates it. The 51-test workflow suite passed in /tmp/honmaru-workflow-edit-schedule-tests.log, including frozen approval continuation after definition edits and the new schedule-cursor regression. This correction is not yet in the running e3d54737 candidate and must be included before promoting editing to production.

## Conditional workflow production rollout completed (2026-10-25)

Main 51f93b1424db01dcddd9bf7987a6a3dea0fbd75a CI 40105554195 passed all required jobs. Deploy Worker 40105554127 / 120906384574 completed migration and deployment successfully; version 89c48909-3cf0-445f-a756-41a00f352349. Public /health returned ok. Deploy Web 40105554060 / 120906384400 succeeded, preview https://faa97d5c.honmaru-web.pages.dev. Independent curl requests confirmed both app.honmaruai.com and honmaru-web.pages.dev serve index-D8APgVAb.js. Python urllib received 403, so verification used normal curl responses. Native signed-in verification of this exact deployment remains unavailable due the control tool's locked-Mac result. This is deployment evidence, not full Kylon parity.

Latest editing candidate eab187e6875cd3d94f9ae9d29efed7a83dea901a, codex/workflow-edit-schedule-release, CI 40106671109, includes schedule-cursor preservation and weekly/monthly controls with localized weekday/detail descriptions. Local web 26 tests and build passed (/tmp/honmaru-workflow-schedule-ui-{tests,build}.log). It has not been promoted. Older e3d54737 CI 40106345694 remains live and lacks the scheduling correction, so do not promote that earlier candidate.

## Explicit workflow timezone editing and validation (2026-10-25)

Workflow editor now exposes the saved timezone and disables save for invalid time/timezone values. Backend normalization rejects explicitly invalid hours, minutes, weekdays, monthdays and timezones instead of silently clamping/falling back; omitted defaults remain compatible. Worker workflow/creation suites passed 66 tests, web workflow screen passed 27 tests, and build passed (/tmp/honmaru-schedule-validation-worker.log, /tmp/honmaru-schedule-timezone-web-tests.log, /tmp/honmaru-schedule-timezone-build.log). These additions are not yet included in eab187e6 and require inclusion in the final editing release candidate.

## Final workflow editing candidate queued (2026-10-25)

653c60952bd49e95b0e7074223c6202bbf9e5648 on codex/workflow-edit-final (parent eab187e6) includes timezone validation and the expanded model-free browser scenario: edit existing conditions, reload, select monthly day 31, reject an invalid timezone, persist UTC and pause the fixture. CI 40107036510 is queued. This is the current promotion candidate; earlier e3d54737/eab187e6 should not be promoted in its place. Unfinished business-state schema/module remain excluded. No editing feature has been deployed yet.

## Saved-edit browser visual acceptance (2026-10-25)

Older editing candidate e3d54737 E2E 120908713950 / CI 40106345694 passed. Downloaded its artifacts and inspected /tmp/honmaru-e2e-40106345694/workflow-condition-edited.png: after reload the renamed workflow title, edited numeric condition amount >= 200, preserved currency condition and Edit workflow control are visible; prior skipped-run history remains. This proves the saved-edit path, not the later calendar/timezone additions. Current promotion candidate remains 653c6095 / CI 40107036510, still running.

## Unreleased immutable workflow definition history (2026-10-25)

Added workflow-revisions.sql with additive version table, current-definition baseline, insert/update capture triggers and immutable-update rejection. It records name, enabled, trigger, steps and creator, excluding webhook credentials and scheduling cursors; all SQL definition writers are covered. Dedicated schema migration avoids D1's SQL-length limit hit by further expanding the already large flattened schema. Deploy/test/E2E initialization explicitly applies this file. GET /workflows/:id/revisions uses bounded pagination and filters each historical definition against current source/resource permissions.

History and workflow suites passed 55 tests (/tmp/honmaru-workflow-revisions-integration-tests.log), including private historical definition hiding, cross-workspace denial, immutable rows, bounded paging and owner deletion cleanup. The requested non-existent app-automation-release test selector matched no file; actual app automation coverage lives in harness-apps.test.js and is now running separately. UI comparison and run-to-definition revision linking are not implemented. This history feature is excluded from current editing release candidate 653c6095 and must not ship by pushing primary HEAD.

## Unreleased definition comparison UI (2026-10-25)

WorkflowHistory lazily loads accessible revisions, compares selected before/after name, enabled state, trigger and steps, supports older-page loading without resetting selection, and clears cached results on failed refresh. Responsive paired panels use existing theme tokens. Web 29 tests passed; build passed after removing a duplicate existing Off translation. HTTP revision-route/history/workflow suites passed 56 tests, and existing app suite passed 57 with the DB triggers enabled. Logs: /tmp/honmaru-workflow-history-{web-tests,route-tests,build}.log and /tmp/honmaru-workflow-revisions-app-tests.log. No browser visual acceptance or production rollout of revision history yet; run revision linking remains unfinished.

## History release pipeline and migration acceptance (2026-10-25)

GitHub rejected the initial history branch because the connected OAuth app lacks workflow-file write scope. Removed the workflow YAML modification and routed revision schema/backfill through the existing CREATE-prefixed migrations.sql runner. No broader permission requested. Candidate 4ba3c0704bc3131bcdee8b283aca474f74a2c2c9 on codex/workflow-history-release was pushed successfully; CI 40107908466 is live. It is based on editing candidate 653c6095 and excludes unfinished business-state storage. The rejected local 6361860e commit is not an ancestor of the pushed candidate.

Four D1 history tests passed, including dropping the new history schema to simulate an existing deployment, executing exactly the production CREATE-prefixed migration statements twice, verifying one baseline and a subsequent version 2 (/tmp/honmaru-workflow-history-migration-tests.log). This last test addition is local after the history candidate snapshot; schema/code are unchanged. Editing candidate 653c6095 E2E 120910758162 passed; artifact download session 53790 is running. Worker 120910757957 remains live.

## History runner permission fix and schedule visual acceptance (2026-10-25)

History candidate 4ba3c070 E2E 120913331705 failed before starting tests: release-index assembly assigned mode 100644 to e2e/run.sh instead of its original 100755. Restored executable mode in candidate 4ab12e4b31d37ab37c5a74ba7830a442ba9d58e6 and pushed codex/workflow-history-release. Primary file mode was already correct. Future isolated-release assembly must preserve source git modes rather than applying 100644 to every path.

Editing 653c6095 artifacts downloaded successfully. Inspected /tmp/honmaru-e2e-40107036510/workflow-condition-schedule-editor.png: monthly day 31, 09:00, UTC, last-day explanation and retained conditions appear coherently in the editor. Its E2E 120910758162 passed; Worker 120910757957 remains running. This candidate is still not deployed.

## Run-to-definition revision binding (2026-10-25)

New runs atomically store the highest matching saved definition revision alongside their frozen definition. Matching includes name, enabled state, trigger, steps and creator. Later edits do not relabel previous runs; no matching tracked version yields null rather than a guessed revision. Run list/detail APIs return the recorded revision and the history UI shows its version number. Worker revision/workflow suites passed 58 tests and web build passed (/tmp/honmaru-workflow-run-revision-{tests,build}.log). E2E now asserts version 1 on the original run before editing. This addition is not in 4ab12e4b and remains undeployed.

## Offline TypeScript execution addition (2026-10-25)

Added explicit TypeScript module payloads, transformed and evaluated inside the existing pinned VM, with a required default function receiving input. Legacy JavaScript payload remains unchanged. Gateway 10 tests, Worker gateway 7 tests, UI language/draft test and web build passed. Real VM typed/enum module returned 42 and missing default entry point failed. Existing isolation/timeout smoke passed (/tmp/honmaru-typescript-runtime-smoke.log). Other logs: /tmp/honmaru-gateway-typescript-tests.log, /tmp/honmaru-typescript-queue-tests.log, /tmp/honmaru-typescript-ui-{tests,build}.log. Installed gateway snapshot, production API/UI and workflow SDK integration remain pending; feature is excluded from current history/editing release candidates.

## Editing promotion and installed TypeScript runner (2026-10-25)

Editing 653c6095 CI 40107036510 completed all required checks successfully. Remote main was confirmed at 51f93b14, then fast-forwarded codex/workflow-edit-final to main. Main CI 40108536003, Deploy Worker 40108536008 / 120915196455 and Deploy Web 40108535985 / 120915196322 are running. This is promotion, not completed deployment.

The Mac had no active containers; updated its existing LaunchAgent snapshot with gateway/install-service.mjs and existing service.json. Token ownership/mode remained valid and no credential was printed/replaced. Plist validation succeeded, launchctl reported running PID 62373 and the installed runner hash matched source. Physical reboot and production TypeScript queue round trip remain unverified. Candidate 4c571b34bc0e70466ea6c67566418fc1ba269249 on codex/typescript-gateway-release (parent aaa86850) includes TypeScript runner/API/UI, plus already-isolated history changes, excluding the unfinished business-state store. It is pushed for CI, not deployed.

## TypeScript UI-to-queue browser scenario (2026-10-25)

Added e2e/gateway-typescript.mjs, restricted to the disposable localhost Worker: creates a local fixture node, preserves independent JavaScript/TypeScript editor drafts, submits a typed module through the UI, claims it using only that fixture node identity and verifies language/code/input, then cancels and revokes the fixture. No production node or paid model executes. Existing VM smoke separately proves execution. Candidate cb4c0667b0abbd6e5af05efe04835ed277e17351 on codex/typescript-gateway-release supersedes 4c571b34 with this E2E scenario; pushed for CI. No production rollout of history/TypeScript yet.

## Readable revision comparisons and CI corrections (2026-10-25)

Inspected history desktop/mobile artifacts from CI 40108225100: mobile contained the layout, but raw trigger/step JSON, unstyled selectors and undefined surface/border tokens made the comparison difficult to read. Replaced those with shared human-readable workflow labels, ordered operations, named record fields, execution conditions, record target IDs and lossless typed value display. Comparison panels/selectors now use hx theme tokens. The localhost E2E captures narrow and dark history views and rejects raw preformatted definition dumps. New screenshots for this correction are still pending.

Older run-history candidate aaa86850 CI 40108225100 failed only migration.test.js (1910 tests passed): its terminator count treated semicolons inside trigger bodies and the CREATE/backfill batch as separate deploy lines. Updated the check to require every non-comment line to be selected by the actual deploy prefix filter and terminated; real migration execution/replay remains tested. Migration/history suites passed 16 tests locally (/tmp/honmaru-history-migration-coverage.log).

TypeScript candidate cb4c0667 E2E 120916277991 failed locating the exact Execution node label. Its downloaded failure screenshot (/tmp/honmaru-e2e-40108864375/gateway-typescript-failure.png) shows the node and full editor present. Added explicit accessible labels to the node/language selectors and code/input editors; browser verification is pending. UI tests passed four tests and build passed (/tmp/honmaru-history-gateway-fixes-{tests,build}.log). Earlier readable-history/condition tests passed five tests (/tmp/honmaru-history-readable-tests.log).

Current isolated release candidate is e16321cbb1886638d76ca7ece56d4aaa24c8b508 on codex/workflow-history-polish-release, CI 40109883954 (Worker 120919516501, E2E 120919516657). It includes history, run revision links, TypeScript and the corrections; excludes unfinished business-state storage. e2e/run.sh mode remains 100755; no workflow YAML modifications. Supersedes failed earlier history/TypeScript candidates and cancelled earlier polish revisions. Do not promote before exact candidate checks pass.

Main editing 653c6095 CI 40108536003 passed every required job. Deploy Worker 40108536008 / 120915196455 has passed tests and is migrating D1 columns; Deploy Web 40108535985 / 120915196322 awaits Worker. Serving asset/deployment completion is not verified yet. Native CUA still reports locked despite the user's statement that the Mac is operable; browser inventory exposes only IAB and MCP Apps, so no new signed-in native proof. No repeated unlock request was sent. Goal remains active and far from 100% parity.

## Workflow editing production acceptance (2026-10-25)

Main 653c60952bd49e95b0e7074223c6202bbf9e5648 completed CI 40108536003, Deploy Worker 40108536008 and Deploy Web 40108535985 successfully. Worker version fbccb126-4432-4ba7-afc2-d9e365a61942; Web preview https://d614f9f1.honmaru-web.pages.dev. Deployment logs and independent curl requests agree that both production domains serve index-Bwg6XH3r.js. Public /health returned ok. Editing, weekly/monthly schedule fields and timezone validation are now deployed; exact-release signed-in native interaction remains unverified. The history/TypeScript/polish candidate e16321cb remains in CI 40109883954; do not confuse it with serving editing code.

Rechecked https://docs.kylon.io/cli/workspace/workflow on 2026-10-25. Kylon saved workflow TypeScript uses top-level module execution and activation-scoped state; exported functions are not automatically called. Our generic gateway's required default function is useful runtime coverage but does not fulfill KY-059. Updated the requirement evidence to retain that distinction; no SDK parity or completed recovery claim.

## Internal durable-state metadata and receipts (2026-10-25)

The unreleased business-state foundation now retains optional schemaVersion/businessDate, structured validationErrors and a SHA-256 hash of the exact serialized state. Save receipts include contentHash; readback includes metadata and currentRunId while preserving sourceRunId. Metadata is bounded to 16 KB and validated without executing accessors. Added an additive metadata migration with empty metadata for old rows, avoiding invented historical hashes. Workflow state and migration suites passed 26 tests (/tmp/honmaru-state-metadata-tests.log), including old committed-state preservation, metadata round trips, invalid metadata rejection and accessor non-execution.

These changes remain on the primary development branch only. They are excluded from e16321cb and are not deployed, exposed as a public API, or connected to gateway execution. Activation-scoped transport, frozen-revision binding, top-level module execution and restart recovery remain required before claiming KY-059 completion.

## Internal state immutability fence (2026-10-25)

Added a DB update trigger protecting saved business-state versions, including metadata and receipt hashes. New writes append through the existing revision CAS; workflow-owned deletion still cascades as before. State/migration suites passed 27 tests (/tmp/honmaru-state-immutable-tests.log), including direct update rejection, new-version creation and retained workflow deletion semantics. This is an unreleased foundation correction, still excluded from e16321cb. CI 40109883954 Worker 120919516501 and E2E 120919516657 remain live at the latest poll; neither was restarted due elapsed time.

## Readable comparison and TypeScript browser acceptance (2026-10-25)

Candidate e16321cb E2E 120919516657 / CI 40109883954 succeeded. Downloaded artifacts to /tmp/honmaru-e2e-40109883954/ and inspected workflow-condition-history.png, workflow-condition-history-dark.png, workflow-condition-history-mobile.png and gateway-typescript-editor.png. History now shows human-readable schedules, ordered steps and conditions in bounded paired cards, with readable dark colors and mobile stacking. The typed module editor shows the selected fixture node and preserved TypeScript code. Browser scenario also verified queue payload language/code/input using its disposable local node; real VM execution has separate earlier evidence. This is CI browser evidence, not native production interaction or full Kylon parity. Worker 120919516501 remains the required gate before promotion.

## State access bound to frozen execution identity (2026-10-25)

Internal state reads/writes now require the run's stored definition in the same SQL statement as its live lease and membership/source fences. The frozen workflow ID and creator must match the live workflow; a changed live owner cannot inherit a previously issued activation. New state metadata captures the frozen definitionRevision rather than today's edited revision. Eighteen state tests passed (/tmp/honmaru-state-frozen-tests.log), covering missing/mismatched snapshots, live ownership changes and unchanged revision provenance after name edits. Still no activation transport or public state API; current resource grants must be checked by the future executor. Excluded from the e16321cb release candidate.

## Gateway executable integrity repair and history promotion (2026-10-25)

An authoritative launchctl check found the installed service in spawn-scheduled state with 72 starts and OS_REASON_CODESIGNING. codesign rejected runtime/node, whose SHA-256 differed from the valid original /Users/tt/.local/node22/bin/node. Added gateway/install-executable.mjs to copy into a fresh inode, compare digests, validate the existing macOS signature and execute --version before atomic replacement. No ad-hoc signing/protection bypass. Eleven gateway tests passed (/tmp/honmaru-node-install-tests.log), including failed-validation preservation of the prior target and fresh-inode replacement. Reinstalled using the existing config/token: plist valid, copied Node signature valid, matching hash 68f4d07ca49e0500cc135c7e0a445093e228e42e126ac22306d045f0a8c2636b. PID 65774 remained running with one start at the follow-up check; container system status running, no active containers, no new service-error log entries (last modified 2026-10-24 22:35:55). This is sustained process/runtime evidence, not physical-reboot or production-job completion proof. Integrity candidate c3ee6aaa358566a70f067327086ee368ff6361af on codex/gateway-install-integrity is in CI 40111434972; installed local repair is already applied.

History/TypeScript/UI candidate e16321cbb1886638d76ca7ece56d4aaa24c8b508 CI 40109883954 passed all required jobs, including Worker 120919516501 and E2E 120919516657. Confirmed remote main was 653c6095 and fast-forwarded only codex/workflow-history-polish-release to main. Main CI 40111530104 (Worker 120924092250, E2E 120924092604), Deploy Worker 40111530216 / 120924092568 and Deploy Web 40111530061 / 120924092141 are running. Deployment is not yet confirmed; last verified serving release remains editing 653c6095 / index-Bwg6XH3r.js. Unfinished state foundation and new gateway installer repair are not part of the just-promoted e16321cb tree.

## Internal top-level TypeScript SDK VM bridge (2026-10-25)

Implemented an unexposed workflow VM runner and state broker with a fixed `@honmaru/workflow-sdk` module shim. Existing pinned Node v22.23.3 was probed and supports registerHooks; official API checked at https://nodejs.org/download/release/v22.15.0/docs/api/module.html. Fifteen gateway tests passed (/tmp/honmaru-workflow-bridge-tests.log). Actual VM smoke (/tmp/honmaru-workflow-vm-smoke.log) passed top-level await, default-export non-invocation, read/write/readback, fresh-VM reads, mandatory initial read, mixed non-newline output/RPC, no host-home visibility, read-only root, no outbound network, output limit and runaway timeout. The storage callback in that smoke is in-memory; no claim of durable D1 integration or production SDK completion. Broker tests reject guest-selected scope/lease fields, arbitrary methods, duplicate IDs and queued work after cancellation, and hide host error details.

New runner remains primary-only and is not installed, deployed or reachable from existing gateway payloads. Existing container arguments are reused with a trusted bootstrap parameter; the ordinary default-function runner behavior is unchanged. Production e16321cb deployment and integrity candidate c3ee6aaa CI remain live and were not restarted.

## Internal activation-bound state adapter (2026-10-25)

Added a private job-to-workflow/checkpoint binding and workflowActivationState adapter. It resolves workspace/run/checkpoint credentials from server-side data, rejects caller-selected scope fields, and requires both the workflow checkpoint lease and assigned node job lease in the same D1 state statement. Revoked nodes, elapsed job deadlines/leases, cancelled jobs, changed requesters, reassigned checkpoint attempts and ordinary jobs without bindings cannot access state. State/migration/workflow suites passed 85 tests (/tmp/honmaru-state-activation-tests.log). Moved runtime schema into workflow-runtime.sql to stay below the already-near-limit flattened schema size; test and localhost E2E initialization apply it explicitly, while existing production migration statements remain additive. No public route, binding admission/queue writer or production SDK wiring yet; source/resource authorization and immutable code admission remain required. Entire adapter/runtime/state foundation remains primary-only and excluded from current releases.

Gateway installer integrity candidate c3ee6aaa CI 40111434972 passed every required job. Confirmed main was e16321cb and fast-forwarded only codex/gateway-install-integrity to main. Its delta changes gateway installer/helper/test only, so no new Worker/Web deploy is needed; the e16321cb Worker/Web rollout continues. This may supersede the duplicate main CI for e16321cb; exact e16321cb candidate CI had already passed before promotion. Neither pending production deployment was cancelled or restarted.

## Node HTTP state transport (2026-10-25, unreleased)

Added the node-authenticated POST /gateways/jobs/:id/state route, private activation resolution and live job/checkpoint fences. The response never contains node bearer tokens, job leases or checkpoint owners. Valid state round trips, wrong nodes/leases, arbitrary scope fields, invalid state and post-cancel access were covered through worker.fetch. Initial run exposed an unhandled rejected promise in the adapter; explicitly awaiting the delegated state operation fixed it. Final HTTP/state suite passed 29 tests without unhandled errors (/tmp/honmaru-state-http-tests.log).

Gateway claim now derives its workflow flag from the private binding, not submitted payload fields. Client selects the isolated workflow runner only for that server flag and keeps node/job credentials in its host callback. Abort signals propagate into the host fetch. Seventeen gateway tests passed (/tmp/honmaru-state-client-tests.log). Installer knows the new runtime module dependencies but this newer snapshot has NOT been installed. Workflow code admission/binding creation, source/resource grants, saved-code UI and run completion/recovery remain missing; new route/SDK transport is primary-only and not deployed.

## History and TypeScript production rollout complete (2026-10-25)

Deployment of e16321cb succeeded: Worker 40111530216 / 120924092568, version a58db35c-06f7-4123-84e6-1071cfb6d726; Web 40111530061 / 120924092141. Independent curl checks show both app.honmaruai.com and honmaru-web.pages.dev serve index-mgdFRSD0.js; public health ok. Candidate CI 40109883954 passed fully before promotion. Duplicate main CI 40111530104 was superseded/cancelled when installer-only c3ee6aaa advanced main; no deployment was cancelled. Main c3ee6aaa CI 40112404024 remains to check. Local gateway PID 65774 still running, one start and never exited. Native CUA still reports locked, so no authenticated production UI/job round-trip claim. The deployed generic TypeScript runtime is distinct from the still-unreleased workflow SDK.

## Frozen program job admission (2026-10-25, unreleased)

Added internal enqueueWorkflowProgram: executable source, node and creator derive exclusively from the run's frozen definition; code/input size is bounded; a whole-program definition is required. Queue job and private activation binding are committed together under an effect checkpoint. Concurrent calls create one job; edited live definitions and caller-supplied replacement source do not alter it. Lost/uncertain leases refuse automatic replay. Current source membership, managed app publication and safety-generation authority are checked in SQL; the same safety/publication guard now fences state operations. Admission/state/node suites passed 35 tests (/tmp/honmaru-workflow-admission-tests.log), including duplicate admission, private source loss, changed safety generation, revoked node, oversized input, mixed definition rejection and paused-state access denial. Not integrated into normal workflow normalization/start/completion yet; no production feature claim. Next required work is terminal job reconciliation, code-form admission/UI, and recovery that does not repeat uncertain effects.

## Program output authorization (2026-10-25, unreleased)

Execution reads now check a program's frozen workflow resource permissions and the source room captured at admission. Cancellation through the gateway route uses the same check. A private program marker keeps retained jobs inaccessible if run retention removes their activation binding, rather than exposing them as generic executions. Missing frozen definitions fail closed. Admission/access, gateway and Company Harness suites passed 30 tests (/tmp/honmaru-program-access-tests.log), including room membership revocation, source unlinking and run deletion. This remains part of the unreleased workflow runtime, not an independent production release.

Native CUA still returned a locked-Mac error after the user's unlock confirmation. IAB successfully loaded https://app.honmaruai.com/ and displayed the signed-out landing screen; authenticated UI verification remains unperformed. Main CI 40112404024 still had Worker tests running while all other required jobs passed. No new paid services or Simple-mode changes.

## Terminal workflow program reconciliation (2026-10-25, unreleased)

Added persisted-job reconciliation into the workflow run, checkpoint and idempotent safety outcome in one D1 batch. Only the matching frozen definition, checkpoint fingerprint/owner/attempt and sole code program qualify. Successful jobs require current source/publication/safety/node authority and recorded completion within both execution and checkpoint deadlines. A revoked or expired successful result fails closed; cancelled runs cannot be overwritten. Finish and identical-result retry paths reconcile, as do authorized cancellation and the existing bounded expiry/cron path. Queued program jobs expire after three minutes so they cannot outlive the five-minute checkpoint while waiting for an offline node. No automatic replay of uncertain effects was added.

Admission/settlement, gateway and state tests passed 52 cases (/tmp/honmaru-program-settlement-tests.log), including actual node claim/finish HTTP, interrupted-result recovery, concurrent duplicate settlement, failure/timed-out/cancelled results, revoked authority and offline queue expiry. The final recovery query additionally skips missing/reassigned checkpoints so they cannot occupy the bounded recovery batch. This is still unreleased: code-form normalization, saved-code UI, ordinary start integration and a complete production SDK round trip are outstanding.

Main c3ee6aaa CI 40112404024 is now completed successfully, including Worker job 120927026537. Serving Worker/Web remains e16321cb; no new deployment was attempted for the unfinished runtime foundation.

## Whole-program save/start integration (2026-10-25, unreleased)

Workflow normalization now accepts one whole TypeScript program with an existing workspace execution node; it rejects mixed form/program definitions and code above 48 KB without truncating source. Create/update validate node availability. Normal start/continue now admit frozen programs and leave runs pending until node settlement, using a running-status CAS so a fast terminal reply cannot be overwritten. Existing form workflows retain their execution path.

Node claim/heartbeat/finish/expiry now require current workflow authority and matching checkpoint ownership. State operations additionally preserve the captured source-room binding; shared workflow authority checks source-table existence and linked-app visibility. Initial deeply nested SQL hit D1's maximum expression depth; materialized CTEs separate authorized runs from authorized jobs while retaining single-statement authorization. The corrected workflow/program/node/state suite passed 108 tests (/tmp/honmaru-program-start-tests.log). Added targeted row-trigger app-privacy regression afterward. UI code editing/history display and full runtime release remain outstanding; no new production rollout or paid service.

## Program workflow editor and history (2026-10-25, unreleased)

Added a workflow format selector with separate form/program drafts, execution-node loading/retry, a theme-aware TypeScript source editor with UTF-8 size validation, and exact source display in workflow detail, revision comparison and automation summaries. Existing code definitions initialize the program editor; changing format does not discard either draft. Save conflicts retain source. Program source is ordinary escaped React text, never rendered as HTML. Japanese labels explain top-level module semantics and the available state SDK without claiming other SDK operations.

Web workflow/history tests passed 32 cases (/tmp/honmaru-program-ui-tests.log), including format round trips, exact source submission, conflict retention, byte-limit disabling and old/new source comparison. Production Web build passed (/tmp/honmaru-program-ui-build.log), with existing chunk-size/dynamic-import warnings. No authenticated screenshot or browser E2E proof yet for this editor, and no production rollout. Runtime install/release and remaining SDK capabilities are still outstanding.

## Program runtime release candidate (2026-10-25, in progress)

Added localhost-only browser E2E for form/program draft switching, exact code/node persistence, light/dark/mobile editor screenshots and overflow/theme checks, then assigned-node claim/state get/set/finish and workflow outcome verification. The node completion in this test is a fixture; it does not claim real VM execution. Local gateway/dependency/migration tests passed 35 cases (/tmp/honmaru-program-release-checks.log), and fixture syntax/diff checks passed.

Created isolated release candidate 966084c15f44edc2dc2e08a5873a21052ecedb41 on codex/workflow-program-runtime, with production c3ee6aaa as its parent and the reviewed current tree. CI 40114790679 is active. Relay 120933731460, Desktop 120933731637, shared/mobile 120933731686, gateway 120933731731 and web 120933731747 passed. Worker 120933731725 and E2E 120933731769 remain in progress at last authoritative poll; do not restart them solely for elapsed time. Main and serving production are unchanged. Next: collect screenshots/report, resolve any CI failure, then promote only the validated candidate and install its node runtime under the existing no-new-charge authorization. Requirements KY-058/KY-059 now distinguish unreleased implementation from verified production behavior.

## Program editor reuse in app automations (2026-10-25)

Inspection while candidate CI runs found imported code workflows still reached the form-only StepEditor inside AppAutomations. They now use the same program editor, retain exact source/node fields, and cannot append form steps to a whole program. Eleven targeted app/editor tests passed (/tmp/honmaru-program-app-editor-tests.log); Web build passed (/tmp/honmaru-program-app-editor-build.log). This follow-up is not yet included in candidate 966084c1. Candidate CI 40114790679 remains live (Worker 120933731725 and E2E 120933731769 in progress; artifacts not yet available); it has not been cancelled or restarted. Incorporate this follow-up into the next validated candidate after collecting the current result. Added a candidate-only operator guide covering top-level semantics, state API and actual limits in docs/mac-mini-gateway.md.

## Live workflow execution detail (2026-10-25, unreleased follow-up)

Added bounded serial five-second refresh while an opened workflow has a running execution. Polling stops on terminal state, edit/navigation/unmount or a foreground action; stale requests cannot overwrite the newer screen. A failed refresh clears stale details/list entry and shows the error. Thirty workflow screen tests passed (/tmp/honmaru-program-live-tests.log), including terminal-stop and revoked-access cases; build passed before the final list-entry removal (/tmp/honmaru-program-live-build.log). This follow-up, like the app editor fix 851994e3, is not yet included in release candidate 966084c1. CI 40114790679 still reports Worker 120933731725 and E2E 120933731769 in progress at the latest poll. No restart or production promotion.

## Candidate E2E results and visual correction (2026-10-25)

Candidate 966084c1 E2E job 120933731769 succeeded. Retrieved artifacts to /tmp/honmaru-e2e-40114790679/ and inspected workflow-program-editor.png, workflow-program-dark.png and workflow-program-mobile.png. Report confirms source persistence, node claim/state transport and terminal workflow history. Light/dark colors switch correctly, but the large generation form remained above the manual builder and the mobile viewport did not show the code field. Removed the redundant generation panel while manual setup is active and changed future program screenshots to capture the builder itself. This correction is not yet browser-verified or included in the running candidate; targeted screen tests passed 31 cases (/tmp/honmaru-program-editor-focus-tests.log).

Before that small visual correction, the full current Web suite passed 1,161 tests in 172 files (/tmp/honmaru-program-web-full-tests.log), including the follow-up app editor/live result changes. Candidate Worker 120933731725 remains in progress at last poll. Do not promote or restart the live run solely for elapsed time; collect its result, then validate a follow-up candidate including 851994e3, 9ab49192 and this visual correction. Production and installed runtime are unchanged.

## Node rollout compatibility fence (2026-10-25, unreleased follow-up)

Before deployment, review identified that legacy node snapshots ignore the workflow flag and could receive a whole program through their generic runner. New clients now advertise workflow-program-v1 on claim; the Worker returns bound program jobs only to clients declaring that capability. Legacy clients can still skip those queued programs and claim ordinary jobs. The capability is protocol negotiation, not a replacement for authentication/current resource fences. Worker/node suites passed 34 and 17 tests; an additional queue compatibility assertion passed all 26 program tests (/tmp/honmaru-program-capability-tests.log, /tmp/honmaru-program-capability-node-tests.log, /tmp/honmaru-program-capability-queue-tests.log). E2E fixture now advertises the same capability. Not yet part of candidate 966084c1; include this with the pending UI follow-ups. Worker CI job 120933731725 remains authoritatively in progress, so no cancellation/restart or production promotion was performed.

## First program candidate fully passed; follow-up candidate queued (2026-10-25)

CI 40114790679 for 966084c1 completed successfully, including Worker 120933731725. No jobs were cancelled or restarted. E2E screenshots/report were already inspected and recorded above. The previous main Worker run took about 19 minutes, consistent with this long sequential suite; elapsed time alone was not treated as failure.

Fast-forwarded codex/workflow-program-runtime to 0b55f8540b8c243433989c25163b474472023e5e (local alias codex/workflow-program-ready), incorporating app-bundle program editing, automatic run-detail refresh, manual-editor visual correction and runtime capability negotiation. CI 40116404900 is queued for this exact candidate. Latest local full Web suite passed 1,162 tests in 172 files and production build passed (/tmp/honmaru-program-final-web-tests.log, /tmp/honmaru-program-final-web-build.log). Main remains c3ee6aaa, serving Worker/Web e16321cb, installed node unchanged. Next gate: follow-up CI and updated editor screenshots before promotion/runtime installation. The broader 100% parity goal remains incomplete.

## Follow-up CI observation and runtime staging (2026-10-25)

Exact run 40116404900 for 0b55f854 is authoritatively in_progress. Its jobs endpoint repeatedly returned HTTP 502; the GitHub connector also timed out, while the run endpoint remained readable. This is an observation failure, not a failed/stopped CI; do not restart it. Native CUA still reports locked, despite the earlier user unlock confirmation. No new unlock request was made.

Current installed gateway remains running at PID 65774, one start, never exited; container list is empty. Prepared the candidate's 17 gateway files and SHA-256 manifest without modifying the service at /var/folders/nx/ygvn7q3x7r5_vwl0rsz2c6zh0000gn/T/honmaru-program-runtime-mzvrx7kd. The manifest pins 0b55f8540b8c243433989c25163b474472023e5e; verify it again before using this staged installer. Production/main and installed runtime remain unchanged pending CI and updated screenshot verification.

## Follow-up CI alternate observation (2026-10-25)

Run 40116404900 remains in_progress; its jobs listing still returns HTTP 502. The commit check-runs endpoint for exact SHA 0b55f854 is readable and confirms Web plus shared/mobile success, with Worker, E2E, relay, local gateway and Desktop still in_progress. No artifacts yet. Use /repos/Torutesu/HonmaruAI/commits/0b55f8540b8c243433989c25163b474472023e5e/check-runs as the temporary read-only observation route; do not assume check-run IDs are workflow job IDs. No rerun, cancellation, deployment, or runtime replacement performed.

## SDK state default corrected from current specification (2026-10-25)

Re-read https://docs.kylon.io/cli/workspace/workflow: public state.set defaults to passed/final commit, while pending is explicit resumable progress. The activation adapter previously inherited the internal helper's pending default, making an omitted option invisible to normal prior-commit reads. Fixed the public adapter to default only an omitted validationStatus to passed; explicit pending remains progress and null remains invalid. Internal checkpoint helper defaults are unchanged. State/node suites passed 31 tests (/tmp/honmaru-program-state-default-tests.log), including default committed readback, pending isolation and invalid null. E2E now omits validationStatus and verifies committed readback. This correction is primary-only and must join the next candidate after 0b55f854's active CI finishes; do not deploy the earlier default. Other documented SDK gaps (schema-bound agent calls, external effects, 15-minute runtime) remain unresolved and are not represented as supported.

## Follow-up candidate browser artifacts inspected (2026-10-25)

Retrieved artifact 12569315941 for CI 40116404900 to /tmp/honmaru-e2e-40116404900/. Its report marks program editor persistence, node capability/state transport and history completion successful. Inspected light/dark/mobile program screenshots: the redundant generation panel is gone, source/editor text is readable and desktop colors switch correctly. The mobile element screenshot is clipped by the scroll viewport, so it does not prove access to the save footer. Added a no-side-effect Playwright trial click on the mobile Save button plus a viewport screenshot at that location for the next candidate; syntax check passed. This is a verification improvement, not evidence that the new mobile footer check has run yet.

Run 40116404900 remains in_progress according to its run endpoint. Both latest-jobs and attempt-1-jobs endpoints return HTTP 502; commit checks still show in-progress entries despite the available successful E2E report. Preserve the distinction between report evidence and terminal CI status. Await authoritative completion before advancing the branch. Primary also contains required default-state-commit correction 6cfbadd9, which is not in 0b55f854; do not deploy 0b55f854 as the final runtime release. No active artifact downloads or shell sessions remain.

## Second candidate fully passed; state-default candidate active (2026-10-25)

Run 40116404900 for 0b55f854 completed success. Worker and all required checks passed; final remaining Relay job 120938484595 was individually verified completed/success before advancing. No live job was cancelled. Its corrected editor screenshots/report were previously inspected.

Fast-forwarded the release branch to 5bec41e42ae765d3c5542eccc4e6b876cf8d7dbf (local alias codex/workflow-program-state-commit). New CI 40117546311 is in_progress. It includes public state.set default-commit correction and E2E committed readback plus mobile Save trial-click/screenshot. Gateway source is byte-for-byte unchanged from 0b55f854 (git diff --exit-code confirmed); the staged runtime remains applicable after manifest verification. Main/production and installed runtime are still unchanged. Next gate: this exact CI and mobile-save artifact, then production promotion and runtime install.

## Validated Mac runtime installed (2026-10-25)

Installed the gateway snapshot from the fully CI-passed 0b55f854 candidate; git/blob comparison verified all 17 staged files exactly match current candidate 5bec41e4, whose gateway source is unchanged. Confirmed zero active containers before replacing the service. Existing token/configuration were reused; no new credentials, subscriptions or permissions. Signed source Node and installed copied Node passed codesign --verify --strict; launchd plist validated. Installer source: /var/folders/nx/ygvn7q3x7r5_vwl0rsz2c6zh0000gn/T/honmaru-program-runtime-mzvrx7kd/gateway/install-service.mjs.

Installed service is running at PID 73627 with one start and never exited, confirmed again after 45 seconds; container list empty. Installed client/runner/SDK bridge files matched staged source bytes. An actual isolated VM invoked through the installed workflow-runner imported the SDK, read state, saved count=2 and printed 2 successfully. Its state callback was in-memory, not production D1. Physical reboot and authenticated production program execution remain unverified. Candidate CI 40117546311 still has Worker/E2E in progress; other required jobs passed at last poll. Server/Web/main remain unchanged, and the updated node remains compatible with that older server until production rollout.


## Program release promoted after complete candidate verification (2026-10-25)

CI 40117546311 for exact candidate 5bec41e42ae765d3c5542eccc4e6b876cf8d7dbf completed success, including Worker 120941894718 and E2E 120941894786. Downloaded artifact 12569927269 to /tmp/honmaru-e2e-40117546311/. The report confirms persisted program source and node state transport through terminal history. Inspected workflow-program-mobile-save.png: source, state guidance and Save workflow button are visible within the mobile viewport; its trial click passed. Inspected workflow-program-dark.png: editor, node selector and save footer have readable dark colors. These are localhost CI artifacts; the simulated node completion does not prove production VM/D1 execution.

Verified remote main was still c3ee6aaa and a direct ancestor, then fast-forwarded main to the exact CI-passed 5bec41e4. Production Deploy Worker 40118687149 (job 120945317026) and Deploy Web 40118687111 (job 120945316840) started; main CI 40118687110 also started. Deployment has not yet been confirmed complete. Do not restart these live runs based solely on elapsed time. Installed Mac runtime was already updated and byte-matched as recorded above. Native CUA still reports locked despite user confirmation; no repeated unlock request was made. Overall parity remains incomplete.


## Program workflow server and Web published (2026-10-25)

Exact release 5bec41e42ae765d3c5542eccc4e6b876cf8d7dbf passed main CI 40118687110 and both production deployments. Worker run 40118687149/job 120945317026 completed success after tests and D1 migrations; deployed version d17996dc-3d3e-4550-9726-4089d801c71a. Independent health request returned ok=true and encryption.all=true. Web run 40118687111/job 120945316840 completed success, preview https://d7d847cf.honmaru-web.pages.dev. Both https://app.honmaruai.com and https://honmaru-web.pages.dev independently returned /assets/index-CgvIoapG.js, matching deployment logs. Private logs are /tmp/honmaru-62966a05-120945317026.log and /tmp/honmaru-62966a05-120945316840.log.

The installed Mac runtime is already compatible, but authenticated production program-to-VM-to-D1 execution remains unverified. Native CUA still reports locked; no repeated user unlock request. Physical reboot remains untested. New UI candidate e058765f89c30466529dc0942963c98d5805e06d is NOT deployed: CI 40119447798 remains active, E2E 120947587180 succeeded, artifact 12569839562 inspected under /tmp/honmaru-e2e-40119447798/. Desktop dark line numbers align; mobile scroll alignment passed but screenshot showed navigation covering lower content. Primary follow-up 7a0630eb reserves mobile home navigation height and asserts viewport non-overlap; it is not in candidate e058765f and still needs browser verification. Do not promote that candidate as the complete UI correction. No new paid service; Simple mode preserved. Broader parity remains incomplete.


## Actual mobile Harness navigation overlap corrected (2026-10-25)

Candidate 723c9487 passed CI 40169897013, but its mobile image still showed lower code lines covered. The initial test inspected hidden .tabbar and fell back to innerHeight, so its success did not prove the visible Harness rail was excluded. Replaced that rule with a mobile-only bottom:52px on direct Harness resource screens, matching .hx-rail, and made E2E require the visible .hx-rail instead of silently falling back. No Simple-mode selector changed.

Candidate 66591eea7ee8e4ba808d64b08e4b93fa47d3fc2a is under CI 40171167814. E2E job 121102102053 completed success. Retrieved screenshots to /tmp/honmaru-e2e-40171167814/ and inspected workflow-program-mobile-lines.png: rows 78-80 and the editor bottom are now visible with no navigation overlay; prior screenshots ended at row 77. Inspected workflow-program-mobile-save.png: save footer remains visible and its trial click passed. Worker job 121102102246 remains active at last observation. Await all required CI before promoting. Production remains 5bec41e4; this UI update is not yet published. Authenticated production execution, physical reboot, broader SDK and full parity requirements remain incomplete.


## Workflow editor UI published (2026-10-25)

Candidate 66591eea7ee8e4ba808d64b08e4b93fa47d3fc2a completed all required CI in 40171167814. After verifying main remained its ancestor 5bec41e4, fast-forwarded main to this exact candidate. Web deploy 40172107975/job 121104939405 completed success; preview https://1545fe52.honmaru-web.pages.dev. Independent HTTP reads of app.honmaruai.com and honmaru-web.pages.dev both returned index-CaziwZnq.js, matching deploy build/verification logs. This publishes synchronized code line numbers and the actual mobile Harness rail clearance already visually verified above. Worker/gateway sources did not change, so the deployed Worker remains 5bec41e4, version d17996dc-3d3e-4550-9726-4089d801c71a; no additional Worker rollout is expected. Main CI 40172107917 is still running separately. Production authenticated browser/VM execution and remaining parity gaps remain unverified/incomplete. No new charge and no Simple-mode code removal.


## Workspace file version ledger foundation (2026-10-25, internal only)

Added workspace-files.sql and fileVersionLedger.js, intentionally without routes, production migrations or user-facing availability. Stable organization/scope/path identities, immutable version rows, deletion tombstones and purge markers are represented. Append uses a D1 batch with current-version compare-and-swap; restore references an unpurged source with matching content metadata and appends a new version instead of rewinding history. Six real workerd/D1 tests passed in /tmp/honmaru-file-ledger-tests.log: concurrent winner preservation, stale writes/restores, immutable history, tombstone restoration, purged/mismatched source rejection, cross-workspace keys, path identity and invalid input atomicity.

This ledger is NOT an authorization layer or complete file feature. It has no public call sites. Transactional live authority, R2 staging/readback/cleanup, retention/holds/purge, organization/account deletion, API and history/restore UI remain required before exposing writes. Existing message attachments and production schema are unchanged. Do not mark KY-073 implemented based on these tests.

## Authenticated native screen verification and staged file upload (2026-10-25)

Native CUA became available. Installed /Applications/Honmaru AI.app initially showed the authenticated chat and floating app. Opening Tools showed an error boundary, followed by an empty native window; bounded local diagnostics recorded script-load-error at 07:29:11Z. Reload/Force Reload did not visibly restore the window. Quitting and reopening the app preserved the session and restored chat. Tools and API & Webhook then loaded successfully, including resolved empty webhook/key lists. Inspected dark screenshot /tmp/honmaru-production-webhooks-20261025.png. No key/webhook was created and no external event was sent. This verifies display after restart, not a permanent fix for the initial load failure. Main CI 40172107917 still had Worker running at the last check; Web deploy remains successful.

Internal file upload now creates a tracked per-upload R2 key, validates exact bounded byte length/hash before storage, verifies stored size, then commits through the live-authority/version/lease fence. A lost DB commit response checks authoritative history before deleting any object. Failed deletion uses the existing media deletion queue. FixedLengthStream cancellation produced unhandled runtime rejections in failure tests; replaced it with a single capped payload buffer before R2 put. Both focused suites passed (21 tests, zero unhandled errors), including empty content, competing uploads, revoked membership, short/long payloads, cleanup failure and lost commit response. Log: /tmp/honmaru-file-upload-tests.log.

Still internal and unreleased: tracked upload recovery, retention/holds/purge/account lifecycle, routes and UI remain necessary. No production migration or file API exposure was added. KY-073 and full parity remain incomplete. No paid service or Simple-mode change.

## Interrupted file upload recovery (2026-10-25, internal only)

Added a bounded recovery pass with a SQL lease-revocation fence. Expired stages transition to cleanup only if no immutable version references their object key; committed stages are removed without deleting content. Cleanup markers survive removal of the file identity and are retained/revisited hourly because an R2 write can complete after an earlier deletion. A failed R2 delete enters the existing retry queue and is reported as failed, not cleaned. No claim that observing one absent object proves permanent removal. The stage expiry index and bounded pass keep each invocation limited; scheduling and eventual tombstone compaction remain part of lifecycle integration before exposure.

Real D1/R2 focused suites passed 24 tests, zero unhandled errors (/tmp/honmaru-file-upload-recovery-tests.log). Additional evidence covers a put completing after recovery, a later object reappearance, a committed upload with lost response, file identity deletion, active lease preservation, bounded batches and deletion failure accounting. No production schema, route, cron or UI exposure yet. Main CI 40172107917/job 121104939479 remains in progress at the last authoritative check; other required jobs and Web deployment succeeded. Full parity remains incomplete.

## File restoration and guarded download (2026-10-25, internal only)

Restoration now reads an authorized historical object and copies its bytes to a fresh staged key. The final immutable append verifies the original version still exists unpurged, its hash/type/size match the copied bytes, the caller still has access, and the expected current version still matches. A successful restoration records restored_from and never rewinds history or shares the old object key. Internal download verifies size/hash and rechecks live authority/purge after fetching bytes; returns an attachment with no-store, nosniff and restrictive CSP, without a durable signed URL.

Focused real D1/R2 suites passed 32 tests, zero unhandled errors (/tmp/honmaru-file-restore-tests.log). Added cases cover deleted-file restoration, independent object identity, stale restore rejection, corrupted bytes, purge during copying, revoked read permission, and download revocation/purge races. These helpers are not HTTP routes or production features. Lifecycle/hold/purge/account integration, API and UI remain incomplete. No schema deployment, added charge or Simple-mode change. Main CI 40172107917 Worker remained live at latest check; no restart was attempted.

## Historical file purge foundation (2026-10-25, internal only)

Rechecked https://docs.kylon.io/cli/workspace/file: historical purge is Human-only, creator or room admin, requires an audit reason, refuses the current version; all-history purge of deleted files is also required and remains pending. Implemented the single-version internal primitive using current scope authorization plus creator/workspace-admin authority. Independent room-admin roles and HTTP Human-principal binding remain integration work; no public route exists. An initial admin-only draft was corrected before commit to permit the creator.

The purge marker (actor/time/reason) and physical media deletion queue entry commit in one D1 batch. Active person holds covering file/version creators or channel holds covering the stored scope prevent purge. Current content is refused. Shared historical object keys are retained until every reference is purged; append refuses keys already purged or queued for deletion. Purge is logically irreversible at the transaction; subsequently created holds cannot restore already purged bytes. Account-deletion identity snapshots and broader retention integration remain pending.

Focused D1/R2 suites passed 38 tests, zero unhandled errors (/tmp/honmaru-file-purge-tests.log), including current-version refusal, unauthorized members, creator permission, missing reasons, active/released holds, inaccessible scope despite admin role, shared keys, queue creation and retired-key reuse refusal. No real user data purged, no production deployment, no paid service, Simple unchanged. File feature and full Kylon parity remain incomplete.

## Deleted-file history purge and durable hold identity (2026-10-25, internal only)

Added whole-history purge for a deleted file with a required expected current version. Live content and stale confirmations after restoration cannot be purged. Any active hold covering any historical writer blocks the whole operation rather than partially purging history. Single-version purge retains its version-specific behavior. Files and immutable versions now snapshot the creator login at creation; hold checks use both the historical login and current identity, preserving old-login holds across rename or user removal. This schema remains unreleased; production migration is still intentionally absent.

Focused suites passed 42 tests, zero unhandled errors (/tmp/honmaru-file-purge-all-tests.log). New checks cover whole-history deletion, repeat invocation, queue counts, stale expected version, restored content, historical-writer hold, and rename/deletion of that writer. No production user content was deleted. Human principal binding, independent room-admin semantics, retention/account cleanup, API/UI, migration and deployment remain outstanding.

Main CI 40172107917 for production 66591eea is now completed SUCCESS, including previously running Worker 121104939479. All required jobs succeeded; Windows/iOS were skipped by workflow policy. Web deploy 40172107975 remains successful. This CI result covers that published UI revision, not these later internal file changes. Full parity remains incomplete, no new service charge and Simple unchanged.

## File listing/search foundation (2026-10-25, internal only)

Added scoped current-version metadata listing with live per-file authority, explicit room/workspace/all-visible scope selection, literal case-insensitive path search, directory-prefix filter, MIME buckets, creator/date filters, optional deleted files and bounded keyset pagination by path/id. Omitted scope is rejected rather than silently becoming a cross-room search. Incomplete initial uploads have no current version and remain absent; object keys and hashes are not serialized. Added an organization/path/id index for pagination.

Focused D1/R2 suites passed 45 tests, zero unhandled errors (/tmp/honmaru-file-list-tests.log). Coverage includes metadata shape, literal wildcard text, type/creator/date/prefix filters, private-room visibility, revoked membership, deleted-file inclusion, uncommitted files, pagination and invalid scope/range bounds. This is an internal query, not a published Files screen or API. Lifecycle integration and UI remain required; full parity remains incomplete. Simple and production behavior unchanged; no new service charge.

## Workspace deletion integration for file storage (2026-10-25)

Inspected existing workspace deletion: it discovers org-scoped tables automatically and deletes the org object prefix, but late uploads could complete after that prefix sweep. Added optional-table cleanup fencing at purge start: retained upload cleanup records are stripped of actor/file identity and marked for recovery; ordinary file/version/purge rows are still removed by the existing generic deletion. Recovery can remove an object reappearing after the prefix sweep. File authority now rejects workspaces whose purge has started or whose deletion tombstone exists, even if a membership row temporarily survives. Scheduled grace periods retain the existing behavior.

Focused suites plus existing workspace deletion tests passed 55 tests, zero unhandled errors (/tmp/honmaru-file-workspace-deletion-tests.log). Added end-to-end storage fixture verifies generic deletion removes data, anonymizes the cleanup record, then recovery removes a simulated late put. Another test verifies claimed/completed deletion prevents reads, listing and uploads. No actual workspace deletion was performed. Changes remain local and unreleased. Recovery scheduling, account erasure/export, retention/holds and public API/UI still require integration before exposing file storage. Existing workspace deletion policy is unchanged; this does not claim a new workspace-wide hold policy. No new charge or Simple removal.

## Account export and in-flight file cleanup integration (2026-10-25)

Inspected account.js policy before integration: shared organizational records survive with identity removed, while personal data is erased. Added workspace file identities and own version metadata to account export, filtered through current file scope authority; no object keys, hashes or durable download credentials are exported. This is metadata export, not a complete binary archive. Missing unreleased file tables follow the existing optional-table behavior.

After account membership/credential removal, deletion now marks the user's remaining upload stages for cleanup and clears the actor. Live authority prevents new stages and in-flight commits; late R2 completion is cleaned without publishing a version. Existing account deletion tests and file suites passed 60 tests, zero unhandled errors (/tmp/honmaru-file-account-tests.log), including account export after room access loss and deletion during an actual paused storage write.

Still pending before file exposure: anonymization of identities in already committed shared file/version records while preserving active hold evidence; personal DM/agent file erasure; binary export; retention, public routes/UI and production deployment. No claim that full account erasure integration is complete. No actual account deletion was performed. Simple retained and no new charge.

## Shared file identity erasure (2026-10-25, internal feature)

Account deletion now anonymizes shared file/version author identity after removing the user, without changing content or history. The immutable-version trigger permits only the exact deleted-user identity substitution when the author account no longer exists; every content/key/hash/size/version/time field must remain identical. Active person/channel holds preserve identity evidence internally. File lists and history serialize deleted-user for absent author accounts even while a hold retains the internal evidence. The anonymizer can be invoked again after hold release; automatic post-release scheduling remains outstanding.

Focused file and existing account deletion suites verify exact before/after preservation, protection against content modification disguised as anonymization, active-hold preservation, public metadata redaction, release/retry, and refusal to anonymize a still-existing user. No real account deleted. Schema is still unreleased, so the revised initial trigger has not been applied to production. Personal DM/agent file erasure, purge-audit identity policy, retention/release scheduling, binary export, API/UI and production rollout remain incomplete. No new charge, Simple retained.

Final focused validation: 63 tests passed, zero unhandled errors, /tmp/honmaru-file-anonymization-tests.log.

## Deferred account erasure and periodic recovery (2026-10-25, unreleased)

Account deletion durably queues file identity reconciliation before removing identity. Bounded recovery retries held records hourly, never erases an existing account, and removes the queue's retained login after all file author fields are anonymized. The anonymizer still runs immediately after normal account deletion. Interrupted requests remain tracked rather than implicitly authorizing account removal.

Added file maintenance to the existing hourly scheduled branch, under the existing spend brake. It requires all five file tables; absent/partial unreleased schema is a no-op. Upload cleanup and account reconciliation run independently and settle before reporting a failure. No new schedule/service was created. This is source integration, not proof of production execution.

Focused suites passed 66 tests, zero unhandled errors (/tmp/honmaru-file-erasure-recovery-tests.log); index.js syntax and diff whitespace checks passed. New tests cover active hold/release recovery, retained identity removal, live-account protection and partial-schema no-op. Personal file erasure, retention, binary export, public APIs/UI and deployment remain outstanding. No actual user data deletion or new charge; Simple unchanged.

## Personal-room file erasure (2026-10-25, unreleased)

Account reconciliation now removes up to 25 eligible personal files per pass before shared-author anonymization. Scope matching uses literal delimited DM participants and agent-room suffixes, not LIKE wildcards. Current/historical content keys enter the existing physical deletion queue atomically with identity removal; upload stages retain anonymous cleanup keys for late writes. A shared file referencing the same legacy object protects that object. An active channel hold or matching creator/history-author hold prevents removal. The account reconciliation queue remains until personal files and retained author identities are gone, allowing post-release and bounded follow-up work.

Tests exercise exact/similar login room names, DM and agent scope removal, shared preservation, actual media retry deletion, held personal data and post-release recovery. No real account/file was deleted. Public file routes/UI, retention policy integration, binary export, room-admin policy and production deployment remain outstanding. Existing Simple behavior preserved; no new charge.

Final validation: 69 focused/account tests passed with zero unhandled errors, /tmp/honmaru-personal-file-erasure-tests.log, including shared-object protection during personal erasure.

## Renamed/departed writer hold protection (2026-10-25)

Review found that personal-file erasure checked historical logins but could miss a hold targeting a writer's current renamed login. After that writer departed, joining only users also lost the mapping. Both personal erasure and historical purge now resolve held identities through current users and the retained file-account erasure queue, in addition to immutable creation-time login snapshots. The queue is retained precisely while held author identities remain, and its login is removed after successful reconciliation.

Regression fixtures cover rename, hold under the new login, departure of that writer, then departure of the personal-room owner; content stays until release and both requests reconcile afterward. A separate historical-version fixture verifies creator-authorized purge remains blocked after the renamed writer departs and succeeds only after hold release. No production operation or data deletion; full file/UI parity remains incomplete.

Final validation: 71 focused/account tests passed, zero unhandled errors, /tmp/honmaru-file-renamed-hold-tests.log. Simple unchanged; no added charge.

## Historical file retention foundation (2026-10-25, internal only)

Added bounded historical-content expiration using existing org_governance.retention_files_days. Null/unset/nonpositive policies do not expire content. Each purge rechecks the current positive integer policy, age and holds inside the same transaction that records the system retention reason and queues object deletion. Current versions are explicitly excluded even when old; their expiration requires a separate tombstone transition, still pending. Shared legacy object references remain protected.

Fixtures cover opt-in behavior, eligible historical purge, current-version survival, person hold exclusion, and a policy disabled between candidate selection and transaction. No scheduler connection or production exposure yet for retention; this does not complete retention semantics. No real content deleted, new service or Simple change. Current-version expiration, APIs/UI, binary export and deployment remain outstanding.

Final focused validation: 74 tests passed, zero unhandled errors, /tmp/honmaru-file-retention-tests.log, including explicit survival of an already expired current version under this history-only helper.

## Current file expiration and maintenance connection (2026-10-25, unreleased)

Added current-version expiration as an atomic append of a system:retention deletion tombstone plus expected-version current-pointer update. Source version, current policy and holds are rechecked inside the transaction; a concurrent fresh write or newly introduced hold prevents expiration. Historical purge then runs with its own fresh policy/hold check. The system actor is preserved in serialized history rather than mislabeled as a deleted user. Both phases are bounded and connected to existing hourly file maintenance, alongside upload and account cleanup; no new paid service or schedule.

Focused suites passed 77 tests, zero unhandled errors (/tmp/honmaru-current-file-retention-tests.log). Added cases prove tombstone-before-purge, repeated expiration no-op, a newer write winning the race, and a hold added after candidate selection. Existing account and file checks pass. This verifies local D1/R2 fixtures and source scheduling, not production execution. Public routes/UI, binary export, room-admin semantics, migrations and rollout remain outstanding. Simple retained and full parity incomplete.

## File read transport adapter (2026-10-25, not mounted)

Added GET adapters for scoped list/search, version history and version content. Query validation rejects omitted scope, malformed cursors/numbers/deleted flags; caller-supplied authenticated org/user identity is used instead of query identity. Download preserves attachment/no-store/nosniff protections and trusted CORS headers. Non-GET requests return 405 and unknown file paths 404. The adapter is deliberately not registered in handleHarness yet; existing member() authentication was inspected and will supply identity at mounting. Unit transport tests do not prove session authentication or deployed routes.

Focused file/account suites passed 79 tests with zero unhandled errors (/tmp/honmaru-file-read-routes-tests.log), including successful metadata/history/content transport, invalid input and caller-vs-query identity. Public API mounting, write adapters, room-admin semantics, binary export, Files UI, migrations and deployment remain incomplete. No production behavior changed, new service or Simple removal.

## File write transport adapters (2026-10-25, not mounted)

Added create-identity, raw-byte upload, tombstone deletion, historical restore and historical/whole-deleted-file purge adapters. Uploads require exact declared size and expected current version; JSON commands are capped at 8 KiB. Identity/build permission/principal type come from the trusted authentication caller, never command fields. Permanent purge refuses non-Human principals. Failed authority/expected-version mutations return generic conflict responses without exposing file existence. No claim of authenticated public route completion: these adapters are still unregistered and the outer session/build/grant/audit integration remains required.

Focused suites passed 82 tests, zero unhandled errors (/tmp/honmaru-file-write-routes-tests.log). Fixtures perform create/upload/stale-delete/delete/restore/download; verify permission/principal spoofing refusal; reject missing versions, oversized commands and declared-length mismatch without publishing a version. UI, route mounting, room-admin policy, binary export, production migrations and rollout remain incomplete. No real file changes or new charge; Simple maintained.

## Room administration for files (2026-10-25, unreleased)

Connected file delete/purge authority to existing independent hx_room_roles for managed business rooms. A person room-admin grant must match both current workspace membership and room participation timestamps; role removal or room rejoin invalidates it. Creator and existing workspace-admin behavior remain, with independent scope authorization still required. File scope authorization now also refuses a managed room carrying deleted_at even before its business row is archived.

Real D1 fixtures verify a member-level workspace user with room-admin rights can delete/purge another creator's file, stale grants after rejoin and demotion cannot delete, and a deleted room refuses read/list/upload. Other scope/hold/retention/account checks remain in the focused suite. This uses existing room-role semantics, not a new grant system; no Simple-room roles were initialized or changed. No production deployment or new charge. Public route mounting, Files UI, binary export and migration/rollout remain incomplete.

Final validation: 85 tests passed, zero unhandled errors, /tmp/honmaru-file-room-authority-tests.log.

## Authenticated file routes mounted in source (2026-10-25, not deployed)

Registered file read/write adapters ahead of generic JSON parsing in handleHarness. Existing member() validates session, membership and workspace policy; guests are refused. Build permission comes from allowed(), and the session-only entry supplies Human principal type. Raw upload streams remain unread until the upload adapter. Existing media/team rate limits apply; successful changes record workspace.file_changed audits without content. All five file tables must exist or authenticated requests receive 503. No production migration/deploy yet, so this is source mounting, not live availability.

Worker.fetch integration tests pass (3) in /tmp/honmaru-files-http-auth-tests.log: session-based create/upload/read/conflict/delete/restore/list with four success audits; missing-session/guest/partial-schema refusal; admin cannot bypass private scope or another workspace. Earlier core file suites passed 74 tests in /tmp/honmaru-files-http-tests.log. An initial test-file write used the wrong relative directory and failed before creation; corrected the path and ran the new HTTP suite explicitly, so that earlier core-only pass was not counted as HTTP evidence. No production data changed, no new charge, Simple unchanged. Files UI, binary export, migrations, complete release checks and rollout remain incomplete.

## Web file client and live Kylon panel reference (2026-10-25)

Added a typed workspaceFileApi exposed through harnessApi.files: scoped search/cursor, create/upload, history, blob download, version-fenced delete/restore and Human purge commands. Org identity is included in every route query; credentials stay in headers. Binary upload is not JSON-encoded and DELETE retains the expected-version body, unlike the generic existing harness helper. Abort signals are supported for reads/uploads. HTTP conflicts preserve status and are not automatically replayed. Three focused Web client tests and full Web TypeScript checking passed (/tmp/honmaru-file-web-client-tests.log, /tmp/honmaru-file-web-client-types.log). This is client plumbing, not a rendered Files UI.

Native Kylon initially showed a blank window; quit/reopen restored the authenticated account. Opened general, then Files without sending messages or uploading anything. Live panel is on the right, approximately 360 px wide, rounded border and inset beneath the room header; title/close, creator filter Agent/User, recent/folder icon toggle, upload icon menu (file/folder), and centered creator-specific empty state. Reference /tmp/kylon-room-files-reference-20261025.png. Native AX confirms exact labels and roomPanel=files navigation. Room has no files in either observed creator tab, so populated rows/history/preview remain unverified. The backend still needs agent-origin classification/folder behavior for these controls; do not fake these with static tabs. No production deploy, paid action or Simple removal.

### 2026-10-25 — room files panel integration (unreleased)
Added the Harness room Files panel with search, keyset pagination, version history and authenticated downloads. Message attachments remain accessible from its footer; Simple mode is unchanged. Room views resolve through an authenticated `/hx/files/scope` endpoint and the file audience predicate, rather than treating DM/agent display IDs as stored scopes. Applied existing Harness theme tokens for both appearances; downloads abort when leaving history. TypeScript passed including the final cancellation adjustment; four real Worker HTTP tests passed including rejected missing/private scopes, guests and unauthenticated callers. Honmaru native production API & Webhook screen was accessible via CUA without an unlock request.

The new panel has NOT been visually verified or deployed. Upload UI, creator tabs, folder view, previews, full history pagination, production schema migration and release checks remain outstanding. KY-073 and 100% parity remain incomplete; no new paid services.

### 2026-10-25 — file and folder upload controls (unreleased)
Added file/folder picker menu, relative folder paths, sequential uploads, per-file outcomes and explicit failed-upload retry to the room file panel. Successful path reservations retain their ID during retry, with expectedVersion=0 so retry cannot overwrite an existing content version. Aborting/unmounting stops content transfer and subsequent files; 25 MiB checks happen before reservation. Added Japanese strings and existing Harness theme colors. Six client/component tests pass, including reservation reuse after transfer failure, unmount during reservation, oversized rejection and binary transport/conflicts. TypeScript passes.

Remaining: persistent recovery of an initial reservation when its response is lost or the panel closes, empty reservation cleanup, actual rendered picker/upload verification, creator classification/tabs, folder browsing, preview, history operations, migration and deployment. No production exposure or parity-complete claim. Simple mode and message attachments remain unchanged.

### 2026-10-25 — replayable initial file reservations (unreleased)
The upload UI now assigns a stable random request ID before its first create request and preserves it across explicit retries. The authenticated create route accepts that ID and recovers an existing reservation only for the same actor, scope and normalized path with current_version=0 and live file authority. Conflicting paths, other authors and published content return conflict; malformed request IDs return 400. No new schema is required for this operation. Five Worker HTTP tests and seven client/component tests pass, including lost create response replay and protection of another author's reservation and existing bytes. TypeScript passes.

This closes lost-response recovery while the upload job remains mounted. Cross-reload recovery, abandoned empty-reservation cleanup, rendered QA, remaining Kylon file controls and production migration/deployment are still pending. No full parity or production completion claim.

### 2026-10-25 — production file schema migration registration
Registered the five file tables, three indexes and immutable-version trigger as single-line idempotent CREATE statements in migrations.sql, consumed by the existing deploy migration runner. The global Worker test setup now creates workspace-files.sql before migration indexes. A new real D1 test drops the file tables to emulate an older database, executes the actual production statements twice and checks all tables, the trigger, key columns and agreement with the source definition. File ledger/upload/API and account/workspace deletion tests all pass: 99 tests across six files, log /tmp/honmaru-file-migration-all.log.

Initially adding these definitions to the monolithic schema.sql caused the flattened test setup statement to exceed D1's size limit; that change was removed. Fresh and existing deploys both run migrations.sql after schema.sql, so the existing production path handles these additions without expanding the monolithic statement. No workflow configuration changes and no production migration was executed in this turn. Full CI, rendered file UX verification and production deployment remain outstanding.

### 2026-10-25 — integrated release candidate and visual component check
Integrated production main 25927232 (channel guest invitation) into primary work as 719a02e1, preserving that independently shipped change. Candidate acde74524a0d5a6423876db95bb85917a31a68a8 uses the same source tree with current main as parent and was pushed to codex/workflow-program-runtime. CI 40176456955: Web, Desktop, Shared core/mobile, Gateway and Relay succeeded; Worker and E2E still running at this observation. Local integrated Web tests: 1,169 passed and production build passed. Local full Worker test remains live as exec session 79801; do not restart it based on absent final output.

CUA rendered the actual WorkspaceFilesPanel in a temporary localhost fixture with mocked file API and existing Harness CSS/theme tokens. Confirmed list-to-history navigation, dark history text/dividers/download icons and the file/folder upload menu. Screenshot: /tmp/honmaru-file-history-dark-20261025.png. This is component layout evidence, not authenticated production save/download or full-shell parity evidence. Temporary fixture files removed and Vite process stopped. No main promotion or production deploy in this turn.

### 2026-10-25 — complete history paging controls (not yet in release candidate)
The file history panel now requests older pages with the oldest displayed version as an exclusive cursor and offers a return to the latest versions. It stops offering older pages when the page has fewer than 50 rows or reaches version 1. A component test with 51 versions verifies boundary traversal and return to current history; TypeScript passes. This source change follows candidate acde7452 and requires a subsequent candidate before release. Existing candidate CI 40176456955 Worker and E2E remain in their test steps; do not restart either based on this waiting observation.

### 2026-10-25 — history restore interaction (not in candidate acde7452)
Added restore actions for non-current, unpurged content versions. The UI submits the currentVersion observed in the history response, then reloads history at the latest page and refreshes the list after success. Conflicts display a refresh instruction without retrying the mutation against a different version. A synchronous guard prevents double restore dispatch and leaving the history prevents late UI updates. Three history component tests and TypeScript pass, covering paging, restore refresh and failed restore without automatic retry. Existing Worker tests already cover versioned restore and live authorization; actual production restore remains unverified. CI 40176456955 Worker/E2E and local full Worker session 79801 are still live at this observation.

### 2026-10-25 — deleted file visibility and recoverable removal
Added an explicit include-deleted checkbox to file listing and a recoverable removal action on the currently loaded content version. Removal uses the history response's currentVersion, refreshes history/list on success, and reports conflicts without retry. Deleted rows are labeled; history restore remains available for retained unpurged content. Permanent purge is not exposed by this control. Four panel tests and TypeScript pass, including default exclusion, explicit inclusion and observed-version removal. These UI changes remain after candidate acde7452 and are not deployed. Full Worker local session 79801 and candidate CI Worker/E2E remained running during this turn.

### 2026-10-25 — full-suite regression diagnosis
Full Worker run (session 79801, still running) exposed a deterministic failure in complimentary-sync's account-deletion interleaving test. Reproduced alone: the test DB wrapper supplied prepare but omitted batch, now used by file-account anonymization after the file schema is present. Added batch delegation to the real test D1, preserving the deliberate users DELETE pause and all tombstone assertions. All 21 complimentary-sync tests now pass. This is a test adapter repair; runtime deletion behavior and assertions were not weakened. Updated Web suite including history/removal controls passes 1,173 tests and production build passes. Candidate acde7452 predates this repair and the new history controls and must not be promoted as the final updated tree.

### 2026-10-25 — upload menu keyboard behavior
The upload menu now focuses its first action when opened, closes on Escape from the trigger or menu and restores trigger focus, and dismisses on an outside pointer event. TypeScript passes; this interaction refinement has not yet received a second CUA check. Worker/E2E run 40176456955 and local full test session 79801 remain active; no premature restart or production promotion.

Local full Worker session 79801 completed: 236 files passed / 1 failed; 2,041 tests passed / 1 failed, 579.75 seconds. The sole failure is the already-reproduced and repaired complimentary-sync DB wrapper issue (67cec372); its focused 21-test rerun passed. This is not a claim that the corrected full suite has passed yet. Remote candidate Worker/E2E remained running at the final observation.

### 2026-10-25 — authenticated historical document previews (after candidate 4d5a8249)
Connected PDF/CSV/text preview actions for retained content versions to the existing document renderers. The new dialog downloads through the session-authenticated file API for the selected exact version, bounds PDF to 25 MiB and text/CSV to 2 MiB, checks metadata before fetching, aborts on close and times out after 30 seconds. HTML follows the existing escaped text renderer, never an executing iframe. No message-attachment conversation ID is reused for workspace files. Six preview/history component tests and TypeScript pass, including preflight oversized rejection and aborting the precise-version request. Image previews, renderer-failure recovery and actual full-shell visual verification remain outstanding; this source is not in the currently running release candidate.

### 2026-10-25 — raster previews and contained rendering failures
Added raster preview for explicit PNG/JPEG/GIF/WebP/AVIF MIME types, with 25 MiB bounds, image decode error feedback and object URL cleanup. Unknown image types/SVG do not select image rendering; HTML remains escaped text. A component error boundary contains document renderer/lazy-load failures inside the closable preview dialog with retry. Eight focused preview/history tests and TypeScript pass, including raster decode failure/URL revocation and MIME classification. Actual image/PDF visual QA and large-image pixel/memory behavior remain unverified. These changes follow candidate 4d5a8249 and are not deployed.

### 2026-10-25 — document preview rendered verification
CUA opened the actual WorkspaceFilePreview and shared document renderer in a temporary localhost fixture. CSV displayed three rows, correctly kept a quoted comma inside one cell, and searching Honmaru produced one highlighted match with 1/1 navigation. Closing returned to the fixture launch buttons. HTML markup including a script assigning the page title remained visible as literal text; title remained unchanged. Screenshot /tmp/honmaru-csv-preview-20261025.png captures the dark CSV view. These checks use mocked authenticated-download bytes, not production authentication, and do not establish PDF/image/mobile parity. Temporary fixtures removed and dev server stopped afterward.

### 2026-10-25 — append a new file version from history
Added a replacement-file picker for the current live content version. It sends raw bytes to the existing file identity with the history response's currentVersion, rejects files over 25 MiB before transfer, aborts transfer on leaving the history and refreshes history/list after success. It never silently retries a conflicted replacement against a newer revision. Five panel tests and TypeScript pass, including replacement identity/version/body and refresh assertions. Picker interaction and authenticated production replacement remain unverified. Source follows candidate 4d5a8249; current candidate CI is still running.

### 2026-10-25 — uploads survive list/history navigation
Moved the room upload controller outside the conditional list/history content. Opening an existing file's history no longer unmounts and aborts an unrelated in-flight upload; its status remains available above history. Closing the panel or changing its scoped parent still aborts the transfer. Six panel tests and TypeScript pass, including a controlled pending transfer that survives history navigation, refreshes on completion and releases its signal on panel unmount. This fixes an unintended interruption found in source review. Not yet deployed.

### 2026-10-25 — release gate scope and isolated UI database
Candidate 4d5a8249 E2E job 121119860043 succeeded. Inspected its log: existing chat/guest/app/workflow/program paths pass, but it does not exercise the new /hx/files UI roundtrip. Worker job 121119860004 remains live. Old candidate Worker log confirms exactly the same sole complimentary-sync wrapper failure as local (2,041 passed, one failed), already repaired in 4d5a8249.

Prepared an isolated local D1 at /tmp/honmaru-file-ui-db for upcoming CUA file operation testing. Fresh schema.sql and all CREATE statements from migrations.sql executed successfully via local Wrangler. No Worker/web process started for this database yet, and no production data or credentials used. This setup does not constitute UI roundtrip completion.

### 2026-10-25 — real local full-shell file verification started
Started mail sink session 84543, local Worker session 42572 (isolated /tmp/honmaru-file-ui-db, localhost:8787) and Vite session 2343 (localhost:4173, local API). Health shows fallback AI and no billing/connectors. Through CUA tab 6 (fileRoundtrip), signed up synthetic file-ui-20261025@example.test via local mail sink, completed onboarding without reports/notifications, switched Simple to Harness through Profile → Harness, created empty File verification room, and opened Files. Actual scoped file API returned an empty list without error. No token extraction or production writes. Tab marked for handoff. Synthetic upload fixtures: /tmp/honmaru-file-ui-v1.txt and /tmp/honmaru-file-ui-v2.txt. Upload/update/restore/reload verification remains next; keep these live service sessions rather than starting duplicates.

### 2026-10-25 — real local file roundtrip and first production promotion
CUA tab 6 used the real local API/D1/R2: uploaded /tmp/honmaru-file-ui-v1.txt as v1, appended v2 from the replacement picker, previewed the version-two body, restored v1 into new v3 and verified the version-one body. Moved the file to deleted state v4, verified it disappeared from default listing and reappeared with include-deleted, restored v3 into v5, reloaded the app and reopened Files to verify persisted v5 (39 bytes). Screenshots /tmp/honmaru-file-restored-v3-20261025.png and /tmp/honmaru-file-v5-after-reload-20261025.png. During reload the initial shell briefly showed Simple before remote Harness mode loaded; investigate this visual flash separately. Current label remains untranslated in this local history. Services 84543/42572/2343 remain available; CUA tab marked handoff.

Candidate 4d5a82491d41264e19a6521b8fcfb3d48acc975c CI 40177043869 passed all seven required jobs, including Worker 121119860004 and E2E 121119860043. Verified remote main still 25927232 and fast-forwarded main to the exact candidate. Production deployment has been triggered, NOT yet verified complete. This candidate includes versioned file backend/list/history/paging/restore/deletion/upload and the DB-wrapper fix. Later source additions (preview, replacement upload, retaining uploads during history navigation) are NOT part of this first promotion and need their own candidate. Local latest-tree roundtrip is not evidence that those later controls are live in production.

### 2026-10-25 — real local search and historical download
CUA in authenticated local full shell searched missing-fixture (empty result) then honmaru-file (persisted v5 row returned). Opened history and downloaded v2 through its UI control; the browser saved /Users/tt/Downloads/honmaru-file-ui-v1.txt. Compared bytes with /tmp/honmaru-file-ui-v2.txt: exact 39-byte match, confirming the older requested version rather than current v5 was returned. The localized current-version label is visible. Screenshot /tmp/honmaru-file-history-download-20261025.png. No production write; live local services and tab retained. Candidate 011031fc CI 40178294653 remains the next unpublished change set; first production deploy 40178191987 is still testing and Web 40178191996 waits for it.

### 2026-10-25 — hierarchical file browser, local verification
Added scoped server-side folder listing with distinct direct children, bounded cursor pagination, live file authorization and include-deleted filtering. File listing gains opt-in directOnly (default recursive behavior preserved). Web Files now switches between all files and folders, offers breadcrumbs and separate folder/file pagination; search is recursive within the selected directory. Folder icons and selected states use existing theme variables.

Validation: Worker file ledger/upload/migration/HTTP suites 81 passed; full Web suite 1,180 passed; production Web build passed. CUA local full shell verified root → QA folder → Nested, with only direct files shown and breadcrumb navigation present in dark mode. Screenshot /tmp/honmaru-files-folders-20261025.png. Test folder rows were seeded into isolated local D1 by copying the existing synthetic fixture's content reference; this is explicitly NOT a folder-upload roundtrip. CUA directory file chooser returned no files for both directory and file-list selections, so native folder upload remains unverified. No production data changed by this verification. First production release remains awaiting Worker tests and Web deploy; next candidate 011031fc does not include this folder-browser change.

### 2026-10-25 — selected folder upload and production dialog inspection
Uploads now capture the open directory as their destination at selection time. Retries preserve that original destination even if folder navigation changes. Focused upload/panel suites: 12 passed; Web build passed. CUA uploaded /tmp/honmaru-file-ui-v2.txt using the normal file chooser while QA folder was open. Real local API saved QA folder/honmaru-file-ui-v2.txt, v1, 39 bytes, and the row appeared in that folder. Screenshot /tmp/honmaru-selected-folder-upload-20261025.png. This verifies file upload into an existing folder, not the native directory chooser.

The installed production Honmaru AI app is operable. Opened API & Webhook → Create webhook: URL/name fields, event checkboxes, DM opt-in and disabled submit for blank input were visible; cancelled without creating a webhook or credential. Screenshot /tmp/honmaru-production-webhook-dialog-20261025.png. Production release 4d5a8249 still has Worker Test running and Web waiting; no new deployment-completion claim.

### 2026-10-25 — recent file ordering
The Files panel now defaults to Recent, ordered by updated timestamp descending, with stable ID tie-breaking. Folder view retains alphabetical order. HTTP search accepts an explicit recent order and validates timestamp-bearing keyset cursors; old path-order clients are unchanged. API test pages through equal-timestamp rows with limit=1 and verifies no skipped rows; invalid order/cursors return 400. HTTP 7 tests and Web focused 10 tests passed; Web build passed. CUA real local listing showed the just-uploaded QA folder/honmaru-file-ui-v2.txt first. Screenshot /tmp/honmaru-files-recent-20261025.png. No production-completion claim; creator tabs/agent tools and Kylon populated reference remain unfinished.

### 2026-10-25 — raster and PDF preview with real local storage
CUA uploaded a synthetic 64×64 PNG (8,482 bytes) through the local full-shell file picker, opened v1 history and preview, and visibly rendered its gradient image. Screenshot /tmp/honmaru-real-raster-preview-20261025.png. Uploaded the repository's e2e/fixtures/document-preview.pdf (874 bytes), opened the saved v1 preview, verified page 1 text “Invoice 42 - first page”, then navigated to page 2 and verified “Invoice 84 - second page” and disabled Next. Screenshot /tmp/honmaru-real-pdf-page2-20261025.png. Closed previews normally. These use authenticated local HTTP/D1/R2, not component fixtures. Production preview availability remains unverified.

Main 4d5a8249 CI 40178192061 now passes all seven required jobs. Deployment 40178191987 remains live in Test, Web 40178191996 waits; candidate 011031fc CI 40178294653 still has Worker running. Folder candidate 2982c45c was pushed and CI 40179077741 is pending behind its predecessor. Recent-order source commits follow that candidate and have local validation only so far. Do not promote untested source HEAD or report these changes deployed.

### 2026-10-25 — bounded empty reservation maintenance
Added seven-day cleanup for file identities that never acquired a version. A single bounded DELETE rechecks zero current version, absence of any saved version, absence of any unfenced uploading stage, and active channel/person holds (including deleted-account login aliases). Cleanup stage rows stay durable to remove late R2 puts. The hourly maintenance runner includes this operation; partial schema remains a no-op. Tests cover batch limits, recent reservations, saved content, expired but unfenced uploads, fenced stage preservation, hold release, path reuse and renamed deleted identities. File upload/lifecycle suite: 63 tests passed. This change is local/unreleased and introduces no schema or paid service.

Candidate 011031fc CI 40178294653 passed all seven required jobs. Verified main remained 4d5a8249, then fast-forwarded main to exact candidate 011031fc. This includes preview/replacement-upload controls, not later folder/recent/empty-reservation changes. Production Web job 40179600565 is pending behind 40178191996; Worker 40178191987 has completed tests and is applying D1 column additions. Do not report deployed until those jobs and production checks succeed.

### 2026-10-25 — production deployment verified; native caveats
Worker release 4d5a8249 deployment 40178191987/job 121123354236 succeeded, including D1 migration. Worker version 8b7424f6-e9a7-4d11-af13-97a6dbb4c75c. Web 4d5a8249 deployment 40178191996 succeeded, followed by Web 011031fc deployment 40179600565/job 121128110417. Deploy log and direct public fetch agree on index-C7dHlt5m.js at app.honmaruai.com; Pages deployment https://428d9e73.honmaru-web.pages.dev. Health via curl is HTTP 200, ok=true. Python urllib receives 403 on health, so do not treat that client-specific response as an outage.

Native installed app reload produced a blank surface: diagnostics show response 200, DOM/finish, layout-state=63 and inspect-visible, but screenshot stayed blank. Window zoom exposed AX nodes but did not restore visible pixels or click response. Quit/relaunch restored rendering and retained sign-in; this is recovery, not a permanent fix. Reopened existing one-member QA Webhook 2026-10-23 room → Files: scoped API returned the normal empty state, no error. Screenshot /tmp/honmaru-production-files-panel-20261025.png. Attempted only synthetic /tmp/honmaru-file-ui-v1.txt upload: native chooser selected and previewed the correct 39-byte file, but Open stayed disabled; Return had no effect and coordinate attempt returned noWindowsAvailable. Cancelled with Escape. No production file was uploaded. Authenticated production lifecycle and native picker remain unverified. IAB public production landing renders normally.

### 2026-10-25 — MCP read access to workspace files
Added Harness-only MCP list_workspace_files, list_workspace_folders, list_file_versions and read_file_text. Existing read scope is required; file policy binds identity/workspace to the key owner and rechecks current room access. Specific immutable text versions are limited to 128 KiB and valid UTF-8; binary/oversized/purged/unavailable data returns a controlled error. Returned content is explicitly untrusted; storage keys/URLs are never returned. Simple tool listing is unchanged. MCP integration/base suites: 16 passed, including scope denial, forged identity arguments, history, exact older content, inaccessible room, Simple mode, binary/large/invalid UTF-8/purge cases. Write tools and creator-origin tabs remain missing; this read integration is local/unreleased.

### 2026-10-25 — restore file navigation within the current tab
Added sessionStorage-backed file view state keyed by API host, workspace, user and room. Recent/folder selection, folder path, committed search and include-deleted restore when reopening/reloading the tab. No token, file contents or pagination cursor is stored. Invalid/oversized/unsafe state and blocked storage fall back to defaults. This is tab-local navigation persistence, NOT cross-device synchronization. Full Web suite 1,183 passed; build passed. CUA selected QA folder, searched v2, reloaded, reopened Files and verified folder mode, QA folder breadcrumb, v2 field and matching file row all restored. Screenshot /tmp/honmaru-files-view-restored-20261025.png. Initial Simple-shell flash before Harness mode arrives remains visible and unresolved.

Native picker follow-up: resolving /private/tmp instead of /tmp and Up/Down reselection did not enable Open. Selecting the synthetic QA directory also left Open disabled. Cancelled normally; still no production upload. Cause is not yet proven to be application code versus automation/native picker behavior.

Candidate d8f3e1b8 CI 40179706175 passed all seven required jobs. Verified remote main was still 011031fc, then fast-forwarded main to exact d8f3e1b8. It includes folder/recent navigation and empty reservation maintenance. Deploy completion for this candidate is not yet verified. MCP read tools and the tab-state persistence follow this release and are not yet live.

### 2026-10-25 — avoid the wrong shell during mode loading
Dashboard now waits for the authenticated workspace mode before rendering either shell, unless this browser explicitly chose Simple. The waiting UI has theme-aware colors. Failed or malformed responses show Retry and an explicit browser-only Simple choice. Mode GET is abortable with a 15-second timeout; stale/aborted responses cannot restore grants after retry or scope changes. Existing Simple functionality and server mode are unchanged by the fallback choice.

Validation: focused hook/loading UI suites 8 passed; full Web suite 1,186 passed; production build passed. Tests cover workspace/session isolation, persisted Simple opt-in, denied storage, failed load retry, timeout, malformed response and late-response rejection. CUA reloaded the real local Harness shell: the previously observed Simple content was not present in the post-reload AX state, and the loaded room rendered normally. Screenshot /tmp/honmaru-harness-reload-20261025.png. This observation is not a frame-by-frame guarantee or a fix for the distinct native blank-surface issue. New mode-loading change is unreleased; existing d8f3e1b8 deployment remains running.

### 2026-10-25 — bounded macOS repaint opportunities
Replaced the single immediate invalidation with four bounded paint requests after document load (0/1/3/10 seconds). Navigation/destruction cancels pending work; hidden/minimized/destroyed windows are excluded. No reload, geometry change, credential access or recurring timer is introduced.

Validation: desktop 128 tests passed and local unsigned dist:dir build succeeded. CUA ran the local build without replacing /Applications. Reloaded chat and API & Webhook screens both visibly rendered; after the API reload, clicking Create Webhook opened its form normally (no webhook submitted). Screenshots /tmp/honmaru-repaint-check.png and /tmp/honmaru-repaint-api-check.png. This limited observation does not prove the intermittent blank surface is eliminated. Desktop distribution remains unreleased.

### 2026-10-25 — compact file navigation toolbar
Matched the observed reference's compact list/folder icon switch and adjacent upload affordance. Tooltips and accessible labels preserve navigation meaning. Upload status stays in normal document flow, spanning the toolbar width; the upload component remains mounted while viewing history. Empty-file illustration now uses the file icon. Creator-origin tabs remain incomplete: existing ledger rows do not record a reliable human/agent origin and must not be guessed from user identity.

Validation: existing file panel/upload suites 12 passed; Web production build passed. CUA on the real local full-stack app verified folder/recent switching, upload-menu opening and Escape focus restoration in dark mode. Screenshot /tmp/honmaru-file-toolbar-20261025.png. This is local evidence, not production confirmation.

Release status: exact MCP candidate 5d1b7872 passed all seven required CI jobs and was fast-forwarded to main after d8f3e1b8. Its deployment is queued behind d8. Candidate 7b5c30bc E2E failed; do not promote until diagnosed and repaired.

### 2026-10-25 — preserve offline viewing behind the mode gate
Candidate 7b5c30bc E2E 40181025988 failed exactly the existing offline-shell scenario: Dashboard's new mode-loading gate prevented cached feed/card display without a server response. Fixed the application rather than weakening the E2E. Offline mode uses only the last confirmed presentation value keyed by server/workspace (no tokens, user data or grants), falling back to the existing Simple shell when unknown. canEdit remains false. Reconnection re-enters mode loading and fetches current server authority; no offline write permission is inferred.

Validation: mode hook 8 tests passed, including offline remount, workspace isolation and reconnect revalidation. Full Web 1,187 tests/179 files passed; build passed. Exact-candidate offline E2E is still required before promotion.

Deployment update: d8f3e1b8 Worker run 40180615717 and Web run 40180615691 both succeeded. Production HTML serves index-Dha3Y8Av.js. Main currently 5d1b7872; later mode-loading/repaint/toolbar changes are not production yet.

### 2026-10-25 — agent text edits preserve file history
Added MCP update_file_text for existing workspace files. It requires token write scope, live harness mode and harness.build membership permission; accepts an exact expectedVersion and valid UTF-8 text up to 128 KiB; preserves the file MIME type; uses the existing staged R2/immutable ledger compare-and-swap path. Current room access is rechecked by that path. Old versions remain readable. Stale/replayed writes fail without overwriting a newer version. Audit metadata records MCP source and authenticated agent token identity, without file contents. Binary writes are rejected.

Validation: harness MCP, core MCP and file upload integration suites: 81 tests/3 files passed. Added coverage for read-only denial, caller-identity spoofing, Unicode size and malformed text, old content preservation, stale writes, binary rejection, private-room access loss, permission loss, and Simple-mode exclusion. A first invocation from the repository root lacked the Cloudflare test environment; reran with the correct worker configuration and obtained the passing result above.

Scope still incomplete: this tool does not create new files, classify original human/agent creation, or supply binary output generation. Those requirements remain open. Production agent editing is not yet verified.

Release: fae6baed candidate CI 40180692215 passed all seven required jobs. Confirmed main was 5d1b7872, then fast-forwarded to fae6baed. Mode-loading/offline fixes remain behind candidate 56c660af CI 40182005007; do not promote until its offline E2E and Worker checks pass.

### 2026-10-25 — reliable original file provenance
Added replayable migration for hx_workspace_file_origins, a file-keyed human/agent classification without additional personal data. The origin marker and new ledger reservation commit atomically; a conflicting create cannot relabel an existing file. Deleting its ledger cascades the marker. Existing unclassified files remain unknown, with no inferred backfill. The authenticated HTTP upload endpoint assigns human origin independently of JSON input.

File and folder listings expose matching optional human/agent/unknown filters; MCP read tools expose them too. HTTP/MCP file readiness now requires the sixth table before using these queries. Existing maintenance remains usable against the previous five-table schema. Agent-created files and UI origin tabs are still not complete.

Validation: file migration, ledger, upload lifecycle, HTTP and MCP suites 94 tests passed. Added HTTP origin-spoofing/readiness coverage and reran its suite: 8 passed. Covers atomic creation, conflict preservation, unavailable-room rejection, matching file/folder filters, unknown legacy rows, invalid filters, cascading removal and replayable migration. Initial root-level test command lacked the Worker runtime; all reported passes used worker/ configuration.

### 2026-10-25 — agent creates new text files
Added MCP create_file_text with explicit room scope, normalized relative path, stable file-UUID request identifier, supported text MIME type and up to 128 KiB of Unicode text. The server records agent origin atomically with the reservation. Upload uses the existing staged blob and version-1 CAS path. Retrying an identical committed request returns its original receipt without a second version; a different payload/path, human reservation, inaccessible room or occupied path is rejected. A failed pre-commit agent reservation can resume. Requires write scope and live workspace build permission; Simple excludes the tool. No file content executes.

Validation: MCP and upload integration suites 83 passed, including same-ID concurrent retries, saved content, trusted origin, path collisions, altered replays, denied readers, inaccessible rooms, human reservation rejection, path traversal, invalid IDs/MIME, and byte limit. Follow-up BOM preservation correction passed the 10-test harness MCP suite. UTF-8 round trips preserve a leading BOM and reject unpaired surrogates.

Still incomplete: built-in conversation-agent wiring, binary generation/export, origin tabs in the web panel and production generation verification. CI 40182005007 E2E failed again; deployment remains gated while the failure is inspected.

### 2026-10-25 — retain Jam state before conversation mount
CI 40182005007's offline-shell test passed after the offline-mode correction. Its only E2E failure was the second tab not showing Join Jam. Inspection found that Dashboard connects the socket while the mode gate can still withhold ClassicList: initial jam_state events were dispatched only as transient window events, so the delayed conversation listener missed them.

Dashboard now retains active Jam display snapshots for the exact relay/user/workspace/session and passes them into ClassicList. Ended calls are removed; reconnect clears the snapshot; changing identity immediately hides the old snapshot. Only display state is retained in memory, without browser storage. RTC offers/candidates and call-control events remain transient and are not replayed.

Validation: a delayed-consumer test receives an initial state delivered before it mounts, ignores RTC offers, and verifies end/reset/session isolation. Existing Jam tests and the new test total 11 passed; full Web 1,188 tests/180 files passed; production build passed. Actual two-tab E2E requires rerunning the new release candidate; this is not yet proof of production Jam recovery.

### 2026-10-25 — file origin controls wired to real listings
Added compact agent-created/user-uploaded selectors beside list/folder/upload controls, with an accessible native overflow selector for all and unknown sources. Default All preserves legacy discoverability. Source filters are sent to both file and folder endpoints; switching source clears both page cursors. The per-tab view saves source selection, accepts earlier saved views, and rejects malformed sources. Source-specific empty states and Japanese labels are included. Existing upload state remains mounted across file history.

Validation: local full-stack CUA uploaded synthetic /tmp/honmaru-origin-ui.txt (42 bytes); it appeared only in user-uploaded results. Unknown-source selection showed the previous six local files, and the agent source correctly showed its empty state. Source choice survived page refresh/reopening. Inspected light and dark layouts: /tmp/honmaru-file-origin-light-20261025.png and /tmp/honmaru-file-origin-human-20261025.png. Agent-populated UI still requires verification after built-in agent wiring.

Full Web rerun passed 1,190 tests/180 files; build passed. Initial build found a duplicate pre-existing All files translation, removed. Initial full test run had one existing attachment renewal timing failure; its isolated 25 tests and the subsequent complete suite passed without changing that test or attachment implementation. CI remains required before release.

### 2026-10-25 — built-in own-agent file tools
Connected file list/folders/history/text-read/create/update tools to the existing agentTools assembly for top-level direct conversations with the user's own agents. Canonical file scope comes from resolveChannel and is removed from model schemas; supplied scope arguments cannot override it. Existing-file operations additionally require that exact conversation scope. Every invocation rechecks the agent's current ownership, membership, deletion and room access before the underlying live file authorization. Files remain available through the room Files UI. Audit metadata distinguishes conversation tools from MCP and records the actual agent name.

The private-source taint flag blocks public read_url calls after file tools run, following the existing connected-app safeguard. Shared rooms, third-party agents and Simple mode do not receive these tools; broader shared-agent execution still needs its intended authorization design and remains incomplete.

Validation: harness MCP/core MCP/connected-app suites 30 passed. Added actual tool assembly and taint checks, then reran harness MCP: 11 passed. Tests exercise real D1/R2 creation with agent provenance, forced scope despite model spoofing, rejection of reads/writes to other rooms, immediate ownership-loss denial and tool exclusion outside the own-agent boundary. Natural-language model execution and populated agent-file UI have not yet been exercised in production.

Production verification: Worker 5d1b7872 deploy 40181583976 succeeded; Web fae6baed deploy 40182201724 succeeded. Its log and production HTML both serve index-DtMFkD57.js. Subsequent origin, creation, toolbar and Jam changes remain release candidates.

### 2026-10-25 — live file invalidation and loading render loop
Successful HTTP and agent file changes now send a payload-free workspace_files_changed event only to the file's current permitted readers. Recipient queries use live fileScopeAuthority; events contain neither file identifiers, room identifiers, names nor content. Delivery failures do not turn an already committed save into an error. WebSocket transport forwards these events; open lists and history coalesce invalidations, reconnects and focus into fresh authorized API reads. Removed duplicate history fetching on local changes after introducing the shared revision.

Local CUA two-tab evidence: receiver remained open on v1 of honmaru-live-refresh.txt, sender uploaded a new version, and receiver changed to 39 B / v2 without reload or reopening. Screenshot /tmp/honmaru-file-live-refresh-20261025.png. The initial HMR session kept its old WebSocket class instance and did not update; retested after both tabs loaded the new code. Closed the extra sender tab.

Browser logs also exposed a pre-existing maximum-update-depth warning in HarnessPinnedApps while pins loaded. useAppPins returned a new empty array every render before its request completed, repeatedly triggering the consumer's setApps effect. Its per-hook empty result now has stable identity; a regression check covers unchanged loading scope.

Validation: Worker ledger/HTTP/MCP suites 35 passed, including private/public recipient selection and access revocation. Web all 1,192 tests/181 files passed; production build passed. New tests cover coalescing, teardown, reconnect/focus, and open list/history refresh.

Release: exact Jam candidate ecfebd24 CI 40183060605 passed all seven required jobs including two-tab E2E. Confirmed remote main was fae6baed, then fast-forwarded to ecfebd24. Its deployment completion remains to be checked; this live-refresh change is not deployed yet.

### 2026-10-25 — native access resumed; release checks still pending
After the user confirmed the Mac was available, CUA successfully opened the installed production app, the existing QA Webhook 2026-10-23 room and its Files panel. The panel loaded its empty state and upload/search controls; there was no lock or capture error in this check. Screenshot: /tmp/honmaru-production-files-resumed-20261025.png. This is display/navigation evidence only, not an upload round trip or proof that the latest candidate is deployed.

Candidate 865607d0 CI 40183432626 has six required jobs passing with Worker still running. Candidate addbd2b3 CI 40183730311 failed the message keyboard E2E: after cancelling editing, Backspace did not display the deletion confirmation. Its Jam/header test passed. Log: /tmp/honmaru-62966a05-121140001820.log. Root cause is not established; do not waive this failure. Latest 7f602fa8 CI 40184262223 still has Worker and E2E running. ecfebd24 production Web 40184108255 and Worker 40184108259 deployment jobs remain in progress. No additional promotion was performed during this check.

### 2026-10-25 — keyboard deletion failure investigated in real UI
Local full-stack CUA sent a synthetic Keyboard focus verification message, picked it with ArrowUp, entered edit with E, then pressed Escape and Backspace. The in-app deletion confirmation appeared with the correct message; Escape cancelled it and restored focus to the message. No deletion was performed. Screenshot: /tmp/honmaru-keyboard-delete-confirm-20261025.png. This successful attempt does not explain or waive CI 40183730311's intermittent failure.

The existing E2E failure now captures active element/row IDs and classes, editing/dialog presence and a screenshot before failing. No retry, timeout increase or weakened assertion was introduced. node --check e2e/spec.mjs passed. Further CI evidence is required to identify the failing state.

### 2026-10-25 — direct file metadata for conversation links
Added GET /hx/files/:id and the Web API client get method as the foundation for opening generated-file links without searching paginated or source-filtered listings. The query uses the existing live fileScopeAuthority and an exact bound file identifier. It returns only committed, unpurged current content metadata; missing, private/inaccessible, reserved and deleted files are unavailable. No storage key or content is returned, and responses remain private/no-store. The public list API does not accept the new internal identifier filter.

Worker HTTP/ledger suites: 25 tests passed, including exact metadata, guest rejection, inaccessible scope and tombstone behavior. Web API tests: 4 passed; Web production build passed. Conversation link rendering/navigation is still incomplete and this endpoint is not deployed yet.

Release: candidate 865607d013ed568b35c1f96b3b42d88e3080648a CI 40183432626 completed successfully with all seven required jobs passing. Verified remote main ecfebd24 and candidate ancestry, then fast-forwarded main to 865607d0. Deployment success is not yet verified. Later conversation-tool/live-refresh candidates remain gated on their own CI.

### 2026-10-25 — file links open their conversation and history
Conversation routes accept a validated file identifier. Dashboard retains these routes through mode loading and workspace switching; ClassicList opens the Files panel only after the requested conversation is current. The panel resolves canonical room scope and loads metadata through the new live-authorized endpoint, rejects a scope mismatch, clears previous selection on target changes, and offers retry on failure. Source/list filters do not hide a directly linked file. Own-agent save receipts now return an HTTPS openUrl for their server-bound agent conversation and instruct the model to include it in its reply. No session credential is in the URL.

Local CUA followed a file URL into File verification, opened the correct existing file's v5/history despite the saved human-only filter, reloaded the URL and recovered the same detail, then previewed its real saved content. Screenshot /tmp/honmaru-file-link-preview-20261025.png. Natural-language agent reply/link generation and cross-workspace UI switching still require actual end-to-end verification.

Validation: route/panel focused tests 37 passed, Worker agent MCP 11 passed, full Web 1,195 tests passed, build passed. After clearing selection on target change, panel suite and build passed again. Earlier root-level build/test invocations used the wrong package directory; passing results used the Web/Worker package configurations.

Release: exact candidate 7f602fa8 CI 40184262223 passed all seven required jobs, including the message-key E2E that failed in an older candidate. That does not establish the earlier intermittent failure's root cause; diagnostic capture remains in the next candidate. Verified main 865607d0 and ancestry, then fast-forwarded main to 7f602fa8. File-link changes are not yet deployed.

### 2026-10-25 — file link across Simple/Harness workspaces
Created File link switch QA using the local synthetic account's UI (localhost only). It opened in Simple mode with the original feed/list controls. From that workspace, followed the existing File verification file URL naming the original personal workspace. The app showed its workspace-loading state, switched to the correct Harness workspace/room and displayed the requested file's v5/history. Screenshot: /tmp/honmaru-file-link-workspace-switch-20261025.png. No invitations or external account changes were made; the local QA workspace remains available for subsequent testing.

Added a focused regression test for two successive file-link targets with the first response delayed: the late response cannot replace the second file's detail. Panel suite 11 tests passed. This does not yet verify a real model-generated natural-language reply or production file links.

Deployment investigation: ecfebd24 Worker run 40184108259 remained in its Test step, while Web 40184108255 explicitly waited for the matching Worker deployment. Newer main 7f602fa8 deploy runs 40185243466/40185243467 were pending. These were live jobs, not missing or terminal; no restart or bypass was performed.

### 2026-10-25 — linked-file loading and recovery states
Added explicit linked-file loading, unavailable/access-denied and transport-failure states. Errors use localizable user-facing copy instead of raw transport messages. Retry clears the error and fetches the same target again; metadata must match both requested ID and canonical room scope. The existing stale-response guard remains in place.

Local CUA navigated from a valid detail to a nonexistent synthetic file ID, observed the Japanese loading message followed by the unavailable message, with no previous-file detail remaining. Fixed the button wording from the generic Retry translation (再送信) to もう一度試す. Screenshot /tmp/honmaru-file-link-unavailable-20261025.png. Panel suite 12 tests and Web build passed; the new test covers failed lookup followed by successful retry. Deployment and full Kylon parity remain unverified.

### 2026-10-25 — deployment-specific generated links and file audit refresh
Own-agent file receipts now construct links from APP_WEB_URL instead of hardcoding production. They retain the configured path (including subpath deployments), discard inherited query/hash, reject non-HTTP(S) and credential-bearing addresses, and omit a link when configuration is invalid without failing an already committed save. Worker harness MCP suite 12 tests passed, including configured origin/path, localhost, inherited query removal, unsupported protocol and embedded credentials.

Reconciled KY-070/073 evidence with implemented origin controls, own-agent tools, empty-reservation cleanup, live invalidation and local file-link verification. All remain partial. KY-074 explicitly distinguishes legacy attachment conversations from the new versioned Workspace Files panel: the latter still lacks its own file conversation UI. File navigation URLs do not satisfy this requirement. Full export conversion, natural-language generation and production/multi-user/mobile evidence remain open.

Live deployment checks: ecfebd24 Worker 40184108259 and Web 40184108255 still in progress; latest file-link candidate 40185272525 and diagnostics candidate 40184789211 also in progress. No completed deployment was inferred from main or local tests.

### 2026-10-25 — versioned workspace files have persistent conversations
Extended the existing file-conversation endpoint to committed versioned workspace files. Live file authority is checked before resolving the channel, inside the deterministic root-message insert, and again before returning a thread. The root ID is separate from legacy attachments and stable across file versions; concurrent opens converge. Workspace-wide files without a room are excluded, as are reservations, tombstones, purged content and inaccessible rooms. Existing ordinary channel reply/AI/notification handling remains in use. File detail now exposes the existing FileConversationButton.

Local CUA opened the v5 file's dedicated thread, sent a synthetic Japanese reply and reloaded its URL; the same thread and reply remained. Screenshot /tmp/honmaru-versioned-file-conversation-20261025.png. File and conversation are not yet displayed simultaneously, and natural-language AI, multi-user notification/mobile and production behavior remain unverified.

Validation: Worker file HTTP and legacy file suites 38 tests passed; panel tests 12 passed; Web build passed. New HTTP coverage verifies non-mutating initial GET, concurrent first opens, one root row, stable thread after version replacement and rejection after room membership removal. An initial fixture used an invalid group-key format and was corrected to the actual format. The Worker test log includes a relay network-connection warning despite passing tests; production relay delivery is not claimed by these tests.

### 2026-10-25 — source file beside its conversation
Added a source-file action to versioned file thread bodies, resolving only the deterministic UUID-based root IDs. It opens the authorized Files detail alongside the focused conversation using the existing split layout, without navigating away from replies. Closing the file leaves the conversation. The legacy attachment footer leaves the thread before opening room attachments so it does not target a hidden panel.

Local CUA clicked 元のファイルを開く from the saved file thread and visually confirmed file history on the left, replies/composer on the right. Screenshot /tmp/honmaru-file-thread-side-by-side-20261025.png. Full Web 1,198 tests/182 files and build passed; identifier tests reject legacy, malformed and trailing-path IDs. A first focused test invocation used the repository-root runner; the subsequent reported full suite used web-react configuration. This verifies desktop history/conversation layout, not simultaneous inline content preview or mobile layout.

Production: ecfebd24 Worker deploy 40184108259 and Web deploy 40184108255 both completed successfully. Worker version e9b7d323-147d-4010-a98d-979ca6a0e308. Web log and current app.honmaruai.com HTML both serve index-CeIVjcgO.js; Pages deployment https://c5012eb7.honmaru-web.pages.dev. Later main 7f602fa8 and file-link/conversation candidates are not covered by this deployment evidence.

### 2026-10-25 — content preview alongside file discussion
WorkspaceFilePreview now supports an inline, labelled region as well as its existing modal. File panels opened beside a thread use the inline form; ordinary file panels retain the modal. Both forms share exact-version authorized downloads, size caps, cancellation/timeout, decode failure handling, search and encoding controls. Added constrained panel styling and Japanese close-preview label.

Local CUA opened the actual v5 text content beside its saved file thread and edited a synthetic reply draft while the preview remained visible. The draft was not sent. Screenshot /tmp/honmaru-file-inline-conversation-20261025.png. A translation HMR update had closed the first panel, so the final check reopened it and verified both content and editable reply together. PDF/image/CSV inline layout, mobile and full Kylon populated-reference comparison remain open.

Validation: preview and panel suites 16 tests passed, including inline region content and close action; Web build passed. Candidate 79cc7bf0 CI 40185272525, file-conversation candidate 55c22dd5 CI 40186024437 and main 7f602fa8 deployments were still running during this check. No new production completion is claimed.

### 2026-10-25 — dark inline preview and search verified
Used the local synthetic account's appearance controls to select Dark, returned to the saved versioned-file thread, reopened its source detail and inline v5 preview. Visually inspected the dark content surface, text, search/encoding controls, boundaries and reply draft together. Searching for version showed 1 / 1 and the matching text. Screenshot /tmp/honmaru-file-inline-dark-20261025.png. The synthetic draft remains unsent; only localhost theme preferences changed.

The current IAB capabilities do not expose viewport resizing, so no mobile-width visual result is claimed. CSS inspection alone is not mobile acceptance. Inline PDF/image/CSV, actual mobile, AI file context and production file conversation verification remain outstanding. No code change or new deployment was needed for this dark-mode check.

### 2026-10-25 — inline PDF fit-width correction
Real local PDF inspection revealed that the default 700px rendering clipped the page in the narrow inline file panel. Added a fit-width zoom option; inline PDFs start in that mode, while existing modal PDF defaults remain unchanged. ResizeObserver measures the available width and remounts the page render at the new scale so canvas/text-layer geometry stay aligned. Numeric zoom options remain available.

Local CUA created/opened the PDF fixture's own file conversation, reopened its source file and inspected both pages in dark mode. The second page now fits horizontally, and searching 84 identified its text on page 2 while the conversation stayed visible. Screenshot /tmp/honmaru-file-inline-pdf-fit-20261025.png. Preview/panel suites 16 tests passed and Web build passed. PDF responsive resizing itself and mobile still require further UI verification.

Release gate: file-link candidate 79cc7bf0 CI 40185272525 completed with Worker job 121144631596 failing; E2E and the other six required categories passed (Worker is one of the seven). Its Worker log is being retrieved. Do not promote this candidate on the basis of local tests or successful E2E.

### 2026-10-25 — exact-file filter no longer changes ordinary listing callers
Worker failure 40185272525 / job 121144631596 was reproduced by inspection: file-upload.test.js supplies a shared base object containing fileId to listWorkspaceFiles. The previously ignored field became an active filter when direct metadata lookup was added, so pagination saw only one file. Renamed the deliberately selected internal filter to exactFileId and updated only the direct metadata route. Existing list callers, including callers with incidental fileId fields, retain prior semantics. No assertion was weakened.

Validation: original upload/lifecycle/pagination suite plus HTTP metadata/conversation suite passed 73 tests. Log /tmp/honmaru-file-list-regression-tests.log. This fixes the identified failure, but exact-candidate full CI is still required before promotion. The earlier candidate's failed result remains evidence and is not treated as a flaky pass.

### 2026-10-25 — File conversation access races and production verification
- Added D1 coverage for stale file snapshots after membership removal or tombstoning: reads and creation return 404 without inserting an orphan root. All 12 HTTP file tests passed (`/tmp/honmaru-file-conversation-race-tests.log`).
- Production `7f602fa8`: CI 40185243465 and deployments 40185243466/40185243467 succeeded. Worker version `76295141-b480-4818-bf88-c3b64eea4789`; Web `index-AwDkSZrO.js` independently verified with curl at app.honmaruai.com (Python urllib request received 403).
- Mac app accessibility works again; production room/file panel visible. Local dark PDF preview shows page 2, fit-width and search result 84 alongside its conversation. Newer conversation UI production verification remains pending.
- Candidate `daf8e3f5`, CI 40186748028: five required jobs passed, Worker and E2E running. Not promoted. No new paid services; Simple mode preserved.

### 2026-10-25 — Server-generated file IDs in deep links
- HTTP file creation without requestId uses raw UUIDs, while channel route parsing previously accepted only `file-UUID`. Channel deep links now support both server-issued forms using strict UUID grouping; malformed IDs remain rejected.
- Route and file-thread tests: 29 passed (`/tmp/honmaru-file-uuid-route-tests.log`). Production rollout of this change remains pending.

### 2026-10-25 — AI access to versioned file conversations
- Added `read_thread_file` to agent replies in existing versioned file threads. Server binds file ID and canonical channel; model arguments cannot select another file. The answer snapshots its starting version, and subsequent answers can use the newer version.
- Every invocation rechecks live file/thread access and uses the existing bounded UTF-8 reader. Reading marks the answer private so public URL reads are blocked afterward. General personal tools remain unavailable in shared thread replies; Simple mode exposes no file reader.
- Real D1/R2 tests: 25 file HTTP/MCP tests passed; after adding agentTools integration coverage, 13 HTTP tests passed. Verified fixed version across an upload, fresh version for a new answer, wrong scope/root rejection, revocation, and read_url blocking.
- Remaining: real model/UI reply validation, PDF/image interpretation, production rollout. This is not full KY074 completion.

### 2026-10-25 — HTTP-to-model file conversation integration and promotion
- Added provider-mocked HTTP integration: save UTF-8 file, open its deterministic thread, ask an assigned agent with parentId, observe read_thread_file tool call, assert actual stored text/version reaches model input, and verify grounded reply persisted. One targeted integration passed (`/tmp/honmaru-file-thread-model-test.log`). No live model charges; actual model behavior remains unverified.
- Fixtures were corrected to supply orgId in the file endpoint query and use parentId (thread reply), not replyTo (inline quote); the model test uses inline execution explicitly.
- Exact candidate daf8e3f5613bcd8ca62e28dba55596373e34497a CI 40186748028 passed all seven required jobs. Confirmed remote main 7f602fa8 and ancestry, then fast-forwarded main to daf8e3f5. Deployment still pending; this candidate includes file conversation/inline preview/PDF fixes, not the later UUID route or AI reader additions.

### 2026-10-25 — Complete AI text pages and mid-read deletion
- Fixed a mismatch with the model runner's 20,000-character output cap: the file-thread reader now returns valid JSON pages with Unicode offsets and nextOffset instead of silently truncating long text. Pages adapt to JSON escaping, stay under 18,000 UTF-16 units, and include at most 16,000 Unicode characters.
- Revalidates the exact live file/thread after storage read, preventing a root deleted during object access from returning its content.
- 14 real D1/R2 HTTP tests passed, including full reconstruction of a 24,000-character Japanese/emoji/newline file, invalid offsets, bounded valid JSON pages, and root deletion during MEDIA.get (`/tmp/honmaru-file-ai-pagination-tests.log`). The existing answer loop still has finite tool/round budgets; a single answer is not guaranteed to read every large file in full.
- Production daf8e3f5 deploy jobs remain live; newer AI changes are not claimed as deployed.

### 2026-10-25 — Source panel on file conversation entry
- Actual UI showed that opening a file conversation hid the source panel. File threads now automatically open the authorized source detail alongside the conversation on entry/reload; closing it stays closed during draft edits.
- Local real-browser verification: created/opened the synthetic image file thread, displayed its raster preview alongside the conversation in dark mode, closed the panel and typed an unsent draft without reopening it, then reloaded and confirmed source details plus draft restoration. Preview re-opened successfully. Screenshot: `/tmp/honmaru-file-image-conversation-dark-20261025.png`.
- Web build passed (`/tmp/honmaru-file-thread-autopanel-build.log`). This evidence is localhost, not production or mobile; Simple mode is excluded by the existing Harness gate.

### 2026-10-25 — File-to-normal thread transition
- Real UI switching from image to PDF correctly changed the source file, but switching afterward to an ordinary thread incorrectly retained the PDF panel. Track only the automatically opened source and close that panel when leaving its file thread; independently selected panels are preserved.
- Repeated PDF-thread → ordinary-thread transition in the local browser: source details open for PDF and disappear on the ordinary thread. Screenshot `/tmp/honmaru-file-thread-exit-panel-20261025.png`. Web build passed (`/tmp/honmaru-file-thread-panel-transition-build.log`).
- This supersedes the automatic-panel behavior in candidate 5b752267; not yet deployed.

### 2026-10-25 — File MIME filter UI
- Rechecked https://docs.kylon.io/cli/workspace/file: file list supports image/video/media/pdf/doc/html categories. Honmaru backend/API already implemented these; exposed them in the file panel with Japanese labels and existing dark palette.
- Type changes reset file/folder cursors; per-tab room view restores valid categories, rejecting invalid saved values. Filtering with no results shows the matching-files empty state. Folder navigation remains available, including folders without matching descendants.
- Panel/view tests: 17 passed (`/tmp/honmaru-file-type-ui-tests.log`); build passed (`/tmp/honmaru-file-type-ui-build.log`). Existing source-selector test now targets that specific select rather than assuming one selector in the panel.
- Actual local dark UI: selecting PDF removes text/image rows and retains document-preview.pdf. Screenshot `/tmp/honmaru-file-type-filter-20261025.png`. Kylon's exact filter-control layout, mobile and production rendering still unverified.

### 2026-10-25 — File origin tab label fit
- Actual 360px file panel truncated the Japanese source labels. Visible tabs now use Agents/Users, while full Created by agents/Uploaded by users descriptions remain in title and aria-label.
- Real dark UI confirms both Japanese labels fit alongside view/upload icons; screenshot `/tmp/honmaru-file-origin-labels-20261025.png`. Panel tests 13 passed and web build passed (`/tmp/honmaru-file-origin-label-tests.log`, `/tmp/honmaru-file-origin-label-build.log`).

### 2026-10-25 — Agent file search parity
- Exposed existing MIME category, creator and inclusive creation-date search through list_workspace_files for MCP and own-agent conversation tools. Scope remains server-bound in native agent conversations.
- Added Kylon-style UTC start-of-day literals for today, tomorrow, yesterday, seven days ago and thirty days ago in the common list query. Both bounds resolve against one captured clock value. Invalid literals/ranges remain errors.
- Real MCP checks verify combined category/creator/date filtering, empty results, invalid input and today/tomorrow/yesterday literals. MCP plus file upload/list regression suite: 75 tests passed (`/tmp/honmaru-agent-file-search-tests.log`). Production rollout pending; this does not verify model selection of the tools.

### 2026-10-25 — Relative date calendar boundary verification
- Added real D1 list tests for all five relative date literals, with a fixed clock covering UTC/JST day difference, New Year, leap-year February, seven-day and thirty-day month/year rollovers.
- Exact boundary timestamps are included by both bounds; one millisecond before the lower bound is excluded. All 68 file upload/list tests passed (`/tmp/honmaru-file-relative-boundaries-tests.log`). No production claim: daf8e3f5 deployments remain live, while the relative-date runtime is in candidate 0e3f572c.

### 2026-10-25 — File filter reload and clearing in real browser
- Reloaded the local file conversation, opened the list, and confirmed the saved PDF filter still selected with only document-preview.pdf visible. Switching to image returned only the synthetic PNG; clearing restored all eight visible files, including PDF, image and folder-contained text.
- Screenshot `/tmp/honmaru-file-filter-cleared-20261025.png`. This proves same-tab reload/clear on localhost, not cross-device sync or production rollout.
- Candidate 8be188b2 CI 40187614813 completed successfully. Later pagination/UI/filter candidates remain pending; production daf8e3f5 deployment is still active.

### 2026-10-25 — Production daf8e3f5 confirmed; conversion architecture gap
- Worker deploy 40187569774/job121151504489 succeeded, version `9e4e493a-db40-4772-9c9d-06015c5b8a59`. Web deploy 40187569797/job121151504580 succeeded, Pages c22714b2; logged and independently curl-verified production asset `index-dhu1O26F.js`.
- Production includes deterministic file conversations, metadata links/recovery, inline file preview and PDF fit width. Later AI reader, automatic source panel, type filters and relative dates are NOT in this deployed snapshot.
- Export audit: gateway Node-only isolated runner has 64 KiB payload and 32 KiB combined output limits, no PDF/DOCX renderer or binary artifact channel. Existing pdfText extracts text only. Updated KY-072 to retain the full conversion/delivery gap rather than count downloads as export.

### 2026-10-25 — Document converter foundation (not exposed)
- Implemented guest-side `gateway/document-converter.mjs`: bounded Markdown/HTML input, DOCX/PDF targets, one total deadline, cancellation, format/size checks, binary output with SHA-256, and scratch cleanup. Markdown uses Pandoc sandbox; HTML/DOCX/PDF uses LibreOffice. This is NOT connected to claims, HTTP, UI, or versioned persistence yet.
- Added a separate document-image Dockerfile using the existing pinned official Node base plus Pandoc, LibreOffice and Noto CJK fonts. Production must execute it in a no-network VM with artifact delivery; do not call it on the host with user documents.
- Gateway suite: 21 passed, including output larger than the old stdout cap, invalid outputs, cleanup on failure/cancel and invalid inputs (`/tmp/honmaru-document-gateway-tests.log`).
- Trusted synthetic HTML smoke generated real DOCX (6,116 bytes) and PDF (28,249 bytes). DOCX XML retains Japanese, one table and one hyperlink. PDF rendering FAILED Japanese fidelity (missing/tofu glyphs) in the bundled macOS LibreOffice; explicit Hiragino also failed. These artifacts are not accepted exports.
- Started dedicated font-equipped image build in exec session 36526; `/tmp/honmaru-document-image-build.log`, tag honmaru-document:development. Build is still live with no output yet; do not restart solely for silence. Must finish build, render Japanese inside VM, implement artifact delivery/authorization/storage, expose UI, and verify production before KY-072 can be complete.
- Primary references: https://pandoc.org/MANUAL.html and https://help.libreoffice.org/latest/en-US/text/shared/guide/pdf_params.html .

### 2026-10-25 — isolated document conversion smoke and resumed native UI

- Native Honmaru production UI capture and file-panel click succeeded after the user's availability confirmation. The QA Webhook room displays its empty file panel in dark mode; screenshot `/tmp/honmaru-production-files-resumed-20261025.png`. This does not verify authenticated production upload.
- Corrected document image to pinned official Node Debian base `de170b39439eb0e5a3444ad7d60b015614a381e10fecae2e30ec9e735122f38d`. The previous base did not provide apt-get.
- Debian Pandoc DOCX writer failed under `--sandbox`, even with an explicit generated reference DOCX. Kept sandbox enabled; Markdown now uses the HTML writer followed by LibreOffice DOCX/PDF conversion. Official documentation describes the external-data limitation: https://pandoc.org/MANUAL.html.
- Dedicated image build passed: manifest `683f698996f4c000a8c2d2f86d1dea5e3cd5f4e0249048b16fc55fac6274770c`, index `bdaf2fcfb5e985ce9c20dc18cd1613113b1d63cfcbea9b9475f0a76050bb15ff`. Actual no-network, read-only-root, unprivileged VM smoke passed Markdown/HTML × DOCX/PDF, with synthetic data only. DOCX XML retained Japanese. Both PDF renders visually retained Japanese, bold text, table content and links; HTML table borders retained. Evidence `/tmp/honmaru-document-vm-html-smoke.log`, `/tmp/honmaru-document-vm-markdown.png`, `/tmp/honmaru-document-vm-html.png`.
- Gateway test suite passed. This is conversion foundation only: no production document claims, artifact broker, workspace file publication, or export UI is enabled yet. KY-072 remains partial.
- Main `483e10734ff627aa8c8a99ec39cbbed0ba627a86` was promoted only after candidate CI's seven required jobs passed. Main Worker deployment `40189442059` still testing, Web deployment `40189442073` waiting for Worker; do not claim deployed yet.

### 2026-10-25 — document binary runner

- Added `gateway/document-runner.mjs`, separate from 32 KiB text executions. It validates fixed input formats/size, requires a configured pinned image and verifies the installed image ID, receives bounded binary output, validates format magic, returns size/hash/MIME, and kills/deletes the VM on completion or failure. Network remains disabled; no host mount or token enters the guest. No document capability is advertised to the production gateway yet.
- Actual runner smoke initially failed because the local image had only a tag and the digest reference caused a registry lookup. After inspecting the image ID, registered that exact local digest reference with `container image tag`; no image upload or external service was introduced.
- Actual runner then passed all four Markdown/HTML → DOCX/PDF combinations with image inspection enabled: `/tmp/honmaru-document-runner-verified-image.log`, artifacts `/var/folders/nx/ygvn7q3x7r5_vwl0rsz2c6zh0000gn/T/honmaru-document-smoke-NCpdnG`. Gateway suite passed 25 tests including oversized text-result preservation, invalid artifact rejection, cleanup on failure, and mismatched image rejection.
- Remaining integration: dedicated document job admission/capability, live requester/scope authorization during artifact upload, idempotent versioned file publication, cancellation/lease recovery, and export UI. Existing node credentials must not gain general file access; upload authority must be bound to the assigned job and exact destination. Existing 120-second job deadline must account for conversion plus artifact delivery.
- Latest queued release candidate `0e3f572c21e17c639564a756de3b3dda05b6057f`: exact CI run 40188606048 has all seven required jobs successful. Current main 483e1073 still has live Worker deployment testing and Web waiting; no second main promotion yet.

### 2026-10-25 — document admission primitives

- Added separate `document-jobs.sql` and internal `documentJobs.js` admission/read/cancel primitives. They are deliberately not in production migrations or HTTP routes yet: a legacy gateway must not claim document payloads as JavaScript. Required remaining integration includes node capability/lease routes, destination-bound artifact publication, lifecycle expiry and account/workspace erasure, then UI.
- Admission requires Harness mode/build permission, checks live file-scope authority inside INSERT, active workspace node, normalized output path with matching extension, bounded input and queue (25 active jobs). Stable per-user request IDs prevent duplicate documents or changed-input reuse. Reads are requester-only and recheck live scope. Cancelling clears the lease; replay preserves cancellation.
- Actual D1 tests passed 4/4, covering idempotency/privacy, JavaScript queue exclusion, unavailable scope/node, invalid extension, Simple mode, membership removal, concurrent retries and queue limit. Log `/tmp/honmaru-document-jobs-tests.log`. These tests do not prove end-to-end export yet.
- Current main deployment remains live: Worker run 40189442059 is testing; Web 40189442073 waits for it. Main CI E2E has now succeeded; Worker remains running. No restart or additional promotion was performed.

### 2026-10-25 — document leases

- Added internal document capability-gated atomic claiming, hashed leases, 90-second lease renewal capped by a 240-second delivery deadline, cancellation-aware authorization, explicit failure and expiry. The conversion itself remains capped at 150 seconds; delivery has time within the server deadline.
- Live file-scope membership, Harness mode, node revocation/owner role and configurable requester build permission are rechecked before returning document payload and during lease authorization. Raw lease is only returned to the claimant; stored/public job views do not expose it. Claim refuses while an ordinary gateway execution is running.
- D1 suite passed 7/7: concurrent claims have one winner; wrong lease fails; renewal never extends beyond deadline; cancelled/revoked/expired jobs reject delivery authority; lost leases fail rather than automatically re-executing; explicit failed conversion releases its slot. Log `/tmp/honmaru-document-leases-tests.log`.
- Still internal and not migrated/routed to production. Before enabling: the existing ordinary claim route must also refuse while a document is running (reciprocal exclusion), destination-bound atomic file publication and cleanup must be complete, node client must opt in only after image readiness, and full HTTP/UI export must be verified. No completed-export claim is made.

### 2026-10-25 — document artifact publication

- Added internal `publishDocumentArtifact`: authenticated lease determines destination, creator and deterministic new file ID; node bytes are bounded and format-checked. R2 staging uses existing upload recovery, then a D1 batch commits immutable version, current file pointer and successful document job together. Existing paths are never overwritten. Live lease and scope checks occur before upload and in final transaction; cancelled uploads are discarded.
- Same-lease/same-hash replay acknowledges the original version after a lost finish response; different bytes/lease are rejected. A successful batch whose response is lost does not delete committed bytes. Staged cleanup remains tracked for existing recovery sweeps.
- D1/R2 tests passed 12/12 including cancellation during R2 put, path collision, invalid format, replay, lost batch response, and serialized-input limits. `/tmp/honmaru-document-artifact-tests-final.log`. Synthetic magic-only bytes test the storage protocol, not PDF rendering; actual rendered PDFs were separately verified in prior VM smoke.
- Queue serialized payload capped below 2,000,000 bytes with metadata allowance, based on official D1 row/string limit: https://developers.cloudflare.com/d1/platform/limits/. JSON escaping is measured after serialization.
- Still not enabled in production: HTTP binary upload endpoint, node capability and delivery client, schema deployment/lifecycle cleanup, origin attribution/events and export UI remain. Broader Kylon parity is not complete. Main 483e1073 Worker deployment remains live in Test; Web still waiting for it.

### 2026-10-25 — document HTTP and node delivery

- Added bounded `/hx/documents` admission/status/cancel and authenticated `/gateways/documents` claim/heartbeat/fail/binary-artifact routes. Binary upload bypasses JSON parsing, caps input, validates live lease and emits existing file invalidation after success. Missing document schema returns 503; schema is not deployed and the service loop still does not opt in.
- Actual Worker HTTP test authenticates a user and node, creates/claims a document, posts binary, repeats identical upload, rejects changed bytes, and reads succeeded status. Existing gateway regression plus document suite passed 21 tests, `/tmp/honmaru-document-http-gateway-regression.log`.
- Added opt-in document client/process function. Tokens/lease stay in headers, redirects are refused, document bytes remain binary, transient delivery errors retry the retained bytes without running conversion again, revoked delivery does not retry, failed conversion reports failure. Image verification precedes claiming. Gateway suite passed 30 tests, `/tmp/honmaru-document-client-tests.log`.
- Remaining before production enablement: lifecycle/account/workspace cleanup, reciprocal exclusion in ordinary gateway claim, migration readiness, configuration/service opt-in, origin/audit handling, user-facing export flow and real node→HTTP→download verification. No full export completion claim.
- Main CI 40189442142 now completed with all seven required jobs successful for 483e1073. Worker deploy 40189442059 remains live in Test and Web 40189442073 waits for it.

### 2026-10-25 — document lifecycle and deployment schema

- Added document schema to normal `schema.sql` deployment (standalone SQL remains for focused tests); no workflow-file edits or manual production migration. Existing gateway claim now refuses while a document job runs, completing reciprocal exclusion. HTTP test proves ordinary claim is blocked during conversion and succeeds after document publication.
- Minute maintenance expires leases/invalid authority and prunes at most 100 terminal receipts older than 30 days. Published workspace files remain governed by their existing retention/history. Account export includes owned currently accessible document source/status without leases; account deletion removes document source/leases. Dynamic workspace purge includes document table and tombstones block late delivery.
- Document suite 16 passed (`/tmp/honmaru-document-lifecycle-final.log`), document+existing gateway suite 23 passed before the final purge test, existing account/workspace/migration suites 30 passed (`/tmp/honmaru-document-erasure-regression.log`). An initial account-erasure fixture omitted the existing deleteAccount login argument; corrected fixture and reran successfully.
- Not deployed or enabled on Mac service yet. Service opt-in, readiness surfaced in UI, origin/audit, user export interaction and full real-binary HTTP download verification remain. Main 483e1073 production deploy has advanced from tests to D1 column migrations; same live run 40189442059, Web still waiting.

### 2026-10-25 — opt-in service and node readiness

- Gateway service accepts optional pinned `documentImage`; absent configuration retains ordinary execution behavior. Service alternates document/ordinary preference, processes at most one job at a time, and document readiness failures do not stop ordinary work. Real Mac service configuration has not yet been modified.
- Added node readiness records refreshed only on document-capable claim/heartbeat and `/hx/documents/nodes` listing recent non-revoked nodes with active administrator owner. Missing both document tables is treated as not ready. A configured client verifies installed image before advertising capability.
- Gateway suite passed 31 tests (`/tmp/honmaru-document-service-tests.log`); Worker document+gateway suite passed 24 (`/tmp/honmaru-document-node-readiness-tests.log`), including nodes absent before capability advertisement and present after claim. UI and real configured-node end-to-end remain.
- Production 483e1073 verified deployed: Worker c9dfe90e-0403-41ba-a79c-987975506bc4; Web index-D0SN8DaB.js, Pages https://b85a7397.honmaru-web.pages.dev. Live app.honmaruai.com HTML independently matched the asset.
- After exact candidate CI 40188606048 confirmed all seven required jobs, verified main=483e1073 and ancestor relation, then fast-forwarded main to 0e3f572c21e17c639564a756de3b3dda05b6057f. This includes source-panel transition, type filters and agent file search, not unfinished document conversion. Deployment completion of 0e3f572c is not yet verified.

### 2026-10-25 — document creation UI

- Added file-panel document creation dialog using the existing modal/focus handling and icon system. Supports Markdown/HTML input, PDF/DOCX output, destination filename/directory, ready-node selection, queued/running/saved/cancelled states, cancellation and opening the resulting file history. Stable request IDs are retained on uncertain admission errors; active jobs are polled without duplicate creation.
- Added Japanese labels and dialog theme tokens. Actual local CUA inspection confirmed the dark-mode form and disabled creation when conversion/node readiness is unavailable; screenshot `/tmp/honmaru-document-create-dark-20261025.png`. Local running DB has not yet received document schema, so this is a readiness/error state, not a successful full UI conversion. Light/mobile and real node round trip remain unverified.
- UI regression suite 15 tests passed, including request-ID reuse and queued→saved→open. Build passed after removing a duplicate existing Japanese Report dictionary key. Logs `/tmp/honmaru-document-ui-tests.log`, `/tmp/honmaru-document-ui-build.log`.
- Remaining: migrate isolated test DB, attach synthetic test node and verify real conversion/download through UI, persist active job receipt across panel reload, refine readiness/errors and origin/audit, then complete release CI and production rollout. Simple mode's existing routing is unchanged; no new service or charge.

### 2026-10-25 — actual UI → VM → storage → download

- Migrated only isolated local D1 at `/tmp/honmaru-file-ui-db`; registered synthetic local node for existing synthetic QA account. Temporary node token stored mode 0600, no real production token read/changed, no service fee. Local document processor uses pinned verified image and connects only to 127.0.0.1:8787; finite test loop session 64018 was active during verification (10-minute maximum).
- CUA submitted Japanese Markdown from document creation form. Actual Mac VM converted, authenticated Worker published file version, UI polled succeeded, opened version history and rendered the PDF inline. Downloaded PDF 24,963 bytes SHA256 `be522dc196571b8975be0484b0bac198bb743adef80416f3588ae3cba647dbe5` exactly matched the immutable file version. Job `d3a5e25b-d752-4de6-be36-37870e3d07d1`; screenshot `/tmp/honmaru-document-real-pdf-preview-20261025.png`.
- Repeated through UI selecting Word. Downloaded DOCX 5,208 bytes SHA256 `4534cfa064c3a4d9ced2f30e44e8d6f5712ca5562468769c4855aaa76ff5dc77` matched stored version. ZIP document XML retained Japanese, table and hyperlink. Job `9608fb39-8718-4e24-908b-e9c1e32825b2`; screenshot `/tmp/honmaru-document-real-word-20261025.png`. Downloads live in user Downloads with synthetic test filename ending 20261025.pdf/.docx.
- Fixed stale readiness error remaining after a node connects, and translated Open file. UI regression 2 tests and full web build passed. `/tmp/honmaru-document-ready-ui-tests.log`, `/tmp/honmaru-document-ui-build.log`.
- This proves local end-to-end conversion, not production or complete Kylon parity. Remaining: active-job restoration across panel reload, origin/audit, light/mobile visual QA, final release CI and real production node configuration/round trip. Main 0e3f572c deploys are live: Worker 40191119046 Test, Web 40191119111 waiting; CI 40191119027 also in progress.

### 2026-10-25 — document receipt restoration

- Added per-tab session receipt keyed by existing host/workspace/user/room preference key and exact scope. Stores only validated UUID, no source text, filename, token or lease. On remount, fetches live authorized server status; unavailable/forbidden receipts clear, storage failure does not prevent operation. This is reload/panel restoration, not cross-device sync or restart persistence.
- Five focused tests passed: key isolation/invalid IDs, disabled storage, unchanged retry ID, normal completion and restored receipt without duplicate admission. Web build passed. Logs `/tmp/honmaru-document-receipt-tests.log`, `/tmp/honmaru-document-receipt-build.log`.
- Actual CUA submitted `Reload receipt QA 20261025.pdf`, reloaded immediately after queued response, reopened document dialog and observed saved state/file-open action. DB confirmed exactly one job (`555b0d4b-aeb9-4d6a-a3ef-f7ce456f09f5`) succeeded. Screenshot `/tmp/honmaru-document-reload-restored-20261025.png`.
- Main 0e3f572c E2E now passed; Worker CI/deploy still live Test and Web waiting. No new production document enablement yet. Remaining includes audit/origin, light/mobile checks, release CI and actual production node/service rollout.

### 2026-10-25 — document origin and audit

- Human-only document admission now publishes immutable file origin `human` in the same D1 batch as the matching version. The node cannot supply origin/author/destination. Future agent admission must explicitly attribute its trusted principal; not exposed yet.
- Audits record conversion/cancellation requests by the authenticated person and accepted artifact deliveries by the authenticated node. Retried deliveries are receipt events, not claims of another conversion. Details contain only job/version identifiers and status; source text, lease and token are omitted. Uses existing best-effort audit infrastructure; this is not a new atomic audit guarantee.
- Document D1/HTTP suite passed 16 tests including origin and request/delivery audit presence. `/tmp/honmaru-document-origin-audit-tests.log`. Full release CI still required before production activation.

- Audit regression suites additionally passed 9 tests (`/tmp/honmaru-document-audit-regression.log`). Created release snapshot `a7ce005779063c6e92f4fe6c7a5466c5efadcacd`, parent `0e3f572c21e17c639564a756de3b3dda05b6057f`, branch `codex/document-conversion-release`. Exact candidate CI `40192173570` confirmed live in progress. Main is unchanged; do not promote until seven required jobs and remaining visual/rollout checks are verified.

### 2026-10-25 — recover progress after transient status failure

- Reopening the document dialog now resumes a previously failed status poll. Existing job progress no longer depends on node discovery (and node discovery cannot overwrite a job-status error). The stored job is fetched, not submitted again.
- Added regression with restored receipt, first status request failing, then reopening successfully recovering the saved document even when node discovery is unavailable. Focused document UI/receipt suite passed 6 tests; build passed. Logs `/tmp/honmaru-document-reopen-tests.log`, `/tmp/honmaru-document-reopen-build.log`.
- Candidate a7ce0057 CI 40192173570 was confirmed still live: relay, desktop, gateway passed; Worker/web/shared/E2E running. This new UI recovery fix is not in that snapshot yet; include it in the next candidate before promotion.

### 2026-10-25 — document light/dark visual correction

- CUA is operating again. Actual light-mode inspection found document actions rendered as browser-default buttons. Applied the existing dialog button classes, primary action contrast, focus-visible outline and a single-column format layout below 400px. Changed status/node retry wording from message-oriented Retry to Try again.
- Verified saved receipt and new-document form in light mode, restored the synthetic QA account to dark, and verified dark form plus scrolling to the retry control with the footer remaining visible. Screenshots: `/tmp/honmaru-document-light-buttons-20261025.png`, `/tmp/honmaru-document-light-form-20261025.png`, `/tmp/honmaru-document-dark-buttons-20261025.png`. Narrow viewport remains unverified.
- Focused UI/receipt tests passed 6; web build passed. Logs `/tmp/honmaru-document-themed-tests.log`, `/tmp/honmaru-document-themed-build.log`. Initial test failed because its label lookup still used Retry; updated to the new visible label, then passed.
- Main 0e3f572c CI 40191119027 now has all seven required jobs passed. Its Worker deploy 40191119046 is live in D1 column additions, Web 40191119111 waits for Worker. Document candidate a7ce0057 CI still has Worker and E2E running; five required jobs passed. No document production activation claimed.

- Pushed updated release snapshot `fd84c2148d93886f9e114598312df079465ee724` (parent a7ce0057), including status recovery and themed actions. Exact CI `40192772920` is pending. Main unchanged. Synthetic local document processor session 64018 has exited successfully after its finite run; production node configuration remains unchanged.

### 2026-10-25 — installed node runtime dependency fix

- Deployment review found install-service copied the old runtime list, omitting document-client/runner/converter despite unconditional imports. This would prevent even an ordinary service from starting after update. Extracted shared copyServiceRuntime with all required modules.
- Regression copies the actual runtime into an isolated temporary directory outside the checkout, imports/runs the ordinary one-shot client, and starts the service with invalid synthetic config to verify it reaches config validation instead of failing module resolution. No token, network, launchd or container touched. Full gateway suite passed 32 tests (`/tmp/honmaru-runtime-install-tests.log`). Existing production service not updated yet.
- Main 0e3f572c CI plus Worker and Web deployments now completed successfully. Exact deployed asset/version verification follows. Candidate fd84c214 CI was confirmed queued; prior a7ce0057 was cancelled by the new candidate, not a test failure.

- Updated candidate `5bb6d76f06142953b2dc22a5ec93ce5f13a6191a` pushed (parent fd84c214); exact CI `40192911584` pending. Verified 0e3f572c deployment: Worker `789e7d3a-68d5-49d5-8715-c8ad21d2f623`, Web `index-DN4ZpEz1.js`, Pages https://b5a911cd.honmaru-web.pages.dev. Independent curl of app.honmaruai.com matched the asset (Python default User-Agent request was 403). Document work remains candidate-only.

### 2026-10-25 — production node preflight and parity audit

- Exact candidate CI 40192911584 confirmed live: gateway/Worker/relay/desktop/shared/E2E running, web queued. No failed job at observation.
- Read-only preflight: existing com.honmaru.gateway LaunchAgent state running; service config has no documentImage, existing token file owner/mode valid (contents not read). Only buildkit container was active. Pinned document image verified using verifyDocumentImage against the configured container binary. No production service/config mutation.
- Updated KY-072 evidence to replace stale no-converter claim with actual local UI/binary/hash/VM verification and explicit production, mobile, resource-fidelity, natural-language and Kylon comparison gaps. Requirement remains partial.

### 2026-10-25 — multipage document content verification

- Ran a synthetic 120-row Japanese HTML table through the real pinned isolated converter for both PDF and DOCX, with start/end markers. Outputs at `/var/folders/nx/ygvn7q3x7r5_vwl0rsz2c6zh0000gn/T/honmaru-document-pagination-FQjVPZ`. PDF: 46,799 bytes, SHA256 `9efd5753bc9d3b2e31429c0430253ab53d5566e658bb4583c54c57b5b4948393`. DOCX: 8,050 bytes, SHA256 `626742940d4b3bdfca08ef6c7d03353d96041bd559dd9479f717f69d25674f8c`.
- Existing PDF.js extracted all 120 unique row markers, Japanese text and start/end markers across six pages. DOCX XML independently contained all rows/Japanese/end marker. Evidence `/tmp/honmaru-document-pagination-evidence.json`. Initial inspection used an unsupported document.destroy cleanup; corrected to loadingTask.destroy and reran successfully. This is content/pagination coverage, not visual layout or Kylon fidelity proof. No user files, credentials, production execution or paid service used.
- Candidate CI 40192911584 observed live: five required jobs passed, Worker and E2E still running. Candidate unchanged.

### 2026-10-25 — terminal document recovery actions

- Failed/cancelled conversion receipts previously retained the generic Create action in the footer even though the input form was hidden (potentially enabled by stale draft/node state). Terminal receipts now show Close, with the existing explicit Create another document action returning to the editable form and refreshing node availability.
- Added restored failed/cancelled receipt regressions proving no blind creation action, no duplicate submission, and an editable new form after explicit recovery. UI/receipt suite passed eight tests; full web build passed (`/tmp/honmaru-document-terminal-tests.log`, `/tmp/honmaru-document-terminal-build.log`). Actual terminal-state visual verification remains.
- Current candidate 5bb6d76f CI 40192911584 still live with Worker/E2E running and five required jobs successful. This local UI fix is not included; defer next candidate push until current CI terminates to avoid repeatedly cancelling the long Worker suite. Production document activation remains pending.

### 2026-10-25 — cancellation during document execution

- Added deterministic client regressions: a revoked heartbeat aborts the in-flight converter and produces neither artifact upload nor a redundant terminal-state mutation; interval cleanup prevents later heartbeats. Service shutdown aborts conversion and reports failure without uploading partial output. Existing lost-upload-response coverage still verifies identical binary retry with only one conversion.
- All 34 gateway tests passed (`/tmp/honmaru-document-cancel-tests.log`). These are client lifecycle tests, not physical restart or production cancellation evidence. No converter/service code changed. Current candidate remains 5bb6d76f with five required CI jobs passed and Worker/E2E live; test additions and terminal UI fix remain local pending the next candidate.

### 2026-10-25 — trusted document agent origin foundation

- Document admission accepts a trusted internal origin option, separate from untrusted request fields. Human payload representation remains compatible with existing receipts. Agent-origin admission persists attribution in the immutable admitted payload; binary publication records that origin atomically with the file version. Upload fields cannot override it and cross-origin request-ID reuse conflicts.
- Document suite passed 18 tests, including forged untrusted origin and trusted agent publication (`/tmp/honmaru-document-agent-origin-tests.log`). Initial fixture edit accidentally changed account-erasure admission; restored that fixture and reran all 18 successfully.
- Not yet exposed to model tools or production. Next: own-agent conversation binding, available-node selection, scoped job status and audit before exposing natural-language conversion. Current candidate CI remains live Worker/E2E, five required jobs passed; these changes and terminal UI recovery are not in candidate 5bb6d76f.

### 2026-10-25 — own-agent document tools

- Connected list_document_nodes/create_document/get_document_status/cancel_document to the existing private owned-agent file tool boundary. Scope comes from the canonical conversation, never model arguments. Every invocation rechecks Harness mode, build permission and live ownership; status/cancel additionally match the exact conversation. No tools are added to public/shared-agent contexts.
- Creation selects a recently ready node, uses stable idempotency and trusted agent origin, records an audit request, and returns queued status explicitly. Successful status adds the existing configured-app file link. No source, token or lease in audit details. Private tool usage taints later public-URL reads.
- Document plus existing MCP suites passed 31 tests (`/tmp/honmaru-document-agent-tools-tests.log`). Added bound-scope/foreign-receipt/duplicate-request/ownership-revocation coverage. Actual model invocation, asynchronous UI progress discovery, production node execution and output links still require end-to-end verification.
- CI 40192911584 remains live Worker/E2E with five required jobs passed. Tool changes are local, not in candidate 5bb6d76f and not deployed.

### 2026-10-25 — agent model-loop document integration

- Integration now exercises assembled agentTools through the existing chatTools function-calling loop, with mocked provider replies: discover node → create queued document → claim/publish → read succeeded status → return configured conversation file link. Asserts queued output has no success link, exactly one job exists, and resulting immutable file origin is agent.
- Document suite passed 20 tests (`/tmp/honmaru-document-model-loop-tests.log`). Provider response and PDF bytes are synthetic; real isolated conversion is covered separately. This does not prove actual model choice/quality, live production execution or asynchronous progress UI. No paid call made.
- Candidate CI 40192911584 still live with five required jobs passed, Worker/E2E running. Current integration changes remain outside candidate 5bb6d76f pending its terminal result.

### 2026-10-25 — discover document jobs across entry points

- Added authorized recent-document API (latest 20, exact scope and requester, live file authority, Harness/build checks; no source or lease fields) and dialog history. This makes agent-created receipts discoverable without a sessionStorage ID; selecting a running item resumes existing polling, selecting a completed item opens its file instead of resubmitting.
- Worker document suite passed 21 tests, UI/receipt suite nine tests, web build passed (`/tmp/honmaru-document-history-worker-tests.log`, `/tmp/honmaru-document-history-ui-tests.log`, `/tmp/honmaru-document-history-build.log`).
- Actual local CUA verified three existing receipts in dark mode and selected the previously generated Word document with saved status and Open file action. Screenshot `/tmp/honmaru-document-history-dark-20261025.png`. Actual model-created job appearance and narrow/light layout of the new history remain unverified. Changes not yet released.

### 2026-10-25 — live document history refresh

- Visible document history refreshes sequentially every five seconds, discovering jobs created through other entry points. A failed list read clears stale rows and exposes retry; closing/unmounting cancels both request and timer. Polling does not enqueue jobs.
- Added external-job appearance, stale-history clearing and timer-cleanup regression. UI/receipt suite passed 10 tests and build passed (`/tmp/honmaru-document-history-refresh-tests.log`, `/tmp/honmaru-document-history-refresh-build.log`). Initial edit script failed before applying the source change; corrected it and reran successfully.
- Candidate CI 40192911584 now has six required jobs passed including E2E; Worker remains live. Local changes after 5bb6d76f still await a new candidate after this run finishes.

### 2026-10-25 — preserve owned-agent authority through publication

- Found a late-ownership gap: ordinary file scope access can survive when an agent is changed to team scope, even after ownership changes. Agent-origin document execution must retain the stricter owned-conversation authority used at admission. Added a trusted SQL predicate to atomic admission and live lease/publication/receipt guards requiring that exact current owner for agent-origin jobs. Human jobs retain normal file-scope authority.
- Regression changes agent scope and ownership during object upload, then verifies publication is refused, no immutable file version is created, and staged bytes are cleaned. All 22 document tests passed (`/tmp/honmaru-document-owner-race-tests.log`), including the model-loop integration.
- Candidate CI 40192911584 remains live with six required jobs passed and Worker running. These ownership protections and newer features are still local, not in candidate 5bb6d76f.

### 2026-10-25 — metadata-only document polling

- Status/history SQL now selects only returned metadata instead of materializing document source and lease fields before discarding them. Added a matching org/requester/scope/time index in both normal deployment schema and focused document schema for bounded recent-history reads. No production migration performed manually.
- Existing 22 document tests passed (`/tmp/honmaru-document-history-metadata-tests.log`), retaining authorization, model-loop, publication and lifecycle coverage. No production latency improvement claim without measurement. Candidate CI 40192911584 remains live Worker with six required jobs passed; candidate unchanged.

### 2026-10-25 — agent/history release candidate

- Inspected CI concurrency: group is workflow plus branch ref. Created updated snapshot `360abb611c2807288854df2a1e323a9e9c26d7ae`, parent `5bb6d76f06142953b2dc22a5ec93ce5f13a6191a`, and pushed `codex/document-agent-release` so the earlier long Worker run is not cancelled. Exact new CI `40193965836` confirmed in progress. Main unchanged at 0e3f572c.
- Snapshot includes terminal UI recovery, cancellation coverage, trusted origin/ownership, scoped agent conversion tools, model-loop integration, recent-history API/UI refresh and metadata/index improvements. Older candidate 5bb6d76f is not the final release target.
- Deployment dependency/migration checks passed 18 tests (`/tmp/honmaru-document-deploy-checks.log`). Combined document/MCP/model-tool suites passed (`/tmp/honmaru-document-agent-release-tests.log`). Full exact-SHA seven-job CI and production rollout still required.

### 2026-10-25 — native Kylon file-folder comparison

- Native Kylon CUA confirmed file upload menu has file/folder entries; recent view has agent/user origin radios; folder view hides those radios and shows All files breadcrumb plus folder icon and empty-folder text. General room had no files in either origin. Synthetic PDF selection remained Open-disabled; cancelled chooser without uploading. No populated preview parity claim.
- Honmaru folder empty-state now uses folder icon and matching empty-folder wording when unfiltered; root breadcrumb says All files. Existing extra origin filtering is retained pending a deliberate treatment of advanced filters. Build passed (`/tmp/honmaru-file-folder-fidelity-build.log`). This small UI refinement is outside current candidate.
- Earlier candidate 5bb6d76f CI 40192911584 completed all seven required jobs successfully. Latest 360abb61 CI 40193965836 has six required jobs passed, Worker running. Main unchanged; only latest candidate is eligible for final feature rollout.

### 2026-10-25 — Kylon folder wording regression

- Folder breadcrumb now says All files to match observed Kylon; updated the existing navigation regression to assert the visible label. First run correctly caught the stale test locator; after updating it, all 13 WorkspaceFilesPanel tests passed (`/tmp/honmaru-kylon-folder-ui-tests.log`).
- Candidate 302f568d CI 40195267162 was already running when the stale assertion was found. It is superseded by a same-branch update containing the corrected regression; the next exact candidate CI is authoritative.

### 2026-10-25 — member-picker semantics in generated app schemas

- Compared the authenticated Kylon task form with the production Honmaru data viewer. Kylon's `担当者` uses workspace-member choices; the existing Honmaru form could render the picker for `person` columns, but the generated task schema had emitted `担当者` as free text. Opened both forms and cancelled them without saving records.
- Added shared field-type normalization for natural-language app creation and additive database migration proposals. Internal `担当者`/owner/assignee/reviewer/interviewer/approver fields use `person` references even when the model returns `text`, while explicit same-field free-text requests remain `text`; unrelated free-text notes do not suppress the member picker. Existing data and schemas are unchanged.
- 60 focused Worker tests passed across app generation and member-field migration behavior (`/tmp/honmaru-member-field-combined-tests.log`). All fixtures are synthetic; no model call or production record write was made.
- Baseline candidate `bf008cf0fa8fb0a34a0d121e0f202c4ceb2e7c1d` passed all seven required CI jobs (run 40195315557). The member-field fix is a separate follow-up candidate and still needs its own full CI and production rollout. Kylon's `Ask agent to add` action and broader app-generation parity remain open.

### 2026-10-25 — production document agent and submenu release

- Worker commit `b2eabf7ccd4a7bfd40a6842bfb2895d9c19a4adb` deployed successfully (run 40201627974); Web commit `de2aca6122b1b559ff284a2a39d9c4acdf283b43` deployed successfully (run 40202969923). Production `/health` returned `ok: true`, all encryption checks true, and Pages served the new `index-B10__F7b.js` bundle.
- In the private `Mac実行アシスタント` DM, a synthetic Markdown-to-PDF request completed through the natural-language agent tool path using the existing Mac mini node. The agent returned `succeeded`, execution ID `91e6801d-a5b2-4aa1-8036-d7d528da4d78`, and a file link. The artifact link opened in the app; v1 history loaded and the PDF preview rendered the exact text `Honmaru production smoke test — synthetic content only.`. Read-only D1 verification found one document node online within the preceding 90 seconds. No real user content or new paid service was used.
- CI run 40202969910 passed all required jobs, including the right-click channel submenu flow that had timed out on the prior candidate. The root cause was immediate submenu closure while crossing a small diagonal pointer gap; a 250 ms close grace period now lets the pointer reach the submenu. Web build and 13 focused RowMenu tests passed. The Worker full-suite, E2E, desktop, shared core/mobile, relay, gateway and reference web jobs all passed.
- KY-072 remains partial: production Markdown-to-PDF agent conversion is proven, but production DOCX and HTML round trips, mobile/narrow UI, comparison with populated Kylon output, and physical reboot recovery remain open. Simple mode remains available.

### 2026-10-26 — workflow AI usage budgets

- Commit `8e17aadf4f759d2374bf2a72ad23e441e18c172d` adds per-workflow estimated AI usage budgets beside existing daily/weekly/monthly run-count limits. Worker records priced token usage as ceiling-rounded USD micros, aggregates rolling 24-hour/7-day/30-day windows, supports warn-only creator-thread notices or pause-after-current-run, and keeps unknown usage visible instead of treating it as free. Budget edits use the existing revision fence; admission is checked atomically. No Simple-mode source files or paid service dependencies changed.
- Local checks: `workflow-safety.test.js` passed 11 tests including the six-decimal boundary case; `HarnessWorkflows.test.tsx` passed 33 tests; `npx tsc --noEmit` passed. Before the final input-step precision adjustment, the full Web suite passed 185 files / 1,217 tests and the production build succeeded. Exact-SHA CI 40212083696 passed all jobs including Worker, E2E, desktop, shared core/mobile, relay, gateway and reference web.
- Production Worker deployment 40212083695 passed its test step, base D1 schema, additive D1 migration (AI budget columns, usage index and durable notice table), deploy and verify steps. Production Web deployment 40212083688 passed tests, matching-Worker wait, Pages deploy, domain attachment and verify. `/health` returned `ok: true` and all encryption checks true.
- After a full reload of the authenticated Honmaru desktop app, the real workflow detail displayed the AI usage estimate heading, warning/pause selector and all three rolling windows in dark mode. Existing workflow limits remained zero/unlimited; no production budget settings were saved or runs started.
- This is not exact Kylon credit or invoice parity: values use known model token list prices, and external tool charges, missing provider counters, pre-run reservations and unreported usage are not fully covered. See [Kylon's credit usage help](https://kylon.io/help/limit-credit-usage). Simple mode remains intact.

### 2026-10-26 — workspace-wide AI usage ceiling release

- Commit `fa4de959594313ca5c45f8c87e748e70a3ba7119` fixed three missing server-copy translations and made the Tools-screen E2E key selector target the accessible OpenAI-key field. Exact-SHA CI [40219026947](https://github.com/Torutesu/HonmaruAI/actions/runs/40219026947) passed, including Worker full suite, browser E2E, Web tests/build, desktop, shared core/mobile, relay and gateway. Windows/Edge and iOS jobs were skipped by the workflow.
- Production Worker [40219026929](https://github.com/Torutesu/HonmaruAI/actions/runs/40219026929) passed tests, base D1 schema, additive column migration, deployment and health verification. Production `/health` returned `ok: true`, `encryption.all: true`, and `aiRouting: true`.
- The Web deploy [40221036459](https://github.com/Torutesu/HonmaruAI/actions/runs/40221036459) was explicitly dispatched because the final fix commit did not match the Pages workflow's web-path filters. Build, tests, Pages deploy, domain attachment, artifact verification and custom-domain check all succeeded. Its internal matching-Worker wait steps were skipped for `workflow_dispatch`; the separate same-SHA Worker success above was verified before dispatching Web.
- Both `https://app.honmaruai.com` and `https://honmaru-web.pages.dev` now serve `assets/index-BNU4od6v.js`. The signed-in Honmaru desktop app was reloaded to Tools → AI; the actual dark-mode screen showed the shared usage section, all three rolling windows, warning selector and disclaimer. It displayed recorded model reference prices of `$0.02` / `$0.02` / `$0.04` for 24 hours / 7 days / 30 days. All configured caps remained `0` (unlimited); no workspace setting, key or record was saved or changed.
- Simple mode remains available and unchanged. No paid provider or service was added. This release is still only a partial Kylon parity: Honmaru estimates recorded model-token list prices and does not implement Kylon credit purchase/grants, invoice reconciliation, external tool charges, provider-side counters, strict pre-run reservation or stopping in-flight work. See KY-067, KY-086 and KY-088 in [requirements.json](requirements.json).

### 2026-10-26 — signed workflow webhook release

- Commit `8c753f911b5b5a05589bdecae82bd2c823a041ae` was deployed to production. Exact-SHA CI [40222276466](https://github.com/Torutesu/HonmaruAI/actions/runs/40222276466), Worker deployment and D1 migration [40222276450](https://github.com/Torutesu/HonmaruAI/actions/runs/40222276450), and Web deployment [40222276471](https://github.com/Torutesu/HonmaruAI/actions/runs/40222276471) all succeeded. CI E2E and full Worker suite passed; iOS and Windows/Edge were skipped by the push workflow.
- New webhook credentials require `X-Webhook-Timestamp`, `X-Webhook-Event-Id`, and `X-Webhook-Signature: v1=<hex>`. HMAC-SHA256 signs the exact UTF-8 body as `timestamp.eventId.body`; timestamps accept seconds or milliseconds and expire after five minutes. Event receipts are atomic with run admission and deduplicate for seven days across queued and held deliveries. Existing URL-only credentials remain compatible until an explicit secret rotation enables signing.
- Focused Worker workflow/app/migration tests (127), Web webhook screen tests (34), Web production build, full Worker CI and E2E passed. The production Worker `/health` returned HTTP 200 with `ok: true` and `encryption.all: true`. The production Web main JS (`assets/index-XRLaL-Ld.js`) matched the same-configuration local build byte-for-byte (1,056,614 bytes; SHA-256 `760684c58ab29baa1dd56490c75b2a130fbbc7f39cfedb522ad812ebf3f2822d`). The signed-in production app reloaded and displayed its workflow list and existing CRM Kanban; no workflow, CRM record, webhook credential, or workflow setting was changed.
- This closes the signed-delivery and deduplication acceptance slice, not full Kylon parity. Legacy senders need an explicit credential rotation before they sign requests; replay recovery, broader workflow UI parity, and the remaining requirements in [requirements.json](requirements.json) remain tracked. Simple mode remains intact, and no new paid service was introduced.

### 2026-10-26 — Mac mini node reconnection and agent action path

- The production Execution nodes screen listed the existing `Mac mini` node and its recent heartbeat. Selecting it and running the existing pure sample `return input * 2` with input `21` returned `42` as `succeeded`.
- The installed `com.honmaru.gateway` LaunchAgent was running. A controlled service restart (`launchctl kickstart -k`) increased its launch count to 2 with exit code 0; after restart the production node heartbeat updated and the same isolated calculation succeeded. The installed plist has `RunAtLoad=true`, `KeepAlive.SuccessfulExit=false`, a 30-second throttle, no token in launch arguments, and only `HOME` in environment variables. Service config and the referenced token file are owner-only (`0600`). No test container remained.
- Agent-owned published app actions are exposed through `list_app_actions`, `run_app_action`, and `get_app_execution`; execution requires the `execute` scope, an authorized published action, current app access, a selected node and an idempotent request ID. The Worker suite passed on the same production-code SHA and includes access revocation and tool-scope coverage. No live model-driven action was invoked in this check to avoid extra model usage.
- This was a controlled LaunchAgent restart, not a full Mac reboot. Boot/login auto-start is configured and the node reauthenticated after service restart; a physical reboot has not yet been performed. User login and an awake Mac are required. No new service or billing was added, and Simple mode remains available.


### 2026-10-26 — external agent cancellation propagation release

- Extended assignment stop to request cancellation from the exact active external run generation. Anthropic Managed Agents uses `user.interrupt` on the matching session without a child-thread filter (the API applies it to the primary and non-archived child threads); Cursor Cloud Agents uses its documented run cancel endpoint. Cursor's documented `run_not_cancellable` conflict is surfaced as already finished. No speculative Devin/Codex endpoint is called.
- Persisted provider stop outcomes on `hx_agent_assignments`, made duplicate stop requests idempotent with compare-and-set, and exposed status plus retry for transient/uncertain outcomes. Migration is additive; existing Simple mode/data are unchanged.
- The complete Worker suite passed (240 files / 2,119 tests); the complete Web suite passed (185 files / 1,219 tests), TypeScript and the production Web build passed, and the additive migration runner passed its 8 tests. Exact-SHA CI [40228310355](https://github.com/Torutesu/HonmaruAI/actions/runs/40228310355), Worker migration/deployment [40228310408](https://github.com/Torutesu/HonmaruAI/actions/runs/40228310408), and Web deployment [40228310357](https://github.com/Torutesu/HonmaruAI/actions/runs/40228310357) all succeeded. Production `/health` returned HTTP 200 with `ok: true` and `encryption.all: true`.
- Production `app.honmaruai.com` served `assets/index-CwQcy37i.js` (1,057,623 bytes; SHA-256 `75636a0078e529515b13f0c3223756226c89b7b05e290fa7f0e87ef7b12a240a`), byte-for-byte identical to a local build with the production `VITE_API_HOST`. The signed-in Honmaru app reloaded to the existing Mac assistant DM; its historical synthetic execution status showed “処理終了”. No production records or assignments were changed. No external provider run was started, so provider-side stop behavior remains API-contract and mock-tested rather than live-proven.
- Official API references: [Anthropic Managed Agents session events](https://platform.claude.com/docs/en/api/cli/beta/sessions/events/send) and [Cursor Cloud Agents API](https://prod.cursor.com/docs/cloud-agent/api/endpoints). See [KY-020](requirements.json) for remaining gaps; this is not 100% Kylon parity.

### 2026-10-26 — Agent access request and selective room grant release

- Commit `c5b069b0058af1ae833bd5d5a979b850a7f50d1c` is on `main`. Exact-SHA CI [40244864417](https://github.com/Torutesu/HonmaruAI/actions/runs/40244864417), Worker test/migration/deploy [40244864388](https://github.com/Torutesu/HonmaruAI/actions/runs/40244864388), and Web build/deploy [40244864416](https://github.com/Torutesu/HonmaruAI/actions/runs/40244864416) all succeeded. Worker schema and additive-column migrations completed before publication; `/health` returned `ok: true` and `encryption.all: true`.
- The release adds private, idempotent Agent access requests to current Agent owners/admins. Approval grants only the requester Agent access; it does not add anyone to a room. Room creation can separately grant the selected Agent to selected room people after the server rechecks each membership and grant authority. Existing Agent owner/admin/member role boundaries and ownership-transfer version checks remain enforced. Schema changes are additive and preserve Simple-mode code/data.
- Exact production web assets changed from `index-CwQcy37i.js` / `index-DCnl8swx.css` to `index-CusObHQU.js` / `index-BKZysugu.css`; both `app.honmaruai.com` and `honmaru-web.pages.dev` served the new JS asset. The signed-in native app reloaded the production app and returned to the original Select workspace. No production access request, approval, Agent grant or room creation was issued. The Agent access dialog was not visually exercised with a synthetic team Agent, so that comparison remains open.
- Focused local suites before release: Worker 82 tests and Web 17 tests passed; exact-SHA CI passed all push-required jobs, with Windows/Edge and iOS skipped by workflow policy. The separate main CI also passed. This closes the explicit-grant part of KY-007, not cross-client live synchronization or multi-user production acceptance. No new paid service was added.

### 2026-10-26 — Agent access refresh and room Webhook production screen

- Commit `decdf5111373fa97de7e37319e52f6d495d587cf` clears stale Agent profile, permission, memory, skill, scope and draft state immediately when access changes, then reloads the still-open detail. Exact-branch CI [40249076818](https://github.com/Torutesu/HonmaruAI/actions/runs/40249076818) and main CI [40249076817](https://github.com/Torutesu/HonmaruAI/actions/runs/40249076817) succeeded; Worker deployment [40249076777](https://github.com/Torutesu/HonmaruAI/actions/runs/40249076777) and Web deployment [40249076815](https://github.com/Torutesu/HonmaruAI/actions/runs/40249076815) succeeded. Production `/health` returned `ok: true` with all encryption checks true.
- Reopened the authenticated Honmaru desktop app and inspected the existing private `QA Webhook 2026-10-23` room without changing its messages or settings. Its Webhook management dialog loaded the production list and showed the empty state, name field, disabled create action and close footer. Inspected the corresponding signed-in Kylon room settings → advanced settings → Webhook dialog in the native app: the explanatory text, empty state, horizontal name/create row and close footer match the same structure. Honmaru's currently selected dark appearance preserves readable contrast and the same hierarchy.
- This confirms production publication and read-only rendered parity for the empty management screen, not inbound delivery acceptance. No webhook credential or secret was created, no event was sent and no agent was run. Dedicated-thread creation, replay/revocation under concurrent production users and multi-user isolation remain open in KY-094. Agent access changes were not made during this visual check. Simple mode and its data remain available; no new paid service was introduced.

### 2026-10-26 — personal Simple display sync release

- Commit `474e4fc557d49890ab98c75d5e36ba112548bc0e` is on `main`. Exact-commit CI [40252241404](https://github.com/Torutesu/HonmaruAI/actions/runs/40252241404) and main CI [40253958671](https://github.com/Torutesu/HonmaruAI/actions/runs/40253958671) succeeded. Worker [40253958703](https://github.com/Torutesu/HonmaruAI/actions/runs/40253958703) passed its full test step, D1 schema and additive-column migrations, deployment, and health verification. Web [40253958656](https://github.com/Torutesu/HonmaruAI/actions/runs/40253958656) passed build/tests, waited for the matching Worker release, deployed Pages, and verified both `app.honmaruai.com` and `honmaru-web.pages.dev`.
- Local complete suites passed: Worker 241 files / 2,142 tests and Web 185 files / 1,229 tests; TypeScript and the production-config Web build passed. Production `/health` returned `ok: true` with all encryption checks true. `app.honmaruai.com` served `assets/index-5o-exZTF.js` (HTTP 200, 1,066,651 bytes), containing the new cross-device Simple preference copy.
- In the signed-in native Honmaru app, the accessibility tree loaded `/#/harness` and showed “すべての端末でシンプル版を使う” unchecked while the shared Workspace mode remained Harness. This also confirmed the current account's existing server value without changing it. The screenshot capture returned a black window, so pixel-level visual inspection of this page is still open. No second device was operated; the same-user-only relay and offline re-sync are covered by Worker integration and Web hook tests, not a live two-device write.
- The preference is stored per user and workspace, does not modify workspace mode or shared Apps/Workflows, and keeps the existing Simple experience/data. No new paid service or production preference change was made.

### 2026-10-30 — Kylon and Honmaru room Webhook screen comparison

- Read-only inspection in the signed-in Kylon desktop app and the installed Honmaru production desktop app, both at 1920×1080. Opened each room's settings → advanced settings → Webhook management.
- Both empty-state dialogs show the same explanatory copy and hierarchy: Webhook title, behavior description, Name label and `例: デプロイ通知` placeholder, inline disabled `Webhookを作成` action, empty-list message and close footer. Honmaru's dark theme keeps the same spacing and readable contrast while Kylon was in light appearance.
- Honmaru production initially showed a connection error; its visible retry action restored the signed-in workspace. The app list, room messages, settings and webhook list were read only. No webhook, secret, delivery or agent execution was created. Production Worker `/health` returned HTTP 200 with `ok: true`, `encryption.all: true`; both production web domains served `assets/index-C72Ou3Wn.js` containing the relation-picker component from PR #516.
- This verifies the empty Webhook-management screen and current production availability. It does not verify inbound delivery, thread creation, multi-user isolation or expired/revoked credentials; those remain open under KY-094. Simple mode and data were not changed, and no new paid service was used.

### 2026-10-30 — Workflow run-history parity work

- Kylon's official Run history page says Automation runs are grouped by day and can be filtered for failures ([source](https://kylon.io/product/run-history)). The signed-in Kylon test room `UI確認用タスク` had zero workflows, so a populated Kylon history could not be inspected. Honmaru production's `本番確認フロー` was read only; its existing run was completed on 2026-10-17. No run was started and no workflow settings were changed.
- Added a shared run-history grouping utility used by the main Workflow detail and the App automation release panel. Both now group by local start date, sort newest first, expose a failed-only toggle, and show a translated empty result when no failures match. Added ja/de/es/fr labels and invalid-date handling. Simple mode source paths were not changed.
- Local checks passed: affected AutomationRuns and HarnessWorkflows suites, 47 tests; full Web suite, 193 files / 1,318 tests; TypeScript and Vite production build. PR [#548](https://github.com/Torutesu/HonmaruAI/pull/548) has since merged. Its PR CI [#2213](https://github.com/Torutesu/HonmaruAI/actions/runs/41049265957) passed, including Worker 247 files / 2,237 tests, Web 193 files / 1,318 tests, Desktop 18 files / 129 tests, E2E, Windows, iOS, gateway and relay. The later main CI and production deployments recorded below include this release. The build still reports existing large-bundle and ineffective-dynamic-import warnings; a populated Kylon run-history screen comparison remains open.

### 2026-10-30 — Immutable workflow revision restore production release

- PR [#549](https://github.com/Torutesu/HonmaruAI/pull/549) merged as `5903477079a7e575236771d0ef4379ee4bb45c50`. PR CI [41057294627](https://github.com/Torutesu/HonmaruAI/actions/runs/41057294627) passed all required checks (16 successful, 2 skipped). Main push CI [41061091535](https://github.com/Torutesu/HonmaruAI/actions/runs/41061091535) passed in 18m44s, including all 247 Worker files / 2,241 tests and all 193 Web files / 1,320 tests. Worker deployment [41061091454](https://github.com/Torutesu/HonmaruAI/actions/runs/41061091454) passed its full suite, D1 schema and column migrations, deployment and health verification. Web deployment [41061091462](https://github.com/Torutesu/HonmaruAI/actions/runs/41061091462) passed build/tests, waited for the matching Worker, deployed Pages and verified the app domain.
- Production `https://tiktokforwork.torubj0904.workers.dev/health` returned `ok: true` with `encryption.all: true`. `app.honmaruai.com` and `honmaru-web.pages.dev` both served `/assets/index-C_IDs8sc.js` and returned HTTP 200. The Pages workflow emitted a Cloudflare DNS API authentication warning when attaching the existing app domain; the deployed custom domain nevertheless served the exact new bundle, so no manual DNS change was made.
- Reloaded the authenticated Honmaru desktop app and opened the existing `本番確認フロー` history. The production UI showed the history description, version selectors and the no-differences state. Only version 1 is currently available, so the restore selector/confirmation are correctly absent until an older version exists. No workflow definition was edited, no run was started, and no live data was changed. The app's dark theme remained readable. The signed-in Kylon test room had zero workflows, so a populated Kylon history screen could not be compared. These acceptance gaps remain in KY-058; this release does not establish 100% Kylon parity.
- Simple mode and its stored data were not changed. No new paid service was introduced.

### 2026-10-30 — Historical workflow revision attribution production release

- PR [#551](https://github.com/Torutesu/HonmaruAI/pull/551) merged as `17a3a450c904dc87984219f49a5c9124617fc3f5`. PR checks passed (16 successful, 2 skipped). Main CI [41071155916](https://github.com/Torutesu/HonmaruAI/actions/runs/41071155916) passed; its Worker suite completed in 26m57s, Web passed 193 files / 1,321 tests, Desktop 18 files / 129 tests, Shared/Mobile 7 files / 45 tests, and E2E passed. Worker deployment [41071155879](https://github.com/Torutesu/HonmaruAI/actions/runs/41071155879) passed tests, schema/column migration, deploy and verification. Web deployment [41071156343](https://github.com/Torutesu/HonmaruAI/actions/runs/41071156343) passed build/tests, waited for the matching Worker, deployed Pages and checked the app domain.
- Production `/health` returned `ok: true` with `encryption.all: true`. Both `app.honmaruai.com` and `honmaru-web.pages.dev` served the same new bundle `assets/index-CM1HPMMW.js`.
- Refreshed the signed-in Honmaru desktop app and opened the existing `本番確認フロー` run history. The run started at 2026/10/17 11:18:58, 12 seconds before the first recorded immutable revision at 11:19:10; the UI displayed `版未記録` and did not attribute revision 1. The UI refresh and app reload were read-only; no workflow definition, run, setting or production data was changed.
- Simple mode and its stored data remain unchanged. No new paid service was introduced. A populated Kylon run-history screen and additional production cases (exact historical snapshot, unmatched snapshot, absent snapshot) remain open; this release does not establish 100% Kylon parity.

### 2026-10-31 — agent assignment elapsed time

- The signed-in Kylon test thread showed work-duration receipts below agent replies (for example, `44秒作業しました` and `1分8秒作業しました`). Honmaru's existing room-authorized execution summary showed agent, status, stop controls and handoff history, but no elapsed duration.
- Honmaru now returns assignment start/update timestamps only through `/channels/agent-runs`, after the existing per-message channel access checks. The UI shows live elapsed time for active assignments and the saved duration after completion. This is the whole assignment chain, including handoffs; it does not claim per-reply or per-tool timing. Tool inputs and outputs are not included.
- No schema or migration change, and no new paid service. The full Web suite passed (194 files / 1,325 tests); TypeScript and the production Vite build passed. Existing large-bundle and ineffective dynamic import warnings remain. The focused Worker assignment-status/API test passed; the full Worker suite, PR CI, production deployment and signed-in Honmaru screen check are pending.

### 2026-10-31 — Workflow run-history deployment audit

- Honmaru grouped workflow history by local start day and added a failed-only filter in commit `1c80323`. The successful production Deploy Web #324 used merge commit `ebbafde`, which includes `1c80323`.
- The earlier local verification passed the affected AutomationRuns and HarnessWorkflows suites (47 tests), the Worker workflow suite (65 tests), and the TypeScript/Vite build. That local build reported existing large-bundle and ineffective dynamic import warnings.
- The signed-in Kylon test room contained no workflows, so a populated Kylon run-history view could not be compared. The Honmaru screen inspected in this audit was in Simple mode, so the Harness run grouping/filter were not visually rechecked today. Full step input/output/error/cost/permission trace remains open under KY-061.
- Simple mode and its data were not changed. No new paid service was used.

### 2026-10-31 — Database app/data-viewer screen comparison

- Read the existing `UI確認用タスク` app in the signed-in Kylon workspace and the same-named Honmaru app in the existing Select workspace. Both had zero records and the same four task fields (task name, assignee, due date, status). Neither app nor its records were edited.
- Kylon's data viewer showed a single `すべて` view, a new-view control, field/filter/group controls and its empty-state message. Its field menu toggled visibility and kept the title field fixed. Honmaru showed the same four visible columns plus task-list, kanban, calendar and personal views. The field menu also exposed user-synced visibility, order, width and optional ID/created/updated system columns; its filter editor exposed a field/operator/value condition form.
- Kylon's group adjustment put a natural-language instruction into the existing app-discussion composer. The draft was cleared without sending. Honmaru's group/filter controls opened direct configuration UI; the temporary empty grouping and filter configurations were canceled without saving. The screenshots showed Kylon's light theme and Honmaru's dark-green theme, so this verifies controls and empty-state layout rather than pixel-identical colors or populated-row behavior.
- Restored Honmaru to its original ShogunAI workspace and Apps screen. Simple mode and its stored data were not changed; no new paid service was used.

### 2026-10-31 — Version-pinned app template links

- Added a share-link flow under app settings. The link pins an existing app version, expires after 1/7/30/90 days and can be revoked; import creates a new app in the selected workspace with no record rows.
- The share table stores only a SHA-256 token hash. The published snapshot includes schema and view structure, while excluding descriptions, relation IDs, records, custom code, app connections and credentials. Since free-form names/options can still contain sensitive text, the creator must acknowledge reviewing them before issuing the link. Expiry/revocation are checked again at both preview and import.
- Focused Worker app tests passed (63 tests). Focused Web route/share/import suites passed (38 tests), and TypeScript plus the Vite production build passed. `git diff --check` passed. The build reports existing large-bundle and ineffective dynamic-import warnings. Full PR CI, Worker schema deployment, production UI review and authenticated browser verification are pending; this is not yet production parity evidence.
- The latest main CI run [#41173468138](https://github.com/Torutesu/HonmaruAI/actions/runs/41173468138) passed all required jobs, including Worker. PR #548 is merged; its CI action updates use Node 24-compatible action majors, while application tests stay on Node 22. No new paid service was introduced; Simple mode and its data path are unchanged.
