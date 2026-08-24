import { provideHttpClient } from "@angular/common/http";
import { HttpTestingController, provideHttpClientTesting } from "@angular/common/http/testing";
import { ComponentFixture, TestBed } from "@angular/core/testing";
import { provideRouter } from "@angular/router";
import { QueryClient, provideTanStackQuery } from "@tanstack/angular-query-experimental";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ME_KEY } from "../core/auth";
import { LIVE_COUNTS_KEY } from "../core/live";
import { Nav } from "./nav";

describe("Nav", () => {
  let fixture: ComponentFixture<Nav>;
  let httpMock: HttpTestingController;
  let queryClient: QueryClient;

  beforeEach(async () => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await TestBed.configureTestingModule({
      imports: [Nav],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTanStackQuery(queryClient),
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(Nav);
    httpMock = TestBed.inject(HttpTestingController);
  });

  function html(): string {
    return (fixture.nativeElement as HTMLElement).innerHTML;
  }

  // Waiting for the /auth/me query to reach its error state before asserting
  // absence matters: a bare `not.toContain("<nav")` passes on the first tick
  // simply because nothing has rendered yet, which would make these tests
  // pass even with the nav ungated.
  async function settleUnauthenticated(): Promise<void> {
    (await vi.waitFor(() => httpMock.expectOne("/api/auth/me"))).flush(
      { detail: "Not authenticated" },
      { status: 401, statusText: "Unauthorized" },
    );
    await expect
      .poll(() => queryClient.getQueryState(ME_KEY)?.status)
      .toBe("error");
    fixture.detectChanges();
    await fixture.whenStable();
  }

  it("renders nothing at all while the user is unauthenticated", async () => {
    fixture.detectChanges();
    await settleUnauthenticated();

    expect(html()).not.toContain("<nav");
    for (const label of ["Bibliothek", "Hochladen", "Papierkorb", "Einstellungen", "Abmelden"]) {
      expect(html()).not.toContain(label);
    }
  });

  it("does not fetch the badge counts while unauthenticated", async () => {
    fixture.detectChanges();
    await settleUnauthenticated();

    httpMock.expectNone("/api/documents/in-flight");
    httpMock.expectNone("/api/trash/");
  });

  it("renders the full menu once authenticated", async () => {
    queryClient.setQueryData(ME_KEY, { username: "admin" });
    fixture.detectChanges();

    await expect.poll(() => html()).toContain("<nav");
    for (const label of ["Start", "Bibliothek", "Hochladen", "Papierkorb", "Einstellungen"]) {
      expect(html()).toContain(label);
    }
  });

  describe("review badge", () => {
    async function renderAuthenticated(): Promise<void> {
      queryClient.setQueryData(ME_KEY, { username: "admin" });
      fixture.detectChanges();
      await expect.poll(() => html()).toContain("<nav");
    }

    it("shows the pending count from the live stream", async () => {
      queryClient.setQueryData(LIVE_COUNTS_KEY, { inbox: 7, in_flight: 9, trash: 0 });
      await renderAuthenticated();

      const badge = (fixture.nativeElement as HTMLElement).querySelector(
        '[data-testid="review-badge"]',
      );
      expect(badge?.textContent?.trim()).toBe("7");
    });

    it("falls back to the polled inbox total when the stream has pushed nothing", async () => {
      await renderAuthenticated();
      (await vi.waitFor(() => httpMock.expectOne((r) => r.url.startsWith("/api/inbox/")))).flush({
        results: [],
        total: 3,
        page: 1,
        page_size: 1,
      });

      await expect
        .poll(() =>
          (fixture.nativeElement as HTMLElement)
            .querySelector('[data-testid="review-badge"]')
            ?.textContent?.trim(),
        )
        .toBe("3");
    });

    it("hides the badge when nothing is waiting for review", async () => {
      queryClient.setQueryData(LIVE_COUNTS_KEY, { inbox: 0, in_flight: 0, trash: 0 });
      await renderAuthenticated();

      expect(
        (fixture.nativeElement as HTMLElement).querySelector('[data-testid="review-badge"]'),
      ).toBeNull();
    });

    it("does not double-count review docs in the in-Bearbeitung pill", async () => {
      // in_flight covers ai-pending AND ai-approved, so a doc waiting in
      // review is in both numbers. The pill must show only the difference.
      queryClient.setQueryData(LIVE_COUNTS_KEY, { inbox: 4, in_flight: 6, trash: 0 });
      await renderAuthenticated();

      const pill = (fixture.nativeElement as HTMLElement).querySelector(
        '[data-testid="in-flight-pill"]',
      );
      expect(pill?.textContent?.trim()).toBe("2 in Bearbeitung");
    });

    it("hides the pill when every in-flight doc is already in review", async () => {
      queryClient.setQueryData(LIVE_COUNTS_KEY, { inbox: 5, in_flight: 5, trash: 0 });
      await renderAuthenticated();

      expect(
        (fixture.nativeElement as HTMLElement).querySelector('[data-testid="in-flight-pill"]'),
      ).toBeNull();
    });
  });
});
