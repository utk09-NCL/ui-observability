// src/doctor.ts
//
// Checks an ingest server against the ingest contract in the README. The `uiobs doctor` command
// calls main(). The code uses web APIs only. The browser build replaces each "node:" import.

import {
  ENCODING_GZIP,
  HEADER_ATTEMPT,
  HEADER_BATCH_ID,
  HEADER_CONTENT_ENCODING,
  HEADER_CONTENT_TYPE,
  HEADER_DATE,
  HEADER_RETRY_AFTER,
  HEADER_SAMPLING,
  SEVERITY_NUMBER,
} from "./constants";
import type { LogRecord } from "./models/log-record";
import { gzip } from "./transport/compression";
import { otlpSerializer } from "./transport/serializers/otlp";

/** Maximum wait for one answer, in milliseconds. */
const REQUEST_TIMEOUT_MS = 10000;

/** Exit code when each rule passes. */
const EXIT_PASS = 0;

/** Exit code when a rule fails. */
const EXIT_FAIL = 1;

/** Exit code of a wrong command. */
const EXIT_USAGE = 2;

/** Text of a wrong command. */
const USAGE =
  "Usage: uiobs doctor <url> --origin <origin>. An origin has no path and no trailing slash.";

/** Response header that lists the headers a page can read. */
const EXPOSE_HEADERS = "Access-Control-Expose-Headers";

/** Request headers of the library. The server must allow each one. */
const REQUEST_HEADERS = [
  HEADER_CONTENT_TYPE,
  HEADER_CONTENT_ENCODING,
  HEADER_BATCH_ID,
  HEADER_ATTEMPT,
].map((name) => name.toLowerCase());

/** Response headers that only an optional feature reads. */
const OPTIONAL_EXPOSED = [HEADER_SAMPLING, HEADER_DATE].map((name) => name.toLowerCase());

/** Result of one rule of the ingest contract. */
export interface DoctorResult {
  /** Rule name. */
  rule: string;
  /** True when the server meets the rule. */
  pass: boolean;
  /** Reason of the result. */
  detail: string;
}

/** An HTTP answer, or the text of a failed request. */
type Answer = Response | string;

/** Gives the text of a problem, or undefined when the answer meets the test. */
type AnswerTest = (response: Response) => string | undefined;

/** Builds the test record. The server stores it as an ordinary record. */
function testRecord(): LogRecord {
  const traceId = crypto.randomUUID().replaceAll("-", "");

  return {
    timeUnixNano: `${String(Date.now())}000000`,
    traceId,
    spanId: traceId.slice(0, 16),
    traceFlags: 1,
    severityNumber: SEVERITY_NUMBER.INFO,
    severityText: "INFO",
    body: "uiobs doctor test record",
    attributes: {},
    resource: { "service.name": "uiobs-doctor" },
  };
}

/** Sends one request. The result line reports a failure. The tool has no diagnostics instance. */
async function request(url: string, init: RequestInit): Promise<Answer> {
  try {
    // A browser refuses a preflight that redirects. A redirect can also name another host.
    return await fetch(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    });
  } catch (error) {
    // Node gives only "fetch failed". The cause holds the reason, for example ECONNREFUSED.
    const reason: unknown = error instanceof Error ? (error.cause ?? error) : error;

    return `The request failed. ${reason instanceof Error ? reason.message : String(reason)}`;
  }
}

/** Gives the wanted values that a comma-separated header omits. A wildcard has each value. */
function absent(response: Response, name: string, wanted: readonly string[]): string[] {
  const values = (response.headers.get(name) ?? "")
    .toLowerCase()
    .split(",")
    .map((value) => value.trim());

  return values.includes("*") ? [] : wanted.filter((value) => !values.includes(value));
}

/** Tests the status of an answer. */
const statusProblem: AnswerTest = (response) =>
  response.ok ? undefined : `The server returned ${String(response.status)}.`;

/** Builds the result of one rule. The first problem is the detail. */
function judge(rule: string, answer: Answer, passed: string, ...tests: AnswerTest[]): DoctorResult {
  const problem =
    typeof answer === "string"
      ? answer
      : tests.map((test) => test(answer)).find((found) => found !== undefined);

  return { rule, pass: problem === undefined, detail: problem ?? passed };
}

/**
 * Sends the requests of each rule, one at a time. Two requests with one batch id must not overlap.
 * @param url Ingest URL.
 * @param origin Origin of the app.
 * @returns One result for each rule.
 */
export async function runDoctor(url: string, origin: string): Promise<DoctorResult[]> {
  const originProblem: AnswerTest = (response) => {
    const allowed = response.headers.get("Access-Control-Allow-Origin");

    return allowed === origin || allowed === "*"
      ? undefined
      : `Access-Control-Allow-Origin is ${String(allowed)}. It must allow ${origin}.`;
  };

  const preflight = await request(url, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": REQUEST_HEADERS.join(", "),
    },
  });

  const { body, contentType } = otlpSerializer.serialize([testRecord()]);
  const post = (
    id: string,
    attempt: number,
    payload: BodyInit,
    extra: Record<string, string> = {},
  ): Promise<Answer> =>
    request(url, {
      method: "POST",
      headers: {
        Origin: origin,
        [HEADER_CONTENT_TYPE]: contentType,
        [HEADER_BATCH_ID]: id,
        [HEADER_ATTEMPT]: String(attempt),
        ...extra,
      },
      body: payload,
    });

  const batchId = crypto.randomUUID();
  const first = await post(batchId, 0, body);
  const repeated = await post(batchId, 1, body);
  const compressed = await gzip(body);
  const zipped = compressed
    ? await post(crypto.randomUUID(), 0, compressed, {
        [HEADER_CONTENT_ENCODING]: ENCODING_GZIP,
      })
    : "This Node version has no CompressionStream.";

  const hidden = typeof first === "string" ? [] : absent(first, EXPOSE_HEADERS, OPTIONAL_EXPOSED);
  const note = hidden.length > 0 ? ` Optional headers stay hidden: ${hidden.join(", ")}.` : "";

  return [
    judge(
      "preflight",
      preflight,
      "The server permits POST from this origin.",
      statusProblem,
      originProblem,
    ),
    judge(
      "allowed headers",
      preflight,
      "The server allows each request header of the library.",
      (response) => {
        const missing = absent(response, "Access-Control-Allow-Headers", REQUEST_HEADERS);

        return missing.length > 0
          ? `Access-Control-Allow-Headers must include ${missing.join(", ")}.`
          : undefined;
      },
    ),
    judge("test batch", first, "The server accepted a test batch.", statusProblem, originProblem),
    judge("exposed headers", first, `The server exposes Retry-After.${note}`, (response) =>
      absent(response, EXPOSE_HEADERS, [HEADER_RETRY_AFTER.toLowerCase()]).length > 0
        ? `${EXPOSE_HEADERS} must include retry-after.`
        : undefined,
    ),
    judge("gzip", zipped, "The server accepted a gzip batch.", statusProblem),
    judge(
      "deduplication",
      repeated,
      "The server accepted a repeated batch id. A client cannot see if it stored the batch again.",
      statusProblem,
    ),
  ];
}

/** Tests an HTTP URL. */
function isHttpUrl(value: string): boolean {
  return /^https?:\/\//i.test(value) && URL.canParse(value);
}

/** Tests an exact browser origin. A path or a trailing slash does not match. */
function isOrigin(value: string): boolean {
  return URL.canParse(value) && new URL(value).origin === value;
}

/**
 * Runs the command line tool.
 * @param args Arguments after the program name.
 * @param print Writes one line of output.
 * @returns The exit code.
 */
export async function main(
  args: readonly string[],
  print: (line: string) => void,
): Promise<number> {
  const [command, url, flag, origin] = args;

  if (command !== "doctor" || flag !== "--origin" || !isHttpUrl(url) || !isOrigin(origin)) {
    print(USAGE);
    print(`Received: ${JSON.stringify(args)}`);
    return EXIT_USAGE;
  }

  const results = await runDoctor(url, origin);

  for (const { rule, pass, detail } of results) {
    print(`${pass ? "PASS" : "FAIL"} ${rule}: ${detail}`);
  }

  return results.every(({ pass }) => pass) ? EXIT_PASS : EXIT_FAIL;
}
