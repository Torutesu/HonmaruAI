Warning: truncated output (original token count: 225719)
Total output lines: 4608

### 2026-11-16 — CLI thread creation alias (candidate)

- Added `honmaru workspace thread create <room-id> --text ... --request-id ... [--file-ids ...]`. It creates a thread root through the existing user-authored, idempotent `send_message` MCP path; request IDs and attachment count are validated before network calls.
- The explicit Room argument and existing token scope/Room ACL checks are preserved. No new service, paid contract, database change, or Simple-mode behavior change.
- CLI suite passed **64/64**; `git diff --check` passed. Exact-head CI, merge, and production deployment are pending. KY-085 remains partial: thread activation/participants and the wider CLI surface still need implementation and Kylon comparison.

### 2026-11-16 — CLI/MCP file conversations (candidate)

- Added file conversation `get` and `open` to MCP and the workspace CLI. `get` never creates a thread; `open` reuses the deterministic file-thread root and synchronizes its message through normal channel events. Both resolve the current file and channel membership before returning; opening requires `files:read` and `chat:write`, and private Room/DM scopes remain enforced by the shared conversation resolver.
- CLI suite passed **66/66** and Worker `mcp-chat.test.js` passed **52/52**, including absent-root lookup, idempotent open, current audience, missing file scope and private Room scope. The full Worker suite is still running. No migration or paid dependency; Simple mode is unchanged. Exact-head CI, merge, production release and authenticated Kylon comparison remain pending.

# 検証記録

### 2026-11-15 — Concurrent read-only Workflow table queries (candidate)

- The TypeScript SDK already bounds `parallel()` and `pipeline()` concurrency, but the Guest-to-host broker serialized every RPC, which silently serialized concurrent `table.query()` reads too. The broker now lets only read-only table queries bypass that queue. State/checkpoint and staged-effect operations retain their existing serialized order; table queries still pass through the same activation-bound Worker broker, live ACL checks, and page/result limits.
- Added a regression proving concurrent table reads can finish while a checkpoint write is pending and checkpoint execution remains ordered. No new service, paid contract, package, migration or Simple-mode change.
- Local Gateway suite passed **97/97**, including the new concurrency regression and existing ordered-checkpoint, activation-cancellation and isolated-guest tests. `git diff --check` and parity requirements JSON parse passed. Exact-head CI, merge and deployment are pending. KY-060 remains partial; broader App/Connection API paging, run interruption recovery, and production/Kylon acceptance remain open.

### 2026-11-15 — Workflow Agent read-only skills and memory (candidate)

- Extended the existing `agent(prompt, { agentId, schema, tier? })` Workflow SDK to use the saved Agent's installed skills and memories. Tool calls are filtered to the established read-only skill readers and user-scoped memory search/read helpers; memory review/write, remote connectors, recursive Agents, and delegation are not supplied. Existing per-call access rechecks, provider usage accounting, Workflow AI budgets, timeout and bounded tool-call loop remain in force.
- Added a Worker integration regression that walks the actual model tool loop for a saved skill and memory, checks returned source text reaches the next model request, and verifies write/external tools are absent. No new service, paid contract, package, migration or Simple-mode change.
- Local QA passed: **107/107** tests across `workflow-agent-invoke`, `harness-skills-access`, `harness-agents`, and `harness-model-tools`. The invocation regression verifies that the model receives only the five allowlisted read tools, sees the actual skill and memory text in subsequent turns, and has no memory-review or remote/write tools. Exact-head CI, merge and deployment are pending. KY-059 remains partial; `app()`, provider proxy/general Connection API, complete runtime parity, and authenticated production/Kylon acceptance remain open.

### 2026-11-15 — Workflow SDK Agent invocation (local QA)

- Added `agent(prompt, { agentId, schema, tier? })` to the isolated Workflow TypeScript SDK. Saved programs must explicitly bind 1–20 Agents; save, view and enqueue paths validate current access, and the Worker rechecks the exact binding and live Agent/Workflow ACL before, during and after invocation. The guest cannot provide workspace, run, lease or replay identity.
- Calls use the existing configured provider and Workflow/workspace AI budgets, record usage, run without tools or recursive Agent delegation, cap each completion at 25 seconds and each Gateway job at five distinct invocations, and validate bounded JSON Schema/output. A D1 invocation journal caches completed output for identical inputs; running or failed calls are not resent after an ambiguous result.
- Added the Agent allowlist to the Workflow program editor and persisted `sourceAgents` bindings. No new provider/service or package was added; existing Simple mode is unchanged.
- Focused Worker Workflow invocation/code-job/state/Gateway/migration suites passed **134/134**. Gateway bridge/guest tests passed **19/19**. The Workflow editor suite passed **8/8**, including explicit Agent binding persistence, and Web production build plus TypeScript check passed. Worker also enforces the 12 KB UTF-8 prompt limit and rechecks access after output validation immediately before result persistence. Exact-head CI, merge, deployment and authenticated production/Kylon acceptance are pending.

### 2026-11-14 — Thread Room audience archive/deletion fence (local QA)

- Closed the stale-membership gap in Thread Room sharing. Both `externalThreadPermission` and every caller of the shared Thread audience SQL predicate now require the target Room to still exist, remain unarchived, and have no deletion tombstone. Existing Room memberships alone cannot preserve access after archive/delete.
- Batched Worker regressions across external Thread, App, collaborator and File grants passed **67/67**. The new integration test verifies a Room-scoped Thread is readable before archive, denied after archive and denied after a deletion tombstone through both the helper and generated SQL predicate.
- Exact-head CI, merge and production deployment remain pending. KY-099 remains partial; cross-workspace authenticated production acceptance and direct Kylon UI comparison are still open. Simple mode is unchanged; no paid service or schema migration was added.

### 2026-11-13 — Search, budget admission and Workflow CLI batch (PR #939 released)

- Added opt-in resource results to Room search in Harness mode: file body search is constrained to the exact Room scope and linked App records are searched only after current App/row ACL checks. Search results are reauthorized against current file version/deletion state, Room membership and App links before being returned. Simple-only users retain the previous message-only Room response; workspace-wide and thread-only search paths remain unchanged.
- Added file/App-record result cards to the existing ThreadSearch panel, using Honmaru theme variables and existing resource navigation. Kylon public Help documents Workspace search using a distinctive file/project phrase, Room and approximate date; it does not establish exact parity for indexed file-body or App-record search. [Kylon Help](https://kylon.io/help/find-previous-work)
- Deployment-key Responses `web_search` reserves the fixed per-search list-price charge plus up to 128,000 input tokens per call as a deliberately conservative search-context upper bound before dispatch. The current request caps built-in calls at four while this reservation is active; settlement counts only billable `web_search_call` actions, not `open_page` or `find_in_page`. `web_search_preview` receives the supported parameters only. BYOK and requests without an active budget reservation are unchanged. This estimate is a safety ceiling that can conservatively block a request; it is not an invoice guarantee.
- Added CLI aliases for workflow create/update/pause. Creation always makes a paused draft; update requires the exact `expectedUpdatedAt` and only edits paused workflows; pause disables future triggers and states that active runs continue. The MCP tools are Harness-only, maker/admin-scoped, write-scoped and audit the mutation. Simple mode does not expose them. Regression testing caught and closed an omitted-version update path.
- Worker regression batch passed **75/75** across Harness MCP, workspace budget, research and unified search. CLI tests passed **48/48**; Web ThreadSearch tests **5/5** and TypeScript passed. Web production build and `git diff --check` passed. No new service, migration or paid contract was added; Simple mode remains available.
- PR #939 merged as `76db474ee0a4400e6adfc9b93b79dc562d40e433`. Exact-head CI #43337139421 and main CI #43340080575 passed. Worker D1 migration/deploy/Verify #43340080401 and Pages build/deploy/domain Verify #43340080328 passed. PR #920 (local ACP teammate presets) was also observed as merged.

### 2026-11-12 — KY-059 App row mutation SDK (released)

- PR #915 adds Workflow SDK `table.update()` and `table.delete()` beside the existing `table.query()` and `table.insert()`. Row creation and row mutation are separately opted into per App entity. Updates and deletes require the query result's `updatedAt` as `expectedUpdatedAt`; the Worker rechecks current ACL, schema version, relation rules and frozen source binding when committing.
- The isolated runner stages at most four combined mutations and 24 KB. On program success, row statements, watched-row outbox events and Workflow settlement/checkpoint share one D1 batch. Failed or stale mutations settle as failed without committing any staged row. Existing insert-only installed gateways remain compatible through legacy `tableWrites` results. No migration, paid service or Simple-mode change.
- Gateway **63/63**, focused Worker Workflow/table suites **204/204**, full Web **1,956/1,956**, Workflow editor/source tests **9/9** and Web production build passed locally. PR #915 exact-head CI run **43138768742** passed all jobs; squash merge commit `6184e93043cb0a98e210eb063442fb085a32105e`. Main CI **43141503880**, Worker migration/deploy/health **43141503812**, and Web deploy/asset verification **43141503866** succeeded. Worker `/health` returned `ok:true`; deployed Pages served its new JS asset.
- KY-059 remains partial: `app()`, `agent()`, provider proxy, general Connection operations, historical row snapshots across pages, step-level external-effect reconciliation and authenticated saved-Workflow interaction/side-by-side Kylon acceptance remain unverified or absent.

### 2026-11-15 — KY-059 row trigger context for TypeScript programs (candidate)

- TypeScript programs now receive Kylon-shaped `ctx.trigger.rows` entries for row additions, changes and deletions, including `rowId`, a derived title and cell values. Deleted records expose no cell data. The existing `ctx.trigger.input` remains available for compatibility with saved programs.
- The focused Worker `workflow-code-jobs.test.js` suite passed 47/47, including queue-payload delivery and all three event shapes. `node --check` and `git diff --check` passed. Initial local test startup was blocked by sandbox loopback/log permissions; the same local test passed after approved permission elevation.
- This candidate is not yet merged or deployed. Exact-head CI and production acceptance remain pending. KY-059 remains partial; no new paid service or Simple-mode change.

### 2026-11-12 — KY-059 opt-in staged App row creation (local, not deployed)

- Added `table.insert({entityId, values})` for App entities whose Workflow source explicitly enables row creation. Each activation can stage at most four strict-schema rows; the Worker rechecks current App/Table edit permission and exact source binding before committing.
- Successful program settlement commits rows, watched row-event outbox items, run state and the program checkpoint in one D1 batch. Failed or stale writes roll back the row changes; duplicate finish delivery does not create rows twice. Update/delete APIs remain unavailable to the TypeScript SDK.
- Batched focused QA: Worker Workflow program/state suites — 76 tests passed, including App edit revocation at settlement and outbox delivery; Gateway SDK/bridge/guest suites — 14 tests passed; Workflow UI suite — 67 tests passed; Web TypeScript check and production build passed. JavaScript syntax checks and `git diff --check` passed.
- This is local evidence only. Full exact-head CI, merge, deployment, Mac runtime refresh, and authenticated production/Kylon UI acceptance remain pending. Simple mode is unchanged; no new paid service or dependency was added.

### 2026-11-12 — KY-059 multi-entity read-only Workflow query (local, not deployed)

- Extended the saved TypeScript Workflow source binding from one App entity to up to 20 explicit entities in that same App. The editor presents checkboxes; the SDK requires `entityId` when multiple sources are bound, and the Worker revalidates each exact entity-to-table mapping and current App/Table membership/ACL on every page. Existing single-source saved definitions remain compatible; Simple mode and direct VM capabilities are unchanged.
- Batched QA: Worker Workflow suites — 2 files / 184 tests passed; Gateway broker/guest/runner suites — 3 files / 33 tests passed; Workflow UI suite — 67 tests passed; Web TypeScript/Vite production build passed; `git diff --check` and JavaScript syntax checks passed. An initial QA run found a source-normalization bug and a UI test locator issue; both were fixed before the passing runs.
- This is a local change only. Full CI, authenticated production acceptance and deployment are pending. KY-059 remains partial: only bounded read-only App entity queries were expanded; broader Kylon SDK/runtime parity, safe external-effect recovery and historical row snapshots remain open. No new paid service or Simple-mode change.

### 2026-11-11 — KY-059 bound Workflow `table.query` (local, not deployed)

- Based on main `1dc9a9c0`, added a TypeScript `table.query()` helper only for a saved program with an explicit App/entity/Table binding. The source choice is visible in the program editor; Worker rejects an incomplete or inaccessible binding at save/enqueue and derives the live scope from the frozen definition on every broker page. App/Table membership, entity mapping and visibility grant are rechecked before and after each read. The Linux VM still has no direct network or database capability.
- Paging uses a createdAt/id keyset cursor bound to App, entity, Table and canonical filter, with a first-page timestamp cutoff. Page size is capped at 100; `table.query({maxPages})` caps at 32 pages and aggregate output at 1 MB. Both SDK and Worker return `complete:false` plus a continuation cursor when bounded work cannot finish; malformed/cross-source cursors and injected org/table scope are rejected. Row values are live between pages, not a historical database snapshot.
- Focused acceptance covers accessible source normalization, another-workspace source rejection, a complete two-page read and filter, malformed cursor/oversized page request, scope injection, page-cap incomplete result and revoking a private App's explicit view grant between pages. Gateway guest forwarding is tested without host/network functions. See commit SHA in the adjacent implementation branch report; this is local evidence only and not a production release or Kylon runtime parity acceptance.
- No `app()`, `agent()`, provider proxy, general Connection operation or write helper was added. KY-059 remains partial. No new service or charge; Simple path is untouched.

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
- A conflict review now lets the user choose per record to keep the live production value or apply the preview value. The decision and the full production snapshot are checksum-bound; the exact post-choice relation state is validated before commit. Choosing the preview for a colliding create explicitly updates the existing live row, while keeping production for every conflict can complete without row mutations. The atomic receipt, selected row writes, and row-event outbox remain in one D1 batch.
- Worker QA for the conflict-resolution increment: `harness-company.test.js` + `harness-app-relations.test.js`, 58/58 passing; `harness-apps.test.js`, 167/167 passing. Coverage includes both choices, stale/wrong checksum rejection, a create-ID collision, no-write completion, relation integrity, and merge replay. `CompanyApp.test.tsx`: 6/6 passing. Web TypeScript and production build passed. Exact-head CI and release are pending; the code is not yet production parity evidence.
- Limits: 50 applied row changes per merge, no schema merge, and older forks without baselines need recreation. Row workflows are queued atomically when watched; they run through the existing outbox after commit. Kylon's docs describe draft writes staying in a separate data copy rather than merging automatically; this explicit merge remains an extra reviewed action, not a requirement for preview isolation.
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
- Implemented the same dialog structure in Harness, explicit whole-form save, failed-draft preservation and disabled unchanged save. Existing access/mention controls remain under Advanced settings; Simple editor retained. Existing picture avatars remain unchanged; photo upload an…155719 tokens truncated…er deployment [run 41292634256](https://github.com/Torutesu/HonmaruAI/actions/runs/41292634256) passed the Worker test step, D1 migrations, deployment, and Verify. Main CI [run 41292634211](https://github.com/Torutesu/HonmaruAI/actions/runs/41292634211) passed its required jobs. Post-deploy `/health` returned `ok: true` and all encryption checks true; `app.honmaruai.com` returned HTTP 200. No live production AI request was sent, so guideline delivery was not exercised against a provider. No new paid service was added; Simple mode remains available.

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

### 2026-11-10 — Per-step Workflow checkpoint and redelivery fence

- Added definition-hash scoped step claims for ordinary Workflow actions, fenced leases with periodic renewal, reuse of persisted results after continuation redelivery, and no replay when a lease expires. Every ordinary action, including external reads that may consume provider quota, is conservatively treated as effectful; only pure declarative conditions can be reclaimed. TypeScript code jobs keep their existing dedicated checkpoint path.
- Added run-history errors that explicitly say an uncertain step was not replayed, and reconciled KY-059/app automation contract evidence. This is at-most-once protection for uncertain dispatch; row effects and checkpoint completion are not yet one D1 transaction, and unknown-outcome resolution UI remains open.
- Worker `test/harness-workflows.test.js` and `test/workflow-checkpoints.test.js`: 142/142 passed; `node --check`, `node scripts/check-kylon-parity.mjs`, and `git diff --check` passed. PR #857 exact-head CI run `42643217690` passed all 13 jobs and merged as `9ccd3d9c`. Main CI `42647126810` and Worker deploy `42647126743` passed, including Verify.

### 2026-11-10 — Workflow cursor-safe cancellation and recovery

- Advance the durable `next_step` with each completed step log and with the post-step budget check. Cancellation and stale-run recovery now see the actual active step rather than the original cursor.
- Added an in-flight Agent-step cancellation test that pauses the model reply, cancels after step 1, then releases a late response and verifies the prior success remains, the active step is unknown, and no later step or late Agent answer is posted.
- Worker workflow tests passed 144/144. PR #858 and push CI runs `42649250258` and `42649219190` both passed on exact head `0b8a4c17`; all applicable jobs succeeded (Windows Edge/iOS skipped on push and passed on PR). PR #858 merged as `7ddd649f5c6f47c39c3194b6eb1b5cdbcf40581a`. Main CI `42652533194` and Worker deploy `42652533030` passed, including D1 migrations, Deploy, and Verify.

### 2026-11-10 — Atomic Workflow local row effects

- Route `add_row` and `update_row` through the existing D1 transaction helper so the permission/schema/CAS-guarded row change and checkpoint result are committed together. Add row capacity to the insert statement itself to preserve the maximum under concurrent writes; a guarded statement that changes no rows rolls the transaction back.
- Regression coverage verifies a replayed checkpoint does not repeat add/update writes and that a zero-row guarded write does not complete the checkpoint. Row-trigger dispatch remains post-commit without a durable outbox; no exactly-once trigger delivery claim is made.
- Worker workflow/checkpoint/budget suites passed together: 151/151 across three test files. PR #859 exact-head CI runs `42654659653` and `42654614749` both passed; PR #859 merged as `705372da66b44ca38643c78bb9df82f7e66736a9`. Main CI `42658394690` and Worker deploy `42658394610` passed, including D1 migrations, Deploy, and Verify.

### 2026-11-10 — Unknown model price guard for workspace pause budgets

- Workspace budget reporting now counts deployment-key model names that do not match a known `PRICES` family as `unpricedCalls` / `indeterminate`. With `budget_action='pause'`, a configured daily, weekly, or monthly window containing such a call fails closed; `warn` mode remains admissive. Explicit `web_search` and `jev-latest` list-price entries remain known.
- Did not infer missing usage from zero token/price rows: the legacy ledger writes missing token counts as zero, and zero alone cannot distinguish missing data from a valid zero-priced operation.
- Focused workspace budget tests: 7/7 passed. Combined Workflow atomicity and budget tests passed 151/151 before the later outbox addition.

### 2026-11-10 — Durable outbox for Workflow local row changes

- Workflow `add_row` / `update_row` now add a JSON row-event outbox record (200KB per event, 100 pending per workspace) in the same D1 batch as the guarded row mutation and checkpoint completion. An immediate best-effort drain preserves normal latency; the existing minute cron retries pending events with CAS leases and capped exponential backoff. Trigger-query failures are retried, and per-workflow row receipts extend as durable retries arrive to protect already-started fan-out runs beyond the normal seven-day dedupe window.
- Each outbox record stores the established stable row-event fingerprint. Expired receipts are retained only while a pending event with the same fingerprint exists, so unrelated receipts continue to clean up even if another event is stuck.
- Scope is intentionally limited to Workflow-local add/update. Manual/API/connection row writers and row deletions still dispatch after their write without a durable outbox. Pending events retain their row snapshot until delivery; completed events are removed after seven days.
- Final combined batch including Workflow, checkpoint, workspace budget, row-event outbox, and migration suites: **190/190 passed** across 6 files. Syntax checks, parity inventory consistency, and `git diff --check` passed. Exact-head CI and deployment for this outbox change remain pending.

### 2026-11-10 — PR #862 App API contract, release history, and memory attribution (production release)

- PR [#862](https://github.com/Torutesu/HonmaruAI/pull/862) is merged at current main `b5fea8e2`. The exact-head CI run [#42681479871](https://github.com/Torutesu/HonmaruAI/actions/runs/42681479871) passed; merged-main CI [#42684677206](https://github.com/Torutesu/HonmaruAI/actions/runs/42684677206), Worker deployment [#42684677210](https://github.com/Torutesu/HonmaruAI/actions/runs/42684677210), and Web deployment [#42684677047](https://github.com/Torutesu/HonmaruAI/actions/runs/42684677047) succeeded. Worker release included D1 migration, deploy, and verify; Web Pages deployment and domain verification succeeded.
- Local focused QA for the merged change passed: Worker harness-apps + harness-memory-scope, 179/179; Web CustomApp + AgentMemoryList, 30/30. Web production build, syntax checks, the 104-row parity inventory consistency check, and `git diff --check` passed.
- Shipped scope: table API OpenAPI contract covers query/sort/filter and pagination plus strict CRUD schemas; Custom App history identifies published versions/current version, timestamp, publisher, and source commit, and restores a prior release into a draft; personal memory listing shows creator/editor names while retaining personal scope. No paid service or migration beyond the release's recorded D1 migration was added; Simple mode remains available.
- Residuals at the time of PR #862: KY-030 still lacks a shared-knowledge promotion/publication and approval/ownership-transfer workflow. KY-044 still lacked arbitrary API registration, pinned public contract versions, and generated/distributed SDKs. KY-051 still lacked runtime logs and detailed deployment status, direct one-click rollback, and environment-specific release history. Production deploy success does not establish Kylon feature parity or full end-user acceptance.

### 2026-11-10 — PR #861 CI status (unresolved)

- PR [#861](https://github.com/Torutesu/HonmaruAI/pull/861) remains unmerged. Its Actions run [#42673825042](https://github.com/Torutesu/HonmaruAI/actions/runs/42673825042) concluded failure even though its individual jobs reported success; the earlier push run [#42673799390](https://github.com/Torutesu/HonmaruAI/actions/runs/42673799390) reported a Worker aggregate failure with `SHARD_RESULT: abandoned`. Do not treat either run as successful exact-head CI. Merge review remains unresolved; no bypass or status change is recorded here.

### 2026-11-10 — PR #863 App SDK and published-release restore (production release)

- PR [#863](https://github.com/Torutesu/HonmaruAI/pull/863) merged as `20c603199918c5ece30ddfc1606985fa37384c42`. Exact-head CI [#42690260184](https://github.com/Torutesu/HonmaruAI/actions/runs/42690260184) passed; main CI [#42693865694](https://github.com/Torutesu/HonmaruAI/actions/runs/42693865694), Worker deploy [#42693865965](https://github.com/Torutesu/HonmaruAI/actions/runs/42693865965), and Web deploy [#42693865973](https://github.com/Torutesu/HonmaruAI/actions/runs/42693865973) all succeeded.
- Added `honmaru workspace sdk generate <table-id> --out <file.ts>` to generate a dependency-free typed TypeScript client from an accessible table schema. CLI tests: 26/26 passed. Generated/distributed SDK packaging, arbitrary API registration, and version-pinned public contracts remain incomplete.
- Added Custom App release-history action to restore an older published snapshot as a new draft. It leaves the current live source intact; prior approvals are revoked and current publish approval is required. Worker `harness-apps.test.js`: 156/156 passed. Web `CustomApp.test.tsx`: 17/17 passed; Web production build and TypeScript check passed.
- Production smoke check: `https://app.honmaruai.com` returned HTTP 200 and `https://tiktokforwork.torubj0904.workers.dev/health` returned `ok: true`. Parity inventory consistency (104 rows), syntax checks, and `git diff --check` passed. No new paid service or migration file was added; Simple mode remains available. Release success is not evidence of full Kylon parity or end-user acceptance.

### 2026-11-10 — Batched KY-030 memory promotion (PR merged)

- Added an append-only request/decision record for a person-scoped memory to be copied into Agent-shared knowledge. Only the current Agent owner or an active explicit Agent admin can decide; source owner membership, Agent access, memory scope, and source version are rechecked. Approval creates a distinct shared copy, leaves the private source intact, and refuses to create a copy if the source or access changed. Duplicate requests for the same source version are idempotent.
- Added the Agent memory UI for requesting, reviewing, approving, and rejecting a shared copy. Reviewers see the source content only while the requester's membership/access and exact memory version remain current; a changed access state clears the displayed content. No new paid service; Simple mode remains available.
- Worker focused `harness-agents.test.js` and `migration.test.js`: 70/70 passed. Web memory UI/API suites: 19/19 passed, including regression coverage for an unavailable/malformed request queue. Web production build, syntax checks, parity inventory consistency, and `git diff --check` passed. PR [#864](https://github.com/Torutesu/HonmaruAI/pull/864) merged as `14018bcbc58032a9ae2c2a91075cc39dc7fd77c8`; exact-head CI [#42702894844](https://github.com/Torutesu/HonmaruAI/actions/runs/42702894844) passed all required jobs. After merge, Worker `/health` returned `ok:true` and the web app returned HTTP 200. The merged commit's production deployment run and served asset SHA were not independently confirmed; authenticated promotion/approval UI acceptance remains outstanding. This is a partial Kylon match, not a 100% claim.

### 2026-11-10 — StoreKit subscription lifecycle visibility (production deployed; authenticated QA pending)

- Kylon's [public pricing page](https://kylon.io/pricing) currently calls BYO-agent pricing a concept preview and says credit amounts/eligibility are not final. Its FAQ describes monthly subscription credits and add-on packs, but public product terms are still not settled. Honmaru does not add a new payment service, products, or charge path.
- The existing authenticated billing status now reads the active RevenueCat entitlement and returns only bounded lifecycle fields: period type, expiration/purchase dates, cancellation detection, billing issue, grace-period end, and sandbox flag. It omits product identifiers, transaction IDs, and the raw subscriber payload. Plan access continues to depend on the active App Store entitlement; provider outage retains last-known Pro access and suppresses stale period details.
- Plan UI displays trial period, cancellation while access remains, billing issues, grace period, and sandbox state. Worker `entitlements.test.js` + `billing-status.test.js`: 13/13 passed. Web `Plans.test.tsx` + `billing.test.ts`: 16/16 passed. TypeScript + production build passed. No D1 migration or Simple-mode change.
- Exact-head CI passed and PR #865 merged as `4848312ad19bfc36b634cb1438bb320c026ec43b`. Main CI #42712593730, Worker deploy #42712593632 and Web deploy #42712593582 succeeded; Worker `/health` returned `ok:true` and `https://app.honmaruai.com` returned HTTP 200. Authenticated App Store account UI QA remains pending.
- Remaining: monthly Kylon credit ledger/renewals, rollover and purchasable packs, plan-change credit timing/deduplication are not implemented. Kylon concept pricing is not a stable contract, and this batch does not claim KY-087 parity.

### 2026-11-10 — OpenRouter long-task checkpointing (local QA; release pending)

- Extended the existing OpenRouter Harness chat-tool loop to match the bounded long-task continuation already available in the OpenAI Responses research path. Once reported prompt usage reaches 48,000 tokens, the loop retains a bounded copy of the original task, completed tool names/arguments/results and the latest assistant progress, then starts a fresh chat-completions chain. Exact completed calls are served from the checkpoint instead of being repeated under new call IDs. At the two-checkpoint cap, no further tool side effects run and the model is asked for a final answer from retained evidence.
- Retained the existing authorization check before every model round and tool, cancellation signal, usage accounting, tool tracing, 16 actual tool-call budget and 240-second caller deadline. The model chain may continue to 16 rounds; no new model request, provider, package, migration, or charge path is added. `Simple` continues through the pre-existing non-Harness request path.
- Combined Worker regression batch (`agent-chat-tools.test.js`, `agent-research.test.js`, `agent-handoff-chattools.test.js`, `agents.test.js`, `harness-agents.test.js`): 149/149 passed. New coverage includes continuing beyond eight rounds, checkpoint contents, tool-result-driven compaction, duplicate side-effect suppression, the two-checkpoint cap, final-only response and existing cancellation/authorization behavior. Exact-head/full CI, authenticated production long-task UX and real BYO-provider acceptance remain pending; KY-114 stays partial.
- PR #865 merge evidence was reconciled in the matrix: merge SHA `4848312ad19bfc36b634cb1438bb320c026ec43b`; main CI #42712593730, Worker deploy #42712593632 and Web deploy #42712593582 all succeeded. Production Worker `/health` returned `ok:true`; `https://app.honmaruai.com` returned HTTP 200. Those release checks apply to PR #865, not this OpenRouter extension.

### 2026-11-10 — OpenRouter long-task release evidence and bounded Agent helpers (combined batch)

- KY-114 OpenRouter/BYO continuation is now production-released: PR #866 merged as `eb192283b8df2c371106d5e887d169833c008506`; exact-head CI #42717933744, main CI #42720363920 and Worker deploy #42720363385 succeeded. Production Worker `/health` returned `ok:true`; `https://app.honmaruai.com` returned HTTP 200. Authenticated provider UX remains unverified.
- Added private parallel helpers to Harness Agent turns: at most two copies, each limited to 30 seconds, four model rounds, three read-only tool calls, and bounded input/output. OpenAI Responses and OpenRouter helper runs now both enforce the wall-clock deadline on model and tool waits; timed-out reads receive an aborted signal and their late result is ignored. They inherit only the parent’s already scoped read tools; no browser, code execution, messaging, writes, approval, permission changes or recursive delegation. Parent authorization is rechecked and late results discarded after revocation. Simple mode is unchanged; no new provider, paid service, or migration.
- Final combined Worker regression batch: 6 suites, 154/154 passed, including an OpenAI helper read that hangs past the deadline. Syntax checks, parity inventory consistency, and `git diff --check` passed locally.
- Added KY-115 to both parity inventories as partial. Remaining Kylon differences include authenticated production QA, route/Agent selection, durable helper run cards/history, independent helper identity/credentials, and longer cloud execution.

### 2026-11-10 — Batched App ACL and Workflow cancellation fixes (local verification)

- Table writes now require edit permission on every linked App, including HTTP row routes, MCP `add_row`, and Workflow `add_row`/`update_row`; Workspace-default view is no longer an implicit write grant. Workspace owner/admin roles inherit edit consistently. Regression coverage includes viewer denial through HTTP/MCP/Workflow, explicit edit grant and revocation, and owner/admin inherited access. The Workflow test fixture now gives its maker a workspace-visible App policy instead of relying on an implicit private-App write.
- Cancelling a running Workflow atomically cancels related queued/running TypeScript gateway jobs and clears their lease, so the node stops polling the cancelled job. An external side effect already completed before cancellation cannot be rolled back.
- Combined local Worker regression batch passed 333/333 across `harness-apps.test.js`, `harness-workflows.test.js`, `workflow-code-jobs.test.js`, and `review-row-write-schema.test.js`. The latter fixture now grants edit permission explicitly; row-write callers do not inherit implicit table edit from App visibility. Parity consistency, JSON parsing, exact-head CI, and production deployment are pending. No migration or paid service added; Simple remains unchanged.
# 2026-11-10 — Workflow TypeScript SDK batch helpers and release ledger

- Reconciled the parity ledger against current `main` (`a3b91f9681bc9c1a31fc2b72bd1c7b8d95a0e419`): the whole-workflow TypeScript editor, immutable source/revision pinning, and state bridge were already merged and deployed. The previous ledger incorrectly described them as unreleased. Main CI `42821620907`, Worker deploy `42821621049`, Web deploy `42821620893`, Worker health, and the served workflow editor bundle were verified.
- Added isolated TypeScript SDK `parallel` and `pipeline` helpers with a 10,000-item cap, concurrency cap 32, 32-stage cap, stable ordering, item-level `null` failures, and `onError` callbacks. Added install snapshot inclusion, Japanese editor guidance, unit coverage, and the VM smoke fixture.
- QA: Gateway suite **53/53 passed** (requires permission for its existing localhost ACP test); `HarnessWorkflows.test.tsx` **61/61 passed**; React TypeScript check and production Vite build passed; `git diff --check` passed.
- Runtime VM smoke remains unverified on this Mac because no `container`, Docker, Podman, or Lima executable is installed. The signed-in Kylon room has no workflow to compare, so authenticated live run and side-by-side workflow UI acceptance remain outstanding. No paid services were added.

### 2026-11-10 — Kylon 15-minute workflow execution cap

- Rechecked Kylon's current [workflow SDK specification](https://docs.kylon.io/cli/workspace/workflow): it allows a saved TypeScript workflow up to 15 minutes by default within the run limit. Honmaru's prior 60-second workflow cap was a material runtime gap.
- Workflow programs now receive a 900,000 ms isolated execution cap and a separate 30-second result-delivery grace period. Ordinary custom-app code keeps its 60-second cap and ACP retains its prior 110-second execution / 120-second lease.
- Gateway heartbeats extend the workflow job lease and activation checkpoint together, only while the frozen run definition, source membership, requester, Gateway, run, activation and lease remain authorized. The absolute deadline stops the job after the cap; cancellation, revocation and uncertain outcomes remain fenced.
- Verification: Gateway suite **54/54**, Workflow UI **61/61**, Worker `workflow-code-jobs` + `harness-gateways` **58/58**, React TypeScript/Vite production build passed, and `git diff --check` passed. The worker regression asserts the exact 15-minute timeout, 15m30s outer deadline, and simultaneous job/checkpoint renewal.
- No schema migration or paid service. Installed Mac Gateway snapshots require refresh; this machine has no container runtime binary, so the 15-minute guest VM execution and refreshed physical node are not yet verified. Kylon's `agent()`, App/proxy APIs, page coverage policies and authenticated production run acceptance remain open.

### 2026-11-11 — Workflow report drafts (`sendMessage`)

- Kylon's [Workflow SDK specification](https://docs.kylon.io/cli/workspace/workflow) defines `sendMessage(text, { mention? })` as a run-scoped draft for the final report, not a direct Room post. Added a bounded implementation that carries draft text and mention metadata through the existing execution lease, persists accepted reports in the run log, and displays them separately from stdout in run history. Normal gateway jobs cannot submit these drafts; Worker checks the frozen workflow-program grant again and rejects invalid/oversized results. No Room message or external side effect is created.
- Added an actual guest-bootstrap protocol test. It exposed that multi-line SDK source was interpolated into a JavaScript single-quoted string without escaping; the guest module could fail to load. SDK source is now JSON-string encoded before importing, and the test verifies the staged RPC roundtrip plus unchanged ordinary stdout.
- QA: Gateway **56/56**, Worker workflow-program/Gateway/message-draft suites **66/66**, Web run-history/workflow-editor suites **84/84**; Web TypeScript check and Vite production build passed. `node --check` and `git diff --check` passed.
- Not deployed yet. This Mac has no `container`, Docker, Podman, or Lima executable, and native UI inspection reports the Mac locked. The installed Gateway snapshot needs a refresh; production VM execution, production Worker/Web release, and authenticated Kylon comparison remain separate acceptance gates. No new paid service was used.
### 2026-11-11 — Workspace CLI conversation aliases (PR #882 merged)

- Kylon's current [Room commands](https://docs.kylon.io/cli/workspace/room), [Message commands](https://docs.kylon.io/cli/workspace/message), and [Thread commands](https://docs.kylon.io/cli/workspace/thread) define everyday room discovery/creation, conversation reads, message search/get/send, thread reads/replies, and many lifecycle operations. Honmaru already exposes scoped MCP tools for a subset; the CLI previously had no resource aliases for that conversation surface.
- Added CLI aliases backed by the existing MCP tools: Room `list/create/read`, Message `search/get/send`, Thread `get/msg`, and Reaction `get/add/remove`. Pagination cursors and 50-item limits pass through. Creation and sends require 8–100 character request IDs; retry identity remains the Worker authority. File ID lists are deduplicated and capped at ten. No broader Room membership grants or Agent activations are implied by these commands; private/DM/attachment scope enforcement remains at the existing Worker boundary.
- Verification on branch `codex/kylon-parity-next-20261111`, based on main `ed8458c4`: CLI **31/31** tests passed; Worker `mcp-chat.test.js` **31/31** passed; parity inventory and `git diff --check` passed. PR #882 merged as `ef1c7730474738fe5a6203fdde420032b12cdd08`; Deploy Web #42880430165 Verify succeeded. Main CI #42880430167 was still running Worker shards and E2E at last check. No new backend endpoint, schema, paid service or Simple-mode change.
- This is not full Kylon CLI parity. Room discover/join/leave/archive/update/member CRUD, Thread create/activate/participants/pin/rename/attach, Message edit/delete/forward, and Connection/Agent/Skill commands remain gaps. The side-by-side Kylon UI acceptance gate is still open.

### 2026-11-11 — Reversible File MCP/CLI lifecycle batch (local verification)

- Added `delete_file` and `restore_file_version` to the existing Harness-scoped MCP surface and CLI aliases `workspace file delete` / `workspace file revert`. Delete appends a version tombstone, requires the exact current content version and the existing file delete authority, and revokes active public URLs through the ledger. Restore copies an unpurged historical object into a fresh immutable version under current file scope authority and expected-version CAS. Permanent purge remains human-only.
- Added regression coverage for write-scope gating, stale and duplicate delete, deleted-file listing, historical read, stale restore, restoring from a prior version, and Simple-mode exclusion; updated CLI and parity docs.
- Verification: CLI **31/31**, Worker `harness-mcp.test.js` **17/17**, JavaScript syntax checks, parity inventory, and `git diff --check` passed. No schema migration, paid service, new storage provider, or Simple-mode change.
- This batch is not merged or deployed yet. Other File CLI gaps still include binary upload/download and sharing management. Kylon live comparison, multiple-user production acceptance, and all-workspace CLI acceptance remain open.

### 2026-11-11 — Workspace File binary CLI transfer batch (local verification)

- Added `honmaru workspace file upload --scope --path --source --request-id [--content-type]` and `download <file-id> [--version] [--output|--dir] [--force]`. Upload streams raw bytes through a 15-minute MCP reservation, capped at 25 MiB, bound to actor, connection, scope/path, MIME, exact length and SHA-256. A stable file UUID is required for retries; completed results remain verifiable against the immutable first version after the short reservation expires. Download obtains the accessible source path/version through MCP, then streams bytes through an authenticated endpoint that rechecks Harness mode, current file scope, purge and version integrity. Local output refuses overwrite unless `--force` is explicit.
- Transfer reservations use a dedicated expiring table. The endpoint requires current MCP `read`/`write` scope; creation additionally checks `harness.build`, while the existing upload primitive's D1 fence rechecks current membership and resource audience at commit. Raw payloads are not base64-embedded in MCP JSON. No external storage, paid service, or Simple-mode functionality was added.
- Verification: CLI workspace **32/32 passed**. Worker `harness-mcp.test.js`, `file-upload.test.js`, and `migration.test.js` **111/111 passed**, including read-only scope, cross-member denial, and Simple-mode exclusion. JavaScript syntax checks, parity inventory, and `git diff --check` passed. PR #888 exact-head CI #42933048190 and post-merge main CI #42935745130 passed; PR #888 merged as `7812d8afce3f9c3e626777c3f4327f0ab8dd8d2d`. D1 migration, Worker deploy/Verify #42935744470, Web deploy/Verify #42935744516 succeeded. Production Worker health reports `ok:true` with encryption ready; app.honmaruai.com returned HTTP 200. Production CLI binary roundtrip and authenticated Kylon comparison remain open; KY-085 remains partial.

### 2026-11-11 — Workspace File CLI copy (local verification)

- Added `honmaru workspace file copy <file-id> --scope ROOM --path PATH --request-id file-UUID [--version N]`. It reads exact immutable source-version metadata, downloads the bytes under the current source ACL, then reserves a new immutable file under the explicit destination scope with MIME, length, SHA-256 and idempotent request identity. Source and destination permissions remain independent; the source is unchanged, purged/deleted versions are refused, and transfers above 25 MiB are refused.
- Added CLI coverage for byte-preserving binary copy, explicit historical version, hash-bound destination reservation, invalid request ID, size limit, and source scope. Updated the KY-085 residual and CLI usage documentation. Simple mode and billing are unchanged.
- Local verification on `codex/kylon-file-copy-and-version-cli-20261112`: CLI workspace **34/34 passed**; `node --check`, parity inventory, and `git diff --check` passed. PR #889 exact-head CI #42939364764, main CI #42941931085, and Web deploy/Verify #42941931058 passed. PR #889 merged as `a0c01ea4bc9a273937fe32cebddac382f5e6ff50`. Production binary transfer roundtrip and Kylon live acceptance remain unverified.

### 2026-11-12 — Workspace CLI public Room lifecycle batch

- Added `room discover --query/--limit/--offset/--joined`, `room join <room-id>`, and `room leave <room-id>` as aliases to new scoped MCP tools. Discovery includes only active managed public Rooms for the token owner's current workspace membership. Join/leave act as that human user; they do not enroll an Agent or create Agent access. Leaving keeps the existing last-human-admin guard. Existing Simple Rooms remain unmanaged and are not changed by these commands.
- Added CLI argument/output coverage and Worker integration coverage for public-only discovery, joined filtering, joining/leaving, and no Agent membership side effect. CLI **35/35** and Worker `mcp-chat.test.js` **32/32** passed; syntax, parity inventory and `git diff --check` passed. PR #890 exact-head CI #42942608463 and main CI #42944957340 passed; PR #890 merged as `e4e3cf527419e2b53165d7518cb1eaa6394ce460`; Worker deploy/Verify #42944957362 and Web deploy/Verify #42944957424 passed. Authenticated Kylon live comparison remains open.

### 2026-11-12 — Workspace CLI managed Room lifecycle batch

- Added `room rename`, `room archive`, `room unarchive`, and `room list --archived` through scoped MCP tools. Rename, archive and restore use the existing managed Room version-CAS helper, then record the specific action and push viewer-filtered Room lists to connected members. Private archived Room names are visible only to current participants; outsiders receive the same not-found result. Simple/unmanaged Rooms stay on their existing UI/API path.
- Added CLI output/argument tests and Worker coverage for membership gating, archive/restore version changes, discovery after restore, and private Room name redaction. CLI workspace **36/36** and Worker `mcp-chat.test.js` **33/33** pass; syntax, parity inventory, and `git diff --check` pass. PR #891 exact-head CI #42948910831 passed and merged as `614fef19bd24c0695b415807e2b2acdf03db3dd7`; main CI #42951355565, Worker deploy/Verify #42951355537, and Web deploy/domain Verify #42951355533 all succeeded. Authenticated Kylon comparison remains pending.

### 2026-11-12 — Workspace CLI thread settings batch (local verification)

- Added CLI/MCP `thread rename`, `thread mute|unmute`, and `thread pin|unpin`. Rename uses the UI's existing title version compare-and-set (supply version `0` if there is no custom title); mute and pin remain personal preferences. Every operation first resolves the requested conversation and verifies that the root message is a live, accessible thread in that conversation. Existing MCP `chat:write` scope is required; guest users cannot rename. Pins use the existing 50-thread cap. No schema migration or new paid service.
- CLI workspace **36/36** passed. Worker `mcp-chat.test.js` **34/34** passed, including stale title version, personal mute/pin and cross-conversation rejection. `node --check` and `git diff --check` passed. PR #892 exact-head CI #42953738142 passed and merged as `9b88ade5123563f85507d206a56d850d22e0f330`; main CI #42955589013, Worker deploy/Verify #42955589004 and Web deploy/domain Verify #42955588949 passed. Authenticated Kylon comparison remains pending.

### 2026-11-12 — Workspace CLI managed Room settings batch (local verification)

- Added `room get <room-id>` and partial `room update` options for name, mentioned-only response policy, main Agent, and icon color. Updates preserve omitted fields and use existing membership/build permission checks, managed-Room version compare-and-set, audit log, and viewer-filtered Room-list notifications. Main Agent must already be available in that Room; `auto` clears the default. Kylon's `cyan` icon option maps to Honmaru's existing `lake` color. Simple/unmanaged Rooms and room scope/guideline/avatar stay on separate paths.
- CLI workspace **38/38** passed. Worker Room MCP/settings suites **56/56** passed, including existing-agent selection, missing-agent rejection, response settings, and Room settings version checks. Syntax checks, parity inventory, and `git diff --check` passed. Exact-head CI, merge, production deployment, and authenticated Kylon comparison are pending.

### 2026-11-11 — Batched personal Room settings (local QA)

- Added MCP/CLI Room mute and unmute, backed by the existing per-user notification preference. Unmute removes the explicit preference and restores the workspace default. Added Room sidebar reorder, restricted to accessible joined Rooms; requested Rooms move to the front and unspecified order, stars, and sections are preserved. Sidebar writes use the existing opaque-version compare-and-set with bounded retries, so another device's concurrent edit is not silently overwritten. CLI aliases: `room mute|unmute <room-id>` and `room reorder --rooms ROOM,ROOM,...`.
- Combined QA after implementing both changes: CLI **39/39**; Worker MCP/chat and sidebar suites **44/44**; syntax checks and `git diff --check` passed. Regression coverage verifies mute persistence/removal, preservation of sidebar stars and remaining order, duplicate rejection, and non-Room rejection.
- PR #894 merged as `a0175293864c69f0e5e44fc0c1e813a0c6aac23d`. Exact-head CI #42966705354 passed; main CI #42968683070, Worker deployment #42968683066 and Web deployment #42968683111 succeeded. Production Worker health and `app.honmaruai.com` HTTP 200 verified. Authenticated cross-device UI confirmation and direct Kylon interaction comparison remain open. No schema migration, paid service, or Simple-mode change.

### 2026-11-11 — Batched Room member operations (local QA)

- Added MCP/CLI member list, add and remove for active managed Rooms. Human member identifiers are workspace-scoped opaque references; list results omit raw account IDs and only expose Agents already bound to the accessible Room. Add defaults to `member`; assigning `admin` requires a current Room admin, and workspace guests cannot become Room admins. Remove requires a Room admin and preserves the final eligible human admin. Both mutations use the existing membership snapshot/version compare-and-set and send Room change events. Simple/unmanaged Rooms and Agent membership mutations remain on their existing paths.
- CLI **41/41** passed. Focused Worker MCP/Room-role/member-group suites are being verified together; the first sandbox run could not bind localhost, so the same run was repeated with the required local test permission. Exact-head CI, merge, deployment and authenticated Kylon comparison are pending. No schema migration or new paid service.


### 2026-11-11 — Reconcile merged Room member and Workflow CLI capabilities

- PR #895 added MCP/CLI Room member list/add/remove using workspace-scoped opaque member refs, Room-admin checks, guest-admin rejection, last-human-admin protection and membership snapshot/version CAS. Exact-head CI #42973967263 passed; merged as `221f3a8c26d23bb980e12089c7bdf3877e14eae5`.
- PR #896 added Workflow detail/run history/cancel, held webhook event inspection/discard/replay, and webhook credential rotation/revocation. Exact-head CI #42985423815 passed; merged as `dfecc38fa93a63ef3846bea3abb5c4b527d14266`.
- PR #898 added Workflow revision list/restore, generation-guarded safety resume and no-replay stalled-run reconciliation. CLI 45/45 and Worker 178/178 passed; exact-head CI #42994820675 passed; merged as `adedaadca547bb0e868e50da8e105ebc2991d415`.
- Current-main CI #42997611750 and Worker/Web deploys #42997611732/#42997611923 succeeded. Authenticated Kylon parity and real multi-user/terminal acceptance remain open; no schema migration or paid service.

### 2026-11-11 — MCP Workflow governance and CLI secret handling (local QA)

- Added specific audit events for Workflow revision restore, safety resume, run cancel/reconciliation, held-event discard/replay, and webhook secret rotation/revocation. Audit entries record actor, Workflow/Run, outcome and bounded counts; they never include webhook secrets or event payloads. Added MCP destructive-operation hints for restore, recovery, held-event changes, webhook credential changes, and Room member removal.
- CLI webhook rotation/revocation now accepts the current secret by environment-variable name (`--expected-secret-env NAME`) or `--expected-secret none` for an inactive hook, avoiding literal secrets in shell history and process arguments.
- Combined local QA: CLI **46/46**; Worker Harness MCP, chat MCP, Room roles and gateway suites **129/129**; JavaScript syntax, requirements JSON, Kylon inventory (**105 items**) and `git diff --check` passed. PR exact-head CI and release are tracked separately; this local QA record does not claim deployment. No schema migration, paid service or Simple-mode change.

### 2026-11-11 — Open failed Automation run in its source chat

- Failed run entries now offer **Ask in chat** when an authorized source thread exists. The link opens the thread tied to that workflow; it does not start or retry a run. Workflow details fetch only source metadata for this action, without loading candidate-thread lists. Japanese UI copy explains the no-rerun recovery path.
- HarnessWorkflows UI suite **64/64**, complete Web suite **1,921/1,921** across 260 files, and `npm run build` passed. `git diff --check` passed. Exact-head CI, merge, and production deploy are pending; no Worker/schema changes, paid service, or Simple-mode changes.

### 2026-11-12 — Search and share with named external collaborators (batched local QA)

- Added authenticated, resource-scoped collaborator search for Thread/File/App sharing. A search requires 3–100 characters, returns at most 8 verified accounts, matches name/login/verified email, omits email from results, and is limited to 30 searches per session in 5 minutes. Search requires current Harness mode, workspace membership, and authority over the specific resource. Grant writes recheck verified identity, non-membership and current sharing authority; direct email invitation flows remain available.
- Added the shared debounced account picker to Thread, File and App sharing. Existing per-resource view/edit, expiry and revoke controls remain the source of access rules. Added server and UI regressions for resource scoping, minimal results, selection, and ID-based grants.
- Focused Worker tests **50/50** across 3 files passed; focused Web tests **50/50** across 7 files passed; Web production build, JavaScript syntax checks, `git diff --check`, and requirements JSON parsing passed. The first Worker run was blocked by the sandbox's localhost bind restriction; rerun with local test permissions passed. Exact-head CI, merge, deployment and authenticated multi-user validation are pending. No schema migration, paid service or Simple-mode changes.

### 2026-11-12 — ACP teammates release reconciliation and Grok Bot gap

- Reconciled PR #920 on the current main baseline `c6853b4a`: named local ACP teammates now include Hermes, Grok Build and Antigravity CLI, with the generic ACP option preserved. Focused Worker teammate coverage passed (24 tests); the Web suite passed (263 files / 1,957 tests) and the production build passed. PR exact-head CI passed before merge; main CI #43164283706, Worker deploy/Verify #43164283779, and Web deploy/Verify #43164283643 succeeded. This validates the named ACP aliases, not Grok Bot.
- Kylon's Nov. 3 changelog separately says Grok Bot connects from the Grok Bot desktop app. xAI's [official routine documentation](https://docs.x.ai/grok-bot/skills-routines-and-automations) states that a webhook HTTP 200 means the run was accepted and started, not completed. Added KY-119 as a separate missing requirement; the existing `grok-build` ACP preset does not satisfy it. No Grok Bot endpoint was configured or called.

### 2026-11-12 — Grok Bot routine bridge (local implementation and batch QA)

- Added `grok-bot` as a separate teammate provider backed by an owner-configured existing routine HTTPS webhook. The key and URL are encrypted at rest; only workspace admins can read the URL; callback tokens are random, hashed, one-time, and expire. HTTP 200 only marks request acceptance. Completion arrives through the authenticated callback and is posted to the originating thread. Stop revokes local callback acceptance and discloses that remote routine work may continue. No blind retries are made for ambiguous webhook outcomes.
- Added callback persistence/migration, rate limiting, API origin config, Japanese setup UI and explicit use of the Bot owner’s existing quota. Simple and the three local ACP providers remain separate. No new vendor or paid contract was added.
- A focused Worker regression exposed that deferred invocations may not have the credential decryption key. The watcher now reads an already authenticated Grok Bot callback result without requiring the routine secret; the focused end-to-end Worker test passed. Full Worker suite and Web build are still running. Test fixtures use a mock HTTPS routine only; no external endpoint/account was configured, so the desktop-app workflow, real execution, progress, production migration/deploy and authenticated Kylon parity remain unverified. KY-119 is partial, not complete.

### 2026-11-12 — Grok Bot completion protocol correction (local QA)

- xAI's [Skills and routines](https://docs.x.ai/grok-bot/skills-routines-and-automations) documents webhook delivery as an incoming trigger and describes HTTP 200 as acceptance/start. It does not establish that a routine can POST an outbound callback. xAI's [Use computer and apps](https://docs.x.ai/grok-bot/computer-and-apps) documents a Remote HTTPS custom MCP connector. Replaced the unsupported routine instruction to POST callback.url with a stateless Streamable HTTP MCP endpoint exposing one completion tool, reusing the existing one-time hashed-token compare-and-set path. The admin UI now shows/copies the MCP URL and gives the connector setup steps; routine payloads tell the Bot to call the tool exactly once.
- Worker regressions verify MCP initialize/discovery, invalid token rejection, successful completion, replay rejection and answer delivery to the originating thread. Focused Worker teammate + workspace query suites passed **27/27**; Web suite passed **1,957/1,957** and `npm run build` passed. Parity inventory consistency (109 requirements), `git diff --check`, and JavaScript/TypeScript production build checks passed.
- This protocol change is local to `codex/grok-bot-mcp-callback`; it is not merged or deployed. The logged-in Kylon/Grok Bot UI could not be operated in this chat, so custom connector configuration and real routine-to-MCP behavior remain unverified. KY-119 remains partial; Simple mode and paid-service configuration are unchanged.

### 2026-11-12 — Grok Bot completion MCP bridge production reconciliation

- PR #922 merged as `f8ebc6b3` after PR #921. Main CI, Worker migration/deploy/Verify, and Web deploy/domain verification succeeded. Production Worker `/health` returned `ok:true`; `https://app.honmaruai.com/` returned HTTP 200.
- The deployed app bundle contains the custom Remote HTTPS connector instructions and MCP completion tool. The production endpoint `/teammates/grok-bot/mcp` answered read-only `tools/list` with `honmaru_complete_grok_bot_task`; no completion mutation or external Grok Bot call was made.
- This supersedes the preceding local-only status. KY-119 remains partial because a real Grok Bot desktop account, connector registration, routine execution, and Kylon side-by-side acceptance were not available for verification. No new paid service was added; Simple mode remains available.

### 2026-11-12 — Per-tool Remote MCP grants and direct Workflow connections (local QA)

- Added Agent-specific grants for individual workspace-approved read-only Remote MCP tools, retaining legacy server grants until they are individually edited. Workflow definitions can pin an Agent, server, tool and bounded JSON arguments; execution checks the current allowlist, schema and exact actor grant before dispatch and again after the response. Credential-shaped argument keys are rejected and arguments are omitted from logs.
- Added per-tool controls in the Agent Connections UI and a Remote MCP source/tool/arguments editor for Workflow Connection steps. Simple mode still rejects Workflow Connection steps and keeps the prior chat/feed path.
- Worker Remote MCP and Workflow suites passed **158/158**; the complete Web suite passed **1,959/1,959**; Web TypeScript/production build and `git diff --check` passed. Exact-head CI, merge, deployment and authenticated Kylon side-by-side validation are pending. KY-079 remains partial for broader provider operations and unified App/Workflow grants. No new paid service was added.

### 2026-11-13 — Workspace AI budget direct routes release and Jev follow-up

- PR #934 merged as `cecf7c848705224c9cf4afe23295bacb03e29b13`. PR CI #43288203131 succeeded. Main CI #43291237987 succeeded, including E2E; the push-triggered main run skipped the iOS and Windows jobs that had run in PR CI. Worker deployment #43291237728 completed D1 migration, column additions, deployment and Verify successfully. This confirms the direct provider reservation batch reached production; it does not establish full Kylon parity.
- The current local follow-up reserves deployment-key Jev/System One calls before dispatch, records successful usage for route, inbox triage and business classification, and settles reservations with the ledger. Workspace TypeSafe keys remain BYOK. A successful Jev decision followed by a BYOK OpenAI request keeps the Jev ledger row charged to the deployment budget. Malformed triage output, invalid business choices and failed second opinions retain completed Jev usage; ambiguous transport outcomes keep reservations until unknown.
- Focused Worker regression batch passed **50/50** across `workspace-ai-budget.test.js`, `jev.test.js`, `sync.test.js`, and `org-ai.test.js`. Static syntax checks, requirements JSON parsing and `git diff --check` passed. The Jev changes still need exact-head CI and production deployment; independent teammate providers, provider-internal/external tool charges, Kylon credits/invoices, and authenticated Kylon side-by-side acceptance remain open.

### 2026-11-13 — DB preview conflict resolution release and additive rollback batch

- PR #937 merged as `9928722fbd358fde050b93e9912286140116917c`. Exact-head CI #43320685412 passed all required jobs, including Windows Edge and iOS. Main CI #43324277247, Worker migration/deploy/Verify #43324277256, and Web deploy/domain Verify #43324277307 succeeded. Per-record conflicts in a preview merge can explicitly keep production or accept the reviewed preview; choices are checksum-bound and resulting relation integrity is revalidated.
- Current branch adds a narrowly bounded rollback aid for newly journaled additive `add_columns` migrations. The inverse contains stable column IDs and is checksum-bound. It only prepares a new `drop_empty_column` migration, which still requires preview and explicit apply; if any column has values, preview blocks it. Existing journal arrays remain readable and replayable. Destructive, rename, conversion and old journal entries do not get a rollback button.
- Local Worker App/database/relation suites passed **226/226**; CompanyApp tests passed **6/6**; TypeScript and Web production build passed. Exact-head CI, merge and production deployment for this extension remain pending. No schema migration, new paid service or Simple-mode change was added.

### 2026-11-13 — Read-first App cells and Workflow run trace detail (PR #940 released)

- Harness table and board cells now show plain values until activated, then use per-type editors. Escape discards drafts for text, numbers, select, checkbox, people and relation cells; system columns remain read-only. Added focus styling and preserved neutral theme tokens and Simple mode.
- Workflow run detail now shows bounded, sanitized workflow definition templates, existing authorization events and per-step AI token usage/estimated model cost. It does not persist runtime-expanded record/message/connection values into the added preview. Step previews are capped at 1,200 bytes and the run preview budget at 8 KB. Existing run authorization remains unchanged.
- Worker workflow/input-preview/authorization/usage regression batch passed **153/153**. Web focused suites passed **157/157**, followed by the full Web suite **1,978/1,978**; TypeScript, production build, requirements JSON parsing and `git diff --check` passed. No new service, migration, paid contract or Simple-mode change was added. PR #940 merged as `def4fbd6b04a87b28784d05261f363b2925ee694`. Exact-head CI #43345382463 passed all required jobs including iOS and Windows; main CI #43347623523 passed (push workflow skips iOS/Windows). Worker D1 migration/deploy/Verify #43347623374 passed and `/health` reported `ok:true`, `encryption.all:true`. Web Pages/domain Verify #43347623133 passed; `app.honmaruai.com` and `honmaru-web.pages.dev` both serve `index-D4wM6RDL.js`. Authenticated Kylon side-by-side acceptance remains open.

### 2026-11-13 — Remote MCP destination lexical hardening (local QA; release pending)

- Expanded the shared public URL filter to reject additional local-only DNS suffixes and reserved IPv4 documentation/relay ranges. Remote MCP endpoint tests cover WHATWG-normalized short, integer, hexadecimal and octal loopback/private addresses. Existing HTTPS requirements and manual redirect refusal remain unchanged.
- This does **not** close DNS rebinding: Worker `fetch` does not expose a peer-IP pinning control in this path. The inventory explicitly keeps that risk open; no new service, paid contract, migration or Simple-mode change was added.
- Focused Worker `remote-mcp.test.js` and `links.test.js` passed **27/27**; `node --check`, requirements JSON parsing and `git diff --check` passed. Exact-head CI, merge and deployment are pending.

### 2026-11-13 — Remote MCP destination lexical hardening (local QA; release pending)

- Expanded the shared public URL filter to reject additional local-only DNS suffixes and reserved IPv4 documentation/relay ranges. Remote MCP endpoint tests cover WHATWG-normalized short, integer, hexadecimal and octal loopback/private addresses. Existing HTTPS requirements and manual redirect refusal remain unchanged.
- This does **not** close DNS rebinding: Worker `fetch` does not expose a peer-IP pinning control in this path. The inventory explicitly keeps that risk open; no new service, paid contract, migration or Simple-mode change was added.
- Focused Worker `remote-mcp.test.js` and `links.test.js` passed **27/27**; `node --check`, requirements JSON parsing and `git diff --check` passed. Exact-head CI, merge and deployment are pending.

### 2026-11-13 — Existing Markdown/HTML file export entry point (PR #971 released)

- A Markdown/HTML file preview now offers the existing document conversion dialog preloaded with the exact inspected version. The source content and format are locked in the export flow; output is PDF or DOCX. The user explicitly selects an online authorized local conversion node, and the dialog states the file content will be sent to that node. Successful output opens the created versioned Workspace file. Japanese labels were added.
- Focused Web tests passed **15/15**; full Web suite passed **2,005/2,005**; TypeScript/production build and `git diff --check` passed. The export request rejects oversized serialized content before making a Worker request. No Worker/API contract or paid service changed. Existing Simple and normal file download paths remain available.
- PR #971 merged to main as `3aefa3a6`. Exact-head CI run #43411232925 passed all required checks. Web deployment #43414235203 completed build, tests, Cloudflare Pages upload, domain attachment and Verify; both `honmaru-web.pages.dev` and `app.honmaruai.com` were verified serving `index-BWi1bbex.js`. Kylon file export remains only partially matched: authenticated UI interaction from an existing file, DOCX/HTML broader roundtrips, mobile/narrow UI, and populated side-by-side acceptance remain.
### 2026-11-13 — Archived App restore UI and authorization (local QA)

- Added an archived App inventory that returns metadata only and is scoped to the creator or workspace owner/admin. Restore requires the exact archive timestamp to prevent stale restore actions. The detail/table/version data stays intact; removed Room/public links and stopped automation are not silently re-enabled.
- Worker restore authorization, stale timestamp, retained table rows and archive visibility test passed **1/1**. Web Harness App UI passed **56/56**, TypeScript and production build passed. No database migration, paid service or Simple-mode change. Exact-head CI, merge and production deployment remain pending.

### 2026-11-14 — App-scoped Remote MCP read-only grants (local QA)

- Added App-level grants for one source-Agent-approved read-only Remote MCP tool at a time. Grant creation and invocation recheck current App membership/access, source-Agent audience, grant owner membership/audience, Agent tool grant, and the live Remote MCP allowlist/annotations. If those permissions or the App source change during a call, the returned data is discarded. Removing a Remote MCP server removes its App grants too.
- The Company App Connections panel exposes tool metadata/schema without endpoint or credentials. Generated apps can call `honmaru.remoteMcp(...)`; the host resolves only an App-shared tool and displays arguments in an explicit approval dialog before invocation. The worker never passes MCP endpoint or authentication data into the generated frame. Simple mode is unchanged; only read-only tools are supported.
- `worker/test/harness-apps.test.js` and `worker/test/remote-mcp.test.js` passed **183/183**, including App grant, invocation, metadata secrecy, owner transfer and revoke coverage. Web UI test/build could not start because the shared local `node_modules` is missing `@vitejs/plugin-react`, React type declarations, and `fast-json-patch`; a focused TypeScript scan reported no errors in the changed CompanyApp, CustomApp, or Harness API files, though the overall project check has existing dependency/type errors. Exact-head CI, merge, migration deployment and production verification remain pending. No new paid service was added.

### 2026-11-14 — Skill share link management through Harness MCP/CLI (local QA)

- Added owner-only metadata listing for custom Skill share links and explicit `confirm=true` / `--confirm` revocation. Responses never include bearer tokens or URLs. Revocation rechecks the actor's current non-guest membership and Skill ownership in the update statement; successful revocations enter the audit log. Share-link creation and import remain human-session operations.
- Worker `harness-mcp.test.js`: **25/25** passed; CLI suite: **62/62** passed; Worker module syntax checks and `git diff --check` passed. Worker Vitest required the permitted localhost runtime because the default sandbox blocks its listener. PR #983 merged as `b36ade40a9211a13935c0a15a25908c199a59fd8`; exact-head CI #43525561796, main CI #43527903917, Worker migration/Deploy/Verify #43527903906 and Web Deploy/Verify #43527903996 succeeded. Production health returned `ok:true` with encryption `all:true`; `app.honmaruai.com` served `index-BcqpUk0X.js`. No schema change, paid service, or Simple-mode tool exposure was added.

### 2026-11-14 — Skill visibility controls through Harness MCP/CLI (production verified)

- Added owner-only publish/unpublish using the current access version. Publishing requires explicit confirmation that the whole Workspace can read the Skill; unpublishing returns it to private. The API never creates an anyone-with-link URL, and successful changes are audited.
- Worker `harness-mcp.test.js`: **25/25** passed; CLI: **64/64** passed. PR #984 exact-head CI #43530673812, main commit `370da7d` CI #43533006849, Worker migration/deploy #43533006832, and Web deploy #43533007031 succeeded. Production Worker `/health` returned HTTP 200 with `encryption.all=true`; `app.honmaruai.com` returned HTTP 200 and served `index-BcqpUk0X.js` / `index-D4_VkcsS.css`. No schema change or paid service was added; Simple mode remains excluded.

### 2026-11-14 — Bulk Skill assignment to selected Agents (local QA)

- Added bounded Harness MCP assignment for up to five Skills and five Agents per call. Every pair rechecks Skill visibility and current Agent-manager authority, successes and failures are returned separately, and each assignment is audited. The CLI now includes `skill install`, `skill uninstall`, and confirmed `skill share` aliases.
- Worker `harness-mcp.test.js`: **25/25** passed; CLI suite: **64/64** passed. Tests cover explicit confirmation, per-Agent permission denial, partial failure reporting, and Simple-mode exclusion. Exact-head CI, merge, and production deployment are pending. No schema change or paid service was added.

### 2026-11-14 — Reconcile Thread Room guard release and App source privacy

- PR #987 merged as `df2f244b921389463d608513933f41153aae8af5`. Exact-head CI #43547376216 passed required Worker shards, E2E, iOS, Windows Edge, Web, Desktop and Gateway jobs. Main CI #43549057275 and Worker deploy/Verify #43549057273 succeeded; production Worker `410772bf-c9a1-4889-91da-9bab0c5c117f` reported `ok:true` and encryption `all:true`. This supersedes the earlier local/pending status for KY-099 `latestThreadRoomGuard`.
- Added regression coverage that App templates created from direct and group conversations inherit private visibility and remain unreadable to a different participant. The complete `harness-apps.test.js` suite passed 170/170. This protects the existing private-by-default behavior for non-room sources; no new runtime behavior was needed.
- Authenticated multi-user production acceptance and direct Kylon comparison remain open. Simple mode, database schema and paid-service configuration are unchanged.

### 2026-11-14 — Company App visual schema and column management

- PR #989 merged as `99d159b4a399c2a5805300ac7a86afd1533656c6`; exact-head CI #43556171708 passed all jobs, main CI #43558192066 passed, and Pages deployment #43558192093 succeeded. PR #990 merged as `6b61ea62aa62015f64931249ee27ba941db83f54`; its exact-head CI #43559604651 passed all jobs, main CI #43561591917 completed successfully, and Pages deployment #43561592016 succeeded. `app.honmaruai.com` returned HTTP 200 and served `/assets/index-CNMobUYl.js`, containing data-model, entity, relation and typed-column builder labels.
- Company App now displays entity/field cards and relation destinations and visually builds entity creation, typed columns with Select options, single/multiple relations, stable-ID column renames, typed conversions, and empty-column removals. Every operation is staged in the migration plan and still requires data preview, checksum and explicit confirmation; destructive or value-changing operations are validated against current rows. Duplicate migration-history rendering was removed.
- Current follow-up local QA: CompanyApp **13/13**; full Web suite **2,017/2,017** across 267 files; TypeScript and production build passed; `git diff --check` passed. A Playwright mock preview at 1440px and 390px confirmed no horizontal overflow, and switching the managed-column action to Relation exposes its target and cardinality controls. The mock did not execute a production database migration.
- PR #991 merged as `941c707b2bf6bc4f66d9cdc6330495fec07fcf97`; exact-head CI #43563742645 and main CI #43565017562 passed. Web deployment #43565017557 succeeded. Production returned HTTP 200 and its served app bundle contained the column rename/type conversion/empty-column removal controls.
- KY-039 remains partial because Honmaru uses app-scoped D1 logical isolation rather than a dedicated per-App Postgres DB/login, and authenticated side-by-side Kylon acceptance remains open. No database schema change, new paid service or Simple-mode change.

### 2026-11-14 — App view editing workflow

- Filter and grouping summaries now open the native editor directly. The existing app-conversation prompt remains available as a separate “AIに調整案を相談” action; personal-view prompts still identify themselves as private and are not sent or saved until the user chooses.
- Local focused Web tests: AppViewControls and HarnessApps **65/65**; full Web suite **2,017/2,017** across 267 files; Web TypeScript and production build passed; `git diff --check` passed. Exact-head CI, merge and deployment are pending.
- First exact-head CI exposed two E2E issues: source navigation still expected the old primary AI action, and the pin-race fixture used equal content versions so a concurrent canonical broadcast could replace its marker. The E2E now exercises direct editing before the secondary AI path, and models the late event with a newer content version but older pin version. Syntax checks and focused Web tests passed after these updates; full CI is rerunning.
- This increment changes only the Harness App view controls. Simple mode, database schema, existing AI request paths and paid-service configuration are unchanged.

### 2026-11-14 — KY-066/KY-079 Workflow Remote MCP write approval (production release)

- PR [#994](https://github.com/Torutesu/HonmaruAI/pull/994) adds Remote MCP write calls only as direct Workflow Connection steps. The workspace admin classifies each server tool for writes; the executing person needs an exact Agent/server/tool grant; and the Workflow must have an immediately preceding, successful Approval step in the same run. The card shows the rendered arguments. Inputs above 12 KB fail closed before dispatch.
- The Worker checks current policy before and after the provider call. If authorization changes while the call is in flight, its result is discarded and later steps stop. Ambiguous effects are not automatically retried. Existing Agent read paths remain, and Simple mode is unchanged.
- Focused Worker suites passed 187/187; full Web suite passed 2,017/2,017; TypeScript/build passed. Exact-head CI [43579317332](https://github.com/Torutesu/HonmaruAI/actions/runs/43579317332), main CI [43581230340](https://github.com/Torutesu/HonmaruAI/actions/runs/43581230340), Worker deploy [43581229709](https://github.com/Torutesu/HonmaruAI/actions/runs/43581229709) and Web deploy [43581229717](https://github.com/Torutesu/HonmaruAI/actions/runs/43581229717) succeeded.
- The current local regression pass also covered Harness MCP file delete/restore tools, App APIs and migrations: `harness-mcp`, `harness-apps`, `migration` — 220/220. MCP delete/restore code is present in deployed main; authenticated production use is still unverified.
- This is partial parity: arbitrary connector operations, DNS-pinned egress, full App/Workflow principal administration, provider-side cancellation guarantees and authenticated side-by-side Kylon acceptance remain open. No new paid service was added.

### 2026-11-14 — Room Agent scoped file writes (production release)

- Shared Room Agents now receive room-bound file listing/reading and text create/update tools in Harness mode. They cannot request another scope, upload binary files, delete files, or restore versions. The current signed-in human remains the actor; writes require `harness.build` and current Room file authority.
- Each tool invocation reloads Agent placement and call access. The D1 reservation, upload stage, and immutable-version commit each combine current human file-scope authorization with the Room Agent's current placement and profile/explicit role grant, so a removed Agent cannot finish a pending write. Simple mode omits these tools.
- PR [#996](https://github.com/Torutesu/HonmaruAI/pull/996) merged as `9c47a4406a02635459fa6132efb324d9c6cbbe5f`. Exact-head CI [43586519145](https://github.com/Torutesu/HonmaruAI/actions/runs/43586519145) passed all 13 jobs. Main CI [43588125060](https://github.com/Torutesu/HonmaruAI/actions/runs/43588125060) and Worker deploy/migration/Verify [43588125020](https://github.com/Torutesu/HonmaruAI/actions/runs/43588125020) succeeded. Production Worker `/health` returned `ok:true` and all encryption checks true; `app.honmaruai.com` and `honmaru-web.pages.dev` returned HTTP 200.
- Local Worker regression batch passed `harness-mcp` plus five file upload/version/share/HTTP suites, **164/164**. No schema migration or paid service was added. Authenticated Kylon side-by-side acceptance remains unverified. KY-073 remains partial: version-pinned message attachments, export conversion, retention/account lifecycle, and broader format parity remain open.

### 2026-11-14 — Room file links in Agent replies (local QA; release pending)

- Room Agent save results now include an `openUrl` on the configured Honmaru deployment, using the current `b:` or `g:` channel and the authenticated file-detail route. Link generation rejects workspace/DM scopes, malformed Room scopes, invalid deployment URLs, and inherited URL credentials. This lets the Agent return a direct Markdown link to a file it just created or updated.
- The same focused Worker batch passed **164/164** after the change, and the existing Web route suite passed **31/31**, including secure `b:` file-link parsing. No schema migration or new paid service. Exact-head CI, merge, and deployment are pending. The authenticated Kylon visual comparison remains open.

### 2026-11-14 — Skill support-file editing (local QA; release pending)

- The Harness Skills editor now loads support files through the existing per-file ACL route, allows text edits, path changes, binary-preserving replacement, adding and removing assets, then sends the complete package in one version-checked update. The Worker route now passes `expectedUpdatedAt` to the existing skill CAS so stale editors receive 409 and cannot replace a newer package.
- Focused Worker Skill access/MCP/package suites passed **83/83**; focused Web HarnessSkills/Agents suites passed **15/15**; Web typecheck and production build passed. No schema or paid-service change, and Simple mode is not exposed to this editor. Exact-head CI, deployment and authenticated screen acceptance remain pending.

### 2026-11-15 — Reconcile isolated ACP browser and Live Desktop parity

- Corrected KY-120 against current main `aa897cf6`: PR [#1008](https://github.com/Torutesu/HonmaruAI/pull/1008) already merged the Agent-isolated persistent Chromium session, explicit Harness ACP opt-in, and DNS-pinned public-only egress. Its exact-head CI #43652504240 passed all jobs; recorded local coverage was Gateway 79, Worker browser/gateway 21, Web 2,030, plus a successful Web production build. PR [#1009](https://github.com/Torutesu/HonmaruAI/pull/1009) then bound execution and every browser action to the exact requester-owned room/thread and current permission; its full Worker suite passed 3,538 tests. Follow-up main commits `ea01cca` and `aa897cf` stream ephemeral frames into the same thread and permit requester-only control takeover.
- Current-main local regression batch: browser-session/proxy **15/15**, Gateway client **24/24**, Worker relay/gateway **31/31**, WebSocket and HarnessThreadHeader **25/25**. Browser proxy tests require localhost access; their first sandboxed attempt failed with `EPERM`, then all passed under the permitted local test runtime. No runtime code changed in this reconciliation.
- KY-120 remains partial. The Apple Container Chromium smoke was still unverified in PR #1008 due insufficient free disk; cloud PCs and non-ACP first-party providers are absent; Mac mini authenticated production use, real multi-user takeover/revocation, and a same-task Kylon UI comparison remain open. Simple mode and paid-service configuration remain unchanged.
- A separate proposed exporter, PR #1012, was closed before merge after rebasing revealed it duplicated the already-merged GitHub draft binding/sync/refresh implementation on main.

### 2026-11-15 — KY-075 permanent public download MIME coverage (production release)

- Permanent signed file URLs now accept any syntactically valid MIME type. Existing image/video/audio/font types retain inline behavior; all other types (including HTML, text, PDF and archives) are served as `application/octet-stream` with `Content-Disposition: attachment`, `nosniff`, sandbox CSP and no-store headers. Invalid MIME values fail with 415. Version binding, size limit, token signature, revoke/purge checks and byte-range handling are retained.
- Focused `harness-file-public-urls` Worker suite passed **5/5**, including exact-byte GET, HEAD, inert headers, invalid-MIME rejection and inline media regression. The separate `file-share-approvals` suite passed **22/22**; `git diff --check` passed. PR [#1014](https://github.com/Torutesu/HonmaruAI/pull/1014) merged as `5f15e677c3dc09ece3cb16b8d222b5e509c318e4`. Exact-head CI [#43677704361](https://github.com/Torutesu/HonmaruAI/actions/runs/43677704361), main CI [#43678815421](https://github.com/Torutesu/HonmaruAI/actions/runs/43678815421), Worker migration/deploy/Verify [#43678815425](https://github.com/Torutesu/HonmaruAI/actions/runs/43678815425), and Web deploy/Verify [#43678815429](https://github.com/Torutesu/HonmaruAI/actions/runs/43678815429) succeeded. Production Worker `/health` returned `ok:true` with `encryption.all=true`; `honmaru-web.pages.dev` responded after deploy. KY-075 remains partial because authenticated multi-account production acceptance and Kylon side-by-side workflow comparison remain outstanding.

### 2026-11-15 — Public link redirect credential and downgrade hardening (production release)

- The shared public-link fetcher now refuses HTTPS-to-HTTP redirect downgrades and removes Authorization, Cookie and Proxy-Authorization headers before following a cross-origin redirect. It continues to validate each redirect destination and manually refuses unsafe private/local destinations. Focused links, preview and SSO Worker suites passed **34/34** after preserving the existing private-address rejection behavior.
- PR [#1015](https://github.com/Torutesu/HonmaruAI/pull/1015) merged as `429e306c064bc82545c59aecdd63fc36bf24b2bf`. Exact-head CI [#43680371839](https://github.com/Torutesu/HonmaruAI/actions/runs/43680371839), main CI and Worker/Web production deployment succeeded. The production app and Worker health endpoint returned HTTP 200 / `ok:true`.
- This does not resolve DNS rebinding. Current Cloudflare Worker `fetch()` is URL-based; `cf.resolveOverride` only applies to hosts in the Worker's zone. The TCP socket API documents hostname/IP connections and TLS, but no TLS server-name override for pinning an IP while validating the original hostname. See [Request API](https://developers.cloudflare.com/workers/runtime-apis/request/), [TCP sockets](https://developers.cloudflare.com/workers/runtime-apis/tcp-sockets/) and [known issues](https://developers.cloudflare.com/workers/platform/known-issues/). A no-new-vendor relay would need an authenticated, tenant-scoped design that preserves the existing credential boundary, and must fail closed while offline; direct Worker fetch must not be a fallback. Gateway jobs currently expose payloads to the Mac mini operator, so copying Remote MCP credentials into them is not an acceptable implementation without an explicit trusted-node design.

### 2026-11-15 — Batched Kylon parity ledger reconciliation

- Rechecked all **110** inventory rows against current code and release evidence. Counts are **4 implemented, 105 partial and 1 unverified**; this count is not a completion percentage. The old 109-row reconciliation and the stalled main CI observation for #1006 are historical; later descendant main CI #43678815421 succeeded.
- KY-063 already has paginated held-webhook events, on-demand payload inspection, explicit selected IDs for replay/discard, confirmation and regression coverage. Updated its acceptance record to leave authenticated production UI acceptance and direct Kylon comparison open instead of describing the discard UI as missing. `AutomationRuns.test.tsx`: **27/27 passed**.
- PR #920 had already merged and its main CI run #43161866406 succeeded. PR #1015's release record now reflects exact-head CI #43680371839, merge `429e306c`, production rollout, and the still-open Worker DNS pinning gap.
- Parity inventory consistency, JSON parsing and `git diff --check` passed. No runtime code, paid service, schema or Simple-mode behavior changed in this reconciliation.

### 2026-11-15 — KY-048 additive migration rollback release evidence

- Current main contains PR [#938](https://github.com/Torutesu/HonmaruAI/pull/938), merge `eb67a254b4b5a0e77d26ed8916e3490b3fc0da46`. Additive `add_columns` journal entries retain checksum-bound stable column IDs and can prepare a separate `drop_empty_column` migration. The normal preview/apply flow rechecks data; populated columns block the rollback, including at apply time. Tampered inverse metadata is hidden and prevents replay.
- Exact-head CI [#43329104671](https://github.com/Torutesu/HonmaruAI/actions/runs/43329104671) succeeded. Descendant PR #939 main CI #43340080575, Worker migration/deploy/Verify #43340080401 and Web deploy #43340080328 succeeded, so the change is on the released main lineage.
- Current focused rerun: Worker `harness-company.test.js` + `harness-app-relations.test.js` **61/61**; Web `CompanyApp.test.tsx` **13/13**. Parity inventory, JSON parse and `git diff --check` passed. This fixes a stale “pending” ledger statement only; no runtime code changed in this batch. Destructive/renamed/data-conversion rollback, legacy entries without inverse metadata, large snapshots and authenticated Kylon comparison remain open.

### 2026-11-15 — KY-040 strict row-version enforcement (production release)

- Strict App HTTP writes and externally granted App writes now reject missing `expectedUpdatedAt`; Harness MCP `update_row` requires it in both schema and execution. Workflow row updates carry the event row's captured version when targeting that row, while other explicit targets use their own current version. User-defined `id` columns cannot shadow the internal row identity used for version selection.
- Legacy/Simple table calls remain compatible when the token is omitted; provided stale tokens still conflict. Regression coverage includes strict HTTP, external App writes, MCP, workflows and relation paths.
- Batched Worker QA: `harness-apps`, `harness-workflows`, `harness-mcp`, `external-apps`, `harness-app-relations`, and `workflow-code-jobs` passed **443/443**. Exact-head CI [#43686794702](https://github.com/Torutesu/HonmaruAI/actions/runs/43686794702) passed; PR [#1017](https://github.com/Torutesu/HonmaruAI/pull/1017) merged as `f910706ca8da909fd4a2e85947d3b7d57e45b8ae`.
- Main CI [#43688580795](https://github.com/Torutesu/HonmaruAI/actions/runs/43688580795) and Worker migration/deploy/Verify [#43688580812](https://github.com/Torutesu/HonmaruAI/actions/runs/43688580812) succeeded. Production `GET /health` returned `ok:true` with all encryption readiness flags true. No new paid service was added and Simple-mode legacy writes remain supported.

### 2026-11-15 — KY-061 App-contained Automation activity overview (local batch QA)

- App-contained Automation history now renders the same shared rolling 168-hour overview as the central Workflow detail: run/failure counts, median completed duration, estimated AI usage, priced/unpriced/unknown usage caveats, and empty/partial-summary states. `GET /workflows/:id` already returned this data; the App detail previously dropped it. The shared summary card also removes duplicated central Workflow markup.
- Focused AutomationRuns, HarnessWorkflows and AppAutomations suites passed **130/130**. Full Web suite passed **2,031/2,031**; `npm run build` (TypeScript plus Vite production build) passed. Parity JSON parse, 110-row inventory consistency and `git diff --check` passed. Exact-head CI, merge, production deploy and authenticated Kylon visual acceptance are pending.

### 2026-11-15 — KY-079 DNS-pinned Remote MCP egress (production release)

- PR [#1019](https://github.com/Torutesu/HonmaruAI/pull/1019) routes configured Remote MCP and OAuth HTTP requests through an explicitly trusted, online Mac Gateway. The Gateway validates all DNS answers, pins the selected address while preserving TLS hostname verification, forbids redirects and bounds request size, response size and total request time. The Worker stores relay data only as AES-GCM ciphertext in a short-lived lease table and rechecks current membership and Agent/App authorization. Gateway absence or revocation fails closed without Worker fetch fallback. Simple mode and isolated App runtime networking remain unchanged.
- Local Gateway suite passed **92/92**, focused Gateway DNS/client tests **16/16**, focused Worker Remote MCP/Gateway tests **39/39**, Web build and HarnessApps.test.tsx **56/56**. One CI-discovered stale test locator was replaced with accessibility labels before final CI.
- Exact-head CI [#43697411306](https://github.com/Torutesu/HonmaruAI/actions/runs/43697411306) passed all required jobs. Merged as [4f6426b9](https://github.com/Torutesu/HonmaruAI/commit/4f6426b94938b22a3360cd27e97da97ef9571002). Main CI [#43699463535](https://github.com/Torutesu/HonmaruAI/actions/runs/43699463535), Worker deploy [#43699463508](https://github.com/Torutesu/HonmaruAI/actions/runs/43699463508) and Web deploy [#43699463483](https://github.com/Torutesu/HonmaruAI/actions/runs/43699463483) succeeded. Production GET /health returned ok:true and encryption.all:true.
- Refreshed the already-installed Mac LaunchAgent with the merged runtime and existing owner-only configuration. launchctl reports running; installed client.mjs and remote-mcp-http.mjs hashes match the merged source. A physical macOS reboot and live call against an explicitly configured production Remote MCP server were not performed. Kylon connector catalog breadth, all operation categories, authenticated multi-user acceptance and direct visual comparison remain open.

### 2026-11-15 — Workflow SDK Agent read-only Remote MCP (local QA; release pending)

- Workflow SDK `agent()` now receives only Remote MCP tools that are currently read-only, workspace-enabled, and individually granted to the Workflow's Agent and creator. Tool dispatch and result acceptance recheck the Workflow/Agent/connection access and workspace budget. Writable or ungranted tools stay out of the model schema. The shared authorization helper also preserves normal Workflow Agent-step audit events and budget-pause handling.
- Corrected the authorization principal: Gateway activation `node_owner` is a lease UUID, not a human user. SDK Agent authorization now resolves the frozen Workflow creator from the saved run definition; a regression test uses the real lease UUID distinction.
- Focused Worker `workflow-agent-invoke` + `harness-workflows` suites passed **159/159**; `git diff --check` passed. A full local `npm test` run was stopped after prolonged network-connection warnings without a completion summary; it is not counted as passing. Exact-head CI, main CI, deploy, and live Remote MCP invocation remain pending. No new paid service was added; Simple mode keeps its existing route.

### 2026-11-15 — Mobile per-user Simple display preference (local QA; release pending)

- Added a mobile Workspace settings switch backed by the existing user×Workspace preference endpoint. It loads on screen focus, saves with the server revision, reloads the current value after a stale-revision conflict, and offers a retry when the preference cannot be loaded. The label explains that this affects the signed-in user only and does not change the Workspace mode or other members.
- Added typed core API methods and focused request tests. `npm test --workspace @honmaru/core -- test/workspacePreferences.test.ts` passed **2/2**; mobile TypeScript (`npx tsc --noEmit -p tsconfig.json`) and Expo lint passed with no warnings. `git diff --check` passed. Simulator/device interaction and visual QA are not available in this local run.
- No new paid service; existing Simple mode remains the default experience and this preference only controls the signed-in user's view. PR, exact-head CI, merge, production deployment, and cross-device live sync verification remain pending.


### 2026-11-15 — KY-061 run-history paging and server-side status filter (local batch QA)

- Workflow run history now pages by a stable `(started_at DESC, id DESC)` keyset, with a 1–100 page size and optional status filter at the Worker. The cursor anchors only to an ACL-visible run; inaccessible runs are omitted from results and cursor output. The AutomationRuns panel loads older pages and restarts at page one when toggling failed-only.
- Web AutomationRuns, AppAutomations and API targeted suites passed **67/67**; the Web TypeScript/production build passed. Worker `harness-workflows` passed **151/151** after correcting the fixture's invalid empty-step workflow (the first run's 150 passing tests exposed that fixture error). Exact-head CI, merge, production deployment and authenticated Kylon screen comparison remain pending.
- No schema or paid-service change; existing workflow/run access control is retained and Simple mode is unchanged.

### 2026-11-15 — KY-020 stop during external session creation (local batch QA)

- Fixed the race where an assignment could be stopped while Claude was still creating an external session. The stop route now recognizes a fresh `starting` reservation and returns `pending`; when the provider returns its exact session ID, the start path rechecks the same assignment generation and sends cancellation. Provider cancellation failure remains visible and retryable; a failed start resolves to `no_remote_run`. Stale reservations older than the existing start hold are excluded.
- Batched Worker suites `teammates`, `agents`, `agent-assignments`, and `agent-job-result` passed **117/117**; `git diff --check` and parity JSON parsing passed. Exact-head CI, merge, production deployment and live provider cancellation acceptance remain pending.
- No schema or paid-service changes; Simple mode is unaffected.

### 2026-11-16 — KY-020 stop-during-start race (production release)

- PR [#1028](https://github.com/Torutesu/HonmaruAI/pull/1028) merged as `3140ea4791a09bafa42cb48e84ef608260721925` after all exact-head CI jobs passed, including all four Worker shards, E2E, Windows (Edge), and iOS. Local batched Worker regression suites passed **117/117**.
- Exact-head CI #43726759665 passed all required jobs. main CI #43728595549 and Worker migration/deploy/Verify #43728595654 passed; live provider-side cancellation remains unverified.
- No schema or paid-service change; Simple mode is unaffected.

### 2026-11-16 — KY-115 durable private helper history (production release)

- Persisted bounded private helper status, timing, title, and final finding for 30 days, and show them on the existing parent Agent run card only to the requester's authorized run view. Raw prompts and tool arguments are not stored; stale active helpers become interrupted after their bounded deadline. Simple mode remains unchanged.
- Worker `agent-subagents`, `agents`, `migration`, and `workspace-queries` suites passed **94/94**; AgentRunStatus tests **16/16**; Web typecheck/build and migration formatting passed. PR #1029 exact-head CI #43728896398, main CI #43731079110, Worker deploy #43731079111, and Web deploy #43731079095 passed. Authenticated Kylon acceptance remains open.
- No new paid service. Independent helper resumption, separate child credentials, and long-running cloud helpers remain out of scope.

### 2026-11-16 — KY-029 per-user private memory follow setting (local batch QA)

- Added a self-service preference scoped to authenticated user × Workspace × Agent. Legacy users default to enabled. When disabled, the user's private memory remains available in its source conversation but is excluded from other conversations during prompt preparation and memory search/read/review. Shared room memory and the owner's management/delete list remain separate. Preference read failures fail closed for personal memory. Simple mode and paid-service dependencies are unchanged.
- Worker `harness-memory-person-scope`, `memory-scope-prep-authority`, `harness-memory-scope`, `harness-agents`, `migration`, and `workspace-queries` suites passed **105/105**. HarnessAgents UI passed **11/11**; Web production build and TypeScript check passed. Migration one-line validation, parity JSON parsing, and `git diff --check` passed. The regression test failed against base `a6b461cdc71a5208c94eed1f3ecb4524bb2f64da` as expected. The implementation is local-only on `codex/kylon-personal-memory-follow-setting-20261116`; exact-head CI/release and authenticated Kylon side-by-side QA remain pending.
- Authenticated production screen comparison remains unverified. No new paid service was added; Simple mode is unchanged.

### 2026-11-16 — KY-036 explicit workspace Skill-to-Agent grants (local batch QA)

- Reused `hx_agent_skills`; no grant table or schema migration was added. A Skill owner can assign/revoke their shareable workspace Skill for an active same-workspace Agent, while existing Agent-manager assignment remains available. Write predicates recheck active membership, target Agent state, current Skill ownership and visibility, and source-scope restrictions.
- After rebase onto KY-029 main `c9205f5c`, Worker `harness-skills-access`, `harness-agents`, `harness-skill-share-agent-import`, and `harness-skill-share-authority` passed in one batch **125/125**. Regression coverage includes owner grant/revoke, wrong workspace, deleted Agent, unauthorized actor, membership revocation at insert, and imported source-scope restrictions. `git diff --check` and requirements JSON parsing passed. A test run against the old snapshot could not start because Vitest's Cloudflare pool was denied localhost bind (`EPERM`), so the old-code failure assertion remains unverified.
- No paid service, schema change, or Simple-mode change. The existing Agent Skill assignment UI/API is reused; authenticated Kylon side-by-side comparison and production acceptance remain pending. This local branch is not merged or deployed.
### 2026-11-16 — bind Workflow Remote MCP write approval to exact arguments (current-main QA)

- The existing human approval for a write-capable Remote MCP Workflow step now records a SHA-256 over canonical rendered arguments and binds it to the current run, workflow, approval/connection step, server and tool. The approval decision and actor are recorded in the run log. Before dispatch, the Workflow checks every binding and the argument hash; changing run input after approval fails closed before the MCP call. Existing workspace allowlist and Agent grant rechecks remain active.
- On a clean temporary checkout of current main `1191272aa71397c9d51b0f5ac4c490662908263f`, Worker `harness-workflows.test.js` and `remote-mcp.test.js` passed **164/164**. The targeted case verifies an approved write is sent exactly once and a changed-input run is rejected. `node --check` and `git diff --check` passed.
- No schema or paid-service change; Simple mode remains unchanged. Exact-head CI, merge and production rollout are pending. Live third-party write roundtrip and authenticated Kylon UI comparison remain unverified.
### 2026-11-16 — KY-051 Custom App release timeline (current-main QA)

- Version history now distinguishes the actual published release version from later draft snapshots that still carry that release. It marks releases as current, replaced or stopped, records explicit unpublish events, and includes publish-review requester/reviewer/status metadata without exposing source hashes or preview IDs. The Harness detail view displays the timeline and approval state. Existing restore-as-new-draft and current publish-approval gates remain unchanged.
- Worker `harness-apps.test.js` passed **171/171**; Web `CustomApp.test.tsx` passed **20/20**; Web TypeScript and production build passed. Regression coverage includes publication, inherited release, replacement, unpublish, pending/approved/published review state and removal of sensitive approval fields. `node --check`, parity inventory, and `git diff --check` passed.
- No schema migration, new paid service or Simple-mode behavior change. Exact-head CI, production release, direct rollback, runtime logs, environment-specific release history and authenticated Kylon comparison remain pending.

### 2026-11-16 — KY-051 draft-scoped Custom App preview DB (PR #1040)

- Custom App preview data is now keyed to the saved App version and source hash. Separate drafts receive separate preview data; authorized reviewers of one draft share its fork. Candidate creation, approval and publishing require that exact fork ID/revision and schema snapshot. A schema refresh archives the replaced preview data, while legacy `hx_app_forks` rows and generic Company App behavior remain unchanged.
- On final code head `5cda1449` in the isolated PR worktree, Worker `harness-apps.test.js`, `migration.test.js` and `custom-app-commit-release.test.js` passed **206/206**; coverage includes reviewer sharing, cross-draft isolation, legacy-fork preservation, stale-candidate rejection, migration replay and version-scoped preview setup for custom commit releases. Web `CustomApp.test.tsx` passed **21/21**; TypeScript no-emit, production build, Kylon parity inventory checker and `git diff --check` passed. No new service, paid dependency or Simple-mode change.
- PR #1040 remains unmerged. Exact-head CI after the documentation-only amendment and production release are pending. Runtime execution logs, detailed deployment status, direct rollback, environment-specific release history and authenticated Kylon comparison remain incomplete; this is not a claim of complete KY-051 or overall parity.

### 2026-11-16 — KY-051 creator-scoped App action execution history (incremental batch)

- The Company App server-action panel can load the signed-in viewer’s own App action runs in stable descending pages of at most 50. List rows contain only action name/version, status, and timestamps. They do not contain the gateway payload (code/input) or execution result. A viewer must explicitly request a row result; the existing job detail route still checks the App ACL, execution permission and job creator. The list query independently requires the action-job creator and gateway-job creator to match the current viewer. Losing App access hides the history. Simple mode and the current `honmaru.job()` polling path are unchanged.
- The execution schema stores payload/result on `hx_gateway_jobs` and App/name/version/creator on `hx_app_action_jobs`. The Worker growth-retention rules do not currently delete these rows, so the API paginates whatever authorized job rows still exist; it does not promise a fixed retention window. Added `(org_id, app_id, created_by, job_id)` index to fresh schema and migration; migration regression checks exact columns, idempotent deployment replay and query-plan use. No paid service was added.
- On current main `2be54771` plus this batch, Worker `harness-company.test.js` and `migration.test.js` passed **61/61**, covering 53 rows across pages, stable ordering, old retained rows, invalid limit/cursor, creator scoping, payload/result omission, index deployment and query plan. Direct list-boundary regressions verify both missing `harness.build` permission (403) and revoked App access (404). Web `CompanyApp.test.tsx` passed **14/14**, covering lazy loading, explicit result retrieval and paging. Web TypeScript no-emit and production build passed; parity inventory and `git diff --check` passed. Exact-head CI and authenticated Kylon screen comparison remain pending.
- This adds a basic personal run-history surface, not Kylon-equivalent streamed logs. Runtime diagnostic streams, detailed deployment status, direct rollback, environment-specific release history, and authenticated Kylon comparison remain.

### 2026-11-16 — Workflow table page snapshot consistency (combined PR #1037)

- A query cursor now pins pages to one table data generation. Row insert/update/delete and moves between tables increment version counters through triggers; each page reads the counter and rows in one D1 batch and refuses a stale generation. Cursor payloads carry a Worker-signed HMAC, so the isolated Workflow SDK cannot edit the generation or offset. The cursor key stays in D1 KV and is never sent to the Gateway/guest.
- Added a schema-only replay regression for all three triggers and a caller-tampered generation regression. On the combined tree, Worker workflow/MCP/App/table-query suites passed **386/386**, workflow query plus migration tests passed **77/77**, and Web `CustomApp.test.tsx` passed **20/20**. TypeScript/production build, `node --check`, parity inventory and `git diff --check` passed.
- No new paid service or Simple-mode change. Exact-head CI, production release and authenticated Kylon comparison remain pending.

### 2026-11-16 — Remote MCP approval descriptor binding and localized release history (PR #1037 follow-up)

- Security review found a pending approval could otherwise survive a same-name tool definition change. Approval now hashes the displayed name, title, description, input schema, annotations, and server/tool identity in addition to exact rendered arguments; dispatch fails closed if the reviewed descriptor changes. Regression coverage changes a schema-compatible tool description while approval is pending and proves no second MCP dispatch occurs.
- Local Worker `harness-workflows.test.js` passed **151/151** after the regression. Web `CustomApp.test.tsx` passed **20/20**; TypeScript and production build passed. The release history states, review trail, restore action and guidance now use the shared localization system with Japanese, Spanish, French and German translations. `node --check`, parity inventory and `git diff --check` passed.
- No new service, paid contract, migration or Simple-mode behavior change. Exact-head CI for these follow-up changes and production rollout remain pending.


### 2026-11-16 — KY-072 editable conversion destination and conflict handling (candidate)

- Source-to-PDF/DOCX exports now let the user choose a destination basename. The UI validates it as a basename and rejects path separators/control characters before enqueue. Worker admission rejects an existing artifact or active conversion at the same authorized org/scope/path with a clear conflict response, including an atomic guard against concurrent submissions. Unauthorized scope remains indistinguishable from an unavailable/queue-full destination.
- Permanent Gateway artifact publish errors now report job failure promptly (best effort) rather than leaving it running until lease expiry. Transient retries and lease-loss behavior remain intact. Source-version pinning, local node selection, existing size limits, pinned no-network conversion, immutable versioned artifacts and no-overwrite semantics are preserved.
- Focused QA in an isolated checkout: Web DocumentCreate/preview tests **16/16**, Worker document-jobs tests **24/24**, Gateway document-client tests **9/9**, Web TypeScript no-emit and production build passed. Parity inventory and diff checks passed. This is candidate-local QA only: exact-head CI, merge, production release, authenticated Kylon UI comparison, mobile/narrow viewport, CLI export and production roundtrip remain unverified.

### 2026-11-16 — KY-072 CLI export (candidate)

- Added `honmaru workspace file export` for exact Markdown/HTML versions to PDF/DOCX through a scoped MCP bridge. It requires an eligible local node and supports bounded wait/cancel. `--dest` publishes an immutable Workspace version; `--output` writes exclusively to local disk after origin/content-type/size/SHA-256 verification; with neither it returns a short-lived download URL and does not create a Workspace file. Temporary binaries live in existing R2 MEDIA, with hashed bearer links and scheduled 15-minute cleanup. No new service or paid dependency.
- Permanent artifact publish path conflicts now mark the active job failed promptly and clean staged bytes; enqueue performs the existing same-scope/path conflict check before job creation. Source version, 2 MiB limit, scope/build authorization, local-node eligibility, pinned no-network execution and append-only artifacts remain enforced.
- Focused local validation: CLI workspace **69/69**, Worker document/MCP/migration suites **80/80**, syntax checks and `git diff --check` passed. No exact-head CI, merge, deploy, Kylon-authenticated screen comparison or production export roundtrip yet. Kylon CLI docs state that `--dest` prints a workspace link; Honmaru currently reports the versioned file ID/version/path because an equivalent deep link was not verified. [Kylon CLI file docs](https://docs.kylon.io/cli/workspace/file).
### 2026-11-16 — KY-055 atomic App room-link move (candidate)

- Added a move operation that updates one App↔Room link in a single D1 statement. It requires the source link's current `created_at` revision and verifies both source and destination conversation authority in that same statement. A stale source, existing destination, or room access revoked after route preflight returns a conflict while preserving the source link.
- Added a Move control in App settings. Entering a destination room enables moving an individual existing link; other links remain attached. Room link timestamps are exposed only for rooms the current viewer can read.
- Validation on main `0b4b98ba`: Worker `harness-apps.test.js` **174/174**; Web `HarnessApps.test.tsx` **57/57**; TypeScript and production build passed; `git diff --check` passed. No schema migration, new paid service, or Simple-mode behavior change.
- Candidate only: exact-head CI, merge, automatic main deployment, production acceptance and authenticated Kylon UI comparison remain.
