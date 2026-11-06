import { gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { main } from "../src/doctor";

const INGEST = "https://ingest.example/v1/logs";
const ORIGIN = "https://app.example";

const PREFLIGHT_HEADERS = {
  "Access-Control-Allow-Origin": ORIGIN,
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Access-Control-Allow-Headers":
    "Content-Type, content-encoding, x-uiobs-batch-id, x-uiobs-attempt",
};

const POST_HEADERS = {
  "Access-Control-Allow-Origin": ORIGIN,
  "Access-Control-Expose-Headers": "Retry-After, x-uiobs-sampling, date",
};

/** Answers of one doctor run, in request order. */
interface Answers {
  preflight?: Response;
  first?: Response;
  repeated?: Response;
  zipped?: Response;
}

/** Records one request. */
interface Call {
  url: string;
  init: RequestInit;
}

const answer = (status: number, headers: Record<string, string>): Response =>
  new Response(null, { status, headers });

/** Stubs a server that meets the contract. A test replaces one of its answers. */
function stubServer(answers: Answers = {}): Call[] {
  const calls: Call[] = [];
  const order = [
    answers.preflight ?? answer(204, PREFLIGHT_HEADERS),
    answers.first ?? answer(202, POST_HEADERS),
    answers.repeated ?? answer(204, POST_HEADERS),
    answers.zipped ?? answer(200, POST_HEADERS),
  ];
  vi.stubGlobal(
    "fetch",
    vi.fn((url: string, init: RequestInit) => {
      calls.push({ url, init });
      return Promise.resolve(order[calls.length - 1]);
    }),
  );
  return calls;
}

/** Runs the tool and keeps its output. */
async function run(args: string[] = ["doctor", INGEST, "--origin", ORIGIN]) {
  const lines: string[] = [];
  const code = await main(args, (line) => {
    lines.push(line);
  });
  return { code, lines };
}

const headersOf = (call: Call): Record<string, string> =>
  call.init.headers as Record<string, string>;

describe("uiobs doctor", () => {
  it("passes each rule on a server that meets the contract", async () => {
    stubServer();
    const { code, lines } = await run();
    expect(code).toBe(0);
    expect(lines).toEqual([
      "PASS preflight: The server permits POST from this origin.",
      "PASS allowed headers: The server allows each request header of the library.",
      "PASS test batch: The server accepted a test batch.",
      "PASS exposed headers: The server exposes Retry-After.",
      "PASS gzip: The server accepted a gzip batch.",
      "PASS deduplication: The server accepted a repeated batch id. A client cannot see if it stored the batch again.",
    ]);
  });

  it("sends the preflight that a browser sends", async () => {
    const calls = stubServer();
    await run();
    expect(calls[0].url).toBe(INGEST);
    expect(calls[0].init.method).toBe("OPTIONS");
    expect(calls[0].init.signal).toBeDefined();
    // A browser refuses a preflight that redirects. A followed redirect gives a false PASS.
    expect(calls[0].init.redirect).toBe("manual");
    expect(headersOf(calls[0])).toEqual({
      Origin: ORIGIN,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers":
        "content-type, content-encoding, x-uiobs-batch-id, x-uiobs-attempt",
    });
  });

  it("sends one id two times and a new id with gzip", async () => {
    const calls = stubServer();
    await run();
    const [, first, repeated, zipped] = calls;

    expect(headersOf(first)).toMatchObject({ Origin: ORIGIN, "X-UiObs-Attempt": "0" });
    expect(headersOf(repeated)["X-UiObs-Batch-Id"]).toBe(headersOf(first)["X-UiObs-Batch-Id"]);
    expect(headersOf(repeated)["X-UiObs-Attempt"]).toBe("1");
    expect(headersOf(zipped)["X-UiObs-Batch-Id"]).not.toBe(headersOf(first)["X-UiObs-Batch-Id"]);
    expect(headersOf(zipped)["Content-Encoding"]).toBe("gzip");
    expect(headersOf(first)).not.toHaveProperty("Content-Encoding");

    const inflated = gunzipSync(zipped.init.body as Uint8Array).toString();
    expect(inflated).toBe(first.init.body);
    expect(inflated).toContain("uiobs-doctor");
    expect(JSON.parse(inflated)).toHaveProperty("resourceLogs");
  });

  it("accepts wildcards in each CORS header", async () => {
    stubServer({
      preflight: answer(204, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Allow-Methods": "*",
        "Access-Control-Allow-Headers": "*",
      }),
      first: answer(200, {
        "Access-Control-Allow-Origin": "*",
        "Access-Control-Expose-Headers": "*",
      }),
    });
    expect((await run()).code).toBe(0);
  });

  it("accepts a preflight without Access-Control-Allow-Methods", async () => {
    stubServer({
      preflight: answer(204, {
        "Access-Control-Allow-Origin": ORIGIN,
        "Access-Control-Allow-Headers": PREFLIGHT_HEADERS["Access-Control-Allow-Headers"],
      }),
    });
    expect((await run()).code).toBe(0);
  });

  it("names optional headers that stay hidden without a failure", async () => {
    stubServer({
      first: answer(202, {
        "Access-Control-Allow-Origin": ORIGIN,
        "Access-Control-Expose-Headers": "retry-after",
      }),
    });
    const { code, lines } = await run();
    expect(code).toBe(0);
    expect(lines).toContain(
      "PASS exposed headers: The server exposes Retry-After. Optional headers stay hidden: x-uiobs-sampling, date.",
    );
  });

  it.each<[string, Answers, string]>([
    [
      "a failed preflight",
      { preflight: answer(404, {}) },
      "FAIL preflight: The server returned 404.",
    ],
    [
      "a preflight for another origin",
      {
        preflight: answer(204, {
          ...PREFLIGHT_HEADERS,
          "Access-Control-Allow-Origin": "https://x",
        }),
      },
      `FAIL preflight: Access-Control-Allow-Origin is https://x. It must allow ${ORIGIN}.`,
    ],
    [
      "a missing allowed header",
      {
        preflight: answer(204, {
          ...PREFLIGHT_HEADERS,
          "Access-Control-Allow-Headers": "content-type",
        }),
      },
      "FAIL allowed headers: Access-Control-Allow-Headers must include content-encoding, x-uiobs-batch-id, x-uiobs-attempt.",
    ],
    [
      "a rejected batch",
      { first: answer(401, POST_HEADERS) },
      "FAIL test batch: The server returned 401.",
    ],
    [
      "a batch answer without CORS",
      { first: answer(202, {}) },
      `FAIL test batch: Access-Control-Allow-Origin is null. It must allow ${ORIGIN}.`,
    ],
    [
      "a hidden Retry-After",
      {
        first: answer(202, {
          "Access-Control-Allow-Origin": ORIGIN,
          "Access-Control-Expose-Headers": "date",
        }),
      },
      "FAIL exposed headers: Access-Control-Expose-Headers must include retry-after.",
    ],
    ["a rejected gzip body", { zipped: answer(415, {}) }, "FAIL gzip: The server returned 415."],
    [
      "a rejected repeated id",
      { repeated: answer(409, {}) },
      "FAIL deduplication: The server returned 409.",
    ],
  ])("fails for %s", async (_label, answers, line) => {
    stubServer(answers);
    const { code, lines } = await run();
    expect(code).toBe(1);
    expect(lines).toContain(line);
  });

  it.each([
    ["an Error", new Error("connection refused"), "connection refused"],
    ["another value", "socket closed", "socket closed"],
    [
      "a hidden cause",
      Object.assign(new TypeError("fetch failed"), { cause: new Error("connect ECONNREFUSED") }),
      "connect ECONNREFUSED",
    ],
  ])("fails each rule after a request failure with %s", async (_label, failure, text) => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(failure));
    const { code, lines } = await run();
    expect(code).toBe(1);
    expect(lines).toHaveLength(6);
    for (const line of lines) {
      expect(line).toMatch(/^FAIL /);
      expect(line).toContain(`The request failed. ${text}`);
    }
  });

  it("fails the gzip rule without CompressionStream", async () => {
    stubServer();
    vi.stubGlobal("CompressionStream", undefined);
    const { code, lines } = await run();
    expect(code).toBe(1);
    expect(lines).toContain("FAIL gzip: This Node version has no CompressionStream.");
  });

  it.each([
    [[]],
    [["other", INGEST, "--origin", ORIGIN]],
    [["doctor", INGEST]],
    [["doctor", INGEST, "--origin"]],
    [["doctor", INGEST, "--url", ORIGIN]],
    [["doctor", "ftp://ingest.example", "--origin", ORIGIN]],
    [["doctor", "http://", "--origin", ORIGIN]],
    [["doctor", INGEST, "--origin", `${ORIGIN}/path`]],
    [["doctor", INGEST, "--origin", "app.example"]],
    [["doctor", INGEST, "--origin", `${ORIGIN}/`]],
  ])("prints the usage for %j", async (args) => {
    const calls = stubServer();
    const { code, lines } = await run(args);
    expect(code).toBe(2);
    expect(lines).toEqual([
      "Usage: uiobs doctor <url> --origin <origin>. An origin has no path and no trailing slash.",
      `Received: ${JSON.stringify(args)}`,
    ]);
    expect(calls).toEqual([]);
  });
});
