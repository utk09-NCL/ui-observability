// src/panels/frame-panel.tsx
//
// A panel that holds an iframe. It does the part that must be right for the bus: the frame is in
// the document with no src, the workspace registers it, and only then the frame gets its src. A
// frame that loads before its registration finds no owner and sends its own records.

import { type ReactElement, type ReactNode, useEffect, useRef } from "react";
import { type BusPermission, flush, registerFrame } from "@utk09/ui-observability";
import { useRuntimeGeneration } from "../observability/runtime-generation";

export interface FrameRegistration {
  /** The exact origin of the page in the frame. */
  origin: string;
  /** What the frame may ask of the workspace. The default is records only. */
  permissions: BusPermission[];
}

/**
 * Renders the toolbar, the extra content and the frame.
 * @param props The title, the address, the registration and the sandbox of the frame.
 * @returns The panel.
 */
export function FramePanel({
  title,
  src,
  registration,
  sandbox,
  children,
}: {
  title: string;
  src: string;
  /** Leave it out for a frame that the app does not register. */
  registration?: FrameRegistration;
  sandbox?: string;
  children?: ReactNode;
}): ReactElement {
  const frame = useRef<HTMLIFrameElement>(null);
  const generation = useRuntimeGeneration();

  // The cleanup removes the registration and stops the pending load, so StrictMode can mount,
  // unmount and mount again. The first run never sets the src, because its cleanup comes first.
  // A restart of the library removes the registrations with the old runtime. A new generation
  // registers the frame again and loads it again, so its runtime finds the new owner.
  useEffect(() => {
    const element = frame.current;
    if (!element) {
      return;
    }

    let active = true;
    const unregister = registration ? registerFrame(element, registration) : undefined;
    // The registration starts with the runtime. flush() waits for that start, and a frame that
    // loads earlier finds no owner.
    void flush().then(() => {
      if (active) {
        element.src = src;
      }
    });

    return () => {
      active = false;
      unregister?.();
    };
  }, [registration, src, generation]);

  const reload = (): void => {
    // The same src again makes the browser load the page again. The registration stays, because
    // it binds the window of the frame and not one document.
    if (frame.current) {
      frame.current.src = src;
    }
  };

  return (
    <section className="panel frame-panel" aria-label={title}>
      <div className="controls">
        <button
          type="button"
          data-observability-action={`reload-${title.toLowerCase().replaceAll(" ", "-")}`}
          onClick={reload}
        >
          Reload frame
        </button>
        <span className="muted">
          <code>{src}</code>
        </span>
      </div>
      {children}
      <iframe ref={frame} title={title} sandbox={sandbox} className="frame-view" />
    </section>
  );
}
