export interface PikPakLink {
  url?: string;
  expire?: string;
}

export interface PikPakFile {
  id: string;
  parent_id?: string;
  name: string;
  kind: 'drive#file' | 'drive#folder';
  size?: string | number;
  mime_type?: string;
  modified_time?: string;
  phase?: string;
  web_content_link?: string;
  links?: { 'application/octet-stream'?: PikPakLink };
  medias?: Array<{ link?: PikPakLink }>;
}

export interface PikPakFileList {
  files?: PikPakFile[];
  next_page_token?: string;
}

export interface PikPakNewFile {
  file?: PikPakFile;
  task?: { id?: string };
}

export interface PikPakTokenResponse {
  token_type?: string;
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  sub?: string;
}
