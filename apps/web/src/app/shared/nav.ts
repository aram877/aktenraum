import { Component, computed, inject, signal } from "@angular/core";
import { Router, RouterLink, RouterLinkActive } from "@angular/router";

import { injectInFlightCount } from "../core/documents";
import { injectLogout, injectMe } from "../core/auth";
import { injectTrashList } from "../core/trash";

@Component({
  selector: "app-nav",
  imports: [RouterLink, RouterLinkActive],
  templateUrl: "./nav.html",
})
export class Nav {
  private readonly router = inject(Router);
  private readonly me = injectMe();
  // The nav is authenticated chrome: it must not render on /login, and its
  // two badge queries must not fire while logged out or every visit to the
  // login page emits a pair of 401s.
  protected readonly authenticated = computed(() => this.me.data() !== undefined);
  protected readonly inFlight = injectInFlightCount(() => this.authenticated());
  protected readonly trash = injectTrashList(() => this.authenticated());
  protected readonly logout = injectLogout();

  protected readonly inFlightCount = computed(() => this.inFlight.data()?.count ?? 0);
  protected readonly trashCount = computed(() => this.trash.data()?.total ?? 0);

  protected readonly menuOpen = signal(false);

  protected readonly links = [
    { to: "/", label: "Start", exact: true },
    { to: "/ask", label: "Ask AI", exact: false },
    { to: "/library", label: "Bibliothek", exact: false },
    { to: "/upload", label: "Hochladen", exact: false },
    { to: "/trash", label: "Papierkorb", exact: false },
    { to: "/settings", label: "Einstellungen", exact: false },
  ];

  protected toggleMenu(): void {
    this.menuOpen.set(!this.menuOpen());
  }

  protected closeMenu(): void {
    this.menuOpen.set(false);
  }

  protected async onLogout(): Promise<void> {
    this.closeMenu();
    await this.logout.mutateAsync().catch(() => undefined);
    void this.router.navigate(["/login"]);
  }
}
