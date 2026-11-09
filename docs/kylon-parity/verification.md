Warning: truncated output (original token count: 196267)
Total output lines: 4048

# 検証記録

### 2026-11-05 — KY-042 personal-view suggestions (production release)

- PR [#675](https://github.com/Torutesu/HonmaruAI/pull/675) added the personal-view adjustment route, and PR [#676](https://github.com/Torutesu/HonmaruAI/pull/676) fixed a draft collision in app chat and the source thread. The new suggestion appears separately while preserving an existing unsent draft; it remains available until the user appends or dismisses it. No app settings are changed by opening the route. Exact-head CI passed all nine jobs; Web deployment [run 41972220196](https://github.com/Torutesu/HonmaruAI/actions/runs/41972220196) succeeded.
- The authenticated production Mac app showed a personal-view filter suggestion card while preserving the existing composer draft. Dismissing the suggestion left the composer text intact and returned the UI to the original shared `タスク一覧` view. No filters, groups, columns, records, or app settings were saved. Kylon's descending `状態` sort remained untouched per user instruction.
- The live cross-device path is covered by Worker/Web tests included in PR #676's successful CI: the Worker sends the preference-change event to both live sessions for the same user and excludes another user; the Web client reloads only the matching app and newer revision. A production two-device interaction was not verified; Chrome had no authenticated Honmaru session during this check.
- Both `app.honmaruai.com` and `honmaru-web.pages.dev` served `index-MLNbjttn.js`. The main push CI was still running at the time of this verification; PR CI was fully green. No paid service was added and Simple mode remains available. KY-042 is still partial: full Kylon parity and authenticated two-device production verification remain open.

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
- 本番反映: PR #433、commit `4952daea62d4ce80fcdf99b87522a4e686003d95`。Deploy Web `39101468115` 成功。`app.honmaruai.com` が新しい `index-yjSDTaKD.js` を配信し、詳…166267 tokens truncated…ld pass the old checks.
- `continueRun` now revalidates the live source Table/App grant through that same callback. A focused Worker regression test made the source app private during the mocked provider response and confirmed the answer was not published. The focused test and full Worker test suite passed.
- Connection grants remain under audit; the current workflow step schema has no direct connector action. Simple mode is unaffected, and the change uses existing infrastructure without adding a paid service.

### 2026-10-31 — Workflow source grant revalidation production release

- PR [#579](https://github.com/Torutesu/HonmaruAI/pull/579) merged as `413f8f801b1102253996edc700d9846e26434873`. The PR CI and exact-SHA push CI passed; merge commit CI [#41204157599](https://github.com/Torutesu/HonmaruAI/actions/runs/41204157599) passed Worker, Web, E2E, Desktop, Relay, Shared core/Mobile and Local gateway. iOS and Windows/Edge were skipped by push policy.
- Worker production deploy [#41204157502](https://github.com/Torutesu/HonmaruAI/actions/runs/41204157502) passed the Worker suite, D1 migration checks, deployment and post-deploy verification. No schema migration was added by this change. Production `/health` returned `ok: true` and `encryption.all: true` after deployment.
- This release closes the observed gap for `app_record_change` source App/Table access inside Workflow Agent model/tool authorization fences. KY-066 remains partial: provider requests are not actively interrupted and settled on grant revocation, and workflow-wide Connection authorization is not implemented; the current step schema has no direct connector action. No new paid service was added and Simple mode remains available.

### 2026-11-01 — Workflow model request cancellation on access revocation

- PR [#581](https://github.com/Torutesu/HonmaruAI/pull/581) merged as `43959a623cf142398a7dfc77a760781a8f442b04`. Its focused model/usage suites passed 14 tests and the Workflow suite passed 69 tests. An in-flight source App privacy revocation aborts the Worker-side provider HTTP request, prevents reply publication, and records unknown/unpriced usage plus one call allowance.
- The merge was included in the later main CI [#41224384637](https://github.com/Torutesu/HonmaruAI/actions/runs/41224384637) and Worker production deployment [#41224384634](https://github.com/Torutesu/HonmaruAI/actions/runs/41224384634), both successful. No schema migration or paid service was added.
- The Worker can abort its outbound HTTP request, but cannot guarantee that the external provider stops processing or removes its charge. Direct Connection actions are not yet part of the Workflow step schema, so their grant lifecycle is not applicable or verified. Simple mode remains unaffected.

### 2026-10-31 — Harness native Agent connection grants (implementation)

- Added per-Agent, per-caller grants for the built-in Notion and GitHub search tools. Harness hides each tool until its caller grants the connected source, then rechecks membership generation, grant and connection immediately before the query and after it returns. If access changes during the query, its result is discarded. Automatic research and scheduled Follow-ups use the same grants and reauthorize after private results are returned and before a response is published. Results from these private sources also block `read_url` for the rest of the answer. Smithery App grants remain separate; Simple mode keeps its existing connected-source behavior.
- Added the grants to the existing Agent Connections screen and `/hx/agents/:id/apps` API, with audit events and Agent access invalidation. The D1 table is included in both `schema.sql` and the deployment migration script.
- Focused Worker tests passed (60 tests across `agents.test.js` and `smithery-apps.test.js` after automatic-research gating; a subsequent run including `harness-workflows.test.js` passed 130 tests), including default denial, explicit grant, in-flight revocation, private-result handling, automatic-research grant enforcement, scheduled-Follow-up reauthorization, revocation before model response, and Simple compatibility. Focused Web tests passed (10 tests); TypeScript and the Vite production build passed; parity inventory and `git diff --check` passed. PR #583 merged; production details follow.
- KY-079 remains partial. Arbitrary external Connection grants and unified App/Workflow execution grants remain unimplemented. No new paid service was added, and the simple Honmaru path remains available.

### 2026-11-01 — Harness native Agent connection grants production release

- PR [#583](https://github.com/Torutesu/HonmaruAI/pull/583) merged as `249f98383c91788d34f45fd29ac2fa78366db3c3`. Main CI [#41217441410](https://github.com/Torutesu/HonmaruAI/actions/runs/41217441410) passed Worker, Web, E2E, Desktop, Relay, Shared core/Mobile, and Local gateway; iOS and Windows/Edge were skipped by push policy.
- Worker deployment [#41217441413](https://github.com/Torutesu/HonmaruAI/actions/runs/41217441413) passed its full Worker test step, D1 schema and column migrations, deployment, and health verification. Web deployment [#41217441411](https://github.com/Torutesu/HonmaruAI/actions/runs/41217441411) passed. The Worker `/health` returned `ok: true` with `encryption.all: true`; `app.honmaruai.com` and `honmaru-web.pages.dev` both returned HTTP 200 and served `index-D-QrCWR1.js`.
- Refreshed the signed-in native Honmaru app and opened the existing `Mac実行アシスタント` Agent's Connections tab. The deployed Notion and GitHub grants were visible, both unchecked and disabled because those workspace sources are not connected. No grant or permission was changed. Restored the `UI確認用タスク` data viewer; it still showed zero records and its saved annotation. Kylon's and Honmaru's QA app data were not changed.
- Simple mode and its data path remain available. No new paid service was added. Native source grants are released, while KY-079 remains partial for arbitrary external Connections and unified App/Workflow execution grants.

### 2026-11-01 — Per-Agent Remote MCP read grants (production release)

- Added a per-caller, per-Agent grant for existing workspace Remote MCP servers. Private Agent conversations expose only workspace-allowed tools whose discovered MCP annotations mark them read-only and non-destructive. The worker rechecks the caller grant and exact tool allowlist/annotation before and after each call and before publishing a model response; a result returned after either grant or tool revocation is discarded. Shared conversations and Simple mode receive no new Remote MCP tools. Existing execute-scoped API tokens keep their workspace-level behavior.
- Added an Agent Connections control, audit events, membership-generation binding, and grant cleanup when a server is removed. No production connection was granted or revoked during this implementation.
- Focused Worker tests passed (123 tests across Remote MCP, Agent, and workflow suites), including default denial, another member's denial, read-only-only exposure, in-flight grant and exact-tool revocation, follow-up wiring, and shared-conversation exclusion. Focused Agent Connections UI tests passed (10 tests); TypeScript and the Vite production build passed. `git diff --check` passed.
- PR [#584](https://github.com/Torutesu/HonmaruAI/pull/584) merged as `2f2acc9ef8532f20fa67e87fa4e7da118739ec01`. Exact-head PR CI [#41222310212](https://github.com/Torutesu/HonmaruAI/actions/runs/41222310212) passed all nine jobs. Main CI [#41224384637](https://github.com/Torutesu/HonmaruAI/actions/runs/41224384637), Worker deployment [#41224384634](https://github.com/Torutesu/HonmaruAI/actions/runs/41224384634), and Web deployment [#41224384626](https://github.com/Torutesu/HonmaruAI/actions/runs/41224384626) completed successfully. Worker `/health` returned `ok: true` with all encryption checks true; `app.honmaruai.com` and `honmaru-web.pages.dev` returned HTTP 200 with the same release bundle.
- In the signed-in production app, the Agent Connections tab displayed the Remote MCP section and no available servers. The workspace Apps page also showed an empty Remote MCP server list. No server, credential, agent grant, or permission setting was created or changed. Restored the existing `UI確認用タスク` data viewer, which still showed zero records. Simple mode remains available and unchanged.
- KY-077 remains partial: OAuth 2.1 client registration, DNS-pinned egress, Kylon's 3,000+ connector catalog, write-capable Agent grants, and unified App/Workflow execution are still missing. No new paid service was introduced; Simple mode and its existing data path remain available.

### 2026-11-01 — Workflow Agent Remote MCP tools (production release)

- PR [#586](https://github.com/Torutesu/HonmaruAI/pull/586) exposes workspace-admin-approved read-only Remote MCP tools to Workflow Agent steps. A model cannot invoke write-capable tools through this path. Harness mode and the current exact server/tool approval are checked before and after calls; workflow, Agent, and authorization-fence checks run during the model loop and again before output is published. Revoked access blocks the result. The feature is limited to Workflow Agent steps; App execution and other workflow step types do not gain MCP execution.
- Private Agent conversations retain their separate per-caller grant and read-only boundary. Shared conversations and Simple mode receive no Remote MCP tools through this change. No schema migration, Remote MCP server, credential, or grant was added to production, and no new paid service was introduced.
- Exact-head PR CI [#41228613594](https://github.com/Torutesu/HonmaruAI/actions/runs/41228613594) passed all nine jobs. Worker deployment [#41230080171](https://github.com/Torutesu/HonmaruAI/actions/runs/41230080171) passed its Worker tests, D1 schema/migration checks, deployment, and verification. Production Worker version `ad1b84e2-c219-4356-bb5a-3b53ac5f49ab` returned `/health` `ok: true` and `encryption.data`, `encryption.audit`, `encryption.sso`, and `encryption.all` all true.
- Focused Worker Workflow/Remote MCP suites passed; diagnostic reading suite passed 10 tests, combined memory/reading suite passed 17, and the isolated sync suite passed 10. Main CI [#41230983711](https://github.com/Torutesu/HonmaruAI/actions/runs/41230983711) completed successfully across Worker, E2E, Desktop, Reference web, Shared core/mobile, Local gateway, and Reference relay; iOS/Windows are skipped by push policy.
- No configured production Remote MCP server exists, so a real external tool call was not performed. KY-077 remains partial: OAuth 2.1 client registration, DNS-pinned egress, Kylon-scale connector catalog, write-capable grants, App integration, and non-Agent workflow execution remain gaps.

### 2026-11-01 — App database migration previews (implementation verification)

- Kept additive migration behavior and added stable-ID column rename, strict scalar conversion (`text`, `number`, `date`, `select`, `checkbox`, `url`, `email`), and removal only for columns whose values are all null or empty strings. Person and relation columns are blocked from conversion or removal.
- The Harness database editor now requires a server preview before confirmation, shows changed-row examples and blocked rows, and sends a preview checksum. Apply recomputes the preview and compares the schema and row snapshot inside the same D1 batch so writes racing with apply are rejected. Snapshots are bounded to 500 KB of stored row data and at most 5,000 rows per table.
- Focused Worker Company Harness tests passed (16 tests), including strict conversion blockers, false/zero preservation, stale preview rejection, a row write immediately before D1 batch commit, replay, empty-column removal, and stable-ID rename. Focused Company App tests passed (3 tests), the Web TypeScript/Vite production build passed, and `git diff --check` passed. PR #594 CI and production deployment later succeeded; the authenticated Kylon screen comparison remains pending.
- At PR #594 release time, person/relation conversion remained unsupported. The follow-up implementation below closes that portion; the 500 KB snapshot cap and live Kylon screen comparison remain.

### 2026-11-01 — App database migration production release

- PR [#594](https://github.com/Torutesu/HonmaruAI/pull/594) merged as `082290f9e391141f87fa3bdafe78a781ff21a7d0`. Exact-head PR CI [#41263834955](https://github.com/Torutesu/HonmaruAI/actions/runs/41263834955) passed all nine jobs. Main CI [#41265870985](https://github.com/Torutesu/HonmaruAI/actions/runs/41265870985) passed; Worker and E2E succeeded, with Windows/iOS skipped by push policy.
- Worker deployment [#41265871040](https://github.com/Torutesu/HonmaruAI/actions/runs/41265871040) and Web deployment [#41265870984](https://github.com/Torutesu/HonmaruAI/actions/runs/41265870984) succeeded. Production Worker `/health` returned `ok: true`; `app.honmaruai.com` returned HTTP 200 and served the new bundle `index-r_W9nUQy.js`, containing the migration preview and confirmation UI.
- Signed-in Kylon visual comparison was not completed: the native Mac-control surface reported the Mac locked, and a fresh browser tab required a sign-in email code. No code was entered and no authenticated screen was claimed as verified. No new paid service was added; the Simple Honmaru path is unchanged.

### 2026-11-01 — Person and relation column migrations (implementation verification)

- Extended `convert_column` to support `person` and single/multiple `relation` targets. Person conversion accepts only strings up to 64 characters and normalizes one leading `@`. Relation conversion accepts stable record IDs or exact-match labels resolved by a stable text-like column ID; missing and duplicate labels block the preview. A text value for a multiple relation may be a JSON array of IDs or labels. Every linked ID must exist in the target entity.
- Renaming person/relation columns is supported. Dropping a person or relation column remains limited to empty values; `[]` is empty only for a multiple relation. `false` and `0` remain populated values.
- A relation preview includes target record IDs and, for label matching, a full snapshot of the target entity rows in its checksum. Preview examples show each input label and the resolved record ID. The apply transaction checks the linked IDs and snapshot still match before changing schema or source rows. Concurrent target deletion, edit, insertion, or creation of an ambiguous match rejects the whole migration.
- Focused Worker Company Harness tests passed (17 tests), including missing and duplicate-match blockers, target deletion at the commit boundary, person normalization, single/multiple relation conversion, preview label-to-ID examples, and empty multi-relation removal. The Harness migration preview now displays those examples; Simple mode and its data path are unchanged.
- Snapshot size remains limited to 500 KB of stored row data and 5,000 rows per table. Fuzzy label matching, cross-workspace people, and the authenticated Kylon screen comparison remain out of scope for this extension.

### 2026-11-01 — Devin assignment cancellation (production release)

- Added cancellation for the exact Devin session stored on the matching active assignment generation. The adapter uses Devin's documented organization-session DELETE endpoint; HTTP 410 is surfaced as already finished. A stale generation is not sent to Devin, and the cancellation response continues through the existing persisted assignment status and retry path.
- The focused Devin cancellation test passed, including exact-session targeting, stale-generation exclusion, and an already-finished response. The full Worker suite passed 2,279 tests across 249 files. PR [#599](https://github.com/Torutesu/HonmaruAI/pull/599) merged as `b8b9b2869df28b2b1a3441cd029a89b738040ddf`; exact-head PR CI passed all nine jobs and main CI [#41286970621](https://github.com/Torutesu/HonmaruAI/actions/runs/41286970621) passed. Worker production deployment [#41286970630](https://github.com/Torutesu/HonmaruAI/actions/runs/41286970630) passed Worker tests, D1 migrations, deploy, and post-deploy verification.
- After deployment, production `/health` returned `ok: true` with `encryption.all: true`; `app.honmaruai.com` returned HTTP 200. No live Devin session was stopped. KY-020 remains partial: Codex cancellation has no safe session handle in the current adapter; provider terminal state and billing are not verified; signal-insensitive tool side effects may continue. No new paid service was added and Simple mode is unchanged.
- Official endpoint references: [Devin v3 API overview and `ManageOrgSessions` permission](https://docs.devin.ai/api-reference/v3/overview), [Devin v3 OpenAPI](https://docs.devin.ai/v3-openapi.yaml).

### 2026-11-01 — Kylon room settings and guest ACL casing

- Read the signed-in Kylon `general` room menu and settings without saving. The screen showed icon, room name, agent response mode, and an advanced Webhook section. The all-member room name was locked; no post-create public/private control was present. This corrects the older KY-001 note that treated privacy editing as a required Kylon behavior. The Honmaru comparison used the existing empty `UI確認用タスク` app; its QA composer draft was left untouched.
- The room ACL had inconsistent normalization: `accessFor` recognizes `Guest` case-insensitively, but the guest-presence shortcut, public audience, and business list used case-sensitive SQL. Normalize those three checks and add regressions for mixed-case guests plus an admin who is not an explicit room member. Focused `closed-conversations.test.js` and `relay-auth.test.js`: 24 tests passed together. Main CI for PR #601's merge SHA `d80f66fe78c1f5cd24ff0c49a0d62ca654a11838` passed, and the Worker release completed; this ACL fix is in PR #602 and has not been deployed.
- After the user unlocked the Mac, visually compared the same empty `UI確認用タスク` data view in the signed-in native apps. Both show the task table, filter/group controls, empty state, and adjacent conversation. Kylon places it in its room/thread layout with a pale green app header and `新規タスク` control; Honmaru uses a dark two-pane app conversation and has a separate `行を追加` control below the table. Kylon's inspected app menu offers share, copy link, float, and pin actions; it showed no room-link editor. Themes and window sizes differ, so this observation records layout only, not a color-parity verdict. The original unsent drafts in both apps were present after the inspection; no app data or settings changed.
- PR #601 Worker deployment [run 41292634256](https://github.com/Torutesu/HonmaruAI/actions/runs/41292634256) passed the Worker test step, D1 migrations, deployment, and Verify. Main CI [run 41292634211](https://github.com/Torutesu/HonmaruAI/actions/runs/41292634211) passed its required jobs. Post-deploy `/health` returned `ok: true` and all encryption checks true; `app.honmaruai.com` returned HTTP 200. No live production AI request was sent, so guideline delivery was not exercised against a provider. No new paid service was added; Simple mode remains available.

### 2026-11-01 — KY-006 room-resource link access review (local, not released)

- Kylon's inspected app menu did not expose a room-link editor. This Honmaru feature is tracked as an extension; Kylon UI parity remains unverified.
- In the independent worktree, room links are treated as navigation only. Link changes require app-maker/Admin authority and a current readable target room. App room keys are filtered for each viewer in library, detail, Home, and MCP responses; unreadable requested rooms return a generic 404. Apps created directly or from templates in a private room, DM, group, or agent chat default to private access.
- Nine related Worker test files passed (234 tests), followed by a focused 137-test rerun covering the latest agent-room alias change; the full Web suite passed (1,353 tests), the Web production build completed, and the focused `HarnessApps` check passed. The full Worker suite was not completed locally. Main CI and Worker deployment for PR #602's merge are still running. No production data, settings, or app links were modified. PR #603 is open and its CI is running; production release and post-deploy multi-user ACL verification remain pending.

### 2026-11-01 — KY-006 room-resource links (production release)

- PR [#603](https://github.com/Torutesu/HonmaruAI/pull/603) merged as `b238bb5c1fa71639320d8330cae6df8ca2fe1f2f`. Main CI [#41303806986](https://github.com/Torutesu/HonmaruAI/actions/runs/41303806986), Worker deployment [#41303806967](https://github.com/Torutesu/HonmaruAI/actions/runs/41303806967), and Web deployment [#41303806966](https://github.com/Torutesu/HonmaruAI/actions/runs/41303806966) succeeded. Production Worker `/health` returned `ok: true` with `encryption.all: true`; `app.honmaruai.com` returned HTTP 200.
- With the Mac unlocked, compared the existing empty `UI確認用タスク` app in the signed-in Kylon and Honmaru desktop apps. Both showed an empty table and adjacent conversation. The read-only check did not change app data or the existing QA draft. This confirms the inspected layout only; multi-user production authorization isolation remains unverified.
- No new paid service was added. Honmaru Simple remains available.

### 2026-11-01 — Data viewer record creation action (production verification)

- With the Mac unlocked, compared the same empty `UI確認用タスク` app in signed-in Kylon and Honmaru. Kylon exposes one `新規タスク` action in the data-viewer header. Honmaru exposed that header action plus a second `行を追加` button below the table.
- Removed the duplicate lower action and retained the existing header action and `addRow` flow. When the app and table share a name, the create label now derives its record noun from the title column (`タスク名` → `新規タスク`); distinct table names continue to supply the noun. Added a regression test that the viewer renders exactly one record-create action with the expected Japanese label. Existing Simple mode and data APIs are unchanged.
- After the label refinement, `HarnessApps.test.tsx` passed all 12 tests, the Web production build passed, and `git diff --check` passed. PR [#607](https://github.com/Torutesu/HonmaruAI/pull/607) merged as `54223d580234fcc8ed9f153f6b96926874a183c6`; exact-head PR CI [#41312452856](https://github.com/Torutesu/HonmaruAI/actions/runs/41312452856) passed all nine jobs, and Web deployment [#41314362673](https://github.com/Torutesu/HonmaruAI/actions/runs/41314362673) succeeded.
- After deployment, Worker `/health` returned `ok: true` with `encryption.all: true` and `app.honmaruai.com` returned HTTP 200. The authenticated native production screen now shows exactly one `新規タスク` action in the table toolbar and no lower `行を追加` button. The QA composer draft reappeared after the native app reloaded; the table remained empty, and no app data or settings changed. The signed-in Kylon and Honmaru screenshots show the same empty task view and its controls, but the comparison is not pixel aligned because the themes and window sizes differ.
- This closes one concrete data-viewer interaction mismatch only. Other table, workflow, app detail, ACP, external connection, mobile/native, and provider-dependent Kylon gaps remain tracked in the parity matrix.

### 2026-11-01 — Data viewer table heading (production verification)

- The production comparison showed Kylon's table header uses the record type (`タスク`) while Honmaru repeated the app name (`UI確認用タスク`) even though the primary title field is `タスク名`. The app name remains in the breadcrumb; this is a display-only distinction.
- The data viewer now derives that header as `タスク` when app and table share a name and the title field supplies a specific noun. Generic fields such as `名前`, `氏名`, `件名`, `タイトル`, and `Name` keep the existing table name. No existing table, record, or app setting is migrated.
- `HarnessApps.test.tsx` passed all 13 tests and the Web production build passed. PR [#608](https://github.com/Torutesu/HonmaruAI/pull/608) merged as `8f75f3d77ffb109dc8c18f1126106c3730dc4d93`; exact-head CI [#41317238264](https://github.com/Torutesu/HonmaruAI/actions/runs/41317238264) passed all nine jobs and Web deployment [#41319157090](https://github.com/Torutesu/HonmaruAI/actions/runs/41319157090) succeeded. The gateway heartbeat test now waits for a successful retry or abort instead of a timing-sensitive fixed sleep; the complete local gateway suite passed all 43 tests.
- After reloading the signed-in production desktop app, the app breadcrumb remains `UI確認用タスク` and the data-view heading is `タスク`. The table remains empty, the toolbar has one `新規タスク` action, and the unsent composer draft returned after opening the chat. No app data or settings changed. Worker `/health` returned `ok: true` with all encryption checks true; `app.honmaruai.com` returned HTTP 200. This closes the heading mismatch only; broader UI and feature gaps remain in the parity matrix.

### 2026-11-02 — Generated app default views (production release)

- The signed-in comparison showed Kylon's generated task app starts with one `すべて` table view while Honmaru's generated app included extra board and calendar views the request did not ask for. New natural-language app generation now defaults to one unfiltered table named `すべて`/`All`; it keeps board, metrics, and calendar views only when those view types are explicitly requested. The generic no-model tracker follows the same rule. Purpose-built CRM, hiring, and invoice templates retain their configured views; existing apps and personal views are untouched.
- PR [#609](https://github.com/Torutesu/HonmaruAI/pull/609) merged as `1b79ab8eebf966c3ae794cc084e47babf8a2a7ee`. PR CI [#41321141811](https://github.com/Torutesu/HonmaruAI/actions/runs/41321141811) and main CI [#41323693570](https://github.com/Torutesu/HonmaruAI/actions/runs/41323693570) passed the executed jobs; iOS and Windows were skipped in those runs. Worker deployment [#41323693571](https://github.com/Torutesu/HonmaruAI/actions/runs/41323693571) succeeded and its post-deploy health check passed. No production app or record was created for verification. No new provider, service, or charge was added; Honmaru Simple is unchanged.

### 2026-11-02 — Generated app request fidelity and initial rows (production release)

- Follow-up review found that long room guidelines could truncate the actual app request and could influence template matching as if they were the user's words. The request and guideline snapshot now stay separate: the full request reaches the model, classification uses the request, and explicitly stated room field-type rules are still applied unless the requester specifies a conflicting type.
- Model-designed views keep explicit multiple views, sorting and grouping; generated IDs are discarded and assigned by the server. Clearly excluded view types are removed and structurally invalid board/calendar views return an error rather than silently becoming a table. A model-provided `viewPolicy` retains the single `すべて`/`All` default when the request contains no view instruction. Natural-language interpretation and the model-free template fallback remain limited and are not claimed to match every Kylon request.
- Natural-language generation now starts with zero sample rows. A new Initial data control lets the creator explicitly select a maximum of 0–20 real example records; prompt wording alone cannot insert them. The server limits examples, removes unverified person references, detects common conflicting requests, and rechecks stored samples before publication. Old incomplete proposals without the new format marker are fenced and must be started again; already completed requests still replay. Starting an old captured-source request again creates a new source thread; the old thread and its replies remain separate. Direct template creation retains its existing sample behavior.
- The updated client uses `/app-generation-v2` and never falls back to the old route: an older Worker rejects this path without creating records. Both routes remain supported by the updated Worker. Room access, source message, workspace membership, and room privacy are checked at the relevant write boundaries; source-guideline access is checked before model dispatch. Captured room identity is included in new job fingerprints, and incomplete older room jobs are fenced before a new request may start.
- Room identity is currently based on `businesses.created_at`, not an immutable unique generation identifier. If a room is deleted and recreated before a request begins, old messages with the same channel key can still be mistaken for messages from the new room; identical creation timestamps also cannot distinguish generations. The safeguards therefore do not provide complete room-generation isolation. A complete solution requires a durable unique room generation attached to messages and a migration policy for older messages. Database authorization checks cannot be made atomic with the external model request, so a small window remains after the final check and before network dispatch.
- The focused Worker run passed 159 tests across six files; an additional lease-expiry regression passed in a later 140-test run across three files. The full Web suite passed 1,371 tests and the Web production build passed. An isolated pre-change Worker returned 404 for the new route without changing apps, tables, rows, generation jobs, or messages. PR [#610](https://github.com/Torutesu/HonmaruAI/pull/610) merged as `e87db3d758b66db47a600e227b2472bb9ec6bed8`; PR CI [#41330925425](https://github.com/Torutesu/HonmaruAI/actions/runs/41330925425), the executed main CI jobs [#41333466879](https://github.com/Torutesu/HonmaruAI/actions/runs/41333466879), Worker deployment [#41333466905](https://github.com/Torutesu/HonmaruAI/actions/runs/41333466905), and Web deployment [#41333466856](https://github.com/Torutesu/HonmaruAI/actions/runs/41333466856) succeeded. Main iOS and Windows jobs were skipped, while both passed in PR CI. The deployed Worker health check passed with all encryption checks true, and the Web returned HTTP 200 and served the versioned API route. No live model call, production record, or new paid service was used for verification. Mac screen capture reported the machine locked, so the new control and production generation flow have not yet been visually verified.

### 2026-11-02 — Simple private room deletion (local verification)

- Simple private room creation now inserts the room as private and its initial members in one D1 batch. A name race cannot attach those members to somebody else's existing room, and a failure in member insertion rolls back the room. Names with pre-existing orphaned membership or messages are refused without deleting them, so a newly created private room does not inherit unknown history or members. A formerly virtual room with such data also requires a different name. Every selected member's workspace membership, role and login must match the server snapshot in the insert transaction; stale or unrecognized selections return 409 and no room is created. The API does not carry a membership-generation stamp from selection time, so a rejoin before that snapshot cannot be detected. This does not supply a unique generation ID for public same-name room recreation, repair already deleted room histories, or establish provenance of earlier messages.
- An isolated HTTP regression reproduced a private legacy room's history becoming accessible to a nonparticipant after deletion: the room row and membership were removed while messages remained under a key treated as a virtual public room. Its cards were also unfiled, broadening their audience.
- Deleting an unmanaged private room now atomically retains a closed archived room and deleted access policy, removes memberships, and keeps cards associated with the closed room. The existing tombstone policy prevents ordinary rejoin and same-slug recreation. After deletion of a tombstoned room the relay receives a best-effort request to disconnect every Jam participant, including managed-public-room viewers without membership rows. Public Simple rooms still unfile cards and can be recreated; their unfile now occurs in the same transaction as deletion so a later room's cards are not changed. Legacy public Jams retain their previous behavior because the slug can be reused immediately. Workspace membership, room privacy, creation time and managed-room initialization are rechecked at commit.
- This change protects future deletions only. Old messages left by already deleted rooms lack reliable generation provenance and are not repaired. Creation timestamps are not unique room-generation IDs, so same-timestamp deletion/recreation remains ambiguous. A message whose authorization was resolved before deletion may still be stored after deletion, though the existing delivery fence prevents live/push delivery; open clients may retain data already received. Jam eviction is best effort and is not durable if the Worker or relay fails after commit. Full room-generation migration and client-cache reauthorization remain open. Large public-room deletion may exceed D1 response limits; the transaction fails without partially unfiling cards.
- Twelve focused Worker files passed 186 tests; a later focused run of three files passed 45 tests after adding the orphan-message guard. Coverage includes message/search access, card visibility, rejoin/recreation/restore, queued delivery, public recreation, stale permissions, workspace purge, same-slug card race, transactional rollback and actual Jam sockets. No production data was used. CI and production release are pending.

### 2026-11-01 — KY-015 channel overview Agent disclosure (local verification)

- Found that `/channels` could advertise a managed Agent's name, handle, and scope when the Agent was placed in a room readable by the caller, even though the caller lacked the Agent-specific grant and direct execution was denied. The channel overview now checks current Agent callability before returning room-placement entries. Added a regression test for a private Agent placed in readable `b:ops`.
- The follow-on direct API audit also found mixed-case `Guest` memberships could retain stale Agent roles, per-Agent Native source / Remote MCP grants, scheduled execution eligibility, and Remote MCP OAuth credentials. Membership checks now normalize case in Agent roles, scheduled execution, Native source grants, Remote MCP permissions and OAuth credential access, and access-request owner enumeration; regression tests prove the stale grants stop authorizing use and cannot be re-granted.
- Five focused Worker test files passed (118 tests): `agent-roles.test.js`, `smithery-apps.test.js`, `remote-mcp.test.js`, `harness-agents.test.js`, and `agents.test.js`. `git diff --check` passed. No production request or data was changed; this expanded fix is still pending exact-head CI and release. KY-015 remains partial pending review of all direct API and external execution paths and multi-user production isolation.

### 2026-11-02 — Personal view removal (local verification)

- The data viewer could create up to 12 personal views but offered no way to remove one. The personal-view menu now lets its user remove the selected personal view after an inline confirmation; the server removes an orphaned layout and selects the first shared view when the active view is removed. Shared views, app records and other users' settings are not changed. At the limit, the menu explains how to make room. Focus returns to the selected shared tab after successful deletion.
- Shared view IDs can already start with `personal_`, so UI ownership now follows the actual shared/personal list rather than an ID prefix. A legacy personal view colliding with a shared ID is disabled rather than edited or deleted through an ambiguous tab; no existing settings are migrated. The Worker rejects newly introduced collisions in either direction, fences concurrent changes in the same D1 transaction, and leaves legacy collisions readable and removable through the existing API. If a save finishes while a prior refresh is in flight, the client retains the newer personal revision while applying the refreshed app data.
- The existing per-user revision check rejects stale cross-device edits. Returning focus, becoming visible, or reconnecting now rereads settings; an open editor, a focused field, an in-flight inline cell save, or a personal-view save defers the refresh, including when editing starts during an in-flight refresh. Newer settings are never replaced by an older GET or save response; after a stale GET the client rereads the app and server-computed rows together, checking the app version before display. This is return-to-view synchronization, not live push between two continuously open devices.
- Settings writes atomically recheck app access and version, and reads recheck access before returning computed records. Component tests cover cancel, confirmation, other views, shared-view protection, focus and conflict retention. Worker tests cover fallback and reread from another session, stale revision, shared definition and record preservation, legacy IDs, simultaneous shared/personal saves, rollback of a table edit, excluded or newly valid view definitions, and access or app-version changes before a save or read. Focused Web tests passed (35 tests), the full Web suite passed (1,387 tests), Worker app and conversation tests passed (134 tests), and the Web production build passed. No production settings or records were changed. The Mac UI controller reported locked, so the new control has not been visually verified or compared with Kylon; CI and release are pending.

### 2026-11-02 — Personal view consistency and recovery (local verification)

- A personal-view response now includes the app, schema, rows and shared views used to compute it. The client uses that response as one rendered snapshot and reloads after saving; it does not combine those computed rows with a separately fetched row set. App links in this response use the same room-access filtering as the app endpoint. For an older Worker that does not provide a snapshot, the client retains its previous compatibility path, so the stronger snapshot guarantee requires the updated Worker.
- Settings writes and the final response check now fence the table columns and update timestamp as well as app version and access. A concurrent direct table-column edit fails the save rather than persisting settings normalized against stale columns. An access-related 404 on refresh clears previously shown app, personal-view and related data; temporary network errors leave the current screen available.
- Legacy shared/personal ID collisions remain disabled as ambiguous tabs, but the view menu offers an explicit confirmation to remove the conflicting personal view alone. Its shared view, rows and shared-ID layout are preserved. No pre-existing data was migrated or removed for verification.
- Worker app and conversation tests passed (136 tests), the complete Web suite passed (1,389 tests), and the Web production build passed. Tests cover concurrent schema and row changes, filtered private-room links, recovery from an ID collision, and access revocation versus a temporary error. These changes are local and pending exact-head CI, production deployment and authenticated visual verification. Synchronization remains on focus, visibility and reconnect, not live push.

### 2026-11-02 — Jam access races (local verification)

- Fence pending joins against room, membership, session and socket eviction, including joins still resolving their channel, and serialize same-channel joins and departures. Recover provisional join metadata after an interrupted Durable Object without treating pending sockets as peers.
- Keep current socket state across session rechecks, alarms and reauthentication; do not restore an evicted Jam from an older attachment. Suppress delayed join, reaction and transcript delivery when the original peer has already left. Actual WebSocket race tests and simulated interruptions cover these boundaries.
- Eviction remains best effort when the Worker or relay fails. A transcript or start message whose write already began can finish after eviction. External notifications and storage updates are not atomic: a crash or close-event ordering may leave an old Jam without an end notification. Unique room-generation IDs, historic orphan cleanup and client-cache reauthorization remain open.
- Nineteen related Worker files passed 286 tests in an independent clone. CI and production deployment are pending. No production records were created for verification.

### 2026-11-02 — Combined generation authorization fences (local verification)

- App database, action, automation and custom generation snapshot the authorized source-room guidelines and recheck them around model use and after model reservation cleanup. Database generation also rechecks the captured schema and linked-table access. Focused tests exercise revoked source access, changed schema, and changes during cleanup using local synthetic data.
- The final database check combines captured source, schema, applicable agent access and custom-generation action, connection and gateway snapshots in one statement; independent tests reproduced and then fenced changes between the earlier separate checks. That database statement and dispatch to a model provider are not atomic: a request already dispatched may reach the provider before revocation is observed. Room and membership timestamps are not unique generation IDs, so same-timestamp replacements remain ambiguous. CI and production verification are pending.

### 2026-11-02 — Room lifecycle and personal views (production deployment)

- Private Simple room lifecycle protection merged as PR #612 (`9a49c6f1`) after all nine PR CI jobs passed. Worker deployment #41342196384 succeeded with version `aca641c0-fd17-4ebb-a67b-0b27e9e1273a`; the health endpoint reported OK. It protects future deletions, not already orphaned histories, and Jam eviction remains best effort.
- Personal views merged as PR #614 (`69d3e660`) after all nine PR CI jobs passed, including a rerun of an iOS simulator failure. Worker deployment #41344109438 succeeded with version `5fa2aca1-de6a-4915-a6ca-4751d47f5a06`; Web deployment #41344109488 succeeded, the app returned HTTP 200 and the Worker health endpoint reported OK. Synchronization refreshes on focus, visibility and reconnect rather than live push.
- The native automation tool reported the Mac as locked despite the user's confirmation that it was unlocked; a new browser tab was signed out. Authenticated production interaction and visual comparison were not verified. No production records were created for these checks.
### 2026-11-07 — Harness Agent tool traces (local verification)

- Harnessのinline Agentが実際にツールを呼び出した返信に、最大16ステップのツール名・完了/失敗/中断状態・所要時間だけを保存し、返信内の「Worked for」開示から遅延取得できる。引数、入力、ツール出力、例外内容はトレースに入れない。Simpleモードでは記録も表示もしない。
- 読み取りごとに現在のworkspace membership、channel access、Agent audienceを再確認し、workspace adminでも個人Agentの権限を迂回できない。削除済み返信・親スレッド・Agent・Simple modeは404で閉じる。返信削除時は外部キーのcascadeに従う。
- Worker focused tests passed (88 tests: `agent-chat-tools.test.js`, `agents.test.js`, `migration.test.js`); Agent trace component tests passed (2 tests); Web production build passed. The complete Worker/Web suites, CI, production deployment, authenticated UI inspection and side-by-side Kylon comparison remain pending. The parity item stays partial because durable/external provider traces and mobile rendering are not covered.


### 2026-11-07 — KY-105 edited-draft handoff production release

- PR #788 was restacked onto main and merged as 2070c40714b952e7ddff26c3b0052f4b8f98a002. The previous draft PR #773 was closed as superseded. The implementation keeps the changed span scoped to the user, workspace, originating Agent and card, passes it once to the next direct message to that Agent, supports explicitly saved personal writing preferences, and includes export/deletion handling. Simple-mode paths remain intact; no new paid service was added.
- Exact-head PR CI 42348597887 and post-merge main CI 42349710775 passed. Worker deployment 42349710789 completed D1 migrations, column additions, deployment and production verification; health reported ok:true and encryption.all:true. Web deployment 42349710776 passed Pages deployment, domain verification, and confirmed app.honmaruai.com serves index-DQFLbTXr.js.
- KY-100 remains partial: authenticated Kylon/Honmaru interaction comparison for editing, one-time next-message handoff, discard, preference management and export/deletion UI has not yet been done. No production content was used to verify those interactions.

### 2026-11-08 — KY-111 record mutation proposals (local verification)

- Record-scoped AI replies can return up to eight column changes as a persisted proposal; the model is explicitly told it has no tools and cannot claim execution. Only members with current table edit access see review controls. Proposals expire after 24 hours.
- Approval claims the pending proposal once, rechecks app/record/table access, then uses the existing `updateRow` strict validation and `expectedUpdatedAt` CAS path. Rejection never writes. Undo restores only proposed fields and only if the row still has the exact post-approval version. No generic code execution, add/delete, or other-record target was added. The D1 change is additive, Simple mode is unchanged, and no new paid service is introduced.
- Worker `harness-conversations.test.js`: 119 tests passed, including apply/undo and stale-conflict regressions. Web full suite: 246 files / 1,824 tests passed; AppConversationPanel tests: 11 passed; TypeScript and production build passed. `node --check` and `git diff --check` passed. Full Worker run was attempted but interrupted after unrelated network-dependent cases reported `Network connection lost`; it is not recorded as a pass.
- Exact-head CI, PR review/merge, D1 migration and production deployment, plus logged-in visual comparison against Kylon remain pending. No production record was edited during local verification.

### 2026-11-08 — KY-015 execution-time connection authorization (local verification)

- Native connection credential reads now recheck the current workspace membership and Agent audience at the credential boundary, in addition to the source grant. Remote MCP execution checks and tool enumeration do the same. This prevents a future caller from relying only on a stale filtered Agent list.
- Regression coverage changes the Agent audience to private after a grant and verifies Native credential access, Remote MCP execution, and Remote MCP tool enumeration all fail closed. Focused Worker tests passed: 66 tests across `harness-agents.test.js`, `remote-mcp.test.js`, and `smithery-apps.test.js`. `node --check` and `git diff --check` passed.
- Full direct API/provider audit, exact-head CI, production release, authenticated multi-user isolation, and Kylon comparison remain pending; KY-015 stays partial.

### 2026-11-08 — KY-006 room-name privacy and link-write fence (local verification)

- Audit found that `GET /apps/:id/access` returned linked private room keys and a private room scope to an App viewer who was not a room member. The response now checks current room readability before returning linked room names or `access.roomChannel`; an explicitly granted App viewer still receives the App while the private room name stays hidden.
- `linkApp` now includes `conversationWriteAuthority` in its conditional INSERT and verifies current authority for idempotent links. A room membership revoked between the route's read check and D1 write can no longer add the link.
- `harness-apps.test.js` passed all 136 tests, including the new room-scope redaction and lower-level revocation check. Exact-head CI, production deployment and authenticated multi-user verification remain pending.

### 2026-11-08 — KY-049/KY-050 implementation ledger correction

- Re-audit confirmed that App `workspace/private/room` access already applies across Table, MCP, Home and Workflow; published Custom Apps already have consented, expiring, revocable read-only snapshot links and Cloudflare Pages custom-host support. Database Apps are explicitly rejected from anyone links. These items were previously incorrectly labeled unimplemented in the ledger.
- The ledger now marks KY-049 and KY-050 partial instead of missing; actual Cloudflare DNS/certificate activation and anonymous production verification remain open.

### 2026-11-08 — KY-099 published Custom App guest runtime (local verification)

- External guests now receive only a valid published Custom App source; drafts are never returned. The UI runs that source in the existing opaque-origin sandbox, loads only App-linked tables, and routes edit-grant writes through the existing guest-authorized endpoints. Custom App server actions and external connections remain unavailable to guests. Simple mode is unchanged.
- Focused Worker tests passed (16 tests, including published-only source, unpublished rejection, invite, and linked-entity table keys). Web tests passed (all 248 files / 1,829 tests; the focused external-App/Custom-App group passed 19 tests), and the Web typecheck/production build passed. The full local Worker suite did not complete because its 301-file run emitted repeated network-connection errors; exact-head CI, production release, and authenticated multi-user comparison remain pending. KY-099 stays partial.

### 2026-11-08 — KY-029 memory provenance (local verification pending)

- New memories created from a conversation now retain source conversation, message ID, and thread ID separately from their authorization scope. Memory list/detail data carries these references, and the UI shows IDs without copying source message content. Legacy rows remain explicitly unknown; no historical source is inferred. Person-scoped memory tests assert references do not widen owner-only visibility. Simple mode is unchanged and no new service is used.
- Focused tests, migration validation, exact-head CI, production release, and authenticated visual verification are pending. KY-029 remains partial because cross-conversation person settings and legacy provenance cannot be reconstructed safely.
### 2026-11-09 — Batched parity ledger and release evidence reconciliation

- Reconciled the inventory against current main `93951cea`: 102 requirements, rather than the matrix's stale 98. KY-112 had shipped in PRs #823/#826 but was still labeled missing; corrected it to partial and recorded the implementation scope and release evidence. Kept it partial because authenticated production acceptance and side-by-side Kylon interaction remain.
- Updated KY-063 and KY-111 with the deployed no-replay workflow recovery and record-proposal release evidence. Main CI run `42494741384` passed; Worker deployment `42494741296` completed migrations, Deploy and Verify. These checks do not establish full parity.
- Read-only authenticated Kylon inspection showed the Data Viewer toolbar (view picker, new view, fields, filter, group, more actions, sortable columns, add record) and an empty table. No Kylon data was changed. This did not verify mutation/approval interactions.
- Added a bookkeeping guard requiring the human matrix date and total to match the machine-readable inventory. Simple mode and existing service contracts were not changed; no new service or paid integration was introduced.
- Validation: `node scripts/check-kylon-parity.mjs` and `git diff --check` pass. This batch updates evidence and prevents ledger drift; it does not implement the remaining open features.
### 2026-11-09 — Workflow approval membership revalidation

- Revalidated current workspace membership when a Workflow approval is decided through either `card_updated` or AG-UI `tool_result`. Existing long-lived sockets can outlive the generic ten-minute membership recheck, so the decision boundary now rejects a removed approver.
- The lower-level Workflow run claim also requires the stored approval recipient still to be a workspace member in the same conditional D1 update that claims the exact waiting run/card. This closes the gap if membership is revoked after relay validation but before settlement. The run remains waiting and cannot continue to its side effects.
- Regressions cover both relay protocols, lower-level settlement after revocation, and unchanged pending card/run state. Combined `harness-workflows.test.js` + `relay-auth.test.js`: 136 tests passed. Parity inventory check and `git diff --check` passed. Exact-head CI and production deployment are pending; no production approval or data was changed.

### 2026-11-09 — Agent assignment membership-generation fence

- Durable Agent assignment creation and idempotent replay now require the actor's current non-guest workspace membership. This prevents an auth-to-write race from creating an assignment with a null membership generation and prevents a revoked actor from retrieving a prior assignment as though it were still executable.
- Atomic handoff now requires the assignment's exact original membership generation to remain active. Removal, rejoin, guest downgrade, and legacy null-generation assignments cannot advance Agent ownership or emit a handoff message/outbox entry.
- Regression batch: `npm test -- --run test/agent-assignments.test.js test/agent-peer-roles.test.js test/agent-wake-approvals.test.js test/agents.test.js` passed, 4 files / 87 tests. This is local evidence; exact-head CI, production deployment and multi-user live verification remain pending. No production Agent or user data was touched.

### 2026-11-09 — Company App migration journal visibility

- Company App now displays the persisted database migration journal with schema version, migration ID, timestamp, and checksum status. It renders a migration plan only when the server reports a valid checksum; tampered history is marked with an alert and its plan stays hidden.
- Existing Worker coverage includes replay/idempotency, conflicting plan IDs, tamper detection, failed-apply atomicity, and stale schema/data snapshots. Web regression coverage verifies valid-plan visibility and tampered-plan suppression; `npm test -- --run src/components/CompanyApp.test.tsx` passed (5 tests).
- Local verification only; web typecheck/build, exact-head CI, production release, authenticated screen check, and Kylon side-by-side comparison remain pending. No production data or schema changed.

### 2026-11-09 — KY-096 floating App placement persistence

- Rebased the implementation worktree on authoritative main `c166511050df42c39f661f79d94528aaff624fe9` after finding the default checkout was stale. Floating App position and size now persist only in browser storage under a key scoped to signed-in user, workspace, and App. Reopening the App restores the last explicit placement; viewport changes clamp it to reachable bounds. Storage errors fall back to the current session. No geometry is sent to the server, so this does not add a service or cross-device sync. Simple mode never reads or writes the preference and continues to reset the floating surface on mode/account/workspace changes.
- Verification: focused Web tests `FloatingAppWorkspace.test.tsx` and `floatingApp.test.ts` passed (2 files / 9 tests); Web full suite passed (254 files / 1,868 tests); Web production build passed; `node scripts/check-kylon-parity.mjs` reports 104 inventory rows consistent; `git diff --check` passed.
- Not yet verified: browser-process restart/reopen on an authenticated production account, Kylon's equivalent restart behavior, and cross-device restoration. The Mac was locked during this turn's browser check, so no production or Kylon screen assertion is claimed. This change moves one bounded part of KY-096 forward; it does not establish full parity.

### 2026-11-09 — KY-081 LINE customer Inbox

- Added a room-scoped LINE Inbox with conversations grouped by pseudonymous customer key, latest text preview, message detail, per-actor read cursors, and links to the original room conversation. Raw LINE identifiers are not persisted in the new Inbox index. Existing webhook signature verification, event replay protection, no-auto-reply behavior, and text-only intake remain in place.
- Verification: Worker `test/room-hooks.test.js` passed (19 tests); Web `RoomWebhooks.test.tsx` passed (12 tests); full Web suite passed (254 files / 1,869 tests); Web production build passed; parity inventory consistency check and `git diff --check` passed. Full local Worker suite could not complete because the Cloudflare test runtime repeatedly reported `Network connection lost` and an internal Miniflare error; CI remains required for the full Worker suite.
- Still not verified/implemented: real LINE Developers round-trip, LINE Access Token and outbound replies, media download, customer-facing Kylon side-by-side comparison. No new paid service or automatic reply was added.

### 2026-11-09 — Workflow active-run cancellation

- Added an explicit maker/admin cancel action for a running Workflow. The endpoint checks the exact run ID, workflow ID, status and start timestamp, then atomically marks it cancelled and records the current step as outcome-unknown. The runner checks terminal state after awaited step execution and stops before persisting a stale result or dispatching later steps.
- UI asks for confirmation and explains that a current external action may already have completed or may still finish. Approval-waiting runs are not included; their existing approve/decline controls remain authoritative.
- Focused Worker workflow tests and Web `HarnessWorkflows.test.tsx` passed; the Web production build passed. Parity inventory consistency and `git diff --check` passed. Exact-head CI and production release are pending.
- Cancellation does not guarantee interruption or rollback of an external request already issued. Kylon side-by-side and production behavior remain unverified; KY-065 remains partial. No new paid service was added and Simple mode is unchanged.

### 2026-11-09 — KY-083 image job acceptance and persistence QA

- Reconciled KY-083 from missing to partial after PR #855 merged the Harness-only, owner-Agent image-generation flow. Video/audio creation and fixed-amount pre-cost quotes remain unimplemented; generated output costs vary, so the UI asks for explicit approval of that uncertainty.
- Expanded mocked-provider QA across successful private R2/file-ledger persistence, duplicate dispatch prevention, provider rejection, unknown outcomes after lease expiry, and cancellation before dispatch. The success case exposed a SQL alias error in the final ownership-fenced success update; fixed it by qualifying the update target consistently.
- Focused Worker suite `test/media-generation.test.js`: 5/5 passed after the fix. Full Worker CI, exact-head CI, and deployment for this fix remain pending. No live provider request or new paid service was used; Simple mode is unchanged.
