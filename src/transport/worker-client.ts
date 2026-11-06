import { TRANSPORT_WORKER_TYPE } from "../constants";
import type { Diagnostics } from "../core/diagnostics";
import { unrefTimer } from "../utils/unref";
import {
  isWorkerMessage,
  isWorkerResult,
  workerMessage,
  type WorkerJob,
  type WorkerResult,
} from "./worker-protocol";

/** A channel failure permits HTTP fallback. A timeout keeps the retry policy. */
export class WorkerFault extends Error {
  constructor(readonly kind: "channel" | "timeout" | "cancelled") {
    super("The transport worker did not complete the request.");
  }
}

/** One pending request of the private channel. */
interface Pending {
  job: WorkerJob;
  resolve: (result: WorkerResult) => void;
  reject: (error: WorkerFault) => void;
}

/** One connection to one worker. */
interface Session {
  worker: Worker;
  port: MessagePort;
  ready: boolean;
  pending: Map<number, Pending>;
  detach: () => void;
}

/** Private channel operations of the HTTP worker adapter. */
export interface WorkerClient {
  send(job: WorkerJob, signal: AbortSignal, timeoutMs: number): Promise<WorkerResult>;
  close(): void;
}

/** Opens a private message port. The worker factory stays on the main thread. */
export function createWorkerClient(factory: () => Worker, diagnostics: Diagnostics): WorkerClient {
  let session: Session | undefined;
  let closed = false;
  let sequence = 0;

  const inactive = (signal: AbortSignal): boolean => closed || signal.aborted;

  const fail = (): void => {
    const old = session;
    session = undefined;
    if (!old) {
      return;
    }
    diagnostics.guard("transport.http_error", "The transport worker could not be closed.", () => {
      old.detach();
    });
    diagnostics.guard("transport.http_error", "The transport port could not be closed.", () => {
      old.port.close();
    });
    diagnostics.guard(
      "transport.http_error",
      "The transport worker could not be terminated.",
      () => {
        old.worker.terminate();
      },
    );
    for (const pending of old.pending.values()) {
      pending.reject(new WorkerFault("channel"));
    }
    old.pending.clear();
  };

  const post = (current: Session, id: number, job: WorkerJob): void => {
    try {
      current.port.postMessage(workerMessage(TRANSPORT_WORKER_TYPE.send, { id, job }));
    } catch (error) {
      diagnostics.report(
        "transport.http_error",
        "The transport worker could not clone its batch.",
        undefined,
        error,
      );
      fail();
    }
  };

  const connect = (): Session => {
    if (session) {
      return session;
    }
    let worker: Worker | undefined;
    try {
      worker = factory();
      const channel = new MessageChannel();
      const current: Session = {
        worker,
        port: channel.port1,
        ready: false,
        pending: new Map(),
        detach: () => undefined,
      };
      session = current;
      const onMessage = (event: MessageEvent<unknown>): void => {
        const message = event.data;
        if (!isWorkerMessage(message)) {
          fail();
          return;
        }
        if (message.t === TRANSPORT_WORKER_TYPE.ready) {
          if (message.ok !== true) {
            fail();
            return;
          }
          if (!current.ready) {
            current.ready = true;
            for (const [id, pending] of current.pending) {
              post(current, id, pending.job);
            }
          }
          return;
        }
        if (
          message.t !== TRANSPORT_WORKER_TYPE.result ||
          typeof message.id !== "number" ||
          !isWorkerResult(message.result)
        ) {
          fail();
          return;
        }

        current.pending.get(message.id)?.resolve(message.result);
      };
      const onError = (): void => {
        fail();
      };
      current.port.addEventListener("message", onMessage);
      current.port.addEventListener("messageerror", onError);
      worker.addEventListener("error", onError);
      worker.addEventListener("messageerror", onError);
      current.detach = () => {
        current.port.removeEventListener("message", onMessage);
        current.port.removeEventListener("messageerror", onError);
        current.worker.removeEventListener("error", onError);
        current.worker.removeEventListener("messageerror", onError);
      };
      current.port.start();
      worker.postMessage(workerMessage(TRANSPORT_WORKER_TYPE.connect), [channel.port2]);
      return current;
    } catch (error) {
      diagnostics.report(
        "transport.http_error",
        "The transport worker could not start.",
        undefined,
        error,
      );
      fail();
      diagnostics.guard("transport.http_error", "The transport worker could not stop.", () =>
        worker?.terminate(),
      );
      throw new WorkerFault("channel");
    }
  };

  return {
    send: async (job, signal, timeoutMs) => {
      if (inactive(signal)) {
        throw new WorkerFault("cancelled");
      }
      const current = connect();
      if (inactive(signal)) {
        fail();
        throw new WorkerFault("cancelled");
      }
      const id = ++sequence;
      let finish!: () => void;
      try {
        return await new Promise<WorkerResult>((resolve, reject) => {
          const cancel = (kind: "timeout" | "cancelled"): void => {
            current.pending.delete(id);
            diagnostics.guard(
              "transport.http_error",
              "The transport worker request could not be cancelled.",
              () => {
                current.port.postMessage(workerMessage(TRANSPORT_WORKER_TYPE.cancel, { id }));
              },
            );
            reject(new WorkerFault(kind));
          };
          const abort = (): void => {
            cancel("cancelled");
          };
          const timer = setTimeout(() => {
            // A worker with no ready answer has not started. HTTP cannot duplicate its unsent job.
            if (current.ready) {
              cancel("timeout");
            } else {
              fail();
            }
          }, timeoutMs);
          unrefTimer(timer);
          finish = () => {
            clearTimeout(timer);
            signal.removeEventListener("abort", abort);
            current.pending.delete(id);
          };
          current.pending.set(id, { job, resolve, reject });
          signal.addEventListener("abort", abort, { once: true });
          if (current.ready) {
            post(current, id, job);
          }
        });
      } finally {
        finish();
      }
    },
    close: () => {
      closed = true;
      fail();
    },
  };
}
