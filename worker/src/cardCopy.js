import { registerCatalog } from "./copy.js";
// The words on a card that nobody wrote.
//
// A card's summary is the person's own sentence and stays in the language they
// typed it in. Its title and its routing line are ours — "Approval needed",
// "From Mai · decision routed to Ken" — and with no AI key configured the
// fallback router put those in English in front of a Japanese reader, which is
// the half of "the language switch does nothing" that lives on the server.
//
// English is the key, as in the client's own table, so an untranslated string
// degrades to English rather than to a key name.

const JA = {
  "Approval needed": "承認が必要です",
  "Revision requested": "修正の依頼",
  "Decision needed": "判断が必要です",
  "New task": "新しいタスク",
  "Your task": "あなたのタスク",
  "Your note": "あなたのメモ",
  "Task for {name}": "{name}へのタスク",
  "Update for {name}": "{name}への連絡",
  "From your own AI": "あなた自身のAIから",
  "From {sender} · decision routed to {recipient}": "{sender}から · {recipient}に振り分け",
  "Decision requested.": "判断をお願いします。",
  "{name} has left this workspace, so this came back to you.":
    "{name}さんはこのワークスペースを離れたため、これはあなたに戻されました。",
};

const ES = {
  "Approval needed": "Se necesita aprobación",
  "Revision requested": "Se solicitan cambios",
  "Decision needed": "Se necesita una decisión",
  "New task": "Nueva tarea",
  "Your task": "Tu tarea",
  "Your note": "Tu nota",
  "Task for {name}": "Tarea para {name}",
  "Update for {name}": "Aviso para {name}",
  "From your own AI": "De tu propia IA",
  "From {sender} · decision routed to {recipient}": "De {sender} · decisión enviada a {recipient}",
  "Decision requested.": "Se solicita una decisión.",
  "{name} has left this workspace, so this came back to you.":
    "{name} ha dejado este espacio de trabajo, así que esto ha vuelto a ti.",
};

const FR = {
  "Approval needed": "Approbation requise",
  "Revision requested": "Modifications demandées",
  "Decision needed": "Décision requise",
  "New task": "Nouvelle tâche",
  "Your task": "Votre tâche",
  "Your note": "Votre note",
  "Task for {name}": "Tâche pour {name}",
  "Update for {name}": "Information pour {name}",
  "From your own AI": "De votre propre IA",
  "From {sender} · decision routed to {recipient}": "De {sender} · décision transmise à {recipient}",
  "Decision requested.": "Une décision est demandée.",
  "{name} has left this workspace, so this came back to you.":
    "{name} a quitté cet espace de travail, cette demande vous revient donc.",
};

const DE = {
  "Approval needed": "Freigabe erforderlich",
  "Revision requested": "Änderungen angefragt",
  "Decision needed": "Entscheidung erforderlich",
  "New task": "Neue Aufgabe",
  "Your task": "Deine Aufgabe",
  "Your note": "Deine Notiz",
  "Task for {name}": "Aufgabe für {name}",
  "Update for {name}": "Info für {name}",
  "From your own AI": "Von deiner eigenen KI",
  "From {sender} · decision routed to {recipient}": "Von {sender} · Entscheidung an {recipient} weitergeleitet",
  "Decision requested.": "Eine Entscheidung wird erbeten.",
  "{name} has left this workspace, so this came back to you.":
    "{name} hat diesen Workspace verlassen, daher liegt dies wieder bei dir.",
};

// English is the key, so the English table is the keys themselves. Any
// language not written here is learned by copy.js on first use.
const EN = Object.fromEntries(Object.keys(JA).map((k) => [k, k]));

const lookup = registerCatalog("card", { en: EN, ja: JA, es: ES, fr: FR, de: DE });

/// `locale` may be a full tag ("ja-JP"); only the language part decides.
export function cardText(locale, key, vars) {
  return lookup(locale, key, vars);
}
