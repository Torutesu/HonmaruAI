# SSO（Google Workspace / Okta / Entra ID）とドメイン参加 — 詳細設計

作成日: 2026-09-26。状態: **設計のみ（未実装）**。

関連文書:
- [enterprise-audit-log.md](enterprise-audit-log.md) §10（企業向けロードマップ）
- [admin-controls.md](admin-controls.md)（Owner、セッション寿命）
- [audit-log-phase2.md](audit-log-phase2.md)

> 目的: 会社のアカウントでログインでき、会社のドメインの人は招待なしで自分の会社のワークスペースに入れる。辞めた人は IdP で止めればここからも締め出される。管理者は「SSO 以外では入れない」を選べる。

---

## 1. 範囲

**入れるもの**

| # | 機能 | 内容 |
|---|---|---|
| 1 | ドメインの所有確認 | DNS の TXT レコードで「example.co.jp は このワークスペースのもの」と確かめる |
| 2 | ドメイン参加 | 確認済みドメインのメールでログインした人を、自動（または承認制）でメンバーにする |
| 3 | SSO（OIDC） | Google Workspace、Okta、Microsoft Entra ID、汎用 OIDC で、ログインを IdP に任せる |
| 4 | SSO の強制 | そのドメインの人は SSO 以外（メールのコード、パスワード、GitHub）で入れない |
| 5 | 退職・停止への追従 | IdP で止まった人を、次のログイン確認のときに締め出す。セッション寿命（[admin-controls.md](admin-controls.md)）と組み合わせる |

**範囲外（次の段階）**

- SAML 2.0。Okta と Entra ID はどちらも OIDC を話せるので、まず OIDC だけにする。§11 で SAML を入れるときの形を書いておく。
- SCIM 2.0 による自動プロビジョニング。§11 に形だけ書く。

---

## 2. いまの仕組み（2026-09-26）

- **アカウント**: `users.github_id` が主キー。
  - メールで登録した人は `email:<アドレス>`、ログイン名（`login`）は `u:<アドレス>`。
  - GitHub で登録した人は GitHub の数値 ID と GitHub のログイン名。
- **ログイン方法**:
  - メールに届く 6 桁のコード（`otp.js`）
  - パスワード（`auth.js` の `login`）
  - GitHub OAuth（`/oauth/github/*`）
  - iOS はこれらを同じ API で使う
- **セッション**: `sessions` の 1 行＝1 端末。30 日で、使うたびに延びる。
  - #80 で `client`、`user_agent`、`place`、`last_seen_at` を足した。
  - ログインしたことは `signedIn()` が監査ログに書く。
- **ワークスペースに入る方法**: 招待コード（`invites`）だけ。
  - 登録すると `personal:<hash>` の自分用ワークスペースができる。

---

## 3. データ

```sql
/* ワークスペースが所有を確かめたドメイン。1 ドメインは 1 ワークスペースだけのもの。 */
CREATE TABLE IF NOT EXISTS org_domains (
  domain          TEXT PRIMARY KEY,         /* 小文字、IDN は punycode */
  org_id          TEXT NOT NULL,
  verify_token    TEXT NOT NULL,            /* TXT に書いてもらう値: honmaru-verify=<token> */
  verified_at     TEXT,                     /* NULL = 未確認 */
  last_checked_at TEXT,
  join_policy     TEXT NOT NULL DEFAULT 'off',   /* off | request | auto */
  join_role       TEXT NOT NULL DEFAULT 'member',/* auto で入る人の役割: member | guest */
  join_channels   TEXT,                     /* JSON: 入ったときに加わるチャンネル */
  created_by      TEXT NOT NULL,
  created_at      TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_org_domains_org ON org_domains(org_id);

/* ワークスペースの SSO 接続。1 ワークスペースに 1 つ（複数 IdP は §11）。 */
CREATE TABLE IF NOT EXISTS org_sso (
  org_id          TEXT PRIMARY KEY,
  provider        TEXT NOT NULL,            /* google | okta | entra | oidc */
  issuer          TEXT NOT NULL,            /* https://accounts.google.com, https://<tenant>.okta.com, https://login.microsoftonline.com/<tid>/v2.0 */
  client_id       TEXT NOT NULL,
  client_secret   TEXT NOT NULL,            /* AES-GCM で暗号化して保存（鍵は Worker シークレット SSO_SECRET_KEY） */
  allowed_domains TEXT NOT NULL,            /* JSON: この IdP で入れるドメイン（org_domains の確認済みに限る） */
  hosted_domain   TEXT,                     /* Google の hd パラメータ */
  enforce         INTEGER NOT NULL DEFAULT 0,    /* 1 = 確認済みドメインの人は SSO でしか入れない */
  enforce_since   TEXT,
  session_hours   INTEGER,                  /* SSO で入ったセッションの寿命（admin-controls.md §3） */
  status          TEXT NOT NULL DEFAULT 'draft', /* draft | testing | active | disabled */
  tested_at       TEXT,                     /* テストログインが通った時刻。active にするための条件 */
  created_by      TEXT NOT NULL,
  updated_at      TEXT NOT NULL
);

/* IdP 側の本人と、こちらのアカウントの対応。メールが変わっても sub で追える。 */
CREATE TABLE IF NOT EXISTS sso_identities (
  org_id          TEXT NOT NULL,
  issuer          TEXT NOT NULL,
  subject         TEXT NOT NULL,            /* id_token の sub（Entra は oid を使う） */
  user_github_id  TEXT NOT NULL,
  email           TEXT NOT NULL,
  last_login_at   TEXT NOT NULL,
  PRIMARY KEY (issuer, subject)
);
CREATE INDEX IF NOT EXISTS idx_sso_identities_user ON sso_identities(user_github_id);

/* OIDC のやり取りの途中状態（state / nonce / PKCE）。10 分で消える。 */
CREATE TABLE IF NOT EXISTS sso_states (
  state           TEXT PRIMARY KEY,
  org_id          TEXT NOT NULL,
  nonce           TEXT NOT NULL,
  code_verifier   TEXT NOT NULL,
  return_to       TEXT,                     /* web | ios | test */
  created_at      TEXT NOT NULL,
  expires_at      TEXT NOT NULL
);

/* 承認制のドメイン参加で、承認を待っている人。 */
CREATE TABLE IF NOT EXISTS join_requests (
  org_id          TEXT NOT NULL,
  user_github_id  TEXT NOT NULL,
  email           TEXT NOT NULL,
  requested_at    TEXT NOT NULL,
  decided_by      TEXT,
  decided_at      TEXT,
  outcome         TEXT,                     /* approved | declined */
  PRIMARY KEY (org_id, user_github_id)
);
```

- `sessions` に足す列:
  - `auth_method TEXT`（`email_code` | `password` | `github` | `sso`）
  - `sso_org_id TEXT`（SSO で入ったならどのワークスペースの IdP か）
  - `idp_checked_at TEXT`（§7 の再確認）
- `memberships` に足す列:
  - `joined_via TEXT`（`invite` | `domain` | `sso` | `created`）
  - 監査とメンバー一覧の「どうやって来たか」に使う。

---

## 4. ドメインの所有確認

1. 管理者が Studio →「セキュリティ」→「ドメイン」でドメインを入力する。
   - 条件:
     - 自分のログインメールがそのドメインであること（他社ドメインを取られないため）
     - `gmail.com` などフリーメールの一覧（`FREE_MAIL_DOMAINS`）でないこと
     - まだどのワークスペースも確認していないこと
   - 結果: `org_domains` に `verify_token`（ランダム 32 バイトを base32 にしたもの）が作られる。
2. 画面に「DNS に `TXT` レコード `honmaru-verify=<token>` を `example.co.jp` に追加してください」と表示する。
3. 「確認する」を押すと、Worker が DNS over HTTPS で TXT を引く。
   - 問い合わせ先: `https://cloudflare-dns.com/dns-query?name=<domain>&type=TXT`、`accept: application/dns-json`
   - 一致すれば `verified_at` を入れ、`domain.verified` を監査ログに記録する（severity: warning）。
4. 確認済みでも、1 日 1 回 Cron で TXT が残っているかを見直す。
   - 3 日続けて消えていたら `verified_at` を NULL に戻す。ドメイン参加と SSO の強制は止まる。
   - `domain.verification_lost`（critical）を記録し、Owner にメールする。
   - 会社が移転・売却されたとき、昔の持ち主が勝手に参加させ続けないため。
5. 同じドメインをほかのワークスペースが後から確認しようとした場合は、断る。
   - 「そのドメインは別のワークスペースが確認済みです」と返す。どこのワークスペースかは返さない。
   - 本物の持ち主の紛争は運営が手で解決する（`docs/handoff-owner-tasks.md` に手順を書く）。

**API**

```
GET    /orgs/domains?orgId=                          → [{domain, verified, joinPolicy, joinRole, joinChannels, lastCheckedAt}]
POST   /orgs/domains        {orgId, domain}          → {domain, txtName, txtValue}
POST   /orgs/domains/verify {orgId, domain}          → {verified: true} | 409 {found: [...TXT値]}
PUT    /orgs/domains        {orgId, domain, joinPolicy, joinRole, joinChannels}
DELETE /orgs/domains        {orgId, domain}
```

権限はすべて Owner（[admin-controls.md](admin-controls.md) §4 で Admin と分ける）。すべて監査ログに残す。

---

## 5. ドメイン参加

`join_policy` は 3 つ。

| 値 | 動き |
|---|---|
| `off` | 何もしない（今と同じ）。招待だけで入る |
| `request` | ログインした人に「〇〇に参加をリクエスト」を出す。Owner / Admin が承認すると入る |
| `auto` | ログインした時点で、`join_role` のメンバーとして入る。`join_channels` にも加わる |

- **判定するタイミング**: ログインが成功したすべての経路（OTP、パスワード、GitHub、SSO）の直後。`signedIn()` の中で `domainJoin(env, user)` を呼ぶ。
- **メールの確かさ**:
  - OTP と SSO で確かめたメールだけを使う。
  - パスワードだけのアカウントは、登録時に確かめていない場合があるので使わない。
  - GitHub は `/user/emails` の `verified: true` かつ `primary` のアドレスだけを使う。
- **判定のしかた**: メールのドメインを小文字にし、完全一致とサブドメインの両方を見る（`sales.example.co.jp` は `example.co.jp` に一致）。
- **すでにメンバーの人**: 何もしない。役割も下げない（`acceptInvite` と同じ考え方）。
- **auto のとき**: `upsertMembership(..., joinRole)`、`joined_via = 'domain'`、`member.joined`（details.via = domain）を記録する。
- **request のとき**:
  - `join_requests` に入れ、Owner / Admin へアクティビティとメールで知らせる。
  - 承認・却下はチームの画面から行う。どちらも監査ログに残す。
- **画面**:
  - ログイン直後に、ワークスペース切り替えメニューへ「example.co.jp のワークスペースがあります」を出す。
  - auto ならそのまま切り替える。request なら「参加をリクエスト」ボタンを出す。
  - 招待リンクを待たずに会社の場所へ着けるのが、この機能の価値。
- **ゲストのドメイン**: 取引先のドメインを「ゲストとして auto」にもできる（`join_role = guest`、`join_channels` 必須）。
  - 取引先のドメインは所有確認できないので、この場合は確認済みでなくてもよい、とはしない。
  - 取引先ドメインの自動参加は危険（そのドメインのアドレスを作れる人が誰でも入れる）ので、**確認済みドメインだけ**に限る。

---

## 6. SSO（OIDC）

### 6.1 設定の流れ（管理画面）

1. Studio →「セキュリティ」→「SSO」で IdP を選ぶ（Google Workspace / Okta / Entra ID / その他 OIDC）。
2. IdP ごとに、手順とコピーできる値を出す:
   - リダイレクト URI: `https://<api>/sso/callback`（本番は `https://api.honmaruai.com/sso/callback`）
   - 必要なスコープ: `openid email profile`
   - Entra: 「ID トークン」を有効に、`email` をオプション要求に追加
   - Okta: 「Web アプリ」、`Authorization Code` + PKCE、グループ要求は任意
   - Google: 「内部」アプリ、承認済みドメインに自社ドメイン
3. 管理者が `issuer`、`client_id`、`client_secret` を入れて保存する（`status = draft`）。
   - Worker が `issuer/.well-known/openid-configuration` を取りに行く。
   - `authorization_endpoint`、`token_endpoint`、`jwks_uri` と `issuer` の一致を確かめる。取れなければ保存しない。
4. 「テストログイン」で、管理者本人が IdP でログインする（`return_to = test`）。
   - 通れば `tested_at` を入れ、画面に受け取った `email`、`sub`、`name` を表示する。
   - 通らなければ IdP の返したエラーをそのまま表示する。
5. 「有効にする」で `status = active`。テストが通っていないと押せない。
6. 「SSO を必須にする」は、有効化の後に別のスイッチで入れる（§6.4）。

`client_secret` は保存後に二度と表示しない（Webhook の秘密と同じ）。変更は上書きだけ。

### 6.2 ログインの流れ

```
[ログイン画面] メールを入力
   │  POST /auth/discover {email}
   ▼
Worker: ドメイン → org_domains（確認済み）→ org_sso（active）
   ├─ 該当なし → 今までどおり「コードを送る」
   └─ 該当あり → {sso: {orgId, provider, name}}（enforce なら「コードを送る」は出さない）
   │
   │  GET /sso/start?orgId=&client=web|ios
   ▼
Worker: state / nonce / PKCE(code_verifier) を sso_states に保存
        → 302 authorization_endpoint?response_type=code&client_id=…&redirect_uri=…
             &scope=openid%20email%20profile&state=…&nonce=…
             &code_challenge=…&code_challenge_method=S256
             [&hd=<hosted_domain>（Google）] [&login_hint=<email>]
   │
   ▼  （IdP でログイン）
GET /sso/callback?code=…&state=…
   ▼
Worker:
  1. sso_states から state を削除しつつ取り出す（一回限り）。期限切れなら失敗
  2. token_endpoint に code + code_verifier + client_secret を POST
  3. id_token を検証:
     - 署名（jwks_uri の鍵、RS256/ES256。鍵は 1 時間キャッシュ、kid が無ければ取り直す）
     - iss = issuer、aud = client_id、exp / iat（許容誤差 2 分）、nonce 一致
     - email_verified = true（Entra は email が無ければ preferred_username を使うが、
       その値のドメインが allowed_domains にあることを必須にする）
     - メールのドメインが allowed_domains に含まれる
  4. sso_identities を (issuer, sub) で引く
     - あれば、そのアカウントでログイン（メールが変わっていれば更新）
     - 無ければ users.email で既存アカウントを探して紐付ける（§6.3）
     - どちらも無ければ新しいアカウントを作る（github_id = "sso:<org>:<sub のハッシュ>"）
  5. メンバーでなければドメイン参加の規則で入れる（SSO で来た人は auto と同じ扱い。
     join_policy が off でも、SSO が有効なら入れる — IdP に居ることがその会社の人である証明）
  6. createSession(…, {auth_method:'sso', sso_org_id}) → signedIn(…, "sso")
  7. web: 302 https://app.honmaruai.com/#/sso/done?token=<一回限りの受け渡しコード>
     ios: 302 honmaruai://sso?code=<受け渡しコード>（ASWebAuthenticationSession で受ける）
```

- **トークンを URL に載せない**: セッショントークンそのものは URL に載せない。
  - 60 秒・一回限りの受け渡しコードを渡し、クライアントが `POST /sso/exchange {code}` でセッショントークンと交換する。
  - 履歴、リファラ、ログにトークンが残らないようにするため。
- **iOS**:
  - `ASWebAuthenticationSession` で `/sso/start?client=ios` を開き、`honmaruai://sso` で戻す。
  - 別アプリがスキームを横取りしても、受け渡しコードと PKCE がなければ交換できない。
- **失敗したとき**: `auth.login_failed`（details.method = sso、reason）を記録し、ログイン画面に理由を 1 行で出す。
  - 理由の例: 「このメールのドメインは SSO に登録されていません」「IdP が拒否しました: <error_description>」

### 6.3 既存アカウントとの紐付け

- 既存の `users.email` と、id_token の確かめられたメールが一致したら、同じ人とみなして `sso_identities` に紐付ける。
- ただし次のどちらかを満たすときに限る（メールアドレスを乗っ取られた場合の備え）:
  - そのメールが OTP で確かめられている
  - そのドメインが確認済み（`org_domains.verified_at`）
- GitHub で登録した人は、GitHub の確かめられたメールが一致したときだけ紐付ける。
- 紐付けたときは、既存のセッションはそのまま残す。§6.4 の強制を入れたときに、SSO 以外のセッションが切れる。

### 6.4 SSO の強制

- **SSO を必須にする**（`enforce = 1`）と、確認済みドメインのメールを持つ人は、このワークスペースに SSO 以外で入れない。
  - OTP、パスワード、GitHub のどれでログインしても、このワークスペースのデータにはアクセスできない。
  - ほかのワークスペース（個人のもの、他社のもの）は今までどおり使える。
- **判定する場所**: `isMember` を通る全経路の先の `requireSSO(env, session, orgId)`。
  - 対象: HTTP ルート、Relay の join、MCP トークン。
  - 判定: `org_sso.enforce = 1` かつ、この人のメールのドメインが対象で、`session.auth_method != 'sso'` または `session.sso_org_id != orgId` なら 403 `{code: "sso-required", start: "/sso/start?orgId=…"}`。
  - クライアントはこのコードを見て、「会社の SSO でログインし直してください」画面を出す。
- **入れた瞬間**:
  - その組織の対象者のうち、SSO 以外のセッションを全部失効させる（`endSessions`）。
  - MCP トークンは止めない。トークンは「作った人がいまも SSO で入れる人か」を §7 の再確認で見る。
  - `sso.enforced`（critical）を記録し、対象者全員にメールで知らせる。
- **締め出し事故を防ぐ**:
  - 強制を入れる管理者本人が、直前 10 分以内に SSO でログインしていなければ入れられない。
  - ドメイン外のメール（例: 外部の管理者）を持つ Owner は強制の対象外にする（「ブレークグラス」アカウント）。画面でそれを明示する。
  - IdP が落ちたときに誰も入れなくなるのを防ぐため、Owner は「メールコードでの緊急ログイン」を 1 アカウントだけ残せる。使ったら critical を記録し、全 Owner にメールする。

### 6.5 IdP ごとの差

| | Google Workspace | Okta | Entra ID | 汎用 OIDC |
|---|---|---|---|---|
| issuer | `https://accounts.google.com` | `https://<org>.okta.com`（またはカスタム認可サーバ） | `https://login.microsoftonline.com/<tenant>/v2.0` | 入力 |
| 本人の ID | `sub` | `sub` | `oid`（`sub` はアプリごとに変わるため） | `sub` |
| メール | `email` + `email_verified` | `email` + `email_verified` | `email`（オプション要求）または `preferred_username` | `email` + `email_verified` |
| ドメイン制限 | `hd` パラメータと `hd` クレームを両方確認 | allowed_domains で確認 | `tid` をテナント ID と照合 + allowed_domains | allowed_domains |
| グループ | 取らない（§11） | `groups` クレーム（任意） | `groups`（任意、200 件超は取らない） | 任意 |

---

## 7. 退職・停止への追従

OIDC だけでは、IdP 側で止められた人を即座には知れない。SCIM（§11）が来るまでは次の 3 つで追う。

1. **SSO セッションの寿命を短く**:
   - `org_sso.session_hours`（既定 24 時間、最短 1、最長 720）を過ぎたら、SSO セッションは期限切れにする。
   - 使い続けていても延長しない（今のスライド延長はしない）。
   - クライアントは `code: "sso-reauth"` を受けたら、IdP に黙って行き直す（`prompt=none`）。IdP にセッションがあれば一瞬で戻る。
2. **再確認**:
   - `sessions.idp_checked_at` が 1 時間より古い SSO セッションは、次のリクエストで確認する。
   - IdP の `userinfo`（または refresh_token での更新。保存するなら暗号化）を叩き、失敗（`invalid_grant` や 401）したらセッションを終える。
   - `offline_access` を IdP が許す場合だけ行う。許さない場合は 1 の寿命だけに頼る。
3. **管理者の手動停止**:
   - チームの画面の「全端末からログアウト」（#80 で実装済み）に、「そして SSO の紐付けを外す」を足す。

監査ログ:
- `auth.login`（method = sso）
- `sso.session_expired`
- `sso.reauth_failed`（warning）
- `sso.identity_unlinked`（warning）

---

## 8. API とルート一覧

```
POST /auth/discover            {email}                      → {sso?: {orgId, provider, name, enforced}}（ドメイン名以外は返さない）
GET  /sso/start                ?orgId=&client=web|ios|test  → 302 IdP
GET  /sso/callback             ?code=&state=                → 302 アプリ（受け渡しコード付き）
POST /sso/exchange             {code}                       → {token, userId, login, orgId}
GET  /orgs/sso                 ?orgId=                      → 設定（client_secret は "set" / null のみ）
PUT  /orgs/sso                 {orgId, provider, issuer, clientId, clientSecret?, allowedDomains, hostedDomain?, sessionHours?}
POST /orgs/sso/activate        {orgId}                      （tested_at 必須）
PUT  /orgs/sso/enforce         {orgId, enforce: bool}       （直前 10 分以内の SSO ログイン必須）
DELETE /orgs/sso               {orgId}                      （無効化。enforce も外れる）
GET  /orgs/join-requests       ?orgId=
POST /orgs/join-requests       {orgId, ref, approve: bool}
```

- レート制限: `/auth/discover`（IP ごと 30 回/分。ドメイン列挙を防ぐため、該当なしの応答は該当ありと同じ時間をかける）、`/sso/*`（IP ごと 20 回/分）。
- `/auth/discover` はワークスペースの名前を返すので、確認済みドメインで SSO が有効なときに限る。

---

## 9. 画面

- **ログイン画面（Web / iOS）**:
  - メールを入れた時点で `/auth/discover`。
  - SSO 対象なら「〇〇（Okta）でログイン」ボタンを主にし、強制なら「コードを送る」を消す。
- **Studio →「セキュリティ」**（Owner のみ。Admin は閲覧だけ）:
  - ドメイン: 追加、TXT の表示、確認、参加ポリシー（off / 承認制 / 自動）、自動で入る役割とチャンネル
  - SSO: IdP 選択、手順、値の入力、テストログイン（結果表示）、有効化、強制、セッション寿命
  - 参加リクエスト: 承認・却下
- **チームの画面**: 各メンバーに「どうやって来たか」（招待 / ドメイン / SSO）と、最後の SSO ログインを表示する。
- **ワークスペース切り替え**: 自分のドメインのワークスペースがあれば「参加できるワークスペース」として出す。

---

## 10. セキュリティ上の決めごと

- **id_token の検証**:
  - 必須: 署名、iss、aud、exp、nonce。
  - `alg: none` と HS256 は拒否する。
  - JWKS はキャッシュが外れたら 1 回だけ取り直す（鍵ローテーション対応）。
- **その他**:
  - PKCE は必須（IdP が要らないと言っても送る）。
  - state は一回限りで、10 分で失効する。
  - 受け渡しコードは 60 秒・一回限りで、発行した client（web / ios）でしか交換できない。
  - `client_secret` は Worker シークレット `SSO_SECRET_KEY` による AES-GCM で暗号化して保存する。監査ログと画面には「設定済み」しか出さない。
  - ドメインの判定は小文字化・末尾ドット除去・punycode 変換の後に行う。`example.co.jp.evil.com` のような接尾辞は一致させない。
  - SSO の設定変更（issuer、client_id、allowed_domains、enforce）はすべて critical で監査ログに残し、全 Owner にメールする。
- **テスト**（`test/sso.test.js`）: IdP をフェッチモックで作り、次を確かめる。
  - 正常系
  - 署名不正、aud 違い、nonce 違い、email_verified=false
  - ドメイン外、state の使い回し、期限切れ
  - 強制中に OTP で入ったセッションの 403
  - ドメイン確認の喪失

---

## 11. 次の段階

- **SAML 2.0**:
  - `samlify` 相当の検証を Worker に入れる必要がある（XML 署名の検証は自前で書かない）。
  - Cloudflare Access を前段の SAML/OIDC 変換として使う案もある。
  - `org_sso.provider = 'saml'` と `idp_metadata_xml` を足す。
- **SCIM 2.0**:
  - `/scim/v2/Users`、`/scim/v2/Groups` を Bearer トークン（Provisioning キー、[admin-controls.md](admin-controls.md) §2 の `scim:write` スコープ）で受ける。
  - `active=false` で全セッション失効とメンバーからの除外。
  - Groups はユーザーグループ（`user_groups`）に写す。
- **複数 IdP**: 1 ワークスペースに複数の `org_sso` を持たせる。子会社ごとに IdP が違う場合に使う。主キーを `(org_id, id)` にする。

---

## 12. 段階と見積もり

| 段階 | 内容 | 目安 |
|---|---|---|
| A | ドメイン確認、ドメイン参加（off / request / auto）、画面、監査 | 4 日 |
| B | OIDC（Google、Okta、Entra、汎用）、テストログイン、Web のログイン画面、受け渡しコード | 6 日 |
| C | iOS（ASWebAuthenticationSession）、`/auth/discover` | 2 日 |
| D | 強制、ブレークグラス、SSO セッション寿命と再確認 | 4 日 |
| E | E2E（モック IdP）、ドキュメント、運用手順 | 2 日 |

**依存**: [admin-controls.md](admin-controls.md) の Owner / Admin の分離（§4）を先に入れる。SSO の設定と強制は Owner の権限にするため。
