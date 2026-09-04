// `schema.sql` is the whole database in one file, which is what the test suite
// loads and what a person reads to see what is stored. `migrations/` is the
// ordered list of changes, which is what production applies.
//
// Keeping both by hand is how they drift, and a drift here means the suite
// tests a schema production does not have. So one is generated from the other,
// and `npm run schema:check` fails if the file on disk is stale.
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dir = join(root, "migrations");

export function buildSchema() {
  const files = readdirSync(dir).filter((f) => f.endsWith(".sql")).sort();
  const header =
    "/* GENERATED FILE — do not edit.\n" +
    "   Built from migrations/ by `npm run schema:build`. Add a change as a new\n" +
    "   numbered migration and regenerate; editing here is a change production\n" +
    "   will never see. */\n\n";
  return header + files.map((f) => readFileSync(join(dir, f), "utf8").trim()).join("\n\n") + "\n";
}

const target = join(root, "schema.sql");
const built = buildSchema();

if (process.argv.includes("--check")) {
  const current = readFileSync(target, "utf8");
  if (current !== built) {
    console.error("schema.sql is out of date with migrations/. Run: npm run schema:build");
    process.exit(1);
  }
  console.log("schema.sql matches migrations/");
} else {
  writeFileSync(target, built);
  console.log(`schema.sql rebuilt from ${readdirSync(dir).filter((f) => f.endsWith(".sql")).length} migrations`);
}
