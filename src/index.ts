// ============================================================
// Smart Cooling Recipe — external package (spec 001)
//
// Solar-aware AC optimizer, designed from 62 days of real usage data:
//  1. Morning airing (notify only): `openWindows` rises when outdoor air
//     is bearable and still cooler than indoors; `closeWindows` rises when
//     outdoor catches up with indoor. Map both to notifications.
//  2. Pre-cooling: on a hot day with sustained grid export, run the AC at
//     a lower setpoint to bank cooling with energy otherwise injected.
//  3. Comfort: restore the normal setpoint when the surplus collapses.
//  4. Night cut: switch the AC off at a fixed time (once per day).
//
// The recipe only issues orders on phase TRANSITIONS — a manual change
// between transitions is never overridden.
// ============================================================

// Minimal types for RecipeContext (injected at runtime by Sowel core)
interface DataBindingLite {
  alias: string;
  category?: string;
  value?: unknown;
}
interface OrderBindingLite {
  alias: string;
  category?: string;
  type?: string;
}
interface RecipeContext {
  eventBus: {
    onType(type: string, handler: (event: Record<string, unknown>) => void): () => void;
  };
  equipmentManager: {
    getByIdWithDetails(id: string): {
      name: string;
      zoneId?: string;
      dataBindings: DataBindingLite[];
      orderBindings: OrderBindingLite[];
    } | null;
  };
  zoneManager: {
    getById(id: string): { id: string; name: string } | null;
  };
  logger: {
    info(obj: Record<string, unknown>, msg?: string): void;
    warn(obj: Record<string, unknown>, msg?: string): void;
    error(obj: Record<string, unknown>, msg?: string): void;
    debug(obj: Record<string, unknown>, msg?: string): void;
  };
  state: {
    get(key: string): unknown;
    set(key: string, value: unknown): void;
    delete(key: string): void;
    clear(): void;
  };
  log: (message: string, level?: "info" | "warn" | "error") => void;
  helpers: {
    parseDuration(value: unknown): number;
    formatDuration(ms: number): string;
    getSunlight?(): { sunrise: string | null; sunset: string | null; isDaylight: boolean | null };
  };
  dispatchOrder(equipmentId: string, alias: string, value: unknown): Promise<void>;
}

interface RecipeSlotDef {
  id: string;
  name: string;
  description: string;
  type: "zone" | "equipment" | "number" | "duration" | "time" | "boolean" | "text" | "data-key";
  required: boolean;
  list?: boolean;
  defaultValue?: unknown;
  constraints?: {
    equipmentType?: string | string[];
    min?: number;
    max?: number;
    crossZone?: boolean;
  };
  group?: string;
}

interface RecipeLangPack {
  name: string;
  description: string;
  slots?: Record<string, { name: string; description: string }>;
  groups?: Record<string, string>;
}

interface RecipeDefinition {
  id: string;
  name: string;
  description: string;
  slots: RecipeSlotDef[];
  i18n?: Record<string, RecipeLangPack>;
  validate(params: Record<string, unknown>, ctx: RecipeContext): void;
  createInstance(params: Record<string, unknown>, ctx: RecipeContext): { stop(): void };
}

// ============================================================
// Pure helpers (exported for tests)
// ============================================================

/** Minutes-of-day for an "HH:MM" string. NaN if malformed. */
export function hmToMinutes(timeStr: string): number {
  const m = /^(\d{1,2}):(\d{2})$/.exec(timeStr);
  if (!m) return NaN;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** Local calendar day "YYYY-MM-DD" (server TZ). */
export function localDay(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const dd = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${dd}`;
}

/** Grid export in W from a signed grid power reading (+import / −export). */
export function exportWatts(gridPower: unknown): number | null {
  if (typeof gridPower !== "number" || !Number.isFinite(gridPower)) return null;
  return Math.max(0, -gridPower);
}

const CLOCK_MS = 30_000;
const DISENGAGE_EXPORT_W = 100;
const DISENGAGE_HOLD_MS = 10 * 60_000;
const MIN_ORDER_GAP_MS = 10 * 60_000;
// The "open the windows" suggestion is a MORNING thing: without this bound,
// any cool evening (T_ext dropping back below T_int, i.e. every day) would
// fire it at dinner time on days when the morning window never opened.
const AIRING_OPEN_END_MIN = 13 * 60;

// ============================================================
// Recipe Definition
// ============================================================

export function createRecipe(): RecipeDefinition {
  return {
    id: "smart-cooling",
    name: "Smart Cooling",
    description:
      "Solar-aware AC optimizer: notifies morning airing windows, pre-cools on sustained solar surplus during hot days, restores the comfort setpoint when the surplus ends, and switches the AC off at a fixed night time. Only acts on phase transitions — manual changes in between are never overridden.",

    slots: [
      { id: "zone", name: "Zone", description: "Zone of the AC", type: "zone", required: true },
      {
        id: "pac",
        name: "Air conditioner",
        description: "Thermostat equipment to drive (power + setpoint)",
        type: "equipment",
        required: true,
        constraints: { equipmentType: "thermostat", crossZone: true },
      },
      {
        id: "gridMeter",
        name: "Grid meter",
        description: "Main energy meter with signed power (+import / −export)",
        type: "equipment",
        required: true,
        constraints: { equipmentType: "main_energy_meter", crossZone: true },
      },
      {
        id: "weather",
        name: "Weather station",
        description: "Source of the outdoor temperature",
        type: "equipment",
        required: true,
        constraints: { equipmentType: "weather", crossZone: true },
      },
      {
        id: "comfortSetpoint",
        name: "Comfort setpoint",
        description: "Normal cooling setpoint (°C)",
        type: "number",
        required: false,
        defaultValue: 26,
        constraints: { min: 20, max: 30 },
        group: "setpoints",
      },
      {
        id: "precoolSetpoint",
        name: "Pre-cool setpoint",
        description: "Lower setpoint used while solar surplus is available (°C)",
        type: "number",
        required: false,
        defaultValue: 24,
        constraints: { min: 18, max: 28 },
        group: "setpoints",
      },
      {
        id: "surplusThreshold",
        name: "Surplus threshold",
        description: "Grid export (W) considered a usable solar surplus",
        type: "number",
        required: false,
        defaultValue: 500,
        constraints: { min: 100, max: 5000 },
        group: "solar",
      },
      {
        id: "surplusHold",
        name: "Surplus hold",
        description: "How long the export must be sustained before pre-cooling (e.g. 15m)",
        type: "duration",
        required: false,
        defaultValue: "15m",
        group: "solar",
      },
      {
        id: "hotDayThreshold",
        name: "Hot day threshold",
        description: "Outdoor temperature (°C) beyond which pre-cooling is worth it",
        type: "number",
        required: false,
        defaultValue: 30,
        constraints: { min: 20, max: 40 },
        group: "solar",
      },
      {
        id: "comfortOnDelta",
        name: "Auto-on margin",
        description: "Turn the AC on when indoor exceeds the comfort setpoint by this margin (°C)",
        type: "number",
        required: false,
        defaultValue: 1,
        constraints: { min: 0.5, max: 3 },
        group: "setpoints",
      },
      {
        id: "comfortOffDelta",
        name: "Auto-off margin",
        description: "Turn the AC off when indoor falls below the comfort setpoint by this margin (°C)",
        type: "number",
        required: false,
        defaultValue: 1,
        constraints: { min: 0.5, max: 3 },
        group: "setpoints",
      },
      {
        id: "nightOffTime",
        name: "Night off time",
        description: "The AC is switched off at this time (once per day)",
        type: "time",
        required: false,
        defaultValue: "23:00",
        group: "night",
      },
      {
        id: "airingEnabled",
        name: "Morning airing notifications",
        description: "Notify when to open and close the windows in the morning",
        type: "boolean",
        required: false,
        defaultValue: true,
        group: "airing",
      },
      {
        id: "airingMinOutdoor",
        name: "Airing minimum outdoor",
        description: "Suggest opening only when the outdoor temperature is at least this (°C)",
        type: "number",
        required: false,
        defaultValue: 18,
        constraints: { min: 5, max: 25 },
        group: "airing",
      },
      {
        id: "airingMargin",
        name: "Airing close margin",
        description: "Suggest closing when outdoor reaches indoor minus this margin (°C)",
        type: "number",
        required: false,
        defaultValue: 0.5,
        constraints: { min: 0, max: 3 },
        group: "airing",
      },
    ],

    i18n: {
      fr: {
        name: "Clim intelligente",
        description:
          "Optimise la climatisation avec le solaire : notifie les fenêtres d'aération le matin, pré-refroidit sur surplus solaire soutenu les jours chauds, restaure la consigne confort quand le surplus disparaît, et éteint la clim à heure fixe le soir. N'agit qu'aux transitions — vos réglages manuels entre-temps sont respectés.",
        slots: {
          zone: { name: "Zone", description: "Zone de la climatisation" },
          pac: { name: "Climatisation", description: "Équipement thermostat à piloter (marche + consigne)" },
          gridMeter: {
            name: "Compteur principal",
            description: "Compteur principal avec puissance signée (+soutirage / −injection)",
          },
          weather: { name: "Station météo", description: "Source de la température extérieure" },
          comfortSetpoint: { name: "Consigne confort", description: "Consigne normale de refroidissement (°C)" },
          comfortOnDelta: {
            name: "Marge d'allumage auto",
            description: "Allume la clim quand l'intérieur dépasse la consigne confort de cette marge (°C)",
          },
          comfortOffDelta: {
            name: "Marge d'extinction auto",
            description: "Éteint la clim quand l'intérieur descend sous la consigne confort de cette marge (°C)",
          },
          precoolSetpoint: {
            name: "Consigne pré-refroidissement",
            description: "Consigne abaissée pendant le surplus solaire (°C)",
          },
          surplusThreshold: {
            name: "Seuil de surplus",
            description: "Injection réseau (W) considérée comme surplus utilisable",
          },
          surplusHold: {
            name: "Durée de surplus",
            description: "Durée d'injection soutenue avant pré-refroidissement (ex. 15m)",
          },
          hotDayThreshold: {
            name: "Seuil jour chaud",
            description: "Température extérieure (°C) au-delà de laquelle pré-refroidir vaut le coup",
          },
          nightOffTime: { name: "Heure d'extinction", description: "La clim est éteinte à cette heure (une fois par jour)" },
          airingEnabled: {
            name: "Notifications d'aération",
            description: "Notifier quand ouvrir et fermer les fenêtres le matin",
          },
          airingMinOutdoor: {
            name: "Minimum extérieur d'aération",
            description: "Ne suggérer d'ouvrir que si la température extérieure atteint au moins ce seuil (°C)",
          },
          airingMargin: {
            name: "Marge de fermeture",
            description: "Suggérer de fermer quand l'extérieur atteint l'intérieur moins cette marge (°C)",
          },
        },
        groups: {
          setpoints: "Consignes",
          solar: "Surplus solaire",
          night: "Nuit",
          airing: "Aération du matin",
        },
      },
    },

    // ============================================================
    // Validation
    // ============================================================

    validate(params: Record<string, unknown>, ctx: RecipeContext): void {
      for (const key of ["zone", "pac", "gridMeter", "weather"] as const) {
        if (!params[key] || typeof params[key] !== "string") {
          throw new Error(`${key} parameter is required`);
        }
      }
      if (!ctx.zoneManager.getById(params.zone as string)) {
        throw new Error("Zone not found");
      }
      for (const key of ["pac", "gridMeter", "weather"] as const) {
        if (!ctx.equipmentManager.getByIdWithDetails(params[key] as string)) {
          throw new Error(`Equipment not found for ${key}`);
        }
      }
      const comfort = Number(params.comfortSetpoint ?? 26);
      const precool = Number(params.precoolSetpoint ?? 24);
      if (Number.isNaN(comfort) || Number.isNaN(precool)) {
        throw new Error("Setpoints must be numbers");
      }
      if (precool > comfort) {
        throw new Error("Pre-cool setpoint must be lower than or equal to the comfort setpoint");
      }
      const nightOff = String(params.nightOffTime ?? "23:00");
      if (Number.isNaN(hmToMinutes(nightOff))) {
        throw new Error("nightOffTime must be HH:MM");
      }
      const pac = ctx.equipmentManager.getByIdWithDetails(params.pac as string);
      const hasPower = pac?.orderBindings.some((o) => o.category === "toggle_power" || o.alias === "power");
      const hasSetpoint = pac?.orderBindings.some((o) => o.category === "set_setpoint" || o.alias === "setpoint");
      if (!hasPower || !hasSetpoint) {
        throw new Error("AC equipment must expose power and setpoint orders");
      }
    },

    // ============================================================
    // Instance
    // ============================================================

    createInstance(params: Record<string, unknown>, ctx: RecipeContext) {
      const pacId = params.pac as string;
      const gridId = params.gridMeter as string;
      const weatherId = params.weather as string;
      const comfortSetpoint = Number(params.comfortSetpoint ?? 26);
      const precoolSetpoint = Number(params.precoolSetpoint ?? 24);
      const surplusThreshold = Number(params.surplusThreshold ?? 500);
      const surplusHoldMs = ctx.helpers.parseDuration(params.surplusHold ?? "15m");
      const hotDayThreshold = Number(params.hotDayThreshold ?? 30);
      const comfortOnDelta = Number(params.comfortOnDelta ?? 1);
      const comfortOffDelta = Number(params.comfortOffDelta ?? 1);
      const nightOffMin = hmToMinutes(String(params.nightOffTime ?? "23:00"));
      const airingEnabled = params.airingEnabled !== false;
      const airingMinOutdoor = Number(params.airingMinOutdoor ?? 18);
      const airingMargin = Number(params.airingMargin ?? 0.5);

      // ── Resolve source aliases once ─────────────────────────
      const pacEq = ctx.equipmentManager.getByIdWithDetails(pacId);
      const gridEq = ctx.equipmentManager.getByIdWithDetails(gridId);
      const weatherEq = ctx.equipmentManager.getByIdWithDetails(weatherId);

      const gridPowerAlias =
        gridEq?.dataBindings.find((b) => b.category === "power")?.alias ??
        gridEq?.dataBindings.find((b) => b.alias === "power")?.alias ??
        "power";
      const tExtAlias =
        weatherEq?.dataBindings.find((b) => b.category === "temperature_outdoor")?.alias ??
        weatherEq?.dataBindings.find((b) => b.alias === "temperature")?.alias ??
        "temperature";
      const tIntAlias =
        pacEq?.dataBindings.find((b) => b.category === "temperature")?.alias ?? "temperature";
      const powerOrderAlias =
        pacEq?.orderBindings.find((o) => o.category === "toggle_power")?.alias ?? "power";
      const setpointOrderAlias =
        pacEq?.orderBindings.find((o) => o.category === "set_setpoint")?.alias ?? "setpoint";

      // ── Live values (seeded from current bindings) ──────────
      const num = (v: unknown): number | null =>
        typeof v === "number" && Number.isFinite(v) ? v : null;
      let gridPower = num(gridEq?.dataBindings.find((b) => b.alias === gridPowerAlias)?.value);
      let tExt = num(weatherEq?.dataBindings.find((b) => b.alias === tExtAlias)?.value);
      let tInt = num(pacEq?.dataBindings.find((b) => b.alias === tIntAlias)?.value);

      // ── Persisted daily latches / phase ─────────────────────
      const s = ctx.state;
      const str = (k: string): string | null => (typeof s.get(k) === "string" ? (s.get(k) as string) : null);
      let phase = str("phase") ?? "idle";
      const setPhase = (p: string) => {
        if (p !== phase) {
          phase = p;
          s.set("phase", p);
          ctx.log(`Phase → ${p}`);
        }
      };
      if (!str("phase")) s.set("phase", phase);
      if (typeof s.get("openWindows") !== "boolean") s.set("openWindows", false);
      if (typeof s.get("closeWindows") !== "boolean") s.set("closeWindows", false);

      // In-memory accounting
      let exportSince: number | null = null;
      let lowExportSince: number | null = null;
      let lastOrderAt = 0;
      const lastSeen = new Map<string, unknown>();
      let stopped = false;

      // ── Order helper: transitions only, never throws ────────
      const sendOrder = (alias: string, value: unknown, why: string, exemptGap = false) => {
        const now = Date.now();
        if (!exemptGap && now - lastOrderAt < MIN_ORDER_GAP_MS) return false;
        lastOrderAt = now;
        ctx.log(`Order ${alias}=${String(value)} (${why})`);
        ctx.dispatchOrder(pacId, alias, value).catch((err: unknown) => {
          ctx.log(`Order ${alias} failed: ${err instanceof Error ? err.message : String(err)}`, "warn");
        });
        return true;
      };

      const sunriseMin = (): number => {
        const sun = ctx.helpers.getSunlight?.();
        const m = sun?.sunrise ? hmToMinutes(sun.sunrise) : NaN;
        return Number.isNaN(m) ? 8 * 60 : m; // fallback 08:00
      };
      const sunsetMin = (): number => {
        const sun = ctx.helpers.getSunlight?.();
        const m = sun?.sunset ? hmToMinutes(sun.sunset) : NaN;
        return Number.isNaN(m) ? 20 * 60 : m; // fallback 20:00
      };

      // ── Core evaluation (clock + data driven) ───────────────
      const evaluate = () => {
        if (stopped) return;
        const nowDate = new Date();
        const now = nowDate.getTime();
        const nowMin = nowDate.getHours() * 60 + nowDate.getMinutes();
        const today = localDay(nowDate);

        // Daily rollover: reset latches, silent falls of the notify keys.
        if (str("day") !== today) {
          s.set("day", today);
          s.set("openWindows", false);
          s.set("closeWindows", false);
          setPhase("idle");
        }

        // Surplus accounting
        const exp = exportWatts(gridPower);
        if (exp === null || exp < surplusThreshold) exportSince = null;
        else exportSince ??= now;
        if (exp === null || exp < DISENGAGE_EXPORT_W) lowExportSince ??= now;
        else lowExportSince = null;

        // 1. Night cut (highest priority, once per day, gap-exempt)
        if (str("nightOffOn") !== today && nowMin >= nightOffMin) {
          s.set("nightOffOn", today);
          sendOrder(powerOrderAlias, false, "night cut", true);
          setPhase("night_off");
          return;
        }
        if (phase === "night_off") return; // dormant until rollover

        // 2. Morning airing notifications (notify only, once per day each)
        if (airingEnabled && tExt !== null && tInt !== null && nowMin >= sunriseMin()) {
          if (
            str("openWindowsOn") !== today &&
            str("closeWindowsOn") !== today &&
            nowMin <= AIRING_OPEN_END_MIN &&
            tExt >= airingMinOutdoor &&
            tExt < tInt - airingMargin
          ) {
            s.set("openWindowsOn", today);
            s.set("openWindows", true);
            setPhase("airing");
            ctx.log(`Airing window open (T_ext=${tExt} < T_int=${tInt})`);
          }
          if (
            str("openWindowsOn") === today &&
            str("closeWindowsOn") !== today &&
            tExt >= tInt - airingMargin
          ) {
            s.set("closeWindowsOn", today);
            s.set("openWindows", false); // silent fall (boolean mappings notify on rise only)
            s.set("closeWindows", true);
            setPhase("comfort");
            ctx.log(`Airing window closed (T_ext=${tExt} caught up with T_int=${tInt})`);
          }
        }

        // 3. Pre-cooling on sustained surplus, daytime, hot day. Blocked
        // while the airing window is open (phase "airing") — cooling with
        // the windows open would be absurd; everything else stays manual.
        const daytime = nowMin >= sunriseMin() && nowMin <= sunsetMin();
        const hot = (tExt !== null && tExt >= hotDayThreshold) || (tInt !== null && tInt > comfortSetpoint);

        if (
          phase !== "precool" &&
          phase !== "airing" &&
          daytime &&
          hot &&
          exportSince !== null &&
          now - exportSince >= surplusHoldMs
        ) {
          if (sendOrder(powerOrderAlias, true, "precool engage")) {
            sendOrder(setpointOrderAlias, precoolSetpoint, "precool setpoint", true);
            setPhase("precool");
          }
          return;
        }

        // 4. Pre-cool exit: surplus collapsed → back to the comfort setpoint.
        // The AC stays ON (phase "cooling") — the auto-off rule below takes
        // over: with a pre-cooled house it releases quickly and the house
        // coasts on the banked cold.
        if (phase === "precool" && lowExportSince !== null && now - lowExportSince >= DISENGAGE_HOLD_MS) {
          sendOrder(setpointOrderAlias, comfortSetpoint, "surplus over, comfort setpoint", true);
          setPhase("cooling");
        }

        // 5. Comfort auto-on: house too warm → AC ON at the comfort setpoint,
        // surplus or not (full-auto mode). Only from idle/comfort — airing,
        // precool, cooling and night_off all have their own rules — and only
        // inside the sunrise→nightOffTime window: after the daily rollover
        // the phase is idle again, and without this gate a warm night would
        // re-engage the AC at midnight, defeating the night cut.
        if (
          (phase === "idle" || phase === "comfort") &&
          nowMin >= sunriseMin() &&
          nowMin < nightOffMin &&
          tInt !== null &&
          tInt >= comfortSetpoint + comfortOnDelta
        ) {
          if (sendOrder(powerOrderAlias, true, "comfort auto-on")) {
            sendOrder(setpointOrderAlias, comfortSetpoint, "comfort setpoint", true);
            setPhase("cooling");
          }
          return;
        }

        // 6. Comfort auto-off: the house is cool enough on its own → AC OFF.
        // Only from "cooling" (never during precool: the unit is deliberately
        // driving below the comfort setpoint there).
        if (
          phase === "cooling" &&
          tInt !== null &&
          tInt <= comfortSetpoint - comfortOffDelta
        ) {
          if (sendOrder(powerOrderAlias, false, "comfort auto-off")) {
            setPhase("comfort");
          }
        }
      };

      // ── Subscriptions ───────────────────────────────────────
      const unsub = ctx.eventBus.onType("equipment.data.changed", (event) => {
        try {
          const eqId = event.equipmentId as string;
          const alias = event.alias as string;
          const value = event.value;
          const key = `${eqId}:${alias}`;
          if (lastSeen.get(key) === value) return; // edge guard (re-fired events)
          lastSeen.set(key, value);

          if (eqId === gridId && alias === gridPowerAlias) gridPower = num(value);
          else if (eqId === weatherId && alias === tExtAlias) tExt = num(value);
          else if (eqId === pacId && alias === tIntAlias) tInt = num(value);
          else return;
          evaluate();
        } catch (err) {
          ctx.logger.error({ err }, "smart-cooling: event handler error");
        }
      });

      const clock = setInterval(() => {
        try {
          evaluate();
        } catch (err) {
          ctx.logger.error({ err }, "smart-cooling: clock error");
        }
      }, CLOCK_MS);

      ctx.log(
        `Smart Cooling started (comfort=${comfortSetpoint}°C, precool=${precoolSetpoint}°C, surplus≥${surplusThreshold}W for ${ctx.helpers.formatDuration(surplusHoldMs)}, night off ${String(params.nightOffTime ?? "23:00")})`,
      );

      return {
        stop() {
          stopped = true;
          clearInterval(clock);
          unsub();
        },
      };
    },
  };
}
