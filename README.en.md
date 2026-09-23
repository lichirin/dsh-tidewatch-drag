# dsh-tidewatch

**DeepSeek peak/off-peak tide badge**: a floating badge beside the composer that tells you whether it's peak or off-peak right now, how long until the next phase, and how much this session costs.

- Status dot: **orange/red for peak, teal/green for off-peak**, readable at a glance
- Collapsed: `● 峰期 距谷期 03:33 · ¥0.12` (peak, 03:33 to off-peak, ¥0.12)
- Expanded (click to open): official peak windows (Beijing time), the active model and its tier prices, a price comparison of every model on sale, this session's token breakdown, per-model cost, currency switch
- **The expanded panel is draggable and resizable**: drag its header to move it, drag any of its **four edges or four corners** to resize (same rule as Windows window frames: the edge you grabbed moves, the opposite edge stays put); contents scroll when they overflow. Size and position are saved to localStorage and restored after a reload — double-click the header or press "复位面板" to reset
- Billing: **per-model price tiers** (DeepSeek currently sells `deepseek-flash` and `deepseek-v4-pro` at different rates), billed by the **actual timestamp of each call**, cache hit/miss charged separately, peak = off-peak × 2
- Currency: CNY display by default (fixed rate 6.82, matching the official CNY prices); one-click switch to USD (4 decimals) in the expanded panel
- Follows the GUI light/dark theme (`--dsw-*` tokens)

## Peak windows (official basis)

DeepSeek introduced peak/off-peak time-of-day pricing on 2026-08-17:

| Window (UTC) | Beijing time | Tier |
|---|---|---|
| 01:00 – 04:00 | 09:00 – 12:00 | peak |
| 04:00 – 06:00 | 12:00 – 14:00 | off-peak |
| 06:00 – 10:00 | 14:00 – 18:00 | peak |
| 10:00 – next 01:00 | 18:00 – next 09:00 | off-peak |

Off-peak prices are half of peak prices. The badge judges the current tier by the UTC windows (official definition); the table display uses Beijing time.

**Weekend rule**: officially, peak hours run **Monday–Friday only** (Beijing-time working days 09:00–12:00 and 14:00–18:00), so Saturdays and Sundays (UTC calendar days) are billed at off-peak prices all day with no switch; the next phase switch lands at the first peak window of the following Monday.

## Billing model

- **Price tier is chosen by the API model name** (official 2026-09-10 changelog and pricing-page footnotes):

  | API model name | Notes |
  |---|---|
  | `deepseek-flash` | DeepSeek-V4.1-Flash, on sale |
  | `deepseek-v4-pro` | DeepSeek-V4-Pro-0813; DeepSeek confirmed it **keeps serving V4 Pro after 2026-09-14 with unchanged billing** |
  | `deepseek-v4-flash`, `deepseek-v4-flash-vision-exp` | retired models, **temporarily** routed to V4.1 Flash and billed at the **Flash** price |
  | anything else | estimated at the Flash price, with a one-time note in the host log |

- Official list prices (CNY / 1M tokens):

  | Model | Bucket | Off-peak | Peak (×2) |
  |---|---|---|---|
  | `deepseek-flash` | input · cache hit | ¥0.02 | ¥0.04 |
  | `deepseek-flash` | input · cache miss | ¥1 | ¥2 |
  | `deepseek-flash` | output | ¥4 | ¥8 |
  | `deepseek-v4-pro` | input · cache hit | ¥0.15 | ¥0.30 |
  | `deepseek-v4-pro` | input · cache miss | ¥4.5 | ¥9 |
  | `deepseek-v4-pro` | output | ¥13.5 | ¥27 |

- The ledger stores USD (= official CNY price ÷ 6.82). Cost = input-miss × cacheMiss + output × output + (cache-read + cache-write) × cacheHit. The DeepSeek API reports no separate cache-write bucket and no separate reasoning charge (reasoning tokens are already counted as output), so neither is charged extra
- The **official CNY table is the authoritative source** (`rates.cny` in `lib/pricing.js`); the USD ledger is derived from it
- Calls before the peak-era boundary (2026-08-16 16:00 UTC) are billed at the then-current base price (historical correctness)
- **Price changes never rewrite history**: no projection `stateVersion` bump is made for a price change or a new model tier, so cached sessions keep the amounts computed at the time (they really did cost that); a session that was never billed starts from the **current** price and **current** model tier
- Each call is billed at the tier of its **event timestamp**, so costs do not drift across a peak/off-peak switch; when the model changes mid-session, each call is billed at **its own model's** rate
- **Reopening a session never re-prices it**: the host computes each amount as the call happens and persists it with the session-projection cache; on reopen the badge and the per-model breakdown **show the saved amounts directly**. So "¥5 spent off-peak still reads ¥5 when reopened during peak" — history is never recomputed as current tier × historical tokens
- The ledger stores USD; display converts via the fixed 6.82 rate to CNY (default, matching the official CNY prices) or shows USD directly
- The panel's "current tier prices / official model prices" rows are **current-rate information**, not part of the amount maths. Recomputing at the current tier is only a fallback for old caches that genuinely lack a stored `cost` field

## Install

> Requires Node.js ≥ 20 + DeepSeek Harness (a build with the `dsh plugin` command).

```sh
# from npm (once published)
dsh plugin --profile web add dsh-tidewatch

# or a local directory (development)
dsh plugin --profile web add link:./dsh-tidewatch
```

Restart `dsh web` after installing.

## Usage

- The badge floats to the right of the composer, vertically centered with it; on narrow windows it moves above the composer instead, never covering the input area or the built-in stats line
- Click the badge to expand/collapse the detail panel: windows, the active model and its tier prices, all-model price comparison (the active one is tagged), token breakdown, per-model cost, currency switch (¥ / $)
- Click the "Session cost" row to expand the **per-model cost breakdown** (e.g. `deepseek-flash` and `deepseek-v4-pro` tokens and cost listed separately; the total equals the sum of per-model costs)
- Currency choice applies immediately and persists; CNY shows 2 decimals, USD 4 decimals
- Switching models mid-session updates the badge's "active model" and price rows live from the latest request header

### Panel direction & self-placement

The panel is **fixed-positioned**; its coordinates come from `placePanel()`, computed from the badge's live rect and the free viewport space, so it can never end up off-screen:

| Situation | Behaviour |
|---|---|
| Room above the badge (default) | Opens upward, its bottom edge 10px above the badge |
| Not enough room above (long session scrolled down, composer pinned to the viewport top) | **Flips below the badge**, top edge 10px under it |
| Not enough room to the right of the badge | Flips to the badge's left; when neither side fits it hugs the viewport edge |
| Short viewport / taller content | `maxHeight` is capped to the free space; the rest scrolls inside the panel |
| Custom size + offset, then a window resize | The offset is a delta from the automatic position, so it re-adapts and is never flung off-screen |

- The direction decision uses a fixed threshold (flip only when the space above is below the 180px minimum height), so it cannot oscillate between "flip up → fill → flip down"
- A single drag/resize is clamped, so the persisted offset always stays within "panel pinned to the viewport margin" — no ±thousands of pixels get stored
- When opening upward the panel anchors its **bottom** edge via CSS `bottom` (instead of estimating the top edge from `maxHeight`), so with an adaptive height the bottom still sits 10px above the badge even when the content is shorter than the available space; opening downward anchors the top edge

### Panel drag & border resize (mirrors the Windows 11 non-client hit test)

Once the panel is dragged or resized it switches to a fixed-size, internally scrolling mode and gains extra interactions:

| Action | Effect |
|---|---|
| Drag the panel **header** | Moves the whole panel (the window's `HTCAPTION`); the offset is recorded relative to the automatic placement |
| Drag any **edge or corner** | Resizes (the `WM_NCHITTEST` `HTLEFT…HTBOTTOMRIGHT` zones): **the edge you grabbed moves, the opposite edge stays put**; a corner moves both axes |
| **Double-click the header** / press **"复位面板"** | Clears the custom geometry and returns to the default size, re-hugging the badge |

Hit bands and cursors follow Explorer's numbers (the three constants in `lib/client.js` are the single source; the panel passes them to CSS as inline `--tw-band / --tw-band-top / --tw-outset`):

| Location | Band | Cursor | Behaviour |
|---|---|---|---|
| Left / right edge | 8px (= `SM_CXSIZEFRAME + SM_CXPADDEDBORDER`) | `ew-resize` | that edge follows the pointer, the opposite one stays |
| Bottom edge | 8px | `ns-resize` | bottom follows, top stays |
| **Top edge** | **2px** | `ns-resize` | top follows, bottom stays |
| Four corners | 8px × matching band | `nwse` / `nesw` | both axes move, the opposite corner stays |

- **The top edge is deliberately only 2px**, for the same reason Explorer does it: Windows 11's Explorer also leaves just 2px of resizing at the top, because the tab strip needs the whole top strip to stay clickable. Here that top strip is the drag-to-move header, so a full 8px top band would turn the header's first 8 pixels into a resize zone and make the header undraggable (`HTTOP` and `HTCAPTION` are mutually exclusive)
- The bands extend **3px outside** the panel (the DWM "invisible border": on Windows, 7 of the 8 grab pixels sit outside the visible frame), so grabbing feels wider than it looks; since that overhang covers UI just outside the panel, it is kept at 3px
- The bands cover only the border ring — the **content area in the middle is untouched**; frame and content are separate layers (`.tw-rs` / `.tw-panel-body`), so scrolling the content never scrolls the resize zones away
- When clamped to the minimum size (240×180) or a viewport edge, **the grabbed edge stops and the anchored opposite edge is not pushed** (the `ptMinTrackSize` behaviour)
- **No visible resize handle**: the only resize affordance is the border hit band (eight zones with per-zone cursors), like a real window; discoverability comes from the cursor change and the header tooltip ("drag any edge or corner to resize")
- Geometry lives in localStorage (`dsh-tidewatch-panel-v1`) and survives a reload; it is clamped to the viewport (8px margin), with size limits of 240×180 minimum and 900×1200 maximum. A panel already pinned to a viewport edge stays pinned instead of overflowing
- Until customized the height stays adaptive (as tall as its content, bounded only by `maxHeight`), the width defaults to 320px, and the "复位面板" button only appears once customized
- Pointer-downs on header buttons do not start a move drag, so clicks and resizing never conflict
- **Press Esc to cancel**: pressing Esc mid-drag or mid-resize aborts the operation and restores the previous size and position (the Win32 move/size loop cancellation), writing nothing to localStorage
- The `SetCapture` counterpart: the pointer is captured with `setPointerCapture` on pointer-down, so events survive leaving the browser window or crossing other elements; during the loop the cursor stays locked as a resize cursor (even when the pointer leaves the border) and text selection is suppressed
- On touch / pen (`pointer: coarse`) the bands widen the way Windows does — **14px sides, 6px top, 6px outset** — because a 2px top edge is ungrabbable with a finger

## Layout

```
dsh-tidewatch
├── package.json          # dsh.bundle.patch + dsh.client.platform manifest
├── cordis.patch.yml      # bundle patch row
├── lib/
│   ├── pricing.js        # pure functions: windows, isPeakHour/peakPhaseAt, per-model price table, priceRuleFor, costOf
│   ├── index.js          # host: costUsage session projection (billed per model + per event time)
│   └── client.js         # browser: floating badge + self-placing / draggable / resizable panel (__ModuleLoader__ bundle)
├── test/
│   ├── verify.mjs        # price table / peak math / model tiers / client-host constant sync (29 checks)
│   ├── projection.mjs    # session-projection integration (17 checks)
│   ├── panel-box.mjs     # placement direction & size clamping pure functions (11 checks)
│   └── panel.mjs         # panel drag / resize / cost-semantics / clamping / reset (34 checks)
└── docs/PORTING.md       # adaptation notes for other hosts
```

## Data flow

```
model-call usage blocks (assistant/chunk, assistant/message events)
        │  lib/index.js: costUsage session projection (zod-schema validated)
        ▼
  token buckets + USD cost (price rule from the request-header model, tier from event time)
        │  useProjection('costUsage') (browser)
        ▼
  lib/client.js: badge rendering (per-second countdown + per-model cost + FX conversion)
```

## Develop & verify

```sh
node test/verify.mjs      # price table / peak math / model tiers / client-host constant sync (29 checks)
node test/projection.mjs  # session-projection integration: per-model billing, streaming replacement (17 checks)
node test/panel-box.mjs   # placement direction / size clamping pure functions (11 checks, no DOM)
node test/panel.mjs       # panel interactions: drag / resize / cost-semantics regressions / clamping / reset (34 checks)
```

`verify.mjs` parses `RATE_RULES` and `FIXED_FX` out of the `lib/client.js` source and compares them against
`lib/pricing.js`'s `rates.cny` and `CNY_PER_USD`, so the two constant sets can never silently drift apart.

`panel-box.mjs` asserts `computePanelBox()` directly — it decides the panel's opening direction and size clamping,
which is the most regression-prone part (e.g. the panel must flip below the badge, and stay on-screen, when the
composer is pinned to the viewport top).

`panel.mjs` renders the real component through a minimal React harness and dispatches pointer events directly,
so the panel's drag/resize/flip behaviour (including clamping, persistence and reset) is regression-covered —
re-run it whenever you touch the interaction code.

> **Prepare `zod` before running the tests locally**: the host `lib/index.js` depends on `zod`, but this repo is
> mounted via `link:` and ships no `node_modules`, so `node test/projection.mjs` fails with
> `Cannot find package 'zod'`. Pick either:
>
> ```sh
> pnpm install                                   # install per pnpm-lock.yaml
> # or reuse the copy shipped with DSH (Windows)
> New-Item -ItemType Junction -Path node_modules\zod -Target "$env:USERPROFILE\.dsh\profiles\node_modules\zod"
> ```
>
> `test/verify.mjs` only needs pure functions and runs without `zod`.

## Known limitations

- Prices are built in (since 2026-09-10: `deepseek-flash` off-peak ¥0.02 / ¥1 / ¥4 and `deepseek-v4-pro` off-peak ¥0.15 / ¥4.5 / ¥13.5, peak = ×2). **When DeepSeek changes prices or the models on sale, update both `lib/pricing.js` (billing) and `RATE_RULES` in `lib/client.js` (display) manually**; `test/verify.mjs` guards their consistency but cannot detect an official price change for you
- Any model name not in the table is estimated at the Flash price (with a one-time host log note). If your DSH config uses a non-DeepSeek provider (e.g. the `llm-pi-ai` opencode route), those model names are not in DeepSeek's price table and their amounts are Flash-price estimates only
- Tier judgement is fixed to UTC (official definition); the window table displays Beijing time (UTC+8)
- Cost is USD-ledger × fixed 6.82 rate for CNY (matching the official CNY prices); switchable to USD in the expanded panel. USD unit prices keep 4 decimals, so the cache-hit tier (¥0.02/M) has few significant digits in the USD view — use the CNY view for reconciliation
- The panel's custom geometry lives only in this browser's localStorage (`dsh-tidewatch-panel-v1`); another browser (or a cleared cache) starts from the default. The panel still anchors to the badge, so moving the badge drags the panel along — a custom offset is recorded relative to that base, never detaching from the badge
- The **spent amount** persists with DSH's session-projection cache (`~/.dsh/storages/session_projcache/`), so closing/reopening a conversation or restarting the app keeps it. That cache is regenerable derived data, though: deleting it, or moving to another machine/home directory, makes DSH **replay the session log**, and historical calls are then re-priced at the **current** rates (the conversation itself is safe — it lives in `~/.dsh/sessions/`). If you need the original amounts to survive a cleared cache, an independent ledger file is required
- Billing/cache fixes are host-side: after changing `lib/index.js` you must **restart `dsh web`** (otherwise the old cache validation and billing logic stay in effect)

## Credits & license

The peak math (isPeakHour / peakPhaseAt / tierFor / costOf) and the session-projection structure are adapted from [dsh-cost-meter](https://github.com/Han-1413141/dsh-cost-meter) (MIT License), rewritten for a minimal footprint.

[MIT](LICENSE) © 2026 KhalilYamber
