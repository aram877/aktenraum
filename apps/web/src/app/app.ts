import { Component } from "@angular/core";
import { RouterOutlet } from "@angular/router";

import { Nav } from "./shared/nav";

@Component({
  selector: "app-root",
  imports: [RouterOutlet, Nav],
  templateUrl: "./app.html",
  styleUrl: "./app.css",
})
export class App {
  protected readonly title = "aktenraum";
}
