# 監査ログ Phase 2 — 退会者の匿名化、封印とアーカイブ、SIEM 配信、保持期間 — 詳細設計

作成日: 2026-09-26。状態: **すべて実装済み**。2-A・2-B（人ごとの鍵、暗号化形式、退会で鍵を捨てる、平文の行の移行）と、2-C 以降（封印とアーカイブ、SIEM 配信、保持期間とリーガルホールド）。

2-C 以降の実装での決めごと:
- 封印は 15 分 Cron のうち毎時 0〜14 分の回に、前の 1 時間分を `sealHour` で閉じる。JSONL を gzip して `audit/<org>/<yyyy>/<mm>/<dd>/<hh>.jsonl.gz` に置き、ダイジェスト（`from_seq`・`to_seq`・`first_hash`・`last_hash`・`prev_digest`・`archive_sha256`・`key_id`・`sig`）を同じ場所の `.digest.json` と `audit_seals` に残す。
- 置く前に同じキーがあるか確かめる（バケットのロックは上書きを拒むため、再実行で失敗しないように）。3 時間続けて封印できなければ運用アラート。
- 公開鍵は `/audit/public-key`、過去の鍵は `AUDIT_PAST_PUBLIC_KEYS`。`/audit/verify` は D1 の連鎖とアーカイブの両方を確かめる。毎週日曜に全ワークスペースを確かめ直す。
- D1 から消すのは `pruneAudit` だけで、封印済みで、保持期間を過ぎて、リーガルホールドが無い行だけ。
- 保持期間とホールドは運用者の窓口（`/ops/audit/settings`、`/ops/audit/principal-hold`、`OPS_TOKEN`）。人単位のホールドは退会しても鍵を残し（`shred_pending`）、解除した時に捨てる。
- SIEM 配信は毎分の Cron で `seq` 順に送る。失敗はバックオフし、24 時間続けば `audit.stream_failing`。秘密は `SSO_SECRET_KEY` で暗号化して読み返さない。Owner が Studio の監査ログ画面で追加・テスト・一時停止・再送する。

実装での決めごと:
- 仮名は `actor_id` / `entity_id` の列にそのまま入れる（別の列は足していない）。暗号化した行は `enc = 1`。
- 人ごとの鍵には `subject`（ワークスペースをまたいで同じ人を指す HMAC）を持たせ、アカウント削除で全ワークスペースの鍵をまとめて捨てる。
- 平文の行の移行はスクリプトではなく Worker の 15 分 Cron（`migrateLegacyAudit`）で、1 ワークスペースずつ 1 つのトランザクションで行う。区切りの署名は 2-C で足す。
- `AUDIT_MASTER_KEY` と `AUDIT_PSEUDONYM_KEY` は、無ければデプロイのワークフローが一度だけ作る（上書きはしない）。

前提: [enterprise-audit-log.md](enterprise-audit-log.md) の Phase 1 は #80 で実装済み。

> Phase 1 で「誰が・いつ・何をしたか」は残り、管理者が読めるようになった。Phase 2 で解くことは 4 つ。
>
> 1. **退会しても名前が残る**（個人情報保護法・GDPR の削除請求に応えられない）
> 2. **D1 の行はデータベース管理者なら消せる**（「消されていない」を第三者に示せない）
> 3. **社内の SIEM に流せない**
> 4. **無限にたまる**

---

## 1. いまの仕組み（Phase 1、#80）

- **`audit_events`**: `(org_id, seq)` が主キー。`body` は §3 形式の平文 JSON。
  - `hash = SHA-256(prev_hash ‖ "\n" ‖ seq ‖ "\n" ‖ canonical(body))` を書き込み時に計算する。
  - `actor_id` と `entity_id` はログイン（メールの人は `u:<アドレス>`）。
  - `body.context.ip_address` と `body.context.ua` も平文。
- **`audit()`**: 直前の行を読んでから書く（衝突したら 3 回まで再試行）。
- **`verifyChain()`**: D1 の行だけでチェーンを検証する。
- **読み出し**: `GET /audit/logs` と CSV / JSONL。画面は名前とメンバー ref で人を出す。
- **Cron**: `*/15 * * * *`（同期・自動化）と `* * * * *`（予約送信など）の 2 本。

---

## 2. 退会者の匿名化（crypto-shredding）

### 2.1 考え方

- 個人を特定できる値を、**人ごとの鍵**で暗号化してから `body` に入れる。
  - 対象: ログイン、メールアドレス、名前、IP アドレス、UA。
- 退会したら、その人の鍵を捨てる。
  - 暗号文は残るので、`seq` とハッシュのチェーンは切れない。
  - 中身は誰にも（運営にも）読めなくなる。
- 「誰の操作か」は、退会後も**仮名 ID**（`p_<16 桁>`、人ごと・ワークスペースごとに固定）で追える。同じ人の一連の操作だと分かるが、誰かは分からない。

### 2.2 データ

```sql
/* 監査ログの中の個人情報を守る、人ごとの鍵。鍵そのものはマスター鍵で包んで保存する。 */
CREATE TABLE IF NOT EXISTS audit_principal_keys (
  org_id        TEXT NOT NULL,
  principal     TEXT NOT NULL,          /* 仮名 ID: p_ + HMAC(AUDIT_PSEUDONYM_KEY, org_id‖login) の先頭 16 桁 */
  wrapped_key   TEXT,                   /* AES-KW(AUDIT_MASTER_KEY, 256bit データ鍵)。NULL = 破棄済み */
  created_at    TEXT NOT NULL,
  shredded_at   TEXT,                   /* 退会で鍵を捨てた時刻 */
  PRIMARY KEY (org_id, principal)
);
```

- `audit_events` に足す列:
  - `enc INTEGER NOT NULL DEFAULT 0`（0 = Phase 1 の平文、1 = 暗号化形式）
  - `actor_principal TEXT`、`entity_principal TEXT`（仮名 ID。絞り込みはこちらで行う）
- **Worker シークレット**:
  - `AUDIT_MASTER_KEY`（AES-KW 256bit）
  - `AUDIT_PSEUDONYM_KEY`（HMAC 256bit）
  - どちらも `wrangler secret put` で入れる。ローテーションは §2.6。

### 2.3 暗号化形式（enc = 1）

`body` の中で、人を指す部分を次の形に置き換える。

```json
"actor": {
  "type": "user",
  "principal": "p_3f9a1c0e5b7d2a41",
  "pii": { "k": "p_3f9a1c0e5b7d2a41", "iv": "<12 バイト b64>", "ct": "<AES-GCM(データ鍵, {\"id\":\"u:mika@x.jp\",\"name\":\"Mika\"}) b64>" }
}
```

- `context.ip_address` と `context.ua` は、操作した人（actor）の鍵で暗号化し、`context.pii` にまとめる。
- `country`、`client`、`request_id` は個人を特定しないので平文のまま（絞り込みと集計に使う）。
- `details` の中の個人情報（例: `member.removed` の対象の名前）は、ルートで入れないようにする。
  - 人を指すときは `entity` に入れる規則にする。
  - テスト（`test/audit-privacy.test.js`）で、details にメールや名前が出ないことを確かめる。
- ハッシュは**暗号文を含めた body** に対して計算する。鍵を捨てても検証は通る。

### 2.4 書く・読む・捨てる

- **書く**（`audit()`）:
  1. actor と entity の `principal` を HMAC で求める。
  2. `audit_principal_keys` から鍵を取り出して包みを解く（無ければ作る）。
  3. 暗号化してから連鎖に入れる。
  - 同じ Worker 実行内では、解いた鍵を 60 秒メモリに置く。
- **読む**（`GET /audit/logs`）:
  - 各 principal の鍵を解いて、名前とメンバー ref に戻して返す。
  - 鍵が捨てられた principal は `{ "type": "user", "name": null, "deleted": true, "principal": "p_…" }` と返し、画面では「削除されたユーザー（p_3f9a…）」と出す。
- **絞り込み**:
  - 「人で絞る」は、画面から来たメンバー ref を principal に写してから `actor_principal = ?` で引く。
  - 退会者は principal でしか引けない。
- **捨てる**（アカウント削除 `deleteAccount` の中）:
  - その人の全ワークスペースの `audit_principal_keys.wrapped_key = NULL`、`shredded_at = 今` にする。
  - `audit.principal_shredded`（system、details に principal と件数）を記録する。
- **書き出しと SIEM**: 復号した形で出す（それを受け取った側の保管は、受け取った会社の責任）。
  - 捨てた後にアーカイブ（§3）から読み直しても、中身はもう読めない。

### 2.5 Phase 1 の平文の行をどうするか

`enc = 0` の既存の行は平文で、ハッシュも平文に対して計算されている。暗号化で書き換えると、チェーンが切れる。

1. **移行の区切りを残す**:
   - Phase 2 を出す時点で、各ワークスペースについて `audit.chain_migrated` を 1 行書く。
   - details に `{ legacy_last_seq, legacy_last_hash }` を入れ、§3 の Ed25519 で署名したダイジェストをアーカイブに置く。
   - 「ここまでの平文チェーンはこの値だった」ことを、署名で固定するため。
2. **平文の行を暗号化形式に書き換える**:
   - 1 回限りのマイグレーション（`scripts/audit-reencrypt.mjs`）で行う。
   - 書き換えた行のハッシュを計算し直し、新しいチェーンとして繋ぐ。
3. **検証**:
   - `verifyChain()` は `audit.chain_migrated` の行を区切りとして扱う。
   - 区切りより前は「署名済みダイジェストと一致するか」、後は通常のチェーンで検証する。
4. **この操作自体を残す**: `audit.chain_migrated` は critical として記録し、全 Owner にメールで知らせる。

移行前に退会した人の平文は、この書き換えの時点で鍵を作ってすぐ捨てる。暗号化したうえで読めなくする。

### 2.6 鍵のローテーション

- **`AUDIT_MASTER_KEY`**: 新旧 2 本を持てるようにする（`AUDIT_MASTER_KEY_NEXT`）。
  - `wrapped_key` に鍵 ID（`v1:` / `v2:`）を前置きしておく。
  - Cron が少しずつ新しい鍵で包み直し、全件が終わったら古い鍵を消す。
- **`AUDIT_PSEUDONYM_KEY`**: 変えると仮名 ID が変わるので、変えない。
  - 漏れた場合は、仮名 ID から人が推測されうるだけで、中身は読めない。

---

## 3. 封印とアーカイブ（改ざんを第三者に示す）

### 3.1 何を守るか

- D1 は運営が書き換えられる。行ごとのハッシュチェーンは「つながっているか」は示すが、全体を差し替えられたら分からない。
- そこで、一定時間ごとのダイジェストを**署名**し、**書き換えのできない保管場所**（R2 の Bucket Lock）に置く。
  - 保存期間中は運営を含め誰も消せず、公開鍵で誰でも検証できる。

### 3.2 R2 の置き場所

- **バケット**: 新しく `tiktokforwork-audit` を作る。
  - `MEDIA` とは分ける。Bucket Lock はバケット単位（またはプレフィックス単位）なので、画像の削除と混ぜないため。
- **Bucket Lock**: `audit/` プレフィックスに保存期間を付ける。
  - 既定は 400 日。Enterprise では契約で延長する。
  - 設定は `wrangler r2 bucket lock add tiktokforwork-audit --prefix audit/ --age 400d` で行い、手順は `docs/setup-secrets.md` に書く。
- **キー（オブジェクトのパス）**:
  - `audit/<org>/<yyyy>/<mm>/<dd>/<hh>.jsonl.gz` … その時間の行（暗号化形式のまま）
  - `audit/<org>/<yyyy>/<mm>/<dd>/<hh>.digest.json` … ダイジェスト（§3.3）

### 3.3 ダイジェスト

```json
{
  "v": 1,
  "org": "personal:…",
  "from_seq": 18201,
  "to_seq": 18234,
  "count": 34,
  "first_hash": "…",
  "last_hash": "…",
  "prev_digest": "<直前のダイジェストの SHA-256>",
  "archive_sha256": "<jsonl.gz の SHA-256>",
  "sealed_at": "2026-09-26T05:00:12Z",
  "key_id": "ed25519-2026-09",
  "sig": "<Ed25519(canonical(上のフィールド全部))>"
}
```

- ダイジェスト同士も `prev_digest` でつなぐ。1 時間分を丸ごと消されても、次の時間のダイジェストで分かる。
- **署名鍵**: Worker シークレット `AUDIT_SIGNING_KEY`（Ed25519 の PKCS8）。
  - Workers の WebCrypto は Ed25519 を扱える。
  - 公開鍵は `GET /audit/public-key` で配る（JWK、`key_id` 付き。過去の鍵も並べる）。
- **行がない時間**: ダイジェストは作らない（空の時間は `prev_digest` の連続性だけで足りる）。

### 3.4 封印の Cron

- 既存の `*/15 * * * *` の中で、毎時 0〜14 分の実行のときだけ走らせる（新しい Cron を足さない）。
- ワークスペースごとに、前の時間に `created_at` が入る行を `seq` 順に読む。
  - 読んだ行を JSONL にして gzip し、R2 に put する。put は `If-None-Match: *` で上書きを防ぐ。
  - ダイジェストを作って署名し、put する。
- `audit_seals(org_id, hour, to_seq, digest_sha256, sealed_at)` に記録し、同じ時間を二度封印しない。
- **失敗したとき**: 次の実行で再試行する。3 時間続けて失敗したら `audit.seal_failed`（critical）を記録し、運営にアラートを送る（既存の `alert.js`）。
- **量**: 1 回の実行で最大 20 ワークスペース × 1 時間分。溜まっていれば次の実行で続きを処理する。

### 3.5 検証

- **`GET /audit/verify?from=&to=`**（管理者、または `audit:read` のキー）:
  1. D1 の行でチェーンを検証する（Phase 1）。
  2. 範囲に入る時間の R2 アーカイブとダイジェストを読み、次を突き合わせる:
     - ダイジェストの署名
     - `archive_sha256`
     - `first_hash` / `last_hash` と D1 の行
     - `prev_digest` の連続
  3. 返り値: `{ ok, checked_rows, checked_hours, first_problem: { kind: "missing"|"hash"|"digest_sig"|"archive"|"gap", seq?, hour? } }`
- **週 1 回の自動検証**: 日曜 3 時（UTC）に、直近 8 日分を検証する。失敗したら `security.anomaly`（critical）を記録し、全 Owner にメールする。
- **オフライン検証**: 外部の監査人向けに `scripts/verify-audit-archive.mjs` を配る。R2 からダウンロードしたファイルと公開鍵だけで、Honmaru の API なしに検証できる。

---

## 4. SIEM 配信

### 4.1 データ

```sql
CREATE TABLE IF NOT EXISTS audit_streams (
  id            TEXT PRIMARY KEY,               /* as_ + 20 桁 */
  org_id        TEXT NOT NULL,
  kind          TEXT NOT NULL,                  /* https | splunk_hec | datadog */
  endpoint      TEXT NOT NULL,                  /* https のみ。私設アドレス不可（webhooks.js の validEndpoint と同じ規則） */
  secret        TEXT NOT NULL,                  /* https: HMAC 秘密 / splunk: HEC トークン / datadog: API キー。AES-GCM で暗号化 */
  region        TEXT,                           /* datadog のサイト（us1, eu1, ap1 …） */
  min_severity  TEXT NOT NULL DEFAULT 'info',
  categories    TEXT,                           /* JSON。NULL = すべて */
  delivered_seq INTEGER NOT NULL DEFAULT 0,     /* ここまで届いた */
  status        TEXT NOT NULL DEFAULT 'active', /* active | paused | failing */
  failures      INTEGER NOT NULL DEFAULT 0,
  next_try_at   TEXT,
  last_error    TEXT,
  created_by    TEXT NOT NULL,
  created_at    TEXT NOT NULL
);
```

### 4.2 送り方

- **Cron**: 既存の `* * * * *` の中で、`status = active` かつ `next_try_at` が過ぎたストリームごとに処理する。
  - `seq > delivered_seq` の行を最大 500 件読み、復号して §6 の Slack 互換形式にする。
  - 1 回で送り、成功したら `delivered_seq` を進める。
  - 行の順序（`seq`）で送るので欠けない。受け手の重複排除のため、各イベントに `id` と `seq` を付ける。
- **形式**:
  - `https`: 本文は JSONL。`honmaru-signature: t=…,v1=…`（webhooks.js の `sign` と同じ方式）。
  - `splunk_hec`: `POST <endpoint>/services/collector/event`、`Authorization: Splunk <token>`。1 イベントを `{time, host:"honmaru", source:"honmaru:audit", sourcetype:"_json", event}` にする。
  - `datadog`: `POST https://http-intake.logs.<site>/api/v2/logs`、`DD-API-KEY`。`ddsource: honmaru`、`service: audit`、`ddtags: org:<id>,severity:<s>`。
- **失敗したとき**: 指数バックオフ（1, 2, 4, 8 … 分、最大 60 分）で再試行する。
  - 24 時間続けて失敗したら `status = failing` にし、`audit.stream_failing`（warning）を記録して Owner にメールする。
  - その間の行は `delivered_seq` の後ろに残っているので、復旧すれば続きから届く。
  - D1 から保持期間で消えた行は、R2 のアーカイブから送り直せる（§4.3）。
- **テスト送信**: 設定画面の「テストを送る」で、`audit.stream_test` を 1 件だけ送る。

### 4.3 送り直し

- **`POST /audit/streams/:id/replay {fromSeq}`**: `delivered_seq` を巻き戻す。
- 巻き戻し先が D1 の最古の行より前なら、R2 のアーカイブから読んで送る。
- **権限と記録**: Owner だけが使える。`audit.stream_replayed`（notice）を記録する。

### 4.4 API と画面

```
GET    /audit/streams?orgId=
POST   /audit/streams          {orgId, kind, endpoint, secret, region?, minSeverity?, categories?}
PUT    /audit/streams/:id      {orgId, …}           （secret は上書きのみ、読み出せない）
POST   /audit/streams/:id/test {orgId}
POST   /audit/streams/:id/replay {orgId, fromSeq}
DELETE /audit/streams/:id?orgId=
```

- **画面**: Studio →「監査ログ」→「配信先」タブ。
  - 一覧（状態、最終送信、遅れの件数）、追加、テスト、一時停止、送り直し。
- **記録**: ストリームの追加・変更・削除はすべて `workspace.audit_stream_changed`（critical）として残す。

---

## 5. 保持期間

| プラン | D1（画面・API で読める） | R2（Bucket Lock） |
|---|---|---|
| Free | 30 日 | なし（封印しない） |
| Business | 180 日 | 400 日 |
| Enterprise | 365 日（契約で延長） | 7 年まで（契約で） |

- **設定**: `org_audit_settings(org_id, retention_days, archive, legal_hold, updated_by, updated_at)` で持つ。
  - 既定値はプラン（`entitlements.js`）から決める。
  - Owner は短くできない（契約・法令の下限を守るため）。延長は Enterprise の契約で運営が設定する。
- **日次の削除 Cron**（`*/15` の中で、毎日 4 時台の 1 回）:
  - `created_at < now - retention_days` かつ封印済み（`audit_seals` にある）の行を消す。
  - 封印されていない行は消さない（アーカイブの前に消えるのを防ぐ）。
  - 消した範囲と件数を `audit.pruned`（system）として記録する。
  - この削除は、Phase 1 で「アプリから `DELETE FROM audit_events` をしない」とした規則の、唯一の例外になる。テスト（`audit-immutable.test.js`）で、この関数以外に DELETE が無いことを grep する。
- **リーガルホールド**: `legal_hold = 1` の間は削除しない。
  - 対象: ワークスペース全体。人単位は §7 で扱う。
  - 設定と解除は運営だけが行う（顧客の法務からの依頼で）。`audit.legal_hold_changed`（critical）を記録する。
  - ホールド中も鍵の破棄（退会）は行う。個人の削除請求と、訴訟の証拠保全がぶつかる場合は法務判断とし、運営が `audit_principal_keys.shredded_at` を保留できるフラグ `hold` を足す。

---

## 6. 作業の順番と見積もり

| 段階 | 内容 | 目安 |
|---|---|---|
| 2-A | 人ごとの鍵、暗号化形式、読み出しの復号、退会で鍵を捨てる、テスト | 4 日 |
| 2-B | 平文の行の移行（区切りの署名、書き換え、検証の区切り対応） | 2 日 |
| 2-C | R2 のバケットと Bucket Lock、封印 Cron、Ed25519 ダイジェスト、公開鍵、`/audit/verify` の拡張、週次の自動検証、オフライン検証スクリプト | 5 日 |
| 2-D | SIEM 配信（https / Splunk HEC / Datadog）、送り直し、画面 | 4 日 |
| 2-E | 保持期間の Cron、プラン別の既定値、リーガルホールド | 2 日 |

**2-A は最優先**: 退会者の名前が残る問題を塞ぐため。プライバシーポリシーの更新（`docs/privacy-policy.md`）も同じ PR で行う。

---

## 7. 次の段階

- **異常検知**（ルールベース）:
  - いつもと違う国からのログイン
  - 短時間の大量書き出し
  - 管理者権限の連続付与
  - 深夜の API キー作成
  - どれも `security.anomaly` として同じストリームに流す。
- **人単位のリーガルホールド**
- **顧客自身の鍵（BYOK）**: `AUDIT_MASTER_KEY` の代わりに、顧客の KMS（AWS KMS / Cloud KMS）で包む。
