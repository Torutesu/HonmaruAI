# ブラウザでしかできない残り作業 — Codex（Computer Use）への指示文

Worker と Web は `main` から自動デプロイ、iPhone のビルドは TestFlight
ワークフロー、証明書・プロファイル・GitHub シークレットは
`scripts/testflight-secrets.sh` が作ります。**残っているのは、アカウントに
ログインしないと作れないもの**だけです。以下はそのまま Codex に貼れる指示です。
各ブロックの末尾に「持ち帰るもの」を書いてあるので、それを次のコマンドに渡します。

> 注意：どのブロックも、鍵・トークン・パスワードをチャットや Issue に貼らないこと。
> ファイルとして所定の場所に置く、または `wrangler secret put` / `gh secret set`
> の標準入力に渡す。

---

## A. App Store Connect API キーを作る（TestFlight の前提、5 分）

```
あなたは私の Mac の Safari を操作します。目的：App Store Connect の API キーを
1 つ作り、.p8 を所定の場所に保存し、Key ID と Issuer ID を控えること。

1. https://appstoreconnect.apple.com を開く。ログイン画面なら私に知らせて止まる
   （Apple ID とパスワード、2 要素認証は私が入力する）。
2. 上部の「ユーザとアクセス」→ タブ「統合」→ 左の「App Store Connect API」。
   「チームキー」タブになっていることを確認。
3. 「+」（キーを生成）を押す。名前は「Honmaru CI」、アクセスは「App Manager」。
   「生成」を押す。
4. 生成された行の「API キーをダウンロード」を押す。ダウンロードは 1 回しかできない。
   ダウンロードした AuthKey_XXXXXXXXXX.p8 をターミナルで
   ~/.appstoreconnect/private_keys/ に移動する（mkdir -p してから mv）。
5. 同じ行の「キー ID」（10 桁）と、ページ上部の「Issuer ID」（UUID）を控える。
6. ターミナルで、リポジトリ直下で `scripts/setup.sh` を実行し、聞かれた順に
   Team ID（https://developer.apple.com/account の Membership に出る 10 桁）、
   Key ID、Issuer ID、.p8 のパス、App ID（`asc apps list --output table` で出る
   com.honmaru.ai の数字）を入力する。
7. `scripts/release.sh doctor` を実行して clean であることを確認する。
持ち帰るもの：.asc.env が書けていること。エラーが出たら全文を私に見せる。
```

続けてターミナルで（Codex に実行させてよい）：

```bash
scripts/testflight-secrets.sh --run 1.0.1
```

これが配布証明書とプロファイルを作り、GitHub の 7 つのシークレットを入れ、
TestFlight ワークフローを起動します。`gh run watch` で緑になれば TestFlight に
ビルドが上がっています。

---

## B. Jev（TypeSafe）の鍵を入れて分類コストを下げる（3 分）

```
目的：TypeSafe の API キーを取得して Worker のシークレットに入れる。
1. https://typesafe.ai にログイン（ログイン画面なら止まって私に知らせる）。
2. ダッシュボードの API Keys で新しいキーを作成し、値をクリップボードにコピーする。
   画面に表示された値はチャットに書かない。
3. ターミナルで、リポジトリの worker/ ディレクトリで
   `npx wrangler@4 secret put TYPESAFE_API_KEY` を実行し、貼り付けて Enter。
4. `curl -s https://tiktokforwork.torubj0904.workers.dev/health` の出力に
   "systemOne": true があることを確認する。
持ち帰るもの：health の出力。
```

---

## C. Web の GitHub サインインを有効にする（5 分）

```
目的：GitHub OAuth App に Web のコールバック URL を追加し、Worker に同じ URL を教える。
1. https://github.com/settings/developers → OAuth Apps → Honmaru（TikTok for Work）の
   アプリを開く。
2. 「Authorization callback URL」の下に、既存の tiktokforwork://oauth/callback を
   残したまま https://honmaru-web.pages.dev/ （末尾のスラッシュまで）を追加して
   「Update application」。
3. ターミナルで worker/ ディレクトリで
   `printf 'https://honmaru-web.pages.dev/' | npx wrangler@4 secret put GITHUB_WEB_REDIRECT_URI`
4. https://honmaru-web.pages.dev を開き、「GitHub で続ける」→ 許可 → リポジトリを
   選ぶ → フィードが開くことを確認。
持ち帰るもの：確認できたかどうか。/health の "githubOAuthWeb": true。
```

---

## D. 他人宛のメール招待・通知を届くようにする（Resend のドメイン、10 分）

```
目的：Resend で送信ドメインを検証し、Worker の From を切り替える。
1. https://resend.com にログイン → Domains → Add Domain → 使うドメイン（例
   honmaru.ai）を入力。
2. 表示された DNS レコード（TXT/MX/CNAME）を、そのドメインの DNS（Cloudflare なら
   https://dash.cloudflare.com の DNS 画面）に 1 つずつ追加する。
3. Resend に戻って Verify。Verified になるまで数分待つ。
4. ターミナルで worker/ ディレクトリで
   `printf 'Honmaru AI <noreply@honmaru.ai>' | npx wrangler@4 secret put NOTIFY_EMAIL_FROM`
   （ドメインは検証したものに合わせる）。
5. Web の Team 画面から自分以外のアドレスにメール招待を送り、届くことを確認。
持ち帰るもの：Resend の Verified 表示と、届いた招待メールのスクリーンショット。
```

---

## E. App Store 提出（A の後、審査用アカウントの準備を含めて 30 分）

`docs/handoff-owner-tasks.md` の E 章と `docs/app-store-release.md` の 3〜5 章の
とおり。コマンドはすべて `scripts/release.sh` にまとまっているので、Codex には
「`scripts/release.sh all 1.0.1 --dry-run` を実行して計画を見せ、私が y と言ったら
`--dry-run` なしで実行する」と指示すれば足ります。App Store Connect の App Privacy
と審査用アカウント欄はブラウザ作業なので、E 章の手順をそのまま貼ってください。
