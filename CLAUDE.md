# NutriLabel Recipe Builder v3 — notes for Claude

R&D recipe / assembly builder for chefs at Northwest Frozen. Owner: Mahindra (Admin). The app is a UI prototype used for testing with chefs and a client, so clarity for non-technical users matters more than code cleverness.

- Repo: `mahindra-nwf/nutrilabel-recipe-layout-v3` (PUBLIC; served by GitHub Pages from `main`)
- Live: https://mahindra-nwf.github.io/nutrilabel-recipe-layout-v3/
- Commits are authored as GitHub user `mahindra-nwf` (repo owner), with the noreply email `330545866+mahindra-nwf@users.noreply.github.com`. Older commits are by `mahindra89`.

## Working rules (from the user)
- **Only commit/push when the user says so** ("push it", "push the changes"). Otherwise leave changes local and say they are not pushed.
- Before a risky experiment, the user may ask for a **checkpoint**: commit, push, and add an annotated tag (e.g. `checkpoint-before-scaling-view`). To revert, restore files from the tag in a new commit; never rewrite history.
- **Scaling is read-only.** Scaling, pinned columns and the portion-size dropdown only *read* the recipe weights. They must never change an assembly's original values.
- Never push the user's recipes/test data into this public repo without asking (client formulas and costs may be confidential).
- The user is a software engineer building this for chefs (not a chef). Technical explanations are fine; keep UI wording plain for chefs. For chef-workflow questions, pick a sensible default and list it as an assumption to test with chefs. Ask when a request is ambiguous.

## Run locally
`npm start` (or `node server.js`, or double-click `start.bat`) → http://localhost:5181. No dependencies, no build step.
For Claude's browser preview, `.claude/launch.json` has the config `nutrilabel-v3`.

## Before every push
1. Syntax check: `node -e "for (const f of ['cards.js','shared/engine.js','shared/data.js']) new Function(require('fs').readFileSync(f,'utf8'))"`
2. Bump the cache stamp on every `?v=` in `index.html` (all five links share one stamp, format `YYYYMMDDhhmm`):
   `sed -i -E 's/\?v=[0-9]+/?v=202601011200/g' index.html` (use the current date/time)
3. Commit with a plain-English message, then push. Check the Pages build:
   `gh api repos/mahindra-nwf/nutrilabel-recipe-layout-v3/pages/builds/latest --jq '.status+" "+.commit'`

## Code map
- `index.html` — page shell, top bar, side panel, ⚙ Settings drawer (`#settings`: View (Board / Sheet), Sheet view (links, width), Units, Scaling view, theme, Lines, Retailers — controls keep their ids), sheet view, split view (`#split`), theme + one-time `nlv2_`→`nlv3_` storage migration.
- `cards.js` — the app (one IIFE): card rendering (`cardHTML`), board + sheet views, split view, scaling (`scaleOf`, pins), costing rows, packaging, labor, Building/Scaling faces, compare, favorites, events.
- Export: ⬇ Export (top bar) → dialog picks **Company template** (`exportTemplate()`: laid out like the team's recipe workbook — product sheet with stacked recipe blocks, components summary, production G/Kg/Lbs, Item & cost sheet, Nutrition; values only, their colours) or **Detailed** (`exportXlsx()`). Uses xlsx-js-style (SheetJS + styles, jsDelivr, loaded on first use). Detailed: Summary, a sheet per card (pinned + From Final columns), Bill of materials (Final flattened per portion + per pinned column, incl. sub-assembly packaging/labor share), Nutrition. Optional costs; weights in the chosen unit (Auto → g or oz).
- Import: ⬆ Import (top bar) → `importFile()` / `readWorkbook()`: rule-based (no AI) reader for workbooks laid out like the team template (header row with "Ingredient" + "Quantity", name from a "Recipe" label, rows to "Total", then Yield % / Procedure: / Notes:). Price lists (Ingredient + cost per kg/lb, no Quantity) feed prices. A row naming another block (or the same "WIP n") becomes a sub-assembly; the unused block is the Final; each sheet → new tab. Names are matched by `NL.matchName()` (shared/engine.js, no AI): brands/codes ignored, prep words ignored, raw/cooked/dried must agree, rare words weigh more, typos/plurals and common synonyms forgiven; remembered aliases first (`nlv3_ing_aliases`, saved from every confirmed review row). The review dialog has a box per name (library name, or empty = new custom ingredient without nutrition) and one-click suggestions (score ≥ 0.65). A scorecard of test names is kept outside the repo.
- Export styles: Company template, Recipe card, Production (N portions), Costing, Spec, Detailed — `xlKit(X)` holds the shared grid/style helpers.
- `cards.css` — card/board/sheet styles (newer feature styles are appended at the end in labelled blocks).
- `shared/engine.js` — `NL` namespace: calc, nutrition label, cost (`NL.cost`, prices), number parsing, workbook/tabs (`NL.workbook`), undo history (`NL.history`; `sync()` saves without an undo step), prompts/forms, canvas helpers.
- `shared/data.js` — ingredient library and the sample assembly (Spicy Miso Ramen).
- `shared/base.css` — design tokens (light/dark) and shared components.

## Data model (per tab, saved in localStorage)
`S = { root, asm: { id: assembly } }`. An assembly has `name, items[{ref:'ing:<id>'|'asm:<id>', amount}], yieldLoss, steps, notes`, plus optional:
`scaleMode/scaleTarget/portionSize/portionCount/baseTarget`, `scalePins[{id,mode,target,size,count,showCost}]`, `activePin`, `scaleShowCost` / `subShowCost` (g|$ switch), `pulled{subId:true}` (Final only: rows pulled into its Sub portions column), `finShowCost{fin-<pinId>:true}` (g|$ for "From Final" columns: each pinned column on the Final card is scaled down into every sub-assembly's Scaling side, computed in `computeFlows()`, never stored),
`retailOff[retailerId]` (on S, per tab: retailers unticked for this recipe), `packaging[{id,name,weight,cost,l,w,h,unit}]`, `labor[{id,name,minutes,people,rate}]`, `face` ('scale' = Scaling side shown), `collapsed`, `x/y` (board position),
`vars` (Variations, only when a card has 2+): `{ on: <id in use>, list: [{ id, name, note, at, data? }] }`. The card's own fields always hold the variation **in use** (so calc, cost, scaling, labels and links need no changes); every other variation keeps a copy of `VAR_FIELDS` = items, yieldLoss, steps, notes, packaging, labor, baseName in `data`. Switching swaps them (undoable). Copy/paste and favorites drop `vars` (a copy starts with the variation in use only). Links in a variation to cards that were deleted, or that would loop, are left out when it is switched in.

localStorage keys (all prefixed `nlv3_`): `cards_book` (all tabs), `favorites`, `custom_ingredients`, `prices`, `theme`, `sheet_prefs`, `side_hidden`, `panel_widths`, `card_clipboard`, `labor_rate`, `scale_style`, `hide_links`, `ing_aliases` ({file name key: ingredient id}, import memory), `export_layout`, `retailers` ([{id,name,bans:[text]}]: banned ingredients per retailer, per browser; a ban matches whole words of an ingredient name, flagged with ⛔ on rows, cards, sub-assembly rows and the tree), `unit_sys` (metric|imperial) + `unit` (auto|g|kg|oz|lb): display only; weights are always stored in grams and prices in $/kg. Auto switches g→kg at 1000 g and oz→lb at 16 oz; a weight box keeps its unit while focused (`fieldUnit`).
Data lives in the browser per site address (localhost and the live site are separate) and does not travel with the repo.

## Testing
Use the browser preview at http://localhost:5181. Drive it with small JS checks (click buttons, read the DOM) and screenshots. Clear test data afterwards (`localStorage.removeItem('nlv3_cards_book')`) so the user's view returns to the sample.

## History
- Older UI Lab with Layouts A/B/C: `mahindra-nwf/nutrilabel-recipe-layout` (separate repo; known unfixed bugs there, untouched unless asked).
- Tags: `checkpoint-before-scaling-view` = everything before the Building/Scaling card sides; `checkpoint-before-final-scaling` = everything before Final-assembly scaling (pull from sub-assemblies, production run).
