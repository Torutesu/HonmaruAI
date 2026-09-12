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
