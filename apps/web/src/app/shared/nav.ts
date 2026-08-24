import { Component, computed, effect, inject, signal } from "@angular/core";
import { Router, RouterLink, RouterLinkActive } from "@angular/router";

import { injectInFlightCount } from "../core/documents";
import { injectInboxList } from "../core/inbox";
import { injectLiveCounts, LiveCountsSubscription } from "../core/live";
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
  protected readonly inbox = injectInboxList({ pageSize: 1 }, () => this.authenticated());
  protected readonly logout = injectLogout();

  // /api/events/counts pushes all three badges. The polled queries above stay
  // as the fallback for when SSE cannot connect, so a badge is never blank
  // just because the stream is down.
  private readonly live = injectLiveCounts();
  private readonly liveSubscription = inject(LiveCountsSubscription);

  protected readonly inboxCount = computed(
    () => this.live.data()?.inbox ?? this.inbox.data()?.total ?? 0,
  );
  protected readonly trashCount = computed(
    () => this.live.data()?.trash ?? this.trash.data()?.total ?? 0,
  );
  // "In Bearbeitung" means the worker is busy with it. Documents already
  // waiting in review carry their own badge, so subtract them rather than
  // counting the same document twice.
  protected readonly inFlightCount = computed(() =>
    Math.max(0, (this.live.data()?.in_flight ?? this.inFlight.data()?.count ?? 0) - this.inboxCount()),
  );

  protected readonly menuOpen = signal(false);

  constructor() {
    effect(() => {
      if (this.authenticated()) this.liveSubscription.start();
      else this.liveSubscription.stop();
    });
  }

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
