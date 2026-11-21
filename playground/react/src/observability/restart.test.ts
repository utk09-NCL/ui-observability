import { describe, expect, it } from "vitest";
import { configure, counter, flush, getHealth, getLogger, shutdown } from "@utk09/ui-observability";
import { memory } from "../../test/observability";

describe("restart with shutdown() and configure()", () => {
  it("keeps a logger and a metric handle that the app made before it", async () => {
    const log = getLogger("restart.spec");
    const handle = counter("restart.count");
    log.info("before the restart");

    await shutdown();
    configure({
      serviceName: "react-workspace",
      transport: memory.transport,
      storage: { backend: "none" },
      bus: { mode: "off" },
      identity: "memory",
    });
    log.info("after the restart");
    handle.add(2);
    await flush();

    const records = memory.records();
    const point = records.find((record) => record.attributes["metric.name"] === "restart.count");

    expect(records.map((record) => record.body)).toContain("after the restart");
    expect(point?.attributes["metric.value"]).toBe(2);
  });

  it("reads the security context id after shutdown(), so a restart can keep it", async () => {
    // Isolation refuses a new id on a running library, so this spec starts a new runtime with it.
    await shutdown();
    configure({
      serviceName: "react-workspace",
      transport: memory.transport,
      storage: { backend: "none" },
      bus: { mode: "off" },
      identity: "memory",
      securityContext: { id: "ctx-restart-spec" },
    });
    await shutdown();

    expect((await getHealth()).securityContext.id).toBe("ctx-restart-spec");
  });
});
