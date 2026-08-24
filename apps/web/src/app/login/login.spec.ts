import { provideHttpClient } from "@angular/common/http";
import { HttpTestingController, provideHttpClientTesting } from "@angular/common/http/testing";
import { ComponentFixture, TestBed } from "@angular/core/testing";
import { provideRouter, Router } from "@angular/router";
import { QueryClient, provideTanStackQuery } from "@tanstack/angular-query-experimental";
import { beforeEach, describe, expect, it, vi } from "vitest";

import { ME_KEY } from "../core/auth";
import { Login } from "./login";

describe("Login", () => {
  let fixture: ComponentFixture<Login>;
  let httpMock: HttpTestingController;
  let queryClient: QueryClient;

  beforeEach(async () => {
    queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await TestBed.configureTestingModule({
      imports: [Login],
      providers: [
        provideRouter([]),
        provideHttpClient(),
        provideHttpClientTesting(),
        provideTanStackQuery(queryClient),
      ],
    }).compileComponents();

    fixture = TestBed.createComponent(Login);
    httpMock = TestBed.inject(HttpTestingController);
    fixture.detectChanges();
  });

  function submit(): void {
    const form = (fixture.nativeElement as HTMLElement).querySelector("form")!;
    form.dispatchEvent(new Event("submit"));
  }

  async function awaitRequest(url: string) {
    return vi.waitFor(() => httpMock.expectOne(url));
  }

  function setField(name: string, value: string): void {
    const input = (fixture.nativeElement as HTMLElement).querySelector(
      `input[name="${name}"]`,
    ) as HTMLInputElement;
    input.value = value;
    input.dispatchEvent(new Event("input"));
    fixture.detectChanges();
  }

  it("posts the credentials to /api/auth/login", async () => {
    setField("username", "admin");
    setField("password", "hunter2");
    submit();

    const req = await awaitRequest("/api/auth/login");
    expect(req.request.method).toBe("POST");
    expect(req.request.body).toEqual({ username: "admin", password: "hunter2" });
    req.flush({ username: "admin" });
  });

  it("seeds the me cache and navigates home on success", async () => {
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, "navigate").mockResolvedValue(true);

    setField("username", "admin");
    setField("password", "hunter2");
    submit();
    (await awaitRequest("/api/auth/login")).flush({ username: "admin" });

    await expect.poll(() => queryClient.getQueryData(ME_KEY)).toEqual({ username: "admin" });
    await expect.poll(() => navigate.mock.calls.length).toBeGreaterThan(0);
    expect(navigate).toHaveBeenCalledWith(["/"]);
  });

  it("shows the German error and does not navigate on 401", async () => {
    const router = TestBed.inject(Router);
    const navigate = vi.spyOn(router, "navigate").mockResolvedValue(true);

    setField("username", "admin");
    setField("password", "wrong");
    submit();
    (await awaitRequest("/api/auth/login")).flush(
      { detail: "Invalid credentials" },
      { status: 401, statusText: "Unauthorized" },
    );

    await expect
      .poll(() => {
        fixture.detectChanges();
        return (fixture.nativeElement as HTMLElement).querySelector(
          '[data-testid="login-error"]',
        )?.textContent;
      })
      .toContain("Ungültige Anmeldedaten");
    expect(navigate).not.toHaveBeenCalled();
  });
});
