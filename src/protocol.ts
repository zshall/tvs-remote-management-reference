/**
 * Minimal wire contracts used by the reference server.
 *
 * Television Simulator validates these messages at runtime. A production server
 * may use any language or framework as long as it emits the same named SSE events.
 */

/** Declarative event names whose effects can outlive their original delivery. */
export const replayableEventNames = [
  "channel-change",
  "receiver-settings",
  "picture-settings",
  "overlay",
  "overlay-data-update",
  "overlay-clear",
] as const;

export type ReplayableEventName = (typeof replayableEventNames)[number];
export type EventName = ReplayableEventName | "remote";

/** Control API envelope used to broadcast or individually address an event. */
export interface EventRequest {
  /** Omit or use an empty array to address every connected client. */
  clientIds?: string[];
  payload: unknown;
  /** Save declarative state for optional replay. Ignored for `remote` events. */
  remember?: boolean;
}

/** Complete overlay definition sent by an `overlay` event. */
export interface OverlayMessage {
  /** `*` is the all-channels slot; otherwise use one channel number. */
  channelNumber: string;
  /** Required for numbered channels; omit for `*`. */
  slotNumber?: 1 | 2 | 3;
  layout: Record<string, unknown>;
  data?: Record<string, unknown>;
  /** CSS mix-blend-mode for the entire overlay. Default normal. */
  mixBlendMode?: string;
  expiresAt: string;
  audio?: Record<string, unknown>;
}

/** Partial dynamic-data and expiration update for an existing overlay. */
export interface OverlayDataUpdateMessage {
  channelNumber: string;
  slotNumber?: 1 | 2 | 3;
  data: Record<string, unknown>;
  expiresAt?: string;
}

/** Clears everything, a channel, a numbered slot, or the all-channels slot. */
export interface OverlayClearMessage {
  channelNumber?: string;
  slotNumber?: 1 | 2 | 3;
}

/** Versioned declarative snapshot returned to a polling JSON client. */
export interface JsonStateDocument {
  version: 1;
  channel?: Record<string, unknown>;
  receiver?: Record<string, unknown>;
  picture?: Record<string, unknown>;
  layouts?: Record<string, Record<string, unknown>>;
  overlays?: Record<string, unknown>[];
}

/** Narrows a URL parameter or other string to a supported remote-management event name. */
export function isEventName(value: string): value is EventName {
  return value === "remote" || replayableEventNames.includes(value as ReplayableEventName);
}

/** Identifies declarative events that may be remembered, replayed, or projected into JSON. */
export function isReplayableEventName(value: EventName): value is ReplayableEventName {
  return value !== "remote";
}
