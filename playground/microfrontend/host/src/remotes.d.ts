// The federated modules the host imports. `blotter/mount` and `ticket/mount`
// are resolved by the federation plugin at runtime, so TypeScript needs the
// shape declared here or every dynamic import lands as `any`.

declare module "blotter/mount" {
  /**
   * Renders the blotter remote into an element the host owns.
   * @param el Panel element.
   */
  export function mount(el: HTMLElement): void;
}

declare module "ticket/mount" {
  /**
   * Renders the ticket remote into an element the host owns.
   * @param el Panel element.
   */
  export function mount(el: HTMLElement): void;
}
