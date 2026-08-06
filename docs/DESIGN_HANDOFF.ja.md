# TikTok for Work — デザイナー向け プロジェクト概要 / 引き継ぎドキュメント

最終更新: 2026-08-06
対象読者: このプロダクトのUI/UXを引き継ぐデザイナー
英語版: [DESIGN_HANDOFF.en.md](./DESIGN_HANDOFF.en.md)

---

## 1. プロダクト概要

### 一言でいうと

**「メッセージではなく、意思決定を届ける」チーム向けAIネイティブ・ワークプラットフォーム。**

Slackのようにチャンネルやスレッドで人間同士が直接やりとりするのではなく、**ユーザーは自分専属のAIとだけ話す**。AI同士が組織図をもとに宛先を判断し、受け手には「判断しやすい形に再構成されたDecision Card（意思決定カード）」だけが届く。

### 解決したい課題

| 既存ツールの課題 | 本プロダクトの答え |
|---|---|
| チャンネルが増え続ける | チャンネルという概念自体が存在しない |
| 通知過多で重要情報を見落とす | 「今あなたが決めるべきカード」だけが1枚ずつ届く |
| 誰が何を見ているか分からない | 送信はAIが組織グラフから宛先を決定し、理由も表示 |
| 誰が決めるべきか分からない | カードに「なぜあなたなのか（Why you）」が必ず付く |
| 決定が会話に埋もれる | 決定は自動的にGitHub Issueとして記録される |
| 同じ説明を何度もする | AIが受け手の役割に合わせて再構成する |

### コアループ（このプロダクトの心臓部）

```
Alice が自分のAIに自然文で指示
   ↓  「Tell your AI」入力シート
AI が意図・宛先・優先度・カード種別を判断（組織グラフ + LLM）
   ↓  Draft Review シートで送信前に確認
Bob のフィードに Decision Card として届く（WebSocket、リアルタイム）
   ↓  縦スクロールで1枚ずつ表示
Bob が判断する（Create issue / Decline / Revise / Delegate）
   ↓  スワイプ or ボタン
GitHub Issue が作成され、結果が Alice 側に反映される
```

**デザイン上の最重要点**: この1周がストレスなく回ること。個別機能の網羅より、このループの体験の質を優先してきた。

### 想定利用シーン

社内デモは4人の固定チームで再現する。

| ユーザー | 役割 | 組織上の関係 |
|---|---|---|
| Alice | Product Manager | Bob のマネージャー / Onboarding v2 の承認権限 |
| Bob | Engineer | Core Team, Engineering 所属 |
| Carol | Designer | Core Team, Design Team 所属 |
| Dana | Engineering Lead | Bob のマネージャー / Onboarding v2 の承認権限 |

---

## 2. 現在のステータス

| 領域 | 状態 | 備考 |
|---|---|---|
| コアループ（指示→カード→判断→GitHub） | 動作する | 実機/シミュレータで確認済み |
| AIルーティング | 実装済み | OpenRouter経由。キー未設定時はキーワードベースのフォールバック |
| リアルタイム同期 | 実装済み | localhost の WebSocket リレーサーバ（`server/`） |
| GitHub連携 | 実装済み | OAuthログイン → リポジトリ選択 → Issues API |
| 組織グラフ | UIは実装済み・データはデモ固定 | 表現は「グラフ」ではなくリスト（後述の課題参照） |
| 複数ユーザー切替 | 実装済み | アプリ内のユーザー切替 + 2シミュレータ同時起動 |
| 配布ビルド | 未着手 | TestFlight / インストール可能ビルドは今後 |

---

## 3. 画面一覧（インフォメーションアーキテクチャ）

画面数は意図的に少ない。**フィード1枚 + モーダル群**という構成。

```
RootView                                 起動時の分岐
├─ 復元中インジケータ                     「Restoring session…」
├─ AuthView                              未ログイン時
└─ FeedView                              ログイン後のホーム（唯一の常設画面）
   ├─ 上部バー: ユーザー名 + 接続ドット / ページドット / ⋯メニュー
   ├─ カード領域: DecisionCardView を縦ページングでフルスクリーン表示
   ├─ 下部: リポジトリ名 + 「Tell your AI」ComposeBar
   └─ モーダル群（すべて sheet）
      ├─ AIInputSheet          AIへの指示入力 + 優先度指定
      ├─ DraftReviewSheet      AIが作った下書きの確認・送信
      ├─ CardDetailSheet       カード詳細（Why you / Context / Routing / GitHub）
      ├─ ReviseSheet           修正依頼メモの入力
      ├─ DelegatePickerSheet   委任先の選択
      ├─ UserSwitcherSheet     デモ用ユーザー切替
      └─ OrgGraphView          組織（People / Agents / Teams / Projects / Relationships）
```

オーバーレイ:
- `ProcessingOverlay` — 全画面を暗転（黒 55%）してスピナー + 処理中メッセージ
- `DraftingBanner` — 上部からスライドイン。「Drafting decision card…」

### 主要画面の構造

**AuthView（ログイン）**
左揃えの縦積み。ロゴ56pt → ワードマーク32pt/medium →「Decisions, not messages」。中央に GitHub サインインボタン（未認証時）またはリポジトリピッカー（認証済み時）、接続済みバナー。最下部に固定の Continue ボタン。

**FeedView（ホーム）**
背景は純黒。カードはコンテナ高さいっぱい（`containerRelativeFrame(.vertical)`）で縦方向ページングスクロール。スクロールインジケータは非表示。カードが0枚のときは中央に空状態テキスト3行。

**DecisionCardView（意思決定カード）— 最重要コンポーネント**
上から順に:
1. メタ行 — カード種別 `·` 優先度 `·` 相対時刻（右寄せ）
2. 送信者 — 「From Bob」+ エージェント経路（「Bob's AI → Alice's AI」）
3. **Why you ボックス** — 左に2ptのアクセントバー、`surfaceRaised` 背景。ルーティング理由
4. タイトル 26pt/medium
5. サマリー 17pt/regular（`textSecondary`）
6. コンテキスト（compact表示: `ラベル: 値 · ラベル: 値`）
7. 「View details」リンク（アクセント色）
8. GitHub Issue リンク（作成済みのとき）
9. ステータスラベル（未処理でないとき）
10. アクションブロック — Create issue（GitHubグリーン、48pt）/ Decline・Revise・Delegate（横3分割のテキストボタン）/ スワイプヒント

**OrgGraphView（組織）**
People / Agents / Teams / Projects をセクション分けしたリスト + 末尾に関係性を等幅フォントで列挙（`Alice  manages  Bob` 形式）。

---

## 4. デザインシステム

> **重要**: 実装上の真実は `TikTokForWork/Design/Theme.swift`。リポジトリ直下の `design.md` は初期案のままで、色・サイズが現行と食い違っている（後述「既知の課題」参照）。**Theme.swift を正とすること。**

### 4.1 カラー

ダークモード専用（`preferredColorScheme(.dark)` を固定）。ライトモードは未対応。

| トークン | Hex | 用途 |
|---|---|---|
| `background` | `#000000` | アプリ全体の地。純黒（OLED前提） |
| `surface` | `#0C0C0E` | シートの背景 |
| `surfaceRaised` | `#161618` | 入力欄、チップ、Why youボックス、リスト行 |
| `textPrimary` | `#F4F4F5` | タイトル、主要テキスト |
| `textSecondary` | `#A1A1AA` | サマリー、補助テキスト |
| `textTertiary` | `#71717A` | メタ情報、プレースホルダ、無効状態 |
| `accent` | `#5E6AD2` | リンク、選択状態、アクセントバー。**1画面1箇所を原則** |
| `approve` | `#4ADE80` | 接続インジケータ、承認系 |
| `issueGreen` | `#238636` | GitHub Issue 作成ボタン（GitHubのブランドグリーン準拠） |
| `reject` | `#F87171` | Decline、緊急優先度、エラー |

Themeに未定義でコード内に直書きされている色（**要トークン化**）:

| Hex | 使用箇所 |
|---|---|
| `#FBBF24` | 優先度 High、Context Insight の deadline 種別 |
| `#38BDF8` | Context Insight の channel 種別 |

### 4.2 タイポグラフィ

SF Pro（`Font.system`）。**boldは使わない。** `.regular` と `.medium` のみ。階層は太さではなくサイズと色で作る。

| トークン | サイズ | ウェイト | 用途 |
|---|---|---|---|
| `title` | 26 | medium | カードタイトル、Draft Review のタイトル |
| `body` | 17 | regular | サマリー、本文、入力テキスト |
| `caption` | 13 | regular | 補助テキスト、メタ行、詳細の値 |
| `label` | 12 | regular | セクション見出し、チップ、ステータス |
| `micro` | 11 | regular | 時刻、ヒント、最小メタ |

トークン外の直書きサイズ（**要整理**）: 32/medium（Authワードマーク）、16/medium（PrimaryButton）、16/semibold（GitHubPrimaryButton）、15/medium（上部バーのユーザー名、UserSwitcher）、15/regular（Org のノード名）、14（SecondaryAction）、13 monospaced（Org の関係性）、12 monospaced（接続リポジトリ）、10 monospaced（フッターのリポジトリ名）、9/semibold（chevron）。

### 4.3 スペーシング

4ptグリッド。

| トークン | 値 |
|---|---|
| `xs` | 4 |
| `sm` | 8 |
| `md` | 16 |
| `lg` | 24 |
| `xl` | 32 |
| `xxl` | 48 |
| `screen` | 24（画面左右の余白） |

### 4.4 角丸

| トークン | 値 | 用途 |
|---|---|---|
| `sm` | 6 | チップ、Why youボックス、スワイプヒントラベル |
| `md` | 10 | ボタン、入力欄、リスト行 |
| `sheet` | 14 | シート（定義のみ、現状はシステム標準に委ねている） |

### 4.5 コンポーネント一覧

すべて `TikTokForWork/Design/Components.swift` に集約（`AppLogo` と `ProcessingOverlay` は別ファイル）。

| コンポーネント | 説明 |
|---|---|
| `PrimaryButton` | 高さ48、白地(`textPrimary`)に黒文字。無効時は `surfaceRaised` + `textTertiary` |
| `GitHubPrimaryButton` | 高さ48、`issueGreen` 地に白文字 + GitHubマーク16pt。カードの主アクション |
| `SecondaryAction` | 高さ40、テキストのみ。tint を指定可能（Decline は `reject`） |
| `ComposeBar` | 高さ48、`surfaceRaised`。sparkleアイコン + 「Tell your AI」 |
| `PageDots` | 現在位置は幅16の白カプセル、その他は幅5。高さ5固定。0.2s easeOut |
| `PrioritySlider` | Low/Med/High/Now の4分割。選択中はバーが優先度色、ラベルが `textPrimary` |
| `LabelChip` | カプセル型、`surfaceRaised`、micro |
| `ToolCallChip` | AIのツール呼び出しを表示。アクセント色アイコン + ラベル + 詳細 |
| `ContextInsightView` | コンテキスト文字列を解析して表示（下記参照） |
| `AppLogo` | `AppMark` アセット（重なる3枚のカード + アクセントバー） |
| `ProcessingOverlay` | 黒55%の全画面ディム + `surfaceRaised` のスピナーピル |
| `DraftingBanner` | 上部インラインバナー。下端に0.5ptの区切り線 |

### 4.6 Context Insight（コンテキストの自動意味づけ）

AIが返す `context` 文字列（`ラベル: 値 · ラベル: 値` 形式）を解析し、種別ごとにアイコンと色を割り当てる仕組み。カード上では compact 表示（1行テキスト）、詳細シートでは `ラベル72pt幅 + 値` の2カラム表示になる。

| 種別 | アイコン | 色 | トリガーとなる語 |
|---|---|---|---|
| deadline | `calendar` | `#FBBF24` | deadline, due, friday, tomorrow, eod … |
| metric | `chart.line.uptrend.xyaxis` | `reject` | %, p95, latency, regression … |
| scope | `square.stack.3d.up` | `accent` | production, staging, scope … |
| channel | `antenna.radiowaves.left.and.right` | `#38BDF8` | channel |
| action | `bolt.fill` | `approve` | hotfix, branch, deploy, fix … |
| link | `link` | `accent` | http, github.com |
| routing | `arrow.triangle.branch` | `textSecondary` | routed from … |
| general | `sparkle` | `textTertiary` | 上記以外 |

> **注意**: 種別ごとのアイコン・色は定義済みだが、**現在の `ContextInsightView` は非compact表示でもアイコンを描画していない**（テキスト2カラムのみ）。デザイン上の伸びしろとして残っている。

---

## 5. インタラクションとモーション

**原則: 速く、機能的に。装飾的なアニメーションは入れない。**

| 対象 | 仕様 |
|---|---|
| フィードのページング | `.scrollTargetBehavior(.paging)` — 1スワイプ1カード。システム標準の物理挙動 |
| カードのスワイプ判定 | 最小ドラッグ20pt、確定しきい値 **96pt**。横移動が縦移動を上回るときのみ反応 |
| スワイプ右 | Create issue（成功ハプティクス） |
| スワイプ左 | Decline（軽ハプティクス） |
| スワイプヒント | ドラッグ24pt超で表示。不透明度は `移動量 / 96` に比例 |
| ドラッグの戻し | easeOut 0.18s |
| 優先度の切替 | easeOut 0.15s + 軽ハプティクス |
| ページドット | easeOut 0.2s |
| カードリストの更新 | easeOut 0.2s |
| 判断後の次カードへの自動送り | easeOut 0.25s |
| 画面遷移（Auth ↔ Feed） | easeOut 0.2s |
| DraftingBanner | 上端からのスライド + フェード |

ハプティクス: `Haptics.light()`（ボタンタップ、Decline、優先度変更）と `Haptics.success()`（Issue作成、委任、判断確定）の2種のみ。

**処理中の扱いが2種類ある点に注意**:
- AIの下書き生成 → **ブロックしない**。上部バナーだけ出してフィードは操作可能（「keep scrolling while it works」）
- GitHub同期などの確定操作 → **ブロックする**。`ProcessingOverlay` で全画面を覆う

---

## 6. コピー（文言）のルール

### トーン

- 「Tell your AI」であって「Send message」ではない
- 「Decision recorded」であって「Message sent」ではない
- センテンスケース。短く。修飾語を入れない
- プロダクトのタグライン: **「Decisions, not messages」**

### 既存の主要コピー

| 場所 | 文言 |
|---|---|
| Auth タグライン | Decisions, not messages |
| ComposeBar | Tell your AI |
| AI入力 説明（AI有効時） | Your AI drafts a decision card in the background — keep scrolling while it works. |
| AI入力 説明（オフライン時） | Offline mode — local routing with your priority setting. |
| AI入力 プレースホルダ | Ask Bob to review the onboarding PR before Friday |
| AI入力 送信ボタン | Draft in background / Draft card |
| Draft Review 送信ボタン | Send decision card |
| カードのスワイプヒント | Swipe right to create issue · left to decline |
| Revise 説明文 | What should change before this becomes a GitHub issue? |
| 空状態 | Tell your AI what you need / Decisions will show up here / Use Tell your AI below to route one |
| 起動中 | Restoring session… |
| 下書き中 | Drafting decision card… |

### ステータスの表示名（ユーザーに見える文言）

内部の状態名とは意図的に変えている。

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

カードの本文はLLMが書く。デザイン上の文字数見積もりはこの制約に従うこと。

| フィールド | 制約 |
|---|---|
| title | **3〜8語**、動作を表す表現。「tell Bob」のような冗語は禁止 |
| summary | **1〜2文**、三人称、受け手が何を決める/やるのかを書く |
| context | **2〜4個**の `ラベル: 詳細` を ` · ` で連結 |
| routingReason | **1文**、なぜこの人が決めるのか |
| labels | 任意。GitHub風のラベル（bug, infra, blocked など） |

送信者の言葉をそのまま繰り返すことは禁止されており、エコーを検出した場合はサーバ側で書き直しがかかる。

---

## 7. 既知の課題・デザイン負債

引き継ぎ後に着手する候補。おおよそ優先度順。

### 高

1. **`design.md` が実装と乖離している** — 初期案のままで、background が `#09090B`（実装は `#000000`）、タイトル22pt（実装は26pt）、角丸0/4（実装は6/10）など全体的にずれている。`Theme.swift` を正として `design.md` を更新するか、廃止して本ドキュメントに一本化すべき。
2. **組織「グラフ」が実質リスト** — 課題要件はノード（人/チーム/AI/プロジェクト）とエッジ（管理関係/所属/承認権限）の可視化。現状はセクション分けリスト + 等幅テキストの関係性列挙で、構造が読み取れない。ここは伸びしろが大きい。
3. **アクセシビリティ未検証** — フォントサイズが全て固定値で Dynamic Type に追随しない。VoiceOver ラベルは `AppLogo` と「Refresh repositories」のみ。`textTertiary`(#71717A) / `background`(#000000) のコントラスト比は約4.8:1で、11〜12ptの微細テキストに使うには厳しい。
4. **タップ領域** — カード本文の「View details」はテキストのみで44pt未満。`SecondaryAction` は高さ40ptで最小推奨44ptを下回る。

### 中

5. **トークンの取りこぼし** — `#FBBF24` / `#38BDF8` の直書き、トークン外のフォントサイズ10種以上。デザインシステムとして閉じていない。
6. **Context Insight のアイコンが未使用** — 種別ごとのアイコンと色は定義済みだが描画されていない。実装すればカード詳細の情報密度が上がる。
7. **`Radius.sheet`(14) が未使用** — シートはシステム標準任せ。定義を使うか削除するか決める。
8. **PageDots がカード枚数に比例して伸びる** — 10枚を超えると上部バーで破綻する。上限とオーバーフロー表現が必要。
9. **英語のみ** — ローカライズ機構が入っていない。日本語チームでのデモを考えると日本語UIの検討余地あり。
10. **アバター/アイデンティティ表現がない** — 送信者は「From Bob」のテキストのみ。誰からのカードかの視認性を上げられる。

### 低

11. **ライトモード非対応** — `preferredColorScheme(.dark)` 固定。純黒ベースの設計なので、対応するならトークン設計から見直しが必要。
12. **`AuthView` に未使用の `fieldSection` が残っている** — デッドコード。
13. **エラー表示がシステムアラート依存** — フィードのエラーは標準の `.alert`。プロダクトの静けさとトーンが合っていない。
14. **空状態のバリエーション不足** — 「全部処理し終わった」と「まだ1枚も来ていない」が同じ画面。

---

## 8. デザイナー向けセットアップ（実機で触るまで）

デザイン確認のためだけなら、GitHub認証とリレーサーバの起動が必要。

### 必要なもの

- macOS + Xcode 16 以降
- Node.js（リレーサーバ用）
- [XcodeGen](https://github.com/yonaskolb/XcodeGen)（`brew install xcodegen`）
- GitHub アカウント

### 手順

```bash
# 1) リレーサーバを起動
cd server
cp .env.example .env
#   .env に GITHUB_CLIENT_ID / GITHUB_CLIENT_SECRET / OPENROUTER_API_KEY を記入
npm install
npm start          # http://127.0.0.1:8080

# 2) Xcode プロジェクトを生成して開く
cd ..
xcodegen generate
open TikTokForWork.xcodeproj
```

GitHub OAuth アプリの作り方は `server/README.md` に記載（Callback URL は `tiktokforwork://oauth/callback`）。

### 2台デモ（インターAI通信を確認する）

1. シミュレータA を起動 → GitHubサインイン → リポジトリ選択 → Alice で入る
2. シミュレータB を起動 → 同様にサインイン → ユーザー切替で Bob にする
3. Alice で「Tell your AI」→ 自然文の指示を入力
4. Bob の画面にカードがリアルタイムで出る（上部バーの緑ドット＝接続中）
5. Bob が Create issue → GitHub に Issue が立ち、Alice 側に結果が戻る

### SwiftUI プレビュー

以下にプレビューが用意されている。単体でUIを見るならここが速い。

- `RootView` / `FeedView` / `AuthView` / `OrgGraphView` / `AIInputSheet` / `AppLogo`
- `DecisionCardView` — 実データ入りのプレビュー（緊急度Urgentのカード）あり

---

## 9. ファイルマップ（どこを触ればいいか）

```
TikTokForWork/
├─ Design/                     ← デザイントークンと共通部品。まずここ
│  ├─ Theme.swift                色・タイポ・スペーシング・角丸の定義（正）
│  ├─ Components.swift           ボタン、チップ、ComposeBar、PrioritySlider、ContextInsight
│  ├─ ProcessingOverlay.swift    処理中オーバーレイ / 下書きバナー
│  ├─ AppLogo.swift              ロゴ
│  ├─ Haptics.swift              触覚フィードバック2種
│  └─ DateFormatting.swift       相対時刻の表示
├─ Features/
│  ├─ Auth/AuthView.swift        ログイン画面
│  ├─ Feed/
│  │  ├─ FeedView.swift          ホーム（上部バー / 下部chrome / シート管理）
│  │  ├─ DecisionCardView.swift  ★カード本体。スワイプ処理もここ
│  │  ├─ AIInputSheet.swift      AI入力 + DraftReviewSheet
│  │  ├─ CardDetailSheet.swift   カード詳細
│  │  ├─ ReviseSheet.swift       修正依頼
│  │  ├─ DelegatePickerSheet.swift 委任先選択
│  │  └─ UserSwitcherSheet.swift ユーザー切替
│  └─ Org/OrgGraphView.swift     組織画面
├─ Models/                      カード・組織・ユーザーの型定義（表示名もここ）
├─ Data/DemoData.swift          デモの4人と組織グラフの定義
├─ ViewModels/FeedViewModel.swift フィードの状態管理（処理中メッセージの文言もここ）
└─ Assets.xcassets/             アイコン、ロゴ、GitHubマーク（SVG）

server/
├─ agentTools.js                ★AIのプロンプトとカード生成の制約（文言の長さ規定）
└─ index.js                     WebSocketリレー + OAuth + AIルーティング
```

**文言を直したいとき**: UIの固定文言は各Viewファイル直書き。ステータス/種別の表示名は `Models/DecisionCard.swift`。処理中メッセージは `ViewModels/FeedViewModel.swift`。AI生成文の指示は `server/agentTools.js`。

---

## 10. 引き継ぎ後の推奨アクション

1. **`design.md` を実装に合わせて更新するか廃止する** — 二重管理の解消が最優先。新しく入る人が古い値を見て作業する事故を防ぐ。
2. **組織グラフのビジュアル設計** — 現状の弱点であり、同時にプロダクトの差別化要素（「誰が決めるべきかが構造から分かる」）を最も体現できる画面。
3. **アクセシビリティのパス** — Dynamic Type 対応、タップ領域44pt確保、コントラスト再検証、VoiceOver ラベル付与。
4. **トークンの閉じ込め** — 直書きの色2種とフォントサイズを `Theme` に吸収し、デザインシステムを完結させる。
5. **カードの情報密度の再検討** — Context Insight のアイコン活用、送信者のアイデンティティ表現、優先度の視覚的な強度差。

---

## 11. 参考リンク

- [README.md](../README.md) — プロダクト概要・セットアップ・アーキテクチャ
- [PROGRESS.md](../PROGRESS.md) — 実装状況チェックリスト
- [design.md](../design.md) — 初期デザイン方針（**値は古い。Theme.swift を正とすること**）
- [server/README.md](../server/README.md) — リレーサーバ、OAuth、WebSocketプロトコル
