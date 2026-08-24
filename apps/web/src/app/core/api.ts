import { HttpClient, HttpErrorResponse } from "@angular/common/http";
import { inject, Injectable } from "@angular/core";
import { lastValueFrom } from "rxjs";

export interface User {
  username: string;
}

export function detailFrom(error: unknown, fallback: string): string {
  if (error instanceof HttpErrorResponse) {
    const detail: unknown = error.error?.detail;
    if (typeof detail === "string" && detail.trim()) return detail;
    if (Array.isArray(detail) && detail.length > 0) {
      const first: unknown = detail[0];
      if (first !== null && typeof first === "object" && "msg" in first) {
        return String((first as { msg: unknown }).msg);
      }
    }
    if (error.status === 0) return "Server nicht erreichbar.";
    return `${error.status} ${error.statusText}`;
  }
  return fallback;
}

export function statusOf(error: unknown): number | null {
  return error instanceof HttpErrorResponse ? error.status : null;
}

@Injectable({ providedIn: "root" })
export class ApiClient {
  private readonly http = inject(HttpClient);

  get<T>(path: string): Promise<T> {
    return lastValueFrom(this.http.get<T>(`/api${path}`, { withCredentials: true }));
  }

  post<T>(path: string, body?: unknown): Promise<T> {
    return lastValueFrom(this.http.post<T>(`/api${path}`, body ?? {}, { withCredentials: true }));
  }

  patch<T>(path: string, body: unknown): Promise<T> {
    return lastValueFrom(this.http.patch<T>(`/api${path}`, body, { withCredentials: true }));
  }

  put<T>(path: string, body: unknown): Promise<T> {
    return lastValueFrom(this.http.put<T>(`/api${path}`, body, { withCredentials: true }));
  }
}
