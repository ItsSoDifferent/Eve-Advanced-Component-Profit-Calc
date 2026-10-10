# Advanced Component Profit

Browser tool for weekly profitability of EVE Online advanced components (market group 65), modelled on reactions.coalition.space.

## Run

No build step. Serve the folder (ES modules need http) and open it:

    python -m http.server 8765
    # http://localhost:8765/

## What it does

- Skills (Industry, Advanced Industry, Accounting, Broker Relations, standings) -> job time, sales tax, broker fee
- Structure (NPC station / Raitaru / Azbel / Sotiyo), up to 3 engineering rigs chosen from every Standup rig (grouped by M/L/XL size; a rig only applies to structures of its size and products it is valid for), scaled by system security
- System cost index (live from ESI), facility tax, SCC surcharge, EIV from ESI adjusted prices
- Per-blueprint ME/TE, runs per job
- Separate buy and sell hubs, instant vs order for each side, per-item price overrides
- Shipping ISK/m3 plus collateral % for inputs and outputs
- Weekly ranking, plus a greedy slot plan capped by a share of 7-day market volume

## Data

`data/*.json` is generated from the EVE Ref reference data (SDE):

    curl -O https://data.everef.net/reference-data/reference-data-latest.tar.xz
    mkdir ref && tar -xJf reference-data-latest.tar.xz -C ref
    python -I scripts/build_data.py ref

Triglavian components have no manufacturing blueprint in the SDE, so they are not listed.
Structure/rig numbers come from the dump; sales tax base (7.5%) and SCC surcharge (4%) are editable settings.

## All manufacturing tab

Covers every T1/structure product with a market BPO (`data/all.json`, built by `scripts/build_all_data.py`), using the same
settings as the main tab. Load market data, then load volumes for the filtered items; the suggested plan only considers
products whose volume is known. Filters hide faction/T2 items without obtainable BPOs, items needing Capital Ship
Construction, and products whose BPO is not sold in Jita.

The module is self-contained: `src/all.js` (loaded lazily by `src/tabs.js`) reads shared settings through the
`window.evecp` bridge in `src/app.js`.

## Reactions tab

Every reaction formula (`data/reactions.json`, built with `python -I scripts/build_all_data.py <ref dir> data reaction`),
using the same table, filters and suggested plan as the All manufacturing tab (`src/all.js` is configured per activity).

Reaction settings live in the sidebar: the Reactions skill (-4% time per level) under Skills, and under Manufacturing
location a separate reaction system, cost index, structure (Athanor, no bonus; Tatara, -25% time), three reactor rigs
(M-set rigs fit an Athanor, L-set a Tatara, each only helps its own reaction type) and facility tax. Reactor rig bonuses
are x1.0 in low-sec and wormholes and x1.1 in null-sec; reactions cannot run in high-sec. Formulas have no ME/TE.

## Reaction chain tab

Builds advanced components from inputs you either buy or react yourself (`src/chain.js`). Each input costs the cheaper of
its market price and its reaction cost, expanded recursively through nested reactions down to the raw moon goo, gas and fuel
blocks you would buy; a mode selector can force "always react" or "never react". The table compares chained and buy-all costs
per component. The suggested plan respects both slot pools (manufacturing slots and reaction slots), capital, market share and
raw-input supply, lists the reaction jobs to run, and copies a multibuy for the raw inputs. Component jobs follow lazy mode;
reactor jobs are sized to the need, so reactor slots are fractional.

## Character login (optional)

Log in with EVE SSO to pull your character's skills and hide every product, formula and plan entry you cannot build
(the "Only items my character can build" checkbox applies to all tabs). Your Industry, Advanced Industry, Reactions,
Accounting and Broker Relations levels are copied into the Skills settings when skills sync.

Setup (once, by whoever hosts the app): register an application at https://developers.eveonline.com/ with the scope
`esi-skills.read_skills.v1` and one callback URL per place the app is served from, exactly as shown in the Character panel
(for example `http://localhost:8765/` and your GitHub Pages URL), then paste its client ID into `src/config.js`. The flow
is OAuth2 with PKCE, so there is no client secret and the client ID is public. If `src/config.js` is left empty, each
visitor can paste a client ID into the Character panel instead. Tokens and the skill snapshot are kept in the browser's
localStorage only; "Log out" removes them.
