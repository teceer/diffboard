---
name: diffboard
description: Agree on a solution's data model, process and assumptions with the user on a design board before writing code, then show code changes on the live diffboard whiteboard while implementing, and attach notes or mermaid diagrams to the files you touch. Use whenever you start or continue implementation work in a repository the user will review, when you are about to design tables, a schema change, a process or a new feature's data layer (design first), when the user says "diffboard", "whiteboard", "tablica", "tablica projektu", "design board", "zaprojektuj", "zaproponuj schemat", "pokaż zmiany na tablicy", "dodaj notatkę do pliku", or pastes a reference like /path/file.ts:12-30 or a localhost:4700 board link.
---

# diffboard

`diffboard` is a local server that watches git repositories and draws the branch's changed files as
a graph with diffs, line references and notes. It reads git, so you never push content to it: edit
files and commit as usual and the board follows. Source: https://github.com/teceer/diffboard.

**Local conventions:** if `~/.diffboard/skill.local.md` exists, read it before your first
diffboard command; it holds the user's own rules (base branches, board names, how to open the
board) and they take precedence over the defaults here.

## Boards: one per session

One server holds several independent boards, listed in the board's left sidebar. Each has its
own repos, diff mode, notes, tours and review marks. **Work on your own board, never on `default`
or another session's board**: adding or removing repos there changes what other agents and the
user see.

## When you start implementing

1. Create a board for your task with every repository you will change (name it after the task or
   ticket, e.g. `PROJ-142 checkout redesign`):
   ```bash
   diffboard board new "<task name>" <repo-path> [<repo-path>...] [--base <target branch>]
   # prints the board id and its url; starts the server when it is not running
   ```
   If a board for this task already exists (`diffboard board list`), reuse it:
   `diffboard add <repo-path> --board <id>`.
2. Commands pick the board in this order: `--board <id>`, `$DIFFBOARD_BOARD`, the board that
   watches the current directory, `default`. Inside your repo you can usually omit `--board`;
   when one repo sits on several boards, pass `--board <id>` (prefix shell calls with
   `DIFFBOARD_BOARD=<id>` to be safe). `diffboard board current` shows which board applies here.
   When auto picks the wrong base, set the branch your work targets:
   `diffboard base <repo-id> origin/<target-branch> --board <id>`.
3. Tell the user the board url once (`diffboard url --board <id>`, it carries `#board=<id>`).
4. Commit in small, logical steps. The board's "since last commit" mode then shows exactly what you
   are doing right now.

## Notes and diagrams

Explain non-obvious decisions where they live, not only in chat:

```bash
DIFFBOARD_AUTHOR=agent:claude diffboard note add --title "<short title>" \
  --link <repo-id>:<path>[:start-end] [--link ...] --body-file /tmp/note.md
```

- Bodies are Markdown; diagrams go in ```` ```mermaid ```` fences.
- Mermaid is strict: no empty link labels (`A -.-> B`, not `A -. .-> B`), quote labels with
  special characters (`A["status: paid (v2)"]`). The board shows a broken diagram as an error box
  with the parser message: open the note's link once after writing it and fix what it reports.
- Link every file the note is about (many-to-many). Line ranges are welcome.
- Update instead of duplicating: `diffboard note list`, then `diffboard note edit <id> --body-file ... --link ...`.
- Keep notes short and factual; they are review aids, not documentation.

### Database schema changes: always add a diagram

Whenever you add or change the database schema (new tables or columns, changed types, relations,
indexes, constraints; entity/ORM schema files, migrations, SQL), add a note with an ER diagram of
the affected part, or update the existing one (`diffboard note list`), in the same step as the change:

- A ```` ```mermaid ```` `erDiagram` with the touched tables and their direct neighbours only: the
  columns that matter (keys, foreign keys, new and changed columns, with types), and relations with
  cardinality. Mark what is new or changed, e.g. a `"NEW"` / `"CHANGED"` comment on the column.
- **Always give example values.** Every column shown in the diagram gets a realistic sample value
  in its comment (`e.g. …`), after the NEW/CHANGED marker. Below the diagram, add a small Markdown
  table of sample rows for each new or changed table (2-3 rows), with foreign keys that point at the
  sample rows of the related tables, so the reader sees how the records connect. Use values that
  look like the domain (real-looking names, enum values, JSON shapes), never `foo`/`bar`.
- Title it `DB: <area>` and link the schema files and the migration (`--link` each).
- Under the samples, a few lines: what changed and why, migration and backfill concerns, and
  anything the reviewer should check (nullability, defaults, index usage, data loss).

```mermaid
erDiagram
  CUSTOMERS ||--o{ ORDERS : places
  CUSTOMERS {
    uuid id PK "e.g. 7f3c…a1"
    text email "e.g. anna.nowak@example.com"
  }
  ORDERS {
    uuid id PK "e.g. 0b9e…42"
    uuid customer_id FK "e.g. 7f3c…a1"
    int total_cents "NEW · e.g. 12990"
    text status "CHANGED: + refunded · e.g. paid (pending | paid | refunded)"
  }
```

| ORDERS.id | customer_id | total_cents | status |
|---|---|---|---|
| 0b9e…42 | 7f3c…a1 (anna.nowak@…) | 12990 | paid |
| 5d21…07 | 7f3c…a1 (anna.nowak@…) | 4500 | refunded |

## Design before code: design boards

Before you implement anything that adds or changes tables, relations, a process or its states,
put your proposal on a **design board** and let the user shape it. The user cares most about the
data layer: a wrong storage model makes every layer above it harder. Code starts from the approved
version, not from the chat.

A design is a text file in the project repo, `docs/boards/<id>.board.json` (history and approved
versions in `docs/boards/<id>/`), so it travels with the branch and shows up in the PR. The user
edits it on an infinite canvas at `http://localhost:4700/design#d=<id>`; you change it with
operations. Set your name first: `export DIFFBOARD_AUTHOR=agent:<session-or-task>`.

```bash
diffboard design new "<task name>" <repo> --purpose "<what we are deciding>"   # prints id + url
diffboard design show                 # the whole design as markdown: read it before every change
diffboard design check                # rule findings; exit 2 when there are errors
diffboard design ops                  # every operation with its fields
diffboard design table reservation --module rooms --col "id uuid pk" --col "room_id uuid ref=room.id" --col "status reservation_status"
diffboard design column reservation "hold_expires_at timestamptz null"
diffboard design op --file ops.json   # any batch of operations, applied all-or-nothing
```

Build the first version yourself (with `op`), then hand it over: give the user the url once.

- **Modules.** Put every table in its module (`--module`). Declare shared platform modules with
  `{"op":"add-module","name":"people","kind":"platform"}`. A foreign key from one business module
  into another is an error (`module-boundary`): keep the id with `fk:false` and say which public API
  reads it. Repo rules like "every module table has team_id" go in
  `{"op":"set-rules","requiredColumns":["team_id"]}` when the project's AGENTS.md says so.
- **Samples.** Give every table 2-3 realistic sample rows (`set-samples`), with ids that point at
  the sample rows of related tables. They show whether the model works on real data.
- **Process.** Lanes are actors (`Guest`, `System (rooms)`, `Payments`), steps say which tables they
  create/read/update/delete (`touches`), flows connect them. A step that writes a table which does
  not exist is flagged: that is a gap in the data model, not in the process.
- **States.** A status column gets a state machine (`set-machine`) whose transitions name the steps.
- **Assumptions.** Every decision the model rests on is an assumption (`accepted`), every open
  point a `question` for the user. Do not bury questions in chat.

**After the user has looked at it, change things through proposals**, not directly: a refactor,
a split table, a renamed concept. The user sees them on the canvas as a diff (green added, red
removed, amber changed) and accepts or rejects them.

```bash
diffboard design propose --title "status as event history" --rationale "<why, trade-offs>" --file p.json
diffboard design wait P3              # blocks until the user decides; prints their comments
diffboard design comment "<answer>" --target proposal:P3
```

Other agents can share a board: `diffboard design join --as propose` (only proposals) or
`--as read` (context only), with `--design <id>` or `DIFFBOARD_DESIGN=<id>` when the repo has several.
The user approves a version on the canvas (`v1`, `v2`…); only then implement, starting from
`diffboard design show` (and `--format dbml` / `mermaid` when useful). If the implementation has
to deviate from the approved design, propose the change on the board first.

## Review tour

When a chunk of work is ready for the user to read, save a guided order through it. Steps go
bottom-up: what everything else builds on first (shared libraries, migrations, entities), then
domain, repositories, services, controllers, UI. Each note says what to look at and why, in one
or two sentences. Point at line ranges when only part of a file matters.

```bash
DIFFBOARD_AUTHOR=agent:claude diffboard tour set <task-id> \
  --step "<repo-id>:<path>[:start-end] | <what to look at>" \
  --step "..."                       # or --steps-file steps.txt, one "<ref> | <note>" per line
diffboard tour list | show <name> | rm <name>
```

`tour set` replaces the whole tour, so rerun it with the full list after more commits. Give the
user the printed `http://localhost:4700/#board=<id>&tour=<name>` link. Files left out of the tour still show
below it in the automatic order (imports first), so the tour only needs the files worth explaining.

## References from the user

The user copies references from the board and pastes them into chat:

- `/abs/path/file.ts:12-30` → read those lines of the working-tree file.
- `/abs/path/file.ts:12-30 (at base <sha>)` → the old side: `git show <sha>:<path>` and read those lines.
- `http://localhost:4700/#board=<b>&file=<repo>:<path>&lines=12-30&side=new` → same as the first
  form; the repo path is in `diffboard status --board <b>`. No `board=` means `default`.
- `http://localhost:4700/#board=<b>&note=<id>` → `diffboard note show <id> --board <b>`.
- `…&tour=<name>` → the user is following that tour; `diffboard tour show <name>`.

## Housekeeping

- When the task is finished (merged), archive your board: `diffboard board rm <id>` (notes and
  tours move to `~/.diffboard/archive`). `diffboard remove <repo-id> --board <id>` drops one repo.
- Logs: `~/.diffboard/server.log`. Restart: `diffboard stop && diffboard start` (boards persist in
  `~/.diffboard/boards/`). A server older than boards answers `no board …`/404 on `/api/b/…`:
  restart it.
