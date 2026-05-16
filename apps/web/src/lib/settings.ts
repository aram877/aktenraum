import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { AxiosError } from "axios";

import { api } from "./api";

export type LLMQuality = "high" | "medium";

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
