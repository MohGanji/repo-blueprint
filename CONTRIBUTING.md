# Contributing

Thanks for helping. Bug reports, ideas and pull requests are all welcome.

## Reporting a problem

Open an issue with:

- the command you ran and the summary it printed,
- what you expected to see on the map and what you saw instead,
- if you can, a link to the repo you mapped, or a small repo that shows the problem.

## Working on the code

```bash
git clone https://github.com/MohGanji/repo-blueprint.git
cd repo-blueprint
node bin/repo-blueprint.mjs build /path/to/some/repo --open
```

The first run installs the two dependencies, `typescript` and `pele`. There is no build step: edit the files in `src/` and run the command again. Use `watch` to see changes while you work.

Keep the output deterministic: the same commit and the same version must always produce the same page.

## Releasing

The skill pins the package version, so they move together:

1. Bump `version` in `package.json` and `.claude-plugin/plugin.json`.
2. Update the `repo-blueprint@x.y.z` references in `skills/repo-blueprint/SKILL.md`.
3. `npm publish`, then commit, tag `vX.Y.Z` and push.

## Re-recording the demo GIF

`media/record-demo.mjs` drives a blueprint page with Playwright and records a video. Serve a blueprint on localhost, then:

```bash
node media/record-demo.mjs http://127.0.0.1:8765/blueprint.html /tmp/demo-video
ffmpeg -ss 1.4 -i /tmp/demo-video/*.webm -vf "setpts=PTS/1.15,fps=10,scale=960:-1:flags=lanczos,split[a][b];[a]palettegen=max_colors=128:stats_mode=full[p];[b][p]paletteuse=dither=none:diff_mode=rectangle" media/demo.gif
```

The script expects the TanStack Query packages (it hovers and opens `query-core`, `react-query` and `useQuery.ts`); change the labels in it for another repo.
