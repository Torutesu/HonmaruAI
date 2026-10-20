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
