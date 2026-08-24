import { Component, computed, effect, input, output, signal } from "@angular/core";
import { FormsModule } from "@angular/forms";

@Component({
  selector: "app-model-picker",
  imports: [FormsModule],
  templateUrl: "./model-picker.html",
})
export class ModelPicker {
  readonly title = input.required<string>();
  readonly description = input.required<string>();
  readonly fieldName = input.required<string>();
  readonly activeModel = input<string | null>(null);
  readonly availableModels = input<readonly string[]>([]);
  readonly isModelsLoading = input(false);
  readonly isPending = input(false);
  readonly pending = input<string | null>(null);
  readonly pick = output<string>();

  protected readonly manualValue = signal("");

  protected readonly hasLiveList = computed(() => this.availableModels().length > 0);

  protected readonly options = computed<readonly string[]>(() => {
    const active = this.activeModel();
    const list = this.availableModels();
    if (this.hasLiveList() && active && !list.includes(active)) return [active, ...list];
    return list;
  });

  protected readonly hint = computed(() => {
    if (this.pending()) return "speichere…";
    if (this.isModelsLoading()) return "Lade verfügbare Modelle…";
    if (!this.hasLiveList()) {
      return "Kein Ollama erreichbar (oder Backend ist Anthropic) — Modell manuell eingeben.";
    }
    return `aktiv: ${this.activeModel()}`;
  });

  constructor() {
    effect(() => {
      this.manualValue.set(this.activeModel() ?? "");
    });
  }

  protected onSelect(value: string): void {
    this.pick.emit(value);
  }

  protected onManualSubmit(): void {
    const trimmed = this.manualValue().trim();
    if (trimmed) this.pick.emit(trimmed);
  }
}
