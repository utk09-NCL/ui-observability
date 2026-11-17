import { gunzipSync } from "node:zlib";
import { describe, expect, it, vi } from "vitest";
import { main, runDoctor, runReplayDoctor } from "../src/doctor";

const INGEST = "https://ingest.example/v1/logs";
const ORIGIN = "https://app.example";
const USAGE =
  'Usage: uiobs doctor <url> --origin <origin> [--replay] [--header "Name: value"]. An origin has no path and no trailing slash. With --replay, the URL is a replay endpoint.';

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

/** The server's answers for one doctor run, in request order. */
interface Answers {
  preflight?: Response;
  first?: Response;
  repeated?: Response;
  zipped?: Response;
  beacon?: Response;
}

/** One recorded request. */
interface Call {
  url: string;
  init: RequestInit;
}

const answer = (status: number, headers: Record<string, string>): Response =>
  new Response(null, { status, headers });

/** Stubs a server that meets the contract. A test overrides one of its answers. */
function stubServer(answers: Answers = {}): Call[] {
  const calls: Call[] = [];
  const order = [
    answers.preflight ?? answer(204, PREFLIGHT_HEADERS),
    answers.first ?? answer(202, POST_HEADERS),
    answers.repeated ?? answer(204, POST_HEADERS),
    answers.zipped ?? answer(200, POST_HEADERS),
    answers.beacon ?? answer(204, {}),
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
      "PASS beacon: The server accepted a text/plain batch.",
    ]);
  });

  it("sends the beacon batch as text/plain with its id and reason in the query", async () => {
    const calls = stubServer();
    await run();
    const [, first, , zipped, beacon] = calls;
    const url = new URL(beacon.url);

    expect(calls).toHaveLength(5);
    expect(beacon.init.method).toBe("POST");
    expect(beacon.init.redirect).toBe("manual");
    // sendBeacon can't set headers, so only the content type and the origin are there.
    expect(headersOf(beacon)).toEqual({
      Origin: ORIGIN,
      "Content-Type": "text/plain;charset=UTF-8",
    });
    expect(`${url.origin}${url.pathname}`).toBe(INGEST);
    expect(url.searchParams.get("uiobs_exit")).toBe("pagehide");
    expect(url.searchParams.get("uiobs_batch_id")).toMatch(/^[0-9a-f-]{36}$/);
    expect(url.searchParams.get("uiobs_batch_id")).not.toBe(headersOf(first)["X-UiObs-Batch-Id"]);
    expect(url.searchParams.get("uiobs_batch_id")).not.toBe(headersOf(zipped)["X-UiObs-Batch-Id"]);
    expect(beacon.init.body).toBe(first.init.body);
  });

  it("sends the beacon when runDoctor gets no custom headers", async () => {
    const calls = stubServer();
    const results = await runDoctor(INGEST, ORIGIN);

    expect(calls).toHaveLength(5);
    expect(results.map(({ rule, pass }) => [rule, pass])).toEqual([
      ["preflight", true],
      ["allowed headers", true],
      ["test batch", true],
      ["exposed headers", true],
      ["gzip", true],
      ["deduplication", true],
      ["beacon", true],
    ]);
  });

  it("keeps the query of the ingest URL in the beacon URL", async () => {
    const calls = stubServer();
    await run(["doctor", `${INGEST}?tenant=a`, "--origin", ORIGIN]);
    const url = new URL(calls[4].url);

    expect(url.searchParams.get("tenant")).toBe("a");
    expect(url.searchParams.get("uiobs_exit")).toBe("pagehide");
  });

  it("sends each custom header on each batch and asks for it in the preflight", async () => {
    const calls = stubServer();
    const { code, lines } = await run([
      "doctor",
      INGEST,
      "--origin",
      ORIGIN,
      "--header",
      "Authorization: Bearer a.b:c",
      "--header",
      "X-Tenant:acme",
    ]);
    const [preflight, first, repeated, zipped] = calls;

    // A browser sends no credentials with a preflight. It only names the header.
    expect(headersOf(preflight)).toEqual({
      Origin: ORIGIN,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers":
        "content-type, content-encoding, x-uiobs-batch-id, x-uiobs-attempt, authorization, x-tenant",
    });

    for (const call of [first, repeated, zipped]) {
      expect(headersOf(call)).toMatchObject({
        Authorization: "Bearer a.b:c",
        "X-Tenant": "acme",
        Origin: ORIGIN,
      });
    }

    // The stub's preflight response doesn't allow the two custom headers.
    expect(code).toBe(1);
    expect(lines).toContain(
      "FAIL allowed headers: Access-Control-Allow-Headers must include authorization, x-tenant.",
    );
    expect(lines.join("\n")).not.toContain("Bearer");
  });

  it("sends no beacon with a custom header and passes the beacon rule", async () => {
    const calls = stubServer({
      preflight: answer(204, {
        ...PREFLIGHT_HEADERS,
        "Access-Control-Allow-Headers": `${PREFLIGHT_HEADERS["Access-Control-Allow-Headers"]}, Authorization`,
      }),
    });
    const { code, lines } = await run([
      "doctor",
      INGEST,
      "--origin",
      ORIGIN,
      "--header",
      "Authorization: Bearer secret",
    ]);

    expect(calls).toHaveLength(4);
    expect(code).toBe(0);
    expect(lines).toHaveLength(7);
    expect(lines[6]).toBe(
      "PASS beacon: The library sends no beacon with custom headers. The tool sent no beacon.",
    );
    expect(lines.join("\n")).not.toContain("secret");
  });

  it("keeps a custom header with the name __proto__ as a header", async () => {
    const calls = stubServer();
    await run(["doctor", INGEST, "--origin", ORIGIN, "--header", "__proto__: x"]);

    expect(Object.keys(headersOf(calls[1]))).toContain("__proto__");
    expect(headersOf(calls[0])["Access-Control-Request-Headers"]).toContain(", __proto__");
  });

  it("sends the preflight that a browser sends", async () => {
    const calls = stubServer();
    await run();
    expect(calls[0].url).toBe(INGEST);
    expect(calls[0].init.method).toBe("OPTIONS");
    expect(calls[0].init.signal).toBeDefined();
    // Browsers refuse a preflight that redirects, so following one would give a false PASS.
    expect(calls[0].init.redirect).toBe("manual");
    expect(headersOf(calls[0])).toEqual({
      Origin: ORIGIN,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers":
        "content-type, content-encoding, x-uiobs-batch-id, x-uiobs-attempt",
    });
  });

  it("sends one id twice and a new id with gzip", async () => {
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
    [
      "a text/plain batch that the server refuses for its media type, and names the collector",
      { beacon: answer(415, {}) },
      "FAIL beacon: The server returned 415 to a text/plain batch, as a stock OpenTelemetry Collector does. The library loses the exit batches of a page on another origin. Set headers in the app, or put a same-origin proxy in front of the server.",
    ],
    [
      "a text/plain batch that the server refuses for another reason",
      { beacon: answer(500, {}) },
      "FAIL beacon: The server returned 500.",
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
    expect(lines).toHaveLength(7);
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

  it.each<[string[], string[]]>([
    [[], []],
    [
      ["other", INGEST, "--origin", ORIGIN],
      ["<hidden>", INGEST, "--origin", ORIGIN],
    ],
    [
      ["doctor", INGEST],
      ["doctor", INGEST],
    ],
    [
      ["doctor", INGEST, "--origin"],
      ["doctor", INGEST, "--origin"],
    ],
    [
      ["doctor", INGEST, "--url", ORIGIN],
      ["doctor", INGEST, "<hidden>", ORIGIN],
    ],
    [
      ["doctor", "ftp://ingest.example", "--origin", ORIGIN],
      ["doctor", "<hidden>", "--origin", ORIGIN],
    ],
    [
      ["doctor", "http://", "--origin", ORIGIN],
      ["doctor", "<hidden>", "--origin", ORIGIN],
    ],
    [
      ["doctor", INGEST, "--origin", `${ORIGIN}/path`],
      ["doctor", INGEST, "--origin", `${ORIGIN}/path`],
    ],
    [
      ["doctor", INGEST, "--origin", "app.example"],
      ["doctor", INGEST, "--origin", "<hidden>"],
    ],
    [
      ["doctor", INGEST, "--origin", `${ORIGIN}/`],
      ["doctor", INGEST, "--origin", `${ORIGIN}/`],
    ],
  ])("prints the usage for %j", async (args, shown) => {
    const calls = stubServer();
    const { code, lines } = await run(args);
    expect(code).toBe(2);
    // The output shows known words and URLs. Anything else could be a token.
    expect(lines).toEqual([USAGE, `Received: ${JSON.stringify(shown)}`]);
    expect(calls).toEqual([]);
  });

  it.each<[string, string[], string[]]>([
    [
      "a header before the origin",
      ["doctor", "--header", "Authorization: Bearer secret", INGEST, "--origin", ORIGIN],
      ["doctor", "--header", "<hidden>", INGEST, "--origin", ORIGIN],
    ],
    [
      "a key in the query of the URL",
      ["doctor", `${INGEST}?api_key=secret`, "--origin"],
      ["doctor", INGEST, "--origin"],
    ],
    [
      "a password in the URL",
      ["doctor", "https://user:secret@ingest.example/v1/logs", "--origin", ORIGIN],
      ["doctor", INGEST, "--origin", ORIGIN],
    ],
    [
      "a token in place of the command",
      ["secret", INGEST, "--origin", ORIGIN],
      ["<hidden>", INGEST, "--origin", ORIGIN],
    ],
  ])("prints the usage and no secret for %s", async (_label, args, shown) => {
    const calls = stubServer();
    const { code, lines } = await run(args);

    expect(code).toBe(2);
    expect(lines).toEqual([USAGE, `Received: ${JSON.stringify(shown)}`]);
    expect(lines.join("\n")).not.toContain("secret");
    expect(calls).toEqual([]);
  });

  it.each([
    ["a flag with no value", ["--header"], ["--header"]],
    ["a value with no name", ["--header", "Bearer secret"], ["--header", "<hidden>"]],
    ["a name with a space", ["--header", "My Name: secret"], ["--header", "<hidden>"]],
    ["an empty value", ["--header", "Authorization:"], ["--header", "<hidden>"]],
    ["a value with a line break", ["--header", "A: secret\nB: c"], ["--header", "<hidden>"]],
    ["another flag", ["--token", "secret"], ["<hidden>", "<hidden>"]],
    [
      "a value in two arguments",
      ["--header", "Authorization:", "Bearer", "secret"],
      ["--header", "<hidden>", "<hidden>", "<hidden>"],
    ],
    ["a header of the library", ["--header", "content-type: secret"], ["--header", "<hidden>"]],
    ["the origin header", ["--header", "Origin: https://secret"], ["--header", "<hidden>"]],
    [
      "a good header before a bad one",
      ["--header", "Authorization: secret", "--header", "X-UiObs-Attempt: 9"],
      ["--header", "<hidden>", "--header", "<hidden>"],
    ],
  ])("prints the usage and hides each value for %s", async (_label, rest, shown) => {
    const calls = stubServer();
    const { code, lines } = await run(["doctor", INGEST, "--origin", ORIGIN, ...rest]);

    expect(code).toBe(2);
    expect(lines).toEqual([
      USAGE,
      `Received: ${JSON.stringify(["doctor", INGEST, "--origin", ORIGIN, ...shown])}`,
    ]);
    expect(lines.join("\n")).not.toContain("secret");
    expect(calls).toEqual([]);
  });

  it("hides an argument after the origin when the origin is wrong", async () => {
    stubServer();
    const { lines } = await run(["doctor", INGEST, "--origin", "app.example", "--header", "A: s"]);

    expect(lines[1]).toBe(
      `Received: ${JSON.stringify(["doctor", INGEST, "--origin", "<hidden>", "--header", "<hidden>"])}`,
    );
  });
});

describe("uiobs doctor --replay", () => {
  const REPLAY = "https://ingest.example/v1/replay";
  const ARGS = ["doctor", REPLAY, "--origin", ORIGIN, "--replay"];

  /** The server's answers for one replay run, in request order. */
  interface ReplayAnswers {
    preflight?: Response;
    first?: Response;
    repeated?: Response;
    zipped?: Response;
    large?: Response;
  }

  /** Stubs a replay endpoint that meets the contract. A test overrides one of its answers. */
  function stubReplay(answers: ReplayAnswers = {}): Call[] {
    const calls: Call[] = [];
    const order = [
      answers.preflight ?? answer(204, PREFLIGHT_HEADERS),
      answers.first ?? answer(202, POST_HEADERS),
      answers.repeated ?? answer(202, POST_HEADERS),
      answers.zipped ?? answer(202, POST_HEADERS),
      answers.large ?? answer(202, POST_HEADERS),
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

  /** A segment body as the tool sent it. */
  interface Body {
    "replay.id": string;
    "session.id": string;
    "tab.id": string;
    "service.name": string;
    sequence: number;
    bytes: number;
    events: { type: number; timestamp: number; data: { tag: string; payload: string } }[];
  }

  const bodyOf = (call: Call): Body => JSON.parse(call.init.body as string) as Body;

  it("passes each rule on a replay endpoint that meets the contract", async () => {
    stubReplay();
    const { code, lines } = await run(ARGS);

    expect(code).toBe(0);
    expect(lines).toEqual([
      "PASS preflight: The server permits POST from this origin.",
      "PASS allowed headers: The server allows each request header of the library.",
      "PASS test segment: The server accepted a test segment.",
      "PASS gzip: The server accepted a gzip segment.",
      "PASS large segment: The server accepted a segment of 5000000 bytes without gzip.",
      "PASS deduplication: The server accepted a repeated batch id. A client cannot see if it stored the segment again.",
    ]);
  });

  it("sends the segment body and the headers of the uploader", async () => {
    const calls = stubReplay();
    await run(ARGS);
    const [preflight, first] = calls;
    const body = bodyOf(first);

    expect(calls).toHaveLength(5);
    expect(calls.every(({ url }) => url === REPLAY)).toBe(true);
    expect(headersOf(preflight)["Access-Control-Request-Headers"]).toBe(
      "content-type, content-encoding, x-uiobs-batch-id, x-uiobs-attempt",
    );
    expect(headersOf(first)).toEqual({
      Origin: ORIGIN,
      "Content-Type": "application/json",
      "X-UiObs-Batch-Id": `${body["replay.id"]}-0`,
      "X-UiObs-Attempt": "0",
    });
    expect(body["replay.id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(body["session.id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(body["tab.id"]).toMatch(/^[0-9a-f-]{36}$/);
    expect(body["service.name"]).toBe("uiobs-doctor");
    expect(body.sequence).toBe(0);
    // bytes is the JSON length of the event list, as in a real segment.
    expect(body.bytes).toBe(JSON.stringify(body.events).length);
    expect(body.events).toEqual([
      {
        type: 5,
        timestamp: expect.any(Number) as number,
        data: { tag: "uiobs-doctor", payload: "uiobs doctor test event" },
      },
    ]);
  });

  it("sends the first segment twice, then a gzip segment and a large segment", async () => {
    const calls = stubReplay();
    await run(ARGS);
    const [, first, repeated, zipped, large] = calls;
    const replayId = bodyOf(first)["replay.id"];
    const unzipped = JSON.parse(
      gunzipSync(zipped.init.body as Uint8Array).toString("utf8"),
    ) as Body;

    expect(repeated.init.body).toBe(first.init.body);
    expect(headersOf(repeated)["X-UiObs-Batch-Id"]).toBe(`${replayId}-0`);
    expect(headersOf(repeated)["X-UiObs-Attempt"]).toBe("1");

    expect(headersOf(zipped)["Content-Encoding"]).toBe("gzip");
    expect(headersOf(zipped)["X-UiObs-Batch-Id"]).toBe(`${replayId}-1`);
    expect(unzipped).toMatchObject({ "replay.id": replayId, sequence: 1 });

    // The large segment goes without gzip, which is the worst case for a body limit.
    expect(headersOf(large)).not.toHaveProperty("Content-Encoding");
    expect(headersOf(large)["X-UiObs-Batch-Id"]).toBe(`${replayId}-2`);
    expect(bodyOf(large)).toMatchObject({ "replay.id": replayId, sequence: 2 });
    expect(bodyOf(large).events[0].data.payload).toHaveLength(5_000_000);
  });

  it("gives the large segment the default request timeout of the library", async () => {
    stubReplay();
    const timeout = vi.spyOn(AbortSignal, "timeout");
    await run(ARGS);

    // The preflight and the small segments get 10 s. The 5 MB body gets the 15 s that the
    // library gives a segment by default, or a slow link fails here and works in the app.
    expect(timeout.mock.calls.map(([ms]) => ms)).toEqual([10_000, 10_000, 10_000, 10_000, 15_000]);
  });

  it("sends each custom header on each segment and asks for it in the preflight", async () => {
    const calls = stubReplay({
      preflight: answer(204, {
        ...PREFLIGHT_HEADERS,
        "Access-Control-Allow-Headers": `${PREFLIGHT_HEADERS["Access-Control-Allow-Headers"]}, authorization`,
      }),
    });
    const { code, lines } = await run([...ARGS, "--header", "Authorization: Bearer token"]);
    const [preflight, ...posts] = calls;

    expect(code).toBe(0);
    expect(lines.join("\n")).not.toContain("token");
    expect(headersOf(preflight)["Access-Control-Request-Headers"]).toBe(
      "content-type, content-encoding, x-uiobs-batch-id, x-uiobs-attempt, authorization",
    );
    expect(posts).toHaveLength(4);
    expect(posts.every((call) => headersOf(call).Authorization === "Bearer token")).toBe(true);
  });

  it("fails the large segment rule when the server refuses the body", async () => {
    stubReplay({ large: answer(413, POST_HEADERS) });
    const { code, lines } = await run(ARGS);

    expect(code).toBe(1);
    expect(lines.filter((line) => line.startsWith("FAIL"))).toEqual([
      "FAIL large segment: The server returned 413 for a segment of 5000000 bytes. The first segment of an upload has a full snapshot of the page. Raise the body limit of the server.",
    ]);
  });

  it("fails a rule for each answer that breaks the contract", async () => {
    stubReplay({
      preflight: answer(204, { "Access-Control-Allow-Origin": "https://other.example" }),
      first: answer(202, {}),
      repeated: answer(500, POST_HEADERS),
      zipped: answer(415, POST_HEADERS),
    });
    const { code, lines } = await run(ARGS);

    expect(code).toBe(1);
    expect(lines).toEqual([
      "FAIL preflight: Access-Control-Allow-Origin is https://other.example. It must allow https://app.example.",
      "FAIL allowed headers: Access-Control-Allow-Headers must include content-type, content-encoding, x-uiobs-batch-id, x-uiobs-attempt.",
      "FAIL test segment: Access-Control-Allow-Origin is null. It must allow https://app.example.",
      "FAIL gzip: The server returned 415.",
      "PASS large segment: The server accepted a segment of 5000000 bytes without gzip.",
      "FAIL deduplication: The server returned 500.",
    ]);
  });

  it("fails the gzip rule without CompressionStream and still sends the large segment", async () => {
    const calls = stubReplay();
    vi.stubGlobal("CompressionStream", undefined);
    const results = await runReplayDoctor(REPLAY, ORIGIN);

    // Preflight, first, repeated and large. No gzip request.
    expect(calls).toHaveLength(4);
    expect(results.map(({ rule, pass }) => [rule, pass])).toEqual([
      ["preflight", true],
      ["allowed headers", true],
      ["test segment", true],
      ["gzip", false],
      ["large segment", true],
      ["deduplication", true],
    ]);
    expect(results[3].detail).toBe("This Node version has no CompressionStream.");
  });

  it("prints the usage when the replay flag comes after a header option", async () => {
    stubReplay();
    const { code, lines } = await run([
      "doctor",
      REPLAY,
      "--origin",
      ORIGIN,
      "--header",
      "Authorization: Bearer token",
      "--replay",
    ]);

    expect(code).toBe(2);
    expect(lines).toEqual([
      USAGE,
      'Received: ["doctor","https://ingest.example/v1/replay","--origin","https://app.example","--header","<hidden>","--replay"]',
    ]);
  });
});
