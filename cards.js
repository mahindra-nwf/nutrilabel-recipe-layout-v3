// NutriLabel assembly builder — assembly cards (Modernist Cuisine style) linked like a flow.
// The final assembly is the main card; every sub-assembly row links to its own card.
(function () {
  const CARDW = 700, GAPX = 140, GAPY = 36;
  const COLORS = ['#3b82f6', '#ef4444', '#8b5cf6', '#f59e0b', '#14b8a6', '#ec4899', '#f97316', '#6366f1'];
  const $ = s => document.querySelector(s);
  const vpEl = $('#vp'), worldEl = $('#world'), linksEl = $('#links'), boardCardsEl = $('#cards');
  let svEl = $('#sheetView'), svInnerEl = $('#svInner'), svCardsEl = $('#svCards'), svLinksEl = $('#svLinks'); // swapped while the split side is current
  let cardsEl = boardCardsEl, view = 'board', orderIdx = {}, depthMap = {}; // view: 'board' (canvas) or 'sheet' (stacked)

  let S, calc, hist, cost = {};
  // Building / Scaling card faces. Style 'flip' turns the card over to a read-only scaling side; 'hide' keeps the card and hides the building columns.
  let scaleStyle = 'flip'; try { if (localStorage.getItem('nlv3_scale_style') === 'hide') scaleStyle = 'hide'; } catch { }
  const fieldUnit = {}; // data-fk -> unit, while that weight box has focus
  const wf = (fk, g, d) => { const u = fieldUnit[fk] || NL.unitFor(g); return { u, v: NL.inUnit(g, u, d), a: `data-u="${u}"` }; };
  // board: the selected card (the one you clicked or are dragging) sits on top of the others
  let topId = null;
  const zOf = id => id === topId ? 1 : 0;
  const raise = id => {
    if (topId === id) return;
    topId = id;
    boardCardsEl.querySelectorAll('.rcard').forEach(el => { el.style.zIndex = zOf(el.dataset.id); });
  };
  // ⚙ Settings: each setting registers how to read itself and put itself back, so Cancel can undo a session
  const settingsReg = [];
  const flipIn = {}; // card id -> 1 while its flip-in animation should play
  const fwErr = {}; // card id -> message while the typed final weight is invalid
  const amtErr = {}; // 'card:row' -> message while a typed ingredient weight is invalid
  const fwStart = {}; // card id -> yieldLoss when editing began, restored if the entry is invalid

  function fromSample() {
    const s = JSON.parse(JSON.stringify(NL.SAMPLE));
    Object.entries(s.asm).forEach(([id, a], i) => {
      a.color = id === s.root ? '#0f766e' : COLORS[(i - 1) % COLORS.length];
      a.steps = a.steps || []; a.notes = a.notes || ''; a.x = 0; a.y = 0;
    });
    return s;
  }
  const A = id => S.asm[id];
  const ROOT_COLOR = '#0f766e';
  // The final card is optional: S.root is null until the chef marks a card as Final.
  const colorOf = id => id === S.root ? ROOT_COLOR : (A(id)?.color || '#94a3b8');
  const hasFinal = () => !!(S.root && A(S.root));
  const subIdOf = ref => ref.startsWith('asm:') ? ref.slice(4) : null;
  const parentsOf = id => Object.entries(S.asm).flatMap(([pid, a]) => a.items.filter(it => it.ref === 'asm:' + id).map(it => ({ pid, amount: it.amount })));
  function descendants(id, acc = new Set()) {
    for (const it of A(id).items) { const s = subIdOf(it.ref); if (s && A(s) && !acc.has(s)) { acc.add(s); descendants(s, acc); } }
    return acc;
  }
  // a card shows its Scaling side only when it is set to and has weights (same rule as cardHTML)
  const onScaleSide = id => A(id)?.face === 'scale' && calc?.[id]?.batch > 0;
  const wouldCycle = (parent, child) => parent === child || descendants(child).has(parent);

  // ---------- retailers: ingredients each retailer does not allow ----------
  // The retailer list is kept per browser (like favorites); each recipe tab checks every retailer
  // except the ones unticked for it (S.retailOff). A ban matches whole words of an ingredient's name.
  const RETAIL = 'nlv3_retailers';
  // split pasted / typed text into separate items: one per line, or on commas / semicolons
  // (not inside brackets, so "Sodium Sulfosuccinate (DSS)" stays whole); bullets and numbers are dropped.
  // A text that is exactly a library ingredient name (e.g. "Garlic, minced") is kept as one item.
  const isLibName = t => NL.INGREDIENTS.some(i => i.name.toLowerCase() === t.trim().toLowerCase());
  function splitItems(txt) {
    if (isLibName(txt)) return [txt.trim()];
    const out = []; let cur = '', depth = 0;
    const multiline = /[\r\n]/.test(txt.trim());
    for (const ch of txt) {
      if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) depth = Math.max(0, depth - 1);
      if (ch === '\n' || ch === '\r' || ((ch === ',' || ch === ';') && depth === 0 && (!multiline || ch === ';'))) { out.push(cur); cur = ''; continue; }
      cur += ch;
    }
    out.push(cur);
    return out.map(p => p.replace(/^\s*(?:[-*•·]|\d+[.)])\s*/, '').trim()).filter(Boolean);
  }
  // read the list; entries saved as one long "a, b, c" item are split into separate items (once)
  const readRetail = () => {
    let list; try { list = JSON.parse(localStorage.getItem(RETAIL)) || []; } catch { return []; }
    let changed = false;
    for (const r of list) {
      const bans = [];
      for (const b of r.bans) for (const t of splitItems(b)) if (!bans.some(x => x.toLowerCase() === t.toLowerCase())) bans.push(t);
      if (bans.length !== r.bans.length || bans.some((b, k) => b !== r.bans[k])) { r.bans = bans; changed = true; }
    }
    if (changed) try { localStorage.setItem(RETAIL, JSON.stringify(list)); } catch { }
    return list;
  };
  const saveRetail = list => { try { localStorage.setItem(RETAIL, JSON.stringify(list)); } catch { } };
  const retailOn = r => !(S.retailOff || []).includes(r.id);
  const reEsc = t => t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  let banRules = [], banMemo = {};
  function computeBans() {
    banMemo = {};
    banRules = readRetail().filter(retailOn).flatMap(r => r.bans.map(b => ({ shop: r.name, re: new RegExp(`(^|[^a-z0-9])${reEsc(b.toLowerCase())}($|[^a-z0-9])`) })));
  }
  // retailers that ban this ingredient
  const bansFor = ing => { const n = (ing?.name || '').toLowerCase(); return n && banRules.length ? [...new Set(banRules.filter(x => x.re.test(n)).map(x => x.shop))] : []; };
  // every banned ingredient in a card, including inside its sub-assemblies: [{ name, shops }]
  function banHits(id) {
    if (banMemo[id]) return banMemo[id];
    if (!banRules.length || !A(id)) return [];
    banMemo[id] = []; // guards against loops while walking
    const out = new Map();
    for (const it of A(id).items) {
      const sid = subIdOf(it.ref), ing = sid ? null : NL.ingMap[it.ref.slice(4)];
      const list = sid ? banHits(sid) : (sh => sh.length ? [{ name: ing?.name || it.ref, shops: sh }] : [])(bansFor(ing));
      for (const h of list) out.set(h.name, { name: h.name, shops: [...new Set([...(out.get(h.name)?.shops || []), ...h.shops])] });
    }
    return (banMemo[id] = [...out.values()]);
  }
  const banTag = shops => shops.length ? `<span class="ban-tag" title="Not allowed by ${NL.esc(shops.join(', '))}">⛔ ${NL.esc(shops.join(', '))}</span>` : '';

  // ---------- rendering ----------
  // The Final card's pinned columns flow down: for each one, how many grams of every sub-assembly it needs
  // (Final amount x its scale, then through each sub-assembly's own recipe and cooking loss). Read-only.
  let finFlows = [];
  const pinLabel = p => p.mode === 'portion' ? `${NL.fmt(p.count, 2)} × ${NL.ws(p.size, 1)}` : p.mode === 'base' ? `Base ${NL.ws(p.target, 1)}` : `Yield ${NL.ws(p.target, 1)}`;
  function computeFlows() {
    finFlows = [];
    if (!hasFinal()) return;
    const root = A(S.root), rc = calc[S.root];
    (root.scalePins || []).forEach((p, k) => {
      const need = {};
      const walk = (id, f) => A(id).items.forEach(it => {
        const sid = subIdOf(it.ref); if (!sid || !A(sid) || !(calc[sid]?.yielded > 0)) return;
        const g = (+it.amount || 0) * f;
        need[sid] = (need[sid] || 0) + g;
        walk(sid, g / calc[sid].yielded);
      });
      walk(S.root, pinFactor(p, rc, baseTotal(root)));
      finFlows.push({ key: 'fin-' + (p.id || k), p, need });
    });
  }
  function paintLeft() {
    calc = NL.calc(S); cost = NL.cost(S, calc); computeFlows(); computeBans();
    if (view === 'sheet') {
      const ord = sheetOrder(); orderIdx = Object.fromEntries(ord.map((id, k) => [id, k])); depthMap = depths();
      cardsEl.innerHTML = ord.length ? ord.map(cardHTML).join('') : SHEET_EMPTY;
    } else cardsEl.innerHTML = Object.keys(S.asm).map(cardHTML).join('');
    stickCols(cardsEl);
    drawLinks();
    drawTree();
    drawRetail();
    drawNut();
    $('#recipeTitle').textContent = hasFinal() ? A(S.root).name : (S.draftName || 'Untitled assembly');
    $('#emptyHint').hidden = Object.keys(S.asm).length > 0;
    wb.live(S);
  }
  const renderKeep = () => NL.keepFocus(render);
  // flip side: Ingredient, Weight and Cost stay put while the scaled columns scroll sideways
  function stickCols(root) {
    // Scaling side: widen the card so every pinned column fits without scrolling sideways
    for (const b of root.querySelectorAll('.rcard.face-scale .rc-body')) {
      const t = b.querySelector('.rc-tbl'), card = b.closest('.rcard'); if (!t || !b.clientWidth) continue;
      const zoom = b.getBoundingClientRect().width / b.offsetWidth || 1; // the board may be zoomed
      const over = Math.max(b.scrollWidth, t.getBoundingClientRect().width / zoom) - b.clientWidth;
      if (over > 0) card.style.width = Math.ceil(card.offsetWidth + over) + 1 + 'px';
    }
    for (const t of root.querySelectorAll('.rcard.flipface .rc-tbl')) {
      const h = t.tHead?.rows[0]; if (!h || !h.cells[0].offsetWidth) continue;
      const w1 = h.cells[0].offsetWidth, w2 = h.querySelector('.hc-w').offsetWidth;
      t.style.setProperty('--s1', w1 + 'px'); t.style.setProperty('--s2', w1 + w2 + 'px');
    }
  }
  // re-measure when the card area changes width (panel hidden, window resized, split opened)
  { const ro = new ResizeObserver(() => { for (const el of [boardCardsEl, $('#svCards'), $('#spCards')]) if (el) stickCols(el); }); for (const el of [$('#svCards'), $('#spCards'), $('#cmain')]) if (el) ro.observe(el); }
  function setFace(id, f) {
    const s = side, el = cardsEl.querySelector(`.rcard[data-id="${id}"]`), anim = scaleStyle === 'flip' && el && !matchMedia('(prefers-reduced-motion: reduce)').matches;
    const go = () => { const a = A(id); if (!a) return; if (f === 'scale') a.face = 'scale'; else delete a.face; if (anim) flipIn[id] = 1; render(); delete flipIn[id]; saveCur(); hist.sync(); };
    if (anim) { el.classList.add('flip-out'); setTimeout(() => withSide(s, go), 170); } else go();
  }

  function cardHTML(id) {
    const a = A(id), c = calc[id], cc = cost[id] || { batch: 0, perG: 0, missing: 0 }, isRoot = id === S.root;
    const parents = parentsOf(id);
    const kind = `<div class="rc-kind" title="Is this the final assembly or a sub-assembly?"><button class="${isRoot ? 'on' : ''}" data-kind="final:${id}">Final</button><button class="${isRoot ? '' : 'on'}" data-kind="sub:${id}">Sub-assembly</button></div>`;
    const apObj = isRoot ? null : activePin(a), ap = apObj ? pinPortion(apObj, c, baseTotal(a)) : null;
    // portion size on top: a dropdown of the parent's amount + each pinned column's portion (display only, never changes weights)
    const psLabel = p => {
      const pins0 = a.scalePins || [], used = `${NL.ws(+p.amount || 0, 2)}`;
      if (!pins0.length) return `<span class="rc-ps" title="The amount of this sub-assembly that goes into ${NL.esc(A(p.pid).name)}">(portion size ${used})</span>`;
      const label = q => q.mode === 'portion' ? `${NL.ws(q.size, 1)} × ${NL.fmt(q.count, 2)}` : q.mode === 'base' ? `Base ${NL.ws(q.target, 1)}` : `Yield ${NL.ws(q.target, 1)}`;
      return `<span class="rc-ps ${ap != null ? 'active' : ''}">(portion size <select class="ps-sel" data-pssel="${id}" title="Show a pinned scaling's portion here. Your weights are not changed">
        <option value="">${used} (as used in ${NL.esc(A(p.pid).name)})</option>
        ${pins0.map(q => `<option value="${q.id}" ${apObj && q.id === apObj.id ? 'selected' : ''}>${NL.ws(pinPortion(q, c, baseTotal(a)), 2)} · ${label(q)}</option>`).join('')}
      </select>)</span>`;
    };
    const kicker = isRoot ? 'Final assembly · per portion'
      : parents.length ? 'Sub-assembly · used in ' + parents.map(p => `<a data-goto="${p.pid}">${NL.esc(A(p.pid).name)}</a> ${psLabel(p)}`).join(', ')
        : 'Sub-assembly · not used yet. ' + (view === 'sheet' ? 'Link it with ↳ Link to assembly' : 'Drag the ● on the left onto an assembly to link it');
    const bset = baseSet(a), baseAmt = baseTotal(a), bname = baseLabel(a, bset), sc = scaleOf(a, c, parents, isRoot);
    // pinned scalings keep their target and recalculate from the current weights
    const pins = a.scalePins || [], pinF = p => pinFactor(p, c, baseAmt);
    // the pinned column in use: its portion weight is what the parent assembly takes (shown as "portion size" on top)
    const activeK = isRoot ? -1 : pins.findIndex(p => p.id && p.id === a.activePin);
    const pcls = k => ' pinned' + (k === activeK ? ' active' : '');
    // Building shows the recipe plus only the column in use; Scaling shows the live scaled column and every pinned column
    const scaling = a.face === 'scale' && c.batch > 0, flip = scaling && scaleStyle === 'flip', showSc = scaling;
    const vp = scaling ? pins.map((p, k) => ({ p, k })) : activeK >= 0 ? [{ p: pins[activeK], k: activeK }] : [];
    // Final card, Scaling side: one portion rebuilt with each sub-assembly's portion in use (the Final's own weights never change)
    const subUse = isRoot && scaling ? a.items.map(it => {
      const sid = subIdOf(it.ref), s = sid && A(sid), q = s && activePin(s);
      if (!q) return null;
      const g = pinPortion(q, calc[sid], baseTotal(s));
      return Math.abs(g - (+it.amount || 0)) < 0.005 ? null : { sid, g, on: !!a.pulled?.[sid] };
    }) : [];
    const subG = idx => subUse[idx]?.on ? subUse[idx].g : +a.items[idx].amount || 0;
    const showSub = subUse.some(u => u?.on);
    const flows = !isRoot && scaling ? finFlows.filter(fl => fl.need[id] > 0) : [];
    const ncol = 6 + (showSc ? 1 : 0) + (showSub ? 1 : 0) + flows.length + vp.length, RO = scaling ? 'readonly tabindex="-1" ' : ''; // the Scaling side never edits the recipe
    // cost of the batch at each scaling (portion scalings also show cost per portion)
    const star = cc.missing ? '*' : '';
    const costCellFor = (f, p, k) => `<td class="r scl${p ? pcls(k) : ''}">${NL.money(costAll * f)}${allStar}${(p || sc).mode === 'portion' ? `<div class="scl-pp">${NL.money(costAll * f / ((p || sc).count || 1))} / portion</div>` : ''}</td>`;
    // packaging rows sit in the ingredient table above Total, so the Total cost includes them
    const pk = a.packaging || [], pkW = pk.reduce((t, r) => t + (+r.weight || 0), 0), pkTotal = pk.reduce((t, r) => t + (+r.cost || 0), 0), pkMissing = pk.filter(r => r.cost == null).length;
    const lb = a.labor || [], lbTotal = laborOf(a), lbMissing = lb.filter(r => laborCost(r) == null).length;
    const allMissing = cc.missing + pkMissing + lbMissing, allStar = allMissing ? '*' : '', costAll = cc.batch + pkTotal + lbTotal;
    const costTip = pk.length || lb.length ? `Ingredients ${NL.money(cc.batch)}${pk.length ? ` + packaging ${NL.money(pkTotal)}` : ''}${lb.length ? ` + labor ${NL.money(lbTotal)}` : ''}${allMissing ? `. ${allMissing} item(s) have no price yet` : ''}` : (cc.missing ? `${cc.missing} ingredient(s) have no price yet` : '');
    // each scaled column shows weights (g) or costs ($); the live column keeps its choice on the card, pinned ones on the pin
    const showCost = k => !!(String(k).startsWith('fin-') ? a.finShowCost?.[k] : k === 'sub' ? a.subShowCost : k < 0 ? a.scaleShowCost : pins[k]?.showCost);
    const scCols = [...(showSc ? [{ f: sc.f, k: -1, cls: '' }] : []), ...(showSub ? [{ f: 1, k: 'sub', cls: ' fromsub' }] : []), ...flows.map(fl => ({ f: fl.need[id] / c.yielded, k: fl.key, cls: ' fromfinal' })), ...vp.map(({ p, k }) => ({ f: pinF(p), k, cls: pcls(k) }))];
    const money1 = (usd, f) => usd == null ? '<span class="faint">—</span>' : NL.money(usd.v * f) + (usd.miss ? '*' : '');
    // alt = { html, usd }: what the Sub portions column shows for this row (otherwise the row as typed)
    const scCells = (wt, usd, alt) => scCols.map(({ f, k, cls }) => `<td class="r scl${cls}">${k === 'sub' && alt ? (showCost(k) ? money1(alt.usd, 1) : alt.html) : showCost(k) ? money1(usd, f) : wt(f)}</td>`).join('');
    const scTog = k => `<span class="scl-tog" title="Show weights or costs in this column"><button class="${showCost(k) ? '' : 'on'}" data-sclshow="${id}:${k}:g">${NL.unitLabel()}</button><button class="${showCost(k) ? 'on' : ''}" data-sclshow="${id}:${k}:$">$</button></span>`;
    const pkW1 = (r, f) => r.weight != null ? `${NL.wu(r.weight * f)}` : '';
    const pkScaled = r => scCells(f => pkW1(r, f), r.cost != null ? { v: +r.cost } : null);
    const gross = (food, f = 1) => pkW > 0 ? `<div class="pk-gross" title="Food ${NL.ws(food * f, 2)} + packaging ${NL.ws(pkW * f, 2)}">gross ${NL.ws((food + pkW) * f, 2)}</div>` : '';
    const pkRows = pk.length ? `<tr class="pk-head"><td colspan="${ncol}">Packaging</td></tr>` + pk.map((r, k) => `<tr class="pk-row">
        <td><span class="pk-cell"><button class="rc-del rc-del-l" data-pkdel="${id}:${k}" title="Remove this packaging">×</button><input ${RO}class="pk-name" data-pkn="${id}:${k}" data-fk="pkn-${id}-${k}" value="${NL.esc(r.name || '')}" placeholder="e.g. Pouch"><button class="pk-more" data-pkedit="${id}:${k}" title="Edit name, cost and dimensions${r.l || r.w || r.h ? ` (${[r.l, r.w, r.h].map(v => v ?? '–').join(' × ')} ${r.unit || 'mm'})` : ''}">⋯</button></span></td>
        <td class="r w"><input ${RO}class="num" inputmode="decimal" data-pkd="${id}:${k}:weight" data-fk="pkw-${id}-${k}" ${wf(`pkw-${id}-${k}`, r.weight).a} value="${wf(`pkw-${id}-${k}`, r.weight).v}" placeholder="—" title="Weight of this packaging per unit (kept out of the food weight)"><span class="u">${wf(`pkw-${id}-${k}`, r.weight).u}</span></td><td class="pc"></td><td class="bk"></td>
        <td class="r cost pk-cost">$<input ${RO}class="num" inputmode="decimal" data-pkc="${id}:${k}" data-fk="pkc-${id}-${k}" value="${r.cost ?? ''}" placeholder="0.00"></td>
        ${pkScaled(r)}<td class="x"></td></tr>`).join('') : '';
    const lbMin = (r, f) => r.minutes != null ? `${NL.fmt(r.minutes * f, 0)}<span class="u">min</span>` : '';
    const lbScaled = r => scCells(f => lbMin(r, f), laborCost(r) == null ? null : { v: laborCost(r) });
    const lbRows = lb.length ? `<tr class="pk-head lab-head"><td colspan="${ncol}">Labor <small>approximate</small></td></tr>` + lb.map((r, k) => `<tr class="pk-row lab-row">
        <td><span class="pk-cell"><button class="rc-del rc-del-l" data-lbdel="${id}:${k}" title="Remove this task">×</button><input ${RO}class="pk-name" data-lbf="${id}:${k}:name" data-fk="lbn-${id}-${k}" value="${NL.esc(r.name || '')}" placeholder="e.g. Prep"><button class="pk-more" data-lbedit="${id}:${k}" title="Edit this task">⋯</button></span></td>
        <td class="r w"><input ${RO}class="num" inputmode="decimal" data-lbf="${id}:${k}:minutes" data-fk="lbm-${id}-${k}" value="${r.minutes ?? ''}" placeholder="—" title="Minutes"><span class="u">min</span></td>
        <td class="r lab-ppl pc">×<input ${RO}class="num" inputmode="decimal" data-lbf="${id}:${k}:people" data-fk="lbp-${id}-${k}" value="${r.people ?? 1}" title="People"></td>
        <td class="r lab-rate bk">$<input ${RO}class="num" inputmode="decimal" data-lbf="${id}:${k}:rate" data-fk="lbr-${id}-${k}" value="${r.rate ?? ''}" placeholder="—" title="Rate per hour"><span class="u">/h</span></td>
        <td class="r cost" title="${r.minutes ?? '?'} min × ${r.people ?? 1} × ${r.rate != null ? NL.money(r.rate) : '?'}/h">${laborCost(r) == null ? '—' : NL.money(laborCost(r))}</td>
        ${lbScaled(r)}<td class="x"></td></tr>`).join('') : '';
    const costRow = () => `<tr class="rc-costrow" ${cc.missing ? `title="${cc.missing} ingredient(s) have no price yet, so these are minimums"` : ''}><td>Cost</td><td class="r w" ${costTip ? `title="${costTip}"` : ''}>${NL.money(costAll)}${allStar}</td><td class="pc"></td><td class="bk"></td><td class="cost"></td>${showSc ? costCellFor(sc.f) : ''}${showSub ? `<td class="r scl fromsub">${NL.money(subAll)}${allStar}<div class="scl-pp">${NL.money(Math.abs(subAll - costAll))} ${subAll >= costAll ? 'more' : 'less'} / portion</div></td>` : ''}${flows.map(fl => `<td class="r scl fromfinal">${NL.money(costAll * fl.need[id] / c.yielded)}${allStar}${fl.p.mode === 'portion' ? `<div class="scl-pp">${NL.money(costAll * fl.need[id] / c.yielded / (fl.p.count || 1))} / final portion</div>` : ''}</td>`).join('')}${vp.map(({ p, k }) => costCellFor(pinF(p), p, k)).join('')}<td></td></tr>`;
    const scCell = (g, usd, alt) => scCells(f => `${NL.wu(g * f)}`, usd, alt);
    const subCost = idx => { const it = a.items[idx], sid = subIdOf(it.ref), k = sid ? cost[sid] : null;
      if (!sid) return rowCost(it); return k ? { v: subG(idx) * k.perG, miss: !!k.missing } : null; };
    const subAlt = idx => ({ html: `<b class="sub-g">${NL.wu(subG(idx), '</b>')}`, usd: subCost(idx) });
    // totals for the Sub portions column
    const subFood = a.items.reduce((t, _, idx) => t + subG(idx), 0);
    const subAll = a.items.reduce((t, _, idx) => t + (subCost(idx)?.v || 0), 0) + pkTotal + lbTotal;
    // the Pull button on a sub-assembly row whose card has a different portion in use (Final card, Scaling side)
    const subNote = idx => { const u = subUse[idx]; if (!u) return '';
      const g = `${NL.ws(u.g, 2)}`;
      return `<div><button class="sub-pull ${u.on ? 'on' : ''}" data-subpull="${id}:${u.sid}" title="${u.on ? 'Pulled into the Sub portions column. Click to remove' : 'Use the portion in use on its card in the Sub portions column. Your weight here is not changed'}">${u.on ? '✓ Pulled ' + g : 'Pull ' + g}</button></div>`; };
    const rows = a.items.map((it, idx) => {
      const sid = subIdOf(it.ref);
      const inBase = bset.includes(idx), bpct = baseAmt > 0 ? +((+it.amount || 0) / baseAmt * 100).toFixed(2) : null;
      const bbtn = `<button class="bk-b ${inBase ? 'on' : ''}" data-togbase="${id}:${idx}" title="${inBase ? 'Part of the base. Click to remove it from the base' : 'Click to add this ingredient to the base (100%)'}">B</button>`;
      const bk = inBase
        ? `<td class="r bk base"><span class="bk-base" title="Share of the base (${NL.esc(bname)})">${bpct == null ? '—' : NL.fmt(bpct, 2) + '%'}</span>${bbtn}</td>`
        : `<td class="r bk"><span class="bk-in"><input ${RO}class="num" inputmode="decimal" data-fk="bk-${id}-${idx}" data-bk="${id}:${idx}" value="${bpct ?? ''}" ${baseAmt > 0 ? 'title="Baker %: type a % to set this weight from the base"' : `disabled placeholder="—" title="${bset.length ? 'The base has no weight yet' : 'Press B on an ingredient to choose the base'}"`}>%</span>${bbtn}</td>`;
      const pct = `<td class="r pc">${NL.pct(+it.amount || 0, c.batch)}</td>${bk}${costCell(it, scaling)}${scCell(+it.amount || 0, rowCost(it), subUse[idx]?.on ? subAlt(idx) : null)}`;
      const aerr = amtErr[`${id}:${idx}`];
      const amt = `<td class="r w"><input ${RO}class="num ${aerr ? 'bad' : ''}" inputmode="decimal" data-fk="amt-${id}-${idx}" data-amt="${id}:${idx}" ${wf(`amt-${id}-${idx}`, it.amount).a} value="${wf(`amt-${id}-${idx}`, it.amount).v}" ${aerr ? `title="${NL.esc(aerr)}"` : ''}><span class="u">${wf(`amt-${id}-${idx}`, it.amount).u}</span></td>`;
      const delL = `<button class="rc-del rc-del-l" data-delrow="${id}:${idx}" title="Remove this row">×</button>`, del = '<td class="x"></td>';
      if (sid && A(sid)) {
        return `<tr class="sub" data-sub="${sid}" style="--rc:${colorOf(sid)}"><td>${delL}<span class="rc-sublink" data-goto="${sid}">${NL.esc(A(sid).name)}</span><span class="rc-see" data-goto="${sid}">see assembly ${view === 'sheet' ? (orderIdx[sid] > orderIdx[id] ? '↓' : '↑') : '→'}</span>${(h => h.length ? `<span class="ban-tag soft" title="Contains ${NL.esc(h.map(x => `${x.name} (${x.shops.join(', ')})`).join('; '))}">⛔ contains ${h.length} not allowed</span>` : '')(banHits(sid))}${subNote(idx)}</td>${amt}${pct}${del}</tr>`;
      }
      const ing = NL.ingMap[it.ref.slice(4)];
      return `<tr${bansFor(ing).length ? ' class="banned"' : ''}><td>${delL}${NL.esc(ing?.name || it.ref)}<span class="rc-vendor">${NL.esc(ing?.vendor || '')}</span>${banTag(bansFor(ing))}</td>${amt}${pct}${del}</tr>`;
    }).join('') || `<tr class="rc-empty"><td colspan="${ncol}">No ingredients yet — use the buttons below or drag from the library</td></tr>`;
    const kcal = Math.round(c.perG[0] * (isRoot ? c.yielded : 100));
    const extra = scaling && !flip ? Math.max(0, pins.length - 2) : 0;
    return `<div class="rcard ${isRoot ? 'final' : ''} ${a.collapsed ? 'rc-collapsed' : ''} ${!isRoot && !parents.length ? 'orphan' : ''} ${scaling ? 'face-scale' : 'face-build'} ${flip ? 'flipface' : ''} ${flipIn[id] ? 'flip-in' : ''}" data-id="${id}" style="${view === 'sheet' ? `--depth:${depthMap[id] || 0};` : `left:${a.x}px;top:${a.y}px;z-index:${zOf(id)};`}--c:${colorOf(id)};--extra:${extra}">
      ${isRoot ? '' : `<span class="port" data-port="${id}" title="Drag onto the assembly that uses this card"></span>`}
      <div class="rc-top" data-drag>
        <div class="rc-kick-row"><div class="rc-kicker">${kicker}</div>${kind}</div>
        <div class="rc-titlebar">
          <span class="sv-grip" data-grip="${id}" title="Drag to move this card up or down">⠿</span>
          <input class="rc-title" data-fk="title-${id}" data-title="${id}" value="${NL.esc(a.name)}">
          ${(v => v ? `<button class="rc-var on" data-var="${id}" title="Variations of this card: ${a.vars.list.length}. In use: ${NL.esc(v.name)}. Click to switch, compare or add one">${NL.esc(v.name)} <span class="rc-var-n">${a.vars.list.length}</span> ▾</button>` : `<button class="rc-var" data-var="${id}" title="Variations: try a change on this card (less salt, another miso…) without losing what you have">Variations</button>`)(varsOf(a) && varInUse(a))}
          <button class="rc-ib sv-only" data-move="${id}:-1" title="Move card up">↑</button><button class="rc-ib sv-only" data-move="${id}:1" title="Move card down">↓</button>
          <span class="rc-face"><button class="${scaling ? '' : 'on'}" data-face="${id}:build" title="Build the recipe: weights, %, packaging, labor, procedure">Building</button><button class="${scaling ? 'on' : ''}" data-face="${id}:scale" ${c.batch > 0 ? `title="${scaleStyle === 'flip' ? 'Flip to the scaling side' : 'Show scaling, hide building columns'}: scaled and pinned columns with cost"` : 'disabled title="Add ingredient weights first"'}>Scaling</button></span>
          <button class="rc-ib" data-collapse="${id}" title="${a.collapsed ? 'Expand' : 'Collapse'}">${a.collapsed ? '▸' : '▾'}</button>
          <button class="rc-ib fav ${favOf(id) ? 'on' : ''}" data-fav="${id}" title="${favOf(id) ? 'In your favorites. Click to update or remove' : 'Save this card to favorites'}">${favOf(id) ? '★' : '☆'}</button>
          <button class="rc-ib" data-copycard="${id}" title="Copy this card${descendants(id).size ? ' (with its sub-assembly cards)' : ''}. Paste into any tab with 📋 Paste card or Ctrl+V">⧉</button>
          <button class="rc-ib del" data-delcard="${id}" title="Delete this card">🗑</button>
        </div>
        ${varsOf(a) && varInUse(a).note ? `<div class="rc-varnote" data-var="${id}" title="Note on the variation in use. Click to see all variations"><b>${NL.esc(varInUse(a).name)}</b> · ${NL.esc(varInUse(a).note)}</div>` : ''}
        ${(h => h.length ? `<div class="rc-ban" title="Retailers are set in the side panel">⛔ Not allowed by a retailer: ${h.map(x => `<b>${NL.esc(x.name)}</b> <span>(${NL.esc(x.shops.join(', '))})</span>`).join(', ')}</div>` : '')(banHits(id))}
        <div class="rc-stats">
          <div><b>${NL.ws(c.batch, 1)}</b><span>${isRoot ? 'Portion' : 'Batch'}</span></div>
          ${isRoot ? (n => `<div class="rc-count" title="Sub-assemblies in this final assembly"><b>${n}</b><span>Sub-assembl${n === 1 ? 'y' : 'ies'}</span></div>`)(a.items.filter(it => subIdOf(it.ref)).length) : ''}
          <div><b>${NL.ws(c.yielded, 1)}</b><span>Yield</span></div>
          <div><b>${NL.fmt(+a.yieldLoss || 0, 1)}% / ${NL.fmt(NL.yieldPct(a.yieldLoss), 1)}%</b><span>Loss / Yield</span></div>
          <div><b>${kcal}</b><span>${isRoot ? 'kcal / portion' : 'kcal / 100 g'}</span></div>
          <div class="rc-cost" ${cc.missing ? `title="${cc.missing} ingredient(s) have no price yet, so this is a minimum"` : `title="Cost from ingredient prices per ${NL.pUnit()}"`}><b>${isRoot ? NL.money(cc.batch + (a.packaging || []).reduce((t, r) => t + (+r.cost || 0), 0) + laborOf(a)) : NL.money(NL.pOut(cc.perG * 1000))}${cc.missing ? '*' : ''}</b><span>${isRoot ? 'cost / portion' : 'cost / ' + NL.pUnit()}</span></div>
        </div>
      </div>
      <div class="rc-body">
        <table class="rc-tbl"><thead><tr><th>Ingredient</th><th class="r hc-w">Weight</th><th class="r hc-pc">Relative %</th><th class="r hc-bk" title="Baker's percentage: weight relative to the base ingredient (100%)">Baker %</th><th class="r hc-cost" title="Cost of this row: price per kg × weight">Cost</th>${showSc ? `<th class="r scl" title="Weights for the target below; your Weight column is not changed">Scaled<div class="scl-ctl">${scTog(-1)}</div></th>` : ''}${showSub ? `<th class="r scl fromsub" title="One portion of this assembly using each sub-assembly's portion in use (chosen on each sub-assembly card). Your weights here are not changed">Sub portions<div class="scl-ctl">${scTog('sub')}</div></th>` : ''}${flows.map(fl => `<th class="r scl fromfinal" title="Scaled from the Final assembly (${NL.esc(A(S.root).name)}): its column ${pinLabel(fl.p)} needs ${NL.ws(fl.need[id])} of this card. Change it on the Final card">From Final<div class="fin-l">${pinLabel(fl.p)}</div><div class="scl-ctl">${scTog(fl.key)}</div></th>`).join('')}${vp.map(({ p, k }) => `<th class="r scl${pcls(k)}" title="Pinned: ${p.mode === 'portion' ? 'scale by portion' : 'scale by yield'}">${p.mode === 'portion' ? `${NL.ws(p.size, 1)} × ${NL.fmt(p.count, 2)}` : p.mode === 'base' ? `Base ${NL.ws(p.target, 1)}` : `Yield ${NL.ws(p.target, 1)}`}<button class="scl-unpin" data-sclunpin="${id}:${k}" title="Remove this column">×</button><div class="scl-ctl">${scTog(k)}</div></th>`).join('')}<th></th></tr></thead><tbody>${rows}${pkRows}${lbRows}</tbody>
          ${a.items.length ? `<tfoot>${bset.length > 1 || a.baseName ? `<tr class="rc-base"><td><span class="rc-base-nm" data-basename="${id}" title="Click to rename the base">${NL.esc(bname)}${a.baseName ? ' <small>(Base)</small>' : ''}</span></td><td class="r w">${NL.wu(baseAmt)}</td><td class="r pc">${NL.pct(baseAmt, c.batch)}</td><td class="r bk">100%</td><td class="r cost"></td>${scCell(baseAmt)}<td class="x"><button class="rc-del rc-base-x" data-delbase="${id}" title="Remove this base (clears its name and B marks)">×</button></td></tr>` : ''}<tr class="rc-tot"><td>Total</td><td class="r w">${NL.wu(c.batch)}${gross(c.batch)}</td><td class="r pc">100%</td><td class="r bk" title="Total formula percentage">${baseAmt > 0 ? NL.fmt(c.batch / baseAmt * 100, 1) + '%' : `<span class="bk-hint">${bset.length ? 'base has no weight' : 'press B to pick a base'}</span>`}</td><td class="r cost" ${costTip ? `title="${costTip}"` : ''}>${NL.money(costAll)}${allStar}</td>${scCells(f => `${NL.wu(c.batch * f)}${gross(c.batch, f)}`, { v: costAll, miss: allMissing > 0 }, { html: `${NL.wu(subFood)}${gross(subFood)}`, usd: { v: subAll, miss: allMissing > 0 } })}<td></td></tr>${showSc || vp.length ? costRow() : ''}</tfoot>` : ''}</table>
        <div class="rc-sec rc-fw bo ${fwErr[id] ? 'bad' : ''}">
          <label>${isRoot ? 'Final portion weight' : 'Final weight after cooking'} <input class="num" inputmode="decimal" data-fk="fw-${id}" data-fw="${id}" ${wf(`fw-${id}`, c.yielded, 1).a} value="${wf(`fw-${id}`, c.yielded, 1).v}" placeholder="${NL.inUnit(c.batch, wf(`fw-${id}`, c.yielded).u, 1)}"> ${wf(`fw-${id}`, c.yielded).u}</label>
          <span class="rc-fw-res">from ${NL.ws(c.batch, 1)} · <b>Yield ${NL.fmt(NL.yieldPct(a.yieldLoss), 1)}%</b> · Loss ${NL.fmt(+a.yieldLoss || 0, 1)}% (${NL.ws(c.lossG, 1)})</span>
          ${fwErr[id] ? `<div class="rc-fw-err">⚠ ${NL.esc(fwErr[id])}</div>` : ''}
        </div>
        <div class="rc-add bo">
          <button data-addi="${id}">+ Ingredient</button>
          <button data-basename="${id}" title="${a.baseName ? 'Rename the base group' : 'Name the base group (e.g. Total Flour), then press B on each ingredient that belongs to it'}">${a.baseName ? '✎ Rename base group' : '+ Base group'}</button>
          <button class="s" data-adds="${id}">＋ New sub-assembly</button>
          <button class="s" data-addl="${id}">↳ Link to assembly</button>
          <button class="pk" data-pkadd="${id}" title="Add a packaging item (pouch, film, box…) with its cost">+ Packaging</button>
          <button class="lb" data-lbadd="${id}" title="Add an approximate labor cost (task time × people × hourly rate)">+ Labor</button>
        </div>
        ${isRoot && !a.items.length ? `<div class="rc-sec guide bo"><b>Building from scratch</b><ol>
          <li>Name your assembly in the title above.</li>
          <li>Add raw ingredients with <b>+ Ingredient</b>, or drag them from the library onto this card.</li>
          <li>Need a component (a sauce, a broth)? Click <b>＋ New sub-assembly</b>. It opens its own linked card where you add its ingredients.</li>
          <li>Type the weight on each row. Batch, yield, % and nutrition update as you type.</li></ol></div>` : ''}
        ${c.batch > 0 ? `<div class="rc-sec rc-bscale">${scaleControls(id, a, c, sc)}<span class="scl-addrow"><button class="scl-add" data-sclpin="${id}" ${pins.length >= 4 ? 'disabled title="Up to 4 columns. Remove one with × first"' : pins.some(p => samePin(p, sc)) ? 'disabled title="These numbers are already a column. Change them above to add another"' : 'title="Add these numbers as a column, to compare with others"'}>${pins.length < 4 && pins.some(p => samePin(p, sc)) ? '✓ Already a column' : '+ Add as column'}</button><span class="faint">${pins.length} of 4 columns</span><span class="faint scl-note">${flip ? 'scaling side · read-only · press Building to edit' : 'reads your weights · never changes them'}</span></span></div>` : ''}
        <div class="bo">${nutSection(id, a, c, isRoot)}</div>
        <div class="rc-sec bo">
          <div class="rc-h">Procedure <button class="rc-mini" data-addstep="${id}">+ Step</button></div>
          <ol class="rc-steps">${(a.steps || []).map((s, i) => `<li><input data-fk="st-${id}-${i}" data-step="${id}:${i}" value="${NL.esc(s)}" placeholder="Describe this step…"><button class="rc-del" data-delstep="${id}:${i}">×</button></li>`).join('')}</ol>
        </div>
        <div class="rc-sec bo">
          <div class="rc-h">Notes · heating · tasting</div>
          <textarea class="rc-notes" data-fk="nt-${id}" data-notes="${id}" placeholder="Add notes…">${NL.esc(a.notes || '')}</textarea>
        </div>
      </div>
    </div>`;
  }

  // Nutrition for any card: a one-line summary per 100 g, or the full label when opened.
  // Cost of one row: ingredients use their price per kg (click to change it); sub-assemblies use their card's cost per gram.
  // cost of one row as a number (null when there is no price), for the scaled columns
  function rowCost(it) {
    const sid = subIdOf(it.ref), amt = +it.amount || 0;
    if (sid) { const k = cost[sid]; return k ? { v: amt * k.perG, miss: !!k.missing } : null; }
    const p = NL.price(it.ref.slice(4));
    return p == null ? null : { v: amt / 1000 * p };
  }
  function costCell(it, locked = false) {
    const sid = subIdOf(it.ref), amt = +it.amount || 0;
    if (sid) { const k = cost[sid]; return `<td class="r cost" title="${k ? NL.money(NL.pOut(k.perG * 1000)) + ` per ${NL.pUnit()}, from its card` : ''}">${k ? NL.money(amt * k.perG) + (k.missing ? '*' : '') : '—'}</td>`; }
    const iid = it.ref.slice(4), p = NL.price(iid), name = NL.esc(NL.ingMap[iid]?.name || iid);
    const tip = p == null ? `No price yet for ${name}. Click to add a price per ${NL.pUnit()}` : `${NL.money(NL.pOut(p))} per ${NL.pUnit()}${NL.isSamplePrice(iid) ? ' (sample price)' : ''}. Click to change`;
    if (locked) return `<td class="r cost" title="${p == null ? `No price yet for ${name}` : `${NL.money(NL.pOut(p))} per ${NL.pUnit()}`}. Prices are set on the Building side">${p == null ? '—' : NL.money(amt / 1000 * p)}</td>`;
    return `<td class="r cost"><button class="cost-b ${p == null ? 'none' : NL.isSamplePrice(iid) ? 'sample' : ''}" data-price="${iid}" title="${tip}">${p == null ? 'add $' : NL.money(amt / 1000 * p)}</button></td>`;
  }

  // Sub-assembly scaling: by finished yield, or by portion size × number of portions (default portion = amount used in the parent)
  // Scaling is a read-only planning view: it reads the card's weights and fills the scaled columns. It never changes a weight.
  function scaleOf(a, c, parents, isRoot = false) {
    const baseAmt = baseTotal(a), hasBase = baseAmt > 0;
    // the final assembly scales by portion or base only (no scale by yield)
    const mode = a.scaleMode === 'base' && hasBase ? 'base' : a.scaleMode === 'portion' || isRoot ? 'portion' : 'yield';
    const size = a.portionSize ?? (+parents[0]?.amount || +c.yielded.toFixed(2) || 100), count = a.portionCount ?? 1;
    const target = mode === 'portion' ? size * count : mode === 'base' ? (a.baseTarget ?? baseAmt) : (a.scaleTarget ?? c.yielded);
    const f = mode === 'base' ? target / baseAmt : c.yielded > 0 ? target / c.yielded : 1;
    return { mode, size, count, target, f, hasBase, baseAmt };
  }
  const samePin = (p, sc) => p.mode === sc.mode && (sc.mode === 'portion' ? Math.abs(p.size - sc.size) < 0.005 && Math.abs(p.count - sc.count) < 0.005 : Math.abs(p.target - sc.target) < 0.005);
  const pinFactor = (p, c, baseAmt) => p.mode === 'base' ? (baseAmt > 0 ? p.target / baseAmt : 1) : c.yielded > 0 ? p.target / c.yielded : 1;
  // the weight of one portion for a pinned scaling (shown as "portion size" when that column is the active scaling)
  const pinPortion = (p, c, baseAmt) => p.mode === 'portion' ? +p.size : c.yielded * pinFactor(p, c, baseAmt);
  const activePin = a => (a.scalePins || []).find(p => p.id && p.id === a.activePin);
  function scaleControls(id, a, c, sc) {
    const btn = (m, label, ok = true) => `<button class="${sc.mode === m ? 'on' : ''}" data-sclmode="${id}:${m}" ${ok ? '' : 'disabled title="Press B on an ingredient to choose a base first"'}>${label}</button>`;
    const seg = `<span class="scl-seg">${id === S.root ? '' : btn('yield', 'Scale by yield')}${btn('portion', 'Scale by portion')}${btn('base', 'Scale by base', sc.hasBase)}</span>`;
    const inputs = sc.mode === 'yield'
      ? `<input class="num" inputmode="decimal" data-fk="sct-${id}" data-sct="${id}" ${wf(`sct-${id}`, sc.target).a} value="${wf(`sct-${id}`, sc.target, 2).v}" title="Finished weight you want after cooking loss"> ${wf(`sct-${id}`, sc.target).u} yield`
      : sc.mode === 'portion'
        ? `<input class="num" inputmode="decimal" data-fk="psz-${id}" data-psz="${id}" ${wf(`psz-${id}`, +sc.size).a} value="${wf(`psz-${id}`, +sc.size, 2).v}" title="Finished weight of one portion"> ${wf(`psz-${id}`, +sc.size).u} × <input class="num scl-n" inputmode="decimal" data-fk="pcn-${id}" data-pcn="${id}" value="${+(+sc.count).toFixed(2)}" title="Number of portions"> portion${sc.count === 1 ? '' : 's'}`
        : `<input class="num" inputmode="decimal" data-fk="sbt-${id}" data-sbt="${id}" ${wf(`sbt-${id}`, sc.target).a} value="${wf(`sbt-${id}`, sc.target, 2).v}" title="Base weight you want; every Baker % is kept"> ${wf(`sbt-${id}`, sc.target).u} of ${NL.esc(baseLabel(a))}`;
    const same = Math.abs(sc.f - 1) < 0.0005;
    return `<span class="rc-sc scl-row">${seg} ${inputs}
      <span class="faint">→ batch ${NL.ws(c.batch * sc.f, 2)}${same ? '' : ` (×${NL.fmt(sc.f, 3)})`}</span></span>`;
  }

  // ---------- packaging: any number of rows per card (name, cost, optional dimensions for later calculations) ----------
  const PK_UNITS = ['mm', 'cm', 'in'];
  // ---------- labor: approximate cost per task (minutes × people × hourly rate) ----------
  const LB_RATE = 'nlv3_labor_rate';
  const laborCost = r => r.minutes != null && r.rate != null ? r.minutes / 60 * (r.people ?? 1) * r.rate : null;
  const laborOf = a => (a.labor || []).reduce((t, r) => t + (laborCost(r) || 0), 0);
  function laborForm(cur = null) {
    return new Promise(resolve => {
      let lastRate = ''; try { lastRate = localStorage.getItem(LB_RATE) || ''; } catch { }
      const ov = document.createElement('div'); ov.className = 'nl-prompt-ov';
      ov.innerHTML = `<form class="nl-prompt nif">
        <div class="nl-prompt-label">${cur ? 'Edit labor' : 'Add labor'}</div>
        <label class="nif-f"><span>Task</span><input name="name" required placeholder="e.g. Prep, cooking, packing"></label>
        <div class="nif-grid lab-form">
          <label class="nif-n"><span>Time (minutes)</span><input name="minutes" inputmode="decimal" placeholder="e.g. 30"></label>
          <label class="nif-n"><span>People</span><input name="people" inputmode="decimal" value="1"></label>
          <label class="nif-n"><span>Rate ($ per hour)</span><input name="rate" inputmode="decimal" value="${lastRate}" placeholder="e.g. 18"></label>
        </div>
        <div class="pk-form-err" hidden></div>
        <div class="nl-prompt-btns"><button type="submit" class="btn primary">${cur ? 'Save' : 'Add labor'}</button><button type="button" class="btn ghost nl-prompt-cancel">Cancel</button></div>
      </form>`;
      document.body.appendChild(ov);
      const f = ov.querySelector('form'), err = ov.querySelector('.pk-form-err');
      if (cur) for (const k of ['name', 'minutes', 'people', 'rate']) if (cur[k] != null) f.elements[k].value = cur[k];
      f.elements.name.focus();
      const done = v => { ov.remove(); resolve(v); };
      const num = (field, label) => { const t = f.elements[field].value.trim(); if (!t) return null; const v = NL.parseNum(t); if (!isFinite(v) || v < 0) throw [label, field]; return v; };
      f.onsubmit = e => {
        e.preventDefault();
        const name = f.elements.name.value.trim(); if (!name) return f.elements.name.focus();
        try {
          const r = { id: cur?.id || NL.uid('l'), name, minutes: num('minutes', 'Time'), people: num('people', 'People') ?? 1, rate: num('rate', 'Rate') };
          if (r.rate != null) try { localStorage.setItem(LB_RATE, String(r.rate)); } catch { }
          done(r);
        } catch ([label, field]) { err.hidden = false; err.textContent = `${label} must be a number, like 12.5`; f.elements[field].focus(); }
      };
      ov.querySelector('.nl-prompt-cancel').onclick = () => done(null);
      ov.addEventListener('pointerdown', e => { if (e.target === ov) done(null); });
      f.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } });
    });
  }

  function packagingForm(cur = null) {
    return new Promise(resolve => {
      const ov = document.createElement('div'); ov.className = 'nl-prompt-ov';
      ov.innerHTML = `<form class="nl-prompt nif">
        <div class="nl-prompt-label">${cur ? 'Edit packaging' : 'Add packaging'}</div>
        <label class="nif-f"><span>Name</span><input name="name" required placeholder="e.g. Pouch, film, box"></label>
        <label class="nif-f"><span>Weight per unit in g (optional)</span><input name="weight" inputmode="decimal" placeholder="e.g. 4.5"></label>
        <label class="nif-f"><span>Cost per unit in $</span><input name="cost" inputmode="decimal" placeholder="e.g. 0.12"></label>
        <div class="nif-h">Dimensions <small>optional, for later calculations</small></div>
        <div class="nif-grid pk-form-dims">
          <label class="nif-n"><span>Length</span><input name="l" inputmode="decimal"></label>
          <label class="nif-n"><span>Width</span><input name="w" inputmode="decimal"></label>
          <label class="nif-n"><span>Height</span><input name="h" inputmode="decimal"></label>
          <label class="nif-n"><span>Unit</span><select name="unit">${PK_UNITS.map(u => `<option>${u}</option>`).join('')}</select></label>
        </div>
        <div class="pk-form-err" hidden></div>
        <div class="nl-prompt-btns"><button type="submit" class="btn primary">${cur ? 'Save' : 'Add packaging'}</button><button type="button" class="btn ghost nl-prompt-cancel">Cancel</button></div>
      </form>`;
      document.body.appendChild(ov);
      const f = ov.querySelector('form'), err = ov.querySelector('.pk-form-err');
      if (cur) for (const k of ['name', 'weight', 'cost', 'l', 'w', 'h', 'unit']) if (cur[k] != null) f.elements[k].value = cur[k];
      f.elements.name.focus();
      const done = v => { ov.remove(); resolve(v); };
      const num = (field, label) => { const t = f.elements[field].value.trim(); if (!t) return null; const v = NL.parseNum(t); if (!isFinite(v) || v < 0) throw label; return v; };
      f.onsubmit = e => {
        e.preventDefault();
        const name = f.elements.name.value.trim(); if (!name) return f.elements.name.focus();
        try { done({ id: cur?.id || NL.uid('k'), name, weight: num('weight', 'Weight'), cost: num('cost', 'Cost'), l: num('l', 'Length'), w: num('w', 'Width'), h: num('h', 'Height'), unit: f.elements.unit.value }); }
        catch (label) { err.hidden = false; err.textContent = `${label} must be a number, like 12.5`; f.elements[{ Weight: 'weight', Cost: 'cost', Length: 'l', Width: 'w', Height: 'h' }[label]].focus(); }
      };
      ov.querySelector('.nl-prompt-cancel').onclick = () => done(null);
      ov.addEventListener('pointerdown', e => { if (e.target === ov) done(null); });
      f.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } });
    });
  }

  function nutSection(id, a, c, isRoot) {
    if (!(c.yielded > 0)) return `<div class="rc-sec rc-nut"><div class="rc-h">Nutrition Facts</div><div class="faint">Add ingredients with weights to see nutrition.</div></div>`;
    const p = i => c.perG[i] * 100;
    const sum = `${Math.round(p(0))} kcal · Fat ${NL.fmt(p(1), 1)} g · Carbs ${NL.fmt(p(5), 1)} g · Protein ${NL.fmt(p(8), 1)} g · Sodium ${Math.round(p(4))} mg <span class="faint">per 100 g</span>`;
    const basis = a.nutBasis || (isRoot ? 'all' : '100');
    const seg = `<div class="nut-seg"><button class="${basis === 'all' ? 'on' : ''}" data-nutbasis="${id}:all">${isRoot ? 'Per portion' : 'Whole batch'}</button><label class="${basis === '100' ? 'on' : ''}" data-nutbasis="${id}:100" title="Type any serving size in grams">Per <input class="nut-g" inputmode="decimal" data-nutserv="${id}" data-fk="ns-${id}" value="${a.nutServing ?? 100}"> g</label></div>`;
    return `<div class="rc-sec rc-nut ${a.showNut ? 'open' : ''}">
      <div class="rc-h"><button class="rc-nut-tog" data-nuttog="${id}" title="${a.showNut ? 'Hide' : 'Show'} the Nutrition Facts label for this card">${a.showNut ? '▾' : '▸'} Nutrition Facts</button>${a.showNut ? seg : ''}</div>
      ${a.showNut ? `<div class="rc-nut-body">${NL.labelHTML(S, calc, id, basis === '100' ? (a.nutServing ?? 100) : undefined)}</div>` : `<div class="rc-nut-sum" data-nuttog="${id}">${sum}</div>`}
    </div>`;
  }

  function drawLinks() {
    if (view === 'sheet') return drawSheetLinks();
    let out = '';
    for (const [pid, a] of Object.entries(S.asm)) {
      const pEl = cardsEl.querySelector(`[data-id="${pid}"]`); if (!pEl) continue;
      const pr = pEl.getBoundingClientRect(), s = pr.width / pEl.offsetWidth || 1; // actual on-screen scale
      a.items.forEach(it => {
        const sid = subIdOf(it.ref); if (!sid || !A(sid)) return;
        const row = pEl.querySelector(`tr[data-sub="${sid}"]`);
        const rr = row && !a.collapsed ? row.getBoundingClientRect() : null;
        const x1 = a.x + pr.width / s, y1 = a.y + (rr ? (rr.top - pr.top + rr.height / 2) / s : 34);
        const ch = A(sid), x2 = ch.x, y2 = ch.y + 30;
        const dx = Math.max(60, Math.abs(x2 - x1) / 2);
        const back = x2 < x1; // child sits to the left: loop around
        const [c1, c2] = back ? [x1 + 80, x2 - 80] : [x1 + dx, x2 - dx];
        const d = `M${x1},${y1} C${c1},${y1} ${c2},${y2} ${x2},${y2}`;
        const mx = (x1 + 3 * c1 + 3 * c2 + x2) / 8, my = (y1 + y2) / 2; // bezier point at t = 0.5
        const col = colorOf(sid);
        out += `<g class="lk" data-link="${pid}:${sid}"><path class="link" d="${d}" stroke="${col}"/><path class="link-hit" d="${d}"/><circle class="link-dot" cx="${x1}" cy="${y1}" r="5" fill="${col}"/><circle class="link-dot" cx="${x2}" cy="${y2}" r="5" fill="${col}"/>
          <g class="lk-cut" data-cut="${pid}:${sid}" transform="translate(${mx},${my})" style="--lc:${col}"><title>Remove link: ${NL.esc(A(sid).name)} → ${NL.esc(a.name)}</title><circle r="13"/><text y="1">✂</text></g></g>`;
      });
    }
    linksEl.innerHTML = out;
  }

  function drawTree() {
    computeBans(); // the tree is the left tab's; the split pane may have painted last
    const seen = new Set();
    // BOM-style tree: `rails` says, for each ancestor level, whether a vertical line continues below this row
    const item = (id, rails = [], last = true, depth = 0) => {
      const a = A(id); seen.add(id);
      const nIng = a.items.filter(it => it.ref.startsWith('ing:')).length;
      const kids = a.items.map(it => subIdOf(it.ref)).filter(s => s && A(s));
      const guide = depth ? `<span class="tg">${rails.map(r => `<i class="${r ? 'v' : ''}"></i>`).join('')}<i class="${last ? 'l' : 't'}"></i></span>` : '';
      return `<div class="tr-item ${id === S.root ? 'root' : ''}" data-goto="${id}">${guide}
        <span class="sw" style="background:${colorOf(id)}"></span><span class="nm">${NL.esc(a.name)}</span>${banHits(id).length ? '<span class="tr-ban" title="Has ingredients a retailer does not allow">⛔</span>' : ''}<span class="faint">${nIng} ing</span></div>` +
        (depth < 12 ? kids.map((k, i) => item(k, depth ? [...rails, !last] : [], i === kids.length - 1, depth + 1)).join('') : '');
    };
    let html = hasFinal() ? item(S.root, 0) : '', extra = '';
    // unlinked cards: list top-level ones first (their sub-assemblies nest under them), then anything left
    for (const id of Object.keys(S.asm)) if (!seen.has(id) && !parentsOf(id).length) extra += item(id, 0);
    for (const id of Object.keys(S.asm)) if (!seen.has(id)) extra += item(id, 0);
    if (extra) html += `<div class="tr-sep">${hasFinal() ? 'Not used in the assembly' : 'No final card yet. Use the Final toggle on a card'}</div>` + extra;
    if (!html) html = '<div class="tr-sep">No cards yet</div>';
    $('#tree').innerHTML = html;
  }
  function drawNut() {
    const nut = $('#nut');
    if (!$('#cmain').classList.contains('show-nut')) { nut.innerHTML = ''; return; }
    // every card's label, in assembly order; each uses the serving basis chosen on its card
    const ids = sheetOrder();
    nut.innerHTML = ids.length ? ids.map(id => {
      const a = A(id), c = calc[id], isRoot = id === S.root, basis = a.nutBasis || (isRoot ? 'all' : '100');
      const per = basis === '100' ? `per ${NL.fmt(a.nutServing ?? 100, 1)} g` : isRoot ? 'per portion' : 'whole batch';
      return `<div class="nut-card">
        <div class="nut-h" data-goto="${id}" title="Go to this card"><span class="sw" style="background:${colorOf(id)}"></span><b>${NL.esc(a.name)}</b><span class="faint">${isRoot ? 'Final' : 'Sub-assembly'} · ${per}</span></div>
        ${c.yielded > 0 ? NL.labelHTML(S, calc, id, basis === '100' ? (a.nutServing ?? 100) : undefined) : '<div class="nut-empty">No ingredients with weights yet.</div>'}
      </div>`;
    }).join('') : '<div class="nut-empty">Add a card to see nutrition.</div>';
  }
  function drawLib() {
    const q = $('#libSearch').value.trim().toLowerCase();
    $('#lib').innerHTML = NL.CATEGORIES.map(cat => {
      const items = NL.INGREDIENTS.filter(i => i.cat === cat && (!q || i.name.toLowerCase().includes(q)));
      if (!items.length) return '';
      return `<div class="lib-cat"><i style="background:${NL.CAT_COLORS[cat]}"></i>${cat}</div>` +
        items.map(i => `<div class="lib-item" draggable="true" data-ing="${i.id}"><span>${NL.esc(i.name)}</span><span class="faint">${Math.round(i.n[0])} kcal</span></div>`).join('');
    }).join('');
  }

  // ---------- layout ----------
  function heights() {
    const h = {};
    cardsEl.querySelectorAll('.rcard').forEach(el => { h[el.dataset.id] = el.offsetHeight; });
    return h;
  }
  // real card widths (a card on its Scaling side grows to fit its pinned columns)
  function widths() {
    const w = {};
    cardsEl.querySelectorAll('.rcard').forEach(el => { w[el.dataset.id] = el.offsetWidth || CARDW; });
    return w;
  }
  function arrange() {
    if (view === 'sheet') { S._arrange = true; return render(); } // board layout is done when the board is shown
    render();
    const H = heights(), W = widths(), placed = new Set(), colBottom = [], depth = {};
    const place = (id, d, desired) => {
      if (placed.has(id)) return; placed.add(id);
      const a = A(id);
      depth[id] = d;
      a.y = Math.max(desired, (colBottom[d] ?? -Infinity) + GAPY);
      colBottom[d] = a.y + H[id];
      // rows are ~34px; place each child next to the row that references it
      a.items.forEach((it, idx) => {
        const s = subIdOf(it.ref);
        if (s && A(s)) place(s, d + 1, a.y + 150 + idx * 34 - 30);
      });
    };
    if (hasFinal()) place(S.root, 0, 0);
    else for (const id of Object.keys(S.asm)) if (!parentsOf(id).length) place(id, 0, 0);
    // each column is as wide as its widest card
    const colW = [], colX = [0];
    for (const [id, d] of Object.entries(depth)) colW[d] = Math.max(colW[d] || CARDW, W[id]);
    for (let d = 1; d < colW.length; d++) colX[d] = colX[d - 1] + (colW[d - 1] || CARDW) + GAPX;
    for (const [id, d] of Object.entries(depth)) A(id).x = colX[d] + (id === S.root ? -20 : 0);
    let y = Math.max(0, ...colBottom.filter(v => v != null)) + 80;
    for (const id of Object.keys(S.asm)) if (!placed.has(id)) { A(id).x = (colW[0] || CARDW) + GAPX; A(id).y = y; y += H[id] + GAPY; }
    render();
  }
  function bounds() {
    if (!Object.keys(S.asm).length) return { x: 0, y: 0, w: 900, h: 600 };
    const H = heights(), W = widths(); let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    for (const [id, a] of Object.entries(S.asm)) { x0 = Math.min(x0, a.x); y0 = Math.min(y0, a.y); x1 = Math.max(x1, a.x + (W[id] || CARDW) + 20); y1 = Math.max(y1, a.y + (H[id] || 300)); }
    return { x: x0, y: y0, w: x1 - x0, h: y1 - y0 };
  }
  function goto(id) {
    const a = A(id), el = cardsEl.querySelector(`[data-id="${id}"]`); if (!a || !el) return;
    if (view === 'sheet') el.scrollIntoView({ block: 'start', behavior: 'smooth' });
    else { raise(id); vp.centerOn(a.x + CARDW / 2, a.y + Math.min(el.offsetHeight, 500) / 2, Math.max(vp.v.s, 0.7)); }
    setTimeout(() => { const e2 = cardsEl.querySelector(`[data-id="${id}"]`); e2?.classList.remove('flash'); void e2?.offsetWidth; e2?.classList.add('flash'); }, 150);
  }

  // ---------- sheet view: the same cards stacked top to bottom, in an order the chef sets ----------
  const SHEET_EMPTY = `<div class="empty-hint sv-empty"><b>Blank assembly</b><span>Start with any card: a sub-assembly (a sauce, a broth) or the final dish. Use the <i>Final / Sub-assembly</i> switch on each card. Cards stack top to bottom; drag ⠿ to reorder.</span><button class="btn primary" data-emptyadd>＋ Add card</button></div>`;
  const PREFS = 'nlv3_sheet_prefs';
  const prefs = { links: 'jump', width: 'full' };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREFS)) || {}); } catch { }
  if (prefs.links === 'lines') prefs.links = 'jump'; // the Lines option was removed
  function applyPrefs() {
    svEl.className = `sheetview lk-${prefs.links} w-${prefs.width}`;
    document.querySelectorAll('[data-svlinks]').forEach(b => b.classList.toggle('on', b.dataset.svlinks === prefs.links));
    document.querySelectorAll('[data-svwidth]').forEach(b => b.classList.toggle('on', b.dataset.svwidth === prefs.width));
  }
  function savePrefs() { try { localStorage.setItem(PREFS, JSON.stringify(prefs)); } catch { } applyPrefs(); }
  settingsReg.push({ get: () => ({ ...prefs }), set: p => { Object.assign(prefs, p); savePrefs(); render(); } });
  applyPrefs();

  // saved order first, then any new cards; with no saved order, final assembly then its sub-assemblies depth-first
  function sheetOrder() {
    const ids = Object.keys(S.asm), have = new Set(ids), out = [], seen = new Set();
    const push = id => { if (have.has(id) && !seen.has(id)) { seen.add(id); out.push(id); return true; } return false; };
    if (S.order) { S.order.forEach(push); ids.forEach(push); return out; }
    const walk = id => { if (!push(id)) return; for (const it of A(id).items) { const s = subIdOf(it.ref); if (s) walk(s); } };
    if (hasFinal()) walk(S.root);
    ids.filter(id => !parentsOf(id).length).forEach(walk);
    ids.forEach(walk);
    return out;
  }
  const ensureOrder = () => { S.order = sheetOrder(); };
  function depths() {
    const d = {}, q = Object.keys(S.asm).filter(id => id === S.root || !parentsOf(id).length).map(id => [id, 0]);
    while (q.length) {
      const [id, k] = q.shift(); if (d[id] != null && d[id] <= k) continue; d[id] = k;
      for (const it of A(id).items) { const s = subIdOf(it.ref); if (s && A(s)) q.push([s, k + 1]); }
    }
    return d;
  }
  function moveCard(id, dir) {
    ensureOrder();
    const i = S.order.indexOf(id), j = i + dir; if (i < 0 || j < 0 || j >= S.order.length) return;
    [S.order[i], S.order[j]] = [S.order[j], S.order[i]];
    render(); commit();
    cardsEl.querySelector(`[data-id="${id}"]`)?.scrollIntoView({ block: 'nearest' });
  }
  function drawSheetLinks() { svLinksEl.innerHTML = ''; } // the sheet shows links as jump links or an indent rail, not lines
  // cards added while in the sheet get a free spot on the board the next time it is shown
  function placeNewCards() {
    const ids = Object.keys(S.asm).filter(id => A(id)._place); if (!ids.length) return false;
    const H = heights(), placed = Object.entries(S.asm).filter(([, a]) => !a._place);
    let right = placed.length ? Math.max(...placed.map(([, a]) => a.x + CARDW)) : -GAPX;
    for (const id of ids) {
      const n = A(id), p = parentsOf(id).map(x => A(x.pid)).find(a => !a._place);
      if (p) { n.x = p.x + CARDW + GAPX; n.y = p.y; } else { n.x = right + GAPX; n.y = 0; right = n.x + CARDW; }
      for (let t = 0; t < 40; t++) {
        const hit = Object.entries(S.asm).find(([oid, a]) => oid !== id && !a._place && Math.abs(a.x - n.x) < CARDW && n.y < a.y + (H[oid] || 300) && n.y + (H[id] || 300) > a.y);
        if (!hit) break; n.y = hit[1].y + (H[hit[0]] || 300) + GAPY;
      }
      delete n._place;
    }
    render(); return true;
  }
  function setView(v) {
    useSide('left');
    if (v === view) return;
    clearTimeout(typingT); commit(); NL.closePicker();
    view = v;
    document.body.classList.toggle('view-sheet', v === 'sheet');
    document.querySelectorAll('#viewSeg [data-view]').forEach(b => b.classList.toggle('on', b.dataset.view === v));
    boardCardsEl.innerHTML = ''; svCardsEl.innerHTML = ''; linksEl.innerHTML = ''; svLinksEl.innerHTML = '';
    cardsEl = v === 'sheet' ? svCardsEl : boardCardsEl;
    if (v === 'sheet') { render(); svEl.scrollTop = 0; return; }
    // board placement is saved without its own undo step, so undo keeps meaning "undo my last edit"
    if (S._arrange) { delete S._arrange; arrange(); wb.save(S); hist.sync(); vp.fit(bounds(), 40, { min: 0.8, align: 'left' }); }
    else { render(); if (placeNewCards()) { wb.save(S); hist.sync(); } }
  }
  // drag a card's ⠿ grip up or down
  document.addEventListener('pointerdown', e => {
    if (!e.target.closest?.('#svCards, #spCards')) return;
    const g = e.target.closest('[data-grip]'); if (!g || e.button !== 0) return;
    e.preventDefault();
    const id = g.dataset.grip, el = g.closest('.rcard');
    ensureOrder();
    const line = document.createElement('div'); line.className = 'sv-drop'; svInnerEl.appendChild(line);
    el.classList.add('sv-dragging');
    let to = null;
    const mv = ev => {
      const cards = [...svCardsEl.querySelectorAll('.rcard')], box = svInnerEl.getBoundingClientRect();
      let idx = cards.length;
      for (let k = 0; k < cards.length; k++) { const r = cards[k].getBoundingClientRect(); if (ev.clientY < r.top + r.height / 2) { idx = k; break; } }
      to = idx;
      const yy = cards[idx] ? cards[idx].getBoundingClientRect().top - 10 : cards[cards.length - 1].getBoundingClientRect().bottom + 8;
      line.style.top = (yy - box.top) + 'px';
      const sr = svEl.getBoundingClientRect();
      if (ev.clientY < sr.top + 60) svEl.scrollTop -= 16; else if (ev.clientY > sr.bottom - 60) svEl.scrollTop += 16;
    };
    const up = () => {
      removeEventListener('pointermove', mv); removeEventListener('pointerup', up);
      line.remove(); el.classList.remove('sv-dragging');
      if (to == null) return;
      const from = S.order.indexOf(id); let t = to > from ? to - 1 : to;
      if (t === from) return;
      S.order.splice(from, 1); S.order.splice(t, 0, id);
      render(); commit();
    };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
    mv(e);
  });

  // ---------- mutations ----------
  const commit = () => hist.commit();
  function addItem(id, value, { focus = true } = {}) {
    const a = A(id);
    if (onScaleSide(id)) return NL.toast(`"${a.name}" is showing its Scaling side. Press Building to add to it`);
    if (value === 'new-sub') return newSub(id);
    if (value.startsWith('fav:')) return useFav(value.slice(4), id);
    if (value.startsWith('asm:') && wouldCycle(id, value.slice(4))) return NL.toast('That would create a loop');
    if (value.startsWith('asm:') && a.items.some(it => it.ref === value)) return NL.toast('Already linked');
    a.items.push({ ref: value, amount: 0 });
    render(); commit();
    if (value.startsWith('ing:')) { const ing = NL.ingMap[value.slice(4)], sh = bansFor(ing); if (sh.length) NL.toast(`⛔ ${ing.name} is not allowed by ${sh.join(', ')}`); }
    if (focus) focusAmt(id, a.items.length - 1);
  }
  // Chefs enter the weighed final weight; yield loss is derived from it (only yieldLoss is stored).
  function setFinalWeight(id, raw, u) {
    const batch = calc[id].batch, v = raw.trim();
    if (v === '') { delete fwErr[id]; if (id in fwStart) A(id).yieldLoss = fwStart[id]; return; }
    const fw = NL.fromU(NL.parseNum(v), u);
    let err = '';
    if (!isFinite(fw)) err = `Enter a number in ${NL.UNIT_NAMES[u] || 'grams'}`;
    else if (batch <= 0) err = 'Add ingredients with weights first';
    else if (fw <= 0) err = 'Final weight must be more than 0';
    else if (fw > batch + 1e-9) err = `Final weight (${NL.ws(fw, 1)}) can't be more than the starting weight (${NL.ws(batch, 1)})`;
    if (err) { fwErr[id] = err; if (id in fwStart) A(id).yieldLoss = fwStart[id]; return; }
    delete fwErr[id];
    A(id).yieldLoss = (1 - fw / batch) * 100;
  }
  // Baker's math: the base item is the one flagged `base`, else the first item with a weight.
  // Baker's math: the base is every item the chef flagged with B (their weights add up to 100%).
  const baseSet = a => a.items.map((it, k) => it.base ? k : -1).filter(k => k >= 0);
  const baseTotal = a => baseSet(a).reduce((s, k) => s + (+a.items[k].amount || 0), 0);
  const baseLabel = (a, set = baseSet(a)) => a.baseName || (set.length === 1 ? itemName(a.items[set[0]]) : 'Total base');
  const itemName = it => { const s = subIdOf(it.ref); return s ? (A(s)?.name || s) : (NL.ingMap[it.ref.slice(4)]?.name || it.ref); };
  const round2 = v => Math.round(v * 100) / 100;
  const bscaleStart = {}; // card id -> amounts when scaling began, so each keystroke scales from the original
  function focusAmt(id, idx) { const i = cardsEl.querySelector(`[data-amt="${id}:${idx}"]`); if (i) { i.focus(); i.select(); } }
  function newSub(pid) {
    const p = A(pid), nid = NL.uid('s');
    const used = new Set(Object.values(S.asm).map(a => a.color));
    const color = COLORS.find(c => !used.has(c)) || COLORS[Object.keys(S.asm).length % COLORS.length];
    const el = cardsEl.querySelector(`[data-id="${pid}"]`);
    S.asm[nid] = { name: 'New sub-assembly', items: [], yieldLoss: 0, steps: [], notes: '', color, x: p.x + CARDW + GAPX, y: p.y + (el ? el.offsetHeight : 200) - 120 };
    if (view === 'sheet') { S.asm[nid]._place = true; if (S.order) S.order.splice(S.order.indexOf(pid) + 1, 0, nid); }
    // avoid landing on top of another card
    const H = view === 'sheet' ? null : heights();
    for (let k = 0; H && k < 30; k++) {
      const n = S.asm[nid];
      const hit = Object.entries(S.asm).find(([id, a]) => id !== nid && Math.abs(a.x - n.x) < CARDW && n.y < a.y + (H[id] || 300) && n.y + 300 > a.y);
      if (!hit) break; n.y = hit[1].y + (H[hit[0]] || 300) + GAPY;
    }
    p.items.push({ ref: 'asm:' + nid, amount: 0 });
    render(); commit();
    goto(nid);
    setTimeout(() => { const t = cardsEl.querySelector(`[data-title="${nid}"]`); t?.focus(); t?.select(); }, 330);
    NL.toast('Name the sub-assembly, then set its weight in "' + p.name + '"');
  }
  function addCard() {
    const nid = NL.uid('s'), used = new Set(Object.values(S.asm).map(a => a.color));
    const color = COLORS.find(c => !used.has(c)) || COLORS[Object.keys(S.asm).length % COLORS.length];
    const r = vpEl.getBoundingClientRect(), c = vp.toWorld(r.left + r.width / 2, r.top + r.height / 3);
    S.asm[nid] = { name: 'New card', items: [], yieldLoss: 0, steps: [], notes: '', color, x: Math.round(c.x - CARDW / 2), y: Math.round(c.y - 60), ...(view === 'sheet' ? { _place: true } : {}) };
    const H = view === 'sheet' ? null : heights();
    for (let k = 0; H && k < 30; k++) {
      const n = S.asm[nid];
      const hit = Object.entries(S.asm).find(([id, a]) => id !== nid && Math.abs(a.x - n.x) < CARDW && n.y < a.y + (H[id] || 300) && n.y + 300 > a.y);
      if (!hit) break; n.x = hit[1].x + CARDW + 40;
    }
    render(); commit(); goto(nid);
    setTimeout(() => { const t = cardsEl.querySelector(`[data-title="${nid}"]`); t?.focus(); t?.select(); }, 330);
    NL.toast(view === 'sheet' ? 'Card added at the bottom. Link it with ↳ Link to assembly' : 'Card added. Drag its ● onto the assembly that uses it, or add it later with + Ingredient');
  }
  function linkCard(child, parent) {
    if (onScaleSide(parent)) return NL.toast(`"${A(parent).name}" is showing its Scaling side. Press Building to link to it`);
    if (A(parent).items.some(it => it.ref === 'asm:' + child)) return NL.toast('Already linked');
    if (wouldCycle(parent, child)) return NL.toast('That would create a loop');
    addItem(parent, 'asm:' + child);
    NL.toast(`Linked. Set how much of "${A(child).name}" go into "${A(parent).name}"`);
  }
  // ---------- copy / paste cards (clipboard lives in localStorage so it works across tabs) ----------
  const CLIP = 'nlv3_card_clipboard';
  const readClip = () => { try { return JSON.parse(localStorage.getItem(CLIP)); } catch { return null; } };
  function updatePasteBtn() {
    const c = readClip(), btn = $('#pasteCard');
    btn.hidden = !c?.cards;
    if (c?.cards) btn.title = `Paste "${c.cards[c.top].name}"${Object.keys(c.cards).length > 1 ? ` with ${Object.keys(c.cards).length - 1} sub-assembly card(s)` : ''} as a new unlinked card (Ctrl+V)`;
  }
  function copyCard(id) {
    const ids = [id, ...descendants(id)];
    const cards = Object.fromEntries(ids.map(k => [k, JSON.parse(JSON.stringify(A(k)))]));
    try { localStorage.setItem(CLIP, JSON.stringify({ top: id, cards })); } catch { return NL.toast('Could not copy the card'); }
    updatePasteBtn();
    NL.toast(`Copied "${A(id).name}"${ids.length > 1 ? ` with ${ids.length - 1} sub-assembly card(s)` : ''}. Paste with 📋 Paste card or Ctrl+V`);
  }
  // Insert a set of cards ({ top, cards }) as fresh copies. With `parent`, the top card is linked into that card.
  function insertCards(clip, { parent = null, suffix = '' } = {}) {
    const map = Object.fromEntries(Object.keys(clip.cards).map(k => [k, NL.uid('s')]));
    const keys = [clip.top, ...Object.keys(clip.cards).filter(k => k !== clip.top)]; // top first, so board placement follows the links
    const top = clip.cards[clip.top], used = new Set(Object.values(S.asm).map(a => a.color));
    let dx = 0, dy = 0;
    if (view === 'board' && !parent) {
      const r = vpEl.getBoundingClientRect(), ctr = vp.toWorld(r.left + r.width / 2, r.top + r.height / 3);
      dx = Math.round(ctr.x - CARDW / 2 - (top.x || 0)); dy = Math.round(ctr.y - 60 - (top.y || 0));
    }
    for (const k of keys) {
      const n = JSON.parse(JSON.stringify(clip.cards[k])); delete n.kind; delete n.favId; delete n._place; delete n.vars; // a copy starts with the variation in use only
      n.items = n.items.filter(it => !subIdOf(it.ref) || map[subIdOf(it.ref)]).map(it => { const s = subIdOf(it.ref); return s ? { ...it, ref: 'asm:' + map[s] } : it; });
      if (k === clip.top) n.name = n.name + suffix;
      if (!n.color || n.color === ROOT_COLOR) n.color = COLORS.find(c => !used.has(c)) || COLORS[Object.keys(S.asm).length % COLORS.length];
      used.add(n.color);
      n.x = (n.x || 0) + dx; n.y = (n.y || 0) + dy;
      if (view === 'sheet' || parent) n._place = true;
      S.asm[map[k]] = n;
    }
    const nid = map[clip.top];
    if (parent) {
      A(parent).items.push({ ref: 'asm:' + nid, amount: 0 });
      if (S.order) S.order.splice(S.order.indexOf(parent) + 1, 0, ...keys.map(k => map[k]));
    }
    render();
    if (view === 'board' && parent) placeNewCards();
    commit();
    if (parent) focusAmt(parent, A(parent).items.length - 1); else goto(nid);
    return nid;
  }

  // ---------- favorites: saved cards (with their sub-assembly cards) reusable in any assembly ----------
  const FAV = 'nlv3_favorites';
  let favCache = null;
  const readFavs = () => favCache || (favCache = (() => { try { return JSON.parse(localStorage.getItem(FAV)) || []; } catch { return []; } })());
  const favById = fid => readFavs().find(f => f.id === fid);
  const favOf = id => { const f = A(id)?.favId; return f ? favById(f) : null; };
  function writeFavs(list) {
    try { localStorage.setItem(FAV, JSON.stringify(list)); } catch { NL.toast('Could not save favorites: browser storage is full'); return false; }
    favCache = list; drawFavs(); return true;
  }
  function saveFav(id) {
    const a = A(id), list = readFavs().slice(), existing = favOf(id), ids = [id, ...descendants(id)];
    const entry = { id: existing?.id || NL.uid('f'), name: a.name, savedAt: Date.now(), top: id, cards: Object.fromEntries(ids.map(k => [k, JSON.parse(JSON.stringify(A(k)))])) };
    if (existing) list[list.findIndex(f => f.id === existing.id)] = entry; else list.unshift(entry);
    if (!writeFavs(list)) return;
    a.favId = entry.id; render(); commit();
    NL.toast(existing ? `Updated "${a.name}" in your favorites` : `Saved "${a.name}" to favorites${ids.length > 1 ? ` with ${ids.length - 1} sub-assembly card(s)` : ''}`);
  }
  function removeFav(fid) { const f = favById(fid); writeFavs(readFavs().filter(x => x.id !== fid)); render(); if (f) NL.toast(`Removed "${f.name}" from favorites`); }
  function useFav(fid, parent) {
    if (parent && onScaleSide(parent)) return NL.toast(`"${A(parent).name}" is showing its Scaling side. Press Building to add to it`);
    const f = favById(fid); if (!f) return NL.toast('That favorite no longer exists');
    insertCards(f, { parent });
    NL.toast(parent ? `Added "${f.name}" to "${A(parent).name}". Set its weight` : `Added "${f.name}" as a new card`);
  }
  function favMenu(id, anchor) {
    document.querySelector('.fav-menu')?.remove();
    const r = anchor.getBoundingClientRect(), m = document.createElement('div'); m.className = 'fav-menu';
    m.innerHTML = `<button data-fm="up">↻ Update saved copy with this card</button><button data-fm="rm" class="danger">Remove from favorites</button>`;
    m.style.left = Math.max(8, Math.min(r.right - 230, innerWidth - 240)) + 'px'; m.style.top = (r.bottom + 6) + 'px';
    document.body.appendChild(m);
    const off = e => { if (!m.contains(e.target)) close(); };
    const close = () => { m.remove(); removeEventListener('pointerdown', off, true); };
    setTimeout(() => addEventListener('pointerdown', off, true));
    m.onclick = e => { const b = e.target.closest('[data-fm]'); if (!b) return; close(); if (b.dataset.fm === 'up') saveFav(id); else removeFav(A(id).favId); };
  }
  const retailOpen = new Set(); // retailers expanded in the side panel
  function drawRetail() {
    const list = readRetail();
    $('#retailList').innerHTML = list.length ? list.map(r => `<div class="rt ${retailOn(r) ? '' : 'off'}">
        <div class="rt-row"><input type="checkbox" data-rton="${r.id}" ${retailOn(r) ? 'checked' : ''} title="Check this recipe against ${NL.esc(r.name)}"><button class="rt-nm" data-rtopen="${r.id}" title="Show or edit the ingredients ${NL.esc(r.name)} does not allow">${retailOpen.has(r.id) ? '▾' : '▸'} ${NL.esc(r.name)}</button><span class="faint">${r.bans.length} not allowed</span><button class="fav-b x" data-rtdel="${r.id}" title="Remove this retailer">×</button></div>
        ${retailOpen.has(r.id) ? `<div class="rt-bans">${r.bans.map((b, k) => `<span class="rt-chip">${NL.esc(b)}${(o => o.length ? `<span class="rt-also" title="Also not allowed by: ${NL.esc(o.join(', '))}">+${o.length}</span>` : '')(list.filter(x => x !== r && x.bans.some(y => y.toLowerCase() === b.toLowerCase())).map(x => x.name))}<button data-rtban="${r.id}:${k}" title="Remove">×</button></span>`).join('')}<input class="txt rt-in" data-rtadd="${r.id}" list="rtNames" placeholder="Type an ingredient, press Enter"></div>` : ''}
      </div>`).join('') + `<datalist id="rtNames">${[...new Set(NL.INGREDIENTS.map(i => i.name))].map(n => `<option value="${NL.esc(n)}">`).join('')}</datalist><div class="fav-empty">Ticked retailers are checked in this recipe.</div>`
      : '<div class="fav-empty">Add a retailer (＋) and the ingredients it does not allow. Cards flag them with ⛔.</div>';
  }

  // ---------- ⬇ Export to Excel (.xlsx) ----------
  // One workbook per recipe tab: Summary, one sheet per card, Bill of materials, Nutrition.
  // Weights use the chosen unit (Auto exports in g or oz so every column has one unit); costs are optional.
  // SheetJS is loaded from cdnjs the first time someone exports.
  const XLSX_URL = 'https://cdn.jsdelivr.net/npm/xlsx-js-style@1.2.0/dist/xlsx.bundle.js'; // SheetJS + cell styles (colours, bold)
  let xlsxLoading = null;
  const loadXlsx = () => window.XLSX ? Promise.resolve(window.XLSX) : (xlsxLoading = xlsxLoading || new Promise((ok, fail) => {
    const sc = document.createElement('script'); sc.src = XLSX_URL;
    sc.onload = () => ok(window.XLSX); sc.onerror = () => { xlsxLoading = null; sc.remove(); fail(new Error('could not load SheetJS')); };
    document.head.appendChild(sc);
  }));
  const XP_STYLES = ['template', 'card', 'production', 'costing', 'spec', 'detailed'];
  const xpLayout = () => { try { const v = localStorage.getItem('nlv3_export_layout'); return XP_STYLES.includes(v) ? v : 'template'; } catch { return 'template'; } };
  function exportDialog() {
    useSide('left'); clearTimeout(typingT); commit();
    if (!Object.keys(S.asm).length) return NL.toast('Nothing to export yet. Add a card first');
    loadXlsx().catch(() => { }); // start loading while the dialog is open
    const ov = document.createElement('div'); ov.className = 'nl-prompt-ov';
    ov.innerHTML = `<form class="nl-prompt nif">
      <div class="nl-prompt-label">Export to Excel</div>
      <div class="xp-sub">Pick a style. Chefs can try each and keep the one that fits.</div>
      <div class="xp-lay">
        <label><input type="radio" name="layout" value="template" ${xpLayout() === 'template' ? 'checked' : ''}> <b>Company template</b><small>Like the team's recipe workbook: a recipe block per component, components summary, production totals (g / kg / lbs), Item &amp; cost sheet, Nutrition.</small></label>
        <label><input type="radio" name="layout" value="card" ${xpLayout() === 'card' ? 'checked' : ''}> <b>Recipe card</b><small>One simple page per recipe: ingredients and amounts, yield, procedure, notes. No costs. For the kitchen.</small></label>
        <label><input type="radio" name="layout" value="production" ${xpLayout() === 'production' ? 'checked' : ''}> <b>Production / batch sheet</b><small>What to make, in order, for a number of portions: scaled weights in g / kg / lb with check boxes. For the floor.</small></label>
        <label><input type="radio" name="layout" value="costing" ${xpLayout() === 'costing' ? 'checked' : ''}> <b>Costing sheet</b><small>Cost per portion by component and by raw ingredient, packaging and labor, with % of cost.</small></label>
        <label><input type="radio" name="layout" value="spec" ${xpLayout() === 'spec' ? 'checked' : ''}> <b>Spec / label sheet</b><small>Serving size, nutrition per serving and per 100 g, ingredient statement. For QA and the client.</small></label>
        <label><input type="radio" name="layout" value="detailed" ${xpLayout() === 'detailed' ? 'checked' : ''}> <b>Detailed</b><small>Everything: a Summary, a sheet per card (pinned and From Final columns), Bill of materials, Nutrition.</small></label>
      </div>
      <label class="xp-chk xp-qty">Portions to make <input class="num" name="qty" inputmode="decimal" value="${(hasFinal() && A(S.root).scalePins?.[0]?.mode === 'portion' ? +A(S.root).scalePins[0].count : 100)}"></label>
      <label class="xp-chk xp-cost"><input type="checkbox" name="costs" checked> Include costs <small>(untick to send a copy without prices)</small></label>
      <div class="nl-prompt-btns"><button type="submit" class="btn primary">⬇ Export</button><button type="button" class="btn ghost nl-prompt-cancel">Cancel</button></div>
    </form>`;
    document.body.appendChild(ov);
    const f = ov.querySelector('form'), close = () => ov.remove();
    // show the quantity box for the production sheet, and the costs box only where costs are optional
    const sync = () => { const v = f.elements.layout.value; f.querySelector('.xp-qty').hidden = v !== 'production'; f.querySelector('.xp-cost').hidden = !['template', 'detailed'].includes(v); };
    f.addEventListener('change', sync); sync();
    f.onsubmit = e => {
      e.preventDefault();
      const layout = f.elements.layout.value, costs = f.elements.costs.checked, qty = NL.parseNum(f.elements.qty.value);
      if (layout === 'production' && !(qty > 0)) return NL.toast('Enter how many portions to make');
      try { localStorage.setItem('nlv3_export_layout', layout); } catch { }
      close(); exportXlsx({ costs, layout, qty });
    };
    ov.querySelector('.nl-prompt-cancel').onclick = close;
    ov.addEventListener('pointerdown', e => { if (e.target === ov) close(); });
    ov.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
    f.querySelector('button[type=submit]').focus();
  }

  // Company template: laid out like the team's recipe workbook (a product sheet per recipe + Item & cost sheet).
  // Values only (no formulas): the app does the calculations, the file shows what was built.
  // Colours as in the template: green = entered in the app, orange = calculated, grey = headers, peach = production.

  // shared helpers for the styled exports: colours, a cell grid, sheet names, and recipe maths used by every style
  function xlKit(X) {
    const today = new Date().toISOString().slice(0, 10);
    const C = { GREEN: 'C1F1C8', ORANGE: 'F1AB83', GREY: 'EFEFEF', PEACH: 'FAE3D6', LIGHT: 'D9F2D0', BLUE: 'DDEBF7' };
    const line = { style: 'thin', color: { rgb: 'BFBFBF' } }, border = { top: line, bottom: line, left: line, right: line };
    const st = (fill, o = {}) => ({ ...(fill ? { fill: { patternType: 'solid', fgColor: { rgb: fill } } } : {}), ...(o.bold || o.size ? { font: { bold: !!o.bold, ...(o.size ? { sz: o.size } : {}) } } : {}), ...(o.box ? { border } : {}), ...(o.wrap ? { alignment: { wrapText: true, vertical: 'top' } } : {}), ...(o.fmt ? { numFmt: o.fmt } : {}) });
    const F = { G2: '0.00', G3: '0.000', USD: '"$"#,##0.00', USD5: '"$"#,##0.00000', PCT: '0.0%', P0: '0%' };
    const r2 = v => v == null || !isFinite(v) ? null : Math.round(v * 100) / 100;
    const xb = X.utils.book_new(), used = new Set();
    const sheetName = n => { const b = String(n).replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 28) || 'Sheet'; let name = b, k = 2; while (used.has(name.toLowerCase())) name = `${b.slice(0, 25)} ${k++}`; used.add(name.toLowerCase()); return name; };
    const grid = () => {
      const cells = {}; let mr = 0, mc = 0;
      return {
        put(r, c, v, sty) {
          if ((v === null || v === undefined || v === '') && !sty) return;
          const cell = v === null || v === undefined || v === '' ? { t: 's', v: '' } : typeof v === 'number' ? { t: 'n', v } : { t: 's', v: String(v) };
          if (sty) { cell.s = sty; if (sty.numFmt) cell.z = sty.numFmt; }
          cells[X.utils.encode_cell({ r, c })] = cell; mr = Math.max(mr, r); mc = Math.max(mc, c);
        },
        sheet(widths) { const ws = { ...cells, '!ref': X.utils.encode_range({ s: { r: 0, c: 0 }, e: { r: mr, c: mc } }) }; ws['!cols'] = widths.map(w => ({ wch: w })); return ws; },
      };
    };
    const add = (g, name, widths) => X.utils.book_append_sheet(xb, g.sheet(widths), sheetName(name));
    const cardCost = id => { const a = A(id); return cost[id].batch + (a.packaging || []).reduce((t, r) => t + (+r.cost || 0), 0) + laborOf(a); };
    const costPerG = it => { const sid = subIdOf(it.ref); if (sid) return cost[sid] ? cost[sid].perG : null; const p = NL.price(it.ref.slice(4)); return p == null ? null : p / 1000; };
    const vName = id => { const a = A(id); return varsOf(a) ? varInUse(a).name : ''; };
    const itemName = it => { const sid = subIdOf(it.ref); return sid ? (A(sid)?.name || '(missing)') : (NL.ingMap[it.ref.slice(4)]?.name || it.ref); };
    const tops = () => hasFinal() ? [S.root] : Object.keys(S.asm).filter(id => !parentsOf(id).length);
    // how many batches of each card one batch of 'top' uses
    const share = top => { const sh = { [top]: 1 }; (function walk(id, f) { for (const it of A(id).items) { const sid = subIdOf(it.ref); if (!sid || !A(sid) || !(calc[sid].yielded > 0)) continue; const sf = (+it.amount || 0) * f / calc[sid].yielded; sh[sid] = (sh[sid] || 0) + sf; walk(sid, sf); } })(top, 1); return sh; };
    // components first (deepest first), the top card last
    const postOrder = top => { const out = [], seen = new Set(); (function post(id) { if (seen.has(id)) return; seen.add(id); for (const it of A(id).items) { const sid = subIdOf(it.ref); if (sid && A(sid)) post(sid); } out.push(id); })(top); return out; };
    const title = hasFinal() ? A(S.root).name : (S.draftName || 'Untitled assembly');
    const save = suffix => { const file = `${title.replace(/[\\/:*?"<>|]/g, ' ').trim() || 'Recipe'} - ${suffix ? suffix + ' - ' : ''}${today}.xlsx`; X.writeFile(xb, file); NL.toast('Exported ' + file); };
    return { today, C, st, F, r2, xb, sheetName, grid, add, cardCost, costPerG, vName, itemName, tops, share, postOrder, title, save };
  }

  // Recipe card: one simple sheet per card (components first): ingredients and amounts, yield, procedure, notes. No costs.
  function exportCard(X) {
    const K = xlKit(X), { C, st, F, r2 } = K;
    const order = []; for (const top of K.tops()) for (const id of K.postOrder(top)) if (!order.includes(id)) order.push(id);
    for (const id of order) {
      const g = K.grid(), a = A(id), c = calc[id]; let r = 0;
      g.put(r, 0, a.name + (K.vName(id) ? ' (' + K.vName(id) + ')' : ''), st(null, { bold: true, size: 16 })); r++;
      g.put(r, 0, id === S.root ? 'Final assembly · one portion' : 'Sub-assembly'); g.put(r, 2, 'Printed ' + K.today); r += 2;
      g.put(r, 0, 'Makes', st(null, { bold: true })); g.put(r, 1, NL.ws(c.yielded, 1)); g.put(r, 2, 'from ' + NL.ws(c.batch, 1) + ' · yield ' + NL.yieldPct(a.yieldLoss) + '%'); r += 2;
      ['Ingredient', 'Amount', 'Unit'].forEach((h, k) => g.put(r, k, h, st(C.GREY, { bold: true, box: true }))); r++;
      for (const it of a.items) {
        const amt = +it.amount || 0, u = NL.unitFor(amt), sid = subIdOf(it.ref);
        g.put(r, 0, K.itemName(it) + (sid ? '  (see its card)' : ''), st(null, { box: true }));
        g.put(r, 1, +(amt / NL.UNITS[u]).toFixed(u === 'g' ? 1 : 3), st(null, { box: true })); g.put(r, 2, u, st(null, { box: true })); r++;
      }
      for (const p of a.packaging || []) { g.put(r, 0, 'Packaging: ' + (p.name || ''), st(null, { box: true })); g.put(r, 1, p.weight ?? null, st(null, { box: true })); g.put(r, 2, p.weight == null ? '' : 'g', st(null, { box: true })); r++; }
      r++;
      const steps = (a.steps || []).filter(t => String(t).trim());
      if (steps.length) { g.put(r, 0, 'Procedure', st(null, { bold: true })); r++; steps.forEach((t, k) => { g.put(r, 0, (k + 1) + '. ' + t, st(null, { wrap: true })); r++; }); r++; }
      if ((a.notes || '').trim()) { g.put(r, 0, 'Notes', st(null, { bold: true })); r++; g.put(r, 0, a.notes, st(null, { wrap: true })); }
      K.add(g, a.name, [46, 12, 8]);
    }
    K.save('Recipe cards');
  }

  // Production / batch sheet: for N portions of the Final, what to make in what order, scaled weights in g / kg / lb, with check boxes.
  function exportProduction(X, N) {
    const K = xlKit(X), { C, st, F, r2 } = K;
    for (const top of K.tops()) {
      const g = K.grid(), sh = K.share(top), root = A(top), isFinal = top === S.root; let r = 0, step = 0;
      g.put(r, 0, 'Production sheet: ' + root.name, st(null, { bold: true, size: 16 })); r++;
      g.put(r, 0, 'Make'); g.put(r, 1, N, st(C.GREEN, { bold: true, box: true, fmt: '#,##0.##' })); g.put(r, 2, isFinal ? 'portions of ' + NL.ws(calc[top].yielded, 1) : 'batches'); g.put(r, 5, 'Date ' + K.today); r += 2;
      for (const id of K.postOrder(top)) {
        const a = A(id), c = calc[id], f = (sh[id] || 0) * N; step++;
        g.put(r, 0, 'Step ' + step + ': ' + (id === top ? (isFinal ? 'Assemble / pack ' : 'Make ') : 'Make ') + a.name, st(C.BLUE, { bold: true })); for (let k = 1; k <= 5; k++) g.put(r, k, '', st(C.BLUE));
        r++;
        g.put(r, 0, id === top && isFinal ? N + ' portions' : 'Batch ' + NL.ws(c.batch * f, 2) + ' → yields ' + NL.ws(c.yielded * f, 2) + ' (' + NL.yieldPct(a.yieldLoss) + '%)', st(null, {})); r++;
        ['Ingredient', 'g', 'kg', 'lb', 'Done ✓'].forEach((h, k) => g.put(r, k, h, st(C.GREY, { bold: true, box: true }))); r++;
        for (const it of a.items) {
          const x = (+it.amount || 0) * f, sid = subIdOf(it.ref);
          g.put(r, 0, K.itemName(it) + (sid ? '  (from step above)' : ''), st(null, { box: true }));
          g.put(r, 1, r2(x), st(C.PEACH, { box: true, fmt: '#,##0.00' })); g.put(r, 2, +(x / 1000).toFixed(3), st(C.PEACH, { box: true, fmt: F.G3 })); g.put(r, 3, +(x / 453.59237).toFixed(3), st(C.PEACH, { box: true, fmt: F.G3 })); g.put(r, 4, '☐', st(null, { box: true }));
          r++;
        }
        for (const p of a.packaging || []) { g.put(r, 0, 'Packaging: ' + (p.name || ''), st(null, { box: true })); g.put(r, 1, p.weight == null ? null : r2(p.weight * f), st(C.PEACH, { box: true })); g.put(r, 4, '☐', st(null, { box: true })); r++; }
        const steps = (a.steps || []).filter(t => String(t).trim());
        if (steps.length) { g.put(r, 0, 'How: ' + steps.map((t, k) => (k + 1) + '. ' + t).join('  '), st(null, { wrap: true })); r++; }
        r++;
      }
      K.add(g, 'Production ' + root.name, [48, 14, 12, 12, 9]);
    }
    K.save('Production x' + N);
  }

  // Costing sheet: cost per portion by component, by raw ingredient, packaging and labor, with % of cost.
  function exportCosting(X) {
    const K = xlKit(X), { C, st, F } = K;
    for (const top of K.tops()) {
      const g = K.grid(), sh = K.share(top), root = A(top); let r = 0;
      // per portion: raw ingredients (through every sub-assembly) + packaging + labor of every card
      const flat = NL.flatten(S, calc, top);
      const ingRows = flat.map(([iid, x]) => { const p = NL.price(iid); return { name: NL.ingMap[iid]?.name || iid, vendor: NL.ingMap[iid]?.vendor || '', g: x, cost: p == null ? null : x / 1000 * p }; });
      const pkRows = [], lbRows = [];
      for (const [id, sf] of Object.entries(sh)) { for (const p of A(id).packaging || []) pkRows.push({ name: (p.name || 'Packaging') + (id === top ? '' : ' (' + A(id).name + ')'), cost: p.cost == null ? null : p.cost * sf }); const l = laborOf(A(id)) * sf; if (l > 0) lbRows.push({ name: 'Labor: ' + A(id).name, cost: l }); }
      const total = [...ingRows, ...pkRows, ...lbRows].reduce((t, x) => t + (x.cost || 0), 0) || 0;
      g.put(r, 0, 'Costing: ' + root.name, st(null, { bold: true, size: 16 })); r++;
      g.put(r, 0, 'Cost per ' + (top === S.root ? 'portion' : 'batch') + ' (ingredients, packaging and labor of every card)'); g.put(r, 3, total, st(C.ORANGE, { bold: true, box: true, fmt: F.USD })); r++;
      g.put(r, 0, 'Exported ' + K.today); r += 2;
      // by component (what the top card is made of)
      g.put(r, 0, 'By component', st(null, { bold: true })); r++;
      ['Component', 'Amount (g)', 'Cost', '% of cost'].forEach((h, k) => g.put(r, k, h, st(C.GREY, { bold: true, box: true }))); r++;
      const comp = root.items.map(it => { const sid = subIdOf(it.ref), amt = +it.amount || 0; let cst = sid ? (cost[sid] ? amt * cost[sid].perG : null) : rowCost(it)?.v ?? null; if (sid) { const s2 = K.share(sid); for (const [cid, sf] of Object.entries(s2)) { const k2 = amt / (calc[sid].yielded || 1) * sf; cst = (cst || 0) + (A(cid).packaging || []).reduce((t, p) => t + (+p.cost || 0), 0) * k2 + laborOf(A(cid)) * k2; } } return { name: K.itemName(it) + (sid ? ' (sub-assembly)' : ''), g: amt, cost: cst }; });
      for (const p of root.packaging || []) comp.push({ name: 'Packaging: ' + (p.name || ''), g: p.weight, cost: p.cost ?? null });
      if (laborOf(root) > 0) comp.push({ name: 'Labor', g: null, cost: laborOf(root) });
      for (const x of comp) { g.put(r, 0, x.name, st(null, { box: true })); g.put(r, 1, x.g == null ? null : K.r2(x.g), st(null, { box: true, fmt: F.G2 })); g.put(r, 2, x.cost, st(C.ORANGE, { box: true, fmt: F.USD5 })); g.put(r, 3, total > 0 && x.cost != null ? x.cost / total : null, st(null, { box: true, fmt: F.PCT })); r++; }
      r++;
      // by raw ingredient, most expensive first
      g.put(r, 0, 'By raw ingredient (most expensive first)', st(null, { bold: true })); r++;
      ['Ingredient', 'Vendor', 'Amount (g)', 'Price per kg', 'Cost', '% of cost'].forEach((h, k) => g.put(r, k, h, st(C.GREY, { bold: true, box: true }))); r++;
      for (const x of [...ingRows].sort((a, b) => (b.cost ?? -1) - (a.cost ?? -1))) { const p = x.g > 0 && x.cost != null ? x.cost / x.g * 1000 : null; g.put(r, 0, x.name, st(null, { box: true })); g.put(r, 1, x.vendor, st(null, { box: true })); g.put(r, 2, K.r2(x.g), st(null, { box: true, fmt: F.G2 })); g.put(r, 3, p, st(null, { box: true, fmt: F.USD })); g.put(r, 4, x.cost, st(C.ORANGE, { box: true, fmt: F.USD5 })); g.put(r, 5, total > 0 && x.cost != null ? x.cost / total : null, st(null, { box: true, fmt: F.PCT })); r++; }
      for (const x of [...pkRows, ...lbRows]) { g.put(r, 0, x.name, st(null, { box: true })); g.put(r, 4, x.cost, st(C.ORANGE, { box: true, fmt: F.USD5 })); g.put(r, 5, total > 0 && x.cost != null ? x.cost / total : null, st(null, { box: true, fmt: F.PCT })); r++; }
      g.put(r, 0, 'Total', st(null, { bold: true, box: true })); g.put(r, 4, total, st(C.ORANGE, { bold: true, box: true, fmt: F.USD })); g.put(r, 5, total > 0 ? 1 : null, st(null, { box: true, fmt: F.PCT })); r += 2;
      const missing = ingRows.filter(x => x.cost == null).map(x => x.name);
      if (missing.length) { g.put(r, 0, 'No price yet (not in the total): ' + missing.join(', '), st(C.ORANGE, { wrap: true })); r++; }
      // per pinned scaling on the top card
      const pins = root.scalePins || [];
      if (pins.length) { r++; g.put(r, 0, 'For each pinned scaling', st(null, { bold: true })); r++; ['Scaling', 'Cost'].forEach((h, k) => g.put(r, k, h, st(C.GREY, { bold: true, box: true }))); r++; for (const p of pins) { g.put(r, 0, pinLabel(p), st(null, { box: true })); g.put(r, 1, total * pinFactor(p, calc[top], baseTotal(root)), st(C.ORANGE, { box: true, fmt: F.USD })); r++; } }
      K.add(g, 'Costing ' + root.name, [44, 20, 13, 13, 13, 11]);
    }
    K.save('Costing');
  }

  // Spec / label sheet: product facts, nutrition per portion and per 100 g, ingredient statement.
  function exportSpec(X) {
    const K = xlKit(X), { C, st, F } = K;
    for (const top of K.tops()) {
      const g = K.grid(), a = A(top), c = calc[top], isFinal = top === S.root, serving = isFinal ? c.yielded : 100; let r = 0;
      g.put(r, 0, 'Product specification: ' + a.name, st(null, { bold: true, size: 16 })); r++;
      g.put(r, 0, 'Exported ' + K.today + ' · values from the ingredient library; verify before regulatory use'); r += 2;
      const facts = [['Product', a.name], ['Serving size', NL.fmt(serving, 1) + ' g' + (isFinal ? ' (one portion)' : '')], ['Calories per serving', Math.round(c.perG[0] * serving)], ['Components', a.items.filter(it => subIdOf(it.ref)).map(it => A(subIdOf(it.ref))?.name).filter(Boolean).join(', ') || '—'], ['Cooking / assembly loss', (+a.yieldLoss || 0) + '%']];
      for (const [k, v] of facts) { g.put(r, 0, k, st(C.GREY, { bold: true, box: true })); g.put(r, 1, v, st(null, { box: true })); r++; }
      r++;
      g.put(r, 0, 'Nutrition Facts', st(null, { bold: true, size: 13 })); r++;
      ['Nutrient', 'Per serving (' + NL.fmt(serving, 1) + ' g)', '% Daily Value', 'Per 100 g'].forEach((h, k) => g.put(r, k, h, st(C.GREY, { bold: true, box: true, wrap: true }))); r++;
      NL.NUTRIENTS.forEach((n, k) => {
        const d = n.unit === 'mg' || !n.unit ? 0 : 1, v = c.perG[k] * serving;
        g.put(r, 0, (n.sub ? '   ' : '') + n.label + ' (' + (n.unit || 'kcal') + ')', st(null, { box: true, ...(n.sub ? {} : { bold: true }) }));
        g.put(r, 1, +v.toFixed(d), st(null, { box: true })); g.put(r, 2, n.dv ? Math.round(v / n.dv * 100) / 100 : null, st(null, { box: true, fmt: F.P0 })); g.put(r, 3, +(c.perG[k] * 100).toFixed(d), st(null, { box: true })); r++;
      });
      r++;
      g.put(r, 0, 'Ingredients', st(null, { bold: true })); r++;
      g.put(r, 0, NL.flatten(S, calc, top).map(([iid]) => NL.ingMap[iid]?.name || iid).join(', '), st(null, { wrap: true })); r++;
      g.put(r, 0, '(largest first, by weight before cooking)');
      K.add(g, 'Spec ' + a.name, [34, 30, 14, 14]);
    }
    K.save('Spec sheet');
  }
  function exportTemplate(X, costs) {
    const K = xlKit(X), { today, st, r2, xb, sheetName, grid, cardCost, costPerG, vName } = K;
    const { GREEN, ORANGE, GREY, PEACH, LIGHT } = K.C, { G2, USD, USD5, PCT } = K.F;
    const used_ings = new Map(); // id -> grams per portion, for the Item & cost sheet

    // products: the Final assembly (or each top card when there is no Final)
    const tops = hasFinal() ? [S.root] : Object.keys(S.asm).filter(id => !parentsOf(id).length);
    for (const top of tops) {
      const g = grid(), root = A(top), rc = calc[top], fp = root.scalePins || [];
      // scale up: the first pinned column on the product card (500 portions), otherwise 1 portion
      const p0 = fp[0], F = p0 ? pinFactor(p0, rc, baseTotal(root)) : 1;
      const N = p0 && p0.mode === 'portion' ? +p0.count : +F.toFixed(4);
      // share = how many batches of each card one portion uses (product card = 1)
      const share = { [top]: 1 };
      (function walk(id, f) { for (const it of A(id).items) { const sid = subIdOf(it.ref); if (!sid || !A(sid) || !(calc[sid].yielded > 0)) continue; const sf = (+it.amount || 0) * f / calc[sid].yielded; share[sid] = (share[sid] || 0) + sf; walk(sid, sf); } })(top, 1);
      // order: components first (deepest first), product card last, as in the template
      const order = [], seen = new Set();
      (function post(id) { if (seen.has(id)) return; seen.add(id); for (const it of A(id).items) { const sid = subIdOf(it.ref); if (sid && A(sid)) post(sid); } order.push(id); })(top);

      // header
      g.put(0, 0, 'Snapshot from the NutriLabel Recipe Builder · ' + today + ' · calculations are done in the app', st(ORANGE, { bold: true }));
      g.put(0, 5, root.name, st(GREEN, { bold: true, size: 14 }));
      g.put(0, 12, '1 Portion', st(null, { bold: true }));
      g.put(1, 0, 'version # ' + [wb.all().find(t => t.active)?.name, vName(top)].filter(Boolean).join(' · '));
      g.put(3, 1, 'Scale up', st(null, { bold: true })); g.put(3, 3, N, st(GREEN, { fmt: G2, box: true })); g.put(3, 5, p0 && p0.mode === 'portion' ? 'Portions' : '× batch');
      g.put(1, 7, 'For QA Reference.', st(null, { bold: true })); g.put(2, 7, 'Pouch item', st(GREY, { box: true })); g.put(2, 8, 'Pasteurization Target Temp', st(GREY, { box: true })); g.put(2, 9, 'Cooking Temp And Time', st(GREY, { box: true }));

      // right: components summary (per portion)
      let rr = 2;
      g.put(rr, 11, 'Components (per portion)', st(GREY, { bold: true, box: true })); g.put(rr, 12, 'Quantity (g)', st(GREY, { bold: true, box: true })); if (costs) g.put(rr, 13, 'Cost', st(GREY, { bold: true, box: true })); g.put(rr, 14, 'oz', st(GREY, { bold: true, box: true }));
      for (const it of root.items) {
        const sid = subIdOf(it.ref); if (!sid || !A(sid)) continue; rr++;
        const amt = +it.amount || 0;
        g.put(rr, 11, A(sid).name, st(null, { box: true })); g.put(rr, 12, r2(amt), st(LIGHT, { fmt: G2, box: true }));
        if (costs) g.put(rr, 13, cost[sid] ? amt * cost[sid].perG : null, st(ORANGE, { fmt: USD, box: true }));
        g.put(rr, 14, +(amt / 28.349523125).toFixed(2), st(null, { fmt: G2, box: true }));
      }
      for (const r of root.packaging || []) { rr++; g.put(rr, 11, (r.name || 'Packaging') + ' cost per portion', st(null, { box: true })); if (costs) g.put(rr, 13, r.cost ?? null, st(ORANGE, { fmt: USD5, box: true })); }
      if (costs) { rr++; g.put(rr, 11, 'Total cost', st(null, { bold: true, box: true })); g.put(rr, 13, cardCost(top), st(ORANGE, { bold: true, fmt: USD, box: true })); }

      // left: one recipe block per card
      let r = Math.max(6, rr + 2);
      const blockTop = r;
      for (const id of order) {
        const a = A(id), c = calc[id], isTop = id === top, sc = (share[id] || 0) * F;
        g.put(r, 1, 'Recipe', st(null, { bold: true })); g.put(r, 2, a.name + (vName(id) ? ' (' + vName(id) + ')' : ''), st(GREEN, { bold: true })); g.put(r, 3, isTop ? 'Final assembly' : 'Sub-assembly (WIP)', st(null, {}));
        r++;
        ['Grouping if needed', 'Ingredient', 'Quantity (g)', '% of Total', 'Cost Per G', 'Cost', 'Scale Up', '% of Total'].forEach((h, k) => g.put(r, 1 + k, h, st(GREY, { bold: true, box: true })));
        r++;
        for (const it of a.items) {
          const sid = subIdOf(it.ref), amt = +it.amount || 0, cpg = costPerG(it);
          if (!sid) used_ings.set(it.ref.slice(4), true);
          g.put(r, 1, sid ? 'WIP' : '', st(null, { box: true }));
          g.put(r, 2, sid ? (A(sid)?.name || '(missing)') : (NL.ingMap[it.ref.slice(4)]?.name || it.ref), st(GREEN, { box: true }));
          g.put(r, 3, r2(amt), st(GREEN, { fmt: G2, box: true }));
          g.put(r, 4, c.batch > 0 ? amt / c.batch : null, st(null, { fmt: PCT, box: true }));
          g.put(r, 5, costs ? cpg : null, st(ORANGE, { fmt: USD5, box: true }));
          g.put(r, 6, costs && cpg != null ? amt * cpg : null, st(ORANGE, { fmt: USD5, box: true }));
          g.put(r, 7, r2(amt * sc), st(ORANGE, { fmt: G2, box: true }));
          g.put(r, 8, c.batch > 0 ? amt / c.batch : null, st(null, { fmt: PCT, box: true }));
          r++;
        }
        for (const p of a.packaging || []) {
          g.put(r, 1, 'Pkg', st(null, { box: true })); g.put(r, 2, p.name || 'Packaging', st(GREEN, { box: true })); g.put(r, 3, p.weight == null ? null : r2(p.weight), st(GREEN, { fmt: G2, box: true }));
          g.put(r, 6, costs ? p.cost ?? null : null, st(ORANGE, { fmt: USD5, box: true })); g.put(r, 7, p.weight == null ? null : r2(p.weight * sc), st(ORANGE, { fmt: G2, box: true }));
          r++;
        }
        g.put(r, 2, 'Total', st(null, { bold: true })); g.put(r, 3, r2(c.batch), st(ORANGE, { bold: true, fmt: G2, box: true })); g.put(r, 4, c.batch > 0 ? 1 : null, st(null, { fmt: PCT }));
        if (costs) g.put(r, 6, cardCost(id), st(ORANGE, { bold: true, fmt: USD5, box: true }));
        g.put(r, 7, r2(c.batch * sc), st(ORANGE, { bold: true, fmt: G2, box: true })); g.put(r, 8, c.batch > 0 ? 1 : null, st(null, { fmt: PCT }));
        r++;
        g.put(r, 2, 'Output', st(null, { bold: true })); g.put(r, 3, r2(c.yielded), st(LIGHT, { fmt: G2, box: true }));
        if (costs) { g.put(r, 5, 'cost per g after cook'); g.put(r, 6, cost[id].perG || null, st(ORANGE, { fmt: USD5, box: true })); }
        r++;
        g.put(r, 2, 'Yield %', st(null, { bold: true })); g.put(r, 6, NL.yieldPct(a.yieldLoss) / 100, st(GREEN, { fmt: '0%', box: true }));
        r++;
        g.put(r, 2, 'After cook with yield', st(null, { bold: true })); g.put(r, 3, r2(c.yielded), st(LIGHT, { fmt: G2, box: true })); g.put(r, 7, r2(c.yielded * sc), st(ORANGE, { fmt: G2, box: true }));
        r++;
        const steps = (a.steps || []).filter(t => String(t).trim());
        g.put(r, 1, 'Procedure: ' + (steps.length ? steps.map((t, k) => (k + 1) + '. ' + t).join('  ') : ''), st(GREEN, { wrap: true }));
        g.put(r, 5, 'Notes: ' + (a.notes || ''), st(GREEN, { wrap: true }));
        if ((a.labor || []).length) { r++; g.put(r, 1, 'Labor: ' + a.labor.map(l => `${l.name || 'Task'} ${l.minutes ?? '?'} min × ${l.people ?? 1}${costs && l.rate != null ? ` @ $${l.rate}/h` : ''}`).join('; ')); }
        r += 3;
      }

      // right: production totals (raw ingredients, scaled to the Scale up quantity)
      let pr = blockTop;
      g.put(pr, 10, 'Main Component Totals (per portion)', st(null, { bold: true })); g.put(pr, 12, 'Production', st(null, { bold: true })); pr++;
      ['Ingredient order Totals', 'Quantity (g) for 1 portion', '% of Total', 'Scale up: G', 'Kg', 'Lbs'].forEach((h, k) => g.put(pr, 10 + k, h, st(k >= 3 ? PEACH : GREY, { bold: true, box: true }))); pr++;
      const flat = NL.flatten(S, calc, top), raw = flat.reduce((t, [, x]) => t + x, 0) || 1;
      for (const [iid, x] of flat) {
        used_ings.set(iid, true);
        g.put(pr, 10, NL.ingMap[iid]?.name || iid, st(null, { box: true })); g.put(pr, 11, r2(x), st(null, { fmt: G2, box: true })); g.put(pr, 12, x / raw, st(null, { fmt: PCT, box: true }));
        g.put(pr, 13, r2(x * F), st(PEACH, { fmt: G2, box: true })); g.put(pr, 14, +(x * F / 1000).toFixed(3), st(PEACH, { fmt: '0.000', box: true })); g.put(pr, 15, +(x * F / 453.59237).toFixed(3), st(PEACH, { fmt: '0.000', box: true }));
        pr++;
      }
      g.put(pr, 10, 'Total', st(null, { bold: true, box: true })); g.put(pr, 11, r2(raw), st(null, { bold: true, fmt: G2, box: true })); g.put(pr, 12, 1, st(null, { fmt: PCT, box: true }));
      g.put(pr, 13, r2(raw * F), st(PEACH, { bold: true, fmt: G2, box: true })); g.put(pr, 14, +(raw * F / 1000).toFixed(3), st(PEACH, { bold: true, fmt: '0.000', box: true })); g.put(pr, 15, +(raw * F / 453.59237).toFixed(3), st(PEACH, { bold: true, fmt: '0.000', box: true }));

      X.utils.book_append_sheet(xb, g.sheet([4, 18, 30, 13, 10, 13, 12, 13, 10, 3, 30, 14, 11, 13, 11, 11]), sheetName(root.name));
    }

    // Item & cost sheet: every ingredient in the recipe, with the template's columns
    if (costs) {
      const g = grid();
      ['Ingredient no.', 'Ingredient', 'Cost per KG', 'Cost per G', 'Cost per lbs', 'Brand', 'Suplier', 'MOQ', 'Suply code if provided'].forEach((h, k) => g.put(0, k, h, st(GREY, { bold: true, box: true })));
      [...used_ings.keys()].map(iid => NL.ingMap[iid] ? NL.ingMap[iid] : { id: iid, name: iid }).sort((a, b) => a.name.localeCompare(b.name)).forEach((ing, k) => {
        const p = NL.price(ing.id), row = k + 1;
        g.put(row, 0, k + 1, st(null, { box: true })); g.put(row, 1, ing.name, st(GREEN, { box: true }));
        g.put(row, 2, p, st(GREEN, { fmt: USD, box: true })); g.put(row, 3, p == null ? null : p / 1000, st(ORANGE, { fmt: USD5, box: true })); g.put(row, 4, p == null ? null : p * 0.45359237, st(ORANGE, { fmt: USD, box: true }));
        g.put(row, 5, '', st(null, { box: true })); g.put(row, 6, ing.vendor || '', st(null, { box: true })); g.put(row, 7, '', st(null, { box: true })); g.put(row, 8, '', st(null, { box: true }));
      });
      X.utils.book_append_sheet(xb, g.sheet([14, 34, 12, 12, 12, 16, 22, 8, 20]), sheetName('Item & cost sheet'));
    }

    // Nutrition (extra; the template has none)
    {
      const g = grid(), rc = hasFinal() ? calc[S.root] : null, others = Object.keys(S.asm).filter(id => id !== S.root);
      g.put(0, 0, 'Nutrition', st(null, { bold: true, size: 13 })); g.put(1, 0, 'Values from the ingredient library.');
      const head = ['Nutrient', ...(rc ? [A(S.root).name + ': per portion (' + r2(rc.yielded) + ' g)', '% Daily Value', A(S.root).name + ': per 100 g'] : []), ...others.map(id => A(id).name + ': per 100 g')];
      head.forEach((h, k) => g.put(3, k, h, st(GREY, { bold: true, box: true, wrap: true })));
      NL.NUTRIENTS.forEach((n, k) => {
        const d = n.unit === 'mg' || !n.unit ? 0 : 1, rd = v => +(+v).toFixed(d), row = 4 + k; let col = 0;
        g.put(row, col++, n.label + ' (' + (n.unit || 'kcal') + ')', st(null, { box: true }));
        if (rc) { g.put(row, col++, rd(rc.perG[k] * rc.yielded), st(null, { box: true })); g.put(row, col++, n.dv ? Math.round(rc.perG[k] * rc.yielded / n.dv * 100) / 100 : null, st(null, { fmt: '0%', box: true })); g.put(row, col++, rd(rc.perG[k] * 100), st(null, { box: true })); }
        for (const id of others) g.put(row, col++, rd(calc[id].perG[k] * 100), st(null, { box: true }));
      });
      if (rc) { g.put(5 + NL.NUTRIENTS.length, 0, 'Ingredients (largest first)', st(null, { bold: true })); g.put(6 + NL.NUTRIENTS.length, 0, NL.flatten(S, calc, S.root).map(([iid]) => NL.ingMap[iid]?.name || iid).join(', ')); }
      X.utils.book_append_sheet(xb, g.sheet([26, 24, 12, 22, ...others.map(() => 22)]), sheetName('Nutrition'));
    }

    const title = hasFinal() ? A(S.root).name : (S.draftName || 'Untitled assembly');
    const file = `${title.replace(/[\/:*?"<>|]/g, ' ').trim() || 'Recipe'} - Company template - ${today}${costs ? '' : ' (no costs)'}.xlsx`;
    X.writeFile(xb, file);
    NL.toast('Exported ' + file);
  }
  async function exportXlsx({ costs, layout = 'detailed', qty = 1 }) {
    let X; try { X = await loadXlsx(); } catch { return NL.toast('Could not load the Excel exporter. Check the internet connection and try again'); }
    calc = NL.calc(S); cost = NL.cost(S, calc); computeFlows(); computeBans();
    if (layout === 'template') return exportTemplate(X, costs);
    if (layout === 'card') return exportCard(X);
    if (layout === 'production') return exportProduction(X, qty);
    if (layout === 'costing') return exportCosting(X);
    if (layout === 'spec') return exportSpec(X);
    const u = NL.unitMode !== 'auto' ? NL.unitMode : NL.SYS_UNITS[NL.unitSys][0], pu = NL.pUnit();
    const W = g => g == null || g === '' ? null : +((+g) / NL.UNITS[u]).toFixed(u === 'g' ? 2 : 4);   // weight in the export unit
    const $v = v => v == null || !isFinite(v) ? null : Math.round(v * 10000) / 10000;                 // money, kept precise for small amounts
    const pct = (a, b) => b > 0 ? +(a / b * 100).toFixed(2) : null;
    const plainPin = p => p.mode === 'portion' ? `${+(+p.count).toFixed(2)} × ${W(p.size)} ${u}` : p.mode === 'base' ? `Base ${W(p.target)} ${u}` : `Yield ${W(p.target)} ${u}`;
    const wb = X.utils.book_new(), used = new Set();
    const sheetName = n => { const b = String(n).replace(/[\\/?*[\]:]/g, ' ').trim().slice(0, 28) || 'Sheet'; let name = b, k = 2; while (used.has(name.toLowerCase())) name = `${b.slice(0, 25)} ${k++}`; used.add(name.toLowerCase()); return name; };
    const add = (name, rows, widths) => { const ws = X.utils.aoa_to_sheet(rows); ws['!cols'] = widths.map(w => ({ wch: w })); X.utils.book_append_sheet(wb, ws, sheetName(name)); };
    const title = hasFinal() ? A(S.root).name : (S.draftName || 'Untitled assembly');
    const order = sheetOrder(), today = new Date().toISOString().slice(0, 10);
    const cardCost = id => { const a = A(id); return cost[id].batch + (a.packaging || []).reduce((t, r) => t + (+r.cost || 0), 0) + laborOf(a); };
    const ingName = it => { const sid = subIdOf(it.ref); return sid ? (A(sid)?.name || '(missing)') + ' (sub-assembly)' : NL.ingMap[it.ref.slice(4)]?.name || it.ref; };

    // Summary
    const sum = [[title], ['Exported', today], ['Weights in', NL.UNIT_NAMES[u]]];
    if (costs) sum.push(['Prices', '$ per ' + pu]);
    if (hasFinal()) {
      const rc = calc[S.root];
      sum.push([], ['Final assembly', title], [`Portion weight (${u})`, W(rc.yielded)], ['kcal per portion', Math.round(rc.perG[0] * rc.yielded)]);
      if (costs) sum.push(['Cost per portion ($)', $v(cardCost(S.root))]);
      const fp = A(S.root).scalePins || [];
      if (fp.length) sum.push([], ['Pinned scalings on the Final card'], ...fp.map(p => [plainPin(p)]));
    }
    sum.push([], ['Cards'], ['Card', 'Type', `Batch (${u})`, `Yield (${u})`, 'Cooking loss %', 'kcal / 100 g', ...(costs ? [`Cost per ${pu} ($)`] : [])]);
    for (const id of order) {
      const a = A(id), c = calc[id];
      sum.push([a.name, id === S.root ? 'Final' : 'Sub-assembly', W(c.batch), W(c.yielded), +(+a.yieldLoss || 0), Math.round(c.perG[0] * 100), ...(costs ? [$v(NL.pOut(cost[id].perG * 1000))] : [])]);
    }
    add('Summary', sum, [34, 16, 14, 14, 14, 12, 14]);

    // one sheet per card
    for (const id of order) {
      const a = A(id), c = calc[id], isRoot = id === S.root, base = baseTotal(a);
      const pins = (a.scalePins || []).map(p => ({ label: 'Pinned: ' + plainPin(p), f: pinFactor(p, c, base) }));
      const flows = isRoot ? [] : finFlows.filter(fl => fl.need[id] > 0 && c.yielded > 0).map(fl => ({ label: 'From Final: ' + plainPin(fl.p), f: fl.need[id] / c.yielded }));
      const cols = [...pins, ...flows];
      const rows = [[a.name], ['Type', isRoot ? 'Final assembly (per portion)' : 'Sub-assembly'], [`Batch (${u})`, W(c.batch)], [`Yield (${u})`, W(c.yielded)], ['Cooking loss %', +(+a.yieldLoss || 0)], [isRoot ? 'kcal per portion' : 'kcal / 100 g', Math.round(c.perG[0] * (isRoot ? c.yielded : 100))]];
      if (costs) rows.push(isRoot ? ['Cost per portion ($)', $v(cardCost(id))] : [`Cost per ${pu} ($)`, $v(NL.pOut(cost[id].perG * 1000))]);
      rows.push([], ['Ingredient', 'Vendor', `Weight (${u})`, 'Relative %', 'Baker %', ...(costs ? ['Cost ($)'] : []), ...cols.map(x => `${x.label} (${u})`)]);
      for (const it of a.items) {
        const amt = +it.amount || 0, sid = subIdOf(it.ref);
        rows.push([ingName(it), sid ? '' : NL.ingMap[it.ref.slice(4)]?.vendor || '', W(amt), pct(amt, c.batch), base > 0 ? pct(amt, base) : null, ...(costs ? [$v(rowCost(it)?.v)] : []), ...cols.map(x => W(amt * x.f))]);
      }
      for (const r of a.packaging || []) rows.push(['Packaging: ' + (r.name || ''), '', W(r.weight), null, null, ...(costs ? [$v(r.cost)] : []), ...cols.map(x => r.weight == null ? null : W(r.weight * x.f))]);
      rows.push(['Total', '', W(c.batch), c.batch > 0 ? 100 : null, base > 0 ? pct(c.batch, base) : null, ...(costs ? [$v(cardCost(id))] : []), ...cols.map(x => W(c.batch * x.f))]);
      if (costs && cols.length) rows.push(['Cost of each column ($)', '', null, null, null, null, ...cols.map(x => $v(cardCost(id) * x.f))]);
      if ((a.labor || []).length) {
        rows.push([], ['Labor', 'Minutes', 'People', ...(costs ? ['Rate ($ / h)', 'Cost ($)'] : [])]);
        for (const r of a.labor) rows.push([r.name || '', r.minutes ?? null, r.people ?? 1, ...(costs ? [r.rate ?? null, $v(laborCost(r))] : [])]);
      }
      const steps = (a.steps || []).filter(t => String(t).trim());
      if (steps.length) rows.push([], ['Procedure'], ...steps.map((t, k) => [k + 1 + '. ' + t]));
      if ((a.notes || '').trim()) rows.push([], ['Notes'], [a.notes]);
      add(a.name, rows, [34, 18, 12, 11, 10, ...(costs ? [11] : []), ...cols.map(() => 22)]);
    }

    // Bill of materials: the Final flattened to raw ingredients and packaging, per portion and per pinned column
    if (hasFinal()) {
      const root = A(S.root), rc = calc[S.root], fp = root.scalePins || [], ff = fp.map(p => pinFactor(p, rc, baseTotal(root)));
      const flat = NL.flatten(S, calc, S.root), raw = flat.reduce((t, [, g]) => t + g, 0) || 1;
      const rows = [['Bill of materials: ' + title], ['Raw ingredients and packaging for one portion' + (fp.length ? ', and for each pinned scaling on the Final card' : '')], ['Raw weights are before cooking, so they add up to more than the finished portion when a sub-assembly loses weight.'], [],
        ['Item', 'Vendor', `Per portion (${u})`, '% of raw weight', ...(costs ? ['Cost per portion ($)'] : []), ...fp.map(p => `${plainPin(p)} (${u})`), ...(costs ? fp.map(p => `${plainPin(p)} cost ($)`) : [])]];
      let tg = 0, tc = 0;
      for (const [iid, g] of flat) {
        const ing = NL.ingMap[iid], pr = NL.price(iid), cg = pr == null ? null : g / 1000 * pr;
        tg += g; tc += cg || 0;
        rows.push([ing?.name || iid, ing?.vendor || '', W(g), pct(g, raw), ...(costs ? [$v(cg)] : []), ...ff.map(f => W(g * f)), ...(costs ? ff.map(f => cg == null ? null : $v(cg * f)) : [])]);
      }
      // packaging and labor of every card, in the share one portion uses
      const share = { [S.root]: 1 };
      (function walk(id, f) { for (const it of A(id).items) { const sid = subIdOf(it.ref); if (!sid || !A(sid) || !(calc[sid].yielded > 0)) continue; const g = (+it.amount || 0) * f, sf = g / calc[sid].yielded; share[sid] = (share[sid] || 0) + sf; walk(sid, sf); } })(S.root, 1);
      for (const [id, sf] of Object.entries(share)) for (const r of A(id).packaging || []) {
        const cg = r.cost == null ? null : r.cost * sf; tc += cg || 0;
        rows.push(['Packaging: ' + (r.name || '') + (id === S.root ? '' : ` (${A(id).name})`), '', r.weight == null ? null : W(r.weight * sf), null, ...(costs ? [$v(cg)] : []), ...ff.map(f => r.weight == null ? null : W(r.weight * sf * f)), ...(costs ? ff.map(f => cg == null ? null : $v(cg * f)) : [])]);
      }
      if (costs) {
        let lc = 0; for (const [id, sf] of Object.entries(share)) lc += laborOf(A(id)) * sf;
        if (lc > 0) { tc += lc; rows.push(['Labor (all cards)', '', null, null, $v(lc), ...ff.map(() => null), ...ff.map(f => $v(lc * f))]); }
      }
      rows.push(['Total (weight = ingredients only)', '', W(tg), pct(tg, raw), ...(costs ? [$v(tc)] : []), ...ff.map(f => W(tg * f)), ...(costs ? ff.map(f => $v(tc * f)) : [])]);
      if (flat.some(([iid]) => NL.price(iid) == null) && costs) rows.push([], ['Some ingredients have no price yet, so costs are a minimum']);
      add('Bill of materials', rows, [36, 18, 16, 12, ...(costs ? [16] : []), ...fp.map(() => 20), ...(costs ? fp.map(() => 18) : [])]);
    }

    // Nutrition: Final per portion and per 100 g, every card per 100 g, ingredient statement
    {
      const nut = NL.NUTRIENTS, rc = hasFinal() ? calc[S.root] : null;
      const head = ['Nutrient', ...(rc ? [`${title}: per portion (${+rc.yielded.toFixed(1)} g)`, '% Daily Value', `${title}: per 100 g`] : []), ...order.filter(id => id !== S.root).map(id => A(id).name + ': per 100 g')];
      const rows = [['Nutrition'], ['Values from the ingredient library. Nutrition stays in grams.'], [], head];
      nut.forEach((n, k) => {
        const unit = n.unit || 'kcal', d = n.unit === 'mg' || !n.unit ? 0 : 1, r = v => +(+v).toFixed(d);
        rows.push([`${n.label} (${unit})`, ...(rc ? [r(rc.perG[k] * rc.yielded), n.dv ? Math.round(rc.perG[k] * rc.yielded / n.dv * 100) + '%' : '', r(rc.perG[k] * 100)] : []), ...order.filter(id => id !== S.root).map(id => r(calc[id].perG[k] * 100))]);
      });
      if (rc) rows.push([], ['Ingredients (largest first)'], [NL.flatten(S, calc, S.root).map(([iid]) => NL.ingMap[iid]?.name || iid).join(', ')]);
      add('Nutrition', rows, [26, 26, 14, 22, ...order.map(() => 22)]);
    }

    const file = `${title.replace(/[\\/:*?"<>|]/g, ' ').trim() || 'Recipe'} - ${today}${costs ? '' : ' (no costs)'}.xlsx`;
    X.writeFile(wb, file);
    NL.toast('Exported ' + file);
  }
  $('#exportBtn').onclick = exportDialog;

  // ---------- ⬆ Import from Excel (rule-based, no AI) ----------
  // Reads recipe blocks laid out like the team's workbook (and this app's own exports): a header row with
  // "Ingredient" (+ "Quantity"), the name from a "Recipe" label above it (or the sheet name), rows until "Total",
  // then "Yield %", "Procedure:" and "Notes:". A row naming another block on the sheet becomes a sub-assembly;
  // the block nothing else uses becomes the Final. Each sheet becomes a new tab. Ingredients are matched to the
  // library (same name, or a close match the chef confirms); the rest become new ingredients without nutrition.
  const normName = t => String(t ?? '').toLowerCase().replace(/\((sub-assembly|see its card|from step above|wip)\)/g, ' ').replace(/[^a-z0-9]+/g, ' ').trim();
  function readWorkbook(X, xbook) {
    const sheets = [], prices = new Map();
    for (const sn of xbook.SheetNames) {
      const ws = xbook.Sheets[sn]; if (!ws || !ws['!ref']) continue;
      const rg = X.utils.decode_range(ws['!ref']);
      const val = (r, c) => { const cell = ws[X.utils.encode_cell({ r, c })]; return cell && cell.t !== 'e' ? cell.v : undefined; }; // skip Excel errors (#DIV/0!, #REF!)
      const txt = (r, c) => { const v = val(r, c); return v == null ? '' : String(v).trim(); };
      const blocks = [];
      for (let r = rg.s.r; r <= rg.e.r; r++) {
        let ic = -1; for (let c = rg.s.c; c <= rg.e.c; c++) if (/^ingredients?$/i.test(txt(r, c))) { ic = c; break; }
        if (ic < 0) continue;
        let qc = -1; for (let c = ic + 1; c <= rg.e.c; c++) if (/quantity|qty|amount|weight|grams|\(g\)/i.test(txt(r, c))) { qc = c; break; }
        // a price list (like "Item & cost sheet"): Ingredient + Cost per KG or per lbs, and no Quantity column
        const head = c => txt(r, c);
        let pk = -1, pg = -1, pl = -1;
        for (let c = rg.s.c; c <= rg.e.c; c++) { const h = head(c); if (/(cost|price).*(kg|kilo)/i.test(h)) pk = c; else if (/(cost|price).*\b(g|gram)s?\b/i.test(h)) pg = c; else if (/(cost|price).*(lb|pound)/i.test(h)) pl = c; }
        if (qc < 0 && (pk >= 0 || pl >= 0)) {
          for (let k = r + 1; k <= rg.e.r; k++) {
            const nm = txt(k, ic); if (!nm) continue;
            const num = c => { const v = val(k, c); return typeof v === 'number' && v > 0 ? v : null; };
            const perKg = pk >= 0 && num(pk) ? num(pk) : pg >= 0 && num(pg) ? num(pg) * 1000 : pl >= 0 && num(pl) ? num(pl) / 0.45359237 : null;
            if (perKg) prices.set(normName(nm), perKg);
          }
          break;
        }
        // the recipe name: a "Recipe" label up to 3 rows above -> text to its right, or the cell under it
        let name = '';
        for (let up = 1; up <= 3 && !name; up++) for (let c = rg.s.c; c <= rg.e.c; c++) if (/^recipe$/i.test(txt(r - up, c))) { for (let c2 = c + 1; c2 <= c + 4 && !name; c2++) name = txt(r - up, c2); if (!name) name = txt(r - up + 1, c); break; }
        const items = []; let k = r + 1, gap = 0;
        for (; k <= rg.e.r; k++) {
          const nm = txt(k, ic), grp = ic > rg.s.c ? txt(k, ic - 1) : '';
          if (/^total\b/i.test(nm) || /^(output|yield|after cook)/i.test(nm) || /^recipe$/i.test(nm) || /^recipe$/i.test(grp)) break;
          if (!nm) { if (++gap >= 3) break; continue; }
          gap = 0;
          if (/^pkg$/i.test(grp) || /^(packaging|labor)\b/i.test(nm)) continue; // packaging / labor rows are not ingredients
          const q = qc >= 0 ? val(k, qc) : undefined;
          items.push({ name: nm, g: typeof q === 'number' && isFinite(q) && q > 0 ? q : 0 });
        }
        // after the total: yield %, procedure, notes (until the next recipe)
        let yieldPct = null, steps = [], notes = '';
        scan: for (let j = k; j <= Math.min(rg.e.r, k + 8); j++) for (let c = rg.s.c; c <= rg.e.c; c++) {
          const t = txt(j, c);
          if (/^recipe$/i.test(t)) break scan;
          if (/^yield\s*%/i.test(t) && yieldPct == null) { for (let c2 = c + 1; c2 <= rg.e.c; c2++) { const v = val(j, c2); if (typeof v === 'number' && v > 0) { yieldPct = v <= 1.5 ? v * 100 : v; break; } } }
          else if (/^procedure\s*:/i.test(t)) steps = t.replace(/^procedure\s*:\s*/i, '').split(/\s*\d+[.)]\s+/).map(x => x.trim()).filter(Boolean);
          else if (/^notes?\s*:/i.test(t)) notes = t.replace(/^notes?\s*:\s*/i, '').trim();
        }
        if (items.length) blocks.push({ name, items, yieldPct, steps, notes });
        r = k;
      }
      if (blocks.length) sheets.push({ sheet: sn, blocks });
    }
    return { sheets, prices };
  }
  async function importFile(file) {
    let X; try { X = await loadXlsx(); } catch { return NL.toast('Could not load the Excel reader. Check the internet connection and try again'); }
    let xbook; try { xbook = X.read(await file.arrayBuffer()); } catch { return NL.toast('Could not read that file. Use an .xlsx, .xls or .csv file'); }
    const { sheets, prices } = readWorkbook(X, xbook);
    if (!sheets.length) return NL.toast('No recipes found. The importer looks for a header row with "Ingredient" (and "Quantity")');
    // every name used, minus the ones that are other recipes on the same sheet
    const recipeNames = sh => new Set(sh.blocks.map(b => normName(b.name)).filter(Boolean));
    const isRecipe = (sh, nm) => { const n = normName(nm), set = recipeNames(sh), wip = n.match(/\bwip (\d+)\b/); return set.has(n) || [...set].some(b => n.startsWith(b + ' ') || (wip && new RegExp('\\bwip ' + wip[1] + '\\b').test(b))); };
    const names = new Map();
    for (const sh of sheets) for (const b of sh.blocks) for (const it of b.items) if (!isRecipe(sh, it.name) && !names.has(normName(it.name))) names.set(normName(it.name), { name: it.name, ...NL.matchName(it.name) });
    const ORDER = { new: 0, close: 1, remembered: 2, same: 3 };
    const list = [...names.values()].sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.name.localeCompare(b.name));
    const cnt = k => list.filter(x => x.kind === k).length, priced = list.filter(x => prices.has(normName(x.name))).length;
    const ov = document.createElement('div'); ov.className = 'nl-prompt-ov';
    ov.innerHTML = `<form class="nl-prompt nif im-box">
      <div class="nl-prompt-label">Import from Excel <small>${NL.esc(file.name)}</small></div>
      <div class="xp-sub">Each sheet becomes a new tab. Recipes used inside another recipe become sub-assemblies. Check the matches below, then import.</div>
      <div class="im-sheets">${sheets.map((sh, i) => `<label><input type="checkbox" name="sh" value="${i}" checked> <b>${NL.esc(sh.sheet)}</b> <span>${sh.blocks.length} recipe${sh.blocks.length === 1 ? '' : 's'}: ${NL.esc(sh.blocks.map(b => b.name || '(no name)').join(', '))}</span></label>`).join('')}</div>
      <div class="im-stats"><span class="im-same">✓ ${cnt('same') + cnt('remembered')} matched${cnt('remembered') ? ` (${cnt('remembered')} remembered)` : ''}</span><span class="im-close">≈ ${cnt('close')} close match</span><span class="im-new">＋ ${cnt('new')} new</span></div>
      <div class="xp-sub">The box shows the library ingredient each name will use. Type to change it, or clear it to add a new ingredient. Your choices are remembered on this computer for the next import.</div>
      <div class="im-list">${list.map((x, i) => `<div class="im-row im-${x.kind}"><span class="im-nm">${NL.esc(x.name)}</span><span class="im-pick"><span class="im-ic">${{ same: '✓', remembered: '↺', close: '≈', new: '＋' }[x.kind]}</span><input class="im-in" name="m${i}" list="imLib" value="${x.ing ? NL.esc(x.ing.name) : ''}" placeholder="new ingredient (no nutrition yet)" title="${x.kind === 'remembered' ? 'Remembered from an earlier import' : x.kind === 'close' ? 'Close match: check it' : x.kind === 'same' ? 'Same name in the library' : 'Not in the library: a new ingredient will be added'}">${x.hint ? `<button type="button" class="im-hint" data-hint="${i}" data-name="${NL.esc(x.hint.name)}">Use ${NL.esc(x.hint.name)}?</button>` : ''}</span></div>`).join('')}</div>
      <datalist id="imLib">${NL.INGREDIENTS.map(g => `<option value="${NL.esc(g.name)}">`).join('')}</datalist>
      ${priced ? `<label class="xp-chk"><input type="checkbox" name="prices" checked> Use prices from the file's price list <small>(${priced} found)</small></label>` : ''}
      <div class="nl-prompt-btns"><button type="submit" class="btn primary">⬆ Import</button><button type="button" class="btn ghost nl-prompt-cancel">Cancel</button></div>
    </form>`;
    document.body.appendChild(ov);
    const f = ov.querySelector('form'), close = () => ov.remove();
    ov.querySelector('.nl-prompt-cancel').onclick = close;
    ov.addEventListener('pointerdown', e => { if (e.target === ov) close(); });
    ov.addEventListener('keydown', e => { if (e.key === 'Escape') close(); });
    f.addEventListener('click', e => { const b = e.target.closest('[data-hint]'); if (!b) return; f.elements['m' + b.dataset.hint].value = b.dataset.name; b.remove(); });
    f.onsubmit = e => {
      e.preventDefault();
      const pick = [...f.querySelectorAll('[name=sh]:checked')].map(x => sheets[+x.value]);
      if (!pick.length) return NL.toast('Tick at least one sheet');
      const usePrices = !!f.elements.prices?.checked, byName = new Map(NL.INGREDIENTS.map(g => [NL.matchKey(g.name), g]));
      // resolve every name to a library id (creating new ingredients once)
      const idOf = new Map();
      list.forEach((x, i) => {
        // the box: a library name → that ingredient; empty → a new ingredient with the file's name; other text → a new ingredient with that name
        const typed = (f.elements['m' + i]?.value || '').trim();
        let ing = typed ? byName.get(NL.matchKey(typed)) : null;
        if (!ing) { ing = NL.addIngredient({ id: NL.uid('c'), name: typed || x.name.trim(), cat: NL.CUSTOM_CAT, vendor: null, n: NL.NUTRIENTS.map(() => 0), custom: true, price: null }); byName.set(NL.matchKey(ing.name), ing); }
        if (x.kind !== 'same' || ing !== x.ing) NL.rememberAlias(x.name, ing.id); // next import of this name needs no review
        idOf.set(normName(x.name), ing.id);
        const p = prices.get(normName(x.name)); if (usePrices && p) NL.setPrice(ing.id, p);
      });
      close();
      let n = 0;
      for (const sh of pick) {
        const ids = sh.blocks.map(() => NL.uid('a')), byName = new Map(), used = new Set(), asm = {};
        sh.blocks.forEach((b, i) => { const k = normName(b.name); if (k && !byName.has(k)) byName.set(k, i); });
        sh.blocks.forEach((b, i) => {
          const items = b.items.map(it => {
            const nn = normName(it.name); let j = byName.get(nn);
            if (j == null) for (const [bn, bi] of byName) if (bn && nn.startsWith(bn + ' ')) { j = bi; break; }
            // the team's numbering: "WIP 2, cooked chicken" is the recipe whose name carries "WIP 2"
            const wip = nn.match(/\bwip (\d+)\b/);
            if (j == null && wip) for (const [bn, bi] of byName) if (bi !== i && new RegExp('\\bwip ' + wip[1] + '\\b').test(bn)) { j = bi; break; }
            if (j != null && j !== i) { used.add(j); return { ref: 'asm:' + ids[j], amount: it.g }; }
            return { ref: 'ing:' + idOf.get(nn), amount: it.g };
          }).filter(it => !it.ref.endsWith(':undefined'));
          asm[ids[i]] = { name: b.name || sh.sheet + ' ' + (i + 1), items, yieldLoss: b.yieldPct != null ? +Math.max(0, Math.min(99.99, 100 - b.yieldPct)).toFixed(2) : 0, steps: b.steps, notes: b.notes };
        });
        const tops = ids.filter((_, i) => !used.has(i));
        wb.add({ root: tops[tops.length - 1] || null, asm, _arrange: true, draftName: sh.sheet }, sh.sheet);
        n++;
      }
      NL.toast(`Imported ${n} sheet${n === 1 ? '' : 's'} into new tab${n === 1 ? '' : 's'}. New ingredients have no nutrition yet: add it from the ingredient list`);
    };
  }
  { const inp = $('#importFile'); $('#importBtn').onclick = () => { useSide('left'); clearTimeout(typingT); commit(); loadXlsx().catch(() => { }); inp.value = ''; inp.click(); }; inp.onchange = () => { if (inp.files[0]) importFile(inp.files[0]); }; }
  // ⚙ Settings drawer: open / close (Esc closes too)
  { const box = $('#settings'), btn = $('#settingsBtn'); let snap = null;
    const show = on => { box.hidden = !on; btn.classList.toggle('on', on); };
    const open = () => { snap = settingsReg.map(r => r.get()); show(true); };
    const cancel = () => { if (snap) settingsReg.forEach((r, i) => { if (JSON.stringify(r.get()) !== JSON.stringify(snap[i])) r.set(snap[i]); }); snap = null; show(false); };
    const save = () => { snap = null; show(false); NL.toast('Settings saved'); };
    btn.onclick = () => box.hidden ? open() : cancel();
    $('#settingsClose').onclick = cancel;
    $('#settingsCancel').onclick = cancel;
    $('#settingsSave').onclick = save;
    document.addEventListener('keydown', e => { if (e.key === 'Escape' && !box.hidden && !document.querySelector('.nl-prompt-ov, .nl-prompt')) cancel(); });
  }
  $('#retailAdd').onclick = () => NL.prompt('Retailer name (e.g. Aldi)', '').then(v => {
    const name = (v || '').trim(); if (!name) return;
    const list = readRetail(), r = { id: NL.uid('r'), name, bans: [] };
    list.push(r); saveRetail(list); retailOpen.add(r.id); render();
    $(`#retailList [data-rtadd="${r.id}"]`)?.focus();
  });
  $('#retailList').addEventListener('click', e => {
    const b = e.target.closest('[data-rtopen],[data-rtdel],[data-rtban]'); if (!b) return;
    const list = readRetail(), d = b.dataset;
    if (d.rtopen) { retailOpen.has(d.rtopen) ? retailOpen.delete(d.rtopen) : retailOpen.add(d.rtopen); return drawRetail(); }
    if (d.rtdel) { const r = list.find(x => x.id === d.rtdel); if (!r || !confirm(`Remove the retailer "${r.name}" and its list?`)) return; saveRetail(list.filter(x => x !== r)); return render(); }
    const [rid, k] = d.rtban.split(':'), r = list.find(x => x.id === rid); if (!r) return;
    r.bans.splice(+k, 1); saveRetail(list); render();
  });
  $('#retailList').addEventListener('change', e => {
    const id = e.target.dataset?.rton; if (!id) return;
    const off = new Set(S.retailOff || []); e.target.checked ? off.delete(id) : off.add(id);
    if (off.size) S.retailOff = [...off]; else delete S.retailOff;
    render(); commit();
  });
  $('#retailList').addEventListener('keydown', e => {
    const id = e.target.dataset?.rtadd; if (!id || e.key !== 'Enter') return;
    e.preventDefault();
    addBans(id, splitItems(e.target.value));
  });
  // paste a whole list: one per line, or comma / semicolon separated on one line; bullets and numbers are dropped
  $('#retailList').addEventListener('paste', e => {
    const id = e.target.dataset?.rtadd; if (!id) return;
    const txt = e.clipboardData?.getData('text') || '';
    const parts = splitItems(txt);
    if (parts.length < 2) return; // a single item: paste into the box as usual
    e.preventDefault();
    addBans(id, parts);
  });
  function addBans(id, items) {
    const list = readRetail(), r = list.find(x => x.id === id); if (!r) return;
    let n = 0;
    for (const t of items.map(x => x.trim()).filter(Boolean)) if (!r.bans.some(b => b.toLowerCase() === t.toLowerCase())) { r.bans.push(t); n++; }
    saveRetail(list); render();
    $(`#retailList [data-rtadd="${id}"]`)?.focus();
    if (items.length > 1) NL.toast(`Added ${n} to ${r.name}${items.length - n ? ` (${items.length - n} already listed)` : ''}`);
  }
  addEventListener('storage', e => { if (e.key === RETAIL) render(); });
  function drawFavs() {
    const list = readFavs();
    $('#favList').innerHTML = list.length ? list.map(f => {
      const t = f.cards[f.top], nIng = t.items.filter(it => it.ref.startsWith('ing:')).length, nSub = Object.keys(f.cards).length - 1;
      return `<div class="fav-item" draggable="true" data-favdrag="${f.id}" title="Drag onto a card to add it as a sub-assembly, or click ＋ to add it as a new card">
        <span class="fav-star">★</span><span class="nm">${NL.esc(f.name)}</span><span class="faint">${nIng} ing${nSub ? ` · ${nSub} sub` : ''}</span>
        <button class="fav-b" data-favadd="${f.id}" title="Add to this assembly as a new card">＋</button><button class="fav-b x" data-favdel="${f.id}" title="Remove from favorites">×</button></div>`;
    }).join('') : '<div class="fav-empty">Click ☆ on any card to save it here, then reuse it in any assembly.</div>';
  }
  $('#favList').addEventListener('dragstart', e => { const it = e.target.closest('[data-favdrag]'); if (it) { e.dataTransfer.setData('text/plain', 'fav:' + it.dataset.favdrag); e.dataTransfer.effectAllowed = 'copy'; } });
  addEventListener('storage', e => { if (e.key === FAV) { favCache = null; drawFavs(); render(); } });

  // ---------- variations: try changes on one card without losing the original; one variation is "in use" ----------
  // a.vars = { on: <id in use>, list: [{ id, name, note, at, data? }] }. The card's own fields always hold the variation
  // in use, so calc, cost, scaling, labels, links and the sheet read it exactly as before. The other variations keep a copy
  // of VAR_FIELDS in `data`. Name, color, position, scaling columns and favorites stay with the card, not the variation.
  const VAR_FIELDS = ['items', 'yieldLoss', 'steps', 'notes', 'packaging', 'labor', 'baseName'];
  const clone = x => JSON.parse(JSON.stringify(x));
  const pickVar = a => Object.fromEntries(VAR_FIELDS.filter(f => a[f] !== undefined).map(f => [f, clone(a[f])]));
  const varsOf = a => (a?.vars?.list?.length > 1 ? a.vars : null);
  const varInUse = a => a?.vars?.list?.find(v => v.id === a.vars.on) || null;
  const varData = (id, v) => (v.id === A(id).vars.on ? pickVar(A(id)) : v.data);
  // a variation's rows, minus links that no longer work here (card deleted, or the link would loop back)
  const cleanItems = (id, items, asm = S.asm) => (items || []).filter(it => { const s = subIdOf(it.ref); return !s || (asm[s] && !wouldCycle(id, s)); });
  function ensureVars(a) {
    if (!a.vars?.list?.length) a.vars = { on: 'v1', list: [{ id: 'v1', name: 'Original', note: '', at: Date.now() }] };
    return a.vars;
  }
  // a small two-field form (name + note), styled like NL.prompt
  function varForm(title, name = '', note = '') {
    return new Promise(resolve => {
      const ov = document.createElement('div'); ov.className = 'nl-prompt-ov';
      ov.innerHTML = `<form class="nl-prompt var-form"><div class="nl-prompt-label">${NL.esc(title)}</div>
        <label>Name<input class="nl-prompt-input" name="n" value="${NL.esc(name)}" maxlength="60" placeholder="e.g. Less salt"></label>
        <label>Note <small>what changed, how it tasted</small><textarea class="nl-prompt-input" name="t" rows="3" maxlength="500" placeholder="e.g. Soy sauce 20 g → 12 g. Tasted better, less harsh.">${NL.esc(note)}</textarea></label>
        <div class="nl-prompt-btns"><button class="btn primary">Save</button><button type="button" class="btn ghost" data-x>Cancel</button></div></form>`;
      document.body.appendChild(ov);
      const f = ov.querySelector('form'), done = v => { ov.remove(); resolve(v); };
      f.n.focus(); f.n.select();
      f.onsubmit = e => { e.preventDefault(); done({ name: f.n.value.trim() || name || 'Untitled', note: f.t.value.trim() }); };
      ov.querySelector('[data-x]').onclick = () => done(null);
      ov.addEventListener('pointerdown', e => { if (e.target === ov) done(null); });
      ov.addEventListener('keydown', e => { if (e.key === 'Escape') done(null); if (e.key === 'Enter' && e.ctrlKey) f.requestSubmit(); });
    });
  }
  async function newVar(id) {
    if (onScaleSide(id)) return NL.toast('This card is showing its Scaling side. Press Building first');
    const a = A(id), vs = ensureVars(a), from = varInUse(a);
    const r = await varForm(`New variation of “${a.name}”, starting from “${from.name}”`, 'Variation ' + (vs.list.length + 1), '');
    if (!r) { if (vs.list.length < 2) delete a.vars; return; }
    from.data = pickVar(a); // keep the one we leave exactly as it is
    const v = { id: NL.uid('v'), name: r.name, note: r.note, at: Date.now() };
    vs.list.push(v); vs.on = v.id;
    render(); commit();
    NL.toast(`Now editing “${v.name}”. “${from.name}” is kept; switch back any time with the Variations button`);
  }
  function useVar(id, vid) {
    const a = A(id), vs = a.vars, to = vs?.list.find(v => v.id === vid);
    if (!to || vs.on === vid) return;
    if (onScaleSide(id)) return NL.toast('This card is showing its Scaling side. Press Building first');
    const from = varInUse(a); from.data = pickVar(a);
    const data = clone(to.data || {}), before = (data.items || []).length;
    data.items = cleanItems(id, data.items);
    VAR_FIELDS.forEach(f => { if (data[f] === undefined) delete a[f]; else a[f] = data[f]; });
    a.items = a.items || []; a.steps = a.steps || [];
    delete to.data; vs.on = vid;
    render(); commit();
    NL.toast(`Using “${to.name}” on ${a.name}${before > a.items.length ? `. ${before - a.items.length} link(s) to cards that are gone were left out` : ''}`);
  }
  async function editVar(id, vid) {
    const v = A(id).vars.list.find(x => x.id === vid); if (!v) return;
    const r = await varForm('Rename or add a note', v.name, v.note);
    if (!r) return;
    v.name = r.name; v.note = r.note; render(); commit();
  }
  function deleteVar(id, vid) {
    const a = A(id), v = a.vars.list.find(x => x.id === vid);
    if (!v || v.id === a.vars.on) return;
    if (!confirm(`Delete the variation “${v.name}”? Undo (Ctrl+Z) can bring it back.`)) return;
    a.vars.list = a.vars.list.filter(x => x.id !== vid);
    if (a.vars.list.length < 2) delete a.vars;
    render(); commit();
  }
  // numbers for one variation: this card, and what the Final ends up as with it in use
  function varStats(id, v) {
    const T = clone(S), t = T.asm[id];
    if (v.id !== t.vars.on) { const d = clone(v.data || {}); d.items = cleanItems(id, d.items); VAR_FIELDS.forEach(f => { if (d[f] === undefined) delete t[f]; else t[f] = d[f]; }); t.items = t.items || []; }
    const c = NL.calc(T), k = NL.cost(T, c), isRoot = id === T.root;
    const full = aid => k[aid] ? k[aid].batch + (T.asm[aid].packaging || []).reduce((s, r) => s + (+r.cost || 0), 0) + laborOf(T.asm[aid]) : null;
    const fin = T.root && T.asm[T.root] && c[T.root] ? { kcal: c[T.root].perG[0] * c[T.root].yielded, cost: full(T.root) } : null;
    return {
      batch: c[id].batch, yielded: c[id].yielded, loss: +t.yieldLoss || 0,
      kcal: isRoot ? c[id].perG[0] * c[id].yielded : c[id].perG[0] * 100,
      cost: isRoot ? full(id) : NL.pOut(k[id].perG * 1000), missing: k[id].missing, // per kg or per lb, like the card header
      fin: isRoot ? null : fin, isRoot, items: t.items, steps: t.steps || [], notes: t.notes || '',
    };
  }
  const when = t => new Date(t).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
  function varMenu(id, anchor) {
    document.querySelector('.var-menu')?.remove();
    const a = A(id), vs = ensureVars(a), one = vs.list.length < 2;
    const r = anchor.getBoundingClientRect(), m = document.createElement('div'); m.className = 'var-menu';
    const kU = id === S.root ? 'kcal / portion' : 'kcal / 100 g', cU = id === S.root ? '/ portion' : '/ ' + NL.pUnit();
    m.innerHTML = `<div class="var-head"><b>Variations</b> of ${NL.esc(a.name)}
        <div class="faint">Try changes on this card without losing what you had. The one in use feeds the totals, the label and scaling.</div></div>
      <div class="var-list">${vs.list.map(v => {
        const s = varStats(id, v), on = v.id === vs.on;
        return `<div class="var-row ${on ? 'on' : ''}" data-vuse="${id}:${v.id}" title="${on ? 'In use' : 'Click to use this variation'}">
          <span class="var-radio">${on ? '●' : '○'}</span>
          <div class="var-main"><div><b>${NL.esc(v.name)}</b>${on ? ' <span class="var-badge">in use</span>' : ''}</div>
            <div class="var-note">${v.note ? NL.esc(v.note) : '<i>No note</i>'}</div>
            <div class="var-meta">${Math.round(s.kcal)} ${kU} · ${NL.money(s.cost)}${s.missing ? '*' : ''} ${cU}${s.fin ? ` · <span title="${NL.esc(A(S.root).name)} with this variation in use">Final ${Math.round(s.fin.kcal)} kcal, ${NL.money(s.fin.cost)}</span>` : ''} · ${when(v.at)}</div></div>
          <button class="var-b" data-vedit="${id}:${v.id}" title="Rename or edit the note">✎</button>
          ${on ? '<span class="var-b"></span>' : `<button class="var-b x" data-vdel="${id}:${v.id}" title="Delete this variation">×</button>`}
        </div>`;
      }).join('')}</div>
      <div class="var-foot"><button class="btn primary sm" data-vnew="${id}">＋ New variation from “${NL.esc(varInUse(a).name)}”</button>
        ${one ? '' : `<button class="btn sm" data-vcmp="${id}">⇄ Compare</button>`}</div>`;
    if (one) delete a.vars; // only "Original" so far: nothing is saved until a second variation exists
    m.style.left = Math.max(8, Math.min(r.left, innerWidth - 440)) + 'px'; m.style.top = Math.min(r.bottom + 6, innerHeight - 120) + 'px';
    document.body.appendChild(m);
    const off = e => { if (!m.contains(e.target) && !e.target.closest('.nl-prompt-ov')) close(); };
    const close = () => { m.remove(); removeEventListener('pointerdown', off, true); };
    setTimeout(() => addEventListener('pointerdown', off, true));
    m.onclick = e => {
      const b = e.target.closest('[data-vedit],[data-vdel],[data-vnew],[data-vcmp],[data-vuse]'); if (!b) return;
      close();
      const d = b.dataset;
      if (d.vedit) return editVar(...d.vedit.split(':'));
      if (d.vdel) return deleteVar(...d.vdel.split(':'));
      if (d.vnew) return newVar(d.vnew);
      if (d.vcmp) return compareVars(d.vcmp);
      if (d.vuse) return useVar(...d.vuse.split(':'));
    };
  }
  // side by side: two variations of one card (rows, totals, and the effect on the Final)
  function compareVars(id) {
    const a = A(id); if (!varsOf(a)) return;
    const list = a.vars.list;
    let L = (list.find(v => v.id !== a.vars.on) || list[0]).id, R = a.vars.on;
    const ov = document.createElement('div'); ov.className = 'cmp-ov';
    document.body.appendChild(ov);
    const esc = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    const close = () => { ov.remove(); removeEventListener('keydown', esc, true); };
    addEventListener('keydown', esc, true);
    const near = (x, y, d) => Math.abs((x ?? 0) - (y ?? 0)) < 10 ** -d / 2;
    const delta = (v, b, unit, d, money) => {
      if (v == null || b == null) return v == null ? '<span class="cmp-d dn">not used</span>' : '<span class="cmp-d up">new</span>';
      if (near(v, b, d)) return '<span class="cmp-same">=</span>';
      const dv = v - b; return `<span class="cmp-d ${dv > 0 ? 'up' : 'dn'}">${dv > 0 ? '▲ +' : '▼ -'}${money ? NL.money(Math.abs(dv)) : NL.fmt(Math.abs(dv), d) + unit}${b ? ` (${dv > 0 ? '+' : ''}${NL.fmt(dv / b * 100, 1)}%)` : ''}</span>`;
    };
    const nameOfRef = ref => { const s = subIdOf(ref); return s ? (A(s)?.name || 'Removed card') + ' <small>sub-assembly</small>' : NL.esc(NL.ingMap[ref.slice(4)]?.name || ref); };
    function draw() {
      const vL = list.find(v => v.id === L), vR = list.find(v => v.id === R), sL = varStats(id, vL), sR = varStats(id, vR);
      const money = Object.assign(v => NL.money(v), { money: true });
      const row = (label, x, y, unit = '', d = 1, fmtv = v => NL.fmt(v, d) + unit) => `<tr class="${near(x, y, d) ? 'same' : 'diff'}"><th>${label}</th>
        <td>${x == null ? '<span class="cmp-na">—</span>' : `<b>${fmtv(x)}</b>`}</td><td>${y == null ? '<span class="cmp-na">—</span>' : `<b>${fmtv(y)}</b>`}<div>${delta(y, x, unit, d, fmtv.money)}</div></td></tr>`;
      // weight rows: both sides in one unit (the unit of the larger value), like Compare assemblies
      const wrow = (label, x, y) => { const u = NL.unitForAll([x, y].filter(v => v != null)), k = NL.UNITS[u]; return row(label, x == null ? null : x / k, y == null ? null : y / k, ' ' + u, u === 'g' ? 1 : 3); };
      const amt = items => { const m = new Map(); items.forEach(it => m.set(it.ref, (m.get(it.ref) || 0) + (+it.amount || 0))); return m; };
      const mL = amt(sL.items), mR = amt(sR.items), refs = [...new Set([...mL.keys(), ...mR.keys()])];
      const sec = t => `<tr><td class="cmp-h" colspan="3">${t}</td></tr>`;
      const opts = sel => list.map(v => `<option value="${v.id}" ${v.id === sel ? 'selected' : ''}>${NL.esc(v.name)}${v.id === a.vars.on ? ' (in use)' : ''}</option>`).join('');
      ov.innerHTML = `<div class="cmp var-cmp">
        <div class="cmp-top"><b>⇄ Compare variations · ${NL.esc(a.name)}</b><span class="spacer"></span><button class="btn ghost cmp-x" title="Close (Esc)">×</button></div>
        <div class="var-cmp-pick"><label>Baseline <select data-side="L">${opts(L)}</select></label><span>vs</span><label><select data-side="R">${opts(R)}</select></label>
          ${R !== a.vars.on ? `<button class="btn sm" data-usecmp="${R}">Use “${NL.esc(vR.name)}”</button>` : ''}</div>
        <div class="cmp-scroll"><table class="cmp-tbl"><thead><tr><th></th>
          <th>${NL.esc(vL.name)}<small>baseline</small><div class="var-cmp-note">${NL.esc(vL.note || '')}</div></th>
          <th>${NL.esc(vR.name)}${R === a.vars.on ? '<small>in use</small>' : ''}<div class="var-cmp-note">${NL.esc(vR.note || '')}</div></th></tr></thead>
        <tbody>${sec('This card')}
          ${wrow('Batch weight', sL.batch, sR.batch)}${wrow('Final weight (yield)', sL.yielded, sR.yielded)}${row('Cooking loss', sL.loss, sR.loss, '%', 1)}
          ${row(sL.isRoot ? 'Calories per portion' : 'Calories per 100 g', sL.kcal, sR.kcal, ' kcal', 0)}
          ${row(sL.isRoot ? 'Cost per portion' : 'Cost per ' + NL.pUnit(), sL.cost, sR.cost, '', 2, money)}
          ${sL.fin ? sec('Effect on the Final · ' + NL.esc(A(S.root).name)) + row('Calories per portion', sL.fin.kcal, sR.fin.kcal, ' kcal', 0) + row('Cost per portion', sL.fin.cost, sR.fin.cost, '', 2, money) : ''}
          ${sec('Rows on this card (weights as typed)')}
          ${refs.map(ref => wrow(nameOfRef(ref), mL.has(ref) ? mL.get(ref) : null, mR.has(ref) ? mR.get(ref) : null)).join('')}
          ${sec('Procedure and notes')}
          <tr class="${JSON.stringify(sL.steps) === JSON.stringify(sR.steps) ? 'same' : 'diff'}"><th>Procedure</th><td class="var-txt">${sL.steps.map(s => NL.esc(s)).join('<br>') || '—'}</td><td class="var-txt">${sR.steps.map(s => NL.esc(s)).join('<br>') || '—'}</td></tr>
          <tr class="${sL.notes === sR.notes ? 'same' : 'diff'}"><th>Notes</th><td class="var-txt">${NL.esc(sL.notes) || '—'}</td><td class="var-txt">${NL.esc(sR.notes) || '—'}</td></tr>
        </tbody></table></div>
        <div class="cmp-foot">▲ / ▼ show the difference from the baseline. Weights are the amounts typed on this card.</div></div>`;
      ov.querySelector('.cmp-x').onclick = close;
      ov.querySelectorAll('[data-side]').forEach(s => s.onchange = () => { if (s.dataset.side === 'L') L = s.value; else R = s.value; draw(); });
      const u = ov.querySelector('[data-usecmp]'); if (u) u.onclick = () => { useVar(id, u.dataset.usecmp); R = a.vars.on; draw(); };
    }
    ov.addEventListener('pointerdown', e => { if (e.target === ov) close(); });
    draw();
  }

  function pasteCard() {
    const clip = readClip(); if (!clip?.cards) return NL.toast('Nothing copied yet');
    insertCards(clip, { suffix: ' (copy)' });
    NL.toast(view === 'sheet' ? 'Card pasted at the bottom' : 'Card pasted. Drag its ● onto an assembly to use it');
  }
  addEventListener('storage', e => { if (e.key === CLIP) updatePasteBtn(); });

  // ---------- split view: a second editable side ----------
  // Each side has its own assembly, undo history and card containers. Before any click, key or edit, the side it
  // happened on becomes current (its values are swapped into the globals the rest of the code uses).
  // When both sides show the same tab they share one assembly and one undo history.
  const split = { on: false, tab: null, card: '' };
  let side = 'left', leftCtx = null, right = null; // right: { tab, shared, S, hist }
  const grab = () => ({ S, hist, view, cardsEl, svCardsEl, svInnerEl, svLinksEl, svEl, calc, cost, orderIdx, depthMap });
  const put = x => { ({ S, hist, view, cardsEl, svCardsEl, svInnerEl, svLinksEl, svEl, calc, cost, orderIdx, depthMap } = x); };
  function rightCtx() {
    const tabs = wb.all(), act = tabs.find(t => t.active);
    if (!tabs.some(t => t.id === split.tab)) split.tab = act.id;
    const shared = split.tab === act.id;
    if (!right || right.tab !== split.tab || right.shared !== shared) {
      right = { tab: split.tab, shared };
      if (!shared) {
        right.S = tabs.find(t => t.id === split.tab).state;
        right.hist = NL.history(() => wb.saveTab(right.tab, right.S), () => right.S, s => { right.S = s; if (side === 'right') S = s; render(); });
      }
    }
    if (shared) { right.S = leftCtx.S; right.hist = leftCtx.hist; }
    return { S: right.S, hist: right.hist, view: 'sheet', cardsEl: $('#spCards'), svCardsEl: $('#spCards'), svInnerEl: $('#spInner'), svLinksEl: $('#spLinks'), svEl: $('#spBody'), calc, cost, orderIdx: {}, depthMap: {} };
  }
  function rawSwap(to) {
    if (to === side || (to === 'right' && !split.on)) return false;
    const cur = grab();
    if (side === 'left') leftCtx = cur;
    else if (right) { right.S = cur.S; if (right.shared) leftCtx.S = cur.S; }
    side = to;
    put(to === 'left' ? leftCtx : rightCtx());
    return true;
  }
  function withSide(to, fn) { const from = side; if (to !== side && !rawSwap(to)) return; try { fn(); } finally { rawSwap(from); } }
  // user moved to the other side: finish the pending edit on this side first
  function useSide(to) {
    if (to === side || (to === 'right' && !split.on)) return;
    clearTimeout(typingT); commit();
    rawSwap(to); markSide();
  }
  function markSide() {
    $('#cmain').classList.toggle('side-right', side === 'right');
  }
  const saveCur = () => side === 'right' && right && !right.shared ? wb.saveTab(right.tab, S) : wb.save(S);
  const sideOf = t => t?.closest?.('#split') ? 'right' : t?.closest?.('#vp, #sheetView, .side, #nut') ? 'left' : null;
  for (const type of ['pointerdown', 'focusin', 'dragover', 'drop'])
    document.addEventListener(type, e => { const s = sideOf(e.target); if (s) useSide(s); }, true);

  function paintRight() {
    calc = NL.calc(S); cost = NL.cost(S, calc); computeFlows(); computeBans();
    const ord = sheetOrder(); orderIdx = Object.fromEntries(ord.map((id, k) => [id, k])); depthMap = depths();
    if (split.card && !S.asm[split.card]) split.card = '';
    const ids = split.card ? [split.card] : ord;
    cardsEl.innerHTML = ids.length ? ids.map(cardHTML).join('') : SHEET_EMPTY;
    stickCols(cardsEl);
    $('#split').className = `split lk-${prefs.links} w-${prefs.width}`;
    drawSheetLinks();
    const tabs = wb.all(), L = side === 'right' ? leftCtx.S : S;
    $('#spTab').innerHTML = tabs.map(x => `<option value="${x.id}" ${x.id === split.tab ? 'selected' : ''}>${NL.esc(x.name)}${x.active ? ' (this sheet)' : ''}</option>`).join('');
    $('#spCard').innerHTML = '<option value="">All cards</option>' + ord.map(id => `<option value="${id}" ${id === split.card ? 'selected' : ''}>${NL.esc(S.asm[id].name)}</option>`).join('');
    $('#spLeft').innerHTML = '<option value="">Left: jump to card…</option>' + Object.keys(L.asm).map(id => `<option value="${id}">${NL.esc(L.asm[id].name)}</option>`).join('');
  }
  // draw both sides (each in its own context)
  function render() {
    if (side === 'right') { paintRight(); withSide('left', paintLeft); return; }
    paintLeft();
    $('#cmain').classList.toggle('split-on', split.on);
    if (split.on) withSide('right', paintRight); else { $('#spCards').innerHTML = ''; $('#spLinks').innerHTML = ''; }
    markSide();
  }
  function openSplit(tabId) {
    useSide('left');
    const tabs = wb.all(), act = tabs.find(t => t.active), others = tabs.filter(t => !t.active);
    split.on = true; split.card = ''; right = null;
    split.tab = tabId === act.id && others.length ? others[0].id : tabId;
    render(); setTimeout(drawLinks, 250);
  }
  function closeSplit() { useSide('left'); split.on = false; right = null; render(); setTimeout(drawLinks, 250); }
  $('#spTab').onchange = e => { useSide('left'); split.tab = e.target.value; split.card = ''; right = null; render(); };
  $('#spCard').onchange = e => { split.card = e.target.value; render(); $('#spBody').scrollTop = 0; };
  $('#spLeft').onchange = e => { const id = e.target.value; e.target.value = ''; if (!id) return; useSide('left'); goto(id); };
  $('#spClose').onclick = () => closeSplit();

  // ---------- compare assemblies / versions ----------
  function recipeStats(state) {
    if (!state.root || !state.asm[state.root]) return null;
    const c = NL.calc(state), rc = c[state.root];
    return {
      batch: rc.batch, yielded: rc.yielded, loss: +state.asm[state.root].yieldLoss || 0,
      kcal100: rc.perG[0] * 100, cards: Object.keys(state.asm).length,
      nut: NL.NUTRIENTS.map((_, i) => rc.perG[i] * rc.yielded),
      ing: Object.fromEntries(NL.flatten(state, c, state.root)),
      cost: NL.cost(state, c)[state.root],
    };
  }
  function openCompare() {
    clearTimeout(typingT); commit();
    const all = wb.all(), tabs = all.filter(t => t.state.root && t.state.asm[t.state.root]), skipped = all.filter(t => !tabs.includes(t));
    if (tabs.length < 2) return NL.toast(skipped.length ? 'Compare needs two assemblies with a Final card. Use the Final toggle on a card' : 'Make a second tab first (＋ New assembly or ⎘ New Version), then compare');
    const pick = new Set(tabs.slice(0, 4).map(t => t.id));
    let baseId = tabs[0].id, diffOnly = false;
    const ov = document.createElement('div'); ov.className = 'cmp-ov';
    document.body.appendChild(ov);
    const esc = e => { if (e.key === 'Escape') { e.stopPropagation(); close(); } };
    const close = () => { ov.remove(); removeEventListener('keydown', esc, true); };
    addEventListener('keydown', esc, true);
    const near = (a, b, d) => Math.abs((a ?? 0) - (b ?? 0)) < 10 ** -d / 2;
    function delta(v, b, unit, d) {
      if (near(v, b, d)) return '<span class="cmp-same">=</span>';
      const dv = v - b, pct = b ? ` (${dv > 0 ? '+' : ''}${NL.fmt(dv / b * 100, 1)}%)` : '';
      return `<span class="cmp-d ${dv > 0 ? 'up' : 'dn'}">${dv > 0 ? '▲ +' : '▼ '}${NL.fmt(dv, d)}${unit}${pct}</span>`;
    }
    function draw() {
      const cols = tabs.filter(t => pick.has(t.id));
      if (!pick.has(baseId)) baseId = cols[0]?.id;
      cols.sort((a, b) => (b.id === baseId) - (a.id === baseId));
      const st = Object.fromEntries(cols.map(t => [t.id, recipeStats(t.state)]));
      const base = st[baseId];
      // a weight row: every column in one unit (the unit of the largest value)
      const wrow = (label, getG, extra = 0) => { const u = NL.unitForAll(cols.map(t => getG(st[t.id]))); return row(label, s => getG(s) == null ? null : getG(s) / NL.UNITS[u], ' ' + u, (u === 'g' ? 1 : 3) + extra); };
      const row = (label, get, unit = '', d = 1) => {
        const vals = cols.map(t => get(st[t.id]));
        const same = vals.every(v => v != null && near(v, vals[0], d)) || vals.every(v => v == null);
        if (diffOnly && same) return '';
        const bv = base ? get(base) : null;
        return `<tr class="${same ? 'same' : 'diff'}"><th>${label}</th>${cols.map((t, i) => {
          const v = vals[i];
          const main = v == null ? '<span class="cmp-na">—</span>' : `<b>${NL.fmt(v, d)}${unit}</b>`;
          const sub = t.id === baseId ? '' : v == null ? (bv == null ? '' : '<span class="cmp-d dn">not used</span>') : bv == null ? '<span class="cmp-d up">new</span>' : delta(v, bv, unit, d);
          return `<td>${main}${sub ? `<div>${sub}</div>` : ''}</td>`;
        }).join('')}</tr>`;
      };
      const ingIds = [...new Set(cols.flatMap(t => Object.keys(st[t.id].ing)))].sort((a, b) => (base?.ing[b] || 0) - (base?.ing[a] || 0));
      const sec = t => `<tr><td class="cmp-h" colspan="${cols.length + 1}">${t}</td></tr>`;
      const body = !cols.length ? '<div class="cmp-empty">Tick at least one assembly above.</div>' : `<div class="cmp-scroll"><table class="cmp-tbl">
        <thead><tr><th></th>${cols.map(t => `<th>${NL.esc(t.name)}${t.id === baseId ? '<small>baseline</small>' : `<button class="cmp-mk" data-base="${t.id}" title="Compare everything against this assembly">set as baseline</button>`}</th>`).join('')}</tr></thead>
        <tbody>${sec('Summary')}
          ${wrow('Portion / batch weight', s => s.batch)}${wrow('Final weight (yield)', s => s.yielded)}${row('Cooking loss', s => s.loss, '%')}
          ${row('Calories per portion', s => s.nut[0], ' kcal', 0)}${row('Calories per 100 g', s => s.kcal100, ' kcal', 0)}${row('Cards in assembly', s => s.cards, '', 0)}
          ${row('Cost per portion ($)', s => s.cost.batch, '', 2)}${row(`Cost per ${NL.pUnit()} ($)`, s => NL.pOut(s.cost.perG * 1000), '', 2)}
          ${sec('Nutrition per portion')}
          ${NL.NUTRIENTS.slice(1).map((n, k) => row(n.label, s => s.nut[k + 1], ' ' + n.unit, n.unit === 'mg' ? 0 : 1)).join('')}
          ${sec('Raw ingredients per portion')}
          ${ingIds.map(iid => wrow(NL.esc(NL.ingMap[iid]?.name || iid), s => s.ing[iid] ?? null, 1)).join('')}</tbody>
      </table></div>`;
      ov.innerHTML = `<div class="cmp">
        <div class="cmp-top"><b>⇄ Compare assemblies</b><span class="spacer"></span>
          <label class="cmp-opt"><input type="checkbox" id="cmpDiff" ${diffOnly ? 'checked' : ''}> Only show differences</label>
          <button class="btn ghost cmp-x" title="Close (Esc)">×</button></div>
        <div class="cmp-pick">${tabs.map(t => `<label class="cmp-chip ${pick.has(t.id) ? 'on' : ''}"><input type="checkbox" data-pick="${t.id}" ${pick.has(t.id) ? 'checked' : ''}>${NL.esc(t.name)}${t.active ? ' <small>(open)</small>' : ''}</label>`).join('')}</div>
        ${body}
        ${skipped.length ? `<div class="cmp-foot">Not shown (no Final card yet): ${skipped.map(t => NL.esc(t.name)).join(', ')}</div>` : ''}
        <div class="cmp-foot">▲ / ▼ show the difference from the baseline column. Ingredient weights are the raw amounts that end up in one portion, including those inside sub-assemblies.</div>
      </div>`;
      ov.querySelector('.cmp-x').onclick = close;
      ov.querySelector('#cmpDiff').onchange = e => { diffOnly = e.target.checked; draw(); };
      ov.querySelectorAll('[data-pick]').forEach(cb => cb.onchange = () => { cb.checked ? pick.add(cb.dataset.pick) : pick.delete(cb.dataset.pick); draw(); });
      ov.querySelectorAll('[data-base]').forEach(b => b.onclick = () => { baseId = b.dataset.base; draw(); });
    }
    ov.addEventListener('pointerdown', e => { if (e.target === ov) close(); });
    draw();
  }

  function deleteCard(id) {
    const ps = parentsOf(id);
    if (!confirm(`Delete "${A(id).name}"?${ps.length ? `\nIt will be removed from: ${ps.map(p => A(p.pid).name).join(', ')}` : ''}`)) return;
    delete S.asm[id];
    if (S.root === id) S.root = null;
    for (const a of Object.values(S.asm)) a.items = a.items.filter(it => it.ref !== 'asm:' + id);
    render(); commit();
  }
  // ---------- remove a connection (hover a line, click its scissors) ----------
  function unlink(pid, sid) {
    A(pid).items = A(pid).items.filter(it => it.ref !== 'asm:' + sid);
    render(); commit();
    NL.toast(`Unlinked "${A(sid).name}" from "${A(pid).name}". The card is kept. Ctrl+Z to undo`);
  }

  function nextColor() {
    const used = new Set(Object.values(S.asm).map(a => a.color));
    return COLORS.find(c => !used.has(c)) || COLORS[Object.keys(S.asm).length % COLORS.length];
  }
  function setKind(id, kind) {
    const a = A(id);
    if (kind === 'final') {
      if (S.root === id) return;
      const ps = parentsOf(id);
      if (ps.length) return NL.toast(`"${a.name}" is used inside ${ps.map(p => '"' + A(p.pid).name + '"').join(', ')}. Remove it there first, then make it Final`);
      const prev = hasFinal() ? S.root : null;
      if (prev && (!A(prev).color || A(prev).color === ROOT_COLOR)) A(prev).color = nextColor();
      S.root = id;
      NL.toast(`"${a.name}" is now the final assembly${prev ? `. "${A(prev).name}" is now a sub-assembly` : ''}`);
    } else {
      if (S.root !== id) return;
      if (!a.color || a.color === ROOT_COLOR) a.color = nextColor();
      S.root = null;
      NL.toast(`"${a.name}" is now a sub-assembly. Mark any card as Final when you're ready`);
    }
    render(); commit();
  }
  function openPicker(id, anchor, mode) {
    const r = anchor.getBoundingClientRect();
    const subs = Object.entries(S.asm).filter(([sid]) => sid !== S.root && !wouldCycle(id, sid) && !A(id).items.some(it => it.ref === 'asm:' + sid))
      .map(([sid, a]) => ({ value: 'asm:' + sid, label: a.name, color: colorOf(sid), sub: 'sub-assembly' }));
    const favs = { label: '★ Favorites', items: readFavs().map(f => ({ value: 'fav:' + f.id, label: f.name, color: '#f59e0b', sub: 'favorite' })) };
    // the other direction: put this card into the Final assembly
    const toFinal = mode === 'link' && hasFinal() && id !== S.root && !A(S.root).items.some(it => it.ref === 'asm:' + id) && !wouldCycle(S.root, id)
      ? [{ label: 'Add this card to', items: [{ value: 'into:' + S.root, label: A(S.root).name, color: colorOf(S.root), sub: 'final assembly' }] }] : [];
    const groups = mode === 'link'
      ? [...toFinal, { label: 'Existing sub-assemblies', items: subs }, favs, { label: 'Create', items: [{ value: 'new-sub', label: '＋ New sub-assembly', color: '#7c5cff', always: true }] }]
      : [{ label: 'Sub-assemblies', items: subs }, favs, ...NL.ingredientGroups()];
    NL.picker({ x: r.left, y: r.bottom + 4, groups, placeholder: mode === 'link' ? 'Search sub-assemblies…' : 'Search ingredients…', onPick: v => v.startsWith('into:') ? linkCard(id, v.slice(5)) : addItem(id, v) });
  }

  // ---------- interactions ----------
  const vp = NL.viewport(vpEl, worldEl, {
    isBackground: t => t === vpEl || t === worldEl || t === boardCardsEl || t === linksEl,
    onChange: v => { $('#zl').textContent = Math.round(v.s * 100) + '%'; },
  });

  boardCardsEl.addEventListener('pointerdown', e => {
    { const c = e.target.closest('.rcard'); if (c) raise(c.dataset.id); }
    const port = e.target.closest('[data-port]');
    if (port && e.button === 0) {
      const id = port.dataset.port, a = A(id);
      return NL.connectDrag({ e, vp, linksEl, from: { x: a.x, y: a.y + 30 }, color: colorOf(id), targetSel: '.rcard', selfEl: port.closest('.rcard'), onDrop: t => linkCard(id, t.dataset.id) });
    }
    const top = e.target.closest('[data-drag]'); if (!top || e.button !== 0) return;
    if (e.target.closest('input,button,textarea,a,select')) return;
    e.preventDefault();
    const el = top.closest('.rcard'), id = el.dataset.id, a = A(id);
    const st = vp.toWorld(e.clientX, e.clientY), ox = a.x, oy = a.y; let moved = false;
    const mv = ev => {
      const p = vp.toWorld(ev.clientX, ev.clientY);
      if (!moved && Math.hypot(p.x - st.x, p.y - st.y) < 3) return;
      moved = true; a.x = ox + p.x - st.x; a.y = oy + p.y - st.y;
      el.style.left = a.x + 'px'; el.style.top = a.y + 'px'; drawLinks();
    };
    const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); if (moved) commit(); };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
  });

  document.addEventListener('input', e => {
    const d = e.target.dataset; if (!d) return;
    if (d.u && d.fk && !fieldUnit[d.fk]) fieldUnit[d.fk] = d.u; // keep this box's unit until you leave it
    if (d.lbf) {
      const [id, k, f] = d.lbf.split(':'), r = A(id).labor?.[+k]; if (!r) return;
      const t = e.target.value.trim(), v = NL.parseNum(t);
      if (f === 'name') r.name = e.target.value;
      else if (t === '') r[f] = f === 'people' ? 1 : null;
      else if (isFinite(v) && v >= 0) { r[f] = v; if (f === 'rate') try { localStorage.setItem(LB_RATE, String(v)); } catch { } }
      renderKeep();
    }
    else if (d.pkn || d.pkc || d.pkd) {
      const [id, k, f] = (d.pkn || d.pkc || d.pkd).split(':'), r = A(id).packaging?.[+k]; if (!r) return;
      const t = e.target.value.trim(), v = NL.parseNum(t);
      if (d.pkn) r.name = e.target.value;
      else if (t === '') d.pkc ? r.cost = null : r[f] = null;
      else if (isFinite(v) && v >= 0) d.pkc ? r.cost = v : r[f] = f === 'weight' ? NL.fromU(v, e.target.dataset.u) : v;
      renderKeep();
    }
    else if (d.amt) {
      const [id, i] = d.amt.split(':'), raw = e.target.value, v = raw.trim() === '' ? 0 : NL.parseNum(raw);
      if (!isFinite(v)) amtErr[d.amt] = `Enter a weight in ${NL.UNIT_NAMES[e.target.dataset.u] || 'grams'}, e.g. 12.5`;
      else if (v < 0) amtErr[d.amt] = "Weight can't be negative";
      else { delete amtErr[d.amt]; A(id).items[+i].amount = NL.fromU(v, e.target.dataset.u); }
      renderKeep();
    }
    else if (d.title) { A(d.title).name = e.target.value; renderKeep(); }
    else if (d.fw) { setFinalWeight(d.fw, e.target.value, e.target.dataset.u); renderKeep(); }
    else if (d.sct || d.psz || d.pcn || d.sbt) {
      const id = d.sct || d.psz || d.pcn || d.sbt, a = A(id), v = NL.parseNum(e.target.value);
      if (v > 0) { if (d.sct) a.scaleTarget = NL.fromU(v, e.target.dataset.u); else if (d.psz) a.portionSize = NL.fromU(v, e.target.dataset.u); else if (d.sbt) a.baseTarget = NL.fromU(v, e.target.dataset.u); else a.portionCount = v; renderKeep(); saveCur(); hist.sync(); }
    }
    else if (d.nutserv) { const v = NL.parseNum(e.target.value), a = A(d.nutserv); if (v > 0) { a.nutServing = v; a.nutBasis = '100'; renderKeep(); saveCur(); hist.sync(); } }
    else if (d.bk) {
      const [id, i] = d.bk.split(':'), a = A(id), base = baseTotal(a), v = e.target.value.trim();
      const pv = NL.parseNum(v);
      if (base > 0 && isFinite(pv) && pv >= 0) { a.items[+i].amount = round2(base * pv / 100); renderKeep(); }
    }
    else if (d.bscale || d.wscale) {
      const id = d.bscale || d.wscale, a = A(id), v = NL.parseNum(e.target.value);
      const snap = bscaleStart[id] || (bscaleStart[id] = a.items.map(it => +it.amount || 0));
      // scale by yield: required batch = desired yield / (1 - loss), so the factor is taken against the snapshot's yield
      const snapBase = d.bscale ? baseSet(a).reduce((s, k) => s + snap[k], 0) : snap.reduce((s, x) => s + x, 0) * (1 - Math.min(+a.yieldLoss || 0, 99.99) / 100);
      if (e.target.value.trim() !== '' && isFinite(v) && v > 0 && snapBase > 0) { const f = v / snapBase; a.items.forEach((it, k) => { it.amount = round2(snap[k] * f); }); renderKeep(); }
    }
    else if (d.step) { const [id, i] = d.step.split(':'); A(id).steps[+i] = e.target.value; }
    else if (d.notes) { A(d.notes).notes = e.target.value; }
  });
  // inputs are re-rendered while typing, so 'change' never fires: commit shortly after typing stops, and on blur
  const isField = d => d && (d.amt || d.title || d.fw || d.bk || d.bscale || d.wscale || d.step || d.notes || d.pkn || d.pkc || d.pkd || d.lbf);
  let typingT;
  document.addEventListener('input', e => { if (isField(e.target.dataset)) { clearTimeout(typingT); typingT = setTimeout(commit, 600); } });
  // portion size dropdown on top of a sub-assembly card: pick the active scaling (display only)
  document.addEventListener('change', e => {
    const pu = e.target.dataset?.pku;
    if (pu) { const [id, k] = pu.split(':'), r = A(id).packaging?.[+k]; if (r) { r.unit = e.target.value; render(); commit(); } return; }
    const id = e.target.dataset?.pssel; if (!id) return;
    const a = A(id), v = e.target.value;
    (a.scalePins || []).forEach(p => { if (!p.id) p.id = NL.uid('p'); });
    if (v) a.activePin = v; else delete a.activePin;
    render(); saveCur(); hist.sync();
  });
  document.addEventListener('focusin', e => {
    { const t = e.target; if (t?.dataset?.u && t.dataset.fk) fieldUnit[t.dataset.fk] = t.dataset.u; }
    if (NL.refocusing) return;
    const id = e.target.dataset?.fw; if (id) fwStart[id] = A(id).yieldLoss || 0;
    const sc = e.target.dataset?.bscale || e.target.dataset?.wscale; if (sc) delete bscaleStart[sc];
  });
  document.addEventListener('focusout', e => {
    // leaving a weight box: forget its unit; with Auto units, redraw so it can switch (e.g. 1500 g -> 1.5 kg)
    { const t = e.target; if (!NL.refocusing && t?.dataset?.fk && fieldUnit[t.dataset.fk]) { delete fieldUnit[t.dataset.fk]; if (NL.unitMode === 'auto') setTimeout(renderKeep, 0); } }
    if (NL.refocusing) return;
    const d = e.target.dataset;
    if (d?.fw) {
      if (e.target.value.trim() === '') render();
      else if (fwErr[d.fw]) { NL.toast('Final weight not saved: ' + fwErr[d.fw]); delete fwErr[d.fw]; render(); }
    }
    if (d?.amt && amtErr[d.amt]) { NL.toast('Weight not saved: ' + amtErr[d.amt]); delete amtErr[d.amt]; render(); }
    if (d?.bscale || d?.wscale || d?.bk) { delete bscaleStart[d.bscale || d.wscale]; render(); }
    if (isField(d)) commit();
  });
  document.addEventListener('keydown', e => {
    const d = e.target.dataset;
    // keyboard flow for chefs: Enter in a weight box goes to the next row's weight, or on the last row opens the ingredient search again
    if (e.key === 'Enter' && d?.amt && !e.target.readOnly && !amtErr[d.amt]) {
      e.preventDefault();
      const [id, i] = d.amt.split(':');
      e.target.blur();
      setTimeout(() => {
        if (cardsEl.querySelector(`[data-amt="${id}:${+i + 1}"]`)) return focusAmt(id, +i + 1);
        const add = cardsEl.querySelector(`[data-addi="${id}"]`);
        if (add) openPicker(id, add, 'ing');
      }, 0);
      return;
    }
    if (e.key === 'Enter' && d && (d.amt || d.title || d.fw || d.bk || d.bscale || d.wscale || d.pkn || d.pkc || d.pkd || d.lbf)) e.target.blur();
    if (e.key === 'Enter' && d?.step) { const [id, i] = d.step.split(':'); A(id).steps.splice(+i + 1, 0, ''); render(); commit(); cardsEl.querySelector(`[data-step="${id}:${+i + 1}"]`)?.focus(); }
  });

  document.addEventListener('click', e => {
    const t = e.target, q = s => t.closest(s);
    let b;
    if ((b = q('[data-view]'))) return setView(b.dataset.view);
    if ((b = q('[data-svlinks]'))) { prefs.links = b.dataset.svlinks; savePrefs(); return render(); }
    if ((b = q('[data-svwidth]'))) { prefs.width = b.dataset.svwidth; savePrefs(); return render(); }
    if ((b = q('[data-move]'))) { const [id, d] = b.dataset.move.split(':'); return moveCard(id, +d); }
    if ((b = q('[data-goto]'))) return goto(b.dataset.goto);
    if ((b = q('[data-togbase]'))) {
      const [id, i] = b.dataset.togbase.split(':'), a = A(id), it = a.items[+i];
      if (it.base) delete it.base; else it.base = true;
      render(); commit(); return;
    }
    if ((b = q('[data-delbase]'))) {
      const a = A(b.dataset.delbase);
      delete a.baseName; a.items.forEach(it => delete it.base);
      render(); commit(); NL.toast('Base removed. Press B on an ingredient to choose a new base'); return;
    }
    if ((b = q('[data-basename]'))) {
      const a = A(b.dataset.basename);
      NL.prompt('Name the base (e.g. Total Flour)', a.baseName || 'Total Flour').then(v => {
        if (v == null) return;
        if (v) a.baseName = v; else delete a.baseName;
        render(); commit();
        NL.toast(v ? `Press B on each ingredient that belongs to "${v}"` : 'Base name removed');
      });
      return;
    }
    if ((b = q('[data-delrow]'))) { const [id, i] = b.dataset.delrow.split(':'); A(id).items.splice(+i, 1); render(); commit(); return; }
    if ((b = q('[data-addi]'))) return openPicker(b.dataset.addi, b, 'ing');
    if ((b = q('[data-addl]'))) return openPicker(b.dataset.addl, b, 'link');
    if ((b = q('[data-adds]'))) return newSub(b.dataset.adds);
    if ((b = q('[data-delcard]'))) return deleteCard(b.dataset.delcard);
    if ((b = q('[data-sclpin]'))) {
      const id = b.dataset.sclpin, a = A(id), sc = scaleOf(a, calc[id], parentsOf(id), id === S.root), list = a.scalePins || (a.scalePins = []);
      if (list.length >= 4) return NL.toast('Up to 4 pinned columns. Remove one with × first');
      if (list.some(p => samePin(p, sc))) return NL.toast('These numbers are already a column. Change them above to add another');
      list.push({ id: NL.uid('p'), mode: sc.mode, target: sc.target, size: sc.size, count: sc.count });
      render(); saveCur(); hist.sync(); return;
    }
    if ((b = q('[data-pkadd]'))) {
      const id = b.dataset.pkadd;
      packagingForm().then(r => { if (!r) return; (A(id).packaging || (A(id).packaging = [])).push(r); render(); commit(); NL.toast(`Added ${r.name}`); });
      return;
    }
    if ((b = q('[data-lbadd]'))) {
      const id = b.dataset.lbadd;
      laborForm().then(r => { if (!r) return; (A(id).labor || (A(id).labor = [])).push(r); render(); commit(); NL.toast(`Added ${r.name}`); });
      return;
    }
    if ((b = q('[data-lbedit]'))) {
      const [id, k] = b.dataset.lbedit.split(':'), list = A(id).labor;
      laborForm(list[+k]).then(r => { if (!r) return; list[+k] = r; render(); commit(); });
      return;
    }
    if ((b = q('[data-lbdel]'))) { const [id, k] = b.dataset.lbdel.split(':'); A(id).labor.splice(+k, 1); render(); commit(); return; }
    if ((b = q('[data-pkedit]'))) {
      const [id, k] = b.dataset.pkedit.split(':'), list = A(id).packaging;
      packagingForm(list[+k]).then(r => { if (!r) return; list[+k] = r; render(); commit(); });
      return;
    }
    if ((b = q('[data-pkdel]'))) { const [id, k] = b.dataset.pkdel.split(':'); A(id).packaging.splice(+k, 1); render(); commit(); return; }
    if ((b = q('[data-subpull]'))) {
      const [id, sid] = b.dataset.subpull.split(':'), a = A(id); if (!a) return;
      a.pulled = a.pulled || {};
      if (a.pulled[sid]) delete a.pulled[sid]; else a.pulled[sid] = true;
      if (!Object.keys(a.pulled).length) delete a.pulled;
      render(); saveCur(); hist.sync(); return;
    }
    if ((b = q('[data-sclshow]'))) {
      { const [id, k, v] = b.dataset.sclshow.split(':'); if (k.startsWith('fin-')) { const a = A(id); a.finShowCost = a.finShowCost || {}; if (v === '$') a.finShowCost[k] = true; else delete a.finShowCost[k]; if (!Object.keys(a.finShowCost).length) delete a.finShowCost; render(); saveCur(); hist.sync(); return; } }
      const [id, k, v] = b.dataset.sclshow.split(':'), a = A(id), t = k === 'sub' || +k < 0 ? a : a.scalePins?.[+k], key = k === 'sub' ? 'subShowCost' : +k < 0 ? 'scaleShowCost' : 'showCost';
      if (!t) return;
      if (v === '$') t[key] = true; else delete t[key];
      render(); saveCur(); hist.sync(); return;
    }
    if ((b = q('[data-scluse]'))) {
      const [id, k] = b.dataset.scluse.split(':'), a = A(id), p = a.scalePins[+k];
      if (!p) return;
      if (!p.id) p.id = NL.uid('p');
      if (a.activePin === p.id) delete a.activePin; else a.activePin = p.id;
      render(); saveCur(); hist.sync(); return;
    }
    if ((b = q('[data-sclunpin]'))) { const [id, k] = b.dataset.sclunpin.split(':'); A(id).scalePins.splice(+k, 1); render(); saveCur(); hist.sync(); return; }
    if ((b = q('[data-sclmode]'))) { const [id, m] = b.dataset.sclmode.split(':'), a = A(id); if (a.scaleMode === m || (!a.scaleMode && m === 'yield')) return; a.scaleMode = m; render(); saveCur(); hist.sync(); return; }
    if ((b = q('[data-nuttog]'))) { const a = A(b.dataset.nuttog); a.showNut = !a.showNut; render(); saveCur(); hist.sync(); return; }
    if ((b = q('[data-nutbasis]'))) { const [id, v] = b.dataset.nutbasis.split(':'); if (A(id).nutBasis === v) return; A(id).nutBasis = v; NL.keepFocus(render); saveCur(); hist.sync(); return; }
    if ((b = q('[data-price]'))) {
      const iid = b.dataset.price, name = NL.ingMap[iid]?.name || iid, cur = NL.price(iid);
      NL.prompt(`Price per ${NL.pUnit()} for ${name} ($). Used everywhere this ingredient appears.`, cur == null ? '' : String(+NL.pOut(cur).toFixed(4))).then(v => {
        if (v == null) return;
        const p = NL.parseNum(v);
        if (!isFinite(p) || p < 0) return NL.toast('Enter a price like 4.50');
        NL.setPrice(iid, NL.pIn(p)); render(); NL.toast(`${name}: ${NL.money(p)} per ${NL.pUnit()}`);
      });
      return;
    }
    if ((b = q('[data-var]'))) return varMenu(b.dataset.var, b);
    if ((b = q('[data-copycard]'))) return copyCard(b.dataset.copycard);
    if ((b = q('[data-fav]'))) { const id = b.dataset.fav; return favOf(id) ? favMenu(id, b) : saveFav(id); }
    if ((b = q('[data-favadd]'))) return useFav(b.dataset.favadd, null);
    if ((b = q('[data-favdel]'))) { const f = favById(b.dataset.favdel); if (f && confirm(`Remove "${f.name}" from favorites?`)) removeFav(f.id); return; }
    if ((b = q('[data-cut]'))) { const [pid, sid] = b.dataset.cut.split(':'); return unlink(pid, sid); }
    if ((b = q('[data-kind]'))) { const [k, id] = b.dataset.kind.split(':'); return setKind(id, k); }
    if ((b = q('[data-emptyadd]'))) return addCard();
    if ((b = q('[data-face]'))) { const [id, f] = b.dataset.face.split(':'); if ((A(id).face === 'scale' ? 'scale' : 'build') !== f) setFace(id, f); return; }
    if ((b = q('[data-collapse]'))) { const a = A(b.dataset.collapse); a.collapsed = !a.collapsed; render(); commit(); return; }
    if ((b = q('[data-addstep]'))) { const a = A(b.dataset.addstep); a.steps.push(''); render(); commit(); cardsEl.querySelector(`[data-step="${b.dataset.addstep}:${a.steps.length - 1}"]`)?.focus(); return; }
    if ((b = q('[data-delstep]'))) { const [id, i] = b.dataset.delstep.split(':'); A(id).steps.splice(+i, 1); render(); commit(); }
  });

  // library drag → card
  $('#libSearch').addEventListener('input', drawLib);
  $('#lib').addEventListener('dragstart', e => { const it = e.target.closest('.lib-item'); if (it) { e.dataTransfer.setData('text/plain', 'ing:' + it.dataset.ing); e.dataTransfer.effectAllowed = 'copy'; } });
  for (const dz of [vpEl, svEl, $('#spBody')]) dz.addEventListener('dragover', e => {
    e.preventDefault();
    const c = e.target.closest?.('.rcard');
    cardsEl.querySelectorAll('.drop').forEach(x => x !== c && x.classList.remove('drop'));
    c?.classList.add('drop');
  });
  for (const dz of [vpEl, svEl, $('#spBody')]) dz.addEventListener('drop', e => {
    e.preventDefault();
    cardsEl.querySelectorAll('.drop').forEach(x => x.classList.remove('drop'));
    const v = e.dataTransfer.getData('text/plain'), c = e.target.closest?.('.rcard');
    if (!v) return;
    if (v.startsWith('fav:')) return useFav(v.slice(4), c?.dataset.id || null);
    if (!c) return NL.toast('Drop the ingredient onto an assembly card');
    addItem(c.dataset.id, v);
  });

  document.addEventListener('keydown', e => {
    if (NL.isTyping()) return;
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key.toLowerCase() === 'z') { e.preventDefault(); e.shiftKey ? hist.redo() : hist.undo(); }
    else if (mod && e.key.toLowerCase() === 'y') { e.preventDefault(); hist.redo(); }
    else if (mod && e.key.toLowerCase() === 'v' && readClip()?.cards && !document.querySelector('.cmp-ov, .nl-prompt-ov')) { e.preventDefault(); pasteCard(); }
    else if ((e.key === 'f' || e.key === 'F') && side === 'left' && view === 'board') vp.fit(bounds());
  });

  $('#undo').onclick = () => hist.undo();
  $('#redo').onclick = () => hist.redo();
  $('#fit').onclick = () => { useSide('left'); vp.fit(bounds()); };
  // board: show or hide the link lines between cards (remembered per browser)
  { const btn = $('#linesBtn'); let off = false; try { off = localStorage.getItem('nlv3_hide_links') === '1'; } catch { }
    const apply = () => { document.body.classList.toggle('hide-links', off); btn.classList.toggle('off', off); btn.textContent = off ? '⤳ Lines off' : '⤳ Lines'; btn.setAttribute('aria-pressed', String(!off)); };
    const setOff = v => { off = v; try { localStorage.setItem('nlv3_hide_links', off ? '1' : '0'); } catch { } apply(); };
    btn.onclick = () => setOff(!off);
    settingsReg.push({ get: () => off, set: setOff });
    apply(); }
  $('#arrange').onclick = () => { useSide('left'); arrange(); commit(); vp.fit(bounds()); };
  $('#zin').onclick = () => vp.zoom(1.2);
  $('#zout').onclick = () => vp.zoom(1 / 1.2);
  // units: pick metric or imperial, then automatic (g → kg, oz → lb) or one fixed unit
  const sysSel = $('#unitSys'), modeSel = $('#unitMode');
  const fillModes = () => {
    const [sm, bg] = NL.SYS_UNITS[NL.unitSys];
    modeSel.innerHTML = `<option value="auto">Auto (${sm} → ${bg} at ${NL.unitSys === 'metric' ? '1000 g' : '16 oz'})</option><option value="${sm}">Always ${sm}</option><option value="${bg}">Always ${bg}</option>`;
    sysSel.value = NL.unitSys; modeSel.value = NL.unitMode;
  };
  fillModes();
  const unitsChanged = () => { for (const k in fieldUnit) delete fieldUnit[k]; render(); }; // boxes take the new units at once
  sysSel.onchange = () => { NL.setUnits(sysSel.value, 'auto'); fillModes(); unitsChanged(); NL.toast(`${sysSel.value === 'metric' ? 'Metric (g / kg)' : 'Imperial (oz / lb)'}. Choose Auto or one fixed unit in the next box`); };
  modeSel.onchange = () => { NL.setUnits(NL.unitSys, modeSel.value); unitsChanged(); };
  settingsReg.push({ get: () => [NL.unitSys, NL.unitMode], set: ([sys, mode]) => { NL.setUnits(sys, mode); fillModes(); unitsChanged(); } });
  const styleSel = $('#scaleStyle'); styleSel.value = scaleStyle;
  styleSel.onchange = () => { scaleStyle = styleSel.value === 'hide' ? 'hide' : 'flip'; try { localStorage.setItem('nlv3_scale_style', scaleStyle); } catch { } render(); };
  settingsReg.push({ get: () => scaleStyle, set: v => { styleSel.value = v; styleSel.onchange(); } });
  $('#toggleNut').onclick = () => {
    useSide('left');
    const m = $('#cmain'); m.classList.toggle('show-nut');
    $('#toggleNut').textContent = m.classList.contains('show-nut') ? 'All facts ◂' : 'All facts ▸';
    drawNut(); setTimeout(drawLinks, 220);
  };
  $('#newVer').onclick = async () => {
    useSide('left');
    const v = await NL.prompt('Version name (shown on the tab):', nameOf(S) + ' v' + (wb.count() + 1));
    if (!v) return;
    wb.add(JSON.parse(JSON.stringify(S)), v);
    NL.toast('Version "' + v + '" created');
  };
  $('#newRecipe').onclick = () => { useSide('left'); newRecipe(); };
  $('#addCard').onclick = () => addCard();
  $('#pasteCard').onclick = () => pasteCard();
  $('#compare').onclick = () => { useSide('left'); openCompare(); };
  // light / dark theme (first visit follows the computer's setting; the choice is remembered)
  function showTheme() {
    const dark = document.documentElement.dataset.theme === 'dark';
    $('#themeBtn').textContent = dark ? '☀' : '☾';
    $('#themeBtn').title = dark ? 'Switch to light mode' : 'Switch to dark mode';
  }
  const setTheme = t => { document.documentElement.dataset.theme = t; try { localStorage.setItem('nlv3_theme', t); } catch { } showTheme(); };
  $('#themeBtn').onclick = () => setTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
  settingsReg.push({ get: () => document.documentElement.dataset.theme, set: setTheme }, { get: () => view, set: setView });
  showTheme();
  // hide / show the left panel (remembered per browser)
  const SIDE = 'nlv3_side_hidden';
  function setSide(hidden) {
    $('#cmain').classList.toggle('hide-side', hidden);
    $('#sideTog').textContent = hidden ? '›' : '‹';
    $('#sideTog').title = hidden ? 'Show the panel (assembly structure and ingredient library)' : 'Hide the panel';
    try { localStorage.setItem(SIDE, hidden ? '1' : ''); } catch { }
    setTimeout(drawLinks, 220);
  }
  $('#sideTog').onclick = () => setSide(!$('#cmain').classList.contains('hide-side'));
  // drag handles to resize the left panel and the All facts panel (remembered per browser; double-click resets)
  (function panelResize() {
    const KEY = 'nlv3_panel_widths', m = $('#cmain');
    let w = {}; try { w = JSON.parse(localStorage.getItem(KEY)) || {}; } catch { }
    const save = () => { try { localStorage.setItem(KEY, JSON.stringify(w)); } catch { } };
    const apply = () => { for (const k of ['side', 'nut']) w[k] ? m.style.setProperty(`--${k}-w`, w[k] + 'px') : m.style.removeProperty(`--${k}-w`); };
    apply();
    for (const [which, min, max] of [['side', 180, 520], ['nut', 260, 680]]) {
      const h = document.createElement('div');
      h.className = `rsz rsz-${which}`; h.title = 'Drag to resize · double-click to reset';
      m.appendChild(h);
      h.addEventListener('pointerdown', e => {
        if (e.button !== 0) return;
        e.preventDefault(); m.classList.add('resizing'); h.classList.add('active');
        const r = m.getBoundingClientRect();
        const other = which === 'side' ? (m.classList.contains('show-nut') ? $('#nut').offsetWidth : 0) : (m.classList.contains('hide-side') ? 0 : $('.side').offsetWidth);
        const room = Math.max(min, r.width - other - 320); // always leave at least 320px for the canvas
        const mv = ev => { const px = which === 'side' ? ev.clientX - r.left : r.right - ev.clientX; w[which] = Math.round(Math.min(max, room, Math.max(min, px))); apply(); };
        const up = () => { removeEventListener('pointermove', mv); removeEventListener('pointerup', up); m.classList.remove('resizing'); h.classList.remove('active'); save(); drawLinks(); };
        addEventListener('pointermove', mv); addEventListener('pointerup', up);
      });
      h.addEventListener('dblclick', () => { delete w[which]; apply(); save(); setTimeout(drawLinks, 220); });
    }
  })();
  try { if (localStorage.getItem(SIDE)) setSide(true); } catch { }
  // TEMP: reset-to-sample button (remove with #resetSample in index.html)
  $('#resetSample').onclick = () => {
    useSide('left');
    if (!confirm('Replace this tab with the original sample assembly? Other tabs are not touched. You can undo with Ctrl+Z.')) return;
    S = fromSample(); arrange(); commit(); if (view === 'board') vp.fit(bounds(), 40, { min: 0.8, align: 'left' });
    NL.toast('Sample assembly restored');
  };
  $('#newIng').onclick = async () => { const i = await NL.ingredientForm(); if (i) NL.toast(`"${i.name}" added. Drag it from the list.`); };
  document.addEventListener('nl:ingredients', drawLib);

  // ---------- assemblies as tabs (workbook) ----------
  const nameOf = st => st.asm[st.root]?.name || st.draftName || 'Untitled assembly';
  const blank = () => ({ root: null, draftName: 'Untitled assembly ' + (wb.count() + 1), asm: {} });
  const sample = () => Object.assign(fromSample(), { _arrange: true });
  function newRecipe() { wb.add(blank()); }
  window.NL_resetSample = () => { wb.add(sample()); NL.toast('Sample assembly opened in a new tab'); };

  function openState(state) {
    S = state;
    if (view === 'sheet') { render(); hist = NL.history(() => wb.save(S), () => S, s => { S = s; render(); }); svEl.scrollTop = 0; return; }
    const needsArrange = S._arrange; delete S._arrange;
    if (needsArrange) { arrange(); wb.save(S); } else { render(); if (placeNewCards()) wb.save(S); }
    hist = NL.history(() => wb.save(S), () => S, s => { S = s; render(); }); // after arranging, so undo never returns to unplaced cards
    if (!Object.keys(S.asm).length) { vp.v.s = 1; vp.v.x = 0; vp.v.y = 0; vp.apply(); return; }
    const empty = hasFinal() && Object.keys(S.asm).length === 1 && !A(S.root).items.length;
    if (empty) {
      const a = A(S.root); vp.v.s = 1; vp.v.x = 40 - a.x; vp.v.y = 30 - a.y; vp.apply();
      const t = cardsEl.querySelector(`[data-title="${S.root}"]`); t.focus(); t.select();
    } else vp.fit(bounds(), 40, { min: 0.8, align: 'left' });
  }

  // ---------- boot ----------
  const wb = NL.workbook({
    key: 'nlv3_cards_book',
    sample, nameOf,
    beforeSwitch: () => { useSide('left'); clearTimeout(typingT); commit(); },
    onSwitch: openState,
    onNew: newRecipe,
    onSplit: openSplit,
  });
  drawLib();
  drawFavs();
  updatePasteBtn();
  openState(wb.current());
})();
