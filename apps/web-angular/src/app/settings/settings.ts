import { Component, signal } from "@angular/core";

import {
  injectAnswerLLMSettings,
  injectAvailableModels,
  injectLLMSettings,
  injectUpdateAnswerLLMSettings,
  injectUpdateLLMSettings,
} from "../core/settings";
import { AutoApprove } from "./auto-approve";
import { Konto } from "./konto";
import { ModelPicker } from "./model-picker";

@Component({
  selector: "app-settings",
  imports: [ModelPicker, Konto, AutoApprove],
  templateUrl: "./settings.html",
})
export class Settings {
  protected readonly tagger = injectLLMSettings();
  protected readonly answer = injectAnswerLLMSettings();
  protected readonly models = injectAvailableModels();
  protected readonly updateTagger = injectUpdateLLMSettings();
  protected readonly updateAnswer = injectUpdateAnswerLLMSettings();

  protected readonly pendingTagger = signal<string | null>(null);
  protected readonly pendingAnswer = signal<string | null>(null);

  protected async onPickTagger(model: string): Promise<void> {
    this.pendingTagger.set(model);
    try {
      await this.updateTagger.mutateAsync(model);
    } finally {
      this.pendingTagger.set(null);
    }
  }

  protected async onPickAnswer(model: string): Promise<void> {
    this.pendingAnswer.set(model);
    try {
      await this.updateAnswer.mutateAsync(model);
    } finally {
      this.pendingAnswer.set(null);
    }
  }
}
