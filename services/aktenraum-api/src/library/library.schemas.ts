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
  /** The document's home space; null while it has none yet, or when it only reaches the caller through a share. */
  home_space: LibrarySpace | null;
  /** Set when the document reaches the caller through a share ("Geteilt von …"). */
  shared_by?: SharedBy | null;
}

export interface SharedBy {
  username: string;
  role: "viewer" | "editor";
  expires_at: string | null;
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
