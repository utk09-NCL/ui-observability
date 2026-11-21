// src/observability/react.tsx
//
// COPY THIS FILE into your app. It imports only the public API. It has the error boundary. React
// catches a render error in the nearest boundary, so window.onerror never sees it, and only this
// boundary can report it.

import * as React from "react";
import { getLogger } from "@utk09/ui-observability";

interface BoundaryProps {
  children: React.ReactNode;
  fallback?: React.ReactNode;
  namespace?: string;
}

/** Reports a render error and shows the fallback in place of the subtree. */
export class ObservabilityErrorBoundary extends React.Component<
  BoundaryProps,
  { failed: boolean }
> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: React.ErrorInfo): void {
    getLogger(this.props.namespace ?? "react").error("render failed", error, {
      "react.component_stack": info.componentStack,
    });
  }

  render(): React.ReactNode {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
  }
}
