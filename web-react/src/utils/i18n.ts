// The interface, in the language the person reads.
//
// Card *content* was already translated by the Worker and picked up through
// `card.localized[locale]`. The chrome around it never was — so choosing 日本語
// under You changed the notifications and nothing on the screen, which reads
// as a setting that does not work.
//
// The key is the English string. That keeps the call sites readable, makes a
// missing translation degrade to English rather than to a key name, and means
// adding a language is adding one column here.

import { getLocale, setLocale, primary } from './locale'
import { useSyncExternalStore, useCallback } from 'react'

type Dict = Record<string, string>

const ja: Dict = {
  "What’s on your mind?": "何を伝えますか？",
  "Speak": "話す",
  "Write": "書く",
  "AI will turn your words into a card.": "AIが内容をカードにまとめます。",
  "Edit details": "編集",
  "Set up team": "チームを設定",
  "Invite a teammate or join a team. Your draft stays here.": "チームに招待するか、参加してください。下書きはここに残ります。",
  "Team": "チーム",
  "Your team": "参加中のチーム",
  "Share invite code": "招待コードを共有",
  "People with this code can join your team and access its shared work.": "このコードを受け取った人はチームに参加し、共有された業務を閲覧できます。",
  "Join team": "参加する",
  "Join a team": "チームに参加",
  "Team joined. Your draft is still available.": "チームに参加しました。下書きは残っています。",
  "Enter a code from your teammate to switch to their team.": "メンバーから受け取ったコードを入力して、そのチームに切り替えます。",
  "Back to draft": "下書きに戻る",
  "Send to": "宛先",

  "That code is not valid.": "コードが正しくありません。",
  "We could not send another code.": "コードを再送できませんでした。",
  "Sent. Check your email again.": "送信しました。メールをご確認ください。",
  "We sent a six-digit code to {email}. It is valid once, for ten minutes.": "{email}に6桁のコードを送りました。有効期限は10分で、1回のみ使用できます。",
  "Digit {n}": "{n}桁目",
  "Checking…": "確認中…",
  "Send another code in {n}s": "{n}秒後に再送できます",

  "Your team could not be loaded.": "チームを読み込めませんでした。",
  "Reminder requested.": "リマインダーの送信をリクエストしました。",
  "Local sample": "ローカルのサンプル",
  "Sign in to manage billing.": "サインインするとプランを管理できます。",
  "Sample workspace reset.": "サンプルワークスペースをリセットしました。",
  "Previous request": "前の依頼",
  "Next request": "次の依頼",
  "Search requests": "依頼を検索",
  "Search requests or people…": "依頼やメンバーを検索…",
  "Clear search": "検索をクリア",
  "Filters": "絞り込み",
  "Filter by type": "種類で絞り込む",
  "Filter by priority": "優先度で絞り込む",
  "All types": "すべての種類",
  "All priorities": "すべての優先度",
  "No matching requests.": "一致する依頼はありません。",
  "Choose a teammate and review your request before sending.": "宛先を選び、送信前に依頼を確認してください。",

  "Approval": "承認依頼",
  "medium": "中",
  "low": "低",
  "Create a sample request. Choose a teammate and review the details.": "サンプルの依頼を作成します。宛先を選んで内容を確認してください。",
  "Some connections need configuration before requests can be imported.": "依頼を取り込むには、連携先の設定が必要です。",
  "GitHub issue synchronization requires a GitHub-connected workspace.": "GitHubのIssue同期には、GitHubと接続したワークスペースが必要です。",
  "Notion databases could not be loaded. Reopen Tools to try again.": "Notionのデータベースを読み込めませんでした。「ツール」を開き直してください。",
  "Notion synced. {n} new requests.": "Notionを同期しました。新しい依頼は{n}件です。",
  "Notion database saved. You can now sync requests.": "Notionのデータベースを保存しました。依頼を同期できます。",
  "Choose the database to import requests from before syncing.": "同期する前に、依頼の取り込み元データベースを選択してください。",
  "Loading databases…": "データベースを読み込み中…",
  "Notion database": "Notionデータベース",
  "Choose a database": "データベースを選択",
  "Save database": "データベースを保存",
  "Sync": "同期",
  "Working…": "処理中…",
  "No shared databases found. Grant Notion access to a database, then reopen Tools.": "共有されたデータベースがありません。Notionでデータベースへのアクセスを許可してから「ツール」を開き直してください。",
  "The code could not be copied. Select and copy it manually.": "コードをコピーできませんでした。選択して手動でコピーしてください。",
  "Set up later": "あとで設定",
  "Which language do you prefer?": "どの言語で使いますか？",
  "Choose your role. You can change it in Profile.": "役割を選んでください。プロフィールで変更できます。",
  "Use Honmaru AI in the language you read.": "読みやすい言語でHonmaru AIを使いましょう。",
  "Sample request": "サンプルの依頼",
  "Product lead": "プロダクト責任者",
  "Design": "デザイン",
  "Engineering": "開発",
  "Operations": "業務運営",
  "Customer success": "カスタマーサクセス",
  "Product launch": "製品リリース",
  "Customer experience": "顧客体験",
  "Approve the autumn launch homepage": "秋のリリース向けホームページを承認",
  "The homepage is ready for a final review. Can you approve the new messaging and pricing section so we can publish on Thursday?": "ホームページの最終確認をお願いします。木曜の公開に向けて、新しいメッセージと料金ページを承認してもらえますか？",
  "The design and engineering reviews are complete. The page introduces the Team plan at $24 per member and includes the customer quote approved by Acme.\n\nWe need your sign-off on the headline and plan positioning before the campaign assets go into production.": "デザインと開発のレビューは完了しています。1人あたり24ドルのTeamプランと、Acmeが承認した導入コメントを掲載しています。\n\nキャンペーン制作の前に、見出しとプランの訴求について承認をお願いします。",
  "Check the new teammate onboarding flow": "新メンバーの参加手順を確認",
  "Please test the invite-to-workspace flow and confirm that a new teammate can find their first request without help.": "招待からワークスペース参加までを試し、新メンバーが最初の依頼を自分で見つけられるか確認してください。",
  "The latest build now opens directly into the shared inbox after accepting an invite. Check the empty state, member names, and the first-request walkthrough.\n\nLeave your findings in the response if anything needs to change.": "最新ビルドでは招待を受けると共有の受信一覧が開きます。空の画面、メンバー名、最初の依頼の案内を確認してください。\n\n変更が必要な点は回答に記入してください。",
  "Update the Acme renewal proposal": "Acmeの更新提案を修正",
  "Acme asked for a quarterly billing option. Please revise the proposal before their procurement review on Friday.": "Acmeが四半期払いを希望しています。金曜の購買レビュー前に提案を修正してください。",
  "The scope and annual commitment stay the same. Replace the annual payment schedule with four quarterly installments and add the support response times we discussed.": "範囲と年間契約は変えません。支払いを年4回に変更し、合意したサポート対応時間を追記してください。",
  "Customer interviews: the three recurring themes": "顧客インタビューで共通した3つの課題",
  "Five interviews are complete. Teams want clearer ownership, fewer status meetings, and a reliable record of decisions.": "5件のインタビューを終えました。明確な担当者、進捗会議の削減、判断の履歴が求められています。",
  "No decision is needed today. These findings will shape next week’s planning session. The strongest signal was that people want to see who is waiting on whom without sending another message.": "本日の判断は不要です。来週の計画に反映します。追加のメッセージを送らずに、誰が誰の回答を待っているか把握したいという声が目立ちました。",
  "Take ownership of next week’s launch check-in": "来週のリリース確認会を引き継ぐ",
  "Could you lead Tuesday’s 30-minute launch check-in while I am away? Design, engineering, and customer success will attend.": "不在のため、火曜の30分間のリリース確認会を進行してもらえますか？デザイン・開発・CSが参加します。",
  "Review the remaining blockers, confirm each owner, and share a short recap after the meeting. The agenda is already prepared; no slide deck is needed.": "残っている課題と担当者を確認し、終了後に短い要約を共有してください。議題は準備済みで、スライドは不要です。",
  "Confirm the launch-day monitoring checklist": "リリース当日の監視チェックリストを確認",
  "Please check that the alert owners and rollback steps are documented before Thursday’s launch.": "木曜のリリース前に、アラートの担当者と復旧手順が文書化されているか確認してください。",
  "Share the checklist with the on-call engineer after your review.": "確認後、チェックリストを当番のエンジニアに共有してください。",
  "Approve the September team workshop budget": "9月のチーム研修予算を承認",
  "Please approve the $1,200 venue and catering budget for the September team workshop.": "9月のチーム研修の会場・飲食費1,200ドルについて承認をお願いします。",
  "The budget covers 12 people and stays within the quarterly team allocation.": "12人分の費用で、チームの四半期予算内です。",
  "Reshoot covers the new signup flow. Same crew as June and it lands 15% under this quarter’s video budget.": "新しい登録手順に合わせて案内動画を再撮影します。6月と同じチームが担当し、今四半期の動画予算を15%下回る見積もりです。",
  "This request is 15% under this quarter’s video budget and consistent with similar requests you’ve approved in the past.": "今四半期の動画予算を15%下回り、過去に承認した類似の依頼とも整合しています。",

  "(optional)": "（任意）",
  "A recipient could not be confirmed.": "宛先を確認できませんでした。",
  "AI-assisted draft. Review the details before sending.": "AIが作成した下書きです。送信前に内容を確認してください。",
  "Accept handoff": "引き受ける",
  "Acknowledge": "確認済みにする",
  "Add a link": "リンクを追加",
  "Add to request": "依頼に追加",
  "Attach a video": "動画を添付",
  "Background": "背景・補足",
  "Changes stay in this browser. No messages or notifications are sent.": "変更はこのブラウザ内だけに保存されます。メッセージや通知は送信されません。",
  "Choose a teammate": "チームメンバーを選択",
  "Choose a video smaller than 12 MB.": "12 MB未満の動画を選んでください。",
  "Complete revision": "修正を完了",
  "Complete task": "タスクを完了",
  "Completed": "完了済み",
  "Confirming delivery…": "送信を確認中…",
  "Could not confirm delivery. Check Sent before retrying.": "送信を確認できませんでした。再送する前に送信済みの依頼を確認してください。",
  "Could not join workspace.": "ワークスペースに参加できませんでした。",
  "Create account": "アカウントを作成",
  "Create an account": "アカウントを作成",
  "Create sample request": "サンプルの依頼を作成",
  "Decision feed": "判断待ちの依頼",
  "Direct request": "直接の依頼",
  "Dismiss": "閉じる",
  "Email and password.": "メールアドレスとパスワード",
  "Email me a code instead": "メールでコードを受け取る",
  "Exit demo": "デモを終了",
  "Home": "ホーム",
  "Join workspace": "ワークスペースに参加",
  "Join your workspace": "ワークスペースに参加",
  "Joining…": "参加中…",
  "No code? You get a workspace of your own, and can invite people into it.": "コードがなくても自分のワークスペースを作成して、メンバーを招待できます。",
  "Nothing settled yet.": "まだ完了した依頼はありません。",
  "One moment…": "お待ちください…",
  "Opening your workspace…": "ワークスペースを開いています…",
  "Original source": "元の情報",
  "Prepared without AI. Review and edit before sending.": "AIを使わずに作成しました。送信前に確認・編集してください。",
  "Preparing…": "作成中…",
  "Read full request": "依頼をすべて読む",
  "Recipient": "宛先",
  "Recommended:": "推奨：",
  "Reconnect before saving a response.": "接続が戻ってから回答を保存してください。",
  "Reconnect before sending a reminder.": "接続が戻ってからリマインダーを送信してください。",
  "Reconnect before undoing a response.": "接続が戻ってから回答を取り消してください。",
  "Reconnect to send. Your draft stays here.": "再接続すると送信できます。下書きは保持されています。",
  "Request": "依頼内容",
  "Request details": "依頼の詳細",
  "Request revision": "修正を依頼",
  "Request sent. You can find it in Classic under Sent by you.": "送信しました。リストの「送信した依頼」で確認できます。",
  "Request type": "依頼の種類",
  "Reset demo": "デモをリセット",
  "Respond to sender": "依頼者に回答",
  "Response saved.": "回答を保存しました。",
  "Response undone. The request is waiting again.": "回答を取り消し、判断待ちに戻しました。",
  "Review and edit the request before sending.": "送信前に依頼を確認・編集してください。",
  "Review manually": "自分で内容を確認",
  "Review request": "依頼を確認",
  "Sample draft. Nothing is sent outside this browser.": "サンプルの下書きです。このブラウザの外には送信されません。",
  "Sample recommendation:": "サンプルの推奨：",
  "Sample reminder recorded locally. No notification was sent.": "サンプルのリマインダーを保存しました。通知は送信されていません。",
  "Sample request created locally. Find it in Classic under Sent by you.": "サンプルの依頼を作成しました。リストの「送信した依頼」で確認できます。",
  "Sample response saved locally.": "サンプルの回答を保存しました。",
  "Sample response undone locally.": "サンプルの回答を取り消しました。",
  "Sample workspace": "サンプルワークスペース",
  "Sample workspace · local only": "サンプルワークスペース · ローカルのみ",
  "Saving response…": "回答を保存中…",
  "Send request": "依頼を送信",
  "Show less": "閉じる",
  "Sign in": "サインイン",
  "Something went wrong.": "エラーが発生しました。",
  "Stop voice input": "音声入力を停止",
  "Subject": "件名",
  "Tell your AI — e.g. ask Yuki to approve the spring menu by Friday": "例：春のメニューを金曜までに承認してほしいと田中さんに依頼して",
  "The complete original request is retained with this summary.": "元の依頼の全文は、この要約と一緒に保持されます。",
  "The request will return to waiting. Changes already made in connected tools are not undone.": "依頼を判断待ちに戻します。連携ツールで行った変更は取り消されません。",
  "The response is not confirmed yet. Check the request before retrying.": "回答の保存をまだ確認できていません。再試行の前に依頼の状態を確認してください。",
  "The sample request will return to waiting. No notifications are sent.": "サンプルの依頼を判断待ちに戻します。通知は送信されません。",
  "The video could not be attached. Try again.": "動画を添付できませんでした。もう一度お試しください。",
  "This workspace cannot send email yet — use a password for now.": "このワークスペースはメール送信が未設定です。パスワードでサインインできます。",
  "Try a local sample workspace": "サンプルで試す",
  "Undo": "取り消す",
  "Undo response": "回答を取り消す",
  "Undo response?": "回答を取り消しますか？",
  "Urgent": "至急",
  "Use a password instead": "パスワードでサインイン",
  "View original": "原文を見る",
  "Voice input": "音声入力",
  "Voice input could not start.": "音声入力を開始できませんでした。",
  "Voice input is unavailable in this browser. You can use your keyboard’s dictation.": "このブラウザでは音声入力を利用できません。キーボードの音声入力機能をご利用ください。",
  "Voice input stopped. You can keep typing.": "音声入力を停止しました。続けて文字を入力できます。",
  "We could not send a code.": "コードを送信できませんでした。",
  "We send a six-digit code. Nothing to remember, and it proves where your decisions should reach you.": "メールに6桁のコードをお送りします。コードを入力してサインインしてください。",
  "Welcome back.": "おかえりなさい。",
  "What needs your attention?": "何を確認しますか？",
  "Write your response…": "回答を入力…",
  "You are signed in. Enter a teammate’s invite code to restore workspace access.": "サインイン済みです。メンバーから受け取った招待コードでワークスペースに参加してください。",
  "You can continue by reviewing manually.": "自分で内容を確認して続けられます。",
  "Your AI needs an address.": "メールアドレスを入力してください。",
  "Your requests will appear when the connection is ready.": "接続が完了すると依頼が表示されます。",
  "Your response completes this request.": "回答を送信すると、この依頼は完了します。",
  "Your team is loading. Try again in a moment.": "チームを読み込み中です。少し待ってからお試しください。",
  "approve": "承認",
  "decline": "却下",
  "fallback": "手動作成",
  "high": "高",
  "revision": "修正依頼",
  "rollback": "取り消し",
  "signup": "アカウント作成",
  "task": "タスク",
  "urgent": "至急",
  "Ask anything…": "依頼を入力…",
  "View history": "履歴を見る",
  "Created in the demo. You can follow the request in History.": "デモに作成しました。履歴で依頼を確認できます。",
  "Request queued. You can follow delivery and the outcome in History.": "送信待ちに追加しました。履歴で送信状況と結果を確認できます。",
  "Marketing Manager": "マーケティング責任者",
  "Approve $1,840 for the onboarding video reshoot": "案内動画の再撮影費用 $1,840 を承認",
  "Reshoot covers the new signup flow. Same crew as June and it lands 15% under this quarter's video budget.": "新しい登録手順に合わせて案内動画を再撮影します。6月と同じチームが担当し、今四半期の動画予算を15%下回る見積もりです。",
  "This is sample data from the product design. No budget approval or external work is performed in the demo.": "製品デザインのサンプルデータです。デモでは実際の予算承認や外部への操作は行いません。",
  "This request is 15% under this quarter's video budget and consistent with similar requests you've approved in the past.": "今四半期の動画予算を15%下回り、過去に承認した類似の依頼とも整合しています。",
  "We need to reshoot the onboarding video to reflect the new signup flow. Current video is causing confusion and drop-off.": "新しい登録手順を反映するため、案内動画の再撮影が必要です。現在の動画は混乱や離脱の原因になっています。",
  "The original message was not included with this request.": "この依頼には元のメッセージが含まれていません。",
  "Open original source": "元の情報を開く",
  "This account has no workspace. Join a team to send requests.": "このアカウントはワークスペースに参加していません。チームに参加すると依頼を送信できます。",

  "Your AI teammate that helps you make the right decisions, every time.": "より良い判断を、いつもそばで支えるあなたのAIチームメイト。",
  "Honmaru AI": "Honmaru AI",
  "Welcome to": "ようこそ",
  "This removes your account and your cards. Decisions other people made stay in their record.": "アカウントと自分のカードを削除します。他の人が行った判断は、その人の履歴に残ります。",
  "Account": "アカウント",
  "The AI model is configured by your workspace.": "AIモデルはワークスペースで設定されています。",
  "This deployment uses keyword routing.": "この環境ではキーワードで依頼を振り分けます。",
  "AI routing": "AIによる振り分け",
  "Your AI assistant": "あなたのAIアシスタント",
  "Unavailable": "利用不可",
  "Configured": "設定済み",
  "Keyword routing": "キーワードで振り分け",
  "AI": "AI",
  "Profile": "プロフィール",
  // Getting in
  'Get started': 'はじめる',
  'I already have an account': 'アカウントを持っている',
  'One feed': 'ひとつのフィード',
  'Everything waiting on you, most urgent first.': 'あなたの判断を待っているものを、急ぐ順に。',
  'Ten businesses, ten people': '10の事業、10人',
  'Every decision filed under the right one, in the background.': 'どの決定も、裏側で正しい事業に紐づきます。',
  'In your language': 'あなたの言語で',
  'The decision is': 'その決定は、',
  'already waiting.': 'もう待っています。',
  'welcome.lede':
    'あなたは自分のAIにだけ話しかけます。AIが「誰が何を決めるべきか」を判断し、相手のAIが一枚のカードとして本人に差し出します。チャンネルも、受信箱も、「あのメッセージ見た？」もありません。',
  'Notifications arrive written in the language you read.': '通知は、あなたが読む言語で届きます。',
  'Sign in with email': 'メールでサインイン',
  'Sign in with GitHub': 'GitHubでサインイン',
  Email: 'メールアドレス',
  Password: 'パスワード',
  'At least 8 characters': '8文字以上',
  'you@company.com': 'you@company.com',
  'Your name': 'お名前',
  'What your team calls you': 'チームでの呼び名',
  'Invite code': '招待コード',
  'Paste one to join a team': 'チームに参加するには貼り付けてください',
  'Email me a code': 'コードを送る',
  'Check your email': 'メールを確認してください',
  'Enter the code.': 'コードを入力してください。',
  Continue: '続ける',
  'Send another code': 'コードを再送する',
  Back: '戻る',
  Cancel: 'キャンセル',
  Skip: 'スキップ',
  'Sign out': 'サインアウト',

  // Onboarding
  'Two questions': 'ふたつの質問',
  'What do you mostly decide?': 'あなたが主に決めているのは？',
  'Where it goes': '届く場所',
  Language: '言語',
  Done: '完了',

  'ob.tell.title': 'AIに伝えるだけ。チャンネルではなく。',
  'ob.tell.body': '「新しい仕入価格の承認を健二にお願いして」。やりとりはこれだけです。投稿する場所も、@で呼ぶ相手も、選ぶチャンネルもありません。',
  'ob.route.title': '誰が決めるかは、AIが判断します。',
  'ob.route.body': 'あなたのAIがチームを読み取り——役割、担当、手一杯の人——適切な相手のAIに渡します。相手のAIは、あなたの文章ではなく、その人が決めるためのカードに書き直します。',
  'ob.swipe.title': 'ワンタップで片づく。',
  'ob.swipe.body': '承認、却下、修正依頼、他の人へ委任。答えは依頼した本人にそのまま返ります。必要ならGitHubにも。',
  'routes to whoever decides': '決める人に届く',
  'Approved. Kenji’s AI already knows.': '承認しました。健二のAIにはもう伝わっています。',
  'Declined. Kenji’s AI already knows.': '却下しました。健二のAIにはもう伝わっています。',
  'waiting': '保留',
  'decided': '決定済み',
  'businesses': '事業',
  'save 20%': '20%お得',
  'Annual': '年払い',
  'Monthly': '月払い',

  // The feed
  'Tell your AI': 'AIに伝える',
  'compose.hint': '誰に、何を決めてもらい、いつまでか。AIがカードにして振り分けます。',
  Feed: 'フィード',
  History: '履歴',
  Tools: 'ツール',
  You: 'あなた',
  Cards: 'カード',
  Priority: '優先度',
  Notification: '連絡',
  Task: 'タスク',
  Delegation: '委任',
  Revision: '修正依頼',
  admin: '管理者',
  member: 'メンバー',
  founder: '経営',
  operator: '運営',
  engineer: 'エンジニア',
  designer: 'デザイナー',
  triager: 'トリアージ',
  maintainer: 'メンテナ',
  Classic: 'リスト',
  'Ask anything...': 'なんでも聞いてください…',
  'Nothing is waiting on you.': '待っているものはありません。',
  'Nothing sent yet. Tell your AI something.': 'まだ何もありません。AIに話しかけてみてください。',
  'No decisions yet.': 'まだ決定はありません。',
  'Nothing decided yet.': 'まだ何も決まっていません。',
  'Nothing yet.': 'まだありません。',
  'You have not sent anything yet.': 'まだ何も送っていません。',
  'Requested By': '依頼者',
  Approve: '承認',
  Decline: '却下',
  Nudge: 'リマインド',
  View: '開く',
  Send: '送信',
  'Reply with a note': 'ひとこと返す',
  'Ask your AI about this decision': 'この決定についてAIに聞く',
  Low: '低',
  Medium: '中',
  High: '高',
  Approved: '承認済み',
  Declined: '却下',
  Waiting: '保留中',
  'Waiting on you': 'あなた待ち',
  'Waiting on {name}': '{name}待ち',
  'Sent by you': 'あなたが送信',
  Decided: '決定済み',
  Everything: 'すべて',
  'You decided': 'あなたが決めた',
  'You asked': 'あなたが依頼した',
  Today: '今日',
  Yesterday: '昨日',
  'just now': 'たった今',
  '{n}m ago': '{n}分前',
  '{n}h ago': '{n}時間前',
  '{n}d ago': '{n}日前',

  // You
  'How your AI treats you': 'AIのふるまい',
  Role: '役割',
  'What gets routed to you first.': '何が優先して届くか。',
  'Every notification arrives written in it.': '通知はこの言語で届きます。',
  'Your workspace': 'ワークスペース',
  'Everything already settled.': '決着したものすべて。',
  'The record': '記録',
  'Every decision, by business, written by nobody.': 'すべての決定を、事業ごとに、自動で。',
  'Google Calendar': 'Google カレンダー',
  'Google Drive': 'Google ドライブ',
  'Meetings still waiting on an answer from you.': 'あなたの返事を待っている予定。',
  'Documents someone put in front of you.': '誰かがあなたに共有した資料。',
  'Gmail, Slack, Notion, GitHub.': 'Gmail、Slack、Notion、GitHub。',
  Notifications: '通知',
  'Where a decision reaches you.': '決定が届く場所。',
  'Invite a teammate': 'メンバーを招待',
  'Their role': '相手の役割',
  'What their AI puts in front of them first.': '相手のAIが最初に差し出すもの。',
  'Anyone who signs up with this code joins your workspace as {role}.':
    'このコードで登録した人は、{role}としてワークスペースに参加します。',
  'Create another': 'もう一つ作る',
  'They get their own AI, in this workspace.': '相手にもこのワークスペースのAIが用意されます。',
  Plan: 'プラン',
  'What you are on, and what else there is.': '現在のプランと、ほかの選択肢。',
  'Delete account': 'アカウントを削除',
  Delete: '削除',
  'Keep it': 'やめる',
  Waiting_stat: '保留',
  Businesses: '事業',
  'Businesses your AI has found': 'AIが見つけた事業',

  'notify.language':
    'どの経路で届いても、文面はあなたの言語で書かれます。決定を動かした人の言語ではなく。',
  'history.blurb': '決まった瞬間にここに並びます。あなたが決めたものも、依頼したものも。',
  'businesses.blurb': 'この一覧は誰も作っていません。決定が積まれるにつれて増えていきます。',
  'On iPhone, add this to your home screen first — Safari only allows notifications for an installed web app.':
    'iPhoneではまずホーム画面に追加してください。Safariはインストール済みのWebアプリにしか通知を許可しません。',
  'Blocked in your browser settings — allow notifications for this site to turn it on.':
    'ブラウザの設定でブロックされています。このサイトの通知を許可してください。',
  'A decision that needs you arrives even when this tab is closed.':
    'このタブを閉じていても、あなたの判断が必要な決定は届きます。',
  'Email as the fallback': '予備の連絡先としてのメール',
  'Changing this changes nothing else — it is only where mail lands.':
    'ここを変えても他には影響しません。メールの届き先だけです。',
  'This is the address you sign in with, so it cannot be changed here.':
    'サインインに使っているアドレスなので、ここでは変更できません。',

  // Notifications
  'On this device': 'この端末で',
  'By email': 'メールで',
  'Email fallback': 'メールでの通知',
  'Push notifications': 'プッシュ通知',
  'Turn on notifications': '通知をオンにする',
  'Always on': '常時オン',
  'All clear': 'すべて完了',
  'Nothing is waiting on you. Your AI will tell you when something is.':
    '待っているものはありません。何か来たらAIが知らせます。',
  'Only when no device of yours can be reached. Never a duplicate.':
    'どの端末にも届かなかったときだけ。重複して届くことはありません。',
  'Every notification reaches you in this language, whoever wrote it.':
    '誰が書いたものでも、通知はこの言語で届きます。',
  'You are on Pro. Unlimited routing, every business, the full record.':
    'Proプランです。ルーティング無制限、事業数無制限、記録もすべて。',
  'Decision · high': '決定 · 高',
  'Supplier price +8%': '仕入価格 +8%',
  'Kenji needs an answer today to hold this month’s slot.':
    '今月の枠を押さえるため、健二が今日中の返事を待っています。',
  'Decision:': '決定:',
  'Revision:': '修正依頼:',

  // Buttons and states mid-action
  'Routing…': '送信中…',
  'Saving…': '保存中…',
  'Creating…': '作成中…',
  'Copy': 'コピー',
  'Copied': 'コピーしました',
  'Copied!': 'コピーしました',
  'Copy as Markdown': 'Markdownでコピー',
  'Create invite code': '招待コードを作る',
  'Next': '次へ',
  'Set me up': 'はじめる',
  'Open my feed': 'フィードを開く',
  'Reconnecting…': '再接続中…',
  'Decisions': '決定',
  'Not yet filed': '未分類',

  // What happened to a decision
  'Approved.': '承認しました。',
  'Declined.': '却下しました。',
  'Revision asked': '修正を依頼',
  'Chose': '選択',
  'Replied': '返信',
  'Acknowledged': '確認',
  'Delegated': '委任',
  'Deferred': '保留',

  // Roles
  'Founder / operator': '経営 / 運営',
  'You decide most things, and want the rest to stop reaching you.': 'ほとんどを自分で決める。それ以外は届かないでほしい。',
  'Ops / business': '事業 / オペレーション',
  'Suppliers, bookings, money, people.': '仕入、予約、お金、人。',
  'Engineer': 'エンジニア',
  'Anything shipping-related routes to you.': 'リリースに関わるものが届きます。',
  'Designer': 'デザイナー',
  'Anything about how it looks or reads.': '見た目と文章に関わるものが届きます。',
  'Something else': 'その他',
  'Member': 'メンバー',
  'Admin': '管理者',
  'Maintainer': 'メンテナ',
  'Triager': 'トリアージ',
  'Your AI works it out from what people send you.': '届くものからAIが判断します。',

  // Things that went wrong
  'Could not read your profile.': 'プロフィールを読み込めませんでした。',
  'Could not read your settings.': '設定を読み込めませんでした。',
  'That did not save.': '保存できませんでした。',
  'Could not create invite.': '招待コードを作れませんでした。',
  'Your AI could not route that.': 'AIがうまく振り分けられませんでした。',
  'Routing failed': '振り分けに失敗しました',
  'This browser cannot receive push notifications here.': 'このブラウザではプッシュ通知を受け取れません。',
  'This browser cannot receive them.': 'このブラウザでは受け取れません。',
  'Could not turn notifications on. Try again in a moment.': '通知をオンにできませんでした。しばらくして試してください。',
  'That did not work. Try again in a moment.': 'うまくいきませんでした。しばらくして試してください。',
  'We could not save that.': '保存できませんでした。',

  // Tools
  'tools.lede':
    '連携したツールはAIに情報を渡します。ここにチャンネルは増えません。返ってくるのは決定で、ほかと同じフィードに並びます。',
  Connected: '接続済み',
  Connect: '接続する',
  'Pull now': '今すぐ取り込む',
  'Pulling…': '取り込み中…',
  'Mail that needs a decision becomes a card. Nothing else does.':
    '判断が必要なメールだけがカードになります。それ以外はなりません。',
  'Messages addressed to you, triaged into decisions — without you opening Slack.':
    'あなた宛のメッセージを決定に整理します。Slackを開く必要はありません。',
  'Decisions are written back to the database you point at.':
    '決定は、指定したデータベースに書き戻されます。',
  'Approvals, tasks and assignee changes sync to Issues and Pull Requests.':
    '承認・タスク・担当者の変更が、IssueとPull Requestに同期されます。',
  'Feeds decisions into your feed.': '決定をフィードに流し込みます。',
  'Connectors are not switched on for this workspace yet.':
    'このワークスペースでは連携がまだ有効になっていません。',
  'Could not load your tools.': 'ツールを読み込めませんでした。',
  'Could not start that connection.': '接続を開始できませんでした。',
  'Finish in the tab that opened, then come back and pull.':
    '開いたタブで手続きを終えてから、戻って取り込んでください。',
  'Nothing could be pulled just now.': '今は取り込めるものがありませんでした。',
  '{n} new in your feed.': 'フィードに{n}件届きました。',
  'Nothing new needed you.': 'あなたの判断が必要な新しいものはありません。',
  'Built in': '標準搭載',
  'No connectors are available on this deployment.': 'この環境では連携ツールを利用できません。',
  'Event log': 'イベントログ',

  // Plans
  'Choose your plan': 'プランを選ぶ',
  Free: '無料',
  Close: '閉じる',
  'Loading…': '読み込み中…',
  Filter: '絞り込み',
  Main: 'メイン',
  'Billing period': '請求期間',
}

// Most keys are their own English text. A few sentences are too long to read
// well as a key, so they get a name and an entry here; `t` falls back through
// this before falling back to the key itself.
const en: Dict = {
  'compose.hint':
    'Who it is for, what they decide, and by when. Your AI writes the card and routes it.',
  'tools.lede':
    'Connected tools feed your AI. They do not put channels in here — what comes back is decisions, in the same feed as everything else.',
  'notify.language':
    'Whichever channel carries it, the words are written in your language — not the language of whoever set the decision in motion.',
  'history.blurb':
    'Decisions land here the moment they are made — yours and the ones you asked for.',
  'businesses.blurb': 'Nobody made this list. It grows as decisions are filed.',
  'ob.tell.title': 'Tell your AI. Not a channel.',
  'ob.tell.body':
    '“Ask Kenji to sign off on the new supplier price.” That is the whole interaction. There is nowhere to post it, nobody to @-mention, and no channel to pick.',
  'ob.route.title': 'It works out who decides.',
  'ob.route.body':
    'Your AI reads your team — roles, who owns what, who is drowning — and hands it to the right person’s AI, which rewrites it as a card built for their decision, not your sentence.',
  'ob.swipe.title': 'Clear it in one tap.',
  'ob.swipe.body':
    'Approve, decline, ask for a revision, or hand it to someone else. The answer goes straight back to the person who asked — and to GitHub, if it belongs there.',
  'welcome.lede':
    'You talk to your own AI. It works out who needs to decide what, and their AI puts it in front of them as a card they can clear in a swipe. No channels. No inbox. No “did you see my message?”.',
}

const TABLES: Record<string, Dict> = { en, ja }

let current = primary(getLocale())
const listeners = new Set<() => void>()

function snapshot(): string {
  return current
}

function subscribe(fn: () => void): () => void {
  listeners.add(fn)
  return () => { listeners.delete(fn) }
}

/// Translate. The key is the English string, so an untranslated one shows in
/// English rather than as a missing-key placeholder.
export function t(key: string, vars?: Record<string, string | number>): string {
  const table = TABLES[current]
  let out = (table && table[key]) || en[key] || key
  if (vars) {
    for (const [name, value] of Object.entries(vars)) {
      out = out.replace(new RegExp(`\\{${name}\\}`, 'g'), String(value))
    }
  }
  return out
}

/// The same, from a component, so choosing a language repaints the screen
/// instead of waiting for the next unrelated render.
export function useT(): typeof t {
  useSyncExternalStore(subscribe, snapshot, snapshot)
  return useCallback(t, [])
}

/// Change it everywhere: the store the rest of the app reads, this table, and
/// the document's own lang attribute, which is what a screen reader uses.
export function changeLocale(code: string | null): void {
  setLocale(code)
  current = primary(getLocale())
  if (typeof document !== 'undefined') document.documentElement.lang = current
  for (const fn of listeners) fn()
}

/// Call once at start-up so the document agrees with the stored choice.
export function applyStoredLocale(): void {
  current = primary(getLocale())
  if (typeof document !== 'undefined') document.documentElement.lang = current
}
