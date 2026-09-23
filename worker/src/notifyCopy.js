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
    codeSubject: "{code} is your Honmaru sign-in code",
    codeIntro: "Enter this code to sign in to Honmaru AI:",
    codeExpiry: "It works for {minutes} minutes, once.",
    codeIgnore: "If you did not ask to sign in, ignore this email — nothing has happened to your account.",
    inviteSubject: "{inviter} invited you to {team} on Honmaru AI",
    inviteIntro: "{inviter} invited you to join {team} on Honmaru AI — where every decision reaches the right person, in their own language.",
    inviteOpen: "Open this link to join: {url}",
    inviteCode: "Or sign in and enter this invite code: {code}",
    inviteExpiry: "The invitation works for {days} days.",
    inviteIgnore: "If you were not expecting this, ignore this email — nothing has happened.",
    yourTeam: "their team",
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
    codeSubject: "Honmaru のログインコード: {code}",
    codeIntro: "このコードを入力すると Honmaru AI にログインできます:",
    codeExpiry: "有効期間は{minutes}分、1回限りです。",
    codeIgnore: "心当たりがない場合は、このメールを無視してください。アカウントには何も起きていません。",
    inviteSubject: "{inviter}さんから Honmaru AI の「{team}」への招待",
    inviteIntro: "{inviter}さんが Honmaru AI の「{team}」にあなたを招待しました。決定が、それぞれの言語で、必要な人に届きます。",
    inviteOpen: "このリンクを開くと参加できます: {url}",
    inviteCode: "または、サインインしてこの招待コードを入力してください: {code}",
    inviteExpiry: "この招待は{days}日間有効です。",
    inviteIgnore: "心当たりがない場合は、このメールを無視してください。何も起きていません。",
    yourTeam: "チーム",
    actions: {
      approve: "承認", decline: "却下", choose: "選択", reply: "返信",
      acknowledge: "確認済み", later: "保留", delete: "削除", mute: "ミュート",
      revised: "修正依頼", delegate: "委任",
    },
  },
  es: {
    waiting: "Hay una decisión pendiente",
    fromAI: "La IA de {name} → tú",
    yourAI: "Tu IA → tú",
    decided: "Decisión tomada",
    decidedBy: "{actor} · {action}",
    digest: "{count} decisiones te esperan",
    nudge: "{name} sigue esperando tu decisión",
    nudgeSubtitle: "Un recordatorio amable",
    emailSubject: "[Honmaru] {title}",
    emailIntro: "Hay una decisión esperándote.",
    emailDecidedIntro: "Se ha tomado una decisión que pediste.",
    emailNudgeIntro: "{name} sigue esperando tu decisión.",
    emailOpen: "Ábrela aquí: {url}",
    emailFooter: "Recibes esto porque ninguno de tus dispositivos puede recibir notificaciones push. Instala la app o activa las notificaciones en tu navegador para cambiarlo.",
    codeSubject: "{code} es tu código de acceso a Honmaru",
    codeIntro: "Introduce este código para entrar en Honmaru AI:",
    codeExpiry: "Funciona durante {minutes} minutos, una sola vez.",
    codeIgnore: "Si no pediste iniciar sesión, ignora este correo: tu cuenta no ha cambiado.",
    inviteSubject: "{inviter} te invitó a {team} en Honmaru AI",
    inviteIntro: "{inviter} te invitó a unirte a {team} en Honmaru AI, donde cada decisión llega a la persona correcta, en su propio idioma.",
    inviteOpen: "Abre este enlace para unirte: {url}",
    inviteCode: "O inicia sesión e introduce este código de invitación: {code}",
    inviteExpiry: "La invitación es válida durante {days} días.",
    inviteIgnore: "Si no esperabas esto, ignora este correo: no ha pasado nada.",
    yourTeam: "su equipo",
    actions: {
      approve: "aprobó", decline: "rechazó", choose: "eligió una opción", reply: "respondió",
      acknowledge: "confirmó", later: "aplazó", delete: "eliminó", mute: "silenció",
      revised: "pidió cambios", delegate: "delegó",
    },
  },
  fr: {
    waiting: "Une décision vous attend",
    fromAI: "L'IA de {name} → vous",
    yourAI: "Votre IA → vous",
    decided: "Décision prise",
    decidedBy: "{actor} · {action}",
    digest: "{count} décisions vous attendent",
    nudge: "{name} attend toujours votre décision",
    nudgeSubtitle: "Un petit rappel",
    emailSubject: "[Honmaru] {title}",
    emailIntro: "Une décision vous attend.",
    emailDecidedIntro: "Une décision que vous aviez demandée a été prise.",
    emailNudgeIntro: "{name} attend toujours votre décision.",
    emailOpen: "Ouvrez-la ici : {url}",
    emailFooter: "Vous recevez ce message car aucun de vos appareils ne peut recevoir de notification push. Installez l'app ou activez les notifications dans votre navigateur pour changer cela.",
    codeSubject: "{code} est votre code de connexion Honmaru",
    codeIntro: "Saisissez ce code pour vous connecter à Honmaru AI :",
    codeExpiry: "Il fonctionne pendant {minutes} minutes, une seule fois.",
    codeIgnore: "Si vous n'avez pas demandé à vous connecter, ignorez cet e-mail — rien n'a changé sur votre compte.",
    inviteSubject: "{inviter} vous a invité à rejoindre {team} sur Honmaru AI",
    inviteIntro: "{inviter} vous a invité à rejoindre {team} sur Honmaru AI, où chaque décision atteint la bonne personne, dans sa propre langue.",
    inviteOpen: "Ouvrez ce lien pour rejoindre l'équipe : {url}",
    inviteCode: "Ou connectez-vous et saisissez ce code d'invitation : {code}",
    inviteExpiry: "L'invitation est valable {days} jours.",
    inviteIgnore: "Si vous n'attendiez pas ce message, ignorez-le : rien ne s'est passé.",
    yourTeam: "son équipe",
    actions: {
      approve: "a approuvé", decline: "a refusé", choose: "a choisi une option", reply: "a répondu",
      acknowledge: "a pris acte", later: "a reporté", delete: "a supprimé", mute: "a masqué",
      revised: "a demandé des modifications", delegate: "a délégué",
    },
  },
  de: {
    waiting: "Eine Entscheidung wartet",
    fromAI: "{name}s KI → du",
    yourAI: "Deine KI → du",
    decided: "Entscheidung getroffen",
    decidedBy: "{actor} · {action}",
    digest: "{count} Entscheidungen warten auf dich",
    nudge: "{name} wartet noch auf deine Entscheidung",
    nudgeSubtitle: "Eine freundliche Erinnerung",
    emailSubject: "[Honmaru] {title}",
    emailIntro: "Eine Entscheidung wartet auf dich.",
    emailDecidedIntro: "Eine Entscheidung, um die du gebeten hast, wurde getroffen.",
    emailNudgeIntro: "{name} wartet noch auf deine Entscheidung.",
    emailOpen: "Hier öffnen: {url}",
    emailFooter: "Du erhältst diese E-Mail, weil keines deiner Geräte Push-Benachrichtigungen empfangen kann. Installiere die App oder aktiviere Benachrichtigungen im Browser, um das zu ändern.",
    codeSubject: "{code} ist dein Honmaru-Anmeldecode",
    codeIntro: "Gib diesen Code ein, um dich bei Honmaru AI anzumelden:",
    codeExpiry: "Er gilt {minutes} Minuten lang, einmalig.",
    codeIgnore: "Falls du keine Anmeldung angefordert hast, ignoriere diese E-Mail — mit deinem Konto ist nichts passiert.",
    inviteSubject: "{inviter} hat dich zu {team} auf Honmaru AI eingeladen",
    inviteIntro: "{inviter} hat dich eingeladen, {team} auf Honmaru AI beizutreten – wo jede Entscheidung die richtige Person erreicht, in ihrer eigenen Sprache.",
    inviteOpen: "Öffne diesen Link, um beizutreten: {url}",
    inviteCode: "Oder melde dich an und gib diesen Einladungscode ein: {code}",
    inviteExpiry: "Die Einladung gilt {days} Tage.",
    inviteIgnore: "Wenn du das nicht erwartet hast, ignoriere diese E-Mail – es ist nichts passiert.",
    yourTeam: "ihr Team",
    actions: {
      approve: "hat zugestimmt", decline: "hat abgelehnt", choose: "hat eine Option gewählt", reply: "hat geantwortet",
      acknowledge: "hat bestätigt", later: "hat vertagt", delete: "hat gelöscht", mute: "hat stummgeschaltet",
      revised: "hat Änderungen angefragt", delegate: "hat delegiert",
    },
  },
};

export const SUPPORTED_LOCALES = Object.keys(STRINGS);

/// The strings for a locale, falling back to English for one we have not
/// written yet. A person whose language we cannot speak still gets told.
///
/// A region is not a language here: "ja-JP", "ja_JP" and "ja" all read the
/// same table. Stored locales are already reduced to the primary subtag, but
/// an Accept-Language header is not, and a sign-in code email is written
/// before there is any stored locale to read.
export function stringsFor(locale) {
  if (typeof locale !== "string") return STRINGS.en;
  const primary = locale.trim().toLowerCase().split(/[-_]/)[0];
  return STRINGS[primary] || STRINGS.en;
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

/// The sign-in code email. Written in the language the browser asked in, since
/// someone who has never signed in has no stored language yet.
///
/// The code is in the subject as well as the body: on a phone, that is the
/// difference between reading it from the notification and opening the mail
/// app, and the code is single-use and short-lived either way.
export function composeCodeEmail({ code, locale, minutes }) {
  return {
    subject: t(locale, "codeSubject", { code }),
    text: [
      t(locale, "codeIntro"),
      "",
      code,
      "",
      t(locale, "codeExpiry", { minutes: String(minutes) }),
      t(locale, "codeIgnore"),
    ].join("\n"),
  };
}

/// An invitation, in the language of the person sending it — the only
/// language we know before the invitee has an account. A link when the
/// deployment has a web address, the code either way.
export function composeInviteEmail({ inviter, team, code, url, days, locale }) {
  const vars = { inviter: inviter || "A teammate", team: team || t(locale, "yourTeam"), code, url: url || "", days: String(days) };
  return {
    subject: t(locale, "inviteSubject", vars),
    text: [
      t(locale, "inviteIntro", vars),
      "",
      url ? t(locale, "inviteOpen", vars) : null,
      t(locale, "inviteCode", vars),
      "",
      t(locale, "inviteExpiry", vars),
      t(locale, "inviteIgnore"),
    ].filter((line) => line !== null).join("\n"),
  };
}
