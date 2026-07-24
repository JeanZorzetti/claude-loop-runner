// Ported from ROI Labs\Imob\sofia-next: src/lib/ai/claude-token-pool.ts +
// src/lib/companies/company-resilience.ts (parseResetAt). Same regexes, same
// cooldown model — validated in production there, reused here as-is.

const DEFAULT_COOLDOWN_MS = 5 * 60 * 60 * 1000; // 5h, matches the Claude usage window

function cooldownMs() {
  const raw = Number(process.env.CLAUDE_TOKEN_COOLDOWN_MS);
  return Number.isFinite(raw) && raw > 0 ? raw : DEFAULT_COOLDOWN_MS;
}

let _cached = null;

// Precedence: CLAUDE_CODE_OAUTH_TOKENS (comma/newline list) > CLAUDE_CODE_OAUTH_TOKEN_1.._N > CLAUDE_CODE_OAUTH_TOKEN
export function loadTokens() {
  if (_cached) return _cached;
  const out = [];

  const list = process.env.CLAUDE_CODE_OAUTH_TOKENS;
  if (list && list.trim()) {
    out.push(...list.split(/[,\n]/).map((s) => s.trim()).filter(Boolean));
  }

  if (out.length === 0) {
    for (let i = 1; i <= 20; i++) {
      const v = process.env[`CLAUDE_CODE_OAUTH_TOKEN_${i}`];
      if (v && v.trim()) out.push(v.trim());
    }
  }

  if (out.length === 0) {
    const single = process.env.CLAUDE_CODE_OAUTH_TOKEN;
    if (single && single.trim()) {
      out.push(...single.split(/[,\n]/).map((s) => s.trim()).filter(Boolean));
    }
  }

  _cached = [...new Set(out)];
  return _cached;
}

export function _resetTokenPool() {
  _cached = null;
  cooldownUntil.clear();
}

const cooldownUntil = new Map(); // token index -> epochMs free-at

export function markTokenLimited(index, ms = cooldownMs()) {
  cooldownUntil.set(index, Date.now() + ms);
}

// Tokens not cooling, in pool order. If ALL are cooling, the soonest-to-free
// one is returned LAST so a final attempt still lands on the best candidate.
export function availableTokens() {
  const tokens = loadTokens();
  const now = Date.now();
  const free = [];
  const cooling = [];
  tokens.forEach((token, index) => {
    const until = cooldownUntil.get(index) ?? 0;
    if (until <= now) free.push({ index, token });
    else cooling.push({ index, token, until });
  });
  if (free.length > 0) return free;
  cooling.sort((a, b) => b.until - a.until);
  return cooling.map(({ index, token }) => ({ index, token }));
}

export function earliestResetAt() {
  const whens = [...cooldownUntil.values()];
  return whens.length ? Math.min(...whens) : null;
}

// Matches real Claude Code limit messages, which can arrive on stderr OR as
// the success output itself (exit 0), e.g. "You've hit your session limit ·
// resets 5pm (UTC)". Word boundaries avoid false positives like "rate limiter".
const RATE_LIMIT_RE =
  /\brate[\s_-]?limit\b|\b(usage|session|weekly|daily|hourly|opus|sonnet)\s+limit\b|hit your .{0,30}?\blimit\b|\blimit reached\b|reached your .{0,30}?\blimit\b|too many requests|\b429\b|\bquota\b|resets?\b[^.\n]{0,20}\([^)]+\)/i;

export function isClaudeRateLimit(text) {
  return !!text && RATE_LIMIT_RE.test(text);
}

export class ClaudeRateLimitError extends Error {
  constructor(message, resetAt = null) {
    super(message);
    this.name = "ClaudeRateLimitError";
    this.resetAt = resetAt; // epochMs, when known
  }
}

// Parses "resets 5pm (UTC)" / "resets 6:10pm (America/Sao_Paulo)" style
// banners into the next Date it refers to (rolls to tomorrow if that time
// already passed). The CLI doesn't always print UTC — observed live output
// used the session's own IANA zone name instead.
export function parseResetAt(text, now = new Date()) {
  if (!text) return null;
  const m = text.match(/resets?\s+(\d{1,2})(?::(\d{2}))?\s*(am|pm)?\s*\(([^)]+)\)/i);
  if (!m) return null;
  let hour = parseInt(m[1], 10);
  const min = m[2] ? parseInt(m[2], 10) : 0;
  const ampm = m[3]?.toLowerCase();
  const zone = m[4].trim().toLowerCase();
  if (ampm === "pm" && hour < 12) hour += 12;
  if (ampm === "am" && hour === 12) hour = 0;
  if (hour > 23 || min > 59) return null;

  const isUtc = zone === "utc";
  // ponytail: a named zone (e.g. "america/sao_paulo") is assumed to be this
  // machine's own local zone -- true for a personal single-machine tool.
  // Upgrade to a real IANA offset lookup if this ever runs somewhere else.
  const d = isUtc
    ? new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate(), hour, min, 0, 0))
    : new Date(now.getFullYear(), now.getMonth(), now.getDate(), hour, min, 0, 0);
  if (d.getTime() <= now.getTime()) {
    if (isUtc) d.setUTCDate(d.getUTCDate() + 1);
    else d.setDate(d.getDate() + 1);
  }
  return d;
}

/**
 * Runs `run(token, index)` against the pool with automatic failover: on a
 * limited error the current token goes into cooldown and the next available
 * token is tried. Pool empty -> single ambient attempt (no pool configured).
 * When every token is exhausted, throws ClaudeRateLimitError.
 */
export async function withTokenFailover(run, { isLimited = isClaudeRateLimit } = {}) {
  const candidates = availableTokens();
  if (candidates.length === 0) {
    // No pool configured (ambient CLI login, single account) -- still must
    // detect+surface a rate limit here, or it looks like a fatal error and
    // the caller never sleeps/retries (this is the bug that shipped first).
    try {
      return await run(undefined, 0);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!isLimited(msg)) throw err;
      const resetAt = parseResetAt(msg);
      throw new ClaudeRateLimitError(msg, resetAt ? resetAt.getTime() : null);
    }
  }

  const poolSize = loadTokens().length;
  let lastErr;
  for (let i = 0; i < candidates.length; i++) {
    const { index, token } = candidates[i];
    try {
      return await run(token, index);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      if (!isLimited(msg)) throw err;
      const resetAt = parseResetAt(msg);
      markTokenLimited(index, resetAt ? resetAt.getTime() - Date.now() : undefined);
      lastErr = err;
      const next = candidates[i + 1];
      if (next) {
        console.warn(`[token-pool] account #${index + 1} limited -> rotating to #${next.index + 1} (pool of ${poolSize})`);
      } else {
        console.warn(`[token-pool] all ${candidates.length} available account(s) limited (pool of ${poolSize})`);
      }
    }
  }
  throw new ClaudeRateLimitError(
    `All ${candidates.length} Claude account(s) are rate-limited. Last error: ${
      lastErr instanceof Error ? lastErr.message : String(lastErr)
    }`,
    earliestResetAt(),
  );
}
