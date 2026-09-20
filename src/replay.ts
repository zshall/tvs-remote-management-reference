import type { JsonStateDocument, ReplayableEventName } from "./protocol.js";

/** One immutable declarative event in this example server's in-memory history. */
interface StoredEvent {
  sequence: number;
  receivedAtMs: number;
  eventName: ReplayableEventName;
  payload: unknown;
}

export type ReplayEventSink = (eventName: ReplayableEventName, payload: unknown) => void;

/**
 * Optional remembered-state example. A production SSE server can omit this entire module.
 * Folding the same event history also supplies complete documents to the JSON adapter.
 */
export class ReplayStore {
  readonly #globalEvents: StoredEvent[] = [];
  readonly #clientEvents = new Map<string, StoredEvent[]>();
  #nextSequence = 1;

  /** Remember one validated event globally or for selected client IDs. */
  remember(eventName: ReplayableEventName, payload: unknown, targetClientIds?: string[]): void {
    if (eventName.startsWith("overlay")) validateOverlayEvent(eventName, payload);
    const destinations = !targetClientIds?.length
      ? [this.#globalEvents]
      : [...new Set(targetClientIds.map((id) => id.trim()))].map((id) => {
          const events = this.#clientEvents.get(id) ?? [];
          this.#clientEvents.set(id, events);
          return events;
        });
    for (const events of destinations) {
      events.push({
        sequence: this.#nextSequence++, receivedAtMs: Date.now(), eventName,
        payload: structuredClone(payload),
      });
    }
  }

  /** Replay scalar events, clear stale client slots, then send the current complete slots. */
  replayTo(clientId: string, send: ReplayEventSink): void {
    for (const event of this.#eventsFor(clientId)) {
      if (!event.eventName.startsWith("overlay")) {
        send(event.eventName, structuredClone(event.payload));
      }
    }
    send("overlay-clear", {});
    for (const overlay of this.projectJsonState(clientId).overlays ?? []) {
      send("overlay", overlay);
    }
  }

  /** Fold all remembered events into one versioned declarative JSON document. */
  projectJsonState(clientId: string): JsonStateDocument {
    let channel: Record<string, unknown> | undefined;
    const receiver: Record<string, unknown> = {};
    const picture: Record<string, unknown> = {};
    const overlays = new Map<string, Record<string, unknown>>();

    for (const event of this.#eventsFor(clientId)) {
      const payload = structuredClone(asObject(event.payload));
      switch (event.eventName) {
        case "channel-change":
          channel = payload;
          break;
        case "receiver-settings":
          Object.assign(receiver, payload);
          break;
        case "picture-settings":
          for (const [key, value] of Object.entries(payload)) {
            if (value === null) delete picture[key];
            else picture[key] = value;
          }
          break;
        case "overlay":
          overlays.set(addressKey(payload), payload);
          break;
        case "overlay-data-update": {
          const existing = overlays.get(addressKey(payload));
          if (existing && Date.parse(String(existing.expiresAt)) > event.receivedAtMs) {
            existing.data = payload.data;
            if (typeof payload.expiresAt === "string") existing.expiresAt = payload.expiresAt;
          }
          break;
        }
        case "overlay-clear":
          if (payload.channelNumber === undefined) overlays.clear();
          else if (payload.channelNumber === "*") overlays.delete("*:0");
          else if (payload.slotNumber === undefined) {
            for (const key of overlays.keys()) {
              if (key.startsWith(`${payload.channelNumber}:`)) overlays.delete(key);
            }
          } else overlays.delete(addressKey(payload));
          break;
      }
    }

    const hasReceiver = typeof receiver.volume === "number" && typeof receiver.isMuting === "boolean";
    return {
      version: 1,
      ...(channel ? { channel } : {}),
      ...(hasReceiver ? { receiver } : {}),
      ...(Object.keys(picture).length ? { picture } : {}),
      overlays: [...overlays.values()].filter((overlay) => !isExpiredOverlay(overlay)),
    };
  }

  /** Merge broadcast and targeted histories in their original order. */
  #eventsFor(clientId: string): StoredEvent[] {
    return [...this.#globalEvents, ...(this.#clientEvents.get(clientId) ?? [])]
      .sort((left, right) => left.sequence - right.sequence);
  }
}

/** The wire address, with zero reserved internally for the all-channels slot. */
function addressKey(payload: Record<string, unknown>): string {
  return `${payload.channelNumber}:${payload.channelNumber === "*" ? 0 : payload.slotNumber}`;
}

/** Reject malformed/unknown overlay commands before remembering them or sending them. */
export function validateOverlayEvent(eventName: ReplayableEventName, value: unknown): void {
  if (!isObject(value)) throw new Error("Overlay payload must be an object.");
  const allowed = eventName === "overlay"
    ? ["channelNumber", "slotNumber", "layout", "data", "mixBlendMode", "expiresAt", "audio"]
    : eventName === "overlay-data-update"
      ? ["channelNumber", "slotNumber", "data", "expiresAt"]
      : ["channelNumber", "slotNumber"];
  if (Object.keys(value).some((key) => !allowed.includes(key))) {
    throw new Error("Overlay payload contains an unknown field.");
  }
  if (value.channelNumber === undefined) {
    if (eventName !== "overlay-clear" || value.slotNumber !== undefined) {
      throw new Error("Overlay channelNumber is required.");
    }
  } else if (value.channelNumber === "*") {
    if (value.slotNumber !== undefined) throw new Error("The all-channels slot has no slotNumber.");
  } else if (typeof value.channelNumber !== "string"
    || !/^-?(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/.test(value.channelNumber)
    || (value.channelNumber.includes(".") && Number(value.channelNumber.split(".")[0]) <= 0)) {
    throw new Error("Invalid overlay channelNumber.");
  } else if (value.slotNumber === undefined) {
    if (eventName !== "overlay-clear") throw new Error("Numbered channels require slotNumber.");
  } else if (![1, 2, 3].includes(value.slotNumber as number)) {
    throw new Error("slotNumber must be 1, 2, or 3.");
  }

  if (eventName === "overlay") {
    if (!isObject(value.layout)) throw new Error("An inline overlay layout is required.");
    if (!isValidExpiration(value.expiresAt)) throw new Error("Invalid overlay expiresAt.");
    if (value.data !== undefined && !isObject(value.data)) throw new Error("Invalid overlay data.");
    if (value.audio !== undefined && !isObject(value.audio)) throw new Error("Invalid overlay audio.");
    if (value.mixBlendMode !== undefined && !BLEND_MODES.has(value.mixBlendMode as string)) {
      throw new Error("Unknown overlay mixBlendMode.");
    }
  } else if (eventName === "overlay-data-update") {
    if (!isObject(value.data)) throw new Error("Overlay data update requires data.");
    if (value.expiresAt !== undefined && !isValidExpiration(value.expiresAt)) {
      throw new Error("Invalid overlay expiresAt.");
    }
  }
}

const BLEND_MODES = new Set([
  "normal", "multiply", "screen", "overlay", "darken", "lighten",
  "color-dodge", "color-burn", "hard-light", "soft-light", "difference",
  "exclusion", "hue", "saturation", "color", "luminosity", "plus-lighter",
]);

function isValidExpiration(value: unknown): boolean {
  return typeof value === "string" && Number.isFinite(Date.parse(value));
}

/** Treat missing or elapsed expiration timestamps as expired. */
function isExpiredOverlay(payload: unknown): boolean {
  return !isValidExpiration(asObject(payload).expiresAt)
    || Date.parse(String(asObject(payload).expiresAt)) <= Date.now();
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asObject(value: unknown): Record<string, unknown> {
  return isObject(value) ? value : {};
}
