// src/workspace/menu.tsx
//
// A button that opens a menu. It closes on a press outside, on Escape and when a menu item calls
// close(). The user menu and the "Add panel" menu use it.

import { type ReactElement, type ReactNode, useEffect, useRef, useState } from "react";

/**
 * Renders the button and, while it is open, the menu.
 * @param props The button text, an observability action name and the menu items.
 * @returns The button and the menu.
 */
export function MenuButton({
  label,
  action,
  menuLabel,
  children,
}: {
  label: ReactNode;
  /** The value of data-observability-action on the button. */
  action: string;
  menuLabel: string;
  /** Renders the items. Call close() when an item runs. */
  children: (close: () => void) => ReactNode;
}): ReactElement {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  // The cleanup removes both listeners, so StrictMode can mount, unmount and mount again.
  useEffect(() => {
    if (!open) {
      return;
    }

    const onPointerDown = (event: PointerEvent): void => {
      if (event.target instanceof Node && !root.current?.contains(event.target)) {
        setOpen(false);
      }
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === "Escape") {
        setOpen(false);
      }
    };
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);

    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [open]);

  return (
    <div className="menu-root" ref={root}>
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        data-observability-action={action}
        onClick={() => {
          setOpen((value) => !value);
        }}
      >
        {label}
      </button>
      {open && (
        <div role="menu" className="menu" aria-label={menuLabel}>
          {children(() => {
            setOpen(false);
          })}
        </div>
      )}
    </div>
  );
}
