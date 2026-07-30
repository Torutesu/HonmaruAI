import { createHmac, timingSafeEqual, randomUUID } from "node:crypto";

export function verifyWebhookSignature({ payload, signature, secret }) {
  if (!secret) return true; // dev mode — set GITHUB_WEBHOOK_SECRET in production
  if (!signature || !signature.startsWith("sha256=")) return false;

  const expected =
    "sha256=" + createHmac("sha256", secret).update(payload).digest("hex");
  const a = Buffer.from(expected);
  const b = Buffer.from(signature);
  return a.length === b.length && timingSafeEqual(a, b);
}

/**
 * Map a GitHub webhook event to decision cards. Recipients resolve through
 * the org's githubUsername mapping; events for unknown logins are dropped.
 */
export function cardsFromWebhook({ event, payload, orgStore }) {
  const cards = [];
  const repo = payload.repository?.full_name || "repository";
  const actorLogin = payload.sender?.login || "";
  const actorMember = orgStore.findByGitHub(actorLogin);

  const make = ({ recipient, type, title, summary, context, priority, url }) => ({
    id: `card-gh-${randomUUID()}`,
    recipientUserID: recipient.id,
    senderUserID: actorMember?.id || recipient.id,
    type,
    title,
    summary,
    context,
    status: "pending",
    priority,
    createdAt: new Date().toISOString(),
    agentRoute: `GitHub → ${recipient.name}'s AI`,
    routingReason: `From GitHub · ${repo}`,
    githubIssueURL: url,
    githubRepository: repo,
  });

  if (event === "pull_request" && payload.action === "review_requested") {
    const reviewer = orgStore.findByGitHub(payload.requested_reviewer?.login);
    const pr = payload.pull_request;
    if (reviewer && pr) {
      cards.push(
        make({
          recipient: reviewer,
          type: "approval",
          title: `Review PR #${pr.number}: ${pr.title}`,
          summary: `${actorLogin || "A teammate"} requested your review on ${repo}#${pr.number}.`,
          context: `repo: ${repo} · pr: #${pr.number} · branch: ${pr.head?.ref || "?"}`,
          priority: "high",
          url: pr.html_url,
        })
      );
    }
  }

  if (event === "issues" && payload.action === "assigned") {
    const assignee = orgStore.findByGitHub(payload.assignee?.login);
    const issue = payload.issue;
    if (assignee && issue) {
      const labels = (issue.labels || []).map((label) => label.name).join(", ");
      cards.push(
        make({
          recipient: assignee,
          type: "task",
          title: `Issue #${issue.number}: ${issue.title}`,
          summary: `You were assigned ${repo}#${issue.number}${actorLogin ? ` by ${actorLogin}` : ""}.`,
          context: `repo: ${repo} · issue: #${issue.number} · labels: ${labels || "none"}`,
          priority: "medium",
          url: issue.html_url,
        })
      );
    }
  }

  if (
    event === "workflow_run" &&
    payload.action === "completed" &&
    payload.workflow_run?.conclusion === "failure"
  ) {
    const run = payload.workflow_run;
    const author = orgStore.findByGitHub(
      run.actor?.login || run.head_commit?.author?.username
    );
    if (author) {
      cards.push(
        make({
          recipient: author,
          type: "task",
          title: `CI failed: ${run.name || "workflow"} on ${run.head_branch || "branch"}`,
          summary: `${run.name || "A workflow"} failed on ${repo} (${run.head_branch || "?"}). Investigate and rerun.`,
          context: `repo: ${repo} · workflow: ${run.name || "?"} · branch: ${run.head_branch || "?"}`,
          priority: "high",
          url: run.html_url,
        })
      );
    }
  }

  return cards;
}
