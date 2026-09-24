# セットアップ手順：デプロイと通知の秘密情報

main にマージされたコードを本番に出し、通知の各経路を有効にするまでの手順。
所要時間はおよそ 30 分。必要なのは Cloudflare、Resend、GitHub の各アカウントと、
`node` が入った手元の端末。どれも無料枠で足りる。

順番どおりに進めば、最後に `GET /health` がすべて `true` を返す。

> **いまの本番は古い。** `curl https://tiktokforwork.torubj0904.workers.dev/health`
> の応答に `push` / `webPush` / `email` が無い。これは APNs 対応より前のコードが
> 動いているということで、main にマージされたものが一度も本番に出ていない。
> 原因は下の段階 1 だけ——デプロイのワークフローが資格情報が無くて毎回止まっている。

---

## 最短：いますぐ本番に出す

GitHub の Secrets は要らない。手元から直接デプロイできる。**この順番で。**
秘密情報を先に入れても効かない——動いている Worker が古いコードで、VAPID も
メールも読まないため。コードを出してから入れる。

```bash
git clone https://github.com/Torutesu/HonmaruAI
cd HonmaruAI
npx wrangler login
./worker/scripts/deploy-local.sh
./worker/scripts/setup-secrets.sh
```

`deploy-local.sh` はデプロイのワークフローと同じ 4 つを同じ順でやる。テスト、
D1 のマイグレーション、デプロイ、`/health` の確認。マイグレーションが本当に
失敗したらデプロイせずに止まる。`setup-secrets.sh` は VAPID を生成して
そのまま Cloudflare に渡すので、秘密鍵は画面にもシェル履歴にも残らない。

これで本番は最新になる。以降の段階 1 は、**次から main への push で自動的に
デプロイされるようにする**ための設定で、急がなくてよい。

---

| 段階 | 何が動くようになるか | 必要なもの |
|------|---------------------|-----------|
| 1. Cloudflare | main への push で Worker が自動デプロイされる | API トークン、アカウント ID |
| 2. Web Push | ブラウザ・Android・ホーム画面に追加した iPhone に通知が届く | VAPID 鍵ペア（自分で生成） |
| 3. メール | プッシュがどこにも届かない人にメールが届く。GitHub を持たない人のログイン口が開く | Resend の API キー 1 本 |
| 4. Web クライアント | フィードを URL で開ける。通知タップやメールのリンク先になる | Cloudflare Pages |
| 5. 確認 | | |

`npx wrangler secret put NAME` は値の入力を促してくるので、そこに貼り付けて Enter。
値はリポジトリにもチャットにも残さない。

---

## 0. 手元の準備（一度だけ）

```bash
git clone https://github.com/Torutesu/HonmaruAI && cd HonmaruAI/worker
npm ci
npx wrangler login        # ブラウザが開く。Cloudflare にログインして許可
npx wrangler whoami       # アカウント名と Account ID が出れば OK
```

---

## 1. Cloudflare：自動デプロイを動かす

main への push で `.github/workflows/deploy-worker.yml` が走るが、いまは
「Check credentials」で止まっている。GitHub のリポジトリ Secrets に 2 つ入れる。

### 1-a. Account ID を取る

- https://dash.cloudflare.com → 左メニュー **Workers & Pages** → 右側の
  **Account details** に **Account ID**（32 桁の16進数）。
- または `npx wrangler whoami` の出力にも出る。

### 1-b. API トークンを作る

1. https://dash.cloudflare.com/profile/api-tokens → **Create Token**
2. テンプレート **Edit Cloudflare Workers** の **Use template**
3. **Permissions** に 1 行追加：**Account** / **D1** / **Edit**
   （既定の Workers Scripts:Edit などはそのまま）
4. **Account Resources** は自分のアカウント、**Zone Resources** はそのまま
5. **Continue to summary** → **Create Token**
6. 表示されたトークンをコピー。**この画面を閉じると二度と見られない**。

### 1-c. GitHub に入れる

https://github.com/Torutesu/HonmaruAI/settings/secrets/actions → **New repository secret**

| Name | Value |
|------|-------|
| `CLOUDFLARE_API_TOKEN` | 1-b で作ったトークン |
| `CLOUDFLARE_ACCOUNT_ID` | 1-a の Account ID |

### 1-d. 走らせる

https://github.com/Torutesu/HonmaruAI/actions/workflows/deploy-worker.yml →
**Run workflow** → main のまま **Run workflow**。

テスト → D1 マイグレーション（`schema.sql` と `migrations.sql`）→ デプロイ →
`/health` 確認の順に流れる。以後は main に push するたびに自動で走る。

手元から出す場合は同じことを自分で：

```bash
cd worker
npx -y wrangler@4 d1 execute tiktokforwork --remote --file schema.sql --yes
npx -y wrangler@4 d1 execute tiktokforwork --remote --command "ALTER TABLE users ADD COLUMN notify_email INTEGER NOT NULL DEFAULT 1"
npx wrangler deploy
```

（2 行目は既に列がある DB では "duplicate column name" で失敗する。それは適用済みの印で、無視してよい。）

---

## 1-e. Web でも GitHub サインイン（5 分）

iPhone と同じ GitHub OAuth App に、Web 用のコールバックをもう 1 つ登録します。

1. GitHub → Settings → Developer settings → OAuth Apps → 該当アプリ →
   **Authorization callback URL** に Web の URL（例 `https://honmaru.pages.dev/`、末尾スラッシュまで）を追加。
   GitHub は 1 アプリに複数のコールバック URL を許します。
2. Worker に同じ値を入れる: `npx wrangler@4 secret put GITHUB_WEB_REDIRECT_URI`
   （staging があれば `--env staging` でプレビューの URL）。
3. 確認: `/health` の `githubOAuthWeb` が `true`、Web の最初の画面に
   「GitHub で続ける」が出る。サインイン後は書き込みできるリポジトリを選ぶ画面になり、
   選んだリポジトリがワークスペース（Issue 作成と GitHub 検索が使える）になります。

## 2〜3 をまとめてやる場合（手動でやる場合の説明は下）

段階 1 を終えて `npx wrangler login` が済んでいれば、2 と 3 と 4 の秘密情報は
1 本のスクリプトで入れられる。VAPID の秘密鍵は生成してそのまま Cloudflare に
渡すので、画面にもシェル履歴にも残らない。空欄で飛ばせるので、あとから 1 つ
だけ足すときにも使える。

```bash
./worker/scripts/setup-secrets.sh
```

最後に `/health` を叩いて、いま何が有効かを表示する。以下は同じことを手でやる場合の説明。

---

## 2. Web Push：VAPID 鍵

鍵は自分で作る。どこかから取得するものではない。

```bash
cd worker
node scripts/vapid-keys.mjs
```

3 行出る。上 2 行はそのまま、3 行目は自分の連絡先に書き換えて入れる：

```bash
npx wrangler secret put VAPID_PUBLIC_KEY     # 出力の 1 行目の値を貼る
npx wrangler secret put VAPID_PRIVATE_KEY    # 2 行目の値
npx wrangler secret put VAPID_SUBJECT        # mailto:you@example.com（プッシュサービスが問題時に連絡する先）
```

秘密鍵は Cloudflare 以外に置かない。公開鍵はブラウザに渡すもので、秘密ではない。
鍵を作り直すと既存の購読は全部無効になり、各ブラウザで再度「通知をオン」が必要になる。

---

## 3. メール：Resend

送信は Resend 一本。**API キー 1 本だけで、ドメインも DNS レコードも要らない。**
無料枠が「試用期間」ではなく無料枠なのが選んだ理由で、通知のフォールバックと
ログインコードという「製品そのものではない」チャンネルにはこの形が合う。

### 3-a. API キー

1. https://resend.com でアカウント作成
2. **API Keys → Create API Key**。`re_` で始まる文字列を一度だけ表示するので
   その場でコピー

ドメインの検証は**しなくていい**。未検証のうちは Resend の共有送信元
（`onboarding@resend.dev`）で送ることになり、その場合 **Resend アカウントの
持ち主のアドレスにしか届かない**。動作確認にはそれで足りる。

### 3-b. Worker に入れる

```bash
cd worker
npx wrangler secret put RESEND_API_KEY      # 3-a のキー
npx wrangler secret put NOTIFY_EMAIL_FROM   # 任意。例: Honmaru AI <no-reply@example.com>
```

`NOTIFY_EMAIL_FROM` は、Resend でドメインを検証して**他の人にも届けたく
なったとき**に入れる。それまでは未設定のままでいい。

誰に届くか：メールでサインアップした人はその住所へ。GitHub でサインインした人は
Web の **You → 通知 → Where it goes** に住所を入れたときだけ。送るのはプッシュが
どこにも届かなかったときだけ。

### 3-c. 受信は別の話

メールを Worker に流し込む webhook（届いたメールが決定カードになるほう）は
Mailgun のままで、`MAILGUN_WEBHOOK_SIGNING_KEY` と `INBOUND_EMAIL_DOMAIN` を使う。
送信とは別の機能・別の秘密で、Resend への切り替えとは関係しない。今回の範囲外
（`PROGRESS.md` 参照）。

### 3-d. まとめて 1 コマンドで

秘密を入れるのは簡単なほうで、難しいのは「本当に送れているか」。鍵が違う・
From ドメインが未検証・宛先が共有送信元では届かないアドレス、のどれも外からは
同じ（何も届かない）に見えるので、最後に本物の往復をして結果を出す。

```bash
./worker/scripts/setup-email.sh
```

Resend の鍵を入れる → デプロイ（コードを送るエンドポイントと `login_codes`
テーブルはデプロイされて初めて存在する）→ `/health` を見て → 指定した宛先に
実際にサインインコードを送る。502 が返れば Resend が拒否していて、理由は
`npx -y wrangler@4 tail --format pretty` にそのまま出る。

> **メールでのログインもここに乗っている。**
> 「6桁のコードをメールで送る」サインイン（`POST /auth/otp/request`）は
> 送信手段が無いと 503 を返す。返された側はパスワード欄に切り替わって理由を
> 出すので壊れはしない — が、GitHub を持っていない人にとっては、`RESEND_API_KEY`
> を入れて初めて入口が開く。`/health` の `"email": true` が入っている証拠。

---

## 4. Web クライアントを置く

`web-react/` は静的サイト。Cloudflare Pages が同じアカウントで済んで楽。

```bash
./web-react/scripts/deploy-pages.sh
```

接続先を聞いて、ビルドして、Pages に出して、最後に `APP_WEB_URL` を Worker に
入れるところまでやる。**接続先はビルド時に埋め込まれる**——サインイン画面に
それを直す欄は無いので、忘れたページは `localhost` を見に行って何も繋がらない。
スクリプトはビルド後に実際にバンドルの中を見て、入っていなければ止まる。

以下は同じことを手でやる場合。

```bash
cd web-react
npm ci
VITE_API_HOST=tiktokforwork.torubj0904.workers.dev npm run build
npx wrangler pages deploy dist --project-name honmaru-web
```

初回は「Create a new project?」に **y**。最後に `https://honmaru-web.pages.dev` のような
URL が出る。これが Web 版の入口で、iPhone なら Safari で開いて
**共有 → ホーム画面に追加** すると通知が受けられる。

その URL を Worker に教えると、通知をタップしたときとメールのリンクがそこに向く：

```bash
cd ../worker
npx wrangler secret put APP_WEB_URL          # 例: https://honmaru-web.pages.dev
```

`VITE_API_HOST` はホスト名だけ（`https://` なし）。ページは自分のスキームから
https/wss を組み立てる。

---

## 4.3c. ワークスペースごとの AI 設定（画面から・2 分）

Web の **ツール → あなたの AI** で、そのワークスペースの管理者が：

- 言語モデルを選ぶ（gpt-4o-mini / gpt-4.1-nano / gpt-4.1-mini / gpt-4o / gpt-4.1 /
  gpt-5-mini / gpt-5-nano。100 万トークンあたりの単価つき）
- ワークスペース用の OpenAI キーを入れる（そのチームの請求になり、台帳では
  「自前」として原価から外れる）
- TypeSafe キーを入れて Jev をオンにする

優先順位は「本人のキー（ブラウザ/端末に保存、`x-ai-key`）＞ ワークスペースの
キー ＞ Worker シークレット」。設定は D1 の `org_ai_settings` にワークスペース
単位で保存され、API（`GET/PUT /orgs/ai`）は鍵を返しません（末尾 4 文字のみ）。
Worker シークレットは「何も設定していないワークスペースの既定値」になります。

## 4.4. Jev（TypeSafe）で判断コストを下げる（任意・10 分）

ルーティングで払っている LLM 代のほとんどは「文章を書く」ではなく「決める」
（誰宛か・種類・優先度・どの事業か）に使われています。Jev はその判断だけを
型付きの答え＋確信度で返すモデルで、入力 100 万トークン $0.042、出力は無料
（gpt-4o-mini は入力 $0.15・出力 $0.60）。鍵を入れると Worker は
「Jev が決め、カードの言葉は手元のルーターが書き、Jev が迷ったときだけ LLM に
聞く」動きになります。同期の「この受信メールは判断が要るか」も Jev が先に
答えるので、ほとんどのメール（＝要らない）が LLM を通らなくなります。

```bash
# 鍵は https://console.typesafe.ai で発行
cd worker
npx wrangler@4 secret put TYPESAFE_API_KEY
# 任意: TYPESAFE_MODEL（既定 jev-latest）、TYPESAFE_ENDPOINT
```

入れる前に精度を見るなら、ゴールデンセットで:

```bash
TYPESAFE_API_KEY=... npm run eval:jev            # Jev だけ
TYPESAFE_API_KEY=... OPENAI_API_KEY=... npm run eval:jev:model   # 迷ったら LLM
```

表の下に「routed by: jev N, OpenAI M」と Jev のトークン数・概算ドルが出ます。
宛先精度の gate は `--gate 0.9` で同じように掛けられます。日本語は「対応して
いるが英語ほどではない」と公式に書かれているので、日本語の項目の宛先精度を
先に見てください。確信度の閾値は `worker/src/jev.js` の `CONFIDENT`（0.6）。

## 4.5. 運用アラート（任意だが推奨）

未ハンドルの 500 と定期同期の失敗を、Slack の incoming webhook などに
`{ text }` で POST する。未設定なら何もしない。同種のアラートは 1 分に
1 回までに間引かれる。

```bash
npx wrangler secret put ALERT_WEBHOOK_URL    # https://hooks.slack.com/services/... など
```

Slack ならワークスペースの App 管理 → Incoming Webhooks で URL を発行するだけ。
リクエストを遅らせないよう `waitUntil` で送るので、応答速度への影響はない。

---

## 4.6 ステージング（任意・15 分）

本番と同じ Worker を `tiktokforwork-staging` という別名で動かし、リレー・D1・R2 を
分けます。`worker/wrangler.toml` の `[env.staging]` がその定義です。
`staging` ブランチに push すると **Deploy Worker** がこちらに出します
（Actions から手動で environment=staging を選んでも同じ）。

```bash
cd worker
npx wrangler@4 d1 create tiktokforwork-staging
#   → 出力の database_id を wrangler.toml の [env.staging] の
#     database_id（全部ゼロのプレースホルダ）に貼る
npx wrangler@4 r2 bucket create tiktokforwork-media-staging
# シークレットは環境ごと。本番と同じ名前を --env staging で入れる
npx wrangler@4 secret put OPENAI_API_KEY --env staging
npx wrangler@4 secret put RESEND_API_KEY --env staging
npx wrangler@4 secret put COMPOSIO_API_KEY --env staging
```

Web 側は Cloudflare Pages のブランチプレビューをそのまま使います。Pages の
Settings → Environment variables → **Preview** に
`VITE_API_HOST=tiktokforwork-staging.torubj0904.workers.dev` を入れると、
`main` 以外のブランチのプレビュー URL がステージング Worker を向きます
（Production はそのまま本番 Worker）。

プレースホルダのままだと Deploy Worker は staging を出さずに止まります
（「Staging has no database yet」）。

## 5. 確認

```bash
curl -s https://tiktokforwork.torubj0904.workers.dev/health
```

```json
{ "ok": true, "aiRouting": true, "push": false, "webPush": true, "email": true, ... }
```

- `webPush: true` … VAPID 3 つが入っている
- `email: true` … `RESEND_API_KEY` が入っている
- `push` は iOS の APNs。Apple 側の作業が別途要る（`docs/push-notifications.md`）。当面 false でよい
- `aiRouting: true` … `OPENAI_API_KEY` が入っている（翻訳と事業の振り分けもこれを使う）

Web を開いて右上のベルを押し、ブラウザの許可を出す。別のアカウントから
「AIに伝える」で自分宛ての決定を作り、タブを閉じた状態で通知が来れば完成。

## つまずいたら

| 症状 | 見るところ |
|------|-----------|
| Deploy Worker が Check credentials で止まる | 1-c の 2 つの名前が正確か（大文字・アンダースコア） |
| `d1 execute` が 7403 "not authorized" | wrangler 3 のバグ。`npx -y wrangler@4` を使う |
| `/health` が `webPush: false` | `npx wrangler secret list` で 3 つとも並んでいるか |
| ベルを押しても何も起きない（iPhone） | Safari のタブではなくホーム画面から開いているか |
| メールが来ない | 相手に住所があるか、`notifyEmail` がオンか、宛先が共有送信元でも届くアドレス（＝Resend アカウントの持ち主）か。拒否理由は `npx -y wrangler@4 tail --format pretty` にそのまま出る |
| 通知の言語が違う | Web の ⋯ → Language、iOS は You → Language。`GET /me` の `locale` が真実 |
