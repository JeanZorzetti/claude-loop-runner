#!/usr/bin/env node
// The supervisor loop. Everything else in this tool is ported from proven
// code (see token-pool.mjs, claude-cli.mjs); this file is the only genuinely
// new part: it ties file-based state (macro_plan.md / current_state.md) to
// repeated fresh `claude --print` calls, with account failover + cooldown.

import { execSync } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { withTokenFailover, ClaudeRateLimitError, earliestResetAt } from "./token-pool.mjs";
import { runClaude } from "./claude-cli.mjs";

function parseArgs(argv) {
  const args = {};
  const positional = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === "--max-iterations") args.maxIterations = Number(argv[++i]);
    else positional.push(a);
  }
  args.targetDir = positional[0];
  return args;
}

function usageError(msg) {
  console.error(`Error: ${msg}\n`);
  console.error("Usage: claude-loop-runner <targetRepoDir> --max-iterations <n>");
  process.exit(1);
}

// Minimal frontmatter reader/writer — no yaml dependency, only the handful of
// scalar fields this tool needs.
function readState(stateFile) {
  const text = readFileSync(stateFile, "utf8");
  const fm = text.match(/^---\n([\s\S]*?)\n---/);
  const fields = {};
  if (fm) {
    for (const line of fm[1].split("\n")) {
      const m = line.match(/^(\w+):\s*(.*)$/);
      if (m) fields[m[1]] = m[2].trim();
    }
  }
  return {
    status: fields.status || "in_progress",
    nextEffort: fields.next_effort || "medium",
    iteration: Number(fields.iteration || 0),
  };
}

function seedStateIfMissing(stateFile) {
  if (existsSync(stateFile)) return;
  writeFileSync(
    stateFile,
    `---\nstatus: in_progress\nnext_effort: medium\niteration: 0\nupdated_at: ${new Date().toISOString()}\n---\n\n## Last completed\n(none yet - first run)\n\n## Next step\n(read macro_plan.md and pick the first task)\n`,
    "utf8",
  );
}

function buildPrompt(nextEffort) {
  const effortNote =
    nextEffort === "high"
      ? "Think this through carefully and weigh tradeoffs before acting."
      : nextEffort === "low"
        ? "Skip deliberation, just implement the next step directly."
        : "";

  return `Read macro_plan.md and current_state.md in this directory. current_state.md tells you what is already done and what the next step is.

${effortNote}

Do ONLY the next step (one task from macro_plan.md), then rewrite current_state.md:
- Update the YAML frontmatter: status (in_progress | done | blocked), next_effort (low | medium | high — match the tag of the NEXT task in macro_plan.md, default medium), iteration (increment by 1), updated_at (ISO timestamp).
- Under "## Last completed", describe exactly what you just did.
- Under "## Next step", describe the next task in enough detail to resume cold, with no other context.
- If every task in macro_plan.md is done, set status: done.
- If you are stuck and cannot make progress (missing credentials, ambiguous requirement, external blocker), set status: blocked and explain why under "## Next step" instead of guessing.

Commit your work with git before finishing this turn.`;
}

// ponytail: no worktree, no branch — by explicit decision (2026-07), every
// commit lands straight on main and gets pushed immediately (deploy is
// automatic on push to main for this project). The only guardrails left are
// --disallowedTools (no force-push/reset --hard) and this branch check.
function requireMainCheckedOut(targetDir) {
  const branch = execSync("git rev-parse --abbrev-ref HEAD", { cwd: targetDir }).toString().trim();
  if (branch !== "main") {
    usageError(`${targetDir} has "${branch}" checked out, not "main". Check out main before running (pushes go straight to main now).`);
  }
}

// Remote main moves on its own (Actions crons, PR merges) — always rebase on
// top of origin before building or pushing, or the push gets rejected and the
// iteration builds against a stale tree. A rebase conflict throws -> the
// iteration fails -> loop stops for human review, which is the right outcome.
function syncMain(targetDir) {
  execSync("git pull --rebase --autostash origin main", { cwd: targetDir, stdio: "inherit" });
}

function pushMain(targetDir) {
  syncMain(targetDir);
  execSync("git push origin main", { cwd: targetDir, stdio: "inherit" });
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function main() {
  const { targetDir, maxIterations } = parseArgs(process.argv.slice(2));
  if (!targetDir) usageError("missing <targetRepoDir>");
  if (!Number.isFinite(maxIterations) || maxIterations <= 0) {
    usageError("--max-iterations is required and must be a positive number (no unlimited default — see plan safeguards)");
  }
  if (!existsSync(path.join(targetDir, "macro_plan.md"))) {
    usageError(`${targetDir} has no macro_plan.md — write the 3-month scope there first, then run this tool`);
  }
  requireMainCheckedOut(targetDir);

  const stateFile = path.join(targetDir, "current_state.md");
  seedStateIfMissing(stateFile);

  console.log(`[runner] working directly on main in ${targetDir}, max ${maxIterations} iterations (every commit pushes immediately)`);

  for (let iteration = 1; iteration <= maxIterations; iteration++) {
    const state = readState(stateFile);
    if (state.status === "done") {
      console.log(`[runner] status: done at iteration ${iteration - 1}. Stopping.`);
      return;
    }
    if (state.status === "blocked") {
      console.log(`[runner] status: blocked. See ${stateFile} for why. Stopping for human review.`);
      return;
    }

    console.log(`[runner] iteration ${iteration}/${maxIterations} (effort: ${state.nextEffort})`);
    const prompt = buildPrompt(state.nextEffort);

    try {
      syncMain(targetDir); // fresh origin/main before the work starts, not just before the push
      const result = await withTokenFailover((token) => runClaude(prompt, { cwd: targetDir, oauthToken: token, effort: state.nextEffort, model: "claude-opus-4-8" }));
      console.log(`[runner] iteration ${iteration} done. usage: ${JSON.stringify(result.usage)}`);
      pushMain(targetDir);
      console.log(`[runner] pushed to origin main.`);
    } catch (err) {
      if (err instanceof ClaudeRateLimitError) {
        const resetAt = err.resetAt ?? earliestResetAt() ?? Date.now() + 5 * 60 * 1000;
        const waitMs = Math.max(resetAt - Date.now(), 0);
        console.log(`[runner] all accounts limited, sleeping ${Math.round(waitMs / 60000)}min until reset (${new Date(resetAt).toLocaleString()})...`);
        await sleep(waitMs);
        iteration--; // this attempt didn't count — don't burn the iteration budget on a wait
        continue;
      }
      console.error(`[runner] iteration ${iteration} failed: ${err.message}. Stopping for human review.`);
      return;
    }
  }

  console.log(`[runner] max iterations (${maxIterations}) reached without status: done. Check ${stateFile}.`);
}

main();
