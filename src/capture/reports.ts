import { recordedUrl } from "../utils/platform";
import { allowInWindow, type StormWindow } from "./storm";
import type { Capture, CaptureContext } from "./types";

/** Report fields that this capture reads. Message text and samples stay out. */
interface BrowserReport {
  type: string;
  url: string;
  body: {
    id?: string;
    sourceFile?: string;
    lineNumber?: number;
    columnNumber?: number;
    effectiveDirective?: string;
    blockedURL?: string;
  };
}

/** Records browser reports without message text, code samples or URL queries. */
export class ReportCapture implements Capture {
  readonly name = "reports";

  private installed = false;

  private observer: ReportingObserver | undefined;

  private readonly window: StormWindow = { start: 0, count: 0 };

  constructor(private readonly ctx: CaptureContext) {}

  /** Installs report and CSP listeners. CSP reports do not need ReportingObserver. */
  install(): void {
    if (this.installed) {
      return;
    }
    this.installed = true;
    document.addEventListener("securitypolicyviolation", this.onCsp);

    const Observer = typeof ReportingObserver === "undefined" ? undefined : ReportingObserver;

    if (!Observer) {
      this.ctx.diagnostics.report(
        "capture.install_failed",
        "The browser does not support ReportingObserver. Only CSP events are captured.",
      );
      return;
    }

    this.observer = new Observer(
      (reports) => {
        for (const report of reports) {
          this.record(report as unknown as BrowserReport);
        }
      },
      { types: ["deprecation", "intervention"], buffered: false },
    );
    this.observer.observe();
  }

  /** Disconnects the observer and removes the CSP listener. */
  uninstall(): void {
    this.installed = false;
    this.observer?.disconnect();
    this.observer = undefined;
    document.removeEventListener("securitypolicyviolation", this.onCsp);
  }

  private readonly onCsp = (event: SecurityPolicyViolationEvent): void => {
    this.ctx.diagnostics.guard(
      "capture.record_failed",
      "The library could not read a CSP event.",
      () => {
        this.record({
          type: "csp-violation",
          url: event.documentURI,
          body: {
            sourceFile: event.sourceFile,
            lineNumber: event.lineNumber,
            columnNumber: event.columnNumber,
            effectiveDirective: event.effectiveDirective,
            blockedURL: event.blockedURI,
          },
        });
      },
    );
  };

  /** Reads only fixed report fields. The diagnostics guard contains a failed field read. */
  private record(report: BrowserReport): void {
    if (!this.installed || this.ctx.isActive?.() === false) {
      return;
    }

    const { capturePolicy, limits } = this.ctx.config;
    if (
      !allowInWindow(
        this.window,
        capturePolicy.reportsPerWindow,
        this.ctx.diagnostics,
        "browser reports",
        capturePolicy.windowMs,
      )
    ) {
      return;
    }

    this.ctx.diagnostics.guard(
      "capture.record_failed",
      "The library could not record a browser report.",
      () => {
        if (!["deprecation", "intervention", "csp-violation"].includes(report.type)) {
          return;
        }

        const body = report.body;
        const url = (value: string): string =>
          recordedUrl(value, false, undefined, this.ctx.diagnostics);
        this.ctx.logger.warn("ui.report", {
          "report.type": report.type,
          "report.url": url(report.url),
          ...(body.id ? { "report.id": body.id.slice(0, limits.maxAttributeChars) } : {}),
          ...(body.sourceFile ? { "report.source": url(body.sourceFile) } : {}),
          ...(body.lineNumber !== undefined ? { "report.line": body.lineNumber } : {}),
          ...(body.columnNumber !== undefined ? { "report.column": body.columnNumber } : {}),
          ...(body.effectiveDirective ? { "report.directive": body.effectiveDirective } : {}),
          ...(body.blockedURL ? { "report.blocked_url": url(body.blockedURL) } : {}),
        });
      },
    );
  }
}
