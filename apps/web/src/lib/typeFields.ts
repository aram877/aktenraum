import {
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { AxiosError } from "axios";

import { api } from "./api";

export type FieldType = "string" | "money" | "date" | "month" | "year";

export type FieldDef = {
  name: string;
  label_de: string;
  field_type: FieldType;
};

export type DocumentTypeSchema = Record<string, FieldDef[]>;

export type TypeFieldsResponse = {
  document_type: string;
  fields: Record<string, string>;
};

const SCHEMA_KEY = ["document-type-schema"] as const;
const TYPE_FIELDS_KEY = ["type-fields"] as const;

async function fetchDocumentTypeSchema(): Promise<DocumentTypeSchema> {
  const { data } = await api.get<DocumentTypeSchema>("/document-types/schema");
  return data;
}

async function fetchTypeFields(docId: number): Promise<TypeFieldsResponse> {
  const { data } = await api.get<TypeFieldsResponse>(
    `/documents/${docId}/type-fields`,
  );
  return data;
}

async function patchTypeFields(
  docId: number,
  fields: Record<string, string | null>,
): Promise<TypeFieldsResponse> {
  const { data } = await api.patch<TypeFieldsResponse>(
    `/documents/${docId}/type-fields`,
    { fields },
  );
  return data;
}

export function useDocumentTypeSchema() {
  return useQuery<DocumentTypeSchema, AxiosError>({
    queryKey: SCHEMA_KEY,
    queryFn: fetchDocumentTypeSchema,
    staleTime: 60 * 60 * 1000,
    gcTime: 24 * 60 * 60 * 1000,
  });
}

export function useTypeFields(docId: number | null) {
  return useQuery<TypeFieldsResponse, AxiosError>({
    queryKey: [...TYPE_FIELDS_KEY, docId],
    queryFn: () => fetchTypeFields(docId as number),
    enabled: docId !== null,
    staleTime: 0,
    retry: (count, err) => {
      // 404 = no row yet, not an error worth retrying
      if ((err as AxiosError)?.response?.status === 404) return false;
      return count < 2;
    },
  });
}

export function usePatchTypeFields(docId: number) {
  const qc = useQueryClient();
  return useMutation({
    mutationFn: (fields: Record<string, string | null>) =>
      patchTypeFields(docId, fields),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...TYPE_FIELDS_KEY, docId] });
    },
  });
}
