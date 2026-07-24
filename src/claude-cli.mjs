// Ported from ROI Labs\Imob\sofia-next: src/services/claude-cli-service.ts.
// Same invocation shape (stdin prompt, --system-prompt-file, env hygiene,
// ANSI strip, JSON parse), trimmed to what a generic standalone loop needs.

import { spawn } from "node:child_process";
import { writeFileSync, unlinkSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { isClaudeRateLimit } from "./token-pool.mjs";

const DEFAULT_TIMEOUT_MS = 20 * 60 * 1000; // 20min per call, matches the proven value

// Hard-blocked regardless of permission mode. `--dangerously-skip-permissions`
// is otherwise required for a fully unattended loop, but these two commands
// must never run unattended even so (see plan: "Salvaguardas").
// Pattern syntax confirmed against `claude --help` + this machine's own
// plugin hooks (ralph-loop uses "Bash(test -f x:*)" / exact "Bash(rm x)"):
// prefix match needs `:*`, a bare trailing `*` is NOT a wildcard.
const DEFAULT_DISALLOWED_TOOLS = [
  "Bash(git push --force:*)",
  "Bash(git push -f:*)",
  "Bash(git reset --hard:*)",
];

// Windows .cmd shims (npm-installed CLIs) can only be spawned through a
// shell — but `shell:true` + an args array joins them with plain spaces, so
// any argument containing whitespace (e.g. the comma-joined --disallowedTools
// value) gets re-split into bogus options by cmd.exe. Quoting is only needed
// on this path; the values here are ours (fixed literals, tmpdir paths, enum
// words), not arbitrary/adversarial input.
function quoteWinArg(s) {
  s = String(s);
  if (s !== "" && !/[\s"^&|<>()]/.test(s)) return s;
  return `"${s.replace(/"/g, '\\"')}"`;
}

function stripAnsi(output) {
  const ansi = new RegExp(String.fromCharCode(27) + "\\[\\d+m", "g");
  return output.replace(ansi, "").trim();
}

function parseResult(stdout) {
  const text = stripAnsi(stdout);
  try {
    const json = JSON.parse(text);
    const content = typeof json.result === "string" ? json.result : text;
    const u = json.usage || {};
    return {
      content: content.trim(),
      usage: {
        input_tokens: u.input_tokens ?? 0,
        output_tokens: u.output_tokens ?? 0,
        cost_usd: json.total_cost_usd ?? 0,
      },
    };
  } catch {
    return { content: text, usage: null };
  }
}

/**
 * Runs one non-interactive `claude --print` call. No `--continue`/`--resume`
 * is ever passed, so every call starts a fresh session — that's what keeps
 * context from growing across loop iterations (see plan point 3).
 *
 * @param {string} prompt
 * @param {object} opts
 * @param {string} opts.cwd - working directory (the target project's worktree)
 * @param {string} [opts.oauthToken] - CLAUDE_CODE_OAUTH_TOKEN for this call (token-pool failover)
 * @param {string} [opts.effort] - low|medium|high|xhigh|max
 * @param {string} [opts.model]
 * @param {string} [opts.systemPrompt]
 * @param {string[]} [opts.allowedTools]
 * @param {string[]} [opts.disallowedTools] - merged with DEFAULT_DISALLOWED_TOOLS
 * @param {string} [opts.permissionMode] - default "bypassPermissions" (required for unattended runs)
 * @param {number} [opts.timeoutMs]
 * @returns {Promise<{content: string, usage: object|null}>}
 */
export function runClaude(prompt, opts = {}) {
  const {
    cwd = process.cwd(),
    oauthToken,
    effort,
    model,
    systemPrompt,
    allowedTools,
    disallowedTools = [],
    permissionMode = "bypassPermissions",
    timeoutMs = DEFAULT_TIMEOUT_MS,
  } = opts;

  const tempId = Math.random().toString(36).slice(2, 15);
  let sysPromptPath = null;
  const cleanup = () => {
    if (sysPromptPath && existsSync(sysPromptPath)) {
      try { unlinkSync(sysPromptPath); } catch { /* best effort */ }
    }
  };

  return new Promise((resolve, reject) => {
    const args = ["--print", "--output-format", "json", "--permission-mode", permissionMode];

    const disallowed = [...DEFAULT_DISALLOWED_TOOLS, ...disallowedTools];
    args.push("--disallowedTools", disallowed.join(","));
    if (allowedTools?.length) args.push("--allowedTools", allowedTools.join(","));
    if (model) args.push("--model", model);
    if (effort) args.push("--effort", effort);

    if (systemPrompt) {
      sysPromptPath = path.join(tmpdir(), `claude_sys_${tempId}.txt`);
      writeFileSync(sysPromptPath, systemPrompt, "utf8");
      args.push("--system-prompt-file", sysPromptPath);
    }

    // Strip API credentials so the CLI bills the subscription (via
    // CLAUDE_CODE_OAUTH_TOKEN) instead of silently switching to metered API billing.
    const env = { ...process.env, CI: "true" };
    delete env.ANTHROPIC_API_KEY;
    delete env.ANTHROPIC_AUTH_TOKEN;
    if (oauthToken) env.CLAUDE_CODE_OAUTH_TOKEN = oauthToken;

    // Windows: claude.cmd needs a shell to run at all, so build+quote the
    // full line ourselves (see quoteWinArg). Elsewhere, plain argv is both
    // simpler and safer (no shell in the middle).
    let child;
    if (process.platform === "win32") {
      const cmdLine = ["claude.cmd", ...args].map(quoteWinArg).join(" ");
      child = spawn(cmdLine, [], { cwd, env, shell: true });
    } else {
      child = spawn("claude", args, { cwd, env });
    }

    let stdoutData = "";
    let stderrData = "";
    child.stdout.on("data", (d) => (stdoutData += d.toString()));
    child.stderr.on("data", (d) => (stderrData += d.toString()));

    child.on("error", (error) => {
      cleanup();
      reject(new Error(`Failed to start Claude CLI: ${error.message}`));
    });

    const timer = setTimeout(() => {
      child.kill();
      cleanup();
      reject(new Error(`Claude CLI timed out after ${timeoutMs}ms`));
    }, timeoutMs);

    child.on("close", (code) => {
      clearTimeout(timer);
      cleanup();
      if (code !== 0 && stderrData.trim()) {
        reject(new Error(stderrData.trim()));
        return;
      }
      const result = parseResult(stdoutData);
      // The CLI can print the limit banner to stdout with exit 0 (a normal
      // "successful" response) instead of a non-zero exit. Reject on it so
      // the token-pool failover rotates accounts instead of treating the
      // banner text as the agent's actual answer. A real banner is a short
      // one-liner — a LONG answer that merely mentions "limit"/"resets" is
      // the agent talking, not a banner (false positive shipped 2026-07-05:
      // a success summary got rejected as an error, sliced to 300 chars, and
      // the slice no longer matched the regex, so it surfaced as a generic
      // failure). Never slice the message: the failover re-tests it with the
      // same regex and must see the same text.
      if (result.content.length < 500 && isClaudeRateLimit(result.content)) {
        reject(new Error(result.content || "Claude usage limit"));
        return;
      }
      resolve(result);
    });

    child.stdin.write(prompt);
    child.stdin.end();
  });
}
