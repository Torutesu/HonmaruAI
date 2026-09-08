// Meetings that are waiting on an answer from you.
//
// A calendar is mostly not decisions: a standing weekly is not a decision, and
// neither is something you accepted a month ago. What is a decision is an
// invitation nobody has answered — so this asks for the window either side of
// now and hands each event to triage with the fact of the invitation attached.
// Triage is what decides whether it needs you; this only decides what to show
// it, exactly as Gmail hands it a week of mail rather than an inbox.

function windowStart() {
  // Yesterday, because an invitation that arrived overnight for a meeting this
  // morning is the one most worth catching.
  return new Date(Date.now() - 86400_000).toISOString();
}

function windowEnd() {
  return new Date(Date.now() + 14 * 86400_000).toISOString();
}

/// Whether *you* still owe an answer. Google marks each attendee's own row with
/// `self: true`; `needsAction` is its word for "not replied".
function myResponse(attendees) {
  const mine = (attendees || []).find((a) => a?.self);
  return mine?.responseStatus || "";
}

function whoInvited(event) {
  return event?.organizer?.displayName || event?.organizer?.email || event?.creator?.email || "Calendar";
}

export const googlecalendar = {
  id: "googlecalendar",
  label: "Google Calendar",
  // No built-in auth config: the ones Gmail, Slack and Notion ship were
  // created at Composio by this project, and nobody has created these. Until
  // CONNECTOR_AUTH_GOOGLECALENDAR is set this connector is not offered at all,
  // which is better than a Connect button that cannot work.
  authConfigId: null,
  toolSlug: "GOOGLECALENDAR_EVENTS_LIST",

  buildArgs() {
    return {
      calendarId: "primary",
      timeMin: windowStart(),
      timeMax: windowEnd(),
      maxResults: 10,
      singleEvents: true,
      orderBy: "startTime",
    };
  },

  // Composio wraps a payload two ways depending on the execution path, and an
  // empty calendar is a normal result — the same three shapes Gmail handles.
  parse(payload) {
    const wrapped = payload?.results?.[0]?.response?.data?.items;
    const plain = payload?.data?.items ?? payload?.items;
    const events = Array.isArray(wrapped) ? wrapped : Array.isArray(plain) ? plain : [];
    return events
      // Something you have already answered is not waiting on you. Declined
      // included: that was an answer.
      .filter((e) => {
        const status = myResponse(e.attendees);
        return status === "" || status === "needsAction";
      })
      .map((e) => {
        const when = e.start?.dateTime || e.start?.date || "";
        const invited = myResponse(e.attendees) === "needsAction";
        return {
          id: e.id,
          from: whoInvited(e),
          subject: e.summary || "(no title)",
          // The snippet is what triage reads, so it says the thing that makes
          // this a decision rather than a diary entry.
          snippet: [
            invited ? "Invitation not yet answered." : "",
            when ? `Starts ${when}.` : "",
            e.location ? `Location: ${e.location}.` : "",
            (e.description || "").slice(0, 300),
          ].filter(Boolean).join(" ").trim(),
          date: when,
        };
      });
  },
};
