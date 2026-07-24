// Self-check for the non-trivial logic in token-pool.mjs (cooldown, failover,
// rate-limit detection, reset-time parsing). Run: node test.mjs
import assert from "node:assert/strict";
import {
  isClaudeRateLimit,
  parseResetAt,
  withTokenFailover,
  availableTokens,
  _resetTokenPool,
  ClaudeRateLimitError,
} from "./src/token-pool.mjs";

function test(name, fn) {
  try {
    fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    throw err;
  }
}

async function asyncTest(name, fn) {
  try {
    await fn();
    console.log(`ok - ${name}`);
  } catch (err) {
    console.error(`FAIL - ${name}`);
    throw err;
  }
}

test("isClaudeRateLimit matches real CLI banners", () => {
  assert.equal(isClaudeRateLimit("You've hit your session limit · resets 5pm (UTC)"), true);
  assert.equal(isClaudeRateLimit("429 Too Many Requests"), true);
  assert.equal(isClaudeRateLimit("Here is your refactored function:"), false);
});

test("parseResetAt reads '5pm (UTC)' into a UTC Date", () => {
  const now = new Date(Date.UTC(2026, 6, 4, 10, 0, 0)); // 2026-07-04 10:00 UTC
  const d = parseResetAt("You've hit your session limit · resets 5pm (UTC)", now);
  assert.equal(d.getUTCHours(), 17);
  assert.ok(d.getTime() > now.getTime());
});

test("parseResetAt rolls to tomorrow when the time already passed today", () => {
  const now = new Date(Date.UTC(2026, 6, 4, 20, 0, 0)); // 20:00 UTC
  const d = parseResetAt("resets 5pm (UTC)", now);
  assert.equal(d.getUTCDate(), 5); // rolled to next day
});

test("parseResetAt handles a named IANA zone, not just (UTC) (real CLI output)", () => {
  const now = new Date(2026, 6, 4, 18, 0, 0); // 18:00 local
  const d = parseResetAt("You've hit your session limit · resets 6:10pm (America/Sao_Paulo)", now);
  assert.equal(d.getHours(), 18);
  assert.equal(d.getMinutes(), 10);
  assert.ok(d.getTime() > now.getTime());
});

await asyncTest("withTokenFailover rotates to the next account on a limit error", async () => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN_1 = "token-a";
  process.env.CLAUDE_CODE_OAUTH_TOKEN_2 = "token-b";
  _resetTokenPool();

  const attempts = [];
  const result = await withTokenFailover(async (token, index) => {
    attempts.push({ token, index });
    if (index === 0) throw new Error("You've hit your session limit · resets 11pm (UTC)");
    return "ok-from-" + token;
  });

  assert.equal(result, "ok-from-token-b");
  assert.deepEqual(attempts.map((a) => a.index), [0, 1]);
  // account #1 (index 0) should now be in cooldown, not returned as the first candidate
  assert.equal(availableTokens()[0].index, 1);

  delete process.env.CLAUDE_CODE_OAUTH_TOKEN_1;
  delete process.env.CLAUDE_CODE_OAUTH_TOKEN_2;
});

await asyncTest("withTokenFailover throws ClaudeRateLimitError when every account is limited", async () => {
  process.env.CLAUDE_CODE_OAUTH_TOKEN_1 = "token-a";
  _resetTokenPool();

  await assert.rejects(
    () => withTokenFailover(async () => { throw new Error("rate limit exceeded"); }),
    ClaudeRateLimitError,
  );

  delete process.env.CLAUDE_CODE_OAUTH_TOKEN_1;
});

await asyncTest("withTokenFailover surfaces a rate limit even with NO pool configured (regression)", async () => {
  // No CLAUDE_CODE_OAUTH_TOKEN_* set -> candidates.length === 0 -> the "ambient
  // login, single account" path. This is the exact bug that shipped: this path
  // used to call run() with zero error handling, so a real rate-limit error
  // came out as a plain Error instead of ClaudeRateLimitError, and the runner
  // treated it as fatal instead of sleeping until reset.
  _resetTokenPool();
  assert.equal(availableTokens().length, 0);

  await assert.rejects(
    () => withTokenFailover(async () => {
      throw new Error("You've hit your session limit · resets 11pm (America/Sao_Paulo)");
    }),
    (err) => {
      assert.ok(err instanceof ClaudeRateLimitError, "must be wrapped as ClaudeRateLimitError");
      assert.ok(err.resetAt && err.resetAt > Date.now(), "must carry a future resetAt timestamp");
      return true;
    },
  );
});

console.log("\nAll token-pool self-checks passed.");
