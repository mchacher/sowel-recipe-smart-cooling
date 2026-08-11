// ============================================================
// Smart Cooling Recipe — external package (spec 001)
//
// Solar-aware AC optimizer, designed from 62 days of real usage data:
//  1. Morning airing (notify only): `openWindows` rises when outdoor air
//     is bearable and still cooler than indoors; `closeWindows` rises when
//     outdoor catches up with indoor. Map both to notifications.
//  2. Pre-cooling: on a hot day when solar surplus is available — via the
//     capacity arbiter when it is enabled (v1.4.0), otherwise self-detected
//     from sustained grid export — or during the afternoon off-peak tariff
//     window (v1.3.0, issue #3). Runs the AC at a lower setpoint to bank
//     cooling with energy that is otherwise injected or cheap. The arbiter
//     path degrades gracefully: no helper, arbiter off, no production, or an
//     unprofiled AC all fall back to the grid-export self-detection.
//  3. Comfort: restore the normal setpoint when neither signal holds.
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
// Spec 140 capacity-arbiter helpers, mirrored from core (recipes don't import
// core). All optional at the call site — see the `energy?` helper below.
interface CapacityClaimReq {
  equipmentId: string;
  watts?: number;
  toleratedImportW?: number;
  slack?: "none" | "some" | "high";
  note?: string;
  onGranted: () => void;
  onRevoked: (reason: string) => void;
}
interface CapacityHandle {
  id: string;
  status(): "pending" | "granted" | "denied" | "released";
  deniedReason?: string;
  release(): void;
}
interface EnergyHelpers {
  claimCapacity(req: CapacityClaimReq): CapacityHandle;
  getCapacityState(): {
    enabled: boolean;
    availableSurplusW: number | null;
    grants: Array<{ equipmentId: string; watts: number; sinceIso: string }>;
  };
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
    // Spec 138, Sowel >= 1.37.0. Optional: on older cores the off-peak
    // boost stays inert and everything else behaves exactly as before.
    getTariff?(): {
      configured: boolean;
      offPeakToday: Array<{ start: string; end: string }>;
      isOffPeakNow: boolean | null;
    };
    // Spec 140, Sowel >= 1.39.0. Optional: on older cores, when the arbiter is
    // off, or the home has no production, this helper is absent or claimCapacity
    // returns a denied handle, and the recipe self-detects surplus from the grid
    // meter's export exactly as in v1.3.0.
    energy?: EnergyHelpers;
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

/**
 * The "pre-peak" off-peak window: the same-day slot whose end lands in the
 * afternoon or early evening — the cheap stretch that immediately precedes
 * the expensive evening hours, where banked cold survives into the peak.
 *
 * Night slots never qualify: a slot that wraps past midnight (end <= start)
 * or ends before noon banks cold the day then wastes, and would fight the
 * morning airing. A slot ending past `nightOffMin` is the night cut's
 * territory. With several candidates the latest-ending one wins (closest to
 * the peak). Returns `[startMin, endMin)` or null.
 */
export function prePeakOffPeakWindow(
  slots: Array<{ start: string; end: string }>,
  nightOffMin: number,
): { startMin: number; endMin: number } | null {
  let best: { startMin: number; endMin: number } | null = null;
  for (const slot of slots) {
    const startMin = hmToMinutes(slot.start);
    const endMin = hmToMinutes(slot.end);
    if (Number.isNaN(startMin) || Number.isNaN(endMin)) continue;
    if (endMin <= startMin) continue; // wraps past midnight → night slot
    if (endMin < 12 * 60 || endMin > nightOffMin) continue;
    if (!best || endMin > best.endMin) best = { startMin, endMin };
  }
  return best;
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
      "Solar-aware AC optimizer: notifies morning airing windows, pre-cools on sustained solar surplus or during the afternoon off-peak tariff window on hot days, restores the comfort setpoint when neither holds, and switches the AC off at a fixed night time. Only acts on phase transitions — manual changes in between are never overridden.",

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
        name: "Outdoor temperature",
        description: "Equipment providing the outdoor temperature (e.g. a weather station)",
        type: "equipment",
        required: true,
        constraints: { equipmentType: "weather", crossZone: true },
      },
      {
        id: "indoorSensor",
        name: "Indoor temperature",
        description:
          "Equipment providing the indoor temperature. Leave empty to use the AC's own sensor — but a continuously-reporting sensor (e.g. a weather station indoor module) is strongly recommended: an AC's built-in probe freezes its last value while the unit is off, which misleads the morning airing and the auto on/off.",
        type: "equipment",
        required: false,
        constraints: { equipmentType: ["weather", "sensor", "thermostat"], crossZone: true },
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
        id: "tariffBoostEnabled",
        name: "Off-peak pre-cool boost",
        description:
          "Also pre-cool during the afternoon off-peak window on hot days, even without solar surplus. Requires the tariff schedule to be configured (Sowel 1.37+); inert otherwise.",
        type: "boolean",
        required: false,
        defaultValue: true,
        group: "tariff",
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
          "Optimise la climatisation avec le solaire : notifie les fenêtres d'aération le matin, pré-refroidit sur surplus solaire soutenu ou pendant la fenêtre d'heures creuses de l'après-midi les jours chauds, restaure la consigne confort quand aucun des deux ne tient, et éteint la clim à heure fixe le soir. N'agit qu'aux transitions — vos réglages manuels entre-temps sont respectés.",
        slots: {
          zone: { name: "Zone", description: "Zone de la climatisation" },
          pac: { name: "Climatisation", description: "Équipement thermostat à piloter (marche + consigne)" },
          gridMeter: {
            name: "Compteur principal",
            description: "Compteur principal avec puissance signée (+soutirage / −injection)",
          },
          weather: {
            name: "Température extérieure",
            description: "Équipement fournissant la température extérieure (ex. une station météo)",
          },
          indoorSensor: {
            name: "Température intérieure",
            description:
              "Équipement fournissant la température intérieure. Vide = capteur interne de la clim, mais un capteur qui remonte en continu (ex. module intérieur d'une station météo) est fortement recommandé : la sonde interne d'une clim fige sa dernière valeur quand l'unité est éteinte, ce qui trompe l'aération du matin et l'allumage/extinction auto.",
          },
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
          tariffBoostEnabled: {
            name: "Boost heures creuses",
            description:
              "Pré-refroidit aussi pendant la fenêtre d'heures creuses de l'après-midi les jours chauds, même sans surplus solaire. Nécessite le tarif configuré (Sowel 1.37+) ; inactif sinon.",
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
          tariff: "Heures creuses",
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
      // Indoor temperature source: a dedicated sensor if configured, else the
      // AC's own probe (unreliable while the unit is off — see indoorSensor
      // slot description). Falls back to the PAC if the configured id is gone.
      const indoorId =
        typeof params.indoorSensor === "string" && params.indoorSensor
          ? params.indoorSensor
          : pacId;
      const comfortSetpoint = Number(params.comfortSetpoint ?? 26);
      const precoolSetpoint = Number(params.precoolSetpoint ?? 24);
      const surplusThreshold = Number(params.surplusThreshold ?? 500);
      const surplusHoldMs = ctx.helpers.parseDuration(params.surplusHold ?? "15m");
      const hotDayThreshold = Number(params.hotDayThreshold ?? 30);
      const comfortOnDelta = Number(params.comfortOnDelta ?? 1);
      const comfortOffDelta = Number(params.comfortOffDelta ?? 1);
      const nightOffMin = hmToMinutes(String(params.nightOffTime ?? "23:00"));
      const tariffBoostEnabled = params.tariffBoostEnabled !== false;
      const airingEnabled = params.airingEnabled !== false;
      const airingMinOutdoor = Number(params.airingMinOutdoor ?? 18);
      const airingMargin = Number(params.airingMargin ?? 0.5);

      // ── Resolve source aliases once ─────────────────────────
      const pacEq = ctx.equipmentManager.getByIdWithDetails(pacId);
      const gridEq = ctx.equipmentManager.getByIdWithDetails(gridId);
      const weatherEq = ctx.equipmentManager.getByIdWithDetails(weatherId);
      const indoorEq = ctx.equipmentManager.getByIdWithDetails(indoorId) ?? pacEq;

      const gridPowerAlias =
        gridEq?.dataBindings.find((b) => b.category === "power")?.alias ??
        gridEq?.dataBindings.find((b) => b.alias === "power")?.alias ??
        "power";
      const tExtAlias =
        weatherEq?.dataBindings.find((b) => b.category === "temperature_outdoor")?.alias ??
        weatherEq?.dataBindings.find((b) => b.alias === "temperature")?.alias ??
        "temperature";
      const tIntAlias =
        indoorEq?.dataBindings.find((b) => b.category === "temperature")?.alias ??
        indoorEq?.dataBindings.find((b) => b.alias === "temperature")?.alias ??
        "temperature";
      const powerOrderAlias =
        pacEq?.orderBindings.find((o) => o.category === "toggle_power")?.alias ?? "power";
      const setpointOrderAlias =
        pacEq?.orderBindings.find((o) => o.category === "set_setpoint")?.alias ?? "setpoint";

      // ── Live values (seeded from current bindings) ──────────
      const num = (v: unknown): number | null =>
        typeof v === "number" && Number.isFinite(v) ? v : null;
      let gridPower = num(gridEq?.dataBindings.find((b) => b.alias === gridPowerAlias)?.value);
      let tExt = num(weatherEq?.dataBindings.find((b) => b.alias === tExtAlias)?.value);
      let tInt = num(indoorEq?.dataBindings.find((b) => b.alias === tIntAlias)?.value);

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

      // ── Surplus arbiter (spec 140) ──────────────────────────
      // When the core exposes ctx.helpers.energy AND the arbiter is enabled,
      // the recipe holds a claim on the AC while pre-cooling is a candidate and
      // pre-cools on the arbiter's grant, instead of reading raw grid export.
      // When the helper is absent, the arbiter is off, or the AC is not
      // profiled (claim denied), `claim` is null/denied and the raw-export
      // detection below drives pre-cooling exactly as before.
      let claim: CapacityHandle | null = null;
      let arbiterGranted = false;
      let evalScheduled = false;
      let notWantingSince: number | null = null; // debounce claim release (anti-thrash)
      const CLAIM_RELEASE_HOLD_MS = 5 * 60_000;
      const arbiterEnabled = (): boolean => {
        try {
          return !!ctx.helpers.energy && ctx.helpers.energy.getCapacityState().enabled;
        } catch {
          return false;
        }
      };
      const releaseClaim = () => {
        try {
          if (claim) claim.release();
        } catch {
          /* a broken handle must not break the recipe */
        }
        claim = null;
        arbiterGranted = false;
        notWantingSince = null;
      };
      // The arbiter may invoke onGranted/onRevoked synchronously from inside
      // claimCapacity(); defer the re-evaluation to the next tick so it never
      // re-enters the evaluate() pass that created the claim.
      const scheduleEvaluate = () => {
        if (evalScheduled || stopped) return;
        evalScheduled = true;
        setTimeout(() => {
          evalScheduled = false;
          try {
            if (!stopped) evaluate();
          } catch (err) {
            ctx.logger.error({ err }, "smart-cooling: deferred evaluate failed");
          }
        }, 0);
      };

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
          releaseClaim(); // the AC is off for the night — free the reservation
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

        // 3. Pre-cooling on sustained surplus (daytime) or inside the
        // afternoon off-peak window (issue #3) — both need a hot day.
        // Blocked while the airing window is open (phase "airing") —
        // cooling with the windows open would be absurd; everything else
        // stays manual. The tariff snapshot is recomputed every pass: it
        // is cheap, and it follows tariff edits and day changes on its
        // own. Unconfigured tariff, night-only contracts and cores
        // without getTariff() (< 1.37) all leave `inBoostWindow` false.
        const daytime = nowMin >= sunriseMin() && nowMin <= sunsetMin();
        const hot = (tExt !== null && tExt >= hotDayThreshold) || (tInt !== null && tInt > comfortSetpoint);

        let inBoostWindow = false;
        if (tariffBoostEnabled && hot) {
          try {
            const tariff = ctx.helpers.getTariff?.();
            if (tariff?.configured && Array.isArray(tariff.offPeakToday)) {
              const win = prePeakOffPeakWindow(tariff.offPeakToday, nightOffMin);
              inBoostWindow = win !== null && nowMin >= win.startMin && nowMin < win.endMin;
            }
          } catch (err) {
            ctx.logger.error({ err }, "smart-cooling: getTariff failed");
          }
        }

        // Surplus signal: defer to the arbiter when it manages this AC,
        // otherwise self-detect from sustained grid export (v1.3.0 fallback).
        const rawSurplusReady = daytime && exportSince !== null && now - exportSince >= surplusHoldMs;

        // Hold a claim on the AC while pre-cooling is a candidate (hot, daytime,
        // not airing/night); the arbiter grants when real surplus exists.
        const wantClaim =
          arbiterEnabled() && hot && daytime && phase !== "airing" && phase !== "night_off";
        if (wantClaim) {
          notWantingSince = null;
          if (!claim && ctx.helpers.energy) {
            try {
              claim =
                ctx.helpers.energy.claimCapacity({
                  equipmentId: pacId,
                  toleratedImportW: 0,
                  slack: "some",
                  note: "precool boost",
                  onGranted: () => {
                    arbiterGranted = true;
                    scheduleEvaluate();
                  },
                  onRevoked: () => {
                    arbiterGranted = false;
                    scheduleEvaluate();
                  },
                }) ?? null;
            } catch (err) {
              ctx.logger.error({ err }, "smart-cooling: claimCapacity failed");
              claim = null;
              arbiterGranted = false; // a sync onGranted-then-throw must not leave a stale grant
            }
          }
        } else if (claim) {
          // Debounced release: a brief dip below `hot` must not thrash the
          // arbiter with rapid claim/release churn.
          notWantingSince ??= now;
          if (now - notWantingSince >= CLAIM_RELEASE_HOLD_MS) releaseClaim();
        }
        // The arbiter manages this AC only if the claim exists and was not
        // denied (e.g. the AC carries no energy profile); otherwise fall back.
        let arbiterManaging = false;
        if (claim) {
          try {
            arbiterManaging = claim.status() !== "denied";
          } catch {
            arbiterManaging = false;
          }
        }
        const surplusReady = arbiterManaging ? arbiterGranted : rawSurplusReady;

        if (phase !== "precool" && phase !== "airing" && hot && (surplusReady || inBoostWindow)) {
          if (
            sendOrder(
              powerOrderAlias,
              true,
              surplusReady ? "precool engage (surplus)" : "precool engage (off-peak)",
            )
          ) {
            sendOrder(setpointOrderAlias, precoolSetpoint, "precool setpoint", true);
            setPhase("precool");
          }
          return;
        }

        // 4. Pre-cool exit: surplus collapsed AND no off-peak window
        // holding → back to the comfort setpoint. The AC stays ON (phase
        // "cooling") — the auto-off rule below takes over: with a
        // pre-cooled house it releases quickly and the house coasts on
        // the banked cold. A boost engaged with zero surplus has had
        // `lowExportSince` running since engage, so the window end alone
        // releases it.
        const surplusGone = arbiterManaging
          ? !arbiterGranted
          : lowExportSince !== null && now - lowExportSince >= DISENGAGE_HOLD_MS;
        if (phase === "precool" && !inBoostWindow && surplusGone) {
          sendOrder(setpointOrderAlias, comfortSetpoint, "precool over, comfort setpoint", true);
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

          // Independent checks (not else-if): the indoor sensor may be the
          // same equipment as the outdoor one (a weather station providing
          // both temperature_outdoor and temperature), so one equipment can
          // feed either reading depending on the alias.
          let matched = false;
          if (eqId === gridId && alias === gridPowerAlias) {
            gridPower = num(value);
            matched = true;
          }
          if (eqId === weatherId && alias === tExtAlias) {
            tExt = num(value);
            matched = true;
          }
          if (eqId === indoorId && alias === tIntAlias) {
            tInt = num(value);
            matched = true;
          }
          if (!matched) return;
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

      if (tariffBoostEnabled && !ctx.helpers.getTariff) {
        ctx.log(
          "Off-peak pre-cool boost is enabled but this Sowel core has no getTariff() helper (needs 1.37+) — boost inactive, surplus behavior unchanged",
          "warn",
        );
      }
      ctx.log(
        `Smart Cooling started (comfort=${comfortSetpoint}°C, precool=${precoolSetpoint}°C, surplus≥${surplusThreshold}W for ${ctx.helpers.formatDuration(surplusHoldMs)}, off-peak boost ${tariffBoostEnabled ? "on" : "off"}, night off ${String(params.nightOffTime ?? "23:00")})`,
      );
      ctx.log(
        ctx.helpers.energy
          ? "Surplus arbiter available. Pre-cooling follows its grants when enabled; grid-export self-detection is the fallback."
          : "No surplus arbiter on this core (needs Sowel 1.39+). Self-detecting surplus from grid export.",
      );

      return {
        stop() {
          stopped = true;
          clearInterval(clock);
          unsub();
          releaseClaim();
        },
      };
    },
  };
}
