import { render } from 'pele';
import { transitiveReduction, levels as sccLevels } from './model.mjs';

const ROW = 6;
const OUTER_MAX = 7;
const PAIRS_MAX = 8;
const ARROW = { import: '-->', rpc: '==>', http: '-.->', event: '-.-o', ext: '-->' };
const KIND_ORDER = ['import', 'rpc', 'http', 'event', 'ext'];
const LEVEL_KINDS = new Set(['import', 'rpc', 'http']);
const ROLE_CLASS = { library: 'lib', service: 'service', app: 'app' };

const q = (s) => String(s).replace(/"/g, '#quot;').replace(/[<>]/g, '');

export function buildViews(model) {
  const { packages, nodes, files } = model;
  const chainCache = new Map();
  const chainOf = (key) => {
    if (chainCache.has(key)) return chainCache.get(key);
    const out = [];
    for (let k = key; k; k = nodes[k] ? nodes[k].parent : null) out.unshift(k);
    chainCache.set(key, out);
    return out;
  };
  const hasView = (k) => nodes[k] && nodes[k].type !== 'file' && nodes[k].children.length >= 2;
  const viewOf = (k) => {
    const ch = chainOf(k);
    for (let i = ch.length - 2; i >= 0; i--) if (hasView(ch[i])) return { view: `v:${ch[i]}`, sel: ch[i + 1] };
    return { view: 'root', sel: `pkg:${nodes[k].pkg}` };
  };
  const sub = (k) => {
    const n = nodes[k];
    if (n.type === 'file') return `${files[k].lines} lines`;
    return `${n.files} file${n.files > 1 ? 's' : ''}`;
  };

  const views = {};
  views.root = makeView({
    id: 'root',
    title: model.repoName,
    kind: 'root',
    ref: null,
    parent: null,
    internal: Object.values(packages)
      .sort((a, b) => a.id.localeCompare(b.id))
      .map((p) => ({ key: p.key, label: p.id, sub: `${p.runtime} · ${p.files} files`, cls: [ROLE_CLASS[p.role], 'drill'], drill: hasView(p.key) ? `v:${p.key}` : null })),
    map: (k) => (k.startsWith('ext:') ? { key: k, inside: false } : k.startsWith('pkg:') ? { key: k, inside: true } : { key: `pkg:${files[k].pkg}`, inside: true }),
    edges: model.fineEdges,
  });

  for (const n of Object.values(nodes)) {
    if (!hasView(n.key)) continue;
    const isPkg = n.type === 'pkg';
    const p = packages[n.pkg];
    const myChain = chainOf(n.key);
    views[`v:${n.key}`] = makeView({
      id: `v:${n.key}`,
      title: isPkg ? n.name : n.name.split('/').pop(),
      kind: isPkg ? 'pkg' : 'dir',
      ref: n.key,
      parent: isPkg ? 'root' : viewOf(n.key).view,
      frame: isPkg ? `${n.name} · ${p.runtime} ${p.role}` : p.dir === '.' ? n.path : n.path.slice(p.dir.length + 1),
      internal: n.children.map((c) => {
        const cn = nodes[c];
        const drill = hasView(c) ? `v:${c}` : null;
        return { key: c, label: cn.name, sub: sub(c), cls: cn.type === 'file' ? ['child', 'file'] : drill ? ['comp', 'drill'] : ['comp'], drill };
      }),
      outerOf: (k) => {
        if (k.startsWith('pkg:')) {
          const op = packages[k.slice(4)];
          return { key: k, label: op.id, cls: ['outer', ROLE_CLASS[op.role]], go: hasView(k) ? `v:${k}` : 'root', sel: hasView(k) ? null : k };
        }
        const on = nodes[k];
        const target = hasView(k) ? { go: `v:${k}`, sel: null } : (({ view, sel }) => ({ go: view, sel }))(viewOf(k));
        return { key: k, label: on.name, cls: ['outer', on.type === 'file' ? 'file' : 'comp'], ...target };
      },
      map: (k) => {
        if (k.startsWith('ext:')) return { key: k, inside: false };
        if (k.startsWith('pkg:')) return k === n.key || k.slice(4) === n.pkg ? { key: 'FRAME', inside: true } : { key: k, inside: false };
        const ch = chainOf(k);
        const i = ch.indexOf(n.key);
        if (i >= 0) return { key: ch[i + 1], inside: true };
        if (files[k].pkg !== n.pkg) return { key: `pkg:${files[k].pkg}`, inside: false };
        let lca = -1;
        while (lca + 1 < Math.min(ch.length, myChain.length) && ch[lca + 1] === myChain[lca + 1]) lca++;
        return { key: ch[lca + 1], inside: false };
      },
      edges: model.fineEdges,
    });
  }
  return views;
}

function makeView(v) {
  const outerOf = (k) => (k.startsWith('ext:') ? { key: k, label: k.slice(4), cls: ['outer', 'ext'] } : v.outerOf(k));
  const sideOf = (k, fallback) => (k.startsWith('ext:') ? 'ext' : fallback);
  const internalKeys = new Set(v.internal.map((n) => n.key));
  const agg = new Map();
  for (const e of v.edges) {
    const a = v.map(e.from);
    const b = v.map(e.to);
    if (!a.key || !b.key || a.key === b.key) continue;
    if (!a.inside && !b.inside) continue;
    if (a.inside && !internalKeys.has(a.key) && a.key !== 'FRAME') continue;
    if (b.inside && !internalKeys.has(b.key) && b.key !== 'FRAME') continue;
    if ((a.key === 'FRAME' && b.inside) || (b.key === 'FRAME' && a.inside)) continue;
    const k = `${a.key}|${b.key}|${e.kind}`;
    if (!agg.has(k)) agg.set(k, { from: a.key, to: b.key, kind: e.kind, count: 0, details: new Set(), pairs: new Map(), fromInside: a.inside, toInside: b.inside });
    const x = agg.get(k);
    x.count += e.count;
    for (const d of e.details) x.details.add(d);
    const pk = `${e.from}|${e.to}`;
    if (!x.pairs.has(pk)) x.pairs.set(pk, new Set());
    for (const d of e.details) x.pairs.get(pk).add(d);
  }
  const sortEdges = (arr) => arr.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind) || (a.from + a.to).localeCompare(b.from + b.to));
  const all = sortEdges(
    [...agg.values()].map((e) => ({
      ...e,
      details: [...e.details].sort(),
      pairs: [...e.pairs.entries()]
        .sort((a, b) => b[1].size - a[1].size || a[0].localeCompare(b[0]))
        .slice(0, PAIRS_MAX)
        .map(([pk, ds]) => ({ from: pk.split('|')[0], to: pk.split('|')[1], names: [...ds].sort() })),
      pairCount: e.pairs.size,
    })),
  );

  const lv = sccLevels([...internalKeys], all.filter((e) => LEVEL_KINDS.has(e.kind) && e.fromInside && e.toInside));
  const cycles = sccLevels([...internalKeys], all.filter((e) => e.kind === 'import' && e.fromInside && e.toInside)).cycles;
  const cycleOf = new Map();
  cycles.forEach((c, i) => c.forEach((k) => cycleOf.set(k, i)));
  for (const n of v.internal) n.level = lv.level[n.key];

  const outer = new Map();
  for (const e of all) {
    if (!e.fromInside && !outer.has(e.from)) outer.set(e.from, { side: sideOf(e.from, 'up'), weight: 0 });
    if (!e.toInside) outer.set(e.to, { side: sideOf(e.to, 'down'), weight: outer.get(e.to)?.weight || 0 });
  }
  for (const e of all) for (const k of [e.from, e.to]) if (outer.has(k)) outer.get(k).weight += e.count;
  const more = { up: [], down: [] };
  if (v.frame) {
    for (const side of ['up', 'down']) {
      const ranked = [...outer.entries()].filter(([, o]) => o.side === side).sort((a, b) => b[1].weight - a[1].weight || a[0].localeCompare(b[0]));
      if (ranked.length > OUTER_MAX) {
        for (const [k] of ranked.slice(OUTER_MAX - 1)) {
          more[side].push(k);
          outer.delete(k);
        }
        outer.set(`more:${side}`, { side, weight: 0 });
      }
    }
  }
  const moreOf = (k) => (more.up.includes(k) ? 'more:up' : more.down.includes(k) ? 'more:down' : k);

  const importsInside = all.filter((e) => e.kind === 'import' && e.fromInside && e.toInside);
  const reduced = new Set(transitiveReduction([...internalKeys], importsInside).map((e) => `${e.from}|${e.to}`));
  const drawn = [];
  let hiddenImplied = 0;
  const outerGroups = new Map();
  for (const e of all) {
    if (e.fromInside && e.toInside) {
      const inCycle = cycleOf.has(e.from) && cycleOf.get(e.from) === cycleOf.get(e.to);
      if (e.kind === 'import' && !inCycle && !reduced.has(`${e.from}|${e.to}`)) hiddenImplied++;
      else drawn.push(e);
      continue;
    }
    const inner = e.fromInside ? e.from : e.to;
    const o = moreOf(e.fromInside ? e.to : e.from);
    const dir = e.fromInside ? 'out' : 'in';
    const gk = `${o}|${dir}`;
    if (!outerGroups.has(gk)) outerGroups.set(gk, { o, dir, inner: new Set(), kinds: new Set(), count: 0, details: new Set(), pairs: [] });
    const g = outerGroups.get(gk);
    g.inner.add(inner);
    g.kinds.add(e.kind);
    g.count += e.count;
    for (const d of e.details) g.details.add(d);
    if (g.pairs.length < PAIRS_MAX) g.pairs.push(...e.pairs.slice(0, PAIRS_MAX - g.pairs.length));
  }
  for (const g of [...outerGroups.values()].sort((a, b) => (a.o + a.dir).localeCompare(b.o + b.dir))) {
    const kind = ['rpc', 'http', 'import', 'event', 'ext'].find((k) => g.kinds.has(k));
    const base = { kind, count: g.count, details: [...g.details].sort(), pairs: g.pairs };
    if (!v.frame) {
      for (const inner of [...g.inner].sort()) drawn.push({ ...base, from: g.dir === 'out' ? inner : g.o, to: g.dir === 'out' ? g.o : inner });
      continue;
    }
    const inner = g.inner.size === 1 ? [...g.inner][0] : 'FRAME';
    drawn.push({ ...base, from: g.dir === 'out' ? inner : g.o, to: g.dir === 'out' ? g.o : inner, collapsed: inner === 'FRAME' });
  }

  const mid = new Map();
  const nodes = {};
  let n = 0;
  const idFor = (key) => {
    if (key === 'FRAME') return 'FRAME';
    if (!mid.has(key)) mid.set(key, `n${n++}`);
    return mid.get(key);
  };
  const lines = ['flowchart TB'];
  const classes = new Map();
  const emitNode = (node, indent) => {
    const id = idFor(node.key);
    lines.push(`${indent}${id}["${q(node.label)}${node.sub ? `<br/>${q(node.sub)}` : ''}"]`);
    for (const c of node.cls || []) classes.set(c, [...(classes.get(c) || []), id]);
    nodes[id] = { key: node.key, drill: node.drill || null, go: node.go || null, sel: node.sel || null, outer: !!node.outerSide, side: node.outerSide || null };
  };
  const outerNodes = (side) =>
    [...outer.entries()]
      .filter(([, o]) => o.side === side)
      .map(([k]) => (k.startsWith('more:') ? { key: k, label: `+${more[side].length} more`, cls: ['outer', 'more'], outerSide: side } : { ...outerOf(k), outerSide: side }))
      .sort((a, b) => (a.key.startsWith('more:') ? 1 : 0) - (b.key.startsWith('more:') ? 1 : 0) || a.label.localeCompare(b.label));
  const ups = v.frame ? outerNodes('up') : [];
  const downs = v.frame ? outerNodes('down') : [];
  const exts = outerNodes('ext');
  const chunk = (arr, indent) => {
    for (const x of arr) emitNode(x, indent);
    for (let i = 0; i + ROW < arr.length; i++) lines.push(`${indent}${idFor(arr[i].key)} ~~~ ${idFor(arr[i + ROW].key)}`);
  };

  if (ups.length) {
    lines.push(`  subgraph UP["Dependents · outside ${q(v.title)}"]`);
    chunk(ups, '    ');
    lines.push('  end');
  }
  const ind = v.frame ? '    ' : '  ';
  if (v.frame) lines.push(`  subgraph FRAME["${q(v.frame)}"]`);
  const levelList = [...new Set(v.internal.map((x) => x.level))].sort((a, b) => b - a);
  const maxL = levelList[0];
  for (const l of levelList) {
    const ns = v.internal.filter((x) => x.level === l).sort((a, b) => a.label.localeCompare(b.label));
    const name = l === 0 ? 'L0 · Base' : l === maxL ? `L${l} · Entry` : `L${l}`;
    lines.push(`${ind}subgraph L${l}["${name}"]`);
    const groups = [...new Set(ns.filter((x) => cycleOf.has(x.key)).map((x) => cycleOf.get(x.key)))];
    for (const g of groups) {
      const members = ns.filter((x) => cycleOf.get(x.key) === g);
      lines.push(`${ind}  subgraph C${g}["Import cycle · ${members.length} parts"]`);
      chunk(members, ind + '    ');
      lines.push(`${ind}  end`);
    }
    chunk(ns.filter((x) => !cycleOf.has(x.key)), ind + '  ');
    lines.push(`${ind}end`);
  }
  if (v.frame) lines.push('  end');
  if (downs.length) {
    lines.push(`  subgraph DOWN["Dependencies · outside ${q(v.title)}"]`);
    chunk(downs, '    ');
    lines.push('  end');
  }
  if (exts.length) {
    lines.push('  subgraph EXT["External systems"]');
    chunk(exts, '    ');
    lines.push('  end');
  }
  for (let i = 0; i + 1 < levelList.length; i++) lines.push(`  L${levelList[i]} ~~~ L${levelList[i + 1]}`);
  if (ups.length) lines.push('  UP ~~~ FRAME');
  if (downs.length) lines.push('  FRAME ~~~ DOWN');
  if (exts.length) lines.push(`  ${downs.length ? 'DOWN' : v.frame ? 'FRAME' : `L${levelList[levelList.length - 1]}`} ~~~ EXT`);

  const edges = {};
  const pairCount = new Map();
  for (const e of drawn) {
    const a = idFor(e.from);
    const b = idFor(e.to);
    lines.push(`  ${a} ${ARROW[e.kind]} ${b}`);
    const pk = `${a}_${b}`;
    const i = pairCount.get(pk) || 0;
    pairCount.set(pk, i + 1);
    edges[`L_${a}_${b}_${i}`] = { from: e.from, to: e.to, kind: e.kind, collapsed: !!e.collapsed };
  }
  for (const [c, ids] of [...classes.entries()].sort()) {
    lines.push(`  classDef ${c} stroke-width:1px`);
    lines.push(`  class ${ids.join(',')} ${c}`);
  }
  const src = lines.join('\n');
  let out;
  try {
    out = render(src, { responsive: false, fontSize: 14, fontFamily: '"Helvetica Neue", Arial, sans-serif', padding: 12, maxEdges: 20000 });
  } catch (err) {
    throw new Error(`Pele failed on view ${v.id}: ${err.message}`);
  }
  return {
    id: v.id,
    title: v.title,
    kind: v.kind,
    ref: v.ref,
    parent: v.parent,
    framed: !!v.frame,
    svg: out.svg.replace(/(\d+\.\d)\d+/g, '$1'),
    width: out.width,
    height: out.height,
    nodes,
    keyToMid: Object.fromEntries([...mid.entries()]),
    edges,
    more,
    cycles,
    levels: Object.fromEntries(v.internal.map((x) => [x.key, x.level])),
    all: all.map((e) => ({ from: e.from, to: e.to, kind: e.kind, count: e.count, details: e.details.slice(0, 40), pairs: e.pairs, pairCount: e.pairCount })),
    hiddenCount: hiddenImplied,
    source: src,
  };
}
