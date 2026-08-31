# Design Review — claudeloop.roilabs.com.br

**Data:** 2026-08-31
**Alvo:** `site/index.html` — landing única, estática, servida pela Vercel a partir de `site/`
**Objetivo do visitante:** decidir se a ferramenta resolve o problema dele e sair rodando
**Restrição:** HTML único, sem build, sem dependência externa

**Verificação:** feita no ar em `https://claudeloop.roilabs.com.br/` (HTTP 200). O Playwright MCP não
conectou na sessão; a passagem foi rodada direto pela API do Playwright (Chromium headless, 1.62.1).
Cada achado abaixo traz a evidência medida.

**Disciplinas rodadas:** `conversion-copy` → `behavioral-design` → `art-direction` → `motion-design`
→ `design-systems` → `responsive-design` → `accessibility` → `web-performance` → `seo-geo`
→ `ui-verification`.

---

## Diagnóstico

A página argumenta muito bem e **não deixa ninguém agir**. Nos primeiros 71% do scroll não existe um
único elemento focável — a passagem de Tab chega em 3 paradas, e a primeira é o botão do GitHub a 72%
de profundidade. Pior: o bloco de instalação começa em `export CLAUDE_CODE_OAUTH_TOKEN` e pula direto
para `node src/runner.mjs` — a página nunca diz como obter a ferramenta (o README também não). Quem
foi convencido pelo título não tem caminho.

O segundo problema é sistêmico e barato: o token `--muted` carrega quase toda a prosa explicativa da
página e reprova em AA nos três fundos onde é usado.

---

## Ações

| # | Disciplina | Achado (evidência) | Correção | Sev |
|---|---|---|---|---|
| 1 | accessibility | `--muted:#69747A` reprova AA em todo lugar: **3.85:1** no `--ground`, **4.15:1** no `--panel`, **3.53:1** no fundo de `code`. Atinge `.sub`, `.qa dd` (FAQ inteiro), `ol.steps p`, `.block p`, `.kicker`, `.rig-foot`, `footer`, `.strip span`, `.c` | `--muted:#586165` → 5.09 / 5.49 / **4.67**. Passa nos três, mantém o cinza-ardósia | 4 |
| 2 | conversion-copy | Nenhum caminho de obtenção. O `<pre>` de "Run it" vai de `export` a `node src/runner.mjs` sem clone; README idem | Duas linhas no topo do bloco: `git clone https://github.com/JeanZorzetti/claude-loop-runner` + `cd claude-loop-runner`. Se o `bin` do `package.json` for publicado, `npx claude-loop-runner` no lugar | 4 |
| 3 | behavioral-design | Zero focáveis nos primeiros 71%. Tab: `tab1 = .cta` (`ctaTop=3800 / docH=5360`), `tab2/tab3` = links do rodapé | CTA no hero, logo abaixo do `.sub`: um `<a>` para o GitHub + o `git clone` em texto copiável. O `.cta` de baixo continua onde está | 3 |
| 4 | motion-design + accessibility | `setInterval(…, 780)` reinicia em 12 e roda **para sempre** — 9,4 s por ciclo, sem pausa: falha WCAG 2.2.2 (nível A). E o estado padrão contradiz o título: medido em ~1 s, `iteration 1/12` mostra **9% (sessão longa) vs 11% (runner)** — o runner parece pior. O frame que prova a tese aparece 780 ms a cada 9,4 s | Rodar **uma vez** a ~350 ms/passo (4,2 s < 5 s) e parar em 12, segurando o veredito. Uma mudança resolve o 2.2.2 e a direção de arte. O estado com `prefers-reduced-motion` já está certo (`iteration 12/12` + veredito) — é esse que deve virar o repouso de todo mundo | 3 |
| 5 | responsive-design | `.strip` é `sticky;top:0` e mede **108 px a 360 px de largura** — 17% da viewport de um celular, permanentemente, com 6 itens quebrando em 3 linhas e **nenhum link dentro** | `@media (max-width:820px){.strip{position:static}}`, ou manter sticky só com a marca + `unattended` e esconder os outros 4 itens | 3 |
| 6 | accessibility | Salto de heading `H1 → H3` (`.lane h3`, "One long session") antes do primeiro `H2`; e `main=0` no DOM — sem landmark para pular a navegação | Os títulos das raias são rótulos de gráfico, não seção: trocar `<h3>` por `<p class="lane-title">` com o mesmo CSS. Envolver as 5 `<section>` em `<main>` | 2 |
| 7 | seo-geo | Sem `og:image` e sem `twitter:card` — o link compartilhado renderiza vazio. Todo o resto do GEO está feito (canonical, `llms.txt`, robots com os crawlers de IA, `@graph` validado pelo `check-geo.mjs`) | Card 1200×630 estático em `site/og.png` + `<meta property="og:image">`, `<meta name="twitter:card" content="summary_large_image">`, `og:site_name` | 2 |
| 8 | design-systems | `--dim:#8C949A` nas barras do medidor dá **2.67:1** contra o `--panel` — abaixo dos 3:1 exigidos para gráfico que carrega informação | `--dim:#7E868C` → 3.20:1 | 2 |
| 9 | conversion-copy | A única prova social existe no `llms.txt` ("Built and used in production by ROI Labs") e **não** está na página. A ferramenta é gratuita e isso também não aparece acima da dobra | Uma linha no `.rig-foot` ou sob o hero: uso em produção + "free, roda no seu login do Claude Code". É a objeção de custo respondida antes de ser feita | 2 |

Severidade 0–4, ordenada por impacto × frequência.

---

## Disciplinas silenciosas

- **web-performance** — nada a fazer, e é raro: **1 requisição**, 30 KB, LCP **284 ms** (o `<h1>`),
  **CLS 0**, console limpo, zero terceiros, zero fonte externa. Muito abaixo de qualquer orçamento.
- **design-systems** (fora do #8) — escala única, sem drift, sem token órfão.
- **usability-heuristics** — a ordem das seções acompanha a ordem das perguntas; o FAQ visível bate
  1:1 com o `FAQPage`, e o `check-geo.mjs` já guarda isso em teste.
- **generative-ui**, **component-architecture**, **dataviz** — não se aplicam: arquivo único, sem
  build, sem UI de LLM.

---

## Fora de escopo agora

- **Dark mode** — a página assume um único fundo claro; é direção deliberada, não bug. Custo alto,
  ganho baixo para uma landing de ferramenta.
- **`.blocks` como `<div>` em vez de `<dl>`**, e os rótulos "blocked"/"gate" via `content:` — o Chrome
  expõe os dois na árvore de acessibilidade (conferido no snapshot). Sev 1, não vale o diff.
- **Coluna de texto a ~58ch dentro de um `wrap` de 1080px** deixa a metade direita vazia em 1440px.
  É escolha editorial coerente com o resto; só mexeria junto de uma redireção de arte, não isolado.

---

## Medições brutas

### Contraste (WCAG 2.1)

| Par | Ratio | Status |
|---|---|---|
| `--muted` #69747A sobre `--ground` #E4E7E6 | 3.85 | **falha AA** |
| `--muted` sobre `--panel` #EDEFEE | 4.15 | **falha AA** |
| `--muted` sobre fundo de `code` #DADEDD | 3.53 | **falha AA** |
| `--dim` #8C949A sobre `--panel` (barra do medidor) | 2.67 | **falha 3:1 gráfico** |
| `--signal` #B0442A sobre `--ground` | 4.55 | passa |
| `--signal` sobre `--panel` | 4.91 | passa |
| `--ink` #12171A sobre `--ground` | 14.50 | passa |
| `.lede` #2B3336 sobre `--ground` | 10.35 | passa |
| `.cta` — `--ground` sobre `--ink` | 14.50 | passa |
| `.cta:hover` — `--ground` sobre `--signal` | 4.55 | passa |
| **correção** #586165 sobre ground / panel / code | 5.09 / 5.49 / 4.67 | passa nos três |
| **correção** #7E868C sobre `--panel` | 3.20 | passa 3:1 |

### Passagem de teclado (1440×900)

```
tab1: A.cta   "Read the code on GitHub"                box=239x49  outline=2px rgb(176,68,42)
tab2: A       "ROI Labs"                               box=59x15   outline=2px rgb(176,68,42)
tab3: A       "github.com/JeanZorzetti/claude-loop..."  box=312x15  outline=2px rgb(176,68,42)
tab4: BODY
```

Três paradas no documento inteiro. Foco sempre visível — o `:focus-visible` está correto.

### Três larguras

| Largura | scrollW / clientW | Estouro de página | `.strip` | CTA em |
|---|---|---|---|---|
| 360×640 | 360 / 360 | nenhum | **108 px (17% da viewport)** | 72% |
| 768×1024 | 768 / 768 | nenhum | 73 px | 74% |
| 1440×900 | 1440 / 1440 | nenhum | 55 px | 71% |

Os elementos que ultrapassam a 360px (`SPAN.c`, `SPAN.k`) estão dentro do `<pre>`, que tem
`overflow-x:auto` — rolam sozinhos, não estouram a página. Não é defeito.

### Estrutura

```
HEADINGS (ordem do DOM)
H1  The context never grows.
H3  One long session          ← salto H1 → H3
H3  claude-loop-runner
H2  Where does the memory live between calls?
H2  What happens in one iteration?
H3 ×6  (passos da iteração — corretos, aninhados sob o H2)
H2  What will it refuse to do?
H2  What do you need to run it?
H2  Questions people actually ask

LANDMARKS
header=3  nav=0  main=0  footer=1  section=5  article=0  aside=0
```

### Rede e métricas (1440×900, cache quente)

```
responses: 1
  200 document https://claudeloop.roilabs.com.br/   (30 185 B)

LCP  284 ms  (elemento: H1)
CLS  0
TTFB 154 ms
DCL  181 ms
console: (limpo)
```

### Animação

- Padrão: `setInterval(780 ms)`, 12 passos, **reinicia indefinidamente**. Em ~1 s a leitura é
  `iteration 1 / 12` → `9%` (sessão longa) vs `11%` (runner).
- `prefers-reduced-motion: reduce`: pinta `iteration 12 / 12` e o veredito
  `"one session is out of room · the runner is on task 13"`. Este é o estado correto.

---

## O que não foi verificado

Dispositivo real (toque, teclado virtual, rede móvel), leitor de tela de verdade — NVDA e VoiceOver
anunciam o `content:` dos badges `blocked`/`gate` de forma diferente do snapshot — e dado de campo
(CrUX). As métricas acima vêm de uma máquina só: servem para pegar regressão grosseira, não para
cravar número.
