#!/usr/bin/env node
// Sync a project created from the permissions-starter-kit template with the
// latest template version.
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
// example roles are never brought into your project by a sync.
//
// The script is idempotent: run it again after resolving conflicts and
// committing, and it will clean up after itself. Once the first sync merge
// is committed, your history is permanently related to the template's —
// future updates are a plain `git fetch upstream && git merge upstream/main`
// (though running this script keeps the roles/ guarantee).

import { execSync } from "child_process";

const UPSTREAM_URL =
  "https://github.com/gnosisguild/permissions-starter-kit.git";
// SYNC_TEMPLATE_REF is a testing/advanced knob: point the sync at another
// (possibly local) ref instead of upstream/main; skips the upstream fetch.
const UPSTREAM = process.env.SYNC_TEMPLATE_REF ?? "upstream/main";
const SCRIPT_PATH = ".lib/scripts/sync-template.mjs";

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
const fail = (msg) => {
  console.error(`\n✗ ${msg}`);
  process.exit(1);
};

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
      `then run this script once more to finish cleaning up.`
  );
}

// Clean up a leftover graft from a previous (committed or aborted) run.
const replaceRefs = sh("git replace -l 2>/dev/null || true")
  .split("\n")
  .filter(Boolean);
for (const ref of replaceRefs) {
  sh(`git replace -d ${ref}`);
}

// Require a clean tree — but tolerate this script itself (freshly checked out
// of upstream) and untracked files.
const dirty = sh("git status --porcelain")
  .split("\n")
  .filter(Boolean)
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
if (!process.env.SYNC_TEMPLATE_REF) {
  if (trySh("git remote get-url upstream") === null) {
    console.log("Adding upstream remote...");
    sh(`git remote add upstream ${UPSTREAM_URL}`);
  }
  console.log("Fetching upstream...");
  sh("git fetch upstream");
}

// ---------------------------------------------------------------------------
// Already related? Then this is a plain merge.
// ---------------------------------------------------------------------------

if (trySh(`git merge-base HEAD ${UPSTREAM}`) !== null) {
  if (sh(`git rev-list -1 ${UPSTREAM} --not HEAD`) === "") {
    console.log("\n✓ Already up to date with the template.");
    process.exit(0);
  }
  console.log(
    "Histories are already related — running a regular merge.\n" +
      "(You won't need this script for future updates.)\n"
  );
  merge();
  process.exit(0);
}

// ---------------------------------------------------------------------------
// Find the template version this repo was created from
// ---------------------------------------------------------------------------

const roots = sh("git rev-list --max-parents=0 HEAD").split("\n");
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
  sh(`git diff --name-only ${a} ${b} -- . ":!${SCRIPT_PATH}"`)
    .split("\n")
    .filter(Boolean).length;

if (!base || diffCount(base, root) > 0) {
  console.log("Scanning template history for the closest match...");
  let best = null;
  let bestCount = Infinity;
  for (const c of sh(`git rev-list ${UPSTREAM}`).split("\n")) {
    const n = diffCount(c, root);
    if (n < bestCount) {
      bestCount = n;
      best = c;
    }
    if (n === 0) break;
  }
  const totalFiles = sh(`git ls-tree -r --name-only ${root}`)
    .split("\n")
    .filter(Boolean).length;
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

  keepOwnRolesDir();

  const unresolved = sh("git diff --name-only --diff-filter=U")
    .split("\n")
    .filter(Boolean);
  if (unresolved.length > 0) {
    console.log(
      "\nMerge stopped with conflicts — only files where both you and the\n" +
        "template changed the same lines. Resolve them, then:\n" +
        "  git commit\n" +
        "  node .lib/scripts/sync-template.mjs   # cleans up and confirms\n" +
        "  yarn install"
    );
    process.exit(0);
  }

  // Nothing left to resolve (either the merge was clean, or the only
  // conflicts were under roles/ and we kept our side): commit it.
  if (conflicted || trySh("git rev-parse -q --verify MERGE_HEAD") !== null) {
    sh("git commit --no-edit");
  }

  // Merge committed: drop the graft, it has served its purpose.
  for (const ref of sh("git replace -l 2>/dev/null || true")
    .split("\n")
    .filter(Boolean)) {
    sh(`git replace -d ${ref}`);
  }
  console.log(
    "\n✓ Synced with the latest template. Now run: yarn install\n" +
      "Future updates only need: git fetch upstream && git merge upstream/main"
  );
}

// The roles/ directory is entirely user-owned: template-side changes to the
// example roles must never propagate into user projects. Reset everything
// under roles/ to our pre-merge state, whatever the merge brought in.
function keepOwnRolesDir() {
  // What did the merge stage (or leave conflicted) under roles/? The merge
  // only touches paths where the template side differs from the merge base,
  // so this is exactly the set of template-side changes we're about to skip.
  const touched = sh("git status --porcelain -- roles/")
    .split("\n")
    .filter(Boolean)
    .filter((line) => !line.startsWith("??"));
  if (touched.length === 0) return;

  // Restore all files that exist in HEAD (undoes template modifications and
  // deletions, and resolves such conflicts to our version).
  trySh("git checkout HEAD -- roles/");

  // Drop files the merge staged under roles/ that HEAD doesn't have
  // (template-added files, including add/add conflict entries).
  const ours = new Set(
    (trySh("git ls-tree -r --name-only HEAD -- roles/") ?? "")
      .split("\n")
      .filter(Boolean)
  );
  const staged = (trySh("git ls-files -- roles/") ?? "")
    .split("\n")
    .filter(Boolean);
  for (const p of new Set(staged.filter((p) => !ours.has(p)))) {
    sh(`git rm -q -f -- "${p}"`);
  }

  console.log(
    `\nSkipped ${touched.length} template change(s) under roles/ — that` +
      " directory is yours and is never touched by template syncs."
  );
}
