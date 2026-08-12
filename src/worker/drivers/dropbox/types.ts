export interface DropboxExportInfo {
  export_as?: string;
  export_options?: string[];
}

export interface DropboxMetadata {
  '.tag': 'file' | 'folder' | 'deleted';
  id: string;
  name: string;
  path_lower?: string;
  path_display?: string;
  client_modified?: string;
  server_modified?: string;
  rev?: string;
  size?: number;
  is_downloadable?: boolean;
  content_hash?: string;
  export_info?: DropboxExportInfo;
}

export interface DropboxListPayload {
  entries: DropboxMetadata[];
  cursor: string;
  has_more: boolean;
}

export interface DropboxRelocationResult {
  metadata: DropboxMetadata;
}

export interface DropboxUploadSessionStartResult {
  session_id: string;
}
