import { afterEach, describe, expect, it, vi } from "vitest";
import { createApi } from "./client";

afterEach(() => {
  vi.unstubAllGlobals();
});

function stubFetch(): ReturnType<typeof vi.fn> {
  const fetchMock = vi.fn(() => Promise.resolve(new Response(null, { status: 204 })));
  vi.stubGlobal("fetch", fetchMock);

  return fetchMock;
}

describe("logoutOnExit", () => {
  it("sends the logout with keepalive and the bearer header, so it survives the page", () => {
    const fetchMock = stubFetch();

    createApi(() => "token-1").logoutOnExit();

    expect(fetchMock).toHaveBeenCalledWith(
      "/api/logout",
      expect.objectContaining({
        method: "POST",
        keepalive: true,
        headers: { Authorization: "Bearer token-1" },
      }),
    );
  });

  it("sends nothing when no token is set", () => {
    const fetchMock = stubFetch();

    createApi(() => undefined).logoutOnExit();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("does not throw into the page when fetch rejects", async () => {
    vi.stubGlobal("fetch", () => Promise.reject(new TypeError("Failed to fetch")));

    expect(() => {
      createApi(() => "token-1").logoutOnExit();
    }).not.toThrow();
    await Promise.resolve();
  });
});

describe("listOrders", () => {
  it("asks again for each call, so an old slow answer can't fill a later session", async () => {
    const answers = [
      Promise.resolve(new Response("[]", { status: 200 })),
      Promise.resolve(new Response("[]", { status: 200 })),
    ];
    const fetchMock = vi.fn(() => answers.shift() ?? Promise.reject(new Error("no answer")));
    vi.stubGlobal("fetch", fetchMock);
    const api = createApi(() => "token-1");

    const first = api.listOrders();
    const second = api.listOrders();
    await Promise.all([first, second]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
