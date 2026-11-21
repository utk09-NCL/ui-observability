import { describe, expect, it } from "vitest";
import {
  buildPanelUrl,
  comesFrom,
  isReadyMessage,
  isSessionMessage,
  parsePanelRequest,
  READY_TYPE,
  SESSION_TYPE,
  WINDOW_PANELS,
} from "./protocol";

const BASE = "http://localhost:5180/panel.html";

describe("panel address", () => {
  it("round-trips the panel and the journey token", () => {
    const url = new URL(buildPanelUrl(BASE, "blotter", "a b+c/d=="));

    expect(url.origin + url.pathname).toBe(BASE);
    expect(parsePanelRequest(url.search, url.hash)).toEqual({
      panel: "blotter",
      journeyToken: "a b+c/d==",
    });
  });

  it("puts the journey token in the fragment, which the browser never sends to a server", () => {
    const url = new URL(buildPanelUrl(BASE, "blotter", "token-1"));

    expect(url.search).toBe("?panel=blotter");
    expect(url.hash).toBe("#journey=token-1");
  });

  it("does not read a journey token from the query, where a server would see it", () => {
    expect(parsePanelRequest("?panel=prices&journey=token-1", "")).toEqual({
      panel: "prices",
      journeyToken: null,
    });
  });

  it("leaves the journey out when the opener has none", () => {
    const url = new URL(buildPanelUrl(BASE, "prices", null));

    expect(url.hash).toBe("");
    expect(parsePanelRequest(url.search, url.hash)).toEqual({
      panel: "prices",
      journeyToken: null,
    });
  });

  it("reads an empty journey as no journey", () => {
    expect(parsePanelRequest("?panel=prices", "#journey=")).toEqual({
      panel: "prices",
      journeyToken: null,
    });
  });

  it.each([
    ["no panel", ""],
    ["an unknown panel", "?panel=admin"],
    ["the settings panel", "?panel=settings"],
    ["a panel with a path in it", "?panel=../prices"],
  ])("refuses %s", (_name, search) => {
    expect(parsePanelRequest(search, "")).toBeNull();
  });

  it("offers each panel except the settings panel", () => {
    expect(WINDOW_PANELS).toContain("support");
    expect(WINDOW_PANELS).not.toContain("settings");
  });
});

describe("messages", () => {
  it("accepts the question and the answer", () => {
    expect(isReadyMessage({ type: READY_TYPE })).toBe(true);
    expect(isSessionMessage({ type: SESSION_TYPE, user: "trader1", tenant: "tenant-a" })).toBe(
      true,
    );
  });

  it.each([
    [null],
    ["text"],
    [{ type: "other" }],
    [{ type: SESSION_TYPE, user: "", tenant: "tenant-a" }],
    [{ type: SESSION_TYPE, user: "trader1", tenant: 3 }],
    [{ type: SESSION_TYPE, user: "trader1" }],
  ])("refuses %j as a session", (data) => {
    expect(isSessionMessage(data)).toBe(false);
  });

  it("refuses data that is not a question", () => {
    expect(isReadyMessage({ type: SESSION_TYPE })).toBe(false);
    expect(isReadyMessage(undefined)).toBe(false);
  });
});

describe("comesFrom", () => {
  const source = {};

  it("passes the expected window from the expected origin", () => {
    expect(
      comesFrom({ origin: "http://localhost:5180", source }, "http://localhost:5180", source),
    ).toBe(true);
  });

  it("refuses another origin, another window and a missing source", () => {
    expect(
      comesFrom({ origin: "http://evil.example", source }, "http://localhost:5180", source),
    ).toBe(false);
    expect(
      comesFrom({ origin: "http://localhost:5180", source: {} }, "http://localhost:5180", source),
    ).toBe(false);
    expect(
      comesFrom({ origin: "http://localhost:5180", source: null }, "http://localhost:5180", null),
    ).toBe(false);
  });
});
