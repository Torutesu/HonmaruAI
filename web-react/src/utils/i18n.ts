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
