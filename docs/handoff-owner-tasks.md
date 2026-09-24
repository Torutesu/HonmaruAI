# オーナー作業の引き継ぎ指示（Codex / コンピューター操作エージェント向け）

コードは全部済んでいる。残っているのは、ダッシュボードにログインして値を取り、
秘密情報として入れる作業だけ。**上から順に**。各タスクは独立しているので、
途中で止まっても他は進められる。

前提：
- リポジトリ: https://github.com/Torutesu/HonmaruAI（ブランチ `main`、または
  `claude/eloquent-volta-s9mmfj` をマージ後）
- 手元に `node` 20+ と `git`。macOS のタスク（B, E）は Xcode 入りの Mac が必要
- 秘密情報は **絶対にチャット・コミット・スクリーンショットに残さない**。
  `npx wrangler secret put NAME` はプロンプトで値を求めるので、そこに貼って Enter
- 各タスクの最後に「確認」がある。確認が通るまで次に進まない

---

## A. Cloudflare の自動デプロイを動かす（15 分）

目的：`main` への push で Worker が自動デプロイされるようにする。
**（2026-09-22 時点で設定済み：直近の `main` で Deploy Worker は緑。以下は再設定用。）**

1. https://dash.cloudflare.com にログイン → 左メニュー **Workers & Pages** →
   右側 **Account details** の **Account ID**（32 桁の16進数）をコピー
2. https://dash.cloudflare.com/profile/api-tokens → **Create Token**
   → テンプレート **Edit Cloudflare Workers** の **Use template**
   → **Permissions** に 1 行追加：**Account / D1 / Edit**（既定行はそのまま）
   → **Account Resources** は自分のアカウント → **Continue to summary** → **Create Token**
   → 表示されたトークンをコピー（この画面を閉じると二度と見られない）
3. https://github.com/Torutesu/HonmaruAI/settings/secrets/actions → **New repository secret** を 2 回：
   - Name `CLOUDFLARE_API_TOKEN` / Value = 手順 2 のトークン
   - Name `CLOUDFLARE_ACCOUNT_ID` / Value = 手順 1 の Account ID
4. https://github.com/Torutesu/HonmaruAI/actions/workflows/deploy-worker.yml
   → **Run workflow** → branch は `main` のまま → **Run workflow**
5. 確認：そのランが緑になること。さらに
   ```bash
   curl -s https://tiktokforwork.torubj0904.workers.dev/health
   ```
   が JSON を返し、`"email": true` を含むこと（他の項目は次のタスクで true になる）。

---

## B. RevenueCat を本番キーに切り替える（30 分、Mac が必要）

目的：Release ビルドは今 RevenueCat の **Test Store キー**（`test_…`）を持っており、
アプリはそれを Release で拒否するので何も売れない。本番の公開キーに差し替える。

1. https://app.revenuecat.com にログイン → プロジェクト **Honmaru AI**
   → **Project settings → API keys**
   - **Public app-specific API key**（`appl_` で始まる、iOS 用）をコピー
   - **Secret API key**（`sk_` で始まる）もコピー（Worker 用。アプリには入れない）
2. リポジトリで `TikTokForWork/App/RevenueCatConfig.swift` を開き、
   ```swift
   static let apiKey = "test_aOieMtugDnVbuliAwBJkfQKazZd"
   ```
   の値を手順 1 の `appl_…` キーに置き換える（公開キーなのでコミットしてよい）
3. 同じ RevenueCat 画面で以下を確認する（無ければ作る。`docs/revenuecat.md` 3 章参照）：
   - Entitlement の identifier がちょうど `honmaruai Pro`
   - Products `yearly` と `monthly` がその Entitlement に紐づいている
   - Offering `default` が current で、両 product が package として入っている
4. App Store Connect（https://appstoreconnect.apple.com）→ アプリ **Honmaru AI**
   → **Subscriptions**：`yearly` と `monthly` が同じ Subscription Group にあり、
   価格・表示名・審査用スクリーンショットが入っていて状態が **Ready to Submit**
   であること。**Agreements, Tax, and Banking** で Paid Apps 契約が有効であること
5. Worker 側の秘密鍵（これが課金のスイッチ。入れた瞬間から無料枠が 1 日 3 回に絞られる）：
   ```bash
   cd HonmaruAI/worker
   npx wrangler login
   npx wrangler secret put REVENUECAT_SECRET_KEY   # 手順 1 の sk_… を貼る
   ```
6. 確認：
   - `git diff` に `appl_` の行だけが出ること。コミットして push
   - 実機（Sandbox Apple ID を Settings → App Store → Sandbox Account に入れたもの）で
     TestFlight ビルドを入れ、**You → Plan → Upgrade to Pro** で Apple の購入シートが
     出て、購入後に Plan 画面が Pro 表示になること。**Restore purchases** も通ること

---

## C. APNs（iOS プッシュ通知）を有効にする（30 分、Mac が必要）

目的：サーバー側の 4 つの秘密は設定済み。残りは App ID の capability、
プロファイルの再発行、アプリ側の定数。**順番厳守**：先に capability を付けないと
ビルドが署名できなくなる。

1. https://developer.apple.com/account/resources/identifiers/list → App ID
   `com.honmaru.ai` → **Push Notifications** にチェック → **Save**
2. プロビジョニングプロファイルを再発行（`asc` CLI。`docs/app-store-release.md` 1 章で
   セットアップ済みの前提）：
   ```bash
   cd HonmaruAI
   asc profiles list --output table            # "HonmaruAI AppStore" の id を控える
   asc profiles delete --id <OLD_PROFILE_ID>
   asc bundle-ids list --output table          # com.honmaru.ai の id
   asc certificates list --output table        # IOS_DISTRIBUTION の id
   asc profiles create --name "HonmaruAI AppStore" --profile-type IOS_APP_STORE \
     --bundle <BUNDLE_ID> --certificate <CERT_ID>
   asc profiles download --id <PROFILE_ID> \
     --output ~/Library/MobileDevice/Provisioning\ Profiles/<PROFILE_UUID>.mobileprovision
   ```
3. `project.yml` の `TikTokForWork` ターゲットに 2 か所追加：
   ```yaml
       entitlements:
         path: TikTokForWork/HonmaruAI.entitlements
       sources:
         - path: TikTokForWork
           excludes:
             - PrivacyInfo.xcprivacy
             - HonmaruAI.entitlements
   ```
   （`TikTokForWork/HonmaruAI.entitlements` は既にあり `aps-environment = development`。
   そのままでよい。Apple が配布時に production に書き換える）
4. `TikTokForWork/Services/PushService.swift` の
   `static let isEnabledInThisBuild = false` を `true` にする
5. Worker の環境を確認・設定：
   ```bash
   cd worker
   npx wrangler secret put APNS_ENVIRONMENT   # production と入力（TestFlight/App Store 用）
   curl -s https://tiktokforwork.torubj0904.workers.dev/health   # "push": true を確認
   ```
6. 確認：
   ```bash
   xcodegen generate
   scripts/smoke-release.sh        # Release ビルドが起動し fatal なしで通ること
   scripts/release.sh testflight
   ```
   TestFlight ビルドを実機で開くと通知許可のダイアログが出る。許可し、別アカウントから
   自分宛の決定を送って通知が届くこと。手順 3・4 は**同じコミット**で push する

---

## D. 受信メール（Mailgun）を接続する（20 分）

目的：`u-<id>@<ドメイン>` 宛のメールが判断カードになる機能。Worker 側は完成しており、
Mailgun のドメインと 2 つの秘密だけが無い。

1. https://app.mailgun.com にログイン → **Sending → Domains → Add New Domain**
   → 受信専用のサブドメイン（例 `in.honmaru.ai`）を追加 → 表示される DNS レコード
   （MX 2 本、TXT の SPF、DKIM）をドメインの DNS に追加 → **Verify** が緑になるまで待つ
2. **Receiving → Create Route**：
   - Expression Type: **Match Recipient**、Recipient: `.*@in.honmaru.ai`（自分のサブドメイン）
   - Actions: **Forward** にチェックし URL に
     `https://tiktokforwork.torubj0904.workers.dev/webhooks/email` を入力
   - **Store and notify** は不要。Priority 0 → **Create Route**
3. **Settings（左下の歯車）→ API Security → HTTP webhook signing key** をコピー
4. Worker に入れる：
   ```bash
   cd HonmaruAI/worker
   npx wrangler secret put MAILGUN_WEBHOOK_SIGNING_KEY   # 手順 3 の値
   npx wrangler secret put INBOUND_EMAIL_DOMAIN          # in.honmaru.ai（@ なし）
   ```
5. 確認：Web クライアントか iOS の **Tools** 画面に「Forward anything here」の行と
   自分専用アドレス（`u-…@in.honmaru.ai`）が出る。そこに件名「承認お願いします：来週の
   仕入価格」のメールを送ると、1 分以内に自分のフィードにカードが出る。出なければ
   ```bash
   npx -y wrangler@4 tail --format pretty
   ```
   で `webhooks/email` の行を見る（署名不一致なら手順 3 の値が違う）

---

## E. App Store 初回提出（1〜2 時間、Mac が必要。A〜C の後）

**近道（2026-09-23）**：TestFlight ワークフローが要る 7 つのシークレットは、
App Store Connect の API キー 1 つから `scripts/testflight-secrets.sh` が全部
作って入れます（配布証明書・プロファイルの発行、`gh secret set`、`--run 1.0.1`
でワークフロー起動まで）。ブラウザでしかできない部分の指示文は
[handoff-computer-use.md](handoff-computer-use.md) にあります。


`docs/app-store-release.md` に沿う。`asc` CLI と `.asc.env` の設定は同ドキュメント 1 章。

1. 事前確認（すべて緑になるまで先に進まない）：
   ```bash
   cd HonmaruAI
   (cd worker && npm test)          # 472+ tests
   xcodegen generate
   xcodebuild test -project TikTokForWork.xcodeproj -scheme TikTokForWork \
     -destination 'platform=iOS Simulator,name=iPhone 16' CODE_SIGNING_ALLOWED=NO
   scripts/smoke-release.sh
   scripts/release.sh doctor        # asc auth / review doctor が clean
   ```
2. メタデータとスクリーンショット：
   ```bash
   scripts/release.sh metadata 1.0.0     # 初回は ./metadata を生成する
   ```
   生成された説明文・キーワード・サポート URL（https://honmaru.ai/support 相当）・
   プライバシーポリシー URL（`docs/privacy-policy.md` を公開した URL）を埋め、
   iPhone 6.7" と 6.1" のスクリーンショットを `./screenshots` に置いてコミット
3. App Store Connect で：
   - **App Privacy** の質問に答える（収集するデータ：メールアドレス、ユーザーコンテンツ。
     トラッキングなし。`TikTokForWork/PrivacyInfo.xcprivacy` と一致させる）
   - **App Review Information** に審査用アカウント：メール `review@honmaru.ai` 相当と
     パスワード（アプリの「Use a password instead」で入れる）。`docs/app-store-review-readiness.md` 参照
   - 年齢制限、価格（無料 + アプリ内課金）、カテゴリ **Business**
4. 提出：
   ```bash
   scripts/release.sh all 1.0.0 --dry-run   # まず全コマンドを目視
   scripts/release.sh all 1.0.0             # build → upload → metadata → submit。各段で y
   ```
5. 確認：`scripts/release.sh status` が **Waiting for Review** を示す。以後は
   同コマンドで進捗を追う

---

## F. Composio の返信スコープを有効にする（15 分）

決定後の「返信を下書き」→「Gmail で送る / Slack で送る」は、Composio 経由で
`GMAIL_REPLY_TO_THREAD` と `SLACK_SEND_MESSAGE` を呼びます。読み取り用に作った
auth config に送信権限が無いと、Worker は 502 で「Gmail did not take the
reply」と返し、画面はコピーして手で送るよう案内します。

1. https://app.composio.dev にログインし、Auth Configs を開く。
2. Gmail の auth config（ID は `worker/src/connectors/gmail.js` の
   `authConfigId`）を開き、scopes に `https://www.googleapis.com/auth/gmail.send`
   が含まれているか確認。無ければ追加して保存。
3. Slack の auth config（`worker/src/connectors/slack.js`）の scopes に
   `chat:write` を追加して保存。
4. 既に接続済みのアカウントはスコープが古いままなので、アプリの
   Tools 画面から Gmail / Slack を一度切断して再接続する。
5. 確認: Gmail から作られたカードを決定し、History（Web）または
   カード詳細（iPhone）で「返信を下書き」→「Gmail で送る」。送信元スレッドに
   返信が付き、画面に「Gmail で送りました。」と出れば完了。

## G. ステージング環境を作る（15 分、A の後）

本番に触らずに試すための 2 つ目の Worker。コードと定義（`worker/wrangler.toml`
の `[env.staging]`、Deploy Worker の environment 入力）は入っています。無いのは
Cloudflare 側のリソース 2 つと、その ID の貼り付けです。

1. ターミナルで `cd worker && npx wrangler@4 login`（ブラウザで許可）。
2. `npx wrangler@4 d1 create tiktokforwork-staging` を実行し、出力の
   `database_id`（UUID）をコピー。
3. `worker/wrangler.toml` を開き、`[[env.staging.d1_databases]]` の
   `database_id = "00000000-0000-0000-0000-000000000000"` をその UUID に置き換えて保存。
4. `npx wrangler@4 r2 bucket create tiktokforwork-media-staging`。
5. 本番に入れたシークレットを `--env staging` 付きでもう一度
   （`npx wrangler@4 secret put OPENAI_API_KEY --env staging` など、
   docs/setup-secrets.md 4.5 の一覧）。
6. 3 の変更をコミットして `main` に入れ、`staging` ブランチを `main` から切って push。
   GitHub の Actions → Deploy Worker が staging に出ることを確認。
7. Cloudflare Pages の Settings → Environment variables → Preview に
   `VITE_API_HOST = tiktokforwork-staging.torubj0904.workers.dev` を追加。
8. 確認: `https://tiktokforwork-staging.torubj0904.workers.dev/health` が
   `{"ok":true…}` を返す。

## H. Jev（TypeSafe）の鍵を入れて原価を下げる（10 分）

コードは入っています。鍵が無いだけです。

**ターミナル無しでもできます**：Web の **ツール → あなたの AI** で、ワークスペースの
管理者が言語モデルを選び、OpenAI キーと TypeSafe キーを入力できます（そのワーク
スペースだけに効き、鍵は画面に戻りません。末尾 4 文字だけ表示）。全ワークスペース
共通の既定値にしたいときだけ、下の手順で Worker シークレットに入れてください。

1. https://console.typesafe.ai でアカウントを作り、API キーを発行。
2. ターミナルで `cd worker && TYPESAFE_API_KEY=<キー> npm run eval:jev` を実行し、
   表の `recipientUserID` の行（宛先精度）と、最後の `routed by:` /
   `jev input tokens:` の行をメモ。宛先精度が 90% 未満なら
   `OPENAI_API_KEY` も付けて `npm run eval:jev:model` を実行し、同じ行をメモ。
3. `npx wrangler@4 secret put TYPESAFE_API_KEY` でキーを Worker に入れる
   （staging があれば `--env staging` でも）。
4. 確認: `https://tiktokforwork.torubj0904.workers.dev/health` の
   `systemOne` が `true`。アプリから 1 件ルーティングし、カードの
   「決定の理由」に「Your AI is NN% sure…」が出れば Jev が動いています。
5. 2 でメモした数字を報告してください。閾値（`CONFIDENT`）の調整判断に使います。

## H2. GitHub をワークスペースにつなぐ（画面から・2 分）

**ツール → GitHub → 接続する** で、管理者がリポジトリ（`owner/repo`）を指定して
つなぎます。GitHub でサインインしていれば 1 タップ（自分のトークンで）、メールで
サインインしている場合は Issues: read/write の fine-grained トークンを入力。
以後、そのワークスペースの決定はすべて Worker が Issue として立て、却下・完了で
閉じます（誰が決めても、どの端末からでも）。トークンは画面に戻りません。

## I. Web の GitHub サインインを有効にする（5 分、A の後）

1. GitHub → Settings → Developer settings → OAuth Apps → 使っているアプリを開く。
2. Authorization callback URL に Web の URL（`https://<Pages のホスト>/`、末尾の `/` まで）を追加して保存。
3. `cd worker && npx wrangler@4 secret put GITHUB_WEB_REDIRECT_URI` に同じ URL を入れる。
4. 確認: Web を開き「GitHub で続ける」→ GitHub で許可 → リポジトリ一覧から 1 つ選ぶ → フィードが開く。
   Tools の GitHub 行が「Built in」になっていれば完了。

## J. チームと招待を本番で使えるようにする（5 分、A の後）

チームは名前をつけて作れるようになり（You → **チームを作成**、Team 画面の
**名前を変更**）、招待は **3 日間有効のリンク** です（画面から作る、またはメールで
送る。コードは表示しません。リンクを貼り付ければコードとして読みます）。
リンクとメールの中のリンクは Web の URL から組み立てるので、Worker が自分の
Web アドレスを知っている必要があります。

1. Web を Pages に出していなければ `./web-react/scripts/deploy-pages.sh`（4 章）。
2. `cd worker && npx wrangler@4 secret put APP_WEB_URL` に Pages の URL
   （例 `https://honmaru-web.pages.dev`）。通知のリンク先にもなります。
3. 確認：`curl -s https://tiktokforwork.torubj0904.workers.dev/health` が
   `"inviteLinks": true` を返す。Team 画面で **招待リンクを作成** すると
   `…/#/join/<code>` のリンクと **リンクをコピー / 共有** が出る（3 日で失効）。
4. メール招待は Resend（`RESEND_API_KEY`）が入っていれば動きます。共有送信元
   （`onboarding@resend.dev`）のままだと Resend アカウントの持ち主宛にしか届かない
   ので、他の人を招待するには `NOTIFY_EMAIL_FROM` に検証済みドメインの From を入れる
   （docs/setup-secrets.md 2 章）。

受け取った側：リンクを開くと、サインイン済みならそのチームに参加してフィードが
開く。未サインインなら「{招待者}さんが{チーム}に招待しています」と出た
サインアップ画面にコードが入った状態で始まり、アカウントを作るとそのチームに入る。
iPhone アプリの You → Team には **招待リンクを作成 / 共有 / コピー**（Web の URL が
ある場合）と **チームを作成** が並び、**招待リンク** を貼り付けて参加できます。
役割は招待された本人が You → **あなたの働き方**（iPhone）/ You → 役割（Web）で
自由な言葉に変えられます（admin などの権限語は不可。権限は変わりません）。

---

## K. このブランチをリリースする（30 分）

`claude/eloquent-volta-s9mmfj` には、Web のワークベンチ・⌘K・音声入力・
オフライン、Jev による分類、翻訳、Notion/GitHub コンテキスト、Web の GitHub
サインイン、チーム作成と招待、そして 2 回の QA パスが入っています。`main` の
Figma ネイティブ UI（#44, #45）はマージ済みです。

1. PR を作って `main` にマージする。マージで **Deploy Worker** が動き、D1 の
   マイグレーションと Worker のデプロイまで自動（A は設定済み — 直近の main で緑）。
   ランが緑で `/health` が `"ok": true` を返せば Worker は本番。
2. Web：`./web-react/scripts/deploy-pages.sh`（Pages への手動デプロイ。Pages に
   GitHub 連携をしているなら main へのマージで自動）。
3. 新しい Worker シークレット（任意）：`TYPESAFE_API_KEY`（H）、
   `GITHUB_WEB_REDIRECT_URI`（I）、`APP_WEB_URL`（J）。どれも無ければその機能が
   静かに無いだけで、他は動きます。
4. iPhone：`main` で **TestFlight** ワークフローを実行（`testflight.yml`）。
   ネイティブ UI 1.0.1 のビルドに、本ブランチの Ask / 下書き / 送信 / Insights /
   翻訳 / チームが乗ります。
5. App Store 提出は E の手順のまま。

## 本番で「各自のユーザー」が使える状態か（2026-09-24 時点）

`/health` が返す実際の設定値で確認済み：

| 項目 | 状態 | 誰でも使えるか |
|------|------|----------------|
| メール（サインインコード・通知・招待） | `mailSender: verified` — 検証済みドメインから送信 | **はい**。誰のアドレスにも届く |
| サインアップ／サインイン（Web） | メールのコード、またはパスワード | **はい** |
| AI ルーティング | `aiRouting: true`（gpt-4o-mini） | **はい** |
| 課金（RevenueCat） | `billing: true` → 無料枠は 1 日 3 件 | 無料枠を超えるとローカルのルーターに落ちる。**ワークスペース自前の OpenAI キー**（ツール → あなたの AI）を入れると無制限・自社請求 |
| Gmail / Slack / Notion / Calendar / Drive | `connectors: true`（Composio） | **はい**。各自がツール画面から接続 |
| GitHub | ワークスペース単位で接続（ツール → GitHub） | **はい**（トークン or GitHub サインイン） |
| プッシュ／Web プッシュ | `push: true`, `webPush: true` | **はい** |
| 招待リンク（3 日） | `inviteLinks: true` | **はい** |
| Jev（System One） | `systemOne: false` | 任意。ツール画面から TypeSafe キーを入れれば ON |
| Web の GitHub サインイン | `githubOAuthWeb: false` | **オーナー作業**（I 章）。それまで Web はメールでサインイン |
| iPhone アプリの配布 | TestFlight 未設定 | **オーナー作業**（E 章、Mac と署名シークレットが必要） |

つまり Web（https://honmaru-web.pages.dev）は、誰でもアカウントを作り、チームを
作って招待し、ツールをつなぎ、決定を回せる状態です。残りはオーナーにしかできない
2 点（Web の GitHub サインインの callback 登録、TestFlight の署名）だけです。

## 完了の定義

- `curl -s https://tiktokforwork.torubj0904.workers.dev/health` が
  `push`, `webPush`, `email`, `inviteLinks` をすべて `true` で返す
- GitHub Actions の **Deploy Worker** が最新の `main` で緑
- TestFlight の実機で：購入シートが出る／通知が届く／転送メールがカードになる
- App Store Connect のステータスが **Waiting for Review** 以降
