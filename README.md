# Advanced Component Profit

Browser tool for weekly profitability of EVE Online advanced components (market group 65), modelled on reactions.coalition.space.

## Run

No build step. Serve the folder (ES modules need http) and open it:

    python -m http.server 8765
    # http://localhost:8765/

## What it does

- Skills (Industry, Advanced Industry, Accounting, Broker Relations, standings) -> job time, sales tax, broker fee
- Structure (NPC station / Raitaru / Azbel / Sotiyo), up to 3 engineering rigs scaled by system security
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
