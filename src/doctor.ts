// src/doctor.ts
//
// Checks an ingest server, or a replay endpoint, against its contract in docs/ingest-server.md.
// The `uiobs doctor` command calls main(). Only web APIs are used here, and the browser build
// replaces every "node:" import.

import {
  CONTENT_TYPE_JSON,
  CONTENT_TYPE_TEXT_PLAIN,
  ENCODING_GZIP,
  HEADER_ATTEMPT,
  HEADER_BATCH_ID,
  HEADER_CONTENT_ENCODING,
  HEADER_CONTENT_TYPE,
  HEADER_DATE,
  HEADER_RETRY_AFTER,
  HEADER_SAMPLING,
  HTTP_UNSUPPORTED_MEDIA_TYPE,
  QUERY_PARAM_BATCH_ID,
  QUERY_PARAM_EXIT_REASON,
  REQUEST_TIMEOUT_MS as LIBRARY_TIMEOUT_MS,
  SEVERITY_NUMBER,
} from "./constants";
import type { LogRecord } from "./models/log-record";
import { gzip } from "./transport/compression";
import { otlpSerializer } from "./transport/serializers/otlp";

/** How long to wait for one answer, in milliseconds. */
const REQUEST_TIMEOUT_MS = 10000;

/** Exit code when every rule passes. */
const EXIT_PASS = 0;

/** Exit code when a rule fails. */
const EXIT_FAIL = 1;

/** Exit code for a wrong command. */
const EXIT_USAGE = 2;

/** Printed for a wrong command. */
const USAGE =
  'Usage: uiobs doctor <url> --origin <origin> [--replay] [--credentials include] [--header "Name: value"]. An origin has no path and no trailing slash. With --replay, the URL is a replay endpoint. With --credentials include, a * in a CORS header fails.';

/** Adds a request header, e.g. an Authorization header. */
const HEADER_FLAG = "--header";

/** Says that the URL is a replay endpoint, so the tool sends segments instead of batches. */
const REPLAY_FLAG = "--replay";

/** Says that the app sets `credentials: "include"`, so a browser refuses a * in a CORS header. */
const CREDENTIALS_FLAG = "--credentials";

/** The only value of CREDENTIALS_FLAG. */
const CREDENTIALS_INCLUDE = "include";

/**
 * Size of the event in the large test segment, in characters. The first segment of a real
 * upload holds a full snapshot, and one of a page with 35,000 table cells measured 4.7 MB.
 */
const LARGE_EVENT_CHARS = 5_000_000;

/** The recorder's custom event type. A player skips a custom event it doesn't know. */
const CUSTOM_EVENT = 5;

/** Marks everything the tool stores, so an operator can find and delete it. */
const DOCTOR_NAME = "uiobs-doctor";

/** A header name, a colon, then a value of printable ASCII. */
const HEADER_PATTERN = /^([\w!#$%&'*+.^`|~-]+): *([\x20-\x7e]+)$/;

/** Printed in place of any argument that might contain a secret. */
const HIDDEN = "<hidden>";

/** Response header that lists the headers a page can read. */
const EXPOSE_HEADERS = "Access-Control-Expose-Headers";

/** Response header that names the origin that may read the answer. */
const ALLOW_ORIGIN = "Access-Control-Allow-Origin";

/** Response header of a preflight that lists the request headers the server accepts. */
const ALLOW_HEADERS = "Access-Control-Allow-Headers";

/** Response header that lets a browser send and read an answer with credentials. */
const ALLOW_CREDENTIALS = "Access-Control-Allow-Credentials";

/** Why a * in Access-Control-Allow-Origin fails with credentials. */
const STAR_REFUSED = 'A browser refuses * with credentials: "include".';

/** Why a * in a list of header names fails with credentials. */
const STAR_PLAIN = 'A browser does not read * as a wildcard with credentials: "include".';

/** Why a * in Access-Control-Allow-Headers fails for Authorization, with or without credentials. */
const STAR_AUTHORIZATION = "A browser never lets * cover authorization.";

/** Ends the note of a PASS line that only a * earned, so the run without credentials says so. */
const STAR_HINT = "Add --credentials include to check that case.";

/** The library's request headers. The server must allow every one of them. */
const REQUEST_HEADERS = [
  HEADER_CONTENT_TYPE,
  HEADER_CONTENT_ENCODING,
  HEADER_BATCH_ID,
  HEADER_ATTEMPT,
].map((name) => name.toLowerCase());

/** Headers the tool sets itself. A custom header can't reuse one of these names. */
const RESERVED_HEADERS = [...REQUEST_HEADERS, "origin"];

/** Response headers that only an optional feature reads. */
const OPTIONAL_EXPOSED = [HEADER_SAMPLING, HEADER_DATE].map((name) => name.toLowerCase());

/** The one request header that a * in Access-Control-Allow-Headers never covers. */
const NON_WILDCARD_HEADER = "authorization";

/** The response header that the library can't work without when it is hidden. */
const REQUIRED_EXPOSED = [HEADER_RETRY_AFTER.toLowerCase()];

/** Every response header that the library reads. */
const WANTED_EXPOSED = [...REQUIRED_EXPOSED, ...OPTIONAL_EXPOSED];

/** The result of one ingest contract rule. */
export interface DoctorResult {
  /** Rule name. */
  rule: string;
  /** True when the server meets the rule. */
  pass: boolean;
  /** Why the rule passed or failed. */
  detail: string;
}

/** An HTTP answer, or the text of a failed request. */
type Answer = Response | string;

/** Returns a description of the problem, or undefined when the answer passes the test. */
type AnswerTest = (response: Response) => string | undefined;

/** Builds the test record. The server stores it like any other record. */
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
    resource: { "service.name": DOCTOR_NAME },
  };
}

/** Sends one request. A failure shows up in the result line, as the tool has no diagnostics. */
async function request(
  url: string,
  init: RequestInit,
  timeoutMs = REQUEST_TIMEOUT_MS,
): Promise<Answer> {
  try {
    // A browser refuses a preflight that redirects, and a redirect can also name another host.
    return await fetch(url, {
      ...init,
      redirect: "manual",
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    // Node only says "fetch failed". The cause holds the real reason, for example ECONNREFUSED.
    const reason: unknown =
      error instanceof Error ? ((error as Error & { cause?: unknown }).cause ?? error) : error;

    return `The request failed. ${reason instanceof Error ? reason.message : String(reason)}`;
  }
}

/** Returns the lowercase values of a comma-separated response header. */
function valuesOf(response: Response, name: string): string[] {
  return (response.headers.get(name) ?? "")
    .toLowerCase()
    .split(",")
    .map((value) => value.trim());
}

/**
 * Returns the wanted values a comma-separated header leaves out. With wildcard, a * covers them
 * all but Authorization, which the Fetch standard never lets a * cover. A run with credentials
 * passes false, because a browser reads * as a plain name then.
 */
function absent(
  response: Response,
  name: string,
  wanted: readonly string[],
  wildcard: boolean,
): string[] {
  const values = valuesOf(response, name);
  const star = wildcard && values.includes("*");

  return wanted.filter(
    (value) => !values.includes(value) && !(star && value !== NON_WILDCARD_HEADER),
  );
}

/** Checks an answer's status. */
const statusProblem: AnswerTest = (response) =>
  response.ok ? undefined : `The server returned ${String(response.status)}.`;

/**
 * Names the collector case for a 415 answer to the beacon batch, because the bare status doesn't
 * say that only the exit batches are lost or how to fix it.
 */
const mediaTypeProblem: AnswerTest = (response) =>
  response.status === HTTP_UNSUPPORTED_MEDIA_TYPE
    ? `The server returned ${String(response.status)} to a text/plain batch, as a stock OpenTelemetry Collector does. The library loses the exit batches of a page on another origin. Set headers in the app, or put a same-origin proxy in front of the server.`
    : undefined;

/** Builds the result for one rule. The first problem found becomes the detail. */
function judge(rule: string, answer: Answer, passed: string, ...tests: AnswerTest[]): DoctorResult {
  const problem =
    typeof answer === "string"
      ? answer
      : tests.map((test) => test(answer)).find((found) => found !== undefined);

  return { rule, pass: problem === undefined, detail: problem ?? passed };
}

/** One endpoint under test: where it is, who calls it and with which headers. */
interface Target {
  /** Endpoint URL. */
  url: string;
  /** The app's origin. */
  origin: string;
  /** The app's headers for each POST, e.g. an Authorization header. */
  custom: Readonly<Record<string, string>>;
  /** Lowercase names of every header a POST carries. The preflight asks for them. */
  requestHeaders: string[];
  /** True with `--credentials include`. A browser then refuses a * in a CORS header. */
  credentials: boolean;
}

/** Sends one POST the way the library does. Extra headers go on top. */
type Post = (
  id: string,
  attempt: number,
  payload: BodyInit,
  extra?: Record<string, string>,
) => Promise<Answer>;

/** Builds the target for one run. */
function targetOf(
  url: string,
  origin: string,
  custom: Readonly<Record<string, string>>,
  credentials: boolean,
): Target {
  const customNames = Object.keys(custom).map((name) => name.toLowerCase());

  return {
    url,
    origin,
    custom,
    requestHeaders: [...REQUEST_HEADERS, ...customNames],
    credentials,
  };
}

/** Builds the test that an answer lets the app's origin read it. */
function originTest({ origin, credentials }: Target): AnswerTest {
  return (response) => {
    const allowed = response.headers.get(ALLOW_ORIGIN);

    if (allowed === "*" && credentials) {
      return `${ALLOW_ORIGIN} is *. ${STAR_REFUSED} It must be ${origin}.`;
    }

    if (allowed !== origin && allowed !== "*") {
      return `${ALLOW_ORIGIN} is ${String(allowed)}. It must allow ${origin}.`;
    }

    // A browser rejects a credentialed answer without this header. The library then sees a
    // network error and sends the batch again.
    return credentials ? allowsCredentials(response) : undefined;
  };
}

/** Checks that an answer lets the browser send and read credentials. */
const allowsCredentials: AnswerTest = (response) => {
  const allowed = response.headers.get(ALLOW_CREDENTIALS);

  return allowed === "true"
    ? undefined
    : `${ALLOW_CREDENTIALS} is ${String(allowed)}. It must be true with credentials: "include".`;
};

/** Returns the origin an answer allows, or null for a failed request or a missing header. */
function allowedOrigin(answer: Answer): string | null {
  return typeof answer === "string" ? null : answer.headers.get(ALLOW_ORIGIN);
}

/**
 * Returns the note for a PASS that only a * earned. With credentials the rule fails on that *,
 * so the note is for the run without them.
 */
function starNote(earnedByStar: boolean, { credentials }: Target, reason = STAR_REFUSED): string {
  return earnedByStar && !credentials ? ` ${reason} ${STAR_HINT}` : "";
}

/** Returns the reason that a * doesn't help a list of header names with credentials, or "". */
function starWhy(response: Response, name: string, { credentials }: Target): string {
  return credentials && valuesOf(response, name).includes("*") ? ` ${STAR_PLAIN}` : "";
}

/** True when a list of header names passes only because of its *: it has one and misses a name. */
function coveredByStar(answer: Answer, name: string, wanted: readonly string[]): boolean {
  return (
    typeof answer !== "string" &&
    valuesOf(answer, name).includes("*") &&
    absent(answer, name, wanted, false).length > 0
  );
}

/** Sends the preflight a browser sends before the library's POST. */
function sendPreflight({ url, origin, requestHeaders }: Target): Promise<Answer> {
  return request(url, {
    method: "OPTIONS",
    headers: {
      Origin: origin,
      "Access-Control-Request-Method": "POST",
      "Access-Control-Request-Headers": requestHeaders.join(", "),
    },
  });
}

/** Builds the two results every preflight gives. */
function preflightResults(preflight: Answer, target: Target): DoctorResult[] {
  const originNote = starNote(allowedOrigin(preflight) === "*", target);
  const headersByStar = coveredByStar(preflight, ALLOW_HEADERS, target.requestHeaders);
  const headersNote = starNote(headersByStar, target, STAR_PLAIN);

  return [
    judge(
      "preflight",
      preflight,
      `The server permits POST from this origin.${originNote}`,
      statusProblem,
      originTest(target),
    ),
    judge(
      "allowed headers",
      preflight,
      `The server allows each request header of the library.${headersNote}`,
      (response) => {
        const missing = absent(response, ALLOW_HEADERS, target.requestHeaders, !target.credentials);
        if (missing.length === 0) {
          return undefined;
        }

        const why = starWhy(response, ALLOW_HEADERS, target);
        const authorization =
          missing.includes(NON_WILDCARD_HEADER) && valuesOf(response, ALLOW_HEADERS).includes("*")
            ? ` ${STAR_AUTHORIZATION}`
            : "";

        return `${ALLOW_HEADERS} must include ${missing.join(", ")}.${why}${authorization}`;
      },
    ),
  ];
}

/** Builds the POST function for one target and content type. */
function poster({ url, origin, custom }: Target, contentType: string, timeoutMs?: number): Post {
  return (id, attempt, payload, extra = {}) =>
    request(
      url,
      {
        method: "POST",
        headers: {
          ...custom,
          Origin: origin,
          [HEADER_CONTENT_TYPE]: contentType,
          [HEADER_BATCH_ID]: id,
          [HEADER_ATTEMPT]: String(attempt),
          ...extra,
        },
        body: payload,
      },
      timeoutMs,
    );
}

/** Sends a body with gzip. Gives the text of the problem if this Node can't compress. */
async function postZipped(post: Post, id: string, body: string): Promise<Answer> {
  const compressed = await gzip(body);

  return compressed
    ? post(id, 0, compressed, { [HEADER_CONTENT_ENCODING]: ENCODING_GZIP })
    : "This Node version has no CompressionStream.";
}

/**
 * Runs each rule's requests one at a time. Two requests with the same batch id must not overlap.
 * @param url Ingest URL.
 * @param origin The app's origin.
 * @param custom The app's headers for each batch, e.g. an Authorization header.
 * @param credentials True when the app sets `credentials: "include"`. A * in a CORS header then
 * fails, and the preflight must allow credentials.
 * @returns One result per rule.
 */
export async function runDoctor(
  url: string,
  origin: string,
  custom: Readonly<Record<string, string>> = {},
  credentials = false,
): Promise<DoctorResult[]> {
  const target = targetOf(url, origin, custom, credentials);
  const originProblem = originTest(target);
  const preflight = await sendPreflight(target);

  const { body, contentType } = otlpSerializer.serialize([testRecord()]);
  const post = poster(target, contentType);

  const batchId = crypto.randomUUID();
  const first = await post(batchId, 0, body);
  const repeated = await post(batchId, 1, body);
  const zipped = await postZipped(post, crypto.randomUUID(), body);

  // sendBeacon can't set headers, so the id and the reason go in the query, like the exit flush.
  const beaconUrl = new URL(url);
  beaconUrl.searchParams.set(QUERY_PARAM_BATCH_ID, crypto.randomUUID());
  beaconUrl.searchParams.set(QUERY_PARAM_EXIT_REASON, "pagehide");

  // With custom headers the library's exit flush uses a keepalive fetch instead of a beacon.
  const beacon =
    target.requestHeaders.length > REQUEST_HEADERS.length
      ? undefined
      : await request(beaconUrl.toString(), {
          method: "POST",
          headers: { Origin: origin, [HEADER_CONTENT_TYPE]: CONTENT_TYPE_TEXT_PLAIN },
          body,
        });

  const hidden =
    typeof first === "string"
      ? []
      : absent(first, EXPOSE_HEADERS, OPTIONAL_EXPOSED, !target.credentials);
  const hiddenNote =
    hidden.length > 0 ? ` Optional headers stay hidden: ${hidden.join(", ")}.` : "";
  const exposedNote = starNote(
    coveredByStar(first, EXPOSE_HEADERS, WANTED_EXPOSED),
    target,
    STAR_PLAIN,
  );

  return [
    ...preflightResults(preflight, target),
    judge(
      "test batch",
      first,
      `The server accepted a test batch.${starNote(allowedOrigin(first) === "*", target)}`,
      statusProblem,
      originProblem,
    ),
    judge(
      "exposed headers",
      first,
      `The server exposes Retry-After.${hiddenNote}${exposedNote}`,
      (response) => {
        if (absent(response, EXPOSE_HEADERS, REQUIRED_EXPOSED, !target.credentials).length === 0) {
          return undefined;
        }

        const why = starWhy(response, EXPOSE_HEADERS, target);

        return `${EXPOSE_HEADERS} must include retry-after.${why}`;
      },
    ),
    judge("gzip", zipped, "The server accepted a gzip batch.", statusProblem),
    judge(
      "deduplication",
      repeated,
      "The server accepted a repeated batch id. A client cannot see if it stored the batch again.",
      statusProblem,
    ),
    beacon === undefined
      ? {
          rule: "beacon",
          pass: true,
          detail: "The library sends no beacon with custom headers. The tool sent no beacon.",
        }
      : judge(
          "beacon",
          beacon,
          "The server accepted a text/plain batch.",
          mediaTypeProblem,
          statusProblem,
        ),
  ];
}

/**
 * Checks a replay endpoint the way runDoctor() checks an ingest server. A segment has its own
 * body and its own batch id form, and its first one can be several megabytes.
 * @param url Replay endpoint URL, the value of replay.endpoint.
 * @param origin The app's origin.
 * @param custom The app's replay.headers, e.g. an Authorization header.
 * @param credentials True when the app sets `credentials: "include"`. See runDoctor().
 * @returns One result per rule.
 */
export async function runReplayDoctor(
  url: string,
  origin: string,
  custom: Readonly<Record<string, string>> = {},
  credentials = false,
): Promise<DoctorResult[]> {
  const target = targetOf(url, origin, custom, credentials);
  const originProblem = originTest(target);
  const preflight = await sendPreflight(target);

  const replayId = crypto.randomUUID();
  const head = {
    "replay.id": replayId,
    "session.id": crypto.randomUUID(),
    "tab.id": crypto.randomUUID(),
    "service.name": DOCTOR_NAME,
  };
  // The body the uploader sends: the ids, the sequence, the JSON length of the events, and the
  // events themselves.
  const segment = (sequence: number, text: string): string => {
    const events = [
      { type: CUSTOM_EVENT, timestamp: Date.now(), data: { tag: DOCTOR_NAME, payload: text } },
    ];

    return JSON.stringify({ ...head, sequence, bytes: JSON.stringify(events).length, events });
  };
  // The uploader's batch id is the replay id plus the sequence.
  const idOf = (sequence: number): string => `${replayId}-${String(sequence)}`;
  const post = poster(target, CONTENT_TYPE_JSON);
  const small = segment(0, "uiobs doctor test event");

  const first = await post(idOf(0), 0, small);
  const repeated = await post(idOf(0), 1, small);
  const zipped = await postZipped(post, idOf(1), segment(1, "uiobs doctor gzip event"));
  // No gzip here. That is the worst case: compression off, or a browser without
  // CompressionStream. The library gives a segment delivery.requestTimeoutMs, so the tool
  // waits for the default of that. A shorter wait would fail a slow link the library can use.
  const large = await poster(target, CONTENT_TYPE_JSON, LIBRARY_TIMEOUT_MS)(
    idOf(2),
    0,
    segment(2, "x".repeat(LARGE_EVENT_CHARS)),
  );

  return [
    ...preflightResults(preflight, target),
    judge(
      "test segment",
      first,
      `The server accepted a test segment.${starNote(allowedOrigin(first) === "*", target)}`,
      statusProblem,
      originProblem,
    ),
    judge("gzip", zipped, "The server accepted a gzip segment.", statusProblem),
    judge(
      "large segment",
      large,
      `The server accepted a segment of ${String(LARGE_EVENT_CHARS)} bytes without gzip.`,
      // The library drops a segment after a 413, so a low body limit loses every replay.
      (response) =>
        response.ok
          ? undefined
          : `The server returned ${String(response.status)} for a segment of ${String(LARGE_EVENT_CHARS)} bytes. The first segment of an upload has a full snapshot of the page. Raise the body limit of the server.`,
    ),
    judge(
      "deduplication",
      repeated,
      "The server accepted a repeated batch id. A client cannot see if it stored the segment again.",
      statusProblem,
    ),
  ];
}

/** The options after the origin and the replay flag. */
interface Options {
  /** The headers of the --header options. */
  headers: Record<string, string>;
  /** True with `--credentials include`. */
  credentials: boolean;
}

/**
 * Parses the options. Each one is a flag and its value: a "Name: value" argument for a header,
 * or `include` for the credentials.
 * @param args The arguments after the origin.
 * @returns The options, or undefined if an option is malformed.
 */
function parseOptions(args: readonly string[]): Options | undefined {
  const pairs: [string, string][] = [];
  let credentials = false;

  for (let index = 0; index < args.length; index += 2) {
    if (args[index] === CREDENTIALS_FLAG && args[index + 1] === CREDENTIALS_INCLUDE) {
      credentials = true;
      continue;
    }

    // A flag without a value leaves undefined here, which exec() treats as text with no colon.
    const match = args[index] === HEADER_FLAG ? HEADER_PATTERN.exec(args[index + 1]) : null;

    if (!match || RESERVED_HEADERS.includes(match[1].toLowerCase())) {
      return undefined;
    }

    pairs.push([match[1], match[2]]);
  }

  return { headers: Object.fromEntries(pairs), credentials };
}

/** True for an HTTP URL without a user name or password. Result lines print the URL. */
function isHttpUrl(value: string): boolean {
  if (!/^https?:\/\//i.test(value) || !URL.canParse(value)) {
    return false;
  }

  const { username, password } = new URL(value);
  return username === "" && password === "";
}

/** Command line words that are safe to print. */
const SHOWN_WORDS = [
  "doctor",
  "--origin",
  REPLAY_FLAG,
  HEADER_FLAG,
  CREDENTIALS_FLAG,
  CREDENTIALS_INCLUDE,
];

/**
 * Turns an argument into something safe to print in the usage message. An argument can be a
 * token, a URL can carry one in its query or user info, and the output may land in a shared log.
 * @param arg Command line argument.
 * @returns The word itself, a URL without query or user info, or a placeholder.
 */
function shownArgument(arg: string): string {
  if (SHOWN_WORDS.includes(arg)) {
    return arg;
  }

  if (/^https?:\/\//i.test(arg) && URL.canParse(arg)) {
    const { origin, pathname } = new URL(arg);
    return `${origin}${pathname === "/" && !arg.endsWith("/") ? "" : pathname}`;
  }

  return HIDDEN;
}

/** Checks for an exact browser origin. A path or a trailing slash doesn't match. */
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
  const [command, url, flag, origin, ...rest] = args;
  // The replay flag comes right after the origin, before any other option.
  const replay = rest[0] === REPLAY_FLAG;
  const options = parseOptions(replay ? rest.slice(1) : rest);

  if (
    command !== "doctor" ||
    flag !== "--origin" ||
    !isHttpUrl(url) ||
    !isOrigin(origin) ||
    !options
  ) {
    print(USAGE);
    print(`Received: ${JSON.stringify(args.map(shownArgument))}`);
    return EXIT_USAGE;
  }

  const { headers, credentials } = options;
  const results = await (replay ? runReplayDoctor : runDoctor)(url, origin, headers, credentials);

  for (const { rule, pass, detail } of results) {
    print(`${pass ? "PASS" : "FAIL"} ${rule}: ${detail}`);
  }

  return results.every(({ pass }) => pass) ? EXIT_PASS : EXIT_FAIL;
}
