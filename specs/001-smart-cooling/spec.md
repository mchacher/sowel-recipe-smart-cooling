# Spec 001 — Smart Cooling recipe

New recipe `smart-cooling` (own repo `mchacher/sowel-recipe-smart-cooling`,
distributed via the registry like every recipe since spec 053).

## Context — grounded in 62 days of production data (2026-06-05 → 2026-08-05)

Measured on the owner's instance (sowelox):

- AC ("PAC" thermostat, Panasonic) consumed **438 kWh over 32 active days**
  (~13.7 kWh/active day), managed manually. Usual setpoint 26°C.
- Activation correlates with outdoor Tmax: rare below 32°C, 15/17 days at
  36-38°C.
- Manual starts cluster 10:00-13:00; consumption peaks 16:00-18:00 with a
  long evening tail 19:00→past midnight — **100% of AC energy runs during
  grid-import hours, only 12% overlaps solar injection**.
- Meanwhile **330 kWh were injected to the grid (30% of production)**, with
  the surplus concentrated 10:00-15:00. Even on hot AC days, 2.8 kWh/day
  is still injected.
- Morning: outdoor temperature crosses above indoor at **12:00 median**
  (11:00-13:00 on 49/62 days) — a long natural-cooling window.

## Goal

Automate the daily cooling cycle to shift AC energy from evening grid
import into the midday solar surplus, and assist the household's existing
morning-airing habit:

1. **Morning airing (notify only)**: notify "open the windows" when the
   morning window starts, "close the windows" when outdoor temperature
   catches up with indoor. The AC stays under recipe/user control (no
   forced block, per owner's decision).
2. **Solar pre-cooling**: when sustained grid export exists on a hot day,
   turn the AC on at a lower setpoint to bank cooling with energy that
   would otherwise be injected.
3. **Comfort**: outside surplus periods, restore the normal setpoint.
4. **Night cut**: switch the AC off at a fixed configurable time (the
   measured evening tail is 100% grid-powered).

Presence is explicitly **out of scope for v1** (owner's decision — no Away
mode or motion coverage exists on the instance today).

## Slots (user parameters)

| id                | type        | default | notes                                              |
| ----------------- | ----------- | ------- | --------------------------------------------------- |
| zone              | zone        | —       | standard                                            |
| pac               | equipment   | —       | thermostat, crossZone                               |
| gridMeter         | equipment   | —       | main_energy_meter, crossZone (signed power)         |
| weather           | equipment   | —       | weather, crossZone (outdoor temperature)            |
| comfortSetpoint   | number      | 26      | °C, 20-30                                           |
| precoolSetpoint   | number      | 24      | °C, 18-28; must be ≤ comfortSetpoint                |
| surplusThreshold  | number      | 500     | W of grid export to consider "surplus"              |
| surplusHold       | duration    | 15m     | sustained export before engaging (cloud filter)     |
| hotDayThreshold   | number      | 30      | °C outdoor beyond which pre-cooling is worth it     |
| nightOffTime      | time        | 23:00   | AC off at this time                                 |
| airingEnabled     | boolean     | true    | morning airing notifications                        |
| airingMinOutdoor  | number      | 18      | °C — "supportable" floor to suggest opening         |
| airingMargin      | number      | 0.5     | °C — close when T_ext ≥ T_int − margin              |

Indoor temperature comes from the PAC's own `temperature` binding (present
on Panasonic); outdoor from the weather equipment's
`temperature_outdoor`-category binding.

## Behavior (daily state machine)

States exposed via recipe state key `phase`:
`idle | airing | precool | comfort | night_off`.

- **airing** (notify only): from sunrise (ctx.helpers.getSunlight), when
  `T_ext ≥ airingMinOutdoor` and `T_ext < T_int − airingMargin` → state key
  `openWindows` rises (true) once per day. When `T_ext ≥ T_int −
  airingMargin` → `closeWindows` rises once per day. Both reset to false
  after the night rollover. Users map these two keys to notifications
  (same pattern as state-watch's `alarm`; boolean mappings notify on the
  rising edge only since core v1.31.1).
- **precool**: engage when all of — daytime (between sunrise and 17:30),
  `closeWindows` already fired or airing disabled, `T_ext ≥
  hotDayThreshold` **or** `T_int > comfortSetpoint`, and grid export ≥
  `surplusThreshold` sustained for `surplusHold`. Action: PAC power ON,
  setpoint = `precoolSetpoint`. Disengage when export collapses (< 100 W
  export, sustained 10 min): setpoint back to `comfortSetpoint` (power
  left ON — the unit idles by itself when satisfied). Re-engagement
  allowed (hysteresis via the two sustained windows).
- **comfort**: default daytime state after a precool episode; no orders
  sent except the setpoint restore on precool exit.
- **night_off**: at `nightOffTime`, PAC power OFF once. No re-arming until
  the next morning (manual restart always possible — the recipe only acts
  on transitions, it never fights a manual change between transitions).

## Explicitly out of scope (v1)

- Presence / Away handling.
- Controlling shutters (freecooling recipe owns night airing).
- Forecast-based planning (only live temperatures and live export).
- Blocking the AC during airing (notify only).
- Multi-AC coordination (single `pac` slot; instantiate twice if needed).

## Acceptance criteria

- [ ] AC1 — Morning: `openWindows` rises when conditions met, at most once
      per day; `closeWindows` rises at the ext/int crossing, at most once
      per day; both false again after night rollover.
- [ ] AC2 — Precool engages only after sustained export on a hot day, sets
      precool setpoint and turns the PAC on; disengages to comfort
      setpoint when the surplus collapses.
- [ ] AC3 — Cloud flapping (export oscillating around the threshold) does
      not cause order storms (sustained-hold on both edges; min 10 min
      between PAC orders).
- [ ] AC4 — At `nightOffTime` the PAC is switched off exactly once.
- [ ] AC5 — A manual user change between transitions is not overridden.
- [ ] AC6 — Recipe survives restart mid-day without duplicate
      notifications (daily-latch state persisted via ctx.state).
- [ ] AC7 — PAC offline / missing bindings → orders skipped with a log,
      never a throw.

## Edge cases

| Case                                             | Expected                                        |
| ------------------------------------------------ | ----------------------------------------------- |
| Equipment data re-fired with unchanged value     | Edge-guarded (track last-seen), no re-trigger   |
| Grid meter briefly reports null                  | Treated as "no surplus", timers reset           |
| Cool day (T_ext never ≥ hotDayThreshold)         | No precool; airing notifications still work     |
| T_ext never crosses T_int (rare cool day)        | `closeWindows` never fires that day — fine      |
| Restart during precool                           | Phase restored; no duplicate engage order       |
| nightOffTime during an active precool            | Night wins: power OFF                           |
| DST / day rollover                               | Daily latches keyed on local date string        |

## v1.1 addendum (2026-08-06) — full-auto ON/OFF

Owner decision after the first live morning: the AC must be fully managed.

- New phase `cooling` and two slots `comfortOnDelta` / `comfortOffDelta`
  (default 1°C each): auto-on when `T_int ≥ comfort + onDelta` (from
  idle/comfort, inside the sunrise→nightOffTime window), auto-off when
  `T_int ≤ comfort − offDelta` (from cooling only — precool deliberately
  drives below the band). Pre-cool exit now lands in `cooling` so the
  house coasts on banked cold until auto-off releases the unit.
- Auto-on is dormant after the night cut (rollover sets phase idle at
  midnight; without the time window a warm night would re-engage the AC).
- The "open the windows" suggestion is bounded to before 13:00 —
  otherwise any cool evening would fire it on days the morning window
  never opened.

## v1.2.0 addendum (2026-08-07) — dedicated indoor sensor

First-morning live incident: the PAC (Panasonic) held a frozen indoor
temperature (26°C for 11 h while off overnight), then jumped to the real
22°C at 06:52. Morning airing fired `openWindows` at dawn on the stale 26,
then `closeWindows` 24 min later when the fresh 22 arrived (T_ext 21.7 ≥
22 − margin) — a confusing pair, the "close" landing while outdoor was
still below indoor. The weather station's indoor module, by contrast,
tracked a smooth reliable curve all night (27.4 → 26.5).

Fix: new optional `indoorSensor` equipment slot (default = the AC's own
sensor, backward compatible). When set to a continuously-reporting sensor
(weather station indoor module, dedicated probe), T_int is read from it
for both airing and comfort auto on/off, avoiding the frozen-AC-sensor
trap. Slots renamed to describe what they provide: "Outdoor temperature"
(was "Weather station") and "Indoor temperature". Event matching made
independent so one equipment can feed both readings (a weather station
providing temperature_outdoor + temperature).
