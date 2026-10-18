// Shared calculation engine + UI helpers. Both layouts convert their state into the same
// "model" shape ({ root, asm: { id: { name, items:[{ref, amount}], yieldLoss } } }) so the
// numbers are identical and only the interface differs.
window.NL = window.NL || {};

NL.CUSTOM_KEY = 'nlv3_custom_ingredients';
NL.CUSTOM_CAT = 'My Ingredients';
NL.CAT_COLORS[NL.CUSTOM_CAT] = '#0ea5e9';
try { (JSON.parse(localStorage.getItem(NL.CUSTOM_KEY)) || []).forEach(i => NL.INGREDIENTS.push(i)); } catch { }
NL.ingMap = Object.fromEntries(NL.INGREDIENTS.map(i => [i.id, i]));
// ---- cost: price per kg in USD. Sample prices ship with the app; prices you enter are kept per browser.
NL.PRICE_KEY = 'nlv3_prices';
NL.SAMPLE_PRICES = { water: 0, chicken_stock: 1.5, pork_bone_broth: 3, soy_sauce: 3.2, mirin: 4.5, sake: 5, rice_vinegar: 3, fish_sauce: 4, lemon_juice: 3.5, coconut_milk: 3.2, white_miso: 6.5, red_miso_powder: 18, dashi_powder: 22, yeast_extract: 15, ajitop: 14, ultra_spicy_sauce: 9, topping_spicy_miso: 12, gochujang: 7, sriracha: 6, oyster_sauce: 5, salt: 0.6, sugar: 1.1, brown_sugar: 1.6, honey: 7, black_pepper: 14, chili_flakes: 12, msg: 3, sesame_seeds: 7, hazelnuts: 16, coriander_seeds: 9, ground_ginger: 18, white_pepper: 20, sesame_oil: 9, olive_oil: 8, vegetable_oil: 2.2, butter: 9, lard: 3.5, onion_sweet: 2.4, garlic: 6, ginger: 5, scallion: 4.5, carrot: 1.4, cabbage: 1.2, bean_sprouts: 2.5, shiitake: 12, corn: 2.5, spinach: 5, tomato: 3, bell_pepper: 4.5, potato: 1.3, fried_shallots: 10, nori: 45, chicken_breast_cooked: 11, chicken_thigh: 5.5, pork_belly: 9, ground_pork: 6, ground_beef: 9.5, salmon: 22, shrimp: 18, egg: 4.5, tofu_firm: 4, fish_cake: 12, ramen_noodles: 4, udon: 3.5, jasmine_rice: 2.2, ap_flour: 0.9, bread_flour: 1.1, whole_wheat_flour: 1.3, instant_yeast: 9, cornstarch: 2, panko: 4.5, potato_starch: 2.8, whole_milk: 1.1, heavy_cream: 5, parmesan: 22, cheddar: 11, potassium_sorbate: 12, citric_acid: 4, xanthan_gum: 25, tapioca_maltodextrin: 14, sodium_benzoate: 6 };
NL.priceOverrides = (() => { try { return JSON.parse(localStorage.getItem(NL.PRICE_KEY)) || {}; } catch { return {}; } })();
NL.price = id => NL.priceOverrides[id] ?? NL.ingMap[id]?.price ?? NL.SAMPLE_PRICES[id] ?? null;
NL.isSamplePrice = id => !(id in NL.priceOverrides) && NL.ingMap[id]?.price == null && NL.SAMPLE_PRICES[id] != null;
NL.setPrice = (id, v) => { NL.priceOverrides[id] = v; try { localStorage.setItem(NL.PRICE_KEY, JSON.stringify(NL.priceOverrides)); } catch { } };
// Batch cost of every assembly, cost per gram of its finished weight (so cooking loss raises it), and ingredients without a price.
NL.cost = function (model, calc) {
  const res = {};
  const go = (id, seen) => {
    if (res[id]) return res[id];
    if (seen.has(id)) return { batch: 0, perG: 0, missing: 0 };
    seen.add(id);
    let batch = 0, missing = 0;
    for (const it of model.asm[id].items) {
      const [t, r] = it.ref.split(':'), amt = +it.amount || 0;
      if (t === 'ing') { const p = NL.price(r); if (p == null) { if (amt > 0) missing++; } else batch += amt / 1000 * p; }
      else if (model.asm[r]) { const s = go(r, seen); batch += amt * s.perG; missing += s.missing; }
    }
    const y = calc[id]?.yielded || 0;
    return (res[id] = { batch, perG: y > 0 ? batch / y : 0, missing });
  };
  Object.keys(model.asm).forEach(id => go(id, new Set()));
  return res;
};
NL.money = v => !isFinite(v) ? '—' : v > 0 && v < 0.01 ? '<$0.01' : '$' + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });

NL.refreshCategories = () => { NL.CATEGORIES = [...new Set([...NL.INGREDIENTS.map(i => i.cat), NL.CUSTOM_CAT])]; };
NL.refreshCategories();
NL.addIngredient = function (ing) {
  NL.INGREDIENTS.push(ing); NL.ingMap[ing.id] = ing; NL.refreshCategories();
  try {
    const list = JSON.parse(localStorage.getItem(NL.CUSTOM_KEY)) || [];
    list.push(ing); localStorage.setItem(NL.CUSTOM_KEY, JSON.stringify(list));
  } catch { }
  document.dispatchEvent(new CustomEvent('nl:ingredients'));
  return ing;
};

// Modal form for a new raw ingredient (nutrition per 100 g). Resolves to the ingredient or null.
NL.ingredientForm = function (initialName = '') {
  return new Promise(resolve => {
    const ov = document.createElement('div'); ov.className = 'nl-prompt-ov';
    const cats = NL.CATEGORIES.map(c => `<option ${c === NL.CUSTOM_CAT ? 'selected' : ''}>${NL.esc(c)}</option>`).join('');
    const nut = NL.NUTRIENTS.map((n, k) => `<label class="nif-n${n.sub ? ' sub' : ''}"><span>${NL.esc(n.label)}${n.unit ? ` (${n.unit})` : ' (kcal)'}</span>
      <input type="number" min="0" step="any" data-n="${k}" placeholder="0"></label>`).join('');
    ov.innerHTML = `<form class="nl-prompt nif">
      <div class="nl-prompt-label">New ingredient</div>
      <label class="nif-f"><span>Name</span><input name="name" required value="${NL.esc(initialName)}" placeholder="e.g. Yuzu Kosho"></label>
      <div class="nif-row">
        <label class="nif-f"><span>Category</span><select name="cat">${cats}</select></label>
        <label class="nif-f"><span>Vendor (optional)</span><input name="vendor" placeholder="e.g. Sysco"></label>
      </div>
      <label class="nif-f"><span>Price per ${NL.pUnit()} in $ (optional)</span><input name="price" inputmode="decimal" placeholder="e.g. 4.50"></label>
      <div class="nif-h">Nutrition per 100 g <small>blank = 0</small></div>
      <div class="nif-grid">${nut}</div>
      <div class="nl-prompt-btns"><button type="submit" class="btn primary">Save ingredient</button><button type="button" class="btn ghost nl-prompt-cancel">Cancel</button></div>
    </form>`;
    document.body.appendChild(ov);
    const f = ov.querySelector('form'), nameIn = f.elements.name;
    nameIn.focus(); nameIn.select();
    const done = v => { ov.remove(); resolve(v); };
    f.onsubmit = e => {
      e.preventDefault();
      const name = nameIn.value.trim(); if (!name) return nameIn.focus();
      if (NL.INGREDIENTS.some(i => i.name.toLowerCase() === name.toLowerCase()) && !confirm(`An ingredient called "${name}" already exists. Create another one anyway?`)) return;
      const n = NL.NUTRIENTS.map((_, k) => Math.max(0, parseFloat(f.querySelector(`[data-n="${k}"]`).value) || 0));
      const price = NL.parseNum(f.elements.price.value);
      done(NL.addIngredient({ id: NL.uid('c'), name, cat: f.elements.cat.value, vendor: f.elements.vendor.value.trim() || null, n, custom: true, price: isFinite(price) && price >= 0 ? NL.pIn(price) : null }));
    };
    ov.querySelector('.nl-prompt-cancel').onclick = () => done(null);
    ov.addEventListener('pointerdown', e => { if (e.target === ov) done(null); });
    f.addEventListener('keydown', e => { if (e.key === 'Escape') { e.stopPropagation(); done(null); } });
  });
};
NL.NUTRIENTS = [
  { k: 'kcal', label: 'Calories', unit: '' },
  { k: 'fat', label: 'Total Fat', unit: 'g', dv: 78 },
  { k: 'sat', label: 'Saturated Fat', unit: 'g', dv: 20, sub: true },
  { k: 'chol', label: 'Cholesterol', unit: 'mg', dv: 300 },
  { k: 'na', label: 'Sodium', unit: 'mg', dv: 2300 },
  { k: 'carb', label: 'Total Carbohydrate', unit: 'g', dv: 275 },
  { k: 'fib', label: 'Dietary Fiber', unit: 'g', dv: 28, sub: true },
  { k: 'sug', label: 'Total Sugars', unit: 'g', sub: true },
  { k: 'pro', label: 'Protein', unit: 'g' },
];

const zero = () => NL.NUTRIENTS.map(() => 0);

// Returns { [asmId]: { batch, yielded, lossG, perG:[...], total:[...], cycle } }
NL.calc = function (model) {
  const res = {}, visiting = new Set();
  function perG(ref) {
    const [t, id] = ref.split(':');
    if (t === 'ing') { const i = NL.ingMap[id]; return i ? i.n.map(v => v / 100) : null; }
    return model.asm[id] ? asm(id).perG : null;
  }
  function asm(id) {
    if (res[id]) return res[id];
    if (visiting.has(id)) return { batch: 0, yielded: 0, lossG: 0, perG: zero(), total: zero(), cycle: true };
    visiting.add(id);
    const a = model.asm[id];
    let batch = 0; const total = zero();
    for (const it of a.items) {
      const amt = +it.amount || 0; batch += amt;
      const pg = perG(it.ref);
      if (pg) pg.forEach((v, i) => { total[i] += v * amt; });
    }
    const loss = Math.min(Math.max(+a.yieldLoss || 0, 0), 99.99);
    const yielded = batch * (1 - loss / 100);
    visiting.delete(id);
    return (res[id] = { batch, yielded, lossG: batch - yielded, perG: total.map(v => yielded > 0 ? v / yielded : 0), total });
  }
  Object.keys(model.asm).forEach(asm);
  return res;
};

// Raw-ingredient breakdown (grams per one unit of root) → for the ingredient statement.
NL.flatten = function (model, calc, rootId) {
  const out = {};
  (function walk(id, factor, depth) {
    if (depth > 20) return;
    const a = model.asm[id]; // yield loss is treated as moisture, so it scales sub-assembly usage
    for (const it of a.items) {
      const [t, rid] = it.ref.split(':');
      if (t === 'ing') out[rid] = (out[rid] || 0) + (+it.amount || 0) * factor;
      else if (model.asm[rid] && calc[rid].yielded > 0) walk(rid, factor * (+it.amount || 0) / calc[rid].yielded, depth + 1);
    }
  })(rootId, 1, 0);
  return Object.entries(out).filter(([, g]) => g > 0).sort((a, b) => b[1] - a[1]);
};

// ---- ingredient name matching for imports (no AI; runs on this computer) ----
// Compares a name from a file with the library: brand names and codes are ignored, preparation words
// (grated, diced…) don't count, raw / cooked / dried must agree, rare words weigh more than common ones,
// one-letter typos and plurals are forgiven. Names a chef has confirmed before are remembered (aliases).
NL.ALIAS_KEY = 'nlv3_ing_aliases';
NL.aliases = (() => { try { return JSON.parse(localStorage.getItem(NL.ALIAS_KEY)) || {}; } catch { return {}; } })();
NL.rememberAlias = (fileName, ingId) => { const k = NL.matchKey(fileName); if (!k || !ingId) return; NL.aliases[k] = ingId; try { localStorage.setItem(NL.ALIAS_KEY, JSON.stringify(NL.aliases)); } catch { } };
NL.matchKey = t => String(t ?? '').toLowerCase().replace(/[^a-z0-9]+/g, ' ').trim();
(() => {
  const PREP = new Set('grated minced chopped diced sliced shredded peeled finely fine strip cubed julienne crushed melted softened cold hot warm strained washed trimmed boneless skinless cut mm inch any brand various shape size plain halved quartered pitted seeded stemmed rinsed drained'.split(' '));
  const STATE = { raw: 'raw', fresh: 'raw', cooked: 'cooked', fried: 'cooked', roasted: 'cooked', baked: 'cooked', grilled: 'cooked', smoked: 'cooked', toasted: 'cooked', dry: 'dry', dried: 'dry', dehydrated: 'dry', powder: 'dry', powdered: 'dry', granulated: 'dry' };
  const ABBR = { bs: ['boneless', 'skinless'], evoo: ['extra', 'virgin', 'olive', 'oil'], ap: ['all', 'purpose'], msg: ['msg'] };
  // common food synonyms (general kitchen vocabulary, not specific to one file)
  const SYN = [[/\b(green|spring) onions?\b/g, 'scallion'], [/\bprawns?\b/g, 'shrimp'], [/\bcorn ?flour\b/g, 'cornstarch'], [/\bcapsicums?\b/g, 'bell pepper'], [/\baubergines?\b/g, 'eggplant'],
    [/\bcourgettes?\b/g, 'zucchini'], [/\bcoriander leaf|cilantro\b/g, 'cilantro'], [/\bgarbanzo beans?\b/g, 'chickpea'], [/\bcaster sugar|white sugar|table sugar\b/g, 'sugar'], [/\bwhole eggs?\b/g, 'egg whole'],
    [/\bsoya\b/g, 'soy'], [/\bshoyu\b/g, 'soy sauce'], [/\bbread ?crumbs?\b/g, 'breadcrumbs']];
  const single = w => w.length > 3 && w.endsWith('ies') ? w.slice(0, -3) + 'y' : w.length > 3 && w.endsWith('oes') ? w.slice(0, -2) : w.length > 3 && w.endsWith('s') && !w.endsWith('ss') && !w.endsWith('us') ? w.slice(0, -1) : w;
  const lev = (a, b) => { if (Math.abs(a.length - b.length) > 2) return 9; const d = Array.from({ length: a.length + 1 }, (_, i) => [i]); for (let j = 1; j <= b.length; j++) d[0][j] = j; for (let i = 1; i <= a.length; i++) for (let j = 1; j <= b.length; j++) d[i][j] = Math.min(d[i - 1][j] + 1, d[i][j - 1] + 1, d[i - 1][j - 1] + (a[i - 1] === b[j - 1] ? 0 : 1)); return d[a.length][b.length]; };
  const near = (a, b) => a === b || (a.length >= 5 && b.length >= 5 && lev(a, b) <= (Math.min(a.length, b.length) >= 8 ? 2 : 1));
  let cache = null;
  const index = () => {
    if (cache && cache.n === NL.INGREDIENTS.length) return cache;
    const raw = t => NL.matchKey(t).split(' ').filter(Boolean).map(single);
    const nameWords = new Set(NL.INGREDIENTS.flatMap(i => raw(i.name)));
    // vendor words that are not food words are treated as brands (e.g. "sysco", "nikken"); "noodle" in "Sun Noodle" stays a food word
    const brands = new Set(NL.INGREDIENTS.flatMap(i => raw(i.vendor || '')).filter(w => !nameWords.has(w)));
    ['lkk', 'kikkoman', 'foreway', 'takii', 'essentia', 'kerry', 'novazyme', 'novozyme', 'bing', 'mr', 'sb', 'lee', 'kum'].forEach(w => brands.add(w));
    const toks = t => {
      const out = [], states = new Set();
      let text = NL.matchKey(String(t).replace(/&/g, '')); for (const [re, to] of SYN) text = text.replace(re, to);
      for (let w of raw(text)) {
        if (/\d/.test(w)) continue;                       // codes and sizes: r2, ag300, 9-11
        for (const x of ABBR[w] || [w]) {
          if (STATE[x]) { states.add(STATE[x]); continue; }
          if (PREP.has(x) || brands.has(x)) continue;
          out.push(x);
        }
      }
      return { words: [...new Set(out)], states };
    };
    const lib = NL.INGREDIENTS.map(i => ({ ing: i, ...toks(i.name), compact: NL.matchKey(i.name).replace(/ /g, '') }));
    const df = {}; lib.forEach(l => l.words.forEach(w => { df[w] = (df[w] || 0) + 1; }));
    const vocab = Object.keys(df), N = lib.length, wt = w => Math.log(1 + N / (df[w] || 1));
    return (cache = { n: NL.INGREDIENTS.length, lib, vocab, wt, toks });
  };
  // returns { kind: 'remembered' | 'same' | 'close' | 'new', ing, score }
  NL.matchName = function (name) {
    const key = NL.matchKey(name); if (!key) return { kind: 'new', score: 0 };
    const aid = NL.aliases[key]; if (aid && NL.ingMap[aid]) return { kind: 'remembered', ing: NL.ingMap[aid], score: 1 };
    const { lib, vocab, wt, toks } = index();
    const exact = lib.find(l => NL.matchKey(l.ing.name) === key || l.compact === key.replace(/ /g, '')); // "corn starch" = "Cornstarch"
    if (exact) return { kind: 'same', ing: exact.ing, score: 1 };
    const f = toks(name);
    const known = f.words.filter(w => vocab.some(v => near(w, v)));       // words the library knows; unknown words (brands, origins) don't count
    if (!known.length) return { kind: 'new', score: 0 };
    let best = null, bs = 0;
    for (const l of lib) {
      if (!l.words.length) continue;
      const hitF = known.filter(w => l.words.some(v => near(w, v))), hitL = l.words.filter(v => known.some(w => near(w, v)));
      if (!hitF.length) continue;
      const sum = a => a.reduce((t, w) => t + wt(w), 0);
      const P = sum(hitF) / sum(known), R = sum(hitL) / sum(l.words);
      let sc = 2 * P * R / (P + R);
      // raw / cooked / dried must agree: a cooked or dried library item needs the file to say so too
      const fs_ = [...f.states].filter(x => x !== 'raw'), ls = [...l.states].filter(x => x !== 'raw');
      if (fs_.some(x => !ls.includes(x)) || ls.some(x => !fs_.includes(x))) sc *= 0.5;
      if (f.states.has('raw') && ls.length) sc *= 0.5;
      if (sc > bs) { bs = sc; best = l.ing; }
    }
    return bs >= 0.75 ? { kind: 'close', ing: best, score: bs } : { kind: 'new', score: bs, hint: bs >= 0.65 ? best : null };
  };
})();

NL.refName = function (model, ref) {
  const [t, id] = ref.split(':');
  if (t === 'ing') return NL.ingMap[id]?.name || id;
  return model.asm[id]?.name || '(missing)';
};

// Parse a typed number. "1,5" is 1.5; "1,000" (comma + exactly 3 digits) is a thousands separator. NaN if not a number.
NL.parseNum = function (raw) {
  let v = String(raw ?? '').trim().replace(/\s+/g, '');
  if (v === '') return NaN;
  v = /^-?\d{1,3}(,\d{3})+(\.\d+)?$/.test(v) ? v.replace(/,/g, '') : v.replace(',', '.');
  return /^-?(\d+\.?\d*|\.\d+)$/.test(v) ? Number(v) : NaN;
};

NL.fmt = function (n, d = 1) {
  if (!isFinite(n)) return '0';
  const r = Math.round(n * 10 ** d) / 10 ** d;
  return r.toLocaleString(undefined, { maximumFractionDigits: d });
};
// ---- display units: weights are always stored in grams and prices per kg.
// The chosen units only change what is shown and typed (so data for a backend stays in g and $/kg).
// System: metric (g / kg) or imperial (oz / lb). Mode: 'auto' (small unit, switching to the big one at 1000 g or 16 oz) or one fixed unit.
NL.UNITS = { g: 1, kg: 1000, oz: 28.349523125, lb: 453.59237 };
NL.UNIT_NAMES = { g: 'grams', kg: 'kilograms', oz: 'ounces', lb: 'pounds' };
NL.unitSys = 'metric'; NL.unitMode = 'auto';
try {
  const m = localStorage.getItem('nlv3_unit'), s = localStorage.getItem('nlv3_unit_sys');
  if (s === 'metric' || s === 'imperial') NL.unitSys = s;
  else if (m === 'oz' || m === 'lb') NL.unitSys = 'imperial';
  if (m === 'auto' || NL.UNITS[m]) NL.unitMode = m;
  if (NL.unitMode !== 'auto' && (NL.unitSys === 'metric') !== (NL.unitMode === 'g' || NL.unitMode === 'kg')) NL.unitMode = 'auto';
} catch { }
NL.SYS_UNITS = { metric: ['g', 'kg'], imperial: ['oz', 'lb'] };
NL.setUnits = (sys, mode) => {
  if (NL.SYS_UNITS[sys]) NL.unitSys = sys;
  NL.unitMode = mode === 'auto' || NL.SYS_UNITS[NL.unitSys].includes(mode) ? mode : 'auto';
  try { localStorage.setItem('nlv3_unit_sys', NL.unitSys); localStorage.setItem('nlv3_unit', NL.unitMode); } catch { }
};
// the unit used to show this many grams
NL.unitFor = g => {
  if (NL.unitMode !== 'auto') return NL.unitMode;
  const [small, big] = NL.SYS_UNITS[NL.unitSys];
  return Math.abs(+g || 0) >= NL.UNITS[big] - 1e-9 ? big : small; // 1000 g -> kg, 16 oz (1 lb) -> lb
};
// one unit for a set of weights shown together (e.g. a Compare row): the unit of the largest
NL.unitForAll = gs => NL.unitFor(Math.max(0, ...gs.filter(g => g != null).map(g => Math.abs(g))));
NL.unitLabel = () => NL.unitMode === 'auto' ? NL.SYS_UNITS[NL.unitSys][0] : NL.unitMode; // short label, e.g. on the g | $ switch
NL.fromU = (v, u) => v * NL.UNITS[u || NL.unitFor(0)];   // typed value -> grams
const wNum = (g, u, d) => { const v = g / NL.UNITS[u]; return u === 'g' ? NL.fmt(v, d) : NL.fmt(v, Math.abs(v) < 1 ? 4 : u === 'oz' ? 2 : 3); };
// a weight as text: "12.5 g", "1.25 kg", "3.5 oz", "2.205 lb"
NL.ws = (g, d = 2) => { const u = NL.unitFor(g); return wNum(g, u, d) + ' ' + u; };
// number + small unit tag, for table cells (mid goes between them, e.g. '</b>')
NL.wu = (g, mid = '') => { const u = NL.unitFor(g); return `${wNum(g, u, 2)}${mid}<span class="u">${u}</span>`; };
// value for a weight box in unit u (grams round to d decimals, other units to 5)
NL.inUnit = (g, u, d) => g == null || g === '' ? '' : u === 'g' ? +(+g).toFixed(d ?? 3) : +((+g) / NL.UNITS[u]).toFixed(5);
// prices: $/kg stored; shown and typed per lb for imperial
NL.pUnit = () => NL.unitSys === 'imperial' ? 'lb' : 'kg';
NL.pOut = perKg => NL.unitSys === 'imperial' ? perKg * 0.45359237 : perKg;
NL.pIn = v => NL.unitSys === 'imperial' ? v / 0.45359237 : v;
NL.pct = (part, whole) => whole > 0 ? NL.fmt(part / whole * 100, 1) + '%' : '0%';
NL.esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
NL.uid = (p = 'n') => p + Math.random().toString(36).slice(2, 8);

// FDA-style nutrition facts panel (US format, simplified rounding).
NL.labelHTML = function (model, calc, rootId, servingG) {
  const c = calc[rootId]; const serving = servingG ?? c.yielded; const t = c.perG.map(v => v * serving);
  const rows = NL.NUTRIENTS.slice(1).map((n, i) => {
    const v = t[i + 1];
    const dv = n.dv ? Math.round(v / n.dv * 100) + '%' : '';
    return `<div class="lb-row ${n.sub ? 'sub' : ''}"><span><b>${n.sub ? '' : n.label}</b>${n.sub ? n.label : ''} ${NL.fmt(v, n.unit === 'mg' ? 0 : 1)}${n.unit}</span><b>${dv}</b></div>`;
  }).join('');
  const stmt = NL.flatten(model, calc, rootId).map(([id]) => NL.ingMap[id]?.name).join(', ');
  return `<div class="nlabel">
    <div class="lb-title">Nutrition Facts</div>
    <div class="lb-serv"><span>Serving size</span><b>${NL.fmt(serving, 1)} g</b></div>
    <div class="lb-thick"></div>
    <div class="lb-cal"><span>Calories</span><b>${Math.round(t[0])}</b></div>
    <div class="lb-med"></div>
    <div class="lb-row right"><b>% Daily Value*</b></div>
    ${rows}
    <div class="lb-thick"></div>
    <div class="lb-foot">* Approximate values from the test ingredient library.</div>
  </div>
  <div class="lb-stmt"><b>INGREDIENTS:</b> ${NL.esc(stmt) || '—'}</div>`;
};

// Searchable dropdown used for "add ingredient / sub-assembly" in both layouts.
// groups: [{ label, items: [{ value, label, sub, color }] }]
NL.picker = function ({ x, y, groups, placeholder = 'Search ingredients…', onPick }) {
  NL.closePicker();
  const el = document.createElement('div');
  el.className = 'picker';
  el.innerHTML = `<div class="pk-head"><input placeholder="${placeholder}"><button class="pk-close" title="Close (Esc)">×</button></div><div class="pk-list"></div>`;
  el.querySelector('.pk-close').onclick = () => NL.closePicker();
  document.body.appendChild(el);
  const input = el.querySelector('input'), list = el.querySelector('.pk-list');
  let active = 0, flat = [];
  function draw() {
    const q = input.value.trim().toLowerCase();
    flat = []; let html = '';
    // while searching, pinned actions ("always") move to the end so Enter picks the best match
    const pinned = groups.filter(g => g.items.some(i => i.always)).sort((a, b) => b.items.some(i => i.value === 'new-ing') - a.items.some(i => i.value === 'new-ing'));
    const ordered = q ? [...groups.filter(g => !g.items.some(i => i.always)), ...pinned] : groups;
    for (const g of ordered) {
      const items = g.items.filter(i => !q || i.label.toLowerCase().includes(q) || (i.sub || '').toLowerCase().includes(q) || i.always);
      if (!items.length) continue;
      html += `<div class="pk-group">${NL.esc(g.label)}</div>`;
      for (const i of items) {
        html += `<div class="pk-item ${flat.length === active ? 'active' : ''}" data-i="${flat.length}">
          <span class="pk-dot" style="background:${i.color || '#94a3b8'}"></span>
          <span class="pk-label">${NL.esc(i.label)}</span><span class="pk-sub">${NL.esc(i.sub || '')}</span></div>`;
        flat.push(i);
      }
    }
    list.innerHTML = html || '<div class="pk-empty">No matches</div>';
    list.querySelector('.active')?.scrollIntoView({ block: 'nearest' });
  }
  function pick(i) {
    const it = flat[i]; if (!it) return;
    const typed = input.value.trim();
    NL.closePicker();
    if (it.value === 'new-ing') NL.ingredientForm(typed).then(ing => { if (ing) { NL.toast(`"${ing.name}" added to your ingredients`); onPick('ing:' + ing.id, it); } });
    else onPick(it.value, it);
  }
  input.addEventListener('input', () => { active = 0; draw(); });
  input.addEventListener('keydown', e => {
    if (e.key === 'ArrowDown') { active = Math.min(active + 1, flat.length - 1); draw(); e.preventDefault(); }
    else if (e.key === 'ArrowUp') { active = Math.max(active - 1, 0); draw(); e.preventDefault(); }
    else if (e.key === 'Enter') { pick(active); e.preventDefault(); }
    else if (e.key === 'Escape') NL.closePicker();
  });
  list.addEventListener('mousedown', e => { const it = e.target.closest('.pk-item'); if (it) { e.preventDefault(); pick(+it.dataset.i); } });
  const W = 300, H = 360;
  el.style.left = Math.max(8, Math.min(x, innerWidth - W - 8)) + 'px';
  el.style.top = Math.max(8, Math.min(y, innerHeight - H - 8)) + 'px';
  draw(); input.focus();
  // pointerdown in the capture phase: the canvas calls preventDefault() on pointerdown (for panning),
  // which suppresses 'mousedown', so a mousedown listener never saw clicks on the canvas.
  NL._pickerOutside = e => { if (!el.contains(e.target)) NL.closePicker(); };
  NL._pickerEsc = e => { if (e.key === 'Escape') NL.closePicker(); };
  setTimeout(() => {
    document.addEventListener('pointerdown', NL._pickerOutside, true);
    document.addEventListener('keydown', NL._pickerEsc, true);
    window.addEventListener('wheel', NL._pickerOutside, { capture: true, passive: true });
  }, 0);
};
NL.closePicker = function () {
  document.querySelector('.picker')?.remove();
  if (NL._pickerOutside) {
    document.removeEventListener('pointerdown', NL._pickerOutside, true);
    document.removeEventListener('keydown', NL._pickerEsc, true);
    window.removeEventListener('wheel', NL._pickerOutside, { capture: true });
  }
  NL._pickerOutside = NL._pickerEsc = null;
};
NL.ingredientGroups = function () {
  return [{ label: 'New', items: [{ value: 'new-ing', label: '＋ Create new ingredient', color: NL.CAT_COLORS[NL.CUSTOM_CAT], always: true }] }, ...NL.CATEGORIES.map(cat => ({
    label: cat,
    items: NL.INGREDIENTS.filter(i => i.cat === cat).map(i => ({ value: 'ing:' + i.id, label: i.name, sub: i.vendor || (i.custom ? 'custom' : ''), color: NL.CAT_COLORS[cat] || '#94a3b8' })),
  })).filter(g => g.items.length)];
};

// Pan / zoom canvas. `world` is transformed; background dots follow the transform.
NL.viewport = function (vp, world, { isBackground, onChange } = {}) {
  const v = { s: 1, x: 0, y: 0 };
  function apply() {
    world.style.transform = `translate(${v.x}px,${v.y}px) scale(${v.s})`;
    vp.style.backgroundPosition = `${v.x}px ${v.y}px`;
    vp.style.backgroundSize = `${22 * v.s}px ${22 * v.s}px`;
    onChange && onChange(v);
  }
  function zoomAt(f, cx, cy) {
    const ns = Math.min(2, Math.max(0.25, v.s * f));
    v.x = cx - (cx - v.x) * ns / v.s; v.y = cy - (cy - v.y) * ns / v.s; v.s = ns; apply();
  }
  vp.addEventListener('wheel', e => {
    if (e.target.closest('.no-wheel')) return;
    e.preventDefault();
    const r = vp.getBoundingClientRect();
    if (e.ctrlKey || e.metaKey || Math.abs(e.deltaY) >= 50 && e.deltaX === 0) zoomAt(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    else { v.x -= e.deltaX; v.y -= e.deltaY; apply(); } // trackpad two-finger scroll pans
  }, { passive: false });
  vp.addEventListener('pointerdown', e => {
    if (!(e.button === 1 || (e.button === 0 && isBackground(e.target)))) return;
    e.preventDefault();
    const sx = e.clientX - v.x, sy = e.clientY - v.y; let moved = false;
    vp.classList.add('panning');
    const mv = ev => { moved = true; v.x = ev.clientX - sx; v.y = ev.clientY - sy; apply(); };
    const up = () => { vp.classList.remove('panning'); removeEventListener('pointermove', mv); removeEventListener('pointerup', up); api.lastPanMoved = moved; };
    addEventListener('pointermove', mv); addEventListener('pointerup', up);
  });
  const api = {
    v, apply,
    toWorld(cx, cy) { const r = vp.getBoundingClientRect(); return { x: (cx - r.left - v.x) / v.s, y: (cy - r.top - v.y) / v.s }; },
    zoom(f) { const r = vp.getBoundingClientRect(); zoomAt(f, r.width / 2, r.height / 2); },
    // min: never zoom out further than this; if clamped, anchor to `align` ('left' | 'right') and top.
    fit(b, pad = 60, { min = 0.25, align = 'left' } = {}) {
      const r = vp.getBoundingClientRect();
      if (!b || b.w <= 0) return;
      const s = Math.min(1.1, Math.min((r.width - pad * 2) / b.w, (r.height - pad * 2) / b.h));
      v.s = Math.max(min, s);
      if (s >= min) { v.x = (r.width - b.w * v.s) / 2 - b.x * v.s; v.y = (r.height - b.h * v.s) / 2 - b.y * v.s; }
      else { v.x = align === 'right' ? r.width - pad - (b.x + b.w) * v.s : pad - b.x * v.s; v.y = pad / 2 - b.y * v.s; }
      api.animate(); apply();
    },
    centerOn(x, y, s) {
      const r = vp.getBoundingClientRect(); if (s) v.s = s;
      v.x = r.width / 2 - x * v.s; v.y = r.height / 2 - y * v.s; api.animate(); apply();
    },
    animate() { world.classList.add('animating'); clearTimeout(api._t); api._t = setTimeout(() => world.classList.remove('animating'), 320); },
  };
  apply();
  return api;
};

// Undo/redo. `save` is called after every change (it persists the current state).
NL.history = function (save, get, set) {
  const past = [], future = [];
  let last = JSON.stringify(get());
  return {
    commit() {
      const now = JSON.stringify(get());
      if (now === last) return;
      past.push(last); if (past.length > 100) past.shift();
      future.length = 0; last = now; save();
    },
    sync() { last = JSON.stringify(get()); }, // accept the current state as-is, without an undo step
    undo() { if (!past.length) return; future.push(last); last = past.pop(); set(JSON.parse(last)); save(); },
    redo() { if (!future.length) return; past.push(last); last = future.pop(); set(JSON.parse(last)); save(); },
  };
};

// Excel-style workbook: one assembly per tab, tab bar pinned to the bottom of the page.
// opts: key, legacyKey, sample(), nameOf(state), onSwitch(state), onNew(), beforeSwitch()
// A tab shows its own `title` once renamed; until then it follows the assembly name.
NL.workbook = function (o) {
  const clone = x => JSON.parse(JSON.stringify(x));
  let book = NL.load(o.key);
  if (!book || !book.tabs?.length) {
    const first = { id: NL.uid('t'), state: (o.legacyKey && NL.load(o.legacyKey)) || o.sample() };
    book = { active: first.id, tabs: [first] };
  }
  if (!book.tabs.some(t => t.id === book.active)) book.active = book.tabs[0].id;
  let live = null, renaming = null, dragId = null;
  const tab = id => book.tabs.find(t => t.id === id);
  const persist = () => { try { localStorage.setItem(o.key, JSON.stringify(book)); } catch { } };
  const name = t => t.title || o.nameOf(t.id === book.active && live ? live : t.state) || 'Untitled';

  const bar = document.createElement('div');
  bar.className = 'tabbar';
  document.body.appendChild(bar);
  document.body.classList.add('has-tabbar');

  function draw() {
    if (renaming) return;
    bar.innerHTML = `<button class="tb-add" data-new title="New assembly">+</button>
      <div class="tb-tabs">${book.tabs.map(t => `<div class="tb-tab ${t.id === book.active ? 'active' : ''}" draggable="true" data-tab="${t.id}" title="Click to open · double-click to rename · right-click for more">
        <span class="tb-name">${NL.esc(name(t))}</span><button class="tb-x" data-close="${t.id}" title="Delete assembly">×</button></div>`).join('')}</div>
      <span class="tb-hint">${book.tabs.length} ${book.tabs.length > 1 ? 'assemblies' : 'assembly'} · double-click a tab to rename</span>`;
    bar.querySelector('.tb-tab.active')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }
  function switchTo(id) {
    if (id === book.active || !tab(id)) return;
    o.beforeSwitch && o.beforeSwitch();
    book.active = id; live = null; persist(); draw();
    o.onSwitch(tab(id).state);
  }
  function add(state, title) {
    o.beforeSwitch && o.beforeSwitch();
    const t = { id: NL.uid('t'), state };
    if (title) t.title = title;
    book.tabs.splice(book.tabs.findIndex(x => x.id === book.active) + 1, 0, t);
    book.active = t.id; live = null; persist(); draw();
    o.onSwitch(state);
  }
  function close(id) {
    if (book.tabs.length === 1) return NL.toast('You need at least one assembly tab');
    if (!confirm(`Delete the assembly "${name(tab(id))}"? This can't be undone.`)) return;
    const i = book.tabs.findIndex(t => t.id === id);
    book.tabs.splice(i, 1);
    if (id === book.active) { book.active = book.tabs[Math.min(i, book.tabs.length - 1)].id; live = null; persist(); draw(); o.onSwitch(tab(book.active).state); }
    else { persist(); draw(); }
  }
  function duplicate(id) {
    o.beforeSwitch && o.beforeSwitch();
    add(clone(tab(id).state), name(tab(id)) + ' (copy)');
  }
  function rename(id) {
    switchTo(id);
    const el = bar.querySelector(`[data-tab="${id}"] .tb-name`); if (!el) return;
    renaming = id;
    const inp = document.createElement('input');
    inp.className = 'tb-input'; inp.value = name(tab(id)); el.replaceWith(inp); inp.focus(); inp.select();
    let done = false;
    const finish = ok => {
      if (done) return; done = true; renaming = null;
      const v = inp.value.trim();
      if (ok && v) { tab(id).title = v; persist(); } draw();
    };
    inp.onkeydown = e => { if (e.key === 'Enter') finish(true); if (e.key === 'Escape') finish(false); e.stopPropagation(); };
    inp.onblur = () => finish(true);
  }
  function menu(id, x, y) {
    document.querySelector('.tb-menu')?.remove();
    const m = document.createElement('div');
    m.className = 'tb-menu';
    m.innerHTML = `<button data-m="rename">Rename</button><button data-m="dup">Duplicate</button>${o.onSplit ? '<button data-m="split">Split view</button>' : ''}<button data-m="del" class="danger">Delete</button>`;
    document.body.appendChild(m);
    m.style.left = Math.min(x, innerWidth - 170) + 'px'; m.style.top = (y - m.offsetHeight - 6) + 'px';
    const off = e => { if (!m.contains(e.target)) { m.remove(); document.removeEventListener('pointerdown', off, true); } };
    setTimeout(() => document.addEventListener('pointerdown', off, true), 0);
    m.onclick = e => {
      const a = e.target.dataset.m; if (!a) return;
      m.remove(); document.removeEventListener('pointerdown', off, true);
      if (a === 'rename') rename(id); else if (a === 'dup') duplicate(id); else if (a === 'split') o.onSplit(id); else close(id);
    };
  }

  bar.addEventListener('click', e => {
    if (e.target.closest('[data-new]')) return o.onNew();
    const x = e.target.closest('[data-close]'); if (x) { e.stopPropagation(); return close(x.dataset.close); }
    const t = e.target.closest('[data-tab]'); if (t && !renaming) switchTo(t.dataset.tab);
  });
  bar.addEventListener('dblclick', e => { const t = e.target.closest('[data-tab]'); if (t && !e.target.closest('[data-close]')) rename(t.dataset.tab); });
  bar.addEventListener('contextmenu', e => { const t = e.target.closest('[data-tab]'); if (t) { e.preventDefault(); menu(t.dataset.tab, e.clientX, e.clientY); } });
  bar.addEventListener('dragstart', e => { const t = e.target.closest('[data-tab]'); if (t) { dragId = t.dataset.tab; e.dataTransfer.effectAllowed = 'move'; e.dataTransfer.setData('text/nl-tab', dragId); } });
  bar.addEventListener('dragover', e => { if (dragId) { e.preventDefault(); } });
  bar.addEventListener('drop', e => {
    const t = e.target.closest('[data-tab]'); if (!dragId || !t || t.dataset.tab === dragId) { dragId = null; return; }
    e.preventDefault();
    const from = book.tabs.findIndex(x => x.id === dragId), moved = book.tabs.splice(from, 1)[0];
    const r = t.getBoundingClientRect(), to = book.tabs.findIndex(x => x.id === t.dataset.tab) + (e.clientX > r.left + r.width / 2 ? 1 : 0);
    book.tabs.splice(to, 0, moved); dragId = null; persist(); draw();
  });
  bar.addEventListener('dragend', () => { dragId = null; });

  draw();
  return {
    current: () => tab(book.active).state,
    save(state) { tab(book.active).state = state; live = null; persist(); draw(); },
    live(state) { live = state; const el = bar.querySelector('.tb-tab.active .tb-name'); if (el && !renaming && !tab(book.active).title) el.textContent = o.nameOf(state); },
    add,
    count: () => book.tabs.length,
    names: () => book.tabs.map(name),
    all: () => book.tabs.map(t => ({ id: t.id, name: name(t), state: t.state, active: t.id === book.active })),
    saveTab(id, state) { const t = tab(id); if (!t) return; t.state = state; persist(); draw(); },
  };
};
NL.load = function (key) { try { const s = localStorage.getItem(key); return s ? JSON.parse(s) : null; } catch { return null; } };

// Yield % is the complement of yield loss %; only yieldLoss is stored.
NL.yieldPct = loss => +(100 - (+loss || 0)).toFixed(2);
NL.lossFromYield = v => +(100 - Math.min(Math.max(+v || 0, 0), 100)).toFixed(2);

// Re-render while keeping the focused input focused (elements carry data-fk keys).
NL.keepFocus = function (fn) {
  const a = document.activeElement, fk = a?.dataset?.fk, typed = a?.value, root = a?.closest?.('[data-focus-root]') || document; // two editable panes can share field keys
  let s = null, e = null; try { s = a.selectionStart; e = a.selectionEnd; } catch { }
  NL.refocusing = true; // focus events fired while re-rendering are not the user leaving/entering a field
  try { fn(); } finally { if (!fk) NL.refocusing = false; }
  if (!fk) return;
  const n = root.querySelector(`[data-fk="${CSS.escape(fk)}"]`);
  if (n) { if (typed != null && 'value' in n) n.value = typed; n.focus(); try { if (s != null) n.setSelectionRange(s, e); } catch { } }
  NL.refocusing = false;
};

NL.toast = function (msg) {
  let t = document.querySelector('.toast');
  if (!t) { t = document.createElement('div'); t.className = 'toast'; document.body.appendChild(t); }
  t.textContent = msg; t.classList.add('show');
  clearTimeout(NL._toastT); NL._toastT = setTimeout(() => t.classList.remove('show'), 1800);
};

// Drag a wire from a card's port onto another card. Calls onDrop(targetEl) if released over one.
NL.connectDrag = function ({ e, vp, linksEl, from, color, targetSel, selfEl, onDrop }) {
  e.preventDefault(); e.stopPropagation();
  const path = document.createElementNS('http://www.w3.org/2000/svg', 'path');
  path.setAttribute('class', 'link link-temp'); path.setAttribute('stroke', color);
  linksEl.appendChild(path);
  let target = null;
  const mv = ev => {
    const p = vp.toWorld(ev.clientX, ev.clientY), dx = Math.max(60, Math.abs(p.x - from.x) / 2);
    path.setAttribute('d', `M${from.x},${from.y} C${from.x - dx},${from.y} ${p.x + dx},${p.y} ${p.x},${p.y}`);
    const t = document.elementFromPoint(ev.clientX, ev.clientY)?.closest(targetSel);
    const next = t && t !== selfEl ? t : null;
    if (next !== target) { target?.classList.remove('drop'); next?.classList.add('drop'); target = next; }
  };
  const up = () => {
    removeEventListener('pointermove', mv); removeEventListener('pointerup', up);
    path.remove(); target?.classList.remove('drop');
    if (target) onDrop(target); else NL.toast('Drop the handle onto the assembly card that uses it');
  };
  addEventListener('pointermove', mv); addEventListener('pointerup', up);
  mv(e);
};

NL.prompt = function (label, defaultVal) {
  return new Promise(resolve => {
    const ov = document.createElement('div'); ov.className = 'nl-prompt-ov';
    ov.innerHTML = `<div class="nl-prompt">
      <div class="nl-prompt-label">${NL.esc(label)}</div>
      <input class="nl-prompt-input" value="${NL.esc(defaultVal || '')}">
      <div class="nl-prompt-btns"><button class="btn nl-prompt-ok">OK</button><button class="btn ghost nl-prompt-cancel">Cancel</button></div>
    </div>`;
    document.body.appendChild(ov);
    const inp = ov.querySelector('.nl-prompt-input');
    inp.focus(); inp.select();
    const done = v => { ov.remove(); resolve(v); };
    ov.querySelector('.nl-prompt-ok').onclick = () => done(inp.value.trim() || null);
    ov.querySelector('.nl-prompt-cancel').onclick = () => done(null);
    ov.addEventListener('pointerdown', e => { if (e.target === ov) done(null); });
    inp.addEventListener('keydown', e => { if (e.key === 'Enter') done(inp.value.trim() || null); if (e.key === 'Escape') done(null); });
  });
};


NL.isTyping = () => { const a = document.activeElement; return a && (a.tagName === 'INPUT' || a.tagName === 'TEXTAREA' || a.isContentEditable); };

// Clicking into a number box that holds 0 clears it so the chef can type straight away; the 0 comes back if nothing is typed.
document.addEventListener('focusin', e => {
  const t = e.target;
  if (NL.refocusing || !t.matches?.('input[inputmode="decimal"]') || t.disabled || t.readOnly) return;
  if (NL.parseNum(t.value) === 0) { t.dataset.zeroCleared = t.value; t.value = ''; }
});
document.addEventListener('focusout', e => {
  const t = e.target, z = t.dataset?.zeroCleared;
  if (z == null) return;
  delete t.dataset.zeroCleared;
  if (t.isConnected && t.value === '') t.value = z;
});
