import assert from "node:assert/strict";
import { test } from "node:test";
import { withNamedLayouts } from "./json.js";
import { ReplayStore, validateOverlayEvent } from "./replay.js";

const expiresAt = () => new Date(Date.now() + 60_000).toISOString();
const overlay = (channelNumber: string, slotNumber?: 1 | 2 | 3) => ({
  channelNumber, ...(slotNumber ? { slotNumber } : {}),
  layout: { version: 2 }, expiresAt: expiresAt(),
});

test("fixed slots replace in place and keep global and targeted clients independent", () => {
  const store = new ReplayStore();
  store.remember("overlay", overlay("*"));
  store.remember("overlay", overlay("12", 1), ["client-a"]);
  store.remember("overlay", { ...overlay("12", 1), data: { variables: { text: "new" } } }, ["client-a"]);
  assert.deepEqual(store.projectJsonState("client-a").overlays?.map((item) => item.channelNumber), ["*", "12"]);
  assert.deepEqual(store.projectJsonState("client-b").overlays?.map((item) => item.channelNumber), ["*"]);
  assert.deepEqual(store.projectJsonState("client-a").overlays?.[1].data, { variables: { text: "new" } });
});

test("all four clear scopes work and replay resets stale client slots", () => {
  const store = new ReplayStore();
  for (const item of [overlay("*"), overlay("12", 1), overlay("12", 2), overlay("13", 1)]) {
    store.remember("overlay", item);
  }
  store.remember("overlay-clear", { channelNumber: "12", slotNumber: 1 });
  assert.equal(store.projectJsonState("a").overlays?.length, 3);
  store.remember("overlay-clear", { channelNumber: "12" });
  assert.equal(store.projectJsonState("a").overlays?.length, 2);
  store.remember("overlay-clear", { channelNumber: "*" });
  assert.equal(store.projectJsonState("a").overlays?.length, 1);
  store.remember("overlay-clear", {});
  assert.deepEqual(store.projectJsonState("a").overlays, []);
  store.remember("overlay", overlay("13", 2));
  const sent: { eventName: string; payload: unknown }[] = [];
  store.replayTo("a", (eventName, payload) => sent.push({ eventName, payload }));
  assert.deepEqual(sent.map((item) => item.eventName), ["overlay-clear", "overlay"]);
  assert.deepEqual(sent[0].payload, {});
});

test("invalid slots and unknown fields are rejected before history changes", () => {
  const store = new ReplayStore();
  store.remember("overlay", overlay("12", 1));
  assert.throws(() => store.remember("overlay", { ...overlay("12", 2), zIndex: 4 }), /unknown field/);
  assert.throws(() => store.remember("overlay", { ...overlay("*"), slotNumber: 1 }), /no slotNumber/);
  assert.throws(() => validateOverlayEvent("overlay-clear", { slotNumber: 1 }), /channelNumber/);
  assert.deepEqual(store.projectJsonState("a").overlays?.map((item) => item.slotNumber), [1]);
});

test("JSON projection shares repeated layouts while leaving SSE payloads inline", () => {
  const store = new ReplayStore();
  store.remember("overlay", overlay("12", 1));
  store.remember("overlay", overlay("13", 2));
  const document = withNamedLayouts(store.projectJsonState("a"));
  assert.deepEqual(document.layouts, { "layout-1": { version: 2 } });
  assert.deepEqual(document.overlays?.map((item) => item.layoutRef), ["layout-1", "layout-1"]);
  const sent: { eventName: string; payload: unknown }[] = [];
  store.replayTo("a", (eventName, payload) => sent.push({ eventName, payload }));
  assert.deepEqual((sent[1].payload as Record<string, unknown>).layout, { version: 2 });
});
