# TVS Remote Management Reference

<img width="800" height="600" alt="image" src="https://github.com/user-attachments/assets/011ad224-685a-4a3d-81cc-f977178bd926" />

This is a deliberately small reference server for the Television Simulator remote management protocols. It can be used in production but it isn't really built for that; rather as a tool for you to study how the communication works so that you can build the same or similar functionality into your own server application.

The control panel can send a demo weather overlay or an uploaded [Character Generator layout](https://docs.tvs.gcpw.art/engines/character-generator/) to a fixed `(channelNumber, slotNumber)` slot. Each channel has 3 numbered overlay slots available (slot `1` is the lowest, slot `3` is the highest) and there's a single slot available over the top of all channels: `channelNumber: "*"` with the slot setting omitted.

## Run it

```sh
npm install
npm run dev
```

Open <http://localhost:3991>, then configure TVS with:

```yaml
remoteManagement: http://localhost:3991/sse
```

TVS appends a random (or fixed if set in the config file) `clientId` query parameter. The object form can provide an explicit ID and optional API key:

```yaml
remoteManagement:
  url: http://localhost:3991/sse
  clientId: lobby-tv
  key: connection-secret
```

`type` defaults to `sse`, so the string and object forms above remain backward-compatible. The explicit form is:

```yaml
remoteManagement:
  type: sse
  url: http://localhost:3991/sse
```

The reference server can require separate keys for connecting TVS to it (the client key) and sending control events (the control key).

Place them in a project-root `.env` file when developing locally:

```dotenv
TVS_REMOTE_MANAGEMENT_CLIENT_KEY=connection-secret
TVS_REMOTE_MANAGEMENT_CONTROL_KEY=control-secret
```

The server automatically loads this file in both development and production-start modes. Variables explicitly supplied by the shell take precedence over values in `.env`. The file is ignored by Git; do not commit real credentials.

You can also provide the variables directly when starting the process:

```sh
TVS_REMOTE_MANAGEMENT_CLIENT_KEY=connection-secret \
TVS_REMOTE_MANAGEMENT_CONTROL_KEY=control-secret \
npm run dev
```

`TVS_REMOTE_MANAGEMENT_CLIENT_KEY` must match the `key` in the TVS configuration and protects the SSE and JSON endpoints. `TVS_REMOTE_MANAGEMENT_CONTROL_KEY` protects every endpoint that sends commands or changes server state; enter it in the control panel or send it in the `x-api-key` header. Either key can be omitted to leave that side unauthenticated during local development.

When the control key is enabled, you need to log in to use the control panel in SSE mode. This is stored in the browser until you log out (in `localStorage`).

Client query-string credentials can appear in infrastructure logs. Redact them, use HTTPS outside local development, and prefer a stronger authentication design such as secure cookies when appropriate.

The server binds to `127.0.0.1` by default. To deliberately expose the server to other machines, set `TVS_REMOTE_MANAGEMENT_HOST=0.0.0.0` and use an appropriate security setup.

## Connection types

Only one remote-management connection type can be configured in TVS at a time. If you're set up with SSE mode then embed mode won't do anything, and vice versa. If you're using the JSON mode the control panel will work to control the contents of the JSON endpoint (so whenever TVS updates it'll get the latest state).

The accompanying `config-file-examples` folder shows some incredibly minimal example configs you can copy the contents of into your own `config.tvs.yml` file to get going with this server.

### SSE (Server-Sent Events)

SSE is the default mode and supports every event documented below, including transient remote inputs. TVS uses EventSource reconnection behavior and adds `clientId` and optional `key` query parameters to the configured URL. **SSE doesn't support headers so we use GET parameters.**

### JSON state polling

JSON mode tells TVS to poll for new data on a schedule, and only declarative states are supported like telling it "display overlays on these channels, set noise to 0.02, etc.". Remote inputs aren't supported since we aren't pushing data just polling every few seconds.

```yaml
remoteManagement:
  type: json
  url: http://localhost:3991/state.json
  pollIntervalMs: 5000
  clientId: lobby-tv
```

The interval defaults to 5000 milliseconds and is clamped to a minimum of 1000 milliseconds. Requests never overlap and include the same `clientId` and optional `key` GET parameters as SSE.

A response might look like this:

```json
{
  "version": 1,
  "channel": { "channelNumber": "12", "hideOsd": true },
  "receiver": { "volume": 35, "isMuting": false },
  "picture": { "noise": 0.4, "blur": 1.5 },
  "overlays": []
}
```

`receiver`, when present, must include both `volume` and `isMuting`. Omitting `picture` clears all remote picture overrides. Omitting `overlays`, using an empty list, or removing a placement from the list clears the affected slots. An optional `layouts` object let multiple overlays reuse the same layout through `layoutRef` with different data; the reference server emits these when layouts repeat. If you've got a `channel` object set you need the `channelNumber` as a string and `hideOsd` is optional. TVS will keep tuning to that channel on every refresh until you remove the declarative state. If TVS fails to retrieve the JSON state or the JSON file is invalid we swallow the exception and retry until we get a success again. Unknown or invalid settings are ignored.

### IFrame embedding

Embedding mode allows you to use all the same commands as SSE entirely in the browser, but for security we require TVS to be configured with the exact origin domain that we'll be embedding it in. For instance, in your TVS config file set it like this to use the local demo:

```yaml
remoteManagement:
  type: embed
  parentOrigin: http://localhost:3991
```

Then connect to `http://localhost:3991/embed.html` and it'll work. Say you were running it on your LAN and connecting to `http://192.168.1.2:3991/embed.html` instead for example, it'd be `parentOrigin: http://192.168.1.2:3991` instead. If it isn't set up properly the entire form will be disabled so to avoid confusion about why pressing buttons doesn't do anything.

When embedding TVS, you communicate with it from the parent IFrame by posting messages to it.

```js
childIFrame.contentWindow.postMessage(
  {
    type: "TVS.RemoteManagement",
    event: "picture-settings",
    data: { noise: 0.4 }
  },
  "http://localhost:3990" // the origin TVS is listening on
);
```

TVS requires an exact, non-wildcard origin from the parent and verifies both `event.origin` and that `event.source` is the immediate parent. Open <http://localhost:3991/embed.html> for an interactive parent-page example.

The demo waits for TVS to send `TVS.EmbedReady` before enabling its controls. In embed mode there's also a powerful integration that lets the parent IFrame use the [TVS IFrame API](https://docs.tvs.gcpw.art/developer/iframe-api/) which is generally meant for channels *inside* TVS, but can also be useful in your apps to query what's being shown right now, upcoming guide listings and the like. For instance if you're embedding TVS in a page and want to show right above it what's playing right now. The demo showcases how `TVS.GetChannels`, `TVS.GetListings`, and `TVS.GetUpNext` work, along with live power, volume, mute, and current-channel messages. To match up the requests to replies, the commands we issue include a `requestId`, which TVS echoes in the matching response.

## SSE format

Each command is a named SSE event whose `data` field contains JSON:

```text
event: receiver-settings
data: {"volume":35,"isMuting":false}
```

The reference control API accepts the same event name at `POST /api/events/:eventName`:

```json
{
  "clientIds": ["lobby-tv"],
  "payload": { "volume": 35, "isMuting": false },
  "remember": true
}
```

Omit `clientIds` or pass an empty array to address every connected client. `remember` defaults to `true` for declarative events and is always ignored for `remote` input.

### `remote`

Acts exactly like a keyboard or phone-remote input. It is transient and is never replayed. Navigation commands (`help`, `setup`, and `about`) are intentionally unavailable because they can navigate away from the remotely controlled TV.

```json
{ "command": "volumeUp" }
```

Other examples include `turnOn`, `turnOff`, `muteOn`, `muteOff`, `channelUp`, `channelDown`, digits, picture toggle commands, `resetPicture`, and `version`.

### `channel-change`

Declaratively selects a channel. It is applied even while the television is powered off; it does not turn the television on.

```json
{ "channelNumber": "5.1", "hideOsd": true }
```

### `receiver-settings`

Updates only the supplied persisted receiver properties.

```json
{ "volume": 40, "isMuting": false }
```

Volume is from `0` to `50`.

### `picture-settings`

Updates persisted picture overrides. Omitted properties are unchanged, `null` clears an override, and `false` explicitly disables settings that support it.

```json
{
  "noise": 0.4,
  "noiseBlendMode": "screen",
  "blur": 1.5,
  "scanlines": true,
  "changeChannelNoise": true,
  "shadowMask": "slot-mask",
  "bezel": "flat",
  "autoScale": true,
  "scaleX": 100,
  "scaleY": 100
}
```

Picture resolution order is remote override, channel configuration, global configuration, then TVS default. Existing manual hide/toggle controls continue to behave like their physical remote equivalents.

The reference control panel includes live noise (`0.00`–`1.00`) and blur (`0.0`–`5.0`) sliders. They send partial `picture-settings` events while dragged, coalescing rapid input so events begin no more often than once every 10 ms. Only the setting being adjusted is included, and the final slider value is always retained for delivery.

### `overlay`

Creates or replaces one complete slot. `layout` is an inline Character Generator bulletin document. `data` uses Character Generator's existing `variables`, `lines`, and `pages` structure.

```json
{
  "channelNumber": "12",
  "slotNumber": 1,
  "layout": {
    "version": 2,
    "layout": {
      "showHeader": false,
      "showFooter": false,
      "body": { "backgroundColor": "transparent", "textColor": "white" }
    },
    "header": { "id": "header", "memo": "", "lines": [] },
    "footer": { "id": "footer", "memo": "", "lines": [] },
    "pages": [{ "id": "alert", "memo": "", "lines": [] }]
  },
  "data": {
    "variables": {
      "alert": "Severe thunderstorm warning",
      "area": "https://example.test/warning-map.png"
    }
  },
  "expiresAt": "2099-08-31T02:30:00.000Z",
  "audio": {
    "src": "https://example.test/attention-signal.mp3",
    "loop": true,
    "behavior": "duck",
    "duckTo": 0.25
  }
}
```

Use `"channelNumber": "*"` and omit `slotNumber` for the all-channels slot. It appears on positive channels only; channel zero and negative inputs are unaffected. Sending the same placement again replaces it. Sending to two channels requires two independent placements. The global slot appears above numbered slots; all remain below picture noise and the OSD. Overlay audio can mute or duck managed channel/component audio, but not television effects such as tuning noise.

### `overlay-data-update`

Replaces the complete dynamic-data object without retransmitting the layout. A new expiration is optional.

```json
{
  "channelNumber": "12",
  "slotNumber": 1,
  "data": { "variables": { "alert": "Warning extended until 9:00 PM" } },
  "expiresAt": "2099-08-31T03:00:00.000Z"
}
```

### `overlay-clear`

Clear every slot, only the all-channels slot, all slots on one numbered channel, or one particular slot:

```json
{}
```

```json
{ "channelNumber": "*" }
```

```json
{ "channelNumber": "12" }
```

```json
{ "channelNumber": "12", "slotNumber": 1 }
```

## Replay behavior in this server

Replay is an optional server feature, not a requirement of the protocol. The control panel can enable replay on connect/reconnect or manually replay remembered state.

This implementation remembers global and per-client declarative events in memory. On replay it clears stale overlay slots, then sends the current complete slots. Remote inputs are never stored. Server restart clears this example state; a production implementation can use its own database or event log.

The useful inspection endpoints are:

- `GET /api/clients` — SSE connections and recently polling JSON client IDs.
- `GET /api/client-events` — the control panel's SSE stream of complete client lists. It sends an initial list and updates on SSE connect/disconnect or when a new JSON client starts polling; a 30-second heartbeat removes expired JSON clients. This is a demo-control endpoint, not part of the TVS remote-management protocol. When the control key is enabled, native EventSource supplies it as `?key=…` because it cannot set request headers; avoid exposing that URL in logs.
- `GET /state.json?clientId=…` — projected JSON state for one polling client.
- `GET /api/settings` — current replay setting.
- `POST /api/settings` — update `{ "replayOnConnect": true }`.
- `POST /api/replay` — replay to all or the supplied `clientIds`.
- `POST /api/events/:eventName` — send and optionally remember an event.

## File Structure

The backend is split by function to make it easier for you to understand. In your own apps you only need to implement the features that you'll be using.

- `src/index.ts` composes the routes, control API, targeting, and adapters.
- `src/sse.ts` owns EventSource sessions and event delivery.
- `src/client-updates.ts` owns the control panel's separate client-list stream.
- `src/json.ts` owns snapshot responses and polling-client discovery.
- `src/replay.ts` contains all optional in-memory replay and state-projection logic.
- `src/client-request.ts` contains the client ID and query-key checks shared by SSE and JSON.
- `src/protocol.ts` contains the minimal wire contracts shared by the backend modules.
