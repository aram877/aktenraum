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
  documentType?: string,
): Promise<TypeFieldsResponse> {
  const { data } = await api.patch<TypeFieldsResponse>(
    `/documents/${docId}/type-fields`,
    { fields, document_type: documentType ?? null },
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

export function useTypeFields(
  docId: number | null,
  opts?: { pollUntilArrived?: boolean },
) {
  return useQuery<TypeFieldsResponse, AxiosError>({
    queryKey: [...TYPE_FIELDS_KEY, docId],
    queryFn: () => fetchTypeFields(docId as number),
    enabled: docId !== null,
    staleTime: 0,
    // Pass 2 (type-specific extraction) runs in the auto-tagger AFTER
    // pass 1 has applied the lifecycle tag, so a user who opens the
    // detail page seconds after a doc lands sees the basic ai_* fields
    // populated but the type-specific section still empty. Caller
    // (Inbox/Library detail) opts in to polling when the parent doc
    // still looks in-flight; we drop the interval the moment we get a
    // non-empty response back, so the polling window is bounded by the
    // server-side pass-2 duration (~seconds, not minutes).
    refetchInterval: (query) => {
      if (!opts?.pollUntilArrived) return false;
      const data = query.state.data;
      const arrived = !!data && Object.keys(data.fields ?? {}).length > 0;
      return arrived ? false : 3000;
    },
    refetchIntervalInBackground: false,
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
    mutationFn: ({
      fields,
      documentType,
    }: {
      fields: Record<string, string | null>;
      documentType?: string;
    }) => patchTypeFields(docId, fields, documentType),
    onSuccess: () => {
      qc.invalidateQueries({ queryKey: [...TYPE_FIELDS_KEY, docId] });
    },
  });
}
