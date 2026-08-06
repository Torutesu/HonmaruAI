# TikTok for Work — デザイナー向け プロジェクト概要 / 引き継ぎドキュメント

最終更新: 2026-08-06
対象読者: このプロダクトのUI/UXをこれから作るデザイナー
英語版: [DESIGN_HANDOFF.en.md](./DESIGN_HANDOFF.en.md)

---

> ## ⚠️ 最初に読んでください
>
> **現在のUIはモックアップ段階です。デザインシステムもクオリティラインも、まだ何も確定していません。**
>
> このドキュメントに書かれている色・サイズ・余白・コンポーネントは「実装が今こうなっている」という
> **現状report**であって、**守るべき仕様ではありません**。
>
> - 今の見た目は、機能を動かすために置いた仮のものです
> - 数値もコンポーネントも、丸ごと変えて構いません
> - **デザインシステムをゼロから定義するのが、これからの仕事です**
>
> このドキュメントの目的は、「何が作られているか」「どこを触れば変えられるか」を渡すことであって、
> 現状の見た目を追認してもらうことではありません。

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

### コアループ（このプロダクトの心臓部）

```
送信者が自分のAIに自然文で指示
   ↓  「Tell your AI」入力シート
AI が意図・宛先・優先度・カード種別を判断（組織グラフ + LLM）
   ↓  Draft Review シートで送信前に確認
受け手のフィードに Decision Card として届く（WebSocket、リアルタイム）
   ↓  縦スクロールで1枚ずつ表示
受け手が判断する（Create issue / Decline / Revise / Delegate）
   ↓  スワイプ or ボタン
GitHub Issue が作成され、結果が送信者側に反映される
```

**デザイン上の最重要点**: この1周がストレスなく回ること。ここが体験の中心で、他はすべてこれを支える要素。

### 組織とメンバー

組織の名簿はリレーサーバが保持し、アプリから追加していく。**固定のダミーメンバーは存在しない。**

初期メンバー:

| メンバー | 役割 |
|---|---|
| Toru | CEO |
| Gota | PM |

- メンバー追加はアプリ内の **Organization → Add member** から（名前 / 役割 / GitHubユーザー名 / 上長）
- 追加した瞬間に全端末へ同期され、そのメンバーは**すぐにAIのルーティング対象になる**
- 各メンバーには専属のAIエージェントが自動的に紐づく（`〇〇's AI`）
- AIは「人」ではなく「役割」でルーティングする（デザイン系の仕事→デザイナー、開発→エンジニア、予算/採用→CEO）。コードを触らずに人を増やせる

---

## 2. 現在のステータス

| 領域 | 状態 | 備考 |
|---|---|---|
| コアループ（指示→カード→判断→GitHub） | 動作する | 実機/シミュレータで確認済み |
| AIルーティング | 実装済み | OpenRouter経由。キー未設定時はキーワードベースのフォールバック |
| リアルタイム同期 | 実装済み | localhost の WebSocket リレーサーバ（`server/`） |
| GitHub連携 | 実装済み | OAuthログイン → リポジトリ選択 → Issues API |
| 組織・メンバー管理 | 実装済み | 名簿はサーバ保持、アプリから追加、全端末に同期 |
| 組織グラフの可視化 | 未着手に近い | データはあるが、画面は単なるリスト表示 |
| **UI / デザインシステム** | **モックアップ段階** | **これから作る。現状は仮** |
| 名簿の永続化 | 未対応 | リレー再起動で初期メンバーに戻る |
| 配布ビルド | 未着手 | TestFlight / インストール可能ビルドは今後 |

---

## 3. 画面一覧（インフォメーションアーキテクチャ）

画面数は意図的に少ない。**フィード1枚 + モーダル群**という構成。この構造自体も見直して構わない。

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

オーバーレイ:
- `ProcessingOverlay` — 全画面を暗転してスピナー + 処理中メッセージ
- `DraftingBanner` — 上部からスライドイン。「Drafting decision card…」

### 主要画面の構造（現状）

**AuthView（ログイン）**
左揃えの縦積み。ロゴ → ワードマーク →「Decisions, not messages」。GitHubサインイン → リポジトリ選択 → 「You」で組織内の自分を選択。最下部に固定の Continue ボタン。

**FeedView（ホーム）**
カードはコンテナ高さいっぱいで縦方向ページングスクロール。カードが0枚のときは中央に空状態テキスト3行。

**DecisionCardView（意思決定カード）— 最重要コンポーネント**
現状の要素順序:
1. メタ行 — カード種別 `·` 優先度 `·` 相対時刻
2. 送信者 — 「From 〇〇」+ エージェント経路（「〇〇's AI → △△'s AI」）
3. **Why you ボックス** — ルーティング理由
4. タイトル
5. サマリー
6. コンテキスト（`ラベル: 値 · ラベル: 値`）
7. 「View details」リンク
8. GitHub Issue リンク（作成済みのとき）
9. ステータスラベル（未処理でないとき）
10. アクションブロック — Create issue / Decline・Revise・Delegate / スワイプヒント

この情報の順序と優先度づけは、**再設計の主戦場**。

**OrgGraphView（組織）**
People / Agents / Teams をセクション分けしたリスト + 関係性を等幅フォントで列挙。名簿から自動生成されるので、メンバーを増やすとそのまま伸びる。**「グラフ」としては全く表現できていない。**

---

## 4. 現状の実装値（**暫定 — 確定仕様ではありません**）

> ここに並ぶ数値は「今こう書いてある」というだけの現状値です。
> デザインの根拠があって決まったものではなく、**全面的に置き換える前提**です。
> 実装上の置き場所は `TikTokForWork/Design/Theme.swift`。

### 4.1 カラー（暫定）

現状はダークモード専用（`preferredColorScheme(.dark)` 固定）。ライトモードは未対応。

| トークン | 現状値 | 用途 |
|---|---|---|
| `background` | `#000000` | アプリ全体の地 |
| `surface` | `#0C0C0E` | シートの背景 |
| `surfaceRaised` | `#161618` | 入力欄、チップ、Why youボックス、リスト行 |
| `textPrimary` | `#F4F4F5` | タイトル、主要テキスト |
| `textSecondary` | `#A1A1AA` | サマリー、補助テキスト |
| `textTertiary` | `#71717A` | メタ情報、プレースホルダ、無効状態 |
| `accent` | `#5E6AD2` | リンク、選択状態、アクセントバー |
| `approve` | `#4ADE80` | 接続インジケータ、承認系 |
| `issueGreen` | `#238636` | GitHub Issue 作成ボタン |
| `reject` | `#F87171` | Decline、緊急優先度、エラー |

Themeに入っていない直書きの色: `#FBBF24`（優先度High / deadline）、`#38BDF8`（channel）。

### 4.2 タイポグラフィ（暫定）

SF Pro（`Font.system`）。現状は `.regular` と `.medium` のみで、boldは使っていない。

| トークン | サイズ | ウェイト |
|---|---|---|
| `title` | 26 | medium |
| `body` | 17 | regular |
| `caption` | 13 | regular |
| `label` | 12 | regular |
| `micro` | 11 | regular |

トークン外の直書きサイズが10種以上ある（32 / 16 / 15 / 14 / 13mono / 12mono / 10mono / 9 など）。**現状はシステムとして閉じていない。**

### 4.3 スペーシング / 角丸（暫定）

4ptグリッド: `xs` 4 / `sm` 8 / `md` 16 / `lg` 24 / `xl` 32 / `xxl` 48 / `screen` 24
角丸: `sm` 6（チップ）/ `md` 10（ボタン・入力欄）/ `sheet` 14（定義のみ・未使用）

### 4.4 コンポーネント一覧（現状あるもの）

`TikTokForWork/Design/Components.swift` に集約。

| コンポーネント | 現状 |
|---|---|
| `PrimaryButton` | 高さ48、白地に黒文字 |
| `GitHubPrimaryButton` | 高さ48、GitHubグリーン地に白文字 + マーク |
| `SecondaryAction` | 高さ40、テキストのみ |
| `ComposeBar` | 高さ48、「Tell your AI」 |
| `PageDots` | 現在位置のみ幅16のカプセル |
| `PrioritySlider` | Low/Med/High/Now の4分割 |
| `LabelChip` | カプセル型チップ |
| `ToolCallChip` | AIのツール呼び出し表示 |
| `ContextInsightView` | コンテキスト文字列を解析して表示 |
| `AppLogo` | 重なる3枚のカード + アクセントバー |
| `ProcessingOverlay` / `DraftingBanner` | 処理中表現2種 |

### 4.5 Context Insight（コンテキストの自動意味づけ）

AIが返す `context` 文字列（`ラベル: 値 · ラベル: 値`）を解析し、種別（deadline / metric / scope / channel / action / link / routing / general）ごとにアイコンと色を割り当てる仕組みが**定義だけされている**。

**ただし現在は描画されていない**（テキスト2カラムのみ）。仕組みは動くので、デザイン次第でそのまま活かせる。

---

## 5. インタラクションとモーション（暫定）

現状の実装値。方針も含めて見直して構わない。

| 対象 | 現状 |
|---|---|
| フィードのページング | `.scrollTargetBehavior(.paging)` — 1スワイプ1カード |
| カードのスワイプ判定 | 最小ドラッグ20pt、確定しきい値 96pt |
| スワイプ右 / 左 | Create issue / Decline |
| スワイプヒント | ドラッグ24pt超で表示、不透明度は移動量に比例 |
| アニメーション | すべて easeOut 0.15〜0.25s |
| ハプティクス | `light`（タップ・優先度変更）と `success`（確定操作）の2種 |

**処理中の扱いが2種類ある点は、意図的な設計として引き継ぐ価値がある**:
- AIの下書き生成 → **ブロックしない**。上部バナーだけ出してフィードは操作可能
- GitHub同期などの確定操作 → **ブロックする**。全画面オーバーレイ

---

## 6. コピー（文言）

### トーン（現状の方針）

- 「Tell your AI」であって「Send message」ではない
- 「Decision recorded」であって「Message sent」ではない
- センテンスケース。短く。修飾語を入れない
- タグライン: **「Decisions, not messages」**

### 主要コピー（現状）

| 場所 | 文言 |
|---|---|
| Auth タグライン | Decisions, not messages |
| ComposeBar | Tell your AI |
| Auth 自分の選択 | Your AI works on your behalf and receives cards addressed to you. |
| メンバー追加 | New members get their own AI agent and can receive decision cards immediately. |
| AI入力 説明 | Your AI drafts a decision card in the background — keep scrolling while it works. |
| カードのスワイプヒント | Swipe right to create issue · left to decline |
| Revise 説明文 | What should change before this becomes a GitHub issue? |
| 空状態 | Tell your AI what you need / Decisions will show up here |

### ステータスの表示名

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

カードの本文はLLMが書く。**レイアウトの文字数見積もりはこの制約が根拠になる。**

| フィールド | 制約 |
|---|---|
| title | **3〜8語**、動作を表す表現 |
| summary | **1〜2文**、三人称、受け手が何を決める/やるのか |
| context | **2〜4個**の `ラベル: 詳細` を ` · ` で連結 |
| routingReason | **1文**、なぜこの人が決めるのか |
| labels | 任意。GitHub風のラベル |

この制約自体もデザイン都合で変更できる（`server/agentTools.js`）。

---

## 7. これから決めること

現状「決まっていない」ことのリスト。優先度の目安つき。

### 大きい

1. **デザインシステム全体の定義** — 色・タイポ・スペーシング・コンポーネントを、根拠を持って一から決める。現状の値は出発点ですらなく、単なる仮置き。
2. **クオリティラインの設定** — どこまで作り込むか、何を「完成」とするか。現状のUIは機能を通すための最低限。
3. **Decision Card の情報設計** — プロダクトの中心。何を最初に見せ、何を畳むか。優先度・送信者・ルーティング理由の視覚的な重みづけ。
4. **組織グラフの可視化** — データ（人・AI・チーム・上長関係）は揃っているのに、画面はリストのまま。「誰が決めるべきかが構造で分かる」というプロダクトの主張を最も体現できる場所。
5. **メンバーが増えたときの設計** — 現状は2人前提の見え方。10人・50人になったときのフィード、委任先選択、組織画面、ページドットの破綻を含めて設計が必要。

### 中くらい

6. **アイデンティティ表現** — アバターなし、送信者は「From 〇〇」のテキストのみ。各メンバーのAIエージェントをどう見せるかも未定。
7. **アクセシビリティ方針** — 現状フォントサイズは全て固定でDynamic Type非対応、VoiceOverラベルもほぼ無し、タップ領域も44pt未満の箇所あり。どこまで担保するかを決める。
8. **ライト/ダークの方針** — 現在はダーク固定。両対応するならトークン設計から。
9. **言語** — 現状は英語のみ、ローカライズ機構なし。日本語UIを出すなら早めに決める。
10. **エラー・空状態の表現** — エラーはシステム標準アラート、空状態は1種類のみ。

### 小さい

11. Context Insight のアイコン・色を実際に使うかどうか
12. `Radius.sheet`(14) を使うか消すか
13. 直書きの色2種とフォントサイズをトークンに吸収するか

---

## 8. セットアップ（実機で触るまで）

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

GitHub OAuth アプリの作り方は `server/README.md`（Callback URL は `tiktokforwork://oauth/callback`）。

### 2台で動かす

1. 端末A → GitHubサインイン → リポジトリ選択 → 自分として Toru を選択
2. 端末B → 同様にサインイン → Gota を選択
3. Toru で「Tell your AI」→ 自然文の指示を入力
4. Gota の画面にカードがリアルタイムで出る（上部バーの緑ドット＝接続中）
5. Gota が Create issue → GitHub に Issue が立ち、Toru 側に結果が戻る

メンバーを増やすときは、どちらかの端末で **Organization → Add member**。即座に両方に反映される。

### SwiftUI プレビュー

`RootView` / `FeedView` / `AuthView` / `OrgGraphView` / `AddMemberSheet` / `AIInputSheet` / `AppLogo` / `DecisionCardView`（実データ入り）にプレビューあり。単体でUIを見るならここが速い。

---

## 9. ファイルマップ（どこを触ればいいか）

```
TikTokForWork/
├─ Design/                     ← デザイントークンと共通部品。まずここ
│  ├─ Theme.swift                色・タイポ・スペーシング・角丸（※暫定値）
│  ├─ Components.swift           ボタン、チップ、ComposeBar、PrioritySlider、ContextInsight
│  ├─ ProcessingOverlay.swift    処理中オーバーレイ / 下書きバナー
│  ├─ AppLogo.swift              ロゴ
│  ├─ Haptics.swift              触覚フィードバック2種
│  └─ DateFormatting.swift       相対時刻の表示
├─ Features/
│  ├─ Auth/AuthView.swift        ログイン + 自分の選択
│  ├─ Feed/
│  │  ├─ FeedView.swift          ホーム（上部バー / 下部chrome / シート管理）
│  │  ├─ DecisionCardView.swift  ★カード本体。スワイプ処理もここ
│  │  ├─ AIInputSheet.swift      AI入力 + DraftReviewSheet
│  │  ├─ CardDetailSheet.swift   カード詳細
│  │  ├─ ReviseSheet.swift       修正依頼
│  │  ├─ DelegatePickerSheet.swift 委任先選択
│  │  └─ UserSwitcherSheet.swift 自分の切り替え
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

---

## 10. 参考リンク

- [README.md](../README.md) — プロダクト概要・セットアップ・アーキテクチャ
- [PROGRESS.md](../PROGRESS.md) — 実装状況
- [design.md](../design.md) — 初期のデザインメモ（**現状と乖離。参考程度に**）
- [server/README.md](../server/README.md) — リレーサーバ、OAuth、名簿API、WebSocketプロトコル
