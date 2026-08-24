export interface TrashItem {
  id: number;
  title: string;
  original_file_name: string | null;
  created: string | null;
  deleted_at: string | null;
  correspondent: string | null;
  document_type: string | null;
  ai_correspondent: string | null;
  ai_document_type: string | null;
  ai_summary_de: string | null;
}

export interface TrashList {
  results: TrashItem[];
  total: number;
  page: number;
  page_size: number;
}

export interface EmptyTrashResponse {
  emptied: number;
}
