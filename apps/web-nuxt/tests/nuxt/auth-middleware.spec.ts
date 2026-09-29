import { mockNuxtImport } from "@nuxt/test-utils/runtime";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { RouteLocationNormalized } from "vue-router";

import authMiddleware from "~/middleware/auth";
import guestMiddleware from "~/middleware/guest";
import { fetchError } from "../fetch-error";

const { get, navigate } = vi.hoisted(() => ({ get: vi.fn(), navigate: vi.fn() }));

mockNuxtImport("useApi", () => () => ({ get, post: vi.fn(), patch: vi.fn(), put: vi.fn(), upload: vi.fn() }));
mockNuxtImport("navigateTo", () => navigate);

const route = {} as RouteLocationNormalized;

describe("route middleware", () => {
  beforeEach(() => {
    useNuxtApp().$queryClient.clear();
    get.mockReset();
    navigate.mockReset();
    navigate.mockImplementation((to: string) => to);
  });

  describe("auth", () => {
    it("allows an authenticated user through", async () => {
      get.mockResolvedValue({ username: "a" });
      expect(await authMiddleware(route, route)).toBeUndefined();
      expect(get).toHaveBeenCalledWith("/auth/me");
      expect(navigate).not.toHaveBeenCalled();
    });

    it("redirects to /login on 401", async () => {
      get.mockRejectedValue(fetchError(401, { detail: "Not authenticated" }));
      expect(await authMiddleware(route, route)).toBe("/login");
    });

    it("rethrows a non-401 so an outage is not mistaken for a logout", async () => {
      get.mockRejectedValue(fetchError(502, "boom", "Bad Gateway"));
      await expect(authMiddleware(route, route)).rejects.toBeDefined();
      expect(navigate).not.toHaveBeenCalled();
    });

    it("reuses a fresh cached user instead of refetching on every navigation", async () => {
      get.mockResolvedValue({ username: "a" });
      await authMiddleware(route, route);
      await authMiddleware(route, route);
      expect(get).toHaveBeenCalledTimes(1);
    });
  });

  describe("guest", () => {
    it("redirects an already-authenticated user away from /login", async () => {
      get.mockResolvedValue({ username: "a" });
      expect(await guestMiddleware(route, route)).toBe("/");
    });

    it("lets an anonymous visitor reach /login", async () => {
      get.mockRejectedValue(fetchError(401));
      expect(await guestMiddleware(route, route)).toBeUndefined();
    });

    it("still shows the login form when the API is down", async () => {
      get.mockRejectedValue(fetchError(502));
      expect(await guestMiddleware(route, route)).toBeUndefined();
    });
  });
});
