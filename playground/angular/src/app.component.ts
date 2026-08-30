import { Component } from "@angular/core";
import { RouterLink, RouterOutlet } from "@angular/router";

/** Shell holding the route links and the outlet. */
@Component({
  selector: "app-root",
  imports: [RouterLink, RouterOutlet],
  template: `
    <h1>ui-observability, Angular example</h1>
    <nav>
      <a routerLink="/">ticket</a>
      <a routerLink="/blotter">blotter</a>
    </nav>
    <router-outlet />
  `,
})
export class AppComponent {}
