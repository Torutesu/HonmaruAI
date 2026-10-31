import { createMcpClient } from "./client.js";

const HELP = `Honmaru workspace CLI

Usage:
  honmaru workspace tools [--json] [--api-url URL]
  honmaru workspace call <tool> [--args JSON] [--api-url URL]
  honmaru workspace app list
  honmaru workspace app read <app-id>
  honmaru workspace table list
  honmaru workspace row list <table-id> [--query TEXT] [--where JSON] [--sort FIELD] [--limit N] [--offset N]
  honmaru workspace row create <table-id> --values JSON
  honmaru workspace row update <table-id> <row-id> --values JSON [--expected-updated-at ISO]
  honmaru workspace workflow list
  honmaru workspace workflow run <workflow-id> [--text TEXT]
  honmaru workspace followup list [--room ROOM]
  honmaru workspace followup schedule --room ROOM --instruction TEXT --minutes N
  honmaru workspace file list --scope ROOM|all [--query TEXT] [--limit N]
  honmaru workspace file read <file-id> --version N
  honmaru workspace member list
  honmaru workspace playbook read
  honmaru workspace decision pending [--direction mine|sent]
  honmaru workspace decision read <card-id>
  honmaru workspace decision search <query>
  honmaru workspace decision request --title TEXT [--to PERSON] [--summary TEXT] [--context TEXT]

Environment:
  HONMARU_API_URL       HTTPS API origin for your Honmaru workspace
  HONMARU_API_TOKEN     Active agent token created under Studio → API

The API enforces the token's scopes, workspace membership, and Simple/Harness
mode. The CLI does not save or print tokens. Mutating commands can change
workspace data, so review the target and arguments before running them.
`;

const ALIAS_VALUE_FLAGS = new Set([
  "query", "where", "sort", "limit", "offset", "values", "expected-updated-at",
  "text", "room", "instruction", "minutes", "scope", "origin", "type", "created-by",
  "direction", "title", "to", "summary", "context", "priority",
  "since", "until", "directory", "order", "cursor", "version",
]);
const ALIAS_BOOLEAN_FLAGS = new Set(["direct-only", "include-deleted"]);

function parseOptions(args, { allowArgs = false, allowWorkspaceFlags = false } = {}) {
  const options = { json: false };
  const positional = [];
  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    if (arg === "--json") options.json = true;
    else if (arg === "--api-url") {
      if (!args[i + 1]) throw new Error("--api-url needs a value.");
      options.apiUrl = args[++i];
    } else if (arg === "--args" && allowArgs) {
      if (!args[i + 1]) throw new Error("--args needs a JSON object.");
      try { options.args = JSON.parse(args[++i]); }
      catch { throw new Error("--args must be valid JSON."); }
    } else if (allowWorkspaceFlags && ALIAS_VALUE_FLAGS.has(arg.slice(2)) && arg.startsWith("--")) {
      if (!args[i + 1] || args[i + 1].startsWith("--")) throw new Error(`${arg} needs a value.`);
      const key = arg.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
      options[key] = args[++i];
    } else if (allowWorkspaceFlags && ALIAS_BOOLEAN_FLAGS.has(arg.slice(2)) && arg.startsWith("--")) {
      const key = arg.slice(2).replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
      options[key] = true;
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else positional.push(arg);
  }
  return { options, positional };
}

function objectOption(options, key, fallback = undefined) {
  if (options[key] === undefined) return fallback;
  let value;
  try { value = JSON.parse(options[key]); }
  catch { throw new Error(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} must be valid JSON.`); }
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} must be a JSON object.`);
  }
  return value;
}

function integerOption(options, key, { min = 0, max = Number.MAX_SAFE_INTEGER, required = false } = {}) {
  const raw = options[key];
  if (raw === undefined) {
    if (required) throw new Error(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required.`);
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw new Error(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} must be an integer from ${min} to ${max}.`);
  }
  return value;
}

function numberOption(options, key, { min = 0, max = Number.MAX_VALUE, required = false } = {}) {
  const raw = options[key];
  if (raw === undefined) {
    if (required) throw new Error(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required.`);
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isFinite(value) || value < min || value > max) {
    throw new Error(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} must be a number from ${min} to ${max}.`);
  }
  return value;
}

function onlyFlags(options, allowed) {
  for (const key of Object.keys(options)) {
    if (!["json", "apiUrl", ...allowed].includes(key)) throw new Error(`Unknown option for this command: --${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)}.`);
  }
}

function positionalCount(positional, exact, usage) {
  if (positional.length !== exact) throw new Error(`Usage: ${usage}`);
}

function resolveWorkspaceCommand(resource, operation, positional, options) {
  const pair = `${resource || ""} ${operation || ""}`.trim();
  switch (pair) {
    case "app list":
      onlyFlags(options, []); positionalCount(positional, 0, "honmaru workspace app list");
      return { tool: "list_apps", args: {} };
    case "app read":
    case "app show":
      onlyFlags(options, []); positionalCount(positional, 1, `honmaru workspace app ${operation} <app-id>`);
      return { tool: "read_app", args: { appId: positional[0] } };
    case "table list":
      onlyFlags(options, []); positionalCount(positional, 0, "honmaru workspace table list");
      return { tool: "list_tables", args: {} };
    case "row list": {
      onlyFlags(options, ["query", "where", "sort", "limit", "offset"]); positionalCount(positional, 1, "honmaru workspace row list <table-id> [options]");
      const args = { tableId: positional[0] };
      if (options.query !== undefined) args.q = options.query;
      if (options.where !== undefined) args.where = objectOption(options, "where");
      if (options.sort !== undefined) args.sort = options.sort;
      const limit = integerOption(options, "limit", { min: 1, max: 500 });
      const offset = integerOption(options, "offset", { min: 0, max: 5000 });
      if (limit !== undefined) args.limit = limit;
      if (offset !== undefined) args.offset = offset;
      return { tool: "query_rows", args };
    }
    case "row create":
    case "row add": {
      onlyFlags(options, ["values"]); positionalCount(positional, 1, `honmaru workspace row ${operation} <table-id> --values JSON`);
      if (options.values === undefined) throw new Error("--values is required.");
      return { tool: "add_row", args: { tableId: positional[0], values: objectOption(options, "values") } };
    }
    case "row update": {
      onlyFlags(options, ["values", "expectedUpdatedAt"]); positionalCount(positional, 2, "honmaru workspace row update <table-id> <row-id> --values JSON [--expected-updated-at ISO]");
      if (options.values === undefined) throw new Error("--values is required.");
      const args = { tableId: positional[0], rowId: positional[1], values: objectOption(options, "values") };
      if (options.expectedUpdatedAt !== undefined) args.expectedUpdatedAt = options.expectedUpdatedAt;
      return { tool: "update_row", args };
    }
    case "workflow list":
      onlyFlags(options, []); positionalCount(positional, 0, "honmaru workspace workflow list");
      return { tool: "list_workflows", args: {} };
    case "workflow run": {
      onlyFlags(options, ["text"]); positionalCount(positional, 1, "honmaru workspace workflow run <workflow-id> [--text TEXT]");
      const args = { workflowId: positional[0] };
      if (options.text !== undefined) args.text = options.text;
      return { tool: "run_workflow", args };
    }
    case "followup list":
      onlyFlags(options, ["room"]); positionalCount(positional, 0, "honmaru workspace followup list [--room ROOM]");
      return { tool: "list_followups", args: options.room === undefined ? {} : { channel: options.room } };
    case "followup schedule": {
      onlyFlags(options, ["room", "instruction", "minutes"]); positionalCount(positional, 0, "honmaru workspace followup schedule --room ROOM --instruction TEXT --minutes N");
      for (const key of ["room", "instruction"]) if (!options[key]) throw new Error(`--${key} is required.`);
      const minutes = numberOption(options, "minutes", { min: 0.01, max: 525600, required: true });
      return { tool: "schedule_followup", args: { channel: options.room, instruction: options.instruction, minutes } };
    }
    case "file list": {
      onlyFlags(options, ["scope", "query", "origin", "type", "createdBy", "since", "until", "directory", "directOnly", "includeDeleted", "order", "cursor", "limit"]);
      positionalCount(positional, 0, "honmaru workspace file list --scope ROOM|all [options]");
      if (!options.scope) throw new Error("--scope is required; use an accessible room key or all.");
      const args = { scope: options.scope };
      for (const key of ["query", "origin", "type", "since", "until", "directory", "order"]) if (options[key] !== undefined) args[key === "query" ? "query" : key] = options[key];
      if (options.createdBy !== undefined) args.createdBy = options.createdBy;
      if (options.directOnly !== undefined) args.directOnly = options.directOnly;
      if (options.includeDeleted !== undefined) args.includeDeleted = options.includeDeleted;
      if (options.cursor !== undefined) args.cursor = objectOption(options, "cursor");
      const limit = integerOption(options, "limit", { min: 1, max: 100 });
      if (limit !== undefined) args.limit = limit;
      return { tool: "list_workspace_files", args };
    }
    case "file read": {
      onlyFlags(options, ["version"]); positionalCount(positional, 1, "honmaru workspace file read <file-id> --version N");
      const version = integerOption(options, "version", { min: 1, required: true });
      return { tool: "read_file_text", args: { fileId: positional[0], version } };
    }
    case "member list":
      onlyFlags(options, []); positionalCount(positional, 0, "honmaru workspace member list");
      return { tool: "list_members", args: {} };
    case "playbook read":
      onlyFlags(options, []); positionalCount(positional, 0, "honmaru workspace playbook read");
      return { tool: "get_playbook", args: {} };
    case "decision pending": {
      onlyFlags(options, ["direction"]); positionalCount(positional, 0, "honmaru workspace decision pending [--direction mine|sent]");
      if (options.direction !== undefined && !["mine", "sent"].includes(options.direction)) throw new Error("--direction must be mine or sent.");
      return { tool: "list_pending", args: options.direction === undefined ? {} : { direction: options.direction } };
    }
    case "decision read":
      onlyFlags(options, []); positionalCount(positional, 1, "honmaru workspace decision read <card-id>");
      return { tool: "get_decision", args: { cardId: positional[0] } };
    case "decision search": {
      onlyFlags(options, ["query"]);
      if (positional.length > 1 || (positional.length === 1 && options.query !== undefined)) throw new Error("Usage: honmaru workspace decision search <query>");
      const query = positional[0] ?? options.query;
      if (!query?.trim()) throw new Error("A search query is required.");
      return { tool: "search_decisions", args: { query } };
    }
    case "decision request": {
      onlyFlags(options, ["title", "to", "summary", "context", "priority", "type"]);
      positionalCount(positional, 0, "honmaru workspace decision request --title TEXT [options]");
      if (!options.title?.trim()) throw new Error("--title is required.");
      if (options.title.length > 120) throw new Error("--title must be 120 characters or fewer.");
      if (options.summary !== undefined && options.summary.length > 600) throw new Error("--summary must be 600 characters or fewer.");
      if (options.context !== undefined && options.context.length > 3000) throw new Error("--context must be 3000 characters or fewer.");
      if (options.priority !== undefined && !["low", "medium", "high", "urgent"].includes(options.priority)) throw new Error("--priority must be low, medium, high, or urgent.");
      if (options.type !== undefined && !["approval", "task", "delegation", "notification"].includes(options.type)) throw new Error("--type must be approval, task, delegation, or notification.");
      const args = { title: options.title };
      for (const key of ["to", "summary", "context", "priority", "type"]) if (options[key] !== undefined) args[key] = options[key];
      return { tool: "request_decision", args };
    }
    default:
      throw new Error(`Unknown workspace command: ${pair || "(missing)"}. Run honmaru workspace help.`);
  }
}

function formatWorkspaceResult(result, json) {
  const value = result?.structuredContent ?? result;
  if (json || !value || typeof value !== "object") return JSON.stringify(value, null, 2);
  if (Array.isArray(value.apps)) return value.apps.length ? value.apps.map((app) => `${app.id}\t${app.name}${app.tableId ? `\t${app.tableId}` : ""}`).join("\n") : "No apps are available.";
  if (Array.isArray(value.tables)) return value.tables.length ? value.tables.map((table) => `${table.id}\t${table.name}\t${(table.columns || []).map((column) => column.name).join(", ")}`).join("\n") : "No tables are available.";
  if (Array.isArray(value.rows)) return value.rows.length ? value.rows.map((row) => `${row.id}\t${JSON.stringify(row)}`).join("\n") : `No rows found (total ${value.total ?? 0}).`;
  if (Array.isArray(value.files)) return value.files.length ? value.files.map((file) => `${file.id}\t${file.path || file.name || "(unnamed)"}`).join("\n") : "No files found.";
  if (Array.isArray(value.members)) return value.members.length ? value.members.map((member) => `${member.name}${member.title ? `\t${member.title}` : ""}`).join("\n") : "No members found.";
  if (Array.isArray(value.rules)) return value.rules.length ? value.rules.map((rule, index) => `${index + 1}. ${rule}`).join("\n") : "The playbook is empty.";
  if (Array.isArray(value.decisions)) return value.decisions.length ? value.decisions.map((decision) => `${decision.cardId}\t${decision.status}\t${decision.title}`).join("\n") : "No decisions found.";
  return JSON.stringify(value, null, 2);
}

function formatTools(tools) {
  if (!tools.length) return "No tools are available to this token. Check its scopes and the workspace mode.";
  return tools.map((tool) => {
    const title = tool.title ? ` — ${tool.title}` : "";
    const description = tool.description ? `\n  ${tool.description}` : "";
    return `${tool.name}${title}${description}`;
  }).join("\n");
}

export async function runCli(argv, { env = process.env, fetcher = fetch, stdout = process.stdout, stderr = process.stderr } = {}) {
  const writeOut = (value) => stdout.write(`${value}\n`);
  const writeError = (value) => stderr.write(`honmaru: ${value}\n`);
  const [root, action, ...rest] = argv;
  if (!root || root === "--help" || root === "-h" || root === "help") {
    writeOut(HELP.trimEnd());
    return 0;
  }
  if (root !== "workspace") {
    writeError(`Unknown command: ${root}. Run honmaru --help.`);
    return 2;
  }

  try {
    if (rest.includes("--help") || rest.includes("-h")) {
      writeOut(HELP.trimEnd());
      return 0;
    }
    if (action === "--help" || action === "-h" || action === "help") {
      writeOut(HELP.trimEnd());
      return 0;
    }
    const aliasMode = !["tools", "call"].includes(action);
    const { options, positional } = parseOptions(rest, { allowArgs: action === "call", allowWorkspaceFlags: aliasMode });
    const apiUrl = options.apiUrl || env.HONMARU_API_URL;
    const token = env.HONMARU_API_TOKEN;
    const client = createMcpClient({ apiUrl, token, fetcher });

    if (action === "tools") {
      if (positional.length) throw new Error("Usage: honmaru workspace tools [--json] [--api-url URL].");
      const tools = await client.listTools();
      writeOut(options.json ? JSON.stringify({ tools }, null, 2) : formatTools(tools));
      return 0;
    }
    if (action === "call") {
      if (positional.length !== 1) throw new Error("Usage: honmaru workspace call <tool> [--args JSON] [--api-url URL].");
      const result = await client.callTool(positional[0], options.args ?? {});
      writeOut(JSON.stringify(result, null, 2));
      return 0;
    }
    if (!aliasMode) throw new Error(`Unknown workspace command: ${action || "(missing)"}. Run honmaru --help.`);
    const [resource, operation, ...commandArgs] = [action, positional[0], ...positional.slice(1)];
    const command = resolveWorkspaceCommand(resource, operation, commandArgs, options);
    const result = await client.callTool(command.tool, command.args);
    writeOut(formatWorkspaceResult(result, options.json));
    return 0;
  } catch (error) {
    writeError(error instanceof Error ? error.message : "The command failed.");
    return 1;
  }
}
