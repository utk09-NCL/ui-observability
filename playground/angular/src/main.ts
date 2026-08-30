import { bootstrapApplication } from "@angular/platform-browser";
import { provideRouter } from "@angular/router";
import { AppComponent } from "./app.component";
import { provideObservability } from "./observability";
import { routes } from "./routes";

// provideBrowserGlobalErrorListeners(), which `ng new` puts here, forwards
// window "error" and "unhandledrejection" into the same ErrorHandler. Add it and
// one uncaught error arrives twice: once on uiobs.capture from capture.errors,
// once on angular.errors from the handler.
void bootstrapApplication(AppComponent, {
  providers: [
    provideRouter(routes),
    provideObservability({
      endpoint: "http://localhost:8787/v1/logs",
      serviceName: "example-angular",
      serviceVersion: "0.0.0",
      environment: "local",
      minLevel: "TRACE",
      console: { enabled: true },
      capture: { errors: true, rejections: true, fetch: true, xhr: true, navigation: true },
    }),
  ],
});
