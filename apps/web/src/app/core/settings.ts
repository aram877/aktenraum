import { inject, Injectable } from "@angular/core";
import {
  injectMutation,
  injectQuery,
  QueryClient,
} from "@tanstack/angular-query-experimental";

import { ApiClient } from "./api";

export interface LLMSettings {
  model: string;
}

export interface AvailableModelsResponse {
  models: string[];
}

export interface AutoApproveRule {
  document_type: string;
  enabled: boolean;
  min_confidence: number;
  updated_at: string | null;
  updated_by: string | null;
}

export interface AutoApproveRulesResponse {
  rules: AutoApproveRule[];
}

export interface AutoApproveRuleUpdate {
  document_type: string;
  enabled: boolean;
  min_confidence: number;
}

export const LLM_KEY = ["settings", "llm"] as const;
export const ANSWER_LLM_KEY = ["settings", "answer-llm"] as const;
export const AVAILABLE_MODELS_KEY = ["settings", "available-models"] as const;
export const AUTO_APPROVE_KEY = ["settings", "auto-approve"] as const;

@Injectable({ providedIn: "root" })
export class SettingsApi {
  private readonly api = inject(ApiClient);

  llm(): Promise<LLMSettings> {
    return this.api.get<LLMSettings>("/settings/llm");
  }

  setLlm(model: string): Promise<LLMSettings> {
    return this.api.patch<LLMSettings>("/settings/llm", { model });
  }

  answerLlm(): Promise<LLMSettings> {
    return this.api.get<LLMSettings>("/settings/answer-llm");
  }

  setAnswerLlm(model: string): Promise<LLMSettings> {
    return this.api.patch<LLMSettings>("/settings/answer-llm", { model });
  }

  availableModels(): Promise<string[]> {
    return this.api
      .get<AvailableModelsResponse>("/settings/available-models")
      .then((r) => r.models);
  }

  autoApprove(): Promise<AutoApproveRulesResponse> {
    return this.api.get<AutoApproveRulesResponse>("/settings/auto-approve");
  }

  setAutoApprove(rules: AutoApproveRuleUpdate[]): Promise<AutoApproveRulesResponse> {
    return this.api.put<AutoApproveRulesResponse>("/settings/auto-approve", { rules });
  }
}

export function injectLLMSettings() {
  const settings = inject(SettingsApi);
  return injectQuery(() => ({
    queryKey: LLM_KEY,
    queryFn: () => settings.llm(),
    staleTime: 30_000,
  }));
}

export function injectUpdateLLMSettings() {
  const settings = inject(SettingsApi);
  const queryClient = inject(QueryClient);
  return injectMutation(() => ({
    mutationFn: (model: string) => settings.setLlm(model),
    onSuccess: (data: LLMSettings) => queryClient.setQueryData(LLM_KEY, data),
  }));
}

export function injectAnswerLLMSettings() {
  const settings = inject(SettingsApi);
  return injectQuery(() => ({
    queryKey: ANSWER_LLM_KEY,
    queryFn: () => settings.answerLlm(),
    staleTime: 30_000,
  }));
}

export function injectUpdateAnswerLLMSettings() {
  const settings = inject(SettingsApi);
  const queryClient = inject(QueryClient);
  return injectMutation(() => ({
    mutationFn: (model: string) => settings.setAnswerLlm(model),
    onSuccess: (data: LLMSettings) => queryClient.setQueryData(ANSWER_LLM_KEY, data),
  }));
}

export function injectAvailableModels() {
  const settings = inject(SettingsApi);
  return injectQuery(() => ({
    queryKey: AVAILABLE_MODELS_KEY,
    queryFn: () => settings.availableModels(),
    staleTime: 10_000,
  }));
}

export function injectAutoApproveRules() {
  const settings = inject(SettingsApi);
  return injectQuery(() => ({
    queryKey: AUTO_APPROVE_KEY,
    queryFn: () => settings.autoApprove(),
    staleTime: 30_000,
  }));
}

export function injectUpdateAutoApproveRules() {
  const settings = inject(SettingsApi);
  const queryClient = inject(QueryClient);
  return injectMutation(() => ({
    mutationFn: (rules: AutoApproveRuleUpdate[]) => settings.setAutoApprove(rules),
    onSuccess: (data: AutoApproveRulesResponse) =>
      queryClient.setQueryData(AUTO_APPROVE_KEY, data),
  }));
}
