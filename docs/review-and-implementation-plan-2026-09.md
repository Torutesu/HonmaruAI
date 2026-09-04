# Honmaru AI — 徹底レビューと「完成」までの実装計画

作成日: 2026-09-04
対象: `main` (HEAD `8f02a23`) / ブランチ `claude/code-review-implementation-plan-wz7nus`
検証環境: Worker テスト 197/197 合格（実 workerd）、server 11/11、web-react build + 7/7、iOS テスト 15 本（CI は PR 時のみ）

---

## 0. 要約

**結論: コアループは本物のインフラ上で動いており、課題 (prd.md) の必須要件は「動く状態」を満たしている。しかし「実ユーザーに提供できる製品」としては、(A) リレーの書き込み経路に残る認可ホール（任意カードの上書き・依頼元の偽装・read-only 協力者のフル参加）、(B) PRD の中核である「組織モデルに基づくルーティング」と「受信側 AI によるカード変換」が GitHub 権限のラベル付け以上のものになっていないこと、(C) 送信者が結果を追えず、通知カードが「承認/却下できる決定」として扱われる設計上の矛盾、(D) docs が「済」とするオフライン耐性が実際には成立していない（オフライン起動でサインアウト、再接続直後の決定が失われ得る、GitHub 接続時のオフライン承認は失敗）、(E) App Store 提出に至るリリース工程の未検証（アイコンのアルファチャンネル、一度も走っていない TestFlight ワークフロー、非機能な IAP UI）、の 5 点で止まっている。**

所見の総数: Worker 30 件（P0 6 / P1 9 / P2 15）、AI ルーティング 9 件、iOS 40 件超（P0-P1 20 / P2 20 超）、docs・CI・レガシー 15 件。Phase 0（2〜3 日）で P0 を閉じ、6 週前後で PRD の中核と App Store 提出まで到達する計画を §4 に示す。

到達度（PRD の必須要件別）:

| PRD 要件 | 状態 | 根拠 |
|---|---|---|
| ネイティブ iOS (SwiftUI)、動作可能 | ✅ 完了 | TestFlight 内部配布済み、`project.yml` |
| マルチユーザー・ユーザーごとの AI・別々のカード | ✅ 動作 / ⚠️ 設計欠陥 | 全メンバーが全カードのスナップショットを受信する（`relay.js:200-202`）。表示は受信者フィルタのみ |
| GitHub ログイン・リポジトリ取得・Issue 同期 | ✅ 動作 / ⚠️ 範囲が狭い | 承認時のみ Issue 作成。却下・差し戻し・委譲は Issue が既にある場合しか反映されない（`DecisionCardService.swift:183`） |
| 縦スクロールフィード、カード単位の決定、テキスト指示、AI 解釈 | ✅ 完了 | `FeedView`, `/ai/route` |
| AI 間通信: A の指示 → B の AI → Decision Card → 結果が A に戻る | ✅ 動作 / ⚠️ 戻り方に欠陥 | 結果は「pending の通知カード」として A に届き、A がそれを「承認」すると B に更に通知が飛ぶ（無限ピンポン）。委譲後は元の依頼者に最終結果が届かない |
| 組織グラフ（役割・責任範囲・承認権限）に基づく配信 | ⚠️ 最小実装 | GitHub のリポジトリ権限を役割名に置き換えただけ。`manages` エッジは一度も生成されず、ルーティングの「上長へエスカレーション」分岐は本番で死んでいる |
| 受信側 AI が受信者の役割・状況に合わせて変換 | ⚠️ 未実装 | 送信者コンテキストのみプロンプトに入る。受信者の `contexts` はどこにも使われない（`routing.js:296-304`） |
| 優先度変更 / AI への追加指示 | ❌ 未実装 | カード上では不可。下書き時のみ優先度指定可 |
| Issue / PR / Discussions / Projects への同期 | ⚠️ Issue のみ | |

「完了」と言える領域: 認証基盤（OAuth state、セッション、GitHub トークンのサーバー側保持、GitHub プロキシの許可リスト）、レート制限、AI メーター、Mailgun 署名検証、監査ログ、コネクタのパーサー、iOS のオフライン基盤（キャッシュ・アウトボックス・再接続）、多言語 UI（391 キー全て ja あり）。

---

## 1. 検証方法

- `worker/src` 全ファイル（約 5.1k 行）、iOS の Swift 全ファイル（約 9k 行）、`server/`・`web/`・`web-react/`・`docs/`・CI ワークフロー・`scripts/` を通読
- `worker`: `npm ci && npx vitest run` → 41 ファイル 197 テスト合格（21.8 秒）
- `server`: `npm test` → 11 合格。`web-react`: `npm run build` 成功、`vitest` 7 合格
- iOS はビルド環境がないため静的レビューのみ。`Localizable.xcstrings` は 391 キー中 391 に `ja` あり
- README / PROGRESS / production-release-plan の「Done」主張はコードで一つずつ照合した

---

## 2. コードレビュー所見

重大度: **P0** = 攻撃者または通常操作で到達できる破壊・漏洩・データ損失 / **P1** = 製品の約束が成立しない / **P2** = 品質・運用 / **P3** = 整理

### 2.1 Worker（Cloudflare）

#### P0

| # | 所見 | 場所 | 影響 |
|---|---|---|---|
| W-1 | `card_created` に既存 ID を載せると、所有者チェックなしに `saveCard` の `ON CONFLICT DO UPDATE` で任意のカードを丸ごと上書きできる。`existing` は読むが `card_created` 分岐では使っていない | `relay.js:228-246`, `db.js:16-45` | 組織のどのメンバーでも他人の決定（受信者・状態・decision）を書き換えられる。全員が join スナップショットで全 ID を知っている |
| W-2 | `card_updated` は `recipientUserID` と `decision.actorUserID` しか固定せず、`senderUserID`・`createdAt`・`sourceApp` 等はクライアント値をそのまま保存し監査スナップショットにも記録 | `relay.js:234-260` | 受信者が依頼元を偽装できる。監査ログが偽装値を正として残す |
| W-3 | 「メンバー = write 権限」はスローパスのみ。`/orgs/:o/:r/graph` は `pull` のみの協力者にも `memberships` 行を書き、以後 `isMember` の高速パスで通る | `index.js:270-274`, `membership.js:32-35`, `org.js:9` | 読み取り専用の協力者がリレー・sync・履歴にフルアクセス。docs の主張と矛盾 |
| W-4 | `card_created` の `recipientUserID` が組織メンバーか検証されない。加えて `devicesForLogin` は org スコープでない | `relay.js:216-246`, `db.js:385-392`, `push.js:39-46` | 存在しないユーザー宛カードが永遠に残る（iOS 側 OfflineRouter のデモ ID 送信で実際に起きる）。別組織のログイン宛に任意タイトルの push を送れる |
| W-5 | アカウント削除が `cards.sender_user_id` / `card_events.actor_user_id` の**列**は匿名化するが、クライアントが読む `data` / `snapshot` の JSON 内 `senderUserID`・`actorUserID`・本文はそのまま | `account.js:26-37`, `db.js:3-14`, `events.js:36` | 削除後もログイン名と本文が全メンバーのフィード・履歴に残る。テストは列しか見ていない（`account-delete.test.js:69-86`）。GitHub OAuth grant・Composio 接続アカウントも失効させない |
| W-6 | メール webhook: `u-<github id>@domain` で宛先を決めるため、公開情報の GitHub ID だけで第三者が任意ユーザーの AI 枠（1 日 200 回）を消費し、`format: "approve"` のカードをフィードに置ける。署名は「Mailgun 経由」しか証明しない | `index.js:480-520`, `email.js:20-54` | 本番で Mailgun を有効化する前に送信者の信頼モデルを決める必要がある。`ALLOW_UNSIGNED_EMAIL_WEBHOOK` は本番で設定可能なままの footgun |

#### P1

| # | 所見 | 場所 |
|---|---|---|
| W-7 | cron は `connector_config` 行があるユーザーしか拾わない。書き手は Notion の `PUT /connectors/notion/config` だけなので、Gmail / Slack のみ接続したユーザーは 15 分同期の対象外。テストは Notion 設定を seed しているため欠陥を固定化している | `scheduled.js:30`, `scheduled.test.js:36` |
| W-8 | cron は `LIMIT 50` でカーソルなし、全ユーザー逐次、outbound fetch にタイムアウトなし。51 人目以降は永遠に同期されない | `scheduled.js:31-33` |
| W-9 | **outbound fetch に一切タイムアウトがない**（OpenAI・GitHub・Composio・APNs・RevenueCat）。DO のメッセージハンドラ内で OpenAI が詰まるとソケットが止まる | `routing.js:671`, `triage.js:70`, `composio.js`, `apns.js:105`, `entitlements.js:19` |
| W-10 | 閉じたソケットへの `ws.send` が例外になり `broadcast` / `sendTo` のループが途中で抜ける。DB 書き込み後に送信者へ `RUN_ERROR` が返るため「保存されたのに失敗と表示」になる | `relay.js:65-79`, `:365-367` |
| W-11 | D1 await 中は DO の入力ゲートが解放されるため、`tool_result` / `card_updated` / `rollback` の load→apply→save が交錯し lost update が起きる。バージョン列も CAS もない | `relay.js:228-246`, `:338-343`, `:371-387` |
| W-12 | `retainMemberships` は `NOT IN (?2..?101)` を組み立てるが D1 のバインド上限は 100。`fetchCollaborators` も `per_page=100` でページングなし。ちょうど 100 人で 500、101 人以上で失効検知漏れ | `db.js:244-253`, `github.js:12` |
| W-13 | `card_updated` に `decision` が付いていれば毎回「decided」ログ + Notion 行追加 + push を行う。iOS は GitHub Issue の open/closed 同期のたびに `decision` 付きで `card_updated` を送るため、Issue を閉じるたびに Notion に重複行、送信者に重複 push、履歴に重複「decided」が発生 | `relay.js:250-290`, `DecisionCardService.swift:127-131` |
| W-14 | GitHub アクセストークン（`repo` スコープ）が D1 に平文保存。サインアウト API が存在せず、セッションはスライド更新で 30 日生き続け、失効セッションは掃除されない | `schema.sql:57`, `db.js:120`, `ratelimit.js:113-123` |
| W-15 | `GET /media/:id` が無認証・immutable キャッシュ・アップロード時の content-type をそのまま返す（`text/html` を上げれば API オリジン上のストアドページ）。`nosniff` なし | `media.js:61, 89` |

#### P2

- `/ai/route` は `body.sender` / `text` の欠落や長さ上限を検証せず 500 になる（`index.js:126-145`, `routing.js:298`）。匿名呼び出しに `quotaExceeded: true` を返し「サインインして」ではなく「上限超過」と見せる（`gate.js:11`）
- `pendingCountFor` を `waitUntil` の**引数評価時**に `await` しており、コメントの「deferred, never awaited」と裏腹に、ブロードキャスト前に D1 の COUNT を待つ（`relay.js:285-288`, `:413`）
- `saveCard` → `markIngested` が非アトミック。webhook の再配送やクラッシュで重複カード（`sync.js:48-70`, `index.js:492-527`）
- メール webhook と cron は `SELECT org_id … LIMIT 1` で複数組織所属ユーザーの組織を任意に選ぶ（`index.js:485-489`, `scheduled.js:26`）
- `join` は認証済みソケットで再送でき、レート制限も対象外。全組織の `loadStore` を無制限に叩ける（`relay.js:164-208`）
- `DELETE /devices` が呼び出し元にスコープされず、任意のデバイストークンを消せる（`index.js:243`）
- `/devices`・`/account`・`/connectors/*/connect`・`/orgs/graph`・両 `/events` にレート制限なし。`/orgs/graph` は 1 回で GitHub 1 コール + 協力者 ×3 の D1 書き込み
- OAuth `state` を GitHub 交換の**前**に消費するため、GitHub 側の一時エラーで再サインインが必要（`index.js:174-194`）。許容範囲
- `deploy-worker.yml` の `/health` は `ok: true` 固定で DB 到達性を見ていない（`index.js:106-118`）。docs の「DB reachability」は誤り
- D1 マイグレーションが `CREATE … IF NOT EXISTS` のみ。最初の `ALTER TABLE` で本番が黙って列を欠く。`wrangler d1 migrations` 未使用
- 開発は `wrangler ^3.80`、デプロイは `wrangler@4`。テストと本番のランタイム版がずれる
- DO 側のログは `console.error` のみ。WS 経路の失敗にリクエスト ID も org も付かない

#### データモデル

- 個人の主キーが **可変な GitHub `login`**（cards / contexts / device_tokens / card_events）。`upsertUser` がリネームで `login` を更新すると push 先・過去カードが一致しなくなる。`users.login` に UNIQUE も index もない
- 不足 index: `cards(recipient_user_id)`（org なし）、`cards(sender_user_id)`、`contexts(user_id)`、`card_events(actor_user_id)`、`memberships(user_github_id)`、`sessions(github_id, expires_at)`、`ingested_items(user_github_id)`
- 死テーブル: `orgs`（読み書きなし）、`agents`（書くだけ）
- CHECK / FK なし。決定済みカードのアーカイブなし → `loadStore` が「組織の全カード」を毎接続で全員に送る（スケールと機密性の両方の問題）

### 2.2 AI ルーティング（`routing.js`, `triage.js`）

- `org.js` が生成するエッジは `memberOf` / `assignedTo` / `canApprove` の 3 種。**`manages` は一度も生成されない**ため、`routing.js:133-155, 419-424` の上長エスカレーションと system prompt の該当行は本番で到達不能
- 「役割」は GitHub 権限（Admin / Maintainer / Engineer / Triager / Member）のみ。デザイン・経理・営業といった責任領域はどこにも存在しない。`canApprove` の唯一の用途は `defaultRecipient` が「送信者以外の最初の承認者」を選ぶこと（`routing.js:61-69`）
- キーワードフォールバックは実組織では **指示文を無視**する: `TEAM_ROUTES` / `ROLE_ROUTES` はデモ ID 専用でスキップされ、残るのは「ログイン名の部分一致 → 最初の承認者 → 最初の他人」。`summarizeInstruction` は今も `alice|bob|carol|dana` を剥がしている（`:445-478`）
- **組織が空のとき `DEMO_USER_IDS` にフォールバック**し `user-toru` に配送する（`:3, :63, :107`）。ゲストや org graph 取得失敗（`AppState.loadOrganization` はエラーを握りつぶす）で実際に発生する
- ログイン名の `includes` 判定（`:106`）は `al` / `ai` のような短いログインで誤爆し、`applyRoutingGuard` の `forceOverride` でモデルの正解を上書きする
- モデルが不正な recipient を返すと **カード本文ごと捨てて**フォールバック（`validateRouting :522`）。recipient だけ補正すれば済む。tools に `strict: true` がなく enum は助言止まり
- 日本語: フォールバックの cardType 判定・優先度・タイトル・context は英語固定で `readerLanguage` を受け取らない（`:571-603`）。`buildUserPrompt` の既定は `ja`、`triage` の既定は `en` と不一致
- `max_tokens: 512` は日本語 4 セグメントの context で `finish_reason: length` を起こしやすく、その場合 `parseToolArguments` が throw してフォールバック
- `triage.js` は良い（フェンス・enum 検証・長さクランプ）が、` ```json ` フェンス付き返答を `JSON.parse` できず「決定不要」として課金 + ingested 記録 → 二度と再判定されない。`response_format: json_object` 未使用
- コネクタ由来カードは `senderUserID = 受信者` で保存され、push に「自分の AI →」と出る

### 2.3 iOS（SwiftUI）

#### P0 / P1（製品の約束に関わる）

| # | 所見 | 場所 |
|---|---|---|
| I-1 | **通知カードのピンポン**: `resolve()` は常に `type: .notification, status: .pending` の応答カードを `card.senderUserID` に作る。`DecisionCardView` は `isPending` なら Approve / Decline / Revise / Delegate を出すため、送信者は「承認されました」という通知を**承認**でき、それがまた相手への pending 通知を生む。GitHub 接続時は通知の「承認」で `[Update] …` という Issue まで作られる。pending バッジにも数えられる | `DecisionCardService.swift:203-234`, `DecisionCardView.swift:759-808` |
| I-2 | **GitHub 接続時、オフラインの承認/委譲は失敗する**: `syncDecision` を `try await` してから decision を作るため、ネットワークがないと throw → エラー表示 → アウトボックスに乗らない。「P1-3 オフラインの決定は届く」は却下と差し戻しにしか当てはまらない | `DecisionCardService.swift:183-188, :258-263` |
| I-3 | **OfflineRouter がデモ ID (`user-yui` / `user-tanaka`) に配送**する。実組織では存在しない受信者宛カードがリレーに永久保存され、誰にも届かない | `OfflineRouter.swift:28-31` |
| I-4 | **委譲チェーンで元の依頼者が結果を失う**: A→B、B が C に委譲すると `delegatedCard.senderUserID = B`。C の決定通知は B にしか戻らず、A は「B が C に委譲した」までしか知らない | `DecisionCardService.swift:283-323` |
| I-5 | **送信者側に「自分が出した依頼の状態」を見る画面がない**。通知カードと History（イベントログ）で代替しており、未決の依頼を催促する場所もない（docs も「sent-items view が無い」と認めている） | — |
| I-6 | `syncGitHubStatus` が 30 秒ごとに Issue 状態を確認し、変化時に `decision` 付きの `card_updated` を送る → W-13 の重複 Notion 行・重複 push・重複履歴の引き金 | `FeedViewModel.swift:317-323`, `DecisionCardService.swift:104-142` |
| I-7 | ゲストモードが行き止まり: リレー接続なし、org 空 → `/ai/route` はセッションなしで拒否 → キーワードルータが `user-toru` に配送 → ゲストのフィードには何も現れない。「Continue without signing in」の体験が壊れている | `AppState.swift:133-140`, `routing.js:63` |
| I-8 | `org graph` 取得失敗を握りつぶす。委譲先が空・AI ルーティングがデモ ID 化するのに UI は何も言わない | `AppState.swift:179-192` |
| I-9 | 送信者の役割が常に `"Member"`（`AppState.user(from:)`）で AI に渡る。受信者のコンテキストは渡さない | `AppState.swift:105-113` |
| I-10 | **オフラインでのコールド起動がサインアウトになる**: `restoreSessionIfNeeded` は `validateSavedSession()`（`/user` の往復）の**あらゆる**エラーでセッションを消す。機内モードで起動すると onboarding に戻り、キャッシュもアウトボックスも一度も使われない。401/403 のときだけ消すべき | `AppState.swift:89-103`, `GitHubService.swift:407-420` |
| I-11 | **アウトボックス送出が join の認証と競合し、ソケットを永久に `refused` にし得る**: `connect` は join フレームを**書けた時点**で `.connected` にして `flushOutbox()` する。リレーは join の認証中に D1 / GitHub を await しており（入力ゲートは D1 を跨いで直列化しない）、その間に届いた `tool_result` は「先に join せよ」の `RUN_ERROR` + close 1008 → iOS は `.refused` と解釈して以後再接続しない。送出済みのアウトボックス項目は失われる | `WebSocketService.swift:257-266, :387-388, :294`, `relay.js:164-166` |
| I-12 | `connect()` を生きた受信ループ中に呼ぶと、旧ループの catch が `.connecting` を `.offline` にし `scheduleReconnect()` を積むため、接続成功後にもう一度 `connect()` が走る（リポジトリ切替・前面復帰で発生） | `WebSocketService.swift:237-239, :382-393` |
| I-13 | サインアウト時にアウトボックスを消さない。次のアカウントでサインインすると前ユーザーの `card_created` が再送され、リレーが送信者を**今のログイン**に書き換えて公開する | `AppState.swift:194-214`, `WebSocketService.swift:198` |
| I-14 | `FeedViewModel.bind` の 30 秒ポーリングループが `deinit` で解放されず、`AppShell` がタブ切替のたびに `FeedView` を再生成するため、Home を訪れるごとにタイマーが増える | `FeedViewModel.swift:317-323`, `AppShell.swift:22-33` |
| I-15 | ユーザーコンテキストは「リレーにミラーされ再インストールでも残る」とコメントにあるが、実際は送るだけ。スナップショットの `context` と `/context/<user>` の delta を `AGUIEventAssembler` が捨てている | `AppState.swift:115-117`, `AGUIEvent.swift:52-53` |
| I-16 | 前面復帰の再接続は `state == .connected` なら何もしない。バックグラウンドで iOS に殺されたソケットは次の送信まで気づかれない。ping / keepalive なし | `WebSocketService.swift:295` |
| I-17 | `SessionStore.clear()` が `apiKey`（ユーザー自身の OpenAI キー）を消さないため、共有端末で次のユーザーの `/ai/route` に前ユーザーのキーが乗る | `SessionStore.swift:160-167`, `AIService.swift:154-156` |
| I-18 | `ConnectorsView.authorize` が `ASWebAuthenticationSession` を保持せず `start()` 直後に解放され得る。エラー時に `true` を返す | `ConnectorsView.swift:146-156` |
| I-19 | **App Store 提出ブロッカー**: `AppIcon.png` が RGBA（PNG colour type 6）。1024px アイコンのアルファチャンネルは ITMS-90717 で拒否される | `Assets.xcassets/AppIcon.appiconset/AppIcon.png` |
| I-20 | Release では RevenueCat が構成されないのに `SubscriptionView` が「Upgrade to Pro」「Restore purchases」を出し、押すと「利用できません」。審査で非機能 IAP UI として指摘されやすい（2.1 / 3.1.1） | `RevenueCatConfig.swift:15, :55`, `SubscriptionView.swift` |

#### P2

- **Dynamic Type が実質存在しない**: `Theme.TypeScale` と約 100 箇所の `.font(.system(size:))` が固定ポイント。text style も `@ScaledMetric` も未使用のため、docs の「accessibility1 でクランプ」という妥協以前に文字が拡大しない
- Reduce Motion を一切見ていない。`SubscriptionView` が `.preferredColorScheme(.dark)` を強制しライト基調のデザインシステムと Appearance 設定に反する。`textTertiary`（#838383 on white ≈ 3.5:1）が 10〜11pt のモノラベルに使われ AA 未満
- **ローカライズを迂回する経路**: `Text(String)` はカタログを引かないため、`CardDetailSheet` の見出し（Why you / Summary / Context / Routing / From / Type …）、`ComposeBar(placeholder:)`、`CaptureView` の Clear / Send、`PrioritySlider` のラベルは ja 設定でも英語。カタログ未登録: "Issue #n" / "View on GitHub" / "Type instead" / 役割 "Member" "Guest" / `GitHubService` のエラー文全部。`Info.plist` の権限説明文も英語のみ（`InfoPlist.xcstrings` なし）。`DateFormatting` / 音声認識 / 更新日フォーマッタは `Locale.current` を使い、アプリ内の言語切替に追従しない
- 応答カード・委譲カードの本文が英語固定（`"created GitHub issue"`, `"Delegated by …"`, `"delegated to"`）で reader language を無視（`DecisionCardService.swift:206-231, :290-319`）。`OrganizationGraph.routingReason` も英語固定
- 受信カードが増えると `scrollPosition` が最新に飛ぶ。`TOOL_CALL_END` と `STATE_DELTA` の両方が `.cardCreated` を出すため 1 枚につき 2 回発火し、決定操作中に画面が動く（`FeedViewModel.swift:556-559`, `AGUIEvent.swift:94-96`）
- 承認が GitHub を待つ: `syncDecision` を decision 記録の**前**に await し、全面 `ProcessingOverlay` の下で待つ。`FeedViewModel` のコメント（「決定はローカル、GitHub は事後処理」）と逆
- `applySnapshot` は空スナップショットをキャッシュがある限り無視するため、正当に空になった組織のカードが残り続ける。非空スナップショットは丸ごと置換するため、アウトボックス待ちのローカル変更が一瞬消える
- Swift の `DecisionCard` は `summary` / `context` / `type` / `status` を必須にしているが、`CARD_SCHEMA` / `validate.js` では任意。欠けたカードは `print` だけ残して黙って捨てられる。`format` / `options` / `drafts` / `source` は未モデル化。`originalBody` / `originalLanguage` はバックエンドのどこも出力しないため `TranslatedFrom` は死んだ UI。`SourceSheet` は "toru@honmaru.jp" 等の偽ヘッダを表示し自ら「demo reproduction」と名乗る
- `AppShell` が常に `showsChrome: false` を渡すため、`FeedView` の topBar / bottomChrome / メニュー / quota 通知 / 「Local mode · Connect GitHub」チップ / paywall シート（約 130 行）は到達不能。`ConnectGitHubSheet.Context.afterFirstApproval` と `FirstRunFlags.promptedGitHubConnect` は使われず、「初回承認後に GitHub 接続を促す」体験は存在しない
- `AppState` の状態（`isGuest`・`userContext`）が `@Published` 宣言の間に散らばる。`DecisionCardService` が View 用 `onCardsUpdated` クロージャと `@Published pendingCount` の二経路で変更を通知。`DecisionCardService` が GitHub 通信を直接行い、`AppState` が HTTP を叩き、View が直接ネットワークを呼ぶ（`FeedView.syncConnectors`, `ConnectorsView`, `HistoryView`）。サービスはすべて具象クラスで、`PushService.shared` / `SubscriptionService.shared` をサービス内部から参照するため値型より上はテスト不能
- `context` 文字列に `"Revision: …"` を連結して保存（データモデルではなく文字列に意味を持たせている）。`GeneratedBlocks` と `ContextInsights.parse` が同じ `label: value · …` を二重にパース。`GeneratedBlocks.Block.id = UUID()` が描画ごとに変わり identity を壊す
- `OnboardingView.githubStep` と `ConnectGitHubSheet` が約 150 行重複。`FeedView.topBar` と `AppShell.homeTopBar` も重複
- `CaptureView` の Send が recorder 完了前に `dismiss()` → `teardown()` でファイナライズが止まりクリップが黙って落ちる。アップロード失敗時はカードに `file://` URL が乗り、受信者側で再生不能
- `CardCache` は `.iso8601` でミリ秒を落とすためキャッシュ順とリレー順が同秒カードでずれる。`waitingDays` は暦日ではなく 24 時間単位
- `print(` が 3 箇所（`SessionStore`, `AGUIEventAssembler`, `AppDelegate`）。`os.Logger` 未使用。`SWIFT_VERSION: "5.9"` だがコードは `nonisolated(unsafe)`（5.10）を使う
- 残骸: `CFBundleURLName com.tangle.tiktokforwork.oauth`、Keychain サービス名 `com.tangle.…`、`bundleIdPrefix: com.tangle`、`NSAllowsLocalNetworking` / `NSLocalNetworkUsageDescription`（LAN リレー時代）
- `/connectors/email/address` を呼ぶ画面がない（PROGRESS 記載どおり）
- iOS テストは 15 本（キャッシュ 4・カード値型 6・アウトボックス 5）。docs が主張する `OfflineRouter` / `AGUIEventAssembler` のテストは存在しない。`DecisionCardService.resolve` / `delegate`・`WebSocketService` の再接続・`FeedViewModel` はテストなし

- 応答カード・委譲カードの本文が英語固定（`"created GitHub issue"`, `"Delegated by …"`, `"delegated to"`）で reader language を無視（`DecisionCardService.swift:206-231, :290-319`）
- 受信カードが増えると `scrollPosition` が最新に飛ぶ。決定操作中に他人のカードが来るとフィードが動く（`FeedViewModel.swift:556-559`）
- `AppState` の状態（`isGuest`・`userContext`）が `@Published` 宣言の間に散らばる。`DecisionCardService` が View 用 `onCardsUpdated` クロージャと `@Published pendingCount` の二経路で変更を通知
- `context` 文字列に `"Revision: …"` を連結して保存（データモデルではなく文字列に意味を持たせている）。`GeneratedBlocks` はラベル `deadline/scope/…` の文字列パースに依存
- `print(` が 3 箇所（`SessionStore`, `AGUIEventAssembler`, `AppDelegate`）。`os.Logger` 未使用
- `/connectors/email/address` を呼ぶ画面がない（PROGRESS 記載どおり）
- Dynamic Type を `accessibility1` でクランプ（docs で既知の妥協）
- iOS テストは 15 本（キャッシュ 4・カード値型 6・アウトボックス 5）。docs が主張する `OfflineRouter` / `AGUIEventAssembler` のテストは存在しない。`DecisionCardService.resolve` / `delegate`・`WebSocketService` の再接続・`FeedViewModel` はテストなし

### 2.4 レガシー・参照クライアント・docs・CI

- `server/`（581 行 + `agentTools.js` 732 行）は「何もビルドしない」と README にあるが、CI が毎 push でテストしている。`server/agentTools.js` は `routing.js` のほぼ複製。`server/data/*.json` は `.gitignore` 追加と同じコミットで追加された空/フィクスチャ（実データ・秘密情報なし）
- `web-react/` は **本番 Worker に接続できない**（`sessionToken` を送らない、`TOOL_CALL_RESULT.content` の形が違う、rollback ボタンの条件が常に偽、delegate はプレースホルダ、既定 URL が `ws://localhost:8080`）。テストはレガシー join を固定化。`web/index.html` の方が Worker 方言を話す
- docs の陳腐化: Worker テスト数が 11 / 147 / 152 / 197 と 4 通り、`onboarding.md`・`design.md` は存在しない 5 画面目（persona）と `DemoData` を記述、`docs/agui-protocol.md` は `server/` パスと「iOS outbound tool_result は次」を記述、存在しないファイル 8 件（`docs/setup-ja.md`, `.asc.env.example`, `HonmaruAI.entitlements`, `worker/test/apns.test.js`, `metadata/`, `screenshots/`, 他）
- 秘密情報リストの不一致: コードは `APNS_TOPIC`, `APNS_ENVIRONMENT`, `MAILGUN_WEBHOOK_SIGNING_KEY`, `INBOUND_EMAIL_DOMAIN` を読むが README / release checklist は一部を欠く（`APNS_TOPIC` がないと `notifyCard` は黙って no-op）
- コミットされた鍵: 本物の API キー・秘密鍵なし。RevenueCat の Test Store 公開キーのみ（意図的、公開リポジトリ化時はローテーション推奨）
- CI: lint / typecheck / coverage なし。iOS は PR のみ、Release 構成のビルドは TestFlight ワークフロー内のみ。`testflight.yml` は**一度も実行されておらず**、`brew install asc` が失敗 → `github.run_number` をビルド番号にフォールバック → 既存ビルド番号（22+）より小さく ITMS 拒否がほぼ確実。`ASC_APP_ID` シークレットもない。`setup.sh` の既定スキーム名 `HonmaruAI` は実在しない（`TikTokForWork`）
- App Store 提出に対して未着手: プライバシーポリシーのホスティング、`metadata/` `screenshots/`、`asc review doctor` の 34 ブロッカー、push 有効化、本番 RevenueCat キー

---

## 3. PRD に対する製品ギャップ（設計レベル）

1. **「必要な人に必要な情報だけ」が成立していない。** リレーは組織の全カードを全員に送り、iOS が受信者でフィルタしているだけ。機密（給与・契約）が全端末のキャッシュに載る。サーバー側で「受信者 or 送信者」に絞った配信にする必要がある
2. **組織モデルが GitHub 権限の写像で止まっている。** PRD が求める上長関係・チーム・プロジェクト・責任範囲・承認権限のうち、実際に存在するのは「admin/maintain = 承認者」だけ。AI に渡る `Organization:` ブロックは「ログイン · Engineer」の羅列で、「役割に最も合う人を選べ」という指示に答える材料がない
3. **受信側 AI が存在しない。** カードは送信時に送信者のデバイスが `/ai/route` を呼んで作り、そのままリレーに置く。受信者の `contexts`（「私はこう働く」）は保存・同期されるだけで、カード生成に一切使われない。「受信者の役割・優先度・状況を踏まえて変換」は未着手
4. **決定の往復モデルが未整理。** 結果の返送が「pending の通知カード」で表現されるため、通知が決定と同じ UI・同じバッジ・同じ GitHub 同期経路に乗る。「FYI = 既読で消える」「決定 = 承認/却下」を型で分ける必要がある。AG-UI 側には `format: fyi` と `acknowledge` が既に定義されているのに iOS が使っていない
5. **GitHub 同期の範囲。** 承認 = Issue 作成、以後は Issue の open/close 追従のみ。却下理由・差し戻しコメント・委譲（assignee 変更）・優先度（label）は Issue に反映されない。PR / Discussions / Projects は未対応
6. **カード上の操作が PRD の 7 種のうち 5 種。** 優先度変更と「AI への追加指示」がない

---

## 4. 実装計画

原則: 各フェーズは単独でデプロイ可能。テストを伴わない修正は完了と見なさない。見積りは 1 人のエンジニアが AI 支援ありで作業する前提の営業日。

### Phase 0 — 止血（2〜3 日）

出荷前に必ず閉じる。既存ユーザーに見える挙動変更は少ない。Worker 側（P0-1〜5, 10, 11）と iOS 側（P0-6, 8, 9, 12〜18）は別人で並行できる。

| ID | タスク | 変更 | 受け入れ条件 |
|---|---|---|---|
| P0-1 | `card_created` の既存 ID を拒否（または `card_updated` と同じ所有者検査に落とす） | `worker/src/relay.js` | 既存 ID を `card_created` で送ると `RUN_ERROR`、DB 不変。テスト追加 |
| P0-2 | `card_updated` は受信者が変えてよいフィールド（status / decision / revisionNote / github*）だけを `existing` にマージ | `relay.js`, `agui/validate.js` | `senderUserID` / `createdAt` / `sourceApp` を変えた `card_updated` が保存されない。監査スナップショットが正しい |
| P0-3 | 受信者の組織メンバー検証（`card_created` と `tool_result` 内 delegate） | `relay.js`, `db.js`（login→membership 解決） | 非メンバー宛は拒否。テスト追加 |
| P0-4 | `isMember` を write 権限ロールに限定、または `/orgs/graph` で pull-only を `memberships` に書かない | `worker/src/membership.js`, `index.js`, `db.js` | pull-only 協力者の join / sync / events が 403。既存テスト更新 |
| P0-5 | `broadcast` / `sendTo` の `ws.send` を個別 try/catch | `relay.js` | 閉じたソケットが混ざっても残りに届く。テスト追加 |
| P0-6 | OfflineRouter のデモ ID 廃止: 受信者は「自分」固定 + 送信時に組織メンバーから選ばせる | `TikTokForWork/Services/OfflineRouter.swift`, `DraftReviewSheet` | オフライン下書きの受信者が常に組織メンバー |
| P0-7 | `routing.js` の `DEMO_USER_IDS` / `TEAM_ROUTES` / `ROLE_ROUTES` / `userNameFor` / alice-bob 正規表現を削除。組織が空なら 400 を返す | `worker/src/routing.js`, `index.js` | 実組織でデモ ID が出力されない。`server/agentTools.js` は Phase 4 で削除 |
| P0-8 | 通知カードの型分離（応急）: `.notification` は Approve/Decline/Revise/Delegate を出さず「確認」のみ。`resolve` は `.notification` に対して応答カードを作らない。pending バッジから除外 | `DecisionCardView.swift`, `DecisionCardService.swift` | 通知を確認しても新しいカードも Issue も生まれない。本設計は Phase 1-2 |
| P0-9 | GitHub 同期を decision 記録の**後**に移し、失敗は `githubSyncPending` フラグでリトライ | `DecisionCardService.swift`, `DecisionCard.swift` | 機内モードで承認 → 復帰後に Issue が作られ、カードにリンクが付く。テスト追加 |
| P0-10 | outbound fetch 全てに `AbortSignal.timeout`（OpenAI 20s、GitHub 10s、Composio 30s、APNs 10s、RevenueCat 5s） | `worker/src/*.js` | タイムアウト時に既存のフォールバック経路に落ちる |
| P0-11 | `/ai/route` の入力検証（`text` ≤ 4,000 文字、`sender.id/name` 必須、`organization` の形） | `index.js`, `routing.js` | 欠落で 400、500 にならない |
| P0-12 | オフライン起動でサインアウトしない: `validateSavedSession` の失敗を `.unauthorized`（401/403）とそれ以外に分け、後者はセッションを保持してキャッシュで起動 | `AppState.swift:89-103`, `GitHubService.swift` | 機内モードでコールド起動 → キャッシュされたフィードが出る。テスト追加 |
| P0-13 | join 認証完了（`RUN_STARTED` / `STATE_SNAPSHOT` 受信）まで `.connected` にせずアウトボックスも流さない。`.connecting` 中の `send` は拒否してキューへ。リレー側は認証前メッセージを close せず `RUN_ERROR` のみ返す | `WebSocketService.swift:257-266, :362`, `relay.js:164-166` | 再接続直後の決定が失われず、`refused` にもならない。テスト追加 |
| P0-14 | 再接続のスラッシュ防止: 受信ループの catch で `task !== self.task` なら何もしない（接続世代カウンタ） | `WebSocketService.swift:382-393` | リポジトリ切替後に二重接続が起きない |
| P0-15 | サインアウトで `Outbox.clear()` と `SessionStore.apiKey` の削除 | `AppState.swift:194-214`, `SessionStore.swift:160-167` | 別アカウントでサインイン後に前ユーザーのカード・キーが出ない |
| P0-16 | `FeedViewModel` の `deinit` で `githubSyncTask` / `draftTask` を cancel。`AppShell` でタブ切替時に `FeedView` を破棄しない（`ZStack` + `opacity` か `@StateObject` を Shell に持ち上げ） | `FeedViewModel.swift`, `AppShell.swift` | タブを 10 回往復してもポーリングは 1 本 |
| P0-17 | `AppIcon.png` をアルファなし RGB に再出力 | `Assets.xcassets/AppIcon.appiconset/` | PNG colour type 2 |
| P0-18 | `SubscriptionView` を `Purchases.isConfigured` のときだけ表示（Release では Plan 行を隠す） | `YouView.swift`, `SubscriptionView.swift` | 非機能な IAP UI が出ない |

### Phase 1 — コアループを正しくする（3〜5 日）

PRD のコアフロー「A → B の AI → B の決定 → A に反映 → GitHub」を端から端まで矛盾なくする。

**1-1 決定の往復モデルを型で分ける**

- `DecisionCard.format`（AG-UI の `approve | choice | reply | fyi`）を iOS モデルに取り込む。応答カードは `format: fyi` + `type: .notification`
- `fyi` は「確認」で `acknowledge` を `tool_result` として送り、`completed` にする。バッジ・SLA チップ・GitHub 同期の対象外
- リレー側: `applyDecision` の `acknowledge` は既にある。`upsertEvents` は `fyi` にも `request_decision` を送るので、クライアントが `format` で分岐
- 受け入れ: A が依頼 → B が承認 → A に fyi が届く → A が確認しても B に何も届かない。Worker / iOS 両方にテスト

**1-2 「送った依頼」ビュー（Sent）**

- `cards(for:)` の逆、`sentCards(by: userID)` を `DecisionCardService` に追加。既にクライアントは組織全カードを持っている（Phase 2-1 でサーバー側絞り込み後も「自分が送信者のカード」は配信対象に含める）
- 画面: You タブ or Home のセグメント「Inbox / Sent」。各行に状態ピル（Waiting 3d / Approved / Declined / Delegated to C）、GitHub リンク、催促ボタン（`nudge` = 受信者に fyi を送る）
- 受け入れ: 送った依頼の現在状態が一覧で分かる。5 日超えの pending に催促できる（docs の P2-3 の未完部分）

**1-3 委譲チェーンの追跡**

- カードに `rootCardID` / `originSenderUserID` を追加。委譲カードは `originSenderUserID` を引き継ぎ、最終決定の fyi は `senderUserID` と `originSenderUserID` の両方に送る
- 受け入れ: A→B→C で C の決定が A にも届く。Sent ビューで A のカードが「Delegated to C → Approved by C」と表示

**1-4 GitHub 同期の範囲拡大**

- 承認: Issue 作成（現状）。却下: Issue が無ければ作らず、あれば close + コメント（理由）。差し戻し: Issue にコメント（revision note）。委譲: `assignees` に委譲先ログインを設定。優先度: `priority:*` ラベル
- GitHub プロキシ許可リストに `POST /repos/:o/:r/issues/:n/comments`、`PATCH issues`（assignees / labels は既存 PATCH で可）を追加
- Issue 本文にカード ID と往復履歴を書く（既存の表を拡張）
- 受け入れ: 各アクションが Issue 上で追える。プロキシのテスト更新

**1-5 W-13 の重複解消**

- iOS の Issue 状態追従は `card_updated` ではなく新メッセージ `card_status_synced {cardId, status}` を送り、リレーはログ種別 `synced` で記録、Notion / push を起動しない
- リレー側でも冪等化: `writeDecisionToNotion` は `ingested_items(connector='notion', card_id)` を先に確認
- 受け入れ: Issue を閉じても Notion 行・push・履歴が増えない

**1-6 サーバー側の recipient / sender 配信絞り込み（機密性）**

- `loadStore` → `loadStoreFor(orgId, login)`: `recipient_user_id = login OR sender_user_id = login OR origin_sender = login` のみ
- `broadcast` を「関係者にのみ送る」`sendToParties(card, ev)` に置き換え（受信者・送信者・元依頼者）。presence / context のブロードキャストは維持
- 受け入れ: 第三者のソケットに他人のカードが流れない。iOS の `cardsByUser` 前提は変わらない

**1-7 応答カードをリレーが作る**

- 現状は決定者の端末が送信者向けの応答カードを作るため、決定者がオフラインなら送信者は何も知らない。リレーは `tool_result` 受信時に決定済みカードをブロードキャスト済みなので、送信者側は「自分が送ったカードの `decision` 変化」から fyi を生成できる（1-1 の `format: fyi` を `applyAndPublish` で生成して `sendTo(senderUserID)`）
- Undo（rollback）時は対応する fyi を取り消す（`decision_rolled_back` CUSTOM を iOS が処理）
- 受け入れ: 決定者の端末を機内モードにしても、リレーに届いた瞬間に送信者へ fyi が届く

**1-8 コンテキスト同期とキープアライブ**

- `AGUIEventAssembler` がスナップショットの `context` と `/context/<user>` の delta を `RealtimeEvent.contextUpdated` として流し、`AppState.userContext` に反映（コメントの「再インストールでも残る」を本当にする）
- 30 秒ごとの `ping` フレーム、または `sendPing` で死んだソケットを検出して再接続
- 受け入れ: 再インストール後にコンテキストが復元される。バックグラウンドで切れたソケットが前面復帰 5 秒以内に再接続

**1-9 GitHub 同期のサーバー移管（任意、1-4 と同時が望ましい）**

- 決定を `tool_result` で受けたリレーがセッションの GitHub トークンで Issue を作る（プロキシ経由と同じ API）。クライアントの `syncDecision` を廃止できれば I-2 が根本解決し、Issue 作成が「決定者の端末が生きている」ことに依存しなくなる
- 判断: 1-4 をクライアントで作った直後にサーバーへ移すのは二度手間なので、**Phase 1 の着手時に決める**。推奨はサーバー移管

### Phase 2 — PRD の中核: 組織モデルと受信側 AI（5〜8 日）

**2-1 組織グラフの拡張（編集可能な役割・上長・チーム・プロジェクト）**

- D1: `org_profiles(org_id, user_github_id, title, responsibilities TEXT[JSON], manager_github_id, team, approves TEXT[JSON])` と `org_projects(org_id, id, name, owner_github_id)`
- 初期値は GitHub 権限から生成（現状）。編集は **AI 経由**でも良いが、最短は You → Organization 画面で自分の役割・責任・上長・担当プロジェクトを編集し、Admin は全員分を編集できる
- `buildOrgGraph` が `manages` / `assignedTo(project)` / `canApprove(project)` エッジを生成
- 受け入れ: 「上長に承認を」で `manages` エッジが使われる。`routing.js` の死んでいた分岐にテストが付く

**2-2 ルーティングプロンプトの再設計**

- `Organization:` ブロックを「login · title · responsibilities · manager · projects · approves」の構造化テキストに
- tools に `strict: true`、recipient 不正時は recipient のみ補正して本文は保持
- ログイン部分一致の `forceOverride` を廃止し、`@login` 明示メンションのみ強制
- 日本語フォールバック: `readerLanguage` を受け取り、cardType / priority 判定に日本語語彙を追加、タイトル・context のテンプレを言語別に
- `max_tokens` 1,024、`finish_reason` を検査
- 受け入れ: 日本語・英語それぞれ 10 件の指示で意図した受信者に配送される回帰テスト（fetchMock でモデル応答固定）

**2-3 受信側 AI（カードのパーソナライズ）**

- `/ai/route` を 2 段に分離: (a) 送信側 `route` = 受信者決定 + 中立の要約、(b) 受信側 `render` = 受信者の `contexts`（役割・優先事項・現在の状況）と reader language でカードを書き直す
- (b) はリレーが `card_created` 受信時にサーバー側で実行（`waitUntil`）し、完成後に `card_updated` を配信。受信者のコンテキストが送信者の端末に渡らないため機密性も改善
- カードに `originalBody` / `originalLanguage`（既存フィールド）を必ず埋め、翻訳前の原文を見せる
- 受け入れ: 同じ指示が受信者 B と C で異なる summary / context / priority になる。受信者コンテキストの有無で出力が変わるテスト

**2-4 カード上の操作を PRD の 7 種に揃える**

- 優先度変更: カード詳細から `priority` を変更 → `card_updated`（受信者のみ）→ GitHub ラベル更新
- AI への追加指示: 「Reply…」を「AI に指示」に拡張し、`/ai/refine` で summary / context / priority を再生成、または送信者への質問（`format: reply`）として返送
- 受け入れ: 7 操作すべてが UI から到達可能で、それぞれ履歴に残る

**2-5 ゲストモードの整理**

- 選択肢 A: ゲストを廃止し、サインインなしでは onboarding のスワイプデモまで。選択肢 B: ゲスト専用の「自分の AI との一人組織」を成立させる（受信者 = 自分固定、リレー接続なし、ローカル保存のみ）
- 推奨: **A**。審査用には TestFlight の共有アカウントか、`prd.md` が認める PAT/テスト接続を用意する方が安い

### Phase 3 — 運用と堅牢性（3〜4 日）

| ID | タスク | 受け入れ条件 |
|---|---|---|
| 3-1 | cron の候補を Composio 接続アカウント（`/connectors` の ACTIVE）または `connector_links` テーブルに変更。カーソル（`last_synced_at` 昇順）で 50 人ずつ回す。並列 5 | Gmail のみのユーザーが 15 分以内に同期される。100 ユーザーでも全員が 1 時間以内に回る |
| 3-2 | `POST /logout`（セッション削除 + デバイス削除）と失効セッションの掃除を cron に追加 | サインアウト後のトークンが 401 |
| 3-3 | GitHub トークンの AES-GCM 暗号化（Worker secret 由来の鍵、`apns.js` と同じ WebCrypto） | D1 に平文トークンが無い。既存行のマイグレーション |
| 3-4 | アカウント削除の完全化: `cards.data` / `card_events.snapshot` の JSON 内匿名化、GitHub grant 失効（`DELETE /applications/{client_id}/grant`）、Composio 接続削除、R2 参照の削除 | 削除後に他メンバーのフィード・履歴にログイン名が出ない。テストは JSON を検証 |
| 3-5 | D1 を `wrangler d1 migrations` に移行（`0001_init.sql` = 現 schema、以後は番号付き）。`deploy-worker.yml` を `migrations apply` に | `ALTER TABLE` を含む変更が CI で本番に適用される |
| 3-6 | 不足 index の追加、`orgs` / `agents` の削除または利用、`users.login` に UNIQUE | 主要クエリが index を使う |
| 3-7 | `/media`: `video/*` のみ受理、`X-Content-Type-Options: nosniff`、`GET` にセッション必須（または署名付き URL 24h） | HTML アップロードが 415。未認証 GET が 401 |
| 3-8 | メール webhook の信頼モデル: 受信者ごとの日次上限（例 20 通）、既知送信者（過去にやり取りのある From または連絡先許可リスト）以外は `format: fyi` の低優先度で「未確認の送信者」表示。`ALLOW_UNSIGNED_EMAIL_WEBHOOK` は本番 env で拒否 | 見知らぬ送信者が承認カードを作れない |
| 3-9 | `saveCard`+`markIngested` を `db.batch`、`/orgs/graph` の upsert を batch、`join` の再送拒否、`DELETE /devices` の所有者スコープ、残り経路のレート制限 | 各テスト追加 |
| 3-10 | lost update 対策: `cards.version` を追加し `saveCard` を `WHERE version = ?` の CAS に。衝突時は再読込して再適用 | 2 ソケット同時決定のテスト |
| 3-11 | DO のログにリクエスト ID・org・userId・message type を付ける。`/health` で D1 `SELECT 1` | `wrangler tail` で WS 経路の失敗が追える |
| 3-12 | `wrangler` を 4 系に統一（devDependency とデプロイ） | テストと本番が同一ランタイム |
| 3-13 | iOS: `applySnapshot` を「サーバーが空を返したら空」に戻し、代わりにアウトボックス中のローカル変更をスナップショット適用後に再適用 | 空になった組織のカードが消える。オフライン決定が一瞬も消えない |
| 3-14 | iOS: `DecisionCard` の `summary` / `context` / `type` / `status` を任意にしてデコード失敗で捨てない。`format` / `options` / `drafts` / `source` をモデル化（Phase 1-1 と共有） | Worker のフィクスチャ 5 種をデコードできるテスト |
| 3-15 | iOS: `ConnectorsView` の `ASWebAuthenticationSession` を保持、`CaptureView` の dismiss を録画ファイナライズ後に、アップロード失敗時は `file://` をカードに載せず再試行キューへ | 各手動確認 + 可能な範囲でテスト |

### Phase 4 — リリース工程と整理（3〜4 日 + Apple 待ち）

| ID | タスク | 受け入れ条件 |
|---|---|---|
| 4-1 | push 有効化: App ID に `aps-environment`、`HonmaruAI.entitlements` 追加、プロファイル再発行、Worker secrets 4 + `APNS_ENVIRONMENT`、`isEnabledInThisBuild = true`。**Workers からの APNs は HTTP/2 必須のため、有効化前に実機で 1 通届くことを確認** | 実機に通知が届き、タップでカードに遷移 |
| 4-2 | `testflight.yml` の初回実行と修正: `asc` の入手方法（Homebrew tap か GitHub release）、`ASC_APP_ID` シークレット追加、ビルド番号を App Store Connect の最新 +1 から取得、`group` 入力の適用、`altool` → `asc publish` または `xcrun notarytool` 系に | Actions からのアップロードが TestFlight に載る |
| 4-3 | `setup.sh` の既定スキーム `HonmaruAI` → `TikTokForWork`、`release.sh:79` の `.asc.env.example` を実在させる | ローカル `release.sh build` が動く |
| 4-4 | App Store 提出物: プライバシーポリシーを GitHub Pages か Worker の `/privacy` で公開、`metadata/` `screenshots/`、`asc review doctor` のブロッカー消化、本番 RevenueCat `appl_` キー（または課金機能を 1.0 から外す判断） | `review doctor` クリーン |
| 4-5 | レガシー削除: `server/`、`web-react/`、`server/data/`、`scripts/device.sh`、`Local.xcconfig` 機構、`Info.plist` の `NSAllowsLocalNetworking`。`web/index.html` は `worker/` 配下に移して Worker がサーブするか削除。`server/test/agui.test.mjs` の有用ケースは `worker/test` に移植。CI から 2 ジョブ削除 | README の「Legacy」節と CI が一致する |
| 4-6 | docs の同期: テスト数、onboarding 4 画面、`agui-protocol.md` のパスと進捗、secrets 一覧（`APNS_TOPIC` / `APNS_ENVIRONMENT` / Mailgun 2 件）、存在しないファイル参照 8 件、`worker/README.md` のルート表に `/connectors/*` `/github/**` `/webhooks/email` `/media` `/events` を追加、Notion の `name: "title"` の記述矛盾を live 検証で確定 | 各 doc の主張がコードで裏付けられる |
| 4-7 | メールアドレスの表示（`GET /connectors/email/address`）を Connectors 画面に追加、Mailgun ドメイン設定 | 実メールでカードが 1 枚作られる |
| 4-8 | ローカライズの取りこぼし: `Text(String)` 経路を `Text(LocalizedStringKey)` / `String(localized:)` に統一、未登録 15 件をカタログへ、`InfoPlist.xcstrings` を追加、`DateFormatting` / 音声認識 / 更新日のロケールを `AppLanguage` から取る。応答・委譲カードの本文は reader language でリレー側生成（1-8）に寄せる | ja 設定で英語が残る画面がゼロ。`Text("…")` 以外で文字列リテラルを描画する箇所を検出する lint（Phase 5） |
| 4-9 | iOS の残骸整理: `FeedView` の `showsChrome` 分岐（約 130 行）、`FirstRunFlags`、`seedDemoFeedIfNeeded`、`restorePartialCredentials`、`ConnectGitHubSheet.Context.afterFirstApproval`（使うなら 1-2 の Sent ビューから呼ぶ）、`ProBadge` / `proPaywall`、`SourceSheet` の偽ヘッダ、`TranslatedFrom`（2-3 で本物のデータを流すまで非表示）、`com.tangle.*` 識別子、`NSAllowsLocalNetworking`。`OnboardingView.githubStep` と `ConnectGitHubSheet` の共通化 | 到達不能コードがない。`SWIFT_VERSION` を 5.10 に |
| 4-10 | Dynamic Type とアクセシビリティ: `Theme.TypeScale` を text style + `@ScaledMetric` に、Reduce Motion で `withAnimation` を無効化、`SubscriptionView` の `.preferredColorScheme(.dark)` 削除、`textTertiary` の 10〜11pt 用途をコントラスト AA 以上に、`PageDots` / `SenderAvatar` を VoiceOver から隠す。カードは 1 ページ内スクロール可能なレイアウトに（docs の既知妥協 P2-1 の本解） | 最大サイズでアクション行が届く。Accessibility Inspector で警告ゼロ |

### Phase 5 — 品質基盤（2〜3 日、他フェーズと並行可）

- **Worker**: 追加テスト = W-1〜W-13 の回帰、日本語フォールバック、`finish_reason: length`、2 ソケット競合、100 人組織、メール webhook の並行再配送。ESLint（`no-floating-promises` 相当の `eslint-plugin-promise`）、`tsc --checkJs` を JSDoc で段階導入
- **iOS**: `WebSocketService` / `GitHubService` / `DecisionCardService` にプロトコルを切りフェイク注入できるようにする。追加テスト = `DecisionCardService.resolve / delegate / acknowledge`、`AGUIEventAssembler`（スナップショット・delta add/replace/remove・RFC 6901・チャンク再結合・壊れたカードのスキップ・`/context/` の処理）、`OutboundEvent.envelope` と `SUBMIT_DECISION_SCHEMA` の契約テスト、`DecisionCard` の Worker フィクスチャデコード、`WebSocketService` のバックオフ上限・refused・connect-while-connected・アウトボックス順序、`OfflineRouter`、`FeedViewModel.refreshCards` のスクロール位置維持、`ContextInsights.parse`、`SessionStore` 往復。SwiftLint / SwiftFormat。`print` → `os.Logger`。`Text(String)` でカタログキーを描画している箇所を検出する lint スクリプト
- **CI**: push 時に iOS を `build-for-testing` だけ走らせ、PR で `test`。Release 構成のビルド検証を PR に追加。`PrivacyInfo.xcprivacy` がバンドルに入ることの検証。dependabot。`xcodebuild` の simulator 名を `simctl` から解決
- **AI 評価**: `worker/test/routing-eval.test.js` に 20 件の日英指示 × 期待受信者 / cardType のゴールデンセット（モデル応答は fetchMock で固定し、プロンプト変更で壊れたことを検知）

### 全体スケジュール（目安）

| 週 | 内容 | 出荷物 |
|---|---|---|
| 1 | Phase 0 → Phase 1-1, 1-5, 1-6 | Worker デプロイ + TestFlight（止血 + 通知型分離 + 配信絞り込み） |
| 2 | Phase 1-2, 1-3, 1-4/1-9, 1-7, 1-8 | Sent ビュー、委譲追跡、GitHub 同期拡大、リレー生成の応答カード、コンテキスト同期 |
| 3 | Phase 2-1, 2-2 | 編集可能な組織モデル、プロンプト再設計 |
| 4 | Phase 2-3, 2-4, 2-5 | 受信側 AI、7 操作、ゲスト整理 |
| 5 | Phase 3 | 運用堅牢化、削除完全化、マイグレーション |
| 6 | Phase 4 + 5 | push ON、TestFlight ワークフロー、レガシー削除、docs 同期、App Store 提出 |

合計 6 週前後。Phase 0 と Phase 1-1 / 1-5 / 1-6 だけなら 1 週で「安全に人に渡せる」状態になる。

---

## 5. 判断が必要なポイント

1. **GitHub 同期をサーバーに移すか**（1-9）。移せば I-2 が根本解決し Issue 作成が端末非依存になるが、リレーがユーザーの GitHub トークンで書き込む責務を持つ。推奨: 移す
2. **ゲストモードの存廃**（2-5）。推奨: 廃止し、審査用アカウントで代替
3. **メールコネクタを 1.0 に含めるか**（3-8, 4-7）。信頼モデルと Mailgun 運用が必要。推奨: 1.0 から外し、Gmail / Slack / Notion に絞る
4. **課金を 1.0 に含めるか**。RevenueCat 本番キー・審査用の IAP 設定・サーバー側 webhook が未整備。推奨: 1.0 は無料（200 回/日の上限のみ）、課金は 1.1
5. **識別子を `login` から数値 GitHub ID に移すか**。リネーム耐性のためには必要だが全テーブル・全クライアントに波及。推奨: Phase 3-6 で `users.login` UNIQUE + リネーム時に関連行を更新するトリガ的処理に留め、ID 移行は 2.0

---

## 6. 付録

### 6.1 検証で確認した数値

| 項目 | 値 |
|---|---|
| Worker テスト | 41 ファイル / 197 テスト / 21.8 秒 |
| server テスト | 11 |
| web-react | build 成功 / 7 テスト |
| iOS テスト | 15（CardCache 4, DecisionCard 6, Outbox 5） |
| Localizable.xcstrings | 391 キー / ja 391 |
| `String(localized:)` 使用箇所 | 208 |
| コミット済み秘密情報 | なし（RevenueCat Test Store 公開キーのみ） |

### 6.2 削除候補

`server/`（`agui/` 再エクスポート含む）、`web-react/`、`server/data/`、`scripts/device.sh`、`Config/Local.xcconfig` 機構、`routing.js` のデモ経路、`db.js: clearCards`、`agui/events.js: runFinished`、`routing.js: AGENT_TOOLS`、`orgs` テーブル、`agents` テーブル（読み手なし）、`docs/figma/*.js`（Figma 手作業用スクリプト。残すなら README で位置付けを明記）

### 6.3 docs 修正リスト

- `README.md`: テスト数 147→197、Legacy 節（CI との整合）、secrets 一覧
- `worker/README.md`: 「11 tests」、Phase 2/3 status 節の削除、ルート表の補完、Notion `name` の矛盾
- `docs/production-release-plan.md`: テスト数、P1-1 を `[~]`、P1-5 の主張、secrets 3→5、`/health` の記述、`apns.test.js` → `push.test.js`
- `onboarding.md`, `design.md`: 5 画面 / persona / DemoData の記述を 4 画面 + ゲストに更新
- `docs/agui-protocol.md`: `server/` パス、「iOS outbound は次」、MCP/Calendar の記述
- `docs/push-notifications.md`: 存在しない entitlements の「復元」→「作成」
- `docs/privacy-policy.md`: 「Account」→「You」
- `web-react/README.md`: 削除に伴い不要
