// e2e/playground/mock-servers.smoke.ts
//
// Checks the two mock servers of the playground apps, with no browser. A page that the user opens
// in the same browser can call a server on localhost, and a DNS name that the attacker controls
// can point to it. The servers must refuse a Host that is not a loopback name, and the replay
// store must keep its byte limit.

import { request as httpRequest } from "node:http";
import { expect, test } from "@playwright/test";
import { APP_API_ORIGIN, APP_API_PORT, INGEST_ORIGIN, INGEST_PORT } from "./ports";

const MEGABYTE = 1024 * 1024;
// The replay store of the mock ingest server keeps at most 64 MB. Keep this number in step with
// REPLAY_LIMITS.maxTotalBytes in tools/mock-ingest-server.mjs.
const STORE_LIMIT_BYTES = 64 * MEGABYTE;

interface Answer {
  status: number;
  body: string;
}

/**
 * Sends one request with a Host header that the caller chooses. fetch() does not allow it, so
 * the helper uses node:http.
 */
function send(
  port: number,
  host: string,
  path: string,
  extra: Record<string, string> = {},
  method = "GET",
): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const outgoing = httpRequest(
      { host: "127.0.0.1", port, path, method, headers: { Host: host, ...extra } },
      (response) => {
        const chunks: Buffer[] = [];
        response.on("data", (chunk: Buffer) => chunks.push(chunk));
        response.on("end", () => {
          resolve({ status: response.statusCode ?? 0, body: Buffer.concat(chunks).toString() });
        });
      },
    );
    // A server that accepts the upgrade answers with 101 and no body. The helper takes the status
    // and closes the socket.
    outgoing.on("upgrade", (response, socket) => {
      socket.destroy();
      resolve({ status: response.statusCode ?? 0, body: "" });
    });
    outgoing.on("error", reject);
    outgoing.end();
  });
}

test.beforeEach(async () => {
  await fetch(`${INGEST_ORIGIN}/__reset`, { method: "POST" });
  await fetch(`${APP_API_ORIGIN}/api/__reset`, { method: "POST" });
});

for (const [name, port, path] of [
  ["mock ingest server", INGEST_PORT, "/v1/replay/recordings"],
  ["mock app API", APP_API_PORT, "/api/tenants"],
] as const) {
  test.describe(name, () => {
    test("refuses a Host that is not a loopback name", async () => {
      for (const host of [
        `rebind.attacker.example:${String(port)}`,
        "rebind.attacker.example",
        `localhost.attacker.example:${String(port)}`,
        `127.0.0.1.attacker.example:${String(port)}`,
        // The servers listen on 127.0.0.1 only, so a client can't reach them with this name.
        `[::1]:${String(port)}`,
      ]) {
        const answer = await send(port, host, path);

        expect(answer.status, host).toBe(403);
        expect(answer.body).toContain("Host");
      }
    });

    test("answers a loopback Host, with or without a port", async () => {
      for (const host of [`localhost:${String(port)}`, "localhost", `127.0.0.1:${String(port)}`]) {
        const answer = await send(port, host, path);

        expect(answer.status, host).toBe(200);
      }
    });
  });
}

test("the mock app API refuses a WebSocket upgrade for a Host that is not loopback", async () => {
  const answer = await send(
    APP_API_PORT,
    `rebind.attacker.example:${String(APP_API_PORT)}`,
    "/api/stream",
    {
      Connection: "Upgrade",
      Upgrade: "websocket",
      "Sec-WebSocket-Version": "13",
      "Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
    },
  );

  expect(answer.status).toBe(403);
});

test.describe("replay store of the mock ingest server", () => {
  /** One segment of 7.5 million characters of 2 bytes each, so 15 MB as UTF-8 and half as text. */
  function segment(replayId: string, sequence: number): string {
    return JSON.stringify({
      "replay.id": replayId,
      "session.id": "session-1",
      "tab.id": "tab-1",
      "service.name": "limit-spec",
      sequence,
      events: ["é".repeat(7.5 * MEGABYTE)],
    });
  }

  async function post(body: string): Promise<Response> {
    return fetch(`${INGEST_ORIGIN}/v1/replay`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body,
    });
  }

  test("refuses a segment that would take one recording past the byte limit", async () => {
    const statuses: number[] = [];
    for (let sequence = 0; sequence < 5; sequence += 1) {
      statuses.push((await post(segment("limit-recording-1", sequence))).status);
    }

    // Four segments of 15 MB are 60 MB. The fifth would make 75 MB, so the server refuses it.
    expect(statuses).toEqual([204, 204, 204, 204, 400]);
    const refused = await post(segment("limit-recording-1", 4));
    expect(await refused.json()).toMatchObject({ error: expect.stringContaining("limit") });

    const list = (await (await fetch(`${INGEST_ORIGIN}/v1/replay/recordings`)).json()) as {
      bytes: number;
    }[];
    expect(list).toHaveLength(1);
    expect(list[0].bytes).toBeLessThanOrEqual(STORE_LIMIT_BYTES);
  });

  test("counts bytes and not characters", async () => {
    // The segment has 7,864,320 characters and 15 MiB. A count of characters gives half the bytes.
    const first = await post(segment("limit-recording-2", 0));
    expect(first.status).toBe(204);

    const list = (await (await fetch(`${INGEST_ORIGIN}/v1/replay/recordings`)).json()) as {
      bytes: number;
    }[];
    expect(list[0].bytes).toBeGreaterThan(14 * MEGABYTE);
  });

  test("evicts the oldest recording when a new one needs the room", async () => {
    for (let recording = 0; recording < 4; recording += 1) {
      for (let sequence = 0; sequence < 2; sequence += 1) {
        expect((await post(segment(`limit-eviction-${String(recording)}`, sequence))).status).toBe(
          204,
        );
      }
    }

    const list = (await (await fetch(`${INGEST_ORIGIN}/v1/replay/recordings`)).json()) as {
      id: string;
      bytes: number;
    }[];
    const total = list.reduce((sum, recording) => sum + recording.bytes, 0);

    // Eight segments of 15 MB are 120 MB. The store keeps the newest recordings that fit in 64 MB.
    expect(total).toBeLessThanOrEqual(STORE_LIMIT_BYTES);
    expect(list.map((recording) => recording.id)).toContain("limit-eviction-3");
    expect(list.map((recording) => recording.id)).not.toContain("limit-eviction-0");
  });
});
