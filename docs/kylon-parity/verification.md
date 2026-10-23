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
- Remaining role gaps include workspace-member-removal handoff (team removal can currently orphan an agent), automatic membership-pruning/account-deletion lifecycle, agent-to-agent role grants, access-request approvals and restricted directory metadata. These remain part of the full Company Harness target.

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
