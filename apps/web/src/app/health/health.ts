import { Component, inject } from "@angular/core";
import { HttpClient } from "@angular/common/http";
import { injectQuery } from "@tanstack/angular-query-experimental";
import { lastValueFrom } from "rxjs";

export interface HealthResponse {
  status: string;
}

@Component({
  selector: "app-health",
  template: `
    @if (health.isPending()) {
      <p data-testid="state">Lädt…</p>
    } @else if (health.isError()) {
      <p data-testid="state">Fehler: {{ health.error().message }}</p>
    } @else {
      <p data-testid="state">API-Status: {{ health.data()?.status }}</p>
    }
  `,
})
export class Health {
  private readonly http = inject(HttpClient);

  readonly health = injectQuery(() => ({
    queryKey: ["health"],
    queryFn: () => lastValueFrom(this.http.get<HealthResponse>("/api/health")),
  }));
}
