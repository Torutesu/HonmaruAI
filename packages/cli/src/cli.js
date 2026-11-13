import { createMcpClient, mcpEndpoint } from "./client.js";
import { formatGatewayStatus, getGatewayStatus, runGatewayForeground } from "./gateway.js";
import { readFile, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { createHash } from "node:crypto";
import { generateTableSdk } from "./sdk.js";

const HELP = `Honmaru workspace CLI

Usage:
  honmaru workspace tools [--json] [--api-url URL]
  honmaru workspace call <tool> [--args JSON] [--api-url URL]
  honmaru workspace app list
  honmaru workspace app read <app-id>
  honmaru workspace app action list [<app-id>]
  honmaru workspace app action run <app-id> <name> --version N --gateway-id NODE --request-id ID --input JSON
  honmaru workspace app action read <app-id> <job-id>
  honmaru workspace room discover [--query TEXT] [--limit N] [--offset N] [--joined]
  honmaru workspace room join <room-id>
  honmaru workspace room leave <room-id>
  honmaru workspace room list [--query TEXT] [--type channel|dm|group] [--limit N] [--cursor CURSOR] [--archived]
  honmaru workspace room mute|unmute <room-id>
  honmaru workspace room reorder --rooms ROOM,ROOM,...
  honmaru workspace room member list <room-id>
  honmaru workspace room member add|remove <room-id> --members REF,REF [--relation admin|member]
  honmaru workspace room agent access <room-id> <agent-id>
  honmaru workspace room agent add <room-id> <agent-id> [--grant-access | --grant-access-members REF,REF] [--acknowledge-external-processing]
  honmaru workspace room agent remove <room-id> <agent-id>
  honmaru workspace room get <room-id>
  honmaru workspace room update <room-id> [--name NAME] [--mentioned-only true|false] [--main-agent ID|auto] [--icon-color COLOR]
  honmaru workspace room visibility set <room-id> --scope public|private --version N
  honmaru workspace room guidelines get <room-id>
  honmaru workspace room guidelines set <room-id> --body TEXT --version N
  honmaru workspace room rename <room-id> --name NAME
  honmaru workspace room archive <room-id>
  honmaru workspace room unarchive <room-id>
  honmaru workspace room create --name NAME --scope public|private --request-id ID [--members REF,REF]
  honmaru workspace room read <room-id> [--limit N] [--cursor CURSOR]
  honmaru workspace message search <query> [--limit N] [--cursor CURSOR]
  honmaru workspace message get <message-id>
  honmaru workspace message send --room ROOM --text TEXT --request-id ID [--thread ROOT] [--reply-to MESSAGE]
  honmaru workspace reaction get <message-id>
  honmaru workspace reaction add <message-id> --emoji EMOJI
  honmaru workspace reaction remove <message-id> --emoji EMOJI
  honmaru workspace thread get <room-id> <root-id> [--limit N] [--cursor CURSOR]
  honmaru workspace thread msg <room-id> <root-id> --text TEXT --request-id ID [--reply-to MESSAGE]
  honmaru workspace thread rename <room-id> <root-id> --title TITLE --version N
  honmaru workspace thread mute|unmute <room-id> <root-id>
  honmaru workspace thread pin|unpin <room-id> <root-id>
  honmaru workspace table list
  honmaru workspace sdk generate <table-id> --out <file.ts>
  honmaru workspace row list <table-id> [--query TEXT] [--where JSON] [--sort FIELD] [--limit N] [--offset N]
  honmaru workspace row create <table-id> --values JSON
  honmaru workspace row update <table-id> <row-id> --values JSON [--expected-updated-at ISO]
  honmaru workspace workflow list
  honmaru workspace workflow show <workflow-id>
  honmaru workspace workflow create --name NAME --trigger JSON --steps JSON --draft
  honmaru workspace workflow update <workflow-id> --expected-updated-at ISO [--name NAME] [--trigger JSON] [--steps JSON]
  honmaru workspace workflow pause <workflow-id> --expected-updated-at ISO
  honmaru workspace workflow run <workflow-id> [--text TEXT]
  honmaru workspace workflow runs <workflow-id> [--limit N]
  honmaru workspace workflow run-detail <workflow-id> <run-id>
  honmaru workspace workflow cancel <workflow-id> <run-id> --expected-started-at ISO
  honmaru workspace workflow revisions <workflow-id> [--before N]
  honmaru workspace workflow restore <workflow-id> --revision N --expected-updated-at ISO [--confirm-auto-paused]
  honmaru workspace workflow resume <workflow-id> --generation TOKEN
  honmaru workspace workflow recover <workflow-id> <run-id> --expected-started-at ISO --confirm-no-replay
  honmaru workspace workflow held-events <workflow-id> [--offset N]
  honmaru workspace workflow held-event <workflow-id> <event-id>
  honmaru workspace workflow discard-held|replay-held <workflow-id> --event-ids ID,ID
  honmaru workspace workflow webhook-rotate|webhook-revoke <workflow-id> --expected-updated-at ISO [--expected-secret-env ENV_NAME]
  honmaru workspace followup list [--room ROOM]
  honmaru workspace followup schedule --room ROOM --instruction TEXT --minutes N
  honmaru workspace file list --scope ROOM|all [--query TEXT] [--limit N]
  honmaru workspace folders list --scope ROOM [--directory PATH] [--origin human|agent|unknown] [--limit N]
  honmaru workspace file read <file-id> --version N
  honmaru workspace file upload --scope ROOM --path REMOTE_PATH --source LOCAL_PATH --request-id file-UUID [--content-type MIME]
  honmaru workspace file copy <file-id> --scope ROOM --path REMOTE_PATH --request-id file-UUID [--version N]
  honmaru workspace file download <file-id> [--version N] [--output PATH | --dir DIRECTORY] [--force]
  honmaru workspace file versions <file-id> [--before N] [--limit N]
  honmaru workspace file create --scope ROOM --path PATH --request-id file-UUID --text TEXT --content-type MIME
  honmaru workspace file update <file-id> --expected-version N --text TEXT
  honmaru workspace file delete <file-id> --expected-version N
  honmaru workspace file revert <file-id> --version N --expected-version N
  honmaru workspace file share request <file-id> --version N --request-id share-UUID [--expires-in 86400|604800|2592000] [--allow-download]
  honmaru workspace file share requests [--file-id FILE_ID]
  honmaru workspace member list
  honmaru workspace playbook read
  honmaru workspace decision pending [--direction mine|sent]
  honmaru workspace decision read <card-id>
  honmaru workspace decision search <query>
  honmaru workspace decision request --title TEXT [--to PERSON] [--summary TEXT] [--context TEXT]
  honmaru workspace execution node list
  honmaru workspace execution run --gateway-id NODE --request-id ID --code JS --input JSON
  honmaru workspace execution read <job-id>
  honmaru workspace execution cancel <job-id>

Environment:
  HONMARU_API_URL       HTTPS API origin for your Honmaru workspace
  HONMARU_API_TOKEN     Active agent token created under Studio → API

The API enforces the token's scopes, workspace membership, and Simple/Harness
mode. The CLI does not save or print tokens. Mutating commands can change
workspace data, so review the target and arguments before running them.
`;

const GATEWAY_HELP = `Honmaru local execution gateway

Usage:
  honmaru gateway status [--json]
  honmaru gateway run

Environment:
  HONMARU_API_URL          HTTPS API origin for your Honmaru workspace
  HONMARU_GATEWAY_TOKEN    Node token created under Studio → Harness → Execution nodes

The gateway polls for isolated jobs and connects outbound. It does not open an
inbound port. Stop it with Ctrl+C. Do not pass the node token as a command-line
argument.

The status command reports the macOS LaunchAgent state without reading or printing credentials.
`;

const ALIAS_VALUE_FLAGS = new Set([
  "query", "where", "sort", "limit", "offset", "values", "expected-updated-at",
  "text", "body", "room", "rooms", "instruction", "minutes", "scope", "origin", "type", "created-by", "mentioned-only", "main-agent", "icon-color", "relation",
  "direction", "title", "name", "members", "grant-access-members", "to", "summary", "context", "priority",
  "since", "until", "directory", "order", "cursor", "version", "before", "offset", "trigger", "steps",
  "gateway-id", "request-id", "code", "input", "app-id", "out", "output", "dir", "expected-started-at", "expected-updated-at", "expected-secret", "expected-secret-env", "event-ids", "generation", "revision",
  "path", "content-type", "expected-version", "thread", "reply-to", "file-ids", "emoji", "source", "expires-in", "file-id",
]);
const ALIAS_BOOLEAN_FLAGS = new Set(["direct-only", "include-deleted", "force", "joined", "archived", "confirm-auto-paused", "confirm-no-replay", "draft", "allow-download", "grant-access", "acknowledge-external-processing"]);

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

function jsonValueOption(options, key) {
  if (options[key] === undefined) return undefined;
  try { return JSON.parse(options[key]); }
  catch { throw new Error(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} must be valid JSON.`); }
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

function resolveWorkspaceCommand(resource, operation, positional, options, env = process.env) {
  const pair = `${resource || ""} ${operation || ""}`.trim();
  switch (pair) {
    case "room list": {
      onlyFlags(options, ["query", "type", "cursor", "limit", "archived"]); positionalCount(positional, 0, "honmaru workspace room list [--archived] [options]");
      if (options.archived) {
        if (options.type !== undefined || options.cursor !== undefined) throw new Error("--type and --cursor cannot be combined with --archived.");
        const args = {};
        if (options.query !== undefined) args.query = options.query;
        const limit = integerOption(options, "limit", { min: 1, max: 50 });
        if (limit !== undefined) args.limit = limit;
        return { tool: "list_archived_rooms", args };
      }
      if (options.type !== undefined && !["channel", "dm", "group"].includes(options.type)) throw new Error("--type must be channel, dm, or group.");
      const args = {};
      for (const key of ["query", "type", "cursor"]) if (options[key] !== undefined) args[key] = options[key];
      const limit = integerOption(options, "limit", { min: 1, max: 50 });
      if (limit !== undefined) args.limit = limit;
      return { tool: "list_conversations", args };
    }
    case "room discover": {
      onlyFlags(options, ["query", "limit", "offset", "joined"]); positionalCount(positional, 0, "honmaru workspace room discover [--query TEXT] [--limit N] [--offset N] [--joined]");
      const args = {};
      if (options.query !== undefined) args.query = options.query;
      const limit = integerOption(options, "limit", { min: 1, max: 50 });
      const offset = integerOption(options, "offset", { min: 0, max: 10000 });
      if (limit !== undefined) args.limit = limit;
      if (offset !== undefined) args.offset = offset;
      if (options.joined) args.joined = true;
      return { tool: "discover_public_rooms", args };
    }
    case "room join":
    case "room leave":
      onlyFlags(options, []); positionalCount(positional, 1, `honmaru workspace room ${operation} <room-id>`);
      return { tool: operation === "join" ? "join_public_room" : "leave_public_room", args: { conversationId: positional[0] } };
    case "room mute":
    case "room unmute":
      onlyFlags(options, []); positionalCount(positional, 1, `honmaru workspace room ${operation} <room-id>`);
      return { tool: "set_room_muted", args: { conversationId: positional[0], muted: operation === "mute" } };
    case "room reorder": {
      onlyFlags(options, ["rooms"]); positionalCount(positional, 0, "honmaru workspace room reorder --rooms ROOM,ROOM,...");
      if (typeof options.rooms !== "string" || !options.rooms.trim()) throw new Error("--rooms is required.");
      const conversationIds = [...new Set(options.rooms.split(",").map(value => value.trim()).filter(Boolean))];
      if (!conversationIds.length || conversationIds.length > 200) throw new Error("--rooms needs 1 to 200 unique room IDs.");
      if (conversationIds.length !== options.rooms.split(",").map(value => value.trim()).filter(Boolean).length) throw new Error("--rooms cannot contain duplicate room IDs.");
      return { tool: "reorder_rooms", args: { conversationIds } };
    }
    case "room member": {
      const [action, ...target] = positional;
      if (action === "list") {
        onlyFlags(options, []); positionalCount(target, 1, "honmaru workspace room member list <room-id>");
        return { tool: "list_room_members", args: { conversationId: target[0] } };
      }
      if (action === "add" || action === "remove") {
        onlyFlags(options, action === "add" ? ["members", "relation"] : ["members"]);
        positionalCount(target, 1, `honmaru workspace room member ${action} <room-id> --members REF,REF`);
        if (typeof options.members !== "string" || !options.members.trim()) throw new Error("--members is required.");
        const memberRefs = options.members.split(",").map(value => value.trim()).filter(Boolean);
        if (!memberRefs.length || memberRefs.length > 100) throw new Error("--members needs 1 to 100 member references.");
        if (new Set(memberRefs).size !== memberRefs.length) throw new Error("--members cannot contain duplicate references.");
        if (action === "add" && options.relation !== undefined && !["admin", "member"].includes(options.relation)) throw new Error("--relation must be admin or member.");
        const args = { conversationId: target[0], memberRefs };
        if (action === "add" && options.relation !== undefined) args.relation = options.relation;
        return { tool: action === "add" ? "add_room_members" : "remove_room_members", args };
      }
      throw new Error("Usage: honmaru workspace room member list|add|remove.");
    }
    case "room agent": {
      const [action, ...target] = positional;
      if (action === "access") {
        onlyFlags(options, []); positionalCount(target, 2, "honmaru workspace room agent access <room-id> <agent-id>");
        return { tool: "get_room_agent_access", args: { conversationId: target[0], agentId: target[1] } };
      }
      if (action === "add") {
        onlyFlags(options, ["grantAccess", "grantAccessMembers", "acknowledgeExternalProcessing"]); positionalCount(target, 2, "honmaru workspace room agent add <room-id> <agent-id> [--grant-access | --grant-access-members REF,REF] [--acknowledge-external-processing]");
        if (options.grantAccess === true && options.grantAccessMembers !== undefined) throw new Error("Choose either --grant-access or --grant-access-members, not both.");
        const args = { conversationId: target[0], agentId: target[1] };
        if (options.grantAccess === true) args.grantAccess = true;
        if (options.grantAccessMembers !== undefined) {
          if (typeof options.grantAccessMembers !== "string" || !options.grantAccessMembers.trim()) throw new Error("--grant-access-members needs 1 to 100 member references.");
          const grantAccessMemberRefs = options.grantAccessMembers.split(",").map(value => value.trim()).filter(Boolean);
          if (!grantAccessMemberRefs.length || grantAccessMemberRefs.length > 100) throw new Error("--grant-access-members needs 1 to 100 member references.");
          if (new Set(grantAccessMemberRefs).size !== grantAccessMemberRefs.length) throw new Error("--grant-access-members cannot contain duplicate references.");
          args.grantAccessMemberRefs = grantAccessMemberRefs;
        }
        if (options.acknowledgeExternalProcessing === true) args.acknowledgeExternalProcessing = true;
        return { tool: "add_room_agent", args };
      }
      if (action === "remove") {
        onlyFlags(options, []); positionalCount(target, 2, "honmaru workspace room agent remove <room-id> <agent-id>");
        return { tool: "remove_room_agent", args: { conversationId: target[0], agentId: target[1] } };
      }
      throw new Error("Usage: honmaru workspace room agent add|remove <room-id> <agent-id>.");
    }
    case "room rename":
      onlyFlags(options, ["name"]); positionalCount(positional, 1, "honmaru workspace room rename <room-id> --name NAME");
      if (typeof options.name !== "string" || !options.name.trim()) throw new Error("--name is required.");
      if (options.name.trim().length > 120) throw new Error("--name must be at most 120 characters.");
      return { tool: "rename_room", args: { conversationId: positional[0], name: options.name.trim() } };
    case "room get":
      onlyFlags(options, []); positionalCount(positional, 1, "honmaru workspace room get <room-id>");
      return { tool: "get_room_settings", args: { conversationId: positional[0] } };
    case "room visibility": {
      const [action, ...target] = positional;
      if (action !== "set") throw new Error("Usage: honmaru workspace room visibility set <room-id> --scope public|private --version N.");
      onlyFlags(options, ["scope", "version"]); positionalCount(target, 1, "honmaru workspace room visibility set <room-id> --scope public|private --version N");
      if (!["public", "private"].includes(options.scope)) throw new Error("--scope must be public or private.");
      const version = integerOption(options, "version", { min: 1, required: true });
      return { tool: "set_room_privacy", args: { conversationId: target[0], scope: options.scope, version } };
    }
    case "room update": {
      onlyFlags(options, ["name", "mentionedOnly", "mainAgent", "iconColor"]); positionalCount(positional, 1, "honmaru workspace room update <room-id> [--name NAME] [--mentioned-only true|false] [--main-agent ID|auto] [--icon-color COLOR]");
      const args = { conversationId: positional[0] };
      if (options.name !== undefined) {
        if (!options.name.trim()) throw new Error("--name cannot be empty.");
        args.name = options.name.trim();
      }
      if (options.mentionedOnly !== undefined) {
        if (!["true", "false"].includes(options.mentionedOnly)) throw new Error("--mentioned-only must be true or false.");
        args.mentionedOnly = options.mentionedOnly === "true";
      }
      if (options.mainAgent !== undefined) args.defaultAgentId = options.mainAgent === "auto" ? null : options.mainAgent;
      if (options.iconColor !== undefined) {
        const colors = ["rose", "orange", "yellow", "green", "teal", "cyan", "blue", "indigo", "purple", "pink", "olive", "red", "gray", "lake"];
        if (!colors.includes(options.iconColor)) throw new Error(`--icon-color must be one of ${colors.join(", ")}.`);
        args.color = options.iconColor === "cyan" ? "lake" : options.iconColor;
      }
      if (Object.keys(args).length === 1) throw new Error("Provide at least one Room setting to update.");
      return { tool: "update_room_settings", args };
    }
    case "room guidelines": {
      const [action, ...target] = positional;
      if (action === "get") {
        onlyFlags(options, []); positionalCount(target, 1, "honmaru workspace room guidelines get <room-id>");
        return { tool: "get_room_guidelines", args: { conversationId: target[0] } };
      }
      if (action === "set") {
        onlyFlags(options, ["body", "version"]); positionalCount(target, 1, "honmaru workspace room guidelines set <room-id> --body TEXT --version N");
        if (typeof options.body !== "string") throw new Error("--body is required (use an empty quoted string to clear the guidelines).");
        if (options.body.length > 4096) throw new Error("--body must be at most 4096 characters.");
        const version = integerOption(options, "version", { min: 0, required: true });
        return { tool: "update_room_guidelines", args: { conversationId: target[0], body: options.body, version } };
      }
      throw new Error("Usage: honmaru workspace room guidelines get|set.");
    }
    case "room archive":
    case "room unarchive":
      onlyFlags(options, []); positionalCount(positional, 1, `honmaru workspace room ${operation} <room-id>`);
      return { tool: operation === "archive" ? "archive_room" : "unarchive_room", args: { conversationId: positional[0] } };
    case "room create": {
      onlyFlags(options, ["name", "scope", "requestId", "members"]); positionalCount(positional, 0, "honmaru workspace room create --name NAME --scope public|private --request-id ID [--members REF,REF]");
      if (!options.name?.trim()) throw new Error("--name is required.");
      if (!["public", "private"].includes(options.scope)) throw new Error("--scope must be public or private.");
      if (typeof options.requestId !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(options.requestId)) throw new Error("--request-id must be 8 to 100 letters, numbers, underscores or hyphens; reuse it only for the identical retry.");
      const memberRefs = options.members === undefined ? [] : [...new Set(options.members.split(",").map(value => value.trim()).filter(Boolean))];
      if (memberRefs.length > 200) throw new Error("--members accepts at most 200 member references.");
      return { tool: "create_conversation", args: { type: "channel", name: options.name, private: options.scope === "private", memberRefs, requestId: options.requestId } };
    }
    case "room read": {
      onlyFlags(options, ["limit", "cursor"]); positionalCount(positional, 1, "honmaru workspace room read <room-id> [--limit N] [--cursor CURSOR]");
      const args = { conversationId: positional[0] };
      const limit = integerOption(options, "limit", { min: 1, max: 50 });
      if (limit !== undefined) args.limit = limit;
      if (options.cursor !== undefined) args.cursor = options.cursor;
      return { tool: "read_channel", args };
    }
    case "message search": {
      onlyFlags(options, ["limit", "cursor"]); positionalCount(positional, 1, "honmaru workspace message search <query> [--limit N] [--cursor CURSOR]");
      const args = { query: positional[0] };
      const limit = integerOption(options, "limit", { min: 1, max: 50 });
      if (limit !== undefined) args.limit = limit;
      if (options.cursor !== undefined) args.cursor = options.cursor;
      return { tool: "search_messages", args };
    }
    case "message get":
      onlyFlags(options, []); positionalCount(positional, 1, "honmaru workspace message get <message-id>");
      return { tool: "get_message", args: { messageId: positional[0] } };
    case "message send": {
      onlyFlags(options, ["room", "text", "requestId", "thread", "replyTo", "fileIds"]); positionalCount(positional, 0, "honmaru workspace message send --room ROOM --text TEXT --request-id ID [--thread ROOT] [--reply-to MESSAGE]");
      for (const key of ["room", "text"]) if (typeof options[key] !== "string" || !options[key].trim()) throw new Error(`--${key} is required.`);
      if (typeof options.requestId !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(options.requestId)) throw new Error("--request-id must be 8 to 100 letters, numbers, underscores or hyphens; reuse it only for the identical retry.");
      const args = { conversationId: options.room, body: options.text, requestId: options.requestId };
      if (options.thread !== undefined) args.threadId = options.thread;
      if (options.replyTo !== undefined) args.replyToMessageId = options.replyTo;
      if (options.fileIds !== undefined) args.fileIds = [...new Set(options.fileIds.split(",").map(value => value.trim()).filter(Boolean))];
      if (args.fileIds?.length > 10) throw new Error("--file-ids accepts at most 10 file IDs.");
      return { tool: "send_message", args };
    }
    case "thread get": {
      onlyFlags(options, ["limit", "cursor"]); positionalCount(positional, 2, "honmaru workspace thread get <room-id> <root-id> [--limit N] [--cursor CURSOR]");
      const args = { conversationId: positional[0], threadId: positional[1] };
      const limit = integerOption(options, "limit", { min: 1, max: 50 });
      if (limit !== undefined) args.limit = limit;
      if (options.cursor !== undefined) args.cursor = options.cursor;
      return { tool: "read_thread", args };
    }
    case "thread msg": {
      onlyFlags(options, ["text", "requestId", "replyTo", "fileIds"]); positionalCount(positional, 2, "honmaru workspace thread msg <room-id> <root-id> --text TEXT --request-id ID [--reply-to MESSAGE]");
      if (typeof options.text !== "string" || !options.text.trim()) throw new Error("--text is required.");
      if (typeof options.requestId !== "string" || !/^[A-Za-z0-9_-]{8,100}$/.test(options.requestId)) throw new Error("--request-id must be 8 to 100 letters, numbers, underscores or hyphens; reuse it only for the identical retry.");
      const args = { conversationId: positional[0], threadId: positional[1], body: options.text, requestId: options.requestId };
      if (options.replyTo !== undefined) args.replyToMessageId = options.replyTo;
      if (options.fileIds !== undefined) args.fileIds = [...new Set(options.fileIds.split(",").map(value => value.trim()).filter(Boolean))];
      if (args.fileIds?.length > 10) throw new Error("--file-ids accepts at most 10 file IDs.");
      return { tool: "send_message", args };
    }
    case "thread rename": {
      onlyFlags(options, ["title", "version"]); positionalCount(positional, 2, "honmaru workspace thread rename <room-id> <root-id> --title TITLE --version N");
      if (typeof options.title !== "string" || !options.title.trim()) throw new Error("--title is required.");
      const version = integerOption(options, "version", { min: 0, max: 2147483647 });
      if (version === undefined) throw new Error("--version is required; use 0 for a thread without a custom title.");
      return { tool: "rename_thread", args: { conversationId: positional[0], threadId: positional[1], title: options.title.trim(), version } };
    }
    case "thread mute":
    case "thread unmute":
    case "thread pin":
    case "thread unpin": {
      onlyFlags(options, []); positionalCount(positional, 2, `honmaru workspace thread ${operation} <room-id> <root-id>`);
      if (operation === "mute" || operation === "unmute") return { tool: "set_thread_muted", args: { conversationId: positional[0], threadId: positional[1], muted: operation === "mute" } };
      return { tool: "set_thread_pin", args: { conversationId: positional[0], threadId: positional[1], pinned: operation === "pin" } };
    }
    case "reaction get":
      onlyFlags(options, []); positionalCount(positional, 1, "honmaru workspace reaction get <message-id>");
      return { tool: "get_reactions", args: { messageId: positional[0] } };
    case "reaction add":
    case "reaction remove":
      onlyFlags(options, ["emoji"]); positionalCount(positional, 1, `honmaru workspace reaction ${operation} <message-id> --emoji EMOJI`);
      if (typeof options.emoji !== "string" || !options.emoji.trim()) throw new Error("--emoji is required.");
      return { tool: operation === "add" ? "add_reaction" : "remove_reaction", args: { messageId: positional[0], emoji: options.emoji } };
    case "app list":
      onlyFlags(options, []); positionalCount(positional, 0, "honmaru workspace app list");
      return { tool: "list_apps", args: {} };
    case "app read":
    case "app show":
      onlyFlags(options, []); positionalCount(positional, 1, `honmaru workspace app ${operation} <app-id>`);
      return { tool: "read_app", args: { appId: positional[0] } };
    case "app action": {
      const [action, ...target] = positional;
      if (action === "list") {
        onlyFlags(options, ["appId"]);
        if (target.length > 1 || (target.length && options.appId)) throw new Error("Usage: honmaru workspace app action list [<app-id>]");
        const appId = target[0] ?? options.appId;
        return { tool: "list_app_actions", args: appId ? { appId } : {} };
      }
      if (action === "run") {
        onlyFlags(options, ["version", "gatewayId", "requestId", "input"]); positionalCount(target, 2, "honmaru workspace app action run <app-id> <name> --version N --gateway-id NODE --request-id ID --input JSON");
        const version = integerOption(options, "version", { min: 1, required: true });
        if (!options.gatewayId?.trim()) throw new Error("--gateway-id is required.");
        if (!options.requestId || !/^[\w-]{1,80}$/.test(options.requestId)) throw new Error("--request-id must be 1 to 80 letters, numbers, underscores or hyphens; reuse it only when retrying the same request.");
        if (options.input === undefined) throw new Error("--input is required and must be valid JSON (use null when there is no input).");
        return { tool: "run_app_action", args: { appId: target[0], name: target[1], version, gatewayId: options.gatewayId, requestId: options.requestId, input: jsonValueOption(options, "input") } };
      }
      if (action === "read") {
        onlyFlags(options, []); positionalCount(target, 2, "honmaru workspace app action read <app-id> <job-id>");
        return { tool: "get_app_execution", args: { appId: target[0], jobId: target[1] } };
      }
      throw new Error("Usage: honmaru workspace app action list|run|read.");
    }
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
    case "workflow show":
      onlyFlags(options, []); positionalCount(positional, 1, "honmaru workspace workflow show <workflow-id>");
      return { tool: "get_workflow", args: { workflowId: positional[0] } };
    case "workflow create": {
      onlyFlags(options, ["name", "trigger", "steps", "draft"]); positionalCount(positional, 0, "honmaru workspace workflow create --name NAME --trigger JSON --steps JSON --draft");
      if (options.draft !== true) throw new Error("--draft is required; new workflows are created paused and never run automatically.");
      if (typeof options.name !== "string" || !options.name.trim() || options.name.trim().length > 80) throw new Error("--name is required and must be at most 80 characters.");
      const trigger = objectOption(options, "trigger");
      const steps = jsonValueOption(options, "steps");
      if (!Array.isArray(steps) || steps.length < 1 || steps.length > 12 || steps.some(step => !step || typeof step !== "object" || Array.isArray(step))) throw new Error("--steps must be a JSON array of 1 to 12 step objects.");
      return { tool: "create_workflow", args: { name: options.name.trim(), trigger, steps } };
    }
    case "workflow update": {
      onlyFlags(options, ["expectedUpdatedAt", "name", "trigger", "steps"]); positionalCount(positional, 1, "honmaru workspace workflow update <workflow-id> --expected-updated-at ISO [--name NAME] [--trigger JSON] [--steps JSON]");
      if (!options.expectedUpdatedAt || !Number.isFinite(Date.parse(options.expectedUpdatedAt))) throw new Error("--expected-updated-at must be a valid timestamp from a freshly loaded workflow.");
      const args = { workflowId: positional[0], expectedUpdatedAt: options.expectedUpdatedAt };
      if (options.name !== undefined) {
        if (!options.name.trim() || options.name.trim().length > 80) throw new Error("--name must be 1 to 80 characters.");
        args.name = options.name.trim();
      }
      if (options.trigger !== undefined) args.trigger = objectOption(options, "trigger");
      if (options.steps !== undefined) {
        const steps = jsonValueOption(options, "steps");
        if (!Array.isArray(steps) || steps.length < 1 || steps.length > 12 || steps.some(step => !step || typeof step !== "object" || Array.isArray(step))) throw new Error("--steps must be a JSON array of 1 to 12 step objects.");
        args.steps = steps;
      }
      if (Object.keys(args).length === 2) throw new Error("Provide at least one of --name, --trigger, or --steps.");
      return { tool: "update_workflow", args };
    }
    case "workflow pause":
      onlyFlags(options, ["expectedUpdatedAt"]); positionalCount(positional, 1, "honmaru workspace workflow pause <workflow-id> --expected-updated-at ISO");
      if (!options.expectedUpdatedAt || !Number.isFinite(Date.parse(options.expectedUpdatedAt))) throw new Error("--expected-updated-at must be a valid timestamp from a freshly loaded workflow.");
      return { tool: "pause_workflow", args: { workflowId: positional[0], expectedUpdatedAt: options.expectedUpdatedAt } };
    case "workflow run": {
      onlyFlags(options, ["text"]); positionalCount(positional, 1, "honmaru workspace workflow run <workflow-id> [--text TEXT]");
      const args = { workflowId: positional[0] };
      if (options.text !== undefined) args.text = options.text;
      return { tool: "run_workflow", args };
    }
    case "workflow runs": {
      onlyFlags(options, ["limit"]); positionalCount(positional, 1, "honmaru workspace workflow runs <workflow-id> [--limit N]");
      const limit = integerOption(options, "limit", { min: 1, max: 200 });
      return { tool: "list_workflow_runs", args: { workflowId: positional[0], ...(limit ? { limit } : {}) } };
    }
    case "workflow run-detail":
      onlyFlags(options, []); positionalCount(positional, 2, "honmaru workspace workflow run-detail <workflow-id> <run-id>");
      return { tool: "get_workflow_run", args: { workflowId: positional[0], runId: positional[1] } };
    case "workflow cancel":
      onlyFlags(options, ["expectedStartedAt"]); positionalCount(positional, 2, "honmaru workspace workflow cancel <workflow-id> <run-id> --expected-started-at ISO");
      if (!options.expectedStartedAt || !Number.isFinite(Date.parse(options.expectedStartedAt))) throw new Error("--expected-started-at must be a valid ISO timestamp from a freshly loaded run.");
      return { tool: "cancel_workflow_run", args: { workflowId: positional[0], runId: positional[1], expectedStartedAt: options.expectedStartedAt } };
    case "workflow revisions": {
      onlyFlags(options, ["before"]); positionalCount(positional, 1, "honmaru workspace workflow revisions <workflow-id> [--before N]");
      const before = integerOption(options, "before", { min: 1 });
      return { tool: "list_workflow_revisions", args: { workflowId: positional[0], ...(before !== undefined ? { before } : {}) } };
    }
    case "workflow restore": {
      onlyFlags(options, ["revision", "expectedUpdatedAt", "confirmAutoPaused"]); positionalCount(positional, 1, "honmaru workspace workflow restore <workflow-id> --revision N --expected-updated-at ISO [--confirm-auto-paused]");
      const revision = integerOption(options, "revision", { min: 1, required: true });
      if (!options.expectedUpdatedAt || !Number.isFinite(Date.parse(options.expectedUpdatedAt))) throw new Error("--expected-updated-at must be a valid ISO timestamp from a freshly loaded workflow.");
      return { tool: "restore_workflow_revision", args: { workflowId: positional[0], revision, expectedUpdatedAt: options.expectedUpdatedAt, ...(options.confirmAutoPaused ? { confirmAutoPaused: true } : {}) } };
    }
    case "workflow resume":
      onlyFlags(options, ["generation"]); positionalCount(positional, 1, "honmaru workspace workflow resume <workflow-id> --generation TOKEN");
      if (!options.generation?.trim()) throw new Error("--generation from a freshly loaded workflow is required.");
      return { tool: "resume_workflow_safety", args: { workflowId: positional[0], generation: options.generation } };
    case "workflow recover":
      onlyFlags(options, ["expectedStartedAt", "confirmNoReplay"]); positionalCount(positional, 2, "honmaru workspace workflow recover <workflow-id> <run-id> --expected-started-at ISO --confirm-no-replay");
      if (!options.expectedStartedAt || !Number.isFinite(Date.parse(options.expectedStartedAt))) throw new Error("--expected-started-at must be a valid ISO timestamp from a freshly loaded run.");
      if (options.confirmNoReplay !== true) throw new Error("--confirm-no-replay is required; the uncertain step will not be retried.");
      return { tool: "recover_stalled_workflow_run", args: { workflowId: positional[0], runId: positional[1], expectedStartedAt: options.expectedStartedAt, confirmNoReplay: true } };
    case "workflow held-events": {
      onlyFlags(options, ["offset"]); positionalCount(positional, 1, "honmaru workspace workflow held-events <workflow-id> [--offset N]");
      const offset = integerOption(options, "offset", { min: 0, max: 975 });
      if (offset !== undefined && offset % 25 !== 0) throw new Error("--offset must be a multiple of 25 from 0 to 975.");
      return { tool: "list_held_workflow_events", args: { workflowId: positional[0], ...(offset !== undefined ? { offset } : {}) } };
    }
    case "workflow held-event":
      onlyFlags(options, []); positionalCount(positional, 2, "honmaru workspace workflow held-event <workflow-id> <event-id>");
      return { tool: "get_held_workflow_event", args: { workflowId: positional[0], eventId: positional[1] } };
    case "workflow discard-held":
    case "workflow replay-held": {
      onlyFlags(options, ["eventIds"]); positionalCount(positional, 1, `honmaru workspace workflow ${operation} <workflow-id> --event-ids ID,ID`);
      if (!options.eventIds?.trim()) throw new Error("--event-ids is required.");
      const eventIds = options.eventIds.split(",").map(value => value.trim()).filter(Boolean);
      const maximum = operation === "replay-held" ? 100 : 1000;
      if (!eventIds.length || eventIds.length > maximum || new Set(eventIds).size !== eventIds.length) throw new Error(`--event-ids needs 1 to ${maximum} distinct event IDs.`);
      return { tool: operation === "discard-held" ? "discard_held_workflow_events" : "replay_held_workflow_events", args: { workflowId: positional[0], eventIds } };
    }
    case "workflow webhook-rotate":
    case "workflow webhook-revoke": {
      onlyFlags(options, ["expectedSecret", "expectedSecretEnv", "expectedUpdatedAt"]); positionalCount(positional, 1, `honmaru workspace workflow ${operation} <workflow-id> --expected-updated-at ISO [--expected-secret-env ENV_NAME]`);
      if (!options.expectedUpdatedAt || !Number.isFinite(Date.parse(options.expectedUpdatedAt))) throw new Error("A valid --expected-updated-at from workflow show is required.");
      if (options.expectedSecret !== undefined && options.expectedSecretEnv !== undefined) throw new Error("Use only one of --expected-secret none and --expected-secret-env.");
      // The server keeps only a digest of the secret, so workflow show cannot
      // print it. --expected-updated-at is the conflict check; a secret the
      // caller still holds (from creation or the last rotation) is optional.
      let expectedSecret;
      if (options.expectedSecretEnv !== undefined) {
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(options.expectedSecretEnv)) throw new Error("--expected-secret-env must be an environment variable name.");
        expectedSecret = env[options.expectedSecretEnv];
        if (typeof expectedSecret !== "string" || !/^[0-9a-f]{48}$/.test(expectedSecret)) throw new Error("The named environment variable must contain the 48-character webhook secret you received when the webhook was created or last rotated.");
      } else if (options.expectedSecret === "none") expectedSecret = null;
      else if (options.expectedSecret !== undefined) throw new Error("Pass a secret you hold with --expected-secret-env NAME (keeps it out of shell history), or omit it; --expected-updated-at is enough.");
      return { tool: operation === "webhook-rotate" ? "rotate_workflow_webhook" : "revoke_workflow_webhook", args: { workflowId: positional[0], ...(expectedSecret !== undefined ? { expectedSecret } : {}), expectedUpdatedAt: options.expectedUpdatedAt } };
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
    case "file versions": {
      onlyFlags(options, ["before", "limit"]); positionalCount(positional, 1, "honmaru workspace file versions <file-id> [--before N] [--limit N]");
      const args = { fileId: positional[0] };
      const before = integerOption(options, "before", { min: 1 });
      const limit = integerOption(options, "limit", { min: 1, max: 100 });
      if (before !== undefined) args.before = before;
      if (limit !== undefined) args.limit = limit;
      return { tool: "list_file_versions", args };
    }
    case "file create": {
      onlyFlags(options, ["scope", "path", "requestId", "text", "contentType"]); positionalCount(positional, 0, "honmaru workspace file create --scope ROOM --path PATH --request-id file-UUID --text TEXT --content-type MIME");
      for (const key of ["scope", "path", "requestId", "text", "contentType"]) {
        if (typeof options[key] !== "string" || !options[key].trim()) throw new Error(`--${key.replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`)} is required.`);
      }
      if (!/^file-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(options.requestId)) throw new Error("--request-id must be file- followed by a UUID; reuse it only for the identical retry.");
      const contentTypes = ["text/plain", "text/markdown", "text/csv", "text/html", "application/json", "application/xml", "application/yaml", "application/javascript"];
      if (!contentTypes.includes(options.contentType)) throw new Error(`--content-type must be one of: ${contentTypes.join(", ")}.`);
      return { tool: "create_file_text", args: { scope: options.scope, path: options.path, requestId: options.requestId, text: options.text, contentType: options.contentType } };
    }
    case "file update": {
      onlyFlags(options, ["expectedVersion", "text"]); positionalCount(positional, 1, "honmaru workspace file update <file-id> --expected-version N --text TEXT");
      if (options.text === undefined || options.text.length === 0) throw new Error("--text is required.");
      const expectedVersion = integerOption(options, "expectedVersion", { min: 1, required: true });
      return { tool: "update_file_text", args: { fileId: positional[0], expectedVersion, text: options.text } };
    }
    case "file delete": {
      onlyFlags(options, ["expectedVersion"]); positionalCount(positional, 1, "honmaru workspace file delete <file-id> --expected-version N");
      const expectedVersion = integerOption(options, "expectedVersion", { min: 1, required: true });
      return { tool: "delete_file", args: { fileId: positional[0], expectedVersion } };
    }
    case "file revert": {
      onlyFlags(options, ["expectedVersion", "version"]); positionalCount(positional, 1, "honmaru workspace file revert <file-id> --version N --expected-version N");
      const expectedVersion = integerOption(options, "expectedVersion", { min: 1, required: true });
      const version = integerOption(options, "version", { min: 1, required: true });
      if (version > expectedVersion) throw new Error("--version must not be newer than --expected-version.");
      return { tool: "restore_file_version", args: { fileId: positional[0], version, expectedVersion } };
    }
    case "file share": {
      const [shareAction, ...target] = positional;
      if (shareAction === "request") {
        onlyFlags(options, ["version", "requestId", "expiresIn", "allowDownload"]);
        positionalCount(target, 1, "honmaru workspace file share request <file-id> --version N --request-id share-UUID [--expires-in 86400|604800|2592000] [--allow-download]");
        const version = integerOption(options, "version", { min: 1, required: true });
        if (typeof options.requestId !== "string" || !/^share-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(options.requestId)) throw new Error("--request-id must be share- followed by a UUID; reuse it only for the identical retry.");
        const expiresIn = integerOption(options, "expiresIn", { min: 86400, max: 2592000 }) ?? 604800;
        if (![86400, 604800, 2592000].includes(expiresIn)) throw new Error("--expires-in must be 86400, 604800, or 2592000 seconds.");
        return { tool: "request_public_file_share", args: { fileId: target[0], version, requestKey: options.requestId, expiresIn, allowDownload: Boolean(options.allowDownload) } };
      }
      if (shareAction === "requests") {
        onlyFlags(options, ["fileId"]); positionalCount(target, 0, "honmaru workspace file share requests [--file-id FILE_ID]");
        return { tool: "list_file_share_requests", args: options.fileId ? { fileId: options.fileId } : {} };
      }
      throw new Error("Usage: honmaru workspace file share request|requests.");
    }
    case "folders list": {
      onlyFlags(options, ["scope", "directory", "origin", "cursor", "limit", "includeDeleted"]); positionalCount(positional, 0, "honmaru workspace folders list --scope ROOM [options]");
      if (!options.scope || options.scope === "all") throw new Error("--scope is required; choose one accessible Room (folder listing does not support all).");
      if (options.origin !== undefined && !["human", "agent", "unknown"].includes(options.origin)) throw new Error("--origin must be human, agent, or unknown.");
      const args = { scope: options.scope };
      for (const key of ["directory", "origin"]) if (options[key] !== undefined) args[key] = options[key];
      if (options.cursor !== undefined) args.cursor = options.cursor;
      if (options.includeDeleted !== undefined) args.includeDeleted = options.includeDeleted;
      const limit = integerOption(options, "limit", { min: 1, max: 100 });
      if (limit !== undefined) args.limit = limit;
      return { tool: "list_workspace_folders", args };
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
    case "execution node":
      onlyFlags(options, []); positionalCount(positional, 1, "honmaru workspace execution node list");
      if (positional[0] !== "list") throw new Error("Usage: honmaru workspace execution node list.");
      return { tool: "list_execution_nodes", args: {} };
    case "execution run": {
      onlyFlags(options, ["gatewayId", "requestId", "code", "input"]); positionalCount(positional, 0, "honmaru workspace execution run --gateway-id NODE --request-id ID --code JS --input JSON");
      if (!options.gatewayId?.trim()) throw new Error("--gateway-id is required.");
      if (!options.requestId || !/^[\w-]{1,80}$/.test(options.requestId)) throw new Error("--request-id must be 1 to 80 letters, numbers, underscores or hyphens; reuse it only when retrying the same request.");
      if (!options.code?.trim()) throw new Error("--code is required.");
      if (options.input === undefined) throw new Error("--input is required and must be valid JSON (use null when there is no input).");
      return { tool: "run_javascript", args: { gatewayId: options.gatewayId, requestId: options.requestId, code: options.code, input: jsonValueOption(options, "input") } };
    }
    case "execution read":
      onlyFlags(options, []); positionalCount(positional, 1, "honmaru workspace execution read <job-id>");
      return { tool: "get_execution", args: { jobId: positional[0] } };
    case "execution cancel":
      onlyFlags(options, []); positionalCount(positional, 1, "honmaru workspace execution cancel <job-id>");
      return { tool: "cancel_execution", args: { jobId: positional[0] } };
    default:
      throw new Error(`Unknown workspace command: ${pair || "(missing)"}. Run honmaru workspace help.`);
  }
}

function formatWorkspaceResult(result, json, command = null) {
  const value = result?.structuredContent ?? result;
  if (json || !value || typeof value !== "object") return JSON.stringify(value, null, 2);
  if (command?.tool === "list_app_actions") {
    const actions = (value.apps || []).flatMap((app) => (app.actions || []).map((action) => `${app.id}\t${app.name}\t${action.name}\tv${action.publishedVersion}`));
    return actions.length ? actions.join("\n") : "No published app actions are available.";
  }
  if (Array.isArray(value.apps) && value.apps.some((app) => Array.isArray(app.actions))) return value.apps.length ? value.apps.flatMap((app) => app.actions.map((action) => `${app.id}\t${app.name}\t${action.name}\tv${action.publishedVersion}`)).join("\n") : "No published app actions are available.";
  if (Array.isArray(value.apps)) return value.apps.length ? value.apps.map((app) => `${app.id}\t${app.name}${app.tableId ? `\t${app.tableId}` : ""}`).join("\n") : "No apps are available.";
  if (Array.isArray(value.tables)) return value.tables.length ? value.tables.map((table) => `${table.id}\t${table.name}\t${(table.columns || []).map((column) => column.name).join(", ")}`).join("\n") : "No tables are available.";
  if (Array.isArray(value.rows)) return value.rows.length ? value.rows.map((row) => `${row.id}\t${JSON.stringify(row)}`).join("\n") : `No rows found (total ${value.total ?? 0}).`;
  if (Array.isArray(value.files)) return value.files.length ? value.files.map((file) => `${file.id}\t${file.path || file.name || "(unnamed)"}`).join("\n") : "No files found.";
  if (Array.isArray(value.folders)) return value.folders.length ? value.folders.map((folder) => `${folder.path || folder.name}`).join("\n") : "No folders found.";
  if (Array.isArray(value.versions)) return value.versions.length ? value.versions.map((version) => `v${version.version}${version.isCurrent ? "\tcurrent" : ""}${version.purged ? "\tpurged" : ""}\t${version.contentType || version.kind}\t${version.size ?? 0} bytes\t${version.createdAt || ""}`).join("\n") : "No file versions found.";
  if (command?.tool === "read_file_text" && typeof value.text === "string") return value.text;
  if (command?.tool === "create_file_text") return `Created file ${value.fileId} as version ${value.version}.`;
  if (command?.tool === "update_file_text") return `Saved file ${value.fileId} as version ${value.version}.`;
  if (command?.tool === "delete_file") return `Deleted file ${value.fileId} as version ${value.version}; its history can be restored.`;
  if (command?.tool === "restore_file_version") return `Restored file ${value.fileId} from version ${value.restoredFrom} as version ${value.version}.`;
  if (command?.tool === "join_public_room") return `${value.joined ? "Joined" : "Already in"} public Room ${value.conversationId}.`;
  if (command?.tool === "leave_public_room") return `Left public Room ${value.conversationId}.`;
  if (command?.tool === "rename_room") return `Renamed Room ${value.conversationId} to ${value.name}.`;
  if (command?.tool === "update_room_settings") return `Updated Room ${value.conversationId} settings (version ${value.settings?.version}).`;
  if (command?.tool === "get_room_settings") return JSON.stringify(value, null, 2);
  if (command?.tool === "get_room_agent_access") return value.canGrantAccess
    ? value.missingAccessMembers?.length
      ? value.missingAccessMembers.map(member => `${member.memberRef}\t${member.name}`).join("\n")
      : "All current Room members already have access to this Agent."
    : "This Agent does not allow its owner or members to grant Room access.";
  if (command?.tool === "add_room_agent") return value.added
    ? `Added Agent ${value.agentId} to Room ${value.conversationId}${value.granted ? "; selected Room members were granted Agent access" : "; no member access grants were changed"}.`
    : `Agent ${value.agentId} is already assigned to Room ${value.conversationId}.`;
  if (command?.tool === "get_room_guidelines") return value.guidelines?.body || "";
  if (command?.tool === "update_room_guidelines") return `Updated Room ${value.conversationId} guidelines (version ${value.guidelines?.version}).`;
  if (command?.tool === "archive_room") return `Archived Room ${value.conversationId}.`;
  if (command?.tool === "unarchive_room") return `Restored Room ${value.conversationId}.`;
  if (Array.isArray(value.conversations)) return value.conversations.length ? value.conversations.map((conversation) => `${conversation.id}\t${conversation.type}\t${conversation.name || "(unnamed)"}${conversation.private ? "\tprivate" : ""}`).join("\n") : "No conversations found.";
  if (Array.isArray(value.rooms)) return value.rooms.length ? value.rooms.map((room) => room.archivedAt
    ? `${room.channel}\t${room.name || "(unnamed)"}${room.private ? "\tprivate" : ""}\tarchived ${room.archivedAt}`
    : `${room.channel}\t${room.name || "(unnamed)"}\t${room.joined ? "joined" : "not joined"}\t${room.memberCount} members`).join("\n") : `No Rooms found (total ${value.total ?? 0}).`;
  if (command?.tool === "create_conversation" && value.conversation) return `${value.created ? "Created" : "Reused"} ${value.conversation.type} ${value.conversation.id}${value.conversation.name ? ` (${value.conversation.name})` : ""}.`;
  if (command?.tool === "send_message" && value.message) return `Sent message ${value.message.id}${value.replayed ? " (idempotent retry)" : ""}.`;
  if (Array.isArray(value.members)) return value.members.length ? value.members.map((member) => `${member.name}${member.title ? `\t${member.title}` : ""}`).join("\n") : "No members found.";
  if (Array.isArray(value.gateways)) return value.gateways.length ? value.gateways.map((gateway) => `${gateway.id}\t${gateway.name}${gateway.lastSeenAt ? `\t${gateway.lastSeenAt}` : ""}`).join("\n") : "No execution nodes are registered.";
  if (value.job?.id && command?.tool === "run_app_action") return `App action ${value.job.id}: ${value.job.status}. Read the result with honmaru workspace app action read ${command.args.appId} ${value.job.id}.`;
  if (value.job?.id) return `Execution ${value.job.id}: ${value.job.status}. Read the result with honmaru workspace execution read ${value.job.id}.`;
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

export async function runCli(argv, { env = process.env, fetcher = fetch, stdout = process.stdout, stderr = process.stderr, gatewayRunner = runGatewayForeground, gatewayStatusReader = getGatewayStatus } = {}) {
  const writeOut = (value) => stdout.write(`${value}\n`);
  const writeError = (value) => stderr.write(`honmaru: ${value}\n`);
  const [root, action, ...rest] = argv;
  if (!root || root === "--help" || root === "-h" || root === "help") {
    writeOut(HELP.trimEnd());
    return 0;
  }
  if (root === "gateway") {
    const [gatewayAction, ...gatewayArgs] = argv.slice(1);
    if (!gatewayAction || gatewayAction === "help" || gatewayAction === "--help" || gatewayAction === "-h" || gatewayArgs.includes("--help") || gatewayArgs.includes("-h")) {
      writeOut(GATEWAY_HELP.trimEnd());
      return 0;
    }
    if (gatewayAction === "status") {
      const json = gatewayArgs.length === 1 && gatewayArgs[0] === "--json";
      if (gatewayArgs.length && !json) {
        writeError("Usage: honmaru gateway status [--json].");
        return 2;
      }
      try {
        writeOut(formatGatewayStatus(await gatewayStatusReader(), { json }));
        return 0;
      } catch (error) {
        writeError(error instanceof Error ? error.message : "Could not inspect the local gateway service.");
        return 1;
      }
    }
    if (gatewayAction !== "run" || gatewayArgs.length) {
      writeError("Usage: honmaru gateway run [--help].");
      return 2;
    }
    try {
      return await gatewayRunner({ env });
    } catch (error) {
      writeError(error instanceof Error ? error.message : "The local gateway could not start.");
      return 1;
    }
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

    if (action === "sdk") {
      const [sdkAction, tableId] = positional;
      onlyFlags(options, ["out"]);
      if (sdkAction !== "generate" || !tableId || positional.length !== 2 || !options.out) {
        throw new Error("Usage: honmaru workspace sdk generate <table-id> --out <file.ts>.");
      }
      const result = await client.callTool("list_tables");
      const table = result?.structuredContent?.tables?.find((item) => item.id === tableId);
      if (!table) throw new Error("No accessible table matches that ID.");
      await writeFile(options.out, generateTableSdk(table), { encoding: "utf8", flag: "w" });
      writeOut(`Generated typed client for ${table.name} at ${options.out}`);
      return 0;
    }

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
    if (resource === "file" && operation === "upload") {
      await uploadWorkspaceFile({ options, positional: commandArgs, client, apiUrl, token, fetcher, writeOut });
      return 0;
    }
    if (resource === "file" && operation === "download") {
      await downloadWorkspaceFile({ options, positional: commandArgs, client, apiUrl, token, fetcher, writeOut });
      return 0;
    }
    if (resource === "file" && operation === "copy") {
      await copyWorkspaceFile({ options, positional: commandArgs, client, apiUrl, token, fetcher, writeOut });
      return 0;
    }
    const command = resolveWorkspaceCommand(resource, operation, commandArgs, options, env);
    const result = await client.callTool(command.tool, command.args);
    writeOut(formatWorkspaceResult(result, options.json, command));
    return 0;
  } catch (error) {
    writeError(error instanceof Error ? error.message : "The command failed.");
    return 1;
  }
}

const MIME_BY_EXTENSION = {
  ".avif":"image/avif", ".csv":"text/csv", ".gif":"image/gif", ".html":"text/html", ".jpeg":"image/jpeg",
  ".jpg":"image/jpeg", ".json":"application/json", ".md":"text/markdown", ".pdf":"application/pdf", ".png":"image/png",
  ".svg":"image/svg+xml", ".txt":"text/plain", ".webp":"image/webp", ".xml":"application/xml", ".yaml":"application/yaml", ".yml":"application/yaml",
};

async function uploadWorkspaceFile({ options, positional, client, apiUrl, token, fetcher, writeOut }) {
  onlyFlags(options, ["scope", "path", "source", "requestId", "contentType"]);
  positionalCount(positional, 0, "honmaru workspace file upload --scope ROOM --path REMOTE_PATH --source LOCAL_PATH --request-id file-UUID [--content-type MIME]");
  for (const key of ["scope", "path", "source", "requestId"]) if (!options[key]?.trim()) throw new Error(`--${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)} is required.`);
  if (!/^file-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(options.requestId)) throw new Error("--request-id must be file- followed by a UUID; reuse it only for the identical upload.");
  const bytes = await readFile(options.source);
  if (bytes.byteLength > 25 * 1024 * 1024) throw new Error("Workspace file uploads are limited to 25 MiB.");
  const contentType = (options.contentType || MIME_BY_EXTENSION[(options.source.match(/\.[^.\\/]+$/)?.[0] || "").toLowerCase()] || "application/octet-stream").toLowerCase();
  if (!/^[\w.+-]+\/[\w.+-]+$/.test(contentType) || contentType.length > 200) throw new Error("--content-type must be a valid MIME type.");
  const reservation = await client.callTool("create_file_upload", {
    scope: options.scope, path: options.path, requestId: options.requestId, contentType,
    size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  const transfer = reservation?.structuredContent;
  if (transfer?.saved) {
    writeOut(JSON.stringify({ fileId: transfer.fileId, version: transfer.version, saved: true, replayed: true }));
    return;
  }
  if (typeof transfer?.uploadUrl !== "string" || typeof transfer.uploadId !== "string") throw new Error("Honmaru returned an invalid file upload reservation.");
  const endpoint = new URL(transfer.uploadUrl, mcpEndpoint(apiUrl));
  if (endpoint.origin !== mcpEndpoint(apiUrl).origin || endpoint.pathname !== `/mcp/workspace-uploads/${transfer.uploadId}`) throw new Error("Honmaru returned an unsafe upload URL.");
  const response = await fetcher(endpoint, {
    method: "PUT", redirect: "error",
    headers: { authorization: `Bearer ${token}`, "content-type": contentType, "content-length": String(bytes.byteLength) },
    body: bytes,
  });
  if (!response.ok) {
    let message = `Honmaru file upload returned HTTP ${response.status}.`;
    try { message = (await response.json()).message || message; } catch { /* Keep the status-based message. */ }
    throw new Error(message);
  }
  const saved = await response.json();
  if (saved?.fileId !== transfer.fileId || saved?.saved !== true) throw new Error("Honmaru returned an invalid file upload result.");
  writeOut(JSON.stringify(saved));
}

async function downloadWorkspaceFile({ options, positional, client, apiUrl, token, fetcher, writeOut }) {
  onlyFlags(options, ["version", "output", "dir", "force"]);
  positionalCount(positional, 1, "honmaru workspace file download <file-id> [--version N] [--output PATH | --dir DIRECTORY] [--force]");
  if (options.output && options.dir) throw new Error("Use either --output or --dir, not both.");
  const fileId = positional[0];
  const metadataResult = await client.callTool("get_workspace_file", { fileId });
  const file = metadataResult?.structuredContent?.file;
  if (!file || file.id !== fileId || typeof file.path !== "string") throw new Error("No accessible workspace file matches that ID.");
  const history = await client.callTool("list_file_versions", { fileId, limit: 100 });
  const versions = history?.structuredContent?.versions;
  if (!Array.isArray(versions)) throw new Error("Honmaru returned invalid file history.");
  const requestedVersion = options.version === undefined ? file.version : integerOption(options, "version", { min: 1, required: true });
  const version = versions.find(item => item.version === requestedVersion);
  if (!version || version.kind !== "content" || version.purged) throw new Error("The requested file version is unavailable or purged.");
  const endpoint = new URL(`/mcp/workspace-files/${encodeURIComponent(fileId)}/versions/${requestedVersion}/content`, mcpEndpoint(apiUrl));
  const response = await fetcher(endpoint, { method: "GET", redirect: "error", headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) {
    let message = `Honmaru file download returned HTTP ${response.status}.`;
    try { message = (await response.json()).message || message; } catch { /* Keep the status-based message. */ }
    throw new Error(message);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== version.size) throw new Error("The downloaded file size does not match its version metadata.");
  const output = options.output || join(options.dir || ".", basename(file.path));
  await writeFile(output, bytes, { flag: options.force ? "w" : "wx" });
  writeOut(JSON.stringify({ fileId, version: requestedVersion, output, size: bytes.byteLength }));
}

async function copyWorkspaceFile({ options, positional, client, apiUrl, token, fetcher, writeOut }) {
  onlyFlags(options, ["scope", "path", "requestId", "version"]);
  positionalCount(positional, 1, "honmaru workspace file copy <file-id> --scope ROOM --path REMOTE_PATH --request-id file-UUID [--version N]");
  for (const key of ["scope", "path", "requestId"]) if (!options[key]?.trim()) throw new Error(`--${key.replace(/[A-Z]/g, letter => `-${letter.toLowerCase()}`)} is required.`);
  if (!/^file-[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(options.requestId)) throw new Error("--request-id must be file- followed by a UUID; reuse it only for the identical copy.");
  const fileId = positional[0];
  const metadataResult = await client.callTool("get_workspace_file", { fileId });
  const file = metadataResult?.structuredContent?.file;
  if (!file || file.id !== fileId || typeof file.path !== "string") throw new Error("No accessible workspace file matches that ID.");
  const history = await client.callTool("list_file_versions", { fileId, limit: 100 });
  const versions = history?.structuredContent?.versions;
  if (!Array.isArray(versions)) throw new Error("Honmaru returned invalid file history.");
  const versionNumber = options.version === undefined ? file.version : integerOption(options, "version", { min: 1, required: true });
  const version = versions.find(item => item.version === versionNumber);
  if (!version || version.kind !== "content" || version.purged) throw new Error("The requested file version is unavailable or purged.");
  if (!Number.isSafeInteger(version.size) || version.size < 0 || version.size > 25 * 1024 * 1024 || !version.contentType) throw new Error("This file version cannot be copied by the CLI (maximum 25 MiB).");
  const endpoint = new URL(`/mcp/workspace-files/${encodeURIComponent(fileId)}/versions/${versionNumber}/content`, mcpEndpoint(apiUrl));
  const response = await fetcher(endpoint, { method: "GET", redirect: "error", headers: { authorization: `Bearer ${token}` } });
  if (!response.ok) {
    let message = `Honmaru file download returned HTTP ${response.status}.`;
    try { message = (await response.json()).message || message; } catch { /* Keep the status-based message. */ }
    throw new Error(message);
  }
  const bytes = new Uint8Array(await response.arrayBuffer());
  if (bytes.byteLength !== version.size) throw new Error("The downloaded file size does not match its version metadata.");
  const reservation = await client.callTool("create_file_upload", {
    scope: options.scope, path: options.path, requestId: options.requestId, contentType: version.contentType,
    size: bytes.byteLength, sha256: createHash("sha256").update(bytes).digest("hex"),
  });
  const transfer = reservation?.structuredContent;
  if (transfer?.saved) {
    writeOut(JSON.stringify({ sourceFileId: fileId, sourceVersion: versionNumber, fileId: transfer.fileId, version: transfer.version, saved: true, replayed: true }));
    return;
  }
  if (typeof transfer?.uploadUrl !== "string" || typeof transfer.uploadId !== "string") throw new Error("Honmaru returned an invalid file upload reservation.");
  const upload = new URL(transfer.uploadUrl, mcpEndpoint(apiUrl));
  if (upload.origin !== mcpEndpoint(apiUrl).origin || upload.pathname !== `/mcp/workspace-uploads/${transfer.uploadId}`) throw new Error("Honmaru returned an unsafe upload URL.");
  const uploaded = await fetcher(upload, {
    method: "PUT", redirect: "error",
    headers: { authorization: `Bearer ${token}`, "content-type": version.contentType, "content-length": String(bytes.byteLength) },
    body: bytes,
  });
  if (!uploaded.ok) {
    let message = `Honmaru file upload returned HTTP ${uploaded.status}.`;
    try { message = (await uploaded.json()).message || message; } catch { /* Keep the status-based message. */ }
    throw new Error(message);
  }
  const saved = await uploaded.json();
  if (saved?.fileId !== transfer.fileId || saved?.saved !== true) throw new Error("Honmaru returned an invalid file upload result.");
  writeOut(JSON.stringify({ sourceFileId: fileId, sourceVersion: versionNumber, ...saved }));
}
