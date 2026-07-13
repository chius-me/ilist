# ilist Multi-Mount Storage Design

## Goal

Turn ilist from a single Cloudflare R2 file manager into an OpenList-style multi-mount file manager. Administrators can add multiple S3-compatible or OneDrive Personal mounts, choose each mount's visible folder name, and manage all mounts through one explorer.

Google Drive, work or school Microsoft accounts, WebDAV, and cross-storage copy are outside this release.

## Product Behavior

The virtual root lists enabled mounts as ordinary folders. Each mount has a unique root path and a user-defined display name:

```text
/
|-- Personal Drive     OneDrive Personal
|-- Photos             OneDrive Personal
|-- Public Files       Cloudflare R2 through S3
`-- Backups            Backblaze B2 through S3
```

Administrators can create, edit, disable, reorder, and remove mounts. Removing a mount removes only ilist configuration and credentials; it never deletes the remote bucket, drive, or its files. A mount path is unique, normalized, and restricted to one top-level path segment in this release. Names `api`, `file`, and `admin` remain reserved.

Guests see only enabled mounts marked public. Administrators see all enabled mounts and can manage content according to driver capabilities.

## Architecture

Filesystem routes resolve the first virtual path segment to a mount, instantiate its driver, and translate provider objects into a common storage item. UI code and filesystem routes do not call R2 or Microsoft Graph directly.

```text
Explorer and filesystem API
          |
          v
     MountResolver
          |
          +-- S3Driver
          |    +-- Cloudflare R2
          |    +-- AWS S3
          |    +-- Backblaze B2
          |    `-- MinIO and compatible services
          |
          `-- OneDriveDriver
               `-- OneDrive Personal
```

The common driver contract covers listing, metadata, download, folder creation, upload, rename, move, and deletion. Capabilities are explicit so the explorer can hide unsupported operations without provider-specific UI branches.

Provider item IDs remain provider-native. Virtual identity is the tuple `(mount_id, provider_item_id)`. Paths are navigation data, not permanent identity.

## Driver Contract

```ts
type DriverCapability =
  | 'list'
  | 'download'
  | 'upload'
  | 'createFolder'
  | 'rename'
  | 'move'
  | 'delete';

interface StorageItem {
  id: string;
  parentId: string | null;
  name: string;
  kind: 'file' | 'folder';
  size: number | null;
  contentType: string | null;
  modifiedAt: string | null;
  etag: string | null;
}

interface ListResult {
  items: StorageItem[];
  nextCursor: string | null;
}

type DownloadResult =
  | { kind: 'redirect'; url: string }
  | { kind: 'stream'; response: Response };

interface StorageDriver {
  readonly capabilities: ReadonlySet<DriverCapability>;
  list(parentId: string, cursor?: string): Promise<ListResult>;
  stat(itemId: string): Promise<StorageItem>;
  getDownload(itemId: string, request: Request): Promise<DownloadResult>;
  createFolder(parentId: string, name: string): Promise<StorageItem>;
  upload(parentId: string, name: string, body: ReadableStream, contentType: string | null): Promise<StorageItem>;
  rename(itemId: string, name: string): Promise<StorageItem>;
  move(itemId: string, destinationId: string): Promise<StorageItem>;
  remove(itemId: string): Promise<void>;
}
```

Driver errors are converted into stable ilist error codes. Provider response bodies, access tokens, refresh tokens, S3 secrets, and preauthenticated download URLs are never logged.

## Data Model

`mounts` stores public mount metadata:

```text
id, name, mount_path, driver_type, provider, enabled, is_public,
sort_order, root_item_id, config_json, created_at, updated_at
```

`storage_credentials` stores encrypted private configuration:

```text
mount_id, ciphertext, key_version, created_at, updated_at
```

Credentials use AES-GCM with a random IV per encryption. The master key is the Cloudflare secret `CREDENTIAL_MASTER_KEY`. Public driver configuration such as region, bucket display information, and root prefix can remain in `config_json`; secrets and OAuth tokens must be encrypted in `storage_credentials`.

`oauth_states` stores one-time PKCE transactions with an expiry and consumed timestamp. OAuth state can only be consumed once.

Existing `entries`, `objects`, and the native `R2_BUCKET` binding remain operational during compatibility migration. Remote S3 and OneDrive items are not mirrored permanently into `entries`; they are read from their provider to avoid stale dual state.

## S3-Compatible Driver

The S3 driver supports multiple independently configured mounts. Configuration includes provider preset, endpoint, region, bucket, root prefix, addressing mode, access key ID, and secret access key.

Provider presets supply defaults but do not change the driver contract:

- Cloudflare R2: account-specific endpoint, region `auto`, path-style addressing.
- AWS S3: AWS regional endpoint and virtual-hosted addressing by default.
- Backblaze B2: region-specific S3 endpoint.
- Custom: explicit endpoint, region, and addressing mode for MinIO or another compatible service.

The implementation uses SigV4 requests compatible with the Workers runtime. Directory semantics are derived from object prefixes and delimiters. Rename and move are copy-then-delete operations and must report partial failures without deleting the source when copying fails.

The current native R2 content remains available through a compatibility mount. A later migration may copy its metadata into the mount model, but this release does not move object bytes or remove the binding.

## OneDrive Personal Driver

OneDrive uses Microsoft delegated Authorization Code flow with PKCE against the `consumers` tenant. Requested scopes are:

```text
offline_access User.Read Files.ReadWrite
```

Each mount has independent OAuth credentials, so one administrator can connect multiple personal Microsoft accounts. OAuth callback processing validates state, verifier, expiry, and single use before exchanging the code. Tokens are encrypted before D1 storage.

The driver refreshes access tokens before expiry and persists rotated refresh tokens. Concurrent refresh attempts for the same mount are serialized using a short D1 lease; callers re-read the credential after waiting for an active lease rather than issuing a second refresh.

Microsoft Graph DriveItem IDs are used as item IDs. Directory listing follows `@odata.nextLink` through opaque cursors. Downloads use `@microsoft.graph.downloadUrl` and redirect whenever possible. Download URLs are not persisted because they are short-lived.

This release supports listing, metadata, download, new folders, rename, move, delete, and existing single-request uploads. Resumable upload sessions are a separate follow-up release.

## APIs and UI

New administrator APIs manage mounts and OAuth:

```text
GET    /api/admin/mounts
POST   /api/admin/mounts
PATCH  /api/admin/mounts/:id
DELETE /api/admin/mounts/:id
POST   /api/admin/mounts/:id/test
GET    /api/admin/oauth/onedrive/start?mountId=:id
GET    /api/admin/oauth/onedrive/callback
POST   /api/admin/mounts/:id/disconnect
```

The explorer API keeps virtual paths. Responses add `mountId`, `driverType`, provider identity, cursor, and capabilities. Stable file URLs include the mount ID and provider item ID rather than a mutable path.

The existing explorer gains a storage management view. It lists mount name, path, provider, connection status, visibility, and enabled state. Add and edit dialogs use provider presets and never return stored secrets to the browser. Leaving a secret field blank preserves the existing secret.

## Failure and Security Rules

- Mount names and paths are normalized and uniqueness is enforced in D1.
- Provider failures affect only the selected mount; the virtual root still loads other mounts.
- OAuth state expires after ten minutes and is single-use.
- Credential encryption uses authenticated AES-GCM; malformed ciphertext fails closed.
- Disconnecting OneDrive deletes local tokens but does not delete remote content.
- Deleting a mount requires explicit confirmation and never deletes provider content.
- S3 endpoint schemes must be HTTPS except for explicitly allowed local development endpoints.
- Redirect and callback origins come from configured trusted origins, not arbitrary request headers.

## Testing

Worker tests cover path resolution, duplicate mounts, guest visibility, encryption round trips, malformed credentials, OAuth state replay, token refresh rotation, Graph pagination, download redirects, S3 signing, prefix listing, and copy-before-delete move behavior.

Provider HTTP calls use deterministic fetch fakes in unit tests. Local integration tests use the current R2 binding for compatibility behavior. Production rollout requires a disposable S3 prefix and OneDrive test folder for create, upload, rename, move, download, and delete smoke tests.

The existing UI and Worker suites must remain green. Desktop and mobile checks cover virtual root navigation, mount management, OAuth return states, disabled mounts, and provider-specific failures.

## Delivery Sequence

1. Add common driver types, mount schema, credential encryption, and mount administration APIs.
2. Add virtual-root resolution while retaining the native R2 compatibility mount.
3. Add the S3-compatible driver and mount UI.
4. Add OneDrive Personal OAuth, token lifecycle, and read operations.
5. Add OneDrive write operations and integrate existing upload UI.
6. Run migration, security, responsive UI, and production smoke checks.

Each stage must be deployable with existing public R2 links and content intact.
