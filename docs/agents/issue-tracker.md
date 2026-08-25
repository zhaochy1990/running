# Issue tracker: GitHub (shared → zhaochy1990/stride-devops)

Issues, specs, and tickets for this repo live in the **shared tracker repo `zhaochy1990/stride-devops`** — NOT in this repo's own GitHub Issues. This repo's `git remote` points at `zhaochy1990/running`, so `gh` cannot infer the target. Point every `gh` call at the shared repo: export `GH_REPO=zhaochy1990/stride-devops` for the session, or pass `-R zhaochy1990/stride-devops` on every command. Do not rely on `gh repo set-default` alone.

## Project isolation

The shared tracker holds issues for several projects (`running` · `auth` · `stride-devops`), each isolated by a `project:<slug>` label. Every issue created here MUST carry this repo's project label; every list or query MUST filter by it.

- **This project's label**: `project:running`
- **Create an issue**: `gh issue create -R zhaochy1990/stride-devops --label "project:running" --title "..." --body "..."`. Use a heredoc for multi-line bodies.
- **List this project's issues**: `gh issue list -R zhaochy1990/stride-devops --label "project:running" --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'` with appropriate `--label` and `--state` filters.
- **Read an issue**: `gh issue view -R zhaochy1990/stride-devops <number> --comments`, filtering comments by `jq` and also fetching labels.
- **Comment on an issue**: `gh issue comment -R zhaochy1990/stride-devops <number> --body "..."`
- **Apply / remove labels**: `gh issue edit -R zhaochy1990/stride-devops <number> --add-label "..."` / `--remove-label "..."`
- **Close**: `gh issue close -R zhaochy1990/stride-devops <number> --comment "..."`

Issue numbers are shared across projects. Always disambiguate with the project label; when referencing another project's issue write `zhaochy1990/stride-devops#<n>`.

## Pull requests as a triage surface

**PRs as a request surface: no.** _(Set to `yes` if this repo treats external PRs as feature requests; `/triage` reads this flag.)_

When set to `yes`, PRs run through the same labels and states as issues, using the `gh pr` equivalents:

- **Read a PR**: `gh pr view -R zhaochy1990/stride-devops <number> --comments` and `gh pr diff -R zhaochy1990/stride-devops <number>` for the diff.
- **List external PRs for triage**: `gh pr list -R zhaochy1990/stride-devops --state open --json number,title,body,labels,author,authorAssociation,comments` then keep only `authorAssociation` of `CONTRIBUTOR`, `FIRST_TIME_CONTRIBUTOR`, or `NONE` (drop `OWNER`/`MEMBER`/`COLLABORATOR`).
- **Comment / label / close**: `gh pr comment`, `gh pr edit --add-label`/`--remove-label`, `gh pr close`.

GitHub shares one number space across issues and PRs, so a bare `#42` may be either — resolve with `gh pr view 42` and fall back to `gh issue view 42`.

## When a skill says "publish to the issue tracker"

Create a GitHub issue in `zhaochy1990/stride-devops` with the `project:running` label.

## When a skill says "fetch the relevant ticket"

Run `gh issue view -R zhaochy1990/stride-devops <number> --comments`.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a single issue with **child** issues as tickets. Every map and child also carries the `project:running` label.

- **Map**: a single issue labelled `wayfinder:map` **and `project:running`**, holding the Notes / Decisions-so-far / Fog body. `gh issue create -R zhaochy1990/stride-devops --label wayfinder:map --label project:running`.
- **Child ticket**: an issue linked to the map as a GitHub sub-issue (`gh api` on the sub-issues endpoint). Where sub-issues aren't enabled, add the child to a task list in the map body and put `Part of #<map>` at the top of the child body. Labels: `wayfinder:<type>` (`research`/`prototype`/`grilling`/`task`) **plus `project:running`**. Once claimed, the ticket is assigned to the driving dev.
- **Blocking**: GitHub's **native issue dependencies** — the canonical, UI-visible representation. Add an edge with `gh api --method POST repos/zhaochy1990/stride-devops/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`, where `<blocker-db-id>` is the blocker's numeric **database id** (`gh api repos/zhaochy1990/stride-devops/issues/<n> --jq .id`, _not_ the `#number` or `node_id`). GitHub reports `issue_dependencies_summary.blocked_by` (open blockers only — the live gate). Where dependencies aren't available, fall back to a `Blocked by: #<n>, #<n>` line at the top of the child body. A ticket is unblocked when every blocker is closed.
- **Frontier query**: list the map's open children scoped to this project (`gh issue list -R zhaochy1990/stride-devops --label "project:running" --state open`, then keep the map's sub-issues / task list), drop any with an open blocker (`issue_dependencies_summary.blocked_by > 0`, or an open issue in the `Blocked by` line) or an assignee; first in map order wins.
- **Claim**: `gh issue edit -R zhaochy1990/stride-devops <n> --add-assignee @me` — the session's first write.
- **Resolve**: `gh issue comment -R zhaochy1990/stride-devops <n> --body "<answer>"`, then `gh issue close -R zhaochy1990/stride-devops <n>`, then append a context pointer (gist + link) to the map's Decisions-so-far.
