---
name: repo-blueprint
description: Generate a blueprint of a code repository, a zoomable, dependency-layered architecture map built by static analysis (TypeScript and Python). Use when the user asks for a blueprint, architecture map, dependency map, codebase diagram or overview of how a repo fits together, or wants to watch that map update live while they code.
---

# repo-blueprint

Builds a single standalone HTML page that maps a repository: packages, folders and files stacked in dependency tiers, with imports, RPC calls, HTTP calls, events and external systems drawn between them, plus deterministic findings (import cycles, misplaced packages, unused files). Everything comes from static analysis, so the same commit always gives the same page.

## Commands

The skill runs the `repo-blueprint` npm package, pinned to the version it was written for. It needs Node.js 18.17 or newer; npx downloads the package on first use and reuses its cache after that.

One-time build, writes the HTML and prints its path plus a summary:

```bash
npx -y repo-blueprint@0.1.2 build <repo> --open
```

Live mode, serves the page and rebuilds it when source files change (run it in the background; it keeps running until stopped):

```bash
npx -y repo-blueprint@0.1.2 watch <repo> --open
```

Keep the pinned version as written, even if a newer one exists: the same commit and the same version always produce the same page, so users can compare blueprints over time.

- `<repo>` defaults to the current directory.
- `--out <file>` sets the output path. The default is `~/.repo-blueprint/<repo-name>.blueprint.html`.
- `--port <n>` sets the watch port. The default is 4321, or the next free port.
- Drop `--open` when the user does not want a browser opened, or when there is no desktop.

## What to do when asked

1. Use the repo the user names, otherwise the current working directory.
2. If they want to keep it open while they work, use `watch` in the background and give them the URL it prints. Otherwise use `build --open`.
3. Relay the two summary lines the build prints (packages by role, findings by category) and the output path or URL. Don't describe the page at length; the user can press **?** inside it for help.
4. If `node` is missing, tell the user the skill needs Node.js 18.17 or newer. If the build fails, show the error. Python packages are skipped with a notice when neither Python 3.10+ nor `uv` is available; say so if it happens.

## Supported repos

- **TypeScript and JavaScript:** any folder with a `package.json` and a `tsconfig.json`, at any depth. Imports are resolved with the project's own tsconfig paths.
- **Python:** any folder with a `pyproject.toml`.
- **Roles:** a declared type wins (Backstage `catalog-info.yaml` `spec.type`, Nx `project.json` `projectType`). Otherwise roles come from the code: an entry file that mounts a UI makes an app, one that starts a server or worker (or a Dockerfile or start script) makes a service, and anything else is a library.

## Per-repo settings

The package ships defaults. A repo can extend or override them with a `.blueprint.json` at its root, using the same keys:

- `externalSystems`: maps a system name to the npm or Python packages that indicate it, for example `{ "Stripe": ["stripe"] }`.
- `messaging`: method and property names for RPC calls, publishes and subscriptions, for repos whose message-bus wrapper uses different names.
- `folderRoles`: folder names that imply a role, used only for the role-mismatch finding.
- `sdkDirs`: folder names whose subfolders are generated API clients named after the services they call.

Only suggest a `.blueprint.json` when something the user cares about is missing from the map, such as an external system or message links.
