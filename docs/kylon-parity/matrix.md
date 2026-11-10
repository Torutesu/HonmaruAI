# Kylon機能差分・受入条件

調査基準日: 2026-11-11。公開仕様とログイン済み画面、Honmaruのmainを照合。実装ありは限定範囲の状態であり、同等性の合格ではない。未実装は調査した主要コード経路で確認できなかった項目。最新mainはPR #882の `ef1c7730474738fe5a6203fdde420032b12cdd08`。

全105項目。優先度P0は権限・データ・実行の基盤、P1は日常業務の機能一致、P2はプロバイダ/配布/高度機能。全項目の受入試験が終わるまで「100%」と表示しない。

2026-11-10 PR #862反映: main `b5fea8e2` にマージ済み。正確なhead CI #42681479871、main CI #42684677206、Worker deploy #42684677210（D1 migration/deploy/verify）、Web deploy #42684677047 が成功。KY-030/044/051は機能範囲を更新したが、Kylon同等性の残差は各行に明記。受入確認の詳細は [verification.md](verification.md) を参照。

2026-11-10 PR #863反映: main `20c603199918c5ece30ddfc1606985fa37384c42` にマージ済み。PR exact-head CI #42690260184、main CI #42693865694、Worker deploy #42693865965、Web deploy #42693865973が成功。`https://app.honmaruai.com` はHTTP 200、Worker `/health` は `ok: true`。KY-044のCLI TypeScript SDK生成とKY-051の過去公開版からの下書き復元を本番反映。全104項目の数は維持し、同等性の残差は各項目に記載。

2026-11-10 PR #864反映: main `14018bcbc58032a9ae2c2a91075cc39dc7fd77c8` にsquash merge。PR exact-head CI #42702894844 はWorker 4 shard・Web・Gateway・共有core/mobile・E2E・iOS・Windows・Desktop・relayを含む全必須ジョブ成功。マージ後のWorker `/health` は `ok:true`、Web appはHTTP 200。KY-030に個人Agent記憶の承認付き共有コピーを追加。マージ後main CI/デプロイのrun IDと配信SHAは未確認のため、health応答だけでマージcommitの配信証明とは扱わない。

2026-11-10 PR #865反映: main `4848312ad19bfc36b634cb1438bb320c026ec43b`。StoreKit/RevenueCat契約の状態表示を追加。main CI #42712593730、Worker deploy #42712593632、Web deploy #42712593582 が成功し、Worker `/health` は `ok:true`、appはHTTP 200。KY-087のcredits/rollover/packsは未実装のまま。KY-114のOpenRouter/BYO長時間継続は次PRで検証中。

2026-11-10 PR #872反映: main `bc79dfae406501e043231a9e2ae8c492e2b419d9` にマージ。PR #872のCI run #42780913454は全ジョブ成功（Worker shard 4/4は既存Agent handoff testの一時timeoutを失敗ジョブのみ再実行して成功）。main CI #42785160782、Worker deploy #42785160568も成功。Room audience経由のFile/Appは参照Roomが存在し未アーカイブでtombstoneがないことを認可時に確認する。古い会話メンバー行だけでアクセスが残るケースを回帰テストで遮断。Worker healthとapp.honmaruai.comはHTTP 200。

2026-11-09 台帳一括整合: main 93951cea時点の要件102件と照合し、KY-112を未実装から一部へ修正（実装・main CI・Worker deploy証跡を追記）。KY-063/KY-111のCI・Worker deploy証跡も更新。ログイン済みKylonのData Viewerを読み取り専用で確認し、ビュー切替・新規ビュー・フィールド・フィルター・グループ・その他・列ソート・レコード追加を確認。表示中のテーブルは0件で、データ変更なし。操作レベルの比較・承認フローの本番受入は未確認。

2026-10-23 公開状況: 原子的ルーム作成と3段階UI、保存色、役割変更・メンバーUIを本番公開済み。93c400d7のCIは全必須ジョブ成功。1dcf52cbで管理対象ルームの追加入口も共通化し、d8e85c76のWebデプロイで公開。10色パレット・Escape時の入力保持・CIバージョン修正もa673f31eで本番公開し、全必須CI成功と本番作成／再読み込みを確認。既定ルーム、プライバシー編集、全利用者・端末での検証は未完了。

2026-11-01 連携の公開状況: PR #588/#589の公開を確認。MCP Registryはコミュニティ掲載の公開サーバーであり、Kylonの審査済み大規模Integration catalogとは同等と扱わない。OAuthメタデータはWorker本番で応答し、ログイン済みHonmaru Appsで公開一覧と検索結果を確認。Simple利用経路は従来の分岐を維持。認証情報や外部サーバーは追加していない。残差の詳細はKY-076/077を参照。

## Rooms

[比較元の公式仕様](https://kylon.io/product/workspace)

| ID | 要件 | 現状 | 優先 | コード根拠 | 完了条件・残差 |
|---|---|---|---|---|---|
| KY-001 | 公開・非公開ルーム | 一部 | P0 | [worker/src/access.js](../../worker/src/access.js) | 管理対象ルームの公開閲覧と明示参加を分離し、原子的作成API・3段階UI・検索・参加UIを公開済み。Kylonのgeneral設定では作成後の公開範囲変更を確認できず、名前も固定。残りは既定ルームの同定と、非メンバー・管理者・ゲストに対するHTTP/WS/検索の複数利用者本番隔離検証 |
| KY-002 | DM・グループ・エージェントDM | 一部 | P1 | [worker/src/channels.js](../../worker/src/channels.js) | 各参加者の可視性と退出後のアクセスを実機で確認 |
| KY-003 | ホーム・最近・未読・メンション | 一部 | P1 | [web-react/src/components/ClassicList.tsx](../../web-react/src/components/ClassicList.tsx) | PR #443で左一覧のメンション絞り込みを公開。本番Macの空状態とローカル非空一覧・会話・下書き・アプリ維持を確認。一覧と通知既読位置の全端末一致は残る |
| KY-004 | ルームガイドライン | 一部 | P0 | [worker/src/harness/guidelines.js](../../worker/src/harness/guidelines.js) | 4096字・競合検知・BYOを含む全AI入口で毎ターン反映。PR #601 merged、main CIとWorkerのテスト・D1移行・デプロイ・Verifyが成功し、本番healthと暗号化状態を確認。実AIリクエストを使う本番往復確認は未実施 |
| KY-005 | オブジェクト固定スレッド | 一部 | P1 | [worker/src/harness/appConversations.js](../../worker/src/harness/appConversations.js) | 作成元スレッドの履歴・返信・既読を共用。独立アプリ／レコード会話に明示的AI返信・メンション・アプリ内通知・既読同期を追加。全体Activityの表示・既読・対象会話への移動を統合。独立会話のOSプッシュと実機比較未確認部分は残る |
| KY-006 | ルームへのリソース紐付け | 一部 | P0 | [worker/src/harness/apps.js](../../worker/src/harness/apps.js), [worker/src/harness/routes.js](../../worker/src/harness/routes.js) | 紐付けを閲覧権限の付与と分離し、参照先ルームへの現在のアクセスを一覧・詳細・Home・MCP・アクセス設定API・リンク書き込み時にも再検証。非公開ルーム名漏えいを修正し、write時のACL競合をD1条件付きINSERTで拒否。非公開ルーム・DM由来の直接/テンプレート作成は初期非公開。ログイン済み本番の複数利用者隔離とUI比較は残る。Kylon同画面にはルーム紐付け編集が見つからず、追加機能として位置づけ。 |
| KY-007 | ルームメンバーとエージェント権限の分離 | 一部 | P0 | [worker/src/customAgents.js](../../worker/src/customAgents.js) | 明示的な人間・Agent所属と役割UI、共通追加ダイアログ、アクセス申請/Owner・Admin承認、ルーム作成時の選択的な利用権付与を本番公開。承認は申請者のAgent権限だけを付与しルームには追加しない。所有者移譲はバージョン競合検知付き。権限・共有先変更、申請承認、ルーム作成/Agent追加の付与後は関係者だけへバージョン通知し、開いた一覧・メンバー・Agent詳細を再読込。最終SHA `decdf511` のCI #2086/#2087 とWorker #236/Web #307は成功。複数利用者による本番隔離検証と合成Agentを使ったKylon実画面比較は残る |
| KY-008 | ルーム横断検索 | 一部 | P1 | [worker/src/channels.js](../../worker/src/channels.js) | メッセージだけでなくファイル本文・レコードも同じACLで検索 |
| KY-009 | ルームのアーカイブ・退出・削除 | 一部 | P1 | [worker/src/channelRoutes.js](../../worker/src/channelRoutes.js) | 管理対象ルームの最後の人間Admin保護、退出時の権限失効、削除後の閉鎖履歴、退会時の後任引き継ぎを公開済み。空のQAルームの可逆アーカイブを本番確認。自動GitHub除名・アカウント削除・復旧・保持期間・実行中自動化は残る |
| KY-010 | チャットから作業開始・送信先自動選択 | 一部 | P1 | [web-react/src/components/ClassicList.tsx](../../web-react/src/components/ClassicList.tsx) | 候補ルームに権限を適用し曖昧な送信先を確認 |

## Agents

[比較元の公式仕様](https://docs.kylon.io/agents/overview)

| ID | 要件 | 現状 | 優先 | コード根拠 | 完了条件・残差 |
|---|---|---|---|---|---|
| KY-011 | 新規エージェントの初期非公開 | 一部実装 | P0 | [worker/src/customAgents.js](../../worker/src/customAgents.js) | 標準作成・Markdown取込を作成者限定で原子的に保存。既存共有・Simpleを維持。外部teammate・全端末UIは残る |
| KY-012 | 名前・専門・ペルソナ・アバター | 一部 | P1 | [worker/src/customAgents.js](../../worker/src/customAgents.js) | 作成・編集・表示と日英入力を全対象クライアントで検証 |
| KY-013 | Fast/Pro/Maxの品質とコスト | 一部 | P1 | [worker/src/harness/agents.js](../../worker/src/harness/agents.js) | 現行lite/standard/maxとの差を定義し全実行経路で同じモデル選択と計測 |
| KY-014 | 独立したAgent Admin/Member | 一部実装 | P0 | [worker/src/harness/agentRoles.js](../../worker/src/harness/agentRoles.js) | 個別役割・制限付き共有・Memberによる通常メンバー追加削除・自己退出・作成者履歴を保持する所有者移譲・競合検出・最後の人間Admin保護を実装。Agent同士の役割・全実行経路のE2E・本番移譲検証は未完了 |
| KY-015 | 制限したエージェントへの直接APIアクセス | 一部 | P0 | [worker/src/channelRoutes.js](../../worker/src/channelRoutes.js), [worker/src/harness/routes.js](../../worker/src/harness/routes.js), [worker/src/harness/agentConnections.js](../../worker/src/harness/agentConnections.js), [worker/src/harness/agentRemoteMcp.js](../../worker/src/harness/agentRemoteMcp.js) | 直接APIと実行経路の監査に加え、Native/Remote MCP資格情報ヘルパーでも毎回現在のmembership・Agent audienceを再確認。private化後のNative資格情報拒否、Remote MCP実行とツール列挙拒否を回帰テスト。残りの全API/外部実行経路監査と複数利用者での本番隔離検証は継続 |
| KY-016 | Simpleへの切替で権限を緩めない | 実装あり | P0 | [worker/test/harness-agents.test.js](../../worker/test/harness-agents.test.js) | 両モードで非許可ユーザーとworkspace adminの直接アクセスを拒否 |
| KY-017 | メンション時のみ応答 | 一部 | P1 | [worker/src/customAgents.js](../../worker/src/customAgents.js), [worker/src/harness/agents.js](../../worker/src/harness/agents.js), [worker/src/harness/roomRouting.js](../../worker/src/harness/roomRouting.js) | 継続スレッドでの自然名呼び出しと短い同一投稿者フォローアップに加え、権限確認済みの部屋Agentに限って専門・Agent説明・共有ルームで利用可能なインストール済みスキル名/説明から自動振り分け。スキル本文は判定に渡さない。自然文の定型判定・2分窓はHonmaru側の暫定ルールで、Kylon実画面との照合が必要 |
| KY-018 | スレッドの単一リーダーと引継ぎ | 一部 | P0 | [worker/src/channelRoutes.js](../../worker/src/channelRoutes.js), [worker/src/harness/agentAssignments.js](../../worker/src/harness/agentAssignments.js), [worker/src/harness/remoteHandoff.js](../../worker/src/harness/remoteHandoff.js) | 世代で重複実行を防ぎ、内部/外部Agentの明示引継ぎを永続キューへ渡す。assignment開始・再利用・handoffで同一membership世代を再確認し、退会/再加入との競合を拒否（関連4ファイル87テスト成功）。外部Agentは利用可能な未訪問先だけを提示し、完了時に元ユーザー・ルーム・Agent権限を再検査。Mock Claude統合テストで成功/失効を検証。安全な自動失敗交代、他Provider実機、Kylon/本番のライブ比較は残る |
| KY-019 | エージェント同士のループ抑止 | 一部 | P0 | [worker/src/harness/remoteHandoff.js](../../worker/src/harness/remoteHandoff.js), [worker/src/harness/agentAssignments.js](../../worker/src/harness/agentAssignments.js) | 通常返信からは起動せず、内部/外部とも明示操作だけ。外部制御は最終行マーカー、現在の未訪問ルームAgentに限定し、自己/循環/上限は世代トランザクションで拒否。実機の複数Agent動作と他Providerの検証は残る |
| KY-020 | 実行停止・キャンセル伝播 | 一部 | P0 | [worker/src/agentRunner.js](../../worker/src/agentRunner.js), [worker/src/teammates.js](../../worker/src/teammates.js) | 世代単位停止をローカルモデル／ツールに伝播。個人DMのAgentが開始したMac mini JavaScript・公開アプリ処理も中断時にジョブを取消し、ゲートウェイのリースを失効。Claude Managed AgentsとCursor Cloud Agentsは公式停止APIへ正確なrun IDで要求し、Devinも組織ID・正確なsession IDへ公式終了APIを呼ぶ。PR #599とWorker本番deploy #41286970630は成功。ACPローカル実行はsession/cancelと$/cancel_requestを先に送信し、最大3秒待ってSIGTERM、750ms後SIGKILLへ進む（応答/無視双方のGateway合成テスト成功、5秒契約内）。Codex停止、signal非対応ツールの進行中副作用、費用精算、ライブ外部停止確認は残る |
| KY-021 | ターンごとの実行プロセス | 一部 | P1 | [worker/src/agentRunner.js](../../worker/src/agentRunner.js), [worker/src/harness/agentToolTraces.js](../../worker/src/harness/agentToolTraces.js), [web-react/src/components/AgentRunStatus.tsx](../../web-react/src/components/AgentRunStatus.tsx), [web-react/src/components/AgentToolTrace.tsx](../../web-react/src/components/AgentToolTrace.tsx) | チャット依頼の実行状態・引き継ぎ・時間に加え、Harnessのinline Agent返信にツール名・状態・時間だけの安全なtraceを保存し、返信から遅延表示。Simpleは対象外。外部provider/run traceの網羅、Web/mobile間の表示、実本番providerでの実行確認は残る |
| KY-022 | クラウド隔離コンピューター | 一部・本番反映 | P0 | [gateway/runner.mjs](../../gateway/runner.mjs), [worker/src/agentRunner.js](../../worker/src/agentRunner.js) | クラウド提供VMはないが、ユーザー所有Mac miniのApple Container 1.5.0上で本番キューから任意JavaScriptを実行できる。2026-11-01、ログイン済み本番UIからMac miniを選択し、隔離ジョブ `return input * 2` に `21` を渡して `42` を取得。nodeはネットワークなし・DNSなし・read-only root・tmpfs・非root・capability全削除・CPU 1・512 MiB・最大60秒。追加課金なし。ユーザー所有端末の起動/スリープに依存しないクラウドVM、ファイル環境、永続workspaceは残る |
| KY-023 | ローカルゲートウェイ・再接続 | 一部・本番反映 | P1 | [worker/src/harness/gateways.js](../../worker/src/harness/gateways.js), [gateway/runner.mjs](../../gateway/runner.mjs), [gateway/launchd.mjs](../../gateway/launchd.mjs) | Mac mini隔離JS・常駐・ログイン時接続・プロセス/ランタイム復旧と本番個人DMの実ツール往復を検証。CLIからmacOS LaunchAgentの導入・稼働状態を秘密情報を表示せず照会可能。2026-11-01、本番実行ノード画面のheartbeatが実行中に更新し、Mac mini経由のJS実行が `42` で成功。LaunchAgentの制御再起動後に再接続する既存記録あり。物理再起動・スリープ復帰の実機試験は残る |
| KY-024 | Codex/Claude Code/Devinの実行選択 | 一部 | P1 | [worker/src/teammates.js](../../worker/src/teammates.js) | クラウドAPI接続とローカルCLIを区別して実機で検証 |
| KY-025 | ACP接続契約 | 一部 | P2 | [gateway/acp.mjs](../../gateway/acp.mjs), [worker/src/teammates.js](../../worker/src/teammates.js) | ACP v1 stdio initialize/session new/load/prompt/cancel、ホストのfs/terminal能力無効化、agent所有の既存認証利用、Mac側allowlist、ACP agentチームメイト、スレッド回答の取り込みを実装。2026-11-01、既存OpenCode認証で合成プロンプトと `list_apps` MCPの実機往復成功（実Workspaceデータなし）。Workspace MCP read-only連携はHarness内で明示opt-in、既定off、Simpleでは通常ACPを継続しtoolsなし、6ツール・ユーザー/agent/resource ACL再確認、lease/node認証、query上限。進捗はリース認証付きで開始元会話に要約を一時配信し、引数・思考本文は送らない。権限要求はMac側allowlistのdefault（既定許可）/strict（読み取り系のみ許可）で自動応答。取消はsession/cancelと$/cancel_requestを送って応答猶予を設け、無応答時は5秒以内にプロセスを終了。Gateway/Worker合成試験とUIテスト済み。複数ACP実装の再接続・二台同期、実機QAは残る |
| KY-026 | 既存ChatGPT契約でクラウドCodex | 要検証 | P2 | [worker/src/teammates.js](../../worker/src/teammates.js) | 提供元条件と対応実行方式の確認後に隔離環境で検証 |

## Memory

[比較元の公式仕様](https://docs.kylon.io/concepts/memory)

| ID | 要件 | 現状 | 優先 | コード根拠 | 完了条件・残差 |
|---|---|---|---|---|---|
| KY-027 | エージェント固有の永続記憶 | 一部 | P0 | [worker/src/harness/agents.js](../../worker/src/harness/agents.js) | 型・title・description・最大16,000字のbodyを後方互換で保存し、競合検知付き編集を追加。対応する研究実行は索引とフレーズ検索から必要な本文だけを権限再確認付きツールで取得。実画面・本番・全実行方式の検証は残る |
| KY-028 | preference/feedback/reference/context | 一部 | P1 | [worker/src/harness/agents.js](../../worker/src/harness/agents.js) | 4種のkind、型別・全文検索、詳細編集を追加。本文全体で重複を判定。意味的な重複統合・レビュー状態は残る |
| KY-029 | ルーム・人単位の記憶スコープ | 一部 | P0 | [worker/src/harness/agents.js](../../worker/src/harness/agents.js) | 新規記憶に会話・元メッセージ・スレッドの参照IDを保存し、記憶画面で確認できる。旧記憶の出典は推測せず不明のまま。会話スコープ・人単位の隔離は維持。人単位の横断設定、実機QAは残る |
| KY-030 | 共有ナレッジと個人記憶の分離 | 一部 | P0 | [memoryEntries.js](../../worker/src/harness/memoryEntries.js), [memoryPromotion.js](../../worker/src/harness/memoryPromotion.js), [AgentMemoryPromotions.tsx](../../web-react/src/components/AgentMemoryPromotions.tsx) | 個人スコープを保った記憶の作成者・編集者表示に加え、PR #864で個人記憶の共有コピー申請、Agent所有者/明示管理者の承認・拒否、元の個人記憶を維持する別コピー、版/アクセス再確認、申請・決定履歴、UIを追加。exact-head CI全必須ジョブ成功。マージ後healthとWebのHTTP応答を確認したが、配信SHAと認証済み本番の申請/承認往復は未確認。記憶自体の所有者移管、意味的な統合、Kylon実画面との完全一致は未達 |
| KY-031 | 記憶のレビュー・スキル変換 | 一部 | P2 | [worker/src/harness/memoryEntries.js](../../worker/src/harness/memoryEntries.js) | 保持/修正/削除レビュー・版付き履歴・削除後の範囲付き証跡・本文と閲覧/実行範囲を維持するスキル変換は本番反映済み。再送時の重複防止と失敗時の一括取消はローカル全体テスト済み。変換の本番E2E、期限による再確認判定は残る |

## Skills

[比較元の公式仕様](https://docs.kylon.io/cli/workspace/skill)

| ID | 要件 | 現状 | 優先 | コード根拠 | 完了条件・残差 |
|---|---|---|---|---|---|
| KY-032 | スキル作成・編集・エージェントへの付与 | 一部 | P1 | [worker/src/harness/skills.js](../../worker/src/harness/skills.js) | 付与解除が次回の実行から反映し他エージェントは維持 |
| KY-033 | SKILL.mdパッケージと補助ファイル | 一部・本番反映 | P1 | [worker/src/harness/skills.js](../../worker/src/harness/skills.js) | SKILL.md・ZIP・フォルダーの確認後取り込み、相対パス検証、サイズ制限、補助バイナリ保存、権限付きページ読み込み・ZIP再出力を本番反映。Mac本番でZIPとフォルダーの日本語本文・補助ファイル一覧プレビューを確認。保存・再出力は自動テストで検証。補助ファイル編集、全アーカイブ形式、実機ドロップは残る |
| KY-034 | 必要時にスキル本文を読む | 一部 | P1 | [worker/src/harness/agents.js](../../worker/src/harness/agents.js) | 会話research・ワークフロー・予約実行に索引と権限再確認付き読込みツールを接続。ワークフロー・予約実行のモデル往復と利用量記録を模擬プロバイダーで検証。非research会話の20000字フォールバック制限、実モデルでの本番検証は残る |
| KY-035 | 組み込みスキル群 | 一部 | P1 | [worker/src/agentPresets.js](../../worker/src/agentPresets.js) | アプリ開発・資料・調査・ブラウザ・データ作業を個別検証 |
| KY-036 | private/publicと人間の所有者 | 一部 | P0 | [worker/src/harness/skills.js](../../worker/src/harness/skills.js) | 本文・パッケージ資産のprivate/workspace、所有者のみの共有変更、一覧/実行/ファイル読込みの権限確認を実装。記憶から変換したスキルは元の会話/エージェントの制限を継承し、再共有と別エージェントへの導入を拒否。共有リンク・明示agent grantモデル・本番複数ユーザー検証は残る |
| KY-037 | 共有URL・期限・失効・インポート | 一部・本番反映 | P2 | [worker/src/harness/skillShares.js](../../worker/src/harness/skillShares.js), [web-react/src/components/SkillSharing.tsx](../../web-react/src/components/SkillSharing.tsx), [web-react/src/screens/PublicSkillShare.tsx](../../web-react/src/screens/PublicSkillShare.tsx) | 1/7/30/90日リンク、即時失効、ZIP取得、別Workspaceへのprivate複製と管理Agentへの追加を実装。PR #572のmain CI #41182556284、Worker deploy #41182556208、Web deploy #41182556254が成功。2026-11-01、存在しない合成tokenに対する本番公開APIが無効リンク用404を返すことを確認。実ユーザー間での有効リンク閲覧・取り込み・失効をログイン画面で受け入れる検証、Kylonとの共有導線比較、組み込みSkillや公開カタログの共有範囲は残る |

## Apps

[比較元の公式仕様](https://docs.kylon.io/cli/workspace/app)

| ID | 要件 | 現状 | 優先 | コード根拠 | 完了条件・残差 |
|---|---|---|---|---|---|
| KY-038 | 会話・テンプレートからDatabase App | 一部 | P1 | [worker/src/harness/appGeneration.js](../../worker/src/harness/appGeneration.js) | PR #443で元の依頼文の自動保存、元会話の表示、要求IDによる再送、保存済み生成定義の再利用、非公開元スレッドの公開範囲継承を追加（本番反映済み）。テンプレート照合とAI生成の区別、業務要件を保持する全体比較は継続 |
| KY-039 | アプリ単位のDBと複数entity | 一部 | P0 | [worker/src/harness/appDatabase.js](../../worker/src/harness/appDatabase.js), [worker/src/harness/tables.js](../../worker/src/harness/tables.js) | アプリACLを継承する複数entity・型付きテーブル・同一アプリ内の単一/複数relationを実装。参照先の存在検証、リンク中の削除防止、previewの最終状態検証をPR #514（`470dabf1`）で追加。物理的にAppごとの専用Postgres DBと専用loginを持たずD1を論理分離している差、Kylon実画面での一致確認は残る |
| KY-040 | 標準CRUD・型検証 | 一部 | P0 | [worker/src/harness/tables.js](../../worker/src/harness/tables.js), [worker/src/harness/appDatabase.js](../../worker/src/harness/appDatabase.js) | strict値検証・行CAS・HTTP/MCPページング・relationの参照整合性と削除競合ガードをPR #514（`470dabf1`）で追加。migrationはschema version/CASと既存列の競合検知を持つ。破壊的/データ変換migrationはKY-048の残差 |
| KY-041 | 表・ボード・カレンダー | 一部 | P1 | [worker/src/harness/apps.js](../../worker/src/harness/apps.js) | table/board/metricsに終日calendarを追加。月移動・日付編集・未設定・閏日を検証。時刻・タイムゾーン付き予定とnative画面は残る |
| KY-042 | 保存ビュー・列順・幅・フィルタ・グループ | 一部 | P1 | [worker/src/harness/apps.js](../../worker/src/harness/apps.js) | 共有フィルター・グループに加え、個人ビュー・列順・列幅・選択中ビューのユーザー別保存を追加。権限分離・競合拒否。列の表示切替（タイトル常時表示）もユーザー別保存。ID・作成日時・更新日時の読取専用システム列、ヘッダーの昇順/降順/解除とフィルターを追加（初期非表示、個人設定に保存）。折り返しの個人設定保存・新規レコード入力ダイアログ・全画面表示、Relation列の表示名検索フィルターと複数リンクの含む/含まない判定を追加。2026-10-31の本番比較では同名の空アプリで双方4列とフィルター/グループ入口を確認。Kylonは「すべて」ビューと新規ビュー入口、列表示トグルを表示。Honmaruはタスク一覧・カンバン・カレンダー・個人ビュー、ID/作成/更新日時の切替と列順/幅、条件式フィルターを表示。Kylonのグループ調整は会話欄への指示文下書き。Honmaruは共有ビューで同じ会話導線、個人ビューでは直接編集を使うため、同じ種類のビューでの操作比較は継続。Appsライブラリからデータビューアーを開く差はPR #560（`b3e155d`、Deploy Web #332）で修正し、ログイン済み本番画面のURLに`?section=data`、0件表示を確認。未調整列を表示幅へ配分する修正はPR #561（`c4a8d07`、Deploy Web #333）で反映し、Selectのログイン済み本番画面で4列が利用幅へ広がることを確認。個人ビュー更新は同じ利用者の常時接続端末へ限定通知し、対象Appだけを再読込する実装をWorker/Webテストで確認済み。PR #676（`3840512`）で、既存の未送信文を保持しながら個人ビューの調整案を別カード表示する修正を本番反映。ログイン済みMacで提案表示・破棄後の既存下書き・元の共有ビュー復元を確認。KylonのQA表で「状態」が降順のまま維持されたことも確認対象とし、設定は変更していない。実機二端末での本番同期と残る操作一致は引き続き検証対象 |
| KY-043 | レコードに紐づく会話 | 一部 | P1 | [worker/src/harness/appConversations.js](../../worker/src/harness/appConversations.js) | 作成元スレッドの履歴・返信・既読を共用。独立アプリ／レコード会話に明示的AI返信・メンション・アプリ内通知・既読同期を追加。全体Activityの表示・既読・対象会話への移動を統合。独立会話のOSプッシュと実機比較未確認部分は残る |
| KY-044 | App APIの登録・OpenAPI・検証 | 一部・本番反映 | P1 | [worker/src/harness/tableContract.js](../../worker/src/harness/tableContract.js), [packages/cli/src/sdk.js](../../packages/cli/src/sdk.js) | テーブルAPIのOpenAPI 3.1とstrict CRUD schemaをPR #862、アクセス可能なテーブル定義から依存なしTypeScript SDKを生成するCLIをPR #863で本番反映。任意の独自API登録、公開契約のversion pinning、SDKのパッケージ配布と全外部利用者での受入は未完了 |
| KY-045 | Custom Appのソースコードと実行環境 | 一部 | P1 | [worker/src/harness/customRunner.js](../../worker/src/harness/customRunner.js) | HTML/CSS/JS生成・隔離UI・確認付きCRUD、公開済みサーバーJSのMac実行、固定API接続を追加。CLIから公開済みアクションの一覧・バージョン固定実行・実行結果を確認可能。クラウド任意サーバー配布は残る |
| KY-046 | 下書き・プレビュー・DB fork | 一部 | P1 | [worker/src/harness/apps.js](../../worker/src/harness/apps.js) | 個人用DB fork、複数entityのプレビューSDK、差分レビュー付きの一括本番反映を追加。競合は反映を拒否。1回50行まで・反映後は再forkが必要。自動競合解消・選択的マージは残る |
| KY-047 | 承認されたcommitの公開 | 一部 | P0 | [worker/src/harness/customApps.js](../../worker/src/harness/customApps.js) | 固定GitHub commit/静的assetの別Owner/Admin承認付き公開と、通常の下書き公開に対する任意の独立承認ゲートを追加。承認は版・SHA-256本文に束縛し、公開時に原子的に消費。Git連携の編集・build/deploy targetと本番受入は残る |
| KY-048 | DB migration journal | 一部 | P0 | [worker/src/harness/appDatabase.js](../../worker/src/harness/appDatabase.js) | 追加専用migrationを維持し、安定IDのrename、厳格なscalar/person変換、単一・複数Relationへの変換、null/空だけの列削除に対応。Relation完全一致で複数候補がある場合、Appのプレビューに候補IDを出し、利用者が入力ラベルごとに選択可能。選択はstable target IDとしてplanに保存し、次のプレビューを必須化。候補から外れたIDは拒否し、リンク先・match列を含む全target rowを適用transactionで再確認。データ変更はchecksum・schema/row snapshot CASで保護し、`false`/`0`は空扱いしない。App画面で直近50件のversion・変更ID・時刻・checksum状態を表示し、改変済みplanは非表示。500KB超snapshot、rollback、実画面Kylon比較は残る |
| KY-049 | 公開範囲private/workspace/public | 一部 | P0 | [worker/src/harness/resourceAccess.js](../../worker/src/harness/resourceAccess.js), [worker/src/harness/appShares.js](../../worker/src/harness/appShares.js), [worker/src/harness/appHosting.js](../../worker/src/harness/appHosting.js) | Database Appのworkspace/private/room ACLはTable・MCP・Home・Workflowへ伝播。公開Custom Appは同意・期限・失効付きread-only snapshot linkとPages独自ドメインを実装。実DBの匿名CRUDは対象外。認証済み本番マルチユーザー・実ドメイン/匿名アクセス検証は残る |
| KY-050 | 独自ドメイン・DNS・環境変数 | 一部実装 | P2 | [worker/src/harness/appHosting.js](../../worker/src/harness/appHosting.js), [web-react/functions/_middleware.js](../../web-react/functions/_middleware.js) | Cloudflare Pages domainの予約/競合確認・接続・解除・DNS target表示、接続に伴う明示公開同意、暗号化env valueと非表示UIを実装。実DNS/証明書・本番独自ドメイン・Secrets保護設定の動作確認は残る |
| KY-051 | デプロイ履歴・ログ・ロールバック | 一部・本番反映 | P1 | [worker/src/harness/customApps.js](../../worker/src/harness/customApps.js), [web-react/src](../../web-react/src) | Custom App詳細で公開版履歴、現在版、公開時刻、公開者名、source commitを確認可能。PR #862で履歴UI、PR #863で過去の公開版を現行版に触れず新しい下書きへ復元する操作を本番反映。復元版の再公開には現在の承認ルールが適用される。実行時ログ・詳細なdeployment status、直接rollback、環境別release履歴は未実装 |
| KY-052 | App用Connection grant | 一部 | P0 | [worker/src/harness/appConnectionGrants.js](../../worker/src/harness/appConnectionGrants.js) | Agent DM由来のAppで、source Agentに現在アクセスできる別メンバーが自分のConnectionだけを明示grant可能。資格情報はserver側に保持し、grantと利用時にApp/Agentアクセス・endpoint/method/versionを再確認する。159 Worker tests pass。App sourceにAgent IDがないGroup/Business conversationから起点を推測する機能、OAuth refresh、Connection全体のpeople/Agent/workspace管理、本番UI比較は残る |
| KY-053 | Appに同梱する自動化と差分検出 | 一部実装 | P1 | [worker/src/harness/appAutomationRelease.js](../../worker/src/harness/appAutomationRelease.js) | declared/liveのdrift・下書き停止・公開時反映 |
| KY-054 | テンプレート共有とバージョン | 一部・本番反映 | P2 | [worker/src/harness/templateShares.js](../../worker/src/harness/templateShares.js), [web-react/src/components/TemplateSharing.tsx](../../web-react/src/components/TemplateSharing.tsx) | PR #571のmain CI #41180397064、Worker deploy #41180397003、Web deploy #41180396947が成功。2026-11-01、存在しない合成tokenに対する本番公開APIが無効リンク用404を返すことを確認。アプリ版を固定したURL共有、1/7/30/90日期限、失効、別workspaceへのprivate取り込みを実装。リンクはハッシュ保存で、レコード・説明・カスタムコード・接続情報を含めず、項目名等は共有前確認を要求。2つのログイン済みWorkspace間での有効リンク作成・取込・失効の受入、招待制/カタログ、schema labelの自動機密検出、Kylon実画面比較は残る |
| KY-055 | App移動・削除とデータ保持 | 一部 | P0 | [worker/src/harness/apps.js](../../worker/src/harness/apps.js) | ルーム移動時に会話ACLを再確認し削除時DB保持方針を明示 |

## Automations

[比較元の公式仕様](https://docs.kylon.io/cli/workspace/workflow)

| ID | 要件 | 現状 | 優先 | コード根拠 | 完了条件・残差 |
|---|---|---|---|---|---|
| KY-056 | 手動・スケジュール・Webhook・レコード変更 | 一部 | P1 | [worker/src/harness/workflows.js](../../worker/src/harness/workflows.js), [web-react/src/components/ScheduleTriggerFields.tsx](../../web-react/src/components/ScheduleTriggerFields.tsx), [web-react/src/components/AutomationTriggerEditor.tsx](../../web-react/src/components/AutomationTriggerEditor.tsx) | 既存のカレンダー指定を維持し、Kylon形式の5項目cron・一定間隔・一度だけのスケジュール、IANAタイムゾーン、cronのDST欠落/重複時刻を実装。アプリ/entity直接トリガー、insert/update/delete、型を保つフラットwhere条件、App権限・entity検証、削除時にデータを渡さないpayloadを実装。単一レコード変更をrecords配列で開始し、コード実行にもctx.trigger.records相当を渡す。Worker/Webの関連検証中。Kylon実画面比較・本番公開・高頻度イベントの集約挙動は残る |
| KY-057 | 型付きイベントフィルタ | 実装あり | P1 | [worker/src/harness/workflows.js](../../worker/src/harness/workflows.js) | フラットAND、厳密な型付きscalar一致/候補配列、missingは不一致・nullは明示一致、条件のfalse→true、変更列判定、7日間の原子的なイベント重複排除と期限切れ掃除を実装・検証。削除イベントはKY-056 |
| KY-058 | 保存定義の不変revision | 一部 | P0 | [worker/src/harness/workflowRevisions.js](../../worker/src/harness/workflowRevisions.js), [worker/src/harness/workflows.js](../../worker/src/harness/workflows.js), [web-react/src/components/WorkflowHistory.tsx](../../web-react/src/components/WorkflowHistory.tsx) | 不変履歴・比較UI・maker/admin限定の安全な新版復元と、新規TypeScriptプログラム定義のfreeze/versionを本番反映。旧runの定義snapshotは開始時点以前の完全一致revisionに読み取り専用で結び付け、未一致/未保存を推定せず「版未記録」と区別。main CI/Worker/Web deploy成功を確認。Kylonの履歴画面との並列比較、認証済み本番操作受入、追跡開始前runの版未記録表示は残る |
| KY-059 | TypeScript SDKと永続checkpoint | 一部 | P1 | [worker/src/harness/workflows.js](../../worker/src/harness/workflows.js), [worker/src/harness/workflowTableQuery.js](../../worker/src/harness/workflowTableQuery.js), [worker/src/harness/workflowActivationState.js](../../worker/src/harness/workflowActivationState.js), [gateway/workflow-runner.mjs](../../gateway/workflow-runner.mjs), [gateway/workflow-sdk.mjs](../../gateway/workflow-sdk.mjs), [web-react/src/components/WorkflowProgramEditor.tsx](../../web-react/src/components/WorkflowProgramEditor.tsx) | 通常stepの定義hash checkpoint・fenced lease・結果再利用・副作用不明後の非再送を維持。TypeScript programは15分実行し、`table.query()`を保存済みWorkflowの明示App/entity/Table bindingに限定してWorker broker経由で公開。VM直接network/DBは禁止。毎ページでmembershipとApp/Table ACL・source mappingを再検証し、createdAt/id cursorとsnapshot cutoffで最大100行ずつ読み、最大32ページ・1 MBに達した場合は`complete:false`とcursorを返す。Kylon SDKの`app()`/`agent()`/provider proxy/一般Connection機能、書込みhelper、ライブ値の履歴snapshot、外部副作用のstep単位reconciliation、安全な継続、本番UI/ランタイム受入は残る。現在のD1行変更・outboxとcheckpointの原子性は実装済みだが、外部effectは exactly-once ではない |
| KY-060 | 条件分岐・batch・制限付き並列 | 一部実装 | P1 | [worker/src/harness/workflows.js](../../worker/src/harness/workflows.js), [gateway/workflow-sdk.mjs](../../gateway/workflow-sdk.mjs) | TypeScriptの`parallel`/`pipeline`に最大件数・同時実行数・stage数の上限、順序保持、部分失敗のnull化と`onError`通知を追加。実行時間はKylon仕様に合わせ15分で上限を設定。フォームWorkflowの条件分岐と合わせて決定的なbatch処理を支援。Workflow一般のページング、Kylon `agent()`との合成、失敗率/入力網羅性を使った自動停止判断、ライブ本番検証は残る |
| KY-061 | 実行履歴・step結果 | 一部 | P1 | [worker/src/harness/workflows.js](../../worker/src/harness/workflows.js), [web-react/src/screens/HarnessWorkflows.tsx](../../web-react/src/screens/HarnessWorkflows.tsx), [web-react/src/utils/runHistory.ts](../../web-react/src/utils/runHistory.ts) | Kylonは日別グループ、失敗フィルター、実行時間、出力を掲載 ([Run history](https://kylon.io/product/run-history))。Honmaruの同等表示・失敗のみ切替はcommit 1c80323で実装し、成功したDeploy Web #324に含まれる。今回、通常・承認・隔離コード実行のstep時間と安定したoperation IDを履歴へ追加し、既存出力・エラー・権限追跡に紐づけた。実入力の記録は機密値漏えい防止のため対象外。コスト・詳細権限の本番状態確認は残る |
| KY-062 | 署名付きWebhookと再送防止 | 実装あり | P0 | [worker/src/harness/workflows.js](../../worker/src/harness/workflows.js) | 8c753f91 を本番反映。新規・再発行credentialはHMAC-SHA256、5分以内timestamp、event ID、7日間の原子的重複排除を検証。既存URL-only credentialは明示rotationまで互換動作。 |
| KY-063 | Webhook rotation/revoke/held/replay | 一部 | P0 | [worker/src/harness/workflows.js](../../worker/src/harness/workflows.js) | 再発行・失効、停止中イベントの7日/1000件保持、明示IDによる古い順の再実行、二重起動防止、30分後の結果不明記録（副作用を再実行しない）を本番反映。main CI 42494741384、Worker migrations/deploy/Verify 42494741296成功。保留イベントは25件単位のページ表示・本文プレビュー・個別選択に対応し、再実行と破棄は明示選択したIDだけを対象とする。ログイン済みKylonとの操作差分・実画面比較と本番受入は残る。 |
| KY-064 | 承認待ち・継続 | 一部 | P0 | [worker/src/harness/workflows.js](../../worker/src/harness/workflows.js), [worker/src/relay.js](../../worker/src/relay.js) | run・approval card・stepを固定し、二重承認/replayを拒否。card_updated/AG-UI双方で決定者が現workspace memberか再確認し、run claimとmembership検証を一つの条件付きDB更新に統合。承認者の削除後も旧socketからWorkflow副作用を再開できないことを136テストで確認。main CI・production反映とKylon本番画面比較は残る。 |
| KY-065 | 停止・再開・アーカイブ | 一部 | P1 | [worker/src/harness/workflows.js](../../worker/src/harness/workflows.js) | スケジュール停止と実行キャンセルを区別。キャンセル時に関連するqueued/running TypeScript gateway jobも同一D1 batchでcancelledにし、leaseを無効化。実行中コードの副作用取り消しとKylon本番比較は残る |
| KY-066 | 実行者の権限を再検証 | 一部 | P0 | [worker/src/harness/agents.js](../../worker/src/harness/agents.js), [worker/src/harness/workflows.js](../../worker/src/harness/workflows.js), [worker/src/harness/modelToolLoop.js](../../worker/src/harness/modelToolLoop.js) | Workflow内Agentの各モデル往復・ツール呼び出し前後でmakerの現行Agent grantと会話アクセスを再検証し、回答公開直前にも確認。app_record_change元App/Table権限も認可fenceに含め、要求待機中にgrantを失った場合はWorkerのHTTP要求を中断し、未確定usageをunknown/unpricedとして記録。PR #579/#581をmain統合し、main CI #41224384637とWorker deploy #41224384634成功。Workflow Connectionのread-only Notion/GitHub検索もmainに含まれ、request/response/output時点で既存Agent grantを再検証。書込操作、未対応connector、provider側処理・請求の停止保証、その他副作用経路の監査と本番受入は残る |
| KY-067 | 実行予算と自動pause | 一部 | P0 | [worker/src/harness/workflowSafety.js](../../worker/src/harness/workflowSafety.js), [worker/src/workspaceAIBudget.js](../../worker/src/workspaceAIBudget.js) | 回数上限に加え、直近24h/7d/30日の記録トークンからUSD参考価格を集計しwarnまたはpauseするAutomation/workspace予算を実装。pause設定では未知モデルの記録を単価不明として扱い、該当する上限窓で新規利用を止める。既知のweb_search/jev価格は維持し、warn設定は停止しない。Kylon credits・invoice換算、外部tool料金、同時実行分の事前予約・精算は未対応 |
| KY-068 | 一回限りのFollow-up | 一部 | P1 | [worker/src/harness/followups.js](../../worker/src/harness/followups.js) | 相対/絶対時刻・スレッド・通知先・停止・権限変更後を検証 |
| KY-069 | Follow-upの実ツール実行 | 一部 | P1 | [worker/src/harness/followups.js](../../worker/src/harness/followups.js) | 個人Agent DMではread-only Notion/GitHub/Smithery連携を使い、ツール実行と出典/ID/URLを回答に含めるよう指示。共有チャンネルへ個人連携は渡さない。全Follow-upのコネクタ対応、書き込み操作、証跡画面、実接続の本番往復は残る |

## Files

[比較元の公式仕様](https://docs.kylon.io/cli/workspace/file)

| ID | 要件 | 現状 | 優先 | コード根拠 | 完了条件・残差 |
|---|---|---|---|---|---|
| KY-070 | アップロード・フォルダ・生成者フィルタ | 一部 | P1 | [worker/src/files.js](../../worker/src/files.js) | ローカルでアップロード・フォルダ・最近・human/agent/unknownフィルター・2タブ自動更新を確認。main 7f602fa8に包含、公開完了は未確認。自然文による生成、共有エージェント、複数利用者・モバイル・本番アップロードが残る |
| KY-071 | PDF・画像・CSV・テキストのプレビュー | 一部 | P1 | [web-react/src/components/DocumentPreview.tsx](../../web-react/src/components/DocumentPreview.tsx) | PR #476/#481を本番反映。PDF選択・検索ハイライト・拡大とCSV/テキスト検索を実装。PR #486でCSVダーク文字色を実画面修正し、後続のWeb/Workerデプロイ成功で公開を確認。全形式・大容量・モバイルの比較は残る |
| KY-072 | PDF/Word/Markdown/HTML書き出し | 一部 | P1 | [worker/src/files.js](../../worker/src/files.js) | 単なる元ファイルDLと形式変換を区別 |
| KY-073 | ファイルの版管理・復元 | 一部 | P1 | [fileVersionLedger.js](../../worker/src/harness/fileVersionLedger.js), [fileWriteTools.js](../../worker/src/harness/fileWriteTools.js) | 版追加・履歴・復元に加えて、Harness MCP/Agent CLIからの版指定可逆削除と過去版復元を追加。削除は最新content版とCASを要求し、既存の所有者/Room delete authorityを再検査。復元は未purge版を新しいimmutable versionに複製し、purgeは人間限定。複数利用者の本番往復・参照履歴・全形式書き出し・Kylon UI比較は残る |
| KY-074 | ファイルへの固定会話 | 一部 | P1 | worker/src/harness/fileConversation.js | 固定会話・同時作成・版更新・失効時拒否を検証。ローカルでファイル／会話の同時表示・戻り導線・ダークPDF幅合わせ・再読込を確認。版固定のAIテキスト読取と模擬モデル返信保存を検証。実モデル・PDF画像理解・通知・全端末・本番比較は残る |
| KY-075 | 公開共有の承認と失効 | 一部 | P0 | [fileShareApprovals.js](../../worker/src/harness/fileShareApprovals.js), [filePublicUrls.js](../../worker/src/harness/filePublicUrls.js), [file-share-approvals.test.js](../../worker/test/file-share-approvals.test.js), [harness-file-public-urls.test.js](../../worker/test/harness-file-public-urls.test.js) | Harnessのスナップショット共有は1/7/30日期限、所有者または現行ルーム/Workspace管理者の承認・拒否、承認前リンク非発行、版/hash/scope/source/session/membership再検証、監査、失効を実装。別系統のメディア公開URLは版固定・失効・purge確認あり。共有リクエストの本番UI/複数利用者受入とKylon比較、共有対象・アクセス操作の全ケースは未確認。公開URLの全ファイル種別対応やKylon同等の共有設定までは実装していない。Simpleでは共有管理APIを無効化し、既存リンクの提供は維持 |

## Connections

[比較元の公式仕様](https://docs.kylon.io/proxy/tools-api)

| ID | 要件 | 現状 | 優先 | コード根拠 | 完了条件・残差 |
|---|---|---|---|---|---|
| KY-076 | 連携カタログとOAuth接続 | 一部 | P1 | [RemoteMcpServers.tsx](../../web-react/src/components/RemoteMcpServers.tsx), [remoteMcpOAuth.js](../../worker/src/harness/remoteMcpOAuth.js), [remote-mcp.test.js](../../worker/test/remote-mcp.test.js) | PR #588でOAuth 2.1接続UIを追加。Workerの統合テストは認可サーバーのDynamic Client RegistrationとCIMD、PKCE、issuer検証、メンバーごとの暗号化token、更新とRemote MCP tool呼出しを模擬providerで検証。PR #589でMCP Registryの公開Streamable HTTPカタログを追加し、本番Macで一覧と「github」検索を確認。OAuthメタデータendpointは本番200。実ProviderでのOAuth往復・provider別のread/write/disconnect、Kylonの審査済み大規模連携カタログは未検証・未対応 |
| KY-077 | Remote MCP任意サーバー | 一部 | P1 | [worker/src/harness/remoteMcp.js](../../worker/src/harness/remoteMcp.js), [worker/src/harness/remoteMcpOAuth.js](../../worker/src/harness/remoteMcpOAuth.js), [worker/src/harness/agentRemoteMcp.js](../../worker/src/harness/agentRemoteMcp.js), [worker/src/harness/workflows.js](../../worker/src/harness/workflows.js), [worker/test/remote-mcp.test.js](../../worker/test/remote-mcp.test.js) | Harness限定。HTTPS接続、暗号化Bearer/custom header、tool一覧/schema、明示allowlist、execute scope、個人Agent会話のcaller grant・読み取り専用制限、Workflow Agent stepのworkspace承認済み読み取り専用toolを実装。OAuth 2.1のauthorization-code/PKCE、RFC 7591登録endpointへのDynamic Client Registration、CIMD、issuer/state検証、メンバー個別のtoken暗号化を実装し、mock provider統合テストでtoken refreshとlive tool callを検証。PR #589で公開RegistryのStreamable HTTP一覧・検索・cursor pagingを追加。Worker health/metadata 200とログイン済み本番Appsで一覧/GitHub検索を確認。Simple/shared会話にはRemote MCPを追加しない。実Provider OAuth往復と本番live tool call、DNS-pinned egress、Kylonの3,000件規模の審査済みcatalog、書き込みgrant、App/non-Agent Workflow実行連携は未対応 |
| KY-078 | Custom API service | 一部 | P1 | [worker/src/harness/appCapabilities.js](../../worker/src/harness/appCapabilities.js) | 6種の公式API host・固定URL/操作・暗号化secret・応答上限・redirect禁止・write再送抑止を追加。任意hostは未対応 |
| KY-079 | Agent単位のConnection grant | 一部 | P0 | [worker/src/agentTools.js](../../worker/src/agentTools.js), [worker/src/harness/agentConnections.js](../../worker/src/harness/agentConnections.js), [worker/src/channelRoutes.js](../../worker/src/channelRoutes.js), [worker/src/harness/followups.js](../../worker/src/harness/followups.js) | PR #583を本番反映し、サインイン済み実画面でNotion/GitHub grantを確認。Harnessで手動・自動検索とFollow-upを利用者ごとに初期拒否・許可・再認可。Smithery App grantは別管理。Simpleは従来どおり。任意の外部Connection、アプリ作成・Workflow実行主体との統合は残る |
| KY-080 | Tools discovery/execute/native proxy/upload | 一部 | P1 | [worker/src/mcp.js](../../worker/src/mcp.js) | 同一principalとスコープでREST/CLI/MCPを提供 |
| KY-081 | LINE公式アカウント受信 | 一部 | P1 | [roomHooks.js](../../worker/src/harness/roomHooks.js), [lineWebhook.js](../../worker/src/harness/lineWebhook.js), [RoomWebhooks.tsx](../../web-react/src/components/RoomWebhooks.tsx), [room-hooks.test.js](../../worker/test/room-hooks.test.js) | マネージドルームに接続別・仮名顧客別Inbox、受信一覧/詳細、actor別既読、ルーム会話リンクを追加。channel secretをworkspace鍵で暗号化し、raw bodyのHMAC-SHA256署名検証後に受信、webhookEventIdで重複排除。生LINE IDはInbox索引にも保存しない。Worker統合テスト19件、Inbox UIテスト追加を含むWebhook UIテスト12件、Web本番ビルド成功。自動返信・手動返信送信・メディア取得・Access Tokenによる送信接続・実LINE Developers往復・Kylon実画面比較は未対応。自動返信/メディア取得は引き続き無効 |
| KY-082 | データプロバイダの組込み | 一部 | P2 | [worker/src/agentResearch.js](../../worker/src/agentResearch.js) | 検索以外の人/企業/SEO/地図/TikTok等を実契約APIで検証 |
| KY-083 | 画像・動画・音声生成 | 一部・本番反映 | P2 | [worker/src/harness/mediaGeneration.js](../../worker/src/harness/mediaGeneration.js), [web-react/src/components/MessageVisualization.tsx](../../web-react/src/components/MessageVisualization.tsx) | PR #855でHarnessの所有Agent会話内に画像生成ジョブを追加。Workspace所有OpenAIキーのみ利用し、モデル送信前にプロンプトと従量費用の説明を人が承認する。進行状態・失敗・キャンセル・非公開PNG成果物の保存を実装。成果物の成功確定時にWorkspace/Agent所有権を再確認する更新SQLを修正し、模擬Provider応答からR2・ファイル台帳保存までテスト。動画・音声生成、固定額を提示する費用見積り、実Provider/実画面での受入は残る。生成費用は出力により変動するため固定額の見積りとしては表示しない |
| KY-084 | モデル互換proxy | 一部 | P2 | [worker/src/orgAI.js](../../worker/src/orgAI.js) | 対応API・stream・使用量計上・providerエラーを検証 |
| KY-085 | Workspace CLIの全操作 | 一部 | P1 | [packages/cli/src/cli.js](../../packages/cli/src/cli.js), [worker/src/mcpChatTools.js](../../worker/src/mcpChatTools.js), [worker/src/harness/fileWriteTools.js](../../worker/src/harness/fileWriteTools.js) | 既存の認可付きMCPツールへHarness実行/App action/DB/Fileに加え、Room一覧・作成・履歴、Message検索・取得・送信、Thread取得・返信、Reaction get/add/remove、Fileの版指定削除・復元aliasを追加。書込みはrequest IDまたはcurrent-version CASを要求し、private/DM/attachment/file-scope authorityをWorkerが再検証。Room join/discover/archive/update/member管理、Thread作成・participants/pin/rename/activate、Message edit/delete/forward、File binary transfer/share/purge、Connection/Agent/Skillの各コマンド、Gateway修復/OAuth/secure credential helperは未対応。CLI操作全体の本人/Agent principal、SSO/IP、Kylonライブ受入は未完了 |

## Commercial

[比較元の公式仕様](https://kylon.io/pricing)

| ID | 要件 | 現状 | 優先 | コード根拠 | 完了条件・残差 |
|---|---|---|---|---|---|
| KY-086 | workspace共有クレジット | 一部 | P0 | [worker/src/workspaceAIBudget.js](../../worker/src/workspaceAIBudget.js) | Honmaruデプロイキーの記録済み価格に対するworkspace共通rolling USD参考価格上限・CAS設定。Kylon credit残高、invoice換算、事前予約・精算は未実装 |
| KY-087 | 月次更新・trial・追加pack | 一部 | P1 | [entitlements.js](../../worker/src/entitlements.js), [plans.js](../../worker/src/plans.js), [Plans.tsx](../../web-react/src/screens/Plans.tsx) | 既存StoreKit/RevenueCatの利用期間・trial・解約検知・請求問題・grace periodをPlan画面に表示し、購入/更新と権利の判定はApp Store/RevenueCatの正規結果に委ねる。新規課金サービスや購入商品は追加しない。Kylon公開料金ページは credit amounts/eligibility を未確定のconcept previewとし、Pro/Ultra・packの提供条件を確定できないため模倣しない。ボーナス/月次creditの残高・繰越・購入pack、plan変更のcredit適用時点・重複防止は未実装。自動テストではProvider payload検証済み、App Store実契約での本番表示QAは未実施 |
| KY-088 | 残高不足時停止と通知 | 一部 | P0 | [workspaceAIBudget.js](../../worker/src/workspaceAIBudget.js), [gate.js](../../worker/src/gate.js), [workspaceBudgetStop.js](../../worker/src/workspaceBudgetStop.js), [workflowSafety.js](../../worker/src/harness/workflowSafety.js), [workspace-ai-budget.test.js](../../worker/test/workspace-ai-budget.test.js) | 記録済みモデル/API価格のrolling 24h/7d/30d workspace上限、80%警告、warn/pause、価格不明時fail-closed、新規deployment-key要求拒否、対象Workflow/App副作用の事前admissionを実装。現在の作業バッチでは上限到達時にrevisionごと一回のRelay通知をOwner/Adminへ送り、Harness Dashboardで初回表示・再接続後に復元、Simpleでは表示しない。Worker 9、Web 34、migration check 8 pass。未mergeで本番受入・Kylon UI比較は残る。クレジット/請求、外部費用、厳密な事前予約、provider側実行停止は未実装 |
| KY-089 | agent数上限 | 一部 | P1 | [worker/src/customAgents.js](../../worker/src/customAgents.js) | 固定最大数ではなくplan別active数・trial数を制御 |
| KY-090 | 音声入力・AIとの音声会話 | 一部 | P2 | [web-react/src/components/JamPanel.tsx](../../web-react/src/components/JamPanel.tsx) | 人同士のJamとAI音声通話を区別して検証 |
| KY-091 | Web/Mac/iOS/Androidの機能一致 | 一部 | P1 | [apps/mobile/README.md](../../apps/mobile/README.md) | 端末ごとの操作・通知・ファイル・オフラインを受入試験 |
| KY-092 | ユーザーごとのSimple表示維持 | 一部 | P0 | [web-react/src/utils/harness.ts](../../web-react/src/utils/harness.ts) | 共有Workspaceモードと分離したユーザー×Workspace設定、同一ユーザー端末だけへのWebSocket通知、オフライン再接続同期を実装。`474e4fc557d4` をmain公開しCI #2088/#2089、Worker #237（schema/column migration・deploy・health）、Web #308を確認。本番ネイティブ画面のAXツリーで `/#/harness` と「すべての端末でシンプル版を使う」未チェック、共有モードHarnessを確認。設定値は変更していない。2台での書込→同期実測、iOS/Android設定画面比較、ピクセル目視は未完了（確認時の画面キャプチャが黒一色） |
| KY-093 | Simpleデータを破壊しない拡張 | 実装あり | P0 | [worker/src/harness/mode.js](../../worker/src/harness/mode.js) | 既定Simple・追加schema・切替で削除しない。リリース時に回帰試験 |

2026-10-16追記: 会話スコープ記憶、予約実行の会話アクセス再検証、フォローアップの一覧・ホーム・MCPの隔離、run定義固定を追加。詳細は [検証記録](verification.md)。

2026-10-18追記（レコード詳細）: テーブル・ボード・カレンダーから全項目の編集ダイアログを開き、ID・作成日時・更新日時を確認可能。変更フィールドのみを既存の競合検知付きAPIに保存。その後、アプリ／レコード固定会話（KY-005 / KY-043）、元スレッド、AI返信、メンション、全体Activity統合を追加して本番反映。上記行と検証記録に残差を記載し、完全一致とは扱わない。

### Room response update (2026-10-21)

KY-017 remains partial: room-level Mentioned only has versioned saves; Harness suppresses implicit continuations, proxy replies, and automatic issue work while retaining explicit mentions and DMs. Managed rooms now have a shared default-agent selector, and a clear request with a positive specialty match routes to that specialist; otherwise it uses the selected default, then a stable eligible-room fallback. Natural-name calls and a guarded same-author task follow-up in the same thread are also supported. Follow-up inheritance currently uses a provisional 2-minute window and task-cue list; compare against authenticated Kylon behavior before treating it as parity. Candidate grants are rechecked at route and commit time. Production and native verification are pending.

Current https://docs.kylon.io/concepts/rooms describes suitable-agent routing and a Mentioned only switch; it explicitly has no separate user-facing Orchestrator role. KY-018 remains an unfulfilled tracking requirement for leadership/handoff/concurrency, but no unobserved leader-selection UI is invented. Automatic suitable-agent routing and explicit agent-to-agent handoff remain gaps.


2026-10-23追記（公開ルーム参加・管理）: 管理対象ルームの検索・参加UIをHarnessの新規メニューに接続。Kylon実画面で未参加のみの候補表示と512pxダイアログを確認し反映。RoomCreateDialogは後続変更で作成APIまで接続済み（検証記録のManaged-room creation route and UI wiring参照）。既存ルームを自動的に管理対象へ移行しない。Web全体133スイート955テスト通過。Worker全体206スイート1,576テストも通過。この追記時点では本番未反映で、KY-001/009を完了扱いしない。

### 2026-10-23 実画面で追加確認したルーム差分

| ID | 要件 | 現状 | 優先 | コード根拠 | 完了条件・残差 |
|---|---|---|---|---|---|
| KY-094 | ルーム受信Webhookから専用スレッドとエージェント実行 | 一部 | P1 | [roomHooks.js](../../worker/src/harness/roomHooks.js) | 名前付き管理・失効・専用スレッド・重複抑止・永続配送・権限再確認・確認付き再実行を本番コードへ反映。2026-10-30、KylonとHonmaru本番の署名済みデスクトップでルーム設定→詳細設定→Webhook管理を読み取り比較。説明文・名前入力・無効な作成ボタン・空状態・閉じる導線が一致し、Honmaruのダークテーマでも可読性を確認。本番一覧は空。受信イベントからの本番スレッド生成、複数利用者での受入、失効をまたぐエージェント実行の実機比較は未確認 |
| KY-095 | ルームのカスタムビジュアルアップロード | 一部 | P1 | [RoomColorPicker.tsx](../../web-react/src/components/RoomColorPicker.tsx) | 本番Macで合成PNGのアップロード・一覧/ヘッダー表示・再読み込み保持・削除を確認。閲覧権限はAPIテスト済み。物理端末間反映と複数利用者での本番検証は残る。参照では入口のみ確認 |

既存のエージェント画像は公開URLを返すため、非公開ルーム画像へそのまま流用しない。既存MEDIA保存先は利用候補だが、ルームACLで認証する読み取り経路と失効後の表示破棄が必要。新規サービス契約は不要の設計方針とし、未実装を完了扱いしない。

2026-10-24追記: KY-018は世代で所有権を管理する明示引き継ぎ・履歴・停止操作と外部エージェントへの引き継ぎを実装したため「一部」に更新。失敗時の安全な自動交代、外部エージェントからの引き継ぎ開始、本番での実動作比較は未完了。OpenRouterツール実行はローカル検証段階。要件件数は完成率ではない。詳細なコミットと検証範囲はverification.mdを参照。

2026-11-08追記: 外部AgentのHarness実行から、明示した最終行マーカーで別のroom Agentへ引き継ぐ経路を追加。プロンプトにはその時点で利用可能かつ未訪問の相手だけを示し、結果受信時に元の人間リクエストと相手のroom/Agent権限を再確認して、既存の世代管理・原子的なhandoff outboxへ接続。Mock Claudeで成功と権限失効をテストした。本番・Kylonライブ比較、他Provider実機、安全な自動失敗交代は未完了。

### 2026-10-24 実画面追加差分

- KY-096: アプリ詳細メニューの「ワークスペース上にフローティング表示」。参照側で右下の独立パネルを確認。Honmaruは移動・サイズ変更・環境切替時の隔離を本番実装。c1e81790の必須CI・デプロイ・ログイン済み実機で小窓ヘッダーと会話操作を確認。2026-11-09の追加差分で、位置・サイズをアカウント／workspace／Appごとにブラウザー内へ保存し、再オープン時に画面内へ補正して復元するコードを追加。ローカル9テストとWeb buildは成功、main未統合。実ブラウザー再起動後の復元、Kylon側の会話遷移と再起動時の挙動、端末間同期は未確認。受入条件は requirements.json を参照。

| ID | 要件 | 現状 | 優先 | コード根拠 | 完了条件・残差 |
|---|---|---|---|---|---|
| KY-096 | ワークスペース上のフローティングアプリ表示 | 一部 | P1 | [FloatingAppWorkspace.tsx](../../web-react/src/components/FloatingAppWorkspace.tsx) | 位置・サイズはブラウザー内でユーザー／workspace／App単位に保存し、再オープン時に画面内へ収めて復元。ローカル10テストとWeb build成功。実ブラウザー再起動・本番QA・Kylonの会話遷移／再起動挙動・端末間同期は未確認。 |

### 2026-10-31 — アプリ詳細の視覚差分

| ID | 要件 | 現状 | 優先 | コード根拠 | 完了条件・残差 |
|---|---|---|---|---|---|
| KY-097 | データ表のインライン編集とダークテーマの視認性 | 一部 | P1 | [HarnessWorkspace.css](../../web-react/src/components/HarnessWorkspace.css) | ログイン済み画面でKylonは未選択セルを平坦に表示。Honmaruではセルが常時入力枠に見え、暗色面に緑かぶりがあった。セル通常時を平坦にし、hover/focusで操作状態を明示。中立なダーク配色とSimple維持のCSSはmain 3b0775b9で本番反映・配信assetを確認。認証済み本番でのセル通常/hover/focusとライト/ダークは未確認。 |

### 2026-10-31 — アプリ注釈

[Kylon公式のアプリ作成ヘルプ](https://kylon.io/help/build-an-app) に記載された注釈機能をログイン済み画面で確認。アプリの範囲を指定しAgentへ修正コメントを渡す導線をKY-098として追加。Honmaruでは範囲選択・親画面の要素特定・公開sandboxカスタム画面内の安全な要素名照会・会話への下書き挿入に加えて、注釈マーカー永続化、一覧/ピン再表示、添付メタデータ復元を実装。PR #576をmain c14a0f6で公開。実機QAで範囲ハイライトのpx/%変換漏れを修正し、PR #577をmerge commit 233faf0で公開、Webデプロイ #41198169985が成功。ログイン済みKylon/Honmaru双方で同じ空アプリの範囲選択と注釈入力欄を比較し、点線枠と選択範囲左下への入力欄配置をHonmaruへ反映中。Honmaru本番のQA用アプリへAIを起動しない注釈メッセージを1件送り、再読込後のピン・本文再表示まで確認。複数アカウントの本番拒否テストと二台同期は未実施。CIの同じコードSHA #41196471534は成功済み。これらの残差があるため一部のまま追跡する。

| ID | 要件 | 現状 | 優先 | コード根拠 | 完了条件・残差 |
|---|---|---|---|---|---|
| KY-098 | アプリ画面への範囲注釈とAgentへの修正依頼 | 一部 | P1 | [AppAnnotation.tsx](../../web-react/src/components/AppAnnotation.tsx), [appAnnotations.js](../../worker/src/harness/appAnnotations.js) | 対象範囲・要素名・位置を指定して編集可能な下書きを利用者が送信。送信済みマーカーを保存し一覧/ピンで再表示。PR #576/#577/#578。最新Web deploy #41199862857成功し、本番HonmaruでKylon同様の淡い点線範囲枠・左寄せ入力欄を実画面確認。最新main merge `25154abc` の全適用CI #41199862881は成功。認証済み本番QAで注釈送信、ピン・本文の再読込復元を確認。別ユーザー拒否・同一ユーザー二台同期・作成元スレッド経由の本番比較は残るため一部 |

### 2026-10-26 — Kylon usage controls

- [Kylon's current credit-usage help](https://kylon.io/help/limit-credit-usage) distinguishes rolling Automation budgets (last 24 hours, 7 days and 30 days; warn or pause after the current run) from workspace-wide caps for code calling paid APIs (daily, current billing period and calls per minute). Kylon records model and paid-tool/API calls in its credit ledger; a brought Agent's own provider model usage remains on that provider account.
- Honmaru's workflow and workspace controls use recorded model-token USD list-price estimates under the no-new-charge constraint. They do not reproduce Kylon credits, billable tool/API charges, renewal/top-up handling or script-call rate caps. Those differences remain in KY-067, KY-086 and KY-088; current exact-SHA CI and production evidence is tracked separately in [verification.md](verification.md).

|---|---|---|---|---|---|
| KY-099 | ワークスペース外の名前付きコラボレーターとリソース単位の権限 | 一部 | P0 | [worker/src/harness/externalCollaborators.js](../../worker/src/harness/externalCollaborators.js), [worker/src/harness/resourceAccess.js](../../worker/src/harness/resourceAccess.js), [worker/src/externalThreads.js](../../worker/src/externalThreads.js), [worker/src/externalFiles.js](../../worker/src/externalFiles.js), [worker/src/externalApps.js](../../worker/src/externalApps.js), [web-react/src/components/ExternalGuestApp.tsx](../../web-react/src/components/ExternalGuestApp.tsx) | Thread/File/Appの個別grantを維持。ThreadにAnyone-with-link (hash-at-rest、期限、失効、Thread限定grant)、Fileにview/edit招待・grantと同一Fileへの版追加、Appゲスト行の追加ページング、公開済みCustom Appの隔離実行を実装。Custom Appは公開HTMLとAppに紐づくテーブルのみに限定し、編集は外部grant検証API経由、server action/外部接続はゲストに公開しない。PR #870でFiles/Apps/ThreadsのWorkspace/Room audience共有と版管理・失効を追加。PR #872ではRoom audienceの参照先Roomが存在・未アーカイブかつtombstoneなしを必須化し、古いメンバー行による共有継続を拒否。今回Workspace既定viewのメンバーによるHTTP/MCP/Workflow書込みを拒否し、owner/admin既定editと明示edit grantを適用。名前検索招待、その他resource audience、認証済み複数利用者の本番比較は残る。Simpleモードはこのgrantモデルを参照しない |

### 2026-11-10 — Latest main release evidence

PR #870 is on main at `1e68161e5b2bbefb8e121a3a22f4ef5fd952994d`. Main CI [#42764954936](https://github.com/Torutesu/HonmaruAI/actions/runs/42764954936), Worker deploy [#42764954930](https://github.com/Torutesu/HonmaruAI/actions/runs/42764954930), and Web deploy [#42764955095](https://github.com/Torutesu/HonmaruAI/actions/runs/42764955095) succeeded. This release includes live Workspace/Room audience sharing for Files, Apps, and Threads; it does not establish full Kylon parity or multi-user production acceptance.
| KY-100 | 編集済みAI下書きの学習を元Agentへ引き継ぐ | 一部 | P1 | [ReplyDraft.tsx](../../web-react/src/components/ReplyDraft.tsx), [draftEdits.js](../../worker/src/draftEdits.js) | PR #788 / main 2070c407。編集差分を利用者・workspace・Agent・cardに限定し、同一Agentへの次の直接メッセージへ一度だけ引き継ぐ。編集例本文と明示的な個人文体設定を分離し、export/deleteを実装。PR exact-head CI 42348597887、main CI 42349710775、Worker deploy 42349710789（migration・health ok:true）、Web deploy 42349710776（app.honmaruai.com配信）成功。認証済み本番での編集・次回返信・破棄・設定・削除/エクスポートUI比較が残るため一部 |

### 2026-11-08 — レコード／フィールドを指した会話

| ID | 要件 | 現状 | 優先 | コード根拠 | 完了条件・残差 |
|---|---|---|---|---|---|
| KY-111 | Appのレコード／フィールドを指してAgentに更新を依頼 | 一部 | P1 | [AppAnnotation.tsx](../../web-react/src/components/AppAnnotation.tsx), [AppConversationPanel.tsx](../../web-react/src/components/AppConversationPanel.tsx), [worker/src/harness/routes.js](../../worker/src/harness/routes.js) | 表示中の列ID・レコードIDとレコードスナップショットを権限付き会話へ引き継ぎ、AIが変更案を出す。最大8フィールドの変更を24時間有効な提案として保存し、権限者の明示承認後のみupdateRowの型検証・CASで反映。拒否・期限切れ・競合を拒否し、未変更レコードへのCAS Undoを追加。undoの権限も再確認。Simple modeは変更なし、既存AI枠以外の課金なし。main CI 42494741384、Worker migrations/deploy/Verify 42494741296成功。認証済みのレコード・フィールド操作とKylon実画面比較は未完了。 |

### 2026-11-09 — Agent wake approval scopes release evidence

Kylonの[2026-10-30 changelog](https://kylon.io/changelog)は、別Agentを起こす際に `Allow once` / `Allow for 10 min`（既定）/ `Allow in this thread` / `Always allow in this room` を人が選ぶ仕様を記載。HonmaruはPR #823/#826で承認カード、範囲付きgrant、dispatch時権限再検証を実装し、exact-head CI 42493079407、main CI 42494741384、Worker deploy 42494741296（migration/deploy/Verify）が成功。ログイン済みKylon/Honmaru間の操作比較と本番複数利用者受入は残る。

| ID | 要件 | 現状 | 優先 | コード根拠 | 完了条件・残差 |
|---|---|---|---|---|---|
| KY-112 | Agent起動の実行単位人間承認と期限付き範囲 | 一部 | P0 | [agentAssignmentGrant.js](../../worker/src/harness/agentAssignmentGrant.js), [agentAssignments.js](../../worker/src/harness/agentAssignments.js), [relay.js](../../worker/src/relay.js) | assignment世代・operation・room/thread/source/targetに結合したpendingをD1に保存。承認前にhandoff message/outbox/claim/target callを作らない。private decision cardからonce/10分（既定）/thread/roomを選び、grantの期限・回数・bindingをサーバー側で検証。現行ACLをdecision/dispatch双方で再確認し、重複・取消・失効・競合・replayを拒否。PR #823/#826 exact-head CI 42493079407、main CI 42494741384、Worker migration/deploy/Verify 42494741296成功。Simple維持・新規課金なし。認証済み本番フローとKylon実画面比較は残る。 |
| KY-113 | 会話内インタラクティブチャートと解説ページ | 一部 | P1 | [MessageVisualization.tsx](../../web-react/src/components/MessageVisualization.tsx), [ClassicList.tsx](../../web-react/src/components/ClassicList.tsx), [agents.js](../../worker/src/harness/agents.js) | Harness会話内の限定JSONフェンスを検証し、native SVGの棒/折れ線チャート、系列切替、データ表、解説セクションを描画。PR #832、必須CI #5474/main CI #5475、Worker deploy #370/Web deploy成功。healthと同一配信assetを確認。HTML/JSは評価せず、不正データはコード表示、Simpleのrich text経路を維持。ライト/ダーク・レスポンシブ・保存後再表示・ログイン済みKylon比較は未確認。 |

### 2026-11-09 — Agent呼び出し回帰

Kylonの[2026-11-03 changelog](https://kylon.io/changelog)は、Agent名だけのスレッド呼び出し・進捗通知抑制を明記。既存Harnessルーティングの自然名認識について、`Billy, please review…` のスレッド呼び出し、依頼文から呼びかけを除く処理、Simple modeで起動しないことを1つの統合回帰テストに追加。Focused Worker test `harness-agents.test.js` は41件成功。短時間follow-up継続・通知タイミングのライブ比較は未確認。長時間タスクはKY-114で追跡する。

### 2026-11-09 — 長時間タスクのコンテキスト継続

Kylonの[2026-10-30 changelog](https://kylon.io/changelog)は、会話コンテキストが満ちてもAgentが内容を圧縮して継続すると説明。HonmaruのOpenAI Responsesループに、48,000 input-token到達時のローカルcheckpoint・新規Responses chain・completed tool result保持・同一tool callの重複抑止を追加。要約用の追加モデル呼び出しや別サービスは使わない。2回の圧縮、16 round/16 tool-call上限、実行ごとの既存deadlineと権限・キャンセルを維持。実行中Agent向けの部分実装であり、非OpenAI providerやSimpleは変更せず、ライブ長時間QA未実施のため一部扱い。

| ID | 要件 | 現状 | 優先 | コード根拠 | 完了条件・残差 |
|---|---|---|---|---|---|
| KY-114 | 長時間Agentタスクの文脈圧縮と継続 | 一部 | P1 | [agentResearch.js](../../worker/src/agentResearch.js), [agentChatTools.js](../../worker/src/agentChatTools.js), [agent-research.test.js](../../worker/test/agent-research.test.js), [agent-chat-tools.test.js](../../worker/test/agent-chat-tools.test.js) | OpenAI ResponsesとOpenRouter chat-tool経路の両方で、48,000 input tokensまたは累積tool結果が同じ推定文脈量に達した時点で、元依頼・直近文脈・完了済みtoolと結果・最新進捗をcheckpointへ変換し、新規chainで継続。圧縮は最大2回、16 model rounds、16 tool calls、実行deadline、権限確認・キャンセルを維持。完了済みの完全一致tool callを再実行しない。追加要約API/サービスなし。関連5スイート149件成功。BYO長時間の認証済み実画面QAは残る。PR #866 exact-head CI #42717933744、main CI #42720363920、Worker deploy #42720363385成功。本番health `ok:true`、app HTTP 200。Simple modeには適用しない。 |
| KY-115 | Agentからのプライベート並列サブエージェント | 一部 | P1 | [agentSubagents.js](../../worker/src/agentSubagents.js), [customAgents.js](../../worker/src/customAgents.js), [agent-subagents.test.js](../../worker/test/agent-subagents.test.js) | Harness Agentが最大2件を並列委譲。親のスコープ済み読み取りツールだけ、bounded context/task/result、30秒・4 model rounds・3 tool calls。書込・投稿・ブラウザ・承認・再委譲なし。認可失効時は結果を破棄し、Simpleではツールを出さない。認証済み本番QA、Kylonのrouting選択・run card/history・個別identity/credential・長時間cloud helperは未実装。追加サービス/課金なし。 |

### 2026-11-10 — KY-109 notification boundary follow-up
The inline Agent path is covered by an end-to-end Worker regression: progress stays in transient socket events, while the finished answer alone enters the requester's attention event and push queue. See [focused acceptance record](verification-ky109-notification-boundary.md). Device-level multi-user and external-runtime notification acceptance remain open.
