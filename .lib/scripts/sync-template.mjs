#!/usr/bin/env node
// Sync a project created from the permissions-starter-kit template with the
// latest template version, and migrate it onto the template's current tooling.
//
// Repos created via GitHub's "Use this template" share no git history with
// this repo, so a naive `git merge upstream/main --allow-unrelated-histories`
// degenerates into whole-file add/add conflicts on every file both sides
// have. This script instead reconstructs the template version your repo was
// created from and grafts it in as a merge base, so git can run a proper
// 3-way merge: only files where both you and the template actually changed
// the same lines will conflict.
//
// Usage (from your project root, on a clean working tree):
//   git remote add upstream https://github.com/gnosisguild/permissions-starter-kit.git
//   git fetch upstream
//   git checkout upstream/main -- .lib/scripts/sync-template.mjs
//   node .lib/scripts/sync-template.mjs
//
// The roles/ directory is entirely yours: template-side changes to the
// example roles are never brought into your project by a sync. What the
// script does do is migrate your roles, contracts and ABIs to the tooling the
// template now uses (see `migrate()`), committed separately from the merge so
// you can review it with `git show`.
//
// The script is idempotent: run it again after resolving conflicts and
// committing, and it will finish the sync — clean up the graft and run the
// migration. It also keeps itself current: when upstream has a newer version
// of this script than the one you ran, it hands over to that version. So for
// future updates, just run it again.
//
// `--check` only inspects the working tree (no git, no network) and exits
// non-zero if the project still carries files from before a tooling
// migration — e.g. because it was synced with an older version of this script
// or a plain `git merge`. `yarn apply` runs it first.

import { execFileSync, execSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const UPSTREAM_URL =
  "https://github.com/gnosisguild/permissions-starter-kit.git";
// SYNC_TEMPLATE_REF is a testing/advanced knob: point the sync at another
// (possibly local) ref instead of upstream/main; skips the upstream fetch.
const UPSTREAM = process.env.SYNC_TEMPLATE_REF ?? "upstream/main";
const SCRIPT_PATH = ".lib/scripts/sync-template.mjs";
// Set when a stale copy of this script hands over to the upstream version.
const HANDED_OVER = process.env.SYNC_TEMPLATE_HANDED_OVER === "1";

// Leftovers of the tooling before @zodiaceco/sdk (see `migrate()`).
const LEGACY_CONTRACTS = "contracts.ts";
const LEGACY_ETH_SDK = ".lib/eth-sdk";

// Chain names eth-sdk / zodiac-roles-sdk used → @zodiaceco/sdk chain prefixes.
const RENAMED_CHAINS = {
  mainnet: "eth",
  optimism: "oeth",
  bsc: "bnb",
  gnosis: "gno",
  polygon: "matic",
  arbitrumOne: "arb1",
  avalanche: "avax",
  baseSepolia: "basesep",
  sepolia: "sep",
};
const UNCHANGED_CHAINS = [
  "flare",
  "unichain",
  "sonic",
  "worldchain",
  "hyperevm",
  "zkevm",
  "megaeth",
  "mantle",
  "base",
  "plasma",
  "celo",
  "ink",
  "bob",
  "berachain",
  "scroll",
  "katana",
];
const LEGACY_ALLOW_CHAIN = new RegExp(
  `\\ballow\\.(${Object.keys(RENAMED_CHAINS).join("|")})\\b`,
  "g"
);

const sh = (cmd, opts = {}) =>
  execSync(cmd, { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"], ...opts })
    .toString()
    .trim();
const trySh = (cmd) => {
  try {
    return sh(cmd);
  } catch {
    return null;
  }
};
const lines = (s) => (s ?? "").split("\n").filter(Boolean);
const quote = (p) => `"${p.replace(/"/g, '\\"')}"`;
const fail = (msg) => {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
};

// ---------------------------------------------------------------------------
// --check: is there anything left to migrate?
// ---------------------------------------------------------------------------

if (process.argv.includes("--check")) {
  const leftovers = legacyLeftovers();
  if (leftovers.length === 0) process.exit(0);
  console.error(
    "\n✗ This project still uses tooling the template has moved away from:\n" +
      leftovers.map((l) => `  - ${l}`).join("\n") +
      "\n\nMigrate it by running:\n" +
      "  node .lib/scripts/sync-template.mjs\n"
  );
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Preflight
// ---------------------------------------------------------------------------

if (trySh("git rev-parse --git-dir") === null) {
  fail("Not a git repository. Run this from your project root.");
}

// A merge may already be in progress from a previous run.
if (trySh("git rev-parse -q --verify MERGE_HEAD") !== null) {
  fail(
    "A merge is already in progress. Resolve the remaining conflicts, run\n" +
      "  git commit\n" +
      `then run this script once more to finish the sync.`
  );
}

// Clean up a leftover graft from a previous (committed or aborted) run.
dropGrafts();

// Require a clean tree — but tolerate this script itself (freshly checked out
// of upstream) and untracked files.
const dirty = lines(sh("git status --porcelain"))
  .filter((line) => !line.startsWith("??"))
  .filter((line) => !line.slice(3).trim().endsWith(SCRIPT_PATH));
if (dirty.length > 0) {
  fail(
    "Working tree has uncommitted changes. Commit or stash them first:\n" +
      dirty.map((l) => `  ${l}`).join("\n")
  );
}

// Shallow clones can't walk history to find the template base.
if (sh("git rev-parse --is-shallow-repository") === "true") {
  console.log("Shallow clone detected — fetching full history...");
  sh("git fetch --unshallow origin");
}

// Make sure the upstream remote exists and is fetched.
if (!process.env.SYNC_TEMPLATE_REF && !HANDED_OVER) {
  if (trySh("git remote get-url upstream") === null) {
    console.log("Adding upstream remote...");
    sh(`git remote add upstream ${UPSTREAM_URL}`);
  }
  console.log("Fetching upstream...");
  sh("git fetch upstream");
}

handOverToUpstreamScript();

// ---------------------------------------------------------------------------
// Already related? Then this is a plain merge.
// ---------------------------------------------------------------------------

if (trySh(`git merge-base HEAD ${UPSTREAM}`) !== null) {
  if (sh(`git rev-list -1 ${UPSTREAM} --not HEAD`) === "") {
    console.log("\n✓ Already up to date with the template.");
    finish();
    process.exit(0);
  }
  console.log("Histories are already related — running a regular merge.\n");
  merge();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Find the template version this repo was created from
// ---------------------------------------------------------------------------

const roots = lines(sh("git rev-list --max-parents=0 HEAD"));
if (roots.length !== 1) {
  fail(
    "Your repository has multiple root commits — can't determine the\n" +
      "template version automatically. Merge manually with a graft:\n" +
      "  git replace --graft <your-template-snapshot-commit> <matching-upstream-commit>\n" +
      `  git merge ${UPSTREAM}`
  );
}
const root = roots[0];

// "Use this template" copies the template's HEAD at creation time, so the
// newest upstream commit at/before the root commit's date is the prime
// candidate. Verify by tree comparison, and fall back to scanning all
// upstream commits for the closest match.
const rootDate = sh(`git log -1 --format=%cI ${root}`);
let base = trySh(`git rev-list -1 --before="${rootDate}" ${UPSTREAM}`);

const diffCount = (a, b) =>
  lines(sh(`git diff --name-only ${a} ${b} -- . ":!${SCRIPT_PATH}"`)).length;

if (!base || diffCount(base, root) > 0) {
  console.log("Scanning template history for the closest match...");
  let best = null;
  let bestCount = Infinity;
  for (const c of lines(sh(`git rev-list ${UPSTREAM}`))) {
    const n = diffCount(c, root);
    if (n < bestCount) {
      bestCount = n;
      best = c;
    }
    if (n === 0) break;
  }
  const totalFiles = lines(sh(`git ls-tree -r --name-only ${root}`)).length;
  if (best === null || bestCount > totalFiles / 2) {
    fail(
      "Couldn't find a template version resembling your repository's initial\n" +
        "commit — was the early history rewritten? Merge manually:\n" +
        `  git merge ${UPSTREAM} --allow-unrelated-histories`
    );
  }
  base = best;
  if (bestCount > 0) {
    console.log(
      `Closest template version differs in ${bestCount} file(s) — ` +
        "expect a few extra conflicts."
    );
  }
}

console.log(
  `Template base: ${base.slice(0, 7)} (${sh(
    `git log -1 --format=%cs ${base}`
  )})`
);

// ---------------------------------------------------------------------------
// Graft + merge
// ---------------------------------------------------------------------------

sh(`git replace --graft ${root} ${base} 2>/dev/null`);
console.log("Grafted template ancestry — merging...\n");
merge();

function merge() {
  putBackOwnCopy();

  let conflicted = false;
  try {
    // --no-commit so we can strip template-side roles/ changes before the
    // merge is recorded, even when it would otherwise commit cleanly.
    execSync(`git merge ${UPSTREAM} --no-edit --no-commit --no-ff`, {
      stdio: "inherit",
    });
  } catch {
    conflicted = true;
  }
  if (trySh("git rev-parse -q --verify MERGE_HEAD") === null) {
    // --no-commit always leaves MERGE_HEAD behind, so git refused to start.
    fail("git merge could not start — see its message above.");
  }

  keepOwnRolesDir();
  resolveTemplateOwnedFiles();
  keepLegacyFilesForMigration();

  const unresolved = lines(sh("git diff --name-only --diff-filter=U"));
  if (unresolved.length > 0) {
    console.log(
      "\nMerge stopped with conflicts — only files where both you and the\n" +
        "template changed the same lines. Resolve them, then:\n" +
        "  git commit\n" +
        "  node .lib/scripts/sync-template.mjs   # finishes the sync and migrates your project"
    );
    process.exit(0);
  }

  // Nothing left to resolve (either the merge was clean, or all conflicts were
  // ones this script resolves): commit it.
  if (conflicted || trySh("git rev-parse -q --verify MERGE_HEAD") !== null) {
    sh("git commit --no-edit");
  }

  // Merge committed: drop the graft, it has served its purpose.
  dropGrafts();
  console.log("\n✓ Synced with the latest template.");
  finish();
}

function finish() {
  const { commit, todos } = migrate();
  if (commit) {
    console.log(
      `\n✓ Migrated your project to the template's current tooling (commit ${commit}).\n` +
        "  Review it with: git show " +
        commit
    );
  }
  if (todos.length > 0) {
    console.log(
      "\nThese need your attention — the script couldn't migrate them automatically:\n" +
        todos.map((t) => `  - ${t}`).join("\n")
    );
  }
  console.log(
    "\nNext:\n" +
      "  yarn install\n" +
      "  yarn setup          # fetch ABIs and generate the `allow` kit types\n" +
      "  npx tsc --noEmit    # confirm your roles type-check\n\n" +
      "For future template updates, just run this script again."
  );
}

function dropGrafts() {
  for (const ref of lines(sh("git replace -l 2>/dev/null || true"))) {
    sh(`git replace -d ${ref}`);
  }
}

// ---------------------------------------------------------------------------
// This script's own file
// ---------------------------------------------------------------------------

// A stale copy of this script must not drive the sync: it wouldn't know about
// the latest migrations. If upstream carries a different version, run that
// one instead (from a temp file, so git is free to update this path).
function handOverToUpstreamScript() {
  if (HANDED_OVER) return;
  const upstreamCopy = trySh(`git show ${UPSTREAM}:${SCRIPT_PATH}`);
  if (upstreamCopy === null) return;
  const ownCopy = fs.readFileSync(fileURLToPath(import.meta.url), "utf8");
  if (ownCopy.trim() === upstreamCopy.trim()) return;

  console.log("A newer version of this script is available — running that.\n");
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "sync-template-"));
  const file = path.join(dir, "sync-template.mjs");
  fs.writeFileSync(file, upstreamCopy + "\n");
  try {
    execFileSync(process.execPath, [file, ...process.argv.slice(2)], {
      stdio: "inherit",
      env: { ...process.env, SYNC_TEMPLATE_HANDED_OVER: "1" },
    });
    process.exit(0);
  } catch (e) {
    process.exit(e.status ?? 1);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

// Bootstrapping (`git checkout upstream/main -- <this script>`) leaves this
// file changed in the index, and `git merge` refuses to run over local changes
// to a path it needs to update. This process has already loaded the script, and
// the merge brings the upstream copy in anyway, so put the committed state back.
function putBackOwnCopy() {
  if (sh(`git status --porcelain -- ${SCRIPT_PATH}`) === "") return;
  if (trySh(`git cat-file -e HEAD:${SCRIPT_PATH}`) !== null) {
    sh(`git checkout HEAD -- ${SCRIPT_PATH}`);
  } else {
    // Not committed yet (the project predates this script).
    trySh(`git rm -q --cached -- ${SCRIPT_PATH}`);
    fs.rmSync(SCRIPT_PATH, { force: true });
  }
}

// Files that belong to the template's tooling, not to your project: whatever
// happened on your side, the merge takes the template's version.
function resolveTemplateOwnedFiles() {
  // This script — e.g. a copy you edited, or one from an older sync whose
  // changes git can't line up with upstream's.
  sh(`git checkout ${UPSTREAM} -- ${SCRIPT_PATH}`);

  // The lockfile can't be merged line by line. Take the template's, and
  // `yarn install` re-resolves any dependencies you added on top.
  if (lines(sh("git diff --name-only --diff-filter=U -- yarn.lock")).length) {
    sh(`git checkout ${UPSTREAM} -- yarn.lock`);
    console.log(
      "\nTook the template's yarn.lock — `yarn install` re-adds your own dependencies."
    );
  }
}

// ---------------------------------------------------------------------------
// roles/ stays yours
// ---------------------------------------------------------------------------

// The roles/ directory is entirely user-owned: template-side changes to the
// example roles must never propagate into user projects. Reset everything
// under roles/ to our pre-merge state, whatever the merge brought in.
function keepOwnRolesDir() {
  // What did the merge stage (or leave conflicted) under roles/? The merge
  // only touches paths where the template side differs from the merge base,
  // so this is exactly the set of template-side changes we're about to skip.
  const touched = lines(sh("git status --porcelain -- roles/")).filter(
    (line) => !line.startsWith("??")
  );
  if (touched.length === 0) return;

  // Restore all files that exist in HEAD (undoes template modifications and
  // deletions, and resolves such conflicts to our version).
  trySh("git checkout HEAD -- roles/");

  // Drop files the merge staged under roles/ that HEAD doesn't have
  // (template-added files, including add/add conflict entries).
  const ours = new Set(lines(trySh("git ls-tree -r --name-only HEAD -- roles/")));
  const staged = lines(trySh("git ls-files -- roles/"));
  for (const p of new Set(staged.filter((p) => !ours.has(p)))) {
    sh(`git rm -q -f -- ${quote(p)}`);
  }

  console.log(
    `\nSkipped ${touched.length} template change(s) under roles/ — that` +
      " directory is yours and is never touched by template syncs."
  );
}

// ---------------------------------------------------------------------------
// Migration onto @zodiaceco/sdk
// ---------------------------------------------------------------------------
//
// The template used to describe contracts in `contracts.ts` keyed by chain
// name, fetch ABIs with eth-sdk into `.lib/eth-sdk/abis/`, and have roles call
// `defi-kit` directly. It now uses @zodiaceco/sdk: contracts live in
// `zodiac.config.ts` keyed by chain prefix, ABIs in `abis/<prefix>/`, and
// DeFi Kit presets are `defikit` entries from `@zodiaceco/sdk/actions`.
//
// The merge takes care of the template's own files. These steps carry over
// what's yours — and are safe to re-run: each looks for leftovers of the old
// layout and does nothing when there are none. (Paths and chain names it
// looks for are declared at the top of this file.)

// Before the merge commits: a conflict on a file the migration still needs to
// read (e.g. `contracts.ts`, modified by you, deleted by the template) resolves
// to your version, and the migration then carries its contents over.
function keepLegacyFilesForMigration() {
  const conflicted = lines(
    sh(
      `git diff --name-only --diff-filter=U -- ${LEGACY_CONTRACTS} ${LEGACY_ETH_SDK}`
    )
  );
  for (const p of conflicted) {
    if (trySh(`git cat-file -e HEAD:${quote(p)}`) !== null) {
      sh(`git checkout HEAD -- ${quote(p)}`);
    } else {
      sh(`git rm -q -f -- ${quote(p)}`);
    }
  }
}

function migrate() {
  const todos = [];
  const touched = new Set();

  migrateContracts(todos, touched);
  migrateAbis(touched);
  migrateRoles(todos, touched);

  const paths = [...touched].filter(
    (p) => fs.existsSync(p) || lines(trySh(`git ls-files -- ${quote(p)}`)).length
  );
  if (paths.length === 0) return { commit: null, todos };

  const pathspec = paths.map(quote).join(" ");
  sh(`git add -A -- ${pathspec}`);
  if (trySh(`git diff --cached --quiet -- ${pathspec}`) !== null) {
    return { commit: null, todos };
  }
  sh(
    `git commit -q -m "chore: migrate to @zodiaceco/sdk tooling" ` +
      `-m "Automated by .lib/scripts/sync-template.mjs." -- ${pathspec}`
  );
  return { commit: sh("git rev-parse --short HEAD"), todos };
}

// contracts.ts → the `contracts` of zodiac.config.ts, chain names → prefixes.
function migrateContracts(todos, touched) {
  if (!fs.existsSync(LEGACY_CONTRACTS)) return;
  const manual =
    `${LEGACY_CONTRACTS}: move its entries into \`contracts\` in zodiac.config.ts, ` +
    "keyed by chain prefix (eth, gno, arb1, ...), then delete it.";

  const source = fs.readFileSync(LEGACY_CONTRACTS, "utf8");
  const exportMatch = /export\s+default\s*\{/.exec(source);
  const open = exportMatch && exportMatch.index + exportMatch[0].length - 1;
  const close = exportMatch && matchingBrace(source, open);
  if (close === null || close === undefined) {
    todos.push(manual);
    return;
  }

  // Only a plain object literal is safe to move: anything else in the file
  // (constants, imports it relies on) wouldn't come along.
  const rest = stripComments(source.slice(0, open) + source.slice(close + 1))
    .replace(/import\s+type\s*\{\s*Contracts\s*\}\s*from\s*["'][^"']*["']\s*;?/, "")
    .replace(/export\s+default/, "")
    .replace(/satisfies\s+Contracts/, "")
    .replace(/as\s+const/, "")
    .replace(/[\s;]/g, "");
  if (rest !== "") {
    todos.push(manual);
    return;
  }

  let literal = source.slice(open, close + 1);
  const replacements = [];
  for (const key of objectKeys(literal, 0)) {
    if (key.name in RENAMED_CHAINS) {
      replacements.push({ ...key, text: RENAMED_CHAINS[key.name] });
    } else if (!UNCHANGED_CHAINS.includes(key.name)) {
      todos.push(`${manual} (Unknown chain "${key.name}".)`);
      return;
    }
  }
  for (const r of replacements.reverse()) {
    literal = literal.slice(0, r.start) + r.text + literal.slice(r.end);
  }
  literal = literal.replace(/\n(?=[^\n])/g, "\n  ");

  let config = fs.existsSync("zodiac.config.ts")
    ? fs.readFileSync("zodiac.config.ts", "utf8")
    : 'import { defineConfig } from "@zodiaceco/sdk/cli/config";\n\nexport default defineConfig({});\n';
  const define = /defineConfig\(\s*\{/.exec(config);
  if (!define) {
    todos.push(manual);
    return;
  }
  const configOpen = define.index + define[0].length - 1;
  const existing = objectKeys(config, configOpen).find(
    (k) => k.name === "contracts"
  );
  if (existing) {
    // Replace the template's example contracts with yours.
    const valueStart = config.indexOf("{", existing.end);
    const valueEnd = matchingBrace(config, valueStart);
    if (valueEnd === null) {
      todos.push(manual);
      return;
    }
    config = config.slice(0, valueStart) + literal + config.slice(valueEnd + 1);
  } else {
    const configClose = matchingBrace(config, configOpen);
    const inner = config.slice(configOpen + 1, configClose).trim();
    config =
      config.slice(0, configOpen + 1) +
      `\n  contracts: ${literal},` +
      (inner ? `\n  ${inner}\n` : "\n") +
      config.slice(configClose);
  }

  fs.writeFileSync("zodiac.config.ts", config);
  fs.rmSync(LEGACY_CONTRACTS);
  touched.add("zodiac.config.ts");
  touched.add(LEGACY_CONTRACTS);
}

// .lib/eth-sdk/abis/<chain name>/... → abis/<chain prefix>/..., so ABIs you
// added by hand (unverified contracts) survive. Anything already at the new
// location wins.
function migrateAbis(touched) {
  if (!fs.existsSync(LEGACY_ETH_SDK)) return;
  const legacyAbis = path.join(LEGACY_ETH_SDK, "abis");
  if (fs.existsSync(legacyAbis)) {
    for (const file of walk(legacyAbis)) {
      const [chain, ...rest] = path.relative(legacyAbis, file).split(path.sep);
      const dest = path.join("abis", RENAMED_CHAINS[chain] ?? chain, ...rest);
      if (fs.existsSync(dest)) continue;
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      fs.renameSync(file, dest);
    }
    touched.add("abis");
  }
  fs.rmSync(LEGACY_ETH_SDK, { recursive: true, force: true });
  touched.add(LEGACY_ETH_SDK);
}

function migrateRoles(todos, touched) {
  if (!fs.existsSync("roles")) return;
  for (const file of walk("roles").filter((f) => /\.[mc]?[jt]sx?$/.test(f))) {
    const original = fs.readFileSync(file, "utf8");
    let src = original;

    // `import { allow as x } from "defi-kit/eth"` → `defikit` entries. Entries
    // need a label (it names the permission in the Zodiac app); we derive one
    // you can rename.
    const aliases = [];
    const otherChains = new Set();
    src = src.replace(
      /import\s*\{\s*allow(?:\s+as\s+(\w+))?\s*\}\s*from\s*["']defi-kit(?:\/(\w+))?["']\s*;?/g,
      (_, alias, chain) => {
        if (chain && chain !== "eth") otherChains.add(chain);
        aliases.push(alias ?? "allow");
        return aliases.length === 1
          ? 'import { defikit } from "@zodiaceco/sdk/actions";'
          : "";
      }
    );
    for (const alias of new Set(aliases)) {
      const call = new RegExp(
        `\\b${alias}\\.(\\w+)\\.(\\w+)\\((\\s*)(\\{[ \\t]*\\n([ \\t]*)|\\{[ \\t]*|\\))?`,
        "g"
      );
      src = src.replace(call, (_, protocol, verb, ws, arg, indent) => {
        const head = `defikit.${protocol}.${verb}(`;
        const label = `label: "${protocol} ${verb}"`;
        if (arg === ")") return `${head}{ ${label} })`;
        if (indent !== undefined) {
          return `${head}${ws}{\n${indent}${label},\n${indent}`;
        }
        if (arg?.trim() === "{") return `${head}${ws}{ ${label}, `;
        todos.push(
          `${file}: add a \`label\` to the parameters of defikit.${protocol}.${verb}(...).`
        );
        return head + ws;
      });
    }
    if (otherChains.size > 0) {
      todos.push(
        `${file}: used defi-kit for ${[...otherChains].join(", ")}. \`defikit\` entries are type-checked ` +
          "against the Ethereum kit, so parameters that only exist on that chain (e.g. a token symbol) " +
          "may fail to type-check even though they are valid — check `npx tsc --noEmit`."
      );
    }

    src = src.replace(
      LEGACY_ALLOW_CHAIN,
      (_, chain) => `allow.${RENAMED_CHAINS[chain]}`
    );
    // @zodiaceco/sdk re-exports `c`, `forAll`, `encodeKey` and the permission types.
    src = src.replace(/(["'])zodiac-roles-sdk\1/g, '"@zodiaceco/sdk"');

    if (/["']defi-kit(\/\w+)?["']/.test(src)) {
      todos.push(
        `${file}: still imports defi-kit — use \`defikit\` from "@zodiaceco/sdk/actions" instead (calling defi-kit directly yields compiled permissions, which aren't valid entries).`
      );
    }
    if (/["']zodiac-roles-sdk\/kit["']/.test(src)) {
      todos.push(
        `${file}: imports zodiac-roles-sdk/kit — use the global \`allow\` instead.`
      );
    }
    if (/["'](\.\.?\/)+contracts["']/.test(src)) {
      todos.push(
        `${file}: imports contracts.ts — import zodiac.config.ts instead and read \`config.contracts.<chain prefix>\`.`
      );
    }

    if (src !== original) {
      fs.writeFileSync(file, src);
      touched.add(file);
    }
  }
}

function legacyLeftovers() {
  const found = [];
  if (fs.existsSync(LEGACY_CONTRACTS)) {
    found.push(`${LEGACY_CONTRACTS} (contracts now live in zodiac.config.ts)`);
  }
  if (fs.existsSync(LEGACY_ETH_SDK)) {
    found.push(`${LEGACY_ETH_SDK}/ (ABIs now live in abis/)`);
  }
  if (fs.existsSync("roles")) {
    for (const file of walk("roles")) {
      const src = fs.readFileSync(file, "utf8");
      if (/["']defi-kit(\/\w+)?["']/.test(src)) {
        found.push(`${file} (calls defi-kit directly)`);
      } else if (/["']zodiac-roles-sdk(\/kit)?["']/.test(src)) {
        found.push(`${file} (imports zodiac-roles-sdk)`);
      } else if (new RegExp(LEGACY_ALLOW_CHAIN.source).test(src)) {
        found.push(`${file} (uses chain names in \`allow.\`, not chain prefixes)`);
      }
    }
  }
  return found;
}

// ---------------------------------------------------------------------------
// Small helpers for reading object literals in TypeScript source
// ---------------------------------------------------------------------------

function walk(dir) {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap((entry) => {
      const p = path.join(dir, entry.name);
      return entry.isDirectory() ? walk(p) : [p];
    })
    .sort();
}

// Visits every character of `src` from `from` on that is outside strings and
// comments. Stops when `visit` returns false.
function scanCode(src, from, visit) {
  for (let i = from; i < src.length; i++) {
    const ch = src[i];
    if (ch === "/" && src[i + 1] === "/") {
      const nl = src.indexOf("\n", i);
      i = nl === -1 ? src.length : nl;
      continue;
    }
    if (ch === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end === -1 ? src.length : end + 1;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === "`") {
      const start = i;
      for (i++; i < src.length && src[i] !== ch; i++) {
        if (src[i] === "\\") i++;
      }
      if (visit({ string: true, start, end: i + 1 }) === false) return;
      continue;
    }
    if (visit({ ch, start: i, end: i + 1 }) === false) return;
  }
}

function matchingBrace(src, open) {
  let depth = 0;
  let close = null;
  scanCode(src, open, ({ ch, start }) => {
    if (ch === "{") depth++;
    if (ch === "}" && --depth === 0) {
      close = start;
      return false;
    }
  });
  return close;
}

// The property keys directly inside the object literal opening at `open`.
function objectKeys(src, open) {
  const keys = [];
  let depth = 0;
  let expectKey = false;
  let pending = null;
  scanCode(src, open, (token) => {
    const { ch, string, start, end } = token;
    if (ch === "{" || ch === "[" || ch === "(") {
      depth++;
      expectKey = depth === 1;
      return;
    }
    if (ch === "}" || ch === "]" || ch === ")") {
      if (--depth === 0) return false;
      return;
    }
    if (depth !== 1) return;
    if (pending && ch === ":") {
      keys.push(pending);
      pending = null;
      expectKey = false;
      return;
    }
    if (ch !== undefined && /\s/.test(ch)) return;
    if (ch === ",") {
      expectKey = true;
      pending = null;
      return;
    }
    if (expectKey && string) {
      pending = { name: src.slice(start + 1, end - 1), start, end };
      expectKey = false;
      return;
    }
    if (expectKey && /[A-Za-z_$]/.test(ch)) {
      const name = /[A-Za-z_$][\w$]*/y;
      name.lastIndex = start;
      const [id] = name.exec(src);
      pending = { name: id, start, end: start + id.length };
      expectKey = false;
      return;
    }
    // Still inside the identifier we just read.
    if (pending && !string && start < pending.end) return;
    pending = null;
  });
  return keys;
}

function stripComments(src) {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}
