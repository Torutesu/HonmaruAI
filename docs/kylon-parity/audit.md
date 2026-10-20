# Kylon調査結果

調査基準日: 2026-10-15。対象: Kylonの公式Webサイト、開発者ドキュメント、ユーザーが利用を許可したログイン済みWeb/Macアプリ。Honmaruは取得したGitHub mainをコードレビュー。画面と文書は公開時期・workspace設定で異なるため、確認範囲を区別する。

## 結論

Kylonは、会話・データ・業務アプリ・エージェント実行・権限・自動化を接続する製品。Honmaruの判断フィードには継続する価値があり、これを共通基盤上のSimple体験として残す。Harnessは追加の体験として育てる。

既存HarnessはApps/型付き行/スキル/個別記憶/6種のworkflow stepを備えるが、KylonのCustom App公開基盤やローカルgatewayに相当しない。既存差分表のチェックマークは、そのまま機能同等性の証明にできない。[公式概要](https://docs.kylon.io/introduction)、[Appsの区別](https://docs.kylon.io/concepts/database-apps)

## 旧調査から修正した判断

| 旧メモの判断 | 今回の訂正 |
|---|---|
| 公式サイトに直接接続できない | 今回は本文取得可能。docsのHTMLを取得できない一部ページも公式の`.md`版で確認した |
| Workspace MemoryはPlaybookと呼び名だけの違い | 型付き記憶・適用対象・レビュー・共有knowledgeの違いがある |
| AppsはTables＋表/ボード/集計で同等 | Database AppとCustom App、複数entity、API契約、preview DB、公開・rollbackまで別途必要 |
| IntelligenceはLite/Standard/Maxで作成時固定 | 文書と実画面はFast/Pro/Max。実行方法が作成時固定。既存プロフィールにはIntelligence選択UIがある |
| Coreは$100/月固定 | 取得した価格ページではfrom $50/mo。BYO $0の表示はconcept previewで金額・適格性未確定 |
| Kylonは監査可能と言うだけ | 実行プロセス、immutable workflow revision、履歴、予算などの具体的仕様がある |
| Kylonに承認横断表示等がないと断定 | 未確認。観察していない機能を不存在と扱わない |
| HonmaruのEnterprise項目があるので優位 | 実装の存在と本番運用・第三者認証は別。比較優位は実測する |
| ツール数の表示を連携互換と扱う | カタログ掲載とOAuth・実操作・grant・失効の動作は別 |

根拠: [Memory](https://docs.kylon.io/concepts/memory)、[Agent実行方式](https://docs.kylon.io/agents/overview)、[App CLI](https://docs.kylon.io/cli/workspace/app)、[Workflow CLI](https://docs.kylon.io/cli/workspace/workflow)、[料金](https://kylon.io/pricing)。価格・プランは実装上の定数に固定しない。

## ログイン済み画面で確認したこと

データやアカウント情報をリポジトリに転記せず、構造と操作だけを記録した。新規エージェント作成、外部接続、メッセージ送信、課金変更、アプリ公開は行っていない。調査で生成された入力欄の下書きは消して元に戻した。

| 画面 | 確認した構造・挙動 | 未検証 |
|---|---|---|
| Webの初期設定後 | 専用private welcome room、AIの実行過程、停止、入力欄、音声入力 | 実行停止後の課金・ツール中断 |
| Chat | 細いglobal rail、ルーム/スレッド一覧、会話、右側resource panel。ホーム/最近/未読/@自分 | 複数端末での同期 |
| ルーム | Apps / Automations / Files / Members / menu | 大量データ・権限変更時 |
| ガイドライン | 4096字の編集欄、保存/キャンセル、毎ターン読む旨の説明 | 全外部providerへの適用 |
| メンバー | 人とagentの同じ一覧、絞込み、招待・agent作成 | 複数ユーザーの権限テスト |
| agent profile | 専門、Intelligence、作成者/日時、persona、Skills | この既存agentではAccessタブを確認できず。公式文書のAgent accessと別記 |
| 新規agent dialog | 初期非公開の説明、名前/専門、hosted/local/cloudの選択 | 作成後の実行・room追加 |
| provider menu | Hosted、Codex、Codex on Kylon Cloud、Claude Code、Devin Cloud | workspaceにより非表示のprovider、ACP |
| Intelligence | Fast/Pro/Max、用途と相対コストの説明 | 実モデル名・実測品質・変更時の扱い |
| Skills | 調査、ブラウザ操作、Apps開発/公開、資料、メール、生成メディア等の組込み一覧 | スキル実行結果と配布物 |
| Connections | カテゴリ・検索、Gmail/Calendar/GitHub/Notion/Drive/Slack/LINE/MCP/Custom API等 | 実際の接続とwrite/revoke |
| Automations空状態 | 設定ボタンはチャット入力を下書きする。自動送信ではない | 既存run・pause・error画面（このルームには0件） |
| Files | agent作成/user uploadの区別、recent/folder、upload | ファイル実体のpreview/version（対象は空） |

## コードで確認した主な不足

- `worker/src/harness/apps.js`: 現状はtyped tableに紐付くview定義。Custom Appのsource/build/preview/deploy基盤はない。
- `worker/src/harness/routes.js`: workspaceメンバー判定が主で、App・Table・Workflow・Follow-upを通じたroom単位の認可が不足する経路がある。ルームへリンクしただけでデータが非公開になるとは扱わない。
- `worker/src/harness/agents.js`: 最大200件・500文字の記憶リストを直近40件promptへ渡す。出典room/personスコープやstructured recallは別途必要。
- `worker/src/harness/workflows.js`: JSONの6種step。保存TypeScript・immutable revision・checkpoint・managed webhook verificationとは異なる。
- `worker/src/harness/followups.js`: モデルへ文章生成を依頼するかリマインダーを投稿する。外部状態を調べる実ツール実行は未実装。
- `worker/src/harness/mcpTools.js`: 外部agentからの一部操作はできるが、gatewayとworkspace CLIの代わりにはならない。
- `worker/src/harness/agents.js` / `customAgents.js`: Simpleを選ぶことでaccess制限を迂回する経路があった。今回修正。private room由来の記憶が別roomへ再利用される問題まで解決したわけではない。

詳細は[要件台帳](matrix.md)。コードを読んだことと本番の完全な機能検証は区別する。

## 同等性検証シナリオ

1. 非公開roomに2人とagentを追加。未参加adminからmessage/file/app/memoryをHTTP・WS・検索・MCPで取得できない。
2. 請求書Appを作り、型付きレコードを編集。レコードの会話と元の依頼が対応する。
3. レコード変更を起点に自動化し、人の承認後だけ外部送信。二重イベント・二重承認・retryで重複送信しない。
4. Custom Appを下書きで編集。previewは本番を変更せず、承認したcommitだけを公開。rollback後もDB整合性を保持する。
5. local agentを接続。PC切断・権限取消・キャンセル時に確実に止まり、再接続で重複実行しない。
6. 複数roomとユーザーを跨いで記憶/skill/connectionの許可・拒否を試す。
7. 同時実行時のcredit予約、失敗時精算、月次更新を検証する。
8. Simple → Harness → Simpleでカード、既読、会話、routine、playbook、添付、通知を保持する。

## 同等達成後の差別化仮説

決定待ちをHonmaruのフィードに集約し、同じ仕事の確認回数・意思決定時間・再説明回数を減らす。競合にないとは断定せず、同じ業務を両製品で実測する。

比較指標: 依頼から完了までの時間、人間の操作回数、判断を要した回数、完了率、費用、誤操作からの復旧時間。最初の対象は請求書督促、採用の進捗整理、営業週次レポート。適切な比較データと許可を得て実施する。

## 2026-10-20 実画面の追加確認と未完了項目

Kylonのログイン済みMacアプリで確認。共有ダイアログのプレビューまで読み取り、「リンクをコピー」は押していない。

- スレッド検索は会話右上の検索バー。入力中に検索し、メッセージ本文を強調する。検索結果はメッセージ単位の「1 / 3」のような表示と、前の結果／新しい結果への移動。Honmaru PR #466をこの構成へ修正。ローカル画面確認済み、本番検証は未完了。
- 参照パネルはアプリとファイルを一覧表示し、アプリの実画面プレビューを持つ。Honmaru PR #465で権限付き全スレッド取得、ファイルURL更新、アプリ詳細から参照一覧への復帰を追加。本番検証は未完了。
- 共有は、共有時点の会話を固定したスナップショット。ダイアログに会話プレビューがあり、以後のメッセージは含まれず、リンクを知る人が閲覧できると表示される。Honmaruの内部ディープリンクとは異なり、未実装。
- ミュート／退出／削除はメニューの存在だけを確認。実際の適用範囲・復旧・通知の扱いは未検証。既存の `channel_prefs` はルーム単位なので、そのままスレッドミュートとして扱えない。

公開スナップショット実装時のCompany Harness要件:

1. プレビュー取得と公開を分離する。公開APIは認証・現在のルーム閲覧権限・組織の共有許可を確認し、画面で公開対象を明示してから実行する。
2. 元メッセージの後日編集・追加が公開内容を変えないよう、本文・表示名・順序を固定する。単にメッセージID一覧を公開時に再取得する方式は不可。
3. 公開URLは推測困難なトークンを使い、無効化できる。トークンや会話本文を監査ログに含めず、作成・無効化の主体と対象を記録する。
4. 会話本文中の内部アプリリンクから、アプリやDBの公開権限を暗黙に与えない。添付は既存の署名URLをコピーして公開せず、共有専用の権限・配信・失効を定義する。
5. DLPは既存メッセージの送信時チェックだけに頼らず、公開時点の組織ルールで再評価する。共有停止・メンバー退会・ルーム非公開化・組織削除・保存期限と公開コピーの扱いを定義してテストする。
6. 公開閲覧はHTMLエスケープ、外部リソース、キャッシュ、検索エンジンへの露出を考慮する。無効化後にアプリ側キャッシュから復元しない。
7. テストで、未認証作成／他組織／非公開ルーム／権限喪失／無効化済みトークンを拒否すること、公開後の追加・編集がスナップショットを変えないことを確認する。

これらは設計要件であり、実装・検証済みを意味しない。Simple版維持・新規課金なし・全体の残差台帳を維持する。

### 共有実装の進捗（PR #467、未デプロイ）

プレビュー・公開確認・組織の共有ポリシー・DLP・7日期限・本人のリンク一覧と無効化を実装。
公開ページは認証画面と分離し、本文をエスケープしたテキストで表示する。
削除、保存期限による元メッセージの消去、組織ポリシー変更時に公開本文も消去する。
期限切れリンクは直ちに閲覧不可となり、日次処理で本文を消去する。
公開保存直前の返信追加・編集・削除を同じSQLで検出し、確認済みの内容と違えば公開しない。

ローカルの合成データで共有ダイアログと公開ページを表示確認。
ダークモードで見出しが暗いままになる問題を修正し、明暗両方を再確認した。
本番の会話は公開していない。Simple版の導線・データは変更していない。

残差: 添付は件数のみで公開配信しない。本文のMarkdown描画、900 KBを超える会話、
作成応答が失われた場合の冪等性、権限変更の全経路での即時失効、実運用の端末間検証は未完了。
現在の権限・参加者・公開範囲はリンク閲覧時にも照合するが、
閲覧がない間に権限を変更して元に戻すケースまで即時失効を保証するものではない。
