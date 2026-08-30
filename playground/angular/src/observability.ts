// playground/angular/src/observability.ts
//
// COPY THIS FILE into your application and own it. It imports nothing but the
// public API, so nothing here depends on a library internal and nothing here
// breaks when the library's internals change.

import {
  ErrorHandler,
  Injectable,
  InjectionToken,
  inject,
  provideEnvironmentInitializer,
  type EnvironmentProviders,
  type Provider,
} from "@angular/core";
import { NavigationStart, Router } from "@angular/router";
import { filter } from "rxjs";
import {
  configure,
  getLogger,
  startTrace,
  type ObservabilityConfig,
  type OneLogger,
} from "ui-observability";

/** Carries the config from `provideObservability` to the initializer that reads it. */
export const UI_OBSERVABILITY_CONFIG = new InjectionToken<Partial<ObservabilityConfig>>(
  "UI_OBSERVABILITY_CONFIG",
);

/** Hands loggers to components through the injector rather than a module import. */
@Injectable({ providedIn: "root" })
export class ObservabilityService {
  private readonly root = getLogger("angular");

  /**
   * Builds a logger for one component's namespace.
   * @param namespace Namespace the records carry, such as "oms.ticket".
   * @returns Logger on that namespace.
   */
  forNamespace(namespace: string): OneLogger {
    return getLogger(namespace);
  }

  /**
   * Logger for code with no namespace of its own.
   * @returns Logger on namespace "angular".
   */
  get log(): OneLogger {
    return this.root;
  }
}

/**
 * Reports the errors Angular catches. Angular routes a throw from a component
 * method or a template listener here and does not rethrow it, so `window.onerror`
 * never fires and `capture.errors` reports nothing. Drop this provider and an
 * Angular application reports no errors at all.
 */
@Injectable()
export class ObservabilityErrorHandler implements ErrorHandler {
  /**
   * Records the error, then prints it so devtools still renders the stack.
   * @param error Whatever Angular caught.
   */
  handleError(error: unknown): void {
    // Angular builds the ErrorHandler before any environment initializer runs.
    // Held as a field, this logger would configure an implicit runtime with no
    // endpoint before configure() ever ran. getLogger caches by namespace.
    getLogger("angular.errors").error("unhandled Angular error", error);
    console.error(error);
  }
}

/**
 * Configures the library from inside the injection context, before the first
 * component renders.
 * @param config Endpoint, service identity and capture switches.
 * @returns Providers for `bootstrapApplication`.
 */
export function provideObservability(
  config: Partial<ObservabilityConfig>,
): (Provider | EnvironmentProviders)[] {
  return [
    { provide: UI_OBSERVABILITY_CONFIG, useValue: config },
    { provide: ErrorHandler, useClass: ObservabilityErrorHandler },
    // Angular 19 and later. On 16 to 18 the same thing is spelled:
    //   { provide: ENVIRONMENT_INITIALIZER, multi: true,
    //     useValue: () => configure(inject(UI_OBSERVABILITY_CONFIG)) }
    provideEnvironmentInitializer(() => {
      configure(inject(UI_OBSERVABILITY_CONFIG));

      // capture.navigation already logs the route change: the Router drives the
      // History API and the capture module patches it. Rotating here gives each
      // navigation its own trace_id. Without it every record for the life of the
      // tab shares one trace.
      inject(Router)
        .events.pipe(filter((e): e is NavigationStart => e instanceof NavigationStart))
        .subscribe(() => {
          startTrace();
        });
    }),
  ];
}
