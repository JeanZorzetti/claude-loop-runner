// Asserts the JSON-LD on index.html still describes the page that is actually there.
// The failure this catches: copy gets edited, @graph does not, and the answer engine
// is handed a Q&A pair no human ever sees. Run: node site/check-geo.mjs
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const dir = path.dirname(fileURLToPath(import.meta.url));
const html = fs.readFileSync(path.join(dir, "index.html"), "utf8");
const strip = (s) => s.replace(/<[^>]+>/g, "").replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&amp;/g, "&").replace(/\s+/g, " ").trim();

const blocks = [...html.matchAll(/<script type="application\/ld\+json">([\s\S]*?)<\/script>/g)];
assert.equal(blocks.length, 1, "exactly one JSON-LD block (schema stacking, not scattered scripts)");

const graph = JSON.parse(blocks[0][1])["@graph"];
const ids = new Set(graph.map((n) => n["@id"]));
const refs = JSON.stringify(graph).match(/\{"@id":"[^"]+"\}/g) || [];
for (const r of refs) {
  const id = JSON.parse(r)["@id"];
  assert.ok(ids.has(id), `dangling @id reference: ${id}`);
}
assert.ok(!JSON.stringify(graph).includes("PLACEHOLDER"), "no placeholder values in production schema");

const canonical = html.match(/<link rel="canonical" href="([^"]+)"/)[1];
const page = graph.find((n) => [].concat(n["@type"]).includes("WebPage"));
assert.equal(page.url, canonical, "WebPage.url must match the canonical");

// every schema question must exist verbatim as a visible <dt>, and its answer as the <dd> under it
const visible = new Map();
for (const m of html.matchAll(/<dt>([\s\S]*?)<\/dt>\s*<dd>([\s\S]*?)<\/dd>/g)) visible.set(strip(m[1]), strip(m[2]));
assert.ok(visible.size >= 5, `expected the FAQ block on the page, found ${visible.size} pairs`);

for (const q of page.mainEntity) {
  const name = q.name.replace("claude-loop-runner?", "it?"); // the schema name may be disambiguated
  const shown = visible.get(q.name) ?? visible.get(name);
  assert.ok(shown, `question in schema but not on the page: ${q.name}`);
  const answer = q.acceptedAnswer.text.replace(/[ \t\r\n]+/g, " ").trim(); // plain text, not HTML — never tag-strip it
  const words = answer.split(" ").length;
  assert.ok(words >= 35 && words <= 70, `answer capsule should be 35-70 words, got ${words}: ${q.name}`);
  // compare ignoring the code-formatting differences the HTML adds
  const norm = (s) => s.toLowerCase().replace(/[^a-z0-9]+/g, "");
  assert.equal(norm(shown), norm(answer), `answer text drifted from the page: ${q.name}`);
}

const robots = fs.readFileSync(path.join(dir, "robots.txt"), "utf8");
for (const bot of ["GPTBot", "OAI-SearchBot", "ClaudeBot", "PerplexityBot", "Google-Extended", "GoogleOther"]) {
  assert.match(robots, new RegExp(`User-agent: ${bot}\s*\nAllow: /`), `robots.txt must allow ${bot}`);
}
assert.ok(fs.existsSync(path.join(dir, "llms.txt")), "llms.txt must exist at the site root");

console.log(`ok — 1 @graph, ${graph.length} nodes, ${page.mainEntity.length} Q&A pairs matched to the page`);
