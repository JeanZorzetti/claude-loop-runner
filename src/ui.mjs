#!/usr/bin/env node
// Minimal local UI for the loop runner: one page — pick repo/iterations/tokens,
// start/stop, watch live logs (SSE) and current_state.md. Zero dependencies,
// binds 127.0.0.1 only (OAuth tokens travel through it).
//
//   node src/ui.mjs            -> http://127.0.0.1:4517
//   node src/ui.mjs --check    -> boot + smoke-test + exit

import { createServer } from "node:http";
import { spawn, execSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const RUNNER = path.join(ROOT, "src", "runner.mjs");
const PORT = Number(process.env.PORT) || 4517;
const DEFAULT_TARGET = "C:\\Users\\jeanz\\OneDrive\\Desktop\\ROI Labs\\ROI Labs";

// Optional .env next to package.json (KEY=VALUE lines, no expansion) so tokens
// survive across sessions without re-pasting. Never overrides real env.
const envFile = path.join(ROOT, ".env");
if (existsSync(envFile)) {
  for (const line of readFileSync(envFile, "utf8").split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !(m[1] in process.env)) process.env[m[1]] = m[2];
  }
}

function envTokenCount() {
  const list = process.env.CLAUDE_CODE_OAUTH_TOKENS;
  if (list && list.trim()) return list.split(/[,\n]/).filter((s) => s.trim()).length;
  let n = 0;
  for (let i = 1; i <= 20; i++) if (process.env[`CLAUDE_CODE_OAUTH_TOKEN_${i}`]?.trim()) n++;
  if (n > 0) return n;
  return process.env.CLAUDE_CODE_OAUTH_TOKEN?.trim() ? 1 : 0;
}

// ---- run state ----------------------------------------------------------
let child = null;
let run = { running: false, targetDir: DEFAULT_TARGET, startedAt: null, exitCode: null };
const logBuf = [];
const sseClients = new Set();

function pushLog(line) {
  logBuf.push(line);
  if (logBuf.length > 2000) logBuf.splice(0, logBuf.length - 2000);
  const payload = `data: ${JSON.stringify(line)}\n\n`;
  for (const res of sseClients) res.write(payload);
}

function wireOutput(stream, tag) {
  let acc = "";
  stream.on("data", (chunk) => {
    acc += chunk.toString();
    const lines = acc.split(/\r?\n/);
    acc = lines.pop();
    for (const l of lines) if (l.trim()) pushLog(tag ? `${tag} ${l}` : l);
  });
  stream.on("end", () => {
    if (acc.trim()) pushLog(tag ? `${tag} ${acc}` : acc);
  });
}

function startRun({ targetDir, maxIterations, tokens }) {
  if (child) return { error: "já existe um run em andamento" };
  if (!targetDir || !existsSync(targetDir)) return { error: `repo alvo não existe: ${targetDir}` };
  if (!existsSync(path.join(targetDir, "macro_plan.md"))) return { error: `${targetDir} não tem macro_plan.md` };
  const n = Number(maxIterations);
  if (!Number.isFinite(n) || n <= 0) return { error: "max iterations deve ser um número positivo" };

  const env = { ...process.env };
  if (tokens && tokens.trim()) env.CLAUDE_CODE_OAUTH_TOKENS = tokens.trim();
  else if (envTokenCount() === 0) return { error: "nenhum token: cole na caixa ou defina CLAUDE_CODE_OAUTH_TOKEN(S) / .env" };

  run = { running: true, targetDir, startedAt: new Date().toISOString(), exitCode: null };
  pushLog(`[ui] iniciando: node runner.mjs "${targetDir}" --max-iterations ${n}`);
  child = spawn(process.execPath, [RUNNER, targetDir, "--max-iterations", String(n)], {
    cwd: ROOT,
    env,
    stdio: ["ignore", "pipe", "pipe"],
  });
  wireOutput(child.stdout, "");
  wireOutput(child.stderr, "[err]");
  child.on("exit", (code) => {
    run.running = false;
    run.exitCode = code;
    child = null;
    pushLog(`[ui] runner terminou (exit ${code}). Confira current_state.md.`);
  });
  return { ok: true };
}

function stopRun() {
  if (!child) return { error: "nada rodando" };
  pushLog("[ui] parando (mata a iteração no meio — depois confira `git status` no repo alvo)...");
  try {
    if (process.platform === "win32") execSync(`taskkill /pid ${child.pid} /t /f`, { stdio: "ignore" });
    else child.kill("SIGTERM");
  } catch (err) {
    return { error: `taskkill falhou: ${err.message}` };
  }
  return { ok: true };
}

function readStateFile(dir) {
  const f = path.join(dir || run.targetDir, "current_state.md");
  try {
    return existsSync(f) ? readFileSync(f, "utf8") : null;
  } catch {
    return null;
  }
}

// ---- http ----------------------------------------------------------------
const PAGE = `<!doctype html>
<html lang="pt-BR"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>claude-loop-runner</title>
<style>
  :root{--bg:#0f1115;--panel:#171a21;--line:#2a2f3a;--fg:#d7dae0;--dim:#8b919d;--ok:#4ade80;--bad:#f87171;--accent:#7aa2f7}
  *{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 ui-monospace,Consolas,monospace}
  .wrap{max-width:1100px;margin:0 auto;padding:20px;display:grid;gap:14px}
  h1{font-size:16px;margin:0}h1 small{color:var(--dim);font-weight:normal}
  .panel{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:14px}
  label{display:block;color:var(--dim);font-size:12px;margin:8px 0 3px}
  input,textarea{width:100%;background:var(--bg);color:var(--fg);border:1px solid var(--line);border-radius:6px;padding:7px 9px;font:inherit}
  textarea{min-height:64px;resize:vertical}
  .row{display:grid;grid-template-columns:1fr 140px;gap:10px}
  .btns{display:flex;gap:10px;margin-top:12px;align-items:center}
  button{border:0;border-radius:6px;padding:9px 18px;font:inherit;cursor:pointer;font-weight:bold}
  #start{background:var(--accent);color:#0f1115}#stop{background:var(--bad);color:#0f1115}
  button:disabled{opacity:.35;cursor:default}
  .chip{display:inline-block;padding:2px 10px;border-radius:99px;border:1px solid var(--line);color:var(--dim);font-size:12px}
  .chip.on{color:var(--ok);border-color:var(--ok)}
  .warn{color:#fbbf24;font-size:12px}
  pre{margin:0;white-space:pre-wrap;word-break:break-word;max-height:420px;overflow-y:auto;font-size:12.5px}
  #state{max-height:260px;color:var(--dim)}
  .cols{display:grid;grid-template-columns:1fr 1fr;gap:14px}
  @media(max-width:800px){.cols{grid-template-columns:1fr}}
  h2{font-size:12px;color:var(--dim);margin:0 0 8px;text-transform:uppercase;letter-spacing:.08em}
</style></head><body><div class="wrap">
  <h1>claude-loop-runner <small>— UI local</small> <span id="chip" class="chip">parado</span></h1>
  <div class="panel">
    <div class="row">
      <div><label>Repo alvo (precisa ter macro_plan.md e main checked out)</label>
        <input id="dir" value="__DEFAULT_TARGET__"></div>
      <div><label>Max iterations</label><input id="max" type="number" value="24" min="1"></div>
    </div>
    <label>Tokens (um por linha; vazio = usa as envs do servidor — <span id="envtok">__ENVTOK__</span> detectada(s))</label>
    <textarea id="tokens" placeholder="sk-ant-oat01-..."></textarea>
    <div class="btns">
      <button id="start">Iniciar</button>
      <button id="stop" disabled>Parar</button>
      <span class="warn">⚠ cada commit vai direto pra main e deploya em produção</span>
    </div>
  </div>
  <div class="cols">
    <div class="panel"><h2>Log ao vivo</h2><pre id="log"></pre></div>
    <div class="panel"><h2>current_state.md</h2><pre id="state">(ainda não existe)</pre></div>
  </div>
</div>
<script>
  const $=id=>document.getElementById(id);
  for(const k of ["dir","max","tokens"]){ const v=localStorage.getItem("lr_"+k); if(v)$(k).value=v;
    $(k).addEventListener("input",()=>localStorage.setItem("lr_"+k,$(k).value)); }
  const log=$("log");
  new EventSource("/logs").onmessage=e=>{ log.textContent+=JSON.parse(e.data)+"\\n";
    log.scrollTop=log.scrollHeight; };
  async function post(u,body){ const r=await fetch(u,{method:"POST",headers:{"content-type":"application/json"},body:JSON.stringify(body||{})}); const j=await r.json(); if(j.error)alert(j.error); return j; }
  $("start").onclick=()=>post("/start",{targetDir:$("dir").value.trim(),maxIterations:$("max").value,tokens:$("tokens").value});
  $("stop").onclick=()=>post("/stop");
  async function tick(){ try{
    const s=await (await fetch("/status?dir="+encodeURIComponent($("dir").value.trim()))).json();
    $("chip").textContent=s.running?"rodando":(s.exitCode==null?"parado":"terminou (exit "+s.exitCode+")");
    $("chip").className="chip"+(s.running?" on":"");
    $("start").disabled=s.running; $("stop").disabled=!s.running;
    $("envtok").textContent=s.tokensEnv;
    if(s.state){ const m=s.state.match(/status:\\s*(\\w+)/), i=s.state.match(/iteration:\\s*(\\d+)/);
      $("state").textContent=(m?"["+m[1]+(i?" · iteração "+i[1]:"")+"]\\n\\n":"")+s.state; }
  }catch{} }
  tick(); setInterval(tick,4000);
</script></body></html>`;

function json(res, code, obj) {
  res.writeHead(code, { "content-type": "application/json" });
  res.end(JSON.stringify(obj));
}

function readBody(req) {
  return new Promise((resolve) => {
    let acc = "";
    req.on("data", (c) => (acc += c));
    req.on("end", () => {
      try {
        resolve(JSON.parse(acc || "{}"));
      } catch {
        resolve({});
      }
    });
  });
}

const server = createServer(async (req, res) => {
  const url = new URL(req.url, "http://x");
  if (req.method === "GET" && url.pathname === "/") {
    res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
    res.end(PAGE.replace("__DEFAULT_TARGET__", DEFAULT_TARGET.replace(/\\/g, "\\\\")).replace("__ENVTOK__", String(envTokenCount())));
  } else if (req.method === "GET" && url.pathname === "/status") {
    json(res, 200, { ...run, tokensEnv: envTokenCount(), state: readStateFile(url.searchParams.get("dir")) });
  } else if (req.method === "GET" && url.pathname === "/logs") {
    res.writeHead(200, { "content-type": "text/event-stream", "cache-control": "no-cache", connection: "keep-alive" });
    for (const line of logBuf) res.write(`data: ${JSON.stringify(line)}\n\n`);
    sseClients.add(res);
    req.on("close", () => sseClients.delete(res));
  } else if (req.method === "POST" && url.pathname === "/start") {
    const r = startRun(await readBody(req));
    json(res, r.error ? 400 : 200, r);
  } else if (req.method === "POST" && url.pathname === "/stop") {
    const r = stopRun();
    json(res, r.error ? 400 : 200, r);
  } else {
    json(res, 404, { error: "not found" });
  }
});

if (process.argv.includes("--check")) {
  // Smoke check: boot on a random port, hit /, /status, a bad /start; exit 0/1.
  server.listen(0, "127.0.0.1", async () => {
    const base = `http://127.0.0.1:${server.address().port}`;
    try {
      const home = await fetch(base + "/");
      if (!home.ok || !(await home.text()).includes("claude-loop-runner")) throw new Error("GET / broken");
      const st = await (await fetch(base + "/status")).json();
      if (typeof st.running !== "boolean" || typeof st.tokensEnv !== "number") throw new Error("GET /status broken");
      const bad = await fetch(base + "/start", { method: "POST", body: JSON.stringify({ targetDir: "Z:\\nope" }) });
      if (bad.status !== 400) throw new Error("POST /start should reject bad dir");
      console.log("ui.mjs check: OK");
      process.exit(0);
    } catch (err) {
      console.error("ui.mjs check FAILED:", err.message);
      process.exit(1);
    }
  });
} else {
  server.listen(PORT, "127.0.0.1", () => {
    console.log(`[ui] http://127.0.0.1:${PORT} — tokens no ambiente: ${envTokenCount()}`);
  });
}
