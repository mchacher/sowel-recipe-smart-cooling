# sowel-recipe-smart-cooling

Solar-aware AC optimizer for [Sowel](https://github.com/mchacher/sowel).
Designed from 62 days of real usage data on the reference installation
(see `specs/001-smart-cooling/`): the measured AC load ran almost entirely
on grid import while 30% of the solar production was injected — this
recipe shifts cooling into the surplus window and assists the household's
natural morning-airing habit.

## What it does

1. **Morning airing (notifications only)** — when the outdoor air is
   bearable (≥ configurable floor) and still cooler than indoors, the
   state key `openWindows` rises; when the outdoor temperature catches up
   with the indoor one, `closeWindows` rises. Map both keys to
   notifications (Administration → Notifications → add a mapping on the
   recipe instance, source keys `openWindows` / `closeWindows`). Each
   fires at most once per day. Requires Sowel ≥ 1.31.1 (boolean mappings
   notify on the rising edge only).
2. **Solar pre-cooling** — on a hot day (outdoor ≥ threshold, or indoor
   above the comfort setpoint), when the grid export stays above the
   surplus threshold for the hold duration, the AC is switched on at the
   pre-cool setpoint. When the surplus collapses, the comfort setpoint is
   restored.
3. **Comfort auto-on/off (v1.1, full-auto)** — when the indoor temperature
   exceeds the comfort setpoint by the auto-on margin (inside the
   sunrise→night-off window), the AC turns on at the comfort setpoint,
   surplus or not. When the house is cool enough (comfort minus the
   auto-off margin), the AC turns off. After a pre-cool episode the house
   coasts on the banked cold until the auto-off margin releases the unit.
4. **Night cut** — at a fixed time, the AC is switched off (once per day);
   the auto-on stays dormant until the next sunrise.

The recipe only issues orders on **phase transitions** (10 min minimum
between orders): whatever you set manually in between is never
overridden. While the airing window is open, neither pre-cooling nor the
comfort auto-on engages. The "open the windows" suggestion is bounded to
the morning (before 13:00).

## Slots

| Slot                | Default | Meaning                                          |
| ------------------- | ------- | ------------------------------------------------ |
| Air conditioner     | —       | thermostat with power + setpoint orders          |
| Grid meter          | —       | main energy meter, signed power (+import/−export)|
| Outdoor temperature | —       | equipment providing outdoor temp (weather station)|
| Indoor temperature  | AC probe | optional; a continuous sensor (weather indoor module) is strongly recommended — the AC's own probe freezes while off |
| Comfort setpoint    | 26 °C   | normal cooling setpoint                          |
| Pre-cool setpoint   | 24 °C   | setpoint while surplus is available              |
| Auto-on margin      | 1 °C    | AC on when indoor ≥ comfort + margin             |
| Auto-off margin     | 1 °C    | AC off when indoor ≤ comfort − margin            |
| Surplus threshold   | 500 W   | export considered usable                         |
| Surplus hold        | 15m     | sustained export before engaging                 |
| Hot day threshold   | 30 °C   | outdoor temp beyond which pre-cooling engages    |
| Night off time      | 23:00   | daily AC cut                                     |
| Airing notifications| on      | morning open/close notifications                 |
| Airing minimum      | 18 °C   | "bearable" floor to suggest opening              |
| Airing close margin | 0.5 °C  | close when T_out ≥ T_in − margin                 |

## State keys (visible in the instance detail, usable in notifications)

- `phase`: `idle | airing | precool | cooling | comfort | night_off`
- `openWindows` / `closeWindows`: daily notification booleans

## Development

```bash
npm install
npm test          # vitest, 18 scenarios
npm run build     # tsc → dist/
```

Releases: push a `v*` tag — the workflow builds and attaches
`sowel-recipe-smart-cooling-<version>.tar.gz` for the Sowel registry.
