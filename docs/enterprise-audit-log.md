# 監査ログ（Audit Log）設計 — 企業で使うための操作記録

調査日: 2026-09-25。状態: **Phase 1 は実装済み**（2026-09-26。`worker/src/audit.js`、Studio → 監査ログ）。Phase 2 以降は未実装。

> Phase 1 と設計の違い:
>
> - ハッシュは封印 Cron を待たず、書き込み時に付けている（1 行ごとに直前の行を読んでから書く）。
> - IP は監査ログにだけ残し、セッション一覧には都市と国だけを出す。

> 会社で使うには、「誰が・いつ・どこから・何に・何をしたか」を管理者が後から確かめられ、
> 消されていないことを証明でき、自社の SIEM に流せる必要がある。この文書はその設計。

---

## 1. 目的と範囲

**目的**

- ワークスペースの Owner / Admin とセキュリティ担当が、操作の記録を検索して書き出せる。
- 記録が改ざん・削除されていないことを、あとから検証できる。
- Splunk / Datadog / Sentinel などの SIEM に継続して送れる。
- 監査対応（SOC 2、ISMS / ISO 27001、J-SOX の IT 全般統制）で「ログがある」と答えられる。

**範囲外**（Slack と同じ線引き）

- メッセージ本文の監視はしない。監査ログが記録するのは **行為** で、**内容** は記録しない。本文の保全や検索は eDiscovery・リーガルホールド・DLP の役割で、別機能として §10 のロードマップに置く。
- 不正の自動判定もしない。記録と通知の材料は出すが、「その操作が適切だったか」は判定しない（Slack も同じ立場）。

---

## 2. 調査

### Slack Audit Logs API

- Enterprise Grid 限定。Org Owner がインストールしたアプリに `auditlogs:read` スコープを与え、**組織全体** を対象に読む。読み取り専用で、書き込み API はない。
- 1 件は **actor が entity に対して action を context の中で行った** という形で表す。
  ```json
  {
    "id": "0123a45b-…",
    "date_create": 1521214343,
    "action": "user_login",
    "actor":   { "type": "user", "user": { "id": "W123AB456", "name": "Charlie Parker", "email": "bird@slack.com" } },
    "entity":  { "type": "user", "user": { "id": "W123AB456", "name": "…", "email": "…" } },
    "context": { "location": { "type": "enterprise", "id": "E1701NCCA", "name": "Birdland", "domain": "birdland" },
                 "ua": "Mozilla/5.0 …", "ip_address": "1.23.45.678", "session_id": "…" },
    "details": { }
  }
  ```
- `GET /audit/v1/logs` の絞り込みは `oldest`、`latest`、`limit`、`action`（カンマ区切りで複数可）、`actor`、`entity`。ページングは `cursor` と `response_metadata.next_cursor`。
- `GET /audit/v1/schemas`（entity の型一覧）と `GET /audit/v1/actions`（action 一覧）がある。
- action は 200 種を超え、`snake_case` の「対象_動詞」形。例:
  - `user_login`, `user_logout`, `file_downloaded`, `file_public_link_created`
  - `public_channel_created`, `private_channel_deleted`, `channel_retention_changed`
  - `app_installed`, `app_approved`, `app_resources_granted`
  - `huddle_participant_joined`, `allow_huddles_transcriptions_changed`
  - `manual_export_downloaded`, `legal_hold_policy_created`, `idp_configuration_added`
  - `mobile_session_duration_changed`, `native_dlp_rule_created`
- 統計的な異常検知の結果を `anomaly` イベントとして同じストリームに出す（普段と違う IP / ASN / UA、Tor、大量ダウンロードなど）。

### そのほかの定石

- **GitHub Enterprise**
  - 監査ログを Splunk、Datadog、S3、Azure などへストリーミングできる。
  - action は `org.add_member` のようなドット区切り（カテゴリ.動詞）。
  - API トークンで行った操作には、そのトークンの ID が記録される。
- **改ざん検知**
  - 各レコードに直前のハッシュを含めるハッシュチェーンを使う。
  - 一定時間ごとのダイジェストを WORM ストレージに置く。
  - Cloudflare R2 の **Bucket Locks** は、プレフィックス単位で保持期間を決め、その間は削除も上書きもさせない。
- **個人情報との両立**
  - 本人削除（GDPR / 個人情報保護法）とハッシュチェーンは、そのままでは両立しない。
  - 個人情報のフィールドは、人ごとの鍵で暗号化してから記録する（**crypto-shredding**）。鍵を捨てれば読めなくなり、チェーンは暗号文の上で検証が通り続ける。

### HonmaruAI の現状（2026-09-25）

- `card_events` が、カードの作成・決定・コメントの履歴を持つ。ただし製品の機能としての履歴で、監査用ではない。削除でき、IP や UA も持たない。
- 役割は `memberships.role`（`owner` / `admin` / `member`）で、`team.js` に `ROLE_RANK` がある。
- `sessions` は token・作成日時・期限だけを持つ。IP、UA、最終利用の記録はない。
- `api_tokens` はスコープがなく、全権限。`last_used_at` だけがある。
- Webhook 署名（`webhooks.js`、HMAC-SHA256）はすでにある。SIEM への配信に流用できる。

---

## 3. イベントの形

Slack 互換を土台にする。同じパーサがそのまま使えることが、SIEM 側の手間をいちばん減らす。これに四つを足す。

- AI エージェントが主体になれる
- 結果（`outcome`）
- 連番とハッシュ
- 重大度

```json
{
  "id": "aud_01J8Z6K7M2Q4…",
  "seq": 18234,
  "date_create": 1790313600,
  "action": "member.role_changed",
  "category": "membership",
  "severity": "notice",
  "outcome": "success",
  "actor": {
    "type": "user",
    "user": { "id": "gh:12345", "name": "Toru", "email": "…" },
    "via": { "type": "session", "id": "ses_ab12…" }
  },
  "entity": { "type": "user", "user": { "id": "gh:67890", "name": "Gota" } },
  "context": {
    "location": { "type": "workspace", "id": "team:…", "name": "Toru さんのチーム" },
    "ip_address": "203.0.113.4",
    "country": "JP",
    "ua": "Mozilla/5.0 …",
    "client": "web",
    "session_id": "ses_ab12…",
    "request_id": "cf-ray-…"
  },
  "details": { "from": "member", "to": "admin" },
  "prev_hash": "b64…",
  "hash": "b64…"
}
```

### actor.type

| type | 意味 | `via` |
|---|---|---|
| `user` | 人がアプリで操作した | `session`（Web / iOS）または `api_token` |
| `agent` | AI エージェント（MCP / 招待リンクで入ったもの）が操作した | `api_token`（どのトークンか）と `on_behalf_of`（誰の権限で動いたか） |
| `ai` | HonmaruAI 自身（ルーティング、自動ルール、ルーティン）が操作した | `rule` / `routine` / `router` の ID |
| `system` | 定期処理、保持期間による削除、システム側の失効 | `job` 名 |
| `webhook` | 受信 Webhook（メール取り込みなど）が起点 | 送信元 |

AI が決めた、あるいは AI に決めさせた、という区別がこの製品の監査では核心になる。そのため `ai` と `agent` を人と同格の主体として記録する。

### その他のフィールド

- `outcome`: `success` / `denied`（権限不足で拒否）/ `failure`（処理の失敗）。拒否も記録する。攻撃の予兆は拒否に現れる。
- `severity`: `info` / `notice` / `warning` / `critical`。SIEM のアラート条件と、管理画面の既定フィルタに使う。

---

## 4. 記録する操作（action 一覧）

命名は `カテゴリ.対象_動詞`（ドット区切り、GitHub 式）。Slack 形式を求める SIEM には、API の `format=slack` で `snake_case` に変換して返す（§6）。

Phase 列は実装の優先度（§11）。

### 認証・セッション（`auth`）

| action | severity | Phase |
|---|---|---|
| `auth.login` （GitHub OAuth / メールコード / Apple。方法は `details.method`） | info | 1 |
| `auth.login_failed` （コード誤り、期限切れ、nonce 不一致） | warning | 1 |
| `auth.logout` | info | 1 |
| `auth.session_revoked` （本人、または管理者が失効させた） | notice | 1 |
| `auth.session_expired` | info | 2 |
| `auth.rate_limited` （ログイン系のレート制限に当たった） | warning | 1 |

### メンバー・役割・招待（`membership`）

| action | severity | Phase |
|---|---|---|
| `member.joined` （招待コード、招待メール、ドメイン参加） | notice | 1 |
| `member.removed` / `member.left` | notice | 1 |
| `member.role_changed` （`details.from/to`） | warning | 1 |
| `invite.created` / `invite.revoked` （役割、有効期限、最大回数） | notice | 1 |
| `invite.email_sent` | info | 1 |
| `agent_invite.created` / `agent_invite.redeemed` / `agent_invite.expired` | notice | 1 |

### ワークスペース設定（`workspace`）

| action | severity | Phase |
|---|---|---|
| `workspace.created` / `workspace.deleted` / `workspace.renamed` | warning | 1 |
| `workspace.icon_changed` | info | 2 |
| `workspace.ai_settings_changed` （モデル、プロバイダ。鍵そのものは記録しない） | warning | 1 |
| `workspace.ai_key_set` / `workspace.ai_key_removed` | critical | 1 |
| `workspace.retention_changed` （§8） | critical | 2 |
| `workspace.audit_stream_changed` （SIEM 配信先の追加・変更） | critical | 2 |

### チャネル・会話（`channel`）

| action | severity | Phase |
|---|---|---|
| `channel.created` / `channel.archived` / `channel.deleted` / `channel.renamed` | notice | 1 |
| `channel.member_added` / `channel.member_removed` （非公開チャネル導入後） | notice | 2 |
| `channel.visibility_changed` （公開 ↔ 非公開） | warning | 2 |
| `channel.automation_created` / `channel.automation_deleted` | notice | 2 |
| `message.deleted` （本文は記録せず、ID・チャネル・作成者だけ） | info | 2 |
| `message.deleted_by_admin` （他人のメッセージを消した） | warning | 2 |
| `message.pinned` / `message.unpinned` | info | 3 |

### カード・決定（`decision`）— この製品の中心

| action | severity | Phase |
|---|---|---|
| `card.created` （起点: 手動、AI ルーティング、メール、コネクタ、エージェント） | info | 1 |
| `card.routed` （AI が誰に回したか、その理由の要約） | info | 1 |
| `card.decided` （承認 / 却下 / 選択。決めた人、代理決定かどうか） | notice | 1 |
| `card.reassigned` / `card.delegated` | notice | 2 |
| `card.deleted` | warning | 1 |
| `auto_rule.created` / `auto_rule.deleted` （AI に自動で決めさせる規則） | warning | 1 |
| `auto_rule.applied` （規則で自動決定された） | notice | 1 |

### AI・エージェント・ルーティン（`ai`）

| action | severity | Phase |
|---|---|---|
| `routine.created` / `routine.updated` / `routine.deleted` | notice | 1 |
| `routine.posted` （日報・朝の計画を投稿した） | info | 2 |
| `agent.tool_called` （MCP 経由の書き込み系ツール呼び出し。読み取りは集計のみ） | info | 2 |
| `memory.deleted` （AI の記憶を消した） | notice | 2 |

### 連携・API（`integration`）

| action | severity | Phase |
|---|---|---|
| `connector.connected` / `connector.disconnected` （Gmail / Slack / Notion。個人単位） | notice | 1 |
| `github.installed` / `github.repo_changed` / `github.uninstalled` （ワークスペース共通） | warning | 1 |
| `api_token.created` / `api_token.revoked` （名前、スコープ、prefix。値は記録しない） | warning | 1 |
| `api_token.used_from_new_ip` | warning | 3 |
| `webhook.created` / `webhook.updated` / `webhook.deleted` （URL のホスト、イベント、DM 範囲） | warning | 1 |
| `webhook.delivery_failed` （連続失敗で記録。1 回ごとではない） | info | 2 |

### 通話（`call`）

| action | severity | Phase |
|---|---|---|
| `call.started` / `call.ended` （参加者、時間） | info | 2 |
| `call.transcription_started` / `call.recording_started` | notice | 2 |
| `call.screen_share_started` | info | 3 |

### データの持ち出し（`data`）

| action | severity | Phase |
|---|---|---|
| `data.account_exported` （本人のデータ書き出し） | warning | 1 |
| `data.account_deleted` | critical | 1 |
| `data.file_downloaded` （ファイル共有導入後） | info | 3 |
| `data.public_link_created` / `data.public_link_revoked` | warning | 3 |
| `audit.exported` / `audit.viewed` （監査ログを見た・書き出したこと自体） | notice | 1 |

### セキュリティ（`security`）

| action | severity | Phase |
|---|---|---|
| `security.webhook_signature_invalid` （受信 Webhook の署名不一致） | warning | 1 |
| `security.permission_denied` （管理 API への権限不足アクセス） | warning | 1 |
| `security.anomaly` （§9 の検知結果。`details.reason`） | critical | 3 |

---

## 5. 記録の仕組み

### 書き込み口は一つ

`worker/src/audit.js` の `audit(env, req, event)` だけが書く。

- ルートのハンドラは、成功・拒否の直後に 1 行呼ぶ。
- `req` から context を作る:
  - `CF-Connecting-IP` → `ip_address`
  - `request.cf.country` → `country`
  - `User-Agent` → `ua`
  - `cf-ray` → `request_id`
  - `X-Client`（Web / iOS が自己申告）→ `client`
  - 認証済みなら session / api_token の ID
- 書き込み方は操作の重さで分ける。
  - **権限・鍵・役割など、重いもの**（severity が `warning` 以上）は、変更と同じ `db.batch([...])` で書く。変更だけ成功して記録が残らない、という状態を作らないため。
  - **それ以外**は `ctx.waitUntil()` で応答の後に書く。応答を遅くしない。
- Durable Object（`OrgRelay`）経由の操作は `state.waitUntil` で書く。Jam の開始・終了、WebSocket 経由のカード決定がこれに当たる。

### テーブル（D1）

```sql
CREATE TABLE IF NOT EXISTS audit_events (
  org_id        TEXT NOT NULL,
  seq           INTEGER NOT NULL,          /* ワークスペースごとの連番。欠番＝削除の痕跡 */
  id            TEXT NOT NULL UNIQUE,      /* aud_ + ULID */
  created_at    INTEGER NOT NULL,          /* unix 秒 */
  action        TEXT NOT NULL,
  category      TEXT NOT NULL,
  severity      TEXT NOT NULL,
  outcome       TEXT NOT NULL,
  actor_type    TEXT NOT NULL,
  actor_id      TEXT,
  entity_type   TEXT,
  entity_id     TEXT,
  body          TEXT NOT NULL,             /* §3 の JSON（個人情報は §8 の方式で暗号化済み） */
  prev_hash     TEXT,
  hash          TEXT,                      /* 封印（§7）されるまで NULL */
  PRIMARY KEY (org_id, seq)
);
CREATE INDEX IF NOT EXISTS idx_audit_time   ON audit_events(org_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_action ON audit_events(org_id, action, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_actor  ON audit_events(org_id, actor_id, created_at);
CREATE INDEX IF NOT EXISTS idx_audit_entity ON audit_events(org_id, entity_id, created_at);
```

- **連番の採番**
  - D1（SQLite）は書き込みが直列なので、一文の `INSERT … SELECT COALESCE(MAX(seq), 0) + 1 FROM audit_events WHERE org_id = ?` で採番すれば競合しない。
  - `PRIMARY KEY (org_id, seq)` の衝突は、万一に備えて 3 回まで再試行する。
- **書き込み専用**
  - アプリのコードに `UPDATE audit_events` と `DELETE FROM audit_events` を置かない。例外は封印（`hash` を埋める）と、保持期間での削除（§8）の 2 か所だけ。
  - テストで grep して守る（`test/audit-immutable.test.js`）。
- **既存の `sessions` に足す列**: `ip`, `user_agent`, `last_seen_at`, `client`。セッション一覧と強制ログアウト（§10）に使う。

---

## 6. 読む：API と管理画面

### API（Slack 互換）

```
GET /audit/logs?orgId=…&oldest=…&latest=…&limit=…&action=a,b&actor=…&entity=…&category=…&severity=…&cursor=…&format=slack|native
→ { "entries": [ … ], "response_metadata": { "next_cursor": "…" } }

GET /audit/actions   → action の一覧と説明、category、severity
GET /audit/schemas   → entity の型一覧
GET /audit/verify?from=seq&to=seq → チェーン検証の結果（§7）
```

- **権限**
  - Owner / Admin のセッション、または `audit:read` スコープ付きの API キー。
  - `api_tokens` に `scopes TEXT`（JSON 配列）を足す。既存のキーは `["*"]` として扱い、`audit:read` は明示したキーだけに与える。
- **並び・ページング**: 新しい順。`limit` は最大 1000。`cursor` は `(created_at, seq)` を不透明に符号化したもの。
- **見た記録も残す**: 監査ログを見たこと自体を `audit.viewed` として記録する（1 時間に 1 回へ丸める）。

### 管理画面（Studio →「セキュリティ」→「監査ログ」）

- **一覧**: 日時、人（顔）、操作（人が読める文。例: 「Toru が Gota を Admin にした」）、対象、場所（国・クライアント）。
- **絞り込み**: 期間、人、カテゴリ、重大度、対象。URL に保存し、共有できる。
- **詳細**: 1 行を開くと JSON をそのまま見られる。前後の操作も並べる。
- **書き出し**: CSV / JSONL。同期上限は 10 万件で、それを超えるものは R2 から非同期に作ってメールで知らせる。
- **表示範囲**: Owner / Admin にだけ表示する。Member には「自分のセッション」と「自分のデータの書き出し」だけを見せる。

---

## 7. 改ざん検知：封印とアーカイブ

書き込みを速く保つため、ハッシュは書き込み時ではなく、**封印** の段階で付ける。

1. **封印**
   - 1 分ごとの Cron（既存の `scheduled.js`）で、ワークスペースごとに `hash IS NULL` の行を `seq` 順に処理する。
   - `hash = SHA-256(prev_hash ‖ canonical_json(row))` を計算して埋める。
   - `canonical_json` はキーをソートし、空白を入れない JSON。
2. **アーカイブ**
   - 1 時間ごとに、その時間の行を JSONL.gz にまとめて R2 に置く: `audit/<org>/<yyyy>/<mm>/<dd>/<hh>.jsonl.gz`。
   - 同時にダイジェスト `…/<hh>.digest.json` を置く。中身は `{first_seq, last_seq, last_hash, count}` と、その Ed25519 署名。
   - 署名鍵は Worker のシークレット `AUDIT_SIGNING_KEY`。公開鍵は `GET /audit/public-key` で配る。
3. **WORM 化**
   - R2 の Bucket Lock を、`audit/` プレフィックスに保持期間付きで設定する（既定 400 日、Enterprise では契約で延長）。
   - 保持期間中は、管理者でも削除・上書きできない。
4. **検証**
   - `GET /audit/verify` は D1 の行からチェーンを再計算し、R2 のダイジェストと突き合わせて `{ok, first_broken_seq}` を返す。
   - 欠番、ハッシュ不一致、ダイジェスト署名不一致のどれでも失敗する。
   - 週に一度の Cron でも自動検証する。失敗すれば `security.anomaly`（critical）を記録し、Owner にメールする。

---

## 8. 保持期間と個人情報

### 保持期間

| プラン | D1（画面・API で検索可能） | R2 アーカイブ（WORM） |
|---|---|---|
| Free | 監査ログ機能なし（本人のセッション一覧のみ） | — |
| Business | 180 日 | 1 年 |
| Enterprise | 1 年（延長可） | 7 年まで、契約で指定 |

- 保持期間を過ぎた D1 の行は、日次 Cron で削除する。削除の事実も `system` の記録として残す（`audit.pruned`、範囲と件数）。
- リーガルホールドが掛かったワークスペースや人の行は、期間を過ぎても消さない（§10）。

### 個人情報：crypto-shredding

- 監査ログの中の個人情報は `email`、`ip_address`、`ua`、名前の 4 種。これらは人ごとのデータ鍵（AES-GCM）で暗号化してから `body` に入れる。
  - 鍵は `audit_principal_keys(principal_id, wrapped_key)` に置き、マスター鍵（シークレット）で包んでおく。
- アカウントを削除したら、その人の鍵を捨てる。
  - 記録は「削除されたユーザー（gh:12345）」として残り、チェーンは暗号文の上で検証が通り続ける。
  - 「誰の操作だったか」は ID で追えるが、個人を特定する情報は復元できない。
- 本文は最初から入れない（§1）。メッセージ・カード・コメントの本文、AI への入力、API キーや Webhook の秘密の値は記録しない。
  - 記録するのは ID と、必要ならタイトルの先頭 40 字まで。Webhook の URL はホスト名だけ。
- テストで守る:
  - 監査イベントの `body` に、テスト用の本文文字列と秘密の値が出てこないこと（`test/audit-privacy.test.js`）。

---

## 9. 外へ流す：SIEM 連携

- **プッシュ**
  - 管理画面で配信先を登録する。種類は HTTPS エンドポイント、Splunk HEC、Datadog Logs。
  - 1 分ごとに、封印済みの行をまとめて送る。署名は既存の `honmaru-signature: t=…,v1=…`（`webhooks.js` と同じ方式）。
  - 失敗したら、指数バックオフで 24 時間まで再送する。そのあいだも `seq` で「どこまで届いたか」を持つので、欠落しない。
- **プル**
  - `GET /audit/logs` をカーソルで回す（Slack と同じ運用ができる）。
  - R2 のアーカイブを、S3 互換 API の読み取り専用キーで直接取得することもできる（Enterprise）。
- **異常検知（Phase 3）**。ルールベースで始める。
  - 普段と違う国・ASN からのログイン
  - 短時間の大量書き出しや API 呼び出し
  - 管理者権限の連続付与
  - 深夜帯の API キー作成
  - 検知結果は `security.anomaly` として同じストリームに流す（Slack の anomaly と同じ位置づけ）。

---

## 10. 企業向けロードマップ（監査ログの周辺）

監査ログだけでは「会社で使える」にならない。Slack Enterprise の標準装備に合わせて、周辺も順に揃える。

| 機能 | 内容 | 前提 | Phase |
|---|---|---|---|
| **セッション管理** | 自分と、管理者なら全員のセッション一覧（端末、IP、最終利用）と強制ログアウト。セッション寿命のポリシー（Web / モバイル別） | `sessions` の列追加 | 1 |
| **API キーのスコープ** | `read`、`write`、`audit:read`、`admin`。キーごとに付け、画面で表示する | `api_tokens.scopes` | 1 |
| **役割の整理** | Owner / Admin / Member / Guest（単一チャネルのみ）。管理 API の権限表を一か所にまとめる | 非公開チャネル | 2 |
| **SSO（SAML 2.0 / OIDC）** | Okta、Entra ID、Google Workspace。ドメインを確認したうえで SSO を強制する | ドメイン所有確認（DNS TXT） | 3 |
| **SCIM 2.0** | IdP からのユーザー作成・停止・グループ同期。停止と同時に全セッションを失効させる | SSO | 3 |
| **ドメイン参加・招待制限** | 社外ドメインの招待禁止、承認制。**実装済み**（`governance.js` の `inviteGate`。誰でも / 確認済みドメインの人だけ / それ以外は管理者の承認後。社外ゲストは許可するかを選べる） | ドメイン確認 | 2 |
| **データの書き出し（管理者）** | ワークスペース全体のコンプライアンス書き出し。**実装済み**（Owner のみ、再認証と理由が必須。期間と人で絞り、プライベートチャンネルと DM を含む JSON Lines を 7 日間保管。作成とダウンロードを critical で記録し、Owner 全員に通知） | 監査ログ（書き出し自体を記録） | 3 |
| **リーガルホールド** | 指定した人・チャネルのメッセージと監査ログを、保持期間に関係なく保全する。**実装済み**（監査ログは運用者の窓口、メッセージは Owner が Studio から。ホールド中の人・チャンネルのメッセージは、編集・削除の前の文面を `message_history` に残し、書き出しにだけ含める） | 保持期間ポリシー | 3 |
| **保持期間ポリシー** | メッセージ、ファイル、文字起こしの自動削除期間（チャネルの種類別）。**実装済み**（公開・非公開チャンネル、DM、ファイルごとに 1 日〜10 年か無期限。毎日 05:xx に削除。ホールド中のものと、新しい返信が残っているスレッドの親は消さない） | — | 3 |
| **IP 許可リスト** | 管理 API と、必要ならアプリ全体への接続元制限。**実装済み**（キーごとの制限に加え、ワークスペース全体の許可リスト。すべてのワークスペース要求の入口 `policyDenial` とソケット参加で確かめる。保存する Owner 自身のアドレスが入っていなければ拒否し、締め出しを防ぐ） | — | 3 |
| **DLP** | 送信前の機密パターン検知（マイナンバー、カード番号など）と、警告またはブロック。**実装済み**（`worker/src/dlp.js`、Studio の「データルール」）。メッセージの投稿・編集・日報の投稿で読み、添付ファイル（テキスト、Word・Excel・PowerPoint の本文、PDF の文字）も読む。PDF は `worker/src/pdfText.js` がページの内容ストリームとフォントの ToUnicode から文字を取り出す（スキャンした画像の PDF と暗号化された PDF は読まない）。監査ログにはルール名と該当ファイルの数だけを残す | — | 4 |

---

## 11. 段階と作業量の見積もり

**Phase 1 — 記録と閲覧（約 1.5 週）**

- `audit_events`、`audit.js` を作り、§4 の Phase 1 の action（約 45 種）を各ルートに入れる。
- `GET /audit/logs`、`/audit/actions` と、管理画面の一覧・絞り込み・CSV 書き出しを作る。
- `sessions` の列を追加し、セッション一覧と強制ログアウトを作る。
- `api_tokens.scopes` を足し、`audit:read` を導入する。
- テスト: action ごとの記録テスト、権限テスト（Member は読めない）、本文と秘密が入らないテスト。

**Phase 2 — 改ざん検知と外部連携（約 1.5 週）**

- 封印 Cron、R2 アーカイブ、Ed25519 ダイジェスト、Bucket Lock を作る。
- `/audit/verify` と週次の自動検証を作る。
- crypto-shredding を入れ、アカウント削除と連動させる。
- SIEM プッシュ（HTTPS / Splunk HEC / Datadog）と、保持期間の Cron を作る。

**Phase 3 — 企業統制（別計画）**

- 異常検知、SSO / SCIM、リーガルホールド、保持期間ポリシー、IP 許可リスト。

---

## 12. 決めておくこと（未決事項）

1. 監査ログを Business プランから出すか、Enterprise 限定にするか。
   - Slack は Enterprise 限定。中小企業の監査対応を考えると、Business で 180 日を出すのが差別化になる。
2. `agent.tool_called` の読み取り系の扱い。全件記録すると量が多いので、書き込み系だけを 1 件ずつ記録し、読み取りは 1 時間ごとの集計行にする案。
3. ワークスペースをまたぐ組織（複数ワークスペースをまとめる「Org」）を作るか。
   - Slack の Audit Logs は組織単位。今は 1 ワークスペース = 1 監査範囲とし、Org は SSO と一緒に Phase 3 で考える。
4. 監査ログの表示言語。
   - action 名は英語で固定する（SIEM のため）。画面の文だけを `serverCopy.js` の 5 言語で出す。
