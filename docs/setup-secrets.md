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
