export interface LibrarySpace {
  id: number;
  name: string;
  kind: "personal" | "shared";
}

export interface LibraryItem {
  id: number;
  title: string;
  original_file_name: string | null;
  created: string | null;
  added: string | null;
  correspondent: string | null;
  document_type: string | null;
  lifecycle_tags: string[];
  tags: string[];
  ai_error_message: string | null;
  is_processing: boolean;
  /** The document's home space; null while it has none yet. */
  home_space: LibrarySpace | null;
}

export interface LibraryList {
  results: LibraryItem[];
  total: number;
  page: number;
  page_size: number;
}

export interface TagFacet {
  name: string;
  count: number;
}

export interface TagFacetList {
  results: TagFacet[];
}
