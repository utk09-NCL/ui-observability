import { Component, inject } from "@angular/core";
import { endJourney, startJourney } from "ui-observability";
import { ObservabilityService } from "./observability";

/** One order ticket: a submit that is logged, and a throw only Angular sees. */
@Component({
  selector: "app-ticket",
  template: `
    <h2>ticket</h2>
    <button (click)="submit()">submit</button>
    <button class="danger" (click)="fail()">throw inside Angular</button>
  `,
})
export class TicketComponent {
  private readonly log = inject(ObservabilityService).forNamespace("oms.ticket");

  /** Logs one action inside a journey that opens and closes with the submit. */
  submit(): void {
    startJourney("order-lifecycle");
    this.log.logAction("ORDER_SUBMIT", { orderId: "ORD-2002", qty: 250 });
    endJourney();
  }

  /** Throws from a template listener, which Angular routes to its ErrorHandler. */
  fail(): void {
    throw new Error("thrown from a component method");
  }
}
