# Architecture — Spec 001 Smart Cooling

New repo `mchacher/sowel-recipe-smart-cooling`, same skeleton as
`sowel-recipe-state-watch` v3 (manifest.json, package.json, src/index.ts,
src/index.test.ts, release workflow on `v*` tags). No core change.

## Inputs (event-driven, no polling)

Subscriptions on `equipment.data.changed`, all edge-guarded (last-seen
value per equipmentId+alias — re-fired unchanged events are dropped):

| Source          | Alias/category                  | Used for                       |
| --------------- | ------------------------------- | ------------------------------- |
| gridMeter slot  | alias `power` (signed W)        | export detection (value < 0)    |
| weather slot    | category `temperature_outdoor`  | T_ext                           |
| pac slot        | alias `temperature`             | T_int                           |
| pac slot        | alias `setpoint`, `power`       | manual-change awareness (log)   |

Timers: one interval clock (30 s) drives sustained-window accounting,
`nightOffTime` firing, and the daily rollover (local date string change).
`sunlight.changed` + `ctx.helpers.getSunlight()` give the morning anchor.

## State (ctx.state — persisted, WS-pushed)

| Key           | Type    | Purpose                                        |
| ------------- | ------- | ----------------------------------------------- |
| `phase`       | string  | idle/airing/precool/comfort/night_off (UI/debug)|
| `openWindows` | boolean | rising edge → user-mapped notification          |
| `closeWindows`| boolean | rising edge → user-mapped notification          |
| `day`         | string  | local date of the current daily latches         |
| `precoolKwh`  | number  | (nice-to-have) energy banked this day — v2      |

Daily latches (`openWindowsFiredOn`, `closeWindowsFiredOn`, `nightOffOn`)
are stored as local-date strings so a restart cannot re-fire them.

## Orders to the PAC

Via `ctx.equipmentManager` order execution on the pac equipment's order
bindings, resolved by category: `set_setpoint` and power toggle. Guards:

- Minimum 10 min between any two orders sent by the recipe.
- Orders only on **phase transitions**, never continuously — a manual
  change between transitions is left alone (AC5).
- Every order wrapped in try/catch; failure logs and keeps the phase (next
  transition retries naturally).

## Surplus detection

`exportW = max(0, -gridPower)`. Two accumulators on the 30 s clock:

- engage: `exportW ≥ surplusThreshold` continuously for `surplusHold` →
  precool (when day conditions met).
- disengage: `exportW < 100` continuously for 10 min → back to comfort.

Null/missing grid power resets the engage accumulator (fails safe: no
precool without live data).

## Test harness

Same pattern as state-watch tests: fake EventBus + fake state store +
`vi.useFakeTimers()`, a stub equipmentManager capturing executed orders.
No SQLite needed (ctx.state is injected).
