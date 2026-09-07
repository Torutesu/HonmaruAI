# セットアップ手順：デプロイと通知の秘密情報

main にマージされたコードを本番に出し、通知の各経路を有効にするまでの手順。
所要時間はおよそ 30 分。必要なのは Cloudflare、Mailgun、GitHub の各アカウントと、
`node` が入った手元の端末。

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
| 3. メール | プッシュがどこにも届かない人にメールが届く | Mailgun の API キーとドメイン |
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

## 3. メール：Mailgun

### 3-a. アカウントとドメイン

1. https://signup.mailgun.com でアカウント作成（Free/Foundation どちらでも可）
2. **Sending → Domains → Add New Domain**。`mg.あなたのドメイン` のようなサブドメインを推奨。
   リージョンは **US** か **EU**（EU にした場合は後述の `MAILGUN_API_BASE` も要る）。
3. 表示される DNS レコード（TXT 2 つ・MX 2 つ・CNAME 1 つ）を、ドメインの DNS
   （Cloudflare で管理しているならそこ）に追加。
4. Mailgun 側で **Verify DNS Settings**。緑になるまで数分〜数時間。

サンドボックスドメイン（`sandbox….mailgun.org`）は自分で承認した宛先にしか送れないので、
試すだけならそれでも動く。

### 3-b. API キー

**Settings（歯車）→ API Keys → Add new key**（または既存の Private API key）。
一度しか表示されないのでその場でコピー。

### 3-c. Worker に入れる

```bash
cd worker
npx wrangler secret put MAILGUN_API_KEY      # 3-b のキー
npx wrangler secret put MAILGUN_DOMAIN       # 例: mg.example.com
npx wrangler secret put NOTIFY_EMAIL_FROM    # 任意。例: Honmaru AI <no-reply@mg.example.com>（未設定なら no-reply@ドメイン）
npx wrangler secret put MAILGUN_API_BASE     # EU リージョンのときだけ: https://api.eu.mailgun.net
```

誰に届くか：メールでサインアップした人はその住所へ。GitHub でサインインした人は
Web の **⋯ → You → Email** に住所を入れたときだけ。送るのはプッシュがどこにも
届かなかったときだけ。

受信側（メールを Worker に流し込む webhook）は別の設定で、`MAILGUN_WEBHOOK_SIGNING_KEY`
と `INBOUND_EMAIL_DOMAIN`。これは今回の範囲外（`PROGRESS.md` 参照）。

---

## 4. Web クライアントを置く

`web-react/` は静的サイト。Cloudflare Pages が同じアカウントで済んで楽。

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
- `email: true` … Mailgun 2 つが入っている
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
| メールが来ない | 相手に住所があるか、`notifyEmail` がオンか、Mailgun のドメインが verified か、Mailgun の **Logs** に送信記録があるか |
| 通知の言語が違う | Web の ⋯ → Language、iOS は You → Language。`GET /me` の `locale` が真実 |
