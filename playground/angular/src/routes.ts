import type { Routes } from "@angular/router";
import { BlotterComponent } from "./blotter.component";
import { TicketComponent } from "./ticket.component";

/** Two routes, so a navigation can be watched rotating the trace. */
export const routes: Routes = [
  { path: "", component: TicketComponent },
  { path: "blotter", component: BlotterComponent },
];
