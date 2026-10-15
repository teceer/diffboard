# diffboard

A live whiteboard of what changed on a branch. It reads git, so it follows whoever edits the
code: you in an editor, a coding agent, or several agents at once. Built for reviewing work done by
AI coding agents, and for agents to explain that work where it lives.

- **Changed files as a graph**, grouped per repository and coloured by status, with `+/-` counts,
  linked by imports (relative paths, `tsconfig` path aliases, workspace packages, other watched
  repositories), plus one step of unchanged neighbours.
- **Whole-repo map**: every file as folders that unfold on click, with import edges folded between
  them, and a file tree with fuzzy quick open.
- **Diff and full file** for any node: unified or split, whole file with changes marked, the base
  version, a rendered preview for Markdown, and inline diff cards on the graph itself.
- **Code intelligence** (TypeScript/JavaScript, Rust): hover types, occurrences, go to definition,
  references across the project.
- **Edit in place** with autosave to the working tree, refusing to overwrite newer changes on disk.
- **Line references**: click line numbers, copy `/abs/path/file.ts:12-30` to paste into a chat with
  an agent, or a board link that reopens those lines.
- **Notes and diagrams** in Markdown with zoomable ` ```mermaid ` diagrams, linked to files or line
  ranges. Agents create them with the CLI.
- **Review order**: agents save guided tours through their changes; everything else follows in
  import order, with reviewed marks tied to file content.
- **Boards**: independent whiteboards in one server, one per agent session.
- **Live**: saves, commits and checkouts update the board over SSE; recently edited files glow.

## Install

Needs [Bun](https://bun.sh) and git.

```bash
git clone https://github.com/teceer/diffboard.git
cd diffboard && bun install
ln -s "$PWD/bin/diffboard" ~/.local/bin/diffboard   # any directory on your PATH
```

## Use

```bash
diffboard start ~/code/shop-api ~/code/shop-web   # background server, watching two repos
diffboard status                                  # url, repos, base per repo, changed files
diffboard add <repo> [--base origin/develop]
diffboard base <repo-id> <ref|auto>
diffboard stop
```

Open http://localhost:4700.

**Base.** Each repo is diffed against its merge-base with the base branch, plus uncommitted and
untracked files. Auto picks the closest of `origin/release-candidate/*`, `origin/develop`,
`origin/main`, `origin/master`; on one of those branches itself, its upstream (so the board shows
what is not pushed). Override per branch with `git config branch.<name>.diffboardBase <ref>`, per
repo with `--base`, or from the UI (click the base). The title bar switches to "since last commit".
A repo with more than 800 changed files (`DIFFBOARD_MAX_FILES`) is not drawn, since that is nearly
always a wrong base. Git-ignored directories never trigger refreshes.

## Boards

One server holds independent boards, listed in the left dock (`b`). Each board has its own repos,
diff mode, notes, review tours and review marks, so agents working in parallel never step on each
other. Give every agent session its own board:

```bash
diffboard board new "checkout redesign" ~/code/shop-web   # prints id + url
diffboard board list | current | rename <id> <name> | rm <id>   # rm archives to ~/.diffboard/archive
```

Every other command picks its board from `--board <id>`, then `$DIFFBOARD_BOARD`, then the board
that watches the current directory, then `default`. Board links carry `#board=<id>`.

## Graph, files and editing

The title bar switches the graph between **Changes** (changed files and their import neighbours)
and **Whole repo** (folders that unfold on click; edge width is how many imports an edge stands
for; folders holding changes are outlined). Right-click anything on the graph for its menu. The
**Files** tab of the left dock is the full file tree; ⌘P / Ctrl+P / `p` opens any file by fuzzy
name. **Edit** (or `e`) in the file panel edits the working-tree file with autosave. Back and
forward (browser buttons, mouse side buttons, Ctrl+- / Alt+←) walk the files and notes you opened.

## Code intelligence

TypeScript/JavaScript (vtsls, installed with `bun install`) and Rust (`rust-analyzer` on PATH) in
the File and Diff views of the working tree: hover a symbol for its type and docs, click it to
highlight its occurrences, ⌘/Ctrl-click (or F12) to go to its definition, Shift+F12 for references
across the project (the files holding them light up on the graph). One server per repo starts on
first use and stops after 10 idle minutes. `DIFFBOARD_TS_LSP` points at another TypeScript server.

## Notes (for agents too)

```bash
diffboard note add --title "Why prices are stored in cents" \
  --link shop-api:src/orders/order.entity.ts:40-72 \
  --link ~/code/shop-web/src/cart/total.ts \
  --body-file notes/prices.md          # or --body "...", or stdin
diffboard note list | show <id> | edit <id> [--link ...] [--unlink ...] | rm <id>
```

Set `DIFFBOARD_AUTHOR=agent:<name>` (or `--author`) so the board shows who wrote the note.

## Review order

The **Review** sidebar (key `r`) lists changed files in the order worth reading them:

1. the steps of a **tour**, if one is chosen: a hand-picked order with a note per step, usually
   written by the agent that made the changes;
2. every other changed file in **automatic order**: repositories that other watched repositories
   import come first, then a topological sort of the import graph (a file after the files it
   imports), ties broken by layer guessed from the path (migrations, entities, domain,
   repositories, services, controllers, UI, tests).

`j` / `k` move through the list, `x` marks the current file reviewed and jumps to the next one.
A reviewed mark is tied to the file's content hash, so a file edited after review comes back
unchecked.

```bash
diffboard tour set checkout-redesign \
  --step "shop-api:migrations/0042_add_price_cents.ts:12-30 | Backfill converts existing prices" \
  --step "shop-web:src/cart/total.ts | Totals now sum integers"
diffboard tour list | show <name> | rm <name>
```

## Claude Code skill

`skill/diffboard/SKILL.md` teaches [Claude Code](https://claude.com/claude-code) agents to use the
board while they work: create their own board, attach notes and diagrams (an ER diagram for every
schema change), and save a review tour. Install it as a personal skill:

```bash
ln -s "$PWD/skill/diffboard" ~/.claude/skills/diffboard
```

Team or personal conventions (which base branch to use, how to open the board in your browser)
go in `~/.diffboard/skill.local.md`; the skill tells agents to read that file when it exists.

## State

Everything lives in `~/.diffboard/`: `config.json` (port), `boards/<id>/` (repos, notes, tours,
review marks per board), `archive/`, `server.log`.

## License

MIT
