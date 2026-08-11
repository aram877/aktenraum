import { HttpClient } from "@angular/common/http";
import { provideHttpClient } from "@angular/common/http";
import { HttpTestingController, provideHttpClientTesting } from "@angular/common/http/testing";
import { ComponentFixture, TestBed } from "@angular/core/testing";
import { QueryClient, provideTanStackQuery } from "@tanstack/angular-query-experimental";
import { beforeEach, describe, expect, it } from "vitest";

import { Health } from "./health";

describe("Health", () => {
  let fixture: ComponentFixture<Health>;
  let httpMock: HttpTestingController;

  beforeEach(async () => {
    await TestBed.configureTestingModule({
      imports: [Health],
      providers: [
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTanStackQuery(
          new QueryClient({ defaultOptions: { queries: { retry: false } } }),
        ),
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(Health);
    httpMock = TestBed.inject(HttpTestingController);
  });

  function stateText(): string {
    return (
      fixture.nativeElement as HTMLElement
    ).querySelector('[data-testid="state"]')!.textContent!.trim();
  }

  it("renders the loading state before the request resolves", () => {
    fixture.detectChanges();
    expect(stateText()).toBe("Lädt…");
  });

  it("renders the API status once the request resolves", async () => {
    fixture.detectChanges();
    httpMock.expectOne("/api/health").flush({ status: "ok" });
    await expect
      .poll(() => {
        fixture.detectChanges();
        return stateText();
      })
      .toBe("API-Status: ok");
  });

  it("renders an error state when the API fails", async () => {
    fixture.detectChanges();
    httpMock
      .expectOne("/api/health")
      .flush("boom", { status: 503, statusText: "Service Unavailable" });
    await expect
      .poll(() => {
        fixture.detectChanges();
        return stateText();
      })
      .toContain("Fehler:");
  });

  it("calls the API exactly once for the shared query key", () => {
    fixture.detectChanges();
    httpMock.expectOne("/api/health").flush({ status: "ok" });
    httpMock.verify();
    expect(TestBed.inject(HttpClient)).toBeTruthy();
  });
});
