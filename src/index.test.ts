import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { createRecipe, hmToMinutes, exportWatts, localDay } from "./index.js";

// ============================================================
// Test harness — fake RecipeContext
// ============================================================

type Handler = (event: Record<string, unknown>) => void;

function makeCtx(overrides?: {
  sunrise?: string;
  sunset?: string;
  pacOrders?: Array<{ alias: string; category?: string }>;
}) {
  const handlers: Handler[] = [];
  const stateMap = new Map<string, unknown>();
  const orders: Array<{ equipmentId: string; alias: string; value: unknown }> = [];
  const logs: string[] = [];

  const equipments: Record<string, { name: string; dataBindings: unknown[]; orderBindings: unknown[] }> = {
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
      dataBindings: [{ alias: "temperature", category: "temperature_outdoor", value: 20 }],
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
    zoneManager: { getById: (id: string) => (id === "zone-1" ? { id, name: "Maison" } : null) },
    logger: { info: () => {}, warn: () => {}, error: () => {}, debug: () => {} },
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
        const mult = { s: 1000, m: 60_000, h: 3_600_000 }[m[2] as "s" | "m" | "h"];
        return Number(m[1]) * mult;
      },
      formatDuration: (ms: number) => `${ms}ms`,
      getSunlight: () => ({
        sunrise: overrides?.sunrise ?? "06:30",
        sunset: overrides?.sunset ?? "21:00",
        isDaylight: true,
      }),
    },
    dispatchOrder: (equipmentId: string, alias: string, value: unknown) => {
      orders.push({ equipmentId, alias, value });
      return Promise.resolve();
    },
  };

  return { ctx, handlers, stateMap, orders, logs };
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

function emit(h: Handler[], equipmentId: string, alias: string, value: unknown) {
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
    expect(() => createRecipe().validate({ ...PARAMS, pac: undefined }, ctx as never)).toThrow();
    expect(() => createRecipe().validate({ ...PARAMS, weather: "nope" }, ctx as never)).toThrow(/not found/i);
  });

  it("throws when the AC lacks power/setpoint orders", () => {
    const { ctx } = makeCtx({ pacOrders: [{ alias: "power", category: "toggle_power" }] });
    expect(() => createRecipe().validate(PARAMS, ctx as never)).toThrow(/setpoint/i);
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

    // T_ext catches up with T_int
    emit(b.handlers, "weather-1", "temperature", 26.5);
    expect(b.stateMap.get("openWindows")).toBe(false);
    expect(b.stateMap.get("closeWindows")).toBe(true);
    expect(b.stateMap.get("phase")).toBe("comfort");
    b.inst.stop();
  });

  it("morning below the bearable floor: no openWindows", () => {
    const b = startAt("2026-08-06T07:00:00");
    emit(b.handlers, "weather-1", "temperature", 14); // below 18 floor
    emit(b.handlers, "pac-1", "temperature", 24);
    expect(b.stateMap.get("openWindows")).toBe(false);
    b.inst.stop();
  });

  it("precool engages after sustained export on a hot day, single order pair", () => {
    const b = startAt("2026-08-06T13:00:00");
    b.stateMap.set("closeWindowsOn", "2026-08-06"); // airing done
    emit(b.handlers, "weather-1", "temperature", 33);
    emit(b.handlers, "pac-1", "temperature", 27);
    emit(b.handlers, "grid-1", "power", -1500); // exporting 1.5 kW

    vi.advanceTimersByTime(16 * 60_000); // > surplusHold
    expect(b.orders).toEqual([
      { equipmentId: "pac-1", alias: "power", value: true },
      { equipmentId: "pac-1", alias: "setpoint", value: 24 },
    ]);
    expect(b.stateMap.get("phase")).toBe("precool");

    // Stays engaged, no order storm
    vi.advanceTimersByTime(30 * 60_000);
    expect(b.orders).toHaveLength(2);
    b.inst.stop();
  });

  it("flapping export never engages", () => {
    const b = startAt("2026-08-06T13:00:00");
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
    expect(b.orders.at(-1)).toEqual({ equipmentId: "pac-1", alias: "setpoint", value: 26 });
    expect(b.stateMap.get("phase")).toBe("comfort");
    b.inst.stop();
  });

  it("null grid power resets the engage accumulator", () => {
    const b = startAt("2026-08-06T13:00:00");
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
    const off = b.orders.filter((o) => o.alias === "power" && o.value === false);
    expect(off).toHaveLength(1);
    expect(b.stateMap.get("phase")).toBe("night_off");

    vi.advanceTimersByTime(30 * 60_000); // still after 23:00
    expect(b.orders.filter((o) => o.alias === "power" && o.value === false)).toHaveLength(1);
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

  it("stop() silences the clock and events", () => {
    const b = startAt("2026-08-06T13:00:00");
    b.inst.stop();
    emit(b.handlers, "grid-1", "power", -1500);
    vi.advanceTimersByTime(60 * 60_000);
    expect(b.orders).toHaveLength(0);
  });
});
