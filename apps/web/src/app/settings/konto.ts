import { Component, computed, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { Router } from "@angular/router";

import { statusOf } from "../core/api";
import { injectChangePassword } from "../core/auth";

export function mapChangePasswordError(status: number | null): string {
  if (status === 401) return "Aktuelles Passwort ist nicht korrekt.";
  if (status === 400) return "Das neue Passwort muss sich vom aktuellen unterscheiden.";
  if (status === 422) {
    return "Bitte fülle alle Felder korrekt aus (min. 8 Zeichen für das neue Passwort).";
  }
  return "Unbekannter Fehler beim Ändern des Passworts.";
}

const REDIRECT_DELAY_MS = 1500;

@Component({
  selector: "app-konto",
  imports: [FormsModule],
  templateUrl: "./konto.html",
})
export class Konto {
  private readonly router = inject(Router);
  protected readonly change = injectChangePassword();

  protected readonly current = signal("");
  protected readonly next = signal("");
  protected readonly confirm = signal("");
  protected readonly showSuccess = signal(false);

  protected readonly confirmMismatch = computed(
    () => this.confirm().length > 0 && this.confirm() !== this.next(),
  );
  protected readonly newTooShort = computed(
    () => this.next().length > 0 && this.next().length < 8,
  );
  protected readonly canSubmit = computed(
    () =>
      this.current().length > 0 &&
      this.next().length >= 8 &&
      this.next() === this.confirm() &&
      !this.change.isPending() &&
      !this.showSuccess(),
  );
  protected readonly errorBanner = computed(() =>
    this.change.isError() ? mapChangePasswordError(statusOf(this.change.error())) : null,
  );

  protected async onSubmit(): Promise<void> {
    if (!this.canSubmit()) return;
    try {
      await this.change.mutateAsync({
        currentPassword: this.current(),
        newPassword: this.next(),
      });
      this.current.set("");
      this.next.set("");
      this.confirm.set("");
      this.showSuccess.set(true);
      setTimeout(() => void this.router.navigate(["/login"]), REDIRECT_DELAY_MS);
    } catch {
      return;
    }
  }
}
