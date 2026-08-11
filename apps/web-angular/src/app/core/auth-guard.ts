import { inject } from "@angular/core";
import { Router, type CanActivateFn } from "@angular/router";

import { AuthApi } from "./auth";
import { statusOf } from "./api";

export const authGuard: CanActivateFn = async () => {
  const auth = inject(AuthApi);
  const router = inject(Router);
  try {
    await auth.me();
    return true;
  } catch (error: unknown) {
    if (statusOf(error) === 401) return router.createUrlTree(["/login"]);
    throw error;
  }
};

export const guestGuard: CanActivateFn = async () => {
  const auth = inject(AuthApi);
  const router = inject(Router);
  try {
    await auth.me();
    return router.createUrlTree(["/"]);
  } catch (error: unknown) {
    if (statusOf(error) === 401) return true;
    return true;
  }
};
