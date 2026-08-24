import { Component, inject } from "@angular/core";
import { Router, RouterLink } from "@angular/router";

@Component({
  selector: "app-not-ported",
  imports: [RouterLink],
  template: `
    <main class="flex min-h-full items-center justify-center px-4 py-16">
      <div class="w-full max-w-md rounded-xl border border-hairline bg-surface p-8 text-center">
        <p class="text-xs font-medium uppercase tracking-wide text-ink-subtle">
          Noch nicht portiert
        </p>
        <h1 class="mt-2 text-lg font-semibold tracking-tight text-ink">
          {{ path }}
        </h1>
        <p class="mt-3 text-sm text-ink-muted">
          Diese Seite gibt es bisher nur in der React-Oberfläche. Die Angular-Portierung
          ist noch nicht so weit.
        </p>
        <a
          routerLink="/"
          class="mt-6 inline-block rounded-lg bg-ink px-4 py-2 text-sm font-medium text-on-inverse hover:opacity-80"
        >
          Zurück zur Startseite
        </a>
      </div>
    </main>
  `,
})
export class NotPorted {
  private readonly router = inject(Router);
  protected readonly path = this.router.url;
}
