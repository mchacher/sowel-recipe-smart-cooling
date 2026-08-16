import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import {
  createRecipe,
  hmToMinutes,
  exportWatts,
  localDay,
  prePeakOffPeakWindow,
} from "./index.js";

// ============================================================
// Test harness — fake RecipeContext
// ============================================================

type Handler = (event: Record<string, unknown>) => void;

interface FakeTariff {
  configured: boolean;
  offPeakToday: Array<{ start: string; end: string }>;
  isOffPeakNow: boolean | null;
}

function makeCtx(overrides?: {
  sunrise?: string;
  sunset?: string;
  pacOrders?: Array<{ alias: string; category?: string }>;
  /** When set, ctx.helpers.getTariff is exposed (Sowel >= 1.37); absent otherwise. */
  tariff?: FakeTariff;
  /** When set, ctx.helpers.energy is exposed (Sowel >= 1.39, spec 140). */
  energy?: unknown;
}) {
  const handlers: Handler[] = [];
  const stateMap = new Map<string, unknown>();
  const orders: Array<{ equipmentId: string; alias: string; value: unknown }> =
    [];
  const logs: string[] = [];
  const tariffOverride = overrides?.tariff;

  const equipments: Record<
    string,
    { name: string; dataBindings: unknown[]; orderBindings: unknown[] }
  > = {
    "pac-1": {
      name: "PAC",
      dataBindings: [
        { alias: "temperature", category: "temperature", value: 27 },
        { alias: "setpoint", category: "setpoint", value: 26 },
      ],
      orderBindings: overrides?.pacOrders ?? [
        { alias: "power", category: "toggle_power" },
        { alias: "setpoint", category: "set_setpoint" },
      ],
    },
    "grid-1": {
      name: "Shelly Grid",
      dataBindings: [{ alias: "power", category: "power", value: 200 }],
      orderBindings: [],
    },
    "weather-1": {
      name: "Station",
      dataBindings: [
        { alias: "temperature", category: "temperature_outdoor", value: 20 },
        { alias: "temperature_2", category: "temperature", value: 25 }, // indoor module
      ],
      orderBindings: [],
    },
    "sensor-1": {
      name: "Capteur Salon",
      dataBindings: [
        { alias: "temperature", category: "temperature", value: 25 },
      ],
      orderBindings: [],
    },
  };

  const ctx = {
    eventBus: {
      onType: (_type: string, h: Handler) => {
        handlers.push(h);
        return () => {
          const i = handlers.indexOf(h);
          if (i >= 0) handlers.splice(i, 1);
        };
      },
    },
    equipmentManager: {
      getByIdWithDetails: (id: string) => equipments[id] ?? null,
    },
    zoneManager: {
      getById: (id: string) =>
        id === "zone-1" ? { id, name: "Maison" } : null,
    },
    logger: {
      info: () => {},
      warn: () => {},
      error: () => {},
      debug: () => {},
    },
    state: {
      get: (k: string) => stateMap.get(k),
      set: (k: string, v: unknown) => stateMap.set(k, v),
      delete: (k: string) => stateMap.delete(k),
      clear: () => stateMap.clear(),
    },
    log: (m: string) => logs.push(m),
    helpers: {
      parseDuration: (v: unknown) => {
        const m = /^(\d+)([smh])$/.exec(String(v));
        if (!m) return 0;
        const mult = { s: 1000, m: 60_000, h: 3_600_000 }[
          m[2] as "s" | "m" | "h"
        ];
        return Number(m[1]) * mult;
      },
      formatDuration: (ms: number) => `${ms}ms`,
      getSunlight: () => ({
        sunrise: overrides?.sunrise ?? "06:30",
        sunset: overrides?.sunset ?? "21:00",
        isDaylight: true,
      }),
      ...(tariffOverride !== undefined
        ? { getTariff: () => tariffOverride }
        : {}),
      ...(overrides?.energy !== undefined ? { energy: overrides.energy } : {}),
    },
    dispatchOrder: (equipmentId: string, alias: string, value: unknown) => {
      orders.push({ equipmentId, alias, value });
      return Promise.resolve();
    },
  };

  return { ctx, handlers, stateMap, orders, logs };
}

// Fake capacity arbiter (spec 140). `grant()`/`revoke()` drive the recipe's
// onGranted/onRevoked callbacks, exactly as the real arbiter would.
function makeArbiter(opts?: { enabled?: boolean; denied?: boolean }) {
  const enabled = opts?.enabled ?? true;
  let status: "pending" | "granted" | "denied" | "released" = "pending";
  let req: { onGranted: () => void; onRevoked: (r: string) => void } | null =
    null;
  let releaseCount = 0;
  const handle = {
    id: "claim-1",
    status: () => status,
    deniedReason: opts?.denied ? "not-profiled" : undefined,
    release: () => {
      status = "released";
      releaseCount++;
    },
  };
  return {
    energy: {
      claimCapacity: (r: {
        onGranted: () => void;
        onRevoked: (r: string) => void;
      }) => {
        req = r;
        status = opts?.denied ? "denied" : "pending";
        return handle;
      },
      getCapacityState: () => ({
        enabled,
        availableSurplusW: enabled ? 800 : null,
        grants: [] as Array<{
          equipmentId: string;
          watts: number;
          sinceIso: string;
        }>,
      }),
    },
    grant: () => {
      if (status === "pending") {
        status = "granted";
        req?.onGranted();
      }
    },
    revoke: () => {
      if (status === "granted") {
        status = "pending";
        req?.onRevoked("surplus-deficit");
      }
    },
    claimed: () => req !== null && status !== "released",
    released: () => releaseCount > 0,
  };
}

const PARAMS = {
  zone: "zone-1",
  pac: "pac-1",
  gridMeter: "grid-1",
  weather: "weather-1",
  comfortSetpoint: 26,
  precoolSetpoint: 24,
  surplusThreshold: 500,
  surplusHold: "15m",
  hotDayThreshold: 30,
  nightOffTime: "23:00",
  airingEnabled: true,
  airingMinOutdoor: 18,
  airingMargin: 0.5,
};

function emit(
  h: Handler[],
  equipmentId: string,
  alias: string,
  value: unknown,
) {
  for (const fn of [...h]) {
    fn({ type: "equipment.data.changed", equipmentId, alias, value });
  }
}

describe("helpers", () => {
  it("hmToMinutes parses and rejects", () => {
    expect(hmToMinutes("23:00")).toBe(1380);
    expect(hmToMinutes("bad")).toBeNaN();
  });
  it("exportWatts sign convention", () => {
    expect(exportWatts(-1200)).toBe(1200);
    expect(exportWatts(300)).toBe(0);
    expect(exportWatts(null)).toBeNull();
    expect(exportWatts(NaN)).toBeNull();
  });

  it("prePeakOffPeakWindow selects the afternoon slot only", () => {
    const night = { start: "00:04", end: "05:34" };
    const afternoon = { start: "14:34", end: "17:04" };
    const wrapped = { start: "22:00", end: "06:00" };
    const NIGHT_OFF = 23 * 60;

    expect(
      prePeakOffPeakWindow([night, afternoon, wrapped], NIGHT_OFF),
    ).toEqual({
      startMin: 14 * 60 + 34,
      endMin: 17 * 60 + 4,
    });
    // night-only contracts (with or without midnight wrap) → no window
    expect(prePeakOffPeakWindow([night, wrapped], NIGHT_OFF)).toBeNull();
    expect(prePeakOffPeakWindow([], NIGHT_OFF)).toBeNull();
    // ends before noon → banks cold the day then wastes
    expect(
      prePeakOffPeakWindow([{ start: "09:00", end: "11:30" }], NIGHT_OFF),
    ).toBeNull();
    // ends past the night cut → the night cut's territory
    expect(
      prePeakOffPeakWindow([{ start: "22:00", end: "23:30" }], NIGHT_OFF),
    ).toBeNull();
    // several candidates → the latest-ending one (closest to the peak)
    expect(
      prePeakOffPeakWindow(
        [
          { start: "12:00", end: "13:00" },
          { start: "15:00", end: "17:00" },
        ],
        NIGHT_OFF,
      ),
    ).toEqual({ startMin: 15 * 60, endMin: 17 * 60 });
    // malformed slots are ignored
    expect(
      prePeakOffPeakWindow([{ start: "bad", end: "17:00" }], NIGHT_OFF),
    ).toBeNull();
  });
});

describe("validate", () => {
  it("throws when precoolSetpoint > comfortSetpoint", () => {
    const { ctx } = makeCtx();
    expect(() =>
      createRecipe().validate({ ...PARAMS, precoolSetpoint: 27 }, ctx as never),
    ).toThrow(/lower/);
  });

  it("throws when an equipment slot is missing or unknown", () => {
    const { ctx } = makeCtx();
    expect(() =>
      createRecipe().validate({ ...PARAMS, pac: undefined }, ctx as never),
    ).toThrow();
    expect(() =>
      createRecipe().validate({ ...PARAMS, weather: "nope" }, ctx as never),
    ).toThrow(/not found/i);
  });

  it("throws when the AC lacks power/setpoint orders", () => {
    const { ctx } = makeCtx({
      pacOrders: [{ alias: "power", category: "toggle_power" }],
    });
    expect(() => createRecipe().validate(PARAMS, ctx as never)).toThrow(
      /setpoint/i,
    );
  });
});

describe("smart-cooling instance", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  function startAt(iso: string, ctxBundle = makeCtx()) {
    vi.setSystemTime(new Date(iso));
    const inst = createRecipe().createInstance(PARAMS, ctxBundle.ctx as never);
    return { ...ctxBundle, inst };
  }

  it("morning: openWindows rises once, then closeWindows at the crossing", () => {
    const b = startAt("2026-08-06T07:00:00");
    emit(b.handlers, "pac-1", "temperature", 27);
    emit(b.handlers, "weather-1", "temperature", 19); // >= 18 floor, < 26.5
    expect(b.stateMap.get("openWindows")).toBe(true);
    expect(b.stateMap.get("phase")).toBe("airing");

    // Re-fired unchanged event → no duplicate (latch already set, still true)
    emit(b.handlers, "weather-1", "temperature", 19);
    expect(b.stateMap.get("openWindows")).toBe(true);

    // T_ext catches up with T_int → close notification, and the hot house
    // (27 ≥ 26+1) immediately triggers the comfort auto-on.
    emit(b.handlers, "weather-1", "temperature", 26.5);
    expect(b.stateMap.get("openWindows")).toBe(false);
    expect(b.stateMap.get("closeWindows")).toBe(true);
    expect(b.stateMap.get("phase")).toBe("cooling");
    expect(b.orders).toEqual([
      { equipmentId: "pac-1", alias: "power", value: true },
      { equipmentId: "pac-1", alias: "setpoint", value: 26 },
    ]);
    b.inst.stop();
  });

  it("morning below the bearable floor: no openWindows", () => {
    const b = startAt("2026-08-06T07:00:00");
    emit(b.handlers, "weather-1", "temperature", 14); // below 18 floor
    emit(b.handlers, "pac-1", "temperature", 24);
    expect(b.stateMap.get("openWindows")).toBe(false);
    b.inst.stop();
  });

  it("precool engages one step below comfort, then walks the setpoint down to the floor while exporting (v2.0)", () => {
    const ctxBundle = makeCtx();
    vi.setSystemTime(new Date("2026-08-06T13:00:00"));
    const inst = createRecipe().createInstance(
      { ...PARAMS, comfortSetpoint: 26, precoolFloor: 22 },
      ctxBundle.ctx as never,
    );
    const b = { ...ctxBundle, inst };
    b.stateMap.set("closeWindowsOn", "2026-08-06"); // airing done
    emit(b.handlers, "pac-1", "temperature", 26.5); // inside band: no auto-on
    emit(b.handlers, "weather-1", "temperature", 33);
    emit(b.handlers, "grid-1", "power", -1500); // exporting 1.5 kW

    vi.advanceTimersByTime(16 * 60_000); // > surplusHold → engage
    expect(b.stateMap.get("phase")).toBe("precool");
    expect(b.orders).toEqual([
      { equipmentId: "pac-1", alias: "power", value: true },
      { equipmentId: "pac-1", alias: "setpoint", value: 25.5 }, // comfort 26 - 0.5 step
    ]);

    // Sustained export: the setpoint walks down one 0.5 °C step per 5 min.
    vi.advanceTimersByTime(5 * 60_000);
    expect(b.orders.at(-1)).toEqual({
      equipmentId: "pac-1",
      alias: "setpoint",
      value: 25,
    });
    vi.advanceTimersByTime(5 * 60_000);
    expect(b.orders.at(-1)).toEqual({
      equipmentId: "pac-1",
      alias: "setpoint",
      value: 24.5,
    });

    // Keeps stepping down while exporting, bounded at the configured floor (22).
    for (let i = 0; i < 10; i++) vi.advanceTimersByTime(5 * 60_000);
    expect(b.orders.at(-1)).toEqual({
      equipmentId: "pac-1",
      alias: "setpoint",
      value: 22,
    });
    const floorOrders = b.orders.filter(
      (o) => o.alias === "setpoint" && o.value === 22,
    ).length;
    expect(floorOrders).toBe(1); // reaches the floor once, then holds (no storm)
    inst.stop();
  });

  it("eases the setpoint back up while granted but importing past the deadband (v2.0)", () => {
    const arb = makeArbiter();
    const ctxBundle = makeCtx({ energy: arb.energy });
    vi.setSystemTime(new Date("2026-08-06T13:00:00"));
    const inst = createRecipe().createInstance(
      { ...PARAMS, comfortSetpoint: 26, precoolFloor: 22 },
      ctxBundle.ctx as never,
    );
    const b = { ...ctxBundle, inst };
    b.stateMap.set("closeWindowsOn", "2026-08-06");
    emit(b.handlers, "pac-1", "temperature", 26.5);
    emit(b.handlers, "weather-1", "temperature", 33); // hot → claim held
    emit(b.handlers, "grid-1", "power", -1500);
    arb.grant();
    vi.advanceTimersByTime(1);
    expect(b.orders.at(-1)).toEqual({
      equipmentId: "pac-1",
      alias: "setpoint",
      value: 25.5,
    }); // engage

    // Still granted (the arbiter tolerates the import), but the grid now imports
    // 600 W (> deadband) → the setpoint eases back up toward comfort, capped there.
    emit(b.handlers, "grid-1", "power", 600);
    vi.advanceTimersByTime(5 * 60_000);
    expect(b.orders.at(-1)).toEqual({
      equipmentId: "pac-1",
      alias: "setpoint",
      value: 26,
    });
    vi.advanceTimersByTime(15 * 60_000);
    expect(b.orders.at(-1)).toEqual({
      equipmentId: "pac-1",
      alias: "setpoint",
      value: 26,
    }); // held at comfort
    inst.stop();
  });

  it("holds the setpoint inside the surplus deadband, no order storm (v2.0)", () => {
    const arb = makeArbiter();
    const ctxBundle = makeCtx({ energy: arb.energy });
    vi.setSystemTime(new Date("2026-08-06T13:00:00"));
    const inst = createRecipe().createInstance(
      { ...PARAMS, comfortSetpoint: 26, precoolFloor: 22 },
      ctxBundle.ctx as never,
    );
    const b = { ...ctxBundle, inst };
    b.stateMap.set("closeWindowsOn", "2026-08-06");
    emit(b.handlers, "pac-1", "temperature", 26.5);
    emit(b.handlers, "weather-1", "temperature", 33);
    emit(b.handlers, "grid-1", "power", -1500);
    arb.grant();
    vi.advanceTimersByTime(1); // engage, setpoint 25.5
    const afterEngage = b.orders.length;

    // Grid near balance (within ±150 W): neither branch fires → no walk orders.
    emit(b.handlers, "grid-1", "power", 80);
    vi.advanceTimersByTime(30 * 60_000);
    expect(b.orders.length).toBe(afterEngage);
    inst.stop();
  });

  it("flapping export never engages", () => {
    const b = startAt("2026-08-06T13:00:00");
    emit(b.handlers, "pac-1", "temperature", 26.5); // inside band: no auto-on
    emit(b.handlers, "weather-1", "temperature", 33);
    for (let i = 0; i < 10; i++) {
      emit(b.handlers, "grid-1", "power", -1500);
      vi.advanceTimersByTime(5 * 60_000); // 5 min export
      emit(b.handlers, "grid-1", "power", 200); // import again
      vi.advanceTimersByTime(60_000);
    }
    expect(b.orders).toHaveLength(0);
    b.inst.stop();
  });

  it("cool day: export alone never engages", () => {
    const b = startAt("2026-08-06T13:00:00");
    emit(b.handlers, "weather-1", "temperature", 24); // not hot
    emit(b.handlers, "pac-1", "temperature", 25); // below comfort
    emit(b.handlers, "grid-1", "power", -2000);
    vi.advanceTimersByTime(60 * 60_000);
    expect(b.orders).toHaveLength(0);
    b.inst.stop();
  });

  it("precool disengages to comfort setpoint when the surplus collapses", () => {
    const b = startAt("2026-08-06T13:00:00");
    emit(b.handlers, "weather-1", "temperature", 33);
    emit(b.handlers, "grid-1", "power", -1500);
    vi.advanceTimersByTime(16 * 60_000);
    expect(b.stateMap.get("phase")).toBe("precool");

    emit(b.handlers, "grid-1", "power", 400); // import: export < 100 W
    vi.advanceTimersByTime(11 * 60_000);
    expect(b.orders.at(-1)).toEqual({
      equipmentId: "pac-1",
      alias: "setpoint",
      value: 26,
    });
    expect(b.stateMap.get("phase")).toBe("cooling"); // AC stays on, auto-off takes over
    b.inst.stop();
  });

  it("null grid power resets the engage accumulator", () => {
    const b = startAt("2026-08-06T13:00:00");
    emit(b.handlers, "pac-1", "temperature", 26.5); // inside band: no auto-on
    emit(b.handlers, "weather-1", "temperature", 33);
    emit(b.handlers, "grid-1", "power", -1500);
    vi.advanceTimersByTime(10 * 60_000);
    emit(b.handlers, "grid-1", "power", null); // data loss mid-hold
    vi.advanceTimersByTime(10 * 60_000);
    expect(b.orders).toHaveLength(0);
    b.inst.stop();
  });

  it("no precool while the airing window is open", () => {
    const b = startAt("2026-08-06T09:00:00");
    emit(b.handlers, "pac-1", "temperature", 27);
    emit(b.handlers, "weather-1", "temperature", 20); // airing opens
    expect(b.stateMap.get("phase")).toBe("airing");
    emit(b.handlers, "pac-1", "temperature", 30.5); // hot inside
    emit(b.handlers, "grid-1", "power", -2000);
    vi.advanceTimersByTime(30 * 60_000);
    expect(b.orders).toHaveLength(0);
    b.inst.stop();
  });

  it("night cut fires once at nightOffTime, even during precool", () => {
    const b = startAt("2026-08-06T22:50:00");
    b.stateMap.set("phase", "precool"); // simulate engaged evening precool
    emit(b.handlers, "weather-1", "temperature", 31);
    vi.advanceTimersByTime(11 * 60_000); // crosses 23:00
    const off = b.orders.filter(
      (o) => o.alias === "power" && o.value === false,
    );
    expect(off).toHaveLength(1);
    expect(b.stateMap.get("phase")).toBe("night_off");

    vi.advanceTimersByTime(30 * 60_000); // still after 23:00
    expect(
      b.orders.filter((o) => o.alias === "power" && o.value === false),
    ).toHaveLength(1);
    b.inst.stop();
  });

  it("restart mid-day with latches set: no duplicate notifications", () => {
    const b = makeCtx();
    vi.setSystemTime(new Date("2026-08-06T14:00:00"));
    b.stateMap.set("day", "2026-08-06");
    b.stateMap.set("openWindowsOn", "2026-08-06");
    b.stateMap.set("closeWindowsOn", "2026-08-06");
    b.stateMap.set("closeWindows", true);
    b.stateMap.set("phase", "comfort");
    const inst = createRecipe().createInstance(PARAMS, b.ctx as never);
    emit(b.handlers, "weather-1", "temperature", 26); // would re-trigger without latches
    emit(b.handlers, "weather-1", "temperature", 19);
    expect(b.stateMap.get("openWindows")).toBe(false); // latch held
    inst.stop();
  });

  it("daily rollover resets latches and phase", () => {
    const b = startAt("2026-08-06T23:30:00");
    b.stateMap.set("closeWindows", true);
    vi.setSystemTime(new Date("2026-08-07T00:00:30"));
    vi.advanceTimersByTime(30_000); // one clock tick past midnight
    expect(localDay(new Date())).toBe("2026-08-07");
    expect(b.stateMap.get("day")).toBe("2026-08-07");
    expect(b.stateMap.get("closeWindows")).toBe(false);
    expect(b.stateMap.get("phase")).toBe("idle");
    b.inst.stop();
  });

  it("order failure is swallowed and logged", () => {
    const b = makeCtx();
    vi.setSystemTime(new Date("2026-08-06T13:00:00"));
    b.ctx.dispatchOrder = () => Promise.reject(new Error("offline"));
    const inst = createRecipe().createInstance(PARAMS, b.ctx as never);
    emit(b.handlers, "weather-1", "temperature", 33);
    emit(b.handlers, "grid-1", "power", -1500);
    vi.advanceTimersByTime(16 * 60_000);
    expect(b.stateMap.get("phase")).toBe("precool"); // phase advanced, retry next transition
    inst.stop();
  });

  it("comfort auto-on: hot house turns the AC on even without surplus", () => {
    const b = makeCtx();
    vi.setSystemTime(new Date("2026-08-06T15:00:00"));
    b.stateMap.set("phase", "comfort");
    b.stateMap.set("day", "2026-08-06");
    const inst = createRecipe().createInstance(PARAMS, b.ctx as never);
    emit(b.handlers, "grid-1", "power", 300); // importing, no surplus; tInt seeded 27 ≥ 27
    expect(b.orders).toEqual([
      { equipmentId: "pac-1", alias: "power", value: true },
      { equipmentId: "pac-1", alias: "setpoint", value: 26 },
    ]);
    expect(b.stateMap.get("phase")).toBe("cooling");

    // Inside the hysteresis band: no further orders
    emit(b.handlers, "pac-1", "temperature", 26.4);
    vi.advanceTimersByTime(30 * 60_000);
    expect(b.orders).toHaveLength(2);
    inst.stop();
  });

  it("comfort auto-off: cool house releases the AC", () => {
    const b = makeCtx();
    vi.setSystemTime(new Date("2026-08-06T18:00:00"));
    b.stateMap.set("phase", "cooling");
    b.stateMap.set("day", "2026-08-06");
    const inst = createRecipe().createInstance(PARAMS, b.ctx as never);
    emit(b.handlers, "pac-1", "temperature", 24.8); // <= 26 - 1
    expect(b.orders).toEqual([
      { equipmentId: "pac-1", alias: "power", value: false },
    ]);
    expect(b.stateMap.get("phase")).toBe("comfort");
    inst.stop();
  });

  it("no auto-on while the airing window is open", () => {
    const b = startAt("2026-08-06T09:00:00");
    emit(b.handlers, "pac-1", "temperature", 27.5); // hot inside
    emit(b.handlers, "weather-1", "temperature", 20); // airing opens (20 < 27)
    expect(b.stateMap.get("phase")).toBe("airing");
    vi.advanceTimersByTime(30 * 60_000);
    expect(b.orders).toHaveLength(0);
    b.inst.stop();
  });

  it("no auto-on after the night cut", () => {
    const b = startAt("2026-08-06T23:05:00");
    b.stateMap.set("day", "2026-08-06");
    vi.advanceTimersByTime(30_000); // night cut fires
    const countAfterCut = b.orders.length;
    emit(b.handlers, "pac-1", "temperature", 28); // hot but night
    vi.advanceTimersByTime(10 * 60_000);
    expect(b.orders).toHaveLength(countAfterCut);
    expect(b.stateMap.get("phase")).toBe("night_off");
    b.inst.stop();
  });

  it("precool exit flows into cooling, then auto-off on the banked cold", () => {
    const b = startAt("2026-08-06T13:00:00");
    emit(b.handlers, "weather-1", "temperature", 33);
    emit(b.handlers, "grid-1", "power", -1500);
    vi.advanceTimersByTime(16 * 60_000); // precool engaged
    emit(b.handlers, "pac-1", "temperature", 24.5); // pre-cooled below comfort band
    emit(b.handlers, "grid-1", "power", 400); // surplus gone
    vi.advanceTimersByTime(11 * 60_000); // disengage → cooling
    expect(b.stateMap.get("phase")).toBe("cooling");
    vi.advanceTimersByTime(11 * 60_000); // order gap passes → auto-off (24.5 <= 25)
    expect(b.orders.at(-1)).toEqual({
      equipmentId: "pac-1",
      alias: "power",
      value: false,
    });
    expect(b.stateMap.get("phase")).toBe("comfort");
    b.inst.stop();
  });

  it("indoorSensor: T_int comes from the configured sensor, PAC sensor ignored", () => {
    const b = makeCtx();
    vi.setSystemTime(new Date("2026-08-07T15:00:00"));
    b.stateMap.set("phase", "comfort");
    b.stateMap.set("day", "2026-08-07");
    const inst = createRecipe().createInstance(
      { ...PARAMS, indoorSensor: "sensor-1" },
      b.ctx as never,
    );
    // The PAC's own (frozen) sensor says 22 — must NOT trigger anything.
    emit(b.handlers, "pac-1", "temperature", 22);
    vi.advanceTimersByTime(5 * 60_000);
    expect(b.orders).toHaveLength(0);
    // The configured indoor sensor rising above comfort+delta drives auto-on.
    emit(b.handlers, "sensor-1", "temperature", 27.5);
    expect(b.orders).toEqual([
      { equipmentId: "pac-1", alias: "power", value: true },
      { equipmentId: "pac-1", alias: "setpoint", value: 26 },
    ]);
    inst.stop();
  });

  it("indoorSensor empty: falls back to the PAC's own sensor (default)", () => {
    const b = makeCtx();
    vi.setSystemTime(new Date("2026-08-07T15:00:00"));
    b.stateMap.set("phase", "comfort");
    b.stateMap.set("day", "2026-08-07");
    const inst = createRecipe().createInstance(PARAMS, b.ctx as never);
    emit(b.handlers, "pac-1", "temperature", 27.5); // PAC drives it when no sensor set
    expect(b.orders).toEqual([
      { equipmentId: "pac-1", alias: "power", value: true },
      { equipmentId: "pac-1", alias: "setpoint", value: 26 },
    ]);
    inst.stop();
  });

  it("indoorSensor same as the weather station: outdoor and indoor both tracked", () => {
    const b = makeCtx();
    vi.setSystemTime(new Date("2026-08-07T07:00:00"));
    const inst = createRecipe().createInstance(
      { ...PARAMS, indoorSensor: "weather-1" },
      b.ctx as never,
    );
    // weather-1 feeds outdoor via `temperature` (temperature_outdoor) AND
    // indoor via `temperature_2` (temperature). Indoor 25, outdoor 19 → airing opens.
    emit(b.handlers, "weather-1", "temperature_2", 25);
    emit(b.handlers, "weather-1", "temperature", 19);
    expect(b.stateMap.get("openWindows")).toBe(true);
    inst.stop();
  });

  it("stop() silences the clock and events", () => {
    const b = startAt("2026-08-06T13:00:00");
    b.inst.stop();
    emit(b.handlers, "grid-1", "power", -1500);
    vi.advanceTimersByTime(60 * 60_000);
    expect(b.orders).toHaveLength(0);
  });
});

describe("off-peak boost (issue #3)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  const TARIFF: FakeTariff = {
    configured: true,
    offPeakToday: [
      { start: "00:04", end: "05:34" },
      { start: "14:34", end: "17:04" },
    ],
    isOffPeakNow: true,
  };

  it("engages inside the window on a hot day with zero surplus, releases at window end", () => {
    const b = makeCtx({ tariff: TARIFF });
    vi.setSystemTime(new Date("2026-08-06T15:00:00"));
    const inst = createRecipe().createInstance(PARAMS, b.ctx as never);

    // Grid stays at +200 W import (seeded binding) — no surplus at all.
    emit(b.handlers, "weather-1", "temperature", 32); // hot day
    expect(b.stateMap.get("phase")).toBe("precool");
    expect(b.orders).toEqual([
      { equipmentId: "pac-1", alias: "power", value: true },
      { equipmentId: "pac-1", alias: "setpoint", value: 24 },
    ]);

    // Window over (17:04) → hand back to the comfort setpoint, AC stays on.
    vi.setSystemTime(new Date("2026-08-06T17:05:00"));
    vi.advanceTimersByTime(30_000);
    expect(b.stateMap.get("phase")).toBe("cooling");
    expect(b.orders[2]).toEqual({
      equipmentId: "pac-1",
      alias: "setpoint",
      value: 26,
    });
    expect(b.orders).toHaveLength(3);
    inst.stop();
  });

  it("stays idle outside the window (peak hours) without surplus", () => {
    const b = makeCtx({ tariff: TARIFF });
    // 13:30: HP before the window, and past the morning-airing latch (13:00)
    vi.setSystemTime(new Date("2026-08-06T13:30:00"));
    const inst = createRecipe().createInstance(PARAMS, b.ctx as never);
    emit(b.handlers, "pac-1", "temperature", 26); // below the auto-on margin
    emit(b.handlers, "weather-1", "temperature", 32);
    expect(b.orders).toEqual([]);
    expect(b.stateMap.get("phase")).toBe("idle");
    inst.stop();
  });

  it("does not engage on a mild day even inside the window", () => {
    const b = makeCtx({ tariff: TARIFF });
    vi.setSystemTime(new Date("2026-08-06T15:00:00"));
    const inst = createRecipe().createInstance(PARAMS, b.ctx as never);
    emit(b.handlers, "pac-1", "temperature", 25);
    emit(b.handlers, "weather-1", "temperature", 25); // not hot
    expect(b.orders).toEqual([]);
    inst.stop();
  });

  it("inert when the tariff is not configured", () => {
    const b = makeCtx({
      tariff: { configured: false, offPeakToday: [], isOffPeakNow: null },
    });
    vi.setSystemTime(new Date("2026-08-06T15:00:00"));
    const inst = createRecipe().createInstance(PARAMS, b.ctx as never);
    emit(b.handlers, "pac-1", "temperature", 26);
    emit(b.handlers, "weather-1", "temperature", 32);
    expect(b.orders).toEqual([]);
    inst.stop();
  });

  it("inert on a night-only contract", () => {
    const b = makeCtx({
      tariff: {
        configured: true,
        offPeakToday: [{ start: "00:04", end: "05:34" }],
        isOffPeakNow: false,
      },
    });
    vi.setSystemTime(new Date("2026-08-06T15:00:00"));
    const inst = createRecipe().createInstance(PARAMS, b.ctx as never);
    emit(b.handlers, "pac-1", "temperature", 26);
    emit(b.handlers, "weather-1", "temperature", 32);
    expect(b.orders).toEqual([]);
    inst.stop();
  });

  it("inert when disabled via the slot", () => {
    const b = makeCtx({ tariff: TARIFF });
    vi.setSystemTime(new Date("2026-08-06T15:00:00"));
    const inst = createRecipe().createInstance(
      { ...PARAMS, tariffBoostEnabled: false },
      b.ctx as never,
    );
    emit(b.handlers, "pac-1", "temperature", 26);
    emit(b.handlers, "weather-1", "temperature", 32);
    expect(b.orders).toEqual([]);
    inst.stop();
  });

  it("old core without getTariff: inert with a warning, no crash", () => {
    const b = makeCtx(); // helper absent
    vi.setSystemTime(new Date("2026-08-06T15:00:00"));
    const inst = createRecipe().createInstance(PARAMS, b.ctx as never);
    expect(b.logs.some((l) => l.includes("getTariff"))).toBe(true);
    emit(b.handlers, "pac-1", "temperature", 26);
    emit(b.handlers, "weather-1", "temperature", 32);
    expect(b.orders).toEqual([]);
    inst.stop();
  });
});

describe("surplus arbiter (spec 140)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("grant engages precool, revoke hands back the comfort setpoint", () => {
    const arb = makeArbiter();
    const b = makeCtx({ energy: arb.energy });
    vi.setSystemTime(new Date("2026-08-06T13:00:00"));
    const inst = createRecipe().createInstance(PARAMS, b.ctx as never);
    b.stateMap.set("closeWindowsOn", "2026-08-06"); // airing done
    emit(b.handlers, "pac-1", "temperature", 26.5); // inside band, no auto-on
    emit(b.handlers, "weather-1", "temperature", 33); // hot → claim held
    expect(arb.claimed()).toBe(true);
    expect(b.orders).toHaveLength(0); // pending, not granted → no precool

    arb.grant();
    vi.advanceTimersByTime(1); // flush the deferred re-evaluation
    expect(b.stateMap.get("phase")).toBe("precool");
    expect(b.orders).toEqual([
      { equipmentId: "pac-1", alias: "power", value: true },
      { equipmentId: "pac-1", alias: "setpoint", value: 25.5 }, // comfort 26 - 0.5 step
    ]);

    arb.revoke();
    vi.advanceTimersByTime(1);
    expect(b.orders.at(-1)).toEqual({
      equipmentId: "pac-1",
      alias: "setpoint",
      value: 26,
    });
    expect(b.stateMap.get("phase")).toBe("cooling"); // AC stays on
    inst.stop();
  });

  it("arbiter is the authority: raw export alone never engages without a grant", () => {
    const arb = makeArbiter();
    const b = makeCtx({ energy: arb.energy });
    vi.setSystemTime(new Date("2026-08-06T13:00:00"));
    const inst = createRecipe().createInstance(PARAMS, b.ctx as never);
    b.stateMap.set("closeWindowsOn", "2026-08-06");
    emit(b.handlers, "pac-1", "temperature", 26.5);
    emit(b.handlers, "weather-1", "temperature", 33);
    emit(b.handlers, "grid-1", "power", -2000); // huge export, but no grant
    vi.advanceTimersByTime(30 * 60_000);
    expect(arb.claimed()).toBe(true);
    expect(b.orders).toHaveLength(0); // deferring to the arbiter, which has not granted
    inst.stop();
  });

  it("a denied claim (AC not profiled) falls back to raw-export detection", () => {
    const arb = makeArbiter({ denied: true });
    const b = makeCtx({ energy: arb.energy });
    vi.setSystemTime(new Date("2026-08-06T13:00:00"));
    const inst = createRecipe().createInstance(PARAMS, b.ctx as never);
    b.stateMap.set("closeWindowsOn", "2026-08-06");
    emit(b.handlers, "pac-1", "temperature", 26.5);
    emit(b.handlers, "weather-1", "temperature", 33);
    emit(b.handlers, "grid-1", "power", -1500); // raw export drives the fallback
    vi.advanceTimersByTime(16 * 60_000);
    expect(b.stateMap.get("phase")).toBe("precool");
    inst.stop();
  });

  it("arbiter present but disabled: raw-export fallback, no claim held", () => {
    const arb = makeArbiter({ enabled: false });
    const b = makeCtx({ energy: arb.energy });
    vi.setSystemTime(new Date("2026-08-06T13:00:00"));
    const inst = createRecipe().createInstance(PARAMS, b.ctx as never);
    b.stateMap.set("closeWindowsOn", "2026-08-06");
    emit(b.handlers, "pac-1", "temperature", 26.5);
    emit(b.handlers, "weather-1", "temperature", 33);
    emit(b.handlers, "grid-1", "power", -1500);
    vi.advanceTimersByTime(16 * 60_000);
    expect(b.stateMap.get("phase")).toBe("precool");
    expect(arb.claimed()).toBe(false); // never claimed while the arbiter is off
    inst.stop();
  });

  it("stop() releases the claim", () => {
    const arb = makeArbiter();
    const b = makeCtx({ energy: arb.energy });
    vi.setSystemTime(new Date("2026-08-06T13:00:00"));
    const inst = createRecipe().createInstance(PARAMS, b.ctx as never);
    emit(b.handlers, "weather-1", "temperature", 33); // hot → claim held
    expect(arb.claimed()).toBe(true);
    inst.stop();
    expect(arb.released()).toBe(true);
  });

  it("night cut releases the claim (no leak into night_off)", () => {
    const arb = makeArbiter();
    const b = makeCtx({ energy: arb.energy });
    vi.setSystemTime(new Date("2026-08-06T12:50:00"));
    const inst = createRecipe().createInstance(
      { ...PARAMS, nightOffTime: "13:00" },
      b.ctx as never,
    );
    emit(b.handlers, "weather-1", "temperature", 33); // hot daytime → claim held
    expect(arb.claimed()).toBe(true);
    vi.advanceTimersByTime(11 * 60_000); // crosses 13:00 → night cut fires
    expect(b.stateMap.get("phase")).toBe("night_off");
    expect(arb.released()).toBe(true);
    inst.stop();
  });

  it("debounces claim release: a brief cool spell does not thrash the arbiter", () => {
    const arb = makeArbiter();
    const b = makeCtx({ energy: arb.energy });
    vi.setSystemTime(new Date("2026-08-06T13:00:00"));
    const inst = createRecipe().createInstance(PARAMS, b.ctx as never);
    b.stateMap.set("closeWindowsOn", "2026-08-06"); // airing done
    emit(b.handlers, "pac-1", "temperature", 26.5); // hot inside → wantClaim true
    emit(b.handlers, "weather-1", "temperature", 33);
    expect(arb.claimed()).toBe(true);
    // No longer hot → wantClaim false, but the claim is HELD (5 min debounce).
    emit(b.handlers, "pac-1", "temperature", 24); // tInt 24 <= comfort
    emit(b.handlers, "weather-1", "temperature", 20); // tExt 20 < hotDay
    vi.advanceTimersByTime(4 * 60_000); // < 5 min hold
    expect(arb.claimed()).toBe(true); // still held
    vi.advanceTimersByTime(2 * 60_000); // now past 5 min
    expect(arb.claimed()).toBe(false); // released
    inst.stop();
  });

  it("a throwing arbiter helper degrades to raw-export detection, no crash", () => {
    const throwing = {
      claimCapacity: () => {
        throw new Error("boom");
      },
      getCapacityState: () => ({
        enabled: true,
        availableSurplusW: 800,
        grants: [],
      }),
    };
    const b = makeCtx({ energy: throwing });
    vi.setSystemTime(new Date("2026-08-06T13:00:00"));
    const inst = createRecipe().createInstance(PARAMS, b.ctx as never);
    b.stateMap.set("closeWindowsOn", "2026-08-06");
    emit(b.handlers, "pac-1", "temperature", 26.5);
    emit(b.handlers, "weather-1", "temperature", 33);
    emit(b.handlers, "grid-1", "power", -1500); // raw export drives the fallback
    vi.advanceTimersByTime(16 * 60_000);
    expect(b.stateMap.get("phase")).toBe("precool"); // engaged despite the throwing arbiter
    inst.stop();
  });
});
