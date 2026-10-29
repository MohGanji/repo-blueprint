# repo-blueprint [![npm](https://img.shields.io/npm/v/repo-blueprint.svg)](https://www.npmjs.com/package/repo-blueprint)

A clearer way to see how a repository is built. repo-blueprint maps a codebase into layers, with each part placed above its dependencies. Detail is handled by zoom: the top level shows packages, and zooming in reveals folders, then files.

![TanStack Query mapped with repo-blueprint](https://raw.githubusercontent.com/MohGanji/repo-blueprint/main/media/demo.gif)

- Works with TypeScript, JavaScript and Python, monorepos included
- Draws imports, RPC and HTTP calls, events, and every third-party package the code imports, named by system (PostgreSQL, Stripe…) when it is a known driver or SDK
- Flags import cycles, unused packages and orphan files
- Reports every file it could not map, and every import it could not follow, so nothing drops off the map silently
- Produces one self-contained HTML file
- Uses static analysis only, so the output is deterministic

## Examples

**[Explore the blueprint gallery →](https://mohganji.github.io/repo-blueprint/)**

Example blueprints of open-source GitHub repos, such as [Pydantic](https://mohganji.github.io/repo-blueprint/pydantic.blueprint.html), [Zod](https://mohganji.github.io/repo-blueprint/zod.blueprint.html), [Flask](https://mohganji.github.io/repo-blueprint/flask.blueprint.html) and [Express](https://mohganji.github.io/repo-blueprint/express.blueprint.html).

## Usage

Requires Node.js 18.17+. Python projects also need Python 3.10+ or [uv](https://docs.astral.sh/uv/).

```sh
npx repo-blueprint build [repo]
```

Writes `~/.repo-blueprint/<repo>.blueprint.html` and prints a short summary.

```sh
npx repo-blueprint watch [repo]
```

Serves the map on localhost and rebuilds it when files change.

| Option | Description |
| --- | --- |
| `--out`, `-o` | Output file (`build` only) |
| `--port`, `-p` | Port for `watch`, default 4321 |
| `--open` | Open the result in a browser |

`repo` defaults to the current directory.

## Supported projects

- **TypeScript and JavaScript:** any folder with a `package.json`, at any depth. ES modules and CommonJS (`require`, `module.exports`) are both read. Imports are resolved through the package's `tsconfig.json` or `jsconfig.json` when it has one. Vue, Svelte and Astro files are not parsed yet and are reported as not mapped.
- **Python:** any folder with a `pyproject.toml`, flat or `src/` layout.

Each package is shown as an app, a service or a library. A declared type is used when there is one (Backstage `catalog-info.yaml`, Nx `project.json`). Otherwise the role is inferred: an entry file that mounts a UI makes an app, one that starts a server or worker makes a service, and anything else is a library.

## Agent skill

The package includes a skill for Claude Code and other agents:

```sh
npx skills add MohGanji/repo-blueprint
```

You can also copy [`SKILL.md`](https://github.com/MohGanji/repo-blueprint/blob/main/skills/repo-blueprint/SKILL.md) into your agent's skills folder. Then ask for "a blueprint of this repo", or a live one to keep open while you work. The skill runs this package through `npx`, pinned to an exact version.

## Configuration

None is needed: every imported package is on the map without it. Put a `.blueprint.json` in the root of the repo being mapped to extend the [defaults](https://github.com/MohGanji/repo-blueprint/blob/main/src/blueprint.config.json). For example, to group your own SDKs under one system name:

```json
{
  "externalSystems": { "Billing API": ["@acme/billing-client"] }
}
```

| Key | Description |
| --- | --- |
| `externalSystems` | System names and the packages that indicate them. Labels only: a package not listed still appears under its own name |
| `messaging` | Method and property names for RPC calls, publishes and subscriptions |
| `folderRoles` | Folder names that imply a role, used by the role-mismatch finding |
| `sdkDirs` | Folders whose subfolders are generated API clients, named after the services they call |

## How it works

The TypeScript compiler API and Python's `ast` module extract facts from the source. Those become a model of packages, folders, edges and findings, which is rendered as one diagram per folder.

```
bin/repo-blueprint.mjs     CLI
src/
├── extract-ts.mjs         TypeScript and JavaScript extractor
├── extract-py.py          Python extractor
├── model.mjs              packages, edges, roles, findings
├── views.mjs              one diagram per folder
├── build.mjs              writes the HTML
└── template.html          the page
skills/repo-blueprint/     agent skill
test/                      fixture repos and tests (npm test)
examples/                  blueprints of open-source repos
```

## Contributing

Bug reports and pull requests are welcome. See [CONTRIBUTING.md](https://github.com/MohGanji/repo-blueprint/blob/main/CONTRIBUTING.md).

## License

MIT
