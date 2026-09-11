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

目的：`main` への push で Worker が自動デプロイされるようにする。今は
`Deploy Worker` ワークフローが "Check credentials" で止まっている。

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

`docs/app-store-release.md` に沿う。`asc` CLI と `.asc.env` の設定は同ドキュメント 1 章。

1. 事前確認（すべて緑になるまで先に進まない）：
   ```bash
   cd HonmaruAI
   (cd worker && npm test)          # 404 tests
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

## 完了の定義

- `curl -s https://tiktokforwork.torubj0904.workers.dev/health` が
  `push`, `webPush`, `email` をすべて `true` で返す
- GitHub Actions の **Deploy Worker** が最新の `main` で緑
- TestFlight の実機で：購入シートが出る／通知が届く／転送メールがカードになる
- App Store Connect のステータスが **Waiting for Review** 以降
