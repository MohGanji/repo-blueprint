# repo-blueprint

A zoomable, dependency-layered map of a code repository, built by static analysis.

It reads TypeScript and Python source, resolves every import through the project's own config, and writes one standalone HTML page: packages, folders and files stacked in dependency tiers, with imports, RPC calls, HTTP calls, events and external systems drawn between them, plus findings such as import cycles and unused files. The same commit and the same version always produce the same page.

## With an agent

1. Add the `repo-blueprint` skill from this repo's `skills/` folder, for example with skills.sh, or by pointing your agent at this repo.
2. Ask for "a blueprint of this repo", or "a live blueprint I can keep open while I work".

The skill is a single `SKILL.md`. It runs this package through `npx`, pinned to an exact version.

## From the command line

Requires Node.js 18.17 or newer. Python repos also need Python 3.10+ or [uv](https://docs.astral.sh/uv/).

```bash
npx repo-blueprint build [repo] [--out file] [--open]
npx repo-blueprint watch [repo] [--port 4321] [--open]
```

- `build` writes the page once, to `~/.repo-blueprint/<repo>.blueprint.html` unless `--out` says otherwise, and prints a summary.
- `watch` serves the page on localhost and rebuilds it whenever source files change.

From a clone, `node bin/repo-blueprint.mjs build` works too; the first run installs the two dependencies, `typescript` and `pele`.

## Per-repo settings

A `.blueprint.json` at the root of the analysed repo extends `src/blueprint.config.json`:

- `externalSystems`: system names and the packages that indicate them, for example `{ "Stripe": ["stripe"] }`.
- `messaging`: method and property names for RPC calls, publishes and subscriptions.
- `folderRoles`: folder names that imply a role, used for the role-mismatch finding.
- `sdkDirs`: folder names whose subfolders are generated API clients named after the services they call.

## Layout

```
bin/repo-blueprint.mjs        CLI: build and watch
src/extract-ts.mjs            TypeScript facts via the compiler API
src/extract-py.py             Python facts via the ast module
src/model.mjs                 packages, folder tree, edges, roles, findings
src/views.mjs                 one Pele diagram per folder
src/build.mjs                 writes the standalone HTML
src/template.html             the page
src/blueprint.config.json     default settings
skills/repo-blueprint/        the agent skill
.claude-plugin/plugin.json    Claude Code plugin manifest
```

## Releasing

The skill pins the package version, so they move together:

1. Bump `version` in `package.json` and `.claude-plugin/plugin.json`.
2. Update the `repo-blueprint@x.y.z` references in `skills/repo-blueprint/SKILL.md`.
3. `npm publish`, then commit and tag the release.
