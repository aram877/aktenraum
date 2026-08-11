import { Component, inject, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";
import { Router } from "@angular/router";

import { injectLogin } from "../core/auth";

@Component({
  selector: "app-login",
  imports: [FormsModule],
  templateUrl: "./login.html",
})
export class Login {
  private readonly router = inject(Router);
  protected readonly login = injectLogin();
  protected readonly username = signal("");
  protected readonly password = signal("");

  protected async onSubmit(): Promise<void> {
    try {
      await this.login.mutateAsync({
        username: this.username(),
        password: this.password(),
      });
      await this.router.navigate(["/"]);
    } catch {
      return;
    }
  }
}
