# TikTok for Work — デザイナー向け プロジェクト概要 / 引き継ぎドキュメント

最終更新: 2026-08-07
対象読者: このプロダクトのUI/UXをこれから作るデザイナー
英語版: [DESIGN_HANDOFF.en.md](./DESIGN_HANDOFF.en.md)

---

> ## ⚠️ 最初に読んでください（2点）
>
> ### 1. UIは確定していません
>
> **現在のUIはモックアップ段階です。デザインシステムもクオリティラインも、まだ何も確定していません。**
> このドキュメントに書かれている色・サイズ・余白は「実装が今こうなっている」という**現状report**であって、
> **守るべき仕様ではありません**。デザインシステムをゼロから定義するのが、これからの仕事です。
>
> ### 2. 6本のブランチが並走していて、デザイン方向が3つに分かれています
>
> `main` にはまだ何もマージされていません。開発は6本のブランチで並行して進んでおり、
> **互いに矛盾する3つのデザイン方向**が同時に存在します。
> **最初の仕事は「どれを採るか決めること」です。** 詳細は §3。

---

## 1. プロダクト概要

### 一言でいうと

**「メッセージではなく、意思決定を届ける」チーム向けAIネイティブ・ワークプラットフォーム。**

Slackのようにチャンネルやスレッドで人間同士が直接やりとりするのではなく、**ユーザーは自分専属のAIとだけ話す**。AI同士が組織の情報をもとに宛先を判断し、受け手には「判断しやすい形に再構成されたDecision Card（意思決定カード）」だけが届く。

### 解決したい課題

| 既存ツールの課題 | このプロダクトの答え |
|---|---|
| チャンネルが増え続ける | チャンネルという概念自体が存在しない |
| 通知過多で重要情報を見落とす | 「今あなたが決めるべきカード」だけが1枚ずつ届く |
| 誰が何を見ているか分からない | AIが組織グラフから宛先を決定し、理由も表示する |
| 誰が決めるべきか分からない | カードに「なぜあなたなのか（Why you）」が必ず付く |
| 決定が会話に埋もれる | 決定は自動的にGitHub Issueとして記録される |
| 同じ説明を何度もする | AIが受け手の役割に合わせて再構成する |

### コアループ（全ブランチ共通の心臓部）

```
送信者が自分のAIに自然文で指示
   ↓  「Tell your AI」入力
AI が意図・宛先・優先度・カード種別を判断（組織グラフ + LLM）
   ↓  送信前に下書きを確認
受け手のフィードに Decision Card として届く（リアルタイム）
   ↓  縦スクロールで1枚ずつ表示
受け手が判断する（承認 / 却下 / 修正依頼 / 委任）
   ↓  スワイプ or ボタン
GitHub Issue が作成され、結果が送信者側に反映される
```

**これはどのブランチでも変わっていません。** ここが体験の中心で、他はすべてこれを支える要素です。

---

## 2. 組織とメンバー

初期メンバーは実在の2名:

| メンバー | 役割 |
|---|---|
| Toru | CEO |
| Gota | PM |

- メンバー追加はアプリ内から（名前 / 役割 / GitHubユーザー名 / 上長）
- 追加した瞬間に全端末へ同期され、そのメンバーは**すぐにAIのルーティング対象になる**
- 各メンバーには専属のAIエージェントが自動的に紐づく（`〇〇's AI`）
- AIは「人」ではなく「役割」でルーティングする（デザイン→デザイナー、開発→エンジニア、予算/採用→CEO）。コードを触らずに人を増やせる

> **ブランチ差分**: この「サーバが名簿を持ち、アプリから追加する」形は
> `designer-project-handoff-docs` / `cross-platform-strategy` / `current-features-gaps` の
> 3ブランチが**独立に同じ結論**に到達しています。一方 `3sec-value-onboarding` は
> まだ旧来の固定4名（Alice/Bob/Carol/Dana）のままです。

---

## 3. リポジトリ現況マップ（★このドキュメントの核心）

### 3.1 ブランチ一覧

`main` = `a2d907b`。**どのブランチもマージされていません。**

| ブランチ | 最終更新 | 規模 | 中身 | デザイン方向 |
|---|---|---|---|---|
| `cross-platform-strategy` | 8/7 | 7commit / 85ファイル | 新バックエンド（Hono + SQLite + zodスキーマ）、Webクライアント、**クラシックチャットモード**（チャンネル+DM、Feed/Chat切替）、@メンション、エージェントメモリ、SLAエスカレーション、通知。iOSはシンクライアント化 | **A. ダーク現行**（変更なし） |
| `designer-project-handoff-docs`（このブランチ） | 8/7 | 2commit / 30ファイル | 実メンバー名簿（Toru/Gota）+ アプリ内メンバー追加、役割ベースルーティング、本ドキュメント | **A. ダーク現行**（変更なし） |
| `app-store-connect-cli` | 8/6 | 1commit / 7ファイル | `asc` CLIによるリリースパイプライン（TestFlight・審査提出） | — |
| `3sec-value-onboarding` | 8/4 | 6commit / 28ファイル | 5画面オンボーディング（価値→仕組み→体験→サインイン→本人確認）、AG-UIプロトコル採用 | **B. ライト "white marble"** |
| `honmaruai-revenuecat-sdk` | 8/3 | 1commit / 17ファイル | RevenueCatによる課金（Pro）、ペイウォール、ルーティング回数クォータ | — |
| `current-features-gaps` | 8/1 | **31commit / 157ファイル** | 最大規模。Webクライアント（React/Vite・PWA・Web Push・E2E）、チャンネル、Notion連携、autopilot、音声入力、プッシュ通知、設定画面、台帳（ledger）ビュー | **C. design v3 "calm"** |

### 3.2 3つのデザイン方向（**ここが最大の分岐**）

| | **A. ダーク現行** | **B. ライト "white marble"** | **C. design v3 "calm"** |
|---|---|---|---|
| **どこ** | main / cross-platform / このブランチ | 3sec-value-onboarding | current-features-gaps |
| **性格** | 仮置き。デザインの根拠なし | ClickUp風・高コントラスト生産性 | 静けさ・意味のある色だけ |
| **背景** | `#000000` | `#FFFFFF`（画面の95%） | 適応 `#FBFBFC` / `#0B0C0E` |
| **サーフェス** | `#0C0C0E` / `#161618` | `#F8F9FA` / `#E9EBF0` / `#EEEEEE` | 適応 `#FFFFFF` / `#141518` |
| **アクセント** | `#5E6AD2` | violet `#6647F0`（バッジ専用）+ blue `#0091FF`（操作系） | 適応 `#4F5BD5` / `#7C8CF8` |
| **主要CTA** | 白地に黒文字 | **黒 `#202020` 塗りのpill**（violetは使わない） | アクセント色 |
| **タイトル** | 26 / medium | Plus Jakarta Sans 650–800、48px+でtracking −0.04em | **21 / semibold** |
| **本文** | 17 | Inter | **15** |
| **角丸** | 6 / 10 | **ボタン9999（pill）** / カード12 / 大カード20 / 入力9 | 6 / 8 / 12 / 16 |
| **境界表現** | 面の段差（線なし） | **1px `#E8E8E8` の線**（影ではなく線で階層） | 余白と文字ウェイト |
| **モーション** | easeOut 0.15–0.25s | 0.45s `cubic-bezier(0.33,1,0.68,1)`、hover 0.15s | easeOut系 |
| **ライト/ダーク** | ダーク固定 | ライト固定 | **System/Dark/Light 切替対応** |
| **仕様書** | なし | `docs/design-system.md` あり（最も詳細） | Theme.swift内のコメント + `web/src/styles/tokens.css` と同期 |

**特記事項**
- **B** は唯一まとまったデザインシステム仕様書を持ち、CSSトークンまで定義されている。完成度は最も高い
- **C** は唯一ライト/ダーク両対応で、iOSとWebでトークンを同期している。「v2は騒がしかった」という反省から作られた第3世代
- **A** は単なる出発点で、誰も意図的にデザインしていない
- **B と C は完全に非互換**（白地pill vs 適応トーン、Plus Jakarta Sans vs システムフォント）。**両方は採れません**

### 3.3 アーキテクチャも2方向に分岐

| | **1. クライアント主導** | **2. サーバ主導（シンクライアント）** |
|---|---|---|
| どこ | main / 3sec / このブランチ | cross-platform（`backend/`）/ current-features-gaps（`server/` + `web/`） |
| ロジックの場所 | Swiftクライアントがカード生成・GitHub同期・状態遷移を持つ | サーバが全ドメインロジックを持ち、クライアントは意図を送って状態を描くだけ |
| プロトコル | ゆるいJSON | zodスキーマ（cross-platform）/ AG-UIイベント（3sec） |
| 他プラットフォーム | iOSのみ | Web実装あり。デスクトップ/Androidを想定した設計 |

**デザインへの影響**: 方向2を採ると、**iOSとWebで同じデザインシステムを共有する必要がある**（現に C はトークンをiOS/Web間で同期している）。1画面だけ設計すればいい話ではなくなります。

### 3.4 その他の未統合機能

デザインが必要だが、どのブランチにも統合されていないもの:

| 機能 | どこにある | デザイン状況 |
|---|---|---|
| オンボーディング（5画面） | 3sec | white marbleで実装済み |
| チャットモード（チャンネル/DM） | cross-platform, current-features-gaps | 実装のみ、方向Aのまま |
| 課金・ペイウォール | revenuecat | 実装のみ |
| 設定画面 | current-features-gaps | design v3で実装済み |
| 通知・SLAエスカレーション | cross-platform, current-features-gaps | 実装のみ |
| 音声入力 | current-features-gaps | 実装のみ |
| Webクライアント | cross-platform, current-features-gaps | それぞれ別デザイン |

---

## 4. デザイナーが最初に決めるべきこと

優先度順。1〜3が決まらないと他が進みません。

1. **デザイン方向をA/B/Cから決める（またはゼロから作る）**
   - B（white marble）を採る → 仕様書があるので早い。ただしライト固定
   - C（design v3 calm）を採る → ライト/ダーク両対応、Web同期済み。ただし仕様書はコード内コメントのみ
   - ゼロから作る → 一番自由。ただしすでにある実装を全部書き換えることになる
2. **どのブランチを土台にするか** — デザイン方向とアーキテクチャの両方が付いてくる。事実上、方向1と2の選択でもある
3. **対象プラットフォームの範囲** — iOSのみか、Webも含むか。デザインシステムの作り方が変わる
4. **Decision Card の情報設計** — プロダクトの中心。何を最初に見せ、何を畳むか
5. **組織グラフの可視化** — データ（人・AI・チーム・上長関係）は揃っているのに、画面はどのブランチでもリストのまま。プロダクトの主張を最も体現できる場所
6. **メンバーが増えたときの設計** — 現状は2〜4人前提の見え方。10人・50人でのフィード、委任先選択、組織画面
7. **アイデンティティ表現** — アバターなし、送信者は「From 〇〇」のテキストのみ。各メンバーのAIエージェントの見せ方も未定
8. **アクセシビリティ方針** — 全ブランチでフォントサイズは固定（Dynamic Type非対応）、VoiceOverラベルもほぼ無し、タップ領域も44pt未満の箇所あり
9. **言語** — 全ブランチ英語のみ、ローカライズ機構なし

---

## 5. 画面一覧（このブランチの現状 = 方向A）

他ブランチはこれに画面を足した形になっています（オンボーディング5画面、設定、チャンネル、通知、ペイウォール等）。

```
RootView                                 起動時の分岐
├─ 復元中インジケータ                     「Restoring session…」
├─ AuthView                              未ログイン時
│  ├─ GitHubサインイン
│  ├─ リポジトリ選択
│  └─ 「You」= 組織内の自分を選ぶ / Add member
└─ FeedView                              ログイン後のホーム（唯一の常設画面）
   ├─ 上部バー: ユーザー名 + 接続ドット / ページドット / ⋯メニュー
   ├─ カード領域: DecisionCardView を縦ページングでフルスクリーン表示
   ├─ 下部: リポジトリ名 + 「Tell your AI」ComposeBar
   └─ モーダル群（すべて sheet）
      ├─ AIInputSheet          AIへの指示入力 + 優先度指定
      ├─ DraftReviewSheet      AIが作った下書きの確認・送信
      ├─ CardDetailSheet       カード詳細（Why you / Context / Routing / GitHub）
      ├─ ReviseSheet           修正依頼メモの入力
      ├─ DelegatePickerSheet   委任先の選択（名簿から）
      ├─ UserSwitcherSheet     自分の切り替え + Add member
      ├─ OrgGraphView          組織（People / Agents / Teams / Relationships）+ Add member
      └─ AddMemberSheet        メンバー追加（名前 / 役割 / GitHub / 上長）
```

オーバーレイ: `ProcessingOverlay`（全画面暗転 + スピナー）/ `DraftingBanner`（上部からスライドイン）

### Decision Card の現在の要素順序（**再設計の主戦場**）

1. メタ行 — カード種別 `·` 優先度 `·` 相対時刻
2. 送信者 — 「From 〇〇」+ エージェント経路（「〇〇's AI → △△'s AI」）
3. **Why you ボックス** — ルーティング理由
4. タイトル
5. サマリー
6. コンテキスト（`ラベル: 値 · ラベル: 値`）
7. 「View details」リンク
8. GitHub Issue リンク（作成済みのとき）
9. ステータスラベル（未処理でないとき）
10. アクションブロック — 承認 / 却下・修正・委任 / スワイプヒント

---

## 6. インタラクション（方向Aの現状値）

| 対象 | 現状 |
|---|---|
| フィードのページング | `.scrollTargetBehavior(.paging)` — 1スワイプ1カード |
| カードのスワイプ判定 | 最小ドラッグ20pt、確定しきい値 96pt |
| スワイプ右 / 左 | Issue作成 / 却下 |
| スワイプヒント | ドラッグ24pt超で表示、不透明度は移動量に比例 |
| アニメーション | すべて easeOut 0.15〜0.25s |
| ハプティクス | `light`（タップ・優先度変更）と `success`（確定操作）の2種 |

**処理中の扱いが2種類ある点は、意図的な設計として引き継ぐ価値があります**:
- AIの下書き生成 → **ブロックしない**。上部バナーだけ出してフィードは操作可能
- GitHub同期などの確定操作 → **ブロックする**。全画面オーバーレイ

---

## 7. コピー（文言）

### トーン（全ブランチ共通）

- 「Tell your AI」であって「Send message」ではない
- 「Decision recorded」であって「Message sent」ではない
- センテンスケース。短く。修飾語を入れない
- タグライン: **「Decisions, not messages」**

### ステータスの表示名

内部の状態名とは意図的に変えています。

| 内部状態 | 表示 |
|---|---|
| `pending` | Pending |
| `approved` | Issue created |
| `rejected` | Declined |
| `revised` | Revision requested |
| `delegated` | Delegated |
| `completed` | Closed on GitHub |

カード種別: Approval / Delegation / **Update**（内部名は `notification`）/ Task / Revision

### AIが生成する文言の制約（サーバ側プロンプトで規定）

カードの本文はLLMが書きます。**レイアウトの文字数見積もりはこの制約が根拠になります。**

| フィールド | 制約 |
|---|---|
| title | **3〜8語**、動作を表す表現 |
| summary | **1〜2文**、三人称、受け手が何を決める/やるのか |
| context | **2〜4個**の `ラベル: 詳細` を ` · ` で連結 |
| routingReason | **1文**、なぜこの人が決めるのか |
| labels | 任意。GitHub風のラベル |

この制約自体もデザイン都合で変更できます（`server/agentTools.js`）。

---

## 8. セットアップ

### 必要なもの

- macOS + Xcode 16 以降 / Node.js / [XcodeGen](https://github.com/yonaskolb/XcodeGen)（`brew install xcodegen`）/ GitHubアカウント

### 手順（このブランチの場合）

```bash
# 1) リレーサーバを起動
cd server
cp .env.example .env
#   .env に GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET / OPENROUTER_API_KEY を記入
npm install && npm start          # http://127.0.0.1:8080

# 2) Xcode プロジェクトを生成して開く
cd .. && xcodegen generate && open TikTokForWork.xcodeproj
```

> 他のブランチはセットアップ手順が違います。`cross-platform-strategy` は `backend/`
> （Docker/Fly対応）、`current-features-gaps` は `server/` + `web/` の構成なので、
> それぞれのREADMEを参照してください。

### 2台で動かす

1. 端末A → GitHubサインイン → リポジトリ選択 → 自分として Toru を選択
2. 端末B → 同様にサインイン → Gota を選択
3. Toru で「Tell your AI」→ 自然文の指示を入力
4. Gota の画面にカードがリアルタイムで出る（上部バーの緑ドット＝接続中）
5. Gota が Create issue → GitHub に Issue が立ち、Toru 側に結果が戻る

メンバー追加は **Organization → Add member**。即座に両方に反映されます。

---

## 9. ファイルマップ（このブランチ）

```
TikTokForWork/
├─ Design/                     ← デザイントークンと共通部品。まずここ
│  ├─ Theme.swift                色・タイポ・スペーシング・角丸（※暫定値）
│  ├─ Components.swift           ボタン、チップ、ComposeBar、PrioritySlider、ContextInsight
│  ├─ ProcessingOverlay.swift    処理中オーバーレイ / 下書きバナー
│  ├─ AppLogo.swift / Haptics.swift / DateFormatting.swift
├─ Features/
│  ├─ Auth/AuthView.swift        ログイン + 自分の選択
│  ├─ Feed/
│  │  ├─ FeedView.swift          ホーム（上部バー / 下部chrome / シート管理）
│  │  ├─ DecisionCardView.swift  ★カード本体。スワイプ処理もここ
│  │  ├─ AIInputSheet.swift      AI入力 + DraftReviewSheet
│  │  ├─ CardDetailSheet.swift / ReviseSheet.swift
│  │  ├─ DelegatePickerSheet.swift / UserSwitcherSheet.swift
│  └─ Org/
│     ├─ OrgGraphView.swift      組織画面
│     └─ AddMemberSheet.swift    メンバー追加
├─ Models/                      カード・組織・ユーザーの型（表示名もここ）
├─ Data/OrgDirectory.swift      ★組織の名簿。初期メンバーと同期処理
├─ ViewModels/FeedViewModel.swift フィードの状態管理（処理中メッセージの文言もここ）
└─ Assets.xcassets/             アイコン、ロゴ、GitHubマーク（SVG）

server/
├─ members.js                   初期メンバー（Toru / Gota）とID採番
├─ agentTools.js                ★AIのプロンプトとカード生成の制約（文言の長さ規定）
└─ index.js                     WebSocketリレー + OAuth + 名簿API + AIルーティング
```

**文言を直したいとき**: UIの固定文言は各Viewファイル直書き。ステータス/種別の表示名は `Models/DecisionCard.swift`。処理中メッセージは `ViewModels/FeedViewModel.swift`。AI生成文の指示は `server/agentTools.js`。

### 他ブランチで見るべきファイル

| 見たいもの | ブランチ | パス |
|---|---|---|
| white marble デザインシステム仕様 | `3sec-value-onboarding` | `docs/design-system.md` |
| オンボーディング設計の考え方 | `3sec-value-onboarding` | `onboarding.md` |
| AG-UIプロトコル設計 | `3sec-value-onboarding` | `docs/agui-protocol.md` |
| design v3 のトークンと意図 | `current-features-gaps` | `TikTokForWork/Design/Theme.swift`（コメント）/ `web/src/styles/tokens.css` |
| クロスプラットフォーム設計 | `current-features-gaps` | `docs/CROSS_PLATFORM.md` / `docs/WEB_PLAN.md` |
| サーバ主導アーキテクチャの根拠 | `cross-platform-strategy` | `backend/README.md` |
| 課金設計 | `honmaruai-revenuecat-sdk` | `docs/revenuecat.md` |
| リリース手順 | `app-store-connect-cli` | `docs/app-store-release.md` |

---

## 10. 参考リンク

- [README.md](../README.md) — プロダクト概要・セットアップ・アーキテクチャ
- [PROGRESS.md](../PROGRESS.md) — 実装状況
- [design.md](../design.md) — 初期のデザインメモ（**現状と乖離。参考程度に**）
- [server/README.md](../server/README.md) — リレーサーバ、OAuth、名簿API、WebSocketプロトコル
