# Plan — Spec 001 Smart Cooling

## Steps

1. Scaffold repo `mchacher/sowel-recipe-smart-cooling` (copy state-watch
   skeleton: manifest, package.json, tsconfig, release workflow).
2. `src/index.ts` — recipe class: slots, i18n FR/EN, validate, state
   machine, edge guards, order guards.
3. `src/index.test.ts` — full test plan below (vitest, fake timers).
4. `tsc` clean + tests green.
5. README (usage, notification mapping how-to for openWindows /
   closeWindows).
6. GitHub release v1.0.0 (tag → tarball workflow).
7. Registry PR on mchacher/sowel (`version` + `sha256` + owner mchacher).
8. Install on prod, create instance on zone Maison (PAC + Shelly Grid +
   Station Météo), map the two notifications, observe 2-3 days, tune
   thresholds.

## Test Plan

| # | Scenario                                                            | Expected                                             |
| - | ------------------------------------------------------------------- | ---------------------------------------------------- |
| 1 | validate: precoolSetpoint > comfortSetpoint                         | throws                                               |
| 2 | validate: missing pac/gridMeter/weather                             | throws                                               |
| 3 | Morning, T_ext 17→19 (≥ floor, < T_int−margin)                      | openWindows rises once                               |
| 4 | T_ext keeps rising to T_int−margin                                  | closeWindows rises once; openWindows false           |
| 5 | Same events re-fired with unchanged values                          | no duplicate state changes (edge guard)              |
| 6 | Hot day + export ≥ threshold sustained `surplusHold`                | PAC ON + precool setpoint ordered once               |
| 7 | Export flapping around threshold (short spikes)                     | no engage, zero orders                               |
| 8 | Engaged, export collapses < 100 W for 10 min                        | setpoint restored to comfort, single order           |
| 9 | Cool day (T_ext < hotDayThreshold, T_int ≤ comfort)                 | no precool despite export                            |
| 10| nightOffTime reached                                                | PAC OFF once; no re-fire same day                    |
| 11| nightOffTime during precool                                         | night wins, PAC OFF                                  |
| 12| Restart mid-day (state restored with latches set)                   | no duplicate notifications/orders                    |
| 13| Grid power null mid-hold                                            | engage accumulator resets                            |
| 14| Order execution throws (PAC offline)                                | logged, no crash, phase kept                         |
| 15| Manual setpoint change during comfort                               | recipe sends nothing until next transition           |

## Tasks

- [ ] P1 Scaffold repo
- [ ] P2 Recipe implementation
- [ ] P3 Tests (15 scenarios)
- [ ] P4 tsc + vitest green
- [ ] P5 README + i18n
- [ ] P6 Release v1.0.0 + registry PR
- [ ] P7 Install + tune on prod (owner-driven)
