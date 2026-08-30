import { Component, inject } from "@angular/core";
import { ObservabilityService } from "./observability";

/** The second route, reached by a navigation the Router drives. */
@Component({
  selector: "app-blotter",
  template: `
    <h2>blotter</h2>
    <button (click)="select('ORD-2002')">select ORD-2002</button>
  `,
})
export class BlotterComponent {
  private readonly log = inject(ObservabilityService).forNamespace("oms.blotter");

  /**
   * Logs a row selection.
   * @param orderId Row the user picked.
   */
  select(orderId: string): void {
    this.log.logEvent("ORDER_SELECTED", { orderId });
  }
}
