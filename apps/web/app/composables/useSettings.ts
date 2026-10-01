import { useMutation, useQuery, useQueryClient } from "@tanstack/vue-query";

export interface LLMSettings {
  model: string;
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

export function useLLMSettings() {
  const api = useApi();
  return useQuery({
    queryKey: LLM_KEY,
    queryFn: () => api.get<LLMSettings>("/settings/llm"),
    staleTime: 30_000,
  });
}

export function useUpdateLLMSettings() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (model: string) => api.patch<LLMSettings>("/settings/llm", { model }),
    onSuccess: (data) => queryClient.setQueryData(LLM_KEY, data),
  });
}

export function useAnswerLLMSettings() {
  const api = useApi();
  return useQuery({
    queryKey: ANSWER_LLM_KEY,
    queryFn: () => api.get<LLMSettings>("/settings/answer-llm"),
    staleTime: 30_000,
  });
}

export function useUpdateAnswerLLMSettings() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (model: string) => api.patch<LLMSettings>("/settings/answer-llm", { model }),
    onSuccess: (data) => queryClient.setQueryData(ANSWER_LLM_KEY, data),
  });
}

export function useAvailableModels() {
  const api = useApi();
  return useQuery({
    queryKey: AVAILABLE_MODELS_KEY,
    queryFn: () =>
      api.get<{ models: string[] }>("/settings/available-models").then((r) => r.models),
    staleTime: 10_000,
  });
}

export function useAutoApproveRules() {
  const api = useApi();
  return useQuery({
    queryKey: AUTO_APPROVE_KEY,
    queryFn: () => api.get<AutoApproveRulesResponse>("/settings/auto-approve"),
    staleTime: 30_000,
  });
}

export function useUpdateAutoApproveRules() {
  const api = useApi();
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (rules: AutoApproveRuleUpdate[]) =>
      api.put<AutoApproveRulesResponse>("/settings/auto-approve", { rules }),
    onSuccess: (data) => queryClient.setQueryData(AUTO_APPROVE_KEY, data),
  });
}
