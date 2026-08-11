import { provideHttpClient } from "@angular/common/http";
import { HttpTestingController, provideHttpClientTesting } from "@angular/common/http/testing";
import { TestBed } from "@angular/core/testing";
import { provideRouter, Router, UrlTree } from "@angular/router";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { authGuard, guestGuard } from "./auth-guard";

function runGuard(guard: typeof authGuard): Promise<unknown> {
  return TestBed.runInInjectionContext(
    () => guard(null as never, null as never) as Promise<unknown>,
  );
}

describe("route guards", () => {
  let httpMock: HttpTestingController;

  beforeEach(() => {
    TestBed.configureTestingModule({
      providers: [provideRouter([]), provideHttpClient(), provideHttpClientTesting()],
    });
    httpMock = TestBed.inject(HttpTestingController);
  });

  describe("authGuard", () => {
    it("allows an authenticated user through", async () => {
      const result = runGuard(authGuard);
      (await vi.waitFor(() => httpMock.expectOne("/api/auth/me"))).flush({ username: "a" });
      expect(await result).toBe(true);
    });

    it("redirects to /login on 401", async () => {
      const result = runGuard(authGuard);
      (await vi.waitFor(() => httpMock.expectOne("/api/auth/me"))).flush(
        { detail: "Not authenticated" },
        { status: 401, statusText: "Unauthorized" },
      );
      const tree = await result;
      expect(tree).toBeInstanceOf(UrlTree);
      expect(TestBed.inject(Router).serializeUrl(tree as UrlTree)).toBe("/login");
    });

    it("rethrows a non-401 so an outage is not mistaken for a logout", async () => {
      const result = runGuard(authGuard);
      (await vi.waitFor(() => httpMock.expectOne("/api/auth/me"))).flush("boom", {
        status: 502,
        statusText: "Bad Gateway",
      });
      await expect(result).rejects.toBeDefined();
    });
  });

  describe("guestGuard", () => {
    it("redirects an already-authenticated user away from /login", async () => {
      const result = runGuard(guestGuard);
      (await vi.waitFor(() => httpMock.expectOne("/api/auth/me"))).flush({ username: "a" });
      const tree = await result;
      expect(tree).toBeInstanceOf(UrlTree);
      expect(TestBed.inject(Router).serializeUrl(tree as UrlTree)).toBe("/");
    });

    it("lets an anonymous visitor reach /login", async () => {
      const result = runGuard(guestGuard);
      (await vi.waitFor(() => httpMock.expectOne("/api/auth/me"))).flush(
        { detail: "Not authenticated" },
        { status: 401, statusText: "Unauthorized" },
      );
      expect(await result).toBe(true);
    });

    it("still shows the login form when the API is down", async () => {
      const result = runGuard(guestGuard);
      (await vi.waitFor(() => httpMock.expectOne("/api/auth/me"))).flush("boom", {
        status: 502,
        statusText: "Bad Gateway",
      });
      expect(await result).toBe(true);
    });
  });
});
