const glob = (pats) => new RegExp('(^|/)(' + pats.map((p) => p.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '[^/]*').replace(/\/$/, '/.*')).join('|') + ')$');

export function buildModel(repoName, facts, config) {
  const EXTERNAL_SYSTEMS = config.externalSystems;
  const SYSTEM_OF = Object.fromEntries(Object.entries(EXTERNAL_SYSTEMS).flatMap(([sys, pkgs]) => pkgs.map((p) => [p, sys])));
  const FOLDER_ROLE = config.folderRoles;
  const CONVENTIONAL_ENTRY_RE = glob(config.conventionalEntries);
  const FRAMEWORK_LOADED_RE = glob(config.frameworkLoaded);
  const SDK_RE = new RegExp(`/(${config.sdkDirs.join('|')})/([^/]+)/`);
  return buildModelWith({ repoName, facts, EXTERNAL_SYSTEMS, SYSTEM_OF, FOLDER_ROLE, CONVENTIONAL_ENTRY_RE, FRAMEWORK_LOADED_RE, SDK_RE });
}

function buildModelWith({ repoName, facts, EXTERNAL_SYSTEMS, SYSTEM_OF, FOLDER_ROLE, CONVENTIONAL_ENTRY_RE, FRAMEWORK_LOADED_RE, SDK_RE }) {
  const wsList = [...facts].sort((a, b) => a.id.localeCompare(b.id));
  const packages = {};
  const nodes = {};
  const files = {};
  const fileOwner = {};

  for (const w of wsList) {
    const pkgKey = `pkg:${w.id}`;
    const meta = w.meta || {};
    packages[w.id] = { id: w.id, key: pkgKey, dir: w.dir, lang: w.lang, meta, aliases: w.aliases || [], files: 0, lines: 0, folder: w.parent || '' };
    for (const [file, info] of Object.entries(w.files)) {
      fileOwner[file] = w.id;
      files[file] = { key: file, pkg: w.id, lines: info.lines, decls: info.decls, boot: info.boot || [], mount: info.mount || [], externals: info.externals || [], imports: info.imports, entry: { routes: [], rpcServe: [], subscribe: [] }, out: { rpcCall: [], publish: [], http: {} } };
      for (const d of info.decls) for (const r of d.routes || []) files[file].entry.routes.push({ route: r, cls: d.name });
    }
    buildTree(w, pkgKey, Object.keys(w.files).sort(), nodes);
  }
  const chainOf = (key) => {
    const out = [];
    for (let k = key; k; k = nodes[k] ? nodes[k].parent : null) out.unshift(k);
    return out;
  };

  const exportIndex = {};
  for (const [file, f] of Object.entries(files)) {
    for (const d of f.decls) {
      const k = `${f.pkg}::${d.name}`;
      if (!exportIndex[k] || /index\.tsx?$/.test(exportIndex[k])) exportIndex[k] = file;
    }
  }

  const fine = new Map();
  const addEdge = (from, to, kind, detail, n = 1) => {
    if (from === to) return;
    const k = `${from}|${to}|${kind}`;
    if (!fine.has(k)) fine.set(k, { from, to, kind, count: 0, details: new Set() });
    const e = fine.get(k);
    e.count += n;
    if (detail) e.details.add(detail);
  };
  const importedFiles = new Set();
  const importEdges = [];
  for (const [file, f] of Object.entries(files)) {
    for (const imp of f.imports) {
      if (imp.target.startsWith('pkg:')) {
        const tp = imp.target.slice(4);
        for (const n of imp.names) {
          const t = exportIndex[`${tp}::${n}`];
          if (t) importEdges.push({ from: file, to: t, names: [n] });
          else addEdge(file, `pkg:${tp}`, 'import', n);
        }
      } else if (files[imp.target]) {
        importEdges.push({ from: file, to: imp.target, names: imp.names });
      } else {
        const m = SDK_RE.exec('/' + imp.target);
        const target = m && sdkTarget(m[2], packages, f.pkg);
        if (target) {
          addEdge(file, `pkg:${target}`, 'http', `${m[1]}/${m[2]}`);
          f.out.http[target] = (f.out.http[target] || 0) + 1;
        }
      }
    }
  }
  for (const e of importEdges) {
    importedFiles.add(e.to);
    const names = e.names.filter((n) => n !== '*');
    for (const n of names.length ? names : [null]) addEdge(e.from, e.to, 'import', n);
  }

  const provided = {};
  for (const e of importEdges) {
    const ca = chainOf(e.from);
    const cb = chainOf(e.to);
    const samePkg = files[e.from].pkg === files[e.to].pkg;
    let lca = -1;
    while (lca + 1 < Math.min(ca.length, cb.length) && ca[lca + 1] === cb[lca + 1]) lca++;
    const user = samePkg ? ca[lca + 1] : `pkg:${files[e.from].pkg}`;
    for (const x of cb.slice(lca + 1)) {
      const map = (provided[x] ||= {});
      for (const n of e.names.filter((n) => n !== '*')) {
        const k = `${n}@${e.to}`;
        if (!map[k]) map[k] = { name: n, file: e.to, users: new Set() };
        map[k].users.add(user);
      }
    }
  }
  const providedOut = {};
  for (const [k, map] of Object.entries(provided)) {
    providedOut[k] = Object.values(map)
      .map((p) => ({ name: p.name, file: p.file, users: [...p.users].sort() }))
      .sort((a, b) => b.users.length - a.users.length || a.name.localeCompare(b.name));
  }

  const mq = { serve: [], sub: [], pub: [], call: [], dynamic: [] };
  for (const w of wsList) {
    for (const m of w.mq) {
      const file = files[m.handler] ? m.handler : m.file;
      if (!files[file]) continue;
      const rec = { pkg: w.id, file, subject: m.subject, inferred: !!m.inferred, expr: m.expr };
      if (m.kind === 'rpc-serve') mq.serve.push(rec);
      else if (m.kind === 'subscribe') mq.sub.push(rec);
      else if (m.kind === 'publish') mq.pub.push(rec);
      else if (m.kind === 'rpc-call') mq.call.push(rec);
      else mq.dynamic.push({ ...rec, kind: m.kind });
    }
  }
  const uniq = (arr) => [...new Map(arr.map((x) => [x.file + '|' + x.subject, x])).values()];
  for (const k of ['serve', 'sub', 'pub', 'call']) mq[k] = uniq(mq[k]);
  for (const s of mq.serve) files[s.file].entry.rpcServe.push(s.subject);
  for (const s of mq.sub) files[s.file].entry.subscribe.push(s.subject);
  for (const s of mq.call) files[s.file].out.rpcCall.push(s.subject);
  for (const s of mq.pub) files[s.file].out.publish.push(s.subject);
  const unmatched = { calls: [], pubs: [], subs: [] };
  for (const c of mq.call) {
    const servers = mq.serve.filter((s) => s.subject === c.subject);
    if (!servers.length) unmatched.calls.push(c);
    for (const s of servers) addEdge(c.file, s.file, 'rpc', c.subject);
  }
  for (const p of mq.pub) {
    const subs = mq.sub.filter((s) => topicMatch(s.subject, p.subject));
    if (!subs.length) unmatched.pubs.push(p);
    for (const s of subs) addEdge(s.file, p.file, 'event', p.subject);
  }
  for (const s of mq.sub) if (!/[#*]/.test(s.subject) && !mq.pub.some((p) => topicMatch(s.subject, p.subject))) unmatched.subs.push(s);

  const thirdParty = {};
  for (const [file, f] of Object.entries(files)) {
    for (const ext of f.externals) {
      const sys = SYSTEM_OF[ext];
      if (sys) addEdge(file, `ext:${sys}`, 'ext', ext);
      for (const k of chainOf(file)) {
        const t = (thirdParty[k] ||= {});
        t[ext] = (t[ext] || 0) + 1;
      }
    }
  }
  const thirdPartyOut = Object.fromEntries(Object.entries(thirdParty).filter(([k]) => !files[k]).map(([k, o]) => [k, Object.entries(o).sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))]));

  for (const p of Object.values(packages)) {
    const pf = Object.values(files).filter((f) => f.pkg === p.id);
    p.files = pf.length;
    p.lines = pf.reduce((a, f) => a + f.lines, 0);
    const entries = pf.filter((f) => !importedFiles.has(f.key) && (f.boot.length || f.mount.length));
    const evidence = [];
    const declared = p.meta.declared || {};
    if (declared.backstage) evidence.push({ role: { website: 'app', service: 'service', library: 'library' }[declared.backstage] || null, why: `catalog-info.yaml declares spec.type: ${declared.backstage}`, declared: true });
    if (declared.nx) evidence.push({ role: declared.nx === 'library' ? 'library' : entries.some((f) => f.mount.length) ? 'app' : 'service', why: `project.json declares projectType: ${declared.nx}`, declared: true });
    for (const f of entries.filter((f) => f.mount.length)) evidence.push({ role: 'app', why: `${f.key} calls ${f.mount.join(', ')} and nothing imports it` });
    for (const f of entries.filter((f) => f.boot.length)) evidence.push({ role: 'service', why: `${f.key} calls ${f.boot.join(', ')} and nothing imports it` });
    if (p.meta.dockerfile) evidence.push({ role: 'service', why: 'has a Dockerfile' });
    if (p.meta.start) evidence.push({ role: 'service', why: `package.json start script: ${p.meta.start}` });
    const decl = evidence.find((e) => e.declared && e.role);
    p.role = decl ? decl.role : evidence.some((e) => e.role === 'app') ? 'app' : evidence.some((e) => e.role === 'service') ? 'service' : 'library';
    p.roleSource = decl ? 'declared' : 'inferred';
    p.evidence = evidence.slice(0, 6);
    p.entryFiles = entries.map((f) => f.key);
    p.folderRole = FOLDER_ROLE[p.folder] || null;
    p.runtime = runtimeOf(p, thirdParty[p.key] || {});
  }

  const FE = [...fine.values()].map((e) => ({ from: e.from, to: e.to, kind: e.kind, count: e.count, details: [...e.details].sort() })).sort((a, b) => (a.from + a.to + a.kind).localeCompare(b.from + b.to + b.kind));
  const pkgOfKey = (k) => (k.startsWith('pkg:') ? k.slice(4) : files[k] ? files[k].pkg : null);
  const pkgEdges = new Map();
  for (const e of FE) {
    const a = pkgOfKey(e.from);
    const b = pkgOfKey(e.to);
    if (!a || !b || a === b) continue;
    const k = `${a}|${b}|${e.kind}`;
    if (!pkgEdges.has(k)) pkgEdges.set(k, { from: a, to: b, kind: e.kind, count: 0 });
    pkgEdges.get(k).count += e.count;
  }
  const PE = [...pkgEdges.values()];

  const findings = [];
  for (const p of Object.values(packages)) {
    if (p.folderRole && p.folderRole !== p.role) {
      const users = [...new Set(PE.filter((e) => e.to === p.id && e.kind === 'import').map((e) => e.from))].sort();
      findings.push({ type: 'role-mismatch', severity: 'design', pkg: p.id, title: `${p.id} sits in ${p.folder}/ but its code says ${p.role}`, detail: `${p.evidence.length ? p.evidence.map((e) => e.why).join('; ') : 'No entry point, no Dockerfile, no start script'}.${users.length ? ` Imported as code by ${users.join(', ')}.` : ''}` });
    }
    if (p.role !== 'library') {
      const importers = [...new Set(PE.filter((e) => e.to === p.id && e.kind === 'import').map((e) => e.from))].sort();
      if (importers.length) findings.push({ type: 'runnable-imported', severity: 'design', pkg: p.id, title: `${p.id} is a ${p.role} but ${importers.join(', ')} import${importers.length > 1 ? '' : 's'} its code`, detail: 'Runnable packages imported as libraries couple deploys together.' });
    } else if (!PE.some((e) => e.to === p.id)) {
      findings.push({ type: 'unused-library', severity: 'check', pkg: p.id, title: `${p.id} is a library nothing else uses`, detail: 'No entry point and no other package imports it.' });
    }
  }
  const disguised = {};
  for (const p of Object.values(packages)) {
    for (const a of p.aliases) {
      const outside = a.targets.filter((t) => !(t + '/').startsWith(p.dir === '.' ? '' : p.dir + '/'));
      if (a.pattern.startsWith('@/') && outside.length) (disguised[`${a.pattern} → ${outside.join(', ')}`] ||= []).push(p.id);
    }
  }
  for (const [k, pkgs] of Object.entries(disguised).sort()) findings.push({ type: 'disguised-alias', severity: 'smell', title: `Alias ${k.split(' → ')[0]} looks local but points into another package`, detail: `Resolves to ${k.split(' → ')[1]} in ${pkgs.length} package${pkgs.length > 1 ? 's' : ''}: ${pkgs.sort().join(', ')}.`, members: pkgs });
  const dyn = mq.dynamic.length ? ` ${mq.dynamic.length} call sites use a subject only known at runtime (${mq.dynamic.map((d) => d.file.split('/').pop()).join(', ')}).` : '';
  for (const c of unmatched.calls) findings.push({ type: 'rpc-no-server', severity: 'check', pkg: c.pkg, title: `RPC "${c.subject}" has no server in the repo`, detail: `Called from ${c.file}.` });
  for (const p of unmatched.pubs) findings.push({ type: 'event-no-subscriber', severity: 'check', pkg: p.pkg, title: `Event "${p.subject}" has no subscriber in the repo`, detail: `Published from ${p.file}.` });
  for (const s of unmatched.subs) findings.push({ type: 'subscription-no-publisher', severity: 'check', pkg: s.pkg, title: `"${s.subject}" is subscribed but never published in the repo`, detail: `Handled in ${s.file}.${dyn}` });
  const orphans = {};
  for (const [file, f] of Object.entries(files)) {
    if (importedFiles.has(file) || CONVENTIONAL_ENTRY_RE.test(file) || FRAMEWORK_LOADED_RE.test(file) || f.boot.length || f.mount.length) continue;
    (orphans[f.pkg] ||= []).push(file);
  }
  for (const [pkg, list] of Object.entries(orphans).sort()) findings.push({ type: 'orphan-files', severity: 'check', pkg, title: `${list.length} file${list.length > 1 ? 's' : ''} in ${pkg} never imported`, detail: 'Not imported by any other file and not an entry point.', files: list.sort() });

  for (const f of Object.values(files)) {
    delete f.imports;
    delete f.externals;
    for (const k of ['rpcServe', 'subscribe']) f.entry[k] = [...new Set(f.entry[k])].sort();
    for (const k of ['rpcCall', 'publish']) f.out[k] = [...new Set(f.out[k])].sort();
  }
  return {
    repoName,
    externalSystems: EXTERNAL_SYSTEMS,
    packages,
    nodes,
    files,
    provided: providedOut,
    thirdParty: thirdPartyOut,
    fineEdges: FE,
    findings,
    mq: { calls: mq.call.length, serves: mq.serve.length, pubs: mq.pub.length, subs: mq.sub.length, dynamic: mq.dynamic },
  };
}

function runtimeOf(p, used) {
  if (p.lang === 'python') {
    for (const [mod, name] of [['fastapi', 'FastAPI'], ['django', 'Django'], ['flask', 'Flask'], ['aio_pika', 'Python worker']]) if (used[mod]) return name;
    return 'Python';
  }
  const ui = [['react', 'React'], ['react-dom', 'React'], ['vue', 'Vue'], ['@angular/core', 'Angular'], ['svelte', 'Svelte'], ['solid-js', 'Solid']];
  const server = [['@nestjs/core', 'NestJS'], ['@nestjs/common', 'NestJS'], ['express', 'Express'], ['fastify', 'Fastify'], ['hono', 'Hono'], ['@temporalio/worker', 'Temporal'], ['koa', 'Koa']];
  for (const [mod, name] of p.role === 'app' ? [...ui, ...server] : [...server, ...ui]) if (used[mod]) return name;
  return 'TypeScript';
}

function sdkTarget(name, packages, self) {
  for (const id of [name, name + 's', name.replace(/s$/, '')]) if (packages[id] && id !== self) return id;
  return null;
}

function buildTree(w, pkgKey, fileKeys, nodes) {
  const base = w.dir === '.' ? '' : w.dir + '/';
  const root = { dirs: new Map(), files: [], path: w.dir };
  for (const f of fileKeys) {
    const parts = f.slice(base.length).split('/');
    let t = root;
    let acc = w.dir === '.' ? '' : w.dir;
    for (const seg of parts.slice(0, -1)) {
      acc = acc ? `${acc}/${seg}` : seg;
      if (!t.dirs.has(seg)) t.dirs.set(seg, { dirs: new Map(), files: [], path: acc });
      t = t.dirs.get(seg);
    }
    t.files.push(f);
  }
  let eff = root;
  while (!eff.files.length && eff.dirs.size === 1) eff = [...eff.dirs.values()][0];
  const make = (t, key, name, parent, type) => {
    const children = [];
    for (const [seg, sub] of [...t.dirs.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
      let c = sub;
      let nm = seg;
      while (!c.files.length && c.dirs.size === 1) {
        const [s2, c2] = [...c.dirs.entries()][0];
        nm += '/' + s2;
        c = c2;
      }
      children.push(make(c, c.path, nm, key, 'dir'));
    }
    for (const f of t.files.sort()) {
      nodes[f] = { key: f, type: 'file', name: f.split('/').pop(), pkg: w.id, parent: key, children: [], files: 1 };
      children.push(f);
    }
    const count = children.reduce((a, c) => a + nodes[c].files, 0);
    nodes[key] = { key, type, name, pkg: w.id, parent, path: t.path, children, files: count };
    return key;
  };
  make(eff, pkgKey, w.id, null, 'pkg');
}

export function topicMatch(pattern, subject) {
  const p = pattern.split('.');
  const s = subject.split('.');
  const go = (i, j) => {
    if (i === p.length) return j === s.length;
    if (p[i] === '#') return go(i + 1, j) || (j < s.length && go(i, j + 1));
    if (j === s.length) return false;
    return (p[i] === '*' || p[i] === s[j]) && go(i + 1, j + 1);
  };
  return go(0, 0);
}

export function levels(nodes, edges) {
  const ids = [...nodes].sort();
  const adj = new Map(ids.map((n) => [n, []]));
  for (const e of edges) if (adj.has(e.from) && adj.has(e.to) && e.from !== e.to) adj.get(e.from).push(e.to);
  for (const v of adj.values()) v.sort();
  let index = 0;
  const idx = new Map();
  const low = new Map();
  const stack = [];
  const on = new Set();
  const comp = new Map();
  const sccs = [];
  const strong = (v) => {
    idx.set(v, index);
    low.set(v, index++);
    stack.push(v);
    on.add(v);
    for (const w of adj.get(v)) {
      if (!idx.has(w)) {
        strong(w);
        low.set(v, Math.min(low.get(v), low.get(w)));
      } else if (on.has(w)) low.set(v, Math.min(low.get(v), idx.get(w)));
    }
    if (low.get(v) === idx.get(v)) {
      const s = [];
      let w;
      do {
        w = stack.pop();
        on.delete(w);
        s.push(w);
      } while (w !== v);
      s.sort();
      sccs.push(s);
      for (const x of s) comp.set(x, sccs.length - 1);
    }
  };
  for (const v of ids) if (!idx.has(v)) strong(v);
  const memo = new Map();
  const lv = (ci) => {
    if (memo.has(ci)) return memo.get(ci);
    let l = 0;
    for (const v of sccs[ci]) for (const w of adj.get(v)) if (comp.get(w) !== ci) l = Math.max(l, lv(comp.get(w)) + 1);
    memo.set(ci, l);
    return l;
  };
  const level = {};
  for (const v of ids) level[v] = lv(comp.get(v));
  return { level, cycles: sccs.filter((s) => s.length > 1), sccOf: comp, adj };
}

export function transitiveReduction(nodes, edges) {
  const { sccOf, adj } = levels(nodes, edges);
  const reach = (from, skipDirect) => {
    const seen = new Set();
    const st = adj.get(from).filter((w) => w !== skipDirect);
    while (st.length) {
      const v = st.pop();
      if (seen.has(v)) continue;
      seen.add(v);
      for (const w of adj.get(v) || []) st.push(w);
    }
    return seen;
  };
  return edges.filter((e) => {
    if (sccOf.get(e.from) === sccOf.get(e.to)) return true;
    return !reach(e.from, e.to).has(e.to);
  });
}
