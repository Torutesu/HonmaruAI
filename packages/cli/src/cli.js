import { createMcpClient } from "./client.js";

const HELP = `Honmaru workspace CLI

Usage:
  honmaru workspace tools [--json] [--api-url URL]
  honmaru workspace call <tool> [--args JSON] [--api-url URL]

Environment:
  HONMARU_API_URL       HTTPS API origin for your Honmaru workspace
  HONMARU_API_TOKEN     Active agent token created under Studio → API

The API enforces the token's scopes, workspace membership, and Simple/Harness
mode. The CLI does not save or print tokens. Tool calls can change workspace
data, so review the tool name and arguments before running them.
`;

function parseOptions(args, { allowArgs = false } = {}) {
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
    } else if (arg.startsWith("--")) {
      throw new Error(`Unknown option: ${arg}`);
    } else positional.push(arg);
  }
  return { options, positional };
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
    if (action === "--help" || action === "-h" || action === "help") {
      writeOut(HELP.trimEnd());
      return 0;
    }
    const { options, positional } = parseOptions(rest, { allowArgs: action === "call" });
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
    throw new Error(`Unknown workspace command: ${action || "(missing)"}. Run honmaru --help.`);
  } catch (error) {
    writeError(error instanceof Error ? error.message : "The command failed.");
    return 1;
  }
}
