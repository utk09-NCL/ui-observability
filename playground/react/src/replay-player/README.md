# replay-player

This folder plays the session replays that the library uploads. The npm package of the library ships no player. A team builds the viewer into its own tooling, as this folder does. Copy the folder into your app and replace the two items in the table.

| File | What it does | Replace |
| --- | --- | --- |
| `replay-api.ts` | `listRecordings()` and `loadRecordingEvents()`. They check the shape of each answer. | `REPLAY_SERVICE_URL` and `getJson()`. |
| `replay-player.tsx` | `ReplayPlayer`, a React component for `rrweb-player` 2.2.2. It imports the CSS of the player. | Nothing. |

## What the folder needs

- `react` and `react-dom`.
- `rrweb-player` 2.2.2. The recorder package of your app, `@rrweb/record`, makes the events. The player reads them.
- A replay service with two routes. The mock ingest server of this repository has them.

| Request | Answer |
| --- | --- |
| `GET <REPLAY_SERVICE_URL>` | A list of recordings, newest first. Each entry has `id`, `service`, `sessionId`, `tabId`, `startedAt`, `segments`, `events` and `bytes`. It has no events. |
| `GET <REPLAY_SERVICE_URL>/<id>` | One recording. It has `segments`, a list of `{ sequence, events }`. |

A segment is what `replay.endpoint` receives. Its body has `replay.id`, `session.id`, `tab.id`, `service.name`, `sequence` and `events`. Your service keeps the segments of one `replay.id` together, and it gives them back in the order of `sequence`.

## The one function to replace

`getJson(url)` calls `fetch()`. Replace it when your service needs a token, another base URL or another way to call. The rest of the folder does not change.

## Rules

- `parseRecordingEvents()` joins the segments in the order of their sequence numbers. It throws for an event without a `type` and a `timestamp`. The player can not read such an event, and the error names the cause.
- `ReplayPlayer` makes the player in an effect, and the cleanup destroys it. A second player on the stage would play on top of the first. StrictMode runs the effect two times, so the cleanup is necessary.
- The events are data of your users. The player of `@rrweb/replay` 2.2.2 shows the recorded page in an iframe with `sandbox="allow-same-origin"`, and so without scripts. The code sets `allow-scripts` only with the option `UNSAFE_replayCanvas`. Never set it for events of users. This comes from reading the package, not from a test.
- The player needs at least 2 events. The first two are the meta event and the full snapshot.
- Each request of the page is a record of the library too. The list has no timer for that reason. A button asks again.
- The recorder masks the text and the input values before the events leave the page. The player can not show what the recorder masked.
- The specs of this folder need `vitest.setup.ts` and `test/observability.ts` of the app.
