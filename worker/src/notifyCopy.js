// Every word a notification says, in every language it can say it in.
//
// A notification is read on a lock screen, in a browser corner, or in a mail
// client — none of which run our app, so none of them can localize for us.
// The Worker has to write the alert in the recipient's language, and that
// language is theirs, not the sender's: a Japanese founder asking an English
// contractor for sign-off produces an English alert on the contractor's phone.
//
// Strings live here rather than inline so the set of languages is one list,
// and adding one is adding a block, not finding every template string.

const STRINGS = {
  en: {
    waiting: "A decision is waiting",
    fromAI: "{name}'s AI → you",
    yourAI: "Your AI → you",
    decided: "Decision made",
    decidedBy: "{actor} · {action}",
    digest: "{count} decisions need you",
    nudge: "{name} is still waiting on your decision",
    nudgeSubtitle: "A gentle reminder",
    emailSubject: "[Honmaru] {title}",
    emailIntro: "A decision is waiting on you.",
    emailDecidedIntro: "A decision you asked for has been made.",
    emailNudgeIntro: "{name} is still waiting on your decision.",
    emailOpen: "Open it here: {url}",
    emailFooter: "You are getting this because no device of yours can receive a push notification. Install the app or enable notifications in your browser to switch.",
    actions: {
      approve: "approved", decline: "declined", choose: "chose an option", reply: "replied",
      acknowledge: "acknowledged", later: "deferred", delete: "removed", mute: "muted",
      revised: "asked for changes", delegate: "delegated",
    },
  },
  ja: {
    waiting: "決定待ちがあります",
    fromAI: "{name}のAI → あなた",
    yourAI: "あなたのAI → あなた",
    decided: "決定されました",
    decidedBy: "{actor} · {action}",
    digest: "{count}件の決定があなたを待っています",
    nudge: "{name}があなたの決定を待っています",
    nudgeSubtitle: "リマインダー",
    emailSubject: "[Honmaru] {title}",
    emailIntro: "あなたの決定が必要な案件があります。",
    emailDecidedIntro: "あなたが依頼した案件が決定されました。",
    emailNudgeIntro: "{name}があなたの決定を待っています。",
    emailOpen: "こちらから開けます: {url}",
    emailFooter: "このメールは、プッシュ通知を受け取れる端末が登録されていないため送られています。アプリをインストールするか、ブラウザで通知を有効にすると切り替わります。",
    actions: {
      approve: "承認", decline: "却下", choose: "選択", reply: "返信",
      acknowledge: "確認済み", later: "保留", delete: "削除", mute: "ミュート",
      revised: "修正依頼", delegate: "委任",
    },
  },
};

export const SUPPORTED_LOCALES = Object.keys(STRINGS);

/// The strings for a locale, falling back to English for one we have not
/// written yet. A person whose language we cannot speak still gets told.
export function stringsFor(locale) {
  return STRINGS[locale] || STRINGS.en;
}

function fill(template, vars = {}) {
  return String(template).replace(/\{(\w+)\}/g, (_, key) => (vars[key] ?? ""));
}

export function t(locale, key, vars) {
  const table = stringsFor(locale);
  const template = table[key] ?? STRINGS.en[key] ?? key;
  return fill(template, vars);
}

/// A decision action as a word: "approved", "承認".
export function actionLabel(locale, action) {
  const table = stringsFor(locale);
  return table.actions[action] || STRINGS.en.actions[action] || action || "";
}

/// The card's title in this person's language, when the relay has produced
/// one; the original otherwise. The original is written in the sender's
/// language, which is the right thing to show the sender.
export function titleFor(card, locale) {
  return card?.localized?.[locale]?.title || card?.title || "";
}

export function summaryFor(card, locale) {
  return card?.localized?.[locale]?.summary || card?.summary || "";
}

/// The plain name to show for a login: "u:someone@x.com" → "someone".
export function displayName(login) {
  if (!login) return "";
  return String(login).replace(/^(u:|email:)/, "").split("@")[0];
}

/// What a notification says, in the recipient's language.
///
/// `kind` is created | decided | nudged | digest. The body is title and routing
/// line only: the lock screen is a public surface, and a summary can carry a
/// salary or a client's name. The card id rides alongside so a tap can open it.
export function composeAlert({ card, kind, locale, count }) {
  const lang = stringsFor(locale) === STRINGS.en ? "en" : locale;
  if (kind === "digest") {
    return { title: t(lang, "digest", { count }), subtitle: t(lang, "yourAI") };
  }
  if (kind === "decided") {
    const action = actionLabel(lang, card.decision?.action || card.status);
    const actor = displayName(card.decision?.actorUserID) || displayName(card.recipientUserID);
    return {
      title: titleFor(card, lang) || t(lang, "decided"),
      subtitle: t(lang, "decidedBy", { actor, action }),
    };
  }
  if (kind === "nudged") {
    return {
      title: titleFor(card, lang) || t(lang, "waiting"),
      subtitle: t(lang, "nudge", { name: displayName(card.senderUserID) }),
    };
  }
  const sender = card.senderUserID;
  const selfSent = !sender || sender === "deleted-user" || sender === card.recipientUserID;
  return {
    title: titleFor(card, lang) || t(lang, "waiting"),
    subtitle: selfSent ? t(lang, "yourAI") : t(lang, "fromAI", { name: displayName(sender) }),
  };
}

/// The same alert, as an email. Plain text: it renders everywhere, and a
/// decision is not a newsletter.
export function composeEmail({ card, kind, locale, count, url }) {
  const lang = stringsFor(locale) === STRINGS.en ? "en" : locale;
  const alert = composeAlert({ card, kind, locale: lang, count });
  const intro = kind === "decided"
    ? t(lang, "emailDecidedIntro")
    : kind === "nudged"
      ? t(lang, "emailNudgeIntro", { name: displayName(card.senderUserID) })
      : t(lang, "emailIntro");
  const lines = [intro, "", alert.title, alert.subtitle];
  const summary = kind === "digest" ? "" : summaryFor(card, lang);
  if (summary) lines.push("", summary);
  if (url) lines.push("", t(lang, "emailOpen", { url }));
  lines.push("", "—", t(lang, "emailFooter"));
  return {
    subject: t(lang, "emailSubject", { title: alert.title }),
    text: lines.join("\n"),
  };
}
