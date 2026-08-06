// End-to-end check: real server + built web client + two Chromium pages.
// Alice creates an org and sends an instruction; Bob joins via invite,
// sees the card, rallies in the thread, and approves. Screenshots saved
// to the paths given in argv (alice.png bob.png).
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { chromium, type Page } from "playwright";

const here = dirname(fileURLToPath(import.meta.url));
const webRoot = join(here, "..");
const serverRoot = join(webRoot, "..", "server");
const [aliceShot, bobShot] = [
  process.argv[2] ?? "alice.png",
  process.argv[3] ?? "bob.png",
];

function waitFor(url: string, timeoutMs = 20000): Promise<void> {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tick = async () => {
      try {
        const r = await fetch(url);
        if (r.ok) return resolve();
      } catch {}
      if (Date.now() - start > timeoutMs) return reject(new Error(`timeout waiting for ${url}`));
      setTimeout(tick, 300);
    };
    tick();
  });
}

const children: ChildProcess[] = [];
function run(cmd: string, args: string[], cwd: string, env: Record<string, string>) {
  const child = spawn(cmd, args, { cwd, env: { ...process.env, ...env }, stdio: "ignore" });
  children.push(child);
  return child;
}
function cleanup() {
  for (const child of children) child.kill("SIGKILL");
}
process.on("exit", cleanup);

const dataDir = mkdtempSync(join(tmpdir(), "honmaru-e2e-"));
run("node", ["dist/index.js"], serverRoot, {
  PORT: "8081",
  AUTH_DEV_MODE: "1",
  DATABASE_PATH: join(dataDir, "e2e.db"),
  LOG_LEVEL: "silent",
  SLA_SWEEP_SECONDS: "0",
});
run("npx", ["vite", "preview", "--port", "4173", "--strictPort"], webRoot, {});
await waitFor("http://127.0.0.1:8081/health");
await waitFor("http://127.0.0.1:4173/");

// The sandbox pre-installs Chromium at a fixed path; pin it so the pinned
// playwright version never tries to download its own build.
const browser = await chromium.launch({
  executablePath: process.env.CHROMIUM_PATH || "/opt/pw-browsers/chromium",
});
const alice: Page = await (await browser.newContext({ viewport: { width: 480, height: 800 } })).newPage();
const bob: Page = await (await browser.newContext({ viewport: { width: 480, height: 800 } })).newPage();
const APP = "http://127.0.0.1:4173/";

function fail(message: string): never {
  console.error("FAIL:", message);
  process.exit(1);
}
function ok(message: string) {
  console.log("ok:", message);
}

// Alice: login -> create org
await alice.goto(APP);
await alice.fill('input[placeholder="Your name"]', "Alice");
await alice.click("text=Continue");
await alice.fill('input[placeholder="Job title (e.g. Engineer)"]', "Product Manager");
await alice.fill('input[placeholder="Org name"]', "Acme");
await alice.click("text=Create org");
await alice.waitForSelector(".composer input");
ok("alice created org");

// Alice: invite code
await alice.click('button[title="Invite a teammate"]');
await alice.waitForSelector(".invite-strip code");
const code = (await alice.textContent(".invite-strip code"))!.trim();
ok("invite code " + code);

// Bob: login -> join
await bob.goto(APP);
await bob.fill('input[placeholder="Your name"]', "Bob");
await bob.click("text=Continue");
await bob.fill('input[placeholder="Job title (e.g. Engineer)"]', "Engineer");
await bob.fill('input[placeholder="Invite code"]', code);
await bob.click('button:text-is("Join")');
await bob.waitForSelector(".composer input");
ok("bob joined org");

// Alice sends an instruction; card must appear on Bob's feed via WS
await alice.fill(".composer input", "tell Bob to fix the login bug asap");
await alice.press(".composer input", "Enter");
await bob.waitForSelector(".card h3", { timeout: 8000 });
const title = await bob.textContent(".card h3");
ok("bob sees card: " + title);
const prio = await bob.textContent(".card .chip[class*=prio]");
if (!prio?.toLowerCase().includes("urgent")) fail("expected urgent priority, got " + prio);
ok("priority urgent (fast-path inference)");

// Bob rallies with a quick reply
await bob.click(".card .thread-btn");
await bob.waitForSelector(".quick button");
await bob.click('.quick button:has-text("On it — today")');
await bob.waitForSelector('.msg.me:has-text("On it — today")');
ok("bob sent quick reply");

// Alice sees the reply in her thread + a notification
await alice.waitForSelector(".bell .badge", { timeout: 8000 });
ok("alice got notification badge");
await alice.click(".card .thread-btn");
await alice.waitForSelector('.msg.them:has-text("On it — today")', { timeout: 8000 });
ok("alice sees rally message");
await alice.click(".sheet-head .icon");

// Bob approves; Alice's card flips to approved
await bob.click(".sheet-head .icon");
await bob.click(".card .approve");
await alice.waitForSelector(".chip.st-approved", { timeout: 8000 });
ok("approval reflected on alice's screen");

// screenshots
await bob.click(".card .thread-btn");
await bob.waitForSelector(".msg.me");
await alice.waitForTimeout(400);
await alice.screenshot({ path: aliceShot });
await bob.screenshot({ path: bobShot });
ok("screenshots saved");

console.log("E2E PASSED");
await browser.close();
process.exit(0);
