# 管理機能 — Owner と Admin の分離、Provisioning キー、ログイン有効期限 — 詳細設計

作成日: 2026-09-26。状態: **§4（Owner）と §3（ログイン有効期限）は実装済み**。§2（Provisioning キー）は次の PR。

実装での決めごと:
- 権限表は `worker/src/permissions.js` の `PERMISSIONS`（操作 → 最低の役割）。ルートは `allowed()` だけを呼ぶ。
- 既存のワークスペースの Owner は、Worker が最初にメンバー一覧を読んだとき（または管理者が操作したとき）に決まる。まとめて決めるなら `worker/scripts/assign-owners.mjs --apply`。GitHub のリポジトリのワークスペースは、GitHub の admin をそのまま Owner として扱う（行は書き換えない）。
- 無操作の判定は、セッションに「今までで一番長く使われなかった時間」（`sessions.longest_idle_ms`）を持たせて行う。一度でも上限を超えたセッションは、そのワークスペースでは使えない。
- 方針のないワークスペースでも、Owner の操作は 60 分以内のログインを求める。本人確認はメールのコードかパスワード。どちらも無いアカウントはログインし直す。

関連文書:
- [sso-and-domain-join.md](sso-and-domain-join.md)
- [audit-log-phase2.md](audit-log-phase2.md)
- [enterprise-audit-log.md](enterprise-audit-log.md)

> 会社で使うと、「ワークスペースを持っている人」「日々の運用をする人」「人ではなく仕組み（人事システム、構成管理）」が分かれる。今は全部が Admin に集まっている。この文書でそれを分け、キーとログインの寿命を会社が決められるようにする。

作業の順番は **§4 Owner → §2 Provisioning キー → §3 ログイン有効期限**。Owner がいないと、キーと寿命を誰が決めるかが定まらないため。

---

## 1. いまの仕組み（2026-09-26）

- **役割**: `memberships.role` の順位は `ROLE_RANK`（`auth.js`）で決まっている。
  - guest -1 / member・designer・engineer 0 / triager 1 / maintainer 2 / admin 3
- **管理者の判定**: 各所でばらばらに行っている。
  - `canRename`（orgs.js）
  - `isAdmin`（audit.js、automation.js）
  - `rank(actor) > rank(target)`（team.js）
- **API キー**: `api_tokens` は人に紐づく。
  - スコープは `read` / `write` / `audit:read`（#80）。
  - 作った人がメンバーでなくなると使えなくなる。
- **セッション**: 30 日で、使えば延びる。ワークスペースごとの方針はない。
  - 端末一覧と強制ログアウトは #80 で入った。

---

## 2. Provisioning キー（ワークスペースのキー）

### 2.1 何のためか

- 人事システムや構成管理（Terraform など）から、人の追加・削除、チャンネルの用意、監査ログの取得を自動で行う。
- 人のキーだと、その人が辞めた瞬間に止まり、しかもその人の権限で動いてしまう。
- ワークスペースそのものに属するキーを、**Owner だけが作れる**ようにする。

### 2.2 データ

```sql
CREATE TABLE IF NOT EXISTS org_keys (
  id            TEXT PRIMARY KEY,           /* ok_ + 20 桁 */
  org_id        TEXT NOT NULL,
  token_hash    TEXT NOT NULL UNIQUE,       /* SHA-256。値は作ったとき一度だけ見せる */
  prefix        TEXT NOT NULL,              /* hmo_ + 先頭 8 文字（画面表示用） */
  name          TEXT NOT NULL,
  scopes        TEXT NOT NULL,              /* JSON（§2.3） */
  allowed_ips   TEXT,                       /* JSON の CIDR 一覧。NULL = 制限なし */
  expires_at    TEXT,                       /* NULL = 無期限（Owner が明示したときだけ） */
  created_by    TEXT NOT NULL,              /* 作った Owner（監査のため。キーはこの人に依存しない） */
  created_at    TEXT NOT NULL,
  last_used_at  TEXT,
  last_used_ip  TEXT,
  revoked_at    TEXT,
  revoked_by    TEXT
);
CREATE INDEX IF NOT EXISTS idx_org_keys_org ON org_keys(org_id);
```

- **キーの形**:
  - `hmo_` + 32 バイトの 16 進。人のキー（`hm_`）と接頭辞で見分ける。
  - GitHub のシークレットスキャンに登録できる形にしておく（接頭辞と長さが固定）。

### 2.3 スコープ

| スコープ | できること |
|---|---|
| `members:read` | メンバー一覧（名前、メール、役割、参加日、来た経路） |
| `members:write` | 招待の発行・取消、役割の変更、メンバーの削除、全端末からのログアウト |
| `channels:read` | チャンネル一覧、メンバー |
| `channels:write` | チャンネルの作成・名前変更・アーカイブ、非公開チャンネルのメンバー変更 |
| `audit:read` | 監査ログ（`GET /audit/logs`、`/audit/verify`） |
| `scim:write` | SCIM 2.0（[sso-and-domain-join.md](sso-and-domain-join.md) §11） |

- メッセージの本文を読むスコープは**作らない**（管理のキーで会話を読めないようにする。書き出しは別機能）。
- Owner より強い操作はしない（`members:write` でも Owner の削除・降格はできない）。

### 2.4 API（管理 API v1）

人のセッションの API とは分け、`/admin/v1/` 以下に安定した形で出す。

```
Authorization: Bearer hmo_…

GET    /admin/v1/members                       ?cursor=&limit=
GET    /admin/v1/members/{ref}
PATCH  /admin/v1/members/{ref}                 {role?, channels?（ゲスト）}
DELETE /admin/v1/members/{ref}                 （削除 + 全セッション失効）
POST   /admin/v1/members/{ref}/sign-out        （全セッション失効のみ）
POST   /admin/v1/invites                       {email?, role, channels?, uses?} → {link, code, expiresAt}
DELETE /admin/v1/invites/{ref}
GET    /admin/v1/channels
POST   /admin/v1/channels                      {name, private?, members?}
PATCH  /admin/v1/channels/{slug}               {name?, archived?}
PUT    /admin/v1/channels/{slug}/members       {add?: [ref|email], remove?: [ref]}
GET    /admin/v1/audit/logs                    （/audit/logs と同じ）
```

- **応答**: JSON。エラーは `{ "error": { "code": "…", "message": "…" } }`。ページングは `cursor`。
- **メール**: `members:read` のキーにはメールアドレスも返す（人事システムと突き合わせるため）。人のセッションの API は今どおり返さない。
- **冪等性**: `Idempotency-Key` ヘッダを受け、24 時間同じ結果を返す（`idempotency(org_id, key, response, created_at)`）。
- **レート制限**: キーごとに 600 回/分（`ratelimit.js` の新しいバケット `admin-api`）。
- **OpenAPI**: 仕様を `docs/admin-api.openapi.json` に書き、Studio →「API」からリンクする。

### 2.5 検証と記録

- **認証**: `resolveOrgKey(header)` で行う。
  - ハッシュで引き、`revoked_at` が NULL で期限内かを確かめる。
  - `allowed_ips` があれば `CF-Connecting-IP` がその範囲に入るかを確かめる。
  - `last_used_at` / `last_used_ip` は 5 分に 1 回だけ書く。
- **監査ログの actor**: `{ type: "api_key", id: <prefix>, name: <キー名>, via: { type: "org_key", id } }` とする。人ではないことが分かる。
- **キー自体の操作**: 作成・スコープ変更・無効化は `org_key.created` / `org_key.updated` / `org_key.revoked`（critical）で残す。
- **新しい IP**: 初めて見る IP から使われたら `org_key.used_from_new_ip`（warning）を残す。

### 2.6 画面

- **Studio →「API」**: 「ワークスペースのキー」欄を足す（Owner にだけ表示）。
  - 作成（名前、スコープ、IP 制限、期限）
  - 作成直後に一度だけ値を表示
  - 一覧（接頭辞、スコープ、最終使用の時刻と IP）
  - 無効化
- **期限の既定**: 90 日。「無期限」は理由の入力を必須にする。
- **期限切れ前の通知**: 7 日前に Owner へメールする。

---

## 3. ログイン有効期限（セッションの方針）

### 3.1 決められること

`org_session_policy`（ワークスペースごと。Owner が設定）:

| 項目 | 意味 | 既定 | 範囲 |
|---|---|---|---|
| `web_max_hours` | ブラウザのセッションの最長。使っていても、この時間で切れる | なし（今どおり 30 日で延長あり） | 1〜2160 |
| `mobile_max_hours` | iOS アプリのセッションの最長 | なし | 1〜8760 |
| `idle_hours` | 使わないまま、この時間が過ぎたら切れる | なし | 1〜720 |
| `reauth_for_admin_minutes` | 管理操作（役割変更、キー作成、SSO 設定など）の直前に、この分数以内のログインを求める | なし | 5〜1440 |
| `sso_session_hours` | SSO で入ったセッションの寿命（[sso-and-domain-join.md](sso-and-domain-join.md) §7） | 24 | 1〜720 |

```sql
CREATE TABLE IF NOT EXISTS org_session_policy (
  org_id                   TEXT PRIMARY KEY,
  web_max_hours            INTEGER,
  mobile_max_hours         INTEGER,
  idle_hours               INTEGER,
  reauth_for_admin_minutes INTEGER,
  updated_by               TEXT NOT NULL,
  updated_at               TEXT NOT NULL
);
```

### 3.2 どこで効かせるか

セッションは人に属し、ワークスペースをまたいで使われる（1 つのトークンで複数のワークスペースに入る）。そこで方針は「**そのワークスペースに入るとき**」に判定する。

- **判定**: `requirePolicy(env, session, orgId)` を、`isMember` を通る全経路（HTTP、Relay の join、MCP）で呼ぶ。
  - `session.created_at` から `web_max_hours`（`client = web`）/ `mobile_max_hours`（`client = ios`）が過ぎていたら、このワークスペースについては `401 { code: "session-policy", orgId }`。
  - `session.last_seen_at` から `idle_hours` が過ぎていたら同じ。
  - ほかのワークスペース（方針の緩いもの）では、同じセッションがそのまま使える。
- **クライアント**:
  - `session-policy` を受けたら「〇〇のルールで、もう一度ログインしてください」を出し、ログイン画面へ送る。
  - ログインし直すと新しいセッションになり、古いものは消す。
- **Relay**:
  - 接続中のソケットは join 時に一度しか見ていない。
  - 方針の最長時間が来たら閉じられるよう、join 時にこのソケットの「締め切り時刻」を attachment に入れる。
  - Durable Object の alarm で見回り、過ぎていれば 1008 で閉じる。
- **管理操作の再認証**:
  - `reauth_for_admin_minutes` があるとき、管理 API は `session.created_at`（または最後の再認証 `reauth_at`）が範囲内かを見る。
  - 範囲外なら `401 { code: "reauth-required" }`。
  - Web はメールのコード（SSO なら IdP）で本人確認し、`sessions.reauth_at` を更新してから操作を続ける。

### 3.3 方針を変えたとき

- 厳しくした直後に、今の方針に合わないセッションはどうなるか:
  - 次にそのワークスペースへアクセスしたときに自然に切れる。
  - 画面の「今すぐ全員に適用」を押すと、Owner の手で即座に失効させられる（対象者の該当セッションを `endSessions`）。
- **記録**: `workspace.session_policy_changed`（critical、details に前後の値）。

### 3.4 画面

- **Studio →「セキュリティ」→「ログイン」**:
  - 数値の入力と、よくある組み合わせのプリセット。
  - 例: 「厳しめ: ブラウザ 12 時間・アプリ 30 日・無操作 8 時間」
- **メンバーのセッション一覧**（#80 の「ログイン中の端末」）: このワークスペースの方針で「あと何時間で切れるか」を出す。

---

## 4. Owner と Admin の分離

### 4.1 役割と順位

| 役割 | 順位 | 位置づけ |
|---|---|---|
| Owner | 4 | ワークスペースを持つ人。お金・セキュリティ・存続を決める。1 人以上必須 |
| Admin | 3 | 日々の運用。人・チャンネル・連携を管理する |
| Member | 0 | 今どおり（designer / engineer などの肩書きも 0 のまま） |
| Guest | -1 | 選んだチャンネルだけ（#80） |

- `ROLE_RANK` に `["owner", 4]` を足す。triager 1 / maintainer 2 は GitHub 連携のワークスペース用に残す。

### 4.2 権限表（一か所にまとめる）

`worker/src/permissions.js` に表を置き、各ルートは `can(role, action)` だけを呼ぶ（今ある `canRename`、`isAdmin`、ばらばらの `rank` 比較をこれに置き換える）。

| 操作（action） | Owner | Admin | Member | Guest |
|---|---|---|---|---|
| `workspace.rename` / `workspace.icon` | ✓ | ✓ | | |
| `workspace.delete` | ✓ | | | |
| `workspace.ai_settings`（モデル、キー） | ✓ | ✓ | | |
| `billing.manage` | ✓ | | | |
| `owner.transfer` / `owner.add` / `owner.remove` | ✓ | | | |
| `member.invite`（member / guest） | ✓ | ✓ | ✓ | |
| `member.invite_admin` | ✓ | | | |
| `member.role_change`（admin 未満） | ✓ | ✓ | | |
| `member.role_change`（admin にする・admin を下げる） | ✓ | | | |
| `member.remove`（admin 未満） | ✓ | ✓ | | |
| `member.remove`（admin） | ✓ | | | |
| `member.sign_out_everywhere`（admin 未満） | ✓ | ✓ | | |
| `domain.*`（確認、参加ポリシー） | ✓ | | | |
| `sso.*`（設定、強制） | ✓ | | | |
| `session_policy.*` | ✓ | | | |
| `org_key.*`（Provisioning キー） | ✓ | | | |
| `audit.read` / `audit.export` | ✓ | ✓ | | |
| `audit.stream.*`（SIEM 配信） | ✓ | | | |
| `webhook.create` / `api_token.create`（自分のもの） | ✓ | ✓ | ✓ | |
| `webhook.delete`（他人のもの） | ✓ | ✓ | | |
| `emoji.add` / `usergroup.edit` | ✓ | ✓ | ✓ | |
| `channel.create` | ✓ | ✓ | ✓ | |

- テスト（`test/permissions.test.js`）: 表の各行を、実際のルートに 4 つの役割で当てて確かめる。表とルートがずれたら落ちる。

### 4.3 今のワークスペースの移行

一度だけのマイグレーション（`migrations.sql` の UPDATE ではなく `scripts/assign-owners.mjs`。判断が入るため）:

1. `personal:` のワークスペース: そのワークスペースを作った人（登録時に admin になった人）を Owner にする。
2. `/orgs` で作ったワークスペース: `createTeam` の `createdBy` を Owner にする（`orgs.created_by` が無いので、`memberships` で最も早い admin を使う）。
3. GitHub 連携のワークスペース: GitHub の admin 権限を持つ人を Owner にする（`membership.js` の再同期で決まる）。
4. どの規則にも当たらないワークスペース: 最も早い admin を Owner にする。
5. 結果を `audit.owner_assigned`（system）として各ワークスペースに記録する。

### 4.4 Owner の決まりごと

- **Owner は常に 1 人以上**:
  - 最後の Owner は、抜ける・降格する・削除されることができない。
  - 「先に別の人を Owner にしてください」と返す。
- **譲渡**（`owner.transfer`）: 相手の承認を必要とする。
  - 相手に通知が届き、承認した時点で相手が Owner になる。元の人は Owner のまま残るか Admin になるかを選べる。
- **退会とアカウント削除**: 最後の Owner のアカウント削除は、そのワークスペースに他のメンバーがいる限り止める。
  - 「ワークスペースを譲るか、削除してください」と返す。今は `deleteAccount` がそのまま進むため、ここを変える。
- **再認証**: Owner の操作はすべて §3.2 の再認証の対象にする（方針が未設定でも、Owner 操作だけは 60 分以内のログインを既定で求める）。
- **記録**: Owner に関わる操作は `owner.added` / `owner.removed` / `owner.transferred`（critical）として残し、全 Owner にメールする。

### 4.5 画面

- **チームの画面**:
  - 役割の選択肢に Owner を足す（Owner にだけ見える）。
  - Owner は名前の横に王冠のマークを付ける。
- **「ワークスペースを譲る」**: チームの画面の一番下（Owner のみ）。
- **Studio**: Owner 専用の項目（セキュリティ、請求、ワークスペースのキー）は、Admin には表示だけして「Owner が変更できます」と出す。

---

## 5. 作業の順番と見積もり

| 段階 | 内容 | 目安 |
|---|---|---|
| 1 | `permissions.js` と権限表、既存の判定の置き換え、テスト | 3 日 |
| 2 | Owner の役割、移行スクリプト、最後の Owner の保護、譲渡、アカウント削除の止め、画面 | 3 日 |
| 3 | Provisioning キー（データ、検証、IP 制限、期限）、管理 API v1、OpenAPI、画面 | 5 日 |
| 4 | ログイン方針（判定、Relay の締め切り、再認証）、画面 | 4 日 |

**SSO との関係**:
- SSO（[sso-and-domain-join.md](sso-and-domain-join.md)）の段階 D（強制）は、このうち 2 と 4 の後に入れる。
- SSO の設定は Owner 専用とし、SSO セッションの寿命は §3 の仕組みを使う。
