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
  'No code? You get a workspace of your own, and can invite people into it.':
    'コードがなくても大丈夫。自分のワークスペースができ、そこに人を招待できます。',
  'Joining a team? Paste the code you were sent and this signs you into it.':
    'チームに参加しますか？受け取ったコードを貼り付けると、そのチームでサインインします。',
  'Continue without the code': 'コードなしで続ける',
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
  'Where you work': '所属している場所',
  "{name}'s team": '{name}さんのチーム',
  'A team you joined': '参加しているチーム',
  'Join a team': 'チームに参加',
  'Your team': 'あなたのチーム',
  'Who is here, the codes you have out, and one more way in.':
    '誰がいるか、発行済みのコード、そしてもう一人招く方法。',
  'Who is here': 'メンバー',
  'Codes you have out': '発行中のコード',
  'Could not read your team.': 'チームを読み込めませんでした。',
  'That did not work.': 'うまくいきませんでした。',
  'One moment…': '少々お待ちください…',
  Remove: '外す',
  Leave: '抜ける',
  Keep: 'やめる',
  // Not "Cancel": that key is already the one on a dismiss button, and this
  // is a code being killed. The English key is the string, so two meanings
  // cannot share one word.
  Revoke: '無効化',
  you: 'あなた',
  yours: 'あなたの発行',
  'from {name}': '{name}さんの発行',
  "This workspace's members come from a GitHub repository. Change who can push to it there.":
    'このワークスペースのメンバーはGitHubリポジトリから来ています。変更はGitHub側で行ってください。',
  'Everyone here gets their own AI': '全員が自分のAIを持ちます',
  'A decision reaches them wherever they read, in their own language.':
    '決定は、その人が読む場所に、その人の言語で届きます。',
  'Not in this workspace': 'このワークスペースでは使えません',
  'Forward anything here': 'ここに転送してください',
  'Mail sent here becomes a card, triaged the way your inbox is.':
    'ここに届いたメールは、受信箱と同じように仕分けられてカードになります。',
  Off: 'オフ',
  'This workspace is not backed by a GitHub repository, so there is nowhere to open an issue.':
    'このワークスペースはGitHubリポジトリに紐づいていないため、Issueを立てる先がありません。',
  'Decisions sync as your GitHub account. Sign in with GitHub to turn this on.':
    '決定はあなたのGitHubアカウントとして同期されます。有効にするにはGitHubでサインインしてください。',
  'Paste a code somebody sent you.': '誰かから受け取ったコードを貼り付けてください。',
  Join: '参加',
  'That invite code is not valid.': 'その招待コードは使えません。',
  'Everything already settled.': '決着したものすべて。',
  'The record': '記録',
  'Every decision, by business, written by nobody.': 'すべての決定を、事業ごとに、自動で。',
  'Gmail, Slack, Notion, GitHub.': 'Gmail、Slack、Notion、GitHub。',
  'Google Calendar': 'Google カレンダー',
  'Google Drive': 'Google ドライブ',
  'Meetings still waiting on an answer from you.': 'あなたの返事を待っている予定。',
  'Documents someone put in front of you.': '誰かがあなたに共有した資料。',
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
  'Not for sale yet': 'まだ販売していません',

  // Sign-in, in full
  'Create account': 'アカウント作成',
  'Sign in': 'サインイン',
  'Your AI needs an address.': 'AIにあなたの連絡先を。',
  'Welcome back.': 'おかえりなさい。',
  'Email and password.': 'メールアドレスとパスワードで。',
  'signin.code.lede': '6桁のコードをお送りします。覚えるものはなく、決定がどこに届くべきかの証明にもなります。',
  '(optional)': '（任意）',
  'Email me a code instead': 'コードをメールで受け取る',
  'Use a password instead': 'パスワードを使う',
  'Create an account': 'アカウントを作る',
  'This workspace cannot send email yet — use a password for now.': 'このワークスペースはまだメールを送れません。今はパスワードを使ってください。',
  'We could not send a code.': 'コードを送信できませんでした。',
  'Something went wrong.': '問題が発生しました。',
  'That code is not valid.': 'そのコードは無効です。',
  'We could not send another code.': 'コードを再送できませんでした。',
  'Sent. Check your email again.': '送信しました。もう一度メールを確認してください。',
  'We sent six digits to': '6桁のコードを送りました：',
  '. It is good for ten minutes, once.': '。有効期限は10分、一度だけ使えます。',
  'Digit {n}': '{n}桁目',
  'Checking…': '確認中…',
  'Send another code in {n}s': '{n}秒後に再送できます',
  'Your AI routes by role. This is the only thing it cannot guess on day one.': 'AIは役割で振り分けます。初日に推測できない唯一のことです。',

  // The feed, opening and undoing
  'Opening your feed…': 'フィードを開いています…',
  'Asking your AI what is waiting on you.': 'あなたを待っているものをAIに確認しています。',
  '{n} waiting to send': '送信待ち {n}件',
  Undo: '元に戻す',
  Urgent: '至急',
  'Recommended:': 'おすすめ:',
  approve: '承認',
  decline: '却下',
  revise: '修正依頼',
  'View original': '元のメッセージを見る',
  'View original in {app}': '{app}で元のメッセージを見る',
  'Decision needed': '判断が必要です',
  'A decision is waiting': '決定があなたを待っています',
  'a teammate': 'チームメイト',
  'New decision for you': '新しい決定が届きました',
  'From {name}': '{name}から',

  // History
  'Nothing settled yet.': 'まだ決着したものはありません。',
  'GitHub issue #{n}': 'GitHub Issue #{n}',

  // You
  'delete.body': 'アカウントとあなたのカードが削除されます。他の人が下した決定はその人の記録に残ります。それはその人のものだからです。',

  // Plans
  'Could not load plans.': 'プランを読み込めませんでした。',
  'Free gives you {n} AI-routed decisions a day': '無料プランでは1日{n}件までAIが振り分けます',
  '{n} left today': '今日はあと{n}件',
  'Paid removes the limit and turns on everything the AI does in the background.': '有料プランでは上限がなくなり、AIが裏側で行うすべてが有効になります。',
  '/user/mo': '/人/月',
  '/mo': '/月',
  'Billed yearly · ${n}': '年払い · ${n}',
  'Subscriptions are bought in the iOS app, through the App Store.': 'サブスクリプションはiOSアプリからApp Store経由で購入できます。',
  'Start {n}-day free trial': '{n}日間の無料トライアルを始める',
  'Billing is not switched on yet': '課金はまだ有効になっていません',
  'plans.trial': '{days}日間無料、その後は月${price}。いつでも解約できます。',
  'plans.trial.seat': '{days}日間無料、その後は1人あたり月${price}。いつでも解約できます。',
  'plans.notForSale': 'この環境ではまだ何も販売していません。その間、全員が1日{n}件までAIの振り分けを使えます。',

  // The record
  'record.hint': '事業ごとの決定を、今の状態のまま。誰も書いていません。起きたことそのものです。',
  'Copy the record': '記録をコピー',

  // Notifications
  'On iPhone: tap Share → Add to Home Screen, then open Honmaru from there to get notified.': 'iPhoneでは、共有 → ホーム画面に追加 のあと、ホーム画面からHonmaruを開くと通知を受け取れます。',
  'Notifications are blocked for this site. Allow them in your browser settings.': 'このサイトの通知はブロックされています。ブラウザの設定で許可してください。',
  'You will be told when a decision is waiting — even with this tab closed.': 'このタブを閉じていても、決定が待っているときにお知らせします。',
  'Your browser refused. Allow notifications for this site, then try again.': 'ブラウザが拒否しました。このサイトの通知を許可してからもう一度お試しください。',

  // Aliases
  'Also called': '呼び名',
  'Names your AI should recognise as you — a first name, a nickname, in any language.': 'AIがあなただと認識すべき名前。下の名前、あだ名、どの言語でも。',
  'e.g. 美香, Mika': '例：美香, Mika',

  // Ask anything
  'Your AI is looking…': 'AIが調べています…',
  'Your AI has no model to answer with on this deployment.': 'この環境のAIには、答えるためのモデルが設定されていません。',
  "You have used today's AI answers.": '今日のAIへの質問回数を使い切りました。',
  'Your AI could not answer that just now.': 'AIは今それに答えられませんでした。',

  // The reply draft
  'Draft the reply': '返信を下書き',
  'The draft': '下書き',
  'Send via {app}': '{app}で送る',
  'Sending…': '送信中…',
  'Sent via {app}.': '{app}で送りました。',
  'Could not send.': '送れませんでした。',
  'Your AI is writing…': 'AIが書いています…',
  'Your AI has no model to draft with on this deployment.': 'この環境のAIには、下書きするためのモデルが設定されていません。',
  'Your AI could not draft that just now.': 'AIは今それを下書きできませんでした。',
  'A draft, in the language the request came in. Read it, change it, send it yourself.': '依頼が来た言語での下書きです。読んで、直して、自分で送ってください。',

  // The feedback loop
  'Is this card wrong?': 'このカード、違う？',
  'What is wrong with it?': '何が違いますか？',
  'Wrong person': '相手が違う',
  'Not a decision': '決定ではない',
  'Wrong priority': '優先度が違う',
  'Badly written': '文面が悪い',
  'Never mind': 'やっぱりいい',
  'Noted. Your AI will do better.': '記録しました。AIが次に活かします。',
  Insights: 'インサイト',
  'How long decisions wait, what gets declined, what your AI got wrong.': '決定の待ち時間、却下されたもの、AIが間違えたもの。',
  'Could not load the numbers.': '数字を読み込めませんでした。',
  Window: '期間',
  '{n} days': '{n}日間',
  cards: 'カード',
  'median wait': '待ち時間の中央値',
  declined: '却下率',
  '{n}m': '{n}分',
  '{n}h': '{n}時間',
  '{n}d': '{n}日',
  'Cards per day': '1日あたりのカード',
  'Cards created per day over the last {n} days': '過去{n}日間の1日あたりのカード数',
  'Right now': 'いま',
  'Waiting on someone': '誰かを待っている',
  'Decided in this window': 'この期間に決まった',
  Nudged: 'リマインドした',
  'A decision that had to be asked about twice.': '二度聞かなければならなかった決定。',
  'Notes to yourself': '自分宛のメモ',
  'Cards you routed to yourself.': '自分に振り分けたカード。',
  'Where cards come from': 'カードの出どころ',
  'What was decided': '決まったこと',
  'What your AI got wrong': 'AIが間違えたもの',
  'Nobody has flagged a card in this window. "Is this card wrong?" sits under every card.': 'この期間に報告されたカードはありません。各カードの下に「このカード、違う？」があります。',
  Other: 'その他',

  // When it breaks
  'crash.body': 'この画面を表示できませんでした。再読み込みすれば、あなたの決定はそのまま残っています。',
  Details: '詳細',
  Reload: '再読み込み',

  // The workbench and the thread
  'Inbox': '受信箱',
  'Search decisions': '決定を検索',
  'What happened': '経緯',
  'What happened to this card': 'このカードの経緯',
  'Nothing has happened to this card yet.': 'このカードにはまだ何も起きていません。',
  'Could not load what happened.': '経緯を読み込めませんでした。',
  'Created': '作成',
  'Updated': '更新',
  'Deleted': '削除',
  'Undone': '取り消し',
  'Asked your AI': 'AIに質問',
  'Reply drafted': '返信を下書き',
  'Reply sent': '返信を送信',
  'Filed': '分類',
  // ⌘K
  'Search or jump to': '検索・移動',
  'Search decisions, or type where to go…': '決定を検索、または行き先を入力…',
  'Go to': '移動',
  'Decided before': '以前の決定',
  'Plans': 'プラン',
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
  'signin.code.lede':
    'We send a six-digit code. Nothing to remember, and it proves where your decisions should reach you.',
  'delete.body':
    'This removes your account and your cards. Decisions other people made stay in their record — those are theirs, not yours.',
  'plans.trial': 'Free for {days} days, then ${price} a month. Cancel any time.',
  'plans.trial.seat': 'Free for {days} days, then ${price} per person a month. Cancel any time.',
  'plans.notForSale':
    'Nothing is for sale on this deployment yet. Everyone gets {n} AI-routed decisions a day in the meantime.',
  'record.hint': 'Every decision, per business, as it stands now. Nobody writes this; it is what happened.',
  'crash.body':
    'This screen could not be drawn. Reloading is safe — your decisions are on the relay, not in this tab.',
}

const es: Dict = {
  // Getting in
  'Get started': 'Empezar',
  'I already have an account': 'Ya tengo una cuenta',
  'One feed': 'Un solo feed',
  'Everything waiting on you, most urgent first.': 'Todo lo que te espera, lo más urgente primero.',
  'Ten businesses, ten people': 'Diez negocios, diez personas',
  'Every decision filed under the right one, in the background.': 'Cada decisión archivada donde toca, sin que lo veas.',
  'In your language': 'En tu idioma',
  'The decision is': 'La decisión',
  'already waiting.': 'ya te está esperando.',
  'welcome.lede':
    'Hablas solo con tu IA. Ella deduce quién decide qué, y la IA de esa persona le presenta una tarjeta que se resuelve con un gesto. Sin canales. Sin bandeja de entrada. Sin "¿viste mi mensaje?".',
  'Notifications arrive written in the language you read.': 'Las notificaciones llegan escritas en el idioma que lees.',
  'Sign in with email': 'Entrar con email',
  'Sign in with GitHub': 'Entrar con GitHub',
  Email: 'Email',
  Password: 'Contraseña',
  'At least 8 characters': 'Mínimo 8 caracteres',
  'you@company.com': 'tu@empresa.com',
  'Your name': 'Tu nombre',
  'What your team calls you': 'Como te llama tu equipo',
  'Invite code': 'Código de invitación',
  'Paste one to join a team': 'Pega uno para unirte a un equipo',
  'No code? You get a workspace of your own, and can invite people into it.':
    '¿Sin código? Tendrás un espacio propio y podrás invitar a otros.',
  'Joining a team? Paste the code you were sent and this signs you into it.':
    '¿Te unes a un equipo? Pega el código que te enviaron y entrarás directamente.',
  'Continue without the code': 'Continuar sin código',
  'Email me a code': 'Enviarme un código',
  'Check your email': 'Revisa tu correo',
  'Enter the code.': 'Introduce el código.',
  Continue: 'Continuar',
  'Send another code': 'Enviar otro código',
  Back: 'Atrás',
  Cancel: 'Cancelar',
  Skip: 'Omitir',
  'Sign out': 'Cerrar sesión',

  // Onboarding
  'Two questions': 'Dos preguntas',
  'What do you mostly decide?': '¿Qué decides principalmente?',
  'Where it goes': 'Dónde llega',
  Language: 'Idioma',
  'ob.tell.title': 'Habla con tu IA. No con un canal.',
  'ob.tell.body':
    '«Pídele a Kenji que apruebe el nuevo precio del proveedor.» Esa es toda la interacción. No hay dónde publicarlo, nadie a quien mencionar, ni canal que elegir.',
  'ob.route.title': 'Averigua quién decide.',
  'ob.route.body':
    'Tu IA lee a tu equipo —roles, responsabilidades, quién está saturado— y se lo pasa a la IA de la persona correcta, que lo reescribe como una tarjeta pensada para su decisión, no para tu frase.',
  'ob.swipe.title': 'Resuélvela con un gesto.',
  'ob.swipe.body':
    'Aprueba, rechaza, pide una revisión o pásasela a otra persona. La respuesta vuelve directa a quien preguntó —y a GitHub, si es donde corresponde.',
  'routes to whoever decides': 'llega a quien decide',
  'Approved. Kenji’s AI already knows.': 'Aprobado. La IA de Kenji ya lo sabe.',
  'Declined. Kenji’s AI already knows.': 'Rechazado. La IA de Kenji ya lo sabe.',

  // Feed
  waiting: 'pendientes',
  decided: 'decididas',
  businesses: 'negocios',
  'save 20%': 'ahorra un 20%',
  Annual: 'Anual',
  Monthly: 'Mensual',
  'Tell your AI': 'Dile a tu IA',
  'compose.hint':
    'Para quién es, qué decide y para cuándo. Tu IA escribe la tarjeta y la encamina.',
  'Ask anything...': 'Pregunta lo que sea...',
  'Nothing is waiting on you.': 'Nada te está esperando.',
  'Nothing sent yet. Tell your AI something.': 'Nada enviado aún. Dile algo a tu IA.',
  'No decisions yet.': 'Aún no hay decisiones.',
  'Nothing decided yet.': 'Nada decidido aún.',
  'Nothing yet.': 'Nada todavía.',
  'You have not sent anything yet.': 'Todavía no has enviado nada.',
  'Requested By': 'Solicitado por',
  'Reply with a note': 'Responder con una nota',
  'Ask your AI about this decision': 'Pregunta a tu IA sobre esta decisión',
  'Waiting on you': 'Esperándote a ti',
  'Waiting on {name}': 'Esperando a {name}',
  'Sent by you': 'Enviado por ti',
  'You decided': 'Tú decidiste',
  'You asked': 'Tú lo pediste',
  'just now': 'ahora mismo',
  '{n}m ago': 'hace {n} min',
  '{n}h ago': 'hace {n} h',
  '{n}d ago': 'hace {n} d',

  // You
  'How your AI treats you': 'Cómo te trata tu IA',
  'What gets routed to you first.': 'Qué te llega primero.',
  'Every notification arrives written in it.': 'Cada notificación llega escrita en él.',
  'Your workspace': 'Tu espacio de trabajo',
  'Where you work': 'Dónde trabajas',
  'A team you joined': 'Un equipo al que te uniste',
  'Join a team': 'Unirse a un equipo',
  'Your team': 'Tu equipo',
  'Who is here, the codes you have out, and one more way in.':
    'Quién está aquí, los códigos que compartiste y otra forma de entrar.',
  'Who is here': 'Quién está aquí',
  'Codes you have out': 'Códigos que has compartido',
  'Could not read your team.': 'No se pudo leer tu equipo.',
  'That did not work.': 'No funcionó.',
  'One moment…': 'Un momento…',
  'from {name}': 'de {name}',
  'Everyone here gets their own AI': 'Cada persona aquí tiene su propia IA',
  'A decision reaches them wherever they read, in their own language.':
    'Las decisiones les llegan donde sea que lean, en su propio idioma.',
  'Not in this workspace': 'No está en este espacio',
  'Forward anything here': 'Reenvía cualquier cosa aquí',
  'Mail sent here becomes a card, triaged the way your inbox is.':
    'El correo que llega aquí se convierte en tarjeta, clasificada como tu bandeja.',
  'This workspace is not backed by a GitHub repository, so there is nowhere to open an issue.':
    'Este espacio no está vinculado a un repositorio de GitHub, así que no hay dónde abrir un issue.',
  'Decisions sync as your GitHub account. Sign in with GitHub to turn this on.':
    'Las decisiones se sincronizan con tu cuenta de GitHub. Entra con GitHub para activarlo.',
  'Paste a code somebody sent you.': 'Pega un código que te hayan enviado.',
  'That invite code is not valid.': 'Ese código de invitación no es válido.',
  'Everything already settled.': 'Todo ya está resuelto.',
  'The record': 'El registro',
  'Every decision, by business, written by nobody.':
    'Cada decisión, por negocio, sin que nadie la escriba.',
  'Gmail, Slack, Notion, GitHub.': 'Gmail, Slack, Notion, GitHub.',
  'Google Calendar': 'Google Calendar',
  'Google Drive': 'Google Drive',
  'Meetings still waiting on an answer from you.': 'Reuniones que aún esperan tu respuesta.',
  'Documents someone put in front of you.': 'Documentos que alguien te presentó.',
  'Where a decision reaches you.': 'Dónde te llega una decisión.',
  'Invite a teammate': 'Invitar a alguien del equipo',
  'Their role': 'Su rol',
  'What their AI puts in front of them first.': 'Qué les presenta su IA primero.',
  'Anyone who signs up with this code joins your workspace as {role}.':
    'Quien se registre con este código entra a tu espacio como {role}.',
  'Create another': 'Crear otro',
  'They get their own AI, in this workspace.': 'Tienen su propia IA, en este espacio.',
  'What you are on, and what else there is.': 'En qué plan estás y qué más hay.',
  'Delete account': 'Eliminar cuenta',
  'Keep it': 'Conservarla',
  'Businesses your AI has found': 'Negocios que tu IA ha encontrado',
  'notify.language':
    'Sea cual sea el canal, las palabras llegan en tu idioma —no en el de quien inició la decisión.',
  'history.blurb':
    'Las decisiones aparecen aquí en el momento en que se toman —las tuyas y las que pediste.',
  'businesses.blurb': 'Nadie creó esta lista. Crece a medida que se archivan decisiones.',
  'On iPhone, add this to your home screen first — Safari only allows notifications for an installed web app.':
    'En iPhone, añade esto primero a tu pantalla de inicio: Safari solo permite notificaciones en una web app instalada.',
  'Blocked in your browser settings — allow notifications for this site to turn it on.':
    'Bloqueado en los ajustes del navegador: permite las notificaciones de este sitio para activarlo.',
  'A decision that needs you arrives even when this tab is closed.':
    'Una decisión que te necesita llega aunque esta pestaña esté cerrada.',
  'Email as the fallback': 'El email como respaldo',
  'Changing this changes nothing else — it is only where mail lands.':
    'Cambiar esto no cambia nada más: es solo dónde llega el correo.',
  'This is the address you sign in with, so it cannot be changed here.':
    'Es la dirección con la que entras, así que no se puede cambiar aquí.',
  'On this device': 'En este dispositivo',
  'By email': 'Por email',
  'Email fallback': 'Respaldo por email',
  'Push notifications': 'Notificaciones push',
  'Turn on notifications': 'Activar notificaciones',
  'Always on': 'Siempre activadas',
  'All clear': 'Todo despejado',
  'Nothing is waiting on you. Your AI will tell you when something is.':
    'Nada te espera. Tu IA te avisará cuando haya algo.',
  'Only when no device of yours can be reached. Never a duplicate.':
    'Solo cuando ningún dispositivo tuyo responde. Nunca un duplicado.',
  'Every notification reaches you in this language, whoever wrote it.':
    'Cada notificación te llega en este idioma, la haya escrito quien la haya escrito.',
  'You are on Pro. Unlimited routing, every business, the full record.':
    'Estás en Pro. Enrutado ilimitado, todos los negocios, el registro completo.',
  'Decision · high': 'Decisión · alta',
  'Supplier price +8%': 'Precio del proveedor +8%',
  'Kenji needs an answer today to hold this month’s slot.':
    'Kenji necesita una respuesta hoy para conservar el hueco de este mes.',
  'Decision:': 'Decisión:',
  'Revision:': 'Revisión:',
  'Routing…': 'Encaminando…',
  'Saving…': 'Guardando…',
  'Creating…': 'Creando…',
  Copy: 'Copiar',
  Copied: 'Copiado',
  'Copied!': '¡Copiado!',
  'Copy as Markdown': 'Copiar como Markdown',
  'Create invite code': 'Crear código de invitación',
  Next: 'Siguiente',
  'Set me up': 'Configurar',
  'Open my feed': 'Abrir mi feed',
  'Reconnecting…': 'Reconectando…',
  Decisions: 'Decisiones',
  'Not yet filed': 'Aún sin archivar',
  'Approved.': 'Aprobado.',
  'Declined.': 'Rechazado.',
  'Revision asked': 'Revisión pedida',
  Chose: 'Eligió',
  Replied: 'Respondió',
  Acknowledged: 'Confirmado',
  Delegated: 'Delegado',
  Deferred: 'Aplazado',
  'Founder / operator': 'Fundador / operador',
  'You decide most things, and want the rest to stop reaching you.':
    'Decides casi todo y quieres que el resto deje de llegarte.',
  'Ops / business': 'Operaciones / negocio',
  'Suppliers, bookings, money, people.': 'Proveedores, reservas, dinero, personas.',
  Engineer: 'Ingeniería',
  'Anything shipping-related routes to you.': 'Todo lo relacionado con lanzamientos te llega a ti.',
  Designer: 'Diseño',
  'Anything about how it looks or reads.': 'Todo lo relacionado con cómo se ve o se lee.',
  'Something else': 'Otra cosa',
  Member: 'Miembro',
  Admin: 'Admin',
  Maintainer: 'Mantenedor',
  Triager: 'Clasificador',
  'Your AI works it out from what people send you.':
    'Tu IA lo deduce a partir de lo que la gente te envía.',
  'Could not read your profile.': 'No se pudo leer tu perfil.',
  'Could not read your settings.': 'No se pudieron leer tus ajustes.',
  'That did not save.': 'No se guardó.',
  'Could not create invite.': 'No se pudo crear la invitación.',
  'Your AI could not route that.': 'Tu IA no pudo encaminar eso.',
  'Routing failed': 'Falló el enrutado',
  'This browser cannot receive push notifications here.':
    'Este navegador no puede recibir notificaciones push aquí.',
  'This browser cannot receive them.': 'Este navegador no puede recibirlas.',
  'Could not turn notifications on. Try again in a moment.':
    'No se pudieron activar las notificaciones. Inténtalo en un momento.',
  'That did not work. Try again in a moment.': 'No funcionó. Inténtalo en un momento.',
  'We could not save that.': 'No pudimos guardarlo.',

  // Tools
  'tools.lede':
    'Las herramientas conectadas alimentan a tu IA. No meten canales aquí: lo que vuelve son decisiones, en el mismo feed que todo lo demás.',
  'Pull now': 'Traer ahora',
  'Pulling…': 'Trayendo…',
  'Mail that needs a decision becomes a card. Nothing else does.':
    'El correo que necesita una decisión se convierte en tarjeta. Nada más lo hace.',
  'Messages addressed to you, triaged into decisions — without you opening Slack.':
    'Mensajes dirigidos a ti, clasificados en decisiones —sin que abras Slack.',
  'Decisions are written back to the database you point at.':
    'Las decisiones se escriben en la base de datos que indiques.',
  'Approvals, tasks and assignee changes sync to Issues and Pull Requests.':
    'Aprobaciones, tareas y cambios de asignación se sincronizan con Issues y Pull Requests.',
  'Feeds decisions into your feed.': 'Alimenta tu feed con decisiones.',
  'Connectors are not switched on for this workspace yet.':
    'Los conectores aún no están activados en este espacio.',
  'Could not load your tools.': 'No se pudieron cargar tus herramientas.',
  'Could not start that connection.': 'No se pudo iniciar esa conexión.',
  'Finish in the tab that opened, then come back and pull.':
    'Termina en la pestaña que se abrió, vuelve y trae los datos.',
  'Nothing could be pulled just now.': 'Ahora mismo no se pudo traer nada.',
  '{n} new in your feed.': '{n} nuevas en tu feed.',
  'Nothing new needed you.': 'Nada nuevo te necesitaba.',
  'Built in': 'Integrado',
  'No connectors are available on this deployment.':
    'No hay conectores disponibles en este despliegue.',
  'Event log': 'Registro de eventos',

  // Plan
  'Choose your plan': 'Elige tu plan',
  'Loading…': 'Cargando…',
  'Billing period': 'Periodo de facturación',
  'Not for sale yet': 'Aún no está a la venta',

  // Chrome
  Done: 'Hecho',
  Feed: 'Feed',
  History: 'Historial',
  Tools: 'Herramientas',
  You: 'Tú',
  Cards: 'Tarjetas',
  Priority: 'Prioridad',
  Notification: 'Notificación',
  Task: 'Tarea',
  Delegation: 'Delegación',
  Revision: 'Revisión',
  admin: 'admin',
  member: 'miembro',
  founder: 'fundador',
  operator: 'operador',
  engineer: 'ingeniero',
  designer: 'diseñador',
  triager: 'clasificador',
  maintainer: 'mantenedor',
  Classic: 'Clásico',
  Approve: 'Aprobar',
  Decline: 'Rechazar',
  Nudge: 'Recordar',
  View: 'Ver',
  Send: 'Enviar',
  Low: 'Baja',
  Medium: 'Media',
  High: 'Alta',
  Approved: 'Aprobado',
  Declined: 'Rechazado',
  Waiting: 'En espera',
  Decided: 'Decidido',
  Everything: 'Todo',
  Today: 'Hoy',
  Yesterday: 'Ayer',
  Role: 'Rol',
  Remove: 'Eliminar',
  Leave: 'Salir',
  Keep: 'Conservar',
  Revoke: 'Revocar',
  you: 'tú',
  yours: 'tuyo',
  Off: 'Apagado',
  Join: 'Unirse',
  Notifications: 'Notificaciones',
  Plan: 'Plan',
  Delete: 'Eliminar',
  Waiting_stat: 'En espera',
  Businesses: 'Negocios',
  Connected: 'Conectado',
  Connect: 'Conectar',
  Free: 'Gratis',
  Close: 'Cerrar',
  Filter: 'Filtrar',
  Main: 'Principal',
}

const fr: Dict = {
  // Getting in
  'Get started': 'Commencer',
  'I already have an account': 'J’ai déjà un compte',
  'One feed': 'Un seul fil',
  'Everything waiting on you, most urgent first.':
    'Tout ce qui vous attend, le plus urgent d’abord.',
  'Ten businesses, ten people': 'Dix activités, dix personnes',
  'Every decision filed under the right one, in the background.':
    'Chaque décision rangée au bon endroit, en arrière-plan.',
  'In your language': 'Dans votre langue',
  'The decision is': 'La décision',
  'already waiting.': 'vous attend déjà.',
  'welcome.lede':
    'Vous ne parlez qu’à votre IA. Elle détermine qui doit décider quoi, et l’IA de cette personne lui présente une carte qui se règle d’un geste. Pas de canaux. Pas de boîte de réception. Pas de « vous avez vu mon message ? ».',
  'Notifications arrive written in the language you read.':
    'Les notifications arrivent écrites dans la langue que vous lisez.',
  'Sign in with email': 'Se connecter par e-mail',
  'Sign in with GitHub': 'Se connecter avec GitHub',
  Email: 'E-mail',
  Password: 'Mot de passe',
  'At least 8 characters': '8 caractères minimum',
  'you@company.com': 'vous@entreprise.com',
  'Your name': 'Votre nom',
  'What your team calls you': 'Comment votre équipe vous appelle',
  'Invite code': 'Code d’invitation',
  'Paste one to join a team': 'Collez-en un pour rejoindre une équipe',
  'No code? You get a workspace of your own, and can invite people into it.':
    'Pas de code ? Vous obtenez un espace à vous et pouvez y inviter d’autres personnes.',
  'Joining a team? Paste the code you were sent and this signs you into it.':
    'Vous rejoignez une équipe ? Collez le code reçu et vous serez connecté directement.',
  'Continue without the code': 'Continuer sans le code',
  'Email me a code': 'M’envoyer un code',
  'Check your email': 'Vérifiez vos e-mails',
  'Enter the code.': 'Saisissez le code.',
  Continue: 'Continuer',
  'Send another code': 'Renvoyer un code',
  Back: 'Retour',
  Cancel: 'Annuler',
  Skip: 'Passer',
  'Sign out': 'Se déconnecter',

  // Onboarding
  'Two questions': 'Deux questions',
  'What do you mostly decide?': 'Que décidez-vous surtout ?',
  'Where it goes': 'Où cela arrive',
  Language: 'Langue',
  'ob.tell.title': 'Parlez à votre IA. Pas à un canal.',
  'ob.tell.body':
    '« Demande à Kenji de valider le nouveau tarif fournisseur. » C’est toute l’interaction. Il n’y a nulle part où la poster, personne à mentionner, aucun canal à choisir.',
  'ob.route.title': 'Elle trouve qui décide.',
  'ob.route.body':
    'Votre IA lit votre équipe — les rôles, les responsabilités, qui est débordé — et la transmet à l’IA de la bonne personne, qui la reformule en carte pensée pour sa décision, pas pour votre phrase.',
  'ob.swipe.title': 'Réglez-la d’un geste.',
  'ob.swipe.body':
    'Approuvez, refusez, demandez une révision ou confiez-la à quelqu’un d’autre. La réponse repart directement vers qui a demandé — et vers GitHub, si c’est là qu’elle doit aller.',
  'routes to whoever decides': 'arrive à qui décide',
  'Approved. Kenji’s AI already knows.': 'Approuvé. L’IA de Kenji le sait déjà.',
  'Declined. Kenji’s AI already knows.': 'Refusé. L’IA de Kenji le sait déjà.',

  // Feed
  waiting: 'en attente',
  decided: 'décidées',
  businesses: 'activités',
  'save 20%': 'économisez 20 %',
  Annual: 'Annuel',
  Monthly: 'Mensuel',
  'Tell your AI': 'Dites à votre IA',
  'compose.hint':
    'Pour qui, quelle décision, et pour quand. Votre IA rédige la carte et l’achemine.',
  'Ask anything...': 'Demandez ce que vous voulez...',
  'Nothing is waiting on you.': 'Rien ne vous attend.',
  'Nothing sent yet. Tell your AI something.': 'Rien d’envoyé. Dites quelque chose à votre IA.',
  'No decisions yet.': 'Pas encore de décisions.',
  'Nothing decided yet.': 'Rien de décidé pour l’instant.',
  'Nothing yet.': 'Rien pour l’instant.',
  'You have not sent anything yet.': 'Vous n’avez encore rien envoyé.',
  'Requested By': 'Demandé par',
  'Reply with a note': 'Répondre avec une note',
  'Ask your AI about this decision': 'Interrogez votre IA sur cette décision',
  'Waiting on you': 'Vous attend',
  'Waiting on {name}': 'En attente de {name}',
  'Sent by you': 'Envoyé par vous',
  'You decided': 'Vous avez décidé',
  'You asked': 'Vous avez demandé',
  'just now': 'à l’instant',
  '{n}m ago': 'il y a {n} min',
  '{n}h ago': 'il y a {n} h',
  '{n}d ago': 'il y a {n} j',

  // You
  'How your AI treats you': 'Comment votre IA vous traite',
  'What gets routed to you first.': 'Ce qui vous parvient en premier.',
  'Every notification arrives written in it.': 'Chaque notification arrive écrite dans cette langue.',
  'Your workspace': 'Votre espace de travail',
  'Where you work': 'Là où vous travaillez',
  'A team you joined': 'Une équipe que vous avez rejointe',
  'Join a team': 'Rejoindre une équipe',
  'Your team': 'Votre équipe',
  'Who is here, the codes you have out, and one more way in.':
    'Qui est là, les codes que vous avez partagés, et une entrée de plus.',
  'Who is here': 'Qui est là',
  'Codes you have out': 'Codes que vous avez partagés',
  'Could not read your team.': 'Impossible de lire votre équipe.',
  'That did not work.': 'Cela n’a pas fonctionné.',
  'One moment…': 'Un instant…',
  'from {name}': 'de {name}',
  'Everyone here gets their own AI': 'Chacun ici a sa propre IA',
  'A decision reaches them wherever they read, in their own language.':
    'Une décision les atteint où qu’ils lisent, dans leur propre langue.',
  'Not in this workspace': 'Pas dans cet espace',
  'Forward anything here': 'Transférez n’importe quoi ici',
  'Mail sent here becomes a card, triaged the way your inbox is.':
    'Le courrier envoyé ici devient une carte, triée comme votre boîte de réception.',
  'This workspace is not backed by a GitHub repository, so there is nowhere to open an issue.':
    'Cet espace n’est pas adossé à un dépôt GitHub : il n’y a donc nulle part où ouvrir un ticket.',
  'Decisions sync as your GitHub account. Sign in with GitHub to turn this on.':
    'Les décisions se synchronisent avec votre compte GitHub. Connectez-vous avec GitHub pour l’activer.',
  'Paste a code somebody sent you.': 'Collez un code qu’on vous a envoyé.',
  'That invite code is not valid.': 'Ce code d’invitation n’est pas valide.',
  'Everything already settled.': 'Tout est déjà réglé.',
  'The record': 'Le registre',
  'Every decision, by business, written by nobody.':
    'Chaque décision, par activité, écrite par personne.',
  'Gmail, Slack, Notion, GitHub.': 'Gmail, Slack, Notion, GitHub.',
  'Google Calendar': 'Google Calendar',
  'Google Drive': 'Google Drive',
  'Meetings still waiting on an answer from you.': 'Réunions qui attendent encore votre réponse.',
  'Documents someone put in front of you.': 'Documents que quelqu’un vous a présentés.',
  'Where a decision reaches you.': 'Là où une décision vous atteint.',
  'Invite a teammate': 'Inviter un coéquipier',
  'Their role': 'Son rôle',
  'What their AI puts in front of them first.': 'Ce que son IA lui présente en premier.',
  'Anyone who signs up with this code joins your workspace as {role}.':
    'Quiconque s’inscrit avec ce code rejoint votre espace en tant que {role}.',
  'Create another': 'En créer un autre',
  'They get their own AI, in this workspace.': 'Ils ont leur propre IA, dans cet espace.',
  'What you are on, and what else there is.': 'Votre offre actuelle, et les autres.',
  'Delete account': 'Supprimer le compte',
  'Keep it': 'Le conserver',
  'Businesses your AI has found': 'Activités que votre IA a trouvées',
  'notify.language':
    'Quel que soit le canal, les mots arrivent dans votre langue — pas dans celle de la personne qui a lancé la décision.',
  'history.blurb':
    'Les décisions apparaissent ici dès qu’elles sont prises — les vôtres et celles que vous avez demandées.',
  'businesses.blurb': 'Personne n’a fait cette liste. Elle grandit au fil des décisions classées.',
  'On iPhone, add this to your home screen first — Safari only allows notifications for an installed web app.':
    'Sur iPhone, ajoutez d’abord ceci à votre écran d’accueil : Safari n’autorise les notifications que pour une web app installée.',
  'Blocked in your browser settings — allow notifications for this site to turn it on.':
    'Bloqué dans les réglages du navigateur : autorisez les notifications de ce site pour l’activer.',
  'A decision that needs you arrives even when this tab is closed.':
    'Une décision qui vous concerne arrive même quand cet onglet est fermé.',
  'Email as the fallback': 'L’e-mail en recours',
  'Changing this changes nothing else — it is only where mail lands.':
    'Changer ceci ne change rien d’autre : c’est seulement là où le courrier arrive.',
  'This is the address you sign in with, so it cannot be changed here.':
    'C’est l’adresse avec laquelle vous vous connectez : elle ne peut pas être changée ici.',
  'On this device': 'Sur cet appareil',
  'By email': 'Par e-mail',
  'Email fallback': 'Recours par e-mail',
  'Push notifications': 'Notifications push',
  'Turn on notifications': 'Activer les notifications',
  'Always on': 'Toujours activées',
  'All clear': 'Tout est réglé',
  'Nothing is waiting on you. Your AI will tell you when something is.':
    'Rien ne vous attend. Votre IA vous préviendra quand il y aura quelque chose.',
  'Only when no device of yours can be reached. Never a duplicate.':
    'Seulement quand aucun de vos appareils n’est joignable. Jamais en double.',
  'Every notification reaches you in this language, whoever wrote it.':
    'Chaque notification vous parvient dans cette langue, qui que ce soit qui l’ait écrite.',
  'You are on Pro. Unlimited routing, every business, the full record.':
    'Vous êtes en Pro. Acheminement illimité, toutes les activités, le registre complet.',
  'Decision · high': 'Décision · haute',
  'Supplier price +8%': 'Tarif fournisseur +8 %',
  'Kenji needs an answer today to hold this month’s slot.':
    'Kenji a besoin d’une réponse aujourd’hui pour garder le créneau de ce mois.',
  'Decision:': 'Décision :',
  'Revision:': 'Révision :',
  'Routing…': 'Acheminement…',
  'Saving…': 'Enregistrement…',
  'Creating…': 'Création…',
  Copy: 'Copier',
  Copied: 'Copié',
  'Copied!': 'Copié !',
  'Copy as Markdown': 'Copier en Markdown',
  'Create invite code': 'Créer un code d’invitation',
  Next: 'Suivant',
  'Set me up': 'Me configurer',
  'Open my feed': 'Ouvrir mon fil',
  'Reconnecting…': 'Reconnexion…',
  Decisions: 'Décisions',
  'Not yet filed': 'Pas encore classé',
  'Approved.': 'Approuvé.',
  'Declined.': 'Refusé.',
  'Revision asked': 'Révision demandée',
  Chose: 'A choisi',
  Replied: 'A répondu',
  Acknowledged: 'Pris en compte',
  Delegated: 'Délégué',
  Deferred: 'Reporté',
  'Founder / operator': 'Fondateur / dirigeant',
  'You decide most things, and want the rest to stop reaching you.':
    'Vous décidez de presque tout et voulez que le reste cesse de vous parvenir.',
  'Ops / business': 'Ops / métier',
  'Suppliers, bookings, money, people.': 'Fournisseurs, réservations, argent, personnes.',
  Engineer: 'Ingénierie',
  'Anything shipping-related routes to you.': 'Tout ce qui concerne les livraisons vous revient.',
  Designer: 'Design',
  'Anything about how it looks or reads.': 'Tout ce qui concerne l’aspect ou le texte.',
  'Something else': 'Autre chose',
  Member: 'Membre',
  Admin: 'Admin',
  Maintainer: 'Mainteneur',
  Triager: 'Trieur',
  'Your AI works it out from what people send you.':
    'Votre IA le déduit de ce que les gens vous envoient.',
  'Could not read your profile.': 'Impossible de lire votre profil.',
  'Could not read your settings.': 'Impossible de lire vos réglages.',
  'That did not save.': 'Cela n’a pas été enregistré.',
  'Could not create invite.': 'Impossible de créer l’invitation.',
  'Your AI could not route that.': 'Votre IA n’a pas pu l’acheminer.',
  'Routing failed': 'L’acheminement a échoué',
  'This browser cannot receive push notifications here.':
    'Ce navigateur ne peut pas recevoir de notifications push ici.',
  'This browser cannot receive them.': 'Ce navigateur ne peut pas les recevoir.',
  'Could not turn notifications on. Try again in a moment.':
    'Impossible d’activer les notifications. Réessayez dans un instant.',
  'That did not work. Try again in a moment.': 'Cela n’a pas marché. Réessayez dans un instant.',
  'We could not save that.': 'Nous n’avons pas pu l’enregistrer.',

  // Tools
  'tools.lede':
    'Les outils connectés nourrissent votre IA. Ils n’ajoutent pas de canaux ici : ce qui revient, ce sont des décisions, dans le même fil que tout le reste.',
  'Pull now': 'Récupérer',
  'Pulling…': 'Récupération…',
  'Mail that needs a decision becomes a card. Nothing else does.':
    'Le courrier qui demande une décision devient une carte. Rien d’autre.',
  'Messages addressed to you, triaged into decisions — without you opening Slack.':
    'Les messages qui vous sont adressés, triés en décisions — sans ouvrir Slack.',
  'Decisions are written back to the database you point at.':
    'Les décisions sont écrites dans la base que vous indiquez.',
  'Approvals, tasks and assignee changes sync to Issues and Pull Requests.':
    'Approbations, tâches et changements d’assignation se synchronisent avec les Issues et Pull Requests.',
  'Feeds decisions into your feed.': 'Alimente votre fil en décisions.',
  'Connectors are not switched on for this workspace yet.':
    'Les connecteurs ne sont pas encore activés pour cet espace.',
  'Could not load your tools.': 'Impossible de charger vos outils.',
  'Could not start that connection.': 'Impossible de démarrer cette connexion.',
  'Finish in the tab that opened, then come back and pull.':
    'Terminez dans l’onglet ouvert, revenez puis récupérez.',
  'Nothing could be pulled just now.': 'Rien n’a pu être récupéré pour l’instant.',
  '{n} new in your feed.': '{n} nouvelles dans votre fil.',
  'Nothing new needed you.': 'Rien de nouveau n’avait besoin de vous.',
  'Built in': 'Intégré',
  'No connectors are available on this deployment.':
    'Aucun connecteur n’est disponible sur ce déploiement.',
  'Event log': 'Journal d’événements',

  // Plan
  'Choose your plan': 'Choisissez votre offre',
  'Loading…': 'Chargement…',
  'Billing period': 'Période de facturation',
  'Not for sale yet': 'Pas encore en vente',

  // Chrome
  Done: 'Terminé',
  Feed: 'Fil',
  History: 'Historique',
  Tools: 'Outils',
  You: 'Vous',
  Cards: 'Cartes',
  Priority: 'Priorité',
  Notification: 'Notification',
  Task: 'Tâche',
  Delegation: 'Délégation',
  Revision: 'Révision',
  admin: 'admin',
  member: 'membre',
  founder: 'fondateur',
  operator: 'dirigeant',
  engineer: 'ingénieur',
  designer: 'designer',
  triager: 'trieur',
  maintainer: 'mainteneur',
  Classic: 'Classique',
  Approve: 'Approuver',
  Decline: 'Refuser',
  Nudge: 'Relancer',
  View: 'Voir',
  Send: 'Envoyer',
  Low: 'Basse',
  Medium: 'Moyenne',
  High: 'Haute',
  Approved: 'Approuvé',
  Declined: 'Refusé',
  Waiting: 'En attente',
  Decided: 'Décidé',
  Everything: 'Tout',
  Today: 'Aujourd’hui',
  Yesterday: 'Hier',
  Role: 'Rôle',
  Remove: 'Retirer',
  Leave: 'Quitter',
  Keep: 'Conserver',
  Revoke: 'Révoquer',
  you: 'vous',
  yours: 'à vous',
  Off: 'Désactivé',
  Join: 'Rejoindre',
  Notifications: 'Notifications',
  Plan: 'Offre',
  Delete: 'Supprimer',
  Waiting_stat: 'En attente',
  Businesses: 'Activités',
  Connected: 'Connecté',
  Connect: 'Connecter',
  Free: 'Gratuit',
  Close: 'Fermer',
  Filter: 'Filtrer',
  Main: 'Principal',
}

const de: Dict = {
  // Getting in
  'Get started': 'Loslegen',
  'I already have an account': 'Ich habe schon ein Konto',
  'One feed': 'Ein Feed',
  'Everything waiting on you, most urgent first.':
    'Alles, was auf dich wartet, das Dringendste zuerst.',
  'Ten businesses, ten people': 'Zehn Bereiche, zehn Personen',
  'Every decision filed under the right one, in the background.':
    'Jede Entscheidung landet im Hintergrund beim richtigen Bereich.',
  'In your language': 'In deiner Sprache',
  'The decision is': 'Die Entscheidung',
  'already waiting.': 'wartet bereits.',
  'welcome.lede':
    'Du sprichst nur mit deiner KI. Sie findet heraus, wer was entscheiden muss, und deren KI legt der Person eine Karte vor, die sich mit einem Wischen erledigen lässt. Keine Kanäle. Kein Posteingang. Kein „Hast du meine Nachricht gesehen?“.',
  'Notifications arrive written in the language you read.':
    'Benachrichtigungen kommen in der Sprache an, die du liest.',
  'Sign in with email': 'Mit E-Mail anmelden',
  'Sign in with GitHub': 'Mit GitHub anmelden',
  Email: 'E-Mail',
  Password: 'Passwort',
  'At least 8 characters': 'Mindestens 8 Zeichen',
  'you@company.com': 'du@firma.de',
  'Your name': 'Dein Name',
  'What your team calls you': 'Wie dein Team dich nennt',
  'Invite code': 'Einladungscode',
  'Paste one to join a team': 'Füge einen ein, um einem Team beizutreten',
  'No code? You get a workspace of your own, and can invite people into it.':
    'Kein Code? Du bekommst einen eigenen Workspace und kannst andere einladen.',
  'Joining a team? Paste the code you were sent and this signs you into it.':
    'Trittst du einem Team bei? Füge den erhaltenen Code ein und du bist direkt angemeldet.',
  'Continue without the code': 'Ohne Code fortfahren',
  'Email me a code': 'Code per E-Mail senden',
  'Check your email': 'Prüfe deine E-Mails',
  'Enter the code.': 'Gib den Code ein.',
  Continue: 'Weiter',
  'Send another code': 'Neuen Code senden',
  Back: 'Zurück',
  Cancel: 'Abbrechen',
  Skip: 'Überspringen',
  'Sign out': 'Abmelden',

  // Onboarding
  'Two questions': 'Zwei Fragen',
  'What do you mostly decide?': 'Was entscheidest du hauptsächlich?',
  'Where it goes': 'Wohin es geht',
  Language: 'Sprache',
  'ob.tell.title': 'Sag es deiner KI. Keinem Kanal.',
  'ob.tell.body':
    '„Bitte Kenji, den neuen Lieferantenpreis freizugeben.“ Das ist die ganze Interaktion. Es gibt nichts zu posten, niemanden zu erwähnen, keinen Kanal zu wählen.',
  'ob.route.title': 'Sie findet heraus, wer entscheidet.',
  'ob.route.body':
    'Deine KI liest dein Team — Rollen, Zuständigkeiten, wer überlastet ist — und reicht es an die KI der richtigen Person weiter, die es als Karte für deren Entscheidung formuliert, nicht für deinen Satz.',
  'ob.swipe.title': 'Erledige es mit einem Wischen.',
  'ob.swipe.body':
    'Zustimmen, ablehnen, eine Überarbeitung anfordern oder an jemand anderen geben. Die Antwort geht direkt zurück an die fragende Person — und an GitHub, wenn sie dorthin gehört.',
  'routes to whoever decides': 'geht an die Person, die entscheidet',
  'Approved. Kenji’s AI already knows.': 'Zugestimmt. Kenjis KI weiß es schon.',
  'Declined. Kenji’s AI already knows.': 'Abgelehnt. Kenjis KI weiß es schon.',

  // Feed
  waiting: 'wartend',
  decided: 'entschieden',
  businesses: 'Bereiche',
  'save 20%': '20 % sparen',
  Annual: 'Jährlich',
  Monthly: 'Monatlich',
  'Tell your AI': 'Sag es deiner KI',
  'compose.hint':
    'Für wen, welche Entscheidung, bis wann. Deine KI schreibt die Karte und leitet sie weiter.',
  'Ask anything...': 'Frag, was du willst...',
  'Nothing is waiting on you.': 'Nichts wartet auf dich.',
  'Nothing sent yet. Tell your AI something.': 'Noch nichts gesendet. Sag deiner KI etwas.',
  'No decisions yet.': 'Noch keine Entscheidungen.',
  'Nothing decided yet.': 'Noch nichts entschieden.',
  'Nothing yet.': 'Noch nichts.',
  'You have not sent anything yet.': 'Du hast noch nichts gesendet.',
  'Requested By': 'Angefragt von',
  'Reply with a note': 'Mit Notiz antworten',
  'Ask your AI about this decision': 'Frag deine KI zu dieser Entscheidung',
  'Waiting on you': 'Wartet auf dich',
  'Waiting on {name}': 'Wartet auf {name}',
  'Sent by you': 'Von dir gesendet',
  'You decided': 'Du hast entschieden',
  'You asked': 'Du hast gefragt',
  'just now': 'gerade eben',
  '{n}m ago': 'vor {n} Min.',
  '{n}h ago': 'vor {n} Std.',
  '{n}d ago': 'vor {n} T.',

  // You
  'How your AI treats you': 'Wie deine KI dich behandelt',
  'What gets routed to you first.': 'Was zuerst bei dir landet.',
  'Every notification arrives written in it.': 'Jede Benachrichtigung kommt in dieser Sprache an.',
  'Your workspace': 'Dein Workspace',
  'Where you work': 'Wo du arbeitest',
  'A team you joined': 'Ein Team, dem du beigetreten bist',
  'Join a team': 'Einem Team beitreten',
  'Your team': 'Dein Team',
  'Who is here, the codes you have out, and one more way in.':
    'Wer hier ist, die Codes, die du vergeben hast, und ein weiterer Weg herein.',
  'Who is here': 'Wer hier ist',
  'Codes you have out': 'Vergabene Codes',
  'Could not read your team.': 'Dein Team konnte nicht gelesen werden.',
  'That did not work.': 'Das hat nicht funktioniert.',
  'One moment…': 'Einen Moment…',
  'from {name}': 'von {name}',
  'Everyone here gets their own AI': 'Jede Person hier bekommt eine eigene KI',
  'A decision reaches them wherever they read, in their own language.':
    'Eine Entscheidung erreicht sie, wo immer sie lesen, in ihrer eigenen Sprache.',
  'Not in this workspace': 'Nicht in diesem Workspace',
  'Forward anything here': 'Leite hierher weiter, was du willst',
  'Mail sent here becomes a card, triaged the way your inbox is.':
    'Mail, die hier ankommt, wird zur Karte — vorsortiert wie dein Posteingang.',
  'This workspace is not backed by a GitHub repository, so there is nowhere to open an issue.':
    'Dieser Workspace ist nicht an ein GitHub-Repository gebunden — es gibt also keine Stelle für ein Issue.',
  'Decisions sync as your GitHub account. Sign in with GitHub to turn this on.':
    'Entscheidungen synchronisieren sich über dein GitHub-Konto. Melde dich mit GitHub an, um das zu aktivieren.',
  'Paste a code somebody sent you.': 'Füge einen Code ein, den dir jemand geschickt hat.',
  'That invite code is not valid.': 'Dieser Einladungscode ist ungültig.',
  'Everything already settled.': 'Alles bereits erledigt.',
  'The record': 'Das Protokoll',
  'Every decision, by business, written by nobody.':
    'Jede Entscheidung, nach Bereich, von niemandem geschrieben.',
  'Gmail, Slack, Notion, GitHub.': 'Gmail, Slack, Notion, GitHub.',
  'Google Calendar': 'Google Calendar',
  'Google Drive': 'Google Drive',
  'Meetings still waiting on an answer from you.': 'Termine, die noch auf deine Antwort warten.',
  'Documents someone put in front of you.': 'Dokumente, die dir jemand vorgelegt hat.',
  'Where a decision reaches you.': 'Wo dich eine Entscheidung erreicht.',
  'Invite a teammate': 'Teammitglied einladen',
  'Their role': 'Deren Rolle',
  'What their AI puts in front of them first.': 'Was deren KI zuerst vorlegt.',
  'Anyone who signs up with this code joins your workspace as {role}.':
    'Wer sich mit diesem Code registriert, tritt deinem Workspace als {role} bei.',
  'Create another': 'Weiteren erstellen',
  'They get their own AI, in this workspace.': 'Sie bekommen eine eigene KI in diesem Workspace.',
  'What you are on, and what else there is.': 'Was du hast und was es sonst gibt.',
  'Delete account': 'Konto löschen',
  'Keep it': 'Behalten',
  'Businesses your AI has found': 'Bereiche, die deine KI gefunden hat',
  'notify.language':
    'Egal über welchen Kanal: Die Worte kommen in deiner Sprache an — nicht in der der Person, die die Entscheidung angestoßen hat.',
  'history.blurb':
    'Entscheidungen landen hier in dem Moment, in dem sie fallen — deine und die, um die du gebeten hast.',
  'businesses.blurb': 'Diese Liste hat niemand angelegt. Sie wächst mit jeder einsortierten Entscheidung.',
  'On iPhone, add this to your home screen first — Safari only allows notifications for an installed web app.':
    'Füge dies auf dem iPhone zuerst dem Home-Bildschirm hinzu — Safari erlaubt Mitteilungen nur für installierte Web-Apps.',
  'Blocked in your browser settings — allow notifications for this site to turn it on.':
    'In den Browser-Einstellungen blockiert — erlaube Mitteilungen für diese Seite, um sie einzuschalten.',
  'A decision that needs you arrives even when this tab is closed.':
    'Eine Entscheidung, die dich braucht, kommt auch bei geschlossenem Tab an.',
  'Email as the fallback': 'E-Mail als Fallback',
  'Changing this changes nothing else — it is only where mail lands.':
    'Das zu ändern ändert nichts weiter — es ist nur, wohin Mail geht.',
  'This is the address you sign in with, so it cannot be changed here.':
    'Das ist die Adresse, mit der du dich anmeldest — sie lässt sich hier nicht ändern.',
  'On this device': 'Auf diesem Gerät',
  'By email': 'Per E-Mail',
  'Email fallback': 'E-Mail-Fallback',
  'Push notifications': 'Push-Mitteilungen',
  'Turn on notifications': 'Mitteilungen aktivieren',
  'Always on': 'Immer an',
  'All clear': 'Alles erledigt',
  'Nothing is waiting on you. Your AI will tell you when something is.':
    'Nichts wartet auf dich. Deine KI meldet sich, wenn etwas ansteht.',
  'Only when no device of yours can be reached. Never a duplicate.':
    'Nur wenn keines deiner Geräte erreichbar ist. Nie doppelt.',
  'Every notification reaches you in this language, whoever wrote it.':
    'Jede Mitteilung erreicht dich in dieser Sprache, egal wer sie verfasst hat.',
  'You are on Pro. Unlimited routing, every business, the full record.':
    'Du bist auf Pro. Unbegrenztes Routing, alle Bereiche, das volle Protokoll.',
  'Decision · high': 'Entscheidung · hoch',
  'Supplier price +8%': 'Lieferantenpreis +8 %',
  'Kenji needs an answer today to hold this month’s slot.':
    'Kenji braucht heute eine Antwort, um den Slot dieses Monats zu halten.',
  'Decision:': 'Entscheidung:',
  'Revision:': 'Überarbeitung:',
  'Routing…': 'Routing…',
  'Saving…': 'Speichern…',
  'Creating…': 'Erstellen…',
  Copy: 'Kopieren',
  Copied: 'Kopiert',
  'Copied!': 'Kopiert!',
  'Copy as Markdown': 'Als Markdown kopieren',
  'Create invite code': 'Einladungscode erstellen',
  Next: 'Weiter',
  'Set me up': 'Einrichten',
  'Open my feed': 'Meinen Feed öffnen',
  'Reconnecting…': 'Verbinde neu…',
  Decisions: 'Entscheidungen',
  'Not yet filed': 'Noch nicht einsortiert',
  'Approved.': 'Zugestimmt.',
  'Declined.': 'Abgelehnt.',
  'Revision asked': 'Überarbeitung angefragt',
  Chose: 'Gewählt',
  Replied: 'Geantwortet',
  Acknowledged: 'Bestätigt',
  Delegated: 'Delegiert',
  Deferred: 'Vertagt',
  'Founder / operator': 'Gründer / Betreiber',
  'You decide most things, and want the rest to stop reaching you.':
    'Du entscheidest fast alles — und willst, dass der Rest dich nicht mehr erreicht.',
  'Ops / business': 'Ops / Business',
  'Suppliers, bookings, money, people.': 'Lieferanten, Buchungen, Geld, Menschen.',
  Engineer: 'Engineering',
  'Anything shipping-related routes to you.': 'Alles rund ums Ausliefern geht an dich.',
  Designer: 'Design',
  'Anything about how it looks or reads.': 'Alles, wie etwas aussieht oder sich liest.',
  'Something else': 'Etwas anderes',
  Member: 'Mitglied',
  Admin: 'Admin',
  Maintainer: 'Maintainer',
  Triager: 'Triager',
  'Your AI works it out from what people send you.':
    'Deine KI erschließt es aus dem, was dir geschickt wird.',
  'Could not read your profile.': 'Dein Profil konnte nicht gelesen werden.',
  'Could not read your settings.': 'Deine Einstellungen konnten nicht gelesen werden.',
  'That did not save.': 'Das wurde nicht gespeichert.',
  'Could not create invite.': 'Einladung konnte nicht erstellt werden.',
  'Your AI could not route that.': 'Deine KI konnte das nicht zuordnen.',
  'Routing failed': 'Routing fehlgeschlagen',
  'This browser cannot receive push notifications here.':
    'Dieser Browser kann hier keine Push-Mitteilungen empfangen.',
  'This browser cannot receive them.': 'Dieser Browser kann sie nicht empfangen.',
  'Could not turn notifications on. Try again in a moment.':
    'Mitteilungen ließen sich nicht aktivieren. Gleich noch einmal versuchen.',
  'That did not work. Try again in a moment.': 'Das hat nicht geklappt. Gleich noch einmal versuchen.',
  'We could not save that.': 'Das ließ sich nicht speichern.',

  // Tools
  'tools.lede':
    'Verbundene Tools speisen deine KI. Sie bringen keine Kanäle hierher — was zurückkommt, sind Entscheidungen, im selben Feed wie alles andere.',
  'Pull now': 'Jetzt abrufen',
  'Pulling…': 'Rufe ab…',
  'Mail that needs a decision becomes a card. Nothing else does.':
    'Mail, die eine Entscheidung braucht, wird zur Karte. Nichts anderes.',
  'Messages addressed to you, triaged into decisions — without you opening Slack.':
    'Nachrichten an dich, zu Entscheidungen vorsortiert — ohne dass du Slack öffnest.',
  'Decisions are written back to the database you point at.':
    'Entscheidungen werden in die Datenbank zurückgeschrieben, die du angibst.',
  'Approvals, tasks and assignee changes sync to Issues and Pull Requests.':
    'Freigaben, Aufgaben und Assignee-Änderungen synchronisieren sich mit Issues und Pull Requests.',
  'Feeds decisions into your feed.': 'Speist Entscheidungen in deinen Feed.',
  'Connectors are not switched on for this workspace yet.':
    'Connectoren sind für diesen Workspace noch nicht aktiviert.',
  'Could not load your tools.': 'Deine Tools konnten nicht geladen werden.',
  'Could not start that connection.': 'Diese Verbindung ließ sich nicht starten.',
  'Finish in the tab that opened, then come back and pull.':
    'Im geöffneten Tab abschließen, zurückkommen und abrufen.',
  'Nothing could be pulled just now.': 'Gerade ließ sich nichts abrufen.',
  '{n} new in your feed.': '{n} neue in deinem Feed.',
  'Nothing new needed you.': 'Nichts Neues brauchte dich.',
  'Built in': 'Integriert',
  'No connectors are available on this deployment.':
    'Auf diesem Deployment sind keine Connectoren verfügbar.',
  'Event log': 'Ereignisprotokoll',

  // Plan
  'Choose your plan': 'Wähl deinen Plan',
  'Loading…': 'Lädt…',
  'Billing period': 'Abrechnungszeitraum',
  'Not for sale yet': 'Noch nicht erhältlich',

  // Chrome
  Done: 'Fertig',
  Feed: 'Feed',
  History: 'Verlauf',
  Tools: 'Tools',
  You: 'Du',
  Cards: 'Karten',
  Priority: 'Priorität',
  Notification: 'Mitteilung',
  Task: 'Aufgabe',
  Delegation: 'Delegation',
  Revision: 'Überarbeitung',
  admin: 'Admin',
  member: 'Mitglied',
  founder: 'Gründer',
  operator: 'Betreiber',
  engineer: 'Engineer',
  designer: 'Designer',
  triager: 'Triager',
  maintainer: 'Maintainer',
  Classic: 'Klassisch',
  Approve: 'Zustimmen',
  Decline: 'Ablehnen',
  Nudge: 'Anstupsen',
  View: 'Ansehen',
  Send: 'Senden',
  Low: 'Niedrig',
  Medium: 'Mittel',
  High: 'Hoch',
  Approved: 'Zugestimmt',
  Declined: 'Abgelehnt',
  Waiting: 'Wartend',
  Decided: 'Entschieden',
  Everything: 'Alles',
  Today: 'Heute',
  Yesterday: 'Gestern',
  Role: 'Rolle',
  Remove: 'Entfernen',
  Leave: 'Verlassen',
  Keep: 'Behalten',
  Revoke: 'Widerrufen',
  you: 'du',
  yours: 'deins',
  Off: 'Aus',
  Join: 'Beitreten',
  Notifications: 'Mitteilungen',
  Plan: 'Plan',
  Delete: 'Löschen',
  Waiting_stat: 'Wartend',
  Businesses: 'Bereiche',
  Connected: 'Verbunden',
  Connect: 'Verbinden',
  Free: 'Kostenlos',
  Close: 'Schließen',
  Filter: 'Filtern',
  Main: 'Haupt',
}

const TABLES: Record<string, Dict> = { en, ja, es, fr, de }

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
