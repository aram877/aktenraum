import { Routes } from "@angular/router";

import { authGuard, guestGuard } from "./core/auth-guard";

export const routes: Routes = [
  {
    path: "login",
    canActivate: [guestGuard],
    loadComponent: () => import("./login/login").then((m) => m.Login),
  },
  {
    path: "",
    canActivate: [authGuard],
    loadComponent: () => import("./home/home").then((m) => m.Home),
  },
  {
    path: "settings",
    canActivate: [authGuard],
    loadComponent: () => import("./settings/settings").then((m) => m.Settings),
  },
  {
    path: "library",
    canActivate: [authGuard],
    loadComponent: () => import("./library/library").then((m) => m.Library),
  },
  {
    path: "upload",
    canActivate: [authGuard],
    loadComponent: () => import("./upload/upload").then((m) => m.Upload),
  },
  {
    path: "trash",
    canActivate: [authGuard],
    loadComponent: () => import("./trash/trash").then((m) => m.Trash),
  },
  {
    path: "ask",
    canActivate: [authGuard],
    loadComponent: () => import("./ask/ask").then((m) => m.Ask),
  },
  {
    path: "library/:id",
    canActivate: [authGuard],
    loadComponent: () =>
      import("./library-review/library-review").then((m) => m.LibraryReview),
  },
  {
    path: "inbox/:id",
    canActivate: [authGuard],
    loadComponent: () => import("./inbox-review/inbox-review").then((m) => m.InboxReview),
  },
  {
    path: "health",
    loadComponent: () => import("./health/health").then((m) => m.Health),
  },
  {
    path: "**",
    loadComponent: () => import("./not-ported/not-ported").then((m) => m.NotPorted),
  },
];
