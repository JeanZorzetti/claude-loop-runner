# claude-loop-runner — Documento Técnico e Executivo

## 1. O que é

`claude-loop-runner` é um supervisor de linha de comando (Node.js, sem
dependências externas) que executa o **Claude Code CLI de forma autônoma e
repetida** contra um repositório-alvo, até que um plano de tarefas seja
concluído. Cada execução do Claude é isolada — sem histórico de conversa —
e o "estado" do trabalho vive em dois arquivos de texto dentro do próprio
repositório-alvo, não na memória do processo.

Em uma frase: é um piloto automático para o Claude Code trabalhar sozinho,
tarefa por tarefa, commitando e publicando no `main` a cada passo, com
troca automática de conta quando bate limite de uso.

## 2. Para quem é

- **Uso individual do autor** (Jean/ROI Labs), não um produto multiusuário.
  Não há autenticação, multi-tenant ou isolamento entre usuários — é uma
  ferramenta de produtividade pessoal/interna.
- Pressupõe familiaridade com: Claude Code CLI, Git, e o hábito de escrever
  um plano de tarefas (`macro_plan.md`) antes de rodar.
- Serve projetos onde o dono aceita que **cada iteração publica direto em
  produção** (push imediato para `main`, com deploy automático já
  configurado no projeto-alvo) — não é adequado para times ou repositórios
  onde mudanças precisam de revisão antes de ir ao ar.

## 3. A dor que resolve

Rodar o Claude Code por longas sessões interativas em uma tarefa grande e
multi-etapas (ex.: um roadmap de semanas) tem dois problemas práticos:

1. **Contexto cresce sem parar.** Uma sessão longa (`--continue`/`--resume`)
   acumula histórico até degradar qualidade e custo. Limpar com `/clear`
   perde continuidade do que já foi decidido.
2. **Presença humana constante.** Ficar acompanhando e reiniciando o Claude
   a cada tarefa do plano é trabalho manual repetitivo — exatamente o tipo
   de tarefa que deveria ser automatizada.

Havia ainda uma tentativa anterior de resolver isso via `pexpect`/screen-
scraping do terminal interativo, abandonada por não funcionar no Windows e
por ser uma camada frágil (depende do layout visual do TUI). Este projeto
substitui essa abordagem.

## 4. Por que existe (motivação e origem)

Nasceu de um padrão já validado em produção em outro projeto da ROI Labs
(Polaris Teams / `Imob\sofia-next`): chamadas não-interativas
`claude --print` + estado em arquivo + rotação de contas em cooldown. O
`claude-loop-runner` extrai esse padrão para uma ferramenta standalone e
reutilizável em qualquer repositório, em vez de ficar acoplado a um projeto
específico. O plano original que motivou a construção está referenciado no
próprio `README.md` (`~/.claude/plans/...idempotent-meteor.md`).

## 5. O que faz — visão executiva

Dado um repositório com um plano de tarefas (`macro_plan.md`) escrito à
mão, a ferramenta:

1. Lê o estado atual (`current_state.md`) para saber o que já foi feito e
   qual o próximo passo.
2. Chama o Claude Code (`claude --print`, sem interface, sem histórico
   herdado) pedindo para executar **apenas a próxima tarefa** do plano.
3. Deixa o próprio Claude reescrever `current_state.md` com o que foi feito
   e o que vem a seguir.
4. Faz commit e push direto no `main` do repositório-alvo.
5. Repete até o plano ser marcado como concluído (`status: done`), até
   travar em algo que exige humano (`status: blocked`), ou até atingir o
   limite de iterações definido na chamada (`--max-iterations`, obrigatório
   — não existe modo "sem limite").
6. Se uma conta bate limite de uso no meio do caminho, troca
   automaticamente para a próxima conta disponível no pool; se todas
   estiverem em cooldown, dorme até o horário de reset mais próximo e
   retoma sozinho — sem gastar uma iteração do orçamento nessa espera.

## 6. Como faz — arquitetura técnica

Projeto Node ≥18, ES modules, quatro arquivos-fonte:

| Arquivo | Papel |
|---|---|
| [src/runner.mjs](src/runner.mjs) | Loop supervisor. Único componente genuinamente novo — liga o estado em arquivo às chamadas repetidas ao Claude. |
| [src/claude-cli.mjs](src/claude-cli.mjs) | Invoca `claude --print --output-format json`, higieniza env vars, faz parsing da resposta. Portado de um serviço já validado em produção (`sofia-next`). |
| [src/token-pool.mjs](src/token-pool.mjs) | Pool de contas (tokens OAuth), detecção de banners de rate-limit por regex, cooldown e failover. Também portado e reaproveitado. |
| [src/ui.mjs](src/ui.mjs) | UI web local opcional (`http://127.0.0.1:4517`, zero dependências, bind só em loopback) para iniciar/parar runs e acompanhar logs e `current_state.md` ao vivo. |

### Fluxo por iteração ([runner.mjs](src/runner.mjs))

```
verifica "main" ── lê current_state.md ── escolhe conta livre no pool
        │                                          │
        ▼                                          ▼
  sincroniza com origin/main            chama `claude --print --effort <n>`
        │                                          │
        └──────────────► sucesso ─────────────────►┤
                                                     ▼
                                    commit (feito pelo próprio Claude)
                                                     │
                                                     ▼
                                    rebase em origin/main + push imediato
```

- **Estado em arquivo, não em memória de conversa**: `current_state.md` tem
  front-matter YAML (`status`, `next_effort`, `iteration`, `updated_at`) e
  duas seções em texto livre ("Last completed" / "Next step") — parseado à
  mão, sem dependência de `yaml`.
- **Esforço adaptativo**: cada tarefa do `macro_plan.md` é marcada
  `[plan]` (dispara `--effort high`, mais deliberação) ou `[build]`
  (`--effort low/medium`, execução direta).
- **Detecção de rate-limit é por regex**, porque o banner de limite do
  Claude Code pode vir tanto em stderr com exit ≠ 0 quanto em stdout com
  exit 0 (parecendo uma resposta normal). Há um cuidado documentado no
  código para não truncar a mensagem antes de testá-la contra o regex —
  um bug real já aconteceu por causa disso (ver comentário em
  [claude-cli.mjs:157-170](src/claude-cli.mjs#L157-L170)).
- **Sincronização defensiva com o remoto**: `git pull --rebase --autostash`
  roda antes de cada iteração E antes de cada push, porque o `main` remoto
  pode se mover sozinho (cron, merge de PR) enquanto o loop trabalha.
  Conflito de rebase para o loop inteiro para revisão humana.

## 7. Salvaguardas de segurança (por decisão explícita, não acidente)

- `git push --force`, `git push -f` e `git reset --hard` são bloqueados via
  `--disallowedTools`, independente do modo de permissão usado.
- Recusa iniciar se o repositório-alvo não estiver com `main` selecionado —
  evita push silencioso em outro branch por engano.
- `--max-iterations` é obrigatório, sem valor padrão "ilimitado" — uma
  tarefa mal especificada não pode consumir a cota semanal de todas as
  contas do pool sozinha.
- `status: blocked` interrompe o loop em vez de forçar continuidade — é
  tratado como resultado esperado, não como bug.
- Credenciais de API (`ANTHROPIC_API_KEY`/`ANTHROPIC_AUTH_TOKEN`) são
  removidas do ambiente do processo filho, para garantir que o consumo
  sempre entra pela assinatura (via `CLAUDE_CODE_OAUTH_TOKEN`) e não migre
  silenciosamente para faturamento por API.

## 8. Limitações e riscos conhecidos (leia antes de usar)

- **Não há cushion de branch/worktree.** Desde uma decisão explícita de
  2026-07, todo commit vai direto para `main` e é publicado imediatamente.
  Se o projeto-alvo faz deploy automático no push (o próprio projeto-piloto
  faz), cada iteração vai para produção sem revisão humana no meio. A única
  rede de segurança é a lista de `--disallowedTools` — revisar o escopo do
  `macro_plan.md` **antes** de rodar é o que substitui a revisão de diff
  depois.
- **`--permission-mode bypassPermissions` é o padrão** — necessário para
  rodar sem supervisão, mas significa que o Claude tem ampla liberdade de
  execução dentro do repositório-alvo, limitada só pelas três ferramentas
  bloqueadas.
- **Detecção de rate-limit por regex** é uma correspondência de texto sobre
  a saída do CLI: uma mudança de wording no banner oficial do Claude Code
  pode quebrar a detecção silenciosamente.
- **`parseResetAt` assume fuso horário local da máquina** quando o banner
  não vem em UTC — documentado no código como simplificação deliberada,
  válida para "ferramenta pessoal, uma máquina só" (ver
  [token-pool.mjs:110-112](src/token-pool.mjs#L110-L112)).
- **UI local expõe tokens OAuth** no navegador — por isso faz bind só em
  `127.0.0.1`, nunca deve ser exposta publicamente.

## 9. Estado atual do projeto

- Versão `0.1.0`, sem publicação em npm (uso local via `node
  src/runner.mjs` ou `npm run ui`).
- Cobertura de testes: um script de auto-verificação (`test.mjs`) cobre a
  lógica não-trivial do pool de tokens (detecção de limite, parsing de
  horário de reset, failover) — sem framework, `node test.mjs`.
- Existe uma landing page estática (`site/`) publicada via Vercel, com SEO
  básico configurado (canonical, robots, sitemap) — presença pública do
  projeto, hoje separada da ferramenta em si.
- Histórico de commits é curto (4 commits): criação inicial, landing page,
  e dois ajustes de SEO — projeto jovem, em uso ativo mas ainda não
  amplamente exercitado fora do caso de uso original.

## 10. Como operar (resumo)

```
node src/runner.mjs "<caminho do repo alvo>" --max-iterations 20
```

Pré-requisitos no repo-alvo: `macro_plan.md` escrito à mão (escopo,
arquitetura, tarefas marcadas `[plan]`/`[build]`) e `main` selecionado.
Contas via `CLAUDE_CODE_OAUTH_TOKEN[_N]` ou `CLAUDE_CODE_OAUTH_TOKENS`. UI
opcional: `npm run ui` → `http://127.0.0.1:4517`.
