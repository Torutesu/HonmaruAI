// The apps a workspace can start from (docs/kylon-gap-plan.md): the three
// Kylon shows first — a sales CRM, a hiring board, an invoice tracker — plus
// a plain tracker for anything else. Each is a table, its views, and a few
// sample rows so the app is never empty on first open.

export const TEMPLATES = {
  crm: {
    name: "Sales CRM",
    icon: "💼",
    description: "Leads to won deals: one pipeline, a stage board and a forecast.",
    keywords: ["crm", "sales", "deal", "deals", "sales pipeline", "lead", "leads", "営業", "商談", "顧客", "案件", "リード"],
    columns: [
      { name: "Company", type: "text" },
      { name: "Contact", type: "text" },
      { name: "Email", type: "email" },
      { name: "Stage", type: "select", options: ["Lead", "Qualified", "Proposal", "Negotiation", "Won", "Lost"] },
      { name: "Value", type: "number" },
      { name: "Next step", type: "text" },
      { name: "Next step date", type: "date" },
      { name: "Owner", type: "person" },
    ],
    views: [
      { type: "board", name: "Pipeline", groupBy: "stage" },
      { type: "table", name: "All deals", sort: "-value" },
      {
        type: "metrics", name: "Forecast",
        metrics: [
          { label: "Open pipeline", op: "sum", column: "value", where: { stage: ["Lead", "Qualified", "Proposal", "Negotiation"] } },
          { label: "Won", op: "sum", column: "value", where: { stage: ["Won"] } },
          { label: "Open deals", op: "count", where: { stage: ["Lead", "Qualified", "Proposal", "Negotiation"] } },
          { label: "Overdue next steps", op: "count", overdue: "next_step_date", where: { stage: ["Lead", "Qualified", "Proposal", "Negotiation"] } },
        ],
      },
    ],
    sample: [
      { Company: "Acme", Contact: "Dana Ito", Stage: "Proposal", Value: 24000, "Next step": "Send revised quote" },
      { Company: "Globex", Contact: "Sam Lee", Stage: "Qualified", Value: 12000, "Next step": "Discovery call" },
      { Company: "Initech", Contact: "Ken Mori", Stage: "Lead", Value: 6000 },
    ],
  },
  hiring: {
    name: "Hiring board",
    icon: "🧑‍💼",
    description: "Every candidate, by stage, with who interviews them.",
    keywords: ["hiring", "hire", "recruit", "recruiting", "candidate", "candidates", "applicant", "採用", "候補者", "応募", "面接"],
    columns: [
      { name: "Candidate", type: "text" },
      { name: "Role", type: "text" },
      { name: "Email", type: "email" },
      { name: "Stage", type: "select", options: ["Applied", "Screen", "Interview", "Offer", "Hired", "Rejected"] },
      { name: "Rating", type: "number" },
      { name: "Interviewer", type: "person" },
      { name: "Next interview", type: "date" },
      { name: "Notes", type: "text" },
    ],
    views: [
      { type: "board", name: "Stages", groupBy: "stage" },
      { type: "table", name: "Candidates", sort: "-rating" },
      {
        type: "metrics", name: "Funnel",
        metrics: [
          { label: "In process", op: "count", where: { stage: ["Applied", "Screen", "Interview", "Offer"] } },
          { label: "Offers out", op: "count", where: { stage: ["Offer"] } },
          { label: "Hired", op: "count", where: { stage: ["Hired"] } },
          { label: "Average rating", op: "avg", column: "rating" },
        ],
      },
    ],
    sample: [
      { Candidate: "Aiko Tanaka", Role: "Backend engineer", Stage: "Interview", Rating: 4 },
      { Candidate: "Ben Carter", Role: "Designer", Stage: "Screen", Rating: 3 },
    ],
  },
  invoices: {
    name: "Invoice tracker",
    icon: "🧾",
    description: "What is billed, what is paid, and what is overdue.",
    keywords: ["invoice", "invoices", "billing", "bill", "payment", "receivable", "請求", "請求書", "入金", "売掛", "支払"],
    columns: [
      { name: "Client", type: "text" },
      { name: "Invoice #", type: "text" },
      { name: "Amount", type: "number" },
      { name: "Issued", type: "date" },
      { name: "Due", type: "date" },
      { name: "Status", type: "select", options: ["Draft", "Sent", "Paid", "Overdue"] },
      { name: "Contact email", type: "email" },
      { name: "Owner", type: "person" },
    ],
    views: [
      { type: "table", name: "Open invoices", where: { status: ["Draft", "Sent", "Overdue"] }, sort: "due" },
      { type: "board", name: "By status", groupBy: "status" },
      {
        type: "metrics", name: "Summary",
        metrics: [
          { label: "Open invoices", op: "count", where: { status: ["Sent", "Overdue"] } },
          { label: "Outstanding", op: "sum", column: "amount", where: { status: ["Sent", "Overdue"] } },
          { label: "Overdue", op: "count", overdue: "due", where: { status: ["Sent", "Overdue"] } },
          { label: "Paid", op: "sum", column: "amount", where: { status: ["Paid"] } },
        ],
      },
    ],
    sample: [
      { Client: "Acme", "Invoice #": "INV-1001", Amount: 4800, Status: "Sent" },
      { Client: "Globex", "Invoice #": "INV-1002", Amount: 1250, Status: "Paid" },
    ],
  },
  tracker: {
    name: "Tracker",
    icon: "📋",
    description: "A list of things, who owns each, and where it stands.",
    keywords: [],
    columns: [
      { name: "Name", type: "text" },
      { name: "Status", type: "select", options: ["To do", "In progress", "Done"] },
      { name: "Owner", type: "person" },
      { name: "Due", type: "date" },
      { name: "Notes", type: "text" },
    ],
    views: [
      { type: "board", name: "Board", groupBy: "status" },
      { type: "table", name: "All", sort: "due" },
      {
        type: "metrics", name: "Summary",
        metrics: [
          { label: "Open", op: "count", where: { status: ["To do", "In progress"] } },
          { label: "Done", op: "count", where: { status: ["Done"] } },
          { label: "Overdue", op: "count", overdue: "due", where: { status: ["To do", "In progress"] } },
        ],
      },
    ],
    sample: [],
  },
};

/// The template a sentence asks for, or null. Plain keyword matching: it
/// costs nothing and works without a model.
export function matchTemplate(text) {
  const t = String(text || "").toLowerCase();
  let best = null;
  let bestScore = 0;
  for (const [id, template] of Object.entries(TEMPLATES)) {
    const score = template.keywords.filter((k) => t.includes(k)).length;
    if (score > bestScore) { best = id; bestScore = score; }
  }
  return best;
}

export const templateList = () => Object.entries(TEMPLATES).map(([id, t]) => ({ id, name: t.name, icon: t.icon, description: t.description }));
