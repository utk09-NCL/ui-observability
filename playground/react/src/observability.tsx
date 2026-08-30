// playground/react/src/observability.tsx
//
// COPY THIS FILE into your application and own it. It imports nothing but the
// public API, so nothing here depends on a library internal and nothing here
// breaks when the library's internals change.

import * as React from "react";
import { endJourney, getLogger, type OneLogger, startJourney } from "ui-observability";

const LoggerContext = React.createContext<OneLogger | null>(null);

/**
 * Provides one namespaced logger to the tree below it.
 * @param props Namespace for the logger and the children that read it.
 * @returns Provider element.
 */
export function LoggerProvider({
  namespace,
  children,
}: {
  namespace: string;
  children: React.ReactNode;
}): React.ReactElement {
  const logger = React.useMemo(() => getLogger(namespace), [namespace]);

  return <LoggerContext.Provider value={logger}>{children}</LoggerContext.Provider>;
}

/**
 * Reads the nearest provider's logger, or builds one for the namespace given.
 * A component outside any provider still gets a logger, on namespace "react".
 * @param namespace Overrides the provider's namespace.
 * @returns Logger for this component.
 */
export function useLogger(namespace?: string): OneLogger {
  const fromContext = React.useContext(LoggerContext);

  return React.useMemo(
    () => (namespace ? getLogger(namespace) : (fromContext ?? getLogger("react"))),
    [namespace, fromContext],
  );
}

/** Options for {@link useJourney}. */
export interface UseJourneyOptions {
  /** Skip entirely, for a component mounted before the work begins. Default true. */
  active?: boolean;
  /**
   * End the journey when the component unmounts. Default FALSE, and think
   * before turning it on.
   *
   * A journey is a business workflow, not a component lifetime. If an order
   * ticket autocloses fifteen seconds after submit while the workflow it
   * belongs to is still running elsewhere, ending on unmount cuts the journey
   * in half. The end also crosses windows, because it is announced on the
   * control plane, so one component unmounting ends the journey in three other
   * windows too. Under StrictMode in development, effects run twice: start,
   * end, start, and that middle end is broadcast to everybody.
   */
  endOnUnmount?: boolean;
}

/**
 * Starts a journey while the component is mounted.
 * @param name Workflow name.
 * @param options Journey lifetime options.
 */
export function useJourney(name: string, options: UseJourneyOptions = {}): void {
  const { active = true, endOnUnmount = false } = options;

  React.useEffect(() => {
    if (!active) {
      return;
    }

    startJourney(name);

    if (!endOnUnmount) {
      return;
    }

    return () => {
      endJourney();
    };
  }, [name, active, endOnUnmount]);
}

/** Props for {@link ObservabilityErrorBoundary}. */
interface BoundaryProps {
  /** Subtree to guard. */
  children: React.ReactNode;
  /** Rendered in place of the subtree once a render has failed. */
  fallback?: React.ReactNode;
  /** Namespace for the error record. Defaults to "react". */
  namespace?: string;
}

/** Reports render errors that would otherwise only reach React's console output. */
export class ObservabilityErrorBoundary extends React.Component<
  BoundaryProps,
  { failed: boolean }
> {
  state = { failed: false };

  /**
   * Marks the boundary failed so the fallback renders.
   * @returns Next state.
   */
  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  /**
   * Logs the render failure and the component stack React collected.
   * @param error Thrown during render.
   * @param info Component stack for the failed subtree.
   */
  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    getLogger(this.props.namespace ?? "react").error("render failed", error, {
      "react.component_stack": info.componentStack,
    });
  }

  /**
   * Renders the fallback once a render below has failed.
   * @returns The subtree, or the fallback.
   */
  render(): React.ReactNode {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
  }
}
