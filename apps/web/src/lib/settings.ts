import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { AxiosError } from "axios";

import { api } from "./api";
import type { DocumentType } from "./ai";

export type LLMQuality = "high" | "medium";

export type AutoApproveRule = {
  document_type: DocumentType;
  enabled: boolean;
  min_confidence: number;
  updated_at: string | null;
  updated_by: string | null;
};

export type AutoApproveRulesResponse = {
  rules: AutoApproveRule[];
};

export type AutoApproveRuleUpdate = {
  document_type: DocumentType;
  enabled: boolean;
  min_confidence: number;
};

export type LLMSettings = {
  quality: LLMQuality;
  ollama_model: string;
};

const SETTINGS_KEY = ["settings", "llm"] as const;

async function fetchLLMSettings(): Promise<LLMSettings> {
  const { data } = await api.get<LLMSettings>("/settings/llm");
  return data;
}

async function patchLLMSettings(quality: LLMQuality): Promise<LLMSettings> {
  const { data } = await api.patch<LLMSettings>("/settings/llm", { quality });
  return data;
}

export function useLLMSettings() {
  return useQuery<LLMSettings, AxiosError>({
    queryKey: SETTINGS_KEY,
    queryFn: fetchLLMSettings,
    staleTime: 30_000,
  });
}

export function useUpdateLLMSettings() {
  const qc = useQueryClient();
  return useMutation<LLMSettings, AxiosError, LLMQuality>({
    mutationFn: patchLLMSettings,
    onSuccess: (data) => {
      qc.setQueryData(SETTINGS_KEY, data);
    },
  });
}

const ANSWER_SETTINGS_KEY = ["settings", "answer-llm"] as const;

async function fetchAnswerLLMSettings(): Promise<LLMSettings> {
  const { data } = await api.get<LLMSettings>("/settings/answer-llm");
  return data;
}

async function patchAnswerLLMSettings(quality: LLMQuality): Promise<LLMSettings> {
  const { data } = await api.patch<LLMSettings>("/settings/answer-llm", { quality });
  return data;
}

export function useAnswerLLMSettings() {
  return useQuery<LLMSettings, AxiosError>({
    queryKey: ANSWER_SETTINGS_KEY,
    queryFn: fetchAnswerLLMSettings,
    staleTime: 30_000,
  });
}

export function useUpdateAnswerLLMSettings() {
  const qc = useQueryClient();
  return useMutation<LLMSettings, AxiosError, LLMQuality>({
    mutationFn: patchAnswerLLMSettings,
    onSuccess: (data) => {
      qc.setQueryData(ANSWER_SETTINGS_KEY, data);
    },
  });
}

export const AUTO_APPROVE_KEY = ["settings", "auto-approve"] as const;

async function fetchAutoApproveRules(): Promise<AutoApproveRulesResponse> {
  const { data } = await api.get<AutoApproveRulesResponse>(
    "/settings/auto-approve",
  );
  return data;
}

async function putAutoApproveRules(
  rules: AutoApproveRuleUpdate[],
): Promise<AutoApproveRulesResponse> {
  const { data } = await api.put<AutoApproveRulesResponse>(
    "/settings/auto-approve",
    { rules },
  );
  return data;
}

export function useAutoApproveRules() {
  return useQuery<AutoApproveRulesResponse, AxiosError<{ detail?: string }>>({
    queryKey: AUTO_APPROVE_KEY,
    queryFn: fetchAutoApproveRules,
    staleTime: 30_000,
  });
}

export function useUpdateAutoApproveRules() {
  const qc = useQueryClient();
  return useMutation<
    AutoApproveRulesResponse,
    AxiosError<{ detail?: string }>,
    AutoApproveRuleUpdate[]
  >({
    mutationFn: putAutoApproveRules,
    onSuccess: (data) => {
      qc.setQueryData(AUTO_APPROVE_KEY, data);
    },
  });
}
